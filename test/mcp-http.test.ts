/**
 * Tests for the MCP client extension's Streamable HTTP transport.
 *
 * We stand up a tiny in-process HTTP server with `node:http` that speaks
 * JSON-RPC 2.0 over MCP's 2025 Streamable HTTP shape: POST a single JSON-RPC
 * message, get one JSON-RPC response (here always `application/json`). It
 * implements just enough of the protocol — initialize (handing back a
 * `Mcp-Session-Id`), the initialized notification (202, empty), tools/list, and
 * tools/call for a `ping` tool — to prove the handshake, session handling, tool
 * registration, invocation, and the `/mcp` command. We also assert the client
 * advertises `text/event-stream` in `accept` and echoes the session id.
 */

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import activate from "../src/extensions/mcp.js";
import { clearTraceparent, setTraceparent, traceparent } from "../src/extensions/lib/otel-context.js";
import { makeHarness } from "./helpers.js";

const SESSION_ID = "sess-http-fixture-1";

let server: http.Server;
let url: string;
/** Observed request headers, keyed by JSON-RPC method, for later assertions. */
const seenHeaders: Record<string, http.IncomingHttpHeaders> = {};

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = await readBody(req);
    let msg: { id?: unknown; method?: string; params?: { arguments?: { msg?: string } } };
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const { id, method, params } = msg;
    if (method) seenHeaders[method] = req.headers;

    if (method === "notifications/initialized") {
      // A notification carries no id; acknowledge with 202 and an empty body.
      res.writeHead(202).end();
      return;
    }

    const json = (result: unknown, headers: http.OutgoingHttpHeaders = {}) => {
      res.writeHead(200, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    };

    if (method === "initialize") {
      json(
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "http-fixture", version: "1" },
        },
        { "mcp-session-id": SESSION_ID },
      );
    } else if (method === "tools/list") {
      json({
        tools: [
          {
            name: "ping",
            description: "ping",
            inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
          },
        ],
      });
    } else if (method === "tools/call") {
      const args = params?.arguments ?? {};
      // Designated args drive the HTTP read-cap tests (AC2/AC3): an oversized or
      // within-cap SSE body, or an oversized JSON body. The default is the echo.
      if (args.msg === "__oversize_sse__" || args.msg === "__small_sse__") {
        const text = args.msg === "__oversize_sse__" ? "x".repeat(8 * 1024) : "ok";
        const data = JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${data}\n\n`);
      } else if (args.msg === "__oversize_json__") {
        json({ content: [{ type: "text", text: "x".repeat(8 * 1024) }] });
      } else if (args.msg === "__stall_body__") {
        // Flush headers, then hold the body open forever — exercises the request
        // deadline spanning the BODY read, not just time-to-headers (GEN-3). A
        // client abort (the timeout) closes the request, so we destroy then.
        res.writeHead(200, { "content-type": "application/json" });
        res.write("{"); // a partial body that never completes
        req.on("close", () => res.destroy());
      } else {
        json({ content: [{ type: "text", text: "pong: " + args.msg }] });
      }
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/mcp`;
  process.env.EAGENT_MCP_SERVERS = JSON.stringify([{ name: "httpfix", url }]);
});

after(async () => {
  delete process.env.EAGENT_MCP_SERVERS;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("registers the HTTP server's tool after the handshake", async () => {
  const { agent, host } = makeHarness({ fallback: "allow" });
  await host.use("mcp", activate);
  try {
    assert.ok(agent.tools.has("mcp__httpfix__ping"), "expected mcp__httpfix__ping to be registered");
    // The client must advertise SSE support and echo the session id onward.
    assert.match(String(seenHeaders["initialize"]?.accept ?? ""), /text\/event-stream/);
    assert.equal(seenHeaders["tools/list"]?.["mcp-session-id"], SESSION_ID);
  } finally {
    await host.dispose();
  }
});

test("calling the MCP tool over HTTP returns the server's textual result", async () => {
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "hi" } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  await host.use("mcp", activate);
  try {
    await agent.run("please ping");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    assert.ok(toolMsg, "expected a tool-role message in the transcript");
    const block = toolMsg!.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.match(block.content, /pong: hi/);
    assert.ok(!block.isError, "result should not be an error");
  } finally {
    await host.dispose();
  }
});

test("AC2: an oversized SSE HTTP reply is capped and surfaced as an 'exceeded' error", async () => {
  const prev = process.env.EAGENT_MAX_MCP_READ_BYTES;
  // Cap above the handshake/reply sizes (so the handshake registers the tool) but
  // far below the ~8 KiB oversized SSE body.
  process.env.EAGENT_MAX_MCP_READ_BYTES = "2048";
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "__oversize_sse__" } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  try {
    await host.use("mcp", activate);
    // The handshake read the same #readResponse path under the cap and succeeded.
    assert.ok(agent.tools.has("mcp__httpfix__ping"), "expected the handshake to register the tool under the cap");
    await agent.run("please ping");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.ok(block.isError, "an oversized SSE reply must surface as an error");
    assert.match(block.content, /exceeded/);
  } finally {
    await host.dispose();
    if (prev === undefined) delete process.env.EAGENT_MAX_MCP_READ_BYTES;
    else process.env.EAGENT_MAX_MCP_READ_BYTES = prev;
  }
});

test("GEN-3: an HTTP MCP server that stalls the body times out (deadline spans the read)", async () => {
  const prev = process.env.EAGENT_MCP_REQUEST_TIMEOUT_MS;
  process.env.EAGENT_MCP_REQUEST_TIMEOUT_MS = "150"; // ample for the instant handshake, tight for the stall
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "__stall_body__" } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  try {
    await host.use("mcp", activate);
    assert.ok(agent.tools.has("mcp__httpfix__ping"), "the handshake completed within the timeout");
    await agent.run("please ping");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.ok(block.isError, "a stalled response body must surface as an error, not hang the turn");
    assert.match(block.content, /timed out/, "the deadline fired during the body read");
  } finally {
    await host.dispose();
    if (prev === undefined) delete process.env.EAGENT_MCP_REQUEST_TIMEOUT_MS;
    else process.env.EAGENT_MCP_REQUEST_TIMEOUT_MS = prev;
  }
});

test("AC2: a within-cap SSE HTTP reply parses and resolves normally", async () => {
  const prev = process.env.EAGENT_MAX_MCP_READ_BYTES;
  process.env.EAGENT_MAX_MCP_READ_BYTES = "2048";
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "__small_sse__" } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  try {
    await host.use("mcp", activate);
    await agent.run("please ping");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.ok(!block.isError, "a within-cap SSE reply should not be an error");
    assert.match(block.content, /ok/);
  } finally {
    await host.dispose();
    if (prev === undefined) delete process.env.EAGENT_MAX_MCP_READ_BYTES;
    else process.env.EAGENT_MAX_MCP_READ_BYTES = prev;
  }
});

test("AC3: an oversized JSON HTTP reply is capped and surfaced as an 'exceeded' error", async () => {
  const prev = process.env.EAGENT_MAX_MCP_READ_BYTES;
  process.env.EAGENT_MAX_MCP_READ_BYTES = "2048";
  const { agent, host } = makeHarness({
    responder: [
      { toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "__oversize_json__" } }] },
      { text: "done" },
    ],
    fallback: "allow",
  });
  try {
    await host.use("mcp", activate);
    // The handshake (also JSON on this path) registered the tool under the cap.
    assert.ok(agent.tools.has("mcp__httpfix__ping"), "expected the handshake to register the tool under the cap");
    await agent.run("please ping");
    const toolMsg = agent.messages.find((m) => m.role === "tool");
    const block = toolMsg?.content.find((b) => b.type === "tool_result");
    assert.ok(block && block.type === "tool_result");
    assert.ok(block.isError, "an oversized JSON reply must surface as an error");
    assert.match(block.content, /exceeded/);
  } finally {
    await host.dispose();
    if (prev === undefined) delete process.env.EAGENT_MAX_MCP_READ_BYTES;
    else process.env.EAGENT_MAX_MCP_READ_BYTES = prev;
  }
});

test("the /mcp command lists the connected HTTP server", async () => {
  const { host, commands } = makeHarness({ fallback: "allow" });
  await host.use("mcp", activate);
  try {
    const cmd = commands.get("mcp");
    assert.ok(cmd, "expected an /mcp command to be registered");
    const lines: string[] = [];
    await cmd!.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });
    const output = lines.join("\n");
    assert.match(output, /httpfix/);
    assert.match(output, /1 tool/);
  } finally {
    await host.dispose();
  }
});

test("RW7c-2: an MCP tool call injects the traceparent for an allowlisted host, not otherwise", async () => {
  const prevAllow = process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
  const TP = traceparent("c".repeat(32), "d".repeat(16));
  // Simulate otel by publishing a traceparent at tool_start (its real writer).
  const publish = (h: ReturnType<typeof makeHarness>): void => {
    h.agent.hooks.on("tool_start", ({ call }) => setTraceparent(call.id, TP));
    h.agent.hooks.on("tool_end", ({ call }) => clearTraceparent(call.id));
  };
  try {
    process.env.EAGENT_OTEL_PROPAGATE_HOSTS = "127.0.0.1";
    const h1 = makeHarness({
      responder: [{ toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "hi" } }] }, { text: "done" }],
      fallback: "allow",
    });
    publish(h1);
    await h1.host.use("mcp", activate);
    await h1.agent.run("please ping");
    assert.equal(seenHeaders["tools/call"]?.["traceparent"], TP, "allowlisted MCP host receives the traceparent");
    await h1.host.dispose();

    delete process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
    const h2 = makeHarness({
      responder: [{ toolCalls: [{ name: "mcp__httpfix__ping", arguments: { msg: "yo" } }] }, { text: "done" }],
      fallback: "allow",
    });
    publish(h2);
    await h2.host.use("mcp", activate);
    await h2.agent.run("please ping");
    assert.equal(seenHeaders["tools/call"]?.["traceparent"], undefined, "non-allowlisted MCP host gets no traceparent");
    await h2.host.dispose();
  } finally {
    if (prevAllow === undefined) delete process.env.EAGENT_OTEL_PROPAGATE_HOSTS;
    else process.env.EAGENT_OTEL_PROPAGATE_HOSTS = prevAllow;
  }
});
