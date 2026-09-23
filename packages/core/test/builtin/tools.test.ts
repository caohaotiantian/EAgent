/**
 * The built-in tools.
 *
 * Two concerns, and they pull in opposite directions. The tools must be USABLE by a
 * graph that has never heard of them — a tool cannot know a graph's channel names — and
 * they must be CONFINED, because they are the only things in the system that touch a
 * disk or a network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { builtinTools, fsRestore } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition, type ToolResult } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";

const ctx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} });

/** A ToolContext for a specific derived TaskId — `nodeId@branchPath#iteration`. */
const ctxOf = (taskId: string) => ({ taskId: taskId as never, signal: new AbortController().signal, progress: () => {} });

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-tools-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Every file under `dir`, workspace-relative, sorted. Used to assert about clobber. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

const byName = (tools: readonly ToolDefinition[], name: string): ToolDefinition =>
  tools.find((t) => t.name === name)!;

/** An `fs.read` the jail refused: an error RESULT carrying `E_CAP_DENIED`, never a throw (D8). */
function refused(r: ToolResult, why: RegExp): void {
  assert.equal(r.isError, true, r.content);
  assert.equal(r.error?.code, "E_CAP_DENIED", r.content);
  assert.match(r.content, why);
}

// ── confinement ──────────────────────────────────────────────────────────────

test("fs.read CANNOT ESCAPE THE ROOT", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root, deny: [] });
  // RETURNED, not thrown, since D8: a refusal `fs.read` throws becomes `effect.failed`, loses its
  // code at the dispatcher and cannot be replayed. The containment claim is unchanged — it is
  // refused, with the jail's code, and nothing of the target is in the answer.
  const r = await byName(tools, "fs.read").execute({ path: "../../etc/passwd" }, ctx());
  refused(r, /escapes the sandbox root/);
  assert.doesNotMatch(r.content, /root:/);
  s.cleanup();
});

test("fs.write cannot escape the root either", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root, deny: [] });
  await assert.rejects(
    async () => byName(tools, "fs.write").execute({ path: "../escape.txt", body: "x" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  s.cleanup();
});

test("a path that merely SHARES A PREFIX with the root is still outside it", async () => {
  // The classic `startsWith` bug: `/tmp/loom-abc` vs `/tmp/loom-abc-evil`. Confinement
  // is a path-relation question, not a string-prefix one.
  const s = sandbox();
  const tools = builtinTools({ root: s.root, deny: [] });
  refused(await byName(tools, "fs.read").execute({ path: "../../evil" }, ctx()), /escapes the sandbox root/);
  s.cleanup();
});

test("net.fetch is not even REGISTERED without an egress allowlist", () => {
  // Absent by construction rather than present-and-refusing: a tool that exists can be
  // named by an injected instruction, and being refused is one bug away from working.
  assert.equal(builtinTools({ root: "/tmp", deny: [] }).some((t) => t.name === "net.fetch"), false);
  assert.equal(
    builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["example.com"] }).some((t) => t.name === "net.fetch"),
    true,
  );
});

test("net.fetch refuses a host outside the allowlist", async () => {
  const tools = builtinTools({
    root: "/tmp",
    deny: [],
    egressAllowlist: ["example.com"],
    fetch: (async () => new Response("should not be reached")) as unknown as typeof fetch,
  });
  // It THROWS rather than returning an error result: an egress refusal is a capability
  // denial, and the dispatcher turns it into `effect.failed` + E6. Returning a soft
  // error would let a caller mistake it for a fetch that merely did not work.
  await assert.rejects(
    async () => byName(tools, "net.fetch").execute({ url: "https://evil.test/x" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
});

// ── the deny-list: the jail root CONTAINS the journal ────────────────────────

test("A DENIED SUBTREE IS OUT OF REACH EVEN THOUGH IT IS INSIDE THE ROOT", async () => {
  // The workspace root is the jail AND the parent of `.loom/journal.db` — the only
  // authoritative durable state there is. Containment alone therefore says yes to the
  // one write that destroys the run's own history.
  const s = sandbox();
  const data = join(s.root, ".loom");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "journal.db"), "SQLite format 3 ");
  const tools = builtinTools({ root: s.root, deny: [data] });

  for (const path of [".loom/journal.db", "./.loom/journal.db", "graphs/../.loom/journal.db", ".loom"]) {
    await assert.rejects(
      async () => byName(tools, "fs.write").execute({ path, body: "clobbered" }, ctx()),
      (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
      path,
    );
  }
  assert.equal(readFileSync(join(data, "journal.db"), "utf8"), "SQLite format 3 ");
  s.cleanup();
});

test("the deny-list covers READING too — the journal is where the redaction bypass lives", async () => {
  const s = sandbox();
  const data = join(s.root, ".loom");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "journal.db"), "canary-from-a-run-input");
  const tools = builtinTools({ root: s.root, deny: [data] });

  const r = await byName(tools, "fs.read").execute({ path: ".loom/journal.db" }, ctx());
  refused(r, /which this sandbox denies/);
  assert.doesNotMatch(r.content, /canary-from-a-run-input/);
  s.cleanup();
});

test("fs.restore is a WRITE and obeys the deny-list like the other two", async () => {
  const s = sandbox();
  const data = join(s.root, ".loom");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "journal.db"), "intact");
  await assert.rejects(
    async () => fsRestore({ root: s.root, deny: [data] }).execute({ path: ".loom/journal.db", previous: "x" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  assert.equal(readFileSync(join(data, "journal.db"), "utf8"), "intact");
  s.cleanup();
});

test("A SYMLINK DOES NOT LAUNDER A DENIED PATH — this is why the two fixes ship together", async () => {
  // `ws/link -> ws/.loom`. A deny-list checked on a LEXICALLY resolved path sees
  // `ws/link/journal.db`, which is neither the denied directory nor outside the root,
  // and lets the write through to the journal anyway.
  const s = sandbox();
  const data = join(s.root, ".loom");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "journal.db"), "intact");
  symlinkSync(data, join(s.root, "link"));
  const tools = builtinTools({ root: s.root, deny: [data] });

  await assert.rejects(
    async () => byName(tools, "fs.write").execute({ path: "link/journal.db", body: "clobbered" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  assert.equal(readFileSync(join(data, "journal.db"), "utf8"), "intact");
  s.cleanup();
});

// ── symlinks are a jail escape when the check is lexical ─────────────────────

test("fs.read CANNOT EXFILTRATE THROUGH A SYMLINK OUT OF THE JAIL", async () => {
  const s = sandbox();
  const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
  writeFileSync(join(outside, "secret.txt"), "ANTHROPIC_API_KEY=sk-not-a-real-key");
  symlinkSync(outside, join(s.root, "vendor"));
  const tools = builtinTools({ root: s.root, deny: [] });

  const r = await byName(tools, "fs.read").execute({ path: "vendor/secret.txt" }, ctx());
  refused(r, /escapes the sandbox root/);
  assert.doesNotMatch(r.content, /sk-not-a-real-key/, "a read through a symlink must not resolve to a file outside the root");
  rmSync(outside, { recursive: true, force: true });
  s.cleanup();
});

test("fs.write cannot create a file outside the jail through a symlinked directory", async () => {
  const s = sandbox();
  const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
  symlinkSync(outside, join(s.root, "vendor"));
  const tools = builtinTools({ root: s.root, deny: [] });

  await assert.rejects(
    async () => byName(tools, "fs.write").execute({ path: "vendor/planted.txt", body: "x" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  assert.equal(existsSync(join(outside, "planted.txt")), false, "nothing was created outside the root");
  rmSync(outside, { recursive: true, force: true });
  s.cleanup();
});

test("a LEAF symlink pointing out of the jail is not clobbered", async () => {
  const s = sandbox();
  const outside = mkdtempSync(join(tmpdir(), "loom-outside-"));
  writeFileSync(join(outside, "target.txt"), "original");
  symlinkSync(join(outside, "target.txt"), join(s.root, "innocent.txt"));
  const tools = builtinTools({ root: s.root, deny: [] });

  await assert.rejects(
    async () => byName(tools, "fs.write").execute({ path: "innocent.txt", body: "overwritten" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  assert.equal(readFileSync(join(outside, "target.txt"), "utf8"), "original");
  rmSync(outside, { recursive: true, force: true });
  s.cleanup();
});

test("a symlink that stays INSIDE the jail still works — the rule is the real path, not the presence of a link", async () => {
  const s = sandbox();
  mkdirSync(join(s.root, "real"), { recursive: true });
  writeFileSync(join(s.root, "real", "note.txt"), "readable");
  symlinkSync(join(s.root, "real"), join(s.root, "alias"));
  const tools = builtinTools({ root: s.root, deny: [] });

  const out = await byName(tools, "fs.read").execute({ path: "alias/note.txt" }, ctx());
  assert.equal(out.content, "readable");
  s.cleanup();
});

// ── egress: the allowlist is checked on every hop ────────────────────────────

/** A loopback server that answers exactly one way. Closed by the caller. */
async function serve(handler: (url: string) => { status: number; body: string; headers?: Record<string, string> }, host = "127.0.0.1"): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const r = handler(req.url ?? "/");
    res.writeHead(r.status, { "content-type": "text/plain", ...(r.headers ?? {}) });
    res.end(r.body);
  });
  const port = await new Promise<number>((resolvePort) => {
    server.listen(0, host, () => resolvePort((server.address() as AddressInfo).port));
  });
  return { server, port };
}

const close = (s: Server): Promise<void> => new Promise((r) => s.close(() => r()));

test("NET.FETCH DOES NOT FOLLOW A REDIRECT OFF THE ALLOWLIST", async () => {
  // The metadata-endpoint pivot, reproduced offline: an allowlisted host answers 302
  // with a `Location` on a host the operator never named. `redirect: "follow"` — the
  // default — makes the allowlist a check on the URL the model typed rather than on
  // the host the bytes come from.
  const secret = await serve(() => ({ status: 200, body: "INSTANCE-CREDENTIALS" }), "localhost");
  const front = await serve(() => ({
    status: 302,
    body: "",
    headers: { location: `http://localhost:${secret.port}/latest/meta-data/iam/` },
  }));
  try {
    const tools = builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["127.0.0.1"] });
    const r = await Promise.resolve(
      byName(tools, "net.fetch").execute({ url: `http://127.0.0.1:${front.port}/repos/x/y` }, ctx()),
    ).then((v) => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

    assert.equal(r.ok, false, `the redirect was followed and returned: ${JSON.stringify((r as { v?: unknown }).v)}`);
    assert.equal((r as { e: { code: string } }).e.code, "E_CAP_DENIED");
    assert.match((r as { e: Error }).e.message, /localhost/);
  } finally {
    await close(front.server);
    await close(secret.server);
  }
});

test("a redirect that stays ON the allowlist is followed, absolute or relative", async () => {
  const target = await serve((url) =>
    url === "/moved" ? { status: 302, body: "", headers: { location: "/final" } } : { status: 200, body: "the real body" },
  );
  const front = await serve(() => ({ status: 302, body: "", headers: { location: `http://127.0.0.1:${target.port}/moved` } }));
  try {
    const tools = builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["127.0.0.1"] });
    const out = await byName(tools, "net.fetch").execute({ url: `http://127.0.0.1:${front.port}/x` }, ctx());
    assert.equal(out.content, "the real body");
    const details = out.details as { status: number; url: string; hops: number };
    assert.equal(details.status, 200);
    assert.equal(details.hops, 2, "one absolute hop, one relative to the host that sent it");
    assert.equal(details.url, `http://127.0.0.1:${target.port}/final`, "the journal records the host that ANSWERED");
  } finally {
    await close(front.server);
    await close(target.server);
  }
});

test("a redirect LOOP terminates instead of spinning", async () => {
  let self = 0;
  const server = await serve(() => ({ status: 302, body: "", headers: { location: `http://127.0.0.1:${self}/again` } }));
  self = server.port;
  try {
    const tools = builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["127.0.0.1"] });
    const out = await byName(tools, "net.fetch").execute({ url: `http://127.0.0.1:${server.port}/start` }, ctx());
    assert.equal(out.isError, true);
    assert.match(String(out.content), /redirect/i);
  } finally {
    await close(server.server);
  }
});

test("a non-HTTP scheme is refused by NAME, not by an empty hostname failing to match", async () => {
  // `file:///etc/passwd` and `data:` both have an empty hostname, so they were refused
  // only as a side effect of never matching an allowlist entry. That is a coincidence,
  // and a coincidence is not a boundary.
  const tools = builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["example.com"] });
  for (const url of ["file:///etc/passwd", "data:text/plain,hello"]) {
    await assert.rejects(
      async () => byName(tools, "net.fetch").execute({ url }, ctx()),
      (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED" && /scheme|protocol/i.test((e as Error).message),
      url,
    );
  }
});

// ── declared irreversibility ─────────────────────────────────────────────────

test("each built-in declares an irreversibility class, which is what drives its posture", () => {
  const tools = builtinTools({ root: "/tmp", deny: [], egressAllowlist: ["example.com"] });
  assert.equal(byName(tools, "fs.read").irreversibility, "read_only");
  assert.equal(byName(tools, "fs.write").irreversibility, "reversible_write");
  assert.equal(byName(tools, "net.fetch").irreversibility, "read_only");
});

test("fs.write names a compensation that actually exists", () => {
  // A declared compensation that cannot compensate is worse than none — it makes a
  // rewind look safe when it is not.
  const tools = builtinTools({ root: "/tmp", deny: [] });
  assert.equal(byName(tools, "fs.write").compensation?.tool, "fs.restore");
  assert.equal(fsRestore({ root: "/tmp", deny: [] }).name, "fs.restore");
});

test("fs.write captures the PRIOR content, so fs.restore has something to restore to", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root, deny: [] });
  writeFileSync(join(s.root, "f.txt"), "original");

  const out = await byName(tools, "fs.write").execute({ path: "f.txt", body: "replacement" }, ctx());
  assert.equal((out.details as { previous?: string }).previous, "original");

  await fsRestore({ root: s.root, deny: [] }).execute({ path: "f.txt", previous: "original" }, ctx());
  assert.equal(readFileSync(join(s.root, "f.txt"), "utf8"), "original");
  s.cleanup();
});

// ── the tool → channel mapping ───────────────────────────────────────────────

test("A TOOL'S OUTPUT LANDS IN THE CHANNEL THE NODE DECLARED, whatever the tool calls it", async () => {
  // Found by running a hand-written graph through the standalone binary: `fs.write`
  // calls its output `written`, the graph called the channel `note`, and the run failed
  // with E_CHANNEL_UNDECLARED — AFTER the file had been written. A tool cannot know a
  // graph's channel names, so it must not have to.
  const s = sandbox();
  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "map", project: "t", version: 1 },
    channels: { who: { type: "string", reduce: "replace" }, note: { type: "object", reduce: "replace" } },
    inputs: ["who"],
    outputs: ["note"],
    nodes: [
      {
        id: "greet" as NodeId,
        type: "tool",
        reads: ["who"],
        writes: ["note"],
        tool: { name: "fs.write", version: "1.0", args: { path: "out.txt", body: "hello ${who}" } },
        unhandled: true,
      },
    ],
    edges: [],
  };

  const store = new MemoryStateStore({ now: () => 1 });
  const tools = new ToolRegistry();
  for (const t of builtinTools({ root: s.root, deny: [] })) tools.register(t);
  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1,
    policy: { granted: ["*"], systemFloor: "out" },
  });

  const graph = compileOrThrow({
    spec,
    resolver: resolver(),
    tools: Object.fromEntries(tools.list().map((t) => [t.name, t])),
    tenantCapabilities: ["*"],
  });
  const runId = await engine.submit({ graph, inputs: { who: "loom" } });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.deepEqual(p.channels["note"], { path: "out.txt", bytes: 10 }, "the tool's `written` became the node's `note`");
  assert.equal(readFileSync(join(s.root, "out.txt"), "utf8"), "hello loom");
  s.cleanup();
});

test("a tool write whose key the node DID declare passes through untouched", async () => {
  // The graph-local case: a tool written for one graph knows its channels, and mapping
  // must not second-guess it.
  const s = sandbox();
  const store = new MemoryStateStore({ now: () => 1 });
  const tools = new ToolRegistry();
  tools.register({
    name: "local.emit",
    version: "1.0",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    description: "Writes two named channels.",
    parameters: { type: "object" },
    execute: () => ({ content: "ok", writes: { a: 1, b: 2 } }),
  });

  const spec: GraphSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "local", project: "t", version: 1 },
    channels: {
      seed: { type: "string", reduce: "replace" },
      a: { type: "number", reduce: "replace" },
      b: { type: "number", reduce: "replace" },
    },
    inputs: ["seed"],
    outputs: ["a"],
    nodes: [
      {
        id: "emit" as NodeId,
        type: "tool",
        reads: ["seed"],
        writes: ["a", "b"],
        tool: { name: "local.emit", version: "1.0" },
        unhandled: true,
      },
    ],
    edges: [],
  };

  const engine = new Engine({
    store,
    bus: new InProcessEventBus({ store }),
    tools,
    functions: new FunctionRegistry(),
    models: new ModelRegistry(),
    now: () => 1,
    policy: { granted: ["*"], systemFloor: "out" },
  });
  const graph = compileOrThrow({
    spec,
    resolver: resolver(),
    tools: Object.fromEntries(tools.list().map((t) => [t.name, t])),
    tenantCapabilities: ["*"],
  });
  const runId = await engine.submit({ graph, inputs: { seed: "x" } });
  const p = await engine.advance(runId);

  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));
  assert.equal(p.channels["a"], 1);
  assert.equal(p.channels["b"], 2);
  s.cleanup();
});

// ── the jail is per BRANCH, not per workspace ────────────────────────────────

test("TWO FAN-OUT BRANCHES WRITING THE SAME PATH GET DISTINCT FILES", async () => {
  // The clobber, at the tool boundary. `cli.ts` constructs `builtinTools(jail)` ONCE
  // with one `root`, so every branch of a fan-out resolves `out.txt` to the same
  // inode: the second write wins, the first is gone, and nothing anywhere says so.
  // `ToolContext.taskId` is `nodeId@branchPath#iteration` and the engine passes the
  // real one, so the branch coordinate is already in hand at the only place that
  // turns a relative path into a real one.
  const s = sandbox();
  try {
    const write = byName(builtinTools({ root: s.root, deny: [] }), "fs.write");
    await write.execute({ path: "out.txt", body: "from branch 0" }, ctxOf("w@root/fo[0]#0"));
    await write.execute({ path: "out.txt", body: "from branch 1" }, ctxOf("w@root/fo[1]#0"));

    const files = filesUnder(s.root);
    assert.equal(files.length, 2, `both branches' writes survive, but the workspace holds: ${JSON.stringify(files)}`);
    const bodies = files.map((f) => readFileSync(join(s.root, f), "utf8")).sort();
    assert.deepEqual(bodies, ["from branch 0", "from branch 1"]);
  } finally {
    s.cleanup();
  }
});

test("the ROOT branch still writes straight into the workspace — the common case is unchanged", async () => {
  // Every graph without a fan-out has one branch, `root`, and its files must land
  // where an operator (and `--workspace`) expects them. A scheme that moved even the
  // root branch into a subdirectory would break every existing workspace.
  const s = sandbox();
  try {
    const write = byName(builtinTools({ root: s.root, deny: [] }), "fs.write");
    await write.execute({ path: "note.txt", body: "hello" }, ctxOf("only@root#0"));
    assert.equal(readFileSync(join(s.root, "note.txt"), "utf8"), "hello");
    assert.deepEqual(filesUnder(s.root), ["note.txt"]);
  } finally {
    s.cleanup();
  }
});

test("a branch READS BACK what it just wrote, and does not see its sibling's copy", async () => {
  const s = sandbox();
  try {
    const tools = builtinTools({ root: s.root, deny: [] });
    const write = byName(tools, "fs.write");
    const read = byName(tools, "fs.read");
    await write.execute({ path: "out.txt", body: "mine" }, ctxOf("w@root/fo[0]#0"));
    await write.execute({ path: "out.txt", body: "theirs" }, ctxOf("w@root/fo[1]#0"));

    assert.equal((await read.execute({ path: "out.txt" }, ctxOf("w@root/fo[0]#0"))).content, "mine");
    assert.equal((await read.execute({ path: "out.txt" }, ctxOf("w@root/fo[1]#0"))).content, "theirs");
  } finally {
    s.cleanup();
  }
});

test("a branch still READS THE SHARED WORKSPACE — a fan-out over files is the ordinary case", async () => {
  // Reads fall back to the workspace when the branch has no copy of its own. Without
  // that, every fan-out branch reading an input file placed in the workspace by the
  // operator would break, which is a larger regression than the clobber being fixed.
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "input.txt"), "shared input");
    const read = byName(builtinTools({ root: s.root, deny: [] }), "fs.read");
    assert.equal((await read.execute({ path: "input.txt" }, ctxOf("w@root/fo[7]#0"))).content, "shared input");
  } finally {
    s.cleanup();
  }
});

test("A BRANCH CANNOT REACH THE JOURNAL, and CONTAINMENT is what refuses it — not the deny-list", async () => {
  // The mechanism is asserted, not just the outcome, because the two walls are one step
  // apart and only one of them is standing here. A branch's jail root does not contain
  // `<ws>/.loom`, so both spellings of the journal are outside it and `assertWithin`
  // refuses them before it ever looks at a denied subtree. Pinning the MESSAGE is what
  // stops "the deny-list keeps branches off the journal" from becoming a second claim
  // about the same wall — the failure mode this repo keeps finding.
  const s = sandbox();
  try {
    const data = join(s.root, ".loom");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "journal.db"), "intact");
    const branch = ctxOf("w@root/fo[0]#0");
    const write = byName(builtinTools({ root: s.root, deny: [data] }), "fs.write");

    // Where this branch's files really land is disclosed on the result, so the test does
    // not have to restate the directory-naming scheme to find it.
    const first = await write.execute({ path: "seed.txt", body: "x" }, branch);
    const branchDir = dirname((first.details as { at: string }).at);
    symlinkSync(data, join(branchDir, "j"));

    await assert.rejects(
      async () => write.execute({ path: "j/journal.db", body: "clobbered" }, branch),
      (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED" && /escapes the sandbox root once its symlinks/.test((e as Error).message),
    );
    await assert.rejects(
      async () => write.execute({ path: "../../.loom/journal.db", body: "clobbered" }, branch),
      (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED" && /escapes the sandbox root/.test((e as Error).message),
    );
    assert.equal(readFileSync(join(data, "journal.db"), "utf8"), "intact");
  } finally {
    s.cleanup();
  }
});

test("a RELATIVE deny entry names one directory, not one per branch", async () => {
  // `assertWithin` resolves a relative deny entry against whatever root it is handed, and
  // the root it is handed is now the branch's — so `deny: [".loom"]` would otherwise mean
  // a different directory for every task that called a tool. The observable consequence is
  // small and is the whole of it: the entry keeps denying the WORKSPACE's `.loom`, and a
  // branch's own `.loom` is an ordinary directory. `cli.ts` passes an absolute `dataDir`
  // and would never have shown this; the contract on `BuiltinOptions.deny` covers both.
  const s = sandbox();
  try {
    const data = join(s.root, ".loom");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "journal.db"), "intact");
    const write = byName(builtinTools({ root: s.root, deny: [".loom"] }), "fs.write");

    await assert.rejects(
      async () => write.execute({ path: ".loom/journal.db", body: "clobbered" }, ctxOf("w@root#0")),
      (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED" && /denies/.test((e as Error).message),
      "the root branch is still denied the workspace's .loom",
    );

    const out = await write.execute({ path: ".loom/note.txt", body: "mine" }, ctxOf("w@root/fo[0]#0"));
    const at = (out.details as { at: string }).at;
    assert.match(at, /\.branches\b/, `a branch's own .loom is its own directory, not the workspace's: ${at}`);
    assert.equal(readFileSync(join(data, "journal.db"), "utf8"), "intact");
    assert.equal(existsSync(join(data, "note.txt")), false);
  } finally {
    s.cleanup();
  }
});

test("END TO END: a fan-out of three branches writing one declared path leaves three files", async () => {
  // The unit tests above hand-build a TaskId. This one proves the premise underneath
  // them — that `engine.ts` really passes a branch-coded `ToolContext.taskId` into a
  // tool, so no engine change is needed for the jail to become per-branch. The graph
  // names ONE output path, because that is what a graph author writes; the runtime is
  // what runs it three times.
  const s = sandbox();
  try {
    const spec: GraphSpec = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "fanout-write", project: "t", version: 1 },
      policy: { expansion: { maxNodes: 16, maxDepth: 1, maxFanout: 4, maxLoopIterations: 1 } },
      channels: {
        items: { type: "array", reduce: "replace" },
        item: { type: "string", reduce: "replace" },
        // `merge_object`, not `replace`: three branch instances of one node writing a
        // `replace` channel is three racing writers, and GRAPH010 refuses that graph at
        // compile time. The channel says the writes are commutative; nothing said the
        // FILES were, which is the gap this test is about.
        note: { type: "object", reduce: "merge_object" },
      },
      inputs: ["items"],
      outputs: ["note"],
      nodes: [
        { id: "start" as NodeId, type: "function", reads: ["items"], function: { ref: "function/seed@stable" } },
        {
          id: "write" as NodeId,
          type: "tool",
          reads: ["item"],
          writes: ["note"],
          tool: { name: "fs.write", version: "1.0", args: { path: "report.md", body: "branch ${item}" } },
          unhandled: true,
        },
        {
          id: "gather" as NodeId,
          type: "join",
          reads: ["note"],
          writes: ["note"],
          join: { branches: ["write" as NodeId], mode: "all", onBranchError: "fail" },
        },
      ],
      edges: [
        { id: "fo", from: "start" as NodeId, to: "write" as NodeId, kind: "fanout", over: "items", as: "item", maxWidth: 3 },
        { id: "jn", from: "write" as NodeId, to: "gather" as NodeId, kind: "join" },
      ],
    } as unknown as GraphSpec;

    const store = new MemoryStateStore({ now: () => 1 });
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: s.root, deny: [] })) tools.register(t);
    const functions = new FunctionRegistry();
    functions.register("function/seed@stable", () => ({}));

    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models: new ModelRegistry(),
      now: () => 1,
      maxParallelism: 3,
      policy: { granted: ["*"], systemFloor: "out" },
    });
    const graph = compileOrThrow({
      spec,
      resolver: resolver(),
      tools: Object.fromEntries(tools.list().map((t) => [t.name, t])),
      tenantCapabilities: ["*"],
    });
    const runId = await engine.submit({ graph, inputs: { items: ["a", "b", "c"] } });
    const p = await engine.advance(runId);
    assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

    const files = filesUnder(s.root);
    assert.equal(files.length, 3, `three branches wrote "report.md"; the workspace holds ${JSON.stringify(files)}`);
    assert.deepEqual(
      files.map((f) => readFileSync(join(s.root, f), "utf8")).sort(),
      ["branch a", "branch b", "branch c"],
      "each branch's body survived its siblings",
    );
    for (const f of files) assert.equal(f.endsWith("report.md"), true, `every file is still the path the graph named: ${f}`);
  } finally {
    s.cleanup();
  }
});

// ── §A.97: a path that is not a regular file is refused before it can block ────────────────

/**
 * `fs.read` of `pipe` in `root`, IN A CHILD PROCESS under a wall-clock bound.
 *
 * A child, because the defect is a SYNCHRONOUS block: a blocking `open` of a FIFO with no writer
 * parks the event loop, so an in-process test of the broken code would hang the runner itself
 * rather than fail. `spawnSync`'s `timeout` kills the child, and the parent reads that as the
 * failure it is. The bound is 10 s against a call that returns in well under one.
 */
function readInChild(root: string, path: string): { status: number | null; signal: string | null; out: string; err: string } {
  const tools = new URL("../../src/builtin/tools.ts", import.meta.url).href;
  const script =
    `const { builtinTools } = await import(${JSON.stringify(tools)});` +
    `const read = builtinTools({ root: ${JSON.stringify(root)}, deny: [] }).find((t) => t.name === "fs.read");` +
    `const r = await read.execute({ path: ${JSON.stringify(path)} }, { taskId: "t@root#0", signal: new AbortController().signal, progress() {} });` +
    `process.stdout.write(JSON.stringify({ isError: r.isError === true, code: r.error?.code, cls: r.error?.class, content: r.content, details: r.error?.details ?? r.details }));`;
  const c = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
  return { status: c.status, signal: c.signal, out: c.stdout, err: c.stderr };
}

test("§A.97 — a FIFO at an fs.read path is refused E_FS_UNREADABLE at once, and never blocks", { skip: process.platform === "win32" }, () => {
  const s = sandbox();
  try {
    // No writer ever opens it. A blocking read-open waits for one forever.
    execFileSync("mkfifo", [join(s.root, "pipe")]);
    const c = readInChild(s.root, "pipe");
    assert.equal(c.signal, null, `the read BLOCKED and the child was killed by the 10 s bound (${String(c.signal)})`);
    assert.equal(c.status, 0, c.err);
    const r = JSON.parse(c.out) as { isError: boolean; code?: string; cls?: string; content: string; details: { errno: string } };
    assert.equal(r.isError, true);
    // UNREADABLE, never NOT_FOUND: something IS at the path, and an `error` arm that reads
    // `E_FS_NOT_FOUND` as "nothing here" must not be told otherwise.
    assert.equal(r.code, "E_FS_UNREADABLE", c.out);
    assert.equal(r.cls, "policy");
    assert.equal(r.details.errno, "ENOTREG");
    assert.match(r.content, /a FIFO, not a regular file/);
  } finally {
    s.cleanup();
  }
});

test("§A.97 — a DIRECTORY at an fs.read path keeps its errno, and a regular file still reads", () => {
  // The ordinary half: the non-blocking open must change nothing about a file that IS regular.
  const s = sandbox();
  try {
    mkdirSync(join(s.root, "dir"));
    writeFileSync(join(s.root, "plain.txt"), "plain bytes");
    const read = readInChild(s.root, "dir");
    const r = JSON.parse(read.out) as { code?: string; details: { errno: string } };
    assert.equal(r.code, "E_FS_UNREADABLE", read.out);
    assert.equal(r.details.errno, "EISDIR");
    const ok = JSON.parse(readInChild(s.root, "plain.txt").out) as { isError: boolean; content: string };
    assert.equal(ok.isError, false);
    assert.equal(ok.content, "plain bytes");
  } finally {
    s.cleanup();
  }
});

// ── §A.99: fs.restore undoes a CREATE, from what fs.write recorded ────────────────────────

test("§A.99 — fs.write RECORDS a create (`created`, a digest of its bytes) and an overwrite (`previous`)", async () => {
  const s = sandbox();
  try {
    const write = byName(builtinTools({ root: s.root, deny: [] }), "fs.write");
    const created = (await write.execute({ path: "new.txt", body: "fresh" }, ctx())).details as Record<string, unknown>;
    assert.equal(created["created"], true);
    assert.match(String(created["wrote"]), /^sha256:[0-9a-f]{64}$/);
    assert.equal("previous" in created, false, "a create has nothing to put back");
    const over = (await write.execute({ path: "new.txt", body: "second" }, ctx())).details as Record<string, unknown>;
    assert.equal(over["created"], false);
    assert.equal(over["previous"], "fresh");
    assert.equal("wrote" in over, false);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — fs.restore REMOVES a file the write created, from the record alone (a fresh tool instance)", async () => {
  const s = sandbox();
  try {
    const details = (await byName(builtinTools({ root: s.root, deny: [] }), "fs.write").execute({ path: "d/new.txt", body: "fresh" }, ctx()))
      .details as Record<string, unknown>;
    // A NEW instance, as after a restart: nothing but the recorded details reaches it.
    const r = await fsRestore({ root: s.root, deny: [] }).execute(details, ctx());
    assert.equal(r.isError, undefined, r.content);
    assert.equal(existsSync(join(s.root, "d", "new.txt")), false);
    // Already gone is the state the undo wants — it says so rather than failing.
    const again = await fsRestore({ root: s.root, deny: [] }).execute(details, ctx());
    assert.equal(again.isError, undefined, again.content);
    assert.match(again.content, /already absent/);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — fs.restore REFUSES to remove a created file whose bytes changed, and leaves it untouched", async () => {
  const s = sandbox();
  try {
    const details = (await byName(builtinTools({ root: s.root, deny: [] }), "fs.write").execute({ path: "new.txt", body: "fresh" }, ctx()))
      .details as Record<string, unknown>;
    writeFileSync(join(s.root, "new.txt"), "somebody else's bytes");
    const r = await fsRestore({ root: s.root, deny: [] }).execute(details, ctx());
    assert.equal(r.isError, true);
    assert.match(r.content, /bytes changed since the write created it/);
    assert.equal(readFileSync(join(s.root, "new.txt"), "utf8"), "somebody else's bytes");
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a MISSING or AMBIGUOUS create record fails CLOSED: nothing is removed", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "keep.txt"), "fresh");
    const good = (await byName(builtinTools({ root: s.root, deny: [] }), "fs.write").execute({ path: "probe.txt", body: "fresh" }, ctx()))
      .details as Record<string, unknown>;
    const restore = fsRestore({ root: s.root, deny: [] });
    for (const [what, args] of [
      ["no record at all (an old journal)", { path: "keep.txt" }],
      ["created without a digest", { path: "keep.txt", created: true }],
      ["created as a STRING", { path: "keep.txt", created: "true", wrote: good["wrote"] }],
      ["created: false with no previous", { path: "keep.txt", created: false, wrote: good["wrote"] }],
      ["a digest that is not a string", { path: "keep.txt", created: true, wrote: 7 }],
    ] as const) {
      const r = await restore.execute(args as Record<string, unknown>, ctx());
      assert.equal(r.isError, true, `${what}: ${r.content}`);
      assert.equal(readFileSync(join(s.root, "keep.txt"), "utf8"), "fresh", `${what}: the file must be untouched`);
    }
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a path that already existed is NEVER recorded as a create, even when it cannot be read", async () => {
  // `created: true` only on ENOENT. A file this run cannot read is something it did not make, and
  // its undo must refuse rather than delete it.
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "locked.txt"), "someone's");
    chmodSync(join(s.root, "locked.txt"), 0o222);
    const details = (await byName(builtinTools({ root: s.root, deny: [] }), "fs.write").execute({ path: "locked.txt", body: "mine" }, ctx()))
      .details as Record<string, unknown>;
    chmodSync(join(s.root, "locked.txt"), 0o644);
    assert.equal(details["created"], false);
    const r = await fsRestore({ root: s.root, deny: [] }).execute(details, ctx());
    assert.equal(r.isError, true, r.content);
    assert.equal(existsSync(join(s.root, "locked.txt")), true);
  } finally {
    s.cleanup();
  }
});

// ── §A.83: a short read is a FACT in `details`, never a marker in `content` ────────────────

test("§A.83 — fs.read past maxBytes returns a bare PREFIX, and says so in details: truncated, and the WHOLE size in bytes", async () => {
  const s = sandbox();
  try {
    const doc = `${JSON.stringify({ a: 1 })}${" ".repeat(50)}`;
    writeFileSync(join(s.root, "doc.json"), doc);
    const read = byName(builtinTools({ root: s.root, deny: [] }), "fs.read");
    const cut = await read.execute({ path: "doc.json", maxBytes: 20 }, ctx());
    assert.equal(cut.content, doc.slice(0, 20), "the prefix and nothing else");
    assert.doesNotMatch(cut.content, /truncated/);
    assert.deepEqual(JSON.parse(cut.content), { a: 1 }, "a prefix that still parses — which is why the fact must be elsewhere");
    assert.deepEqual(cut.details, { path: "doc.json", bytes: doc.length, truncated: true });
    const whole = await read.execute({ path: "doc.json" }, ctx());
    assert.equal(whole.content, doc);
    assert.deepEqual(whole.details, { path: "doc.json", bytes: doc.length, truncated: false });
  } finally {
    s.cleanup();
  }
});

test("§A.83 — maxBytes counts BYTES, and the cut never splits a UTF-8 character", async () => {
  // It compared `text.length` — UTF-16 units — so `bytes` was not the file's size and the cap was
  // not the one asked for. `é` is two bytes, `€` three.
  const s = sandbox();
  try {
    const text = "éé€x";
    writeFileSync(join(s.root, "u.txt"), text);
    const read = byName(builtinTools({ root: s.root, deny: [] }), "fs.read");
    const all = await read.execute({ path: "u.txt" }, ctx());
    assert.deepEqual(all.details, { path: "u.txt", bytes: Buffer.byteLength(text), truncated: false });
    assert.equal(Buffer.byteLength(text), 8);
    // 6 bytes lands inside `€` (bytes 4..6): the character is left out whole.
    const cut = await read.execute({ path: "u.txt", maxBytes: 6 }, ctx());
    assert.equal(cut.content, "éé");
    assert.equal((cut.details as { truncated: boolean }).truncated, true);
    assert.equal((await read.execute({ path: "u.txt", maxBytes: 7 }, ctx())).content, "éé€");
  } finally {
    s.cleanup();
  }
});

test("§A.83 — net.fetch past maxBytes: a bare prefix, with truncated and the body's size in bytes", async () => {
  const body = `{"ok":true}${" ".repeat(40)}`;
  const fetchTool = byName(
    builtinTools({
      root: "/tmp",
      deny: [],
      egressAllowlist: ["example.com"],
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
    }),
    "net.fetch",
  );
  const r = await fetchTool.execute({ url: "https://example.com/x", maxBytes: 11 }, ctx());
  assert.equal(r.content, '{"ok":true}');
  assert.doesNotMatch(r.content, /truncated/);
  const d = r.details as { bytes: number; truncated: boolean };
  assert.equal(d.bytes, body.length);
  assert.equal(d.truncated, true);
  const whole = await fetchTool.execute({ url: "https://example.com/x" }, ctx());
  assert.equal(whole.content, body);
  assert.equal((whole.details as { truncated: boolean }).truncated, false);
});

test("§A.83 — proc.exec past its output cap: no marker appended, and details.truncated says so", async () => {
  const s = sandbox();
  try {
    const exec = byName(builtinTools({ root: s.root, deny: [], execAllowlist: [process.execPath] }), "proc.exec");
    // Past the sandbox's 1 MiB default capture.
    const r = await exec.execute({ command: process.execPath, args: ["-e", "process.stdout.write('y'.repeat(1_200_000))"] }, ctx());
    assert.equal((r.details as { truncated: boolean }).truncated, true);
    assert.doesNotMatch(r.content, /truncated/, "the output ends in the program's bytes, not in a marker");
    assert.match(r.content, /^exit=0\ny+$/);
  } finally {
    s.cleanup();
  }
});

// ── §A.99 review: the undo removes THE FILE the write made, identified, never a name ─────────

/** One create through the real `fs.write`, and its recorded details — the undo's only input. */
async function created(root: string, path = "a.txt", body = "B"): Promise<Record<string, unknown>> {
  return (await byName(builtinTools({ root, deny: [] }), "fs.write").execute({ path, body }, ctx())).details as Record<string, unknown>;
}

test("§A.99 — a SYMLINK planted at the created path is refused, and its target survives (in the jail or out)", async () => {
  const s = sandbox();
  const outside = mkdtempSync(join(tmpdir(), "loom-tools-out-"));
  try {
    for (const target of [join(s.root, "victim.txt"), join(outside, "victim.txt")]) {
      const d = await created(s.root);
      writeFileSync(target, "B");
      rmSync(join(s.root, "a.txt"));
      symlinkSync(target, join(s.root, "a.txt"));
      const r = await fsRestore({ root: s.root, deny: [] }).execute(d, ctx());
      assert.equal(r.isError, true, r.content);
      assert.equal(readFileSync(target, "utf8"), "B", `the link's target must survive: ${target}`);
      assert.equal(lstatSync(join(s.root, "a.txt")).isSymbolicLink(), true, "and the link is left as it is");
      rmSync(join(s.root, "a.txt"));
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
    s.cleanup();
  }
});

test("§A.99 — a PARENT DIRECTORY swapped for a symlink is refused, and the file it now reaches survives", async () => {
  const s = sandbox();
  try {
    const d = await created(s.root, "d/x.txt");
    mkdirSync(join(s.root, "e"));
    writeFileSync(join(s.root, "e", "x.txt"), "B");
    renameSync(join(s.root, "d"), join(s.root, "d-moved"));
    symlinkSync(join(s.root, "e"), join(s.root, "d"));
    const r = await fsRestore({ root: s.root, deny: [] }).execute(d, ctx());
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /no longer a real directory/);
    assert.equal(readFileSync(join(s.root, "e", "x.txt"), "utf8"), "B");
  } finally {
    s.cleanup();
  }
});

test("§A.99 — CREATE then OVERWRITE in one run: the reverse rollback restores, then REMOVES — both undone", async () => {
  // The run's own rollback runs in reverse: the overwrite's undo puts the create's bytes back, and
  // then the create's undo must still recognise its file. A change time in the identity refused
  // exactly this (review round 2): the restore moved it, so a file the run created stayed standing.
  const s = sandbox();
  try {
    const first = await created(s.root, "f.txt", "first x");
    const second = await created(s.root, "f.txt", "second x");
    assert.equal(second["created"], false);
    const restore = fsRestore({ root: s.root, deny: [] });
    const r2 = await restore.execute(second, ctx());
    assert.equal(r2.isError, undefined, r2.content);
    assert.equal(readFileSync(join(s.root, "f.txt"), "utf8"), "first x");
    const r1 = await restore.execute(first, ctx());
    assert.equal(r1.isError, undefined, r1.content);
    assert.equal(existsSync(join(s.root, "f.txt")), false, "the file the run created is gone");
  } finally {
    s.cleanup();
  }
});

test("§A.99 — CREATE then OVERWRITE through the ENGINE: a failed run's rollback leaves no file and records two `compensated`", async () => {
  const s = sandbox();
  try {
    const store = new MemoryStateStore({ now: () => 1 });
    const tools = new ToolRegistry();
    for (const t of builtinTools({ root: s.root, deny: [] })) if (t.name === "fs.write") tools.register(t);
    tools.register(fsRestore({ root: s.root, deny: [] }));
    const functions = new FunctionRegistry();
    functions.register("function/boom@stable", (() => ({ refuse: { reason: "no" } })) as never);
    const engine = new Engine({
      store,
      bus: new InProcessEventBus({ store }),
      tools,
      functions,
      models: new ModelRegistry(),
      now: () => 1,
      sleep: async () => {},
      policy: { granted: ["fs:write"], systemFloor: "out" },
    });
    const write = (id: string, body: string) => ({
      id,
      type: "tool",
      writes: [id],
      tool: { name: "fs.write", version: "1.0", args: { path: "out/f.txt", body } },
    });
    const spec = {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "create-overwrite", project: "t", version: 1 },
      policy: { posture: "out", capabilities: ["fs:write"] },
      channels: {
        save1: { type: "object", reduce: "replace" },
        save2: { type: "object", reduce: "replace" },
        out: { type: "object", reduce: "replace" },
      },
      inputs: [],
      outputs: ["out"],
      nodes: [write("save1", "first x"), write("save2", "second x"), { id: "boom", type: "function", reads: ["save2"], writes: ["out"], function: { ref: "function/boom@stable" } }],
      edges: [
        { id: "a", from: "save1", to: "save2", kind: "seq" },
        { id: "b", from: "save2", to: "boom", kind: "seq" },
      ],
    } as unknown as GraphSpec;
    const graph = compileOrThrow({ spec, resolver: resolver(), tools: Object.fromEntries(tools.list().map((t) => [t.name, t])), tenantCapabilities: ["fs:write"] });
    const runId = await engine.submit({ graph, inputs: {} });
    let p = await engine.advance(runId);
    for (let i = 0; i < 8 && p.status === "running"; i++) p = await engine.advance(runId);
    assert.equal(p.status, "failed");
    const outcomes: string[] = [];
    for await (const e of store.read(runId, 1 as never)) if (e.type === "compensation.recorded") outcomes.push((e.payload as { outcome: string }).outcome);
    assert.deepEqual(outcomes, ["compensated", "compensated"]);
    assert.equal(existsSync(join(s.root, "out", "f.txt")), false);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — TWO fs.edits in one branch: undoing both in reverse removes the branch copy the first created", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "shared.txt"), "hello world");
    const edit = byName(builtinTools({ root: s.root, deny: [] }), "fs.edit");
    const branch = ctxOf("e@root/fo[0]#0");
    const d1 = (await edit.execute({ path: "shared.txt", find: "world", replace: "one" }, branch)).details as Record<string, unknown>;
    const d2 = (await edit.execute({ path: "shared.txt", find: "one", replace: "two" }, branch)).details as Record<string, unknown>;
    assert.equal(d1["created"], true);
    assert.equal(d2["created"], false);
    const restore = fsRestore({ root: s.root, deny: [] });
    assert.equal((await restore.execute(d2, branch)).isError, undefined);
    const r1 = await restore.execute(d1, branch);
    assert.equal(r1.isError, undefined, r1.content);
    assert.equal(existsSync(String(d1["at"])), false);
    assert.equal(readFileSync(join(s.root, "shared.txt"), "utf8"), "hello world");
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a HARD LINK to the created file (a second name) makes the undo refuse", async () => {
  const s = sandbox();
  try {
    const d = await created(s.root);
    linkSync(join(s.root, "a.txt"), join(s.root, "hl.txt"));
    const r = await fsRestore({ root: s.root, deny: [] }).execute(d, ctx());
    assert.equal(r.isError, true, r.content);
    assert.equal(existsSync(join(s.root, "a.txt")), true);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — the digest is checked too: the true identity with other bytes' digest refuses", async () => {
  const s = sandbox();
  try {
    const d = await created(s.root);
    const r = await fsRestore({ root: s.root, deny: [] }).execute({ ...d, wrote: `sha256:${"0".repeat(64)}` }, ctx());
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /bytes changed/);
    assert.equal(existsSync(join(s.root, "a.txt")), true);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a FORGED record naming any file by path and digest deletes nothing, and says no creation", async () => {
  // A graph `tool` node may call `fs.restore` directly; the identity is what refuses it.
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "precious.txt"), "operator data");
    const digest = `sha256:${createHash("sha256").update("operator data").digest("hex")}`;
    for (const args of [
      { path: "precious.txt", created: true, wrote: digest },
      { path: "precious.txt", created: true, wrote: digest, at: join(realpathSync(s.root), "precious.txt") },
      { path: "precious.txt", created: true, wrote: digest, at: join(realpathSync(s.root), "precious.txt"), identity: { dev: "1", ino: "2", ctimeNs: "3" } },
    ]) {
      const r = await fsRestore({ root: s.root, deny: [] }).execute(args, ctx());
      assert.equal(r.isError, true, r.content);
      assert.doesNotMatch(r.content, /removed/);
      assert.equal(readFileSync(join(s.root, "precious.txt"), "utf8"), "operator data");
    }
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a record from ANOTHER workspace root is refused — never read as 'already absent'", async () => {
  const s = sandbox();
  const other = mkdtempSync(join(tmpdir(), "loom-tools-other-"));
  try {
    const d = await created(s.root);
    const r = await fsRestore({ root: other, deny: [] }).execute(d, ctx());
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /not under this workspace's root/);
    assert.equal(existsSync(join(s.root, "a.txt")), true, "the created file still stands, and nothing claimed otherwise");
  } finally {
    rmSync(other, { recursive: true, force: true });
    s.cleanup();
  }
});

test("§A.99 — 'already absent' ONLY for a plain absence of the recorded path; an unreadable parent refuses", { skip: process.getuid?.() === 0 }, async () => {
  const s = sandbox();
  try {
    // The leaf gone, and a directory above it gone: both are the state the undo wants.
    const leaf = await created(s.root, "d1/a.txt");
    rmSync(join(s.root, "d1", "a.txt"));
    const r1 = await fsRestore({ root: s.root, deny: [] }).execute(leaf, ctx());
    assert.equal(r1.isError, undefined, r1.content);
    assert.match(r1.content, /already absent/);
    const dir = await created(s.root, "d2/a.txt");
    rmSync(join(s.root, "d2"), { recursive: true });
    assert.match((await fsRestore({ root: s.root, deny: [] }).execute(dir, ctx())).content, /already absent/);
    // An absence the undo cannot SEE is not one: a parent it may not search is a refusal.
    const hidden = await created(s.root, "d3/a.txt");
    chmodSync(join(s.root, "d3"), 0o000);
    let r3;
    try {
      r3 = await fsRestore({ root: s.root, deny: [] }).execute(hidden, ctx());
    } finally {
      chmodSync(join(s.root, "d3"), 0o755);
    }
    assert.equal(r3.isError, true, r3.content);
    assert.doesNotMatch(r3.content, /already absent/);
    assert.equal(existsSync(join(s.root, "d3", "a.txt")), true);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a created file inside a subtree THIS jail denies is refused, even with its true record", async () => {
  const s = sandbox();
  try {
    const d = await created(s.root, "later-denied/a.txt");
    const r = await fsRestore({ root: s.root, deny: ["later-denied"] }).execute(d, ctx());
    assert.equal(r.isError, true, r.content);
    assert.match(r.content, /denied subtree/);
    assert.equal(existsSync(join(s.root, "later-denied", "a.txt")), true);
  } finally {
    s.cleanup();
  }
});

test("§A.99 — a record claiming BOTH a create and a previous content is refused, and nothing is written", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "p.txt"), "cur");
    const r = await fsRestore({ root: s.root, deny: [] }).execute({ path: "p.txt", previous: "X", created: true }, ctx());
    assert.equal(r.isError, true, r.content);
    assert.equal(readFileSync(join(s.root, "p.txt"), "utf8"), "cur");
  } finally {
    s.cleanup();
  }
});

test("§A.99 — fs.edit's FIRST write in a branch creates the branch copy, is recorded as a create, and its undo removes only that copy", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "shared.txt"), "hello world");
    const edit = byName(builtinTools({ root: s.root, deny: [] }), "fs.edit");
    const branch = ctxOf("e@root/fo[0]#0");
    const d = (await edit.execute({ path: "shared.txt", find: "world", replace: "branch" }, branch)).details as Record<string, unknown>;
    assert.equal(d["created"], true, JSON.stringify(d));
    assert.equal("previous" in d, false);
    const copy = String(d["at"]);
    assert.equal(readFileSync(copy, "utf8"), "hello branch");
    const r = await fsRestore({ root: s.root, deny: [] }).execute(d, branch);
    assert.equal(r.isError, undefined, r.content);
    assert.equal(existsSync(copy), false, "the branch copy is gone");
    assert.equal(readFileSync(join(s.root, "shared.txt"), "utf8"), "hello world", "the shared file is untouched");
    // And a SECOND edit in a branch that already has its copy is an overwrite, not a create.
    await edit.execute({ path: "shared.txt", find: "world", replace: "one" }, branch);
    const again = (await edit.execute({ path: "shared.txt", find: "one", replace: "two" }, branch)).details as Record<string, unknown>;
    assert.equal(again["created"], false);
    assert.equal(again["previous"], "hello one");
  } finally {
    s.cleanup();
  }
});

// ── §A.83 review: `bytes` is bytes everywhere; the cut never empties; a BOM is still dropped ──

test("§A.83 — fs.write and fs.edit report BYTES, not UTF-16 units (é😀 is 6 on disk, not 3)", async () => {
  const s = sandbox();
  try {
    const tools = builtinTools({ root: s.root, deny: [] });
    const w = await byName(tools, "fs.write").execute({ path: "u.txt", body: "é😀" }, ctx());
    assert.equal(statSync(join(s.root, "u.txt")).size, 6);
    assert.equal((w.details as { bytes: number }).bytes, 6);
    // The channel receipt is unchanged — a UTF-16 count, which a shipped graph's channel carries.
    assert.deepEqual(w.writes, { written: { path: "u.txt", bytes: 3 } });
    const e = await byName(tools, "fs.edit").execute({ path: "u.txt", find: "é", replace: "€" }, ctx());
    assert.equal(statSync(join(s.root, "u.txt")).size, 7);
    assert.equal((e.details as { bytes: number }).bytes, 7);
  } finally {
    s.cleanup();
  }
});

test("§A.83 — the cut steps back at most THREE bytes: input that is not UTF-8 is cut short, never emptied", async () => {
  const s = sandbox();
  try {
    writeFileSync(join(s.root, "bin"), Buffer.from([0x41, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]));
    const r = await byName(builtinTools({ root: s.root, deny: [] }), "fs.read").execute({ path: "bin", maxBytes: 8 }, ctx());
    assert.equal((r.details as { truncated: boolean }).truncated, true);
    // Bytes 0..4 survive: `A` and four stray continuation bytes, decoded as replacement characters.
    assert.equal(r.content, `A${"�".repeat(4)}`);
  } finally {
    s.cleanup();
  }
});

test("§A.83 — net.fetch still drops a leading UTF-8 BOM, as res.text() did, so the body parses", async () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]);
  const r = await byName(
    builtinTools({
      root: "/tmp",
      deny: [],
      egressAllowlist: ["example.com"],
      fetch: (async () => new Response(bom, { status: 200 })) as unknown as typeof fetch,
    }),
    "net.fetch",
  ).execute({ url: "https://example.com/x" }, ctx());
  assert.deepEqual(JSON.parse(r.content), { ok: true });
  assert.equal((r.details as { bytes: number }).bytes, 11);
});

test("§A.97 — a UNIX SOCKET and a TERMINAL DEVICE are refused E_FS_UNREADABLE by KIND when their OPEN fails", { skip: process.platform === "win32" }, async (t) => {
  // Their OPEN fails before the descriptor can be checked — macOS: a socket with errno 102, which
  // libuv does not name, and /dev/tty with ENXIO — and both used to come back UNTYPED, i.e. the
  // retryable E_TOOL_SOURCE_UNAVAILABLE. An `lstat` after the failed open classifies them.
  const dir = mkdtempSync(join(tmpdir(), "sk-"));
  const server = createNetServer();
  await new Promise<void>((ok) => server.listen(join(dir, "sock"), ok));
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const socket = await byName(builtinTools({ root: dir, deny: [] }), "fs.read").execute({ path: "sock" }, ctx());
  assert.equal(socket.error?.code, "E_FS_UNREADABLE", socket.content);
  assert.match(socket.content, /ENOTREG: a socket, not a regular file/);
  for (const dev of ["tty", "null"]) {
    const r = await byName(builtinTools({ root: "/dev", deny: [] }), "fs.read").execute({ path: dev }, ctx());
    assert.equal(r.error?.code, "E_FS_UNREADABLE", `${dev}: ${r.content}`);
    assert.match(r.content, /ENOTREG: a character device, not a regular file/, dev);
  }
});
