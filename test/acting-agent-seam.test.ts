/**
 * Acting-agent seam (W9.1) — childScope guard governance acts on the ACTING
 * agent, and per-run guard state is partitioned per agent.
 *
 * Offline against MockProvider. A child is constructed exactly the way
 * `subagents` does it — `new Agent({ …, hooks: parent.hooks.childScope() })` —
 * so the parent's shared gate filters and intra-run event handlers govern the
 * child, while the run-lifecycle events stay suppressed. Pre-seam these tests
 * fail because the guards resolve `e.agent` (the parent, bound once at
 * activation) instead of the running child.
 *
 * Covers AC-4 (acts on the child), AC-5 (no state collision under concurrency),
 * AC-6 (otel namespacing + child spans emitted), AC-7 (flow-guard cross-agent
 * capability taint preserved + intra-child data taint), and the kernel seam.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent, currentActingAgent } from "../src/kernel/agent.js";
import { defineTool, ok } from "../src/kernel/define.js";
import { ProviderRegistry, ToolRegistry } from "../src/kernel/registry.js";
import type { CompletionRequest, Message, Tool, ToolResult } from "../src/kernel/types.js";
import budgetCap from "../src/extensions/budget-cap.js";
import citations from "../src/extensions/citations.js";
import circuitBreaker from "../src/extensions/circuit-breaker.js";
import flowGuard from "../src/extensions/flow-guard.js";
import otelExporter from "../src/extensions/otel-exporter.js";
import outputContract from "../src/extensions/output-contract.js";
import routing from "../src/extensions/routing.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";
import { makeHarness } from "./helpers.js";

// --- shared test helpers ---------------------------------------------------

/** Tool messages so far in a request — drives a scripted child turn sequence. */
function toolMsgCount(req: CompletionRequest): number {
  return req.messages.filter((m) => m.role === "tool").length;
}

/** The space-joined text of a message's text blocks. */
function textOf(m: Message): string {
  return m.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join(" ");
}

/** Does any message in the transcript carry text matching `re`? */
function transcriptHas(agent: Agent, re: RegExp): boolean {
  return agent.messages.some((m) => re.test(textOf(m)));
}

/**
 * A child agent constructed the way `subagents` constructs one: its own
 * provider + tool registry, but the PARENT's hook bus via `childScope()` (so the
 * parent's gate filters and intra-run observers govern it) and the parent's
 * capabilities/ui/logger.
 */
function makeChild(parent: Agent, system: string, script: MockResponder, tools: Tool[]): Agent {
  const providers = new ProviderRegistry();
  providers.register(new MockProvider(script), { default: true });
  const registry = new ToolRegistry();
  for (const t of tools) registry.register(t);
  return new Agent({
    providers,
    capabilities: parent.capabilities,
    ui: parent.ui,
    logger: parent.logger,
    model: "mock",
    provider: "mock",
    systemPrompt: system,
    tools: registry,
    hooks: parent.hooks.childScope(),
  });
}

/** Save/restore a set of env keys around a test body. */
async function withEnv(keys: string[], body: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    await body();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// Kernel seam — currentActingAgent()
// ---------------------------------------------------------------------------

test("kernel: currentActingAgent() is undefined outside a run and the running agent inside it", async () => {
  assert.equal(currentActingAgent(), undefined, "no acting agent outside any run()");

  const { agent } = makeHarness({ responder: [{ text: "hi" }] });
  let seenInTool: Agent | undefined;
  agent.tools.register(
    defineTool({
      name: "who",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        seenInTool = currentActingAgent();
        return ok("ok");
      },
    }),
  );
  agent.providers.register(new MockProvider((req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "who", arguments: {} }] } : { text: "done" })), {
    default: true,
  });
  await agent.run("go");
  assert.equal(seenInTool, agent, "inside a tool the acting agent is the running agent");
  assert.equal(currentActingAgent(), undefined, "the acting-agent context is cleared after run() returns");
});

// ---------------------------------------------------------------------------
// AC-4 — the guard acts on the CHILD, never the parent
// ---------------------------------------------------------------------------

test("AC-4 circuit-breaker: a child's repetition steers the CHILD, not the parent", async () => {
  await withEnv(["EAGENT_CIRCUIT_BREAKER"], async () => {
    delete process.env.EAGENT_CIRCUIT_BREAKER;
    const { agent: parent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("circuit-breaker", circuitBreaker);
    // A high threshold so only the soft steer (at the 2nd identical call) fires —
    // no hard trip, no ui.confirm.
    commands.get("circuit-breaker")!.run({ agent: parent as never, args: "threshold=5", print: () => {} });

    let ran = 0;
    const noop = defineTool({
      name: "noop",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        ran++;
        return ok("ok");
      },
    });
    // Three identical calls, then finish.
    const child = makeChild(parent, "CHILD", (req) => (toolMsgCount(req) < 3 ? { toolCalls: [{ name: "noop", arguments: {} }] } : { text: "done" }), [noop]);

    await child.run("go");

    const nudge = /circuit-breaker: you are repeating an identical call/;
    assert.ok(transcriptHas(child, nudge), "the child was steered (the nudge landed in the child transcript)");
    assert.ok(!transcriptHas(parent, nudge), "the parent was NOT steered");
    assert.equal(ran, 3, "all three identical calls still executed (soft steer never blocks)");
  });
});

test("AC-4 output-contract: a child's invalid `respond` reask writes the CHILD, not the parent", async () => {
  await withEnv(["EAGENT_OUTPUT_CONTRACT"], async () => {
    delete process.env.EAGENT_OUTPUT_CONTRACT;
    const { agent: parent, host } = makeHarness({ fallback: "allow" });
    await host.use("output-contract", outputContract);

    const schema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } as const;
    const respond = defineTool({
      name: "respond",
      description: "final output",
      parameters: schema as never,
      execute: (): ToolResult => ({ content: "recorded", terminate: true }),
    });
    // Turn 1 calls respond with a missing field (kernel refuses → reask path);
    // turn 2 finishes with text so `forceTool` is left set on the child.
    const child = makeChild(parent, "CHILD", (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "respond", arguments: {} }] } : { text: "giving up" }), [respond]);
    child.outputSchema = schema as never;

    await child.run("go");

    assert.equal(child.forceTool, "respond", "the child's forceTool was set by the reask");
    assert.ok(transcriptHas(child, /did not match the required output schema/), "the child got the reask steer");
    assert.equal(parent.forceTool, undefined, "the parent's forceTool was NOT touched");
    assert.equal(parent.output, undefined, "the parent's output was NOT touched");
  });
});

test("AC-4 routing: an enabled child turn routes the CHILD's model, leaving the parent untouched", async () => {
  await withEnv(["EAGENT_ROUTING"], async () => {
    delete process.env.EAGENT_ROUTING;
    const { agent: parent, host } = makeHarness({ fallback: "allow" });
    parent.model = "mock-parent";
    await host.use("routing", (e) => {
      e.store.set("enabled", true);
      e.store.set("tiers", { cheap: "mock-cheap", flagship: "mock-flagship" });
      return routing(e);
    });

    // A trivial single-turn child: the heuristic routes "cheap". The script
    // records the model each turn streamed with (the post-routing value).
    const childModels: string[] = [];
    const child = makeChild(
      parent,
      "CHILD",
      (req) => {
        childModels.push(req.model);
        return { text: "done" };
      },
      [],
    );
    child.model = "mock-child";

    await child.run("rename this variable");

    assert.equal(childModels[0], "mock-cheap", "the child's turn streamed with the routed (cheap) model — routing acted on the child");
    assert.equal(parent.model, "mock-parent", "the parent's model was never touched");
  });
});

test("AC-4 routing: a soft-disabled child turn restores the CHILD's own baseline, not the parent's", async () => {
  await withEnv(["EAGENT_ROUTING"], async () => {
    delete process.env.EAGENT_ROUTING;
    const { agent: parent, host } = makeHarness({ fallback: "allow" });
    parent.model = "mock-parent";
    // Soft switch OFF (enabled=false): the turn_start listener still fires and
    // restores the baseline — but it must restore the CHILD's own baseline, not
    // the parent's (the shared-closure-var bug this guards against).
    await host.use("routing", (e) => {
      e.store.set("enabled", false);
      e.store.set("tiers", { cheap: "mock-cheap", flagship: "mock-flagship" });
      return routing(e);
    });

    const childModels: string[] = [];
    const child = makeChild(
      parent,
      "CHILD",
      (req) => {
        childModels.push(req.model);
        return { text: "done" };
      },
      [],
    );
    child.model = "mock-child";

    await child.run("go");

    assert.equal(childModels[0], "mock-child", "the disabled branch restored the child's OWN baseline, not the parent's");
    assert.equal(parent.model, "mock-parent", "the parent's model was never touched");
  });
});

// ---------------------------------------------------------------------------
// AC-5 — no per-run state collision under concurrency (WeakMap partition)
// ---------------------------------------------------------------------------

test("AC-5 circuit-breaker: two concurrent children with an identical signature don't cross-trip", async () => {
  await withEnv(["EAGENT_CIRCUIT_BREAKER"], async () => {
    delete process.env.EAGENT_CIRCUIT_BREAKER;
    const { agent: parent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("circuit-breaker", circuitBreaker);
    // block mode + threshold 3: the 3rd identical occurrence in a SINGLE bucket
    // would block. Each child only makes 2 → with per-agent buckets none blocks;
    // with a shared bucket the combined 4 calls trip and block two of them.
    commands.get("circuit-breaker")!.run({ agent: parent as never, args: "block", print: () => {} });

    let ran = 0;
    const dup = defineTool({
      name: "dup",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        ran++;
        return ok("ok");
      },
    });

    let blocked = 0;
    parent.hooks.on("tool_end", ({ result }) => {
      if (result.isError && /circuit-breaker/.test(result.content)) blocked++;
    });

    const script: MockResponder = (req) => (toolMsgCount(req) < 2 ? { toolCalls: [{ name: "dup", arguments: {} }] } : { text: "done" });
    const a = makeChild(parent, "CHILD-A", script, [dup]);
    const b = makeChild(parent, "CHILD-B", script, [dup]);

    await Promise.all([a.run("a"), b.run("b")]);

    assert.equal(ran, 4, "each child ran its two calls — no cross-bucket trip (partitioned)");
    assert.equal(blocked, 0, "no circuit-breaker block fired");
  });
});

test("AC-5 budget-cap: two concurrent children's run spend is partitioned per agent", async () => {
  await withEnv(["EAGENT_BUDGET_CAP"], async () => {
    delete process.env.EAGENT_BUDGET_CAP;
    const { agent: parent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("budget-cap", budgetCap);
    // Price "mock" so the first usage of a child (input ≈ 2 tok) costs $2; cap $3.
    // A single child's first usage ($2) is under cap; two children sharing one
    // counter would reach $4 ≥ $3 and block. mode defaults to "block".
    commands.get("budget-cap")!.run({ agent: parent as never, args: "pricecard mock 1000000 0", print: () => {} });
    commands.get("budget-cap")!.run({ agent: parent as never, args: "run=3", print: () => {} });

    let ran = 0;
    const work = defineTool({
      name: "work",
      description: "x",
      parameters: { type: "object", properties: {} },
      execute: () => {
        ran++;
        return ok("ok");
      },
    });

    let blocked = 0;
    parent.hooks.on("tool_end", ({ result }) => {
      if (result.isError && /budget-cap/.test(result.content)) blocked++;
    });

    const script: MockResponder = (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "work", arguments: {} }] } : { text: "done" });
    // A 1-char system prompt + "go" input pins the first usage to 2 input tokens.
    const a = makeChild(parent, "S", script, [work]);
    const b = makeChild(parent, "S", script, [work]);

    await Promise.all([a.run("go"), b.run("go")]);

    assert.equal(ran, 2, "each child ran its single tool call — run spend is per-agent");
    assert.equal(blocked, 0, "no budget-cap block fired (no shared-counter trip)");
  });
});

test("AC-5 citations: two concurrent children's source ids are partitioned (each starts at [src:1])", async () => {
  await withEnv(["EAGENT_CITATIONS"], async () => {
    delete process.env.EAGENT_CITATIONS;
    const { agent: parent, host } = makeHarness({ fallback: "allow" });
    await host.use("citations", (e) => {
      e.store.set("enabled", true);
      return citations(e);
    });

    const grab = defineTool({
      name: "grab",
      description: "x",
      capabilities: ["net:fetch"],
      parameters: { type: "object", properties: {} },
      execute: () => ok("body"),
    });
    // citations.isRetrieval reads the PARENT registry — register the tool there
    // too (the flow-guard cross-agent pattern).
    parent.tools.register(grab);

    const script: MockResponder = (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "grab", arguments: {} }] } : { text: "done" });
    const a = makeChild(parent, "CHILD-A", script, [grab]);
    const b = makeChild(parent, "CHILD-B", script, [grab]);

    await Promise.all([a.run("a"), b.run("b")]);

    const firstResult = (agent: Agent): string => {
      const m = agent.messages.find((mm) => mm.role === "tool");
      const blk = m?.content.find((bb) => bb.type === "tool_result");
      return blk && blk.type === "tool_result" ? blk.content : "";
    };
    // With a single shared counter the two forks would commingle to [src:1]/[src:2];
    // the per-agent WeakMap partition gives each its own counter starting at 1.
    assert.ok(firstResult(a).startsWith("[src:1] "), `child A's first retrieval is [src:1]; got: ${firstResult(a)}`);
    assert.ok(firstResult(b).startsWith("[src:1] "), `child B's first retrieval is [src:1]; got: ${firstResult(b)}`);
  });
});

// ---------------------------------------------------------------------------
// AC-6 — otel: concurrent forks emit distinct, correctly-parented traces
// ---------------------------------------------------------------------------

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
}

function spansOfBody(body: string): OtlpSpan[] {
  const parsed = JSON.parse(body) as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] };
  return parsed.resourceSpans[0]!.scopeSpans[0]!.spans;
}
function toolName(s: OtlpSpan): string | undefined {
  return s.attributes.find((a) => a.key === "gen_ai.tool.name")?.value.stringValue;
}

test("AC-6 otel: two concurrent forks under one parent emit distinct, correctly-parented traces", async () => {
  await withEnv(["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "EAGENT_OTEL"], async () => {
    for (const k of ["OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_HEADERS", "EAGENT_OTEL"]) delete process.env[k];
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://collector.test:4318/v1/traces";

    const bodies: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    try {
      const { agent: parent, host } = makeHarness({ fallback: "allow" });
      await host.use("otel-exporter", otelExporter);

      const leaf = defineTool({ name: "leaf", description: "x", parameters: { type: "object", properties: {} }, execute: () => ok("leaf") });
      const childScript: MockResponder = (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "leaf", arguments: {} }] } : { text: "child-done" });

      const fork = defineTool({
        name: "fork",
        description: "run two children concurrently",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          const a = makeChild(parent, "FORK-A", childScript, [leaf]);
          const b = makeChild(parent, "FORK-B", childScript, [leaf]);
          await Promise.all([a.run("a"), b.run("b")]);
          return ok("forked");
        },
      });
      parent.tools.register(fork);
      parent.providers.register(new MockProvider((req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "fork", arguments: {} }] } : { text: "parent-done" })), {
        default: true,
      });

      await parent.run("go");

      assert.equal(bodies.length, 1, "exactly one POST at the parent's agent_end");
      const spans = spansOfBody(bodies[0]!);

      // Three distinct traces: parent + two forks.
      const traceIds = new Set(spans.map((s) => s.traceId));
      assert.equal(traceIds.size, 3, "parent and each fork emit a distinct traceId (no shared/colliding trace)");

      // Each fork's leaf span is present (non-zero child spans) and in its own trace.
      const leafSpans = spans.filter((s) => toolName(s) === "leaf");
      assert.equal(leafSpans.length, 2, "one leaf span per fork (child spans are emitted, not zero)");
      assert.equal(new Set(leafSpans.map((s) => s.traceId)).size, 2, "each fork's leaf is in its own trace");

      // Correct intra-trace parenting: a leaf parents to a turn span in the SAME trace.
      for (const leaf of leafSpans) {
        const parentTurn = spans.find((s) => s.spanId === leaf.parentSpanId);
        assert.ok(parentTurn, "the leaf span parents to an existing span");
        assert.equal(parentTurn!.traceId, leaf.traceId, "the leaf's parent turn is in the same trace");
        assert.match(parentTurn!.name, /^turn /, "the leaf parents to a turn span");
      }

      // Every span is closed at flush (best-effort end-ts on the still-open roots).
      for (const s of spans) assert.ok(s.endTimeUnixNano !== undefined, "every flushed span is closed");

      await host.dispose();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// AC-7 — flow-guard: cross-agent capability taint preserved + intra-child data
// ---------------------------------------------------------------------------

test("AC-7(a) flow-guard: a child's shell:exec source taints the shared Set — another agent's egress is held", async () => {
  await withEnv(["EAGENT_FLOW_GUARD"], async () => {
    delete process.env.EAGENT_FLOW_GUARD;
    const { agent: parent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("flow-guard", flowGuard);
    commands.get("flow-guard")!.run({ agent: parent as never, args: "block", print: () => {} });

    const source = defineTool({ name: "source", description: "x", capabilities: ["shell:exec"], parameters: { type: "object", properties: {} }, execute: () => ok("ran") });
    let egressRuns = 0;
    const egress = defineTool({
      name: "egress",
      description: "x",
      capabilities: ["net:fetch"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        egressRuns++;
        return ok("sent");
      },
    });
    // capsOf reads the parent registry — register the tools there too.
    parent.tools.register(source);
    parent.tools.register(egress);

    const childA = makeChild(parent, "CHILD-A", (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "source", arguments: {} }] } : { text: "a-done" }), [source]);
    await childA.run("a");

    const egressResults: ToolResult[] = [];
    parent.hooks.on("tool_end", ({ call, result }) => {
      if (call.name === "egress") egressResults.push(result);
    });
    const childB = makeChild(parent, "CHILD-B", (req) => (toolMsgCount(req) === 0 ? { toolCalls: [{ name: "egress", arguments: {} }] } : { text: "b-done" }), [egress]);
    await childB.run("b");

    assert.equal(egressRuns, 0, "the second child's egress body never ran (cross-agent capability taint)");
    assert.equal(egressResults.length, 1, "the egress reached the shared tool_end once");
    assert.ok(egressResults[0]!.isError && /flow-guard: blocked/.test(egressResults[0]!.content), "flow-guard held it");
  });
});

test("AC-7(b) flow-guard: a child fs:read-taints its OWN transcript, then the SAME child's egress is held", async () => {
  await withEnv(["EAGENT_FLOW_GUARD"], async () => {
    delete process.env.EAGENT_FLOW_GUARD;
    const { agent: parent, host, commands } = makeHarness({ fallback: "allow" });
    await host.use("flow-guard", flowGuard);
    commands.get("flow-guard")!.run({ agent: parent as never, args: "block", print: () => {} });

    const fread = defineTool({
      name: "fread",
      description: "x",
      capabilities: ["fs:read"],
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: () => ok("file body"),
    });
    let egressRuns = 0;
    const egress = defineTool({
      name: "egress",
      description: "x",
      capabilities: ["net:fetch"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        egressRuns++;
        return ok("sent");
      },
    });
    parent.tools.register(fread);
    parent.tools.register(egress);

    const egressResults: ToolResult[] = [];
    parent.hooks.on("tool_end", ({ call, result }) => {
      if (call.name === "egress") egressResults.push(result);
    });

    const child = makeChild(
      parent,
      "CHILD",
      (req) => {
        const n = toolMsgCount(req);
        if (n === 0) return { toolCalls: [{ name: "fread", arguments: { path: "/home/u/my-secret.txt" } }] };
        if (n === 1) return { toolCalls: [{ name: "egress", arguments: {} }] };
        return { text: "done" };
      },
      [fread, egress],
    );
    await child.run("go");

    assert.equal(egressRuns, 0, "the child's egress was held — the sink read the child's OWN tainted transcript");
    assert.equal(egressResults.length, 1, "the egress reached the shared tool_end once");
    assert.ok(egressResults[0]!.isError && /flow-guard: blocked/.test(egressResults[0]!.content), "flow-guard held the intra-child data egress");
    // The parent transcript stayed clean (data taint never crossed into it).
    assert.equal(parent.messages.length, 0, "the parent never ran and was untouched");
  });
});
