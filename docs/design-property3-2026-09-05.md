# Property 3 — a measurement the candidate cannot write

**BUILT and MERGED** — `wave2-exam` at `ec2ad88` on `loom`, with `exam-reads` (`3b983f7`,
`8c86559`) after it. Written 2026-09-05; slimmed 2026-09-09 to the decisions in force, the
corrections the implementation forced, and the residue. The alternatives that lost and the
argument's history are gone; `git log` has them.

Section numbers are load-bearing: `test/cli/exam-lane-acceptance.test.ts` cites §6,
`test/evolution/exam-lane-exam-predicate.test.ts` cites §4.1 and §4.5, and `evolution/gate.ts`
cites §B′. Do not renumber.

---

## 1 · The problem, stated as ownership

`loom promote --against-cohort` decides on `candidateScore − baselineScore`, and 0.6 of
`candidateScore` was an outcome the candidate's own evaluator wrote: S1 came from the CANDIDATE
graph's `evaluator` nodes (`trajectory.ts` `extractSignals`). Two more inputs were the candidate's:
`didWork` (which gates 0.4 of the score) and `metadata.name`, which nothing compared to the cohort's.

`loom promote --suite` never reads the grader's VERDICT — `freezeSuite` excludes grader-written
channels from the pin by construction — so a candidate that only swaps its grader is a no-op to
that gate and promotes. The damage is one step later: `loom score` reads S1 from the rigged grader,
`isGolden` marks garbage golden, and the next `loom suite freeze` pins it as must-pass ground truth.

**The shape of the hole, in one sentence:** the graph is both the WORK being optimised and the EXAM
that grades it, and one author owns both. Every structural patch on the exam side (the three at
`aabdc63`) lost because the candidate owns every channel a graph produces. `docs/audit-2026-09-02.md`
has the three reproductions.

**Constraints any answer had to meet**, still the bar for the next change here:

1. The inputs must be **unwritable** by the candidate, not merely hard to write.
2. **The ordinary half must still promote.** `aabdc63` records the false negative that matters:
   strengthening the grader refused an honest candidate 6 of 6. A gate nobody can pass is absent,
   not strict.
3. **Refusing is allowed; loosening is not.** Where the mechanism is not configured, a gate that
   would otherwise read a candidate-written value REFUSES and names what to configure.
4. **Journal is the authority**, across a restart, and an OLD journal without the new facts must
   still fold.
5. **Kernel stays small.**
6. **Threat model: single machine, single operator.** The candidate is a graph file plus its
   resources; its RUNS execute behind the tool jail (`.loom` denied; `docs/audit-2026-09-02.md`
   records nine escapes refused) and behind gates on irreversible tools. The candidate's AUTHOR is
   assumed NOT to run the operator-only verb.

---

## 2 · The decision: an exam OUTSIDE every candidate graph, run by the runtime

**Separate the exam from the graph.** A grader that lives inside the artifact being optimised is
owned by the optimiser; a grader that lives in an operator-attested graph the runtime runs is not.

Rejected, and why, in one line each: re-executing the BASELINE's evaluators over the candidate's run
moves the ownership problem from the grader to its inputs; pinning the evaluator set alone
(**B**) does not look at what fed the grader; a `function` invoked directly by the CLI (**D**)
re-derives half of what a run already is and loses the journal; human-decided outcomes only (**E**)
cannot rank at scale and stays the floor where no exam exists; temporal hold-out (**F**) composes
with this rather than replacing it, and is the eventual answer to a student tuned to a known exam.

### B′ · the rule the replayed gate uses

`12-grader-unchanged` — where a workflow has NO attestation, the evaluator set (id, ref, digest,
`reads`) must be identical at every scope, additions included: an added always-pass evaluator
inflates k/n in `loom score`, which is then the only ground truth this workflow has.

**§B′'s original premise was FALSE and the rule changed because of it.** The body claimed "once an
exam exists the in-graph grader is not read by anything that decides" — `#checkConfidence` reads it
on every run and escalates a posture. So the planned SKIP of check 12 under an attestation was
REMOVED (`673c3b3`): **check 12 applies to EVERY `promote --suite`**, attested workflows included.
An evaluator's THRESHOLD is part of what may not change — lowering `threshold: 0.5 → 0` had the
identical oversight effect while the check printed "the evaluator set is unchanged" (`92a0a46`).

---

## 4 · The mechanism

### 4.1 · `loom exam attest <exam.json> --cohort <runId> --as <subject>` — operator-only

The workflow is DERIVED from `--cohort`, never typed: two sources for one fact would need a rule for
their disagreement. The verb refuses the exam unless it is an exam (§4.5); unless every exam input
other than `subject` is a declared `input` or `output` of the cohort's baseline graph; unless it
reads at least one baseline `input` (an exam over outputs alone is the two-sided fixture moved
outside); and if every baseline OUTPUT it reads is written by a baseline `evaluator` node (that is
grading the grader). Then it appends

```
operator.command { kind: "evolution.exam-attest",
                   args: { workflow, examGraphHash, spec: <the exam GraphSpec>,
                           resolutionManifest, reads: [...spec.inputs], attestedAt,
                           corpusThrough: <newest recording of this workflow at attestation> } }
actor: { kind: "human", subject: <--as, REQUIRED>, via: "console" }
```

to the `--cohort` run — the same run-coordinate borrow `suite freeze` and both `promote` verbs make
(`TODO.md` §A.25/§D.5; this is the third customer, recorded rather than solved). **The spec rides in
the row**, so the exam is reconstructible from the journal with the file gone: the file is a cache,
the row is the authority. `--as` is required and may not be `cli`.

**The corpus is frozen with the exam.** `corpusThrough` is the newest baseline RunId at attestation.
`promote --against-cohort` and `suite freeze` draw recordings at or before it and no later: the exam
predates the student, and the exam's QUESTIONS are the recordings, so a recording made after the
operator looked is not a question until the operator looks again. That is what makes the "baseline
callers" row clean. New recordings join by re-attesting the same exam — a human act that moves
nothing else.

**Readers TRAVERSE `listRuns` by its cursor**, not the 500-newest `cohortPeers` window: a fact
living on one anchor run would scroll out of that window as the workspace grows, after which
`loom score` would silently fall back to in-graph S1 — a loosening driven by run count. There is no
truncated case to fall back from. Newest attestation by `ts` wins.

**Correction (`ec2ad88`): the traversal is not cheap and the body said it was.** Attestation rows sit
at a journal's TAIL. The scan reads the first event of EVERY run in the listing plus the WHOLE
journal of every run of the workflow and of every exam run made under the attested hash, and nothing
caches it.

### 4.2 · The exam run — `gradeWithExam(ws, exam, subjectRunId)`

Inputs are built from two places the candidate does not author: R's `run.submitted.inputs` and R's
`run.completed.outputs`, plus `subject: R`. Every rule fails closed **in the direction that refuses
the candidate**, which is not the same direction on both sides of a pair:

- an exam input present in neither → on the CANDIDATE side the pair scores 0 and `delivered` false,
  and the exam graph is NOT run (a grader handed a missing answer must not guess); on the BASELINE
  side the pair is `unmeasured`, because scoring it 0 would hand a candidate that merely ADDS the
  missing output a free +0.6 on every pair;
- a name that is both an `input` and an `output` → the RECORDED input wins; the collision is reported;
- no `run.completed` → score 0;
- the exam RUN does not complete, or its `verdict` is not `{pass: boolean}` → **on the candidate side
  that is a fail**: a candidate could otherwise crash a weak exam on every input and hide in
  `unmeasured`. On the baseline side, `unmeasured`.

The compiled exam's `run.compiled.resolutionManifest` must equal the attested one, or the exam's
function body moved underneath the attestation and the grade is refused. A reader that finds a grade
VERIFIES it: the exam run's inputs minus `subject` must equal the subject's recorded inputs ∪
terminal outputs, and its `graphHash` must be the attested one.

### 4.3 · The exam is part of the RULER, and S1 comes from it

`scoreTrajectory(t, cohort, {exam?})` — the caller-supplied shape `downstream` already uses, so the
scorer stays pure. With `exam` present, `readSignals` emits S1 from it and does NOT read
`t.outcome.assertions`; `didWork` stops counting in-graph assertions as work; `delivered`
additionally requires `gradable`, so a work-deleting candidate scores exactly 0. With `exam` absent,
behaviour is byte-identical to the pre-exam binary — which is what keeps every old journal folding.

**`weightsDigest` becomes `digest({weights, examGraphHash})`.** That is the whole fix for the thing
the first draft missed: `freezeSuite` does not compute `golden`, it reads it off the LAST journaled
row, so an attestation on an existing workspace would otherwise freeze goldens a rigged in-graph
grader decided last month. With the exam in the digest, every row scored before the attestation — or
under another exam — is a row under a different ruler, and code that already exists excludes it and
says so. No new field, no kernel touch.

### 4.4 · The gates

- **`promote --against-cohort`** REFUSES when the workflow has no attestation, naming
  `loom exam attest`; REFUSES a candidate whose `metadata.name` differs from the cohort's workflow;
  selects recordings at or before `corpusThrough`. With an attestation, both sides of every pair are
  graded by the exam, selected by the COHORT's workflow and never the candidate's.
- **`promote --suite`** gains `12-grader-unchanged` (§B′), applied always.
- **`loom suite freeze`** REFUSES a workflow with no attestation and draws only from recordings at
  or before `corpusThrough`; `golden` rests on exam-ruler rows only.

**The invariant these produce:** *the set of graders whose verdicts count as ground truth for a
workflow, and the set of questions they are asked, change only by a human act.* No `promote` path
and no `loom run` can change either. Same shape as "oversight only tightens".

### 4.5 · What makes a graph an exam (compile-time, `evolution/exam.ts` — not kernel)

`inputs` non-empty and including `subject`; exactly one output, `verdict`; no `agent`, `tool`,
`subgraph`, `human_gate` or `evaluator{kind:"rubric"}` node — deterministic bodies only, so the grade
replays and calls no provider; terminal node is an `evaluator{kind:"assertion"}` writing `verdict`;
no node reads `subject`. The verdict is read from `run.completed.outputs`, never via
`extractSignals`.

**Two rules added during implementation, each because the candidate reached the deciding number one
edge over the previous fix.** An exam declaring no baseline OUTPUT attested and measured nothing
(`b8fc664`) — the mirror of the input rule. And a fifth rule: an exam input that is DECLARED and
named in no node's `reads`, no `${…}` in a node's tool args, and no fanout edge's `over` is refused
(`8c86559`). **Edge conditions never count** — a conditional edge's `when` is an expression the
executor skips whenever a body returns `take`, so a guard that counted it could not decide, and it
fails closed. Cost, accepted: an exam whose only read is in a `when` is refused.

**Two rules on exam AUTHORS, stated because ownership is not quality.** An exam treats every output
it reads as a CLAIM and re-derives it from the raw output rather than believing the work graph's own
summary. And an exam should write `verdict.score` in `[0, 1]` with the resolution the work has, not
`pass` alone: a pass/fail exam over a mostly-passing baseline saturates `outcomeSpread` and
`isGolden` condition 2 refuses to rank at all.

### 4.6 · Kernel and costs

**Kernel: untouched.** `journal/events.ts` gained no member and no field — the attestation rides on
the `operator.command{kind, args}` vocabulary that already existed. The seam that would be needed if
the ruler-digest carrier ever proves insufficient is named so nobody discovers it mid-fix: a fold
that must decide on exam provenance WITHOUT re-deriving the digest needs
`evolution.scored.exam?: {runId, graphHash}` — one optional field, `feat`, `Kernel-seam:` *"the
verdict vocabulary cannot say who graded"*.

Costs, named: one function-only run per graded run (60 new journals per live attempt where there
were 30), which makes the cohort scroll out of `cohortPeers`' 500-newest window after ~7 live
attempts rather than ~15 — the honest fix is a workflow filter on `listRuns`, a kernel `store.ts`
change deliberately NOT made. Re-attesting a CHANGED exam is a new ruler and re-grades everything;
re-attesting the SAME exam to admit new recordings re-grades nothing. **Correction (`ec2ad88`): the
first `loom score` after an attestation grades the whole corpus in one invocation** — 30
`graded … by exam run …` lines on the §6 fixture — so the cost table's per-verb figures move with
workspace size, not cohort size.

---

## 5 · What this does NOT close

- **A student tuned to a known exam.** The recordings are readable. `corpusThrough` stops an author
  ADDING questions; it cannot stop one READING them. F is the eventual answer.
- **A weak or trusting exam.** §4.1's checks refuse the two mechanical forms of trusting an output;
  ownership is fixed, quality is the operator's. **And the fifth rule checks NAMES**: an exam that
  names the channel in `reads` and ignores it still attests. Closing that is a dataflow analysis
  from each declared input to the terminal node, not a sixth rule.
- **`didWork` is still the candidate's for efficiency credit.** A run the exam FAILED keeps its 0.4
  of cost and latency credit — the metric's existing rule for a measured failure, left as it is.
- **The trust assumption.** Attestation is a verb a person runs; a loop given `proc.exec` ungated
  would own its own exam. This holds under one operator.
- **`promote --suite` stays a regression floor**, and its inputs still include a self-asserted file.
  The rule §4.1 applies to the attestation — the row is the authority, the file is a cache — is the
  same rule `promote --suite` should apply to `frozenAt`: look the suite up by
  `(name, version, caseRunIds)` in `evolution.suite-freeze` rows and refuse check 9 when no row
  exists. Deferred; it needs `cli.ts`. For lineage the fail-closed fix is "an agent-generated suite
  requires `--proposed-by`", which is a new rejection on every human `promote --suite` that omits
  the flag — a contract change to make deliberately, with `examples/demo/close-the-loop.sh`'s text.
- **`TODO.md` §A.29 stays OPEN.** Its defect — a frozen golden case pins channel bytes, so an honest
  fix the verifier certifies is refused by `1-must-pass` at 33.3pp — is untouched here; only its
  proposed closing MECHANISM (a per-task ordering of channel state) is superseded, because the exam
  never asks what a task saw. **Alternative G** — the exam's VERDICT as the frozen case's
  expectation, `runCase` running the exam over the REPLAYED outputs — is the C-shaped answer to the
  defect itself, and the natural second step. It changes `EvalCase.expect`'s meaning and would make
  `runCase` start runs, which is why it is not here.


### 5.1 · Two rules carried over from the 2026-08-27 live loop

Folded here on 2026-09-09 from the deleted 2026-08-27 evolution-loop note; the rest of it is in
`DESIGN.md` item 5 and in the docstrings of `evolution/score.ts`, `evolution/trajectory.ts` and
`run/engine.ts`. **Golden counts do not compare across cohorts:** `isGolden` condition 2 is a
WITHIN-cohort top decile, so roughly a tenth of ANY cohort qualifies and two cohorts reading back
`golden 4` each is arithmetic, not a tie — compare by mean score and by ground truth instead.
**And the freeze rule has a mirror:** D6 freezes the exam so it cannot be written for a known
student; the reverse failure is a student tuned against a known exam. The 2026-08-27 prompt
candidate was committed before it was ever run and not iterated afterwards, which is the only
guard there is — the live door refuses to let an operator pick the INPUTS (`--against-cohort` takes
a cohort, `--runs` says how many and never which), but nothing mechanical stops a human picking the
CANDIDATE to match the corpus.

---

## 6 · Acceptance exam

**The fixture is not in the tree and this block is not copy-pasteable** — it is built by hand in a
scratch workspace from the shapes below, which is what this section asks for. The shipped workspace
exam is `examples/exams/review-bench-exam.json`. Function-only runs have `wallMs 0` and `costUsd 0`
exactly, so every score is `0.6 × outcome` and every pair count is exact. `pick` is deliberately
wrong on even-length inputs; thirty inputs `items` of length `2 + n % 3`, n = 1…30, so 20 of the 30
recordings are wrong.

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
# models.json              adapters:[{name,provider,baseUrl,apiKeyEnv:null,prices:{"<model>":{input,output}}}]
#                          with routes:{"default":{adapter,model}}. A ROUTE row may declare only a FREE
#                          endpoint; a real rate goes on the ADAPTER row. promoteAgainstCohort refuses
#                          without a models file whether or not the candidate has an agent node, and
#                          readModels refuses an adapter whose apiKeyEnv is unset — `null` declares there
#                          is none.
```

`pick.json` must declare `picked` as an OUTPUT — the exam reads terminal outputs, and a work channel
the graph does not declare is one the exam cannot see.

1. Record and score the corpus: 30 × `loom run graphs/pick.json`, then `loom score <id>` each;
   likewise 6 runs of `graphs/other.json`. `loom cohort <last pick run>` → `members 30`.
2. **Before attestation the gates refuse and say what to do:** `loom promote candidates/fixed.json
   --against-cohort <last> --models-file models.json` → exit ≠ 0, stderr names `loom exam attest`.
   `loom suite freeze --cohort <last> --out s0.json` → same refusal. (Control: `fixed.json` is the
   honest candidate; the refusal is about the workspace.)
3. **Audit repro 2 through the replayed door:** freeze `s-legacy.json` from the 30 recordings on a
   pre-exam binary, then `loom promote candidates/rigged.json --baseline graphs/pick.json --suite
   s-legacy.json` → `✗ 12-grader-unchanged` naming
   `node:check function/check@stable → function/check-rigged@stable`, exit 1. **Control, corrected
   (`ec2ad88`):** `candidates/fixed.json` against the same suite gives `✓ 2-non-inferior Δ 0.0pp`
   and promote true, because for a suite frozen by an HONEST grader the goldens are the odd-length
   runs and `fixed` reproduces them. `✗ 1-must-pass` is the POISONED-suite shape (step 11), not a
   legacy suite's.
4. Attest: `loom exam attest exams/pick-exam.json --cohort <last> --as <you>` → exit 0; read the
   `evolution.exam-attest` row back through the store (**corrected (`ec2ad88`): `loom audit` prints
   rule verdicts and skips, not `operator.command` rows**) and check the `human` actor, the subject,
   and `corpusThrough`. Refused, each with its rule named: without `--as`; with `--as cli`;
   `exams/bad-exam.json`; an exam whose `inputs` name a channel `pick.json` declares nowhere; an
   exam containing an `agent` node; an exam that declares an input and reads it nowhere.
5. **Stale scores are stale:** every pre-attestation row is under another ruler. **Corrected
   (`ce9e7b4`): `loom cohort <last>` immediately after attestation reports `members 30`,
   `excludedForWeights 0`, `golden true 10`, `p90Score 0.6`, not the `excludedForWeights 30` /
   `members 0` the body predicted** — `case "cohort"` keys on the queried run's OWN last row, so it
   always counts self, and the FIRST `loom score` after an attestation grades the whole corpus in
   one invocation, so the predicted state is not observable at that point.
6. **Audit repro 1 is REFUSED:** `loom promote candidates/noop.json --against-cohort <last>` →
   `✗ L1-paired-improvement` Δ −0.2000 (sd 0.2877, n 30, 0W/10L/20T) and `✗ L5-candidate-earned-it`
   ("scored 0 on every input"). exit 1.
7. **Audit repro 2 through the live door is REFUSED:** `candidates/rigged.json --against-cohort` →
   `✗ L1` Δ 0.0000, 0W/0L/30T, exit 1 — and `✓ L5` "scored above 0 on 10 of 30". That last line is
   the one that says the property is working: the rigged grader returns `{pass:true}` on all thirty
   and the candidate still scored above 0 on ten. The exam's answer, not the graph's.
8. **Attacks R and Q are REFUSED:** `candidates/renamed.json` is refused before any run starts,
   naming `pick-bench-2` ≠ `pick-bench`. Then record 30 more `pick.json` runs on odd-length inputs
   only and re-run step 6: still Δ −0.2000 over 30 pairs — the new recordings are after
   `corpusThrough` and are not questions.
9. **The ORDINARY half PROMOTES:** `candidates/fixed.json --against-cohort` → `✓ L1` Δ +0.4000 (sd
   0.2877, n 30, 20W/0L/10T), t lower bound 0.3108, Wilcoxon 0.3000, `✓ L5` 30/30, `✓ 3-cost`,
   exit 0. The journaled `evolution.promote` row carries `examGraphHash`, `corpusThrough` and 60
   exam run ids.
10. **Unattested workflows fold as before:** `loom score <an other-bench run>` prints, byte-for-byte
    except `ts`, what it printed in step 1.
11. **Poisoning cannot recur:** copy `candidates/rigged.json` into `graphs/` by hand, run it 30
    times, `loom score` each — every even-length run is NOT golden, whatever `check-rigged` said.
    Then `candidates/renamed.json` the same way: its runs are workflow `pick-bench-2`, which has no
    attestation, so the rename buys a new workflow, not a way past the exam.
12. **Restart survives:** delete `exams/pick-exam.json` from disk and re-run step 9 — the exam is
    compiled from the attestation row; same verdict, `✓ L1`.

Steps 6, 7 and 9 are the three the property is measured by; 11 is the one the audit's third finding
needs; 5 and 8 are the two the first draft would have failed.

---

## 7 · Non-goals, and what is left for later

- No candidate generator, no canary rollout (`TODO.md` §E.3 stands; F).
- No change to `SIGNAL_WEIGHTS`, `DEFAULT_WEIGHTS`, `MIN_COHORT_SIZE`, `MIN_PAIRED_RUNS`, or the
  statistics in `live.ts`.
- No `listRuns` workflow filter (kernel `store.ts`); the traversal cost is carried in §4.6, and the
  filter is the first thing a long-lived workspace will ask for.
- No graph-scoped durable fact (§D.5); the attestation borrows a run coordinate like its two
  predecessors, and is the third argument for deciding §D.5.
- Alternative G is the second step (§5).
- `promote --suite` keeps checks 9 and 10 as they are; their fail-closed fixes are in §5.

**Five candidate-owned paths to S1 were closed in total, three of them reopenings of the previous
fix one edge over** — a candidate-added rubric raising the outcome of a run the exam FAILED,
0 → 0.2308, because `outcomeOf` averages over the signals present (`a7bc2ee`); an attested spec
compiled and RUN without `examShape` ever being applied to the row, so a relay exam took
`rigged.json` from `✗ L1 Δ 0.0000` to `✓ L1 Δ +0.4000 exit 0` (`5b3f568`); and the no-baseline-output
exam (`b8fc664`). **That is the shape to expect of the next one.**
