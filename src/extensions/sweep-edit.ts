/**
 * `sweep-edit` — regex-enumerated multi-site refactor that fans a sub-agent per
 * match.
 *
 * EAgent can edit exactly one file per `edit` call. A cross-tree rename/refactor
 * is therefore N manual `edit` calls the model must orchestrate by hand: grep,
 * read each hit, issue one `edit` per file, track which it has done. That is the
 * mechanical fan-out the model is bad at (it loses count, skips files, burns
 * turns). `sweep_edit` closes that gap with one primitive that composes two
 * mechanisms it must NOT reimplement:
 *
 *   - Enumeration reuses the `search` extension's workspace-confined, pure-Node
 *     `grep` tool (no shell, no second walker, no ripgrep). `sweep_edit` resolves
 *     the registered `grep`, runs it once, and parses its `path:line:text` lines.
 *   - Editing reuses a `subagents`-style constrained child per matched file: a
 *     fresh `Agent` whose registry holds ONLY the parent's `read` + `edit` tools,
 *     so a child literally has no `bash`/net tool to call. Each child reads its
 *     one file and edits it, or declines (false-positive tolerance).
 *
 * The novelty is solely deriving the worklist from a regex over the tree; the
 * searching and the editing are reuse. Per-site isolation means one bad edit is
 * contained to its file and the structured `{file, status, note}` summary tells
 * the model exactly which sites need a follow-up.
 *
 * Capability-gated `fs:write` (the edits) + `agent:spawn` (the children); no new
 * capability string. Kill switch `EAGENT_SWEEP_EDIT=off`. Dispose loop never
 * throws.
 */

import { Agent } from "../kernel/agent.js";
import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import { ToolRegistry } from "../kernel/registry.js";
import type { Disposable, Message, Tool, ToolResultBlock } from "../kernel/types.js";

/** Default cap on the number of files (= children spawned) a single sweep edits. */
export const DEFAULT_MAX_SITES = 50;

/** Safety bound on each site-child's loop iterations (edit in a turn or two, or decline). */
export const DEFAULT_MAX_TURNS = 8;

/** The per-site outcome the tool reports. */
export type SiteStatus = "edited" | "declined" | "error";

export interface SiteResult {
  file: string;
  status: SiteStatus;
  note: string;
}

/**
 * Parse `grep`'s output into a worklist `Map<file, matchedLines[]>`.
 *
 * `grep` emits one `path:line:text` line per match (`search.ts:230`), but two of
 * its output lines are NOT sites and must be skipped defensively:
 *   - the empty-result sentinel `(no matches)` (`search.ts:236`) — no `:line:`;
 *   - the cap trailer `... (truncated at 100 matches; …)` (`search.ts:121-124`)
 *     — no parseable line-number segment.
 * So we split on the first two `:` (path, line-number, rest) and skip any line
 * whose line-number segment is not a positive integer. That drops both the
 * trailer and the `(no matches)` line cleanly.
 */
export function parseGrep(output: string): Map<string, number[]> {
  const sites = new Map<string, number[]>();
  for (const line of output.split("\n")) {
    const first = line.indexOf(":");
    if (first <= 0) continue;
    const second = line.indexOf(":", first + 1);
    if (second < 0) continue;
    const file = line.slice(0, first);
    const lineNo = Number(line.slice(first + 1, second));
    if (!Number.isInteger(lineNo) || lineNo <= 0) continue;
    const acc = sites.get(file);
    if (acc) acc.push(lineNo);
    else sites.set(file, [lineNo]);
  }
  return sites;
}

/** Build a child's tool registry: a fresh registry holding ONLY `read` + `edit`. */
function childRegistry(read: Tool, edit: Tool): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(read);
  registry.register(edit);
  return registry;
}

/** Collect every tool_result block from a child transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/**
 * Classify a child's transcript into a per-site outcome.
 *   - a successful `edit` tool_result → `edited`;
 *   - an `edit` was attempted but every attempt errored → `error` (the failure
 *     text is the note);
 *   - the child produced a final answer but issued no `edit` at all → `declined`.
 */
export function classify(messages: readonly Message[]): { status: SiteStatus; note: string } {
  const results = toolResults(messages);
  const edits = results.filter((r) => /^Edited /.test(r.content));
  if (edits.length > 0) {
    return { status: "edited", note: edits.at(-1)!.content };
  }
  const errored = results.filter((r) => r.isError);
  if (errored.length > 0) {
    return { status: "error", note: errored.at(-1)!.content };
  }
  return { status: "declined", note: lastAssistantText(messages) || "left unchanged" };
}

/** The last assistant message's text, concatenating all of its text blocks. */
function lastAssistantText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    // Concatenate every text block: a model may split its answer across blocks
    // (or emit an empty leading text block before a thinking block), so taking
    // only the first text block can drop the real answer.
    let text = "";
    for (const b of m.content) if (b.type === "text") text += b.text;
    if (text.length > 0) return text;
  }
  return "";
}

const CHILD_SYSTEM_PREFIX =
  "You are a focused sub-agent for one sweep-edit site. You may only read and " +
  "edit a single file. Apply the shared instruction to file=";

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_SWEEP_EDIT === "off") return () => {};

  e.grantCapability("agent:spawn");

  const disposables: Disposable[] = [];

  disposables.push(
    e.registerTool(
      defineTool({
        name: "sweep_edit",
        description:
          "Enumerate every file matching a regex (workspace-confined, via grep) " +
          "and apply one shared natural-language instruction to each by spawning " +
          "a constrained read+edit child per file. A site may decline (false " +
          "positive). Per-site failures are isolated. Breadth is capped by " +
          "maxSites (default 50); a truncated sweep is logged. Returns a JSON " +
          "summary of {file, status, note} per site.",
        capabilities: ["fs:write", "agent:spawn"],
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "JavaScript regular expression enumerating the sites." },
            glob: { type: "string", description: "Optional glob filter (grep's `include`); only matching paths are swept." },
            instruction: { type: "string", description: "Shared natural-language change applied to every matched file." },
            maxSites: {
              type: "integer",
              description: `Cap on files edited (default ${DEFAULT_MAX_SITES}); exceeding it truncates with a logged note.`,
            },
          },
          required: ["pattern", "instruction"],
        },
        execute: async (args, ctx) => {
          const pattern = typeof args.pattern === "string" ? args.pattern : "";
          if (pattern.length === 0) return fail("sweep_edit requires a non-empty `pattern`.");
          const instruction = typeof args.instruction === "string" ? args.instruction : "";
          if (instruction.length === 0) return fail("sweep_edit requires a non-empty `instruction`.");
          const glob = typeof args.glob === "string" ? args.glob : undefined;
          const maxSites =
            typeof args.maxSites === "number" && Number.isInteger(args.maxSites) && args.maxSites > 0
              ? args.maxSites
              : DEFAULT_MAX_SITES;

          // Resolve the composed tools. Absent → clear error, never a fallback walker.
          const grep = e.agent.tools.get("grep");
          if (!grep) return fail("sweep_edit needs the `grep` tool (load the `search` extension).");
          const read = e.agent.tools.get("read");
          if (!read) return fail("sweep_edit needs the `read` tool (load the `core-tools` extension).");
          const edit = e.agent.tools.get("edit");
          if (!edit) return fail("sweep_edit needs the `edit` tool (load the `core-tools` extension).");

          // Enumerate via grep (workspace-confined, pure Node, no shell).
          const grepResult = await grep.execute(
            glob === undefined ? { pattern } : { pattern, include: glob },
            ctx,
          );
          if (grepResult.isError) {
            return fail(`sweep_edit enumeration failed: ${grepResult.content}`);
          }
          const worklist = [...parseGrep(grepResult.content).entries()];

          if (worklist.length === 0) {
            const summary: SweepSummary = { total: 0, edited: 0, declined: 0, errors: 0, truncated: false, sites: [] };
            return ok(render(summary), summary);
          }

          // Cap breadth; never silently — log on truncation.
          const truncated = worklist.length > maxSites;
          const selected = truncated ? worklist.slice(0, maxSites) : worklist;
          if (truncated) {
            e.log.warn(
              `sweep_edit truncated ${worklist.length} matched files to the maxSites cap of ${maxSites}; ` +
                "narrow the pattern/glob or raise maxSites to sweep the rest.",
            );
          }

          // Fan one child per file; sites are independent → run in parallel.
          const sites = await Promise.all(
            selected.map(([file, matchedLines]) =>
              runSite(file, matchedLines, instruction).catch((err) => ({
                file,
                status: "error" as const,
                note: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
              })),
            ),
          );

          const summary: SweepSummary = {
            total: sites.length,
            edited: sites.filter((s) => s.status === "edited").length,
            declined: sites.filter((s) => s.status === "declined").length,
            errors: sites.filter((s) => s.status === "error").length,
            truncated,
            sites,
          };
          return ok(render(summary), summary);

          /** Spawn one constrained child for `file`, returning its classified outcome. */
          async function runSite(file: string, matchedLines: number[], shared: string): Promise<SiteResult> {
            const system =
              `${CHILD_SYSTEM_PREFIX}${file} (matched on line(s) ${matchedLines.join(", ")}). ` +
              "If the change does not apply here (a false positive), make no edit and say so.";
            const child = new Agent({
              providers: e.agent.providers,
              capabilities: e.agent.capabilities,
              ui: e.agent.ui,
              logger: e.agent.logger,
              model: e.agent.model,
              provider: e.agent.providerName,
              systemPrompt: system,
              maxTurns: DEFAULT_MAX_TURNS,
              tools: childRegistry(read!, edit!),
              hooks: e.agent.hooks.childScope(),
            });
            const prompt = `File: ${file}\nMatched line(s): ${matchedLines.join(", ")}\nInstruction: ${shared}`;
            const { messages } = await child.run(prompt);
            const outcome = classify(messages);
            return { file, status: outcome.status, note: outcome.note };
          }
        },
      }),
    ),
  );

  disposables.push(
    e.registerCommand({
      name: "sweeps",
      description: "Explain the sweep_edit contract and the max-sites cap.",
      run: (cmd) => {
        cmd.print("sweep_edit — regex-enumerated multi-site refactor.");
        cmd.print("  Enumerates every file matching `pattern` (+ optional `glob`) via the");
        cmd.print("  workspace-confined grep — no shell, no escape from the workspace root.");
        cmd.print("  Spawns one constrained read+edit child per matched file, applying the");
        cmd.print("  shared `instruction`. A site may decline (false-positive tolerance);");
        cmd.print("  a per-site failure is isolated to that file.");
        cmd.print(`  Breadth is capped at maxSites (default ${DEFAULT_MAX_SITES}); a truncated`);
        cmd.print("  sweep is logged and flagged `truncated: true`. Returns {file, status, note} per site.");
      },
    }),
  );

  return () => {
    for (const d of disposables) {
      try {
        d.dispose();
      } catch {
        // a failing teardown must not block the others
      }
    }
  };
}

interface SweepSummary {
  total: number;
  edited: number;
  declined: number;
  errors: number;
  truncated: boolean;
  sites: SiteResult[];
}

/** Render the structured summary as a header line plus the JSON site array. */
function render(summary: SweepSummary): string {
  return JSON.stringify(summary);
}
