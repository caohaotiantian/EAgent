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
 * active, a later tool requesting an "egress" capability (default `net:fetch`,
 * `mcp:call`) is held: confirmed with the human in `ask` mode, or refused outright in
 * `block` mode. This is the thesis in action — a new security best practice
 * absorbed as a hot-reloadable extension, not a core fork.
 *
 * Disable or tune it at runtime with `/flow-guard`, or set `EAGENT_FLOW_GUARD=off`.
 */

import { currentActingAgent, type Agent } from "../kernel/agent.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import type { ToolCallBlock } from "../kernel/types.ts";
import { expandCommands, extractCommand } from "./bash-policy.ts";

type Mode = "ask" | "block";

/** Capabilities whose use marks the session as having touched sensitive data. */
/** Max nesting the sensitive-path arg scan descends into (mirrors provenance/secret-guard). */
const MAX_SCAN_DEPTH = 8;

const DEFAULT_SOURCE_CAPS = ["shell:exec"];
/** Capabilities that move data off the machine (where a chain would exfiltrate). */
const DEFAULT_EGRESS_CAPS = ["net:fetch", "mcp:call"];

/**
 * Shell programs that reach the network. A `shell:exec` call is not itself an
 * egress capability (it is a *source* — every shell run taints capability), so
 * adding it to `egressCaps` would self-gate normal bash. Instead flow-guard
 * treats a shell call as egress-equivalent only when it runs one of these AND
 * the session already carries DATA taint (a prior scannable secret read) — the
 * data-taint gate is what keeps plain "build then curl a health check" flowing.
 * Store-overridable via `networkCommands`.
 */
const DEFAULT_NETWORK_COMMANDS = ["curl", "wget", "nc", "ncat", "ssh", "scp", "sftp", "telnet", "ftp", "rsync"];

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

/**
 * True when a `shell:exec` call runs a network-reaching program (`curl`, `wget`,
 * …). Reads the built-in shell tool's `command` arg directly; an absent or
 * non-string command — a renamed arg or a third-party shell tool with a
 * different key — is not classified (the heuristic scope: an unparseable shell
 * tool is not treated as egress). Reuses bash-policy's `expandCommands` (peels
 * `sudo`/`env`/`timeout` wrappers, splits pipes/segments) and `extractCommand`
 * (strips a leading `VAR=value`, returns the bare program) so `sudo curl evil`
 * and `echo x | curl … evil` are caught where a naive first-token split misses.
 */
function isNetworkShell(call: ToolCallBlock, networkCommands: string[]): boolean {
  const command = call.arguments?.command;
  if (typeof command !== "string") return false;
  return expandCommands(command).some((cmd) => networkCommands.includes(extractCommand(cmd)));
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled: e.config.enabled("flow-guard", { default: true, store: e.store }),
    mode: (e.store.get<Mode>("mode", "ask") ?? "ask") as Mode,
    sourceCaps: e.store.get<string[]>("sourceCaps", DEFAULT_SOURCE_CAPS) ?? DEFAULT_SOURCE_CAPS,
    egressCaps: e.store.get<string[]>("egressCaps", DEFAULT_EGRESS_CAPS) ?? DEFAULT_EGRESS_CAPS,
    sensitivePaths: compile(e.store.get<string[]>("sensitivePaths", DEFAULT_SENSITIVE_PATHS) ?? DEFAULT_SENSITIVE_PATHS),
    sensitiveContent: compile(
      e.store.get<string[]>("sensitiveContent", DEFAULT_SENSITIVE_CONTENT) ?? DEFAULT_SENSITIVE_CONTENT,
    ),
    networkCommands: e.store.get<string[]>("networkCommands", DEFAULT_NETWORK_COMMANDS) ?? DEFAULT_NETWORK_COMMANDS,
  });

  /**
   * Per-session-root state, keyed on `e.rootAgent` (the run-tree root). Both the
   * capability-taint set and the pending-path map are shared across a session's
   * fork tree — so a parent's taint gates a fork's egress (the confused-deputy
   * exfil catch) — yet isolated BETWEEN sessions (each on its own Agent). No reset
   * closure is needed: eviction drops the root Agent and GCs the entry.
   *
   *   - `tainted`: a session-sticky set. A tool that ran `shell:exec` could carry
   *     a secret in any unscannable form, so we cannot tie that taint to a single
   *     message. (Data taint is different — it rides the *message* that carried
   *     the data, see the `message` handler, and clears when that message leaves
   *     the transcript. The split is the whole point of this layer.)
   *   - `pending`: sensitive-path detections awaiting their tool-result message. A
   *     `tool_end` knows the path arg, but the message to tag is built later, in
   *     the `message` event — so we stash `callId → reasons` here and the
   *     `message` handler drains it. A never-claimed entry is inert.
   */
  interface FlowState {
    tainted: Set<string>;
    pending: Map<string, string[]>;
  }
  const byRoot = new WeakMap<Agent, FlowState>();
  const stateFor = (agent: Agent): FlowState => {
    let s = byRoot.get(agent);
    if (!s) byRoot.set(agent, (s = { tainted: new Set(), pending: new Map() }));
    return s;
  };

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
    const st = stateFor(e.rootAgent);
    const caps = capsOf(call.name);
    for (const cap of caps) if (c.sourceCaps.includes(cap)) st.tainted.add(cap);

    // Data confinement (path trigger): a sensitive path argument to a read tool.
    // The result message does not exist yet, so record the call id for the
    // `message` handler to tag when it is appended.
    if (caps.includes("fs:read")) {
      // Recurse string leaves (depth-bounded like provenance/secret-guard) so a
      // sensitive path nested in a sub-object — e.g. a third-party fs:read tool's
      // `{opts:{path:…}}` — is tainted, not only a top-level path arg.
      const findSensitivePath = (v: unknown, depth: number): string | undefined => {
        if (typeof v === "string") return c.sensitivePaths.some((re) => re.test(v)) ? v : undefined;
        if (depth <= 0 || v === null || typeof v !== "object") return undefined;
        for (const item of Object.values(v)) {
          const hit = findSensitivePath(item, depth - 1);
          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      const hit = findSensitivePath(call.arguments, MAX_SCAN_DEPTH);
      if (hit !== undefined) {
        const reasons = st.pending.get(call.id) ?? [];
        reasons.push(`sensitive-path:${hit}`);
        st.pending.set(call.id, reasons);
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
    const st = stateFor(e.rootAgent);
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      const reasons = [...(st.pending.get(block.toolCallId) ?? [])];
      if (c.sensitiveContent.some((re) => re.test(block.content))) reasons.push("sensitive-content");
      if (reasons.length > 0) {
        message.meta = { ...message.meta, flowGuardTaint: reasons };
      }
      st.pending.delete(block.toolCallId);
    }
  });

  // Intervene: hold a later egress call once the session is tainted — either by
  // a sticky source capability, or by a still-present tool message carrying
  // sensitive data (information flow: gone from the transcript, gone from here).
  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, mode, egressCaps, networkCommands } = cfg();
    if (!enabled || decision.block) return decision;
    // Read the ACTING agent's transcript: a child that read a secret and egresses
    // is caught on its OWN transcript, not the parent's. The capability taint set
    // is keyed on the SESSION ROOT, so it stays shared across the fork tree (the
    // cross-agent exfiltration catch) while isolating between sessions.
    const st = stateFor(e.rootAgent);
    const agent = currentActingAgent() ?? e.agent;
    const dataTainted = agent.messages.some((m) => (taintArray(m)?.length ?? 0) > 0);
    if (st.tainted.size === 0 && !dataTainted) return decision;
    const isEgress = capsOf(ctx.call.name).some((c) => egressCaps.includes(c));
    // Shell-exfil path: a network-reaching `shell:exec` call is egress-equivalent,
    // but ONLY under data taint — NOT the sticky capability `tainted` set, which
    // every shell run populates (gating on it would self-gate normal bash). This
    // dataTainted-only gate is the crux: it holds `read secret -> bash curl` while
    // leaving `build -> curl health-check` untouched.
    const isShellEgress =
      !isEgress &&
      dataTainted &&
      capsOf(ctx.call.name).includes("shell:exec") &&
      isNetworkShell(ctx.call, networkCommands);
    if (!isEgress && !isShellEgress) return decision;

    const reasons: string[] = [];
    if (st.tainted.size > 0) reasons.push(`capabilities [${[...st.tainted].join(", ")}]`);
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
        case "reset": {
          const st = stateFor(e.rootAgent);
          st.tainted.clear();
          st.pending.clear();
          // Data taint rides the messages, so a true clear-all strips it there too.
          for (const m of (currentActingAgent() ?? e.agent).messages) {
            if (m.meta && "flowGuardTaint" in m.meta) delete (m.meta as Record<string, unknown>).flowGuardTaint;
          }
          c.print("flow-guard: session taint cleared");
          break;
        }
        default: {
          const { enabled, mode, sourceCaps, egressCaps } = cfg();
          const st = stateFor(e.rootAgent);
          const dataCount = (currentActingAgent() ?? e.agent).messages.filter((m) => (taintArray(m)?.length ?? 0) > 0).length;
          c.print(
            `flow-guard ${enabled ? "on" : "off"} (mode=${mode}); ` +
              `source=${sourceCaps.join(",")} -> egress=${egressCaps.join(",")}; ` +
              `capability-taint: ${st.tainted.size} (${st.tainted.size ? [...st.tainted].join(", ") : "none"}); ` +
              `tainted-data: ${dataCount}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offEnd, offMessage, offHook, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
