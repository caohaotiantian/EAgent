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

import type { ExtensionAPI } from "../kernel/extension.ts";
import type { Config } from "../kernel/store.ts";
import type { Message, ToolCallBlock } from "../kernel/types.ts";
import { normalizeForInspection } from "./lib/decode.ts";

type Mode = "ask" | "block";

/** Capabilities whose tools are semantically analyzed before they run. */
const DEFAULT_SENSITIVE_CAPS = ["shell:exec"];

/** Classifier sub-call timeout (ms). `risk-guard.timeoutMs`, default 10000
 *  (matches memory's network sub-call bound); invalid/≤0 falls back to the default. */
function classifyTimeoutMs(config: Config): number {
  const n = config.int("risk-guard.timeoutMs", 10000);
  return Number.isInteger(n) && n > 0 ? n : 10000;
}

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
 * Reads the first non-empty line and upper-cases its leading run of letters
 * (so `RISKY:` and `safe,` classify by `RISKY`/`SAFE`): `RISKY` is risky (reason
 * is the text after the first `:`,
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

/** Every string leaf of `v` (recursing through arrays/objects), so each arg value
 *  can be decode-normalized on its own — catching a rot13'd command hidden in one
 *  value that the whole-blob scan cannot surface. */
function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringLeaves(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringLeaves(x, out);
  return out;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    enabled: e.config.enabled("risk-guard", { default: false, store: e.store }),
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

      // Pre-inspection decode (decode-normalize): normalize the WHOLE stringified
      // blob AND each string-leaf value. The whole-blob pass lets the substring
      // idiom/base64 matchers find a payload embedded in the JSON wrapper; the
      // per-value pass makes each value the *whole* subject, so a rot13'd command
      // hidden in one arg value (which the gate can't surface from the whole blob,
      // whose first token is `{"…":`) is decoded (`ez -es /` → `rm -rf /`). Emit a
      // deduped `[decoded payload: …]` line for each decode differing from the raw
      // blob. `EAGENT_DECODE_NORMALIZE=off` leaves the prompt byte-identical.
      const rawArgs = JSON.stringify(call.arguments);
      let prefix = "";
      if (e.config.enabled("decode.normalize", { default: true })) {
        const seen = new Set<string>();
        const annotate = (subject: string): void => {
          for (const decoded of normalizeForInspection(subject)) {
            if (decoded !== rawArgs && !seen.has(decoded)) {
              seen.add(decoded);
              prefix += `[decoded payload: ${decoded}]\n`;
            }
          }
        };
        annotate(rawArgs);
        for (const value of stringLeaves(call.arguments)) annotate(value);
      }

      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: `${prefix}Tool: ${call.name}\nArguments: ${rawArgs}` },
          ],
        },
      ];
      // Bound the classifier sub-call: a hung provider must not block this
      // (blocking) gate forever. A ref'd `setTimeout` (NOT `AbortSignal.timeout`,
      // whose timer is unref'd) keeps the loop alive so the deadline actually
      // fires even when this sub-call is the only pending work; on abort the
      // stream throws → the outer catch fails open (like classifier-unavailable).
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("risk-guard: classifier timed out")),
        classifyTimeoutMs(e.config),
      );
      try {
        let reply = "";
        for await (const ev of provider.stream({
          systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
          messages,
          tools: [],
          model: e.agent.model,
          signal: controller.signal,
        })) {
          if (ev.type === "done") reply = textOf(ev.message);
        }
        return parseVerdict(reply);
      } finally {
        clearTimeout(timer);
      }
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
