/**
 * `packages` — an extension package manager for EAgent extensions and skills.
 *
 * This is the Emacs `package.el`/MELPA analog: a small command surface for
 * installing third-party extensions from a few distribution channels and
 * loading them into the live agent, the way `M-x package-install` pulls a
 * package and evaluates its `*-autoloads`. Three source kinds are supported:
 *
 *   - `path:<file-or-dir>` (or a bare local path) — a local extension copied
 *     and loaded directly, with no network access.
 *   - `git:<url>` — `git clone --depth 1` of a repository into the packages
 *     directory.
 *   - `npm:<spec>` — `npm install <spec> --ignore-scripts` into the packages
 *     directory.
 *
 * Installing an extension means running its code in-process, which is exactly
 * the supply-chain hazard that capability gating exists to contain: every
 * install is gated by the `pkg:install` capability, npm installs disable
 * lifecycle scripts, and the human is expected to vet the source. Treat
 * anything pulled from git or npm as untrusted until reviewed.
 *
 * Installed packages register their tools, commands, and hooks through a
 * recording shim that delegates to this extension's own `ExtensionAPI` while
 * capturing every returned `Disposable`. That lets `/pkg-remove` tear an
 * installed package's registrations back out precisely — the same clean-swap
 * discipline the host uses for reloads. The installed registry is persisted in
 * `e.store`, so `path:` installs are best-effort re-loaded on `session_start`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { createJiti } from "jiti";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import type { Command, CommandContext } from "../kernel/commands.js";
import type { KernelEvents, KernelFilters } from "../kernel/events.js";
import type { EventHandler, FilterHandler } from "../kernel/hooks.js";
import type { Disposable, Tool } from "../kernel/types.js";

/** Persisted registry entry for one installed package. */
interface PackageEntry {
  /** Normalized source string the package was installed from. */
  source: string;
  /** Absolute path of the entry file that was imported. */
  entryPath: string;
  /** Install timestamp (ms since epoch). */
  installedAt: number;
}

type PackageRegistry = Record<string, PackageEntry>;

const STORE_KEY = "packages";
const ENTRY_CANDIDATES = ["index.ts", "extension.ts", "index.js", "extension.js", "main.ts", "main.js"];

/**
 * A full alias of `ExtensionAPI`, named to mark where an installed package
 * activates against the recording shim (see `makeShim`) rather than the raw
 * host API. The shim implements this same interface but wraps the registration
 * methods so the disposables they return are captured for later teardown.
 */
type ShimAPI = ExtensionAPI;

export default function activate(e: ExtensionAPI): Disposable {
  // NOTE: `pkg:install` is deliberately NOT auto-granted here. Installing a
  // package runs third-party code in-process, so each install must clear the
  // capability policy (grant/deny/ask) rather than being silently allowed.

  /** Live disposers per installed package id, keyed alongside the store. */
  const active = new Map<string, Disposable[]>();

  const packagesDir = resolvePackagesDir(e.config);
  // We load packages through our own jiti + recording shim rather than the
  // ExtensionAPI's `loadExtension`, on purpose: a package is a CHILD of the
  // manager. Scoping its registrations to us means `/pkg-remove` and reloading
  // the manager tear the package down with it. `loadExtension` (used by the
  // `self` extension) instead creates an independent, host-level peer — the
  // right choice there, the wrong lifecycle here.
  const jiti = createJiti(pathToFileURL(join(process.cwd(), "pkg.host.ts")).href, {
    moduleCache: false,
    fsCache: true,
  });

  const readRegistry = (): PackageRegistry => e.store.get<PackageRegistry>(STORE_KEY, {}) ?? {};
  const writeRegistry = (reg: PackageRegistry): void => e.store.set(STORE_KEY, reg);

  /**
   * Import an extension entry file and activate it against a recording shim.
   * Returns the disposables the activation produced. Throws on any failure;
   * callers report the error to the user.
   */
  async function loadEntry(entryPath: string): Promise<Disposable[]> {
    const collected: Disposable[] = [];
    const shim = makeShim(e, collected);
    const mod = (await jiti.import(entryPath)) as { default?: unknown };
    const activateFn = mod.default;
    if (typeof activateFn !== "function") {
      throw new Error(`no default-exported activation function in ${entryPath}`);
    }
    const returned = await (activateFn as (api: ShimAPI) => unknown)(shim);
    if (typeof returned === "function") collected.push({ dispose: returned as () => void });
    else if (returned && typeof returned === "object" && "dispose" in (returned as object)) {
      collected.push(returned as Disposable);
    }
    return collected;
  }

  /** Tear down a package's registrations and forget it. */
  function disposePackage(id: string): void {
    const disposers = active.get(id);
    if (disposers) {
      for (const d of disposers.reverse()) {
        try {
          d.dispose();
        } catch {
          // a failing teardown must not block the rest
        }
      }
      active.delete(id);
    }
  }

  // -- commands -------------------------------------------------------------

  const addCommand: Command = {
    name: "pkg-add",
    description: "Install and load an extension package (path:/git:/npm: source).",
    async run({ args, print }: CommandContext): Promise<void> {
      const source = args.trim();
      if (!source) {
        print("usage: /pkg-add <path:... | git:... | npm:... | local-path>");
        return;
      }

      try {
        await e.agent.capabilities.require("pkg:install", "packages");
      } catch {
        print(`refused: installing packages requires the "pkg:install" capability (denied).`);
        return;
      }

      let entryPath: string;
      try {
        entryPath = await materialize(source, packagesDir);
      } catch (err) {
        print(`error: could not fetch package from ${source}: ${describe(err)}`);
        return;
      }

      const id = deriveId(entryPath);

      // Replace any prior install of the same id cleanly.
      if (active.has(id)) disposePackage(id);

      let disposers: Disposable[];
      try {
        disposers = await loadEntry(entryPath);
      } catch (err) {
        print(`error: failed to activate ${id}: ${describe(err)}`);
        return;
      }

      active.set(id, disposers);
      const reg = readRegistry();
      reg[id] = { source: normalizeSource(source), entryPath, installedAt: Date.now() };
      writeRegistry(reg);

      print(`installed ${id} (${disposers.length} registration${disposers.length === 1 ? "" : "s"}) from ${source}`);
    },
  };

  const listCommand: Command = {
    name: "pkg-list",
    description: "List installed extension packages.",
    run({ print }: CommandContext): void {
      const reg = readRegistry();
      const ids = Object.keys(reg).sort();
      if (ids.length === 0) {
        print("no packages installed.");
        return;
      }
      for (const id of ids) {
        const entry = reg[id]!;
        const live = active.has(id) ? "loaded" : "not loaded";
        print(`${id}  <-  ${entry.source}  [${live}]`);
      }
    },
  };

  const removeCommand: Command = {
    name: "pkg-remove",
    description: "Uninstall an extension package and remove its registrations.",
    run({ args, print }: CommandContext): void {
      const id = args.trim();
      if (!id) {
        print("usage: /pkg-remove <id>");
        return;
      }
      const reg = readRegistry();
      const wasKnown = id in reg || active.has(id);
      disposePackage(id);
      if (id in reg) {
        delete reg[id];
        writeRegistry(reg);
      }
      print(wasKnown ? `removed ${id}.` : `no package named ${id}.`);
    },
  };

  const disposables: Disposable[] = [
    e.registerCommand(addCommand),
    e.registerCommand(listCommand),
    e.registerCommand(removeCommand),
  ];

  // Best-effort: re-load previously installed local packages on session start
  // so installs persist across runs. Network sources are not auto-refetched.
  disposables.push(
    e.on("session_start", async () => {
      const reg = readRegistry();
      const root = resolve(packagesDir);
      for (const [id, entry] of Object.entries(reg)) {
        if (active.has(id)) continue;
        // Harden against a tampered registry: a remotely-fetched package (git:/
        // npm:) materializes INTO the packages dir, so on reload its entryPath
        // must still live there. If a tampered store points it elsewhere, refuse
        // to auto-execute it. (path:/bare installs are the user's own local code
        // and legitimately reload from wherever they were recorded.)
        if (/^(git|npm):/.test(entry.source)) {
          const abs = resolve(entry.entryPath);
          if (abs !== root && !abs.startsWith(root + sep)) {
            e.log.warn(
              `skipping package ${id}: a ${entry.source.split(":")[0]}: package must reload from the packages dir, not ${abs}`,
            );
            continue;
          }
        }
        if (!existsSync(entry.entryPath)) continue;
        try {
          active.set(id, await loadEntry(entry.entryPath));
        } catch (err) {
          e.log.warn(`could not re-load package ${id}:`, err);
        }
      }
    }),
  );

  return {
    dispose() {
      for (const id of [...active.keys()]) disposePackage(id);
      for (const d of disposables.reverse()) {
        try {
          d.dispose();
        } catch {
          // ignore teardown failures
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Source resolution
// ---------------------------------------------------------------------------

/**
 * Turn a source string into an absolute entry file on disk, fetching it if
 * necessary. `path:`/bare sources are local; `git:`/`npm:` shell out to fetch
 * into the packages directory (real, but not exercised by the offline tests).
 */
async function materialize(source: string, packagesDir: string): Promise<string> {
  mkdirSync(packagesDir, { recursive: true });

  if (source.startsWith("git:")) {
    const url = source.slice("git:".length);
    assertSafeGitUrl(url);
    const dest = join(packagesDir, sanitize(repoName(url)));
    // assertSafeGitUrl is the real guard: its scheme/scp allowlist already
    // rejects `-`-leading URLs and the dangerous ext::/fd::/file:// remote
    // helpers. The `--` below is belt-and-suspenders, separating the URL from
    // options so nothing that slipped through could be reparsed as a git flag.
    execFileSync("git", ["clone", "--depth", "1", "--", url, dest], { stdio: "ignore" });
    return resolveEntry(dest);
  }

  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length);
    assertSafeNpmSpec(spec);
    execFileSync("npm", ["install", spec, "--ignore-scripts", "--no-save", "--prefix", packagesDir], {
      stdio: "ignore",
    });
    const pkgName = spec.replace(/@[^/]*$/, ""); // drop trailing @version
    return resolveEntry(join(packagesDir, "node_modules", pkgName));
  }

  // path: or a bare local filesystem path — used directly, no network.
  const raw = source.startsWith("path:") ? source.slice("path:".length) : source;
  const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  if (!existsSync(abs)) throw new Error(`no such file or directory: ${abs}`);
  return resolveEntry(abs);
}

/**
 * Reject git URLs that aren't plain transport URLs — in particular git's
 * `ext::`/`fd::` remote helpers (which execute arbitrary commands at clone time)
 * and `file://`, plus anything that could be reparsed as an option. Allows
 * https/ssh/git scheme URLs and scp-style `git@host:path`.
 */
function assertSafeGitUrl(url: string): void {
  const schemeUrl = /^(https?|ssh|git):\/\/[^\s]+$/.test(url);
  const scpStyle = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url);
  if (!schemeUrl && !scpStyle) {
    throw new Error(`refusing to clone unsafe git URL "${url}" — use https://, ssh://, git://, or git@host:path`);
  }
}

/** Require a bare npm package spec (`name`, `@scope/name`, optional `@version`). */
function assertSafeNpmSpec(spec: string): void {
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+(@[A-Za-z0-9._^~><=.\-]+)?$/.test(spec)) {
    throw new Error(`refusing to install unsafe npm spec "${spec}" — expected name or name@version`);
  }
}

/** Resolve a file-or-directory to a concrete entry file. */
function resolveEntry(target: string): string {
  const st = statSync(target);
  if (st.isFile()) return target;
  // Directory: honor a package.json "main", else known entry filenames.
  const pkgJson = join(target, "package.json");
  if (existsSync(pkgJson)) {
    try {
      const main = (JSON.parse(readFileSync(pkgJson, "utf8")) as { main?: string }).main;
      if (main) {
        const mainPath = join(target, main);
        if (existsSync(mainPath)) return mainPath;
      }
    } catch {
      // fall through to candidate filenames
    }
  }
  for (const name of ENTRY_CANDIDATES) {
    const candidate = join(target, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`no entry file found in ${target}`);
}

// ---------------------------------------------------------------------------
// Recording shim
// ---------------------------------------------------------------------------

/**
 * Build a structural `ExtensionAPI` for an installed package. Registration
 * methods delegate to the host extension's `e` (so registrations land on the
 * live agent) but push every returned `Disposable` into `collected`, giving
 * `/pkg-remove` an exact teardown set. Everything else passes through to `e`.
 */
function makeShim(e: ExtensionAPI, collected: Disposable[]): ExtensionAPI {
  const record = <T extends Disposable>(d: T): T => {
    collected.push(d);
    return d;
  };
  return {
    id: e.id,
    registerTool: (tool: Tool) => record(e.registerTool(tool)),
    registerProvider: (provider, opts) => record(e.registerProvider(provider, opts)),
    registerCommand: (command: Command) => record(e.registerCommand(command)),
    on: <K extends keyof KernelEvents>(event: K, handler: EventHandler<KernelEvents[K]>) =>
      record(e.on(event, handler)),
    hook: <K extends keyof KernelFilters>(
      point: K,
      handler: FilterHandler<KernelFilters[K]["value"], KernelFilters[K]["context"]>,
    ) => record(e.hook(point, handler)),
    grantCapability: (pattern: string) => e.grantCapability(pattern),
    store: e.store,
    config: e.config,
    log: e.log,
    agent: e.agent,
    commands: e.commands,
    reload: () => e.reload(),
    loadExtension: (path: string) => e.loadExtension(path),
    unloadExtension: (id: string) => e.unloadExtension(id),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolvePackagesDir(config: Config): string {
  return config.string("packages.dir") ?? join(homedir(), ".eagent", "packages");
}

/** A stable id derived from the entry file's basename (sans extension). */
function deriveId(entryPath: string): string {
  const base = basename(entryPath).replace(/\.(ts|tsx|js|mjs|cjs)$/, "");
  return sanitize(base) || "package";
}

function normalizeSource(source: string): string {
  return source.trim();
}

function repoName(url: string): string {
  const tail = url.replace(/\.git$/, "").split(/[\\/]/).pop() ?? "repo";
  return tail || "repo";
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
