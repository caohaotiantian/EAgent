/**
 * Finding files without a shell.
 *
 * An agent that can read a file it already knows the name of is not much use; the useful
 * question is "which files" and "where does this string occur", and the usual answer is to
 * hand the model a shell and let it run `find` and `rg`. That trade is bad here — `proc.exec`
 * exists but its allowlist is the entire boundary, so reaching a shell to list files
 * dissolves the filesystem jail rather than narrowing it. These do the same work in Node,
 * inside the jail, with no allowlist entry required.
 *
 * VENDORED from EAgent `src/extensions/search.ts` @ tag `eagent-v1` — `globToRegExp` and the
 * traversal — with two changes that are not stylistic:
 *
 *  1. **The deny-list reaches the walk.** EAgent has no notion of one; Loom's jail root
 *     CONTAINS the journal (`cli.ts` passes `deny: [dataDir]`). A traversal that ignores it
 *     hands `.loom/journal.db` to any grep, which is the same hole `BuiltinOptions.deny`
 *     was added to close for `fs.read` — reopened by a different door.
 *  2. **Containment is `assertWithin`, not `resolve` + `relative`.** EAgent's `confine` is
 *     lexical, so an in-workspace symlink escapes it. That it also skips symlinks while
 *     descending mitigates the walk but not the `path` ARGUMENT, which is the half a caller
 *     controls.
 *
 * The traversal is name-sorted, so results are stable across platforms and across runs —
 * `readdir` order is not, and an agent diffing two runs of the same graph would otherwise
 * see phantom changes.
 */

import { type Dirent, readdirSync } from "node:fs";
import { join, relative } from "node:path";

/** Never descended: enormous, uninteresting, and present in almost every workspace. */
const IGNORE_DIRS = new Set([".git", "node_modules"]);

/** `\` → `/`, so a pattern written for POSIX matches on Windows too. */
export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/**
 * Glob → anchored RegExp.
 *
 * `**` spans path segments, `*` and `?` do not, and every other character is escaped so a
 * pattern containing `.` or `(` stays literal. That escaping is the security-relevant line:
 * an unescaped glob is a regex the caller wrote, and a caller who can write a regex against
 * every path in the workspace can spend the walk's whole budget on backtracking.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` means "zero or more path segments", so the slash is consumed with it —
        // otherwise `**/x` fails to match a top-level `x`.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export interface WalkOptions {
  /** Absolute paths whose subtrees are never entered. Compared by prefix, already resolved. */
  readonly deny: readonly string[];
  /** Directory names never descended, beyond the built-in `.git` / `node_modules`. */
  readonly skipDirs?: readonly string[];
}

/**
 * Every regular file under `dir`, as a POSIX path relative to `root`, name-sorted.
 *
 * Symlinks are skipped entirely rather than resolved. Resolving them would need a
 * containment check per entry and would let a link inside the workspace walk the walker
 * out of it; skipping costs the ability to search through a symlinked directory, which is
 * the cheaper loss.
 *
 * Every filesystem call is guarded, so one unreadable directory narrows the results instead
 * of aborting the search. `shouldStop` is checked before each entry so a capped result set
 * stops the walk rather than finishing it and discarding the remainder.
 */
export function walk(
  dir: string,
  root: string,
  opts: WalkOptions,
  onFile: (rel: string, abs: string) => void,
  shouldStop: () => boolean,
): void {
  if (shouldStop()) return;
  if (opts.deny.some((d) => dir === d || dir.startsWith(d + "/"))) return;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const entry of entries) {
    if (shouldStop()) return;
    if (entry.isSymbolicLink()) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (opts.skipDirs?.includes(entry.name) === true) continue;
      walk(abs, root, opts, onFile, shouldStop);
    } else if (entry.isFile()) {
      if (opts.deny.some((d) => abs === d || abs.startsWith(d + "/"))) continue;
      onFile(toPosix(relative(root, abs)), abs);
    }
  }
}
