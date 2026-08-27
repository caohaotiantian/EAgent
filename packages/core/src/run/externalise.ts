/**
 * WHICH channels may leave the journal, decided from the compiled graph alone.
 *
 * WHY THIS IS A SET AND NOT A THRESHOLD. `foldRun` is pure and synchronous — that is the stated
 * reason `run/projection.ts` is kernel — so a handle in the projection can only become a value
 * where something ASYNC resolves it. The engine resolves exactly one place: a node's observed
 * channels, before its body runs. Every other reader of channel state is synchronous and would
 * see the handle:
 *
 *   - `#edgesToTake` evaluates `when` / `until` / a router's cases against the raw scope. A
 *     handle compares unequal to everything the author wrote, so the graph would route the
 *     wrong way and journal that as the run's decision. Silent, not loud.
 *   - `#activate` reads a fan-out's `over` channel to plan its width, and binds `as` per branch.
 *   - `collectOutputs` builds `run.completed.outputs`, which nothing resolves — the run's answer
 *     would be a handle.
 *   - a `subgraph` node hands `inputs` to a CHILD RUN, which has its own runId and therefore its
 *     own payload scope; the handle would name a cell the child cannot address.
 *
 * So the set is the complement of those, intersected with the one reducer that can hold a handle
 * safely. THE DIRECTION OF ERROR IS FIXED: every rule below REMOVES channels, an unparseable
 * expression removes ALL of them, and an engine with no payload store externalises nothing. The
 * failure mode of this file is "the journal is as big as it was", never "a node got a handle".
 *
 * `replace` IS THE ONLY REDUCER HERE, and the reason is mechanical rather than cautious.
 * `reduceState` calls `reduceChannel(name, spec, current[channel], contributions)` — the
 * channel's CURRENT value is the fold's seed. `append_ordered`, `merge_object`, `sum`, `max`,
 * `min` and `union_set` all read that seed, so a handle sitting there would have to be
 * materialised inside a synchronous reducer to reduce at all — and materialising it is exactly
 * what externalising was for. `replace`'s `step` is `return c.value`: the previous value is
 * discarded unread, so a handle in the seat costs nothing. `last_write_wins_by_ts` is excluded
 * with the others because its stored form is a `{value, ts}` envelope that `channelValue`
 * unwraps, and a handle would have to be one layer down.
 */

import { parseExpr, referencedChannels } from "../graph/expr.ts";
import type { RunGraph } from "../graph/spec.ts";

/**
 * The channels a run may externalise. Computed once per run — it is a pure function of the
 * compiled graph, so an attach in a fresh process derives the same set the original run used.
 */
export function externalisableChannels(graph: RunGraph): ReadonlySet<string> {
  const hit = CACHE.get(graph);
  if (hit !== undefined) return hit;
  const answer = derive(graph);
  CACHE.set(graph, answer);
  return answer;
}

/**
 * Keyed on the compiled graph OBJECT, which is what makes this safe to cache at all: a runtime
 * mutation swaps `ctx.graph` for a successor rather than editing it, so the new graph is a new
 * key and gets a new answer. Weak, so a finished run's entry goes when the graph does.
 */
const CACHE = new WeakMap<RunGraph, ReadonlySet<string>>();

function derive(graph: RunGraph): ReadonlySet<string> {
  const spec = graph.spec;
  const out = new Set<string>();
  for (const [name, ch] of Object.entries(spec.channels)) if (ch.reduce === "replace") out.add(name);

  for (const name of spec.outputs) out.delete(name);

  for (const node of spec.nodes) {
    for (const parent of Object.values(node.subgraph?.inputs ?? {})) out.delete(String(parent));
    for (const c of node.router?.cases ?? []) forget(out, c.when);
  }

  for (const e of spec.edges) {
    forget(out, e.when);
    forget(out, e.until);
    if (e.over !== undefined) out.delete(e.over);
    if (e.as !== undefined) out.delete(e.as);
  }

  return out;
}

/**
 * Drop every channel this expression can reach.
 *
 * A PARSE FAILURE DROPS EVERYTHING. The compiler already refuses a graph whose expressions do
 * not parse, so this arm is not reachable from a compiled graph — and "not reachable today" is
 * the sentence that turns into a silent hole when a later change hands this function a string
 * from somewhere else. Clearing the set makes the whole feature switch off rather than letting
 * one unreadable expression see a handle.
 */
function forget(out: Set<string>, expr: string | undefined): void {
  if (expr === undefined) return;
  try {
    for (const ref of referencedChannels(parseExpr(expr))) out.delete(ref);
  } catch {
    out.clear();
  }
}
