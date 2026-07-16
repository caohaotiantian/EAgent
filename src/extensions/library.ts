/**
 * `/library` — install the in-repo official agent library into a resource tier.
 *
 * The layered-resource model made `library/` opt-in: a user enables an offering
 * by copying `library/<kind>/*` into a tier the loader scans. This command
 * automates that copy. `list` shows the offerings; `install [--home|--project]
 * [kind...]` copies them into the home (`~/.eagent/<kind>`) or project
 * (`<cwd>/.eagent/<kind>`, default) tier. The concrete target for each kind is
 * taken from `resourceDirs(config, kind)` so it always equals a location the
 * layered read actually scans — including `microagents`' workspace-rooted tier
 * and any `<kind>.dir` override (which collapses the tier choice to that one dir).
 *
 * The source is `config.string("library.dir") ?? <cwd>/library`. A *distributed*
 * binary has no `library/` beside it, so `/library install` is a repo/dev
 * convenience unless `library.dir` points at a shipped copy — it reports cleanly
 * when no source is found.
 *
 * Never clobbers: an existing same-named entry is skipped and reported. Copying
 * uses `cpSync(..., { recursive: true })`, which handles both a flat `.md` file
 * and a skill *bundle directory*. The install path requires `fs:write` (commands
 * are not auto-gated like tools, so the handler enforces it itself). Kill switch:
 * `EAGENT_LIBRARY=off`.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { CapabilityError } from "../kernel/capabilities.js";
import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";

import { resourceDirs, type ResourceKind } from "./lib/resource-dirs.js";

const KINDS: ResourceKind[] = ["templates", "teams", "skills", "microagents"];

/** The top-level entry names under `<src>/<kind>` (files or bundle dirs), or []. */
function entriesOf(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

export default function activate(e: ExtensionAPI): void {
  const enabled = (): boolean => e.config.enabled("library", { default: true });
  const librarySrc = (): string => e.config.string("library.dir") ?? join(process.cwd(), "library");

  e.registerCommand({
    name: "library",
    description:
      "Install the official agent library into a resource tier: list, install [--home|--project] [kind...].",
    run: async (ctx: CommandContext): Promise<void> => {
      if (!enabled()) {
        ctx.print("library is disabled (EAGENT_LIBRARY=off).");
        return;
      }

      const argv = ctx.args.trim().split(/\s+/).filter((s) => s.length > 0);
      const sub = argv[0] ?? "list";
      const src = librarySrc();

      if (sub === "list") {
        if (!existsSync(src)) {
          ctx.print(`no library found at ${src}; set \`library.dir\`.`);
          return;
        }
        for (const kind of KINDS) {
          const names = entriesOf(join(src, kind));
          ctx.print(`  ${kind.padEnd(12)} ${names.length}${names.length ? "  " + names.join(", ") : ""}`);
        }
        return;
      }

      if (sub === "install") {
        const rest = argv.slice(1);
        const tier: "home" | "project" = rest.includes("--home") ? "home" : "project";
        const kindArgs = rest.filter((a) => !a.startsWith("--"));
        const unknown = kindArgs.filter((k) => !KINDS.includes(k as ResourceKind));
        if (unknown.length > 0) {
          ctx.print(`unknown kind(s): ${unknown.join(", ")} (valid: ${KINDS.join(", ")})`);
          return;
        }
        const kinds = kindArgs.length > 0 ? (kindArgs as ResourceKind[]) : KINDS;

        if (!existsSync(src)) {
          ctx.print(`no library found at ${src}; set \`library.dir\`.`);
          return;
        }

        try {
          await e.agent.capabilities.require("fs:write", "library");
        } catch (err) {
          if (err instanceof CapabilityError) {
            ctx.print(`Cannot install: ${err.message}`);
            return;
          }
          throw err;
        }

        for (const kind of kinds) {
          const kindDir = join(src, kind);
          const dirs = resourceDirs(e.config, kind);
          const target = tier === "home" ? dirs[0]! : (dirs[1] ?? dirs[0]!);
          const entries = entriesOf(kindDir);
          let copied = 0;
          let skipped = 0;
          if (entries.length > 0) mkdirSync(target, { recursive: true });
          for (const name of entries) {
            const dst = join(target, name);
            if (existsSync(dst)) {
              skipped++;
            } else {
              cpSync(join(kindDir, name), dst, { recursive: true });
              copied++;
            }
          }
          ctx.print(`  ${kind.padEnd(12)} copied ${copied}, skipped (exists) ${skipped} -> ${target}`);
        }
        return;
      }

      ctx.print("usage: /library list | install [--home|--project] [templates teams skills microagents]");
    },
  });
}
