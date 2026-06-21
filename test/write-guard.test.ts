/**
 * write-guard — prompts before a blind overwrite of an unread existing file.
 *
 * The pure helper (isFullOverwrite) is unit-tested; the guard is exercised
 * through the agent loop with only core-tools and write-guard loaded, against a
 * real temp-file workspace, so any ui.confirm is unambiguously write-guard's
 * (the harness capability fallback is "allow", so the capability layer never
 * prompts). All offline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UI } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";
import coreTools from "../src/extensions/core-tools.js";
import writeGuard, { isFullOverwrite } from "../src/extensions/write-guard.js";

// -- unit: the overwrite-shape detector --------------------------------------

test("isFullOverwrite matches a write-shaped call and excludes edit / non-writers", () => {
  assert.equal(isFullOverwrite(["fs:write"], { path: "a.ts", content: "x" }), true);
  // edit carries `old` → excluded
  assert.equal(isFullOverwrite(["fs:read", "fs:write"], { path: "a.ts", old: "x", new: "y" }), false);
  // missing fs:write capability → excluded
  assert.equal(isFullOverwrite(["fs:read"], { path: "a.ts", content: "x" }), false);
  // missing string content → excluded
  assert.equal(isFullOverwrite(["fs:write"], { path: "a.ts" }), false);
  // undefined capabilities → excluded
  assert.equal(isFullOverwrite(undefined, { path: "a.ts", content: "x" }), false);
});

// -- live: through the agent loop --------------------------------------------

const ORIGINAL = "const greeting = 'hello world';\n";

/** A scratch workspace with one known pre-existing file. */
function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "eagent-write-guard-"));
  const file = join(dir, "x.ts");
  writeFileSync(file, ORIGINAL);
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir;
  return {
    dir,
    file,
    cleanup: () => {
      if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
      else process.env.EAGENT_WORKSPACE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A UI that counts confirm calls and answers with a fixed verdict. */
function countingUI(answer: boolean): { ui: UI; count: () => number } {
  let n = 0;
  return {
    ui: {
      confirm: async () => {
        n += 1;
        return answer;
      },
      notify: () => {},
    },
    count: () => n,
  };
}

/** Did any tool_result the model saw carry a write-guard block reason? */
function sawBlock(messages: { role: string; content: { type: string; content?: string }[] }[]): boolean {
  return messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /write-guard: /.test(b.content ?? "")));
}

test("live: overwriting an unread existing file is asked; a 'no' blocks it", async () => {
  const s = scratch();
  const u = countingUI(false);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "CLOBBERED" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("regenerate x.ts");
    assert.equal(u.count(), 1, "the unread overwrite prompts exactly once");
    assert.equal(sawBlock(h.agent.messages as never), true, "the model sees a write-guard block reason");
    assert.equal(readFileSync(s.file, "utf8"), ORIGINAL, "the file was not clobbered");
  } finally {
    s.cleanup();
  }
});

test("live: overwriting an unread existing file passes on a 'yes'", async () => {
  const s = scratch();
  const u = countingUI(true);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "NEWCONTENT" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("regenerate x.ts");
    assert.equal(u.count(), 1, "still prompts once");
    assert.equal(sawBlock(h.agent.messages as never), false, "no block reason when allowed");
    assert.equal(readFileSync(s.file, "utf8"), "NEWCONTENT", "the file was overwritten after consent");
  } finally {
    s.cleanup();
  }
});

test("live: creating a new file is never asked", async () => {
  const s = scratch();
  const u = countingUI(false);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "new.ts", content: "fresh" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("make a new file");
    assert.equal(u.count(), 0, "a new file has nothing to clobber, so no prompt");
    assert.equal(readFileSync(join(s.dir, "new.ts"), "utf8"), "fresh", "the new file was created");
  } finally {
    s.cleanup();
  }
});

test("live: reading the file first lets a later write pass unprompted", async () => {
  const s = scratch();
  const u = countingUI(false);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "read", arguments: { path: "x.ts" } }] },
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "INFORMED" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("read then rewrite x.ts");
    assert.equal(u.count(), 0, "a file read this session is known; no prompt");
    assert.equal(readFileSync(s.file, "utf8"), "INFORMED", "the informed write landed");
  } finally {
    s.cleanup();
  }
});

test("live: two writes to the same unread file prompt only once", async () => {
  const s = scratch();
  const u = countingUI(true);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "ONE" } }] },
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "TWO" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("write x.ts twice");
    assert.equal(u.count(), 1, "the first write records the path; the second is unprompted");
    assert.equal(readFileSync(s.file, "utf8"), "TWO", "the second write landed");
  } finally {
    s.cleanup();
  }
});

test("live: edit of an unread file is not guarded (the old-arg signature excludes it)", async () => {
  const s = scratch();
  const u = countingUI(false);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "edit", arguments: { path: "x.ts", old: "hello world", new: "goodbye" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("edit x.ts");
    assert.equal(u.count(), 0, "edit reads-then-replaces, so it is never guarded");
    assert.match(readFileSync(s.file, "utf8"), /goodbye/, "the edit applied");
  } finally {
    s.cleanup();
  }
});

test("live: EAGENT_WRITE_GUARD=off disables the guard", async () => {
  const s = scratch();
  const u = countingUI(false);
  const prev = process.env.EAGENT_WRITE_GUARD;
  process.env.EAGENT_WRITE_GUARD = "off";
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "UNGUARDED" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("regenerate x.ts");
    assert.equal(u.count(), 0, "kill switch means no prompt");
    assert.equal(readFileSync(s.file, "utf8"), "UNGUARDED", "the write was not guarded");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WRITE_GUARD;
    else process.env.EAGENT_WRITE_GUARD = prev;
    s.cleanup();
  }
});

test("live: disposing write-guard removes the guard (no leak)", async () => {
  const s = scratch();
  const u = countingUI(false);
  try {
    const h = makeHarness({
      ui: u.ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "AFTERUNLOAD" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);
    await h.host.unload("write-guard");

    await h.agent.run("regenerate x.ts");
    assert.equal(u.count(), 0, "after teardown nothing prompts");
    assert.equal(readFileSync(s.file, "utf8"), "AFTERUNLOAD", "the unguarded write landed");
  } finally {
    s.cleanup();
  }
});
