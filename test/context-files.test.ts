/**
 * Tests for the context-files extension (AGENTS.md / CLAUDE.md discovery).
 *
 * Each test builds a throwaway directory tree under the OS temp dir and points
 * the extension's base directory at it via `process.env.EAGENT_WORKSPACE`, which
 * is read at activation time. We set the env var BEFORE `host.use` so the very
 * first `transformContext` call walks the right tree, then a function responder
 * captures the message list the provider actually received.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import type { CompletionRequest, Message } from "../src/kernel/types.js";
import contextFiles from "../src/extensions/context-files.js";
import { makeHarness } from "./helpers.js";

let root: string;
let savedWorkspace: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eagent-ctx-"));
  savedWorkspace = process.env.EAGENT_WORKSPACE;
});

afterEach(() => {
  if (savedWorkspace === undefined) delete process.env.EAGENT_WORKSPACE;
  else process.env.EAGENT_WORKSPACE = savedWorkspace;
  rmSync(root, { recursive: true, force: true });
});

/** Collect the text of every block in a message into one string. */
function messageText(m: Message): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** A responder that records the message list of the first request it sees. */
function capturing(): { responder: (req: CompletionRequest, i: number) => { text: string }; seen: Message[][] } {
  const seen: Message[][] = [];
  return {
    seen,
    responder: (req) => {
      seen.push(req.messages);
      return { text: "ok" };
    },
  };
}

/** Run a command by name through the harness command registry. */
async function runCommand(
  commands: ReturnType<typeof makeHarness>["commands"],
  agent: ReturnType<typeof makeHarness>["agent"],
  name: string,
): Promise<string[]> {
  const cmd = commands.get(name);
  assert.ok(cmd, `command "${name}" should be registered`);
  const lines: string[] = [];
  await cmd!.run({ agent, args: "", print: (line) => lines.push(line) });
  return lines;
}

test("injects an AGENTS.md system message without mutating the transcript", async () => {
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULES");
  process.env.EAGENT_WORKSPACE = root;

  const { responder, seen } = capturing();
  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("context-files", contextFiles);

  await agent.run("hello");

  // The provider saw an injected system message carrying the file text.
  const sent = seen[0]!;
  const injected = sent.find(
    (m) => m.role === "system" && messageText(m).includes("ROOT RULES"),
  );
  assert.ok(injected, "provider should receive a system message with the file contents");
  assert.equal(injected!.meta?.source, "context-files");
  assert.equal(injected!.meta?.ephemeral, true);

  // The persistent transcript must NOT contain the injected system message.
  const persisted = agent.messages.find(
    (m) => m.role === "system" && messageText(m).includes("ROOT RULES"),
  );
  assert.equal(persisted, undefined, "injected context must not be persisted to the transcript");
});

test("nearest-wins ordering: SUB content appears after ROOT content", async () => {
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULES");
  const sub = join(root, "sub");
  mkdirSync(sub);
  writeFileSync(join(sub, "AGENTS.md"), "SUB RULES");
  process.env.EAGENT_WORKSPACE = sub;

  const { responder, seen } = capturing();
  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("context-files", contextFiles);

  await agent.run("hello");

  const injected = seen[0]!.find((m) => m.role === "system" && messageText(m).includes("SUB RULES"));
  assert.ok(injected, "both context files should be injected");
  const body = messageText(injected!);
  assert.ok(body.includes("ROOT RULES"), "root content present");
  assert.ok(body.includes("SUB RULES"), "sub content present");
  assert.ok(
    body.indexOf("ROOT RULES") < body.indexOf("SUB RULES"),
    "the nearest (SUB) file must appear after the root file",
  );
});

test("/context lists discovered files with byte sizes", async () => {
  writeFileSync(join(root, "AGENTS.md"), "ROOT RULES");
  process.env.EAGENT_WORKSPACE = root;

  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("context-files", contextFiles);

  const lines = await runCommand(commands, agent, "context");
  const joined = lines.join("\n");
  assert.ok(joined.includes("AGENTS.md"), "lists the file path");
  // "ROOT RULES" is 10 bytes.
  assert.ok(/\b10 bytes\b/.test(joined), `lists the byte size, got: ${joined}`);
});

test("no context files: nothing injected and /context prints (none found)", async () => {
  // Point the base dir at an empty temp dir (its ancestors hold no context
  // files either, since temp dirs live under the OS tmp tree).
  const empty = mkdtempSync(join(tmpdir(), "eagent-empty-"));
  process.env.EAGENT_WORKSPACE = empty;
  try {
    const { responder, seen } = capturing();
    const { agent, host, commands } = makeHarness({ responder, fallback: "allow" });
    await host.use("context-files", contextFiles);

    await agent.run("hello");

    const injected = seen[0]!.find(
      (m) => m.role === "system" && messageText(m).includes("Project context"),
    );
    assert.equal(injected, undefined, "no context message should be injected");

    const lines = await runCommand(commands, agent, "context");
    assert.deepEqual(lines, ["(none found)"]);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("/context-reload picks up a newly-added file", async () => {
  process.env.EAGENT_WORKSPACE = root;

  const { agent, host, commands } = makeHarness({ fallback: "allow" });
  await host.use("context-files", contextFiles);

  // Initial discovery finds nothing.
  const before = await runCommand(commands, agent, "context");
  assert.deepEqual(before, ["(none found)"]);

  // Add a file, then reload to invalidate the cache and re-walk.
  writeFileSync(join(root, "CLAUDE.md"), "NEW RULES");
  const reloaded = await runCommand(commands, agent, "context-reload");
  const joined = reloaded.join("\n");
  assert.ok(joined.includes("CLAUDE.md"), `reload should find the new file, got: ${joined}`);

  // And it now lists via /context too.
  const after = await runCommand(commands, agent, "context");
  assert.ok(after.join("\n").includes("CLAUDE.md"), "context now lists the new file");
});
