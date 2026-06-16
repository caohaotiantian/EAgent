/**
 * Saved prompt templates — Emacs abbrevs / keyboard macros for an agent, and
 * the user-controlled "prompts" primitive that MCP also defines.
 *
 * You save a reusable prompt with placeholders (`$1`, `$2`, `$*`) and invoke it
 * by name with arguments. `/prompt review src/foo.ts` expands a stored template
 * and runs it as a turn. Templates persist in the extension's `store`, so they
 * survive restarts. Like the rest of the system this is pure extension: it adds
 * commands and reads/writes its own state, touching nothing in the core.
 */

import type { ExtensionAPI } from "../kernel/extension.js";

type Templates = Record<string, string>;

export default function activate(e: ExtensionAPI): void {
  const read = (): Templates => e.store.get<Templates>("templates", {}) ?? {};
  const write = (t: Templates): void => e.store.set("templates", t);

  e.registerCommand({
    name: "prompt-save",
    description: "Save a prompt template. Usage: /prompt-save <name> <template with $1 $2 $*>",
    run: (ctx) => {
      const name = ctx.args.trim().split(/\s+/, 1)[0] ?? "";
      const template = ctx.args.trim().slice(name.length).trim();
      if (!name || !template) {
        ctx.print("usage: /prompt-save <name> <template>");
        return;
      }
      const t = read();
      t[name] = template;
      write(t);
      ctx.print(`saved prompt "${name}".`);
    },
  });

  e.registerCommand({
    name: "prompts",
    description: "List saved prompt templates.",
    run: (ctx) => {
      const t = read();
      const names = Object.keys(t).sort();
      ctx.print(names.length ? names.map((n) => `  ${n.padEnd(16)} ${t[n]}`).join("\n") : "(no saved prompts)");
    },
  });

  e.registerCommand({
    name: "prompt-remove",
    description: "Delete a saved prompt template. Usage: /prompt-remove <name>",
    run: (ctx) => {
      const name = ctx.args.trim();
      const t = read();
      if (!(name in t)) {
        ctx.print(`no prompt named "${name}".`);
        return;
      }
      delete t[name];
      write(t);
      ctx.print(`removed "${name}".`);
    },
  });

  e.registerCommand({
    name: "prompt",
    description: "Expand a saved prompt with arguments and run it. Usage: /prompt <name> [args...]",
    run: async (ctx) => {
      const [name, ...args] = ctx.args.trim().split(/\s+/);
      if (!name) {
        ctx.print("usage: /prompt <name> [args...]");
        return;
      }
      const template = read()[name];
      if (template === undefined) {
        ctx.print(`no prompt named "${name}". Try /prompts.`);
        return;
      }
      const expanded = expand(template, args);
      await ctx.agent.run(expanded);
    },
  });
}

/** Substitute `$1`, `$2`, … with positional args and `$*` with all of them. */
export function expand(template: string, args: string[]): string {
  return template
    .replace(/\$\*/g, args.join(" "))
    .replace(/\$(\d+)/g, (_m, d: string) => args[Number(d) - 1] ?? "");
}
