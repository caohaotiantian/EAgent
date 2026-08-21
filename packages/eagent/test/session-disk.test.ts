/**
 * HTTP session on-disk store (parse/write/list) + server round-trip across
 * process restarts (new createHttpServer, same sessionsDir).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  listDiskSessionSummaries,
  parseSessionFile,
  readSessionFile,
  writeSessionFile,
} from "../src/session-disk.ts";
import { createHttpServer, type HttpServer } from "../src/server.ts";
import type { MockProvider } from "../src/providers/mock.ts";
import { unwrapProvider } from "../src/extensions/lib/provider-wrap.ts";
import { silentLogger } from "./helpers.ts";

test("parseSessionFile rejects bad envelopes", () => {
  assert.equal(parseSessionFile(null), undefined);
  assert.equal(parseSessionFile({ version: 99, session: "s", messages: [] }), undefined);
  assert.equal(parseSessionFile({ version: 1, session: "s", messages: "nope" }), undefined);
});

test("write/read/list session files", () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-sess-"));
  try {
    writeSessionFile(dir, {
      version: 1,
      savedAt: "2026-01-01T00:00:00.000Z",
      session: "abc/def",
      model: "mock",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      usage: { inputTokens: 2, outputTokens: 3 },
      costUsd: 0.01,
    });
    const got = readSessionFile(dir, "abc/def");
    assert.ok(got);
    assert.equal(got!.messages[0]!.role, "user");
    assert.equal(got!.usage.inputTokens, 2);
    const list = listDiskSessionSummaries(dir);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, "abc/def");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function withServer(
  sessionsDir: string,
  fn: (base: string, http: HttpServer) => Promise<void>,
): Promise<void> {
  const http = await createHttpServer({
    provider: "mock",
    logger: silentLogger,
    sessionsDir,
    persistSessions: true,
  });
  await new Promise<void>((resolve) => http.server.listen(0, "127.0.0.1", resolve));
  const addr = http.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, http);
  } finally {
    await new Promise<void>((resolve) => http.server.close(() => resolve()));
    await http.close();
  }
}

function mockOf(http: HttpServer): MockProvider {
  return unwrapProvider(http.agent.providers.get("mock")!) as MockProvider;
}

test("HTTP sessions survive a server restart via disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-http-sess-"));
  try {
    // Server A: run a turn, then shut down.
    await withServer(dir, async (base, http) => {
      mockOf(http).script({ text: "persisted-hello" });
      const r = await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "remember me", session: "persist-1" }),
      });
      assert.equal(r.status, 200);
      await r.text();
    });

    // Server B: same sessionsDir, empty memory — must reload from disk.
    await withServer(dir, async (base) => {
      const list = (await (await fetch(`${base}/sessions`)).json()) as Array<{ id: string }>;
      assert.ok(list.some((s) => s.id === "persist-1"), "disk session listed after restart");

      const detail = (await (await fetch(`${base}/sessions/persist-1`)).json()) as {
        messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
      };
      assert.ok(detail.messages.length >= 2);
      assert.equal(detail.messages[0]!.role, "user");
      const asst = detail.messages.find((m) => m.role === "assistant");
      assert.ok(asst);
      const text = asst!.content.find((b) => b.type === "text")?.text;
      assert.equal(text, "persisted-hello");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DELETE removes the on-disk session file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-http-del-"));
  try {
    await withServer(dir, async (base, http) => {
      mockOf(http).script({ text: "bye" });
      await (await fetch(`${base}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "x", session: "del-me" }),
      })).text();
      const del = await fetch(`${base}/sessions/del-me`, { method: "DELETE" });
      assert.equal(del.status, 200);
    });
    assert.equal(readSessionFile(dir, "del-me"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
