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

import type { ExtensionAPI } from "../kernel/extension.ts";

import {
  wrapCommand,
  detectBackend,
  binExists,
  isBackend,
  workspaceRoot,
  TIERS,
  LAUNCHERS,
  type Backend,
  type Tier,
} from "./lib/sandbox.ts";

// Re-export the launcher core from the lib under the names this extension's
// public surface exposes, so importers depending on them are unaffected.
export { detectBackend, wrapCommand, shquote, isWrapped, workspaceRoot, TIERS } from "./lib/sandbox.ts";
export type { Backend, Tier } from "./lib/sandbox.ts";

export default function activate(e: ExtensionAPI): () => void {
  const cfg = (): {
    enabled: boolean;
    tier: Tier;
    missingBackend: "pass" | "block";
    commandArgKey: string;
  } => ({
    enabled: e.config.enabled("sandbox-tiers", { default: true }),
    // Read the tier from config first (so the hardened preset / EAGENT_SANDBOX_TIER
    // can set it without a store write), falling back to the extension's store key.
    // Mirrors the `sandbox.backend` config read below; fail-secure — only exact
    // "off" is the pass-through no-op, so any other value confines.
    tier: (e.config.string("sandbox.tier") ?? e.store.get<Tier>("tier", "off") ?? "off") as Tier,
    missingBackend: (e.store.get<"pass" | "block">("missingBackend", "pass") ?? "pass"),
    commandArgKey: e.store.get<string>("commandArgKey", "command") ?? "command",
  });

  /** A forced backend pins the probe (store key wins, then env), for tests/ops. */
  const forcedBackend = (): Backend | undefined => {
    const raw = e.store.get<string>("forceBackend") ?? e.config.string("sandbox.backend");
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

    // Always wrap when a tier is active — never skip because the command *looks*
    // already-wrapped. The command is untrusted model output, so a launcher prefix
    // (`sandbox-exec`/`bwrap`/`firejail`) is attacker-forgeable: skipping on it would
    // let an injected `sandbox-exec -p '(allow default)' /bin/sh -c '…'` run under the
    // attacker's own permissive profile and escape confinement. Nesting our launcher
    // around a launcher command fails closed — the OS rejects a nested sandbox, or the
    // inner can only further-restrict what the outer already denied — never opens a hole.
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
        [commandArgKey]: wrapCommand(backend, tier, command, { root: workspaceRoot(e.config) }),
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
              ` missing=${missingBackend}; root=${workspaceRoot(e.config)}`,
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
          e.config.set("sandbox-tiers", true);
          c.print("sandbox-tiers on");
          break;
        case "off":
          e.config.set("sandbox-tiers", false);
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
