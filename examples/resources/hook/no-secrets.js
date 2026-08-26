/**
 * `hook/no-secrets@stable` — a `preTool` filter.
 *
 * THE FILE IS A BARE FUNCTION EXPRESSION, exactly like a `function` resource. Writing
 * `module.exports = function (input, ctx) {…}` here fails at compile with
 * `Unexpected token ';'`, because the loader evaluates `(<this file>)` as one expression.
 *
 * Signature: `(input, ctx) => decision`. What `input` and the decision are depends on the
 * point the graph names this hook at; at `preTool` it is `{tool, args}` and the decision is
 * `{block?, reason?, args?}` — return `{}` to change nothing.
 *
 *   ctx.point   the point that fired: preNode, preModel, postModel, preTool, postTool,
 *               onError, onGate, onComplete
 *   ctx.runId   the run
 *   ctx.taskId  the task, `nodeId@branch#iteration` — absent at the run-scoped point
 *               (onComplete), which has no Task
 *   ctx.signal  `{aborted}`
 *
 * A FILTER MAY ONLY NARROW. Block a call, rewrite its arguments, add an excluded approver —
 * but a hook cannot grant a capability, lower a posture or add an approver, and the fields
 * that would let it are not on the object it is handed. A filter that throws fails its task;
 * an observer that throws is skipped.
 *
 * `Math.random()` throws here on purpose — a hook has no journaled seed, so a draw would make
 * the run unreplayable. `Date` and `Intl` are absent for the same reason. Do the draw in a
 * `function` node, where the engine has already seeded it.
 */
function (input, ctx) {
  if (ctx.point !== "preTool" || input.tool !== "fs.write") return {};
  var body = String(input.args.body);
  if (body.indexOf("sk-") === -1 && body.indexOf("BEGIN PRIVATE KEY") === -1) return {};
  return {
    block: true,
    reason: "the body looks like it carries a credential, so it is not going to disk",
  };
}
