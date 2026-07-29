/**
 * Popup suggestions for `/` and `@` (AC12).
 *
 * Offline: the directory listing is injected, so these run with no filesystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { accept, findTrigger, suggest, type SuggestContext } from "./suggest.js";

const ctx: SuggestContext = {
  commands: () => [
    { name: "help", description: "Show available commands." },
    { name: "model", description: "Get or set the model." },
    { name: "clear", description: "Clear the transcript." },
  ],
  readDir: (dir) => {
    if (dir === ".") {
      return [
        { name: "src", isDirectory: true },
        { name: "README.md", isDirectory: false },
        { name: "package.json", isDirectory: false },
        { name: ".env", isDirectory: false },
      ];
    }
    if (dir === "src/") {
      return [
        { name: "cli.ts", isDirectory: false },
        { name: "kernel", isDirectory: true },
      ];
    }
    throw new Error("ENOENT");
  },
};

const labels = (t: ReturnType<typeof findTrigger>): string[] =>
  t === null ? [] : suggest(t, ctx).map((s) => s.label);

// -- triggers ---------------------------------------------------------------

test("AC12: a leading slash opens the command menu", () => {
  const t = findTrigger("/mo", 3);
  assert.deepEqual(t, { kind: "command", start: 0, query: "mo" });
});

test("a slash mid-sentence is not a command trigger", () => {
  assert.equal(findTrigger("see src/cli.ts", 14), null);
  assert.equal(findTrigger("on 12/25", 8), null);
});

test("AC12: @ triggers at the start or after whitespace", () => {
  assert.deepEqual(findTrigger("@RE", 3), { kind: "file", start: 0, query: "RE" });
  assert.deepEqual(findTrigger("look at @src", 12), { kind: "file", start: 8, query: "src" });
});

test("@ inside a word is not a trigger — an email address must not open a popup", () => {
  assert.equal(findTrigger("someone@example.com", 19), null);
});

test("a mention followed by a space closes the popup", () => {
  assert.equal(findTrigger("@README.md and then", 19), null);
});

// -- command suggestions ----------------------------------------------------

test("AC12: the command menu filters as you type", () => {
  assert.deepEqual(labels(findTrigger("/", 1)), ["/help", "/model", "/clear"]);
  assert.deepEqual(labels(findTrigger("/mo", 3)), ["/model"]);
});

test("a command match on a non-prefix substring still ranks, after the prefixes", () => {
  // "ea" appears inside /clear; nothing starts with it.
  assert.deepEqual(labels(findTrigger("/ea", 3)), ["/clear"]);
});

test("an unmatched command query yields nothing rather than everything", () => {
  assert.deepEqual(labels(findTrigger("/zzz", 4)), []);
});

// -- file suggestions -------------------------------------------------------

test("AC12: a bare @ lists the working directory", () => {
  const out = labels(findTrigger("@", 1));

  assert.ok(out.includes("src/"), "directories are marked with a trailing slash");
  assert.ok(out.includes("README.md"));
});

test("AC12: @src (no slash) matches — the engine's completer could not do this", () => {
  assert.deepEqual(labels(findTrigger("@src", 4)), ["src/"]);
});

test("AC12: a trailing slash descends into the directory", () => {
  const out = labels(findTrigger("@src/", 5));

  assert.ok(out.includes("src/cli.ts"));
  assert.ok(out.includes("src/kernel/"));
});

test("dotfiles are hidden until the query asks for them", () => {
  assert.ok(!labels(findTrigger("@", 1)).includes(".env"));
  assert.ok(labels(findTrigger("@.", 2)).includes(".env"));
});

test("an unreadable directory yields no suggestions rather than throwing", () => {
  assert.doesNotThrow(() => labels(findTrigger("@nope/", 6)));
  assert.deepEqual(labels(findTrigger("@nope/", 6)), []);
});

test("file matching is case-insensitive", () => {
  assert.ok(labels(findTrigger("@readme", 7)).includes("README.md"));
});

// -- acceptance -------------------------------------------------------------

test("AC12: accepting a command replaces the trigger and leaves a trailing space", () => {
  const t = findTrigger("/mo", 3)!;
  const choice = suggest(t, ctx)[0]!;

  assert.deepEqual(accept("/mo", 3, t, choice), { text: "/model ", cursor: 7 });
});

test("AC12: accepting a file splices into the surrounding sentence", () => {
  const text = "please read @REA and summarise";
  const cursor = 16; // right after "@REA"
  const t = findTrigger(text, cursor)!;
  const choice = suggest(t, ctx).find((s) => s.label === "README.md")!;

  const out = accept(text, cursor, t, choice);
  assert.equal(out.text, "please read @README.md  and summarise");
  assert.equal(out.cursor, "please read @README.md ".length);
});

test("accepting a directory leaves the trailing slash so completion continues", () => {
  const t = findTrigger("@src", 4)!;
  const choice = suggest(t, ctx)[0]!;

  assert.equal(accept("@src", 4, t, choice).text, "@src/");
});
