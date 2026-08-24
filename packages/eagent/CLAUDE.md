# CLAUDE.md — `packages/eagent`

Orientation for an AI agent working in **this package**. **The code is the source
of truth**; where this file and the code disagree, the code wins — fix this file.

> **This is one package inside the Loom monorepo.** The repository root's `CLAUDE.md` is the
> project guide and governs the gate, the invariants and the commit rules; this file covers
> EAgent specifically. EAgent moved here from its own repository on 2026-08-21 and is developed
> here — the `init` branch (tag `eagent-v1`) and the `../eagent-ref` worktree are frozen history,
> not the source of truth.

<!-- Anchor map (read by the three-loop-workflow skill; maps a role to this file's heading) -->
- _repo-workflow_       → "## Working here"
- _common-commands_     → "## Key commands"
- _engineering-norms_   → "## House conventions"
- _load-bearing-docs_   → "## Load-Bearing Documents"

## One package

**`@eagent/core`** — the engine: kernel, providers, extensions, the HTTP host, and the
headless `eagent-headless` CLI. Zero runtime dependencies but `jiti`.

The interactive terminal client that used to ship beside it as `eagent` was **deleted
2026-08-25**. The rich surface is the browser, served by the HTTP host. Nothing claims the
bare `eagent` bin name today; which entry point should own it is a packaging decision the
redesign will take, and `test/zero-dep.test.ts` deliberately asserts it stays unclaimed so
that decision is not made by accident.

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
and keeps `src/kernel/` under a hard line ceiling (2,335 lines; the metric is
`split("\n").length` summed over `src/kernel/*.ts`, currently ~2,331 — a few
lines of slack). The ceiling moved from 2,200 to 2,250 when the `Config`
interface + `envOnlyConfig` fallback were added to `store.ts` for the injected
`e.config` facility, then from 2,250 to 2,265 for the multi-tenant isolation
seam (`currentRootAgent()` + a `rootAgentStore` ALS, the `e.agent`/`e.rootAgent`
getters), then from 2,265 to 2,335 for the interactive permission seams — `UI.decide?`
(a structured permission request, since `confirm`'s single pre-formatted string
cannot carry a diff or a command), `CapabilityManager.setFallback`/`forget`
(without which a permission-mode control cannot exist: the fallback was
constructor-only and every answer was remembered forever, so cycling back to
`ask` was a silent no-op), and the `tool_progress` event for live tool output —
deliberate explicit decisions. Adding to the kernel means golfing
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
# Run these FROM THE REPOSITORY ROOT — the gate is the monorepo's, not this package's.
npm run check     # THE gate: typechecks + BOTH packages' suites + Loom's guards
npm test          # both suites, offline against MockProvider (no API key)
npm run eagent    # this package's headless CLI  (--eval / piped stdin)

# Scoped to this package — from the root, `npm --prefix packages/eagent run <script>`:
npm --prefix packages/eagent test          # EAgent's suite alone
npm --prefix packages/eagent run typecheck # src + test, read-only
npm --prefix packages/eagent run eval      # offline evals-as-CI gate (exits non-zero on failure)
npm --prefix packages/eagent run dev       # headless CLI
npm --prefix packages/eagent run serve     # the HTTP host
npm --prefix packages/eagent run build:binary   # esbuild + Node-SEA -> bin/eagent

# THERE IS NO `tsx`. Node 24 strips types natively and every relative import
# specifier under `src/` and `test/` says `.ts`, so `node --test` runs the source directly.
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
- `src/cli.ts` — the **headless** host: one-shot (`--eval`), piped batch, and
  `--json`. It mounts no display, so no cursor or alt-screen byte can reach a pipe
  by construction.
- **The human display layer is not in the engine.** `src/print.ts` is the only
  human-readable output the engine emits — a plain stream printer for the machine
  paths (assistant text to stdout, tool/reasoning/error annotations to stderr).
  The rich surface is the **browser**, served by `src/server.ts` over HTTP + SSE.
  Keeping every display out of the engine is what keeps `src/` zero-dep and
  embeddable — a library consumer must never download a rendering stack.
- `src/complete.ts` — a pure, offline-testable `complete(line, ctx)` completion
  engine, consumed by whatever front end is attached.
- `src/server.ts` — the HTTP host (`GET /health`, `POST /run`, `POST /answer`
  for a mid-turn elicitation reply, `GET /sessions/:id` for a session's usage +
  cost summary, `DELETE /sessions/:id`), plus additive, read-mostly **monitor
  endpoints** for remote clients (zero-dep): `GET /sessions` (list
  `{id, running, usage, costUsd}`), `GET /sessions/:id/events` (a per-session SSE
  feed, tenant-isolated by the run-tree root agent), `GET /events` (a global SSE
  feed with each frame tagged by its `session` id), and `POST /sessions/:id/stop`
  (abort a running turn). Sessions are isolated per session id and run
  **concurrently** (a same-session second `/run` gets 409; different sessions
  overlap); all per-session extension state is keyed on the run-tree root Agent.
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

- **ESM + NodeNext, and specifiers say `.ts`.** Write
  `import { defineTool } from "../kernel/define.ts"`. **This rule used to say the opposite** —
  "always use `.js` … even when importing a `.ts` file" — which was true in EAgent's own
  repository and stopped being true at the move: conforming to Loom's toolchain rewrote 1032
  relative specifiers `.js` → `.ts`, because Node 24 strips types from the file you actually
  name. Re-derived rather than remembered: `packages/eagent/src` contains **zero** relative
  `.js` specifiers and **433** `.ts` ones. Following the old rule now produces an import that
  resolves to nothing at runtime.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are all on. No `any`
  cop-outs; model the types. The build `tsconfig.json` covers `src/` only;
  `tsconfig.test.json` covers `src/` + `test/` and **the root `typecheck` script names it
  explicitly**, so test files ARE type-checked here — that was not true before the move, and
  a stale note saying otherwise is how a real type error gets waved off as an editor
  false positive. `examples/` remains unchecked.

  This package's tsconfig extends the monorepo's `tsconfig.base.json` but turns OFF three
  flags EAgent predates: `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`,
  `noImplicitReturns`. Turning them on is a migration, not a bug fix.
- **Zero runtime dependencies in the engine (except `jiti`).** The kernel,
  providers, extensions, server, and CLI-engine — everything the SEA `bin/eagent`
  bundles — stay zero-runtime-dep: providers use the global `fetch`; nothing pulls
  in an SDK. Do not add any other npm dependency. Enforced by
  `test/zero-dep.test.ts` (runtime `dependencies` ⊆ `{ jiti }`; no ink/react
  imports under `src/` or `test/`). No UI framework may enter this package at all: a library consumer must never download a
  rendering stack to use the engine.
- **Tests use `node:test`, run directly by `node --test`**, and must run offline. Every extension
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

## Load-Bearing Documents

Contract surfaces. A change that alters a rule or shape here takes the Deep tier: alternatives
recorded before choosing, a plan in `.agent/plan.md`, two independent reviewers, and a closeout pass.

- `src/kernel/*.ts` — kernel core; its surface is already pinned by `test/kernel-surface.test.ts`
- `package.json` — published `exports` and `bin` entries
- `ARCHITECTURE.md` — the small-core bet this project is organised around
- `CLAUDE.md` — this file
- `docs/EXTENSIONS.md` — the extension API every extension is written against
- `docs/JSONL.md` — the on-disk session format, which persisted data depends on

**Not** load-bearing — these take Standard or Direct: `src/extensions/**`, `test/**`,
`evals/**`, and the remaining `docs/*.md`.

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
