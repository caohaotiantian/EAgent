/**
 * A real provider for the Anthropic Messages API, over `fetch` and SSE — no
 * SDK, no extra dependency. It maps EAgent's neutral message/tool shapes to
 * Anthropic's wire format and parses the streaming response back into the
 * kernel's `StreamEvent`s.
 *
 * Configuration is by environment, so the CLI can pick it up automatically:
 *   ANTHROPIC_API_KEY   (required for live use)
 *   ANTHROPIC_BASE_URL  (optional; defaults to https://api.anthropic.com)
 */

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolSpec,
} from "../kernel/types.js";

export interface AnthropicOptions {
  apiKey?: string;
  baseUrl?: string;
  version?: string;
  maxTokens?: number;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #version: string;
  readonly #maxTokens: number;

  constructor(opts: AnthropicOptions = {}) {
    this.#apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.#baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.#version = opts.version ?? "2023-06-01";
    this.#maxTokens = opts.maxTokens ?? 4096;
  }

  get configured(): boolean {
    return this.#apiKey.length > 0;
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (!this.#apiKey) throw new Error("AnthropicProvider: ANTHROPIC_API_KEY is not set");

    const body = {
      model: req.model,
      max_tokens: this.#maxTokens,
      system: req.systemPrompt,
      messages: toAnthropicMessages(req.messages),
      tools: req.tools.map(toAnthropicTool),
      stream: true,
    };

    const res = await fetch(`${this.#baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.#apiKey,
        "anthropic-version": this.#version,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      throw new Error(`Anthropic API error ${res.status}: ${detail}`);
    }

    // Assemble blocks as they stream in.
    const blocks = new Map<number, { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string }>();
    let stopReason: StopReason = "end_turn";

    for await (const event of parseSSE(res.body)) {
      const data = event.data;
      if (!data || data === "[DONE]") continue;
      let parsed: AnthropicStreamEvent;
      try {
        parsed = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (parsed.type) {
        case "content_block_start": {
          const cb = parsed.content_block;
          if (cb.type === "text") blocks.set(parsed.index, { type: "text", text: "" });
          else if (cb.type === "tool_use")
            blocks.set(parsed.index, { type: "tool_use", id: cb.id, name: cb.name, json: "" });
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(parsed.index);
          if (!block) break;
          if (parsed.delta.type === "text_delta" && block.type === "text") {
            block.text += parsed.delta.text;
            yield { type: "text_delta", text: parsed.delta.text };
          } else if (parsed.delta.type === "input_json_delta" && block.type === "tool_use") {
            block.json += parsed.delta.partial_json;
          }
          break;
        }
        case "message_delta": {
          if (parsed.delta.stop_reason) stopReason = mapStopReason(parsed.delta.stop_reason);
          break;
        }
        default:
          break;
      }
    }

    const content: ContentBlock[] = [];
    for (const block of [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)) {
      if (block.type === "text") {
        content.push({ type: "text", text: block.text });
      } else {
        let args: Record<string, unknown> = {};
        try {
          args = block.json ? (JSON.parse(block.json) as Record<string, unknown>) : {};
        } catch {
          args = {};
        }
        content.push({ type: "tool_call", id: block.id, name: block.name, arguments: args });
        yield { type: "tool_call", id: block.id, name: block.name, arguments: args };
      }
    }

    yield { type: "done", message: { role: "assistant", content }, stopReason };
  }
}

// -- wire-format mapping ----------------------------------------------------

function toAnthropicTool(spec: ToolSpec): unknown {
  return { name: spec.name, description: spec.description, input_schema: spec.parameters };
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // carried via top-level `system`
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: m.content
          .filter((b) => b.type === "tool_result")
          .map((b) => {
            const r = b as Extract<ContentBlock, { type: "tool_result" }>;
            return { type: "tool_result", tool_use_id: r.toolCallId, content: r.content, is_error: r.isError ?? false };
          }),
      });
      continue;
    }
    out.push({
      role: m.role,
      content: m.content.map((b) => {
        if (b.type === "text") return { type: "text", text: b.text };
        if (b.type === "tool_call") return { type: "tool_use", id: b.id, name: b.name, input: b.arguments };
        return { type: "text", text: "" };
      }),
    });
  }
  return out;
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stop";
  }
}

// -- SSE parsing ------------------------------------------------------------

interface SSEMessage {
  event?: string;
  data: string;
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<SSEMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const msg: SSEMessage = { data: "" };
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) msg.event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      msg.data = dataLines.join("\n");
      yield msg;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return res.statusText;
  }
}

// -- minimal stream-event typings -------------------------------------------

type AnthropicStreamEvent =
  | { type: "content_block_start"; index: number; content_block: { type: "text" } | { type: "tool_use"; id: string; name: string } }
  | { type: "content_block_delta"; index: number; delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } }
  | { type: "message_delta"; delta: { stop_reason?: string } }
  | { type: "message_start" | "message_stop" | "content_block_stop" | "ping" };
