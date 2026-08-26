/**
 * `function/count@stable` — one fan-out branch.
 *
 * Runs once per element of `chunks`, in parallel, each instance reading its own element from
 * the `chunk` channel. It writes a ONE-ELEMENT array into `counts`, whose reducer is
 * `append_ordered`: concurrent writers are folded in branch order, not arrival order, so the
 * result does not depend on which branch finished first.
 */
function (view) {
  var line = view.require("chunk");
  var words = line.split(/\s+/).filter(function (w) {
    return w !== "";
  });
  return { writes: { counts: [{ line: line, words: words.length }] } };
}
