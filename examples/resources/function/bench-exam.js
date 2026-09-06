// THE EXAM'S BODY. It reads the raw `reviews` — the model's text, one per case, in case order —
// and RE-DERIVES each verdict against `cases[j].defect` with its own parser. It does not read
// `verdicts` (what `bench-collate` wrote) or `verdict0`…`verdict5` (what the six `bench-check`
// evaluators wrote): both are the work graph's own summary of its work, which a candidate may
// rewrite, and an exam treats every output it reads as a CLAIM to be checked, never believed.
//
// The parser is the balanced-object scan `bench-collate-v2.js` documents, so a review that buries
// its JSON under a reasoning preamble is still read — which is exactly the improvement v2 makes,
// and an exam using the naive first-brace-to-last-brace parser would be blind to it. `score` is
// k/6, so the ladder spreads over a cohort and `isGolden` condition 2 can rank.
(view) => {
  const balancedObjects = (text) => {
    const out = [];
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
      if (ch === "}") {
        depth--;
        if (depth === 0 && start >= 0) { out.push(text.slice(start, i + 1)); start = -1; }
        if (depth < 0) { depth = 0; start = -1; }
      }
    }
    return out;
  };
  const flaggedBy = (review) => {
    const raw = typeof review === "string" ? review : JSON.stringify(review);
    const text = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    let best;
    for (const span of balancedObjects(text)) {
      let value;
      try { value = JSON.parse(span); } catch (e) { continue; }
      if (value !== null && typeof value === "object" && typeof value.verdict === "string") best = value;
    }
    return best !== undefined && best.verdict === "concerns" && Array.isArray(best.findings) && best.findings.length > 0;
  };
  const cases = view.get("cases") ?? [];
  const reviews = view.get("reviews") ?? [];
  let correct = 0;
  const detail = [];
  for (let j = 0; j < cases.length; j++) {
    const c = cases[j];
    const flagged = j < reviews.length && flaggedBy(reviews[j]);
    const ok = Boolean(c.defect) === flagged;
    if (ok) correct++;
    detail.push(c.id + ": " + (c.defect ? (flagged ? "FOUND" : "MISSED") : flagged ? "FALSE ALARM" : "correctly clean"));
  }
  const n = cases.length;
  const score = n === 0 ? 0 : correct / n;
  return { writes: { verdict: { pass: n > 0 && correct === n, score: score, confidence: 1, detail: detail.join("; ") } } };
}
