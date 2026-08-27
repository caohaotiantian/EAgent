// THE CANDIDATE, and the improvement is entirely in this body — which is what makes it
// measurable offline. `loom promote` replays a recorded run against a candidate graph and serves
// every model turn from the recording, so a candidate whose change is a PROMPT is refused: the
// gate would be certifying an answer to a question nobody asked. A `function` body RE-EXECUTES
// under replay, so the same recorded model text, parsed correctly, is a real delta.
//
// WHAT bench-collate.js GETS WRONG. Its parser is `/\{[\s\S]*\}/` — greedy, first brace to last
// brace — and `JSON.parse` on that span. Measured against six realistic model shapes:
//
//   clean JSON                             -> concerns   flagged=true
//   fenced ```json block                   -> concerns   flagged=true
//   reasoning preamble containing a brace  -> unparsed   flagged=false
//   trailing prose containing a brace      -> unparsed   flagged=false
//   a scratch object before the answer     -> unparsed   flagged=false
//   no JSON at all                         -> unparsed   flagged=false
//
// An `unparsed` verdict reads downstream as "not flagged", which is a MISS on every case that
// carries a defect. The three middle rows are not hypothetical: GLM-5.2 spends roughly 17
// reasoning tokens per content token, so a preamble is the ordinary case rather than the odd one.
//
// The rule here: strip fences, then scan for BALANCED objects — tracking string literals and
// escapes, so a brace inside a quoted string does not close a span — and take the LAST one that
// parses and names a `verdict`. Last, because a model's answer follows its scratch work. A text
// with no balanced object at all is still `unparsed`, which is the honest answer and the one row
// above that must NOT change.
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
  const reviews = view.get("reviews") ?? [];
  const parsed = reviews.map((r) => {
    const raw = typeof r === "string" ? r : JSON.stringify(r);
    // A fenced block is the common wrapper; removing the fence markers alone is enough, because
    // the scan below finds the object inside whatever is left.
    const text = raw.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");
    const spans = balancedObjects(text);
    let best;
    for (const span of spans) {
      let value;
      try { value = JSON.parse(span); } catch (e) { continue; }
      if (value === null || typeof value !== "object") continue;
      if (typeof value.verdict === "string") best = value;
      else if (best === undefined) best = value;
    }
    if (best === undefined || typeof best.verdict !== "string") return { verdict: "unparsed", findings: [] };
    return best;
  });
  return { writes: { verdicts: parsed } };
}
