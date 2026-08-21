/**
 * sandbox — shared OS-launcher confinement helpers.
 *
 * The launcher core both the shell tier (`sandbox-tiers`) and the code tier
 * (`codeact`) build on, kept in one place so the security-critical string logic
 * is written and tested once. Pure and stateless: `wrapCommand`/`detectBackend`/
 * `shquote`/`isWrapped` are pure, `workspaceRoot` reads `process.env`/`cwd`, and
 * `binExists` does a non-throwing PATH lookup — none holds module state, and the
 * lib imports no `ExtensionAPI`, so it never couples to an extension or risks a
 * circular import. The stateful machinery (backend memoization, the hooks, the
 * commands) lives in each consumer's `activate()`.
 */

import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import type { Config } from "../../kernel/store.ts";

export type Backend = "sandbox-exec" | "bwrap" | "firejail" | "none";
export type Tier = "off" | "readonly" | "workspace-write" | "no-network";

/** The tiers an operator may select, for command validation. */
export const TIERS: readonly Tier[] = ["off", "readonly", "workspace-write", "no-network"];

/** The launcher basenames a wrapped command can begin with (idempotency guard). */
export const LAUNCHERS = ["sandbox-exec", "bwrap", "firejail"] as const;

/**
 * The directory shell writes are confined to under the write tiers: computed
 * identically to `core-tools.ts`'s `workspaceRoot()` (the `workspace` config key
 * resolved, else `process.cwd()`) so the writable subpath matches the `bash`
 * tool's `cwd: root` and the `fs:*` confinement the file tools enforce. The
 * resolved config is passed in by the extension caller so this lib reads no env.
 */
export function workspaceRoot(config: Config): string {
  const ws = config.string("workspace");
  return ws ? resolve(ws) : process.cwd();
}

/**
 * Single-quote a string for safe embedding in a `/bin/sh -c '…'` argument: wrap
 * in single quotes and replace each interior `'` with `'\''` (close, escaped
 * quote, reopen). Everything else — `;`, `$()`, `&&`, backticks — is literal
 * inside single quotes, so the wrapped command is reproduced byte-for-byte.
 */
export function shquote(s: string): string {
  return "'" + s.replaceAll("'", "'\\''") + "'";
}

/**
 * Escape a string for embedding inside an SBPL double-quoted literal (e.g. a
 * sandbox-exec `(subpath "…")`). A different grammar from `/bin/sh` single
 * quotes: escape `\` first, then `"`, so a literal backslash isn't re-escaped.
 */
function sbplString(s: string): string {
  return s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/**
 * Pure backend selection: which launcher to use on `platform`, given a presence
 * predicate `has`. macOS prefers `sandbox-exec`; Linux prefers `bwrap`, falling
 * back to `firejail`; every other platform (including `win32`) has no backend.
 */
export function detectBackend(platform: NodeJS.Platform, has: (bin: string) => boolean): Backend {
  if (platform === "darwin") return has("sandbox-exec") ? "sandbox-exec" : "none";
  if (platform === "linux") {
    if (has("bwrap")) return "bwrap";
    if (has("firejail")) return "firejail";
    return "none";
  }
  return "none";
}

/** Recognized backend identifiers, for validating a forced override. */
const BACKENDS: readonly Backend[] = ["sandbox-exec", "bwrap", "firejail", "none"];
export function isBackend(v: string): v is Backend {
  return (BACKENDS as readonly string[]).includes(v);
}

/** True when `command` already begins with a known launcher (never double-wrap). */
export function isWrapped(command: string): boolean {
  const first = command.trim().split(/\s+/)[0];
  if (first === undefined) return false;
  const slash = first.lastIndexOf("/");
  const base = slash < 0 ? first : first.slice(slash + 1);
  return (LAUNCHERS as readonly string[]).includes(base);
}

/**
 * Wrap `command` in `backend`'s launcher to enforce `tier`. Pure. Returns
 * `command` unchanged when `tier === "off"` or `backend === "none"`. The write
 * tiers (`workspace-write`, `no-network`) make `opts.root` (and the temp dirs)
 * writable; `no-network` additionally denies subprocess network. The inner
 * command is always re-shell'd via `/bin/sh -c <shquote(command)>`, robust to
 * quotes / `$` / `;` in the original.
 */
export function wrapCommand(backend: Backend, tier: Tier, command: string, opts: { root: string }): string {
  if (tier === "off" || backend === "none") return command;

  const writeTier = tier === "workspace-write" || tier === "no-network";
  const noNet = tier === "no-network";
  const root = opts.root;
  const inner = `/bin/sh -c ${shquote(command)}`;

  switch (backend) {
    case "sandbox-exec": {
      // SBPL is last-match-wins: allow-default, deny all writes, then re-allow
      // writes under the workspace + temp subpaths for the write tiers, then
      // deny network for `no-network`.
      let profile = "(version 1)(allow default)(deny file-write*)";
      if (writeTier) {
        profile +=
          `(allow file-write* (subpath "${sbplString(root)}")` +
          ` (subpath "/private/tmp") (subpath "/private/var/folders"))`;
      }
      if (noNet) profile += "(deny network*)";
      return `/usr/bin/sandbox-exec -p ${shquote(profile)} ${inner}`;
    }
    case "bwrap": {
      // `root` is shquoted: the wrapped string is re-parsed by the bash tool's
      // outer `/bin/sh -c`, so a workspace path with a space (e.g. macOS
      // "/Users/me/My Project") would otherwise word-split and mis-bind.
      const parts = ["bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"];
      if (writeTier) parts.push("--bind", shquote(root), shquote(root));
      else parts.push("--ro-bind", shquote(root), shquote(root));
      if (noNet) parts.push("--unshare-net");
      parts.push(inner);
      return parts.join(" ");
    }
    case "firejail": {
      const parts = ["firejail", "--quiet", "--noprofile", "--read-only=/"];
      if (writeTier) parts.push(`--read-write=${shquote(root)}`);
      if (noNet) parts.push("--net=none");
      parts.push(inner);
      return parts.join(" ");
    }
  }
}

/**
 * Non-throwing PATH lookup for `bin`. Checks each `$PATH` entry plus the usual
 * launcher homes (`/usr/bin`, `/bin`, `/usr/local/bin`); never spawns, never
 * touches the network. Used only by the impure probe inside `activate`.
 */
export function binExists(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of [...dirs, "/usr/bin", "/bin", "/usr/local/bin"]) {
    try {
      if (existsSync(join(dir, bin))) return true;
    } catch {
      // ignore an unreadable PATH entry
    }
  }
  return false;
}
