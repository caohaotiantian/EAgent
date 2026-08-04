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
 * `DEFERRED-v2: partition assignment and cross-worker fairness (G3).` The genuinely risky
 * part is not selection but *who runs which run* — that needs a coordinator, and shipping
 * a half one is worse than shipping none.
 *
 * See design/loom/03-RUNTIME.md D6.2 and design/loom/99-DOD.md G3.
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

/** The v1 default: one worker, so every eligible Task is this worker's to take. */
export class InProcessScheduler implements Scheduler {
  readonly kind = "in-process";

  select(input: SelectInput): readonly Runnable[] {
    return orderByCriticalPath(eligible(input), input.graph).slice(0, input.maxParallelism);
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
    const candidates = eligible(input).filter(({ task }) => {
      const held = heldBy(input.projection, task.taskId);
      if (held === undefined) return true;
      // Somebody else's live lease is somebody else's work. Taking it anyway is the
      // double execution the fencing token catches AFTER the fact — and "after the fact"
      // is too late for a tool that already sent an email.
      if (held.workerId === input.workerId) return true;
      return input.now - held.at >= this.#leaseMs;
    });
    return orderByCriticalPath(candidates, input.graph).slice(0, input.maxParallelism);
  }
}

/** The most recent lease on a Task, if it is still the current one. */
function heldBy(p: RunProjection, taskId: string): { workerId: string; at: number } | undefined {
  const task = p.tasks[taskId as keyof typeof p.tasks];
  if (task === undefined) return undefined;
  return task.lease === undefined ? undefined : { workerId: task.lease.workerId, at: task.lease.at };
}
