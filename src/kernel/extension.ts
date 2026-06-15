/**
 * The extension surface and the host that loads it.
 *
 * An extension is a module with a default-exported activation function:
 *
 *     export default function activate(e: ExtensionAPI) {
 *       e.registerTool(myTool);
 *       e.on("turn_end", () => { ... });
 *       return () => cleanup();   // optional deactivate
 *     }
 *
 * The activation function may be async. Everything it registers is tracked, so
 * a hot reload tears the old version down precisely and brings a new one up —
 * the "clean swap" that makes live redefinition safe.
 *
 * Trusted extensions run in-process for power and immediacy (pi's trade-off).
 * Untrusted/LLM-authored code does NOT belong here; it goes through the
 * capability layer and is meant to be executed behind an OS/VM boundary.
 */

import { createJiti } from "jiti";
import { readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Agent } from "./agent.js";
import type { KernelEvents, KernelFilters } from "./events.js";
import type { EventHandler, FilterHandler } from "./hooks.js";
import { type Command, CommandRegistry } from "./commands.js";
import { MemoryBackend, type Store, type StoreBackend } from "./store.js";
import { combine, type Disposable, type Logger, type Provider, type Tool } from "./types.js";

/**
 * The capability-scoped object handed to each extension. This is the public,
 * stable API — keep it minimal and additive.
 */
export interface ExtensionAPI {
  readonly id: string;

  registerTool(tool: Tool): Disposable;
  registerProvider(provider: Provider, opts?: { default?: boolean }): Disposable;
  registerCommand(command: Command): Disposable;

  on<K extends keyof KernelEvents>(event: K, handler: EventHandler<KernelEvents[K]>): Disposable;
  hook<K extends keyof KernelFilters>(
    point: K,
    handler: FilterHandler<KernelFilters[K]["value"], KernelFilters[K]["context"]>,
  ): Disposable;

  /** Declare a capability this extension's tools are allowed to use. */
  grantCapability(pattern: string): void;

  /** Namespaced persistent state for this extension. */
  readonly store: Store;
  readonly log: Logger;
  /** The running agent (registries, hooks, capabilities, transcript). */
  readonly agent: Agent;
  /** The command registry, for introspection. */
  readonly commands: CommandRegistry;

  /** Request a hot reload of this extension. Treat as terminal: code after the
   *  await runs in the old runtime. */
  reload(): Promise<void>;

  /**
   * Load another extension from a file at runtime (via the host's jiti loader)
   * and return its id. This is the seam for dynamic, self-authored, and
   * package-installed extensions: they are loaded through the same tracked path
   * as built-ins, so `unloadExtension`/`reload` work on them uniformly.
   */
  loadExtension(path: string): Promise<string>;
  /** Tear down a runtime-loaded extension by id. */
  unloadExtension(id: string): Promise<void>;
}

/** What an extension may return: nothing, a `Disposable`, or a deactivate
 *  function — synchronously or as a promise. All are run on unload/reload. */
export type Deactivate = Disposable | (() => void);
export type ActivateFn = (api: ExtensionAPI) => Deactivate | void | Promise<Deactivate | void>;

interface LoadedExtension {
  id: string;
  origin: { kind: "inline"; activate: ActivateFn } | { kind: "file"; path: string };
  /** Combined teardown of every registration plus any returned deactivate. */
  teardown: Disposable;
}

export interface ExtensionHostOptions {
  agent: Agent;
  commands?: CommandRegistry;
  store?: StoreBackend;
  logger?: Logger;
}

export class ExtensionHost {
  readonly agent: Agent;
  readonly commands: CommandRegistry;
  readonly #store: StoreBackend;
  readonly #logger: Logger;
  readonly #loaded = new Map<string, LoadedExtension>();
  readonly #jiti: ReturnType<typeof createJiti>;

  constructor(opts: ExtensionHostOptions) {
    this.agent = opts.agent;
    this.commands = opts.commands ?? new CommandRegistry();
    this.#store = opts.store ?? new MemoryBackend();
    this.#logger = opts.logger ?? this.agent.logger;
    // moduleCache:false so re-importing a file on reload re-evaluates it.
    this.#jiti = createJiti(pathToFileURL(join(process.cwd(), "eagent.host.ts")).href, {
      moduleCache: false,
      fsCache: true,
    });
  }

  /** Activate an in-process extension factory (built-ins, tests). */
  async use(id: string, activate: ActivateFn): Promise<void> {
    await this.activate({ id, origin: { kind: "inline", activate } });
  }

  /** Load and activate a single extension file via jiti (no build step). */
  async loadFile(path: string): Promise<string> {
    const abs = resolve(path);
    const id = deriveId(abs);
    await this.activate({ id, origin: { kind: "file", path: abs } });
    return id;
  }

  /**
   * Discover and load every extension file in the given directories, in order.
   * Later directories win on id collision (caller passes most-specific last,
   * matching the project-over-user precedence model).
   */
  async discover(dirs: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const dir of dirs) {
      for (const file of listExtensionFiles(dir)) {
        try {
          ids.push(await this.loadFile(file));
        } catch (err) {
          this.#logger.error(`failed to load extension ${file}:`, err);
        }
      }
    }
    return ids;
  }

  /** Hot-reload one extension (or all). Tears down, re-imports, re-activates. */
  async reload(id?: string): Promise<void> {
    const targets = id ? [this.#loaded.get(id)].filter(Boolean) : [...this.#loaded.values()];
    await this.agent.hooks.emit("session_shutdown", {});
    for (const ext of targets as LoadedExtension[]) {
      ext.teardown.dispose();
      this.#loaded.delete(ext.id);
      await this.activate({ id: ext.id, origin: ext.origin });
    }
    await this.agent.hooks.emit("reload", { id });
    await this.agent.hooks.emit("session_start", {});
  }

  /** Tear down a single extension without reactivating. */
  async unload(id: string): Promise<void> {
    const ext = this.#loaded.get(id);
    if (!ext) return;
    ext.teardown.dispose();
    this.#loaded.delete(id);
  }

  list(): string[] {
    return [...this.#loaded.keys()];
  }

  has(id: string): boolean {
    return this.#loaded.has(id);
  }

  /** Tear everything down (e.g. on process exit). */
  async dispose(): Promise<void> {
    await this.agent.hooks.emit("session_shutdown", {});
    for (const ext of this.#loaded.values()) ext.teardown.dispose();
    this.#loaded.clear();
  }

  // -- internals ----------------------------------------------------------

  private async activate(spec: { id: string; origin: LoadedExtension["origin"] }): Promise<void> {
    const disposables: Disposable[] = [];
    const track = <T extends Disposable>(d: T): T => {
      disposables.push(d);
      return d;
    };

    const store = this.#store.open(spec.id);
    const host = this;
    const api: ExtensionAPI = {
      id: spec.id,
      registerTool: (tool) => track(host.agent.tools.register(tool)),
      registerProvider: (provider, opts) => track(host.agent.providers.register(provider, opts)),
      registerCommand: (command) => track(host.commands.register(command)),
      on: (event, handler) => track(host.agent.hooks.on(event, handler)),
      hook: (point, handler) => track(host.agent.hooks.filter(point, handler)),
      grantCapability: (pattern) => host.agent.capabilities.grant(pattern),
      store,
      log: prefixed(this.#logger, spec.id),
      agent: host.agent,
      commands: host.commands,
      reload: () => host.reload(spec.id),
      loadExtension: (path) => host.loadFile(path),
      unloadExtension: (id) => host.unload(id),
    };

    const activate = spec.origin.kind === "inline" ? spec.origin.activate : await this.importFile(spec.origin.path);
    const returned = await activate(api);
    if (typeof returned === "function") disposables.push({ dispose: returned as () => void });
    else if (returned && typeof returned === "object" && "dispose" in returned) disposables.push(returned);

    this.#loaded.set(spec.id, { id: spec.id, origin: spec.origin, teardown: combine(...disposables) });
  }

  private async importFile(path: string): Promise<ActivateFn> {
    const mod = (await this.#jiti.import(path)) as { default?: unknown };
    const activate = mod.default;
    if (typeof activate !== "function") {
      throw new Error(`extension ${path} has no default-exported activation function`);
    }
    return activate as ActivateFn;
  }
}

function prefixed(logger: Logger, id: string): Logger {
  const tag = `[${id}]`;
  return {
    debug: (...a) => logger.debug(tag, ...a),
    info: (...a) => logger.info(tag, ...a),
    warn: (...a) => logger.warn(tag, ...a),
    error: (...a) => logger.error(tag, ...a),
  };
}

function listExtensionFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const full = join(dir, name);
    let isFile: boolean;
    try {
      isFile = statSync(full).isFile();
    } catch {
      continue;
    }
    if (isFile && [".ts", ".js", ".mjs", ".tsx"].includes(extname(name))) out.push(full);
  }
  return out;
}

function deriveId(absPath: string): string {
  const base = absPath.split(/[\\/]/).pop() ?? absPath;
  return base.replace(/\.(ts|js|mjs|tsx)$/, "");
}
