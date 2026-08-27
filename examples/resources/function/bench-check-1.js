// Case 1 alone. SIX EVALUATOR NODES, NOT ONE, because `readSignals` computes S1 as
// (assertion nodes that passed) / (assertion nodes), so one node is one bit: a review that
// found five of six planted defects scored the same 0 as one that found none. Six make S1 k/6.
(view) => {
  const c = (view.get("cases") ?? [])[1];
  const v = (view.get("verdicts") ?? [])[1];
  if (c === undefined) return { writes: { verdict1: { pass: false, score: 0, confidence: 1, detail: "no case 1 in this input" } } };
  // "Flagged" is a verdict of concerns WITH findings. A model that says "concerns" and lists
  // nothing has not found anything, and counting it would pay for hedging.
  const flagged = v !== undefined && v.verdict === "concerns" && (v.findings ?? []).length > 0;
  const correct = c.defect === flagged;
  const detail = c.id + ": " + (c.defect ? (flagged ? "FOUND" : "MISSED") : flagged ? "FALSE ALARM" : "correctly clean");
  return { writes: { verdict1: { pass: correct, score: correct ? 1 : 0, confidence: 1, detail: detail } } };
}
