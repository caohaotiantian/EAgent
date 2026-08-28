/**
 * TWO OF THREE PEOPLE MUST APPROVE, and the graph language already said it.
 *
 * `ApprovalSpec.mode: "quorum"` and `.k` were declared in `graph/spec.ts` — a kernel file — in
 * order to be refused, on the reading that k-of-n approval was a roadmap item. It was not
 * missing. Three `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k:2}` do it
 * today with no new vocabulary, so the fields were deleted rather than implemented, and this
 * test is why that is safe to say: it drives `examples/graphs/two-person-approval.json`, the
 * shipped artifact, rather than a fixture written to make the claim true.
 *
 * The measurement the deletion rests on, and the assertions below are it verbatim:
 *
 *     all three gates open       writes = 0
 *     alice approves             writes = 0   ← ONE is not enough, which is the whole point
 *     bob approves               writes = 1   ← the barrier fires and the guarded write lands
 *     carol's gate               still open   ← the residue, named rather than hidden
 *
 * Two-of-two is two gates in series. N-of-N is `mode: "all"`.
 *
 * THE RESIDUE IS REAL AND IS PINNED HERE. A short-circuiting quorum join leaves the unneeded
 * branch OPEN — `JoinNode`'s own documented `drain` gap — so the run is still `awaiting_gate`
 * after the write fired. If two-person approval becomes routine, straggler cancellation is the
 * fix and it belongs in the join, not in the gate. An assertion that let this quietly become
 * "carol's gate closes" would be hiding the one thing a reader needs to know before copying the
 * file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InProcessEventBus } from "../../src/bus.ts";
import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { GateId, NodeId, RunId } from "../../src/ids.ts";
import type { HumanActor } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

/** THE SHIPPED FILE, read from disk. A copy here would let the example rot while this stays green. */
const SPEC = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../examples/graphs/two-person-approval.json", import.meta.url)), "utf8"),
) as GraphSpec;

const WRITE: ToolManifestLite = {
  name: "fs.write",
  version: "1.0",
  capabilities: ["fs:write"],
  irreversibility: "reversible_write",
  idempotent: false,
};
const RESOLVER: ResourceResolver = { resolve: (ref) => ({ ref, digest: `sha256:${"0".repeat(64)}`, channel: "stable" }) };
const human = (subject: string): HumanActor => ({ kind: "human", subject, via: "api" });

function harness() {
  const wrote: string[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  tools.register({
    ...WRITE,
    description: "write",
    parameters: { type: "object", properties: { path: { type: "string" }, body: { type: "string" } } },
    execute: (args: Readonly<Record<string, unknown>>) => {
      wrote.push(String(args["body"] ?? ""));
      return { content: "written", writes: { written: { ok: true } } };
    },
  } as never);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    sleep: async () => {},
    policy: { granted: ["fs:write"], systemFloor: "out" },
  });
  return { engine, wrote, store };
}

const openGates = (p: { readonly gates: Record<string, { readonly gateId: GateId; readonly nodeId: NodeId; readonly state: string }> }) =>
  Object.values(p.gates).filter((g) => g.state === "open");

test("THE SHIPPED EXAMPLE COMPILES, and its join is the quorum", () => {
  const r = compile({ spec: SPEC, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, true, r.diagnostics.map((d) => `${d.severity}:${d.code} ${d.message}`).join(" | "));
  const join = SPEC.nodes.find((n) => n.id === ("quorum" as NodeId))?.join;
  assert.equal(join?.mode, "quorum", "the composition IS the join's mode — if this moves, the example stops demonstrating it");
  assert.equal(join?.k, 2);
  assert.equal(join?.branches.length, 3);
});

test("NO `approval.mode` ANYWHERE IN IT — the field it replaces is not in the file", () => {
  // The example exists to say "quorum lives in `join`, not in `approval`". A stray
  // `"mode": "single"` left in a gate block would now be a compile error, but a reader copying
  // the file is the audience, so the absence is asserted rather than left to the compiler.
  const raw = readFileSync(fileURLToPath(new URL("../../../../examples/graphs/two-person-approval.json", import.meta.url)), "utf8");
  const gateBlocks = SPEC.nodes.filter((n) => n.type === "human_gate").map((n) => n.humanGate);
  assert.equal(gateBlocks.length, 3, "three gates, one per person");
  for (const g of gateBlocks) {
    assert.deepEqual(Object.keys(g ?? {}).sort(), ["approval", "ref"]);
    assert.deepEqual(Object.keys((g as { approval: object }).approval), ["approvers"]);
  }
  assert.doesNotMatch(raw, /"mode"\s*:\s*"single"/);
});

test("ONE APPROVAL IS NOT ENOUGH; THE SECOND FIRES THE GUARDED WRITE", async () => {
  const h = harness();
  const r = compile({ spec: SPEC, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
  assert.ok(r.ok);
  const runId: RunId = await h.engine.submit({ graph: r.graph, inputs: { request: "ship it" } });

  let p = await h.engine.advance(runId);
  assert.equal(p.status, "awaiting_gate");
  assert.equal(openGates(p).length, 3, "all three people are asked at once, not in sequence");
  assert.equal(h.wrote.length, 0);

  const gateFor = (node: string): GateId => {
    const g = openGates(p).find((x) => x.nodeId === (node as NodeId));
    assert.ok(g !== undefined, `no open gate on "${node}"`);
    return g.gateId;
  };

  p = await h.engine.resolveGate(runId, {
    gateId: gateFor("alice"),
    decision: { kind: "approve" },
    actor: human("u:alice"),
    idempotencyKey: "a1",
  });
  assert.equal(h.wrote.length, 0, "ONE of three must not be enough — this is the assertion the deleted `mode: quorum` claimed to make");

  p = await h.engine.resolveGate(runId, {
    gateId: gateFor("bob"),
    decision: { kind: "approve" },
    actor: human("u:bob"),
    idempotencyKey: "b1",
  });
  assert.deepEqual(h.wrote, ["ship it"], "two of three fires the barrier and the guarded write lands");

  // THE RESIDUE, asserted rather than glossed: the third gate is still open and the run is still
  // waiting on it. `JoinNode`'s docstring names this — a short-circuiting join keeps the
  // remaining branches running, with no `task.cancelled` anywhere.
  assert.deepEqual(openGates(p).map((g) => String(g.nodeId)), ["carol"], "the unneeded gate is left open");
  assert.equal(p.status, "awaiting_gate");
});

test("AND THE PERSON A GATE DOES NOT NAME CANNOT ANSWER IT", async () => {
  // The composition is only two-person approval if each gate is actually restricted. Without
  // this, three gates naming nobody would pass every assertion above and be one person clicking
  // twice.
  const h = harness();
  const r = compile({ spec: SPEC, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
  assert.ok(r.ok);
  const runId: RunId = await h.engine.submit({ graph: r.graph, inputs: { request: "ship it" } });
  const p = await h.engine.advance(runId);
  const aliceGate = openGates(p).find((g) => g.nodeId === ("alice" as NodeId))!.gateId;

  await assert.rejects(
    () =>
      h.engine.resolveGate(runId, {
        gateId: aliceGate,
        decision: { kind: "approve" },
        actor: human("u:bob"),
        idempotencyKey: "x1",
      }),
    /NOT_AUTHORIZED|not authorized|does not name/i,
  );
  assert.equal(h.wrote.length, 0);
});
