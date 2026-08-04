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
| M4b model adapters | **done** | real Anthropic/OpenAI adapters, offline via injected fetch | 278 tests; `test/providers/providers.test.ts` (24 cases) |
| M4a retry/cancel/rewind | **done** | declared-but-ignored runtime features now implemented | 254 tests; `test/run/runtime.test.ts` (14 cases) |
| M3 replay + spans | **done** | replay reproduces state hashes with zero side effects; reconstruct(trace) ⊆ declared | 240 tests; `test/run/replay.test.ts` (22 cases) |
| M2 walking skeleton | **done** | all 12 rows of `08-PLAN.md` D13.3 | 218 tests; `test/run/skeleton.test.ts` — 23 cases incl. the kill -9 gate-durability test |

Open threads that need resolving before the milestone they block:

- **T1 (blocks M1e):** YAML→JSON conversion lives outside core. Core is JSON-only.
  The CLI will need a YAML reader; decide dep-vs-subset-parser at M2.
- **T2 (blocks M2):** the `function` node resource loader needs a sandbox story for
  v1. Current plan: `function` resources are trusted, pinned, and loaded via dynamic
  `import()` of a digest-addressed file. Not untrusted-input safe — by design (A13).
- **T3 (blocks M2):** `node:sqlite` is still flagged experimental in Node 24; it
  prints a warning on first use. Need to decide whether to suppress it for CLI UX.
- **T4: RESOLVED (M2).** Branch-scoped channels are bindings keyed by branch path,
  resolved by walking a Task's path prefixes (deepest wins), so nested fan-outs shadow
  their parent's item channel without anything copying state.
- **T5 (blocks M3):** fan-out materialises every branch Task in one append, so a join's
  `expected` width is just "how many sibling Tasks exist". Lazy materialisation under
  backpressure (D6.3 level 2) would break that — it needs a *planned* width recorded at
  fan-out time. Do it when backpressure lands, not before.
- **T6: RESOLVED (M4a).** `Engine.rewind` appends a `checkpoint.restored` marker and
  the fold suppresses `(atSeq, marker)`. History is never edited.
- **T7: RESOLVED (M4a).** Retries schedule with deterministic backoff; a
  non-idempotent tool that reached its sandbox is never auto-retried.
- **T8 (blocks M4b):** `fork` mode on rewind is unimplemented — only `rewind`. Fork
  needs a new runId plus a re-execution policy for effects, which is genuinely
  different from replay (it re-executes for real).
- **T9 (blocks M5):** no HTTP surface yet. `ControlPlaneAPI` / `RunEventStream` are
  designed (D3.17–18) but the engine is only reachable in-process.

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
