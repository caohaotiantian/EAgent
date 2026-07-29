/**
 * The monitor wire contract.
 *
 * These are the assertions that used to live in the deleted
 * `test/session-source.test.ts`, re-expressed against the TUI's event
 * vocabulary per decision D5. Entirely offline — the input is parsed JSON, so no
 * server, socket, or clock is involved.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isTranscriptEvent, parseSessions, parseSse, wireToEvent, type MonitorEvent } from "./wire.js";

const ctx = { session: "s1", at: 100 };
const map = (p: Record<string, unknown>): MonitorEvent | undefined => wireToEvent(p, ctx);

test("streaming text maps to a transcript event tagged with its session", () => {
  const e = map({ type: "text_delta", text: "hello" });

  assert.deepEqual(e, { kind: "text_delta", text: "hello", actingId: "s1", at: 100 });
});

test("a sub-agent frame keeps its OWN identity, not the session's", () => {
  const e = map({ type: "text_delta", text: "child", actingId: "sub-7" });

  assert.equal(e?.kind === "text_delta" && e.actingId, "sub-7", "so a fork does not merge into the root");
});

test("tool frames carry the call id both spellings the server has used", () => {
  const byId = map({ type: "tool_start", id: "c1", name: "read", arguments: { f: "a" } });
  assert.equal(byId?.kind === "tool_start" && byId.callId, "c1");

  const byCallId = map({ type: "tool_start", callId: "c2", name: "read" });
  assert.equal(byCallId?.kind === "tool_start" && byCallId.callId, "c2");
});

test("a tool_start with no arguments still produces a valid event", () => {
  const e = map({ type: "tool_start", id: "c1", name: "read" });

  assert.deepEqual(e?.kind === "tool_start" && e.arguments, {});
});

test("tool_end carries the error flag", () => {
  const ok = map({ type: "tool_end", id: "c1", content: "fine", isError: false });
  const bad = map({ type: "tool_end", id: "c1", content: "boom", isError: true });

  assert.equal(ok?.kind === "tool_end" && ok.isError, false);
  assert.equal(bad?.kind === "tool_end" && bad.isError, true);
});

test("usage prefers the cumulative total", () => {
  const e = map({ type: "usage", usage: { inputTokens: 1, outputTokens: 1 }, cumulative: { inputTokens: 10, outputTokens: 5 } });

  assert.equal(e?.kind === "usage" && e.total, 15);
});

test("an error frame becomes a visible notice, not a silent drop", () => {
  const e = map({ type: "error", where: "tool", message: "exploded" });

  assert.equal(e?.kind === "notice" && e.text, "tool: exploded");
});

test("an elicitation is surfaced so a remote turn can be answered", () => {
  const e = map({ type: "action_required", id: 3, question: "which?", options: ["a", "b"] });

  assert.deepEqual(e, { kind: "action_required", id: 3, question: "which?", options: ["a", "b"] });
});

test("an UNKNOWN frame type is ignored, never thrown on", () => {
  // A newer server must not be able to crash an older client.
  assert.equal(map({ type: "something_new_in_2027", payload: 1 }), undefined);
  assert.equal(map({}), undefined);
});

test("isTranscriptEvent separates what the reducer accepts", () => {
  assert.equal(isTranscriptEvent(map({ type: "text_delta", text: "x" })!), true);
  assert.equal(isTranscriptEvent(map({ type: "action_required", id: 1, question: "q", options: null })!), false);
});

// -- SSE framing -------------------------------------------------------------

test("complete SSE frames parse, and a partial one is carried forward", () => {
  const { events, rest } = parseSse('data: {"type":"text_delta","text":"a"}\n\ndata: {"type":"tex');

  assert.equal(events.length, 1);
  assert.equal(events[0]?.["text"], "a");
  assert.equal(rest, 'data: {"type":"tex', "the partial frame is not dropped");
});

test("a split frame reassembles across chunks", () => {
  const first = parseSse('data: {"type":"text_del');
  assert.deepEqual(first.events, []);

  const second = parseSse(first.rest + 'ta","text":"joined"}\n\n');
  assert.equal(second.events[0]?.["text"], "joined");
});

test("a malformed frame is skipped without killing the stream", () => {
  const { events } = parseSse('data: {not json\n\ndata: {"type":"text_delta","text":"survived"}\n\n');

  assert.equal(events.length, 1, "the good frame still arrives");
  assert.equal(events[0]?.["text"], "survived");
});

test("keep-alive comments and blank data lines are ignored", () => {
  const { events } = parseSse(": keep-alive\n\ndata:\n\n");

  assert.deepEqual(events, []);
});

// -- the session list --------------------------------------------------------

test("the session list maps id, running, cost, and tokens", () => {
  const out = parseSessions([
    { id: "a", running: true, costUsd: 0.25, usage: { inputTokens: 100, outputTokens: 40 } },
    { id: "b", running: false },
  ]);

  assert.deepEqual(out, [
    { id: "a", running: true, costUsd: 0.25, tokens: 140 },
    { id: "b", running: false, costUsd: undefined, tokens: undefined },
  ]);
});

test("a malformed session list degrades to empty rather than throwing", () => {
  assert.deepEqual(parseSessions(null), []);
  assert.deepEqual(parseSessions({ not: "an array" }), []);
  assert.deepEqual(parseSessions([null, 42, { noId: true }]), [], "entries without an id are dropped");
});
