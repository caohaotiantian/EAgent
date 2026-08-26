(view) => {
  const reviews = view.get("reviews") ?? [];
  const parsed = reviews.map((r) => {
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { verdict: "unparsed", findings: [] };
    try { return JSON.parse(m[0]); } catch (e) { return { verdict: "unparsed", findings: [] }; }
  });
  return { writes: { verdicts: parsed } };
}
