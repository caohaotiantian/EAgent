/**
 * `function/plan@stable` — the fan-out's source.
 *
 * THE FILE IS A BARE FUNCTION EXPRESSION. There is no `module.exports`, no `export default`
 * and no wrapper: the loader evaluates `(<this file>)` and keeps the completion value, so a
 * `module.exports =` line is a syntax error before your code ever runs.
 *
 * Signature: `(view, ctx) => { writes?, take?, retry? }`.
 *   view.require(c)  the value of channel `c`, throwing if the node did not declare it
 *   view.get(c)      the same, `undefined` instead of throwing
 *   view.visible     the channels this node declared it reads
 *   ctx.taskId       this task's id
 *   ctx.now()        the task's journaled lease timestamp — NOT the wall clock, and it does
 *                    not advance during the task, which is what makes replay total
 *   ctx.signal       `{aborted}`
 *
 * What is NOT here: `Date`, `Intl`, `fetch`, `require`, `process`. A body that could read a
 * second clock is a body no replay reproduces. `Math.random()` works and is seeded from a
 * journaled draw, so the stream is the same on replay.
 */
function (view) {
  var lines = view.require("document").split("\n");
  var chunks = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line !== "") chunks.push(line);
  }
  // Whatever lands in `chunks` is what the `fanout` edge spreads: one branch per element,
  // each one seeing its element on the `chunk` channel the edge names with `as`.
  return { writes: { chunks: chunks } };
}
