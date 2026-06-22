/**
 * Dynamic workflow extension: a `run_workflow` tool that executes a model-emitted
 * dependency DAG of tool/agent steps. All offline via MockProvider.
 *
 * The AC-* labels map to docs/design/2026-06-20-dynamic-workflow.md §7.
 */

import assert from "node:assert/strict";
import test from "node:test";

import dynamicWorkflow, {
  MAX_STEPS,
  extractRefs,
  substitute,
  workflowChildRegistry,
} from "../src/extensions/dynamic-workflow.js";
import { defineTool, fail, ok } from "../src/kernel/define.js";
import type { ToolDecision } from "../src/kernel/events.js";
import type {
  CompletionRequest,
  Message,
  Tool,
  ToolResult,
  ToolResultBlock,
} from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness, RenamedProvider, type Harness } from "./helpers.js";

// --- helpers ----------------------------------------------------------------

/** The last user text block of a request (used to read what a child was asked). */
function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}

/** The single tool_result block produced by the parent's `run_workflow` call. */
function wfResult(messages: readonly Message[]): ToolResultBlock {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") return b;
  }
  throw new Error("no tool_result found");
}

/** A responder where the parent emits one `run_workflow` call, then says done. */
function parentEmits(
  steps: unknown[],
  childText?: (ask: string) => string,
): (req: CompletionRequest) => { text?: string; toolCalls?: { name: string; id?: string; arguments?: Record<string, unknown> }[] } {
  let parentCalls = 0;
  return (req) => {
    if (childText && req.systemPrompt.includes("WF_CHILD")) return { text: childText(lastUserText(req)) };
    parentCalls++;
    if (parentCalls === 1) return { toolCalls: [{ name: "run_workflow", id: "w1", arguments: { steps } }] };
    return { text: "parent-done" };
  };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RecOpts {
  capability?: string;
  executionMode?: "parallel" | "sequential";
  output?: string;
  fail?: boolean;
  delayMs?: number;
  onEnter?: () => void;
  onExit?: () => void;
}

/** A factory for instrumented recording tools sharing a call-order log. */
function recorder() {
  const order: string[] = [];
  const calls: Record<string, Record<string, unknown>[]> = {};
  const make = (name: string, opts: RecOpts = {}): Tool => {
    calls[name] = [];
    return defineTool({
      name,
      description: name,
      capabilities: opts.capability ? [opts.capability] : undefined,
      executionMode: opts.executionMode,
      parameters: { type: "object", properties: {} },
      execute: async (args) => {
        order.push(name);
        calls[name]!.push(args);
        opts.onEnter?.();
        if (opts.delayMs) await delay(opts.delayMs);
        opts.onExit?.();
        const text = opts.output ?? `${name}-out`;
        return opts.fail ? fail(text) : ok(text);
      },
    });
  };
  return { order, calls, make };
}

/** Build a harness with the workflow extension active and tools registered. */
async function workflowHarness(opts: {
  responder: (req: CompletionRequest) => unknown;
  fallback?: "allow" | "deny" | "ask";
  tools?: Tool[];
}): Promise<Harness> {
  const h = makeHarness({ responder: opts.responder as never, fallback: opts.fallback ?? "allow" });
  for (const t of opts.tools ?? []) h.agent.tools.register(t);
  await h.host.use("dynamic-workflow", dynamicWorkflow);
  return h;
}

// --- T1: pure substitution primitives (AC-1 primitive) ----------------------

test("extractRefs finds ${id} tokens in string leaves only", () => {
  assert.deepEqual(new Set(extractRefs("hello ${a} and ${b}")), new Set(["a", "b"]));
  assert.deepEqual(new Set(extractRefs({ x: "use ${a}", y: ["nested ${b}", 5], z: 7 })), new Set(["a", "b"]));
  assert.deepEqual(extractRefs("no refs here"), []);
});

test("substitute replaces declared ids and leaves unknown tokens verbatim", () => {
  assert.equal(substitute("got ${a}", { a: "X" }), "got X");
  assert.deepEqual(substitute({ in: "a=${a},b=${b}" }, { a: "1", b: "2" }), { in: "a=1,b=2" });
  // An unknown token is left exactly as written (legitimate ${HOME}-style text).
  assert.equal(substitute("path ${HOME}", { a: "X" }), "path ${HOME}");
});

// --- T2: up-front validation rejects malformed specs (AC-5, AC-6, AC-9) -----

test("AC-5/AC-6/AC-9: invalid specs are rejected before any step runs", async () => {
  const cases: { name: string; steps: unknown[]; match: RegExp }[] = [
    {
      name: "cycle",
      steps: [
        { id: "a", tool: "rec", needs: ["b"] },
        { id: "b", tool: "rec", needs: ["a"] },
      ],
      match: /cycle/,
    },
    {
      name: "needs unknown id",
      steps: [{ id: "a", tool: "rec", needs: ["ghost"] }],
      match: /unknown step "ghost"/,
    },
    {
      name: "duplicate id",
      steps: [
        { id: "a", tool: "rec" },
        { id: "a", tool: "rec" },
      ],
      match: /duplicate step id "a"/,
    },
    {
      name: "unregistered tool",
      steps: [{ id: "a", tool: "nope" }],
      match: /unregistered tool "nope"/,
    },
    {
      name: "names run_workflow",
      steps: [{ id: "a", tool: "run_workflow" }],
      match: /no nested workflows/,
    },
    {
      name: "over MAX_STEPS",
      steps: Array.from({ length: MAX_STEPS + 1 }, (_, i) => ({ id: `s${i}`, tool: "rec" })),
      match: /over the limit/,
    },
    {
      name: "missing required input",
      steps: [{ id: "a", type: "agent" }],
      match: /needs a non-empty `prompt`/,
    },
  ];

  for (const c of cases) {
    const rec = recorder();
    const h = await workflowHarness({ responder: parentEmits(c.steps), tools: [rec.make("rec")] });
    await h.agent.run("go");
    const res = wfResult(h.agent.messages);
    assert.equal(res.isError, true, `${c.name}: expected isError`);
    assert.match(res.content, c.match, `${c.name}: message`);
    assert.equal(rec.order.length, 0, `${c.name}: no step should run`);
  }
});

test("AC-6 companion: a ${unknownId} token is left verbatim, not rejected", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([{ id: "a", tool: "rec", args: { in: "literal ${nope}" } }]),
    tools: [rec.make("rec")],
  });
  await h.agent.run("go");
  const res = wfResult(h.agent.messages);
  assert.equal(res.isError, undefined);
  assert.equal(rec.calls.rec![0]!.in, "literal ${nope}");
});

// --- T3: data flow (AC-1, AC-2) ---------------------------------------------

test("AC-1: linear data flow substitutes an upstream output into a downstream input", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([
      { id: "a", tool: "rec_a" },
      { id: "b", tool: "rec_b", args: { in: "got ${a}" } },
    ]),
    tools: [rec.make("rec_a", { output: "AOUT" }), rec.make("rec_b")],
  });
  await h.agent.run("go");
  assert.ok(rec.order.indexOf("rec_a") < rec.order.indexOf("rec_b"), "a runs before b");
  assert.equal(rec.calls.rec_b![0]!.in, "got AOUT");
});

test("AC-2: parallel independent steps fan in to a dependent step", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([
      { id: "a", tool: "rec_a" },
      { id: "b", tool: "rec_b" },
      { id: "c", tool: "rec_c", args: { in: "${a}|${b}" } },
    ]),
    tools: [
      rec.make("rec_a", { output: "AA" }),
      rec.make("rec_b", { output: "BB" }),
      rec.make("rec_c"),
    ],
  });
  await h.agent.run("go");
  assert.ok(rec.order.indexOf("rec_c") > rec.order.indexOf("rec_a"), "c after a");
  assert.ok(rec.order.indexOf("rec_c") > rec.order.indexOf("rec_b"), "c after b");
  assert.equal(rec.calls.rec_c![0]!.in, "AA|BB");
});

// --- T4: tool-step guard is the faithful kernel mirror (AC-4, AC-7, 7b, 7c) -

test("AC-4: a tool step honors capabilities (denied → error + skip; granted → runs)", async () => {
  // fallback deny: the gated tool's capability is not granted, so it is denied,
  // while its independent sibling (no capability) still completes.
  const rec = recorder();
  const denied = await workflowHarness({
    responder: parentEmits([
      { id: "gated", tool: "needs_fs" },
      { id: "free", tool: "free_tool" },
    ]),
    fallback: "deny",
    tools: [rec.make("needs_fs", { capability: "fs:read" }), rec.make("free_tool")],
  });
  await denied.agent.run("go");
  const res = wfResult(denied.agent.messages);
  assert.equal(res.isError, true);
  assert.match(res.content, /\[gated\] \(error\)/);
  assert.match(res.content, /\[free\] \(done\)/);
  assert.equal(rec.calls.needs_fs!.length, 0, "denied tool never executes");
  assert.equal(rec.calls.free_tool!.length, 1, "sibling still completes");

  // fallback allow: the same gated tool now runs.
  const rec2 = recorder();
  const allowed = await workflowHarness({
    responder: parentEmits([{ id: "gated", tool: "needs_fs" }]),
    fallback: "allow",
    tools: [rec2.make("needs_fs", { capability: "fs:read" })],
  });
  await allowed.agent.run("go");
  assert.equal(wfResult(allowed.agent.messages).isError, undefined);
  assert.equal(rec2.calls.needs_fs!.length, 1);
});

test("AC-7: a beforeToolCall block vetoes a workflow tool step (no policy bypass)", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([{ id: "a", tool: "blockme" }]),
    tools: [rec.make("blockme")],
  });
  h.agent.hooks.filter("beforeToolCall", (d: ToolDecision, ctx) =>
    ctx.call.name === "blockme" ? { ...d, block: true, reason: "nope" } : d,
  );
  await h.agent.run("go");
  const res = wfResult(h.agent.messages);
  assert.equal(res.isError, true);
  assert.match(res.content, /\[a\] \(error\)/);
  assert.equal(rec.calls.blockme!.length, 0, "blocked tool never executes");
});

test("AC-7b: beforeToolCall rewrites are re-validated before reaching the tool", async () => {
  // A filter rewrites the args; the tool must receive the rewritten value.
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([{ id: "a", tool: "rec", args: { in: "original" } }]),
    tools: [rec.make("rec")],
  });
  h.agent.hooks.filter("beforeToolCall", (d: ToolDecision, ctx) =>
    ctx.call.name === "rec" ? { ...d, arguments: { in: "REWRITTEN" } } : d,
  );
  await h.agent.run("go");
  assert.equal(rec.calls.rec![0]!.in, "REWRITTEN", "tool receives the rewritten args");

  // A filter rewriting to a schema-invalid value yields the after-guards error
  // and the tool is NOT executed.
  const numTool = defineTool({
    name: "needs_num",
    description: "needs_num",
    parameters: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] },
    execute: async () => ok("ran"),
  });
  let executed = false;
  const numTool2: Tool = {
    ...numTool,
    execute: async (a, c) => {
      executed = true;
      return numTool.execute(a, c);
    },
  };
  const h2 = await workflowHarness({
    responder: parentEmits([{ id: "a", tool: "needs_num", args: { n: 1 } }]),
    tools: [numTool2],
  });
  h2.agent.hooks.filter("beforeToolCall", (d: ToolDecision, ctx) =>
    ctx.call.name === "needs_num" ? { ...d, arguments: { n: "not-a-number" } } : d,
  );
  await h2.agent.run("go");
  const res = wfResult(h2.agent.messages);
  assert.equal(res.isError, true);
  assert.match(res.content, /after guards/);
  assert.equal(executed, false, "tool must not run on invalid post-guard args");
});

test("AC-7c: afterToolCall runs on every outcome (success and denial)", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([
      { id: "ok", tool: "free_tool" },
      { id: "bad", tool: "needs_fs" },
    ]),
    fallback: "deny",
    tools: [rec.make("free_tool"), rec.make("needs_fs", { capability: "fs:read" })],
  });
  h.agent.hooks.filter("afterToolCall", (r: ToolResult, ctx) =>
    ctx.call.id.startsWith("wf:") ? { ...r, content: `${r.content}#TAG` } : r,
  );
  await h.agent.run("go");
  const res = wfResult(h.agent.messages);
  // Both the successful step's output and the denied step's error output carry
  // the afterToolCall tag — the filter fired on each.
  assert.match(res.content, /\[ok\] \(done\): free_tool-out#TAG/);
  assert.match(res.content, /\[bad\] \(error\):.*#TAG/);
});

// --- T5: agent step + recursion guard (AC-3, AC-10) -------------------------

test("AC-3: an agent step's child output is captured and substitutable", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits(
      [
        { id: "a", type: "agent", prompt: "summarize", system: "WF_CHILD agent" },
        { id: "b", tool: "rec", args: { in: "child said ${a}" } },
      ],
      (ask) => `answer:${ask}`,
    ),
    tools: [rec.make("rec")],
  });
  await h.agent.run("go");
  const res = wfResult(h.agent.messages);
  assert.match(res.content, /\[a\] \(done\): answer:summarize/);
  assert.equal(rec.calls.rec![0]!.in, "child said answer:summarize");
});

test("AC-10: workflowChildRegistry omits run_workflow but keeps other tools", () => {
  const wf = defineTool({ name: "run_workflow", description: "wf", execute: async () => ok("") });
  const other = defineTool({ name: "reader", description: "r", execute: async () => ok("") });
  const reg = workflowChildRegistry([wf, other]);
  assert.equal(reg.has("run_workflow"), false);
  assert.equal(reg.has("reader"), true);
});

// --- T6: fail-fast isolation across a diamond (AC-8) ------------------------

test("AC-8: a failed branch skips only its dependents; independent branches finish", async () => {
  const rec = recorder();
  const h = await workflowHarness({
    responder: parentEmits([
      { id: "a", tool: "rec_a" },
      { id: "b", tool: "boom", needs: ["a"] },
      { id: "c", tool: "rec_c", needs: ["a"] },
      { id: "d", tool: "rec_d", needs: ["b"] },
    ]),
    tools: [
      rec.make("rec_a"),
      rec.make("boom", { fail: true }),
      rec.make("rec_c"),
      rec.make("rec_d"),
    ],
  });
  await h.agent.run("go");
  const res = wfResult(h.agent.messages);
  assert.equal(res.isError, true);
  assert.match(res.content, /\[a\] \(done\)/);
  assert.match(res.content, /\[b\] \(error\)/);
  assert.match(res.content, /\[c\] \(done\)/);
  assert.match(res.content, /\[d\] \(skipped\)/);
  assert.equal(rec.calls.rec_d!.length, 0, "d's dependent tool never runs");
  assert.equal(rec.calls.rec_c!.length, 1, "independent branch c completes");
});

// --- T7: sequential-mode tools are not interleaved (AC-11) ------------------

test("AC-11: a sequential-mode tool is not interleaved; parallel tools may overlap", async () => {
  // sequential: two ready steps naming a sequential tool never overlap.
  let activeSeq = 0;
  let maxSeq = 0;
  const seqRec = recorder();
  const seqTool = seqRec.make("seq", {
    executionMode: "sequential",
    delayMs: 15,
    onEnter: () => {
      activeSeq++;
      maxSeq = Math.max(maxSeq, activeSeq);
    },
    onExit: () => {
      activeSeq--;
    },
  });
  const hSeq = await workflowHarness({
    responder: parentEmits([
      { id: "s1", tool: "seq" },
      { id: "s2", tool: "seq" },
    ]),
    tools: [seqTool],
  });
  await hSeq.agent.run("go");
  assert.equal(maxSeq, 1, "sequential tool steps must not overlap");

  // parallel control: two parallel-mode steps DO overlap.
  let activePar = 0;
  let maxPar = 0;
  const parRec = recorder();
  const parTool = parRec.make("par", {
    delayMs: 15,
    onEnter: () => {
      activePar++;
      maxPar = Math.max(maxPar, activePar);
    },
    onExit: () => {
      activePar--;
    },
  });
  const hPar = await workflowHarness({
    responder: parentEmits([
      { id: "p1", tool: "par" },
      { id: "p2", tool: "par" },
    ]),
    tools: [parTool],
  });
  await hPar.agent.run("go");
  assert.equal(maxPar, 2, "parallel tool steps overlap");
});

// ---------------------------------------------------------------------------
// subagents-least-privilege parity (D6/AC-8): the same three passthroughs on
// the workflow `agent` step.
// ---------------------------------------------------------------------------

/** Register an fs:write `mutate` tool that flips a flag (denial is observable). */
function mutateTool(agent: Harness["agent"], flag: { wrote: boolean }): void {
  agent.tools.register(
    defineTool({
      name: "mutate",
      description: "Writes (declares fs:write).",
      capabilities: ["fs:write"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        flag.wrote = true;
        return { content: "mutated" };
      },
    }),
  );
}

/** Register a shell:exec `lint` tool that flips a flag (allow is observable). */
function lintTool(agent: Harness["agent"], flag: { linted: boolean }): void {
  agent.tools.register(
    defineTool({
      name: "lint",
      description: "Lints (declares shell:exec).",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: {} },
      execute: () => {
        flag.linted = true;
        return { content: "linted" };
      },
    }),
  );
}

/**
 * A parent that emits one agent-step workflow; the WF_CHILD then calls each tool
 * in `childToolCalls` (one per turn) before finishing with `childFinal`.
 */
function parentEmitsAgentStep(
  stepExtra: Record<string, unknown>,
  childToolCalls: string[],
  childFinal = "child-done",
): (req: CompletionRequest) => unknown {
  let parentCalls = 0;
  let childStep = 0;
  return (req) => {
    if (req.systemPrompt.includes("WF_CHILD")) {
      if (childStep < childToolCalls.length) {
        const name = childToolCalls[childStep]!;
        childStep++;
        return { toolCalls: [{ name, arguments: {} }] };
      }
      return { text: childFinal };
    }
    parentCalls++;
    if (parentCalls === 1) {
      return {
        toolCalls: [
          {
            name: "run_workflow",
            id: "w1",
            arguments: {
              steps: [{ id: "a", type: "agent", prompt: "go", system: "WF_CHILD", ...stepExtra }],
            },
          },
        ],
      };
    }
    return { text: "parent-done" };
  };
}

test("AC-8: an agent step's `capabilities` allowlist scopes the child (granted runs, ungranted denied)", async () => {
  const linted = { linted: false };
  const wrote = { wrote: false };
  const h = makeHarness({
    responder: parentEmitsAgentStep({ capabilities: ["shell:exec"] }, ["lint", "mutate"]) as never,
    fallback: "allow",
  });
  lintTool(h.agent, linted);
  mutateTool(h.agent, wrote);
  await h.host.use("dynamic-workflow", dynamicWorkflow);

  await h.agent.run("go");

  assert.equal(linted.linted, true, "shell:exec granted → lint runs inside the DAG");
  assert.equal(wrote.wrote, false, "fs:write not in allowlist → mutate denied inside the DAG");
});

test("AC-8: an agent step's `provider` routes the child to the named provider", async () => {
  let parentChildCalls = 0;
  let criticChildCalls = 0;
  let parentSpawned = false;
  const parentMock = new MockProvider((req) => {
    if (req.systemPrompt.includes("WF_CHILD")) {
      parentChildCalls++;
      return { text: "parent-child" };
    }
    if (!parentSpawned) {
      parentSpawned = true;
      return {
        toolCalls: [
          {
            name: "run_workflow",
            id: "w1",
            arguments: { steps: [{ id: "a", type: "agent", prompt: "go", system: "WF_CHILD", provider: "critic" }] },
          },
        ],
      };
    }
    return { text: "parent-done" };
  });
  const criticMock = new MockProvider((req) => {
    if (req.systemPrompt.includes("WF_CHILD")) {
      criticChildCalls++;
      return { text: "critic-child" };
    }
    return { text: "" };
  });

  const h = makeHarness({ fallback: "allow" });
  h.agent.providers.register(parentMock, { default: true });
  h.agent.providers.register(new RenamedProvider("critic", criticMock));
  await h.host.use("dynamic-workflow", dynamicWorkflow);

  await h.agent.run("go");

  const res = wfResult(h.agent.messages);
  assert.match(res.content, /critic-child/, "the agent step's child ran on the critic provider");
  assert.equal(criticChildCalls, 1);
  assert.equal(parentChildCalls, 0, "the parent provider was not used for the child");
});

test("AC-8: an agent step's `outputSchema` validates and surfaces the child's typed JSON", async () => {
  // The child emits confidence as a string; only the typed path coerces it to a
  // number, so the rendered step output reflects the validated object.
  let parentCalls = 0;
  const responder = (req: CompletionRequest) => {
    if (req.systemPrompt.includes("WF_CHILD")) {
      return { text: JSON.stringify({ status: "ok", confidence: "0.9" }) };
    }
    parentCalls++;
    if (parentCalls === 1) {
      return {
        toolCalls: [
          {
            name: "run_workflow",
            id: "w1",
            arguments: {
              steps: [
                {
                  id: "a",
                  type: "agent",
                  prompt: "verify",
                  system: "WF_CHILD",
                  outputSchema: {
                    type: "object",
                    properties: { status: { type: "string" }, confidence: { type: "number" } },
                    required: ["status", "confidence"],
                  },
                },
              ],
            },
          },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const h = makeHarness({ responder: responder as never, fallback: "allow" });
  await h.host.use("dynamic-workflow", dynamicWorkflow);
  await h.agent.run("go");

  const res = wfResult(h.agent.messages);
  assert.equal(res.isError, undefined, "valid typed return is not an error");
  assert.match(res.content, /\[a\] \(done\)/);
  // The step's rendered output is the validated JSON, with confidence coerced to a number.
  assert.match(res.content, /"confidence":0\.9/);
});

test("AC-8: an agent step's invalid typed return re-prompts once then errors with contract violation", async () => {
  let parentCalls = 0;
  const responder = (req: CompletionRequest) => {
    if (req.systemPrompt.includes("WF_CHILD")) return { text: "not json at all" };
    parentCalls++;
    if (parentCalls === 1) {
      return {
        toolCalls: [
          {
            name: "run_workflow",
            id: "w1",
            arguments: {
              steps: [
                {
                  id: "a",
                  type: "agent",
                  prompt: "verify",
                  system: "WF_CHILD",
                  outputSchema: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
                },
              ],
            },
          },
        ],
      };
    }
    return { text: "parent-done" };
  };

  const h = makeHarness({ responder: responder as never, fallback: "allow" });
  await h.host.use("dynamic-workflow", dynamicWorkflow);
  await h.agent.run("go");

  const res = wfResult(h.agent.messages);
  assert.equal(res.isError, true);
  assert.match(res.content, /\[a\] \(error\)/);
  assert.match(res.content, /contract violation/);
});

test("AC-9: EAGENT_SUBAGENTS_LP=off makes the agent step's new fields a no-op", async () => {
  const prev = process.env.EAGENT_SUBAGENTS_LP;
  process.env.EAGENT_SUBAGENTS_LP = "off";
  try {
    const wrote = { wrote: false };
    const h = makeHarness({
      responder: parentEmitsAgentStep({ capabilities: ["shell:exec"] }, ["mutate"]) as never,
      fallback: "allow",
    });
    mutateTool(h.agent, wrote);
    await h.host.use("dynamic-workflow", dynamicWorkflow);

    await h.agent.run("go");

    assert.equal(wrote.wrote, true, "with the kill switch off, the child inherits the parent manager and writes");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_SUBAGENTS_LP;
    else process.env.EAGENT_SUBAGENTS_LP = prev;
  }
});

test("AC-10: unloading dynamic-workflow is clean and removes run_workflow", async () => {
  const h = makeHarness({ fallback: "allow" });
  await h.host.use("dynamic-workflow", dynamicWorkflow);
  assert.ok(h.agent.tools.get("run_workflow"), "run_workflow is registered after load");

  await assert.doesNotReject(() => h.host.unload("dynamic-workflow"), "unload throws nothing");
  assert.equal(h.agent.tools.get("run_workflow"), undefined, "run_workflow is gone after unload");
});
