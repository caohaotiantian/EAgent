/**
 * Who holds the deny-list on the loosening path.
 *
 * `oversight.test.ts` covers the lattice — what a posture composes to. This file covers
 * a narrower and nastier question: when `deescalate` asks "is this actor allowed to
 * lower a posture?", *whose answer is it reading?*
 *
 * It used to read `actor.denied` — a field carried ON the object being authorized. An
 * actor that simply omitted the field was on no deny-list at all, so the one path
 * invariant 5 permits a posture to drop was guarded by a check the caller could answer
 * about itself. These tests pin the authority where it belongs: in the engine, seeded at
 * construction, unreachable from the argument.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { EVOLUTION_ACTOR, PolicyEngine, type PolicyActor } from "../../src/run/policy.ts";
import type { RunId } from "../../src/ids.ts";

const RUN = "01JRUNPOLICY000000000000000" as RunId;
const SCOPE = `run:${RUN}`;
const HUMAN: PolicyActor = { kind: "human", id: "u:alice" };

const forbidden = (e: unknown): boolean => (e as { code?: string }).code === "E_OVERSIGHT_LOOSEN_FORBIDDEN";

const engine = (over: Partial<ConstructorParameters<typeof PolicyEngine>[0]> = {}) =>
  new PolicyEngine({ granted: ["*"], systemFloor: "out", ...over });

// ── the deny-list is the engine's, not the caller's ──────────────────────────

test("A DENY-LISTED IDENTITY CANNOT LOOSEN BY OMITTING ITS OWN DENY-LIST", () => {
  // `EVOLUTION_ACTOR` declares `denied: ["oversight:loosen", …]`, and the old check read
  // that field off the actor it was authorizing. Anything that names itself
  // `evolution-engine` while leaving `denied` unset therefore passed — the guard was
  // answerable by the thing it guards.
  const p = engine();
  assert.throws(
    () => p.deescalate(SCOPE, "out", "trust me", { kind: "human", id: EVOLUTION_ACTOR.id }),
    forbidden,
  );
  assert.equal(p.ceilingFor(SCOPE), undefined, "and no ceiling was set on the way out");
});

test("the tenant's capability deny-list refuses everyone, including a real human", () => {
  // `denied` already beats `granted` for every capability a node or tool declares.
  // Loosening is a capability like any other; it just never passed through `decide`.
  const p = engine({ denied: ["oversight:loosen"] });
  assert.throws(() => p.deescalate(SCOPE, "on", "incident window", HUMAN), forbidden);
});

test("a prefix wildcard in the tenant deny-list covers loosening too", () => {
  const p = engine({ denied: ["oversight:*"] });
  assert.throws(() => p.deescalate(SCOPE, "on", "incident window", HUMAN), forbidden);
});

test("an engine-held deny-list can name any identity, not just the evolution engine", () => {
  const p = engine({ deniedActors: { "u:contractor": ["oversight:loosen"] } });
  assert.throws(() => p.deescalate(SCOPE, "on", "just this once", { kind: "human", id: "u:contractor" }), forbidden);
  p.deescalate(SCOPE, "on", "incident window", HUMAN);
  assert.equal(p.ceilingFor(SCOPE), "on", "…and everyone else is unaffected");
});

test("supplying deniedActors cannot UN-deny the evolution engine", () => {
  // Deny beats allow in every direction: the supplied map is unioned with the built-in
  // entry, never substituted for it. Otherwise closing this hole would open a wider one —
  // an embedder passing `{}` would silently drop the only identity that must never loosen.
  const p = engine({ deniedActors: { [EVOLUTION_ACTOR.id]: [] } });
  assert.throws(() => p.deescalate(SCOPE, "out", "cleared", { kind: "human", id: EVOLUTION_ACTOR.id }), forbidden);
});

test("a self-reported deny-list still counts — it can only ever ADD a denial", () => {
  // The old check is kept as a belt. It was never wrong, only insufficient: an actor that
  // volunteers a denial the engine has not been told about is still denied.
  const p = engine();
  assert.throws(
    () => p.deescalate(SCOPE, "on", "because", { kind: "human", id: "u:bob", denied: ["oversight:loosen"] }),
    forbidden,
  );
});

test("an ordinary human is unaffected by any of it", () => {
  const p = engine();
  p.deescalate(SCOPE, "on", "operator is watching this one", HUMAN);
  assert.equal(p.ceilingFor(SCOPE), "on");
});
