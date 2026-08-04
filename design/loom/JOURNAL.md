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
| M2 walking skeleton | **done** | all 12 rows of `08-PLAN.md` D13.3 | 218 tests; `test/run/skeleton.test.ts` — 23 cases incl. the kill -9 gate-durability test |

Open threads that need resolving before the milestone they block:

- **T1 (blocks M1e):** YAML→JSON conversion lives outside core. Core is JSON-only.
  The CLI will need a YAML reader; decide dep-vs-subset-parser at M2.
- **T2 (open):** the `function` node resource loader still registers bodies in-process
  rather than loading them from digest-addressed files. Trusted-code-only by design
  (A13); the loader is packaging work, not a safety question.
- **T3 (blocks M2):** `node:sqlite` is still flagged experimental in Node 24; it
  prints a warning on first use. Need to decide whether to suppress it for CLI UX.
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

