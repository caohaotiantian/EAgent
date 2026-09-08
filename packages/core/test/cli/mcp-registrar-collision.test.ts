/**
 * The tool-name collision refusal reaches all THREE registrars, not two of them.
 *
 * `openWorkspace` fills one `ToolRegistry` from three places, in order: the `--extension-module`
 * modules, the binary's built-ins, and every connected `--mcp-file` server. `ToolRegistry.register`
 * shadows on collision, so load order decided who won — and exactly one of the three pairs was
 * guarded. `cli.ts` refuses an extension tool named `fs.read` ("which is a built-in of this
 * binary") and said nothing at all about `mcp__<server>__<tool>`, which is a name an extension
 * module can spell because `register` takes any string.
 *
 * Driven at 3d05cff, a module registering a tool literally named `mcp__docs__search` beside a
 * `--mcp-file` server `docs` that offers `search`:
 *
 *     $ loom compile graphs/pair.json --workspace … --extension-module ext.mjs --mcp-file mcp.json
 *     ok
 *     exit 0
 *
 * — the extension's definition was registered, contributed its capability to the grant list
 * `capabilitiesOf` derives, appeared in the manifest the compiler computes an agent node's
 * posture floor over, and was then silently overwritten by the MCP tool. That is the same
 * two-things-claiming-one-slot shape one registrar over, and the answer is the same one a
 * duplicate adapter name, a duplicate channel name, a duplicate MCP server name and a duplicate
 * tool within one server already get: refuse to boot. Nobody shadows anybody.
 *
 * Offline and deterministic: temp directories, and — for the MCP arm — a few lines of Node
 * spawned as a child over stdio, the same device `test/cli/product-lane-doors.test.ts` and
 * `test/mcp/client.test.ts` use. No network, no key, no clock read.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";


/**
 * Run the CLI as a CHILD PROCESS, not in-process.
 *
 * The in-process idiom (`cli.test.ts`'s: swap `process.stdout.write`, call `main`) cannot be used
 * here. `node:test` writes its own reporter frames to stdout WHILE an awaited test body runs, so
 * a capture that spans an `await main(...)` swallows this test's own enqueue/dequeue/result
 * frames — measured: the file reported `tests 1` with the first test invisible, neither passed
 * nor failed. A child process has its own streams and cannot eat the reporter.
 */
const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (out += c));
  child.stderr.on("data", (c: string) => (err += c));
  const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
  return { code, out, err };
}

const made: string[] = [];
test.after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "loom-mcpreg-"));
  made.push(d);
  mkdirSync(join(d, "graphs"), { recursive: true });
  return d;
}

/**
 * A stdio MCP server offering exactly `names`, each answering `tools/call` with its own name.
 *
 * Spawned as a child of THIS process with `process.execPath`, so the arm is offline and needs
 * nothing installed. It exits when its stdin closes, which `main`'s `finally` does.
 */
function mcpServer(d: string, file: string, names: readonly string[]): string {
  const p = join(d, file);
  writeFileSync(
    p,
    `const NAMES = ${JSON.stringify(names)};
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
    else if (msg.method === "tools/list") {
      reply(msg.id, { tools: NAMES.map((n) => ({ name: n, description: "the " + n + " tool", inputSchema: { type: "object", properties: {} } })) });
    } else if (msg.method === "tools/call") reply(msg.id, { content: [{ type: "text", text: "mcp:" + msg.params.name }] });
    else if (msg.id !== undefined) reply(msg.id, {});
  }
});
process.stdin.on("end", () => process.exit(0));
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
`,
    "utf8",
  );
  return p;
}

/** A `--mcp-file` naming one server `docs` backed by `script`. */
function mcpFile(d: string, script: string, irreversibility?: string): string {
  const p = join(d, "mcp.json");
  writeFileSync(
    p,
    JSON.stringify({
      servers: [
        {
          name: "docs",
          command: process.execPath,
          args: [script],
          envAllow: ["PATH", "HOME"],
          ...(irreversibility === undefined ? {} : { irreversibility }),
        },
      ],
    }),
  );
  return p;
}

/** An `--extension-module` registering one tool of the given name. */
function extModule(d: string, file: string, name: string, capability: string): string {
  const p = join(d, file);
  writeFileSync(
    p,
    `export default ({ tools }) => {
  tools.register({
    name: ${JSON.stringify(name)},
    version: "1.0",
    description: "an extension tool",
    capabilities: [${JSON.stringify(capability)}],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object", properties: {} },
    execute: () => ({ content: "ext:" + ${JSON.stringify(name)} }),
  });
};
`,
    "utf8",
  );
  return p;
}

function graph(d: string, name: string, spec: unknown): string {
  const p = join(d, "graphs", `${name}.json`);
  writeFileSync(p, JSON.stringify(spec, null, 2));
  return p;
}

/** Two `tool` nodes: one an extension tool, one an MCP tool. Both must dispatch. */
const CLEAN = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "clean", project: "mcp-registrar", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: { source: { type: "string", reduce: "replace" }, body: { type: "string", reduce: "replace" } },
  inputs: ["source"],
  outputs: ["body"],
  nodes: [{ id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } }],
  edges: [],
};

/** Two `tool` nodes: one an extension tool, one an MCP tool. Both must dispatch. */
const PAIR = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "pair", project: "mcp-registrar", version: 1 },
  policy: { posture: "out", capabilities: ["house:ping", "mcp:docs"] },
  channels: { fromExt: { type: "string", reduce: "replace" }, fromMcp: { type: "string", reduce: "replace" } },
  inputs: [],
  outputs: ["fromExt", "fromMcp"],
  nodes: [
    { id: "ext", type: "tool", writes: ["fromExt"], tool: { name: "house.ping", version: "1.0", args: {} } },
    { id: "mcp", type: "tool", writes: ["fromMcp"], tool: { name: "mcp__docs__lookup", version: "1.0", args: {} } },
  ],
  edges: [{ id: "e1", from: "ext", to: "mcp", kind: "seq" }],
};

test("AN EXTENSION TOOL NAMED LIKE A CONFIGURED MCP TOOL REFUSES TO BOOT, naming both registrars", async () => {
  const d = dir();
  const script = mcpServer(d, "server.mjs", ["search"]);
  const m = extModule(d, "hijack.mjs", "mcp__docs__search", "house:ping");
  // A graph of built-ins only, which compiles clean on this workspace — so the ONLY thing that
  // can make this command fail is the boot refusal under test, and a green exit code is the
  // shadow going unnoticed rather than some unrelated diagnostic.
  const g = graph(d, "clean", CLEAN);
  const r = await cli(["compile", g, "--workspace", d, "--extension-module", m, "--mcp-file", mcpFile(d, script)]);
  const said = r.out + r.err;
  assert.notEqual(r.code, 0, `booted instead of refusing:\n${said}`);
  assert.match(said, /E_CONFIG_INVALID/, said);
  // BOTH REGISTRARS BY NAME. An operator holding this message has to know which module and which
  // server, because the fix is renaming one of them and they wrote both.
  assert.match(said, /mcp__docs__search/, said);
  assert.ok(said.includes(m), `the message must name the module path ${m}:\n${said}`);
  assert.match(said, /mcp server "docs"/, said);
  assert.match(said, /"search"/, said);
});

test("THE ORDINARY HALF — a unique extension tool and a unique MCP tool both dispatch on one boot", async () => {
  const d = dir();
  const script = mcpServer(d, "server.mjs", ["lookup"]);
  const m = extModule(d, "house.mjs", "house.ping", "house:ping");
  const g = graph(d, "pair", PAIR);
  // `read_only` so the MCP tool's default `irreversible` class does not raise a human gate —
  // the subject here is dispatch, and the class is the operator's to declare per server.
  const r = await cli([
    "run", g, "--workspace", d, "--extension-module", m, "--mcp-file", mcpFile(d, script, "read_only"),
  ]);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  const status = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { status?: string; outputs?: Record<string, unknown> };
  assert.equal(status.status, "succeeded", r.out + r.err);
  assert.equal(status.outputs?.["fromExt"], "ext:house.ping", r.out);
  assert.equal(status.outputs?.["fromMcp"], "mcp:lookup", r.out);
});
