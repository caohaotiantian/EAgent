# TODO

Everything unfinished, self-contained. **Nothing here is a plan** — the roadmap is `DESIGN.md`'s
Sequence, the decisions live in the commit history, and this file is only the list of what is
still true and still open.

## How to read this — four rules

- Rule 1 — **Reproduce by RUNNING, not by reading.** Every row carries the command that settles it;
  a row you cannot run is a row you must not write.
- Rule 2 — **Name the set a claim covers.** A count nobody can enumerate is a count nobody checked.
- Rule 3 — **A self-describing claim has no fixed point.** State the invariant, not the
  measurement, when the claim is about the artifact containing it.
- Rule 4 — **Every row states what would close it.** A row with no closing condition is a row
  nobody owns; delete it with an argument instead of carrying it.

Convention: a row struck through (`- ~~**A.N …**~~`) is CLOSED and must not be re-fixed. Row ids
are stable — other files cite them — so a closed row keeps its id rather than being renumbered
away. `§Z` is the register of closures with the sha that carries each argument.

---

## State — one command each, re-run 2026-09-09 on `45294b4`

| fact | value | command |
|---|---|---|
| the gate | **exit 0** | `npm run check` |
| tests on `loom` | **3,611 pass / 0 fail** | `npm test` |
| pinned exports | 540 | `node scripts/check-surface.mjs` |
| kernel | 10 files pinned, 12 declared seams | `node scripts/check-kernel.mjs` |
| zero runtime deps | ok, 66 files | `node scripts/check-zero-dep.mjs` |
| NUL census | 5 files, 0 invalid UTF-8, of 463 tracked | read every `git ls-files` path; see CLAUDE.md |

The kernel guard also prints a commits-judged count (581 at `45294b4`). It is deliberately not a
cell above: it moves with every commit, this file's own included — rule 3.

**Every wave lane is merged into `loom`.** `CLAUDE.md`'s Layout lists the merge shas and
`git merge-base --is-ancestor <sha> loom` is the check per lane — a merge that REPORTS merged is not
evidence the work arrived (§A.14). `docs/handoff-2026-09-09.md` is the current handoff.

## Row census — three commands, run on this file

```bash
/usr/bin/grep -aoE '^- (~~)?\*\*[A-Z0-9]+\.[0-9]+ ' TODO.md   # every row
/usr/bin/grep -aoE '^- ~~\*\*[A-Z0-9]+\.[0-9]+ '    TODO.md   # the struck (closed) subset
/usr/bin/grep -acE '^[0-9]+\. \*\*' TODO.md                   # §F, a numbered list, counted its own way
```

"Rows present" and "rows still open" are different facts; a table stating only their difference can
be wrong without being falsifiable, which is why there are three columns.

| section | rows | struck | still open | the shape of it |
|---|---|---|---|---|
| §A0 | 17 | 9 | 8 | the phase-2-4 merge's remainder, plus what the 2026-09 waves recorded rather than fixed |
| §A | 36 | 21 | 15 | open defects, unguarded behaviour, and two deliberate non-defects recorded so nobody "fixes" them |
| §B | 2 | 0 | 2 | declared and wired to nothing — down from 13 |
| §C | 5 | 2 | 3 | unbuilt observability |
| §D | 6 | 4 | 2 | decisions still owed, both narrow |
| §E | 8 | 0 | 8 | deferred on purpose, with the reason — do not silently revive |
| §F | 19 | — | — | properties to preserve; nothing here is "open" |
| §G | 7 | 0 | 7 | field-survey work the redesign creates |
| §H | 5 | 4 | 1 | housekeeping |

The 2026-09-02 audit's 207 findings are NOT copied into the rows below; the record is
`docs/audit-2026-09-02.md`.

---

## A0 · Reproduced and NOT fixed

- ~~**A0.5 · A channel named `toString` still compiles clean.**~~ CLOSED at `3cfd363`.
- ~~**A0.8 · `#edgesToTake`'s exhaustiveness claim is false.**~~ CLOSED at `6b3513b`.
- ~~**A0.14 · A model with no price row and no dated base still prices 0.**~~ CLOSED at `3656d69`.
- ~~**A0.16 · Three injection paths are live on `loom`, on no register row.**~~ CLOSED at `02a5e84`.
- ~~**A0.17 · `POST /runs` accepts the input the CLI refuses.**~~ CLOSED at `86193e3`.
- ~~**A0.18 · A flake in `test/server/plane-watch-and-stop.test.ts`.**~~ CLOSED at `4bc3ce1`.
- ~~**A0.19 · A NODE id may still be an `Object.prototype` name.**~~ CLOSED at `878001c`.
- ~~**A0.20 · The mirror-gate asymmetry.**~~ CLOSED at `6b3513b`. `GET /gates` still lists both
  rows; that listing is the disclosed residue and its decision is unmade.
- ~~**A0.21 · A router's `take` selects a `compensation` edge and walks past a human gate.**~~
  CLOSED at `ff8fdac`.
- **A0.12 · A permanently-undriveable stranded run recompiles the whole workspace on every tick.**
  Repro: `/usr/bin/grep -anc 'graphsByHash(ws).index' packages/core/src/cli.ts` → 4. `runClockTick`'s
  `due` predicate counts a `leased` task, so a run whose graph hash no longer resolves, or whose
  leased node is one of the four types with no enforced deadline (`join`, `router`, `human_gate`,
  `subgraph`), sweeps the whole workspace on every tick and drives nothing — measured at ~10× per
  tick over 31 published graphs, scaling with WORKSPACE size rather than with the stranded run.
  **Closes when** the compiled index is cached with an invalidation rule that keeps a republished
  graph visible, or an unresolvable hash is memoised with an expiry; restricting the `leased` arm to
  nodes declaring a `timeoutMs` is not available, because the clock cannot read a node's deadline
  without the graph it is trying to resolve.
- **A0.13 · The usage floor's dollar residual is ~10×, and no function of the two numbers a wire
  reports can close it.** Repro:
  `node --test packages/core/test/providers/usage-per-rate-floor.test.ts` → 9 pass / 0 fail, five
  named `ORDINARY`. The `=== 1` defeat closed at `49624c0` and the ~80× compounding at
  `dcf54c9` (`dearestRateFloor` in `providers/usage.ts`, a `Math.max` beside the sum floor). What
  remains is the raw cacheRead-to-input rate ratio, and it is structural: the adversary's optimum is
  `cacheCredit` close to `estimated`, and a wire claiming a full cache hit reports the identical two
  numbers as an honest one. **Closes with** a cap on credited cache tokens at the tools-plus-system
  prefix the request body actually marks `cache_control` on — which needs real cached-deployment
  measurement to parameterise without breaking the honest-hit pins — or with an explicit decision to
  accept ~10× as inherent. Two carriers ride with it: an operator price table pricing cacheWrite
  below input reopens the compounding on the write dimension (`dearestRateFloor` assumes
  `inputTokens` is the dearest rate); and a genuine partial hit with a small honest remainder is
  over-charged, ~5% on one fixture, pinned as `ORDINARY 5 (NOT unchanged)`.
- **A0.22 · The delegation door still permits the input the plane now refuses.** Repro:
  `/usr/bin/grep -anc 'Object.hasOwn(child.channels, childCh)' packages/core/src/graph/validate.ts`
  → 2. `rule016Subgraphs` tests a `subgraph` node's mapping against the child's `channels`, never its
  `inputs`, and `Engine.#runSubgraph` submits that map — so a parent may hand a child exactly the key
  `POST /runs` refuses at the wire (§A0.17) and `loom run --input` has refused since `8c734ce`.
  **Closes when** §D.6 is settled, and not before: keying `rule016Subgraphs` on the child's `inputs`
  tightens the delegation, while §D.6's option (f) keys all three doors on `channels` and relaxes the
  plane instead. They are opposite directions and the decision is §D.6's.
- **A0.23 · The seventh cross-run child touch is unwrapped, and still answers `E_INTERNAL`.** Repro:
  `/usr/bin/grep -an 'const childP = await this.advance(childRunId)' packages/core/src/run/engine.ts`
  → one hit, inside `#runSubgraph`. `5fe7614` wrapped five cross-run touches so another run's store
  failure is never this run's answer; this call is the one it did not, and the lane measured
  `failAt=3..6 => status=failed err=E_INTERNAL` — not retryable, so one transient read of another
  run's disk permanently fails the parent's delegation and starts a compensation cascade over the
  parent's irreversible effects. The honest reason it is open is scope: an earlier draft claimed
  wrapping it would swallow a cancel, and driving the guard showed that is false. **Closes by**
  giving this call the same two-way treatment the other five got, with the ordinary half measured.
- **A0.24 · `gates.ts` keeps its idempotency entry after a non-`E_SEQ_CONFLICT` throw.** Repro:
  `/usr/bin/grep -an '#idempotency.set\|#idempotency.delete' packages/core/src/run/gates.ts` — the
  `set` precedes `log.commit` and the catch deletes it again only for `E_SEQ_CONFLICT`; every other
  throw leaves the entry behind, against the comment two lines above ("NOTHING LANDED, so nothing
  may be remembered as landed"). Consequence: the cross-run WRITE `#resolveGateAsSystem` retries
  into a broker answering from the stale entry, so §A0.23's sibling retry is inert for the life of
  the process. It self-heals on restart, which is why this is a defect and not a member of the
  journal-authority list. **Closes by** deleting the entry on ANY throw, with a test that a second
  delivery after a store failure actually commits.
- **A0.25 · `E_SUBGRAPH_FAILED` carries six raises of two different meanings.** Repro:
  `/usr/bin/grep -anc 'childUnavailable' packages/core/src/run/engine.ts` → 8, and the set comment
  above them says so in the file. `childUnavailable` raises the code for the three cross-run touches,
  so "only the poll can reach it" is no longer true and four of the six raises are retryable. The
  cost: an `onlyIf` keyed on `E_SUBGRAPH_FAILED` can no longer separate "still working" from "the
  child's disk is broken", and a DETERMINISTIC child-journal alarm (`E_TRACE_INCONSISTENT` out of
  `projection`) is deferred as if it were a disk. **Closes with** a new `CODES` member for the
  unreachable-child arm and the `RETRYABLE`/`onlyIf` sets re-derived against it.
- **A0.26 · The kernel guard's merge coverage is conflict-resolving merges only.** Repro:
  `git show --name-only --format='' 878001c | wc -l` → 0, while the same command on `fbbdac4` prints
  seven files. `706b88a` made the CENSUS count a `Kernel-seam:` trailer on any subject via `git
  interpret-trailers --parse`, which is how `fbbdac4` reached the ledger — but the guard only looks
  at commits that TOUCH a pinned path, and git prints no paths for a clean merge, so a trailer on a
  clean merge is still invisible. Two carriers: the REQUIREMENT path still classifies subjects with
  its own `FEAT` regex rather than with git's parser, so the two paths disagree about what a
  declaration is; and a sub-`MIN_SEAM_CHARS` trailer on a non-`feat` subject is dropped in silence
  where the same trailer on a `feat` subject is a violation. **Closes when** the guard reads a
  merge's effective diff (`git show --name-only -m`, or `--first-parent` against each parent) and
  the two paths share one definition of a trailer.
- **A0.27 · The `mcp__` reservation holds at `register()`, and two things beside it do not.** Repro:
  `/usr/bin/grep -anc 'reservePrefix' packages/core/src/run/registry.ts` → 5. `9cf88b5` moved the
  reservation into `ToolRegistry.#doRegister`, so a registration made from a timer, a library embedder
  or any later verb is refused. Two residue items its lane recorded and did not fix.
  (a) **Overlapping prefixes are not checked** — `reservePrefix` throws only on an EXACT duplicate,
  so a module that registers one benign tool and then calls `reservePrefix("mcp")` can make the
  legitimate `mcp__` registration fail with attacker-authored text in an operator-facing
  `E_CONFIG_INVALID`. Fail-closed denial of service, not an escalation. **Closes by** refusing a
  `reservePrefix` whose argument is a prefix of, or prefixed by, one already reserved.
  (b) **Only `name` is snapshotted** — `list()`, `manifests()` and every downstream reader of
  `.irreversibility` and `.capabilities` re-read the caller's object, so a getter that flips AFTER
  registration shows the boot banner, the manifest map and the posture computation a different value
  than the one checked. An `irreversibility` flip is a live oversight-posture bypass. **Closes by**
  freezing every `ToolDefinition` field at registration, not just the name.

---

## A · Open defects and unguarded behaviour

### The replay-fidelity class

- ~~**A.1 · Three token/cost refusals cannot be re-derived by a replay.**~~ CLOSED — the `quote`
  member of `effect.started.kind`, seam trailer `a8d62fb`; `test/run/replay-fidelity.test.ts`.
- ~~**A.2 · A replay grades no MESSAGE, so a path-dependent refusal diverges in silence.**~~ CLOSED
  by `34a7f14`. `details` is deliberately not graded.
- ~~**A.3 · Three sites named the wrong set for "a journal with no `provider`".**~~ CLOSED — all
  three now name the window (journals written before `e6d00f2`); the behaviour cannot change.
- ~~**A.4 · `hermetic`'s third conjunct had no producer in `src/`.**~~ CLOSED — `bodyEntered` at
  FETCH plus `carryRealmBrand` in `resources/functions.ts`.
- ~~**A.5 · Two kernel files stated a set as total and were not.**~~ CLOSED — both now state the
  PROPERTY, and `sla.reminders[i]` is named `GateReminderSpec` so it sits inside the drift guard.
- **A.6 · A pass-through value with a two-faced `then` getter still crosses the realm boundary, and
  it is left open deliberately.** Repro:
  `/usr/bin/grep -anc 'WHAT IT STILL DOES NOT CATCH' packages/core/src/resources/realm.ts` → 1, and
  that heading names the two members. Member 1 (a `Map`) IS caught, by the canonicalizer refusing a
  `Map` at all; the survivor is member 2 — `rebuild` returns a value as-is whenever its prototype's
  constructor is not named `Object`, i.e. every class instance. Measured through the hook loader at
  `callTimeoutMs: 100`: `PASS-THROUGH CROSSED at 1 ms; host proto? false`, then `AWAIT resolved at
  1945 ms`. **No read closes it** — reading `.then` host-side runs the getter on the host thread,
  the hazard the gate exists to avoid. **Closes only by** refusing every non-plain return outright
  (deleting the canonicalizer message member 1 depends on) **or a process boundary** — the same limit
  A.10 ends on, and they should be paid for once.

### Oversight, and the places a floor is weaker than it reads

- ~~**A.34 · `Engine.rewind` had no floor.**~~ CLOSED — `by: HumanActor` with no default and
  `E_HUMAN_APPROVAL_REQUIRED` as the first check, unconditionally; the route is a 403 for a service
  token and for an open plane.
- ~~**A.35 · A rewind's authorization is blind.**~~ CLOSED (seam `52da0e8`) — `planRewind` +
  `GET /runs/:id/rewind-plan`, both halves needing a human, preview and dispatch sharing ONE
  `#planRollback` walk, and a per-run chain serialising concurrent rewinds. `rewind-plan.test.ts`.
- ~~**A.8 · The compensation dispatch's `nodeApproved: false` is load-bearing and nothing tests
  it.**~~ CLOSED at `552d999` — `nodeApproved: trigger === "rewind"`, with the fixture that goes red
  in both directions in `compensation-fires.test.ts`.
- **A.10 · An async body cannot be bounded by any deadline, so it is refused.** Repro:
  `/usr/bin/grep -anc 'ASYNC_RULE' packages/core/src/resources/realm.ts` → 7 — the refusal is stated
  once at the seam. `vm`'s timeout covers synchronous execution only, so the refusal is correct.
  **Closes when** there is a process boundary to run one in — the same prerequisite as §F.10, and it
  should be built once for both.
- **A.11 · A 429 arriving after a non-idempotent `effect.started` with NO `effect.completed` refuses
  both a retry and a deferral.** The world may already have changed and the journal cannot say. The
  one row of the rate-limit table that stays red, deliberately — *refusing is always allowed.*
  **Closes when** the journal can distinguish "the effect ran" from "the effect may have run", which
  is a different item and probably A.1's seam.
- **A.12 · A deferral counts toward E4's consecutive-failure streak.** `#recordEvidence` runs before
  the retry decision, so a long rate-limit outage escalates a node's posture sooner than it used to.
  **Left alone deliberately: not counting it would be LOOSENING oversight.** Recorded so the next
  reader does not "fix" it. **Closes only** if somebody argues that a provider being busy is evidence
  about the node — and that argument has to be made, not assumed.

### Bounds and backpressure

- ~~**A.13 · `loom run`'s `MAX_BACKOFF_WAITS` is 64 and a deferral can be up to 60 s.**~~ CLOSED by
  `96a03bf` — the CLI waits on a journal predicate (`seq` not moving) rather than a wait count.
- ~~**A.14 · `run.submitted.inputs` is the last inline copy of a payload.**~~ CLOSED (`6d830d7`,
  `eba2a63`) — `run.submitted.external` names which inputs left the journal and the trajectory fold
  puts them back as handles, so `defaultBucket` cannot split a cohort on a 64 KiB threshold.
- ~~**A.15 · `RUN_CLOCK_SCAN_CEILING`'s residual.**~~ CLOSED (seam `3762a0e`) — `RunFilter.after`
  and a paged `runClockTick`, which throws `E_CONFIG_INVALID` the first time a page boundary repeats.
  The constant has no declaration left in `src/` — its two mentions are comments. `run-clock-window.test.ts`.
- ~~**A.16 · Process-local and unreconstructable state.**~~ CLOSED — the set of ten is named in
  `cli.ts`; nine lose only work, the tenth is A.17.
- ~~**A.17 · A plane that RESTARTS cannot reclaim its own pre-restart leases.**~~ CLOSED — measured
  at exactly one `leaseMs` and accepted, because no identity does better under §D.2's single-machine
  answer. `test/deployment/two-planes.test.ts`.

### Boundaries that are unexamined rather than broken

- ~~**A.18 · A branch choice made from untrusted content raises nothing.**~~ CLOSED by `b2f4002` —
  control taint folded at the deciding commit, keyed on the CHOICE rather than on `node.type` after a
  reviewer drove four bypasses; the covered set is named at `choiceOf`.
- **A.19 · "Partial reads of untrusted values remain in ~25 files" names no predicate, so it cannot
  be re-derived.** Repro: `/usr/bin/grep -arl 'Array\.isArray' packages/core/src | wc -l` → 34 today
  — a different set measured a different way, evidence neither for nor against 25. The row's one
  runnable claim was corrected 2026-09-02: of the three files `resources/realm.ts`'s docstring names
  as each carrying a private array guard, only two do — `telemetry/spans.ts`'s `isList` and
  `run/delivery.ts`'s `isArrayValue`; `security/redact.ts` defines neither
  (`/usr/bin/grep -anc 'isList\|isArrayValue' packages/core/src/security/redact.ts` → 0), and its
  four `Array.isArray` sites are ordinary. **Closes by deletion with that argument, OR by naming the predicate** (which read
  counts as a partial read of an untrusted value?) and re-deriving the set from it. Until one of
  those happens it is a row nobody can check, which is the thing it warns about.
- ~~**A.20 · A rare suite flake: four sightings, never reproduced.**~~ CLOSED — a 0.28–0.32 ms
  window between `announce`'s last banner line and `serveUntilInterrupt` installing the SIGINT
  handler, in which `stop()` was a KILL. `harness.ts`'s `awaitStoppable` proves the handler exists by
  one answered `/health`; `stopVerdict` refuses a signal death by name.
  `test/deployment/boot-banner.test.ts`.
- **A.20 (superseded) · the four-sighting record.** No separate work: superseded by the struck A.20
  above, and kept only because the id is cited. Repro and closing condition are that row's.

### Guards over states nobody has constructed

- **A.21 · `suite freeze`'s unresolved-gate exclusion is a guard over a state nobody has
  constructed.** Repro: mutate the exclusion away and run
  `node --test packages/core/test/cli/suite-freeze.test.ts` → 9/9 still green (the case "every frozen
  case carries the safety invariant" says so in its own prose). A run must be `succeeded` AND
  `delivered` to reach that line, and `gateShapeOf` counts a gate unresolved only when its folded
  state is neither `decided` nor `cancelled`. Two possibilities wanting different answers: the state
  is unreachable for an eligible run (delete it and say why), or it is reachable by a path nobody has
  found (build the fixture). **Closes when** somebody decides which, by construction rather than by
  argument.
- ~~**A.22 · `loom score`'s `! N run(s) folded without their graph` line has no end-to-end test.**~~
  CLOSED by `fabc360` — the branch is reachable (a prefix graph compiles to its successor's hash) and
  its message named the wrong hash; `Trajectory.authoredGraphHash` is the repair.

### The self-improvement loop — what it still cannot see

- ~~**A.23 · The `maxTurns` shape is refused; the `policy.budget` one is not.**~~ CLOSED by
  `276e05c` — `11-budget-exercised` refuses a candidate that MOVED a ceiling the replayed corpus
  never crossed. Residual: `GraphPolicy.expansion` is not compared — raising all four 100× promotes.
- **A.24 · `run.compiled` carries node counts, not the spec.** Repro:
  `/usr/bin/grep -anc 'resolutionManifest' packages/core/src/journal/events.ts` → 1, and the payload
  beside it is `{graphHash, nodes, edges, resolutionManifest}`. So a trajectory's S1/S4/S5 depend on a
  file on disk and `isGolden` reads a value the journal cannot reconstruct across a restart — the
  first non-negotiable. Both the peer-fold fix and `loom score` work around it by threading a
  filesystem index into the fold. **Closes when** `run.compiled` carries the spec, or a graph store
  the journal can address does.
- **A.25 · A promotion's subject is a graph and the store is keyed by runId.** Repro:
  `/usr/bin/grep -anc 'evolution.promote' packages/core/src/cli.ts` → 3. The decision rides on
  `operator.command {kind: "evolution.promote"}` appended to the FIRST case's run, with `caseRunIds`
  naming the rest; the live mode makes the same borrow, anchoring on the first selected baseline run.
  Never on a candidate run — hanging the record of a judgement inside the thing being judged is a
  different defect. **Closes when** §D.5 is answered: whether the kernel needs a graph-scoped durable
  fact, and whether that is one event type or a second keyspace.
- **A.26 · The Wilcoxon bound is built; the repeated-runs half is not.** Repro:
  `/usr/bin/grep -anc 'L1-paired-improvement' packages/core/src/evolution/live.ts` → 3.
  `L1-paired-improvement` now requires the t bound AND the Hodges–Lehmann bound to clear 0, and each
  binds where the other does not. What is left is the second strengthening — repeated runs per input,
  so within-input model variance separates from between-graph difference. No statistic computed from
  one run per input can see it, and neither bound removes the SYMMETRY assumption (the signed-rank
  null IS sign symmetry; what it removes is normality). **Closes when** the mode can run an input
  more than once.
- ~~**A.27 · The live cost check divides TOTALS where D10.d says medians.**~~ CLOSED by `50f7c03`,
  corrected by `160985c` — `pairedCostRatio` gates on the UPPER median, an undefined pair unbounded.
  `gateCandidate`'s `3-cost` still divides totals; `EvalReport` has no median to divide.
- ~~**A.28 · A saturated outcome ranks cheapness.**~~ CLOSED by `a0f0cec` — `outcomeSpread` measures
  the saturation and `isGolden` condition 2 refuses the rank on it. What cannot be fixed here stands:
  a workflow whose only signal is human approval cannot rank its own runs.
- **A.29 · A frozen golden case pins the whole work channel verbatim, so a candidate the graph's OWN
  verifier certifies is refused by `1-must-pass` and reported as a 33.3pp regression.** Repro:
  `/usr/bin/grep -anc 'task.started' packages/core/src/journal/events.ts` → 3, all of them naming it
  as a decided-DELETE member with no appender — which is the fact the fix needs and does not have.
  **THREE MECHANISMS HAVE BEEN REFUSED**, the third having shipped at `ec1047b`+`ce76bf3` and been
  REVERTED: a `VerifierPin` over WHO verified, WHAT IT SAID and WHAT FED IT, plus two topology
  conditions, was defeated by four games that each reached `promote: true` with the grader
  certifying garbage. The shape of the hole is that the pin reconstructs *what the grader saw* from
  the run's FINAL channel value and the graph's STATIC edge ancestry, **neither of which is a
  statement about time, and the candidate owns the graph**. A fourth structural patch is the wrong
  move. **Closes when** a fold can answer "what did channel C hold when task T read it" — a per-task
  ordering of channel state, which `RunProjection` does not carry and the journal cannot supply
  while `task.started` has no appender. DESIGN item 20 is the second customer for that fact.

### Compensation — what runs, and the gaps that do not

Rollback RUNS: `run/compensation.ts` plans it, `Engine.#compensate` performs it in reverse-seq order
through `#invokeTool`, journaled `compensation.recorded` in three states. What is left:

- **A.30 · What is still uncovered, after the run-failure sites and child runs were wired.** Repro:
  `/usr/bin/grep -anc 'case "compensation": break' packages/core/src/run/engine.ts` → 1 — deliberate,
  because rollback is journal-driven, and the arm carries that argument where a reader reaches it.
  Four things remain open:
  - **`#compensateOne` with an `effect.completed` that carries no `details`** still yields `args = {}`
    (`detailsOf(result)` handed straight to `#invokeTool`, because `effect.completed.result` is typed
    `unknown`). An undo invoked with no arguments is not a refusal. **Closes when** that case is
    `not_attempted` too — one arm, the same fail-closed shape its three neighbours already use.
  - **`JoinNode.onBranchError: "compensate"`**, refused at compile
    (`/usr/bin/grep -anc 'GRAPH008_COMPENSATE_UNIMPLEMENTED' packages/core/src/graph/validate.ts` → 1).
    What it would take is recorded at `#absorbedByJoin`: a BRANCH-PATH scope the planner does not
    have, a trigger in the failing Task's commit rather than at the barrier, and a fourth answer from
    `#absorbedByJoin`, since `boolean` cannot say whether a branch's rollback actually cleaned up.
    **Closes when** those exist; the refusal deletes in the same change.
  - **A DETACHED PARENT whose steps are all blocked journals nothing**, because the `not_attempted`
    rows go through a `RunContext` that cannot be rebuilt without the graph. **Closes** by the move
    that closed the child-run case: `#logFor` writes the rows without a context.
  - **§F.13 at `#finish`** — a task LEASED BY ANOTHER WORKER is still producing while the rollback
    runs, and `ctx.abort` reaches only this process. **Closes when** there is a way to fence a lease
    this engine does not hold.

  Whether an author should ALSO get a graph-level cleanup node on failure is §D.3, not a wiring gap.
- ~~**A.36 · A subgraph's child run is unreachable by URL on the control plane.**~~ CLOSED by
  `d9a8173` — `runIdIn` decodes all NINE run-id captures in `server/http.ts` (the row said three),
  and `run/delivery.ts`'s `callbackFor` encodes, so emitter and route agree.
  `test/server/child-run-by-url.test.ts`.
- **A.37 · A compensation refused for missing arguments is the last word, and the operator's obvious
  next move quietly makes it worse.** Repro:
  `/usr/bin/grep -anc 'retryable !== true' packages/core/src/run/compensation.ts` → 1 —
  `planCompensation` skips settled seqs, so an operator who reads `#compensateOne`'s honest
  `not_attempted` reason and then runs `rewind` to put it right gets a ZERO-STEP plan and a rewind
  that is ACCEPTED, suppressing the `effect.completed` while the effect is still in the world. Not a
  regression: the pre-fix path settled the seq too, and lied about why. **Closes when** the rewind
  refusal (`#uncompensatedIrreversible`) reads the same fact the plan does — a step the plan already
  knows cannot be dispatched — rather than permitting the rewind because the tool merely DECLARES a
  compensation. The `dispatch` count already reads that fact, so the seam exists.

### Two things that are NOT defects, written down so nobody "fixes" them

- **A.31 · An adapter yielding a `UsageRecord` with an absent or non-finite `costUsd` crashes the run
  inside the journal commit.** Repro:
  `/usr/bin/grep -anc 'non-finite number' packages/core/src/canonical.ts` → 1; a `usage` record with
  no `costUsd` throws a raw `CanonicalizationError` out of `RunLog.commit` — not a `LoomError`, not a
  run failure. **Decided: build nothing.** A `ModelAdapter` is host-realm trusted code and
  `--extension-module` is named on ARGV by the operator, so the trust boundary does not move.
  Coercing a non-finite `costUsd` to 0 is explicitly REFUSED — a guard answering its undecidable case
  with the passing value, here a journaled cost of `0`. **Dissent, recorded:** an unhandled throw
  escaping `#commit` is a worse artifact than a `LoomError` even when equally safe. **Reopens if** an
  adapter is ever loaded from anywhere but argv, or if a real adapter produces this in a real run;
  validation then lands in `run/engine.ts` as a `feat` with a `Kernel-seam:` trailer.
- **A.32 · You cannot fan out from a graph's entry, and it costs a user one node.** A fan-out edge
  needs a source node, so every fan-out graph opens with a no-op `function` node whose only job is to
  exist (`examples/graphs/fan-out-join.json`). Not a correctness bug. **Closes when** somebody
  decides the entry is a node; worth a decision only if a second shape needs it.
- ~~**A.33 · `PolicyEngine.clearCeiling` existed in a kernel file with no caller but a test.**~~
  CLOSED — deleted. No event ever clears a human ceiling, so the method deleted an in-memory entry
  `PolicyEngine.restore` re-installed at the LOWERED posture; `deescalate(scope, "in", …)` is the
  same tightening, refused for a non-human, and folded.

---

## B · Declared and wired to nothing

- **B.1 · `loom serve` cannot survive its own death mid-lease.** Repro:
  `/usr/bin/grep -arn 'new LeasedScheduler' packages/core/src` → one hit, in a `cli.ts` docstring
  asserting it appears zero times; there is no construction site. **The row's original framing —
  "`LeasedScheduler` has zero callers, so plug it in or delete it" — was ANSWERED 2026-09-02 and both
  options refused.** It is a library capability an embedder reaches from the package root today
  (`EngineOptions.scheduler` is the seam, both names are on the pinned surface so removal is
  breaking, and four suites exercise it), deliberately unused by the single-tenant CLI per §D.2.
  What stands regardless is the price the row found: a plane that dies between `task.leased` and
  `task.committed` strands that run permanently, because reclaiming needs a lease DEADLINE and
  `InProcessScheduler` has none (`test/deployment/run-clock-survives-restart.test.ts`, with the
  one-event-shorter control). **Closes when** the CLI grows a way to survive its own death mid-lease
  — a single-process deadline would also do it — or somebody argues that a stranded run is
  acceptable for one operator on one machine and writes that here.
- **B.2 · Three event types have no appender.** Repro:
  `/usr/bin/grep -anc 'task.skipped' packages/core/test/registries.test.ts` → 1; that file pins each
  with a written reason and a `blockedOn` list, and goes red the moment the reason stops holding. The
  members: **`task.skipped`** (wire, behind the join's branch-error accounting), **`channel.written`**
  and **`task.started`** (both delete). `budget.reserved`/`budget.settled` were the pair decided
  *wire* and are wired (`test/run/budget-reservation-is-durable.test.ts`, seam `b28c343`), which also
  brought back `journal/audit.ts`'s `budget.reservation-is-settled`. `task.started`'s own defect is
  closed without its deletion — `advance-reentrancy.test.ts` reads `task.leased` keyed
  `taskId#attempt` instead of comparing 0 to 0 — and the deletion waits on `test/scale.test.ts`, the
  remaining `blockedOn` entry. **Closes when** each of the three is wired or deleted.

---

## C · Unbuilt observability, which several other items depend on

**This block gates the UI direction.** A richer operator surface over a plane that is not emitting is
a better view of nothing.

- **C.1 · Six designed span names are unbuilt.** Repro:
  `/usr/bin/grep -anc 'name: "loom\.' packages/core/src/telemetry/spans.ts` → 7, and the grep
  UNDERCOUNTS by two: `loom.model` and `loom.tool` are minted through one ternary, so nine names
  exist. The constraint is that `spansFrom` is a pure fold over one journal, so a name is buildable
  only if the journal already covers it — and each of the six names the event it would need:
  **`loom.request`** (nothing covers ingress; a request is accepted before a runId exists, so it
  needs a durable stream not keyed on a run); **`loom.compile`** (measured impossible —
  `run.submitted`/`run.compiled`/`run.started` and the entry `task.ready`s are ONE append with one
  `ts`, and `compileOrThrow` runs in the caller; needs a `durationMs` on `run.compiled`, a kernel
  change); **`loom.schedule.pick`** (three of its four attributes are scheduler state no event
  carries; needs a `schedule.picked` event); **`loom.context.assemble`** (`run/context.ts` journals
  nothing); **`loom.replay`** (the shadow run's journal carries no marker and its `MemoryStateStore`
  dies with the call; needs `replayOf: RunId` on `run.submitted` plus a durable shadow store);
  **`loom.scheduler.tick`** (C.3 — no tick loop to instrument). **Closes** name by name, each with
  the event it names. `loom.schedule.admit` is NOT among them and never will be: §D refused
  admission control permanently, so the name has no subject.
- **C.2 · Eight of eleven documented span attributes are NOT DERIVABLE, which falsifies this row's
  own premise rather than shrinking it.** Repro: count both spellings, since `spans.ts` writes
  `capability` as a bare identifier —
  `/usr/bin/grep -aoE '"(gate\.batched|tool\.attempt)"|(^|[^.\w"])capability\s*:' packages/core/src/telemetry/spans.ts`
  → 3, the three that were journaled fields this fold read and discarded and are now set. The other
  eight each have a stated reason: `node.type` (only on `task.started`, no writer — §B.2);
  `budget.cost_usd` (`budget.reserved` carries `remainingUsd` only when a dollar ceiling exists, so
  the ceiling reconstructs on some runs and not others, worse than absent); `reducers`
  (`channel.written` has no writer, `state.reduced` carries channels); `trigger.kind` (nothing
  journals a trigger); `gen_ai.request.max_tokens` (`model.called` journals a `requestDigest`, never
  the request); `tool.source` (the concept is not in the tree); `loom.replayed` on both its spans (a
  replay rewrites `model.called.provider` to the recorded leaf ON PURPOSE, so a replayed journal is
  designed to be indistinguishable); `gate.posture` (a constant reached by an inference). **Closes
  when** each of the eight gains the journal event it needs — a `journal/events.ts` change and
  therefore a seam, every one — or is struck from the set. **It does not close by emitting them.**
- **C.3 · No scheduler-tick telemetry, and there is no tick loop to instrument.** Repro:
  `/usr/bin/grep -anc 'tick' packages/core/src/run/scheduler.ts` → 1. A design gap, not a wiring gap.
  Per-task queue wait is already measurable — `task.ready` and `task.leased` are journaled and
  `spans.ts` attaches the latter as a span event, so the p99 is a fold over what is already emitted.
  **Closes when** there is scheduler-level behaviour to instrument.
- ~~**C.4 · There is no OTLP exporter in the repo and no HTTP trace endpoint.**~~ CLOSED —
  `telemetry/otlp.ts` (`otlpTraceRequest` + `OtlpHttpExporter`), `GET /runs/:id/trace?format=otlp` as
  the pull half, and `loom trace <runId> --otlp <endpoint>` as the push half (`96a03bf`). Zero
  dependencies, so "it belongs outside the core" was answered rather than obeyed. Wiring it found
  five defects in the shipped exporter, all fixed and each pinned: `redirect: "follow"` let a
  "collector" re-address the credential and the whole trace; the mask covered the endpoint and not
  the API key; every transport failure said only `TypeError: fetch failed`; `__proto__` as a header
  name is undeliverable and now refuses; and a query string in the endpoint POSTed to a path nobody
  named. `test/telemetry/otlp.test.ts`, `test/cli/trace-otlp.test.ts`.
- ~~**C.5 · A subgraph renders as `loom.tool`.**~~ CLOSED by `aaa4a9a`, and NOT by adding a name
  (§D.2 answered "no ninth name") — the fold's two-arm partition became three:
  `model|summarize → loom.model`, `tool|compensate → loom.tool`, `subgraph|random → loom.effect`.

---

## D · Decisions still owed

Each row states what a decision would settle; none is the implementer's to answer alone. The framing
question was answered by the maintainer: **single machine, single tenant, the maintainer's own
workflows** — one `loom serve`, one operator. Answered rows stay struck rather than deleted, because
a decision's argument is the thing a future reader needs.

- ~~**D.1 · Per-server `irreversibility` on `--mcp-file`.**~~ ANSWERED: yes, an operator may, and the
  argument is at `MCP_SERVER_FIELDS` rather than here. The load-bearing part: that file is ALREADY
  the arbitrary-code door (a row names `command` and `args`, and `startMcp` spawns them with no
  allow-list), so `"irreversibility":"read_only"` is strictly weaker than the `"command":"/bin/sh"`
  the same row could always have said, and the path comes from argv. **The condition, not a caveat:**
  it assumes the writer of the mcp file and the runner of the binary are one person; at a second
  operator the field must be taken away. Inferring the class from the server's own advertised
  metadata is refused outright. `test/mcp/irreversibility.test.ts`.
- ~~**D.2 · A ninth span name for a subgraph.**~~ ANSWERED: no ninth name — the taxonomy is a closed
  vocabulary, and a subgraph is `loom.effect` told apart by `effect.kind` (`aaa4a9a`). The rejected
  alternative — a generic parent over all four effect kinds — would either double a span count
  `spans.ts`'s header budgets or delete the `gen_ai.*`/`tool.*` groupings those names exist for.
- ~~**D.4 · Whether the median gates, and what an undefined pair does to it.**~~ ANSWERED by
  `50f7c03`: the median gates, and an undefined pair is UNBOUNDED rather than dropped. See §A.27.
- ~~**D.6 · Whether `POST /runs` may refuse a graph that only WARNS at compile time.**~~ ANSWERED at
  `86193e3`: yes — the wire refuses, keyed on `spec.inputs`, 400 `E_PROVIDER_BAD_REQUEST` with zero
  `run.submitted` rows. A graph on which `GRAPH005_UNPRODUCED_READ` only WARNS is therefore refused
  at the wire when a caller supplies that channel. **This is the decision of that lane most likely to
  be overturned**, so the counter-argument is kept: `engine.submit` enforces NEITHER set, so this
  door invents an authority the engine does not have, and invents the STRICTER of the two available.
  The alternative, option (f), keys the shared rule on `spec.channels` at all three doors — it still
  closes §A0.17's whole complaint and refuses nothing that compiles. **If it is taken, the change is
  one line in `undeclaredInputs` plus the message's second clause, and the test that would flip is
  `A GRAPH THAT COMPILES AND READS THE CHANNEL IS REFUSED TOO` in
  `test/server/plane-declared-inputs.test.ts`.** Three options were rejected: a defaulted
  `strictInputs` body field, 202 plus a `Warning:` header, and doing nothing. It does NOT reach the
  delegation door — §A0.22, which cannot close until this is settled for all three doors at once.
- **D.3 · Whether an author gets a graph-level cleanup node on failure**, beside journal-driven
  rollback. Compensation edges are a compile-time declaration by design (§A.30); this asks whether
  there should also be a node an author can point at. **Closes when** the maintainer answers.
- **D.5 · Whether the kernel needs a graph-scoped durable fact.** See §A.25: two callers now borrow
  one coordinate — `operator.command` on the first case's run. The question is whether that is one new
  event type or a second keyspace, and either answer is a kernel change with a `Kernel-seam:` trailer.
  **Closes when** the maintainer answers.

---

## E · Deferred on purpose, with the reason — do not silently revive

**"Do not silently revive" is not "never revive."** The reason IS the deferral, so a reason that
stops being true takes the deferral with it.

- **E.1 · Distributed deployment.** A distributed v1 by a small team yields a distributed prototype,
  not a product. The half of this that was false is now §B.1.
- **E.2 · Partition assignment and cross-run fairness.** Half a coordinator is worse than none: a
  cursor lets one plane traverse the listing and gives two no way to divide it, and dividing needs a
  fact that spans runs, which `journal/store.ts` says the journal has nowhere to hold.
- **E.3 · Automated candidate generation, canaries and auto-promotion.** "Under roughly thirty
  scored trajectories per cohort, any candidate is fitted to noise" (`MIN_COHORT_SIZE = 30`). The
  sample argument survives; **its premise did not**, so this must be re-argued rather than inherited.
- **E.4 · Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the
  compiled one, which is what makes the compiled artifact meaningful. Verified: removal is
  unrepresentable in the mutation type.
- **E.5 · Custom user-authored reducers.** Reason: arbitrary code inside the determinism boundary.
  **Worth re-examining on the merits** — that boundary now exists and is proven, and a closed reducer
  set is one of the three things `README.md` says still needs a fork.
- **E.6 · Free-form agent chatter.** "Makes termination unprovable and replay quadratic." The
  precondition holds; the reason is **unverifiable** — there is no chatter to replay.
- **E.7 · seccomp / Landlock.** "Platform-specific" holds — both are Linux-only and this tree runs
  darwin. The clause claiming the threat model was covered was false (the three mitigations bind this
  plane's OWN tools, and `proc.exec` is outside all three); the boot banner now names it as off.
- **E.8 · Vendor callback parsing.** Signature verification IS built and tested
  (`SignedWebhookChannel` implements Slack's scheme end to end). Missing: per-vendor payload SHAPE
  parsing, and an email transport (`email` is only an `Actor.via` label).

**Do not re-enumerate the fork list here.** It lives in `README.md`, "Extending it, and where that
stops"; count it with
`sed -n '/^## Extending it, and where that stops$/,/^## Why this exists$/p' README.md | /usr/bin/grep -a -c '^- \*\*'`
→ 3 today. That list moving the wrong way is property 2's alarm; shrinking it is what property 2
means in practice.

---

## F · Properties to preserve, not history to honour

Each cost real debugging time and would cost it again.

1. **Every durable fact must be rebuildable by folding the log.** The unit needing a restore path is
   the *producer*, not the field. The enumeration is SPLIT across
   `packages/core/test/run/oversight-survives-restart.test.ts` and
   `packages/core/test/run/escalation.test.ts` — search either for `MEMBER`. **A pointer to an
   enumeration is only as good as that enumeration's own discipline about growing.**
2. **A vocabulary with two representations will drift**, and every gate walking the wrong one is
   silently switched off. Prefer a form the type checker can walk; where a test must do it, gate all
   representations as one set and read them from the source.
3. **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm that
   lets something through does not.
4. **Mutation-test every guard.** A test whose expected value could also come from a fallback path is
   a tautology waiting to be discovered.
5. **Driving beats sweeping.** Sweeps derived from the last finding mostly find nothing, because in a
   disciplined codebase most findings are exceptions rather than instances of a class.
6. **A test built from the same mental model as the fix certifies the model, not the mechanism.**
7. **Reproduce by running, not by reading** — including when correcting a document. A correction that
   replaces a false claim with a differently-false one is worse than the original.
8. **Name the set a claim covers.** A count nobody can enumerate is a count nobody checked.
9. **A self-describing claim has no fixed point.** State the invariant, not the measurement, when the
   claim is about the artifact containing it.
10. **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.
11. **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and
    "could not read who it names" must never produce the same value.
12. **Approve means "go ahead", not "consider it done"** — on every node type except the gate itself,
    there is work behind the gate. Checked by
    `node --test packages/core/test/run/approve-means-go-ahead.test.ts`, which drives one gated graph
    per node type off a `Record<NodeType, Case>`, so a ninth member is a COMPILE error there.
13. **A terminal operation is not final until every producer of the state it ends is stopped.**
14. **Cross-realm values look identical and are not**; assert on the prototype, and know that
    `Array.isArray` is realm-agnostic and throws on a revoked proxy.
15. **A plain `grep` can silently skip a file, and empty output is not evidence of absence.** Always
    `/usr/bin/grep -a`, and the path matters — this shell's `grep` is a ugrep wrapper passing `-I`.
    **The trigger set is NUL ∪ invalid UTF-8**, not non-ASCII. **Do not count the affected files with
    grep** — a skipped file is only reported when it also matches your pattern, so grep undercounts
    and the count moves with the search term. Census instead: read every `git ls-files` path and test
    for a zero byte (5 files today, 0 invalid UTF-8).
16. **A fake credential in a doc must LOOK fake, or a scanner is right to stop you.** And the lesson
    that cost more: **a secret scan that names one vendor's shape is not a secret scan** — a scan for
    `sk-` cannot match Stripe's `sk_`, so the claim was broader than the check.
17. **A ratio of two timings is not more robust than one timing.** The noise compounds
    asymmetrically, so a gate written as `t_big / t_small < K` is **likeliest to pass when its own
    denominator sample is worst.** THE MEASUREMENTS, which `CLAUDE.md` cites this entry for:
    `compile scales sub-quadratically` went green only on the run whose 100-node baseline was
    15.5 ms against 4.5–5.0 ms everywhere else, and the layout bound's 500-node sample twice came
    back FASTER than its 100-node one. The replacement in both cases was a deterministic counter (a
    `Proxy` counting the property reads the code makes), byte-identical run to run. Where a timing
    must stay, make it ONE absolute bound with an order-of-magnitude margin, never a ratio.
18. **Cite a source by SYMBOL, never by line number.** Checked by
    `/usr/bin/grep -aon '[a-zA-Z_/-]*\.ts:[0-9][0-9]*' TODO.md DESIGN.md` — every remaining match must
    be either a path under `test/` or a record of what a pointer USED TO BE. **Not one is a live
    pointer into `src/`, which is what makes this rule checkable rather than merely stated.** A symbol
    fails LOUDLY when renamed; a line number goes stale on the next commit and fails SILENTLY, by
    pointing at something plausible. **A claim about a SET checked by a grep over one MEMBER of it is
    the same defect as a stale line number**: it fails silently, by looking checked.
19. **The kernel guard's job is to force a question, and "relabel until it passes" is the failure it
    exists to catch.** The honest answers are a `Kernel-seam:` trailer or an argument for the label,
    written in the commit body where the ledger can be audited against it. `552d999` is the worked
    example: no mechanism added, no vocabulary added, and it RESTORES a property the code already
    claimed. **A `fix` label that cannot survive being spelled out in the commit body is a `feat`
    wearing a disguise**, and the guard cannot tell the two apart — only the argument can.

---

## G · Field-survey work the redesign creates

Each traces to a decision in `DESIGN.md`.

- **G.1 · Declared effects (D2) for `evaluator` bodies and the sandbox.** Repro:
  `/usr/bin/grep -anc 'GRAPH020_UNKNOWN_FIELD' packages/core/src/graph/validate.ts` → 1;
  `ALLOWED_FIELDS.evaluator` refuses `effects`, which is the correct fail-closed state and is pinned
  by `test/run/evaluator-body-contract.test.ts`. Done for `function` nodes. **The row's old reason
  was wrong twice** (driven 2026-09-02): a resource-loaded body's missing effects is the SANDBOX's
  limit and applies to `function` nodes identically — they get a throwing `E_EFFECT_UNAVAILABLE`
  stub, not an absence — and an in-process assertion body AWAITS fine, so `ctx.effects` is undefined
  there because nobody wired it. The real blocker is where the DECLARATION would live: opening it is
  a schema change to `graph/spec.ts` and a wiring change to `run/engine.ts`, **both kernel files,
  under a `feat`** — a `Kernel-seam:` trailer and a maintainer's call. **Closes with**
  `EvaluatorNode.effects` + `ALLOWED_FIELDS.evaluator` + `reachableToolNames` reading it
  unconditionally, `validate.ts`'s effects-shape check widened past `n.type === "function"`,
  `#effectsFor` keyed off the node, and — **in the same commit** — `isExternal` moved, because its
  docstring trusts an `assertion` evaluator on the ground that the arm binds no `ctx.effects`, which
  stops being true the moment this lands. `kind: "rubric"` gets nothing and should be REFUSED.
- **G.2 · `Date` in the realm.** It stays absent, and the reason changed: not "no seed could make it
  reproducible" but "a frozen `Date` that silently never advances is more surprising than an absent
  one". **Closes by** binding the whole constructor to `ctx.now` — and bind `Temporal` in the same
  change when it becomes a default global.
- **G.3 · Divergence must be terminal and loud.** The known failure mode of every replay-based runtime
  is a silent stall: the task retries forever without entering a failed state. `E_REPLAY_DIVERGENCE`
  is fatal, so the recorded-effect path is covered. **Closes when** a repeated divergence signature
  with no forward progress gets its own terminal state.
- **G.4 · Two-axis labels (D4): unlabelled ⇒ untrusted. DONE on the integrity axis.** Repro:
  `/usr/bin/grep -anc 'applySecretFlow' packages/core/src/run/engine.ts` → 4. Both axes exist
  (`tainted`/`applyTaint`, `carriesSecret`/`applySecretFlow`) and `isExternal` no longer defaults to
  trusted (`test/run/unlabelled-is-untrusted.test.ts`). **What is left is the CONFIDENTIALITY axis:**
  `applySecretFlow` still reads the declared classification, so an unclassified channel carrying a
  secret is trusted by default — and the fix is not symmetric, because there is no `effects: []`
  equivalent and marking every unclassified channel sensitive is the constant-gate failure that arm's
  docstring already refuses. **Closes when** that asymmetry has an answer.
- **G.5 · Prompt text is bound by the MANIFEST, not by the hash (D7). Closed 2026-09-01 except one
  residue.** Repro: `node --test packages/core/test/run/graph-binding.test.ts` → 6 pass / 0 fail;
  "THE SAME SPEC WITH DIFFERENT RESOURCES IS REFUSED" asserts the graphHash is IDENTICAL while
  `resolutionManifest` moves and `resolveGate` throws. A subgraph's own
  refs were the half that was real and are now walked into the manifest (`graph/compile.ts`;
  `test/resources/store.test.ts`, "THE PINNING RULE REACHES INTO A SUBGRAPH"). **The residue, and the
  whole of what this row carries:** `#assertBound` checks the manifest only when the attached graph IS
  the compiled one, so a MUTATED run's successor carries no recorded manifest to compare — mutation
  is unreachable from the binary today. **Closes when** it records one.
- **G.6 · Proposed-API mechanism and a version pin (D5).** Repro:
  `/usr/bin/grep -arc 'proposed' packages/core/src/index.ts` → 0. Both halves unbuilt: no
  proposed-API declaration file, no opt-in, no publish-time refusal for an extension that uses one,
  and no runtime version pin. **Closes when** they exist.
- **G.7 · One retry budget per run. THE MULTIPLICATION IS GONE; THE BUDGET WAS NOT BUILT, and that is
  the decision rather than the omission.** Repro:
  `node --test packages/core/test/run/retry-does-not-multiply.test.ts` — `HttpOptions.maxAttempts`
  defaults to 1, so the engine's journaled curve is the only one: `{requests: 3, retriesScheduled: 2}`
  where engine × transport gave `{requests: 9, retriesScheduled: 2}`. A fourth `Budget` dimension
  would have touched three kernel files under a `feat` to buy what deleting the duplicate layer buys
  for nothing. **The cost, named:** an embedder driving an adapter with no engine above it loses two
  silent pre-response retries (`maxAttempts: 3` restores the old curve), and a `RunGraph` whose
  `plans` a caller assembled WITHOUT the compiler loses its only retry. **Reopen a run-scoped budget
  if fan-out width turns out to be the real multiplier** — 3 requests × a wide fan-out is the same
  arithmetic one level up.

---

## H · Housekeeping

- **H.0 · A delegating chain raises one gate per level, and that was the maintainer's call.** Repro:
  `node --test packages/core/test/run/approve-means-go-ahead.test.ts`. Closing A.7 means
  `top → mid → leaf` over an irreversible child asks a human three times where it asked once. Put to
  the maintainer with the alternatives (gate only the outermost; revert to a compile diagnostic) and
  **decided: keep it** — a non-subgraph graph already asks at every node that transitively reaches
  the tool, so the old behaviour was the subgraph route being LOOSER, and the human is asked BEFORE
  the child does reversible work. **Reopens if** an operator reports that nested delegation is
  unusable in practice; the mechanism then is one approval covering a chain, which needs a rule for
  what happens when the chain's shape changes mid-run.
- ~~**H.1 · `bin/loom` is gitignored and goes stale on any source edit.**~~ CLOSED — not by a
  watcher (under §D's single-operator framing a rebuild is a command a person runs) but by
  `scripts/verify-binary.mjs`, which drives the PRODUCED ARTIFACT through the freshness guard's four
  cases (CURRENT, STALE, OVERRIDE, SHIPPED) plus a `binary` CI job. The hole was that a source grep
  cannot check an artifact: a binary built before the guard existed does not carry it and cannot say
  so — measured 8 days and 48 files behind, exit 0, silent. Deliberately NOT in `npm run check`.
  **Reopens on** more than one operator, or a published binary.
- ~~**H.2 · The 2026-08-29 renumber broke FOURTEEN in-tree citations of this file.**~~ CLOSED —
  thirteen by `814e283` and a fourteenth its own command could not see (`cli.ts` wrote `TODO §D.19`
  with no `.md`, and the published grep hard-required `TODO\.md`). Two resolved after the renumber to
  a *plausible, unrelated, live* row instead of to nothing. **Run BEFORE the next renumber:**
  `/usr/bin/grep -arno 'TODO\(\.md\)\?[^"]\{0,4\}§\?[A-Z]0\?\.\?[0-9]*' packages/core/src packages/core/test scripts *.md`
- ~~**H.4 · `--otlp` is the only verb-scoped flag on this CLI.**~~ CLOSED by `96a03bf` on the
  condition this row set — a verb→flag applicability table now exists, so a flag on a verb that does
  not read it is REFUSED rather than ignored. The general form was built rather than the exception
  defended.
- ~~**H.3 · `effectiveTimeout`'s docstring names a set of three and then enumerates four.**~~ CLOSED
  by `e8c2fb5`, and the row UNDERCOUNTED its own survivor set — four count-claims in the region now
  name their members instead, pinned by `test/graph/deadline-set-is-named-not-counted.test.ts`, which
  parses the `NodeType` union out of `graph/spec.ts` so a ninth node type fails there.

---

## Z · Closed 2026-08-25 → 2026-09-09 — do not re-fix these

The register: what closed, and the commit carrying the argument. `git show <sha>` is the citation.
An em dash means the row records no sha; the closure's evidence is the test or mechanism its row
names. Ids below the rule are lanes and decisions that closed with no row of their own.

| id | sha | what closed |
|---|---|---|
| A0.1 | `74b62d9` | canonical string arm, raw length |
| A0.2 | `60ff53d` | `flushHeaders()` after `writeHead` |
| A0.3 | `8c734ce`, `60ff53d` | child gate reachable without `--graph` |
| A0.4 | `49624c0` | truncated tool turn floored |
| A0.5 | `3cfd363` | reserved `Object.prototype` channel names |
| A0.6 | `60ff53d` | console fold shares terminal set |
| A0.7 | `60ff53d` | arming scan inside `listen()` |
| A0.8 | `6b3513b` | `e.kind satisfies never` exhaustiveness |
| A0.9 | `702f785` | `filePayloads` docstring corrected |
| A0.10 | `61e8185` | `GLOB_SCAN_BATCH` docstring counted |
| A0.11 | `49624c0` | `wireCount` shared, not barrelled |
| A0.14 | `3656d69` | unpriced route fails closed |
| A0.15 | `49624c0` | Anthropic input usage MAX |
| A0.16 | `02a5e84` | three control-flow injection paths |
| A0.17 | `86193e3` | plane refuses undeclared input |
| A0.18 | `4bc3ce1` | DOM mock clears children |
| A0.19 | `878001c` | reserved `Object.prototype` node ids |
| A0.20 | `6b3513b` | child gate forwards to mirror |
| A0.21 | `ff8fdac` | `TAKEABLE_EDGE_KINDS` shared predicate |
| A.1 | `a8d62fb` | quote effect makes refusals replayable |
| A.2 | `34a7f14` | replay grades the terminal message |
| A.3 | — | the no-`provider` window named |
| A.4 | — | realm brand carried onto wrappers |
| A.5 | — | two false totals became properties |
| A.8 | `552d999` | `nodeApproved: trigger === "rewind"` |
| A.13 | `96a03bf` | CLI waits on journal predicate |
| A.14 | `6d830d7`, `eba2a63` | run inputs externalised, folded back |
| A.15 | `3762a0e` | keyset cursor replaces scan ceiling |
| A.16 | — | process-local producer sweep named |
| A.17 | — | restart lease wait measured, accepted |
| A.18 | `b2f4002` | taint keyed on the choice |
| A.20 | — | SIGINT window closed by `awaitStoppable` |
| A.22 | `fabc360` | `authoredGraphHash` fixes cohort note |
| A.23 | `276e05c` | `11-budget-exercised` refuses moved ceilings |
| A.27 | `50f7c03`, `160985c` | upper median gates pair cost |
| A.28 | `a0f0cec` | `outcomeSpread` refuses saturated rank |
| A.33 | — | `clearCeiling` deleted, ceiling durable |
| A.34 | — | rewind requires a human |
| A.35 | `52da0e8` | rewind plan previews what dispatches |
| A.36 | `d9a8173` | nine run-id captures now decoded |
| C.4 | `96a03bf` | OTLP encoder, endpoint and push |
| C.5 | `aaa4a9a` | three-arm effect span partition |
| D.1 | — | per-server `irreversibility` allowed |
| D.2 | `aaa4a9a` | no ninth span name |
| D.4 | `50f7c03` | median gates, undefined pair unbounded |
| D.6 | `86193e3` | wire refuses on `spec.inputs` |
| D.14 | `d57c984` | retention tiering deleted — a run's journal is the corpus |
| H.1 | — | `verify-binary.mjs` drives the artifact |
| H.2 | `814e283` | fourteen broken citations repaired |
| H.3 | `e8c2fb5` | four count-claims name their members |
| H.4 | `96a03bf` | verb→flag applicability table |
| — | — | — |
| `engine-cross-run` | `5fe7614` | five cross-run touches answer closed |
| `mcp-seal` | `9cf88b5` | prefix reservation at every registration |
| `mcp-registrar` | `010510e` | three registrars refuse name collisions |
| `engine-child-journal` | `0de48c4` | mirror answer wrapped per mirror |
| `usage-floor` | `dcf54c9` | dollar residual narrowed 80× → 10× |
| `exam-reads` | `3b983f7`, `8c86559` | exam must read the answer |
| `seam-ledger` | `706b88a` | census counts non-`feat` trailers |
| A.7, A.9 | `f5a047e`, `02d3db0`, `ff4888d` | four node types get default deadlines |
| span attributes | `deafe43` | three journaled fields reach spans |
| compensation | `7c8b89c`, `160985c` | one `run.failed` site, children reached |
| unlabelled ⇒ untrusted | `5bff93b` | integrity axis defaults to untrusted |
| subgraph prompt binding | `0f605a9` | manifest walks frozen child specs |
| retry multiplication | `683d928` | transport retry folded into engine |
| malformed `effects` | `7e889a1` | purity label refused at compile |
| answered by DELETION | `21be5ce` `aaa8e3b` `d57c984` `583ecd9` `d078368` `065a9e1` | `JoinNode.timeoutMs`, `FunctionNode.cpuBound`, `journal/retention.ts`, `ApprovalSpec.mode`/`.k`, two `effect.started.kind` members, `TenantId`/`Budget.tenantUsd` |
| D.4's `kill` verb, and `run.cancelled.forced` with it | `e50a2e7` | the field is gone and `run.cancelled` carries `clean` and `unknownEffects` only. Its docstring said "decided for deletion" while §D assigned it to a `kill` verb, and those could not both be acted on; `test/run/cancel-does-not-wait.test.ts` then measured that `cancel` does NOT wait, so `kill` as specified is a second name for `cancel` and the field was being held for nothing. That test and `run/engine.ts`'s steer docstring cite this row. |
| answered by REFUSAL | `378e965` `e42c572` | circuit breaker (no fold spans runs), `preAuthorization`, admission control (a ceiling shipped instead) |
| operator levers | `cc64481` | `deescalate`, in-flight and budget caps |
| `--extension-module` | `cc320d1` | fork list moved the right way |

**The defect class that accounted for nearly every real finding, stated once because it will
recur:** *a guard answering its undecidable case with the passing value.* Members: `gateCandidate`
certifying a candidate it never ran; 0% vs 0% satisfying "non-inferior"; an empty suite reported
valid; an audit rule firing on healthy journals the product itself writes; a cost ratio over a zero
baseline reported as "1.00x"; a deferral budget bounding everything except the last deferral; `loom
score` reporting outcome 0 for a run whose graph it could not find; and a ratio-of-timings gate that
passed hardest when its baseline was worst.
