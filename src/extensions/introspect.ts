/**
 * Self-documentation — EAgent's answer to Emacs's `describe-function` and
 * `apropos`.
 *
 * A malleable system is only usable if it can explain itself. This extension
 * lets both the human (via `/describe` and `/apropos`) and the agent (via the
 * `describe_tool` tool) inspect the live tool and command surface: descriptions,
 * JSON schemas, and the capabilities each tool requires. Nothing here is
 * privileged — introspection is always safe.
 */

import { defineTool, fail, ok } from "../kernel/define.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { Tool } from "../kernel/types.js";

export default function activate(e: ExtensionAPI): void {
  const describeTool = (t: Tool): string => {
    const caps = t.capabilities?.length ? `\ncapabilities: ${t.capabilities.join(", ")}` : "";
    const mode = t.executionMode ? `\nexecution: ${t.executionMode}` : "";
    const schema = JSON.stringify(t.spec.parameters, null, 2);
    return `tool ${t.spec.name}\n${t.spec.description}${caps}${mode}\nparameters:\n${schema}`;
  };

  // The agent can introspect its own tools — useful before composing a call.
  e.registerTool(
    defineTool({
      name: "describe_tool",
      description: "Return the description, JSON schema, and required capabilities of a registered tool.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Tool name to describe." } },
        required: ["name"],
      },
      execute: (args) => {
        const t = e.agent.tools.get(String(args.name));
        return t ? ok(describeTool(t)) : fail(`No tool named "${String(args.name)}".`);
      },
    }),
  );

  e.registerCommand({
    name: "describe",
    description: "Describe a tool or command in detail. Usage: /describe <name>",
    run: (ctx) => {
      const name = ctx.args.trim();
      if (!name) {
        ctx.print("usage: /describe <tool-or-command-name>");
        return;
      }
      const tool = ctx.agent.tools.get(name);
      if (tool) {
        ctx.print(describeTool(tool));
        return;
      }
      const command = e.commands.get(name);
      if (command) {
        ctx.print(`command /${command.name}\n${command.description}`);
        return;
      }
      ctx.print(`Nothing named "${name}". Try /apropos ${name} to search the available tools and commands.`);
    },
  });

  e.registerCommand({
    name: "apropos",
    description: "Search tools and commands by keyword. Usage: /apropos <keyword>",
    run: (ctx) => {
      const q = ctx.args.trim().toLowerCase();
      if (!q) {
        ctx.print("usage: /apropos <keyword>");
        return;
      }
      const hit = (name: string, desc: string) => name.toLowerCase().includes(q) || desc.toLowerCase().includes(q);
      const tools = ctx.agent.tools.list().filter((t) => hit(t.spec.name, t.spec.description));
      const commands = e.commands.list().filter((c) => hit(c.name, c.description));
      const lines: string[] = [];
      for (const t of tools) lines.push(`  tool  ${t.spec.name.padEnd(16)} ${t.spec.description}`);
      for (const c of commands) lines.push(`  cmd   /${c.name.padEnd(15)} ${c.description}`);
      ctx.print(lines.length ? lines.join("\n") : `nothing matches "${q}".`);
    },
  });
}
