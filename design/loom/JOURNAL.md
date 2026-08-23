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
| M8 intervention window | **done** | an interrupt mid-window means the effect never starts | 407 tests; `test/run/oversight.test.ts` (20 cases) |
| Scheduler seam (G3 partial) | **done** | one conformance suite over two schedulers; the executor takes one | 716 tests; `test/run/scheduler.test.ts` (23 cases) |
| P5 layout extraction | **done** | 500 nodes lay out in 0.95 ms; the console computes no positions | 693 tests; `test/server/layout.test.ts` (14 cases) |
| T1/T2/T3 open threads | **done** | YAML subset, digest-addressed function loader, sqlite guard | 676 tests; `test/graph/yaml.test.ts` (26) + `test/resources/functions.test.ts` (19) |
| P1 subgraph execution | **done** | every node type the compiler accepts now runs | 630 tests; `test/run/subgraph.test.ts` (12 cases) |
| Wave G escalation table | **done** | all ten E-rules wired; every rule tightens and names itself | 618 tests; `test/run/escalation.test.ts` (31 cases) + `test/docs-drift.test.ts` |
| Wave F retention tiering | **done** | a run rebuilt from cold storage alone still replays; a cold-retention cut leaves audit intact | 568 tests; `test/journal/retention.test.ts` (22 cases) |
| Wave E gate delivery | **done** | delivery failure never auto-approves; the escalation clock resets per tier | 546 tests; `test/run/delivery.test.ts` (20 cases) |
| Wave D incident-triage + scale | **done** | router/evaluator/error/compensation end to end; 500 nodes measured | 518 tests; `test/workflows/incident-triage.test.ts` (17) + `test/scale.test.ts` (8) |
| Wave C trajectories + scoring | **done** | fan-out order does not change a trajectory; S4 alone never reaches golden | 501 tests; `test/evolution/trajectory.test.ts` (30 cases) |
| Wave B graph mutation | **done** | a mid-flight restart rebuilds the mutated graph from the journal | 471 tests; `test/graph/mutate.test.ts` (21 cases) |
| Wave A context + lazy fan-out | **done** | ladder deterministic; a 5-way fan-out runs at maxParallelism 1 | 446 tests; `test/run/context.test.ts` (18 cases) |
| M10 authoring graph | **done** | a bad draft is corrected by the compiler's own diagnostics | 428 tests; `test/builtin/authoring.test.ts` (12 cases) |
| M9 AI-suite safety rules | **done** | a suite written after the candidate is refused | 413 tests |
| M7b single binary | **done** | `bin/loom` runs alone in an empty dir; 0 third-party modules | verified by copying the binary into an isolated directory |
| M5c console | **done** | G5 closed: an operator console ships in the binary | 386 tests; `test/server/console.test.ts` (11 cases) |
| M7a redaction + secrets | **done** | a secret cannot be interpolated; pii tokenises stably | 375 tests; `test/security/redact.test.ts` (19 cases) |
| M5b CLI | **done** | DoD item 6 demonstrated: empty dir → real graph → real file | 356 tests; `test/cli/cli.test.ts` (10 cases) |
| M5a control plane | **done** | HTTP surface with gap-free SSE reconnect | 346 tests; `test/server/http.test.ts` (17 cases, real sockets) |
| M6 resources + eval gate | **done** | pinning rule proven; promotion criteria enforced | 329 tests; `test/resources/store.test.ts` (17) + `test/evolution/gate.test.ts` (15) |
| M4c tool sandbox | **done** | a tool cannot read the engine's env, escape its jail, or outlive its timeout | 297 tests; `test/sandbox/subprocess.test.ts` (19 cases) |
| M4b model adapters | **done** | real Anthropic/OpenAI adapters, offline via injected fetch | 278 tests; `test/providers/providers.test.ts` (24 cases) |
| M4a retry/cancel/rewind | **done** | declared-but-ignored runtime features now implemented | 254 tests; `test/run/runtime.test.ts` (14 cases) |
| M3 replay + spans | **done** | replay reproduces state hashes with zero side effects; reconstruct(trace) ⊆ declared | 240 tests; `test/run/replay.test.ts` (22 cases) |
| M2 walking skeleton | **done** | all 12 rows of `08-PLAN.md` D13.3 | 218 tests; `test/run/skeleton.test.ts` — 23 cases; row 6 is a CLEAN close, and the real kill -9 test arrived later as `test/run/restart-crash.test.ts` |

**Every open thread is closed and every non-deferred DoD item is PROVEN.** What remains is
three things, each blocked by a stated constraint rather than by effort:

1. **Browser paint at 500 nodes.** Layout is now measured at 0.95 ms and the console
   provably computes no positions; the paint itself needs a headless browser the zero-dep
   rule keeps out of this package.
2. **Partition assignment (G3).** Selection is now a seam with two implementations passing
   one conformance suite. Deciding *which runs a worker considers* needs a coordinator,
   and half a coordinator is worse than none.
3. **seccomp/cgroups.** Platform-specific, deliberately `DEFERRED-v2`; subprocess
   confinement is built and tested.

Open threads that needed resolving before the milestone they blocked — all now closed:

- **T1 (CLOSED 2026-08-05):** `graph/yaml.ts` is a restricted subset parser, zero-dep.
  Core is still JSON-only — YAML converts at the CLI boundary and never reaches a digest.
- **T2 (CLOSED 2026-08-05):** `resources/functions.ts` loads bodies from
  digest-addressed resources, compiled and cached per digest. Hand-registered bodies
  still win, so embedding and testing are unchanged.
- **T3 (CLOSED 2026-08-05):** Node 24.16 no longer emits an ExperimentalWarning for
  `node:sqlite`, so there is nothing to suppress. A guard in `test/journal/store.test.ts`
  fails if one returns, so the decision is revisited deliberately rather than by someone
  silencing process warnings wholesale.
- **T4: RESOLVED (M2).** Branch-scoped channels are bindings keyed by branch path,
  resolved by walking a Task's path prefixes (deepest wins), so nested fan-outs shadow
  their parent's item channel without anything copying state.
- **T5: RESOLVED (Wave A).** `fanout.planned` records the width before any branch is
  created; the join reads the plan, and branches materialise in waves of
  `maxParallelism`. `#finish` refuses to complete a run with unmaterialised branches.
- **T6: RESOLVED (M4a).** `Engine.rewind` appends a `checkpoint.restored` marker and
  the fold suppresses `(atSeq, marker)`. History is never edited.
- **T7: RESOLVED (M4a).** Retries schedule with deterministic backoff; a
  non-idempotent tool that reached its sandbox is never auto-retried.
- **T8 (blocks M4b):** `fork` mode on rewind is unimplemented — only `rewind`. Fork
  needs a new runId plus a re-execution policy for effects, which is genuinely
  different from replay (it re-executes for real).
- **T9: RESOLVED (M5a).** `ControlPlane` serves the run lifecycle, gates, commands,
  and a gap-free SSE stream over `node:http` — no framework, so zero-dep holds.
- **T10: RESOLVED (M5b).** `loom run` from an empty directory creates the journal,
  registers built-in tools, runs a real graph, and writes a real file — verified
  against the COMPILED `dist/cli.js`, not just the source. SEA packaging itself
  (`build:binary`) remains a build-tooling task.
- **T11: RESOLVED (M5c).** A zero-dependency console ships inside the binary: graph
  canvas from compiler layout ranks, collapsed fan-out, SSE deltas coalesced at 60 ms,
  and an approve/reject queue. A React SPA can come later against the same API.
- **T12: RESOLVED (M7b).** `npm run build:binary` → `bin/loom`, 120 MB, application
  bundle 219 KB, **0 third-party modules**. The build fails if any appear.

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

---

## 2026-08-04 — M2 — A Task inside a fan-out holds its writes until the join

**Decision.** `task.committed.writes` is a *proposal*; `state.reduced` is the only
event that changes channel state. A Task at the root branch reduces immediately; a
Task inside a fan-out holds, and the join folds every sibling in branch-coordinate
order.

**Why.** Applying writes on arrival makes the result depend on which branch finished
first — the exact nondeterminism the branch-coordinate fold exists to remove. Pinned
by acceptance row 4, which deliberately makes branch 0 take an extra tool round-trip
so it commits *last*, then asserts `digests` is still in document order.

**Consequence.** A fan-out without a join has no defined fold point, so GRAPH021 now
requires one. "When do these merge?" is a question the author answers, not one the
scheduler answers by accident.

---

## 2026-08-04 — M2 — Work is parallel; commits are serialized

**Decision.** Node bodies run under `Promise.all`; every journal append goes through a
single promise chain with an explicit `expectedSeq`.

**Why.** The CAS is what makes at-least-once execution produce exactly-once state, but
in one process there is no reason to *lose* work to a conflict — serializing the
commits means the parallelism is where it pays (model and tool calls) and the log has
exactly one writer. When the executor becomes multi-process the chain disappears and
the CAS does the same job across processes, unchanged.

**Also.** `RunLog.append` retries on conflict (the events are unconditional facts);
`RunLog.commit` never does (its validity depended on the head not moving). Two methods
because conflating them would silently retry a stale decision.

---

## 2026-08-04 — M2 — Three bugs the acceptance suite caught

**1. A join is notified by TERMINATION, not by edge selection.** A failed branch takes
no outgoing edge, so the join never heard about it — a fan-out whose last branch failed
hung forever waiting for an arrival that could never come. `#activate` now walks the
node's `join` edges regardless of `take`.

**2. `onBranchError: skip` was a lie.** One failed branch failed the whole run, because
`#finish` fails on any failed Task with no error edge. A Task whose failure is absorbed
by a downstream join is now exempt.

**3. Budget exhaustion is a RUN-level condition.** With (2) fixed, a budget breach in
five branches was silently absorbed by the join and the run carried on to the gate —
i.e. the ladder in D6.5 was defeated by the fix for (1). `budget.exhausted` is now
journaled and checked before `advance` picks another wave, so it survives a restart and
no join can swallow it.

The three form a chain: fixing one exposed the next. Worth recording because it is the
argument for the acceptance suite existing at all — none of the three is visible from
reading the code.

---

## 2026-08-04 — M2 — The mock model's turn counter is per-conversation

**The bug.** `MockModelAdapter` counted turns on the adapter. With five fan-out branches
calling one adapter, the counter interleaved arbitrarily and each branch saw a turn
number unrelated to its own progress — three branches ended up scripted as the same
document.

**Decision.** `turn` is derived from the request: the number of assistant messages
already in the conversation.

**Why it matters beyond the test.** A mock that cannot script *concurrent* agents
deterministically is useless to a graph runtime, which is the one thing this system
does that EAgent did not. The offline-deterministic-mock property is load-bearing for
every replay and acceptance test, so it has to hold under fan-out.

---

## 2026-08-04 — M2 — v1 convention: where a node's output goes

**Decision.** Any declared write channel whose reducer is `sum` receives the Task's
cost; the node's own output value goes to the first remaining declared write channel.

**Why.** `writes: [findings, costUsd]` is the common shape, and the alternative —
making every agent emit a keyed object naming its own channels — pushes plumbing into
every prompt. Explicit and dull beats clever here.

**Reverses if.** A node needs to write two non-cost channels. Then the agent's
`outputSchema` should name them and the executor should key on it; the current rule
becomes the one-channel special case.

---

## 2026-08-04 — M3 — Spans are DERIVED from the journal, not emitted alongside it

**Decision.** `spansFrom(events)` is a pure fold. There is no tracer hook in the
executor, no `TraceEmitter` the engine calls, and no span state held during a run.

**Why.** The usual design emits telemetry alongside execution, creating a second
source of truth that can disagree with the first — and the disagreement always
surfaces during an incident, when it is least affordable. Deriving spans means:

- sampling can never lose something the journal has (it only drops *export*);
- a run recorded before the tracer existed still produces a full trace;
- `reconstruct(trace) ⊆ declared(graph)` becomes a real assertion about *execution*
  rather than about the tracer's bookkeeping.

**Cost.** Attribute ordering now matters. `effect.completed` closes an effect span, so
`model.called` / `tool.called` must be appended BEFORE it or their attributes are
silently dropped — which is exactly how the gen_ai-attributes test failed first. Noted
on the emit sites.

---

## 2026-08-04 — M3 — Replay serves effects; it never falls back to a live call

**Decision.** In replay mode `#invokeTool` and the agent's model loop are served from
`ReplayEffects`. A tool's `execute` is never reached and `adapter.stream` is never
called. A missing key is `E_REPLAY_DIVERGENCE`.

**Why.** Falling back to a live call would make replaying a run that charged a card
charge it again. Refusing loudly is the only safe default, and it also makes replay a
*verification* tool: a divergence means the graph, the recording, or a reducer changed.

**Tested by** three assertions that are easy to get wrong and easy to check:
`h.writes.length` is unchanged, `h.model.seen.length` is unchanged, and `h.reads` is
unchanged across a full replay.

**Honest limits** (D9.5, unchanged): secrets are re-resolved, redacted fields serve a
token, forks re-execute for real, and an effect that started without recording an
outcome makes the report `hermetic: false` rather than guessing.

---

## 2026-08-04 — M3 — `RUN_FATAL_CODES`: what a join may never absorb

**The bug.** M2 taught joins to absorb branch failures (`onBranchError: skip`). A
replay divergence in one branch was then absorbed too, and the run sailed on to the
gate — an invalid replay reporting a plausible result.

**Decision.** `RUN_FATAL_CODES = {E_BUDGET_EXHAUSTED, E_REPLAY_DIVERGENCE}`. A Task
failing with one of these is never absorbed and stops `advance` immediately.

**Why record it.** This is the second time the same fix caused the same class of bug
(the first was budget, during M2). "Contain branch failures" and "some failures are
not about the branch" pull in opposite directions, and the set makes the tension
explicit and greppable instead of rediscovering it a third time.

---

## 2026-08-04 — M4a — A rewind APPENDS, it never edits

**Decision.** `Engine.rewind(runId, atSeq, reason)` appends a `checkpoint.restored`
marker; `foldRun` pre-scans for those markers and suppresses events in
`(atSeq, markerSeq)`.

**Why.** Deleting or rewriting journal entries would destroy the one property every
other guarantee rests on. Suppression keeps the log append-only, makes the undo itself
auditable, and means a trace still shows what was undone — which is exactly what an
incident review needs.

**Refusal.** `rewind` throws `E_RESTORE_ILLEGAL` when a committed `irreversible` or
`externally_visible` action with no declared compensation lies after the target. A
store that offers a silently-unsafe undo is worse than one that offers none.

---

## 2026-08-04 — M4a — Retry backoff has NO jitter

**Decision.** `afterMs` is a pure function of `(policy, attempt)`. The `jitter` flag in
`GraphSpec.retry` is accepted and currently ignored by the in-process executor.

**Why.** The delay is recorded in `task.retry_scheduled`, so a jittered value would be
a recorded decision replay could not reproduce. Jitter belongs in the distributed
scheduler, where the delay is a transport concern rather than part of the run's
history. Pinned by a test that runs the same graph twice and asserts identical delays.

**Reverses if.** Retry storms become a real problem before the distributed path lands.
Then jitter becomes an *effect* (`ctx.random()`), recorded like any other.

---

## 2026-08-04 — M4a — `startedEffects` vs `unknownEffects`

**The bug.** The non-idempotent retry refusal checked `unknownEffects` and never fired,
because by the time the decision is made the effect has already recorded a failure —
so it is no longer *unknown*.

**Decision.** The projection now tracks both: `startedEffects` (every key that ever
reached the world, whatever the outcome) and `unknownEffects` (started, no terminal
record).

**Why they are different questions.** "Did this reach the world?" governs whether a
retry is safe. "Do we know what the world did?" governs whether a cancel can be called
clean. Conflating them makes one of the two silently wrong — and the failure mode is
the dangerous direction: retrying a charge that already went through.

**Precise consequence.** A failure *before* the sandbox (schema validation, policy
deny) touched nothing, so it retries even for a non-idempotent tool. A failure after is
never auto-retried.

---

## 2026-08-04 — M4b — The normalized taxonomy is the product; the transport is not

**Decision.** `normalizeError(status, body, headers)` maps every provider failure onto
the one `LoomError` taxonomy, and both adapters go through it.

**Why it is the valuable part.** A fallback chain is only *declarative*
(`when: [E_PROVIDER_RATE_LIMIT]`) because the codes are provider-independent. Without
it, every chain would need provider-specific branching and the config in D3.8 would be
a lie.

**The mappings that carry weight:**

| Native | Normalized | Class | Consequence |
|---|---|---|---|
| 400 "context length" | `E_CONTEXT_OVERFLOW` | validation | **not** retryable — the same prompt cannot fit next time |
| 400 "content policy" | `E_CONTENT_FILTERED` | policy | **never** falls through (see below) |
| 429 | `E_PROVIDER_RATE_LIMIT` | exhausted | retry, honouring `retry-after` |
| 529/503 | `E_PROVIDER_OVERLOADED` | unavailable | retry with backoff |

---

## 2026-08-04 — M4b — A content filter never falls through, and the chain fails to BUILD

**Decision.** `NEVER_FALL_THROUGH = {E_CONTENT_FILTERED, E_PROVIDER_BAD_REQUEST,
E_CANCELLED}`. A chain that *names* one of these in a `when` clause throws at
construction.

**Why construction rather than call time.** Trying a second vendor after a safety
refusal is evasion, not resilience. Catching it when the chain is built means the
misconfiguration fails in CI; catching it at call time means it fails once, in
production, on the request that triggered the filter.

---

## 2026-08-04 — M4b — Post-first-event failures never fall through either

**Decision.** Both the retry loop in `postJson` and the tier loop in `FallbackAdapter`
stop once the first event has been yielded.

**Why.** After the first delta the caller has already rendered text and counted usage.
Re-streaming from another tier would duplicate both. This is the same rule EAgent
arrived at for `onProviderError` (`agent.ts:427-441`) and it is worth restating: a
partly-consumed stream is not retryable, whatever the error says.

**Tested** by an adapter that yields one delta and then throws: the fallback tier is
never reached and exactly one event is observed.

---

## 2026-08-04 — M4b — Two kinds of record/replay, deliberately

`ReplayEffects` (M3) replays a **run** from its journal. A `Cassette` captures a
**provider** so an adapter's own parsing can be tested against real bytes offline.

They answer different questions — "did the run behave the same?" versus "did we parse
this provider correctly?" — and conflating them would mean an adapter change could
only be tested by re-running whole graphs.

**Test-harness note.** The first fallback tests failed because the fake errors were
`Object.assign(new Error(), {...})` lookalikes, not `LoomError` instances, so
`isLoomError` wrapped them and the `when` match never fired. Fixed by using the real
`err.*` constructors — a good reminder that a hand-shaped error is not the same type,
and that testing through the real constructor is the only version that proves anything.

---

## 2026-08-04 — M4c — Confinement is a different question from authorization

**Decision.** `runSandboxed` exists alongside the capability layer, not instead of it.
Capabilities answer "is this tool ALLOWED to act?"; the sandbox answers "and if it
misbehaves, what can it reach?".

**Why both.** An *allowed* tool with a bug can still read the journal file, exhaust
memory, or run for an hour. Neither layer subsumes the other, and a design that ships
only one always ships the first — because the first is the one that shows up in a
threat model discussion.

**v1 controls:** argv array (never a shell string), cwd jail with escape detection,
env allowlist, SIGTERM → grace → SIGKILL on the process GROUP, output byte cap.
`DEFERRED-v2`: seccomp/Landlock, cgroup memory limits, the egress proxy.

---

## 2026-08-04 — M4c — The jail check uses `path.relative`, not `startsWith`

**Why it matters.** `"/jail-evil".startsWith("/jail")` is `true`. A prefix check also
does not resolve `..` at all, so `a/../../etc/passwd` passes it. `path.relative`
handles both, and the sibling-directory escape has its own test so the reasoning
survives a future "simplification".

---

## 2026-08-04 — M4c — There is deliberately no string form for `args`

**Decision.** `SandboxOptions.args` is `readonly string[]` with no string alternative,
and `spawn` is called with `shell: false`.

**Why not offer both.** A single concatenated command line is how argument injection
happens. Offering the convenience means someone eventually takes it — usually the
person wiring up a quick integration under deadline. The test passes `"; rm -rf ."` as
an argv element and asserts a canary file survives.

---

## 2026-08-04 — M4c — Kill the process GROUP, not the process

**Decision.** The child is spawned `detached` on POSIX and signalled via `-pid`.

**Why.** A tool that spawns its own children (a shell script, a build) would otherwise
leave orphans running after a timeout — holding files, ports, and memory the engine
believes it reclaimed. Pinned by a test that ignores SIGTERM and still dies.

---

## 2026-08-04 — M6 — A resource digest covers IDENTITY, not just content

**The bug.** `function/passthrough` and `function/merge-digests`, both with content
`{}`, produced the SAME digest under pure content-addressing. The second `publish`
silently returned the first resource's version — and its channel — so promoting the
second threw `cannot promote stable → canary` on a resource that had never been
promoted.

**Decision.** `digest({kind, name, content})`.

**Why this is the right shape.** "Identical content ⇒ same version" is the property
that matters *within* a resource: it makes republishing idempotent without a key and
makes "did anything change?" a digest comparison. Across resources it is not merely
useless but wrong, because a Resource's identity is `kind/name`, not its bytes. The
cost is that two identical prompts under different names no longer share a cache
entry, which is a trade nobody will notice.

---

## 2026-08-04 — M6 — The pinning rule is now proven, not asserted

**The test.** Compile the skeleton against `@stable`; start a run; let it suspend on
its gate; then publish a NEW version and promote it to `stable`; then assert:

1. the run's manifest still names the ORIGINAL digest;
2. `fetch(originalDigest)` still returns the original content;
3. the run completes on the pinned version;
4. a NEW compile picks up the new version.

**Why it is worth a dedicated test.** Every claim about safe rollback, cache
correctness, and "a resource change cannot break production mid-flight" reduces to
this one property, and it is the kind of property that quietly stops holding when
someone adds a convenience `fetch(ref)` overload. `fetch` refusing a floating ref with
an `internal`-class error is the guard that keeps it true.

---

## 2026-08-04 — M6 — The eval gate ships in v1; synthesis does not

**Decision.** `runEvalSuite` + `gateCandidate` are in v1. Trajectory synthesis and
canary rollout remain `DEFERRED-v2`.

**Why this split and not the other one.** The gate is immediately useful for *human*
prompt and graph changes — it is a regression suite that costs no model calls, because
it is replay all the way down. The generator is useless until a corpus exists, and
shipping it early guarantees the loop's first candidates are fitted to noise.

**The rule that makes the gate meaningful:** the suite is authored by humans, never by
the evolution engine. An optimiser that writes its own exam will pass it. `validateSuite`
enforces the shape a suite needs to certify anything — including a minimum number of
FAILURE cases, because a suite of only happy paths certifies only that the happy path
still works.

---

## 2026-08-04 — M5a — The 202 body says what is durable

**Decision.** `POST /runs` responds `202` with
`{runId, graphHash, durable: ["run.submitted","run.compiled"], note: "accepted means
this WILL run, not that it HAS run"}`.

**Why put it in the payload.** Every client eventually treats a 2xx as "it happened".
Naming the durable set in the response makes the contract impossible to misread
without ignoring it on purpose, and it gives a test something to assert. The companion
test then checks the journal really does contain those events the moment the client is
told 202.

---

## 2026-08-04 — M5a — Out-of-window reconnect gets a SNAPSHOT, never a silent gap

**Decision.** `Last-Event-ID` within `hotWindow` replays from `seq+1`. Outside it, the
client receives one `snapshot` frame and then the live tail.

**Why the distinction is explicit.** A client that silently misses events renders a
wrong graph and has no way to know. Sending a differently-named frame means the client
can tell "this is a continuation" from "this is a fresh baseline" without inferring it
from sequence arithmetic. Tested both ways, including that resumed ids are contiguous
from `lastEventId + 1`.

---

## 2026-08-04 — M5a — 401 before routing

**Decision.** Authorization runs before route matching, so an unauthenticated caller
gets `401` even for a path that does not exist.

**Why.** Returning `404` for unknown routes and `401` for known ones tells an
unauthenticated caller which routes exist. The token comparison is `timingSafeEqual`
over a padded buffer for the same reason — a length-sensitive or early-exit compare
leaks the token one byte at a time.

---

## 2026-08-04 — M5b — A tool's channel write is its `content`, never its `details`

**The bug.** `#runToolNode` wrote `result.details ?? result.content` into the target
channel. So `fs.read` — whose `details` is `{path, bytes, truncated}` — put an OBJECT
into a `string` channel, and the downstream `fs.write` failed schema validation with
"value.body must be a string".

**Why it matters beyond the type error.** `details` is documented as "structured
payload for renderers and telemetry; NEVER sent to the model". Letting it land in a
channel makes it reachable by the next node's prompt, which is precisely the
distinction the field exists to draw. The fix restores the invariant: a tool writes
`result.writes` when it declares one, otherwise its model-legible `content`.

**How it was found.** Not by a unit test — by running the CLI end to end from an empty
directory against the built-in tools. Worth noting: this is the class of bug the
walking skeleton could not catch, because its test tools happened to return the shape
the engine assumed.

---

## 2026-08-04 — M5b — Graphs are JSON, and `loom fmt` will live elsewhere

**Decision (closing T1).** The CLI reads GraphSpec JSON. `@loom/core` never parses
YAML.

**Why.** Zero-dep is the constraint that keeps the single binary possible, and hashing
needs one unambiguous representation — canonical JSON has exactly one form of a
document; YAML has several. A YAML→JSON converter is genuinely useful for authoring
and belongs in a CLI-only package that may take the dependency, where a mis-parse
cannot change a `graph.hash`.

---

## 2026-08-04 — M7a — Redaction applies on the way OUT, never to the journal

**The trap.** The obvious reading of "redact at emit time" is to redact journal
payloads. That would destroy the system: `state.reduced` payloads **are** the channel
state, so a redacted journal folds to corrupted state.

**Decision.** The journal keeps real values. Redaction is applied at the two places
data crosses the process boundary — span attributes and the HTTP wire. Erasure
obligations against the journal are met by classification-driven crypto-shredding
(R13), which destroys a key rather than rewriting history.

**Why this is the right split.** The journal is the source of truth; a source of truth
you have edited for display is no longer one. Redaction is a *presentation* concern
with a security purpose, and it belongs where presentation happens.

---

## 2026-08-04 — M7a — `SecretValue` makes the failure mode loud instead of silent

**Decision.** Secrets are objects whose `toString`, `toJSON`, template interpolation,
and `util.inspect` all yield `[secret]`. `reveal()` is the only way out, named so it
is greppable in review.

**Why.** An accidental `` `Bearer ${token}` `` now produces `Bearer [secret]` — a
broken request someone notices in minutes — instead of a credential sitting in a
journal payload, which nobody notices. The whole point is to convert a silent,
permanent failure into a loud, immediate one.

**Ordering of mechanisms, stated deliberately.** Declared classification first;
detector sweep second, as a backstop that *will* have false negatives. A design that
leads with detection has already accepted leaks. The detector list is short on
purpose: false positives train people to ignore redaction, so only shapes that are
essentially never legitimate content are matched, and a test asserts ordinary prose
passes through untouched.

---

## 2026-08-04 — M5c — The console ships in the binary, in vanilla JS

**Decision.** One self-contained HTML document served at `/` — inline SVG, no React,
no bundler, no build step. Rejected: a React + Vite SPA in `packages/ui`.

**Why.** The oversight model's whole premise is that a human can reach the approval
queue. An approval queue that requires `npm install && npm run build` before anyone
can see it is an oversight model that does not exist for the first week. Shipping it
inside the same zero-dep binary means `loom serve` gives a working console with
nothing installed.

**What it costs.** No component model, no type-checking inside the template string,
and the page will not grow gracefully past a few thousand lines. That is the right
trade for v1 and the wrong one for v3; the API it consumes is the durable part.

**The four rendering decisions from D9 §L1 are implemented, not just designed:**

| Decision | Implementation | Test |
|---|---|---|
| Structure once, deltas forever | `/graphs/by-hash/:hash`, cached client-side by hash | "structure is addressed by hash, so a client can cache it forever" |
| Layout from the compiler | `plans[].layoutRank` shipped in the structure payload | "the structure endpoint carries the COMPILER's layout" |
| Fan-out collapses | N instances → one shape + count badge | "the page collapses fan-out into one shape with a count" |
| Deltas coalesce | 60 ms `invalidate()` window | "the page coalesces deltas rather than repainting per event" |

**Testing a UI without a browser.** These tests assert the things a browser cannot
recover from if they are wrong — that the page is served and self-contained, that the
structure endpoint carries layout, that ids are escaped before injection, and that the
cache key is the graph hash. Visual correctness is not asserted, and the tests do not
pretend to.

---

## 2026-08-04 — M7b — The build FAILS if any third-party module reaches the bundle

**Decision.** `build-binary.mjs` runs esbuild twice: once to produce the bundle, once
with `metafile: true` to inspect its inputs. Any input path containing `node_modules`
aborts the build.

**Why not just trust the guard.** `check-zero-dep.mjs` reads declared dependencies and
import specifiers in `src/`. That catches the ordinary case. It would NOT catch a
transitive import introduced through a path it does not scan, or a build-time shim
quietly bundled in. Checking the metafile verifies the property where it finally
matters — in the artifact that ships — rather than in the source that produces it.

**Result.** 120 MB binary, of which the application is 219 KB. The rest is the Node
runtime, which is the honest cost of "no installation required".

**Note on macOS.** A signed binary rejects injected sections, so the script strips the
signature, injects, and re-signs ad-hoc. Without that the produced file is killed by
the kernel on launch with no useful error — worth recording because the failure looks
like a build bug rather than a signing one.

---

## 2026-08-04 — M8 — Implementing the hold proved the hold was dead code

**What happened.** I implemented the pre-irreversible hold from D4 deviation 5, then
could not write a test that made it fire. Posture folds by `max`, so an `irreversible`
action always computes to `in` — which means "let this run on-the-loop for the next
hour" was not *expressible*, and the window could never occur.

`deescalate` as written only removed entries from `#escalations`, which are additive
terms in the same `max`. It could not lower a class floor. So the one operation the
asymmetry rule exists to constrain did nothing at all for the cases that matter.

**Decision.** De-escalation is a **ceiling**: a clamp applied AFTER the `max` fold,
stored separately from escalations because they compose differently. It is the only
thing in the system that can lower a posture — human-only, justification required,
journaled.

**The hard floor.** A ceiling may take an `irreversible` or `externally_visible` action
to `on`, **never to `out`**. At `out` nobody is watching and the action cannot be taken
back; `on` at least keeps someone there with a window to stop it. Clamped in
`effectivePosture`, not left to review.

**Why this is worth recording.** The design described three postures and an
intervention window without noticing that the lattice made one of them unreachable for
the class of action the window exists to protect. Writing the test is what found it.

---

## 2026-08-04 — M8 — `reversible_write` holds for 0 ms, not 2000

**Deviation from D7.10, deliberate.** A hold on an action Loom can undo is pure latency
for no recoverable benefit. Worse, a hold that fires on every file write is one
operators learn to dismiss — which costs exactly the interruptions the mechanism exists
to enable. The window is reserved for actions where stopping in time is the only remedy.

---

## 2026-08-04 — M9 — "Human-authored suites" replaced by two mechanical checks

**Context.** The original D10 rule was that eval suites must be human-authored, because
an optimiser that writes its own exam passes it. That is the safe default and it does
not scale.

**Decision.** AI-authored suites are permitted under two checks that are verifiable
rather than aspirational:

1. **`suite.frozenAt < candidate.proposedAt`.** It does not matter who wrote the exam
   if it existed before the student did. This converts an unfalsifiable question into a
   timestamp comparison, and it has a useful side effect: it forces suites to be built
   continuously from production traffic, because a suite assembled the moment you need
   it is a suite assembled to be passed.
2. **Separate lineage.** The suite's generator and the candidate's proposer must
   differ. A shared model and prompt lineage converges the exam on what the candidate
   already does.

**What did NOT change.** Assertions still anchor to deterministic verifiers, never to a
judge's opinion; and must-pass cases are still derived from recorded failures rather
than invented. AI decides *which* runs matter and *what to assert*; the assertion is
code either way.

**Absent metadata is not a silent pass.** With no `proposedAt`/`proposedBy` the checks
report a pass with a readable reason — that is the human-driven path, and it should
look different from a verified one.

---

## 2026-08-05 — M10 — The authoring agent is itself a Loom graph

**Decision (answers Q7).** `graph-from-goal` is a built-in GraphSpec:
`propose` (agent) → `validate` (evaluator running the REAL compiler) → loop back on
diagnostics, bounded at 3 → `accept` (human gate).

**Why a graph rather than a special mode.** Three properties fall out for free:
the compiler's 21 rules become the critic (and every diagnostic already carries an
actionable `fix`, written for exactly this); the loop is bounded by `GRAPH006` so a
model that cannot converge fails rather than spins; and the authoring path dogfoods an
agent node, an evaluator, a bounded loop, and a gate — so if authoring works, the
runtime works.

**The critic is deliberately not a rubric judge.** A model asked "is this graph good?"
says yes. The compiler says `GRAPH009_BUDGET_OVERCOMMIT: worst-case declared spend is
$22.50 but the graph budget is $12.00`, which is both true and actionable.

**What the model cannot propose**, tested: a graph that weakens oversight
(`GRAPH014`), an unbounded fan-out (`GRAPH007`), or a fan-out with no join
(`GRAPH021`). Those are compile errors, not preferences it can argue with.

---

## 2026-08-05 — M10 — Two real bugs, both found by running the authoring loop

**1. A bare `{type:"object"}` schema stripped every key.** The object validator
dropped undeclared keys, which is right when a shape IS declared and catastrophic when
one is not — `{type:"object"}` silently meant "the empty object". Now: no `properties`
at all means "it is an object and nothing more", and every key passes through; only a
declared shape makes a key stray.

**2. The loop iteration did not propagate, so the graph looped forever.** `#activate`
set `iteration = 0` on every non-loop edge. So pass 2's `propose@root#1` took its `seq`
edge to `validate@root#0` — pass 1's Task, already succeeded — which the fold marked
ready again. Infinite. The counter now propagates through the loop body and increments
only on the back-edge, which is what "everything inside the loop shares an iteration"
actually means.

Neither was reachable from the walking skeleton, which has no loop and no permissive
output schema. Worth recording as evidence for building the *second* real workflow
early: the first one only exercises the paths you designed it to exercise.

---

## 2026-08-05 — Wave A — Lazy fan-out needs a PLANNED width, not a sibling count

**Decision.** A `fanout.planned` event records the width before any branch Task exists.
The join reads it; branches are created in waves of `maxParallelism` and topped up as
each one commits.

**Why the sibling count had to go.** With lazy materialisation, "how many siblings
exist" is a count of what has STARTED, not of what will. Using it fires the barrier as
soon as wave 1 finishes and silently drops every branch not yet created — a partial
result reported as a whole one. Pinned by a test that runs a 5-way fan-out at
`maxParallelism: 1` and asserts all five fold.

**Two bugs found writing it:**

1. **The committing Task counted itself as in-flight.** `p` predates its own commit, so
   it still reads `leased`; at `maxParallelism: 1` that left zero room forever and the
   fan-out stalled after one branch.
2. **`#finish` completed the stalled run anyway**, reporting success with one of five
   branches done. There is now a guard: a run with unmaterialised branches fails
   loudly. A safety net like this is worth having precisely because the first bug
   produced a *plausible* wrong answer rather than a crash.

---

## 2026-08-05 — Wave A — Rung 4 must not truncate the system prompt

**The bug.** Hard truncation cut sections by priority — including, eventually, the
system prompt. A system prompt cut to two tokens "fits" and is useless.

**Decision.** `system` and `instruction` are inviolable. If those alone exceed the
budget, `E_CONTEXT_OVERFLOW` fires — the author has a modelling problem and should be
told, not handed a mutilated prompt.

**Also:** the truncation MARKER costs tokens. Cutting to `room` and then appending
`[...truncated N tokens...]` overshoots the budget by exactly the marker's length,
which is how this first failed.

---

## 2026-08-05 — Wave A — Projections are declarative, not a path language

**DEVIATION from D5.3's `select: "$[*].{title: title}"`.** Projections are
`{fields?, take?}` — keep these keys, take the first or last N. A path language needs
its own parser, error taxonomy, and determinism argument, for a feature whose real use
is "these three fields of the last twenty items".

**Rung 3 stays deterministic** because the summarizer is injected and, in the executor,
wrapped as a recorded effect. Without that boundary a replay would produce a different
summary and every downstream state hash would diverge for a reason unrelated to the
graph.

---

## 2026-08-05 — Wave B — Mutation is compiled, not trusted

**Decision.** `compileMutation(base, mutation, budget)` runs five stages: additive-only,
dominated-by-the-proposer, expansion budget, then **the identical `compile()`** every
authored graph goes through, then the gate check. The baseline postures handed to that
compile are the RUNNING graph's own, so a mutation that lowers oversight anywhere fails
`GRAPH014_OVERSIGHT_LOOSENED` — the same rule, not a weaker runtime variant.

**Why additive-only.** Removal introduces "what happened to the branch already running
through the deleted edge?", which has no cheap answer, and it would let a mutation
retroactively change what events already in the journal mean.

**`canMutate` is declared on the NODE.** Inferring it from the model's output would let
a model grant itself the power by emitting the right shape. The capability
`graph:mutate` is checked on top of that, at dispatch.

**Gating is per node, not per run.** `gatedNodes` names exactly which added nodes are
hard to undo; those escalate to `in`. Escalating the whole run would be a lie — the rest
of the graph was already reviewed and did not become riskier.

---

## 2026-08-05 — Wave B — A mutated graph must be rebuildable from the journal

**The gap.** `ctx.graph` was swapped in memory. A restarting process re-attaches the
AUTHORED graph — the only thing on disk — so every derived value (plans, entry nodes,
`maxInstances`) would have been computed from the wrong spec, and a node that exists
only in the successor graph would never be scheduled.

**Decision.** `graph.mutated` carries the FULL added specs, not just their ids, and
`advance()` rebuilds the successor by replaying them through the same compiler. A hash
mismatch after replay is `E_REPLAY_DIVERGENCE`, not something to paper over.

This is the journal-is-the-sole-durable-truth invariant applied to the graph itself: if
an event cannot rebuild the thing it describes, it is a log line, not a journal entry.

---

## 2026-08-05 — Wave B — APPROVE MEANS "GO AHEAD", NOT "CONSIDER IT DONE"

**The bug, found by the restart test.** A gate decided for a Task short-circuited into
`#applyGateDecision`, which on `approve` returned `succeeded` with no execution. Correct
for a `human_gate` node — that node IS the approval — and wrong for every other node
type, where there is real work behind the gate.

The failure mode is the worst available: the run reports **success**, the human sees
their approval recorded, and the action never happens. Silently, in the one place
someone was explicitly asked to look. It was invisible until a run suspended at a
policy gate on a *tool* node and resumed; every prior gate test used a `human_gate`
node, where the old behaviour is right.

**Decision.** Approval on a work node falls through to `#dispatch`. `reject`, `edit`,
and `redirect` all resolve WITHOUT executing — each is the human substituting their own
outcome. `edit` in particular carries channel writes, not tool arguments, so running the
tool as well would both charge the card and overwrite the receipt that proves it.

**Meta.** Second time a Wave test has found a defect in code the previous wave shipped
green. Both times the mechanism was the same: a new *shape* of run (a restart, a loop)
reaching code that the original workflow's shape never reached.

---

## 2026-08-05 — Wave C — Normalization is what makes "similar trajectory" mean anything

**Decision.** Four normalization rules, all in the fold: retries collapse to the
succeeding attempt (count becomes an attribute), fan-out branches are re-indexed by the
digest of **what they did**, payloads become digests, and tool arguments become type
SHAPES via `shapeOf`.

**Why re-indexing by content and not by arrival.** Two runs that investigated the same
five signals in a different order are the same strategy. Indexed by arrival they are two
strategies, and a cohort of "similar trajectories" is noise. Verified directly: with the
heavy branch at arrival index 0 it canonicalises to `root/e0[1]`; with the heavy branch at
index 1 it stays at `root/e0[1]`. Same fold either way.

**`shapeOf` is the privacy boundary.** `{namespace:"prod-payments", replicas:3}` becomes
`{namespace:string,replicas:number}`. Structure generalises — "this strategy calls
`k8s.describe` with a pod name" is a fact about the strategy — while values do not
generalise and do leak. Without it a trajectory store is a second copy of production
data, subject to every rule the first copy is.

`tool.called` gained `argsShape`, computed at emit. Deriving it later is impossible: the
arguments are nowhere in the journal, and putting them there would make every journal
the copy the shapes exist to avoid.

**DEVIATION from D10.a.** The fold optionally takes the `RunGraph`. `promptRef` is a
property of the graph, not the journal, and D10.c's delta extraction is keyed on
`(node, promptRef)` — without it the corpus cannot be grouped by the thing being
optimised. Both inputs are immutable and content-addressed, so the fold stays pure.

---

## 2026-08-05 — Wave C — The ladder's protection is structural, not arithmetic

**The temptation.** Make the outcome formula punish weak signals — divide by the TOTAL
weight rather than by the weights present, so a run with only a rubric scores low.

**Why that is wrong.** It punishes a run for the absence of a human, which is not
evidence against the run. Absence is absence. Dividing by the present weights is
correct: `outcome = Σ(wᵢ·sᵢ) / Σ(wᵢ)` over what was actually observed.

**So the protection lives elsewhere, in two structural places:**

1. `isGolden` condition 1 requires a signal from `{S1, S2, S3}`. A rubric that scored 1.0
   yields `outcome = 1.0` and still fails, because the condition is about the KIND of
   evidence, not its magnitude.
2. `promotionCeiling` caps an S4-only candidate at `canary` with mandatory human
   sign-off, whatever the score.

Two independent barriers, because reward hacking is the failure this whole subsystem is
built against and one barrier is a single point of failure.

**S5 is captured and weighted 0.00, not dropped.** A system that never recorded
self-reports could not later measure how often they were wrong — which is the evidence
for keeping the weight at zero.

**A weight change invalidates the cohort, and `scoreTrajectory` THROWS rather than
warns.** The failure mode being prevented is a self-improving system reporting an
improvement it measured with a different ruler.

---

## 2026-08-05 — Wave D — The second workflow found four defects, as it was meant to

Incident triage is the second real workflow: a router, an assertion evaluator, an error
edge, and a compensation edge — four surfaces the skeleton and the authoring graph never
reached together. Building it surfaced four defects, each in code that was green.

**1. A branch with an error path was counted as terminated too early.** `#maybeFireJoin`
counted a FAILED sibling as terminal. But an investigation that failed onto an error edge
is still being handled by the quarantine node behind it — the join fired before the
handler ran, and the recovery the error edge exists for was silently discarded. Findings
came back 2 of 3, and the run reported success.

The fix reads a declaration that was already there: `join.branches` lists every node that
counts as part of the branch. An edge to a node OUTSIDE that set is an arrival at the
join; an edge to a node inside it is a continuation.

**2. A zero-width fan-out stranded the entire downstream graph.** Join notification rides
on a branch Task's commit, and a width-0 fan-out has no branch Tasks — so the join was
never notified, nothing downstream ran, and the run still reported `succeeded`. A barrier
over zero branches is satisfied; it now fires immediately.

**3. A run that produced NONE of its declared outputs reported success.** Found while
fixing 2, and worth its own guard: `E_OUTPUT_MISSING`. "Succeeded, with nothing to show
for it" is the plausible-wrong-answer shape this system exists to refuse. Partial outputs
stay legal — a router arm may write only some.

**4. Replay required a configured model provider.** `models.require()` ran before the
replay branch, so an audit could not re-derive a run without the provider that produced
it — exactly the coupling replay exists to remove. A replay now needs no adapter, reserves
no budget (it makes no call), and takes the provider name from the record.

---

## 2026-08-05 — Wave D — The compiler was right twice and wrong twice

Compiling a realistic graph produced six diagnostics. Two were the compiler being right
about my modelling, and two were the compiler being wrong.

**Right:** `action` was a `replace` channel written by four router arms. GRAPH010 refused
it. The channel is now `append_ordered` — and that is better modelling anyway, because a
run that remediated and was then rolled back took TWO actions, and one `replace` slot
loses the rollback. Second, GRAPH011 said `remediate` had no error handling. It had a
compensation edge, but compensation is a REWIND facility — the engine never takes a
compensation edge on failure — so the node genuinely had none.

**Wrong, and fixed:**

- **GRAPH010 treated router arms as concurrent.** A router takes exactly one case, so its
  arms are mutually exclusive by construction. Over-approximating here pushes the author
  into a channel per arm, which is worse modelling forced by a compiler limitation.
  `armOf` walks back through single-inbound chains — including error and compensation
  edges, so a rollback inherits the arm of the action it undoes.
- **GRAPH005 scoped a fan-out binding to the fan-out target only.** A node on the branch's
  error path reads the same `signal` the investigation did. The binding is in scope for
  the whole branch.
- **GRAPH009 counted an `assertion` evaluator as a spender.** It is a plain function over
  channel state. Only a `rubric` evaluator makes a model call.

---

## 2026-08-05 — Wave D — A run was quadratic in its own history

**Measured, not guessed.** A 500-way fan-out took **1,672 ms** for 500 trivial function
nodes. `#project` re-read and re-folded the whole journal, and it is called once per task
and again per commit — so the fold cost grew with the journal exactly when there was most
work left to do.

`RunFolder` holds the mutable state and consumes only the tail. **1,672 ms → 126 ms.**

**Two details that make it correct rather than merely fast:**

1. **A rewind breaks incrementality.** `checkpoint.restored{mode:"rewind"}` suppresses
   events that were already folded, so what earlier events mean changes retroactively.
   The folder flags itself stale and the caller re-folds from seq 1. Rare by
   construction; paying full cost there is not worth optimising.
2. **`projection()` copies the top-level maps.** The join fold holds a projection across
   commits, and it must not watch its own inputs change underneath it. Nested values stay
   shared, as they already were — they come from event payloads, which are never mutated.

**The peak-concurrency probe was measuring nothing.** It wrapped a SYNCHRONOUS function
body, which runs to completion before any sibling starts, so it reported a peak of 1 no
matter what the scheduler did. With an async body it reports 16 — the configured
`maxParallelism`, which is the actual claim.

---

## 2026-08-05 — Wave E — Delivery failure never auto-approves, and the clock resets

**The rule the file is built around.** Every channel failing is a NOTIFICATION problem,
not an authorization one. The gate stays open, each failure is journaled per channel, and
the only ways out remain a human decision or the declared timeout policy. Anything else
would turn an unreachable Slack workspace into a way to approve a production restart.

Pinned by tests for each way it could leak: a dead webhook, an unknown channel name, a
partial failure, and an exhausted escalation chain. None ends in `gate.decided`.

**Delivery happens AFTER the gate is durable.** A crash between them loses a
notification, not a decision — and the SLA sweep re-delivers on the next tier.

**Zero-dep by construction.** Two built-in channels: `ConsoleChannel`, which cannot fail
and is therefore the fallback, and `WebhookChannel` on the global `fetch`. A Slack
incoming webhook, a PagerDuty Events endpoint, and an internal approvals service are all
that shape, so one implementation covers the realistic cases without `@loom/core`
learning any vendor's API. A real SDK integration is a `DeliveryChannel` living outside
the package.

**The escalation chain had a hole: the clock.** `sweepTimeouts` journaled `gate.timeout`
on `escalate` and did nothing else — no tier advance, no re-delivery. Building it
surfaced the reason the design says "clock resets": a tier that inherited the original
deadline breaches the instant it is reached, so ONE sweep walks the entire chain and
pages the director about something the on-call never saw. Each tier now gets its own
`afterMs` window from the moment it is reached.

An exhausted chain EXPIRES the gate. Returning it to "waiting" would leave it open
forever with nobody left to ask.

---

## 2026-08-05 — Wave E — DEVIATION: gate redaction is field-scoped, not classification-scoped

D7.2 says `redact: [pii]`. Implemented literally — `redactPayload(payload, "pii")` — it
tokenises the WHOLE payload, so the approver sees
`{"command":"pii:3ace…","blastRadius":"pii:91b2…"}`.

**A human cannot approve what they cannot see.** A gate rendered unreadable is a gate
that gets rubber-stamped, which is worse than no gate: it manufactures a record of
informed consent nobody gave.

So the knob is the FIELD SET. `redact: ["email"]` replaces that key wherever it appears,
recursively, and everything else stays legible. Matched by key name rather than by path
on purpose — `email` is `email` three objects down, and a path list silently misses the
nested one.

---

## 2026-08-05 — Wave F — Two rules, both about what cannot happen

**The journal is never pruned, only tiered.** Archiving changes where a run's events live
and how fast they read; it never changes whether they exist. A retention policy that
deleted journal events would make replay, the evaluation gate, and every trajectory a lie
about the past. Pinned by a test that archives a real run, rebuilds a store from cold
storage ALONE, and replays out of it against live tool bodies — if a single effect had
been dropped, replay would fall through to those bodies and their counters would move.

**Audit records are duplicated into their own store, under their own window.** They are
derived from the journal, so the copy is redundant by construction — and that is the
point. Without it, a retention change made to cut telemetry cost silently shortens the
record of who approved what. Those two decisions have different owners and different
stakes, and a system where the cheap one can quietly override the expensive one is
misdesigned. `DEFAULT_RETENTION.audit` is `Infinity` while `cold` is a year, and a test
cuts cold to one day and asserts the approval record is untouched.

**The audit tier is WORM.** A second write of the same key with DIFFERENT content is
`E_AUDIT_IMMUTABLE`; an identical re-put is idempotent, because a retry must not be an
error. An audit store you can rewrite is a story, not a record. Cold is deliberately not
WORM — a re-archive may legitimately supersede.

**`agent_action` covers what the machine did alone.** A hard-to-undo tool call is an
audit record whether or not a human was involved; "who did what" is not only about
people. Read-only calls are excluded, or the audit tier becomes a second copy of the
journal and stops being cheap enough to keep forever.

**`contentDigest` is the field that earns its keep.** It pins what the approver actually
saw, which is why gate payloads are rendered server-side. A later "they were shown the
wrong diff" dispute is otherwise unanswerable.

**Zero-dep, so the backends are memory and filesystem.** Parquet, S3, and Glacier are
`TierStore` implementations that live outside the package — the same shape as
`DeliveryChannel` and `StateStore`. `@loom/core` learns no vendor's API.

---

## 2026-08-05 — Wave G — The escalation table, as data

E1–E10 are now `ESCALATION_RULES`, an object rather than string literals scattered
through the executor. Two properties hold for the table as a whole, and they are what
make it safe to extend:

1. **Every rule only TIGHTENS.** They all call `escalate`, which folds by `max`. A new
   rule is at worst noise, never a hole. Loosening exists solely as `deescalate`, which
   demands a human actor and a justification.
2. **Every rule names itself in the journal.** A test walks every `policy.escalated`
   emitted by a real run and asserts its `rule` is in the table — an anonymous escalation
   is indistinguishable from a bug.

**E5 and E7's evidence is INJECTED** (`SequenceIndex`, `CohortBaseline`) rather than
imported. Neither has anything to say about the first run of a new graph, and a
deployment with no history supplies nothing and they simply never fire. `p99` refuses to
answer under 10 samples: a p99 over one run is the maximum wearing a hat.

**E5 applies to AGENT nodes only.** The first implementation fired on tool nodes too,
and the test caught it: a tool node's tool is written in the spec, so if it changed the
graph hash changed and this is a different graph. Only an agent CHOOSES its sequence at
run time, so only an agent can produce one nobody has seen.

**E1 treats absence as absence.** A verdict with no numeric score has not scored low; it
has not scored. Treating missing as zero would escalate every run whose evaluator
returned a bare `{pass: true}`, and an alarm that always fires is one people learn to
ignore.

---

## 2026-08-05 — Wave G — Reserve-worst-case makes "80% consumed" ambiguous

**The bug, and it was mine twice over.** E2 fires when a run has consumed 80% of its
budget. The first implementation re-derived the fraction from `spentUsd + remainingUsd`
inside the engine, duplicating arithmetic the `PolicyEngine` already owns as `nearLimit`.
The second put the check only at commit time.

Both were wrong for the same underlying reason: under **reserve-worst-case**, committed
exposure PEAKS at the reservation and falls back when `settle` credits the real cost. The
mock reserves ~$0.001 (assuming 1024 output tokens) and settles $0.000024 — a 40× swing.
A check at commit reads the trough and never fires.

"80% consumed" means 80% COMMITTED — the number that could still be spent, not the number
already gone. The check now runs at both sites, with a one-shot flag, because a run can
also drift over the line through settled spend across many cheap tasks without any single
reservation reaching it.

**E4's test premise was wrong too.** Three retries of a schema mismatch is one failure:
`E_PROVIDER_BAD_REQUEST` is validation-class, and `#retryDecision` correctly refuses to
retry it — the same bad shape comes back. The honest test is a three-way fan-out where
every branch fails: three separate Tasks, one node, nothing succeeding in between, which
is exactly the "broken right now" signal E4 exists for.

---

## 2026-08-05 — G1 closed, and pinned so it stays closed

**Why it mattered.** The eight boundary interfaces inherited their error semantics from
the universal contract. That reads as complete and is not: a caller writing a
`retry.onlyIf` list, or a UI deciding whether to offer "try again", needs to know which
codes a method can ACTUALLY produce. "Whatever the universal contract allows" is a set of
fifty, and a caller who must handle fifty handles none.

D3.17–D3.24 now enumerate per method, drawn from the implementations rather than guessed.
Three rows are load-bearing rather than descriptive:

- **`GateDelivery.deliver` raises exactly ONE code.** Any second code invites a caller to
  branch, and every branch out of "the notification failed" that is not "leave the gate
  open" is a way to approve something nobody approved.
- **`ToolTransport.call` on cancel reports unknown as unknown.** A cancelled charge
  recorded as "did not happen" is the most expensive lie this system could tell.
- **`BlobStore.put` is content-addressed, so a partial upload is not addressable.** There
  is no cleanup path because there is nothing to clean up.

**`test/docs-drift.test.ts` keeps it closed.** Writing it immediately found real drift:
the compiler emits `GRAPH000` (apiVersion), added after D5's rule table was written, and
the design never mentioned it. A diagnostic an author cannot look up is a diagnostic they
will guess at.

**One test was deleted for being vacuous.** A first draft asserted that documents
claiming "N event types" agree with `EVENT_TYPES.length`. The only such claim is in this
JOURNAL, which said 42 when 42 was true — and a historical record rewritten to match the
present is not a record. A test that looks like coverage and is not is worse than no
test, so it was replaced with the node-type, edge-kind, and GRAPH-rule checks, which
pin genuine contract surfaces.

---

## 2026-08-05 — Closeout — A tool cannot know a graph's channel names

**Found by using the product, not by testing it.** Copying `bin/loom` into an empty
directory, writing a four-line graph by hand, and running it — which is the exact thing
the single-binary claim promises — produced:

```
E_CHANNEL_UNDECLARED: write to undeclared channel "written"
```

…after `out.txt` had already been written. The built-in `fs.write` returns
`writes: {written: {...}}`; my graph called the channel `note`. Every built-in tool was
usable only by a graph that had guessed its internal vocabulary, and the failure arrived
after the side effect.

**The fix is the convention the engine already documents for agent nodes**: a value the
node did not name goes to the node's declared write channel. Keys the node DID declare
pass through untouched, which is what a graph-local tool wants. So `mapToolWrites` is not
a new rule — it is an existing rule finally applied to the case that needed it.

**The built-in tools had no test file at all.** They now have one, covering the mapping
plus the two things that actually matter about them: they are the only components that
touch a disk or a network, so confinement (`fs.read` cannot escape the root, `net.fetch`
is not even *registered* without an allowlist) is their real contract.

**The lesson, again and more bluntly than before.** Every wave found defects by running a
new SHAPE of thing: a restart, a loop, a branch that recovers, a graph with a router.
This one was found by being a user for four minutes. The walking skeleton, the authoring
graph, and incident-triage all supply their own tools; none of them could have hit this,
because none of them used a built-in tool from a graph they did not also write.

---

## 2026-08-05 — P1 — Subgraph execution, and the compile-then-fail hole it closed

**The hole.** `subgraph` is one of the eight node types. The compiler accepted it and
validated its mappings in full (GRAPH016: depth, cycles, both directions of the channel
map, and a recursive validation of the child). The executor threw
`E_INTERNAL: "subgraph nodes are not implemented in v1"`.

So a graph could pass every one of the 22 compile rules and then die at run time — the
exact failure the compile stage exists to prevent, sitting inside the executor. Every
other guarantee here is conditional on "if it compiles, it runs".

**Decision: the child is a SEPARATE RUN, not an inlined region.**

- It gets its own `runId`, journal, gates, and replayable history, so it is auditable on
  its own terms and the parent's journal stays the size of the parent rather than of the
  whole tree.
- The child run id is DERIVED — `parentRunId~taskId` — for the same reason a `TaskId` is.
  A random id would silently break replay and restart.
- **The invocation is an EFFECT.** `effect.completed` records the mapped outputs, so a
  parent replay serves them instead of re-running the child. Pinned by a test where the
  child charges a card: replay matches, and the shadow rig's charge counter stays empty.

**One human decision, not two.** A child that hits a gate suspends the parent, and the
parent's gate payload names the child run, the child node, and the child's gate. The
human answers once, on the parent; `#forwardGateDecision` carries that answer into the
child. Two gates for one question would be the obvious implementation and the wrong one —
it splits an audit trail across two runs and asks a person the same thing twice.

**The child's spend rolls up.** Without it, a graph could exceed its declared cost by
nesting, which is the one thing GRAPH009 proves at compile time cannot happen. The slice
is carved from what the parent still HAS, not from its original limit: a subgraph reached
late in an expensive run gets less, which is correct.

---

## 2026-08-05 — P1 — A gate had no way to show what it was asking

**Found while testing the subgraph gate.** The projection carries a gate's durable half —
who, which node, what state. The rendered payload, which is the half a human actually
reads, lived only inside `HumanGateBroker`'s in-memory map with no accessor. The HTTP
`GET /runs/:id/gates` returned projection rows; the console rendered the same.

A gate surfaced without what it is asking about is a gate that gets approved on trust.
That is precisely the failure the oversight layer exists to prevent, and it was in the
one place nobody thought to look — the *display* path, not the decision path.

`Engine.openGates(runId)` returns the broker summaries, and the HTTP handler joins them
onto the projection rows. It matters most for a `subgraph` gate, where the real question
is in another run entirely and the projection row says only "node `delegate` is waiting".

---

## 2026-08-05 — T2 closed — function bodies load from digest-addressed resources

**The gap.** A graph naming `function/merge@stable` only ran if someone had called
`functions.register` by hand, in the same process. The compiler pinned the ref, the
resolution manifest recorded its digest, and the executor ignored both — `function` was
the one node type whose resource reference was decorative.

**Compiled and cached per DIGEST, not per ref.** One digest, one compiled body, however
it was reached. That is the pinning rule applied to code: a ref repointed at new bytes
gets a new body, and the old one stays available to a replay that pinned it.

**`node:vm` is not a sandbox, and the module says so in its own docstring.** A fresh
context is a SCOPING mechanism: it stops a body reaching `process.env` by accident, which
is the realistic failure for trusted code. Untrusted code goes through the subprocess
sandbox, behind a tool manifest and a capability. `function` resources are assumption A13
and this is packaging for that assumption, not a relaxation of it.

**`Date` is bound to `undefined` on purpose.** A `function` node is a pure fold over
channel state, and a body reading the wall clock breaks its own replay. GRAPH013 already
refuses clock-dependent *expressions*; leaving the constructor reachable here would be an
inconsistent seam. `ctx.now` is the injected, recorded way.

**A hand-registered body WINS over a stored one.** An embedder or a test overriding a
resource is doing so deliberately, and silently preferring the stored version would make
the override look like it worked while doing nothing.

---

## 2026-08-05 — T2 — Cross-realm values, and the `.map` that did nothing

**Found by `deepStrictEqual` refusing two structurally identical objects.** An object
literal inside a `vm` context is built from THAT context's intrinsics, so `{writes: {…}}`
coming back has a different `Object.prototype` than anything in the host. It looks
identical, passes `typeof`, and any downstream prototype check would quietly disagree
with itself depending on whether a body was loaded or hand-registered.

`intoHostRealm` rebuilds on the way out, which makes a loaded body indistinguishable from
a registered one and enforces at the cheapest seam what channel values must be anyway:
plain JSON-shaped data. Anything not plain — a function, a class instance — passes
through untouched, so the canonicalizer rejects it with its own clear message rather than
this helper mangling it into `{}`.

**The first version used `value.map(intoHostRealm)` and did nothing at all.** `map` goes
through `ArraySpeciesCreate`, which uses the ARRAY'S OWN constructor — so mapping a
cross-realm array produces another cross-realm array. `Array.from` is the host's, so it
builds a host array. The test that caught it asserts on the PROTOTYPE, because
`Array.isArray` is realm-agnostic and passes either way — which is exactly why the bug
was invisible.

---

## 2026-08-05 — T1 closed — a YAML subset, and the one that stays a string

**The question T1 asked:** take a YAML dependency for the CLI, or write a subset parser?

`@loom/core` has zero runtime dependencies, checked in CI and demonstrated by a binary
that boots from an empty directory. Spending that on authoring sugar is a poor trade —
especially since almost none of real YAML appears in a hand-written GraphSpec. Anchors,
aliases, tags, five scalar styles, and the implicit typing rules that turn `1:30` into a
sexagesimal number are all absent from every YAML block in the design documents.

**Everything outside the subset is REFUSED with a line number.** That is the entire point.
A parser that silently mishandles an anchor produces a graph the author did not write, and
the compiler then validates the wrong thing perfectly. Anchors, aliases, tags, merge keys,
a second document, and tabs in the indentation all fail loudly.

**`on` STAYS A STRING.** YAML 1.1 turns `on`, `yes`, and `off` into booleans — the most
notorious footgun in the format, and catastrophic *here specifically*, because `on` is a
posture. `posture: on` silently becoming `posture: true` would turn on-the-loop oversight
into a type error at best and a wrong posture at worst.

**A duplicate key is an error, not last-wins.** JSON silently keeps the last one. In a
GraphSpec a duplicate means two declarations disagree and one is being ignored, which is
exactly what an author needs told.

**YAML stops at the CLI boundary.** It is converted to a plain value before anything
downstream sees it, so a digest is only ever taken over JSON — two authors who write the
same graph in different formats get the same hash. Verified end to end: a hand-written
`hello.yaml` compiled and ran through the standalone binary in an empty directory.

**The flow-collection parser is a parser, not a regex.** The first version quoted bare
words with a regex and handed the result to `JSON.parse`; it broke on
`capabilities: [fs:write]`, reading the colon in a capability NAME as a key separator and
producing `["fs":write]`. Any regex that tells those two colons apart is already a parser,
so it became one — it tracks whether it is inside `{}` or `[]`, which is the actual
difference.

---

## 2026-08-05 — T3 closed — the warning went away on its own

`node:sqlite` no longer emits an `ExperimentalWarning` on Node 24.16, so the question T3
asked — suppress it for CLI UX, or live with it — has no subject. Verified directly and
through the standalone binary's `run` and `serve` paths: no warning on either.

**A guard rather than a note.** `test/journal/store.test.ts` listens for a
sqlite-flavoured `ExperimentalWarning` while constructing the store and asserts none
arrives. That converts "it happens not to warn today" into "we would notice it starting",
and it names the alternative in its own failure message: the tempting fix was
`process.removeAllListeners("warning")` or `--no-warnings`, which would have hidden every
OTHER warning too — including the ones that mean something.

---

## 2026-08-05 — P5 — Layout moved out of the browser, and became measurable

**The claim and where it lived.** D8 says "the browser never runs graph layout". The code
implementing it was inside `CONSOLE_HTML` — a JavaScript string served to a browser, where
nothing could check it, nothing could measure it, and the DoD's 500-node row had to say
"unmeasured" for the whole thing rather than for the one part that genuinely is.

**`server/layout.ts` is a pure function of `(RunGraph, tasks)`.** Extracting it bought
three things that mattered more than tidiness:

1. **Measurable.** 500 nodes and 4,900 edges lay out in **0.95 ms**, and 100→500 costs
   6.6× for 5× the nodes and 25× the edges — linear in edges, which is what a rank-based
   placement should be. Only literal paint is left unmeasured, and it is a browser
   property that a headless-browser dependency would be required to measure.
2. **Testable.** Rank assignment, fan-out collapsing, and edge routing are now failing
   tests when wrong rather than a diagram that looks slightly off.
3. **Cacheable by `graphHash`.** Geometry ships with the structure payload, so a run
   streaming a thousand task updates recomputes zero positions. Asserted directly:
   layouts with and without tasks have identical coordinates.

**The console now draws what it is given.** `drawGraph` turns numbers into SVG and decides
nothing about where anything goes. A test asserts the page contains no `layoutRank` and no
`GAPX`/`GAPY` — the claim checked against the artifact rather than against a comment.

**A collapsed fan-out shows the WORST state, not the commonest.** Twenty-five branches,
one shape: 24 succeeded and one awaiting a gate is a fan-out waiting on a human, and
rendering it green is a lie of omission. That ordering was buried in a `dominant()` helper
in the HTML string; it is now `STATE_PRIORITY`, exported and tested.

---

## 2026-08-05 — The scheduler seam — G3's claim, made testable without building G3

**What checklist item 7 actually claimed.** "Local → distributed changes implementations,
never call sites." For the journal that is discharged: one conformance suite passes
against `MemoryStateStore` and `SqliteStateStore`. For the SCHEDULER it was a claim about
code that had no seam at all — selection was twenty lines inline in `Engine.advance`, so
"swap the implementation" would have meant editing the executor.

**The seam is deliberately small.** A `Scheduler` answers exactly one question: *given
what the journal says, which Tasks should this worker run right now?* Leasing, executing,
committing, and the fencing token stay in the executor, because those must not vary
between deployments — a scheduler that could also decide HOW a Task runs would be a second
executor.

**`LeasedScheduler` is not idle documentation.** It runs against the same journal and
passes the same conformance suite as the in-process one, plus the three things a
multi-worker selector must do and a single-worker one never has to: skip a Task another
worker holds, reclaim an expired lease, and take back its own without waiting. Running it
anyway is the double execution the fencing token catches *after the fact* — and after the
fact is too late for a tool that already sent an email.

**The projection was shaped for one worker.** `task.leased` carries a `workerId` and a
fencing token; the fold turned it into a state and threw both away. With one worker there
is nothing to ask. A second worker's first question is "is anyone on this?", so the read
model now keeps the lease — which is the change that made the seam usable at all, and a
good example of a read model quietly encoding a deployment assumption.

**Still `DEFERRED-v2`: partition assignment (G3).** The genuinely risky part is not
selection but *who runs which run*. That needs a coordinator, and shipping half a
coordinator is worse than shipping none. What has changed is that the risk is now
localised to one named thing rather than spread through the executor.


---

## 2026-08-05 — Hardening — Gate authorization: journaled, required by the type, bound to the gate it mirrors

**One arc, hardened across four waves, and worth reading as one decision** — because each
fix was the same mistake found one door further in, and the final shape is the only part
that matters now.

**Where it started: the approvers list lived in memory.** `HumanGateBroker` kept
`approvers` and `allowEdit` in a private `Map`, so the rule held for the process that
raised the gate and for nothing else. After a restart the list was gone, which made
`delivery.ts`'s `approvers.length > 0` check a no-op in the shipped system and made
`allowEdit` fail **open** — a signed `edit` could then write any channel, including a
`reduce: sum` budget accumulator. Worse, the distinction that mattered was not
expressible: "this gate named nobody" and "I could not read who it names" both arrived as
an empty array, and empty is the permissive case.

**The final shape.** `gate.raised` carries `approvers`, `allowEdit`, `slaMs`, an ABSOLUTE
`deadline`, `onTimeout` and `mirrorOf`; `gate.escalated` carries the reset deadline. All
of it folds into `GateRecord`, and `HumanGateBroker.resolve` enforces from that fold — so
the rule holds at every entry point rather than at the one that remembered to check.
`isAuthorizedActor` refuses an `agent` or `evolution` actor outright: a model must never
satisfy a human approval, whatever its `profile` says. The broker's remaining `Map` is
typed `EphemeralGate` and holds only payload, delivery route and default action, which
makes reading an authorization decision out of process memory **a compile error rather
than a discipline**.

**The type carries it, because the guard was missed twice.** `NodeOutcome.gate` has a
REQUIRED `auth: {approvers, allowEdit}`, computed in exactly one place
(`gateAuthorizationOf`) and passed through `#commit` unchanged. Before that, `#commit`
derived authorization from `node.humanGate` — a block `GRAPH020` permits only on a
`human_gate` node — so the two gates a human answers most often, a tool's posture gate and
a subgraph's mirror, journaled no approvers and no allow-list. A child declaring
`approvers: ["u:security-lead"]` in front of a charge was enforced by nobody. Making the
field required moves "did you think about authorization here?" from a reviewer's memory to
the compiler, and that is the general lesson: **a guard that is missed twice should be
made unrepresentable, not re-added.**

**A mirror gate is BOUND to the gate it forwards to.** `#runSubgraph` writes `mirrorOf`
when it raises the mirror and inherits that specific child gate's approvers;
`#forwardGateDecision` resolves exactly that gateId or nothing. Inheriting from one
`find(state === "open")` and forwarding into a second, independent one is not one bug in
two places — it is a missing binding, and answering any unrestricted child gate between
the two lookups (ordinary queue work, not an attack) slid a restricted gate under a mirror
that had inherited nothing. The binding must be durable because the process that raises
the mirror need not be the one that forwards it. A mirror's `allowEdit` is `[]` and the
broker refuses `edit` and `redirect` on it outright: `node.writes` on a subgraph node is
exactly the set needed to forge the delegated result, and approve/reject are the only
decisions that can cross into another run's namespace.

**Three narrower doors, closed the same way.** `isAuthorizedActor`'s system escape hatch
became a three-name allow-list (`GATE_SYSTEM_ACTORS`: the broker's own timeout path, the
subgraph forwarder, and replay) rather than "any `system` actor", because `system:cron`
was answering gates that named a person. `Engine.resolveGate` is typed to a human plus
replay-mode, with the executor's own forwarding going through a private
`#resolveGateAsSystem` — replay-mode is a property of how the Engine was CONSTRUCTED,
which no route added later can fake. And `#applyGateDecision` now refuses a `redirect`
naming any edge the node does not declare: "a human cannot invent a target any more than a
model can" had been a comment with nothing behind it, while `#activate` resolved edge ids
against the whole graph.

**A graph declares approvers inline, and everything else is a compile error.**
`HumanGateNode.approval` uses D7.2's field names verbatim, but `mode` other than `single`,
any `k`, `separationOfDuties` and `delegation` are `GRAPH014_APPROVAL_UNSUPPORTED` errors.
Accepting the block and enforcing only the implemented part yields a graph that reads "two
leads must agree" and behaves as "any one", which D7.9 names the worst failure available —
it looks supervised, so nobody goes looking.

**Rejected.** Resolving the `oversight/<name>@<version>` Resource, where D7.2 actually
puts this block: `ResourceResolver.resolve` returns a pin, not a document, and nothing in
`src/` reads Resource content, so being design-faithful meant building a content-resolution
seam through the compiler and the engine — several times the size of the defect. Also
rejected: a `NodeSpec.approval` field so any node could restrict its own posture gate (a
second place to declare approvers is a second thing that can disagree); inheriting the
child's `allowEdit` into a mirror (it names CHILD channels, so inheriting authorizes
whatever happens to share a name); and a capability token minted by the executor and
checked by the broker (it would have to be exported from `gates.ts` for `engine.ts` to
mint it — importable by exactly the in-process caller it defends against).

**Reversal condition.** Move `approval` onto the Resource the moment a content-resolving
`ResourceResolver` exists; the node block then becomes an override or is deleted. Widen
`approvers` from `readonly string[]` to a `{kind, id}` union when an identity resolver can
expand roles — never before, because a role that expands to nobody is an approvers list
that authorizes everybody. The `approvers`-inheritance rule is a single-source assignment
only because just one node type can declare approvers today: the moment a second can,
`gateAuthorizationOf` must COMPOSE the two rather than let one win, and an empty
composition must mean "nobody may answer". Reverse the `mirrorOf` pointer if a subgraph is
ever allowed to mirror more than one child gate at once — the binding then becomes a set.

---

## 2026-08-05 — Hardening — The inbound callback edge: verify before you look anything up

**Choice.** `DeliveryChannel.parseCallback?(req: CallbackRequest)` takes the RAW BYTES plus
headers and returns `{runId, gateId, decision, actor, idempotencyKey}`.
`SignedWebhookChannel` implements it with HMAC-SHA256 over Slack's `v0:{ts}:{body}`,
compared with a length-safe `timingSafeStringEqual`. `GateCallbackRouter.handle` is the one
inbound dispatch path and runs the signature check BEFORE any lookup; admission (run exists
∧ not terminal ∧ at least one open gate) then gates only whether a `gate.callback_rejected`
row is written, never whether the request reaches `resolve`.
`POST /runs/:id/callbacks/:channel` is exempt from the bearer token, scoped by method AND
path AND the presence of a configured dispatcher.

**Rationale.** Slack does not hold the control plane's bearer token, and handing one to
three vendors so they can answer a gate would put a credential that can start and cancel
runs into their logs. So the HMAC *is* the authentication for that route — a strictly
narrower one, since it authenticates a single gate decision rather than the whole API.
Three details are load-bearing. The body reaches the verifier as **bytes**, because
`JSON.parse` → `JSON.stringify` does not round-trip (key order, `1.0`, `A`), so a
signature checked against a re-serialization is checkable-by-luck: it passes for the
payloads a test happens to use and fails in production. The timestamp is INSIDE the signed
material, because a timestamp checked but not signed is one the attacker edits and the
replay window is then decoration. And the idempotency key is derived from the signature
rather than minted, so a channel retry lands on `resolve`'s existing
`(gateId, approver, key)` check instead of a second mechanism that would drift from it.

**Verifying first was not a tidy-up; the lookup-first order was the bug.** The callback URL
carries the runId and is handed to a third party, so it is not a secret. With the lookup
first, 200 unsigned POSTs at a finished run appended 200 journal rows, and the status codes
were an unauthenticated existence oracle — 403 for a real gated run, 404 for a fictional
one. Verifying first collapses both, and it is also the cheaper check. In the same pass
`ControlPlane` learned to parse its own request URL totally: `new URL(req.url, "http://" +
host)` sat outside the handler's `try`, llhttp accepts `Host: a b`, and one unauthenticated
packet on a raw socket ended the process along with every in-flight run.

**Where a refusal may be durable, and where it may only be counted.** The split follows
from the reorder: at perimeter-failure time we no longer know the run exists, and appending
would conjure a journal for it. A forged, unsigned or replayed callback
(`PERIMETER_REJECTIONS`) is refused having read nothing and written nothing; a
signed-then-unauthorized one is journaled to that run, because a caller who demonstrably
used the secret has earned a durable row. Everything withheld from the journal lands in
`GateCallbackRouter.refusals()` — a process-lifetime counter keyed by (configured channel
name) × (closed rejection token set), so it is O(1) in request volume — and `GET /health`
surfaces it only to a caller holding the shared token. That is invariant 8 exactly:
backpressure at admission, overflow to the lossy sink, never a lost journal fact. Durable
rows are additionally capped at 32 per run per process (`#admitRow`), because the secret is
shared with a third party by construction and the commonest integration bug there is — a
`parseCallback` that returns without checking the MAC — otherwise buys one row per POST
forever.

**Rejected.** Journaling every refusal unconditionally: the claimed bound ("the winning
decision exists") is not one, since N conflicting posts still write N rows. Coalescing
repeated rejections into one row with a count: a window that flushes only when the next
attempt arrives loses the tail exactly when the attack stops. Requiring an open gate to
reach `resolve` at all: it turns a webhook retry of an already-recorded decision into a 404
that reads as "your approval was lost", breaking the documented idempotency contract.
Putting `parseCallback` on `WebhookChannel` behind an optional secret: it destroys the only
cheap test for "can this channel be answered?", since `parseCallback !== undefined` would
then mean "maybe, depending on config".

**Reversal condition.** Reverse the single-secret-per-channel model if a deployment needs
per-sender key rotation or asymmetric signatures — `SignedWebhookChannel` then grows a
key-id header and a resolver, or is replaced by a channel outside `@loom/core`. Reverse the
URL-carries-runId shape if a vendor cannot template a callback URL per gate; the fallback is
a global `POST /callbacks/:channel` that derives the run from the signed body, which costs a
gateId→runId index and loses the pre-parse admission bound on journal writes. Reverse the
durability split if operators need forged attempts on the record — at which point the answer
is a bounded sink outside the journal, not a row per packet. Raise or re-shape the 32-row
cap if a legitimate run ever exceeds it: it is a guess about human behaviour, not a property
of the protocol.

---

## 2026-08-05 — Hardening — `run/delivery.ts` has ONE boundary, instead of a fifth guarded getter

**Choice.** Values from injected code become values this module OWNS, at one place, and
everything downstream reads the owned copy: `ownError` for anything a channel or the engine
throws, `ownedCall`/`ownedDecision`/`ownedActor` for every property of a returned
`CallbackDecision`, `usableReceipt` for a receipt, `channelName` for a channel's name
(read once, at construction — an unnameable channel is `E_CONFIG_INVALID` at boot rather
than an untyped throw at request time), and `safeGateId` for an id on its way into a
lookup. `#refuse` takes a `LoomError`, so the compiler now states what three waves of
comments did.

**Rationale — four waves running, the untyped exit from this file was a read of an injected
value on an error path.** `describeCause`'s `name`, then `journalMessage`'s `message`, then
`rejectionReasonOf`'s `details`, then `parsed.runId`: each fixed where it was found, each
followed by the next one property over. The last was worse than a repeat — `toLoomError`
returns `e` unchanged when `isLoomError(e)`, and `instanceof` proves a prototype, not
provenance, so the booby-trapped accessor `readProp` had been added to survive escaped WITH
the error and detonated in `LoomError.toJSON` on the HTTP path, one layer out. Hardening
readers inside a file while handing the object to callers who read it bare is a boundary
with a hole shaped exactly like the value it was meant to stop. Three shapes turn out to be
one bug: a getter that throws, a value that is not the type it claims, and a name that
resolves through a prototype — `gates["__proto__"]` answered with `Object.prototype`, so a
gate nobody raised produced a 409 and a durable row asserting `already_resolved` about
nothing.

**A channel that does not resolve a usable receipt has FAILED, not delivered.** A receipt
is `string` by contract and injected code's return value in fact. `canonicalize` refuses a
symbol, so `log.append` threw AFTER every channel had reported — one hostile channel
deleting every healthy channel's `gate.delivered` row. And the old `"receipt" in r` split
was true for `{channel, receipt: undefined}`, so a channel that resolved nothing was
journaled as a delivery and the `ConsoleChannel` safety net was suppressed at the moment it
was most needed. `usableReceipt` bounds to 200 characters, rejects non-strings and blanks;
the dispatcher turns each into `E_GATE_DELIVERY_FAILED` with `reason: "receipt"` and splits
on the error, not on key presence.

**`deliver` raises one code, and now that is true for every exit.** D3's taxonomy calls the
single code load-bearing and only the non-2xx arm honoured it — the arm that almost never
fires. `fetch` REJECTS for the two failures that actually happen, so an unreachable endpoint
escaped as a bare `TypeError` and a hung one as `E_INTERNAL`, i.e. "a bug in Loom", which
pages. Everything now exits `E_GATE_DELIVERY_FAILED` (class `unavailable`, so `retryable`
stays true and a declarative `retry.onlyIf` keeps working) with the cause in `details`,
except a caller-initiated abort, which stays `E_CANCELLED`: retrying a delivery an operator
cancelled is the wrong branch, and journaling a person's abort as a delivery failure blames
the network for their action. `WebhookChannel` also masks its own URL, origin, path and
userinfo out of any cause string via `maskLiterals` — a Slack webhook path IS the bearer
token, and it was reaching an audit row nobody can rotate.

**Rejected.** A fifth local `try` — three waves of evidence say the next reader added to
this module will not get its own. Passing `CODES.E_GATE_DELIVERY_FAILED` as `toLoomError`'s
fallback code, which is the smaller edit: it fixes the code and leaves the class `internal`,
so one code would live in two classes and `retryable` would silently differ between a
webhook and a vendor channel. Passing the engine's `details` through: it is the one
unbounded field on an error and `errorRecord` copies it verbatim, so the owned copy carries
a closed-set `reason` token or nothing. And owning the values the ENGINE hands this module
(the `GateSummary` to deliver, the `RunProjection` to return) — those are read models folded
from this process's own journal, and copying them per call would say nothing true about
where untrusted values enter, which is `DeliveryChannel` and nothing else. Errors the engine
or store THROW are not covered by that exemption and are owned like a channel's.

**Reversal condition.** A second module needing the same treatment: `ownError`, `ownedJson`
and `readProp` move to a shared `untrusted.ts` rather than being copied. The
one-property-over failure recurring anyway would mean the boundary is in the wrong place —
the next candidate is the `DeliveryChannel` interface itself, wrapped once at registration
so no un-owned channel object exists inside the module at all. Delete the local totalizing
wrappers the day `errors.ts` makes `toLoomError` total and `LoomError` copies its own fields
at construction. And revisit the receipt rule if a real channel legitimately reports
delivery without an id it can be asked about later — the right change is then a
`receiptless` flag declared at construction, not a dispatcher inferring it from `undefined`.

---

## 2026-08-05 — Hardening — The approver's identity comes from the credential, never from the request body

**Choice.** `ControlPlaneOptions` gains an injected `IdentitySource` that resolves an
`AuthContext` (`human` | `service`) from request headers, and `POST /runs/:id/gates/:id`
builds its `HumanActor` from that alone. A body `actor` that DISAGREES with the
authenticated principal is a 403, not a preference; a credential that names no person
decides as `(unidentified)` and is refused outright on any gate that declares approvers,
with an error naming the missing configuration. Ships with `BearerTokenIdentity` (one token
per subject) and `loom serve --identity-file`, a file rather than a flag because argv is
world-readable via `ps`.

**Rationale.** `subject` began life as an AUDIT LABEL and became an AUTHORIZATION KEY the
wave approvers started being matched against it — and nobody revisited where it came from.
One shared bearer token plus `{"actor":"u:security-lead"}` decided a gate that named the
security lead (reproduced at HTTP 200, with the journal naming them), while the shipped
console, honestly posting `actor: "console"`, got 403 on the same gate. Forgery was the only
workflow that worked, in the one place the whole oversight layer terminates. **That is the
general lesson: an audit label that becomes an authorization key needs its provenance
re-examined, and nothing about the type system will prompt you.** The seam is injected for
the same reason `DeliveryChannel` is — identity is the most vendor-shaped thing in a
deployment and `@loom/core` must stay zero-dependency.

**An injected seam's output is data, not a type.** `checkedAuth` validates what
`IdentitySource` returns, splitting on what each field DOES: `subject` and `kind` decide, so
a wrong one is refused (500, `E_CONFIG_INVALID`, naming the source) — including
`(unidentified)`, which is this file's word for the absence of identity and not a name a
source may claim, and including an over-long subject, refused rather than truncated because
truncating turns `u:alice-contractor` into `u:alice`. `via`, `mfa` and `onBehalfOf`
describe, so a wrong one is dropped. Every field is read ONCE into a `const`: reading
`raw["via"]` twice — validate, then use — let a getter pass the closed-vocabulary check with
`console` and write `telepathy` into the journal.

**Nothing a stranger can reach may cause `IdentitySource.identify` to be called.**
`/health` used to consult the seam so it could decide whether to disclose the refusal
counters, which meant an SSO outage returned 503 from every healthy process and drained
them out of rotation — an outage CAUSED by the health check rather than caught by one, and
an unauthenticated amplifier aimed at the deployment's own identity provider. The counters
are gated on the shared token instead, and the accepted cost is written down: an
identity-only deployment with no service token cannot read them. Three routes are open by
design and the count is exactly three — the callback route, `/health`, and `GET /`, which
serves the console's static shell because a browser cannot put a bearer token on a top-level
navigation. The console therefore streams over authenticated `fetch` rather than
`EventSource`, so the token rides in a header instead of a query string.

**The idempotency map had inherited "there is exactly one principal".** `Idempotency-Key` is
a string the caller chooses; keyed on that alone it was a shared namespace — sound while
every caller was the same principal, and a cross-principal collision the day they were not.
Two teams both call their nightly job "nightly": the second submitter was handed the first's
`runId`, and with it the projection and event stream of a run they did not submit, while
their own submission was silently never made. The slot is now `(method, kind, subject, key)`
via `idempotencySlot`, JSON-encoded so no subject can be spelled to reach across, and both
idempotent writes use the one helper. The two ways of being wrong are not symmetric — too
fine a slot costs a duplicate run, too coarse a slot hands one principal another's — so the
slot errs fine.

**Rejected.** Refusing at compile time, as `GRAPH014_APPROVAL_UNSUPPORTED` refuses
`mode: quorum`: whether identity exists is DEPLOYMENT config, not graph config, and the same
graph is answerable where a source is wired and unanswerable where none is. The gap is
closed at boot instead — `unanswerableGraphs()` names every affected graph on stderr, the
earliest moment both halves are in one process. Also rejected: ignoring a body `actor`
rather than refusing it, which leaves a client confidently wrong about what the journal
says; and refusing an out-of-vocabulary `via` rather than dropping it, because taking a
deployment down over a label an SSO liked is the wrong trade for a field that describes
rather than decides.

**Reversal condition.** If a deployment appears that must accept a decider's subject from a
payload — a broker fronting the API that has already authenticated the human and cannot
present their credential — this becomes wrong as stated. The honest shape is then a
delegation field (`onBehalfOf`) on a credential explicitly granted impersonation by the
`IdentitySource`, never an unauthenticated `actor` string. Equally, if `AuthContext` starts
accumulating vendor-shaped fields (claims, group lists, token introspection), the seam has
been drawn too narrow and belongs in its own module with a resolver interface rather than as
a type in `server/http.ts`.

---

## 2026-08-05 — Hardening — Authentication is not authorization: the control plane's scope limit, chosen and made loud

**Decision, and it is a decision not to build.** `AuthContext` admits a caller, names a
gate's decider, and namespaces an idempotency slot. It scopes NOTHING else: runs are not
owned by the principal that submitted them, so every valid credential can list, read, stream
and cancel every run, and can see every gate payload. Rather than half-build isolation, the
limit is stated in `http.ts`'s module docstring under "THE LIMIT", in a D3.17 subsection, on
each of the four unscoped routes, and — the part that cannot be deferred — as a boot warning
whenever `ControlPlane.distinctPrincipals > 1`, on both boot paths. It is pinned by a test
that has one principal cancel another's run, so the limit cannot be narrowed without
rewriting an assertion that states it in full.

**Rationale.** D3.17 puts `auth` on every method precisely so it can scope, and the code
took it and dropped it — a contract that over-promises. The honest fix needs a DURABLE
owner: a `submittedBy` on `run.submitted`, folded into the `runs` read model, with
`listRuns` filtered in the store, plus a designed operator escape. All of that is engine and
journal work. The only version buildable in the server alone is a process-local ownership
map, which evaporates on restart, violates invariant 2, and READS as isolation while
providing none — strictly worse than an honest absence. Configuring per-subject identities
implies isolation to whoever does it, which is why the warning is the part that ships now
and why it stays silent at one principal: there is nobody to be isolated from, and a warning
that fires when nothing is wrong is one operators learn to skip.

**Rejected.** The process-local map above. Also rejected: disclosing the limit through
`/whoami` or the console header — the false implication belongs to whoever CONFIGURES
identities, and the boot warning and the docs reach that person, while a new `/whoami` field
changes a wire contract for a different audience.

**Reversal condition.** Build per-principal access the moment a second tenant or a second
team shares one control plane, or the moment anything that is not an operator holds a
credential. The trigger to watch for is a deployment adding subjects to `--identity-file`
for reasons other than "these people approve gates". When it flips, the ask is exact: the
`submittedBy` field above; and the limit's test is REWRITTEN rather than deleted, so the new
boundary is stated as precisely as the old absence was. `IdentitySource.principals` and
`ControlPlane.distinctPrincipals` exist only to decide whether to warn and lose their
purpose that day.

---

## 2026-08-05 — Hardening — A terminal operation is not final until every producer of the state it ends is stopped

**A read model with no writer looks exactly like a finished feature.** D7.3's gate FSM had
`Open --> Cancelled: gate.cancelled` from the day it was drawn, and D6.4 explains why it
must exist: `ctx.abort` reaches every in-flight effect and cannot reach a gate, because an
open gate has no work to interrupt — it is a row and a queue entry. The event type was in
`EVENT_TYPES`; `projection.ts` folded it. **Nothing in `src/` ever appended one**, and a
`grep` for the string was enough to see it. So `cancel` stopped the run and left its gates
`open`, `resolve` validated the GATE and had no opinion about the RUN, and `gate.decided`
carried an unconditional `run.resumed` that the fold applied whatever the status was. Three
reasonable decisions, one hole: answering a leftover gate on a cancelled run resurrected it
and performed the irreversible action the operator had just refused. Reproduced end to end —
`cancelled → succeeded`, with the guarded `fs.write` executed.

**Closing it took four sides, because cancel is not the only producer of an open gate.**

1. **Gates that already exist.** `cancel` and every `run.failed` path in `#finish` emit
   `gate.cancelled` per open gate, in the SAME append as the terminal event
   (`cancelOpenGates`) — a crash between the two would leave a stopped run with a live gate,
   which is exactly the answerable state.
2. **Gates that do not exist yet.** `cancel` closes the gates that exist; it cannot close one
   that does not. A Task already in flight reached its gate on a dead run, and the
   `run.suspended` riding with `gate.raised` carried the status back out of `cancelled`.
   `raise` now projects and refuses `E_ILLEGAL_TRANSITION` on a terminal run — a state
   machine refusing a move out of a final state, which is not the same fact as a repeated
   decision.
3. **The success path.** `#finish`'s docstring excused `run.completed` on the grounds that
   "`advance` re-suspends rather than finishing while a gate is open". False: the budget and
   fatal floors reach `#finish` without passing that check, so a SUCCEEDED run could leave a
   live question in an approver's queue. **An exemption justified by a claim about a
   different function survives exactly until that function changes.**
4. **The fold.** Its terminal guard covered `run.resumed` and nothing else, so
   `sweepTimeouts` appending `run.failed` to a cancelled run overwrote `cancelled` with
   `failed`. `RUN_STATUS_EVENTS` now names the six status-moving events and one line at the
   top of `apply` refuses all of them once the run has ended. The rule had been a property of
   one EVENT rather than of the STATUS, and the next event to violate it walked straight
   through.

**`raise` was the one commit path still using `append`, and the reason had expired.**
`RunLog.append` retries a seq conflict by re-reading the head, which is right for events
that are facts that happened — and `raise` used to be exactly that. Adding a terminal check
turns it into a decision made AT a projection, and a retrying append after a check is
precisely how a check passes and the write behind it lands on a journal that has since
moved. It uses `log.commit(expectedSeq, …)` now.

**Undoing a failure is a retry; undoing a refusal overrules a person.** `rewind` refuses a
`cancelled` run — suppressing `run.cancelled` suppresses the `gate.cancelled` events beside
it, so every gate reopens with the run, one call, no approvers checked — and refuses any
rewind whose suppressed range contains a `gate.decided{decision:"reject"}`, because a run
that failed BECAUSE a human refused is also just `failed`. The opposite sign resolves the
other way for a checkable reason: rewinding past an `approve` stays allowed, because
suppressing the decision RE-OPENS the gate rather than carrying the approval forward, so
the same person is asked the same question again before anything runs. Re-asking someone
who said yes costs a click; re-asking someone who said no is an appeal against a decision
already made. `edit` and `redirect` go with `approve` — they modify a request, they do not
refuse one.

**Two orderings that could have gone the other way.** `resolve`'s terminal check sits AFTER
the idempotency check, not before: a webhook redelivery routinely lands once the run has
finished, and three tests correctly refused to let a retry of an already-recorded decision
become a 409. What is refused is a NEW decision on a dead run. And the append-side guards
stay primary per invariant 2, with the fold's guard doing the narrower job of keeping a
journal an older build wrote readable.

**Rejected.** Making gate EXPIRY close its sibling gates too. That would require the SLA
sweep to stop after the first expiry, and a run-wide loop must not abort on one member —
`ONE GATE CANNOT WEDGE THE SWEEP FOR THE WHOLE RUN` pins the opposite, deliberately. So
expiry is the one path that still produces a terminal run with an open gate, which is
exactly why `resolve`'s own check must stay. Also rejected: adding a dedicated
run-is-terminal error code, which would need an `errors.ts` line and a design-document row
in the same change; the refusal reuses `E_GATE_ALREADY_RESOLVED`, same `conflict` class,
with the distinction in the message.

**Reversal condition.** If a legitimate use appears for a status transition out of a
terminal state — a forced cancel that must overwrite a `failed` run — the answer is a NEW
event type that says so, not a hole in `RUN_STATUS_EVENTS`. If rewinding past a rejection
turns out to be a real operational need, it needs its own command with its own approvers
list and its own journal event; it must not arrive as a relaxation of `rewind`. And the
dedicated terminal code lands the day `errors.ts` and D3's taxonomy are edited together.

---

## 2026-08-05 — Hardening — Reclaim is a second candidate source, not a filter over `eligible`

**Choice.** `LeasedScheduler.select` unions two sets: `ready` Tasks not held live by another
worker, and `leased` Tasks whose lease has lapsed. A lease whose deadline is exactly `now`
counts as LIVE, and a worker does not reclaim its own live lease.

**Rationale.** Reclaim used to be a FILTER over `eligible()`, and `eligible()` returns only
`ready` Tasks — correct for one worker, and empty for the exact case reclaim exists to
serve. A worker that dies mid-Task leaves it `leased` forever, because the state only
advances when its holder commits, so the stranded Tasks were precisely the ones `eligible()`
excluded: the path was structurally unreachable. It survived the conformance suite because
that suite builds projections BY HAND and gave the stranded Task `state: "ready"` — a
combination the real fold only produces after a retry or a resolved gate. Folding real
journals for two workers (`test/run/contention.test.ts`) turned seven tests red on the first
run. This is the handoff's own trap one layer up: not "the projection discards a field",
which was already fixed, but "the CONSUMER still encodes the one-worker assumption in a
state predicate". The boundary goes to LIVE because the two errors are not symmetric —
calling a live lease dead double-executes a Task that may already have sent the email;
calling a dead one live costs one poll interval.

**Rejected.** Widening `eligible()` to include expired `leased` Tasks: that leaks reclaim
into `InProcessScheduler`, where a `leased` Task is this process's own in-flight wave and
re-selecting it double-runs it. `eligible()` stays "ready and past its backoff", which is not
a policy; reclaim is one, and belongs to the implementation that has more than one worker.
Also rejected: clearing the lease on `task.committed` / `task.retry_scheduled` — keeping it
is what stops two workers racing a retry the moment its backoff lapses.

**Reversal condition.** Reverse if partition assignment (G3) lands and gives each Task
exactly one eligible worker by construction; reclaim then becomes the coordinator's job and
the scheduler goes back to a pure `ready` filter. Revisit the boundary if leases ever become
short relative to the poll interval, where a lease-duration delay stops being cheap.

**Still open, and named in `HANDOFF.md` → Known issues.** No append in the executor passes
`fencingToken`, so both stores' fencing checks are unreachable and a stale holder's late
commit is accepted; `Engine.#fencing` is a process-local counter a second worker would
collide with; and `advance` gates on ready Tasks before calling the scheduler, so a stranded
`leased` Task never reaches `select`. The contention suite covers all three the moment the
executor supplies them.

---

## 2026-08-05 — Hardening — Drift became a guard, and then the guard was made honest about itself

**Choice.** `test/docs-drift.test.ts` reads both `design/loom/**` and `src/` and fails on
disagreement: span names against `telemetry/spans.ts`, error codes against `errors.ts` in
both directions, `GRAPH\d+` in both directions, an exact pin on the codes nothing raises,
an exact pin on the event types nothing APPENDS, and a check that every method a design
`export interface` declares exists on the real prototype (or the real `src/` interface) of
the class it names. Documents may describe unbuilt things only through
`DESIGNED-NOT-BUILT(<identifier>)` — or `NOT-IN-CODE(<identifier>)` where the document names
a symbol only to say it is absent — each naming one registered identifier, pinned to the
exact set of files allowed to carry it.

**Rationale.** Three consecutive waves each found the same class of defect by hand:
a scheduler-tick
span asserted in four documents and emitted nowhere; `E_ADMISSION_REJECTED` heading a
three-level admission design with nothing under it. "Fix the design when it turns
out to be wrong" only works if being wrong is NOTICED, and a human noticing is the step that
kept failing. The marker rules exist so the escape hatch is an admission rather than a
silencer: silencing costs two edits in two files, and a caveat cannot outlive its gap
because building the thing turns the suite red.

**"Who appends this?" is the question that found the severe one.** `NEVER_APPENDED` exists
because `gate.cancelled` was declared, listed in `EVENT_TYPES` and FOLDED — which is what
made it so easy to believe in — and written by nothing. Nothing about that is visible from
any single file. The same check names eight more unappended types, including
`budget.reserved`/`budget.settled` (D6.5 assumes a crashed worker's reservation is
recoverable by folding; it is not, and `reservedUsd` is permanently zero) and
`task.cancelled`/`task.skipped`, whose folds and span arms are unreachable. The widened
method check found four D3 methods no caller could reach.

**Three rounds were then spent making the guard stop overstating itself, and that is the
part worth remembering.** A guard that is confidently wrong is worse than no guard, because
the reader stops looking — the exact failure it exists to prevent, reproduced in the tool.
(a) It announced that stripping `\p{Cf}` closed the zero-width bypass; that is the wrong
character class, and U+034F, the variation selectors, the Mongolian FVS and the Hangul
fillers all render as nothing and each silenced a claim outright. The class is now
`[\p{Cf}\p{Default_Ignorable_Code_Point}]` over code points, and the homoglyph bypass, which
cannot be closed without a confusable table larger than the guard, is written down as an
open limit AND pinned by a test that fails when it closes. (b) Five tail/next join regexes
INVENTED span names and error codes out of ordinary hard-wrapped prose — gluing a wrapped
table cell's trailing identifier to the next line's first word, so a nested list item and a
blockquote each produced a claim nobody had written; they were replaced by one rule for both
passes — **a normalization may recover a
claim, it may never invent one** — after which coverage went UP, because mid-segment breaks
became joinable. (c) The stated honest limit was wrong: a broken identifier did not fail
silently, it failed LOUDLY under a name nobody wrote, which is a different and worse
instruction to give a reader.

**Rejected.** Parsing method bodies to attribute error codes to the boundary method that
raises them — the check D3.17's table actually wants. Tried on `GateDelivery.deliver`, and
it broke the same afternoon: a refactor moved the mapping into a private helper, the body
named no code, and the guard reported the method raises nothing. A false negative on a
security row is worse than no check, so it was replaced by a BEHAVIOURAL check that
constructs a channel with an injected rejecting `fetch` and reads the code actually thrown.
Also rejected: a guard over span ATTRIBUTE names, because `spans.ts` writes keys both quoted
and bare and a regex recovers half while reporting it as the whole; comparing method
signatures, since `Function.length` reports 1 for `sweepTimeouts(log, now = …)`, exactly
matching the wrong signature the doc carried; and NFKC normalization, which would rewrite a
corpus full of `→ ⏎ ⊆ ≥ ·` and still miss Cyrillic.

**Reverses when.** The marker registry stops being read — if it grows past roughly thirty
entries, or if a wave adds markers without deleting any, the convention has become a
suppression list and each entry should get a build-or-delete deadline instead. Separately,
`NEVER_APPENDED` should be derived from running the engine and reading the store rather than
from `type:` literals the day a fixture journal exists that provably covers every
`EVENT_TYPE`; the attribute check becomes possible at the same moment. And if `tsc -b`'s
`.d.ts` output can be assumed present during `npm test`, signature checking becomes
tractable and the method check widens to the design interfaces that have no class.

---

## 2026-08-05 — Hardening — The corpus caught up with the code, and the promotion gate turned out to be overstated

**Choice.** The assumption register in `08-PLAN.md` now states what the code holds and WHY,
D3.20's `parseCallback` signature was replaced by the one that shipped, the fairness claims
were corrected to what the seam can express, and — in this closing pass — D10.d's promotion
criteria were rewritten to the arithmetic that actually runs.

**Each correction is the same failure in a different place: a document asserting something
nobody could check.** `A2` said `Node 22+` while `engines.node` is `>=24.0.0`, and the
rationale offered ("type stripping and `node:sqlite` each require 24") is itself false —
type stripping is default from v22.18.0 and `node:sqlite` unflagged from v22.13.0, so the
strict floor they imply is 22.18 and 24 is a CHOICE. **A rationale that is wrong is worse
than no rationale, because it stops the next person checking.** `A11` said "7 years" where
`DEFAULT_RETENTION.audit` is `Infinity`, which reads as an oversight until you see that Q3
put erasure out of scope and "keep the approval record until a human deliberately shortens
it" is the direction that fails safe. `A12` promised React + Vite + Zustand for a console
that is one vanilla-JS document embedded as a string constant — the point being not that we
wrote vanilla JS but that the console INHERITS the zero-dependency rule rather than being
exempted from it. `01-INTERFACES.md` claimed ready Tasks are drawn by weighted DRR over Runs
then Tenants, which is not merely unbuilt but unexpressible at the shipped seam:
`Scheduler.select` receives ONE run's projection.

**The most consequential one was the promotion gate, and it was found last.** D10.d
described criterion 2 as McNemar's paired test with a 95 % lower bound on the paired
difference; `gateCandidate` compares two point estimates and asks whether the difference
clears a margin. Criterion 3 said "median cost"; the code divides one suite TOTAL by
another, and `EvalReport` has no median field at all. Criterion 7 claimed
injection-resistance cases are required; nothing reads them, and `EvalCase.expect` has no
field in which a suite could declare one. This is the gate that stops self-evolution
shipping a regression, so an overstated description of it is the worst doc defect the
programme had left — a reader who trusts the table believes a candidate cleared a
significance test it never took. The table now states the arithmetic, and the gap between
design and code is recorded as a defect with a fix, not smoothed over.

**Rejected.** Re-adding a "documentation drift to fix" register. The previous one outlived
its own items: it quoted four strings that had been removed, so a newcomer opening the file
to fix them found none of the text and could not tell whether the work had been done or the
file had moved — the one question such a list exists to answer. **A list of documentation to
fix is itself documentation, and it rots faster than what it points at.** Corrections go
into the sentences that are wrong, in the change that finds them; the diff is the record.
Also rejected: striking out the resolved register rows the way D14.2 strikes answered
questions — `A2` and `A11` are only PARTLY settled, and a struck row is one nobody re-reads.

**Reverses when.** A claim becomes cheaper to check than to read — i.e. when
`test/docs-drift.test.ts` can pin it mechanically; that is the standing instruction to widen
the guard rather than re-audit by hand. The D10.d correction reverses in the good direction:
when the paired test, the median and an injection-resistance expectation are BUILT, the
table goes back to describing them, and this entry becomes the record of the window in which
it did not.

---

## 2026-08-05 — Hardening — The register was audited against the tree, and two of its entries were fiction

**Context.** The previous wave replaced a rotting "documentation drift" list with a
known-issues register in `HANDOFF.md`, on the argument that a register of *defects* ages
better than a register of *edits*. An adversarial read of that register found it had
committed the same error it was built to end, in the opposite direction: it listed defects
that no longer existed. **A1** described `HumanGateBroker.resolve` indexing the gate map
bare and answering `409 E_GATE_ALREADY_RESOLVED` for `__proto__`; **A8** described the fold
letting `gate.decided` and `gate.timeout` overwrite a terminal gate state. Both had been
fixed before the register was written, and A1 cited as its provenance a reading of a file
that could not have produced it.

**Decision.** Every entry was reproduced or refuted against this tree before the register
was touched. 36 checked: 2 refuted and removed with the refutation recorded in place, 32
reproduced, 2 left explicitly UNCONFIRMED, 5 added. The removals are written down rather
than silently made, because "an entry vanished" and "an entry was never real" are the two
readings a reader cannot otherwise distinguish — and the second one is the one that
destroys the register.

**Why a false known-issue is worse than a missing one.** A missing entry costs the reader
the bug. A false entry costs them a day reproducing something already fixed, and then costs
them the whole document: having found one entry that was fiction, the rational move is to
stop trusting the other thirty-eight. The register's only asset is that a reader can act on
it without checking it first.

**What the audit found that reading alone would not have.** Four of the five new entries
came from executing something rather than reading it, and they are exactly the four the
previous pass missed. `#expire` appends `run.failed` without re-reading the gate, so a
decision landing inside `sweepTimeouts`' own read→append window is recorded, resumes the
run, and is then killed by the deadline it beat (`gate=decided decision=approve run=failed`
— fail-closed, live, untested). `Engine.rewind`'s boundary refusal is written against the
event type `gate.decided` when the hazard is an append that spans two seqs, so `#expire`'s
`gate.timeout` + `run.failed` reproduces the identical wedge through a door the refusal does
not watch. And three load-bearing guards turned out to have no test at all: reverting each
one and running the whole suite left it at 1003 pass, 0 fail — including
`presented.length === expected.length`, without which `Bearer s3cretEXTRA` authenticates,
and the `typeof token !== "string"` half of the constructor refusal, without which
`token: []` yields a plane that answers `GET /runs` **200 with no credential** while
`/health` reports `auth: "required"`.

**The pattern worth keeping.** A correction made against a file must be followed by a grep
of that file for the claim just refuted. The D10.d correction was read out of
`evolution/gate.ts` and left three refuted copies inside `gate.ts`'s own docstring —
"authored by humans, never by the evolution engine" (replaced in M9), "median cost" (the
code divides totals), and "the eight criteria" (the function pushes eleven, which
`99-DOD.md` row 8 had already called out). The same shape appeared in `run/delivery.ts`,
which still described `resolve` indexing bare four waves after it stopped.

**Rejected.** Keeping A1 and A8 "in case they come back", and renumbering nothing. Both are
the comfortable option and both are dishonest: a register that never shrinks is a register
nobody prunes, and stable-but-wrong ids are how six cross-references in `design/loom/` came
to name `C1.4` — an entry with a sub-number the register has never had.

**Reverses when.** An entry can be pinned mechanically. Every one that can becomes a test in
`docs-drift.test.ts` and leaves this file; the register is for what a test cannot yet hold.
A2 (fencing), A9 and A10 all reverse the good way — they become tests the day the defect is
fixed, and the entries go with them.

## 2026-08-06 — Fail-open — A decision in no vocabulary is a refusal, not an approval

**Context.** `GateDecision` is a four-member union and every reader downstream branches on
`kind === "reject"`. So every kind the union did not name satisfied each of those branches
by not being the one they tested, and fell through to the permissive reading. Driven against
`Engine.resolveGate` — the public, pinned-surface method an embedder calls — one fresh
skeleton run each, the last column being whether the guarded `fs.write` behind the gate
really ran: `{"kind":"REJECT"}` → `succeeded writes=1`, `{"kind":"nope"}` → `succeeded
writes=1`, `{}` and `42` → `succeeded writes=1` with no `decision` field on the row at all.
An operator's caps-lock was an approval, and the journal kept `decision: "REJECT"` beside an
action that happened — a word in no vocabulary, recorded as the thing a human decided.

**Decision.** One exported guard, `gateDecisionOf`, in `vocab.ts`; `HumanGateBroker.#validate`
is the point of use and now RETURNS the checked decision, so nothing downstream re-reads the
caller's object. `GateDecision` moves to `vocab.ts` with it.

**Why `vocab.ts` and not `run/gates.ts`.** `run/gates.ts` imports `run/delivery.ts` at run
time, so a guard exported from either is an import cycle for the other. `vocab.ts` is a leaf
module whose whole stated purpose is "value types shared by layers that must not import each
other", which is exactly the situation. It has no imports, so it raises no errors either —
`undefined` is its fail-closed answer, and each caller chooses its own code.

**Why one guard rather than a fourth private switch.** There were already THREE independent
switches over this union — `checkedDecision` (`server/http.ts`), `ownedDecision`
(`run/delivery.ts`), and `run/replay.ts`'s `decisionOf`, whose `default:` arm returned
`{kind: "approve"}` — in front of a broker that validated it nowhere. `checkedDecision`'s own
docstring claimed it mirrored `ownedDecision` "member for member, so unifying them later is a
deletion rather than a reconciliation"; by the time that was checked they had already drifted
(one truncates `reason` and JSON-round-trips its containers, the other does neither). Three
guard chains for one union is what invariant 6 forbids, and a door is not a guard: the next
route added is the one nobody copies the switch into.

**What did NOT collapse, and why that is the interesting half.** Each door keeps what is
genuinely its own, because the INPUTS differ. `ownedDecision` reads a vendor adapter's return
value, so it bounds `reason` and copies `writes` through a JSON round trip — and it keeps a
`isPlainRecord` check on the INPUT as well as the result, which the first version of this
change dropped and a test caught within the hour: `ownedJson` renders a `Map` as `{}`, so a
`Map` of a human's edits would have been journaled as an edit that edited nothing, on a gate
somebody had just been asked to edit. `checkedDecision` reads `JSON.parse` output and keeps
its per-member HTTP messages, which a total function returning `undefined` cannot give a
caller. Folding those in would make one door's bound another door's silent behaviour change.

**A7, in the same change, because it is the same failure one layer out.**
`GRAPH014_APPROVER_INVALID` accepted any non-empty string, so a graph could list
`(unidentified)` — the marker the perimeter mints for a caller it could not identify — as an
approver. That list reads as restricted and is satisfied by exactly the callers nobody
vouched for. The refusal is on the parenthesised FORM rather than on the two markers this
build happens to mint, so a marker added later is refused by construction; and it is applied
at all three doors, because the control plane's perimeter check was only ever one of them —
`loom approve --as` and the signed-callback route each construct the actor themselves.

**Rejected.** The minimal variant: a total switch inside the private `#validate` only, ~20
lines and surface-neutral. It closes the fail-open and leaves three validators for one union,
which is the arrangement that produced the defect. Two deliberate exports are cheaper than
the fourth copy.

**Every guard was watched failing.** Nine mutations, one per new condition, each reverted
against the whole suite: eight were killed by the test named for them. The ninth —
`replay.ts`'s `default:` arm — SURVIVED, because no fixture can reach it any more: the broker
now refuses to journal a decision outside the vocabulary, which is the fix one layer up. It
is reachable only from a journal this build did not write, so the test wraps the store and
rewrites one field on read, keeping every seq and ts identical. It kills the mutation.

**Reverses when.** A fifth `GateDecision` member is added. `gateDecisionOf` is then the one
place that has to learn it, which is the property the change was made for — and the three
doors become compile errors rather than silent approvals, which is the property it was made
against.

## 2026-08-06 — Fail-open — The register was verified before it was worked, and the review found the half the fix left open

**Context.** The handoff's known-issues register listed 44 entries and the previous wave's
own lesson was that a false entry costs more than a missing one. So nothing was fixed until
every open entry had been reproduced or refuted against the tree: 18 checked, 14 confirmed
OPEN, **4 refuted** — A11 (the `pii` floor is the published contract, stated in
`DeliverySpec.redactAs`'s own JSDoc and pinned by name), A17 (the `taskId === ""` branches
are not dead; they defend hand-written journals), A20 (the SSE window is real in principle
and EMPTY in practice, because both shipped stores are synchronous), A21 (the exclusion is
already stated, measured and priced in `run/delivery.ts`'s own `THE BOUNDARY` block, and the
entry names the smaller half of it). Each refutation is recorded in place rather than the
entry being deleted.

**Decision.** Nine entries closed: A19, A7, A6, A10, A14, A12's residue, A1, A16, and A18's
three quiet reads. Each is written up in the register with what it cost to find.

**The finding that justifies the whole method.** The A19 fix — one guard, one point of use,
three doors collapsed onto it — was reviewed by two fresh readers of the diff, and one of
them found that it closed the WRITE side and left the READ side open:
`Engine.#applyGateDecision` reads a decision back out of the FOLD and branched on
`=== "reject"` alone, so a journal carrying `decision: "REJECT"` still ran the guarded write.
The journal is authoritative, and *trusted* means "we do not defend against it", not "it
cannot be malformed". **When a value is guarded on the way in, ask what reads it on the way
out** — the two are different questions with different attack surfaces, and the fix that
feels complete is the one that answers only the first.

**The review's arithmetic, because it is the argument for asking for everything.** 30
findings, **27 refuted** by an independent skeptic per finding. Both findings graded
*blocking* were downgraded to minor by their verifiers and both were REAL: an unbounded
`for…of` over a caller-supplied `Symbol.iterator` (an uncatchable heap OOM, exit 134, on a
path reachable from the unauthenticated callback route) and the read side above. A 90 %
rejection rate is the cost of a reviewer that does not self-censor, and it is cheaper than
the two it caught.

**What the sweep caught that no reviewer did.** Reverting one condition at a time and
counting what turns red found five more: `StateView.get`/`require` reading the slice bare
after `makeStateView` had been made total (the third recorded instance of *"make the reads
total" is a claim about a SET of reads*); `ephemeralOf` letting a rehydrated `slaMs` of `NaN`
become a deadline that never arrives; and two tests that caught their guard only as a HANG
rather than as a failure, which were rewritten to distinguish in microseconds.

**And one hazard was MOVED rather than closed, which is its own lesson.** `claimedList`
refused to spread a hostile container and then returned the container — and the next reader,
`redactAttributes`' `walk`, calls `.map` on anything `Array.isArray` accepts. A `Proxy`
claiming `length: 2 ** 32 - 1` was refused in one function and walked in the next; the suite
hung. **A guard that refuses a value and passes it on has relocated the problem.** The
container is now rendered to a marker.

**Rejected.** Deleting the closed entries. Seven have live cross-references in `design/` and
`packages/`, and D10's own warning is to run the grep BEFORE deleting rather than after — so
they are marked RESOLVED in place, which keeps every citation valid and keeps the
reproduction, which is the part that is worth reading.

Also rejected: a `#iterating` flag making a second `for await` over one `Subscription`
unrepresentable (it would have to be threaded through `replayThenTail`'s merged iterator, and
a re-entry after a clean `break` is legitimate and indistinguishable at that seam); and
making `spansFrom` total over the twelve LOUD partial reads, which is one decision about
partial spans rather than twelve edits.

**Reverses when.** The journal records an append boundary. A10 is the third event type added
to a scan whose real property is "this boundary splits an append whose tail carries the run's
status transition"; the day `JournalEvent` can say which append it belonged to, that scan
becomes one structural check and three special cases go away.

## 2026-08-06 — Fail-open — The second review, and the two assertions that could not fail

**Context.** The phase 2–5 diff went through the same two-reviewer, one-skeptic-per-finding
pass as phase 1. 20 findings, **17 refuted** — two of them shown byte-identical to the base
commit (`providers/http.ts` is literally the same blob), one whose claimed observable did not
reproduce when driven.

**The three that survived, and what each says.**

**`toLoomError` could not tell "threw" from "absent".** `readOwn` collapses both to
`undefined`. That is correct where the answer is only ever rendered and wrong where it
decides whether the VALUE may be passed on: a forged error whose `class`, `code` and
`message` all answered and whose only trap was on `details` was indistinguishable from one
with no `details`, so it went through by identity with the trap live — and `errorRecord`
reads `e.details` and `e.retryable` bare into a journal payload. **The question a boundary
has to ask is not "did this answer for me" but "will it answer for the next reader",** and
that is what makes a field the function never uses part of its check.

**Two of this wave's own assertions were inert.** The bus test capped each collector at two
entries, so `notDeepEqual(a, [1,2,3,4])` was a tautology that a perfectly fan-out bus would
also satisfy. The `shouldExport` half of A18's `runId` fix was never executed, because
`shouldExport` returns at `ratio >= 1` six lines above the read and the test passed
`headRatio: 1`. **Both were written in the same wave that added a mutation sweep, by the
person running it.** A sweep only kills what it mutates: neither line was covered by a
mutation because neither guard looked like a guard.

**And verifying a finding beat accepting it.** The `slaMs` finding was REFUTED by its
skeptic, and the underlying defect was real anyway — reproducing it myself found a worse
shape than the reviewer named: `raisedAt + "1000"` CONCATENATES, giving a deadline ~10^10 ms
out on a gate an operator believed had a 1 s SLA, while `NaN` threw an untyped
`CanonicalizationError` out of a public method. `raise` is `#deadlineOf`'s HIGHEST-authority
source and the previous wave had guarded only the lowest.

**The recurring shape, now four times in two waves.** A19: guarded the write, not the read.
A14: fixed the slice construction, not the two readers. A12: guarded `rehydrate`, not
`raise`. A18: refused to spread the container, then passed it to a caller that walked it.
Each time the fix was correct and the SET it applied to was short. **The habit that finds
these is not "make the reads total" — it is "name every site that touches this value, and
write the list into the claim."**

**Rejected.** Fail-closing `class` to `internal` whenever ANY field is trapped. It reads as
the safe direction and is not: `class` decides the HTTP status and the retry policy, so an
unrelated `details` trap would turn a real 403 into a 500. The trapped field is dropped and
the fields that spoke are carried across.

**Reverses when.** `Channel` grows per-consumer cursors. The single-consumer contract is
documented and pinned rather than enforced, and no one-line mutation can express fan-out —
so the day that changes, `A SUBSCRIPTION IS ONE CONSUMER'S CHANNEL` is the test to change
deliberately rather than a test to notice failing.

## 2026-08-15 — Close-the-audit — A tool gate inside an agent turn is a refusal, not a suspension

**Context.** `PolicyEngine.decide` returns three effects, and the executor had one place to
put each: deny, hold, gate. `gate` meant "suspend the Task and raise a `HumanGate`", which is
exactly right on the path that reaches it from `#executeTask` — the Task boundary is a commit
boundary, so what has to survive until the human answers is journaled. It is not right on the
path from inside an agent turn. **A turn's transcript lives in memory.** Suspending there
would mean a gate raised mid-turn could be answered after a restart onto a conversation that
no longer exists, and either the turn is silently restarted (the model is asked twice, the
tool may run twice) or the approval is honoured against a context nobody can reconstruct.

**Decision.** `Engine.#invokeTool` REFUSES on `gate` when the node was not already approved:
it appends `policy.decided{effect:"deny"}` naming the tool and the reason, and returns an
error result telling the model that this action needs a human and belongs on a `tool` node,
which can suspend. The refusal is journaled rather than only returned, because an
irreversible action that was refused is precisely what an operator reading the trace
afterwards needs to see, and a string that only the model ever reads is not a durable fact.

**Rejected.** Turn-level durability — journaling the transcript so a mid-turn gate can be
resumed. It is buildable and it is a different system: it makes the model's context a durable
entity with its own vocabulary, its own redaction rules and its own replay semantics, to buy
a suspension that a one-line graph change (put the tool on its own node) already buys.

**Reverses when.** An agent turn becomes durable — a journaled transcript with a resumable
cursor. At that point `gate` at this call site can raise a real gate, and the sentence in
D3.6 that calls this a refusal is the one to delete.

## 2026-08-15 — Close-the-audit — `nodeApproved` is a trust assertion, and it is what makes one dispatch path survivable

**Context.** Two changes met. A node's posture became the `max` over every tool it can REACH
rather than the one it names, so an agent node that can call a destructive tool now floors at
`in` and gates BEFORE the model runs. And the entry above makes a `gate` decision inside a
turn a refusal. Composed naively those two are a deadlock that reports success: the human
approves the node, the model asks for the tool, `#invokeTool` re-decides, gets `gate` again,
refuses — and the run ends `succeeded` having done none of the work the human said yes to.

**Decision.** `#invokeTool` takes `nodeApproved`, set when `#executeTask` already ran the
full chain for this node and a human, if asked, said yes. It is a **trust assertion carried
across a call boundary**, not a second guard chain: the decision is still made in one place
and the flag says only *that decision has already been made and answered for this Task*.
`lastDecidedGate(p, taskId)?.decision === "approve"` is where it comes from — the journal,
not a field the caller could invent. It also suppresses the second pre-irreversible hold, so
an approved node does not serve its intervention window twice.

**What this deliberately does NOT become.** A capability. `nodeApproved` authorizes the tools
the NODE declares, because the posture floor that raised the gate was computed from exactly
that reachable set — so approving the node is approving it to act with the tools it declares.
It cannot widen the set: the allowlist handed to the model is still computed from the node
spec before the turn, and a tool name the model invents is refused before dispatch.

**Rejected.** Passing the gate decision itself down and re-deriving trust inside
`#invokeTool`. It reads as less of a shortcut and is more of one — it puts a second reading
of the journal on the dispatch path, which is the second guard chain invariant 6 exists to
forbid, wearing a different hat.

**Reverses when.** Per-call approval exists — a human answering "yes to THIS tool with THESE
arguments" rather than "yes to this node acting". Then the flag becomes a decision id and the
chain re-reads it. Until then, widening `nodeApproved` past the node's declared tool set is
the mutation that turns an approval into a blank cheque, and
`test/run/agent-tool-oversight.test.ts` is where that has to fail.

## 2026-08-15 — Close-the-audit — `replayThenTail` defaults to `close`, and that is what "gap-free" means

**Context.** D3.9 promised a gap-free reconnect path and the bus promised at-most-once
delivery, and both were true in isolation. `replayThenTail` reads the journal and then merges
a live subscription, deduping by seq. The unqualified word "gap-free" is not keepable by
merging: a consumer can always fall further behind than any bounded queue.

**Decision.** The live half is opened `onOverflow: "close"` by default — deliberately NOT
`subscribe`'s `drop_oldest` — and the iterator throws `SubscriberOverflowError` carrying a
resume seq. Nothing consumes the live channel while the journal is being read, so its queue
is fullest exactly at the seam; `drop_oldest` discards from the OLD end, which is the seam
itself, and the `seq <= lastSeq` dedupe filters duplicates and never gaps, so the hole would
leave no trace in the delivered stream. `close` cuts at the new end instead, so what was
delivered is always a contiguous prefix. **The guarantee is therefore "a contiguous prefix,
then a throw", and the throw is what makes the first half true.**

`opts` is accepted so a caller can raise `queueSize`. A caller that overrides `onOverflow`
has chosen at-most-once and must track its own watermark; D3.9's Delivery row now says so.

**Rejected.** `E_SUBSCRIBER_OVERFLOW`. The thrown value is a plain `Error`, not a `LoomError`
with a `Code`, because it never crosses a process edge — declaring a code would promote a
local control-flow fact into boundary vocabulary that a `retry.onlyIf` list or an HTTP status
map could then name. `NOT-IN-CODE(E_SUBSCRIBER_OVERFLOW)` records that, and the drift guard
pins which of the two marker spellings it may carry so the softer word cannot become the
cheaper one.

**Reverses when.** The bus grows per-consumer cursors backed by the journal, at which point
overflow stops being terminal and the throw becomes a resumption rather than a cut.

## 2026-08-15 — Close-the-audit — Cold retention is infinite, because cold is not a cache

**Context.** D9.4's table gave the cold tier "1 y (configurable)", inherited from the shape of
the hot and warm tiers, which hold spans and metrics.

**Decision.** `DEFAULT_RETENTION.cold` is `Infinity`, and `journal/retention.ts` refuses to
construct a policy with a finite `cold.retentionMs` unless the caller also passes
`pruneJournal: true`. The reason is not conservatism about disk. **Cold is where the journal
comes to rest — `archive` writes the complete event array there and there is no tier beneath
it — so a finite cold window is a delete however it is spelled.** It would break invariant 2
(the journal is the only authoritative durable state) and leave the derived audit record
outliving the log it was derived from, which is the exact coupling the separate audit tier
exists to prevent, running backwards.

A deployment under an erasure mandate can still have a finite window. It just cannot arrive
there by leaving a field alone, and the flag it must pass is named for what it does.

**Rejected.** Deriving `cold` from `audit`, or making `pruneJournal` a per-run decision. The
first re-couples the two windows this design separates on purpose; the second makes replay
availability a property of a run rather than of the deployment, so "can this run be replayed"
stops having an answer you can give in advance.

**Reverses when.** A tier is added beneath cold — an offline export whose existence is itself
journaled. Then a finite cold window is tiering again rather than deletion, and the refusal
should move down one level rather than being removed.

## 2026-08-15 — Close-the-audit — `realpathSync.native`, because a resolved path is still a string

**Context.** The sandbox jail answers "is this path inside the root?" for paths that do not
exist yet, so it resolves the deepest existing ancestor and re-appends the missing
components. The JS `realpathSync` resolves symlinks and **preserves the spelling the caller
used**.

**Decision.** `realpathSync.native`. On a case-insensitive filesystem — which is the default
on macOS and common on Windows — two different strings name one file, so a containment or
deny check compared case-sensitively is walked past by `.LOOM/journal.db`. The native binding
asks the filesystem and returns the name it actually stores, so the comparison is against one
canonical spelling rather than against whichever one the caller typed. This is the same error
as the one a level up, arriving in the resolver instead of in the comparison.

Two neighbouring rules stay as they are and belong to the same claim: a **dangling symlink is
refused rather than treated as absent** (`lstat` is what tells "link to nothing" from "name
that was never created"; without it `ws/evil -> /etc/nope` resolves ENOENT like an absent
name and `open(…, O_CREAT)` then creates `/etc/nope`), and every other resolution failure —
ELOOP, EACCES, ENAMETOOLONG — is denied, because there is no answer to "is this inside the
jail?" that a caller can act on when the filesystem will not say where the path leads.

**Rejected.** Case-folding the comparison instead. It needs the guard to know the filesystem's
collation, which is per-mount and not observable from Node, and it answers the wrong question:
the jail wants the name the filesystem stores, not a normalization of the name it was given.

**Reverses when.** Node exposes a resolver that reports the mount's case sensitivity, or the
jail moves to inode identity (`stat` the resolved root once, compare `dev`/`ino` up the
chain), which is stronger and does not depend on strings at all — that is the direction to go
if this is ever revisited, not a return to the JS binding.

## 2026-08-15 — Close-the-audit — Egress is checked per hop, not per request

**Context.** The built-in `net.fetch` tool takes an operator's allowlist. `fetch` defaults to
`redirect: "follow"`, so one check before the call authorized the FIRST url and nothing else:
any host on the allowlist could redirect the request anywhere, and the allowlist became a
statement about who you ask rather than about where the bytes come from.

**Decision.** `redirect: "manual"`, and `assertEgressAllowed` runs again on every `Location`,
with the hop number in the refusal's details. A refusal THROWS rather than returning an error
result, on every hop for the same reason it does on the first: an egress refusal is a
capability denial, and the run's error taxonomy is where a denial belongs — collapsing hop 2
into a `content` string would make a policy violation look like a bad web page.

**Rejected.** Checking only the final url. It is one line shorter and it authorizes every
intermediate host implicitly, including the one that saw the request headers.

**Reverses when.** The tool grows a proper HTTP client with its own policy hooks, at which
point the check belongs in the client rather than in the loop — but "the host the bytes came
from is one the operator named" is the property to keep, not the loop that implements it.

## 2026-08-15 — Close-the-audit — The gate could pass on a tree that does not build

**Context.** `npm run check` is THE gate, and its first arm is `tsc -b`. `tsc -b` is
incremental, and its up-to-date test is a **timestamp comparison**, not a read of the inputs.

**The reproduction, in a replica of this repo's tsconfig layout.** Source edited, its mtime
moved behind `dist/`: `tsc -b .` exits 0 having compiled nothing; `node --test` strips types
rather than checking them; and `node scripts/check-surface.mjs` — the last arm of `check` —
reads `packages/core/dist/index.d.ts`, which is exactly the file that was not re-emitted, and
prints `surface guard ok: 1 public exports, unchanged` while `export const
BRAND_NEW_PUBLIC_EXPORT` sits in `src/index.ts`. Forcing the build turns the same tree into
`surface guard FAILED … added: BRAND_NEW_PUBLIC_EXPORT`.

**Decision.** `typecheck` and `build` both run `tsc -b --force`. `typecheck:clean` is gone
(`--force` subsumes it) and `typecheck:fast` is the incremental one, documented in CLAUDE.md
as an inner-loop command and not a gate. The cost is a full compile of 49 files; the thing
bought is that "the gate is green" and "the tree builds" are the same statement again.

**What this does NOT fix, said plainly.** The second arm
(`tsc -p packages/core/tsconfig.test.json`) is not incremental and does include `src/**/*.ts`,
so an ordinary type error was still caught by it even when the first arm skipped — checked,
not assumed. What the skip lost was the EMIT, and the emit is what the surface guard reads.
So the demonstrated failure is a stale public contract rather than a stale type check.

**Rejected.** Forcing only in CI. CI does a fresh checkout and was never exposed; the machine
that needs the honest answer is the one with a `dist/` already on it.

**Reverses when.** `tsc -b` learns a content-hash up-to-date check, or the build gets big
enough that a forced compile is felt. `packages/core/test/toolchain-gate.test.ts` reads the
flags out of `package.json` and hands them to the real compiler, so dropping `--force` fails
on what the compiler did, not on what the script says.

## 2026-08-15 — Close-the-audit — The zero-dep guard now covers the routes a parser cannot read

**Context.** Invariant 1 has exactly one automatic enforcer. `build:binary`'s esbuild metafile
backstop — added precisely because the source guard "would NOT catch a transitive import
introduced through a path it does not scan" — is **not in `ci.yml`**, so nothing runs it
unattended; and esbuild leaves a runtime `require` as a runtime call, so for the shapes below
both layers were blind at once.

**What passed the guard before this change**, each reproduced against a fixture tree:
`createRequire(import.meta.url)("lodash")`, a bare `require("lodash")`, a computed
`import(NAME)`, a template-literal ``import(`lodash`)``, an `.mjs`/`.mts` file under `src/`
importing anything at all, `optionalDependencies` (which npm installs by default), and
`bundleDependencies`. Twelve of the new test file's twenty cases were watched passing.

**Decision.** Three checks instead of two, and the first two are widened rather than patched.
Check 1 is now an **allowlist** over `/ependencies$/i` — exactly one field, `devDependencies`,
may be non-empty — which is total against dependency fields npm has not invented yet, where a
denylist of two names never could be. Check 2 walks every file `ts.createSourceFile` can
parse and **fails on one it cannot**, so "the guard read nothing here" and "the guard found
nothing here" stop printing the same thing. Check 3 is new: no file may load a module by a
route the parser cannot read.

**The trap, paid for once and pinned as a test.** `require` is a legitimate METHOD name here —
`ToolRegistry.require`, `FunctionRegistry.require`, `ReplayCursor.require`, `Engine.#require`,
about fifteen call sites — so a rule keyed to the callee's NAME fails the whole build. The
rule is keyed to its SHAPE: a bare identifier callee, never a property access, never a private
name. Both directions are rows in `test/check-zero-dep.test.ts`.

**Rejected.** Two things. Validating `node:` specifiers against `builtinModules` — that was
raised and refuted: `node:` is a reserved scheme never resolved against `node_modules`, so a
misspelled builtin is a typo rather than a dependency, and it is already `TS2307` under this
repo's `nodenext` config in every import form. And changing `build-binary.mjs`: esbuild
genuinely cannot resolve these forms, so the source guard is the right and only place.

**Reverses when.** `src/` legitimately needs a dynamic import — a lazily loaded optional
backend, say. The rule then needs an allowlist of specifiers rather than a ban, and the
allowlist has to be checked the same way check 2 checks a static one.

## 2026-08-15 — Close-the-audit — The drift guard's "absent from src/" meant one file

**Context.** Rule 4 of `docs-drift.test.ts` — a stale marker fails — and `design/loom/README.md`
both promised that a marker is checked against the code. `absentFromCode` answered from
`builtTelemetry`, which is built from `telemetry/spans.ts` alone.

**Reproduced in a full tree copy, both directions.** A new file `src/telemetry/_probe.ts`
containing `({ name: "loom.scheduler.tick" })` → **36/36 green**, with a ninth `loom.*` name
live in `src/` and five documents still hedging it as unbuilt. The identical line appended to
`spans.ts` instead → **34 pass / 2 fail**. Byte-identical code, one directory apart.

**Decision.** `absentFromCode` reads every `loom.*` literal under `src/`, comment-stripped.
`spanNames`, `attrNames` and `builtTelemetry` are untouched, so the eight-span count and the
doc-side checks keep meaning "what `spans.ts` produces" — which is the question those ask.
The premise that makes the two the same set is pinned by its own test with a **named**
allow-list (`loom.token`, `loom.internal`, plus the apiVersion and config filename that were
already there); the obvious version — "no `loom.*` literal outside the tracer" — fails on day
one against a localStorage key, and a guard that fails on correct code on the day it lands is
a guard that gets deleted on the day it lands.

Two more checks landed with it. `ABSENT_CONTEXT_METHODS` is a fourth registry, and the only
one about an INSTRUCTION rather than a description: five places told an author to route
nondeterminism through `ctx.effect(key, fn)`, which has never existed, and a `function`
resource's body is source text compiled by `vm.runInContext` — so there is no typecheck
between the author and the `TypeError`. And any test file the DoD cites as evidence must
exist, which closes the rename and not the row that names no path at all.

**Rejected.** Widening `DESIGN_DIR` to cover `CLAUDE.md`. It is a separate deliberate change
with its own reversal condition — the guard already couples `design/loom/*.md` to `src/`
tightly enough that a code-only commit is red by design, and adding a second normative file
to that coupling doubles it.

**Reverses when.** The `loom.*` literals move out of `spans.ts` on purpose — into a constants
module, or a second tracer. The premise test is the one that fails first, and it names the two
choices rather than a fix, because either is defensible.

---

## Vendoring EAgent: Loom becomes a monorepo

**Maintainer decision, 2026-08-16.** EAgent's source is taken into this repo rather than
referenced. `init` stays frozen at `eagent-v1` and `../eagent-ref` stays readable; vendored
files are copies carrying a provenance header, fixed on the way in.

Three seams were considered and two are recorded as refuted, because they are the obvious
ideas and will otherwise be proposed again.

**Hosted kernel** — Loom injects adapter implementations into EAgent's four registries
(`tools`, `providers`, `hooks`, `capabilities`), which `AgentOptions` accepts. Refuted four
ways, each verified: `ctx.effect` does not exist and invariant 4 says so in bold, yet the
plan routed the provider seam through it; the four registries carry `#private` fields, so
TypeScript types them *nominally* and no structural adapter can be passed at all;
`@eagent/core` is not installable — no committed `dist/`, 404 on npm, `../eagent-ref` absent
in CI, so every phase's `npm run check` was unreachable; and `#invokeTool`, `#runAgent`,
`#gates` are `#`-private with `#dispatch` a hard-coded switch on `NodeType`, so all four
adapters needed new public seams and "core is untouched by construction" — the plan's own
strongest argument — was false.

**Subprocess** — exec `eagent-headless --json` under `runSandboxed`. This one worked: it
preserved every invariant, needed no new machinery (`sandbox/subprocess.ts:552` is already
public and hardened), and EAgent already speaks JSONL on stdout by design (`cli.ts:147`).
It was rejected on cost, not correctness. `scripts/build-binary.mjs:35` bundles
`packages/core/dist/cli.js` only, so the SEA binary cannot contain EAgent — a deployment
using it is two binaries. And Loom cannot gate a subprocess's individual tool calls, so an
EAgent node's posture floor would have to be the `max` over the whole class table.

**Decision.** Vendor the source. It is the only option that permits *fixing* what is taken,
and the fixes are the point: three tool-dispatch paths merge into one, `jiti` goes away, the
parameter property at `capabilities.ts:27` becomes assignments, and nondeterminism comes off
the recorded paths.

**What is NOT vendored: the loop.** Two independent plan reviews converged on this from
opposite directions — EAgent contributes ~320 lines over a `Message[]`, which
`Engine.#runAgent` already is, with journaling, budget reservation, replay, and containment
that EAgent's loop has none of. The value is the 21k LOC of extensions, not the 2.3k-LOC
kernel. What may be ported *into* `#runAgent` is the filter points and `forceTool`, journaled.
Parallel tool waves are deliberately excluded: `engine.ts:1993-1997` derives tool ordinals
from array position precisely so they survive replay, and calls arrival-ordering "invariant
7's failure mode wearing a different hat."

**The intake rule**, fixed before the survey so the survey cannot rationalise around it: an
extension is redundant if the engine already provides its guarantee *durably*. The journal,
`PolicyEngine`, `EventBus`, subgraph nodes, oversight and retry already cover checkpointing,
cost, budget, tracing, sub-agents and recovery. Taking those back would add a second,
in-memory answer to a question the journal already answers — invariant 2's failure mode.
Additive is what touches the world: shell, MCP, search, and the guards over them. Core
already ships `fs.read`/`fs.write`/`net.fetch`/`fs.restore`, so the fs basics are not a gap.

**Rejected: replacing `Engine.#runAgent` with EAgent's loop.** It would trade journaling,
budget reservation and replay for filters and parallel dispatch. The filters can be ported;
the journaling cannot be recovered.

**Reverses when.** If the vendored surface turns out to need EAgent's extension host to be
useful — that is, if the taken files cannot be made to work against `ToolDefinition` without
`ExtensionAPI` — then the subprocess seam is the fallback, and its two-binary cost is paid
deliberately. That is the condition to watch during intake, and it fails file by file, not
all at once.

---

## The context budget bounded a request the model was never sent

Found while checking a vendoring survey's claim that `AssembleInput.turns` is never
populated. It is not, and the consequence is larger than a dead field.

`#runAgent` called `assembleContext` ONCE, before its turn loop, over `system`,
`instruction` and `channels` — the smallest the request will ever be. The loop then pushed
an assistant message and a tool result per turn into the same array that becomes
`req.messages`. So the ladder measured a request the model is never sent, and the request
the model IS sent was unmeasured.

**Reproduced**: an eight-turn loop with 16 kB tool results against a 2,000-token budget sent
~28,000 tokens — fourteen times the bound, no rung fired, no `E_CONTEXT_OVERFLOW`. In
production that failure arrives from the provider as a 400, after the spend.

Three defects were tangled here, and the second is why the first stayed invisible:

1. The budget did not bound the transcript.
2. `AssembleInput.turns` and `.retrieved` are declared and passed by nobody, so rung 3 — the
   one rung that is a recorded Effect — operated on a section that was always empty. The
   `summarize` effect kind invariant 4 names was unreachable in a live run.
3. `#summarizeEffect` keyed on `effectKey(taskId, "summarize", 0)` — a FIXED ordinal. Safe
   only while (2) meant it never ran twice; the moment folding happens per turn, every
   summary in a task collides on one key and replay serves whichever was recorded last.

**Decision.** `boundTurns` in `run/context.ts` folds the transcript per turn, and the cut is
only ever *before* an assistant message. That is correctness, not tidiness: a `tool` message
whose `tool_call_id` names a call no longer present is rejected by the provider, so the fold
point walks to the next assistant boundary rather than cutting where the arithmetic lands.
`messages[0]` — the instruction envelope — is never folded. The fold is in place, so a prefix
summarised on turn 3 stays summarised on turn 4 rather than costing a model call per turn to
recompute the same summary under a different key. A tail that alone exceeds the window raises
`E_CONTEXT_OVERFLOW`, the same verdict `assembleContext` reaches for the same condition.

**A second, independent defect found by the repro.** `MockModelAdapter.seen` pushed `req` by
reference, and `#runAgent` mutates `req.messages` in place — so every test asserting about
"the request at turn N" was reading the state at the LAST turn. First and last both reported
28,022 tokens on a loop that demonstrably grew. Now snapshotted one level deep.

**Rejected: adding `loom.subgraph` and `loom.summarize` spans.** Correcting the durable
`kind` field tempted a matching telemetry change, which `docs-drift` correctly refused —
it would have grown D9.1's span taxonomy from eight as a side effect of fixing a journal
field. `summarize` rides with `model` in telemetry because it *is* a model call. The guard
also taught the rule: it reads a span name as a `loom.*` literal following `name:` **on the
same line**, so a lookup table hides every name from it. Kept inline.

**Reverses when.** A model appears whose tool-result pairing rules differ enough that
"cut before an assistant message" is no longer sufficient — then the boundary rule needs the
provider's own constraint, and `boundTurns` needs to take it as an argument rather than
assume it.

---

## An autonomous pass over the remediation queue

Seventeen commits, run without check-ins at the maintainer's instruction. What is worth
keeping is the pattern in what turned out to be true, not the list.

**Four claims in the queue were refuted rather than fixed.** `resultDigest` "written at four
sites and read by none" is read — `replay.ts:160` compares it and raises
`E_REPLAY_DIVERGENCE`. `budget.reserved`/`budget.settled` "have no producer" was already
known and registered in `NEVER_APPENDED` with reasons. `--models-file` was "untested" because
I grepped `test/cli/cli.test.ts` and the coverage is in `test/cli.test.ts` — seven tests,
including one asserting on the HTTP bytes. And `usage` was going onto a registry as an
eleventh escalation rule; there are ten, and the name came from a different object literal in
the same file. **A queue carried forward across compactions decays**, and the check is
cheaper than the fix.

**The write-confinement hole was the severe one.** `node.writes` is what GRAPH010, the
posture floor and `dataClassification` are all computed over, and two of the four node paths
did not enforce it: `#runFunction` and `#runEvaluator` returned `{...out.writes}` raw. A node
declaring `writes: ["mine"]` committed `secret`. Confined in `#dispatch` rather than at those
two sites, on invariant 6's argument — a check applied per-caller is a check the next node
type forgets. The whole suite passed unchanged afterwards, which is the evidence that the
rule was already the intended contract everywhere and only the enforcement was partial.

**Three defects were found by writing a repro rather than by reading.** The context budget
bounded a request the model was never sent (~28,000 tokens against a 2,000 budget, fourteen
times over) — and the probe for it found a second, independent defect in the test
infrastructure: `MockModelAdapter.seen` pushed `req` by reference while `#runAgent` mutates
`req.messages` in place, so every test asserting about "the request at turn N" was reading
the last turn. `scale.test.ts` asserted on a wall-clock ratio and failed only under parallel
load; best-of-N fixed it, because interference can delay a run but never make it finish
faster.

**Two attempts were stopped and recorded instead of pushed through.** Auto-retiring a
terminal run looked obviously right and turned two failures into eleven; the honest move was
to ship `forget` as a manual call, record precisely what blocked the automatic version, and
come back to it — which is what happened three commits later, once `openGates`,
`openGateBatches` and `rewind` no longer needed a live context. Rewind was the interesting
one: it looked like a refactor and was not, because the only thing needing a context was an
incremental fold that a rewind has just invalidated anyway.

**A guard found twelve real disagreements on its first run.** Absorbing `verify-type-equiv`
from deepseek-harness — comparing each `ts` block in `design/loom/` against the named
declaration, member by member — turned up three kinds: members described and absent (now
marked and registered), members whose optionality differed (the document was wrong), and a
rename the design missed. Two design decisions inside it are worth keeping: a document may
be INCOMPLETE and may not be FALSE, so a member the code has and the design omits is not
drift; and inherited members count, because a first version reported nine of
`ToolDefinition`'s as missing by not following `extends` — the guard's own bug, reported as
the code's.

**One thing was almost repeated.** `runSandboxed` had sat in this tree with zero callers,
which is what `proc.exec` was written to fix — and then `McpClient` shipped with nothing
constructing it. Wired in the next commit. A capability nothing calls is indistinguishable
from one that does not exist.

**Reverses when.** The MCP scope (tools only, stdio only) is the part most likely to need
revisiting: the moment a server worth using offers only Streamable HTTP, the transport seam
has to exist, and it should be added as a second transport behind the same client rather than
as a second client.

---

## Who started the run, and who stopped it — and why they live in different places

A4 asked one question — "who started this run that spent money, and who cancelled it" — and
the answer turned out to need two mechanisms rather than one. Both are journaled; they are
journaled in different halves of the event, and the split is the decision worth recording.

**The submitter is PAYLOAD.** `run.submitted` is appended BY the control plane on a
principal's behalf, so `actor: SYSTEM_ACTOR("control-plane")` was never wrong — it is the true
answer to "what wrote this row". The principal is a fact *about the run*, which is the shape
`gate.raised.approvers` already has for the same reason. Moving it to the envelope would also
have meant widening `Actor`: its human arm REQUIRES `via`, a channel a `service` principal has
none of, and `SYSTEM_ACTOR` is single-arg so it cannot carry `method` either.

**The canceller is ENVELOPE.** A cancel is caused by its caller directly, so the event's own
`actor` is the honest home, and `projection.ts`'s `gate.decided` arm is the precedent — *"The
EVENT's actor, not the payload's — there is no actor in the payload and there must not be
one."* A reviewer read the split as unprincipled and was half right: the representability
problem exists on both sides, because a *service* cancelling through the API has no `via`
either, and nothing said what it should be journaled as. It does now. A named service
principal IS a system component in `Actor`'s vocabulary, so it becomes
`system:principal:<subject>`. The prefix is load-bearing: without it a deployment could
configure a service subject called `gate-broker:timeout` and forge that component in the audit
trail, and `GATE_SYSTEM_ACTORS` holds no `principal:*` so the actor grants nothing anywhere.

**An unidentified caller is still `system:operator`, unchanged.** `(shared-token)` and
`(unidentified)` describe what the perimeter concluded rather than naming anybody, so
`principal:(shared-token)` would claim a principal by that name. "An operator did it" is the
most that can honestly be said, and it is what this path already wrote.

**The fold is first-wins, because a read model that disagrees with itself is worse than one
that is stale.** `run_head.submitted_by` (next phase) is written on the row-creating INSERT and
never on the update, copying `first_ts`'s shape so no later append can rewrite an owner. If the
fold took the LAST `run.submitted` instead, the list route (reading the column) and the detail
route (reading the fold) would answer differently about who owns a run — in the one field that
decides access. Reachable from an embedder re-submitting an explicit `runId`.

**`loom run` fabricates nobody, and that is a refusal rather than an omission.** The obvious
move was to reuse `subjectFlag`, which already exists and already refuses synthetic markers.
It also defaults to the literal `cli`, and as an *owner* that default is three defects at once:
it journals a human named `cli` that a graph could then list in `approvers`; it collapses every
CLI-submitted run in a deployment onto one owner; and it takes those runs out of the permissive
unowned set that exists so an upgrade loses nothing. So `--as` supplies a principal and its
absence supplies none. The CLI authenticates nobody — it writes to the journal directly — and
inventing a principal is exactly the synthetic-subject failure the perimeter refuses one door
over.

**A delegated run belongs to whoever started the parent.** The child inherits, rather than
getting a synthetic `(subgraph)` subject or nothing. A synthetic subject would be a name that
matches nothing while reading like one that does; absent would make the half of a workflow
where the irreversible work usually lives invisible to the person who caused it and permissive
to everyone else.

**The audit projection needed a field, not just an arm.** The first version of this was "one
arm, one `AuditKind` member", and a reviewer showed it could not answer its own question:
`AuditRecord` carries exactly one identity field, `actor`, and for `run.submitted` that is
`system:control-plane`. The audit store would have answered "who started this run that spent
money" with "the software did", which is the one answer an audit trail exists to make
impossible. `AuditRecord.principal` is the fix, and it is absent on every kind where `actor`
and the principal coincide.

**The optional field is fail-open, and the mitigation is a registry rather than a type.**
`SubmitInput.submittedBy` is optional and an absent principal is the PERMISSIVE case, so a
`submit` call site that forgets it mints a world-readable run with nothing red. The strong fix
— a required field with an explicit `{kind:"unowned"}` member, so forgetting is a type error —
was rejected because it breaks every embedder for a feature they may not use.
`test/run/submit-callers.test.ts` stands in its place: it greps `src/` for `.submit(`, and a
new door fails it until somebody writes down, in words, who owns the runs that door starts.
It is the shape `docs-drift.test.ts` already uses for the same kind of question.

**Reverses when.** The registry test is the weak part and it knows it: it proves that every
call site has been *considered*, not that any of them is right. If a third-party embedder ever
matters more than the two internal callers, the honest move is the required field with the
explicit `unowned` member and a major version — at which point the registry test is deleted
rather than kept as a second, weaker answer.

---

## Two review findings that the first version of A4 got exactly backwards

Both diff reviewers found the same two defects independently, and both were cases where a
COMMENT asserted a property the code did not have. That is worse than an uncommented bug: the
comment is what a later reader checks instead of the code.

**"First wins" was "first NON-EMPTY wins".** The fold guarded on `p.submittedBy === undefined`,
which reads as "have I already decided" and behaves as "have I already found somebody". So a
run whose FIRST submission named nobody could be adopted by a later one — and "the first
submission named nobody" is not the exotic case, it is the common one: every pre-upgrade
journal, and every `loom run` without `--as`. The read-model column the next phase adds writes
on the row-creating INSERT and never on the update, so it would have held NULL while the fold
named a principal: the list route and the detail route disagreeing about who owns a run, in the
field that decides access — precisely the divergence the comment was written to prevent. The
guard is now `sawSubmitted`, a boolean that records that the QUESTION was answered rather than
that the answer was somebody.

**A rewind reached the audit tier through nothing.** `cancel` appends `operator.command` and
lands in `extractAudit`'s existing arm; `rewind` appends only `checkpoint.restored`, and there
was no arm for it. So the actor A4 threads into `rewind` reached the journal and stopped there,
while a comment three lines up claimed both stops were covered. It matters because the audit
tier is a separately stored `Infinity`-retention duplicate, kept so "who did what" survives a
journal retention change — with `pruneJournal` configured, "who rewound this run" was the one
A4 fact still destroyable. Reproduced by construction before fixing: two events in, one audit
row out.

**The registry test was keyed by FILE and claimed to be keyed by call site.** Its whole job is
to stand in for a required field, and a second forgetful `submit(` inside a file already on the
list passed it green. It now pins a COUNT per file, and the count was watched failing before it
was believed. It also stopped shelling out to `grep` — it was the only test in the repo that
did, which made it the only one that fails on a machine without the binary, and the `-a`
reasoning it needed for non-ASCII files evaporates when the file is read in-process.

**A dead branch whose value is the permissive one is a fail-open waiting for an unrelated
edit.** `...(auth === undefined ? {} : {submittedBy: …})` was unreachable — `#serve` answers
401 first — and its dead arm recorded no principal, which is the world-readable value. The day
`/runs` joined the unauthenticated carve-out it would have minted open runs with nothing red.
It is now `mustAuth(auth)`, which throws rather than defaults.

**And a body that claims a principal is refused rather than ignored.** `#decider` already makes
this argument for a claimed gate approver — *"a client that sends `actor` believes it is writing
the audit trail; ignoring it would leave that client confidently wrong about what the journal
says"* — and the first version cited `#decider` as its precedent while taking the opposite
treatment. Refused even when the claim AGREES with the credential, which is stricter than
`#decider`: there, `actor` is a client restating who it is; here it would be a client asserting
a field the perimeter owns.

**Reverses when.** `CommandActor` narrows `cancel`/`rewind` to a person or a component, which
excludes `agent` and `evolution` on the argument that neither cancels a run. If an evolution
candidate ever needs to stop its own trial run, that is the line to widen — and the widening
should carry the same `principal:`-style prefixing, because the reason the union is narrow is
that a public door accepting any `system` component lets an embedder journal a cancel as
`gate-broker:timeout`.

---

## A run belongs to whoever started it, and two predicates rather than one

A3 was the oldest open security entry: every valid credential was a full operator credential.
The fix it prescribed — a durable owner, folded into a read model, with a designed escape —
is what landed. What the prescription did not anticipate is that **one predicate is not
enough**, and getting that wrong would have closed A3 by breaking the thing A3 protects.

**`ownsRun` and `mayReachGates`, and the gap between them is the design.** Owner, unowned or
operator governs the four `#runs` routes. The two routes that carry gates add one term —
*named on one of this run's gates* — because under `separationOfDuties` the only principal
permitted to decide is by construction **not** the submitter. A rule without that term makes
every gate it guards unanswerable: supervision that looks configured and cannot be exercised,
which is the failure D7.9 calls the worst available. The converse is equally deliberate: being
named an approver is a grant to answer one question, not a key to somebody's run, so it widens
neither `GET /runs/:id` nor the command route.

**NAMED, never "not excluded".** A gate that names nobody is answerable by whoever reaches it,
and the dominant gate class — a posture-floor gate on a tool node — names nobody by
construction. Reading that as "visible to everybody" would have published the node's readable
channel values, inside the gate's rendered payload, to every principal in the deployment: the
disclosure A3 exists to close, re-opened by the fix for A3. The predicate is an explicit
`some` over gates naming the caller, so a run with NO gates admits nobody through that term
rather than being vacuously true — which is the same "absence is not zero" the Traps list
already records twice.

**And the approver still has to FIND the question.** `GET /runs` is scoped to the submitter
and answers from the owner column with no fold, which is what keeps a 4-second console poll
from folding every run in the journal — and it means an approver sees an empty list. So
`GET /gates` was added: the cross-run queue, returning the questions ADDRESSED to the caller,
**with the rendered payload**, because `GET /runs/:id` is closed to them and this is therefore
the only place the question can reach the person being asked. A stranger's queue excludes an
unrestricted gate: answerable-by-whoever-reaches-it must not become published-to-everyone. The
console reads it as an "Awaiting you" panel and answers in place — routing through `select()`
would need `GET /runs/:id` and would render a panel whose buttons 404.

**`(shared-token)` is an operator only when it is the SOLE credential.** `#principal` tries the
identity source first and falls back to the shared token, and this file documents the mixed
arrangement — Alice her own token, the CI job the shared one — as supported. An unconditional
grant would therefore have handed every service in such a deployment a full read of every
human's runs and gate payloads, through a fallback nobody configured. Alone, the grant changes
nothing: every caller is that principal, owns every run, and scoping is vacuous — which is what
keeps the single-token deployment byte-for-byte what it was.

**"Nobody" includes a SYNTHETIC owner.** The HTTP door records whatever the perimeter
concluded, so an open plane stamps `(unidentified)` and a shared-token plane `(shared-token)`.
Those are coherent while the plane stays as it is and incoherent the moment identities are
configured — the runs would be owned by a subject no principal can present and would leave the
permissive set all at once, which reads to an operator exactly like a wipe. `ownedByNobody` is
the one place that rule is spelled, and it is why the CLI's "record nothing" and the HTTP
door's "record a marker" do not have to agree.

**The migration would have bricked every process after the first.** `#migrate` stamps
`schema_version` only in its bootstrap arm, so an existing file reads its old version forever:
an `ALTER TABLE` placed where the file says migrations go re-runs on every open, and the second
one throws `duplicate column name` out of the constructor. Found by a plan reviewer, reproduced
before fixing, and pinned by a test that opens a hand-built v1 journal three times — the second
open is the one that used to die.

**And the filter is in SQL, before the LIMIT.** Selecting the newest N and filtering in JS
answers a different question: a principal with few runs on a busy deployment gets an empty
list, and the number that survives varies with `limit` in a way that measures how often OTHER
principals submit.

**Reverses when.** `GET /gates` folds every candidate run, bounded by `limit` — the same shape
and bound `GateSweeper` already pays on a timer, and the console polls it every 4 s. If a
deployment's journal makes that cost real, the answer is a denormalised open-gate index beside
`run_head`, not a narrower queue: the queue is what makes an approver able to work at all.

---

## The Phase 2 review, and the rule that shipped backwards for one commit

Two diff reviewers, two lenses. Five blocking findings, all real, all reproduced before being
fixed. Three are worth keeping.

**A synthetic owner is a REAL owner, and reading it as "nobody" was an escalation.**
`(shared-token)` and `(unidentified)` describe what the perimeter concluded rather than naming
a person, which is a good argument for treating them as unowned and a bad conclusion. On a
MIXED plane — a shared token *and* per-subject identities, which this codebase documents as
supported — every run the CI service submits is owned by `(shared-token)`, and "unowned" is
the permissive case. Measured: a human credential listed **zero** runs, read the service's run
**200**, and **cancelled** it. A cross-principal write, arrived at from a rule written to
prevent a cross-principal read.

Reading them as owners costs nothing where they are minted, which is what makes it the right
answer rather than merely the safe one: on an open plane every caller *is* `(unidentified)`,
and a sole shared token is an operator anyway, so both of those deployments are byte-for-byte
unchanged. What it costs is the upgrade — a plane that was open and is then given identities
keeps those runs for its operators — and that is the side to be wrong on.

**And the third answer had to exist.** `nobody` is permissive; `unreadable` is not. A journal
is an input, so a `submittedBy` whose subject is not a non-empty bounded string is refused
rather than read as unowned — otherwise a malformed row is world-readable. It also used to
*throw*, out of a helper shared by every scoped route, which took the cross-run approver queue
down for the whole deployment on one bad row. Same asymmetry the gate layer already carries for
an empty `approvers` list, one question over.

**A door that refuses a read and then performs it in the response to a write is not a door.**
`POST /runs/:id/gates/:gateId` answered `summarise(p)` — channels, outputs, usage, every task
and every gate — to a named approver who is 404'd on `GET /runs/:id` and gets a per-gate
filtered list from `GET /runs/:id/gates`. Every other check on that route was decorative while
it stood. The reply is now scoped like the reads.

**A queue bounded by the wrong UNIT is a denial of the thing it exists for.** `GET /gates` took
an uncapped `pageLimit` and spent it on RUNS. Two failures at once: `?limit=<huge>` folded the
whole journal on a route the lowest-privilege credential can reach, and a question addressed to
an approver vanished as soon as fifty newer runs existed — invisible in the console, with no
error, in the route added so that ownership would not hide approvals. It is now bounded by
GATES, with a hard scan ceiling and a `truncated` flag, because a queue that admits it is
incomplete is worth more than one that silently is.

**Two routes over one set of gates must not disagree about who sees them.** `visible()` on the
per-run route admitted an unrestricted gate to any caller who reached the run, while `/gates`
excluded it from every stranger's queue — the same question answered two ways in one commit.
"Answerable by whoever reaches it" is about DECIDING and says nothing about publishing; the
narrower answer is the right one at both.

**What the reviewers proved was fine is worth as much as what they broke**: the migration is
concurrency-safe (144/144 clean opens across 12 concurrent processes), the idempotency slot
cannot cross principals, 404-never-403 holds on every scoped route with identical bodies, and
the four `submit` doors are exactly what the registry says.

**Reverses when.** `mayReachGates` admits a named approver in ANY gate state, not only `open`.
Requiring `open` was tried and it turns a second approver's 409 into a 404 — two people named,
one decides, the other is told the run does not exist rather than that the question is
answered. If gate-naming ever becomes attacker-influenced at scale (see `graph:mutate` in the
HANDOFF), narrow it then and accept the worse conflict diagnostic.

---

## Separation of duties, and the four ways to a rule that enforces nothing

D7.2 said support for the unimplemented approval modes "is added by deleting a check". This
is the first time that sentence has been exercised, and what it turned out to mean is: delete
one check, add a narrower one, and then spend most of the work on the ways the rule can be
present and toothless.

**The rule is RESOLVED AT RAISE, not evaluated at decide**, and that is the decision the rest
follows from. `#authorize` reads "`gate`, the FOLD of `gate.raised`, and nothing else" — a
deliberate invariant, because an authorization input that can be silently empty is a check
that passes by default, and the broker's memory is empty in every process that did not raise
the gate. So the exclusion is computed once from `run.submitted.submittedBy` and journaled on
`gate.raised.excludedApprovers`. It states the DECISION rather than its inputs, which is
exactly what `approvers` does one field over, and it buys three properties for free: it
survives a restart, it replays unchanged, and a process that never held the run can still
enforce it.

**Five builders, and the fifth is the one a reader forgets.** `GateRequest`, the payload, the
fold, `GateRecord` — and `prospectiveRecord`, the record `#validate` is handed on the dedup
path. Because the field is optional, omitting it there is silent, and it is precisely the
bypass: an SoD gate would compare EQUAL to a non-SoD one under `sameAuthority` and inherit its
decision in the append that raised it, from the person the rule bars. `sameAuthority` gained
the term, which covers dedup and batching together because both ask it.

**Four refusals, because a gate that reads as supervised and bars nobody is worse than no
gate at all.** The obvious one is "no principal recorded". The other three are not:

- **a service, or a perimeter marker.** `(shared-token)` and `(unidentified)` name credentials
  and conclusions, not people; excluding either bars a subject no human actor can present, so
  the gate is journaled as supervised and answerable by everyone, initiator included.
- **a gate whose only named approver IS the initiator.** No compile-time check can see this —
  `approvers` is static in the spec and the initiator is a runtime fact — and `raise` holds
  both. Without it the run parks on a question nobody can ever answer.
- **and, at COMPILE time, `separationOfDuties` with no `approvers`**, which would read as
  "everybody except one person". `GRAPH014_APPROVAL_INCOMPLETE` — a check added in the same
  change that deleted one, because the rule NARROWS a list and does not stand in for one.

**The refusal is an OUTCOME, never a throw**, and this is the part that would have been a
production incident. `#commit` — where `raise` is called — runs outside the try/catch that
turns an exception into `{status:"failed"}`; that catch wraps `#executeTask` alone. A throw
from the raise path escapes `advance()` with the task still `leased`, and every later
`advance` re-leases it, re-executes, and throws again: the run never terminates and the
command answers 500 forever. Caught by a plan reviewer before a line was written, which is the
argument for reviewing plans.

**The claim door is narrower than the decision door, again.** A claim grants nothing, so the
exclusion there is not authorization — it is about what a claim SAYS. Letting the one person
who provably cannot decide hold it tells the approvers that somebody is looking, which is the
single thing a soft lock must never do falsely.

**And the carve-out that makes replay work is a KIND, not a subject.** The arm fires only for
`human` actors. A `system` actor reaching it has already passed `isAuthorizedActor`, which
admits exactly `GATE_SYSTEM_ACTORS` — the replayer, the timeout's default action, the dedup
inheritor — none of which is a person who could be the initiator. What replay actually needed
was the recorded principal threaded into the shadow run, and not for authorization: without it
the RAISE refuses, so `replayRun` throws instead of reporting.

**Reverses when.** The exclusion is a one-element list because the initiator is one principal.
Quorum and delegation are still compile errors, and both would widen it — a delegate is a
second subject the rule has an opinion about, and `mustStayInGroup` needs the identity resolver
`approvers` is already waiting on. The list shape is what makes that a widening rather than a
rewrite.

---

## The Phase 3 review: five holes, and one claim that would not reproduce

**A truthy string is not `true`, and every test in the feature was `=== true`.** So
`separationOfDuties: "true"` compiled clean, resolved no exclusion, and the initiator approved
their own run — the exact failure `checkApproval` exists against, reached by declaring the
rule. Not contrived: the canonical on-disk form is JSON and nothing type-checks it on the way
in, and YAML 1.2 reads a bare `yes` as the STRING. `checkSla` sixty lines below already makes
this argument for `onTimeout`; the new code makes it for `separationOfDuties` and for
`delegation.allowed`, which had the identical hole and where "read as absent" means the
UNSUPPORTED refusal never fires either.

**The mirror's inherited exclusion was a security control with no test.** Deleting the line
left all 1726 tests green, and a probe showed what that bought: the initiator approves the
parent's mirror and `executor:subgraph` forwards the approval into a child gate whose own
`excludedApprovers` names them — the rule enforced one run away from the decision, which is
nowhere. It is the same hole `THE CHILD'S APPROVERS BIND THE PARENT'S MIRROR GATE` was written
against, one field over, and it now has the twin test it should have shipped with.

**Two of the new tests did not test what they were named.** The replay test never called
`replayRun`; it read the journal and asserted a payload, which is true of a run nobody
replays. The dedup test started two unrelated runs and compared a field on two gates that
never meet. Both are rewritten, and both now go red when the mechanism is removed. The second
one also corrected the claim: within one run and one node the exclusion is constant, so the
DEDUP half is embedder-only — **batching** is the engine-reachable consumer, because `batchFor`
asks `sameAuthority` with no `nodeId` term. Two `human_gate` nodes sharing a policy and a
batching key are merge candidates, and merging across the rule produces one question the
initiator can never answer.

**Three doors that only the ENGINE kept shut.** `raise` is public: it accepted
`excludedApprovers: []`, which journals a rule that bars nobody and which `shownGate` renders
to a human as "these people are barred: nobody" — the thing its own comment says cannot
happen. And a pre-authorized `defaultAction` let the clock approve what the rule forbids,
because the humans-only carve-out that makes replay work is a carve-out for `gate-broker:
timeout` too. Both are refused at the raise now, beside the other "this gate cannot mean what
it says" checks. The third was the reads: `sodRefusal` took `p.submittedBy` bare, so a journal
carrying `null` or a numeric subject exited as a raw `TypeError`, and an EMPTY subject
produced `excludedApprovers: [""]` — present, journaled, and toothless.

**And one claim did not reproduce, which is recorded rather than quietly dropped.** A reviewer
reported that a refused SoD gate takes an `error` edge and lets the run report `succeeded`
with no gate on the journal. The fix — `E_GATE_REQUIRED` in `RUN_FATAL_CODES`, beside a
breached budget and a replay divergence — is right on its own terms and shipped: an action
that requires a decision nobody can give is not something a graph should route around. But two
attempts to reproduce the recovery, an error edge to a node writing the graph's output and one
to a node writing its own channel, both ended `failed` with the recovery node never activated,
identically with and without the fatal listing. So the test pins what is demonstrable — the
code, and that NO gate row exists, which is what makes this worse than a rejection — and this
paragraph is the honest state of the routing claim. **A test that passes for a reason it
cannot name is the thing this file keeps warning about**, and writing one to close a finding
would have been the worse of the two mistakes.

**Reverses when.** `E_GATE_REQUIRED` was declared and raised by nothing since the vocabulary
was written; using it closes one of C2's thirteen and is why the `NEVER_RAISED` registry moved.
If a graph ever needs to recover from an unsupervisable gate deliberately — a fallback that
routes to a stricter, non-delegated path — the fatal listing is the line to reconsider, and the
replacement is a distinct code rather than making this one routable.

---

## Four minutes as a user, again — and the prompt is a pointer

The habit at the bottom of `HANDOFF.md` says every wave of this build found its real defects by
running a NEW SHAPE of thing, and names "four minutes as a user, copying the binary into an
empty directory and hand-writing a graph" as the one that found the tool-channel bug three test
workflows structurally could not. It worked again, and this time it found the biggest thing in
the build.

**What the smoke test was for.** After the ownership chain landed I drove it through
`bin/loom` rather than through the suite: boot with an identity file, submit as one principal,
check another cannot see it. That all worked — the new boot warning printed, the owner listed
one run, a named approver listed zero and got 404 on the run while `GET /gates` handed them
exactly their question, an operator saw everything, and the answer to the write was the
four-key scoped body rather than the fourteen-key summary. Separation of duties refused the
initiator BY NAME through the CLI and let the co-approver through.

**Then I wrote an agent node, because the goal at the top of `CLAUDE.md` says a user should be
able to.** `prompt: "Say the word ready"` is `GRAPH015_RESOURCE_NOT_FOUND` — `RESOURCE_REF` is
`[a-z_]+/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+`, so the field cannot hold a sentence. Written the way
the corpus writes it, `prompt: prompt/say-ready@stable`, it compiles and runs — and the model
receives the string `prompt/say-ready@stable`. Not a rendering of it. It.

`ResourceResolver.resolve` returns `{ref, digest, channel}`, which `CLAUDE.md` already states
plainly — "a pin, not a document" — and which is exactly right for `humanGate.ref`, where
proving a policy exists and pinning its bytes is the whole job. Nobody carried the sentence one
node type over. `#runAgent` interpolates `agent.prompt` into the instruction and the user
message; `promptOverride`, the one parameter that could carry text, has a single caller, the
evaluator, which passes `ev.ref` — another ref. `agent.profile` never reaches the request except
as the model routing key, and the system message is a hard-coded
`` `You are node ${w.node.id}.` ``.

**What makes this worth an entry rather than a bug report is how well everything around it
works.** The provider adapters are not stubs: an invalid key routed through
`agent_profile/basic@stable` produced `loom.model [error] 1152ms` — a real round trip to a real
API and a real 401. The graph compiled with useful diagnostics, the run journaled, the gate
gated, the ownership scoped, the SQLite store survived restart. Every layer between a user and
a working agent is built except the one that turns a name into words, and a build whose every
component works is the hardest kind to notice a hole in.

**The lesson is the one the file already had, and it took the harder form this time.** The
previous four-minutes-as-a-user finding was a bug — tool writes routed onto channels no graph
could guess. This one is an ABSENCE, and absences do not throw. `[mock] {"prompt":"prompt/
say-ready@stable"}` is a successful run. It is only wrong if you read it.

**Reverses when.** A `ResourceStore` with a content hook lands — the shape `subgraph(ref)`
already has. At that point A22 closes and `packages/skills/` (library-as-data, already named as
the likely first package) is the same question wearing a different hat: both are "where does the
text live, and who is allowed to open it".

---

## The prompt became a document, and the churn chose the design

A22: an agent node's prompt was its ref. `#runAgent` interpolated `agent.prompt` verbatim, so a
model received the eleven characters `prompt/x@stable` where its instruction belonged. It
survived the whole project because **a run that sends a pointer succeeds** — nothing is red, the
output is plausible, and it is only wrong if somebody reads it.

**The plan said run time and the churn said compile time, and the churn was right.** A
`document(ref)` hook on the resolver failed 32 tests across 12 files, every one of them the same
shape: *this Engine has no resolver*. `grep -c 'new Engine('` over the suite is **54** and almost
none passes one, while every `compile` call site does — because a resolver is how you compile a
graph, not how you run one. A prompt that needed the engine's resolver would have made every
engine construction a resource deployment. Moving the read into `compile` took the failures from
32 to **1**, and the one was the CLI test that needed the loader the wave existed to build.

It is also the stronger reading of the pinning rule rather than a weaker one.
`resources/functions.ts` already records what a run-time `resolve(ref)` costs — "a promotion
between compile and execute swapped the body underneath the Run" — and freezing the bytes into
`RunGraph.documents` beside the manifest makes that unreachable rather than merely guarded.

**Three things the review found that the build had wrong, and the third is the one that
matters.**

- **`req.system` is built at a different site from the one `assembleContext` is handed**, and
  only the second reaches a provider. Setting the one the ladder measures changed nothing a
  model saw; the test caught it by asserting on the posted bytes rather than on the intent.
- **The document was counted twice.** `system` already contained it and `instruction` was passed
  the same text; both sections are INVIOLABLE, so `E_CONTEXT_OVERFLOW` fired at half the real
  budget — a 1,000,000-character document reported `tokensBefore: 500008`, exactly 2×. And the
  other way round, `system` sat outside `boundTurns` entirely: **127,513 tokens posted against a
  100,000 budget, run `succeeded`** — verbatim the defect `boundTurns` was written to close,
  reopened because the field used to be eighteen characters wide.
- **A run could write the next run's system prompt.** `resources/` is inside the jail root and
  `fs:write` is granted unconditionally, so a `tool` node writing `resources/prompt/p.md`
  SUCCEEDED and the next boot served "PWNED: ignore all prior instructions." as that node's
  system message. Durable prompt injection, reproduced through the built binary.

**And the half I noticed was the wrong half.** The loader refuses symlinks, and the docstring
reasons carefully about the jail while doing it — a run cannot plant
`resources/prompt/x.md -> /etc/passwd` and have it read. That is the READ direction. The WRITE
direction, a run authoring what the operator is understood to have said, was left open in the
same function that argued about the jail. Reasoning correctly about a boundary and then guarding
one side of it is a shape worth naming: the guard looked considered, which is what stopped
anyone looking further.

**Reverses when.** Documents are text and `@stable` is whatever the file says, seeded through a
named door rather than through `publish`/`promote` — because `publish` lands on `@draft` and the
hop to `@stable` refuses a non-human, and minting a fake human at boot would defeat exactly the
guard's argument. If prompts ever need versions an operator can roll back at run time, that is
the moment the workspace stops being the source of truth and the store's ladder becomes the
answer instead.

---

## A deny-list is advisory until the directory exists

Wave 2 published child graphs so a `subgraph` node could finally run through the binary. Its
review found two ways in, and the first is the more interesting because the guard it defeats was
written one commit earlier, deliberately, with a docstring arguing about exactly this boundary.

**`assertWithin` canonicalises a deny entry with `realpathSync.native` — and `realpath` can only
canonicalise a path that EXISTS.** `openWorkspace` creates `.loom/` and `graphs/` and did not
create `resources/`, so on a fresh workspace the deny comparison fell back to a lexical one and
`RESOURCES/prompt/p.md` walked straight past it on any case-insensitive filesystem — the default
on macOS and Windows. Measured through `bin/loom`: the write succeeded, the directory it created
*was* `resources/` for the next boot's `readdirSync`, and the run after that was handed
"PWNED via case" as its system prompt. The same trick reopened arbitrary GRAPH injection through
`resources/subgraph/`, which is strictly worse — no model is in the loop, the child simply runs.

`.loom/` was never exposed to this for one reason: it is always `mkdirSync`'d. The fix is one
line beside it, and the lesson is that **a path-based guard has a precondition nobody states —
the path has to be real.**

**And my own regression test hid it.** The prompt-injection test written the commit before
creates `resources/prompt/` in its fixture before writing the graph, so the directory existed
and the deny worked. The test passed for a reason it did not claim, and the new sibling
deliberately does NOT pre-create the directory — which is the whole difference between the two.

**The second way in was a missing shape check.** The spec branch was a bare `JSON.parse` and a
cast, while the YAML half already refused a non-mapping, so the two spellings of a child graph
disagreed about what counts as one. `null` came through and passed the executor's
`childSpec === undefined` guard; a file holding a bare JSON *string* came through and was served
to a model as a system prompt, because `ResourceStore.document` type-checks the CONTENT and not
the kind. The commit message claimed specs were "parsed with the same reader `loadGraph` uses" —
`loadGraph` goes through `readSpec`, which refuses array, null and scalar and names the file. The
claim was the design; the code was one function short of it.

**Reverses when.** The shape check is `typeof === "object" && !== null && !Array.isArray` at the
loader, duplicating `readSpec` rather than calling it, because `readSpec` also throws with a
filename and this path must SKIP. If a third loader appears, that is the moment the two become
one helper with a `mode` rather than a third copy of the same three predicates.

---

## The third content kind, and the extension that looked obvious and starved the child

A22 froze prompts into the compiled graph; A23 made child graphs publishable; A24 is what was
left — `#runSubgraph` still asked a resolver for the child SPEC while a Task was executing. The
parent's compile now walks the subgraph tree and freezes every reachable child into
`RunGraph.subgraphs`, reusing the cycle set and depth bound the validator already applies so a
graph it refuses cannot make the collector loop. `grep -an '#resolver\.' engine.ts` is now empty.

**I measured one change and drew a conclusion about a different one, and it shipped.** If the
parent freezes the tree, should the child compile against the frozen view or against a live
resolver? I replaced the resolver WHOLESALE, watched **38 tests** fail — a child's own
`function/…` and `prompt/…` refs are not in the PARENT's manifest — and concluded that the
child's compile must keep the live resolver. The measurement was real. The conclusion covered a
change I never ran: overriding the ONE hook the parent has an answer for,
`{...resolver, subgraph: (r) => frozen[r] ?? resolver.subgraph?.(r)}`, costs **zero** failures.
A reviewer tried it and the whole suite stayed green.

So the freeze stopped at depth 1. `#compileChild` runs inside the executing parent Task, so the
GRANDCHILD spec was still read from the live resolver mid-run — verbatim the swap the entry
exists to prevent — and every deep entry `resolveSubgraphs` gathered was dead code that nothing
read. Reproduced with a promotion between the parent's compile and its execution: the promoted
grandchild ran.

**The lesson is not "test the fix", it is "a negative measurement is about the thing you
measured".** "Replacing the resolver breaks 38 tests" is true and says nothing about narrowing
it. I wrote the number into a source comment, the register and the journal, where it read as a
refutation of the whole direction — three places all confidently wrong in the same way, because
each was copied from the first rather than re-derived.

**And the cache had to move with the spec.** `#compileChild` was keyed by ref under a docstring
saying "the tree is fixed, so the cache never stales". It stopped being fixed the moment the
spec came from a per-run `RunGraph`: two runs on one `loom serve` process with different frozen
children for one ref both got the first one's compiled graph, so the freeze bound only the first
run per process. A cache key that encodes an assumption outlives the assumption silently.

**A2 turned out to be stale, and what was left was a field that lied.** The entry says the
executor never arms the fencing token; it does, at all three `#commit` exits, using the lease's
seq — a per-process counter cannot fence across processes, because worker B starts at 1 and
loses to worker A's 3. What remained was that `task.leased` *journaled* the counter while the
store *enforced* the seq, and `TaskRecord.lease.fencingToken` folded the counter. Two numbers
for one thing, and the projection reported the one nothing compares.

Nothing read it, so it misled rather than leaked — which is exactly the kind of defect that
survives, because the failure it causes is somebody believing a number. The seq IS the token, so
the payload stopped carrying a second one and the fold reads `e.seq`.

**Two paths still read a resolver mid-run and are recorded rather than claimed shut.**
`#applyMutation` recompiles a mutated graph, and `#rehydrateGraph` recompiles on every `advance`
of a run that has mutated — both with the live resolver, so a `canMutate` agent's graph
re-resolves its prompts and its children. A22's prompt freeze has the identical hole. The
absolute sentence is false for a mutated graph and true otherwise, and saying so is worth more
than an absolute that a reader will disprove.

**Reverses when.** `RunGraph.subgraphs` holds specs and not compiled children, so a parent still
pays nothing for a branch it never takes. If eager compilation ever becomes worth it — a
deployment that wants every delegation validated before the first Task runs — that is the moment
to reconsider, and the manifest question comes with it.

---

## Three recompiles, one rule, and a test that counts questions rather than answers

A22 froze prompts, A24 froze the subgraph tree, and A25 was the path both had stepped around:
a graph that MUTATES recompiles by design, and both sites did it with the live resolver.
`#applyMutation` runs inside the executing Task that proposed the change; `#rehydrateGraph` runs
on **every** `advance` of a run that has ever mutated, so one re-resolve became one per turn.
A `canMutate` agent's own prompt could change underneath it between proposing a node and taking
its next turn.

**The fix is the rule mutation already follows, applied to content.** `frozenFirst(graph, live)`
answers `document` and `subgraph` from what the run froze and falls through to the live store for
anything else — so a mutation may ADD a node naming a ref nothing has seen, and that ref resolves
once, at the compile that introduces it, while nothing already relied upon can move. Additive-only
was always the mutation rule; this is the same sentence about bytes instead of nodes.

`resolve` is deliberately not overridden: it returns a pin, the pin is a digest over the ref, and
a compile that could not pin a new ref could not compile at all.

**One helper at all three sites, and the reason is the previous wave.** `#compileChild` had this
shape already, spelled inline. I shipped the WIDE substitution there first, measured 38 failures,
wrote the number into three documents as though it refuted the whole direction, and only a
reviewer's narrow retry showed the cheap version cost nothing. A shape that has been got wrong
once is a shape to give a name, so the fourth site cannot re-derive it differently.

**And then I did the same thing again, in the same wave.** The fix shipped with `resolve` left
live, on a written rationale that "the pin is a digest over the ref" — true of the CLI's
STAND-IN resolver, false of `ResourceStore`, where `resourceDigest` is
`digest({kind, name, content})`. So a promotion moves the digest, a recompile re-pins the
existing ref to the NEW one, the frozen map keyed by the old one misses, and the live fallback
serves the promoted bytes. The freeze held in exactly the case that needed no freeze. A reviewer
reproduced it through the engine.

**The test had the same disease three times over.** The first draft asserted a frozen object's
contents were unchanged — which cannot fail. The second counted lookups but used a fixture where
every ref shares one constant digest, so the genuinely new ref hit the frozen map too and the
additive fallback the whole design rests on was never called: deleting the fallback kept the
suite green. And its final clause claimed "reverting either call site turns it red" when
reverting the rehydrate site left it green, because that fixture's run reaches `succeeded` on the
first `advance` and a re-attach does no work at all.

**What made the third version real was writing the probe first and watching it fail.** A
store-shaped fixture — per-ref digests that MOVE with content — reproduced the defect, then the
fix turned it green, then reverting each call site individually said which one the test actually
holds. It holds `#applyMutation`. `#rehydrateGraph` has none, and that is now written down
instead of claimed.

**The pattern across both waves is one habit, not two mistakes: I generalised from a measurement
to a neighbouring claim.** "The wide substitution breaks 38 tests" became "the narrow one would
too". "The test goes red when I revert this site" became "either site". Both times the number was
real and the sentence around it was not. The fix is mechanical and cheap — revert each conjunct
separately, run it, write down which one moved — and it is exactly what the file's own
mutation-sweep habit already prescribes for guards.

**Reverses when.** The live fallback is what makes this additive rather than a freeze. If a
deployment ever needs a mutation to be sealed — no new refs at all, only recombination of what
was compiled — that is a different rule and wants a different resolver, not a flag on this one.

## 2026-08-19 · Wave 5 — what a long-lived process never releases

Six unbounded collections, one uncancellable continuation, and two register entries that had
drifted. The work is small; what is worth recording is that **the first plan for it was wrong in
every direction that mattered, and two independent reviews refuted the same three things.**

**The plan's central argument held for one map of the four it named.** It proposed a uniform size
cap and argued eviction was safe because filling a 10 000-entry map costs 10 000 of the operation
being deduplicated. True for `ControlPlane.#idempotency`. For `ResourceStore.#idempotency` the key
is set BEFORE the content-address early return, so filling it is free — and the map is a mismatch
DETECTOR, so evicting turns a refusal into a silent accept, the opposite sign from the harm the
plan reasoned about. For `HumanGateBroker.#idempotency` eviction is replay-safe but converts a
routine Slack redelivery into a durable rejection row naming a blameless human and a bump on a
counter documented as unresettable.

**And the map the plan called safest was the dangerous one.** It enumerated three readers of
`#ephemeral` and concluded "eviction reaches a state the code is already written for". There are
nine. The two it missed decide outcomes: an evicted live gate takes `#fireTimeout`'s
`spec === undefined` arm and is **expired with the reason "exhausted its escalation chain with no
decision"**, which is false, in the journal; and `onTimeout: "default_action"` degrades to `fail`.
Insertion order is raise order, so a FIFO cap evicts the longest-open gate — the one nearest its
SLA. The refutation was already written in the same file, about a different cause, in the words
*"EXPIRES gates that should have escalated. Silently, and fail-closed, which is the kind of wrong
that gets discovered a quarter later."* The plan cited that file as its evidence that eviction was
safe.

The option that was not in the list is the one that shipped: **release on the terminal
transition.** It touches no live gate and reclaims more, because a month-old process is mostly
closed gates.

**A5's register entry credited a fix to the wrong layer, and I repeated it.** `#withDeadline`
answers 504 and increments nothing; every counter lives past `parse`. So "the refusal is recorded
nowhere" was still true while the plan said it was closed — read off a docstring instead of the
code. The fix is four lines at the router, and it is stronger than the interface change the entry
proposed: an `AbortSignal` on `CallbackRequest` is a request injected code may honour, and the one
channel in the binary would have ignored it.

**The heaviest leak was in neither the entry nor the plan.** `Engine.#childGraphs` holds compiled
graphs forever, and the commit immediately before this wave had just widened its key
a third time. That fix was right and stays; it also multiplied the entries. **A correctness fix
can have a resource cost, and this pass shipped one without looking.**

**Reverses when:** a deployment measures child-graph recompiles it cares about (raise
`MAX_CACHED_CHILD_GRAPHS` — though nothing counts them today, so that condition is currently
unmeasurable); or clients retry submits slower than the deployment submits 10 000 runs (raise
`MAX_IDEMPOTENT_SUBMITS`; the unit is entries ÷ submission rate, ~17 h at ten runs a minute).

### Then the diff review found that the fix had the bug the plan rejected the cap for

Two reviewers, independently, with reproductions: **`Engine.rewind` reopens a decided gate by
design** — the engine's own refusals tell operators to do it — and the `gate.raised` event
survives, so the gate folds back to `open` with nothing to repopulate the broker's map. Deleting
the entry on decision therefore stripped a LIVE gate's `DeliverySpec`. Measured: a rewound gate
declaring `onTimeout: "escalate"` with a tier left went from one page and `gate.escalated` to zero
pages, `gate.timeout`, `run.failed`, and a journaled reason — "exhausted its escalation chain with
no decision" — that was false. That is the same sentence the plan quoted as its argument AGAINST
the size cap, and I reintroduced it through a different door while quoting it.

The fix is a split rather than a retreat: **drop the payload, keep the behaviour.** The bytes are
in `payload`; `delivery`, `defaultAction`, `slaMs` and `reminders` are small config. A reopened
gate now behaves exactly as it did and has lost only its rendered payload — which `#summaryOf`
already takes as possibly-absent, because a process that did not raise the gate never had one. The
test asserts both directions with two WeakRefs and fails against both wrong answers.

**The general lesson, and it is the same one as the two waves before:** "terminal" was an
assumption about the system, not a fact about it, and I did not check whether anything undoes a
terminal transition before building on it. `grep -an 'rewind'` would have answered it.

**Three more claims in the shipped comments were false and are corrected in place.** "A recompile
is byte-identical" — no: `resolveManifest` walks only the PARENT's nodes, so a child's own refs
miss the frozen map and resolve live every time, and `tools.manifests()` reads a mutable registry.
That is a real limit of the freeze rather than of the cap, but a cap makes recompiles reachable on
purpose, so it is recorded at the eviction. "The channel still gets the signal" — no: `parse`
receives `{body, headers, now}`; `CallbackInput` is what the ControlPlane hands the ROUTER. And
`boundedLimit` did not refuse at construction as four places claimed, because `GateSweeper` is
built lazily — so `limit: 0` swept nothing forever, which is worse than the clamp it replaced. The
`Engine` constructor now builds and discards one, the same idiom `interventionWindowMs` uses ten
lines above.

**And the headline measurement was over-attributed.** "33.0 MiB in `#ephemeral`" was total process
retention; the map holds ~24 MiB of it and the rest is journal the fix correctly does not touch.

### The probe that lied three times, and the two tests that could not fail

Measuring `#ephemeral` took four attempts and the first three read "no leak". Payloads built from
`"x".repeat(4096)` share one V8 backing store, so 2000 of them cost 1.2 MiB rather than 8. With
that fixed the number stayed flat because **nothing referenced the broker after the loop**, so V8
collected the entire thing before the measurement; one call on it afterwards moved the same probe
from 0.7 MiB to 33.0.

The test had the same disease. `WeakRef.deref()` pins its target until the microtask queue drains,
so proving an object IS held guaranteed the later assertion that it is not. A default scavenge
does not collect at all. And a binding that merely leaves scope stays reachable through its
enclosing context — an object referenced by nothing survived a major GC. The probe now carries a
two-sided control that must see a referenced object survive AND an unreferenced one go.

**Two of this wave's tests are green with their fix reverted, and both say so in their own
docstrings rather than being quietly counted as coverage.** The child-graph test cannot see an
eviction because since A24/A25 a recompile is byte-identical — which is precisely why capping is
safe there; it pins that flooding does not corrupt an answer, and the bound rests on inspection.
The gate-escalation test pins the property the REJECTED design would have broken, so reintroducing
a cap fails there rather than in a deployment a quarter later.

**Where a clamp was overridden, the clamp's own argument was checked first.**
`GateSweeperOptions.limit` fell back to `Math.max(1, …)` on the stated grounds that a floor makes a
mistyped knob "a slow tick rather than no clock at all". `listRuns` is `ORDER BY run_id DESC
LIMIT ?` over time-ordered ids, so a limit of 1 pins every tick to the newest run and every other
run loses its clock entirely. The floor bought the appearance of the guarantee. **Reverses when**
someone shows a deployment where refusing at construction is worse than sweeping one run.


## 2026-08-21 · A provider that ignores `stream: true`

Both adapters send `stream: true` unconditionally, and a gateway that answers with an ordinary
`chat.completion` body produced ZERO frames — so the adapter built a `done` event with empty text
and the run reported SUCCEEDED with `""` as the model's answer. Measured through the binary:
`"outputs": {"a": ""}`, exit 0, and the journaled usage was the local ESTIMATE rather than the
1000/2000 the server reported, so the ledger carried a plausible cost for a call that returned
nothing — a number that feeds the budget ladder and the cohort baseline.

**Refused rather than parsed.** The defect is not "we cannot read this shape", it is that a
zero-frame stream became a successful turn. **Reverses when** a deployment's gateway cannot be
configured to stream; the message carries the server's own content type, which is the diagnostic a
parser would have had to produce anyway.

**The rules live in `modelFrames`, not in `sse`, and finding that out is the useful part.** The
plan graded this Standard on the claim that `sse` is internal. It is a pinned export, so tightening
it would have been a published-contract change and therefore Deep — a depth call made on a fact I
had not checked. Building it surfaced the same error independently: the checks inside `sse` broke
three existing tests whose fixtures read plain `Response`s, one of which asserts that a
comment-only stream yields nothing. That is correct SSE behaviour a general reader must keep, and
a model call wanting an ANSWER is a different rule. The split is better than the plan; it was right
by accident.

**Half the plan was dropped on contact.** The declared-content-type check went: the zero-frame rule
catches every case it would have, the content type is in that message anyway, and a strict header
check refuses honest servers that omit it.

**And one review finding could not be reproduced.** A reviewer measured `modelFrames` turning a
cancel into a retryable `E_PROVIDER_TRANSPORT` — the exact hazard `anthropic.ts` guards against
eighty lines away. I could not reach that branch on either adapter: `sse` checks `signal.aborted`
at the top of its own loop and throws `cancelled` first, measured on a stream that aborts and
closes mid-read. The guard stays, because the ordering it protects is one `sse` edit away from
being real. The TEST for it does not: it passed with the guard removed, which makes it a test that
cannot fail, and the comment says so instead. **Reverses when** someone reproduces the branch.

Unadvertised improvement worth recording: the fallback chain now fails over correctly. The empty
`done` event used to set `committed = true`, so a non-streaming primary OWNED the turn and no
failover happened. Zero frames means zero events, `committed` stays false, and the chain falls
through.

## E8 was the identity function for the entire life of the mechanism

The taint rule — untrusted tool output feeding a hard-to-undo action, invariant 5's E8 —
never changed a single answer. Two independent reasons, either alone sufficient:

`taintBump` returned `"in"` exactly when the action's class was `irreversible` or
`externally_visible`, and `CLASS_DEFAULT_POSTURE` already puts those two at `"in"` in the
**same** `maxPosture(...)` call. It was arithmetically dead the day it was written. And it
was computed *before* the ceiling clamp, so in the one case where it could have mattered — a
human having de-escalated to `on` — the clamp lowered it back regardless. Probed against
`dist/`, all eight rows read `SAME`.

Meanwhile the producer was live and correct: `#recordEvidence` taints channels a tool wrote,
and the decision site computed the bit and passed it under a comment reading "the policy
layer already knows what to do with the bit — it was just never being told." The comment had
it exactly backwards. That is the shape worth remembering: a *producer* wired to an inert
*consumer* reads, from either end, like a working mechanism.

**Taint is not a term in `posture_default`.** It is a floor under the human ceiling. A
de-escalation is a judgement about what its author could see when they made it; untrusted
content arriving afterwards is new information they have not seen, so the earlier "let this
run on-the-loop" stops covering that action and they are asked again. D7.7's row said "one
level up" and "Who may undo: human" — BOTH wrong for E8: it goes to `in`, and nothing undoes
it. The row and the equation are corrected rather than cited.
Untainted, the hard floor stays `on`: the fix must not read as "irreversible always gates",
or it would delete de-escalation for the case it exists for. That control is a test.

E8 also had no firing site — 9 of 10 rules had one — so nothing was ever journaled. It now
raises before the decision it must bind, not at commit like E4/E5, because the evidence is an
upstream task's writes and is already durable.

**The repo's own guard caught this and the excuse dismissed it.** `RULES_NEVER_RAISED` pinned
`taint` with a `why` asserting the behaviour existed compositionally and was recorded in
`policy.decided`'s reasons. Both clauses false. A `why` on that list is a claim about running
code; this one was never run. The list is now empty and the reasons string is now real.

**There is no escape hatch, and an earlier draft of this entry claimed there was.** It said the
operator "must call `deescalate` again after the gate". They cannot: while tainted the clamp is
`maxPosture(ceiling, "in")`, so a second de-escalation by the same human — after they have read
the content and approved the first gate — changes nothing. The only way through is approving each
action. Taint never clears and is keyed by channel NAME with no branch coordinate, so a long run
tends toward "every hard-to-undo node gates every time", which is the "holds that fire constantly
are holds operators learn to ignore" failure this repo argues against in `policy.ts`.
**Reverses when** that becomes routine; the answer then is a ceiling that records WHAT was seen,
not a weaker floor.

Cost: one new public export, `isHardToUndo`. The two-class test drove the hard floor and the
taint rule and was written longhand in both, which is how one of them became the identity
without the other noticing.

## …and then the taint SET turned out to be the weaker half

Two independent adversarial reviews of the E8 fix converged on the same verdict: the rule was
now correct and the thing it consumed was not. Between them they reproduced five ways past it,
each confirmed here against the source rather than taken on report. The fix held only for a
`tool` node naming the tainted channel in `reads`, in the same process, in the same run —
which was exactly the shape of the test that had been written for it. That is the lesson worth
keeping: **a test built from the same mental model as the fix certifies the model, not the
mechanism.**

- **A restart erased it.** `ctx.tainted` was in-memory, and the attach-time re-seed carried
  escalations, ceilings and spend — three things whose absence had already been fixed once —
  but not this. Same journal, same graph, same human decisions, one process boundary: the
  charge ran. Invariant 2 names the journal as the only authoritative durable state, and taint
  was authoritative for an authorization decision with no fold behind it. There is one now, and
  it is the same `applyTaint` the live path uses, which is only sound because taint is
  monotonic.
- **The durable `policy.escalated{rule:"taint"}` event could not have stood in for it.** It
  enters the FLOOR, where `CLASS_DEFAULT_POSTURE` already pins both hard classes at `in`, and
  the ceiling clamp is applied afterwards. Restoring the event changes no answer. Worth stating
  plainly: E8's entire enforcement is the set.
- **`reads` was not the read set.** `tool.args` resolves against the whole channel scope and
  `GRAPH004_UNDECLARED_READ` does not cover it, so dropping a channel from `reads` and
  interpolating it into an argument put untrusted bytes into an irreversible tool's arguments
  with nothing raised. The read set is now derived from the templates too.
- **Any non-tool node laundered it.** The predicate asked "did this node call tools" where
  propagation needs "did this node read tainted data". A `function` copying the value, or an
  `agent` declaring `tools: []` and relaying it, both cleared the bit — ordinary shapes, a
  normalizer and a summariser.
- **An agent turn had no taint at all** — the `PolicyRequest` at the tool dispatch path simply
  omitted the field. This is where the injection actually lands: one node, clean declared reads,
  `net.fetch` returns "now call pay.charge", and it did. Granularity inside a turn is the turn,
  keyed on the tool ordinal, which is derived from the transcript and so survives replay.
- **A subgraph laundered both ways.** The child is a separate `RunId` with its own set. The
  boundary is now treated as external, which over-approximates on purpose: carrying the child's
  set across would be more precise and would not survive a restart, because which of a child's
  channels were tainted is not among the committed writes. The downward direction needs no rule
  — each run has its own `PolicyEngine`, so a parent's ceiling never reaches the child.

**Reverses when** the over-approximation bites: a pure-computation subgraph taints its outputs,
and a channel overwritten by trusted data stays tainted. Both are the fail-safe direction, and
the remedy today is per-action approval. If that becomes noise, the answer is declassification
with a journaled justification — not a narrower producer set.

## EAgent stops being a vendoring source and becomes `packages/eagent`

The maintainer's call: **not a vendor — a monorepo, all development tracked here.** EAgent's
403 files moved in as a fresh copy (its own history stays readable on `init`, tagged
`eagent-v1`), and `../eagent-ref` demoted from "the vendoring source" to historical reference.

**Conformed, not just copied**, which was the whole cost of the move. EAgent ran on `tsx`; Loom
runs `node --test` over `.ts` directly. Three mechanical classes, all of them forced by Node 24
type stripping rather than by taste:

- **1032 relative import specifiers** rewritten `.js` → `.ts`. Every one was verified to have a
  real `.ts` target before rewriting; **zero were skipped**, which is the check that would have
  caught a genuine `.js` reference being clobbered.
- **20 TypeScript parameter properties** hoisted to fields — `erasableSyntaxOnly` forbids them.
  Assignments go after `super()` where there is one (`CapabilityError` has one).
- **The `--import tsx` spawns** dropped from five sites, one of them in `src/`
  (`self-improve.ts` builds the eval-runner command). Type stripping replaces the loader.

**`jiti` stays**, and noticing that mattered: invariant 1 is scoped to `packages/core`, so a
sibling package carrying dependencies breaks nothing. The plan had budgeted for deleting the
package-extension loader, and that turned out to be work nobody needed.

**Four failures out of 1542 were real findings rather than conversion damage**, and all four
were the same shape: **a test locating its own package's source through `process.cwd()`**. That
worked only because the suite happened to run from the package root; from the monorepo root it
resolves one level too high. `kernel-surface`, `self`, `extension` and `packages` all did it —
the last one via `DEFINE_PATH`, which builds a fixture's import statement from cwd. **I nearly
"fixed" `src/extensions/packages.ts` for this**, because the failure surfaced as jiti failing to
load an extension and the loader does seed itself from `process.cwd()`. It was the test. Getting
the actual error instead of the plausible one is what separated them.

**The kernel LOC guard fired, and was raised by exactly six.** Hoisting three parameter
properties out of `kernel/` costs 2 lines each. The ceiling moved 2335 → 2342 with the
derivation written into the test, because a budget raised without one is a budget that stops
meaning anything. It still bites on the next real addition.

**And one Loom guard was coupled to the package list by accident.** `toolchain-gate.test.ts`
built its replica by copying the root `tsconfig.json`; the moment that referenced a package the
replica lacked, `tsc -b` failed there for a reason having nothing to do with what the guard
tests. It writes its own reference list now.

The three files core FORKED from EAgent stay forks — core is zero-dep and cannot import a
sibling, and `build:binary` bundles core's entry alone. Their headers now name the in-repo
original, so the copies can be diffed rather than trusted.

**Reverses when** someone wants one toolchain rather than two: EAgent's tsconfig still turns off
`exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature` and `noImplicitReturns`.
Turning them on is a migration of 28k LOC and was deliberately not bundled with the move — if
the import had broken something, nobody could have told which change did it.

## The hook bus — the extension surface that was declared everywhere and invoked nowhere

The maintainer's first principle for this stretch: **unlimited extensibility and the most stable
kernel, so the agent can keep up with the top ones at any time.** Extensibility is a MECHANISM,
not a port — you cannot absorb what other harnesses do next by copying what they do now. Loom
already designed the mechanism in D6.9 and never built it.

Everything except the bus existed. `GraphSpec.hooks` was in the schema and shape-validated; its
refs were resolved and pinned into the resolution manifest; `hook.applied{ref,point,changed}` was
in `EVENT_TYPES`; `"hook"` was a `ResourceKind`. So a graph could declare an extension, compile
it, pin its digest — and nothing ever called it. **That reads, from any single file, exactly like
a working extension point**, which is this repo's most-repeated failure shape arriving once more.

**A second silence sat inside the first.** The point NAME was an unenumerated `Record<string, …>`
key, so `hooks: {preTolo: […]}` compiled clean, resolved, pinned, and was quiet forever. It is a
compile error now (`GRAPH003_UNKNOWN_HOOK_POINT`), with the known points in the `fix` line —
the same treatment `mode: quorum` gets, and for the same reason.

**And the bus closes a gap the register said had no home.** `PolicyEngine.decide` authorises on
`{capabilities, irreversibility, dataClassification, tainted}` and never sees an argument, and
`irreversibility` is static per tool — so "this invocation is read-only but that one force-pushes"
could not be expressed, which is why EAgent's `bash-policy`/`secret-guard` could not move into
core. `preTool` sees the tool name and the current arguments and may block or rewrite them. That
is argument-level policy, and it runs BEFORE the policy engine deliberately: rewritten arguments
must be the ones policy judges, or a hook that redacts a secret would be authorising the
unredacted call.

**The first draft of that point was blind and it took writing the test to notice.** It threaded a
bare `ToolDecision`, so a hook could block but only on faith — it could not see the argv it was
judging. The threaded value is `PreToolState {tool, args, block?, reason?}` now, and `args` is the
running value so the second hook in a chain sees the first's rewrite.

**Three rules carry the design, each because its opposite is a bypass.** A hook is a pinned
Resource, never ambient code — otherwise a hook edit changes what an in-flight run does, which is
the pinning rule broken from outside. Filters may narrow, never widen: `narrowToolDecision` reads
only `block`/`reason`/`args` and DROPS anything else, so a hook returning `{block:false,
posture:"out"}` is ignored rather than refused, and `block` is monotonic. A filter that throws
fails its Task; an observer that throws is skipped.

**The journal gets the decisions, not the traffic.** `hook.applied` is appended once per hook that
CHANGED the value, naming which ref did it — an operator needs to know which extension rewrote a
tool's arguments, not that one of them did. A row per invocation would flood a hot path, and
invariant 8's rule runs the other way: telemetry may drop, the journal may not.

Wired so far: `preTool`. The other eight points are next; the design's `NodeDecision.overrideWrites`
and `ErrorDecision.downshiftModel` were removed from D6.9's code block until `preNode` and
`onError` land, because a member described and absent is the drift `docs-type-equiv` exists to
catch — and describing an unbuilt field is the same defect as an uninvoked hook, one level down.

**Reverses when** a host needs ambient hooks that outlive a graph. It should not: that is a
plugin system, and this repo's answer to one is `packages/eagent`.

## What two reference harnesses were worth, measured rather than admired

Six parallel readers over `earendil-works/pi` and `deepseek-ai/deepseek-harness` (both MIT, tips
days old), then a synthesiser told to verify the top claims against OUR code before ranking. 54
findings, 45 nominally actionable. The synthesis is worth more than the list, in three ways.

**It caught a reader being confidently wrong about us, which is the failure mode that matters.**
Two findings claimed we have no argument-level guard stage — that `#invokeTool` "has no stage
between the decision and `tool.execute`" and that argument policy "can only be expressed by
writing a whole second tool". That was true when the readers started and false when they
finished: the hook bus landed mid-run. The synthesiser opened the file and said so. **A reader
claiming we lack something we shipped is the most damaging error available here**, because it
buys a rebuild of what exists.

**And I rejected one of its own recommendations for the same reason.** It ranked
`bash-policy`'s `fallthrough: "allow"` default as a posture inversion — "every other boundary in
this repo fails closed". It is not a boundary. `shell:exec` is the gate; `bash-policy` is a
refinement layer on top of it that ships deliberately no-op, and defaulting it to `deny` would
break every shell command the moment someone activates it. "Fail closed" applies to the thing
that IS the gate. The finding read the default and not the docstring three lines above it.

**Two live defects were real, cheap, and ours alone** — neither is an idea borrowed from either
repo, they are things reading someone else's provider code made visible in ours:

- **A truncated turn was reported as a clean tool call.** Both adapters ended with
  `finishReason: toolCalls.length > 0 ? "tool_use" : finishReason`, so `max_tokens` was ERASED
  whenever any call had been parsed — and a call whose argument JSON was cut mid-stream is
  debris: the parser turns the unparseable remainder into `{}`, so the engine dispatched the
  tool with EMPTY arguments. `fs.write` with `{}` is not a smaller version of the intended
  write. A truncated turn now keeps its reason and drops its partial calls.
- **Cached tokens were captured and never priced.** The adapter has always read
  `cache_read_input_tokens`/`cache_creation_input_tokens` and put them on the `UsageRecord`;
  `priceOf`'s parameter named two fields, so it could not see them. Every cached turn settled at
  the plain input rate — cheap-direction wrong for a read, expensive-direction wrong for a write
  (creation costs ~1.25x input), and a budget compares against that number. A row without cache
  rates falls back to input, so an operator who has not priced their cache is not handed a free
  one.

**And one in the kernel: teardown was not total.** Every registration an extension makes is
tracked and disposed, but the `api` object outlived it — a handle captured in a timer could
register after `/unload`, untracked, permanent, attributable to no id. `combine` had a second,
quieter version of the same shape: `disposables.reverse()` is in-place, so a second `dispose()`
tore down in the ORIGINAL order.

The kernel LOC ceiling fired at +14 and the change was rewritten to +7 rather than the budget
being raised to fit it. **A ceiling raised twice in two days without shrinking the change is not
a ceiling.**

**Deliberately NOT taken**, each for a reason that is about our invariants rather than taste:
workflow-as-JS-in-a-vm (control flow is not derivable from a log, so inv 3 and inv 4 both fail);
`ctx.effect` as an effect boundary (it is a disposal scope, records nothing, and hands a node
body the capability inv 4 closes); dsh's fail-open hook arm and its `permission:'allow'`
auto-approval for child agents (a private grant, inv 5); dsh's deny-pattern env scrubbing (ours
is an allow-list — do not regress it while taking the sandbox half); mutation testing as a gate
(neither reference has it, and a slower `npm run check` is a gate people stop running).

## `auditRun` — nothing read the journal back

Invariant 2 makes the journal the only authoritative durable state, and nothing checked that the
authoritative state was internally consistent. The nearest thing, `conformsToGraph`, is
set-membership plus a hash — which is exactly why it printed `ok` straight through the
human-gate bypass (`git log --grep='may only route along its own edges'`): **every id in the
bypass was declared.** Membership was never the question. The question is whether the ids stand
in the right relation, and a relation is a property of a SEQUENCE, so no single call site can
hold it. A writer knows it is appending `effect.completed`; it cannot know whether anything ever
appended the matching `started`, or whether a second completion already used that key.

Eight rules, each with a fixture that trips it and one that does not, each mutation-tested:
removing any one rule turns exactly one test red and nothing else.

**Two deliberate departures from the proposal that produced this.**

*It is offline and pure, not a listener.* deepseek-harness registers checkers on live dispatch.
For us that puts a throwing auditor on the durable write path — invariant 2's own failure mode —
and our `EventBus` is explicitly lossy under backpressure (invariant 8), so a listener-based
auditor would report violations that are really dropped deliveries.

*It returns a report, not a `Violation[]`.* The sketch proposed the bare array. A checker that
could not run a rule and returns an empty array is indistinguishable from one that ran it and
found nothing — the defect class this repo keeps rediscovering. `checked` and `skipped[]` are
part of the answer, with a reason on every skip. Two rules are gated on the run being TERMINAL,
because an open gate and an unsettled reservation are CORRECT in a live run, and a guard that
cries wolf on correct code gets switched off, which costs more than it ever caught.

**Validated against real journals before being believed.** Four run shapes — tool, agent, gated,
router — audited clean, 0 violations. That is the property that matters more than the rules: a
first version that fired on healthy runs would have been switched off within a day.

`loom audit <runId> [--graph <file>]` exits non-zero on a violation. `--graph` is optional and
its absence is REPORTED, because the original compiled graph is not in the journal — only its
hash is — so edge ownership cannot be derived from events alone.

**Reverses when** a rule fires on a healthy run: fix the rule or delete it the same day.

### …and it did, within the hour. Three of the eight rules fired on healthy runs.

A fresh reviewer ran the real `Engine` over shapes this repo already tests and the auditor
failed its own reversal condition on day one. Every finding below was reproduced, then verified
here before acting.

- **`effect.completed-once` fired on every retry.** `ids.ts` says in as many words that the key
  is "stable across retries (the attempt is deliberately NOT part of it)", so a run that survived
  one transient blip exited 1. The rule asserted the opposite of the documented contract. It is
  scoped per ATTEMPT now, using the `attempt` already on `effect.started`.
- **A rewind was read as live history.** `foldRun` suppresses what a rewind undid; the auditor
  read raw events, so "approve → rewind → re-approve" — which `gate-lifecycle.test.ts` tests as
  legal — looked like a double completion. `suppressedRanges` is exported from `projection.ts`
  and shared rather than copied, because two copies drift.
- **An SLA expiry was read as unresolved gates.** `HumanGateBroker.#expire` fails the run for the
  ONE gate that expired and abandons its siblings deliberately. The rule now applies only to a
  run that COMPLETED.

**And two of the eight rules were built on events nothing writes.**
`budget.reservation-is-settled` and `task.no-commit-after-cancel` rest on `budget.reserved`,
`budget.settled` and `task.cancelled` — all three pinned in `docs-drift.test.ts`'s never-appended
registry, which I could have read first. Deleted, not disabled; they return when the events do.

**The worst one was in the CLI, and it was my headline claim.** The entry above said "`--graph`
is optional and its absence is REPORTED". `cli.ts` passed `{}` rather than `undefined`, so
`edgeSource !== undefined` held, every lookup missed, nothing was examined — and the report said
the rule had been CHECKED. On the one rule that catches the gate bypass this module exists for.
`loom audit <run>` printed `ok — 8 rule(s) checked, 0 skipped` while examining nothing. **That is
`conformsToGraph` printing `ok` through the bypass, reproduced one layer up, inside the module
written to prevent it.**

`checked` now means the rule SAW at least one relevant event. The first version seeded it with
every rule and only ever removed from it — the exact defect the module's own docstring names,
shipped inside the module that names it. An empty read is also refused now: auditing a runId that
does not exist printed `ok` and exited 0.

**The lesson is not "review harder".** Every one of these came from believing a rule was right
because it was easy to state. The auditor's own validation set was four linear happy paths, and
the first three non-linear shapes anyone tried all fired. **A checker is only as good as the
healthy runs it has been proven quiet on**, and that set has to include the awkward ones —
retry, rewind, partial failure — before the rule is worth anything.

The follow-on is unchanged: the `EVENT_TYPES` exhaustiveness gate — 52 types each either named by
a rule or carrying an explicit "no relation" excuse — which is what stops the rule set decaying
as the vocabulary grows, and which would have caught the two dead rules at birth.

## The exhaustiveness gate — what stops a rule set decaying quietly

Two of `auditRun`'s first eight rules were built on event types nothing appends. The information
that would have caught it at birth was already in this repo: `docs-drift.test.ts` pins those types
in a never-appended registry. **Nothing connected the two.** This is that connection.

`test/journal/audit-coverage.test.ts` asserts that each of the 52 `EVENT_TYPES` is either
constrained by a rule or excused in writing, that nothing is both, and that no excuse names a type
the vocabulary has dropped. The constrained set is read from `audit.ts`'s SOURCE — the `case`
labels it actually branches on — because a hand-maintained "types my rules read" list is a second
copy that drifts the moment somebody edits one and not the other, which is the exact failure the
file exists to prevent.

Four kinds of excuse, and the split is the useful part: **never-appended** (7, cross-checked
against the other registry so the two cannot disagree), **indirect** (1 — `checkpoint.restored`,
consumed by `suppressedRanges`, which is the strongest constraint here since it decides what the
auditor can see at all), **no-relation** (17 claims that can be argued with), and **todo** (15
promises somebody has to keep). The todo list may shrink and not grow.

**Writing the excuses was the point, and it produced two rules.** Working through the list made it
obvious that `gate.decided` had no mirror — a forged approval row appended by a second writer
passed every rule clean, which is the security-relevant direction and exactly the shape
`effect.completion-has-a-start` catches for effects. And `task.committed` twice for one TaskId —
the double-commit the seq-CAS and the fencing token exist to prevent — had no reader either. Both
are rules now; both were found by being made to say, in prose, why an event needed no rule.

**Three things this session proved about the gate rather than asserted.** Its own excuse check
caught a shrug I wrote ("the mirror of the above", 24 characters). Breaking the source scanner
fails loudly instead of silently reporting everything unconstrained — the failure that would
otherwise read like work. And when a stray `git checkout` reverted the two new rules mid-session,
the gate is what noticed: *"6 rules; deleting one needs a reason in the journal, not a quiet edit."*

**Reverses when** the todo list stops shrinking. A promise nobody keeps is worth less than an
honest "no relation", and the right move then is to demote the entries rather than let the number
sit there.

## Four more hook points, and the honest way to have five of nine

`HOOK_POINTS` declared nine and the engine dispatched one. Narrowing the compiler from "any
string" to "one of nine" had NOT closed the declared-and-never-invoked defect — it just spelled
the silence better: a graph could name `preModel`, compile clean, have its ref resolved and its
digest pinned, and nothing would fire.

So the built set is now data. `WIRED_POINTS` is what the engine dispatches, the compiler refuses
anything outside it (`GRAPH003_UNWIRED_HOOK_POINT`, distinct from "unknown" so the message can
say *why*), and a test walks all nine asserting compile-ok exactly matches wired. The two lists
cannot quietly disagree, and wiring a point is one line plus the dispatch.

Wired this pass: **`preModel`**, **`postModel`**, **`postTool`**, **`onComplete`** — joining
`preTool`. Left unwired and refused at compile: `prePlan`, `preNode`, `onError`, `onGate`.

**Where each one sits is the whole design, and two of the four moved once I wrote the test.**

- `preModel` runs before the ESTIMATE, so the reservation prices the request that will actually
  be sent. Filtering after would price a request nobody made — the same error `assembleContext`'s
  discarded `system` made one layer up.
- `postModel` and `postTool` run BEFORE their journal append, deliberately. A filter that redacts
  a secret out of a result *after* the result is durable has redacted nothing. It also means
  replay serves the filtered value instead of re-running the hook, which is the more
  deterministic half.
- `onComplete` is the one observer: it runs after the terminal event is durable, cannot change
  anything, and a throw is contained — the run is already over, so failing it would report a
  failure that did not happen. Nothing is journaled, because `hook.applied{changed:true}` would
  be false for something that changed nothing.

**And one lie fell out of wiring `preModel`.** `model.called` journaled `req.model` — the
pre-filter value. A hook that reroutes a model would have made the journal record a call to a
model nobody made, in the event an operator reads to answer "what did this cost and where did it
go". It records `shaped.model` now.

**Reverses when** the remaining four are wired: delete their compile refusal in the same change
that adds their dispatch, never before. A point accepted by the compiler and ignored by the
engine is the defect this whole file exists to close.

## `onError` — six of nine, and a deadlock the first draft walked straight into

`onError` lets an extension SUPPRESS a retry the policy allowed, or LENGTHEN its backoff. A
circuit breaker and a cost guard are the obvious uses; both are narrowings, and nothing here
widens.

**The containment is structural, not a merge function.** `#narrowRetry` is reached only when
`#retryDecision` already said yes, so a hook cannot resurrect a retry by any route — which
matters because the policy refuses one for a NON-IDEMPOTENT tool that may already have done its
work in the sandbox. An extension able to override that refusal would be the most dangerous
thing on this bus. `retry: true` is additionally ignored by `narrowErrorDecision`, and a shorter
`afterMs` is clamped to the policy's, so a hook cannot hammer a failing provider harder either.

**Two fields the design promised did not survive contact with the asymmetry rule**, and both
refusals are the rule working rather than scope-cutting. `downshiftModel` substitutes a model
for the NEXT attempt — that is state which must survive the retry, so it belongs in
`task.retry_scheduled`'s payload, and a vocabulary change is a bigger decision than a hook
field. `take` would let a hook choose which edge the run leaves by on failure, which is
ROUTING — a node may only take its own edges, and a hook-supplied `take` would have to pass the
same confinement check or reopen the gate bypass from a new direction. `03-RUNTIME.md` records
both, and `docs-type-equiv` is what made me write it down rather than quietly ship a smaller
interface.

**The first draft deadlocked, and the mechanism is worth knowing.** `#journalHooks` goes through
`#serialize`, which chains onto `#commitChain`. The retry path is already ON that chain, so
awaiting a second entry from inside one waits for itself: the run hung on the first `advance`
with the tool already called. The fix is better than a workaround — the hook's `hook.applied`
rows now ride the SAME `ctx.log.commit` batch as the decision they explain, so the decision and
its reason become durable together or neither does.

**And a test that passed for the wrong reason.** "`onError` CANNOT RESURRECT a retry" was
vacuous: allowing widening in `narrowErrorDecision` killed no test, because the hook is never
consulted once the policy refuses. The structural property is the stronger one and the test is
renamed for it; the merge is now asserted directly against `narrowErrorDecision`, where
widening, shrinking a backoff, and junk input each turn it red. **A run-level test cannot
distinguish "the merge refused it" from "the hook was never asked"** — which is exactly the
distinction that mattered.

Wired: `preModel`, `postModel`, `preTool`, `postTool`, `onError`, `onComplete`. Refused at
compile until built: `prePlan`, `preNode`, `onGate`.

## `onGate` — seven of nine, and the point where "narrowing" needed the most thought

A gate is the one place where a hook could grant AUTHORITY rather than merely change a value, so
this point is defined by what it cannot reach. `approvers` says who may decide, `defaultAction`
is a pre-authorised decision, `onTimeout` says what happens when nobody answers — none of the
three is in `GateView` at all. Not reachable-and-validated: **not reachable**. A hook returning
`{approvers: ["u:attacker"]}` is not refused, it is structurally incapable of being read, which
is the difference between a check somebody can forget and a shape nobody can express.

Three fields remain, and each is a narrowing or pure information gain:

- **`payload`** — what the human SEES. Enriching it is the useful case (attach a risk score, a
  diff, an incident link) and grants nothing. `contentDigest` is computed inside `raise`, AFTER
  this hook, so the digest pins what the approver actually saw rather than what the node
  originally rendered.
- **`excludedApprovers`** — union only. Barring one more subject narrows; a shorter list handed
  back cannot un-bar anyone.
- **`allowEdit`** — intersection only. Shrinking what an `edit` decision may write narrows; a
  channel the gate never allowed cannot be added.

**Two things worth recording about the build rather than the design.**

The deadlock from `onError` generalises: this path is on the commit chain too, so the
`hook.applied` rows go through `ctx.log.append` directly — which is what `raise` itself does
five lines later. `#journalHooks` is now the wrong tool anywhere inside `#commit`, and only the
two points outside it (`preTool`, `preModel`/`postModel`/`postTool`) may use it.

And the first test asserted the wrong thing: it looked for the enriched payload in the gate
RECORD, which deliberately carries `contentDigest` and not the payload. The observable proof is
that the digest MOVED — same graph, same inputs, hook versus no hook — which is a stronger
assertion than the one I set out to write, because it checks the pinning rather than the
plumbing.

Wired: `preModel`, `postModel`, `preTool`, `postTool`, `onError`, `onGate`, `onComplete`.
Refused at compile until built: `prePlan`, `preNode`.

## `preNode` — eight of nine, and `overrideWrites` earns its way back

`preNode` lets a hook skip a node and supply its answer. The canonical use is memoisation:
recognise the work is already done, skip the body, hand back the result — strictly LESS action,
no model call, no tool, no spend, which is why it narrows even though it produces state.

`NodeDecision.overrideWrites` was removed from `03-RUNTIME.md` two waves ago precisely because
it was described and unbuilt. It is back with two containments, both in the engine because both
need the node:

- **`overrideWrites` is confined to the channels the node DECLARED it writes.** A hook cannot
  write a channel the node was never going to touch — route confinement's rule applied to state
  instead of edges. Measured: a hook returning `{out: …, smuggled: …}` on a node declaring only
  `out` writes `out` and nothing else.
- **A `human_gate` may never be skipped**, refused before the decision is even read.

**And the second containment is where the test lied — again, and I caught it the same way.**
Deleting the `human_gate` check turned NO test red. On the ordinary path a gate has posture `in`,
so `#executeTask`'s policy decision raises it and returns before `#dispatch` is ever called, and
`preNode` lives inside `#dispatch`. The containment my test observed was structural; the explicit
check was invisible to it.

The check is not dead, though, and that mattered to establish rather than assume: a settled
MIRROR gate returns `this.#dispatch(...)` directly, so `#preNode` CAN see a `human_gate` in a
subgraph delegation. The test is renamed for the property it actually proves and says which path
it does not reach, and the check stays with the reason written next to it.

**Three iterations, three tests that passed for the wrong reason** — `onError`'s resurrection
guard, `onGate`'s payload assertion, and this one. All three were found by mutation, not by
review, and none would have been found by re-reading the test. The habit worth keeping is not
"write better tests"; it is **delete the mechanism and watch what survives**, because a test that
survives its own subject was never testing it.

Wired: `preModel`, `postModel`, `preNode`, `preTool`, `postTool`, `onError`, `onGate`,
`onComplete`. One left: `prePlan`, which is the hardest — a rewritten spec must recompile and
re-pin, and that collides with the graph-binding rule an approval depends on.

## `prePlan` is refuted, and the hook bus is finished at eight

The design named nine points. Eight are built. The ninth is not pending — it is wrong, and
saying so is the end of this piece of work rather than a gap in it.

**Three independent reasons, any one sufficient.** `Engine.submit` takes a COMPILED `RunGraph`,
so the engine never holds a `GraphSpec` to filter — the point has no home on the inside. A host
could filter before compiling, but the hooks a graph declares live IN the spec, so it would have
to parse, read, filter and only then compile, putting the extension surface outside the bus that
governs every other point. And a hook rewriting a spec would duplicate `compileMutation` with
strictly fewer guarantees: no additive-only rule (`MUT001_NOT_ADDITIVE`), no `graph.mutated`
record carrying nodes and edges so a restart can rebuild, no `mutation_introduced_irreversible`
escalation for an added hard-to-undo node. **That is invariant 2's failure mode — a second,
weaker answer to a question the journal already answers.** A graph that changes itself does it
through mutation, which is journaled, bounded and escalated.

**So the two lists collapse into one.** `WIRED_POINTS` existed to keep intermediate states
honest while the design named more points than the engine dispatched, with the compiler refusing
the difference. The difference is gone, so the second list is gone with it, and
`GRAPH003_UNWIRED_HOOK_POINT` went too rather than sitting there unreachable — a declared code
nothing raises is the defect this bus was written to close.

**And the test that replaced it is weaker than I first wrote it.** It scans `engine.ts` for each
point name, and I claimed that proved dispatch. It does not: deleting `preNode`'s dispatch leaves
the name in the `runFilters` context object one line down, and the scan stays green. The
behavioural test is what catches that. The scan is a FLOOR — it catches a point added to
`HOOK_POINTS` with no engine code at all, which is exactly how declared-and-never-invoked comes
back — and the comment says so now instead of overclaiming. Found by mutation, like the three
before it.

**The bus, finished:** `preNode`, `preModel`, `postModel`, `preTool`, `postTool`, `onError`,
`onGate`, `onComplete`. Every point is dispatched, every filter narrows and none widens, every
change is journaled as `hook.applied` naming the ref that made it, and a hook is a digest-pinned
vm-sandboxed resource rather than ambient code. `@loom/core` still has zero runtime dependencies.

## Two more audit rules, and the fixtures were the ones that were wrong

`task.leased-precedes-commit` and `run.submitted-is-first-and-once` — the first two off the
coverage gate's todo list, which drops 15 → 13.

**The lease rule reads the fencing token back.** The lease's own seq IS the token: the journal's
seq is the only monotonic source every process shares, so a task that commits with no prior
`task.leased` committed under no token at all — the concurrent double-execution the
compare-and-set exists to prevent. Nothing checked it from the record.

**And adding the submission rule turned every existing fixture red at once, correctly.** They
were hand-built arrays that began at seq 1 with no `run.submitted` — a shape the engine cannot
produce. The fixtures were wrong, not the rule, so `fixture()` now prepends the submission the
way a real journal does, and every fixture that commits leases first. **A synthetic journal that
no engine could emit is not a test of the auditor; it is a test of a run that cannot exist.**

**The partial-journal case is the one that would have bitten in production.** `auditRun` takes
any array, so a caller reading from seq 5 hands it a tail with no submission in it — not a defect
in the run. The rule stands down unless the journal starts at seq 1, and says so in `skipped`.
That is the same shape as the terminal-run guard on the gate rule: an "eventually" or
"always-first" property is only checkable when you can see the whole thing.

**Validated against real journals before being believed, on five shapes this time** — fan-out
with a join, a bounded loop, a subgraph (parent AND child journals audited separately), and a
gate approved then resumed. Zero violations. The previous sweep was four linear shapes; the ones
added here are the ones that produce branch coordinates, iteration suffixes, a second RunId, and
a suspend/resume — every axis a TaskId varies along.

**Both rules were then mutation-tested and both were under-tested**: deleting them killed 3 and
13 tests respectively, but only INCIDENTALLY, because every well-formed fixture exercises them.
Neither had a fixture that TRIPPED it. Three added — a commit with no lease, a journal with no
submission, a submission that is not first — plus the partial-journal control. **A rule with only
negative coverage is a rule you have proved silent, not a rule you have proved works.**

## The ledger and the mechanism have to agree

`call-pairs-with-its-effect` — every `model.called`/`tool.called` must sit on an `effect.started`
with the same key AND the matching kind. Todo list 13 → 11; eleven rules.

The two records serve different readers. `*.called` is the human-legible one — the provider, the
model, the shape of the arguments — and it is what an operator reads to answer "what did this
cost and where did it go". `effect.started` is the REPLAYABLE one. They are appended together at
four sites and nothing checked they stayed together, so **a `*.called` with no effect is a call
the journal DESCRIBES and replay CANNOT REPRODUCE**: the ledger and the mechanism disagreeing
about what happened, which is precisely the class `auditRun` exists for.

**Two paths were checked before the rule was written rather than after.** The summariser calls a
model too — it appends `effect.started{kind:"summarize"}` and no `model.called`, so it cannot
false-positive. And the model site appends `effect.started` unconditionally, BEFORE the replay
branch, so a replayed turn carries both records like any other. Neither was obvious from the rule
statement; both would have been false positives.

Nine real journals swept clean again — the four linear shapes plus fan-out, loop, subgraph parent
and child, and a gate approved and resumed. The kind-crossed fixture trips this rule AND
`effect.kind-matches-its-key` together, which is right: they catch the same disagreement from
opposite sides, and a fixture that tripped only one would mean one of them had a hole.

## The other half of the oversight record — and a mutation harness that was lying

`gate.raise-has-a-decision`: every `gate.raised` must be preceded by a `policy.decided` for the
same task. Todo list 11 → 10; twelve rules.

A gate is the OUTPUT of the guard chain and `policy.decided` is the input that produced it — the
reasons, the posture, the class. A gate raised for a task that never had a decision came from
somewhere other than the chain, which is the thing invariant 6's single dispatch path exists to
make impossible. Nothing read that back.

**Keyed on the TASK, not on the decision's effect being `gate`, and a real journal is why.** A
subgraph delegation raises a MIRROR gate in the parent for a task whose own decision was `allow`
— the child is what gated. I built the case rather than reasoning about it: parent journal reads
`policy.decided(allow) → subgraph.started → gate.raised → run.suspended → gate.decided →
run.resumed`, 0 violations. Keying on `effect === "gate"` would have fired on every delegation
that gates, which this repo tests and ships.

### The mutation harness was producing false confirmations

The sweep replaced `add("rule"` with `void ("rule"` — and that regex also matched
`saw.add("rule")`, the line that records EVIDENCE. The result was `saw.void (…)`, a `TypeError`,
so the tests died of a crash rather than of the rule's absence. **Every "mutation confirmed"
in this file for a rule that has a `saw.add` was, to that extent, unearned** — the tests did go
red, but not for the reason claimed, and a rule with no test at all would have looked identical.

Redone with `(?<!saw\.)` and asserting the substitution actually matched something. All twelve
rules kill 1–2 tests, **zero crashes**. The result stands; the evidence for it did not, and the
difference matters because "the test went red" is worth nothing without "and for the right
reason".

The lesson generalises past this file: **a mutation that changes behaviour AND breaks the program
proves nothing.** A harness needs to assert its edit was surgical — that it matched, and that the
suite fails on assertions rather than exceptions — or it is measuring its own bugs.

## The state hash chain, and the rule that had to know about fan-out

Two rules, todo 10 → 9, fourteen rules total.

**`state.chain-is-unbroken`** is the stronger and was not on the todo list — it fell out of
reading the payload. `state.reduced` carries `stateHashBefore` and `stateHashAfter`, so every
reduction must start where the last one finished. A break means a write went missing between
them, a second writer interleaved, or a reduction was computed against a projection that had
already moved. Nothing had ever compared the two halves of a field the engine has always written.

**`state.root-writes-are-reduced`** is the one from the list, and the naive version of it is
WRONG. The engine's own comment says why: *"a join emits its fold; a root-branch Task reduces its
own writes immediately; a Task inside a fan-out holds them until its join."* A rule asserting
"committed writes are followed by a reduction" fires on every parallel branch this engine runs.
It asks only about `root`-branch tasks, and a branch-coordinate task holding its writes is
explicitly tested as legal.

**Both candidates were probed against real journals BEFORE either was written** — fan-out,
linear, and loop, checking the hash chain and the root-reduction property separately. Fan-out
produced three reductions and zero chain breaks, which is what made the chain rule safe to write
at all. Then the full nine-shape sweep: zero violations.

That ordering is now the habit: read the payload, form two candidate rules, run both against real
journals as a probe, and only then implement the one that survives. Four iterations ago I would
have written the naive rule, shipped it, and had a reviewer find it firing on every fan-out.

## Subgraph pairing, and invariant 3 read back out of the record

Two rules, todo 9 → 7, sixteen rules.

**`subgraph.start-and-completion-pair`** in both directions: a completion with no start is a
child nobody recorded starting, and a start with no completion on a run that COMPLETED is a
delegation whose end was never written. The second half is gated on the parent completing, like
the gate rule — a suspended parent with a child mid-flight is the normal shape of a delegation,
not a lost child.

**`subgraph.child-id-is-derived`** is the one worth having. `#runSubgraph` derives the child's
id as `${runId}~${taskId}` for exactly the reason a TaskId is derived — replay and a restart
must find the SAME child — and **nothing compared the journalled id against the rule that is
supposed to have produced it.** That is invariant 3 checked from the record rather than trusted.
It validated against two real journals before being written, so the format assumption is
measured rather than assumed.

**And a fixture I wrote two iterations ago was the thing that broke.** The mirror-gate test
invented `childRunId: "run_2"` with no completion — an id no engine mints, in a shape no engine
emits. Both new rules fired on it correctly. That is the third time an unrealistic fixture has
been the failure rather than the rule (`run.submitted` absent, commits without leases, now this),
and the pattern is the same each time: **a hand-built journal drifts from what the engine
actually writes, and the drift is invisible until a rule looks at that part of the shape.**

The fix each time is to make the fixture realistic rather than to weaken the rule, and the reason
is worth stating: a fixture is a claim about what the engine produces. When a rule contradicts
one, exactly one of them is wrong about the engine — and the engine is checkable.

## Posture monotonicity and an unlisted extension — the last two high-value rules

Todo 7 → 5, eighteen rules.

**`policy.escalation-only-raises`** checks invariant 5's tightening half from the record.
`PolicyEngine.escalate` computes `max(from, to)` and returns WITHOUT firing when that equals
`from`, so a journalled escalation strictly raises BY CONSTRUCTION — and nothing verified the
construction held. Two properties: each event raises, and escalations CHAIN per scope, because
`from` is that scope's current value. A gap in the chain means a second writer. Node scopes and
the run scope keep separate ladders, which the test pins so the rule cannot be tightened into
firing on ordinary node escalation.

Validated on a REAL escalating journal rather than a fixture: a tool needing an ungranted
capability produces `E6 violation, out → in`, audits clean, and the rule reports as `checked` —
which matters because the nine sweep shapes escalate nothing, so this rule had no evidence in any
of them and would have looked "validated" while never running.

**`hook.applied-ref-is-declared`** closes the extension surface's own audit gap. A hook is a
pinned resource NAMED BY THE GRAPH, so a `hook.applied` citing a ref the graph never declared at
that point is an extension that reached the run some other way. It needs the graph — like
`edgeSource`, the declared hooks are not in the journal — so `loom audit --graph` supplies both
now, and without one the rule is skipped rather than guessed at.

**This is the end of the high-value list.** Five todos remain and all five are thin:
`run.started` ordering, `task.ready` before lease, `fanout.planned` width bounds,
`gate.escalated` tier monotonicity, `graph.mutated` added-edge scope. Each is a real relation and
none of them would have caught anything this repo has actually shipped. Writing them would grow
the rule count without growing the guarantee, and a rule set padded with the cheap ones is harder
to trust than a short one where every entry earned its place.

## The arguments were the hole, and the globals fix had not closed them

This module records its own worst finding: `SAFE_GLOBALS` seeded the vm context with the HOST's
intrinsics, so `Object.constructor("return globalThis")()` reached the host global, and a
reviewer measured a body printing a real `ANTHROPIC_API_KEY` out of `process.env`. That was
fixed by rebuilding the globals out of the context's own intrinsics, and the docstring says the
fix made the module's claim "true rather than aspirational".

**It was still false.** The body was then CALLED with the host's `view` and `ctx`, and a host
object hands over the host `Function` exactly as a host `Object` does. Measured, today, before
any change:

    view.constructor.constructor("return globalThis")().process   → object
    ctx.constructor.constructor(…)                                → object
    view.get.constructor(…)                                       → object
    ctx.now.constructor(…)                                        → object
    ({}).constructor.constructor(…)                               → undefined   ← the globals fix, working

The last line is the point. The context isolation is sound; **the arguments walked around it.**
Same escape, same words in the docstring, a different door — and the door nobody guarded was the
one every single function body goes through.

`view` and `ctx` are rebuilt INSIDE the context now, from a JSON payload, so only strings and
numbers cross. The allow-list and own-property checks mirror `makeStateView` exactly, including
the reason the second is not redundant: `reads: ["constructor"]` compiles with a warning, so an
allow-list alone would answer with `Object`. Values coming BACK need no such care — an object
built inside the context carries that context's intrinsics, which is exactly why the fifth probe
reads `undefined`.

**And the same change fixed the hang, because they were the same defect seen twice.** Calling the
body from the host meant `vm`'s own timeout — the only thing that can terminate synchronous
execution — did not apply, so `while (true) {}` in a `function` resource hung `loom run` with no
output until it was killed, while `#withNodeDeadline`'s `Promise.race` sat on the same blocked
thread. The call happens inside the context now, so the timeout applies to the synchronous part
and the node deadline still bounds the async part. Two mechanisms because there are two failure
modes, and the README row claiming the hang is gone.

**The mutation test proved it by hanging.** Reverting to the host-argument call made the spinning
body run forever and took the command with it — which is the defect, reproduced, as the cost of
checking. Worth the two minutes: a fix for a hang that cannot be shown to hang without it is a
fix nobody can check.

## `onBudgetExhausted: "gate"` promised a human and delivered a failure

D6.5 designs a ladder — warn → degrade → gate → fail. Only `fail` was ever built. `gate`
compiled clean, escalated the run's ceiling for decisions a dead run would never make, and then
returned `failed` **exactly as `fail` does**. `degrade` was read by nothing at all. Both are
compile errors now (`GRAPH003_BUDGET_ACTION_UNSUPPORTED`), which is the treatment
`approval.mode: quorum` gets and for the identical reason: a graph that reads as supervised and
behaves otherwise is the worst failure available, because nobody goes looking.

**The test covering it was part of the illusion**, and that is the finding worth keeping. It was
called *"E3 — an exhausted budget GATES when the graph asked it to"*, its failure message read
*"'stop, this is expensive' and 'stop' are different answers"* — and it asserted only that an
ESCALATION EVENT had fired. It never checked that a gate was raised or that the run parked,
because neither happened. **A test can assert the vocabulary of supervision while the behaviour
is absent, and its name is not evidence.**

Building `gate` properly needs somewhere for the human's answer to GO — a way to raise a budget
mid-run — and no such API exists. The refusal is written to be deleted in the same change that
adds one.

**Three guards caught the blast radius, which is what they are for.** Removing the escalation
left `budget_exhausted` as a rule nothing raises, and `docs-drift` failed until it was pinned
with the reason. A shared compile fixture and the corpus's only end-to-end example both declared
`gate`, and `docs-examples` failed until they said `fail` — a design document whose example
cannot compile is drift, and the guard treats it as such. Each failure was the change being
measured rather than a cost of making it.

## Declarative fallback chains, which the front page promised and nothing constructed

`FallbackAdapter` has been written and fully tested since the provider layer landed, and
`grep -ran 'new FallbackAdapter' packages/core/src/` returned NOTHING. A models-file route row
could name one adapter and no more, so the capability README advertises — on the row a reader
consults before pointing this at a provider — was real and unreachable.

A route row takes an optional `fallback` list now, and the chain becomes a SYNTHETIC ADAPTER the
route points at, so `RoutingAdapter` is untouched: it still maps one key to one adapter, and the
fanning-out happens a layer down where `FallbackAdapter` already lives.

**Three refusals came with it, and one of them is the guard most likely to be lost in a port.**
An undeclared tier adapter is refused rather than skipped — a skipped tier is a chain that reads
as resilience and has none, which is the rule the adapter rows already make about an unknown
provider. A malformed `when` is refused. And `FallbackAdapter` refuses a policy-class code AT
CONSTRUCTION, because trying a second vendor after a content filter declined is evasion rather
than resilience — wiring the chain through a config file must not lose that, so the construction
refusal is re-raised naming the file and the row, and a test pins it. It looks like defensive
typing until you read why it is there, which is exactly why it needed a test at this layer.

**And the pricing check had the same hole one tier down.** `unpriced` read only the model a route
NAMES, so a chain whose fallback is unpriced spends without limit the moment it falls through and
reports `costUsd: 0` for it. It walks every tier now.

The README row is gone and the front-page claim is true. That leaves three of the audit's
defects: `rewind` wedging a run, `loom compile` fabricating resource pins, and `EdgeSpec.codes`
having no reader.

## `EdgeSpec.codes` — a filter with no reader, next to one that works

Every error edge was a catch-all whatever it declared: `#errorEdges` filtered on `kind` alone
and `codes` had ZERO readers. It reads them now — an edge with no `codes` stays a catch-all, and
when nothing matches the take is empty and the failure is unhandled, which is the honest answer:
the graph declared handlers and none of them was for this.

**The asymmetry is what made it a trap rather than a gap.** `RetryPolicy.onlyIf` IS read —
`policy.onlyIf.includes(error.code)` — so an author who learns that code-filtering works for
retry reasonably assumes it works for error edges, declares
`codes: ["E_PROVIDER_UNAVAILABLE"]` on a compensating edge, and silently gets that edge for a
validation failure too. Two fields, one behaviour each, and only one of them the documented one.

**And writing the test found the thing that would have made the feature confusing.** The code an
edge must declare is the NORMALIZED one, not the one the tool threw: `#invokeTool` maps a tool's
failure onto the taxonomy, so a thrown `E_PROVIDER_UNAVAILABLE` reaches the journal as
`E_TOOL_SOURCE_UNAVAILABLE`. My first test asserted the raw code and failed. Matching what
`task.failed` records is the right choice — an author reads the code off `loom trace`, so the
filter should key on what they can see — and now it is written down instead of discovered.

Zero blast radius: nothing in `src/` or `test/` declared `codes`, only the schema in
`02-EXECUTION-GRAPH.md`. Two of the audit's defects remain: `rewind` wedging a run, and
`loom compile` fabricating resource pins.

## A rewind reported success having undone the work and not redone it

`rewind` is the only recovery command, and it was worse than the register said. The register
called it a wedge — `E_OUTPUT_MISSING` on the next advance. Reproduced, it is quieter than that.

A node's declared `checkpoint: "before"` lands BETWEEN that node's `task.leased` and its
`task.committed` by construction. Rewinding to it suppresses the commit and leaves the lease, so
the fold shows a task held by a worker whose work no longer exists — and `#advanceSerially`
leases only tasks in state `ready`. Measured on a one-node graph:

    rewind to the node's own checkpoint  →  task "leased", run "running"
    advance                             →  "succeeded", n = 0

`n` is the output channel and `0` is its INPUT value. `advance` found nothing runnable, walked
to `#finish`, and appended a second `run.completed`. **Not a wedge — a run that says it did the
work and did not**, which is the worse of the two and the reason the register's description
mattered less than the reproduction.

A lease the rewind undid is not a lease. `rewind` now appends `task.ready` for every task left
`leased`, so the task is runnable again and the node actually re-runs: `n = 1`. That is also what
makes `checkpoint: "before"` mean anything — the checkpoint a node declares is precisely the one
that strands its own lease.

**The auditor did not catch it, and now does.** `task.leased-is-resolved`: a task left `leased`
on a run that COMPLETED is work the run reported as done and never did. Gated on `run.completed`,
because a cancelled or failed run legitimately abandons an in-flight lease.

**And the rule caught a fixture on its way in — the fourth time.** The retry regression fixture
leased for attempt 2 and never committed, which no engine emits. Fixed the fixture, not the rule.
The tally is now: a journal with no submission, commits with no lease, a subgraph child id no
engine mints, and this. **Every hand-built fixture drifts from what the engine writes; the drift
is invisible until a rule looks at that part of the shape, and the rule is right every time.**

---

## The extension surface was never reachable through the product

*Reversal condition: if hooks should be ambient plugins rather than pinned Resources, the loader
goes and `registerHooks` becomes an `import()` — and the pinning rule stops applying to code the
engine runs, which is the trade.*

`grep -an 'HookRegistry' packages/core/src/ | grep -av run/hooks.ts` returned three lines, all in
`engine.ts`: one import, one option field, one assignment. **No constructor anywhere.** So
`Engine.#hooks` was `undefined` on every path the CLI builds, `#hooksFor` answered `[]` at all
eight points, and the entire hook bus — the thing this project calls its extension surface — did
nothing through `bin/loom`.

Everything around it existed and looked right from any single file. `graph/validate.ts` refuses
an unknown point name. `graph/compile.ts` pins every hook ref into the resolution manifest.
`journal/events.ts` carries `hook.applied`. `resources/store.ts` has `"hook"` in `ResourceKind`.
`run/hooks.ts` opens by promising a hook "is loaded by the same digest-pinned, vm-sandboxed
loader that `function` nodes use." Twelve months of scaffolding around an empty middle — which is
the same shape as `createFunctionLoader`, `runSandboxed`, `McpClient` and `ResourceStore` before
it. **This is the fifth capability this repo shipped with no caller, and the first one that was
the headline feature.**

Measured, through the CLI, before and after, on a one-node graph whose `preNode` hook memoises
the answer as `41`:

    without the registry   →  n = 1     the node's own answer, hook silent
    with it                →  n = 41    the hook's

**One realm, two bridges.** A hook body is `(input, ctx)`; a function body is `(view, ctx)`. The
temptation was to fork the loader. `resources/functions.ts` is the file where a live escape was
found and fixed this month — `view.constructor.constructor("return globalThis")().process`
reached the host because the globals had been rebuilt from the context's intrinsics and the
ARGUMENTS had not — and a fork means the next such fix lands in one copy of two. So the hardened
part moved to `resources/realm.ts` and each caller supplies only the few lines that turn a JSON
payload into its argument list. Both suites now guard it: seeding the realm with host intrinsics
turns `functions.test.ts` AND `hook-loader.test.ts` red.

**A declared hook with no body is refused, and that does not contradict the registry's shrug.**
`HookRegistry.resolve` skips an unregistered ref on purpose — an embedder that did not install an
optional extension has not written a broken graph. But the CLI's registry is built *from the
workspace*, so a ref it lacks is a missing FILE. Answering that with a shrug would rebuild the
declared-and-silent failure one level up, so `requireHookBodies` refuses at compile — before the
run, before a model call, before spend.

**And a docstring that had been false for a year fell out of writing an honest test.**
`functions.ts` claimed "two refs resolving to the same bytes share one compiled body."
`resourceDigest` hashes `{kind, name, content}`, so two NAMES holding identical source are two
digests and compile twice. The real guarantee is per version — two SELECTORS on one version share
a body — which is what anything actually depends on. The test that found it was written to assert
the stronger claim and went red.

**And the acceptance test found a lying error message on the way through.** Deleting a published
hook body under a live gate correctly refuses the approval — the ref now resolves elsewhere, so
the resolution manifest no longer matches the one `run.compiled` recorded, and that is the
graph-binding rule doing exactly its job. But `#assertBound`'s `details` reported
`expected: recorded.graphHash, actual: ctx.graph.graphHash` on BOTH branches, and on the
`resources` branch `isCompiled` is true by construction — so the operator was told "the resources
behind its refs have changed" beneath the same sha256 printed twice. A diagnostic that reads as a
broken check, pointing at the graph file, which is the one thing that did not change. It now
reports the manifest pair on that branch.

**One scoping decision, and invariant 5 decided it.** `requireHookBodies` runs when a graph is
being INTRODUCED — `compile`, `run`, an explicit `--graph`, the server's catalogue — and not in
`graphsByHash`, which exists so a human can answer a gate on a run already in flight and which
swallows a compile failure per file. Left unscoped, a deleted extension file made the graph drop
silently out of that index and the approver was told `E_RUN_NOT_FOUND`: "no graph in `graphs/`
has that hash … restore them to answer the gate" — about bytes nobody changed. Scoped, the same
deletion produces `E_GRAPH_MISMATCH{differs: "resources"}`, which is true, and restoring the file
makes the gate answerable again. Both halves are mutation-tested against the same test.

---

## D5 — the compiler was never the problem

*Reversal condition: when `agent_profile` resources carry a real profile document, or an
`OversightPolicy` resolver seam exists, that kind leaves `NAME_ONLY_KINDS` in the same change
that builds the reader. A kind that has become a document and is still on the list is a graph
that compiles and cannot run.*

`loom compile` said `ok` for a graph naming `agent_profile/does-not-exist@stable` and
`prompt/also-missing@stable`. The register called it a compiler gap and prescribed adding an
`oversight` resource kind. Both were wrong.

`rule015Resources` has raised `GRAPH015_RESOURCE_NOT_FOUND` **as an error** since long before
this. It could not fire because `openWorkspace`'s resolver answered every syntactically valid ref
with a fabricated pin:

    oversight/deploy@stable  →  sha256:6f76657273696768742f6465706c6f7940737461626c65000…

which is the ref, hex-encoded, and decodes back to itself. **A digest derived from the ref
carries nothing `graphHash` does not already carry**, so it bound nothing and proved nothing —
and `spec.ts`'s claim that a pinned `humanGate.ref` "proves a policy EXISTS and pins its bytes"
was false against the fabricator. Deleting the fallback is one line.

**The real question was the second one, and the answer is not the one the register proposed.**
Of the seven ref-bearing fields, two name kinds whose content nothing in `src/` reads:

- `agent_profile` — a ROUTING KEY. `#runAgent` passes it straight through as
  `ModelRequest.model`; `--models-file`'s `routes` table maps it. `cli.ts` already stated the
  reversal.
- `oversight` — a POLICY LABEL. `humanGate.ref` becomes `policyRef`, which gates batch by;
  D7.2's blocks are inline on the node for exactly that reason. 04-OVERSIGHT.md already stated
  the reversal.

Publishing `oversight` as a resource kind — the register's prescription — would have made every
gated graph carry a JSON file with no schema and no reader: the fifth caller-less capability,
one wave after finding the fourth. `NAME_ONLY_KINDS` says instead that **a ref which becomes a
document must exist and a ref which is a key need not**, names both entries, carries both
reversal conditions, and is gated against growth.

**Measured before choosing, and the measurement was the whole decision.** A probe appended every
ref for which `resolver.resolve()` returned `undefined` across all 1888 Loom tests: zero. Every
in-tree resolver answers everything, so the diagnostic could not break a test — and could not be
caught by one either, which is why the new suite builds workspaces that genuinely lack a ref.
Removing the fabrication then failed 15 tests; exempting the two key kinds took it to 6, and
every one of those six was a fixture leaning on the fabrication:

- a "failed run prints its error" fixture that reached run time only because a missing
  `subgraph` ref compiled. Now a PUBLISHED function body that does not evaluate — resolves,
  compiles, and raises the same `E_RESOURCE_NOT_FOUND` from `FunctionRegistry.require`.
- two that asserted the fabrication directly ("an unpublished ref still pins"). One of them,
  "A SPEC FILE THAT PARSES TO SOMETHING THAT IS NOT A SPEC IS NOT PUBLISHED", could finally
  assert its own title: those files do not publish, where before the strongest available check
  was that their fabricated pin served no document.

**And it found a swallow that predates all of it.** `graphsByHash` — the index an approver's
gate is answered through — caught every compile failure per file and dropped it in silence, so
the operator got "no graph in `graphs/` has that hash (N searched)": true, useless, and pointing
at the one directory that was fine. It now returns what it could not build, and the refusal names
the file and the reason. Any compile failure had this; a deleted hook body is only how it
surfaced.

**A test that could not fail, caught by mutation.** The gate keeping `NAME_ONLY_KINDS` from
growing also requires each entry to carry its reversal condition — first written as a COUNT of
the word "reversal" in the docstring. Three mentions minus one still cleared a threshold of two,
so deleting an entry's condition left it green. The unit is the bullet, not the file, and the
last bullet has to stop at the end of the list rather than running into the closing paragraph —
which is the second version of the same mistake, found the same way.

---

## T4 — replay could not reproduce the runs an auditor most wants to reproduce

*Reversal condition: if a `policy.deescalated` event ever becomes derivable from the run itself
rather than supplied by a human, it stops being an input and this serving goes away. Nothing
suggests it will — that a human is the only source is what invariant 5 is.*

`CLAUDE.md` carried this as the ONE caveat on the bar. Reproduced on a one-node graph with no
taint in it:

    recorded:  deescalate `run:<id>` → on, the irreversible action runs, no gate, succeeded
    replayed:  no ceiling → posture `in` → a gate → E_REPLAY_DIVERGENCE, "replay raised a gate
               on node "act" that the recorded run never decided"

So an audit could not re-derive precisely the runs where a human used the one lever invariant 5
allows to lower oversight.

**The framing that made the fix obvious.** Every other term in the posture `max` is DERIVED — the
graph declares it, a rule computes it, a class implies it — so a replay re-derives it by running.
A human ceiling is the one term that comes from outside the run, which is exactly why nothing
else may lower a posture. **It is an input, like a gate decision, and replay has to serve it.**

**The trap, and it is the kind that ships.** `PolicyEngine.decide` keys ceilings by
`run:<runId>` and `node:<runId>/<nodeId>`. The obvious fix — hand the original's `ceilings` map
to `PolicyEngine.restore` — writes entries no lookup in the SHADOW run ever reaches. It
type-checks, it runs, it changes nothing, and it reports green. Mutation-tested: dropping the
rekey alone reopens the original failure exactly.

**Ordering is by gates RAISED, not gates DECIDED.** `resolveGate` advances the run as part of
answering, so a human lowering a ceiling while gate 2 is open does it after gate 2 was raised and
before it was decided. Keyed on decisions, the replay applies that ceiling right after serving
gate 1 — before gate 2 exists — and suppresses the very gate the recording raised. Measured on a
three-node chain: keyed on decisions it diverges, keyed on raises it matches.

**And the reproduction itself was wrong twice before it was right.** The first attempt
de-escalated AFTER the gate was raised, so the recording had a decision to serve and replay
passed. The second wired node 2 to read node 1's output — tool output is untrusted, so E8 tainted
it, the hard floor went to `in`, and the gate fired whatever the human said. Correct behaviour,
and it silently turned a test about de-escalation into a test about taint. The test file says so,
because the next person will wire it the same way.

### The bigger hole, found by mutating the fix

`replayRun`'s `compare` weighed task states, channels and run status. **Never gates.** So a replay
that raised a different number of human gates than the recording reported `match: true` — and so
did one that asked NOBODY AT ALL. Measured: a recording that asked a human twice, replayed asking
once, `match: true`; replayed asking zero times, `match: true`.

That is "looks supervised, is not" at the level of the audit tool. The verdict every consumer
reads — `loom replay`'s exit code, D10's promotion gate — was blind to exactly the thing
replaying a gated run is for. Two of the seven mutations written to verify the T4 fix were
silently green against it, which is how it was found: **the fix could not be verified until the
verdict could see what the fix changed.**

`compare` now emits a `gate.decided` frame per gated TaskId — derived, so comparable across the
two runIds — carrying each side's state and decision. One exemption, narrow and per-task: a
`subgraph` whose effect was SERVED from the record did not run its child, so its parent-side
mirror gate has nothing to mirror; comparing it would report a divergence for behaving as
designed, which is the same rule that stops a replay re-calling a model.

**And a test that asserted contents rather than the verdict.** The first gate-frame test checked
that the frames exist and carry the right strings; forcing every frame's `match` to `true` left
it green. Asserting a frame's contents is not asserting that the verdict moves. A second test
produces a real gate divergence through `replayGates: false` and asserts `match` is false — and
that one dies under the mutation.

**Four tests took ten seconds each.** Lowering an irreversible action to `on` is what turns the
intervention window ON — at `in` a gate is stronger and there is no hold, at `out` nobody is
watching — so the tests proving de-escalation works were exactly the ones that then sat in
`#sleep`. 35 seconds on a 9-second suite. `sleep: async () => {}`, which this repo's working
rules already name as the usual cause.

---

## T2 — the declared read set was not the real one, and two decisions believed it

*Reversal condition: if `tool.args` interpolation is ever narrowed to `reads` — the hygiene fix
HANDOFF describes — then `observedChannels` becomes the identity and can go. Until then, every
decision computed from `node.reads` is computed from a field nothing holds anyone to.*

`#runToolNode` resolves `tool.args` against `scopeFor(...)`, the whole channel scope. So a
template names a channel and the node reads it whether or not `reads` mentions it, and anything
derived from the DECLARED set is one token from being switched off.

`observedChannels` was written for the taint half of this and wired to taint alone. Two other
sites still read `node.reads`, and both feed the posture `max`. Reproduced on a graph that
compiles clean, with `token` declared `classification: "secret_ref"` — floor `in`, a gate:

    reads DECLARES the secret:   awaiting_gate   gates=1   tool saw: nothing
    reads OMITS it, same args:   succeeded       gates=0   tool saw: "sk-live-SUPER-SECRET"

**One token deleted and the classification floor is gone.** Same shape as the E8 bypass, one
field over, with the fix already sitting in the same file unused on this path.

`observedChannels` moved to `graph/spec.ts`, beside `reachableToolNames` — the same kind of
thing one noun over, a static derivation off `NodeSpec` that invariant 5 depends on — and now
feeds the compiler's `dataFloor` and the engine's `dataClassification` too.

**Both sites, and the reason is a test that could not fail.** Reverting the ENGINE site alone
changed no outcome, because the compiler's plan already supplied the floor through
`declaredPosture` — a fix with no test that could distinguish it, which this repo treats as no
fix. The case where it matters is real and written down in 01-INTERFACES: `plans` are excluded
from `graphHash`, so "a process registering fewer tools recomputes a weaker posture under an
identical hash". A graph can therefore arrive carrying `posture: "out"` for a node whose channels
say `in`, and then the engine's own computation is the only term left. The test attaches exactly
that — same bytes, same hash, weakened plan — and the engine still gates.

**And a fixture that proved nothing, caught the same way E8 was.** The first version used a
`reversible_write` tool, whose own floor is already `on`. That makes `pii` — also `on` — the
IDENTITY, so the `pii` row demonstrated nothing about classification at all. It is the exact
mistake this repo found in E8, where taint was written into a `max` that `CLASS_DEFAULT_POSTURE`
had already pinned. Caught by the `public` row refusing to come back `out`; the fixture is
`read_only` now, so classification is the only term that can raise it.

**What is deliberately NOT done.** The compile rule refusing a template outside `reads` — the
hygiene fix — breaks every graph that does this today, and making a security fix hostage to a
migration is how the security fix does not ship. Also untouched: `viewFor(…, node.reads)`, which
is CONFINEMENT rather than a decision. Widening that would grant a `function` body more than it
declared, which is the opposite of what this change is for. The boundary is now a test: a
router's `when` reads the scope through the expression evaluator and is still not covered (T1),
asserted rather than described, so the day it changes the test says so.

---

## T1 — the blocker was stale, and the coupling that made it stale was unrecorded

*Reversal condition: if a branch CHOICE ever needs to escalate on untrusted input — if the two
bounds below stop being enough — this becomes a hole and the boundary argument goes with it.*

T1 said: "a `router`'s `when` reads the scope through the expression evaluator, not a `${}`
template, so `observedChannels` cannot see it… Needs the expression parser to report free
variables."

**The parser has always reported them.** `checkExpr(...).refs` returns the free variables and
`GRAPH004_UNDECLARED_READ` has always used them — a router case's `when` and an edge's
`when`/`until` are refused unless every channel they name is in the owning node's
`reads ∪ writes`. Measured: `router reads [], when "untrusted != null"` → `ok=false
GRAPH004_UNDECLARED_READ`; declare it and it compiles. So the reachability half of T1 does not
exist. `observedChannels` is blind to expressions and it does not matter, because `reads` is
already a superset for exactly the channels an expression can reach.

**It does not matter for a reason living in another file, and nothing recorded that.**
`observedChannels` is in `graph/spec.ts` and said only that it does not cover expressions;
`rule004Expressions` is in `graph/validate.ts` and does not know anything depends on it. Relax
GRAPH004, or add a fourth place the engine evaluates an expression, and taint and the
classification floor go quiet with no test failing. That is the same shape as the audit-rule
coverage gate: two mechanisms that compose into a guarantee neither one states.

`test/graph/expression-reads.test.ts` is that missing edge. It reads the ENGINE's source for
every `evaluate(this.#expr(…))` call — three today: `c.when`, `e.until`, `e.when` — and fails on
any site no GRAPH004 check is named for. Mutation-tested with a fourth site added: red.

**What is actually left, stated so it can be argued with.** A branch CHOICE made from untrusted
content raises nothing. That is a design boundary rather than a hole because it is bounded twice
— `GRAPH005_ROUTE_NOT_OWN_EDGE` and its runtime half `E_ROUTE_INVALID` confine a router to edges
the AUTHOR declared, so untrusted content picks among the graph's own branches and cannot invent
one; and every target re-decides at full strictness on its own class, so an irreversible node
still floors at `in` whatever branch reached it. Both bounds are asserted by the same test, so
the day either goes, the boundary claim fails with it rather than quietly becoming false.

**The pattern across three iterations now.** D5's prescribed fix was wrong, D2's severity was
understated, and T1's blocker had already been built. **The register is a record of what was
believed when it was written; the code is what is true.** Reproduce before fixing — and read
"reproduce" as including "reproduce that the problem still exists".

---

## T3 — a wave decides before it commits, and taint arrives at commit

*Reversal condition: if `#runWave` ever commits each task as it finishes rather than after the
whole wave, the overlay becomes the identity and can go. It is the `Promise.all`-then-commit
shape that creates the window.*

`#runWave` runs the whole wave with `Promise.all` and commits afterwards in branch order;
`applyTaint` runs in that commit loop. So every policy decision in a wave is made against the
taint set as it stood BEFORE the wave, and a node whose tainter is a sibling rather than an
ancestor decided on a set one commit out of date.

The register said "needs an under-constrained graph and nothing refuses one". Both true, and the
graph is one edge from an ordinary one:

    start → fetch  (a tool: taints `untrusted`)
    start → charge (irreversible, reads `untrusted`)

Measured, the same graph one edge apart, under a human ceiling of `on`:

    edge fetch→charge    awaiting_gate   gates=1   charged=0
    NO edge (same wave)  succeeded       gates=0   charged=1

**E8's hard floor — never below `in` while a hard-to-undo action is tainted — is the one thing a
human ceiling may not cross, and deleting an edge walked around it.**

`RunContext.waveTaint` is the fix: a per-wave, TaskId-keyed overlay of what the wave's EXTERNAL
members are about to write, consulted alongside `ctx.tainted` through one helper so the two
halves cannot drift.

**It is a separate field rather than a pre-fill of `ctx.tainted`, and that is invariant 2.**
That set promises "monotonic and never cleared, so folding it forward from seq 1 gives the same
answer as running it live". Pre-filling would break it: a wave member that FAILS writes nothing,
so no fold ever produces its channels. The overlay is recomputed from the wave's composition —
itself derived — so a replay reaches the same answer with nothing journaled a fold could not
reproduce.

**Two things it must not do, and both needed a fixture that could tell the difference.**
A node is not tainted by its OWN pending write: its input on that channel came from elsewhere,
and self-tainting would gate every read-modify-write node against itself. And only EXTERNAL
members taint — a `function` body is trusted code (A13). The first version of the second test
put producer and consumer in different waves, where the filter cannot act, and a mutation
deleting the filter entirely left it green. Siblings, not a chain, is the only arrangement that
tests it.

**And a guard whose stated reason was wrong.** The `finally` that clears the overlay was
commented "a stale overlay would taint the next wave's decisions with channels nobody in it
writes". It would not: the map is keyed by TaskId, so a stale overlay reaches only a task with
the SAME id in a later wave — a retry, and nothing else. The mutation that left it armed went
green, which is what surfaced the overstatement. The comment now says it is defence rather than
the thing that makes the mechanism correct. **A guard whose reason is overstated is one somebody
deletes later on a correct-sounding argument.**

*(Also caught in passing: a `.replace()` inside a JS template literal ate the escapes out of a
regex — `[\s\S]` became `[sS]` — so an assertion silently tested a different pattern. Patches
that write regexes now go through a heredoc, not a template literal.)*

---

## T5 — a shape that made every consumer wrong, and the tests that were written around it

*Reversal condition: none — a rule id and its evidence are different things and the journal
should say so. If a consumer ever wants the old packed form it can join the two fields.*

`#escalate` journaled `` `${id} ${JSON.stringify(detail)}` `` as the rule, so E6 arrived as

    rule = "violation {\"capability\":{\"capability\":\"danger:do\",\"nodeId\":\"act\"}}"

and `evolution/trajectory.ts`'s `e.payload.rule === "violation"` never matched. Reproduced by
running a graph whose capability the engine does not grant.

**The register found the one rule that had a consumer; seven of the eight firing sites pass a
detail.** Only `operator` does not. So the value was unmatchable for seven of eight rules, and
the register's own second-order note — "E8's firing site uses the same pattern, so any future
consumer inherits the bug" — was the important half. **A shape that makes the obvious consumer
wrong is worse than a wrong consumer, because the next one is wrong too and nobody looks.**

`policy.escalated` now carries `rule` and `detail` as separate fields, through
`PolicyEngine.escalate(scope, to, rule, detail?)` and `onEscalate(rule, from, to, scope,
detail?)`.

**And the reason it survived having tests.** `test/run/escalation.test.ts` covers all ten rules,
and every assertion was written as `startsWith(id)` plus a regex over the JSON tail — which is
exactly how you assert against a packed string, and it passes forever while the field stays
packed. The tests were shaped around the defect. They now read `rule` and `detail` as the two
fields they are, and the mutation that packs them back turns **twelve** assertions red.

**Tests shaped around a defect are how a defect survives having tests.** Worth holding next to
this wave's other findings — a `pii` row that was the identity, a fixture whose two nodes were
in different waves, a gate frame that asserted contents rather than the verdict. Every one of
them passed, covered the code, and could not have failed.

---

## T6 — "not currently a hole" had checked one consumer

*Reversal condition: if a child run's journal is ever folded into its parent's, the recursion
becomes a plain scan and goes. `subgraph.started`'s docstring argues against that — keeping the
parent's journal the size of the parent is the point.*

T6 recorded that `reachableToolNames` does not descend into a `subgraph`, and judged it "not
currently a hole — each run has its own `PolicyEngine`, so the child re-decides at full
strictness with no inherited ceiling". That argument is sound. It is about the POSTURE consumer.

**There is another consumer, and it was a hole.** `rewind` refuses to undo past a committed
irreversible effect with no compensation — "the store must not offer a silently-unsafe undo" —
by scanning `tool.called` in the run's own journal. A subgraph's calls are in a different one,
by design: `subgraph.started` "is the only link between them, which is what keeps a parent's
journal the size of the parent rather than of its whole tree."

Measured, the same irreversible uncompensated `pay.charge` in the same position:

    tool DIRECTLY in the parent   rewind REFUSED (E_RESTORE_ILLEGAL)
    the same tool via a subgraph  rewind ALLOWED — with the charge already taken

**Delegation was an undo the guarantee did not cover.** `#uncompensatedIrreversible` now follows
`subgraph.started.childRunId` — derived, so following it is exact rather than a guess —
depth-bounded and visited-checked, and the refusal names which run the call is recorded in,
because "which journal" is the one thing an operator cannot guess.

**The blunter fix was available and is worse.** Refusing every rewind past any subgraph would
have passed the same reproduction while making every pure-computation child permanently
un-rewindable. A second test pins that the rule is about COMPENSATION and not about subgraphs: a
child call that declares one is undoable, exactly as the same call in the parent is.

### The pattern, now five for five

Every register entry examined this wave was wrong in the same direction — not about whether
something was broken, but about the SCOPE of it:

| entry | what it said | what was true |
|---|---|---|
| D5 | a compiler gap; add an `oversight` kind | the compiler was right; the CLI fabricated pins, and the prescribed fix would have added a caller-less kind |
| D2 | rewind wedges | rewind reported SUCCESS having undone the work |
| T1 | needs the parser to report free variables | it always had, and GRAPH004 always used them |
| T5 | one consumer matched a rule id wrongly | seven of eight rules were unmatchable |
| T6 | not currently a hole | not a hole for the consumer that was checked |

**An entry that says "not a hole" has usually only checked one consumer.** Name the consumers
and check each — `grep` for the symbol, then read every call site, which is what turned this one
up. `#irreversibilityOf` and `#capabilitiesOf` are the two callers of `reachableToolNames` that
remain unaudited against a subgraph, and the entry now says so.

---

## A graph's capability allowlist bounded nothing

*Reversal condition: none. "Never widened" is the design's own phrase; the code simply had not
built the downward half.*

Auditing the two remaining `reachableToolNames` consumers against a subgraph — the follow-up T6
left named — turned up neither a posture hole nor a capability hole in those consumers, and one
next door that is bigger than both.

`02-EXECUTION-GRAPH.md` D5's schema line:

    capabilities: [string]         # allowlist; intersected with system + tenant (never widened)

`grep -arn 'policy.capabilities' packages/core/src/` returned **three** sites: two in
`rule017Capabilities` checking the list UPWARD against the tenant, and one reading a NODE's list.
Nothing narrowed anything by it. Measured, with the tenant holding `pay`:

    graph declares ["pay"]      → succeeded, charged
    graph declares []           → succeeded, CHARGED
    graph declares nothing      → succeeded, charged
    graph declares ["fs:read"]  → COMPILE FAILED (the tenant lacks fs:read)

So the only way to fail was to ask for something the TENANT lacked. An author writing
`capabilities: []` reads it as "this graph needs nothing" and got one that can move money.

**Three places, because two of them cannot see the third.**
`GRAPH017_CAPABILITY_NOT_DECLARED` refuses it at compile, where the author is. The
`PolicyEngine` gets the list as a second bound, because `plans` are outside `graphHash` and
`attach` is public — a compile-only ceiling is one a graph can walk under, the same argument
that made the classification floor load-bearing in both places. And `RunContext.grantBound`
narrows into each child run, because a `subgraph` node reaches no tool and the compile check is
therefore blind to exactly the delegation case.

**That last one is T6's lesson applied before it could become T6's defect** — a guarantee a
child escapes is not a guarantee — and the test for it fails if delegation is merely broken, so
it cannot pass for the wrong reason.

**A second list, not an intersection of patterns.** `granted` may be `["*"]` while the allowlist
is `["pay"]`, and no single pattern list means "matches both" for every input. Requiring both is
what the design says and needs no arithmetic. Where narrowing IS needed — a child's list against
a parent's — the child's is filtered by the parent's, which drops a pattern the parent does not
match. That under-permits rather than over-permits, and it is the only direction worth being
wrong in at a security boundary.

**Absent is not empty**, and that is the whole compatibility story: a graph declaring no list has
no ceiling. Measured before a line was written by arming the rule and running the full suite —
zero failures, because every graph here that declares a list already names what its tools need.
The enforcement was simply missing.

---

## Three sweeps, no defects, and one gate that was missing anyway

*Reversal condition: the gate goes if `AUDIT_RULES` stops being the rule set — it reads that
export, so a second registry would make it check the wrong list.*

With the named backlog empty, the method that produced the last three findings — grep a declared
field, name every consumer, check each — was turned on things nobody had asked about. All three
came back clean, which is worth writing down precisely because a negative result is the thing
nobody records and the next session therefore re-derives.

**Policy fields.** Every field of `GraphPolicy`, `NodePolicy` and `NodeSpec` has a consumer
outside its own declaration. Two looked like suspects and are not: `unhandled` has exactly one
reference and it is right — a compile-only suppression of `GRAPH011`, documented as such — and
`concurrencyKey` has zero because it is not declared in `src/` at all, only in the design, under
`DESIGNED-NOT-BUILT(ToolDefinition.concurrencyKey)`. An unbuilt thing that says so is not drift.

**The marker convention.** `docs-drift.test.ts` already gates every `DESIGNED-NOT-BUILT` and
`NOT-IN-CODE` marker, including the trap that one inside an HTML comment silences nothing.

**Audit rule coverage.** All 19 rules are tripped by a fixture — measured by instrumenting `add`
and running the suite.

**The last of those was a measurement with nothing keeping it true**, which is the same decay
shape `audit-coverage.test.ts` exists to stop one direction of. That file gates: every event TYPE
is constrained by a rule or excused in writing. Nothing gated the other direction, and the two do
not imply each other — a rule can exist, branch on a type that IS appended, and still have no
journal shape any test makes it fire on. Such a rule is indistinguishable from a no-op, and this
module has shipped two of them.

So the probe became the gate: every `auditRun` call in `audit.test.ts` goes through one recorder,
and the file's last test asserts every rule in `AUDIT_RULES` was provoked by something above it.
It also asserts the recorder's own count, because a recorder that stopped recording would
otherwise report the whole list as untripped and read like nineteen new defects.

*(The rewrite that routed those calls through the recorder replaced `auditRun(` inside the
recorder's own body, making it call itself. Caught by reading the result instead of trusting the
patch — the second time this wave a mechanical edit has quietly produced something different
from what it said.)*

---

## A list of error codes nothing validated, where a typo was a silence

*Reversal condition: if error codes ever stop being a closed set — if a deployment can mint its
own — this becomes a warning, because the rule's whole justification is that `CODES` is
enumerable.*

The sweep over `EdgeSpec` and the tool manifest turned up two things. `compensates` has five
references and all of them are in `validate.ts` — that is B9, already recorded in HANDOFF §3 as
needing a product decision, not a new find. `codes` has exactly two, both at run time.

`EdgeSpec.codes` and `RetryPolicy.onlyIf` are both lists of error codes, both read when a task
fails, and neither was checked at compile. Measured on a graph whose irreversible tool body
throws:

    error edge, no codes        the edge fires, the handler runs
    codes: ["E_TYPOO"]          compiles clean, the edge NEVER fires

**And the second row still satisfied `GRAPH011_UNHANDLED_IRREVERSIBLE`**, which asks only whether
an `error` edge EXISTS. So the warning whose entire job is catching an unhandled irreversible
node was suppressed by an edge that could not handle anything. On `onlyIf` the same typo means
"retry nothing", which reads as a retry policy and switches retry off.

**The reproduction found it by making the mistake.** The probe declared
`codes: ["E_TOOL_FAILED"]` — a reasonable guess, and not a code this system has. A tool body that
throws surfaces as `E_TOOL_SOURCE_UNAVAILABLE`. That is why the diagnostic SUGGESTS rather than
just refusing: `E_BUDGET_GONE` → `did you mean E_BUDGET_EXHAUSTED`. An author cannot guess these
and should not have to run the graph to learn them.

An error rather than a warning, because the codes are a closed set and a code no error carries
can never match — there is no reading of it that is correct. The rule is about EXISTENCE and not
reachability: which codes a node can actually raise is not knowable at compile, and pretending
otherwise would refuse correct graphs.

**And it forced a fixture to stop conflating two things.** `error-edge-codes.test.ts` used
`"E_SOMETHING_ELSE"` as its does-not-match code, which mixed "a code that does not MATCH" with
"a code that does not EXIST". The new rule refuses the second, so the placeholder stopped
compiling and the distinction had to be made. The fixture now uses a real, correctly-spelled code
that this failure simply does not carry — which is the case an author actually hits.

---

## A barrier timeout that does nothing, and a refusal I nearly took by accident

*Reversal condition: if the corpus ever starts claiming a join deadline exists, the warning stops
being the right treatment and the argument restarts — `join-timeout-inert.test.ts` asserts the
three places the design says it does not.*

The node-block sweep found `JoinNode.timeoutMs`: declared, shape-validated as a duration, and
read by nothing. `grep -arn 'join?\.timeoutMs' packages/core/src/` returns nothing. A graph writes
`timeoutMs: 120_000` and gets a barrier with no deadline — and the shipped `incident-triage`
workflow was one of them.

**I made it a compile error, which was wrong, and the measurement said so.** The reasoning looked
airtight: `router.mode: "model"`, `onBudgetExhausted: "gate"`, `approval.mode: "quorum"` and
`sla.onTimeout: "default_action"` are each refused for being declared-and-unbuilt, so this should
be too. Then it broke 24 tests and two of the corpus's own worked examples — and looking at why,
`02-EXECUTION-GRAPH.md` states in THREE places that `timeoutMs` is enforced by nothing: the node
table, the field table, and the `mode: all` row ("waits — indefinitely"). The design is not
drifting. It made a choice, and HANDOFF §3 reserves the decision to change it.

**The distinction the four errors share and this one does not: they SUBSTITUTE.** Each runs
something semantically different from what the graph says, so accepting one ships a graph that
reads as supervised and behaves otherwise. `timeoutMs` does nothing at all. That is a smaller
crime and it has a smaller punishment — a warning, which is what
`GRAPH019_POSTURE_NO_EFFECT` gets for the same "you declared something that changes nothing".

**What blast radius is for.** I measured it with a grep over four files, got three hits, edited
those, and found twenty-four failures. The grep that would have answered the question was
`grep -arn 'onBranchError' … | grep -a timeoutMs` over the whole tree — fourteen sites in ten
files. **A blast-radius measurement scoped to where you expect the answer is not a measurement.**

The one failure that survived the downgrade was the right one: `docs-examples.test.ts` pins the
diagnostics of D5.5's worked example, and that example declares a join timeout. Its own comment
says pinning exists so "a change in compiler behaviour show[s] up in the commit that causes it" —
which is exactly what it did. The pin now includes the warning and asserts it is present, so the
compiler and the paragraph next to the example agree.

---

## A misspelled flag was silence, and for `--token` silence was an open control plane

*Reversal condition: none for the refusal. If flags ever become per-verb, `KNOWN_FLAGS` becomes a
map and the gate compares per-verb sets — the shape holds.*

`parseArgs` accepts any `--word` and puts it in the map; nothing checked the set. Measured:

    loom serve --token s3cret    token set, plane authenticated
    loom serve --tokne s3cret    flags {"tokne": "s3cret"}, token ABSENT
    loom serve --Token s3cret    same

and absent means "run an open plane on purpose". The operator's secret sits in `ps`, nothing
complains, every caller is authorized.

**The flag's own docstring had already named this class.** `--name=value` support exists because
parsing only the space form "registers a flag literally NAMED `token=s3cret` and leaves
`flags["token"]` undefined… a security bug rather than an ergonomic gap." One spelling of the
class was fixed; a misspelling reached the identical place. **Fixing an instance is not fixing
the class, and the comment that explains the instance is where to look for the class.**

`assertKnownFlags` refuses at the door — after `help`, so the reader who typo'd still gets the
list — and names the nearest real flag, including the case-only miss that reads as correct.
Three lists now have to agree: `KNOWN_FLAGS` (what the refusal knows), `USAGE` (what the operator
is told), and `args.flags[…]` (what the code consults). A flag in USAGE but not KNOWN_FLAGS is
refused while advertised; one read but not advertised is undiscoverable — which this repo shipped
once, with `--graph` appearing "in no usage text, no error message, and not in the hint `loom run`
itself prints".

### Three process failures in one iteration, all in the harness rather than the code

**A grep window that overran.** The first flag comparison said `--callback-secret` was advertised
and unread. It is not advertised: the extraction ran 80 lines past `const USAGE` into a docstring
that says there is *deliberately* no such flag. Bounding the regex to the template literal gave
perfect symmetry. That is the third hasty grep this wave to produce a wrong answer.

**A mutation sweep that hung and left the tree edited.** The suites included `serve`; the mutation
that removes the refusal turns `assert.rejects(cli(["serve", …]))` from a failing test into a
LISTENING SERVER. The sweep stalled, the 10-minute cap killed it, and `finally` never ran — so
`assertKnownFlags` was missing from `cli.ts` until it was checked. Now: every refusal is driven
through `compile`, child runs carry `timeout: 60_000`, and the harness restores on SIGTERM.
**A test that hangs under the mutation it exists to catch is worse than one that passes**, and a
sweep must be assumed to have left the tree dirty until proven otherwise.

**Two tests that claimed coverage they did not have**, both found by the fixed sweep. The security
test asserted only that `compile nope.json --tokne x` rejected — which it does anyway, for the
missing file — so deleting the refusal left it green; it now names `E_CONFIG_INVALID` and
`unknown flag`. And "every real flag is accepted" iterated `KNOWN_FLAGS`, the list under test, so
dropping a flag from it also dropped it from the loop; it now iterates what USAGE promises.

---

## `String(true)` is `"true"`, and three flags that decide this process's reach had escaped it

*Reversal condition: none. If a fourth list flag appears it goes through `listFlag`; the
`known-flags` gate makes that visible because a new accessor breaks it until registered.*

`--egress`, `--allow-exec` and `--exec-env` each took a value and each read it as
`String(args.flags[name]).split(",")`. A flag given with no value parses to `true`, so a bare
flag became the one-element allowlist `["true"]` — **while still registering the tool it
enables**:

    loom compile --allow-exec    granted=[…,proc:exec]  tools=[…,proc.exec]
    loom compile --egress        granted=[…,net:fetch]  tools=[…,net.fetch]

`capabilitiesOf`'s security argument is that "a tool is registered ONLY when the operator passed
the flag that registers it… so 'registered implies granted' says exactly 'the operator asked for
this'". A flag with no argument is not that: they asked for something and said nothing about
what. And `true` is a real executable, so the allowlist was not empty — it was one program nobody
named.

Six other value-flags already refuse both empty spellings. **These three were the ones that
define what the process may reach outside itself**, which is the usual shape: the guard exists,
and the places it did not reach are not random.

`listFlag` refuses `true` and `""`, and refuses a stray comma rather than dropping the blank —
`--egress a,,b` would otherwise be an allowlist that differs from what was typed with nothing to
show for it. Read before the jail is built, so a malformed flag refuses before any tool is
registered.

**The gate from last iteration earned itself immediately.** Introducing `listFlag` moved three
flags off `args.flags[…]`, and `known-flags.test.ts` went red because its scan of "what the code
reads" did not know the new accessor. That is the gate working, not a chore — the same edit
would otherwise have made three advertised flags look unread.

### And the sweep caught two more of my own tests that could not fail

**A bare `assert.throws` is not an assertion about refusing.** Deleting the empty-value guard
makes `v` be `true`, and `true.split` is not a function — so a TypeError satisfied `throws` just
as well as the refusal did, and the capability test stayed green. It now names
`E_CONFIG_INVALID`. **"It threw" is not "it refused"**, and every `assert.throws`/`rejects` in
this repo that omits a predicate is the same latent hole.

**A test can assert something the behaviour under test does not affect.** "Entries are trimmed"
asserted that `--egress "a, b"` still registers `net.fetch` — which it does either way, so
removing `.trim()` left it green. Trimming's only observable consequence is that a
whitespace-only entry becomes blank and is then caught as a stray comma; the test asserts that
instead. **Find the consequence, not the restatement.**
