/**
 * reasoning-search — best-of-N over forked, governed child agents.
 *
 * Offline + deterministic: a `MockProvider` function responder scripts the
 * parent turn (which calls `best_of_n`), each fork's candidate output, and any
 * judge sub-call, distinguishing them by request shape (the judge sub-call's
 * system prompt pins the `SCORE` grammar; a fork's last user message is the
 * task; the parent's is the kick-off). The deterministic `longest`/`shortest`
 * scorers keep AC-3/AC-6 free of a live judge.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type {
  CompletionRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamEvent,
  ToolResult,
  ToolResultBlock,
} from "../src/kernel/types.ts";
import { defineTool } from "../src/kernel/define.ts";
import reasoningSearch, { childRegistryFrom } from "../src/extensions/reasoning-search.ts";
import { lastText, makeHarness } from "./helpers.ts";

const TASK = "solve-it";

/** The last text block of the most recent user message in a request. */
function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/**
 * The ids of assistant `tool_call` blocks with no matching `tool_result` — the
 * live-provider failure mode: Anthropic/OpenAI 400 a request containing an
 * assistant tool_use that is not resolved by a tool_result.
 */
function danglingToolUseIds(messages: readonly Message[]): string[] {
  const resolved = new Set<string>();
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") resolved.add(b.toolCallId);
  }
  const dangling: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) if (b.type === "tool_call" && !resolved.has(b.id)) dangling.push(b.id);
  }
  return dangling;
}

/** Flip the per-extension store flag the tool guards on. */
function enable(host: { storeFor(id: string): { set(k: string, v: unknown): void } }): void {
  host.storeFor("reasoning-search").set("enabled", true);
}

// ---------------------------------------------------------------------------
// AC-3 — best-of-N forks N children and selects the argmax candidate
// ---------------------------------------------------------------------------

test("AC-3: best_of_n forks 3 children and returns the LONGEST candidate", async () => {
  const childOutputs = ["a", "bb", "ccc"];
  let childIdx = 0;
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      const out = childOutputs[Math.min(childIdx, childOutputs.length - 1)]!;
      childIdx++;
      return { text: out };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 3, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  // The tool result drops `details`, so capture the live ToolResult off the bus.
  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "best_of_n") captured = p.result;
  });

  await agent.run("kickoff");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "best_of_n succeeded");
  assert.equal(result.content, "ccc", "the longest of {a, bb, ccc} is returned");
  assert.equal(lastText(agent), "parent-done");

  assert.ok(Array.isArray(captured?.details), "details is the per-candidate score list");
  const details = captured!.details as { text: string; score: number }[];
  assert.equal(details.length, 3, "one score entry per forked candidate");
  assert.deepEqual(
    details.map((d) => d.score).sort((x, y) => x - y),
    [1, 2, 3],
    "longest scorer scores each candidate by its text length",
  );
});

// ---------------------------------------------------------------------------
// AC-4 — children inherit the parent's gate filters (childScope governance)
// ---------------------------------------------------------------------------

test("AC-4: a parent beforeToolCall guard blocks a forked child's tool call", async () => {
  const flag = { mutated: false };
  let bestOfNCalled = false;
  let childStep = 0;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      // Each child tries `mutate` once, then finishes.
      if (childStep < 2) {
        childStep++;
        return { toolCalls: [{ name: "mutate", arguments: {} }] };
      }
      return { text: "child-done" };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 2, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  agent.tools.register(
    defineTool({
      name: "mutate",
      description: "Flips a flag when it runs.",
      parameters: { type: "object", properties: {} },
      execute: () => {
        flag.mutated = true;
        return { content: "mutated" };
      },
    }),
  );
  // Parent gate filter: veto every `mutate` call. childScope shares it to forks.
  agent.hooks.filter("beforeToolCall", (decision, ctx) =>
    ctx.call.name === "mutate" ? { ...decision, block: true, reason: "blocked by parent guard" } : decision,
  );
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(flag.mutated, false, "the parent guard blocked the child's mutate; its body never ran");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "the fork still completed after the block");
});

// ---------------------------------------------------------------------------
// AC-5 — bounded by the N cap, recursion guard, usage via the parent bus
// ---------------------------------------------------------------------------

test("AC-5: n above the cap (5) is clamped to at most 5 forks", async () => {
  let childRequests = 0;
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRequests++;
      return { text: `c${childRequests}` };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 10, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(childRequests, 5, "n=10 is clamped to the default cap of 5 forks");
});

test("AC-5: a child's registry omits every spawn-class tool — no re-fork", () => {
  const bestOfN = defineTool({ name: "best_of_n", description: "x", capabilities: ["agent:spawn"], execute: () => ({ content: "" }) });
  const spawn = defineTool({ name: "spawn_agent", description: "x", capabilities: ["agent:spawn"], execute: () => ({ content: "" }) });
  // A second-named spawn tool outside the old {best_of_n, spawn_agent, tree_search,
  // graph_search} name set: the capability strip must remove it too.
  const runWorkflow = defineTool({ name: "run_workflow", description: "x", capabilities: ["workflow:run"], execute: () => ({ content: "" }) });
  const helper = defineTool({ name: "helper", description: "x", execute: () => ({ content: "" }) });

  const childTools = childRegistryFrom([bestOfN, spawn, runWorkflow, helper]);

  assert.equal(childTools.has("best_of_n"), false, "the recursion guard removes best_of_n");
  assert.equal(childTools.has("spawn_agent"), false, "spawn_agent is also removed");
  assert.equal(childTools.has("run_workflow"), false, "a second-named spawn tool is stripped by capability");
  assert.equal(childTools.has("helper"), true, "every other parent tool is copied through");
});

test("AC-5: children's usage events reach the parent bus", async () => {
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) return { text: "cand" };
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 3, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  // Register the observer before the run so its `usage` Set exists when
  // childScope() captures it by reference at fork time.
  let usageEvents = 0;
  agent.hooks.on("usage", () => {
    usageEvents++;
  });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // Parent emits usage on its two turns (the best_of_n call + the final text);
  // the 3 forks each emit one more on the shared bus. Without children it would
  // be 2, so > 2 proves the forks' usage reached the parent bus.
  assert.equal(usageEvents, 5, "2 parent + 3 child usage events arrive on the parent bus");
});

// ---------------------------------------------------------------------------
// AC-6 — losing branches never mutate the parent transcript
// ---------------------------------------------------------------------------

test("AC-6: the parent transcript carries only the best_of_n call, not loser turns", async () => {
  let childIdx = 0;
  const childOutputs = ["WINNER-LONG", "LOSER"];
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      const out = childOutputs[Math.min(childIdx, childOutputs.length - 1)]!;
      childIdx++;
      return { text: out };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 2, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // user kickoff, assistant(best_of_n call), tool(result), assistant(parent-done).
  assert.equal(agent.messages.length, 4, "no losing branch internal turns leaked into the parent");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.content, "WINNER-LONG", "the winner re-enters via the tool result");
  assert.ok(
    !JSON.stringify(agent.messages).includes("LOSER"),
    "the losing branch's text never appears in the parent transcript",
  );
});

// ---------------------------------------------------------------------------
// Live-provider hygiene — a fork's request carries no dangling tool_use
// ---------------------------------------------------------------------------

test("a fork's first request has no dangling best_of_n tool_use (valid for a live provider)", async () => {
  let bestOfNCalled = false;
  const forkRequests: CompletionRequest[] = [];
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      forkRequests.push(req);
      return { text: "cand" };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 2, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.ok(forkRequests.length > 0, "the forks ran");
  for (const req of forkRequests) {
    assert.deepEqual(
      danglingToolUseIds(req.messages),
      [],
      "a fork must not inherit the in-flight best_of_n tool_use with no matching tool_result",
    );
  }
});

// ---------------------------------------------------------------------------
// AC-8 — off by default: loaded but not enabled is inert
// ---------------------------------------------------------------------------

test("AC-8: loaded-but-not-enabled best_of_n is inert (no forks, disabled result)", async () => {
  let childRequests = 0;
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRequests++;
      return { text: "should-not-run" };
    }
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 3, scorer: "longest" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  // Intentionally NOT enabled.

  await agent.run("kickoff");

  assert.equal(childRequests, 0, "no children were forked while disabled");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true, "the disabled tool returns an error result");
  assert.match(result.content, /disabled/i, "the result explains it is disabled");
});

// ---------------------------------------------------------------------------
// AC-7 — the judge scorer is fail-soft on a malformed reply
// ---------------------------------------------------------------------------

test("AC-7: a malformed judge reply scores 0 and falls back to candidate 0 (no throw)", async () => {
  let bestOfNCalled = false;
  const responder = (req: CompletionRequest) => {
    // The judge sub-call is the only request whose system prompt pins SCORE.
    if (req.systemPrompt.includes("SCORE")) return { text: "I cannot grade this." };
    if (lastUserText(req) === TASK) return { text: "cand" };
    if (!bestOfNCalled) {
      bestOfNCalled = true;
      return { toolCalls: [{ name: "best_of_n", arguments: { task: TASK, n: 2, scorer: "judge" } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "best_of_n") captured = p.result;
  });

  await assert.doesNotReject(() => agent.run("kickoff"), "a malformed judge reply must not throw");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "best_of_n still succeeds when the judge is unparseable");
  assert.equal(result.content, "cand", "argmax of all-zero scores falls back to candidate 0");
  const details = captured!.details as { text: string; score: number }[];
  assert.deepEqual(
    details.map((d) => d.score),
    [0, 0],
    "every malformed-judge candidate scores 0 (fail-soft)",
  );
});

// ---------------------------------------------------------------------------
// D5 — the /reasoning-search command toggles the enabled flag
// ---------------------------------------------------------------------------

test("/reasoning-search on|off|status toggles and reports the enabled flag", async () => {
  const { commands, host } = makeHarness({ fallback: "allow" });
  await host.use("reasoning-search", reasoningSearch);

  const cmd = commands.get("reasoning-search");
  assert.ok(cmd, "the command is registered");

  const run = async (args: string): Promise<string> => {
    const lines: string[] = [];
    await cmd!.run({ agent: {} as never, args, print: (l) => lines.push(l) });
    return lines.join("\n");
  };

  assert.match(await run("status"), /off/i, "defaults to off");
  assert.match(await run("on"), /on/i, "enabling reports on");
  assert.equal(host.storeFor("reasoning-search").get("enabled"), true, "on sets the store flag");
  assert.match(await run("off"), /off/i, "disabling reports off");
  assert.equal(host.storeFor("reasoning-search").get("enabled"), false, "off clears the store flag");
});

// ---------------------------------------------------------------------------
// W9.4 — fork robustness: abort wiring + per-fork fault isolation. These need a
// CUSTOM provider (MockProvider has no block/throw primitive and one shared
// provider drives forks + the judge), so we script the parent/fork/judge turns
// by request shape — exactly the discriminators the existing ACs already use.
// ---------------------------------------------------------------------------

/** A single `done` stream event carrying `content` (the loop reads the message). */
function done(content: ContentBlock[], stopReason: StopReason = "end_turn"): StreamEvent {
  return {
    type: "done",
    message: { role: "assistant", content },
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Race `p` against a timer so a never-resolving best_of_n fails fast (not hangs). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Each fork turn (last user message === TASK) records its request signal and
 * blocks until that signal aborts; the parent kickoff turn fires the best_of_n
 * call. Used to prove a parent abort tears every fork down promptly.
 */
class BlockingForkProvider implements Provider {
  readonly name = "mock";
  readonly forkSignals: AbortSignal[] = [];
  #bestOfNCalled = false;
  readonly #onFork: () => void;
  constructor(onFork: () => void) {
    this.#onFork = onFork;
  }
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (lastUserText(req) === TASK) {
      this.forkSignals.push(req.signal);
      this.#onFork();
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield done([]); // aborted: end the fork turn cleanly with no answer
      return;
    }
    if (!this.#bestOfNCalled) {
      this.#bestOfNCalled = true;
      yield done([{ type: "tool_call", id: "bon", name: "best_of_n", arguments: { task: TASK, n: 3, scorer: "longest" } }], "tool_use");
      return;
    }
    yield done([{ type: "text", text: "parent-done" }]);
  }
}

test("W9.4a: a parent abort tears down every in-flight fork and best_of_n returns promptly", async () => {
  let started = 0;
  let resolveStarted!: () => void;
  const allForksStarted = new Promise<void>((r) => {
    resolveStarted = r;
  });
  const provider = new BlockingForkProvider(() => {
    if (++started === 3) resolveStarted();
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  const runPromise = agent.run("kickoff");
  await allForksStarted; // every fork's stream is now blocked on its own signal
  assert.equal(provider.forkSignals.length, 3, "three forks started and blocked");
  assert.ok(provider.forkSignals.every((s) => !s.aborted), "forks run until the parent aborts");

  agent.stop(); // abort the parent: the fix must propagate stop() to every fork

  await withTimeout(runPromise, 2000, "best_of_n did not return promptly after a parent abort");
  for (const s of provider.forkSignals) {
    assert.ok(s.aborted, "every in-flight fork received stop() on the parent abort");
  }
});

/**
 * Throws inside a fork's stream (pre-first-event) for one or all forks, while a
 * judge sub-call (systemPrompt pins the SCORE grammar) never throws and scores a
 * candidate by its x-count so a longer survivor wins.
 */
class ThrowingForkProvider implements Provider {
  readonly name = "mock";
  #bestOfNCalled = false;
  #forkRuns = 0;
  private readonly throwAll: boolean;
  constructor(throwAll: boolean) {
    this.throwAll = throwAll;
  }
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (req.systemPrompt.includes("SCORE")) {
      // A judge sub-call — discriminated from a fork run by its system prompt.
      const xs = (lastUserText(req).match(/x/g) ?? []).length;
      yield done([{ type: "text", text: `SCORE ${Math.min(10, xs)}/10 PASS sized` }]);
      return;
    }
    if (lastUserText(req) === TASK) {
      const i = this.#forkRuns++;
      if (this.throwAll || i === 0) throw new Error(`fork ${i} stream boom`);
      yield done([{ type: "text", text: "x".repeat(i + 1) }]); // distinct survivor candidates
      return;
    }
    if (!this.#bestOfNCalled) {
      this.#bestOfNCalled = true;
      yield done([{ type: "tool_call", id: "bon", name: "best_of_n", arguments: { task: TASK, n: 3 } }], "tool_use");
      return;
    }
    yield done([{ type: "text", text: "parent-done" }]);
  }
}

test("W9.4b: one fork that throws does not fail best_of_n — the best survivor wins", async () => {
  const provider = new ThrowingForkProvider(false);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "best_of_n") captured = p.result;
  });

  await assert.doesNotReject(() => agent.run("kickoff"), "a single fork throw must not reject best_of_n");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "best_of_n still succeeds with one failed fork");
  assert.equal(result.content, "xxx", "the highest-scoring SURVIVOR (not the thrown fork) is returned");

  const details = captured!.details as { text: string; score: number }[];
  assert.equal(details.length, 3, "one entry per fork, including the failure");
  assert.equal(details.filter((d) => d.score === -Infinity).length, 1, "the thrown fork is scored -Infinity, never argmax");
});

test("W9.4b: when every fork throws, best_of_n returns a clean fail (no unhandled throw)", async () => {
  const provider = new ThrowingForkProvider(true);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "best_of_n") captured = p.result;
  });

  await assert.doesNotReject(() => agent.run("kickoff"), "all forks failing must surface as a result, not a throw");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true, "all-forks-failed returns an error result");
  assert.match(result.content, /fork/i, "the failure result mentions the forks");
  // A clean fail() carries the per-fork detail list; a Promise.all reject caught
  // by the dispatcher would produce a details-less error result instead.
  const details = captured!.details as { text: string; score: number }[];
  assert.ok(Array.isArray(details) && details.length === 3, "the clean fail reports all three failed forks as detail");
});
