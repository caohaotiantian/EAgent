/**
 * THE TESTS THIS PROJECT CANNOT WRITE ANYWHERE ELSE: restart, scale, and a second plane.
 *
 * Every other suite here is in-process, single-run and small-N — 2,283 of them, measured
 * `npm test` (2,288) minus this directory's own five. Excellent inside that boundary and
 * blind outside it. The audit's structural finding is that every surviving defect class
 * lives outside it: a value that only a RESTART re-derives, a window that only shows itself
 * past `limit` runs, a set two call sites compute differently.
 *
 * So this directory is the instrument, and it is built out of four moves:
 *
 *   - **A REAL WORKSPACE ON DISK.** `openWorkspace` on a temp dir — the same function
 *     `bin/loom` calls — so the journal is the SQLite one, the graph index is the real
 *     `graphs/` directory, and the compiled graph hash is the one the product computes.
 *   - **A RESTART** is `close()` plus a second `openWorkspace` over the same directory: a new
 *     `Engine`, a new `HumanGateBroker`, a new SQLite handle, folding the same journal.
 *     WHAT THAT DOES NOT COVER, stated rather than implied: it is one OS process, so it
 *     cannot catch anything that lives in module state shared between the two planes, in the
 *     SQLite connection's own cache, or in an exit path (`process.on("exit")`, an unflushed
 *     WAL). A defect of that shape needs a spawned `loom`, which is the fourth move.
 *   - **A REAL OS PROCESS, AND A SECOND ADDRESS.** `serving` spawns `node src/cli.ts serve`
 *     and reads the address back out of the child's own banner; `refusing` spawns one that
 *     must END BY ITSELF; `reach` dials a real socket; `secondAddress` finds an address this
 *     machine can bind that is NOT 127.0.0.1, by binding rather than by trusting an
 *     interface list. All four were earned in `test/cli/serve-host.test.ts` and are here
 *     because two files owning the same platform probe is how the two answers drift — and
 *     because the reaper under them, which that file costed at a four-minute hang, must
 *     exist exactly once.
 *   - **SCALE WITHOUT PATIENCE.** `fillRuns` appends run heads straight to the store. A
 *     window bug is about how many rows a listing has to choose between, and 201 real runs
 *     would buy the same coverage for a hundred times the wall clock. Filler runs hold one
 *     `run.submitted` each and never gate, which is exactly the traffic that pushes a gated
 *     run out of an unfiltered window.
 *
 * OFFLINE AND DETERMINISTIC, per CLAUDE.md, and the three places that could have broken it:
 * no channel is configured (delivery would be a webhook, i.e. the network), no assertion
 * reads the wall clock — the sweep is driven at an instant DERIVED from the journaled raise —
 * and every address `serving`/`reach` touch is one THIS machine answers on. The deadlines in
 * the spawned half are failure deadlines, never measurements: nothing here asserts how fast
 * anything is, and the deadline exists only because a test that drives a real socket and a
 * real child fails by HANGING, which reports less than no test at all.
 */

import { after } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createSocket } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openWorkspace, parseArgs } from "../../src/cli.ts";
import { newGateId, newRunId, type NodeId, type RunId } from "../../src/ids.ts";
import type { StateStore } from "../../src/journal/store.ts";

export type Plane = ReturnType<typeof openWorkspace>;

export interface Deployment {
  readonly dir: string;
  /** Boot a plane over this directory. Call it twice and you have restarted. */
  open(): Plane;
  dispose(): void;
}

export function deployment(): Deployment {
  const dir = mkdtempSync(join(tmpdir(), "loom-deployment-"));
  mkdirSync(join(dir, "graphs"), { recursive: true });
  return {
    dir,
    // `serve` is the command whose clocks this directory exists to test; `openWorkspace`
    // reads flags only, so the verb is documentation.
    open: () => openWorkspace(parseArgs(["serve", "--workspace", dir])),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Put a graph where `discoverGraphs` and `graphsByHash` will find it after a restart. */
export function publishGraph(d: Deployment, name: string, spec: unknown): string {
  const file = join(d.dir, "graphs", `${name}.json`);
  writeFileSync(file, JSON.stringify(spec, null, 2));
  return file;
}

/**
 * `count` run heads, newer than `sinceTs`, that never raise a gate.
 *
 * Run ids are ULIDs, so a later timestamp sorts ABOVE an earlier one — which is what
 * `ORDER BY run_id DESC` reads, and therefore what a run has to be pushed out of.
 */
export async function fillRuns(store: StateStore, count: number, sinceTs: number): Promise<readonly RunId[]> {
  const ids: RunId[] = [];
  for (let i = 0; i < count; i++) {
    const ts = sinceTs + 1 + i;
    const runId = newRunId(ts);
    await store.append({
      runId,
      expectedSeq: 0,
      now: ts,
      events: [
        {
          type: "run.submitted",
          payload: {
            workflow: "filler",
            graphHash: "sha256:filler",
            inputs: {},
            idempotencyKey: `filler-${i}`,
            configDigest: "sha256:filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
      ],
    });
    ids.push(runId);
  }
  return ids;
}

/** Every event type on a run's journal, in order. The evidence most of these tests assert on. */
export async function journalTypes(store: StateStore, runId: RunId): Promise<readonly string[]> {
  const types: string[] = [];
  for await (const e of store.read(runId, 1)) types.push(e.type);
  return types;
}

/**
 * Run something that writes to the terminal without writing to the terminal.
 *
 * `main` is the door these tests drive on purpose — it is the product — and it prints a
 * run summary. Captured rather than suppressed: a failing test wants the output, and the
 * returned lines are what a test asserts on when the CLI's own words are the claim.
 */
export async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    out += String(chunk);
    return true;
  };
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    err += String(chunk);
    return true;
  };
  try {
    return { value: await fn(), out, err };
  } finally {
    (process.stdout as { write: unknown }).write = realOut;
    (process.stderr as { write: unknown }).write = realErr;
  }
}

/**
 * `count` run heads that HAVE raised a gate, newer than `sinceTs` — the traffic that pushes
 * an older gate out of `{ raisedAGate: true }`.
 *
 * `fillRuns` cannot do this job. Its runs never gate, so they never compete for a slot in the
 * gated listing, and a test built on them measures the FILTER rather than the window behind
 * it. The gate clock's window is 500 GATED runs (`GATE_CLOCK_LIMIT`); the only way past it is
 * more than 500 gates.
 *
 * The gate is journaled, not raised: `listRuns(_, { raisedAGate: true })` orders by
 * `MAX(ts)` over the `gate.raised` rows and nothing here needs a broker, a graph, or a
 * `DeliverySpec`. Both events carry `ts` explicitly, so the ordering these runs establish is
 * derived from `sinceTs` and never from the wall clock.
 */
export async function fillGatedRuns(store: StateStore, count: number, sinceTs: number): Promise<readonly RunId[]> {
  const ids: RunId[] = [];
  for (let i = 0; i < count; i++) {
    const ts = sinceTs + 1 + i;
    const runId = newRunId(ts);
    await store.append({
      runId,
      expectedSeq: 0,
      now: ts,
      events: [
        {
          type: "run.submitted",
          payload: {
            workflow: "gated-filler",
            graphHash: "sha256:gated-filler",
            inputs: {},
            idempotencyKey: `gated-filler-${i}`,
            configDigest: "sha256:gated-filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
        {
          type: "gate.raised",
          payload: {
            gateId: newGateId(ts),
            nodeId: "approve" as NodeId,
            policyRef: "oversight/ship@stable",
            contentDigest: "sha256:gated-filler",
          },
          actor: { kind: "system", component: "deployment-harness" },
        },
      ],
    });
    ids.push(runId);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The fourth move: a real OS process, and a second address.
//
// Hoisted verbatim out of `test/cli/serve-host.test.ts`, which earned every paragraph
// below. That file now imports them from here. The reason to move rather than copy is the
// reaper: a second `spawned` set is a second set nobody drains.
// ---------------------------------------------------------------------------

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

/**
 * EVERY CHILD THIS HARNESS SPAWNS, so none of them can outlive the run.
 *
 * Not tidiness. An assertion that throws between `serving(...)` and its `stop()` leaves a
 * `loom serve` holding a temp workspace with nobody who knows its pid — and `serve-host`'s
 * own mutation sweep is what proved it: two mutations that should have gone red in fifty
 * seconds reported HUNG at four minutes, because the orphans from the previous mutation were
 * still running. A leaked process does not fail a test; it taxes every later run, silently.
 * `cli.test.ts` records the same lesson costed at 917 seconds.
 *
 * The `try`/`finally` in each test is still the primary mechanism; this is the net under it.
 */
const spawned = new Set<ChildProcess>();
after(() => {
  for (const c of spawned) c.kill("SIGKILL");
});
process.on("exit", () => {
  for (const c of spawned) c.kill("SIGKILL");
});

/** A bare temp directory — the workspace a spawned `loom serve` creates the rest of for itself. */
export function scratchWorkspace(prefix = "loom-host-"): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

async function bindable(addr: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const s = createSocket();
    s.once("error", () => resolve(false));
    s.listen(0, addr, () => s.close(() => resolve(true)));
  });
}

/**
 * An address THIS MACHINE can bind that is not `127.0.0.1`, or `undefined`.
 *
 * Needed because "the flag reached the socket" is only checkable against a SECOND address:
 * on `0.0.0.0` a connection to 127.0.0.1 succeeds exactly as it would on a loopback bind,
 * so that pair cannot tell a working `--host` from a `--host` that was parsed and dropped.
 *
 * PROBED BY BINDING, never by trusting the interface list — `127.0.0.2` is in no list here
 * and is `EADDRNOTAVAIL` on macOS while it binds fine on Linux, which is precisely the kind
 * of platform difference a test must not assume its way through.
 *
 * Preference order is deliberate: a non-internal IPv4 first, because that is the case the
 * defect is about (an address something off this machine could route to), and `::1` second
 * as the loopback-but-not-127.0.0.1 fallback for a container with no such interface.
 */
export async function secondAddress(): Promise<string | undefined> {
  const candidates: string[] = [];
  for (const rows of Object.values(networkInterfaces())) {
    for (const a of rows ?? []) {
      // Link-local IPv6 (`fe80::…`) needs a scope id to dial and is skipped: an address a
      // test cannot reliably CONNECT to proves nothing about a bind.
      if (!a.internal && a.family === "IPv4") candidates.push(a.address);
    }
  }
  candidates.push("::1");
  for (const c of candidates) if (await bindable(c)) return c;
  return undefined;
}

/** `http://host:port` — bracketed when the host is IPv6, which is not optional in a URL. */
export function origin(host: string, port: number): string {
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

/**
 * A real HTTP round trip to a real socket. Resolves the status, or the errno that stopped it.
 *
 * **`AbortSignal.timeout` AND NOT `req.setTimeout`, and this cost a 600-second hang.** The
 * mutation "`httpHost` parses the flag and drops it" is one `serve-host.test.ts` exists to
 * catch: the plane then binds 127.0.0.1 while the banner claims another address, so
 * `reach(other, …)` dials an interface address with nothing behind it. A dropped SYN — which
 * is what a non-internal interface does with a port nothing holds, as opposed to the RST
 * loopback sends — never reaches the socket-inactivity timer `req.setTimeout` arms, so the
 * request never settled, the child was never stopped, and `node --test` sat there until the
 * sweep's own 600s deadline killed it. `cli.test.ts` already states the rule this broke: a
 * test that HANGS under the mutation it is meant to catch is worse than one that passes. The
 * signal aborts the request whatever phase it is in, connect included.
 */
export async function reach(host: string, port: number, token?: string): Promise<{ status?: number; error?: string }> {
  return await new Promise((resolve) => {
    const req = httpRequest(
      `${origin(host, port)}/health`,
      {
        method: "GET",
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(4_000),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode === undefined ? {} : { status: res.statusCode }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

/**
 * A JSON round trip to a spawned plane — the door a second host answers a gate through.
 *
 * `reach` is deliberately not generalised into this: it asserts on an errno as much as on a
 * status, and its whole subject is `/health` on a socket that may not exist. This one is for
 * a request that IS expected to be answered, and it hands back the body because the answer
 * is the claim.
 */
export async function speak(
  url: string,
  init: { method: string; token?: string; body?: unknown },
): Promise<{ status?: number; body: string; error?: string }> {
  return await new Promise((resolve) => {
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      url,
      {
        method: init.method,
        headers: {
          ...(init.token === undefined ? {} : { authorization: `Bearer ${init.token}` }),
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        signal: AbortSignal.timeout(10_000),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ body: "", error: e.code ?? e.message }));
    req.end(payload);
  });
}

export interface Serving {
  readonly out: string;
  readonly err: string;
  readonly host: string;
  readonly port: number;
  stop(): Promise<number | null>;
}

/** `loom serve`, booted, with the address it ANNOUNCED parsed back out of its own stdout. */
export async function serving(argv: readonly string[]): Promise<Serving> {
  const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  spawned.add(child);
  child.on("close", () => spawned.delete(child));
  let out = "";
  let err = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c: string) => (out += c));
  child.stderr.on("data", (c: string) => (err += c));
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  try {
    // `  clock:` and not `loom listening` — the LAST stdout line, not the first. A pipe
    // splits where it likes, so waiting on the first line returns with the rest in flight
    // and every negative assertion below would pass for the wrong reason.
    const deadline = Date.now() + 15_000;
    while (!out.includes("  clock:")) {
      if (Date.now() > deadline) throw new Error(`\`loom ${argv.join(" ")}\` never booted.\nstdout:\n${out}\nstderr:\n${err}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    const m = /loom listening on http:\/\/(\[[^\]]+\]|[^:\s]+):(\d+)/.exec(out);
    if (m?.[1] === undefined || m[2] === undefined) throw new Error(`no address line in:\n${out}`);
    return {
      get out() {
        return out;
      },
      get err() {
        return err;
      },
      host: m[1].replace(/^\[/, "").replace(/\]$/, ""),
      port: Number(m[2]),
      /**
       * SIGINT, then wait for `close` — the event that fires once every stdio pipe has
       * DRAINED. Anything asserted about `err` must be read after this: boot returns as soon
       * as stdout's last line lands, and stderr's warnings are still in flight at that point.
       * Measured — an assertion on `err` before `stop()` saw the empty string.
       */
      stop: async () => {
        child.kill("SIGINT");
        return await exited;
      },
    };
  } catch (e) {
    // Anything thrown before the return leaves a `loom serve` holding a temp workspace with
    // nobody who knows its pid. `cli.test.ts` records what one such orphan cost.
    child.kill("SIGKILL");
    throw e;
  }
}

/** `loom …`, expected to END BY ITSELF, non-zero, having bound nothing. */
export async function refusing(argv: readonly string[]): Promise<{ code: number | null; err: string }> {
  const child = spawn(process.execPath, [CLI, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
  spawned.add(child);
  child.on("close", () => spawned.delete(child));
  let err = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c: string) => (err += c));
  const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
  const timer = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`\`loom ${argv.join(" ")}\` never exited — it must refuse BEFORE it binds anything`)), 15_000).unref();
  });
  try {
    return { code: await Promise.race([exited, timer]), err };
  } finally {
    child.kill("SIGKILL");
  }
}

/**
 * Poll for a JOURNALED FACT under a FAILURE deadline.
 *
 * The rule this keeps: no `sleep`, and no assertion whose truth depends on elapsed time. A
 * fixed sleep is either flaky or slow and is never evidence. The deadline here is not a
 * measurement — nothing asserts on how long the probe took — it is the point at which the
 * test gives up and SAYS SO, in `what`'s own words, instead of hanging.
 */
export async function until<T>(what: string, deadlineMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const giveUp = Date.now() + deadlineMs;
  for (;;) {
    const got = await probe();
    if (got !== undefined) return got;
    if (Date.now() > giveUp) throw new Error(`gave up after ${deadlineMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
