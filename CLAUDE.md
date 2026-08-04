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
   `node:` builtins. Guarded by `scripts/check-zero-dep.mjs`.
2. **The journal is the only authoritative durable state.** `runs`, `tasks`,
   `human_gates`, `checkpoints` are derived read models, rebuildable by folding.
   Never write a read model without appending the event that justifies it.
3. **`TaskId` is derived, never random** (`nodeId@branchPath#iteration`). Same for
   effect keys. A random id silently breaks replay.
4. **All nondeterminism goes through `ctx.effect(key, fn)`.** No bare `Date.now()`,
   `Math.random()`, or `fetch` in node bodies. Replay serves recorded results.
5. **Oversight posture composes by `max` over `out < on < in`.** Nothing may lower a
   posture except an explicit human `deescalate` call.
6. **One dispatch path for tools** (`ToolExecutor.invoke`). EAgent's bug was two;
   never write a second guard chain.
7. **Joins fold in branch-coordinate order**, never arrival order. Reducers must be
   associative; they need not be commutative because the order is fixed.
8. **Telemetry may drop data; the journal may not.** Backpressure hits admission,
   never durability.

## Layout

```
design/loom/       architecture (D1–D14) + JOURNAL.md (implementation log)
packages/core/     the engine. zero runtime deps. src/ + test/
scripts/           CI guards (zero-dep, public surface)
../eagent-ref      EAgent v1, read-only reference worktree
```

## Commands

```bash
npm run typecheck   # tsc -b (emits dist/) + tsc -p packages/core/tsconfig.test.json
npm test            # node --test over packages/*/test/**/*.test.ts
npm run check       # typecheck + test + both guards. THE gate.
node scripts/check-surface.mjs --write   # re-pin the public surface, then commit it
```

## Toolchain facts that shape the code

- **Node 24 + native TS type stripping.** Tests run `.ts` directly; there is no
  build step for tests and no `tsx`. Dev deps are `typescript` + `@types/node` only.
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
