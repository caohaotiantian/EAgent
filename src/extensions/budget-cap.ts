/**
 * budget-cap — a monetary (USD) spend ceiling that ENFORCES.
 *
 * EAgent already prices and counts spend, but neither existing guard stops on a
 * dollar figure: `limits` enforces a *per-run token* budget (and a tool-call
 * count) yet knows nothing about USD or the cumulative session; `cost` prices
 * tokens into USD across both the run and the session but is **warn-only** ("it
 * never blocks — that is `limits`' job"). `budget-cap` fills the exact gap
 * between them. It observes the `usage` event, prices the running totals into
 * USD by **reusing `cost`'s already-exported pure pricing helpers** (`priceRow`/
 * `costOf`/`DEFAULT_PRICE_CARD` — importing that module runs no side effects, as
 * `activate` is only invoked when called and the named members are pure), and
 * trips a **two-tier ladder**:
 *
 *   - a soft pre-warn at `softFraction`·cap (default 0.8) that only *steers* the
 *     model to wrap up (the `circuit-breaker` soft-steer idiom) and logs; and
 *   - a hard trip at the cap that either **blocks all further (paid) tool calls**
 *     via `beforeToolCall` (`mode === "block"`) or **aborts the run** via
 *     `e.agent.stop()` (`mode === "stop"`), while `mode === "warn"` only logs.
 *
 * Like `limits` and `circuit-breaker` it is a pure hook+event consumer: it
 * registers **no tool**, declares **no capability**, and only gates calls the
 * kernel already authorized through the public hook surface.
 *
 * Two ceilings are tracked independently — a per-run cap and a cumulative-session
 * cap — and **both default to `0` = disabled**, exactly the opt-in posture of
 * `limits.maxTokensPerRun`. So the extension ships wired-but-inert: the hooks are
 * installed but `assess()` returns `"ok"` for any spend until an operator sets a
 * number with `/budget-cap run=<usd>` or `session=<usd>`. Under MockProvider and
 * any unknown model the fallback price is $0, so a default-config CI run can
 * never trip.
 *
 * Two caveats are intrinsic and documented, never papered over:
 *   - **Detection is post-spend.** The crossing model call has already been
 *     billed by the time `usage` fires; we can only stop the *next* spend. The
 *     soft pre-warn is the mitigation. This is not a hard guarantee of max spend.
 *   - **`e.agent.stop()` aborts at turn boundaries only** (the loop checks the
 *     abort signal at top-of-turn and right after `streamTurn`), so an in-flight
 *     model call finishes before the run ends.
 *
 * The hard kill switch `EAGENT_BUDGET_CAP=off` makes activation a no-op disposer;
 * it is also read live inside `cfg()` so `/budget-cap off` flips the gate to
 * pass-through without a reload. Every handler body fails open (logs and returns
 * the value unchanged on any internal error) — a guardrail that crashes the run
 * it guards is worse than no guardrail.
 */

import { currentActingAgent, type Agent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message, Usage } from "../kernel/types.js";
import { text } from "../kernel/types.js";
import type { ToolDecision } from "../kernel/events.js";
import { priceRow, costOf, DEFAULT_PRICE_CARD, type PriceCard } from "./cost.js";

/** Enforcement strength once a cap is exhausted. */
export type Mode = "warn" | "block" | "stop";

/** The recognized modes, for validation. */
const MODES: readonly Mode[] = ["warn", "block", "stop"];

/** Default enforcement strength: block paid tool work once a cap trips. */
const DEFAULT_MODE: Mode = "block";
/** Default soft-warn fraction: steer the model at 80% of a cap. */
const DEFAULT_SOFT_FRACTION = 0.8;

/** The resolved configuration, re-read from the store on every evaluation. */
export interface BudgetConfig {
  enabled: boolean;
  mode: Mode;
  /** Per-run USD ceiling; 0 = disabled. */
  runMaxUsd: number;
  /** Cumulative-session USD ceiling; 0 = disabled. */
  sessionMaxUsd: number;
  /** Fraction of a cap at which the soft pre-warn fires; in (0, 1]. */
  softFraction: number;
}

/** The store keys the config is persisted under (its own namespace). */
const KEYS = {
  mode: "mode",
  runMaxUsd: "runMaxUsd",
  sessionMaxUsd: "sessionMaxUsd",
  softFraction: "softFraction",
  priceCard: "priceCard",
} as const;

/**
 * The pure ladder predicate, exported so it is directly unit-testable. A cap of
 * `0` is disabled and never trips regardless of spend.
 *
 *   - `"hard"` — an enabled cap is met or exceeded (run or session, independently);
 *   - `"soft"` — spend is in the `[softFraction·cap, cap)` band of an enabled cap;
 *   - `"ok"`   — neither.
 *
 * Hard is checked first so a spend past the cap reports `"hard"`, not `"soft"`.
 */
export function assess(runUsd: number, sessionUsd: number, cfg: BudgetConfig): "ok" | "soft" | "hard" {
  const hits = (spend: number, cap: number): boolean => cap > 0 && spend >= cap;
  if (hits(runUsd, cfg.runMaxUsd) || hits(sessionUsd, cfg.sessionMaxUsd)) return "hard";
  const soft = (spend: number, cap: number): boolean => cap > 0 && spend >= cfg.softFraction * cap;
  if (soft(runUsd, cfg.runMaxUsd) || soft(sessionUsd, cfg.sessionMaxUsd)) return "soft";
  return "ok";
}

/** The cap currently binding (hard-exceeded), preferring `run`; else undefined. */
export function bindingCap(
  runUsd: number,
  sessionUsd: number,
  cfg: BudgetConfig,
): { which: "run" | "session"; spend: number; cap: number } | undefined {
  if (cfg.runMaxUsd > 0 && runUsd >= cfg.runMaxUsd) {
    return { which: "run", spend: runUsd, cap: cfg.runMaxUsd };
  }
  if (cfg.sessionMaxUsd > 0 && sessionUsd >= cfg.sessionMaxUsd) {
    return { which: "session", spend: sessionUsd, cap: cfg.sessionMaxUsd };
  }
  return undefined;
}

/**
 * Which enabled cap is in its `[softFraction·cap, cap)` soft band — the run cap
 * preferred when both qualify. Used to frame the soft-warn message on the cap
 * that actually tripped the soft verdict (a run cap enabled but far from its
 * band must not steal the framing from a session cap that is in its band).
 */
export function softBinding(
  runUsd: number,
  sessionUsd: number,
  cfg: BudgetConfig,
): { which: "run" | "session"; spend: number; cap: number } | undefined {
  const inSoft = (spend: number, cap: number): boolean => cap > 0 && spend >= cfg.softFraction * cap;
  if (inSoft(runUsd, cfg.runMaxUsd)) return { which: "run", spend: runUsd, cap: cfg.runMaxUsd };
  if (inSoft(sessionUsd, cfg.sessionMaxUsd)) {
    return { which: "session", spend: sessionUsd, cap: cfg.sessionMaxUsd };
  }
  return undefined;
}

/** True only when `n` is a finite number >= 0 (a valid rate). */
function validRate(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** A price row passes validation only when both rates are finite and >= 0. */
function validRow(row: unknown): row is { inputPerMTok: number; outputPerMTok: number } {
  return (
    typeof row === "object" &&
    row !== null &&
    validRate((row as { inputPerMTok: unknown }).inputPerMTok) &&
    validRate((row as { outputPerMTok: unknown }).outputPerMTok)
  );
}

/** Render a USD figure to a fixed precision (small costs need many decimals). */
function fmtUsd(usd: number): string {
  return `$${usd.toFixed(6)}`;
}

export default function activate(e: ExtensionAPI): () => void {
  // Hard kill switch: wire nothing, register no command, return a no-op disposer
  // (the `circuit-breaker` pattern). Re-checked live in `cfg()` below, so a later
  // `/budget-cap off` flipping the env makes the installed hooks pass through.
  if (process.env.EAGENT_BUDGET_CAP === "off") return () => {};

  // --- run-scoped state, keyed by the ACTING agent (`WeakMap<Agent,…>`) so
  // concurrent parent + child forks don't commingle spend. The parent's entry is
  // reset on `agent_start`; a child's is lazily created (with `activeModel` stamped
  // from its own `model`) on its first `usage`, since `agent_start` is suppressed
  // for children. (W9.1.) -----------------------------------------------------
  interface RunState {
    /** Per-run USD spend; reset on `agent_start`. */
    runUsd: number;
    /** Set once a hard cap trips this run. */
    tripped: boolean;
    /** Set once the soft pre-warn has fired this run (so it nudges only once). */
    softWarned: boolean;
    /** The model stamped when this agent's state was created (the pricing key). */
    activeModel: string;
  }
  const states = new WeakMap<Agent, RunState>();
  const stateFor = (agent: Agent): RunState => {
    let s = states.get(agent);
    if (!s) states.set(agent, (s = { runUsd: 0, tripped: false, softWarned: false, activeModel: agent.model }));
    return s;
  };
  /** Cumulative-session USD; cross-run, shared, mirrored from the ROOT's `usage`. */
  let sessionUsd = 0;

  // Each handler is wrapped so a thrown error never escapes the bus (the `cost`
  // `safe` wrapper). A budget-cap failure can at worst drop a number, never a turn.
  const safe =
    <T>(fn: (payload: T) => void) =>
    (payload: T): void => {
      try {
        fn(payload);
      } catch (err) {
        e.log.warn("budget-cap handler error:", err);
      }
    };

  // --- config (re-read from the store on every call, so `/budget-cap …` retunes
  // live). Each reader falls back on a missing/NaN/out-of-range value, so a
  // malformed store entry can never silently disable a cap (the `limits` posture).
  const readNonNegativeUsd = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
    return fallback;
  };

  const readFraction = (key: string, fallback: number): number => {
    const raw = e.store.get<unknown>(key);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n > 0 && n <= 1) return n;
    return fallback;
  };

  const readMode = (): Mode => {
    const raw = e.store.get<unknown>(KEYS.mode);
    return typeof raw === "string" && (MODES as readonly string[]).includes(raw) ? (raw as Mode) : DEFAULT_MODE;
  };

  const cfg = (): BudgetConfig => ({
    enabled: process.env.EAGENT_BUDGET_CAP !== "off",
    mode: readMode(),
    runMaxUsd: readNonNegativeUsd(KEYS.runMaxUsd, 0),
    sessionMaxUsd: readNonNegativeUsd(KEYS.sessionMaxUsd, 0),
    softFraction: readFraction(KEYS.softFraction, DEFAULT_SOFT_FRACTION),
  });

  /**
   * The active price card: `DEFAULT_PRICE_CARD` merged with the validated
   * `priceCard` store override (the `/budget-cap pricecard …` setter writes it).
   * Re-read on every pricing so a mid-session override takes effect. Malformed
   * override rows are dropped per-row; a non-object store value falls back to the
   * default card whole (defensive — a bad value can never throw or NaN a bill).
   * This `store` is namespaced by extension id, so this override is independent
   * of `/cost`'s own `priceCard`.
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

  // --- 1. Run-scoped reset (agent_start) -----------------------------------
  // Reset only the per-run accumulators and re-stamp the active model; the
  // cumulative session figure persists across runs (mirrored from `usage`).
  const offStart = e.on(
    "agent_start",
    safe(() => {
      const agent = currentActingAgent() ?? e.agent;
      const s = stateFor(agent);
      s.runUsd = 0;
      s.tripped = false;
      s.softWarned = false;
      s.activeModel = agent.model;
    }),
  );

  // --- 2. The trip detector (usage) ----------------------------------------
  const offUsage = e.on(
    "usage",
    safe((p: { usage: Usage; cumulative: Usage }) => {
      const c = cfg();
      if (!c.enabled) return;
      const agent = currentActingAgent() ?? e.agent;
      const s = stateFor(agent);
      const row = priceRow(s.activeModel, activeCard());
      // Per-run accumulates from per-event deltas; the session figure mirrors the
      // authoritative cumulative (avoids float drift across a long session — the
      // exact approach `cost` takes). Only the ROOT agent updates the shared
      // `sessionUsd`, so a child's smaller cumulative can't clobber it. (W9.1.)
      s.runUsd += costOf(p.usage, row);
      if (currentActingAgent() === undefined || currentActingAgent() === e.agent) {
        sessionUsd = costOf(p.cumulative, row);
      }

      const verdict = assess(s.runUsd, sessionUsd, c);
      if (verdict === "hard") {
        // Fire the warn/stop side-effects once, on the ok→hard transition — the
        // gate keeps blocking every later call, so re-warning (and re-calling
        // stop()) on each post-trip usage event would be noise. Mirrors the soft
        // branch's single-shot `softWarned` discipline.
        if (!s.tripped) {
          s.tripped = true;
          const b = bindingCap(s.runUsd, sessionUsd, c);
          if (b) {
            e.log.warn(
              `budget-cap: ${b.which} budget (${fmtUsd(b.cap)}) exceeded — spent ${fmtUsd(b.spend)} ` +
                `(mode=${c.mode})`,
            );
          }
          // Only `mode === "stop"` acts here; `block` is handled in the gate, and
          // `warn` logs only. stop() aborts the ACTING agent at its next turn boundary.
          if (c.mode === "stop") agent.stop();
        }
      } else if (verdict === "soft" && !s.softWarned) {
        s.softWarned = true;
        // The soft band: nudge once, never block. Frame on whichever cap is
        // actually in its soft band (run preferred) — not unconditionally the run
        // cap — so the figures match the cap that tripped. A pre-warn nudges the
        // model to wrap up before the hard wall (the only mitigation for the
        // intrinsic post-spend detection lag).
        const b = softBinding(s.runUsd, sessionUsd, c);
        const cap = b ? b.cap : c.runMaxUsd > 0 ? c.runMaxUsd : c.sessionMaxUsd;
        const spend = b ? b.spend : c.runMaxUsd > 0 ? s.runUsd : sessionUsd;
        e.log.warn(`budget-cap: soft warning — spent ${fmtUsd(spend)} of ${fmtUsd(cap)} budget`);
        const msg: Message = text(
          "user",
          `budget-cap: you have spent ${fmtUsd(spend)} of your ${fmtUsd(cap)} budget. ` +
            `Wrap up now and produce your final answer rather than starting new tool work.`,
        );
        agent.handle.steer(msg);
      }
    }),
  );

  // --- 3. The enforcement gate (beforeToolCall) ----------------------------
  // Belt-and-suspenders for the window between the `usage` event and the next
  // dispatch, and the whole of `mode === "block"`. Never un-blocks another guard's
  // veto. In `mode === "stop"` this is mostly redundant with `e.agent.stop()` but
  // covers any tool dispatched before the abort lands.
  const offGate = e.hook("beforeToolCall", (decision: ToolDecision): ToolDecision => {
    try {
      if (decision.block) return decision; // already vetoed by another guard
      const c = cfg();
      if (!c.enabled || c.mode === "warn") return decision;
      const s = stateFor(currentActingAgent() ?? e.agent);
      if (!s.tripped) return decision;
      const b = bindingCap(s.runUsd, sessionUsd, c);
      const reason = b
        ? `budget-cap: ${b.which} budget (${fmtUsd(b.cap)}) exhausted — spent ${fmtUsd(b.spend)}; ` +
          `halting paid tool work`
        : `budget-cap: budget exhausted — halting paid tool work`;
      return { ...decision, block: true, reason };
    } catch (err) {
      e.log.warn("budget-cap: gate hook error:", err);
      return decision;
    }
  });

  // --- 4. /budget-cap command ----------------------------------------------
  const renderStatus = (print: (line: string) => void): void => {
    const c = cfg();
    const s = stateFor(currentActingAgent() ?? e.agent);
    print(`enabled=${c.enabled}`);
    print(`mode=${c.mode}`);
    print(`runMaxUsd=${c.runMaxUsd}${c.runMaxUsd === 0 ? " (disabled)" : ""}`);
    print(`sessionMaxUsd=${c.sessionMaxUsd}${c.sessionMaxUsd === 0 ? " (disabled)" : ""}`);
    print(`softFraction=${c.softFraction}`);
    print(`runUsd=${fmtUsd(s.runUsd)}`);
    print(`sessionUsd=${fmtUsd(sessionUsd)}`);
    print(`tripped=${s.tripped}`);
  };

  const setPriceCard = (parts: string[], print: (line: string) => void): void => {
    const [model, inRaw, outRaw] = parts;
    if (!model) {
      print("budget-cap: usage — /budget-cap pricecard <model> <inputPerMTok> <outputPerMTok>");
      return;
    }
    const inRate = Number(inRaw);
    const outRate = Number(outRaw);
    if (!validRate(inRate) || !validRate(outRate)) {
      print(`budget-cap: rejected — rates must be finite numbers >= 0 (got "${inRaw}" "${outRaw}")`);
      return;
    }
    const stored = e.store.get<unknown>(KEYS.priceCard);
    const override: PriceCard = typeof stored === "object" && stored !== null ? { ...(stored as PriceCard) } : {};
    override[model] = { inputPerMTok: inRate, outputPerMTok: outRate };
    e.store.set(KEYS.priceCard, override);
    print(`budget-cap: price card updated — ${model}: in=$${inRate} out=$${outRate} per MTok`);
  };

  /** Apply one `key=value` setter; print a confirmation or a rejection. */
  const applyPair = (key: string, value: string, print: (line: string) => void): void => {
    // `run`/`session` are the user-facing aliases for the USD-ceiling store keys.
    if (key === "run" || key === "session" || key === KEYS.runMaxUsd || key === KEYS.sessionMaxUsd) {
      const storeKey = key === "run" || key === KEYS.runMaxUsd ? KEYS.runMaxUsd : KEYS.sessionMaxUsd;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        print(`budget-cap: "${key}" must be a finite number >= 0 (got "${value}") — unchanged`);
        return;
      }
      e.store.set(storeKey, n);
      print(`budget-cap: ${storeKey}=${n}${n === 0 ? " (disabled)" : ""}`);
      return;
    }
    if (key === KEYS.mode) {
      if (!(MODES as readonly string[]).includes(value)) {
        print(`budget-cap: "mode" must be one of ${MODES.join("|")} (got "${value}") — unchanged`);
        return;
      }
      e.store.set(KEYS.mode, value);
      print(`budget-cap: mode=${value}`);
      return;
    }
    if (key === "soft" || key === KEYS.softFraction) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || n > 1) {
        print(`budget-cap: "soft" must be a number in (0, 1] (got "${value}") — unchanged`);
        return;
      }
      e.store.set(KEYS.softFraction, n);
      print(`budget-cap: softFraction=${n}`);
      return;
    }
    print(`budget-cap: unknown key "${key}"`);
  };

  const offCmd = e.registerCommand({
    name: "budget-cap",
    description:
      "USD spend ceiling that enforces. Usage: /budget-cap " +
      "[status|on|off|reset|run=<usd>|session=<usd>|mode=warn|block|stop|soft=<0..1>|pricecard <model> <in> <out>]",
    run: (ctx) => {
      const tokens = ctx.args.trim().split(/\s+/).filter(Boolean);
      const head = tokens[0] ?? "";

      if (head === "pricecard") {
        setPriceCard(tokens.slice(1), ctx.print);
        return;
      }
      if (head === "on") {
        process.env.EAGENT_BUDGET_CAP = "on";
        ctx.print("budget-cap on");
        return;
      }
      if (head === "off") {
        process.env.EAGENT_BUDGET_CAP = "off";
        ctx.print("budget-cap off");
        return;
      }
      if (head === "reset") {
        const s = stateFor(currentActingAgent() ?? e.agent);
        s.runUsd = 0;
        s.tripped = false;
        s.softWarned = false;
        ctx.print("budget-cap: per-run state cleared (runUsd, tripped, softWarned)");
        return;
      }
      if (head === "" || head === "status") {
        renderStatus(ctx.print);
        return;
      }

      // Otherwise treat every token as a `key=value` setter.
      for (const pair of tokens) {
        const eq = pair.indexOf("=");
        if (eq <= 0) {
          ctx.print(`budget-cap: ignoring "${pair}" (expected key=value)`);
          continue;
        }
        applyPair(pair.slice(0, eq), pair.slice(eq + 1), ctx.print);
      }
    },
  });

  return () => {
    for (const d of [offCmd, offGate, offUsage, offStart]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
