/**
 * Payloads that live BESIDE the journal instead of inside it, addressed by their own digest.
 *
 * WHY THIS FILE EXISTS: the journal amplifies. Measured on a chain of `function` nodes passing
 * one value, `journal_bytes = payload x (2N + 2)` where N is the nodes the value flows through —
 * `task.committed` and `state.reduced` each carry a full copy per hop, plus `run.submitted`'s
 * inputs and `run.completed`'s outputs. `journal/store.ts` BOUNDED that at 8 MiB per event and
 * said so plainly: "THIS IS A BOUND, NOT THE FIX ... which needs payload externalisation — a
 * reference above a threshold, resolved on read." Two comments named the need and nothing
 * implemented it.
 *
 * THE REFERENCE IS A DIGEST, NEVER A MINTED ID. CLAUDE.md invariant 2: "an id you cannot
 * recompute breaks replay". The same value externalises to the same `PayloadRef` in every
 * process and on every attempt, so a re-executed node writing the same bytes produces the same
 * journal event, and replay resolves what the original run resolved. Content addressing also
 * makes `put` idempotent for free: the second write of the same value is the same key.
 *
 * `get` RE-DIGESTS WHAT IT READ and refuses a mismatch. A payload store is a second durable
 * thing beside the journal, so it is a second thing that can be truncated, restored from the
 * wrong backup, or edited — and a substituted payload that resolved silently would be exactly
 * the "clipped payload journaled as a value that is not the value" failure `boundedPayload`
 * refuses to create by truncating. Loud, not silent: `E_PAYLOAD_UNRESOLVED`.
 *
 * SCOPED BY RUN. The key is `(runId, digest)`, not `digest` alone. Content addressing would
 * happily de-duplicate across runs, and that would make one run's channel value reachable from
 * another run's journal by digest — a cross-run read through a store that was only ever asked
 * to save bytes. Per-run scoping also makes deletion mean something: dropping a run's payloads
 * is one directory.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { digestOf, type Digest } from "../canonical.ts";
import { CODES, err } from "../errors.ts";
import type { RunId } from "../ids.ts";

/**
 * What a journal event carries in place of a payload.
 *
 * `bytes` is not decoration: it is what lets an operator reading a journal see the size that
 * left it, and what lets a reader decide whether to fetch at all. It is the size of the
 * CANONICAL text, which is the only size the journal ever had an opinion about.
 */
export interface PayloadRef {
  readonly digest: Digest;
  readonly bytes: number;
}

/**
 * What the PROJECTION carries in place of a channel's value.
 *
 * A distinct wrapper rather than the bare `PayloadRef`, so a handle in a state dump, a trace or
 * a `stateHash` is visibly a handle and not an object that happens to have a `digest` field.
 *
 * NOTHING DECIDES "IS THIS A HANDLE" BY LOOKING AT IT. The fold learns which channels are
 * handles from the event's `external` map and records the answer in `RunProjection.external`;
 * a node body that happens to write `{$payload: {...}}` is an ordinary value and stays one.
 * Sniffing the shape would hand any node that can write a channel the ability to name a
 * payload it never produced.
 */
export interface PayloadHandle {
  readonly $payload: PayloadRef;
}

export function payloadHandle(ref: PayloadRef): PayloadHandle {
  return { $payload: { digest: ref.digest, bytes: ref.bytes } };
}

/**
 * Above this many canonical bytes a channel value leaves the journal. STRICTLY ABOVE: a value
 * of exactly this size stays inline, matching `boundedPayload`'s own `<=` so the two thresholds
 * in this package read the same way at their boundary.
 *
 * SIXTY-FOUR KIBIBYTES, and the reason a small payload is not externalised AT ALL is arithmetic
 * rather than taste. A handle costs about 110 bytes in the event plus one file and one
 * round-trip on every read that touches the channel. Below the threshold the indirection is a
 * net loss in both bytes and reads: externalising a 200-byte value replaces 200 bytes with 110
 * bytes and a filesystem round trip, and does it on every hop.
 *
 * The number is taken from the comparison `journal/store.ts` already drew when it chose its own
 * bound: "Golem inlines to 65 KB and externalises past it". It is deliberately far below the
 * 8 MiB per-event refusal, because the refusal exists to catch a runaway and this exists to
 * stop an ordinary large document from being copied 2N+2 times.
 */
export const EXTERNALISE_ABOVE_BYTES = 64 * 1024;

/**
 * The durable side-store. Two methods, because that is the whole contract: content in, content
 * out, both keyed by a digest the caller can recompute.
 *
 * Deliberately NOT part of `StateStore`. The journal's interface is kernel and its one decision
 * is "append is a compare-and-swap on expectedSeq"; a blob get/put has nothing to do with that
 * and would ride into the kernel on the back of it. An engine given no `PayloadStore`
 * externalises nothing and behaves exactly as it did before this file existed.
 */
export interface PayloadStore {
  /** Idempotent: the same canonical text is the same key. */
  put(runId: RunId, canonical: string): Promise<PayloadRef>;
  /** The value, re-digested and checked. `E_PAYLOAD_UNRESOLVED` if absent or altered. */
  get(runId: RunId, ref: PayloadRef): Promise<unknown>;
}

export function refFor(canonical: string): PayloadRef {
  return { digest: digestOf(canonical), bytes: Buffer.byteLength(canonical, "utf8") };
}

/** Shared by every backend, so "what a get guarantees" has exactly one definition. */
function verified(runId: RunId, ref: PayloadRef, text: string | undefined): unknown {
  if (text === undefined) {
    throw err.internal(CODES.E_PAYLOAD_UNRESOLVED, `payload ${ref.digest} is not in this run's payload store`, {
      details: { runId, digest: ref.digest, bytes: ref.bytes },
    });
  }
  const actual = digestOf(text);
  if (actual !== ref.digest) {
    throw err.internal(
      CODES.E_PAYLOAD_UNRESOLVED,
      `payload ${ref.digest} resolved to ${actual} — the stored bytes are not the bytes the journal recorded`,
      { details: { runId, expected: ref.digest, actual } },
    );
  }
  return JSON.parse(text);
}

/**
 * Durable, and a directory rather than a table.
 *
 * A SQLite table would have meant a schema migration on the one file every running deployment
 * already has open, for bytes that are pure content-addressed blobs with no relational question
 * to ask of them. A directory of `<runId>/<sha>.json` is durable in the same way, is inspectable
 * with `ls` and `du` — which `journal/store.ts` names as the operator's only current symptom of
 * the amplification — and adds nothing to the journal's own recovery path.
 *
 * BOTH PATH SEGMENTS ARE CHECKED, not assumed. A `RunId` is a ULID and a digest is hex today,
 * and "today" is the word that makes an unchecked `join` a traversal later: this store is handed
 * ids that come out of a journal, and a journal is a file an operator can hand to a tool.
 * Refusing is always allowed.
 */
export function filePayloads(dir: string): PayloadStore {
  const cellPath = (runId: RunId, d: Digest): string => {
    const hex = d.slice("sha256:".length);
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(String(runId)) || !/^[0-9a-f]{64}$/.test(hex)) {
      throw err.internal(CODES.E_PAYLOAD_UNRESOLVED, `refusing a payload path built from ${String(runId)}/${d}`, {
        details: { runId, digest: d },
      });
    }
    return join(dir, String(runId), `${hex}.json`);
  };
  return {
    async put(runId, canonical) {
      const ref = refFor(canonical);
      const path = cellPath(runId, ref.digest);
      await mkdir(dirname(path), { recursive: true });
      // Written under a temporary name and renamed, because a reader that finds a half-written
      // file finds a DIGEST MISMATCH — a loud refusal for what is only a crash mid-write.
      // Rename is atomic within a directory.
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, canonical, "utf8");
      await rename(tmp, path);
      return ref;
    },
    async get(runId, ref) {
      const path = cellPath(runId, ref.digest);
      let text: string | undefined;
      try {
        text = await readFile(path, "utf8");
      } catch {
        text = undefined;
      }
      return verified(runId, ref, text);
    },
  };
}

/** For tests and for an embedder that keeps a run in one process. NOT durable. */
export function memoryPayloads(): PayloadStore {
  const cells = new Map<string, string>();
  return {
    async put(runId, canonical) {
      const ref = refFor(canonical);
      cells.set(`${runId} ${ref.digest}`, canonical);
      return ref;
    },
    async get(runId, ref) {
      return verified(runId, ref, cells.get(`${runId} ${ref.digest}`));
    },
  };
}
