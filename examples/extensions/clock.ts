/**
 * Example extension: clock & guardrails.
 *
 * A single file that exercises most of the ExtensionAPI, meant to be read as a
 * worked example. Load it with:
 *
 *     eagent --ext examples/extensions/clock.ts
 *
 * or drop it into `.eagent/extensions/` to have it auto-discovered, then edit
 * it and run `/reload` to see live redefinition.
 */

import { defineTool, ok } from "../../src/kernel/define.js";
import type { ExtensionAPI } from "../../src/kernel/extension.js";

export default function activate(e: ExtensionAPI) {
  // Persistent state survives reloads (it lives in the extension's store).
  const runs = (e.store.get<number>("activations") ?? 0) + 1;
  e.store.set("activations", runs);
  e.log.info(`clock activated (activation #${runs})`);

  // 1. A tool the model can call.
  e.registerTool(
    defineTool({
      name: "now",
      description: "Return the current date and time in ISO 8601.",
      execute: () => ok(new Date().toISOString()),
    }),
  );

  // 2. Context shaping: make the agent always aware of the current time.
  e.hook("transformContext", (messages) => [
    {
      role: "system",
      content: [{ type: "text", text: `The current time is ${new Date().toISOString()}.` }],
      meta: { ephemeral: true, source: "clock" },
    },
    ...messages,
  ]);

  // 3. A safety guard: veto obviously destructive shell commands. This is the
  //    "advice" pattern — wrap behavior without touching the bash tool itself.
  e.hook("beforeToolCall", (decision, { call }) => {
    if (call.name !== "bash") return decision;
    const command = String(call.arguments.command ?? "");
    if (/\brm\s+-rf\s+[~/]/.test(command)) {
      return { ...decision, block: true, reason: "refusing to delete from a root or home path" };
    }
    return decision;
  });

  // 4. A user-facing command.
  e.registerCommand({
    name: "uptime",
    // `runs` is the activation-count snapshot taken at activation time, not a
    // live store read — so this prints the same number for the whole session.
    // Scope is this extension's store namespace (process lifetime under
    // MemoryBackend; the ~/.eagent/state file under FileBackend), not the host.
    description: "How many times this extension has been activated.",
    run: (ctx) =>
      ctx.print(`clock had been activated ${runs} time(s) in this extension's store at activation.`),
  });

  // Optional cleanup, run on unload/reload.
  return () => e.log.info("clock deactivated");
}
