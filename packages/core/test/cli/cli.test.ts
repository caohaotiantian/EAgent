/**
 * The CLI, and DoD item 6.
 *
 * The point of these tests is one claim: **Loom boots from nothing.** An empty
 * directory, no configuration, no external service, no API key — and a real graph
 * runs end to end. Everything else here supports proving that.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { controlPlaneOptions, main, openWorkspace, parseArgs, readChannels, readIdentities, serveUntilInterrupt } from "../../src/cli.ts";
import { CODES, isLoomError } from "../../src/errors.ts";
import { ControlPlane } from "../../src/server/http.ts";

/** A graph that uses only built-in tools, so nothing needs registering. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    {
      id: "read",
      type: "tool",
      reads: ["source"],
      writes: ["body"],
      tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } },
    },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

function emptyDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-cli-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

function seed(dir: string): string {
  mkdirSync(join(dir, "graphs"), { recursive: true });
  const graphFile = join(dir, "graphs", "copy.json");
  writeFileSync(graphFile, JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello from an empty directory");
  return graphFile;
}

/** Capture stdout/stderr around a CLI invocation. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
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

// ── argument parsing ─────────────────────────────────────────────────────────

test("flags, values, and positionals parse as expected", () => {
  const a = parseArgs(["run", "g.json", "--input", '{"a":1}', "--verbose"]);
  assert.equal(a.command, "run");
  assert.deepEqual(a.positional, ["g.json"]);
  assert.equal(a.flags["input"], '{"a":1}');
  assert.equal(a.flags["verbose"], true);
});

// ── DoD item 6 ───────────────────────────────────────────────────────────────

test("DoD 6 — an EMPTY directory becomes a working workspace with no external service", () => {
  const d = emptyDir();
  try {
    assert.equal(existsSync(join(d.dir, ".loom")), false, "starting from genuinely nothing");
    const ws = openWorkspace(parseArgs(["serve", "--workspace", d.dir]));
    try {
      assert.equal(existsSync(join(d.dir, ".loom", "journal.db")), true, "the journal exists after boot");
      assert.equal(existsSync(join(d.dir, "graphs")), true);
      // Built-in tools are registered, so a fresh install can run a real graph.
      //
      // What is ABSENT matters as much as what is present: `net.fetch` and `proc.exec` are
      // both opt-in and neither `--egress` nor `--allow-exec` was passed, so an empty
      // directory becomes a workspace that can read, search and edit its own files and
      // reach nothing else. That is the intended shape of "no external service".
      assert.deepEqual(
        ws.engine.tools.list().map((t) => t.name).sort(),
        ["fs.edit", "fs.glob", "fs.grep", "fs.read", "fs.restore", "fs.write"],
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("DoD 6 — a real graph runs end to end from a fresh directory, offline", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const r = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);

    assert.equal(r.code, 0, r.err);
    const parsed = JSON.parse(r.out) as { status: string; outputs: Record<string, unknown> };
    assert.equal(parsed.status, "succeeded");
    assert.equal(
      readFileSync(join(d.dir, "out", "copy.txt"), "utf8"),
      "hello from an empty directory",
      "the tool really wrote the file, inside the jail",
    );
  } finally {
    d.dispose();
  }
});

test("the run is journaled, so a second process can read it back", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    // A completely separate workspace handle — i.e. a new process.
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const p = await ws.engine.projection(runId as never);
      assert.equal(p?.status, "succeeded");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("`loom gates` ON A RUN THAT DOES NOT EXIST IS NOT `no gates` — the two answers were byte-identical", async () => {
  // `Object.values(p?.gates ?? {})` turned "there is no such run" into "this run has
  // nothing waiting on you", on the one command an operator runs to ask whether anything
  // is waiting on them. Measured, same workspace, same journal:
  //
  //     loom gates 01KZ9B2D99QZMRAQXTSJTPB84B   (a real, finished run) → []   exit 0
  //     loom gates r_definitely_not_a_run       (no such run)          → []   exit 0
  //
  // A typed run id, a stale id from a chat message, an id from the wrong workspace: each
  // reads as "you are clear". `?? {}` is the exact `absence is not zero` shape the Traps
  // list names, and `GET /runs/:id/gates` already answers the same question with 404 —
  // the CLI was the door that forgot.
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    // A run that EXISTS and has no open gates: `[]`, exit 0. That is the answer this
    // command is for, and it must keep working.
    const real = await run(["gates", runId, "--workspace", d.dir]);
    assert.equal(real.code, 0);
    assert.deepEqual(JSON.parse(real.out), []);

    // A run that does not exist is a different fact and gets a different answer.
    for (const missing of [`${runId}X`, "r_definitely_not_a_run", "01KZ0000000000000000000000"]) {
      await assert.rejects(
        () => run(["gates", missing, "--workspace", d.dir]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_RUN_NOT_FOUND && new RegExp(missing).test(e.message),
        `\`loom gates ${missing}\` must say the run is unknown, not that it has no open gates`,
      );
    }
  } finally {
    d.dispose();
  }
});

/**
 * Two gates open at once, of different urgency, and both raised by the graph's own roots.
 *
 * `human_gate` may not be a leaf (`GRAPH014` refuses one, since approving it would do
 * nothing), so each gate leads into the join that gathers them. Journal order puts the
 * PATIENT one first — `slow` is declared first, so it is raised first — which is what makes
 * the two doors distinguishable at all.
 */
const TWO_GATES = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "two-gates", project: "demo", version: 1 },
  policy: { posture: "out", capabilities: ["fs:write"] },
  channels: { plan: { type: "string", reduce: "replace" }, written: { type: "object", reduce: "replace" } },
  inputs: ["plan"],
  outputs: ["written"],
  nodes: [
    { id: "slow", type: "human_gate", reads: ["plan"], humanGate: { ref: "oversight/deploy@stable", sla: { respondWithinMs: 900_000, onTimeout: "fail" } } },
    { id: "urgent", type: "human_gate", reads: ["plan"], humanGate: { ref: "oversight/deploy@stable", sla: { respondWithinMs: 60_000, onTimeout: "fail" } } },
    { id: "collect", type: "join", join: { branches: ["slow", "urgent"], mode: "all", onBranchError: "fail", timeoutMs: 60_000 } },
    {
      id: "apply",
      type: "tool",
      reads: ["plan"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/applied.txt", body: "${plan}" } },
      unhandled: true,
    },
  ],
  edges: [
    { id: "g1", from: "slow", to: "collect", kind: "join", branches: ["slow", "urgent"] },
    { id: "g2", from: "urgent", to: "collect", kind: "join", branches: ["slow", "urgent"] },
    { id: "e1", from: "collect", to: "apply", kind: "seq" },
  ],
};

test("BOTH DOORS ONTO THE GATE QUEUE AGREE — `loom run`'s hint and `loom gates`", async () => {
  // THEY USED TO DISAGREE, and the reason given for it had already stopped being true. The
  // claim was that D7.9 row 5's rank lives in `gateQueueOrder`, reachable only through an
  // engine that had ATTACHED the run — "so a fresh `loom gates` raises `E_RUN_NOT_FOUND` and
  // is left folding the projection". `Engine.openGates` falls back to `#logFor` and says so in
  // its own docstring: "a run this engine holds no context for is not an unknown run: a gate is
  // a ROW". Measured on this fixture in a second process: `openGates` → ["urgent","slow"], the
  // projection → ["slow","urgent"], nothing thrown.
  //
  // This test's previous form asserted the disagreement and carried its own escape hatch — "if
  // this fails because it is now ranked, delete B8 and this assertion together". It did, and
  // they are.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "two-gates.json");
    writeFileSync(graphFile, JSON.stringify(TWO_GATES));

    const r = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ plan: "ship it" })]);
    assert.equal(r.code, 0, r.err);
    // The command prints the run summary and then one hint line per gate; the summary is
    // everything before the first hint.
    const parsed = JSON.parse(r.out.split("\ngate ")[0]!) as { runId: string; status: string };
    assert.equal(parsed.status, "awaiting_gate");

    const hinted = [...r.out.matchAll(/gate \S+ on node (\S+)/g)].map((m) => m[1]);
    assert.deepEqual(hinted, ["urgent", "slow"], "most urgent first — the hint is the ranked queue");

    // The other door, a fresh process over the same journal.
    const listed = await run(["gates", parsed.runId, "--workspace", d.dir]);
    assert.equal(listed.code, 0);
    const nodes = (JSON.parse(listed.out) as { nodeId: string }[]).map((g) => g.nodeId);
    assert.deepEqual([...nodes].sort(), ["slow", "urgent"], "the SET is complete");
    assert.deepEqual(nodes, hinted, "and the ORDER is the same one the hint printed — one queue, one answer");
  } finally {
    d.dispose();
  }
});

// ── compile ──────────────────────────────────────────────────────────────────

test("A GRAPH FILE THAT IS NOT JSON IS NOT A BUG IN LOOM — the same rule `--input` already states", async () => {
  // `readSpec` ends in `JSON.parse(text)` with nothing around it, so an operator's typo in
  // a graph file surfaces as `E_INTERNAL` — this system's word for "a bug in Loom" —
  // naming neither the file nor the mistake. The YAML half of the same expression has
  // always been right. Measured, on the same workspace:
  //
  //     loom compile graphs/broken.yaml → E_GRAPH_INVALID: broken.yaml:3: unexpected indentation inside a sequence
  //     loom compile graphs/broken.json → E_INTERNAL: SyntaxError: Expected double-quoted property name in JSON at position 54
  //     loom compile graphs/nope.json   → E_INTERNAL: Error: ENOENT: no such file or directory, open '…/graphs/nope.json'
  //     loom compile graphs             → E_INTERNAL: Error: EISDIR: illegal operation on a directory, read
  //
  // `runInputs`' docstring in the same file states the rule these break, and cites
  // `server/http.ts`'s `safeDecode` for it: a caller sending nonsense is not an internal
  // error and must not be reported as one. Two formats, one file-reading function, one
  // shape of refusal.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const truncated = join(d.dir, "graphs", "broken.json");
    writeFileSync(truncated, '{ "apiVersion": "loom.dev/v1",\n  "kind": "GraphSpec",\n');
    const notAnObject = join(d.dir, "graphs", "scalar.json");
    writeFileSync(notAnObject, "42");

    for (const [file, pattern] of [
      [truncated, /broken\.json/],
      [notAnObject, /scalar\.json/],
    ] as const) {
      for (const command of ["compile", "run"]) {
        await assert.rejects(
          () => run([command, file, "--workspace", d.dir]),
          (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_INVALID && pattern.test(e.message),
          `\`loom ${command} ${file}\` must name the file and refuse it as a graph, never E_INTERNAL`,
        );
      }
    }

    // The path itself is the operator's other typo, and it is a configuration mistake
    // rather than a malformed graph — a different code, because the fix is different.
    for (const path of [join(d.dir, "graphs", "nope.json"), join(d.dir, "graphs")]) {
      await assert.rejects(
        () => run(["compile", path, "--workspace", d.dir]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && new RegExp(String(path).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(e.message),
        `\`loom compile ${path}\` must name the path, never E_INTERNAL`,
      );
    }

    // And a real graph still compiles, in both formats — the refusal is about malformed
    // input, not about the reader having been broken.
    assert.equal((await run(["compile", seed(d.dir), "--workspace", d.dir])).code, 0);
    const yaml = join(d.dir, "graphs", "broken.yaml");
    writeFileSync(yaml, "nodes:\n  - id: a\n   bad: indent\n");
    await assert.rejects(
      () => run(["compile", yaml, "--workspace", d.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_INVALID,
      "the YAML half was always right and stays right",
    );
  } finally {
    d.dispose();
  }
});

test("compile accepts a valid graph and reports ok", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const r = await run(["compile", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0);
    assert.match(r.out, /ok/);
  } finally {
    d.dispose();
  }
});

test("compile prints every diagnostic with its suggested fix, then fails", async () => {
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const bad = { ...GRAPH, nodes: GRAPH.nodes.map((n) => ({ ...n, writes: ["ghost"] })) };
    const file = join(d.dir, "graphs", "bad.json");
    writeFileSync(file, JSON.stringify(bad));

    await assert.rejects(
      () => run(["compile", file, "--workspace", d.dir]),
      (e: unknown) => isLoomError(e) && e.code === CODES.E_GRAPH_INVALID,
      "the undeclared write must be what refuses, not the file being unreadable",
    );
  } finally {
    d.dispose();
  }
});

// ── replay and trace ─────────────────────────────────────────────────────────

test("replay verifies a recorded run and performs no side effects", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    // Corrupt the output file; a replay that re-ran the tool would recreate it.
    writeFileSync(join(d.dir, "out", "copy.txt"), "TAMPERED");

    const r = await run(["replay", runId, "--graph", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /"match": true/);
    assert.equal(readFileSync(join(d.dir, "out", "copy.txt"), "utf8"), "TAMPERED", "replay wrote nothing");
  } finally {
    d.dispose();
  }
});

test("trace prints spans and asserts graph conformance", async () => {
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    const { runId } = JSON.parse(first.out) as { runId: string };

    const r = await run(["trace", runId, "--graph", graphFile, "--workspace", d.dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /loom\.run/);
    assert.match(r.out, /loom\.task/);
    assert.match(r.out, /conformance: ok/);
  } finally {
    d.dispose();
  }
});

// ── the jail applies to built-in tools ───────────────────────────────────────

test("a built-in tool cannot escape the workspace", async () => {
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const escaping = {
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.id === "read" ? { ...n, tool: { name: "fs.read", version: "1.0", args: { path: "../../../etc/passwd" } } } : n,
      ),
    };
    const file = join(d.dir, "graphs", "escape.json");
    writeFileSync(file, JSON.stringify(escaping));
    writeFileSync(join(d.dir, "input.txt"), "x");

    const r = await run(["run", file, "--workspace", d.dir, "--input", JSON.stringify({ source: "input.txt" })]);
    assert.equal(r.code, 1, "the run fails rather than reading outside the jail");
  } finally {
    d.dispose();
  }
});

test("help is printed for no arguments", async () => {
  const r = await run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /loom serve/);
  assert.match(r.out, /--identity-file/, "the single binary can be told who may approve");
});

// ── who may approve, in the single binary ────────────────────────────────────

test("THE SINGLE BINARY CAN BE GIVEN AN IDENTITY SOURCE, one token per person", () => {
  // Without this, `loom serve` is a deployment in which no gate that names an approver
  // can ever be answered — the fail-closed state, which is correct and unusable.
  const d = emptyDir();
  try {
    const file = join(d.dir, "identities.json");
    writeFileSync(
      file,
      JSON.stringify({ subjects: [{ subject: "u:security-lead", token: "lead-token", via: "console" }, { subject: "svc:ci", token: "ci-token", kind: "service" }] }),
    );
    const source = readIdentities(file);
    // Two subjects, so two principals — and `loom serve` warns on exactly this, because
    // per-subject tokens imply an isolation this plane does not have. `principals` is
    // what `ControlPlane.distinctPrincipals` counts; a source that could not say would be
    // assumed to have many.
    assert.equal(source.principals, 2);
    const lead = source.identify({ method: "POST", path: "/x", headers: { authorization: "Bearer lead-token" } });
    assert.deepEqual(lead, { kind: "human", subject: "u:security-lead", method: "bearer-token", via: "console" });
    assert.equal((source.identify({ method: "POST", path: "/x", headers: { authorization: "Bearer ci-token" } }) as { kind: string }).kind, "service");
    assert.equal(source.identify({ method: "POST", path: "/x", headers: { authorization: "Bearer wrong" } }), undefined);

    // `via` is a closed vocabulary on the journal, and an unknown one is DROPPED rather
    // than coerced or written: the file is operator input, and a typo in it must not
    // become a value no fold over the journal can read. What is left says `api` at the
    // decision site, which is true.
    const typo = join(d.dir, "typo.json");
    writeFileSync(typo, JSON.stringify({ subjects: [{ subject: "u:alice", token: "t", via: "telepathy" }] }));
    assert.deepEqual(readIdentities(typo).identify({ method: "POST", path: "/x", headers: { authorization: "Bearer t" } }), {
      kind: "human",
      subject: "u:alice",
      method: "bearer-token",
    });

    // `operator` GOES THE OTHER WAY, with `kind`, and one step further. It grants read
    // access to every run in the journal, so a value nobody can read is a refusal to start
    // rather than a dropped field — even though dropping would fail closed here. A
    // deployment whose file says `"operator": "true"` must not silently have none.
    const op = join(d.dir, "op.json");
    writeFileSync(op, JSON.stringify({ subjects: [{ subject: "u:root", token: "t", operator: true }] }));
    assert.deepEqual(readIdentities(op).identify({ method: "POST", path: "/x", headers: { authorization: "Bearer t" } }), {
      kind: "human",
      subject: "u:root",
      method: "bearer-token",
      operator: true,
    });
    assert.equal(readIdentities(op).operators, 1, "countable, which is what the boot warning reads");

    const badOp = join(d.dir, "badop.json");
    writeFileSync(badOp, JSON.stringify({ subjects: [{ subject: "u:root", token: "t", operator: "true" }] }));
    assert.throws(() => readIdentities(badOp), /operator "true", which must be true or false/);
  } finally {
    d.dispose();
  }
});

test("`loom serve --token \"\"` REFUSES TO START rather than starting WIDE OPEN", async () => {
  // The one-character deployment slip this exists for: `--token "$LOOM_TOKEN"` with the
  // variable unset. The shell hands the flag an empty string, and an empty shared token
  // used to authenticate every caller — including one presenting no Authorization header
  // at all — while `/health` still reported `auth: "required"` and no boot warning fired.
  //
  // The refusal is `ControlPlane`'s, so the library and the binary cannot disagree about
  // it; what the CLI adds is the FLAG'S name and the deliberate alternative, because
  // "ControlPlaneOptions.token" is not a string any operator typed.
  const d = emptyDir();
  try {
    const slips = [
      // The shell handed the flag an empty string.
      ["serve", "--workspace", d.dir, "--port", "0", "--token", ""],
      // The same slip one keystroke earlier: `parseArgs` yields `true` for a flag with no
      // value, and `String(true)` silently installed "true" as the deployment's secret.
      ["serve", "--workspace", d.dir, "--port", "0", "--token"],
      // And the same slip written the other conventional way. This one did not reach the
      // guard at all until `parseArgs` learned `--name=value`: it registered a flag NAMED
      // `token=` and left `flags["token"]` undefined, which every reader takes as "no
      // token was asked for" — i.e. run open, deliberately.
      ["serve", "--workspace", d.dir, "--port", "0", "--token="],
    ];
    for (const argv of slips) {
      // RACE, don't just await. If the guard regresses, `serve` binds a port and waits for
      // SIGINT for the life of the process, so a plain `assert.rejects` would HANG the
      // suite rather than fail it — a regression that never reports is worse than one that
      // reports late. `--port 0` for the same reason at one remove: a test that squats the
      // default port fails the NEXT test instead of this one.
      const timer = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`\`loom ${argv.join(" ")}\` STARTED. It must refuse.`)), 5_000).unref();
      });
      await assert.rejects(
        Promise.race([run(argv), timer]),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--token/.test(e.message) && /open plane/.test(e.message),
        argv.join(" "),
      );
    }
  } finally {
    d.dispose();
  }
});

test("parseArgs understands `--name=value`, because not understanding it opened the plane", () => {
  // Not an ergonomic gap. `--token=s3cret` used to register a flag literally NAMED
  // `token=s3cret`, leaving `flags["token"]` undefined — and absent means "open plane on
  // purpose". The most common flag convention there is silently disarmed the perimeter.
  assert.equal(parseArgs(["serve", "--token=s3cret"]).flags["token"], "s3cret");
  assert.equal(parseArgs(["serve", "--token", "s3cret"]).flags["token"], "s3cret", "the spaced form still works");
  // First `=` only: tokens, URLs with query strings and base64 all contain one.
  assert.equal(parseArgs(["serve", "--token=a=b=c"]).flags["token"], "a=b=c");
  // An empty value is a value the caller GAVE, and the `--token` guard refuses it. It
  // must not collapse into `true` (a flag with no value) or into absent.
  assert.equal(parseArgs(["serve", "--token="]).flags["token"], "");
  assert.equal(parseArgs(["serve", "--token"]).flags["token"], true);
  assert.equal(parseArgs(["serve"]).flags["token"], undefined);
  // `--=x` has no name; it must not become a flag called "".
  assert.equal(parseArgs(["serve", "--=x"]).flags[""], undefined);
});

// ── how gates reach humans, and how humans answer ────────────────────────────
//
// `bin/loom` used to construct a `ControlPlane` with no dispatcher, so neither the inbound
// callback route nor its bearer carve-out existed in the binary, and nothing in the CLI
// built a channel or held a signing secret. The feature was reachable by embedding
// `@loom/core` and not by running the thing we ship — which is the shape of defect a test
// per hop cannot see, because every hop had one and the joins had none.

const CHANNEL_SECRET = "shhh-approvals-service";

/** A graph whose action is BEHIND a gate, so "the run resumed" and "the action ran" differ. */
const GUARDED = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "guarded-write", project: "demo", version: 1 },
  policy: { posture: "on", capabilities: ["fs:write"] },
  channels: {
    plan: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["plan"],
  outputs: ["written"],
  nodes: [
    {
      id: "approve",
      type: "human_gate",
      reads: ["plan"],
      writes: ["plan"],
      humanGate: {
        ref: "oversight/deploy@stable",
        approval: { approvers: ["u:release-manager"] },
        // The graph names the channel; the deployment says what that channel IS. Neither
        // layer can complete a round trip alone, which is the seam this test is about.
        delivery: { channels: ["approvals"] },
      },
    },
    {
      id: "apply",
      type: "tool",
      reads: ["plan"],
      writes: ["written"],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/applied.txt", body: "${plan}" } },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "approve", to: "apply", kind: "seq" }],
};

function writeChannels(dir: string, body: unknown): string {
  const file = join(dir, "channels.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
}

test("a malformed channels file REFUSES TO START rather than delivering gates nowhere", () => {
  // Same trade as the identity file, and for a sharper reason: this file holds a SIGNING
  // SECRET and decides whether an unauthenticated route exists. Booting past a typo in it
  // produces a deployment whose gates reach nobody, or whose approvals endpoint answers
  // 404 to the only service that can answer — found hours later, at the first gate.
  const d = emptyDir();
  try {
    const cases: readonly [string, unknown][] = [
      ["no channels key", { webhooks: [] }],
      ["an empty list", { channels: [] }],
      ["a channel with no name", { channels: [{ url: "https://x.example.com" }] }],
      ["a channel with no url", { channels: [{ name: "slack" }] }],
      ["a non-object row", { channels: ["slack"] }],
      // A `Map` keyed by name: the second row would silently replace the first and one
      // configured channel would never deliver, with nothing anywhere saying so.
      ["a repeated name", { channels: [{ name: "slack", url: "https://a.example.com" }, { name: "slack", url: "https://b.example.com" }] }],
      // The `--token ""` slip, one file over. A signed channel with signing turned off
      // looks authenticated in a config file and is not.
      ["an empty callbackSecret", { channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "" }] }],
      ["an empty callbackBaseUrl", { callbackBaseUrl: "", channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "s" }] }],
      // The replay window is a security parameter; a string would silently fall back to
      // the five-minute default rather than the value the operator wrote.
      ["a string toleranceMs", { channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "s", toleranceMs: "60000" }] }],
      // Refused by `SignedWebhookChannel`, re-raised naming the file and the row.
      ["a callbackBaseUrl with credentials in it", { callbackBaseUrl: "https://u:p@loom.example.com", channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "s" }] }],
    ];
    for (const [what, body] of cases) {
      const file = writeChannels(d.dir, body);
      assert.throws(() => readChannels(file), (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID, what);
    }
    writeFileSync(join(d.dir, "channels.json"), "{oops");
    assert.throws(() => readChannels(join(d.dir, "channels.json")), (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID);
  } finally {
    d.dispose();
  }
});

test("A DURATION NO TIMER CAN HOLD IS REFUSED, because the platform turns it into ONE MILLISECOND", async () => {
  // The two knobs wave 10 added were unbounded above, and above the ceiling each becomes
  // its OWN OPPOSITE rather than merely wrong:
  //
  //   --sweep-ms 86400000000  "sweep once a day"      → a sweep every millisecond
  //   "timeoutMs": 2**31      "give it 24 days"       → every delivery aborts before the
  //                                                     socket connects, i.e. nobody is
  //                                                     ever told about the gate
  //
  // …while the boot output announced the interval that was asked for and the channel as
  // `(answerable)`. That is exactly what `announce` promises cannot happen ("no line can
  // promise a posture the running process does not have"), broken by arithmetic one layer
  // under it.
  //
  // THE PLATFORM FACT THE CEILING EXISTS FOR, pinned rather than asserted in a comment.
  // `setTimeout`, `setInterval` and `AbortSignal.timeout` keep their delay in a 32-bit
  // signed integer and TRUNCATE — they do not saturate and they do not throw. 50ms against
  // a nominal 24.8 days is not a timing assertion; it is six orders of magnitude. If this
  // ever goes red, the platform stopped truncating and the refusal can be reconsidered.
  const overflowing = AbortSignal.timeout(2 ** 31);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(overflowing.aborted, true, "AbortSignal.timeout(2**31) is nominally ~24 days and fired inside 50ms");
  assert.equal((overflowing.reason as Error).name, "TimeoutError");

  const d = emptyDir();
  try {
    // Both durations a channels file carries, and the boundary value on each — so the
    // refusal cannot quietly become an off-by-one that refuses a usable configuration.
    const cases: readonly [string, unknown][] = [
      ["a timeoutMs above the ceiling", { channels: [{ name: "slack", url: "https://x.example.com", timeoutMs: 2 ** 31 }] }],
      ["a toleranceMs above the ceiling", { channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "s", toleranceMs: 2 ** 31 }] }],
      // The unit slip this really arrives as: microseconds, or a day written in the wrong
      // base unit. Nobody types 2**31; everybody types this.
      ["a day in microseconds", { channels: [{ name: "slack", url: "https://x.example.com", timeoutMs: 86_400_000_000 }] }],
    ];
    for (const [what, body] of cases) {
      const file = writeChannels(d.dir, body);
      assert.throws(
        () => readChannels(file),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /ceiling/.test(e.message),
        what,
      );
    }
    const atTheCeiling = writeChannels(d.dir, {
      channels: [{ name: "slack", url: "https://x.example.com", callbackSecret: "s", timeoutMs: 2 ** 31 - 1, toleranceMs: 2 ** 31 - 1 }],
    });
    assert.deepEqual([...readChannels(atTheCeiling).answerable], ["slack"], "the largest delay a timer CAN hold is a legal one");

    // And the same ceiling on the flag, refused before the socket rather than announced
    // and then silently disregarded.
    for (const argv of [
      ["serve", "--workspace", d.dir, "--port", "0", "--sweep-ms", String(2 ** 31)],
      ["serve", "--workspace", d.dir, "--port", "0", "--sweep-ms", "86400000000"],
    ]) {
      const r = await refusing(argv);
      assert.equal(r.code, 1, `\`loom ${argv.join(" ")}\` must exit non-zero. stderr:\n${r.err}`);
      assert.match(r.err, /E_CONFIG_INVALID/, argv.join(" "));
      assert.match(r.err, /--sweep-ms/, "the message names the flag the operator typed");
      assert.match(r.err, /ceiling/, argv.join(" "));
    }
  } finally {
    d.dispose();
  }
});

test("`--port` WITH NO VALUE IS NOT PORT 1, and `--port=` IS NOT A RANDOM PORT", async () => {
  // The `String(true)`/`Number(true)` slip the token and the sweep interval are both
  // guarded against, on the one remaining flag that reaches a platform API with a range.
  // Driven against the old expression (`Number(args.flags["port"] ?? 8787)`) before the
  // guard existed, one row per way the flag arrives:
  //
  //     --port          Number(true) = 1    → listen EACCES on 127.0.0.1:1, thrown from an
  //                                           'error' event with no handler: a raw stack
  //                                           trace and a dead process
  //     --port=         Number("")   = 0    → BOUND 58423. A random port, announced, with
  //                                           nothing saying the flag was disregarded
  //     --port 70000    RangeError: options.port should be >= 0 and < 65536
  //     --port http     the same RangeError, for NaN
  //
  // The middle one is the dangerous one and the reason this is a refusal rather than a
  // tidy-up: `loom serve --port="$PORT"` with the variable unset is a deployment that
  // starts, reports itself healthy, and is unreachable at the address it was configured
  // for. The last two are already loud, and still name neither the flag nor the mistake —
  // and arrive after the workspace has been created and a SQLite handle opened.
  const d = emptyDir();
  try {
    for (const argv of [
      ["serve", "--workspace", d.dir, "--port"],
      ["serve", "--workspace", d.dir, "--port="],
      ["serve", "--workspace", d.dir, "--port", "70000"],
      ["serve", "--workspace", d.dir, "--port", "http"],
    ]) {
      const r = await refusing(argv);
      assert.equal(r.code, 1, `\`loom ${argv.join(" ")}\` must exit non-zero. stderr:\n${r.err}`);
      assert.match(r.err, /E_CONFIG_INVALID/, argv.join(" "));
      assert.match(r.err, /--port/, "the message names the flag, which ERR_SOCKET_BAD_PORT does not");
    }
    // 0 is a REAL choice — "any free port" — and every test in this file that binds one
    // depends on it staying legal.
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", "s3cret"]);
    assert.match(s.out, /loom listening on http:\/\/127\.0\.0\.1:\d+/);

    // AND THE FAILURE THIS FLAG CHECK CANNOT REMOVE, which its docstring used to claim it
    // did: a LEGAL port that cannot be bound. Every case above is a value slip; this one
    // is a whole number in range, and it exited through the same unhandled `'error'`
    // event the docstring named as the thing being fixed:
    //
    //     $ loom serve --workspace <dir> --port 1
    //     node:events:487 / throw er; // Unhandled 'error' event
    //     Error: listen EACCES: permission denied 127.0.0.1:1  … a raw stack, exit 1
    //
    // Driven here against a port THIS TEST is holding, so it needs no privilege and races
    // with nothing: `serving` above is still listening on `s`'s port.
    const taken = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(s.out)?.[1]);
    assert.ok(Number.isInteger(taken) && taken > 0, `could not read the bound port back from:\n${s.out}`);
    const clash = await refusing(["serve", "--workspace", d.dir, "--port", String(taken)]);
    await s.stop();
    assert.equal(clash.code, 1, `a taken port must exit non-zero, not crash. stderr:\n${clash.err}`);
    assert.match(clash.err, /E_CONFIG_INVALID/, "a LoomError, not an uncaught 'error' event");
    assert.match(clash.err, /could not bind 127\.0\.0\.1:/, "the message names the address it failed on");
    assert.doesNotMatch(clash.err, /Unhandled 'error' event/, "the raw stack trace is what this replaces");
  } finally {
    d.dispose();
  }
});

test("CTRL-C TWICE STILL WAITS FOR THE SOCKET — the second one must not cut the shutdown short", async () => {
  // `serve` ends at `await new Promise((r) => process.on("SIGINT", …))`, and `process.on`
  // is not `once`: pressing Ctrl-C twice runs the handler twice, which is not an exotic
  // shape but the ordinary impatient one. `main` then returns and the module guard calls
  // `process.exit(code)` immediately, so whatever the SECOND handler believes about the
  // socket is what actually happens to it.
  //
  // `ControlPlane.close()` cleared `#server` first — deliberately, so a `listen` is
  // admitted the moment the socket stops accepting — and the second call therefore took
  // the "nothing bound" early return and resolved at **0 ms**, while the first was still
  // inside its 2 s grace with a connection attached. The process exited on that answer.
  //
  // Driven with ONE mid-request connection, which is what makes the grace real: bytes
  // sent, no terminating blank line, so it is neither idle (`closeIdleConnections` will
  // not take it) nor finished (`server.close` waits for it).
  //
  // The elapsed time is an ASSERTION here rather than the usual failure deadline, and it
  // is the only one in this file that is: the defect IS a duration — "resolved before the
  // socket was released" has no other observable. The margin is wide (≥1 s against a 2 s
  // grace, and the early return answered in single-digit ms).
  const d = emptyDir();
  try {
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0"]);
    const sock = connect(s.port, "127.0.0.1");
    try {
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", () => resolve());
        sock.once("error", reject);
      });
      sock.write("GET /health HTTP/1.1\r\nHost: x\r\n");
      await new Promise<void>((r) => setTimeout(r, 100));

      const t = Date.now();
      s.sigint();
      await new Promise<void>((r) => setTimeout(r, 50));
      const code = await s.stop();
      const ms = Date.now() - t;

      assert.equal(code, 0, `a clean shutdown, not an unhandled rejection. stderr:\n${s.err}`);
      assert.ok(ms >= 1000, `the second Ctrl-C joined the first shutdown instead of answering for it (${ms}ms)`);
      // The `.catch` arm on the detached shutdown promise: an unhandled rejection here
      // would end the process at 1 with no message of ours anywhere.
      assert.doesNotMatch(s.err, /UnhandledPromiseRejection|unhandledRejection/, s.err);
      assert.doesNotMatch(s.err, /SHUTDOWN INCOMPLETE/, `close() itself failed:\n${s.err}`);
    } finally {
      sock.destroy();
      await s.stop();
    }
  } finally {
    d.dispose();
  }
});

test("A SHUTDOWN THAT DID NOT COMPLETE EXITS NON-ZERO — the message and the exit code must agree", async () => {
  // `serve` printed `! SHUTDOWN INCOMPLETE — close() failed: …` and then returned 0, so
  // the only thing a supervisor reads — the exit status — said the process stopped
  // cleanly immediately after the process said it had not. systemd, a container runtime
  // and a `&&` in a shell script all restart or proceed on that; nobody re-reads stderr to
  // check whether the 0 was true.
  //
  // `main`'s own vocabulary already answers what a supervisor should see: 0 is "what you
  // asked for happened" (`run` succeeded, `replay` matched, `trace` conformed), 1 is "it
  // did not", 2 is "there is no such command", and the module entry point exits 1 on any
  // thrown error. A shutdown that left a socket bound is "it did not".
  //
  // 130 (128 + SIGINT) was considered and is wrong twice: it is equally true of the
  // SUCCESSFUL Ctrl-C, so it cannot distinguish the two, and it would make every clean
  // stop look like a crash to a supervisor that treats non-zero as one.
  //
  // The path is driven directly because `close()` cannot currently reject — that is a fact
  // about ANOTHER FILE's control flow, which is exactly why `serve` does not depend on it.
  // `serveUntilInterrupt` exists so the dependency is held by a test rather than by a
  // comment; it takes the two things it stops, which is all the coupling it needs.
  const stopped: string[] = [];
  const clock = { stop: () => stopped.push("clock") };
  const errOut: string[] = [];
  const realErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string) => (errOut.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const failing = serveUntilInterrupt({ close: () => Promise.reject(new Error("a connection would not let go")) }, clock);
    process.emit("SIGINT");
    assert.equal(await failing, 1, "the exit code must say what the message said");
    assert.match(errOut.join(""), /SHUTDOWN INCOMPLETE/);
    assert.deepEqual(stopped, ["clock"], "the clock still stops — `.finally` is not conditional on success");

    // And the ordinary path is still 0, because a clean Ctrl-C is not a failure.
    const clean = serveUntilInterrupt({ close: () => Promise.resolve() }, clock);
    process.emit("SIGINT");
    assert.equal(await clean, 0);
  } finally {
    process.stderr.write = realErr;
  }
  // No handler is left behind. `process.on` (not `once`) is deliberate — Ctrl-C twice must
  // reach the second handler while the first close is still in flight — but a handler that
  // outlives the wait is a listener leak in any embedder that calls this more than once.
  assert.equal(process.listenerCount("SIGINT"), 0, "the SIGINT handler is removed once the shutdown has settled");
});

test("A FLAG WITH NO VALUE IS NOT A DIRECTORY CALLED `true` — the journal is not written where nobody looks", async () => {
  // The `String(true)` slip, on the two flags that decide WHERE THE JOURNAL GOES, and it
  // is the quietest member of the family: `--token` and `--port` were caught because their
  // wrong values are dangerous, and these two were missed because their wrong value merely
  // WORKS. `String(args.flags["workspace"] ?? process.cwd())` made `--workspace` with no
  // value resolve to `./true`. Measured before the check:
  //
  //     $ loom compile g.json --workspace
  //     ok                         ← exit 0
  //     $ ls -a
  //     .  ..  g.json  true        ← a directory holding .loom/journal.db and graphs/
  //
  // Invariant 2 says the journal is the only authoritative durable state. A run submitted
  // into `./true` is not recoverable by anyone who does not know the flag was disregarded,
  // and `loom gates <runId>` in the intended workspace answers `[]` — the empty answer and
  // the true answer being indistinguishable is the whole failure.
  const d = emptyDir();
  const cwd = process.cwd();
  try {
    process.chdir(d.dir);
    const graphFile = seed(d.dir);
    for (const flag of ["workspace", "data-dir"]) {
      for (const argv of [["compile", graphFile, `--${flag}`], ["compile", graphFile, `--${flag}=`]]) {
        await assert.rejects(
          () => run(argv),
          (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && new RegExp(`--${flag}`).test(e.message),
          `\`loom ${argv.join(" ")}\` must refuse, naming the flag the operator typed`,
        );
      }
    }
    assert.equal(existsSync(join(d.dir, "true")), false, "and no directory called `true` was created");

    // A real value still works, and so does omitting the flag entirely.
    assert.equal((await run(["compile", graphFile, "--workspace", d.dir])).code, 0);
    assert.equal((await run(["compile", graphFile])).code, 0);
  } finally {
    process.chdir(cwd);
    d.dispose();
  }
});

test("`--input` WITH NO VALUE IS NOT THE BOOLEAN `true`, and a JSON typo is not a bug in Loom", async () => {
  // The fourth flag in the `String(true)`/`Number(true)` family, and the last one in this
  // file that turns an operator's slip into a value. `JSON.parse(String(args.flags["input"]
  // ?? "{}"))` — `--input` with no value is `true` from `parseArgs`, `String(true)` is
  // `"true"`, and `JSON.parse("true")` is the BOOLEAN `true`, which is then handed to
  // `engine.submit` as the run's inputs. Measured:
  //
  //     loom run g.json --input      → status "failed", exit 1, nothing naming the flag.
  //                                    The failure is a channel binding failure four
  //                                    layers down from the mistake.
  //     loom run g.json --input=     → E_INTERNAL: SyntaxError: Unexpected end of JSON input
  //     loom run g.json --input nope → E_INTERNAL: SyntaxError: Unexpected token 'o'
  //
  // The last two are loud and misfiled: `E_INTERNAL` is this system's word for "a bug in
  // Loom", and `safeDecode` in `server/http.ts` states the rule they break — a caller
  // sending nonsense is not an internal error and must not be reported as one.
  const d = emptyDir();
  try {
    const graphFile = seed(d.dir);
    for (const argv of [
      ["run", graphFile, "--workspace", d.dir, "--input"],
      ["run", graphFile, "--workspace", d.dir, "--input="],
      ["run", graphFile, "--workspace", d.dir, "--input", "nope"],
      ["run", graphFile, "--workspace", d.dir, "--input", "[1,2]"],
      ["run", graphFile, "--workspace", d.dir, "--input", "null"],
    ]) {
      await assert.rejects(
        () => run(argv),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--input/.test(e.message),
        `\`loom ${argv.join(" ")}\` must be a configuration refusal naming the flag, never E_INTERNAL`,
      );
    }
    // A real object still runs, and so does omitting the flag.
    assert.equal((await run(["run", graphFile, "--workspace", d.dir, "--input", `{"source":"${join(d.dir, "input.txt")}"}`])).code, 0);
  } finally {
    d.dispose();
  }
});

test("`--graph` WITH NO VALUE IS REFUSED LIKE THE OTHER PATH FLAGS — replay and trace included", async () => {
  // `requireFileFlag` exists for exactly this and was wired to `--identity-file` and
  // `--channels-file` only, while `replay` and `trace` read `String(requireFlag(args,
  // "graph"))` — the pre-`requireFileFlag` expression, still in the tree, one flag over.
  // Measured: `loom replay r_x --graph` → `E_INTERNAL: Error: EISDIR: illegal operation on
  // a directory, read` (or ENOENT for `true`), naming neither the flag nor the mistake,
  // which is verbatim the failure `requireFileFlag`'s own docstring cites as its reason
  // for existing.
  const d = emptyDir();
  try {
    for (const argv of [
      ["replay", "r_nope", "--workspace", d.dir, "--graph"],
      ["replay", "r_nope", "--workspace", d.dir, "--graph="],
      ["trace", "r_nope", "--workspace", d.dir, "--graph"],
    ]) {
      await assert.rejects(
        () => run(argv),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--graph/.test(e.message),
        `\`loom ${argv.join(" ")}\` must name the flag, which EISDIR does not`,
      );
    }
    // `--as` is the last member of this family and the only one whose wrong value reaches
    // the JOURNAL: `String(true)` wrote the four letters "true" into a gate decision as the
    // subject who approved it, in a field an approvers list is matched against.
    for (const argv of [
      ["approve", "r_nope", "g_nope", "--workspace", d.dir, "--as"],
      ["approve", "r_nope", "g_nope", "--workspace", d.dir, "--as="],
      // …and the third door to that field. The control plane refuses a caller CLAIMING
      // `(unidentified)`, and the compiler refuses a graph LISTING one as an approver; this
      // process authenticates nobody, so it is the one that would journal a decision under
      // a subject naming nobody — and satisfy an approvers list naming it.
      ["approve", "r_nope", "g_nope", "--workspace", d.dir, "--as", "(unidentified)"],
      ["approve", "r_nope", "g_nope", "--workspace", d.dir, "--as", "(shared-token)"],
    ]) {
      await assert.rejects(
        () => run(argv),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--as/.test(e.message),
        `\`loom ${argv.join(" ")}\` must not journal a subject the shell invented`,
      );
    }
  } finally {
    d.dispose();
  }
});

test("a channel with no secret is NOTIFY-ONLY, which is a configuration and not a mistake", () => {
  // `callbackSecret` is the switch: with one the channel is answerable and the
  // unauthenticated route opens; without one it can be told about a gate and never
  // answers — a pager, a dashboard, an audit sink. The absence fails CLOSED.
  const d = emptyDir();
  try {
    const file = writeChannels(d.dir, {
      callbackBaseUrl: "https://loom.example.com",
      channels: [
        { name: "slack", url: "https://hooks.example.com/a", callbackSecret: CHANNEL_SECRET },
        { name: "pager", url: "https://events.example.com/b" },
      ],
    });
    const cfg = readChannels(file);
    assert.deepEqual([...cfg.answerable], ["slack"]);
    assert.deepEqual([...cfg.notifyOnly], ["pager"]);
    assert.equal(cfg.publishesAddress, true);
    // The answerable one has an inbound path; the other does not, and that is what
    // `GateCallbackRouter` looks at.
    assert.equal(typeof cfg.dispatcher.channel("slack")?.parseCallback, "function");
    assert.equal(cfg.dispatcher.channel("pager")?.parseCallback, undefined);
  } finally {
    d.dispose();
  }
});

test("--channels-file and --identity-file with NO VALUE are refused, not read as a file called \"true\"", () => {
  // `parseArgs` yields `true` for a flag with no value, and `String(true)` sent
  // `readFileSync` looking for a file named `true`. These two files are the perimeter and
  // the return path; `ENOENT: open 'true'` names neither the flag nor the mistake.
  const d = emptyDir();
  try {
    for (const argv of [
      ["serve", "--workspace", d.dir, "--channels-file"],
      ["serve", "--workspace", d.dir, "--channels-file="],
    ]) {
      assert.throws(
        () => openWorkspace(parseArgs(argv)),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--channels-file/.test(e.message),
        argv.join(" "),
      );
    }
    const ws = openWorkspace(parseArgs(["serve", "--workspace", d.dir]));
    try {
      assert.throws(
        () => controlPlaneOptions(ws, parseArgs(["serve", "--identity-file"])),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /--identity-file/.test(e.message),
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("THE ROUTE EXISTS ONLY WHEN SOMEBODY CAN ANSWER ON IT", () => {
  // `ControlPlaneOptions.dispatcher` opens `POST /runs/:id/callbacks/:channel` AND its
  // carve-out in the bearer check, together. A dispatcher whose channels are all
  // notify-only would open a route that refuses every request — attack surface bought for
  // nothing — so the two facts are made the same fact here.
  const d = emptyDir();
  try {
    const notifyOnly = writeChannels(d.dir, { channels: [{ name: "pager", url: "https://events.example.com/b" }] });
    const argv = ["serve", "--workspace", d.dir, "--channels-file", notifyOnly];
    const ws = openWorkspace(parseArgs(argv));
    try {
      assert.equal(controlPlaneOptions(ws, parseArgs(argv)).dispatcher, undefined, "notify-only: no inbound route");
    } finally {
      ws.close();
    }

    const answerable = writeChannels(d.dir, {
      channels: [{ name: "slack", url: "https://hooks.example.com/a", callbackSecret: CHANNEL_SECRET }],
    });
    const argv2 = ["serve", "--workspace", d.dir, "--channels-file", answerable];
    const ws2 = openWorkspace(parseArgs(argv2));
    try {
      assert.notEqual(controlPlaneOptions(ws2, parseArgs(argv2)).dispatcher, undefined);
    } finally {
      ws2.close();
    }

    // And with no channels file at all — the shipped default — there is no route and no
    // hole, which is what `bin/loom` had before this and what it still has by default.
    const bare = openWorkspace(parseArgs(["serve", "--workspace", d.dir]));
    try {
      assert.equal(controlPlaneOptions(bare, parseArgs(["serve"])).dispatcher, undefined);
    } finally {
      bare.close();
    }
  } finally {
    d.dispose();
  }
});

test("`loom serve` SAYS which perimeter it has, including the second hole", async () => {
  // A deployment with an inbound callback route and one without are materially different
  // postures, and which one you had was previously invisible in the output.
  const d = emptyDir();
  try {
    const file = writeChannels(d.dir, {
      channels: [
        { name: "slack", url: "https://hooks.example.com/a", callbackSecret: CHANNEL_SECRET },
        { name: "pager", url: "https://events.example.com/b" },
      ],
    });
    // Stopped BEFORE asserting: `stop` waits for the child's pipes to drain, so what is
    // read below is everything the process wrote and not a prefix of it.
    const s = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", "s3cret", "--channels-file", file]);
    await s.stop();
    assert.match(s.out, /gates:.*slack \(answerable\).*pager \(notify-only\)/);
    assert.match(s.err, /CALLBACK ROUTE OPEN/);
    assert.match(s.err, /WITHOUT the bearer token/);
    assert.match(s.err, /slack/);
    // Answerable, and no address published: every receiver still has to be told the URL
    // out of band, which is the thing having a callback route was meant to fix (B4).
    assert.match(s.err, /NO CALLBACK BASE URL/);

    const quiet = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", "s3cret"]);
    await quiet.stop();
    assert.match(quiet.out, /gates:\s+\(no channels/);
    assert.equal(/CALLBACK ROUTE OPEN/.test(quiet.err), false, "no route, so nothing to warn about");
  } finally {
    d.dispose();
  }
});

test("`loom serve` DRIVES THE GATE CLOCK, so a declared SLA is an enforced one", async () => {
  // `Engine.sweepGates` starts no timer, on purpose: every clock in this codebase is
  // injected so a test can advance it and observe exactly one escalation. The INTERVAL is
  // therefore the deployment's, and `serve` is the only long-lived process we ship — so
  // without this wiring a gate declaring `onTimeout: "fail"` waits forever in `bin/loom`.
  //
  // The wall clock appears here as a FAILURE DEADLINE and never as a condition: nothing
  // below asserts how long anything took, only that the sweep eventually fires at all.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const expiring = {
      ...GUARDED,
      metadata: { ...GUARDED.metadata, name: "expiring-gate" },
      nodes: GUARDED.nodes.map((n) =>
        n.id !== "approve" ? n : { ...n, humanGate: { ref: "oversight/deploy@stable", sla: { respondWithinMs: 10, onTimeout: "fail" } } },
      ),
    };
    writeFileSync(join(d.dir, "graphs", "expiring.json"), JSON.stringify(expiring));

    const s = await serving(["serve", "--workspace", d.dir, "--port", "0", "--token", "s3cret", "--sweep-ms", "25"]);
    try {
      assert.match(s.out, /clock:\s+gate SLAs.*every 25ms/, "what is on, said at boot");
      const port = /loom listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(s.out)?.[1];
      assert.ok(port, s.out);

      const base = `http://127.0.0.1:${port}`;
      const headers = { authorization: "Bearer s3cret", "content-type": "application/json" };
      const submitted = await fetch(`${base}/runs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ workflow: "expiring-gate", inputs: { plan: "something nobody will approve" } }),
      });
      assert.equal(submitted.status, 202);
      const { runId } = (await submitted.json()) as { runId: string };

      let status = "";
      await until(async () => {
        status = ((await (await fetch(`${base}/runs/${runId}`, { headers })).json()) as { status: string }).status;
        return status === "failed";
      }, "the gate's SLA never fired — nothing is driving the clock");
      assert.equal(status, "failed", "onTimeout: fail, enforced by a tick the deployment started");
      // FAIL-CLOSED: the action behind the gate did not run because nobody approved it.
      assert.equal(existsSync(join(d.dir, "out", "applied.txt")), false);
    } finally {
      await s.stop();
    }
  } finally {
    d.dispose();
  }
});

test("A GATE THIS PROCESS DID NOT RAISE STILL ESCALATES — the clock arms what it is asked to sweep", async () => {
  // `GateSweeper` reads its escalation chain from the broker record only the RAISING process
  // wrote. `rehydrateGates` rebuilds it, and was wired into the two write paths and the RUN
  // clock — never into the gate clock, whose whole job is the deadline. The run clock could not
  // cover it either: it skips any run that is not `running`, and a run holding a gate is
  // `awaiting_gate` by definition.
  //
  // So the shipped two-verb shape had it. Measured through `bin/loom` before the fix: submitted
  // through `POST /runs` the journal reads gate.delivered, gate.escalated, gate.delivered,
  // gate.timeout; raised by `loom run` against the same serving plane it read gate.raised,
  // run.suspended, gate.timeout — `onTimeout: "escalate"` behaving precisely as `fail`, which is
  // the outcome `GRAPH014_SLA_INVALID` refuses a graph at COMPILE time to prevent.
  //
  // `run(...)` here is that second process in miniature: its own `Workspace` and its own
  // `Engine` over the same store, so the serving plane's broker never sees the raise.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const escalating = {
      ...GUARDED,
      metadata: { ...GUARDED.metadata, name: "escalating-gate" },
      nodes: GUARDED.nodes.map((n) =>
        n.id !== "approve"
          ? n
          : {
              ...n,
              humanGate: {
                ref: "oversight/deploy@stable",
                sla: { respondWithinMs: 10, onTimeout: "escalate" },
                // A second tier to reach, and a terminal one so the run still ends. The channel
                // names need no deployment behind them: an unknown name fails delivery loudly and
                // never auto-approves, and the assertion here is the ESCALATION, not the send.
                delivery: { channels: ["first"], escalation: [{ afterMs: 10, channels: ["second"] }, { afterMs: 60_000, action: "fail" }] },
              },
            },
      ),
    };
    const file = join(d.dir, "graphs", "esc.json");
    writeFileSync(file, JSON.stringify(escalating));

    const s = await serving(["serve", "--workspace", d.dir, "--port", "0", "--sweep-ms", "25"]);
    try {
      const r = await run(["run", file, "--workspace", d.dir, "--input", JSON.stringify({ plan: "nobody will answer this" })]);
      const runId = /"runId":\s*"([0-9A-Z]+)"/.exec(r.out)?.[1];
      assert.ok(runId, `no runId in: ${r.out}\n${r.err}`);

      const types = (): string[] => {
        const db = new DatabaseSync(join(d.dir, ".loom", "journal.db"), { readOnly: true });
        try {
          return db.prepare("select type from journal where run_id = ? order by seq").all(runId).map((x) => String((x as { type: unknown }).type));
        } finally {
          db.close();
        }
      };
      await until(() => types().includes("gate.escalated"), "the gate expired without ever escalating — the sweeper held no chain for a gate it did not raise");

      const seen = types();
      assert.ok(seen.indexOf("gate.escalated") > seen.indexOf("gate.raised"), `escalation must follow the raise: ${seen.join(" ")}`);
      // FAIL-CLOSED THROUGHOUT: escalating is telling someone else, never deciding for them.
      assert.equal(existsSync(join(d.dir, "out", "applied.txt")), false);
    } finally {
      await s.stop();
    }
  } finally {
    d.dispose();
  }
});

test("THE WHOLE LOOP — a graph raises a gate, it is delivered, a signed callback answers it, and the guarded action runs", async () => {
  // Every hop of this existed and none of them had ever been run as ONE thing. The gaps
  // were at the joins: the binary built no channels (B3) and the outbound payload never
  // said where to answer (B4), so the two halves could each pass their own tests while the
  // shipped product could not complete a round trip.
  //
  // Nothing here is told anything out of band. The approvals service learns the address
  // and the signing scheme from the delivered payload, and answers with NO bearer token —
  // which it does not have, because that is the whole reason the route is carved out.
  const d = emptyDir();
  const approvals = await approvalsService();
  // Pre-allocated, because the address a delivered gate publishes is baked into the
  // channel at construction and the run is submitted after that.
  const port = await freePort();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    writeFileSync(join(d.dir, "graphs", "guarded.json"), JSON.stringify(GUARDED));
    const file = writeChannels(d.dir, {
      callbackBaseUrl: `http://127.0.0.1:${port}`,
      channels: [{ name: "approvals", url: approvals.url, callbackSecret: CHANNEL_SECRET }],
    });

    const argv = ["serve", "--workspace", d.dir, "--port", String(port), "--token", "s3cret", "--channels-file", file];
    const args = parseArgs(argv);
    const ws = openWorkspace(args);
    const plane = new ControlPlane(controlPlaneOptions(ws, args));
    await plane.listen(port);
    const base = `http://127.0.0.1:${port}`;
    try {
      // ── 1. a graph raises a gate ──────────────────────────────────────────
      const submitted = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: "Bearer s3cret", "content-type": "application/json" },
        body: JSON.stringify({ workflow: "guarded-write", inputs: { plan: "scale api to 12 replicas" } }),
      });
      assert.equal(submitted.status, 202);
      const { runId } = (await submitted.json()) as { runId: string };

      // ── 2. it is delivered over a channel ─────────────────────────────────
      const gate = await approvals.next();
      assert.equal(gate["runId"], runId);
      assert.equal(gate["nodeId"], "approve");
      const gateId = gate["gateId"] as string;

      // …carrying the address to answer at, and the scheme to sign with. WITHOUT THIS the
      // rest of this test would have to be told the URL by the test author, which is
      // precisely the out-of-band coupling B4 names.
      const callback = gate["callback"] as { url: string; channel: string; signature: Record<string, string> };
      assert.ok(callback, "a delivered gate that does not say where to answer is not a round trip");
      assert.equal(callback.url, `${base}/runs/${runId}/callbacks/approvals`);
      assert.equal(
        JSON.stringify(gate).includes(CHANNEL_SECRET),
        false,
        "the signing secret must never travel with the message it protects",
      );

      // ── 3. a signed callback comes back ───────────────────────────────────
      // Built by FOLLOWING the two strings in the payload rather than by importing the
      // channel: `signedPayload: "v0:{timestamp}:{body}"` and `signatureFormat: "v0={hex}"`
      // are the contract a third party implements, so the test implements them too.
      const answer = JSON.stringify({ runId, gateId, actor: "u:release-manager", decision: { kind: "approve" } });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const hex = createHmac("sha256", CHANNEL_SECRET).update(`v0:${timestamp}:`).update(Buffer.from(answer, "utf8")).digest("hex");
      const answered = await fetch(callback.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [callback.signature["timestampHeader"]!]: timestamp,
          [callback.signature["signatureHeader"]!]: `v0=${hex}`,
        },
        body: answer,
      });
      const answerBody = await answered.text();
      assert.equal(answered.status, 200, answerBody);
      const decided = JSON.parse(answerBody) as { decision: string; actor: { subject: string } };
      assert.equal(decided.decision, "approve");
      assert.equal(decided.actor.subject, "u:release-manager", "the human the signature vouched for, not the credential");

      // ── 4. the run resumes and the GUARDED ACTION executes ────────────────
      // The distinction that was once a real bug: approving a `human_gate` completes that
      // node, and the work is on the node behind it. A run reporting success while the
      // action never happened is the failure this assertion exists for.
      await until(() => existsSync(join(d.dir, "out", "applied.txt")));
      assert.equal(readFileSync(join(d.dir, "out", "applied.txt"), "utf8"), "scale api to 12 replicas");

      const after = (await (await fetch(`${base}/runs/${runId}`, { headers: { authorization: "Bearer s3cret" } })).json()) as {
        status: string;
      };
      assert.equal(after.status, "succeeded");

      // AND THE ROUTE REALLY IS THE UNAUTHENTICATED ONE. Everything else on this plane
      // needs the bearer token; the round trip above presented none.
      assert.equal((await fetch(`${base}/runs/${runId}`)).status, 401);
    } finally {
      await plane.close();
      ws.close();
    }
  } finally {
    await approvals.close();
    d.dispose();
  }
});

// ── harness for the two tests above ──────────────────────────────────────────

/** A port nobody is listening on, because the published address must exist before the run. */
async function freePort(): Promise<number> {
  return new Promise<number>((res, rej) => {
    const s = createNetServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => res(port));
    });
  });
}

/** The third party: it receives gates and knows nothing this process did not post to it. */
async function approvalsService(): Promise<{ url: string; next(): Promise<Record<string, unknown>>; close(): Promise<void> }> {
  const seen: Record<string, unknown>[] = [];
  const waiting: ((v: Record<string, unknown>) => void)[] = [];
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("approvals-42");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      const w = waiting.shift();
      if (w === undefined) seen.push(body);
      else w(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/approvals`,
    next: async () => {
      const queued = seen.shift();
      if (queued !== undefined) return queued;
      // RACE, never a bare await: if delivery regresses this must fail the suite rather
      // than hang it — the same reason the `--token ""` test races its own timer.
      return Promise.race([
        new Promise<Record<string, unknown>>((r) => waiting.push(r)),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("no gate was delivered — the binary built no channel, or raised no delivery")), 10_000).unref();
        }),
      ]);
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/**
 * `loom serve`, in a CHILD PROCESS, with its boot output read off its pipes.
 *
 * A child and not an in-process `main(...)` for two reasons, one of which cost an hour:
 *
 *   - `serve` ends in a promise only a SIGINT resolves, so reading its output in-process
 *     means holding `process.stdout.write` replaced for the whole life of the server. The
 *     node test runner's own reporter writes through that same function, so the capture
 *     swallowed the results of every test that had run before it — 18 of them vanished
 *     from the run and the file reported `tests 3`. A test harness that can silently
 *     delete other tests' results is worse than the gap it was covering.
 *   - it is also the more honest test: this is the entry point the shipped binary uses,
 *     argv parsing, module guard and all.
 */
async function serving(
  argv: string[],
): Promise<{ out: string; err: string; port: number; sigint(): void; stop(): Promise<number | null> }> {
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (out += c));
  child.stderr.on("data", (c: string) => (err += c));
  // `close`, not `exit`: `close` is the event that fires once every stdio pipe has been
  // drained, so a caller that stops the server and then reads `out`/`err` sees everything
  // it wrote. `exit` can fire with output still in flight, which makes a negative
  // assertion ("this line was NOT printed") pass for the wrong reason.
  //
  // It carries the EXIT CODE, because how `loom serve` ends is a contract too: an
  // unhandled rejection in the shutdown path ends the process at 1, and a `stop()` that
  // discarded the code could not tell that from a clean 0.
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  // WAIT FOR THE LAST BOOT LINE, NOT THE FIRST. `announce` makes six separate
  // `process.stdout.write` calls and a pipe delivers them in whatever chunks it likes, so
  // waiting for `loom listening` — the FIRST line — returned while `gates:` and `clock:`
  // were still in flight. That failed about one run in three, and only under the full
  // suite, where the machine is loaded enough for the chunks to split: a test that passes
  // alone and fails in the suite is the worst shape a flake comes in. `clock:` is the last
  // thing written to stdout, and a stream delivers in order, so seeing it means the whole
  // block has landed.
  // REAPED ON EVERY FAILURE PATH, and that is not defensive tidiness. `stop()` is on the value
  // this function RETURNS, so anything that throws before the return leaves the child running
  // forever — a `loom serve` holding a temp workspace with nobody left who knows its pid.
  //
  // Found the expensive way: one such orphan, 2h14m old, made `subprocess.test.ts`'s
  // "A CHILD THAT OUTLIVES SIGKILL" test wait on it — 5s alone became 917s in the suite, and
  // `npm test` went from 9s to 923s. A leaked process does not fail a test; it taxes every later
  // run, on a machine, silently.
  let bound: RegExpExecArray | null = null;
  try {
    await until(() => out.includes("  clock:"), `loom serve never finished booting. stdout:\n${out}\nstderr:\n${err}`);
    bound = /loom listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
    if (bound?.[1] === undefined) throw new Error(`could not read the bound port from:\n${out}`);
  } catch (e) {
    child.kill("SIGKILL");
    throw e;
  }
  return {
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    port: Number(bound[1]),
    /** Send Ctrl-C without waiting. A shutdown that can be asked TWICE needs two senders. */
    sigint: () => {
      child.kill("SIGINT");
    },
    stop: async () => {
      child.kill("SIGINT");
      return await exited;
    },
  };
}

/**
 * `loom …`, in a CHILD PROCESS, expected to REFUSE — exit non-zero, having bound nothing.
 *
 * A child and not the in-process `run` helper, for the reason `serving`'s docstring gives
 * at length: `run` holds `process.stdout.write` replaced for the length of the call, and
 * the node test runner's reporter writes through that same function. So when a refusal
 * REGRESSES — `serve` binds a port and waits for a SIGINT that never comes — `run` does not
 * merely fail its own assertion, it swallows the results of every test in the file. A guard
 * whose regression hides the rest of the suite reports less than no guard at all.
 *
 * The deadline is a FAILURE deadline: nothing here asserts how fast a refusal is, only that
 * the process ends by itself. The `SIGKILL` in the `finally` is what makes a regression cost
 * one failed test rather than a hung suite.
 */
async function refusing(argv: string[]): Promise<{ code: number | null; err: string }> {
  const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
  const child = spawn(process.execPath, [cli, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (err += c));
  // `close`, not `exit`: it fires once the pipes have drained, so the message asserted on
  // below is the whole of what the process wrote and not a prefix of it.
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`\`loom ${argv.join(" ")}\` never exited. It must refuse, before it binds anything.`)), 10_000).unref();
  });
  try {
    return { code: await Promise.race([exited, timer]), err };
  } finally {
    child.kill("SIGKILL");
  }
}

/**
 * Poll until a condition holds, failing loudly rather than hanging when it never does.
 *
 * The wall clock is a FAILURE DEADLINE and never a condition: no assertion anywhere below
 * depends on how long something took, only on it having happened at all. A test that
 * `sleep`s for a guess is a test that is flaky on a loaded machine and green on a fast one.
 */
async function until(cond: () => boolean | Promise<boolean>, what = "the condition never became true"): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("a malformed identity file REFUSES TO START rather than starting with nobody", () => {
  // Booting anyway would produce a plane that looks configured and can answer nothing —
  // discovered at the first refused approval, hours later.
  const d = emptyDir();
  try {
    const cases: readonly [string, string][] = [
      ["not json", "{oops"],
      ["no subjects", JSON.stringify({ people: [] })],
      ["an empty list", JSON.stringify({ subjects: [] })],
      ["a token with no subject", JSON.stringify({ subjects: [{ token: "t" }] })],
      ["a subject with no token", JSON.stringify({ subjects: [{ subject: "u:alice" }] })],
    ];
    for (const [what, text] of cases) {
      const file = join(d.dir, "identities.json");
      writeFileSync(file, text);
      assert.throws(
        () => readIdentities(file),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
        what,
      );
    }
    assert.throws(() => readIdentities(join(d.dir, "absent.json")), /ENOENT|E_CONFIG_INVALID/);
  } finally {
    d.dispose();
  }
});

test("A MISTYPED `kind` IN AN IDENTITY FILE IS NOT A PERSON — the dropped-field rule does not hold for it", () => {
  // `via` and `mfa` are DROPPED when the file spells them wrong, and this function's own
  // docstring says why that is right: `via` is journaled vocabulary, and the value a
  // dropped one falls back to (`api`) is TRUE. `kind` was given the same treatment on the
  // same line and the rule does not transfer, because the value IT falls back to is a
  // STRONGER claim than the one that was written: `BearerSubject.kind` defaults to
  // `human`, and `human` is the only kind that can satisfy a gate's approvers list.
  //
  // Measured through this function before the refusal, one row per way an operator gets it
  // wrong, each identifying with the same token:
  //
  //     "kind": "service" → service   (can satisfy an approvers list: false)
  //     "kind": "servce"  → human     (can satisfy an approvers list: TRUE)
  //     "kind": "SERVICE" → human     (can satisfy an approvers list: TRUE)
  //     "kind": 1 / null  → human     (can satisfy an approvers list: TRUE)
  //
  // One transposed letter promotes a deployment's CI credential to a person who may
  // approve production actions, and nothing downstream can tell: by the time `/whoami`,
  // the journal and the console see it, it is a human. `server/http.ts`'s `checkedAuth`
  // states the rule this breaks — "fields that DECIDE … are refused when wrong" — for the
  // injected identity seam; the file is the other door to the same field.
  const d = emptyDir();
  const file = join(d.dir, "identities.json");
  const write = (kind: unknown): string => (writeFileSync(file, JSON.stringify({ subjects: [{ subject: "svc:ci", token: "t0ken", kind }] })), file);
  try {
    for (const bad of ["servce", "SERVICE", "machine", "", 1, null, ["service"]]) {
      assert.throws(
        () => readIdentities(write(bad)),
        (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID && /kind/.test(e.message),
        `"kind": ${JSON.stringify(bad)} must refuse to start, not become a person`,
      );
    }
    // Both legal spellings, and ABSENCE, still work — absence is `human` by documented
    // default and that is the common case, so this is a refusal of the WRONG values only.
    const identified = (text: string, token: string): string | undefined => {
      writeFileSync(file, text);
      const who = readIdentities(file).identify({ method: "GET", path: "/runs", headers: { authorization: `Bearer ${token}` } });
      return (who as { kind?: string } | undefined)?.kind;
    };
    assert.equal(identified(JSON.stringify({ subjects: [{ subject: "svc:ci", token: "t", kind: "service" }] }), "t"), "service");
    assert.equal(identified(JSON.stringify({ subjects: [{ subject: "u:a", token: "t", kind: "human" }] }), "t"), "human");
    assert.equal(identified(JSON.stringify({ subjects: [{ subject: "u:a", token: "t" }] }), "t"), "human", "an absent kind is still a person");
  } finally {
    d.dispose();
  }
});
