/**
 * write-guard — no blind overwrite of a file the session has not read.
 *
 * The `write` tool overwrites a file's whole contents with no check that the
 * agent has *seen* the file first, so a guessed path or a from-memory
 * regeneration can silently clobber work that was never read. `edit` is safe (it
 * reads then replaces); `write` is the blind-overwrite primitive.
 *
 * This extension rides the `beforeToolCall` filter hook (as `flow-guard` and
 * `bash-policy` do). It records the resolved path of every successful file tool
 * call (`read` / `edit` / `write` — a file you wrote, you know), and when a
 * full-overwrite call targets an *existing* file *not* in that set, it asks the
 * human via `ui.confirm`: a "no" blocks the overwrite, a "yes" lets it through
 * (and the resulting write records the path, so it never re-prompts for it).
 *
 * A full-overwrite call is identified by capability + argument shape — a tool
 * declaring `fs:write` whose arguments carry a string `path` and string
 * `content` but no `old` field — which matches `write` and excludes `edit`. The
 * read-set is in-memory and session-scoped. On by default, no new capability,
 * `EAGENT_WRITE_GUARD=off` kill switch.
 */

import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";

/** The directory file paths resolve against — matches `core-tools`. */
function workspaceRoot(config: Config): string {
  const ws = config.string("workspace");
  return ws ? resolve(ws) : process.cwd();
}

/** Resolve a path argument to an absolute path the same way `core-tools` does. */
function resolvePath(root: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(root, p);
}

/** Does a regular file already exist at this absolute path? */
function fileExists(abs: string): boolean {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Is this a full-overwrite call? A tool declaring `fs:write` whose arguments
 * carry a string `path` and string `content` but no `old` field. That shape is
 * `write`'s and not `edit`'s, so read-then-write tools are excluded.
 */
export function isFullOverwrite(capabilities: string[] | undefined, args: Record<string, unknown>): boolean {
  if (!capabilities?.includes("fs:write")) return false;
  if (typeof args.path !== "string" || typeof args.content !== "string") return false;
  if ("old" in args) return false;
  return true;
}

export default function activate(e: ExtensionAPI): () => void {
  if (!e.config.enabled("write-guard", { default: true })) return () => {};

  const root = workspaceRoot(e.config);
  /** Absolute paths the session has read or written this session. */
  const seen = new Set<string>();

  // Record every successful file tool call's path: reading, editing, or writing
  // a file all count as having "seen" it.
  const offEnd = e.on("tool_end", ({ call, result }) => {
    if (result.isError) return;
    const p = call.arguments.path;
    if (typeof p === "string") seen.add(resolvePath(root, p));
  });

  const offHook = e.hook("beforeToolCall", async (decision, ctx) => {
    if (decision.block) return decision;
    const tool = e.agent.tools.get(ctx.call.name);
    if (!isFullOverwrite(tool?.capabilities, decision.arguments)) return decision;

    const abs = resolvePath(root, decision.arguments.path as string);
    // Only an existing, unread file is at risk of a blind clobber. A new file
    // has nothing to lose; a file already seen this session is known.
    if (!fileExists(abs) || seen.has(abs)) return decision;

    const why = `overwrite "${decision.arguments.path as string}", which has not been read this session`;
    const allow = await e.agent.ui.confirm(`write-guard: allow ${why}?`);
    return allow ? decision : { ...decision, block: true, reason: `write-guard: blocked ${why}` };
  });

  const reset = () => seen.clear();
  const offStart = e.on("session_start", reset);
  const offDown = e.on("session_shutdown", reset);

  return () => {
    for (const d of [offEnd, offHook, offStart, offDown]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
