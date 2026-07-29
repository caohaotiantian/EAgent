/**
 * Doc surface pin for the terminal UI (AC16).
 *
 * The load-bearing half is negative: the docs must never re-advertise a removed
 * surface, and must never sanction `ink`/`react` inside the engine. That guard is
 * what keeps the `tui/` package boundary honest, so this file is rewritten as the
 * surface changes — never deleted.
 *
 * The positive half asserts the docs describe what actually ships today: a
 * headless engine CLI plus a separate Ink TUI package.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Modules deleted with the old display layer; no doc may present them as shipped. */
const REMOVED_MODULES = [/engine-render/, /view-model/, /src\/attribution/, /src\/tty/];

test("AC16: CLAUDE.md keeps the engine zero-dep charter and sanctions no in-engine ink", () => {
  const md = read("CLAUDE.md");
  assert.match(md, /jiti/, "mentions jiti");
  assert.match(md, /[Zz]ero runtime dependenc/, "states zero runtime deps");
  assert.doesNotMatch(md, /src\/tui\//, "the TUI is a package, not src/tui/");
  assert.doesNotMatch(md, /MAY use[\s\S]{0,80}ink/i, "must not allow ink inside the engine");
});

test("AC16: ARCHITECTURE.md keeps zero-dep and documents no removed module", () => {
  const md = read("ARCHITECTURE.md");
  assert.match(md, /jiti/, "mentions jiti");
  assert.match(md, /zero runtime dependenc/i, "zero runtime deps");
  assert.doesNotMatch(md, /src\/tui\//, "no src/tui/");
  for (const re of REMOVED_MODULES) {
    assert.doesNotMatch(md, re, `must not document the removed ${re}`);
  }
});

test("AC16: README.md documents no removed module and no deleted web SPA workflow", () => {
  const md = read("README.md");
  assert.doesNotMatch(md, /src\/tui\//, "layout must not list src/tui/");
  assert.doesNotMatch(md, /build:web|dev:web|test:web/, "web SPA scripts are gone");
  for (const re of REMOVED_MODULES) {
    assert.doesNotMatch(md, re, `must not document the removed ${re}`);
  }
});

test("AC16: docs/TUI.md describes the headless CLI and the Ink TUI package", () => {
  const md = read("docs/TUI.md");
  assert.match(md, /headless/i, "documents the headless machine CLI");
  assert.match(md, /[Ii]nk/, "names the Ink TUI package");
  assert.match(md, /zero runtime dependenc/i, "restates the engine charter");
  assert.doesNotMatch(md, /build:web/, "no web build instructions");
  for (const re of REMOVED_MODULES) {
    assert.doesNotMatch(md, re, `must not document the removed ${re}`);
  }
});

test("AC16: docs/WEB.md is gone — the web SPA is not a shipped surface", () => {
  assert.equal(existsSync(join(repoRoot, "docs", "WEB.md")), false, "docs/WEB.md was removed with web/");
});
