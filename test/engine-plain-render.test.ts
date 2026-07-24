/**
 * The engine plain renderer — the non-Ink path that must preserve both shipped
 * pain-point fixes (AC-engine-plain).
 *
 * de-interleaving:  two real `childScope()` reasoning-search forks under
 *                   `Promise.allSettled` (the render-attribution harness) → each
 *                   fork's reasoning renders in its OWN section, never merged.
 * collapse:         finished reasoning collapses to a one-line header, its body
 *                   reachable on demand — not dumped.
 * full params:      a tool card summarizes by default; /expand + /details full
 *                   reveal the entire untruncated args + result.
 * machine parity:   a fake non-TTY Term carries no alt-screen/cursor/spinner bytes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Agent } from "../src/kernel/agent.js";
import { ProviderRegistry } from "../src/kernel/registry.js";
import { defineTool, ok } from "../src/kernel/define.js";
import { MockProvider } from "../src/providers/mock.js";
import { EngineRenderer } from "../src/engine-render.js";
import { wireViewModel } from "../src/attribution.js";
import { initialModel, reduce, type RenderEvent, type ViewModel } from "../src/view-model.js";
import { SPINNER_FRAMES } from "../src/tty.js";
import type { ToolCallBlock, ToolResult } from "../src/kernel/types.js";
import { makeFakeTerm, makeHarness } from "./helpers.js";

const call = (name: string, id: string, args: Record<string, unknown> = {}): ToolCallBlock => ({
  type: "tool_call",
  id,
  name,
  arguments: args,
});
const result = (content: string, isError = false): ToolResult => ({ content, isError });

/** Fold a scripted single-agent stream into the renderer. */
function drive(renderer: EngineRenderer, events: RenderEvent[], root = "root"): void {
  let m: ViewModel = initialModel();
  let at = 0;
  m = reduce(m, { kind: "agent_start", actingId: root, rootId: root, at: at++ });
  renderer.onModel(m);
  for (const ev of events) {
    m = reduce(m, { ...ev, actingId: root, rootId: root, at: at++ });
    renderer.onModel(m);
  }
}

test("de-interleaves concurrent reasoning-search forks — each fork's reasoning in its own section", async () => {
  const { agent: parent, provider: rootProvider } = makeHarness();

  // A fork shares the parent's governed bus (childScope) but streams its OWN,
  // recognizable content; the mock chunks it so the two forks' deltas interleave.
  const mkChild = (tag: string): Agent =>
    new Agent({
      providers: (() => {
        const p = new ProviderRegistry();
        p.register(new MockProvider({ reasoning: tag.repeat(60), text: tag.repeat(20) }), { default: true });
        return p;
      })(),
      hooks: parent.hooks.childScope(),
      capabilities: parent.capabilities,
      model: "mock",
      provider: "mock",
    });

  const forkTool = defineTool({
    name: "best_of_n",
    description: "fork two children concurrently",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const a = mkChild("A");
      const b = mkChild("B");
      await Promise.allSettled([a.run("task"), b.run("task")]);
      return ok("forked");
    },
  });
  parent.tools.register(forkTool);
  rootProvider.script((_req, i) => (i === 0 ? { toolCalls: [{ name: "best_of_n" }] } : { text: "final answer" }));

  const term = makeFakeTerm({ isTTY: false, columns: 80 });
  const renderer = new EngineRenderer({ term });
  let counter = 0;
  wireViewModel(parent, (m) => renderer.onModel(m), { now: () => counter++ });

  await parent.run("start");

  const out = term.output;
  // Each fork's reasoning renders as a contiguous, single-fork run — impossible if
  // concurrent deltas had been merged into one buffer (the reasoning-search flood).
  assert.ok(out.includes("A".repeat(60)), "forkA's reasoning renders as its own un-interleaved section");
  assert.ok(out.includes("B".repeat(60)), "forkB's reasoning renders as its own un-interleaved section");
  // No rendered line mixes the two forks' distinct reasoning glyphs.
  for (const line of renderer.committedLines) {
    assert.ok(!(/A/.test(line) && /B/.test(line)), `no committed line mixes forks: ${JSON.stringify(line.slice(0, 16))}`);
  }
});

test("collapses finished reasoning to a header — the full body is not dumped on the plain path", () => {
  const term = makeFakeTerm({ isTTY: false, columns: 80 });
  const renderer = new EngineRenderer({ term });
  drive(renderer, [
    { kind: "reasoning_delta", text: "deep private reasoning here" },
    { kind: "text_delta", text: "the visible answer" },
    { kind: "message", role: "assistant" },
    { kind: "agent_end", reason: "end_turn" },
  ]);

  const out = term.output;
  assert.match(out, /◆ Reasoning/, "reasoning committed as a collapsed one-line header");
  assert.doesNotMatch(out, /deep private reasoning here/, "the full reasoning body is not dumped (collapsed)");
  assert.match(out, /the visible answer/, "the answer body still reaches the plain stream");
});

test("a tool card summarizes by default; /expand and /details full reveal the full untruncated args + result", () => {
  const term = makeFakeTerm({ isTTY: false, columns: 100 });
  const renderer = new EngineRenderer({ term });
  const bigArgs = {
    command: "deploy --region us-east-1 --service api ".repeat(6),
    note: "z".repeat(80),
  };
  assert.ok(JSON.stringify(bigArgs).length > 200, "args exceed the summary trigger");
  const multiline = ["result line 1", "result line 2", "result line 3", "result line 4"].join("\n");

  drive(renderer, [
    { kind: "tool_start", call: call("bash", "c1", bigArgs) },
    { kind: "tool_end", call: call("bash", "c1", bigArgs), result: result(multiline) },
    { kind: "text_delta", text: "done" },
    { kind: "message", role: "assistant" },
    { kind: "agent_end", reason: "end_turn" },
  ]);

  // Auto (collapsed card): a header with a bounded summary, NOT the whole payload.
  const collapsed = renderer.committedLines.join("\n");
  assert.match(collapsed, /→ bash/, "the collapsed card shows a header");
  assert.ok(!collapsed.includes(JSON.stringify(bigArgs)), "collapsed: the full args string is NOT dumped");
  assert.ok(!collapsed.includes("result line 3"), "collapsed: the full result is NOT dumped");

  // /expand 1 targets the tool card (section 1) and reveals its full body below.
  const beforeExpand = renderer.committedLines.length;
  renderer.applyControl({ kind: "expand", n: 1 });
  const revealed = renderer.committedLines.slice(beforeExpand).join("\n");
  assert.ok(revealed.includes(`args: ${JSON.stringify(bigArgs)}`), "/expand reveals the ENTIRE args string, no … elision");
  for (const line of multiline.split("\n")) assert.ok(revealed.includes(line), `/expand reveals result line: ${line}`);

  // /details full reveals every section's full body too (mode-level control).
  const beforeMode = renderer.committedLines.length;
  renderer.applyControl({ kind: "mode", mode: "full" });
  const afterMode = renderer.committedLines.slice(beforeMode).join("\n");
  assert.ok(afterMode.includes(JSON.stringify(bigArgs)), "/details full reveals the entire args string");
  assert.equal(renderer.mode, "full", "the mode getter reflects the applied /details full");
});

test("the engine plain renderer emits no alt-screen, cursor, or spinner bytes (machine parity)", () => {
  const term = makeFakeTerm({ isTTY: false, columns: 80 });
  const renderer = new EngineRenderer({ term });
  drive(renderer, [
    { kind: "reasoning_delta", text: "thinking about it\nsecond line" },
    { kind: "tool_start", call: call("bash", "c1", { cmd: "ls" }) },
    { kind: "tool_end", call: call("bash", "c1", { cmd: "ls" }), result: result("a\nb") },
    { kind: "text_delta", text: "the answer" },
    { kind: "message", role: "assistant" },
    { kind: "agent_end", reason: "end_turn" },
  ]);

  const out = term.output;
  assert.doesNotMatch(out, /\x1b\[\?1049/, "no alt-screen enter/exit");
  assert.doesNotMatch(out, /\x1b\[\d*A/, "no cursor-up rewrites");
  for (const frame of SPINNER_FRAMES) assert.ok(!out.includes(frame), `no spinner frame ${frame}`);
  assert.match(out, /the answer/, "the answer text still reaches the plain stream");
});
