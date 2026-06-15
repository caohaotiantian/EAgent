import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityError, CapabilityManager, matchPattern } from "../src/kernel/capabilities.js";

test("wildcard patterns match by segment", () => {
  assert.ok(matchPattern("fs:read", "fs:*"));
  assert.ok(matchPattern("fs:read", "*"));
  assert.ok(matchPattern("fs:read", "fs:read"));
  assert.equal(matchPattern("net:fetch", "fs:*"), false);
});

test("granted capabilities pass without prompting", async () => {
  const caps = new CapabilityManager({ grant: ["fs:*"] });
  await caps.require("fs:read", "read");
  assert.equal(caps.audit().at(-1)?.decision, "allow");
  assert.equal(caps.audit().at(-1)?.prompted, false);
});

test("deny takes precedence over grant", async () => {
  const caps = new CapabilityManager({ grant: ["*"], deny: ["shell:exec"] });
  await assert.rejects(() => caps.require("shell:exec", "bash"), CapabilityError);
});

test("ask fallback prompts the UI and remembers the answer", async () => {
  let prompts = 0;
  const caps = new CapabilityManager({
    fallback: "ask",
    ui: {
      confirm: async () => {
        prompts++;
        return true;
      },
      notify: () => {},
    },
  });
  await caps.require("skill:write", "skill_create");
  await caps.require("skill:write", "skill_create");
  assert.equal(prompts, 1, "second check should reuse the remembered answer");
});

test("ask fallback with no UI denies", async () => {
  const caps = new CapabilityManager({ fallback: "ask" });
  await assert.rejects(() => caps.require("net:fetch", "x"), CapabilityError);
});

test("declining a prompt is remembered and keeps denying", async () => {
  const caps = new CapabilityManager({
    fallback: "ask",
    ui: { confirm: async () => false, notify: () => {} },
  });
  await assert.rejects(() => caps.require("shell:exec", "bash"), CapabilityError);
  await assert.rejects(() => caps.require("shell:exec", "bash"), CapabilityError);
  assert.equal(caps.audit().length, 2);
});
