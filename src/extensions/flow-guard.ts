/**
 * flow-guard — compositional capability policy (the research-driven layer).
 *
 * The capability layer authorizes each tool call *in isolation*. But composing
 * individually-safe tools can be unsafe: reading a secret is fine, reaching the
 * network is fine, yet "read a secret, then POST it out" is exfiltration — the
 * capability-chaining / confused-deputy pattern behind real MCP exploits. No
 * per-call check catches it, because each call, alone, is allowed.
 *
 * The fix does NOT belong in the kernel: it is *policy*, and the kernel ships
 * mechanism. So it lives here, riding two primitives the core already exposes —
 * the `tool_end` event (observe what authority has been exercised this session)
 * and the `beforeToolCall` filter (intervene before egress). When a tool that
 * exercised a "source" capability (default `shell:exec`) has run, a later tool
 * requesting an "egress" capability (default `net:fetch`) is held: confirmed
 * with the human in `ask` mode, or refused outright in `block` mode. This is
 * the thesis in action — a new security best practice absorbed as a
 * hot-reloadable extension, not a core fork.
 *
 * Disable or tune it at runtime with `/flow-guard`, or set `EAGENT_FLOW_GUARD=off`.
 */

import type { ExtensionAPI } from "../kernel/extension.js";

type Mode = "ask" | "block";

/** Capabilities whose use marks the session as having touched sensitive data. */
const DEFAULT_SOURCE_CAPS = ["shell:exec"];
/** Capabilities that move data off the machine (where a chain would exfiltrate). */
const DEFAULT_EGRESS_CAPS = ["net:fetch"];

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled:
      process.env.EAGENT_FLOW_GUARD === "off"
        ? false
        : e.store.get<boolean>("enabled", true) ?? true,
    mode: (e.store.get<Mode>("mode", "ask") ?? "ask") as Mode,
    sourceCaps: e.store.get<string[]>("sourceCaps", DEFAULT_SOURCE_CAPS) ?? DEFAULT_SOURCE_CAPS,
    egressCaps: e.store.get<string[]>("egressCaps", DEFAULT_EGRESS_CAPS) ?? DEFAULT_EGRESS_CAPS,
  });

  /** Source capabilities exercised so far this session (the "taint" set). */
  const tainted = new Set<string>();

  /** The capabilities a registered tool declares. */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];

  // Observe: once a source-capability tool has actually run, the session is
  // "tainted" — sensitive data may now be in the agent's hands.
  const offEnd = e.on("tool_end", ({ call, result }) => {
    if (result.isError) return;
    const { sourceCaps } = cfg();
    for (const cap of capsOf(call.name)) if (sourceCaps.includes(cap)) tainted.add(cap);
  });

  // Intervene: hold a later egress call once the session is tainted.
  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, mode, egressCaps } = cfg();
    if (!enabled || decision.block || tainted.size === 0) return decision;
    const isEgress = capsOf(ctx.call.name).some((c) => egressCaps.includes(c));
    if (!isEgress) return decision;

    const why =
      `network egress (${ctx.call.name}) after sensitive ${[...tainted].join(", ")} use this session ` +
      `— a capability-chaining / exfiltration pattern`;
    if (mode === "block") {
      return { ...decision, block: true, reason: `flow-guard: blocked ${why}` };
    }
    const allow = await e.agent.ui.confirm(`flow-guard: allow ${why}?`);
    return allow ? decision : { ...decision, block: true, reason: `flow-guard: denied ${why}` };
  });

  // The chain is scoped to a session; a fresh runtime starts clean.
  const offStart = e.on("session_start", () => tainted.clear());
  const offDown = e.on("session_shutdown", () => tainted.clear());

  const offCmd = e.registerCommand({
    name: "flow-guard",
    description: "Compositional capability policy. Usage: /flow-guard [on|off|ask|block|reset|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("flow-guard on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("flow-guard off");
          break;
        case "ask":
        case "block":
          e.store.set("mode", arg);
          c.print(`flow-guard mode = ${arg}`);
          break;
        case "reset":
          tainted.clear();
          c.print("flow-guard: session taint cleared");
          break;
        default: {
          const { enabled, mode, sourceCaps, egressCaps } = cfg();
          c.print(
            `flow-guard ${enabled ? "on" : "off"} (mode=${mode}); ` +
              `source=${sourceCaps.join(",")} -> egress=${egressCaps.join(",")}; ` +
              `tainted: ${tainted.size ? [...tainted].join(", ") : "(none)"}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offEnd, offHook, offStart, offDown, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
