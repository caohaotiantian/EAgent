/**
 * The agent loop.
 *
 * This is the one piece that must be small, correct, and observable, because
 * everything else hangs off it. A turn is: assemble context (filterable),
 * stream from the provider, run any tool calls (guarded and ordered), append
 * results, and decide whether to continue. Two injection points — *steering*
 * (before the next call) and *follow-up* (when the loop would idle) — make the
 * running agent controllable from the outside.
 *
 * The loop holds no opinions about tools, memory, prompts, or UI. Those arrive
 * through the registries and hooks that extensions populate.
 */

import { CapabilityManager } from "./capabilities.js";
import { type KernelEvents, type KernelFilters, type ToolDecision } from "./events.js";
import { HookBus } from "./hooks.js";
import { ProviderRegistry, ToolRegistry } from "./registry.js";
import {
  type AgentHandle,
  type ContentBlock,
  type JSONSchema,
  type Logger,
  type Message,
  type StopReason,
  type ToolCallBlock,
  type ToolContext,
  type ThinkingLevel,
  type ToolResult,
  type ToolResultBlock,
  type UI,
  type Usage,
  ZERO_USAGE,
  addUsage,
} from "./types.js";
import { validate } from "./validate.js";

export interface AgentOptions {
  systemPrompt?: string;
  model?: string;
  /** Provider name to use; defaults to the registry default. */
  provider?: string;
  /** Reasoning effort forwarded to the provider; defaults to `off`. */
  thinking?: ThinkingLevel;
  /** Safety bound on loop iterations within a single `run`. */
  maxTurns?: number;
  ui?: UI;
  logger?: Logger;
  tools?: ToolRegistry;
  providers?: ProviderRegistry;
  hooks?: HookBus<KernelEvents, KernelFilters>;
  capabilities?: CapabilityManager;
}

export interface RunResult {
  reason: StopReason;
  messages: readonly Message[];
}

const DEFAULT_SYSTEM_PROMPT =
  "You are EAgent, a helpful, precise assistant. Use the available tools when they help. Keep answers tight.";

export class Agent {
  readonly hooks: HookBus<KernelEvents, KernelFilters>;
  readonly tools: ToolRegistry;
  readonly providers: ProviderRegistry;
  readonly capabilities: CapabilityManager;
  readonly ui: UI;
  readonly logger: Logger;

  systemPrompt: string;
  model: string;
  providerName: string | undefined;
  /** Reasoning effort forwarded to the provider on every turn. */
  thinking: ThinkingLevel;
  maxTurns: number;

  /** Caller-set before run(): if present, output-contract registers a respond tool whose parameters are this schema. */
  outputSchema?: JSONSchema;
  /** Caller-read after run(): the validated final output (ok) or best-effort value (ok:false). undefined when no schema was set. */
  output?: { value: unknown; ok: boolean };

  readonly #messages: Message[] = [];
  readonly #steering: Message[] = [];
  readonly #followUps: Message[] = [];
  #running = false;
  #abort: AbortController | undefined;
  #usage: Usage = { ...ZERO_USAGE };

  constructor(opts: AgentOptions = {}) {
    this.hooks = opts.hooks ?? new HookBus();
    this.tools = opts.tools ?? new ToolRegistry();
    this.providers = opts.providers ?? new ProviderRegistry();
    this.ui = opts.ui ?? defaultUI;
    this.logger = opts.logger ?? defaultLogger;
    this.capabilities = opts.capabilities ?? new CapabilityManager({ ui: this.ui });
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.model = opts.model ?? "mock";
    this.providerName = opts.provider;
    this.thinking = opts.thinking ?? "off";
    this.maxTurns = opts.maxTurns ?? 24;
  }

  get messages(): readonly Message[] {
    return this.#messages;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Cumulative token usage across every model call this agent has made. */
  get usage(): Usage {
    return { ...this.#usage };
  }

  /** The capability-limited handle exposed to tools/extensions. */
  get handle(): AgentHandle {
    return {
      model: this.model,
      messages: this.#messages,
      steer: (m) => this.steer(m),
      followUp: (m) => this.followUp(m),
    };
  }

  /** Inject a message to be seen before the next LLM call. */
  steer(message: Message): void {
    this.#steering.push(message);
  }

  /** Queue a message to be processed once the loop would otherwise stop. */
  followUp(message: Message): void {
    this.#followUps.push(message);
  }

  /** Abort an in-flight `run`. */
  stop(): void {
    this.#abort?.abort();
  }

  /** Seed transcript without running (e.g. restoring a session). */
  load(messages: Message[]): void {
    this.#messages.push(...messages);
  }

  /** Drop the transcript, keeping all registrations (start a fresh topic). */
  clear(): void {
    this.#messages.length = 0;
  }

  async run(input: string | Message): Promise<RunResult> {
    if (this.#running) throw new Error("agent is already running");
    const userMessage: Message =
      typeof input === "string" ? { role: "user", content: [{ type: "text", text: input }] } : input;
    this.#messages.push(userMessage);

    this.#abort = new AbortController();
    this.#running = true;
    let reason: StopReason = "end_turn";

    await this.hooks.emit("agent_start", { input: userMessage });
    // The user's message is a completed message appended to the transcript, so
    // it emits `message` like any other — observers (journal, renderers) see
    // every message uniformly.
    await this.hooks.emit("message", { message: userMessage });
    try {
      for (let turn = 1; turn <= this.maxTurns; turn++) {
        // Honor stop()/abort directly in the loop. The signal is passed to the
        // provider and tools, but a provider that doesn't reject on abort would
        // otherwise let the loop run on; checking here makes stop() reliable.
        // Two checks guard a turn: this one at the top of the loop, and a second
        // immediately after streamTurn (below) so an abort that lands mid-stream
        // stops us before the assistant message is appended and dispatched.
        if (this.#abort!.signal.aborted) {
          reason = "stop";
          break;
        }
        this.drainInto(this.#steering, this.#messages);
        await this.hooks.emit("turn_start", { turn });

        const assistant = await this.streamTurn(turn);
        if (this.#abort!.signal.aborted) {
          reason = "stop";
          break;
        }
        this.#messages.push(assistant.message);
        await this.hooks.emit("message", { message: assistant.message });

        const calls = assistant.message.content.filter(
          (b): b is ToolCallBlock => b.type === "tool_call",
        );

        if (calls.length === 0) {
          if (this.#followUps.length > 0) {
            this.drainInto(this.#followUps, this.#messages);
            await this.hooks.emit("turn_end", { turn });
            continue;
          }
          reason = assistant.stopReason;
          await this.hooks.emit("turn_end", { turn });
          break;
        }

        const results = await this.dispatch(calls);
        // A wave-settled, observe-only signal: the whole dispatch group as one
        // ordered value, before anything commits it to the transcript. Additive
        // to tool_end (per-tool) and turn_end (per-turn); neither is perturbed.
        await this.hooks.emit("tool_batch_end", {
          batch: results.map((r) => ({ call: r.call, result: r.result })),
        });
        const toolMessage: Message = {
          role: "tool",
          content: results.map(
            (r): ToolResultBlock => ({
              type: "tool_result",
              toolCallId: r.call.id,
              content: r.result.content,
              isError: r.result.isError,
            }),
          ),
        };
        this.#messages.push(toolMessage);
        await this.hooks.emit("message", { message: toolMessage });
        await this.hooks.emit("turn_end", { turn });

        if (results.length > 0 && results.every((r) => r.result.terminate)) {
          reason = "stop";
          break;
        }

        if (turn === this.maxTurns) {
          reason = "stop";
          await this.hooks.emit("error", {
            where: "agent.run",
            error: new Error(`maxTurns (${this.maxTurns}) reached`),
          });
        }
      }
    } catch (err) {
      reason = "error";
      await this.hooks.emit("error", { where: "agent.run", error: err });
      throw err;
    } finally {
      this.#running = false;
      this.#abort = undefined;
      await this.hooks.emit("agent_end", { reason });
    }

    return { reason, messages: this.#messages };
  }

  // -- internals ----------------------------------------------------------

  private async streamTurn(turn: number): Promise<{ message: Message; stopReason: StopReason }> {
    const provider = this.providers.get(this.providerName);
    if (!provider) throw new Error(`no provider registered (looking for ${this.providerName ?? "default"})`);

    const context = await this.hooks.apply(
      "transformContext",
      [...this.#messages],
      { turn, model: this.model },
    );

    const req = {
      systemPrompt: this.systemPrompt,
      messages: context,
      tools: this.tools.list().map((t) => t.spec),
      model: this.model,
      signal: this.#abort!.signal,
      thinking: this.thinking,
    };

    let message: Message | undefined;
    let stopReason: StopReason = "end_turn";
    let usage: Usage = { ...ZERO_USAGE };
    for await (const ev of provider.stream(req)) {
      if (ev.type === "text_delta") {
        await this.hooks.emit("text_delta", { text: ev.text });
      } else if (ev.type === "reasoning_delta") {
        await this.hooks.emit("reasoning_delta", { text: ev.text });
      } else if (ev.type === "done") {
        message = ev.message;
        stopReason = ev.stopReason;
        if (ev.usage) usage = ev.usage;
      }
    }
    if (!message) throw new Error(`provider "${provider.name}" stream ended without a "done" event`);
    this.#usage = addUsage(this.#usage, usage);
    await this.hooks.emit("usage", { usage, cumulative: { ...this.#usage } });
    return { message, stopReason };
  }

  private async dispatch(calls: ToolCallBlock[]): Promise<DispatchOutcome[]> {
    // A single sequential tool forces the whole batch to run in order; results
    // are always returned in the originally requested order regardless.
    const sequential = calls.some((c) => this.tools.get(c.name)?.executionMode === "sequential");

    if (sequential) {
      const out: DispatchOutcome[] = [];
      for (const call of calls) out.push(await this.runOne(call));
      return out;
    }
    return Promise.all(calls.map((call) => this.runOne(call)));
  }

  private async runOne(call: ToolCallBlock): Promise<DispatchOutcome> {
    await this.hooks.emit("tool_start", { call });
    let result: ToolResult;
    try {
      result = await this.executeGuarded(call);
    } catch (err) {
      result = { content: errorText(err), isError: true };
    }
    const finalResult = await this.hooks.apply("afterToolCall", result, { call });
    await this.hooks.emit("tool_end", { call, result: finalResult });
    return { call, result: finalResult };
  }

  private async executeGuarded(call: ToolCallBlock): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    const { ok, value, errors } = validate(tool.spec.parameters, call.arguments);
    const args = (ok ? value : call.arguments) as Record<string, unknown>;

    const decision: ToolDecision = { block: false, arguments: args };
    const decided = await this.hooks.apply(
      "beforeToolCall",
      decision,
      { call },
      (d) => d.block,
    );
    if (decided.block) {
      return { content: `Tool call blocked: ${decided.reason ?? "no reason given"}`, isError: true };
    }
    if (!ok) {
      return { content: `Invalid arguments for ${call.name}:\n- ${errors.join("\n- ")}`, isError: true };
    }

    for (const cap of tool.capabilities ?? []) {
      await this.capabilities.require(cap, tool.spec.name);
    }

    // A beforeToolCall guard may have rewritten the arguments; re-validate so the
    // tool still receives schema-clean, coerced input — the kernel's contract —
    // even after a guard injected or changed fields.
    const final = validate(tool.spec.parameters, decided.arguments);
    if (!final.ok) {
      return { content: `Invalid arguments for ${call.name} (after guards):\n- ${final.errors.join("\n- ")}`, isError: true };
    }

    const ctx: ToolContext = {
      toolCallId: call.id,
      signal: this.#abort!.signal,
      require: (cap) => this.capabilities.require(cap, tool.spec.name),
      progress: (chunk) => this.logger.debug(`[${tool.spec.name}] ${chunk}`),
      ui: this.ui,
      agent: this.handle,
      log: this.logger,
    };
    return tool.execute(final.value as Record<string, unknown>, ctx);
  }

  private drainInto(from: Message[], to: Message[]): void {
    if (from.length === 0) return;
    to.push(...from.splice(0, from.length));
  }
}

interface DispatchOutcome {
  call: ToolCallBlock;
  result: ToolResult;
}

function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

// Renderless defaults so the kernel is usable headless (tests, SDK embedding).

const defaultLogger: Logger = {
  debug: () => {},
  info: (...a) => console.error("[eagent]", ...a),
  warn: (...a) => console.error("[eagent:warn]", ...a),
  error: (...a) => console.error("[eagent:error]", ...a),
};

const defaultUI: UI = {
  // Headless default denies prompts rather than blocking on stdin.
  confirm: async () => false,
  notify: (m) => defaultLogger.info(m),
};

export type { ContentBlock };
