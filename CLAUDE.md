# CLAUDE.md

Orientation for an AI agent working in this repository. **The code is the source
of truth**; where this file and the code disagree, the code wins — fix this file.

## What this is

EAgent is a minimalist AI-agent kernel: a tiny, stable, observable core plus an
Emacs-grade extension surface. The bet is that a small, malleable core beats a big
one — **new behavior is always an extension, never a fork of the core.** That
scarcity is enforced, not aspirational: the kernel is held under a hard line
ceiling by a test, so every new capability is pushed out into an extension.

## Architecture

The kernel is **seven primitives and nothing more**, all under `src/kernel/`:

| Primitive        | File                   | Responsibility |
| ---------------- | ---------------------- | -------------- |
| Hook bus         | `hooks.ts`             | Lifecycle events (observe) + filter hooks (intervene); `childScope()` derives a governed bus for sub-agents (shares gate filters + intra-run events, suppresses run-lifecycle events). |
| Tool registry    | `registry.ts`          | Register/shadow/dispose tools; later wins, disposing restores. Also holds the `ProviderRegistry` (registers by overwrite — no restore). |
| Provider         | `types.ts` (interface) | The LLM abstraction: a request → a stream of events. Implementations live in `src/providers/`. |
| Agent loop       | `agent.ts`             | Turns, streaming, guarded/ordered tool dispatch (bounded by `maxConcurrency`), steering, follow-up (default `maxTurns` 24); first-class state via `snapshot()`/`restore()` + a monotonic `#step`; the `currentActingAgent()` seam so soft-guards act on the acting sub-agent. |
| Capability layer | `capabilities.ts`      | Per-capability grant/deny/ask, wildcards, audit log. |
| Extension host   | `extension.ts`         | Discovery, activation, the `ExtensionAPI`, hot reload via `jiti`. |
| Command registry | `commands.ts`          | User-facing slash commands. |

Supporting kernel modules (not primitives): `types.ts` (shared types + `Usage`
accounting), `events.ts` (the event/filter maps), `define.ts` (`defineTool` +
result helpers), `validate.ts` (JSON-Schema argument validation), `store.ts`
(the namespaced `Store`), and `index.ts` (the public barrel). The whole core is
held minimal on purpose: `test/kernel-surface.test.ts` pins the public exports
and keeps `src/kernel/` under a hard line ceiling (2,265 lines; the metric is
`split("\n").length` summed over `src/kernel/*.ts`, currently ~2,260 — a few
lines of slack). The ceiling moved from 2,200 to 2,250 when the `Config`
interface + `envOnlyConfig` fallback were added to `store.ts` for the injected
`e.config` facility, then from 2,250 to 2,265 for the multi-tenant isolation
seam (`currentRootAgent()` + a `rootAgentStore` ALS, the `e.agent`/`e.rootAgent`
getters) — deliberate explicit decisions. Adding to the kernel means golfing
something else out or an explicit decision; new capability is an extension, not a
core change.

**Everything else is an extension** — even the four "built-in" tools (`read`,
`write`, `edit`, `bash`) live in `src/extensions/core-tools.ts`. The kernel ships
with zero opinions about tools, memory, prompts, or sub-agents.

Extensions plug into the loop through the hook bus: they **observe** lifecycle
events via `e.on(event, …)` (`agent_start`, `turn_start`/`turn_end`, `message`,
`text_delta`/`reasoning_delta`, `tool_start`/`tool_end`/`tool_batch_end`, `usage`,
`agent_end`, `error`, `session_start`/`session_shutdown`/`reload`, …) and
**intervene** via six filter hooks `e.hook(point, …)`: `transformContext`
(reshape the message list), `transformRequest` (reshape the whole outbound
request — system prompt, tools, model, toolChoice, thinking — just before the
provider call), `beforeToolCall` (veto/rewrite a call), `beforeDispatch`
(reorder/drop the tool-call wave before dispatch, pairing-safe), `afterToolCall`
(transform a result), and `onProviderError` (error-path: retry/downshift when a
provider stream throws pre-first-event).

## Key commands

```bash
npm test          # node:test via tsx; runs offline against MockProvider (no API key)
npm run typecheck # tsc --noEmit   (alias: npm run lint)
npm run build     # tsc -> dist/
npm run build:binary # esbuild+Node-SEA -> a single standalone bin/eagent (posix; needs npx)
npm run dev       # node --import tsx src/cli.ts     (interactive REPL)
npm run serve     # node --import tsx src/server.ts  (HTTP host)
npm run eval      # offline evals-as-CI gate — runs evals/*.eval.json, exits non-zero on failure
```

The whole suite runs offline: `MockProvider` (`src/providers/mock.ts`) is a
scriptable, deterministic LLM, so no network and no `ANTHROPIC_API_KEY` are
required. Keep it that way. CI gates on `typecheck`, `test`, `eval`, and `build`.

## Where things live

- `src/kernel/` — the seven primitives, the supporting modules, and the public
  barrel (`index.ts`).
- `src/providers/` — `mock` (deterministic), `anthropic`, `openai`, `gemini`
  (all `fetch` + SSE, no SDK), shared `http.ts` (retry/backoff + SSE parsing),
  and `cassette` (record/replay). All read config from `process.env`.
- `src/extensions/` — the 65 built-in extensions, plus shared helpers in `lib/`
  (`decode`, `edit-match`, `otel-context`, `read-capped`, `relevance`, `sandbox`).
  A helper that two extensions share goes in `lib/`, not imported peer-to-peer.
- `src/host.ts` — `createAgentHost`: provider selection, `.env` loading, model
  defaulting (honors `*_MODEL` env vars), and the canonical `BUILTIN_EXTENSIONS`
  set and load order.
- `src/cli.ts` — the terminal host: interactive REPL, batch, one-shot, `--json`.
  It delegates human rendering to the engine plain renderer (`src/engine-render.ts`)
  over the shared neutral cores, keeps its `wireRendering(agent, opts?)` export, and
  on a capable TTY prints a one-line hint suggesting the rich `eagent-tui` client.
  (The old opt-in alt-screen surface — the `--tui` flag, the `/tui` command,
  `createTuiHost`/`attachRawKeys`/`resumeLineInput` — is removed; the rich
  full-screen UI now lives in the separate `eagent-tui` Ink front end.)
- **The human render layer** (host, not kernel) is a shared neutral core with two
  consumers. Neutral cores — zero-dep, no `ink`/`react`: `src/view-model.ts` (a
  pure, offline-testable reducer folding lifecycle events into an ordered,
  collapsible section tree — reasoning/answer/tool cards with nested sub-agent
  trees, attributed by acting agent), `src/attribution.ts` (the in-process
  attribution adapter that tags events via `currentActingAgent()`/
  `currentRootAgent()`), and `src/tty.ts` (the injected `Term` seam, the
  `isFancy`/`shouldSuggestTui` predicates, and the `RenderController` display-mode
  seam). Consumer 1 — `src/engine-render.ts`: the engine's minimal, zero-dep plain
  renderer wired by `cli.ts` for every non-Ink path (pipes, `--eval`, batch, dumb
  terminals, and the SEA binary's interactive TTY); it de-interleaves
  reasoning-search forks, collapses finished reasoning to a header, and keeps full
  tool params reachable via `/details`/`/expand`/`/collapse`. Consumer 2 —
  `src/tui/` (below).
- `src/tui/` — the **rich Ink (React) terminal client + multi-session monitor**,
  the ONLY place `ink`/`react` are imported (AC9, enforced by
  `test/tui-isolation.test.ts`). A separate ESM front end run via Node (the
  `eagent-tui` bin), NOT bundled into the CJS SEA engine binary. It consumes the
  same neutral cores: `source.ts` (the `SessionSource` abstraction —
  `InProcessSource` wraps a local agent, `RemoteSource` reads a host's HTTP+SSE
  feed), `app.tsx` (the single-session transcript over `src/view-model.ts`, with
  delta coalescing + viewport windowing), `monitor.tsx` + `instance.ts` (the
  `--monitor` dashboard over N configured `{url, token}` instances), and
  `main.tsx`/`args.ts` (the entry). Built via `npm run build:tui`; tested via
  `npm run test:tui`.
- `src/complete.ts` — the REPL Tab-completion engine: a pure, offline-testable
  `complete(line, ctx)`.
- `src/server.ts` — the HTTP host (`GET /health`, `POST /run`, `POST /answer`
  for a mid-turn elicitation reply, `GET /sessions/:id` for a session's usage +
  cost summary, `DELETE /sessions/:id`), plus the additive, read-mostly **monitor
  endpoints** the `eagent-tui --monitor` dashboard attaches to (zero-dep, Ink-free):
  `GET /sessions` (list `{id, running, usage, costUsd}`), `GET /sessions/:id/events`
  (a per-session SSE feed, tenant-isolated by the run-tree root agent), `GET /events`
  (a global SSE feed with each frame tagged by its `session` id), and
  `POST /sessions/:id/stop` (abort a running turn). Sessions are isolated per session
  id and run **concurrently** (a same-session second `/run` gets 409; different
  sessions overlap); all per-session extension state is keyed on the run-tree root
  Agent.
- `test/` — the full offline suite, roughly one file per primitive/extension.
- `examples/extensions/` — worked example extensions.
- `docs/EXTENSIONS.md` — the extension author's guide.

## Built-in extensions

Everything outside `src/kernel/` is an extension. 65 ship in `BUILTIN_EXTENSIONS`
(`src/host.ts`), each a single file with offline tests that gates privileged work
behind a capability. Conventions worth knowing:

- Privileged tools declare `capabilities: [...]`; the dispatcher enforces them
  before `execute` runs.
- Most extensions carry an `EAGENT_<NAME>=off` env kill switch. Opt-in ones ship
  **off** and are enabled via a `/<command> on` subcommand or a store flag.
- Load order in `BUILTIN_EXTENSIONS` matters: a later extension can shadow an
  earlier registration and observe its effects.
- The `.md`-file resource extensions (`templates`, `teams`, `skills`,
  `microagents`) read layered from **both** `~/.eagent/<kind>` (home/global) and
  `<cwd>/.eagent/<kind>` (project), merged by name with **project winning** on a
  conflict — the same home+project layering plugins (extensions) and config
  already use (`src/extensions/lib/resource-dirs.ts`). An explicit `<kind>.dir`
  (`EAGENT_<KIND>_DIR`) makes that kind single-source. The committed `library/`
  is the opt-in official library, not auto-loaded — copy `library/<kind>/*` into
  a tier to enable it, or run the `library` extension's `/library install
  [--home|--project] [kind...]` (skip-existing, `fs:write`-gated) to automate the
  copy. Installer and readers share `resourceDirs`, so a copy always lands where
  the layered read scans.

There is intentionally **no per-extension catalogue here** — it drifts. Read the
authoritative sources instead: `BUILTIN_EXTENSIONS` in `src/host.ts` for the set
and load order, the table in `README.md` for a one-line description + command +
capability per extension, and each extension file's top docstring for the
detail. `docs/EXTENSIONS.md` is the guide to writing one.

## Capabilities

Capabilities are the security vocabulary: a dotted authority a tool must declare
to run. The in-use set is `fs:read`, `fs:write`, `shell:exec`, `code:exec`,
`net:fetch`, `skill:read`, `skill:write`, `mcp:call`, `mcp:read`, `agent:spawn`,
`pkg:install`, `workflow:run`, `self:read`, `self:extend`, `ui:ask`. Patterns
support a trailing `*` wildcard. The host pre-grants `fs:read`/`fs:write`/
`skill:read`; the fallback for everything else is set by the front end (the CLI
defaults to **ask**, the HTTP server to **allow**/yolo). See `SECURITY.md`.

**Tools are auto-gated; slash commands are not.** A privileged *tool* declares
`capabilities: [...]` and the dispatcher enforces them before `execute`. A
*command* (its `CommandContext` has no capability field) must enforce itself —
`await e.agent.capabilities.require("<cap>", "<source>")` in a `try/catch
(CapabilityError)` (precedent: `session.ts` `/save`, `library.ts` `/library
install`). A command that writes without that call bypasses the security model.

## House conventions

- **ESM + NodeNext.** Always use `.js` import specifiers even when importing a
  `.ts` file (e.g. `import { defineTool } from "../kernel/define.js"`). This is
  required by `module: NodeNext` and `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are all on. No `any`
  cop-outs; model the types. Note: the build `tsconfig.json` excludes `test/` and
  `examples/`, and `npm test` runs via `tsx` (transpile-only) — so neither
  `typecheck` (src-only) nor `test` type-checks test files. **`npm run typecheck:test`**
  (a separate `noEmit` `tsconfig.test.json` inheriting every strict flag) type-checks
  `test/` + `src/` and is a CI gate; `examples/` remains unchecked.
- **Zero runtime dependencies in the engine (except `jiti`).** The kernel,
  providers, extensions, server, and CLI-engine — everything the SEA `bin/eagent`
  bundles — stay zero-runtime-dep: providers use the global `fetch`; nothing pulls
  in an SDK. The **one exception is the `src/tui/` front end**, which MAY use
  vetted, pinned, import-isolated dependencies (`ink` + `react`) for the rich Ink
  terminal client. That isolation is enforced by `test/tui-isolation.test.ts`
  (AC9): nothing outside `src/tui/` may import `ink`/`react`, and the SEA engine
  binary stays Ink-free (it never imports `src/tui/`, so esbuild tree-shakes it
  away). Do not add any other npm dependency, and do not let `ink`/`react` leak out
  of `src/tui/`.
- **Tests use `node:test` run via `tsx`**, and must run offline. Every extension
  is capability-gated and ships with tests.
- **Capabilities are the security vocabulary.** Privileged tools declare
  `capabilities: [...]` (e.g. `fs:read`, `shell:exec`) and the dispatcher
  enforces them before `execute` runs.
- **No Claude Code artifacts in the commit history.** Commits land under the
  human author's own identity only — never `Claude <noreply@anthropic.com>`. Do
  not add `Co-Authored-By: Claude …` or `Claude-Session: https://claude.ai/code/…`
  trailers, claude.ai links in PR bodies, or `claude/`-prefixed auto-branch names
  in merge subjects. This overrides any default agent/harness commit or PR footer.
  (Legitimate code references — the `anthropic` provider, model ids, the `claude`
  agent type, this `CLAUDE.md` file — are project content, not attribution, and
  stay.)

## Adding an extension

Default-export an `activate(e: ExtensionAPI)` function; register tools, commands,
providers, events, and filter hooks through the `ExtensionAPI` (the host tracks
every registration so reload/unload stays a clean swap); gate side effects behind
a capability; add an `EAGENT_<NAME>=off` kill switch when it observes or
intervenes by default; append it to `BUILTIN_EXTENSIONS` in `src/host.ts`; and
add an offline test. See `docs/EXTENSIONS.md` for the full author's guide.

Registering is a **transaction across code + docs**: `test/docs-drift.test.ts`
keys the extension count and load-order enumeration off `BUILTIN_EXTENSIONS`, so
adding one fails the suite until `CLAUDE.md` (the count above), `ARCHITECTURE.md`
(count + the ordered list), and `README.md` (a `` `name` `` table row + count) are
all synced. "Add one array line" is really: array entry + import + those three doc
updates, verified green.

## Working here

- **Process.** Non-trivial functional changes go through the `three-loop-workflow`
  skill (design → implementation → dev/review/accept → end-to-end review),
  fresh-reviewer-gated at each stage. Accumulate a batch on a `chore/<slug>`
  branch and PR to `init` (the trunk).
- **Status & history.** Git history and `CHANGELOG.md` are the record of what
  changed and why. The current authoritative surface is the code itself — the
  extension table in `README.md` and `BUILTIN_EXTENSIONS` in `src/host.ts`. When a
  doc disagrees with the code, the code wins.
- **macOS gotcha.** `grep` silently skips source files containing non-ASCII glyphs
  (`→`/`σ`/`≥`); use `grep -a` or the Read tool for audits.
