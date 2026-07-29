/**
 * The `tool_progress` lifecycle event (AC7).
 *
 * `ToolContext.progress` existed but reached only `logger.debug`, so a renderer
 * had no way to stream a long shell command's output inside its tool card — it
 * could only show the finished result. This pins the event: it fires with the
 * originating call (so a renderer can attribute the chunk to the right card) and
 * it does not disturb the tool's own result.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool, ok } from "../src/kernel/define.js";
import type { ToolCallBlock } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

/** A tool that emits progress chunks before returning. */
const chatty = defineTool({
  name: "chatty",
  description: "emits progress",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    ctx.progress("line one");
    ctx.progress("line two");
    return ok("finished");
  },
});

test("AC7: progress chunks reach the hook bus, tagged with their call", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "chatty", id: "c1" }] }, { text: "done" }],
  });
  agent.tools.register(chatty);

  const seen: { call: ToolCallBlock; chunk: string }[] = [];
  agent.hooks.on("tool_progress", (e) => void seen.push(e));

  await agent.run("go");

  assert.deepEqual(seen.map((s) => s.chunk), ["line one", "line two"], "both chunks, in order");
  assert.equal(seen[0]?.call.id, "c1", "the chunk names the call it belongs to");
  assert.equal(seen[0]?.call.name, "chatty");
});

test("AC7: a tool that never calls progress emits nothing", async () => {
  const quiet = defineTool({
    name: "quiet",
    description: "no progress",
    parameters: { type: "object", properties: {} },
    async execute() {
      return ok("done");
    },
  });
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "quiet", id: "q1" }] }, { text: "done" }],
  });
  agent.tools.register(quiet);

  let fired = 0;
  agent.hooks.on("tool_progress", () => void fired++);

  await agent.run("go");

  assert.equal(fired, 0);
});

test("AC7: progress is observation only — the tool result is unaffected", async () => {
  const { agent } = makeHarness({
    responder: [{ toolCalls: [{ name: "chatty", id: "c1" }] }, { text: "done" }],
  });
  agent.tools.register(chatty);

  const results: string[] = [];
  agent.hooks.on("tool_end", ({ result }) => void results.push(result.content));

  await agent.run("go");

  assert.deepEqual(results, ["finished"], "the result is the tool's, not the progress stream");
});
