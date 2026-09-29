/**
 * `loom replay` OF A RUN THAT REWROTE ITSELF — the CLI half of §A.102.
 *
 * A mutation's added refs are resolved LIVE when the replay re-adopts the served proposal, and the
 * CLI handed `replayRun` no resolver, so the shadow Engine resolved nothing. Two consequences, both
 * measured through the binary at `e59a969a`, and both "the replayer differed, blamed on the run":
 *
 *   - a mutation-added `function` ref failed the shadow's compile, so an UNEDITED run replayed
 *     `✗ run.message … GRAPH015_RESOURCE_NOT_FOUND`, exit 1 — and an EDITED one said the same, so
 *     the verb could not tell the two apart;
 *   - a ref an `--extension-module` resolver answered was dropped from the shadow's successor, so
 *     once §A.102 bound successors (`replay.ts`, `unboundSuccessors`) an unedited run went exit 1
 *     `=(absent)` — and before it, an EDITED one replayed exit 0.
 *
 * The replay now gets `ws.resolver`: the SAME object `loom run`'s Engine resolves through,
 * whichever of the workspace's documents or a module's substitute that is. Every case here is
 * driven through `main()` — run, approve, replay — with nothing but the journal between verbs.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "../../src/cli.ts";

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

const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "mutable", project: "bind", version: 1 },
  policy: {
    posture: "out",
    capabilities: ["graph:mutate"],
    budget: { costUsd: 1 },
    expansion: { maxNodes: 8, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 },
  },
  channels: {
    note: { type: "string", reduce: "replace" },
    out: { type: "object", reduce: "replace" },
    done: { type: "object", reduce: "replace" },
  },
  inputs: ["note"],
  outputs: ["out"],
  nodes: [
    {
      id: "propose",
      type: "agent",
      reads: ["note"],
      writes: ["out"],
      agent: {
        profile: "agent_profile/p@stable",
        prompt: "prompt/p@stable",
        maxTurns: 1,
        canMutate: true,
        outputSchema: { type: "object", properties: { ok: { type: "boolean" }, mutation: { type: "object" } } },
      },
    },
  ],
  edges: [],
};

/** A gate on the proposer, and — when `withFunction` — a published `function` behind it. */
function mutation(withFunction: boolean): object {
  return {
    reason: "gate it",
    addNodes: [
      { id: "added_gate", type: "human_gate", reads: ["note"], writes: [], humanGate: { ref: "oversight/added@stable", approval: { approvers: ["u:alice"] } } },
      ...(withFunction ? [{ id: "added_fn", type: "function", reads: ["note"], writes: ["done"], function: { ref: "function/added@stable" } }] : []),
    ],
    addEdges: [
      { id: "e_gate", from: "propose", to: "added_gate", kind: "seq" },
      ...(withFunction ? [{ id: "e_fn", from: "added_gate", to: "added_fn", kind: "seq" }] : []),
    ],
  };
}

/** A model adapter proposing `mutation`, and — when `resolverFile` — a resolver that owns every ref. */
function moduleSource(m: object, resolverFile?: string): string {
  const resolver =
    resolverFile === undefined
      ? ""
      : `
  // THE MODULE OWNS RESOLUTION: every ref answers with a digest of its own name, and the ONE ref only
  // the mutation adds also folds in a file's CURRENT bytes — so editing the file moves that ref and
  // nothing the authored graph names, which run.compiled's manifest would already catch.
  resolver.register({
    resolve: (ref) => ({ ref, digest: "sha256:" + createHash("sha256").update(ref + (ref.startsWith("oversight/") ? readFileSync(${JSON.stringify(resolverFile)}, "utf8") : "")).digest("hex"), channel: "stable" }),
    document: () => "Propose.",
  });`;
  return `
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const MUTATION = ${JSON.stringify(m)};
class Mut {
  provider = "mut";
  async *stream(req) {
    const text = JSON.stringify({ ok: true, mutation: MUTATION });
    yield { type: "text_delta", text };
    yield { type: "done", message: { role: "assistant", content: text }, provider: this.provider, finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, wallMs: 0 } };
  }
  priceOf() { return 0; }
  estimateOf() { return 0; }
  outputCeilingOf(req) { return req.maxTokens ?? 4096; }
}
export default ({ models, resolver }) => {
  models.register(new Mut());${resolver}
};
`;
}

interface Ws {
  readonly dir: string;
  readonly flags: readonly string[];
}

function workspace(t: { after: (fn: () => void) => void }, opts: { withFunction: boolean; moduleResolver: boolean }): Ws {
  const dir = mkdtempSync(join(tmpdir(), "loom-replay-mut-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const d of ["graphs", "resources/prompt", "resources/agent_profile", "resources/function"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "graphs", "mutable.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "resources", "prompt", "p.md"), "Propose.\n");
  writeFileSync(join(dir, "resources", "agent_profile", "p.md"), "You propose.\n");
  writeFileSync(join(dir, "resources", "function", "added.js"), "function (view) { return { writes: { done: { v: 1 } } }; }\n");
  const resolverFile = join(dir, "module-resolved.txt");
  writeFileSync(resolverFile, "one\n");
  const mod = join(dir, "mut.mjs");
  writeFileSync(mod, moduleSource(mutation(opts.withFunction), opts.moduleResolver ? resolverFile : undefined));
  const models = join(dir, "models.json");
  writeFileSync(models, JSON.stringify({ routes: { "agent_profile/p@stable": { adapter: "mut", model: "m", prices: { m: { input: 0, output: 0 } } } } }));
  return { dir, flags: ["--workspace", dir, "--models-file", models, "--extension-module", mod, "--grant", "graph:mutate"] };
}

/** Run the mutable graph to the mutation-added gate, approve it, and hand back the finished run. */
async function recordApproved(w: Ws): Promise<string> {
  const run = await cli(["run", join(w.dir, "graphs", "mutable.json"), ...w.flags, "--input", JSON.stringify({ note: "n" })]);
  const parsed = JSON.parse(run.out) as { runId: string; status: string };
  assert.equal(parsed.status, "awaiting_gate", `the mutation parked the run on its added gate: ${run.out}${run.err}`);
  const gate = /gate (gate_[0-9A-Za-z]+) on node added_gate/.exec(run.err)?.[1];
  assert.ok(gate !== undefined, `the added gate is named: ${run.err}`);
  const approved = await cli(["approve", parsed.runId, gate, "--as", "u:alice", ...w.flags]);
  assert.equal(approved.code, 0, approved.err);
  assert.equal((JSON.parse(approved.out) as { status: string }).status, "succeeded", approved.out);
  return parsed.runId;
}

const replay = (w: Ws, runId: string) => cli(["replay", runId, ...w.flags]);
const matchOf = (out: string): boolean => (JSON.parse(out) as { match: boolean }).match;

test("A MUTATED RUN WITH AN ADDED `function` REPLAYS match: true UNEDITED, and ✗ graph.bound EDITED", async (t) => {
  const w = workspace(t, { withFunction: true, moduleResolver: false });
  const runId = await recordApproved(w);

  const clean = await replay(w, runId);
  assert.equal(clean.code, 0, `unedited: exit 0 — ${clean.err}`);
  assert.equal(matchOf(clean.out), true);

  // THE ADDED FUNCTION'S FILE IS EDITED — same output, different bytes.
  writeFileSync(join(w.dir, "resources", "function", "added.js"), "function (view) { /* edited */ return { writes: { done: { v: 1 } } }; }\n");
  const moved = await replay(w, runId);
  assert.equal(moved.code, 1, "edited: exit 1");
  assert.equal(matchOf(moved.out), false);
  assert.match(moved.err, /✗ graph\.bound propose@root#0 ?: expected function\/added@stable=sha256:[0-9a-f]{10}…, got function\/added@stable=sha256:[0-9a-f]{10}…/, moved.err);
  assert.doesNotMatch(moved.err, /GRAPH015/, "and it is the binding that failed, not the shadow's compile");
});

test("A REF AN --extension-module RESOLVER ANSWERED replays match: true UNEDITED, and ✗ graph.bound EDITED", async (t) => {
  // The reviewer's case: the module substitutes the whole resolver, so `oversight/added@stable`
  // resolves at record time and is on the successor's manifest. The replay has to be handed that
  // SAME resolver, or the shadow's successor lacks the ref and the unedited run reads `=(absent)`.
  const w = workspace(t, { withFunction: false, moduleResolver: true });
  const runId = await recordApproved(w);

  const clean = await replay(w, runId);
  assert.equal(clean.code, 0, `unedited: exit 0 — ${clean.err}`);
  assert.equal(matchOf(clean.out), true);

  writeFileSync(join(w.dir, "module-resolved.txt"), "two\n");
  const moved = await replay(w, runId);
  assert.equal(moved.code, 1, "edited: exit 1");
  assert.match(moved.err, /✗ graph\.bound/, moved.err);
});

test("A RUN THAT NEVER MUTATED still replays match: true — the resolver changes nothing for it", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "loom-replay-plain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  writeFileSync(
    join(dir, "graphs", "plain.json"),
    JSON.stringify({
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "plain", project: "bind", version: 1 },
      policy: { posture: "out" },
      channels: { note: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
      inputs: ["note"],
      outputs: ["out"],
      nodes: [{ id: "f", type: "function", reads: ["note"], writes: ["out"], function: { ref: "function/f@stable" } }],
      edges: [],
    }),
  );
  writeFileSync(join(dir, "resources", "function", "f.js"), "function (view) { return { writes: { out: { n: view.require('note') } } }; }\n");
  const run = await cli(["run", join(dir, "graphs", "plain.json"), "--workspace", dir, "--input", JSON.stringify({ note: "n" })]);
  const { runId, status } = JSON.parse(run.out) as { runId: string; status: string };
  assert.equal(status, "succeeded", run.err);
  const r = await cli(["replay", runId, "--workspace", dir]);
  assert.equal(r.code, 0, r.err);
  assert.equal(matchOf(r.out), true);
  // THE AUTHORED HALF STILL BINDS: an edit to the graph's own function is caught as before.
  writeFileSync(join(dir, "resources", "function", "f.js"), "function (view) { /* edited */ return { writes: { out: { n: view.require('note') } } }; }\n");
  const moved = await cli(["replay", runId, "--workspace", dir]);
  assert.equal(moved.code, 1);
  assert.match(moved.err, /✗ graph\.bound\s*: expected function\/f@stable=/, moved.err);
});

