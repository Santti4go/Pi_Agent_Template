import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TeamAgent = {
  name: string;
  description: string;
  prompt: string;
  skill?: string;
  tools: string[];
  model?: string;
};

type DispatchTask = {
  agent: string;
  task: string;
  cwd?: string;
};

type DispatchResult = {
  agent: string;
  task: string;
  exitCode: number;
  output: string;
  stderr: string;
  model?: string;
  turns: number;
  errorMessage?: string;
};

type DispatcherDetails = {
  teamFile: string;
  mode: "single" | "parallel";
  results: DispatchResult[];
};

type AgentStatus = "idle" | "working" | "done" | "error";

const CHILD_ENV = "PI_AGENT_DISPATCHER_CHILD";
const ACTIVE_AGENT_ENV = "PI_AGENT_ACTIVE_AGENT";
const TEAM_FILE = path.join("agents", "team.yml");
const DOT_PI_TEAM_FILE = path.join(".pi", "agents", "team.yml");
const THEME_DIR = "themes";
const DOT_PI_THEME_DIR = path.join(".pi", "themes");
const THEME_NAME = "pi-dispatcher";
const GRID_THEME_NAME = "pi-dispatcher-grid";
const MAX_PARALLEL_TASKS = 6;
const MAX_CONCURRENCY = 3;
const OUTPUT_CAP_BYTES = 40 * 1024;
const BLOCKED_PARENT_TOOLS = new Set(["bash", "write", "edit", "multi_tool_use.parallel"]);
const SPECIALIST_DIRS = ["backend", "frontend"];

/**
 * Checks if a file path belongs to any designated specialist directories.
 */
function isSpecialistPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return SPECIALIST_DIRS.some((dir) => normalized.startsWith(`${dir}/`) || normalized === dir);
}

/**
 * Strips comments from a YAML line.
 */
function stripComment(line: string): string {
  const hash = line.indexOf("#");
  return hash >= 0 ? line.slice(0, hash) : line;
}

/**
 * Parses a YAML inline list bracket representation (e.g., [a, b, c]).
 */
function parseInlineList(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((item) => item.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean);
}

/**
 * Parses a YAML scalar value, resolving inline lists if present.
 */
function parseScalar(value: string): string | string[] {
  const list = parseInlineList(value);
  if (list) return list;
  return value.trim().replace(/^['\"]|['\"]$/g, "");
}

/**
 * Parses the raw contents of team.yml to construct TeamAgent structures.
 */
function parseTeamYaml(raw: string): TeamAgent[] {
  const agents: TeamAgent[] = [];
  let current: Record<string, any> | undefined;
  let activeArrayKey: string | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (!line.trim() || line.trim() === "agents:") continue;

    const trimmed = line.trim();
    const item = /^-\s+([^:]+):\s*(.*)$/.exec(trimmed);
    if (item && ["name", "description", "prompt", "skill", "tools", "model"].includes(item[1])) {
      if (item[1] === "name") {
        if (current?.name) agents.push(current as TeamAgent);
        current = {};
      }
      if (!current) current = {};
      current[item[1]] = parseScalar(item[2]);
      activeArrayKey = Array.isArray(current[item[1]]) ? item[1] : undefined;
      continue;
    }

    const keyValue = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (keyValue && current) {
      const [, key, value] = keyValue;
      current[key] = value ? parseScalar(value) : [];
      activeArrayKey = value ? undefined : key;
      continue;
    }

    const arrayItem = /^-\s+(.+)$/.exec(trimmed);
    if (arrayItem && current && activeArrayKey) {
      if (!Array.isArray(current[activeArrayKey])) current[activeArrayKey] = [];
      current[activeArrayKey].push(parseScalar(arrayItem[1]));
    }
  }

  if (current?.name) agents.push(current as TeamAgent);
  return agents.filter((agent) => agent.name && agent.description);
}

/**
 * Resolves the configuration root by searching upward for agents/team.yml or .pi/agents/team.yml.
 */
function findProjectRoot(cwd: string): string {
  let current = path.resolve(cwd);
  while (true) {
    if (fs.existsSync(path.join(current, TEAM_FILE)) || fs.existsSync(path.join(current, DOT_PI_TEAM_FILE))) return current;
    if (path.basename(current) === ".pi" && fs.existsSync(path.join(current, "agents", "team.yml"))) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

function resolveTeamFile(root: string): string {
  const direct = path.resolve(root, TEAM_FILE);
  if (fs.existsSync(direct)) return direct;
  return path.resolve(root, DOT_PI_TEAM_FILE);
}

function resolveThemeDir(root: string): string {
  const direct = path.resolve(root, THEME_DIR);
  if (fs.existsSync(direct)) return direct;
  return path.resolve(root, DOT_PI_THEME_DIR);
}

/**
 * Loads and parses the agent list from the configured team file.
 */
function loadTeam(cwd: string): { root: string; teamFile: string; agents: TeamAgent[] } {
  const root = findProjectRoot(cwd);
  const teamFile = resolveTeamFile(root);
  const raw = fs.readFileSync(teamFile, "utf-8");
  const agents = raw.trim().startsWith("{") ? JSON.parse(raw).agents : parseTeamYaml(raw);
  return { root, teamFile, agents };
}

/**
 * Assembles the specialist's system prompt from its configuration and files.
 */
function readPrompt(cwd: string, agent: TeamAgent): string {
  const parts = [
    `You are ${agent.name}, a Pi Agent specialist.`,
    `Specialty: ${agent.description}`,
    "Do the delegated specialist work directly. Do not re-dispatch this task.",
    "Keep changes inside your owned domain unless the task explicitly requires an interface/documentation update.",
  ];

  if (agent.skill) parts.push(`Load this skill before substantial work: ${agent.skill}`);

  if (agent.prompt) {
    const promptPath = path.resolve(cwd, agent.prompt);
    if (fs.existsSync(promptPath)) {
      const raw = fs.readFileSync(promptPath, "utf-8");
      const { body } = parseFrontmatter<Record<string, string>>(raw);
      parts.push(body.replace(/^Task:\s*\$@\s*$/gm, "").trim());
    }
  }

  return parts.filter(Boolean).join("\n\n");
}

/**
 * Writes the custom prompt to a temporary markdown file.
 */
async function writeTempPrompt(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-dispatcher-"));
  const safe = agentName.replace(/[^A-Za-z0-9_.-]+/g, "_");
  const filePath = path.join(dir, `${safe}-system.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir, filePath };
}

/**
 * Resolves the proper command and argument syntax to launch the pi process.
 */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const runtime = path.basename(process.execPath).toLowerCase();
  if (/^(node|bun)(\.exe)?$/.test(runtime)) return { command: "pi", args };
  return { command: process.execPath, args };
}

/**
 * Helper to extract the plain-text string from assistant messages.
 */
function extractText(message: any): string {
  const parts = message?.content ?? [];
  for (const part of parts) {
    if (part?.type === "text") return part.text ?? "";
  }
  return "";
}

/**
 * Truncates output to safe limits to prevent parent context overflow from subagents.
 */
// TODO: make each subagent run a summary step before returning to parent
function capOutput(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= OUTPUT_CAP_BYTES) return text;
  let capped = text.slice(0, OUTPUT_CAP_BYTES);
  while (Buffer.byteLength(capped, "utf8") > OUTPUT_CAP_BYTES) capped = capped.slice(0, -1);
  return `${capped}\n\n[dispatcher: output truncated; full text omitted from parent context]`;
}

/**
 * Spawns a child process running the pi agent for the specified specialist.
 */
async function runSpecialist(
  rootCwd: string,
  teamFile: string,
  agents: TeamAgent[],
  dispatch: DispatchTask,
  parentModel?: string,
  signal?: AbortSignal,
  onUpdate?: (partial: AgentToolResult<DispatcherDetails>) => void,
): Promise<DispatchResult> {
  const agent = agents.find((candidate) => candidate.name === dispatch.agent);
  if (!agent) {
    return {
      agent: dispatch.agent,
      task: dispatch.task,
      exitCode: 1,
      output: `Unknown specialist: ${dispatch.agent}. Available: ${agents.map((a) => a.name).join(", ") || "none"}`,
      stderr: "",
      turns: 0,
    };
  }

  let tmp: { dir: string; filePath: string } | undefined;
  const result: DispatchResult = { agent: agent.name, task: dispatch.task, exitCode: 0, output: "", stderr: "", turns: 0 };

  try {
    tmp = await writeTempPrompt(agent.name, readPrompt(rootCwd, agent));
    const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", tmp.filePath];
    if (agent.model || parentModel) {
      const parentProvider = parentModel?.includes("/") ? parentModel.split("/")[0] : undefined;
      const model = agent.model
        ? (agent.model.includes("/") || !parentProvider ? agent.model : `${parentProvider}/${agent.model}`)
        : parentModel!;
      args.push("--model", model);
    }
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    args.push(`Delegated task for ${agent.name}:\n\n${dispatch.task}`);

    let aborted = false;
    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: dispatch.cwd ? path.resolve(rootCwd, dispatch.cwd) : rootCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, [CHILD_ENV]: "1", [ACTIVE_AGENT_ENV]: agent.name, PI_AGENT_DISPATCHER_TEAM: teamFile },
      });
      let buffer = "";

      // TODO:  try to re-use the lgic of pi-pi.ts to spawn subagents, it seems to be clearer
      const processLine = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "message_end" && event.message?.role === "assistant") {
            result.turns += 1;
            result.model = result.model ?? event.message.model;
            result.errorMessage = event.message.errorMessage ?? result.errorMessage;
            const text = extractText(event.message);
            if (text) result.output = text;
            onUpdate?.({
              content: [{ type: "text", text: `${agent.name}: ${capOutput(result.output || "(running...)")}` }],
              details: { teamFile, mode: "single", results: [result] },
            });
          }
        } catch {
          // Ignore non-JSON noise from child process.
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data) => {
        result.stderr += data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      proc.on("error", (error) => {
        result.stderr += String(error);
        resolve(1);
      });
      if (signal) {
        const kill = () => {
          aborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => proc.kill("SIGKILL"), 5000).unref?.();
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
    if (aborted) result.errorMessage = "Specialist was aborted";
    result.output = capOutput(result.output || result.errorMessage || result.stderr || "(no specialist output)");
    return result;
  } finally {
    if (tmp) {
      fs.rmSync(tmp.dir, { recursive: true, force: true });
    }
  }
}

/**
 * Standard helper to map async actions with a concurrency ceiling.
 */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Formats the list of specialists for inclusion in system instructions.
 */
function formatAgentList(agents: TeamAgent[]): string {
  return agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n") || "No specialists found.";
}

/**
 * Pad or truncate table strings to align nicely in terminal columns.
 */
function fitCell(text: string, width: number): string {
  const fitted = truncateToWidth(text, Math.max(0, width));
  return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

/**
 * Returns colored indicator formatting for the agent status cell.
 */
function statusStyle(theme: any, status: AgentStatus): string {
  const icon = status === "idle" ? "○" : status === "working" ? "◉" : status === "done" ? "✓" : "✗";
  const color = status === "idle" ? "dim" : status === "working" ? "accent" : status === "done" ? "success" : "error";
  return theme.fg(color, `${icon} ${status}`);
}

function statusIcon(theme: any, status: AgentStatus): string {
  const BLINK_ON = "\x1b[5m";
  const BLINK_OFF = "\x1b[25m";

  if (status === "idle") return theme.fg("dim", "○");
  if (status === "working") return `${BLINK_ON}${theme.fg("accent", "◉")}${BLINK_OFF}`;
  if (status === "done") return theme.fg("success", "✓");
  return theme.fg("error", "✗");
}

function isGridTheme(theme: any): boolean {
  return theme?.name === GRID_THEME_NAME;
}

function renderDispatcherCard(theme: any, agent: TeamAgent, status: AgentStatus, cardWidth: number): string[] {
  const innerWidth = Math.max(1, cardWidth - 2);
  const bg = (text: string) => theme.bg("toolErrorBg", text);
  const borderColor = status === "error" ? "error" : status === "done" ? "success" : status === "working" ? "accent" : "error";
  const border = (text: string) => bg(theme.fg(borderColor, text));
  const row = (content: string) => bg(`${theme.fg(borderColor, "│")}${fitCell(content, innerWidth)}${theme.fg(borderColor, "│")}`);
  const name = theme.fg("text", theme.bold(agent.name));
  const statusModel = `${statusIcon(theme, status)}${agent.model ? theme.fg("muted", " | ") + theme.fg("muted", agent.model) : ""}`;
  const description = theme.fg("muted", truncateToWidth(agent.description, innerWidth));

  return [
    border(`┌${"─".repeat(innerWidth)}┐`),
    row(name),
    row(statusModel),
    row(description),
    border(`└${"─".repeat(innerWidth)}┘`),
  ];
}

function dispatcherGridLines(theme: any, agents: TeamAgent[], statuses: Map<string, AgentStatus>, width: number): string[] {
  if (width < 20) return [truncateToWidth(theme.fg("error", "Team agents"), width)];

  const outerWidth = width - 1;
  const header = theme.fg("error", theme.bold("Team agents"));
  if (agents.length === 0) return [header, theme.fg("dim", "No specialists found.")];

  const maxCols = Math.min(3, agents.length);
  const gap = 1;
  const minCardWidth = 24;
  let cols = 1;
  for (let candidate = maxCols; candidate >= 1; candidate -= 1) {
    const candidateWidth = Math.floor((outerWidth - gap * (candidate - 1)) / candidate);
    if (candidateWidth >= minCardWidth || candidate === 1) {
      cols = candidate;
      break;
    }
  }

  const cardWidth = Math.max(1, Math.floor((outerWidth - gap * (cols - 1)) / cols));
  const lines = [header];

  for (let i = 0; i < agents.length; i += cols) {
    const rowAgents = agents.slice(i, i + cols);
    const cards = rowAgents.map((agent) => renderDispatcherCard(theme, agent, statuses.get(agent.name) ?? "idle", cardWidth));
    const cardHeight = Math.max(...cards.map((card) => card.length));

    while (cards.length < cols) {
      cards.push(Array(cardHeight).fill(" ".repeat(cardWidth)));
    }

    for (let lineIndex = 0; lineIndex < cardHeight; lineIndex += 1) {
      lines.push(cards.map((card) => card[lineIndex] ?? " ".repeat(cardWidth)).join(" ".repeat(gap)));
    }
  }

  return lines;
}

/**
 * Draws the table layout border/rows showcasing the agent team status.
 */
function dispatcherTableLines(theme: any, agents: TeamAgent[], statuses: Map<string, AgentStatus>, width: number): string[] {
  if (width < 20) return [truncateToWidth(theme.fg("error", "DISPATCHER"), width)];

  const outerWidth = width - 1;
  const innerWidth = outerWidth - 2;
  const compact = innerWidth < 42;
  const statusWidth = compact ? 3 : 11;
  const agentWidth = compact ? Math.max(8, Math.min(14, Math.floor(innerWidth * 0.42))) : Math.min(18, Math.max(12, Math.floor(innerWidth * 0.22)));
  const descWidth = Math.max(1, innerWidth - statusWidth - agentWidth - 2);
  const bg = (text: string) => theme.bg("toolErrorBg", text);
  const border = (text: string) => bg(theme.fg("error", text));
  const sep = border(`├${"─".repeat(statusWidth)}┼${"─".repeat(agentWidth)}┼${"─".repeat(descWidth)}┤`);
  const row = (status: string, agent: string, desc: string) =>
    bg(
      `${theme.fg("error", "│")}${fitCell(status, statusWidth)}${theme.fg("error", "│")}` +
      `${fitCell(agent, agentWidth)}${theme.fg("error", "│")}${fitCell(desc, descWidth)}${theme.fg("error", "│")}`,
    );

  const title = ` DISPATCHER MODE · ${agents.length || 0} agents `;
  const titleLine = `${title}${"─".repeat(Math.max(0, innerWidth - visibleWidth(title)))}`;
  const lines = [
    border(`┌${truncateToWidth(titleLine, innerWidth)}┐`),
    row(theme.fg("muted", "status"), theme.fg("muted", "agent"), theme.fg("muted", "description")),
    sep,
  ];

  if (agents.length === 0) {
    lines.push(row(theme.fg("dim", "○ idle"), theme.fg("text", theme.bold("no-agents")), theme.fg("muted", "No specialists found.")));
  } else {
    for (const agent of agents) {
      const status = statuses.get(agent.name) ?? "idle";
      lines.push(
        row(
          statusStyle(theme, status),
          theme.fg("text", theme.bold(agent.name)),
          theme.fg("muted", agent.description),
        ),
      );
    }
  }

  lines.push(border(`└${"─".repeat(innerWidth)}┘`));
  return lines;
}

/**
 * Mounts the dispatcher status indicator and table widgets into the UI.
 */
function installDispatcherUi(ctx: any, statuses: Map<string, AgentStatus>): void {
  if (!ctx.hasUI) return;

  let agents: TeamAgent[] = [];
  try {
    agents = loadTeam(ctx.cwd).agents;
  } catch {
    // The dispatch tool will report load errors; keep the visual mode marker active.
  }

  ctx.ui.setWidget("pi-dispatcher-team", (_tui: any, theme: any) => ({
    render(width: number) {
      return isGridTheme(theme) ? dispatcherGridLines(theme, agents, statuses, width) : dispatcherTableLines(theme, agents, statuses, width);
    },
    invalidate() { },
  }));
  ctx.ui.setStatus("pi-dispatcher", ctx.ui.theme.fg("error", "dispatcher"));
}

function setDispatcherTheme(ctx: any, themeName: string): void {
  if (!ctx.hasUI) return;

  const result = ctx.ui.setTheme(themeName);
  if (!result?.success) {
    ctx.ui.notify(`Dispatcher theme switch failed: ${result?.error ?? "unknown error"}`, "warning");
    return;
  }

  ctx.ui.notify(`Dispatcher theme: ${themeName}`, "info");
}

function toggleDispatcherTheme(ctx: any): void {
  const nextTheme = ctx.ui.theme?.name === GRID_THEME_NAME ? THEME_NAME : GRID_THEME_NAME;
  setDispatcherTheme(ctx, nextTheme);
}

function registerDispatcherShortcuts(pi: ExtensionAPI): void {
  pi.registerShortcut("alt+1", {
    description: "Use dispatcher table theme",
    handler: async (ctx) => setDispatcherTheme(ctx, THEME_NAME),
  });

  pi.registerShortcut("alt+2", {
    description: "Use dispatcher grid theme",
    handler: async (ctx) => setDispatcherTheme(ctx, GRID_THEME_NAME),
  });
}

const DispatchItem = Type.Object({
  agent: Type.String({ description: "Specialist name from agents/team.yml" }),
  task: Type.String({ description: "Work to delegate. Include acceptance criteria and relevant paths." }),
  cwd: Type.Optional(Type.String({ description: "Optional specialist working directory, relative to repo root." })),
});

/**
 * Main entry point for the Pi Agent dispatcher extension.
 */
export default function(pi: ExtensionAPI) {
  const isChild = process.env[CHILD_ENV] === "1";
  if (isChild) return;

  const agentStatuses = new Map<string, AgentStatus>();

  registerDispatcherShortcuts(pi);

  pi.on("resources_discover", async (event) => ({
    themePaths: [resolveThemeDir(findProjectRoot(event.cwd))],
  }));

  pi.on("session_start", async (_event, ctx) => {
    installDispatcherUi(ctx, agentStatuses);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("pi-dispatcher-team", undefined);
    ctx.ui.setStatus("pi-dispatcher", undefined);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    let agents: TeamAgent[] = [];
    let teamFile = path.resolve(findProjectRoot(ctx.cwd), TEAM_FILE);
    try {
      const loaded = loadTeam(ctx.cwd);
      agents = loaded.agents;
      teamFile = loaded.teamFile;
    } catch {
      // Keep prompt injection useful even if the tool will report the load error later.
    }

    // Design Decision: Instruct the parent LLM to act strictly as an orchestrator.
    // We append the list of available specialists from team.yml and define hard domain ownership
    // rules so the orchestrator knows how to delegate engineering tasks.
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `Pi Agent dispatcher extension is active. You are a dispatcher/orchestrator only: do not inspect, edit, or implement domain work in the parent agent. ` +
        `Delegate work with the dispatch_to_specialist tool and integrate/report specialist outputs. ` +
        `Dispatch independent multi-domain work in parallel by default with the tasks array; use single-task dispatch only for one-owner work or true sequencing dependencies. ` +
        `Enforce hard domain ownership in task wording: each specialist may edit only its owned domain plus required interface/README docs. ` +
        `Specialists are loaded from ${teamFile}.\n\nAvailable specialists:\n${formatAgentList(agents)}`,
    };
  });

  pi.on("tool_call", async (event) => {
    // Design Decision: Enforce strict boundary isolation. The orchestrator must not modify code
    // or execute scripts inside the configured specialist domain directories.
    // Any attempt to use write/edit/bash on these paths is blocked, forcing delegation via dispatch_to_specialist.
    if (!BLOCKED_PARENT_TOOLS.has(event.toolName)) return;

    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event?.input ?? {};
      const filePath = input.path ?? input.file_path ?? input.filePath;
      if (typeof filePath === "string" && isSpecialistPath(filePath)) {
        return {
          block: true,
          reason: `Dispatcher mode is active: parent agent must not modify code inside specialist directories (${filePath}). Delegate this work to the appropriate specialist agent using dispatch_to_specialist.`,
        };
      }
      return;
    }

    if (event.toolName === "bash") {
      const input = event?.input ?? {};
      const cwdOption = input.cwd ?? "";
      const command = input.command ?? "";
      if (
        (typeof cwdOption === "string" && isSpecialistPath(cwdOption)) ||
        (typeof command === "string" &&
          SPECIALIST_DIRS.some((dir) => command.includes(`${dir}/`) || command.includes(` ${dir}`)))
      ) {
        return {
          block: true,
          reason: "Dispatcher mode is active: parent agent must not run engineering tasks or build/test commands inside specialist directories directly. Delegate this work using dispatch_to_specialist.",
        };
      }
      return;
    }

    return {
      block: true,
      reason: "Dispatcher mode is active: parent agent must not execute repository work directly. Use dispatch_to_specialist.",
    };
  });

  pi.registerTool({
    name: "dispatch_to_specialist",
    label: "Dispatch",
    description:
      "Delegate work to specialist agents from agents/team.yml. Prefer parallel tasks for independent multi-owner work; use single mode only for one-owner work or true sequencing dependencies. The dispatcher does not implement work itself; it only returns specialist outputs.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Specialist name for single-task mode." })),
      task: Type.Optional(Type.String({ description: "Task for single-task mode." })),
      cwd: Type.Optional(Type.String({ description: "Optional cwd for single-task mode, relative to repo root." })),
      tasks: Type.Optional(Type.Array(DispatchItem, { description: "Parallel specialist tasks." })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      let loaded: { root: string; teamFile: string; agents: TeamAgent[] };
      try {
        loaded = loadTeam(ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Cannot load ${TEAM_FILE}: ${message}` }], details: { teamFile: TEAM_FILE, mode: "single", results: [] } };
      }

      // Design Decision: Validate that the model chooses either single-agent or parallel execution,
      // but not both, ensuring clean parameter parsing and predictable tool execution state.
      const hasSingle = Boolean(params.agent && params.task);
      const hasParallel = Boolean(params.tasks?.length);
      if (Number(hasSingle) + Number(hasParallel) !== 1) {
        return {
          content: [{ type: "text", text: `Provide exactly one mode: {agent, task} or {tasks}.\n\n${formatAgentList(loaded.agents)}` }],
          details: { teamFile: loaded.teamFile, mode: "single", results: [] },
        };
      }

      const dispatches: DispatchTask[] = hasSingle
        ? [{ agent: params.agent!, task: params.task!, cwd: params.cwd }]
        : params.tasks!.slice(0, MAX_PARALLEL_TASKS);
      const mode = hasSingle ? "single" : "parallel";

      const refreshUi = () => {
        if (ctx.hasUI) installDispatcherUi(ctx, agentStatuses);
      };
      for (const dispatch of dispatches) agentStatuses.set(dispatch.agent, "working");
      refreshUi();

      const parentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      // Design Decision: Parallel execution limit. We control concurrency via mapWithLimit to prevent
      // potential API rate limits or excessive CPU/RAM usage from spawning too many child processes.
      const results = await mapWithLimit(dispatches, MAX_CONCURRENCY, async (dispatch) => {
        const result = await runSpecialist(loaded.root, loaded.teamFile, loaded.agents, dispatch, parentModel, signal, onUpdate);
        agentStatuses.set(dispatch.agent, result.exitCode === 0 && !result.errorMessage ? "done" : "error");
        refreshUi();
        return result;
      });

      const text = results
        .map((result) => `## ${result.agent} (exit ${result.exitCode})\n\n${result.output}${result.stderr ? `\n\nStderr:\n${capOutput(result.stderr)}` : ""}`)
        .join("\n\n---\n\n");

      return { content: [{ type: "text", text }], details: { teamFile: loaded.teamFile, mode, results } };
    },
    renderResult(result, options, theme) {
      // Design Decision: TUI Custom Rendering. In collapsed mode, we display a clean one-line status
      // summary. If the user expands the tool result (e.g. by hitting Enter), we render the full
      // markdown formatted output of all executed specialists.
      const details = result.details as DispatcherDetails | undefined;
      if (!details?.results?.length) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      const summary = details.results
        .map((item) => {
          const icon = item.exitCode === 0 && !item.errorMessage ? "✓" : "✗";
          const color = item.exitCode === 0 && !item.errorMessage ? "success" : "error";
          return theme.fg(color, `${icon} ${item.agent}`) + theme.fg("dim", ` exit ${item.exitCode}`);
        })
        .join(theme.fg("dim", " · "));

      if (!options.expanded) return new Text(summary, 0, 0);

      const mdTheme = getMarkdownTheme();
      const markdown = details.results
        .map((item) => {
          const stderr = item.stderr ? `\n\n## Stderr\n\n\`\`\`text\n${capOutput(item.stderr)}\n\`\`\`` : "";
          return `# ${item.agent} (exit ${item.exitCode})\n\n${item.output}${stderr}`;
        })
        .join("\n\n---\n\n");

      return new Markdown(markdown, 0, 0, mdTheme);
    },
  });

  pi.registerCommand("dispatcher-agents", {
    description: "List Pi Agent dispatcher specialists from agents/team.yml",
    handler: async (_args, ctx) => {
      try {
        const loaded = loadTeam(ctx.cwd);
        ctx.ui.notify(`${loaded.teamFile}\n\n${formatAgentList(loaded.agents)}`, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
