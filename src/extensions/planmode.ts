/**
 * Plan mode — a human-in-the-loop approval gate over tool execution.
 *
 * This is the Emacs "advice" / interception pattern applied to the agent loop:
 * we wrap the kernel's `beforeToolCall` seam to insert an approval checkpoint
 * around every *mutating* tool, without touching the tools themselves. The
 * tools stay oblivious; policy lives entirely here, in an extension. (pi ships
 * plan mode as an extension too — the loop stays neutral, the gate is swappable.)
 *
 * When plan mode is ON, any tool whose effects reach beyond the conversation —
 * writing files, running shells, fetching the network, spawning agents — must
 * be approved by the human before it runs. Read-only tools (the core `read`
 * tool, plus cross-extension examples like `recall`/`now` that may not be
 * loaded) pass through untouched, so the agent can still look around freely
 * while every irreversible step waits for a yes.
 *
 * State is a single `enabled` boolean in the extension store, defaulting to OFF
 * and read fresh on every call so a `/plan` toggle takes effect immediately.
 */

import type { ExtensionAPI } from "../kernel/extension.js";

/** Store key for the plan-mode on/off flag. Exported so a front end can read the
 *  current mode; the flag is already store-backed, so no accessor is needed. */
export const ENABLED_KEY = "enabled";

/**
 * The policy knob. A tool is treated as mutating if it declares any of these
 * capabilities. This is the primary signal — capabilities are the kernel's own
 * vocabulary for "this reaches outside the conversation". Edit this set to widen
 * or narrow what plan mode gates.
 */
const MUTATING_CAPABILITIES = new Set<string>([
  "fs:write",
  "shell:exec",
  "code:exec",
  "net:fetch",
  "skill:write",
  "mcp:call",
  "agent:spawn",
  "pkg:install",
]);

/**
 * A small backstop denylist of obviously-mutating tool *names*, for tools that
 * (for whatever reason) ship without declared capabilities. Also part of the
 * policy knob — keep it short and obvious.
 */
const MUTATING_NAMES = new Set<string>(["write", "edit", "bash"]);

export default function activate(e: ExtensionAPI): void {
  const isEnabled = (): boolean => e.store.get<boolean>(ENABLED_KEY, false) ?? false;

  /** Decide whether a tool call mutates state and therefore needs approval. */
  const isMutating = (name: string): boolean => {
    if (MUTATING_NAMES.has(name)) return true;
    const caps = e.agent.tools.get(name)?.capabilities ?? [];
    return caps.some((c) => MUTATING_CAPABILITIES.has(c));
  };

  e.hook("beforeToolCall", async (decision, ctx) => {
    // OFF: never interfere. Read the flag fresh so toggling is immediate.
    if (!isEnabled()) return decision;
    // Another guard already vetoed this call; don't second-guess it.
    if (decision.block) return decision;

    const { name, arguments: args } = ctx.call;
    if (!isMutating(name)) return decision;

    const approved = await e.agent.ui.confirm(
      `Plan mode: allow ${name} to run? ${compactArgs(args)}`,
    );
    if (approved) return decision;
    return { ...decision, block: true, reason: "rejected in plan mode" };
  });

  e.registerCommand({
    name: "plan",
    description: "Toggle plan mode (human approval gate for mutating tools). Usage: /plan [on|off]",
    run({ args, print }) {
      const arg = args.trim().toLowerCase();
      let next: boolean;
      if (arg === "on") next = true;
      else if (arg === "off") next = false;
      else if (arg === "" ) next = !isEnabled();
      else {
        print(`plan: unknown argument "${arg}" (use "on", "off", or no argument to toggle)`);
        return;
      }
      e.store.set(ENABLED_KEY, next);
      print(`Plan mode is now ${next ? "ON" : "OFF"}.`);
    },
  });

  e.on("session_start", () => {
    e.log.info(`plan mode ${isEnabled() ? "active" : "inactive"}`);
  });
}

/** Render a tool's arguments as a short single line for the approval prompt. */
function compactArgs(args: Record<string, unknown>): string {
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = "{...}";
  }
  return json.length > 120 ? `${json.slice(0, 117)}...` : json;
}
