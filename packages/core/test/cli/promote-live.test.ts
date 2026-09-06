/**
 * A PROMPT CHANGE WAS INVISIBLE TO THE ONLY PROMOTION GATE THE PRODUCT HAD.
 *
 * `loom promote --baseline … --suite …` replays recorded runs against the candidate, and replay
 * serves every model turn from the recording under `effectKey(taskId, "model", turn)` — a key
 * built from `nodeId@branchPath#iteration`, carrying no prompt and no request. A candidate that
 * changes a FUNCTION BODY is measurable that way; a candidate that changes a PROMPT replays
 * byte-identically. D6 defines self-improvement as text-space optimisation, so the gate was
 * blind to exactly the change it exists to judge. `gate.ts`'s `unexercised` closed the half that
 * can be closed offline — such a candidate is now REFUSED rather than certified — and refusing
 * is not judging.
 *
 * This suite drives the other half: `loom promote --against-cohort <runId>`, which takes the
 * INPUTS out of the recordings, RUNS the candidate on them, and compares the paired score
 * differences. Test 1 is the whole point of the lane and shows both modes on the same candidate:
 * the replayed one refuses because it cannot ask, the live one measures and promotes.
 *
 * ── Offline, and structurally so ────────────────────────────────────────────────
 *
 * The live mode calls a provider. This suite calls none: `main(argv, fetch)` hands the workspace
 * a stub `fetch`, through the seam `--models-file` adapters already take (`openWorkspace`'s
 * `fetchImpl`, which existed for this and was not threaded to `main`). The models file is real —
 * a real `OpenAIAdapter` against a `baseUrl` that is never dialled — so the refusals about
 * adapters and prices are exercised for real and no socket is opened. `STUB` counts its calls,
 * and the last test asserts the count, so a change that let this reach the network would be red
 * rather than slow.
 *
 * ── What each test holds down ───────────────────────────────────────────────────
 *
 * 1. Both modes on one prompt-only candidate: replayed refuses (measured nothing), live promotes
 *    (measured a real gain), and the two decision rows are not confusable.
 * 2. THE FREEZE PROPERTY: every input the candidate ran on is byte-identical to some recording's
 *    `run.submitted.inputs`, and nothing in argv could have supplied one.
 * 3. The paired arithmetic on the page is the arithmetic in the journal, and `8-determinism` is
 *    reported DID NOT RUN — never as passed — in both.
 * 4. A candidate that is WORSE is refused, and the refusal is journaled: a decision not to
 *    promote is a decision.
 * 5. The refusals: no adapter, an unpriced route, a cohort under `MIN_COHORT_SIZE`, a candidate
 *    identical to the cohort's own graph, `--baseline`/`--suite` alongside `--against-cohort`,
 *    and `--runs` below the floor.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { EvalSuite } from "../../src/evolution/gate.ts";
import { isEvent, type JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

// ── the fixture: one agent node whose prompt decides whether it is right ─────

/**
 * The assertion. It compares the agent's text against ground truth DERIVED FROM THE INPUT, not
 * against what the baseline happened to produce — a check written from the incumbent's output
 * is one the incumbent passes by construction and no candidate could ever beat.
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
 * DELIBERATELY NO LONGER than the incumbent — `5-prompt-size` is a real check and a candidate
 * that wins by spending context has to clear it, which is a different experiment from this one.
 */
const BETTER_PROMPT = "PRECISE-MODE. Answer the question exactly.\n";

function graphJson(promptRef: string, name = "ask-bench"): string {
  return JSON.stringify({
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name, project: "demo", version: 1 },
    // A budget, because GRAPH009 warns without one and a suite that prints a diagnostic on
    // every run of every fixture teaches a reader to stop reading stderr.
    policy: { posture: "out", budget: { costUsd: 1 } },
    channels: {
      question: { type: "string", reduce: "replace" },
      answer: { type: "string", reduce: "replace" },
      verdict: { type: "object", reduce: "replace" },
    },
    inputs: ["question"],
    // `answer` is an OUTPUT so the exam can read it: the exam grades terminal outputs, and a work
    // channel the graph does not declare is one the exam cannot see.
    outputs: ["answer", "verdict"],
    nodes: [
      {
        id: "answer",
        type: "agent",
        reads: ["question"],
        writes: ["answer"],
        agent: { profile: "agent_profile/x@stable", prompt: promptRef, maxTurns: 1 },
      },
      {
        id: "check",
        type: "evaluator",
        reads: ["question", "answer"],
        writes: ["verdict"],
        evaluator: { kind: "assertion", ref: "function/check@stable", threshold: 0.5 },
      },
    ],
    edges: [{ id: "e", from: "answer", to: "check", kind: "seq" }],
  });
}

/**
 * THE EXAM — the same rule as CHECK, but attested by an operator and run by the binary over the
 * recording's `question` and the run's terminal `answer`. `loom score`, `suite freeze` and
 * `promote --against-cohort` refuse a workflow with none, because without it the only S1 is the
 * graph's own evaluator, which a candidate authors.
 */
const EXAM_ASK = `(view) => {
  const q = String(view.get("question") || "");
  const a = String(view.get("answer") || "");
  const ok = a.indexOf("ANSWER:" + q) >= 0;
  return { writes: { verdict: { pass: ok, score: ok ? 1 : 0, confidence: 1, detail: ok ? "answered " + q : "did not answer " + q } } };
}`;

const EXAM_GRAPH = JSON.stringify({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "ask-exam", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: [] },
  channels: {
    subject: { type: "string", reduce: "replace" },
    question: { type: "string", reduce: "replace" },
    answer: { type: "string", reduce: "replace" },
    verdict: { type: "object", reduce: "replace" },
  },
  inputs: ["subject", "question", "answer"],
  outputs: ["verdict"],
  nodes: [{ id: "grade", type: "evaluator", reads: ["question", "answer"], writes: ["verdict"], evaluator: { kind: "assertion", ref: "function/exam-ask@stable", threshold: 0 } }],
  edges: [],
});

const MODELS_FILE = JSON.stringify({
  adapters: [
    {
      provider: "openai",
      name: "stub",
      // Never dialled: `main(argv, STUB.fetch)` replaces the transport. `"apiKeyEnv": null`
      // DECLARES that this endpoint takes no credential, which is what keeps this suite free
      // of one. A `baseUrl` alone no longer implies it — that inference was the reader
      // answering an undecidable question with the passing value.
      baseUrl: "http://stub.invalid/v1",
      apiKeyEnv: null,
      prices: { m1: { input: 1, output: 1 } },
    },
  ],
  routes: { "agent_profile/x@stable": { adapter: "stub", model: "m1" } },
});

/**
 * The provider, stubbed — and it is the only thing in this suite that knows which prompt is
 * better. It answers PRECISELY when the system slot carries `PRECISE-MODE`, and vaguely
 * otherwise, so the candidate's improvement is a real consequence of the text it ships.
 *
 * Token counts are FIXED, so both graphs are billed identically and `3-cost` compares 1.00×.
 * Letting the two prompts bill differently would make the cost check about prompt length, which
 * is `5-prompt-size`'s question and not this one's.
 */
function stub(): { fetch: (url: string, init: RequestInit) => Promise<Response>; calls: number } {
  const state = { calls: 0 };
  const fn = async (_url: string, init: RequestInit): Promise<Response> => {
    state.calls++;
    // PARSED, never grepped. The engine puts the instruction in the SYSTEM slot and the channel
    // state in the user message as JSON — so the user content is JSON *inside* JSON, and a
    // regex over the raw body reads `\"question\":\"q01\"` and matches nothing. That cost one
    // red run in which every answer was `ANSWER:` and both graphs scored identically, which is
    // the failure a stub that lies about the request produces: a comparison with nothing in it.
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
  writeFileSync(join(dir, "resources", "function", "check.js"), CHECK);
  writeFileSync(join(dir, "resources", "function", "exam-ask.js"), EXAM_ASK);
  mkdirSync(join(dir, "exams"), { recursive: true });
  writeFileSync(join(dir, "exams", "ask-exam.json"), EXAM_GRAPH);
  writeFileSync(join(dir, "resources", "prompt", "base.md"), BASE_PROMPT);
  writeFileSync(join(dir, "resources", "prompt", "better.md"), BETTER_PROMPT);
  writeFileSync(join(dir, "resources", "agent_profile", "x.md"), "a helper profile\n");
  writeFileSync(join(dir, "models.json"), MODELS_FILE);
  // PUBLISHED vs NOT, and the difference is load-bearing: `loom score` reads `graphs/` as the
  // set of graphs a human approved, so a candidate parked there would be promoted before it was
  // judged. `--against-cohort` derives the baseline from `graphs/` for the same reason.
  writeFileSync(join(dir, "graphs", "ask.json"), graphJson("prompt/base@stable"));
  writeFileSync(join(dir, "candidates", "ask-v2.json"), graphJson("prompt/better@stable"));
}

/**
 * THIRTY RECORDINGS OF THE INCUMBENT, built once and copied per test.
 *
 * Thirty because `MIN_COHORT_SIZE` is thirty and the mode refuses below it — a cohort smaller
 * than that is not a population. Built once because thirty real Engine runs per test is minutes
 * of nothing being learned; the SQLite journal is closed between commands, so a directory copy
 * is a faithful clone of the workspace.
 */
let TEMPLATE: { dir: string; runIds: RunId[] } | undefined;

async function corpus(): Promise<{ dir: string; runIds: RunId[] }> {
  if (TEMPLATE !== undefined) return TEMPLATE;
  const dir = mkdtempSync(join(tmpdir(), "loom-live-template-"));
  seed(dir);
  const runIds: RunId[] = [];
  for (let i = 1; i <= 30; i++) {
    const r = await cli([
      "run",
      join(dir, "graphs", "ask.json"),
      "--workspace",
      dir,
      "--models-file",
      join(dir, "models.json"),
      "--input",
      JSON.stringify({ question: `q${String(i).padStart(2, "0")}` }),
    ]);
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const parsed = JSON.parse(r.out) as { runId: string; status: string };
    assert.equal(parsed.status, "succeeded", r.out);
    runIds.push(parsed.runId as RunId);
  }
  // THE OPERATOR ATTESTS THE EXAM, then one score grades every recording under it. Both live in
  // the template so every copy starts with a graded corpus and no test pays for thirty exam runs.
  // Anchored on the NEWEST recording: every promotion below journals its decision on the OLDEST
  // selected run, and the tests that read that run's rows expect to find promotions alone.
  const attested = await cli(["exam", "attest", join(dir, "exams", "ask-exam.json"), "--cohort", runIds[runIds.length - 1]!, "--as", "u:operator", "--workspace", dir]);
  assert.equal(attested.code, 0, `${attested.out}\n${attested.err}`);
  const scored = await cli(["score", runIds[0]!, "--workspace", dir]);
  assert.equal(scored.code, 0, `${scored.out}\n${scored.err}`);
  TEMPLATE = { dir, runIds };
  return TEMPLATE;
}

/** A private copy of the corpus. Every test that runs a promotion mutates a journal. */
async function workspace(): Promise<{ dir: string; runIds: RunId[]; dispose: () => void }> {
  const t = await corpus();
  const dir = mkdtempSync(join(tmpdir(), "loom-live-"));
  cpSync(t.dir, dir, { recursive: true });
  return { dir, runIds: t.runIds, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

interface Decision {
  readonly mode?: string;
  readonly promote: boolean;
  readonly cohortKey?: string;
  readonly cohort?: { n: number };
  readonly selected?: number;
  readonly paired?: { n: number; mean: number; sd: number; lower95: number; wins: number; losses: number; ties: number; signTestP: number };
  readonly pairs?: { baselineRunId: string; candidateRunId: string; baselineScore: number; candidateScore: number; diff: number }[];
  readonly checksNotRun?: string[];
  readonly checks: { id: string; ran?: boolean; pass: boolean; detail: string }[];
}

function decisionOf(out: string): Decision {
  return JSON.parse(out.slice(out.indexOf("{"))) as Decision;
}

/** Every `operator.command` row on a run, newest last. */
async function rowsOn(dir: string, runId: RunId): Promise<{ kind: string; args: Record<string, unknown> }[]> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    const rows: { kind: string; args: Record<string, unknown> }[] = [];
    for await (const e of ws.store.read(runId, 1) as AsyncIterable<JournalEvent>) {
      if (isEvent(e, "operator.command")) rows.push({ kind: e.payload.kind, args: e.payload.args as Record<string, unknown> });
    }
    return rows;
  } finally {
    ws.close();
  }
}

/** Every run's `run.submitted.inputs` in the workspace, so the freeze property is checkable. */
async function recordedInputs(dir: string, runIds: readonly RunId[]): Promise<Map<string, string>> {
  const ws = openWorkspace(parseArgs(["gates", "--workspace", dir]));
  try {
    const out = new Map<string, string>();
    for (const id of runIds) {
      for await (const e of ws.store.read(id, 1) as AsyncIterable<JournalEvent>) {
        if (isEvent(e, "run.submitted")) out.set(id, JSON.stringify(e.payload.inputs));
      }
    }
    return out;
  } finally {
    ws.close();
  }
}

const liveArgs = (dir: string, runId: RunId, extra: string[] = []): string[] => [
  "promote",
  join(dir, "candidates", "ask-v2.json"),
  "--against-cohort",
  runId,
  "--workspace",
  dir,
  "--models-file",
  join(dir, "models.json"),
  ...extra,
];

// ── 1 · the defect, both modes, one candidate ────────────────────────────────

test("the replayed gate cannot ask a prompt candidate anything; the live one measures it", async () => {
  const w = await workspace();
  try {
    // (a) THE REPLAYED MODE. Six recordings frozen as a suite, and the candidate differs only in
    // `agent.prompt`. Every model turn would be served from the recording, so the only thing the
    // replay can honestly say is that it did not ask the candidate's question — which is now a
    // refusal rather than a certification.
    const cases = w.runIds.slice(0, 6);
    const suite: EvalSuite = {
      name: "ask-bench",
      version: 1,
      frozen: true,
      frozenAt: 1_000,
      generatedBy: "maintainer",
      cases: cases.map((runId, i) => ({
        id: `c${String(i)}`,
        runId,
        mustPass: i === 0,
        expect: { status: "succeeded" as const, channels: { verdict: { pass: true, confidence: 1, detail: `answered q0${String(i + 1)}` } } },
      })),
      composition: { minCases: 3, minMustPass: 1 },
    };
    const suiteFile = join(w.dir, "suite.json");
    writeFileSync(suiteFile, JSON.stringify(suite));

    const replayed = await cli([
      "promote",
      join(w.dir, "candidates", "ask-v2.json"),
      "--baseline",
      join(w.dir, "graphs", "ask.json"),
      "--suite",
      suiteFile,
      "--workspace",
      w.dir,
      "--models-file",
      join(w.dir, "models.json"),
    ]);
    assert.equal(replayed.code, 1, `${replayed.out}\n${replayed.err}`);
    assert.match(replayed.out, /measured the recording and not the candidate/, "the replayed mode says why it cannot judge this");

    // (b) THE LIVE MODE, same candidate, same workspace. It runs the candidate on inputs taken
    // out of those recordings and finds the improvement the replay could not see.
    const live = await cli(liveArgs(w.dir, w.runIds[0]!, ["--runs", "6"]));
    assert.equal(live.code, 0, `${live.out}\n${live.err}`);
    const d = decisionOf(live.out);
    assert.equal(d.promote, true, JSON.stringify(d.checks.filter((c) => c.ran && !c.pass)));
    assert.equal(d.paired!.n, 6);
    assert.equal(d.paired!.wins, 6, "the better prompt answered every question the vague one did not");
    assert.equal(d.paired!.lower95 > 0, true, `the bound must clear 0: ${JSON.stringify(d.paired)}`);

    // THE TWO ROWS ARE NOT CONFUSABLE. The replayed decision carries a suite and no mode; the
    // live one carries a mode and no suite, and names the check it could not run.
    assert.equal(d.mode, "live-cohort");
    assert.equal("suite" in d, false, "a live verdict must not wear the replayed gate's shape");
    assert.deepEqual(d.checksNotRun, ["8-determinism"]);
  } finally {
    w.dispose();
  }
});

// ── 2 · the freeze property ──────────────────────────────────────────────────

test("EVERY input the candidate ran on came out of a recording, and argv could not supply one", async () => {
  const w = await workspace();
  try {
    const r = await cli(liveArgs(w.dir, w.runIds[0]!, ["--runs", "6"]));
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const d = decisionOf(r.out);

    const recorded = await recordedInputs(w.dir, w.runIds);
    const candidateIds = d.pairs!.map((p) => p.candidateRunId as RunId);
    const ran = await recordedInputs(w.dir, candidateIds);
    for (const p of d.pairs!) {
      const fromRecording = recorded.get(p.baselineRunId);
      assert.ok(fromRecording !== undefined, `${p.baselineRunId} is not one of this workspace's recordings`);
      assert.equal(
        ran.get(p.candidateRunId),
        fromRecording,
        "the candidate must be given the recording's inputs byte for byte, or the exam was rewritten",
      );
    }

    // OLDEST FIRST, and not a choice the caller made. RunIds are ULIDs, so ascending order is
    // chronological: `--runs 6` uses the six recordings least able to have been made for this
    // candidate.
    assert.deepEqual(
      d.pairs!.map((p) => p.baselineRunId),
      [...w.runIds].sort().slice(0, 6),
    );

    // AND THERE IS NO DOOR FOR ONE. `--input` is `loom run`'s flag; it is not read by this verb,
    // and the inputs above prove it was not consulted — but a reader should be able to see what
    // happens to somebody who tries rather than take it on faith.
    //
    // THIS ASSERTION USED TO BE THAT THE FLAG WAS IGNORED, and the flag is now REFUSED: `--input`
    // is not in `loom promote`'s row of `VERB_FLAGS`, so the door closes before the exam is
    // assembled rather than after. Ignoring it was already the freeze property holding — the
    // recordings above are the proof of that — but an operator who typed it learnt nothing,
    // which is exactly the class §H.4 was opened for. The strictly stronger statement is that
    // the attempt does not run at all.
    let refused: unknown;
    try {
      await cli(liveArgs(w.dir, w.runIds[0]!, ["--runs", "6", "--input", JSON.stringify({ question: "a question I chose" })]));
    } catch (e) {
      refused = e;
    }
    assert.ok(isLoomError(refused) && refused.code === CODES.E_CONFIG_INVALID, `an input named at promotion time must be refused: ${String(refused)}`);
    assert.match(refused.message, /--input is read by `loom run` and by no other verb/);
  } finally {
    w.dispose();
  }
});

// ── 3 · the arithmetic on the page is the arithmetic in the journal ──────────

test("the decision is journaled with its pairs, its bound, and the check that did not run", async () => {
  const w = await workspace();
  try {
    const r = await cli(liveArgs(w.dir, w.runIds[0]!, ["--runs", "8", "--as", "u:maintainer"]));
    assert.equal(r.code, 0, `${r.out}\n${r.err}`);
    const printed = decisionOf(r.out);

    // ANCHORED ON A RECORDING, and on the first SELECTED one — never on a candidate run, which
    // was produced by a graph no human has approved.
    const anchor = printed.pairs![0]!.baselineRunId as RunId;
    const rows = await rowsOn(w.dir, anchor);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "evolution.promote");
    const journaled = rows[0]!.args;
    assert.equal(journaled["mode"], "live-cohort");
    assert.equal(journaled["promote"], true);
    assert.deepEqual(journaled["checksNotRun"], ["8-determinism"]);
    assert.deepEqual(journaled["paired"], printed.paired, "the page and the row must not be two different judgements");
    assert.equal((journaled["pairs"] as unknown[]).length, 8);
    assert.equal((journaled["cohort"] as { n: number }).n, 30);

    // `8-determinism` IS ON THE PAGE, AS NOT RUN. Never `✓`, and never absent — an omitted check
    // is one a reader assumes was performed.
    assert.match(r.out, /⊘ 8-determinism/);
    assert.doesNotMatch(r.out, /✓ 8-determinism/);
    assert.match(r.err, /decided WITHOUT 8-determinism/);

    // The conservative fold — what a consumer writes without reading `live.ts` — must read this
    // promoting verdict as not fully passing.
    assert.equal(printed.checks.every((c) => c.pass), false);
    assert.equal(printed.checks.find((c) => c.id === "8-determinism")!.ran, false);
  } finally {
    w.dispose();
  }
});

// ── 4 · the losing direction ─────────────────────────────────────────────────

test("a candidate that is WORSE is refused, and the refusal is journaled too", async () => {
  const w = await workspace();
  try {
    // Roles swapped by publishing the GOOD prompt and offering the vague one as the candidate.
    // The cohort is rebuilt from scratch so its recordings are the good graph's.
    const dir = w.dir;
    writeFileSync(join(dir, "graphs", "ask.json"), graphJson("prompt/better@stable"));
    writeFileSync(join(dir, "candidates", "ask-v2.json"), graphJson("prompt/base@stable"));
    const ids: RunId[] = [];
    for (let i = 1; i <= 30; i++) {
      const run = await cli([
        "run",
        join(dir, "graphs", "ask.json"),
        "--workspace",
        dir,
        "--models-file",
        join(dir, "models.json"),
        "--input",
        JSON.stringify({ question: `w${String(i).padStart(2, "0")}` }),
      ]);
      assert.equal(run.code, 0, `${run.out}\n${run.err}`);
      ids.push((JSON.parse(run.out) as { runId: string }).runId as RunId);
    }

    const attested = await cli(["exam", "attest", join(dir, "exams", "ask-exam.json"), "--cohort", ids[ids.length - 1]!, "--as", "u:operator", "--workspace", dir]);
    assert.equal(attested.code, 0, `${attested.out}\n${attested.err}`);
    const r = await cli(liveArgs(dir, ids[0]!, ["--runs", "6"]));
    assert.equal(r.code, 1, `${r.out}\n${r.err}`);
    const d = decisionOf(r.out);
    assert.equal(d.promote, false);
    assert.equal(d.paired!.losses, 6, "the vague prompt answered nothing the precise one did");
    assert.equal(d.checks.find((c) => c.id === "L1-paired-improvement")!.pass, false);

    const rows = await rowsOn(dir, d.pairs![0]!.baselineRunId as RunId);
    assert.equal(rows[0]!.args["promote"], false, "a decision not to promote is a decision");
  } finally {
    w.dispose();
  }
});

// ── 5 · the refusals ─────────────────────────────────────────────────────────

test("a live judgement with no adapter, or an unpriced one, is refused rather than mocked", async () => {
  const w = await workspace();
  try {
    // (a) NO ADAPTER. The mock answers every agent node with canned text and fabricates a cost,
    // so a promotion decided on it measures the mock.
    await assert.rejects(
      () =>
        cli([
          "promote",
          join(w.dir, "candidates", "ask-v2.json"),
          "--against-cohort",
          w.runIds[0]!,
          "--workspace",
          w.dir,
        ]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /only\s+registered adapter is the offline mock/.test(e.message),
    );

    // (b) AN UNPRICED ROUTE journals every call as costing $0, so `3-cost` would report a 0.00×
    // ratio against recordings that cost real money — a check certifying what it never measured.
    const unpriced = join(w.dir, "models-unpriced.json");
    writeFileSync(
      unpriced,
      JSON.stringify({
        adapters: [{ provider: "openai", name: "stub", baseUrl: "http://stub.invalid/v1", apiKeyEnv: null }],
        routes: { "agent_profile/x@stable": { adapter: "stub", model: "m1" } },
      }),
    );
    await assert.rejects(
      () =>
        cli([
          "promote",
          join(w.dir, "candidates", "ask-v2.json"),
          "--against-cohort",
          w.runIds[0]!,
          "--workspace",
          w.dir,
          "--models-file",
          unpriced,
        ]),
      (e: unknown) => isLoomError(e) && /have no price/.test(e.message),
    );

    // Neither refusal ran the candidate, and neither wrote a decision.
    assert.deepEqual(await rowsOn(w.dir, w.runIds[0]!), []);
  } finally {
    w.dispose();
  }
});

test("a cohort too small to be a population, and a candidate that is the baseline, are refused", async () => {
  const small = mkdtempSync(join(tmpdir(), "loom-live-small-"));
  try {
    seed(small);
    const ids: RunId[] = [];
    for (let i = 1; i <= 4; i++) {
      const r = await cli([
        "run",
        join(small, "graphs", "ask.json"),
        "--workspace",
        small,
        "--models-file",
        join(small, "models.json"),
        "--input",
        JSON.stringify({ question: `s${String(i)}` }),
      ]);
      ids.push((JSON.parse(r.out) as { runId: string }).runId as RunId);
    }
    // Attested, so the refusal below is about the POPULATION and not about the missing exam —
    // that refusal comes first, and has its own test in exam-lane-acceptance.test.ts.
    const attested = await cli(["exam", "attest", join(small, "exams", "ask-exam.json"), "--cohort", ids[ids.length - 1]!, "--as", "u:operator", "--workspace", small]);
    assert.equal(attested.code, 0, `${attested.out}\n${attested.err}`);
    await assert.rejects(
      () => cli(liveArgs(small, ids[0]!)),
      (e: unknown) => isLoomError(e) && /n = 4 comparable runs/.test(e.message) && /at least 30/.test(e.message),
      "the refusal has to say n, or an operator cannot tell how far off they are",
    );

    // The candidate IS the cohort's graph: running it against its own recordings' inputs would
    // measure model nondeterminism and report it as an improvement.
    const w = await workspace();
    try {
      await assert.rejects(
        () =>
          cli([
            "promote",
            join(w.dir, "graphs", "ask.json"),
            "--against-cohort",
            w.runIds[0]!,
            "--workspace",
            w.dir,
            "--models-file",
            join(w.dir, "models.json"),
          ]),
        (e: unknown) => isLoomError(e) && /the same graph/.test(e.message),
      );
    } finally {
      w.dispose();
    }
  } finally {
    rmSync(small, { recursive: true, force: true });
  }
});

test("the two modes' flags do not mix, and --runs below the floor is refused at the door", async () => {
  const w = await workspace();
  try {
    for (const [flag, value, why] of [
      ["baseline", join(w.dir, "graphs", "ask.json"), /derived from the cohort key/],
      ["suite", join(w.dir, "suite.json"), /replays no recordings/],
    ] as const) {
      await assert.rejects(
        () => cli(liveArgs(w.dir, w.runIds[0]!, [`--${flag}`, value])),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && why.test(e.message),
        `--${flag} must be refused alongside --against-cohort`,
      );
    }

    // Two pairs cannot reach a 95% bound on anything, and the refusal happens BEFORE a provider
    // is called — an operator who typed 2 should not pay for the lesson.
    await assert.rejects(
      () => cli(liveArgs(w.dir, w.runIds[0]!, ["--runs", "2"])),
      (e: unknown) => isLoomError(e) && /at least 6/.test(e.message),
    );

    // And `--runs` on the REPLAYED mode caps nothing, so it is refused there rather than ignored.
    await assert.rejects(
      () =>
        cli([
          "promote",
          join(w.dir, "candidates", "ask-v2.json"),
          "--baseline",
          join(w.dir, "graphs", "ask.json"),
          "--suite",
          join(w.dir, "suite.json"),
          "--runs",
          "6",
          "--workspace",
          w.dir,
        ]),
      (e: unknown) => isLoomError(e) && /makes no runs at all/.test(e.message),
    );

    assert.deepEqual(await rowsOn(w.dir, w.runIds[0]!), [], "a refused command judged nothing");
  } finally {
    w.dispose();
  }
});

// ── the offline claim, asserted rather than assumed ──────────────────────────

test("NO SOCKET WAS OPENED: every provider call in this suite went to the stub", async () => {
  // The live mode calls a provider, and a test suite that reached one would be non-deterministic,
  // slow, and billed. `main(argv, fetch)` is the seam that keeps it here; this asserts the seam
  // carried every call rather than trusting that it did. Run last: `node --test` executes the
  // tests in this file in order, so by now every recording and every candidate run has happened.
  assert.ok(STUB.calls > 30, `the stub answered ${String(STUB.calls)} calls — it should have answered every one`);
});

test.after(() => {
  if (TEMPLATE !== undefined) rmSync(TEMPLATE.dir, { recursive: true, force: true });
});
