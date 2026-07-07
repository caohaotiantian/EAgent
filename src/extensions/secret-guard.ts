/**
 * secret-guard — keep secret VALUES out of tool args (and the transcript).
 *
 * EAgent has a rich vocabulary for authorizing a tool by *capability* and three
 * `beforeToolCall` policy guards — `flow-guard` (compositional egress),
 * `risk-guard` (semantic risk), `bash-policy` (command-granular shell) — plus
 * `content-guard` on `afterToolCall` (ingress). What none of them close is a
 * **secret VALUE materializing into a tool argument**: when the model emits
 * `bash` with `curl -H "Authorization: Bearer sk-…"`, or a `net:fetch` tool with
 * an `AKIA…` header, the plaintext key lands in the tool-call block — and from
 * there into the transcript, the journal, every trace/checkpoint, and every
 * later context window. Once it is there, no downstream guard can un-leak it.
 *
 * secret-guard fills that prevention seam: a `beforeToolCall` filter that scans
 * the about-to-run arguments for secret-looking *values* and, for a tool whose
 * capability could *leak* the value (the egress/exec set — default `net:fetch`,
 * `shell:exec`, `mcp:call`), HOLDS the call — asking the human in `ask` mode (default) or
 * refusing in `block` mode — WITHOUT ever echoing the matched value. The single
 * most important property: only the matched *kind* label ever appears in a
 * reason, prompt, or log line; the secret value never does.
 *
 * It rides one seam and declares no capability of its own (it only reads args and
 * calls `ui.confirm`). Being a pure-regex scan, it is free and adds no latency,
 * so — unlike `risk-guard` — it ships ON in `ask` mode, with three off-ramps:
 * `/secret-guard off`, `EAGENT_SECRET_GUARD=off`, or `host.unload`.
 */

import type { ExtensionAPI } from "../kernel/extension.js";

type Mode = "ask" | "block";

/**
 * Known-credential patterns, copied WITH ATTRIBUTION from flow-guard's
 * `DEFAULT_SENSITIVE_CONTENT` (`src/extensions/flow-guard.ts:55-60`) so the two
 * guards agree on "what a secret looks like": flow-guard taints when one of these
 * appears in a *result*, secret-guard holds when the *same shape* appears in an
 * *argument*. Copied (not imported from flow-guard's non-exported `const`) to
 * keep the two guards decoupled — no load-order or circular-import coupling —
 * this comment marks the single-source-of-truth intent for the eventual
 * extract-to-shared-module refactor. No entropy gate: the patterns are
 * structurally anchored, so the false-positive rate is near zero, and the table is
 * shaped so an entropy gate is a one-entry addition later.
 */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "pem-private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
  { kind: "aws-access-key-id", re: /AKIA[0-9A-Z]{16}/i },
  { kind: "openai-secret-key", re: /sk-[A-Za-z0-9_-]{16,}/i },
  { kind: "github-token", re: /ghp_[A-Za-z0-9]{36}/i },
];

/** Capabilities that move data off the machine — where a leak would happen. */
const DEFAULT_LEAK_CAPS = ["net:fetch", "shell:exec", "mcp:call"];

/** Max nesting the arg scan descends into (mirrors provenance's bound; keeps a
 *  pathologically deep arg from overflowing the stack → fail-open secret bypass). */
const MAX_SCAN_DEPTH = 8;

/**
 * Scan a single string for known credential shapes, returning the de-duplicated
 * list of KIND labels that matched. Pure. Returns `[]` for a non-string or no
 * match. By contract it NEVER returns the matched substring — only kind labels —
 * so a reason can name *what* matched without leaking *the value*.
 */
export function scanSecrets(value: string): string[] {
  if (typeof value !== "string") return [];
  const kinds: string[] = [];
  for (const { kind, re } of SECRET_PATTERNS) {
    if (re.test(value) && !kinds.includes(kind)) kinds.push(kind);
  }
  return kinds;
}

/**
 * Walk argument *values* recursively — descending arrays and plain objects — and
 * return the de-duplicated union of secret kinds found in any nested string.
 * Numbers/booleans/null/undefined are ignored. Pure. Typed over `unknown`
 * to stay `noUncheckedIndexedAccess`-safe with no index assumptions.
 */
export function scanArgs(args: Record<string, unknown>): string[] {
  const kinds: string[] = [];
  const add = (found: string[]) => {
    for (const k of found) if (!kinds.includes(k)) kinds.push(k);
  };
  const walk = (v: unknown, depth: number): void => {
    if (typeof v === "string") {
      add(scanSecrets(v));
      return;
    }
    // Depth bound (matches provenance's MAX_SCAN_DEPTH): a hostile deeply-nested
    // arg must not blow the stack — that would throw and the fail-open catch would
    // then skip the scan, letting a co-located secret through unscanned.
    if (depth <= 0) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth - 1);
    } else if (v !== null && typeof v === "object") {
      for (const item of Object.values(v)) walk(item, depth - 1);
    }
    // numbers/booleans/null/undefined carry no secret string
  };
  walk(args, MAX_SCAN_DEPTH);
  return kinds;
}

export default function activate(e: ExtensionAPI): () => void {
  const cfg = () => ({
    // On by default (unlike risk-guard), killable via the env var.
    enabled: e.config.enabled("secret-guard", { default: true, store: e.store }),
    mode: (e.store.get<Mode>("mode", "ask") ?? "ask") as Mode,
    leakCaps: e.store.get<string[]>("leakCaps", DEFAULT_LEAK_CAPS) ?? DEFAULT_LEAK_CAPS,
  });

  /** The capabilities a registered tool declares (the flow-guard/risk-guard pattern). */
  const capsOf = (name: string): string[] => e.agent.tools.get(name)?.capabilities ?? [];

  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    try {
      const { enabled, mode, leakCaps } = cfg();
      // Passthrough when off; never un-block an already-blocked decision.
      if (!enabled || decision.block) return decision;
      // Out-of-scope (non-leak-capable) tools pass with no scan, no confirm.
      if (!capsOf(ctx.call.name).some((c) => leakCaps.includes(c))) return decision;

      const kinds = scanArgs(ctx.call.arguments);
      if (kinds.length === 0) return decision; // no secret → no prompt, no block

      // Reason built from KIND labels only — never the value.
      const why = `secret-guard: a ${kinds.join(", ")} value is about to be sent via ${ctx.call.name}`;
      if (mode === "block") return { ...decision, block: true, reason: why };

      const allow = await e.agent.ui.confirm(`${why}. Allow?`);
      return allow ? decision : { ...decision, block: true, reason: `secret-guard: denied — ${why}` };
    } catch (err) {
      // Fail open: a guard fault must never brick a legitimate call.
      e.log.warn("secret-guard: scan failed; allowing", ctx.call.name, err);
      return decision;
    }
  });

  const offCmd = e.registerCommand({
    name: "secret-guard",
    description: "Keep secret values out of tool args. Usage: /secret-guard [on|off|ask|block|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("secret-guard on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("secret-guard off");
          break;
        case "ask":
        case "block":
          e.store.set("mode", arg);
          c.print(`secret-guard mode = ${arg}`);
          break;
        default: {
          const { enabled, mode, leakCaps } = cfg();
          c.print(`secret-guard ${enabled ? "on" : "off"} (mode=${mode}); leakCaps=${leakCaps.join(",")}`);
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
