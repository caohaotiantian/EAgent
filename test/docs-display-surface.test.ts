/**
 * Doc surface pin after dropping the Ink TUI (design 2026-07-27-drop-ink-tui AC6).
 * Ensures CLAUDE/README/ARCHITECTURE/docs/TUI.md/CHANGELOG cannot re-advertise
 * eagent-tui as a shipped product surface.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

/** Forbidden as *install/run instructions* for the removed product. */
const INSTALL_HINTS = [/npm run build:tui/, /npm run test:tui/, /eagent-tui\s+--monitor/, /^eagent-tui\s*$/m];

test("AC6: CLAUDE.md zero-dep charter and no shipped eagent-tui / src/tui", () => {
  const md = read("CLAUDE.md");
  assert.match(md, /jiti/, "mentions jiti");
  assert.match(md, /[Zz]ero runtime dependenc/, "states zero runtime deps");
  assert.doesNotMatch(md, /src\/tui\//, "must not document src/tui/ as a path");
  assert.doesNotMatch(md, /eagent-tui/, "must not document eagent-tui");
  assert.doesNotMatch(md, /MAY use[\s\S]{0,80}ink/i, "must not allow ink under a tui exception");
  assert.doesNotMatch(md, /test\/tui-isolation/, "isolation suite replaced by zero-dep pin");
});

test("AC6: README.md does not instruct eagent-tui / build:tui / list src/tui as Ink client", () => {
  const md = read("README.md");
  assert.doesNotMatch(md, /eagent-tui/, "no eagent-tui usage");
  assert.doesNotMatch(md, /build:tui|test:tui/, "no tui build scripts");
  assert.doesNotMatch(md, /src\/tui\//, "layout must not list src/tui/");
  assert.match(md, /engine-render/, "still documents plain renderer");
  assert.match(md, /[Ww]eb|browser/, "points rich UX at web/browser");
});

test("AC6: ARCHITECTURE.md no shipped eagent-tui / src/tui; zero-dep except jiti", () => {
  const md = read("ARCHITECTURE.md");
  assert.doesNotMatch(md, /eagent-tui/, "no eagent-tui");
  assert.doesNotMatch(md, /src\/tui\//, "no src/tui/");
  assert.doesNotMatch(md, /test\/tui-isolation/, "no tui-isolation reference");
  assert.match(md, /jiti/, "mentions jiti");
  assert.match(md, /zero runtime dependenc/i, "zero runtime deps");
});

test("AC6: docs/TUI.md is plain-CLI + planned web; no eagent-tui install/usage", () => {
  const md = read("docs/TUI.md");
  assert.doesNotMatch(md, /eagent-tui/, "no eagent-tui");
  assert.doesNotMatch(md, /build:tui|test:tui/, "no tui scripts");
  assert.match(md, /engine-render/, "describes plain CLI renderer");
  assert.match(md, /[Ww]eb|browser/, "mentions planned web");
  for (const re of INSTALL_HINTS) {
    assert.doesNotMatch(md, re, `must not match install hint ${re}`);
  }
});

test("AC6: CHANGELOG notes removal of Ink eagent-tui client", () => {
  const md = read("CHANGELOG.md");
  // Top Unreleased should include a Removed note about eagent-tui / Ink client.
  const head = md.slice(0, 2500);
  assert.match(head, /### Removed/, "Unreleased has Removed section");
  assert.match(head, /eagent-tui/, "removal note names eagent-tui");
  assert.match(head, /[Ii]nk/, "removal note mentions Ink");
});
