import assert from "node:assert/strict";
import { test } from "node:test";
import { agentStatuses, mergeSessionList } from "./agents.js";
import type { Section } from "@eagent/view-model";

const base = {
  rootId: "a0",
  startTs: 0,
  lastTs: 1,
  collapsed: false,
  children: [] as Section[],
};

test("mergeSessionList always surfaces current chat session", () => {
  const rows = mergeSessionList(
    [{ id: "other", running: false, usage: { inputTokens: 1, outputTokens: 2 }, costUsd: 0.1 }],
    "mine",
    true,
  );
  assert.equal(rows[0]!.id, "mine");
  assert.equal(rows[0]!.current, true);
  assert.equal(rows[0]!.localOnly, true);
  assert.equal(rows[0]!.running, true);
  assert.equal(rows.length, 2);
});

test("mergeSessionList marks current when already on server", () => {
  const rows = mergeSessionList(
    [
      { id: "mine", running: true, usage: { inputTokens: 3, outputTokens: 4 }, costUsd: 0 },
      { id: "other", running: false, usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0 },
    ],
    "mine",
    false,
  );
  assert.equal(rows[0]!.id, "mine");
  assert.equal(rows[0]!.current, true);
  assert.equal(rows[0]!.localOnly, false);
  assert.equal(rows[0]!.usage.inputTokens, 3);
});

test("agentStatuses nests child agents separately from root", () => {
  const sections: Section[] = [
    {
      ...base,
      id: "s1",
      kind: "answer",
      actingId: "a0",
      status: "success",
      text: "hi",
    },
    {
      ...base,
      id: "s2",
      kind: "tool",
      actingId: "a0",
      status: "success",
      name: "spawn_agent",
      callId: "c1",
      arguments: {},
      spawn: true,
      children: [
        {
          ...base,
          id: "s3",
          kind: "tool",
          actingId: "a1",
          rootId: "a0",
          status: "streaming",
          name: "bash",
          callId: "c2",
          arguments: { cmd: "ls" },
          spawn: false,
          children: [],
        },
      ],
    },
  ];
  const st = agentStatuses(sections, "a0");
  assert.equal(st.length, 2);
  assert.equal(st[0]!.id, "a0");
  assert.equal(st[0]!.isRoot, true);
  assert.equal(st[1]!.id, "a1");
  assert.equal(st[1]!.toolsRunning, 1);
  assert.ok(st[1]!.labels.includes("bash"));
});
