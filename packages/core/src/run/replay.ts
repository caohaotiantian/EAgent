/**
 * Deterministic replay.
 *
 * Replay re-executes the graph with every effect served from the journal. It makes
 * NO network calls and produces NO side effects — a tool's `execute` is never
 * reached. If replay needs an effect the journal does not contain, that is
 * `E_REPLAY_DIVERGENCE`, a loud failure, never a silent live call.
 *
 * Three uses, one mechanism: debugging (step a run), regression evaluation (D10
 * replays a frozen suite against a candidate), and verification (CI replays fixtures
 * and asserts every `state.hash` matches — which is how a reducer regression is
 * caught).
 *
 * WHAT CANNOT BE REPLAYED FAITHFULLY is documented in D9.5 and is honest: secrets
 * (never journaled, so re-resolved), redacted fields (serve a token), forked runs
 * with modified inputs (they re-execute for real), and effects whose outcome was
 * never recorded because the process died mid-call.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.5.
 */

import { CODES, err } from "../errors.ts";
import type { RunId, TaskId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import { MemoryStateStore } from "../journal/memory.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { foldRun, type GateRecord, type RunProjection } from "./projection.ts";

export interface RecordedEffect {
  readonly key: string;
  readonly result: unknown;
  readonly resultDigest: string;
}

/**
 * An index of everything the world told this run, keyed by effect key.
 *
 * Effect keys are `taskId:kind:ordinal` and deliberately exclude the attempt number,
 * so a retry and a replay resolve to the same recorded value.
 */
export class ReplayEffects {
  readonly #completed = new Map<string, RecordedEffect>();
  readonly #failed = new Map<string, unknown>();
  /** Keys that started with no terminal record — the honest third outcome. */
  readonly #unknown = new Set<string>();
  readonly #served = new Set<string>();

  static fromEvents(events: Iterable<JournalEvent>): ReplayEffects {
    const r = new ReplayEffects();
    for (const e of events) {
      if (isEvent(e, "effect.started")) r.#unknown.add(e.payload.key);
      else if (isEvent(e, "effect.completed")) {
        r.#unknown.delete(e.payload.key);
        r.#completed.set(e.payload.key, {
          key: e.payload.key,
          result: e.payload.result,
          resultDigest: e.payload.resultDigest,
        });
      } else if (isEvent(e, "effect.failed")) {
        r.#unknown.delete(e.payload.key);
        r.#failed.set(e.payload.key, e.payload.error);
      }
    }
    return r;
  }

  static async fromStore(store: StateStore, runId: RunId): Promise<ReplayEffects> {
    const events: JournalEvent[] = [];
    for await (const e of store.read(runId, 1)) events.push(e);
    return ReplayEffects.fromEvents(events);
  }

  /** Throws `E_REPLAY_DIVERGENCE` rather than falling back to a live call. */
  require(key: string): RecordedEffect {
    const hit = this.#completed.get(key);
    if (hit !== undefined) {
      this.#served.add(key);
      return hit;
    }
    if (this.#failed.has(key)) {
      this.#served.add(key);
      throw err.internal(CODES.E_REPLAY_DIVERGENCE, `effect "${key}" failed in the recorded run`, {
        details: { key, recorded: this.#failed.get(key) },
      });
    }
    if (this.#unknown.has(key)) {
      throw err.internal(
        CODES.E_REPLAY_DIVERGENCE,
        `effect "${key}" started but never recorded an outcome — the original process died mid-call`,
        { details: { key, outcome: "unknown" } },
      );
    }
    throw err.internal(CODES.E_REPLAY_DIVERGENCE, `effect "${key}" is not in the journal`, { details: { key } });
  }

  has(key: string): boolean {
    return this.#completed.has(key) || this.#failed.has(key);
  }

  /** Recorded effects the replay never asked for — a divergence in the other direction. */
  get unserved(): readonly string[] {
    return [...this.#completed.keys()].filter((k) => !this.#served.has(k)).sort();
  }

  get unknownOutcomes(): readonly string[] {
    return [...this.#unknown].sort();
  }

  get size(): number {
    return this.#completed.size;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface ReplayFrame {
  readonly seq: number;
  readonly kind: "state.reduced" | "task.committed" | "run.completed" | "run.failed";
  readonly taskId?: string;
  readonly match: boolean;
  readonly expected?: string;
  readonly actual?: string;
}

export interface ReplayReport {
  readonly runId: RunId;
  readonly replayRunId: RunId;
  readonly match: boolean;
  readonly frames: readonly ReplayFrame[];
  readonly original: RunProjection;
  readonly replayed: RunProjection;
  /** Recorded effects the replay never consumed. Non-empty means the graph changed. */
  readonly unservedEffects: readonly string[];
  readonly hermetic: boolean;
}

export interface ReplayOptions {
  readonly store: StateStore;
  readonly runId: RunId;
  readonly graph: RunGraph;
  /** Everything the live engine had except the store: tools, functions, models. */
  readonly engine: Omit<EngineOptions, "store" | "bus">;
  /** Auto-answer gates with what the human actually decided. Default true. */
  readonly replayGates?: boolean;
}

/**
 * Re-execute a recorded run into a throwaway journal and compare.
 *
 * The replay writes to a fresh `MemoryStateStore`, so the original journal is never
 * touched — replay is a read of history, not an edit of it.
 */
export async function replayRun(opts: ReplayOptions): Promise<ReplayReport> {
  const original = await projectionOf(opts.store, opts.runId);
  if (original === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${opts.runId} has no journal`);

  const effects = await ReplayEffects.fromStore(opts.store, opts.runId);
  const events: JournalEvent[] = [];
  for await (const e of opts.store.read(opts.runId, 1)) events.push(e);

  const submitted = events.find((e) => isEvent(e, "run.submitted"));
  const inputs = submitted !== undefined && isEvent(submitted, "run.submitted") ? submitted.payload.inputs : {};

  const shadow = new MemoryStateStore({ now: opts.engine.now ?? (() => original.startedAt) });
  const engine = new Engine({ ...opts.engine, store: shadow, replay: effects });

  const replayRunId = await engine.submit({ graph: opts.graph, inputs });
  let replayed = await engine.advance(replayRunId);

  // Serve recorded human decisions the same way effects are served: a gate's answer
  // is an input from the world, not a decision the replay gets to re-make.
  if (opts.replayGates !== false) {
    for (let guard = 0; guard < 32 && replayed.status === "awaiting_gate"; guard++) {
      const open = Object.values(replayed.gates).find((g) => g.state === "open");
      if (open === undefined) break;
      const recorded = Object.values(original.gates).find((g) => g.nodeId === open.nodeId && g.state === "decided");
      if (recorded === undefined) {
        throw err.internal(
          CODES.E_REPLAY_DIVERGENCE,
          `replay raised a gate on node "${open.nodeId}" that the recorded run never decided`,
        );
      }
      replayed = await engine.resolveGate(replayRunId, {
        gateId: open.gateId,
        decision: decisionOf(recorded),
        actor: { kind: "system", component: "replay" },
        idempotencyKey: `replay:${open.gateId}`,
      });
    }
  }

  const frames = compare(original, replayed);
  return {
    runId: opts.runId,
    replayRunId,
    match: frames.every((f) => f.match),
    frames,
    original,
    replayed,
    unservedEffects: effects.unserved,
    // Non-hermetic when the recorded run had effects with no outcome: replay cannot
    // invent what the world did while the process was dying.
    hermetic: effects.unknownOutcomes.length === 0,
  };
}

/**
 * The recorded decision, re-served — or a DIVERGENCE, never an approval.
 *
 * The `default:` arm answered `{kind: "approve"}`, so a journal whose `gate.decided`
 * carried a word in no vocabulary — which `HumanGateBroker` used to append verbatim — was
 * replayed as a human having said yes. That is the same fail-open the broker itself had,
 * one layer in and harder to see: replay is what the D10 promotion gate and the CI state
 * hash are built on, so the wrong answer here is the one that certifies a candidate.
 *
 * `approve` is spelled out rather than left to fall through for the same reason: the
 * permissive reading has to be something a journal SAYS, not something it fails to say.
 */
function decisionOf(g: GateRecord): Parameters<Engine["resolveGate"]>[1]["decision"] {
  switch (g.decision) {
    case "approve":
      return { kind: "approve" };
    case "reject":
      return { kind: "reject", reason: g.justification ?? "recorded rejection" };
    case "edit":
      return { kind: "edit", writes: g.writes ?? {} };
    case "redirect":
      return { kind: "redirect", take: g.take ?? [] };
    default:
      throw err.internal(
        CODES.E_REPLAY_DIVERGENCE,
        `the recorded run decided gate "${g.gateId}" with ${JSON.stringify(g.decision)}, which is not a decision replay can re-serve`,
      );
  }
}

function compare(original: RunProjection, replayed: RunProjection): ReplayFrame[] {
  const frames: ReplayFrame[] = [];

  // Task-by-task: the same Task ids must reach the same terminal states. TaskIds are
  // derived, so this comparison is meaningful across two different runIds.
  const ids = new Set<TaskId>([
    ...(Object.keys(original.tasks) as TaskId[]),
    ...(Object.keys(replayed.tasks) as TaskId[]),
  ]);
  let seq = 0;
  for (const id of [...ids].sort()) {
    const a = original.tasks[id];
    const b = replayed.tasks[id];
    frames.push({
      seq: seq++,
      kind: "task.committed",
      taskId: id,
      match: a?.state === b?.state,
      expected: a?.state ?? "(absent)",
      actual: b?.state ?? "(absent)",
    });
  }

  frames.push({
    seq: seq++,
    kind: "state.reduced",
    match: canonicalEqual(original.channels, replayed.channels),
    expected: JSON.stringify(original.channels),
    actual: JSON.stringify(replayed.channels),
  });

  frames.push({
    seq: seq++,
    kind: original.status === "failed" ? "run.failed" : "run.completed",
    match: original.status === replayed.status,
    expected: original.status,
    actual: replayed.status,
  });

  return frames;
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

async function projectionOf(store: StateStore, runId: RunId): Promise<RunProjection | undefined> {
  const events: JournalEvent[] = [];
  for await (const e of store.read(runId, 1)) events.push(e);
  return foldRun(events);
}
