/**
 * The `search` extension — read-only `glob` and `grep` tools. These run offline
 * against a fresh mkdtemp workspace per test (set via EAGENT_WORKSPACE, restored
 * in finally), so the tests exercise the real recursive walk, glob translator,
 * confinement, default-ignore, symlink-skip, and the 100-result caps.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import search from "../src/extensions/search.ts";
import coreTools from "../src/extensions/core-tools.ts";
import type { Tool, ToolContext, ToolResult } from "../src/kernel/types.ts";
import { makeHarness } from "./helpers.ts";

function ctx(): ToolContext {
  return {
    toolCallId: "x",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: { confirm: async () => true, notify: () => {} },
    agent: { model: "mock", messages: [], steer: () => {}, followUp: () => {} },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
}

/** Load the search extension into a fresh harness and return its tools by name. */
async function loadSearch(): Promise<Map<string, Tool>> {
  const { agent, host } = makeHarness();
  await host.use("search", search);
  const map = new Map<string, Tool>();
  for (const t of agent.tools.list()) map.set(t.spec.name, t);
  return map;
}

function run(tool: Tool | undefined, args: Record<string, unknown>): Promise<ToolResult> {
  assert.ok(tool, "tool should be registered");
  return tool!.execute(args, ctx());
}

/** Run `fn` against a fresh mkdtemp workspace, restoring EAGENT_WORKSPACE after. */
async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
  const prev = process.env.EAGENT_WORKSPACE;
  const root = mkdtempSync(join(tmpdir(), "eagent-search-"));
  process.env.EAGENT_WORKSPACE = root;
  try {
    await fn(root);
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = prev;
  }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// T1 — glob: pattern, confinement, default-ignore, symlink
// ---------------------------------------------------------------------------

test("AC-2 glob matches by pattern (root-relative, sorted)", async () => {
  await withWorkspace(async (root) => {
    write(root, "a.ts", "");
    write(root, "src/b.ts", "");
    write(root, "src/c/d.ts", "");
    write(root, "notes.md", "");
    const tools = await loadSearch();

    const all = await run(tools.get("glob"), { pattern: "**/*.ts" });
    assert.equal(all.isError, undefined);
    assert.deepEqual(all.content.split("\n"), ["a.ts", "src/b.ts", "src/c/d.ts"]);

    const underSrc = await run(tools.get("glob"), { pattern: "src/**/*.ts" });
    assert.equal(underSrc.isError, undefined);
    assert.deepEqual(underSrc.content.split("\n"), ["src/b.ts", "src/c/d.ts"]);
    assert.ok(!underSrc.content.split("\n").includes("a.ts"), "a.ts is not under src/");
  });
});

test("AC-8 default-ignore skips node_modules and .git", async () => {
  await withWorkspace(async (root) => {
    write(root, "a.ts", "");
    write(root, "node_modules/x.ts", "");
    write(root, ".git/y.ts", "");
    const tools = await loadSearch();

    const out = (await run(tools.get("glob"), { pattern: "**/*.ts" })).content.split("\n");
    assert.deepEqual(out, ["a.ts"]);
    assert.ok(!out.includes("node_modules/x.ts"));
    assert.ok(!out.includes(".git/y.ts"));
  });
});

test("AC-5a glob rejects a path that escapes the workspace root", async () => {
  await withWorkspace(async (root) => {
    write(root, "a.ts", "");
    const tools = await loadSearch();
    const r = await run(tools.get("glob"), { pattern: "*", path: "../" });
    assert.equal(r.isError, true);
    assert.match(r.content, /outside the workspace root/);
  });
});

test("AC-5b glob does not follow an in-root symlink", async () => {
  await withWorkspace(async (root) => {
    const outside = mkdtempSync(join(tmpdir(), "eagent-outside-"));
    writeFileSync(join(outside, "secret.ts"), "");
    write(root, "a.ts", "");
    symlinkSync(outside, join(root, "link"));
    const tools = await loadSearch();

    const out = (await run(tools.get("glob"), { pattern: "**/*" })).content.split("\n");
    assert.ok(out.includes("a.ts"));
    assert.ok(!out.some((p) => p.includes("secret.ts")), "symlinked target must not be walked");
    assert.ok(!out.some((p) => p.startsWith("link/")), "symlink dir must not be descended");
  });
});

test("AC-5b grep does not read through an in-root symlink", async () => {
  await withWorkspace(async (root) => {
    const outside = mkdtempSync(join(tmpdir(), "eagent-outside-"));
    writeFileSync(join(outside, "secret.ts"), "SEKRET_NEEDLE here\n");
    write(root, "a.ts", "nothing to see\n");
    symlinkSync(outside, join(root, "link"));
    const tools = await loadSearch();

    const r = await run(tools.get("grep"), { pattern: "SEKRET_NEEDLE" });
    assert.ok(!/SEKRET_NEEDLE/.test(r.content), "grep must not read through the symlink to the out-of-root target");
  });
});

// ---------------------------------------------------------------------------
// T3 — grep: content+location, include, caps, binary, metadata, capability
// ---------------------------------------------------------------------------

test("AC-3 grep finds content with file:line:text", async () => {
  await withWorkspace(async (root) => {
    write(root, "src/f.ts", "line one\nhas needle here\nline three");
    const tools = await loadSearch();

    const r = await run(tools.get("grep"), { pattern: "needle" });
    assert.equal(r.isError, undefined);
    assert.equal(r.content, "src/f.ts:2:has needle here");
  });
});

test("AC-4 grep include filter scopes the search", async () => {
  await withWorkspace(async (root) => {
    write(root, "doc.md", "the needle is in markdown");
    write(root, "code.ts", "the needle is in code");
    const tools = await loadSearch();

    const r = await run(tools.get("grep"), { pattern: "needle", include: "*.md" });
    assert.equal(r.isError, undefined);
    assert.match(r.content, /doc\.md/);
    assert.ok(!/code\.ts/.test(r.content), "the .ts file must not be searched");
  });
});

test("grep fails on an invalid regex", async () => {
  await withWorkspace(async () => {
    const tools = await loadSearch();
    const r = await run(tools.get("grep"), { pattern: "(" });
    assert.equal(r.isError, true);
  });
});

test("binary guard: grep skips a file with a NUL byte", async () => {
  await withWorkspace(async (root) => {
    writeFileSync(join(root, "blob.bin"), Buffer.from("needle\0more", "utf8"));
    write(root, "text.txt", "needle in text");
    const tools = await loadSearch();

    const r = await run(tools.get("grep"), { pattern: "needle" });
    assert.match(r.content, /text\.txt/);
    assert.ok(!/blob\.bin/.test(r.content), "binary file must be skipped");
  });
});

test("AC-7 glob and grep are parallel and need only fs:read", async () => {
  await withWorkspace(async () => {
    const { agent, host } = makeHarness();
    await host.use("search", search);
    const glob = agent.tools.get("glob");
    const grep = agent.tools.get("grep");
    assert.ok(glob && grep);
    assert.equal(glob!.executionMode, "parallel");
    assert.equal(grep!.executionMode, "parallel");
    assert.deepEqual(glob!.capabilities, ["fs:read"]);
    assert.deepEqual(grep!.capabilities, ["fs:read"]);
  });
});

test("AC-6 grep executes with shell:exec denied but fs:read granted", async () => {
  await withWorkspace(async (root) => {
    write(root, "f.ts", "find the needle");
    const h = makeHarness({
      fallback: "deny",
      responder: [{ toolCalls: [{ name: "grep", arguments: { pattern: "needle" } }] }, { text: "done" }],
    });
    await h.host.use("core-tools", coreTools); // grants fs:read
    await h.host.use("search", search);

    await h.agent.run("search for the needle");

    const results = h.agent.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "tool_result" }> => b.type === "tool_result");
    assert.equal(results.length, 1, "the grep tool should have run once");
    const out = results[0]!;
    assert.equal(out.isError, undefined, "grep must not be capability-denied");
    assert.match(out.content, /f\.ts:1:find the needle/);
  });
});

// ---------------------------------------------------------------------------
// T3 — caps and short-circuit (AC-9)
// ---------------------------------------------------------------------------

test("AC-9a glob caps at 100 files with a truncation marker", async () => {
  await withWorkspace(async (root) => {
    for (let i = 0; i < 150; i++) write(root, `f${String(i).padStart(4, "0")}.ts`, "");
    const tools = await loadSearch();

    const r = await run(tools.get("glob"), { pattern: "**/*.ts" });
    const lines = r.content.split("\n");
    const marker = lines[lines.length - 1]!;
    assert.match(marker, /limit|truncat/i);
    assert.equal(lines.length - 1, 100, "exactly 100 file paths before the marker");
  });
});

test("AC-9b grep caps at 100 matches, short-circuits past the cap", async () => {
  await withWorkspace(async (root) => {
    // 120 matching files, name-sorted; the walk reaches the sentinel only after
    // the cap, so a short-circuit must leave its distinguishable match absent.
    for (let i = 0; i < 120; i++) write(root, `m${String(i).padStart(4, "0")}.txt`, "needle");
    write(root, "zzz_sentinel.txt", "needle SENTINEL");
    const tools = await loadSearch();

    const r = await run(tools.get("grep"), { pattern: "needle" });
    const lines = r.content.split("\n");
    const marker = lines[lines.length - 1]!;
    assert.match(marker, /limit|truncat/i);
    assert.equal(lines.length - 1, 100, "exactly 100 match lines before the marker");
    assert.ok(!r.content.includes("SENTINEL"), "sentinel after the cap must not be read");
  });
});

test("glob returns (no matches) when nothing matches", async () => {
  await withWorkspace(async (root) => {
    write(root, "a.ts", "");
    const tools = await loadSearch();
    const r = await run(tools.get("glob"), { pattern: "**/*.zzz" });
    assert.equal(r.isError, undefined);
    assert.equal(r.content, "(no matches)");
  });
});
