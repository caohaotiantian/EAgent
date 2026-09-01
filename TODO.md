# TODO

Everything unfinished, self-contained. **Nothing here is a plan** — the roadmap is `DESIGN.md`'s
Sequence, the decisions live in the commit history, and this file is only the list of what is
still true and still open.

## How to read this, and the four rules that govern edits to it

- **Reproduce by RUNNING, not by reading**, including when correcting an entry. *A correction that
  replaces a false claim with a differently-false one is worse than the original, because it
  asserts verified accuracy and is believed harder.* Every row below carries the command that
  settled it; a row you cannot run is a row you must not write.
- **Name the set a claim covers.** "This is total" cannot be checked; a claim naming its members
  can. **A count nobody can enumerate is a count nobody checked** — so a section table's number
  must be countable off the rows beneath it, and where it is not, the table goes rather than the
  rows. §A.19 is the one row here that admits it fails this test, and it says so.
- **A self-describing claim has no fixed point.** State the invariant, not the measurement, when
  the claim is about the artifact containing it. That is why there is no "this file has N items"
  line anywhere.
- **Deleting an item is a choice and so is keeping one.** Every row states **what would close it**.
  A row with no closing condition is a row nobody owns, and it should be deleted with an argument
  instead of carried.

`§Z` at the bottom is the register of what was closed 2026-08-25 → 2026-08-29 and must not be
re-fixed. It is short on purpose: the argument for each closure lives in the commit that made it,
and the sha is the citation.

---

## State — measured 2026-08-29, one command each

| fact | value | command |
|---|---|---|
| tests | **2,678 pass, 0 fail** | `node --test "packages/*/test/**/*.test.ts"` |
| pinned public exports | **526** | `scripts/surface.json` (`check-surface.mjs` needs `dist/`, which needs a build) |
| kernel | **10 files, 8 declared seams** | `node scripts/check-kernel.mjs` |
| zero runtime deps | green, **61 source files** | `node scripts/check-zero-dep.mjs` |
| source files in `packages/core/src` | **61** | `find packages/core/src -name '*.ts' \| wc -l` |
| tracked files carrying a NUL byte | **5**, and **0** invalid UTF-8 | census over `git ls-files` — see §F.15 for why grep cannot count these |
| wall-clock-dependent assertions in the suite | **none** | `abb1e01`, `8b9182f` — see §F.17 |

**The seam census is 8 and did not move this session.** Two `feat` commits landed (`cc320d1`,
`cc64481`) and neither touched a kernel file, so no `Kernel-seam:` trailer was written.
`git log --grep='^Kernel-seam:'` is the ledger and it is not a number anyone can quietly reset.

**The roadmap is closed.** All eight items in `DESIGN.md`'s Sequence name a command that passes;
the last was met against a live provider (`docs/evolution-loop-2026-08-27.md`). The next Sequence
is unwritten and no longer blocked — §D was answered.

---

## What is still open, by section

Counted off the rows, not remembered.

| section | rows | the shape of it |
|---|---|---|
| §A | 27 | open defects, unguarded behaviour, and two deliberate non-defects recorded so nobody "fixes" them |
| §B | 2 | declared and wired to nothing — down from 13 |
| §C | 5 | unbuilt observability |
| §D | 5 | decisions still owed, all of them narrow |
| §E | 8 | deferred on purpose, with the reason — do not silently revive |
| §F | 17 | properties to preserve, not history to honour |
| §G | 7 | field-survey work the redesign creates |
| §H | 1 | housekeeping |

---

## A · Open defects and unguarded behaviour

### The replay-fidelity class — three refusals a replay cannot re-derive

This is the sharpest class in the file, because it is the first non-negotiable failing in the one
place the project sells: *the journal is the only authoritative state.* All three members are
named in one comment at `packages/core/src/run/engine.ts:4681-4695`.

- **A.1 · Three token/cost refusals cannot be re-derived by a replay, all for one reason.** The
  quantity is an ADAPTER's answer and the journal does not carry it: the node **token** ceiling;
  the node **`costUsd`** ceiling, whose `estimateOf(shaped) ?? 0` makes it refuse *nothing at all*
  in replay; and **`ctx.policy.reserve`**, which charges the run's token budget a padded number
  live and an unpadded one in replay. **Only `wallMs` is exempt, and only because it is
  settled-only.** The `costUsd` member predates this session and was undocumented until now.
  Measured, node cap 500: LIVE fails `E_BUDGET_EXHAUSTED` at 1043; REPLAY does not refuse at 19,
  reaches an effect the live run never made, and dies `E_REPLAY_DIVERGENCE` — while `compare()`
  grades both `failed` and reports `match: true`, so nothing announces it. Pinned as debt by
  `test/run/replay-fidelity.test.ts`, "THE HOLE THIS DOES NOT CLOSE".
  **Closes when** `effect.started.kind` gains a seventh member for the adapter call plus an index
  for it in `ReplayEffects` — a vocabulary change in a kernel file, so it is a `Kernel-seam:` and
  the census goes to 9. That is the seam this hole is asking for; it is not a repair.

- **A.2 · A replay grades no MESSAGE, so a path-dependent refusal diverges in silence.**
  **The instance is fixed; the class is not.** The provider refusal opened with
  `model adapter "<name>"` live and `the recorded turn` in replay, because `adapter` is undefined
  under replay — same code, same status, different text, and `match: true` throughout. The wording
  is path-independent now and the adapter's name stays on `details.adapter`.
  **Still open:** `run/replay.ts`'s `compare()` has no message frame, so any OTHER refusal whose
  text depends on the live path diverges the same way and nothing announces it. **Closes when**
  `compare()` grades the message, or when a test pins that no refusal's text can vary by path.

- ~~**A.3 · Three sites named the wrong set for "a journal with no `provider`".**~~ **FIXED.**
  All three now say *journals written before `e6d00f2`* rather than *every journal written before
  this field*. The difference is one real window — between `e6d00f2` and `633e265^` D.7.6's
  refusal existed while nothing wrote the field, so a journal from that range replays a provider
  refusal as a SUCCESS with the refused string on the channel. **The behaviour is unchanged and
  cannot be changed**: the value genuinely is not in those journals. Naming the window was the
  whole remedy, and it is recorded at `engine.ts`'s three-state table.

- ~~**A.4 · `hermetic`'s third conjunct had no producer in `src/`.**~~ **FIXED.**
  `Engine.#functionBody` now calls `bodyEntered(taskId, isRealmBounded(body))` at FETCH, and —
  the half that makes the first mean anything — `resources/functions.ts` carries the realm's brand
  onto the wrapper it returns, via a `carryRealmBrand` that propagates and cannot mint. Without
  that second line `isRealmBounded` was true on the `RealmCall` and false on everything the engine
  holds, so every body would have read as unvouched-for and a term false for everything
  distinguishes nothing. The census test fired exactly as designed and is kept inverted (one
  caller, at the fetch site); the `fromStore` patch is gone, replaced by the pair D.9 asked for.
  **Three existing assertions changed value**, each true only while the term was inert — including
  the flagship `incident-triage` workflow, which is how we learned it does not exercise the
  product's own function-loading path.

- ~~**A.5 · Two kernel files stated a set as total and were not.**~~ **FIXED, and one of them
  was a real hole rather than a wrong sentence.** `run/replay.ts`'s two enumerations named two
  cases where `compileRealm`'s checks had grown to six; both now state the PROPERTY — *this module
  did not make the realm, or could not finish vouching for it* — and let `resources/realm.ts` hold
  the set beside the checks that decide it, which is the only place it can be right.
  `graph/spec.ts`'s "every authoring scope" was false for `sla.reminders[i]`, and that scope is
  now guarded. **Why it had stayed open is the part worth keeping:** `reminders` was an anonymous
  inline type, and `allowed-fields.test.ts` checks each `NESTED_FIELDS` row against the interface
  it covers — so a row for it would have sat OUTSIDE the drift guard that keeps the others honest.
  Naming the shape `GateReminderSpec` put it back inside. A false total is expensive; a true one
  that cannot be checked is not much better.

- **A.6 · A pass-through value with a two-faced `then` getter still crosses the realm boundary,
  and it is left open deliberately.** The thenable refusal now lives once at the seam in
  `resources/realm.ts`, covers both loaders, and `realm.ts:541-573` enumerates what it does NOT
  catch as two members rather than one — which matters, because **the `Map` case (member 1) IS
  caught**, by the canonicalizer refusing a `Map` at all. The survivor is member 2: `rebuild`
  returns a value as-is whenever its prototype's constructor is not named `Object`, i.e. every
  class instance. Measured through the hook loader at `callTimeoutMs: 100`, a body returning
  `new Thing()` whose `Thing.prototype.then` is a getter answering `undefined` on read one and a
  spinning function on read two: `PASS-THROUGH CROSSED at 1 ms; host proto? false` then
  `AWAIT resolved at 1945 ms`. The in-context guard took the first face, the host-side check
  declined to read at all, and `runFilters`' own `await` took the second; `canonicalize(new
  Thing())` is `{"a":1}`, not a refusal, and would be too late anyway. **No read closes it** —
  reading `.then` host-side runs the getter on the host thread, which is the hazard the gate
  exists to avoid, and a counting getter just moves its second face to the `await`. **Closes only
  by** refusing every non-plain return outright (which deletes the clear canonicalizer message
  member 1 depends on) **or a process boundary** — the same limit A.10 ends on, and they should be
  paid for once.

### Oversight, and the places a floor is weaker than it reads

- **A.8 · The compensation dispatch's `nodeApproved: false` is load-bearing and nothing tests it.**
  `engine.ts:1153` argues it at length — an undo that policy answers `gate` must be REFUSED, or
  compensation becomes the back door that performs an irreversible action a gate would have
  stopped. **Measured today**: flipping `engine.ts:1273` to `true` and running
  `node --test "packages/core/test/run/*.test.ts"` leaves **1047/1047 green**. A guard nothing
  would notice the deletion of is not yet a guard. **Closes when** a fixture drives a rollback
  whose undo tool policy answers `gate`, and asserts `compensation.recorded {failed}` rather than
  a performed undo.

- **A.10 · An async body cannot be bounded by any deadline, so it is refused.** `vm`'s timeout
  covers synchronous execution only. The refusal is correct and is stated once at the seam
  (`realm.ts`'s `ASYNC_RULE`). **Closes when** there is a process boundary to run one in — which
  is the same prerequisite as `node:vm is not a sandbox` (§F.10), and should be built once for
  both.

- **A.11 · A 429 arriving after a non-idempotent `effect.started` with NO `effect.completed`
  refuses both a retry and a deferral.** The world may already have changed and the journal
  cannot say. This is the one row of the rate-limit table that stays red and it is deliberate —
  *refusing is always allowed.* **Closes when** the journal can distinguish "the effect ran" from
  "the effect may have run", which is a different item from this one and probably A.1's seam.

- **A.12 · A deferral counts toward E4's consecutive-failure streak.** `#recordEvidence` runs
  before the retry decision, so a long rate-limit outage escalates a node's posture sooner than
  it used to. **Left alone deliberately: not counting it would be LOOSENING oversight.** Recorded
  so the next reader does not "fix" it. **Closes only** if somebody argues that a provider being
  busy is evidence about the node — and that argument has to be made, not assumed.

### Bounds and backpressure

- **A.13 · `loom run`'s `MAX_BACKOFF_WAITS` is 64 and a deferral can be up to 60 s**, so a wide
  fan-out of rate-limited tasks can exhaust the CLI's patience. It reports rather than hangs,
  which is why it ships. **Closes when** the CLI waits on a journal predicate rather than a wait
  count.

- **A.14 · `run.submitted.inputs` is the last inline copy of a payload, and the largest one left.**
  Externalisation is built and flat at 1.01–1.02x over a chain; that residual is this. Inputs
  arrive before any node has run, so there is nothing yet to point at. **Closes when** `submit`
  can reach a payload store — which it cannot today.

- **A.15 · `RUN_CLOCK_SCAN_CEILING`'s residual, and two planes duplicating one window — both want
  the same cursor.** A run past 10,000 is reached by no lap and `RunClockTick.truncated` is the
  only reason anyone knows; separately, two planes now AGREE on a window rather than dividing it,
  which is correct and wasteful because they duplicate every fold. **Closes when** `StateStore`
  grows `listRuns(after)` with a conformance test behind it — `runClockTick`'s own docstring names
  it — and the rotation is then the thing to delete. §E.2's coordinator is the second half.

- **A.16 · What else is process-local and unreconstructable?** `startGateClock`'s `armed` map is
  memory — a memo, so losing it costs a fold rather than correctness, which is why it was left.
  The generalisable lesson `oversight-survives-restart.test.ts` states is that the unit needing a
  restore arm is not the FIELD but the PRODUCER. **Closes when** somebody sweeps every long-lived
  `new Map()` and object literal in `cli.ts` and classifies each as memo or state. Nobody has.

- **A.17 · A plane that RESTARTS gets a new `workerId`, so it cannot reclaim its own pre-restart
  leases through the identity arm and waits for `reclaimable()`.** Arguably correct — after a
  restart they ARE foreign — but **nobody has measured what it costs a fast redeploy**. A real
  trade, recorded as one. **Closes when** somebody measures a redeploy under load and either
  accepts the number or gives a plane a stable identity across restarts.

### Boundaries that are unexamined rather than broken

- **A.18 · A branch choice made from untrusted content raises nothing.** Bounded twice — a router
  is confined to edges the author declared, and every target re-decides at full strictness — so it
  is a boundary rather than a hole, but an unexamined one. **Closes when** somebody drives a
  hostile-content router and either finds the escape or writes down what the two bounds prove.

- **A.19 · Partial reads of untrusted values remain in "~25 files", and that count fails this
  file's own §F.8.** A revoked `Proxy` throws on `Array.isArray`; three files were swept, the
  rest were not, and there are now three private copies of the same guard under three different
  names. **The number is not enumerable as stated and nobody has re-derived it.** **Closes when**
  it is re-derived against a named scope (which files, which predicate) — or dropped with an
  argument. Keeping it in its present shape past the next re-check is the wrong choice.

- **A.20 · A rare suite flake: four sightings, never reproduced.** The last one was captured — a
  child process's stderr read as a prefix — and `5ebad55` fixed the *decidable* half: both spawn
  helpers waited for `"  clock:"` calling it "the LAST stdout line", and `announce` writes
  `  models:` after it, so `serving` returned with 60 bytes still in flight on ten of ten boots.
  That commit explicitly declines to claim the sightings: ten loops under sixteen CPU burners are
  10/10 green before and after. **Closes when** a sighting is reproduced. Until then the honest
  statement is that a helper invariant was repaired and the flake is unexplained.

### Guards over states nobody has constructed

- **A.21 · `suite freeze`'s unresolved-gate exclusion is a guard over a state nobody has
  constructed.** A run must be `succeeded` AND `delivered` to reach that line, and `gateShapeOf`
  counts a gate as unresolved only when its folded state is neither `decided` nor `cancelled`.
  Measured, and the test says so in its own prose (`test/cli/suite-freeze.test.ts`, the case
  "every frozen case carries the safety invariant"): mutating the exclusion away leaves the suite
  9/9. **The comment that cited "TODO.md §A0" now cites this row by number**, along with the twelve
  other citations the renumber broke — see §H.2. Two possibilities wanting different answers: the state is unreachable for an eligible run
  (delete it and say why), or it is reachable by a path nobody has found (build the fixture).
  **Closes when** somebody decides which, by
  construction rather than by argument. A `gate.timeout{fail}` leaves a gate `expired` and fails
  the run, and an `open` gate suspends it, both excluded upstream — which is the argument for
  "unreachable" and is not the same as having shown it.

- **A.22 · `loom score`'s `! N run(s) folded without their graph` line is a backstop with no
  end-to-end test.** With the judged run refusing outright and the peers sharing its lookup, the
  only route left to it is a peer that reached the same cohort key through `graph.mutated` while
  its spec is looked up by `run.submitted`'s hash. Stated at the branch. **Closes when** that
  fixture exists, or the branch is deleted as unreachable.

### The self-improvement loop — what it still cannot see

- **A.23 · The OFFLINE promotion gate is blind to two candidate shapes, and a request digest
  cannot answer either.** Lowering `agent.maxTurns` asks the SAME question on the turns it does
  take, so its turn-0 digest matches and the later recorded turns simply go unserved — it
  promotes, one turn cheaper. Lowering a node's `policy.budget` is invisible because replay has
  no adapter, so `estimateOf` returns 0 and the ceiling is never tested (that is A.1's second
  member seen from the gate's side). **`loom promote --against-cohort` sees both, and that is not
  the same as closing this** — it is a different door with real money, a real provider, and a
  verdict carrying `checksNotRun: ["8-determinism"]`. **Closes when** replay can serve an
  adapter's answers, i.e. A.1's seam.

- **A.24 · `run.compiled` carries node counts, not the spec.** `{graphHash, nodes, edges,
  resolutionManifest}` — so a trajectory's S1/S4/S5 depend on a file on disk, and `isGolden` reads
  a value the journal cannot reconstruct across a restart. **That is the first non-negotiable**,
  and both the peer-fold fix and `loom score` work around it by threading a filesystem index into
  the fold; `promotedGraphHashes` comes from `<workspace>/graphs/` for the same reason. **Closes
  when** `run.compiled` carries the spec, or a graph store the journal can address does.

- **A.25 · A promotion's subject is a graph and the store is keyed by runId.** The decision rides
  on `operator.command {kind: "evolution.promote"}` appended to the FIRST case's run, with
  `caseRunIds` naming the rest. The live mode makes the same borrow and is now the SECOND caller,
  anchoring on the first selected baseline run. Never on a candidate run — hanging the record of a
  judgement inside the thing being judged is a different defect. **Two callers borrowing one
  coordinate is the argument for deciding this, not a reason to.** **Closes when** §D.5 is
  answered: whether the kernel needs a graph-scoped durable fact, and whether that is one event
  type or a second keyspace.

- **A.26 · The live decision rule is weak at small n.** `MIN_PAIRED_RUNS` is 6, argued from the
  exact sign test (n = 4 tops out at p = 0.0625). At six pairs the t bound assumes roughly
  symmetric differences and six observations cannot check that. Two strengthenings are unowned: a
  Wilcoxon signed-rank bound (distribution-free, uses magnitudes; needs an exact null table, a
  page of numerics under the zero-dependency rule) and repeated runs per input so within-input
  model variance separates from between-graph difference. **Neither is required for the mechanism
  to be honest** — the verdict journals `n`, `sd` and `signTestP` and a reader can disagree with
  it. **Closes when** one of the two is built, or the current rule is defended in writing.

- **A.27 · The live cost check divides TOTALS where D10.d says medians.** `3-cost` is
  `Σcandidate / Σbaseline ≤ 1.1` in both modes. Pairing makes the median expressible and the CLI
  computes and journals `medianCostRatio` — **reported, not gated**, because a pair whose baseline
  cost $0 makes the ratio undefined and a check that sometimes has no answer is worse than one
  clear rule. **Closes when** §D.4 decides whether the median gates and what an undefined pair
  does to it.

- **A.28 · A saturated outcome ranks cheapness.** Measured on five real runs sharing a cohort:
  every one had `outcome: 1`, `costNormalized` clamps at the cohort median, two ranked and three
  tied at exactly 0.600, unrankable — and `isGolden` condition 2 is "top decile", so a saturated
  outcome makes that read "the cheapest decile". The cause is **S2, the human gate decision**
  (`DECISION_VALUE.approve = 1` at weight 0.9), not S5, whose weight is 0.0. **A workflow whose
  only signal is human approval cannot rank its own runs.** The escape is a ground-truth signal
  and it is measured, not argued: `examples/graphs/review-bench.json` drives S1 to `k/n` and the
  score then reads correctness rather than cheapness. **Closes when** either scoring refuses a
  cohort whose outcome has no variance, or every workflow anybody scores carries an S1 — and the
  first is a change to the metric, which is the harder and better one.

- **A.29 · A suite frozen from a corpus is a REGRESSION FLOOR, not a claim of improvement.**
  `EvalCase.expect` can name a status, a channel VALUE, a cost and `noIrreversibleWithoutGate` —
  every one of which describes what already happened, so an expectation derived from a recording
  can only say *keep doing this*. Measured: the good candidate promotes over the frozen suite at
  **Δ 0.0pp**, so `2-non-inferior` is what passes it, not an improvement. **The residual cost,
  stated:** a golden case pins the channels the recording produced, so a subtly-wrong output a
  deterministic verifier certified becomes a must-pass regression and a candidate that corrects it
  fails `1-must-pass`. Bounded by `isGolden` condition 1, not eliminated. **Closes when**
  `EvalCase.expect` can name an assertion node's `pass` rather than its whole verdict object —
  `extractSignals`' `firstVerdict` already knows which channel that is. That is a change to the
  gate's vocabulary, not to the freeze verb.

### Compensation — what runs, and the four gaps that do not

Rollback RUNS: `run/compensation.ts` plans it, `Engine.#compensate` performs it in reverse-seq
order through `#invokeTool`, journaled `compensation.recorded` in three states. What is left:

- **A.30 · The four uncovered triggers and scopes.** `#edgesToTake` still has
  `case "compensation": break;` — **deliberate**, because rollback is journal-driven (an effect
  needs undoing whether or not an author drew an edge, and an edge names a NODE while a rollback
  must name a CALL). The rest are gaps: the other three `run.failed` sites (an unmaterialised
  fan-out, `E_OUTPUT_MISSING`, and the budget/fatal floor at the top of `advance`, which can fail
  a run with tasks still leased); child runs, since `#uncompensatedIrreversible` follows
  `subgraph.started` into them while the planner reads one journal;
  `JoinNode.onBranchError: "compensate"`, still refused at compile by
  `GRAPH008_COMPENSATE_UNIMPLEMENTED`; and a DETACHED run whose steps are all blocked, which
  journals nothing because the `not_attempted` rows go through a `RunContext` that cannot be
  rebuilt without the graph. **Closes**, each independently, when a trigger is wired with a
  fixture that fails without it. **Whether an author should ALSO get a graph-level cleanup node on
  failure is a design question, not a wiring gap** — §D.3.

### Two things that are NOT defects, written down so nobody "fixes" them

- **A.31 · An adapter yielding a `UsageRecord` with an absent or non-finite `costUsd` crashes the
  run inside the journal commit.** Reproduced: `usage: {inputTokens: 10, outputTokens: 20,
  wallMs: 1}` with no `costUsd` throws a raw `CanonicalizationError` — `non-finite number NaN at
  usage.costUsd` — from `canonical.ts` through `journal/store.ts` into `RunLog.commit`. Not a
  `LoomError`, not a run failure: an unhandled throw. **Decided: build nothing.** A `ModelAdapter`
  is host-realm trusted code like a `function` body or a `ToolRegistry` entry, and `--extension-
  module` is named on ARGV by the operator, so it carries exactly the trust the operator already
  extends to the binary — the trust boundary does not move, which is why argv-only is load-bearing
  rather than stylistic. **Coercing a non-finite `costUsd` to 0 is explicitly REFUSED**: that is
  this project's signature failure, a guard answering an undecidable case with the passing value,
  and the passing value here is a journaled cost of `0` — exactly what the unpriced-route banner
  exists to shout about. **The dissent, recorded because it could flip this on evidence:** an
  unhandled throw escaping `#commit` is a worse artifact than a `LoomError` even when equally
  safe — no `run.failed`, an operator sees a run that simply stops. **Reopens if** an adapter is
  ever loaded from anywhere but argv (a path in the data directory, a `--models-file` field, a
  resource ref, a hosted deployment), or if a real adapter produces this in a real run and the
  journal cannot be told from a crash. At that moment validation becomes mandatory, it lands in
  `run/engine.ts` as a `feat`, and it needs a `Kernel-seam:` trailer.

- **A.32 · `you cannot fan out from a graph's entry`, and it costs a user one node.** A fan-out
  edge needs a source node, so every fan-out graph opens with a no-op `function` node whose only
  job is to exist. Not a correctness bug. **Closes when** somebody decides the entry is a node;
  worth a decision only if a second shape needs it.

### One more, found while writing this file — a decision that was made and not executed

- ~~**A.33 · `PolicyEngine.clearCeiling` existed in a kernel file with no caller but a test.**~~
  **FIXED — the decided deletion has now landed.** The row is kept because of how it was found:
  the closing sweep nearly recorded it as closed on the strength of the DECISION rather than the
  code, and two independent readers caught that. A decision is not a diff.
  The reason held up under re-derivation: a human ceiling is folded from `policy.deescalated` and
  **no event ever clears one**, so `clearCeiling` deleted an in-memory entry that
  `PolicyEngine.restore` re-installed from the projection on the next attach — the ceiling came
  back at the LOWERED posture. Its docstring ("Always allowed: it tightens") was true about the
  direction and silent about the durability, which is §F.1's class inside the object built to
  defend against it. The capability never needed the method: `deescalate(scope, "in", …)` is the
  same tightening, refused for a non-human, and folded.

---

## B · Declared and wired to nothing

Mechanism that exists in the schema or the types and executes nowhere — each a place a reader
believes a feature is present. This section was thirteen rows and is two.

- **B.1 · `LeasedScheduler` has zero callers in `src/`.** `run/scheduler.ts` implements two of the
  three distributed behaviours its own docstring names — skip live leases, reclaim expired ones —
  with contention tests exercising them against folded journals for two workers. `cli.ts` never
  names a Scheduler, so `loom serve` always runs `InProcessScheduler`; the only mentions outside
  the file are two docstrings in `cli.ts` and one in `engine.ts`. **Either plug it in or delete
  it. Both are decisions and neither is the current state.** This lived in §E under "distributed
  deployment"; it is a §B item and belongs here, which is the whole reason the row moved.

- **B.2 · Five event types have no appender**, each pinned in `test/registries.test.ts` with a
  written reason and a `blockedOn` file list, and a test that goes red the moment the reason stops
  holding. The members: **`budget.reserved`, `budget.settled`, `task.skipped`, `channel.written`,
  `task.started`**. `budget.reserved` is the one that matters — `PolicyEngine.reserve` holds the
  reservation in memory, so a crashed worker's reservation is unrecoverable by folding, which is
  the first non-negotiable again. **The error-code half of this row is CLOSED**: the unraised set
  is now asserted as the EMPTY set (`registries.test.ts:145-149`), not a pinned list with
  excuses. **Closes when** each type is wired or deleted, per its own row's decision.

---

## C · Unbuilt observability, which several other items depend on

**This block gates the UI direction.** A richer operator surface over a plane that is not emitting
is a better view of nothing.

- **C.1 · Seven designed span names are unbuilt.** `loom.request`, `loom.compile`,
  `loom.schedule.pick`, `loom.context.assemble`, `loom.effect`, `loom.scheduler.tick`,
  `loom.replay`. **Eight names ARE minted, and none of them is one of the seven above**:
  `loom.run`, `loom.gate`, `loom.task`, `loom.policy`, `loom.tool`, `loom.state.reduce`,
  `loom.checkpoint` — the seven that
  `/usr/bin/grep -an 'name: "loom\.' packages/core/src/telemetry/spans.ts` returns — plus
  **`loom.model`, which that grep misses**, because `spans.ts:784` mints it through a ternary
  (`name: e.payload.kind === "model" || … ? "loom.model" : "loom.tool"`). So the grep undercounts
  the built set by one. **`loom.effect` carries the opposite trap**: `loom.effect.key` is an
  ATTRIBUTE at `spans.ts:788`, so a bare `grep -c` on it returns nonzero and reads as built.
  **The count was 8 and is 7** — `loom.schedule.admit` was struck when
  §D decided admission control will never be built, a count moving down by a decision rather than
  by a build. The members survive only in git history; the design corpus was deleted at `f975f9f`.

- **C.2 · Eleven documented span attributes are set on no built span.** `budget.cost_usd`,
  `trigger.kind` (`loom.run`); `node.type` (`loom.task`); `capability`,
  `gen_ai.request.max_tokens`, `loom.replayed` (two spans), `tool.attempt`, `tool.source`,
  `reducers`, `gate.posture`, `gate.batched`. Re-verified 2026-08-29: `grep -ac '"<attr>"'` over
  `spans.ts` returns **0 for all eleven**, and the two attributes an earlier count wrongly
  included — `state.hash.before` / `state.hash.after` — return **2 each**, which is the control
  proving the grep discriminates rather than failing silently. Those two ARE set, on
  `loom.state.reduce` and not on the span the source table blamed; the old figure of "roughly
  fifteen" was wrong under every scoping.

- **C.3 · No scheduler-tick telemetry, and there is no tick loop to instrument.** A design gap,
  not a wiring gap. **Per-task queue wait is already measurable** — `task.ready` and `task.leased`
  are journaled for every task and `spans.ts` attaches `task.leased` as a span event, so the p99
  is a fold over what is already emitted. What is missing is scheduler-level behaviour.

- **C.4 · There is no OTLP exporter in the repo and no HTTP trace endpoint**, so
  `SpanLink.traceId` has no consumer outside the splice. The subgraph link is built and
  `loom trace` follows it; nothing off this machine can. **Closes when** an exporter exists — and
  it belongs outside the core, which takes no runtime dependencies.

- **C.5 · The span taxonomy was NOT grown for subgraphs: a subgraph renders as `loom.tool`.**
  Verified at `spans.ts:862`, where `subgraph.started` opens a span named `loom.tool` carrying
  `effect.kind: "subgraph"`, `subgraph.child_run_id`, `.ref`, `.graph_hash`, `.budget_usd` and a
  `SpanLink`. Every attribute a reader needs is there and the NAME is wrong. **Closes when** §D.2
  decides whether a ninth span name is warranted.

---

## D · Decisions still owed

**§D's re-check table carried 22 rows (`D.0`–`D.21`); five remain, renumbered `D.1`–`D.5`.**
Twelve were answered on 2026-08-28 and are in §Z with the commit that executed each — the rest had
already closed before this session. **The surviving five do NOT keep their old numbers**, which is
why §H.2 exists. Many were answered by DELETION, which is the honest direction for a tree whose §B
table carried thirteen rows under a header claiming eleven. The framing question was answered by the
maintainer: **single machine, single tenant, the maintainer's own workflows** — tens of runs per
day, retention in weeks, one `loom serve`, one operator. Four items resolved on that answer and
three of them resolved to *do not build*.

Each row below states what a decision would settle. None is the implementer's to answer alone.

- **D.1 · Per-server `irreversibility` on `--mcp-file`, and the unknown-key refusal
  `readMcpServers` lacks.** `mcp/tools.ts:84` hardcodes `irreversibility: "irreversible"` on every
  tool from every MCP server, so **every MCP tool gates** — and `readMcpServers` (`cli.ts:2408`)
  validates exactly `name`, `command`, `args` and `envAllow` and then builds its result from those
  four keys, with no unknown-field refusal anywhere, so an operator writing a per-server class
  today is silently ignored. That is the same defect class `GRAPH020_UNKNOWN_FIELD` exists to
  close for graphs. Together: the only no-fork tool route the binary offers is unusable for
  anything called more than a few times a day. A mailbox-as-tool delivering ten messages raises
  ten human gates. **This is the item that actually blocks somebody without commit access from
  building a message bus, a cache or a counter**, and it would be the first entry ever to move
  README's fork-required list in the SHRINKING direction, which is what property 2 means in
  practice. **Shape if built:** an optional `irreversibility` on each server entry, validated
  against the four `IrreversibilityClass` members, plus the unknown-key refusal, plus a test whose
  CONTROL (field absent) asserts `awaiting_gate` so the assertion cannot be satisfied by a gate
  that never fires. No kernel file; census stays at 8. **Refused outright, in writing:** inferring
  the class from the server's own advertised metadata — that is the thing being governed writing
  its own permission. **The decision it needs** is whether an operator lowering an oversight class
  from a config file is a threshold this binary should cross. Under one operator it is defensible;
  at more than one it must be reconsidered, because "the operator" and "the person who wrote the
  mcp file" stop being the same person. **Dissent, recorded:** filing rather than building is how
  findings die, and a §D item nobody picks up is functionally the silence that gave §B thirteen
  entries. If this is still open at the next re-check, filing it was the wrong call.

- **D.2 · A ninth span name for a subgraph.** See §C.5. The decision is whether the span taxonomy
  is a closed vocabulary; if it is, the name stays `loom.tool` and C.5 is closed by argument.

- **D.3 · Whether an author gets a graph-level cleanup node on failure**, beside journal-driven
  rollback. Compensation edges are a compile-time declaration by design (§A.30); this asks whether
  there should also be a node an author can point at.

- **D.4 · Whether `medianCostRatio` GATES, and what an undefined pair does to it.** See §A.27.
  D10.d says medians; the code computes the median and gates on totals, and reports the
  divergence rather than hiding it.

- **D.5 · Whether the kernel needs a graph-scoped durable fact.** See §A.25. Two callers now
  borrow one coordinate — `operator.command` on the first case's run. The question is whether that
  is one new event type or a second keyspace, and either answer is a kernel change with a
  `Kernel-seam:` trailer.

---

## E · Deferred on purpose, with the reason — do not silently revive

**"Do not silently revive" is not "never revive."** The reason IS the deferral, so a reason that
stops being true takes the deferral with it. Reading the label instead of testing the reason is
how a deferral becomes a permanent exemption nobody re-examines — which is what happened to four
of these on 2026-08-26.

**Vintage, stated rather than implied: every reason below was last tested by running on
2026-08-25/26, not on 2026-08-29.** The two facts re-checked today are E.1's (`LeasedScheduler`
still has no caller — see §B.1) and E.5's fork-list membership. A reason nobody has re-run in
three days is still the best evidence there is for these, and it is not the same as a measurement
taken now.

- **E.1 · Distributed deployment.** A distributed v1 by a small team yields a distributed
  prototype, not a product. **The half of this that was false is now §B.1**, where it belongs: the
  interfaces are not merely "shaped for it", `LeasedScheduler` is built and uncalled.
- **E.2 · Partition assignment and cross-run fairness.** Deciding which runs a worker considers
  needs a coordinator, and half a coordinator is worse than none. **Still true and still unbuilt.**
  The sentence must stop implying nothing decides it: a silent newest-200-first starvation policy
  had already shipped, and its remaining half is §A.15.
- **E.3 · Automated candidate generation, canaries and auto-promotion.** "Under roughly thirty
  scored trajectories per cohort, any candidate is fitted to noise." The sample argument survives;
  **its premise did not** — the scorer was inverted and the cohort could not assemble until the
  bucket seam was wired. Both are fixed, so **this deferral has to be re-argued rather than
  inherited.** `MIN_COHORT_SIZE = 30` is the encoded form and it is enforced.
- **E.4 · Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the
  compiled one, which is what makes the compiled artifact meaningful. **Reason holds, verified:**
  base node specs survive a mutation deepEqual-identical and removal is unrepresentable in the
  mutation type.
- **E.5 · Custom user-authored reducers.** Reason: arbitrary code inside the determinism boundary.
  **Worth re-examining on the merits** — that boundary now exists and is proven (a seeded PRNG
  from a journaled draw, a clock bound to a journaled task boundary, `Date` and `Intl` absent, an
  embedder `globals` seam that refuses a governed name). A user-authored reducer would run under
  exactly the machinery that was not there when the deferral was written, and a closed reducer set
  is one of the five things README says still needs a fork.
- **E.6 · Free-form agent chatter.** "Makes termination unprovable and replay quadratic."
  **Unverifiable**: there is no chatter to replay, so "replay quadratic" has no measurable
  referent. The precondition holds; the reason names nothing that can be checked.
- **E.7 · seccomp / Landlock.** "Platform-specific" holds — both are Linux-only and this tree runs
  darwin. **The clause claiming the threat model is covered was false and is corrected**: the
  three mitigations bind this plane's OWN tools, and a child process does its own `open()` and
  `connect()`, so `proc.exec` is outside all three. What was missing was not a mitigation but a
  sentence at the moment it happens; the boot banner now names this guard among the ones that are
  off. **The deferral stands; the sentence did not.**
- **E.8 · Vendor callback parsing.** Wrong in both directions as originally written. Signature
  verification IS built, wired and tested — `SignedWebhookChannel` implements Slack's scheme end
  to end. **What is actually missing is per-vendor payload SHAPE parsing, and an email transport
  that does not exist at all** (`email` is only an `Actor.via` label).

**Do not re-enumerate the fork list here.** It lives in `README.md`, "Extending it, and where that
stops" — **ten things need no fork, five do**, each quoted from the refusal the binary prints.
That list moving the wrong way is property 2's alarm; shrinking it is what property 2 means in
practice, and §D.1 is the next entry that would.

---

## F · Properties to preserve, not history to honour

Each cost real debugging time and would cost it again. They are stated as properties, not as
anecdotes.

1. **Every durable fact must be rebuildable by folding the log.** The unit needing a restore path
   is the *producer*, not the field. **The enumeration is SPLIT, and that is the lesson:** five
   are named in `packages/core/test/run/oversight-survives-restart.test.ts:1-20` (PolicyEngine
   escalations, human ceilings, accumulated spend, the taint set, E4's failure streak) and the
   sixth is in `packages/core/test/run/escalation.test.ts` — search either for `MEMBER`. This line
   used to say "cite that file rather than repeating the number", and the device failed on its
   first test: the sixth landed in a different file and the cited one still said five. **A pointer
   to an enumeration is only as good as that enumeration's own discipline about growing.**
2. **A vocabulary with two representations will drift**, and every gate walking the wrong one is
   silently switched off. Prefer a form the type checker can walk; where a test must do it, gate
   all representations as one set and read them from the source.
3. **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm
   that lets something through does not.
4. **Mutation-test every guard.** A test whose expected value could also come from a fallback path
   is a tautology waiting to be discovered. §A.8 is the live instance in this file.
5. **Driving beats sweeping.** Every wave that found real defects found them by running a new
   shape of thing. Sweeps derived from the last finding mostly find nothing, because in a
   disciplined codebase most findings are exceptions rather than instances of a class.
6. **A test built from the same mental model as the fix certifies the model, not the mechanism.**
7. **Reproduce by running, not by reading** — including when correcting a document. A correction
   that replaces a false claim with a differently-false one is worse than the original, because it
   asserts verified accuracy and is believed harder.
8. **Name the set a claim covers.** "This boundary is total" cannot be checked; a claim that names
   its members can. A count nobody can enumerate is a count nobody checked.
9. **A self-describing claim has no fixed point.** State the invariant, not the measurement, when
   the claim is about the artifact containing it.
10. **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.
11. **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and
    "could not read who it names" must never produce the same value.
12. **Approve means "go ahead", not "consider it done"** — on every node type except the gate
    itself, there is work behind the gate. Pinned by the type system rather than by a count:
    `test/run/approve-means-go-ahead.test.ts` drives one gated graph per node type off a
    `Record<NodeType, Case>`, so a ninth member is a COMPILE error there.
13. **A terminal operation is not final until every producer of the state it ends is stopped.**
14. **Cross-realm values look identical and are not**; assert on the prototype, and know that
    `Array.isArray` is realm-agnostic and throws on a revoked proxy.
15. **A plain `grep` can silently skip a file, and empty output is not evidence of absence.**
    Always `/usr/bin/grep -a`, and the path matters — this shell's `grep` is a ugrep wrapper that
    passes `-I`. **The trigger set is NUL ∪ invalid UTF-8**, not non-ASCII: valid non-ASCII
    matches fine. **Do not count the affected files with grep** — a skipped file is only reported
    when it also matches your pattern, so grep undercounts and the count moves with the search
    term. Census instead. Today: **5 files carry a NUL byte and none is invalid UTF-8** —
    `evolution/trajectory.ts`, `journal/payloads.ts`, `test/builtin/fs-search.test.ts`,
    `test/run/delivery.test.ts`, `test/server/http.test.ts`.
16. **A fake credential in a doc must LOOK fake, or a scanner is right to stop you.** And the
    lesson that cost more: **a secret scan that names one vendor's shape is not a secret scan.**
    The pre-push scan that declared the tree clean searched for `sk-` with a HYPHEN; Stripe uses
    `sk_` with an underscore, so the pattern could not match and the claim was broader than the
    check.
17. **A ratio of two timings is not more robust than one timing.** The noise does not cancel, it
    compounds, and it compounds asymmetrically — so a gate written as `t_big / t_small < K` is
    **likeliest to pass when its own denominator sample is worst.** Measured twice this session on
    two different assertions: `compile scales sub-quadratically` went green only on the run whose
    100-node baseline was 15.5 ms against 4.5–5.0 ms everywhere else, and the layout bound's
    500-node sample twice came back *faster* than its 100-node one. **The replacement in both
    cases was a deterministic counter** — a `Proxy` counting the property reads the code makes —
    which is byte-identical run to run and ten times tighter than the timing it replaced. Where a
    timing must stay, make it ONE absolute bound with an order-of-magnitude margin, never a ratio.
    **This entry has now carried a claim that did not reproduce three separate times, always about
    this same measurement**, which is why it states the rule and not a fourth set of numbers.

---

## G · Field-survey work the redesign creates

Each traces to a decision in `DESIGN.md`.

- **G.1 · Declared effects (D2) for `evaluator` bodies and the sandbox.** Done for `function`
  nodes: `FunctionNode.effects` names the tools a body may invoke, `reachableToolNames` sees them,
  and the body gets one bound invoker per name through `ctx.effects`. **Still open** for
  evaluators and for sandboxed bodies — a resource-loaded body runs synchronously inside
  `vm.runInContext` and cannot await, so `ctx.effects` is honestly absent there rather than
  broken. Giving a sandboxed body effects means an async bridge, which is its own design and is
  §A.10's prerequisite too.
- **G.2 · `Date` in the realm.** It stays absent, and **the reason changed**: not "no seed could
  make it reproducible" but "a frozen `Date` that silently never advances is more surprising than
  an absent one". Restoring it means binding the whole constructor to `ctx.now`. **Bind `Temporal`
  in the same change** when it becomes a default global.
- **G.3 · Divergence must be terminal and loud.** The known failure mode of every replay-based
  runtime is a silent stall: the task retries forever without entering a failed state.
  `E_REPLAY_DIVERGENCE` is fatal, so the recorded-effect path is covered. **A repeated divergence
  signature with no forward progress still needs its own terminal state.**
- **G.4 · Two-axis labels (D4): unlabelled ⇒ untrusted.** Both axes now exist — `tainted`/
  `applyTaint` for integrity, `carriesSecret`/`applySecretFlow` for confidentiality. **The
  valuable half is the one this codebase does not have**: a tool that is not `isExternal` writing
  data from anywhere is untainted today. Branch-coordinate scoping was built and reverted; see
  `DESIGN.md` D4 for what would reopen it.
- **G.5 · Prompt text into the artifact hash (D7).** `graphHash` digests the spec, so a ref'd
  prompt's text is not in it — **a prompt edit currently changes what a resumed run does,
  silently.**
- **G.6 · Proposed-API mechanism and a version pin (D5).** Both halves unbuilt: no proposed-API
  declaration file, no opt-in, no publish-time refusal for an extension that uses one, and no
  runtime version pin.
- **G.7 · One retry budget per run**, decremented across every layer. Engine retry × provider
  retry × agent-loop retry currently multiply, and nothing decrements across them.

---

## H · Housekeeping

- **H.1 · `bin/loom` is gitignored and goes stale on any source edit.** **The silence is fixed**:
  `scripts/binary-freshness.cjs` refuses when the sources beside the binary have moved, and it
  distinguishes "no sources" from "sources I cannot read" rather than passing on either. **Still
  open:** nothing rebuilds the binary automatically, so the standing condition remains — after a
  source edit, `npm run build:binary` before trusting `bin/loom`.
- **H.2 · The 2026-08-29 renumber broke thirteen in-tree citations of this file; all are
  repointed.** Recorded as a set rather than described, because two of them had the dangerous
  shape — after the renumber they resolved to a *plausible, unrelated, live* row instead of to
  nothing, which is worse than dangling. `src/run/engine.ts:7096` cited `§B.1` for a compensation
  gap and landed on `LeasedScheduler`; `test/deployment/boot-banner.test.ts:18` cited `A.15` for
  the suite flake and landed on `RUN_CLOCK_SCAN_CEILING`.

  | was | is now | sites |
  |---|---|---|
  | `§A0` | `§A` | `DESIGN.md` ×3 |
  | `§A0` | `§A.21` | `test/cli/suite-freeze.test.ts` |
  | `§D.4` | `§Z` | `src/run/engine.ts`, `test/run/cancel-does-not-wait.test.ts`, `test/run/operator-steer.test.ts` |
  | `§D.14` | `§Z` | `README.md`, `test/readme-gaps.test.ts` |
  | `§B.1` | `§A.30` | `src/run/engine.ts` |
  | `§E.1` | `§B.1` | `src/cli.ts` |
  | `A.15` | `A.20` | `test/deployment/boot-banner.test.ts` |

  Four citations were checked and left alone because they still resolve: `§E.2` (`src/cli.ts`) and
  §F items 11, 12 and 13, which survived because §F is a numbered list whose numbering did not
  move. **The command that enumerates the whole set**, so the next renumber can run it first:
  `/usr/bin/grep -arno 'TODO\.md[^"]\{0,4\}§\?[A-Z]0\?\.\?[0-9]*' packages/core/src packages/core/test scripts *.md`
  — and running it BEFORE renumbering is the cheap half of the lesson §F.1 states about pointers
  into enumerations.

---

## Z · Closed 2026-08-25 → 2026-08-29 — do not re-fix these

The register. Each line names what closed and the commit carrying the argument; `git show <sha>`
is the citation, and it is durable in a way a working-notes directory is not.

**Answered by DELETION (a decision, not a shortfall).** `JoinNode.timeoutMs` and
`E_JOIN_TIMEOUT` (`21be5ce`) — a barrier deadline's undecidable case has no journaled answer, and
every branch already has an enforced bound at its own locus; the "waits forever" hole itself moved
to §A.9 rather than going with the field, **and §A.9 is now closed** — that argument was only true
of a branch whose author had written a number, and a default node deadline is what made it true of
every branch. `FunctionNode.cpuBound` and
`GRAPH019_CPUBOUND_NO_EFFECT` (`aaa8e3b`) — measured 1.997x wall for two independent nodes and
5.989x for four on 16 cores, exactly serial; work that needs a process goes out as a TOOL.
`journal/retention.ts`, its 26-test suite and its 15 pinned exports (`d57c984`) — argued on
property 3, not on storage: a terminal run's journal **is** the corpus self-improvement measures
over. `ApprovalSpec.mode`, `.k`, `.delegation`, `DelegationSpec` (`583ecd9`) — quorum was never
missing; `join{mode:"quorum", k}` over N `human_gate` nodes does k-of-n today, measured, and
`examples/graphs/two-person-approval.json` ships the composition. Two `effect.started.kind`
members (`d078368`), one of them a feature `DESIGN.md` explicitly refuses; the union is six.
`TenantId`, `ProjectId`, `Budget.tenantUsd` (`065a9e1`) — three types waiting on a question now
answered. **`run.cancelled.forced`** — the field is gone; `run.cancelled` now carries `clean` and
`unknownEffects` only. Its own docstring had said "decided for deletion" while §D assigned it to a
`kill` verb, and those could not both be acted on; the operator lane then measured that `cancel`
does not wait (`test/run/cancel-does-not-wait.test.ts`), so `kill` as specified is a second name
for `cancel` and the field was not being held for anything.

**Answered by REFUSAL, permanently.** Admission control — `POST /runs` admits everything it can
authenticate and always will, because under one tenant the right answer to "too much work" is to
make it wait, never to say no; `E_ADMISSION_REJECTED` stays deleted and so do a queue-depth field,
a token bucket and the `loom.schedule.admit` span. What shipped instead is a CEILING:
`--max-runs-in-flight` (default 4), with the surplus waiting and `runClockTick`'s widened `due`
predicate re-deriving it from the journal. The circuit breaker (`378e965`) — a breaker's verdict
is a per-source failure count SPANNING RUNS and `StateStore.read(runId, fromSeq)` addresses the
journal per run, so no fold can reconstruct it; three false claims about it were deleted and what
shipped is the sightline, `providerNotice`, one latched stderr line down and one back.
`preAuthorization` (`e42c572`) — six of its seven parts already exist as orthogonal mechanisms
that bind, and the `metadata` scope was closed so the refusal is total.

**Built.** The operator's levers (`cc64481`): `loom deescalate` — the one verb that LOWERS
oversight, with no `--force` and no way to skip `--why` — plus `--max-runs-in-flight`,
`--max-parallelism`, `--budget-usd/-tokens/-wall-ms`, each refusing to boot on a malformed value.
`pause`/`resume`/`steer` as journaled facts that survive a restart. The fork ledger's two missing
doors (`cc320d1`): `--extension-module` gives a provider on any wire and an in-process tool a
CLI-reachable seam, moving README's fork-required list from seven to five — **the first time that
list has moved the right way.** Compensation runs. Payload externalisation runs. The evolution
loop is closed end to end against a live provider.

**Two floors that read as claims about a node and were claims about its declaration** (`f5a047e`,
`02d3db0`). §A.9 — a node declaring no `timeoutMs` had NO deadline, measured as `Engine.advance`
unsettled at 1,500 ms on one `tool` node and never going to settle; `NodePlan.timeoutMs` now
carries an effective deadline for `agent`, `tool` and `evaluator`, the engine reads the PLAN, and
`loom compile` prints it with `declared` or `default`. The commit names why each of the other five
node types gets none. §A.7 — `reachableToolNames` does not descend, and it still does not: the
descent is `reachableToolNamesThrough` in `graph/validate.ts`, folded into the parent's class
floor, capability ceiling and mutation gate. **Billed honestly: it closed no oversight hole** — the
child always gated on its own floor — what it bought is the parent's missing
`policy.escalated{rule: mutation_introduced_irreversible}` record, a human asked before the child
does reversible work, and an `E_CAP_DENIED` that was a run-time death becoming a compile
diagnostic.

**Fixed defects whose measurement is no longer needed to read the residue.** A gate decision that
retried; every plane calling itself `worker-0`; the run clock's rotation cursor living in process
memory; the auditor guarding a run's start and not its end; `foldRun` never folding `model.called`;
`ctx.now()` not reproducing on replay; hook bodies getting the real `Math.random()`; a static
sibling-branch join double-counting; gate payloads served unredacted on six routes; a router `when`
expression reaching `Object.prototype` (and the same read in the VALIDATOR, where GRAPH004
accepted `constructor` as a declared channel); a truncated model turn written as `""` and reported
`succeeded`; `cohortKeyOf` making every run its own cohort of one; `gateCandidate` promoting a
candidate that passed nothing; `loom score` folding every peer without its graph; the promotion
gate failing open on a prompt candidate; `loom score` reporting outcome 0 for a run whose graph it
could not resolve; a cancelled run that kept scheduling (`a64b05b`); a tool manifest's
irreversibility class checked by the type system alone (`55c653d`); a declaration one level inside
`retry` discarded, turning a bounded retry unbounded (`bd6ef8b`); an unknown key inside `humanGate`
dropped in silence, on the one block oversight exists for (`cf491fe`); the thenable refusal living
in one loader of two (`347cb98`); the global proxy's prototype being the host's, so a body reached
the host realm and the wall clock (`c69356c`); `L4-gated-at-least-as-much` having no end-to-end
coverage, and the live promotion refusal blaming a missing measurement where a run was parked on a
human gate (`test/cli/promote-live-gates.test.ts`); a truncation refusal that named neither the
ceiling nor which of two failures it was — `turnRefusal` now discriminates on `contentChars === 0`
and tells the operator to raise the ceiling by an order of magnitude rather than a margin
(`99557f7`); the compiler's silence about a secret-laundering hop, now `GRAPH014_SECRET_LAUNDERED`.

**The defect class that accounted for nearly every real finding, stated once because it will
recur:** *a guard answering its undecidable case with the passing value.* Members: `gateCandidate`
certifying a candidate it never ran; 0% vs 0% satisfying "non-inferior"; an empty suite reported
valid; an audit rule firing on healthy journals the product itself writes; a cost ratio over a zero
baseline reported as "1.00x"; a deferral budget that bounded everything except the last deferral;
`loom score` reporting outcome 0 for a run whose graph it could not find; and a ratio-of-timings
gate that passed hardest when its baseline was worst. Several were introduced by the session that
found them and caught by its own reviewers.
