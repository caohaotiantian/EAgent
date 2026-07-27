/**
 * Hydrate Chat turns + view-model sections from a server transcript (Message[]).
 * Pure — offline-testable. Tool results are matched to tool_call blocks by id.
 */

import { initialModel, type DisplayMode, type Section, type ViewModel } from "@eagent/view-model";

/** Minimal message shape (matches kernel Message; kept local so web does not import kernel). */
export type HistoryMessage = {
  role: string;
  content: Array<Record<string, unknown>>;
};

export type ChatTurn = {
  id: string;
  user: string;
  sectionFrom: number;
};

export type HydratedChat = {
  turns: ChatTurn[];
  model: ViewModel;
};

function textFromContent(content: Array<Record<string, unknown>>): string {
  return content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n");
}

/**
 * Convert server `messages` into Chat turns (user prompts) + completed sections
 * (reasoning / answer / tools) for the collapsible transcript.
 */
export function hydrateFromMessages(messages: HistoryMessage[], mode: DisplayMode = "auto"): HydratedChat {
  const turns: ChatTurn[] = [];
  const sections: Section[] = [];
  let seq = 0;
  const nextId = (): string => `h${seq++}`;
  const ts = 0;
  const openTools = new Map<string, Extract<Section, { kind: "tool" }>>();

  const pushText = (kind: "reasoning" | "answer", text: string, collapsed: boolean): void => {
    if (!text) return;
    sections.push({
      id: nextId(),
      kind,
      actingId: "root",
      rootId: "root",
      status: "success",
      startTs: ts,
      lastTs: ts,
      collapsed,
      children: [],
      text,
    });
  };

  for (const msg of messages) {
    if (msg.role === "system") continue;

    if (msg.role === "user") {
      const text = textFromContent(msg.content);
      turns.push({ id: nextId(), user: text || "(empty)", sectionFrom: sections.length });
      continue;
    }

    if (msg.role === "assistant") {
      for (const b of msg.content) {
        if (b.type === "thinking" && typeof b.thinking === "string") {
          pushText("reasoning", b.thinking, true);
        } else if (b.type === "text" && typeof b.text === "string") {
          pushText("answer", b.text, false);
        } else if (b.type === "tool_call") {
          const callId = String(b.id ?? nextId());
          const card: Extract<Section, { kind: "tool" }> = {
            id: nextId(),
            kind: "tool",
            actingId: "root",
            rootId: "root",
            status: "success",
            startTs: ts,
            lastTs: ts,
            collapsed: true,
            children: [],
            name: String(b.name ?? "tool"),
            callId,
            arguments: (b.arguments as Record<string, unknown>) ?? {},
            spawn: false,
          };
          openTools.set(callId, card);
          sections.push(card);
        }
      }
      continue;
    }

    if (msg.role === "tool") {
      for (const b of msg.content) {
        if (b.type !== "tool_result") continue;
        const callId = String(b.toolCallId ?? "");
        const card = openTools.get(callId);
        if (!card) continue;
        const isError = Boolean(b.isError);
        card.result = { content: String(b.content ?? ""), isError };
        card.status = isError ? "error" : "success";
      }
    }
  }

  // If transcript has assistant/tool content before any user message, still show it.
  if (turns.length === 0 && sections.length > 0) {
    turns.push({ id: nextId(), user: "(prior context)", sectionFrom: 0 });
  }

  const model = initialModel(mode);
  model.sections = sections;
  model.seq = seq;
  model.done = true;
  model.rootId = "root";

  return { turns, model };
}
