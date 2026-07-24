/**
 * The reasoning-flood coalescing adapter (design D4/KDD4, AC3).
 *
 * EAgent's reasoning-search fan-out is a high-rate multi-stream token flood, and
 * Ink has a render-throughput ceiling. This adapter folds the (attribution-tagged)
 * `SourceEvent` stream through the pure `reduce` and hands the model to a sink
 * **at most once per frame interval**: the first event of a frame arms a single
 * pending flush; every later event within that frame mutates the model in place
 * but does NOT arm another — so K deltas commit as one React state update, not K.
 * De-interleaving/ordering are the reducer's job; this only bounds commit rate.
 *
 * The scheduler is injected (default `setTimeout` at one frame) so the batching
 * is deterministically offline-testable without real timers. Framework-agnostic
 * (no `ink`/`react`); the `App` in `app.tsx` drives it into React state.
 */

import { applyControl, initialModel, reduce, type ControlAction, type DisplayMode, type ViewModel } from "../view-model.js";
import type { SourceEvent } from "./source.js";

/** ~60fps. A frame's worth of deltas coalesce into a single commit. */
export const FRAME_MS = 16;

export interface CoalesceOptions {
  mode?: DisplayMode;
  /** Arm a flush; returns an opaque handle. Default: `setTimeout(cb, FRAME_MS)`. */
  schedule?: (cb: () => void) => unknown;
  /** Cancel a pending flush handle. Default: `clearTimeout`. */
  cancel?: (handle: unknown) => void;
}

export class Coalescer {
  #model: ViewModel;
  readonly #sink: (model: ViewModel) => void;
  readonly #schedule: (cb: () => void) => unknown;
  readonly #cancel: (handle: unknown) => void;
  #handle: unknown | undefined;
  #dirty = false;

  constructor(sink: (model: ViewModel) => void, opts: CoalesceOptions = {}) {
    this.#sink = sink;
    this.#model = initialModel(opts.mode ?? "auto");
    this.#schedule = opts.schedule ?? ((cb): unknown => setTimeout(cb, FRAME_MS));
    this.#cancel = opts.cancel ?? ((h): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /** The current folded model (between commits). */
  get model(): ViewModel {
    return this.#model;
  }

  /**
   * Fold one event. Only reducer-foldable render events (those carrying an `at`
   * timestamp) mutate the model; connection/usage/elicitation meta events are the
   * app's concern, not the transcript's, and are ignored here. A render event arms
   * exactly one pending flush per frame — the coalescing budget.
   */
  push(event: SourceEvent): void {
    if (!isRenderEvent(event)) return;
    this.#model = reduce(this.#model, event);
    this.#dirty = true;
    if (this.#handle === undefined) {
      this.#handle = this.#schedule(() => this.#flush());
    }
  }

  /**
   * Apply a display control (`/details`/`/expand`/`/collapse`) through the shared
   * pure `applyControl` and commit immediately — a user control is a single
   * deliberate action, not a flood, so it is not coalesced.
   */
  applyControl(action: ControlAction): void {
    this.#model = applyControl(this.#model, action);
    this.#dirty = true;
    this.flush();
  }

  #flush(): void {
    this.#handle = undefined;
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#sink(this.#model);
  }

  /** Force any pending model out now and cancel the armed flush (e.g. on unmount). */
  flush(): void {
    if (this.#handle !== undefined) {
      this.#cancel(this.#handle);
      this.#handle = undefined;
    }
    if (this.#dirty) {
      this.#dirty = false;
      this.#sink(this.#model);
    }
  }
}

/** A render event (folded into the transcript) carries the attribution `at` tag;
 *  the meta events (`connected`/`usage`/`action_required`/…) do not. */
function isRenderEvent(event: SourceEvent): event is Extract<SourceEvent, { at: number }> {
  return "at" in event;
}
