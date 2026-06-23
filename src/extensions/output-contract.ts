/**
 * output-contract — schema-validated final output via a `respond` tool +
 * validate-and-reask.
 *
 * EAgent validates tool *input* rigorously but has no equivalent for final
 * *output*: a run returns an untyped transcript and every machine consumer
 * scrapes the last assistant text and hopes it parses. This extension closes
 * that asymmetry by reusing the exact input machinery.
 *
 * A caller opts in by setting `agent.outputSchema` before the run. When set, on
 * `agent_start` a `respond` tool is registered whose `parameters` *are* that
 * schema, so the kernel's own input-validation path coerces/validates the
 * model's arguments against it for free (`agent.ts:314`). On a *valid* `respond`
 * the tool records the validated value on `agent.output` and ends the turn
 * (`terminate:true`). On an *invalid* `respond` the kernel refuses before
 * `execute` runs (`agent.ts:327`) — so the reask path lives on the
 * `afterToolCall` filter, not in `execute`: it inspects the kernel's
 * "Invalid arguments for respond" error, steers a reask echoing the validator's
 * *exact* per-field error strings, and bounds retries by `maxOutputRetries`.
 * After the cap it surfaces the best-effort value flagged (`ok:false`) and calls
 * `agent.stop()` to halt the loop (the invalid-arg refusal is non-terminating,
 * so without the explicit stop the run would advance to `maxTurns`).
 *
 * With no `outputSchema` set the extension is fully inert: no `respond` tool, no
 * steer, no reask — byte-identical to today. On-by-default builtin with an
 * `EAGENT_OUTPUT_CONTRACT=off` kill switch. No capability (recording a value the
 * run already produced is not a side effect; mirrors `recovery`).
 *
 * Decode-time forcing (the delivered follow-up, design §9): on the SAME
 * corrective-turn path where it steers a reask, it also sets the public mutable
 * `e.agent.forceTool = "respond"` so the kernel maps it to
 * `CompletionRequest.toolChoice` and the provider COMPELS a `respond` call on
 * the next turn — turning best-effort into near-guaranteed where the provider
 * supports forcing, while a non-forcing provider still converges via the
 * unchanged reask + cap. Forcing is strictly corrective-turn-only: the model's
 * initial working turns are NEVER forced (so a multi-step run is free to call
 * read/grep/etc. before finalizing). `forceTool` is cleared the instant a valid
 * `respond` is accepted, at the retry cap, on `agent_end`, and on teardown — so
 * it never leaks across turns or runs, and the no-schema path never touches it.
 */

import { defineTool } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { type JSONSchema, text, type ToolResult } from "../kernel/types.js";
import { validate } from "../kernel/validate.js";

/**
 * Corrective reask rounds after the initial attempt. 2 ⇒ up to 3 `respond`
 * attempts (initial + 2 reasks). Mirrors the kernel's bounded-loop instinct
 * (`maxTurns`): one reask catches the common missing-field case, a second covers
 * a follow-on miss; beyond that, rounds rarely converge.
 */
const maxOutputRetries = 2;

/**
 * Thin wrapper over the kernel `validate` (`validate.ts:19`), exported as the
 * test / `/respond`-preview seam. The live path does NOT call this to block — the
 * kernel's own input validation already validates `respond` arguments; this only
 * re-shapes the result. Keeping it a pure re-export is what keeps the output
 * coercion byte-identical to the input coercion (one validator, one contract).
 */
export function validateOutput(
  schema: JSONSchema,
  value: unknown,
): { ok: boolean; value: unknown; errors: string[] } {
  const r = validate(schema, value);
  return { ok: r.ok, value: r.value, errors: r.errors };
}

/**
 * Build the terse corrective reask. It re-states the validator's *exact* error
 * strings verbatim (`errors.join("\n- ")`) and asks the model to call `respond`
 * again with corrected fields. Never re-derives or paraphrases the per-field text.
 */
export function buildReask(errors: string[]): string {
  return (
    "Your `respond` call did not match the required output schema:\n- " +
    errors.join("\n- ") +
    "\nCall the `respond` tool again with every required field present and correctly typed."
  );
}

/** The kernel's invalid-arguments refusal prefix for the `respond` tool. */
const INVALID_RESPOND_PREFIX = "Invalid arguments for respond";

/** Extract the per-field error lines the kernel formatted with `\n- `. */
function parseErrorLines(content: string): string[] {
  const nl = content.indexOf("\n- ");
  if (nl === -1) return [];
  return content
    .slice(nl + 3)
    .split("\n- ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_OUTPUT_CONTRACT === "off") return () => {};

  // Per-run state.
  let attempts = 0;
  let respondReg: { dispose(): void } | undefined;

  const disposeRespond = (): void => {
    try {
      respondReg?.dispose();
    } catch {
      // disposing a stale registration must not throw
    }
    respondReg = undefined;
  };

  /**
   * Clear any pending decode-time force. Called the instant a valid `respond` is
   * accepted, at the retry cap, on `agent_end`, and on teardown — so a force set
   * for a corrective turn never leaks into a later turn or a later run, and a
   * run that never opted in never has `forceTool` touched.
   */
  const clearForce = (): void => {
    if (e.agent.forceTool === "respond") e.agent.forceTool = undefined;
  };

  const onStart = e.on("agent_start", () => {
    attempts = 0;
    const schema = e.agent.outputSchema;
    if (!schema) {
      // No opt-in ⇒ fully inert (byte-identical to today). Do NOT touch
      // forceTool: a run without a schema must never see this extension write it.
      return;
    }
    // Opted in: clear any stale force from a prior run so a corrective force can
    // never leak across runs (the listener may outlive a run; agent_end also
    // clears, but reset defensively here too).
    clearForce();

    const respond = defineTool({
      name: "respond",
      description:
        "Return your final answer as the run's typed output. Its arguments must match the required output schema exactly. " +
        "Call this exactly once when you are ready to finish.",
      parameters: schema,
      // This runs ONLY on a valid call — the kernel's input validation passed.
      execute: (args): ToolResult => {
        e.agent.output = { value: args, ok: true };
        // A valid contract satisfies the run; drop any pending force so it never
        // outlives the corrective turn that set it.
        clearForce();
        return { content: "Final output recorded.", terminate: true };
      },
    });
    respondReg = e.registerTool(respond);

    // Nudge the model toward `respond` on the first turn (gated on opt-in).
    e.agent.handle.steer(
      text("user", "When you have the final answer, call the `respond` tool with the required fields."),
    );
  });

  // The reask seam: fires on EVERY dispatched call, valid or refused. On an
  // invalid `respond` the kernel returns its "Invalid arguments for respond"
  // error here (execute never ran), so this — not execute — drives the reask.
  const onAfter = e.hook("afterToolCall", (result, { call }) => {
    if (call.name !== "respond") return result;
    if (!e.agent.outputSchema) return result;
    if (!result.isError || !result.content.startsWith(INVALID_RESPOND_PREFIX)) return result;

    attempts += 1;
    if (attempts <= maxOutputRetries) {
      const errors = parseErrorLines(result.content);
      e.agent.handle.steer(text("user", buildReask(errors)));
      // Corrective turn: compel the model to call `respond` next, so a provider
      // that supports forcing turns the reask from a nudge into a near-guarantee.
      // Set ONLY here (never on the model's initial working turns), so multi-step
      // work before finalizing is unaffected. A non-forcing provider ignores it
      // and still converges via this reask + the cap below. Cleared on a valid
      // accept (execute), at the cap (below), on agent_end, and on teardown.
      e.agent.forceTool = "respond";
      return result;
    }
    // Cap reached: surface the last (invalid-but-best-effort) value, flagged, and
    // halt the loop. The invalid-arg refusal is non-terminating, so without this
    // explicit stop the run would advance turn-by-turn to maxTurns.
    e.agent.output = { value: call.arguments, ok: false };
    // Drop the force before halting so it never outlives the run (e.g. if a host
    // reuses the agent without an intervening agent_start).
    clearForce();
    e.agent.stop();
    return result;
  });

  const onEnd = e.on("agent_end", () => {
    disposeRespond();
    // Restore the model's free choice for the next run: a force must never
    // outlive the run that set it (mirrors routing restoring Agent.model).
    clearForce();
  });

  const cmd = e.registerCommand({
    name: "respond",
    description: "Show the active output schema and the last surfaced output (read-only).",
    run: (c) => {
      const schema = e.agent.outputSchema;
      const out = e.agent.output;
      const lines: string[] = [];
      lines.push(schema ? `output schema: ${JSON.stringify(schema)}` : "no output schema set");
      lines.push(out ? `last output (ok=${out.ok}): ${JSON.stringify(out.value)}` : "no output surfaced yet");
      c.print(lines.join("\n"));
    },
  });

  return () => {
    try {
      onStart.dispose();
      onAfter.dispose();
      onEnd.dispose();
      cmd.dispose();
      disposeRespond();
      // Drop any pending force on unload so a disabled extension leaves no
      // lingering toolChoice for the next run.
      clearForce();
    } catch {
      // teardown must not throw
    }
  };
}
