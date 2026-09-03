/**
 * Task selection — the seam the distributed swap goes through.
 *
 * Checklist item 7 says "local → distributed changes implementations, never call sites".
 * For the journal that claim is discharged by one conformance suite passing against both
 * `MemoryStateStore` and `SqliteStateStore`. For the SCHEDULER it was a claim about code
 * that had no seam at all: selection was twenty lines inline in `Engine.advance`, so
 * "swap the implementation" would have meant editing the executor.
 *
 * This is that seam, and it is deliberately small. A `Scheduler` answers ONE question:
 *
 * > Given what the journal says, which Tasks should this worker run right now?
 *
 * Everything else — leasing, executing, committing, the fencing token — stays in the
 * executor, because those are the parts that must not vary between deployments. A
 * scheduler that could also decide *how* a Task runs would be a second executor.
 *
 * ## What the distributed one has to do differently
 *
 * `InProcessScheduler` assumes it is the only worker: every ready Task is available. A
 * partitioned scheduler cannot assume that, so it must additionally
 *
 * 1. **skip Tasks another worker holds** — a live lease is somebody else's work, and
 *    running it anyway is the double-execution the fencing token exists to catch late;
 * 2. **reclaim expired leases** — a worker that died holding a Task must not strand it;
 * 3. **stay within its partition**, so two workers do not both consider the same run.
 *
 * All three are decisions about *which* Tasks, which is why the seam is where it is.
 * `LeasedScheduler` below implements the first two against the same journal the local one
 * reads, so the behaviour is exercised in v1 rather than asserted about v2.
 *
 * (2) IS NOT ONLY A DISTRIBUTED PROBLEM, which is what this list originally implied and what
 * left the shipped scheduler stranding runs. One worker still has a PREDECESSOR: a plane killed
 * between `task.leased` and `task.committed` leaves a Task in a state only its holder advances,
 * and the next process is not that holder. `InProcessScheduler` therefore reclaims too, expired
 * against the node's own compiled deadline rather than an operator-chosen lease — see
 * `deadlineExpired`.
 *
 * (2) took two goes. The first version filtered `eligible`, and `eligible` returns only
 * `ready` Tasks — which is exactly right for one worker and silently empty for the case
 * reclaim exists to handle, since a Task whose holder died stays `leased` forever. The
 * bug survived a passing conformance suite because the suite built its projections by
 * hand and gave the stranded Task a state the real fold never assigns it. Reclaim is now
 * a second candidate source rather than a filter; see `test/run/contention.test.ts`,
 * which folds real journals for two workers instead.
 *
 * `DEFERRED-v2: partition assignment and cross-worker fairness (G3).` The genuinely risky
 * part is not selection but *who runs which run* — that needs a coordinator, and shipping
 * a half one is worse than shipping none.
 *
 */

import { compareBranch } from "../ids.ts";
import type { NodeSpec, RunGraph } from "../graph/spec.ts";
import type { RunProjection, TaskRecord } from "./projection.ts";

export interface Runnable {
  readonly task: TaskRecord;
  readonly node: NodeSpec;
}

export interface SelectInput {
  readonly projection: RunProjection;
  readonly graph: RunGraph;
  /** `nodeId → NodeSpec`, so a scheduler never re-walks the spec. */
  readonly nodes: ReadonlyMap<string, NodeSpec>;
  readonly maxParallelism: number;
  readonly now: number;
  /** Identifies this worker. A single-process deployment has exactly one. */
  readonly workerId: string;
}

export interface Scheduler {
  readonly kind: string;
  /**
   * Tasks to run now, in execution order.
   *
   * MUST be deterministic given the same input: replay re-derives the same waves, and a
   * scheduler that shuffled would make a replay's task order differ from the original's
   * for a reason unrelated to the graph.
   */
  select(input: SelectInput): readonly Runnable[];
}

/**
 * Ready Tasks, ordered by longest remaining path.
 *
 * Critical-path-first shrinks a run's makespan without any extra concurrency: the work
 * with the most behind it starts soonest. Ties break on branch coordinate, which is a
 * total order, so the wave is deterministic and replay reproduces it.
 */
export function orderByCriticalPath(candidates: readonly Runnable[], graph: RunGraph): Runnable[] {
  return [...candidates].sort((a, b) => {
    const ca = graph.plans[a.task.nodeId]?.criticalPathLength ?? 0;
    const cb = graph.plans[b.task.nodeId]?.criticalPathLength ?? 0;
    return cb - ca || compareBranch(a.task.branch, b.task.branch);
  });
}

/** Ready, and past its retry backoff. Shared by every scheduler — it is not a policy. */
export function eligible(input: SelectInput): Runnable[] {
  const out: Runnable[] = [];
  for (const task of Object.values(input.projection.tasks)) {
    if (task.state !== "ready") continue;
    if (task.retryAfter !== undefined && task.retryAfter > input.now) continue;
    const node = input.nodes.get(task.nodeId);
    if (node !== undefined) out.push({ task, node });
  }
  return out;
}

/**
 * Is a lease taken at `at` still live at `now`?
 *
 * The boundary is a decision, not an accident. A lease whose deadline is EXACTLY `now`
 * is LIVE. Both answers are defensible and they are not symmetric: calling a live lease
 * dead double-executes a Task that may already have sent the email, while calling a dead
 * one live costs one poll interval. Ambiguity resolves toward the cheaper mistake.
 */
function leaseLive(at: number, now: number, leaseMs: number): boolean {
  return now <= at + leaseMs;
}

/**
 * Tasks whose holder is gone.
 *
 * `eligible` returns only `ready` Tasks, and for ONE worker that is complete: a `leased`
 * Task is this process's own work, in flight. With two it is not, and the gap is not a
 * corner — a worker that dies mid-Task leaves it in `leased` forever, because the state
 * only advances when its holder commits. So reclaim cannot be a filter over `eligible`;
 * the stranded Tasks are precisely the ones `eligible` excludes.
 *
 * A `leased` Task this worker itself holds is NOT reclaimed early. In-process it is
 * running right now, and the projection cannot distinguish that from a crashed predecessor
 * sharing the worker id — so the expiry applies to everyone, including us.
 */
function reclaimable(input: SelectInput, leaseMs: number): Runnable[] {
  const out: Runnable[] = [];
  for (const task of Object.values(input.projection.tasks)) {
    if (task.state !== "leased") continue;
    // Leased with no recorded lease is a shape the fold cannot produce. If it ever
    // appears there is no deadline to reason from, and "no deadline" must read as
    // "still live" for the same reason the boundary does.
    if (task.lease === undefined) continue;
    if (leaseLive(task.lease.at, input.now, leaseMs)) continue;
    if (task.retryAfter !== undefined && task.retryAfter > input.now) continue;
    const node = input.nodes.get(task.nodeId);
    if (node !== undefined) out.push({ task, node });
  }
  return out;
}

/**
 * Tasks a crash left behind, expired by the node's OWN declared deadline.
 *
 * This is `reclaimable()`'s argument with a different clock, and the clock is the whole point.
 * `LeasedScheduler` expires a lease against an operator-chosen `leaseMs`, and its docstring is
 * right that there is no safe default for that number. A single-plane deployment does not need
 * one: the graph already carries a bound that means "no live execution can still be inside this
 * task". `NodePlan.timeoutMs` is the deadline `Engine.#withNodeDeadline` WILL enforce, so a
 * holder that is still alive has already aborted the task by `lease.at + timeoutMs` and appended
 * its own outcome. Past that instant a `leased` task is a dead worker's, and reclaiming it costs
 * no double execution that the deadline was not already going to cause.
 *
 * TWO WAYS IT REFUSES, and both are the conservative direction:
 *
 *   - OUR OWN LEASE IS NEVER TAKEN BACK, at any age. `advance` is re-entrant, so a lease under
 *     this worker's id is work running right now. `workerId` is `hostname:pid:ordinal`
 *     (`cli.ts`'s `planeWorkerId`), so a restarted plane comes back under a new name and its
 *     pre-restart leases are correctly foreign — which is exactly the case that was stranded.
 *   - NO DEADLINE, NO RECLAIM. `compile.ts`'s `effectiveTimeout` gives an enforced deadline to
 *     `agent`, `tool`, `evaluator` and `function` and to nothing else, so a `join`, `router`,
 *     `human_gate` or `subgraph` task is left alone: with no bound there is nothing to reason
 *     from, and "I do not know" is not "the holder is dead". Those four are also the four whose
 *     bodies return synchronously or delegate to a child run, so the window a crash can land in
 *     is a tick rather than a node's whole duration. A deployment that wants them reclaimed too
 *     asks for a flat lease by passing `Engine`'s `opts.scheduler` a `LeasedScheduler` — that is
 *     the seam, and it is on the pinned public surface.
 *
 * The boundary is `leaseLive`'s, inclusive: a deadline landing exactly on `now` is still live,
 * for the reason stated there.
 */
function deadlineExpired(input: SelectInput): Runnable[] {
  const out: Runnable[] = [];
  for (const task of Object.values(input.projection.tasks)) {
    if (task.state !== "leased") continue;
    if (task.lease === undefined) continue;
    if (task.lease.workerId === input.workerId) continue;
    const timeoutMs = input.graph.plans[task.nodeId]?.timeoutMs;
    if (timeoutMs === undefined) continue;
    if (leaseLive(task.lease.at, input.now, timeoutMs)) continue;
    if (task.retryAfter !== undefined && task.retryAfter > input.now) continue;
    const node = input.nodes.get(task.nodeId);
    if (node !== undefined) out.push({ task, node });
  }
  return out;
}

/**
 * The v1 default: one worker, so every eligible Task is this worker's to take.
 *
 * `eligible` returns `ready` Tasks only, and for the worker that is running RIGHT NOW that is
 * complete — a `leased` Task is its own work in flight. It is not complete for the worker BEFORE
 * this one. A plane SIGKILLed between `task.leased` and `task.committed` (OOM, deploy, crash)
 * leaves a Task in `leased`, a state only its holder's commit advances, so selection skipped it
 * forever: `loom resume` folded a complete, correct journal, chose an empty wave and exited 0
 * having done nothing — indistinguishable from a run legitimately waiting. `deadlineExpired`
 * above is the second candidate source that ends that, and it is a source rather than a filter
 * for the reason this file's header gives about (2): the stranded Tasks are precisely the ones
 * `eligible` excludes.
 */
export class InProcessScheduler implements Scheduler {
  readonly kind = "in-process";

  select(input: SelectInput): readonly Runnable[] {
    const candidates = [...eligible(input), ...deadlineExpired(input)];
    return orderByCriticalPath(candidates, input.graph).slice(0, input.maxParallelism);
  }
}

export interface LeasedSchedulerOptions {
  /**
   * How long a lease is honoured before another worker may reclaim the Task.
   *
   * The tradeoff is stated plainly because there is no safe default: too short and a slow
   * Task is stolen while still running; too long and a crashed worker strands it. The
   * fencing token makes the first case *detectable* — the stale worker's commit is
   * refused — but detection is not prevention, so this should exceed the slowest node's
   * expected duration.
   */
  readonly leaseMs: number;
}

/**
 * Selection for more than one worker.
 *
 * Not wired into the v1 executor, and not idle either: it runs against the same journal
 * and passes the same conformance suite as the in-process one, so the claim "the swap is
 * an implementation change" is exercised rather than asserted. What is still missing for
 * a real distributed deployment is partition assignment — which runs a worker considers
 * at all — and that is G3.
 */
export class LeasedScheduler implements Scheduler {
  readonly kind = "leased";
  readonly #leaseMs: number;

  constructor(opts: LeasedSchedulerOptions) {
    this.#leaseMs = opts.leaseMs;
  }

  select(input: SelectInput): readonly Runnable[] {
    // A `ready` Task can still carry a lease: a retry and a resolved gate both return one
    // to `ready` without clearing who last held it, which is deliberate — releasing it
    // would let two workers race the retry the instant the backoff lapses.
    const free = eligible(input).filter(({ task }) => {
      const held = heldBy(input.projection, task.taskId);
      if (held === undefined) return true;
      // Somebody else's live lease is somebody else's work. Taking it anyway is the
      // double execution the fencing token catches AFTER the fact — and "after the fact"
      // is too late for a tool that already sent an email.
      if (held.workerId === input.workerId) return true;
      return !leaseLive(held.at, input.now, this.#leaseMs);
    });
    // … and the stranded ones, which by construction are never `ready` at all.
    const candidates = [...free, ...reclaimable(input, this.#leaseMs)];
    return orderByCriticalPath(candidates, input.graph).slice(0, input.maxParallelism);
  }
}

/** The most recent lease on a Task, if it is still the current one. */
function heldBy(p: RunProjection, taskId: string): { workerId: string; at: number } | undefined {
  const task = p.tasks[taskId as keyof typeof p.tasks];
  if (task === undefined) return undefined;
  return task.lease === undefined ? undefined : { workerId: task.lease.workerId, at: task.lease.at };
}
