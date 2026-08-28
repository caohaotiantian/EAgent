/**
 * A node block may not carry a field the compiler cannot interpret.
 *
 * There was no unknown-field check anywhere, for any node type. `evaluator: {kind, ref,
 * threshold, effects: [...]}` compiled clean, warned nothing, and decided nothing — so an author
 * who had just read `FunctionNode.effects` believed they had declared a capability ceiling and
 * had not. This repository has named that failure four times under other names, and this instance
 * is worse than those: they are declared-and-inert, this one is declared, inert and PERMISSIVE.
 *
 * TypeScript's excess-property check hides it from anyone authoring a spec inside this repo. The
 * YAML path — how an operator actually writes a graph — has nothing.
 *
 * THE SECOND TEST IS THE ONE THAT KEEPS THIS HONEST. An allow-list's failure mode is refusing a
 * field somebody legitimately added, and a guard that cries wolf on correct code is worse than no
 * guard. So the list is checked against the interfaces it claims to enumerate, read out of
 * `spec.ts` rather than restated here — a restatement would be a third copy of one vocabulary,
 * which is the drift this file exists to prevent, one level up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compile } from "../../src/graph/compile.ts";
import {
  ALLOWED_FIELDS,
  EDGE_FIELDS,
  NESTED_FIELDS,
  NODE_FIELDS,
  POLICY_FIELDS,
  REQUIRED_BLOCK,
  SPEC_FIELDS,
  type NodeType,
} from "../../src/graph/spec.ts";
import { resolver } from "../run/skeleton.ts";

const SPEC_SRC = readFileSync(fileURLToPath(new URL("../../src/graph/spec.ts", import.meta.url)), "utf8");
/** `ChannelSpec` and `ContextProjection` live in the state layer, so the cross-check reads two files. */
const CHANNELS_SRC = readFileSync(fileURLToPath(new URL("../../src/state/channels.ts", import.meta.url)), "utf8");
/** `DeliverySpec` and `EscalationTier` live in `run/delivery.ts`, for the same reason — three files. */
const DELIVERY_SRC = readFileSync(fileURLToPath(new URL("../../src/run/delivery.ts", import.meta.url)), "utf8");

/** The interface each node type's block is typed as, e.g. `evaluator` → `EvaluatorNode`. */
const BLOCK_INTERFACE: Readonly<Record<NodeType, string>> = {
  function: "FunctionNode",
  agent: "AgentNode",
  tool: "ToolNode",
  router: "RouterNode",
  join: "JoinNode",
  evaluator: "EvaluatorNode",
  human_gate: "HumanGateNode",
  subgraph: "SubgraphNode",
};

/** Field names declared by an interface, read from the source rather than restated here. */
function membersOf(name: string, src: string = SPEC_SRC): readonly string[] {
  const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
  assert.ok(m, `interface ${name} moved or changed shape — this test reads it from the source`);
  return [...m[1]!.matchAll(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/gm)].map((x) => x[1]!).sort();
}

const graph = (block: string, body: Record<string, unknown>) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "af", project: "test", version: 1 },
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [{ id: "n", type: block === "humanGate" ? "human_gate" : block, reads: ["a"], writes: ["b"], [block]: body }],
      edges: [],
    } as never,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

test("AN UNKNOWN FIELD IN A NODE BLOCK IS REFUSED, and the message names it", () => {
  // The exact mistake: reading `FunctionNode.effects` and reaching for it on an evaluator.
  const r = graph("evaluator", { kind: "assertion", ref: "function/a@stable", threshold: 0.8, effects: ["pay.charge"] });

  assert.equal(r.ok, false, "a declared-and-uninterpretable field compiled clean");
  const codes = r.diagnostics.filter((x) => x.severity === "error").map((x) => x.code);
  assert.ok(codes.includes("GRAPH020_UNKNOWN_FIELD"), codes.join(", "));
  const diag = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD")!;
  assert.match(diag.message, /effects/, "the message must name the field the author wrote");
});

test("A TYPO GETS THE NEAREST REAL FIELD, not a list to read", () => {
  const r = graph("function", { ref: "function/a@stable", effectz: ["x"] });
  const diag = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD")!;
  assert.ok(diag !== undefined, "a misspelled field must not compile");
  assert.match(diag.fix ?? "", /effects/, `expected a suggestion, got: ${diag.fix ?? "(none)"}`);
});

test("EVERY FIELD THE INTERFACES DECLARE IS ALLOWED — the guard must not refuse valid graphs", () => {
  // An allow-list that has fallen behind its interface refuses graphs that are correct, which is
  // strictly worse than the hole it closed. Read from the source so the two cannot drift.
  for (const [type, iface] of Object.entries(BLOCK_INTERFACE) as [NodeType, string][]) {
    assert.deepEqual(
      [...ALLOWED_FIELDS[type]].sort(),
      membersOf(iface),
      `ALLOWED_FIELDS.${type} and ${iface} disagree — a field was added to one and not the other`,
    );
  }
});

test("the table covers every node type, and every type has a block", () => {
  // Non-vacuous: both loops above iterate tables, and a table that lost a member would make them
  // pass while checking less. `REQUIRED_BLOCK` is the independent enumeration to compare against.
  assert.deepEqual(Object.keys(ALLOWED_FIELDS).sort(), Object.keys(REQUIRED_BLOCK).sort());
  assert.deepEqual(Object.keys(BLOCK_INTERFACE).sort(), Object.keys(REQUIRED_BLOCK).sort());
  assert.equal(Object.keys(ALLOWED_FIELDS).length, 8, "eight node types");
});

// ── the three enclosing scopes ───────────────────────────────────────────────

/**
 * The block check left the node, the graph and the edge open, and the worst instance was there.
 *
 * Measured on a `tool` node, everything else identical:
 *
 *     policy:  { posture: "in" }   →  plan posture `in`
 *     policyy: { posture: "in" }   →  plan posture `out`, ZERO diagnostics
 *
 * Every other member of this family costs a feature. This one costs the control deciding whether
 * a human sees the action at all — the author asked for the strongest oversight the system has,
 * got the weakest, and was told nothing. `retry`, `timeoutMs` and `checkpoint` are discarded the
 * same way; `checkpoint`'s own docstring records a VALID value being ignored for months, which is
 * this defect with the misspelling on the compiler's side instead of the author's.
 */
const full = (over: { spec?: Record<string, unknown>; node?: Record<string, unknown>; edge?: Record<string, unknown> }) =>
  compile({
    spec: {
      apiVersion: "loom.dev/v1",
      kind: "GraphSpec",
      metadata: { name: "sc", project: "test", version: 1 },
      policy: { posture: "out", budget: { costUsd: 1 }, capabilities: [] },
      channels: { a: { type: "string", reduce: "replace" }, b: { type: "object", reduce: "replace" } },
      inputs: ["a"],
      outputs: ["b"],
      nodes: [
        { id: "n", type: "function", reads: ["a"], writes: ["b"], function: { ref: "function/f@stable" }, ...(over.node ?? {}) },
        { id: "m", type: "function", reads: ["b"], writes: ["b"], function: { ref: "function/f@stable" } },
      ],
      edges: [{ id: "e", from: "n", to: "m", kind: "seq", ...(over.edge ?? {}) }],
      ...(over.spec ?? {}),
    } as never,
    resolver: resolver(),
    tools: {},
    tenantCapabilities: [],
  });

const unknownField = (r: ReturnType<typeof compile>) => r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD");

test("A MISSPELLED `policy` IS REFUSED — the oversight control that silently vanished", () => {
  const r = full({ node: { policyy: { posture: "in" } } });

  assert.equal(r.ok, false, "a node asking for `in` and running at `out` compiled clean");
  const diag = unknownField(r)!;
  assert.ok(diag !== undefined, r.diagnostics.map((x) => x.code).join(", ") || "(no diagnostics)");
  assert.match(diag.message, /policyy/, "the message must name what the author wrote");
  assert.match(diag.fix ?? "", /`policy`/, `expected the near miss, got: ${diag.fix ?? "(none)"}`);
});

test("AN UNKNOWN TOP-LEVEL GRAPH FIELD IS REFUSED", () => {
  const r = full({ spec: { channelz: {} } });
  assert.equal(r.ok, false);
  assert.match(unknownField(r)!.message, /channelz/);
  assert.match(unknownField(r)!.fix ?? "", /`channels`/);
});

test("AN UNKNOWN EDGE FIELD IS REFUSED — a misspelled `when` fires every time", () => {
  // Not merely inert: the edge keeps running, unconditionally. The guard the author wrote is
  // absent rather than broken, which is the direction that does not announce itself.
  const r = full({ edge: { whenn: "a == 'x'" } });
  assert.equal(r.ok, false);
  assert.match(unknownField(r)!.message, /whenn/);
  assert.match(unknownField(r)!.fix ?? "", /`when`/);
});

test("EVERY FIELD THE THREE INTERFACES DECLARE IS ALLOWED — the guard must not refuse valid graphs", () => {
  // The same anti-cry-wolf check as the block table above, for the same reason: an allow-list
  // that has fallen behind its interface refuses correct graphs, which is worse than the hole.
  assert.deepEqual([...NODE_FIELDS].sort(), membersOf("NodeSpec"), "NODE_FIELDS and NodeSpec disagree");
  assert.deepEqual([...SPEC_FIELDS].sort(), membersOf("GraphSpec"), "SPEC_FIELDS and GraphSpec disagree");
  assert.deepEqual([...EDGE_FIELDS].sort(), membersOf("EdgeSpec"), "EDGE_FIELDS and EdgeSpec disagree");
});

test("EVERY FIELD THE POLICY INTERFACES DECLARE IS ALLOWED — the same, one level in", () => {
  // `POLICY_FIELDS` is read at one call site for four scopes, and the cry-wolf risk is higher
  // here than above: a field added to `Budget` and not to this table refuses a graph whose
  // budget is correct, and the author has no way to tell that from a real typo.
  const IFACE: Readonly<Record<keyof typeof POLICY_FIELDS, string>> = {
    graphPolicy: "GraphPolicy",
    nodePolicy: "NodePolicy",
    budget: "Budget",
    expansion: "ExpansionBudget",
  };
  for (const [key, iface] of Object.entries(IFACE) as [keyof typeof POLICY_FIELDS, string][]) {
    assert.deepEqual(
      [...POLICY_FIELDS[key]].sort(),
      membersOf(iface),
      `POLICY_FIELDS.${key} and ${iface} disagree — a field was added to one and not the other`,
    );
  }
  assert.deepEqual(Object.keys(POLICY_FIELDS).sort(), Object.keys(IFACE).sort(), "the table lost or gained a scope");
});

test("A GRAPH USING THESE FIELDS CORRECTLY STILL COMPILES — the control", () => {
  // Reading a table is not evidence the check accepts what it should. This exercises the exact
  // four node fields whose typos are tested above, all valid, all together.
  const r = full({
    node: { policy: { posture: "in" }, retry: { maxAttempts: 2 }, timeoutMs: 5000, checkpoint: "after" },
    edge: { when: "true" },
  });
  assert.deepEqual(
    r.diagnostics.filter((x) => x.code === "GRAPH020_UNKNOWN_FIELD"),
    [],
    "valid fields were refused",
  );
});

// ── and one level in again: retry, a channel, and metadata ───────────────────

/**
 * A census of the allow-lists found five, covering the node block, the node, the graph, the edge
 * and `policy`. FOUR SCOPES HAD NO LIST AT ALL: `retry`, a `channels.<name>` declaration, that
 * declaration's `contextProjection`, and `metadata`.
 *
 * Measured against `compile` before `NESTED_FIELDS` existed, each on a graph that is otherwise
 * byte-identical to one that compiles clean, each `ok: true` with ZERO diagnostics:
 *
 *     retry: { maxAttemptss: 3 }                     →  plan.retry = {"maxAttemptss":3}
 *     retry: { backoff: "fixed" }                    →  plan.retry = {"backoff":"fixed"}
 *     channels.a: { …, classificaton: "secret_ref" } →  channel `a` unclassified
 *     metadata: { …, nmae: "x" }                     →  nothing
 *
 * THE FIRST TWO ROWS ARE THE WORST MEMBER OF THIS FAMILY YET, and worse than the `policyy` case
 * this file was written for, because it is not a lost declaration but an INVERTED one.
 * `#retryDecision` stops at `attempt >= policy.maxAttempts`; `n >= undefined` is `false` for every
 * `n`, so a bounded retry becomes an unbounded one — and `effectiveRetry` stops substituting
 * `DEFAULT_PROVIDER_RETRY` as soon as any `retry` block exists, so the typo also deletes the sane
 * default it was overriding. That is why `maxAttempts` is REQUIRED here and not merely allowed.
 *
 * The third row is `policyy` exactly one scope over, with the same cost: a channel the author
 * meant to mark `secret_ref` is unclassified, so `dataFloorOf` floors its readers at `out` instead
 * of `in` and no human is asked. The fourth is tidy rather than load-bearing, and is here because
 * the others are not — a family with a member left out is a family nobody can check by naming it.
 *
 * TWO OF THE FOUR INTERFACES ARE IN ANOTHER FILE, so the anti-cry-wolf check reads two sources.
 */
const nested = (r: ReturnType<typeof compile>, code = "GRAPH020_UNKNOWN_FIELD") =>
  r.diagnostics.find((x) => x.code === code);

test("A MISSPELLED `retry` FIELD IS REFUSED — the bound that became its own opposite", () => {
  const r = full({ node: { retry: { maxAttemptss: 3 } } });
  assert.equal(r.ok, false, "a retry block with no bound the engine can read compiled clean");
  assert.match(nested(r)!.message, /maxAttemptss/, "the message must name what the author wrote");
  assert.match(nested(r)!.fix ?? "", /`maxAttempts`/, `expected the near miss, got: ${nested(r)!.fix ?? "(none)"}`);
});

test("AND `maxAttempts` IS REQUIRED, because absent and misspelled fail identically", () => {
  // The unknown-key check alone would pass `retry: {backoff: "fixed"}` — a policy that reads as a
  // retry policy and never stops retrying. `RetryPolicy.maxAttempts` is the one non-optional field
  // on the interface and nothing enforced it.
  const r = full({ node: { retry: { backoff: "fixed" } } });
  assert.equal(r.ok, false);
  const diag = nested(r, "GRAPH020_MISSING_FIELD")!;
  assert.ok(diag !== undefined, r.diagnostics.map((x) => x.code).join(", ") || "(no diagnostics)");
  assert.match(diag.message, /maxAttempts/);
  assert.match(diag.fix ?? "", /never/, "the fix must say what the engine actually does without it");
});

test("...and a non-integer bound is refused too — a string coerces, `null` and `1.5` do not", () => {
  for (const bad of [null, 1.5, "3", 0, -1]) {
    const r = full({ node: { retry: { maxAttempts: bad } } });
    assert.equal(r.ok, false, `maxAttempts: ${JSON.stringify(bad)} compiled`);
    assert.ok(nested(r, "GRAPH020_MISSING_FIELD") !== undefined, `maxAttempts: ${JSON.stringify(bad)}`);
  }
});

test("A MISSPELLED CHANNEL FIELD IS REFUSED — `policyy` one scope over, and the same cost", () => {
  const r = full({
    spec: { channels: { a: { type: "string", reduce: "replace", classificaton: "secret_ref" }, b: { type: "object", reduce: "replace" } } },
  });
  assert.equal(r.ok, false, "a channel that meant to be secret and is not compiled clean");
  assert.match(nested(r)!.message, /classificaton/);
  assert.match(nested(r)!.fix ?? "", /`classification`/);
  assert.equal(nested(r)!.at?.channel, "a", "the diagnostic must point at the channel");
});

test("AND INSIDE ITS `contextProjection`", () => {
  const r = full({
    spec: {
      channels: {
        a: { type: "string", reduce: "replace", contextProjection: { maxTokens: 10, overflow: "truncate_tail", takee: 3 } },
        b: { type: "object", reduce: "replace" },
      },
    },
  });
  assert.equal(r.ok, false);
  assert.match(nested(r)!.message, /takee/);
  assert.match(nested(r)!.fix ?? "", /`take`/);
});

test("AN UNKNOWN `metadata` FIELD IS REFUSED", () => {
  const r = full({ spec: { metadata: { name: "sc", project: "test", version: 1, nmae: "x" } } });
  assert.equal(r.ok, false);
  assert.match(nested(r)!.message, /nmae/);
  assert.match(nested(r)!.fix ?? "", /`name`/);
});

/**
 * `preAuthorization` IS REFUSED AT EVERY AUTHORING SCOPE, and that is the whole of the answer.
 *
 * The envelope — cost ceiling, blast radius, tool scope, data classification, allowed side
 * effects, audit completeness, demotion triggers — has been proposed three times as a block of
 * `GraphSpec`/`NodeSpec`/`GraphPolicy`. `graph/spec.ts`'s docstring above `GraphPolicy` states
 * the refusal and maps each part onto its existing home; this is the mechanical half, so the
 * refusal is a fact about the compiler rather than a sentence in a comment.
 *
 * NAMED SCOPES, not "everywhere": the graph root, a node, `policy`, `policy.budget` and
 * `metadata`. `metadata` was the last silent one and closed most recently — before that, the
 * envelope could be written there with zero diagnostics.
 *
 * The reason it is refused rather than built is in that docstring, and its sharp end is the
 * seventh part: a "demotion trigger" is an automated rule that LOWERS a posture, which
 * `PolicyEngine.escalate` and the audit rule `policy.deescalation-is-human` exist to make
 * impossible. A graph does not write its own grant.
 */
test("THE `preAuthorization` ENVELOPE IS REFUSED WHEREVER IT IS WRITTEN", () => {
  const envelope = { costCeilingUsd: 5, blastRadius: "wide", demotionTriggers: [{ when: "true", to: "out" }] };
  const scopes: readonly (readonly [string, Parameters<typeof full>[0]])[] = [
    ["the graph root", { spec: { preAuthorization: envelope } }],
    ["a node", { node: { preAuthorization: envelope } }],
    ["`policy`", { spec: { policy: { posture: "out", budget: { costUsd: 1 }, capabilities: [], preAuthorization: envelope } } }],
    ["`policy.budget`", { spec: { policy: { posture: "out", budget: { costUsd: 1, preAuthorization: envelope }, capabilities: [] } } }],
    ["`metadata`", { spec: { metadata: { name: "sc", project: "test", version: 1, preAuthorization: envelope } } }],
  ];
  for (const [where, over] of scopes) {
    const r = full(over);
    assert.equal(r.ok, false, `${where}: the envelope compiled clean`);
    const diag = r.diagnostics.find((x) => x.code === "GRAPH020_UNKNOWN_FIELD" && /preAuthorization/.test(x.message));
    assert.ok(diag !== undefined, `${where}: ${r.diagnostics.map((x) => x.code).join(", ") || "(no diagnostics)"}`);
  }
});

test("...and `labels` is the sanctioned home for the annotation it was reaching for", () => {
  // The control. Closing `metadata` must not have removed the ability to attach arbitrary keys —
  // it forces them into the place built for them, which is what makes the refusal cost nothing
  // legitimate.
  const r = full({ spec: { metadata: { name: "sc", project: "test", version: 1, labels: { preAuthorization: "reviewed-by-hand" } } } });
  assert.equal(r.ok, true, r.diagnostics.map((x) => `${x.severity}:${x.code}`).join(", "));
});

/**
 * THE `humanGate` SCOPES, where a dropped key is not a lost setting but an unsupervised action.
 *
 * `unknownKeys` reached six scopes and none of `humanGate`'s. Measured on a structurally valid
 * graph, every one of these compiled with ZERO gate diagnostics:
 *
 *     approval: {approvres: [...]}                          →  nothing
 *     approval: {approvers: "u:alice"}                       →  nothing
 *     approval: {approvers: []}                              →  nothing
 *     approval: 42                                           →  nothing
 *     approval: {..., separationOfDutys: true}               →  nothing
 *     approval: {..., delegation: {allowd: true}}            →  nothing
 *     sla: {respondWithinMs: 60000, onTimout: "escalate"}    →  nothing
 *     delivery: {channels: ["console"], recipiants: []}      →  nothing
 *     approval: null                                         →  E_INTERNAL TypeError, no diagnostic
 *
 * Driven through the engine with a restart between raise and resolve, the first typo journals
 * `approvers: []`, `u:mallory` — named by nobody — approves, and the guarded `fs.write` lands.
 * `"u:alice"` journals as the STRING, so the audit record READS supervised while
 * `String.prototype.includes` lets subject `"u"` and subject `"alice"` each approve and write.
 *
 * This is `policyy: {posture: "in"}` one nesting level deeper with worse consequences, and it is
 * the same fix: the enumeration lives in `NESTED_FIELDS` beside the interfaces, and the drift
 * test below reads those interfaces out of the source rather than restating them.
 */
const gate = (humanGate: Record<string, unknown>) =>
  full({
    node: {
      id: "n",
      type: "human_gate",
      reads: ["a"],
      humanGate: { ref: "oversight/gate@stable", ...humanGate },
      function: undefined,
    },
  });

test("AN UNKNOWN KEY IN ANY `humanGate` SUB-BLOCK IS REFUSED", () => {
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["approval", { approval: { approvres: ["u:alice"] } }],
    ["approval.delegation", { approval: { approvers: ["u:alice"], delegation: { allowd: true } } }],
    ["sla", { approval: { approvers: ["u:alice"] }, sla: { respondWithinMs: 60_000, onTimout: "escalate" } }],
    ["delivery", { approval: { approvers: ["u:alice"] }, delivery: { channels: ["console"], recipiants: [] } }],
    [
      "delivery.escalation[0]",
      {
        approval: { approvers: ["u:alice"] },
        delivery: { channels: ["console"], escalation: [{ afterMs: 1000, too: [{ kind: "user", id: "u:bob" }] }] },
      },
    ],
    ["batching", { approval: { approvers: ["u:alice"] }, batching: { enabled: true, key: "k", windowMs: 5, maxBatch: 2, windowMz: 5 } }],
    ["dedupe", { approval: { approvers: ["u:alice"] }, dedupe: { enabled: true, windowMs: 5, keyy: "x" } }],
  ];
  for (const [where, hg] of cases) {
    const r = gate(hg);
    assert.equal(r.ok, false, `${where}: compiled clean`);
    const diag = unknownField(r);
    assert.ok(diag !== undefined, `${where}: ${r.diagnostics.map((x) => x.code).join(", ") || "(no diagnostics)"}`);
    assert.equal(diag.severity, "error", `${where}: an unknown key on a gate must not be a warning`);
  }
});

test("...and a MALFORMED sub-block is a diagnostic naming the node, not a TypeError", () => {
  // `approval: null` reached `a.mode` and crashed the compiler with a raw stack.
  // `approval: 42` and `approval: []` read as `undefined` at every field, so the whole check
  // returned having checked nothing — the block was typed wrong and the gate compiled clean.
  for (const approval of [null, 42, [], "u:alice"]) {
    const r = gate({ approval });
    assert.equal(r.ok, false, `approval: ${JSON.stringify(approval)} compiled clean`);
    assert.ok(
      r.diagnostics.some((x) => x.code === "GRAPH003_MALFORMED" && /approval/.test(x.message)),
      `approval: ${JSON.stringify(approval)} → ${r.diagnostics.map((x) => x.code).join(", ") || "(none)"}`,
    );
  }

  // TWO MORE THAT THE FIRST DRAFT OF THIS CHANGE REPORTED AND THEN CRASHED ON, which is the
  // defect class in miniature: `objectBlock` pushed the diagnostic and the code below it read
  // through the raw value anyway, so the author got `TypeError: Cannot read properties of null`
  // instead of the message that had just been written for them. A guard that reports a fault and
  // then trips over it has reported nothing.
  const nested: readonly (readonly [string, Record<string, unknown>])[] = [
    ["approval.delegation: null", { approval: { approvers: ["u:alice"], delegation: null } }],
    ["delivery.escalation[0]: null", { approval: { approvers: ["u:alice"] }, delivery: { channels: ["console"], escalation: [null] } }],
  ];
  for (const [where, hg] of nested) {
    const r = gate(hg);
    assert.equal(r.ok, false, `${where}: compiled clean`);
    assert.ok(
      r.diagnostics.some((x) => x.code === "GRAPH003_MALFORMED"),
      `${where}: ${r.diagnostics.map((x) => x.code).join(", ") || "(none)"}`,
    );
  }
});

test("A GATE THAT DECLARES ALL SIX BLOCKS CORRECTLY STILL COMPILES — the control", () => {
  // The anti-cry-wolf half, and it matters more here than anywhere else in this file: refusing a
  // correct gate is refusing the graph, and an author has no way to tell that from a real typo.
  const r = gate({
    approval: { approvers: ["u:alice"], separationOfDuties: true },
    sla: { respondWithinMs: 60_000, onTimeout: "escalate", reminders: [{ afterMs: 30_000 }] },
    delivery: {
      channels: ["console"],
      recipients: [{ kind: "user", id: "u:alice" }],
      redact: ["email"],
      redactAs: "pii",
      escalation: [{ afterMs: 30_000, to: [{ kind: "role", id: "sre" }], channels: ["console"] }],
    },
    batching: { enabled: true, key: "deploys", windowMs: 5_000, maxBatch: 3 },
    dedupe: { enabled: true, windowMs: 5_000 },
  });
  assert.equal(r.ok, true, r.diagnostics.map((x) => `${x.severity}:${x.code} ${x.message}`).join(" | "));
});

test("EVERY FIELD THESE FOUR INTERFACES DECLARE IS ALLOWED — the guard must not refuse valid graphs", () => {
  // The same anti-cry-wolf check as the three above, and the one that matters most here: a field
  // added to `ChannelSpec` and not to this table refuses a channel declaration that is correct,
  // and an author has no way to tell that from a real typo.
  const IFACE: Readonly<Record<keyof typeof NESTED_FIELDS, readonly [string, string]>> = {
    approval: ["ApprovalSpec", SPEC_SRC],
    delegation: ["DelegationSpec", SPEC_SRC],
    sla: ["GateSlaSpec", SPEC_SRC],
    delivery: ["DeliverySpec", DELIVERY_SRC],
    deliveryEscalation: ["EscalationTier", DELIVERY_SRC],
    batching: ["BatchingSpec", SPEC_SRC],
    dedupe: ["DedupeSpec", SPEC_SRC],
    retry: ["RetryPolicy", SPEC_SRC],
    channel: ["ChannelSpec", CHANNELS_SRC],
    contextProjection: ["ContextProjection", CHANNELS_SRC],
    metadata: ["GraphMetadata", SPEC_SRC],
  };
  for (const [key, [iface, src]] of Object.entries(IFACE) as [keyof typeof NESTED_FIELDS, readonly [string, string]][]) {
    assert.deepEqual(
      [...NESTED_FIELDS[key]].sort(),
      membersOf(iface, src),
      `NESTED_FIELDS.${key} and ${iface} disagree — a field was added to one and not the other`,
    );
  }
  assert.deepEqual(Object.keys(NESTED_FIELDS).sort(), Object.keys(IFACE).sort(), "the table lost or gained a scope");
});

test("A GRAPH USING ALL FOUR CORRECTLY STILL COMPILES — the control", () => {
  // Reading a table proves nothing about what the check accepts. Every field of all four scopes,
  // valid, in one graph.
  const r = full({
    node: { retry: { maxAttempts: 2, backoff: "fixed", initialMs: 10, maxMs: 20, jitter: false, onlyIf: ["E_TOOL_TIMEOUT"] } },
    spec: {
      metadata: { name: "sc", project: "test", version: 1, description: "d", labels: { k: "v" } },
      channels: {
        a: {
          type: "string",
          reduce: "replace",
          initial: "",
          classification: "internal",
          contextProjection: { fields: ["x"], take: -2, maxTokens: 100, overflow: "truncate_tail" },
        },
        b: { type: "object", reduce: "merge_object", onConflict: "last_by_branch" },
      },
    },
  });
  assert.deepEqual(
    r.diagnostics.filter((x) => x.severity === "error"),
    [],
    "valid fields were refused",
  );
});
