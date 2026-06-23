/**
 * Tests for decode-normalize — the shared pre-inspection decode layer behind
 * `bash-policy` and `risk-guard`.
 *
 * Two halves, both offline (`node:test` via `tsx`):
 *  - Unit tests of the pure `normalizeForInspection` (each encoding, the D7 emit
 *    gate, the depth bound, fail-open, raw exclusion, dedup). No provider.
 *  - Integration tests that load `bash-policy` and `risk-guard` directly via
 *    `host.use(id, activate)` (NOT depending on `BUILTIN_EXTENSIONS`) with a
 *    scriptable `MockProvider`, asserting the decode layer widens the candidate
 *    set / annotates the judge prompt, and that `EAGENT_DECODE_NORMALIZE=off`
 *    restores literal-only behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeForInspection } from "../src/extensions/lib/decode.js";
import bashPolicy, { type Rule } from "../src/extensions/bash-policy.js";
import riskGuard from "../src/extensions/risk-guard.js";
import { defineTool } from "../src/kernel/define.js";
import type { Agent } from "../src/kernel/agent.js";
import type { ExtensionAPI } from "../src/kernel/extension.js";
import type { CompletionRequest } from "../src/kernel/types.js";
import { MockProvider } from "../src/providers/mock.js";
import { makeHarness, type Harness } from "./helpers.js";

// In-test base64 wrapper so the depth/dedup fixtures are self-documenting.
const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

// -- T2-T8: unit (pure normalizeForInspection) --------------------------------

test("AC1: echo <b64>|base64 -d|sh idiom surfaces the decoded destructive payload", () => {
  const out = normalizeForInspection("echo cm0gLXJmIC8=|base64 -d|sh");
  assert.ok(out.some((c) => /rm -rf \//.test(c)), `expected a rm -rf / candidate, got ${JSON.stringify(out)}`);
});

test("AC2: printf '\\xNN'|sh hex-escape idiom surfaces the decoded payload", () => {
  const out = normalizeForInspection("printf '\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x2f'|sh");
  assert.ok(out.some((c) => /rm -rf \//.test(c)), `expected a rm -rf / candidate, got ${JSON.stringify(out)}`);
});

test("AC3: a rot13'd command with a known-command first token is surfaced", () => {
  // rot13("ez -es /") === "rm -rf /"; first token `rm` is a known command.
  const out = normalizeForInspection("ez -es /");
  assert.ok(out.includes("rm -rf /"), `expected rm -rf /, got ${JSON.stringify(out)}`);
});

test("AC4: invisible-Unicode-obfuscated payloads are stripped before matching", () => {
  // Interleave zero-width (U+200B) and a Plane-14 tag char (U+E0041) into rm -rf /.
  const zw = String.fromCodePoint(0x200b);
  const tag = String.fromCodePoint(0xe0041);
  const obf = `r${zw}m${tag} -rf ${zw}/`;
  assert.notEqual(obf, "rm -rf /");
  const out = normalizeForInspection(obf);
  assert.ok(out.some((c) => /^rm -rf \//.test(c)), `expected a stripped rm -rf / candidate, got ${JSON.stringify(out)}`);
});

test("AC5: the emit gate (not raw-exclusion) drops total-decoder garbage; benign yields exactly []", () => {
  // rot13("ls -la") = "yf -yn" is produced and !== raw, but first token `yf` is
  // not a known command, so conjunct-2 drops it; base64/hex of "ls -la" decode to
  // invalid UTF-8 so conjunct-1 drops them. Exact [] distinguishes correct gating
  // from the un-gated ["yf -yn"].
  assert.deepEqual(normalizeForInspection("ls -la"), []);
  // No duplicates on a case that does emit.
  const emitted = normalizeForInspection("echo cm0gLXJmIC8=|base64 -d|sh");
  assert.equal(new Set(emitted).size, emitted.length, "no duplicate candidates");
});

test("AC6: fail-open on silent-garbage base64 — no command-looking candidate, no throw", () => {
  let out: string[] = [];
  assert.doesNotThrow(() => {
    out = normalizeForInspection("echo not-valid-base64!!! | base64 -d");
  });
  // The decoded bytes carry U+FFFD; conjunct-1 rejects them — no real command family.
  assert.ok(!out.some((c) => /\brm\b|\bsh\b|\bcurl\b|\bwget\b/.test(c)), `unexpected command candidate: ${JSON.stringify(out)}`);
});

test("AC7: decode depth is bounded at 2 — cleartext one layer beyond the bound is unreached", () => {
  const tripleWrapped = b64(b64(b64("rm -rf /"))); // "WTIwd1oweFlTbTFKUXpnOQ=="
  const triple = normalizeForInspection(tripleWrapped);
  // Load-bearing, gate-independent: cleartext is one decode past DECODE_DEPTH=2.
  assert.ok(!triple.some((c) => /rm -rf \//.test(c)), `cleartext leaked past the bound: ${JSON.stringify(triple)}`);
  // The set is NOT empty — the depth-1 intermediate is an un-padded emittable junk candidate.
  assert.notDeepEqual(triple, []);

  // The double-wrapped form IS decoded to cleartext (depth 2 reaches it).
  const doubleWrapped = b64(b64("rm -rf /"));
  const dbl = normalizeForInspection(doubleWrapped);
  assert.ok(dbl.some((c) => /rm -rf \//.test(c)), `double-wrap should reach cleartext, got ${JSON.stringify(dbl)}`);
});

// -- bash-policy live harness (mirrors test/bash-policy.test.ts:173-195) -------

/** Register a shell:exec tool whose execute flips a flag, so blocking is observable. */
function shellTool(agent: Agent, name = "bash"): () => boolean {
  let ran = false;
  agent.tools.register(
    defineTool({
      name,
      description: "",
      capabilities: ["shell:exec"],
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: () => {
        ran = true;
        return { content: "ran" };
      },
    }),
  );
  return () => ran;
}

/** Did any tool-result the model saw carry a bash-policy block reason? */
function sawBlock(agent: Agent): boolean {
  return agent.messages
    .filter((m) => m.role === "tool")
    .some((m) => m.content.some((b) => b.type === "tool_result" && /bash-policy: /.test(b.content)));
}

async function loadBashPolicy(h: Harness, rules: Rule[]): Promise<void> {
  await h.host.use("bash-policy", (e) => {
    e.store.set("rules", rules);
    return bashPolicy(e);
  });
}

// -- T15: bash-policy blocks obfuscated payloads -------------------------------

test("AC8: bash-policy deny blocks an echo|base64 -d|sh obfuscated rm the literal rule would miss", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      { toolCalls: [{ name: "bash", arguments: { command: "echo cm0gLXJmIC8=|base64 -d|sh" } }] },
      { text: "done" },
    ],
  });
  const didRun = shellTool(h.agent);
  await loadBashPolicy(h, [{ pattern: "rm *", action: "deny" }]);

  await h.agent.run("run it");
  assert.equal(didRun(), false, "the decoded rm -rf / is blocked by the rm * deny rule");
  assert.equal(sawBlock(h.agent), true, "the model sees a bash-policy block reason");
});

test("AC8: bash-policy deny blocks a printf '\\xNN'|sh obfuscated rm", async () => {
  const h = makeHarness({
    fallback: "allow",
    responder: [
      {
        toolCalls: [
          { name: "bash", arguments: { command: "printf '\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x2f'|sh" } },
        ],
      },
      { text: "done" },
    ],
  });
  const didRun = shellTool(h.agent);
  await loadBashPolicy(h, [{ pattern: "rm *", action: "deny" }]);

  await h.agent.run("run it");
  assert.equal(didRun(), false, "the decoded rm -rf / is blocked");
  assert.equal(sawBlock(h.agent), true);
});

// -- T16: kill switch restores literal-only matching ---------------------------

test("AC9: EAGENT_DECODE_NORMALIZE=off restores literal-only — the obfuscated call runs", async () => {
  const prev = process.env.EAGENT_DECODE_NORMALIZE;
  process.env.EAGENT_DECODE_NORMALIZE = "off";
  try {
    const h = makeHarness({
      fallback: "allow",
      responder: [
        { toolCalls: [{ name: "bash", arguments: { command: "echo cm0gLXJmIC8=|base64 -d|sh" } }] },
        { text: "done" },
      ],
    });
    const didRun = shellTool(h.agent);
    await loadBashPolicy(h, [{ pattern: "rm *", action: "deny" }]);

    await h.agent.run("run it");
    assert.equal(didRun(), true, "with decode off, only literal echo/base64/sh candidates exist — rm * misses");
    assert.equal(sawBlock(h.agent), false, "no block when the decode layer is disabled");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_DECODE_NORMALIZE;
    else process.env.EAGENT_DECODE_NORMALIZE = prev;
  }
});

// -- risk-guard live harness (mirrors test/risk-guard.test.ts:53-63) -----------

/** A MockProvider that returns one scripted verdict and captures the user-message text. */
class Capturing extends MockProvider {
  userText = "";
  constructor(verdict = "SAFE") {
    super(() => ({ text: verdict }));
  }
  override async *stream(req: CompletionRequest) {
    const last = req.messages[req.messages.length - 1];
    if (last) {
      this.userText = last.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
    yield* super.stream(req);
  }
}

async function activateRiskGuard(h: Harness): Promise<ExtensionAPI> {
  let api!: ExtensionAPI;
  await h.host.use("risk-guard", (e) => {
    api = e;
    e.store.set("enabled", true);
    e.store.set("mode", "ask");
    return riskGuard(e);
  });
  return api;
}

function toolCall(name: string, args: Record<string, unknown>) {
  return { type: "tool_call" as const, id: "1", name, arguments: args };
}

// -- T18: risk-guard judge prompt annotation + the documented asymmetry --------

test("AC11: risk-guard annotates the judge prompt with the decoded payload for an obfuscated arg", async () => {
  const h = makeHarness();
  shellTool(h.agent);
  const c = new Capturing("SAFE");
  h.agent.providers.register(c, { default: true });
  await activateRiskGuard(h);

  await h.agent.hooks.apply(
    "beforeToolCall",
    { block: false, arguments: {} },
    { call: toolCall("bash", { cmd: "echo cm0gLXJmIC8=|base64 -d|sh" }) },
  );

  assert.match(c.userText, /\[decoded payload:/, "judge prompt carries a decoded-payload note");
  assert.match(c.userText, /rm -rf \//, "the decoded rm -rf / is shown to the judge");
});

test("AC11 (negative): a rot13'd arg is NOT surfaced to risk-guard (whole-blob asymmetry)", async () => {
  const h = makeHarness();
  shellTool(h.agent);
  const c = new Capturing("SAFE");
  h.agent.providers.register(c, { default: true });
  await activateRiskGuard(h);

  await h.agent.hooks.apply(
    "beforeToolCall",
    { block: false, arguments: {} },
    { call: toolCall("bash", { cmd: "ez -es /" }) },
  );

  // The whole-string rot13/known-command gate sees the JSON wrapper token
  // `{"cmd":"ez` as the first token, which is not a known command, so nothing is
  // surfaced — the deliberate asymmetry vs bash-policy (Deliverable 3, D5).
  assert.doesNotMatch(c.userText, /\[decoded payload:/, "rot13-in-arg is intentionally out of reach for risk-guard");
});

// -- T19: kill switch leaves the risk-guard prompt unchanged --------------------

test("AC12: EAGENT_DECODE_NORMALIZE=off leaves the risk-guard prompt unannotated", async () => {
  const prev = process.env.EAGENT_DECODE_NORMALIZE;
  process.env.EAGENT_DECODE_NORMALIZE = "off";
  try {
    const h = makeHarness();
    shellTool(h.agent);
    const c = new Capturing("SAFE");
    h.agent.providers.register(c, { default: true });
    await activateRiskGuard(h);

    await h.agent.hooks.apply(
      "beforeToolCall",
      { block: false, arguments: {} },
      { call: toolCall("bash", { cmd: "echo cm0gLXJmIC8=|base64 -d|sh" }) },
    );

    assert.doesNotMatch(c.userText, /\[decoded payload:/, "decode off → byte-identical prompt");
  } finally {
    if (prev === undefined) delete process.env.EAGENT_DECODE_NORMALIZE;
    else process.env.EAGENT_DECODE_NORMALIZE = prev;
  }
});
