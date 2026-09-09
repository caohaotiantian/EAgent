/**
 * `function/triage-plan@stable` — turn what `fs.glob` found into the fan-out's source.
 *
 * A tool node that declares no channel of the tool's own naming gets the tool's `content` on
 * its first declared write channel, so `found` here is `fs.glob`'s human-readable answer: one
 * root-relative path per line, or the literal `(no matches)`.
 *
 * THROWING IS THE POINT of the empty case. A fan-out over an empty array produces no branches
 * and the join folds nothing, so the run would succeed with an empty report — telling you the
 * suite is clean when in fact you pointed the graph at a directory that is not there. Failing
 * here names the pattern back to you instead.
 */
function (view) {
  const found = String(view.require("found"));
  const shards = found
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "(no matches)" && !line.startsWith("…"));

  if (shards.length === 0) {
    throw new Error("no test-output files matched — check the --input pattern, and that it is relative to the workspace root");
  }
  return { writes: { shards: shards } };
}
