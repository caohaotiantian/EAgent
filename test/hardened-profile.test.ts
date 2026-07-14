/**
 * Hardened server profile — end-to-end wiring.
 *
 * Invariant: building a host with `hardened` makes the enforcing guards resolve
 * active and confining (risk-guard + provenance enabled, sandbox tier
 * `workspace-write`) without persisting anything; a kill switch still wins; and a
 * non-hardened host is byte-unchanged. Offline against `MockProvider`; every host
 * is built with an isolated temp store root so no persisted state leaks in.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createAgentHost, type AgentHostOptions } from "../src/host.js";
import { MockProvider } from "../src/providers/mock.js";
import { MemoryStore } from "../src/kernel/store.js";
import type { CompletionRequest, Logger, UI } from "../src/kernel/types.js";

/** A MockProvider that returns one scripted verdict line (mirrors risk-guard's). */
class Classifier extends MockProvider {
  constructor(verdict: string) {
    super(() => ({ text: verdict }));
  }
  override async *stream(req: CompletionRequest) {
    yield* super.stream(req);
  }
}

/** A fresh isolated store root, so no real ~/.eagent state bleeds into a test. */
function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "eagent-hardened-"));
}

/** Build an offline host with an isolated store and no extension discovery. */
function buildHost(opts: AgentHostOptions = {}) {
  return createAgentHost({ provider: "mock", storeRoot: tmpRoot(), discoverDirs: [], ...opts });
}

const touched: string[] = [];
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k];
});

// -- AC1: guards resolve enforcing under hardened ----------------------------

test("AC1: hardened resolves risk-guard + provenance on and tier=workspace-write", async () => {
  const built = await buildHost({ hardened: true });
  try {
    const store = new MemoryStore();
    assert.equal(built.config.enabled("risk-guard", { store }), true);
    assert.equal(built.config.enabled("provenance", { store }), true);
    assert.equal(built.config.string("sandbox.tier"), "workspace-write");
  } finally {
    await built.host.dispose();
  }
});

// -- AC6: hardened enables content-guard local fencing -----------------------

test("AC6: hardened resolves contentGuard.fenceLocal on", async () => {
  const built = await buildHost({ hardened: true });
  try {
    assert.equal(built.config.bool("contentGuard.fenceLocal", false), true);
  } finally {
    await built.host.dispose();
  }
});

test("AC6: a non-hardened host leaves contentGuard.fenceLocal off", async () => {
  const built = await buildHost();
  try {
    assert.equal(built.config.bool("contentGuard.fenceLocal", false), false);
  } finally {
    await built.host.dispose();
  }
});

// -- AC3: non-hardened is unchanged (regression guard) -----------------------

test("AC3: a non-hardened host leaves the guards inert", async () => {
  const built = await buildHost();
  try {
    const store = new MemoryStore();
    assert.equal(built.config.enabled("risk-guard", { store }), false);
    assert.equal(built.config.string("sandbox.tier"), undefined);
  } finally {
    await built.host.dispose();
  }
});

// -- AC4: the env kill switch beats the preset -------------------------------

test("AC4: EAGENT_RISK_GUARD=off disables risk-guard even under hardened", async () => {
  touched.push("EAGENT_RISK_GUARD");
  process.env.EAGENT_RISK_GUARD = "off";
  const built = await buildHost({ hardened: true });
  try {
    const store = new MemoryStore();
    assert.equal(built.config.enabled("risk-guard", { store }), false);
  } finally {
    await built.host.dispose();
  }
});

// -- AC2: hardened turns a high-risk verdict into enforcement ----------------

test("AC2: a hardened host blocks a call the classifier rates risky", async () => {
  const ui: UI = { confirm: async () => false, notify: () => {} };
  const built = await buildHost({ hardened: true, ui });
  try {
    // Overwrite the host's default MockProvider with a scripted high-risk
    // classifier so risk-guard's no-arg providers.get() resolves to it.
    built.agent.providers.register(new Classifier("RISKY: exfiltrates secrets"), { default: true });

    const decision = await built.agent.hooks.apply(
      "beforeToolCall",
      { block: false, arguments: { command: "echo hi" } },
      { call: { type: "tool_call", id: "1", name: "bash", arguments: { command: "echo hi" } } },
    );

    assert.equal(decision.block, true);
    assert.match(decision.reason ?? "", /risk-guard/);
  } finally {
    await built.host.dispose();
  }
});

// -- AC7: the hardened startup banner is observable via the logger -----------

test("AC7: hardened logs a banner naming the guards and the resolved tier", async () => {
  const lines: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (...a) => lines.push(a.join(" ")),
    warn: () => {},
    error: () => {},
  };
  const built = await buildHost({ hardened: true, logger });
  try {
    const banner = lines.find((l) => /hardened/i.test(l));
    assert.ok(banner, "a hardened banner line is logged");
    assert.match(banner!, /risk-guard/);
    assert.match(banner!, /provenance/);
    assert.match(banner!, /workspace-write/);
  } finally {
    await built.host.dispose();
  }
});
