/**
 * Keyword-triggered knowledge microagents — conditional, event-pushed context.
 *
 * `context-files` injects project docs unconditionally every turn (always-on);
 * `skills` injects a name+description catalog and loads a body only when the
 * model decides to call `skill_read` (model-pull). The missing pattern is
 * *conditional, event-pushed* knowledge: a body of domain instructions that
 * should appear in context only when the latest user turn is actually about that
 * domain — no model action required, no per-turn cost when irrelevant.
 *
 * A microagent is a markdown file with single-line `triggers: a, b, c`
 * frontmatter (the `skills` convention). When a trigger keyword appears
 * whole-word in the latest user message, the file's body is injected as one
 * ephemeral system message. A file with no triggers is not a microagent — use
 * `context-files` for always-on content. Discovery is cached; `/microagents`
 * re-scans. Like `prune`/`context-files`, the transform returns a NEW array and
 * never mutates the durable transcript, and returns the input by reference when
 * there is nothing to inject.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI } from "../kernel/extension.js";
import type { Config } from "../kernel/store.js";
import type { Message } from "../kernel/types.js";

import { loadLayered, resourceDirs } from "./lib/resource-dirs.js";

/** Upper bound on the total bytes injected, matching `context-files`. */
export const MAX_TOTAL_BYTES = 32 * 1024;

/** A discovered microagent: its name, trigger keywords, and full body. */
export interface Microagent {
  name: string;
  triggers: string[];
  body: string;
  description?: string;
}

/**
 * Parse a microagent from markdown using the single-line frontmatter convention
 * of `skills.ts` (the file must open with `---` and contain a closing `\n---`).
 * `triggers` is comma-split, each entry trimmed and lowercased, empties dropped;
 * a file with zero non-empty triggers is not a microagent (returns `undefined`).
 * `name` defaults to `fallbackName`; `body` is the markdown after the fence.
 */
export function parseMicroagent(md: string, fallbackName: string): Microagent | undefined {
  if (!md.startsWith("---")) return undefined;
  const end = md.indexOf("\n---", 3);
  if (end === -1) return undefined;

  const front: Record<string, string> = {};
  for (const line of md.slice(3, end).split("\n")) {
    const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (m) front[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }

  const triggers = (front.triggers ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  if (triggers.length === 0) return undefined;

  // Body is everything after the closing fence line.
  const fenceEnd = md.indexOf("\n", end + 1);
  const body = (fenceEnd === -1 ? "" : md.slice(fenceEnd + 1)).trim();

  const result: Microagent = { name: front.name ?? fallbackName, triggers, body };
  if (front.description) result.description = front.description;
  return result;
}

/**
 * Case-insensitive whole-word match: lowercase `userText`, and for each
 * (already-lowercased) trigger accept only when the characters immediately
 * before and after an occurrence are non-alphanumeric (`/[a-z0-9]/`) or absent.
 * This fires `k8s` at word edges but not `cat` inside `category`.
 */
export function triggered(userText: string, triggers: string[]): boolean {
  const text = userText.toLowerCase();
  const isWord = (c: string | undefined): boolean => c !== undefined && /[a-z0-9]/.test(c);
  return triggers.some((trigger) => {
    if (trigger.length === 0) return false;
    let from = 0;
    for (;;) {
      const i = text.indexOf(trigger, from);
      if (i === -1) return false;
      if (!isWord(text[i - 1]) && !isWord(text[i + trigger.length])) return true;
      from = i + 1;
    }
  });
}

/**
 * The space-joined text-block text of the last `user` message, or `undefined`
 * when there is no `user` message. Non-text blocks are ignored.
 */
export function latestUserText(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    return m.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ");
  }
  return undefined;
}

/**
 * Inject the bodies of microagents whose triggers fire on the latest user
 * message. Reads its own kill switch (`EAGENT_MICROAGENTS=off`). Returns the
 * input array BY REFERENCE on the kill-switch, no-user-message, and no-match
 * paths; otherwise returns a NEW `[note, ...messages]` array. Matched files are
 * ordered by name and prefix-filled under `MAX_TOTAL_BYTES` (whole files only,
 * stop at the first that would overflow).
 */
export function injectMicroagents(messages: Message[], microagents: Microagent[], config?: Config): Message[] {
  if (config && !config.enabled("microagents", { default: true })) return messages;

  const userText = latestUserText(messages);
  if (userText === undefined) return messages;

  const matched = microagents
    .filter((m) => triggered(userText, m.triggers))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const selected: Microagent[] = [];
  let used = 0;
  for (const m of matched) {
    const bytes = Buffer.byteLength(m.body, "utf8");
    if (used + bytes > MAX_TOTAL_BYTES) break;
    used += bytes;
    selected.push(m);
  }
  if (selected.length === 0) return messages;

  const body = [
    "Triggered knowledge (microagents):",
    ...selected.map((m) => `### ${m.name}\n${m.body}`),
  ].join("\n\n");

  const note: Message = {
    role: "system",
    content: [{ type: "text", text: body }],
    meta: { source: "microagents", ephemeral: true },
  };
  return [note, ...messages];
}

/**
 * Scan a directory for microagent `*.md` files, parsed and sorted by filename.
 * Degrades to `[]` and never throws: an unreadable directory, file, or a
 * badly-fenced / trigger-less file is skipped.
 */
export function scanMicroagents(dir: string): Microagent[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Microagent[] = [];
  for (const file of entries.sort()) {
    if (!file.endsWith(".md")) continue;
    try {
      const md = readFileSync(join(dir, file), "utf8");
      const m = parseMicroagent(md, file.slice(0, -3));
      if (m) out.push(m);
    } catch {
      // unreadable file; skip
    }
  }
  return out;
}

/**
 * Resolve the microagents directory: the `EAGENT_MICROAGENTS_DIR` override, else
 * `<workspace>/.eagent/microagents`, where `<workspace>` is `EAGENT_WORKSPACE`
 * or `process.cwd()`. Deliberately omits any store-backed override.
 */
export function microagentsDir(config: Config): string {
  return (
    config.string("microagents.dir") ??
    join(config.string("workspace") ?? process.cwd(), ".eagent", "microagents")
  );
}

export default function activate(e: ExtensionAPI): void {
  // The scan result is cached so the directory is read at most once until the
  // `/microagents` command forces a re-scan.
  let cache: Microagent[] | undefined;

  const discover = (): Microagent[] => {
    if (!cache) cache = loadLayered(resourceDirs(e.config, "microagents"), scanMicroagents);
    return cache;
  };

  e.hook("transformContext", (messages) => injectMicroagents(messages, discover(), e.config));

  e.registerCommand({
    name: "microagents",
    description: "Re-scan and list keyword-triggered microagents and their triggers.",
    run: (ctx) => {
      cache = loadLayered(resourceDirs(e.config, "microagents"), scanMicroagents);
      if (cache.length === 0) {
        ctx.print(`(no microagents in ${microagentsDir(e.config)})`);
        return;
      }
      for (const m of cache) ctx.print(`  ${m.name.padEnd(20)} [${m.triggers.join(", ")}]`);
    },
  });
}
