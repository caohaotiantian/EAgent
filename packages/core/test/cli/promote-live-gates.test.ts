/**
 * `L4-gated-at-least-as-much` HAD NO FIXTURE THAT COULD FAIL IT.
 *
 * `promote-live.test.ts` drives `loom promote --against-cohort` on a two-node graph that gates
 * nothing. Every assertion there is honest and none of them touches oversight, so
 * `L4-gated-at-least-as-much` — the live door's enforcement of "oversight only tightens" —
 * passed vacuously in all eight of its tests. MEASURED, by deleting the whole
 * regression-collection block in `promoteAgainstCohort` (both `gatingRegressions.push` loops,
 * replaced with `void candGates; void baseGates;`) and running that suite:
 *
 *     node --test packages/core/test/cli/promote-live.test.ts
 *     # pass 8   fail 0
 *
 * A guard nothing would notice the deletion of is not a guard. This suite is the fixture that
 * notices, and the same deletion turns the test below red — the mutation is recorded in the
 * commit that added it.
 *
 * ── Why the deleted clause is not redundant with `6-oversight-diff` ─────────────
 *
 * The obvious objection is that the compiler already refuses a candidate that lowers oversight,
 * so a candidate that DELETES a `human_gate` should be caught there. It is not.
 * `rule014And019Oversight` iterates `for (const n of spec.nodes)` over the CANDIDATE's nodes and
 * looks each one up in `baselinePostures`; a node the baseline had and the candidate does not is
 * never visited, so `GRAPH014_OVERSIGHT_LOOSENED` cannot fire for it. The test asserts that
 * directly: `6-oversight-diff` reports "no posture lowered" on a candidate that removed the only
 * gate in the graph. The journal comparison is the only thing that sees it.
 *
 * ── Offline, and structurally so ────────────────────────────────────────────────
 *
 * Same seam as `promote-live.test.ts`: `main(argv, STUB)` hands the workspace a stub `fetch`
 * through `openWorkspace`'s `fetchImpl`, so the models file is real, the adapter is real, the
 * `baseUrl` is never dialled and no socket is opened. Nothing here reads a clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main } from "../../src/cli.ts";
import type { RunId } from "../../src/ids.ts";

// ── the fixture: the same one-question bench, with a human in the middle ─────

/**
 * The assertion, and it compares the agent's text against ground truth DERIVED FROM THE INPUT.
 * A check written from the incumbent's output is one the incumbent passes by construction.
 */
const CHECK = `(view) => {
  const q = String(view.get("question") || "");
  const a = String(view.get("answer") || "");
  const ok = a.indexOf("ANSWER:" + q) >= 0;
  return { writes: { verdict: { pass: ok, confidence: 1, detail: ok ? "answered " + q : "did not answer " + q } } };
}`;

/** The incumbent instruction. Vague on purpose; the stub provider answers it vaguely. */
const BASE_PROMPT = "You are a helper. Say something about the question you are given.\n";
/**
 * The candidate instruction. It carries the marker the stub answers precisely to, and it is
 * DELIBERATELY NO LONGER than the incumbent, so `5-prompt-size` is not what refuses anything
 * here. The whole point of the test is that the candidate is genuinely BETTER: a refusal over a
 * candidate nobody wanted proves nothing.
 */
const BETTER_PROMPT = "PRECISE-MODE. Answer the question exactly.\n";

/**
 * `gated` is the one axis. The gate sits BETWEEN the agent and the evaluator, so a run that
 * reaches it has already spent its model call and has not yet been scored — which is what makes
 * removing the gate a change to oversight and not to the answer.
 */
function graphJson(promptRef: string, gated: boolean): string {
  const nodes: unknown[] = [
    {
      id: "answer",
      type: "agent",
      reads: ["question"],
      writes: ["answer"],
      agent: { profile: "agent_profile/x@stable", prompt: promptRef, maxTurns: 1 },
      // Per-node, because the graph-level budget alone leaves GRAPH009_UNBOUNDED_NODE on
      // stderr for every run of every fixture, which teaches a reader to stop reading stderr.
      policy: { budget: { costUsd: 0.5 } },
    },
  ];
  const edges: unknown[] = [];
  if (gated) {
    nodes.push({
      id: "approve",
      type: "human_gate",
      reads: ["answer"],
      writes: ["answer"],
      humanGate: { ref: "oversight/publish@stable" },
    });
    edges.push({ id: "e0", from: "answer", to: "approve", kind: "seq" });
    edges.push({ id: "e1", from: "approve", to: "check", kind: "seq" });
  } else {
    edges.push({ id: "e1", from: "answer", to: "check", kind: "seq" });
  }
  nodes.push({
    id: "check",
    type: "evaluator",
    reads: ["question", "answer"],
    writes: ["verdict"],
    evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
  });
  return JSON.stringify({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "ask-bench-gated", project: "demo", version: 1 },
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: {
      question: { type: "string", reduce: "replace" },
      answer: { type: "string", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["question"],
    outputs: ["verdict"],
    nodes,
    edges,
  });
}

const MODELS_FILE = JSON.stringify({
  adapters: [
    {
      provider: "openai",
      name: "stub",
      // Never dialled: `main(argv, STUB.fetch)` replaces the transport. A `baseUrl` is what
      // makes a keyless adapter legal, which is what keeps this suite free of a credential.
      baseUrl: "http://stub.invalid/v1",
      prices: { m1: { input: 1, output: 1 } },
    },
  ],
  routes: { "agent_profile/x@stable": { adapter: "stub", model: "m1" } },
});

/**
 * The provider, stubbed — the only thing here that knows which prompt is better. Token counts
 * are FIXED so both graphs bill identically and `3-cost` compares 1.00×; letting the prompts
 * bill differently would make the cost check about prompt length, which is a different question.
 */
function stub(): { fetch: (url: string, init: RequestInit) => Promise<Response>; calls: number } {
  const state = { calls: 0 };
  const fn = async (_url: string, init: RequestInit): Promise<Response> => {
    state.calls++;
    // PARSED, never grepped: the engine puts the instruction in the SYSTEM slot and the channel
    // state in the user message as JSON, so the user content is JSON inside JSON and a regex
    // over the raw body matches nothing.
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const user = body.messages.find((m) => m.role === "user")?.content ?? "{}";
    const question = String((JSON.parse(user) as { state?: { question?: unknown } }).state?.question ?? "");
    const content = system.includes("PRECISE-MODE") ? `ANSWER:${question}` : "I could not say.";
    const frames = [
      `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 20 } })}`,
      "data: [DONE]",
    ];
    const text = frames.map((f) => `${f}\n\n`).join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn, get calls() { return state.calls; } } as ReturnType<typeof stub>;
}

const STUB = stub();

interface Result {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function cli(argv: string[]): Promise<Result> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv, STUB.fetch);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function seed(dir: string): void {
  mkdirSync(join(dir, "graphs"), { recursive: true });
  mkdirSync(join(dir, "candidates"), { recursive: true });
  mkdirSync(join(dir, "resources", "function"), { recursive: true });
  mkdirSync(join(dir, "resources", "prompt"), { recursive: true });
  mkdirSync(join(dir, "resources", "agent_profile"), { recursive: true });
  mkdirSync(join(dir, "resources", "oversight"), { recursive: true });
  writeFileSync(join(dir, "resources", "function", "check.js"), CHECK);
  writeFileSync(join(dir, "resources", "prompt", "base.md"), BASE_PROMPT);
  writeFileSync(join(dir, "resources", "prompt", "better.md"), BETTER_PROMPT);
  writeFileSync(join(dir, "resources", "agent_profile", "x.md"), "a helper profile\n");
  writeFileSync(join(dir, "resources", "oversight", "publish.md"), "a person approves the answer before it is scored\n");
  writeFileSync(join(dir, "models.json"), MODELS_FILE);
  // PUBLISHED vs NOT. `graphs/` is the set a human approved, and `--against-cohort` derives the
  // baseline from it — so the gated graph is the incumbent and both candidates sit outside.
  writeFileSync(join(dir, "graphs", "gated.json"), graphJson("prompt/base@stable", true));
  // The candidate that DELETES the gate: better prompt, no human in the loop.
  writeFileSync(join(dir, "candidates", "ungated-v2.json"), graphJson("prompt/better@stable", false));
  // The candidate that KEEPS it: same better prompt, gate untouched.
  writeFileSync(join(dir, "candidates", "gated-v2.json"), graphJson("prompt/better@stable", true));
}

/**
 * THIRTY RECORDINGS OF THE INCUMBENT, EACH ONE ANSWERED BY A PERSON, built once and copied.
 *
 * Thirty because `MIN_COHORT_SIZE` is thirty. Each run stops at `awaiting_gate` and is completed
 * by `loom approve` — which is what puts a `gate.decided` on node "approve" in every baseline
 * journal, and that is the fact test 1 turns on. A recording where nobody answered would leave
 * `decidedNodes` empty and the comparison would have nothing to notice.
 */
let TEMPLATE: { dir: string; runIds: RunId[] } | undefined;

async function corpus(): Promise<{ dir: string; runIds: RunId[] }> {
  if (TEMPLATE !== undefined) return TEMPLATE;
  const dir = mkdtempSync(join(tmpdir(), "loom-gated-template-"));
  seed(dir);
  const runIds: RunId[] = [];
  for (let i = 1; i <= 30; i++) {
    const r = await cli([
      "run",
      join(dir, "graphs", "gated.json"),
      "--workspace",
      dir,
      "--models-file",
      join(dir, "models.json"),
      "--input",
      JSON.stringify({ question: `q${String(i).padStart(2, "0")}` }),
    ]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    // The run PARKS. Asserted rather than assumed: if the fixture ever stopped gating, every
    // test below would still pass and would be measuring the ungated case again.
    const runId = /"runId": "(\w+)"/.exec(r.out)?.[1];
    assert.ok(runId, r.out);
    assert.match(r.out, /"status": "awaiting_gate"/, r.out);
    const gateId = /gate (\S+) on node approve/.exec(r.out)?.[1];
    assert.ok(gateId, r.out);

    const a = await cli(["approve", runId, gateId, "--workspace", dir, "--as", "u:release-manager"]);
    assert.equal(a.code, 0, `${a.out}\n${a.err}`);
    assert.match(a.out, /"status": "succeeded"/, a.out);
    runIds.push(runId as RunId);
  }
  TEMPLATE = { dir, runIds };
  return TEMPLATE;
}

/** A private copy of the corpus. Every test that runs a promotion mutates a journal. */
async function workspace(): Promise<{ dir: string; runIds: RunId[]; dispose: () => void }> {
  const t = await corpus();
  const dir = mkdtempSync(join(tmpdir(), "loom-gated-"));
  cpSync(t.dir, dir, { recursive: true });
  return { dir, runIds: t.runIds, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Decision {
  readonly mode?: string;
  readonly promote: boolean;
  readonly paired?: { n: number; lower95: number };
  readonly checks: { id: string; ran: boolean; pass: boolean; detail: string }[];
}

function decisionOf(out: string): Decision {
  return JSON.parse(out.slice(out.indexOf("{"))) as Decision;
}

function check(d: Decision, id: string): { id: string; ran: boolean; pass: boolean; detail: string } {
  const c = d.checks.find((x) => x.id === id);
  assert.ok(c, `no check ${id} in ${JSON.stringify(d.checks.map((x) => x.id))}`);
  return c;
}

const liveArgs = (dir: string, runId: RunId, candidate: string): string[] => [
  "promote",
  join(dir, "candidates", candidate),
  "--against-cohort",
  runId,
  "--workspace",
  dir,
  "--models-file",
  join(dir, "models.json"),
  // Six is `MIN_PAIRED_RUNS`, the floor the flag itself enforces. Every one of them is a live
  // candidate run, so the number is also this suite's provider-call budget.
  "--runs",
  "6",
];

// ── 1 · a candidate that DELETES the gate, and beats the incumbent ───────────

test("a candidate that removed the human gate is measurably better and is refused for removing it", async () => {
  const w = await workspace();
  try {
    const r = await cli(liveArgs(w.dir, w.runIds[0]!, "ungated-v2.json"));
    const d = decisionOf(r.out);

    assert.equal(d.mode, "live-cohort", r.out);
    // THE CANDIDATE GENUINELY WON. Without this the refusal below proves nothing — a gate that
    // refuses a candidate the arithmetic already rejected is untested.
    const l1 = check(d, "L1-paired-improvement");
    assert.ok(l1.ran && l1.pass, `L1 should pass — the better prompt wins every pair: ${l1.detail}`);
    assert.equal(d.paired?.n, 6, r.out);
    assert.ok((d.paired?.lower95 ?? 0) > 0, l1.detail);

    // THE COMPILER DID NOT SEE IT. `rule014And019Oversight` walks the CANDIDATE's nodes, and the
    // gate node is not among them, so the posture diff has nothing to compare and reports clean.
    // This is the line that makes L4 non-redundant.
    const posture = check(d, "6-oversight-diff");
    assert.ok(posture.ran && posture.pass, `the compiler's posture diff is blind to a DELETED node: ${posture.detail}`);

    // AND THE JOURNAL COMPARISON DID. One regression per pair, each naming the node.
    const l4 = check(d, "L4-gated-at-least-as-much");
    assert.ok(l4.ran, l4.detail);
    assert.equal(l4.pass, false, `L4 must refuse a candidate that dropped the gate: ${l4.detail}`);
    assert.match(l4.detail, /6 oversight regression\(s\)/, l4.detail);
    assert.match(l4.detail, /the recording gated node "approve" and this candidate did not/, l4.detail);
    // The regression is attributed to the INPUT it was seen on, not to the candidate in general.
    assert.match(l4.detail, new RegExp(`on the input from ${w.runIds[0]!}:`), l4.detail);

    // L4 IS THE ONLY THING STANDING IN THE WAY. Stated as a set rather than as a count, so a
    // future check that starts failing here is named rather than absorbed.
    assert.deepEqual(
      d.checks.filter((c) => c.ran && !c.pass).map((c) => c.id),
      ["L4-gated-at-least-as-much"],
      r.out,
    );
    assert.equal(d.promote, false, r.out);
    assert.equal(r.code, 1, r.err);
  } finally {
    w.dispose();
  }
});
