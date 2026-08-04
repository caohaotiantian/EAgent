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
| M1c EventBus | **done** | slow subscriber cannot stall the producer | `test/bus.test.ts` — one slow + one fast subscriber, fast sees all 5 |
| M1d channels + reducers | **done** | fold order independent of arrival order | `test/state/channels.test.ts` — every reducer folded forward and reversed |
| M1e GraphCompiler | **done** | incident-triage compiles; every rule has a negative test | 195 tests; `test/graph/compile.test.ts` (49 cases) + `expr.test.ts` (30) |
| M2 walking skeleton | pending | all 12 rows of `08-PLAN.md` D13.3 | — |

Open threads that need resolving before the milestone they block:

- **T1 (blocks M1e):** YAML→JSON conversion lives outside core. Core is JSON-only.
  The CLI will need a YAML reader; decide dep-vs-subset-parser at M2.
- **T2 (blocks M2):** the `function` node resource loader needs a sandbox story for
  v1. Current plan: `function` resources are trusted, pinned, and loaded via dynamic
  `import()` of a digest-addressed file. Not untrusted-input safe — by design (A13).
- **T3 (blocks M2):** `node:sqlite` is still flagged experimental in Node 24; it
  prints a warning on first use. Need to decide whether to suppress it for CLI UX.
- **T4 (blocks M2):** **branch-scoped channels.** A fan-out edge's `as` channel holds
  one value *per branch*, but `reduceState` is currently global. The executor needs a
  per-branch state overlay: a Task at `root/e1[7]` sees `signal` = element 7, while
  `findings` is shared. Compile-side is done (GRAPH007 requires `as` to be declared);
  the runtime scoping is M2 work and is the main open modelling question left.

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

---

## 2026-08-04 — M1c/M1d — `src/vocab.ts`, forced by TS2308

**What happened.** `Classification` ended up declared in both `journal/events.ts` and
`state/channels.ts`, and the barrel's `export *` hit TS2308 (ambiguous re-export).
Worth recording because the *silent* version of this bug is worse: under plain ES
semantics an ambiguous star export is excluded rather than reported, so the type would
simply have vanished from the public surface with no error.

**Decision.** Cross-cutting value types live in `src/vocab.ts`, a leaf module with no
imports of its own: `Posture` + the lattice helpers, `IrreversibilityClass` and its
default-posture map, `Classification`, `UsageRecord`.

**Why here.** The journal must not import the policy engine and the channel model must
not import the journal, but all three speak these words. A leaf module is the only
place that does not create a cycle.

**Bonus.** `maxPosture` / `isLoosening` now exist as functions rather than as prose in
D7.6, so the asymmetry rule is enforceable by a call rather than by review.

---

## 2026-08-04 — M1c — The bus is allowed to lose data; the journal is not

**Decision.** `publish` never throws and never blocks. A subscriber that cannot keep
up has its own bounded queue trimmed (`drop_oldest` | `drop_newest` | `close`) and
counts its own `dropped`.

**Why.** The inversion that makes this safe is that the bus is *derived*. Anything a
subscriber misses is still in the journal, and `replayThenTail` gets it back
gap-free. If `publish` applied back-pressure, a stalled browser tab could wedge
production execution — which is the exact class of failure this system exists to
remove.

**Test.** "one slow subscriber cannot stall a fast one": queue sizes 1 and 100, five
events; the fast subscriber sees all five and the slow one reports `dropped === 4`.

---

## 2026-08-04 — M1c — `replayThenTail` subscribes BEFORE it reads

**Decision.** Subscribe to live events first, then read the journal, then emit journal
events followed by live ones with `seq <= lastReplayed` filtered out.

**Why.** The obvious order (read, then subscribe) drops everything appended during the
read. Subscribing first creates a deliberate overlap, and the dedupe by `seq` turns
that overlap into a guarantee rather than a duplicate-delivery bug. This is the exact
path a reconnecting UI takes with `Last-Event-ID`.

---

## 2026-08-04 — M1d — `max`/`min` seed from the first contribution, not an identity

**Decision.** `initialFor` returns `undefined` for `max`/`min`; the first contribution
in branch order seeds the accumulator.

**Why.** There is no safe identity element. Seeding `max` at 0 silently returns 0 for
an all-negative channel, and ±Infinity is deliberately not representable in the
canonical form (it would break digests). Seeding from the first element is total and
needs no sentinel.

---

## 2026-08-04 — M1d — `merge_object` errors on conflict by default

**Decision.** Two concurrent branches writing different values to the same key throws,
unless the channel declares `onConflict: "last_by_branch"`.

**Why.** A silent last-writer-wins here is the same class of bug as `replace` under
concurrency: deterministic (branch order is fixed) but arbitrary, and the author never
said which branch should win. Making them say it costs one line of YAML and removes a
whole category of "why did that field have the other value?" investigations.

---

## 2026-08-04 — M1e — Absence makes every ordering comparison FALSE

**The bug.** `verdict.score < 0.7` evaluated to **true** on an empty state, because
`undefined` coerced to `0`. A run would route on a fabricated number and take a branch
nobody authored. A test written to assert "routing on incomplete state does not crash"
caught it.

**Decision.** `toNumber` returns `undefined` for anything that is not a finite number;
arithmetic propagates absence; and every ordering comparison (`< <= > >=`) involving an
absent value is `false`, in both directions. `==`/`!=` still treat `null` and
`undefined` as equal, so `x == null` remains the presence test.

**Consequence.** The idiom for "present and low" is `has(v) && v.score < 0.7`, and `&&`
short-circuits so it is safe. An unwritten channel simply fails to satisfy a
conditional edge, and the router falls through to its declared `fallbackEdge` — a
decision an author actually made.

**Known cost.** The classic three-valued-logic trap: `!(x < 1)` is true when `x` is
absent. Full 3VL would fix it and would also mean every routing predicate could return
"unknown", which no author expects. Not worth it. Documented on `lt()`.

**Also.** Division by zero yields absence rather than `Infinity`, because `Infinity` is
not representable in the canonical form and would break digests.

---

## 2026-08-04 — M1e — `parallelWidth` is not `multiplicity`

**The bug.** The worked incident-triage example failed to compile with three false
GRAPH010 (concurrent write) errors: `verify` "runs up to 3 times in parallel and writes
verdict". It does not. It runs three times *sequentially*, because 3 is a loop bound.

**Decision.** Two derived quantities, not one:

| | meaning | consumers |
|---|---|---|
| `parallelWidth` | Π fan-out widths — instances that can run **at the same time** | GRAPH010 concurrency |
| `multiplicity` | `parallelWidth × Π loop iterations` — **total** instances over the run | GRAPH009 budget, GRAPH018 task count |

**Why both are needed.** Budget must count loop passes (three iterations cost three
times as much); concurrency must not (three sequential passes cannot race). Collapsing
them into one number is wrong for exactly one of the two consumers, whichever you pick.

---

## 2026-08-04 — M1e — Compensation targets are not entry nodes

**Decision.** `dagEdges` (topological order, ancestors) excludes `loop` **and**
`compensation`; `entryNodes` excludes only `loop`.

**Why.** Compensation is not forward flow — it runs in reverse on the error path — so
including it in the DAG makes almost every real graph look cyclic. But excluding it
from the *entry* calculation too would classify `rollback` as a start node, and the
scheduler would run the rollback at run start. Two different questions, two different
edge sets.

---

## 2026-08-04 — M1e — Edge conditions may reference `reads ∪ writes`

**Decision.** GRAPH004's declared-reference check uses the source node's `reads` union
`writes`, not `reads` alone.

**Why.** An edge condition is evaluated on **post-commit** state. `until: verdict.pass`
on the loop edge leaving `verify` — the node that just wrote `verdict` — is correct and
must not be rejected. Requiring `verdict` in `verify.reads` would be a lie about the
dataflow.

---

## 2026-08-04 — M1e — Structural errors gate the semantic rules

**Decision.** `checkStructure` (duplicate ids, dangling edges, missing/duplicated type
blocks, unknown apiVersion) returns early; the other 19 rules do not run.

**Why.** A node with no type block makes every later rule report derived nonsense — what
does a typeless node read, can it route, what is its irreversibility class? One accurate
error beats twelve consequential ones. Pinned by a test so the behaviour is a decision
rather than an accident.

---

## 2026-08-04 — M1e — The zero-dep guard uses the TypeScript parser

**The bug.** The regex-based guard failed the build on
`` `join "${n.id}" waits on unknown node "${branch}"` `` — it saw `from "${branch}"`
inside an error-message template literal and reported a bare import specifier.

**Decision.** Parse each file with `ts.createSourceFile` and read real
`ImportDeclaration` / `ExportDeclaration` / `ImportType` / dynamic-`import()`
specifiers.

**Why it matters beyond the false positive.** A guard that can produce false positives
gets disabled or worked around; and the same regex that mis-fires here would silently
miss a specifier written in a shape it does not match. The surface guard already asks
the compiler; this one now does too.
