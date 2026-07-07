/**
 * ask — agent→host elicitation (`ask_user_question`).
 *
 * EAgent already lets the human inject into a running agent (`steer`/`followUp`
 * on the `AgentHandle`). There is no inverse: the model cannot pause, surface a
 * concrete "which of these did you mean?" question to the human, and block on
 * the answer before committing to a direction. The only human-facing primitive
 * is a yes/no `confirm` plus a fire-and-forget `notify` — neither can collect a
 * free-form or multiple-choice answer *before* the model chooses. So on an
 * ambiguous instruction the model guesses, and a wrong guess is the single most
 * expensive failure mode in agentic work.
 *
 * This extension closes that gap with the minimum surface: an `ask_user_question`
 * tool, gated behind a trivial `ui:ask` capability, that calls the host's
 * `ctx.ui.ask(...)` when present. It lives exactly where `confirm` lives — in the
 * host's `UI` implementation, reached via `ctx.ui` — so there is *no* agent-loop
 * change.
 *
 * Two paths keep a non-interactive run from hanging:
 *   1. The grant is CONDITIONAL — `ui:ask` is granted only when the host UI can
 *      actually elicit (`typeof api.agent.ui.ask === "function"`). An interactive
 *      run is therefore not double-prompted (capability prompt *then* the
 *      question); a non-interactive run leaves the capability ungranted, so a
 *      `fallback: "deny"` / deny pattern auto-declines through the capability
 *      layer — the tool body never runs, nothing blocks on stdin.
 *   2. When the policy *allows* `ui:ask` but the UI still cannot elicit (no `ask`
 *      method, or `ask` resolves null/empty), the tool returns a non-error
 *      "proceed with a stated assumption" result so the run degrades gracefully
 *      instead of dead-ending.
 *
 * On by default, with an `EAGENT_ASK=off` kill switch, a dispose loop that never
 * throws, and no filesystem/shell/network side effect of its own (the side
 * effect — blocking a human — is gated by `ui:ask`).
 */

import { defineTool, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";

/**
 * The model-legible contract for "no human is reachable in this run". A fixed
 * string constant (a non-behavioral format choice): it is a NON-error result so
 * the model keeps making forward progress under ambiguity — picking the most
 * reasonable interpretation, stating it, and continuing — rather than treating a
 * `fail(...)` as something to retry (which would invite the `recovery` extension
 * and the model's own retry reflex to re-issue the broken call).
 */
export const NO_HUMAN =
  "No human is available to answer in this run. Proceed by stating the most " +
  "reasonable assumption explicitly and continuing.";

export default function activate(e: ExtensionAPI): () => void {
  // Kill switch first — before any registration (mirror recovery.ts).
  if (!e.config.enabled("ask", { default: true })) return () => {};

  // Conditional grant: pre-allow ui:ask ONLY when the host UI can actually
  // elicit, so an interactive run is not double-prompted while a non-interactive
  // run leaves the capability ungranted (so a `fallback: "deny"` / deny pattern
  // can still auto-decline). An unconditional grant would make `fallback: "deny"`
  // un-deniable (a grant short-circuits `require` to ALLOW before the deny
  // fallback). Read the agent's live UI via `e.agent.ui`.
  if (typeof e.agent.ui.ask === "function") e.grantCapability("ui:ask");

  const offTool = e.registerTool(
    defineTool({
      name: "ask_user_question",
      description:
        "Pause and ask the human a clarifying question before choosing a direction; " +
        "supply options for multiple-choice. Use it when the instruction is ambiguous " +
        "rather than guessing.",
      capabilities: ["ui:ask"],
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question"],
      },
      execute: async (args, ctx) => {
        const question = typeof args.question === "string" ? args.question : "";
        const options = Array.isArray(args.options)
          ? args.options.filter((o): o is string => typeof o === "string")
          : undefined;

        // When the host can elicit, await the human's answer; when it
        // cannot — or when the answer is null/empty — take the absence-fallback.
        if (typeof ctx.ui.ask === "function") {
          const answer = await ctx.ui.ask(question, options);
          if (answer !== null && answer.length > 0) return ok(`Answer: ${answer}`);
        }
        return ok(NO_HUMAN);
      },
    }),
  );

  return () => {
    for (const d of [offTool]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
