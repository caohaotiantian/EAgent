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
 * THE VERDICT IS OVER TWO QUESTIONS, not one: did the projections agree, and was the
 * recording actually consumed? The second is not implied by the first — a recorded result
 * nobody asks for moves no channel — so `unservedEffects` counts against `match` rather
 * than being reported beside it. See `ReplayReport.match`.
 *
 * WHAT CANNOT BE REPLAYED FAITHFULLY is documented in D9.5 and is honest: secrets
 * (never journaled, so re-resolved), redacted fields (serve a token), forked runs
 * with modified inputs (they re-execute for real), and effects whose outcome was
 * never recorded because the process died mid-call.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.5.
 */

import { digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { GateId, RunId, TaskId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import { MemoryStateStore } from "../journal/memory.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import { Engine, type EngineOptions } from "./engine.ts";
import { foldRun, type GateRecord, type RunProjection } from "./projection.ts";

export interface RecordedEffect {
  readonly key: string;
  readonly result: unknown;
  /**
   * `digest(result)` as the recording computed it. `require` compares it; nothing else
   * does anything with it beyond copying it out of the event.
   *
   * It was written at four sites in `engine.ts` and compared nowhere: a durable field
   * whose NAME asserted a property nothing verified. Kept rather than deleted because the
   * check it enables is the journal's only defense against a substituted result, and
   * deleting it would have been a change to the durable event vocabulary
   * (`journal/events.ts`) plus its four writers — see `require` for what a mismatch means
   * and what it cannot see.
   */
  readonly resultDigest: string;
}

/**
 * Effect KINDS whose recorded digest is known not to be a digest of `result`.
 *
 * `#runSubgraph` in `engine.ts` (`:2191` when this was written) journals
 * `result: {writes}` alongside `resultDigest: digest(writes)`, so the recorded digest
 * addresses a sub-object of the result and a strict comparison refuses every subgraph
 * replay. This is a narrowed CLAIM, not a weakened check: the comparison is exact for
 * every kind not listed, and nothing here tries to guess which encoding a mismatch meant.
 *
 * The exemption is pinned by a test that re-derives the disagreement from a real subgraph
 * run rather than by this sentence ("THE SUBGRAPH SITE STILL DOES NOT DIGEST ITS RESULT",
 * `test/run/replay.test.ts`), so fixing `engine.ts` turns that test red with the
 * instruction to delete this set. A prose reason nobody re-executes is how this repo grew
 * four of the claims this file is being repaired for.
 */
const DIGEST_NOT_OVER_RESULT: ReadonlySet<string> = new Set(["subgraph"]);

/** The `kind` of `taskId:kind:ordinal`. Empty when the key is not in that shape. */
function kindOf(key: string): string {
  const last = key.lastIndexOf(":");
  if (last <= 0) return "";
  const prev = key.lastIndexOf(":", last - 1);
  return prev < 0 ? "" : key.slice(prev + 1, last);
}

/** The `taskId` of `taskId:kind:ordinal`, for a frame a human has to place. */
function taskOf(key: string): string | undefined {
  const last = key.lastIndexOf(":");
  if (last <= 0) return undefined;
  const prev = key.lastIndexOf(":", last - 1);
  return prev <= 0 ? undefined : key.slice(0, prev);
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

  /**
   * Throws `E_REPLAY_DIVERGENCE` rather than falling back to a live call.
   *
   * THE RESULT IS CHECKED AGAINST THE DIGEST RECORDED WITH IT, which makes exactly one
   * claim: the bytes being served are the bytes the engine hashed when it wrote them. Two
   * things produce a mismatch, and they are told apart by looking at the journal rather
   * than by this code guessing:
   *
   *   - THE JOURNAL WAS EDITED UNDER THE REPLAY. A row rewritten by hand, a restore that
   *     spliced results from another run, a store that corrupted a payload. The digest is
   *     the only thing that notices, because a wrong tool result reaches the agent's
   *     transcript and the model turn that would react to it is served from the journal
   *     too — so the replay still reaches the recorded end state and `compare` still
   *     reports every frame green.
   *   - CANONICALIZATION CHANGED. `canonical.ts` decides these bytes; a change to key
   *     ordering, number formatting or what it refuses re-addresses every result ever
   *     recorded. That is a migration, and it should be loud on the first replay rather
   *     than silently redefine what a recorded run was.
   *
   * WHAT IT DOES NOT CLAIM: the digest is over the RESULT only. It says nothing about
   * which call produced it (`reboundEffects`), about arguments (there is no input digest —
   * see `reboundEffects`' docstring), or about a journal rewritten CONSISTENTLY, digest
   * included, by anyone who can run `digest`. It is an integrity check against edits and
   * drift, never an authenticity check against an adversary; the journal is not signed.
   *
   * COST is one `canonicalize` + sha256 per served effect, on the replay path only — live
   * runs never enter this class. It is linear in the size of the recorded result, so a run
   * whose results are large pays proportionally, and it pays it once per replay.
   */
  require(key: string): RecordedEffect {
    const hit = this.#completed.get(key);
    if (hit !== undefined) {
      this.#served.add(key);
      if (!DIGEST_NOT_OVER_RESULT.has(kindOf(key))) {
        const computed = digest(hit.result);
        if (computed !== hit.resultDigest) {
          throw err.internal(
            CODES.E_REPLAY_DIVERGENCE,
            `effect "${key}" no longer hashes to its recorded digest — the journal was edited under this replay, or canonicalization changed`,
            { details: { key, recorded: hit.resultDigest, computed } },
          );
        }
      }
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
  readonly kind:
    | "state.reduced"
    | "task.committed"
    | "run.completed"
    | "run.failed"
    | "graph.bound"
    | "effect.rebound"
    | "effect.unserved";
  readonly taskId?: string;
  readonly match: boolean;
  readonly expected?: string;
  readonly actual?: string;
}

export interface ReplayReport {
  readonly runId: RunId;
  readonly replayRunId: RunId;
  /**
   * The verdict — every frame agreed, INCLUDING one frame per recorded effect the replay
   * never asked for.
   *
   * Folded into `match` rather than reported as a separate `complete` flag, and the
   * argument is about readers. `match` is the field consumers act on: `cli.ts` returns it
   * as a process exit code, and `evolution/gate.ts` reads it for
   * `EvalCase.expect.identicalToRecording`, which decides whether a candidate is
   * promotable. A new field would have had no reader on the day it landed — the exact
   * shape being repaired one type up in this file, where `resultDigest` sat written and
   * unread — and making it load-bearing means editing the consumers, so the choice was
   * between one honest verdict and a second field that certifies nothing until somebody
   * else wires it.
   *
   * The narrower reading was available — "`match` means the compared frames agreed;
   * completeness is a separate question" — and it is what the code did. It is wrong here
   * because the frames CANNOT SEE this class. An agent's tool result reaches the
   * transcript only, and the model turn that would react to it is itself served from the
   * journal, so a recorded result nobody fetches moves no channel and changes no task
   * state. A green `compare` over a replay that skipped two recorded calls is not evidence
   * of agreement; it is the absence of evidence, reported as agreement to the one field
   * that gets acted on.
   */
  readonly match: boolean;
  readonly frames: readonly ReplayFrame[];
  readonly original: RunProjection;
  readonly replayed: RunProjection;
  /**
   * Recorded effects the replay never asked for.
   *
   * Non-empty means this replay did not make a call the recording made — because the
   * GRAPH changed, or because the code walking it did. Both are divergences and both
   * count against `match`; which one it was is answered by `graph.match` beside it.
   */
  readonly unservedEffects: readonly string[];
  readonly hermetic: boolean;
  /**
   * The graph the journal was produced by, against the graph this replay ran.
   *
   * Reported whatever `onGraphChange` says, including under `"allow"`: opting out changes
   * the VERDICT, never the record. A caller that suppressed the frame can still see, and
   * journal, that it replayed a candidate.
   */
  readonly graph: {
    readonly recorded: string;
    readonly replayed: string;
    readonly match: boolean;
  };
  /**
   * Effect keys where the recording and the replay made DIFFERENT CALLS.
   *
   * An effect key is `taskId:kind:ordinal` and says nothing about the call it names, so
   * the same key in two graphs can be two different tools. Each entry is a recorded result
   * that was handed to a call other than the one that produced it.
   */
  readonly reboundEffects: readonly {
    readonly key: string;
    readonly field: "tool" | "model";
    readonly recorded: string;
    readonly replayed: string;
  }[];
}

export interface ReplayOptions {
  readonly store: StateStore;
  readonly runId: RunId;
  readonly graph: RunGraph;
  /** Everything the live engine had except the store: tools, functions, models. */
  readonly engine: Omit<EngineOptions, "store" | "bus">;
  /** Auto-answer gates with what the human actually decided. Default true. */
  readonly replayGates?: boolean;
  /**
   * What to do when `graph` is not the graph the journal came out of.
   *
   * `"diverge"` (default) runs the replay and reports `match: false` with a `graph.bound`
   * frame. `"throw"` refuses before serving a single result. `"allow"` runs and does not
   * count the change against `match`.
   *
   * THE OPT-OUT IS NAMED RATHER THAN DEFAULTED, and the asymmetry is deliberate. Replaying
   * against a different graph is a real thing to want — it is `runEvalSuite`'s entire job —
   * but it is a thing a caller has to SAY, because the caller that does it by accident is
   * the one this option exists for. `"diverge"` was chosen over `"throw"` as the default
   * for the same reason `identicalToRecording` is off in `EvalCase`: a candidate graph
   * still has to produce a report to be judged against, and a throw at the door would make
   * the eval gate unreachable without every call site being edited first.
   */
  readonly onGraphChange?: "diverge" | "throw" | "allow";
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

  // The SUBMITTED hash, not `original.graphHash`. The projection's field folds
  // `graph.mutated` too, so on a run that rewrote itself mid-flight it holds the FINAL
  // hash — while `opts.graph` is the graph a replay starts from and the engine re-applies
  // the recorded mutations to it. Comparing against the fold would make every
  // self-modifying run look like a tampered one.
  const recordedGraph = submitted !== undefined && isEvent(submitted, "run.submitted") ? submitted.payload.graphHash : "";
  // An empty recorded hash means the journal has no `run.submitted` to bind to — a
  // fragment, or a fixture assembled by hand. Nothing to compare, so nothing is claimed.
  // THE HASH IS OVER THE SPEC, AND THE SPEC IS FULL OF POINTERS.
  //
  // `graphHash = digest(spec)` covers the ref `prompt/summarize-file@stable`, never the
  // bytes it resolves to — and re-pointing a `@stable` channel is exactly how one Loom
  // graph normally differs from another, because `resource:promote` moves the pointer
  // without touching the spec. So a run whose prompt, agent profile, function body and
  // oversight spec ALL changed replayed green on an identical hash. The compile already
  // journals what each ref resolved to; binding it costs a comparison.
  const compiled = events.find((e) => isEvent(e, "run.compiled"));
  const recordedRefs = compiled !== undefined && isEvent(compiled, "run.compiled") ? compiled.payload.resolutionManifest : [];
  const refKey = (m: readonly { ref: string; digest: string }[]): string =>
    m
      .map((r) => `${r.ref}=${r.digest}`)
      .sort()
      .join("\n");
  const recordedManifest = refKey(recordedRefs);
  const replayedManifest = refKey(opts.graph.resolutionManifest);
  const refsBound = recordedManifest === "" || recordedManifest === replayedManifest;

  const graphBound = (recordedGraph === "" || recordedGraph === opts.graph.graphHash) && refsBound;
  if (!graphBound && opts.onGraphChange === "throw") {
    const what = recordedGraph !== "" && recordedGraph !== opts.graph.graphHash ? "graph" : "resolved resources";
    throw err.internal(
      CODES.E_REPLAY_DIVERGENCE,
      `run ${opts.runId} recorded ${what} ${recordedGraph}, but this replay was handed ${opts.graph.graphHash} — its recorded results were produced by a different ${what}`,
      {
        details: {
          recorded: recordedGraph,
          replayed: opts.graph.graphHash,
          ...(refsBound ? {} : { recordedManifest, replayedManifest }),
        },
      },
    );
  }

  const shadow = new MemoryStateStore({ now: opts.engine.now ?? (() => original.startedAt) });
  const engine = new Engine({ ...opts.engine, store: shadow, replay: effects });

  const replayRunId = await engine.submit({ graph: opts.graph, inputs });
  let replayed = await engine.advance(replayRunId);

  // Serve recorded human decisions the same way effects are served: a gate's answer
  // is an input from the world, not a decision the replay gets to re-make.
  //
  // BOTH PICKS ARE BY TaskId AND JOURNAL ORDER, NOT BY ENUMERATION ORDER. This loop used to
  // take the first `open` gate `Object.values` happened to yield and then match a recorded
  // one on `nodeId` ALONE. A node that gates ONCE has one of each and the two agree by
  // luck; a `human_gate` inside a bounded loop has one gate per ITERATION on the same
  // `nodeId`, so every iteration was served the FIRST recorded decision — a rejection on
  // iteration 2 replayed as iteration 1's approval, and nothing said so. `compare` still
  // reports `match: false`, which is the quiet part: the divergence is blamed on task
  // states and channels rather than on the harness having answered the wrong question, and
  // the D10 promotion gate reads that verdict.
  //
  // `TaskId` is derived (`nodeId@branchPath#iteration`), so it is stable across the two
  // runIds and is exactly the coordinate that distinguishes iterations. `served` keeps a
  // gate from being consumed twice when one Task gates more than once.
  if (opts.replayGates !== false) {
    const served = new Set<GateId>();
    for (let guard = 0; guard < 32 && replayed.status === "awaiting_gate"; guard++) {
      const open = oldestOpen(replayed);
      if (open === undefined) break;
      const recorded = firstUnservedDecision(original, open.taskId, served);
      if (recorded === undefined) {
        throw err.internal(
          CODES.E_REPLAY_DIVERGENCE,
          `replay raised a gate on node "${open.nodeId}" (task "${open.taskId}") that the recorded run never decided`,
        );
      }
      served.add(recorded.gateId);
      replayed = await engine.resolveGate(replayRunId, {
        gateId: open.gateId,
        decision: decisionOf(recorded),
        actor: { kind: "system", component: "replay" },
        idempotencyKey: `replay:${open.gateId}`,
      });
    }
  }

  const replayedEvents: JournalEvent[] = [];
  for await (const e of shadow.read(replayRunId, 1)) replayedEvents.push(e);
  const rebound = reboundEffects(events, replayedEvents);

  const frames = compare(original, replayed);
  // Appended after `compare`, so the frame seq numbers of the three original kinds are
  // untouched by whether a binding held.
  let seq = frames.length;
  if (!graphBound && opts.onGraphChange !== "allow") {
    frames.push({ seq: seq++, kind: "graph.bound", match: false, expected: recordedGraph, actual: opts.graph.graphHash });
  }
  for (const r of rebound) {
    frames.push({ seq: seq++, kind: "effect.rebound", match: false, expected: r.recorded, actual: r.replayed });
  }
  // A FRAME PER UNSERVED EFFECT, not one boolean, because `loom replay` prints the frames
  // that did not match and "the replay never asked for this" is useless without the key.
  // Unconditional, including under `onGraphChange: "allow"`: that opt-out is a statement
  // about which GRAPH may run, and this is the narrower fact that survives it — whatever
  // graph ran, it did not consume what the recording produced.
  const unserved = effects.unserved;
  for (const key of unserved) {
    const taskId = taskOf(key);
    frames.push({
      seq: seq++,
      kind: "effect.unserved",
      ...(taskId === undefined ? {} : { taskId }),
      match: false,
      expected: key,
      actual: "(never requested)",
    });
  }

  return {
    runId: opts.runId,
    replayRunId,
    match: frames.every((f) => f.match),
    frames,
    original,
    replayed,
    unservedEffects: unserved,
    // Non-hermetic when the recorded run had effects with no outcome: replay cannot
    // invent what the world did while the process was dying.
    hermetic: effects.unknownOutcomes.length === 0,
    graph: { recorded: recordedGraph, replayed: opts.graph.graphHash, match: graphBound },
    reboundEffects: rebound,
  };
}

/**
 * Effect keys where the recording and the replay made different CALLS.
 *
 * THIS IS THE HALF THAT SURVIVES A LEGITIMATE GRAPH CHANGE. The hash check answers "is
 * this the same graph?", which is the wrong question to ask `runEvalSuite` — a candidate
 * is a different graph by definition. This one asks the narrower question that stays
 * meaningful there: whatever else moved, was each recorded result handed back to the call
 * that produced it? A candidate that swaps `fs.write` for `fs.append` at the same node
 * keeps the effect key `write@root#0:tool:0`, so it is served the recorded `fs.write`
 * result and, before this, nothing anywhere said so.
 *
 * Derived from the two journals rather than checked at serve time, because that is what is
 * possible from here: the journal records a call's TYPE SHAPE and never its argument
 * VALUES (`tool.called.argsShape`, and see the comment there for why), and there is no
 * per-effect input digest for `ReplayEffects.require` to compare against. So this catches
 * a different tool, a different tool version, a different argument SHAPE, and a different
 * model — and does NOT catch the same call with a different argument VALUE. That last one
 * is caught today by the graph hash, and only by it, which means it is not caught at all
 * under `onGraphChange: "allow"`. Closing it needs an `inputDigest` on `effect.started`,
 * written where the effect is journaled and compared in `require`.
 *
 * Joined on the intersection of keys. Recorded-and-never-asked-for is already
 * `unservedEffects`; asked-for-and-never-recorded is `E_REPLAY_DIVERGENCE` at serve time.
 */
function reboundEffects(
  recorded: readonly JournalEvent[],
  replayed: readonly JournalEvent[],
): ReplayReport["reboundEffects"] {
  const index = (events: readonly JournalEvent[]): Map<string, { field: "tool" | "model"; call: string }> => {
    const out = new Map<string, { field: "tool" | "model"; call: string }>();
    for (const e of events) {
      if (isEvent(e, "tool.called")) {
        out.set(e.payload.key, { field: "tool", call: `${e.payload.name}@${e.payload.version}(${e.payload.argsShape})` });
      } else if (isEvent(e, "model.called")) {
        // The MODEL, and deliberately not the provider. A replay reaches no adapter, so
        // it journals `provider: "replay"` — a fact about the replay, not about the call,
        // and comparing it would make every model effect in every replay look rebound.
        out.set(e.payload.key, { field: "model", call: e.payload.model });
      }
    }
    return out;
  };

  const before = index(recorded);
  const after = index(replayed);
  const out: { key: string; field: "tool" | "model"; recorded: string; replayed: string }[] = [];
  for (const [key, a] of before) {
    const b = after.get(key);
    if (b === undefined || b.call === a.call) continue;
    out.push({ key, field: a.field, recorded: a.call, replayed: b.call });
  }
  return out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

/**
 * The open gate this run has been waiting on longest, by JOURNAL order.
 *
 * The twin of `oldestOpenGate` in `run/engine.ts`, and duplicated rather than exported for
 * the reason that file's version gives: it is six lines of loop, and exporting it would put
 * a projection helper on the pinned public surface to save them.
 */
function oldestOpen(p: RunProjection): GateRecord | undefined {
  let oldest: GateRecord | undefined;
  for (const g of Object.values(p.gates)) {
    if (g.state !== "open") continue;
    if (oldest === undefined || g.raisedAtSeq < oldest.raisedAtSeq) oldest = g;
  }
  return oldest;
}

/**
 * The earliest decision the recorded run made on THIS Task that this replay has not already
 * re-served.
 *
 * Earliest, not latest: a replay walks a run forward, so the answers come back in the order
 * they were given. `served` is what makes "not already" meaningful — without it a Task that
 * gates twice would be handed its first decision both times, which is the same defect as
 * the `nodeId` match one coordinate finer.
 */
function firstUnservedDecision(
  p: RunProjection,
  taskId: TaskId,
  served: ReadonlySet<GateId>,
): GateRecord | undefined {
  let best: GateRecord | undefined;
  for (const g of Object.values(p.gates)) {
    if (g.state !== "decided" || g.taskId !== taskId || served.has(g.gateId)) continue;
    if (best === undefined || g.raisedAtSeq < best.raisedAtSeq) best = g;
  }
  return best;
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
