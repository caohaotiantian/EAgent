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

import { AsyncLocalStorage } from "node:async_hooks";
import { CapabilityManager } from "./capabilities.js";
import { type KernelEvents, type KernelFilters, type ToolDecision } from "./events.js";
import { HookBus } from "./hooks.js";
import { ProviderRegistry, ToolRegistry } from "./registry.js";
import {
  type AgentHandle,
  type AgentState,
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
  /** Upper bound on tools run concurrently within one parallel wave; defaults to `Infinity`. */
  maxConcurrency?: number;
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

/**
 * Hard safety bound on `onProviderError` re-streams within a single turn,
 * regardless of what a handler returns — a buggy handler returning perpetual
 * `retry:true` cannot spin forever. `attempt` starts at 1.
 */
const MAX_PROVIDER_RETRIES = 6;

/** Ambient acting-agent context: `run()` binds `this`, so a childScope guard reads the running agent + a `WeakMap` key under concurrent forks. */
const actingAgentStore = new AsyncLocalStorage<Agent>();
export const currentActingAgent = (): Agent | undefined => actingAgentStore.getStore();

/** Ambient run-tree root: set once at the top-level `run()` and inherited (never overwritten) by forks, so session-scoped state keys per session and root-detection is concurrency-safe. */
const rootAgentStore = new AsyncLocalStorage<Agent>();
export const currentRootAgent = (): Agent | undefined => rootAgentStore.getStore();

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
  /** Cap on tools dispatched concurrently within a parallel wave; `Infinity` (default) preserves full parallelism. */
  maxConcurrency: number;

  /** Caller-set before run(): if present, output-contract registers a respond tool whose parameters are this schema. */
  outputSchema?: JSONSchema;
  /** Caller-read after run(): the validated final output (ok) or best-effort value (ok:false). undefined when no schema was set. */
  output?: { value: unknown; ok: boolean };

  /**
   * The name of a tool the model MUST call on the NEXT request, or `undefined`
   * for the model's free choice. A public mutable field re-read at the top of
   * each turn (mirroring `Agent.model`, which `routing` rides). The only thing
   * the loop does with it is map a set value to `CompletionRequest.toolChoice`;
   * it is inert while `undefined`, so the default behavior is unchanged. Its one
   * live consumer is `output-contract`, which sets it to `"respond"` on a
   * corrective turn to compel the final-output call, then clears it.
   */
  forceTool?: string;

  readonly #messages: Message[] = [];
  readonly #steering: Message[] = [];
  readonly #followUps: Message[] = [];
  #running = false;
  #abort: AbortController | undefined;
  #usage: Usage = { ...ZERO_USAGE };
  /** Monotonic per-run turn counter, incremented once per turn at `turn_end`. */
  #step = 0;

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
    this.maxConcurrency = Math.max(1, opts.maxConcurrency ?? Infinity);
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
      // A frozen shallow copy: a tool cannot add/remove/reorder transcript
      // entries. Shallow by design — the elements are the same Message refs.
      messages: Object.freeze(this.#messages.slice()),
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
    this.#step = 0;
  }

  /**
   * A self-contained, deep copy of the conversational state and accounting.
   * Raw `structuredClone` (fail-loud) of `messages`/`usage` so the returned
   * `AgentState` shares no references with the live agent.
   */
  snapshot(): AgentState {
    return {
      messages: structuredClone(this.#messages),
      usage: structuredClone(this.#usage),
      model: this.model,
      providerName: this.providerName,
      systemPrompt: this.systemPrompt,
      thinking: this.thinking,
      step: this.#step,
    };
  }

  /**
   * Replace the conversational state and accounting from a snapshot, deep-copying
   * back in so the agent and the passed `AgentState` stay independent. Forbidden
   * while running (mirrors `run()`'s guard) — restore is a between-turn operation.
   */
  restore(state: AgentState): void {
    if (this.#running) throw new Error("cannot restore() while the agent is running");
    this.#messages.length = 0;
    this.#messages.push(...structuredClone(state.messages));
    this.#usage = structuredClone(state.usage);
    this.model = state.model;
    this.providerName = state.providerName;
    this.systemPrompt = state.systemPrompt;
    this.thinking = state.thinking;
    this.#step = state.step;
  }

  async run(input: string | Message): Promise<RunResult> {
    // A top-level run is its own root; a fork inherits its parent's root (the ALS
    // context set here is never overwritten by a nested run).
    const root = rootAgentStore.getStore() ?? this;
    return rootAgentStore.run(root, () =>
    actingAgentStore.run(this, async (): Promise<RunResult> => {
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
          // Honor stop()/abort directly: three guards end the run reason:"stop" — this
          // check, the post-streamTurn check below, and run()'s catch (FRESH-1, mid-stream).
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
              this.#step++;
              await this.hooks.emit("turn_end", { turn, step: this.#step });
              continue;
            }
            reason = assistant.stopReason;
            this.#step++;
            await this.hooks.emit("turn_end", { turn, step: this.#step });
            break;
          }

          // The wave-shaping seam: hand the whole tool-call wave to extensions,
          // which may reorder or drop calls (return a subset/permutation). Only
          // returned calls whose id is among the originals are dispatched; an
          // unknown injected id is ignored (a tool_result with no matching
          // assistant tool_use would 400 the next turn). The defensive copy keeps
          // an in-place-mutating handler from corrupting the originals; with no
          // handler `apply` returns the wave unchanged — byte-identical to today.
          const originalCalls = calls;
          const wanted = await this.hooks.apply("beforeDispatch", [...originalCalls], { turn });
          const dispatchSet = wanted.filter((c) => originalCalls.some((o) => o.id === c.id));
          const results = await this.dispatch(dispatchSet);
          // A wave-settled, observe-only signal: the whole dispatch group as one
          // ordered value, before anything commits it to the transcript. Additive
          // to tool_end (per-tool) and turn_end (per-turn); neither is perturbed.
          await this.hooks.emit("tool_batch_end", {
            batch: results.map((r) => ({ call: r.call, result: r.result })),
            step: this.#step,
          });
          // Pairing reconciliation: every original id must get exactly one result.
          // A dispatched call contributes its real result; a dropped one a neutral
          // synthetic skip-result (isError:false, so error accounting stays clean).
          // Built in ORIGINAL order — `tool_batch_end` above and the terminate check
          // below intentionally read the EXECUTED set (`results`), not this all-id
          // set, so a synthetic skip can't mask a real terminate. The `??` is
          // required: `.find` is `T | undefined` under noUncheckedIndexedAccess.
          const reconciled: DispatchOutcome[] = originalCalls.map(
            (oc) =>
              results.find((r) => r.call.id === oc.id) ?? {
                call: oc,
                result: { content: "(skipped by a beforeDispatch hook)", isError: false },
              },
          );
          const toolMessage: Message = {
            role: "tool",
            content: reconciled.map(
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
          this.#step++;
          await this.hooks.emit("turn_end", { turn, step: this.#step });

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
        if (this.#abort?.signal.aborted) reason = "stop";
        else {
          reason = "error";
          await this.hooks.emit("error", { where: "agent.run", error: err });
          throw err;
        }
      } finally {
        this.#running = false;
        this.#abort = undefined;
        await this.hooks.emit("agent_end", { reason });
      }

      return { reason, messages: this.#messages };
    }));
  }

  // -- internals ----------------------------------------------------------

  private async streamTurn(turn: number): Promise<{ message: Message; stopReason: StopReason }> {
    const provider = this.providers.get(this.providerName);
    if (!provider) throw new Error(`no provider registered (looking for ${this.providerName ?? "default"})`);

    // The provider-error seam: rebuild + consume the stream in a bounded retry loop.
    // A pre-commit throw (no event emitted) is offered to `onProviderError`, which may
    // re-stream (optionally downshifting `model`); a post-commit throw always rethrows
    // (retrying a partly-rendered stream double-emits). No handler ⇒ rethrow on first.
    let attempt = 1;
    let model = this.model;
    for (;;) {
      const context = await this.hooks.apply(
        "transformContext",
        [...this.#messages],
        { turn, model },
      );

      const req = {
        systemPrompt: this.systemPrompt,
        messages: context,
        tools: this.tools.list().map((t) => t.spec),
        model,
        thinking: this.thinking,
        // Re-read each turn (like `model`): a set `forceTool` compels that tool;
        // `undefined` leaves `toolChoice` absent ⇒ free choice. Only force a registered
        // name (forcing an unregistered public-API value would 400 a real provider).
        toolChoice:
          this.forceTool && this.tools.get(this.forceTool)
            ? { type: "tool" as const, name: this.forceTool }
            : undefined,
      };

      // The request-shaping seam: hand the request to extensions, then re-attach the
      // live abort `signal` (excluded from the filter value — a mutated signal could
      // wedge abort). `cumulativeUsage` is a defensive copy; no handler ⇒ unchanged.
      const shaped = await this.hooks.apply(
        "transformRequest",
        {
          systemPrompt: req.systemPrompt,
          messages: req.messages,
          tools: req.tools,
          model: req.model,
          toolChoice: req.toolChoice,
          thinking: req.thinking,
        },
        { turn, cumulativeUsage: { ...this.#usage } },
      );
      const finalReq = { ...shaped, signal: this.#abort!.signal };

      let committed = false;
      let message: Message | undefined;
      let stopReason: StopReason = "end_turn";
      let usage: Usage = { ...ZERO_USAGE };
      try {
        for await (const ev of provider.stream(finalReq)) {
          committed = true;
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
      } catch (err) {
        // Post-commit or out of retries → rethrow (run() turns it into reason:error).
        if (committed || attempt >= MAX_PROVIDER_RETRIES) throw err;
        const decision = await this.hooks.apply(
          "onProviderError",
          { retry: false, fail: true },
          { error: err, attempt },
        );
        if (decision.retry && !decision.fail) {
          attempt++;
          if (decision.downshiftModel) model = decision.downshiftModel;
          continue;
        }
        throw err;
      }
      // Usage only accrues on a fully-consumed stream, so a pre-commit failure adds none.
      this.#usage = addUsage(this.#usage, usage);
      await this.hooks.emit("usage", { usage, cumulative: { ...this.#usage }, model: shaped.model });
      return { message, stopReason };
    }
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
    if (this.maxConcurrency === Infinity) {
      return Promise.all(calls.map((call) => this.runOne(call)));
    }

    // A finite cap: a fixed pool of workers pulls the next call off a shared
    // cursor and writes its outcome at the call's original index, so the result
    // array stays in requested order whichever worker finishes first.
    const results = new Array<DispatchOutcome>(calls.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < calls.length) {
        const index = next++;
        results[index] = await this.runOne(calls[index]!);
      }
    };
    const poolSize = Math.min(this.maxConcurrency, calls.length);
    await Promise.all(Array.from({ length: poolSize }, worker));
    return results;
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
    await this.hooks.emit("tool_end", { call, result: finalResult, step: this.#step });
    return { call, result: finalResult };
  }

  private async executeGuarded(call: ToolCallBlock): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { content: `Unknown tool: ${call.name}`, isError: true };
    }

    const { ok, value } = validate(tool.spec.parameters, call.arguments);
    // Seed the guard with coerced args when valid, raw args otherwise — a guard
    // may repair an invalid call, so we don't reject yet.
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

    // The single validation gate: re-validate the (possibly guard-rewritten) args
    // so the tool receives schema-clean, coerced input. It runs BEFORE the
    // capability check so an irreparably-invalid call fails without spuriously
    // prompting for a capability, and a guard that fixes the args is honored.
    const final = validate(tool.spec.parameters, decided.arguments);
    if (!final.ok) {
      return { content: `Invalid arguments for ${call.name}:\n- ${final.errors.join("\n- ")}`, isError: true };
    }

    for (const cap of tool.capabilities ?? []) {
      await this.capabilities.require(cap, tool.spec.name);
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
