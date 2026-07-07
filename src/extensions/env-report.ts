/**
 * env-report — classify *environmental* failures and suppress the retry-nudge.
 *
 * `recovery` turns a failed tool result into a corrective retry-nudge. That is
 * right for *self-inflicted* errors — an `edit` whose `old` text is absent, a
 * schema-invalid argument set — where the same call, corrected, makes progress.
 * It is exactly wrong for *environmental* faults: a missing `ANTHROPIC_API_KEY`,
 * a binary that is not installed, a DNS/connection failure, a permission denial.
 * Re-issuing the identical call there loops until the budget drains. The
 * environment is broken, not the call.
 *
 * This extension is the deliberate inverse of `recovery` on the same
 * `afterToolCall` filter hook. It:
 *   1. classifies a *failed* result against a small, conservative regex set
 *      scoped to clearly-environmental OS/runtime error vocabulary (auth,
 *      missing-binary, network, permission);
 *   2. surfaces an `environment_issue` signal via `e.log.warn`, so an
 *      environmental blocker is never silently absorbed;
 *   3. suppresses the retry-nudge for env-class errors — registered *after*
 *      `recovery` (filters run in registration order, each receiving the prior
 *      filter's output), it sees any `"Recovery hint:"` recovery appended and,
 *      for an env-class error, replaces it with a "surface to the operator and
 *      route around; do NOT retry" note.
 *
 * Plus an explicit `env_report` tool the model can call to declare a blocker it
 * reasoned about (Devin's `report_environment_issue` path).
 *
 * It rides only `afterToolCall` (observe/annotate) and registers a tool; it
 * never blocks, makes no model call, holds no state, and declares no capability.
 * On by default, with an `EAGENT_ENV_REPORT=off` kill switch. Fail-open: the
 * hook body returns the result unchanged on any internal error.
 */

import type { ExtensionAPI } from "../kernel/extension.js";
import type { ToolResult } from "../kernel/types.js";
import { defineTool, ok } from "../kernel/define.js";

/** The environmental failure classes env-report recognizes. */
export type EnvClass = "auth" | "missing-binary" | "network" | "permission";

/** A class → environmental-failure-signature pair. */
export interface EnvRule {
  class: EnvClass;
  match: RegExp;
}

/**
 * The fixed, conservative ruleset, scoped to clearly-environmental OS/runtime
 * error vocabulary (POSIX `errno` names, Node's `spawn ENOENT`, shell's
 * `command not found`, HTTP 401/403). First match wins. The patterns are
 * deliberately anchored on unambiguous environmental tokens so a borderline
 * string simply gets recovery's normal behavior — the safe default.
 *
 * Note: the `auth` credential pattern has **no** leading `\b` — a leading word
 * boundary would fail on prefixed identifiers like `ANTHROPIC_API_KEY`, since
 * the `_` before `API` is itself a word character, so no boundary exists there.
 */
export const ENV_RULES: readonly EnvRule[] = [
  // auth — credential/key missing or rejected.
  {
    class: "auth",
    match: /(api[ _-]?key|credential|token)\b[^\n]*\b(missing|not set|unset|required|invalid|unauthorized)\b/i,
  },
  { class: "auth", match: /\b401\b|\bunauthorized\b|\bforbidden\b|\b403\b/i },
  { class: "auth", match: /\bauthentication (failed|required)\b/i },
  // missing-binary — absent executable.
  { class: "missing-binary", match: /\bcommand not found\b/i },
  { class: "missing-binary", match: /: not found\b/i },
  { class: "missing-binary", match: /\bno such file or directory\b[^\n]*\b(bin|exec)\b/i },
  { class: "missing-binary", match: /\bENOENT\b[^\n]*\bspawn\b|\bspawn \w+ ENOENT\b/i },
  // network — DNS/connection/network.
  { class: "network", match: /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH)\b/i },
  { class: "network", match: /\b(getaddrinfo|dns) (failed|lookup)\b/i },
  { class: "network", match: /\bnetwork (is )?unreachable\b/i },
  { class: "network", match: /\bconnection (refused|timed out|reset)\b/i },
  // permission — permission denial.
  { class: "permission", match: /\b(EACCES|EPERM)\b/i },
  { class: "permission", match: /\bpermission denied\b/i },
  { class: "permission", match: /\boperation not permitted\b/i },
];

/**
 * The matched environmental class of the first rule whose pattern matches
 * `content`, or `null` if none match. Pure and side-effect-free (a sequence of
 * `RegExp.test` lookups).
 */
export function classifyEnv(content: string): EnvClass | null {
  for (const rule of ENV_RULES) {
    if (rule.match.test(content)) return rule.class;
  }
  return null;
}

/**
 * The route-around note. Pinned by its assertable shape: it matches
 * `/environment issue/i` and `/do NOT retry/i`, and tells the operator to
 * surface the fault and route around the infra. One literal, reused by
 * `annotateEnv` and the `env_report` tool.
 */
export const ENV_NOTE =
  "Environment issue: this failure is the environment, not the call. " +
  "Surface it to the operator and route around the infrastructure (e.g. fall back to CI); " +
  "do NOT retry the same call — re-issuing it cannot repair a broken environment.";

/** The literal marker `recovery` appends ahead of its hint (`recovery.ts:34`). */
const RECOVERY_MARKER = "Recovery hint:";

/**
 * The guard transform: for a *failed env-class* result, strip any recovery
 * retry-nudge and append the route-around note exactly once. Returns the result
 * unchanged when it is not an error, matches no env class, or is already noted.
 * Exported so its gating, idempotency, and replacement are unit-testable without
 * the agent loop. Pure — no logging (the `e.log.warn` surfacing lives in the
 * hook body); never sets `terminate`/`block`.
 *
 * The caller may pass the already-computed `kind` to avoid a second regex sweep
 * (the hook body classifies once for its warn gate); omit it and the transform
 * classifies itself, so the standalone unit contract is unchanged. The `isError`
 * gate runs first, so a success result never classifies on the no-arg path.
 */
export function annotateEnv(result: ToolResult, kind?: EnvClass | null): ToolResult {
  if (!result.isError) return result;
  // `undefined` means "not pre-classified": sweep now. An explicit `null` from
  // the caller is authoritative (a non-env failure) and short-circuits here.
  if ((kind === undefined ? classifyEnv(result.content) : kind) === null) return result;
  // Strip any recovery hint: recovery appends `${content}\n\n${MARKER} ${hint}`,
  // so slice at the literal marker and trim the trailing separator.
  const markerAt = result.content.indexOf(RECOVERY_MARKER);
  const base = (markerAt >= 0 ? result.content.slice(0, markerAt) : result.content).trimEnd();
  // Idempotency: if the base already carries the note, leave it unchanged.
  if (base.includes(ENV_NOTE)) return result;
  return { ...result, content: `${base}\n\n${ENV_NOTE}` };
}

export default function activate(e: ExtensionAPI): () => void {
  if (!e.config.enabled("env-report", { default: true })) return () => {};

  const off = e.hook("afterToolCall", (result) => {
    try {
      // Classify once and thread the verdict into annotateEnv (which would
      // otherwise sweep the same regex set a second time).
      const kind = classifyEnv(result.content);
      const annotated = annotateEnv(result, kind);
      // Only an actually-rewritten env-class failure surfaces the signal.
      if (result.isError && kind !== null) {
        e.log.warn("environment_issue", kind);
      }
      return annotated;
    } catch {
      // fail-open: a classifier bug degrades to "no annotation", never a wedge.
      return result;
    }
  });

  e.registerTool(
    defineTool<{ reason: string }>({
      name: "env_report",
      description:
        "Declare an environment blocker you have diagnosed (e.g. a missing credential or absent tool) " +
        "that no single tool result reveals. Surfaces it to the operator and tells you to route around " +
        "the infrastructure rather than retry the same infra-dependent call.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "A short description of the environment blocker (what is missing or broken).",
          },
        },
        required: ["reason"],
      },
      execute: (args) => {
        const reason = String(args.reason);
        try {
          e.log.warn("environment_issue", reason);
        } catch {
          // surfacing must not fail the tool.
        }
        return ok(`${ENV_NOTE}\n\n${reason}`);
      },
    }),
  );

  return () => {
    try {
      off.dispose();
    } catch {
      // teardown must not throw
    }
  };
}
