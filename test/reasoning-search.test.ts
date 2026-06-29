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

import type { CompletionRequest, Message, ToolResult, ToolResultBlock } from "../src/kernel/types.js";
import { defineTool } from "../src/kernel/define.js";
import reasoningSearch, { childRegistryFrom } from "../src/extensions/reasoning-search.js";
import { lastText, makeHarness } from "./helpers.js";

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

test("AC-5: a child's registry omits best_of_n (and spawn_agent) — no re-fork", () => {
  const bestOfN = defineTool({ name: "best_of_n", description: "x", execute: () => ({ content: "" }) });
  const spawn = defineTool({ name: "spawn_agent", description: "x", execute: () => ({ content: "" }) });
  const helper = defineTool({ name: "helper", description: "x", execute: () => ({ content: "" }) });

  const childTools = childRegistryFrom([bestOfN, spawn, helper]);

  assert.equal(childTools.has("best_of_n"), false, "the recursion guard removes best_of_n");
  assert.equal(childTools.has("spawn_agent"), false, "spawn_agent is also removed");
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
