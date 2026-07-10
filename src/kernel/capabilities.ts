/**
 * Capability-based authority for tools and extensions.
 *
 * pi deliberately ships no permission system and tells you to containerize.
 * That is a reasonable stance for a trusted single-user coding agent. But the
 * moment the LLM itself authors and runs new tools (extension mode "c"),
 * ambient authority becomes a liability. So the kernel carries a small,
 * explicit capability layer from day one.
 *
 * A capability is a dotted string naming an authority: `fs:read`, `fs:write`,
 * `shell:exec`, `net:fetch`, `skill:write`. Tools declare what they need; the
 * dispatcher enforces it via `ctx.require(cap)` before the tool body runs.
 *
 * Decisions come from an ordered policy:
 *   - an explicit grant pattern  -> allow
 *   - an explicit deny pattern   -> deny
 *   - otherwise                  -> ask the human (default), or a custom rule
 *
 * Patterns support a trailing `*` wildcard segment (`fs:*`, `*`).
 */

import type { Disposable, UI } from "./types.js";

export type Decision = "allow" | "deny" | "ask";

export class CapabilityError extends Error {
  constructor(public readonly capability: string, reason: string) {
    super(`capability "${capability}" denied: ${reason}`);
    this.name = "CapabilityError";
  }
}

export interface AuditEntry {
  capability: string;
  decision: "allow" | "deny";
  source: string; // who asked — a tool name or extension id
  prompted: boolean; // whether a human was prompted for this decision
  at: number;
}

export interface CapabilityOptions {
  grant?: string[]; // patterns auto-allowed without prompting
  deny?: string[]; // patterns always denied (takes precedence over grants)
  /** Fallback for caps matching neither list. Default `"ask"`; `"allow"` for trusted runs, `"deny"` for locked-down. */
  fallback?: Decision;
  ui?: UI;
}

export class CapabilityManager {
  #grant: string[];
  #deny: string[];
  #fallback: Decision;
  #ui: UI | undefined;
  readonly #audit: AuditEntry[] = [];
  /** Session prompt-answer memo + its in-flight dedup map, keyed by capability. */
  readonly #remembered = new Map<string, boolean>();
  readonly #pending = new Map<string, Promise<boolean>>();

  constructor(opts: CapabilityOptions = {}) {
    this.#grant = [...(opts.grant ?? [])];
    this.#deny = [...(opts.deny ?? [])];
    this.#fallback = opts.fallback ?? "ask";
    this.#ui = opts.ui;
  }

  setUI(ui: UI): void {
    this.#ui = ui;
  }

  /** Add a granted pattern at runtime (e.g. an extension declaring its needs). */
  grant(pattern: string): Disposable {
    this.#grant.push(pattern);
    let disposed = false;
    return { dispose: () => { if (disposed) return; disposed = true; const i = this.#grant.indexOf(pattern); if (i >= 0) this.#grant.splice(i, 1); } };
  }

  /**
   * Enforce a capability. Resolves if allowed, throws `CapabilityError` if not.
   * `source` identifies the requester for the audit log.
   */
  async require(capability: string, source: string): Promise<void> {
    if (matchesAny(capability, this.#deny)) {
      this.record(capability, "deny", source, false);
      throw new CapabilityError(capability, `matches deny rule`);
    }
    if (matchesAny(capability, this.#grant)) {
      this.record(capability, "allow", source, false);
      return;
    }

    if (this.#remembered.has(capability)) {
      const ok = this.#remembered.get(capability)!;
      this.record(capability, ok ? "allow" : "deny", source, false);
      if (!ok) throw new CapabilityError(capability, "previously declined");
      return;
    }

    if (this.#fallback === "allow") {
      this.record(capability, "allow", source, false);
      return;
    }
    if (this.#fallback === "deny") {
      this.record(capability, "deny", source, false);
      throw new CapabilityError(capability, "not granted (fallback deny)");
    }

    // fallback === "ask"
    if (!this.#ui) {
      this.record(capability, "deny", source, false);
      throw new CapabilityError(capability, "not granted and no UI to prompt");
    }
    // Concurrent callers needing the same unremembered cap share ONE confirm.
    let ask = this.#pending.get(capability);
    if (!ask) {
      this.#pending.set(capability, (ask = this.#ui.confirm(`Allow ${source} to use capability "${capability}"?`).then((ok) => (this.#remembered.set(capability, ok), ok))));
      void ask.finally(() => this.#pending.delete(capability));
    }
    const ok = await ask;
    this.record(capability, ok ? "allow" : "deny", source, true);
    if (!ok) throw new CapabilityError(capability, "declined by user");
  }

  /** Non-throwing check, used for filtering tool lists and introspection. */
  isGranted(capability: string): boolean {
    if (matchesAny(capability, this.#deny)) return false;
    if (matchesAny(capability, this.#grant)) return true;
    if (this.#remembered.has(capability)) return this.#remembered.get(capability)!;
    return this.#fallback === "allow";
  }

  audit(): readonly AuditEntry[] {
    return this.#audit;
  }

  private record(capability: string, decision: "allow" | "deny", source: string, prompted: boolean): void {
    this.#audit.push({ capability, decision, source, prompted, at: Date.now() });
  }
}

function matchesAny(capability: string, patterns: string[]): boolean {
  return patterns.some((p) => matchPattern(capability, p));
}

/** `fs:*` matches `fs:read`; `*` matches everything; otherwise exact. */
export function matchPattern(capability: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern === capability) return true;
  if (pattern.endsWith(":*")) {
    const prefix = pattern.slice(0, -1); // keep the colon: "fs:"
    return capability.startsWith(prefix);
  }
  return false;
}
