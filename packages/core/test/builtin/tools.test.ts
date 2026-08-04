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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const tools = builtinTools({ root: s.root });
  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: "../../etc/passwd" }, ctx()),
    (e: unknown) => (e as { code: string }).code === "E_CAP_DENIED",
  );
  s.cleanup();
});

test("fs.write cannot escape the root either", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root });
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
  const tools = builtinTools({ root: s.root });
  await assert.rejects(
    async () => byName(tools, "fs.read").execute({ path: "../../evil" }, ctx()),
    (e: unknown) => /escapes the sandbox root/.test((e as Error).message),
  );
  s.cleanup();
});

test("net.fetch is not even REGISTERED without an egress allowlist", () => {
  // Absent by construction rather than present-and-refusing: a tool that exists can be
  // named by an injected instruction, and being refused is one bug away from working.
  assert.equal(builtinTools({ root: "/tmp" }).some((t) => t.name === "net.fetch"), false);
  assert.equal(
    builtinTools({ root: "/tmp", egressAllowlist: ["example.com"] }).some((t) => t.name === "net.fetch"),
    true,
  );
});

test("net.fetch refuses a host outside the allowlist", async () => {
  const tools = builtinTools({
    root: "/tmp",
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

// ── declared irreversibility ─────────────────────────────────────────────────

test("each built-in declares an irreversibility class, which is what drives its posture", () => {
  const tools = builtinTools({ root: "/tmp", egressAllowlist: ["example.com"] });
  assert.equal(byName(tools, "fs.read").irreversibility, "read_only");
  assert.equal(byName(tools, "fs.write").irreversibility, "reversible_write");
  assert.equal(byName(tools, "net.fetch").irreversibility, "read_only");
});

test("fs.write names a compensation that actually exists", () => {
  // A declared compensation that cannot compensate is worse than none — it makes a
  // rewind look safe when it is not.
  const tools = builtinTools({ root: "/tmp" });
  assert.equal(byName(tools, "fs.write").compensation?.tool, "fs.restore");
  assert.equal(fsRestore({ root: "/tmp" }).name, "fs.restore");
});

test("fs.write captures the PRIOR content, so fs.restore has something to restore to", async () => {
  const s = sandbox();
  const tools = builtinTools({ root: s.root });
  writeFileSync(join(s.root, "f.txt"), "original");

  const out = await byName(tools, "fs.write").execute({ path: "f.txt", body: "replacement" }, ctx());
  assert.equal((out.details as { previous?: string }).previous, "original");

  await fsRestore({ root: s.root }).execute({ path: "f.txt", previous: "original" }, ctx());
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
  for (const t of builtinTools({ root: s.root })) tools.register(t);
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
