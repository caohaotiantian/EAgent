/**
 * The `search` extension — two read-only tools, `glob` and `grep`, implemented
 * in pure Node (no ripgrep, no shell). They declare only `fs:read` and run in
 * `parallel` mode, so the agent can search the workspace without acquiring
 * `shell:exec` and without serializing independent searches.
 *
 * Both confine to the workspace root, skip symlinks (so an in-root link cannot
 * escape the root), ignore `.git` and `node_modules` during descent, and cap at
 * 100 results with an early-exit short-circuit.
 */

import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";

/** Maximum results returned by either tool before truncation. */
const RESULT_CAP = 100;

/** Directory names whose subtrees are never descended into. */
const IGNORE_DIRS = new Set([".git", "node_modules"]);

/** The directory searches are confined to: the `workspace` config key or cwd. */
function workspaceRoot(config: Config): string {
  const ws = config.string("workspace");
  return ws ? resolve(ws) : process.cwd();
}

function sep(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * Resolve `p` and assert it stays inside `root`, rejecting `../` escapes and
 * absolute paths that point elsewhere. The boundary check is `sep()`-aware:
 * `relative()` yields OS-native separators, so a hardcoded `"../"` would let
 * `..\foo` slip through on win32.
 */
function confine(root: string, p: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep()}`) || isAbsolute(rel))) {
    throw new Error(`path "${p}" is outside the workspace root (${root})`);
  }
  return abs;
}

/** Normalize an OS path to a POSIX path so patterns are platform-independent. */
function toPosix(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

/**
 * Translate a glob (`*`, `**`, `?`) into an anchored regex matched against a
 * POSIX root-relative path. A leading or embedded `**​/` matches zero or more
 * leading segments (so `**​/*.ts` matches a root-level `a.ts`); `**` matches any
 * span including `/`; `*` matches a run of non-`/`; `?` matches one non-`/`;
 * every other character is matched literally.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**` — consume an optional trailing slash to make leading/embedded
        // `**/` mean "zero or more path segments".
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
      // Escape every regex metacharacter so the glob's literals stay literal.
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Recursively walk `dir`, calling `onFile(posixRelPath)` for every regular file.
 * Directory entries are visited in name-sorted order for a deterministic,
 * platform-stable traversal. Symlinks are skipped entirely, `.git`/`node_modules`
 * are not descended, and the walk stops as soon as `shouldStop()` is true. Each
 * filesystem operation is guarded so one unreadable entry cannot abort the walk.
 */
function walk(dir: string, root: string, onFile: (rel: string) => void, shouldStop: () => boolean): void {
  if (shouldStop()) return;
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
      walk(abs, root, onFile, shouldStop);
    } else if (entry.isFile()) {
      onFile(toPosix(relative(root, abs)));
    }
  }
}

/** Append a truncation marker if the result set was capped. */
function withMarker(lines: string[], capped: boolean, kind: string): string {
  if (!capped) return lines.join("\n");
  return [...lines, `... (truncated at ${RESULT_CAP} ${kind}; narrow the search to see more)`].join("\n");
}

export default function activate(e: ExtensionAPI): () => void {
  const root = workspaceRoot(e.config);

  const disposeGlob = e.registerTool(
    defineTool({
      name: "glob",
      description: "Find files by glob pattern (e.g. src/**/*.ts). Read-only.",
      capabilities: ["fs:read"],
      executionMode: "parallel",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, matched against root-relative POSIX paths." },
          path: { type: "string", description: "Subdirectory to search (default: workspace root)." },
        },
        required: ["pattern"],
      },
      execute: (args) => {
        let base: string;
        try {
          base = confine(root, args.path === undefined ? "." : String(args.path));
        } catch (err) {
          return fail((err as Error).message);
        }
        const re = globToRegExp(String(args.pattern));
        const matches: string[] = [];
        let capped = false;
        walk(
          base,
          root,
          (rel) => {
            if (re.test(rel)) {
              if (matches.length >= RESULT_CAP) {
                capped = true;
                return;
              }
              matches.push(rel);
            }
          },
          () => capped,
        );
        if (matches.length === 0) return ok("(no matches)");
        matches.sort();
        return ok(withMarker(matches, capped, "files"));
      },
    }),
  );

  const disposeGrep = e.registerTool(
    defineTool({
      name: "grep",
      description: "Search file contents by JS regex; returns path:line:text. Read-only.",
      capabilities: ["fs:read"],
      executionMode: "parallel",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "JavaScript regular expression." },
          path: { type: "string", description: "Subdirectory to search (default: workspace root)." },
          include: { type: "string", description: "Glob filter; only matching file paths are searched." },
        },
        required: ["pattern"],
      },
      execute: (args) => {
        let base: string;
        try {
          base = confine(root, args.path === undefined ? "." : String(args.path));
        } catch (err) {
          return fail((err as Error).message);
        }
        let re: RegExp;
        try {
          re = new RegExp(String(args.pattern));
        } catch (err) {
          return fail(`invalid regex: ${(err as Error).message}`);
        }
        const includeRe = args.include === undefined ? undefined : globToRegExp(String(args.include));
        const results: string[] = [];
        let capped = false;
        walk(
          base,
          root,
          (rel) => {
            if (includeRe && !includeRe.test(rel)) return;
            const abs = join(root, rel);
            let raw: Buffer;
            try {
              raw = readFileSync(abs);
            } catch {
              return;
            }
            // Binary guard: scan the first ~8KB for a NUL byte before decoding.
            const sniff = raw.subarray(0, Math.min(raw.length, 8 * 1024));
            if (sniff.includes(0)) return;
            const text = raw.toString("utf8");
            const lines = text.split("\n");
            for (let n = 0; n < lines.length; n++) {
              const line = lines[n]!;
              if (re.test(line)) {
                if (results.length >= RESULT_CAP) {
                  capped = true;
                  return;
                }
                results.push(`${rel}:${n + 1}:${line}`);
              }
            }
          },
          () => capped,
        );
        if (results.length === 0) return ok("(no matches)");
        return ok(withMarker(results, capped, "matches"));
      },
    }),
  );

  return () => {
    disposeGlob.dispose();
    disposeGrep.dispose();
  };
}
