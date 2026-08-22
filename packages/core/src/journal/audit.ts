/**
 * Read the journal back and check it holds together.
 *
 * Invariant 2 makes the journal the only authoritative durable state. Nothing checked that the
 * authoritative state was internally CONSISTENT. The closest thing was `conformsToGraph` in
 * `telemetry/spans.ts`, which is set-membership plus a hash — so it reported `ok` straight
 * through the human-gate bypass, because every id in the bypass was declared. Membership was
 * never the question; the question is whether the ids stand in the right RELATION to each other.
 *
 * Every rule here is a property of a SEQUENCE, which is why no single call site can hold it. A
 * writer knows it is appending `effect.completed`; it does not know whether anything ever
 * appended the matching `effect.started`, or whether a second completion already used that key.
 *
 * DELIBERATELY OFFLINE AND PURE. The obvious alternative — the one deepseek-harness takes — is
 * to register checkers as listeners on live dispatch. Two reasons not to: it puts a throwing
 * auditor on the durable write path, which is invariant 2's own failure mode, and our `EventBus`
 * is explicitly lossy under backpressure (invariant 8), so a listener-based auditor would report
 * violations that are really dropped deliveries. This function takes events and returns findings.
 * It performs no I/O, holds no state between calls, and cannot fail a run.
 *
 * WHAT IT DOES NOT DO is as load-bearing as what it does. A rule it could not run is reported in
 * `skipped`, never omitted: a checker that returns "no violations" because it never looked is
 * indistinguishable from one that looked and found nothing, and this repo has shipped that
 * mistake often enough to name it.
 */

import type { JournalEvent } from "./events.ts";

/** Stable ids: they get cited in journal entries and in the exhaustiveness gate that follows. */
export const AUDIT_RULES = [
  "effect.completion-has-a-start",
  "effect.kind-matches-its-key",
  "effect.completed-once",
  "policy.deescalation-is-human",
  "gate.raised-is-resolved",
  "budget.reservation-is-settled",
  "task.no-commit-after-cancel",
  "edge.taken-belongs-to-its-node",
] as const;

export type AuditRule = (typeof AUDIT_RULES)[number];

export interface Violation {
  readonly rule: AuditRule;
  /** Where it was observed. `0` when the violation is an ABSENCE and has no event of its own. */
  readonly seq: number;
  readonly detail: string;
}

export interface AuditReport {
  readonly violations: readonly Violation[];
  /** Rules that actually ran. */
  readonly checked: readonly AuditRule[];
  /** Rules that could not run, and why. Never silently dropped. */
  readonly skipped: readonly { readonly rule: AuditRule; readonly why: string }[];
}

export interface AuditOptions {
  /**
   * Edge id → the node it leaves. Required by `edge.taken-belongs-to-its-node`, because the
   * ORIGINAL compiled graph is not in the journal — only its hash is — so ownership cannot be
   * derived from events alone. Omit it and that rule is reported as skipped.
   */
  readonly edgeSource?: Readonly<Record<string, string>>;
}

/** `nodeId@branchPath#iteration` — the part of a TaskId before `@`. */
function nodeOf(taskId: string): string {
  const at = taskId.indexOf("@");
  return at < 0 ? taskId : taskId.slice(0, at);
}

/**
 * The `kind` segment of an effect key.
 *
 * `effectKey` is `${taskId}:${kind}:${ordinal}` and a TaskId may itself contain `:`, so this
 * reads from the RIGHT. Splitting from the left finds a branch coordinate and compares it
 * against a kind, which fails on exactly the graphs that fan out.
 */
function kindOfKey(key: string): string | undefined {
  const parts = key.split(":");
  return parts.length < 3 ? undefined : parts[parts.length - 2];
}

const TERMINAL = new Set(["run.completed", "run.failed", "run.cancelled"]);

export function auditRun(events: readonly JournalEvent[], opts: AuditOptions = {}): AuditReport {
  const violations: Violation[] = [];
  const skipped: { rule: AuditRule; why: string }[] = [];
  const checked = new Set<AuditRule>(AUDIT_RULES);

  const add = (rule: AuditRule, seq: number, detail: string): void => {
    violations.push({ rule, seq, detail });
  };
  const skip = (rule: AuditRule, why: string): void => {
    checked.delete(rule);
    skipped.push({ rule, why });
  };

  // A run that has not finished is ALLOWED to hold an open gate and an unsettled reservation.
  // Checking "eventually" properties on a live run is how a guard learns to cry wolf, and a
  // guard that cries wolf on correct code gets switched off — which costs more than it caught.
  const terminal = events.some((e) => TERMINAL.has(e.type));

  const startedKinds = new Map<string, string>();
  const completedAt = new Map<string, number>();
  const openGates = new Map<string, number>();
  const reservedScopes = new Map<string, number>();
  const settledScopes = new Set<string>();
  const cancelledTasks = new Map<string, number>();

  for (const e of events) {
    const seq = Number(e.seq);
    switch (e.type) {
      case "effect.started": {
        const p = e.payload as { key: string; kind: string };
        startedKinds.set(p.key, p.kind);
        const inKey = kindOfKey(p.key);
        // THE ONE CLAUDE.MD RECORDS AS HAVING BEEN WRONG AT TWO OF FOUR SITES for the whole life
        // of the project: the subgraph effect keyed `subgraph` and declared `mailbox`, the
        // summariser keyed `summarize` and declared `model`. An auditor filtering by `kind` could
        // not find a single summarisation, and nothing anywhere compared the two.
        if (inKey !== undefined && inKey !== p.kind) {
          add("effect.kind-matches-its-key", seq, `key says kind "${inKey}", the event declares "${p.kind}" (${p.key})`);
        }
        break;
      }
      case "effect.completed":
      case "effect.failed": {
        const p = e.payload as { key: string };
        if (!startedKinds.has(p.key)) {
          add("effect.completion-has-a-start", seq, `${e.type} for "${p.key}" with no prior effect.started`);
        }
        if (e.type === "effect.completed") {
          const prior = completedAt.get(p.key);
          if (prior !== undefined) {
            add("effect.completed-once", seq, `"${p.key}" was completed at seq ${prior} and again here`);
          }
          completedAt.set(p.key, seq);
        }
        break;
      }
      case "policy.deescalated": {
        // Invariant 5: nothing may lower a posture except an explicit HUMAN de-escalation. The
        // engine's `deescalate` refuses a non-human actor, so a journal that carries one means
        // either a second writer or a corrupted record — both worth knowing about.
        if (e.actor.kind !== "human") {
          add("policy.deescalation-is-human", seq, `a posture was lowered by a ${e.actor.kind} actor`);
        }
        break;
      }
      case "gate.raised":
        openGates.set(String((e.payload as { gateId: string }).gateId), seq);
        break;
      case "gate.decided":
      case "gate.batch_decided":
      case "gate.deduped":
      case "gate.timeout":
      case "gate.cancelled": {
        const p = e.payload as { gateId?: string; gateIds?: readonly string[] };
        for (const id of p.gateIds ?? (p.gateId === undefined ? [] : [p.gateId])) openGates.delete(String(id));
        break;
      }
      case "budget.reserved":
        reservedScopes.set(String((e.payload as { scope: string }).scope), seq);
        break;
      case "budget.settled":
      case "budget.exhausted":
        settledScopes.add(String((e.payload as { scope: string }).scope));
        break;
      case "task.cancelled":
        if (e.taskId !== undefined) cancelledTasks.set(String(e.taskId), seq);
        break;
      case "task.committed": {
        const tid = e.taskId === undefined ? undefined : String(e.taskId);
        if (tid !== undefined) {
          const at = cancelledTasks.get(tid);
          if (at !== undefined) {
            add("task.no-commit-after-cancel", seq, `task "${tid}" was cancelled at seq ${at} and committed here`);
          }
          const owner = nodeOf(tid);
          const take = (e.payload as { take?: readonly string[] }).take ?? [];
          if (opts.edgeSource !== undefined) {
            for (const edge of take) {
              const from = opts.edgeSource[edge];
              // THE GATE-BYPASS BUG, as a relation. `#activate` looked an edge id up in the WHOLE
              // graph's table, so a `take` naming another node's edge jumped everything between —
              // and the span conformance check reported `ok`, because every id was declared.
              if (from !== undefined && from !== owner) {
                add("edge.taken-belongs-to-its-node", seq, `task "${tid}" took edge "${edge}", which leaves "${from}"`);
              }
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (opts.edgeSource === undefined) {
    skip("edge.taken-belongs-to-its-node", "no edgeSource supplied: the compiled graph is not in the journal, only its hash");
  }
  if (!terminal) {
    skip("gate.raised-is-resolved", "the run has not reached a terminal event; an open gate is legal");
    skip("budget.reservation-is-settled", "the run has not reached a terminal event; an unsettled reservation is legal");
  } else {
    for (const [gateId, seq] of openGates) {
      add("gate.raised-is-resolved", seq, `gate "${gateId}" was raised and the run ended without resolving it`);
    }
    for (const [scope, seq] of reservedScopes) {
      if (!settledScopes.has(scope)) {
        add("budget.reservation-is-settled", seq, `scope "${scope}" reserved budget that was never settled or exhausted`);
      }
    }
  }

  return { violations, checked: [...checked], skipped };
}
