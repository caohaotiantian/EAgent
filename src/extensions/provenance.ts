/**
 * provenance — a CaMeL-lite arg-derivation gate (structural injection defense).
 *
 * Indirect prompt injection is the top agentic risk. EAgent already fences
 * foreign ingress (`content-guard`) and gates sensitive-pattern egress
 * (`flow-guard`), but neither makes the structural CaMeL move: track that a
 * *privileged side-effecting* call's ARGUMENTS derive from untrusted content and
 * gate *that* call. The full CaMeL design (a privileged/quarantined LLM split +
 * a data-flow interpreter) is exactly why it was not adopted — the interpreter is
 * the tax. The adopted-in-practice subset ("CaMeL-lite") is: tag tool results
 * with source provenance, propagate immediate dependency, and gate a privileged
 * sink whose args derive from untrusted content — escalating, not crashing.
 *
 * That subset maps 1:1 onto two seams EAgent already exposes, needing zero kernel
 * change: `afterToolCall` tags a foreign result's content into a bounded closure
 * segment-store, and `beforeToolCall` flags a sink call whose string args contain
 * a verbatim ≥minLen untrusted segment. On a flag it ESCALATES — prompting the
 * human via `ui.confirm` (default mode, blocking on a `false` answer) or blocking
 * outright (strict mode). The reason names the tool and a redacted marker of the
 * overlap (its length + a non-crypto hash) — never the value.
 *
 * Complementary to its siblings on a distinct axis: content-guard = ingress
 * labeling, flow-guard = sensitive-pattern → egress, provenance = source-taint +
 * arg-derivation → any privileged sink. The closure store lives in this extension
 * (no kernel field); because `before/afterToolCall` are shared filter points, the
 * store accumulates a child sub-agent's foreign results and gates its sink calls
 * too — so provenance governs sub-agents. It declares NO capability (it routes
 * trust through the existing layer). Off by default: an arg-derivation gate can
 * have false positives and changes tool-call behavior, so a deployment opts in
 * knowingly via `/provenance on` (or the `enabled` store flag); `EAGENT_PROVENANCE=off`
 * is a hard kill switch.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { ToolResult } from "../kernel/types.js";

type Mode = "default" | "strict";

/** Capabilities whose declaring tool produces foreign/untrusted output. */
const DEFAULT_FOREIGN_CAPS = ["net:fetch", "mcp:call", "mcp:read"];
/** Capabilities marking a privileged side-effecting sink to gate. */
const DEFAULT_SINK_CAPS = ["shell:exec", "net:fetch", "mcp:call", "fs:write"];
/** Minimum segment length: the floor that kills one-word-overlap false positives. */
const DEFAULT_MIN_LEN = 24;
/** Hard cap on the closure store (FIFO eviction past it) to bound growth. */
const DEFAULT_MAX_SEGMENTS = 256;
/** Max nesting the arg scan descends into (bounds a pathologically deep arg). */
const MAX_SCAN_DEPTH = 8;

/**
 * Yield every string leaf of an args value, descending into objects and arrays
 * up to `depth` levels. A privileged sink (e.g. `mcp:call`) takes arbitrary
 * nested params, so a tainted segment can hide below the top level; the depth
 * bound keeps a hostile deeply-nested arg from blowing the stack.
 */
function* stringLeaves(value: unknown, depth: number): Iterable<string> {
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (depth <= 0 || value === null || typeof value !== "object") return;
  for (const v of Object.values(value as Record<string, unknown>)) {
    yield* stringLeaves(v, depth - 1);
  }
}

/** A short, non-crypto hash (djb2) — a redacted marker that never echoes the value. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export default function activate(e: ExtensionAPI): () => void {
  if (!e.config.enabled("provenance", { default: true })) return () => {};

  const cfg = () => ({
    enabled: e.config.enabled("provenance", { default: false, store: e.store }),
    mode: (e.store.get<Mode>("mode", "default") ?? "default") as Mode,
    foreignCaps: e.store.get<string[]>("foreignCaps", DEFAULT_FOREIGN_CAPS) ?? DEFAULT_FOREIGN_CAPS,
    sinkCaps: e.store.get<string[]>("sinkCaps", DEFAULT_SINK_CAPS) ?? DEFAULT_SINK_CAPS,
    minLen: e.store.get<number>("minLen", DEFAULT_MIN_LEN) ?? DEFAULT_MIN_LEN,
    maxSegments: e.store.get<number>("maxSegments", DEFAULT_MAX_SEGMENTS) ?? DEFAULT_MAX_SEGMENTS,
  });

  /** The bounded untrusted-segment store (closure state; no kernel field). */
  const untrusted = new Set<string>();

  /** The capabilities a registered tool declares (the flow-/secret-guard pattern). */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];
  const intersects = (caps: string[], set: string[]): boolean => caps.some((c) => set.includes(c));

  // Tagger: a successful foreign-source result's content is split into normalized
  // ≥minLen segments and added to the store (FIFO-capped). Observe-only — the
  // result is returned unchanged.
  const offAfter = e.hook("afterToolCall", (result: ToolResult, ctx) => {
    const c = cfg();
    if (!c.enabled || result.isError || !intersects(capsOf(ctx.call.name), c.foreignCaps)) return result;
    for (const seg of result.content.split(/\s+/)) {
      if (seg.length < c.minLen) continue;
      untrusted.add(seg);
      while (untrusted.size > c.maxSegments) {
        const oldest = untrusted.values().next().value;
        if (oldest === undefined) break;
        untrusted.delete(oldest);
      }
    }
    return result;
  });

  // Gate: a privileged-sink call whose string arg contains a verbatim untrusted
  // segment is escalated — prompted (default) or blocked (strict). The reason
  // carries only a redacted marker (length + hash), never the matched value.
  const offBefore = e.hook("beforeToolCall", async (decision, ctx) => {
    const c = cfg();
    if (!c.enabled || decision.block) return decision;
    if (!intersects(capsOf(ctx.call.name), c.sinkCaps)) return decision;
    for (const v of stringLeaves(decision.arguments, MAX_SCAN_DEPTH)) {
      for (const seg of untrusted) {
        if (!v.includes(seg)) continue;
        const reason = `provenance: ${ctx.call.name} arg derives from untrusted content (len=${seg.length}, h=${djb2(seg)})`;
        if (c.mode === "strict") return { ...decision, block: true, reason };
        const ok = await e.agent.ui.confirm(reason);
        return ok ? decision : { ...decision, block: true, reason };
      }
    }
    return decision;
  });

  const offCmd = e.registerCommand({
    name: "provenance",
    description: "CaMeL-lite arg-derivation gate. Usage: /provenance [on|off|strict|status]",
    run: (cmd) => {
      const arg = cmd.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          e.store.set("mode", "default");
          cmd.print("provenance on (mode=default)");
          break;
        case "strict":
          e.store.set("enabled", true);
          e.store.set("mode", "strict");
          cmd.print("provenance on (mode=strict)");
          break;
        case "off":
          e.store.set("enabled", false);
          cmd.print("provenance off");
          break;
        default: {
          const c = cfg();
          cmd.print(
            `provenance ${c.enabled ? "on" : "off"} (mode=${c.mode}); ` +
              `foreign=${c.foreignCaps.join(",")} -> sink=${c.sinkCaps.join(",")}; ` +
              `minLen=${c.minLen}; tracked-segments: ${untrusted.size}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offAfter, offBefore, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
