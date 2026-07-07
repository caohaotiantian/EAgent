/**
 * circuit-breaker — fail-fast on tool-call repetition and consecutive failures.
 *
 * EAgent already has two run-scoped guards on the tool-dispatch path, but neither
 * tracks the *identity* of a call. `limits` caps the total number of calls and
 * tokens; `recovery` appends one stateless hint to a failed result. So three
 * loops slip through both: an identical broken retry, a useless-but-successful
 * spin, and an A-B-A-B oscillation. What these share is a per-signature loop
 * whose correction is mechanical.
 *
 * This extension is a circuit breaker keyed on the call signature
 * (`name + canonical(args)`). It maintains a per-run
 * `Map<signature, { count; consecutiveFailures }>`, observes outcomes via
 * `afterToolCall`, and trips on a ladder via `beforeToolCall`: the **2nd**
 * occurrence earns a single non-blocking `steer` nudge; the **N-th** (default 3)
 * occurrence — or N consecutive failures of that signature — is halted (asked in
 * `ask` mode, refused in `block` mode). All state is in-memory and reset on
 * `agent_start`; nothing is persisted except the three config keys.
 *
 * It declares no capability and registers no tool — it only steers or blocks a
 * decision the kernel already authorized. Every hook body fails open (logs and
 * returns the decision/result unchanged on any internal error), and
 * `EAGENT_CIRCUIT_BREAKER=off` returns a no-op disposer. Tune it at runtime with
 * `/circuit-breaker [on|off|ask|block|status|reset|threshold=<n>]`.
 */

import { currentActingAgent, type Agent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message, ToolResult } from "../kernel/types.js";
import type { ToolDecision } from "../kernel/events.js";

type Mode = "ask" | "block";

/** Occurrences (or consecutive failures) of a signature before the hard trip. */
const DEFAULT_THRESHOLD = 3;
/** On by default, `ask` mode: the hard trip routes through `ui.confirm`. */
const DEFAULT_MODE: Mode = "ask";

/** The store keys the config is persisted under. */
const KEYS = {
  enabled: "enabled",
  mode: "mode",
  threshold: "threshold",
} as const;

/**
 * Canonical JSON serialization with **recursively sorted object keys**, so two
 * genuinely-identical calls emitted with different key orders (`{a,b}` vs
 * `{b,a}`) produce the same string, while different *values* (an advancing
 * pagination offset) produce different strings. Arrays keep their order
 * (element order is semantically meaningful); primitives pass through.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown): unknown => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return v;
  });
}

/**
 * The loop-detection signature for a call: its name plus a canonical
 * serialization of its arguments. Pure and exported so the canonicalization is
 * directly unit-testable (key-order invariance and value sensitivity).
 */
export function stableSignature(name: string, args: unknown): string {
  return `${name}:${stableStringify(args)}`;
}

interface Bucket {
  count: number;
  consecutiveFailures: number;
}

export default function activate(e: ExtensionAPI): () => void {
  // Hard kill switch: wire nothing, return a no-op disposer.
  if (!e.config.enabled("circuit-breaker", { default: true })) return () => {};

  /**
   * Per-run signature buckets, keyed by the ACTING agent (`WeakMap<Agent,…>`) so
   * concurrent parent + child forks don't share a bucket. In-memory; the parent's
   * entry is reset on `agent_start` (a child's is suppressed, so it lazily inits
   * on its first call) and self-evicts on GC. (W9.1.)
   */
  const buckets = new WeakMap<Agent, Map<string, Bucket>>();

  /** Read a positive integer from the store, falling back for missing/NaN/<=0. */
  const readThreshold = (): number => {
    const raw = e.store.get<unknown>(KEYS.threshold);
    const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
    return DEFAULT_THRESHOLD;
  };

  const cfg = (): { enabled: boolean; mode: Mode; threshold: number } => ({
    enabled: e.config.enabled("circuit-breaker", { default: true, store: e.store }),
    mode: (e.store.get<Mode>(KEYS.mode, DEFAULT_MODE) ?? DEFAULT_MODE) as Mode,
    threshold: readThreshold(),
  });

  /** The signature→bucket map for an agent, lazily created on first use. */
  const bucketsFor = (agent: Agent): Map<string, Bucket> => {
    let m = buckets.get(agent);
    if (!m) buckets.set(agent, (m = new Map<string, Bucket>()));
    return m;
  };

  /** Fetch (creating if absent) the bucket for a signature on an agent. */
  const bucketFor = (agent: Agent, sig: string): Bucket => {
    const m = bucketsFor(agent);
    let b = m.get(sig);
    if (!b) m.set(sig, (b = { count: 0, consecutiveFailures: 0 }));
    return b;
  };

  // --- 1. The repetition / failure ladder (beforeToolCall) -----------------
  const offBefore = e.hook("beforeToolCall", async (decision, ctx): Promise<ToolDecision> => {
    try {
      const { enabled, mode, threshold } = cfg();
      // Kill switch / store-disabled / already-vetoed: pass through untouched.
      // Never un-block an existing block.
      if (!enabled || decision.block) return decision;

      // Steer/track the ACTING agent (the running child under a shared bus), not
      // the parent bound at activation. (W9.1.)
      const agent = currentActingAgent() ?? e.agent;
      // Key on the RAW model arguments (`ctx.call.arguments`), exactly as
      // `afterToolCall` does, so both hooks address the same bucket. Keying on
      // `decision.arguments` here would use the validate-coerced shape ("3"->3,
      // filled defaults), diverging from the after-hook for any coercing schema
      // and splitting the count and the failure streak across two buckets.
      const sig = stableSignature(ctx.call.name, ctx.call.arguments);
      const b = bucketFor(agent, sig);
      b.count += 1;

      // Failure trip first (so its framing wins when both branches apply): once
      // this signature has failed `threshold` times in a row, halt the next
      // attempt with a failure-framed reason — distinct from the identical-args
      // reason so AC-2 and AC-4 assert different text. The streak is maintained
      // by `afterToolCall` and reset on a success of this signature.
      if (b.consecutiveFailures >= threshold) {
        const reason = `circuit-breaker: ${ctx.call.name} failed ${b.consecutiveFailures}x — halting the retry loop`;
        return await halt(agent, decision, reason, mode);
      }

      // Hard repetition trip at the threshold — the useless-but-not-erroring
      // spin. Gated on an empty failure streak so an actively-failing signature
      // is routed to the failure branch above (which reports `failed Nx`) rather
      // than pre-empted here. Checked BEFORE the soft steer so a threshold of 2
      // trips on the 2nd occurrence rather than only nudging.
      if (b.count >= threshold && b.consecutiveFailures === 0) {
        const reason = `circuit-breaker: ${ctx.call.name} called ${b.count}x with identical args`;
        return await halt(agent, decision, reason, mode);
      }

      // Soft steer at the 2nd occurrence (when 2 is strictly below threshold):
      // nudge once, never block, and let a legitimate retry proceed.
      if (b.count === 2) {
        const text =
          `circuit-breaker: you are repeating an identical call to ${ctx.call.name} with the same arguments. ` +
          `Re-issuing the identical call is unlikely to make progress — change the arguments or try a different approach.`;
        const message: Message = { role: "user", content: [{ type: "text", text }] };
        agent.handle.steer(message);
        return decision;
      }

      return decision;
    } catch (err) {
      e.log.warn("circuit-breaker: beforeToolCall hook error:", err);
      return decision;
    }
  });

  /** Block in `block` mode; ask the human in `ask` mode (allow on confirm). */
  const halt = async (agent: Agent, decision: ToolDecision, reason: string, mode: Mode): Promise<ToolDecision> => {
    if (mode === "block") return { ...decision, block: true, reason };
    const allow = await agent.ui.confirm(`${reason}. Allow this call anyway?`);
    return allow ? decision : { ...decision, block: true, reason };
  };

  // --- 2. Outcome recording (afterToolCall) — observes only ----------------
  const offAfter = e.hook("afterToolCall", (result: ToolResult, ctx): ToolResult => {
    try {
      if (!cfg().enabled) return result;
      const agent = currentActingAgent() ?? e.agent;
      const sig = stableSignature(ctx.call.name, ctx.call.arguments);
      const b = bucketFor(agent, sig);
      if (result.isError === true) b.consecutiveFailures += 1;
      else b.consecutiveFailures = 0; // the *failure streak* resets on success
      return result;
    } catch (err) {
      e.log.warn("circuit-breaker: afterToolCall hook error:", err);
      return result;
    }
  });

  // --- 3. Per-run reset (the acting agent's entry only; children never fire
  // agent_start, so a child's bucket is born fresh on its first call). ---------
  const offReset = e.on("agent_start", () => {
    buckets.delete(currentActingAgent() ?? e.agent);
  });

  // --- 4. /circuit-breaker command -----------------------------------------
  const offCmd = e.registerCommand({
    name: "circuit-breaker",
    description:
      "Tool-call repetition / consecutive-failure guard. Usage: /circuit-breaker [on|off|ask|block|status|reset|threshold=<n>]",
    run: (c) => {
      const arg = c.args.trim();
      if (arg.startsWith("threshold=")) {
        const value = arg.slice("threshold=".length);
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          c.print(`circuit-breaker: threshold must be a positive integer (got "${value}")`);
          return;
        }
        e.store.set(KEYS.threshold, Math.floor(n));
        c.print(`circuit-breaker threshold = ${Math.floor(n)}`);
        return;
      }
      switch (arg) {
        case "on":
          e.store.set(KEYS.enabled, true);
          c.print("circuit-breaker on");
          break;
        case "off":
          e.store.set(KEYS.enabled, false);
          c.print("circuit-breaker off");
          break;
        case "ask":
        case "block":
          e.store.set(KEYS.mode, arg);
          c.print(`circuit-breaker mode = ${arg}`);
          break;
        case "reset":
          buckets.delete(currentActingAgent() ?? e.agent);
          c.print("circuit-breaker: per-run state cleared");
          break;
        case "":
        case "status":
        default: {
          const { enabled, mode, threshold } = cfg();
          c.print(`enabled=${enabled}`);
          c.print(`mode=${mode}`);
          c.print(`threshold=${threshold}`);
          c.print(`buckets=${buckets.get(currentActingAgent() ?? e.agent)?.size ?? 0}`);
        }
      }
    },
  });

  return () => {
    for (const d of [offBefore, offAfter, offReset, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
