/**
 * Context assembly, the compaction ladder, and lazy fan-out materialisation.
 *
 * The claim these defend: context is a FUNCTION of declared inputs, so the ladder only
 * fires when one node's declared reads are genuinely too large — and when it does, it
 * stays deterministic, because rung 3's summarizer is a recorded effect.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { assembleContext, estimateTokens, project } from "../../src/run/context.ts";
import type { ChannelSpec } from "../../src/state/channels.ts";
import type { NodeId } from "../../src/ids.ts";
import { DOCS, compileSkeleton, harness } from "./skeleton.ts";

const SPECS: Record<string, ChannelSpec> = {
  findings: { type: "array", reduce: "append_ordered" },
  note: { type: "string", reduce: "replace" },
};

const base = {
  system: "You are a node.",
  instruction: "do the thing",
  channelSpecs: SPECS,
};

const big = (n: number): string => "x".repeat(n);

// ── projection ───────────────────────────────────────────────────────────────

test("a projection keeps only declared fields", () => {
  const value = [
    { host: "a", severity: 1, evidence: "long…", internal: "noise" },
    { host: "b", severity: 2, evidence: "long…", internal: "noise" },
  ];
  assert.deepEqual(project(value, { fields: ["host", "severity"], maxTokens: 999, overflow: "truncate_tail" }), [
    { host: "a", severity: 1 },
    { host: "b", severity: 2 },
  ]);
});

test("a positive take keeps the first N; a negative take keeps the LAST N", () => {
  const p = (take: number) => project([1, 2, 3, 4, 5], { take, maxTokens: 999, overflow: "truncate_tail" });
  assert.deepEqual(p(2), [1, 2]);
  assert.deepEqual(p(-2), [4, 5], "'the last twenty findings' is the common case");
});

test("no projection means the value passes through untouched", () => {
  const v = { a: 1 };
  assert.equal(project(v, undefined), v);
});

test("projection applies to a bare object too", () => {
  assert.deepEqual(project({ a: 1, b: 2 }, { fields: ["a"], maxTokens: 9, overflow: "error" }), { a: 1 });
});

// ── the ladder ───────────────────────────────────────────────────────────────

test("rung 0 — a context that fits is untouched", async () => {
  const c = await assembleContext({ ...base, channels: { note: "short" } }, { maxTokens: 10_000 });
  assert.equal(c.rung, 0);
  assert.equal(c.tokensBefore, c.tokensAfter);
  assert.deepEqual(c.channels, { note: "short" });
});

test("rung 1 — the lowest-priority sections are dropped first", async () => {
  const c = await assembleContext(
    { ...base, channels: { note: "n" }, retrieved: [big(4000)] },
    { maxTokens: 200, dropBelowPriority: 35 },
  );
  assert.ok(c.rung >= 1);
  assert.equal(c.sections.find((s) => s.name === "retrieved")?.kept, false, "retrieved goes first");
  assert.equal(c.sections.find((s) => s.name === "system")?.kept, true, "the system prompt survives");
});

test("rung 2 — a declared overflow truncates the channel, not the prompt", async () => {
  const specs: Record<string, ChannelSpec> = {
    findings: {
      type: "array",
      reduce: "append_ordered",
      contextProjection: { maxTokens: 20, overflow: "truncate_tail" },
    },
  };
  const c = await assembleContext(
    { ...base, channelSpecs: specs, channels: { findings: Array.from({ length: 200 }, (_, i) => ({ i, pad: big(40) })) } },
    { maxTokens: 300 },
  );
  assert.ok(c.rung >= 2);
  const kept = c.channels["findings"] as unknown[];
  assert.ok(kept.length < 200, "the channel shrank");
  assert.ok(kept.length > 0, "…but did not vanish");
});

test("rung 3 — the summarizer is INJECTED, so the ladder can stay deterministic", async () => {
  let called = 0;
  const c = await assembleContext(
    { ...base, channels: { note: "n" }, turns: [{ role: "assistant", content: big(8000) }] },
    {
      maxTokens: 200,
      summarize: async (text) => {
        called++;
        assert.ok(text.length > 1000, "it receives the real turns");
        return "a short summary";
      },
    },
  );
  assert.equal(called, 1);
  assert.ok(c.rung >= 3);
});

test("rung 4 — a hard truncation is MARKED, never silent", async () => {
  const c = await assembleContext({ ...base, channels: { note: big(20_000) } }, { maxTokens: 200 });
  assert.equal(c.rung, 4);
  const text = c.messages[0]!.content;
  assert.match(text, /\[\.\.\.truncated \d+ tokens\.\.\.\]/, "a model reasoning over a cut prompt should be told");
  assert.ok(c.tokensAfter <= 200);
});

test("a context that cannot be made to fit fails loudly", async () => {
  await assert.rejects(
    () => assembleContext({ ...base, system: big(40_000), channels: {} }, { maxTokens: 10 }),
    (e: unknown) => (e as { code: string }).code === "E_CONTEXT_OVERFLOW",
  );
});

test("assembly is deterministic: same inputs, same hash", async () => {
  const input = { ...base, channels: { findings: [{ a: 1 }, { a: 2 }], note: "n" } };
  const a = await assembleContext(input, { maxTokens: 10_000 });
  const b = await assembleContext(input, { maxTokens: 10_000 });
  assert.equal(a.hash, b.hash);
});

test("channel ORDER in the input does not change the hash", async () => {
  const a = await assembleContext({ ...base, channels: { note: "n", findings: [1] } }, { maxTokens: 10_000 });
  const b = await assembleContext({ ...base, channels: { findings: [1], note: "n" } }, { maxTokens: 10_000 });
  assert.equal(a.hash, b.hash, "rendering is sorted, so two equal states assemble identically");
});

test("estimateTokens is monotonic and never negative", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("abcd") <= estimateTokens("abcdefgh"));
});

// ── lazy fan-out ─────────────────────────────────────────────────────────────

test("a fan-out records its PLANNED width before materialising anything", async () => {
  const h = harness({ maxParallelism: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  await h.engine.advance(runId);

  const events = [];
  for await (const e of h.store.read(runId, 1)) events.push(e);
  const planned = events.find((e) => e.type === "fanout.planned");
  assert.ok(planned, "the join needs the width; it cannot infer it from a sibling count");
  assert.equal((planned.payload as { width: number }).width, 5);
});

test("branches materialise in bounded waves, and ALL of them still run", async () => {
  // maxParallelism 2 against a 5-way fan-out: the first wave is 2, and the rest are
  // created as slots free. Nothing is dropped.
  const h = harness({ maxParallelism: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  let p = await h.engine.advance(runId);
  const gate = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await h.engine.resolveGate(runId, {
    gateId: gate.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:a", via: "console" },
    idempotencyKey: "k",
  });

  assert.equal(p.status, "succeeded");
  assert.equal((p.channels["digests"] as unknown[]).length, 5, "every branch ran");
  assert.deepEqual([...h.reads].sort(), [...DOCS].sort());
});

test("the join waits for the PLAN, not for the first wave", async () => {
  // The bug this pins: with `expected` taken from a sibling count, the barrier fires
  // as soon as wave 1 finishes and silently drops the branches not yet created.
  const h = harness({ maxParallelism: 1 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal((p.channels["digests"] as unknown[]).length, 5, "all five folded, one at a time");
});

test("branch order survives lazy materialisation", async () => {
  const h = harness({ maxParallelism: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  const p = await h.engine.advance(runId);
  const digests = p.channels["digests"] as { path: string }[];
  assert.deepEqual(digests.map((d) => d.path), DOCS, "branch-coordinate order, not creation order");
});

test("the projection records the plan so a restart can resume the fan-out", async () => {
  const h = harness({ maxParallelism: 2 });
  const runId = await h.engine.submit({ graph: compileSkeleton(), inputs: { paths: DOCS } });
  await h.engine.advance(runId);
  const p = (await h.engine.projection(runId))!;
  const plans = Object.values(p.fanouts);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.width, 5);
  assert.equal(plans[0]?.nodeId, "summarize" as NodeId);
});
