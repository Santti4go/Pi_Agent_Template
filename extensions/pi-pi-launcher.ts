import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PI_PI_COMMAND = "pi --no-extensions -e ./manual-extensions/pi-pi.ts";

export default function(pi: ExtensionAPI) {
  pi.registerCommand("pi-pi-run", {
    description: "Show the manual command to launch Pi Pi on demand",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Pi Pi is manual-only in this repo. Launch it with:\n\n${PI_PI_COMMAND}`,
        "info",
      );
    },
  });
}
