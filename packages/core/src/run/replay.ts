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
 * narrow — the `vm` context cannot reach `process` or `fetch` — and `Math.random()` is no longer
 * part of it. It used to be: `SAFE_GLOBALS` removed `Date` and left `Math` whole, so a body using
 * it diverged, measured through the binary as
 * `✗ state.reduced : expected {"out":"0.534…"}, got {"out":"0.108…"}`, `match: false`. The engine
 * now journals a seed per task under `effectKey(taskId, "random", 0)` and the bridge builds the
 * body's `Math.random` from it, so the draws are SERVED here like any other effect. A key this
 * replay's graph asks for that the recording never held is the one case that derives rather than
 * serves — see `seedFromKey`, and the reason is `onGraphChange: "allow"`. An embedder passing
 * `opts.globals`, or registering a body directly on `FunctionRegistry`, still gets a genuine live
 * side effect. See `the design notes` B11. If replay needs an effect the journal does not contain, that is
 * `E_REPLAY_DIVERGENCE`, a loud failure, never a silent live call.
 *
 * RE-EXECUTION STAYS. Serving a body's output from the record was the obvious answer and it is
 * the wrong one twice over: it would put a `function` member in `journal/events.ts`'s
 * forever-vocabulary to hold a fact the journal already holds as `state.reduced`, and it would
 * re-open a fail-open — `evolution/gate.ts` reads `report.match` for
 * `EvalCase.expect.identicalToRecording`, so a candidate graph whose ONLY change is a body would
 * produce no divergent frame and the promotion gate would certify a body it never exercised.
 * Re-execution is the only thing that catches a body regression. What was wrong was not the
 * re-execution but the REPORT: see `ReplayReport.hermetic` and `ReplayEffects.liveBodies`.
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
  /**
   * The recorded body clock, `${taskId}#${attempt}` → the `task.leased` timestamps in journal
   * order. See `leaseAt`; it is not an effect and deliberately does not live with them.
   */
  readonly #leases = new Map<string, number[]>();
  /** Keys `leaseAt` could not answer. See `derivedClocks`. */
  readonly #clockDerived = new Set<string>();
  /**
   * Tasks whose body this replay re-executed unvouched-for. See `bodyEntered`.
   *
   * Sits with `#clockDerived` rather than with the effect maps because it is the same KIND of
   * accumulator: a fact about what the replay had to do, not a fact the recording holds. Neither
   * is keyed by an effect key, which is exactly why `hermetic` could not see either of them.
   */
  readonly #liveBodies = new Set<string>();

  static fromEvents(events: Iterable<JournalEvent>): ReplayEffects {
    const r = new ReplayEffects();
    for (const e of events) {
      // NOT AN EFFECT, CARRIED WITH THEM. `FunctionContext.now` is the task's lease instant, and
      // the recording already holds it — so replay serves it here rather than journaling a new
      // `clock` effect, which would be replay appending nondeterminism to reach determinism.
      if (isEvent(e, "task.leased") && e.taskId !== undefined) {
        const k = `${e.taskId}#${e.payload.attempt}`;
        const q = r.#leases.get(k);
        if (q === undefined) r.#leases.set(k, [e.ts]);
        else q.push(e.ts);
        continue;
      }
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

  /**
   * The instant the RECORDING leased this task, for the body's `ctx.now()`.
   *
   * WHY THIS EXISTS. `Engine.#bodyClock` binds `FunctionContext.now` to the task's journaled
   * lease timestamp, which is reproducible for a live run and was NOT for a replay: the shadow
   * run appends its OWN `task.leased`, `RunLog` stamps it `now: this.#now()`, and `prepare` gives
   * that caller-supplied value priority over the store's clock — so the replay Engine's wall
   * clock reached the body and two replays of one run answered differently. Measured before the
   * fix: 1204 ms apart, which is just the pause between them.
   *
   * THE COORDINATE IS `(taskId, attempt)`, and both halves are load-bearing. `TaskId` is derived
   * (`nodeId@branchPath#iteration`) so it is the same string in both runs despite the two runIds;
   * `attempt` distinguishes a retry, whose lease is a DIFFERENT instant, from the first try.
   *
   * CONSUMED IN JOURNAL ORDER rather than read, because the pair is not unique over a journal: a
   * rewind can undo a lease and the task is leased again at the same attempt. `#bodyClock` is
   * called exactly once per execution of a `function` or `evaluator{assertion}` task, so the Nth
   * execution is answered with the Nth recorded lease.
   *
   * `undefined` means the recording has no such lease left to serve — the replay ran a body the
   * recording did not. That is a divergence, and it is recorded rather than papered over: the
   * caller falls back to the shadow's own lease and `derivedClocks` reports it.
   */
  leaseAt(taskId: TaskId, attempt: number): number | undefined {
    const key = `${taskId}#${attempt}`;
    const at = this.#leases.get(key)?.shift();
    if (at === undefined) {
      this.#clockDerived.add(key);
      return undefined;
    }
    return at;
  }

  /**
   * Body clocks the recording could not answer, as `taskId#attempt`.
   *
   * Non-empty means at least one body read a time this replay RE-DERIVED instead of serving —
   * which is what `ReplayReport.hermetic` claims did not happen.
   */
  get derivedClocks(): readonly string[] {
    return [...this.#clockDerived].sort();
  }

  /**
   * Record that a replay reached a `function` or `evaluator{assertion}` body, and whether the
   * runtime can vouch for it. See `liveBodies` for what the answer is for.
   *
   * `bounded` is `isRealmBounded(body)` and nothing else — a fact about where the body came
   * from, decided by an unforgeable brand `resources/realm.ts` stamps and no caller can name.
   * A `false` is what an embedder's hand-registered host closure gives, and what a realm built
   * over a non-empty `RealmOptions.globals` gives, because those two are the cases the runtime
   * genuinely cannot decide.
   *
   * CALLED AT FETCH TIME, BEFORE INVOCATION, so a body that throws, is terminated at its
   * deadline, or is aborted still counts. The count can therefore be too HIGH and never too
   * low, which is the only direction a term of `hermetic` may err in.
   */
  bodyEntered(taskId: string, bounded: boolean): void {
    if (!bounded) this.#liveBodies.add(taskId);
  }

  /**
   * Tasks whose body the replay RE-EXECUTED without being able to vouch for it.
   *
   * This is the term `hermetic` was missing, and the reason it was missing is worth keeping:
   * the other two terms are indexed by EFFECT KEY, and a `function` or `evaluator{assertion}`
   * body computes no effect key. So "a body ran live" was not expressible over the vocabulary
   * the report had, and the field answered its undecidable case with the passing value.
   *
   * NOT A LIST OF EVERY BODY THAT RAN. A branded body re-executes too — that is deliberate, and
   * it is the only thing that catches a body regression, since serving a body's output by key
   * would let `evolution/gate.ts` certify a candidate graph whose only change IS the body. What
   * this names is the narrower set: the bodies whose reproducibility the runtime has no ground
   * to assert.
   *
   * EMPTY IS NOT YET EVIDENCE — NOTHING IN `src/` CALLS `bodyEntered`. The two call sites are
   * `Engine.#runFunction` and `Engine.#runEvaluator`'s assertion arm, both by way of
   * `#functionBody`, and `run/engine.ts` is owned by another change. Until that line lands this
   * getter answers `[]` on every run and `hermetic` over-claims exactly as it did before — see
   * `ReplayReport.hermetic`, which says so in the field's own docstring rather than here where a
   * reader of the report would not find it.
   * `test/run/hermetic-names-the-live-bodies.test.ts` pins the un-wired state as a source census,
   * so the day a caller appears that assertion goes red and sends its author to both docstrings.
   */
  get liveBodies(): readonly string[] {
    return [...this.#liveBodies].sort();
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
   * Tasks whose `function` or `evaluator{assertion}` body this replay RE-EXECUTED without being
   * able to vouch for it — a hand-registered host closure, or a realm built over embedder
   * globals. See `ReplayEffects.bodyEntered`, which decides it, and `liveBodies`, which explains
   * why the answer is about provenance rather than about purity.
   *
   * Surfaced as the list and not folded into the boolean, because "not hermetic" without the
   * taskIds sends its reader to the wrong file — the same argument `unservedEffects` makes one
   * field up, and the reason `loom replay` prints frames rather than a verdict.
   *
   * `Engine.#functionBody` is the sole producer and records at FETCH, before the body runs, so a
   * body that throws still counts as having run. `test/run/hermetic-names-the-live-bodies.test.ts`
   * pins that there is exactly one caller.
   */
  readonly liveBodies: readonly string[];
  /**
   * Nothing this replay needed had to be RE-DERIVED instead of served from the record.
   *
   * Three things can falsify it. Two are "the journal could not answer":
   *   - a recorded effect that started and never recorded an outcome (`unknownOutcomes`) — the
   *     original process died mid-call, and replay cannot invent what the world did;
   *   - a body clock the recording has no lease for (`ReplayEffects.derivedClocks`) — the replay
   *     ran a `function` or `evaluator{assertion}` body the recording did not lease at that
   *     attempt, so `ctx.now()` came from the shadow's own lease rather than from history.
   *
   * The third is "the RUNTIME could not answer", and it is a different question:
   *   - `liveBodies` — a body re-executed that the runtime cannot vouch for. Bodies re-execute
   *     on purpose; what this term adds is whether the one that ran was realm-bounded.
   *
   * WHY THE THIRD TERM HAD TO BE ITS OWN KIND. The first two are indexed by effect key, and a
   * `function` or `evaluator{assertion}` body computes NO effect key — so on a graph of function
   * nodes no input could make this field false, while the bodies re-executed live. That is a
   * guard answering its undecidable case with the passing value, inside the one field the replay
   * thesis is quoted by. "A body ran live" was not expressible over the terms the report had.
   *
   * IT IS FALSIFIABLE NOW, and the two lines this paragraph used to name are both written.
   * `Engine.#functionBody` calls `bodyEntered(taskId, isRealmBounded(body))` at fetch, and
   * `resources/functions.ts` carries the realm's brand onto the wrapper it returns — without the
   * second, `isRealmBounded` was `true` on the `RealmCall` and `false` on the closure the engine
   * actually holds, so every body read as unvouched-for and a term false for everything
   * distinguishes nothing. The device worked as designed: the census in
   * `test/run/hermetic-names-the-live-bodies.test.ts` asserted the un-wired state, went red the
   * moment the wiring landed, and sent its author here. It now asserts one caller, and the paired
   * proving test beside it drives both answers from real runs — a hand-registered host closure
   * replays `hermetic: false` naming its taskId, and the same graph loaded from a `ResourceStore`
   * replays `hermetic: true`.
   *
   * WHAT `hermetic: true` WILL MEAN, once wired, and it is narrower than it reads: "no body ran
   * that the runtime could not vouch for", not "nothing nondeterministic happened". A branded
   * body can still read the host's default locale and observe garbage collection — both are
   * PASSING tests, `THE HOST'S DEFAULT LOCALE IS AMBIENT` and `GARBAGE COLLECTION IS OBSERVABLE`
   * in `test/resources/realm-has-no-clock.test.ts`. Naming that set is what keeps this from
   * becoming a smaller version of the same overclaim.
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
  /**
   * Model effect keys where the RECORDING predates `model.called.requestDigest`, so whether
   * the replay asked the same question is not decidable from these two journals.
   *
   * NOT A SUBSET OF `reboundEffects` AND NOT ITS COMPLEMENT — a third state, kept separate on
   * purpose. "The calls differ" and "I cannot tell whether the calls differ" are different
   * facts, and folding the second into the first would report a defect nobody measured, while
   * folding it into "no rebound" is the loosening that made the promotion gate certify a
   * candidate it never exercised.
   *
   * A reader deciding anything on this must fail closed: `evolution/gate.ts` refuses a case
   * whose replay carries entries here AND whose graph is not the recorded one. Same graph and
   * no digest is not a hazard — there is nothing a same-graph replay could have changed about
   * the request — which is why the graph-hash test belongs at the reader and not here.
   */
  readonly unverifiedModelEffects: readonly string[];
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

  // THIS CLOCK NEVER REACHES AN EVENT, and for four commits it was mistaken for the thing that
  // made replay's clock reproducible. `MemoryStateStore`'s `now` is only consulted when an append
  // arrives with none, and `RunLog` passes `now: this.#now()` on EVERY append while `prepare`
  // gives the caller priority (`journal/store.ts`) — so every shadow event is stamped by the
  // replay Engine's clock, not this one. It is kept because a store with no clock is a store that
  // falls back to `Date.now` for a direct `store.append`, and the shadow should not; the body
  // clock is served by `ReplayEffects.leaseAt`, which is where that fix actually lives.
  //
  // The Engine's own `#now` is deliberately NOT frozen here. `#pickReady` gates a backed-off task
  // on `t.retryAfter <= now()` and `retryAfter` is *now + backoff*, so a frozen clock leaves every
  // retrying task permanently in the future and the replay stalls.
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
  const { rebound, unverified } = reboundEffects(events, replayedEvents);

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
    liveBodies: effects.liveBodies,
    // Non-hermetic when the recorded run had effects with no outcome: replay cannot
    // invent what the world did while the process was dying — or when a body read a clock
    // this recording could not answer, which is the same statement one field over — or when a
    // body re-executed that the runtime cannot vouch for. The third conjunct has no producer in
    // this tree and is therefore inert; `ReplayReport.hermetic` names the two lines that give it
    // one, and why it is published before them. See also `ReplayEffects.derivedClocks`.
    hermetic:
      effects.unknownOutcomes.length === 0 && effects.derivedClocks.length === 0 && effects.liveBodies.length === 0,
    graph: { recorded: recordedGraph, replayed: opts.graph.graphHash, match: graphBound },
    reboundEffects: rebound,
    unverifiedModelEffects: unverified,
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
 * VALUES (`tool.called.argsShape`, and see the comment there for why). For a TOOL that is
 * still all there is, so a tool entry catches a different tool, a different tool version and
 * a different argument shape, and does NOT catch the same tool with a different argument
 * VALUE — caught today by the graph hash, and only by it, which means not at all under
 * `onGraphChange: "allow"`.
 *
 * FOR A MODEL IT IS NOW THE WHOLE REQUEST. This used to compare the model NAME alone, and
 * named the missing piece in its own text: an input digest per effect. `model.called` carries
 * one — `requestDigest`, a digest of the shaped `ModelRequest` — so a candidate that re-points
 * `agent.prompt`, rewrites the system document, or changes which tools the model is offered
 * shows up here instead of replaying byte-identically. That was measured before the field
 * existed: a prompt-only candidate replayed with `reboundEffects: []` and `gateCandidate`
 * answered `promote: true` having made zero model calls.
 *
 * A RECORDING WITH NO `requestDigest` IS NOT EVIDENCE OF SAMENESS. Journals written before
 * that field carry none, and reading its absence as "the calls agree" would restore exactly
 * the loosening it closes. Those keys go to `unverifiedModelEffects` instead, and the reader
 * decides — see that field.
 *
 * Joined on the intersection of keys. Recorded-and-never-asked-for is already
 * `unservedEffects`; asked-for-and-never-recorded is `E_REPLAY_DIVERGENCE` at serve time.
 */
function reboundEffects(
  recorded: readonly JournalEvent[],
  replayed: readonly JournalEvent[],
): { rebound: ReplayReport["reboundEffects"]; unverified: readonly string[] } {
  const index = (events: readonly JournalEvent[]): Map<string, { field: "tool" | "model"; call: string }> => {
    const out = new Map<string, { field: "tool" | "model"; call: string }>();
    for (const e of events) {
      if (isEvent(e, "tool.called")) {
        out.set(e.payload.key, { field: "tool", call: `${e.payload.name}@${e.payload.version}(${e.payload.argsShape})` });
      } else if (isEvent(e, "model.called")) {
        // The MODEL and the REQUEST, and deliberately not the provider. A replay reaches no
        // adapter, so it journals `provider: "replay"` — a fact about the replay, not about
        // the call, and comparing it would make every model effect in every replay look
        // rebound. `requestDigest` is a fact about the call.
        //
        // `undefined` is kept as `undefined` rather than normalised to a string, so the
        // caller can tell "no digest was written" from "a digest that happens to differ".
        const d = (e.payload as { requestDigest?: string }).requestDigest;
        out.set(e.payload.key, { field: "model", call: d === undefined ? e.payload.model : `${e.payload.model} ${d}` });
      }
    }
    return out;
  };
  const digestOf = (events: readonly JournalEvent[], key: string): string | undefined => {
    for (const e of events) {
      if (isEvent(e, "model.called") && e.payload.key === key) return (e.payload as { requestDigest?: string }).requestDigest;
    }
    return undefined;
  };

  const before = index(recorded);
  const after = index(replayed);
  const out: { key: string; field: "tool" | "model"; recorded: string; replayed: string }[] = [];
  const unverified: string[] = [];
  for (const [key, a] of before) {
    const b = after.get(key);
    if (b === undefined) continue;
    if (a.field === "model" && digestOf(recorded, key) === undefined) {
      // The recording cannot answer the question, so this key is neither rebound nor clean.
      // Reporting it as clean is the loosening; reporting it as rebound would claim a
      // difference nothing measured.
      unverified.push(key);
      continue;
    }
    if (b.call === a.call) continue;
    out.push({ key, field: a.field, recorded: a.call, replayed: b.call });
  }
  return {
    rebound: out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    unverified: unverified.sort(),
  };
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
