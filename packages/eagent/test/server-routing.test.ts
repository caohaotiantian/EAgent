/**
 * The HTTP auth boundary after the static-serving surface was removed.
 *
 * Two routes are deliberately reachable without a Bearer token: `/health` (for
 * liveness probes) and a bare `/` (a plain-text courtesy for a human hitting the
 * host in a browser). Everything else must be gated when a token is set. The
 * previous static branch was auth-EXEMPT so the SPA could boot before a token
 * prompt; with it gone, every path it used to catch must now fall through to the
 * Bearer check rather than silently staying open. That property had no test —
 * `test/server-static.test.ts` was its only cover and was deleted with the SPA.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createHttpServer, isApiPath, type HttpServer } from "../src/server.ts";

const TOKEN = "test-token";
let http: HttpServer;
let base: string;

before(async () => {
  http = await createHttpServer({ token: TOKEN, provider: "mock", persistSessions: false });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = http.server.address();
  if (addr === null || typeof addr === "string") throw new Error("expected a TCP address");
  base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve) => http.server.close(() => resolve()));
  await http.close();
});

const get = (path: string, token?: string): Promise<Response> =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test("/health is open without a token", async () => {
  const res = await get("/health");

  assert.equal(res.status, 200);
  assert.equal(((await res.json()) as { ok: boolean }).ok, true);
});

test("a bare / is open and answers in plain text, not HTML", async () => {
  const res = await get("/");

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(await res.text(), /EAgent HTTP API is up/);
});

test("a path the SPA used to serve is now gated, not silently open", async () => {
  for (const path of ["/index.html", "/assets/index.js", "/favicon.ico"]) {
    const res = await get(path);
    assert.equal(res.status, 401, `${path} must require a token now that static serving is gone`);
  }
});

test("a former static path 404s once authorized — it is not served from disk", async () => {
  const res = await get("/index.html", TOKEN);

  assert.equal(res.status, 404, "no file is served for it");
});

test("API routes require the token and accept it", async () => {
  assert.equal((await get("/sessions")).status, 401, "unauthenticated is rejected");
  assert.equal((await get("/sessions", TOKEN)).status, 200, "the Bearer token is accepted");
});

test("a traversal attempt is rejected, never resolved against a filesystem root", async () => {
  for (const path of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
    const res = await get(path);
    assert.ok(res.status === 401 || res.status === 404, `${path} must not be served (got ${res.status})`);
    assert.doesNotMatch(await res.text(), /root:/, "no file content leaked");
  }
});

test("isApiPath still covers every reserved prefix the router relies on", () => {
  for (const p of ["/health", "/run", "/answer", "/events", "/sessions", "/sessions/abc", "/sessions/abc/events"]) {
    assert.equal(isApiPath(p), true, `${p} must be recognised as an API path`);
  }
  for (const p of ["/", "/index.html", "/assets/app.js"]) {
    assert.equal(isApiPath(p), false, `${p} must not be recognised as an API path`);
  }
});
