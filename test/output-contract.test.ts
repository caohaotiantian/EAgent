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
