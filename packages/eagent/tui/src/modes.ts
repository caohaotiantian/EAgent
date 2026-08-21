/**
 * Permission modes — the Shift+Tab cycle.
 *
 * A mode is a name for a capability-layer configuration. The engine has a
 * three-way fallback (`ask`/`allow`/`deny`) plus a plan-mode flag, not Claude
 * Code's enum, so the mapping is defined here explicitly rather than pretended
 * to be identical.
 *
 * Cycling is pure; applying a mode is a separate, injected effect, so the wheel
 * order and labels are testable without a capability manager.
 */

export type Mode = "manual" | "plan" | "yolo";

export const MODES: readonly Mode[] = ["manual", "plan", "yolo"];

export interface ModeInfo {
  label: string;
  hint: string;
  /** The capability fallback this mode installs. */
  fallback: "ask" | "allow" | "deny";
  /** Patterns pre-granted while the mode is active. */
  grants: readonly string[];
  /** Whether the `planmode` extension's approval gate is on. */
  plan: boolean;
}

export const MODE_INFO: Record<Mode, ModeInfo> = {
  manual: {
    label: "manual",
    // NOT "ask before every privileged call": the host pre-grants fs:read,
    // fs:write and skill:read at construction (src/host.ts), and grants are
    // checked before the fallback, so file access never prompts in any mode.
    // An "accept edits" mode was dropped for exactly this reason -- its only
    // content was a redundant fs:write grant, making it a no-op.
    hint: "ask before shell, code, network, and spawns",
    fallback: "ask",
    grants: [],
    plan: false,
  },
  plan: {
    // Read-only reconnaissance: the model may look around freely, and every
    // mutating call waits for a human.
    label: "plan",
    hint: "read-only; mutating calls wait for approval",
    fallback: "ask",
    grants: ["fs:read"],
    plan: true,
  },
  yolo: {
    label: "yolo",
    hint: "auto-approve everything — no prompts",
    fallback: "allow",
    grants: [],
    plan: false,
  },
};

/** Next mode on the wheel. Shift+Tab cycles forward; the wheel wraps. */
export function cycle(current: Mode, dir: 1 | -1 = 1): Mode {
  const i = MODES.indexOf(current);
  const next = (i + dir + MODES.length) % MODES.length;
  return MODES[next]!;
}

export interface ModeTarget {
  setFallback: (d: "ask" | "allow" | "deny") => void;
  /** Returns a disposer, so the previous mode's grants can be revoked. */
  grant: (pattern: string) => { dispose: () => void };
  setPlanMode?: (on: boolean) => void;
}

/**
 * Apply a mode, revoking whatever the previous one granted. Returns the new
 * disposers. Revoking matters: without it, cycling `acceptEdits → manual` would
 * leave `fs:write` granted and the indicator would lie.
 */
export function applyMode(
  mode: Mode,
  target: ModeTarget,
  previous: { dispose: () => void }[] = [],
): { dispose: () => void }[] {
  for (const d of previous) d.dispose();
  const info = MODE_INFO[mode];
  // setFallback clears remembered answers, so a mode switch genuinely takes
  // effect for capabilities already answered — including the lock-down way.
  target.setFallback(info.fallback);
  target.setPlanMode?.(info.plan);
  return info.grants.map((p) => target.grant(p));
}
