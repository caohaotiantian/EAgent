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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { builtinTools, fsRestore } from "../../src/builtin/tools.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import type { NodeId } from "../../src/ids.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { Engine } from "../../src/run/engine.ts";
import { FunctionRegistry, ModelRegistry, ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import { resolver } from "../run/skeleton.ts";

const ctx = () => ({ taskId: "t@root#0" as never, signal: new AbortController().signal, progress: () => {} });

function sandbox(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "loom-tools-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const byName = (tools: readonly ToolDefinition[], name: string): ToolDefinition =>
  tools.find((t) => t.name === name)!;

// ── confinement ──────────────────────────────────────────────────────────────

test("fs.read CANNOT ESCAPE THE ROOT", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root, deny: [] });
  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: "../../etc/passwd" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
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
  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: "../../evil" }, ctx()),
    (e: unknown) => /escapes the sandbox root/.test((e as Error).message),
  );
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

  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: ".loom/journal.db" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
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

  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: "vendor/secret.txt" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED" && !/not yours/.test((e as Error).message),
    "a read through a symlink must not resolve to a file outside the root",
  );
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
