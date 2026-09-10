/**
 * `function/plan@stable` — the fan-out's source.
 *
 * THE FILE IS A BARE FUNCTION EXPRESSION. There is no `module.exports`, no `export default`
 * and no wrapper: the loader evaluates `(<this file>)` and keeps the completion value, so a
 * `module.exports =` line is a syntax error before your code ever runs.
 *
 * Signature: `(view, ctx) => { writes?, take? }` — or, INSTEAD of those, one verdict:
 * `{ retry: {reason} }` or `{ refuse: {reason} }`. `writes` and `take` go together; a verdict
 * beside either, or beside the other verdict, is refused as `E_RESOURCE_INVALID`.
 *   view.require(c)  the value of channel `c`, throwing if the node did not declare it
 *   view.get(c)      the same, `undefined` instead of throwing
 *   view.visible     the channels this node declared it reads
 *   ctx.taskId       this task's id
 *   ctx.now()        the task's journaled lease timestamp — NOT the wall clock, and it does
 *                    not advance during the task, which is what makes replay total
 *   ctx.signal       `{aborted}`
 *   ctx.node         this node as its GRAPH declared it — `{id, type, reads, writes, out}`,
 *                    frozen, where `out` is each outgoing edge as
 *                    `{id, kind, over?, as?, maxWidth?, maxIterations?}`. Read a bound the graph
 *                    already states instead of writing it twice; see `triage-plan.js`
 *
 * THE TWO WAYS TO FAIL ON PURPOSE, and they are returns rather than throws. `{retry: {reason}}`
 * is `unavailable`/`E_FUNCTION_UNAVAILABLE` and the node's `retry` policy may grant it another
 * attempt; `{refuse: {reason}}` is `validation`/`E_FUNCTION_REFUSED` and is never retried,
 * because a second attempt on the same inputs would refuse identically. A `throw` is neither: it
 * normalizes to `internal`/`E_INTERNAL`, the code a genuine BUG in the body produces.
 *
 * What is NOT here: `Intl`, `fetch`, `require`, `process`. A body that could read a second clock
 * is a body no replay reproduces — which is why `Intl` is absent even though `Date` is not:
 * `new Intl.DateTimeFormat(…).format()` with no argument reads the WALL clock.
 *
 * `Date` IS here and is BOUND TO `ctx.now()`: `new Date()`, `Date()` and `Date.now()` all answer
 * the task's journaled lease timestamp, while `new Date(0)`, `Date.parse` and `Date.UTC` are the
 * real ones, because none of those reads a clock. `Math.random()` works too and is seeded from a
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
