/**
 * Tests for the playbook extension: an ACE-style delta-merged, auto-injected
 * insight playbook.
 *
 * The pure functions (`mergeSegments`, `buildInjection`, `injectPlaybook`) are
 * exercised directly; the extension is exercised through the harness for the
 * `transformContext` seam, the `/playbook` command, and the store bullet cap.
 * Each test names the invariant it protects.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import playbook, {
  buildInjection,
  injectPlaybook,
  mergeSegments,
  MAX_BULLETS,
  MAX_INJECT_BYTES,
  MERGE_SEP,
  type Bullet,
} from "../src/extensions/playbook.js";
import type { CommandContext } from "../src/kernel/commands.js";
import { envOnlyConfig } from "../src/kernel/store.js";
import { text } from "../src/kernel/types.js";
import { makeHarness } from "./helpers.js";

/** A concrete `Bullet` for pure-function tests. */
function bullet(id: string, body: string, ord: number): Bullet {
  return { id, text: body, ord, ts: "2026-01-01T00:00:00.000Z" };
}

// -- Task 1: mergeSegments determinism (AC 4) -------------------------------

test("mergeSegments: append new delta; segment-exact no-op; substring appended", () => {
  // Appending a genuinely new delta yields text + SEP + delta.
  assert.equal(mergeSegments("a", "b", MERGE_SEP), "a" + MERGE_SEP + "b");

  // A delta exactly equal to an existing SEP-delimited segment is a no-op.
  const existing = "a" + MERGE_SEP + "b";
  assert.equal(mergeSegments(existing, "b", MERGE_SEP), existing);
  assert.equal(mergeSegments(existing, "a", MERGE_SEP), existing);

  // Segment-exact, NOT raw-substring: "conf" is a substring of "config" but not
  // equal to the segment, so it IS appended.
  assert.equal(mergeSegments("config", "conf", MERGE_SEP), "config" + MERGE_SEP + "conf");
});

// -- Task 2: injected byte cap (AC 5a) --------------------------------------

test("buildInjection: caps note text at MAX_INJECT_BYTES and marks truncation", () => {
  // 12 bullets of ~1 KB each = ~12 KB combined, over the 8 KB cap.
  const bullets: Bullet[] = [];
  for (let i = 0; i < 12; i++) bullets.push(bullet(`b${i}`, "X".repeat(1000), i));

  const noteText = buildInjection(bullets, MAX_INJECT_BYTES);
  assert.ok(noteText !== undefined);
  assert.ok(
    Buffer.byteLength(noteText, "utf8") <= MAX_INJECT_BYTES,
    "note text stays within the byte cap",
  );
  assert.match(noteText, /more not shown/);
});

// -- Task 3: off-path identity (AC 1) ---------------------------------------

test("injectPlaybook: identity by reference when killed / disabled / empty", () => {
  const bullets = [bullet("b1", "one", 1)];
  const saved = process.env.EAGENT_PLAYBOOK;

  // Kill switch: EAGENT_PLAYBOOK=off, even with bullets present.
  process.env.EAGENT_PLAYBOOK = "off";
  try {
    const input = [text("user", "hi")];
    assert.equal(injectPlaybook(input, bullets, envOnlyConfig()), input);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_PLAYBOOK;
    else process.env.EAGENT_PLAYBOOK = saved;
  }

  // Disabled config (default false, no store), with bullets present.
  const disabledInput = [text("user", "hi")];
  assert.equal(injectPlaybook(disabledInput, bullets, envOnlyConfig()), disabledInput);

  // No bullets: nothing to inject, returns input by reference.
  const emptyInput = [text("user", "hi")];
  assert.equal(injectPlaybook(emptyInput, []), emptyInput);
});

// -- Task 4: injection shape (AC 2, pure) -----------------------------------

test("injectPlaybook: enabled injects a leading ephemeral system note in ord order", () => {
  const input = [text("user", "hi")];
  const bullets = [bullet("b2", "SECOND", 2), bullet("b1", "FIRST", 1)];

  const out = injectPlaybook(input, bullets);
  assert.notEqual(out, input);
  assert.equal(out.length, input.length + 1);

  const note = out[0]!;
  assert.equal(note.role, "system");
  assert.equal(note.meta?.source, "playbook");
  assert.equal(note.meta?.ephemeral, true);

  const block = note.content[0];
  assert.ok(block && block.type === "text");
  assert.ok(block.text.includes("FIRST"));
  assert.ok(block.text.includes("SECOND"));
  // Ascending ord: FIRST (ord 1) precedes SECOND (ord 2).
  assert.ok(block.text.indexOf("FIRST") < block.text.indexOf("SECOND"));
});

// -- Task 5: real seam across both gate states (AC 2, integration) ----------

test("activate: transformContext is identity when disabled, injects when enabled", async () => {
  const h = makeHarness();
  await h.host.use("playbook", playbook);
  const store = h.backend.open("playbook");

  // Seed a bullet directly so injection has content once enabled.
  store.set("bullet:seed", { id: "seed", text: "SEEDED", ord: 1, ts: "2026-01-01T00:00:00.000Z" });

  // (i) Disabled (default): the transform returns its input unchanged.
  const msgs = [text("user", "hi")];
  const off = await h.agent.hooks.apply("transformContext", msgs, { turn: 0, model: "mock" });
  assert.equal(off, msgs);

  // (ii) Enable via the extension's own store flag: the transform now injects.
  store.set("enabled", true);
  const on = await h.agent.hooks.apply("transformContext", msgs, { turn: 0, model: "mock" });
  assert.notEqual(on, msgs);
  assert.equal(on[0]?.role, "system");
  assert.equal(on[0]?.meta?.source, "playbook");
  const block = on[0]?.content[0];
  assert.ok(block && block.type === "text" && block.text.includes("SEEDED"));
});

/** Drive a `/playbook <args>` command and return the printed lines. */
async function runPlaybook(
  h: ReturnType<typeof makeHarness>,
  args: string,
): Promise<string[]> {
  const lines: string[] = [];
  const ctx: CommandContext = { agent: h.agent, args, print: (l) => lines.push(l) };
  await h.commands.get("playbook")!.run(ctx);
  return lines;
}

/** Extract a bullet id from an "Added <id>." line. */
function addedId(lines: string[]): string {
  const m = /Added (\S+?)\.?$/.exec(lines.join("\n"));
  assert.ok(m, `expected an "Added <id>." line, got: ${lines.join("\n")}`);
  return m[1]!;
}

// -- Task 6: command round-trips (AC 3, 4, 6) -------------------------------

test("/playbook: add / list / merge / forget / clear round-trip", async () => {
  const h = makeHarness();
  await h.host.use("playbook", playbook);

  const id1 = addedId(await runPlaybook(h, "add first insight"));
  const id2 = addedId(await runPlaybook(h, "add second insight"));
  assert.notEqual(id1, id2);

  // list shows both, in insertion order.
  const listed = await runPlaybook(h, "list");
  const listText = listed.join("\n");
  assert.ok(listText.includes(id1));
  assert.ok(listText.includes(id2));
  assert.ok(listText.indexOf(id1) < listText.indexOf(id2));

  // merge mutates only the targeted bullet; the other is untouched.
  await runPlaybook(h, `merge ${id1} refined`);
  const afterMerge = (await runPlaybook(h, "list")).join("\n");
  const line1 = afterMerge.split("\n").find((l) => l.includes(id1))!;
  const line2 = afterMerge.split("\n").find((l) => l.includes(id2))!;
  assert.ok(line1.includes("refined"));
  assert.ok(line1.includes("first insight"));
  assert.ok(!line2.includes("refined"));

  // A second identical merge is a no-op (idempotent).
  await runPlaybook(h, `merge ${id1} refined`);
  const afterSecond = (await runPlaybook(h, "list")).join("\n");
  const line1b = afterSecond.split("\n").find((l) => l.includes(id1))!;
  assert.equal(line1b, line1);

  // forget removes exactly one.
  await runPlaybook(h, `forget ${id1}`);
  const afterForget = (await runPlaybook(h, "list")).join("\n");
  assert.ok(!afterForget.includes(id1));
  assert.ok(afterForget.includes(id2));

  // clear empties.
  await runPlaybook(h, "clear");
  const afterClear = (await runPlaybook(h, "list")).join("\n");
  assert.ok(!afterClear.includes(id2));
});

// -- Task 7: store bullet cap (AC 5b) ---------------------------------------

test("store bullet cap: FIFO-drops earliest over MAX_BULLETS", async () => {
  const h = makeHarness();
  await h.host.use("playbook", playbook);
  const store = h.backend.open("playbook");

  const ids: string[] = [];
  for (let i = 0; i < MAX_BULLETS + 5; i++) {
    ids.push(addedId(await runPlaybook(h, `add bullet number ${i}`)));
  }

  const bulletKeys = store.keys().filter((k) => k.startsWith("bullet:"));
  assert.equal(bulletKeys.length, MAX_BULLETS);

  // The 5 earliest-added ids are the ones dropped.
  const remaining = new Set(bulletKeys.map((k) => k.slice("bullet:".length)));
  for (let i = 0; i < 5; i++) assert.ok(!remaining.has(ids[i]!), `earliest id ${ids[i]} dropped`);
  assert.ok(remaining.has(ids[MAX_BULLETS + 4]!), "newest id retained");
});

// -- Task 8: kill-switch parity (AC 7) --------------------------------------

test("kill switch: /playbook add reports disabled and writes nothing", async () => {
  const h = makeHarness();
  await h.host.use("playbook", playbook);
  const store = h.backend.open("playbook");

  const before = store.keys().filter((k) => k.startsWith("bullet:")).length;
  const saved = process.env.EAGENT_PLAYBOOK;
  process.env.EAGENT_PLAYBOOK = "off";
  try {
    const out = (await runPlaybook(h, "add should not persist")).join("\n");
    assert.match(out, /disabled/i);
    const after = store.keys().filter((k) => k.startsWith("bullet:")).length;
    assert.equal(after, before);
  } finally {
    if (saved === undefined) delete process.env.EAGENT_PLAYBOOK;
    else process.env.EAGENT_PLAYBOOK = saved;
  }
});
