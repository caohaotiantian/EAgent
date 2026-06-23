/**
 * output-contract — schema-validated final output via a `respond` tool +
 * validate-and-reask.
 *
 * Offline node:test against the scriptable MockProvider. Loads only `core-tools`
 * (baseline tool list) plus `output-contract`, so any `respond`/reask behavior is
 * unambiguously this extension's. The output schema fixture is the single
 * `SCHEMA` constant below — declared as a plain `JSONSchema` literal (NOT
 * `as const`, which would make `required` a readonly tuple and break assignment
 * to `JSONSchema`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import coreTools from "../src/extensions/core-tools.js";
import outputContract, { buildReask, validateOutput } from "../src/extensions/output-contract.js";
import type { JSONSchema, Message } from "../src/kernel/types.js";
import type { MockTurn } from "../src/providers/mock.js";
import { lastText, makeHarness } from "./helpers.js";

const SCHEMA: JSONSchema = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
};

function respondTurn(args: Record<string, unknown>): MockTurn {
  return { toolCalls: [{ name: "respond", arguments: args }] };
}

/** Collect every steered/queued user-message text in the transcript. */
function userTexts(messages: readonly Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const b of m.content) if (b.type === "text") out.push(b.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// P1.2 — Unit tests for the exported pure helpers.
// ---------------------------------------------------------------------------

test("validateOutput: a conforming arg-object validates and surfaces the typed value", () => {
  const r = validateOutput(SCHEMA, { name: "Ada", age: 36 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "Ada", age: 36 });
});

test("validateOutput: coercion parity with input (string age → number)", () => {
  const r = validateOutput(SCHEMA, { name: "Ada", age: "36" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { name: "Ada", age: 36 });
});

test("validateOutput: invalid yields the EXACT per-field validator error", () => {
  const r = validateOutput(SCHEMA, { name: "Ada" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("$.age: required property missing"));
});

test("buildReask: the reask text carries the exact validator strings verbatim", () => {
  const { errors } = validateOutput(SCHEMA, { name: "Ada" });
  const reask = buildReask([...errors]);
  assert.match(reask, /\$\.age: required property missing/);
  assert.match(reask, /respond/);
});

// ---------------------------------------------------------------------------
// P1.4 — Live agent-loop tests via makeHarness + scripted MockProvider.
// ---------------------------------------------------------------------------

test("live (a): valid respond → typed output surfaced + turn ends; respond tool = schema, disposed after", async () => {
  const h = makeHarness({ responder: [respondTurn({ name: "Ada", age: 36 })] });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  // Capture the respond tool's parameters from inside the run.
  let seenParams: JSONSchema | undefined;
  h.agent.hooks.on("tool_start", ({ call }) => {
    if (call.name === "respond") seenParams = h.agent.tools.get("respond")?.spec.parameters;
  });

  const result = await h.agent.run("produce a person");

  assert.deepEqual(h.agent.output, { value: { name: "Ada", age: 36 }, ok: true });
  assert.equal(result.reason, "stop");
  assert.deepEqual(seenParams, SCHEMA);
  assert.equal(h.agent.tools.get("respond"), undefined);
});

test("live (b): invalid → reask with EXACT per-field error → then valid → success", async () => {
  const h = makeHarness({
    responder: [respondTurn({ name: "Ada" }), respondTurn({ name: "Ada", age: 36 })],
  });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  await h.agent.run("produce a person");

  const steered = userTexts(h.agent.messages).join("\n");
  assert.match(steered, /\$\.age: required property missing/);
  assert.deepEqual(h.agent.output, { value: { name: "Ada", age: 36 }, ok: true });
});

test("live (c): coercion parity (string age → number) in surfaced output", async () => {
  const h = makeHarness({ responder: [respondTurn({ name: "Ada", age: "36" })] });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  await h.agent.run("produce a person");

  assert.deepEqual(h.agent.output, { value: { name: "Ada", age: 36 }, ok: true });
});

test("live (d): never-valid → cap reached, flagged, exactly 3 attempts, no infinite loop", async () => {
  // Function responder so it never runs out of scripted turns.
  const h = makeHarness({ responder: () => respondTurn({ name: "Ada" }) });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  let respondAttempts = 0;
  h.agent.hooks.on("tool_start", ({ call }) => {
    if (call.name === "respond") respondAttempts++;
  });

  const result = await h.agent.run("produce a person");

  assert.equal(h.agent.output?.ok, false);
  assert.deepEqual(h.agent.output?.value, { name: "Ada" });
  assert.equal(respondAttempts, 3); // initial + 2 reasks
  assert.equal(result.reason, "stop");
  // One turn per respond attempt; well short of the maxTurns default (24).
  assert.ok(h.agent.messages.length <= 12, `transcript grew to ${h.agent.messages.length} messages`);
});

test("live (e): kill switch EAGENT_OUTPUT_CONTRACT=off makes the extension inert", async () => {
  const prev = process.env.EAGENT_OUTPUT_CONTRACT;
  process.env.EAGENT_OUTPUT_CONTRACT = "off";
  try {
    const h = makeHarness({ responder: [respondTurn({ name: "Ada", age: 36 })] });
    await h.host.use("core-tools", coreTools);
    await h.host.use("output-contract", outputContract);
    h.agent.outputSchema = SCHEMA;

    let sawRespond = false;
    h.agent.hooks.on("tool_start", ({ call }) => {
      if (call.name === "respond") sawRespond = true;
    });

    await h.agent.run("produce a person");

    // No respond tool registered; the scripted call hits an unknown tool.
    assert.equal(h.agent.tools.get("respond"), undefined);
    assert.equal(h.agent.output, undefined);
    // No reask was steered.
    const steered = userTexts(h.agent.messages).join("\n");
    assert.doesNotMatch(steered, /respond/i);
    // The respond tool call still dispatched (unknown tool) but no respond tool ran.
    assert.equal(sawRespond, true); // the model still emitted the call name
  } finally {
    if (prev === undefined) delete process.env.EAGENT_OUTPUT_CONTRACT;
    else process.env.EAGENT_OUTPUT_CONTRACT = prev;
  }
});

test("live (f): backward-compat — no schema set ⇒ byte-identical to today", async () => {
  const script: MockTurn[] = [{ text: "hello, here is my plain answer" }];

  // With the extension loaded but no outputSchema.
  const h1 = makeHarness({ responder: [...script] });
  await h1.host.use("core-tools", coreTools);
  await h1.host.use("output-contract", outputContract);
  const r1 = await h1.agent.run("say hi");

  // Bare harness with only core-tools, extension NOT loaded.
  const h2 = makeHarness({ responder: [...script] });
  await h2.host.use("core-tools", coreTools);
  const r2 = await h2.agent.run("say hi");

  assert.equal(r1.reason, r2.reason);
  assert.equal(lastText(h1.agent), lastText(h2.agent));
  assert.equal(h1.agent.tools.get("respond"), undefined);
  assert.equal(h1.agent.output, undefined);
});

test("live (g): clean teardown — unload removes every listener/registration, no leak", async () => {
  const h = makeHarness({ responder: [respondTurn({ name: "Ada", age: 36 })] });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  await h.host.unload("output-contract");

  h.agent.outputSchema = SCHEMA;

  let sawRespond = false;
  h.agent.hooks.on("tool_start", ({ call }) => {
    if (call.name === "respond") sawRespond = true;
  });

  await h.agent.run("produce a person");

  assert.equal(h.agent.tools.get("respond"), undefined);
  assert.equal(h.agent.output, undefined);
  // The model emitted a respond call name but no respond tool/registration existed.
  assert.equal(sawRespond, true);
});

// ---------------------------------------------------------------------------
// P2 — Decode-time forcing (the delivered follow-up). The model is COMPELLED to
// call `respond` on a corrective turn via CompletionRequest.toolChoice, never on
// its initial working turns. We assert the choice that reached the provider
// using MockProvider's `toolChoices` recording.
// ---------------------------------------------------------------------------

/** Script one turn that calls a non-respond tool (the model "working" first). */
function readTurn(path: string): MockTurn {
  return { toolCalls: [{ name: "read", arguments: { path } }] };
}

test("forcing (a): back-compat — no schema ⇒ every request omits toolChoice", async () => {
  const h = makeHarness({ responder: [readTurn("/nope"), { text: "done" }] });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  // No outputSchema set ⇒ the extension is inert and never writes forceTool.

  await h.agent.run("do a thing");

  // The agent-loop seam never set toolChoice on any turn: byte-identical request.
  assert.ok(h.provider.toolChoices.length >= 1);
  for (const tc of h.provider.toolChoices) assert.equal(tc, undefined);
  assert.equal(h.agent.forceTool, undefined);
});

test("forcing (b): multi-step preserved — the model's first (working) turn is NOT forced", async () => {
  // Turn 1: the model calls `read` (working). Turn 2: it finalizes with respond.
  const h = makeHarness({ responder: [readTurn("/nope"), respondTurn({ name: "Ada", age: 36 })] });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  await h.agent.run("research then answer");

  // Turn 1 — the working turn — carried NO forcing: the model was free to call read.
  assert.equal(h.provider.toolChoices[0], undefined);
  // The run still finalized correctly.
  assert.deepEqual(h.agent.output, { value: { name: "Ada", age: 36 }, ok: true });
  // And no force leaked past the run.
  assert.equal(h.agent.forceTool, undefined);
});

test("forcing (c): corrective turn forces respond; cleared once a valid respond is accepted", async () => {
  // Turn 1: invalid respond (missing age) ⇒ reask + force respond for turn 2.
  // Turn 2: valid respond ⇒ accepted, force cleared.
  const h = makeHarness({
    responder: [respondTurn({ name: "Ada" }), respondTurn({ name: "Ada", age: 36 })],
  });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  // Capture forceTool as seen at the top of each turn (before streamTurn reads it).
  const forcedAtTurn: (string | undefined)[] = [];
  h.agent.hooks.on("turn_start", () => {
    forcedAtTurn.push(h.agent.forceTool);
  });

  await h.agent.run("produce a person");

  // Turn 1 (the initial attempt) was NOT forced; turn 2 (the corrective turn) WAS.
  assert.equal(forcedAtTurn[0], undefined);
  assert.equal(forcedAtTurn[1], "respond");
  // The forcing reached the provider as a named tool_choice on the corrective turn.
  assert.equal(h.provider.toolChoices[0], undefined);
  assert.deepEqual(h.provider.toolChoices[1], { type: "tool", name: "respond" });
  // A valid respond was accepted and the force was cleared (not left dangling).
  assert.deepEqual(h.agent.output, { value: { name: "Ada", age: 36 }, ok: true });
  assert.equal(h.agent.forceTool, undefined);
});

test("forcing (d): never-valid — force is set on each corrective turn and cleared at the cap", async () => {
  const h = makeHarness({ responder: () => respondTurn({ name: "Ada" }) });
  await h.host.use("core-tools", coreTools);
  await h.host.use("output-contract", outputContract);
  h.agent.outputSchema = SCHEMA;

  await h.agent.run("produce a person");

  // 3 respond attempts ⇒ 3 requests. Turn 1 unforced; turns 2 and 3 forced (the
  // two reasks each set forceTool for the next turn).
  assert.equal(h.provider.toolChoices.length, 3);
  assert.equal(h.provider.toolChoices[0], undefined);
  assert.deepEqual(h.provider.toolChoices[1], { type: "tool", name: "respond" });
  assert.deepEqual(h.provider.toolChoices[2], { type: "tool", name: "respond" });
  // At the cap the run halts with a flagged value and the force is cleared.
  assert.equal(h.agent.output?.ok, false);
  assert.equal(h.agent.forceTool, undefined);
});

test("forcing (e): kill switch ⇒ forceTool never set, every request omits toolChoice", async () => {
  const prev = process.env.EAGENT_OUTPUT_CONTRACT;
  process.env.EAGENT_OUTPUT_CONTRACT = "off";
  try {
    const h = makeHarness({ responder: [respondTurn({ name: "Ada" }), { text: "done" }] });
    await h.host.use("core-tools", coreTools);
    await h.host.use("output-contract", outputContract);
    h.agent.outputSchema = SCHEMA;

    await h.agent.run("produce a person");

    assert.equal(h.agent.forceTool, undefined);
    for (const tc of h.provider.toolChoices) assert.equal(tc, undefined);
  } finally {
    if (prev === undefined) delete process.env.EAGENT_OUTPUT_CONTRACT;
    else process.env.EAGENT_OUTPUT_CONTRACT = prev;
  }
});
