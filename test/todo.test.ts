/**
 * todo — a session-scoped, in-memory todo list. `todowrite` replaces the list
 * and echoes the canonical render; `/todos` shows it; session reset clears it.
 * The tool declares no capability, so it runs even under `fallback:"deny"`.
 * Fully offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defineTool } from "../src/kernel/define.js";
import type { Tool, ToolContext, ToolResult } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";
import todo from "../src/extensions/todo.js";

function ctx(): ToolContext {
  return {
    toolCallId: "t",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: { model: "mock", messages: [], steer: () => {}, followUp: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function loadTodo(): Promise<Harness> {
  const h = makeHarness();
  await h.host.use("todo", todo);
  return h;
}

function write(h: Harness, todos: unknown): Promise<ToolResult> {
  const tool = h.agent.tools.get("todowrite") as Tool | undefined;
  assert.ok(tool, "todowrite should be registered");
  return tool!.execute({ todos }, ctx());
}

function todos(h: Harness): string[] {
  const out: string[] = [];
  h.commands.get("todos")!.run({ agent: h.agent, args: "", print: (l) => out.push(l) });
  return out;
}

test("AC-2: write echoes the list in the canonical D6 format", async () => {
  const h = await loadTodo();
  const r = await write(h, [
    { content: "a", status: "pending", priority: "high" },
    { content: "b", status: "completed", priority: "low" },
  ]);
  assert.equal(r.isError, undefined);
  assert.equal(r.content, "Todos (1/2 done):\n- [ ] a (high)\n- [x] b (low)");
});

test("AC-3: a second write replaces the whole list", async () => {
  const h = await loadTodo();
  await write(h, [{ content: "a", status: "pending", priority: "high" }]);
  const r = await write(h, [{ content: "c", status: "in_progress", priority: "medium" }]);
  assert.equal(r.content, "Todos (0/1 done):\n- [~] c (medium)");
  assert.ok(!r.content.includes("a (high)"), "the first list's items must be gone");
});

test("AC-4: an invalid status fails naming the field and leaves the list unchanged", async () => {
  const h = await loadTodo();
  await write(h, [{ content: "keep", status: "pending", priority: "high" }]);
  const r = await write(h, [{ content: "x", status: "bogus", priority: "high" }]);
  assert.equal(r.isError, true);
  assert.match(r.content, /status/);
  assert.match(r.content, /pending/);
  assert.match(r.content, /in_progress/);
  // The previous valid list still stands.
  assert.deepEqual(todos(h), ["Todos (0/1 done):\n- [ ] keep (high)"]);
});

test("AC-5: an invalid priority fails naming the field", async () => {
  const h = await loadTodo();
  const r = await write(h, [{ content: "x", status: "pending", priority: "urgent" }]);
  assert.equal(r.isError, true);
  assert.match(r.content, /priority/);
  assert.match(r.content, /high/);
});

test("AC-5: empty content fails naming the field", async () => {
  const h = await loadTodo();
  const r = await write(h, [{ content: "", status: "pending", priority: "high" }]);
  assert.equal(r.isError, true);
  assert.match(r.content, /content/);
});

test("AC-6: /todos renders the current list, or (no todos) before any write", async () => {
  const h = await loadTodo();
  assert.deepEqual(todos(h), ["(no todos)"]);
  await write(h, [{ content: "a", status: "pending", priority: "high" }]);
  assert.deepEqual(todos(h), ["Todos (0/1 done):\n- [ ] a (high)"]);
});

test("AC-7: session_start clears the list", async () => {
  const h = await loadTodo();
  await write(h, [{ content: "a", status: "pending", priority: "high" }]);
  await h.agent.hooks.emit("session_start", {});
  assert.deepEqual(todos(h), ["(no todos)"]);
});

test("AC-8: todowrite needs no capability and runs under fallback:deny", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: [
      {
        toolCalls: [
          {
            name: "todowrite",
            arguments: { todos: [{ content: "a", status: "pending", priority: "high" }] },
          },
        ],
      },
      { text: "done" },
    ],
  });
  await h.host.use("todo", todo);

  await h.agent.run("track a task");

  const results = h.agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  assert.equal(results.length, 1);
  const result = results[0]!;
  assert.equal(result.type === "tool_result" && result.isError, undefined, "no capability => not denied");
  assert.ok(
    result.type === "tool_result" && result.content.includes("Todos (0/1 done):"),
    "the tool executed and echoed the list",
  );
});

test("AC-8 control: a tool declaring shell:exec IS blocked under fallback:deny", async () => {
  const h = makeHarness({
    fallback: "deny",
    responder: [{ toolCalls: [{ name: "run_shell" }] }, { text: "done" }],
  });
  h.agent.tools.register(
    defineTool({ name: "run_shell", description: "", capabilities: ["shell:exec"], execute: () => ({ content: "ran" }) }),
  );

  await h.agent.run("run something");

  const blocked = h.agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .some((b) => b.type === "tool_result" && b.isError === true && /shell:exec/.test(b.content));
  assert.ok(blocked, "the capability-declaring tool must be denied, proving the harness is not allow-all");
});
