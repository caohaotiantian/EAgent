/**
 * Tests for the microagents extension: keyword-triggered knowledge injection on
 * the `transformContext` seam.
 *
 * The pure functions (`parseMicroagent`, `triggered`, `latestUserText`,
 * `injectMicroagents`, `scanMicroagents`) are exercised directly; the extension
 * is exercised through the harness for registration shape and the `/microagents`
 * command.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import microagents, {
  injectMicroagents,
  latestUserText,
  MAX_TOTAL_BYTES,
  parseMicroagent,
  scanMicroagents,
  triggered,
  type Microagent,
} from "../src/extensions/microagents.js";
import type { CommandContext } from "../src/kernel/commands.js";
import { envOnlyConfig } from "../src/kernel/store.js";
import type { Message } from "../src/kernel/types.js";
import { text } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

/** A microagent file with a single-line frontmatter fence. */
function fenced(triggers: string | undefined, body: string): string {
  const front = triggers === undefined ? "name: x" : `triggers: ${triggers}`;
  return `---\n${front}\n---\n${body}`;
}

test("parseMicroagent: comma-split, trimmed, lowercased triggers; body excludes frontmatter", () => {
  const m = parseMicroagent(fenced("Kubernetes, K8s", "BODY-K8S"), "k8s");
  assert.ok(m);
  assert.deepEqual(m.triggers, ["kubernetes", "k8s"]);
  assert.equal(m.name, "k8s");
  assert.ok(!m.body.includes("triggers:"));
  assert.ok(m.body.includes("BODY-K8S"));
});

test("parseMicroagent: no triggers, empty triggers, or no fence returns undefined", () => {
  assert.equal(parseMicroagent(fenced(undefined, "body"), "x"), undefined);
  assert.equal(parseMicroagent(fenced("   ,  , ", "body"), "x"), undefined);
  assert.equal(parseMicroagent("triggers: cat\n\nbody", "x"), undefined);
});

test("triggered: case-insensitive, whole-word", () => {
  assert.equal(triggered("scale KUBERNETES now", ["kubernetes"]), true);
  assert.equal(triggered("list the category", ["cat"]), false);
  assert.equal(triggered("feed the cat.", ["cat"]), true);
  assert.equal(triggered("use k8s here", ["k8s"]), true);
  assert.equal(triggered("xk8sy", ["k8s"]), false);
});

test("latestUserText: last user message's text blocks, joined; tool/assistant ignored", () => {
  const messages: Message[] = [
    text("user", "a kubernetes q"),
    text("assistant", "x"),
    { role: "tool", content: [{ type: "tool_result", toolCallId: "t", content: "r" }] },
  ];
  assert.equal(latestUserText(messages), "a kubernetes q");

  assert.equal(latestUserText([text("assistant", "x")]), undefined);

  const multi: Message[] = [
    { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
  ];
  assert.equal(latestUserText(multi), "one two");
});

test("injectMicroagents: trigger fires (AC-1/AC-3/AC-4); no match returns input by reference (AC-2)", () => {
  const m: Microagent = { name: "k8s", triggers: ["kubernetes", "k8s"], body: "BODY-K8S" };

  const hit = injectMicroagents([text("user", "how do I scale kubernetes?")], [m]);
  assert.equal(hit[0]?.role, "system");
  const note = hit[0]?.content[0];
  assert.ok(note && note.type === "text" && note.text.includes("BODY-K8S"));

  const input = [text("user", "how do I scale a database?")];
  const out = injectMicroagents(input, [m]);
  assert.equal(out, input);
});

test("injectMicroagents: no user message returns input by reference", () => {
  const m: Microagent = { name: "k8s", triggers: ["kubernetes", "k8s"], body: "BODY-K8S" };
  const input: Message[] = [
    text("assistant", "deploying to kubernetes"),
    { role: "tool", content: [{ type: "tool_result", toolCallId: "t", content: "kubernetes" }] },
  ];
  const out = injectMicroagents(input, [m]);
  assert.equal(out, input);
});

test("injectMicroagents: AC-5 latest-user anchoring (last message a tool_result)", () => {
  const m: Microagent = { name: "k8s", triggers: ["kubernetes"], body: "BODY-K8S" };
  const messages: Message[] = [
    text("user", "deploy to kubernetes"),
    text("assistant", "ok"),
    { role: "tool", content: [{ type: "tool_result", toolCallId: "t", content: "r" }] },
  ];
  const out = injectMicroagents(messages, [m]);
  const note = out[0]?.content[0];
  assert.ok(note && note.type === "text" && note.text.includes("BODY-K8S"));
});

test("injectMicroagents: AC-6 size cap — both small fit; oversize prefix-fill stops whole", () => {
  const small: Microagent[] = [
    { name: "a", triggers: ["go"], body: "AAA" },
    { name: "b", triggers: ["go"], body: "BBB" },
  ];
  const both = injectMicroagents([text("user", "go now")], small);
  const bothText = both[0]?.content[0];
  assert.ok(bothText && bothText.type === "text");
  assert.ok(bothText.text.includes("AAA") && bothText.text.includes("BBB"));

  const aBody = "A".repeat(MAX_TOTAL_BYTES - 100);
  const bBody = "B".repeat(200);
  const big: Microagent[] = [
    { name: "a", triggers: ["go"], body: aBody },
    { name: "b", triggers: ["go"], body: bBody },
  ];
  const out = injectMicroagents([text("user", "go now")], big);
  const noteText = out[0]?.content[0];
  assert.ok(noteText && noteText.type === "text");
  assert.ok(noteText.text.includes(aBody));
  assert.ok(!noteText.text.includes(bBody));
});

test("injectMicroagents: AC-8 kill switch returns input by reference", () => {
  const m: Microagent = { name: "k8s", triggers: ["kubernetes"], body: "BODY-K8S" };
  const input = [text("user", "scale kubernetes")];
  const saved = process.env.EAGENT_MICROAGENTS;
  process.env.EAGENT_MICROAGENTS = "off";
  try {
    const out = injectMicroagents(input, [m], envOnlyConfig());
    assert.equal(out, input);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_MICROAGENTS;
    else process.env.EAGENT_MICROAGENTS = saved;
  }
});

test("scanMicroagents: triggered file returned, trigger-less absent, missing dir is []", () => {
  const dir = mkdtempSync(join(tmpdir(), "microagents-scan-"));
  try {
    writeFileSync(join(dir, "k8s.md"), fenced("kubernetes, k8s", "BODY-K8S"));
    writeFileSync(join(dir, "notes.md"), fenced(undefined, "no triggers"));
    const found = scanMicroagents(dir);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.name, "k8s");
    assert.deepEqual(found[0]?.triggers, ["kubernetes", "k8s"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(scanMicroagents(join(tmpdir(), "microagents-does-not-exist-xyz")), []);
});

test("AC-1 registration shape + AC-9 command", async () => {
  const savedDir = process.env.EAGENT_MICROAGENTS_DIR;
  const dir = mkdtempSync(join(tmpdir(), "microagents-cmd-"));
  try {
    const h = makeHarness();
    const toolsBefore = h.agent.tools.list().length;
    const commandsBefore = h.commands.list().length;
    const hooksBefore = h.agent.hooks.listenerCount("transformContext");

    await h.host.use("microagents", microagents);

    assert.equal(h.agent.tools.list().length, toolsBefore);
    assert.equal(h.commands.list().length, commandsBefore + 1);
    assert.equal(h.agent.hooks.listenerCount("transformContext"), hooksBefore + 1);

    const cmd = h.commands.get("microagents");
    assert.ok(cmd);

    const run = async (): Promise<string[]> => {
      const lines: string[] = [];
      const ctx: CommandContext = { agent: h.agent, args: "", print: (l) => lines.push(l) };
      await cmd.run(ctx);
      return lines;
    };

    writeFileSync(join(dir, "k8s.md"), fenced("kubernetes, k8s", "BODY-K8S"));
    process.env.EAGENT_MICROAGENTS_DIR = dir;
    const listed = (await run()).join("\n");
    assert.match(listed, /k8s/);
    assert.match(listed, /kubernetes/);

    const empty = mkdtempSync(join(tmpdir(), "microagents-empty-"));
    process.env.EAGENT_MICROAGENTS_DIR = empty;
    const noneLines = (await run()).join("\n");
    assert.match(noneLines, /no microagents/);
    rmSync(empty, { recursive: true, force: true });
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_MICROAGENTS_DIR;
    else process.env.EAGENT_MICROAGENTS_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Layered home+project resolution (D5; AC1-3, AC4, KDD1)
// ---------------------------------------------------------------------------
//
// Invariant: with no `microagents.dir` override, microagents resolve from BOTH
// `~/.eagent/microagents` (the NEW home tier) and the workspace/project root,
// merged by name, project-wins. An explicit `EAGENT_MICROAGENTS_DIR` override
// reverts to single-source (KDD1; the empty-override "no microagents" test above
// is the regression pin). These tests isolate `process.env.HOME` (home tier),
// `EAGENT_WORKSPACE`, and cwd so the dev's real `~/.eagent/microagents` cannot
// bleed in. Injection (via `transformContext`) exercises the activate-time cache
// fill; the `/microagents` command exercises the re-scan.

test("microagents layered: home tier (NEW) injects + both tiers list; project wins (AC1-3)", async () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.EAGENT_MICROAGENTS_DIR;
  const savedWorkspace = process.env.EAGENT_WORKSPACE;
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "microagents-layered-"));
  const homeMa = join(root, "home", ".eagent", "microagents");
  const projMa = join(root, "project", ".eagent", "microagents");
  mkdirSync(homeMa, { recursive: true });
  mkdirSync(projMa, { recursive: true });
  process.env.HOME = join(root, "home"); // homedir() reads $HOME on POSIX
  delete process.env.EAGENT_MICROAGENTS_DIR; // no override => layered default
  delete process.env.EAGENT_WORKSPACE; // project root falls back to cwd
  process.chdir(join(root, "project"));
  try {
    writeFileSync(join(homeMa, "home-agent.md"), `---\nname: home-agent\ntriggers: homekw\n---\nHOME-BODY`);
    writeFileSync(join(projMa, "proj-agent.md"), `---\nname: proj-agent\ntriggers: projkw\n---\nPROJ-BODY`);

    // (1) Injection through transformContext exercises the activate-time cache
    // fill site — the home-tier body must reach the outbound request.
    let injectedHomeBody = false;
    const h = makeHarness({
      responder: (req) => {
        injectedHomeBody = req.messages.some(
          (m) => m.role === "system" && m.content.some((b) => b.type === "text" && b.text.includes("HOME-BODY")),
        );
        return { text: "ok" };
      },
      fallback: "allow",
    });
    await h.host.use("microagents", microagents);
    await h.agent.run("tell me about homekw");
    assert.ok(injectedHomeBody, "the home-tier (NEW) microagent body is injected");

    // (2) The `/microagents` re-scan lists BOTH tiers.
    const cmd = h.commands.get("microagents")!;
    const lines: string[] = [];
    const ctx: CommandContext = { agent: h.agent, args: "", print: (l) => lines.push(l) };
    await cmd.run(ctx);
    const listed = lines.join("\n");
    assert.match(listed, /home-agent/, "the home-tier microagent (NEW tier) is listed");
    assert.match(listed, /proj-agent/, "the project-tier microagent is still listed");
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.EAGENT_MICROAGENTS_DIR;
    else process.env.EAGENT_MICROAGENTS_DIR = savedDir;
    if (savedWorkspace === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = savedWorkspace;
    rmSync(root, { recursive: true, force: true });
  }
});

test("microagents override: EAGENT_MICROAGENTS_DIR is single-source — home/project tiers are NOT read (AC4/KDD1)", async () => {
  const savedHome = process.env.HOME;
  const savedDir = process.env.EAGENT_MICROAGENTS_DIR;
  const savedWorkspace = process.env.EAGENT_WORKSPACE;
  const savedCwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "microagents-override-"));
  const homeMa = join(root, "home", ".eagent", "microagents");
  const projMa = join(root, "project", ".eagent", "microagents");
  const overrideDir = join(root, "override");
  mkdirSync(homeMa, { recursive: true });
  mkdirSync(projMa, { recursive: true });
  mkdirSync(overrideDir, { recursive: true });
  process.env.HOME = join(root, "home");
  process.env.EAGENT_MICROAGENTS_DIR = overrideDir; // override => single-source
  delete process.env.EAGENT_WORKSPACE;
  process.chdir(join(root, "project"));
  try {
    writeFileSync(join(overrideDir, "only.md"), `---\nname: only\ntriggers: onlykw\n---\nONLY-BODY`);
    writeFileSync(join(homeMa, "home-agent.md"), `---\nname: home-agent\ntriggers: homekw\n---\nHOME-BODY`);
    writeFileSync(join(projMa, "proj-agent.md"), `---\nname: proj-agent\ntriggers: projkw\n---\nPROJ-BODY`);

    const h = makeHarness();
    await h.host.use("microagents", microagents);
    const cmd = h.commands.get("microagents")!;
    const lines: string[] = [];
    const ctx: CommandContext = { agent: h.agent, args: "", print: (l) => lines.push(l) };
    await cmd.run(ctx);
    const listed = lines.join("\n");

    assert.match(listed, /only/, "the override dir is read");
    assert.doesNotMatch(listed, /home-agent/, "the home tier is NOT read under an override");
    assert.doesNotMatch(listed, /proj-agent/, "the project tier is NOT read under an override");
  } finally {
    process.chdir(savedCwd);
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env.EAGENT_MICROAGENTS_DIR;
    else process.env.EAGENT_MICROAGENTS_DIR = savedDir;
    if (savedWorkspace === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = savedWorkspace;
    rmSync(root, { recursive: true, force: true });
  }
});
