/**
 * Tests for the memory extension: the remember/recall scratchpad and its
 * white-box per-entry provenance (`/memory list|edit|forget|rollback|
 * consolidate`). Conversation compaction is no longer memory's responsibility —
 * `compact` owns the `transformContext` seam — so this suite asserts only the
 * scratchpad surface.
 *
 * The mock provider's FUNCTION responder is the instrument: it branches on the
 * summarization system prompt so a scripted run can drive tool calls without a
 * nested summarization call interfering.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ExtensionHost } from "../src/kernel/extension.js";
import { Agent } from "../src/kernel/agent.js";
import { CapabilityManager } from "../src/kernel/capabilities.js";
import { CommandRegistry } from "../src/kernel/commands.js";
import { FileBackend, MemoryBackend } from "../src/kernel/store.js";
import type { Store, StoreBackend } from "../src/kernel/store.js";
import activate, { parseEmbeddings, setEmbedder } from "../src/extensions/memory.js";
import type { Embedder } from "../src/extensions/memory.js";
import type { CompletionRequest, Message } from "../src/kernel/types.js";
import { MockProvider, type MockResponder } from "../src/providers/mock.js";
import { autoUI, makeHarness, silentLogger } from "./helpers.js";

/** Robustly detect our summarization sub-call by its dedicated system prompt. */
function isSummarizeReq(req: CompletionRequest): boolean {
  return /summar/i.test(req.systemPrompt);
}

interface Recorder {
  /** Context handed to every NON-summarization (real) provider call. */
  realCalls: Message[][];
  /** Number of summarization sub-calls made. */
  summarizeCalls: number;
}

function freshRecorder(): Recorder {
  return { realCalls: [], summarizeCalls: 0 };
}

test("remember/recall round-trips a note", async () => {
  const rec = freshRecorder();
  // Script: turn 1 calls remember, turn 2 calls recall, turn 3 plain text.
  let turn = 0;
  const responder = (req: CompletionRequest) => {
    if (isSummarizeReq(req)) {
      rec.summarizeCalls++;
      return { text: "SUMMARY" };
    }
    turn++;
    if (turn === 1) {
      return { toolCalls: [{ name: "remember", arguments: { key: "color", value: "blue" } }] };
    }
    if (turn === 2) {
      return { toolCalls: [{ name: "recall", arguments: { key: "color" } }] };
    }
    return { text: "done" };
  };
  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("memory", activate);

  await agent.run("remember my color then recall it");

  // Find the tool result message carrying recall's answer.
  const toolResults = agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  const recalled = toolResults.find((b) => b.type === "tool_result" && b.content === "blue");
  assert.ok(recalled, "recall returned the stored value");
});

// ---------------------------------------------------------------------------
// white-box-memory: per-entry provenance, edit/forget/rollback (AC 1–15)
// ---------------------------------------------------------------------------

/** The provenance-tagged entry shape stored under `note:<key>`. */
interface Entry {
  id: string;
  text: string;
  source: string;
  ts: string;
  prevText?: string;
}

/** A harness that also exposes the extension store backend for inspection. */
interface MemHarness {
  agent: Agent;
  host: ExtensionHost;
  commands: CommandRegistry;
  /** The `memory`-namespaced store the extension writes through. */
  store: Store;
}

/**
 * Build a harness whose extension store backend we hold a reference to, so we
 * can `open("memory")` and read the exact note entries the extension writes —
 * the `memory` namespace, not a sibling. `backend` lets T16 pass a FileBackend.
 */
function makeMemHarness(backend: StoreBackend = new MemoryBackend()): MemHarness {
  const ui = autoUI(true);
  const capabilities = new CapabilityManager({ ui, fallback: "allow" });
  const agent = new Agent({ ui, logger: silentLogger, capabilities, provider: "mock", model: "mock" });
  agent.providers.register(new MockProvider(), { default: true });
  const commands = new CommandRegistry();
  const host = new ExtensionHost({ agent, commands, logger: silentLogger, store: backend });
  // open("memory") returns the SAME Store instance the extension receives on
  // activation under id "memory" (MemoryBackend/FileBackend both cache per ns).
  return { agent, host, commands, store: backend.open("memory") };
}

/** Build a harness, scripting the provider, and load the memory extension. */
async function loadMem(responder?: MockResponder): Promise<MemHarness> {
  const h = makeMemHarness();
  if (responder) {
    // Re-register a scripted provider in place of the default no-arg mock.
    h.agent.providers.register(new MockProvider(responder), { default: true });
  }
  await h.host.use("memory", activate);
  return h;
}

/** Drive a `/memory <args>` command and return the printed lines. */
async function runMemory(commands: CommandRegistry, agent: Agent, args: string): Promise<string[]> {
  const out: string[] = [];
  await commands.get("memory")!.run({ agent, args, print: (l) => out.push(l) });
  return out;
}

/** Read the raw stored entry (or legacy string) for a note key. */
function rawNote(store: Store, key: string): unknown {
  return store.get<unknown>("note:" + key);
}

test("provenance: remember stores a tagged Entry (AC 2)", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });

  const raw = rawNote(h.store, "color");
  assert.ok(raw && typeof raw === "object", "note:color is an object, not a bare string");
  const entry = raw as Entry;
  assert.equal(entry.text, "blue");
  assert.ok(entry.source.length > 0, "non-empty source");
  assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/, "ISO-8601 ts");
  assert.ok(typeof entry.id === "string" && entry.id.length > 0, "defined id");
});

test("AC 1: remember/recall still returns the bare text", async () => {
  const rec = freshRecorder();
  let turn = 0;
  const responder = (req: CompletionRequest) => {
    if (isSummarizeReq(req)) {
      rec.summarizeCalls++;
      return { text: "SUMMARY" };
    }
    turn++;
    if (turn === 1) return { toolCalls: [{ name: "remember", arguments: { key: "color", value: "blue" } }] };
    if (turn === 2) return { toolCalls: [{ name: "recall", arguments: { key: "color" } }] };
    return { text: "done" };
  };
  const { agent, host } = makeHarness({ responder, fallback: "allow" });
  await host.use("memory", activate);
  await agent.run("remember then recall");

  const toolResults = agent.messages
    .filter((m) => m.role === "tool")
    .flatMap((m) => m.content)
    .filter((b) => b.type === "tool_result");
  const recalled = toolResults.find((b) => b.type === "tool_result" && b.content === "blue");
  assert.ok(recalled, "recall returned the stored value, not an Entry object");
});

test("AC 7: re-remember shifts current text into prevText", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "k", value: "one" });
  await execTool(h.agent, "remember", { key: "k", value: "two" });

  const entry = rawNote(h.store, "k") as Entry;
  assert.equal(entry.text, "two");
  assert.equal(entry.prevText, "one", "overwrite is reversible one step");
});

test("AC 13: entry ids are distinct across keys and stable on re-read", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "a", value: "1" });
  await execTool(h.agent, "remember", { key: "b", value: "2" });

  const a1 = (rawNote(h.store, "a") as Entry).id;
  const b1 = (rawNote(h.store, "b") as Entry).id;
  assert.notEqual(a1, b1, "distinct ids");

  // Stable on re-read.
  const a2 = (rawNote(h.store, "a") as Entry).id;
  assert.equal(a1, a2, "id stable on re-read");
});

test("AC 3: /memory list shows id + source + ts, one line per note (incl. legacy)", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  await execTool(h.agent, "remember", { key: "size", value: "large" });
  // Legacy bare-string note must list with a `legacy` sentinel and not throw (AC 8).
  h.store.set("note:legacy", "old");

  const out = await runMemory(h.commands, h.agent, "list");
  assert.equal(out.length, 3, "one line per entry");
  const colorEntry = rawNote(h.store, "color") as Entry;
  const colorLine = out.find((l) => l.includes("color"))!;
  assert.ok(colorLine.includes(colorEntry.id), "line shows id");
  assert.ok(colorLine.includes(colorEntry.source), "line shows source");
  assert.match(colorLine, /\d{4}-\d{2}-\d{2}T/, "line shows date-shaped ts");
  const legacyLine = out.find((l) => l.includes("legacy"))!;
  assert.ok(legacyLine.includes("legacy"), "legacy note listed with legacy source");
});

test("AC 4: /memory edit <id> <text> replaces by id and preserves prior", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  const id = (rawNote(h.store, "color") as Entry).id;

  const out = await runMemory(h.commands, h.agent, `edit ${id} green`);
  const entry = rawNote(h.store, "color") as Entry;
  assert.equal(entry.text, "green", "text replaced");
  assert.equal(entry.prevText, "blue", "prior value preserved");
  assert.ok(out.join("\n").length > 0, "edit prints a confirmation");

  // recall returns the new text.
  const res = await execTool(h.agent, "recall", { key: "color" });
  assert.equal(res.content, "green");
});

test("AC 4: /memory edit accepts multi-word replacement text", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  const id = (rawNote(h.store, "color") as Entry).id;

  await runMemory(h.commands, h.agent, `edit ${id} dark forest green`);
  assert.equal((rawNote(h.store, "color") as Entry).text, "dark forest green");
});

test("AC 5: /memory forget <id> deletes by id", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  const id = (rawNote(h.store, "color") as Entry).id;

  await runMemory(h.commands, h.agent, `forget ${id}`);
  assert.equal(rawNote(h.store, "color"), undefined, "note key gone");

  const res = await execTool(h.agent, "recall", { key: "color" });
  assert.equal(res.isError, true);
  assert.equal(res.content, 'No note for "color".');

  const list = await runMemory(h.commands, h.agent, "list");
  assert.ok(!list.some((l) => l.includes("color")), "no longer listed");
});

test("AC 6: /memory rollback restores prior once; second is a no-op", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  const id = (rawNote(h.store, "color") as Entry).id;
  await runMemory(h.commands, h.agent, `edit ${id} green`);

  await runMemory(h.commands, h.agent, `rollback ${id}`);
  assert.equal((rawNote(h.store, "color") as Entry).text, "blue", "restored prior value");

  const before = (rawNote(h.store, "color") as Entry).text;
  await runMemory(h.commands, h.agent, `rollback ${id}`);
  const after = (rawNote(h.store, "color") as Entry).text;
  assert.equal(after, before, "second consecutive rollback is a no-op");
});

test("AC 9: /memory consolidate is opt-in exact-text dedupe", async () => {
  const h = await loadMem();
  // Two notes with normalized-identical text; plain remember keeps BOTH.
  await execTool(h.agent, "remember", { key: "a", value: "Hello" });
  await execTool(h.agent, "remember", { key: "b", value: " hello " });
  assert.ok(rawNote(h.store, "a"), "a present after writes");
  assert.ok(rawNote(h.store, "b"), "b present after writes — no auto-merge");

  const out = await runMemory(h.commands, h.agent, "consolidate");
  const remaining = h.store.keys().filter((k) => k.startsWith("note:"));
  assert.equal(remaining.length, 1, "exactly one remains after consolidate");
  assert.match(out.join("\n"), /1|merged|consolidat/i, "prints a merged-count line");

  // Distinct texts → removes nothing.
  await execTool(h.agent, "remember", { key: "c", value: "alpha" });
  await execTool(h.agent, "remember", { key: "d", value: "beta" });
  await runMemory(h.commands, h.agent, "consolidate");
  assert.ok(rawNote(h.store, "c"), "distinct text c kept");
  assert.ok(rawNote(h.store, "d"), "distinct text d kept");
});

test("D-W9.6c: consolidate keeps the LOWEST-ts entry per group, not first-by-iteration", async () => {
  const h = await loadMem();
  // Two normalized-identical notes. Key "a" is written/iterated first but carries
  // the HIGHER ts; key "b" carries the LOWER ts. The genuinely earliest copy is b,
  // so the survivor must be b — proving the rule is lowest-ts, not first-by-key.
  h.store.set("note:a", { id: "id-a", text: "Hello", source: "tool:remember", ts: "2026-06-29T12:00:00.000Z" });
  h.store.set("note:b", { id: "id-b", text: " hello ", source: "tool:remember", ts: "2026-06-29T10:00:00.000Z" });

  const out = await runMemory(h.commands, h.agent, "consolidate");

  const remaining = h.store.keys().filter((k) => k.startsWith("note:"));
  assert.equal(remaining.length, 1, "exactly one survivor after consolidate");
  assert.equal(remaining[0], "note:b", "the lowest-ts entry survived (not the first-iterated higher-ts one)");
  assert.equal((rawNote(h.store, "b") as Entry).id, "id-b", "the surviving entry is b's");
  assert.match(out.join("\n"), /merged 1/i, "reports one merged duplicate");
});

test("D-W9.6c: a legacy (ts:\"\") duplicate is preferred as the survivor", async () => {
  const h = await loadMem();
  // "new" is written/iterated first (first-by-iteration would keep it), but the
  // legacy bare-string note sorts first (ts:"") so lowest-ts keeps the legacy one.
  h.store.set("note:new", { id: "id-new", text: "hello", source: "tool:remember", ts: "2026-06-29T10:00:00.000Z" });
  h.store.set("note:legacy", "Hello"); // bare string => readEntry wraps with ts:""

  await runMemory(h.commands, h.agent, "consolidate");

  const remaining = h.store.keys().filter((k) => k.startsWith("note:"));
  assert.deepEqual(remaining, ["note:legacy"], "the legacy ts:\"\" entry is the lowest-ts survivor");
});

test("AC 10: kill switch writes a bare string and disables sub-commands", async () => {
  const prev = process.env.EAGENT_MEMORY_ENTRIES;
  process.env.EAGENT_MEMORY_ENTRIES = "off";
  try {
    let turn = 0;
    const responder = (req: CompletionRequest) => {
      if (isSummarizeReq(req)) return { text: "SUMMARY" };
      turn++;
      if (turn === 1) return { toolCalls: [{ name: "remember", arguments: { key: "color", value: "blue" } }] };
      if (turn === 2) return { toolCalls: [{ name: "recall", arguments: { key: "color" } }] };
      return { text: "done" };
    };
    const h = await loadMem(responder);
    await h.agent.run("remember then recall");

    assert.equal(typeof rawNote(h.store, "color"), "string", "kill switch writes a bare string");

    // recall round-trip (AC 1) still passes.
    const toolResults = h.agent.messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => m.content)
      .filter((b) => b.type === "tool_result");
    assert.ok(toolResults.some((b) => b.type === "tool_result" && b.content === "blue"));

    // list prints a disabled notice, not entry rows.
    const out = await runMemory(h.commands, h.agent, "list");
    assert.match(out.join("\n"), /disabled|off/i, "list reports disabled");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MEMORY_ENTRIES;
    else process.env.EAGENT_MEMORY_ENTRIES = prev;
  }
});

test("AC 15: no-key recall unwraps .text over mixed new+legacy shapes", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  h.store.set("note:legacy", "old"); // bare string

  const res = await execTool(h.agent, "recall", {});
  assert.deepEqual(res.details, { color: "blue", legacy: "old" });
  // Parsed content is also plain text values, never an Entry object.
  const parsed = JSON.parse(res.content) as Record<string, unknown>;
  assert.deepEqual(parsed, { color: "blue", legacy: "old" });
});

test("AC 8: legacy bare-string note recalls without throwing", async () => {
  const h = await loadMem();
  h.store.set("note:legacy", "old");
  const res = await execTool(h.agent, "recall", { key: "legacy" });
  assert.equal(res.content, "old");

  const out = await runMemory(h.commands, h.agent, "list");
  assert.ok(out.some((l) => l.includes("legacy")), "legacy listed without throwing");
});

test("AC 14: Entry with prevText round-trips a FileBackend flush/read", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-memory-"));
  try {
    // First "process": remember + edit (creates a prevText), then drop the host.
    {
      const h = makeMemHarness(new FileBackend(dir));
      await h.host.use("memory", activate);
      await execTool(h.agent, "remember", { key: "color", value: "blue" });
      const id = (rawNote(h.store, "color") as Entry).id;
      await runMemory(h.commands, h.agent, `edit ${id} green`);
    }

    // Second "process": a fresh backend reads the flushed-and-renamed file.
    {
      const h = makeMemHarness(new FileBackend(dir));
      await h.host.use("memory", activate);
      const entry = rawNote(h.store, "color") as Entry;
      assert.equal(entry.text, "green");
      assert.equal(entry.prevText, "blue");
      assert.ok(entry.source.length > 0);
      assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(entry.id.length > 0);

      // Rollback restores prevText correctly across the persisted boundary.
      await runMemory(h.commands, h.agent, `rollback ${entry.id}`);
      assert.equal((rawNote(h.store, "color") as Entry).text, "blue");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AC 12: host.unload removes registrations and never throws", async () => {
  const h = await loadMem();
  assert.ok(h.agent.tools.get("remember"));
  assert.ok(h.agent.tools.get("recall"));
  assert.ok(h.commands.get("memory"));

  await h.host.unload("memory");

  assert.equal(h.agent.tools.get("remember"), undefined);
  assert.equal(h.agent.tools.get("recall"), undefined);
  assert.equal(h.commands.get("memory"), undefined);
});

// ---------------------------------------------------------------------------
// tiered memory: archival tier + lexical query recall + eviction (AC 4–7)
// ---------------------------------------------------------------------------

interface Match {
  key: string;
  tier: string;
  text: string;
  score: number;
}

test("AC-4: recall({query}) returns a ranked list of token-overlap matches, top-K, score>0", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "auth", value: "fix the login auth flow" });
  await execTool(h.agent, "remember", { key: "auth2", value: "login auth token refresh session" });
  await execTool(h.agent, "remember", { key: "db", value: "database migration schema" });

  const res = await execTool(h.agent, "recall", { query: "login auth session token" });
  const details = res.details as Match[];
  assert.ok(Array.isArray(details), "details is a ranked array, not a map");
  assert.equal(details.length, 2, "only score>0 matches returned (db excluded)");
  assert.equal(details[0]!.key, "auth2", "highest overlap ranks first");
  assert.equal(details[1]!.key, "auth");
  assert.ok(details[0]!.score > details[1]!.score, "sorted by score descending");
  assert.equal(details[0]!.tier, "core", "core-tier note tagged core");
  assert.ok(details.every((d) => d.score > 0), "no score-0 entries");

  // A no-overlap query returns no matches — never a dump of every note.
  const none = await execTool(h.agent, "recall", { query: "kubernetes helm chart" });
  assert.deepEqual(none.details, [], "no-overlap query returns an empty list");
  assert.doesNotMatch(none.content, /database migration|login auth/, "not a dump of all notes");
});

test("AC-5: no-query recall stays byte-identical (exact key + dump-all)", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "color", value: "blue" });
  await execTool(h.agent, "remember", { key: "size", value: "large" });

  const exact = await execTool(h.agent, "recall", { key: "color" });
  assert.equal(exact.content, "blue", "exact-key path unchanged");

  const dump = await execTool(h.agent, "recall", {});
  assert.deepEqual(dump.details, { color: "blue", size: "large" }, "dump-all map unchanged");
  assert.deepEqual(JSON.parse(dump.content), { color: "blue", size: "large" });
});

test("AC-6: remember past coreCap evicts the oldest note to archive; recall finds it", async () => {
  const h = await loadMem();
  h.store.set("coreCap", 2);
  h.store.set("note:n1", { id: "e1", text: "alpha apple", source: "tool:remember", ts: "2026-01-01T00:00:00.000Z" });
  h.store.set("note:n2", { id: "e2", text: "beta banana", source: "tool:remember", ts: "2026-01-02T00:00:00.000Z" });

  await execTool(h.agent, "remember", { key: "n3", value: "gamma grape" });

  const noteCount = h.store.keys().filter((k) => k.startsWith("note:")).length;
  assert.ok(noteCount <= 2, `core stays within cap (got ${noteCount})`);
  assert.equal(rawNote(h.store, "n1"), undefined, "oldest note evicted from core");
  const archived = h.store.get<{ text: string }>("archive:n1");
  assert.equal(archived?.text, "alpha apple", "oldest note moved to archive");

  const res = await execTool(h.agent, "recall", { query: "alpha apple" });
  const details = res.details as Match[];
  assert.equal(details.length, 1, "the evicted note is found by query");
  assert.equal(details[0]!.key, "n1");
  assert.equal(details[0]!.tier, "archive", "found in the archive tier");
});

test("AC-6: kill switch disables eviction", async () => {
  const prev = process.env.EAGENT_MEMORY_ENTRIES;
  process.env.EAGENT_MEMORY_ENTRIES = "off";
  try {
    const h = await loadMem();
    h.store.set("coreCap", 1);
    await execTool(h.agent, "remember", { key: "a", value: "one" });
    await execTool(h.agent, "remember", { key: "b", value: "two" });
    await execTool(h.agent, "remember", { key: "c", value: "three" });

    const noteCount = h.store.keys().filter((k) => k.startsWith("note:")).length;
    assert.equal(noteCount, 3, "no eviction under the kill switch");
    const archiveCount = h.store.keys().filter((k) => k.startsWith("archive:")).length;
    assert.equal(archiveCount, 0, "nothing archived under the kill switch");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_MEMORY_ENTRIES;
    else process.env.EAGENT_MEMORY_ENTRIES = prev;
  }
});

test("AC-7: /memory archive lists the archive; /memory promote restores a note; list stays core-scoped", async () => {
  const h = await loadMem();
  h.store.set("coreCap", 1);
  h.store.set("note:n1", { id: "e1", text: "alpha apple", source: "tool:remember", ts: "2026-01-01T00:00:00.000Z" });
  await execTool(h.agent, "remember", { key: "n2", value: "beta banana" });
  assert.ok(h.store.get("archive:n1"), "precondition: n1 evicted to archive");

  const archiveOut = await runMemory(h.commands, h.agent, "archive");
  assert.ok(archiveOut.join("\n").includes("n1"), "/memory archive lists the archived key");
  assert.match(archiveOut.join("\n"), /1/, "/memory archive shows a count");

  // Existing subcommands stay note:-scoped: list shows only the core note.
  const listOut = await runMemory(h.commands, h.agent, "list");
  assert.ok(!listOut.some((l) => l.includes("n1")), "list excludes the archived note");
  assert.ok(listOut.some((l) => l.includes("n2")), "list shows the core note");

  const promoteOut = await runMemory(h.commands, h.agent, "promote n1");
  assert.ok(rawNote(h.store, "n1"), "promote moves n1 back into core");
  assert.equal(h.store.get("archive:n1"), undefined, "promote removes n1 from archive");
  assert.ok(promoteOut.join("\n").length > 0, "promote prints a confirmation");
});

test("AC-7: /memory recall searches across tiers and prints ranked matches", async () => {
  const h = await loadMem();
  await execTool(h.agent, "remember", { key: "auth", value: "fix the login auth flow" });
  await execTool(h.agent, "remember", { key: "db", value: "database migration schema" });

  const out = await runMemory(h.commands, h.agent, "recall login auth");
  const joined = out.join("\n");
  assert.ok(joined.includes("auth"), "ranked output includes the matching key");
  assert.ok(!joined.includes("database migration"), "non-matching note excluded");
});

// -- shared helpers for the white-box tests ---------------------------------

/** Execute a registered tool directly with a minimal ToolContext. */
async function execTool(agent: Agent, name: string, args: Record<string, unknown>) {
  const tool = agent.tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool.execute(args, {
    toolCallId: "t",
    signal: new AbortController().signal,
    require: async () => {},
    progress: () => {},
    ui: autoUI(true),
    agent: agent.handle,
    log: silentLogger,
  });
}

// ---------------------------------------------------------------------------
// RW7b-1: optional semantic (embedding) recall — off by default, fail-soft
// ---------------------------------------------------------------------------

/**
 * A deterministic mock embedder over a tiny 4-dim concept vocabulary. Each text
 * becomes a concept-count vector (dim 0 vehicle, 1 cost, 2 database, 3 food), so
 * a paraphrase that shares a CONCEPT with the query — but no ≥3-char surface
 * token — earns a high cosine, while a note that only shares a surface token
 * earns a lower one. This inverts the lexical order.
 */
const CONCEPT: Record<string, number> = {
  car: 0, automobile: 0, vehicle: 0, sedan: 0,
  cost: 1, price: 1, pricing: 1, budget: 1,
  database: 2, postgres: 2, sql: 2,
  recipe: 3, food: 3, meal: 3,
};

const mockEmbedder: Embedder = (texts) =>
  Promise.resolve(
    texts.map((t) => {
      const v = [0, 0, 0, 0];
      for (const tok of t.toLowerCase().split(/[^a-z0-9]+/)) {
        const dim = CONCEPT[tok];
        if (dim !== undefined) v[dim] += 1;
      }
      return v;
    }),
  );

const throwingEmbedder: Embedder = async () => {
  throw new Error("embed down");
};

/** Seed the paraphrase (zero lexical overlap) + incidental (one shared token) pair. */
async function seedSemanticNotes(h: MemHarness): Promise<void> {
  // paraphrase: shares the vehicle+cost CONCEPT with "automobile pricing" but no salient token.
  await execTool(h.agent, "remember", { key: "para", value: "car budget estimate" });
  // incidental: shares the surface token "automobile" (overlapScore>0) but a weaker concept.
  await execTool(h.agent, "remember", { key: "inc", value: "automobile assembly plant" });
}

test("RW7b-1 AC#1: semantic recall surfaces a paraphrase note that lexical drops", async () => {
  const h = await loadMem();
  await seedSemanticNotes(h);
  const query = "automobile pricing";

  // (i) lexical (no embedder): the zero-overlap paraphrase is omitted entirely.
  const lex = await execTool(h.agent, "recall", { query });
  const lexKeys = (lex.details as Match[]).map((m) => m.key);
  assert.deepEqual(lexKeys, ["inc"], "lexical recall omits the zero-overlap paraphrase");

  // (ii) semantic (mock injected): the paraphrase surfaces AND ranks first.
  setEmbedder(mockEmbedder);
  try {
    const sem = await execTool(h.agent, "recall", { query });
    const semKeys = (sem.details as Match[]).map((m) => m.key);
    assert.equal(semKeys[0], "para", "semantic ranks the paraphrase first");
    assert.ok(semKeys.includes("inc"), "the incidental note is still present");
  } finally {
    setEmbedder(undefined);
  }
});

test("RW7b-1 AC#2: EAGENT_MEMORY_EMBED=off forces lexical even with an embedder injected", async () => {
  const prev = process.env.EAGENT_MEMORY_EMBED;
  const h = await loadMem();
  await seedSemanticNotes(h);
  const query = "automobile pricing";
  const lex = await execTool(h.agent, "recall", { query });

  setEmbedder(mockEmbedder);
  process.env.EAGENT_MEMORY_EMBED = "off";
  try {
    const killed = await execTool(h.agent, "recall", { query });
    assert.deepEqual(killed.details, lex.details, "the kill switch yields the lexical ranking");
  } finally {
    setEmbedder(undefined);
    if (prev === undefined) delete process.env.EAGENT_MEMORY_EMBED;
    else process.env.EAGENT_MEMORY_EMBED = prev;
  }
});

test("RW7b-1 AC#3: a throwing embedder fails soft to a result deep-equal to lexical", async () => {
  const h = await loadMem();
  await seedSemanticNotes(h);
  const query = "automobile pricing";
  const lex = await execTool(h.agent, "recall", { query });

  setEmbedder(throwingEmbedder);
  try {
    const soft = await execTool(h.agent, "recall", { query });
    assert.deepEqual(soft.details, lex.details, "fail-soft recall deep-equals the lexical result");
  } finally {
    setEmbedder(undefined);
  }
});

test("RW7b-1: parseEmbeddings maps an OpenAI-shaped body to number[][], order-preserving", () => {
  const body = { data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] };
  assert.deepEqual(parseEmbeddings(body), [[1, 2, 3], [4, 5, 6]]);
  assert.throws(() => parseEmbeddings({}), /data/i, "missing data[] throws");
  assert.throws(() => parseEmbeddings({ data: [{}] }), /embedding/i, "missing embedding[] throws");
  assert.throws(() => parseEmbeddings({ data: "nope" }), /data/i, "non-array data throws");
});

test("RW7b-2: /memory forget-archive <key> deletes an archived note, leaving core notes", async () => {
  const h = await loadMem();
  h.store.set("archive:old", "an archived thought"); // bare string => readArchive wraps it
  h.store.set("note:keep", { id: "id-keep", text: "core note", source: "tool:remember", ts: "2026-07-01T00:00:00.000Z" });

  const out = await runMemory(h.commands, h.agent, "forget-archive old");
  assert.match(out.join("\n"), /Forgot archived "old"/);
  assert.equal(h.store.get("archive:old"), undefined, "the archived note is deleted");
  assert.ok(h.store.get("note:keep"), "the core note keyspace is untouched");

  const miss = await runMemory(h.commands, h.agent, "forget-archive nope");
  assert.match(miss.join("\n"), /no archived note "nope"/, "an unknown key reports not-found, no delete");
});
