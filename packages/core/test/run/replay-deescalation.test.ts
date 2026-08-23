/**
 * T4 — a replay could not reproduce a run whose posture a human lowered.
 *
 * `CLAUDE.md` named this as the ONE caveat on the project's bar: "replay does not reproduce a
 * run whose posture a human lowered, because `replayRun` never re-applies `policy.deescalated`."
 * Reproduced end to end on a one-node graph with no taint in it:
 *
 *     recorded:  deescalate `run:<id>` → on, the irreversible action runs, no gate, succeeded
 *     replayed:  no ceiling → posture `in` → a gate → E_REPLAY_DIVERGENCE, "replay raised a
 *                gate on node "act" that the recorded run never decided"
 *
 * So an audit could not re-derive exactly the runs where a human used the one lever invariant 5
 * allows to lower oversight — the runs an auditor most wants re-derived.
 *
 * ## Why "restore the ceilings" would not have been the fix
 *
 * `PolicyEngine.decide` looks ceilings up under `node:<runId>/<nodeId>` and `run:<runId>`. The
 * shadow run has a different id, so handing the original's `ceilings` map to
 * `PolicyEngine.restore` writes entries no lookup ever reaches: it type-checks, it runs, and it
 * changes nothing. The scope has to be REKEYED, and the test below fails without that.
 *
 * ## And the thing that made all of this hard to see
 *
 * `compare` weighed task states, channels and status — never gates. A replay that raised a
 * DIFFERENT NUMBER OF HUMAN GATES than the recording scored `match: true`, and so did one that
 * asked nobody at all. Two of the mutations here were silently green before that was fixed,
 * which is the "looks supervised, is not" shape at the level of the audit tool itself.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { RunId } from "../../src/ids.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";

const CAP = "danger:launch";

function manifest(name: string): ToolManifestLite {
  return { name, version: "1.0", capabilities: [CAP], irreversibility: "irreversible", idempotent: false };
}

/** One irreversible tool per channel. Irreversible, so `CLASS_DEFAULT_POSTURE` puts it at `in`. */
function tool(name: string, channel: string, fired: string[]): ToolDefinition {
  return {
    ...manifest(name),
    description: "An irreversible action.",
    parameters: { type: "object", properties: {} },
    execute: () => {
      fired.push(name);
      return { content: name, writes: { [channel]: { ok: name } } };
    },
  };
}

/**
 * N irreversible tool nodes in a `seq` chain, and DELIBERATELY NO DATA FLOW between them.
 *
 * Wiring node 2 to read node 1's output makes node 2 tainted (E8: tool output is untrusted),
 * which raises the hard floor under the ceiling to `in` and gates it whatever the human said —
 * correct behaviour, and it silently turns a test about de-escalation into a test about taint.
 * Cost an hour of a wrong reproduction before the reason was found.
 */
function chainSpec(n: number): GraphSpec {
  const names = ["one", "two", "three"].slice(0, n);
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "deesc", project: "t", version: 1 },
    policy: { posture: "out", capabilities: [CAP] },
    channels: Object.fromEntries(names.map((c) => [c, { type: "object" as const, reduce: "replace" as const }])),
    inputs: [],
    outputs: [names[n - 1]!],
    nodes: names.map((id) => ({
      id: id as never,
      type: "tool" as const,
      writes: [id],
      tool: { name: `danger.${id}`, version: "1.0", args: {} },
    })),
    edges: names.slice(1).map((to, i) => ({
      id: `e${i}` as never,
      from: names[i] as never,
      to: to as never,
      kind: "seq" as const,
    })),
  };
}

function harness(n: number) {
  const names = ["one", "two", "three"].slice(0, n);
  const fired: string[] = [];
  const now = (): number => 1_700_000_000_000;
  const store = new MemoryStateStore({ now });
  const tools = new ToolRegistry();
  for (const id of names) tools.register(tool(`danger.${id}`, id, fired));
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now,
    // THE INTERVENTION WINDOW IS REAL TIME, and lowering an irreversible action to `on` is
    // exactly what turns it on: at `in` a gate is stronger and there is no hold, at `out`
    // nobody is watching. So the tests that prove de-escalation WORKS are precisely the ones
    // that then sat in `#sleep` for ten seconds each — four of them, 35s of a 9s suite.
    // Injected, per this repo's rule that a test taking seconds is a test that forgot this.
    sleep: async () => {},
    policy: { granted: [CAP], systemFloor: "out" },
  });
  const graph = compileOrThrow({
    spec: chainSpec(n),
    resolver: { resolve: () => undefined },
    tools: Object.fromEntries(names.map((id) => [`danger.${id}`, manifest(`danger.${id}`)])),
    tenantCapabilities: [CAP],
  });
  const replayOpts = () => ({
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    // The replay re-derives the SAME postures, so it takes the same holds — and a replay that
    // waited for them would make every audit of a de-escalated run take real minutes.
    sleep: async (): Promise<void> => {},
    policy: { granted: [CAP], systemFloor: "out" as const },
  });
  return { store, engine, graph, fired, replayOpts };
}

const HUMAN = { kind: "human", id: "u:alice" } as const;
const APPROVER = { kind: "human", subject: "u:alice", via: "console" } as const;

test("T4 — A RUN WHOSE POSTURE A HUMAN LOWERED REPLAYS, and reproduces the work", async () => {
  const h = harness(1);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  // Before the run reaches the action, so no gate is ever raised.
  await h.engine.deescalate(runId, `run:${runId}`, "on", "drill: pre-authorised by the board", HUMAN);
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded");
  assert.deepEqual(h.fired, ["danger.one"], "the irreversible action ran, ungated");
  assert.equal(Object.keys(recorded.gates).length, 0, "and nobody was asked");

  h.fired.length = 0;
  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts() });

  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(report.replayed.status, "succeeded");
  assert.deepEqual(report.replayed.channels, recorded.channels);
  assert.equal(Object.keys(report.replayed.gates).length, 0, "the replay must not ask a question the recording never asked");
  assert.deepEqual(h.fired, [], "and it serves the recorded effect rather than re-running the action");
});

test("the ceiling is REKEYED onto the replay's runId — the same map would reach no lookup", async () => {
  const h = harness(1);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  await h.engine.deescalate(runId, `run:${runId}`, "on", "drill", HUMAN);
  await h.engine.advance(runId);

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts() });
  const scopes = Object.keys(report.replayed.ceilings);
  assert.deepEqual(scopes, [`run:${report.replayRunId}`], "the shadow's ceiling must be keyed by the SHADOW's runId");
  assert.notEqual(report.replayRunId, runId, "the two runs have different ids — which is the whole difficulty");
  // Journaled, not carried in memory: invariant 2 applies to the replay's own journal too.
  assert.equal(report.replayed.ceilings[`run:${report.replayRunId}`], "on");
});

test("A CEILING LOWERED WHILE A GATE IS OPEN lands after that gate was RAISED, not after it was decided", async () => {
  // `resolveGate` advances the run as part of answering, so a human who lowers a ceiling while
  // gate 2 is open does it AFTER gate 2 was raised and BEFORE it was decided. Keyed on
  // decisions, the replay applies it straight after serving gate 1 — before gate 2 exists — and
  // suppresses the very gate the recording raised.
  const h = harness(3);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  let p = await h.engine.advance(runId);

  const answer = async (key: string): Promise<void> => {
    const open = Object.values(p.gates).find((g) => g.state === "open")!;
    p = await h.engine.resolveGate(runId, {
      gateId: open.gateId,
      decision: { kind: "approve" },
      actor: APPROVER,
      idempotencyKey: key,
    });
  };

  await answer("k1"); // answering gate 1 advances the run and raises gate 2
  assert.equal(Object.keys(p.gates).length, 2, "two gates raised, one decided");
  await h.engine.deescalate(runId, `run:${runId}`, "on", "board pre-authorised the remaining stages", HUMAN);
  await answer("k2");
  p = await h.engine.advance(runId);

  assert.equal(p.status, "succeeded");
  assert.equal(Object.keys(p.gates).length, 2, "the third node ran ungated");
  assert.deepEqual(h.fired, ["danger.one", "danger.two", "danger.three"]);

  h.fired.length = 0;
  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts() });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  assert.equal(Object.keys(report.replayed.gates).length, 2, "the replay asked the same two questions");
  assert.deepEqual(h.fired, []);
});

test("THE VERDICT WEIGHS WHO WAS ASKED — a replay that gates differently is not a match", async () => {
  // `compare` read task states, channels and status and nothing else, so a replay that asked a
  // human a different number of times scored green. This asserts the frame exists and that it
  // carries what an operator needs: which task, and what each side did.
  const h = harness(3);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  let p = await h.engine.advance(runId);
  for (const key of ["k1", "k2", "k3"]) {
    const open = Object.values(p.gates).find((g) => g.state === "open");
    if (open === undefined) break;
    p = await h.engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: APPROVER, idempotencyKey: key });
  }
  assert.equal(p.status, "succeeded");
  assert.equal(Object.keys(p.gates).length, 3, "three humans-in-the-loop decisions on record");

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts() });
  assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match)));
  const gateFrames = report.frames.filter((f) => f.kind === "gate.decided");
  assert.equal(gateFrames.length, 3, "one frame per gated task — the verdict must SEE the oversight");
  for (const f of gateFrames) {
    assert.equal(f.expected, "decided:approve");
    assert.equal(f.actual, "decided:approve");
    assert.ok(f.taskId !== undefined, "a frame an operator cannot locate is not a diagnosis");
  }
});

test("A DE-ESCALATION NO ENGINE COULD HAVE WRITTEN IS NOT APPLIED", async () => {
  // `PolicyEngine.deescalate` refuses any non-human actor, so a `policy.deescalated` carrying a
  // system actor cannot have come from the engine — the journal was edited. Applying it would
  // launder that edit into a real ceiling and let the replay bless an ungated irreversible
  // action. It is skipped, so the replay raises the gate the recording lacks and SAYS SO.
  const h = harness(1);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  await h.engine.deescalate(runId, `run:${runId}`, "on", "drill", HUMAN);
  const recorded = await h.engine.advance(runId);
  assert.equal(recorded.status, "succeeded");

  // Forge the actor on the recorded de-escalation, leaving everything else identical. Copied
  // event by event so the forgery is the ONLY difference — a hand-built journal would drift
  // from what the engine writes, which this repo has been bitten by four times.
  const forged = new MemoryStateStore({ now: () => 1_700_000_000_000 });
  let seq = 0;
  for await (const e of h.store.read(runId, 1)) {
    const actor = e.type === "policy.deescalated" ? { kind: "system" as const, component: "evolution-engine" } : e.actor;
    await forged.append({
      runId,
      expectedSeq: seq as never,
      events: [{ type: e.type, payload: e.payload, actor, ...(e.taskId === undefined ? {} : { taskId: e.taskId }) } as never],
    });
    seq++;
  }

  await assert.rejects(
    () => replayRun({ store: forged, runId: runId as RunId, graph: h.graph, engine: h.replayOpts() }),
    /never decided/,
    "a forged de-escalation must not be replayed into a real ceiling",
  );
});

test("...and a gate the replay left UNANSWERED is reported as the divergence it is", async () => {
  // The test above proves the frames exist; this proves they can FAIL. Written after a mutation
  // showed the first one could not: forcing every gate frame to `match: true` left it green,
  // because asserting a frame's contents is not the same as asserting the verdict moves.
  //
  // `replayGates: false` is the public way to make the two runs disagree about oversight — the
  // recording answered its gates, the replay does not — so this asserts on the mechanism a
  // caller can actually reach rather than on a mutated build.
  const h = harness(1);
  const runId = await h.engine.submit({ graph: h.graph, inputs: {} });
  let p = await h.engine.advance(runId);
  const open = Object.values(p.gates).find((g) => g.state === "open")!;
  p = await h.engine.resolveGate(runId, { gateId: open.gateId, decision: { kind: "approve" }, actor: APPROVER, idempotencyKey: "k1" });
  assert.equal(p.status, "succeeded");

  const report = await replayRun({ store: h.store, runId, graph: h.graph, engine: h.replayOpts(), replayGates: false });
  const gateFrames = report.frames.filter((f) => f.kind === "gate.decided");
  assert.equal(gateFrames.length, 1);
  assert.equal(gateFrames[0]!.match, false, "an unanswered gate is a divergence in the oversight, and the verdict must say so");
  assert.equal(gateFrames[0]!.expected, "decided:approve");
  assert.equal(gateFrames[0]!.actual, "open");
  assert.equal(report.match, false);
});
