/**
 * Security regression: write-guard still prompts before a blind overwrite of an
 * unread existing file, and a "no" leaves the file untouched.
 *
 * Offline through the agent loop via `makeHarness` + `host.use`, against a real
 * temp-file workspace; reuses the attack shape from `test/write-guard.test.ts:80-101`.
 * Asserts the defining action: the unread overwrite is asked exactly once and the
 * file is NOT clobbered.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { UI } from "../../src/kernel/types.js";
import { makeHarness } from "../helpers.js";
import coreTools from "../../src/extensions/core-tools.js";
import writeGuard from "../../src/extensions/write-guard.js";

const ORIGINAL = "const greeting = 'hello world';\n";

test("write-guard asks once and blocks a blind overwrite of an unread file (a 'no')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "eagent-sec-write-guard-"));
  const file = join(dir, "x.ts");
  writeFileSync(file, ORIGINAL);
  const prev = process.env.EAGENT_WORKSPACE;
  process.env.EAGENT_WORKSPACE = dir;

  let confirms = 0;
  const ui: UI = {
    confirm: async () => {
      confirms += 1;
      return false; // the human declines the clobber
    },
    notify: () => {},
  };

  try {
    const h = makeHarness({
      ui,
      responder: [
        { toolCalls: [{ name: "write", arguments: { path: "x.ts", content: "CLOBBERED" } }] },
        { text: "done" },
      ],
    });
    await h.host.use("core-tools", coreTools);
    await h.host.use("write-guard", writeGuard);

    await h.agent.run("regenerate x.ts");

    assert.equal(confirms, 1, "the unread overwrite prompts exactly once");
    const sawBlock = h.agent.messages
      .filter((m) => m.role === "tool")
      .some((m) => m.content.some((b) => b.type === "tool_result" && /write-guard: /.test(b.content)));
    assert.ok(sawBlock, "the model sees a write-guard block reason");
    assert.equal(readFileSync(file, "utf8"), ORIGINAL, "the file was not clobbered");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_WORKSPACE;
    else process.env.EAGENT_WORKSPACE = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
