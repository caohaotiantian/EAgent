/**
 * THE FORK LEDGER IS FOUR ROWS SHORTER, AND THIS IS THE MEASUREMENT THAT SAYS SO.
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
 *
 * **THE OTHER TWO ROWS ARE `channels` AND `identity`, AND THEIR REASON WAS NEVER REPLAY EITHER.**
 * README said so itself — *"a delivery transport, an identity source — nobody built the seam"* —
 * and named the pinned types a library embedder already reached: `DeliveryChannel`,
 * `GateDispatcher`, `IdentitySource`, `startControlPlane`. The refusals the binary printed were
 * honest and named the WRONG DOOR:
 *
 *     E_CONFIG_INVALID: unknown flag: --channels-module (did you mean --channels-file?)
 *     E_CONFIG_INVALID: unknown flag: --identity-module (did you mean --identity-file?)
 *
 * There is still no such flag and there is deliberately not going to be one: `cli.ts`'s own
 * docstring said a transport "should EXTEND this object when it is built, rather than invent a
 * second flag", because the argv-only trust argument is written once and a second door would
 * have to re-earn it. So the factory is handed `{models, tools, channels, identity}` and the
 * last three tests here drive what that buys: a transport that is not an HTTP webhook taking a
 * real gate delivery with no channels file in sight, a source that is not a token file deciding
 * who a caller is, and the collisions that refuse rather than pick a winner by load order.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { controlPlaneOptions, loadExtensionModules, main, openWorkspace, parseArgs, readChannels, readModels } from "../../src/cli.ts";
import { completeLines, serving } from "../deployment/harness.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { ModelRegistry } from "../../src/run/registry.ts";
import { replayRun } from "../../src/run/replay.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import { HumanGateBroker } from "../../src/run/gates.ts";
import { RunLog } from "../../src/run/log.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId, RunId, TaskId } from "../../src/ids.ts";

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

// ── what the boot line may say ───────────────────────────────────────────────

/** A module that registers a tool and NO adapter — the shape that exposed the defect. */
const TOOL_ONLY = `
export default ({ tools }) => {
  tools.register({
    name: "NAME.ping",
    version: "1.0",
    description: "A tool this binary has never heard of.",
    capabilities: ["NAME:ping"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: { type: "object", properties: {} },
    execute: () => ({ pong: true }),
  });
};
`;

test("THE `ext:` LINE NAMES ONLY WHAT THE MODULE REGISTERED — the adapter map is a SNAPSHOT", async () => {
  const w = workspace();
  try {
    const only = moduleAt(w.dir, "tool-only.mjs", TOOL_ONLY.replaceAll("NAME", "house"));
    const ext = await loadExtensionModules([only]);
    assert.deepEqual([...ext.adapters.keys()], [], "the premise: this module registered no adapter");

    // THE DEFECT. `adapters` used to BE `ObservedModelRegistry.registered`, the live map, and
    // `openWorkspace` registers the mock (and, with a --models-file, the RoutingAdapter) into
    // that same registry — so the field grew after the loader returned and the boot line printed
    // `→ adapter mock, tool house.ping` for a module that registered neither.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]), process.env, undefined, [], ext);
    try {
      assert.equal(ws.engine.models.get("mock")?.provider, "mock", "the premise: the mock really was registered");
      assert.deepEqual([...ext.adapters.keys()], [], "…into the registry, and NOT into the loader's answer");
    } finally {
      ws.close();
    }
    assert.deepEqual([...ext.toolNames], ["house.ping"], "and the tool half was always a snapshot");
  } finally {
    w.dispose();
  }
});

test("…AND THE PRINTED LINE SAYS SO, driven against a real boot", async () => {
  // The half a unit test cannot reach: `announce` renders `[...ext.adapters.keys()]`, and until
  // this test nothing in the tree asserted the line's CONTENT — the suite passed either way,
  // which is the second half of the finding. Spawns `loom serve` on port 0 and reads its banner.
  const w = workspace();
  try {
    const only = moduleAt(w.dir, "tool-only.mjs", TOOL_ONLY.replaceAll("NAME", "house"));
    const s = await serving(["serve", "--workspace", w.dir, "--port", "0", "--extension-module", only]);
    try {
      const line = completeLines(s.out).find((l) => l.trimStart().startsWith("ext:"));
      assert.ok(line !== undefined, `no ext: line in:\n${s.out}`);
      assert.equal(/adapter mock/.test(line), false, `the module registered no adapter: ${line}`);
      assert.match(line, /→ no adapters, tool house\.ping$/, line);
    } finally {
      await s.stop();
    }
  } finally {
    w.dispose();
  }
});

test("A REPEATED --extension-module IS REFUSED — last-wins would drop a module named on argv", async () => {
  const w = workspace();
  try {
    const a = moduleAt(w.dir, "a.mjs", TOOL_ONLY.replaceAll("NAME", "aa"));
    const b = moduleAt(w.dir, "b.mjs", TOOL_ONLY.replaceAll("NAME", "bb"));

    // THE DEFECT: `parseArgs` is last-wins, so `a` was dropped and the plane BOOTED — the one
    // arm `loadExtensionModules`' docstring says does not exist ("there is no arm in which a
    // module named on argv is skipped and the process keeps going") and USAGE says refuses.
    await assert.rejects(
      () => cli(["compile", "nope.json", "--workspace", w.dir, "--extension-module", a, "--extension-module", b]),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        /--extension-module was given more than once/.test(e.message) &&
        /comma-separated/.test(e.message),
      "a repeat must refuse, and name the spelling that works",
    );

    // AND THE COMMA FORM IS THE ONE THAT WORKS, so the refusal is not a dead end: both modules
    // load, in argv order.
    const ext = await loadExtensionModules([a, b]);
    assert.deepEqual([...ext.toolNames].sort(), ["aa.ping", "bb.ping"]);

    // THE CONTROL — repetition is refused for THIS flag only. `--grant` repeated is still
    // last-wins, because for every other flag a dropped repeat is an override or a narrowing.
    const twice = parseArgs(["compile", "g.json", "--grant", "a:b", "--grant", "c:d"]);
    assert.equal(twice.flags["grant"], "c:d");
    assert.deepEqual([...twice.repeated], ["grant"], "seen, and deliberately not refused");
  } finally {
    w.dispose();
  }
});

// ── the other two rows: a transport, and who a caller is ─────────────────────

/**
 * A transport that is not an HTTP webhook, written the way a stranger would have to write it.
 *
 * IT RECORDS TO A FILE BESIDE ITSELF rather than to a variable, and that is not a convenience:
 * `--extension-module` loads through `await import()`, so the channel object lives in the
 * module's own graph and a test cannot reach into it. A file is the only observation that
 * proves the delivery went all the way through the dispatcher THIS BINARY built — the same
 * boundary a real SMTP or Slack-app channel is on the far side of.
 */
const SMTP_MODULE = `
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const LOG = fileURLToPath(new URL("./delivered.log", import.meta.url));
class SmtpChannel {
  name = "ops-email";
  async deliver(target) {
    appendFileSync(LOG, target.gate.gateId + "\\n");
    return "smtp-message-id";
  }
}
export default ({ channels }) => { channels.register(new SmtpChannel()); };
`;

/** A source that is not a token file: it trusts a header a terminating proxy set. */
const OIDC_MODULE = `
class ProxyHeaderIdentity {
  name = "NAME";
  identify(req) {
    const s = req.headers["x-forwarded-subject"];
    return s === undefined ? undefined : { subject: s, kind: "human", via: "console" };
  }
}
export default ({ identity }) => { identity.register(new ProxyHeaderIdentity()); };
`;

test("a DELIVERY TRANSPORT that is no HTTP webhook takes a real gate — with NO --channels-file at all", async () => {
  const w = workspace();
  try {
    const mod = moduleAt(w.dir, "smtp.mjs", SMTP_MODULE);
    const ext = await loadExtensionModules([mod]);

    // REGISTERING ONLY A CHANNEL IS REGISTERING SOMETHING. Had the "registered nothing"
    // check kept asking only about adapters and tools, this module — the whole reason the
    // seam exists — would have been the one deployment it refused to boot.
    assert.deepEqual([...ext.channelNames], ["ops-email"]);

    // NO --channels-file. Requiring one beside this would mean writing a JSON file of webhook
    // rows to enable a transport that is not a webhook.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]), process.env, undefined, [], ext);
    try {
      assert.notEqual(ws.delivery, undefined, "no file, and still channels");
      assert.deepEqual(ws.delivery?.notifyOnly, ["ops-email"], "it defines no parseCallback, so it can be told and not answered");
      assert.deepEqual(ws.delivery?.answerable, []);
      assert.deepEqual(ws.delivery?.fromModules, ["ops-email"], "and the banner can tell whose channel it is");

      // THE DELIVERY ITSELF, through the dispatcher `openWorkspace` built, into a module this
      // process only knows by path. Anything short of this is a test of the wiring's shape.
      const runId = "run_ext_channel" as RunId;
      const log = new RunLog(runId, { store: ws.store });
      const broker = new HumanGateBroker({ dispatcher: ws.delivery!.dispatcher });
      const gateId = await broker.raise(log, {
        runId,
        taskId: "ship@root#0" as TaskId,
        nodeId: "ship" as NodeId,
        policyRef: "oversight/ship@stable",
        payload: { question: "ship it?" },
        delivery: { channels: ["ops-email"] },
      });
      assert.equal(readFileSync(join(w.dir, "delivered.log"), "utf8"), `${gateId}\n`);
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("a module channel MERGES with --channels-file, and a name across the two REFUSES", async () => {
  const w = workspace();
  try {
    const ext = await loadExtensionModules([moduleAt(w.dir, "smtp.mjs", SMTP_MODULE)]);
    const file = join(w.dir, "channels.json");

    // BOTH HALVES REACH ONE DISPATCHER, because a graph's delivery spec resolves every channel
    // name through exactly one — so two dispatchers is the one arrangement that cannot work.
    writeFileSync(file, JSON.stringify({ channels: [{ name: "pager", url: "https://events.example.invalid/x" }] }));
    const merged = readChannels(file, ext.channels);
    assert.deepEqual([...merged.notifyOnly].sort(), ["ops-email", "pager"]);
    assert.notEqual(merged.dispatcher.channel("ops-email"), undefined, "the module's channel is addressable by name");
    assert.deepEqual(merged.fromModules, ["ops-email"], "and the file's row is not attributed to the module");

    // AND THE COLLISION REFUSES rather than letting a `Map` keep one silently. The refusal
    // names the module half, because "entry 0 repeats a name" would send an operator looking
    // for a second row in a file that has only one.
    writeFileSync(file, JSON.stringify({ channels: [{ name: "ops-email", url: "https://hooks.example.invalid/x" }] }));
    assert.throws(
      () => readChannels(file, ext.channels),
      (e: unknown) =>
        isLoomError(e) &&
        e.code === CODES.E_CONFIG_INVALID &&
        /repeats the channel name "ops-email", which an --extension-module already registered/.test(e.message),
    );

    // TWO MODULES, ONE CHANNEL NAME — the same refusal one namespace over from the adapter one,
    // and it names both modules.
    const second = moduleAt(
      w.dir,
      "smtp-again.mjs",
      `export default ({ channels }) => { channels.register({ name: "ops-email", deliver: async () => "x" }); };\n`,
    );
    await assert.rejects(
      () => loadExtensionModules([join(w.dir, "smtp.mjs"), second]),
      (e: unknown) =>
        isLoomError(e) &&
        /registers the channel name "ops-email", which .* already registered/.test(e.message) &&
        e.message.includes(join(w.dir, "smtp.mjs")) &&
        e.message.includes(second),
    );
  } finally {
    w.dispose();
  }
});

test("an IDENTITY SOURCE that is not a token file decides who a caller is — and a SECOND one refuses", async () => {
  const w = workspace();
  try {
    const mod = moduleAt(w.dir, "oidc.mjs", OIDC_MODULE.replace("NAME", "proxy-header"));
    const ext = await loadExtensionModules([mod]);
    const ws = openWorkspace(parseArgs(["serve", "--workspace", w.dir]), process.env, undefined, [], ext);
    try {
      // THE PLANE IS BUILT WITH IT. `--identity-file` is not given and does not need to be:
      // this is the field `ControlPlane` authenticates through and `announce` prints as `who:`.
      const opts = controlPlaneOptions(ws, parseArgs(["serve", "--workspace", w.dir]));
      assert.equal(opts.identity?.name, "proxy-header");
      // AND IT REALLY IS THE MODULE'S OBJECT, not a same-named stand-in.
      assert.equal(opts.identity, ext.identity);

      // BOTH TOGETHER IS REFUSED, and the reason is the one non-negotiable this seam could have
      // broken: a chain accepts the UNION of two credential sets, so adding a source could only
      // ever widen who gets in — loosening along a path no human chose.
      const ids = join(w.dir, "identities.json");
      writeFileSync(ids, JSON.stringify({ subjects: [{ subject: "u:you", token: "s3cret" }] }));
      assert.throws(
        () => controlPlaneOptions(ws, parseArgs(["serve", "--workspace", w.dir, "--identity-file", ids])),
        (e: unknown) =>
          isLoomError(e) &&
          e.code === CODES.E_CONFIG_INVALID &&
          /both establish who a caller is \("proxy-header"\)/.test(e.message) &&
          /union of two credential sets/.test(e.message),
      );
    } finally {
      ws.close();
    }

    // TWO MODULES, SAME REASON, refused at load with both paths named — acceptance must not
    // depend on argv order.
    const second = moduleAt(w.dir, "oidc-again.mjs", OIDC_MODULE.replace("NAME", "mtls"));
    await assert.rejects(
      () => loadExtensionModules([mod, second]),
      (e: unknown) =>
        isLoomError(e) &&
        /registers the identity source "mtls", and .* already registered one/.test(e.message) &&
        e.message.includes(mod) &&
        e.message.includes(second),
    );

    // AND A SOURCE THAT CANNOT SAY WHO IT IS is refused at the call, naming the module: the
    // name is what `/health` and every refusal print, so a nameless one is undiagnosable.
    await assert.rejects(
      () => loadExtensionModules([moduleAt(w.dir, "nameless.mjs", `export default ({ identity }) => { identity.register({ identify: () => undefined }); };\n`)]),
      (e: unknown) => isLoomError(e) && /threw while registering.*identity\.register was given a source whose "name" is/s.test(e.message),
    );
  } finally {
    w.dispose();
  }
});
