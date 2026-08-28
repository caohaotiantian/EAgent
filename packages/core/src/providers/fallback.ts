/**
 * Declarative fallback chains, and cassette record/replay.
 *
 * A fallback chain is only expressible because every adapter maps its native failures
 * onto ONE normalized taxonomy. `when: [E_PROVIDER_RATE_LIMIT]` is a config line
 * rather than provider-specific code, which is the payoff for `normalizeError`.
 *
 * THE RULE THAT MATTERS: a `policy`-class refusal never falls through. Trying a second
 * vendor after a content filter declined is evasion, not resilience — so
 * `E_CONTENT_FILTERED` is refused here even if a chain names it, and the refusal is
 * checked at construction rather than at call time.
 *
 */

import { CODES, err, isLoomError, type LoomError } from "../errors.ts";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../run/registry.ts";

export interface FallbackTier {
  readonly adapter: ModelAdapter;
  readonly model: string;
  /** Normalized codes that make the PREVIOUS tier fall through to this one. */
  readonly when?: readonly string[];
  /** Marks a deliberately weaker tier, so cost/quality dashboards can separate it. */
  readonly degrade?: boolean;
}

export interface FallbackOptions {
  readonly provider?: string;
  readonly primary: FallbackTier;
  readonly fallback?: readonly FallbackTier[];
  /** Called for each fall-through, for telemetry and escalation rule E11. */
  readonly onFallback?: (from: string, to: string, error: LoomError) => void;
}

/**
 * Codes that must NEVER trigger a fallback, whatever a chain declares.
 *
 * - `E_CONTENT_FILTERED`: retrying elsewhere is evasion.
 * - `E_PROVIDER_BAD_REQUEST`: the request is malformed; every provider will refuse it.
 * - `E_CANCELLED`: the caller asked to stop.
 */
const NEVER_FALL_THROUGH: ReadonlySet<string> = new Set([
  CODES.E_CONTENT_FILTERED,
  CODES.E_PROVIDER_BAD_REQUEST,
  CODES.E_CANCELLED,
]);

export class FallbackAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #tiers: readonly FallbackTier[];
  readonly #onFallback: FallbackOptions["onFallback"];

  constructor(opts: FallbackOptions) {
    this.provider = opts.provider ?? `fallback(${opts.primary.adapter.provider})`;
    this.#tiers = [opts.primary, ...(opts.fallback ?? [])];
    this.#onFallback = opts.onFallback;

    // Checked at construction, not at call time: a chain that would evade a safety
    // refusal should fail to build, not fail once in production at 3am.
    for (const tier of this.#tiers) {
      for (const code of tier.when ?? []) {
        if (NEVER_FALL_THROUGH.has(code)) {
          throw err.policy(
            CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN,
            `a fallback chain may not trigger on "${code}" — falling through would be evasion, not resilience`,
            { details: { code } },
          );
        }
      }
    }
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    let last: LoomError | undefined;

    for (let i = 0; i < this.#tiers.length; i++) {
      const tier = this.#tiers[i]!;
      if (i > 0 && !this.#shouldTry(tier, last)) continue;

      let committed = false;
      try {
        for await (const ev of tier.adapter.stream({ ...req, model: tier.model }, signal)) {
          // Once the first event is out, this tier owns the turn. Falling through now
          // would replay deltas the caller has already seen and double-count usage.
          committed = true;
          yield ev;
        }
        return;
      } catch (e) {
        const le = isLoomError(e) ? e : err.unavailable(CODES.E_PROVIDER_TRANSPORT, String(e));
        if (committed) throw le;
        if (NEVER_FALL_THROUGH.has(le.code)) throw le;
        last = le;
        const next = this.#tiers[i + 1];
        if (next !== undefined) this.#onFallback?.(tier.model, next.model, le);
      }
    }

    throw last ?? err.unavailable(CODES.E_PROVIDER_TRANSPORT, "no fallback tier accepted the request");
  }

  #shouldTry(tier: FallbackTier, last: LoomError | undefined): boolean {
    if (last === undefined) return false;
    // No `when` means "take anything the previous tier could not handle".
    if (tier.when === undefined) return true;
    return tier.when.includes(last.code);
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    const tier = this.#tiers.find((t) => t.model === model) ?? this.#tiers[0]!;
    return tier.adapter.priceOf(model, usage);
  }

  estimateOf(req: ModelRequest): number {
    // The PRIMARY tier's estimate, not the worst tier's: reserving the most expensive
    // possible path would starve the budget for runs that never fall through.
    const primary = this.#tiers[0]!;
    return primary.adapter.estimateOf({ ...req, model: primary.model });
  }

  /**
   * The MAXIMUM ceiling over every tier, and deliberately not the primary's.
   *
   * This is the one place it diverges from `estimateOf` above, and the asymmetry is the point.
   * A chain does not know which tier will answer until an earlier one has failed, so both
   * numbers are guesses — but they are guesses about different things and the wrong direction
   * costs differently. `estimateOf` feeds a DOLLAR reservation, where over-reserving the
   * priciest tier would starve every run that never falls through. `outputCeilingOf` feeds a
   * TOKEN reservation whose whole job is to be a bound: under-reserving lets a turn through
   * that the budget could not afford, which is a broken guard, while over-reserving refuses
   * work that would have fit, which is a visible and arguable refusal. Only the first is a
   * defect, so this rounds up.
   */
  outputCeilingOf(req: ModelRequest): number {
    let most = 0;
    for (const tier of this.#tiers) most = Math.max(most, tier.adapter.outputCeilingOf({ ...req, model: tier.model }));
    return most;
  }
}

// ---------------------------------------------------------------------------
// Cassettes
// ---------------------------------------------------------------------------

export interface Cassette {
  /** Keyed by a digest of the request, so a replay is order-independent. */
  readonly entries: Record<string, ModelEvent[]>;
}

/**
 * Wrap a live adapter and record every exchange.
 *
 * Distinct from `ReplayEffects`: that replays a *run* from its journal; a cassette
 * captures a *provider* so an adapter's own parsing can be tested offline against
 * real bytes. Both exist because they answer different questions — "did the run
 * behave the same?" versus "did we parse this provider correctly?".
 */
export class RecordingAdapter implements ModelAdapter {
  readonly provider: string;
  readonly cassette: Cassette = { entries: {} };
  readonly #inner: ModelAdapter;

  constructor(inner: ModelAdapter) {
    this.#inner = inner;
    this.provider = inner.provider;
  }

  async *stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const key = requestKey(req);
    const recorded: ModelEvent[] = [];
    for await (const ev of this.#inner.stream(req, signal)) {
      recorded.push(ev);
      yield ev;
    }
    this.cassette.entries[key] = recorded;
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    return this.#inner.priceOf(model, usage);
  }
  estimateOf(req: ModelRequest): number {
    return this.#inner.estimateOf(req);
  }
  outputCeilingOf(req: ModelRequest): number {
    return this.#inner.outputCeilingOf(req);
  }
}

export class ReplayingAdapter implements ModelAdapter {
  readonly provider: string;
  readonly #cassette: Cassette;
  readonly #priceOf: ModelAdapter["priceOf"];

  constructor(cassette: Cassette, opts: { provider?: string; priceOf?: ModelAdapter["priceOf"] } = {}) {
    this.#cassette = cassette;
    this.provider = opts.provider ?? "cassette";
    this.#priceOf = opts.priceOf ?? (() => 0);
  }

  async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
    const key = requestKey(req);
    const events = this.#cassette.entries[key];
    if (events === undefined) {
      throw err.internal(CODES.E_REPLAY_DIVERGENCE, `no cassette entry for this request`, {
        details: { key, known: Object.keys(this.#cassette.entries).length },
      });
    }
    // THE TAPE'S OWN ANSWER WINS. A cassette recorded through `RecordingAdapter` carries the
    // leaf that actually served, and re-attributing it to this adapter would erase the one fact
    // the recording was made to preserve. A tape cut before `provider` existed on the frame has
    // no answer, and then this adapter says so as itself rather than inventing a leaf.
    for (const ev of events) yield ev.type === "done" && ev.provider === undefined ? { ...ev, provider: this.provider } : ev;
  }

  priceOf(model: string, usage: { inputTokens: number; outputTokens: number }): number {
    return this.#priceOf(model, usage);
  }
  estimateOf(): number {
    return 0;
  }
  /**
   * A cassette bills nothing, but the reservation still needs a POSITIVE number: the engine
   * refuses a turn whose adapter reports a non-positive ceiling, because zero is what a missing
   * answer looks like. One token is the smallest honest bound for a turn served from a tape.
   */
  outputCeilingOf(req: ModelRequest): number {
    return req.maxTokens ?? 1;
  }
}

/** Content-addressed request identity. Excludes nothing — a changed prompt is a miss. */
export function requestKey(req: ModelRequest): string {
  return JSON.stringify({
    model: req.model,
    system: req.system,
    messages: req.messages,
    tools: req.tools.map((t) => t.name),
  });
}
