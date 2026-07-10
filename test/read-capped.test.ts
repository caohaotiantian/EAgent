import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readCapped, readFileCapped } from "../src/extensions/lib/read-capped.js";

test("readFileCapped bounds a large file and flags truncation", () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-readfilecapped-"));
  const path = join(dir, "big");
  writeFileSync(path, Buffer.alloc(1000, 0x41)); // 1000 'A' bytes
  const capped = readFileCapped(path, 100);
  assert.equal(capped.buf.length, 100, "reads only the cap window");
  assert.equal(capped.truncated, true, "flags that the file exceeded the cap");
  const whole = readFileCapped(path, 5000);
  assert.equal(whole.buf.length, 1000, "reads the whole file when under the cap");
  assert.equal(whole.truncated, false);
});

// In-memory stream helpers for the readCapped unit tests — no network.
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

// T3 — readCapped(stream, maxBytes, 0) is byte-identical to today (crit 2).
test("readCapped with startIndex=0 reproduces today's window exactly", async () => {
  // under-cap body: full text, not truncated.
  const under = await readCapped(streamOf(bytesOf("hello"), bytesOf(" world")), 100, 0);
  assert.equal(under.text, "hello world");
  assert.equal(under.bytes, 11);
  assert.equal(under.truncated, false);

  // over-cap body: first maxBytes bytes, truncated.
  const src = "0123456789ABCDEFGHIJ"; // 20 ASCII bytes
  const over = await readCapped(streamOf(bytesOf(src.slice(0, 7)), bytesOf(src.slice(7))), 10, 0);
  assert.equal(over.bytes, 10);
  assert.equal(over.truncated, true);
  assert.equal(over.text, src.slice(0, 10));
});

// T4 — readCapped skips startIndex bytes incl. boundary-straddle and
// past-the-end (crit 3, 4, 7).
test("readCapped skips startIndex bytes and windows the next maxBytes (crit 3)", async () => {
  const src = "0123456789ABCDEFGHIJKLMNOPQRST"; // 30 ASCII bytes
  const r = await readCapped(streamOf(bytesOf(src)), 10, 10);
  assert.equal(r.text, src.slice(10, 20)); // bytes [10,20)
  assert.equal(r.bytes, 10);
  assert.equal(r.truncated, true); // 10 bytes remain after the window
});

test("readCapped skip is exact when a chunk straddles the boundary (crit 4)", async () => {
  const src = "0123456789ABCDEFGHIJKLMNOPQRST"; // 30 ASCII bytes
  // 7-byte chunks: 0-6, 7-13, 14-20, 21-27, 28-29 — chunk #2 (7-13) straddles
  // startIndex=10, so only its leading 3 bytes (7,8,9) must be dropped.
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < src.length; i += 7) chunks.push(bytesOf(src.slice(i, i + 7)));
  const r = await readCapped(streamOf(...chunks), 10, 10);
  assert.equal(r.text, src.slice(10, 20));
  assert.equal(r.bytes, 10);
  assert.equal(r.truncated, true);
});

test("readCapped past-the-end yields an empty, non-truncated window (crit 7)", async () => {
  const src = "0123456789"; // 10 bytes
  const r = await readCapped(streamOf(bytesOf(src)), 10, 50);
  assert.equal(r.text, "");
  assert.equal(r.bytes, 0);
  assert.equal(r.truncated, false);
});
