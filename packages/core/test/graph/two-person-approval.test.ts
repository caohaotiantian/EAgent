/**
 * TWO OF THREE PEOPLE MUST APPROVE, and the graph language already said it — in TWO shipped files,
 * because there are two products and one file must not teach both (`DESIGN.md` D9).
 *
 * `ApprovalSpec.mode: "quorum"` and `.k` were declared in `graph/spec.ts` — a kernel file — in
 * order to be refused, on the reading that k-of-n approval was a roadmap item. It was not
 * missing. Three `human_gate` nodes joined by `join{branches:[…], mode:"quorum", k:2}` do it
 * today with no new vocabulary, so the fields were deleted rather than implemented, and this
 * test is why that is safe to say: it drives the SHIPPED artifacts, read from disk, rather than
 * fixtures written to make the claim true.
 *
 *     examples/graphs/two-person-approval.json   onBranchError "skip"   QUORUM — a lone dissenter is outvoted
 *     examples/graphs/two-person-veto.json       onBranchError "fail"   VETO   — the first reject decides
 *
 * The two files differ in `onBranchError` and `metadata` and in nothing else, which is asserted,
 * because each description tells a copier so.
 *
 * WHAT EACH ONE TEACHES, measured through the built binary (`loom run` + `loom approve`) and
 * again here through a real `Engine`:
 *
 *     votes                          two-person-approval (skip)            two-person-veto (fail)
 *     alice ✓  bob ✓                 awaiting_gate  written                awaiting_gate  written
 *     alice ✓  bob ✓  carol ✗        succeeded      written                failed E_HUMAN_APPROVAL_REQUIRED  WRITTEN
 *     alice ✗  bob ✓  carol ✓        succeeded      written                failed E_HUMAN_APPROVAL_REQUIRED  nothing
 *     alice ✓  bob ✗  carol ✗        failed E_QUORUM_UNREACHABLE  nothing  failed E_HUMAN_APPROVAL_REQUIRED  nothing
 *     alice ✗                        awaiting_gate  nothing                awaiting_gate  nothing
 *
 * The fourth VETO cell is the one a copier is likeliest to get wrong, and it is a PRODUCT LIMIT,
 * not a defect this file waits on: the barrier short-circuits on two approvals, `save` runs, and
 * the gate the short-circuit left open is still answerable — so a late reject marks the run
 * failed while the effect stays. Under quorum the same three votes succeed.
 *
 * THE RESIDUE IS REAL AND IS PINNED HERE. A short-circuiting quorum join leaves the unneeded
 * branch OPEN — `JoinNode`'s own documented `drain` gap — so the run is still `awaiting_gate`
 * after the write fired. Straggler cancellation is the fix and it belongs in the join, not in
 * the gate; D9 explicitly did not decide it. An assertion that let this quietly become "carol's
 * gate closes" would be hiding the one thing a reader needs to know before copying either file.
 *
 * History, so the ordering of these decisions is readable: `TODO.md` §A.68 made the description
 * of the `"fail"` file honest (it described quorum and behaved as veto); §A.75 made `k` a floor
 * the fold enforces, which is what made `"skip"` safe — before it, ONE approval of three landed
 * the write under `"skip"`; `DESIGN.md` D9 then split the two products into two files. The
 * engine-side matrix is `packages/core/test/run/join-quorum-k-is-a-floor.test.ts`; this file
 * owns what the EXAMPLES teach.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { InProcessEventBus } from "../../src/bus.ts";
import { CODES } from "../../src/errors.ts";
import { compile } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ResourceResolver, ToolManifestLite } from "../../src/graph/validate.ts";
import type { GateId, NodeId, RunId } from "../../src/ids.ts";
import type { HumanActor } from "../../src/journal/events.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";

/** THE SHIPPED FILES, read from disk. A copy here would let the examples rot while this stays green. */
const RAW = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/graphs/${name}.json`, import.meta.url)), "utf8");
const QUORUM = JSON.parse(RAW("two-person-approval")) as GraphSpec;
const VETO = JSON.parse(RAW("two-person-veto")) as GraphSpec;

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

const joinOf = (spec: GraphSpec) => spec.nodes.find((n) => n.id === ("quorum" as NodeId))?.join;
const describe = (spec: GraphSpec): string => String((spec.metadata as { description?: unknown }).description ?? "");
const labelsOf = (spec: GraphSpec): Record<string, string> => (spec.metadata as { labels?: Record<string, string> }).labels ?? {};

type Vote = readonly [string, "approve" | "reject"];

/**
 * Drive a spec through a real Engine, answering gates in the order given, and report what a
 * reader of the example would see: did the write land, and how did the run end.
 *
 * `break` on a gate that is not open is deliberate — once the run has failed there is nothing
 * left to answer, and a sequence that runs out is the honest shape of "the third person never
 * got to vote".
 */
async function drive(spec: GraphSpec, decisions: readonly Vote[]): Promise<{ status: string; wrote: readonly string[]; error: string | undefined }> {
  const h = harness();
  const r = compile({ spec, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
  assert.equal(r.ok, true, r.diagnostics.map((d) => `${d.severity}:${d.code} ${d.message}`).join(" | "));
  const runId: RunId = await h.engine.submit({ graph: r.graph, inputs: { request: "ship it" } });
  let p = await h.engine.advance(runId);
  let i = 0;
  for (const [who, how] of decisions) {
    const g = openGates(p).find((x) => x.nodeId === (who as NodeId));
    if (g === undefined) break;
    p = await h.engine.resolveGate(runId, {
      gateId: g.gateId,
      decision: how === "approve" ? { kind: "approve" } : { kind: "reject", reason: "no" },
      actor: human(`u:${who}`),
      idempotencyKey: `k${i++}`,
    });
  }
  return { status: p.status, wrote: h.wrote, error: (p as { error?: { code: string } }).error?.code };
}

const PEOPLE = ["alice", "bob", "carol"] as const;

/** Every ordering of the three people, so no outcome below depends on who votes when. */
const ORDERS: readonly (readonly string[])[] = [
  ["alice", "bob", "carol"], ["alice", "carol", "bob"], ["bob", "alice", "carol"],
  ["bob", "carol", "alice"], ["carol", "alice", "bob"], ["carol", "bob", "alice"],
];

// ── Both files: the composition ─────────────────────────────────────────────

test("BOTH SHIPPED EXAMPLES COMPILE, their join is the quorum, and they differ in `onBranchError` and metadata ALONE", () => {
  for (const [name, spec, onBranchError] of [
    ["two-person-approval", QUORUM, "skip"],
    ["two-person-veto", VETO, "fail"],
  ] as const) {
    const r = compile({ spec, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
    assert.equal(r.ok, true, `${name}: ${r.diagnostics.map((d) => `${d.severity}:${d.code} ${d.message}`).join(" | ")}`);
    const join = joinOf(spec);
    assert.equal(join?.mode, "quorum", `${name}: the composition IS the join's mode — if this moves, the example stops demonstrating it`);
    assert.equal(join?.k, 2, name);
    assert.equal(join?.branches.length, 3, name);
    assert.equal(join?.onBranchError, onBranchError, `${name}: this one word is the whole difference between the two products (DESIGN.md D9)`);
    assert.equal((spec.metadata as { name?: string }).name, name, "metadata.name matches the filename a copier sees");
  }
  // Each description tells a copier "differs from this file in `onBranchError` and its metadata
  // alone", so that is asserted rather than trusted: a drift in one file's nodes would make the
  // sentence false and the choice between them no longer one word.
  const strip = (spec: GraphSpec) => {
    const c = JSON.parse(JSON.stringify(spec)) as { metadata?: unknown; nodes: { id: string; join?: { onBranchError?: string } }[] };
    delete c.metadata;
    for (const n of c.nodes) if (n.join !== undefined) delete n.join.onBranchError;
    return c;
  };
  assert.deepEqual(strip(QUORUM), strip(VETO));
});

test("NO `approval.mode` ANYWHERE IN EITHER — the field they replace is not in the files", () => {
  // The examples exist to say "quorum lives in `join`, not in `approval`". A stray
  // `"mode": "single"` left in a gate block would now be a compile error, but a reader copying
  // the file is the audience, so the absence is asserted rather than left to the compiler.
  for (const [name, spec] of [["two-person-approval", QUORUM], ["two-person-veto", VETO]] as const) {
    const gateBlocks = spec.nodes.filter((n) => n.type === "human_gate").map((n) => n.humanGate);
    assert.equal(gateBlocks.length, 3, `${name}: three gates, one per person`);
    for (const g of gateBlocks) {
      assert.deepEqual(Object.keys(g ?? {}).sort(), ["approval", "ref"]);
      assert.deepEqual(Object.keys((g as { approval: object }).approval), ["approvers"]);
    }
    assert.doesNotMatch(RAW(name), /"mode"\s*:\s*"single"/);
  }
});

test("ONE APPROVAL IS NOT ENOUGH; THE SECOND FIRES THE GUARDED WRITE — and the third gate is left open", async () => {
  const h = harness();
  const r = compile({ spec: QUORUM, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
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

  // And the same two votes do the same on the veto file: the difference is ONLY in what a
  // rejection does, never in what two approvals do.
  const veto = await drive(VETO, [["alice", "approve"], ["bob", "approve"]]);
  assert.deepEqual(veto.wrote, ["ship it"]);
  assert.equal(veto.status, "awaiting_gate");
});

test("AND THE PERSON A GATE DOES NOT NAME CANNOT ANSWER IT", async () => {
  // The composition is only two-person approval if each gate is actually restricted. Without
  // this, three gates naming nobody would pass every assertion above and be one person clicking
  // twice.
  const h = harness();
  const r = compile({ spec: QUORUM, resolver: RESOLVER, tools: { "fs.write": WRITE }, tenantCapabilities: ["fs:write"] });
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

// ── two-person-approval.json: QUORUM ────────────────────────────────────────

test("QUORUM · a lone dissenter is OUTVOTED — two approvals and one rejection succeed, in every ordering, including the late reject", async () => {
  // THE DECISION D9 TOOK. Under the old `"fail"` this file vetoed on one rejection; the file's
  // name, its `k: 2` and its first sentence all said two-of-three, and now its behaviour does too.
  for (const dissenter of PEOPLE) {
    for (const order of ORDERS) {
      const votes = order.map((who): Vote => [who, who === dissenter ? "reject" : "approve"]);
      const r = await drive(QUORUM, votes);
      const where = votes.map(([w, h]) => `${w}:${h}`).join(" ");
      assert.equal(r.status, "succeeded", `${where}: two of three approved, so the run succeeds`);
      assert.deepEqual(r.wrote, ["ship it"], `${where}: and the write lands exactly once`);
      assert.equal(r.error, undefined, where);
    }
  }
  // Named separately because it is the case the VETO file cannot recover, and the contrast is
  // what a copier is choosing between: the same votes, the write already landed, and here the
  // run ends as the votes said it should.
  const late = await drive(QUORUM, [["alice", "approve"], ["bob", "approve"], ["carol", "reject"]]);
  assert.deepEqual(late, { status: "succeeded", wrote: ["ship it"], error: undefined });
});

test("QUORUM · below two approvals NOTHING is written — refused at the barrier with E_QUORUM_UNREACHABLE, and only once every gate is answered", async () => {
  // §A.75's floor is what makes this file safe to ship: before it, ONE approval of three landed
  // the write under `"skip"`. Swept over every ordering, because `k` is a floor and not a race.
  for (const approver of PEOPLE) {
    for (const order of ORDERS) {
      const votes = order.map((who): Vote => [who, who === approver ? "approve" : "reject"]);
      const r = await drive(QUORUM, votes);
      const where = votes.map(([w, h]) => `${w}:${h}`).join(" ");
      assert.deepEqual(r.wrote, [], `${where}: k: 2 is unmet, so nothing may be written`);
      assert.equal(r.status, "failed", `${where}: and the run does not report a success it did not earn`);
      assert.equal(r.error, CODES.E_QUORUM_UNREACHABLE, `${where}: named by the barrier, not by a gate`);
    }
  }
  const allReject = await drive(QUORUM, [["alice", "reject"], ["bob", "reject"], ["carol", "reject"]]);
  assert.deepEqual(allReject, { status: "failed", wrote: [], error: CODES.E_QUORUM_UNREACHABLE });

  // THE MOMENT: the barrier hears every gate before it refuses. A rejection and silence parks —
  // and so do TWO rejections and silence, although `k` is already out of reach, which the
  // description's "hears every gate before it refuses" is there to tell a copier.
  assert.deepEqual(await drive(QUORUM, [["alice", "reject"]]), { status: "awaiting_gate", wrote: [], error: undefined });
  assert.deepEqual(await drive(QUORUM, [["alice", "reject"], ["bob", "reject"]]), { status: "awaiting_gate", wrote: [], error: undefined });
});

test("QUORUM · THE FILE SAYS SO IN ITS OWN WORDS — quorum, outvoted, the floor, and where the veto went", () => {
  const d = describe(QUORUM);
  assert.match(d, /Two of three named people must approve/, d);
  assert.match(d, /QUORUM/, `the description must name the product it teaches: ${d}`);
  assert.match(d, /outvoted/i, `and what happens to a dissenter: ${d}`);
  assert.match(d, /onBranchError: \\?"skip\\?"/, `and name the field and value that do it: ${d}`);
  assert.match(d, /E_QUORUM_UNREACHABLE/, `and the refusal below k, by its code: ${d}`);
  assert.match(d, /awaiting_gate/, `and that the barrier waits for every gate before refusing: ${d}`);
  assert.match(d, /two-person-veto\.json/, `and where a copier who wants a veto should go instead: ${d}`);
  // The collision D9 removed was ONE file teaching two products. The veto file is named by its
  // filename above; the veto BEHAVIOUR must not be described as this file's.
  assert.doesNotMatch(d, /vetoes|one rejection fails|onBranchError: \\?"fail\\?"/i, `this file must no longer teach veto: ${d}`);
  for (const [k, v] of Object.entries(labelsOf(QUORUM))) {
    assert.doesNotMatch(v, /veto|"fail"|until a maintainer/i, `label ${k} still describes the old product: ${v}`);
  }
  assert.match(labelsOf(QUORUM)["residue"] ?? "", /OPEN/, "the straggler gap stays named");
});

// ── two-person-veto.json: VETO ──────────────────────────────────────────────

test("VETO · THE FIRST REJECT DECIDES — any rejection before the second approval fails the run with nothing written, in every ordering", async () => {
  // `onBranchError: "fail"` is read before `k` ever matters. Every position where the dissenter
  // votes before the second approval is here, by WHO dissents and by WHERE their vote falls — the
  // veto must not depend on which of the three it is.
  for (const dissenter of PEOPLE) {
    const others = PEOPLE.filter((w) => w !== dissenter);
    for (const votes of [
      [[dissenter, "reject"], [others[0]!, "approve"], [others[1]!, "approve"]],
      [[others[0]!, "approve"], [dissenter, "reject"], [others[1]!, "approve"]],
    ] as readonly (readonly Vote[])[]) {
      const r = await drive(VETO, votes);
      const where = votes.map(([w, h]) => `${w}:${h}`).join(" ");
      assert.deepEqual(r.wrote, [], `${where}: ${dissenter} rejecting before the quorum must stop the write, not be outvoted`);
      assert.equal(r.status, "failed", where);
      assert.equal(r.error, CODES.E_HUMAN_APPROVAL_REQUIRED, `${where}: named by the rejecting gate, not by the barrier`);
    }
  }
  assert.deepEqual(await drive(VETO, [["alice", "reject"], ["bob", "reject"], ["carol", "reject"]]), {
    status: "failed", wrote: [], error: CODES.E_HUMAN_APPROVAL_REQUIRED,
  });
  // Fails for the same reason and NOT because the quorum was short: the first rejection decided.
  assert.deepEqual(await drive(VETO, [["alice", "approve"], ["bob", "reject"], ["carol", "reject"]]), {
    status: "failed", wrote: [], error: CODES.E_HUMAN_APPROVAL_REQUIRED,
  });

  // THE VERDICT IS SETTLED, THE RUN IS NOT. One rejection with the other two silent parks
  // `awaiting_gate`: the barrier still has members to hear from. "The first reject decides" is
  // true of the outcome and not of the moment, which is why the description says so.
  assert.deepEqual(await drive(VETO, [["alice", "reject"]]), { status: "awaiting_gate", wrote: [], error: undefined });
});

test("VETO · PRODUCT LIMIT — a late reject, after the short-circuited write, fails the run and the write STAYS", async () => {
  // Measured through the binary (`TODO.md` §A.68): alice approve, bob approve, carol reject.
  // The barrier short-circuits on two approvals, `save` runs, and the gate the short-circuit left
  // open is still answerable — so the third vote fails a run whose effect already happened. Two
  // approvals are the point of no return. This is what the file SAYS, not a defect it waits on;
  // whether an irreversible effect may short-circuit is a separate question D9 did not decide.
  for (const late of PEOPLE) {
    const first = PEOPLE.filter((w) => w !== late);
    const votes: readonly Vote[] = [[first[0]!, "approve"], [first[1]!, "approve"], [late, "reject"]];
    const r = await drive(VETO, votes);
    const where = votes.map(([w, h]) => `${w}:${h}`).join(" ");
    assert.equal(r.status, "failed", `${where}: the run is marked failed`);
    assert.equal(r.error, CODES.E_HUMAN_APPROVAL_REQUIRED, where);
    assert.deepEqual(r.wrote, ["ship it"], `${where}: and the write has ALREADY LANDED — the veto arrived after the effect`);
  }
});

test("VETO · THE FILE SAYS SO IN ITS OWN WORDS — the first reject decides, and a late reject cannot recover the effect", () => {
  const d = describe(VETO);
  // The defect D9 closed was a description and a behaviour disagreeing, so the description is
  // what is asserted — not a comment in this file, which a reader copying the example never sees.
  assert.match(d, /Two of three named people must approve/, d);
  assert.match(d, /VETO/, `the description must name the product it teaches: ${d}`);
  assert.match(d, /onBranchError: \\?"fail\\?"/, `and name the field and value that do it: ${d}`);
  assert.match(d, /first reject decides/i, `D9's first required half: ${d}`);
  assert.match(d, /awaiting_gate/, `and the moment, not just the verdict — a lone reject parks: ${d}`);
  // D9's second required half, in the DESCRIPTION and not in a residue label: the late reject.
  assert.match(d, /late reject/i, d);
  assert.match(d, /already landed/i, `a late reject fails a run whose write has already happened: ${d}`);
  assert.match(d, /effect stays/i, `the effect is not recovered: ${d}`);
  assert.match(d, /only marked failed/i, `the run is only marked failed: ${d}`);
  assert.match(d, /before the second approval/i, `and the boundary a vetoing person must beat: ${d}`);
  assert.match(d, /two-person-approval\.json/, `and where a copier who wants quorum should go instead: ${d}`);
  assert.doesNotMatch(d, /onBranchError: \\?"skip\\?"/, `this file must not declare quorum's value as its own: ${d}`);
});
