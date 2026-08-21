/**
 * The shared provider plumbing: the SSE parser must reassemble events that are
 * split across arbitrary chunk boundaries (real network reads do not align to
 * event boundaries), and the retry/backoff helper must honor abort.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSSE, fetchWithRetry, maxSseEventBytes } from "../src/providers/http.ts";

/** A stream that emits exactly the given byte chunks, in order. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const msg of parseSSE(body)) out.push(msg.data);
  return out;
}

test("reassembles SSE events split mid-event across chunks", async () => {
  // One event ("hello world") arrives in three fragments, the boundary "\n\n"
  // itself straddling two chunks; a second event follows.
  const data = await collect(
    streamOf(["data: hel", "lo wor", "ld\n", "\ndata: second\n\n"]),
  );
  assert.deepEqual(data, ["hello world", "second"]);
});

test("joins multiple data: lines within one event", async () => {
  const data = await collect(streamOf(["data: line1\ndata: line2\n\n"]));
  assert.deepEqual(data, ["line1\nline2"]);
});

test("ignores event: and comment lines, keeping data", async () => {
  const data = await collect(streamOf(["event: ping\ndata: {\"x\":1}\n\n"]));
  assert.deepEqual(data, ['{"x":1}']);
});

test("parses events delimited and split by CRLF line endings", async () => {
  // A proxy emitting CRLF must not stall the parser (regression: indexOf("\n\n")).
  const data = await collect(streamOf(["data: a\r\n\r\n", "data: b\r\n\r\n"]));
  assert.deepEqual(data, ["a", "b"]);
});

test("strips only a single leading space from data, preserving the rest", async () => {
  const data = await collect(streamOf(["data:  two leading spaces\n\n"]));
  assert.deepEqual(data, [" two leading spaces"]);
});

test("fetchWithRetry aborts cleanly during backoff", async () => {
  const controller = new AbortController();
  const fetchImpl = (async () =>
    new Response("rate", { status: 429, headers: { "retry-after": "5" } })) as unknown as typeof fetch;
  // Abort shortly after the first attempt enters backoff.
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(
    () =>
      fetchWithRetry({
        url: "http://example/x",
        headers: {},
        body: {},
        signal: controller.signal,
        fetchImpl,
        maxRetries: 5,
        describe: (s, d) => `err ${s}: ${d}`,
      }),
    /aborted/,
  );
});

// -- SRV-4: parseSSE bounds a single un-terminated event (OOM guard) --

test("SRV-4: parseSSE throws on an un-terminated event that exceeds the cap (bounds OOM)", async () => {
  const prev = process.env.EAGENT_MAX_SSE_EVENT_BYTES;
  process.env.EAGENT_MAX_SSE_EVENT_BYTES = "64";
  try {
    await assert.rejects(
      () => collect(streamOf(["data: " + "x".repeat(200)])), // no "\n\n", > 64 bytes
      /exceeded 64 bytes/,
      "an un-terminated oversized event must throw, not grow the buffer without bound",
    );
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MAX_SSE_EVENT_BYTES;
    else process.env.EAGENT_MAX_SSE_EVENT_BYTES = prev;
  }
});

test("SRV-4: a long stream of terminated small events does NOT hit the cap (only the incomplete buffer is bounded)", async () => {
  const prev = process.env.EAGENT_MAX_SSE_EVENT_BYTES;
  process.env.EAGENT_MAX_SSE_EVENT_BYTES = "64";
  try {
    const chunks = Array.from({ length: 50 }, (_, i) => `data: e${i}\n\n`);
    const data = await collect(streamOf(chunks));
    assert.equal(data.length, 50, "all terminated events yield; the cap is per incomplete event, not total throughput");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MAX_SSE_EVENT_BYTES;
    else process.env.EAGENT_MAX_SSE_EVENT_BYTES = prev;
  }
});

test("SRV-4: maxSseEventBytes parses the env with a 16 MiB default", () => {
  const prev = process.env.EAGENT_MAX_SSE_EVENT_BYTES;
  try {
    delete process.env.EAGENT_MAX_SSE_EVENT_BYTES;
    assert.equal(maxSseEventBytes(), 16 * 1024 * 1024, "unset → 16 MiB");
    for (const bad of ["abc", "0", "-5", "1.5", ""]) {
      process.env.EAGENT_MAX_SSE_EVENT_BYTES = bad;
      assert.equal(maxSseEventBytes(), 16 * 1024 * 1024, `${JSON.stringify(bad)} → default`);
    }
    process.env.EAGENT_MAX_SSE_EVENT_BYTES = "1024";
    assert.equal(maxSseEventBytes(), 1024, "a positive integer overrides");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MAX_SSE_EVENT_BYTES;
    else process.env.EAGENT_MAX_SSE_EVENT_BYTES = prev;
  }
});
