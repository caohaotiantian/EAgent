/**
 * THE JOURNAL'S DURABILITY ARGUMENT DID NOT FOLLOW THE PAYLOAD OUT OF THE JOURNAL.
 *
 * `SqliteStateStoreOptions.synchronous` defaults to FULL on the stated grounds that "invariant 8
 * admits no exception for the journal" — so an appended `task.committed{external:{ch:{digest}}}`
 * is on the platter. `filePayloads.put` wrote the bytes that digest NAMES with `writeFile` +
 * `rename` and no fsync at all, so after power loss the journal could assert a value the store
 * no longer holds — permanently, because the digest sits in an append-only row nothing can
 * rewrite. The rename comment reasoned about a crash MID-write, which the rename does handle; it
 * did not reason about a crash AFTER a successful rename, which is the case fsync is for.
 *
 * fsync is not observable from a test that only reads files back, so this counts the syncs the
 * implementation performs, by size, on the shared `FileHandle` prototype: one on a handle whose
 * stat is the canonical bytes (the payload), one on a handle whose stat is a directory (so the
 * rename itself survives). Before the fix that count was 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { filePayloads } from "../../src/journal/payloads.ts";
import type { RunId } from "../../src/ids.ts";

const RUN = "01JRUNPAYLOAD00000000000AB" as RunId;

/** The FileHandle prototype is shared and reachable only from an instance. */
async function fileHandleProto(dir: string): Promise<{ sync: () => Promise<void> }> {
  const fh = await open(join(dir, "probe"), "w");
  const proto = Object.getPrototypeOf(fh) as { sync: () => Promise<void> };
  await fh.close();
  return proto;
}

test("filePayloads.put fsyncs the payload AND its directory before returning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-payload-durable-"));
  const proto = await fileHandleProto(dir);
  const original = proto.sync;
  const synced: string[] = [];
  try {
    proto.sync = async function patched(this: { stat: () => Promise<{ isDirectory: () => boolean; size: number }> }) {
      const st = await this.stat();
      synced.push(st.isDirectory() ? "dir" : `file:${st.size}`);
      return original.call(this);
    };

    const store = filePayloads(dir);
    const canonical = JSON.stringify({ big: "x".repeat(1000) });
    const ref = await store.put(RUN, canonical);

    assert.ok(
      synced.includes(`file:${Buffer.byteLength(canonical, "utf8")}`),
      `the payload's own bytes must be synced; saw ${JSON.stringify(synced)}`,
    );
    assert.ok(synced.includes("dir"), `the containing directory must be synced so the rename survives; saw ${JSON.stringify(synced)}`);

    // …and the ordinary case still works: the value reads back and verifies against its digest.
    assert.deepEqual(await store.get(RUN, ref), JSON.parse(canonical));
  } finally {
    proto.sync = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("put stays idempotent and get still refuses a payload that is not there", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-payload-durable-"));
  try {
    const store = filePayloads(dir);
    const canonical = '{"a":1}';
    const first = await store.put(RUN, canonical);
    const second = await store.put(RUN, canonical);
    assert.deepEqual(first, second, "content addressing makes the second write the same key");
    assert.deepEqual(await store.get(RUN, first), { a: 1 });
    await assert.rejects(
      () => store.get(RUN, { digest: `sha256:${"0".repeat(64)}` as never, bytes: 1 }),
      /E_PAYLOAD_UNRESOLVED|unresolved|payload/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
