/**
 * Tests for the time-travel extension: a persisted, branching checkpoint TREE
 * over the dormant Agent.snapshot()/restore() primitive. All offline against the
 * scriptable MockProvider.
 *
 * Each test points EAGENT_TIME_TRAVEL_DIR at a fresh mkdtemp dir (so blobs never
 * touch the real workspace) and saves/restores both EAGENT_TIME_TRAVEL_DIR and
 * the EAGENT_TIME_TRAVEL kill switch. The store index is read back directly off
 * the MemoryBackend the test owns, so assertions are about real structure.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import timeTravel from "../src/extensions/time-travel.js";
import { BUILTIN_EXTENSIONS } from "../src/host.js";
import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { ExtensionHost } from "../src/kernel/extension.js";
import { MemoryBackend, type StoreBackend } from "../src/kernel/store.js";
import type { MockResponder } from "../src/providers/mock.js";
import { MockProvider } from "../src/providers/mock.js";
import { autoUI, silentLogger } from "./helpers.js";

/** The Node index shape the extension persists in `e.store.get("nodes")`. */
interface Node {
  id: string;
  step: number;
  parentId?: string;
  label?: string;
  ts: number;
}

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** A fresh temp dir for blobs, tracked for cleanup. */
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eagent-tt-"));
  tempDirs.push(dir);
  return dir;
}

/**
 * Run `body` with EAGENT_TIME_TRAVEL_DIR pointed at a fresh temp dir and the
 * EAGENT_TIME_TRAVEL kill switch cleared, restoring both afterwards. Returns the
 * blob dir so a test can inspect/clean it.
 */
async function withEnv(body: (dir: string) => Promise<void>): Promise<void> {
  const prevDir = process.env.EAGENT_TIME_TRAVEL_DIR;
  const prevKill = process.env.EAGENT_TIME_TRAVEL;
  const dir = freshDir();
  process.env.EAGENT_TIME_TRAVEL_DIR = dir;
  delete process.env.EAGENT_TIME_TRAVEL;
  try {
    await body(dir);
  } finally {
    if (prevDir === undefined) delete process.env.EAGENT_TIME_TRAVEL_DIR;
    else process.env.EAGENT_TIME_TRAVEL_DIR = prevDir;
    if (prevKill === undefined) delete process.env.EAGENT_TIME_TRAVEL;
    else process.env.EAGENT_TIME_TRAVEL = prevKill;
  }
}

interface Slice {
  agent: Agent;
  host: ExtensionHost;
  commands: CommandRegistry;
  provider: MockProvider;
  backend: StoreBackend;
  store: ReturnType<StoreBackend["open"]>;
  run: (name: string, args?: string) => Promise<string[]>;
}

/** A minimal host slice wired to MockProvider; only the caller's extensions load. */
function makeSlice(opts: { backend?: StoreBackend; responder?: MockResponder } = {}): Slice {
  const backend = opts.backend ?? new MemoryBackend();
  const ui = autoUI(true);
  const capabilities = new CapabilityManager({ ui, fallback: "allow" });
  const agent = new Agent({ ui, logger: silentLogger, capabilities, provider: "mock", model: "mock" });
  const provider = new MockProvider(opts.responder);
  agent.providers.register(provider, { default: true });
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, logger: silentLogger, store: backend });
  const run = async (name: string, args = ""): Promise<string[]> => {
    const out: string[] = [];
    const cmd = commands.get(name);
    if (!cmd) throw new Error(`no command: ${name}`);
    await cmd.run({ agent, args, print: (l) => out.push(l) });
    return out;
  };
  return { agent, host, commands, provider, backend, store: backend.open("time-travel"), run };
}

function readNodes(slice: Slice): Record<string, Node> {
  return slice.store.get<Record<string, Node>>("nodes", {}) ?? {};
}

// -- AC-3: checkpoint + rewind round-trip ------------------------------------

test("AC-3 checkpoint+rewind restores transcript and step; later turns are gone", async () => {
  await withEnv(async () => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    await slice.agent.run("first");
    const checkpointStep = slice.agent.snapshot().step;
    const checkpointLen = slice.agent.messages.length;
    const created = await slice.run("timetravel", "checkpoint");
    const id = /checkpoint (\d+)/.exec(created.join("\n"))?.[1];
    assert.ok(id, "checkpoint command prints the new node id");

    // Run more turns: the transcript grows past the checkpoint.
    await slice.agent.run("second");
    await slice.agent.run("third");
    assert.ok(slice.agent.messages.length > checkpointLen, "later turns extended the transcript");
    assert.ok(slice.agent.snapshot().step > checkpointStep, "step advanced past the checkpoint");

    const rewound = await slice.run("rewind", id!);
    assert.match(rewound.join("\n"), /rewound to/);
    assert.equal(slice.agent.messages.length, checkpointLen, "transcript truncated back to the checkpoint");
    assert.equal(slice.agent.snapshot().step, checkpointStep, "step restored to the checkpoint");
    // The first user message survives; the later ones are gone.
    const userTexts = slice.agent.messages
      .filter((m) => m.role === "user")
      .flatMap((m) => m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text));
    assert.deepEqual(userTexts, ["first"], "only the pre-checkpoint user turn remains");
  });
});

// -- AC-4: fork forms a branch -----------------------------------------------

test("AC-4 fork creates a second child under the forked node; head is on the fork line", async () => {
  await withEnv(async () => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    await slice.agent.run("turn-a");
    const a = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(a, "node A created");

    // B-line: continue from A and checkpoint (auto is off, so capture explicitly).
    await slice.agent.run("turn-b");
    const b = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(b, "node B created");

    // Fork off A: materializes a sibling branch node F whose parent is A.
    const forked = await slice.run("fork", a!);
    const f = /forked (\d+)/.exec(forked.join("\n"))?.[1];
    assert.ok(f, "fork node F created");

    await slice.agent.run("turn-fork");
    const g = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(g, "node G created on the fork line");

    const nodes = readNodes(slice);
    const childrenOfA = Object.values(nodes).filter((n) => n.parentId === a);
    assert.equal(childrenOfA.length, 2, "A has exactly two children (the B-line node and the fork node)");
    assert.ok(
      childrenOfA.some((n) => n.id === b) && childrenOfA.some((n) => n.id === f),
      "the two children are B and the fork node F",
    );

    // head is on the fork line: G's ancestry passes through F, not B.
    const head = slice.store.get<string>("head");
    assert.equal(head, g, "head is the latest fork-line node");
    assert.equal(nodes[g!]?.parentId, f, "G's parent is the fork node F");
  });
});

// -- AC-5: persistence across a fresh extension instance ---------------------

test("AC-5 a fresh activation over the same store + blob dir sees the tree and rewinds", async () => {
  await withEnv(async () => {
    const backend = new MemoryBackend();

    // First instance: write a small tree.
    const first = makeSlice({ backend, responder: { text: "ok" } });
    await first.host.use("time-travel", timeTravel);
    await first.run("timetravel", "on");
    await first.agent.run("first");
    const id = /checkpoint (\d+)/.exec((await first.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(id, "checkpoint written by the first instance");
    const capturedLen = first.agent.messages.length;
    await first.host.dispose();

    // Second instance: fresh agent + host, SAME store backend + same blob dir.
    const second = makeSlice({ backend, responder: { text: "ok" } });
    await second.host.use("time-travel", timeTravel);
    assert.equal(second.agent.messages.length, 0, "the second agent starts empty");

    const tree = await second.run("tree");
    assert.match(tree.join("\n"), new RegExp(`\\b${id}\\b`), "/tree lists the prior node id");

    const rewound = await second.run("rewind", id!);
    assert.match(rewound.join("\n"), /rewound to/);
    assert.equal(second.agent.messages.length, capturedLen, "the persisted blob restored the transcript");
  });
});

// -- AC-6: refuses mid-run / off-by-default ----------------------------------

test("AC-6 /rewind mid-run prints a clean error and never throws out of the command", async () => {
  await withEnv(async () => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    await slice.agent.run("first");
    const id = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(id);

    // Park the loop inside a turn so the agent is provably running while we rewind.
    let openGate!: () => void;
    const gate = new Promise<void>((r) => (openGate = r));
    const off = slice.agent.hooks.on("turn_start", async () => {
      await gate;
    });
    const runP = slice.agent.run("second");
    await new Promise((r) => setTimeout(r, 0)); // let the loop reach turn_start and park
    assert.equal(slice.agent.running, true, "agent is mid-run");

    const out = await slice.run("rewind", id!);
    assert.match(out.join("\n"), /cannot rewind/i, "rewind surfaces a clean error, no throw");

    openGate();
    await runP; // the run still completes normally
    off.dispose();
  });
});

test("AC-6 off-by-default: /timetravel checkpoint is inert and writes no blob", async () => {
  await withEnv(async (dir) => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel); // loaded but NOT enabled

    await slice.agent.run("first");
    await slice.run("timetravel", "checkpoint");

    assert.deepEqual(readNodes(slice), {}, "no node added while disabled");
    const files = existsSync(dir) ? readdirSync(dir) : [];
    assert.deepEqual(files, [], "no blob file written while disabled");
  });
});

// -- AC-7: disjoint command names --------------------------------------------

test("AC-7 timetravel/rewind/fork/tree are disjoint from every other built-in's commands", async () => {
  const backend = new MemoryBackend();
  const agent = new Agent({
    ui: autoUI(true),
    logger: silentLogger,
    capabilities: new CapabilityManager({ ui: autoUI(true), fallback: "allow" }),
    provider: "mock",
    model: "mock",
  });
  agent.providers.register(new MockProvider(), { default: true });
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, logger: silentLogger, store: backend });
  for (const [id, act] of BUILTIN_EXTENSIONS.filter(([id]) => id !== "time-travel")) {
    try {
      await host.use(id, act);
    } catch {
      // an extension that fails to activate registered nothing — irrelevant here
    }
  }
  const names = new Set(commands.list().map((c) => c.name));
  for (const own of ["timetravel", "rewind", "fork", "tree"]) {
    assert.ok(!names.has(own), `command /${own} must not collide with another built-in`);
  }
  await host.dispose();
});

// -- AC-8: tree-coherent cap -------------------------------------------------

test("AC-8 cap evicts an ancestor, re-parents survivors, prunes its blob, keeps head live", async () => {
  await withEnv(async (dir) => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");
    slice.store.set("cap", 2); // tiny cap so a linear chain evicts ancestors

    const ids: string[] = [];
    for (const word of ["one", "two", "three", "four"]) {
      await slice.agent.run(word);
      const id = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
      assert.ok(id);
      ids.push(id!);
    }

    const nodes = readNodes(slice);
    const surviving = Object.keys(nodes);
    assert.ok(surviving.length <= 2, "tree size stays within the cap");

    // The two oldest nodes were evicted; their blob files are gone.
    for (const id of ids.slice(0, ids.length - surviving.length)) {
      assert.ok(!existsSync(join(dir, `${id}.json`)), `evicted blob ${id}.json is deleted`);
      assert.ok(!(id in nodes), `evicted node ${id} dropped from the index`);
    }

    // Every survivor is reachable from a root: no dangling parentId.
    for (const n of Object.values(nodes)) {
      if (n.parentId !== undefined) {
        assert.ok(n.parentId in nodes, `node ${n.id} has no dangling parentId`);
      }
    }
    // head resolves to a live node.
    const head = slice.store.get<string>("head");
    assert.ok(head !== undefined && head in nodes, "head resolves to a surviving node");
  });
});

// -- D-W9.6d: malformed-blob rejection before the non-atomic restore ----------

test("D-W9.6d /rewind REJECTS a malformed blob before restore — transcript intact", async () => {
  await withEnv(async (dir) => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    await slice.agent.run("first");
    const id = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(id);

    // Grow the live transcript past the checkpoint, then snapshot what's live now.
    await slice.agent.run("second");
    const liveLen = slice.agent.messages.length;
    const liveStep = slice.agent.snapshot().step;
    assert.ok(liveLen > 0);

    // Corrupt the blob to valid JSON but a malformed AgentState: `messages` is not
    // an array. readBlob parses it; Agent.restore is non-atomic (clears #messages
    // BEFORE the throwing spread of a non-iterable), so without a pre-check the
    // transcript is wiped. The shape check must reject it before restore runs.
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ messages: 42, usage: {}, model: "mock", systemPrompt: "", thinking: "off", step: 0 }),
      "utf8",
    );

    const out = await slice.run("rewind", id!);
    assert.match(out.join("\n"), /malformed|refus/i, "a clear rejection message, not a restore");
    assert.equal(slice.agent.messages.length, liveLen, "transcript NOT wiped (restore never ran)");
    assert.equal(slice.agent.snapshot().step, liveStep, "step unchanged");
  });
});

test("D-W9.6d /rewind accepts a valid snapshot with providerName undefined", async () => {
  await withEnv(async (dir) => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    await slice.agent.run("first");
    const checkpointLen = slice.agent.messages.length;
    const id = /checkpoint (\d+)/.exec((await slice.run("timetravel", "checkpoint")).join("\n"))?.[1];
    assert.ok(id);

    // Rewrite the blob as a real, valid AgentState whose providerName is OMITTED
    // (the field is string | undefined) — the shape check must NOT over-reject it.
    const blob: Record<string, unknown> = { ...slice.agent.snapshot() };
    delete blob.providerName;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(blob), "utf8");

    await slice.agent.run("second");
    assert.ok(slice.agent.messages.length > checkpointLen, "transcript grew past the checkpoint");

    const out = await slice.run("rewind", id!);
    assert.match(out.join("\n"), /rewound to/, "the valid snapshot restored");
    assert.equal(slice.agent.messages.length, checkpointLen, "transcript restored to the checkpoint");
  });
});

test("D-W9.6d /checkpoint over a non-cloneable transcript fails cleanly (no throw out of the command)", async () => {
  await withEnv(async () => {
    const slice = makeSlice({ responder: { text: "ok" } });
    await slice.host.use("time-travel", timeTravel);
    await slice.run("timetravel", "on");

    // Poison the transcript: a message whose meta holds a function is not
    // structuredClone-able, so snapshot() throws. Steering injects it; the run
    // drains it into the live transcript.
    slice.agent.steer({ role: "user", content: [{ type: "text", text: "x" }], meta: { fn: () => {} } });
    await slice.agent.run("first");

    const out = await slice.run("timetravel", "checkpoint");
    assert.match(out.join("\n"), /cannot checkpoint/i, "the failed snapshot surfaces a clean error, not a throw");
    assert.deepEqual(readNodes(slice), {}, "no node written when the snapshot fails");
  });
});
