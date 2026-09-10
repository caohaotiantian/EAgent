/**
 * `function/triage-plan@stable` — turn what `fs.glob` found into the fan-out's source.
 *
 * A tool node that declares no channel of the tool's own naming gets the tool's `content` on
 * its first declared write channel, so `found` here is `fs.glob`'s human-readable answer: one
 * root-relative path per line, or the literal `(no matches)`.
 *
 * THIS BODY REFUSES THREE TIMES, and the first two exist because the alternative is a report
 * that lies about a green suite.
 *
 *  - **Nothing matched.** A fan-out over an empty array produces no branches and the join folds
 *    nothing, so the run would SUCCEED with a report saying zero failures — which reads as "your
 *    suite is clean" when what happened is that you pointed it at a directory that is not there.
 *  - **More shards than the fan-out can carry.** `maxWidth` on the `fan` edge (and
 *    `policy.expansion.maxFanout` above it) CLAMPS silently: 30 shards with a width of 24 runs 24
 *    branches, and nothing in the run, the trace or the report says the other six were never read.
 *    A triage report missing a quarter of its evidence is worse than no report, so the count is
 *    checked HERE, where the number is still known and the refusal can name it.
 *  - **No fan-out to read the ceiling off.** Below.
 *
 * THE CEILING IS READ OFF THE GRAPH, NOT WRITTEN HERE. `ctx.node` is this node as its graph
 * declared it — `{id, type, reads, writes, out}`, frozen — and `out` reduces each outgoing edge
 * to `{id, kind, over?, as?, maxWidth?, maxIterations?}`. The `fanout` edge whose `over` names
 * the channel this body writes is the one that will spread it, and its `maxWidth` is the number
 * the executor actually clamps at. So the bound has ONE home, in `graphs/triage-failures.json`,
 * and raising it there is the whole edit.
 *
 * AND IF THAT EDGE IS NOT THERE, THIS REFUSES rather than running unbounded — the third refusal.
 * A body hand-registered through `FunctionRegistry.register` (rather than loaded from this file)
 * gets no `ctx.node` at all, and a graph could point some other node at this ref. Guessing a
 * ceiling there would be the silent clamp again, this time with the body's own blessing.
 */
function (view, ctx) {
  // `/\r?\n/`, not `"\n"`. A CI shard produced on Windows, or checked out under
  // `core.autocrlf=true`, ends every line with `\r\n`; splitting on `"\n"` alone leaves a `\r`
  // that `.trim()` here would hide and that `triage-classify.js`'s anchored regexes would NOT.
  const found = String(view.require("found"));
  const shards = found
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(no matches)" && !line.startsWith("…"));

  if (shards.length === 0) {
    return {
      refuse: {
        reason: "no test-output files matched — check the --input pattern, and that it is relative to the workspace root",
      },
    };
  }

  const node = ctx.node;
  const fan = node === undefined ? undefined : node.out.find((e) => e.kind === "fanout" && e.over === "shards");
  const ceiling = fan === undefined ? undefined : fan.maxWidth;
  if (typeof ceiling !== "number") {
    return {
      refuse: {
        reason:
          "this body plans a fan-out over \"shards\" and could not read its width: no fanout edge over \"shards\" " +
          "leaves this node (ctx.node is " + (node === undefined ? "absent — a hand-registered body gets none" : "\"" + node.id + "\"") +
          "). Running on would silently drop every shard past a width nobody stated.",
      },
    };
  }

  if (shards.length > ceiling) {
    return {
      refuse: {
        reason:
          "matched " + shards.length + " test-output files but this graph fans out at most " + ceiling +
          " — the rest would be dropped without a word. Narrow the pattern, or raise maxWidth on the \"fan\" edge " +
          "(and policy.expansion.maxFanout above it).",
      },
    };
  }
  return { writes: { shards: shards } };
}
