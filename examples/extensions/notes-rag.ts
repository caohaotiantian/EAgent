/**
 * Example extension: retrieval-augmented context (the RAG pattern).
 *
 * `transformContext` is the seam where you reshape the prompt just before it
 * reaches the model. Here we use it to retrieve relevant "notes" and inject them
 * as a system message — the same place the built-in `memory` and `context-files`
 * extensions hook in. Swap the in-memory store for a vector DB and this is a
 * real RAG pipeline, with zero changes to the kernel.
 *
 * A `note` tool lets the conversation add to the corpus; the hook retrieves the
 * notes whose keywords overlap the latest user message.
 *
 *   eagent --ext examples/extensions/notes-rag.ts
 */

import { defineTool, ok } from "../../src/kernel/define.js";
import type { ExtensionAPI } from "../../src/kernel/extension.js";
import type { Message } from "../../src/kernel/types.js";

export default function activate(e: ExtensionAPI) {
  const notes = (): string[] => e.store.get<string[]>("notes", []) ?? [];

  e.registerTool(
    defineTool({
      name: "note",
      description: "Save a short note for later retrieval into context.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => {
        const all = notes();
        all.push(String(args.text));
        e.store.set("notes", all);
        return ok(`noted (${all.length} total)`);
      },
    }),
  );

  // Retrieve notes overlapping the latest user message and inject them.
  e.hook("transformContext", (messages) => {
    const all = notes();
    if (all.length === 0) return messages;
    const query = latestUserText(messages).toLowerCase();
    const words = new Set(query.split(/\W+/).filter((w) => w.length > 3));
    const relevant = all.filter((n) => n.toLowerCase().split(/\W+/).some((w) => words.has(w)));
    if (relevant.length === 0) return messages;
    const note: Message = {
      role: "system",
      content: [{ type: "text", text: `Relevant notes:\n${relevant.map((n) => `- ${n}`).join("\n")}` }],
      meta: { source: "notes-rag", ephemeral: true },
    };
    return [note, ...messages];
  });
}

function latestUserText(messages: readonly Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return t.text;
  }
  return "";
}
