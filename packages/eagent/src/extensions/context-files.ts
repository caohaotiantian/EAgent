/**
 * Project context files — AGENTS.md / CLAUDE.md discovery.
 *
 * This is the agent equivalent of Emacs's `.dir-locals.el`: per-project
 * instructions that live in the tree alongside the code, discovered by walking
 * up from a base directory until the home directory or filesystem root. The
 * conventional names — `AGENTS.md`, `CLAUDE.md`, `.eagent/context.md` — let a
 * repository tell the agent how it wants to be worked on without any global
 * configuration.
 *
 * Disclosure is progressive in the cheap sense: discovery is a single filesystem
 * walk whose discovery result (the parsed files) is cached, so the tree is not re-walked every turn,
 * and the total injected size is capped so per-turn cost stays bounded. Each
 * ancestor directory contributes at most one file (the highest-priority name
 * present there), and the blocks are ordered from the root-most ancestor down to
 * the nearest directory, so the most specific instructions sit closest to the
 * user turn — nearest wins by recency.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.ts";
import type { Message } from "../kernel/types.ts";

/** Context filenames searched in each directory, highest priority first. */
const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md", join(".eagent", "context.md")];

/** Upper bound on the total bytes injected, to keep per-turn cost bounded. */
const MAX_TOTAL_BYTES = 32 * 1024;

/** A single discovered context file. */
interface ContextFile {
  /** Absolute path to the file. */
  path: string;
  /** Path shown to the user/model, relative to the base directory. */
  display: string;
  /** UTF-8 contents (never truncated; whole files are dropped to respect the size cap). */
  content: string;
  /** Byte size of the contents as injected. */
  bytes: number;
}

export default function activate(e: ExtensionAPI): void {
  // The discovery result is cached so the filesystem is walked at most once per
  // base directory until something explicitly invalidates it.
  let cache: ContextFile[] | undefined;

  /** Resolve the base directory: store override, then env, then cwd. */
  const baseDir = (): string => {
    const override = e.store.get<string>("baseDir");
    const dir = override ?? e.config.string("workspace") ?? process.cwd();
    return resolve(dir);
  };

  /** Discover (and cache) the context files for the current base directory. */
  const discover = (): ContextFile[] => {
    if (cache) return cache;
    cache = walkUp(baseDir());
    return cache;
  };

  /** Forget the cached result so the next access re-walks the tree. */
  const invalidate = (): void => {
    cache = undefined;
  };

  // Inject the collected context as one system message before each LLM call.
  // Never throws: a discovery failure degrades to injecting nothing.
  e.hook("transformContext", (messages) => {
    let files: ContextFile[];
    try {
      files = discover();
    } catch (err) {
      e.log.warn("context discovery failed:", err);
      return messages;
    }
    if (files.length === 0) return messages;

    const body = [
      "Project context (from AGENTS.md / CLAUDE.md):",
      ...files.map((f) => `### ${f.display}\n${f.content}`),
    ].join("\n\n");

    const note: Message = {
      role: "system",
      content: [{ type: "text", text: body }],
      meta: { source: "context-files", ephemeral: true },
    };
    return [note, ...messages];
  });

  // List the discovered files and their sizes.
  e.registerCommand({
    name: "context",
    description: "List the project context files (AGENTS.md / CLAUDE.md) in effect.",
    run: (ctx) => {
      let files: ContextFile[];
      try {
        files = discover();
      } catch (err) {
        ctx.print(`(discovery failed: ${(err as Error).message})`);
        return;
      }
      if (files.length === 0) {
        ctx.print("(none found)");
        return;
      }
      for (const f of files) ctx.print(`  ${f.display}  (${f.bytes} bytes)`);
    },
  });

  // Drop the cache and re-discover, reporting what was found.
  e.registerCommand({
    name: "context-reload",
    description: "Re-scan the tree for project context files and report what changed.",
    run: (ctx) => {
      invalidate();
      let files: ContextFile[];
      try {
        files = discover();
      } catch (err) {
        ctx.print(`(discovery failed: ${(err as Error).message})`);
        return;
      }
      if (files.length === 0) {
        ctx.print("(none found)");
        return;
      }
      ctx.print(`Reloaded ${files.length} context file(s):`);
      for (const f of files) ctx.print(`  ${f.display}  (${f.bytes} bytes)`);
    },
  });
}

/**
 * Walk from `base` up to the filesystem root (or the home directory), collecting
 * the highest-priority context file present in each ancestor directory. The
 * returned list is ordered root-most first so that, when injected, the nearest
 * directory's instructions appear last. Unreadable files and directories are
 * skipped; the total size is capped at `MAX_TOTAL_BYTES`.
 */
function walkUp(base: string): ContextFile[] {
  const home = resolve(homedir());
  const collected: ContextFile[] = [];

  let dir = base;
  // Bound the walk both by reaching the root (parent === dir) and by the home
  // directory acting as a natural stop above the user's projects.
  for (;;) {
    const found = firstInDir(dir, base);
    if (found) collected.push(found);

    if (dir === home) break;
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  // `collected` is nearest-first from the walk; reverse so the root-most file
  // leads and the most specific (nearest) file trails the injected block.
  collected.reverse();

  // Apply the total-size cap, keeping the trailing (nearest, most specific)
  // entries when something must be dropped.
  return capTotal(collected, MAX_TOTAL_BYTES);
}

/** Return the highest-priority context file present in `dir`, if any. */
function firstInDir(dir: string, base: string): ContextFile | undefined {
  for (const name of CONTEXT_FILENAMES) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
      const content = readFileSync(path, "utf8");
      const rel = relative(base, path);
      return {
        path,
        display: rel === "" ? name : rel,
        content,
        bytes: Buffer.byteLength(content, "utf8"),
      };
    } catch {
      // Missing, unreadable, or not a regular file — try the next name.
    }
  }
  return undefined;
}

/**
 * Enforce a total byte budget across the ordered list. Because the most specific
 * files sit at the tail, the budget is filled from the tail backwards and the
 * surviving entries are returned in their original (root-most-first) order.
 */
function capTotal(files: ContextFile[], limit: number): ContextFile[] {
  const kept: ContextFile[] = [];
  let used = 0;
  for (let i = files.length - 1; i >= 0; i--) {
    const f = files[i]!;
    if (used + f.bytes > limit) break;
    used += f.bytes;
    kept.unshift(f);
  }
  return kept;
}
