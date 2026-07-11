/**
 * AC4 — both front ends adopt the shared JSONL mapper and no longer hand-roll a
 * divergent object for a common streaming event.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const fronts = [
  ["cli.ts", readFileSync(join(srcDir, "cli.ts"), "utf8")],
  ["server.ts", readFileSync(join(srcDir, "server.ts"), "utf8")],
] as const;

test("AC4: both front ends import and wire the shared JSONL mapper", () => {
  for (const [name, src] of fronts) {
    assert.match(src, /from "\.\/jsonl\.js"/, `${name} imports the shared mapper`);
    assert.match(src, /wireJsonl\(/, `${name} wires the common streaming handlers via wireJsonl`);
  }
});

test("AC4: neither front end hand-rolls a divergent common-event JSONL object", () => {
  // The common streaming events are shaped only in src/jsonl.ts now; a front end
  // building one of these inline would reintroduce the schema divergence.
  const commonEvents = ["text_delta", "reasoning_delta", "message", "tool_start", "tool_end", "usage"];
  for (const [name, src] of fronts) {
    for (const event of commonEvents) {
      assert.doesNotMatch(
        src,
        new RegExp(`type:\\s*"${event}"`),
        `${name} must not hand-roll a { type: "${event}" } object`,
      );
    }
  }
});
