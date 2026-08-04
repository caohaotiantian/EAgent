# Implementation journal

Append-only. Newest entries at the bottom. Records decisions made **while building**
that are not in the architecture docs, deviations from them, and current state.

Format per entry: `## <date> — <milestone> — <title>`, then what changed, why, what it
rejects, and what would reverse it.

---

## Status board

| Milestone | State | Exit criterion | Evidence |
|---|---|---|---|
| M0 scaffold + CI | **done** | `npm run check` green offline, no runtime deps | 32 tests, both guards pass |
| M1a ids/errors/canonical | **done** | branch order total; digests stable; codes unique | `packages/core/test/{ids,canonical,errors}.test.ts` |
| M1b journal StateStore | **done** | racing appends → exactly one lands | 76 tests; one conformance suite passes against both memory and SQLite stores |
| M1c EventBus | pending | slow subscriber cannot stall the producer | — |
| M1d channels + reducers | pending | fold order independent of arrival order | — |
| M1e GraphCompiler | pending | incident-triage compiles; every rule has a negative test | — |
| M2 walking skeleton | pending | all 12 rows of `08-PLAN.md` D13.3 | — |

Open threads that need resolving before the milestone they block:

- **T1 (blocks M1e):** YAML→JSON conversion lives outside core. Core is JSON-only.
  The CLI will need a YAML reader; decide dep-vs-subset-parser at M2.
- **T2 (blocks M2):** the `function` node resource loader needs a sandbox story for
  v1. Current plan: `function` resources are trusted, pinned, and loaded via dynamic
  `import()` of a digest-addressed file. Not untrusted-input safe — by design (A13).
- **T3 (blocks M2):** `node:sqlite` is still flagged experimental in Node 24; it
  prints a warning on first use. Need to decide whether to suppress it for CLI UX.

---

## 2026-08-04 — M0 — Node 24 native type stripping instead of a build step for tests

**Decision.** Tests are `.ts` files run directly by `node --test`; source imports use
`.ts` specifiers; `tsc` rewrites them to `.js` on emit
(`rewriteRelativeImportExtensions`). Dev dependencies are `typescript` and
`@types/node` only.

**Why.** EAgent needed `tsx` to run its suite. Node 24 strips types natively, so the
test path has zero tooling between the source and the runtime — which matters because
a transpiler in the test path is a place where determinism bugs can hide.

**Rejects.** `tsx`/`ts-node` (an extra dev dep and a second module resolver);
compiling tests to JS first (slow edit loop, and stack traces point at generated code).

**Reverses if.** Node's type-stripping flags change semantics, or a dependency
requires a transform type stripping cannot do (decorators, `enum`).
`erasableSyntaxOnly: true` is on precisely so this cannot creep in unnoticed.

---

## 2026-08-04 — M0 — Pin the public surface, not a line count

**Decision.** `scripts/check-surface.mjs` snapshots every exported name of
`@loom/core` (resolved by the TypeScript checker, not a regex) into
`scripts/surface.json`. CI fails when it changes without the pin being updated.

**Why.** EAgent's kernel line ceiling was raised four times, each time for something
genuinely primitive. A line ceiling taxes correct primitives and incidental ones
equally; a name pin taxes only new public contract, which is the thing that is
actually expensive to get wrong.

**Rejects.** A kernel line ceiling (`test/kernel-surface.test.ts` in `eagent-v1`).

**Reverses if.** The surface grows for reasons the pin does not catch — e.g. one
exported `Config` object accumulating fields. If that happens, add a shape check, not
a line count.

---

## 2026-08-04 — M0 — `node:sqlite`, not `better-sqlite3`

**Decision.** The durable store uses Node 24's built-in `node:sqlite`.

**Why.** It is the only way to have a real SQL durable store **and** hold the
zero-runtime-dependency invariant, which is what makes the single-binary
deployment possible (`design/loom/07-CONFIG-DEPLOY.md` D12.1). A native module would
also complicate SEA packaging.

**Rejects.** `better-sqlite3` (native build, breaks SEA, adds a dep); a hand-rolled
append-only file format (no query path for the ops console, and a second thing to get
crash-safe).

**Reverses if.** `node:sqlite`'s API breaks across Node majors in a way that costs
more than the dependency would, or WAL append throughput falls short of the 5k
events/s target from A5 (measure at M3).

---

## 2026-08-04 — M1a — Canonicalization rejects ambiguity instead of coercing it

**Decision.** `canonicalize()` throws on `NaN`, `Infinity`, `undefined` inside an
array, `Date`, `Map`, `Set`, `bigint`, and cycles.

**Why.** `JSON.stringify` silently maps several of those to `null` or drops them,
which would make two materially different values produce the same digest. Since
`graph.hash` and `state.hash` are the mechanism behind replay verification and the
"one artifact" guarantee, a silent collision there is not a nuisance — it is a
correctness hole that only shows up as an unexplainable replay mismatch months later.

**Rejects.** Coercing to `null` (fast, silent, wrong); allowing `Date` (its
serialization is locale/precision-sensitive — epoch millis are unambiguous).

**Reverses if.** A legitimate payload type needs one of these. Then add an explicit
tagged encoding (e.g. `{"$date": 1700000000000}`), never an implicit coercion.

---

## 2026-08-04 — M1a — `compareBranch` compares indices numerically

**Decision.** Branch coordinates sort by `(edgeId lexicographic, index numeric)`,
with a proper prefix sorting before its extensions.

**Why.** This is the total order that makes `append_ordered` deterministic without
requiring commutativity (`design/loom/02-EXECUTION-GRAPH.md` D5.3). If indices sorted
lexicographically, branch 10 would fall between 1 and 2, and a 25-way fan-out would
produce results in an order no author would predict — deterministic, but wrong.

**Test.** `ids.test.ts` "compareBranch is a total order with prefixes first" asserts
`e1[10]` sorts after `e1[1]`, and a second test sorts the same set from a reversed
input to prove arrival order is irrelevant.

---

## 2026-08-04 — M1b — Two StateStore implementations, one conformance suite

**Decision.** `MemoryStateStore` and `SqliteStateStore` are both first-class, and
`test/journal/conformance.ts` runs an identical 18-case suite against both.

**Why.** DoD item 7 claims "swapping local → distributed changes only
implementations, never call sites". That is an assertion until two implementations
pass the same tests. It also caught a real difference while writing: the memory store
originally let a concurrent append extend an in-flight `read`, while the SQLite store
pinned its upper bound — the suite forced both to the stricter semantics ("read
returns a consistent prefix").

**Rejects.** A SQLite-only store with the memory one as a test double. A test double
that is allowed to differ is exactly where migration bugs hide.

**Reverses if.** Never. When Postgres lands, it joins the same suite.

---

## 2026-08-04 — M1b — `BEGIN IMMEDIATE`, not `BEGIN`

**Decision.** The append transaction opens with `BEGIN IMMEDIATE`.

**Why.** SQLite's default deferred transaction takes a read lock first and upgrades to
a write lock at the first mutation. That upgrade can fail with `SQLITE_BUSY` *after*
we have already read the head and decided the CAS passed — so the check would be
against a head another writer has since moved. `BEGIN IMMEDIATE` takes the write lock
at statement one, making read-check-insert-update genuinely serializable.

**Rejects.** Deferred transactions plus a retry loop (retrying a CAS whose premise
may have changed is the bug, not the fix).

---

## 2026-08-04 — M1b — Fencing is scoped per (run, task), not per run

**Decision.** `task_fence(run_id, task_id) -> max_token`; an append carrying a lower
token than the highest already seen for that task is rejected `E_FENCING_STALE`.

**Why.** `expectedSeq` alone stops two workers double-committing the same position,
but not a worker whose lease expired, whose Task was re-leased and completed, and
which then wakes up and writes at a position that happens to be free. Fencing per task
is the right scope because leases are per task — a per-run token would make two
unrelated Tasks in the same run fight over one counter.

**Test.** `conformance.ts` "fencing is scoped per task" and "fencing allows the same
and higher tokens" (the same worker writing twice inside one lease must not
self-reject).

---

## 2026-08-04 — M1b — `EventPayloads` is an exhaustive map, not `payload: unknown`

**Decision.** Every one of the 42 event types has a declared payload shape.

**Why.** The journal is the system's whole durable vocabulary; if any subsystem can
append `{type: "task.committed", payload: <whatever>}`, folds become defensive and the
log stops being a contract. The exhaustive map means adding a durable fact is a
reviewable diff in one file.

**Cost.** Payload shapes will churn during M2 as the executor lands. That churn is the
point — it happens in one place and the compiler finds every fold that must change.
