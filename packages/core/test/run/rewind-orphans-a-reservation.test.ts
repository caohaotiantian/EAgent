/**
 * A REWIND THAT LANDS INSIDE A RESERVATION WINDOW MUST NOT LEAVE THE PROMISE STANDING.
 *
 * `budget.reserved` and `budget.settled` are written on either side of a model call — reserve
 * before, settle after — and `Engine.rewind` suppresses a RANGE. So a boundary between the two
 * keeps the debit and hides the credit, and `projection.ts` folds `reservedUsd` by adding one
 * and subtracting the other. Measured on this file's graph, whose first run is
 *
 *     1:run.submitted ... 9:budget.reserved 10:effect.started 11:budget.settled
 *     12:model.called 13:effect.completed 14:task.committed 15:state.reduced 16:run.completed
 *
 * rewinding to 9 and re-running to completion, before `#rewindSerially` compensated:
 *
 *     after re-run  : status=succeeded reservedUsd=0.001048 costUsd=0.000027
 *     audit budget.reservation-is-settled violations: 1
 *       scope "node:work" reserved budget at seq 9 and the run completed without settling it
 *
 * TWO WRONG ANSWERS, AND BOTH ARE NEW — `reservedUsd` folded to a uniform 0 until the pair
 * gained appenders, so neither could happen before. The first is a SUCCEEDED run reporting
 * money it will never spend, on `GET /runs/:id`, forever. The second is worse: a guard that
 * fires on a healthy run is a guard somebody switches off.
 *
 * WHAT IS ASSERTED, AND WHY EACH ONE IS NOT THE OTHERS:
 *
 *   - the fold reaches 0 again — the operator-visible half;
 *   - the audit rule is CHECKED and clean — the guard half, and `checked` rather than "no
 *     violations" because a rule that saw nothing reports as skipped and would pass vacuously;
 *   - a SECOND `Engine` over the same store folds the same 0 — the repair is a journal fact and
 *     not a patch some process is holding, which is the invariant this repo has broken six
 *     times;
 *   - the compensating settle and the lease re-arm arrive in ONE `append`, observed at the
 *     store rather than inferred from adjacent seqs. `AppendInput.events` is "committed
 *     atomically as one transaction, or not at all", so one batch is the whole of "both or
 *     neither" — and a half-applied repair is worse than none, because `rewind` has already
 *     returned to its caller by the time anyone could notice;
 *   - a rewind BELOW the reservation writes NO compensating row. That is the over-settling
 *     guard: the repair must fire on what the rewind orphaned and be silent otherwise, or it
 *     becomes a second way to lose a promise.
 *
 * WHAT MAKES THIS FAIL RATHER THAN JUST PASS. Run with `#rewindSerially`'s `orphaned` list
 * forced empty — the repair computed and never applied — three of the four go red:
 *
 *   - `AssertionError: a completed run owes nothing; the fold reports 0.001048 promised`
 *   - `AssertionError: a rule that fires on a healthy completed run is a rule somebody switches
 *     off` — actual `[{rule: "budget.reservation-is-settled", seq: 9, detail: 'scope
 *     "node:work" reserved budget at seq 9 and the run completed without settling it'}]`
 *   - `AssertionError: exactly one batch carries the repair:
 *     [["operator.command"],["checkpoint.restored","operator.command"],["task.ready"]]`
 *
 * THE FOURTH STAYS GREEN AND MUST — it asserts an ABSENCE, so deleting the repair cannot break
 * it. It is here for the opposite mutation: a repair that fired on every rewind rather than on
 * an orphaned promise.
 *
 * The run this drives is `budget-reservation-is-durable.test.ts`'s graph, deliberately: it is
 * the journal shape the appenders were measured on, so the two files disagree about nothing.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { auditRun } from "../../src/journal/audit.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { ToolManifestLite } from "../../src/graph/validate.ts";
import type { NodeId, RunId, Seq } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import type { AppendInput, AppendResult } from "../../src/journal/store.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "./skeleton.ts";
import { rewindWithPlan } from "./operator.ts";

const NOW = 1_700_000_000_000;

const TOOLS: Record<string, ToolManifestLite> = {
  "note.read": { name: "note.read", version: "1.0", capabilities: ["fs:read"], irreversibility: "read_only", idempotent: true },
};

function spec(): GraphSpec {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "budget-reservation", project: "test", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 }, capabilities: ["fs:read"] },
    channels: { goal: { type: "string", reduce: "replace" }, done: { type: "object", reduce: "replace" } },
    inputs: ["goal"],
    outputs: ["done"],
    nodes: [
      {
        id: "work" as NodeId,
        type: "agent",
        reads: ["goal"],
        writes: ["done"],
        agent: {
          profile: "agent_profile/w@stable",
          prompt: "prompt/w@stable",
          maxTurns: 2,
          tools: ["note.read"],
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
}

/**
 * THE APPEND BOUNDARY, WHICH THE JOURNAL DOES NOT RECORD.
 *
 * `Engine` says so itself where it declines to make the rewind refusals structural: "the journal
 * records no append boundary". Two adjacent seqs are therefore not evidence of one transaction,
 * so the batch is observed at the only place it exists — the store's own `append` argument.
 */
class Batches extends MemoryStateStore {
  readonly batches: string[][] = [];
  override async append(input: AppendInput): Promise<AppendResult> {
    const out = await super.append(input);
    this.batches.push(input.events.map((e) => e.type));
    return out;
  }
}

function harness(): { readonly store: Batches; readonly engine: Engine; readonly graph: ReturnType<typeof compileOrThrow> } {
  const now = (): number => NOW;
  const tools = new ToolRegistry();
  tools.register({
    ...TOOLS["note.read"]!,
    description: "Read a note.",
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "a note" }),
  } satisfies ToolDefinition);
  const models = new ModelRegistry();
  models.register(new MockModelAdapter({ script: () => ({ text: JSON.stringify({ ok: true }), finishReason: "stop" }), pricePerMTok: 1 }) as never, true);
  const store = new Batches({ now });
  const engine = new Engine({
    store,
    tools,
    functions: new FunctionRegistry(),
    models,
    now,
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  const graph = compileOrThrow({ spec: spec(), resolver: resolver(), tools: TOOLS, tenantCapabilities: ["fs:read"] });
  return { store, engine, graph };
}

async function journal(store: MemoryStateStore, runId: RunId): Promise<JournalEvent[]> {
  const out: JournalEvent[] = [];
  for await (const ev of store.read(runId, 1 as Seq)) out.push(ev);
  return out;
}

/**
 * ONE REWIND, DRIVEN TO COMPLETION, AT THE BOUNDARY THAT ORPHANS THE RESERVATION.
 *
 * The seq is read off the journal rather than written down: `suppressedRanges` is exclusive at
 * both ends, so rewinding to `budget.reserved`'s OWN seq keeps the debit live and hides
 * everything above it up to the marker, the settlement included.
 *
 * TWO CASES SHARE IT RATHER THAN ONE ASSERTING BOTH THINGS, and that is not tidiness. The
 * defect has two symptoms — a phantom `reservedUsd` and an audit rule firing on a healthy run —
 * and an assertion that throws stops the case, so a single test would only ever measure the
 * first of them red under a mutation. Split, both are evidence.
 */
async function rewoundAcrossTheReservation(h: ReturnType<typeof harness>): Promise<RunId> {
  const runId = await h.engine.submit({ graph: h.graph, inputs: { goal: "g" } });
  await h.engine.advance(runId);

  const first = await journal(h.store, runId);
  const reserved = first.find((e) => e.type === "budget.reserved");
  const settled = first.find((e) => e.type === "budget.settled");
  assert.ok(reserved !== undefined && settled !== undefined, `the run must take and release a reservation: ${first.map((e) => e.type).join(" ")}`);
  // THE WINDOW HAS TO BE NON-EMPTY or this case is about nothing: a boundary can only fall
  // between the two rows when there is something between them.
  assert.ok(Number(settled.seq) > Number(reserved.seq), "the settle comes after the reserve");

  await rewindWithPlan(h.engine, runId, reserved.seq, "operator rewound into a model turn");
  await h.engine.advance(runId);
  return runId;
}

test("A REWIND ACROSS A RESERVATION SETTLES WHAT IT ORPHANED, AND THE RUN ENDS OWING NOTHING", async () => {
  const h = harness();
  const runId = await rewoundAcrossTheReservation(h);

  const end = (await h.engine.projection(runId))!;
  assert.equal(end.status, "succeeded", "the re-executed run still completes");
  assert.ok(end.usage.costUsd > 0, "and it really re-ran the turn, rather than reporting a success it did not have");
  assert.equal(end.reservedUsd, 0, `a completed run owes nothing; the fold reports ${String(end.reservedUsd)} promised`);

  // DURABLE, NOT HELD. A second plane that never reserved, never rewound and holds no
  // `PolicyEngine` state for this run folds the same answer out of the log.
  const observer = new Engine({
    store: h.store,
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => NOW,
    policy: { granted: ["fs:read"], systemFloor: "out", budget: { runUsd: 1 } },
  });
  assert.equal((await observer.projection(runId))?.reservedUsd, 0, "a restart must not bring the phantom promise back");
});

test("`budget.reservation-is-settled` STAYS QUIET ON THE REWOUND-AND-COMPLETED RUN", async () => {
  const h = harness();
  const runId = await rewoundAcrossTheReservation(h);

  // `checked` rather than an empty violation list: a rule that saw no event it constrains is
  // reported as skipped, and this would pass vacuously on a journal with no reservation in it.
  const report = auditRun(await journal(h.store, runId));
  assert.ok(
    report.checked.includes("budget.reservation-is-settled"),
    `the rule must have seen a reservation; it was skipped as: ${JSON.stringify(report.skipped.find((s) => s.rule === "budget.reservation-is-settled"))}`,
  );
  assert.deepEqual(
    report.violations.filter((v) => v.rule === "budget.reservation-is-settled"),
    [],
    "a rule that fires on a healthy completed run is a rule somebody switches off",
  );
  // AND NOTHING ELSE IS BROKEN BY THE REPAIR. A compensating row that satisfied its own rule and
  // tripped another would have moved the problem rather than fixed it.
  assert.deepEqual(report.violations, [], `the whole report must be clean: ${JSON.stringify(report.violations)}`);
});

test("THE COMPENSATING SETTLE AND THE LEASE RE-ARM ARE ONE APPEND — both, or neither", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: { goal: "g" } });
  await h.engine.advance(runId);
  const reserved = (await journal(h.store, runId)).find((e) => e.type === "budget.reserved")!;

  const before = h.store.batches.length;
  await rewindWithPlan(h.engine, runId, reserved.seq, "operator rewound into a model turn");

  // Only the batches the rewind itself wrote, so a later `advance` cannot lend this its evidence.
  const written = h.store.batches.slice(before);
  const withSettle = written.filter((b) => b.includes("budget.settled"));
  assert.equal(withSettle.length, 1, `exactly one batch carries the repair: ${JSON.stringify(written)}`);
  assert.ok(
    withSettle[0]!.includes("task.ready"),
    `the money repair and the lease re-arm must be committed together: ${JSON.stringify(withSettle[0])}`,
  );
  // AND THE REWIND ITSELF IS STILL ITS OWN TRANSACTION. The marker and the authorization the
  // operator gave are batched above for their own reason; folding the repair into that append
  // would put the compensating settle inside a range a SECOND rewind to the same boundary hides.
  assert.ok(
    written.some((b) => b.includes("checkpoint.restored") && !b.includes("budget.settled")),
    `the marker append stays separate from the repair: ${JSON.stringify(written)}`,
  );
});

test("A REWIND BELOW THE RESERVATION COMPENSATES NOTHING — the repair is not a second way to lose a promise", async () => {
  const h = harness();
  const runId = await h.engine.submit({ graph: h.graph, inputs: { goal: "g" } });
  await h.engine.advance(runId);
  const reserved = (await journal(h.store, runId)).find((e) => e.type === "budget.reserved")!;

  // One below, so the reservation is suppressed along with its settlement and there is nothing
  // outstanding for the repair to find. A compensating row here would be releasing a promise the
  // fold no longer holds.
  const before = h.store.batches.length;
  await rewindWithPlan(h.engine, runId, (Number(reserved.seq) - 1) as Seq, "operator rewound in front of the turn");
  const written = h.store.batches.slice(before);
  assert.deepEqual(
    written.filter((b) => b.includes("budget.settled")),
    [],
    `nothing was orphaned, so nothing is compensated: ${JSON.stringify(written)}`,
  );

  await h.engine.advance(runId);
  const end = (await h.engine.projection(runId))!;
  assert.equal(end.status, "succeeded");
  assert.equal(end.reservedUsd, 0, "and the re-run's own reserve/settle pair still balances");
});
