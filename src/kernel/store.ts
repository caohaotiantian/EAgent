/**
 * Per-extension persistent key/value state.
 *
 * Extensions get their own namespaced `Store` so state is scoped, not global
 * (the explicit fix for one of Emacs's documented mistakes — pervasive global
 * mutable state). A reload preserves the store; a teardown does not wipe it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Store {
  get<T = unknown>(key: string, fallback?: T): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
  keys(): string[];
}

export interface StoreBackend {
  open(namespace: string): Store;
}

/** Layered, read-mostly config handed to every extension as `e.config`: value
 *  keys resolve override>env>file>default; `enabled()` env-veto>override>store>
 *  default (no file). Full host impl: `LayeredConfig` in `src/config.ts`. */
export interface Config {
  get<T>(key: string, fallback: T): T;
  int(key: string, fallback: number): number;
  bool(key: string, fallback: boolean): boolean;
  string(key: string): string | undefined;
  enabled(key: string, opts?: { default?: boolean; store?: Pick<Store, "get"> }): boolean;
  set(key: string, value: string | number | boolean): void;
  unset(key: string): void;
  entries(): { key: string; value: unknown; source: "override" | "env" | "file" | "default" }[];
}

/** Coerce a config string to a boolean by the shared vocabulary, or `undefined`. */
export function parseConfigBool(raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return undefined;
}

/** A minimal env-only `Config`: the `ExtensionHost` fallback when a host supplies
 *  none (chiefly tests). No file layer, aliases, or override store — `set/unset`
 *  are no-ops; real hosts pass a full `LayeredConfig` (`src/config.ts`). */
export function envOnlyConfig(): Config {
  const env = (k: string): string | undefined =>
    process.env["EAGENT_" + k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toUpperCase()];
  return {
    get: <T>(k: string, f: T): T => ((env(k) as unknown as T) ?? f),
    int: (k, f) => { const r = env(k), n = Number(r); return r !== undefined && Number.isFinite(n) ? n : f; },
    bool: (k, f) => parseConfigBool(env(k)) ?? f,
    string: (k) => env(k),
    enabled: (k, o) => (env(k) === "off" ? false : o?.store ? Boolean(o.store.get("enabled", o.default ?? false)) : (o?.default ?? false)),
    set: () => {},
    unset: () => {},
    entries: () => [],
  };
}

export class MemoryStore implements Store {
  readonly #data = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.#data.has(key) ? (this.#data.get(key) as T) : fallback);
  }
  set(key: string, value: unknown): void {
    this.#data.set(key, value);
  }
  delete(key: string): void {
    this.#data.delete(key);
  }
  keys(): string[] {
    return [...this.#data.keys()];
  }
}

export class MemoryBackend implements StoreBackend {
  readonly #stores = new Map<string, MemoryStore>();
  open(namespace: string): Store {
    let s = this.#stores.get(namespace);
    if (!s) this.#stores.set(namespace, (s = new MemoryStore()));
    return s;
  }
}

/** JSON-file-backed store, one file per extension namespace. */
export class FileBackend implements StoreBackend {
  readonly #stores = new Map<string, FileStore>();
  constructor(private readonly root: string) {}
  open(namespace: string): Store {
    // Cache one FileStore per namespace so two `open()` calls in the same
    // process share in-memory state instead of clobbering each other's keys on
    // flush (last-full-object-write-wins).
    let s = this.#stores.get(namespace);
    if (!s) this.#stores.set(namespace, (s = new FileStore(join(this.root, `${sanitize(namespace)}.json`))));
    return s;
  }
}

class FileStore implements Store {
  #data: Record<string, unknown>;
  constructor(private readonly path: string) {
    this.#data = this.read();
  }
  get<T>(key: string, fallback?: T): T | undefined {
    return key in this.#data ? (this.#data[key] as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.#data[key] = value;
    this.flush();
  }
  delete(key: string): void {
    delete this.#data[key];
    this.flush();
  }
  keys(): string[] {
    return Object.keys(this.#data);
  }
  private read(): Record<string, unknown> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
    } catch {
      try { renameSync(this.path, `${this.path}.corrupt-${process.pid}-${Date.now()}`); } catch { /* best effort */ }
      return {};
    }
  }
  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write to a temp file then atomically rename into place, so a crash or
    // concurrent reader never sees a half-written (corrupt) JSON file.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#data, null, 2));
    renameSync(tmp, this.path);
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}
