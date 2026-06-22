/**
 * risk-guard — an LLM-based semantic risk analyzer (the meaning-aware layer).
 *
 * The capability layer authorizes a tool call by *type*, and the pattern-based
 * guards (`flow-guard`, `bash-policy`, `write-guard`) judge it *structurally* —
 * a command family, a capability composition, a blind overwrite. None of them
 * read the *meaning* of a specific invocation: `bash-policy` can ask-list the
 * `rm` family, but it cannot tell `rm /tmp/scratch.txt` from `rm -rf "$HOME"`,
 * nor see that a `curl … | sh` pipes a remote script into a shell. That semantic
 * gap is what an LLM security analyzer fills: classify the proposed call with the
 * model and, only when it judges the specific call RISKY, prompt the human
 * (`ask`) or refuse (`block`).
 *
 * It rides the `beforeToolCall` filter, scoped by capability so the model is
 * consulted only for sensitive-capability tools (default `shell:exec`) — every
 * other call passes untouched, with no round-trip. Because the model call makes
 * this guard *paid and latency-adding* (unlike its provider-free siblings), it
 * ships OFF and must be enabled explicitly. The classification is a recursion-
 * safe provider sub-call with no tools, so it cannot re-enter this seam, and it
 * fails OPEN with a warning: a provider hiccup forgoes the extra semantic check
 * for one call, never bricks the agent — the static gates still apply alongside.
 *
 * Disable or tune it at runtime with `/risk-guard`, or set `EAGENT_RISK_GUARD=off`.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message, ToolCallBlock } from "../kernel/types.js";

type Mode = "ask" | "block";

/** Capabilities whose tools are semantically analyzed before they run. */
const DEFAULT_SENSITIVE_CAPS = ["shell:exec"];

/** The fixed instruction for the classification sub-call. */
const CLASSIFIER_SYSTEM_PROMPT =
  "You are a security analyzer for an autonomous agent. You are given a single " +
  "proposed tool call (its name and arguments). Judge whether running it is " +
  "risky — destructive, irreversible, exfiltrating, or otherwise dangerous. " +
  "Reply on ONE line that begins with SAFE or RISKY. For RISKY, add a colon and " +
  "one short reason, e.g. `RISKY: deletes the home directory`. Output nothing else.";

export interface Verdict {
  risky: boolean;
  reason?: string;
}

/**
 * Parse a classifier reply into a verdict, or `undefined` when unrecognized.
 *
 * Reads the first non-empty line and upper-cases its leading whitespace-
 * delimited token: `RISKY` is risky (reason is the text after the first `:`,
 * trimmed, possibly empty — a missing colon is not a failure); `SAFE` is not
 * risky; anything else, or an empty reply, is unrecognized so the caller fails
 * open with a warning.
 */
export function parseVerdict(reply: string): Verdict | undefined {
  const line = reply.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return undefined;
  const token = (/^[A-Za-z]+/.exec(line)?.[0] ?? "").toUpperCase();
  if (token === "RISKY") {
    const colon = line.indexOf(":");
    return { risky: true, reason: colon >= 0 ? line.slice(colon + 1).trim() : "" };
  }
  if (token === "SAFE") return { risky: false };
  return undefined;
}

/** Concatenate an assistant message's text blocks. */
function textOf(message: Message): string {
  return message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled:
      process.env.EAGENT_RISK_GUARD === "off" ? false : e.store.get<boolean>("enabled", false) ?? false,
    mode: (e.store.get<Mode>("mode", "ask") ?? "ask") as Mode,
    sensitiveCaps: e.store.get<string[]>("sensitiveCaps", DEFAULT_SENSITIVE_CAPS) ?? DEFAULT_SENSITIVE_CAPS,
  });

  /** The capabilities a registered tool declares. */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];

  /**
   * Classify the proposed call via the provider DIRECTLY, mirroring `memory`'s
   * summarization sub-call: passing `tools: []` runs outside the agent loop, so
   * this completion cannot emit a tool call and re-enter `beforeToolCall` — the
   * recursion guard. Any failure (no provider, a throw, an empty/garbled reply)
   * resolves to `undefined`, so the handler fails open.
   */
  async function classify(call: ToolCallBlock): Promise<Verdict | undefined> {
    try {
      const provider = e.agent.providers.get();
      if (!provider) return undefined;
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: `Tool: ${call.name}\nArguments: ${JSON.stringify(call.arguments)}` },
          ],
        },
      ];
      let reply = "";
      for await (const ev of provider.stream({
        systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
        messages,
        tools: [],
        model: e.agent.model,
        signal: new AbortController().signal,
      })) {
        if (ev.type === "done") reply = textOf(ev.message);
      }
      return parseVerdict(reply);
    } catch {
      return undefined;
    }
  }

  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    const { enabled, mode, sensitiveCaps } = cfg();
    if (!enabled || decision.block) return decision;
    if (!capsOf(ctx.call.name).some((c) => sensitiveCaps.includes(c))) return decision;

    const verdict = await classify(ctx.call);
    if (verdict === undefined) {
      e.log.warn("risk-guard: classifier unavailable/unparseable; allowing", ctx.call.name);
      return decision;
    }
    if (!verdict.risky) return decision;

    const why = `risk-guard: ${ctx.call.name} flagged risky${verdict.reason ? ": " + verdict.reason : ""}`;
    if (mode === "block") return { ...decision, block: true, reason: why };
    const allow = await e.agent.ui.confirm(`${why}. Allow?`);
    return allow ? decision : { ...decision, block: true, reason: `risk-guard: denied — ${why}` };
  });

  const offCmd = e.registerCommand({
    name: "risk-guard",
    description: "Semantic risk analyzer. Usage: /risk-guard [on|off|ask|block|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("risk-guard on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("risk-guard off");
          break;
        case "ask":
        case "block":
          e.store.set("mode", arg);
          c.print(`risk-guard mode = ${arg}`);
          break;
        default: {
          const { enabled, mode, sensitiveCaps } = cfg();
          c.print(
            `risk-guard ${enabled ? "on" : "off"} (mode=${mode}); sensitive=${sensitiveCaps.join(",")}`,
          );
        }
      }
    },
  });

  return () => {
    for (const d of [offHook, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
