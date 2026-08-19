# CLAUDE.md — orientation

Working file for the agent building this repo. **The code is the source of truth**;
where this file disagrees with the code, the code wins — fix this file.

## What this is

**Loom** — a graph-native multi-agent orchestration framework. Branch `loom` (orphan).

**The goal**, and the thing to measure work against:

> A **working single-node deployment** — someone can install it, write a graph, point it at
> a real provider, and have it run, with a human gate that works and a replay that
> reproduces. The distributed path stays open but unbuilt.

That is the bar. Correctness of the mechanism serves it and does not substitute for it — a
framework whose agent nodes can only return `[mock] …` is not a working deployment however
well-guarded its invariants are. (`--models-file` and the real provider adapters landed
for exactly this reason — `git log --grep='close the self-DoS'` — and before them the binary
could not call a model at all.)

**The thesis, in one line:** the executable graph is the runtime; an agent loop is one node
type inside it; every durable fact is an append-only journal entry — so parallelism, human
gates, replay, and observability are one mechanism.

Full architecture: `design/loom/`, indexed by `design/loom/README.md`.
Implementation decisions and state: `design/loom/JOURNAL.md` (append-only).

## EAgent — predecessor, and now a source

**EAgent** is the maintainer's prior agent harness, frozen at tag `eagent-v1` on branch
`init`, readable at `../eagent-ref` (a git worktree). It is 28k LOC: a 2.3k-LOC kernel and
21k LOC across 65 extensions.

**Decision (2026-08-16, maintainer): Loom becomes a monorepo and vendors what it needs from
EAgent's source.** `init` stays frozen and `../eagent-ref` stays the reference; vendored
files are copies, fixed on the way in, carrying a provenance header naming source path and
tag.

**Status: DECIDED, NOT BUILT.** Only `packages/core` exists today. Do not read the layout
section below as describing a tree that is there.

### Why vendoring, and what was refuted first

Three seams were considered. The two rejected ones are recorded because they are the
obvious ideas and will otherwise be re-proposed:

- **Hosted kernel** — Loom injects adapters into EAgent's four registries. **Refuted, four
  ways:** `ctx.effect` does not exist (invariant 4 says so; the plan used it anyway); the
  registries carry `#private` fields so they are typed *nominally* and no structural adapter
  can be passed; `@eagent/core` is not installable (no committed `dist/`, 404 on npm,
  `../eagent-ref` absent in CI); and `#invokeTool`/`#runAgent`/`#gates` are all `#`-private
  with `#dispatch` a hard-coded switch, so core could not stay untouched.
- **Subprocess** — exec `eagent-headless --json` under `runSandboxed`. Sound, and it
  preserved every invariant, but the SEA binary cannot ship EAgent
  (`scripts/build-binary.mjs:35`), making it a two-binary deployment, and Loom could not
  gate EAgent's individual tool calls.
- **Vendor the source.** ✅ Chosen. It is the only option that lets us *fix* what we take.

### What is actually worth taking, and what is not

Both independent plan reviews converged on this, from opposite directions: **the value is
in the extensions, not the loop.** EAgent's loop is ~320 lines over a `Message[]`, which
`Engine.#runAgent` already is — with journaling, budget reservation, replay, and
containment that EAgent's loop does not have.

So: **Loom's loop stays. EAgent's loop is not vendored.** What may be ported *into*
`#runAgent` is the small set of things EAgent's loop does that Loom's does not — the filter
points and `forceTool` — each journaled, which is the part EAgent never had. Parallel tool
waves are deliberately **not** ported: Loom derives tool ordinals from array position so
they stay replayable (`engine.ts:1993-1997`), and tool-level parallelism is what the graph
is for.

**The intake rule.** An extension is *redundant* if the engine already provides its
guarantee **durably** — the journal, `PolicyEngine`, `EventBus`, subgraph nodes, oversight,
and retry already cover checkpointing, cost, budget, tracing, sub-agents, and recovery.
Re-vendoring those adds a second, weaker, in-memory answer to a question the journal
already answers, which is invariant 2's failure mode. What is *additive* is what touches
the world — shell, MCP, search, web — and the guards over it.

Note before assuming a gap: core **already ships** `fs.read`, `fs.write`, `net.fetch`,
`fs.restore` (`packages/core/src/builtin/tools.ts`). The genuine gaps are shell execution,
grep/glob, structured edit, and MCP.

### Non-negotiable at intake

A file is not vendored until it satisfies the invariants. In particular:

| Fix | Why |
|---|---|
| exactly ONE `.execute(` path | inv 6. EAgent has **three** — `kernel/agent.ts:540`, the drifted hand-mirror `extensions/dynamic-workflow.ts:467`, and the unguarded `extensions/sweep-edit.ts:189`. The latter two are deleted, not ported |
| no `jiti`, no `ExtensionHost` | runtime `import()` of arbitrary code is not something Loom does |
| no parameter properties, `.ts` specifiers | `erasableSyntaxOnly`; Node 24 type-stripping |
| no `Date.now()`/`Math.random()` on a recorded path | inv 4 |
| tools declare `version`, `irreversibility`, `idempotent` | `ToolDefinition` requires them; EAgent's `Tool` has none |
| capability → posture, never a private grant | inv 5. `CapabilityManager.grant()` auto-allows *before* consulting anything (`capabilities.ts:114-117`), and `core-tools.ts:48-49` grants `fs:read` **and `fs:write`** unconditionally at activation — ported naively, every fs tool runs at effective `out` |

## Invariants — violating any of these is a bug, not a tradeoff

1. **`@loom/core` has zero runtime dependencies.** No bare import specifiers except
   `node:` builtins, and no route into `node_modules` that a parser cannot read —
   `createRequire`, a bare `require(…)`, an `import()` with a computed specifier.
   Guarded by `scripts/check-zero-dep.mjs`, which is the ONLY automatic enforcement:
   `build:binary`'s metafile backstop is not in CI, and esbuild cannot see a runtime
   `require` either. **The monorepo does not weaken this**: the guard is scoped by
   `process.argv[2] ?? "packages/core"` and CI passes no argument, so it keeps scanning
   core alone. Other packages may carry dependencies; core may not, and core may not
   import them.
2. **The journal is the only authoritative durable state.** `runs`, `tasks`,
   `human_gates`, `checkpoints` are derived read models, rebuildable by folding.
   Never write a read model without appending the event that justifies it.
3. **`TaskId` is derived, never random** (`nodeId@branchPath#iteration`). Same for
   effect keys. A random id silently breaks replay.
4. **Every nondeterministic call is journaled under a derived effect key.** The
   boundary is inside `Engine` — `effectKey(taskId, kind, ordinal)` from `src/ids.ts`,
   with `kind` one of `model`, `tool`, `subgraph`, `summarize` — and replay serves the
   recorded result instead of calling out. **The kind in the key and the `kind` on
   `effect.started` must agree**, and for two of the four sites they did not: the subgraph
   effect keyed `subgraph` and declared `mailbox`, the summariser keyed `summarize` and
   declared `model`. Not by choice — neither word was in the event's union, so the honest
   value would not typecheck. An auditor filtering by `kind` therefore could not find a
   single summarisation. The union is now the superset and the sites are honest.
   `summarize`'s ordinal is the TURN: it was a literal `0`, which was invisible only while
   the section it summarised was never populated (see below) and would otherwise collide
   every summary in a task onto one key. **There is no `ctx.effect` and no
   `ctx.random`**: a node body is handed `{taskId, signal, now}` (`function`) or
   `{taskId, signal, progress}` (`tool`), and nothing else. Two gaps sit inside this
   invariant rather than outside it, so do not read it as a closed boundary: the clock
   is *outside* it (`FunctionContext.now` is the injected clock passed straight
   through, appending nothing), and `Math` reaches a `function` resource whole, so
   `Math.random()` runs unrecorded while `Date` is `undefined`. `effect.started`
   declares `clock` and `random` kinds that nothing appends. See HANDOFF D11.
5. **Oversight posture composes by `max` over `out < on < in`.** Nothing may lower a
   posture except an explicit human `deescalate` call. An `agent` node's floor is the
   `max` over every tool it can REACH (`reachableToolNames`), not over the one it
   names — it names none.
6. **One dispatch path for tools** — `Engine.#invokeTool` in `src/run/engine.ts`,
   private on purpose, the only caller of `ToolDefinition.execute`
   (`grep -ran '\.execute(' packages/core/src/` returns exactly one line). EAgent's bug
   was two — actually three, verified at `eagent-v1`; never write a second guard chain.
   `design/loom/` calls this boundary `ToolExecutor` and describes an `invoke` that
   returns a stream; no such symbol exists in `packages/` — D3.6 carries the reality
   block that says so.
7. **Joins fold in branch-coordinate order**, never arrival order. Reducers must be
   associative; they need not be commutative because the order is fixed.
8. **Telemetry may drop data; the journal may not.** Backpressure hits admission,
   never durability.

## Layout

```
design/loom/       architecture (D1–D14) + JOURNAL.md (implementation log)
packages/core/     the engine. zero runtime deps. src/ + test/
scripts/           CI guards (zero-dep, public surface) + the SEA build
.agent/<task>/     per-task working state (gitignored); plan.md is the re-entry point
../eagent-ref      EAgent v1, read-only reference worktree — the vendoring source
```

**Where vendored code actually went, and why it is not `packages/tools/`.** The plan said a
separate package; building it changed the answer. Everything taken so far needs **no
dependency** — `fs.edit`/`fs.glob`/`fs.grep` are pure Node, `proc.exec` wraps the sandbox
already in core, and the MCP client is newline-JSON over `node:child_process`. A capability
that needs no dependency belongs in core, because `build:binary` bundles
`packages/core/dist/cli.js` **only**: a capability living in another package is absent from
the single binary, and the single binary is the deployment.

So the rule is: **zero-dep capability → `packages/core/src/`; a package only when something
genuinely needs a dependency.** `packages/skills/` (library/recipes/prompts as data) is still
the likely first one, and is not built.

## Commands

```bash
npm run typecheck   # tsc -b --force (emits dist/) + tsc -p packages/core/tsconfig.test.json
npm test            # node --test over packages/*/test/**/*.test.ts
npm run check       # typecheck + test + both guards. THE gate.
npm run build:binary   # bin/loom; fails if any node_modules input appears
node scripts/check-surface.mjs --write   # re-pin the public surface, then commit it
```

`--force` is load-bearing, not tidiness. `tsc -b` decides whether to build by comparing
input timestamps against output timestamps, so a tree whose sources are older than its
`dist/` is "up to date" whatever it now says: the build is skipped, `node --test` strips
types rather than checking them, and `check-surface.mjs` then reads a `dist/index.d.ts`
that no longer describes `src/`. Reproduced — the whole gate green with an unpinned
public export in the tree. `npm run typecheck:fast` is the incremental one; it is for the
inner loop and is not a gate.

**Adding a package is a four-file transaction**, and skipping any part of it re-creates a
trap this project has already hit: root `tsconfig.json` `references`, the package's own
`tsconfig.json` + `tsconfig.test.json`, and the root `typecheck` script — which today
hardcodes `tsc -p packages/core/tsconfig.test.json`. `npm test` globs `packages/*/test/`
and so *runs* a new package's tests automatically, but under Node's type-stripping that
executes them without type-checking. A new package whose test config is not wired is a
package whose tests are untypechecked while appearing to pass.

## Toolchain facts that shape the code

- **Node 24 + native TS type stripping.** Tests run `.ts` directly; there is no
  build step for tests and no `tsx`. Dev deps are `typescript` + `@types/node`, plus
  `esbuild` + `postject` at the **root** for `build:binary` alone. Invariant 1 is a
  statement about `packages/core/package.json`, whose every dependency field is empty,
  so a consumer of `@loom/core` downloads neither bundler.
- **`erasableSyntaxOnly` is on**, so: no `enum`, no `namespace`, no parameter
  properties. Use `const` objects + union types.
- **Source imports use `.ts` specifiers** (`from "./ids.ts"`). `tsc` rewrites them to
  `.js` on emit via `rewriteRelativeImportExtensions`. Do not write `.js` in source.
- **`node:sqlite` is the durable store** — built in, so zero-dep holds.
- **`exactOptionalPropertyTypes` is on.** `foo?: T` and `foo: T | undefined` differ;
  build objects conditionally rather than assigning `undefined`.
- **`build:binary` bundles `packages/core/dist/cli.js` only** (`scripts/build-binary.mjs:35`).
  Anything that must ship in the single binary has to be reachable from that entry point —
  a capability living only in another package is absent from the binary.

## Working rules

- Every module starts with a docstring saying *why it exists*, not what it does.
- Every non-obvious decision gets a line in `design/loom/JOURNAL.md` with its
  reversal condition.
- Tests are offline and deterministic. No network, no API key, no wall-clock
  dependence. Inject clocks and ids.
- Commit under the human author's identity only. **No Claude attribution, no
  `Co-Authored-By`, no claude.ai links** — this carried over from EAgent and is
  non-negotiable.
- When the design in `design/loom/` turns out to be wrong, fix the design file and
  note the change in the journal. Do not let code and design drift silently.
- **`grep` on macOS silently skips files containing non-ASCII bytes**, and both this tree
  and `../eagent-ref` have them. Always `grep -a`. Empty output from a plain `grep` is not
  evidence of absence — this has produced false "verified" claims here before.
- **Verify a mechanism exists before building on it.** Two plans in this repo have cited
  symbols that do not exist (`ctx.effect`, a `GRAPH008_JOIN_DEPTH` guard). Both times the
  prose was in the corpus and the code was not. Grep for the symbol, not the sentence.
