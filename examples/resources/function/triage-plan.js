/**
 * `function/triage-plan@stable` — turn what `fs.glob` found into the fan-out's source.
 *
 * A tool node that declares no channel of the tool's own naming gets the tool's `content` on
 * its first declared write channel, so `found` here is `fs.glob`'s human-readable answer: one
 * root-relative path per line, or the literal `(no matches)`.
 *
 * THIS BODY REFUSES TWICE, and both refusals exist because the alternative is a report that
 * lies about a green suite.
 *
 *  - **Nothing matched.** A fan-out over an empty array produces no branches and the join folds
 *    nothing, so the run would SUCCEED with a report saying zero failures — which reads as "your
 *    suite is clean" when what happened is that you pointed it at a directory that is not there.
 *  - **More shards than the fan-out can carry.** `maxWidth` on the `fan` edge (and
 *    `policy.expansion.maxFanout` above it) CLAMPS silently: 30 shards with a width of 24 runs 24
 *    branches, and nothing in the run, the trace or the report says the other six were never read.
 *    A triage report missing a quarter of its evidence is worse than no report, so the count is
 *    checked HERE, where the number is still known and the refusal can name it.
 *
 * `SHARD_CEILING` MUST TRACK `edges[fan].maxWidth` IN THE GRAPH. It is duplicated rather than
 * derived because a `function` body is handed channel values and nothing about the graph that
 * called it — there is no `ctx.node`, no `ctx.graph`. `packages/core/test/examples-triage.test.ts`
 * pins the two together by reading `maxWidth` out of the graph and driving one shard past it.
 */
function (view) {
  const SHARD_CEILING = 24;

  // `/\r?\n/`, not `"\n"`. A CI shard produced on Windows, or checked out under
  // `core.autocrlf=true`, ends every line with `\r\n`; splitting on `"\n"` alone leaves a `\r`
  // that `.trim()` here would hide and that `triage-classify.js`'s anchored regexes would NOT.
  const found = String(view.require("found"));
  const shards = found
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(no matches)" && !line.startsWith("…"));

  if (shards.length === 0) {
    throw new Error("no test-output files matched — check the --input pattern, and that it is relative to the workspace root");
  }
  if (shards.length > SHARD_CEILING) {
    throw new Error(
      "matched " + shards.length + " test-output files but this graph fans out at most " + SHARD_CEILING +
        " — the rest would be dropped without a word. Narrow the pattern, or raise maxWidth on the \"fan\" edge " +
        "(and policy.expansion.maxFanout above it) and SHARD_CEILING in triage-plan.js together.",
    );
  }
  return { writes: { shards: shards } };
}
