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
 * the `tool_end` event (observe what authority and data have been touched this
 * session) and the `beforeToolCall` filter (intervene before egress). The
 * session is "tainted" when either (a) a tool exercised a sensitive *capability*
 * (default `shell:exec`), or (b) a tool read a sensitive *path* or returned
 * credential-looking *content* (data confinement). Once tainted, a later tool
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

/**
 * Data confinement (the second trigger): reading one of these path patterns, or
 * a tool result that matches one of the content patterns, taints the session
 * even if no `shell:exec` ran — because the *data*, not just the capability, is
 * what must not leave. All are overridable via the extension store.
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

  /** Source capabilities exercised so far this session (the "taint" set). */
  const tainted = new Set<string>();

  /** The capabilities a registered tool declares. */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];

  // Observe: a session becomes "tainted" when either (a) a source-capability
  // tool runs, or (b) a tool reads a sensitive path / returns sensitive-looking
  // content. Either way, sensitive data may now be in the agent's hands.
  const offEnd = e.on("tool_end", ({ call, result }) => {
    if (result.isError) return;
    const c = cfg();
    const caps = capsOf(call.name);
    for (const cap of caps) if (c.sourceCaps.includes(cap)) tainted.add(cap);

    // Data confinement: a sensitive path argument to a read tool...
    if (caps.includes("fs:read")) {
      for (const v of Object.values(call.arguments)) {
        if (typeof v === "string" && c.sensitivePaths.some((re) => re.test(v))) {
          tainted.add("sensitive-path");
          break;
        }
      }
    }
    // ...or a result that looks like a credential, taints the session.
    if (c.sensitiveContent.some((re) => re.test(result.content))) tainted.add("sensitive-content");
  });

  // Intervene: hold a later egress call once the session is tainted.
  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, mode, egressCaps } = cfg();
    if (!enabled || decision.block || tainted.size === 0) return decision;
    const isEgress = capsOf(ctx.call.name).some((c) => egressCaps.includes(c));
    if (!isEgress) return decision;

    const why =
      `network egress (${ctx.call.name}) while the session is tainted by [${[...tainted].join(", ")}] ` +
      `— a capability-chaining / data-exfiltration pattern`;
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
