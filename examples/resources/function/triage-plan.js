/**
 * `function/triage-plan@stable` — turn what `fs.glob` found into the fan-out's source.
 *
 * A tool node that declares no channel of the tool's own naming gets the tool's `content` on
 * its first declared write channel, so `found` here is `fs.glob`'s human-readable answer: one
 * root-relative path per line, or the literal `(no matches)`.
 *
 * THIS BODY REFUSES FOUR TIMES, and every one of them is the same defect wearing a different
 * hat: evidence going missing from a document a person is about to approve, with nothing saying
 * so. **Every refusal here exists because the alternative is a report that lies about a green
 * suite.**
 *
 *  - **Nothing matched.** A fan-out over an empty array produces no branches and the join folds
 *    nothing, so the run would SUCCEED with a report saying zero failures — which reads as "your
 *    suite is clean" when what happened is that you pointed it at a directory that is not there.
 *  - **More shards than the fan-out can carry.** `maxWidth` on the fan-out edge (and
 *    `policy.expansion.maxFanout` above it) CLAMPS silently: 30 shards with a width of 24 runs 24
 *    branches, and nothing in the run, the trace or the report says the other six were never read.
 *    A triage report missing a quarter of its evidence is worse than no report, so the count is
 *    checked HERE, where the number is still known and the refusal can name it.
 *  - **The LISTING was truncated.** `fs.glob` caps at 100 paths and says so in a final `… ` line.
 *    Dropping that line and triaging the 100 is the clamp again, one layer up — and this one the
 *    ceiling check cannot catch, because 100 arriving under a width of 128 looks like a complete
 *    answer. Unreachable at the shipped width (100 > 24, so the ceiling fires first) and refused
 *    anyway: a guard whose reachability depends on another guard's constant is not a guard.
 *  - **No fan-out to read the ceiling off.** Below.
 *
 * THE CEILING IS READ OFF THE GRAPH, NOT WRITTEN HERE. `ctx.node` is this node as its graph
 * declared it — `{id, type, reads, writes, out}`, frozen — and `out` reduces each outgoing edge
 * to `{id, kind, over?, as?, maxWidth?, maxIterations?}`. A `fanout` edge whose `over` is
 * `"shards"` — the channel this body writes, named literally here and in the graph — is one that
 * will spread it, and its `maxWidth` is a number the executor actually clamps at. So the bound
 * has ONE home, in `graphs/triage-failures.json`, and raising it there is the whole edit.
 *
 * "A" AND NOT "THE", because nothing stops a graph spreading one array down two fan-outs. This
 * takes the SMALLEST width of all of them and names the edge it came from: the tightest is the
 * one that would drop evidence first, so a body reading the loosest would refuse too late, which
 * is the silent clamp with an extra step.
 *
 * AND IF NO SUCH EDGE IS THERE, THIS REFUSES rather than running unbounded — the fourth refusal.
 * Both engine callers supply `ctx.node`, so the missing cases are a graph pointing some OTHER node
 * at this ref (one with no `fanout` over `shards`) and a caller invoking this body directly, which
 * passes no node at all. Guessing a ceiling in either would be the silent clamp again, this time
 * with the body's own blessing.
 */
function (view, ctx) {
  // `/\r?\n/`, not `"\n"`. A CI shard produced on Windows, or checked out under
  // `core.autocrlf=true`, ends every line with `\r\n`; splitting on `"\n"` alone leaves a `\r`
  // that `.trim()` here would hide and that `triage-classify.js`'s anchored regexes would NOT.
  const found = String(view.require("found"));
  const lines = found.split(/\r?\n/).map((line) => line.trim());
  // `fs.glob`'s truncation marker, which is the ONE line here that must not be quietly dropped.
  const truncated = lines.filter((line) => line.startsWith("…"));
  const shards = lines.filter((line) => line !== "" && line !== "(no matches)" && !line.startsWith("…"));

  if (truncated.length > 0) {
    return {
      refuse: {
        reason:
          "the file listing was TRUNCATED, so these " + shards.length + " paths are not all of them: " +
          truncated.join(" ") + ". Triaging a capped listing reports a subset of the evidence as if it " +
          "were the whole. Narrow the pattern until the listing is complete.",
      },
    };
  }

  if (shards.length === 0) {
    return {
      refuse: {
        reason: "no test-output files matched — check the --input pattern, and that it is relative to the workspace root",
      },
    };
  }

  // EVERY fanout edge over this channel, and the TIGHTEST of them — not the first found. The edge
  // OBJECT is kept rather than just its number, because the refusal has to name the edge whose
  // width bound it: telling an operator to raise "fan" when the binding edge was another one sends
  // them to change a number that was never the cap. An edge whose `maxWidth` is not a number is
  // counted as unreadable rather than skipped, so a width this body cannot see can never widen the
  // ceiling.
  const fans = (ctx.node === undefined ? [] : ctx.node.out).filter((e) => e.kind === "fanout" && e.over === "shards");
  const bounded = fans.filter((e) => typeof e.maxWidth === "number");
  if (bounded.length === 0 || bounded.length !== fans.length) {
    return {
      refuse: {
        reason:
          "this body plans a fan-out over \"shards\" and cannot read its width: node " +
          (ctx.node === undefined ? "(no ctx.node was supplied)" : "\"" + ctx.node.id + "\"") +
          " declares " + fans.length + " fanout edge(s) over \"shards\", of which " + bounded.length +
          " state a numeric maxWidth. Running on would drop every shard past a width nobody stated, " +
          "without a word.",
      },
    };
  }
  let binding = bounded[0];
  for (const e of bounded) if (e.maxWidth < binding.maxWidth) binding = e;

  if (shards.length > binding.maxWidth) {
    return {
      refuse: {
        reason:
          "matched " + shards.length + " test-output files but this graph fans out at most " + binding.maxWidth +
          " — the rest would be dropped without a word. Narrow the pattern, or raise maxWidth on the \"" +
          binding.id + "\" edge (and policy.expansion.maxFanout above it).",
      },
    };
  }
  return { writes: { shards: shards } };
}
