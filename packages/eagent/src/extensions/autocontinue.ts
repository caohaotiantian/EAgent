/**
 * autocontinue — resume an answer that was cut off at the output-token cap.
 *
 * When the model's output hits the per-request token ceiling, the provider
 * reports `max_tokens` and the agent loop's no-tool-call branch adopts that
 * reason and stops — leaving the user with a silently truncated final answer.
 * This extension observes the assistant `message` event (which carries the
 * turn's `stopReason`, and fires BEFORE the loop decides to stop); when a turn
 * ends on `max_tokens` with NO tool call, it injects a short "continue"
 * follow-up via the acting agent's `followUp()`, so the loop's existing
 * `#followUps` drain resumes the run instead of breaking. A truncated turn that
 * carries a tool call is left alone — the tool-call path already continues the
 * loop, and double-driving it would be wrong.
 *
 * Because it actively spends extra tokens/turns when it fires, it ships OFF
 * (opt-in): enable with `/autocontinue on` (a store flag, re-read live) and
 * hard-disable with `EAGENT_AUTOCONTINUE=off`. Continuations are capped at
 * `CAP` per acting agent per top-level run — the count is keyed on the acting
 * agent and reset on `agent_start` (which fires once per top-level run and is
 * suppressed for sub-agents), so it is per-run, not per-session, and a chatty
 * sub-agent cannot deplete the primary answer's budget. On reaching the cap it
 * stops injecting; the loop ends `max_tokens` and the CLI surfaces it.
 *
 * It declares no capability — it performs no filesystem/network/shell side
 * effect, only a message injection (matching `watchdog`/`recovery`).
 */

import type { Agent } from "../kernel/agent.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";
import { text } from "../kernel/types.ts";

/** Max continuations per acting agent per top-level run (bounds token spend). */
export const CAP = 3;

/** The follow-up injected to resume a truncated turn (provider-neutral, honest). */
export const NUDGE =
  "Your previous response was cut off at the output token limit. Continue from exactly " +
  "where you stopped, without repeating anything you already wrote.";

export default function activate(e: ExtensionAPI): () => void {
  // Continuation count keyed on the ACTING agent, reset on `agent_start` so it is
  // per-run (not per-session): the REPL reuses one root Agent across turns, so an
  // unreset counter would silently become per-session. A fresh sub-agent Agent
  // starts at 0 via a WeakMap miss.
  const byAgent = new WeakMap<Agent, number>();

  const offStart = e.on("agent_start", () => {
    byAgent.set(e.agent, 0);
  });

  const offMessage = e.on("message", ({ message, stopReason }) => {
    // Re-read the enable flag live so `/autocontinue on` and the kill switch both
    // take effect without a reload (env "off" > store flag > default false).
    if (!e.config.enabled("autocontinue", { default: false, store: e.store })) return;
    // Only the assistant's own truncated, tool-less turn qualifies. A tool_call
    // block means the loop already continues via the tool-call path — injecting
    // here would double-drive it.
    if (message.role !== "assistant" || stopReason !== "max_tokens") return;
    if (message.content.some((b) => b.type === "tool_call")) return;

    const agent = e.agent;
    const count = byAgent.get(agent) ?? 0;
    if (count >= CAP) return; // cap reached: let the loop stop; the CLI surfaces it
    byAgent.set(agent, count + 1);
    agent.handle.followUp(text("user", NUDGE));
  });

  const offCmd = e.registerCommand({
    name: "autocontinue",
    description: "Resume answers truncated at the token cap. Usage: /autocontinue [on|off|status]",
    run: (c) => {
      const arg = c.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          c.print("autocontinue on");
          break;
        case "off":
          e.store.set("enabled", false);
          c.print("autocontinue off");
          break;
        default: {
          const enabled = e.config.enabled("autocontinue", { default: false, store: e.store });
          c.print(`autocontinue ${enabled ? "on" : "off"}`);
          c.print(`cap ${CAP} continuations per run`);
        }
      }
    },
  });

  return () => {
    for (const d of [offStart, offMessage, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
