/**
 * THE FORK LEDGER IS TWO ROWS SHORTER, AND THIS IS THE MEASUREMENT THAT SAYS SO.
 *
 * README's "Extending it, and where that stops" listed "a wire protocol that is not
 * Anthropic's or OpenAI's" and "an in-process tool, from the CLI" among the things that
 * need a fork, under one blanket reason: *the reason is replay — every one of those closed
 * sets is journaled vocabulary.* For these two that reason is false, and the last test in
 * this file is the proof. An adapter produces NO journal vocabulary: `replay.ts` never
 * reaches an adapter and journals `provider: "replay"`, so a run served by a third-wire
 * adapter folds back byte-identically in a process that has never heard of it — asserted
 * here against an EMPTY `ModelRegistry`, which is a stronger claim than passing a mock
 * (an unknown adapter merely fails, and a failure is not proof of hermeticity).
 *
 * So the door was missing, not closed. `--extension-module` is that door, and the whole of
 * what it adds is reachability: `Engine` already took a `ModelRegistry`, `#runAgent`
 * already resolved through it, and `ModelAdapter`/`ModelRegistry`/`ToolRegistry` were
 * already on the pinned public surface for a library embedder. Nothing in the kernel moved.
 *
 * The refusals are the other half. A module named on argv that does not load, does not
 * export a function, or registers nothing is a deployment the operator believes is extended
 * and is not — so every one of them REFUSES TO BOOT, and each case is asserted below rather
 * than argued.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadExtensionModules, main, openWorkspace, parseArgs, readModels } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { ModelRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { RunId } from "../../src/ids.ts";

/**
 * A wire that is neither Anthropic's nor OpenAI's, written the way a stranger would have to
 * write it: a plain module, importing nothing from this repo, handed only `{models, tools}`.
 *
 * IT IMPLEMENTS THE WHOLE `ModelAdapter` CONTRACT, and the two newest members are here because
 * they were MISSED. This fixture was written against a tree where `outputCeilingOf` did not
 * exist and the `done` frame carried no `provider`; both landed in the same wave, from two other
 * decisions, and this test was the only thing in the tree that noticed — every shipped adapter
 * was updated with them, and a THIRD-PARTY one is by definition not.
 *
 * That is the finding worth keeping: **making a member required on `ModelAdapter` is a breaking
 * change to the extension surface**, and the extension surface is the thing D.7.5 exists to open.
 * The members stay required — `outputCeilingOf` was added precisely because reserving against a
 * made-up constant is a guard answering its undecidable case with the passing value, and an
 * optional version with a fallback reinstates that defect for exactly the adapters nobody here
 * wrote. So the contract is the thing that has to be legible instead: `--help` names the required
 * members at the flag, and README quotes them.
 */
const BEDROCK_MODULE = `
class BedrockConverseAdapter {
  provider = "bedrock";
  async *stream(req) {
    const text = "[bedrock-converse] " + req.model;
    yield { type: "text_delta", text };
    const usage = { inputTokens: 7, outputTokens: 5 };
    yield {
      type: "done",
      message: { role: "assistant", content: text },
      provider: this.provider,
      finishReason: "stop",
      usage: { ...usage, costUsd: this.priceOf(req.model, usage), wallMs: 0 },
    };
  }
  priceOf(_m, u) { return (u.inputTokens + u.outputTokens) / 1e6; }
  estimateOf() { return 0.001; }
  outputCeilingOf(req) { return req.maxTokens ?? 4096; }
}
export default ({ models, tools }) => {
  models.register(new BedrockConverseAdapter());
  tools.register({
    name: "house.ping",
    version: "1.0",
    description: "A tool this binary has never heard of.",
    capabilities: ["house:ping"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object", properties: {} },
    execute: () => ({ pong: true }),
  });
};
`;

const GRAPH: GraphSpec = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "third-wire", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [], budget: { costUsd: 1 } },
  channels: { topic: { type: "string", reduce: "replace" }, draft: { type: "string", reduce: "replace" } },
  inputs: ["topic"],
  outputs: ["draft"],
  nodes: [
    {
      id: "write",
      type: "agent",
      reads: ["topic"],
      writes: ["draft"],
      agent: { profile: "agent_profile/writer@stable", prompt: "prompt/writer@stable", maxTurns: 1 },
    },
  ],
  edges: [],
} as unknown as GraphSpec;

/** A workspace holding the graph, the two resources its agent node names, and the module. */
function workspace(): { dir: string; graph: string; module: string; models: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-ext-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "prompt"), { recursive: true });
  mkdirSync(join(dir, "resources", "agent_profile"), { recursive: true });
  const graph = join(dir, "graphs", "third-wire.json");
  writeFileSync(graph, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "resources", "prompt", "writer.md"), "Write a short note about the topic.\n");
  writeFileSync(join(dir, "resources", "agent_profile", "writer.md"), "You are a writer.\n");
  const module = join(dir, "bedrock.mjs");
  writeFileSync(module, BEDROCK_MODULE);
  const models = join(dir, "models.json");
  writeFileSync(
    models,
    JSON.stringify({
      routes: { "agent_profile/writer@stable": { adapter: "bedrock", model: "anthropic.claude-3-5-sonnet-20240620-v1:0" } },
    }),
  );
  return { dir, graph, module, models, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Capture stdout/stderr around a CLI invocation, the idiom `cli.test.ts` uses. */
async function cli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main([...argv]);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function moduleAt(dir: string, name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body);
  return p;
}

// ── the door ─────────────────────────────────────────────────────────────────

test("a THIRD-WIRE provider runs from the binary, with no fork and no models-file adapter row", async () => {
  const w = workspace();
  try {
    const r = await cli([
      "run",
      w.graph,
      "--workspace",
      w.dir,
      "--models-file",
      w.models,
      "--extension-module",
      w.module,
      "--input",
      JSON.stringify({ topic: "kernels" }),
    ]);
    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { runId: string; status: string; outputs: Record<string, unknown> };
    assert.equal(parsed.status, "succeeded");
    // THE MODEL ID WAS REWRITTEN BY THE ROUTE TABLE, so a `routes` row really does reach an
    // adapter the file never declared — the whole point of `preRegistered`.
    assert.equal(parsed.outputs["draft"], "[bedrock-converse] anthropic.claude-3-5-sonnet-20240620-v1:0");

    // AND THE RUN REPLAYS AGAINST AN EMPTY REGISTRY, which is the claim that unmakes the
    // "closed by replay" reason: nothing about a third-wire adapter is journaled vocabulary.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const report = await replayRun({
        runId: parsed.runId as RunId,
        store: ws.store,
        graph: compileOrThrow({ spec: GRAPH, resolver: ws.resolver, tools: ws.engine.tools.manifests(), tenantCapabilities: ws.granted }),
        engine: {
          tools: ws.engine.tools,
          functions: ws.engine.functions,
          models: new ModelRegistry(),
          resolver: ws.resolver,
          policy: { granted: ws.granted },
          payloads: ws.payloads,
        },
      });
      assert.equal(report.match, true, JSON.stringify(report.frames.filter((f) => !f.match).slice(0, 3), null, 2));
      assert.equal(report.hermetic, true, "the replay reached no adapter at all");
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("an in-process TOOL from the same door is registered, granted and callable", async () => {
  const w = workspace();
  try {
    const ext = await loadExtensionModules([w.module]);
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]), process.env, undefined, [], ext);
    try {
      assert.equal(
        ws.engine.tools.list().some((t) => t.name === "house.ping"),
        true,
        "the extension tool is in the registry `openWorkspace` actually built",
      );
      // REGISTERED BEFORE THE GRANT LIST IS DERIVED, which is the ordering the `mcp`
      // parameter exists for. A tool registered after this snapshot holds no capability.
      assert.equal(ws.granted.includes("house:ping"), true);
      // AND THE BUILT-INS ARE STILL THERE, registered on top: an extension does not displace
      // the jail's own tools.
      assert.equal(
        ws.engine.tools.list().some((t) => t.name === "fs.write"),
        true,
      );
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("the MOCK is not registered over an extension's default claim", async () => {
  const w = workspace();
  try {
    const ext = await loadExtensionModules([w.module]);
    assert.equal(ext.claimsDefault, true);
    // NO `--models-file`. Before this condition existed the mock was registered
    // unconditionally with `asDefault: true`, so every agent node in a deployment the
    // operator had extended answered `[mock] …`.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]), process.env, undefined, [], ext);
    try {
      assert.equal(ws.engine.models.require().provider, "bedrock");
      assert.equal(ws.engine.models.get("mock"), undefined, "and the mock is not registered beside it");
    } finally {
      ws.close();
    }

    // The control: with no extension the mock is still the default, so this did not
    // degenerate into "the mock is gone".
    const plain = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      assert.equal(plain.engine.models.require().provider, "mock");
    } finally {
      plain.close();
    }
  } finally {
    w.dispose();
  }
});

// ── the refusals ─────────────────────────────────────────────────────────────

test("every way an --extension-module can fail is a REFUSAL TO BOOT, naming the path", async () => {
  const w = workspace();
  try {
    const cases: readonly [string, RegExp][] = [
      [join(w.dir, "no-such-file.mjs"), /could not be loaded/],
      [moduleAt(w.dir, "throws.mjs", `throw new Error("boom at import");\n`), /could not be loaded.*boom at import/s],
      [moduleAt(w.dir, "nodefault.mjs", `export const x = 1;\n`), /no default export that is a function.*no default export/s],
      [moduleAt(w.dir, "notfn.mjs", `export default 7;\n`), /default export of type number/],
      [moduleAt(w.dir, "throwing-factory.mjs", `export default () => { throw new Error("no credentials"); };\n`), /threw while registering.*no credentials/s],
      [moduleAt(w.dir, "empty.mjs", `export default () => {};\n`), /registered nothing/],
    ];
    for (const [path, expected] of cases) {
      await assert.rejects(
        () => loadExtensionModules([path]),
        (e: unknown) =>
          isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && expected.test(e.message) && e.message.includes(path),
        path,
      );
    }
  } finally {
    w.dispose();
  }
});

test("a SECOND module that registers nothing is refused even though the first registered plenty", async () => {
  const w = workspace();
  try {
    const inert = moduleAt(w.dir, "inert.mjs", `export default () => {};\n`);
    await assert.rejects(
      () => loadExtensionModules([w.module, inert]),
      (e: unknown) => isLoomError(e) && /registered nothing/.test(e.message) && e.message.includes(inert),
    );
  } finally {
    w.dispose();
  }
});

test("TWO MODULES CLAIMING ONE ADAPTER NAME are refused — and NOT as \"registered nothing\"", async () => {
  // The counter behind "registered nothing" is the number of `register` CALLS and not the
  // number of distinct names, and this is the case that forces the distinction. Off
  // `registered.size` the second module leaves the size unchanged and would have been
  // refused for registering nothing — a refusal in the safe direction carrying a claim that
  // is false, which is worse than the silence it replaced.
  const w = workspace();
  try {
    const second = moduleAt(
      w.dir,
      "bedrock-again.mjs",
      `export default ({ models }) => { models.register({ provider: "bedrock", stream(){}, priceOf(){return 0;}, estimateOf(){return 0;} }); };\n`,
    );
    await assert.rejects(
      () => loadExtensionModules([w.module, second]),
      (e: unknown) =>
        isLoomError(e) &&
        /registers the adapter name "bedrock", which .* already registered/.test(e.message) &&
        e.message.includes(w.module) &&
        e.message.includes(second),
    );
  } finally {
    w.dispose();
  }
});

test("a module that registers a tool OVER another module's tool still counts as having registered", async () => {
  // `ToolRegistry` shadows on name collision, so `list().length` cannot tell "did nothing"
  // from "replaced something" either. Shadowing is legal — the registry's whole disposal
  // discipline is built on it — so this must NOT be refused.
  const w = workspace();
  try {
    const shadow = moduleAt(
      w.dir,
      "shadow.mjs",
      `export default ({ tools }) => { tools.register({ name: "house.ping", version: "2.0", description: "d", ` +
        `capabilities: ["house:ping"], irreversibility: "read_only", idempotent: true, parameters: { type: "object", properties: {} }, ` +
        `execute: () => ({ pong: false }) }); };\n`,
    );
    const ext = await loadExtensionModules([w.module, shadow]);
    assert.equal(ext.tools.require("house.ping").version, "2.0", "the later module's definition is live");
  } finally {
    w.dispose();
  }
});

test("an adapter name that COLLIDES with a --models-file row refuses, naming both", async () => {
  const w = workspace();
  try {
    const ext = await loadExtensionModules([w.module]);
    const clash = join(w.dir, "clash.json");
    writeFileSync(
      clash,
      JSON.stringify({
        adapters: [{ name: "bedrock", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: null }],
        routes: { "agent_profile/writer@stable": { adapter: "bedrock", model: "m" } },
      }),
    );
    assert.throws(
      () => readModels(clash, {}, undefined, ext.adapters),
      (e: unknown) => isLoomError(e) && /an --extension-module already registered/.test(e.message),
      "one of the two would never be reachable, and the registry cannot say which",
    );
  } finally {
    w.dispose();
  }
});

test("a models file with NO adapters row is legal only when an extension supplied one", async () => {
  const w = workspace();
  try {
    // Refused with nothing registered…
    assert.throws(
      () => readModels(w.models, {}),
      (e: unknown) => isLoomError(e) && /at least one adapter/.test(e.message),
    );
    // …and accepted with the extension's, which is the case the route table is for.
    const ext = await loadExtensionModules([w.module]);
    const cfg = readModels(w.models, {}, undefined, ext.adapters);
    assert.deepEqual(cfg.adapters, [], "the boot line names the FILE's rows, and this file declares none");
    assert.deepEqual(cfg.routes, ["agent_profile/writer@stable"]);
  } finally {
    w.dispose();
  }
});
