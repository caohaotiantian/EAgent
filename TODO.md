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

`§Z` at the bottom is the register of what was closed 2026-08-25 → 2026-09-01 and must not be
re-fixed. It is short on purpose: the argument for each closure lives in the commit that made it,
and the sha is the citation.

---

## State — measured 2026-09-01, one command each

| fact | value | command |
|---|---|---|
| tests | **2,708 pass, 0 fail** | `node --test "packages/*/test/**/*.test.ts"` |
| pinned public exports | **528** | `scripts/surface.json` (`check-surface.mjs` needs `dist/`, which needs a build) |
| kernel | **10 files, 8 declared seams** | `node scripts/check-kernel.mjs` |
| zero runtime deps | green, **61 source files** | `node scripts/check-zero-dep.mjs` |
| source files in `packages/core/src` | **61** | `find packages/core/src -name '*.ts' \| wc -l` |
| tracked files carrying a NUL byte | **5**, and **0** invalid UTF-8 | census over `git ls-files` — see §F.15 for why grep cannot count these |
| wall-clock-dependent assertions in the suite | **none** | `abb1e01`, `8b9182f` — see §F.17 |

**The seam census is 8 and has not moved across the whole of this effort.** `check-kernel.mjs`
reports `193 commits since 86b84c9, 8 declared seams`. The two `feat` commits of the last three
waves (`50f7c03`, `8482859`) touch `cli.ts` and `evolution/live.ts`, neither of which is one of
the ten pinned files, so no `Kernel-seam:` trailer was written.
`git log --grep='^Kernel-seam:'` is the ledger and it is not a number anyone can quietly reset.

**The roadmap is NOT closed, and the line here that said so was about the wrong list.** Items 1–8
are the record and all eight pass; `DESIGN.md` then wrote items **9–13** on 2026-08-29, and four
of those five still name a command that fails. **Item 11 is the one that closed** — `hermetic`'s
third conjunct has a producer, and `test/run/hermetic-names-the-live-bodies.test.ts` is 13/13
green on the pair the item specified. Items **9, 10, 12 and 13** were each re-run at this commit
and each still fails; the reproductions are in `DESIGN.md` beside the items. Three have a backlog
row here — item 9 is §A.30, item 10 is §A.1, item 13 is §A.15. **Item 12 has none, deliberately:**
its subject is `README.md`'s fork ledger, whose two DEBT rows it closes, and §E's closing
paragraph is explicit that the ledger is not to be re-enumerated in this file.

---

## What is still open, by section

**Recounted 2026-09-01 by running the grep, not by arithmetic on the previous number** — which is
the only method that has ever produced a right answer here. Every column below comes from one of
these three commands, and a reader who does not believe a cell should run them rather than argue:

```bash
# every row id, in order — §A–§E and §G–§H
/usr/bin/grep -aoE '^- (~~)?\*\*[A-Z]\.[0-9]+ ' TODO.md | /usr/bin/grep -aoE '[A-Z]\.[0-9]+'
# the struck subset, which is what "closed" means in this file's convention
/usr/bin/grep -aoE '^- ~~\*\*[A-Z]\.[0-9]+ '  TODO.md | /usr/bin/grep -aoE '[A-Z]\.[0-9]+'
# §F is a numbered list and is counted its own way
/usr/bin/grep -acE '^[0-9]+\. \*\*' TODO.md
```

**Three columns, because one was the bug.** The old table had a single `rows` number and no rule
saying whether a struck-through row counted, so it drifted every time a row closed: it said **27**
for §A against **31** present rows and **25** unstruck ones — a number matching neither reading —
and **1** for §H against **3**. A closed row is kept on purpose (§Z's header says why), so "rows
present" and "rows still open" are different facts, and a table that states only their difference
can be wrong without being falsifiable.

| section | rows | struck | still open | the shape of it |
|---|---|---|---|---|
| §A | 31 | 9 | 22 | open defects, unguarded behaviour, and two deliberate non-defects recorded so nobody "fixes" them |
| §B | 2 | 0 | 2 | declared and wired to nothing — down from 13 |
| §C | 5 | 1 | 4 | unbuilt observability |
| §D | 5 | 2 | 3 | decisions still owed, all of them narrow |
| §E | 8 | 0 | 8 | deferred on purpose, with the reason — do not silently revive |
| §F | 17 | — | — | properties to preserve, not history to honour; nothing here is "open" |
| §G | 7 | 0 | 7 | field-survey work the redesign creates; G.1, G.4, G.5 and G.7 are part-done and each names which half remains |
| §H | 4 | 1 | 3 | housekeeping |

The struck members, so the column is checkable and not merely asserted: **§A** A.3, A.4, A.5,
A.16, A.17, A.22, A.27, A.28, A.33; **§C** C.5; **§D** D.2, D.4; **§H** H.2.

**The §A numbering has two holes and they are not errors.** A.7 and A.9 are absent because both
closed and moved bodily into §Z, where the argument for each closure is the commit. Ids are never
reused — §H.2 is the record of what a renumber cost the last time one happened.

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
  `engine.ts:1199` argues it at length — an undo that policy answers `gate` must be REFUSED, or
  compensation becomes the back door that performs an irreversible action a gate would have
  stopped. **Re-measured 2026-09-01, and it got WORSE rather than going stale**: flipping the
  seventh argument at `engine.ts:1457` (`#compensateOne`'s single `#invokeTool` call) from `false`
  to `true` and running the WHOLE suite — not just `run/`, which is what the earlier reading of
  this row did — leaves **2,708/2,708 green**. The original number was 1047/1047 over
  `packages/core/test/run/*.test.ts`; that directory is 1061 tests now and the wider run says the
  guard is unobserved everywhere, not merely in its own neighbourhood. A guard nothing would
  notice the deletion of is not yet a guard. **Closes when** a fixture drives a rollback whose
  undo tool policy answers `gate`, and asserts `compensation.recorded {failed}` rather than a
  performed undo. **The two line numbers in this row moved once already** — they were `1153` and
  `1273` — which is the argument for citing the SYMBOL (`#compensateOne`, the `nodeApproved`
  paragraph above `#compensate`) beside the line, and it is now done.

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

- ~~**A.16 · What else is process-local and unreconstructable?**~~ **CLOSED — the sweep is done
  and the set is named in `cli.ts`.** Ten long-lived mutable
  producers, each classified above `runDispatcher` with what reads it and what a restart costs;
  the set was closed by a census of every module-level binding (`workspaceOrdinal` is the only
  mutable one of thirty-seven) plus every container construction that outlives its call. **Nine
  lose only work.** The tenth, `planeWorkerId`'s counter, loses a bounded WAIT — §A.17.
  **What the sweep found that a re-fold does not repair, and it is not a container at all:** a
  plane that dies between `task.leased` and `task.committed` leaves that task `leased` forever,
  so `runClockTick`'s `due` predicate never offers the run again. Measured — in view, never
  driven, with a control — in `test/deployment/run-clock-survives-restart.test.ts`. Widening the
  predicate would not help, because `InProcessScheduler.eligible` returns `ready` tasks only;
  it is a cost of **§B.1** and is recorded there.

- ~~**A.17 · A plane that RESTARTS cannot reclaim its own pre-restart leases.**~~ **CLOSED —
  measured, and the number is written at `planeWorkerId`.** Driven against
  `LeasedScheduler.select` with `leaseMs` 30,000: a restarted plane's wait is **exactly one
  `leaseMs`** (first eligible at `at + leaseMs + 1`, the boundary being inclusive-live), it
  applies **only** to tasks that are `ready` while still carrying a lease, and it is **zero** for
  a task that was genuinely `leased` — `reclaimable` expires every holder including the one that
  took it, so there was no head start to lose. Less in practice: the residual is
  `max(0, leaseMs - downtime)`. **Accepted rather than fixed**, because no identity does better:
  a name stable across a restart that still separates two live planes on one host is not
  derivable from `hostname:pid`, and not from the journal either — nothing journals a plane
  starting or stopping, so a fold cannot tell "A restarted" from "B booted beside A". Anything
  stronger is a coordinator, and D.2 is single machine / single tenant. Pinned by
  `test/deployment/two-planes.test.ts`, which goes red if the identity is made stable — that
  direction re-opens the double-execution defect the identity fix closed.

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

- ~~**A.22 · `loom score`'s `! N run(s) folded without their graph` line is a backstop with no
  end-to-end test.**~~ **CLOSED by `fabc360` — the branch is reachable, and its message was
  wrong.** The route was the one
  stated: a peer that reached the cohort key through `graph.mutated` while its spec is looked up
  by `run.submitted`'s hash. Driven, not argued — `compileMutation` builds a successor as
  `{...spec, nodes: [...nodes, ...added]}`, so a graph that is a PREFIX of another compiles to
  the other's hash exactly (`sha256:dd019089…` + one node = `sha256:bf1f5820…`), and a run of the
  unpublished parent joins the published child's cohort. The fixture is in
  `test/cli/evolution-score.test.ts`, and on its first firing it caught the note printing the
  FOLDED hash — the successor, which is the judged run's own published graph — under "publish
  those graphs". `Trajectory.authoredGraphHash` is the repair.

### The self-improvement loop — what it still cannot see

- **A.23 · HALF CLOSED. The `maxTurns` shape is refused; the `policy.budget` one is not, and the
  blanket refusal was measured rather than argued.** The turns half needed no new evidence: a
  candidate that lowers `agent.maxTurns` leaves recorded effects UNSERVED, `ReplayReport` has
  carried `unservedEffects` all along, and `unexercised` was not reading it. It now refuses, and
  every control stays green including the function-body candidate. The budget half is worse than
  unimplemented — the obvious fail-closed answer, refusing any different-graph candidate that
  declares a budget, turns the gate off for every well-formed graph: `test/run/skeleton.ts`'s own
  `summarize` declares `policy: {budget: {costUsd: 0.15}}` (`skeleton.ts:73`), and so do nodes in
  **both** of the graphs the loop is actually driven on — `examples/graphs/review-bench.json` and
  `examples/graphs/self-review.json`, two `costUsd` occurrences each — while
  `GRAPH009_UNBOUNDED_NODE` tells authors to ADD that field to any spending node
  (`graph/validate.ts:1962`, and `evolution/gate.ts:310` says so where the refusal would go).
  **So "refuse a candidate whose policy the offline gate cannot exercise" is not free: it turns
  the offline gate into a refuse-everything gate for every well-formed graph.** That is the
  measurement, and it is the reason this half is carried rather than attempted again.
  The narrower refusal is not
  expressible either, because the recording's SPEC is not in the journal (A.24), so nothing can
  tell "the candidate lowered the ceiling" from "it kept it and changed a body". **Closes when**
  replay can serve an adapter's answers, i.e. A.1's seam. Stated with the numbers at
  `unexercised`.

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

- **A.26 · The Wilcoxon bound is built; the repeated-runs half is not.** It needed no table:
  under the null the differences are sign-symmetric, so `W⁺ = Σ Zᵢ·i` with `Zᵢ` iid Bernoulli(½)
  and its distribution is a subset-sum count over the ranks — twenty lines, and checked against
  the published one-sided 0.05 table at n = 5…20 and 25 (seventeen exact agreements; the
  eighteenth, n = 30, is the table being loose — `P(T ≤ 152) = 0.050199` against
  `P(T ≤ 151) = 0.048051`). `L1-paired-improvement` now requires the t bound AND the
  Hodges–Lehmann bound to clear 0, and each binds where the other does not. **What is left is the
  second strengthening — repeated runs per input**, so within-input model variance separates from
  between-graph difference; no statistic computed from one run per input can see it, and neither
  bound removes the SYMMETRY assumption (the signed-rank null IS sign symmetry — what it removes
  is normality). **Closes when** the mode can run an input more than once.

- ~~**A.27 · The live cost check divides TOTALS where D10.d says medians.**~~ **CLOSED by
  `50f7c03`, and corrected by `160985c` — the median gates in the LIVE mode; the replayed one
  still cannot express one.** §D.4 is decided: a pair's ratio is `candidate / baseline` when the baseline spent
  anything, 1 when neither side spent, and UNBOUNDED when a free input became a paid one — the
  limit of the ratio, not a convention, and a median is an order statistic so it never does
  arithmetic on it. That makes the rule total, which is what the "a check that sometimes has no
  answer" objection was asking for; the old code met that objection by not gating at all, and the
  reviewer's six-pairs-at-$0-baseline-and-$100-candidate fixture went from PROMOTE at "1.00×" to
  `ran: false` to a refusal. The total is reported in the detail. `gateCandidate`'s `3-cost` is
  untouched and still divides `EvalReport` totals, because that type has no median to divide —
  see its docstring; closing THAT needs a `medianCostUsd` where `p95WallMs` already is.
  **AND THE FIRST VERSION PICKED THE WRONG MIDDLE, which is worth keeping because the gate read
  as built while it was still off for half its domain.** `Math.floor((length - 1) / 2)` is index 2
  of 6 — the permissive side — so at an even count THREE pairs could go from a $0 baseline to a
  paying candidate and `3-cost` still passed: driven, `3 × $0 → $100` plus `3 × $1 → $1` reported
  `median pair cost ratio 1.00x` and PROMOTED while its own passing line printed
  `totals 303.000000 vs 3.000000`. The upper median (`Math.floor(length / 2)`, `live.ts:435`) is
  what makes "half the pairs went from free to paid" refuse. A check closed at 6-of-6 and open at
  3-of-6 is not a check, and only an even-count fixture could show it.

- ~~**A.28 · A saturated outcome ranks cheapness.**~~ **CLOSED by `a0f0cec`.** The original
  reading is kept in full, because the MEASUREMENT is what made it findable and the escape it
  names is still the only real one. Measured on five real runs sharing a cohort:
  every one had `outcome: 1`, `costNormalized` clamps at the cohort median, two ranked and three
  tied at exactly 0.600, unrankable — and `isGolden` condition 2 is "top decile", so a saturated
  outcome makes that read "the cheapest decile". The cause is **S2, the human gate decision**
  (`DECISION_VALUE.approve = 1` at weight 0.9), not S5, whose weight is 0.0. **A workflow whose
  only signal is human approval cannot rank its own runs.** The escape is a ground-truth signal
  and it is measured, not argued: `examples/graphs/review-bench.json` drives S1 to `k/n` and the
  score then reads correctness rather than cheapness. **CLOSED by the first of the two:**
  `CohortStats.outcomeSpread` measures the saturation and `isGolden` condition 2 refuses the rank
  on it, so the verdict reads UNRANKABLE instead of crowning the cheapest run. The SCORES are
  unchanged — the score was not what was wrong, the rank was — and `loom score` prints the
  refusal at the terminal as well as journaling it in `goldenBlockers`. What cannot be fixed here
  stands: a workflow whose only signal is human approval still cannot rank its own runs.

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

- **A.30 · What is still uncovered, after the run-failure sites and child runs were wired.**
  `#edgesToTake` still has `case "compensation": break;` — **deliberate**, because rollback is
  journal-driven (an effect needs undoing whether or not an author drew an edge, and an edge names
  a NODE while a rollback must name a CALL); the arm now carries that argument where a reader
  reaches it. **Closed since 2026-09-01:** every `run.failed` site compensates, because there is
  now exactly one — `Engine.#failRun`, which all three exits of `#finish` call, so the
  unmaterialised fan-out and `E_OUTPUT_MISSING` roll back for the same reason a failed task does;
  and `#compensate` DESCENDS INTO CHILD RUNS, splicing each child's plan into the parent's reverse
  walk at the seq of the parent's own `subgraph.started` (the only order across two journals the
  journal can justify), rebuilding the child's context from the parent's frozen
  `subgraphs[ref]`, and journaling `not_attempted` **in the child's journal** where it cannot.
  `test/run/compensation-reaches-children.test.ts` fails without both halves.
  **Also closed since, by `160985c`, and each was a guard recording a thing as handled when
  nothing had handled it:** a rollback made every CHILD journal fail the repo's own audit
  (`loom audit <childRunId>` said `3 violation(s)` on a rollback the engine had just performed
  correctly, because a child is already terminal when its parent fails — `audit.ts` gains an arm
  opened only by `effect.started{kind:"compensate"}`, not a relaxation); a TRANSIENT block was
  settled as if structural (`planCompensation` settled a seq on any `compensation.recorded`, so
  planning after "this engine cannot rebuild the child's graph" gave `steps= 0  settled= [8]` —
  a zero-step plan produced by following the row's own advice — and `compensation.recorded` now
  carries an optional `retryable`, absent meaning not retryable so every existing journal settles
  exactly as it did); and a GRANDCHILD's effects were dropped in silence, `#compensateChild`
  having journaled one level and returned.
  **A residue of `#compensateOne`, narrower than the row it came from and still there:** the
  "no `effect.completed` recorded at all" case is now `not_attempted` with a reason, but a record
  that EXISTS and carries no `details` still yields `args = {}` at `engine.ts:1450`, because
  `effect.completed.result` is typed `unknown` and nothing constrains it. An undo invoked with no
  arguments is not a refusal. **Closes when** that case is `not_attempted` too, which is one arm
  and the same fail-closed shape its three neighbours already use.
  **Still open:**
  - **A REWIND ACROSS A `subgraph` NODE IS PERMITTED BECAUSE THE CHILD DECLARED AN UNDO, AND
    THEN DOES NOT RUN IT.** This is `DESIGN.md`'s Sequence item 9 and it is the one the child
    descent above did NOT close — driven again at this commit, one `subgraph` node whose child
    charges `pay.refundable` (irreversible, `compensation: {tool: "pay.refund"}`), then
    `engine.rewind(runId, 1)`: `status succeeded  charges [42]` → `rewind refused: no` →
    `charges [ 42 ]  refunds []`. **The reason is now sharper than when the item was written, and
    it is an ordering of two guards rather than a missing feature.** `#uncompensatedIrreversible`
    DOES descend into child runs, so the permission crosses the boundary; `#compensate` DOES
    descend into child runs since `7c8b89c`, so the machinery to run the undo exists. What sits
    between them is `rewind`'s entry condition at `engine.ts:2980`,
    `if (plan.steps.length > 0 && live !== undefined)`, where `plan` is `planCompensation` over
    **the parent's own events only**. A parent that delegated has zero steps of its own, so the
    descent that exists is never entered. **Closes when** that condition asks whether there is
    anything to undo ANYWHERE under the run — which is the same question
    `#uncompensatedIrreversible` already answers one screen above it, in the opposite direction.
  - **`JoinNode.onBranchError: "compensate"`**, refused at compile by
    `GRAPH008_COMPENSATE_UNIMPLEMENTED`. What it would take is recorded at `#absorbedByJoin`:
    a BRANCH-PATH scope the planner does not have (its only scope is `sinceSeq`, and branches
    interleave in seq by construction — that is the planner's central claim, not an oversight);
    a trigger in the failing Task's commit rather than at the barrier; and a fourth answer from
    `#absorbedByJoin`, because a branch is contained only if its rollback actually cleaned up,
    which `boolean` cannot say. The refusal deletes in the same change.
  - **A DETACHED PARENT whose steps are all blocked** journals nothing, because the
    `not_attempted` rows go through a `RunContext` that cannot be rebuilt without the graph. The
    child-run case of this is now closed — `#logFor` writes the rows without a context — and the
    same move would close the parent's, which is why this is smaller than it was.
  - **§F.13 AT `#finish`**, which the collapse into `#failRun` makes easier to believe is fixed
    and is not: a task LEASED BY ANOTHER WORKER is still producing while the rollback runs. Both
    callers can be reached with one — the budget/fatal floor, and the drain path, which sees an
    empty READY set when a peer holds every lease — and `ctx.abort` reaches only this process.
    Closing it needs a way to fence a lease this engine does not hold.
  **Whether an author should ALSO get a graph-level cleanup node on failure is a design question,
  not a wiring gap** — §D.3.

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
  **THE ROW NOW HAS A PRICE, found by §A.16's sweep and measured rather than argued.** A plane
  that dies between `task.leased` and `task.committed` strands that run permanently: the fold
  puts the task back in `leased`, `runClockTick`'s `due` predicate wants a `ready` one, and
  `InProcessScheduler.eligible` would return nothing even if the clock did offer it. Driven on a
  real journal truncated after its `task.leased` —
  `status: running, tasks: [apply@root#0 leased] · run clock visited: 2 · drove: []` — with a
  control run one event shorter that IS driven, in
  `test/deployment/run-clock-survives-restart.test.ts`. **Reclaiming it needs a lease DEADLINE,
  which is the one signal that separates a dead holder from a slow one, and `LeasedScheduler` is
  where that lives.** So "delete it" is no longer free: it deletes the only design in the tree
  for a crash-stranded task.

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

- **C.1 · Six designed span names are unbuilt, and five of the six are closed decisions
  rather than open work.** **`loom.effect` was built 2026-09-01** and the count went 7 → 6 by a
  build. **Nine names are minted now**: `loom.run`, `loom.gate`, `loom.task`, `loom.policy`,
  `loom.effect`, `loom.state.reduce`, `loom.checkpoint` — the seven that
  `/usr/bin/grep -an 'name: "loom\.' packages/core/src/telemetry/spans.ts` returns — plus
  **`loom.model` and `loom.tool`, which that grep misses**, because both are minted through one
  ternary. So the grep undercounts the built set by TWO, and the seventh literal it does see
  used to be the `subgraph.started` arm saying `loom.tool` — the mis-classification itself.
  **`loom.effect` used to carry the opposite trap**: `loom.effect.key` is an ATTRIBUTE, so a
  bare `grep -c` on it returned nonzero and read as built while no span bore the name.

  **What `loom.effect` fixed.** `effect.started.kind` is a closed six-member union
  (`model | tool | subgraph | summarize | random | compensate`) and the fold partitioned it with
  `modelish` and its NEGATION — but `!modelish` is not `tool`. Measured by driving a `function`
  body of `Math.random()` through `Engine`: the PRNG seed the engine journals so a body can be
  replayed folded to `loom.tool  effect.kind=random  tool.name=undefined`, a seed draw named a
  tool call, and it carried `tool.attempt` too. `subgraph` had the same defect, papered over in
  `cli.ts` by printing the kind in parentheses. The partition is now three arms:
  `model|summarize → loom.model`, `tool|compensate → loom.tool` (a compensation IS a tool call —
  `#callTool` journals `tool.called` on both paths), `subgraph|random → loom.effect`. NOT a
  generic parent over all four: that would either double the span count this file's header
  budgets or delete the `gen_ai.*`/`tool.*` groupings that are the reason those names exist.

  **The remaining six, each with the event that would have to exist.** The constraint is that
  `spansFrom` is a pure fold over one journal, so a name is buildable only if the journal
  already covers it.
  - **`loom.request`** — no journal event covers ingress; the first append is `run.submitted`.
    Not fixable by an event: a request is accepted before a runId exists, so it has no journal
    to go in. Needs a durable stream that is not keyed on a run.
  - **`loom.compile`** — **not "possible but redundant", MEASURED IMPOSSIBLE.** `run.submitted`,
    `run.compiled`, `run.started` and the entry `task.ready`s are ONE append (engine.ts:1526,
    the only site), and `journal/store.ts`'s `prepare` stamps one `ts` per batch. Driven with a
    clock ticking +7ms per call, all four came back `ts: 1700000000014`, so a span bracketed
    submitted→compiled is zero-width by construction. Worse, `compileOrThrow` runs in the
    CALLER — `engine.submit` receives an already-compiled graph — so `run.compiled` records the
    RESULT of work that finished before the journal existed. Its three attributes are already
    on `loom.run`. Would need a `durationMs` on `run.compiled`, i.e. a `journal/events.ts`
    change, which is the kernel.
  - **`loom.schedule.pick`** — the INTERVAL is journaled (`task.ready` → `task.leased`, and
    C.3 notes the wait is already a span event on `loom.task`); the DECISION is not. The name
    means "which task did the scheduler choose, out of what queue, against what limit", and
    three of its four designed attributes (`queue.depth`, `concurrency.used`,
    `concurrency.limit`) are scheduler state no event carries. A span minted with one of four
    would manufacture C.2 defects. Needs a `schedule.picked` event carrying those three.
  - **`loom.context.assemble`** — `run/context.ts` assembles and journals nothing.
  - **`loom.replay`** — the gap is TWO deep, not one. `replayRun` submits a shadow run through
    the ordinary `engine.submit`, so its journal carries no marker; and the shadow lives in a
    fresh `MemoryStateStore` (replay.ts:640) that dies with the call, so there is no durable
    replay journal to fold at all. Needs an optional `replayOf: RunId` on `run.submitted` —
    which has optional-field precedent in `submittedBy` — plus a durable shadow store.
  - **`loom.scheduler.tick`** — C.3, and a design gap rather than a wiring one: there is no
    tick loop in `run/scheduler.ts` to instrument.

  **The two movements of this count are different things and the row says which is which.**
  8 → 7 was a DECISION: `loom.schedule.admit` is not among the six because §D refused admission
  control permanently, so the name has no subject and never will — nothing was built and nothing
  is owed. 7 → 6 was a BUILD: `loom.effect` is minted and folded. A backlog count that falls
  because work landed and a backlog count that falls because the work was cancelled are the same
  arithmetic and opposite facts, and a row that reports only the number reports neither.

- **C.2 · Three of the eleven are built; the remaining eight are NOT DERIVABLE, and that
  falsifies this row's own premise rather than shrinking it.** The row used to say eleven
  documented span attributes are set on no built span *and* that "every one of them is a value the
  journal fold already has in hand". `deafe43` tested the second half by trying to build all
  eleven. **It is false for eight of them, and this row must be read as a correction and not as a
  tick.**

  **Three were journaled fields this fold already read the event for and discarded** — a span
  poorer than the journal by accident. `policy.decided.capability` → `capability` on `loom.policy`;
  `gate.raised.batch.id` → `gate.batched` on `loom.gate`; `effect.started.attempt` →
  `tool.attempt`, on the `loom.tool` arm only. Reproduced by folding a journal carrying all three
  (`capability: "fs:write"`, `batch.id: "g0"`, `attempt: 3`) and finding none on any span; driven
  on the one that varies today, `gate-saturation`'s five-branch fan-out now gives five
  `loom.gate` spans all reading the founder's gate id. **Two of the three are faithful reads of
  DEAD WRITERS and saying so is the point:** `run/engine.ts` builds both `policy.decided` payloads
  literally and neither includes `capability`, and all five `effect.started` writers pass the
  literal `1`.

  **Eight are not in the journal at all**, each for a stated reason, and a span attribute carrying
  a guess is worse than an absent one: `node.type` (only on `task.started`, which has no writer —
  §B.2); `budget.cost_usd` (the ceiling is never journaled; `budget.reserved`/`budget.settled`
  have no writer either); `reducers` (`channel.written` has no writer, and `state.reduced` carries
  channels rather than reducers); `trigger.kind` (nothing journals a trigger —
  `run.submitted.submittedBy.kind` is WHO, and relabelling it is a different fact under a
  documented name); `gen_ai.request.max_tokens` (`model.called` journals a `requestDigest`, never
  the request; the spelling was checked against the OpenTelemetry gen_ai conventions and is right,
  the value is absent); `tool.source` (no `source` on `ToolManifestLite`, `ToolDefinition` or
  `tool.called` — the concept is not in the tree); `loom.replayed`, on both its spans (a served
  effect appends nothing, and a replay rewrites `model.called.provider` to the recorded leaf **on
  purpose**, so a replayed journal is designed to be indistinguishable); `gate.posture` (a
  constant `"in"` reached by pairing two events — a constant obtained by an inference is both
  things this file refuses).

  **The grep this row was previously re-verified with was itself an undercount, which is why the
  eleven must be counted two ways.** `/usr/bin/grep -ac '"<attr>"'` returns 0 for `capability` at
  HEAD even though it IS set, because `spans.ts` writes it as a bare identifier (`capability:`,
  `spans.ts:798`). Counting both spellings —
  `/usr/bin/grep -aoE '"(budget\.cost_usd|…|gate\.batched)"|(^|[^.\w"])(capability|reducers|trigger|source)\s*:' packages/core/src/telemetry/spans.ts`
  — returns exactly three today: `capability:`, `"gate.batched"`, `"tool.attempt"`. The control
  that proves the grep discriminates rather than failing silently is still
  `state.hash.before`/`state.hash.after`, **2 each**, set on `loom.state.reduce` and not on the
  span the source table used to blame.

  **Closes when** each of the eight either gains the journal event it needs — which is a
  `journal/events.ts` change and therefore a seam, for every one of them — or is struck from the
  documented set with the reason above beside it. **It does not close by emitting them.**

- **C.3 · No scheduler-tick telemetry, and there is no tick loop to instrument.** A design gap,
  not a wiring gap. **Per-task queue wait is already measurable** — `task.ready` and `task.leased`
  are journaled for every task and `spans.ts` attaches `task.leased` as a span event, so the p99
  is a fold over what is already emitted. What is missing is scheduler-level behaviour.

- **C.4 · There is no OTLP exporter in the repo and no HTTP trace endpoint**, so
  `SpanLink.traceId` has no consumer outside the splice. The subgraph link is built and
  `loom trace` follows it; nothing off this machine can. **Closes when** an exporter exists — and
  it belongs outside the core, which takes no runtime dependencies.

- ~~**C.5 · The span taxonomy was NOT grown for subgraphs: a subgraph renders as `loom.tool`.**~~
  **CLOSED by `aaa4a9a`, and NOT by adding a name — §D.2 was answered "no ninth name".** The
  original reading was right about the defect and wrong about the remedy: `subgraph.started` did
  open a span named `loom.tool`, and every attribute a reader needs (`effect.kind: "subgraph"`,
  `subgraph.child_run_id`, `.ref`, `.graph_hash`, `.budget_usd`, a `SpanLink`) was already on it.
  What was actually broken was the partition — the fold split a six-member union with `modelish`
  and its NEGATION, and `!modelish` is not `tool` — so `subgraph` and `random` both landed on
  `loom.tool` for the same reason. Three arms fix all of it: `model|summarize → loom.model`,
  `tool|compensate → loom.tool`, `subgraph|random → loom.effect`. `subgraph.started` now opens
  `loom.effect` at `spans.ts:993`, and the two literals that can name that span agree by
  construction because `start` is a no-op on an open id — if they disagreed, a span's name would
  depend on which events a read happened to contain. Driven:
  `test/telemetry/subgraph-trace-driven.test.ts`, 2/2, selecting the span by
  `attributes["effect.kind"] === "subgraph"` rather than by name — which is the check that shows
  a ninth name was never what the reader needed.

---

## D · Decisions still owed

**§D's re-check table carried 22 rows (`D.0`–`D.21`); five remain, renumbered `D.1`–`D.5`, and
of those five only THREE are still owed — `D.1`, `D.3`, `D.5`.** `D.4` was answered by
`50f7c03` and `D.2` by `aaa4a9a`; both are struck below and kept, because a decision's argument is
the thing a future reader needs and deleting the row deletes it.
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

- ~~**D.2 · A ninth span name for a subgraph.**~~ **ANSWERED: no ninth name.** The question was
  whether the span taxonomy is a closed vocabulary. It is, and the decision landed with the code
  in `aaa4a9a` rather than as a note: a subgraph is named by the existing `loom.effect` and told
  apart by `effect.kind`, which is how the shipped test already selects it. **The alternative was
  rejected on a measurement, not on taste** — a generic parent over all four effect kinds would
  either mint a second span per effect (doubling a row count `spans.ts`'s own header budgets at
  "~500 task spans, not 2,500") or rename `loom.model` and `loom.tool` out of existence, losing
  the `gen_ai.*` and `tool.*` groupings that are the reason those two names are worth having.
  A parent whose only content is the union of its children is an indirection, not a taxonomy.

- **D.3 · Whether an author gets a graph-level cleanup node on failure**, beside journal-driven
  rollback. Compensation edges are a compile-time declaration by design (§A.30); this asks whether
  there should also be a node an author can point at.

- ~~**D.4 · Whether the median gates, and what an undefined pair does to it.**~~
  **ANSWERED by `50f7c03`: the median gates, and an undefined pair is UNBOUNDED rather than
  dropped.**
  See §A.27 for the rule and `pairedCostRatio` in `evolution/live.ts` for the derivation. The
  live mode gates on the median pair; the replayed one still divides totals because `EvalReport`
  carries no median, and that divergence is now stated at both `3-cost` docstrings rather than
  read as one rule implemented twice.

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
2026-08-25/26, not on 2026-09-01.** The two facts re-checked today are E.1's — `LeasedScheduler`
still has no construction site anywhere in `src/`
(`/usr/bin/grep -arn 'LeasedScheduler' packages/core/src` returns only its own definition in
`run/scheduler.ts` and four docstring mentions in `cli.ts` and `engine.ts`; see §B.1) — and E.5's
fork-list membership, where `README.md` still names **a reducer** among the five things that need
a fork. **A reason nobody has re-run in a week is still the best evidence there is for these, and
it is not the same as a measurement taken now.** The gap has widened by four days since this
paragraph was written, which is exactly the fact it exists to expose rather than to excuse.

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
- **G.4 · Two-axis labels (D4): unlabelled ⇒ untrusted. DONE on the integrity axis, 2026-09-01.**
  Both axes exist — `tainted`/`applyTaint` for integrity, `carriesSecret`/`applySecretFlow` for
  confidentiality — and `isExternal` no longer defaults to trusted. It is now a named set of pure
  types (`router`, `join`, `human_gate`) plus two label reads: a `function` is untrusted unless it
  declares `effects: []`, and an `evaluator` splits on `kind`. `agent` is unconditionally
  untrusted, which widened the old `tools: []` arm. Reproduction and the label's limits (it
  declares ORIGINATION and never launders) are in `test/run/unlabelled-is-untrusted.test.ts`.
  **What is left is the CONFIDENTIALITY axis**: `applySecretFlow` still reads the declared
  classification, so an unclassified channel carrying a secret is still trusted by default, and
  the fix there is not symmetric — there is no `effects: []` equivalent, and marking every
  unclassified channel sensitive is the constant-gate failure that arm's docstring already
  refuses. Branch-coordinate scoping was built and reverted; see `DESIGN.md` D4.
- **G.5 · Prompt text is bound by the MANIFEST, not by the hash (D7). Closed 2026-09-01, and the
  row as written was half stale.** `graphHash` is still `digest(spec)` and a ref'd prompt's text
  is still not in it — that part was always true and is deliberate. What the row got wrong is the
  conclusion: the text is bound anyway, by `RunGraph.resolutionManifest`, which pins every ref to
  a CONTENT digest and is journaled on `run.compiled`. Reproduced through the shipped binary at
  the top level: run a workspace graph to a gate, edit `resources/prompt/writer.md`, and
  `loom approve` refuses — `E_GRAPH_MISMATCH: … matches run …'s spec, but the resources behind
  its refs have changed since it was compiled`. Three doors check it (`Engine.#assertBound` on
  gate decisions and on `advance`, and `replayRun`'s `refsBound`), and `RunGraph.documents`
  freezes the bytes by value so `#documentFor` asks no resolver at run time.
  **What was NOT bound, and is the half that was real: a SUBGRAPH's own refs.**
  `resolveManifest` walked only the root spec while `resolveSubgraphs` walked children
  recursively, so a parent naming `subgraph/child@stable` pinned that ref and nothing inside it —
  the child's `prompt/…` and `function/…` were in neither the manifest nor `documents`, and
  `Engine.#compileChild` (which runs during `advance`, while the parent's Task is executing) fell
  through `frozenFirst` to the LIVE resolver. Reproduced in ONE process with no restart: a
  promotion landing between `submit` and `advance` reached a running node, the model was sent the
  edited prompt, and the run reported `succeeded` — nothing refused, because
  `run.compiled.resolutionManifest` named only the subgraph ref. Fixed in `graph/compile.ts` by
  walking the frozen child specs into the manifest; `frozenFirst` then serves them, so no engine
  change was needed. `graphHash` is untouched **on purpose**: `cohortKeyOf` keys on it, so the run
  is pinned and the cohort is not, and the evolution loop can still compare two runs of
  `review-bench` across a prompt edit — which is the one candidate kind D6 defines self-improvement
  as producing. Test: `test/resources/store.test.ts`, "THE PINNING RULE REACHES INTO A SUBGRAPH".
  **Residue, both narrow and both pre-existing:** (a) `#assertBound` checks the manifest only when
  the attached graph IS the compiled one, so a MUTATED run's successor carries no recorded manifest
  to compare — the engine says so where the gap is, and mutation is unreachable from the binary
  today; (b) `#compileChild`'s docstring still says a child's own refs "go to the live resolver on
  every compile", which this change makes false for every child `resolveSubgraphs` collected — the
  claim about `tools.manifests()` in the same paragraph is unaffected and still holds.
  **(b) is the only part of this row still open, and it is a FALSE CLAIM rather than a missing
  one, which is the worse kind.** Re-checked at this commit by reading both sides:
  `engine.ts:5655` still says `resolveManifest` "walks only the PARENT's nodes, so the child's own
  `function/…` and `prompt/…` refs miss the frozen map", while `compile.ts:294` now calls
  `resolveManifest(input, subgraphs)` and its own line 288 says "the manifest pins the refs of
  these child specs too". A reader who trusts the engine comment will conclude the freeze is
  weaker than it is and may re-fix something already fixed. **Closes when** that paragraph is
  rewritten to keep the `tools.manifests()` half and drop the refs half.
- **G.6 · Proposed-API mechanism and a version pin (D5).** Both halves unbuilt: no proposed-API
  declaration file, no opt-in, no publish-time refusal for an extension that uses one, and no
  runtime version pin.
- **G.7 · One retry budget per run. THE MULTIPLICATION IS GONE; THE BUDGET WAS NOT BUILT, AND
  that is the decision rather than the omission.** The rationale named three layers and there
  were two: the agent loop ADDS rather than multiplies (a completed turn is served from the
  journal under `<taskId>:model:<turn>`), and a 429 never multiplied either because `postJson`
  rethrows it without a hold. What did multiply was engine node retry × provider transport retry,
  measured through the engine on one agent node against a permanent 503:
  `{requests: 9, retriesScheduled: 2}`.

  A fourth `Budget` dimension would have touched `graph/spec.ts`, `run/policy.ts` and
  `run/engine.ts` — three kernel files, so a `feat` needing a seam — to buy what deleting the
  duplicate layer buys for nothing. `HttpOptions.maxAttempts` now defaults to 1, so the engine's
  journaled curve is the only one: `{requests: 3, retriesScheduled: 2}`, same journal, a third of
  the traffic. Pinned both ways in `test/run/retry-does-not-multiply.test.ts`.

  **What that cost, named.** An embedder driving an adapter with no engine above it loses two
  silent pre-response retries and gets the retryable error instead; `maxAttempts: 3` restores the
  old curve exactly. Nothing about a mid-stream failure moves — `postJson` never retried past the
  first byte. The one shape that genuinely loses a retry is a `RunGraph` whose `plans` a caller
  assembled WITHOUT the compiler: `#retryDecision` returns on `policy === undefined`, and the
  transport was the only retry such a graph had.

  **Reopen a run-scoped budget if fan-out width turns out to be the real multiplier** — it is
  still a free variable, and 3 requests × a wide fan-out is the same arithmetic one level up.

---

## H · Housekeeping

- **H.0 · A delegating chain now raises one gate per level, and that was the maintainer's call.**
  Closing A.7 means `top → mid → leaf` over an irreversible child asks a human three times where
  it asked once. Put to the maintainer with the alternatives (gate only the outermost; revert to a
  compile diagnostic only) and **decided: keep it.** The argument that carried it is consistency —
  a non-subgraph graph already asks at every node that transitively reaches the tool, so the old
  behaviour was the subgraph route being LOOSER, not the new one being stricter — plus the human
  being asked BEFORE the child does reversible work rather than at the innermost irreversible
  call. **What would reopen it:** an operator reporting that nested delegation is unusable in
  practice. The mechanism to reach for then is one approval covering a chain, which needs a rule
  for what happens when the chain's shape changes mid-run, and that is a new decision rather than
  a tuning knob.



- **H.1 · `bin/loom` is gitignored and goes stale on any source edit.** **The silence is fixed**:
  `scripts/binary-freshness.cjs` refuses when the sources beside the binary have moved, and it
  distinguishes "no sources" from "sources I cannot read" rather than passing on either. **Still
  open:** nothing rebuilds the binary automatically, so the standing condition remains — after a
  source edit, `npm run build:binary` before trusting `bin/loom`.
- ~~**H.2 · The 2026-08-29 renumber broke thirteen in-tree citations of this file.**~~
  **CLOSED by `814e283` — all thirteen are repointed.** Kept, not deleted, because the TABLE is
  the thing a future renumber needs and the command at the end of it is the cheap half of the
  lesson. Recorded as a set rather than described, because two of them had the dangerous
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

- **H.3 · `effectiveTimeout`'s docstring names a set of three and then enumerates four.** Found
  while re-checking §Z's deadline claim, and it is §F.8 inside the comment written to satisfy
  §F.8. `graph/compile.ts:163` says "**THE SET IS `agent`, `tool`, `evaluator`**" and "why the
  other **five** do not"; the bullets below it describe four members (`function` is the fourth,
  added by `ff4888d`) and the next heading says "**THE FOUR** WITHOUT ONE". The CODE is right —
  `effectiveTimeout` at `compile.ts:206` tests all four — so nothing is mis-executed; what is
  wrong is the two summary numbers, which are the only part of a 45-line comment a hurried reader
  takes away. **Closes when** both read four, and the fix is two words. Recorded rather than done
  because this lane owns `TODO.md` and `DESIGN.md` and not `src/`.

---

## Z · Closed 2026-08-25 → 2026-09-01 — do not re-fix these

The register. Each line names what closed and the commit carrying the argument; `git show <sha>`
is the citation, and it is durable in a way a working-notes directory is not.

**Closed 2026-09-01, the last three waves.** (§A.7's and §A.9's own closures are the "Two floors"
paragraph below; what `ff4888d` added to both is that the deadline default had skipped the one
body type with no realm — `function`, excluded first on a false argument and added after a
reviewer drove a hand-registered async body hanging forever — and that the subgraph descent was
order-dependent and now keys on `reachedAt`.) The promotion gate: the saturated ladder (`a0f0cec` — §A.28), the paired
cost median (`50f7c03`, corrected at `160985c` — §A.27), the improvement bound (`8482859` —
§A.26's first half), the no-graph note (`fabc360` — §A.22), and the `maxTurns` half of §A.23
(`a702063`). `loom.effect` is minted and the fold no longer names a PRNG seed draw `loom.tool`
(`aaa4a9a` — §C.5 with it). Three span attributes the fold read and threw away (`deafe43`).
Compensation reaches children and every `run.failed` exit — of which there is now exactly one
(`7c8b89c`) — and a rollback no longer fails the repo's own audit, a transient block is no longer
recorded as settled, and a grandchild's effects are no longer dropped (`160985c`). Unlabelled ⇒
untrusted on the integrity axis (`5bff93b` — §G.4's first half). A subgraph's own prompt was read
live while the parent's task was executing (`0f605a9` — §G.5). Transport retry collapsed into the
engine's journaled curve, 9 HTTP requests per dead turn down to 3 (`683d928` — §G.7). And a
malformed `effects` value could claim the PURITY label: `isExternal` asked
`effects === undefined || effects.length > 0`, so `null` and `""` read as "declared, and empty" —
the author's claim that a node is pure computation — while `{}`, `0` and `{length: 0}` crashed
`reachableToolNames`, the helper the capability ceiling, the unknown-tool diagnostic and the
oversight floor all share. Refused at compile and failed closed in `isExternal` (`7e889a1`).
**None of these opened a row here, and that is deliberate: a defect found and closed inside one
wave is history, not backlog.**

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
carries an effective deadline for **`agent`, `tool`, `evaluator` and `function`** — four, not the
three `f5a047e` shipped. `ff4888d` added the fourth after the exclusion's argument was driven and
found false: `functions.register("function/hang@stable", async () => new Promise(() => {}))` on a
node declaring no `timeoutMs` gave `STILL HANGING after 1500ms`, the identical reproduction that
opened the item for `tool`. The engine reads the PLAN, `loom compile` prints it with `declared` or
`default`, and the FOUR that get none — `router`, `join`, `human_gate`, `subgraph` — each carry a
stated reason at `compile.ts`'s `effectiveTimeout`. §A.7 — `reachableToolNames` does not descend, and it still does not: the
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
