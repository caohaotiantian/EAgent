/**
 * Tests for the checkpoint extension: git-backed workspace snapshots, manual
 * and automatic, plus rollback round-trips. Each test builds a throwaway git
 * repo under the system temp dir, points the workspace at it via the
 * `workspaceDir` store override, and drives the extension's commands through
 * the harness. The non-git case asserts the extension stays inert and never
 * throws.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import activate from "../src/extensions/checkpoint.js";
import type { CompletionRequest } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

/** Temp dirs to clean up after the whole suite. */
const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** Make a fresh empty temp dir (tracked for cleanup). */
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Run a git subcommand in `cwd`, throwing on failure (test setup must succeed). */
function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

/** Create a git repo with one committed file, returning the dir and file path. */
function makeRepo(initialContent: string): { dir: string; file: string } {
  const dir = freshDir("eagent-ckpt-");
  git(dir, "init");
  // Set identity per-repo so commits work without global git config.
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test User");
  // Disable commit signing per-repo: deterministic, and avoids any host gpg.
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "tag.gpgsign", "false");
  const file = join(dir, "file.txt");
  writeFileSync(file, initialContent);
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "initial");
  return { dir, file };
}

/** Spin up the harness with the checkpoint extension bound to `workspace`. */
async function harnessFor(workspace: string) {
  const out: string[] = [];
  const h = makeHarness({});
  // Bind the workspace BEFORE activation, via the same namespaced store the
  // extension reads (the host opens it under the extension id).
  await h.host.use("checkpoint", (e) => {
    e.store.set("workspaceDir", workspace);
    return activate(e);
  });
  const run = async (name: string, args = ""): Promise<string[]> => {
    out.length = 0;
    await h.commands.get(name)!.run({ agent: h.agent, args, print: (l) => out.push(l) });
    return [...out];
  };
  return { ...h, run };
}

test("/checkpoint creates a snapshot and /checkpoints lists it", async () => {
  const { dir } = makeRepo("v1");
  const { run } = await harnessFor(dir);

  const created = await run("checkpoint", "my-label");
  assert.match(created.join("\n"), /checkpoint \d+ created \(my-label\)/);

  const listed = await run("checkpoints");
  assert.equal(listed.length, 1, "exactly one checkpoint listed");
  assert.match(listed[0]!, /my-label/);
});

test("rollback round-trip restores the working tree", async () => {
  const { dir, file } = makeRepo("v1");
  const { run } = await harnessFor(dir);

  // Snapshot the committed "v1" state, then mutate the file on disk.
  await run("checkpoint", "before-edit");
  writeFileSync(file, "v2");
  assert.equal(readFileSync(file, "utf8"), "v2");

  const rolled = await run("rollback");
  assert.match(rolled.join("\n"), /rolled back to checkpoint/);
  assert.equal(readFileSync(file, "utf8"), "v1", "file restored to snapshot content");
});

test("auto-snapshots before a mutating (fs:write) tool runs", async () => {
  const { dir } = makeRepo("v1");

  // Script the model to call our writer tool once, then stop.
  let turn = 0;
  const responder = (_req: CompletionRequest) => {
    turn++;
    if (turn === 1) return { toolCalls: [{ name: "writer", arguments: { content: "changed" } }] };
    return { text: "done" };
  };
  const out: string[] = [];
  const h = makeHarness({ responder });
  await h.host.use("checkpoint", (e) => {
    e.store.set("workspaceDir", dir);
    return activate(e);
  });

  // A tool declaring fs:write; the hook must snapshot before it executes.
  h.agent.tools.register({
    spec: {
      name: "writer",
      description: "Write content into the workspace file.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
    capabilities: ["fs:write"],
    execute: async (args) => {
      writeFileSync(join(dir, "file.txt"), String(args.content));
      return { content: "wrote" };
    },
  });

  await h.agent.run("please write");

  const listed: string[] = [];
  await h.commands
    .get("checkpoints")!
    .run({ agent: h.agent, args: "", print: (l) => listed.push(l) });
  const text = listed.join("\n");
  assert.match(text, /writer/, "an auto-snapshot labeled with the tool name was recorded");
});

test("non-git directory: commands print 'not a git repository' and never throw", async () => {
  const dir = freshDir("eagent-nogit-");
  const { run } = await harnessFor(dir);

  for (const cmd of ["checkpoint", "checkpoints", "rollback"]) {
    const lines = await run(cmd);
    assert.equal(lines[0], "not a git repository", `${cmd} reports non-repo`);
  }
});

test("EAGENT_CHECKPOINT=off disables the extension: no commands, no auto-snapshot", async () => {
  const { dir } = makeRepo("v1");
  const prev = process.env.EAGENT_CHECKPOINT;
  process.env.EAGENT_CHECKPOINT = "off";
  try {
    // Script the model to call a mutating tool once, then stop.
    let turn = 0;
    const responder = (_req: CompletionRequest) => {
      turn++;
      if (turn === 1) return { toolCalls: [{ name: "writer", arguments: { content: "changed" } }] };
      return { text: "done" };
    };
    const h = makeHarness({ responder });
    let captured: import("../src/kernel/extension.js").ExtensionAPI | undefined;
    await h.host.use("checkpoint", (e) => {
      e.store.set("workspaceDir", dir);
      captured = e;
      return activate(e);
    });

    // Off ⇒ activate early-returns ⇒ no commands registered.
    assert.equal(h.commands.get("checkpoint"), undefined, "no /checkpoint command when off");
    assert.equal(h.commands.get("checkpoints"), undefined, "no /checkpoints command when off");
    assert.equal(h.commands.get("rollback"), undefined, "no /rollback command when off");

    // A mutating tool runs, but the absent auto-snapshot hook records nothing.
    h.agent.tools.register({
      spec: {
        name: "writer",
        description: "Write content into the workspace file.",
        parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
      },
      capabilities: ["fs:write"],
      execute: async (args) => {
        writeFileSync(join(dir, "file.txt"), String(args.content));
        return { content: "wrote" };
      },
    });
    await h.agent.run("please write");

    assert.deepEqual(captured!.store.get("checkpoints", []), [], "no auto-snapshot recorded when off");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_CHECKPOINT;
    else process.env.EAGENT_CHECKPOINT = prev;
  }
});
