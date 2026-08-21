/**
 * Cost: token→USD accounting + rolling-mean run-cost anomaly flag.
 *
 * `trace` can already *count* tokens; this extension *prices* them. It is a pure
 * event-bus consumer — a sibling of `trace` in the exact same shape — that maps
 * the tokens the provider reports into USD via a static, date-pinned price card,
 * accumulates per-run and cumulative-session cost split by model, learns a
 * rolling baseline of recent run costs, and emits a warn-only anomaly flag when
 * a finished run is a gross statistical outlier. It is observability only: it
 * never blocks (that is `limits`' job) and needs no kernel change — it reads the
 * existing `usage` payload and `e.agent.model`.
 *
 * The price card is a constant so there is zero network dependency (house rule:
 * providers-only `fetch`). Staleness is mitigated three ways: a pinned date
 * comment, an operator override of the `priceCard` store key (settable live via
 * `/cost pricecard …`), and a clearly-marked fallback rate for unknown models so
 * `mock`/unfamiliar endpoints never report a confidently-wrong dollar figure.
 */

import { currentActingAgent, currentRootAgent, type Agent } from "../kernel/agent.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import { addUsage, totalTokens, type StopReason, type Usage } from "../kernel/types.ts";

export type { Usage };

/**
 * The store key under which `cost` publishes a `costOf(agent): number` accessor
 * (the session's cumulative USD, keyed on the session root). A host front end
 * (e.g. the HTTP server's `GET /sessions/:id`) resolves it from `cost`'s
 * namespaced store and calls it with a session's Agent — the cross-boundary read
 * channel, so no new host API or kernel method is needed.
 */
export const COST_ACCESSOR_KEY = "costOf";

/** A per-model USD rate, expressed per million tokens (the conventional unit). */
export interface PriceRow {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** A price row resolved for a model, marked when it came from the fallback. */
export interface ResolvedRow extends PriceRow {
  /** True when this row is the documented fallback, not a pinned/overridden row. */
  fallback: boolean;
}

/** A card maps a model id (or a family prefix key) to its price row. */
export type PriceCard = Record<string, PriceRow>;

/**
 * Static, date-pinned price card. Rates are USD per million tokens.
 *
 * // rates as of 2026-06-22
 *
 * Rows are pinned for the model ids `host.ts` can default to (`claude-fable-5`,
 * `gpt-4o`, `gemini-2.0-flash`) plus the Anthropic families that may arrive via
 * `ANTHROPIC_MODEL` (`claude-opus-*`, `claude-sonnet-*`, prefix-matched). Each row
 * carries only an input and output rate; cache reads/writes are priced off the
 * input rate via fixed multipliers (`costOf`), and reasoning is a subset of output
 * already priced — so no extra rate columns are needed. `mock` and any unknown id
 * resolve to `FALLBACK_ROW`, clearly marked so `/cost` can label it.
 */
export const DEFAULT_PRICE_CARD: PriceCard = {
  "claude-fable-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

/** Family-prefix rows: matched when a model id starts with the key. */
const FAMILY_PREFIXES: Array<[string, PriceRow]> = [
  ["claude-opus-", { inputPerMTok: 15, outputPerMTok: 75 }],
  ["claude-sonnet-", { inputPerMTok: 3, outputPerMTok: 15 }],
];

/**
 * The documented fallback rate for `mock` and any unknown model. $0 so an
 * unfamiliar endpoint reports a clearly-marked "(fallback rate)" $0.00 figure
 * rather than a confident wrong number (the figure is advisory, never billing).
 */
export const FALLBACK_ROW: PriceRow = { inputPerMTok: 0, outputPerMTok: 0 };

/** True only when `n` is a finite number ≥ 0 (a valid rate). */
function validRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** A row passes validation only when both rates are finite and non-negative. */
function validRow(row: unknown): row is PriceRow {
  return (
    typeof row === "object" &&
    row !== null &&
    validRate((row as PriceRow).inputPerMTok) &&
    validRate((row as PriceRow).outputPerMTok)
  );
}

/**
 * Resolve a model id to its price row: an exact card hit first, then a known
 * family prefix, then the marked fallback. Each candidate is shape-validated
 * (numeric rates), so a malformed override row falls through to the fallback
 * rather than producing a NaN bill. Never returns undefined, never throws.
 */
export function priceRow(model: string, card: PriceCard = DEFAULT_PRICE_CARD): ResolvedRow {
  const exact = card[model];
  if (validRow(exact)) return { ...exact, fallback: false };
  for (const [prefix, row] of FAMILY_PREFIXES) {
    if (model.startsWith(prefix)) return { ...row, fallback: false };
  }
  return { ...FALLBACK_ROW, fallback: true };
}

/**
 * Cache-read tokens bill at ~0.1x the fresh-input rate, cache-write (cache
 * creation) at ~1.25x. These are the documented Anthropic-standard
 * approximations: `cost` is an estimator, so a single multiplier off the existing
 * input rate captures the dominant effect without a separate per-model rate column.
 */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Price a usage delta into USD. Fresh input and output are billed at the row's
 * rates; cache-read/cache-write tokens (disjoint from input) are billed off the
 * input rate via the reduced/premium multipliers above. `reasoningTokens` is a
 * subset of `outputTokens` (already priced), so it is not added. Pure, no side
 * effects; absent optional fields contribute 0.
 */
export function costOf(usage: Usage, row: PriceRow): number {
  return (
    (usage.inputTokens / 1e6) * row.inputPerMTok +
    ((usage.cacheReadTokens ?? 0) / 1e6) * row.inputPerMTok * CACHE_READ_MULTIPLIER +
    ((usage.cacheWriteTokens ?? 0) / 1e6) * row.inputPerMTok * CACHE_WRITE_MULTIPLIER +
    (usage.outputTokens / 1e6) * row.outputPerMTok
  );
}

/** Anomaly threshold: warn when a run cost exceeds mean + k·stddev. */
const ANOMALY_K = 3;
/** Minimum prior samples before any anomaly warning may fire. */
const ANOMALY_MIN_SAMPLES = 5;
/** Fixed rolling-window size: only the last N run costs feed the baseline. */
const WINDOW_SIZE = 20;

/** Store keys this extension persists under (its own namespace). */
const KEYS = {
  priceCard: "priceCard",
  enabled: "enabled",
} as const;

/** Render a USD figure to a fixed precision (small costs need many decimals). */
function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

/** Mean of an array (0 for empty). */
function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Population standard deviation of an array (0 for empty/singleton). */
function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(variance);
}

export default function activate(e: ExtensionAPI): () => void {
  // Kill switch: the env var or a stored `enabled:false` flag makes activation a
  // no-op — no command, no handlers — returning a valid no-op dispose closure.
  if (!e.config.enabled("cost", { default: true, store: e.store })) {
    return () => {};
  }

  // --- session state, keyed on the run-tree ROOT (`e.rootAgent`) so it is shared
  // across a session's fork tree but isolated BETWEEN sessions (each on its own
  // Agent) and race-free under concurrency. Eviction drops the root Agent and GCs
  // the entry — no reset closure needed. The rolling anomaly `window` lives here
  // too (session-scoped, not a durable cross-session store key). ----------------
  interface CostState {
    /** Cumulative session cost and tokens, mirrored from the `usage` cumulative. */
    sessionUsd: number;
    sessionTokens: Usage;
    /** Per-run cost; reset on every `agent_start`. */
    runUsd: number;
    /** Per-model breakdown for the live session (USD + tokens + fallback mark). */
    perModel: Map<string, { usd: number; tokens: Usage; fallback: boolean }>;
    /** The model stamped at the start of the current run (the lookup key). */
    activeModel: string;
    /** The most recent finished run's cost and the rolling mean at that point. */
    lastRunUsd: number;
    lastMean: number;
    /** Fixed-size rolling window of recent run costs feeding the anomaly baseline. */
    window: number[];
  }
  const byRoot = new WeakMap<Agent, CostState>();
  const stateFor = (agent: Agent): CostState => {
    let s = byRoot.get(agent);
    if (!s) {
      byRoot.set(
        agent,
        (s = {
          sessionUsd: 0,
          sessionTokens: { inputTokens: 0, outputTokens: 0 },
          runUsd: 0,
          perModel: new Map(),
          activeModel: agent.model,
          lastRunUsd: 0,
          lastMean: 0,
          window: [],
        }),
      );
    }
    return s;
  };

  // Publish the cross-boundary read accessor: a host front end resolves the
  // session's cumulative USD by the session Agent (a non-upserting peek, so a read
  // for a never-priced session returns 0 without pinning an entry).
  e.store.set(COST_ACCESSOR_KEY, (agent: Agent): number => byRoot.get(agent)?.sessionUsd ?? 0);

  // Each handler is wrapped so a thrown error never escapes the bus (trace
  // pattern). A cost failure can at worst drop a number, never a turn.
  const safe =
    <T>(fn: (payload: T) => void) =>
    (payload: T): void => {
      try {
        fn(payload);
      } catch (err) {
        e.log.warn("cost handler error:", err);
      }
    };

  /**
   * The active card: `DEFAULT_PRICE_CARD` merged with the validated `priceCard`
   * store override (the `/cost pricecard …` setter writes it). Re-read on every
   * pricing so a mid-session override takes effect on the next run/render.
   * Malformed override rows are dropped per-row (defensive, `limits` posture).
   */
  const activeCard = (): PriceCard => {
    const raw = e.store.get<unknown>(KEYS.priceCard);
    if (typeof raw !== "object" || raw === null) return DEFAULT_PRICE_CARD;
    const merged: PriceCard = { ...DEFAULT_PRICE_CARD };
    for (const [model, row] of Object.entries(raw as Record<string, unknown>)) {
      if (validRow(row)) merged[model] = { inputPerMTok: row.inputPerMTok, outputPerMTok: row.outputPerMTok };
    }
    return merged;
  };

  const disposers = [
    e.on(
      "agent_start",
      safe(() => {
        // Reset only the per-run accumulator and re-stamp the active model;
        // cumulative + per-model session totals persist across runs.
        const st = stateFor(e.rootAgent);
        st.runUsd = 0;
        st.activeModel = e.agent.model;
      }),
    ),

    e.on(
      "usage",
      safe((p: { usage: Usage; cumulative: Usage; model?: string }) => {
        const card = activeCard();
        const st = stateFor(e.rootAgent);
        // Price at the model the event reports (the exact model the committed
        // stream requested — a routing switch or a retry downshift), keyed the
        // same. `activeModel` (the agent_start model) stays the fallback for older
        // events or a provider that reports none.
        const model = p.model ?? st.activeModel;
        const row = priceRow(model, card);
        // Per-run + per-model use the per-event delta; the session figure mirrors
        // the agent's running cumulative (matching how `trace` mirrors it). Only the
        // run-tree ROOT updates the session cumulative, so a fork's smaller
        // cumulative can't clobber it (the budget-cap root-guard pattern).
        const deltaUsd = costOf(p.usage, row);
        st.runUsd += deltaUsd;
        if (currentActingAgent() === currentRootAgent()) {
          st.sessionUsd = costOf(p.cumulative, row);
          st.sessionTokens = { ...p.cumulative };
        }
        const entry = st.perModel.get(model) ?? {
          usd: 0,
          tokens: { inputTokens: 0, outputTokens: 0 },
          fallback: row.fallback,
        };
        entry.usd += deltaUsd;
        // addUsage aggregates the cache/reasoning fields per provider too, while
        // preserving the omit-invariant for providers that report none.
        entry.tokens = addUsage(entry.tokens, p.usage);
        entry.fallback = row.fallback;
        st.perModel.set(model, entry);
      }),
    ),

    e.on(
      "agent_end",
      safe((_p: { reason: StopReason }) => {
        const st = stateFor(e.rootAgent);
        // Compute the baseline over the PRIOR samples, then record this run.
        const prior = st.window;
        const m = mean(prior);
        const sd = stddev(prior);
        st.lastRunUsd = st.runUsd;
        st.lastMean = m;
        if (prior.length >= ANOMALY_MIN_SAMPLES && st.runUsd > m + ANOMALY_K * sd) {
          e.log.warn(
            `cost anomaly: run cost ${fmtUsd(st.runUsd)} exceeds rolling mean ${fmtUsd(m)} ` +
              `by more than ${ANOMALY_K}σ (n=${prior.length})`,
          );
        }
        // Push this run into the fixed-size rolling window.
        st.window = [...prior, st.runUsd].slice(-WINDOW_SIZE);
      }),
    ),
  ];

  // --- /cost command: status view + pricecard setter ----------------------

  const renderStatus = (print: (line: string) => void): void => {
    const card = activeCard();
    const st = stateFor(e.rootAgent);
    // (a) session cumulative USD + token totals
    print(
      `cumulative: ${fmtUsd(st.sessionUsd)}  ` +
        `(tokens in=${st.sessionTokens.inputTokens} out=${st.sessionTokens.outputTokens} ` +
        `total=${totalTokens(st.sessionTokens)})`,
    );
    // (b) per-model breakdown naming each model (fallback-priced models marked)
    if (st.perModel.size === 0) {
      print("per-model: (no usage recorded yet)");
    } else {
      for (const [model, agg] of st.perModel) {
        const mark = agg.fallback ? "  (fallback rate — unknown model)" : "";
        print(
          `per-model ${model}: ${fmtUsd(agg.usd)}  ` +
            `(in=${agg.tokens.inputTokens} out=${agg.tokens.outputTokens})${mark}`,
        );
      }
    }
    // (c) the active price-card row(s) in effect
    print("price card (rates per MTok, as of 2026-06-22):");
    for (const [model, row] of Object.entries(card)) {
      print(`  price ${model}: in=$${row.inputPerMTok} out=$${row.outputPerMTok}`);
    }
    const fb = priceRow(" unknown ", card);
    print(`  price (fallback, unknown models): in=$${fb.inputPerMTok} out=$${fb.outputPerMTok}`);
    // (d) anomaly-status line naming the rolling mean and last-run cost
    print(
      `anomaly: last-run ${fmtUsd(st.lastRunUsd)} vs rolling mean ${fmtUsd(st.lastMean)} ` +
        `(window n=${st.window.length}, k=${ANOMALY_K}σ, min-samples=${ANOMALY_MIN_SAMPLES})`,
    );
  };

  const runSetter = (rest: string, print: (line: string) => void): void => {
    const parts = rest.trim().split(/\s+/);
    const [model, inRaw, outRaw] = parts;
    if (!model) {
      print("cost: usage — /cost pricecard <model> <inputPerMTok> <outputPerMTok>");
      return;
    }
    const inRate = Number(inRaw);
    const outRate = Number(outRaw);
    if (!validRate(inRate) || !validRate(outRate)) {
      print(`cost: rejected — rates must be finite numbers >= 0 (got "${inRaw}" "${outRaw}")`);
      return;
    }
    // Merge the validated row into the stored override card.
    const stored = e.store.get<unknown>(KEYS.priceCard);
    const override: PriceCard = typeof stored === "object" && stored !== null ? { ...(stored as PriceCard) } : {};
    override[model] = { inputPerMTok: inRate, outputPerMTok: outRate };
    e.store.set(KEYS.priceCard, override);
    print(`cost: price card updated — ${model}: in=$${inRate} out=$${outRate} per MTok`);
  };

  const offCommand = e.registerCommand({
    name: "cost",
    description:
      "Show session cost (USD, per-model, price card, anomaly status) or set a rate " +
      "(/cost pricecard <model> <inputPerMTok> <outputPerMTok>).",
    run: (ctx) => {
      const args = ctx.args.trim();
      const [head, ...rest] = args.split(/\s+/);
      if (head === "pricecard") {
        runSetter(rest.join(" "), ctx.print);
        return;
      }
      // Any other input (empty or unrecognized) renders the status view.
      renderStatus(ctx.print);
    },
  });

  return () => {
    for (const d of [offCommand, ...disposers]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
