// A byte-bounded reader over a `ReadableStream<Uint8Array>`: it collects a
// ≤ `maxBytes` window starting at byte `startIndex`, never buffering the whole
// body, so a huge or hostile response cannot exhaust memory. It lives in `lib/`
// so any extension that reads a foreign stream at arm's length can share it
// (currently `web`'s `fetch_url` / `/fetch`). It also exports a file-path
// analogue, `readFileCapped`, for the built-in read/edit/grep tools.

import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Read `body` as UTF-8 text but stop once `maxBytes` bytes have been consumed.
 * Streaming the reader (rather than buffering the whole response then slicing)
 * means a huge or hostile response never fully lands in memory.
 *
 * `startIndex` (default 0) is a **byte** offset: the reader stream-skips and
 * discards the first `startIndex` bytes — never buffering them — then collects
 * the next ≤ `maxBytes` bytes. That slice is the *window*. Memory stays
 * O(maxBytes) regardless of how large `startIndex` or the body is. A chunk that
 * straddles the `startIndex` boundary has only its leading prefix dropped; its
 * remainder feeds the window, so the window begins at exactly byte `startIndex`.
 * `truncated` means "more bytes remained after the window"; a `startIndex` at or
 * past the end yields an empty, non-truncated window.
 *
 * Exported as a named export so the byte-window logic is unit-testable directly
 * over an in-memory `ReadableStream` (mirrors `recovery.ts`'s exported helpers).
 */
/**
 * Read a file into memory but never buffer more than `maxBytes`: a `statSync`
 * size check plus a single bounded `readSync`, so a huge or hostile file cannot
 * exhaust process memory (the file/path analogue of `readCapped`'s stream cap).
 * `truncated` is true when the file was larger than `maxBytes` — only the
 * leading `maxBytes`-byte window was read.
 */
export function readFileCapped(path: string, maxBytes: number): { buf: Buffer; truncated: boolean } {
  const size = statSync(path).size;
  const cap = Math.min(size, Math.max(0, Math.floor(maxBytes)));
  const buf = Buffer.alloc(cap);
  const fd = openSync(path, "r");
  try {
    let read = 0;
    while (read < cap) {
      const n = readSync(fd, buf, read, cap - read, read);
      if (n === 0) break;
      read += n;
    }
    return { buf: read === cap ? buf : buf.subarray(0, read), truncated: size > maxBytes };
  } finally {
    closeSync(fd);
  }
}

export async function readCapped(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  startIndex = 0,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  let truncated = false;
  let skipped = 0; // bytes discarded so far while seeking to `startIndex`
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      // Phase 1 — stream-and-discard until `startIndex` bytes have passed. We
      // only count bytes; skipped bytes are never decoded (byte offset).
      let chunk = value;
      if (skipped < startIndex) {
        const need = startIndex - skipped;
        if (chunk.byteLength <= need) {
          skipped += chunk.byteLength;
          continue; // whole chunk is in the skip region
        }
        // This chunk straddles the boundary: drop only its leading prefix.
        skipped = startIndex;
        chunk = chunk.subarray(need);
      }

      // Phase 2 — collect up to `maxBytes` from the post-skip bytes.
      const remaining = maxBytes - bytes;
      if (chunk.byteLength > remaining) {
        chunks.push(decoder.decode(chunk.subarray(0, remaining), { stream: false }));
        bytes = maxBytes;
        truncated = true;
        break;
      }
      bytes += chunk.byteLength;
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
  } finally {
    // Releasing the lock and cancelling lets the connection close promptly when
    // we stop early at the cap.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { text: chunks.join(""), bytes, truncated };
}
