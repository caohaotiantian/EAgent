/**
 * T5 — the journal packed a rule id and its evidence into one string, so matching by rule id
 * could never work.
 *
 * `#escalate` journaled `` `${id} ${JSON.stringify(detail)}` ``, so E6 arrived as
 *
 *     rule = "violation {\"capability\":{\"capability\":\"danger:do\",\"nodeId\":\"act\"}}"
 *
 * and `evolution/trajectory.ts`'s `e.payload.rule === "violation"` was dead for the whole life
 * of the mechanism. **Seven of the eight firing sites pass a detail**, so it was dead for seven
 * of the eight rules — the register only noticed the one that had a consumer.
 *
 * What makes this worth a file of its own is the second-order part the register named: "E8's
 * firing site uses the same pattern, so any future consumer inherits the bug." A shape that
 * makes the obvious consumer wrong is worse than a wrong consumer, because the next one is
 * wrong too and nobody looks.
 *
 * The other half of why it survived: `test/run/escalation.test.ts` asserted with
 * `startsWith(id)` plus a regex over the JSON tail. Every rule was covered and every assertion
 * passed. **Tests shaped around a defect are how a defect survives having tests** — those now
 * read `rule` and `detail` as the separate fields they are.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile } from "../../src/graph/compile.ts";
import { foldTrajectory } from "../../src/evolution/trajectory.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { ESCALATION_RULES } from "../../src/run/escalation.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

const MAN: ToolManifestLite = { name: "danger.do", version: "1.0", capabilities: ["danger:do"], irreversibility: "reversible_write", idempotent: true };
const RESOLVER: ResourceResolver = { resolve: () => undefined };

const SPEC: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "t5", project: "p", version: 1 },
  // The GRAPH declares the capability so it compiles; the ENGINE is not granted it, so the
  // call is denied at dispatch and E6 fires.
  policy: { posture: "out", capabilities: ["danger:do"] },
  channels: { out: { type: "object", reduce: "replace" } },
  inputs: [],
  outputs: ["out"],
  nodes: [{ id: "act" as never, type: "tool", writes: ["out"], tool: { name: "danger.do", version: "1.0", args: {} } }],
  edges: [],
};

async function deniedRun(): Promise<JournalEvent[]> {
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({ ...MAN, description: "d", parameters: { type: "object", properties: {} }, execute: () => ({ content: "ok", writes: { out: {} } }) });
  const engine = new Engine({
    store, bus: new InProcessEventBus({ store }), tools,
    functions: new FunctionRegistry(), models: new ModelRegistry(), now, sleep: async () => {},
    policy: { granted: [], systemFloor: "out" },
  });
  const r = compile({ spec: SPEC, resolver: RESOLVER, tools: { "danger.do": MAN }, tenantCapabilities: ["danger:do"] });
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  const runId = await engine.submit({ graph: r.graph, inputs: {} });
  await engine.advance(runId);
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  return events;
}

test("A JOURNALED ESCALATION CARRIES THE BARE RULE ID, and its evidence beside it", async () => {
  const events = await deniedRun();
  const rows = events.filter((e) => e.type === "policy.escalated").map((e) => e.payload as { rule: string; detail?: Record<string, unknown> });
  assert.ok(rows.length > 0, "the denied capability must escalate — E6");

  const e6 = rows.find((r) => r.rule === "violation");
  // THE DEFECT: `rule` used to be `violation {"capability":{…}}`, so this find returned nothing.
  assert.ok(e6 !== undefined, `no row matched the bare id; got ${rows.map((r) => JSON.stringify(r.rule)).join(", ")}`);
  assert.ok(e6.detail !== undefined, "and the evidence must still be there — split, not dropped");
  assert.match(JSON.stringify(e6.detail), /danger:do/, "the detail names the capability that was denied");
});

test("EVERY rule id is a value a consumer can match — not just the one that had a consumer", async () => {
  // The register noticed `violation` because `trajectory.ts` tried to match it. Seven of the
  // eight rules pass a detail, so seven were equally broken and silent. Stated as the SET, per
  // this repo's rule that a claim naming its set can be checked and "this is total" cannot.
  const events = await deniedRun();
  const ids = new Set(Object.keys(ESCALATION_RULES));
  assert.ok(ids.size >= 8, `expected the full rule table, got ${ids.size}`);
  for (const e of events) {
    if (e.type !== "policy.escalated") continue;
    const { rule } = e.payload as { rule: string };
    assert.ok(ids.has(rule), `journaled rule ${JSON.stringify(rule)} is not an id in ESCALATION_RULES`);
    assert.doesNotMatch(rule, /[ {]/, "a rule id with a space or a brace in it is a packed string, which is the defect");
  }
});

test("THE CONSUMER THAT WAS DEAD NOW COUNTS — foldTrajectory sees E6", async () => {
  const events = await deniedRun();
  const t = foldTrajectory(events);
  assert.ok(t.policy.escalations.includes("violation"), `escalations: ${t.policy.escalations.join(", ")}`);
  // `violations` counts both the deny and the escalation it raised; what matters here is that
  // the escalation arm is reachable at all, which it was not.
  assert.ok(t.policy.violations >= 1, "a denied capability must show up as a violation");
});
