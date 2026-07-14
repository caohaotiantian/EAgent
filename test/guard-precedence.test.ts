/**
 * guard-precedence — drift guard for the documented `beforeToolCall` precedence
 * order (design 2026-07-11-guard-telemetry-precedence, AC4 / D1).
 *
 * Guards run as `beforeToolCall` filters in `BUILTIN_EXTENSIONS` load order and
 * the first `block:true` short-circuits the rest — so the load order IS the
 * precedence order. This test derives the live registrant order by activating
 * the built-ins one at a time onto a fresh host and recording which activation
 * grows `bus.listenerCount("beforeToolCall")` by 1 (the bus stores no filter
 * name, so activation-order is the only handle). It then asserts that order
 * equals the roster documented in SECURITY.md, so a future reorder/add fails
 * loudly instead of silently drifting the contract.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BUILTIN_EXTENSIONS } from "../src/host.js";
import { makeHarness } from "./helpers.js";

/** The documented precedence roster (SECURITY.md "Guard precedence", design §2 D1). */
const DOCUMENTED_ROSTER = [
  "templates",
  "provenance",
  "circuit-breaker",
  "planmode",
  "limits",
  "budget-cap",
  "checkpoint",
  "flow-guard",
  "risk-guard",
  "headless-flags",
  "bash-policy",
  "sandbox-tiers",
  "config-hooks",
  "write-guard",
  "secret-guard",
  "skills-hardening",
  "self-extend-floor",
] as const;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the live beforeToolCall registrant order equals the documented roster", async () => {
  const h = makeHarness({ fallback: "allow" });
  const roster: string[] = [];
  let prev = h.agent.hooks.listenerCount("beforeToolCall");
  for (const [id, activate] of BUILTIN_EXTENSIONS) {
    await h.host.use(id, activate);
    const now = h.agent.hooks.listenerCount("beforeToolCall");
    assert.ok(
      now === prev || now === prev + 1,
      `${id} registered ${now - prev} beforeToolCall filters (expected 0 or 1)`,
    );
    if (now === prev + 1) roster.push(id);
    prev = now;
  }
  assert.deepEqual(roster, [...DOCUMENTED_ROSTER]);
  await h.host.dispose();
});

test("SECURITY.md documents the Guard precedence roster in the live order", () => {
  const security = readFileSync(join(repoRoot, "SECURITY.md"), "utf8");
  const start = security.search(/^#{2,4} Guard precedence\s*$/m);
  assert.ok(start >= 0, "SECURITY.md has a 'Guard precedence' heading");
  // Start after the heading LINE, else the next-heading search matches the
  // heading itself and yields an empty section.
  const rest = security.slice(security.indexOf("\n", start) + 1);
  const nextHeading = rest.search(/^#{1,6} /m);
  const section = nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;

  let last = -1;
  for (const name of DOCUMENTED_ROSTER) {
    const idx = section.indexOf(`\`${name}\``);
    assert.ok(idx >= 0, `SECURITY.md 'Guard precedence' names \`${name}\``);
    assert.ok(idx > last, `\`${name}\` appears in the documented precedence order`);
    last = idx;
  }
});

test("docs/EXTENSIONS.md cross-links the guard precedence contract", () => {
  const ext = readFileSync(join(repoRoot, "docs", "EXTENSIONS.md"), "utf8");
  assert.match(ext, /Guard precedence/, "EXTENSIONS.md cross-links the SECURITY.md precedence contract");
});
