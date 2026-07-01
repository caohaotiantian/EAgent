/**
 * graph_search — Graph-of-Thought operations (generate → aggregate → refine).
 *
 * Offline + deterministic: a `MockProvider` function responder keyed on the last
 * user message scripts the parent turn (which calls `graph_search`), the generate
 * turns (`lastUserText === TASK`), and the two op turns (the aggregate prompt
 * starts with "Combine these candidate answers"; the refine prompt starts with
 * "Improve this answer"). A custom blocking provider covers the abort case
 * (MockProvider cannot block). The deterministic `longest`/`shortest` scorers keep
 * selection order-invariant.
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
} from "../src/kernel/types.js";
import { defineTool } from "../src/kernel/define.js";
import reasoningSearch, { childRegistryFrom } from "../src/extensions/reasoning-search.js";
import { makeHarness } from "./helpers.js";

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

/** Flip the per-extension store flag the tool guards on. */
function enable(host: { storeFor(id: string): { set(k: string, v: unknown): void } }): void {
  host.storeFor("reasoning-search").set("enabled", true);
}

/** A single `done` stream event carrying `content` (the loop reads the message). */
function done(content: ContentBlock[], stopReason: StopReason = "end_turn"): StreamEvent {
  return {
    type: "done",
    message: { role: "assistant", content },
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Race `p` against a timer so a never-resolving search fails fast (not hangs). */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Distinguish a generate / aggregate / refine / parent turn by the last user message. */
function turnKind(req: CompletionRequest): "generate" | "aggregate" | "refine" | "parent" {
  const u = lastUserText(req);
  if (u === TASK) return "generate";
  if (u.startsWith("Combine these candidate answers")) return "aggregate";
  if (u.startsWith("Improve this answer")) return "refine";
  return "parent";
}

// ---------------------------------------------------------------------------
// AC-3 — the aggregate node is produced and can win
// ---------------------------------------------------------------------------

test("AC-3: the aggregate node is produced and can win the global best", async () => {
  const GEN = "gen"; // length 3 — every generated thought
  const AGG = "aggregated-combined-answer"; // longest — the aggregate wins
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: GEN };
      case "aggregate":
        return { text: AGG };
      case "refine":
        return { text: "should-not-refine" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 3, scorer: "longest", refine: false } },
            ],
          };
        }
        return { text: "parent-done" };
    }
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "graph_search") captured = p.result;
  });

  await agent.run("kickoff");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "graph_search succeeded");
  assert.equal(result.content, AGG, "the longer aggregate text is returned as the global best");

  const details = captured!.details as { op: string; score: number; text: string }[];
  assert.ok(
    details.some((d) => d.op === "aggregate"),
    "details records an aggregate node",
  );
});

// ---------------------------------------------------------------------------
// AC-4 — the refine node is produced and can win
// ---------------------------------------------------------------------------

test("AC-4: the refine node is produced and can win the global best", async () => {
  const GEN = "gen"; // length 3
  const AGG = "aggregated"; // length 10 — beats GEN but not REF
  const REF = "refined-improved-final-answer"; // longest overall — refine wins
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: GEN };
      case "aggregate":
        return { text: AGG };
      case "refine":
        return { text: REF };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 3, scorer: "longest", refine: true } },
            ],
          };
        }
        return { text: "parent-done" };
    }
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "graph_search") captured = p.result;
  });

  await agent.run("kickoff");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "graph_search succeeded");
  assert.equal(result.content, REF, "the longest refined text is returned as the global best");

  const details = captured!.details as { op: string; score: number; text: string }[];
  assert.ok(
    details.some((d) => d.op === "refine"),
    "details records a refine node",
  );
});

// ---------------------------------------------------------------------------
// AC-5 — global best never regresses to a worse aggregate/refine
// ---------------------------------------------------------------------------

test("AC-5: a generated best is kept when aggregate and refine score lower", async () => {
  const GEN_BEST = "x".repeat(20); // the global best
  const GEN_OTHER = "x".repeat(5);
  const AGG = "x".repeat(3); // worse than GEN_BEST
  const REF = "x".repeat(1); // worse than GEN_BEST
  let g = 0;
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: g++ === 0 ? GEN_BEST : GEN_OTHER };
      case "aggregate":
        return { text: AGG };
      case "refine":
        return { text: REF };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 3, scorer: "longest", refine: true } },
            ],
          };
        }
        return { text: "parent-done" };
    }
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "graph_search succeeded");
  assert.equal(result.content, GEN_BEST, "the generated best wins over a worse aggregate/refine");
});

// ---------------------------------------------------------------------------
// AC-6 — bounded: total child runs = branch + 1 + (refine ? 1 : 0)
// ---------------------------------------------------------------------------

test("AC-6: total child runs equal branch(clamped) + 1 aggregate + 1 refine", async () => {
  let childRuns = 0;
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    const kind = turnKind(req);
    if (kind !== "parent") {
      childRuns++;
      return { text: "x".repeat(childRuns) };
    }
    if (!calledGraph) {
      calledGraph = true;
      return {
        toolCalls: [
          { name: "graph_search", arguments: { task: TASK, branch: 99, scorer: "longest", refine: true } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // branch:99 clamps to DEFAULT_MAX_BRANCH(4); +1 aggregate +1 refine = 6.
  assert.equal(childRuns, 6, `child runs equal branch(4) + aggregate + refine (ran ${childRuns})`);
});

// ---------------------------------------------------------------------------
// AC-7 — recursion guard: a forked node can neither re-search nor re-fork
// ---------------------------------------------------------------------------

test("AC-7: a forked node's registry omits graph_search, tree_search, and best_of_n", () => {
  const graphSearch = defineTool({ name: "graph_search", description: "x", execute: () => ({ content: "" }) });
  const treeSearch = defineTool({ name: "tree_search", description: "x", execute: () => ({ content: "" }) });
  const bestOfN = defineTool({ name: "best_of_n", description: "x", execute: () => ({ content: "" }) });
  const helper = defineTool({ name: "helper", description: "x", execute: () => ({ content: "" }) });

  const childTools = childRegistryFrom([graphSearch, treeSearch, bestOfN, helper]);

  assert.equal(childTools.has("graph_search"), false, "the recursion guard removes graph_search");
  assert.equal(childTools.has("tree_search"), false, "tree_search is also removed");
  assert.equal(childTools.has("best_of_n"), false, "best_of_n is also removed");
  assert.equal(childTools.has("helper"), true, "every other parent tool is copied through");
});

// ---------------------------------------------------------------------------
// AC-8 — childScope governance carries to every forked op node
// ---------------------------------------------------------------------------

test("AC-8: a parent beforeToolCall guard blocks a tool inside a forked op node", async () => {
  const flag = { mutated: false };
  let calledGraph = false;
  let childStep = 0;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        if (childStep < 2) {
          childStep++;
          return { toolCalls: [{ name: "mutate", arguments: {} }] };
        }
        return { text: "child-done" };
      case "aggregate":
        return { text: "agg-done" };
      case "refine":
        return { text: "refine-done" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 2, scorer: "longest", refine: false } },
            ],
          };
        }
        return { text: "parent-done" };
    }
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
  agent.hooks.filter("beforeToolCall", (decision, ctx) =>
    ctx.call.name === "mutate" ? { ...decision, block: true, reason: "blocked by parent guard" } : decision,
  );
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(flag.mutated, false, "the parent guard blocked the op node's mutate; its body never ran");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "the search still completed after the block");
});

// ---------------------------------------------------------------------------
// AC-9 — abort stops the live op; allSettled/try-catch fault isolation
// ---------------------------------------------------------------------------

/**
 * Generate turns complete immediately; the aggregate turn records its signal and
 * blocks until it aborts. Proves an abort while the aggregate fork is live stops it.
 */
class AggregateBlockingProvider implements Provider {
  readonly name = "mock";
  aggregateSignal: AbortSignal | undefined;
  #calledGraph = false;
  constructor(private readonly onAggregate: () => void) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    switch (turnKind(req)) {
      case "generate":
        yield done([{ type: "text", text: "thought" }]);
        return;
      case "aggregate":
        this.aggregateSignal = req.signal;
        this.onAggregate();
        await new Promise<void>((resolve) => {
          if (req.signal.aborted) resolve();
          else req.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        yield done([]);
        return;
      case "refine":
        yield done([{ type: "text", text: "refine" }]);
        return;
      default:
        if (!this.#calledGraph) {
          this.#calledGraph = true;
          yield done(
            [{ type: "tool_call", id: "gs", name: "graph_search", arguments: { task: TASK, branch: 2, scorer: "longest", refine: false } }],
            "tool_use",
          );
          return;
        }
        yield done([{ type: "text", text: "parent-done" }]);
    }
  }
}

test("AC-9: aborting while the aggregate fork is live stops it and returns promptly", async () => {
  let resolveAgg!: () => void;
  const aggStarted = new Promise<void>((r) => {
    resolveAgg = r;
  });
  const provider = new AggregateBlockingProvider(() => resolveAgg());

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  const runPromise = agent.run("kickoff");
  await aggStarted; // the aggregate fork's stream is now blocked on its own signal
  assert.ok(provider.aggregateSignal && !provider.aggregateSignal.aborted, "the aggregate fork runs until the parent aborts");

  agent.stop(); // abort the parent: the handler must stop the live (aggregate) fork

  await withTimeout(runPromise, 2000, "graph_search did not return promptly after aborting the aggregate fork");
  assert.ok(provider.aggregateSignal!.aborted, "the live aggregate fork received stop() on the parent abort");
});

test("AC-9: an aggregate that throws is dropped and the generated best is returned", async () => {
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: "thought" };
      case "aggregate":
        throw new Error("aggregate stream boom");
      case "refine":
        return { text: "refine" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 2, scorer: "longest", refine: false } },
            ],
          };
        }
        return { text: "parent-done" };
    }
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await assert.doesNotReject(() => agent.run("kickoff"), "an aggregate throw must not reject graph_search");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "graph_search still succeeds with a dropped aggregate");
  assert.equal(result.content, "thought", "the generated best survives the dropped aggregate");
});

test("AC-9: when every operation throws, graph_search returns a clean fail", async () => {
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    const kind = turnKind(req);
    if (kind === "generate" || kind === "aggregate" || kind === "refine") {
      throw new Error(`${kind} stream boom`);
    }
    if (!calledGraph) {
      calledGraph = true;
      return {
        toolCalls: [
          { name: "graph_search", arguments: { task: TASK, branch: 2, scorer: "longest", refine: true } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await assert.doesNotReject(() => agent.run("kickoff"), "all operations failing must surface as a result, not a throw");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true, "all-operations-failed returns an error result");
  assert.match(result.content, /operation/i, "the failure result mentions the failed operations");
});

// ---------------------------------------------------------------------------
// AC-10 — off by default: loaded but not enabled is inert
// ---------------------------------------------------------------------------

test("AC-10: loaded-but-not-enabled graph_search is inert (no forks, disabled result)", async () => {
  let childRuns = 0;
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    const kind = turnKind(req);
    if (kind !== "parent") {
      childRuns++;
      return { text: "should-not-run" };
    }
    if (!calledGraph) {
      calledGraph = true;
      return { toolCalls: [{ name: "graph_search", arguments: { task: TASK, branch: 2 } }] };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  // Intentionally NOT enabled.

  await agent.run("kickoff");

  assert.equal(childRuns, 0, "no children were forked while disabled");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true, "the disabled tool returns an error result");
  assert.match(result.content, /disabled/i, "the result explains it is disabled");
});

// ---------------------------------------------------------------------------
// AC-11 — op-internal turns never mutate the parent transcript
// ---------------------------------------------------------------------------

test("AC-11: the parent transcript carries only the graph_search call, not op turns", async () => {
  const GEN = "gen"; // op-internal only; never re-enters the parent
  const AGG = "aggregated-combined-winner"; // the global best — re-enters via the tool result
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: GEN };
      case "aggregate":
        return { text: AGG };
      case "refine":
        return { text: "refine" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [
              { name: "graph_search", arguments: { task: TASK, branch: 2, scorer: "longest", refine: false } },
            ],
          };
        }
        return { text: "parent-done" };
    }
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // user kickoff, assistant(graph_search call), tool(result), assistant(parent-done).
  assert.equal(agent.messages.length, 4, "no op-internal turns leaked into the parent");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.content, AGG, "the winner re-enters via the tool result");
  assert.ok(
    !JSON.stringify(agent.messages).includes(GEN),
    "an op-internal generated thought never appears in the parent transcript",
  );
});

// ---------------------------------------------------------------------------
// RW8a-3 — multi-round refine to convergence (optional refineRounds; default 1)
// ---------------------------------------------------------------------------

test("RW8a-3: graph_search refines to convergence (stops the first non-improving round)", async () => {
  // scorer=longest ⇒ score = text length. Refine round 1 returns a LONGER answer
  // (improves), round 2 a shorter one (no gain) ⇒ 2 refine ops recorded, then the
  // loop converges before round 3.
  let refineCalls = 0;
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: "gen" };
      case "aggregate":
        return { text: "aggr" };
      case "refine":
        refineCalls++;
        return refineCalls === 1 ? { text: "refined-longer-answer" } : { text: "short" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return {
            toolCalls: [{ name: "graph_search", arguments: { task: TASK, branch: 1, scorer: "longest", refineRounds: 3 } }],
          };
        }
        return { text: "parent-done" };
    }
  };
  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);
  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "graph_search") captured = p.result;
  });

  await agent.run("kickoff");

  const details = captured!.details as { op: string; score: number; text: string }[];
  assert.equal(details.filter((d) => d.op === "refine").length, 2, "two refine rounds, then converged (round 2 no gain)");
  assert.equal(toolResults(agent.messages)[0]!.content, "refined-longer-answer", "returns the round-1 best");
});

test("RW8a-3: default (no refineRounds) runs exactly one refine pass (byte-identical)", async () => {
  let refineCalls = 0;
  let calledGraph = false;
  const responder = (req: CompletionRequest) => {
    switch (turnKind(req)) {
      case "generate":
        return { text: "gen" };
      case "aggregate":
        return { text: "aggr" };
      case "refine":
        refineCalls++;
        return { text: "refined-longer-answer" };
      default:
        if (!calledGraph) {
          calledGraph = true;
          return { toolCalls: [{ name: "graph_search", arguments: { task: TASK, branch: 1, scorer: "longest" } }] };
        }
        return { text: "parent-done" };
    }
  };
  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);
  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "graph_search") captured = p.result;
  });

  await agent.run("kickoff");

  const details = captured!.details as { op: string }[];
  assert.equal(details.filter((d) => d.op === "refine").length, 1, "default is a single refine pass");
});
