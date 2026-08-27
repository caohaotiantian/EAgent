# The self-improvement loop, driven end to end against a live provider

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
  folded-without-its-graph defect this session** and it is recorded in `TODO.md` as open.

## 5 · To reproduce

    # the corpus and the loop, end to end (calls a provider, ~$0.8, ~30 min)
    WS=<workspace> MODELS=<models.json> RUNS=30 bash examples/demo/close-the-loop.sh

    # the candidate, against the same inputs
    loom run  candidates/review-bench-v3.json --workspace <ws> --models-file <models.json> \
              --input "$(cat bench-cases.json)"
    loom score <runId> --workspace <ws>      # needs the graph in graphs/, see §4
    loom cohort <runId> --workspace <ws>
