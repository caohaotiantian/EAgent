/**
 * The workspace the CLI hands to the built-in tools.
 *
 * `openWorkspace` decides three things at once: where the journal lives, what the tool
 * jail's root is, and which capabilities are granted. For a long time it decided them
 * so that the second contained the first — the model's own `fs.write` could reach the
 * only authoritative durable state there is. These tests are about that seam, and they
 * live next to `cli/cli.test.ts` rather than inside it because they are one claim, made
 * end to end through the real `main()`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { main, openWorkspace, parseArgs } from "../src/cli.ts";
import type { RunId } from "../src/ids.ts";

function emptyDir(): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "loom-jail-cli-"));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A graph whose only node writes wherever the caller says. */
function graphWriting(path: string): Record<string, unknown> {
  return {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "clobber", project: "demo", version: 1 },
    policy: { posture: "out", capabilities: ["fs:read", "fs:write"] },
    channels: { seed: { type: "string", reduce: "replace" }, written: { type: "object", reduce: "replace" } },
    inputs: ["seed"],
    outputs: ["written"],
    nodes: [
      {
        id: "write",
        type: "tool",
        reads: ["seed"],
        writes: ["written"],
        tool: { name: "fs.write", version: "1.0", args: { path, body: "clobbered" } },
        unhandled: true,
      },
    ],
    edges: [],
  };
}

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

test("A RUN CANNOT WRITE TO ITS OWN JOURNAL — the data dir is inside the jail root", async () => {
  // `--workspace` is both the fs jail and the parent of `.loom/journal.db`, and
  // `fs.write` is `reversible_write`, so no gate stands between a model and the run's
  // own source of truth. Before the deny-list this run reported success and the journal
  // was destroyed: a second process opening it answered
  // `ERR_SQLITE_ERROR: database disk image is malformed`.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "clobber.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting(".loom/journal.db")));

    const first = await run(["run", graphFile, "--workspace", d.dir, "--input", JSON.stringify({ seed: "x" })]);
    const parsed = JSON.parse(first.out) as { status: string; runId: string; error?: { code?: string } };
    assert.equal(parsed.status, "failed", `the write must not succeed: ${first.out}`);

    // The journal is intact, which is the claim that actually matters: a second process
    // reads the run back, including the failure that was just recorded.
    const header = readFileSync(join(d.dir, ".loom", "journal.db")).subarray(0, 15).toString("utf8");
    assert.equal(header, "SQLite format 3", "the journal file is still a database");

    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const p = await ws.engine.projection(parsed.runId as RunId);
      assert.equal(p?.status, "failed");
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("`--data-dir` moves the denial with it, wherever the operator puts the journal", async () => {
  // The deny-list is derived from the data dir that was actually chosen, so pointing
  // `--data-dir` at a directory INSIDE the workspace is safe rather than a foot-gun.
  const d = emptyDir();
  try {
    mkdirSync(join(d.dir, "graphs"), { recursive: true });
    const graphFile = join(d.dir, "graphs", "clobber.json");
    writeFileSync(graphFile, JSON.stringify(graphWriting("state/journal.db")));

    const r = await run([
      "run",
      graphFile,
      "--workspace",
      d.dir,
      "--data-dir",
      join(d.dir, "state"),
      "--input",
      JSON.stringify({ seed: "x" }),
    ]);
    const parsed = JSON.parse(r.out) as { status: string };
    assert.equal(parsed.status, "failed", r.out);
    const header = readFileSync(join(d.dir, "state", "journal.db")).subarray(0, 15).toString("utf8");
    assert.equal(header, "SQLite format 3");
  } finally {
    d.dispose();
  }
});

test("the journal cannot be READ back out through the tools either", async () => {
  // The other direction of the same hole: `fs.read` of the journal returns whatever was
  // ever journaled — including a secret that arrived as a run input — into a channel and
  // into the model's context, past every redaction the event path applies.
  const d = emptyDir();
  try {
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      const read = ws.engine.tools.list().find((t) => t.name === "fs.read")!;
      await assert.rejects(
        async () =>
          read.execute(
            { path: ".loom/journal.db", maxBytes: 100_000_000 },
            { taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} },
          ),
        (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
      );
    } finally {
      ws.close();
    }
  } finally {
    d.dispose();
  }
});

test("a symlink planted in the workspace does not reopen either hole", async () => {
  // The precondition for the symlink escape is a pre-existing link in the workspace —
  // and the workspace defaults to the process's cwd, i.e. a directory whose contents
  // nobody audited. `link -> .loom` defeats a deny-list that resolves lexically.
  const d = emptyDir();
  const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
  try {
    const ws = openWorkspace(parseArgs(["gates", "--workspace", d.dir]));
    try {
      symlinkSync(join(d.dir, ".loom"), join(d.dir, "link"));
      symlinkSync(outside, join(d.dir, "out"));
      writeFileSync(join(outside, "secret.txt"), "not yours");

      const tools = ws.engine.tools;
      const call = (name: string, args: Record<string, unknown>): Promise<unknown> =>
        tools.list().find((t) => t.name === name)!.execute(args, {
          taskId: "t@root#0" as never,
          signal: new AbortController().signal,
          progress: () => {},
        }) as Promise<unknown>;

      await assert.rejects(async () => call("fs.write", { path: "link/journal.db", body: "x" }), /which this sandbox denies/);
      await assert.rejects(async () => call("fs.read", { path: "out/secret.txt" }), /escapes the sandbox root/);
      await assert.rejects(async () => call("fs.write", { path: "out/planted.txt", body: "x" }), /escapes the sandbox root/);
      assert.equal(existsSync(join(outside, "planted.txt")), false);
    } finally {
      ws.close();
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    d.dispose();
  }
});
