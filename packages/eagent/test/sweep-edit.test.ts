/**
 * sweep-edit — regex-enumerated multi-site refactor that fans a sub-agent per
 * match.
 *
 * Every test runs offline against a real temp-file workspace
 * (`EAGENT_WORKSPACE`) and a scripted `MockProvider`. The extension is loaded
 * via `host.use("sweep-edit", sweepEdit)` alongside `core-tools` and `search`
 * (the established offline pattern, e.g. test/recovery.test.ts) and never
 * depends on `BUILTIN_EXTENSIONS`. Each child is a real `Agent.run`; the
 * responder branches on the child system prompt (the subagents.test.ts pattern)
 * to script each child's edit-or-decline.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../src/kernel/agent.ts";
import { CapabilityManager } from "../src/kernel/capabilities.ts";
import { CommandRegistry } from "../src/kernel/commands.ts";
import { ExtensionHost } from "../src/kernel/extension.ts";
import { MemoryBackend } from "../src/kernel/store.ts";
import type { CompletionRequest, Logger, Message, ToolResultBlock } from "../src/kernel/types.ts";
import { MockProvider, type MockResponder } from "../src/providers/mock.ts";
import coreTools from "../src/extensions/core-tools.ts";
import search from "../src/extensions/search.ts";
import sweepEdit, { DEFAULT_MAX_SITES } from "../src/extensions/sweep-edit.ts";
import { autoUI, makeHarness, silentLogger } from "./helpers.ts";

/** The marker every site-child's system prompt carries, so the responder can branch on parent vs child. */
const CHILD_MARKER = "sweep-edit site";

/**
 * A scratch workspace seeded with N matching files (each containing `needle`)
 * plus one non-matching file. `EAGENT_WORKSPACE` points the confined grep/edit
 * tools here; the original value is restored on cleanup.
 */
function scratch(matchCount = 3): {
  dir: string;
  needle: string;
  matchFiles: string[];
  miss: string;
  read: (rel: string) => string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "eagent-sweep-"));
  const needle = "OLD_NAME";
  const matchFiles: string[] = [];
  for (let i = 0; i < matchCount; i++) {
    const rel = `m${i}.ts`;
    writeFileSync(join(dir, rel), `export const ${needle}_${i} = ${i};\n`);
    matchFiles.push(rel);
  }
  const miss = "miss.ts";
  writeFileSync(join(dir, miss), "export const UNRELATED = 0;\n");

  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir;
  return {
    dir,
    needle,
    matchFiles,
    miss,
    read: (rel: string) => readFileSync(join(dir, rel), "utf8"),
    cleanup: () => {
      if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
      else process.env.EAGENT_WORKSPACE = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The last user text block in a request (used to target a specific child by its file). */
function lastUserText(req: CompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i]!;
    if (m.role !== "user") continue;
    const block = m.content.find((b) => b.type === "text");
    if (block && block.type === "text") return block.text;
  }
  return "";
}

/** Collect every tool_result block from a transcript. */
function toolResults(messages: readonly Message[]): ToolResultBlock[] {
  const out: ToolResultBlock[] = [];
  for (const m of messages) {
    if (m.role !== "tool") continue;
    for (const b of m.content) if (b.type === "tool_result") out.push(b);
  }
  return out;
}

/** The parsed array the `sweep_edit` tool returns (its `details`, which carries the structured summary). */
interface SweepEntry {
  file: string;
  status: "edited" | "declined" | "error";
  note: string;
}
interface SweepDetails {
  total: number;
  edited: number;
  declined: number;
  errors: number;
  truncated: boolean;
  sites: SweepEntry[];
}

/** A logger that records every warn line into `warnings`. */
function recordingLogger(warnings: string[]): Logger {
  return { ...silentLogger, warn: (...a: unknown[]) => warnings.push(a.map(String).join(" ")) };
}

/**
 * A responder that drives a sweep end-to-end: the parent emits one `sweep_edit`
 * call (then a final text); each site-child edits its own file (then a final
 * text). `childAction` lets a test override a specific child's behavior by file.
 */
function sweepResponder(
  args: Record<string, unknown>,
  childAction?: (file: string) => { toolCalls?: { name: string; arguments: Record<string, unknown> }[]; text?: string },
): MockResponder {
  let parentCalled = false;
  return (req: CompletionRequest) => {
    if (req.systemPrompt.includes(CHILD_MARKER)) {
      // The child system prompt carries its file path; branch on it.
      const file = childFileOf(req.systemPrompt);
      const action = childAction?.(file);
      if (action) return action;
      return { toolCalls: [{ name: "edit", arguments: { path: file, old: "OLD_NAME", new: "NEW_NAME" } }] };
    }
    if (!parentCalled) {
      parentCalled = true;
      return { toolCalls: [{ name: "sweep_edit", arguments: args }] };
    }
    return { text: "parent-done" };
  };
}

/** Extract the `file=<path>` token a site-child's system prompt carries. */
function childFileOf(systemPrompt: string): string {
  const m = /file=(\S+)/.exec(systemPrompt);
  return m ? m[1]! : "";
}

/** Drive a sweep and return the parsed structured summary the tool returned via `details`. */
async function runSweep(
  responder: MockResponder,
  opts: { logger?: Logger } = {},
): Promise<{ details: SweepDetails; result: ToolResultBlock }> {
  const h = makeHarness({ responder, fallback: "allow", logger: opts.logger });
  await h.host.use("core-tools", coreTools);
  await h.host.use("search", search);
  await h.host.use("sweep-edit", sweepEdit);
  await h.agent.run("sweep it");
  const results = toolResults(h.agent.messages);
  const sweep = results.find((r) => /"sites"/.test(r.content));
  assert.ok(sweep, "the sweep_edit tool result is present");
  return { details: JSON.parse(sweep.content) as SweepDetails, result: sweep };
}

// -- T1 — enumeration fans one child per matched file (AC1) -------------------

test("AC1: enumerates all matching files and edits each", async () => {
  const s = scratch(3);
  try {
    const before = s.matchFiles.map((f) => s.read(f));
    const { details } = await runSweep(
      sweepResponder({ pattern: s.needle, instruction: "rename OLD_NAME to NEW_NAME" }),
    );

    assert.equal(details.sites.length, 3, "exactly one site per matching file");
    assert.ok(details.sites.every((e) => e.status === "edited"), "every site is edited");

    s.matchFiles.forEach((f, i) => {
      assert.notEqual(s.read(f), before[i], `${f} changed on disk`);
      assert.match(s.read(f), /NEW_NAME/, `${f} carries the new name`);
    });
    // The non-matching file is untouched (pinned fully in T5).
    assert.equal(s.read(s.miss), "export const UNRELATED = 0;\n");
  } finally {
    s.cleanup();
  }
});

// -- T2 contract pin — declared capabilities (AC4(b)) ------------------------

test("AC4(b): sweep_edit declares fs:write + agent:spawn", async () => {
  const s = scratch(1);
  try {
    const h = makeHarness({ fallback: "allow" });
    await h.host.use("core-tools", coreTools);
    await h.host.use("search", search);
    await h.host.use("sweep-edit", sweepEdit);
    assert.deepEqual(h.agent.tools.get("sweep_edit")!.capabilities, ["fs:write", "agent:spawn"]);
  } finally {
    s.cleanup();
  }
});

// -- T3 — a site may decline (AC2) -------------------------------------------

test("AC2: a child that declines leaves its file unchanged and is reported `declined`", async () => {
  const s = scratch(3);
  try {
    const decliner = s.matchFiles[0]!;
    const before = s.read(decliner);
    const { details } = await runSweep(
      sweepResponder(
        { pattern: s.needle, instruction: "rename" },
        (file) =>
          file === decliner
            ? { text: "This match is a false positive; leaving it unchanged." }
            : { toolCalls: [{ name: "edit", arguments: { path: file, old: "OLD_NAME", new: "NEW_NAME" } }] },
      ),
    );

    const declinedEntry = details.sites.find((e) => e.file === decliner)!;
    assert.equal(declinedEntry.status, "declined", "the no-edit child is reported declined");
    assert.equal(s.read(decliner), before, "the declined file is byte-identical on disk");
    // The other sites still edited.
    const others = details.sites.filter((e) => e.file !== decliner);
    assert.ok(others.every((e) => e.status === "edited"), "the other sites are still edited");
    assert.equal(others.length, 2);
  } finally {
    s.cleanup();
  }
});

// -- T5 — a non-matching file is never touched (AC1 corollary) ---------------

test("AC1 corollary: a non-matching file is never a site and never touched", async () => {
  const s = scratch(3);
  try {
    const before = s.read(s.miss);
    const { details } = await runSweep(
      sweepResponder({ pattern: s.needle, instruction: "rename" }),
    );
    assert.equal(s.read(s.miss), before, "the non-matching file's bytes are identical");
    assert.ok(!details.sites.some((e) => e.file === s.miss), "the non-matching file is in no summary entry");
  } finally {
    s.cleanup();
  }
});

// -- T7 — max-sites cap truncates with a logged note (AC6) -------------------

test("AC6: maxSites caps the worklist, flags truncated, and logs a warning", async () => {
  const s = scratch(3);
  try {
    const warnings: string[] = [];
    const { details } = await runSweep(
      sweepResponder({ pattern: s.needle, instruction: "rename", maxSites: 2 }),
      { logger: recordingLogger(warnings) },
    );
    assert.equal(details.sites.length, 2, "exactly maxSites children ran");
    assert.equal(details.truncated, true, "the summary is flagged truncated");
    assert.ok(
      warnings.some((w) => /truncat/i.test(w)),
      `a truncation warning was emitted (saw: ${JSON.stringify(warnings)})`,
    );
  } finally {
    s.cleanup();
  }
});

// -- T9 — confinement (rides grep) + missing-dependency error (AC7) ----------

test("AC7: sweep_edit loaded without `search` returns a clear missing-grep error", async () => {
  const s = scratch(2);
  try {
    let parentCalled = false;
    const responder: MockResponder = (req: CompletionRequest) => {
      if (req.systemPrompt.includes(CHILD_MARKER)) return { text: "unreachable" };
      if (!parentCalled) {
        parentCalled = true;
        return { toolCalls: [{ name: "sweep_edit", arguments: { pattern: s.needle, instruction: "rename" } }] };
      }
      return { text: "done" };
    };
    const h = makeHarness({ responder, fallback: "allow" });
    await h.host.use("core-tools", coreTools);
    // deliberately NOT loading `search`
    await h.host.use("sweep-edit", sweepEdit);
    await h.agent.run("sweep it");

    const res = toolResults(h.agent.messages).find((r) =>
      r.toolCallId.length > 0 && (r.isError === true),
    );
    assert.ok(res, "an error result was produced");
    assert.equal(res.isError, true);
    assert.match(res.content, /grep/, "the error names the missing grep tool");
  } finally {
    s.cleanup();
  }
});

test("confinement: a pattern matching nothing in-root yields an empty worklist, no out-of-root site", async () => {
  const s = scratch(2);
  try {
    const before = s.matchFiles.map((f) => s.read(f));
    const { details } = await runSweep(
      sweepResponder({ pattern: "ABSOLUTELY_NOT_PRESENT_ANYWHERE", instruction: "rename" }),
    );
    assert.equal(details.sites.length, 0, "no sites enumerated for a non-matching pattern");
    s.matchFiles.forEach((f, i) => assert.equal(s.read(f), before[i], `${f} untouched`));
  } finally {
    s.cleanup();
  }
});

// -- T11 — per-site error isolation (AC3) + child scoped to read+edit (AC5) ---

test("AC3: a child whose edit fails is isolated to its own site (status `error`)", async () => {
  const s = scratch(3);
  try {
    const failer = s.matchFiles[1]!;
    const { details } = await runSweep(
      sweepResponder(
        { pattern: s.needle, instruction: "rename" },
        (file) =>
          file === failer
            ? // an `old` string that is absent → edit returns "Text not found in …"
              { toolCalls: [{ name: "edit", arguments: { path: file, old: "THIS_TEXT_IS_ABSENT", new: "x" } }] }
            : { toolCalls: [{ name: "edit", arguments: { path: file, old: "OLD_NAME", new: "NEW_NAME" } }] },
      ),
    );

    const errEntry = details.sites.find((e) => e.file === failer)!;
    assert.equal(errEntry.status, "error", "the failing site is status error");
    assert.match(errEntry.note, /Text not found/, "the failure text is carried in the note");
    const others = details.sites.filter((e) => e.file !== failer);
    assert.ok(others.every((e) => e.status === "edited"), "the other sites are unaffected");
    assert.equal(others.length, 2);
  } finally {
    s.cleanup();
  }
});

test("AC5: the child registry omits bash — a child `bash` call resolves to Unknown tool, no shell runs", async () => {
  const s = scratch(2);
  try {
    const probe = s.matchFiles[0]!;
    // Capture the child transcript by branching: the probed child issues a bash
    // call (which must be Unknown tool), then a final text; the other edits.
    let childBashSeen = false;
    let parentCalled = false;
    const responder: MockResponder = (req: CompletionRequest) => {
      if (req.systemPrompt.includes(CHILD_MARKER)) {
        const file = childFileOf(req.systemPrompt);
        if (file === probe) {
          if (!childBashSeen) {
            childBashSeen = true;
            return { toolCalls: [{ name: "bash", arguments: { command: "echo pwned" } }] };
          }
          return { text: "child saw the bash failure and stopped" };
        }
        return { toolCalls: [{ name: "edit", arguments: { path: file, old: "OLD_NAME", new: "NEW_NAME" } }] };
      }
      if (!parentCalled) {
        parentCalled = true;
        return { toolCalls: [{ name: "sweep_edit", arguments: { pattern: s.needle, instruction: "rename" } }] };
      }
      return { text: "parent-done" };
    };

    const { details } = await runSweep(responder);
    // The probed child's bash call resolved to Unknown tool → it issued no edit →
    // its site is classified `error` (note carries the Unknown tool text) or
    // `declined`; either way it is NOT edited and the shell never ran.
    const probeEntry = details.sites.find((e) => e.file === probe)!;
    assert.match(probeEntry.note, /Unknown tool: bash/, "bash is absent from the child registry");
    assert.notEqual(probeEntry.status, "edited", "the probed child made no edit");
    assert.equal(childBashSeen, true, "the child did attempt the bash call");
  } finally {
    s.cleanup();
  }
});

// -- T13 — capability gate (AC4(a)) + /sweeps command ------------------------

test("AC4(a): a deny rule on agent:spawn refuses the sweep at the dispatcher", async () => {
  const s = scratch(2);
  try {
    let parentCalled = false;
    const provider = new MockProvider((req: CompletionRequest) => {
      if (req.systemPrompt.includes(CHILD_MARKER)) return { text: "unreachable" };
      if (!parentCalled) {
        parentCalled = true;
        return { toolCalls: [{ name: "sweep_edit", arguments: { pattern: s.needle, instruction: "rename" } }] };
      }
      return { text: "done" };
    });
    // Build the agent directly with a deny rule (makeHarness forwards only fallback).
    const ui = autoUI(true);
    const capabilities = new CapabilityManager({ ui, fallback: "allow", deny: ["agent:spawn"] });
    const agent = new Agent({ ui, logger: silentLogger, capabilities, provider: "mock", model: "mock" });
    agent.providers.register(provider, { default: true });
    const commands = new CommandRegistry();
    const host = new ExtensionHost({ agent, commands, logger: silentLogger, store: new MemoryBackend() });
    await host.use("core-tools", coreTools);
    await host.use("search", search);
    await host.use("sweep-edit", sweepEdit);

    await agent.run("sweep it");
    const res = toolResults(agent.messages).find((r) => r.isError === true);
    assert.ok(res, "the denied call produced an error result");
    assert.equal(res.isError, true, "the sweep was refused at the capability boundary before any child ran");
    // The matching files were never edited.
    s.matchFiles.forEach((f) => assert.match(s.read(f), /OLD_NAME/, `${f} was not edited`));
  } finally {
    s.cleanup();
  }
});

test("/sweeps command explains the contract and the max-sites cap", async () => {
  const { commands, host } = makeHarness({ fallback: "allow" });
  await host.use("sweep-edit", sweepEdit);
  const cmd = commands.get("sweeps");
  assert.ok(cmd, "the /sweeps command is registered");
  const lines: string[] = [];
  await cmd.run({ agent: {} as never, args: "", print: (l) => lines.push(l) });
  const joined = lines.join("\n");
  assert.match(joined, /sweep_edit/, "names the tool");
  assert.match(joined, /maxSites/, "explains the max-sites cap");
  assert.match(joined, new RegExp(String(DEFAULT_MAX_SITES)), "states the default cap");
});

// -- T15 — kill switch (AC8) + clean teardown (AC9) --------------------------

test("AC8: EAGENT_SWEEP_EDIT=off registers nothing", async () => {
  const prev = process.env.EAGENT_SWEEP_EDIT;
  process.env.EAGENT_SWEEP_EDIT = "off";
  try {
    const { agent, commands, host } = makeHarness({ fallback: "allow" });
    await host.use("sweep-edit", sweepEdit);
    assert.equal(agent.tools.has("sweep_edit"), false, "no sweep_edit tool");
    assert.equal(commands.get("sweeps"), undefined, "no /sweeps command");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_SWEEP_EDIT;
    else process.env.EAGENT_SWEEP_EDIT = prev;
  }
});

test("AC9: host.unload removes the tool and command without throwing", async () => {
  const { agent, commands, host } = makeHarness({ fallback: "allow" });
  await host.use("sweep-edit", sweepEdit);
  assert.equal(agent.tools.has("sweep_edit"), true);
  await host.unload("sweep-edit"); // must not throw
  assert.equal(agent.tools.has("sweep_edit"), false, "tool removed after unload");
  assert.equal(commands.get("sweeps"), undefined, "command removed after unload");
});

export type { SweepDetails, MockResponder };
