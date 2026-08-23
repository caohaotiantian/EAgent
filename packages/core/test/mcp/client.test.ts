/**
 * The MCP client, against a real child process speaking the real protocol.
 *
 * Offline and deterministic: the "server" is a few lines of Node written to a temp file and
 * spawned, so the transport, the framing, the handshake and the timeout are all genuinely
 * exercised rather than mocked. A mocked transport would prove the parts of this file that
 * were never in doubt.
 *
 * The tests that matter are the ones about not trusting the server: a nameless tool entry, a
 * non-JSON line on stdout, a server that answers nothing, and a server that dies mid-call.
 * Each is something a third party's program does, and each has a wrong answer that looks
 * fine until production.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { McpClient, createBoundedLineReader } from "../../src/mcp/client.ts";
import { mcpToolName, mcpTools } from "../../src/mcp/tools.ts";
import { openWorkspace, parseArgs, readMcpServers, startMcp } from "../../src/cli.ts";
import { compile } from "../../src/graph/compile.ts";

function serverFile(body: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcp-"));
  const path = join(dir, "server.mjs");
  writeFileSync(path, body, "utf8");
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal, well-behaved MCP server: handshake, one tool, echoes its argument. */
const GOOD = `
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
      { name: "echo", description: "Echo it back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "", description: "nameless — must be dropped" },
      null,
    ] });
    else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: "echo:" + msg.params.arguments.text }] });
    else if (msg.id !== undefined) reply(msg.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`;

// ── the line reader, which is the part a hostile server attacks ──────────────

test("THE LINE READER DROPS A NO-NEWLINE FLOOD instead of growing without bound", () => {
  const seen: string[] = [];
  const r = createBoundedLineReader(64, (l) => seen.push(l));
  r.push(Buffer.from("x".repeat(1000)));
  assert.equal(r.discarding(), true, "past the cap with no newline, it must stop buffering");
  assert.equal(r.buffered(), 0);
  // …and it must resync ON the next newline, so the following message is parsed clean
  // rather than as the tail of the garbage.
  r.push(Buffer.from('more-garbage\n{"ok":1}\n'));
  assert.deepEqual(seen, ['{"ok":1}']);
});

test("the line reader splits ordinary traffic exactly", () => {
  const seen: string[] = [];
  const r = createBoundedLineReader(1024, (l) => seen.push(l));
  r.push(Buffer.from("a\nb"));
  r.push(Buffer.from("c\nd\n"));
  assert.deepEqual(seen, ["a", "bc", "d"]);
});

// ── the protocol, end to end ─────────────────────────────────────────────────

test("A REAL HANDSHAKE ENUMERATES TOOLS, and drops the entries that are not tools", async () => {
  const s = serverFile(GOOD);
  const c = new McpClient({ name: "demo", command: process.execPath, args: [s.path], timeoutMs: 10_000 });
  try {
    await c.start();
    // Three entries came back; one has an empty name and one is null. A nameless entry
    // would register as `mcp__demo__` and shadow nothing usefully.
    assert.deepEqual(c.tools.map((t) => t.name), ["echo"]);
  } finally {
    c.close();
    s.cleanup();
  }
});

test("a discovered tool round-trips a real call", async () => {
  const s = serverFile(GOOD);
  const c = new McpClient({ name: "demo", command: process.execPath, args: [s.path], timeoutMs: 10_000 });
  try {
    await c.start();
    const tool = mcpTools(c).find((t) => t.name === mcpToolName("demo", "echo"))!;
    const r = await tool.execute({ text: "hi" }, { taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} });
    assert.equal(r.content, "echo:hi");
  } finally {
    c.close();
    s.cleanup();
  }
});

// ── the manifest, which is what oversight reads ──────────────────────────────

test("EVERY MCP TOOL IS irreversible, so an unknown tool gates rather than guessing", async () => {
  const s = serverFile(GOOD);
  const c = new McpClient({ name: "demo", command: process.execPath, args: [s.path], timeoutMs: 10_000 });
  try {
    await c.start();
    const [tool] = mcpTools(c);
    // `tools/list` says nothing about whether a tool reads a file or wires money, and the
    // two alternatives are worse: guessing from the NAME is a heuristic a hostile server
    // picks its names to defeat, and trusting a self-declared class lets the party being
    // governed choose its own governance.
    assert.equal(tool!.irreversibility, "irreversible");
    assert.equal(tool!.idempotent, false);
    // One capability per SERVER: "this graph may use the demo server" is a decision an
    // operator can actually make.
    assert.deepEqual(tool!.capabilities, ["mcp:demo"]);
  } finally {
    c.close();
    s.cleanup();
  }
});

// ── what a third party's program actually does ───────────────────────────────

test("A SERVER THAT LOGS TO STDOUT DOES NOT BREAK THE SESSION", async () => {
  const s = serverFile(`process.stdout.write("starting up, not JSON\\n");\n${GOOD}`);
  const c = new McpClient({ name: "chatty", command: process.execPath, args: [s.path], timeoutMs: 10_000 });
  try {
    await c.start();
    // Rejecting every in-flight request over one stray line would make a chatty server
    // unusable, and each request's own deadline still bounds the damage.
    assert.deepEqual(c.tools.map((t) => t.name), ["echo"]);
  } finally {
    c.close();
    s.cleanup();
  }
});

test("A SERVER THAT NEVER ANSWERS TIMES OUT rather than wedging the run", async () => {
  const s = serverFile(`process.stdin.on("data", () => {});\nsetInterval(() => {}, 1000);\n`);
  const c = new McpClient({ name: "silent", command: process.execPath, args: [s.path], timeoutMs: 150 });
  try {
    await assert.rejects(async () => c.start(), (e: unknown) => (e as { code: string }).code === "E_TOOL_TIMEOUT");
  } finally {
    c.close();
    s.cleanup();
  }
});

test("A SERVER THAT DIES MID-CALL REJECTS THE CALL, and does not leave it pending forever", async () => {
  const s = serverFile(`
let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  const i = buf.indexOf("\\n");
  if (i === -1) return;
  const msg = JSON.parse(buf.slice(0, i));
  buf = "";
  if (msg.method === "initialize") { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }) + "\\n"); return; }
  process.exit(1);
});
`);
  const c = new McpClient({ name: "dying", command: process.execPath, args: [s.path], timeoutMs: 10_000 });
  try {
    await assert.rejects(
      async () => c.start(),
      (e: unknown) => (e as { code: string }).code === "E_TOOL_SOURCE_UNAVAILABLE",
    );
  } finally {
    c.close();
    s.cleanup();
  }
});

test("calling a client that is not running is refused, not silently pending", async () => {
  const c = new McpClient({ name: "never", command: process.execPath, args: ["-e", ""], timeoutMs: 100 });
  await assert.rejects(
    async () => c.request("tools/list", {}),
    (e: unknown) => (e as { code: string }).code === "E_TOOL_SOURCE_UNAVAILABLE",
  );
});

// ── the CLI wiring, which is what makes any of this reachable ────────────────

test("THE EXAMPLE IN THE REFUSAL IS ONE THAT CAN ACTUALLY START", () => {
  // The refusal is what an operator is holding when they write the file, and it used to suggest
  // `{"name":"docs","command":"npx","args":[…]}` — no `envAllow`. `McpClient.start` builds the
  // child environment from `envAllow` ALONE, so that shape has no PATH, `npx` is not found, and
  // the operator gets `spawn npx ENOENT` from a config this very message handed them.
  //
  // USAGE has said so at length for a while. The refusal did not, and a reader following the
  // error rather than the manual is exactly the reader who needs it.
  const d = mkdtempSync(join(tmpdir(), "loom-mcpex-"));
  try {
    const p = join(d, "mcp.json");
    writeFileSync(p, JSON.stringify({}));
    let message = "";
    try {
      readMcpServers(p);
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /envAllow/, "the suggested shape must include envAllow");
    assert.match(message, /"PATH"/, "and name PATH, which is the one that stops `npx` resolving");

    // And the shape it suggests must be a shape this parser accepts — an example that does not
    // round-trip is worse than none.
    // Extracted by BALANCING, not by a lazy regex. `/\{"servers":\[.*?\]\}/` stops at the first
    // `]` — which is the `args` array's — and yields a fragment that does not parse. The example
    // contains nested arrays by construction, so the extractor has to count.
    const flat = message.replace(/`/g, "");
    const from = flat.indexOf('{"servers":');
    assert.notEqual(from, -1, `the refusal must contain a copyable example; got: ${message}`);
    let depth = 0;
    let to = from;
    for (; to < flat.length; to++) {
      const c = flat[to]!;
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    const parsed = JSON.parse(flat.slice(from, to + 1)) as { servers: unknown[] };
    writeFileSync(p, JSON.stringify(parsed));
    const rows = readMcpServers(p);
    assert.equal(rows.length, 1);
    assert.deepEqual([...(rows[0]!.envAllow ?? [])], ["PATH", "HOME"]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A COMMAND THAT NEEDS PATH FAILS WITH THE REASON, not just ENOENT", async () => {
  // `spawn npx ENOENT` points an operator at their command, which is usually fine — the cause is
  // the empty child environment. Measured through `bin/loom`: `command: "node"` with no envAllow
  // fails ENOENT, and the identical config with an absolute path starts.
  const d = mkdtempSync(join(tmpdir(), "loom-mcpenv-"));
  try {
    let message = "";
    try {
      await startMcp([{ name: "demo", command: "definitely-not-on-any-path-xyz" }]);
    } catch (e) {
      message = (e as Error).message;
    }
    assert.match(message, /ENOENT/, "the underlying failure is still reported");
    assert.match(message, /envAllow/, "and the cause is named");
    assert.match(message, /"PATH"/);

    // NOT volunteered when it would be wrong. An absolute path that does not exist fails for its
    // own reason, and blaming the environment there would send the reader somewhere useless.
    let abs = "";
    try {
      await startMcp([{ name: "demo", command: "/nonexistent/bin/xyz" }]);
    } catch (e) {
      abs = (e as Error).message;
    }
    assert.match(abs, /ENOENT/);
    assert.doesNotMatch(abs, /envAllow/, "an absolute command is not a PATH problem");

    // Nor when the server ALREADY lists PATH — then the command really is missing, and telling
    // the operator to add what they have added is the kind of advice that teaches people to stop
    // reading errors.
    let listed = "";
    try {
      await startMcp([{ name: "demo", command: "definitely-not-on-any-path-xyz", envAllow: ["PATH"] }]);
    } catch (e) {
      listed = (e as Error).message;
    }
    assert.match(listed, /ENOENT/);
    assert.doesNotMatch(listed, /envAllow/, "PATH is already listed — the hint would be wrong");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("readMcpServers REFUSES A MALFORMED FILE rather than booting unconfigured", () => {
  const d = mkdtempSync(join(tmpdir(), "loom-mcpcfg-"));
  try {
    const write = (doc: unknown): string => {
      const p = join(d, "mcp.json");
      writeFileSync(p, JSON.stringify(doc));
      return p;
    };
    // Each refusal names what is wrong, because "looks configured and every call fails with
    // unknown tool" is the outcome booting anyway produces.
    assert.throws(() => readMcpServers(write({})), /at least one server/);
    assert.throws(() => readMcpServers(write({ servers: [{ command: "x" }] })), /name must match/);
    assert.throws(() => readMcpServers(write({ servers: [{ name: "a" }] })), /command is required/);
    // A name that is not id-safe would produce a tool called `mcp__my server__x`.
    assert.throws(() => readMcpServers(write({ servers: [{ name: "my server", command: "x" }] })), /name must match/);
    // A duplicate would have the second server's tools shadow the first's silently.
    assert.throws(
      () => readMcpServers(write({ servers: [{ name: "a", command: "x" }, { name: "a", command: "y" }] })),
      /used twice/,
    );
    // A command line assembled from a single string is how argument injection happens.
    assert.throws(() => readMcpServers(write({ servers: [{ name: "a", command: "x", args: "-y foo" }] })), /array of strings/);
    assert.deepEqual(readMcpServers(write({ servers: [{ name: "a", command: "x", args: ["-y"] }] })), [
      { name: "a", command: "x", args: ["-y"] },
    ]);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("A GRAPH COMPILES AGAINST A DISCOVERED MCP TOOL — the ordering that keeps the floor honest", async () => {
  const s = serverFile(GOOD);
  const d = mkdtempSync(join(tmpdir(), "loom-mcpws-"));
  const cfg = join(d, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ servers: [{ name: "demo", command: process.execPath, args: [s.path] }] }));

  // STARTED BEFORE THE WORKSPACE. The grant list is derived inside `openWorkspace`, so a tool
  // registered after it returns is a tool whose capability nobody holds — which is exactly what
  // shipped: `mcp:demo` was absent from both `tenantCapabilities` and the engine's grant, and a
  // graph naming an MCP tool failed to COMPILE with GRAPH017_CAPABILITY_NOT_GRANTED.
  let clients: readonly McpClient[] = [];
  clients = await startMcp(readMcpServers(cfg));
  const ws = openWorkspace(parseArgs(["compile", "--workspace", d]), process.env, undefined, clients);
  try {
    const manifests = ws.engine.tools.manifests();
    assert.ok(mcpToolName("demo", "echo") in manifests, "the discovered tool must be registered before any compile");
    assert.equal(manifests[mcpToolName("demo", "echo")]!.irreversibility, "irreversible");

    // AND A GRAPH THAT USES IT COMPILES. This test asserted only that the tool APPEARED in the
    // registry, which is why it stayed green through a defect that made every MCP graph
    // unbuildable — the capability is what was missing, not the tool.
    const spec = {
        apiVersion: "loom.dev/v1",
        kind: "GraphSpec",
        metadata: { name: "usesmcp", project: "probe", version: 1 },
        policy: { posture: "out", capabilities: [`mcp:demo`], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
        channels: { a: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
        inputs: ["a"],
        outputs: ["out"],
        nodes: [
          { id: "p", type: "tool", reads: ["a"], writes: ["out"], tool: { name: mcpToolName("demo", "echo"), version: "1.0", args: {} }, unhandled: true },
        ],
      edges: [],
    };
    const r = compile({
      spec: spec as never,
      resolver: ws.resolver,
      tools: ws.engine.tools.manifests(),
      tenantCapabilities: ws.granted,
    });
    assert.equal(
      r.ok,
      true,
      `a graph naming an MCP tool must compile: ${(r.diagnostics ?? []).map((x) => `${x.code}: ${x.message}`).join("; ")}`,
    );
  } finally {
    for (const c of clients) c.close();
    ws.close();
    rmSync(d, { recursive: true, force: true });
    s.cleanup();
  }
});
