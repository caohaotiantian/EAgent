/**
 * Read the journal back and check it holds together.
 *
 * Invariant 2 makes the journal the only authoritative durable state. Nothing checked that the
 * authoritative state was internally CONSISTENT. The closest thing was `conformsToGraph` in
 * `telemetry/spans.ts`, which is set-membership plus a hash — so it reported `ok` straight
 * through the human-gate bypass, because every id in the bypass was declared. Membership was
 * never the question; the question is whether the ids stand in the right RELATION to each other,
 * and a relation is a property of a SEQUENCE, which no single call site can hold.
 *
 * DELIBERATELY OFFLINE AND PURE. The obvious alternative — registering checkers on live dispatch
 * — puts a throwing auditor on the durable write path, which is invariant 2's own failure mode,
 * and our `EventBus` is lossy under backpressure (invariant 8), so a listener would report
 * violations that are really dropped deliveries.
 *
 * ── THREE RULES THIS FILE LEARNED THE HARD WAY ──────────────────────────────────────────────
 *
 * **A rule must not fire on a healthy run.** The first version had three that did, and all three
 * were shapes this repo already tests: a retry (effect keys are STABLE across attempts by
 * design — `ids.ts` says so in as many words), a rewind (the fold suppresses undone history and
 * this did not), and an SLA expiry (one gate times out, the run fails, and its siblings are
 * abandoned on purpose). A guard that cries wolf on correct code gets switched off, which costs
 * more than it ever caught.
 *
 * **A rule with no evidence is not a rule that passed.** `checked` means the rule SAW at least
 * one relevant event. The first version seeded `checked` with everything and only ever removed
 * from it, so two rules built on event types nothing appends reported as checked on every run —
 * the exact defect the paragraph below names, shipped in the module that names it.
 *
 * **A rule for an event nothing writes is not a rule.** `budget.reservation-is-settled` and
 * `task.no-commit-after-cancel` were deleted, not disabled: `budget.reserved`, `budget.settled`
 * and `task.cancelled` are all pinned in `test/docs-drift.test.ts`'s never-appended registry
 * (the reservation lives in `PolicyEngine`'s memory; `cancel()` appends `run.cancelled` only).
 * They come back when the events do.
 */

import { suppressedRanges } from "../run/projection.ts";
import type { JournalEvent } from "./events.ts";

/** Stable ids: they get cited in journal entries and in the exhaustiveness gate that follows. */
export const AUDIT_RULES = [
  "effect.completion-has-a-start",
  "effect.kind-matches-its-key",
  "effect.completed-once-per-attempt",
  "policy.deescalation-is-human",
  "gate.raised-is-resolved",
  "gate.decision-has-a-raise",
  "task.committed-once",
  "task.leased-precedes-commit",
  "run.submitted-is-first-and-once",
  "call-pairs-with-its-effect",
  "edge.taken-belongs-to-its-node",
] as const;

export type AuditRule = (typeof AUDIT_RULES)[number];

export interface Violation {
  readonly rule: AuditRule;
  readonly seq: number;
  readonly detail: string;
}

export interface AuditReport {
  readonly violations: readonly Violation[];
  /** Rules that ran AND saw at least one relevant event. */
  readonly checked: readonly AuditRule[];
  /** Every other rule, with the reason it did not check anything. Never silently dropped. */
  readonly skipped: readonly { readonly rule: AuditRule; readonly why: string }[];
}

export interface AuditOptions {
  /**
   * Edge id → the node it leaves. Required by `edge.taken-belongs-to-its-node`: the original
   * compiled graph is not in the journal — only its hash is — so ownership cannot be derived
   * from events alone. Omit it and the rule is reported as skipped.
   *
   * An EMPTY map is not the same as an absent one, and conflating them is how the first version
   * lied: the CLI passed `{}`, every lookup missed, nothing was examined, and the report said
   * the rule had been checked.
   */
  readonly edgeSource?: Readonly<Record<string, string>>;
}

/** Total reads. A journal this cannot parse is exactly the journal it exists to diagnose. */
function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** `nodeId@branchPath#iteration` — the part before `@`. */
function nodeOf(taskId: string): string {
  const at = taskId.indexOf("@");
  return at < 0 ? taskId : taskId.slice(0, at);
}

/**
 * The `kind` segment of `${taskId}:${kind}:${ordinal}`.
 *
 * Read from the RIGHT because that is robust to a taskId shape changing, not because a taskId
 * can contain `:` today — it cannot: `graph/validate.ts` raises `GRAPH003_BAD_ID` for `: @ # / [ ]`
 * in a node id, and a branch path is `root/e0[0]`, which has no colon at all. An earlier comment
 * here claimed otherwise and a test "proved" it with a key `taskId()` cannot mint.
 */
function kindOfKey(key: string): string | undefined {
  const parts = key.split(":");
  return parts.length < 3 ? undefined : parts[parts.length - 2];
}

export function auditRun(events: readonly JournalEvent[], opts: AuditOptions = {}): AuditReport {
  const violations: Violation[] = [];
  const saw = new Set<AuditRule>();
  const unrunnable = new Map<AuditRule, string>();

  const add = (rule: AuditRule, seq: number, detail: string): void => void violations.push({ rule, seq, detail });

  // A REWIND NEVER EDITS HISTORY — it appends a marker, and the fold suppresses what it undid.
  // Reading raw events meant a run rewound past an approval and re-approved looked like a double
  // completion. Same helper the projection uses, so the two cannot drift.
  const all = [...events];
  const hidden = suppressedRanges(all);
  const live = all.filter((e) => !hidden.some(([from, to]) => Number(e.seq) > from && Number(e.seq) < to));

  // Only a run that COMPLETED must have closed every gate. `run.failed`/`run.cancelled` abandon
  // siblings on purpose: `HumanGateBroker.#expire` fails the run for the ONE gate that expired,
  // and leaving the others open is what stops a suspended run with no answerable gate.
  const completed = live.some((e) => e.type === "run.completed");

  const startedAttempt = new Map<string, number>();
  const startedKind = new Map<string, string>();
  const completions = new Map<string, number>();
  const openGates = new Map<string, number>();
  const raisedGates = new Set<string>();
  const commits = new Map<string, number>();
  const leased = new Set<string>();
  const submissions: number[] = [];

  for (const e of live) {
    const seq = Number(e.seq);
    const p = obj(e.payload);
    if (p === undefined) continue;

    switch (e.type) {
      case "effect.started": {
        const key = str(p["key"]);
        if (key === undefined) break;
        const attempt = typeof p["attempt"] === "number" ? p["attempt"] : 1;
        startedAttempt.set(key, attempt);
        const declared = str(p["kind"]);
        if (declared !== undefined) startedKind.set(key, declared);
        const inKey = kindOfKey(key);
        if (declared !== undefined && inKey !== undefined) {
          saw.add("effect.kind-matches-its-key");
          // THE ONE CLAUDE.md RECORDS AS HAVING BEEN WRONG AT TWO OF FOUR SITES for the whole
          // life of the project: the subgraph effect keyed `subgraph` and declared `mailbox`,
          // the summariser keyed `summarize` and declared `model`. Nothing compared the two, so
          // an auditor filtering by `kind` could not find a single summarisation.
          if (inKey !== declared) {
            add("effect.kind-matches-its-key", seq, `key says kind "${inKey}", the event declares "${declared}" (${key})`);
          }
        }
        break;
      }
      case "effect.completed":
      case "effect.failed": {
        const key = str(p["key"]);
        if (key === undefined) break;
        saw.add("effect.completion-has-a-start");
        if (!startedAttempt.has(key)) {
          add("effect.completion-has-a-start", seq, `${e.type} for "${key}" with no prior effect.started`);
        }
        if (e.type === "effect.completed") {
          // PER ATTEMPT. The key is deliberately stable across retries so a server-idempotent
          // tool dedupes for free — `ids.ts` says exactly that — so "completed twice" is only a
          // defect WITHIN one attempt. The first version asserted the opposite of the documented
          // contract and fired on every successful retry.
          const attempt = startedAttempt.get(key) ?? 1;
          const scoped = `${key}#${String(attempt)}`;
          saw.add("effect.completed-once-per-attempt");
          const prior = completions.get(scoped);
          if (prior !== undefined) {
            add("effect.completed-once-per-attempt", seq, `"${key}" completed twice in attempt ${String(attempt)} (also at seq ${String(prior)})`);
          }
          completions.set(scoped, seq);
        }
        break;
      }
      // `model.called` and `tool.called` are the human-legible record of an outbound call — the
      // provider, the model, the arguments' shape. `effect.started` is the REPLAYABLE record of
      // the same call. They are appended together at four sites and nothing checked they stayed
      // together: a `*.called` with no effect is a call the journal describes and replay cannot
      // reproduce, which is the ledger and the mechanism disagreeing about what happened.
      case "model.called":
      case "tool.called": {
        const key = str(p["key"]);
        if (key === undefined) break;
        saw.add("call-pairs-with-its-effect");
        const want = e.type === "model.called" ? "model" : "tool";
        const started = startedAttempt.has(key);
        if (!started) {
          add("call-pairs-with-its-effect", seq, `${e.type} for "${key}" with no effect.started — replay cannot reproduce it`);
        } else if (startedKind.get(key) !== want) {
          add(
            "call-pairs-with-its-effect",
            seq,
            `${e.type} for "${key}", whose effect declared kind "${String(startedKind.get(key))}" rather than "${want}"`,
          );
        }
        break;
      }
      case "policy.deescalated": {
        saw.add("policy.deescalation-is-human");
        // Invariant 5: nothing lowers a posture but an explicit HUMAN de-escalation. `Engine`
        // refuses a non-human actor, so a journal carrying one means a second writer.
        const kind = str(obj(e.actor)?.["kind"]);
        if (kind !== "human") {
          add("policy.deescalation-is-human", seq, `a posture was lowered by a ${kind ?? "malformed"} actor`);
        }
        break;
      }
      case "task.leased": {
        if (e.taskId !== undefined) leased.add(String(e.taskId));
        break;
      }
      case "run.submitted":
        submissions.push(seq);
        break;
      case "gate.raised": {
        const id = str(p["gateId"]);
        if (id !== undefined) {
          saw.add("gate.raised-is-resolved");
          openGates.set(id, seq);
          raisedGates.add(id);
        }
        break;
      }
      case "gate.decided":
      case "gate.batch_decided":
      case "gate.deduped":
      case "gate.timeout":
      case "gate.cancelled": {
        const one = str(p["gateId"]);
        const many = Array.isArray(p["gateIds"]) ? (p["gateIds"] as unknown[]) : [];
        for (const id of [...(one === undefined ? [] : [one]), ...many]) {
          const s = str(id);
          if (s === undefined) continue;
          saw.add("gate.decision-has-a-raise");
          // THE MIRROR OF `effect.completion-has-a-start`, and the direction that matters for
          // security: a forged approval row appended by a second writer passes every other rule
          // clean. `gates.ts` spends hundreds of lines making this impossible at the door;
          // nothing read the record back to confirm the door held.
          if (!raisedGates.has(s)) {
            add("gate.decision-has-a-raise", seq, `${e.type} for gate "${s}", which was never raised in this run`);
          }
          openGates.delete(s);
        }
        break;
      }
      case "task.committed": {
        const tid = e.taskId === undefined ? undefined : String(e.taskId);
        const take = Array.isArray(p["take"]) ? (p["take"] as unknown[]) : [];
        if (tid === undefined) break;
        saw.add("task.committed-once");
        // THE FENCING TOKEN'S ORDERING, read back. The lease's own seq IS the token — the
        // journal's seq is the only monotonic source every process shares — so a task that
        // commits without one committed under no token at all, which is the concurrent
        // double-execution `#serialize` and the compare-and-set exist to prevent.
        saw.add("task.leased-precedes-commit");
        if (!leased.has(tid)) {
          add("task.leased-precedes-commit", seq, `task "${tid}" committed with no prior task.leased — it held no fencing token`);
        }
        // The double-commit the seq-CAS and the fencing token exist to prevent. A loop iteration
        // and a fan-out branch each mint a DIFFERENT TaskId (`nodeId@branchPath#iteration`), so
        // one taskId committing twice is not a legal shape — once a rewind's undone history is
        // filtered out, which is why this reads `live` rather than the raw log.
        const before = commits.get(tid);
        if (before !== undefined) {
          add("task.committed-once", seq, `task "${tid}" committed at seq ${String(before)} and again here`);
        }
        commits.set(tid, seq);
        if (opts.edgeSource === undefined) break;
        const owner = nodeOf(tid);
        for (const raw of take) {
          const edge = str(raw);
          if (edge === undefined) continue;
          const from = opts.edgeSource[edge];
          // The gate bypass as a relation: `#activate` looked an edge id up in the WHOLE graph's
          // table, so a `take` naming another node's edge jumped everything between — and span
          // conformance reported `ok`, because every id involved was declared.
          if (from === undefined) continue;
          saw.add("edge.taken-belongs-to-its-node");
          if (from !== owner) {
            add("edge.taken-belongs-to-its-node", seq, `task "${tid}" took edge "${edge}", which leaves "${from}"`);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Only when the journal starts at the beginning. `auditRun` takes any array, and a caller
  // reading from seq 5 has a journal with no submission in it — which is not a defect in the run.
  const fromStart = live.length > 0 && Number(live[0]!.seq) === 1;
  if (fromStart) {
    saw.add("run.submitted-is-first-and-once");
    if (submissions.length === 0) {
      add("run.submitted-is-first-and-once", 1, "the journal begins at seq 1 with no run.submitted");
    } else {
      if (submissions[0] !== 1) {
        add("run.submitted-is-first-and-once", submissions[0]!, `run.submitted is at seq ${String(submissions[0])}, not first`);
      }
      for (const extra of submissions.slice(1)) {
        add("run.submitted-is-first-and-once", extra, "a second run.submitted — two writers, or one run submitted twice");
      }
    }
  } else {
    unrunnable.set("run.submitted-is-first-and-once", "this journal does not begin at seq 1, so the submission is legitimately absent from it");
  }

  if (completed) {
    for (const [gateId, seq] of openGates) {
      add("gate.raised-is-resolved", seq, `gate "${gateId}" was raised and the run completed without resolving it`);
    }
  } else if (saw.has("gate.raised-is-resolved")) {
    unrunnable.set("gate.raised-is-resolved", "the run did not complete; an open or abandoned gate is legal on a failed, cancelled or live run");
    saw.delete("gate.raised-is-resolved");
  }
  if (opts.edgeSource === undefined) {
    unrunnable.set("edge.taken-belongs-to-its-node", "no edgeSource supplied: the compiled graph is not in the journal, only its hash");
  }

  const skipped = AUDIT_RULES.filter((r) => !saw.has(r)).map((rule) => ({
    rule,
    why: unrunnable.get(rule) ?? "no event this rule constrains appears in this journal",
  }));
  return { violations, checked: AUDIT_RULES.filter((r) => saw.has(r)), skipped };
}
