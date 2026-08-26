/**
 * `function/summarise@stable` — what the join hands on.
 *
 * By the time this runs the `gather` join has folded every branch's contribution into
 * `counts`, so this is an ordinary fold over an array. The ORDER of that array is branch
 * order — the order the fan-out laid the branches out in, not the order they finished — which
 * is why `report.order` is the same on every run and on every replay.
 *
 * `ctx.now()` is the task's journaled lease timestamp: a replay of this run computes the same
 * number, with nothing new written. It does not advance during the task.
 *
 * `ctx.effects` — declaring `effects: ["fs.write"]` on the node would put a stub for it here,
 * but a body loaded from `resources/function/` CANNOT invoke one: it runs synchronously inside
 * a `vm` and cannot await a host round trip. The stub says so when you call it, with
 * `E_EFFECT_UNAVAILABLE`. Put the call on a `tool` node instead — or register the body
 * in-process with `FunctionRegistry.register`, which is the path that does get a live
 * `ctx.effects`.
 */
function (view, ctx) {
  var counts = view.require("counts");
  var words = 0;
  var order = [];
  for (var i = 0; i < counts.length; i++) {
    words += counts[i].words;
    order.push(counts[i].line);
  }
  return { writes: { report: { lines: counts.length, words: words, order: order, at: ctx.now() } } };
}
