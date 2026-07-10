/**
 * Layered configuration — the host implementation of the kernel `Config`
 * interface handed to every extension as `e.config`.
 *
 * Configuration in EAgent used to be read at ~200 isolated sites (direct
 * `process.env.EAGENT_*` reads, private hard-coded constants, per-extension store
 * flags), each with its own precedence and parsing. `LayeredConfig` centralizes
 * that into one deterministic chain:
 *
 *   - **value keys** resolve `override > env > file > default`
 *   - **`enabled()`** resolves `env-veto("off") > override > store > default`,
 *     deliberately EXCLUDING the config file so an untrusted project
 *     `.eagent/config.json` can never flip an extension on or off.
 *
 * Env var names derive from the dotted key by convention (`subagents.maxTurns`
 * ⟷ `EAGENT_SUBAGENTS_MAX_TURNS`); irregular legacy names are honored via the
 * explicit `ENV_ALIASES` map so every existing `.env` keeps working. The runtime
 * override layer is a namespaced `Store` (persisted like any other state); the
 * file layer is flat JSON at `~/.eagent/config.json` then `./.eagent/config.json`
 * (project wins), re-read only on `/config reload`.
 */

import type { Config, Store } from "./kernel/store.js";
import { parseConfigBool } from "./kernel/store.js";
import { existsSync, readFileSync } from "node:fs";

/** A flat map of dotted config key → JSON scalar (the file layer's shape). */
export type ConfigValues = Record<string, string | number | boolean>;

/**
 * Irregular legacy env names that the derivation `EAGENT_ + UPPER(key, .-→_)`
 * does not reproduce, plus the non-`EAGENT_` provider vars. Each canonical key
 * lists the env names to consult (in addition to the derived name), first-set
 * wins. Keeps every historical `.env` working after centralization.
 */
export const ENV_ALIASES: Record<string, string[]> = {
  "mcp.maxReadBytes": ["EAGENT_MAX_MCP_READ_BYTES"],
  "http.maxSseEventBytes": ["EAGENT_MAX_SSE_EVENT_BYTES"],
  "server.maxSessions": ["EAGENT_MAX_SESSIONS"],
  "server.host": ["EAGENT_HOST"],
  "models.anthropic": ["ANTHROPIC_MODEL"],
  "models.openai": ["OPENAI_MODEL"],
  "models.gemini": ["GEMINI_MODEL"],
  "providers.anthropic.baseUrl": ["ANTHROPIC_BASE_URL"],
  "providers.openai.baseUrl": ["OPENAI_BASE_URL"],
  "providers.gemini.baseUrl": ["GEMINI_BASE_URL"],
  "providers.anthropic.maxTokens": ["ANTHROPIC_MAX_TOKENS"],
  "providers.openai.maxTokens": ["OPENAI_MAX_TOKENS"],
  "providers.gemini.maxTokens": ["GEMINI_MAX_TOKENS"],
};

/** The env var name a key reads by convention: `EAGENT_` + the key upper-cased
 *  with camelCase boundaries, dots, and dashes all mapped to `_`
 *  (`agent.maxTurns` → `EAGENT_AGENT_MAX_TURNS`). */
export function configEnvName(key: string): string {
  return "EAGENT_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toUpperCase();
}

/** A key whose value must never be printed by `/config` (list or get). */
export function isSecretKey(key: string): boolean {
  // A token *count* (maxTokens, maxTokensPerRun, …) is a limit, not a credential,
  // so it must not be masked despite containing "token".
  if (/maxtokens/i.test(key.replace(/[._-]/g, ""))) return false;
  return /token|key|secret/i.test(key);
}

export interface LayeredConfigOptions {
  /** The file layer (already merged project-over-user). */
  fileValues?: ConfigValues;
  /** The runtime-override layer — a persisted namespaced store. */
  overrideStore: Store;
  /** File paths to (re-)read the file layer from on `reload()`. */
  filePaths?: string[];
}

export class LayeredConfig implements Config {
  #file: ConfigValues;
  readonly #over: Store;
  readonly #filePaths: string[];
  /** Every key ever read or written, so `entries()` can enumerate the surface. */
  readonly #seen = new Set<string>();

  constructor(opts: LayeredConfigOptions) {
    this.#file = opts.fileValues ?? {};
    this.#over = opts.overrideStore;
    this.#filePaths = opts.filePaths ?? [];
  }

  /** Re-read the file layer from the configured paths (for `/config reload`). */
  reload(): void {
    if (this.#filePaths.length > 0) this.#file = loadConfigFile(this.#filePaths);
  }

  /** The raw env string for a key: the derived name, then any legacy alias. */
  #env(key: string): string | undefined {
    const direct = process.env[configEnvName(key)];
    if (direct !== undefined) return direct;
    for (const alias of ENV_ALIASES[key] ?? []) {
      const v = process.env[alias];
      if (v !== undefined) return v;
    }
    return undefined;
  }

  /** The winning raw value for a VALUE key: override > env > file (else undefined). */
  #raw(key: string): { value: string | number | boolean; source: "override" | "env" | "file" } | undefined {
    this.#seen.add(key);
    const o = this.#over.get<string | number | boolean>(key);
    if (o !== undefined) return { value: o, source: "override" };
    const e = this.#env(key);
    if (e !== undefined) return { value: e, source: "env" };
    if (key in this.#file) return { value: this.#file[key]!, source: "file" };
    return undefined;
  }

  get<T>(key: string, fallback: T): T {
    const r = this.#raw(key);
    return r === undefined ? fallback : (r.value as unknown as T);
  }

  int(key: string, fallback: number): number {
    const r = this.#raw(key);
    if (r === undefined) return fallback;
    const n = Number(r.value);
    return Number.isFinite(n) ? n : fallback;
  }

  bool(key: string, fallback: boolean): boolean {
    const r = this.#raw(key);
    if (r === undefined) return fallback;
    return parseConfigBool(String(r.value)) ?? fallback;
  }

  string(key: string): string | undefined {
    const r = this.#raw(key);
    return r === undefined ? undefined : String(r.value);
  }

  enabled(key: string, opts?: { default?: boolean; store?: Pick<Store, "get"> }): boolean {
    this.#seen.add(key);
    const fallback = opts?.default ?? false;
    // 1. env "off" is a hard veto (the config FILE is intentionally not consulted).
    if (this.#env(key) === "off") return false;
    // 2. runtime override (trusted — written only by /config set and /x commands).
    const o = this.#over.get<string | number | boolean>(key);
    if (o !== undefined) return parseConfigBool(String(o)) ?? Boolean(o);
    // 3. the extension's own store flag, with the default threaded into the lookup.
    //    Coerce via parseConfigBool (like the override layer) so a string flag
    //    "off"/"false" reads false, not truthy.
    if (opts?.store) {
      const v = opts.store.get("enabled", fallback);
      return parseConfigBool(String(v)) ?? Boolean(v);
    }
    // 4. the code default.
    return fallback;
  }

  set(key: string, value: string | number | boolean): void {
    this.#seen.add(key);
    this.#over.set(key, value);
  }

  unset(key: string): void {
    this.#over.delete(key);
  }

  entries(): { key: string; value: unknown; source: "override" | "env" | "file" | "default" }[] {
    const keys = new Set<string>([...this.#seen, ...this.#over.keys(), ...Object.keys(this.#file)]);
    return [...keys].sort().map((key) => {
      const r = this.#raw(key);
      const source = r?.source ?? "default";
      const value = isSecretKey(key) ? "«hidden»" : r?.value;
      return { key, value, source };
    });
  }
}

/**
 * Load and shallow-merge the flat-JSON config files in order (project last wins).
 * A missing file is skipped; an invalid or non-object file contributes nothing.
 * Never throws.
 */
export function loadConfigFile(paths: string[]): ConfigValues {
  const merged: ConfigValues = {};
  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") merged[k] = v;
        }
      }
    } catch {
      // invalid JSON — contribute nothing
    }
  }
  return merged;
}
