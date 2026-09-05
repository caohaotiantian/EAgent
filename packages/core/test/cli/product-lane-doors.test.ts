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
 *     about an unrelated graph above a successful approval and exited 0.
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
    // `--max-parallelism 0` is one of `openWorkspace`'s eight refusals, and it fires AFTER the
    // children are spawned. Any of the others would do; this one needs no filesystem setup.
    const r = await run(["compile", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--mcp-file", join(d.dir, "mcp.json"), "--max-parallelism", "0"]);
    assert.equal(r.code, 1, `the refusal itself is unchanged:\n${r.err}`);
    assert.match(r.err, /E_CONFIG_INVALID: --max-parallelism/, r.err);
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

test("A COMPILE DIAGNOSTIC NAMES ITS FILE — an unattributed ✗ above a successful approval teaches an operator to ignore stderr", async () => {
  const d = workspace();
  try {
    writeFileSync(join(d.dir, "graphs", "needs-net.json"), JSON.stringify(UNCOMPILABLE));
    const r = await run(["run", join(d.dir, "graphs", "copy.json"), "--workspace", d.dir, "--input", '{"source":"input.txt"}']);
    assert.equal(r.code, 0, r.err);
    const id = (JSON.parse(r.out) as { runId: string }).runId;

    // `trace` resolves the run's graph by scanning the whole directory, so it compiles
    // `needs-net.json` too and writes its diagnostics to stderr.
    const t = await run(["trace", id, "--workspace", d.dir]);
    assert.equal(t.code, 0, t.err);
    assert.match(t.err, /GRAPH017_CAPABILITY_NOT_GRANTED/, `the scan must still report what would not compile:\n${t.err}`);
    // EVERY diagnostic line carries the file it came from. Asserting on the whole set rather than
    // on one line is the point: the defect was that a reader could not tell which file ANY of
    // them belonged to.
    const diagnostics = t.err.split("\n").filter((l) => /^[✗!] /.test(l));
    assert.ok(diagnostics.length > 0, `expected diagnostics on stderr:\n${t.err}`);
    for (const line of diagnostics) {
      assert.match(line, /^[✗!] [\w.-]+\.(json|ya?ml): /, `every diagnostic must name its file, not just its code: ${line}`);
    }
  } finally {
    d.dispose();
  }
});

// ── install it ───────────────────────────────────────────────────────────────

test("THE CLI RUNS WHEN IT IS REACHED THROUGH A SYMLINK, which is what `package.json`'s `bin` produces", async () => {
  // npm writes `node_modules/.bin/loom` as a SYMLINK to `dist/cli.js` on POSIX, so `argv[1]`'s
  // basename is "loom" while the module's own URL ends in "cli". The entry-point test used to
  // compare those two strings, so an installed `loom --help` printed NOTHING and exited 0 —
  // "Install it", the goal's first two words, failing in silence.
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
