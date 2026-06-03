---
name: frontend-dev
description: Reusable frontend engineering workflow for UI components, client-side state, styling, accessibility, API integration, and frontend tests. Use when implementing or reviewing frontend/client code.
---
# Frontend Development Skill

## Workflow

1. Identify the frontend root (`frontend/`, `web/`, `app/`, `client/`, or equivalent) and read its README/package configuration before editing.
2. Inspect existing component, routing, state, styling, and test conventions.
3. Make the smallest UI/client change that satisfies the task while preserving user experience and API compatibility unless a contract change is requested.
4. Add or update focused tests where the project supports them.
5. Run the narrowest available validation command and report the result.

## Implementation Checklist

- Keep components focused, accessible, and consistent with existing styling.
- Handle loading, empty, and error states for API interactions.
- Keep API contract assumptions explicit; request backend follow-up when needed.
- Avoid backend/server edits; summarize any required API or data changes for `backend-dev`.

## Common Validation Commands

Use whichever commands exist in the target project:

```bash
npm test
npm run lint
npm run typecheck
npm run build
pnpm test
pnpm lint
pnpm typecheck
pnpm build
yarn test
yarn lint
yarn typecheck
yarn build
```
