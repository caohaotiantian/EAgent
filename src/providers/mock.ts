/**
 * A deterministic, scriptable provider.
 *
 * This is what makes the kernel testable and demoable without a network or an
 * API key. You hand it a script of turns — text and/or tool calls — and it
 * replays them as a proper event stream. With no script it simply echoes the
 * last user message, which is enough to drive the CLI offline.
 */

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
} from "../kernel/types.js";

export interface MockToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  id?: string;
}

export interface MockTurn {
  text?: string;
  toolCalls?: MockToolCall[];
}

export type MockResponder =
  | MockTurn
  | MockTurn[]
  | ((req: CompletionRequest, turnIndex: number) => MockTurn | undefined);

export class MockProvider implements Provider {
  readonly name = "mock";
  #turn = 0;
  #queue: MockTurn[] | undefined;
  #fn: ((req: CompletionRequest, i: number) => MockTurn | undefined) | undefined;

  constructor(responder?: MockResponder) {
    if (typeof responder === "function") this.#fn = responder;
    else if (Array.isArray(responder)) this.#queue = [...responder];
    else if (responder) this.#queue = [responder];
  }

  /** Replace the script and reset the turn counter (handy between tests). */
  script(responder: MockResponder): this {
    this.#turn = 0;
    this.#queue = undefined;
    this.#fn = undefined;
    if (typeof responder === "function") this.#fn = responder;
    else if (Array.isArray(responder)) this.#queue = [...responder];
    else this.#queue = [responder];
    return this;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    const turn = this.nextTurn(req);
    const content: ContentBlock[] = [];

    if (turn.text) {
      for (const chunk of chunkText(turn.text)) {
        if (req.signal.aborted) break;
        yield { type: "text_delta", text: chunk };
      }
      content.push({ type: "text", text: turn.text });
    }

    for (const [i, call] of (turn.toolCalls ?? []).entries()) {
      const id = call.id ?? `mock_${this.#turn}_${i}`;
      const args = call.arguments ?? {};
      content.push({ type: "tool_call", id, name: call.name, arguments: args });
      yield { type: "tool_call", id, name: call.name, arguments: args };
    }

    const stopReason: StopReason = (turn.toolCalls?.length ?? 0) > 0 ? "tool_use" : "end_turn";
    const message: Message = { role: "assistant", content };
    yield { type: "done", message, stopReason };
  }

  private nextTurn(req: CompletionRequest): MockTurn {
    const i = this.#turn++;
    if (this.#fn) return this.#fn(req, i) ?? { text: "" };
    if (this.#queue) return this.#queue[i] ?? { text: "" };
    return { text: echo(req.messages) };
  }
}

function echo(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const t = m.content.find((b) => b.type === "text");
    if (t && t.type === "text") return `(mock) you said: ${t.text}`;
  }
  return "(mock) hello";
}

function chunkText(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [text];
}
