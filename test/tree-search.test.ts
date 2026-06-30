/**
 * tree_search — Tree-of-Thought beam search over forked, governed child agents.
 *
 * Offline + deterministic: a `MockProvider` function responder keyed on the whole
 * request scripts the parent turn (which calls `tree_search`), each depth's fork
 * outputs, and the lineage a surviving node descends from (the prior "thought"
 * present in the transcript). Custom providers cover the cases MockProvider cannot
 * script: a multi-wave abort (block at depth >= 2) and a per-fork throw. The
 * deterministic `longest`/`shortest` scorers keep the winning lineage order-invariant.
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

/** Every non-empty assistant "thought" text in a request, oldest first (the lineage). */
function assistantTexts(req: CompletionRequest): string[] {
  const out: string[] = [];
  for (const m of req.messages) {
    if (m.role !== "assistant") continue;
    let text = "";
    for (const b of m.content) if (b.type === "text") text += b.text;
    if (text.length > 0) out.push(text);
  }
  return out;
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

// ---------------------------------------------------------------------------
// AC-3 — multi-step beam follows the highest-scoring lineage across depths
// ---------------------------------------------------------------------------

test("AC-3: tree_search beam follows the highest-scoring lineage and reports each depth", async () => {
  const D1_WIN = "winner"; // length 6 — beats the loser at depth 1
  const D1_LOSE = "lose"; // length 4 — pruned by beam:1
  const D2_LEAF = "leaf"; // length 4
  const D2_WIN = "champion-leaf"; // length 13 — longest leaf in the winning lineage
  const LOSER_PATH = "LOSER-PATH-SENTINEL"; // returned only if the beam follows the loser lineage

  let d1 = 0;
  let d2 = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      const lineage = assistantTexts(req);
      if (lineage.length === 0) {
        return { text: d1++ === 0 ? D1_WIN : D1_LOSE };
      }
      if (lineage[lineage.length - 1] !== D1_WIN) return { text: LOSER_PATH };
      return { text: d2++ === 0 ? D2_LEAF : D2_WIN };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 2, beam: 1, depth: 2, scorer: "longest" } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  let captured: ToolResult | undefined;
  agent.hooks.on("tool_end", (p) => {
    if (p.call.name === "tree_search") captured = p.result;
  });

  await agent.run("kickoff");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "tree_search succeeded");
  assert.equal(result.content, D2_WIN, "the longest leaf of the winning lineage is returned");
  assert.ok(
    !JSON.stringify(agent.messages).includes(LOSER_PATH),
    "the beam never followed the pruned loser lineage",
  );

  const details = captured!.details as { text: string; score: number }[][];
  assert.equal(details.length, 2, "details reports one frontier per depth");
});

// ---------------------------------------------------------------------------
// AC-4 — bounded by maxNodes (clip to budget), clamping, best-so-far on exhaustion
// ---------------------------------------------------------------------------

test("AC-4: a worst-case config is clipped to maxNodes and returns the best leaf so far", async () => {
  let childRuns = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRuns++;
      return { text: "x".repeat(childRuns) };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 4, beam: 3, depth: 3, maxNodes: 5, scorer: "longest" } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // Worst case is branch + (depth-1)*beam*branch = 4 + 2*3*4 = 28; maxNodes:5 clips it.
  assert.ok(childRuns <= 5, `child runs clipped to maxNodes:5 (ran ${childRuns})`);
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "budget exhaustion returns the best leaf so far, not a fail");
});

test("AC-4: branch above the cap is clamped to DEFAULT_MAX_BRANCH (4)", async () => {
  let childRuns = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRuns++;
      return { text: "x".repeat(childRuns) };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 99, beam: 1, depth: 1, scorer: "longest" } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(childRuns, 4, "branch:99 clamps to 4 children at depth 1");
});

test("AC-4: maxNodes below branch is clamped up to branch so depth-1 still runs", async () => {
  let childRuns = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRuns++;
      return { text: "x".repeat(childRuns) };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 3, beam: 1, depth: 1, maxNodes: 1, scorer: "longest" } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(childRuns, 3, "maxNodes:1 clamps up to branch:3 so the first depth runs all 3");
});

// ---------------------------------------------------------------------------
// AC-5 — recursion guard: a forked node can neither re-search nor re-fork
// ---------------------------------------------------------------------------

test("AC-5: a forked node's registry omits both tree_search and best_of_n", () => {
  const treeSearch = defineTool({ name: "tree_search", description: "x", execute: () => ({ content: "" }) });
  const bestOfN = defineTool({ name: "best_of_n", description: "x", execute: () => ({ content: "" }) });
  const helper = defineTool({ name: "helper", description: "x", execute: () => ({ content: "" }) });

  const childTools = childRegistryFrom([treeSearch, bestOfN, helper]);

  assert.equal(childTools.has("tree_search"), false, "the recursion guard removes tree_search");
  assert.equal(childTools.has("best_of_n"), false, "best_of_n is also removed");
  assert.equal(childTools.has("helper"), true, "every other parent tool is copied through");
});

// ---------------------------------------------------------------------------
// AC-6 — childScope governance carries to every forked node
// ---------------------------------------------------------------------------

test("AC-6: a parent beforeToolCall guard blocks a tool inside a forked node", async () => {
  const flag = { mutated: false };
  let calledTree = false;
  let childStep = 0;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      if (childStep < 2) {
        childStep++;
        return { toolCalls: [{ name: "mutate", arguments: {} }] };
      }
      return { text: "child-done" };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 2, beam: 1, depth: 1, scorer: "longest" } },
        ],
      };
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
  agent.hooks.filter("beforeToolCall", (decision, ctx) =>
    ctx.call.name === "mutate" ? { ...decision, block: true, reason: "blocked by parent guard" } : decision,
  );
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  assert.equal(flag.mutated, false, "the parent guard blocked the node's mutate; its body never ran");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "the node still completed after the block");
});

// ---------------------------------------------------------------------------
// AC-7 — multi-wave abort: the handler follows the moving frontier (G1). Needs a
// custom provider that completes depth 1 but blocks at depth >= 2 (MockProvider
// cannot block, and a block-every-turn provider deadlocks before depth 2).
// ---------------------------------------------------------------------------

/**
 * Depth-1 fork turns complete immediately with a "thought"; depth >= 2 fork turns
 * (whose transcript already carries a depth-1 thought) record their signal and
 * block until it aborts. Proves an abort at depth 2 stops the live depth-2 wave.
 */
class DepthBlockingProvider implements Provider {
  readonly name = "mock";
  readonly depth2Signals: AbortSignal[] = [];
  #calledTree = false;
  constructor(private readonly onDepth2: () => void) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (lastUserText(req) === TASK) {
      if (assistantTexts(req).length === 0) {
        yield done([{ type: "text", text: "d1-thought" }]);
        return;
      }
      this.depth2Signals.push(req.signal);
      this.onDepth2();
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) resolve();
        else req.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield done([]);
      return;
    }
    if (!this.#calledTree) {
      this.#calledTree = true;
      yield done(
        [{ type: "tool_call", id: "ts", name: "tree_search", arguments: { task: TASK, branch: 2, beam: 2, depth: 2, scorer: "longest" } }],
        "tool_use",
      );
      return;
    }
    yield done([{ type: "text", text: "parent-done" }]);
  }
}

test("AC-7: aborting during depth 2 stops every live child and returns promptly", async () => {
  let started = 0;
  let resolveAll!: () => void;
  const allDepth2Started = new Promise<void>((r) => {
    resolveAll = r;
  });
  const provider = new DepthBlockingProvider(() => {
    if (++started === 4) resolveAll();
  });

  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  const runPromise = agent.run("kickoff");
  await allDepth2Started; // every depth-2 child's stream is now blocked on its own signal
  assert.equal(provider.depth2Signals.length, 4, "four depth-2 children started and blocked");
  assert.ok(provider.depth2Signals.every((s) => !s.aborted), "depth-2 children run until the parent aborts");

  agent.stop(); // abort the parent: the handler must stop the live (depth-2) wave, not the settled depth-1 set

  await withTimeout(runPromise, 2000, "tree_search did not return promptly after a depth-2 abort");
  for (const s of provider.depth2Signals) {
    assert.ok(s.aborted, "every live depth-2 child received stop() on the parent abort");
  }
});

// ---------------------------------------------------------------------------
// AC-8 — allSettled fault isolation: a throwing child is dropped, not fatal
// ---------------------------------------------------------------------------

/** Throws inside a fork's stream for one (or all) forks; the parent turn fires the search. */
class TreeThrowProvider implements Provider {
  readonly name = "mock";
  #calledTree = false;
  #forkRuns = 0;
  constructor(private readonly throwAll: boolean) {}
  async *stream(req: CompletionRequest): AsyncIterable<StreamEvent> {
    if (lastUserText(req) === TASK) {
      const i = this.#forkRuns++;
      if (this.throwAll || i === 0) throw new Error(`fork ${i} stream boom`);
      yield done([{ type: "text", text: "survivor" }]);
      return;
    }
    if (!this.#calledTree) {
      this.#calledTree = true;
      yield done(
        [{ type: "tool_call", id: "ts", name: "tree_search", arguments: { task: TASK, branch: 2, beam: 1, depth: 1, scorer: "longest" } }],
        "tool_use",
      );
      return;
    }
    yield done([{ type: "text", text: "parent-done" }]);
  }
}

test("AC-8: one child that throws is dropped and the best survivor is returned", async () => {
  const provider = new TreeThrowProvider(false);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await assert.doesNotReject(() => agent.run("kickoff"), "a single child throw must not reject tree_search");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, undefined, "tree_search still succeeds with one failed child");
  assert.equal(result.content, "survivor", "the surviving child's text is returned");
});

test("AC-8: when every child throws, tree_search returns a clean fail", async () => {
  const provider = new TreeThrowProvider(true);
  const { agent, host } = makeHarness({ fallback: "allow" });
  agent.providers.register(provider, { default: true });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await assert.doesNotReject(() => agent.run("kickoff"), "all children failing must surface as a result, not a throw");

  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.isError, true, "all-children-failed returns an error result");
  assert.match(result.content, /branch/i, "the failure result mentions the failed branches");
});

// ---------------------------------------------------------------------------
// AC-9 — off by default: loaded but not enabled is inert
// ---------------------------------------------------------------------------

test("AC-9: loaded-but-not-enabled tree_search is inert (no forks, disabled result)", async () => {
  let childRuns = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      childRuns++;
      return { text: "should-not-run" };
    }
    if (!calledTree) {
      calledTree = true;
      return { toolCalls: [{ name: "tree_search", arguments: { task: TASK, branch: 2, beam: 1, depth: 1 } }] };
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
// AC-10 — losing branches never mutate the parent transcript
// ---------------------------------------------------------------------------

test("AC-10: the parent transcript carries only the tree_search call, not loser turns", async () => {
  const D1_WIN = "WINNER-LONG";
  const D1_LOSE = "LOSE";
  let d1 = 0;
  let calledTree = false;
  const responder = (req: CompletionRequest) => {
    if (lastUserText(req) === TASK) {
      return { text: d1++ === 0 ? D1_WIN : D1_LOSE };
    }
    if (!calledTree) {
      calledTree = true;
      return {
        toolCalls: [
          { name: "tree_search", arguments: { task: TASK, branch: 2, beam: 1, depth: 1, scorer: "longest" } },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const { agent, host } = makeHarness({ fallback: "allow", responder });
  await host.use("reasoning-search", reasoningSearch);
  enable(host);

  await agent.run("kickoff");

  // user kickoff, assistant(tree_search call), tool(result), assistant(parent-done).
  assert.equal(agent.messages.length, 4, "no losing branch internal turns leaked into the parent");
  const result = toolResults(agent.messages)[0]!;
  assert.equal(result.content, D1_WIN, "the winner re-enters via the tool result");
  assert.ok(
    !JSON.stringify(agent.messages).includes(D1_LOSE),
    "the losing branch's text never appears in the parent transcript",
  );
});
