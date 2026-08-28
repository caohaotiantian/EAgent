# The self-improvement loop, driven end to end against a live provider

> **Commit hashes in this file predate a history rewrite and no longer resolve.** On
> 2026-08-28 the branch was filtered to remove a Stripe-shaped fixture string from
> `docs/audit-2026-08-25.md` (GitHub push protection rejected it; the string was fake, and the
> reasoning is `TODO.md` §F.16). Filtering rewrote every commit in `86b84c9..HEAD`, so every
> short hash below points at an object that is gone. **The subjects are unchanged**, so a
> reference resolves with `git log --grep='<the subject or a phrase from it>'`. The hashes are
> left as written rather than renumbered: this is a dated record, and a record edited to agree
> with a later state is no longer a record of anything.

**2026-08-27.** Roadmap item 5's fails-today is *"thirty runs of one workflow sharing a cohort
key, and a candidate promoted over them because it measurably beat the baseline."* This is the
record of driving it. Every number here came from running the shipped CLI; nothing is estimated.

Provider: GLM-5.2 over an OpenAI-compatible endpoint. Total spend for everything below: **$1.29**
(baseline corpus $0.78, candidate corpus $0.51). The key was read from the environment and never
written to a file — no `sk-` string and no endpoint address reached any tracked file or journal.

---

## 1 · The corpus, and the cohort it forms

33 runs of `examples/graphs/review-bench.json`. Each run reviews six diffs of this repo's own
code: three carry a planted defect, three are cosmetic. Grading is mechanical against
`examples/bench-cases.json` — no human, no rubric, no model judging itself.

    members 33  golden 4  excludedForWeights 0  truncated false
    key  review-bench|sha256:2985c869…|default|shape:54b682a9

One cohort key over 33 runs. That is the first half of the fails-today, and it needed no code
change: `loom score --bucket` already calls the `bucketInput` seam and `defaultBucket` keys on
the input's SHAPE.

**One run of the 34 failed, and it is a fix working.** The model spent all 32,001 output tokens
reasoning and returned zero content characters; `0d1fe4b` makes that
`E_PROVIDER_BAD_REQUEST … finishReason "max_tokens"` rather than a silently empty answer. It is
also live evidence for the open §A0 item that nothing warns when `defaultMaxTokens` is too small
for a reasoning model.

## 2 · The candidate, and why it is the kind that matters

D6 defines self-improvement as **text-space optimisation**. The tree's only candidate,
`review-bench-v2`, changes a FUNCTION body — the one kind the offline replay gate can measure —
and on this corpus it is worth exactly nothing, measured: `bench-collate`'s parser handled 197 of
198 recorded answers, the model's verdict vocabulary was exactly `{clean: 124, concerns: 73}`,
and every `concerns` carried findings. The parse failure v2 repairs occurs **zero** times here,
so `Δ 0.0pp`, refused, is the correct answer and the gate gave it.

`review-bench-v3` is a text candidate: identical graph, identical functions, one changed ref
(`prompt/review@stable` → `prompt/review-v2@stable`). The prompt tells the reviewer to read what
a diff REMOVES — a removed condition is a removed guarantee — argued from how diffs work rather
than from these scores. **It was committed at `67c8ab8` before it was ever run.** D6's freeze rule
stops an exam being written for a known student; the mirror failure is a student tuned against a
known exam, and the guard against it is that the prompt was authored once and not iterated.

## 3 · The result

Ground truth, 32 runs each, same six diffs, same inputs:

    cohort      n    mean      sd     6/6      distribution              $/run
    baseline   32    5.000/6   0.803  8 (25%)  {3:2, 4:4, 5:18, 6:8}     0.0250
    candidate  32    5.719/6   0.457  23 (72%) {5:9, 6:23}               0.0159

    Δ mean = +0.719 of 6      SE 0.163      Welch t = 4.40

The candidate never scores below 5, where the baseline has six runs at 3–4. It is also **36%
cheaper**: a more decisive prompt spends less on reasoning.

Through the product's own scorer, both cohorts read back with `loom cohort`:

    BASELINE   members 33  golden 4  mean score 0.619  p90 0.744
    CANDIDATE  members 32  golden 4  mean score 0.696  p90 0.780

Equal golden counts are expected, not a tie: `isGolden` condition 2 is a WITHIN-cohort top decile,
so roughly a tenth of any cohort qualifies. The cross-cohort comparison is the mean and the
ground-truth delta, and both favour the candidate.

**A later run is measurably better because of an earlier one, and the measurement is one the
thing being measured cannot game**: the six planted defects are fixed, the grading is arithmetic
over them, and S5 — the model's own report that it is done — carries weight 0.0.

## 4 · What driving it found that reading it never had

- **The live script had never been run.** It died on its own first step twice, for two different
  reasons: the six diffs inlined into an `xargs -I{}` template thirty times, and then BSD
  `xargs -I`'s 255-byte cap on the command it builds. Both fixed; it is a bounded loop now.
- **An absent channel killed `loom promote` outright.** Moving `expect.channels` to the canonical
  comparison its own docstring promised turned "this run never wrote that channel" into
  `E_INTERNAL: CanonicalizationError` — `canonicalize` refuses `undefined` where `JSON.stringify`
  returned it. Now a case failure with a readable reason.
- **`loom score` reports outcome 0 for a run whose graph the workspace cannot resolve.** The
  candidate's graph lived in `candidates/`, not `graphs/`, so the fold got no spec, found no
  evaluator nodes, and returned `signals: []` → outcome 0 → score 0.111. Same run, same command,
  with the graph copied into `graphs/`: `S1 6/6 assertions passed`, outcome 1, score 0.700.
  Silently scoring 0 for "I could not find the spec" is indistinguishable from "this run failed
  every assertion", and it makes every candidate look worthless. **This is the third
  folded-without-its-graph defect this session.**

  *Amended 2026-08-27, same day:* fixed. `loom score` refuses — exit 1, no verdict printed and
  **nothing appended** — and `--graph <file>` supplies the spec without publishing it, which
  matters because publishing into `graphs/` is also what marks a graph promoted. The library
  half is `Trajectory.specResolved`, read by `scoreTrajectory` (outcome and score both 0,
  `components.specResolved` saying which zero it is), by `isGolden` condition 6, and by
  `measureCohort`, which drops such a member from the population. Reproducing §5's second line
  no longer needs the graph in `graphs/`: `loom score <runId> --workspace <ws> --graph
  candidates/review-bench-v3.json`. See `TODO.md` §A0 for what is still uncovered.

## 5 · To reproduce

    # the corpus and the loop, end to end (calls a provider, ~$0.8, ~30 min)
    WS=<workspace> MODELS=<models.json> RUNS=30 bash examples/demo/close-the-loop.sh

    # the candidate, against the same inputs
    loom run  candidates/review-bench-v3.json --workspace <ws> --models-file <models.json> \
              --input "$(cat bench-cases.json)"
    loom score <runId> --workspace <ws> \
      --graph candidates/review-bench-v3.json  # the spec, without publishing it; see §4
    loom cohort <runId> --workspace <ws>

---

## 6 · The promotion, through the verb

`loom promote --against-cohort` judges a candidate by RUNNING it on inputs taken out of the
baseline recordings, and comparing the PAIRED score differences. It exists because the replayed
door serves every model turn from the recording, so a prompt candidate replays byte-identically
and that door can only refuse it.

    node packages/core/src/cli.ts promote candidates/review-bench-v3.json \
      --against-cohort 01M11C1S4E6G48HGWVH0W6ZG7X --runs 20 \
      --workspace <ws> --models-file <glm.json> --as caohaotiantian
    EXIT=0

    ✓ 3-cost                     cost ratio 0.58× (max 1.1×) — $0.304869 vs $0.527962
    ✓ 5-prompt-size              prompt growth 136.7% (bought by the paired mean)
    ✓ 6-oversight-diff           no posture lowered
    ⊘ 8-determinism              DID NOT RUN … It is not reported as passed
    ✓ L1-paired-improvement      paired mean Δscore 0.1356 (sd 0.0767, n 20),
                                 one-sided 95% lower bound 0.1059 — needs > 0.
                                 Sign test 20W/0L/0T, p 0.0000
    ✓ L2-every-input-measured    every selected input produced a terminal candidate run
    ✓ L3-paired-count            20 paired measurement(s) (need ≥ 6)
    ✓ L4-gated-at-least-as-much  the candidate gated everywhere the baseline did
    ✓ L5-candidate-earned-it     the candidate scored above 0 on 20 of 20 input(s)
    "promote": true

Read back out of the journal on the anchor run:

    mode          live-cohort
    promote       true
    checksNotRun  ["8-determinism"]
    cohort        {n: 32, p50CostUsd: 0.021457, p90Score: 0.744, weightsDigest: sha256:61a833d4…}
    paired        {n: 20, mean: 0.135576, sd: 0.076671, lower95: 0.105934,
                   wins: 20, losses: 0, ties: 0, signTestP: 0.000001}
    actor         {kind: human, subject: caohaotiantian, via: console}

and carrying no suite fields, so a live certificate cannot be read as a replayed one.

**A twenty-to-nothing sweep.** Every one of the twenty inputs scored higher under the candidate.
The bound is what gates — `lower95 > 0`, strictly, because `>= -margin` certifies "we could not
detect harm", which is a different sentence from "measurably beat".

## 7 · What it still does not prove

- **One input shape.** All 20 pairs are the same six diffs. Pairing removes input variance that
  is not there, and each input was run ONCE, so within-input model nondeterminism is folded into
  the between-graph difference. The sweep is well clear of it; a wider corpus would still be a
  different and better claim.
- **`8-determinism` did not run** and cannot in this mode. The verdict says so in three places.
- **`L4-gated-at-least-as-much` has no end-to-end coverage** — see `TODO.md` §A0. This graph
  raises no gates, so it passed vacuously here.
- **A graph that DOES raise a blocking gate cannot be promoted through this door at all**, and
  the refusal blames a missing measurement rather than a waiting human. Also §A0.
