/**
 * What a Task was SERVED — the channel state its body was handed, answered from the journal alone.
 *
 * WHY THIS EXISTS. `TODO.md` §A.29: a frozen golden case pins the whole work channel byte for byte,
 * so a candidate its graph's own verifier certifies is refused as a regression. Three attempts to
 * waive that pin on the verifier's word were REVERTED at `aabdc63` after four games promoted
 * garbage, and every one had the same shape: the pin reconstructed *what the grader saw* from the
 * run's FINAL channel value and the graph's STATIC edge ancestry. Neither is a statement about
 * time, and the candidate owns the graph. The closing condition the row names is a fold that
 * answers "what did channel C hold when task T read it". This is that fold, and it is the only
 * thing `evolution/gate.ts` consults to decide it — never ancestry, never the final value alone.
 *
 * IT IS THE KERNEL'S FOLD, NOT A SECOND ONE. The answer is `foldRun` over the journal PREFIX that
 * ends at T's lease, read through `viewFor` at T's branch — the function the engine hands a body
 * its view with — with rewinds honoured by the kernel's own `suppressedRanges`. Nothing here
 * reduces a channel, and nothing here copies an engine rule it could get wrong — where the engine
 * computes a view this fold cannot rebuild from the kernel's exports, the answer is UNDECIDABLE and
 * the caller fails closed.
 *
 * WHY THE LEASE IS THE CUT. `Engine.#runWaveInner` appends every `task.leased` of a wave, then
 * takes ONE projection, then runs the bodies against it, then commits in branch order. A lease
 * changes no channel, binding or externalised-handle map, so the fold at T's own lease equals the
 * projection the wave's bodies were handed in everything a CHANNEL read sees; a wave-mate's write
 * lands at its commit, after every body in the wave ran, and is correctly absent. A lease DOES change
 * `tasks`, which a reserved `"<id>:error"` read is projected from: a wave-mate leased later in the
 * same wave out of `succeeded`/`failed` (§A.101's re-run) projects differently at T's lease than in
 * the wave's snapshot. So an `:error` read's answer here is exact only when no wave-mate was re-run;
 * `evolution/gate.ts` never certifies on one (it is not a recorded input). That is an argument about the engine, so it is
 * proven by running rather than by reading: `test/run/served.test.ts` has bodies echo their view
 * over multi-node waves, an externalised payload, a retry, an lww envelope and a reserved error
 * projection, and compares each echo with this. The argument holds for ONE writer per journal,
 * which every replay shadow is: a second process appending to the same run between a lease and the
 * wave's snapshot could move the view under it (`Engine` has no cross-process lease today,
 * `TODO.md` §B.1). Nothing here is asked of a live multi-writer journal.
 *
 * THE LAST LEASE BEFORE THE ONE COMMIT. A retry and a gate both re-lease a Task before the body
 * that finally commits runs, and that body ran against the snapshot taken after ITS lease. A Task
 * with more than one commit, or a lease after its commit, ran more than once (§A.101's shape), and
 * "what did it read" then has more than one answer — UNDECIDABLE.
 *
 * WHAT IS UNDECIDABLE, and the set is named:
 *   - a Task never committed, committed more than once, or leased again after its commit;
 *   - a Task with no lease before its commit;
 *   - a Task whose branch holds its writes for a join (any non-root branch — the engine's
 *     `writesHeldForJoin`). Such a body is also handed what ITS OWN branch has written so far
 *     (`Engine.#withBranchWrites`), which is engine-private; rebuilding it here would be a second
 *     fold of join state, and a second fold is how two answers to one question start.
 *
 * ALSO HERE, and for the reason the fold is: `evaluatorIdentities` and `graderSite` — what a grader
 * is held to — because `loom suite freeze` writes them into a case and `evolution/gate.ts` compares
 * them, and one definition is what keeps the two doors agreeing.
 *
 * NOT EXPORTED FROM `index.ts`. It is an internal of the promotion gate, not a public surface.
 */

import { digest } from "../canonical.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { ChannelSpec } from "../state/channels.ts";
import { branchChain, foldRun, stateAtBranch, suppressedRanges, viewFor, type RunProjection } from "./projection.ts";
import { parseTaskId, type Seq, type TaskId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import type { PayloadRef } from "../journal/payloads.ts";

/** Channel values plus the fold's own declaration of which of them are payload handles. */
export interface ChannelSnapshot {
  readonly channels: Readonly<Record<string, unknown>>;
  /**
   * Channels whose value in `channels` is a `PayloadHandle`, per the FOLD — never per the value's
   * shape (a body may write `{$payload: …}` itself; see `RunProjection.external`).
   */
  readonly external: Readonly<Record<string, PayloadRef>>;
}

export type Served =
  | ({
      readonly decidable: true;
      readonly taskId: TaskId;
      /** The seq of the lease whose post-lease snapshot the committing body ran on. */
      readonly leaseSeq: Seq;
      /** The Task's one `task.committed`. */
      readonly commit: {
        readonly seq: Seq;
        readonly status: string;
        readonly writes: Readonly<Record<string, unknown>>;
        readonly external: Readonly<Record<string, PayloadRef>>;
      };
    } & ChannelSnapshot)
  | { readonly decidable: false; readonly taskId: TaskId; readonly reason: string };

/**
 * The channels in `reads` as Task `taskId` was served them, from `events` — one run's journal in
 * seq order — through the VIEW `specs` (the graph in force) builds. A channel the body was handed
 * no value for is ABSENT from the answer, not `undefined`.
 */
export function servedTo(
  events: readonly JournalEvent[],
  taskId: TaskId,
  reads: readonly string[],
  specs: Readonly<Record<string, ChannelSpec>>,
): Served {
  const undecidable = (reason: string): Served => ({ decidable: false, taskId, reason });

  const branch = parseTaskId(taskId).branch;
  if (branch.segments.length > 0) {
    return undecidable(
      `task "${taskId}" runs inside a fan-out, whose body is also handed its own branch's held writes — ` +
        "engine-private join state this fold does not rebuild",
    );
  }

  const hidden = suppressedRanges(events);
  const live = (e: JournalEvent): boolean => !hidden.some(([from, to]) => e.seq > from && e.seq < to);
  const mine = events.filter((e) => e.taskId === taskId && live(e));
  const commits = mine.filter((e) => isEvent(e, "task.committed"));
  if (commits.length !== 1) {
    return undecidable(
      commits.length === 0
        ? `task "${taskId}" never committed`
        : `task "${taskId}" committed ${String(commits.length)} times, so what it read has more than one answer`,
    );
  }
  const commit = commits[0]!;
  const leases = mine.filter((e) => isEvent(e, "task.leased"));
  if (leases.some((e) => e.seq > commit.seq)) {
    return undecidable(`task "${taskId}" was leased again after its commit, so it ran more than once`);
  }
  const before = leases.filter((e) => e.seq < commit.seq);
  if (before.length === 0) return undecidable(`task "${taskId}" has no lease before its commit`);
  const leaseSeq = before[before.length - 1]!.seq;

  const p = foldRun(events.filter((e) => e.seq <= leaseSeq));
  if (p === undefined) return undecidable(`the journal before task "${taskId}"'s lease folds to no run`);
  const snapshot = snapshotAt(p, branch, reads, specs);
  if (!isEvent(commit, "task.committed")) return undecidable(`task "${taskId}"'s commit is not a commit`);
  return {
    decidable: true,
    taskId,
    leaseSeq,
    commit: {
      seq: commit.seq,
      status: commit.payload.status,
      writes: commit.payload.writes,
      external: commit.payload.external ?? {},
    },
    ...snapshot,
  };
}

/**
 * The channels in `reads` of a projection at `branch`, AS A BODY'S VIEW HANDS THEM, with the fold's
 * handle declarations.
 *
 * THROUGH THE KERNEL'S `viewFor`, the function `Engine.#runFunction` and `#runEvaluator` call, not
 * over raw state — because the view is not the state. `makeStateView` drops a channel `specs` does
 * not declare, unwraps a `last_write_wins_by_ts` envelope (`channelValue`) and supplies a reserved
 * `"<id>:error"` projection, and `specs` is the CANDIDATE's. Comparing stored values instead let a
 * candidate re-declare an input the grader reads as `last_write_wins_by_ts`: the stored list still
 * matched the recording while the grader was handed `undefined` (lane F's plan review).
 *
 * A HANDLE is a channel the fold holds as a `PayloadHandle` AND the view handed over untransformed
 * — the same reference `stateAtBranch` holds — and not one a binding on the chain overrides. The
 * engine resolves exactly those before the body runs (`#resolveReads`), so its content is the
 * handle's digest; everything else is digested as the view gave it.
 */
export function snapshotAt(
  p: RunProjection,
  branch: Parameters<typeof stateAtBranch>[1],
  reads: readonly string[],
  specs: Readonly<Record<string, ChannelSpec>>,
): ChannelSnapshot {
  const state = stateAtBranch(p, branch);
  const view = viewFor(p, specs, branch, reads);
  const bound = new Set<string>();
  for (const path of branchChain(branch)) for (const c of Object.keys(p.bindings[path] ?? {})) bound.add(c);
  const channels: Record<string, unknown> = {};
  const external: Record<string, PayloadRef> = {};
  for (const c of reads) {
    const v = view.get(c);
    if (v === undefined) continue;
    channels[c] = v;
    const ref = bound.has(c) || v !== state[c] ? undefined : p.external[c];
    if (ref !== undefined) external[c] = ref;
  }
  return { channels, external };
}

/**
 * The CONTENT digest of `channel` in `s`, or `undefined` when it holds no value.
 *
 * LIKE WITH LIKE. A channel above the externalisation threshold is a handle in the fold and a
 * value in a body's view; its handle's digest IS `digestOf(canonicalize(value))` (`refFor`), so
 * comparing content digests compares what was served with what was written whichever form
 * either side is in. Which form a side is in comes from the fold's `external`, never the shape.
 */
export function contentDigest(s: ChannelSnapshot, channel: string): string | undefined {
  if (!Object.hasOwn(s.channels, channel)) return undefined;
  const ref = s.external[channel];
  return ref !== undefined ? ref.digest : digest(s.channels[channel]);
}

/**
 * Every evaluator node of `graph` with the identity a grader is held to, keyed `node:<id>`: kind,
 * ref, the digest the ref RESOLVED to, sorted `reads`, and `threshold`.
 *
 * Here rather than in `evolution/gate.ts` because two doors need the one definition and neither may
 * grow the public surface: the gate's `12-grader-unchanged` (`EvalReport.evaluators`) and the
 * certificate `loom suite freeze` writes into a golden case (`EvalCase.expect.graders`), which the
 * gate then compares against the candidate's. It walks `graph.spec.nodes` only — an evaluator inside
 * a `subgraph` child is not seen, which `EvalReport.evaluators` names as its own gap.
 */
export function evaluatorIdentities(graph: RunGraph): Record<
  string,
  { kind: "assertion" | "rubric"; ref: string; digest?: string; reads: readonly string[]; threshold?: number }
> {
  const out: Record<string, { kind: "assertion" | "rubric"; ref: string; digest?: string; reads: readonly string[]; threshold?: number }> = {};
  for (const node of graph.spec.nodes) {
    if (node.type !== "evaluator" || node.evaluator === undefined) continue;
    const resolved = graph.resolutionManifest.find((r) => r.ref === node.evaluator?.ref);
    out[`node:${String(node.id)}`] = {
      kind: node.evaluator.kind,
      ref: node.evaluator.ref,
      ...(resolved === undefined ? {} : { digest: resolved.digest }),
      reads: [...(node.reads ?? [])].sort(),
      ...(node.evaluator.threshold === undefined ? {} : { threshold: node.evaluator.threshold }),
    };
  }
  return out;
}

/**
 * A digest of everything a grader's `ctx.node` is built from, and more: its whole `NodeSpec` and
 * every edge LEAVING it, ordered by id.
 *
 * WHY. A body is handed more than its view — `Engine.#runEvaluator` passes `ctx.node`
 * (`nodeShapeOf`: the node's reads and writes, and each outbound edge's kind, `over`, `as`,
 * `maxWidth`, `maxIterations`), and every one of those edges is the candidate's. A frozen grader
 * that consults, say, the fan-out width below it could be steered by a candidate that only
 * re-wired it. `nodeShapeOf` is engine-private, so rather than copy its membership — a copy that
 * would fail OPEN the day it grows a field — this binds a strict superset: the node and its
 * outbound edges whole. The same superset binds what the evaluator identity leaves out and the
 * engine reads for this node: its `policy` (a gate), `retry` (which attempt's clock it reads),
 * `timeoutMs`, and the `writes` that confine a hook's override.
 *
 * AND THE `ChannelSpec` OF EVERY CHANNEL IT READS, which is the other input of the function that
 * builds its view. A body is handed `viewFor(state, specs, …)`: the fold pins `state`, and the
 * candidate owns `specs`. Left unbound, a candidate re-declaring a read channel chose what the
 * grader saw from the same stored bytes — an input as `last_write_wins_by_ts` handed as nothing,
 * or the GRADED channel as `last_write_wins_by_ts` with an `initial` that no later write can
 * displace, so the grader and the final view both read `undefined` while the stored channel held
 * garbage (lane F's diff review, driven to `promote: true`). Two reviews found the same fact one
 * spec field apart; binding the spec is the fact, not a third edge.
 *
 * THE COST, named: a candidate that adds or edits an edge leaving the grader, or re-declares a
 * channel it reads, keeps the byte pin on that case even when the change is honest. That is the
 * refusing direction.
 */
export function graderSite(graph: RunGraph, nodeId: string): string | undefined {
  const node = graph.spec.nodes.find((n) => String(n.id) === nodeId);
  if (node === undefined) return undefined;
  const out = graph.spec.edges
    .filter((e) => String(e.from) === nodeId)
    .sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));
  const channels = Object.fromEntries(
    [...new Set(node.reads ?? [])].sort().map((r) => [r, graph.spec.channels[r] ?? null] as const),
  );
  return digest({ node, out, channels });
}
