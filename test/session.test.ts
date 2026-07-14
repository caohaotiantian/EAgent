import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Command } from "../src/kernel/commands.js";
import type { Message } from "../src/kernel/types.js";
import { makeHarness, type Harness } from "./helpers.js";
import activate from "../src/extensions/session.js";

/** Activate the session extension and point its default dir at a temp dir. */
async function setup(opts: Parameters<typeof makeHarness>[0] = {}): Promise<
  Harness & { dir: string; run: (name: string, args: string) => Promise<string[]> }
> {
  const h = makeHarness({ fallback: "allow", ...opts });
  const dir = mkdtempSync(join(tmpdir(), "eagent-session-"));
  // Use the documented store override so default-path commands write here.
  await h.host.use("session", (e) => {
    e.store.set("sessionsDir", dir);
    return activate(e);
  });
  const run = async (name: string, args: string): Promise<string[]> => {
    const lines: string[] = [];
    const cmd = h.commands.get(name) as Command;
    await cmd.run({ agent: h.agent, args, print: (l) => lines.push(l) });
    return lines;
  };
  return { ...h, dir, run };
}

function firstText(m: Message): string {
  const b = m.content.find((c) => c.type === "text");
  return b && b.type === "text" ? b.text : "";
}

test("round-trip: save then load restores the transcript identically", async () => {
  const { agent, dir, run } = await setup();
  agent.load([
    { role: "user", content: [{ type: "text", text: "first message" }] },
    { role: "assistant", content: [{ type: "text", text: "a reply" }] },
    { role: "user", content: [{ type: "text", text: "last message" }] },
  ]);
  const path = join(dir, "s.json");
  const before = agent.messages.length;
  const firstBefore = firstText(agent.messages[0]!);
  const lastBefore = firstText(agent.messages[before - 1]!);

  const saved = await run("save", path);
  assert.match(saved.join("\n"), /Saved 3 message/);

  agent.clear();
  assert.equal(agent.messages.length, 0);

  const loaded = await run("load", path);
  assert.match(loaded.join("\n"), /Restored 3 message/);
  assert.equal(agent.messages.length, before);
  assert.equal(firstText(agent.messages[0]!), firstBefore);
  assert.equal(firstText(agent.messages[agent.messages.length - 1]!), lastBefore);
});

test("save writes a valid JSON envelope with version, model, and messages", async () => {
  const { agent, dir, run } = await setup();
  agent.load([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  const path = join(dir, "envelope.json");
  await run("save", path);

  const parsed = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(parsed.version, 1);
  assert.equal(typeof parsed.model, "string");
  assert.ok(Array.isArray(parsed.messages));
  assert.equal(parsed.messages.length, 1);
});

test("load of a missing path prints an error and does not throw", async () => {
  const { dir, run } = await setup();
  const path = join(dir, "does-not-exist.json");
  const lines = await run("load", path); // resolves without throwing
  assert.match(lines.join("\n"), /Failed to load session/);
});

test("handoff replaces the transcript with a single system summary message", async () => {
  const responder = (req: { systemPrompt: string }) => {
    if (req.systemPrompt.includes("handoff briefing")) {
      return { text: "- Goal: ship the feature\n- Next: write tests" };
    }
    return { text: "ok" };
  };
  const { agent, run } = await setup({ responder });
  await agent.run("let's build a thing");
  await agent.run("keep going");
  assert.ok(agent.messages.length > 1);

  const lines = await run("handoff", "");
  assert.match(lines.join("\n"), /ship the feature/);
  assert.equal(agent.messages.length, 1);
  assert.equal(agent.messages[0]!.role, "system");
  const text = firstText(agent.messages[0]!);
  assert.match(text, /^Handoff from previous session:/);
  assert.match(text, /ship the feature/);
});

test("handoff falls back to a digest when no provider yields a summary", async () => {
  // Responder returns empty text for the handoff call -> fallback digest.
  const { agent, run } = await setup({ responder: () => ({ text: "" }) });
  agent.load([
    { role: "user", content: [{ type: "text", text: "remember the alamo" }] },
    { role: "assistant", content: [{ type: "text", text: "noted" }] },
  ]);
  const lines = await run("handoff", "");
  assert.equal(agent.messages.length, 1);
  assert.match(firstText(agent.messages[0]!), /Carried over 2 message/);
  assert.match(lines.join("\n"), /remember the alamo/);
});

test("sessions lists saved files with counts", async () => {
  const { agent, dir, run } = await setup();
  agent.load([{ role: "user", content: [{ type: "text", text: "one" }] }]);
  await run("save", join(dir, "alpha.json"));
  agent.load([{ role: "user", content: [{ type: "text", text: "two" }] }]);
  await run("save", join(dir, "beta.json"));

  const lines = await run("sessions", "");
  const out = lines.join("\n");
  assert.match(out, /alpha\.json/);
  assert.match(out, /beta\.json/);
  assert.match(out, /message\(s\)/);
});

test("load tolerates an invalid (non-JSON) session file", async () => {
  const { dir, run } = await setup();
  const path = join(dir, "broken.json");
  writeFileSync(path, "{not json", "utf8");
  const lines = await run("load", path);
  assert.match(lines.join("\n"), /Failed to load session/);
});

test("load rejects a session whose messages contain a malformed entry", async () => {
  const { dir, run } = await setup();
  const path = join(dir, "malformed.json");
  // Valid JSON and a valid envelope, but the second entry is not a well-formed
  // Message (missing `content`) — it must fail loudly at load, not crash later.
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      savedAt: "x",
      model: "mock",
      messages: [{ role: "user", content: [{ type: "text", text: "ok" }] }, { role: "user" }],
    }),
    "utf8",
  );
  const lines = await run("load", path);
  assert.match(lines.join("\n"), /malformed entry/);
});

test("load rejects a message whose content block is malformed (null / no type)", async () => {
  const { dir, run } = await setup();
  // A null content block (or a non-object / typeless block) passes a shallow
  // Array.isArray check but crashes a later turn that reads block.type. It must
  // fail loudly at the read boundary instead.
  for (const bad of [[null], ["oops"], [{ text: "no type" }]]) {
    const path = join(dir, `badblock-${JSON.stringify(bad).length}.json`);
    writeFileSync(
      path,
      JSON.stringify({ version: 1, savedAt: "x", model: "mock", messages: [{ role: "user", content: bad }] }),
      "utf8",
    );
    const lines = await run("load", path);
    assert.match(lines.join("\n"), /malformed entry/, `content ${JSON.stringify(bad)} is rejected`);
  }
});

test("load rejects a forward-incompatible session version", async () => {
  const { dir, run } = await setup();
  const path = join(dir, "future.json");
  writeFileSync(
    path,
    JSON.stringify({ version: 999, savedAt: "x", model: "mock", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
    "utf8",
  );
  const lines = await run("load", path);
  assert.match(lines.join("\n"), /unsupported session version 999/);
});
