/**
 * A tool manifest was accepted at the door, and two guards downstream read the word it
 * carried as PERMISSION.
 *
 * `ToolRegistry.register` took whatever object it was handed and pushed it on the stack.
 * `ToolManifestLite.irreversibility` is typed `IrreversibilityClass`, so the direct path is
 * closed by tsc — but the type is the ONLY thing closing it, and a type is not present at
 * run time. An embedder building a manifest from JSON, a `as` cast, a plugin loaded through
 * an untyped seam: each reaches `register` with a word in no vocabulary. Measured on the
 * unmodified tree, one registration each:
 *
 *     irreversibility: "nuclear"          register threw: NO — accepted
 *     irreversibility: "reversible-write" register threw: NO — accepted   (hyphen typo)
 *     name: 42                            register threw: NO — accepted
 *     idempotent: "sure"                  register threw: NO — accepted
 *
 * WHY THE DOOR AND NOT THE READ. The reads are already split across six sites and only one
 * of them fails closed (`run/policy.ts`'s `isHardToUndo`); the other five spell the pair out
 * longhand in the POSITIVE, so an unreadable class answers `false` and skips the guard —
 * `run/engine.ts:1078` therefore allows a rewind over a call it cannot classify. Those five
 * belong to other files and are fixed in their own layer. Registration is the one moment the
 * bad word is attributable to a person, so the message names the TOOL.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not tighten `journal/events.ts`'s
 * `irreversibility: string` to the union. A bad event is already written; a fold that throws
 * on it makes the whole run unfoldable, which is what `postureRank`'s docstring refuses. A
 * fold must tighten, never throw.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CODES, isLoomError } from "../../src/errors.ts";
import { ToolRegistry, type ToolDefinition } from "../../src/run/registry.ts";
import type { IrreversibilityClass } from "../../src/vocab.ts";

/** A manifest that is valid in every field, so each case below changes exactly one thing. */
function good(name = "ok"): ToolDefinition {
  return {
    name,
    version: "1.0.0",
    capabilities: ["net"],
    irreversibility: "read_only",
    idempotent: true,
    description: "d",
    parameters: { type: "object" },
    execute: () => ({ content: "" }),
  };
}

/** The cast is the point: this is what an untyped seam hands `register`. */
function withFields(patch: Record<string, unknown>, name = "probe"): ToolDefinition {
  return { ...good(name), ...patch } as unknown as ToolDefinition;
}

function refusal(t: ToolDefinition): { threw: boolean; code?: string; message?: string } {
  const reg = new ToolRegistry();
  try {
    reg.register(t);
    return { threw: false };
  } catch (e) {
    if (!isLoomError(e)) return { threw: true, code: "(not a LoomError)", message: String(e) };
    return { threw: true, code: e.code, message: e.message };
  }
}

test("register refuses an irreversibility class outside the vocabulary, and names the tool", () => {
  for (const bad of ["nuclear", "reversible-write", "READ_ONLY", "", "irreversible ", "toString", "constructor"]) {
    const r = refusal(withFields({ irreversibility: bad }, "charge_card"));
    assert.equal(r.threw, true, `"${bad}" was accepted`);
    assert.equal(r.code, CODES.E_CONFIG_INVALID, `"${bad}" → ${String(r.code)}`);
    assert.match(r.message!, /charge_card/, `message must name the tool: ${r.message}`);
    assert.match(r.message!, /irreversibility/, `message must name the field: ${r.message}`);
  }
});

test("register refuses a non-string irreversibility", () => {
  for (const bad of [undefined, null, 42, {}, ["read_only"]]) {
    const r = refusal(withFields({ irreversibility: bad }));
    assert.equal(r.threw, true, `${JSON.stringify(bad) ?? "undefined"} was accepted`);
  }
});

test("register refuses a manifest missing or mistyping a required field", () => {
  const cases: readonly { readonly patch: Record<string, unknown>; readonly field: string }[] = [
    { patch: { name: undefined }, field: "name" },
    { patch: { name: "" }, field: "name" },
    { patch: { name: 42 }, field: "name" },
    { patch: { version: undefined }, field: "version" },
    { patch: { version: "" }, field: "version" },
    { patch: { version: 1 }, field: "version" },
    { patch: { capabilities: undefined }, field: "capabilities" },
    { patch: { capabilities: "net" }, field: "capabilities" },
    { patch: { capabilities: [1] }, field: "capabilities" },
    { patch: { idempotent: undefined }, field: "idempotent" },
    { patch: { idempotent: "sure" }, field: "idempotent" },
    { patch: { idempotent: 1 }, field: "idempotent" },
    { patch: { compensation: {} }, field: "compensation" },
    { patch: { compensation: { tool: "" } }, field: "compensation" },
    { patch: { compensation: "refund" }, field: "compensation" },
  ];
  for (const c of cases) {
    const r = refusal(withFields(c.patch, "charge_card"));
    assert.equal(r.threw, true, `${JSON.stringify(c.patch)} was accepted`);
    assert.equal(r.code, CODES.E_CONFIG_INVALID, `${JSON.stringify(c.patch)} → ${String(r.code)}`);
    assert.match(r.message!, new RegExp(c.field), `message must name the field: ${r.message}`);
  }
});

test("a refused registration leaves the registry untouched", () => {
  const reg = new ToolRegistry();
  reg.register(good("charge_card"));
  assert.throws(
    () => reg.register(withFields({ irreversibility: "nuclear" }, "charge_card")),
    (e: unknown) => isLoomError(e) && e.code === CODES.E_CONFIG_INVALID,
  );
  assert.equal(reg.get("charge_card")?.irreversibility, "read_only");
  assert.equal(reg.list().length, 1);
});

test("every member of the vocabulary still registers", () => {
  const all: readonly IrreversibilityClass[] = ["read_only", "reversible_write", "irreversible", "externally_visible"];
  for (const c of all) {
    const reg = new ToolRegistry();
    reg.register({ ...good("t"), irreversibility: c });
    assert.equal(reg.get("t")?.irreversibility, c);
  }
  // …and a well-formed compensation.
  const reg = new ToolRegistry();
  reg.register({ ...good("t"), irreversibility: "reversible_write", compensation: { tool: "refund" } });
  assert.equal(reg.get("t")?.compensation?.tool, "refund");
});
