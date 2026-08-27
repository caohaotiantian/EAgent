#!/usr/bin/env bash
#
# THE SELF-IMPROVEMENT LOOP, END TO END, AGAINST A REAL PROVIDER.
#
# This script is the LIVE half of roadmap item 5, and it is deliberately a script rather than a
# test: `npm run check` must never call a provider, so the demonstration that matters most is the
# one the gate can never run. The offline half is
# `packages/core/test/evolution/close-the-loop.test.ts` and it runs in 284 ms for $0.
#
# WHAT IT DOES, and in this order, because the order is the rule rather than a convenience:
#
#   1. Thirty runs of `graphs/review-bench.json` against a live model. Six diffs per run, three
#      carrying a planted defect and three cosmetic, so every run is graded mechanically against
#      `bench-cases.json` with no human and no rubric — an S1 signal, the only kind a model
#      cannot argue with.
#   2. `loom score` on each, which folds the run, assembles the cohort from the workspace's other
#      runs of the same cohort key, and journals the verdict as `evolution.scored`.
#   3. `loom cohort` on the last, which reads those verdicts back: n, how many came back golden,
#      and how many were excluded for having been judged under different weights.
#   4. FREEZE THE SUITE — before the candidate is looked at. `9-suite-predates-candidate`
#      compares `suite.frozenAt` against the candidate's `proposedAt` and refuses an exam written
#      for a known student. The expectations come from the planted ground truth in
#      `bench-cases.json`, never from what the baseline produced.
#   5. `loom promote` the candidate, which replays those recordings against both graphs. It calls
#      NO model and runs NO tool, so step 5 is free however expensive step 1 was.
#
# THE CANDIDATE IS `candidates/review-bench-v2.json`, and its improvement is entirely in a
# `function` body — `bench-collate-v2.js`, whose parser survives a reasoning preamble where the
# shipped one returns `{"verdict":"unparsed"}` and reads downstream as a MISS. That is not a
# stylistic choice. `loom promote` refuses a candidate whose only change is a PROMPT, because
# replay would serve the recorded answer to a question the candidate never asked; a function body
# RE-EXECUTES under replay, so the same recorded model text parsed correctly is a real delta.
#
# WHAT TO EXPECT, and what NOT to engineer around. With six cases and a graded S1, `MIN_OUTCOME`
# of 0.8 means a run must get 5 of 6 diffs right to clear condition 1. The one live GLM-5.2 run
# on record got exactly 5 of 6 — three defects found, two of three clean diffs cleared, one false
# alarm — so the golden yield sits on a knife edge and IS the measurement. If it comes back 0/30,
# report that. Widening the benchmark until it passes is writing the exam for the student.
#
# THE CANDIDATE MIGHT ALSO SIMPLY NOT WIN, and that is a result too: if none of the thirty
# recordings trips the greedy parser, it ties the baseline and `2-non-inferior` passes at Δ 0.0pp
# — a promotion, but not a demonstration. Read the recordings before believing the delta.
#
set -euo pipefail

WS="${WS:-$(cd "$(dirname "$0")/.." && pwd)}"
LOOM="${LOOM:-node $(cd "$(dirname "$0")/../../packages/core/src" && pwd)/cli.ts}"
MODELS="${MODELS:-$WS/models.json}"
RUNS="${RUNS:-30}"
# Four, not thirty. Half two of the 429 fix has failed twice: a rate limit still sleeps holding
# the worker slot, and review-bench fans out six ways, so four concurrent runs is twenty-four
# requests in flight. Step up only after watching one batch.
PAR="${PAR:-4}"
OUT="${OUT:-$WS/.demo}"

if [ ! -f "$MODELS" ]; then
  echo "no models file at $MODELS — this script calls a real provider on purpose." >&2
  echo 'Write one: {"adapters":[{"provider":"openai","name":"m","baseUrl":"…","apiKeyEnv":"…"}],' >&2
  echo '            "routes":{"agent_profile/reviewer@stable":{"adapter":"m","model":"…"}}}' >&2
  echo "Set defaultMaxTokens generously: a reasoning model spends most of its budget before it" >&2
  echo "writes anything — measured on GLM-5.2, roughly 17 reasoning tokens per content token." >&2
  exit 1
fi

mkdir -p "$OUT"
INPUT="$(cat "$WS/bench-cases.json")"

echo "== 1 · $RUNS live runs of review-bench, $PAR at a time"
seq 1 "$RUNS" | xargs -P "$PAR" -I{} sh -c \
  "$LOOM run '$WS/graphs/review-bench.json' --workspace '$WS' --models-file '$MODELS' --input '$INPUT' > '$OUT/run-{}.json'"
node -e '
  const {readdirSync,readFileSync}=require("fs");
  const dir=process.argv[1];
  const ids=readdirSync(dir).filter(f=>/^run-\d+\.json$/.test(f))
    .map(f=>JSON.parse(readFileSync(`${dir}/${f}`,"utf8")));
  console.log(`  ${ids.length} runs, ${ids.filter(r=>r.status==="succeeded").length} succeeded`);
  console.log(`  spend $${ids.reduce((a,r)=>a+(r.usage?.costUsd??0),0).toFixed(4)}`);
  require("fs").writeFileSync(`${dir}/ids.json`,JSON.stringify(ids.map(r=>r.runId),null,2));
' "$OUT"

echo "== 2 · loom score, once per run"
node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).join("\n"))' "$OUT/ids.json" \
  | while read -r id; do $LOOM score "$id" --workspace "$WS" > "$OUT/score-$id.json"; done

echo "== 3 · the cohort those thirty runs formed"
LAST=$(node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(a[a.length-1])' "$OUT/ids.json")
$LOOM cohort "$LAST" --workspace "$WS" > "$OUT/cohort.json"
node -e '
  const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  console.log(`  key ${c.cohortKey}`);
  console.log(`  members ${c.members.length}  golden ${c.members.filter(m=>m.golden).length}` +
              `  excludedForWeights ${c.excludedForWeights}  truncated ${c.truncated}`);
' "$OUT/cohort.json"

echo "== 4 · freeze the exam, BEFORE looking at the candidate"
node -e '
  const {readFileSync,writeFileSync}=require("fs");
  const [idsFile,casesFile,out]=process.argv.slice(1);
  const ids=JSON.parse(readFileSync(idsFile,"utf8"));
  const cases=JSON.parse(readFileSync(casesFile,"utf8")).cases;
  // Six recordings, and the expectations are the PLANTED ground truth: every case the review
  // should have flagged, and every case it should not have. Never what the baseline produced.
  const picked=ids.slice(0,6);
  // `expect.channels` is compared by canonical form, so each verdict channel is named in full —
  // the exact object `bench-check-<j>.js` writes when the review got case j right.
  const truth=Object.fromEntries(cases.map((c,j)=>[`verdict${j}`,{
    pass:true, score:1, confidence:1,
    detail:`${c.id}: ${c.defect?"FOUND":"correctly clean"}`,
  }]));
  writeFileSync(out,JSON.stringify({
    name:"review-bench", version:1, frozen:true, frozenAt:Date.now(), generatedBy:"maintainer",
    cases:picked.map((runId,i)=>({ id:`c${i}`, runId, mustPass:i<2, expect:{status:"succeeded", channels:truth} })),
    composition:{minCases:6,minMustPass:2},
  },null,2));
  console.log(`  frozen over ${picked.length} recordings -> ${out}`);
' "$OUT/ids.json" "$WS/bench-cases.json" "$OUT/suite.json"
echo "  NOTE: this writes a MAXIMAL exam — every case, every diff correct. That is the honest"
echo "  starting point and probably not the one to promote against: a model that gets 5 of 6"
echo "  right fails every case of it. Open $OUT/suite.json and decide what correct means before"
echo "  anybody proposes a candidate. Deciding it afterwards is the exam written for a student."
echo "  Driven offline against the mock, where the model flags nothing, this exact shape gives:"
echo "    ✗ 1-must-pass  must-pass failures: c0, c1"
echo "    ✓ 2-non-inferior  pass rate 0.0% vs baseline 0.0% (Δ 0.0pp)     ← and note that this"
echo "  PASSES at 0 vs 0. \`gateCandidate\` is a non-inferiority test; the must-pass floor is what"
echo "  refuses a candidate nothing measured. exit=1."

echo "== 5 · promote — replay only, no model, no tool"
set +e
$LOOM promote "$WS/candidates/review-bench-v2.json" \
  --baseline "$WS/graphs/review-bench.json" \
  --suite "$OUT/suite.json" \
  --proposed-by maintainer \
  --workspace "$WS" | tee "$OUT/promotion.json"
CODE=${PIPESTATUS[0]}
set -e
echo "  exit=$CODE  (0 promotes, 1 refuses)"
echo
echo "The decision is journaled on the first case's run as operator.command"
echo "{kind: \"evolution.promote\"}. Read it back with: $LOOM audit \$(head -1 $OUT/ids.json)"
