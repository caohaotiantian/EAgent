# CLAUDE.md

Orientation for an AI agent working in this repository.

## What this is

EAgent is a minimalist AI-agent kernel: a tiny, stable core plus an
Emacs-grade extension surface. The bet is that a small, observable, malleable
core beats a big one — new behavior is always an extension, never a fork.

## Architecture

The kernel is **seven primitives and nothing more**, all under `src/kernel/`:

| Primitive        | File                | Responsibility |
| ---------------- | ------------------- | -------------- |
| Hook bus         | `hooks.ts`          | Lifecycle events (observe) + filter hooks (intervene). |
| Tool registry    | `registry.ts`       | Register/shadow/dispose tools; later wins, disposing restores. |
| Provider         | `types.ts` (interface) | The LLM abstraction: a request → a stream of events. Implementations live in `src/providers/`. |
| Agent loop       | `agent.ts`          | Turns, streaming, guarded/ordered tool dispatch, steering, follow-up. |
| Capability layer | `capabilities.ts`   | Per-capability grant/deny/ask, wildcards, audit log. |
| Extension host   | `extension.ts`      | Discovery, activation, `ExtensionAPI`, hot reload via `jiti`. |
| Command registry | `commands.ts`       | User-facing slash commands. |

**Everything else is an extension** — even the four "built-in" tools
(`read`, `write`, `edit`, `bash`) live in `src/extensions/core-tools.ts`. The
kernel ships with zero opinions about tools, memory, prompts, or sub-agents.

## Key commands

```bash
npm test         # node:test via tsx; runs offline against MockProvider (no API key)
npm run typecheck
npm run build    # tsc -> dist/
npm run dev      # node --import tsx src/cli.ts  (interactive REPL)
```

`npm test` (and the whole suite) runs offline: `MockProvider`
(`src/providers/mock.ts`) is a scriptable, deterministic LLM, so no network and
no `ANTHROPIC_API_KEY` are required. Keep it that way.

## Where things live

- `src/kernel/` — the seven primitives + public barrel (`index.ts`).
- `src/providers/` — `mock` (deterministic), `anthropic`, `openai`, `gemini`
  (all `fetch` + SSE, no SDK), shared `http.ts` plumbing, and `cassette`
  (record/replay). All read config from `process.env`.
- `src/extensions/` — `core-tools`,
  `search` (`fs:read`, parallel `glob`/`grep` tools for finding files and
  searching contents in pure Node — no shell, confined to the workspace root),
  `skills`, `mcp`, `codeact`, `subagents`,
  `dynamic-workflow` (a `run_workflow` tool that executes a model-emitted
  dependency DAG of `tool`/`agent` steps with `${id}` output substitution;
  independent steps run in parallel, tool steps reuse the kernel's guard
  sequence so capability/policy checks still apply),
  `memory`,
  `prune` (token-budget tool-output pruning on `transformContext` — truncates
  old, oversized `tool_result` content beyond a protected recent window; no
  capability, `EAGENT_PRUNE=off` kill switch),
  `planmode`, `session`, `packages`, `trace`, `context-files`,
  `microagents` (keyword-triggered knowledge injection on `transformContext` —
  scans one directory of `*.md` files with single-line `triggers:` frontmatter
  and injects a file's body, whole-word-matched and case-insensitive, only when a
  trigger appears in the latest user message; cached scan + `/microagents`
  re-scan, byte-capped prefix fill, no capability, `EAGENT_MICROAGENTS=off` kill
  switch),
  `limits` (per-run call/token budgets + tool-output byte cap; on overflow it
  spills the full output to a gitignored file under `.eagent/tool-output` and
  returns a retrieval hint instead of discarding the clipped bytes),
  `cost` (token→USD accounting on `usage`/`agent_*` — a pure observability
  sibling of `trace`: prices tokens via a date-pinned, store-overridable price
  card, accumulates per-run + per-model session cost, and emits a warn-only
  rolling-mean anomaly flag when a finished run's cost exceeds mean+3σ past a
  5-sample guard; `/cost` status view + `/cost pricecard` setter, no capability,
  `EAGENT_COST=off` kill switch),
  `self`, `web`, `checkpoint`, `introspect`, `journal`, `prompts`,
  `todo` (session-scoped in-memory todo list — a `todowrite` tool that replaces
  and echoes the list plus a `/todos` command; no capability),
  `flow-guard` (compositional egress gate — taints a session on a source
  capability, default `shell:exec`, or sensitive data in the transcript, then
  holds egress, default `net:fetch`; ask or block mode),
  `risk-guard` (LLM-based semantic risk analyzer on `beforeToolCall` — for tools
  whose capabilities intersect a configured sensitive set, default `shell:exec`,
  it classifies the specific call via a recursion-safe, tool-less provider
  sub-call and, on a RISKY verdict, asks or blocks; off by default, no
  capability, fails open with a warning, `EAGENT_RISK_GUARD=off` kill switch),
  `bash-policy` (command-granular shell policy gate — evaluates an allow/deny/ask
  ruleset over the full command line plus every effective sub-command (pipe/`;`/`&&`
  segments, unwrapped wrappers like `sudo`/`env`/`timeout`, and `find -exec` inner
  commands), last-match-wins; the matched command family is the approval label;
  no-op by default, no capability, `EAGENT_BASH_POLICY=off` kill switch),
  `integrity` (sweeps all tool descriptions for poisoning/hidden instructions,
  and flags descriptions that change across sessions — a rug-pull guard),
  `recovery` (turns a *failed* tool result into a corrective nudge — appends one
  hint keyed to EAgent's own error strings via `afterToolCall`, so the model
  self-corrects instead of re-issuing the broken call; on by default, no
  capability, `EAGENT_RECOVERY=off` kill switch),
  `write-guard` (prompts before a *blind overwrite* — a full-content `write` to
  an existing file the session has not read — via `beforeToolCall`; tracks
  read/edit/written paths per session, asks once, excludes `edit` and new-file
  creation; on by default, no capability, `EAGENT_WRITE_GUARD=off` kill switch),
  `content-guard` (ingress trust labeling — on `afterToolCall`, for *successful*
  results from a *foreign*-capability tool (default `net:fetch`/`mcp:call`) it
  strips always-invisible injection-vector Unicode (zero-width/bidi/tag/variation
  selectors) and wraps the body in an `<untrusted-content>` provenance fence with
  a standing "data, not instructions" note; skips error results so it stays
  disjoint from `recovery`; never blocks or calls a model, no capability, on by
  default, `EAGENT_CONTENT_GUARD=off` kill switch),
  `circuit-breaker` (tool-call repetition / consecutive-failure fail-fast — a
  per-run `Map` keyed on the call signature `name + canonical(args)` where object
  keys are recursively sorted; on `beforeToolCall` the 2nd identical occurrence
  earns one non-blocking `steer` nudge and the N-th (default threshold 3) — or N
  consecutive failures of that signature, tracked via `afterToolCall` and reset on
  success — asks via `ui.confirm` in `ask` mode or blocks in `block` mode; counts
  total-in-run so A-B-A-B oscillation trips; resets all state on `agent_start`,
  exports a pure `stableSignature`, fails open, on by default mode `ask`, no
  capability, `/circuit-breaker` command, `EAGENT_CIRCUIT_BREAKER=off` kill switch).
- `src/host.ts` — shared wiring reused by both front ends: provider selection,
  `.env` loading (`loadEnvFile`), model defaulting (honors `*_MODEL` env vars),
  and the canonical builtin extension set.
- `src/cli.ts` — the terminal host: interactive REPL, batch, one-shot.
- `src/complete.ts` — the REPL Tab-completion engine: a pure `complete(line, ctx)`
  returning readline's `[matches, substring]`; completes command names, command
  arguments, and filesystem paths, with `readDir`/`homedir` injected so it is
  offline-testable.
- `src/server.ts` — the HTTP host (`GET /health`, `POST /run`, `DELETE /sessions/:id`).
- `test/` — the full offline suite, one file per primitive/extension.
- `examples/extensions/` — worked example extensions.
- `docs/EXTENSIONS.md` — the extension author's guide.

## House conventions

- **ESM + NodeNext.** Always use `.js` import specifiers even when importing a
  `.ts` file (e.g. `import { defineTool } from "../kernel/define.js"`). This is
  required by `module: NodeNext` and `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are all on. No `any`
  cop-outs; model the types.
- **Zero runtime dependencies except `jiti`.** Do not add npm dependencies.
  Providers use the global `fetch`; nothing pulls in an SDK.
- **Tests use `node:test` run via `tsx`**, and must run offline. Every
  extension is capability-gated and ships with tests.
- **Capabilities are the security vocabulary.** Privileged tools declare
  `capabilities: [...]` (e.g. `fs:read`, `shell:exec`) and the dispatcher
  enforces them before `execute` runs.

When adding an extension: register through the `ExtensionAPI`, track every
registration (the host does this for you so reload is clean), gate side effects
behind a capability, and add an offline test.
