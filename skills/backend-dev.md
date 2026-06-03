---
name: backend-dev
description: Reusable backend engineering workflow for APIs, services, data models, persistence, validation, and tests. Use when implementing or reviewing backend/server-side code.
---
# Backend Development Skill

## Workflow

1. Identify the backend root (`backend/`, `server/`, `api/`, or equivalent) and read its README/configuration before editing.
2. Inspect existing architecture, framework conventions, tests, and scripts.
3. Make the smallest change that satisfies the task while preserving API compatibility unless a contract change is requested.
4. Add or update focused tests when behavior changes.
5. Run the narrowest available validation command and report the result.

## Implementation Checklist

- Keep request/response contracts explicit and documented when they affect other components.
- Validate inputs at boundaries.
- Prefer clear service/module boundaries over duplicating business logic.
- Consider error handling, logging, security, and performance implications.
- Avoid frontend/client edits; summarize any required UI follow-up for `frontend-dev`.

## Common Validation Commands

Use whichever commands exist in the target project:

```bash
npm test
npm run lint
npm run typecheck
npm run build
./gradlew test
./gradlew check
mvn test
pytest
```
