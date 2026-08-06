/**
 * One journal, and a way to fold it in SOMEBODY ELSE'S PROCESS.
 *
 * This exists because the determinism claim `telemetry/spans.ts` opens with cannot be
 * tested from inside one process. The test that stood for it — "the same journal yields
 * identical spans" — folded twice in the same process, which a per-process token key
 * satisfies perfectly; that is how a random key came to sit under a function documented as
 * a pure function of the journal, with a green suite either side of the change.
 *
 * So the fixture and the fold both live here, and the test spawns this file. Run directly
 * it writes `JSON.stringify(spansFrom(fixtureJournal()))` to stdout and nothing else, so
 * the parent can compare BYTES with its own fold. Imported, it is just the fixture.
 *
 * The journal is hand-written and every `ts` is a literal, so nothing here reads a clock,
 * touches a network, or depends on anything but the deployment key in the environment —
 * which is the one variable the test is actually varying.
 *
 * It carries one of every `pii`-classified attribute in `ATTRIBUTE_CLASSES`, because those
 * are the only values whose bytes a key can change: the approver, the gate content digest,
 * the two state hashes, and an escalation's recipient list on a span EVENT.
 */

import { spansFrom } from "../../src/telemetry/spans.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId, TaskId } from "../../src/ids.ts";

const RUN = "01JRUNFIXTURE00000000000000" as RunId;
const TASK = "approve@#0" as TaskId;

function ev(seq: number, type: string, payload: unknown, actor?: unknown, taskId: TaskId | null = TASK): JournalEvent {
  return {
    runId: RUN,
    seq,
    ts: 1_000 + seq * 10,
    type,
    payload,
    actor: actor ?? { kind: "system", component: "fixture" },
    ...(taskId === null ? {} : { taskId }),
    classification: "internal",
  } as unknown as JournalEvent;
}

export function fixtureJournal(): readonly JournalEvent[] {
  return [
    ev(1, "run.submitted", { workflow: "w", graphHash: "h", inputs: {}, idempotencyKey: "k", configDigest: "c" }, undefined, null),
    ev(2, "task.ready", { nodeId: "approve", branchPath: "", edgesIn: ["e1"] }),
    ev(3, "state.reduced", {
      channels: ["findings"],
      values: {},
      branchCount: 1,
      skipped: 0,
      degraded: false,
      stateHashBefore: "sha256:1111111111111111",
      stateHashAfter: "sha256:2222222222222222",
    }),
    ev(4, "gate.raised", { gateId: "g_1", nodeId: "approve", policyRef: "p", contentDigest: "sha256:3333333333333333" }),
    ev(5, "gate.escalated", { gateId: "g_1", tier: 1, to: "user:oncall@example.com, role:sre", deadline: 900_000 }),
    ev(6, "gate.decided", { gateId: "g_1", decision: "approve", latencyMs: 42 }, { kind: "human", subject: "u:alice@example.com", via: "console" }),
    ev(7, "task.committed", { take: ["e1"], status: "succeeded", writes: {} }),
    ev(8, "run.completed", { usage: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 } }, undefined, null),
  ];
}

if (import.meta.filename === process.argv[1]) {
  process.stdout.write(JSON.stringify(spansFrom(fixtureJournal())));
}
