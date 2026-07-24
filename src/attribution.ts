/**
 * Attribution + framing adapter.
 *
 * Subscribes to the agent's intra-run lifecycle events and tags each with the
 * emitting agent's identity — `currentActingAgent()` (the leaf: a fork or
 * subagent) and `currentRootAgent()` (the run-tree root) — plus a host-supplied
 * monotonic timestamp, then folds it through the pure reducer and hands the new
 * model to a sink. Fork/subagent streams separate by agent object identity
 * (keyed in a `WeakMap`), which is the mechanism that de-interleaves the
 * reasoning-search flood. Never constructs a JSONL `type:"<event>"` literal —
 * the machine stream stays the sole province of `src/jsonl.ts`.
 */

import type { Agent } from "./kernel/agent.js";
import { currentActingAgent, currentRootAgent } from "./kernel/agent.js";
import type { Disposable } from "./kernel/types.js";
import { initialModel, reduce, type DisplayMode, type RenderEvent, type TaggedEvent, type ViewModel } from "./view-model.js";

export interface WireOptions {
  now?: () => number;
  mode?: DisplayMode;
}

/**
 * Tag `agent.hooks` lifecycle events with their emitting agent's identity and a
 * monotonic timestamp, handing each `TaggedEvent` to `sink` in arrival order.
 * This is the in-process half of attribution (KDD5): the acting/root ids come
 * from the ALS (`currentActingAgent()`/`currentRootAgent()`), so a fork's deltas
 * — firing the same shared handlers inside the fork's ALS context — carry the
 * fork's id and de-interleave downstream. Returns the subscriptions so the caller
 * can dispose them on reload/teardown. Consumed by `wireViewModel` (engine plain
 * renderer) and by `InProcessSource` (the TUI), so the tagging is written once.
 */
export function wireEvents(
  agent: Agent,
  sink: (event: TaggedEvent) => void,
  opts: { now?: () => number } = {},
): Disposable[] {
  const now = opts.now ?? ((): number => performance.now());
  const ids = new WeakMap<Agent, string>();
  let counter = 0;
  const idOf = (a: Agent | undefined): string => {
    if (!a) return "root";
    let id = ids.get(a);
    if (id === undefined) {
      id = "a" + counter++;
      ids.set(a, id);
    }
    return id;
  };

  const dispatch = (ev: RenderEvent): void => {
    const acting = currentActingAgent();
    const root = currentRootAgent();
    const rootId = idOf(root ?? acting);
    const actingId = acting ? idOf(acting) : rootId;
    sink({ ...ev, actingId, rootId, at: now() });
  };

  return [
    agent.hooks.on("agent_start", () => dispatch({ kind: "agent_start" })),
    agent.hooks.on("reasoning_delta", ({ text }) => dispatch({ kind: "reasoning_delta", text })),
    agent.hooks.on("text_delta", ({ text }) => dispatch({ kind: "text_delta", text })),
    agent.hooks.on("tool_start", ({ call }) => dispatch({ kind: "tool_start", call })),
    agent.hooks.on("tool_end", ({ call, result }) => dispatch({ kind: "tool_end", call, result })),
    agent.hooks.on("message", ({ message, stopReason }) => dispatch({ kind: "message", role: message.role, stopReason })),
    agent.hooks.on("agent_end", ({ reason }) => dispatch({ kind: "agent_end", reason })),
  ];
}

/**
 * Wire the reducer to `agent.hooks`: fold each `TaggedEvent` (via `wireEvents`)
 * into the pure view model and hand the new model to `sink`. Returns the
 * subscriptions so the caller can dispose them on reload/teardown.
 */
export function wireViewModel(
  agent: Agent,
  sink: (model: ViewModel) => void,
  opts: WireOptions = {},
): Disposable[] {
  let model = initialModel(opts.mode ?? "auto");
  return wireEvents(
    agent,
    (event) => {
      model = reduce(model, event);
      sink(model);
    },
    { now: opts.now },
  );
}
