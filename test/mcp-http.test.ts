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
      json({ content: [{ type: "text", text: "pong: " + args.msg }] });
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
