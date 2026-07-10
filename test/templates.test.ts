/**
 * Tests for the `templates` extension — the named, file-based, reusable agent
 * specification: parse + validate, single-inheritance resolution, opt-in catalog
 * injection, the delegate path (`spawn_template`) with its recursion guard, the
 * become path (`/template use|reset` + the allow-list veto), and registration.
 *
 * The pure functions are exercised directly; the extension is driven through the
 * harness for the delegate run, the become command, and the registration shape.
 * Template files are written to per-test temp dirs pointed at via
 * `EAGENT_TEMPLATES_DIR`; every `process.env` mutation is restored in `finally`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import templates, {
  buildTemplateChild,
  injectCatalog,
  parseTemplate,
  resolveTemplate,
  scanTemplates,
  templateChildRegistry,
  validateTemplate,
  type ResolvedTemplate,
  type Template,
} from "../src/extensions/templates.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { envOnlyConfig } from "../src/kernel/store.js";
import type { CommandContext } from "../src/kernel/commands.js";
import { defineTool } from "../src/kernel/define.js";
import type { ToolDecision } from "../src/kernel/events.js";
import { ProviderRegistry } from "../src/kernel/registry.js";
import type {
  CompletionRequest,
  Logger,
  Message,
  Provider,
  StreamEvent,
  Tool,
  ToolCallBlock,
  ToolContext,
  UI,
} from "../src/kernel/types.js";
import { text } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { autoUI, lastText, makeHarness, RenamedProvider, silentLogger } from "./helpers.js";

/** A template file with single-line frontmatter and a markdown body. */
function fenced(front: Record<string, string>, body: string): string {
  const lines = Object.entries(front).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/** A trivial named tool, for child-registry assertions. */
function tool(name: string): Tool {
  return defineTool({ name, description: "x", execute: () => ({ content: "" }) });
}

/** Run a registered command, capturing printed lines. */
async function runCommand(
  cmd: { run(ctx: CommandContext): void | Promise<void> },
  agent: CommandContext["agent"],
  args: string,
): Promise<string[]> {
  const lines: string[] = [];
  await cmd.run({ agent, args, print: (l) => lines.push(l) });
  return lines;
}

// ---------------------------------------------------------------------------
// T1 — parse + validate (AC-1, AC-2)
// ---------------------------------------------------------------------------

test("T1 parseTemplate: reads keys, comma-lists, coerces maxTurns, carries thinking, body after fence (AC-1)", () => {
  const md = fenced(
    {
      name: "reviewer",
      description: "A careful code reviewer.",
      extends: "base",
      model: "big-model",
      provider: "critic",
      thinking: "high",
      maxTurns: "5",
      tools: "read, grep , search",
      capabilities: "fs:read , shell:exec",
    },
    "You are a reviewer.\nBe terse.",
  );
  const t = parseTemplate(md, "fallback");
  assert.equal(t.name, "reviewer");
  assert.equal(t.description, "A careful code reviewer.");
  assert.equal(t.extends, "base");
  assert.equal(t.model, "big-model");
  assert.equal(t.provider, "critic");
  assert.equal(t.thinking, "high");
  assert.strictEqual(t.maxTurns, 5);
  assert.deepEqual(t.tools, ["read", "grep", "search"]);
  assert.deepEqual(t.capabilities, ["fs:read", "shell:exec"]);
  assert.equal(t.systemPrompt, "You are a reviewer.\nBe terse.");
});

test("T1 parseTemplate: name falls back; no fence degrades to empty frontmatter + whole body, never throws (AC-1)", () => {
  const t = parseTemplate(fenced({ description: "d" }, "BODY"), "myfile");
  assert.equal(t.name, "myfile");

  const noFence = parseTemplate("just a prose body, no fence", "fb");
  assert.equal(noFence.name, "fb");
  assert.equal(noFence.description, "");
  assert.equal(noFence.systemPrompt, "just a prose body, no fence");
});

test("T1 validateTemplate: [] for a well-formed template", () => {
  const t: Template = { name: "code-reviewer", description: "Reviews code.", systemPrompt: "x" };
  assert.deepEqual(validateTemplate(t), []);
});

test("T1 validateTemplate: rejects non-kebab name, angle brackets, bad thinking, bad maxTurns, unknown key (AC-2)", () => {
  assert.ok(validateTemplate({ name: "Bad_Name", description: "d", systemPrompt: "" }).length > 0);
  // The angle-bracket injection vector in the description.
  assert.ok(validateTemplate({ name: "a", description: "has <tag>", systemPrompt: "" }).length > 0);
  assert.ok(validateTemplate({ name: "a", description: "d>", systemPrompt: "" }).length > 0);
  assert.ok(validateTemplate({ name: "a", description: "", systemPrompt: "" }).length > 0);
  assert.ok(
    validateTemplate({ name: "a", description: "d", thinking: "ultra" as never, systemPrompt: "" }).length > 0,
  );
  assert.ok(validateTemplate({ name: "a", description: "d", maxTurns: 0, systemPrompt: "" }).length > 0);
  assert.ok(validateTemplate({ name: "a", description: "d", maxTurns: 1.5, systemPrompt: "" }).length > 0);
  assert.ok(
    validateTemplate({ name: "a", description: "d", systemPrompt: "", smuggled: "x" } as Template).length > 0,
  );
});

test("T1 scanTemplates: valid sorted, invalid excluded, missing dir => [] (AC-2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "templates-scan-"));
  try {
    writeFileSync(join(dir, "b.md"), fenced({ name: "bravo", description: "B." }, "body-b"));
    writeFileSync(join(dir, "a.md"), fenced({ name: "alpha", description: "A." }, "body-a"));
    // Invalid: angle bracket in description — must be skipped.
    writeFileSync(join(dir, "evil.md"), fenced({ name: "evil", description: "<hidden>" }, "body-e"));
    // Invalid: unknown key.
    writeFileSync(join(dir, "junk.md"), fenced({ name: "junk", description: "J.", bogus: "x" }, "body-j"));

    const found = scanTemplates(dir);
    assert.deepEqual(
      found.map((t) => t.name),
      ["alpha", "bravo"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.deepEqual(scanTemplates(join(tmpdir(), "templates-does-not-exist-xyz")), []);
});

// ---------------------------------------------------------------------------
// T2 — resolve + inheritance (AC-3, AC-4, AC-5, AC-6)
// ---------------------------------------------------------------------------

test("T2 resolveTemplate: no extends returns own fields (AC-3)", () => {
  const solo: Template = {
    name: "solo",
    description: "S.",
    model: "m",
    thinking: "low",
    tools: ["read"],
    systemPrompt: "solo body",
  };
  const r = resolveTemplate("solo", [solo]);
  assert.ok(r.ok);
  assert.equal(r.template.name, "solo");
  assert.equal(r.template.model, "m");
  assert.equal(r.template.thinking, "low");
  assert.deepEqual(r.template.tools, ["read"]);
  assert.equal(r.template.systemPrompt, "solo body");
});

test("T2 resolveTemplate: 2-level scalar override/inherit, list union, prompt concat (AC-4)", () => {
  const base: Template = {
    name: "base",
    description: "Base.",
    model: "base-model",
    thinking: "low",
    tools: ["read", "grep"],
    capabilities: ["fs:read"],
    systemPrompt: "BASE",
  };
  const child: Template = {
    name: "child",
    description: "Child.",
    extends: "base",
    model: "child-model", // overrides
    // thinking absent => inherited
    tools: ["grep", "edit"], // union with base, de-duplicated
    capabilities: ["shell:exec"],
    systemPrompt: "CHILD",
  };
  const r = resolveTemplate("child", [base, child]);
  assert.ok(r.ok);
  assert.equal(r.template.model, "child-model");
  assert.equal(r.template.thinking, "low");
  assert.deepEqual(r.template.tools, ["read", "grep", "edit"]);
  assert.deepEqual(r.template.capabilities, ["fs:read", "shell:exec"]);
  assert.equal(r.template.systemPrompt, "BASE\n\nCHILD");
});

test("T2 resolveTemplate: 3-level concat is root-first (AC-4)", () => {
  const root: Template = { name: "root", description: "R.", systemPrompt: "ROOT" };
  const mid: Template = { name: "mid", description: "M.", extends: "root", systemPrompt: "MID" };
  const leaf: Template = { name: "leaf", description: "L.", extends: "mid", systemPrompt: "LEAF" };
  const r = resolveTemplate("leaf", [root, mid, leaf]);
  assert.ok(r.ok);
  assert.equal(r.template.systemPrompt, "ROOT\n\nMID\n\nLEAF");
});

test("T2 resolveTemplate: a cycle returns a typed error naming the cycle and terminates (AC-5)", () => {
  const a: Template = { name: "a", description: "A.", extends: "b", systemPrompt: "A" };
  const b: Template = { name: "b", description: "B.", extends: "a", systemPrompt: "B" };
  const r = resolveTemplate("a", [a, b]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /cycle/i.test(r.error));
});

test("T2 resolveTemplate: an unknown parent returns a typed error naming it (AC-6)", () => {
  const child: Template = { name: "child", description: "C.", extends: "nope", systemPrompt: "C" };
  const r = resolveTemplate("child", [child]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && /nope/.test(r.error));
});

// ---------------------------------------------------------------------------
// T3 — catalog injection opt-in (AC-7)
// ---------------------------------------------------------------------------

test("T3 injectCatalog: on + >=1 template => new array with ephemeral system note (AC-7)", () => {
  const catalog: Template[] = [
    { name: "reviewer", description: "Reviews code.", systemPrompt: "x" },
    { name: "writer", description: "Writes docs.", systemPrompt: "y" },
  ];
  const input = [text("user", "hi")];
  const out = injectCatalog(input, catalog, true);
  assert.notEqual(out, input);
  const note = out[0];
  assert.ok(note && note.role === "system");
  assert.equal(note.meta?.ephemeral, true);
  assert.equal(note.meta?.source, "templates");
  const body = note.content[0];
  assert.ok(body && body.type === "text");
  assert.match(body.text, /- reviewer: Reviews code\./);
  assert.match(body.text, /- writer: Writes docs\./);
});

test("T3 injectCatalog: off, or empty catalog => same array reference (AC-7)", () => {
  const catalog: Template[] = [{ name: "a", description: "A.", systemPrompt: "x" }];
  const input = [text("user", "hi")];
  assert.equal(injectCatalog(input, catalog, false), input);
  assert.equal(injectCatalog(input, [], true), input);
});

// ---------------------------------------------------------------------------
// T4 — child registry + recursion guard (AC-9 registry half)
// ---------------------------------------------------------------------------

test("T4 templateChildRegistry: allowlist keeps exactly the named tools (AC-9)", () => {
  const parent = [tool("read"), tool("write"), tool("edit"), tool("spawn_agent"), tool("spawn_template")];
  const reg = templateChildRegistry(parent, ["read", "write"]);
  assert.equal(reg.has("read"), true);
  assert.equal(reg.has("write"), true);
  assert.equal(reg.has("edit"), false);
  assert.equal(reg.list().length, 2);
});

test("T4 templateChildRegistry: no allowlist => all parent tools except spawn-class tools (AC-9)", () => {
  const parent = [
    tool("read"),
    tool("write"),
    tool("edit"),
    capTool("spawn_agent", ["agent:spawn"]),
    capTool("spawn_template", ["agent:spawn"]),
    // A spawn tool OUTSIDE the old {spawn_agent, spawn_template} name set: the
    // capability strip must remove it too (a name-based strip would let it survive).
    capTool("run_team", ["agent:spawn"]),
  ];
  const reg = templateChildRegistry(parent);
  assert.equal(reg.has("read"), true);
  assert.equal(reg.has("write"), true);
  assert.equal(reg.has("edit"), true);
  assert.equal(reg.has("spawn_agent"), false);
  assert.equal(reg.has("spawn_template"), false);
  assert.equal(
    reg.has("run_team"),
    false,
    "a spawn-class tool outside the old name set is stripped by capability",
  );
});

// ---------------------------------------------------------------------------
// T5 — kill switch (AC-8)
// ---------------------------------------------------------------------------

test("T5 EAGENT_TEMPLATES=off: injectCatalog returns input by reference (AC-8)", () => {
  const saved = process.env.EAGENT_TEMPLATES;
  process.env.EAGENT_TEMPLATES = "off";
  try {
    const catalog: Template[] = [{ name: "a", description: "A.", systemPrompt: "x" }];
    const input = [text("user", "hi")];
    assert.equal(injectCatalog(input, catalog, true, envOnlyConfig()), input);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_TEMPLATES;
    else process.env.EAGENT_TEMPLATES = saved;
  }
});

test("T5 EAGENT_TEMPLATES=off: spawn_template errors disabled; /template use refuses (AC-8)", async () => {
  const savedOff = process.env.EAGENT_TEMPLATES;
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-kill-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  process.env.EAGENT_TEMPLATES = "off";
  try {
    writeFileSync(join(dir, "spec.md"), fenced({ name: "spec", description: "S." }, "SPEC BODY"));

    let spawned = false;
    const h = makeHarness({ fallback: "allow" });
    h.provider.script(() => {
      if (!spawned) {
        spawned = true;
        return { toolCalls: [{ name: "spawn_template", arguments: { template: "spec", prompt: "go" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);

    await h.agent.run("kick off");
    const result = toolResults(h.agent.messages)[0]!;
    assert.equal(result.isError, true);
    assert.match(result.content, /disabled/i);

    const cmd = h.commands.get("template")!;
    const lines = await runCommand(cmd, h.agent, "use spec");
    assert.match(lines.join("\n"), /disabled/i);
  } finally {
    if (savedOff === undefined) delete process.env.EAGENT_TEMPLATES;
    else process.env.EAGENT_TEMPLATES = savedOff;
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T6 — delegate end-to-end (AC-9 run half)
// ---------------------------------------------------------------------------

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): { content: string; isError?: boolean }[] {
  const out: { content: string; isError?: boolean }[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push({ content: b.content, isError: b.isError });
  }
  return out;
}

test("T6 spawn_template: a template runs a MockProvider child and returns its final answer (AC-9)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-run-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(join(dir, "reader.md"), fenced({ name: "reader", description: "R.", tools: "read" }, "READER PERSONA"));

    let spawned = false;
    const h = makeHarness({ fallback: "allow" });
    h.provider.script((req) => {
      if (req.systemPrompt.includes("READER PERSONA")) {
        return { text: "child-final-answer" };
      }
      if (!spawned) {
        spawned = true;
        return { toolCalls: [{ name: "spawn_template", arguments: { template: "reader", prompt: "analyze" } }] };
      }
      return { text: "parent-done" };
    });
    await h.host.use("templates", templates);

    await h.agent.run("kick off");

    const result = toolResults(h.agent.messages)[0]!;
    assert.equal(result.isError, undefined);
    assert.match(result.content, /child-final-answer/);
    assert.equal(lastText(h.agent), "parent-done");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T6 spawn_template: provider: <registered> builds the child against that provider (AC-9)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-prov-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(
      join(dir, "critique.md"),
      fenced({ name: "critique", description: "C.", provider: "critic" }, "CRITIC PERSONA"),
    );

    let parentSpawned = false;
    let criticChildCalls = 0;
    let parentChildCalls = 0;
    const parentMock = new MockProvider((req) => {
      if (req.systemPrompt.includes("CRITIC PERSONA")) {
        parentChildCalls++;
        return { text: "parent-child" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "spawn_template", arguments: { template: "critique", prompt: "review" } }] };
      }
      return { text: "parent-done" };
    });
    const criticMock = new MockProvider((req) => {
      if (req.systemPrompt.includes("CRITIC PERSONA")) {
        criticChildCalls++;
        return { text: "critic-child" };
      }
      return { text: "" };
    });

    const h = makeHarness({ fallback: "allow" });
    h.agent.providers.register(parentMock, { default: true });
    h.agent.providers.register(new RenamedProvider("critic", criticMock));
    await h.host.use("templates", templates);

    await h.agent.run("kick off");

    const result = toolResults(h.agent.messages)[0]!;
    assert.match(result.content, /critic-child/, "child ran on the critic provider");
    assert.equal(criticChildCalls, 1);
    assert.equal(parentChildCalls, 0, "the parent provider was NOT used for the child");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T6 recursion guard (behavioral): a delegated child cannot spawn_template (AC-9)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-guard-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(join(dir, "spec.md"), fenced({ name: "spec", description: "S." }, "SPEC PERSONA"));

    let parentSpawned = false;
    let childTried = false;
    const provider = new MockProvider((req) => {
      if (req.systemPrompt.includes("SPEC PERSONA")) {
        if (!childTried) {
          childTried = true;
          // The child attempts to re-spawn; the tool is absent from its registry.
          return { toolCalls: [{ name: "spawn_template", arguments: { template: "spec", prompt: "deeper" } }] };
        }
        return { text: "child-done" };
      }
      if (!parentSpawned) {
        parentSpawned = true;
        return { toolCalls: [{ name: "spawn_template", arguments: { template: "spec", prompt: "go" } }] };
      }
      return { text: "parent-done" };
    });

    const h = makeHarness({ fallback: "allow" });
    h.agent.providers.register(provider, { default: true });
    await h.host.use("templates", templates);

    await h.agent.run("kick off");

    const result = toolResults(h.agent.messages)[0]!;
    assert.equal(result.isError, undefined);
    assert.match(result.content, /child-done/);
    assert.equal(lastText(h.agent), "parent-done");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T7 — become + reset, incl. use->use->reset (AC-10)
// ---------------------------------------------------------------------------

test("T7 /template use sets fields (not provider); veto blocks outside allow-list; reset restores pristine (AC-10)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-become-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(
      join(dir, "specialist.md"),
      fenced(
        { name: "specialist", description: "Sp.", model: "spec-model", thinking: "high", maxTurns: "3", tools: "read" },
        "SPECIALIST PROMPT",
      ),
    );
    writeFileSync(
      join(dir, "other.md"),
      fenced({ name: "other", description: "Ot.", model: "other-model", tools: "grep" }, "OTHER PROMPT"),
    );

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("templates", templates);

    // Pristine baseline (before any use).
    const pristine = {
      systemPrompt: h.agent.systemPrompt,
      model: h.agent.model,
      thinking: h.agent.thinking,
      maxTurns: h.agent.maxTurns,
      providerName: h.agent.providerName,
    };

    const cmd = h.commands.get("template")!;
    await runCommand(cmd, h.agent, "use specialist");

    assert.equal(h.agent.systemPrompt, "SPECIALIST PROMPT");
    assert.equal(h.agent.model, "spec-model");
    assert.equal(h.agent.thinking, "high");
    assert.equal(h.agent.maxTurns, 3);
    assert.equal(h.agent.providerName, pristine.providerName, "become never swaps the provider");

    // The veto: a tool outside the allow-list (read) is blocked.
    const decideOn = async (name: string): Promise<ToolDecision> => {
      const call: ToolCallBlock = { type: "tool_call", id: "t", name, arguments: {} };
      return h.agent.hooks.apply(
        "beforeToolCall",
        { block: false, arguments: {} },
        { call },
        (d) => d.block,
      );
    };
    assert.equal((await decideOn("write")).block, true, "a non-allow-listed tool is blocked while active");
    assert.equal((await decideOn("read")).block, false, "an allow-listed tool passes");

    // use -> use does not re-record the baseline.
    await runCommand(cmd, h.agent, "use other");
    assert.equal(h.agent.systemPrompt, "OTHER PROMPT");
    assert.equal(h.agent.model, "other-model");

    // reset returns to the pristine pre-first-use values and disarms the veto.
    await runCommand(cmd, h.agent, "reset");
    assert.equal(h.agent.systemPrompt, pristine.systemPrompt);
    assert.equal(h.agent.model, pristine.model);
    assert.equal(h.agent.thinking, pristine.thinking);
    assert.equal(h.agent.maxTurns, pristine.maxTurns);
    assert.equal((await decideOn("write")).block, false, "the previously blocked tool is allowed again after reset");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T7 become with NO tools allow-list leaves the veto disarmed — an arbitrary tool is not blocked (design §4.5 / §8)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-become-notools-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    // A persona-only template: no `tools` frontmatter — a very common shape.
    writeFileSync(
      join(dir, "persona.md"),
      fenced({ name: "persona", description: "Be a careful reviewer." }, "PERSONA PROMPT"),
    );

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("templates", templates);

    const cmd = h.commands.get("template")!;
    await runCommand(cmd, h.agent, "use persona");
    assert.equal(h.agent.systemPrompt, "PERSONA PROMPT", "the persona prompt is adopted");

    const decideOn = async (name: string): Promise<ToolDecision> => {
      const call: ToolCallBlock = { type: "tool_call", id: "t", name, arguments: {} };
      return h.agent.hooks.apply("beforeToolCall", { block: false, arguments: {} }, { call }, (d) => d.block);
    };
    // With no allow-list the veto stays disarmed: an arbitrary tool must NOT be
    // blocked (the old `active = { tools: [] }` bricked every call).
    assert.equal((await decideOn("read")).block, false, "no allow-list => an arbitrary tool is not blocked");
    assert.equal((await decideOn("anything")).block, false, "no allow-list => even an unknown tool is not blocked");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T7 /template show renders resolved fields and the 'use delegate' become caveat (design §4.5)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-show-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(
      join(dir, "specialist.md"),
      fenced(
        { name: "specialist", description: "Sp.", model: "spec-model", tools: "read, grep" },
        "SPECIALIST PROMPT",
      ),
    );

    const h = makeHarness({ fallback: "allow" });
    await h.host.use("templates", templates);

    const out = (await runCommand(h.commands.get("template")!, h.agent, "show specialist")).join("\n");
    assert.match(out, /name:\s+specialist/, "prints the resolved name field");
    assert.match(out, /model:\s+spec-model/, "prints the resolved model field");
    assert.match(out, /tools:\s+read, grep/, "prints the resolved tools allow-list");
    assert.match(out, /for true scoping, use delegate/, "prints the become->delegate scoping caveat");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T8 — registration + commands (AC-11)
// ---------------------------------------------------------------------------

test("T8 registration: one tool, /template + /templates, one transformContext + one beforeToolCall (AC-11)", async () => {
  const savedDir = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "templates-reg-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(join(dir, "alpha.md"), fenced({ name: "alpha", description: "A." }, "ALPHA"));
    writeFileSync(join(dir, "beta.md"), fenced({ name: "beta", description: "B." }, "BETA"));

    const h = makeHarness({ fallback: "allow" });
    const toolsBefore = h.agent.tools.list().length;
    const commandsBefore = h.commands.list().length;
    const ctxBefore = h.agent.hooks.listenerCount("transformContext");
    const vetoBefore = h.agent.hooks.listenerCount("beforeToolCall");

    await h.host.use("templates", templates);

    assert.equal(h.agent.tools.list().length, toolsBefore + 1, "exactly one new tool");
    assert.ok(h.agent.tools.get("spawn_template"));
    assert.equal(h.commands.list().length, commandsBefore + 2, "/template + /templates alias");
    assert.ok(h.commands.get("template"));
    assert.ok(h.commands.get("templates"));
    assert.equal(h.agent.hooks.listenerCount("transformContext"), ctxBefore + 1, "exactly one transformContext");
    assert.equal(h.agent.hooks.listenerCount("beforeToolCall"), vetoBefore + 1, "exactly one beforeToolCall");

    // /templates prints the catalog names.
    const listed = (await runCommand(h.commands.get("templates")!, h.agent, "")).join("\n");
    assert.match(listed, /alpha/);
    assert.match(listed, /beta/);

    // catalog on then off flips the store flag read by injectCatalog.
    const tmplCmd = h.commands.get("template")!;
    await runCommand(tmplCmd, h.agent, "catalog on");
    // With the flag on, the transformContext hook injects the ephemeral note.
    const onMsgs = await h.agent.hooks.apply(
      "transformContext",
      [text("user", "hi")],
      { turn: 0, model: "mock" },
    );
    assert.equal(onMsgs[0]?.meta?.source, "templates");

    await runCommand(tmplCmd, h.agent, "catalog off");
    const offInput = [text("user", "hi")];
    const offMsgs = await h.agent.hooks.apply(
      "transformContext",
      offInput,
      { turn: 0, model: "mock" },
    );
    assert.equal(offMsgs, offInput, "catalog off => transform is a by-reference no-op");
  } finally {
    if (savedDir === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = savedDir;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// T9 — buildTemplateChild construct-only helper (AC-11)
// ---------------------------------------------------------------------------

/** A minimal `parent` shape for buildTemplateChild, with the given tool list. */
function parentFor(tools: Tool[]): {
  providers: ProviderRegistry;
  ui: UI;
  logger: Logger;
  capabilities: CapabilityManager;
  model: string;
  providerName: string | undefined;
  tools: Tool[];
} {
  const ui: UI = autoUI(true);
  return {
    providers: new ProviderRegistry(),
    ui,
    logger: silentLogger,
    capabilities: new CapabilityManager({ ui, fallback: "allow" }),
    model: "mock",
    providerName: undefined,
    tools,
  };
}

/** A named tool declaring the given capabilities (for the exclude-by-capability path). */
function capTool(name: string, capabilities: string[]): Tool {
  return defineTool({ name, description: "x", capabilities, execute: () => ({ content: "" }) });
}

test("T9 buildTemplateChild: no opts => child registry equals templateChildRegistry(parentTools, t.tools) (AC-11)", () => {
  const parentTools = [
    tool("read"),
    tool("write"),
    tool("edit"),
    tool("spawn_agent"),
    tool("spawn_template"),
  ];
  const t: ResolvedTemplate = {
    name: "reader",
    description: "R.",
    tools: ["read"],
    systemPrompt: "READER PERSONA",
  };

  const child = buildTemplateChild(t, parentFor(parentTools));
  const expected = templateChildRegistry(parentTools, t.tools);

  // Invariant: the closed-cycle (no-opts) child registry is unchanged by the refactor.
  assert.equal(child.tools.list().length, expected.list().length);
  for (const name of ["read", "write", "edit", "spawn_agent", "spawn_template"]) {
    assert.equal(child.tools.has(name), expected.has(name), `membership of "${name}" matches`);
  }
  assert.equal(child.tools.has("read"), true);
  assert.equal(child.tools.has("write"), false, "an allow-listed template keeps only its tools");
});

test("T9 buildTemplateChild: opts excludeCapabilities drops spawn-class tools and extraTools are added (AC-11)", () => {
  const parentTools = [
    tool("read"),
    capTool("spawn_agent", ["agent:spawn"]),
    capTool("plain-write", ["fs:write"]),
  ];
  const extra = tool("board");
  const t: ResolvedTemplate = { name: "member", description: "M.", systemPrompt: "MEMBER" };

  const child = buildTemplateChild(t, parentFor(parentTools), {
    excludeCapabilities: ["agent:spawn"],
    extraTools: [extra],
  });

  assert.equal(child.tools.has("spawn_agent"), false, "agent:spawn tool is excluded");
  assert.equal(child.tools.has("plain-write"), true, "an fs:write-only tool is retained (intersection, not subset)");
  assert.equal(child.tools.has("read"), true);
  assert.equal(child.tools.has("board"), true, "extraTools are registered");
});

test("T9 buildTemplateChild: maxTurnsCeiling caps a large template maxTurns and floors at the template's own (AC-11)", () => {
  const parentTools = [tool("read")];

  const capped = buildTemplateChild(
    { name: "big", description: "B.", maxTurns: 99, systemPrompt: "BIG" },
    parentFor(parentTools),
    { maxTurnsCeiling: 8 },
  );
  assert.equal(capped.maxTurns, 8, "maxTurns 99 is capped to the ceiling 8");

  const underCeiling = buildTemplateChild(
    { name: "small", description: "S.", maxTurns: 4, systemPrompt: "SMALL" },
    parentFor(parentTools),
    { maxTurnsCeiling: 8 },
  );
  assert.equal(underCeiling.maxTurns, 4, "a template maxTurns below the ceiling is kept");
});

// ---------------------------------------------------------------------------
// Regression: a child's final text concatenates ALL text blocks (AC live-1)
// ---------------------------------------------------------------------------

/**
 * A provider that returns one assistant message whose content is
 * [text(""), thinking, text("REAL ANSWER")] — the shape some models (e.g. GLM
 * via an Anthropic-compatible proxy) emit: an empty leading text block before
 * the thinking block and the real answer. `find(first text block)` would pick
 * the empty one; the fix concatenates all text blocks.
 */
class LeadingEmptyTextProvider implements Provider {
  readonly name = "mock";
  // eslint-disable-next-line require-yield
  async *stream(_req: CompletionRequest): AsyncIterable<StreamEvent> {
    const message: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "" },
        { type: "thinking", thinking: "no tools needed" },
        { type: "text", text: "REAL ANSWER" },
      ],
    };
    yield { type: "done", message, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

test("spawn_template: a child's final text uses all text blocks, not just the first (empty-leading-block regression)", async () => {
  const saved = process.env.EAGENT_TEMPLATES_DIR;
  const dir = mkdtempSync(join(tmpdir(), "tmpl-blocks-"));
  process.env.EAGENT_TEMPLATES_DIR = dir;
  try {
    writeFileSync(join(dir, "answerer.md"), fenced({ name: "answerer", description: "A." }, "You answer."));
    const h = makeHarness({ fallback: "allow" });
    h.agent.providers.register(new LeadingEmptyTextProvider(), { default: true });
    await h.host.use("templates", templates);

    const ctx: ToolContext = {
      toolCallId: "t",
      signal: new AbortController().signal,
      require: async () => {},
      progress: () => {},
      ui: h.agent.ui,
      agent: { model: "mock", messages: [], steer() {}, followUp() {} },
      log: h.agent.logger,
    };
    const res = await h.agent.tools.get("spawn_template")!.execute(
      { template: "answerer", prompt: "hi" },
      ctx,
    );
    assert.equal(res.isError, undefined);
    assert.equal(res.content, "REAL ANSWER", "the real answer is returned, not the empty leading text block");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.EAGENT_TEMPLATES_DIR;
    else process.env.EAGENT_TEMPLATES_DIR = saved;
  }
});
