/**
 * The resource layer, and THE PINNING RULE.
 *
 * The last test in the first section is the important one: it proves that publishing
 * and promoting a new version mid-run cannot affect a run already in flight. Every
 * other claim about safe rollback and cache correctness rests on it.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ResourceStore, parseRef } from "../../src/resources/store.ts";
import { EVOLUTION_ACTOR, type PolicyActor } from "../../src/run/policy.ts";
import { compileOrThrow } from "../../src/graph/compile.ts";
import type { GraphSpec } from "../../src/graph/spec.ts";
import { Engine } from "../../src/run/engine.ts";
import { MemoryStateStore } from "../../src/journal/memory.ts";
import { InProcessEventBus } from "../../src/bus.ts";
import { FunctionRegistry, MockModelAdapter, ModelRegistry, ToolRegistry } from "../../src/run/registry.ts";
import { DOCS, SKELETON_TOOLS, SKELETON_TENANT_CAPS, harness, skeletonSpec } from "../run/skeleton.ts";

const HUMAN: PolicyActor = { kind: "human", id: "u:alice" };
const AGENT: PolicyActor = { kind: "agent", id: "planner" };

function store(): ResourceStore {
  let t = 1_700_000_000_000;
  return new ResourceStore({ now: () => (t += 1000) });
}

// ── publish ──────────────────────────────────────────────────────────────────

test("identical content under DIFFERENT names does not collide", () => {
  // Pure content-addressing would give these one digest, and the second publish
  // would silently inherit the first's version and channel.
  const s = store();
  const a = s.publish({ kind: "function", name: "alpha", content: {}, actor: HUMAN });
  const b = s.publish({ kind: "function", name: "beta", content: {}, actor: HUMAN });
  assert.notEqual(a.digest, b.digest);
  assert.equal(s.versions("function", "alpha").length, 1);
  assert.equal(s.versions("function", "beta").length, 1);
});

test("publishing identical content twice yields the same digest and no new version", () => {
  const s = store();
  const a = s.publish({ kind: "prompt", name: "p", content: { text: "hello" }, actor: HUMAN });
  const b = s.publish({ kind: "prompt", name: "p", content: { text: "hello" }, actor: HUMAN });
  assert.equal(a.digest, b.digest);
  assert.equal(s.versions("prompt", "p").length, 1, "content-addressed: republishing is idempotent without a key");
});

test("key order does not create a new version", () => {
  const s = store();
  const a = s.publish({ kind: "prompt", name: "p", content: { a: 1, b: 2 }, actor: HUMAN });
  const b = s.publish({ kind: "prompt", name: "p", content: { b: 2, a: 1 }, actor: HUMAN });
  assert.equal(a.digest, b.digest);
});

test("different content mints a new version", () => {
  const s = store();
  s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  const v2 = s.publish({ kind: "prompt", name: "p", content: { text: "v2" }, actor: HUMAN });
  assert.equal(v2.ref, "prompt/p@2");
  assert.equal(s.versions("prompt", "p").length, 2);
});

test("an idempotency key reused with different content is a conflict", () => {
  const s = store();
  s.publish({ kind: "prompt", name: "p", content: { text: "a" }, actor: HUMAN, idempotencyKey: "k" });
  assert.throws(
    () => s.publish({ kind: "prompt", name: "p", content: { text: "b" }, actor: HUMAN, idempotencyKey: "k" }),
    (e: unknown) => (e as { code: string }).code === "E_IDEMPOTENCY_MISMATCH",
  );
});

// ── promotion ────────────────────────────────────────────────────────────────

test("promotion moves a SELECTOR and never mutates content", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", AGENT);
  s.promote(v1, "stable", HUMAN);

  assert.equal(s.resolve("prompt/p@stable")?.digest, v1.digest);
  assert.deepEqual(s.fetch(v1.digest).content, { text: "v1" }, "content is untouched by promotion");
});

test("promoting to stable requires a HUMAN actor", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: AGENT });
  s.promote(v1, "canary", AGENT);
  assert.throws(
    () => s.promote(v1, "stable", AGENT),
    (e: unknown) => (e as { code: string }).code === "E_HUMAN_APPROVAL_REQUIRED",
  );
});

test("the evolution engine is DENY-LISTED for stable promotion, not merely un-granted", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: EVOLUTION_ACTOR });
  s.promote(v1, "canary", EVOLUTION_ACTOR);
  // Even a hypothetical "human-kind" evolution identity is refused by the deny-list.
  const disguised: PolicyActor = { ...EVOLUTION_ACTOR, kind: "human" };
  assert.throws(
    () => s.promote(v1, "stable", disguised),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
  );
});

test("illegal transitions are refused", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  // draft cannot jump straight to stable
  assert.throws(
    () => s.promote(v1, "stable", HUMAN),
    (e: unknown) => (e as { code: string }).code === "E_ILLEGAL_TRANSITION",
  );
});

test("rollback is a pointer move — instantaneous and content-free", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);
  const v2 = s.publish({ kind: "prompt", name: "p", content: { text: "v2" }, actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);
  assert.equal(s.resolve("prompt/p@stable")?.digest, v2.digest);

  s.rollback("prompt", "p", 1, HUMAN);
  assert.equal(s.resolve("prompt/p@stable")?.digest, v1.digest);
  assert.deepEqual(s.fetch(v2.digest).content, { text: "v2" }, "the rolled-back version still exists");
});

test("ROLLBACK MOVES @stable, so the evolution engine may not do it either", () => {
  // Rollback writes the same selector `promote` guards with a human check and a
  // deny-list. Without the same guard it is the way round them.
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);
  const v2 = s.publish({ kind: "prompt", name: "p", content: { text: "v2" }, actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);

  assert.throws(
    () => s.rollback("prompt", "p", 1, EVOLUTION_ACTOR),
    (e: unknown) => (e as { code: string }).code === "E_HUMAN_APPROVAL_REQUIRED",
  );
  const disguised: PolicyActor = { ...EVOLUTION_ACTOR, kind: "human" };
  assert.throws(
    () => s.rollback("prompt", "p", 1, disguised),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
  );
  assert.equal(s.resolve("prompt/p@stable")?.digest, v2.digest, "the selector did not move");
});

test("THE DENY-LIST IS THE STORE'S, NOT THE CALLER'S — an omitted `denied` is not an empty one", () => {
  // `PolicyActor.denied` rides on the object being authorized, so reading it alone asks the
  // subject whether the subject is allowed. The two tests above only ever spread
  // `EVOLUTION_ACTOR`, which CARRIES the list — so they proved the guard works for a caller
  // that volunteers its own denial. Nothing made a caller volunteer it: a hand-built literal
  // naming the same identity and simply leaving the field off was on no deny-list at all,
  // and both doors onto `@stable` opened.
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);
  const v2 = s.publish({ kind: "prompt", name: "p", content: { text: "v2" }, actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);

  const forged: PolicyActor = { kind: "human", id: EVOLUTION_ACTOR.id };
  assert.equal(forged.denied, undefined, "the whole point: the actor asserts nothing about itself");

  assert.throws(
    () => s.rollback("prompt", "p", 1, forged),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
    "rollback writes @stable",
  );
  assert.equal(s.resolve("prompt/p@stable")?.digest, v2.digest, "the selector did not move");

  const v3 = s.publish({ kind: "prompt", name: "p", content: { text: "v3" }, actor: HUMAN });
  s.promote(v3, "canary", HUMAN);
  assert.throws(
    () => s.promote(v3, "stable", forged),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
    "and so does promotion — the two doors must agree",
  );
  assert.equal(s.resolve("prompt/p@stable")?.digest, v2.digest, "still did not move");
});

test("a deny-list the embedder supplies is UNIONED with the built-in one, never substituted", () => {
  // Supplying the map is how a deployment denies an identity of its own; it must not be a
  // way to un-deny the one the codebase already declares. `{"evolution-engine": []}` is the
  // shortest spelling of that attempt.
  const s = new ResourceStore({
    now: () => 1_700_000_000_000,
    deniedActors: { "evolution-engine": [], "u:contractor": ["resource:promote(stable)"] },
  });
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);

  assert.throws(
    () => s.promote(v1, "stable", { kind: "human", id: EVOLUTION_ACTOR.id }),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
    "an empty supplied list does not un-deny the built-in identity",
  );
  assert.throws(
    () => s.promote(v1, "stable", { kind: "human", id: "u:contractor" }),
    (e: unknown) => (e as { code: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN",
    "and a supplied identity is denied on the store's word alone",
  );
  s.promote(v1, "stable", HUMAN);
  assert.equal(s.resolve("prompt/p@stable")?.digest, v1.digest, "an actor on no list still promotes");
});

test("listing is ordered by code unit, not by the machine's collation", () => {
  // `localeCompare` is locale- and ICU-dependent: two machines would page a resource
  // list in different orders, and a cursor over that list would skip or repeat rows.
  const s = store();
  s.publish({ kind: "prompt", name: "Zebra", content: { text: "z" }, actor: HUMAN });
  s.publish({ kind: "prompt", name: "apple", content: { text: "a" }, actor: HUMAN });
  assert.deepEqual(
    s.list({ kind: "prompt" }).map((v) => v.name),
    ["Zebra", "apple"],
  );
});

// ── resolution and the runtime split ─────────────────────────────────────────

test("resolve accepts versions, digests, and floating channels", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);

  assert.equal(s.resolve("prompt/p@1")?.digest, v1.digest);
  assert.equal(s.resolve(`prompt/p@${v1.digest}`)?.digest, v1.digest);
  assert.equal(s.resolve("prompt/p@stable")?.digest, v1.digest);
  assert.equal(s.resolve("prompt/p@nope"), undefined);
  assert.equal(s.resolve("not-a-ref"), undefined);
});

test("FETCH REFUSES A FLOATING REF — that would unfreeze a run's view of the world", () => {
  const s = store();
  s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  assert.throws(
    () => s.fetch("prompt/p@stable" as never),
    (e: unknown) => (e as { code: string }).code === "E_FLOATING_REF_AT_RUNTIME",
  );
});

test("a yanked version stops resolving for NEW compiles but is still fetchable by digest", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);
  s.yank("prompt", "p", 1, "INC-42: leaked a credential", HUMAN);

  assert.equal(s.resolve("prompt/p@stable"), undefined, "new compiles break, deliberately");
  // In-flight runs hold digests, and breaking them mid-flight could strand
  // irreversible work — D8.5 escalates those runs instead.
  assert.deepEqual(s.fetch(v1.digest).content, { text: "v1" });
});

test("yanking requires a human and an incident reference", () => {
  const s = store();
  s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  assert.throws(() => s.yank("prompt", "p", 1, "because", AGENT), /human actor/);
  assert.throws(() => s.yank("prompt", "p", 1, "  ", HUMAN), /incident reference/);
});

test("parseRef handles kind/name@selector, including digests", () => {
  assert.deepEqual(parseRef("prompt/my-thing@stable"), { kind: "prompt", name: "my-thing", selector: "stable" });
  assert.deepEqual(parseRef("graph/a@sha256:abc"), { kind: "graph", name: "a", selector: "sha256:abc" });
  assert.equal(parseRef("nope"), undefined);
});

// ── THE PINNING RULE ─────────────────────────────────────────────────────────

test("THE PINNING RULE — publishing and promoting mid-run cannot affect an in-flight run", async () => {
  const s = store();
  const prompt = s.publish({ kind: "prompt", name: "summarize-file", content: { text: "ORIGINAL" }, actor: HUMAN });
  s.promote(prompt, "canary", HUMAN);
  s.promote(prompt, "stable", HUMAN);
  const profile = s.publish({ kind: "agent_profile", name: "summarizer", content: { model: "mock" }, actor: HUMAN });
  s.promote(profile, "canary", HUMAN);
  s.promote(profile, "stable", HUMAN);
  const fn1 = s.publish({ kind: "function", name: "passthrough", content: {}, actor: HUMAN });
  s.promote(fn1, "canary", HUMAN);
  s.promote(fn1, "stable", HUMAN);
  const fn2 = s.publish({ kind: "function", name: "merge-digests", content: {}, actor: HUMAN });
  s.promote(fn2, "canary", HUMAN);
  s.promote(fn2, "stable", HUMAN);
  const gate = s.publish({ kind: "oversight", name: "demo-write", content: { posture: "in" }, actor: HUMAN });
  s.promote(gate, "canary", HUMAN);
  s.promote(gate, "stable", HUMAN);

  // Compile against @stable. The manifest freezes the run's view right here.
  const graph = compileOrThrow({
    spec: skeletonSpec(),
    resolver: s,
    tools: SKELETON_TOOLS,
    tenantCapabilities: SKELETON_TENANT_CAPS,
  });
  const pinned = graph.resolutionManifest.find((r) => r.ref === "prompt/summarize-file@stable")!;
  assert.equal(pinned.digest, prompt.digest);

  const h = harness();
  const runId = await h.engine.submit({ graph, inputs: { paths: DOCS } });
  await h.engine.advance(runId); // suspends at the gate, mid-run

  // …and now the world moves on underneath it.
  const v2 = s.publish({ kind: "prompt", name: "summarize-file", content: { text: "REWRITTEN" }, actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);
  assert.notEqual(v2.digest, prompt.digest);
  assert.equal(s.resolve("prompt/summarize-file@stable")?.digest, v2.digest, "the selector moved");

  // The in-flight run still names the ORIGINAL digest.
  assert.equal(
    graph.resolutionManifest.find((r) => r.ref === "prompt/summarize-file@stable")?.digest,
    prompt.digest,
    "a Run reads only what its manifest names",
  );
  assert.deepEqual(s.fetch(pinned.digest).content, { text: "ORIGINAL" });

  // And it finishes on the pinned version.
  const open = Object.values((await h.engine.projection(runId))!.gates).find((g) => g.state === "open")!;
  const done = await h.engine.resolveGate(runId, {
    gateId: open.gateId,
    decision: { kind: "approve" },
    actor: { kind: "human", subject: "u:alice", via: "console" },
    idempotencyKey: "k",
  });
  assert.equal(done.status, "succeeded");

  // A NEW compile picks up the new version — that is the whole point of a selector.
  const next = compileOrThrow({ spec: skeletonSpec(), resolver: s, tools: SKELETON_TOOLS, tenantCapabilities: SKELETON_TENANT_CAPS });
  assert.equal(next.resolutionManifest.find((r) => r.ref === "prompt/summarize-file@stable")?.digest, v2.digest);
});

/**
 * THE SAME RULE ONE LEVEL DOWN, which is where it did not hold — D7 / G.5.
 *
 * The test above pins a ref the ROOT spec names. `resolveManifest` used to walk only that spec
 * while `resolveSubgraphs` walked children recursively, so the two disagreed about what the Run
 * could reach: a parent naming `subgraph/child@stable` pinned that ref and nothing inside it.
 *
 * That is not a gap that waits for a restart. `Engine.#compileChild` runs during `advance`,
 * while the parent's Task is executing, and `frozenFirst` falls through to the LIVE resolver for
 * any ref the freeze does not hold — so a promotion landing between `submit` and `advance`
 * reached a running node. Measured before the fix: the model was sent v2 and the run reported
 * `succeeded`. Nothing refused, and nothing could have: `run.compiled.resolutionManifest` named
 * only the subgraph ref, so `#assertBound` had no moved digest to find.
 *
 * The assertion that matters is the LAST one — what the model was actually sent. The manifest
 * check above it is the mechanism; the prompt is the consequence, and only the consequence says
 * the run did what it was compiled to do.
 */
test("THE PINNING RULE REACHES INTO A SUBGRAPH — a child's prompt is frozen with the parent's", async () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "inner", content: "INNER v1", actor: HUMAN });
  s.promote(v1, "canary", HUMAN);
  s.promote(v1, "stable", HUMAN);

  const childSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "child", project: "pinning", version: 1 },
    channels: { t: { type: "string", reduce: "replace" }, d: { type: "string", reduce: "replace" } },
    inputs: ["t"],
    outputs: ["d"],
    nodes: [
      {
        id: "inner",
        type: "agent",
        reads: ["t"],
        writes: ["d"],
        agent: { profile: "agent_profile/default@stable", prompt: "prompt/inner@stable" },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;
  const sub = s.publish({ kind: "subgraph", name: "child", content: childSpec, actor: HUMAN });
  s.promote(sub, "canary", HUMAN);
  s.promote(sub, "stable", HUMAN);

  const parentSpec = {
    apiVersion: "loom.dev/v1",
    kind: "GraphSpec",
    metadata: { name: "parent", project: "pinning", version: 1 },
    channels: { t: { type: "string", reduce: "replace" }, d: { type: "string", reduce: "replace" } },
    inputs: ["t"],
    outputs: ["d"],
    nodes: [
      {
        id: "call",
        type: "subgraph",
        reads: ["t"],
        writes: ["d"],
        subgraph: { ref: "subgraph/child@stable", inputs: { t: "t" }, outputs: { d: "d" } },
      },
    ],
    edges: [],
  } as unknown as GraphSpec;

  const graph = compileOrThrow({ spec: parentSpec, resolver: s, tools: {}, tenantCapabilities: [] });
  // THE MECHANISM: the parent's own manifest names the child's ref, so `frozenFirst` can serve
  // it and `#compileChild` never reaches the live store for it.
  assert.equal(
    graph.resolutionManifest.find((r) => r.ref === "prompt/inner@stable")?.digest,
    v1.digest,
    "a child's prompt belongs to the parent's manifest — it is a ref the Run reads",
  );
  assert.equal(graph.documents["prompt/inner@stable"], "INNER v1", "and its bytes travel with the pin");

  const sent: string[] = [];
  const models = new ModelRegistry();
  models.register(
    new MockModelAdapter({
      script: (req) => {
        sent.push(req.system ?? "");
        return { text: JSON.stringify({ d: "done" }), finishReason: "stop" };
      },
      pricePerMTok: 0,
    }),
    true,
  );
  const now = (): number => 1_700_000_000_000;
  const journal = new MemoryStateStore({ now });
  const engine = new Engine({
    store: journal,
    bus: new InProcessEventBus({ store: journal }),
    tools: new ToolRegistry(),
    functions: new FunctionRegistry(),
    models,
    now,
    resolver: s,
    policy: { granted: [], systemFloor: "out", budget: { runUsd: 100 } },
  });

  const runId = await engine.submit({ graph, inputs: { t: "hello" } });

  // The world moves on AFTER the run is journalled and BEFORE the child is compiled.
  const v2 = s.publish({ kind: "prompt", name: "inner", content: "INNER v2 — EDITED", actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);
  assert.equal(s.resolve("prompt/inner@stable")?.digest, v2.digest, "the selector moved");

  const p = await engine.advance(runId); // `#compileChild` runs HERE
  assert.equal(p.status, "succeeded", JSON.stringify(p.error ?? {}));

  // THE CONSEQUENCE. Before the fix this read "INNER v2 — EDITED".
  assert.equal(sent.length, 1);
  assert.ok(
    sent[0]!.startsWith("INNER v1"),
    `the child ran on the promoted prompt: ${JSON.stringify(sent[0])}`,
  );
});

test("cache invalidation is a non-problem: digests are immutable, so entries are never stale", () => {
  const s = store();
  const v1 = s.publish({ kind: "prompt", name: "p", content: { text: "v1" }, actor: HUMAN });
  const cached = s.fetch(v1.digest);

  const v2 = s.publish({ kind: "prompt", name: "p", content: { text: "v2" }, actor: HUMAN });
  s.promote(v2, "canary", HUMAN);
  s.promote(v2, "stable", HUMAN);

  // The cached entry is still correct — it was never a cache of "@stable", it was a
  // cache of a digest, and that digest still means exactly what it meant.
  assert.deepEqual(s.fetch(v1.digest).content, cached.content);
  assert.notEqual(v1.digest, v2.digest);
});
