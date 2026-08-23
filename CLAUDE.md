# CLAUDE.md — orientation

Working file for the agent building this repo. **The code is the source of truth**;
where this file disagrees with the code, the code wins — fix this file.

## Start here

1. **`design/loom/HANDOFF.md`** — where things stand, what is left, what will bite you. It is
   the re-entry point after a compaction or a fresh session; read it before planning anything.
2. `design/loom/REGISTER.md` — the defect archive (`A1`…`E8`). **Grep it, do not read it.**
3. `design/loom/JOURNAL.md` — append-only, newest last. *Why* a decision was made.
4. `design/loom/README.md` — index of the architecture documents D1–D14.

## What this is

**Loom** — a graph-native multi-agent orchestration framework. Branch `loom` (orphan).

**The goal**, and the thing to measure work against:

> A **working single-node deployment** — someone can install it, write a graph, point it at
> a real provider, and have it run, with a human gate that works and a replay that
> reproduces. The distributed path stays open but unbuilt.

That is the bar. Correctness of the mechanism serves it and does not substitute for it — a
framework whose agent nodes can only return `[mock] …` is not a working deployment however
well-guarded its invariants are.

**Today the bar is met**, and the caveat that stood here — replay could not reproduce a run
whose posture a human lowered — is closed: `replayRun` now serves recorded `policy.deescalated`
events the same way it serves gate decisions, rekeyed onto the shadow run's id. Every clause is
verified end to end, most of them through `bin/loom` rather than only through `node`.

**Be suspicious of that sentence anyway.** Closing T4 immediately turned up a bigger hole one
level up: `replayRun`'s `compare` weighed task states, channels and status and NEVER GATES, so
a replay that asked a human a different number of times — including none at all — reported
`match: true`. The verdict every consumer reads (`loom replay`'s exit code, the D10 promotion
gate) was blind to the oversight it exists to re-derive. **A bar is met against the checks that
exist; the checks are the thing to distrust.**

**The thesis, in one line:** the executable graph is the runtime; an agent loop is one node
type inside it; every durable fact is an append-only journal entry — so parallelism, human
gates, replay, and observability are one mechanism.

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
2. **The journal is the only authoritative durable state.** `runs`, `tasks` and
   `human_gates` are derived read models, rebuildable by folding. Never write a read model
   without appending the event that justifies it — **and never hold authoritative state in a
   field with no fold behind it.** That second half is not decoration: the taint set was
   in-memory only, so a restart silently switched off the prompt-injection guard, and it was
   the fourth such field found (escalations, ceilings and spend preceded it). If a decision
   reads it, the journal must be able to rebuild it.
   (`checkpoints` used to be listed here and there is no such read model: `checkpoint.created`
   is written by one site and read only by `telemetry/spans.ts`, and `rewind` targets a raw
   `Seq`, never a `CheckpointId`. Naming a read model that does not exist is the same defect
   this invariant is about, one level up.)
3. **`TaskId` is derived, never random** (`nodeId@branchPath#iteration`). Same for
   effect keys. A random id silently breaks replay.
4. **Every nondeterministic call is journaled under a derived effect key.** The
   boundary is inside `Engine` — `effectKey(taskId, kind, ordinal)` from `src/ids.ts`,
   with `kind` one of `model`, `tool`, `subgraph`, `summarize` — and replay serves the
   recorded result instead of calling out. **The kind in the key and the `kind` on
   `effect.started` must agree.** `summarize`'s ordinal is the TURN, not a literal `0`,
   which would collide every summary in a task onto one key.
   **There is no `ctx.effect` and no `ctx.random`**: a node body is handed `{taskId, signal,
   now}` (`function`) or `{taskId, signal, progress}` (`tool`), and nothing else. Two gaps sit
   inside this invariant rather than outside it, so do not read it as a closed boundary: the
   clock is *outside* it (`FunctionContext.now` is the injected clock passed straight through,
   appending nothing), and `Math` reaches a `function` resource whole, so `Math.random()` runs
   unrecorded while `Date` is `undefined`. `effect.started` declares `clock` and `random` kinds
   that nothing appends. See REGISTER D11.
5. **Oversight posture composes by `max` over `out < on < in`.** Nothing may lower a
   posture except an explicit human `deescalate` call. An `agent` node's floor is the
   `max` over every tool it can REACH (`reachableToolNames`), not over the one it
   names — it names none.
   **A human ceiling is the one thing that can lower, and it has a hard floor under it**: never
   below `on` for an `irreversible` or `externally_visible` action, and never below `in` while
   that action is **tainted** (E8). Taint is *not* a term in the `max` — written as one it was
   the identity, because `CLASS_DEFAULT_POSTURE` already puts both hard classes at `in`. The
   hard floor is the only place it can change an answer.
6. **One dispatch path for tools** — `Engine.#invokeTool` in `src/run/engine.ts`,
   private on purpose, the only caller of `ToolDefinition.execute`
   (`grep -ran '\.execute(' packages/core/src/` returns exactly one line). EAgent's bug
   was three; never write a second guard chain.
   `design/loom/` calls this boundary `ToolExecutor` and describes an `invoke` that
   returns a stream; no such symbol exists in `packages/` — D3.6 carries the reality
   block that says so.
7. **Joins fold in branch-coordinate order**, never arrival order. Reducers must be
   associative; they need not be commutative because the order is fixed.
8. **Telemetry may drop data; the journal may not.** Backpressure hits admission,
   never durability.

## Layout

```
design/loom/       architecture (D1–D14) + HANDOFF.md + REGISTER.md + JOURNAL.md
packages/core/     the Loom engine. ZERO runtime deps. src/ + test/
packages/eagent/   EAgent — the agent kernel + 65 extensions. May carry deps (it has `jiti`)
scripts/           CI guards (zero-dep, public surface) + the SEA build
.agent/<task>/     per-task working state (gitignored); plan.md is the re-entry point
../eagent-ref      a worktree on the frozen `init` branch. Historical reference ONLY —
                   EAgent is developed HERE now, not there
```

**Two packages, and the split is a rule rather than a stage.** `build:binary` bundles
`packages/core/dist/cli.js` **only**, so a capability living in another package is absent from
the single binary — and the single binary is the Loom deployment. Hence: **a zero-dep capability
Loom needs goes in `packages/core/src/`; a package exists when something genuinely needs
dependencies or is its own product.** `packages/eagent` is the second kind: it is EAgent, it
ships its own CLI, and it carries `jiti`. `packages/core` may not import it, and does not.

`packages/skills/` (library/recipes/prompts as data) is still the likely third, and is not built.

**Adding a package is a four-file transaction**, and adding `packages/eagent` exercised every
part of it: root `tsconfig.json` `references`, the package's own `tsconfig.json` +
`tsconfig.test.json`, and the root `typecheck` script, which names each test config
explicitly. `npm test` globs `packages/*/test/` and so *runs* a new package's tests
automatically, but under Node's type-stripping that executes them WITHOUT type-checking — so a
package whose test config is not named in `typecheck` is a package whose tests are
untypechecked while appearing to pass.

One more thing the import found, worth knowing before you add the third package: a guard can
couple itself to the package list by accident. `toolchain-gate.test.ts` built its throwaway
replica by COPYING the root `tsconfig.json`, so the moment that file referenced a package the
replica did not contain, `tsc -b` failed there for a reason unrelated to what the guard tests.
It now writes its own reference list.

## Commands

```bash
npm run check       # typecheck + test + both guards. THE gate.
npm test            # tests only
npx tsc -p packages/core/tsconfig.test.json     # read-only typecheck, safe under concurrency
npx tsc -p packages/eagent/tsconfig.test.json  # ...and the other package
node --test packages/core/test/<file>          # one suite
node --test "packages/eagent/test/**/*.test.ts"   # EAgent's suite alone
npm run build:binary                           # bin/loom; fails if any node_modules input appears
node scripts/check-surface.mjs --write         # re-pin the public surface, then commit surface.json
```

`--force` in `typecheck` is load-bearing, not tidiness. `tsc -b` decides whether to build by
comparing input timestamps against output timestamps, so a tree whose sources are older than its
`dist/` is "up to date" whatever it now says: the build is skipped, `node --test` strips types
rather than checking them, and `check-surface.mjs` then reads a `dist/index.d.ts` that no longer
describes `src/`. Reproduced — the whole gate green with an unpinned public export in the tree.
`npm run typecheck:fast` is the incremental one; it is for the inner loop and is not a gate.

**If several agents or shells are working at once, do not run `npm run check`, `npm run build`
or a bare `tsc -b`** — concurrent `tsc -b` races on emit. Use the read-only typecheck instead.

## Toolchain facts that shape the code

- **Node 24 + native TS type stripping.** Tests run `.ts` directly; there is no build step for
  tests and no `tsx`. Dev deps are `typescript` + `@types/node`, plus `esbuild` + `postject` at
  the **root** for `build:binary` alone. Invariant 1 is a statement about
  `packages/core/package.json`, whose every dependency field is empty.
- **`erasableSyntaxOnly` is on**, so: no `enum`, no `namespace`, no parameter properties. Use
  `const` objects + union types.
- **Source imports use `.ts` specifiers** (`from "./ids.ts"`). `tsc` rewrites them to `.js` on
  emit via `rewriteRelativeImportExtensions`. Do not write `.js` in source.
- **`node:sqlite` is the durable store** — built in, so zero-dep holds.
- **`exactOptionalPropertyTypes` is on.** `foo?: T` and `foo: T | undefined` differ; build
  objects conditionally rather than assigning `undefined`.

## EAgent — in this repo, and developed here

**EAgent** is the maintainer's prior agent harness: a ~2.3k-LOC kernel plus 65 extensions,
1541 tests. It lives at **`packages/eagent/`** and is developed here. `init` (tag `eagent-v1`)
and the `../eagent-ref` worktree are frozen history, not the source of truth — do not edit
there, and do not treat a difference between the two as drift to reconcile.

**It was conformed to Loom's toolchain on the way in**, which is why it runs under the same
gate: 1032 relative import specifiers rewritten `.js` → `.ts`, 20 TypeScript parameter
properties hoisted to fields (`erasableSyntaxOnly` forbids them), and the `--import tsx`
spawns dropped — Node 24's native type stripping replaces the loader. Its tsconfig extends
`tsconfig.base.json` but turns OFF three flags EAgent predates
(`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noImplicitReturns`).
Turning those on is a migration somebody may choose to do; it is not required for the gate.

**What the two share, and what they must not.** `packages/core` holds three files FORKED from
EAgent — `builtin/edit-match.ts`, `builtin/search-match.ts`, `mcp/client.ts`. They stay forks:
core has zero runtime dependencies and may not import a sibling package (invariant 1), and
`build:binary` bundles core's entry alone, so an import would put the capability outside the
binary. Each names its in-repo origin, so the two copies can now be diffed instead of trusted.

**Loom's loop is not EAgent's, and neither replaces the other.** EAgent's loop is ~320 lines
over a `Message[]`; `Engine.#runAgent` is the same shape with journaling, budget reservation,
replay and containment that EAgent's does not have. Parallel tool waves are deliberately absent
from Loom: it derives tool ordinals from array position so they stay replayable, and
tool-level parallelism is what the graph is for.

**If you move code from `packages/eagent` into `packages/core`,** it must satisfy the
invariants first: exactly ONE `.execute(` path (inv 6 — EAgent has three); no `jiti` and no
`ExtensionHost`, because runtime `import()` of arbitrary code is not something core does; no
parameter properties; no `Date.now()`/`Math.random()` on a recorded path (inv 4); tools declare
`version`, `irreversibility`, `idempotent`; and capability → posture, never a private grant
(inv 5 — EAgent's `CapabilityManager.grant()` auto-allows *before* consulting anything, and its
core tools grant `fs:read` **and `fs:write`** unconditionally at activation).

## Working rules

- Every module starts with a docstring saying *why it exists*, not what it does.
- Every non-obvious decision gets a line in `design/loom/JOURNAL.md` with its reversal condition.
- Tests are offline and deterministic. No network, no API key, no wall-clock dependence — inject
  clocks and ids. A test that takes seconds is usually one that forgot `sleep: async () => {}`.
- **Mutation-test every new guard.** Revert the fix, watch the new test go red, restore. A test
  that still passes with the fix removed is a test that cannot fail, and this repo has written
  several — including one in the same wave that ran a mutation sweep.
- **Reproduce before fixing, and reproduce by running, not by reading.** Every wave that found
  real defects found them by running a *new shape* of thing.
- **Name every site that touches the value, and write the list into the claim.** "This boundary
  is total" cannot be checked; a claim that names its set can.
- Commit under the human author's identity only. **No Claude attribution, no `Co-Authored-By`,
  no claude.ai links** — this carried over from EAgent and is non-negotiable.
- **Never cite a git SHA in `design/` or this file.** Name a commit by a fragment of its subject
  and find it with `git log --oneline --grep='<fragment>'`. A corpus that cites SHAs acquires a
  silent dependency on history never moving.
- When the design in `design/loom/` turns out to be wrong, fix the design file and note the
  change in the journal. Do not let code and design drift silently.
- **`grep` on macOS silently skips files containing non-ASCII bytes**, and both this tree and
  `../eagent-ref` have them. Always `grep -a`. Empty output from a plain `grep` is not evidence
  of absence — this has produced false "verified" claims here before.
- **Verify a mechanism exists before building on it.** Two plans in this repo have cited symbols
  that do not exist (`ctx.effect`, a `GRAPH008_JOIN_DEPTH` guard). Both times the prose was in
  the corpus and the code was not. Grep for the symbol, not the sentence.
