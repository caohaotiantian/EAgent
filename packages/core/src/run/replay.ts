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
 * replay's graph asks for that the recording never held is `E_REPLAY_DIVERGENCE` like any other
 * missing effect — unless this replay runs a graph that is NOT the recorded one, in which case a
 * seed is DERIVED from the key (`seedFromKey`, in `engine.ts`), `derivedSeeds` names it and
 * `hermetic` is false. See `ReplayEffects.seed`. An embedder passing
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
 * replays a frozen suite against a candidate), and verification (`loom replay` re-executes a run
 * and grades it: task states, gate decisions, the final channel map, the per-step
 * `state.reduced` hashes — see `stateHashFrame` — and why the run ended). Nothing in `scripts/`
 * replays fixtures in CI; this paragraph used to say it did.
 *
 * THE VERDICT IS OVER TWO QUESTIONS, not one: did the projections agree, and was the
 * recording actually consumed? The second is not implied by the first — a recorded result
 * nobody asks for moves no channel — so `unservedEffects` counts against `match` rather
 * than being reported beside it. See `ReplayReport.match`.
 *
 * AND "AGREED" INCLUDES WHAT A REFUSAL SAID. `compare` weighs the terminal error's MESSAGE as
 * well as its code, because a refusal that keeps its classification and changes its sentence is
 * two different claims about why a run stopped, and it used to score `match: true`. The one
 * difference it forgives is a minted id — see `withoutMintedIds`, which names the set.
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
  /** `random` keys this replay DERIVED because the recording held no seed. See `seed`. */
  readonly #seedsDerived = new Set<string>();
  /** Whether `seed` may derive at all. Off until `replayRun` says the graph may differ. */
  #deriveSeeds = false;

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
   * which call produced it or with what arguments — both are graded after the run by
   * `reboundEffects`, from `tool.called` and `model.called` — or about a journal rewritten CONSISTENTLY, digest
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
   * Let `seed` derive a value for a key the recording never held.
   *
   * Called by `replayRun` when the graph it was handed is NOT the graph the journal records —
   * by hash or by resolved resources — and by nothing else. That fact, not the caller's
   * `onGraphChange` setting, is what makes a missing seed explicable: a node the recording never
   * had has no seed to serve. It was keyed on `onGraphChange: "allow"` first, and that broke the
   * one caller the derivation exists for — `evolution/gate.ts`'s `runEvalSuite` replays a
   * candidate at the DEFAULT setting, so a candidate that added a `function` node failed every
   * case `E_REPLAY_DIVERGENCE`. On the recorded graph a missing seed can only be an old or
   * truncated journal, and stays a divergence whatever the caller said. This only ever widens
   * what is REPORTED, never what is served: a derived seed is named in `derivedSeeds` and costs
   * `ReplayReport.hermetic`.
   */
  allowDerivedSeeds(): void {
    this.#deriveSeeds = true;
  }

  /**
   * The `random` seed for `key` — served from the record, or DERIVED and said so, or refused.
   *
   * THIS USED TO BE AN ENGINE BRANCH THAT DERIVED UNCONDITIONALLY. `Engine.#randomSeedEffect`
   * tested `has(key)` and fell through to `seedFromKey` on every miss, on the argument that a miss
   * can only be a candidate's new node under `onGraphChange: "allow"` — an option the Engine
   * cannot see. Measured at 95a3dde on a recording written before the seed effect existed,
   * replayed against the byte-identical graph at the default `onGraphChange`: the body drew from
   * a seed the record never held and the report said `match: true, hermetic: true` whenever the
   * draw did not reach a channel. A replay that invents its entropy is not a replay.
   *
   * So a miss is a DIVERGENCE unless this replay runs a graph that is not the recorded one (see
   * `allowDerivedSeeds`), and even then it is recorded: `derivedSeeds` names the key and
   * `hermetic` counts it. Deriving from the key rather than drawing keeps two replays of one
   * candidate on one stream, which is what `runEvalSuite` needs to be measuring the candidate
   * and not the entropy.
   *
   * `derive` is a parameter rather than an import because the derivation lives in `engine.ts`
   * beside the bridge that consumes the seed; this class decides whether to SERVE, not how to
   * seed a PRNG. A key that started and never completed goes through `require`, which already
   * says so.
   */
  seed(key: string, derive: (key: string) => number): number {
    if (this.has(key) || this.#unknown.has(key)) return Number(this.require(key).result);
    if (!this.#deriveSeeds) {
      throw err.internal(
        CODES.E_REPLAY_DIVERGENCE,
        `effect "${key}" is not in the journal — this is the recorded graph, so the recording holds no seed for this ` +
          `body because it predates the random effect or was truncated. A replay derives a seed only for a graph that ` +
          `is not the recorded one, and the report then names it in derivedSeeds`,
        { details: { key } },
      );
    }
    this.#seedsDerived.add(key);
    return derive(key);
  }

  /** `random` keys this replay derived from the key instead of serving. See `seed`. */
  get derivedSeeds(): readonly string[] {
    return [...this.#seedsDerived].sort();
  }

  /**
   * Record that a replay reached a `function` or `evaluator{assertion}` body, and whether the
   * runtime can vouch for it. See `liveBodies` for what the answer is for.
   *
   * `bounded` is `isRealmBounded(body)` and nothing else — a fact about where the body came
   * from, decided by an unforgeable brand `resources/realm.ts` stamps and no caller can name.
   * THE PROPERTY, NOT A LIST: `false` means *this module did not make the realm this body came
   * from, or could not finish vouching for it*. Stated as a property because the list version
   * went stale — it named a hand-registered host closure and a non-empty `RealmOptions.globals`
   * "because those two are the cases", and by then `compileRealm`'s checks had been widened to
   * refuse the brand for a body that un-shadows `Date` or `Intl` at definition time, one that
   * swaps `Math`, a `Date` installed as an accessor, and a realm whose `Math.random` was never
   * replaced. Six members where the sentence claimed two. `resources/realm.ts` holds the current
   * set beside the checks that decide it, which is the only place it can be right.
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
    | "state.hash"
    | "task.committed"
    | "gate.decided"
    | "run.completed"
    | "run.failed"
    | "run.message"
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
   * able to vouch for it — meaning `resources/realm.ts` did not make that realm, or could not
   * finish vouching for it. Stated as the property rather than as members: this sentence used to
   * name two cases and the refusal set had grown to six. `ReplayEffects.bodyEntered` decides it
   * and carries the argument for why the answer is about provenance rather than about purity.
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
   * `random` effect keys this replay DERIVED from the key because the recording held no seed.
   *
   * Reachable only when the replayed graph is not the recorded one, where a candidate's new
   * `function` node has a taskId the recording never wrote a seed for; on the recorded graph the
   * same miss is `E_REPLAY_DIVERGENCE`. Named, for the reason `liveBodies` gives: a false `hermetic` without
   * the keys sends its reader to the wrong file. `ReplayEffects.seed` decides it and carries the
   * argument, including the measurement of what the unconditional derivation used to certify.
   */
  readonly derivedSeeds: readonly string[];
  /**
   * Nothing this replay needed had to be RE-DERIVED instead of served from the record.
   *
   * Four things can falsify it. Three are "the journal could not answer":
   *   - a recorded effect that started and never recorded an outcome (`unknownOutcomes`) — the
   *     original process died mid-call, and replay cannot invent what the world did;
   *   - a body clock the recording has no lease for (`ReplayEffects.derivedClocks`) — the replay
   *     ran a `function` or `evaluator{assertion}` body the recording did not lease at that
   *     attempt, so `ctx.now()` came from the shadow's own lease rather than from history;
   *   - a PRNG seed the recording never wrote (`derivedSeeds`) — the replay ran a body under a
   *     candidate graph and derived the seed from the effect key, so the body's draws came from
   *     the key rather than from history. This was the unnamed fourth member: the derivation ran
   *     on EVERY miss and nothing counted it, so a replay that invented its entropy reported
   *     `hermetic: true`.
   *
   * The fourth is "the RUNTIME could not answer", and it is a different question:
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
  /**
   * Tool effect keys where the RECORDING predates `tool.called.argsDigest` (journals written
   * before 2026-08-27), so whether the replay made the same call is not decidable from these two
   * journals. The same third state as `unverifiedModelEffects`, one effect kind over, and kept as
   * its own list rather than folded into that one because a reader refusing on "different graph
   * and cannot tell" has to say WHAT it could not tell. `evolution/gate.ts` reads the model list
   * today; it is owed this one under the same condition.
   */
  readonly unverifiedToolEffects: readonly string[];
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
  const recordedInputs = submitted !== undefined && isEvent(submitted, "run.submitted") ? submitted.payload.inputs : {};
  // AN EXTERNALISED INPUT IS FETCHED HERE, NOT CARRIED FORWARD AS A HANDLE, and the reason is
  // the runId. A `PayloadRef` is scoped to the run that stored it (`journal/payloads.ts`: the
  // key is `(runId, digest)`), and the shadow gets a fresh runId — so handing `submit` the
  // recorded handle would name a cell the shadow cannot address. The value comes back under
  // the ORIGINAL run's scope and the shadow's own `submit` re-puts it under its own, which
  // costs one copy and is what makes the shadow a self-contained run.
  //
  // NO STORE PLUS A HANDLE IS A REFUSAL, the same one `Engine.#resolveReads` makes: the
  // recording's inputs exist and are simply unreachable from here, and a shadow submitted
  // WITHOUT them would run a different run and report `match: false` about the recording.
  const submittedExternal =
    submitted !== undefined && isEvent(submitted, "run.submitted") ? (submitted.payload.external ?? {}) : {};
  const inputs: Record<string, unknown> = { ...recordedInputs };
  if (Object.keys(submittedExternal).length > 0) {
    const store = opts.engine.payloads;
    if (store === undefined) {
      throw err.internal(
        CODES.E_PAYLOAD_UNRESOLVED,
        `run ${opts.runId} externalised its input${Object.keys(submittedExternal).length === 1 ? "" : "s"} ${Object.keys(
          submittedExternal,
        )
          .map((c) => `"${c}"`)
          .join(", ")} — replaying it needs the same \`payloads\` store the recording was written with`,
        { details: { runId: opts.runId, channels: Object.keys(submittedExternal) } },
      );
    }
    for (const [channel, ref] of Object.entries(submittedExternal)) inputs[channel] = await store.get(opts.runId, ref);
  }

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
  // THE ONE PERMISSION TO DERIVE RATHER THAN SERVE, and it is a fact about the graph rather than
  // a setting: a graph that is not the recorded one may hold a `function` node the recording
  // never seeded. On the recorded graph a missing seed stays a divergence. See `ReplayEffects.seed`.
  if (!graphBound) effects.allowDerivedSeeds();
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
  const { rebound, unverifiedModels, unverifiedTools } = reboundEffects(events, replayedEvents);

  const frames = compare(original, replayed, effects);
  // Appended after `compare`, so the frame seq numbers of the three original kinds are
  // untouched by whether a binding held.
  let seq = frames.length;
  // THE TRAJECTORY, NOT ONLY WHERE IT ENDED — see `stateHashFrame`. Unconditional, including
  // under `onGraphChange: "allow"`: that opt-out is about which GRAPH may run, and a candidate
  // that reaches the recorded end state by a different route has still not reproduced the run.
  frames.push({ seq: seq++, ...stateHashFrame(events, replayedEvents) });
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
    derivedSeeds: effects.derivedSeeds,
    // Non-hermetic when the recorded run had effects with no outcome: replay cannot
    // invent what the world did while the process was dying — or when a body read a clock
    // this recording could not answer, or drew from a seed it never wrote, which are the same
    // statement two fields over — or when a body re-executed that the runtime cannot vouch for.
    // `ReplayReport.hermetic` names all four and what each one means.
    hermetic:
      effects.unknownOutcomes.length === 0 &&
      effects.derivedClocks.length === 0 &&
      effects.derivedSeeds.length === 0 &&
      effects.liveBodies.length === 0,
    graph: { recorded: recordedGraph, replayed: opts.graph.graphHash, match: graphBound },
    reboundEffects: rebound,
    unverifiedModelEffects: unverifiedModels,
    unverifiedToolEffects: unverifiedTools,
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
 * possible from here: the replay Engine hands `require` a key and nothing else, and journals
 * the `tool.called` that says what it asked for only after the result is in hand.
 *
 * FOR A TOOL IT IS THE CALL AND ITS ARGUMENTS. `tool.called` carries `argsShape`, a TYPE shape,
 * and `argsDigest`, a digest of the argument VALUES — never the values themselves, for the
 * reason that event gives. This compared the shape alone and its own text said "that is still
 * all there is", which was false the day `argsDigest` landed beside it. Measured at 95a3dde: a
 * candidate that changed `fs.write`'s `path` from `out/summary.md` to somewhere else kept the
 * key `write@root#0:tool:0` and the shape `{body:string,path:string}`, was served the recorded
 * write, and replayed `match: true, reboundEffects: []` under `onGraphChange: "allow"` —
 * certified by `evolution/gate.ts` as measured, against a transcript of a write it never made.
 * The digest is the whole sha256, not a prefix: a shortened one could render two identities
 * that compare unequal as the same string in a frame.
 *
 * A RECORDING WITH NO `argsDigest` IS NOT EVIDENCE OF SAMENESS EITHER. Journals written before
 * that field (2026-08-27) carry none; those keys go to `unverifiedToolEffects`, exactly as the
 * model arm below does for a missing `requestDigest`, and the reader decides.
 *
 * FOR A MODEL IT IS THE WHOLE REQUEST. This used to compare the model NAME alone, and
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
): { rebound: ReplayReport["reboundEffects"]; unverifiedModels: readonly string[]; unverifiedTools: readonly string[] } {
  // `verified` is whether the RECORDING carried the input digest this identity rests on. Both
  // arms keep `undefined` as `undefined` rather than normalising to a string, so "no digest was
  // written" is never mistaken for "a digest that happens to differ".
  const index = (events: readonly JournalEvent[]): Map<string, { field: "tool" | "model"; call: string; verified: boolean }> => {
    const out = new Map<string, { field: "tool" | "model"; call: string; verified: boolean }>();
    for (const e of events) {
      if (isEvent(e, "tool.called")) {
        const d = (e.payload as { argsDigest?: string }).argsDigest;
        const call = `${e.payload.name}@${e.payload.version}(${e.payload.argsShape})`;
        out.set(e.payload.key, { field: "tool", call: d === undefined ? call : `${call} ${d}`, verified: d !== undefined });
      } else if (isEvent(e, "model.called")) {
        // The MODEL and the REQUEST, and deliberately not the provider. A replay reaches no
        // adapter, so it journals `provider: "replay"` — a fact about the replay, not about
        // the call, and comparing it would make every model effect in every replay look
        // rebound. `requestDigest` is a fact about the call.
        //
        // `undefined` is kept as `undefined` rather than normalised to a string, so the
        // caller can tell "no digest was written" from "a digest that happens to differ".
        const d = (e.payload as { requestDigest?: string }).requestDigest;
        out.set(e.payload.key, {
          field: "model",
          call: d === undefined ? e.payload.model : `${e.payload.model} ${d}`,
          verified: d !== undefined,
        });
      }
    }
    return out;
  };

  const before = index(recorded);
  const after = index(replayed);
  const out: { key: string; field: "tool" | "model"; recorded: string; replayed: string }[] = [];
  const unverifiedModels: string[] = [];
  const unverifiedTools: string[] = [];
  for (const [key, a] of before) {
    const b = after.get(key);
    if (b === undefined) continue;
    if (!a.verified) {
      // The recording cannot answer the question, so this key is neither rebound nor clean.
      // Reporting it as clean is the loosening; reporting it as rebound would claim a
      // difference nothing measured.
      (a.field === "model" ? unverifiedModels : unverifiedTools).push(key);
      continue;
    }
    if (b.call === a.call) continue;
    out.push({ key, field: a.field, recorded: a.call, replayed: b.call });
  }
  return {
    rebound: out.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0)),
    unverifiedModels: unverifiedModels.sort(),
    unverifiedTools: unverifiedTools.sort(),
  };
}

/**
 * The per-step state hashes of the two runs, compared in journal order — one frame, naming the
 * first step that differs.
 *
 * `compare` grades the FINAL channel map, and for as long as that was the only state frame the
 * module docstring claimed verification "asserts every `state.hash` matches" while nothing read
 * `stateHashAfter` at all. Measured at 95a3dde: channel `out` with `reduce: "sum"`, bodies `a`
 * then `b` writing 1 then 2 in the recording and 2 then 1 in the candidate — the journals hold
 * `afb1ca2872` against `56f2fff5c7` at the first step, the end state is 3 both ways, and the
 * report said `match: true`. Function bodies re-execute on replay PRECISELY so that a body
 * regression is caught, and the only comparison happened after the fold had collapsed the
 * trajectory into one map. The evidence was in hand — both event arrays are collected before
 * `compare` runs — and unread, the same shape as `resultDigest` written at four sites and
 * compared nowhere.
 *
 * ORDER IS COMPARED, AND HERE IS WHAT WAS CHECKED. `Engine.#runWaveInner` runs a wave in parallel
 * and commits it in `compareBranch` order, so within a wave the sequence does not depend on which
 * task's tool answered first. Across waves the partition is the scheduler's, and one attempt to
 * make it differ did not: two independent chains recorded at `maxParallelism: 1` and replayed at
 * the default, and the reverse, walked the same four steps. The skeleton's five-way fan-out
 * replays to the same sequence in `test/run/replay.test.ts`. NOT CHECKED, and named so the next
 * false divergence has somewhere to start: a retried task whose backoff elapsed during a slow
 * recorded tool call and not during the instantaneous replay would partition differently, and
 * whether its step then moves depends on its order against its neighbours. This frame reads the
 * raw journal where `compare` reads the fold, so a rewound span is visible here and suppressed
 * there; a rewound run diverges on `task.committed` already.
 *
 * WHAT IT DOES NOT SEE: a hash is over the channel map AS THE FOLD BUILDS IT, so a divergence in
 * a value the fold never touches (a tool result that only reaches a transcript) is `reboundEffects`'
 * and `unservedEffects`' to find, not this frame's.
 */
function stateHashFrame(recorded: readonly JournalEvent[], replayed: readonly JournalEvent[]): Omit<ReplayFrame, "seq"> {
  const steps = (events: readonly JournalEvent[]): { taskId: string; hash: string }[] => {
    const out: { taskId: string; hash: string }[] = [];
    for (const e of events) {
      if (isEvent(e, "state.reduced")) out.push({ taskId: String(e.taskId ?? "(no task)"), hash: e.payload.stateHashAfter });
    }
    return out;
  };
  const render = (s: { taskId: string; hash: string } | undefined): string => (s === undefined ? "(no step)" : `${s.taskId} ${s.hash}`);
  const a = steps(recorded);
  const b = steps(replayed);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x !== undefined && y !== undefined && x.taskId === y.taskId && x.hash === y.hash) continue;
    // `(x ?? y)!`: the loop only reaches here past the shorter sequence's end or on a mismatch,
    // and in both cases at least one side has a step.
    const at = (x ?? y)!;
    return { kind: "state.hash", taskId: at.taskId, match: false, expected: render(x), actual: render(y) };
  }
  return { kind: "state.hash", match: true, expected: `${a.length} steps`, actual: `${b.length} steps` };
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

  // WHY IT ENDED, NOT ONLY THAT IT DID. This weighed `status` alone, so two runs that failed for
  // unrelated reasons scored `match: true` — and that is not hypothetical, it is the thing that
  // kept the `budget.tokens` replay hole quiet for as long as it existed. Measured, one agent
  // node with `budget.tokens: 500`: the recording failed `E_BUDGET_EXHAUSTED` before any model
  // call, the replay could not re-derive that refusal, went on to a model effect the recording
  // never made, and died `E_REPLAY_DIVERGENCE` — two different runs, both `failed`, reported as a
  // faithful reproduction. `loom replay`'s exit code and `evolution/gate.ts`'s promotion decision
  // both read this verdict.
  //
  // THE CODE, AND THEN THE MESSAGE IN ITS OWN FRAME — see `run.message` below. This used to be
  // the code ALONE, and the argument for that was measured and is now false; the frame that
  // replaces it says why.
  //
  // `(no code)` is a failed projection with no `error` — a journal fragment, or a `run.failed`
  // written by hand. It compares as itself rather than matching everything, which is the same
  // direction every other frame here fails in.
  const why = (p: RunProjection): string => (p.status === "failed" ? `failed:${p.error?.code ?? "(no code)"}` : p.status);
  frames.push({
    seq: seq++,
    kind: original.status === "failed" ? "run.failed" : "run.completed",
    match: why(original) === why(replayed),
    expected: why(original),
    actual: why(replayed),
  });

  // WHAT THE REFUSAL SAID, AND NOT ONLY WHICH REFUSAL IT WAS. The frame above grades the error
  // CODE, which catches a refusal that became a DIFFERENT refusal and misses one that kept its
  // classification and changed its sentence. That second shape is not hypothetical: the provider
  // refusal at `engine.ts`'s `framedProvider === ""` opened with `model adapter "<name>"` live
  // and `the recorded turn` in replay — same code, same status, same channels, two different
  // sentences, `match: true` throughout. The wording there was made path-independent; this frame
  // is the general answer, because the next such message will not be that one.
  //
  // THE STANDING OBJECTION, AND WHY IT NO LONGER HOLDS. This file argued against a message frame
  // on the grounds that "a message carries numbers that legitimately differ between a recording
  // and its replay (`spent`, `estimated`, an adapter name)". Every one of those three was true
  // when it was written and none of them is true now, which is the whole reason this frame is
  // affordable:
  //   * `spent` and `estimated` — A.1 put the adapter's own answers on the journal as a `quote`
  //     effect, so a replay reserves the recorded number rather than a floor. Driven at HEAD in
  //     `replay-fidelity.test.ts` on a node `budget.tokens: 500`: LIVE and REPLAY both say
  //     `1041 estimated for this turn`, and the same file drives the node-`costUsd` and
  //     run-`runTokens` refusals to the same byte-identical pair.
  //   * an adapter name — it moved OFF the text and onto `details.adapter`, which is exactly
  //     where a value that legitimately differs by path belongs.
  //
  // AND THE MESSAGE, NOT THE `details`. `details` is where the path-dependent values live by
  // design — `details.adapter` is the adapter's name live and `null` in a replay, because a
  // replay reaches no adapter and has nothing to ask. Grading it would report divergence for a
  // run that agreed, which is the failure mode this frame must not have; grading the sentence
  // catches the same class without it. A future value that must be compared should be spelled
  // into the message, or given a frame that states its own tolerance.
  //
  // ONE TOLERANCE, AND IT IS THE ONE THE GATE FRAME ABOVE ALREADY STATES: a MINTED id differs
  // between two runs by construction, so `withoutMintedIds` blanks them before the compare. The
  // gate frame says it in prose — "ids are minted per run and always differ" — and a replayed
  // run that expires a gate puts that id straight into the sentence: measured, the two
  // `replay-expired-gate.test.ts` cases produced
  //     expected  gate "gate_01HF7YAT00X9AFK8WE6241HDJT" expired with no decision
  //     actual    gate "gate_01M1GE37R4N1H5S4NMS7JP4SR9" expired with no decision
  // which is a faithful replay reported as a divergence. The set it covers is exactly `ids.ts`'s
  // three mints and nothing else — a bare `ulid()` (a RunId), `gate_` + one, `cp_` + one — all
  // three of which are 26 Crockford base32 characters, and a `TaskId` is DERIVED and so is left
  // alone on purpose: `nodeId@branchPath#iteration` is the same string in both runs and a
  // difference in it is a real divergence.
  //
  // `(no message)` for a `failed` projection with no `error`, and for the same reason `(no code)`
  // exists one frame up: it compares as itself rather than matching everything.
  //
  // Emitted only when a refusal is in evidence on EITHER side. A pair of completed runs has no
  // message to grade, and a frame that is always `match: true` teaches its reader to skip the
  // whole family.
  if (original.status === "failed" || replayed.status === "failed") {
    const said = (p: RunProjection): string =>
      p.status === "failed" ? withoutMintedIds(p.error?.message ?? "(no message)") : `(${p.status}, no error)`;
    frames.push({
      seq: seq++,
      kind: "run.message",
      match: said(original) === said(replayed),
      expected: said(original),
      actual: said(replayed),
    });
  }

  return frames;
}

/**
 * A message with its MINTED ids blanked — the one difference a faithful replay is allowed.
 *
 * Everything else a refusal says is either the same in both runs or a real divergence. An id is
 * neither: `ids.ts` mints three of them at random — a bare ULID (`RunId`), `gate_` + a ULID, and
 * `cp_` + a ULID — and a replay runs into its own shadow journal, so those three CANNOT agree and
 * a comparison that demands they do reports every gated run as broken. `compare`'s gate frame has
 * always known this and states it as prose; this is the same rule applied to the text.
 *
 * The pattern is 26 Crockford base32 characters (no I, L, O or U — see `B32`), not delimited by
 * another id character, which is what makes it match the ULID inside `gate_…` without eating the
 * prefix. Deliberately NOT anchored to the three prefixes: a bare RunId carries none, and
 * enumerating prefixes here would silently stop covering a fourth mint the day one is added.
 *
 * WHAT IT COSTS, stated rather than hidden: a divergence whose ONLY difference is a minted id is
 * invisible to this frame. That is not a hole this frame opened — such a difference is invisible
 * to every other frame in `compare` too, for the same reason, and a run's own id is not a fact
 * about the run. A `TaskId` is the case that matters and it is untouched: it is DERIVED
 * (`nodeId@branchPath#iteration`), so it is identical across runs and a difference in one is a
 * genuine divergence this frame still reports.
 */
function withoutMintedIds(message: string): string {
  return message.replace(/(?<![0-9A-Z])[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}(?![0-9A-Z])/g, "<minted-id>");
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
