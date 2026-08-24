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
  "task.cancelled-not-after-commit",
  "task.leased-precedes-commit",
  "task.leased-is-resolved",
  "run.submitted-is-first-and-once",
  "call-pairs-with-its-effect",
  "gate.raise-has-a-decision",
  "subgraph.start-and-completion-pair",
  "subgraph.child-id-is-derived",
  "policy.escalation-only-raises",
  "hook.applied-ref-is-declared",
  "state.chain-is-unbroken",
  "state.root-writes-are-reduced",
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
  /**
   * The hook refs the graph DECLARED, per point. Required by `hook.applied-ref-is-declared` for
   * the same reason `edgeSource` is required by its rule: the graph is not in the journal.
   */
  readonly hookRefs?: Readonly<Record<string, readonly string[]>>;
}

const POSTURE_RANK: Readonly<Record<string, number>> = { out: 0, on: 1, in: 2 };

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
  const openLeases = new Map<string, number>();
  const decidedTasks = new Set<string>();
  const reducedTasks = new Set<string>();
  const rootWriters = new Map<string, { seq: number; channels: string }>();
  let lastAfter: string | undefined;
  const childStarts = new Map<string, number>();
  const escalatedTo = new Map<string, string>();
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
      case "subgraph.started": {
        const child = str(p["childRunId"]);
        if (child === undefined) break;
        childStarts.set(child, seq);
        // INVARIANT 3 READ BACK. `#runSubgraph` derives the child's id as `${runId}~${taskId}`
        // for the same reason a TaskId is derived: replay and a restart must find the SAME child.
        // A random id here would break both silently, and nothing compared the journalled id to
        // the rule that is supposed to have produced it.
        if (e.taskId !== undefined) {
          saw.add("subgraph.child-id-is-derived");
          const want = `${String(e.runId)}~${String(e.taskId)}`;
          if (child !== want) {
            add("subgraph.child-id-is-derived", seq, `child run id "${child}" is not the derived "${want}" — replay cannot find it`);
          }
        }
        break;
      }
      case "subgraph.completed": {
        const child = str(p["childRunId"]);
        if (child === undefined) break;
        saw.add("subgraph.start-and-completion-pair");
        if (!childStarts.has(child)) {
          add("subgraph.start-and-completion-pair", seq, `subgraph.completed for "${child}" with no prior subgraph.started — a child nobody recorded starting`);
        }
        childStarts.delete(child);
        break;
      }
      case "state.reduced": {
        if (e.taskId !== undefined) reducedTasks.add(String(e.taskId));
        const before = str(p["stateHashBefore"]);
        const after = str(p["stateHashAfter"]);
        if (before !== undefined && after !== undefined) {
          saw.add("state.chain-is-unbroken");
          // EVERY REDUCTION STARTS WHERE THE LAST ONE FINISHED. `state.reduced` carries the hash
          // of the channel state either side of it, and a break means a write went missing
          // between them, or a second writer interleaved, or a reduction was computed against a
          // projection that had already moved. Fan-out safe, measured: two branches and a join
          // produce three reductions and no break, because a branch HOLDS its writes until the
          // join folds them.
          if (lastAfter !== undefined && lastAfter !== before) {
            add("state.chain-is-unbroken", seq, `this reduction starts at ${before.slice(0, 20)}… but the last one ended at ${lastAfter.slice(0, 20)}…`);
          }
          lastAfter = after;
        }
        break;
      }
      case "policy.escalated": {
        const from = str(p["from"]);
        const to = str(p["to"]);
        const scope = str(p["scope"]);
        if (from === undefined || to === undefined || scope === undefined) break;
        saw.add("policy.escalation-only-raises");
        // `PolicyEngine.escalate` computes `max(from, to)` and returns WITHOUT firing when that
        // equals `from`, so a journalled escalation strictly raises by construction. An event
        // that does not is a posture lowered through the tightening door — invariant 5 inverted.
        const a = POSTURE_RANK[from];
        const b = POSTURE_RANK[to];
        if (a === undefined || b === undefined) {
          add("policy.escalation-only-raises", seq, `escalation names a posture that is not out/on/in: ${from} -> ${to}`);
        } else if (b <= a) {
          add("policy.escalation-only-raises", seq, `escalation went ${from} -> ${to} in scope "${scope}", which does not raise`);
        }
        // And they CHAIN per scope: `from` is that scope's current value, so a later escalation
        // starting somewhere other than where the last one ended means a second writer.
        const prev = escalatedTo.get(scope);
        if (prev !== undefined && prev !== from) {
          add("policy.escalation-only-raises", seq, `scope "${scope}" was last escalated to "${prev}" but this one starts from "${from}"`);
        }
        escalatedTo.set(scope, to);
        break;
      }
      case "hook.applied": {
        const ref = str(p["ref"]);
        const point = str(p["point"]);
        if (ref === undefined || point === undefined || opts.hookRefs === undefined) break;
        saw.add("hook.applied-ref-is-declared");
        // AN EXTENSION THAT WAS NOT INSTALLED CHANGED SOMETHING. Hooks are pinned resources named
        // by the graph, so a `hook.applied` naming a ref the graph never declared at that point
        // is an extension that reached the run some other way.
        if (!(opts.hookRefs[point] ?? []).includes(ref)) {
          add("hook.applied-ref-is-declared", seq, `hook "${ref}" changed a value at ${point}, and the graph declares no such hook there`);
        }
        break;
      }
      case "policy.decided":
        if (e.taskId !== undefined) decidedTasks.add(String(e.taskId));
        break;
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
        if (e.taskId !== undefined) {
          leased.add(String(e.taskId));
          openLeases.set(String(e.taskId), seq);
        }
        break;
      }
      case "task.failed":
        if (e.taskId !== undefined) openLeases.delete(String(e.taskId));
        break;
      case "run.submitted":
        submissions.push(seq);
        break;
      case "gate.raised": {
        const id = str(p["gateId"]);
        // THE OTHER HALF OF THE OVERSIGHT RECORD. A gate is the output of the guard chain, and
        // `policy.decided` is the input that produced it — the reasons, the posture, the class.
        // A gate raised for a task that never had a decision is a gate manufactured OUTSIDE the
        // chain, which is the one thing the chain being single (invariant 6) is supposed to make
        // impossible. Keyed on the TASK rather than on the effect being `gate`, because a mirror
        // gate is raised from `#runSubgraph` for a task whose own decision was `allow`.
        if (e.taskId !== undefined) {
          saw.add("gate.raise-has-a-decision");
          if (!decidedTasks.has(String(e.taskId))) {
            add("gate.raise-has-a-decision", seq, `gate "${id ?? "?"}" was raised for task "${String(e.taskId)}" with no prior policy.decided`);
          }
        }
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
      case "task.cancelled": {
        // A CANCEL STOPS WORK; IT DOES NOT UNDO WORK THAT LANDED. `Engine.#cancelTree` skips
        // Tasks already in a terminal state for exactly this reason — re-ending a Task that
        // committed would erase work that really happened, which is a worse lie in the read
        // model than the stranded `leased` this event exists to fix (REGISTER E6).
        //
        // The rule exists because the EVENT is new. It was in `NEVER_APPENDED` until the E6
        // fix, so nothing here had anything to constrain; the moment it gained an appender the
        // coverage guard asked for a rule, and the `todo` ratchet refused to let it be deferred.
        const tid = e.taskId === undefined ? undefined : String(e.taskId);
        if (tid === undefined) break;
        saw.add("task.cancelled-not-after-commit");
        // AND IT RESOLVES THE LEASE, which `task.failed` one arm below has always done. Adding
        // the event without this made `task.leased-is-resolved` fire on the very shape the E6
        // fix produces — a Task leased, then cancelled — so the fix for one rule's blind spot
        // would have created another's false positive. Found by the fixture this rule needed,
        // which is the argument for the fixture gate: a new event type has to be taught to every
        // rule that tracks the thing it ends, not only to the rule it was added for.
        openLeases.delete(tid);
        const committedAt = commits.get(tid);
        if (committedAt !== undefined) {
          add("task.cancelled-not-after-commit", seq, `task "${tid}" was cancelled after committing at seq ${String(committedAt)} — a cancel must not un-land work`);
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
        openLeases.delete(tid);
        // A ROOT-BRANCH task reduces its writes immediately; one inside a fan-out holds them
        // until its join, which is why this asks only about `root`.
        const wrote = Object.keys((p["writes"] ?? {}) as Record<string, unknown>);
        const at = tid.indexOf("@");
        const hash = tid.lastIndexOf("#");
        const branch = at < 0 || hash < at ? "" : tid.slice(at + 1, hash);
        if (wrote.length > 0 && branch === "root") rootWriters.set(tid, { seq, channels: wrote.join(", ") });
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

  for (const [tid, w] of rootWriters) {
    saw.add("state.root-writes-are-reduced");
    if (!reducedTasks.has(tid)) {
      add("state.root-writes-are-reduced", w.seq, `root-branch task "${tid}" committed writes (${w.channels}) that no state.reduced ever applied`);
    }
  }

  if (completed) {
    // A LEASE THE RUN NEVER RESOLVED. `#advanceSerially` leases only tasks in state `ready`, so
    // a task left `leased` on a run that COMPLETED is work the run reported as done and never
    // did. Reproduced: a rewind whose checkpoint sat between a task's lease and its commit
    // suppressed the commit and left the lease, and the run re-completed with its output channel
    // back at the INPUT value — `succeeded`, having done nothing.
    //
    // `run.completed` only: a cancelled or failed run legitimately abandons an in-flight lease.
    // EVIDENCE IS "a lease existed and the run completed", not "a violation was found". Recording
    // it inside the loop below made a clean run report the rule as never checked — which is the
    // distinction this report exists to keep.
    if (leased.size > 0) saw.add("task.leased-is-resolved");
    for (const [tid, seq] of openLeases) {
      add("task.leased-is-resolved", seq, `task "${tid}" was leased and the run completed without committing or failing it`);
    }
    for (const [child, seq] of childStarts) {
      saw.add("subgraph.start-and-completion-pair");
      add("subgraph.start-and-completion-pair", seq, `subgraph "${child}" started and the parent completed without recording its end`);
    }
    for (const [gateId, seq] of openGates) {
      add("gate.raised-is-resolved", seq, `gate "${gateId}" was raised and the run completed without resolving it`);
    }
  } else {
    // THE SAME PRECONDITION GUARDS THREE RULES, AND ONLY ONE HAD ITS REASON WRITTEN.
    //
    // `if (completed)` is what makes all three inapplicable to a run that failed or was
    // cancelled, and the gate rule got a sentence saying so while its two siblings fell through
    // to the default — "no event this rule constrains appears in this journal" — on journals that
    // plainly contain `task.leased` and `subgraph.started`. Measured through `bin/loom audit` on a
    // run whose seq 5 IS `task.leased`.
    //
    // **A report that explains an omission with a false reason is worse than one that says
    // nothing**, because the false reason is checkable and answers the operator's next question
    // wrongly: they go looking for a missing event instead of reading the run's status. And of
    // the three, `task.leased-is-resolved` is the one that matters most — it is the rule that
    // catches a stranded lease, which is register defect D2, a run that reported success having
    // undone its own work.
    if (saw.has("gate.raised-is-resolved")) {
      unrunnable.set("gate.raised-is-resolved", "the run did not complete; an open or abandoned gate is legal on a failed, cancelled or live run");
      saw.delete("gate.raised-is-resolved");
    }
    if (leased.size > 0) {
      unrunnable.set("task.leased-is-resolved", "the run did not complete; a lease left open by a failed, cancelled or live run is abandoned on purpose");
    }
    if (childStarts.size > 0) {
      unrunnable.set(
        "subgraph.start-and-completion-pair",
        "the run did not complete; a child whose end the parent never recorded is legitimate on a failed, cancelled or live run",
      );
    }
  }
  if (opts.hookRefs === undefined) {
    unrunnable.set("hook.applied-ref-is-declared", "no hookRefs supplied: the graph's declared hooks are not in the journal, only the refs that fired");
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
