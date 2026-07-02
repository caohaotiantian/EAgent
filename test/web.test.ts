import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { test, after, before } from "node:test";

import web, { continuationHint } from "../src/extensions/web.js";
import { clearTraceparent, setTraceparent, traceparent } from "../src/extensions/lib/otel-context.js";
import type { Message, ToolContext } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

// ---------------------------------------------------------------------------
// Fixture server: a tiny node:http server on an ephemeral port. It records the
// paths it is asked for so a test can prove the tool body never ran when the
// capability is denied.
// ---------------------------------------------------------------------------

const hits: string[] = [];
let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    hits.push(path);
    if (path === "/hello") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello world");
      return;
    }
    if (path === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("X".repeat(5000));
      return;
    }
    if (path === "/paged") {
      // A 200-byte body whose two halves are distinguishable, so a tail window
      // is provably the tail: first 100 bytes "A", next 100 bytes "B".
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("A".repeat(100) + "B".repeat(100));
      return;
    }
    if (path === "/notfound") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("missing");
      return;
    }
    if (path === "/echo" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(Buffer.concat(chunks).toString("utf8"));
      });
      return;
    }
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("unhandled");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

/** Find the last tool-result message and return its content + error flag. */
function lastToolResult(messages: readonly Message[]): { content: string; isError: boolean } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    const block = m.content[0];
    if (block && block.type === "tool_result") {
      return { content: block.content, isError: block.isError === true };
    }
  }
  throw new Error("no tool result message found");
}

test("GET /hello returns the body with a 200 status, not an error", async () => {
  const { agent, host } = makeHarness({
    responder: [{ toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/hello` } }] }, { text: "done" }],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("fetch hello");
  const result = lastToolResult(agent.messages);
  assert.equal(result.isError, false);
  assert.match(result.content, /hello world/);
  assert.match(result.content, /^200 /);
  await host.dispose();
});

test("size cap truncates the body and marks it truncated", async () => {
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/big`, maxBytes: 100 } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("fetch big");
  const result = lastToolResult(agent.messages);
  assert.match(result.content, /truncated/);
  // Default-on (web-paginate): the truncated branch now emits an actionable
  // continuation hint, not the dead-end marker. The marker is reconciled here
  // to the new default; the EAGENT_WEB_PAGINATE=off path still proves the
  // legacy marker (see the kill-switch test below).
  assert.match(result.content, /start_index=\d+/);
  assert.ok(!/…\[truncated\]/.test(result.content), "default-on truncation must not emit the legacy marker");
  // 100-byte cap on a 5000-byte body: the payload portion must be far shorter.
  assert.ok(result.content.length < 5000, "body should be truncated below the full size");
  await host.dispose();
});

test("404 yields an error-flagged result that includes the body", async () => {
  const { agent, host } = makeHarness({
    responder: [{ toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/notfound` } }] }, { text: "done" }],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("fetch missing");
  const result = lastToolResult(agent.messages);
  assert.equal(result.isError, true);
  assert.match(result.content, /404/);
  assert.match(result.content, /missing/);
  await host.dispose();
});

test("net:fetch gate blocks the tool and no request reaches the server", async () => {
  const before = hits.length;
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/hello` } }] },
      { text: "done" },
    ],
    fallback: "deny",
  });
  await host.use("web", web);
  await agent.run("fetch hello");
  const result = lastToolResult(agent.messages);
  assert.equal(result.isError, true);
  assert.match(result.content, /denied/i);
  // Proof the tool body never executed: the fixture recorded no new hits.
  assert.equal(hits.length, before, "denied tool must not have issued a request");
  await host.dispose();
});

test("POST /echo returns the echoed request body", async () => {
  const { agent, host } = makeHarness({
    responder: [
      {
        toolCalls: [
          { name: "fetch_url", arguments: { url: `${base}/echo`, method: "POST", body: "ping-123" } },
        ],
      },
      { text: "done" },
    ],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("post echo");
  const result = lastToolResult(agent.messages);
  assert.equal(result.isError, false);
  assert.match(result.content, /ping-123/);
  await host.dispose();
});

// ===========================================================================
// web-paginate — start_index continuation (design 2026-06-22-web-paginate)
// ===========================================================================

// T2 — schema advertises start_index (crit 1). The model must be told fetch_url
// accepts an optional byte offset start_index that defaults to 0.
test("fetch_url schema advertises an optional start_index byte offset (default 0)", async () => {
  const { agent, host } = makeHarness({ responder: [], fallback: "allow" });
  await host.use("web", web);
  const tool = agent.tools.get("fetch_url");
  assert.ok(tool, "fetch_url tool must be registered");
  const props = tool.spec.parameters.properties;
  assert.ok(props, "fetch_url must declare parameter properties");
  const startIndex = props.start_index;
  assert.ok(startIndex, "fetch_url must advertise a start_index parameter");
  assert.equal(startIndex.type, "integer");
  assert.equal(startIndex.default, 0);
  assert.equal(typeof startIndex.description, "string");
  assert.match(String(startIndex.description), /byte/i);
  // Backward compatible: start_index is optional, not required.
  assert.ok(!(tool.spec.parameters.required ?? []).includes("start_index"));
  await host.dispose();
});

// T5 (unit) — continuation hint carries the right N and replaces the marker
// (crit 5). N = startIndex + bytesShown.
test("continuationHint computes N = startIndex + bytesShown and omits the marker", () => {
  assert.match(continuationHint(0 + 100), /start_index=100/);
  assert.match(continuationHint(100 + 100), /start_index=200/);
  assert.ok(!/…\[truncated\]/.test(continuationHint(100)), "the hint must not carry the dead-end marker");
});

// T5 (integration) — truncated fetch returns the hint via the agent loop.
test("a truncated fetch_url returns a start_index continuation hint, not the marker", async () => {
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100 } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("page one");
  const result = lastToolResult(agent.messages);
  // First window is 100 bytes of "A"; N = 0 + 100 = 100.
  assert.match(result.content, /start_index=100/);
  assert.ok(!/…\[truncated\]/.test(result.content), "default-on truncation must not emit the legacy marker");
  await host.dispose();
});

// T6 — end-to-end paging reaches the tail (crit 6).
test("chained fetch_url calls page the whole body with no gap or overlap (crit 6)", async () => {
  const { agent, host } = makeHarness({
    responder: [
      // Turn 1: fetch the head, then stop so the result is observable.
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100 } }] },
      { text: "got the head" },
      // Turn 2: re-issue at the advancing offset, then stop.
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100, start_index: 100 } }] },
      { text: "got the tail" },
    ],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("page one");
  const first = lastToolResult(agent.messages);
  assert.match(first.content, /start_index=100/);
  // The first window is the head: 100 "A" bytes, no "B" yet.
  assert.match(first.content, /A{100}/);
  assert.ok(!/B/.test(first.content.replace(/^[^\n]*\n/, "")), "first window must be the head, not the tail");

  // Turn 2: re-issue the fetch at the advancing offset from the hint.
  await agent.run("page two");
  const second = lastToolResult(agent.messages);
  // The tail window is 100 "B" bytes and, fitting in one window, carries no hint.
  assert.match(second.content, /B{100}/);
  assert.ok(!/start_index=/.test(second.content), "the final tail window carries no continuation hint");
  assert.ok(!/…\[truncated\]/.test(second.content));

  // The two windows' payloads concatenate to the whole body with no gap.
  const payload = (c: string): string => c.slice(c.indexOf("\n") + 1).replace(/\nmore content available.*$/s, "");
  assert.equal(payload(first.content) + payload(second.content), "A".repeat(100) + "B".repeat(100));
  await host.dispose();
});

// T6 (tool-level) — a start_index at/past the body length yields a clean empty
// window through the agent loop: empty body, not an error, and NO continuation
// hint (the past-the-end window is non-truncated, so it is a clean end, not a
// dead-end). The /paged body is 200 bytes; start_index=200 is exactly past-the-end.
test("fetch_url past-the-end start_index returns a clean empty window with no continuation hint", async () => {
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100, start_index: 200 } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  await host.use("web", web);
  await agent.run("page past the end");
  const result = lastToolResult(agent.messages);

  // Not an error: a 200 OK whose window is simply empty.
  assert.equal(result.isError, false, "past-the-end is a clean 200, not an error");
  // The body after the status summary line is empty (0 bytes read).
  const body = result.content.slice(result.content.indexOf("\n") + 1);
  assert.equal(body, "", "the window body is empty past the end");
  assert.match(result.content, /· 0 bytes/, "the summary reports 0 bytes read");
  // No "more available" continuation hint and no legacy truncation marker:
  // a non-truncated empty window is a clean end, not a dead-end.
  assert.ok(!/start_index=/.test(result.content), "past-the-end window carries no continuation hint");
  assert.ok(!/…\[truncated\]/.test(result.content), "past-the-end window carries no truncation marker");
  await host.dispose();
});

// T6 — negative start_index clamps to 0; a non-numeric value is rejected by the
// kernel's integer-schema validator *before* execute runs (so it can never land
// at a bad offset). Both are safe outcomes (crit 8 — defensive clamp).
test("negative start_index clamps to 0; non-numeric is rejected by schema validation (crit 8)", async () => {
  async function fetchWith(startIndex: unknown): Promise<string> {
    const { agent, host } = makeHarness({
      responder: [
        { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100, start_index: startIndex } }] },
        { text: "done" },
      ],
      fallback: "allow",
    });
    await host.use("web", web);
    await agent.run("page");
    const r = lastToolResult(agent.messages);
    await host.dispose();
    return r.content;
  }
  const zero = await fetchWith(0);
  const negative = await fetchWith(-5);
  // Negative clamps to 0 via Math.max(0, …): identical window to start_index: 0.
  assert.equal(negative, zero, "negative start_index must behave like 0");
  // A truly non-numeric value is caught by the integer schema validator, never
  // reaching execute — the safe outcome (no read at a garbage offset).
  const nonNumeric = await fetchWith("not-a-number");
  assert.match(nonNumeric, /Invalid arguments for fetch_url/);
});

// T6 — kill switch restores legacy output (crit 9).
test("EAGENT_WEB_PAGINATE=off restores the legacy marker and ignores start_index (crit 9)", async () => {
  const prev = process.env.EAGENT_WEB_PAGINATE;
  process.env.EAGENT_WEB_PAGINATE = "off";
  try {
    const { agent, host } = makeHarness({
      responder: [
        // pass a non-zero start_index: under the kill switch it must be ignored.
        { toolCalls: [{ name: "fetch_url", arguments: { url: `${base}/paged`, maxBytes: 100, start_index: 100 } }] },
        { text: "done" },
      ],
      fallback: "allow",
    });
    await host.use("web", web);
    await agent.run("page off");
    const result = lastToolResult(agent.messages);
    assert.match(result.content, /…\[truncated\]/);
    assert.ok(!/start_index=/.test(result.content), "kill switch must not emit a continuation hint");
    // start_index ignored: window starts at byte 0 ("A"s, not the "B" tail).
    assert.match(result.content, /A{100}/);
    assert.ok(!/B/.test(result.content.replace(/^[^\n]*\n/, "")), "kill switch must read from byte 0");
    await host.dispose();
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WEB_PAGINATE;
    else process.env.EAGENT_WEB_PAGINATE = prev;
  }
});

// T6 — clean teardown (crit 10).
test("loading web and disposing does not throw (no new registration leaks)", async () => {
  const { host } = makeHarness({ responder: [], fallback: "allow" });
  await host.use("web", web);
  await assert.doesNotReject(host.dispose());
});

// RW7c-2 — the fetch tool propagates the OTel traceparent to allowlisted hosts only
test("RW7c-2: fetch_url injects traceparent for an allowlisted host, and never otherwise", async () => {
  const prevAllow = process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
  const origFetch = globalThis.fetch;
  const calls: { url: string; headers: Record<string, string> }[] = [];
  globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(u), headers: (init?.headers ?? {}) as Record<string, string> });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
  try {
    const { agent, host } = makeHarness({ responder: [], fallback: "allow" });
    await host.use("web", web);
    const tool = agent.tools.get("fetch_url")!;
    const run = (callId: string, url: string) =>
      tool.execute({ url }, { toolCallId: callId, signal: new AbortController().signal } as unknown as ToolContext);
    const TP = traceparent("a".repeat(32), "b".repeat(16));

    // otel published a traceparent for this call AND the host is allowlisted ⇒ injected.
    process.env.EAGENT_OTEL_PROPAGATE_HOSTS = "trusted.test";
    setTraceparent("tc-a", TP);
    await run("tc-a", "http://trusted.test/data");
    assert.equal(calls.find((c) => c.url.startsWith("http://trusted.test"))!.headers.traceparent, TP);

    // Published, but the host is NOT on the allowlist ⇒ no header.
    setTraceparent("tc-b", TP);
    await run("tc-b", "http://untrusted.test/data");
    assert.equal(calls.find((c) => c.url.startsWith("http://untrusted.test"))!.headers.traceparent, undefined);

    // No published traceparent (otel off) ⇒ no header even for an allowlisted host.
    await run("tc-none", "http://trusted.test/other");
    assert.equal(calls.find((c) => c.url === "http://trusted.test/other")!.headers.traceparent, undefined);

    clearTraceparent("tc-a");
    clearTraceparent("tc-b");
    await host.dispose();
  } finally {
    globalThis.fetch = origFetch;
    if (prevAllow === undefined) delete process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
    else process.env.EAGENT_OTEL_PROPAGATE_HOSTS = prevAllow;
  }
});
