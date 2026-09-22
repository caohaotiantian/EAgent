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
 *
 * ## §A.68 — AND A REJECTION ARRIVING BEFORE THE SECOND APPROVAL VETOES IT
 *
 * The measurement above says what two approvals do. It said nothing about a REJECTION, and the
 * file's description said "two of three must approve" while `onBranchError: "fail"` made one
 * rejection fail the run whatever the other two said. Driven on the shipped file:
 *
 *     alice approve, bob approve                 awaiting_gate  wrote ["ship it"]
 *     alice REJECT,  bob approve, carol approve  failed         wrote []  E_HUMAN_APPROVAL_REQUIRED
 *     alice approve, bob REJECT,  carol approve  failed         wrote []  E_HUMAN_APPROVAL_REQUIRED
 *     alice REJECT,  bob REJECT,  carol REJECT   failed         wrote []  E_HUMAN_APPROVAL_REQUIRED
 *
 * AND THE ONE THE ROW DID NOT CARRY, which decides what the veto is worth:
 *
 *     alice approve, bob approve, carol REJECT   failed         wrote ["ship it"]
 *
 * The barrier short-circuits on two approvals, `save` runs, and the gate the short-circuit left
 * open — the residue named above — is STILL ANSWERABLE. So the third vote fails a run whose
 * effect already happened. Two approvals are the point of no return; "any one of them can veto
 * it" would have been the second false description in this file, and so — more quietly — would
 * "a rejection that arrives FIRST", since a rejection arriving SECOND also vetoes with nothing
 * written (asserted below, over all six orderings). The shipped `description` gives the boundary.
 *
 * §A.68 offered two closures and said the decision is which behaviour the example is FOR. The
 * measurement took it, and then §A.75 MOVED WHAT IT MEASURED — this paragraph is the second
 * version and the first one is why it is dated. When §A.68 ran, `onBranchError: "skip"` on the
 * same graph with only that field changed read:
 *
 *     alice REJECT,  bob approve, carol approve  succeeded  wrote ["ship it"]   ← wanted
 *     alice REJECT,  bob REJECT,  carol REJECT   failed     E_QUORUM_UNREACHABLE ← wanted
 *     alice REJECT,  bob REJECT,  carol approve  succeeded  wrote ["ship it"]   ← NOT WANTED
 *
 * — in all three orderings of one approval and two rejections, because `#maybeFireJoin` fired
 * `quorum` on `succeeded >= need || noMoreArrivals` and `#foldJoin` held only the
 * `onBranchError === "fail" && skipped > 0` arm and §D.9's, never re-checking `k`. That was an
 * ENGINE defect, it is fixed (§A.75), and the third line now reads
 * `failed E_QUORUM_UNREACHABLE wrote []` in all three orderings. The last test in this file drives
 * it; `packages/core/test/run/join-quorum-k-is-a-floor.test.ts` owns the engine-side matrix.
 *
 * §D.9'S ARM IS `succeededMembers === 0` FOR THIS GRAPH, not `succeededWork === 0`. The predicate
 * is `workMembers > 0 ? succeededWork === 0 && terminalWork === workMembers : succeededMembers === 0`
 * (`run/engine.ts`), and all three members here are `human_gate` nodes, so `workMembers` is 0 and
 * the fallback is what fires. `engine.ts` names THIS FILE at that branch — "the EVIDENCE-ONLY
 * BARRIER, which is `examples/graphs/two-person-approval.json`" — so quoting the work term here
 * would have pointed a reader at the one arm this graph can never reach.
 *
 * So AT THE TIME `"skip"` would have replaced a fail-CLOSED mismatch with a fail-OPEN one: an
 * example saying "two of three" that lets one person land the write. *Refusing is always allowed;
 * loosening never is.* The description was made honest instead — and that decision still stands on
 * its own, because a description that lies is a defect whatever the engine does.
 *
 * WHAT §A.75 CHANGED, AND WHAT IT DID NOT. The fold now enforces `k` as a floor whatever
 * `onBranchError` says, so the fail-OPEN objection is GONE: under `"skip"` one approval of three is
 * refused at the barrier. The two values now differ only in WHEN a run that will not reach `k` is
 * refused — `"fail"` at the first rejection, with `E_HUMAN_APPROVAL_REQUIRED` carrying the human's
 * own reason; `"skip"` at the barrier, once every gate has been answered, with
 * `E_QUORUM_UNREACHABLE`. Both refuse; neither writes.
 *
 * THIS EXAMPLE STILL SHIPS `"fail"`, AND THAT IS A MAINTAINER'S DECISION RATHER THAN A CONSEQUENCE.
 * Nothing in the fix makes `"skip"` the better default: `"fail"` tells a rejecting approver
 * immediately and names them in the error, `"skip"` collects every vote before answering. The file
 * stays as it is until someone picks; what this test owns is that the choice is now a FREE one, and
 * the last test in this file is the half of that claim the shipped `"fail"` cases cannot make.
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

// ── §A.68 · the veto, and why `onBranchError: "skip"` was refused ────────────

/**
 * Drive a spec through a real Engine, answering gates in the order given, and report what a
 * reader of the example would see: did the write land, and how did the run end.
 *
 * `break` on a gate that is not open is deliberate — once the run has failed there is nothing
 * left to answer, and a sequence that runs out is the honest shape of "the third person never
 * got to vote".
 */
async function drive(
  spec: GraphSpec,
  decisions: readonly (readonly [string, "approve" | "reject"])[],
): Promise<{ status: string; wrote: readonly string[]; error: string | undefined }> {
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

test("§A.68 · ONE REJECTION FAILS THE RUN — the four cases on the shipped file, and the late one where the write already landed", async () => {
  // Case 1 — two approvals: the barrier short-circuits and the write lands. The existing test
  // above pins this step by step; it is repeated here so the four cases read as one table.
  const twoApprovals = await drive(SPEC, [["alice", "approve"], ["bob", "approve"]]);
  assert.deepEqual(twoApprovals.wrote, ["ship it"]);
  assert.equal(twoApprovals.status, "awaiting_gate", "carol's gate is the residue above, still open");

  // Case 2 — ONE rejection, arriving BEFORE the second approval. `k: 2` would be met on the two
  // approvals and the write still does not land: `onBranchError: "fail"` is read before `k` ever
  // matters to a losing arm. This is the case the old description promised and did not deliver.
  // Every ordering in which the dissenter votes first or second is here, by WHO dissents and by
  // WHERE their vote falls — the veto must not depend on which of the three it is.
  for (const dissenter of ["alice", "bob", "carol"] as const) {
    const others = (["alice", "bob", "carol"] as const).filter((w) => w !== dissenter);
    for (const order of [
      [[dissenter, "reject"], [others[0]!, "approve"], [others[1]!, "approve"]],
      [[others[0]!, "approve"], [dissenter, "reject"], [others[1]!, "approve"]],
    ] as readonly (readonly (readonly [string, "approve" | "reject"])[])[]) {
      const r = await drive(SPEC, order);
      assert.deepEqual(r.wrote, [], `${dissenter} rejecting before the quorum must stop the write, not be outvoted`);
      assert.equal(r.status, "failed");
      assert.equal(r.error, CODES.E_HUMAN_APPROVAL_REQUIRED);
    }
  }

  // Case 2b — THE SAME REJECTION, ARRIVING THIRD, AND THE WRITE HAS ALREADY HAPPENED. §A.68 asked
  // whether one rejection fails the run; it does, but the residue at the top of this file decides
  // WHAT THAT IS WORTH. The barrier short-circuits on two approvals, `save` runs, and the third
  // gate is left open and still answerable — so the last vote fails a run whose effect already
  // landed. Two approvals are the point of no return, and an example that read "any one of them
  // can veto it" would have been the second false description in the same file.
  const lateVeto = await drive(SPEC, [["alice", "approve"], ["bob", "approve"], ["carol", "reject"]]);
  assert.equal(lateVeto.status, "failed");
  assert.equal(lateVeto.error, CODES.E_HUMAN_APPROVAL_REQUIRED);
  assert.deepEqual(lateVeto.wrote, ["ship it"], "the run FAILS with the write standing — the veto arrived after the effect");

  // Case 2c — THE VERDICT IS SETTLED, THE RUN IS NOT. One rejection with the other two silent
  // parks `awaiting_gate`: the barrier still has members to hear from. "One rejection fails the
  // whole run" is true of the outcome and not of the moment, which is why the description says
  // "once the remaining gates are answered" rather than leaving a copier to wait for a failure
  // that has not happened yet.
  const loneReject = await drive(SPEC, [["alice", "reject"]]);
  assert.equal(loneReject.status, "awaiting_gate");
  assert.deepEqual(loneReject.wrote, []);
  assert.equal(loneReject.error, undefined, "and no error yet — nothing has been decided against");

  // Case 3 — all three reject.
  const allReject = await drive(SPEC, [["alice", "reject"], ["bob", "reject"], ["carol", "reject"]]);
  assert.deepEqual(allReject.wrote, []);
  assert.equal(allReject.status, "failed");
  assert.equal(allReject.error, CODES.E_HUMAN_APPROVAL_REQUIRED);

  // Case 4 — two reject, one approves. Fails for the same reason as case 2 and NOT because the
  // quorum was short: under `"fail"` the first rejection already decided it.
  const twoReject = await drive(SPEC, [["alice", "reject"], ["bob", "reject"], ["carol", "approve"]]);
  assert.deepEqual(twoReject.wrote, []);
  assert.equal(twoReject.status, "failed");
  assert.equal(twoReject.error, CODES.E_HUMAN_APPROVAL_REQUIRED);
});

test("§A.68 · THE FILE SAYS SO IN ITS OWN WORDS — the description states the veto, and a `residue` label carries what the other arm now does", () => {
  const description = String((SPEC.metadata as { description?: unknown }).description ?? "");
  const labels = (SPEC.metadata as { labels?: Record<string, string> }).labels ?? {};
  // The defect was a description and a behaviour disagreeing, so the description is what is
  // asserted — not a comment in this file, which a reader copying the example never sees.
  assert.match(description, /VETO/i, `the description must state that one rejection fails the run: ${description}`);
  assert.match(description, /onBranchError/, "and name the field that does it");
  assert.match(description, /one rejection fails the whole run/i, description);
  // NOT "arrives first" — a rejection arriving SECOND vetoes too, with nothing written, and the
  // rule a copier needs is the boundary, not the position. Understating it in the description and
  // stating it correctly only in a label further down would be this file's defect a second time.
  assert.match(description, /before the second approval/i, `the description must give the boundary, not "first": ${description}`);
  assert.match(description, /already landed/i, "and say what a rejection after it is worth");
  // AND THE MOMENT, not just the verdict: one rejection with the other two silent leaves the run
  // `awaiting_gate`, which the fourth driven case below pins. "Fails the whole run" on its own
  // reads as "fails now" and would send a copier looking for a failure that has not happened yet.
  assert.match(description, /awaiting_gate|until the other people vote/i, `the description must say the run parks until the rest vote: ${description}`);
  // AND THE LABEL MUST SAY WHAT IS TRUE NOW, not what was true when §A.68 measured it. The old
  // form of this assertion required the words "skip" and "ONE approval" together, which the old
  // label supplied in a sentence saying `skip` "lets ONE approval out of three land the write ...
  // the fold never re-checks `k`" — false since §A.75, and GREEN, because a pattern over two words
  // cannot tell a measurement from its negation. What a copier needs is the live difference
  // between the two values, so that is what is asserted.
  assert.ok(
    Object.values(labels).some((v) => /skip/.test(v) && /floor/.test(v) && /E_QUORUM_UNREACHABLE/.test(v)),
    `a residue label must say that "skip" now refuses at the barrier on the k floor: ${JSON.stringify(labels)}`,
  );
  assert.ok(
    Object.values(labels).some((v) => /differ only in WHEN/i.test(v)),
    `and that the two values differ in WHEN they refuse, which is the choice a copier is making: ${JSON.stringify(labels)}`,
  );
  assert.ok(
    !Object.values(labels).some((v) => /never re-checks/i.test(v) || /land the write, because/i.test(v)),
    `no label may still state the defect as current behaviour: ${JSON.stringify(labels)}`,
  );
  // And the veto's own limit, which is the half a reader is likeliest to get wrong.
  assert.ok(
    Object.values(labels).some((v) => /already landed/i.test(v)),
    `a residue label must say that a rejection arriving third fails a run whose write already happened: ${JSON.stringify(labels)}`,
  );
});

test("§A.68's `onBranchError: \"skip\"` ARM IS NOW AVAILABLE — §A.75 made `k` a floor, so one approval of three refuses", async () => {
  // THIS TEST WENT RED ON PURPOSE AND WAS FLIPPED. Its previous form MEASURED the defect §A.75
  // names — under `"skip"`, ONE approval of three landed the write, so `k: 2` was any-of-3 — and
  // said in as many words that if the line ever failed, "the engine enforces k on the
  // noMoreArrivals release and §A.68's skip arm is open". It failed at §A.75's fix: `#foldJoin`
  // now folds a `quorum` barrier against its own `k` whatever `onBranchError` says, so the release
  // that happens because no further arrival is possible no longer reports a success the graph did
  // not ask for.
  //
  // SO THE ARM IS AVAILABLE AND THE EXAMPLE STILL DOES NOT TAKE IT: switching the shipped
  // `examples/graphs/two-person-approval.json` from `"fail"` to `"skip"` is a MAINTAINER's
  // decision, not a consequence of this fix, and it stays `"fail"` until one is taken. What this
  // test now owns is that the decision is a FREE one — both values refuse a run that did not reach
  // `k`, and they differ only in WHEN (`"fail"` at the first rejection, `"skip"` at the barrier),
  // which is what these assertions and the `"fail"` cases above are together.
  const skip = JSON.parse(JSON.stringify(SPEC)) as GraphSpec;
  const quorum = skip.nodes.find((n) => n.id === ("quorum" as NodeId))!;
  (quorum.join as { onBranchError: string }).onBranchError = "skip";

  // Wanted, and delivered: two approvals over one rejection land the write.
  const oneReject = await drive(skip, [["alice", "reject"], ["bob", "approve"], ["carol", "approve"]]);
  assert.deepEqual(oneReject.wrote, ["ship it"]);
  assert.equal(oneReject.status, "succeeded");

  // Wanted, and delivered: all three rejecting fails, on §D.9's arm.
  const allReject = await drive(skip, [["alice", "reject"], ["bob", "reject"], ["carol", "reject"]]);
  assert.deepEqual(allReject.wrote, []);
  assert.equal(allReject.status, "failed");
  assert.equal(allReject.error, CODES.E_QUORUM_UNREACHABLE);

  // WANTED, AND NOW DELIVERED, in all three orderings: `k: 2` unmet, so the write does NOT land.
  // This is the block that was inverted. The ordering is swept rather than picked because `k` is a
  // floor and not a race — which approver said yes cannot change the count — and because the defect
  // it replaces was present in all three orderings, not in one.
  for (const approver of ["alice", "bob", "carol"] as const) {
    const order = (["alice", "bob", "carol"] as const).map(
      (who) => [who, who === approver ? "approve" : "reject"] as const,
    );
    const r = await drive(skip, order);
    assert.deepEqual(r.wrote, [], `with only ${approver} approving, k: 2 is unmet, so nothing may be written — §A.75`);
    assert.equal(r.status, "failed", `${approver}: and the run does not report a success it did not earn`);
    assert.equal(r.error, CODES.E_QUORUM_UNREACHABLE, `${approver}: named by the barrier, not by a gate`);
  }
});
