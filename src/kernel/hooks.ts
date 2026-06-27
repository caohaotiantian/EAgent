/**
 * The nervous system of the kernel: an event bus (Emacs *hooks*) plus filter
 * hooks (Emacs *advice*).
 *
 * Two complementary mechanisms:
 *
 *   - **Notifications** (`on`/`emit`) — fire-and-forget lifecycle signals.
 *     Handlers run in registration order; one throwing does not abort the rest.
 *
 *   - **Filters** (`filter`/`apply`) — a value is threaded through each
 *     handler, which may transform it or short-circuit. This is how
 *     `beforeToolCall` can veto a call and `transformContext` can rewrite the
 *     prompt. Filter/transform advice (no continuation / cannot call the
 *     original).
 *
 * Everything is typed against a map interface so extensions get autocomplete
 * and the compiler catches payload mistakes.
 */

import type { Disposable } from "./types.js";

export type EventHandler<P> = (payload: P) => void | Promise<void>;
export type FilterHandler<V, C> = (value: V, context: C) => V | Promise<V>;

interface Registration {
  fn: (...args: any[]) => unknown;
}

/**
 * Run-lifecycle events a child scope must NOT re-fire to the parent's observers:
 * re-firing them resets per-run guard state (e.g. `circuit-breaker`/`limits`
 * reset on `agent_start`). Every other event is intra-run and IS shared, so the
 * parent's event-fed guard state (`flow-guard` taint, `write-guard` seen-set,
 * cost/budget counters) accumulates from a child's activity. (KDD-1/KDD-2.)
 */
const SUPPRESSED_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set([
  "agent_start",
  "agent_end",
  "session_start",
  "session_shutdown",
  "reload",
]);

/**
 * The only filter points a child scope shares with its parent: the gate guards.
 * Context-shaping filters (`transformContext`/`transformRequest`) are absent by
 * design so the child keeps a fresh, isolated context window. (KDD-1/KDD-2.)
 */
const SHARED_FILTER_POINTS: ReadonlySet<string> = new Set([
  "beforeToolCall",
  "afterToolCall",
]);

/**
 * @typeParam Events  map of event name -> payload type (notifications)
 * @typeParam Filters map of hook name -> `{ value; context }` (filters)
 */
export class HookBus<
  Events extends Record<string, unknown>,
  Filters extends Record<string, { value: unknown; context: unknown }>,
> {
  readonly #events = new Map<keyof Events, Set<Registration>>();
  readonly #filters = new Map<keyof Filters, Registration[]>();

  /**
   * @param seed  optional pre-population for a derived bus (see `childScope`).
   *   The provided `Set`/`Registration[]` references are shared, not deep-copied,
   *   so the derived bus fires the parent's existing handlers. Children never
   *   register their own (§5), so the shared structures stay read-only in use.
   */
  constructor(seed?: {
    events?: Map<keyof Events, Set<Registration>>;
    filters?: Map<keyof Filters, Registration[]>;
  }) {
    if (seed?.events) for (const [name, set] of seed.events) this.#events.set(name, set);
    if (seed?.filters) for (const [point, list] of seed.filters) this.#filters.set(point, list);
  }

  /** Subscribe to a lifecycle event. */
  on<K extends keyof Events>(event: K, handler: EventHandler<Events[K]>): Disposable {
    let set = this.#events.get(event);
    if (!set) this.#events.set(event, (set = new Set()));
    const reg: Registration = { fn: handler };
    set.add(reg);
    return { dispose: () => set!.delete(reg) };
  }

  /** Emit a lifecycle event, awaiting handlers in registration order. */
  async emit<K extends keyof Events>(event: K, payload: Events[K]): Promise<void> {
    const set = this.#events.get(event);
    if (!set) return;
    for (const reg of [...set]) {
      try {
        await reg.fn(payload);
      } catch (err) {
        // An observer must never break the loop. Surface and continue.
        reportHandlerError(String(event), err);
      }
    }
  }

  /**
   * Register a filter for a hook point. Filters run in registration order and
   * each receives the previous filter's output. Returning a special sentinel
   * is unnecessary — to short-circuit, a filter simply returns a value the
   * caller recognizes as terminal (e.g. a decision object with `block: true`).
   */
  filter<K extends keyof Filters>(
    point: K,
    handler: FilterHandler<Filters[K]["value"], Filters[K]["context"]>,
  ): Disposable {
    let list = this.#filters.get(point);
    if (!list) this.#filters.set(point, (list = []));
    const reg: Registration = { fn: handler };
    list.push(reg);
    return {
      dispose: () => {
        const i = list!.indexOf(reg);
        if (i >= 0) list!.splice(i, 1);
      },
    };
  }

  /**
   * Thread `value` through every filter registered for `point`.
   *
   * `shouldStop` lets the caller halt the chain early when a filter produces a
   * terminal value (e.g. a veto), so later filters don't override a decision
   * that has already been made. Filter errors are fatal to the chain by
   * design: a `beforeToolCall` guard that throws must not be silently ignored.
   */
  async apply<K extends keyof Filters>(
    point: K,
    value: Filters[K]["value"],
    context: Filters[K]["context"],
    shouldStop?: (value: Filters[K]["value"]) => boolean,
  ): Promise<Filters[K]["value"]> {
    const list = this.#filters.get(point);
    if (!list) return value;
    let acc = value;
    for (const reg of [...list]) {
      acc = (await reg.fn(acc, context)) as Filters[K]["value"];
      if (shouldStop?.(acc)) break;
    }
    return acc;
  }

  /** Number of listeners — useful in tests and introspection. */
  listenerCount(name: keyof Events | keyof Filters): number {
    return (
      (this.#events.get(name as keyof Events)?.size ?? 0) +
      (this.#filters.get(name as keyof Filters)?.length ?? 0)
    );
  }

  /**
   * Derive a child bus for a sub-agent. The child shares — by reference — the
   * parent's gate filters (`beforeToolCall`/`afterToolCall`) and its intra-run
   * event handlers, so the parent's guards and event-fed state govern the child.
   * It does NOT carry the context-shaping filters (the child keeps a fresh,
   * isolated context) or the run-lifecycle events (a child must not reset the
   * parent's per-run guard state). Suppression is by absence: a point left out of
   * the seed is a no-op under this bus's own semantics — `emit` returns on a
   * missing event set and `apply` passes the value through on a missing filter
   * list. (KDD-1/KDD-2.)
   */
  childScope(): HookBus<Events, Filters> {
    const events = new Map<keyof Events, Set<Registration>>();
    for (const [name, set] of this.#events) {
      if (!SUPPRESSED_LIFECYCLE_EVENTS.has(name as string)) events.set(name, set);
    }
    const filters = new Map<keyof Filters, Registration[]>();
    for (const [point, list] of this.#filters) {
      if (SHARED_FILTER_POINTS.has(point as string)) filters.set(point, list);
    }
    return new HookBus<Events, Filters>({ events, filters });
  }
}

let errorReporter: (event: string, err: unknown) => void = (event, err) => {
  console.error(`[eagent] event handler for "${event}" threw:`, err);
};

/** Tests/hosts can redirect where observer errors go. */
export function setHandlerErrorReporter(fn: (event: string, err: unknown) => void): void {
  errorReporter = fn;
}

function reportHandlerError(event: string, err: unknown): void {
  errorReporter(event, err);
}
