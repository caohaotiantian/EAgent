/**
 * Identity.
 *
 * Two rules make replay possible and are load-bearing everywhere else:
 *
 *   1. A `RunId` is random (ULID) — it names a thing that happened once.
 *   2. A `TaskId` is DERIVED — `nodeId@branchPath#iteration` is a pure function of
 *      the graph and the branch coordinate. A retry, a resume after restart, and a
 *      replay all compute the same TaskId, which is what makes journal appends and
 *      effect keys idempotent. A random TaskId would break replay silently.
 *
 * See design/loom/01-INTERFACES.md D3.0.
 */

import { randomBytes } from "node:crypto";

declare const brand: unique symbol;
/** A nominal string type. Erased at runtime; the brand exists only for the checker. */
export type Id<K extends string> = string & { readonly [brand]: K };

export type TenantId = Id<"tenant">;
export type ProjectId = Id<"project">;
export type RunId = Id<"run">;
export type NodeId = Id<"node">;
export type EdgeId = Id<"edge">;
export type TaskId = Id<"task">;
export type GateId = Id<"gate">;
export type CheckpointId = Id<"checkpoint">;

/** Monotonic per-Run journal position. Starts at 1, never has gaps. */
export type Seq = number;

// ---------------------------------------------------------------------------
// ULID — lexicographically sortable, time-prefixed, 128-bit
// ---------------------------------------------------------------------------

/** Crockford base32: no I, L, O, U — so a transcribed id cannot be ambiguous. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastMs = -1;
/** The 80 random bits of the last ULID minted in `lastMs`, as 16 base32 indices. */
let lastRand: number[] = [];

function randomIndices(): number[] {
  // 16 base32 chars = 80 bits. One byte per char, masked to 5 bits: uniform over
  // 0..31 because 32 divides 256, so no modulo bias.
  const bytes = randomBytes(RAND_LEN);
  const out = new Array<number>(RAND_LEN);
  for (let i = 0; i < RAND_LEN; i++) out[i] = bytes[i]! & 0x1f;
  return out;
}

/** Increment the random field in place, carrying right-to-left. Returns false on overflow. */
function bumpRandom(r: number[]): boolean {
  for (let i = RAND_LEN - 1; i >= 0; i--) {
    if (r[i]! < 31) {
      r[i] = r[i]! + 1;
      return true;
    }
    r[i] = 0;
  }
  return false;
}

function encodeTime(ms: number): string {
  let out = "";
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = B32[t % 32]! + out;
    t = Math.floor(t / 32);
  }
  return out;
}

/**
 * Mint a ULID. Within a single millisecond, ids are strictly increasing (the random
 * field is incremented rather than redrawn), so sorting by id sorts by creation order
 * even for ids minted in the same tick.
 */
export function ulid(now: number = Date.now()): string {
  if (now === lastMs) {
    if (!bumpRandom(lastRand)) {
      // 2^80 ids in one millisecond is not reachable; fall forward rather than repeat.
      return ulid(now + 1);
    }
  } else {
    lastMs = now;
    lastRand = randomIndices();
  }
  let rand = "";
  for (const i of lastRand) rand += B32[i]!;
  return encodeTime(now) + rand;
}

export const newRunId = (now?: number): RunId => ulid(now) as RunId;
export const newGateId = (now?: number): GateId => `gate_${ulid(now)}` as GateId;
export const newCheckpointId = (now?: number): CheckpointId => `cp_${ulid(now)}` as CheckpointId;

// ---------------------------------------------------------------------------
// Branch coordinates
// ---------------------------------------------------------------------------

/** One fan-out hop: which edge expanded, and which element of `over` this branch is. */
export interface BranchSegment {
  readonly edgeId: string;
  readonly index: number;
}

/**
 * Where a Task sits in the run's expansion tree. The empty path is the root.
 *
 * This type carries the TOTAL ORDER that makes parallel joins deterministic: a join
 * folds branch contributions sorted by coordinate, never by arrival time, so a
 * reducer needs to be associative but not commutative (see D5.3).
 */
export interface BranchCoordinate {
  readonly segments: readonly BranchSegment[];
}

export const ROOT_BRANCH: BranchCoordinate = { segments: [] };

export function childBranch(parent: BranchCoordinate, edgeId: string, index: number): BranchCoordinate {
  return { segments: [...parent.segments, { edgeId, index }] };
}

/** `root` | `root/e1[0]` | `root/e1[0]/e7[3]` — stable, human-readable, sortable. */
export function encodeBranch(b: BranchCoordinate): string {
  if (b.segments.length === 0) return "root";
  return "root/" + b.segments.map((s) => `${s.edgeId}[${s.index}]`).join("/");
}

const BRANCH_SEGMENT = /^([^[\]]+)\[(\d+)\]$/;

export function decodeBranch(encoded: string): BranchCoordinate {
  if (encoded === "root") return ROOT_BRANCH;
  if (!encoded.startsWith("root/")) throw new Error(`malformed branch coordinate: ${encoded}`);
  const segments: BranchSegment[] = [];
  for (const part of encoded.slice("root/".length).split("/")) {
    const m = BRANCH_SEGMENT.exec(part);
    if (!m) throw new Error(`malformed branch segment: ${part}`);
    segments.push({ edgeId: m[1]!, index: Number(m[2]!) });
  }
  return { segments };
}

/**
 * The total order used by every join fold. Compares segment by segment (edge id
 * lexicographically, then index numerically); a proper prefix sorts before its
 * extensions. Total and antisymmetric, so `sort` is deterministic.
 */
export function compareBranch(a: BranchCoordinate, b: BranchCoordinate): number {
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) {
    const x = a.segments[i]!;
    const y = b.segments[i]!;
    if (x.edgeId !== y.edgeId) return x.edgeId < y.edgeId ? -1 : 1;
    if (x.index !== y.index) return x.index - y.index;
  }
  return a.segments.length - b.segments.length;
}

// ---------------------------------------------------------------------------
// Derived TaskId
// ---------------------------------------------------------------------------

/** `nodeId@branchPath#iteration`. Pure — the same inputs always yield the same id. */
export function taskId(nodeId: NodeId, branch: BranchCoordinate, iteration = 0): TaskId {
  return `${nodeId}@${encodeBranch(branch)}#${iteration}` as TaskId;
}

export interface ParsedTaskId {
  readonly nodeId: NodeId;
  readonly branch: BranchCoordinate;
  readonly iteration: number;
}

export function parseTaskId(id: TaskId): ParsedTaskId {
  const at = id.indexOf("@");
  const hash = id.lastIndexOf("#");
  if (at < 0 || hash < at) throw new Error(`malformed task id: ${id}`);
  return {
    nodeId: id.slice(0, at) as NodeId,
    branch: decodeBranch(id.slice(at + 1, hash)),
    iteration: Number(id.slice(hash + 1)),
  };
}

/**
 * The key under which an effect's result is journaled. Stable across retries (the
 * attempt is deliberately NOT part of it) so a tool that supports server-side
 * idempotency dedupes for free, and so replay finds exactly one recorded result.
 */
export function effectKey(task: TaskId, kind: string, ordinal: number): string {
  return `${task}:${kind}:${ordinal}`;
}
