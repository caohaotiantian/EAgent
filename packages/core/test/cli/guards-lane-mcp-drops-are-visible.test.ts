/**
 * A tool an MCP server offered and this binary refused had no operator reader.
 *
 * `McpClient.rejectedTools` records every drop with its reason, and its own docstring said so:
 * "NOTHING IN `cli.ts` OR `server/` READS THIS YET, so the fact is available to a library
 * embedder and not to the operator … under `loom serve` a legitimate server whose description
 * runs past `MAX_DESCRIPTION_CHARS` simply stops offering that tool, with no line anywhere."
 * Measured at 294e713: `grep -rn rejectedTools packages/core/src/` returns the two lines that
 * define it in `mcp/client.ts` and nothing else.
 *
 * That is the shape of silence this repo keeps finding one level down from a guard: the refusal
 * is right, and it is indistinguishable from the tool never having existed — so it is diagnosed
 * as "the model did not call the tool" rather than as "your server said something we refused".
 *
 * The reader is `mcpRejectionWarnings`, written as a pure function for `modelWarnings`' reason:
 * the decision is testable without a process, and all `main` does with it is write the lines.
 * The server here is real and spawned, so the transport and the handshake are not stubbed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mcpRejectionWarnings } from "../../src/cli.ts";
import { McpClient } from "../../src/mcp/client.ts";

/** One honest tool and two the client must refuse, in the shapes that actually arrive. */
const SERVER = `
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  for (;;) {
    const i = buf.indexOf("\\n");
    if (i === -1) return;
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    if (msg.method === "initialize") reply(msg.id, { capabilities: {}, protocolVersion: "2024-11-05" });
    else if (msg.method === "tools/list") reply(msg.id, { tools: [
      { name: "honest", description: "Reads a doc.", inputSchema: { type: "object" } },
      { name: "verbose", description: "x".repeat(200000), inputSchema: { type: "object" } },
      { name: "schemaless", description: "ok", inputSchema: 42 },
    ] });
    else if (msg.id !== undefined) reply(msg.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`;

test("EVERY DROPPED MCP TOOL GETS A LINE, naming the server, the tool and the reason", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-drop-"));
  const path = join(dir, "server.mjs");
  writeFileSync(path, SERVER, "utf8");
  const client = new McpClient({ name: "docs", command: process.execPath, args: [path], timeoutMs: 10_000 });
  try {
    await client.start();
    assert.deepEqual(
      client.tools.map((t) => t.name),
      ["honest"],
      "the two malformed entries are refused — that half already worked",
    );

    const lines = mcpRejectionWarnings([{ client, irreversibility: "irreversible" }]);
    assert.equal(lines.length, 2, `one line per drop, got:\n${lines.join("")}`);
    const said = lines.join("");
    assert.match(said, /MCP TOOL DROPPED — docs: "verbose" was offered by the server and is NOT registered/);
    assert.match(said, /description is 200000 characters, over the 8192 allowed/);
    assert.match(said, /MCP TOOL DROPPED — docs: "schemaless"/);
    assert.match(said, /inputSchema is number, not a JSON Schema object/);
    // The line has to say what an operator can DO about it, or it is a second silence.
    assert.match(said, /Fix it on the server, or drop the row\./);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("THE ORDINARY HALF: a server whose tools are all fine prints nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-clean-"));
  const path = join(dir, "server.mjs");
  // The same server with its two malformed rows removed — written out rather than regexed, so
  // the fixture the ordinary half runs is one a reader can see is well-formed.
  writeFileSync(
    path,
    SERVER.split("\n")
      .filter((l) => !l.includes('"verbose"') && !l.includes('"schemaless"'))
      .join("\n"),
    "utf8",
  );
  const client = new McpClient({ name: "docs", command: process.execPath, args: [path], timeoutMs: 10_000 });
  try {
    await client.start();
    assert.deepEqual(client.tools.map((t) => t.name), ["honest"]);
    assert.deepEqual(mcpRejectionWarnings([{ client, irreversibility: "irreversible" }]), []);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("…and no servers at all is no lines, not a crash", () => {
  assert.deepEqual(mcpRejectionWarnings([]), []);
});
