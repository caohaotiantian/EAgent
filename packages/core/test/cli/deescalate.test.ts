/**
 * THE HUMAN HALF OF "OVERSIGHT ONLY TIGHTENS" HAS A DOOR NOW.
 *
 * CLAUDE.md's non-negotiable reads "Oversight only tightens. A human may lower a posture; no
 * automated path may." The second clause has been enforced in `PolicyEngine.deescalate` since
 * it was written — a non-`human` actor, three deny-lists and a blank justification are each
 * refused. The first clause had no caller: `/usr/bin/grep -ac deescalate` returned **0** for
 * `src/cli.ts`, **0** for `src/server/http.ts` and **0** for `src/server/console.ts`, and the
 * method's only non-test caller was `run/replay.ts`, replaying a de-escalation some embedder
 * had made. A control that exists only in the test suite is not safe-by-default; it is a
 * sentence in a document with no code under it.
 *
 * So this suite drives the verb through `main`, the door an operator actually has, and it
 * spends most of its length on the refusals — because the one verb in this binary that LOWERS
 * something is the one whose parser has to fail closed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import type { JournalEvent } from "../../src/journal/events.ts";
import type { RunId } from "../../src/ids.ts";

/** One tool node and a gate, so the run parks and stays reachable while the verb is driven. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "gated-copy", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["body"],
  nodes: [
    { id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } },
    { id: "approve", type: "human_gate", reads: ["body"], writes: ["body"], humanGate: { ref: "oversight/publish@stable" } },
  ],
  edges: [{ id: "e1", from: "read", to: "approve", kind: "seq" }],
};

interface Cap {
  code: number;
  out: string;
  err: string;
}

async function run(argv: string[]): Promise<Cap> {
  const out: string[] = [];
  const errOut: string[] = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join(""), err: errOut.join("") };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function workspace(): { dir: string; graphFile: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-deesc-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "gated.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "the body");
  return { dir, graphFile, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function firstJson(out: string): Record<string, unknown> {
  const end = out.indexOf("\n}");
  assert.ok(end > 0, `no JSON object in CLI output: ${out}`);
  return JSON.parse(out.slice(0, end + 2)) as Record<string, unknown>;
}

async function start(w: { dir: string; graphFile: string }): Promise<RunId> {
  const started = await run(["run", w.graphFile, "--workspace", w.dir, "--input", JSON.stringify({ source: "input.txt" })]);
  assert.equal(started.code, 0, started.err);
  return String(firstJson(started.out)["runId"]) as RunId;
}

test("loom deescalate lowers a posture, and the journal names the person, the reason and the door", async () => {
  const w = workspace();
  try {
    const runId = await start(w);

    const lowered = await run([
      "deescalate",
      runId,
      "--workspace",
      w.dir,
      "--scope",
      `run:${runId}`,
      "--to",
      "on",
      "--why",
      "incident 4471: this graph has run twenty times unchanged",
      "--as",
      "u:ops",
    ]);
    assert.equal(lowered.code, 0, lowered.err);
    assert.equal(firstJson(lowered.out)["ceiling"], "on", "the ceiling the fold produced, read back off the projection");

    // THE JOURNAL IS THE ONLY AUTHORITATIVE STATE, so the assertion is on the journal and not
    // on the projection this process happened to hold. Every command above opened its own
    // workspace and closed it, so this read holds nothing but the log.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId, 1)) log.push(ev);
      const deesc = log.filter((ev) => ev.type === "policy.deescalated");
      assert.equal(deesc.length, 1, "exactly one de-escalation, appended once");
      const e = deesc[0]!;
      assert.deepEqual(e.payload, {
        from: "in",
        to: "on",
        scope: `run:${runId}`,
        justification: "incident 4471: this graph has run twenty times unchanged",
      });
      assert.equal(e.actor.kind, "human");
      assert.equal((e.actor as { subject?: string }).subject, "u:ops");
      // `via: "cli"`, NOT `"api"`. `Engine.deescalate` hardcoded `"api"`, which was true while
      // the only caller was an embedder and became a false durable fact the moment this verb
      // existed: an auditor reading the journal would say a de-escalation arrived over the
      // network when it was typed at the host's shell.
      assert.equal((e.actor as { via?: string }).via, "cli", "the door the human came through is a durable fact");
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("every way of asking for a loosening without saying why is refused", async () => {
  const w = workspace();
  try {
    const runId = await start(w);
    const base = ["deescalate", runId, "--workspace", w.dir, "--scope", `run:${runId}`, "--to", "on"];

    // NO `--why` AT ALL.
    await assert.rejects(
      () => run([...base, "--as", "u:ops"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--why needs a justification/.test(e.message),
    );
    // `--why` WITH NO VALUE. `parseArgs` makes a trailing flag `true`, and `String(true)` would
    // journal the four letters "true" as an operator's account of why supervision was reduced.
    await assert.rejects(
      () => run([...base, "--as", "u:ops", "--why"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /no value at all/.test(e.message),
    );
    // BLANK.
    await assert.rejects(
      () => run([...base, "--as", "u:ops", "--why", "   "]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /blank/.test(e.message),
    );

    // AND THERE IS NO FORCE FLAG. `--force` is not in `KNOWN_FLAGS`, so the binary refuses it
    // as an unknown flag rather than ignoring it — which is the difference between "there is
    // no way to skip the justification" and "there is a way and it is undocumented".
    await assert.rejects(
      () => run([...base, "--as", "u:ops", "--force"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /unknown flag: --force/.test(e.message),
    );

    // NOTHING WAS APPENDED BY ANY OF THEM.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", w.dir]));
    try {
      const log: JournalEvent[] = [];
      for await (const ev of ws.store.read(runId, 1)) log.push(ev);
      assert.equal(log.filter((ev) => ev.type === "policy.deescalated").length, 0, "a refused loosening appends nothing");
    } finally {
      ws.close();
    }
  } finally {
    w.dispose();
  }
});

test("a posture outside the union and a scope naming another run are both refused", async () => {
  const w = workspace();
  try {
    const runId = await start(w);
    const base = ["deescalate", runId, "--workspace", w.dir, "--why", "because"];

    // AN UNRANKED POSTURE IS NOT A STRICTER POSTURE. `POSTURE_RANK[x]` is `undefined` for a
    // value outside the union and every `<` against `undefined` is false, so a cast here would
    // put a string into `p.ceilings` that `PolicyEngine.floorFor` cannot order.
    await assert.rejects(
      () => run([...base, "--scope", `run:${runId}`, "--to", "off"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--to must be one of out, on, in/.test(e.message),
    );
    await assert.rejects(
      () => run([...base, "--scope", `run:${runId}`]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /not omitted/.test(e.message),
    );

    // A SCOPE NAMING ANOTHER RUN. `PolicyEngine` keys ceilings by an opaque string and
    // `Engine.deescalate` appends to the log of the run in the first argument, so this would
    // lower the other run's posture in THIS process and be re-seeded, forever, from a journal
    // that other run never reads. A loosening the journal cannot reconstruct.
    await assert.rejects(
      () => run([...base, "--to", "on", "--scope", "run:01OTHERRUNIDOTHERRUNIDOTHER"]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /names run 01OTHERRUNIDOTHERRUNIDOTHER/.test(e.message),
    );
    // AND ONE THIS FILE CANNOT PARSE. Nothing consults an unrecognised scope, so passing it
    // through would exit 0 and change nothing — a de-escalation an operator believes happened.
    await assert.rejects(
      () => run([...base, "--to", "on", "--scope", `tenant:${runId}`]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /Those are the two scopes/.test(e.message),
    );
    await assert.rejects(
      () => run([...base, "--to", "on", "--scope", `node:${runId}`]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /Those are the two scopes/.test(e.message),
    );

    // A NODE SCOPE ON THIS RUN IS THE OTHER LEGAL SHAPE, and it is accepted.
    const ok = await run([...base, "--to", "on", "--scope", `node:${runId}/approve`, "--as", "u:ops"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(firstJson(ok.out)["ceiling"], "on");
  } finally {
    w.dispose();
  }
});

test("a synthetic subject cannot lower a posture from the CLI either", async () => {
  const w = workspace();
  try {
    const runId = await start(w);
    // `subjectFlag` already refuses a parenthesised subject on every verb that writes one to
    // the journal. It is asserted HERE because this is the verb where the consequence is a
    // LOOSENING journaled under a marker that names nobody — the control plane mints
    // `(unidentified)` to record what the perimeter concluded, and a ceiling recorded under it
    // would be a de-escalation with no person behind it.
    await assert.rejects(
      () =>
        run([
          "deescalate",
          runId,
          "--workspace",
          w.dir,
          "--scope",
          `run:${runId}`,
          "--to",
          "on",
          "--why",
          "because",
          "--as",
          "(unidentified)",
        ]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /synthetic marker/.test(e.message),
    );
  } finally {
    w.dispose();
  }
});
