#!/usr/bin/env node
/**
 * The `loom` command.
 *
 * Its most important job is to make DoD item 6 demonstrable: **boot from a single
 * binary with an empty data directory and no external service.** Everything else the
 * CLI does is in service of being able to prove that by running a real graph.
 *
 * Graphs are JSON here, not YAML: `@loom/core` never parses YAML, which is what keeps
 * it zero-dependency and keeps hashing unambiguous (canonical JSON has exactly one
 * representation of a document; YAML has several). A `loom fmt` that converts YAML to
 * JSON belongs in a CLI-only package that may take the dependency.
 */

import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { InProcessEventBus } from "./bus.ts";
import { isLoomError, toLoomError } from "./errors.ts";
import { compile } from "./graph/compile.ts";
import type { GraphSpec, RunGraph } from "./graph/spec.ts";
import type { ResourceResolver } from "./graph/validate.ts";
import { SqliteStateStore } from "./journal/sqlite.ts";
import { builtinTools, fsRestore } from "./builtin/tools.ts";
import { Engine } from "./run/engine.ts";
import { FunctionRegistry, ModelRegistry, MockModelAdapter, ToolRegistry } from "./run/registry.ts";
import { replayRun } from "./run/replay.ts";
import { ControlPlane } from "./server/http.ts";
import { conformsToGraph, reconstructGraph, spansFrom } from "./telemetry/spans.ts";
import type { GateId, RunId } from "./ids.ts";

const USAGE = `loom — graph-native multi-agent orchestration

  loom serve   [--workspace .] [--port 8787] [--token T]   start the control plane
  loom compile <graph.json>                                validate and print diagnostics
  loom run     <graph.json> [--input JSON]                 run to completion or to a gate
  loom gates   <runId>                                     list open gates
  loom approve <runId> <gateId> [--reject REASON]          resolve a gate
  loom replay  <runId> --graph <graph.json>                replay and verify
  loom trace   <runId> --graph <graph.json>                print the span tree

  --workspace DIR   root for graphs/, data, and the tool jail (default: cwd)
  --data-dir  DIR   journal location (default: <workspace>/.loom)
`;

interface Args {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | true>>;
}

export function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { command: positional[0] ?? "help", positional: positional.slice(1), flags };
}

interface Workspace {
  readonly root: string;
  readonly dataDir: string;
  readonly store: SqliteStateStore;
  readonly engine: Engine;
  readonly bus: InProcessEventBus;
  readonly resolver: ResourceResolver;
  close(): void;
}

/**
 * Build everything from a directory that may not exist yet.
 *
 * This is the "empty data directory" path: it creates the tree, opens a fresh SQLite
 * journal, registers the built-in tools against a jail, and returns a working engine.
 * No service, no migration step, no configuration file required.
 */
export function openWorkspace(args: Args): Workspace {
  const root = resolve(String(args.flags["workspace"] ?? process.cwd()));
  const dataDir = resolve(String(args.flags["data-dir"] ?? join(root, ".loom")));
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(root, "graphs"), { recursive: true });

  const store = new SqliteStateStore({ path: join(dataDir, "journal.db") });
  const bus = new InProcessEventBus({ store });

  const tools = new ToolRegistry();
  const jail = { root, ...(args.flags["egress"] === undefined ? {} : { egressAllowlist: String(args.flags["egress"]).split(",") }) };
  for (const t of builtinTools(jail)) tools.register(t);
  tools.register(fsRestore(jail));

  const models = new ModelRegistry();
  // Offline by default. A real adapter is registered by configuration; the mock is
  // what makes `loom run` work on a fresh machine with no API key.
  models.register(
    new MockModelAdapter({
      script: (req) => ({ text: `[mock] ${req.messages.at(-1)?.content.slice(0, 80) ?? ""}` }),
    }),
    true,
  );

  const engine = new Engine({
    store,
    bus,
    tools,
    functions: new FunctionRegistry(),
    models,
    policy: { granted: ["fs:read", "fs:write", "net:fetch"], systemFloor: "out" },
  });

  const resolver: ResourceResolver = {
    // Without a resource store, refs resolve to a digest of their own name. That is
    // enough for the compiler's pinning to be structurally correct locally, and it is
    // replaced by a real ResourceStore the moment one is configured.
    resolve: (ref) =>
      /^[a-z_]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(ref)
        ? { ref, digest: `sha256:${Buffer.from(ref).toString("hex").padEnd(64, "0").slice(0, 64)}`, channel: "stable" }
        : undefined,
  };

  return { root, dataDir, store, engine, bus, resolver, close: () => store.close() };
}

function loadGraph(ws: Workspace, file: string): RunGraph {
  const spec = JSON.parse(readFileSync(resolve(file), "utf8")) as GraphSpec;
  const result = compile({
    spec,
    resolver: ws.resolver,
    tools: (ws.engine.tools as ToolRegistry).manifests(),
    tenantCapabilities: ["fs:read", "fs:write", "net:fetch"],
  });
  if (!result.ok) {
    for (const d of result.diagnostics) {
      process.stderr.write(`${d.severity === "error" ? "✗" : "!"} ${d.code}: ${d.message}\n`);
      if (d.fix !== undefined) process.stderr.write(`   fix: ${d.fix}\n`);
    }
    throw result.error;
  }
  for (const d of result.diagnostics) process.stderr.write(`! ${d.code}: ${d.message}\n`);
  return result.graph;
}

function discoverGraphs(ws: Workspace): Record<string, RunGraph> {
  const dir = join(ws.root, "graphs");
  const out: Record<string, RunGraph> = {};
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const graph = loadGraph(ws, join(dir, file));
      out[graph.spec.metadata.name] = graph;
    } catch (e) {
      // One malformed graph must not stop the server from serving the others.
      process.stderr.write(`! skipping ${basename(file)}: ${(e as Error).message}\n`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "help" || args.flags["help"] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const ws = openWorkspace(args);
  try {
    switch (args.command) {
      case "compile": {
        loadGraph(ws, requirePositional(args, 0, "a graph file"));
        process.stdout.write("ok\n");
        return 0;
      }

      case "serve": {
        const graphs = discoverGraphs(ws);
        const plane = new ControlPlane({
          engine: ws.engine,
          store: ws.store,
          bus: ws.bus,
          graphs,
          ...(args.flags["token"] === undefined ? {} : { token: String(args.flags["token"]) }),
        });
        const { port } = await plane.listen(Number(args.flags["port"] ?? 8787));
        process.stdout.write(`loom listening on http://127.0.0.1:${port}\n`);
        process.stdout.write(`  data:   ${ws.dataDir}\n`);
        process.stdout.write(`  graphs: ${Object.keys(graphs).join(", ") || "(none)"}\n`);
        if (args.flags["token"] === undefined) process.stderr.write("! NO TOKEN — every caller is authorized\n");
        await new Promise<void>((r) => process.on("SIGINT", () => void plane.close().then(r)));
        return 0;
      }

      case "run": {
        const graph = loadGraph(ws, requirePositional(args, 0, "a graph file"));
        const inputs = JSON.parse(String(args.flags["input"] ?? "{}")) as Record<string, unknown>;
        const runId = await ws.engine.submit({ graph, inputs });
        const p = await ws.engine.advance(runId);
        process.stdout.write(`${JSON.stringify({ runId, status: p.status, outputs: p.outputs, usage: p.usage }, null, 2)}\n`);
        if (p.status === "awaiting_gate") {
          for (const g of Object.values(p.gates).filter((x) => x.state === "open")) {
            process.stdout.write(`gate ${g.gateId} on node ${g.nodeId} — loom approve ${runId} ${g.gateId}\n`);
          }
        }
        return p.status === "failed" ? 1 : 0;
      }

      case "gates": {
        const p = await ws.engine.projection(requirePositional(args, 0, "a runId") as RunId);
        const open = Object.values(p?.gates ?? {}).filter((g) => g.state === "open");
        process.stdout.write(`${JSON.stringify(open, null, 2)}\n`);
        return 0;
      }

      case "approve": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const gateId = requirePositional(args, 1, "a gateId") as GateId;
        const reject = args.flags["reject"];
        // The graph must be re-attached: the RunGraph is not itself journaled (its
        // hash is), so a fresh process needs to be told which graph this run used.
        if (args.flags["graph"] !== undefined) ws.engine.attach(runId, loadGraph(ws, String(args.flags["graph"])));
        const p = await ws.engine.resolveGate(runId, {
          gateId,
          decision: reject === undefined ? { kind: "approve" } : { kind: "reject", reason: String(reject) },
          actor: { kind: "human", subject: String(args.flags["as"] ?? "cli"), via: "cli" },
          idempotencyKey: `cli:${gateId}`,
        });
        process.stdout.write(`${JSON.stringify({ status: p.status, outputs: p.outputs }, null, 2)}\n`);
        return p.status === "failed" ? 1 : 0;
      }

      case "replay": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const graph = loadGraph(ws, String(requireFlag(args, "graph")));
        const report = await replayRun({
          store: ws.store,
          runId,
          graph,
          engine: { tools: ws.engine.tools, functions: ws.engine.functions, models: ws.engine.models },
        });
        for (const f of report.frames.filter((x) => !x.match)) {
          process.stderr.write(`✗ ${f.kind} ${f.taskId ?? ""}: expected ${f.expected}, got ${f.actual}\n`);
        }
        process.stdout.write(`${JSON.stringify({ match: report.match, hermetic: report.hermetic }, null, 2)}\n`);
        return report.match ? 0 : 1;
      }

      case "trace": {
        const runId = requirePositional(args, 0, "a runId") as RunId;
        const graph = loadGraph(ws, String(requireFlag(args, "graph")));
        const events = [];
        for await (const e of ws.store.read(runId, 1)) events.push(e);
        const spans = spansFrom(events);
        for (const s of spans) {
          const depth = s.parentSpanId === undefined ? 0 : 1;
          process.stdout.write(`${"  ".repeat(depth)}${s.name} [${s.status}] ${s.endTime - s.startTime}ms\n`);
        }
        const conformance = conformsToGraph(reconstructGraph(spans), graph.spec, graph.graphHash);
        process.stdout.write(`\nconformance: ${conformance.ok ? "ok" : JSON.stringify(conformance)}\n`);
        return conformance.ok ? 0 : 1;
      }

      default:
        process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
        return 2;
    }
  } finally {
    ws.close();
  }
}

function requirePositional(args: Args, i: number, what: string): string {
  const v = args.positional[i];
  if (v === undefined) throw new Error(`${args.command} requires ${what}`);
  return v;
}

function requireFlag(args: Args, name: string): string | true {
  const v = args.flags[name];
  if (v === undefined) throw new Error(`${args.command} requires --${name}`);
  return v;
}

// Entry point. Kept at the bottom so importing this module for tests runs nothing.
if (process.argv[1] !== undefined && import.meta.url.endsWith(basename(process.argv[1]))) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      const le = isLoomError(e) ? e : toLoomError(e);
      process.stderr.write(`${le.code}: ${le.message}\n`);
      process.exit(1);
    });
}
