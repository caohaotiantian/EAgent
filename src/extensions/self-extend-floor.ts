/**
 * self-extend-floor — a model-capability floor for self-extension.
 *
 * The verified STOP result (Zelikman et al., arXiv 2310.02304) is that
 * scaffold-level self-improvement only bootstrapped with a GPT-4-class base
 * model; weaker models could not. The engineering lesson: a self-modifying loop
 * should assume a capable base and *refuse* rather than loop uselessly (or
 * dangerously) on a weak one. EAgent's self-modification surface (`self.ts`,
 * `self-improve.ts`) is well-gated in every respect except model competence —
 * nothing keys on which model is driving the self-extension.
 *
 * This guard fills that gap. It rides `beforeToolCall` (mirroring `risk-guard`),
 * scoped by capability: it acts only on a call whose registered tool declares
 * `self:extend`, so it covers every current and future `self:extend` tool
 * without naming any. It blocks the call when the acting model (`e.agent.model`)
 * matches NONE of a configured allowlist of model substrings, and passes it
 * through otherwise.
 *
 * It is inert by default: an empty/unset allowlist performs zero gating
 * (byte-identical to today), activated only by configuring
 * `selfExtendFloor.models` (comma-separated, case-insensitive substrings).
 * Substring matching is deliberate so a pattern like `opus` matches
 * `claude-opus-4-8`; write the most specific patterns that still match your
 * intended ids (e.g. `opus-4`, `gpt-5`) since a weaker variant whose id contains
 * an allowlisted substring is admitted. A hard kill switch
 * `EAGENT_SELF_EXTEND_FLOOR=off` disables the guard entirely; on a block it emits
 * one `e.log.warn` line naming the tool, the acting model, and the floor.
 */

import type { ExtensionAPI } from "../kernel/extension.js";

/** The one capability this floor gates. */
const GATED_CAP = "self:extend";

/**
 * Parse the comma-separated allowlist config into normalized patterns: split on
 * `,`, trim, lowercase, drop empties. An empty/unset raw yields `[]` (inert).
 */
export function parseAllowlist(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/**
 * Whether `model` satisfies the floor. `true` when `patterns` is empty (inert),
 * else `true` iff `model` (lowercased) includes at least one pattern — a
 * case-insensitive substring test. Pure, no I/O.
 */
export function modelAllowed(model: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const m = model.toLowerCase();
  return patterns.some((p) => m.includes(p.toLowerCase()));
}

export default function activate(e: ExtensionAPI): () => void {
  const offHook = e.hook("beforeToolCall", (decision, ctx) => {
    // Kill switch: EAGENT_SELF_EXTEND_FLOOR=off disables the guard entirely.
    if (!e.config.enabled("self-extend-floor", { default: true })) return decision;

    // Capability-scoped: act only on tools declaring self:extend. An unknown
    // tool has no spec → [] → passes untouched.
    const caps = e.agent.tools.get(ctx.call.name)?.capabilities ?? [];
    if (!caps.includes(GATED_CAP)) return decision;

    // Inert until configured; an allowed model passes.
    const patterns = parseAllowlist(e.config.get("selfExtendFloor.models", ""));
    if (modelAllowed(e.agent.model, patterns)) return decision;

    e.log.warn(
      `self-extend-floor: blocked ${ctx.call.name} — model "${e.agent.model}" not in floor [${patterns.join(", ")}]`,
    );
    return {
      ...decision,
      block: true,
      reason: `self-extend-floor: model "${e.agent.model}" is below the configured self:extend floor [${patterns.join(", ")}]`,
    };
  });

  return () => {
    try {
      offHook.dispose();
    } catch {
      // teardown must not throw
    }
  };
}
