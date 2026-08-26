(view) => {
  const reviews = view.get("reviews") ?? [];
  const parsed = reviews.map((r) => {
    const text = typeof r === "string" ? r : JSON.stringify(r);
    const m = /\{[\s\S]*\}/.exec(text);
    if (!m) return { file: "unparsed", verdict: "concerns", findings: [], raw: text.slice(0, 200) };
    try { return JSON.parse(m[0]); } catch (e) { return { file: "unparsed", verdict: "concerns", findings: [], raw: text.slice(0, 200) }; }
  });
  const findings = parsed.flatMap((p) => (p.findings ?? []).map((f) => ({ ...f, file: p.file })));
  return {
    writes: {
      report: {
        filesReviewed: parsed.length,
        clean: parsed.filter((p) => p.verdict === "clean").length,
        findings,
      },
    },
  };
}
