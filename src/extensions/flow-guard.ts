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
 * mechanism. So it lives here, riding three primitives the core already exposes
 * — the `tool_end` event (observe what authority and data have been touched),
 * the `message` event (tag the data-bearing message), and the `beforeToolCall`
 * filter (intervene before egress). Egress is gated when either (a) a tool
 * exercised a sensitive *capability* (default `shell:exec`) — a session-sticky
 * flag, since shell output is unscannable — or (b) a tool read a sensitive
 * *path* or returned credential-looking *content*, in which case the taint is
 * pinned to that tool-result message via `meta.flowGuardTaint`. Data taint is
 * information flow: it gates only while the tainting message is still in the
 * live transcript, so `/clear` and `/handoff` un-gate. Once either trigger is
 * active, a later tool requesting an "egress" capability (default `net:fetch`)
 * is held: confirmed with the human in `ask` mode, or refused outright in
 * `block` mode. This is the thesis in action — a new security best practice
 * absorbed as a hot-reloadable extension, not a core fork.
 *
 * Disable or tune it at runtime with `/flow-guard`, or set `EAGENT_FLOW_GUARD=off`.
 */

import { currentActingAgent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";

type Mode = "ask" | "block";

/** Capabilities whose use marks the session as having touched sensitive data. */
const DEFAULT_SOURCE_CAPS = ["shell:exec"];
/** Capabilities that move data off the machine (where a chain would exfiltrate). */
const DEFAULT_EGRESS_CAPS = ["net:fetch", "mcp:call"];

/**
 * Data confinement (the second trigger): reading one of these path patterns, or
 * a tool result that matches one of the content patterns, taints the *message*
 * that carried it even if no `shell:exec` ran — because the *data*, not just the
 * capability, is what must not leave. All are overridable via the extension store.
 */
const DEFAULT_SENSITIVE_PATHS = [
  "\\.env(\\.|$)",
  "id_rsa",
  "id_ed25519",
  "\\.pem$",
  "\\.key$",
  "[\\\\/]\\.ssh[\\\\/]",
  "[\\\\/]\\.aws[\\\\/]",
  "credentials",
  "secret",
];
const DEFAULT_SENSITIVE_CONTENT = [
  "-----BEGIN [A-Z ]*PRIVATE KEY-----", // PEM private keys
  "AKIA[0-9A-Z]{16}", // AWS access key id
  "sk-[A-Za-z0-9_-]{16,}", // OpenAI-style secret keys
  "ghp_[A-Za-z0-9]{36}", // GitHub personal access token
];

function compile(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const p of patterns) {
    try {
      out.push(new RegExp(p, "i"));
    } catch {
      // a bad user-supplied pattern is skipped, not fatal
    }
  }
  return out;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled:
      process.env.EAGENT_FLOW_GUARD === "off"
        ? false
        : e.store.get<boolean>("enabled", true) ?? true,
    mode: (e.store.get<Mode>("mode", "ask") ?? "ask") as Mode,
    sourceCaps: e.store.get<string[]>("sourceCaps", DEFAULT_SOURCE_CAPS) ?? DEFAULT_SOURCE_CAPS,
    egressCaps: e.store.get<string[]>("egressCaps", DEFAULT_EGRESS_CAPS) ?? DEFAULT_EGRESS_CAPS,
    sensitivePaths: compile(e.store.get<string[]>("sensitivePaths", DEFAULT_SENSITIVE_PATHS) ?? DEFAULT_SENSITIVE_PATHS),
    sensitiveContent: compile(
      e.store.get<string[]>("sensitiveContent", DEFAULT_SENSITIVE_CONTENT) ?? DEFAULT_SENSITIVE_CONTENT,
    ),
  });

  /**
   * Capability taint stays a session-sticky set: a tool that ran `shell:exec`
   * could carry a secret in any unscannable form, so we cannot tie that taint to
   * a single message. Data taint is different — it rides the *message* that
   * carried the data (see the `message` handler) and clears when that message
   * leaves the transcript. The split is the whole point of this layer.
   */
  const tainted = new Set<string>();

  /**
   * Sensitive path detections waiting for their tool-result message to be
   * appended. A `tool_end` knows the call arguments (the path), but the message
   * to tag is built later, in the `message` event — so we stash `callId →
   * reasons` and the `message` handler drains it. Cleared on session reset; a
   * never-claimed entry is inert and reclaimed there.
   */
  const pending = new Map<string, string[]>();

  /** Read a message's data-taint marker as an array, or undefined if absent. */
  const taintArray = (m: { meta?: Record<string, unknown> }): unknown[] | undefined => {
    const t = (m.meta as Record<string, unknown> | undefined)?.flowGuardTaint;
    return Array.isArray(t) ? t : undefined;
  };

  /** The capabilities a registered tool declares. */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];

  // Observe authority: the capability-chain trigger. A source-capability tool
  // (default shell:exec) makes the session sticky-tainted. Data confinement is
  // handled per-message below, not here.
  const offEnd = e.on("tool_end", ({ call, result }) => {
    if (result.isError) return;
    const c = cfg();
    const caps = capsOf(call.name);
    for (const cap of caps) if (c.sourceCaps.includes(cap)) tainted.add(cap);

    // Data confinement (path trigger): a sensitive path argument to a read tool.
    // The result message does not exist yet, so record the call id for the
    // `message` handler to tag when it is appended.
    if (caps.includes("fs:read")) {
      for (const v of Object.values(call.arguments)) {
        if (typeof v === "string" && c.sensitivePaths.some((re) => re.test(v))) {
          const reasons = pending.get(call.id) ?? [];
          reasons.push(`sensitive-path:${v}`);
          pending.set(call.id, reasons);
          break;
        }
      }
    }
  });

  // Tag the data: when a tool message is appended, mark each result block whose
  // call was pending (sensitive path) or whose content matches a credential
  // pattern. The emitted message is the same object stored in the transcript, so
  // the tag persists and travels with the data (drops on /clear, /handoff).
  const offMessage = e.on("message", ({ message }) => {
    if (message.role !== "tool") return;
    const c = cfg();
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const reasons = [...(pending.get(block.toolCallId) ?? [])];
      if (c.sensitiveContent.some((re) => re.test(block.content))) reasons.push("sensitive-content");
      if (reasons.length > 0) {
        message.meta = { ...message.meta, flowGuardTaint: reasons };
      }
      pending.delete(block.toolCallId);
    }
  });

  // Intervene: hold a later egress call once the session is tainted — either by
  // a sticky source capability, or by a still-present tool message carrying
  // sensitive data (information flow: gone from the transcript, gone from here).
  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, mode, egressCaps } = cfg();
    if (!enabled || decision.block) return decision;
    // Read the ACTING agent's transcript: a child that read a secret and egresses
    // is caught on its OWN transcript, not the parent's. The capability `tainted`
    // Set stays shared (cross-agent exfiltration catch — KDD-3). (W9.1.)
    const agent = currentActingAgent() ?? e.agent;
    const dataTainted = agent.messages.some((m) => (taintArray(m)?.length ?? 0) > 0);
    if (tainted.size === 0 && !dataTainted) return decision;
    const isEgress = capsOf(ctx.call.name).some((c) => egressCaps.includes(c));
    if (!isEgress) return decision;

    const reasons: string[] = [];
    if (tainted.size > 0) reasons.push(`capabilities [${[...tainted].join(", ")}]`);
    if (dataTainted) reasons.push("sensitive data in the live transcript");
    const why =
      `network egress (${ctx.call.name}) while the session is tainted by ${reasons.join(" and ")} ` +
      `— a capability-chaining / data-exfiltration pattern`;
    if (mode === "block") {
      return { ...decision, block: true, reason: `flow-guard: blocked ${why}` };
    }
    const allow = await e.agent.ui.confirm(`flow-guard: allow ${why}?`);
    return allow ? decision : { ...decision, block: true, reason: `flow-guard: denied ${why}` };
  });

  // The chain is scoped to a session; a fresh runtime starts clean. (Data taint
  // lives on messages, so it clears with the transcript, not here.)
  const reset = () => {
    tainted.clear();
    pending.clear();
  };
  const offStart = e.on("session_start", reset);
  const offDown = e.on("session_shutdown", reset);

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
          pending.clear();
          // Data taint rides the messages, so a true clear-all strips it there too.
          for (const m of (currentActingAgent() ?? e.agent).messages) {
            if (m.meta && "flowGuardTaint" in m.meta) delete (m.meta as Record<string, unknown>).flowGuardTaint;
          }
          c.print("flow-guard: session taint cleared");
          break;
        default: {
          const { enabled, mode, sourceCaps, egressCaps } = cfg();
          const dataCount = (currentActingAgent() ?? e.agent).messages.filter((m) => (taintArray(m)?.length ?? 0) > 0).length;
          c.print(
            `flow-guard ${enabled ? "on" : "off"} (mode=${mode}); ` +
              `source=${sourceCaps.join(",")} -> egress=${egressCaps.join(",")}; ` +
              `capability-taint: ${tainted.size} (${tainted.size ? [...tainted].join(", ") : "none"}); ` +
              `tainted-data: ${dataCount}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offEnd, offMessage, offHook, offStart, offDown, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
