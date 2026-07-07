/**
 * `self` — the agent extends itself.
 *
 * This is the realization of the Emacs ideal carried into an LLM agent: the
 * agent does not merely emit instructions or edit configuration, it authors and
 * hot-loads real, executable TypeScript extensions at runtime. With these tools
 * the agent can read the extension API by example (`read_extension`), write a
 * brand-new extension module with a default-exported `activate` function
 * (`write_extension`), and bring it live in-process (`loadExtension`) so the
 * tools, commands, and hooks it registers become immediately available — then
 * iterate on it with `reload_extension`.
 *
 * Because a loaded extension runs in-process with full authority, this power is
 * gated hard. Reading the extension directory is benign and auto-granted
 * (`self:read`), but writing and executing new code requires `self:extend`,
 * which is deliberately NOT auto-granted: by default it must be asked or denied,
 * because authoring in-process code is unbounded authority.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";

/** File extensions we treat as loadable extension modules. */
const EXT_SUFFIXES = [".ts", ".js", ".mjs", ".tsx"];

/**
 * Where self-authored extensions are written. Defaults to
 * `<workspace>/.eagent/extensions`; tests override it with the `extensionsDir`
 * store key so they can write into a temp directory.
 */
function extensionsDir(e: ExtensionAPI): string {
  const override = e.store.get<string>("extensionsDir");
  if (override) return override;
  const root = e.config.string("workspace") ?? process.cwd();
  return join(root, ".eagent", "extensions");
}

/**
 * Turn an arbitrary name into a safe kebab-case filename stem: lowercase,
 * non-alphanumerics collapsed to single hyphens, trimmed. Returns "" if nothing
 * usable survives, so callers can reject empty slugs.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

/** List the source files currently present in the extensions directory. */
function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries.sort()) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    let isFile: boolean;
    try {
      isFile = statSync(join(dir, name)).isFile();
    } catch {
      continue;
    }
    if (isFile && EXT_SUFFIXES.includes(extname(name))) out.push(name);
  }
  return out;
}

/** Snapshot the set of currently registered tool names. */
function toolNames(e: ExtensionAPI): Set<string> {
  return new Set(e.agent.tools.list().map((t) => t.spec.name));
}

/** Snapshot the set of currently registered command names. */
function commandNames(e: ExtensionAPI): Set<string> {
  return new Set(e.commands.list().map((c) => c.name));
}

/** Names present in `after` but not in `before`. */
function added(before: Set<string>, after: Set<string>): string[] {
  return [...after].filter((n) => !before.has(n)).sort();
}

export default function activate(e: ExtensionAPI): void {
  // Reading the extension directory is benign; grant it. Writing/loading
  // in-process code (self:extend) is intentionally left to ask/deny policy.
  e.grantCapability("self:read");

  e.registerTool(
    defineTool({
      name: "list_extensions",
      description:
        "List the extension source files present in the project extensions directory, plus a count of currently registered tools and commands.",
      execute: () => {
        const dir = extensionsDir(e);
        const files = listSourceFiles(dir);
        const tools = e.agent.tools.list().map((t) => t.spec.name);
        const commands = e.commands.list().map((c) => c.name);
        const body =
          `Extensions directory: ${dir}\n` +
          `Source files (${files.length}): ${files.length ? files.join(", ") : "(none)"}\n` +
          `Registered tools (${tools.length}): ${tools.join(", ")}\n` +
          `Registered commands (${commands.length}): ${commands.join(", ")}`;
        return ok(body, { dir, files, tools, commands });
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "read_extension",
      description:
        "Read the source of an extension file from the project extensions directory, so the API can be learned by example.",
      capabilities: ["self:read"],
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Extension name or filename (with or without a .ts/.js suffix).",
          },
        },
        required: ["name"],
      },
      execute: (args) => {
        const raw = typeof args.name === "string" ? args.name : "";
        if (!raw.trim()) return fail("read_extension: `name` is required.");
        const dir = extensionsDir(e);
        const requestedSuffix = EXT_SUFFIXES.includes(extname(raw)) ? extname(raw) : undefined;
        const stem = requestedSuffix ? raw.slice(0, -requestedSuffix.length) : raw;
        const slug = slugify(stem);
        if (!slug) return fail(`read_extension: "${raw}" is not a valid extension name.`);
        // Candidates are built ONLY from the sanitized slug — never the raw
        // input — so a name like "../../../../etc/hosts.js" cannot escape the
        // extensions directory. Try the requested suffix first (if any).
        const suffixes = requestedSuffix
          ? [requestedSuffix, ...EXT_SUFFIXES.filter((s) => s !== requestedSuffix)]
          : EXT_SUFFIXES;
        const root = resolve(dir);
        for (const suffix of suffixes) {
          const path = resolve(dir, slug + suffix);
          // Defense in depth: the slug is already traversal-free, but assert the
          // resolved path stays inside the extensions directory before reading.
          if (path !== root + sep + slug + suffix) continue;
          try {
            const source = readFileSync(path, "utf8");
            return ok(source, { path });
          } catch {
            // try the next candidate
          }
        }
        return fail(`read_extension: no extension named "${slug}" found in ${dir}.`);
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "write_extension",
      description:
        "Write a new TypeScript extension module (with a default-exported `activate`) to the extensions directory and load it live in-process. Reports any newly registered tools and commands. WARNING: this executes in-process code with full authority.",
      capabilities: ["self:extend"],
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Kebab-case extension name (used as the filename).",
          },
          code: {
            type: "string",
            description:
              "Full extension module source: an ESM file with `export default function activate(e) { ... }`.",
          },
        },
        required: ["name", "code"],
      },
      execute: async (args) => {
        const rawName = typeof args.name === "string" ? args.name : "";
        const code = typeof args.code === "string" ? args.code : "";
        const slug = slugify(rawName);
        if (!slug) return fail("write_extension: `name` must contain at least one alphanumeric character.");
        if (!code.trim()) return fail("write_extension: `code` is required and cannot be empty.");

        const dir = extensionsDir(e);
        const path = join(dir, `${slug}.ts`);
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(path, code, "utf8");
        } catch (err) {
          return fail(`write_extension: cannot write ${path}: ${(err as Error).message}`);
        }

        const toolsBefore = toolNames(e);
        const commandsBefore = commandNames(e);
        let id: string;
        try {
          id = await e.loadExtension(path);
        } catch (err) {
          // Leave the file on disk so the agent can inspect, fix, and retry.
          return fail(
            `write_extension: wrote ${path} but loading it failed: ${(err as Error).message}`,
            { path, loaded: false },
          );
        }

        const newTools = added(toolsBefore, toolNames(e));
        const newCommands = added(commandsBefore, commandNames(e));
        const body =
          `Loaded extension "${id}" from ${path}.\n` +
          `New tools (${newTools.length}): ${newTools.length ? newTools.join(", ") : "(none)"}\n` +
          `New commands (${newCommands.length}): ${newCommands.length ? newCommands.join(", ") : "(none)"}`;
        return ok(body, { id, path, newTools, newCommands, loaded: true });
      },
    }),
  );

  e.registerTool(
    defineTool({
      name: "reload_extension",
      description:
        "Reload a runtime-loaded extension by id: unload it, then re-load its source file to pick up edits. Reports the resulting tool and command changes. WARNING: this executes in-process code with full authority.",
      capabilities: ["self:extend"],
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The extension id (its filename stem, as returned by write_extension).",
          },
        },
        required: ["id"],
      },
      execute: async (args) => {
        const rawId = typeof args.id === "string" ? args.id : "";
        const slug = slugify(rawId);
        if (!slug) return fail("reload_extension: `id` is required.");

        const dir = extensionsDir(e);
        // Find the source file backing this id.
        let path: string | undefined;
        for (const suffix of EXT_SUFFIXES) {
          const candidate = join(dir, slug + suffix);
          try {
            if (statSync(candidate).isFile()) {
              path = candidate;
              break;
            }
          } catch {
            // try the next suffix
          }
        }
        if (!path) return fail(`reload_extension: no source file for extension "${slug}" in ${dir}.`);

        const toolsBefore = toolNames(e);
        const commandsBefore = commandNames(e);
        try {
          await e.unloadExtension(slug);
        } catch (err) {
          return fail(`reload_extension: failed to unload "${slug}": ${(err as Error).message}`);
        }
        let id: string;
        try {
          id = await e.loadExtension(path);
        } catch (err) {
          return fail(
            `reload_extension: unloaded "${slug}" but reloading ${path} failed: ${(err as Error).message}`,
            { path, loaded: false },
          );
        }

        const newTools = added(toolsBefore, toolNames(e));
        const newCommands = added(commandsBefore, commandNames(e));
        const body =
          `Reloaded extension "${id}" from ${path}.\n` +
          `New tools (${newTools.length}): ${newTools.length ? newTools.join(", ") : "(none)"}\n` +
          `New commands (${newCommands.length}): ${newCommands.length ? newCommands.join(", ") : "(none)"}`;
        return ok(body, { id, path, newTools, newCommands, loaded: true });
      },
    }),
  );

  e.registerCommand({
    name: "self",
    description: "Explain how the agent can extend itself and where extensions are written.",
    run: (ctx) => {
      const dir = extensionsDir(e);
      ctx.print(
        [
          "self — the agent extends itself (Emacs-style, at runtime):",
          "  list_extensions   list extension source files and registered tools/commands",
          "  read_extension    read an extension's source to learn the API by example",
          "  write_extension   author a new TypeScript extension and load it live (needs self:extend)",
          "  reload_extension  reload an extension to pick up edits (needs self:extend)",
          `Extensions are written to: ${dir}`,
          "Loaded extensions run in-process with full authority; self:extend is ask/deny by default.",
        ].join("\n"),
      );
    },
  });
}
