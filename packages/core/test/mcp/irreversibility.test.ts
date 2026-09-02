/**
 * THE ONE PLACE A CONFIG FILE LOWERS A GATE, driven end to end against a real stdio server.
 *
 * `mcpTools` registered every tool from every MCP server as `irreversible`, so every MCP tool
 * gated — which made the only no-fork tool route this binary offers unusable for anything called
 * more than a few times a day. `TODO.md` §D.1 is that row; the argument for why an operator's own
 * `--mcp-file` may declare a class, when `loadExtensionModules` says a file may not name a module
 * path, is written at `MCP_SERVER_FIELDS` and not repeated here.
 *
 * WHAT THIS FILE IS FOR IS THE PAIR, and specifically its CONTROL. An assertion that a declared
 * `read_only` server runs unattended is satisfied by a gate that never fires for any reason at
 * all — a broken floor, a graph that reaches no tool, a run that failed before it got there. So
 * the two halves differ by ONE KEY in ONE FILE, everything else byte-identical, and the half with
 * no key must reach `awaiting_gate` with the server's `tools/call` never called:
 *
 *     {"servers":[{"name":"demo","command":…}]}                          -> awaiting_gate, calls=0
 *     {"servers":[{"name":"demo","command":…,"irreversibility":"read_only"}]} -> succeeded, calls=1
 *
 * The call count is read off a RECEIPT THE SERVER ITSELF APPENDS, not off a spy this test wrapped
 * around the tool: the thing being measured is whether a third party's program was reached, and a
 * wrapper measures whether this test's own wrapper was reached.
 *
 * OFFLINE AND DETERMINISTIC: the server is a few lines of Node written to a temp file and spawned,
 * every model is the mock, and no assertion reads a clock.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { mcpToolName } from "../../src/mcp/tools.ts";
import {
  mcpLoweringWarnings,
  openWorkspace,
  parseArgs,
  readMcpServers,
  startMcp,
  type ConnectedMcpServer,
  type McpServerConfig,
} from "../../src/cli.ts";
import type { ToolRegistry } from "../../src/run/registry.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";

/**
 * A well-behaved stdio server offering one tool, which APPENDS A LINE PER CALL to `argv[2]`.
 *
 * The receipt is the measurement. A tool that gated and a tool that ran both leave a run behind;
 * only one of them leaves a file.
 */
const SERVER = `
import { appendFileSync } from "node:fs";
const receipt = process.argv[2];
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
      { name: "lookup", description: "Look something up.", inputSchema: { type: "object" } },
    ] });
    else if (msg.method === "tools/call") {
      appendFileSync(receipt, "called\\n");
      reply(msg.id, { content: [{ type: "text", text: "looked it up" }] });
    } else if (msg.id !== undefined) reply(msg.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`;

const TOOL = mcpToolName("demo", "lookup");

/** One tool node behind a graph whose own posture is `out`, so the FLOOR is the only thing gating. */
const SPEC = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "mcpclass", project: "probe", version: 1 },
  policy: {
    posture: "out",
    capabilities: ["mcp:demo"],
    expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
  },
  channels: { a: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["a"],
  outputs: ["out"],
  nodes: [
    { id: "p", type: "tool", reads: ["a"], writes: ["out"], tool: { name: TOOL, version: "1.0", args: {} }, unhandled: true },
  ],
  edges: [],
} as unknown as GraphSpec;

interface Driven {
  readonly status: string;
  readonly gates: number;
  readonly calls: number;
  readonly declared: IrreversibilityClass;
  readonly manifest: string | undefined;
}

/**
 * The whole CLI path: a file on disk -> `readMcpServers` -> `startMcp` -> `openWorkspace` -> a run.
 *
 * Nothing is short-circuited, and that is deliberate — the defect §D.1 describes is not in any one
 * of those functions, it is in what the four of them do to each other. `declared` is the ONLY
 * thing that varies between the two calls below.
 */
async function drive(declared: IrreversibilityClass | undefined): Promise<Driven> {
  const dir = mkdtempSync(join(tmpdir(), "loom-mcpclass-"));
  const serverPath = join(dir, "server.mjs");
  const receipt = join(dir, "calls.log");
  writeFileSync(serverPath, SERVER, "utf8");
  const cfg = join(dir, "mcp.json");
  writeFileSync(
    cfg,
    JSON.stringify({
      servers: [
        {
          name: "demo",
          command: process.execPath,
          args: [serverPath, receipt],
          ...(declared === undefined ? {} : { irreversibility: declared }),
        },
      ],
    }),
  );

  let servers: readonly ConnectedMcpServer[] = [];
  try {
    servers = await startMcp(readMcpServers(cfg));
    const ws = openWorkspace(parseArgs(["run", "--workspace", dir]), process.env, undefined, servers);
    try {
      const manifests = (ws.engine.tools as ToolRegistry).manifests();
      const graph = compileOrThrow({ spec: SPEC, resolver: ws.resolver, tools: manifests, tenantCapabilities: ws.granted });
      const runId = await ws.engine.submit({ graph, inputs: { a: "anything" } });
      const p = await ws.engine.advance(runId);
      return {
        status: p.status,
        gates: Object.keys(p.gates).length,
        calls: existsSync(receipt) ? readFileSync(receipt, "utf8").split("\n").filter((l) => l !== "").length : 0,
        declared: servers[0]!.irreversibility,
        manifest: manifests[TOOL]?.irreversibility,
      };
    } finally {
      ws.close();
    }
  } finally {
    for (const s of servers) s.client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("THE CONTROL — a server that declares nothing still gates, and the tool is never reached", async () => {
  const r = await drive(undefined);

  // THIS ASSERTION IS THE WHOLE POINT OF THE PAIR. Without it the test below is satisfiable by a
  // floor that stopped working, and "MCP tools no longer gate" would read as a feature.
  assert.equal(r.status, "awaiting_gate", `a server declaring nothing must still gate: ${r.status}`);
  assert.equal(r.gates, 1, "and exactly one gate, on the node that reaches the tool");
  assert.equal(r.calls, 0, "the server's tools/call must NOT have been reached before a human answered");
  assert.equal(r.manifest, "irreversible", "silence registers the strict class");
  assert.equal(r.declared, "irreversible", "and startMcp is where the default is applied");
});

test("A SERVER THE OPERATOR DECLARED read_only RUNS, and its tool is actually called", async () => {
  const r = await drive("read_only");

  assert.equal(r.status, "succeeded", `a declared read_only server must not gate: ${r.status}`);
  assert.equal(r.gates, 0, "no gate was raised");
  // NOT INFERRED FROM `succeeded`. A run can succeed having skipped the node; the receipt is
  // written by the third party's own process and is the only evidence the tool ran.
  assert.equal(r.calls, 1, "the MCP server's tools/call must have been reached exactly once");
  assert.equal(r.manifest, "read_only", "and the declared class is what the registry holds");
});

test("A DECLARED externally_visible STILL GATES — the field is not a synonym for read_only", async () => {
  // The direction nobody would notice if it were wrong, because the wrong answer looks like the
  // default. `CLASS_DEFAULT_POSTURE` puts `externally_visible` at `in` alongside `irreversible`,
  // so an operator who declares it is TIGHTENING nothing and loosening nothing — and a validator
  // that accepted only the two lowering members would pass every other test in this file.
  const r = await drive("externally_visible");
  assert.equal(r.status, "awaiting_gate", `externally_visible is an in-class: ${r.status}`);
  assert.equal(r.calls, 0);
  assert.equal(r.manifest, "externally_visible");
});

test("reversible_write DOES NOT GATE, and it is the class most operators actually want", async () => {
  // `CLASS_DEFAULT_POSTURE.reversible_write` is `on`, which is below `in` — a mailbox-as-tool
  // delivering ten messages is this row, not `read_only`, and §D.1's worked example is exactly it.
  const r = await drive("reversible_write");
  assert.equal(r.status, "succeeded", r.status);
  assert.equal(r.calls, 1);
  assert.equal(r.manifest, "reversible_write");
});

// ── what an operator is told, which is the other half of a lowering ──────────

test("A LOWERED CLASS IS ANNOUNCED, and a row that says `irreversible` out loud is not", () => {
  const rows = (xs: readonly McpServerConfig[]): readonly string[] => mcpLoweringWarnings(xs);

  assert.deepEqual(rows([{ name: "docs", command: "node" }]), [], "silence is the default and is not news");
  assert.deepEqual(
    rows([{ name: "docs", command: "node", irreversibility: "irreversible" }]),
    [],
    "a declaration that changed nothing must not print — a warning that fires on a no-op is one operators learn to skip",
  );

  const [line] = rows([
    { name: "mail", command: "node", irreversibility: "reversible_write" },
    { name: "docs", command: "node", irreversibility: "read_only" },
    { name: "pay", command: "node", irreversibility: "irreversible" },
  ]);
  assert.ok(line !== undefined, "two lowered servers must produce a warning");
  assert.match(line, /^! MCP OVERSIGHT LOWERED BY --mcp-file/);
  assert.match(line, /mail: reversible_write \(posture floor on\)/);
  assert.match(line, /docs: read_only \(posture floor out\)/);
  // The one that changed nothing is NOT in the line, so the operator reading it is reading the
  // set that actually moved.
  assert.doesNotMatch(line, /pay/);
});
