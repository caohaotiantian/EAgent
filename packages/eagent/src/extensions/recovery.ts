/**
 * recovery — turn failed tool results into corrective nudges.
 *
 * When a tool call fails, EAgent returns the raw error string and nothing else,
 * and the model's common reflex is to re-issue the same broken call: an `edit`
 * whose `old` text is not found, an `edit` that matches in several places, a
 * call whose arguments miss the schema, a path that escapes the workspace. Each
 * wasted retry burns a turn (and, live, tokens and latency) on a mistake whose
 * correction is mechanical and known.
 *
 * This extension rides the `afterToolCall` filter hook — which transforms a tool
 * result before it is appended to the transcript — and, for *failed* results
 * only (`isError === true`), appends one terse corrective hint keyed to
 * EAgent's own error strings. It is a pure post-processing nudge: no model call,
 * no blocking, no state, no capability. The same `prune`-style posture applies —
 * on by default, with an `EAGENT_RECOVERY=off` kill switch.
 *
 * Scoping to `isError` results (rather than scanning every tool's output and
 * maintaining a per-tool exclusion list) is the deliberate simplification over
 * the upstream projects this idea is digested from: a successful `read` whose
 * contents happen to contain the words "Text not found" is never touched.
 */

import type { ExtensionAPI } from "../kernel/extension.ts";
import type { ToolResult } from "../kernel/types.ts";

/** A failure-signature → corrective-instruction pair. */
export interface RecoveryRule {
  match: RegExp;
  hint: string;
}

/** The sentinel that marks an already-annotated result (idempotency guard). */
const MARKER = "Recovery hint:";

/**
 * The default ruleset, each rule anchored to a verified EAgent error string
 * (see `core-tools.ts` and `agent.ts`). Ordered: the first match wins, so the
 * most specific failure modes are listed before broader ones. The list is a
 * fixed constant — there is no user-configurable ruleset in this extension.
 */
export const RECOVERY_RULES: readonly RecoveryRule[] = [
  {
    match: /Text not found in /,
    hint:
      "re-read the file with the read tool and copy the exact text to replace — " +
      "including its indentation and enough surrounding lines that the `old` string occurs verbatim.",
  },
  {
    match: /appears \d+ times|matches multiple places/,
    hint:
      "add more surrounding context to the `old` text so it occurs exactly once, " +
      "or pass replaceAll: true to replace every occurrence.",
  },
  {
    match: /much larger than the text to replace/,
    hint: "re-read the file and provide the exact, minimal text to replace rather than a large block.",
  },
  {
    match: /Invalid arguments for /,
    hint:
      "fix the arguments to match the tool's parameter schema: include every required field and use the correct types.",
  },
  {
    match: /is outside the workspace root/,
    hint:
      "use a path inside the workspace root; paths above the project directory and unrelated absolute paths are refused.",
  },
  {
    match: /Unknown tool: /,
    hint: "call one of the registered tools — check the exact tool name (the /tools command lists them).",
  },
];

/**
 * The hint of the first rule whose pattern matches `content`, or `null` if none
 * match. Pure and side-effect-free (a sequence of `RegExp.test` lookups).
 */
export function recoveryHint(content: string): string | null {
  for (const rule of RECOVERY_RULES) {
    if (rule.match.test(content)) return rule.hint;
  }
  return null;
}

/**
 * The guard transform: append one corrective hint to a *failed* result whose
 * content matches a rule and is not already annotated. This is the exact logic
 * the `afterToolCall` hook applies — exported as a pure function so its
 * idempotency and `isError` gating are directly unit-testable. Returns the
 * result unchanged when it is not an error, is already marked, or matches no
 * rule.
 */
export function annotate(result: ToolResult): ToolResult {
  if (!result.isError) return result;
  if (result.content.includes(MARKER)) return result;
  const hint = recoveryHint(result.content);
  if (!hint) return result;
  return { ...result, content: `${result.content}\n\n${MARKER} ${hint}` };
}

export default function activate(e: ExtensionAPI): () => void {
  if (!e.config.enabled("recovery", { default: true })) return () => {};

  const off = e.hook("afterToolCall", (result) => annotate(result));

  return () => {
    try {
      off.dispose();
    } catch {
      // teardown must not throw
    }
  };
}
