/**
 * sandbox-tiers — OS-level confinement tiers for every shell command.
 *
 * The capability layer authorizes the shell as a single coarse capability,
 * `shell:exec`. It can allow, deny, or ask — but it cannot say "run, yet with
 * no network" or "run, yet writable only inside the workspace". This extension
 * adds that confinement as policy, not as a kernel change, and without touching
 * the `bash` tool. It rides the `beforeToolCall` filter — the same seam
 * `bash-policy`/`risk-guard` use — but instead of vetoing or prompting it
 * *rewrites the command argument*, wrapping it in the host's native sandbox
 * launcher (`sandbox-exec` on macOS, `bwrap`/`firejail` on Linux) to enforce a
 * configurable tier. The kernel sanctions this: `ToolDecision.arguments` is "may
 * be rewritten by a guard before execution," and the dispatcher re-validates the
 * rewritten args against the tool schema — the wrapped value is still a string,
 * so it sails through that gate.
 *
 * Tiers (cumulative authority reduction):
 *   - `off`             — pure pass-through; the no-op default.
 *   - `readonly`        — read-only filesystem; network allowed.
 *   - `workspace-write` — writable only under the workspace root (+ temp);
 *                          network allowed.
 *   - `no-network`      — workspace-write, plus subprocess network denied.
 *
 * The wrap is a pure string transform (`wrapCommand`), so the entire tier/policy
 * surface is offline-testable. The single impure part — detecting which launcher
 * binary exists — is isolated behind an injectable probe (`detectBackend` is
 * pure; `binExists` does a non-throwing PATH lookup), and a forced-backend
 * override (`forceBackend` store key / `EAGENT_SANDBOX_BACKEND`) lets tests and
 * operators pin a backend regardless of the host OS, so CI never depends on a
 * real OS sandbox.
 *
 * It ships loaded but inert: default tier `off` means a pure pass-through, the
 * same "loaded, no-op until tuned" stance as `bash-policy`. Opt into confinement
 * with `/sandbox-tiers tier workspace-write`; hard-disable with
 * `EAGENT_SANDBOX_TIERS=off`.
 *
 * Known caveats, documented honestly:
 *   - `no-network` confines only *subprocess* network spawned via `shell:exec`.
 *     It does NOT stop in-process `net:fetch` tools (e.g. the `web` extension
 *     calls global `fetch` in-process, never a subprocess) — those are out of a
 *     process sandbox's reach by construction.
 *   - `sandbox-exec` is Apple-deprecated but still present and functional on
 *     current macOS; acceptable for a best-effort hardening layer.
 *   - Signal/timeout delivery to sandboxed grandchildren is best-effort: `bwrap`
 *     forwards signals to the child; `sandbox-exec` runs in the process group.
 */

import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";

export type Backend = "sandbox-exec" | "bwrap" | "firejail" | "none";
export type Tier = "off" | "readonly" | "workspace-write" | "no-network";

/** The tiers an operator may select, for command validation. */
export const TIERS: readonly Tier[] = ["off", "readonly", "workspace-write", "no-network"];

/** The launcher basenames a wrapped command can begin with (idempotency guard). */
const LAUNCHERS = ["sandbox-exec", "bwrap", "firejail"] as const;

/**
 * The directory shell writes are confined to under the write tiers: computed
 * identically to `core-tools.ts`'s `workspaceRoot()` (`$EAGENT_WORKSPACE`
 * resolved, else `process.cwd()`) so the writable subpath matches the `bash`
 * tool's `cwd: root` and the `fs:*` confinement the file tools enforce.
 */
export function workspaceRoot(): string {
  return process.env.EAGENT_WORKSPACE ? resolve(process.env.EAGENT_WORKSPACE) : process.cwd();
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
function isBackend(v: string): v is Backend {
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
          `(allow file-write* (subpath "${root}")` +
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
function binExists(bin: string): boolean {
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

export default function activate(e: ExtensionAPI): () => void {
  const cfg = (): {
    enabled: boolean;
    tier: Tier;
    missingBackend: "pass" | "block";
    commandArgKey: string;
  } => ({
    enabled: process.env.EAGENT_SANDBOX_TIERS !== "off",
    tier: (e.store.get<Tier>("tier", "off") ?? "off") as Tier,
    missingBackend: (e.store.get<"pass" | "block">("missingBackend", "pass") ?? "pass"),
    commandArgKey: e.store.get<string>("commandArgKey", "command") ?? "command",
  });

  /** A forced backend pins the probe (store key wins, then env), for tests/ops. */
  const forcedBackend = (): Backend | undefined => {
    const raw = e.store.get<string>("forceBackend") ?? process.env.EAGENT_SANDBOX_BACKEND;
    if (!raw) return undefined;
    // An unrecognized override (operator typo) coerces to "none" so it routes
    // through the documented missingBackend pass/block policy, rather than
    // falling through wrapCommand's switch and yielding an undefined command.
    return isBackend(raw) ? raw : "none";
  };

  /** Memoized detection (impure); reset on session_start so a reload re-probes. */
  let probed: Backend | undefined;
  const probeBackend = (): Backend => {
    const forced = forcedBackend();
    if (forced) return forced;
    if (probed === undefined) probed = detectBackend(process.platform, binExists);
    return probed;
  };

  /** One-time "no backend" warnings, cleared on session_start so each re-warns. */
  const warned = new Set<string>();

  const offHook = e.hook("beforeToolCall", (decision, ctx) => {
    const { enabled, tier, missingBackend, commandArgKey } = cfg();
    // Disabled, or an earlier guard already vetoed — never un-block another guard.
    if (!enabled || decision.block) return decision;

    // Capability-scope, not name-scope: any `shell:exec` tool (bash, sh, …) is
    // covered; non-shell tools pass untouched. Same idiom as bash-policy.
    const caps = e.agent.tools.get(ctx.call.name)?.capabilities;
    if (!caps?.includes("shell:exec")) return decision;

    // Read from decision.arguments (not ctx.call.arguments) so we compose with an
    // upstream guard that rewrote the command.
    const command = decision.arguments[commandArgKey];
    if (typeof command !== "string") return decision;

    if (tier === "off") return decision; // the no-op default path
    if (isWrapped(command)) return decision; // never nest two sandboxes

    const backend = probeBackend();
    if (backend === "none") {
      if (missingBackend === "block") {
        return {
          ...decision,
          block: true,
          reason: `sandbox-tiers: no sandbox backend available on this host; refusing to run unsandboxed (tier=${tier})`,
        };
      }
      // Fail-open: a degraded environment must not brick the agent. Warn once.
      if (!warned.has("missing")) {
        warned.add("missing");
        e.log.warn(`no sandbox backend available; running shell commands unsandboxed (tier=${tier})`);
      }
      return decision;
    }

    return {
      ...decision,
      arguments: {
        ...decision.arguments,
        [commandArgKey]: wrapCommand(backend, tier, command, { root: workspaceRoot() }),
      },
    };
  });

  const reset = (): void => {
    warned.clear();
    probed = undefined;
  };
  const offStart = e.on("session_start", reset);

  const offCmd = e.registerCommand({
    name: "sandbox-tiers",
    description:
      "OS sandbox confinement tiers for shell commands. Usage: /sandbox-tiers [status|tier <name>|missing <pass|block>|probe|on|off]",
    run: (c) => {
      const raw = c.args.trim();
      const space = raw.indexOf(" ");
      const sub = space < 0 ? raw : raw.slice(0, space);
      const arg = space < 0 ? "" : raw.slice(space + 1).trim();

      switch (sub) {
        case "":
        case "status": {
          const { enabled, tier, missingBackend } = cfg();
          c.print(
            `sandbox-tiers ${enabled ? "on" : "off"}; tier=${tier}; backend=${probeBackend()};` +
              ` missing=${missingBackend}; root=${workspaceRoot()}`,
          );
          break;
        }
        case "tier": {
          if (!(TIERS as readonly string[]).includes(arg)) {
            c.print(`sandbox-tiers: unknown tier "${arg}"; valid: ${TIERS.join(", ")}`);
            break;
          }
          e.store.set("tier", arg);
          c.print(`sandbox-tiers tier=${arg}`);
          break;
        }
        case "missing": {
          if (arg !== "pass" && arg !== "block") {
            c.print(`sandbox-tiers: missing must be "pass" or "block"`);
            break;
          }
          e.store.set("missingBackend", arg);
          c.print(`sandbox-tiers missing=${arg}`);
          break;
        }
        case "probe": {
          const avail = LAUNCHERS.map((b) => `${b}: ${binExists(b) ? "yes" : "no"}`).join(", ");
          c.print(`sandbox-tiers probe: ${avail}; resolved=${probeBackend()}`);
          break;
        }
        case "on":
          delete process.env.EAGENT_SANDBOX_TIERS;
          c.print("sandbox-tiers on");
          break;
        case "off":
          process.env.EAGENT_SANDBOX_TIERS = "off";
          c.print("sandbox-tiers off");
          break;
        default:
          c.print(`sandbox-tiers: unknown subcommand "${sub}"`);
      }
    },
  });

  return () => {
    for (const d of [offHook, offStart, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
