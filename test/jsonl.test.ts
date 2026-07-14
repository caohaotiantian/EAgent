/**
 * The shared JSONL serializer: the mapper's per-event canonical shapes (AC1) and
 * the `wireJsonl` in-process wiring golden (AC2 layer-2) that pins the six common
 * streaming events byte-for-byte against the pre-refactor CLI strings.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { eventToJsonl, wireJsonl } from "../src/jsonl.js";
import type { Agent } from "../src/kernel/index.js";
import type { Message, ToolCallBlock, ToolResult, Usage } from "../src/kernel/types.js";

const message: Message = { role: "assistant", content: [{ type: "text", text: "hi" }] };
const call: ToolCallBlock = { type: "tool_call", id: "call_1", name: "read", arguments: { path: "/x" } };
const usage: Usage = { inputTokens: 10, outputTokens: 5 };
const cumulative: Usage = { inputTokens: 100, outputTokens: 50 };

// ── AC1 — mapper units (exact shape, values, and key insertion order) ──────────

test("eventToJsonl text_delta → {type,text}", () => {
  assert.equal(JSON.stringify(eventToJsonl("text_delta", { text: "hi" })), '{"type":"text_delta","text":"hi"}');
});

test("eventToJsonl reasoning_delta → {type,text}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("reasoning_delta", { text: "hmm" })),
    '{"type":"reasoning_delta","text":"hmm"}',
  );
});

test("eventToJsonl message → {type,role,content}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("message", { message })),
    '{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}',
  );
});

test("eventToJsonl tool_start → {type,id,name,arguments}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("tool_start", { call })),
    '{"type":"tool_start","id":"call_1","name":"read","arguments":{"path":"/x"}}',
  );
});

test("eventToJsonl tool_end defaults isError via ?? false and drops step", () => {
  const result: ToolResult = { content: "ok" }; // isError undefined
  const out = eventToJsonl("tool_end", { call, result, step: 3 });
  assert.equal(
    JSON.stringify(out),
    '{"type":"tool_end","id":"call_1","name":"read","isError":false,"content":"ok"}',
  );
  assert.ok(!("step" in out), "tool_end must not leak the kernel-only `step` field");
});

test("eventToJsonl tool_end passes through isError:true", () => {
  const result: ToolResult = { content: "bad", isError: true };
  assert.equal(
    JSON.stringify(eventToJsonl("tool_end", { call, result, step: 2 })),
    '{"type":"tool_end","id":"call_1","name":"read","isError":true,"content":"bad"}',
  );
});

test("eventToJsonl usage → {type,usage,cumulative} and drops model", () => {
  const out = eventToJsonl("usage", { usage, cumulative, model: "mock-model" });
  assert.equal(
    JSON.stringify(out),
    '{"type":"usage","usage":{"inputTokens":10,"outputTokens":5},"cumulative":{"inputTokens":100,"outputTokens":50}}',
  );
  assert.ok(!("model" in out), "usage must not leak the kernel-only `model` field");
});

test("eventToJsonl agent_end (CLI, no session) → {type,reason,usage}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("agent_end", { reason: "end_turn", usage })),
    '{"type":"agent_end","reason":"end_turn","usage":{"inputTokens":10,"outputTokens":5}}',
  );
});

test("eventToJsonl agent_end (server, with session) → {type,reason,usage,session}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("agent_end", { reason: "end_turn", usage, session: "s1" })),
    '{"type":"agent_end","reason":"end_turn","usage":{"inputTokens":10,"outputTokens":5},"session":"s1"}',
  );
});

test("eventToJsonl error → {type,where,message}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("error", { where: "agent.run", message: "boom" })),
    '{"type":"error","where":"agent.run","message":"boom"}',
  );
});

test("eventToJsonl action_required → {type,id,question,options}", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("action_required", { id: 1, question: "Proceed?", options: ["yes", "no"] })),
    '{"type":"action_required","id":1,"question":"Proceed?","options":["yes","no"]}',
  );
});

test("eventToJsonl action_required defaults options via ?? null", () => {
  assert.equal(
    JSON.stringify(eventToJsonl("action_required", { id: 2, question: "Continue?" })),
    '{"type":"action_required","id":2,"question":"Continue?","options":null}',
  );
});

// ── AC2 layer-2 — in-process wiring golden ─────────────────────────────────────

/** A scripted stand-in for `Agent`: `hooks.on` records handlers per event and
 *  returns a real `{dispose}` that removes the recorded handler. `fire` invokes a
 *  recorded handler; `count` reports how many are registered for an event. */
function makeMockAgent() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const hooks = {
    on(event: string, fn: (payload: never) => void) {
      let set = handlers.get(event);
      if (!set) handlers.set(event, (set = new Set()));
      const handler = fn as (payload: unknown) => void;
      set.add(handler);
      return {
        dispose() {
          set!.delete(handler);
        },
      };
    },
  };
  return {
    agent: { hooks } as unknown as Agent,
    fire(event: string, payload: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    count(event: string): number {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

test("wireJsonl emits the six common events byte-identical to the CLI", () => {
  const mock = makeMockAgent();
  const lines: string[] = [];
  const emit = (obj: unknown): void => void lines.push(JSON.stringify(obj) + "\n");

  const subs = wireJsonl(emit, mock.agent);

  mock.fire("text_delta", { text: "hi" });
  mock.fire("reasoning_delta", { text: "hmm" });
  mock.fire("message", { message });
  mock.fire("tool_start", { call });
  mock.fire("tool_end", { call, result: { content: "done" } as ToolResult, step: 1 });
  mock.fire("usage", { usage, cumulative, model: "m" });

  assert.deepEqual(lines, [
    '{"type":"text_delta","text":"hi"}\n',
    '{"type":"reasoning_delta","text":"hmm"}\n',
    '{"type":"message","role":"assistant","content":[{"type":"text","text":"hi"}]}\n',
    '{"type":"tool_start","id":"call_1","name":"read","arguments":{"path":"/x"}}\n',
    '{"type":"tool_end","id":"call_1","name":"read","isError":false,"content":"done"}\n',
    '{"type":"usage","usage":{"inputTokens":10,"outputTokens":5},"cumulative":{"inputTokens":100,"outputTokens":50}}\n',
  ]);

  assert.equal(subs.length, 6);
  for (const sub of subs) assert.equal(typeof sub.dispose, "function");
});

test("wireJsonl subscriptions unsubscribe on dispose", () => {
  const mock = makeMockAgent();
  const lines: string[] = [];
  const emit = (obj: unknown): void => void lines.push(JSON.stringify(obj) + "\n");

  const subs = wireJsonl(emit, mock.agent);
  for (const event of ["text_delta", "reasoning_delta", "message", "tool_start", "tool_end", "usage"]) {
    assert.equal(mock.count(event), 1);
  }

  for (const sub of subs) sub.dispose();
  for (const event of ["text_delta", "reasoning_delta", "message", "tool_start", "tool_end", "usage"]) {
    assert.equal(mock.count(event), 0);
  }

  mock.fire("text_delta", { text: "after" });
  assert.deepEqual(lines, []);
});
