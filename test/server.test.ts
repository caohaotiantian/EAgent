/**
 * The HTTP server front end, driven against a real (offline, mock-backed)
 * server on an ephemeral port.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createHttpServer } from "../src/server.js";
import { silentLogger } from "./helpers.js";

async function withServer(
  fn: (base: string) => Promise<void>,
  opts: { token?: string; maxBodyBytes?: number } = {},
): Promise<void> {
  const { server } = await createHttpServer({ provider: "mock", logger: silentLogger, ...opts });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("GET /health reports model and extensions", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; model: string; extensions: string[] };
    assert.equal(body.ok, true);
    assert.ok(body.extensions.includes("core-tools"));
    assert.ok(body.extensions.includes("web"));
  });
});

test("POST /run streams lifecycle events as JSONL", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "hello server" }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    const events = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string });
    const types = events.map((e) => e.type);
    assert.ok(types.includes("message"), "should stream a message event");
    assert.ok(types.includes("usage"), "should stream a usage event");
    assert.equal(events.at(-1)?.type, "done");
  });
});

test("a session id makes /run accumulate conversation history", async () => {
  await withServer(async (base) => {
    const run = async (input: string) => {
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input, session: "s1" }),
      });
      return (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as { type: string; role?: string; content?: { type: string; text?: string }[] });
    };
    await run("first message");
    const second = await run("second message");
    // The replayed history means the provider saw more than one user turn;
    // health should report one tracked session.
    const done = second.at(-1) as { type: string; session?: string };
    assert.equal(done.session, "s1");

    const health = await (await fetch(`${base}/health`)).json();
    assert.equal((health as { sessions: number }).sessions, 1);

    // Deleting the session forgets it.
    const del = await fetch(`${base}/sessions/s1`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const health2 = await (await fetch(`${base}/health`)).json();
    assert.equal((health2 as { sessions: number }).sessions, 0);
  });
});

test("POST /run rejects a missing input", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

test("a configured token gates mutating routes but not /health", async () => {
  await withServer(
    async (base) => {
      // /health is open.
      assert.equal((await fetch(`${base}/health`)).status, 200);
      // /run without a token is rejected.
      const noauth = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(noauth.status, 401);
      await noauth.text();
      // /run with the correct bearer token succeeds.
      const ok = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
        body: JSON.stringify({ input: "hi" }),
      });
      assert.equal(ok.status, 200);
      await ok.text();
    },
    { token: "secret" },
  );
});

test("an oversized request body is rejected with 413", async () => {
  await withServer(
    async (base) => {
      const big = "x".repeat(200);
      const res = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: big }),
      });
      assert.equal(res.status, 413);
      await res.text();
    },
    { maxBodyBytes: 50 },
  );
});

test("unknown routes 404 with the route list", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { routes: string[] };
    assert.ok(Array.isArray(body.routes));
  });
});
