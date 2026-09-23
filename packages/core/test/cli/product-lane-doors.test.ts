/**
 * The five CLI doors an operator walks through when they install this and use it.
 *
 * CLAUDE.md's goal sentence is the specification: "Install it, describe what they want done, have
 * it run against a real provider, watch it, stop it, and trust what it did." Each test here is one
 * verb of that sentence failing on the tree before it, measured through `main` rather than through
 * a helper that stands in for it.
 *
 *   - STOP IT, from a supervisor. `loom serve` answered SIGINT and nothing else, so `systemctl
 *     stop`, `docker stop` and a Kubernetes eviction all ended the process at Node's default
 *     disposition: exit 143, no `close()`, and `main`'s `finally` — the MCP children and the
 *     SQLite handle — never reached.
 *   - STOP IT, from the keyboard. `loom run` printed the run id only once the run had reached
 *     rest, so an interrupt produced zero bytes and left a durable run nothing had named.
 *   - REFUSING IS CHEAP. Every refusal between `startMcp` and `openWorkspace` returning orphaned
 *     the spawned MCP servers, so the fail-closed path was the expensive one.
 *   - DESCRIBE WHAT YOU WANT. A misspelled `--input` channel was submitted, spent and failed four
 *     layers down as `E_INTERNAL`, naming a channel the operator never typed.
 *   - TRUST WHAT IT DID. Compile diagnostics named no file, so `loom approve` printed a red `✗`
 *     about an unrelated graph above a successful approval and exited 0 — fixed by attributing
 *     every diagnostic to its file. That fix was necessary and not sufficient: TODO.md §A.91 found
 *     the file `loom trace`/`replay`/`approve` attributed a candidate's diagnostics TO was still
 *     one the operator never named at all — the by-hash sweep behind those verbs compiles every
 *     file in `graphs/` to find the one hash match, and printed every OTHER candidate's warnings
 *     along the way. Attribution made the noise readable; it did not stop it being noise. Fixed by
 *     making that sweep silent about a candidate it rejects, while an explicit `loom compile` or
 *     `--graph` — a graph the operator DID name — stays exactly as loud as attribution left it.
 *
 * Offline and deterministic: temp directories, a graph of built-in tools, and — for the MCP arm —
 * a few lines of Node spawned as a child, the same device `test/mcp/client.test.ts` uses. The one
 * clock read is an absolute bound with an order-of-magnitude margin on a process that has already
 * been asked to die.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

import { serveUntilInterrupt } from "../../src/cli.ts";

const CLI_SRC = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/** A graph of built-in tools only, so nothing has to be registered. */
const GRAPH = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "copy-file", project: "lane-p", version: 1 },
  policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
  channels: {
    source: { type: "string", reduce: "replace" },
    body: { type: "string", reduce: "replace" },
    written: { type: "object", reduce: "replace" },
  },
  inputs: ["source"],
  outputs: ["written"],
  nodes: [
    { id: "read", type: "tool", reads: ["source"], writes: ["body"], tool: { name: "fs.read", version: "1.0", args: { path: "${source}" } } },
    {
      id: "write",
      type: "tool",
      reads: ["body"],
      writes: ["written"],
      unhandled: true,
      tool: { name: "fs.write", version: "1.0", args: { path: "out/copy.txt", body: "${body}" } },
    },
  ],
  edges: [{ id: "e1", from: "read", to: "write", kind: "seq" }],
};

/** A graph that declares a capability an unflagged workspace does not hold, so it cannot compile. */
const UNCOMPILABLE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "needs-net", project: "lane-p", version: 1 },
  policy: { posture: "out", capabilities: ["net:fetch"], budget: { costUsd: 1 } },
  channels: { url: { type: "string", reduce: "replace" }, body: { type: "object", reduce: "replace" } },
  inputs: ["url"],
  outputs: ["body"],
  nodes: [
    {
      id: "get",
      type: "tool",
      reads: ["url"],
      writes: ["body"],
      unhandled: true,
      tool: { name: "net.fetch", version: "1.0", args: { url: "${url}" } },
    },
  ],
  edges: [],
};

/**
 * A graph that compiles only with a flag this file's other invocations of `run()` omit — so the
 * SAME bytes, the SAME hash, compile under one CLI invocation and refuse under another. `proc:exec`
 * over `--allow-exec`, rather than `net:fetch` over `--egress`, because a granted `proc.exec` still
 * GATES before it ever spawns anything (irreversible tools gate once, before the first call) — so
 * `run()` reaches `awaiting_gate` with no child process started and no network touched.
 */
const SOLE_CANDIDATE = {
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "sole-candidate", project: "lane-p", version: 1 },
  policy: { posture: "out", capabilities: ["proc:exec"], expansion: { maxNodes: 4, maxDepth: 1, maxFanout: 2, maxLoopIterations: 1 } },
  channels: { seed: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["seed"],
  outputs: ["out"],
  nodes: [
    {
      id: "x",
      type: "tool",
      reads: ["seed"],
      writes: ["out"],
      unhandled: true,
      tool: { name: "proc.exec", version: "1.0", args: { command: "echo", args: ["hi"] } },
    },
  ],
  edges: [],
};

function workspace(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-lane-p-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  writeFileSync(join(dir, "graphs", "copy.json"), JSON.stringify(GRAPH));
  writeFileSync(join(dir, "input.txt"), "hello");
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * One CLI invocation, IN A CHILD PROCESS — deliberately not the in-process capture helper
 * `cli.test.ts` uses.
 *
 * That helper replaces `process.stdout.write` for the duration of a call, and `node --test`'s
 * reporter writes its own results through the same function. Measured on a four-test probe whose
 * only content was the hijack: `tests 4` became `ℹ tests 1`, and with one of the four failing the
 * run still exits 1 but names the FILE rather than the test — so a red assertion is detected and
 * undiagnosable. This file drives the real entry point instead, which is also the door an operator
 * uses, and gets the exit code from the process rather than from a return value.
 */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  return await new Promise((resolve) => {
    execFile(process.execPath, [CLI_SRC, ...argv], { cwd: dirname(CLI_SRC), timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1), out: stdout, err: stderr });
    });
  });
}

// ── stop it, from a supervisor ───────────────────────────────────────────────

test("SIGTERM STOPS THE PLANE THE WAY CTRL-C DOES — it is the signal every supervisor sends", async () => {
  // SIGINT is the control, and it has to be here: a test that only drove SIGTERM would pass on a
  // handler that answered SIGTERM and had stopped answering SIGINT.
  //
  // THE HANDLER IS CALLED, NOT `process.emit`. `node --test` installs its own SIGINT handler and
  // treats the signal as "the operator interrupted the suite" — emitting one here silently
  // removed two tests from the run's report. Taking the listener off the emitter and invoking it
  // is what the emitter would do, and it also asserts the thing the defect was about: that a
  // listener for THIS signal was registered at all.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    let closed = 0;
    let stopped = 0;
    const before = { SIGINT: process.listeners("SIGINT"), SIGTERM: process.listeners("SIGTERM") };
    const settled = serveUntilInterrupt(
      {
        close: async () => {
          closed++;
        },
      },
      {
        stop: () => {
          stopped++;
        },
      },
    );
    const added = process.listeners(signal).filter((l) => !before[signal].includes(l));
    assert.equal(added.length, 1, `serveUntilInterrupt must register exactly one ${signal} listener`);
    (added[0] as () => void)();
    const code = await settled;
    assert.equal(code, 0, `${signal} must return the clean-shutdown code`);
    assert.equal(closed, 1, `${signal} must close the plane`);
    assert.equal(stopped, 1, `${signal} must stop the clocks`);
    // BOTH listeners are removed whichever fired: a SIGINT arriving after a SIGTERM has settled
    // would otherwise close a plane that is already closed and resolve a promise nobody holds.
    assert.deepEqual(process.listeners("SIGTERM"), before.SIGTERM, "no SIGTERM listener may be left behind");
    assert.deepEqual(process.listeners("SIGINT"), before.SIGINT, "no SIGINT listener may be left behind");
  }
});

// ── stop it, from the keyboard ───────────────────────────────────────────────

test("`loom run` SAYS THE RUN ID BEFORE IT DRIVES, so an interrupt cannot lose the run", async () => {
  const d = workspace();
  try {
    const r = await run(["run", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(r.code, 0, r.err);
    const id = (JSON.parse(r.out) as { runId: string }).runId;
    // On stderr, because stdout carries a JSON document callers pipe.
    assert.match(r.err, new RegExp(`run ${id} — inspect it with: loom trace ${id}`), `the id must be announced on stderr:\n${r.err}`);
    // BEFORE the projection: the whole point is that the id exists on screen while the run is
    // still in flight. stdout and stderr are two streams, so the ordering is asserted where it
    // can be — the announcement is written by the `submitted` callback, which runs between
    // `submit` and the first `advance`, and `loom trace` proves the id it printed is real.
    const t = await run(["trace", id, "--workspace", d.dir]);
    assert.equal(t.code, 0, `the announced id must be one the CLI can look up:\n${t.err}`);
  } finally {
    d.dispose();
  }
});

// ── refusing is cheap ────────────────────────────────────────────────────────

test("A REFUSAL AFTER `startMcp` CLOSES THE CHILDREN — every config typo used to leak one", async () => {
  const d = workspace();
  const pidFile = join(d.dir, "child.pid");
  // A minimal stdio MCP server that records its pid and then idles forever. It answers the
  // handshake so `startMcp` gets as far as spawning something real.
  writeFileSync(
    join(d.dir, "server.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
    else if (msg.method === "tools/list") reply(msg.id, { tools: [] });
    else if (msg.id !== undefined) reply(msg.id, {});
  }
});
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }
setInterval(() => {}, 1 << 30);
`,
    "utf8",
  );
  writeFileSync(
    join(d.dir, "mcp.json"),
    JSON.stringify({ servers: [{ name: "probe", command: process.execPath, args: [join(d.dir, "server.mjs")], envAllow: ["PATH", "HOME"] }] }),
  );
  try {
    // A MODELS FILE WHOSE CONTENT IS WRONG, and the choice of refusal is the whole setup here.
    // This used to drive `--max-parallelism 0`, which was one of `openWorkspace`'s refusals and
    // therefore fired after the children were spawned. TODO.md §H.12 moved every refusal a flag's
    // VALUE can decide to the door, which runs before `startMcp` — so that argv now refuses with
    // nothing spawned, and the test would have proved nothing while still passing its first two
    // assertions.
    //
    // WHAT STILL REFUSES AFTER `startMcp` is everything in `main`'s try block that is not a flag
    // value: `loadExtensionModules`' `await import()`, and inside `openWorkspace` the two content
    // reads (`readChannels`, `readModels`), the three `mkdirSync`s, `new SqliteStateStore`, and
    // every construction after it. This drives the second, because it is the cheapest one to make
    // fail on purpose — and the door has already agreed the PATH is well formed, so the refusal
    // is provably past it.
    writeFileSync(join(d.dir, "models.json"), "{ not json");
    const r = await run([
      "compile",
      join(d.dir, "graphs", "copy.json"),
      "--workspace",
      d.dir,
      "--mcp-file",
      join(d.dir, "mcp.json"),
      "--models-file",
      join(d.dir, "models.json"),
    ]);
    assert.equal(r.code, 1, `the refusal itself is unchanged:\n${r.err}`);
    // THE SPECIFIC REFUSAL, not any `E_CONFIG_INVALID`. A bare code would be satisfied by the
    // door refusing one of the flags on this line — which is precisely the thing that would make
    // this test stop spawning a child and stop proving anything.
    assert.match(r.err, /E_CONFIG_INVALID: --models-file .*models\.json: .*JSON/, r.err);
    assert.equal(existsSync(pidFile), true, "the child must actually have been spawned, or this proves nothing");
    const pid = Number(readFileSync(pidFile, "utf8"));
    // An ABSOLUTE bound with an order-of-magnitude margin on a process that has already had its
    // stdin closed: the close is synchronous in `main`'s catch, and the kernel reaps within
    // milliseconds. Never a ratio of two timings.
    const gone = await waitForExit(pid, 3000);
    assert.equal(gone, true, `MCP child ${pid} was still running after the refusal — every config typo leaks one`);
  } finally {
    d.dispose();
  }
});

/** True once `pid` is no longer a live process, or false at the deadline. */
async function waitForExit(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      return false;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ── describe what you want ───────────────────────────────────────────────────

test("AN UNDECLARED `--input` CHANNEL IS REFUSED BEFORE THE RUN, naming the key the operator typed", async () => {
  const d = workspace();
  try {
    const bad = await run(["run", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--input", '{"sorce":"input.txt"}']);
    assert.equal(bad.code, 1, `a typo'd channel must be refused, not run:\n${bad.err}`);
    assert.match(bad.err, /E_CONFIG_INVALID/, bad.err);
    // The key they TYPED, not the one that is missing — the old message named `source`, a
    // channel the operator never wrote, and classed the whole thing `E_INTERNAL`.
    assert.ok(bad.err.includes('"sorce"'), `the refusal must name the key that was typed:\n${bad.err}`);
    assert.ok(bad.err.includes('did you mean "source"'), `and the nearest declared one:\n${bad.err}`);
    assert.ok(bad.err.includes('It declares "source"'), `and the declared set:\n${bad.err}`);
    assert.doesNotMatch(bad.err, /E_INTERNAL/, "a caller's typo is not an internal error");
    // AND NOTHING WAS SUBMITTED. The refusal is worth having because it costs no journal row and
    // — against a real provider — no money; a warning would not have that property. The journal
    // FILE exists either way, because `openWorkspace` creates it at boot; what must be empty is
    // the set of runs in it.
    const db = new DatabaseSync(join(d.dir, ".loom", "journal.db"), { readOnly: true });
    try {
      const rows = db.prepare("select count(*) as n from journal where type = 'run.submitted'").get() as { n: number };
      assert.equal(rows.n, 0, "a refused --input must not have opened a run");
    } finally {
      db.close();
    }

    // THE ORDINARY HALF. The honest spelling still runs, and an input the graph declares is not
    // narrowed by this check.
    const ok = await run(["run", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(ok.code, 0, ok.err);
    assert.equal((JSON.parse(ok.out) as { status: string }).status, "succeeded", ok.out);
  } finally {
    d.dispose();
  }
});

// ── trust what it did ────────────────────────────────────────────────────────

test("A DIAGNOSTIC STILL NAMES ITS FILE ON A DOOR THE OPERATOR OPENED, AND THE BY-HASH SWEEP BEHIND `trace` IS SILENT ABOUT ONE IT DID NOT — TODO.md §A.91", async () => {
  const d = workspace();
  try {
    writeFileSync(join(d.dir, "graphs", "needs-net.json"), JSON.stringify(UNCOMPILABLE));

    // ── the earlier fix, still true: a graph the operator NAMED is narrated loudly ──────────────
    // `loom compile` on `needs-net.json` directly is exactly the door attribution was fixed for —
    // this file, given no capability to compile it, still fails with every diagnostic naming it.
    const c = await run(["compile", join(d.dir, "graphs", "needs-net.json"), "--workspace", d.dir]);
    assert.notEqual(c.code, 0, `an explicit compile of a broken graph must still refuse:\n${c.out}${c.err}`);
    assert.match(c.err, /GRAPH017_CAPABILITY_NOT_GRANTED/, `an explicit compile must still report what would not compile:\n${c.err}`);
    // EVERY diagnostic line carries the file it came from. Asserting on the whole set rather than
    // on one line is the point: the earlier defect was that a reader could not tell which file ANY
    // of them belonged to.
    const named = c.err.split("\n").filter((l) => /^[✗!] /.test(l));
    assert.ok(named.length > 0, `expected diagnostics on stderr:\n${c.err}`);
    for (const line of named) {
      assert.match(line, /^[✗!] [\w.-]+\.(json|ya?ml): /, `every diagnostic must name its file, not just its code: ${line}`);
    }

    // ── the row this test now pins: a graph the operator did NOT name stays off stderr ──────────
    const r = await run(["run", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(r.code, 0, r.err);
    const id = (JSON.parse(r.out) as { runId: string }).runId;

    // `trace` resolves the run's graph by HASH, which sweeps every file in `graphs/` — including
    // `needs-net.json` — to find it. Before §A.91 closed, that sweep's own diagnostics reached
    // stderr for every candidate it rejected, attributed or not; the sweep is an internal question
    // ("which of these files is this run's graph") and its answer belongs to nobody but the search.
    const t = await run(["trace", id, "--workspace", d.dir]);
    assert.equal(t.code, 0, t.err);
    assert.doesNotMatch(
      t.err,
      /GRAPH017_CAPABILITY_NOT_GRANTED|needs-net\.json/,
      `a candidate the operator did not name leaked onto stderr:\n${t.err}`,
    );
    // AND IT STILL SAYS WHAT IT FOUND — silence is about the REJECTED candidate, not the resolved
    // one.
    assert.match(t.err, /graph copy-file v1/, `trace must still say which graph it resolved:\n${t.err}`);
  } finally {
    d.dispose();
  }
});

test("SILENCE DOES NOT HIDE THE REASON WHEN THE ONLY CANDIDATE IS THE ONE THAT WOULD HAVE MATCHED", async () => {
  // §A.91's fix makes the by-hash sweep silent about a REJECTED candidate. The question this test
  // answers: when the run's OWN graph is the one that now fails to compile — the same bytes, same
  // hash, a capability this invocation was not given — does the operator still learn why, or does
  // "silent about rejected candidates" also swallow the one case where the rejected candidate WAS
  // the answer? It does not: `indexGraphs` catches the compile failure into its own `failed` list
  // independently of `silent` (`silent` only gates the raw `writeDiagnostic` lines), and every
  // caller's own "not found" message already reports `failed` regardless.
  const d = mkdtempSync(join(tmpdir(), "loom-lane-p-sole-"));
  try {
    mkdirSync(join(d, "graphs"), { recursive: true });
    writeFileSync(join(d, "graphs", "sole.json"), JSON.stringify(SOLE_CANDIDATE));

    // Compiles and gates — `--allow-exec` grants `proc:exec` for THIS invocation only, and the
    // tool never actually runs: an irreversible tool gates once before its first call.
    const started = await run(["run", join(d, "graphs", "sole.json"), "--workspace", d, "--input", '{"seed":"hi"}', "--allow-exec", "echo"]);
    assert.equal(started.code, 0, started.err);
    const id = (JSON.parse(started.out) as { runId: string; status: string }).runId;
    assert.equal((JSON.parse(started.out) as { status: string }).status, "awaiting_gate", "the fixture must gate for this to mean anything");

    // A LATER INVOCATION, NO `--allow-exec`. Same file, same bytes, same hash — the only candidate
    // in `graphs/` — and it no longer compiles here.
    const traced = await run(["trace", id, "--workspace", d]);
    assert.notEqual(traced.code, 0, `trace must refuse when it cannot resolve a graph:\n${traced.out}${traced.err}`);
    assert.match(
      traced.err,
      /GRAPH017_CAPABILITY_NOT_GRANTED/,
      `the ONLY candidate failing to compile must still explain why, not just that nothing resolved:\n${traced.err}`,
    );

    const approved = await run(["approve", id, "does-not-matter", "--as", "u:alice", "--workspace", d]);
    assert.notEqual(approved.code, 0, `approve must refuse when it cannot resolve a graph:\n${approved.out}${approved.err}`);
    assert.match(
      approved.err,
      /GRAPH017_CAPABILITY_NOT_GRANTED/,
      `approve's own resolution must explain the SAME reason, not just "not found":\n${approved.err}`,
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

// ── install it ───────────────────────────────────────────────────────────────

test("THE CLI RUNS WHEN IT IS REACHED THROUGH A SYMLINK", async () => {
  // npm writes `node_modules/.bin/loom` as a SYMLINK on POSIX, so `argv[1]`'s basename is "loom"
  // while the module's own URL ends in "cli". The entry-point test used to compare those two
  // strings, so while `bin` pointed at `dist/cli.js` an installed `loom --help` printed NOTHING
  // and exited 0 — "Install it", the goal's first two words, failing in silence. `bin` is
  // `dist/bin.js` now and `node-floor.test.ts` drives THAT link; a link straight to `cli` is still
  // a way to start it, and this keeps it one.
  //
  // The link is named `.ts` so Node type-strips it exactly as it does the real file; the
  // basename still differs, which is the whole condition under test.
  const d = mkdtempSync(join(tmpdir(), "loom-lane-p-bin-"));
  try {
    const link = join(d, "loom-as-installed.ts");
    symlinkSync(CLI_SRC, link);
    const { stdout, code } = await node([link, "--help"], dirname(CLI_SRC));
    assert.equal(code, 0, "a symlinked entry point must exit 0");
    assert.match(stdout, /loom — graph-native multi-agent orchestration/, `--help must print the usage, and printed:\n${JSON.stringify(stdout)}`);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

/** Run node with `args`, offline, and collect what it said. */
async function node(args: string[], cwd: string): Promise<{ stdout: string; code: number }> {
  return await new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, timeout: 30_000 }, (err, stdout) => {
      resolve({ stdout, code: err === null ? 0 : ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) });
    });
  });
}
