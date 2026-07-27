/**
 * Static SPA serve + auth split (design 2026-07-27-web-frontend AC3).
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createHttpServer } from "../src/server.js";
import { silentLogger } from "./helpers.js";

async function withStaticServer(
  token: string | undefined,
  webRoot: string,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const http = await createHttpServer({
    provider: "mock",
    logger: silentLogger,
    token,
    webRoot,
  });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base);
  } finally {
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await http.close();
  }
}

test("AC3: static HTML without auth; sessions gated; SPA fallback; no SPA for API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>web</title><h1>marker-ui</h1>");
  writeFileSync(join(dir, "app.js"), "console.log(1)");
  try {
    const token = "secret-token";
    await withStaticServer(token, dir, async (base) => {
      // (a) GET / without Authorization → HTML
      {
        const r = await fetch(base + "/");
        assert.equal(r.status, 200);
        const t = await r.text();
        assert.match(t, /marker-ui/);
        assert.match(r.headers.get("content-type") ?? "", /html/);
      }
      // (b) health open
      {
        const r = await fetch(base + "/health");
        assert.equal(r.status, 200);
        const j = (await r.json()) as { ok: boolean; auth: string };
        assert.equal(j.ok, true);
        assert.equal(j.auth, "required");
      }
      // (c) sessions without token → 401
      {
        const r = await fetch(base + "/sessions");
        assert.equal(r.status, 401);
      }
      // (d) sessions with Bearer → 200 array
      {
        const r = await fetch(base + "/sessions", {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(r.status, 200);
        const j = await r.json();
        assert.ok(Array.isArray(j));
      }
      // (e) SPA entry is `/` only (hash client routes); assets still served
      {
        const r = await fetch(base + "/app.js");
        assert.equal(r.status, 200);
        assert.match(await r.text(), /console\.log/);
      }
      // reserved GET /run must not be SPA
      {
        const r = await fetch(base + "/run", {
          headers: { Authorization: `Bearer ${token}` },
        });
        assert.notEqual(r.status, 200);
        const body = await r.text();
        assert.doesNotMatch(body, /marker-ui/);
      }
      // (f) traversal via raw request path (fetch() may normalize ".." away)
      {
        const u = new URL(base);
        const { request } = await import("node:http");
        const status = await new Promise<number>((resolve, reject) => {
          const req = request(
            { hostname: u.hostname, port: u.port, path: "/../../etc/passwd", method: "GET" },
            (res) => {
              res.resume();
              res.on("end", () => resolve(res.statusCode ?? 0));
            },
          );
          req.on("error", reject);
          req.end();
        });
        assert.ok(status === 400 || status === 404, `status=${status}`);
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
