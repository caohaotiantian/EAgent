---
name: eagent-conventions
triggers: extension, kernel, capability, provider, EAgent
description: House rules for working inside the EAgent codebase
---
When working in the EAgent codebase, honor these conventions:

- The kernel is seven primitives under `src/kernel/` and is held under a hard line
  ceiling by `test/kernel-surface.test.ts`. New behavior is an **extension**, never
  a core change. Adding kernel lines needs an explicit decision.
- ESM + NodeNext: always use `.js` import specifiers even when importing a `.ts`
  file (e.g. `import { defineTool } from "../kernel/define.js"`).
- Strict TypeScript, no `any`. Zero runtime dependencies except `jiti`; providers
  use the global `fetch`, no SDKs.
- Privileged tools declare `capabilities: [...]` (e.g. `fs:read`, `shell:exec`) and
  the dispatcher enforces them before `execute` runs.
- Every extension ships with an offline test and, when it observes or intervenes by
  default, an `EAGENT_<NAME>=off` kill switch; opt-in extensions ship off.
- Tests run offline via `node:test` through `MockProvider` — keep them offline.
- The code is the source of truth; when a doc disagrees with the code, fix the doc.
