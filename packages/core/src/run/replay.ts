/**
 * Deterministic replay.
 *
 * Replay re-executes the graph with every RECORDED effect served from the journal — the four
 * kinds `model`, `tool`, `subgraph` and `summarize`. It makes no network calls and no tool's
 * `execute` is ever reached; an effect the journal does not contain is `E_REPLAY_DIVERGENCE`, a
 * loud failure rather than a quiet live call.
 *
 * IT IS NOT SIDE-EFFECT-FREE, and this said it was. `function` and `evaluator{assertion}` bodies
 * compute no effect key, never consult `ReplayEffects`, and RE-EXECUTE. On the CLI path that is
 * narrow — the `vm` context cannot reach `process` or `fetch` — but `SAFE_GLOBALS` leaves
 * `Math.random()` reachable while deliberately removing `Date`, so a body using it diverges.
 * Measured through the binary: `✗ state.reduced : expected {"out":"0.534…"}, got {"out":"0.108…"}`,
 * `match: false`. Replay REPORTS that rather than serving a wrong answer. An embedder passing
 * `opts.globals`, or registering a body directly on `FunctionRegistry`, gets a genuine live side
 * effect. See `design/loom/HANDOFF.md` B11. If replay needs an effect the journal does not contain, that is
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
import { effectKey, type GateId, type RunId, type TaskId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import { MemoryStateStore } from "../journal/memory.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { Posture } from "../vocab.ts";
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

  /** Did the replay serve this key from the record, rather than re-deriving it? */
  wasServed(key: string): boolean {
    return this.#served.has(key);
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
    | "gate.decided"
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
  /**
   * No RECORDED effect had an unrecorded outcome.
   *
   * NOT "nothing ran live", which is how it reads and how it was read. `function` and
   * assertion bodies compute no effect key, so they never appear in `unknownOutcomes` and
   * `hermetic` stays true while they re-execute — measured alongside `match: false` on a body
   * calling `Math.random()`. See this module's header.
   */
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

/**
 * The refs whose pinned digest differs between two manifests, as `ref (was … now …)`.
 *
 * The whole manifest is the wrong thing to print: a run pinning forty resources and one moved
 * prompt should name the prompt. Absent and added refs are named too — a ref the replay resolves
 * and the run did not is as much a difference as one whose bytes moved.
 */
function short(digest: string): string {
  return digest === "(absent)" || digest === "(added)" ? digest : `${digest.slice(0, 17)}…`;
}

function describeRefDrift(
  recorded: readonly { readonly ref: string; readonly digest: string }[],
  replayed: readonly { readonly ref: string; readonly digest: string }[],
): { ref: string; was: string; now: string }[] {
  const was = new Map(recorded.map((r) => [r.ref, r.digest] as const));
  const now = new Map(replayed.map((r) => [r.ref, r.digest] as const));
  const out: { ref: string; was: string; now: string }[] = [];
  for (const [ref, digest] of was) {
    const current = now.get(ref);
    if (current === undefined) out.push({ ref, was: digest, now: "(absent)" });
    else if (current !== digest) out.push({ ref, was: digest, now: current });
  }
  for (const [ref, digest] of now) if (!was.has(ref)) out.push({ ref, was: "(added)", now: digest });
  return out;
}

export interface ReplayOptions {
  readonly store: StateStore;
  readonly runId: RunId;
  readonly graph: RunGraph;
  /**
   * Everything the live engine had except the store: tools, functions, models.
   *
   * NOT the gate broker, and that is a refusal rather than an omission. `sweepTimeouts` is the
   * code that DELIVERS — it escalates tiers and calls the dispatcher — and a replay sweeps now,
   * so a caller handing this their production engine options would hand the shadow run their
   * channels and page real people about a run that ended days ago. Excluded in the type so the
   * ordinary caller cannot, and stripped again at construction for the one who casts.
   */
  readonly engine: Omit<EngineOptions, "store" | "bus" | "gates">;
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
  // THE SHADOW GETS ITS OWN BROKER, always. `Engine` builds one when none is supplied, and that
  // is what a replay must have: a broker carries a dispatcher, and `sweepTimeouts` — which this
  // function now calls, to re-derive a run that ended on an expired gate — is the code that
  // delivers. Measured against the worst input a caller can construct: with a live broker passed
  // through, replaying an expired gate paged the approver. The type refuses it; this refuses it
  // again for the caller who casts, because a rule enforced at each call site is not a rule.
  //
  // It also keeps the shadow's gates out of the caller's ephemeral map, which sharing a broker
  // would not.
  const engineOpts: Record<string, unknown> = { ...opts.engine };
  delete engineOpts["gates"];
  const engine = new Engine({ ...(engineOpts as Omit<EngineOptions, "store" | "bus">), store: shadow, replay: effects });

  // THE RECORDED PRINCIPAL COMES FORWARD, and without it every replay of a run whose graph
  // declares `separationOfDuties` DIVERGES: a shadow run with no initiator cannot resolve the
  // exclusion, so the raise refuses, the task fails, and `compare` reports `match: false` on a
  // run that was faithfully recorded. Measured both ways — it reports rather than throws, and
  // a quiet wrong answer is the failure mode this comment used to overstate as a loud one.
  // Note it is not the AUTHORIZATION that needs this — the replayer decides as a system actor
  // and the exclusion arm is humans-only — it is the RAISE. The shadow store is in-memory and
  // reachable by no control plane, so carrying the principal grants nothing.
  const submittedBy =
    submitted !== undefined && isEvent(submitted, "run.submitted") ? submitted.payload.submittedBy : undefined;
  const replayRunId = await engine.submit({ graph: opts.graph, inputs, ...(submittedBy === undefined ? {} : { submittedBy }) });

  // THE HUMAN CEILINGS, REKEYED AND SERVED IN ORDER — see `recordedCeilings`. Unconditional,
  // unlike `replayGates`: answering a gate differently is a thing a caller may legitimately
  // want, and running at a posture the recorded run did not have is not. Without this the
  // replay of any de-escalated run either raises a gate that was never decided (and throws) or
  // gates an action the recording performed.
  const ceilings = recordedCeilings(events, opts.runId, replayRunId);
  const applied = new Set<RecordedCeiling>();
  const applyCeilings = async (raised: number): Promise<void> => {
    for (const c of ceilings.filter((x) => x.afterRaised <= raised && !applied.has(x))) {
      applied.add(c);
      // Through the same door a human used, so the shadow journal RECORDS the ceiling rather
      // than carrying it in memory — invariant 2 applies to the replay's own journal too, and
      // a shadow whose posture came from nowhere is the shape that made this bug invisible.
      await engine.deescalate(replayRunId, c.scope, c.to, c.justification, { kind: "human", id: c.subject });
    }
  };
  await applyCeilings(0);

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
        // NOBODY ANSWERING IS AN OUTCOME, and it was the one outcome replay could not re-derive.
        // A gate the CLOCK resolved has no `gate.decided` — it has `gate.timeout` and folds to
        // `state: "expired"` — so this arm threw for every run that ended because a deadline
        // passed. `onTimeout: "fail"` is the DEFAULT, which makes that the ordinary unanswered
        // run rather than a corner, and the set an auditor most wants to re-derive.
        const expired = firstUnservedExpiry(original, open.taskId, served);
        if (expired === undefined) {
          throw err.internal(
            CODES.E_REPLAY_DIVERGENCE,
            `replay raised a gate on node "${open.nodeId}" (task "${open.taskId}") that the recorded run never decided`,
          );
        }
        served.add(expired.gateId);
        await applyCeilings(Object.keys(replayed.gates).length);
        replayed = await expireOnTheClock(engine, replayRunId, open.gateId, replayed);
        await applyCeilings(Object.keys(replayed.gates).length);
        if (replayed.status !== "awaiting_gate") replayed = await engine.advance(replayRunId);
        continue;
      }
      served.add(recorded.gateId);
      // Every ceiling the human had set by the time THIS gate existed, before answering it.
      await applyCeilings(Object.keys(replayed.gates).length);
      replayed = await engine.resolveGate(replayRunId, {
        gateId: open.gateId,
        decision: decisionOf(recorded),
        actor: { kind: "system", component: "replay" },
        idempotencyKey: `replay:${open.gateId}`,
      });
      await applyCeilings(Object.keys(replayed.gates).length);
      if (replayed.status !== "awaiting_gate") replayed = await engine.advance(replayRunId);
    }
  }

  const replayedEvents: JournalEvent[] = [];
  for await (const e of shadow.read(replayRunId, 1)) replayedEvents.push(e);
  const rebound = reboundEffects(events, replayedEvents);

  const frames = compare(original, replayed, effects);
  // Appended after `compare`, so the frame seq numbers of the three original kinds are
  // untouched by whether a binding held.
  let seq = frames.length;
  if (!graphBound && opts.onGraphChange !== "allow") {
    // WHICH CONJUNCT MOVED, because reporting the graph hash for a RESOURCE change printed the
    // same string twice. `graphBound` is `specBound && refsBound`, and `loom replay`'s only
    // output for a frame is `expected … got …` — so editing `resources/prompt/p.md` produced
    // `✗ graph.bound : expected sha256:aaf236…, got sha256:aaf236…`, two identical hashes and no
    // hint that the manifest was the thing that changed. A diagnostic that shows a difference
    // where there is none sends its reader to look at the wrong artifact.
    const specMoved = recordedGraph !== "" && recordedGraph !== opts.graph.graphHash;
    // The frame is rendered by `loom replay` as `expected X, got Y`, so both halves have to be
    // the two things that DIFFER — and for a resource change the graph hash is not one of them.
    const drift = specMoved ? undefined : describeRefDrift(recordedRefs, opts.graph.resolutionManifest);
    frames.push({
      seq: seq++,
      kind: "graph.bound",
      match: false,
      expected: drift === undefined ? recordedGraph : drift.map((r) => `${r.ref}=${short(r.was)}`).join(", "),
      actual: drift === undefined ? opts.graph.graphHash : drift.map((r) => `${r.ref}=${short(r.now)}`).join(", "),
    });
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
/**
 * A DE-ESCALATION IS A HUMAN INPUT, and replay has to serve it exactly as it serves a gate.
 *
 * Every other term in the posture `max` is derived — the graph declares it, a rule computes it,
 * a class implies it — so a replay re-derives it by running. A human ceiling is the one term
 * that comes from OUTSIDE the run, which is precisely why invariant 5 lets nothing else lower a
 * posture. Nothing re-derives it, so nothing replayed it, so:
 *
 *     recorded:  deescalate `run:<id>` → on, the irreversible action runs, no gate, succeeded
 *     replayed:  no ceiling → posture `in` → a gate → E_REPLAY_DIVERGENCE, "a gate the
 *                recorded run never decided"
 *
 * An audit could not re-derive the runs where a human used the one lever that lowers oversight
 * — which are the runs an auditor most wants to re-derive. Reproduced end to end on a one-node
 * graph with no taint in it, and it is the caveat CLAUDE.md put on the whole bar.
 *
 * ## The scope carries the runId, which is why restoring it verbatim would not have worked
 *
 * `PolicyEngine.decide` looks ceilings up under `node:<runId>/<nodeId>` and `run:<runId>`, and
 * the shadow run has a different id. Handing the original's `ceilings` map straight to
 * `PolicyEngine.restore` would write entries no lookup in the shadow ever reaches: the fix that
 * looks right, does nothing, and reports green. The scope is rekeyed here instead.
 *
 * ## Ordering
 *
 * Applied in recorded order, positioned by how many gates had been RAISED when the human called
 * it. A human can only intervene where the run is paused — before the first advance, or while a
 * gate is open — so that count is the coordinate, and it is derived from the journal rather than
 * read off a wall clock.
 *
 * RAISED, not DECIDED, and the difference is a real case rather than a nicety. `resolveGate`
 * advances the run as part of answering, so a human who lowers a ceiling while gate 2 is open
 * does it AFTER gate 2 was raised and BEFORE it was decided. Keyed on decisions, the replay
 * would apply that ceiling straight after serving gate 1 — before gate 2 exists — and suppress
 * the very gate the recording says was raised, leaving its recorded decision unserved. Measured
 * on a three-node graph: keyed on decisions the replay diverges, keyed on raises it matches.
 */
interface RecordedCeiling {
  readonly scope: string;
  readonly to: Posture;
  readonly justification: string;
  readonly subject: string;
  /** How many gates had been RAISED when the human called it. */
  readonly afterRaised: number;
}

function recordedCeilings(events: readonly JournalEvent[], from: RunId, to: RunId): readonly RecordedCeiling[] {
  const out: RecordedCeiling[] = [];
  let raised = 0;
  for (const e of events) {
    if (isEvent(e, "gate.raised")) {
      raised++;
      continue;
    }
    if (!isEvent(e, "policy.deescalated")) continue;
    // A scope naming no run — a tenant-wide ceiling — carries across unchanged. Only the run
    // coordinate is rewritten, by exact substring, so a runId appearing inside a node name or
    // a justification is not touched.
    const scope = e.payload.scope.split(from).join(to);
    // A de-escalation by a non-human cannot exist: `PolicyEngine.deescalate` refuses one. A
    // journal holding one is a journal that was EDITED, and applying it here would launder the
    // edit into a real ceiling. Skipped instead — which makes the replay raise the gate the
    // recording lacks, and report the divergence rather than hide it.
    if (e.actor.kind !== "human") continue;
    out.push({
      scope,
      to: e.payload.to,
      justification: e.payload.justification,
      subject: e.actor.subject,
      afterRaised: raised,
    });
  }
  return out;
}

/**
 * The earliest EXPIRY on this Task the replay has not re-served — the mirror of
 * `firstUnservedDecision`, and deliberately its exact shape.
 *
 * `GateRecord.state` already carried `"expired"`; nothing read it. The two helpers differ in one
 * literal because the two cases differ in one fact: who resolved the gate. Everything else — the
 * per-Task scoping that keeps iteration 2 from being served iteration 1's answer, the `served`
 * set, the earliest-first order a forward walk needs — is the same problem and must not acquire a
 * second, drifting solution.
 */
function firstUnservedExpiry(p: RunProjection, taskId: TaskId, served: ReadonlySet<GateId>): GateRecord | undefined {
  let best: GateRecord | undefined;
  for (const g of Object.values(p.gates)) {
    if (g.state !== "expired" || g.taskId !== taskId || served.has(g.gateId)) continue;
    if (best === undefined || g.raisedAtSeq < best.raisedAtSeq) best = g;
  }
  return best;
}

/**
 * Let the shadow gate expire BY RUNNING THE CLOCK, never by asserting the outcome.
 *
 * The alternative was to resolve the shadow gate with a synthesised timeout, and that is the
 * shape which reports `match: true` for a mechanism that has stopped working — which `compare`'s
 * own gate-blindness already was once in this file. Sweeping means the real `GateSweeper` decides:
 * if the deadline arithmetic, the escalation chain or the terminal action ever break, a replay
 * DIVERGES instead of agreeing with itself.
 *
 * ## Why the instant is searched for rather than read off the journal
 *
 * The obvious derivation is the offset the recorded run took, `gate.timeout.ts − raisedAtTs`,
 * applied to the shadow's own raise. It was written that way first and it does not work, for a
 * reason worth keeping: **an event `ts` is the STORE's clock, not a measurement of the deadline.**
 * That clock is injected everywhere in this codebase — fixed in tests, and fixed at
 * `original.startedAt` for a replay — so a run whose gate genuinely expired records
 * `gate.timeout.ts === raisedAtTs`, an offset of ZERO, and sweeping there expires nothing. The
 * instant `sweepGates` was actually called with is not journaled anywhere.
 *
 * So the coordinate the journal really carries is weaker, and using it honestly is the fix: the
 * recorded run expired this gate AT ALL. The shadow clock is therefore walked forward until the
 * gate stops being open, which reproduces the outcome through the mechanism without claiming to
 * reproduce a wall-clock instant that was never recorded.
 *
 * ## Why a loop, and why doubling
 *
 * `sweepTimeouts` makes at most ONE append per gate per tick — its own comment says so — so a
 * gate that escalates through tiers needs one sweep per tier to reach the terminal one, and each
 * tier's deadline is further out than the last. Doubling covers any finite schedule in a bounded
 * number of steps while still arriving at each deadline in order, so tiers fire in sequence
 * rather than being skipped. The cap is a guard, not a policy: a sweep that stops making progress
 * must not spin.
 */
async function expireOnTheClock(
  engine: Engine,
  runId: RunId,
  gateId: GateId,
  p: RunProjection,
): Promise<RunProjection> {
  const raisedAt = p.gates[gateId]?.raisedAtTs ?? 0;
  let current = p;
  for (let k = 0; k < 48 && current.gates[gateId]?.state === "open"; k++) {
    await engine.sweepGates(raisedAt + 2 ** Math.min(k, 41));
    current = (await engine.projection(runId)) ?? current;
  }
  return current;
}

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

function compare(original: RunProjection, replayed: RunProjection, effects: ReplayEffects): ReplayFrame[] {
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

  // WHO WAS ASKED, AND WHAT THEY SAID. Absent until a mutation test went looking for it:
  // `compare` weighed task states, channels and status, so a replay that raised a DIFFERENT
  // NUMBER OF HUMAN GATES than the recording reported `match: true`. Measured on a
  // three-node graph whose recording asked a human twice — a replay that asked once scored
  // green, and so did one that asked NOBODY AT ALL.
  //
  // That is the "looks supervised, is not" shape at the level of the audit tool itself. The
  // whole point of replaying a gated run is to re-derive the oversight, and the verdict every
  // consumer reads — `loom replay`'s exit code, `evolution/gate.ts`'s promotion decision — was
  // blind to exactly that.
  //
  // Keyed by TaskId, which is derived (`nodeId@branchPath#iteration`) and therefore the same
  // coordinate in both runs — the same reason `task.committed` above can be compared at all.
  // The DECISION is compared, not the gateId: ids are minted per run and always differ.
  const gateKeys = new Set<TaskId>([
    ...Object.values(original.gates).map((g) => g.taskId),
    ...Object.values(replayed.gates).map((g) => g.taskId),
  ]);
  for (const id of [...gateKeys].sort()) {
    // A SUBGRAPH SERVED FROM THE RECORD DID NOT RUN ITS CHILD, so its parent-side mirror gate
    // has nothing to mirror and is not raised — which is the whole point of "a parent replay
    // does not re-run the child", the same rule that stops it re-calling a model. Comparing it
    // would report a divergence for behaving as designed. Narrow on purpose: the exemption is
    // per TASK and only when that task's `subgraph` effect was actually served, so a subgraph
    // node the replay DID execute is still compared.
    if (effects.wasServed(effectKey(id, "subgraph", 0))) continue;
    const a = Object.values(original.gates).filter((g) => g.taskId === id);
    const b = Object.values(replayed.gates).filter((g) => g.taskId === id);
    const render = (gs: readonly GateRecord[]): string =>
      gs.map((g) => `${g.state}${g.decision === undefined ? "" : `:${g.decision}`}`).sort().join(",") || "(never raised)";
    frames.push({
      seq: seq++,
      kind: "gate.decided",
      taskId: id,
      match: render(a) === render(b),
      expected: render(a),
      actual: render(b),
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
