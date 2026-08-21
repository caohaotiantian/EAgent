import assert from "node:assert/strict";
import { test } from "node:test";

import { CapabilityError, CapabilityManager, matchPattern } from "../src/kernel/capabilities.ts";

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

/** A UI whose confirm counts calls and returns promises the test resolves manually. */
function deferredUI() {
  const resolvers: Array<(ok: boolean) => void> = [];
  let calls = 0;
  return {
    ui: {
      confirm: () =>
        new Promise<boolean>((res) => {
          calls++;
          resolvers.push(res);
        }),
      notify: () => {},
    },
    calls: () => calls,
    resolveAll: (ok: boolean) => resolvers.forEach((r) => r(ok)),
  };
}

test("concurrent callers for the same unremembered cap share one prompt", async () => {
  const d = deferredUI();
  const mgr = new CapabilityManager({ fallback: "ask", ui: d.ui });
  const both = Promise.all([mgr.require("net:fetch", "a"), mgr.require("net:fetch", "b")]);
  assert.equal(d.calls(), 1, "both callers should share a single confirm");
  d.resolveAll(true);
  await both;
  assert.equal(d.calls(), 1);
  const audit = mgr.audit();
  assert.equal(audit.length, 2, "each caller still records its own audit entry");
  assert.ok(
    audit.every((e) => e.decision === "allow" && e.prompted === true),
    "both entries are allow + human-sourced",
  );
});

test("concurrent deny is shared, remembered, and short-circuits after", async () => {
  const d = deferredUI();
  const mgr = new CapabilityManager({ fallback: "ask", ui: d.ui });
  const settled = Promise.allSettled([mgr.require("net:fetch", "a"), mgr.require("net:fetch", "b")]);
  assert.equal(d.calls(), 1);
  d.resolveAll(false);
  const results = await settled;
  assert.ok(
    results.every((r) => r.status === "rejected" && r.reason instanceof CapabilityError),
    "both callers reject with CapabilityError",
  );
  assert.equal(d.calls(), 1);
  // The shared deny is remembered as false: a later require short-circuits, no new prompt.
  await assert.rejects(() => mgr.require("net:fetch", "later"), /previously declined/);
  assert.equal(d.calls(), 1);
});

test("a fresh unremembered cap prompts once (memo not cross-contaminated)", async () => {
  const d = deferredUI();
  const mgr = new CapabilityManager({ fallback: "ask", ui: d.ui });
  const w1 = Promise.all([mgr.require("net:fetch", "a"), mgr.require("net:fetch", "b")]);
  assert.equal(d.calls(), 1);
  d.resolveAll(true);
  await w1;
  const w2 = Promise.all([mgr.require("shell:exec", "c"), mgr.require("shell:exec", "d")]);
  assert.equal(d.calls(), 2, "a different cap prompts once more");
  d.resolveAll(true);
  await w2;
  assert.equal(d.calls(), 2);
  assert.equal(mgr.audit().length, 4);
});

// A runtime grant is revocable and reference-counted: a shared pattern survives
// until its last granter disposes, a baseline grant is never revoked, and a
// double-dispose never over-revokes a sibling. Managers use the default `ask`
// fallback so `isGranted` reports `false` for an ungranted cap (an `allow`
// fallback would mask revocation).

test("a runtime grant is revocable via its Disposable", () => {
  const mgr = new CapabilityManager();
  const d = mgr.grant("test:cap");
  assert.equal(mgr.isGranted("test:cap"), true);
  d.dispose();
  assert.equal(mgr.isGranted("test:cap"), false);
});

test("shared runtime grants are reference-counted (survive until the last granter disposes)", () => {
  const mgr = new CapabilityManager();
  const a = mgr.grant("shared:cap");
  const b = mgr.grant("shared:cap");
  a.dispose();
  assert.equal(mgr.isGranted("shared:cap"), true, "one granter left keeps it granted");
  b.dispose();
  assert.equal(mgr.isGranted("shared:cap"), false, "the last granter disposing revokes it");
});

test("a baseline (constructor) grant survives a same-pattern runtime grant's dispose", () => {
  const mgr = new CapabilityManager({ grant: ["base:cap"] });
  const d = mgr.grant("base:cap");
  d.dispose();
  assert.equal(mgr.isGranted("base:cap"), true, "the baseline instance is never revoked");
});

test("a double-dispose is idempotent and never over-revokes a sibling", () => {
  const mgr = new CapabilityManager();
  const d = mgr.grant("i:cap");
  d.dispose();
  const d2 = mgr.grant("i:cap");
  d.dispose(); // second dispose of d must not splice d2's instance
  assert.equal(mgr.isGranted("i:cap"), true);
});
