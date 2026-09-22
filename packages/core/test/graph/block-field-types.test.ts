/**
 * A NAME ALLOW-LIST IS HALF A SCHEMA, one scope in from the edge — §A.81(a).
 *
 * `EDGE_FIELDS` grew a type per field at §A.62 and `edgeFieldTypes` enforces it. `POLICY_FIELDS`
 * and `NESTED_FIELDS` were still NAME-only: they said `capabilities` was an allowed key of
 * `policy` and nothing about what it holds. Measured against `compile` before this, one graph per
 * value, with every key spelled RIGHT:
 *
 *     policy: {capabilities: "k8s:write"}   THREW TypeError: allow.some is not a function
 *     policy: {capabilities: null}          THREW Cannot read properties of null (reading 'some')
 *     policy: {capabilities: 42 / {} / true} THREW (caps ?? []) is not iterable
 *     policy.budget.costUsd/tokens/wallMs   ok, ZERO diagnostics, for all six wrong types
 *     retry.backoff/initialMs/maxMs/jitter  the same
 *     channel.type/identityKey/onConflict   the same
 *     contextProjection.fields              the same
 *     metadata.project/description/labels   the same
 *     delivery.recipients, escalation.to/action  the same
 *
 * THE FIRST GROUP IS THE ONE THAT MATTERS: `rule017Capabilities` reads `policy.capabilities` to
 * decide whether a tenant holds what a graph asks for, and the singular an author writes by hand
 * crashed the compiler rather than refusing. The rest are the quiet half — a budget nobody can
 * enforce, a retry nobody applies — which is the shape this repository has now named five times.
 *
 * WHAT IS *NOT* CHECKED HERE, and why that list is the interesting half: every field a RULE
 * already refuses by name is on `validate.ts`'s `CHECKED_BY_A_RULE`, measured one graph per value,
 * because a second spelling of one refusal is how two diagnostics come to disagree. The last test
 * drives that set rather than trusting it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { compile } from "../../src/graph/compile.ts";
import { NESTED_FIELDS, POLICY_FIELDS, type GraphSpec } from "../../src/graph/spec.ts";
import { TOOLS, stubResolver } from "./fixtures.ts";

type Obj = Record<string, unknown>;

/** One graph that exercises every scope both tables name, and compiles clean. */
const base = (): Obj => ({
  apiVersion: "loom.dev/v1",
  kind: "GraphSpec",
  metadata: { name: "p", project: "t", version: 1 },
  policy: {
    posture: "out",
    capabilities: ["k8s:write"],
    expansion: { maxNodes: 16, maxDepth: 3, maxFanout: 2, maxLoopIterations: 1 },
  },
  channels: { inp: { type: "string", reduce: "replace" }, out: { type: "object", reduce: "replace" } },
  inputs: ["inp"],
  outputs: ["out"],
  nodes: [
    {
      id: "gate",
      type: "human_gate",
      reads: ["inp"],
      writes: [],
      humanGate: {
        ref: "oversight/x@stable",
        approval: { approvers: ["u:a"] },
        sla: { respondWithinMs: 1000, reminders: [{ afterMs: 500 }] },
        delivery: { channels: ["console"], escalation: [{ afterMs: 100 }] },
        batching: { enabled: true, key: "k", windowMs: 10, maxBatch: 2 },
        dedupe: { enabled: true, windowMs: 10 },
      },
      unhandled: true,
    },
    {
      id: "act",
      type: "tool",
      reads: ["inp"],
      writes: ["out"],
      tool: { name: "k8s.apply", version: "3.0", args: {} },
      retry: { maxAttempts: 2 },
      policy: { posture: "out" },
      unhandled: true,
    },
  ],
  edges: [{ id: "e1", from: "gate", to: "act", kind: "seq" }],
});

/** Every scope, and where it lives on that graph. The table IS the claim about coverage. */
const SCOPES: Readonly<Record<string, (s: Obj) => Obj>> = {
  graphPolicy: (s) => s["policy"] as Obj,
  nodePolicy: (s) => ((s["nodes"] as Obj[])[1]!)["policy"] as Obj,
  budget: (s) => (((s["policy"] as Obj)["budget"] ??= {}) as Obj),
  expansion: (s) => (s["policy"] as Obj)["expansion"] as Obj,
  retry: (s) => ((s["nodes"] as Obj[])[1]!)["retry"] as Obj,
  channel: (s) => (s["channels"] as Obj)["inp"] as Obj,
  contextProjection: (s) => {
    const c = (s["channels"] as Obj)["inp"] as Obj;
    c["contextProjection"] ??= { maxTokens: 10, overflow: "error" };
    return c["contextProjection"] as Obj;
  },
  metadata: (s) => s["metadata"] as Obj,
  approval: (s) => (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["approval"] as Obj,
  sla: (s) => (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["sla"] as Obj,
  slaReminder: (s) => {
    const sla = (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["sla"] as Obj;
    return (sla["reminders"] as Obj[])[0]!;
  },
  delivery: (s) => (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["delivery"] as Obj,
  deliveryEscalation: (s) =>
    (((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["delivery"] as Obj)["escalation"] as Obj[])[0]!,
  batching: (s) => (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["batching"] as Obj,
  dedupe: (s) => (((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["dedupe"] as Obj,
};

const TABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = { ...POLICY_FIELDS, ...NESTED_FIELDS };

/** `compile`, never `compileOrThrow`: half of what is under test is that a THROW became a refusal. */
function diagnose(s: Obj): { codes: readonly string[]; threw: string | undefined; messages: readonly string[] } {
  try {
    const r = compile({
      spec: s as unknown as GraphSpec,
      resolver: stubResolver(),
      tools: TOOLS,
      tenantCapabilities: ["k8s:write"],
    });
    const errs = r.diagnostics.filter((x) => x.severity === "error");
    return { codes: errs.map((x) => x.code), threw: undefined, messages: errs.map((x) => x.message) };
  } catch (e) {
    return { codes: [], threw: `${(e as Error).name}: ${(e as Error).message}`, messages: [] };
  }
}

/** The six values a JSON file can hold, so "wrong type" is a set and not an example. */
const VALUES: readonly (readonly [string, unknown])[] = [
  ["a string", "banana"],
  ["a number", 42],
  ["null", null],
  ["an array", ["x"]],
  ["an object", { a: 1 }],
  ["true", true],
];

/** Which of the six a field of each tag legitimately accepts. */
const ACCEPTS: Readonly<Record<string, readonly string[]>> = {
  string: ["a string"],
  count: ["a number"],
  number: ["a number"],
  boolean: ["true"],
  stringArray: ["an array"],
  array: ["an array"],
  object: ["an object"],
  unknown: VALUES.map(([label]) => label),
};

test("THE BASE GRAPH COMPILES — so every case below differs by exactly one field", () => {
  const r = diagnose(base());
  assert.equal(r.threw, undefined, r.threw);
  assert.deepEqual(r.codes, [], r.messages.join("\n"));
});

test("EVERY SCOPE BOTH TABLES NAME IS EXERCISED — a scope added and not driven is the gap", () => {
  // The tables are the census; this asserts the fixture reaches all of it, so a twelfth nested
  // scope cannot be added and silently left untested.
  assert.deepEqual(Object.keys(SCOPES).sort(), Object.keys(TABLE).sort());
  for (const [scope, at] of Object.entries(SCOPES)) {
    const block = at(base());
    assert.ok(block !== undefined && typeof block === "object", `${scope} is not reachable on the fixture`);
  }
});

test("NO WRONG-TYPED VALUE IN ANY SCOPE CRASHES THE COMPILER — five did, all on `capabilities`", () => {
  // The census, over every field of every scope and all six values: 300-odd compiles, and the
  // assertion is that NONE of them is an exception. `policy.capabilities` was the whole of the
  // crashing set and it is the one a rule reads to decide a capability ceiling.
  let drove = 0;
  for (const [scope, at] of Object.entries(SCOPES)) {
    for (const field of Object.keys(TABLE[scope]!)) {
      for (const [label, v] of VALUES) {
        const s = base();
        at(s)[field] = v;
        const r = diagnose(s);
        drove += 1;
        assert.equal(r.threw, undefined, `${scope}.${field} = ${label} CRASHED the compiler: ${String(r.threw)}`);
      }
    }
  }
  assert.ok(drove > 200, `only ${String(drove)} cases driven — the tables shrank, re-read this file`);
});

/**
 * THE ONE PAIR THAT STILL COMPILES CLEAN, named rather than counted.
 *
 * `contextProjection.take` is on `CHECKED_BY_A_RULE` — `checkProjectionValues` refuses `"banana"`,
 * `["x"]`, `{a:1}` and `true` with `GRAPH003_MALFORMED` — and that rule reads `null` as ABSENT, so
 * `take: null` is silently dropped rather than refused. Taking `take` off the opt-out list would
 * close this one value and give the other four TWO diagnostics for one mistake, which is the trade
 * `CHECKED_BY_A_RULE` exists to refuse. Closing it properly is one line in that rule, and it is a
 * different change from typing a table. Listed here so it is a measured fact and not a hope: if
 * the rule ever learns about `null`, this row comes off and the loop below goes green without it.
 */
const STILL_ACCEPTED: ReadonlySet<string> = new Set(["contextProjection.take:null"]);

test("EVERY WRONG-TYPED VALUE IS REFUSED — by this pass or by the rule that owns the field", () => {
  // The other half, and it is the one that makes the tag column load-bearing rather than
  // decorative: a field whose tag says `count` and which accepts `"banana"` is a tag nobody reads.
  // WHICH refusal is deliberately not asserted here — `CHECKED_BY_A_RULE`'s own test below owns
  // that — because this one is about the hole being closed, not about who closed it.
  for (const [scope, at] of Object.entries(SCOPES)) {
    for (const [field, tag] of Object.entries(TABLE[scope]!)) {
      if (tag === "unknown") continue; // `channel.initial` and `metadata.version`: see the table
      for (const [label, v] of VALUES) {
        if (ACCEPTS[tag]!.includes(label)) continue;
        const s = base();
        at(s)[field] = v;
        const r = diagnose(s);
        if (STILL_ACCEPTED.has(`${scope}.${field}:${label === "null" ? "null" : label}`)) {
          assert.equal(
            r.codes.length,
            0,
            `${scope}.${field} = ${label} is refused now — take it off STILL_ACCEPTED and off the docstring`,
          );
          continue;
        }
        assert.ok(
          r.codes.length > 0,
          `${scope}.${field} (${tag}) = ${label} compiled with ZERO diagnostics — the tag is not enforced`,
        );
      }
    }
  }
});

test("…AND A RIGHT VALUE OF EACH IS ACCEPTED, so the check is not refusing on principle", () => {
  // The cry-wolf control, and every table in `spec.ts` names it as the failure mode of an
  // allow-list. Only the fields this pass OWNS: a field on `CHECKED_BY_A_RULE` has a rule with its
  // own vocabulary (`posture`, `reduce`, `classification`, `onTimeout`), and "a string" is not a
  // valid value of any of those.
  const RIGHT: Readonly<Record<string, unknown>> = {
    string: "banana",
    count: 3,
    number: 1.5,
    boolean: true,
    stringArray: ["x"],
    array: [],
    object: {},
    unknown: 1,
  };
  for (const [scope, at] of Object.entries(SCOPES)) {
    for (const [field, tag] of Object.entries(TABLE[scope]!)) {
      const s = base();
      at(s)[field] = RIGHT[tag];
      const r = diagnose(s);
      const mine = r.messages.filter((m) => m.includes(`declares \`${field}\` as`));
      assert.deepEqual(mine, [], `${scope}.${field} (${tag}) refused a well-typed value`);
    }
  }
});

test("`policy.capabilities` IS FATAL — a diagnostic the next rule would have crashed past is not enough", () => {
  // The finding, and the reason its refusal GATES where a malformed `budget` does not.
  // `checkPolicyBlocks`' own header states the criterion for `posture`: a later rule REASONS from
  // the field, so leaving it in play makes the next diagnostic wrong. Here `rule017Capabilities`
  // does not merely reason wrongly, it throws — which is what the first cut of this fix still did,
  // because the diagnostic was non-fatal and the rule ran anyway.
  for (const bad of ["k8s:write", 42, null, { a: 1 }, true] as unknown[]) {
    const s = base();
    (s["policy"] as Obj)["capabilities"] = bad;
    const r = diagnose(s);
    assert.equal(r.threw, undefined, `capabilities = ${JSON.stringify(bad)} still crashes: ${String(r.threw)}`);
    assert.deepEqual(
      r.codes,
      ["GRAPH003_MALFORMED"],
      `expected exactly one refusal and nothing downstream; got ${r.messages.join(" | ")}`,
    );
    assert.ok(r.messages[0]?.includes("`capabilities`"), r.messages.join(" | "));
  }
});

test("A FIELD A RULE ALREADY OWNS IS REFUSED ONCE, NOT TWICE — `CHECKED_BY_A_RULE`, driven", () => {
  // The opt-out set is a hand-written list and the reason it is allowed to exist is that a refusal
  // already covers each member. A set whose members are NOT covered is a list of holes somebody
  // believed were closed — and one whose members ARE covered twice is two diagnostics for one
  // mistake. Both directions, on the sharpest members of each family.
  const cases: readonly (readonly [string, (s: Obj) => void, string])[] = [
    ["graphPolicy.posture", (s) => { (s["policy"] as Obj)["posture"] = 42; }, "GRAPH003_UNKNOWN_POSTURE"],
    ["graphPolicy.onBudgetExhausted", (s) => { (s["policy"] as Obj)["onBudgetExhausted"] = 42; }, "GRAPH003_BUDGET_ACTION_UNSUPPORTED"],
    ["expansion.maxNodes", (s) => { ((s["policy"] as Obj)["expansion"] as Obj)["maxNodes"] = "banana"; }, "GRAPH003_MALFORMED"],
    ["retry.maxAttempts", (s) => { (((s["nodes"] as Obj[])[1]!)["retry"] as Obj)["maxAttempts"] = "two"; }, "GRAPH020_MISSING_FIELD"],
    ["channel.reduce", (s) => { ((s["channels"] as Obj)["inp"] as Obj)["reduce"] = 42; }, "GRAPH003_UNKNOWN_REDUCER"],
    ["channel.classification", (s) => { ((s["channels"] as Obj)["inp"] as Obj)["classification"] = 42; }, "GRAPH003_UNKNOWN_CLASSIFICATION"],
    ["approval.approvers", (s) => { ((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["approval"] as Obj)["approvers"] = "u:a"; }, "GRAPH014_APPROVER_INVALID"],
    ["sla.respondWithinMs", (s) => { ((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["sla"] as Obj)["respondWithinMs"] = "soon"; }, "GRAPH014_SLA_INVALID"],
    ["delivery.channels", (s) => { ((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["delivery"] as Obj)["channels"] = "console"; }, "GRAPH014_DELIVERY_INVALID"],
    ["batching.windowMs", (s) => { ((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["batching"] as Obj)["windowMs"] = "soon"; }, "GRAPH014_BATCHING_INVALID"],
    ["dedupe.windowMs", (s) => { ((((s["nodes"] as Obj[])[0]!)["humanGate"] as Obj)["dedupe"] as Obj)["windowMs"] = "soon"; }, "GRAPH014_DEDUPE_INVALID"],
  ];
  for (const [label, mutate, code] of cases) {
    const s = base();
    mutate(s);
    const r = diagnose(s);
    assert.ok(r.codes.includes(code), `${label}: expected ${code}, got ${r.codes.join(", ") || "nothing"}`);
    // AND NOT A SECOND SPELLING FROM THIS PASS. `blockFieldTypes`' message is the one shape that
    // identifies it, so a duplicate is visible without keying on a code two producers share.
    const mine = r.messages.filter((m) => /declares `[a-zA-Z]+` as .*, which is not /.test(m));
    assert.deepEqual(mine, [], `${label}: the generic pass ALSO refused it — two diagnostics for one mistake`);
  }
});
