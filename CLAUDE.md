# CLAUDE.md — orientation

Working file for the agent building this repo. **The code is the source of truth**;
where this file disagrees with the code, the code wins — fix this file.

## What this is

**Loom** — a graph-native multi-agent orchestration framework. Branch `loom` (orphan).
The predecessor **EAgent** is frozen at tag `eagent-v1` on branch `init`; it is a
reference text, never a dependency. Read it at `../eagent-ref` (a git worktree).

Full architecture: `design/loom/`. Read `design/loom/README.md` for the index.
Implementation decisions and state: `design/loom/JOURNAL.md` (append-only).

## The thesis, in one line

The executable graph is the runtime; an agent loop is one node type inside it; every
durable fact is an append-only journal entry — so parallelism, human gates, replay,
and observability are one mechanism.

## Invariants — violating any of these is a bug, not a tradeoff

1. **`@loom/core` has zero runtime dependencies.** No bare import specifiers except
   `node:` builtins, and no route into `node_modules` that a parser cannot read —
   `createRequire`, a bare `require(…)`, an `import()` with a computed specifier.
   Guarded by `scripts/check-zero-dep.mjs`, which is the ONLY automatic enforcement:
   `build:binary`'s metafile backstop is not in CI, and esbuild cannot see a runtime
   `require` either.
2. **The journal is the only authoritative durable state.** `runs`, `tasks`,
   `human_gates`, `checkpoints` are derived read models, rebuildable by folding.
   Never write a read model without appending the event that justifies it.
3. **`TaskId` is derived, never random** (`nodeId@branchPath#iteration`). Same for
   effect keys. A random id silently breaks replay.
4. **Every nondeterministic call is journaled under a derived effect key.** The
   boundary is inside `Engine` — `effectKey(taskId, kind, ordinal)` from `src/ids.ts`,
   with `kind` one of `model`, `tool`, `subgraph`, `summarize` — and replay serves the
   recorded result instead of calling out. **There is no `ctx.effect` and no
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
   was two; never write a second guard chain. `design/loom/` calls this boundary
   `ToolExecutor` and describes an `invoke` that returns a stream; no such symbol
   exists in `packages/` — D3.6 carries the reality block that says so.
7. **Joins fold in branch-coordinate order**, never arrival order. Reducers must be
   associative; they need not be commutative because the order is fixed.
8. **Telemetry may drop data; the journal may not.** Backpressure hits admission,
   never durability.

## Layout

```
design/loom/       architecture (D1–D14) + JOURNAL.md (implementation log)
packages/core/     the engine. zero runtime deps. src/ + test/
scripts/           CI guards (zero-dep, public surface) + the SEA build
../eagent-ref      EAgent v1, read-only reference worktree
```

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
