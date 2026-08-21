import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import journal from "../src/extensions/journal.ts";
import type { Command } from "../src/kernel/commands.ts";
import { makeHarness } from "./helpers.ts";

function journalPath(): string {
  return join(mkdtempSync(join(tmpdir(), "eagent-journal-")), "journal.jsonl");
}

async function runCommand(cmd: Command, agent: ReturnType<typeof makeHarness>["agent"], args: string): Promise<string[]> {
  const out: string[] = [];
  await cmd.run({ agent, args, print: (l) => out.push(l) });
  return out;
}

test("records messages when enabled and resumes them into a fresh agent", async () => {
  const path = journalPath();
  // First agent: enable journaling (via store path + on), run a couple of turns.
  const a = makeHarness({ responder: [{ text: "one" }, { text: "two" }], fallback: "allow" });
  await a.host.use("journal", journal);
  // Point the journal at our temp path (via env) and enable it.
  const jcmd = a.commands.get("journal")!;
  process.env.EAGENT_JOURNAL = path;
  await runCommand(jcmd, a.agent, "on");

  await a.agent.run("hello");
  await a.agent.run("again");

  assert.ok(existsSync(path), "journal file should exist");
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.ok(lines.length >= 4, `expected several journaled messages, got ${lines.length}`);

  // Second agent: resume from the same journal into an empty transcript.
  const b = makeHarness({ fallback: "allow" });
  await b.host.use("journal", journal);
  const before = b.agent.messages.length;
  assert.equal(before, 0);
  const out = await runCommand(b.commands.get("resume")!, b.agent, "");
  assert.match(out.join("\n"), /resumed \d+ messages/);
  assert.equal(b.agent.messages.length, lines.length);

  delete process.env.EAGENT_JOURNAL;
});

test("is inert when disabled", async () => {
  delete process.env.EAGENT_JOURNAL;
  const h = makeHarness({ responder: [{ text: "x" }], fallback: "allow" });
  await h.host.use("journal", journal);
  // Default off: a run journals nothing.
  await h.agent.run("hi");
  const status = await runCommand(h.commands.get("journal")!, h.agent, "status");
  assert.match(status.join("\n"), /journal off/);
});

test("resume recovers valid messages and skips a corrupt journal line", async () => {
  const path = journalPath();
  process.env.EAGENT_JOURNAL = path;
  const good1 = JSON.stringify({ role: "user", content: [{ type: "text", text: "one" }] });
  const good2 = JSON.stringify({ role: "assistant", content: [{ type: "text", text: "two" }] });
  // A truncated/corrupt line wedged between two valid ones must not discard the
  // whole journal (regression: one JSON.parse throw returned []).
  writeFileSync(path, `${good1}\n{ this is not json\n${good2}\n`);

  const h = makeHarness({ fallback: "allow" });
  await h.host.use("journal", journal);
  const out = await runCommand(h.commands.get("resume")!, h.agent, "");
  assert.match(out.join("\n"), /resumed 2 messages/);
  assert.equal(h.agent.messages.length, 2);
  delete process.env.EAGENT_JOURNAL;
});

test("/journal clear empties the journal", async () => {
  const path = journalPath();
  process.env.EAGENT_JOURNAL = path;
  const h = makeHarness({ responder: [{ text: "x" }], fallback: "allow" });
  await h.host.use("journal", journal);
  await h.agent.run("hi");
  assert.ok(readFileSync(path, "utf8").trim().length > 0);
  await runCommand(h.commands.get("journal")!, h.agent, "clear");
  assert.equal(readFileSync(path, "utf8").trim().length, 0);
  delete process.env.EAGENT_JOURNAL;
});
