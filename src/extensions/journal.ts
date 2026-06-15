/**
 * Durable, resumable runs — an append-only conversation journal.
 *
 * The `session` extension is manual (`/save`, `/load`); this is automatic. When
 * enabled, every message is appended to a JSONL journal as it happens, so a
 * crashed or killed process loses nothing: `/resume` replays the journal into a
 * fresh transcript. It is the agent equivalent of a shell history or a database
 * write-ahead log, and — like everything else — it lives entirely out here in an
 * extension, observing the kernel's `message` event rather than changing the
 * loop.
 *
 * Off by default for privacy; opt in with `/journal on` (the choice persists),
 * or set `EAGENT_JOURNAL=/path/to/journal.jsonl` to enable and place it.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Message } from "../kernel/types.js";

export default function activate(e: ExtensionAPI): () => void {
  e.grantCapability("fs:read");
  e.grantCapability("fs:write");

  const journalPath = (): string =>
    process.env.EAGENT_JOURNAL ?? e.store.get<string>("path") ?? join(homedir(), ".eagent", "journal.jsonl");

  // Enabled if the env var is set, or the persisted flag is on.
  const isEnabled = (): boolean => Boolean(process.env.EAGENT_JOURNAL) || e.store.get<boolean>("enabled", false) === true;

  const append = (message: Message): void => {
    if (!isEnabled()) return;
    try {
      const path = journalPath();
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(message) + "\n");
    } catch (err) {
      e.log.warn("journal: append failed:", err);
    }
  };

  const off = e.on("message", ({ message }) => append(message));

  const readJournal = (): Message[] => {
    try {
      return readFileSync(journalPath(), "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Message);
    } catch {
      return [];
    }
  };

  const offJournal = e.registerCommand({
    name: "journal",
    description: "Durable run journal. Usage: /journal [on|off|clear|status]",
    run: (ctx) => {
      const arg = ctx.args.trim();
      const path = journalPath();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          ctx.print(`journal on -> ${path}`);
          break;
        case "off":
          e.store.set("enabled", false);
          ctx.print("journal off");
          break;
        case "clear":
          try {
            writeFileSync(path, "");
            ctx.print("journal cleared");
          } catch (err) {
            ctx.print(`journal: could not clear: ${(err as Error).message}`);
          }
          break;
        default: {
          const n = readJournal().length;
          ctx.print(`journal ${isEnabled() ? "on" : "off"} (${n} entries) -> ${path}`);
        }
      }
    },
  });

  const offResume = e.registerCommand({
    name: "resume",
    description: "Replay the journal into the current (empty) transcript.",
    run: (ctx) => {
      if (ctx.agent.messages.length > 0) {
        ctx.print("resume: transcript is not empty; /clear first to avoid mixing conversations.");
        return;
      }
      const messages = readJournal();
      if (messages.length === 0) {
        ctx.print(`resume: nothing to resume (journal empty at ${journalPath()}).`);
        return;
      }
      ctx.agent.load(messages);
      ctx.print(`resumed ${messages.length} messages from the journal.`);
    },
  });

  return () => {
    for (const d of [off, offJournal, offResume]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
