/**
 * Durable human gates.
 *
 * The single largest departure from EAgent, where an approval was a `Promise` held
 * by a running turn (`UI.confirm`). That promise could not survive a restart, could
 * not be routed anywhere, could not time out with a default action, and pinned the
 * agent's memory for its whole lifetime.
 *
 * Here a gate is a row plus a journal event. `raise` returns as soon as the gate is
 * PERSISTED — it does not wait for the human — and the Run suspends, releasing its
 * worker slot. So "how many gates can be open at once" is a database question, not a
 * concurrency question: ten thousand open gates cost ten thousand rows.
 *
 * See design/loom/04-OVERSIGHT.md D7.3–D7.4.
 */

import { digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import { newGateId, type GateId, type NodeId, type RunId, type TaskId } from "../ids.ts";
import { SYSTEM_ACTOR, type Actor } from "../journal/events.ts";
import { foldRun, openGates, type GateRecord, type RunProjection } from "./projection.ts";
import type { RunLog } from "./log.ts";

export type GateDecisionKind = "approve" | "reject" | "edit" | "redirect";

export type GateDecision =
  | { readonly kind: "approve" }
  | { readonly kind: "reject"; readonly reason: string }
  /** The highest-quality label the evolution loop ever gets (D10.b, signal S2). */
  | { readonly kind: "edit"; readonly writes: Readonly<Record<string, unknown>>; readonly reason?: string }
  | { readonly kind: "redirect"; readonly take: readonly string[]; readonly reason?: string };

export type TimeoutAction = "escalate" | "default_action" | "fail";

export interface GateRequest {
  readonly runId: RunId;
  readonly taskId: TaskId;
  readonly nodeId: NodeId;
  readonly policyRef: string;
  /** Rendered server-side, so `contentDigest` pins what the approver actually saw. */
  readonly payload: unknown;
  readonly approvers?: readonly string[];
  readonly slaMs?: number;
  readonly onTimeout?: TimeoutAction;
  /** Only permissible when the action is read_only or reversible_write (GRAPH014). */
  readonly defaultAction?: GateDecision;
  /** Channels an `edit` decision may write. Anything else is rejected. */
  readonly allowEdit?: readonly string[];
}

export interface GateSummary extends GateRecord {
  readonly runId: RunId;
  readonly payload: unknown;
  readonly slaMs: number | undefined;
  readonly deadline: number | undefined;
  readonly onTimeout: TimeoutAction;
  readonly approvers: readonly string[];
  readonly allowEdit: readonly string[] | undefined;
}

export interface ResolveInput {
  readonly gateId: GateId;
  readonly decision: GateDecision;
  readonly actor: Actor;
  readonly idempotencyKey: string;
}

export interface GateBrokerOptions {
  readonly now?: () => number;
}

/**
 * In-process gate broker over the journal.
 *
 * Its non-durable state is deliberately minimal: only the gate *payload* and delivery
 * metadata, which are re-derivable and not needed for correctness. Everything that
 * decides whether a run may proceed lives in the journal, so a restart loses nothing
 * a human cares about.
 */
export class HumanGateBroker {
  readonly #now: () => number;
  /** gateId → request. Rebuilt lazily from the journal on restart. */
  readonly #requests = new Map<GateId, GateRequest & { deadline: number | undefined }>();
  /** `(gateId, approverId)` → decision, so a double-click collapses to one decision. */
  readonly #idempotency = new Map<string, GateDecisionKind>();

  constructor(opts: GateBrokerOptions = {}) {
    this.#now = opts.now ?? Date.now;
  }

  /**
   * Persist the gate and suspend the run. Returns as soon as it is durable.
   *
   * The caller must NOT hold anything open waiting for this — that is the entire
   * point. The Task is re-leased later, by whichever worker picks it up after
   * `gate.decided`.
   */
  async raise(log: RunLog, req: GateRequest): Promise<GateId> {
    const gateId = newGateId(this.#now());
    const contentDigest = digest(req.payload);
    const deadline = req.slaMs === undefined ? undefined : this.#now() + req.slaMs;

    this.#requests.set(gateId, { ...req, deadline });

    // ONE append: the gate and the suspension are a single durable fact. A crash
    // between them would otherwise leave a run that is neither running nor gated.
    await log.append(
      [
        {
          type: "gate.raised",
          payload: { gateId, nodeId: req.nodeId, policyRef: req.policyRef, contentDigest },
          actor: SYSTEM_ACTOR("gate-broker"),
          taskId: req.taskId,
        },
        {
          type: "run.suspended",
          payload: { reason: "gate" },
          actor: SYSTEM_ACTOR("gate-broker"),
        },
      ],
      { taskId: req.taskId },
    );

    return gateId;
  }

  /**
   * Record a decision and resume the run. Idempotent per `(gateId, approver)`, so a
   * double-click, a webhook retry, and a channel retry all collapse to one decision.
   */
  async resolve(log: RunLog, input: ResolveInput): Promise<{ resolved: boolean }> {
    const p = await this.project(log);
    const gate = p?.gates[input.gateId];
    if (gate === undefined) {
      throw err.notFound(CODES.E_GATE_NOT_FOUND, `no gate "${input.gateId}" in run ${log.runId}`);
    }

    const idemKey = `${input.gateId}:${actorId(input.actor)}:${input.idempotencyKey}`;
    const already = this.#idempotency.get(idemKey);
    if (already !== undefined) return { resolved: false };

    if (gate.state !== "open") {
      throw err.conflict(
        CODES.E_GATE_ALREADY_RESOLVED,
        `gate "${input.gateId}" is ${gate.state}, not open`,
        { details: { gateId: input.gateId, state: gate.state } },
      );
    }

    const req = this.#requests.get(input.gateId);
    if (input.decision.kind === "edit" && req?.allowEdit !== undefined) {
      for (const channel of Object.keys(input.decision.writes)) {
        if (!req.allowEdit.includes(channel)) {
          throw err.policy(
            CODES.E_GATE_NOT_AUTHORIZED,
            `gate "${input.gateId}" does not permit editing channel "${channel}"`,
            { details: { channel, allowed: req.allowEdit } },
          );
        }
      }
    }
    if (input.decision.kind === "reject" && input.decision.reason.trim() === "") {
      throw err.validation(CODES.E_HUMAN_APPROVAL_REQUIRED, "a rejection requires a reason");
    }

    this.#idempotency.set(idemKey, input.decision.kind);

    await log.append(
      [
        {
          type: "gate.decided",
          payload: {
            gateId: input.gateId,
            decision: input.decision.kind,
            latencyMs: this.#now() - gate.raisedAtTs,
            ...(input.decision.kind === "edit" ? { writes: input.decision.writes } : {}),
            ...(input.decision.kind === "redirect" ? { take: input.decision.take } : {}),
            ...(justificationOf(input.decision) === undefined
              ? {}
              : { justification: justificationOf(input.decision)! }),
          },
          actor: input.actor,
          taskId: gate.taskId,
        },
        { type: "run.resumed", payload: { by: "gate" }, actor: input.actor },
      ],
      { taskId: gate.taskId },
    );

    return { resolved: true };
  }

  /**
   * Fire due timeouts. Driven by the scheduler tick locally, a delay queue when
   * distributed. Deadlines are absolute timestamps in the log, not in-memory timers,
   * so a deploy neither resets nor skips an SLA.
   */
  async sweepTimeouts(log: RunLog, now = this.#now()): Promise<readonly GateId[]> {
    const p = await this.project(log);
    if (p === undefined) return [];
    const fired: GateId[] = [];

    for (const gate of openGates(p)) {
      const req = this.#requests.get(gate.gateId);
      if (req?.deadline === undefined || now < req.deadline) continue;
      const action = req.onTimeout ?? "fail";

      // A timeout can never auto-approve an irreversible action: `defaultAction` is
      // rejected at compile time (GRAPH014) for those classes, so if one is present
      // here it has already been proven safe.
      if (action === "default_action" && req.defaultAction !== undefined) {
        await log.append([
          { type: "gate.timeout", payload: { gateId: gate.gateId, action }, actor: SYSTEM_ACTOR("gate-broker") },
        ]);
        await this.resolve(log, {
          gateId: gate.gateId,
          decision: req.defaultAction,
          actor: SYSTEM_ACTOR("gate-broker:timeout"),
          idempotencyKey: `timeout:${gate.gateId}`,
        });
      } else {
        await log.append([
          { type: "gate.timeout", payload: { gateId: gate.gateId, action }, actor: SYSTEM_ACTOR("gate-broker") },
          ...(action === "fail"
            ? ([
                {
                  type: "run.failed" as const,
                  payload: {
                    error: {
                      class: "timeout",
                      code: CODES.E_GATE_EXPIRED,
                      message: `gate "${gate.gateId}" expired with no decision`,
                      retryable: false,
                    },
                  },
                  actor: SYSTEM_ACTOR("gate-broker"),
                },
              ] as const)
            : []),
        ]);
      }
      fired.push(gate.gateId);
    }
    return fired;
  }

  /** Open gates for a run, joined with their (non-durable) payload where available. */
  async list(log: RunLog): Promise<readonly GateSummary[]> {
    const p = await this.project(log);
    if (p === undefined) return [];
    return openGates(p).map((g) => {
      const req = this.#requests.get(g.gateId);
      return {
        ...g,
        runId: log.runId,
        payload: req?.payload,
        slaMs: req?.slaMs,
        deadline: req?.deadline,
        onTimeout: req?.onTimeout ?? "fail",
        approvers: req?.approvers ?? [],
        allowEdit: req?.allowEdit,
      };
    });
  }

  /**
   * Re-attach payloads after a restart.
   *
   * The gate itself survives without this — the run stays suspended and the decision
   * still applies. What is lost is the rendered payload, which is a UI concern: the
   * console re-renders it from the pinned prompt and the projection.
   */
  rehydrate(gateId: GateId, req: GateRequest): void {
    this.#requests.set(gateId, { ...req, deadline: req.slaMs === undefined ? undefined : this.#now() + req.slaMs });
  }

  async project(log: RunLog): Promise<RunProjection | undefined> {
    const events = [];
    for await (const e of log.read(1)) events.push(e);
    return foldRun(events);
  }
}

function actorId(a: Actor): string {
  switch (a.kind) {
    case "human":
      return a.subject;
    case "agent":
      return a.profile;
    case "system":
      return a.component;
    case "evolution":
      return a.candidate;
  }
}

function justificationOf(d: GateDecision): string | undefined {
  if (d.kind === "reject") return d.reason;
  if (d.kind === "edit" || d.kind === "redirect") return d.reason;
  return undefined;
}
