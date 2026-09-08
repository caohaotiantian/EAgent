# Property 3 — a measurement the candidate cannot write

## Corrections after implementation (2026-09-08)

**This design is BUILT and MERGED** — `wave2-exam` at `ec2ad88` on `loom`. The header below still
says "design only. Nothing here is built"; read it as the status on 2026-09-05. **The body is left
exactly as written**, because a design document's value after the fact is the record of what was
predicted, and rewriting it to match the outcome destroys that. This section is the diff between
the two.

Seven claims in the body were measured FALSE. Four are the implementing lane's measurements
(`ec2ad88`); three carry an independent re-drive on `loom` at `ce9e7b4`, through `./bin/loom`, by a
fresh agent given this §6 and nothing else.

1. **§6 step 3's control is false as stated.** The body predicts `candidates/fixed.json` against
   the same legacy suite gives 12 passes and `✗ 1-must-pass`. Measured: for a suite frozen by an
   HONEST grader the goldens are the odd-length (correct) runs, `fixed` reproduces them, `✓ 2-non-
   inferior Δ 0.0pp`, promote true. `✗ 1-must-pass` is the POISONED-suite shape — step 11's
   subject — not a legacy suite's. (Lane measurement, `ec2ad88`.)

2. **§6 step 4's `loom audit` sentence is false.** `loom audit` prints rule verdicts and skips,
   not `operator.command` rows; the attestation row is read back through the store. (Lane
   measurement, `ec2ad88`.)

3. **§6 step 5's numbers do not reproduce, and were re-driven today.** The body predicts
   `loom cohort <last>` reports `excludedForWeights 30` and `members 0` right after attestation.
   Observed on `ce9e7b4`, immediately after `loom exam attest … --as haotian` → exit 0:
   `members 30`, `excludedForWeights 0`, `golden true 10`, `p90Score 0.6`. Two reasons, one from
   each measurement: `case "cohort"` keys on the queried run's OWN last row (`mine = lastScore(
   events)`) and therefore always counts self (lane); and the FIRST `loom score` after an
   attestation grades the whole corpus in one invocation — 30 `graded … by exam run …` lines —
   rather than one run per invocation, so the state the body describes is not observable at that
   point (today's re-drive).

4. **§6's `models.json` line — "one priced route" — is refused by the binary, measured today.**
   A ROUTE row may declare only a FREE endpoint; a real rate goes on the ADAPTER row. Four
   successive refusals before an accepted file:

   ```
   E_CONFIG_INVALID: … "routes" must be an object mapping each ModelRequest.model the engine sends
     to {"adapter":…,"model":…}
   E_CONFIG_INVALID: … routes["default"] declares "priceInPerMTok", "priceOutPerMTok", which are
     fields nothing reads … This row may declare: adapter, model, fallback, prices.
   E_CONFIG_INVALID: … routes["default"] "prices".input must be {"input":n,"output":n}
   E_CONFIG_INVALID: … routes["default"] "prices"."gpt-4o-mini" declares {"input": 0.15, "output":
     0.6}, and a ROUTE price row may only declare a FREE endpoint: {"input": 0, "output": 0}. …
     A REAL RATE HAS TWO DOORS: put it on the ADAPTER row's "prices" …
   ```

   Accepted: `adapters:[{name,provider,baseUrl,apiKeyEnv:null,prices:{"<model>":{input,output}}}]`
   with `routes:{"default":{adapter,model}}`. **The lane's own owed-docs note said the refused keys
   were `inputPerMTok`/`outputPerMTok`; that is not a correction this document owes** —
   `/usr/bin/grep -a -c 'inputPerMTok\|outputPerMTok' docs/design-property3-2026-09-05.md` → `0`.
   The sentence to fix is "one priced route", above.

5. **§4.1's traversal claim is false.** "reading each journal's first events (`run.submitted`, and
   `operator.command` rows) and never folding": attestation rows sit at a journal's TAIL. The scan
   reads the first event of EVERY run in the listing plus the whole journal of every run of the
   workflow, published or not, and of every exam run made under the attested hash. Nothing caches
   it. (Lane measurement, `ec2ad88`.)

6. **§4.6's cost table under-states `loom score`.** The first `loom score` after an attestation
   starts one exam run per ungraded cohort member — 30 on the §6 fixture — and every scoring verb
   walks the whole listing by cursor, so the 0.173 s figure moves with workspace size, not cohort
   size. Corroborated today by the 30 `graded …` lines in item 3.

7. **§B′'s premise is false, and §4.4's rule changed because of it.** "Once an exam exists the
   in-graph grader is not read by anything that decides" — `#checkConfidence` reads it on every run
   and escalates a posture. So §4.4's skip of `12-grader-unchanged` under an attestation is
   REMOVED (`673c3b3`): check 12 applies to EVERY `promote --suite`, including suites this binary
   froze under an attestation. §4.4's "the invariant these produce" paragraph should also say that
   an evaluator's THRESHOLD is part of what may not change — lowering `threshold: 0.5 → 0` had the
   identical oversight effect while the check printed "the evaluator set is unchanged"
   (`92a0a46`).

**Two rules the body does not contain were added during implementation**, both because the
candidate still reached the deciding number one edge over the previous fix: a candidate-added
rubric raised the outcome of a run the exam FAILED, 0 → 0.2308, because `outcomeOf` averages over
the signals present (`a7bc2ee`); an attested spec was compiled and RUN without `examShape` ever
being applied to the row, so a relay exam in the row took `rigged.json` from `✗ L1 Δ 0.0000` to
`✓ L1 Δ +0.4000 exit 0` (`5b3f568`); and an exam reading no baseline OUTPUT attested and measured
nothing, closed by the mirror of §4.5's input rule (`b8fc664`, comment corrected at `b55f6b1`).
**Five candidate-owned paths to S1 in total, three of them reopenings of the previous fix one edge
over.** That is the shape to expect of the next one.

**What the built thing does NOT cover** is in `CLAUDE.md` §3 as five assumptions, and §5 of this
document is still the right reading of the rest.

---

**Status: design only. Nothing here is built.** Written 2026-09-05 against `95a3dde` plus this
lane's three `fix(evolution)` commits (`9dbfc10`, `1c307a9`, `beded56`), for the implementer of
`.agent/full-audit-2026-09-02/plan.md` Phase 6. Every claim about the tree below was checked by
reading or running the code at that sha; every claim about the future is a proposal. Two
independent reviewers read the first draft with instructions to refute it; twelve of their
findings held and are folded in. The three that changed the design are named where they land:
§4.3's ruler, §4.2's asymmetric refusal, §4.1's frozen corpus.

CLAUDE.md §3 sets the bar: *"Until a measurement exists whose inputs the candidate provably cannot
write, this property is aspirational."* This document names the inputs, names who writes each,
weighs the ways to make one of them unwritable by the candidate, and recommends one.

---

## 1 · The problem, stated as ownership

A promotion gate is a function of inputs. For each input the two shipped gates read, the table
says who can WRITE it. "Candidate" means the author of the candidate graph — a person today, an
optimiser in the loop D6 describes. "Baseline author" is whoever published the graph in
`<ws>/graphs/`; under an automated loop the baseline author is the PREVIOUS promoted candidate,
which is how ownership leaks across rounds. "Baseline callers" are whoever ran `loom run` to make
the recordings; `loom run` is not an operator-only verb, so under D6's loop that is the loop —
the row is not clean, and §4.1 is where it is made clean.

### `loom promote --against-cohort` (`cli.ts` `promoteAgainstCohort`, gate in `evolution/live.ts`)

| input | read from | writer |
|---|---|---|
| inputs the candidate runs on | baseline runs' `run.submitted.inputs`; ALL eligible recordings unless `--runs` | baseline callers — **the candidate's author may be one**: nothing stops `loom run` adding recordings with chosen inputs |
| `CohortStats` (medians, p90) | fold of baseline runs, baseline graph from `graphs/` | baseline author + baseline callers |
| baseline score per pair | `scoreTrajectory(baselineT, cohort)`; S1 from BASELINE graph's `evaluator` nodes | baseline author |
| **candidate score per pair** | `scoreTrajectory(candT, cohort)` with `graph: candidate`; S1 from the **CANDIDATE graph's `evaluator` nodes** (`trajectory.ts` `extractSignals`) | **candidate** |
| `didWork` on the candidate run (gates 0.4 of the score) | candidate run's journal: any committed channel, or any in-graph evaluator verdict | **candidate** |
| the candidate's `metadata.name` (its `run.submitted.workflow`) | the candidate spec | **candidate** — nothing compares it to the cohort's |
| gating regressions (`L4`) | `gate.decided` rows in both journals | humans (a gate needs a person) |
| `postureDiffNonNegative` | `compile` with baseline postures | compiler |
| `promptGrowth` | bytes of both compiled graphs | measured |
| `--bucket`, `--runs`, `--budget`; the `graphs/` index (`promotedGraphHashes` → `specResolved`, condition 5) | argv; the filesystem | caller / operator |
| `8-determinism` | does not run | — |

Row four is the whole defect. `L1-paired-improvement` decides on `candidateScore − baselineScore`,
and 0.6 of `candidateScore` is an outcome the candidate's own evaluator wrote. The audit's
reproduction — one `evaluator` node reading `items`, writing `{pass:true}`, no work node —
scores 1.000 on every input and promotes at paired mean Δ +0.4000 over 30 pairs. (At this
lane's head the same candidate scores 0.600 — `9dbfc10` stopped a $0 cohort paying 0.4 of
efficiency credit — and still promotes at Δ +0.4000: the free credit was never the hole.)

### `loom promote --suite` (`cli.ts`, gate in `evolution/gate.ts` `gateCandidate`)

| input | read from | writer |
|---|---|---|
| suite cases, `frozenAt`, `generatedBy`, `mustPass`, pinned channels | a JSON FILE at `--suite` | whoever can write a file; `freezeSuite` journals the freeze but `promote` never reads that row |
| which runs are `mustPass` and which channels are pinned | `evolution.scored.golden` of baseline runs — READ BACK from the last journaled row (`lastScore`), never recomputed; `golden` rests on S1 from the baseline graph's evaluator | baseline author |
| pinned channel VALUES | baseline recordings' final channels, minus grader-written, minus inputs | baseline runs (not the candidate) |
| candidate pass/fail per case | replay of the recording against the candidate; function bodies re-execute (the grader's included — a throwing grader fails the case); work channels compared byte-for-byte to the pin | candidate's WORK, judged against baseline bytes |
| `--baseline` graph | a path the caller names | caller |
| `proposedAt` | `Date.now()` | clock |
| `proposedBy` | `--proposed-by`, optional | caller; omitting it skips checks 9 and 10 |
| `8-determinism` | two replays of the candidate compared | measured |

This gate never reads the grader's VERDICT: `freezeSuite` excludes grader-written channels from
the pin by construction. So a candidate that only swaps its grader is, to this exam, a no-op —
work channels identical, all thirteen checks green — and promotes. The damage is one step later:
publish it, and `loom score` reads S1 from the rigged grader, `isGolden` marks garbage golden,
and the next `loom suite freeze` pins that garbage as must-pass ground truth (the audit's
`corpus-poisoning-through-freeze`: 20 of 30 golden, 10 must-pass cases pinning a dropped item).

### `loom score` / `isGolden` / `loom suite freeze`

| input | writer |
|---|---|
| S1 (`evaluator{kind:"assertion"}` verdicts) | the graph's author — i.e. the candidate, once promoted |
| S2 (gate decisions) | humans |
| S3 (downstream) | caller-supplied, no caller in the tree |
| S4 (rubric) | a model; weight 0.3, never ground truth |
| S5 (self-report) | the agent; weight 0 |
| cost, latency, gates | the run |
| `promotedGraphHashes` | whatever files are in `graphs/` — a human act |

**The shape of the hole, in one sentence:** the graph is both the WORK being optimised and the
EXAM that grades it, and one author owns both. Every structural patch on the exam side (the three
at `aabdc63`) lost because the candidate owns every channel a graph produces, including what fed
the grader and when. That commit's own closing line says what would close it: a fact the
candidate does not author.

### What the audit found HOLDS, and this design keeps

- The replayed suite's channel pin is ungameable (baseline bytes, not candidate bytes) — but it
  is a regression floor and can only report a tie.
- `cohortKeyOf` keys on `graphHash`, so a candidate's runs cannot move the ruler (`CohortStats`).
  A `subgraph` child is journaled under `workflow: sub.ref` (`engine.ts:6788`), not its own
  `metadata.name`, so a candidate cannot inject runs into a workflow's cohort by delegating to
  the baseline either.
- `isGolden` condition 5 fails closed; `outcomeSpread` refuses a saturated ladder; `L4` compares
  real `gate.decided` rows; `11-budget-exercised` iterates the baseline's scopes.

---

## 2 · Constraints on any answer

1. **The inputs must be unwritable by the candidate**, not merely hard to write. Three attempts
   to pin what an in-graph verifier saw were each defeated by a graph shape the patch had no
   vocabulary for (`git show aabdc63`). A fourth vocabulary is refused here on that record.
2. **The ordinary half must still promote.** `aabdc63` also records the false negative that
   matters: strengthening the grader refused an honest candidate 6 of 6. A gate nobody can pass
   is absent, not strict. Under this design "strengthen the grader" is an operator act
   (re-attest), not a candidate change — §4.4 says so in the refusal, so the false negative is
   re-routed rather than re-imported.
3. **Refusing is allowed; loosening is not.** Where the new mechanism is not configured, the
   gates that would otherwise read a candidate-written value REFUSE and say what to configure;
   readers that only report fall back to today's behaviour. §4.6's table says which is which,
   per reader — and no reader may reach the fallback because a scan was truncated.
4. **Journal is the authority.** Whatever the gate reads must fold from journals, across a
   restart, and an OLD journal without the new facts must still fold. A journaled verdict must
   say enough about its own ruler that a later reader can tell a stale one from a current one.
5. **Kernel stays small.** `scripts/kernel.json` names ten files; touching one for capability
   needs a named seam.
6. **Threat model, stated so the argument has edges.** Single machine, single operator (TODO §D's
   framing answer). The candidate is a graph file plus the resources it references. The
   candidate's RUNS execute under the operator's user but behind the tool jail (`.loom` denied;
   `docs/audit-2026-09-02.md` records nine escapes refused) and behind gates on irreversible
   tools (`proc.exec`). The candidate's AUTHOR — a person or a loop — may run `loom run` and
   `loom score`, and is assumed NOT to run the one verb marked operator-only below. Where that
   assumption is what makes an input unwritable, this document says so.

---

## 3 · Alternatives

Attack set used for every row: **W** work-node deletion + `{pass:true}` (audit repro 1);
**G** grader swap (audit repro 2); **P** corpus poisoning through freeze (audit repro 3);
**A/A′/C/G′** the four `aabdc63` games — rewrite what fed the grader and restore it afterwards;
same with the graded channel never written; fabricated ancestry via `conditional` + `loop`
edges; the same against the recommended topology; **2S** the two-sided fixture (candidate
writes both `expected` and `answer`); **R** rename — the candidate changes `metadata.name` so
it belongs to no workflow anyone configured; **O** output-shaping — the candidate declares (or
drops) an output so that a grader sees a channel the baseline never produced (or vice versa);
**Q** question-planting — the author records extra baseline runs on inputs of their choosing,
so the exam's questions include ones the candidate was built for.

### A · Re-execute the BASELINE graph's evaluator nodes over the candidate's run

*Measures:* the baseline's `evaluator` bodies, run post-hoc by the CLI over the candidate run's
final channels. *Who writes the inputs:* the grader body — baseline author (good); the channels
it reads — the **candidate** (its run wrote them, inputs included: nothing stops a node
overwriting a declared input; the `aabdc63` games did). *Defeats:* W (work channel absent →
fail), G (grader is the baseline's). *Defeated by:* A/C/G′/2S unchanged — the grader reads
candidate-owned channels; a `fixture` node that writes `expected` is candidate-owned.
*Cost:* a way to invoke a `function` body outside a run; `createFunctionLoader`'s bridge is
built for the engine and has no such door. **Verdict: moves the ownership problem from the
grader to its inputs, which is exactly axis 3 of the refused pin.**

### B · Pin the evaluator set; count S1 as ground truth only from an attested grader

*Measures:* the diff of the two graphs' `evaluator` nodes (id, ref, resolved digest, `reads`),
refusing any change — `12-grader-unchanged`, built like `11-budget-exercised` from an
`EvalReport.evaluators` projection; plus an operator attestation set for grader digests that
`isGolden` requires before an S1 counts. *Who writes the inputs:* the two specs — caller and
candidate; the attestation — operator. *Defeats:* G, P (a rigged grader can never enter the
promoted set without a human attesting it); W in the audit's form (the one-node candidate has a
different evaluator). *Defeated by:* A/A′/C/G′/2S — an evaluator kept byte-identical and fed
garbage passes; nothing here looks at what fed it. It is axis 1 of the reverted pin turned into
a refusal, and carries the `aabdc63` false negative verbatim: strengthening the grader is
refused until a human re-attests. *Cost:* small — `gate.ts` and tests for the check; a
`graders/` attestation and journal row for the set. **Verdict: not the measurement.**

### B′ · B, but only where no exam is attested

The form §4.4 adopts. Once an exam exists the in-graph grader is not read by anything that
decides, so refusing a change to it protects nothing and costs the honest strengthening. Where
no exam exists the in-graph grader IS the ground truth `loom score` reports, and it may not
change without a human act. Same cost as B; the false negative is confined to workflows that
have not adopted the exam, and the refusal names the way through.

### C · The operator's exam — a grader OUTSIDE every candidate graph, run by the runtime

*Measures:* a small operator-authored GRAPH (the exam) whose only job is to grade: it declares
inputs by name, runs deterministic `function`/`evaluator{kind:"assertion"}` nodes, and writes one
output, `verdict`. The runtime runs it as its own run with inputs drawn from two places the
candidate does not author: the RECORDED inputs of a baseline run that PREDATES the attestation
(`run.submitted.inputs`) and the graded run's TERMINAL outputs (`run.completed.outputs`). Its
verdict is S1 for the graded run, and the exam's identity is part of the RULER every score is
journaled under. *Who writes the inputs:* the exam spec — operator, attested by a journal row
with a human actor; the recorded inputs — whoever recorded them BEFORE the operator attested,
which the operator saw when attesting; the terminal outputs — the candidate, and **that is the
one input a grade must read: it is the work**. What the candidate does NOT write: the grader,
the ground truth (computed by the exam from recorded inputs, or carried by the exam), the set of
questions (frozen at attestation), the time of grading (after the run terminates, so there is
no "after grading" to spoil), the graph the grader lives in (so no ancestry, no edges, no
vocabulary to fabricate), and the ruler's digest. *Defeats:* W (output absent → the candidate
side is ungradable → 0, and not `delivered`); G (the in-graph grader is not read); P (golden
comes from the exam, and a score under another ruler is excluded by digest); A/A′/C/G′ (the exam
sees recorded inputs and terminal outputs, never the run's intermediate channel state or its
edges); 2S (the exam computes or carries `expected` itself); R (the gate selects the exam by the
COHORT's workflow and refuses a candidate whose name differs); O (an exam may read only channels
the baseline graph declares, and a baseline side the exam cannot grade is `unmeasured`, never a
free win); Q (recordings made after the attestation are not questions until a human re-attests).
*Defeated by:* a candidate tuned to the recorded inputs — the exam's questions are readable
recordings, and nothing mechanical stops a candidate memorising them (`5-prompt-size` catches
the crude prompt form only); an exam that TRUSTS an output instead of checking it (§4.5's rule,
and still the operator's judgement); the threat-model assumption — if the loop can run
`loom exam attest`, ownership collapses. *Cost:* one new verb, one new journal row kind on
`operator.command`, one function-only exam run per graded run (milliseconds, $0, but a journal
each), a cursor traversal of the workspace per scoring verb, changes in `cli.ts`, `score.ts`,
`gate.ts`, `validate.ts`; every existing workflow's live gate and freeze REFUSE until an exam is
authored; NO kernel file. **Verdict: recommended.**

### D · The same exam, but the grader is a `function` invoked directly by the CLI, not a run

Same ownership as C. Loses: the journal as the durable record of each grade (the CLI would have
to journal the verdict itself — on which run? that is TODO §A.25/§D.5 again), replayability,
and the payload-store handling a run already has. Needs a new door into the function realm.
Gains: no extra journals, which §4.6 shows is not nothing. **Rejected**: it re-derives half of
what a run already is; the journal cost is paid in C by traversal, not by a second mechanism.

### E · Human-decided outcomes only (S2)

*Measures:* gate decisions. *Who writes:* humans. *Defeats:* everything mechanical. *Defeated
by:* scale and saturation — `A.28` measured that a human-approval-only cohort cannot rank its
runs (`outcomeSpread 0`), and the live mode parks on every gate (`L2` refuses a graph that stops
for a person by design). *Cost:* a person per candidate run. **Verdict: the floor when no exam
exists, not the loop.** It stays available unchanged.

### F · Temporal hold-out — judge on inputs that arrive AFTER the candidate exists (canary)

*Measures:* the candidate on future traffic. *Who writes:* future callers. *Defeats:* the attack
C cannot — memorising the recorded inputs. *Defeated by:* needing a grader anyway (C), and
needing traffic. *Cost:* the canary rollout TODO §E.3 defers. **Verdict: later; it composes with
C rather than replacing it.**

### G · The exam's VERDICT as the frozen case's expectation

Instead of pinning channel bytes, a frozen case would carry "the exam said pass" and `runCase`
would run the exam over the REPLAYED outputs. It would turn the replayed suite from a regression
floor into a measurement, and would answer TODO §A.29's defect (an honest fix the verifier
certifies refused at 33.3pp). It is not in §4 because it changes `EvalCase.expect`'s meaning and
`runCase` would then start runs; it is the natural second step once C exists, and §7 names it.

---

## 4 · Recommendation: C, with B′ as the replayed gate's rule

**Separate the exam from the graph.** A grader that lives inside the artifact being optimised is
owned by the optimiser; a grader that lives in an operator-attested graph the runtime runs is
not. Six parts, in build order.

### 4.1 · `loom exam attest <exam.json> --cohort <runId> --as <subject>` — the operator-only verb

The workflow is DERIVED from `--cohort` (`run.submitted.workflow` of that run), never typed: two
sources for one fact would need a rule for their disagreement, and `promoteAgainstCohort` already
refuses `--baseline` on the same argument. The verb compiles the exam graph and refuses it unless
it is an exam (§4.5); refuses it unless every exam input other than `subject` is a declared
`input` or `output` of the cohort's baseline graph (the graph at `anchorT.cohort.graphHash` in
`graphs/` — an exam that reads a channel the recordings never produced would grade every baseline
`fail`, see §4.2); refuses it unless it reads at least one baseline `input` (an exam over outputs
alone is attack 2S with the fixture moved outside); and refuses it if every baseline OUTPUT it
reads is written by a baseline `evaluator` node (that is grading the grader — for `review-bench`
as shipped, whose six declared outputs are all evaluator-written, this refusal fires and says
what to declare). Then it appends

```
operator.command { kind: "evolution.exam-attest",
                   args: { workflow, examGraphHash, spec: <the exam GraphSpec>,
                           resolutionManifest, reads: [...spec.inputs], attestedAt,
                           corpusThrough: <RunId of the newest recording of this workflow at attestation> } }
actor: { kind: "human", subject: <--as, REQUIRED>, via: "console" }
```

to the run named by `--cohort` — the same borrow `suite freeze` and both `promote` verbs make
(TODO §A.25/§D.5; this is the third customer, recorded rather than solved). **The spec rides in
the row**, so the exam is reconstructible from the journal with the file gone: the file is a
cache, the row is the authority. `--as` is required and may not be `cli`: a person is deciding,
and the row must name them. `SUITE_GENERATOR` is refused as an attester, the way
`proposedByFlag` refuses it as a proposer.

**The corpus is frozen with the exam.** `corpusThrough` is the newest baseline RunId (a ULID,
so chronological) at attestation time. `promote --against-cohort` and `suite freeze` draw
recordings from runs at or before it and no later: D6's rule is that the exam predates the
student, and the exam's QUESTIONS are the recordings, so a recording made after the operator
looked is not a question until the operator looks again. That is what makes §1's first row
clean — an author who runs `loom run` thirty times on inputs the candidate was built for has
added nothing the gate will read. New recordings join by re-attesting the same exam, which is a
human act and moves nothing else (same hash, same ruler). `loom score` and `loom cohort` are
unaffected: they report, they do not decide.

**How readers find it — and this is not the 500-run window.** `cohortPeers` reads
`listRuns(COHORT_SCAN_LIMIT)`, newest first, and a fact that lives on one anchor run would scroll
out of that window as the workspace grows — exam runs (§4.2) make it grow faster — after which
`loom score` would silently fall back to in-graph S1, a loosening driven by run count. Readers of
attestations and exam grades therefore TRAVERSE `listRuns` by its cursor (`RunFilter.after`,
DESIGN item 13 — it exists, and is a `cli.ts` change only), reading each journal's first events
(`run.submitted`, and `operator.command` rows) and never folding. There is no truncated case to
fall back from. Newest attestation by `ts` wins; a re-attestation is the human path for
"strengthen the grader" and for "admit new recordings", and §4.3 is what makes the old grades
visibly stale when the exam changed.

### 4.2 · The exam run — `gradeWithExam(ws, exam, subjectRunId)`

For a run R of the workflow: read R's `run.submitted.inputs` (resolving `external` handles as
`promoteAgainstCohort` already does) and R's `run.completed.outputs` (never externalised —
`run/externalise.ts` names `collectOutputs` as a site that must see values). Build the exam's
inputs from the two, keyed by the exam's declared `inputs`, plus `subject: R`. Rules, each
failing closed **in the direction that refuses the candidate**, which is not the same direction
on both sides of a pair:

- an exam input present in neither → R is **UNGRADABLE**. On the CANDIDATE side of a pair that is
  the candidate's doing (it dropped or renamed an output): the pair scores the candidate 0 and
  `delivered` false — the exam graph is NOT run; a grader handed a missing answer must not
  guess. On the BASELINE side it is the exam's or the operator's doing, and the pair is
  `unmeasured` — `L2` refuses the promotion by count, exactly as an unfinished candidate run is
  refused today. Scoring the baseline 0 there would hand a candidate that merely ADDS the missing
  output a free +0.6 on every pair, which is the shape `promoteAgainstCohort` already refuses for
  `specResolved`. §4.1's attest-time check makes this arm unreachable for recordings of the
  attested graph; it stays for recordings of an OLDER hash that share the workflow name;
- a name present in both (a channel that is both an `input` and an `output` of the work graph)
  → the RECORDED input wins; the collision is reported;
- R has no `run.completed` → not gradable; the caller treats it as `scoreTrajectory` treats a
  non-succeeded run: score 0;
- the exam RUN itself does not reach `run.completed`, or its `verdict` is not `{pass: boolean}`
  (a body threw on a candidate-shaped output, a payload was gone) → R is **ungraded, and on the
  candidate side that is a fail**: a candidate whose outputs crash the exam has not passed it,
  and a candidate could otherwise crash a weak exam on every input and hide in `unmeasured`.
  On the baseline side it is `unmeasured`. Nothing is locked: a later `loom score` may grade R
  again, and an unfinished exam run is not a grade the scan below will find.

Then `startAndDrive` the attested spec (compiled fresh; its `run.compiled.resolutionManifest`
must equal the attested one, or the exam's function body moved underneath the attestation and
the grade is refused) with those inputs. `startAndDrive` today takes `{graph, inputs,
submittedBy?, budgetUsd?}`; the exam run needs nothing more, and its `submittedBy` is whoever ran
the verb — it is not provenance and nothing reads it as such. The link from grade to subject is
the exam's DECLARED input `subject` (§4.5), journaled on `run.submitted.inputs` like every other
input. The exam run's `run.completed.outputs.verdict` is the grade. Its journal is the durable
record: a run the candidate did not author, keyed by its own runId, folding without the exam
file. A reader that finds a grade VERIFIES it before using it: the exam run's `run.submitted.
inputs` minus `subject` must equal the subject's recorded inputs ∪ terminal outputs as §4.2
builds them, and its `graphHash` must be the attested one; a row that fails either is not a
grade of R. Two completed grades of R under one hash cannot disagree — the exam is deterministic
by §4.5 — so the reader takes either.

Finding a grade later: the traversal of §4.1 collects runs whose `run.submitted.graphHash` is an
attested exam hash and reads `inputs.subject`. A run graded to completion once under exam hash E
is not graded again under E; a run whose exam run did not complete may be.

### 4.3 · The exam is part of the RULER, and S1 comes from it

`scoreTrajectory(t, cohort, {exam?: {graphHash, gradable, pass, score?, examRunId}})` — the
same caller-supplied shape `downstream` (S3) already uses, so the scorer stays pure. When `exam`
is present, `readSignals` emits S1 from it (`evidence: "exam <examRunId> graph <hash>"`) and does
NOT read `t.outcome.assertions`: an assertion the optimiser wrote is the graph's opinion of
itself, one rung above S5 — and `didWork` stops counting in-graph assertions as work for the same
reason. `delivered` additionally requires `gradable`: a run whose outputs the exam could not read
delivered nothing, so it earns no efficiency credit either, and the work-deleting candidate
scores exactly 0 rather than the 0.3 of cost and latency credit it would otherwise keep in a
priced cohort. When `exam` is absent, behaviour is byte-identical to this lane's head, which is
what keeps every existing test and every old journal folding.

**The ruler.** `weightsDigest` is journaled on every `evolution.scored` row and every reader
already refuses or excludes on a mismatch: `scoreTrajectory` throws `E_COHORT_INVALIDATED`,
`freezeSuite` counts `excludedForWeights`, `loom cohort` reports it. Under an exam the digest
becomes `digest({weights, examGraphHash})`. That is the whole fix for a problem the first draft
missed and both reviewers found: `freezeSuite` does not compute `golden`, it reads it off the
LAST journaled row, so an attestation on an existing workspace would otherwise freeze goldens
that a rigged in-graph grader decided last month, and a re-attestation with a changed exam would
leave rows scored under E1 indistinguishable from E2. With the exam in the digest, every row
scored before the attestation — or under another exam — is a row under a different ruler, and
code that already exists excludes it and says so. `loom score` re-scores under the current ruler;
`loom cohort` shows the excluded count. No new field, no kernel touch, and `evolution.scored.
weights` still carries the four numbers — the digest covers more than they do, and the row's
`signals[].evidence` names the exam so a reader can see why.

`measureCohort` takes `exam?: ReadonlyMap<runId, ExamOutcome>` beside `downstream`, and folds the
exam hash into the digest it stamps on `CohortStats`. `isGolden` is unchanged: condition 1's
`hasGroundTruth` reads `scored.signals`; condition 2's `outcomeSpread` is why an exam should emit
a `score` in `[0, 1]` and not only `pass` (§4.5).

Callers (`cli.ts`): `loom score`, `loom cohort`, `loom suite freeze`, `loom promote
--against-cohort` all fold with the exam when the cohort's workflow has one, grading any member
not yet graded under the current hash first.

### 4.4 · The gates

- **`promote --against-cohort`** REFUSES when the cohort's workflow has no attestation: *"no
  measurement the candidate cannot write exists for this workflow — attest one with `loom exam
  attest`, or judge by hand"*. It REFUSES a candidate whose `metadata.name` differs from the
  cohort's workflow (attack R). It selects recordings at or before `corpusThrough` (attack Q).
  With an attestation, both sides of every pair are graded by the exam, selected by the COHORT's
  workflow and never the candidate's: the baseline recording's terminal outputs and the candidate
  run's. One ruler, owned by neither graph. `L1`…`L5`, `3-cost`, `5`, `6`, `8` are unchanged. The
  journaled `evolution.promote` decision gains `examGraphHash`, `corpusThrough` and, per pair,
  the two exam run ids, so the certificate says which exam judged it over which questions.
- **`promote --suite`** gains `12-grader-unchanged` (alternative B′): where the cohort's workflow
  has NO attestation, the evaluator set (id, ref, digest, `reads`) must be identical at every
  scope, additions included — an added always-pass evaluator inflates k/n in `loom score`, which
  is then the only ground truth this workflow has. Where an attestation exists the check is
  reported as skipped, with the reason: the exam grades, and the in-graph evaluator decides
  nothing. Refusal text: *"a replayed suite grades work channels and never the grader, so a
  grader change is a change this exam cannot see and this workflow has no other ground truth.
  Strengthening a grader is an operator's act, not a candidate's: attest the stronger grader as
  this workflow's exam (`loom exam attest`) and judge candidates live"*. Data:
  `EvalReport.evaluators`, projected in `runEvalSuite` from `spec.nodes` ×
  `RunGraph.resolutionManifest`; the attestation lookup is the caller's (`cli.ts`), passed in as
  `PromotionInput.examAttested: boolean`, the way `postureDiffNonNegative` is measured outside
  and passed in. What this buys is narrow and said so: it refuses audit repro 2 through the
  replayed door on a workflow nobody has attested, and nothing else; `freezeSuite` refusing
  without an attestation is what stops the poisoning. `11-budget-exercised`'s argument that
  added nodes must promote is about the loop's mutation operator, and `compileMutation` adds no
  evaluator; if it ever does, that is the moment to revisit this line, not before.
- **`loom suite freeze`** REFUSES a workflow with no attestation, same message as the live gate,
  and draws only from recordings at or before `corpusThrough`. With one, `golden` rests on
  exam-ruler rows only (stale rows are `excludedForWeights`), so `freezeSuite`'s load-bearing
  sentence — "what is pinned is an output something OUTSIDE the graph already certified" — becomes
  true instead of false. No other rule change.

**The invariant these produce:** *the set of graders whose verdicts count as ground truth for a
workflow, and the set of questions they are asked, change only by a human act* — an attestation
row with a human actor, or a human publishing a graph into `graphs/` outside any promotion. No
`promote` path and no `loom run` can change either. That is the same shape as "oversight only
tightens; a human may lower it".

### 4.5 · What makes a graph an exam (compile-time, `graph/validate.ts` — not kernel)

`inputs` non-empty and including `subject`; exactly one output, `verdict`; no `agent`, `tool`,
`subgraph`, `human_gate` or `evaluator{kind:"rubric"}` node — deterministic bodies only, so the
grade replays and calls no provider; terminal node is an `evaluator{kind:"assertion"}` writing
`verdict`; no node reads `subject`. Refused with a diagnostic naming the rule. The verdict is
read from `run.completed.outputs`, never via `extractSignals` (which classifies rubric against
assertion by whether a model call happened, a question the exam run never raises).

**Two rules on exam AUTHORS, stated because ownership is not quality.** An exam treats every
output it reads as a CLAIM and checks it against ground truth it derives from recorded inputs or
carries itself; an output that is already the work graph's own summary of its work — a parsed
verdict list, a `pass` flag — is candidate-owned and must be re-derived from the raw output, not
believed. §4.1's attest-time checks refuse the two mechanical forms of that mistake (no input
read; only evaluator-written outputs read) and cannot refuse the rest. And an exam should write
`verdict.score` in `[0, 1]` with the resolution the work has (k of n cases), not `pass` alone: a
pass/fail exam over a mostly-passing baseline saturates `outcomeSpread` and `isGolden` condition
2 refuses to rank at all.

### 4.6 · Journal vocabulary, kernel, files, costs

| fact | carrier | new type? | absent means, per reader |
|---|---|---|---|
| a human attested exam E for workflow W, over recordings through R₀ | `operator.command{kind:"evolution.exam-attest"}` on the `--cohort` run, human actor, spec inline, `corpusThrough` | no — `operator.command` is `{kind: string, args}` and already carries `evolution.suite-freeze` and `evolution.promote` | `loom score` / `loom cohort`: in-graph S1, as today. `promote --against-cohort`, `suite freeze`: REFUSE and name the verb. `promote --suite`: check 12 applies |
| run R was graded by exam E | the exam run's own journal: `run.submitted.graphHash = E`, `run.submitted.inputs.subject = R`, `run.completed.outputs.verdict`, verified against R's own journal on read | no | R is ungraded under E; the next scoring verb grades it |
| a score was computed under exam E | `evolution.scored.weightsDigest = digest({weights, examGraphHash: E})`; `signals[].evidence` names the exam run | no | the row is under another ruler; `excludedForWeights`, as today for a weight change |
| a promotion was judged by exam E over questions through R₀ | `evolution.promote.args.examGraphHash`, `corpusThrough`, `pairs[].baselineExamRunId / candidateExamRunId` | no | a pre-exam certificate |
| exam runs exist in the workspace | ordinary runs; `run.submitted.workflow` is the exam spec's `metadata.name` | no | — |

**Kernel: untouched.** `journal/events.ts` gains no member and no field; `store.ts`'s
`ListRunsOptions` is not widened, because the cursor it already has is what the traversal uses;
`engine.ts` is not touched (`startAndDrive`'s existing input shape suffices). The seam that would
be needed if the ruler-digest carrier ever proves insufficient is named so nobody discovers it
mid-fix: a fold that must decide on exam provenance WITHOUT re-deriving the digest needs
`evolution.scored.exam?: {runId, graphHash}` — one optional field, `feat`, `Kernel-seam:` "the
verdict vocabulary cannot say who graded". Nothing in §4 needs it: every consumer already keys on
`weightsDigest`.

**Files.** `cli.ts` (verb; `gradeWithExam`; the cursor traversal; the four call sites; the
`metadata.name` and `corpusThrough` selection; refusal texts); `evolution/score.ts` (`exam`
option on `scoreTrajectory`/`measureCohort`, the digest, `delivered`, `didWork`);
`evolution/gate.ts` (`EvalReport.evaluators`, `PromotionInput.examAttested`,
`12-grader-unchanged`); `graph/validate.ts` (exam rules; `GRAPH0xx_NOT_AN_EXAM`); `README.md`
"Extending it" (an exam is a graph — no fork); `scripts/surface.json` gains at most one name if
`ExamOutcome` is exported (prefer inlining it on the option). Tests: one file per part, plus the
acceptance exam below driven through `main()` the way `test/cli/promote-live.test.ts` drives the
live verb with a stub adapter.

**Costs, named.**

- **Journals.** One function-only run per graded run: 30 once for a 30-run baseline, then 30 per
  candidate judged live — 60 new journals per live attempt where today there are 30. Every one
  is a `listRuns` row. Today the baseline cohort scrolls out of `cohortPeers`' 500-newest window
  after ~15 live attempts; with exams, ~7. The attestation and grade lookups do NOT depend on
  that window (§4.1), but `cohortPeers` still does, so the cohort itself is the thing that
  disappears first — a pre-existing bound this design brings forward, and the honest fix is a
  workflow filter on `listRuns`, which is a kernel change (`store.ts`) deliberately NOT made here
  and recorded in §7 as the first thing a long-lived workspace will need.
- **Traversal.** Every scoring verb reads every run's head once. `loom score` already folds up
  to 500 whole journals; this adds a pass over the first few events of each run in the
  workspace, so its 0.173 s figure moves with workspace size, not cohort size.
- **Re-attestation re-grades.** A new exam hash is a new ruler: every baseline member and every
  candidate is graded again, and every existing score row is stale. That is the correct
  consequence of "the grader changed", and it is a cost. Re-attesting the SAME exam to admit new
  recordings changes no ruler and re-grades nothing.
- **Adoption breaks what ships.** Until a workflow has an exam, `promote --against-cohort` and
  `suite freeze` refuse for it. `review-bench`'s six declared outputs are all evaluator-written,
  so attestation refuses its shipped shape; its exam must read `reviews` (the raw model text)
  and re-parse against `bench-cases` — not `verdicts`, which `bench-collate` writes and a
  candidate may rewrite — and `reviews` is not a declared output today, so adopting the exam
  edits the graph's `outputs`, which changes its hash and its cohort: the 33-run corpus and the
  live promotion DESIGN Sequence 5 records stay reproducible at their own sha and not at this
  one, and a fresh paid corpus precedes any live promotion of `review-bench`. A workflow with no
  deterministic ground truth has no exam, and the honest answer is E.

---

## 5 · What this does NOT close

- **A student tuned to a known exam.** The recordings are readable; a candidate can be written
  to them. `corpusThrough` stops an author ADDING questions; it cannot stop one READING them. F
  is the eventual answer.
- **A weak or trusting exam.** An exam that checks `picked.length` promotes a candidate that
  returns the right number of wrong items. §4.1's checks refuse the two mechanical forms of
  trusting an output; ownership is fixed, quality is the operator's, exactly as the quality of a
  human gate decision is.
- **`didWork` is still the candidate's for efficiency credit.** 0.4 of the score is efficiency
  credit gated on a predicate one committed channel satisfies. §4.3 ties it to gradability and
  stops in-graph verdicts counting, so a run the exam could not read earns nothing; a run the
  exam FAILED still keeps its efficiency credit, which is the metric's existing rule for a
  measured failure and is left as it is.
- **The trust assumption.** Attestation is a verb a person runs. `proc.exec` inside a run can run
  it — behind a human gate, so the human is the attester; a loop given `proc.exec` ungated would
  own its own exam. `MCP_SERVER_FIELDS`' condition applies verbatim: this holds under one
  operator.
- **`promote --suite` stays a regression floor**, and its inputs still include a self-asserted
  file (`suite-frozenat-not-from-journal`, `lineage-check-off-by-omission`, both downgraded to
  minor by the audit's skeptic). The attestation rule in §4.1 — the row is the authority, the
  file is a cache — is the same rule `promote --suite` should apply to `frozenAt`: look the suite
  up by `(name, version, caseRunIds)` in `evolution.suite-freeze` rows reachable from its cases
  and take `frozenAt` from the row, refusing 9 when no row exists. Deferred to the implementer:
  it needs `cli.ts`. For lineage, the fail-closed fix is "an agent-generated suite requires
  `--proposed-by`"; every `suite freeze` output carries `generatedBy`, so that is a new rejection
  on every human `promote --suite` that omits the flag — `examples/demo/close-the-loop.sh`'s
  command does pass `--proposed-by maintainer` (line 159), but its printed guidance tells the
  operator to drop it (line 141). A contract change to make deliberately, with the demo's text.
- **TODO §A.29 stays OPEN.** Its defect — a frozen golden case pins channel bytes, so an honest
  fix the verifier certifies is refused by `1-must-pass` at 33.3pp — is untouched by this design;
  only its proposed closing MECHANISM (a per-task ordering of channel state) is superseded, because
  the exam never asks what a task saw. Alternative G is the C-shaped answer to the defect itself.
  The row should say both.

---

## 6 · Acceptance exam, for a fresh agent with the shipped binary

Run at the sha that lands this design. The numbers assume `9dbfc10`'s rule (a $0 / 0 ms /
gateless cohort pays no efficiency credit) — function-only runs have `wallMs 0` and `costUsd 0`
exactly, so every score below is `0.6 × outcome` and every pair count is exact. Fixture: the
audit's `pick-bench` (`.agent/full-audit-2026-09-02/findings/property-3-…`, repro 1), reproduced
here so it survives the scratch directory. `pick` is deliberately wrong on even-length inputs;
`check` is the in-graph grader. Thirty inputs `items = ["doc-n-0", …]` of length `2 + n % 3`,
n = 1…30 — even for n % 3 ∈ {0, 2}, so 20 of the 30 recordings are wrong.

```
WS=<tmp>; mkdir -p $WS/graphs $WS/resources/function $WS/candidates $WS/exams
# resources/function/pick.js        (view) => ({ writes: { picked: items.length % 2 === 0 ? items.slice(0,-1) : items.slice() } })
# resources/function/pick-fixed.js  (view) => ({ writes: { picked: items.slice() } })
# resources/function/check.js       pass = picked.length === items.length            (in-graph grader)
# resources/function/check-rigged.js () => ({ writes: { verdict: { pass: true, score: 1 } } })
# resources/function/exam-pick.js   (view) => { const want = view.get("items"), got = view.get("picked") ?? [];
#                                     const ok = JSON.stringify(got) === JSON.stringify(want);
#                                     return { writes: { verdict: { pass: ok, score: ok ? 1 : 0 } } }; }
# graphs/pick.json         name pick-bench; inputs [items] outputs [picked, verdict]; pick -> check   (baseline)
# graphs/other.json        name other-bench; any function-only graph with its own evaluator          (step 10)
# candidates/noop.json     one evaluator node reading items, writing verdict {pass:true}; NO pick node (audit repro 1)
# candidates/rigged.json   pick.json with check -> function/check-rigged@stable                        (audit repro 2)
# candidates/fixed.json    pick.json with pick  -> function/pick-fixed@stable                          (the ORDINARY half)
# candidates/renamed.json  fixed.json with metadata.name "pick-bench-2"                                (attack R)
# exams/pick-exam.json     inputs [subject, items, picked] outputs [verdict]; one evaluator{assertion} -> function/exam-pick@stable
# exams/bad-exam.json      inputs [subject, verdict] — reads only an evaluator-written output           (refused at attest)
# models.json              the shape test/cli/promote-live.test.ts:114-127 uses: provider "openai", "apiKeyEnv": null,
#                          a baseUrl nothing will call, one priced route. promoteAgainstCohort refuses without a
#                          models file whether or not the candidate has an agent node, and readModels refuses an
#                          adapter whose apiKeyEnv is unset — `null` declares there is none.
```

`pick.json` must declare `picked` as an OUTPUT — the exam reads terminal outputs, and a work
channel the graph does not declare is one the exam cannot see. Relaxing `--models-file` for
agent-free graphs is the implementer's call and not required here.

1. Record and score the corpus: 30 × `loom run graphs/pick.json --input '{"items":[…]}'`, then
   `loom score <id>` for each; likewise 6 runs of `graphs/other.json`. `loom cohort <last pick
   run>` → `members 30`.
2. **Before attestation the gates refuse, and say what to do:** `loom promote
   candidates/fixed.json --against-cohort <last> --models-file models.json` → exit ≠ 0, stderr
   names `loom exam attest`. `loom suite freeze --cohort <last> --out s0.json` → same refusal.
   (Control: `fixed.json` is the honest candidate; the refusal is about the workspace.)
3. **Audit repro 2 through the replayed door, before attestation:** freeze `s-legacy.json` from
   the 30 recordings at `95a3dde`'s binary (or bypass the new refusal once, by hand), then
   `loom promote candidates/rigged.json --baseline graphs/pick.json --suite s-legacy.json` →
   `✗ 12-grader-unchanged` naming `node:check function/check@stable → function/check-rigged@stable`,
   exit 1. Control: `candidates/fixed.json` against the same suite → 12 passes (the evaluator set
   is unchanged) and `✗ 1-must-pass` (the regression floor pins the old wrong `picked`) — the
   floor is a floor, which is §A.29's open defect and not this design's.
4. Attest: `loom exam attest exams/pick-exam.json --cohort <last> --as <you>` → exit 0;
   `loom audit <last>` shows one `evolution.exam-attest` row with a `human` actor whose subject
   is `<you>` and `corpusThrough` = the newest pick-bench RunId. Refused, each with its rule
   named: without `--as`; with `--as cli`; `exams/bad-exam.json` (reads only an evaluator-written
   output); an exam whose `inputs` name a channel `pick.json` declares nowhere; an exam
   containing an `agent` node.
5. **Stale scores are stale:** `loom cohort <last>` now reports `excludedForWeights 30` and
   `members 0` (every row was scored under the pre-exam ruler); `loom score <id>` on each run
   grades it (one exam run appears per scored run) and the cohort refills. From here `golden` is
   decided by the exam.
6. **Audit repro 1 is REFUSED:** `loom promote candidates/noop.json --against-cohort <last>
   --models-file models.json` → `✗ L1-paired-improvement` (paired mean Δ −0.2000: `picked` is
   absent from every candidate `run.completed.outputs`, so every candidate side is ungradable,
   `delivered` false, score 0, against a baseline that scores 0.6 on the 10 odd-length inputs)
   and `✗ L5-candidate-earned-it` (0 of 30 above 0). exit 1.
7. **Audit repro 2 through the live door is REFUSED:** `loom promote candidates/rigged.json
   --against-cohort <last> --models-file models.json` → `✗ L1` (Δ 0.0000 on every pair: the exam
   grades identical `picked` on both sides; 0W/0L/30T), exit 1.
8. **Attacks R and Q are REFUSED:** `loom promote candidates/renamed.json --against-cohort
   <last> …` → refused before any run starts, naming `pick-bench-2` ≠ `pick-bench`. Then record
   30 more `pick.json` runs on odd-length inputs only (the ones the baseline gets right) and
   re-run step 6's command: still Δ −0.2000 over 30 pairs — the new recordings are after
   `corpusThrough` and are not questions.
9. **The ORDINARY half PROMOTES:** `loom promote candidates/fixed.json --against-cohort <last>
   --models-file models.json` → `✓ L1` with the exam grading 20 of 30 baseline inputs
   `pass:false` and 30 of 30 candidate runs `pass:true`; paired mean Δ = 0.6 × 20/30 = +0.4000,
   20W/0L/10T, t lower bound 0.3108 and Wilcoxon 0.3000, both > 0; `✓ L5`; `✓ 3-cost` (both
   sides $0 → 1.00×); exit 0. The journaled `evolution.promote` row carries `examGraphHash`,
   `corpusThrough` and 60 exam run ids.
10. **Unattested workflows fold as before:** `loom score <an other-bench run>` prints, byte-for-
    byte except `ts`, what it printed in step 1 — in-graph S1, no exam.
11. **Poisoning cannot recur:** copy `candidates/rigged.json` into `graphs/` by hand (a human
    publishing a rigged grader), run it 30 times, `loom score` each — every even-length run is
    NOT golden, whatever `check-rigged` said; re-attest the same exam (`corpusThrough` advances)
    and `loom suite freeze` on that cohort pins only exam-certified outputs. Then
    `candidates/renamed.json` the same way: its runs are workflow `pick-bench-2`, which has no
    attestation, so `loom score` reports in-graph S1 for them and `loom suite freeze` /
    `promote --against-cohort` refuse until someone attests — the rename buys a new workflow, not
    a way past the exam.
12. **Restart survives:** delete `exams/pick-exam.json` from disk and re-run step 9 — the exam is
    compiled from the attestation row; same verdict, same 20 baseline inputs graded `pass:false`,
    `✓ L1`. A workspace copied without its `graphs/` still refuses (`E_RUN_NOT_FOUND`, the
    baseline must be publishable — unchanged).

Each step is one command with an exit code; steps 6, 7 and 9 are the three the property is
measured by, 11 is the one the audit's third finding needs, and 5 and 8 are the two the first
draft of this document would have failed.

---

## 7 · Non-goals, and what is left for later

- No candidate generator, no canary rollout (TODO §E.3 stands, to be re-argued after this; F).
- No change to `SIGNAL_WEIGHTS`, `DEFAULT_WEIGHTS`, `MIN_COHORT_SIZE`, `MIN_PAIRED_RUNS`, or the
  statistics in `live.ts`.
- No per-task channel-state fold (A.29's old closing condition; see §5).
- No `listRuns` workflow filter (kernel `store.ts`); the traversal cost is carried and named in
  §4.6, and the filter is the first thing a long-lived workspace will ask for.
- No graph-scoped durable fact (§D.5); the attestation borrows a run coordinate like its two
  predecessors, and is the third argument for deciding §D.5.
- Alternative G — the exam's verdict as a frozen case's expectation — is the second step, not
  this one; it is what would make the replayed door measure an improvement.
- `promote --suite` keeps checks 9 and 10 as they are; their fail-closed fixes are recorded in
  §5 for the implementer who owns `cli.ts` and the demo script.
- The three mechanical fixes this lane DID make — normalizers fail closed at a zero median
  (`score.ts`, `9dbfc10`), `3-cost`/`4-latency` fail closed at a zero baseline (`gate.ts`,
  `1c307a9`), and `didWork`'s docstring corrected (`beded56`) — are independent of this design.
