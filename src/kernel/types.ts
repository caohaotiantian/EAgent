/**
 * The vocabulary of the kernel.
 *
 * These types are the stable contract between the core and every extension.
 * The guiding rule (borrowed from VS Code's `vscode.d.ts` discipline): this
 * surface changes rarely and never breaks. Policy lives in extensions; only
 * primitives live here.
 */

// ---------------------------------------------------------------------------
// Conversation model
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolCallId: string;
  /** Rendered, model-legible result text. */
  content: string;
  isError?: boolean;
}

/**
 * A reasoning ("thinking") block emitted by a model that exposes its chain of
 * thought. `signature` is an opaque provider token (Anthropic) that must be
 * echoed back verbatim when the block is replayed in a later turn — preserving
 * it is what keeps multi-turn tool use valid under extended thinking. The kernel
 * treats both fields opaquely; providers that don't reason simply never produce
 * one.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

/**
 * An image, supplied either inline (base64 in `data`) or by reference (`url`).
 * Providers map it to their own multimodal format; text-only providers and the
 * mock simply account for it. The kernel treats it opaquely.
 */
export interface ImageBlock {
  type: "image";
  /** MIME type, e.g. "image/png" (required for base64 data). */
  mimeType: string;
  /** Base64-encoded bytes (no `data:` prefix). Use this or `url`. */
  data?: string;
  /** A URL to the image, as an alternative to inline `data`. */
  url?: string;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | ThinkingBlock | ImageBlock;

/** Build a user message carrying an image (plus optional caption text). */
export function imageMessage(image: Omit<ImageBlock, "type">, caption?: string): Message {
  const content: ContentBlock[] = [{ type: "image", ...image }];
  if (caption) content.unshift({ type: "text", text: caption });
  return { role: "user", content };
}

/**
 * A message in the running transcript.
 *
 * `meta` is an escape hatch for extensions to stash app-specific data on a
 * message without the kernel needing to know about it (Emacs text-property
 * spirit). The kernel ignores it; `Provider.stream` never sees it.
 */
export interface Message {
  role: Role;
  content: ContentBlock[];
  meta?: Record<string, unknown>;
}

export function text(role: Role, body: string): Message {
  return { role, content: [{ type: "text", text: body }] };
}

const ROLES: readonly Role[] = ["system", "user", "assistant", "tool"];

/**
 * Runtime guard that a parsed value is a structurally valid `Message`. Used when
 * loading transcripts from disk (sessions, journals): a corrupt-but-valid-JSON
 * entry must be rejected at the boundary rather than crash a later turn that
 * assumes `message.content` is an array.
 */
export function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false;
  const m = value as { role?: unknown; content?: unknown };
  return typeof m.role === "string" && (ROLES as readonly string[]).includes(m.role) && Array.isArray(m.content);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** A minimal JSON-Schema subset — enough to describe and validate tool inputs. */
export interface JSONSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  default?: unknown;
  [extra: string]: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON-Schema object describing the tool's arguments. */
  parameters: JSONSchema;
}

export interface ToolResult {
  /** Model-legible result text. */
  content: string;
  isError?: boolean;
  /** Structured payload for renderers/telemetry; never sent to the model. */
  details?: unknown;
  /**
   * If true, the loop will not make an automatic follow-up LLM call after this
   * tool. In a parallel batch it is honored only if every tool requests it.
   */
  terminate?: boolean;
}

export interface Tool {
  spec: ToolSpec;
  /**
   * `parallel` (default) tools may run concurrently within a turn. A single
   * `sequential` tool in a batch forces the whole batch to run in order.
   */
  executionMode?: "parallel" | "sequential";
  /** Capabilities this tool needs; enforced via `ctx.require` at call time. */
  capabilities?: string[];
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** The environment handed to a tool at call time. */
export interface ToolContext {
  readonly toolCallId: string;
  readonly signal: AbortSignal;
  /** Request a capability; rejects with `CapabilityError` if denied. */
  require(capability: string): Promise<void>;
  /** Stream incremental progress to renderers (optional). */
  progress(chunk: string): void;
  readonly ui: UI;
  readonly agent: AgentHandle;
  readonly log: Logger;
}

// ---------------------------------------------------------------------------
// Providers (LLM abstraction)
// ---------------------------------------------------------------------------

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop" | "error";

/**
 * A normalized reasoning-effort dial. The kernel speaks one neutral vocabulary;
 * each provider maps it to its own native control — Anthropic's `output_config`
 * effort + adaptive thinking, OpenAI's `reasoning_effort`, Gemini's thinking
 * budget. `off` means "don't ask the model to reason"; providers whose models
 * always reason (e.g. Claude Fable) simply fall back to their default.
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/** Token accounting for a completion. Providers report it; the agent sums it. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export function totalTokens(u: Usage): number {
  return u.inputTokens + u.outputTokens;
}

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "done"; message: Message; stopReason: StopReason; usage?: Usage };

export interface CompletionRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSpec[];
  model: string;
  signal: AbortSignal;
  /** Requested reasoning effort; a provider maps it to its native control. */
  thinking?: ThinkingLevel;
}

/**
 * The only thing the kernel knows about an LLM: it turns a request into a
 * stream of events ending in exactly one `done`. Anthropic, OpenAI, a local
 * model, or a deterministic mock all satisfy this same shape.
 */
export interface Provider {
  readonly name: string;
  stream(req: CompletionRequest): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// Ambient services exposed to tools/extensions
// ---------------------------------------------------------------------------

export interface UI {
  /** Ask the human a yes/no question. Resolves to the decision. */
  confirm(question: string): Promise<boolean>;
  notify(message: string): void;
}

export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** The slice of the running agent that tools/extensions are allowed to touch. */
export interface AgentHandle {
  readonly model: string;
  readonly messages: readonly Message[];
  /** Inject a message before the next LLM call (interruption/correction). */
  steer(message: Message): void;
  /** Queue a message to be processed once the loop would otherwise idle. */
  followUp(message: Message): void;
}

// ---------------------------------------------------------------------------
// Disposables
// ---------------------------------------------------------------------------

/** Every registration returns one of these so a reload can cleanly undo it. */
export interface Disposable {
  dispose(): void;
}

export function combine(...disposables: Disposable[]): Disposable {
  return {
    dispose() {
      for (const d of disposables.reverse()) {
        try {
          d.dispose();
        } catch {
          // a failing teardown must not block the others
        }
      }
    },
  };
}
