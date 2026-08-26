(view) => {
  const cases = view.get("cases") ?? [];
  const verdicts = view.get("verdicts") ?? [];
  // Branch order is the fan-out order, which is the case order — the join folds in
  // branch-coordinate order, which is what makes this pairing sound rather than lucky.
  let hit = 0, miss = 0, falseAlarm = 0, correctClean = 0;
  const detail = [];
  cases.forEach((c, i) => {
    const v = verdicts[i];
    const flagged = v !== undefined && v.verdict === "concerns" && (v.findings ?? []).length > 0;
    if (c.defect && flagged) { hit++; detail.push(c.id + ": FOUND"); }
    else if (c.defect && !flagged) { miss++; detail.push(c.id + ": MISSED"); }
    else if (!c.defect && flagged) { falseAlarm++; detail.push(c.id + ": FALSE ALARM"); }
    else { correctClean++; detail.push(c.id + ": correctly clean"); }
  });
  const n = cases.length;
  const correct = hit + correctClean;
  // `pass` is the assertion; `score` is how well, both read by the fold as S1.
  return {
    writes: {
      verdict: {
        pass: miss === 0 && falseAlarm === 0,
        score: n === 0 ? 0 : correct / n,
        confidence: 1,
        detail, hit, miss, falseAlarm, correctClean,
      },
    },
  };
}
