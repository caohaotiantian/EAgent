import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { test, after, before } from "node:test";

import web from "../src/extensions/web.js";
import type { Message } from "../src/kernel/types.js";
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
  assert.match(result.content, /…\[truncated\]/);
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
