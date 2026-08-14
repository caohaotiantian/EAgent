/**
 * The three registries, held to ONE disposal discipline — and the registration knob.
 *
 * `ToolRegistry` kept a stack per key so that disposing a registration restores the one
 * it shadowed. `ModelRegistry` and `FunctionRegistry` did not, and each carried the same
 * three defects in consequence: the shadowed entry was destroyed rather than restored, a
 * stale handle deleted a NEWER registration that merely shared its key, and (models only)
 * `#default` kept naming a provider that was gone, so every provider-less
 * `models.require()` — every agent node — threw `no model adapter registered for
 * "(default)"` while the replacement sat reachable by name.
 *
 * The second half of this file pins the registration policy knob. The hazard it closes is
 * an audit hazard, not a privilege one: anyone who can call `register()` already runs code
 * in this process. What they can do that nothing else in the system can is change the tool
 * a human already approved a gate against — the posture was computed from manifest A and
 * manifest B ran.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { LoomError } from "../../src/errors.ts";
import type { TaskId } from "../../src/ids.ts";
import {
  FunctionRegistry,
  MockModelAdapter,
  ModelRegistry,
  ToolRegistry,
  type FunctionBody,
  type ModelAdapter,
  type ToolDefinition,
} from "../../src/run/registry.ts";
import type { StateView } from "../../src/state/channels.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tool(name: string, marker: string): ToolDefinition {
  return {
    name,
    version: "1.0.0",
    capabilities: [],
    irreversibility: "read_only",
    idempotent: true,
    description: marker,
    parameters: { type: "object" },
    execute: () => ({ content: marker }),
  };
}

function adapter(provider: string): ModelAdapter {
  return new MockModelAdapter({ provider, script: () => ({ text: provider }) });
}

/** A body whose only job is to be identifiable. */
function body(marker: string): FunctionBody {
  return () => ({ writes: { marker } });
}

const NO_VIEW = { get: () => undefined } as unknown as StateView;
const CTX = { taskId: "t" as TaskId, signal: new AbortController().signal, now: () => 0 };

function markerOf(f: FunctionBody | undefined): string | undefined {
  if (f === undefined) return undefined;
  const out = f(NO_VIEW, CTX) as { writes: { marker: string } };
  return out.writes.marker;
}

function loomError(fn: () => unknown): LoomError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LoomError, `expected a LoomError, got ${String(e)}`);
    return e;
  }
  throw new assert.AssertionError({ message: "expected a throw, got a clean return" });
}

// ---------------------------------------------------------------------------
// ToolRegistry — the discipline the other two are measured against
// ---------------------------------------------------------------------------

test("TOOLS: disposing a shadow restores the definition it shadowed", () => {
  const r = new ToolRegistry();
  r.register(tool("fs.write", "base"));
  const shadow = r.register(tool("fs.write", "shadow"));

  assert.equal(r.require("fs.write").description, "shadow");
  shadow.dispose();
  assert.equal(r.require("fs.write").description, "base");
  assert.equal(r.list().length, 1);
});

test("TOOLS: a stale handle cannot delete a newer registration under the same name", () => {
  const r = new ToolRegistry();
  const first = r.register(tool("fs.write", "first"));
  first.dispose();
  r.register(tool("fs.write", "second"));

  first.dispose(); // the same handle again — it has nothing left to remove
  assert.equal(r.require("fs.write").description, "second");
});

// ---------------------------------------------------------------------------
// ModelRegistry — mirror of the above
// ---------------------------------------------------------------------------

test("MODELS: disposing the default lets the next registration claim it", () => {
  // The reported failure, verbatim: an embedder hot-swaps its provider.
  const r = new ModelRegistry();
  const d = r.register(adapter("anthropic"));
  d.dispose();
  r.register(adapter("anthropic-v2"));

  assert.equal(r.get()?.provider, "anthropic-v2");
  assert.equal(r.require().provider, "anthropic-v2");
});

test("MODELS: disposing a shadow restores the adapter it shadowed, default and all", () => {
  const r = new ModelRegistry();
  const base = adapter("anthropic");
  r.register(base);
  const shadow = r.register(new MockModelAdapter({ provider: "anthropic", script: () => ({ text: "shadow" }) }), true);

  shadow.dispose();
  assert.equal(r.get("anthropic"), base, "the shadowed adapter must come back, not vanish");
  assert.equal(r.require().provider, "anthropic");
});

test("MODELS: a stale handle cannot delete the live adapter that replaced it", () => {
  // register(a1, default) → register(a2, default) under ONE provider name → dispose the
  // FIRST handle. Deleting by name would take out a2, the live one.
  const r = new ModelRegistry();
  const a1 = adapter("anthropic");
  const a2 = new MockModelAdapter({ provider: "anthropic", script: () => ({ text: "second" }) });
  const first = r.register(a1, true);
  r.register(a2, true);

  first.dispose();
  assert.equal(r.get("anthropic"), a2);
  assert.equal(r.require().provider, "anthropic");
});

test("MODELS: an explicit default is restored to the previous one when disposed", () => {
  const r = new ModelRegistry();
  r.register(adapter("anthropic")); // implicit default
  const openai = r.register(adapter("openai"), true); // takes it

  assert.equal(r.require().provider, "openai");
  openai.dispose();
  assert.equal(r.require().provider, "anthropic", "the previous default must come back");
});

test("MODELS: a double dispose is inert", () => {
  const r = new ModelRegistry();
  const d = r.register(adapter("anthropic"));
  d.dispose();
  const live = r.register(adapter("anthropic"));
  d.dispose(); // second call on the stale handle

  assert.equal(r.get("anthropic")?.provider, "anthropic");
  assert.equal(r.require().provider, "anthropic");
  live.dispose();
  assert.equal(r.get("anthropic"), undefined);
});

// ---------------------------------------------------------------------------
// FunctionRegistry — mirror of the above
// ---------------------------------------------------------------------------

test("FUNCTIONS: disposing a shadow restores the body it shadowed", () => {
  const r = new FunctionRegistry();
  r.register("function/merge@stable", body("base"));
  const shadow = r.register("function/merge@stable", body("shadow"));

  assert.equal(markerOf(r.require("function/merge@stable")), "shadow");
  shadow.dispose();
  assert.equal(markerOf(r.require("function/merge@stable")), "base");
});

test("FUNCTIONS: a stale handle cannot delete a newer body under the same ref", () => {
  const r = new FunctionRegistry();
  const first = r.register("function/merge@stable", body("first"));
  first.dispose();
  r.register("function/merge@stable", body("second"));

  first.dispose();
  assert.equal(markerOf(r.get("function/merge@stable")), "second");
  assert.equal(r.has("function/merge@stable"), true);
});

test("FUNCTIONS: disposing a hand override falls back to the loader, not to nothing", () => {
  let loads = 0;
  const r = new FunctionRegistry({
    loader: (ref) => {
      loads += 1;
      return ref === "function/merge@stable" ? body("loaded") : undefined;
    },
  });
  assert.equal(markerOf(r.get("function/merge@stable")), "loaded");
  const hand = r.register("function/merge@stable", body("hand"));
  assert.equal(markerOf(r.get("function/merge@stable")), "hand");

  hand.dispose();
  assert.equal(markerOf(r.get("function/merge@stable")), "loaded");
  assert.equal(loads, 1, "the loaded body was cached; disposing an override must not re-load it");
});

// ---------------------------------------------------------------------------
// The registration knob (D-3)
// ---------------------------------------------------------------------------

test("KNOB: registration is allowed by default, sealed or not", () => {
  const r = new ToolRegistry();
  r.register(tool("fs.write", "wiring"));
  r.seal();
  r.register(tool("fs.read", "late"));

  assert.equal(r.require("fs.read").description, "late");
  assert.equal(r.sealed, true);
});

test("KNOB: under deny, wiring before the seal is ordinary and still works", () => {
  const r = new ToolRegistry({ registerAfterSeal: "deny" });
  r.register(tool("fs.write", "wiring"));
  r.register(tool("fs.write", "wiring-shadow"));

  assert.equal(r.require("fs.write").description, "wiring-shadow");
  assert.equal(r.sealed, false);
});

test("KNOB: under deny, registration after the seal is REFUSED — loudly, and typed", () => {
  const r = new ToolRegistry({ registerAfterSeal: "deny" });
  r.register(tool("fs.write", "wiring"));
  r.seal();

  const e = loomError(() => r.register(tool("fs.write", "late-shadow")));
  assert.equal(e.class, "policy");
  assert.equal(e.code, "E_NOT_AUTHORIZED");
  assert.match(e.message, /fs\.write/);
  // The refusal must say how to configure it, or the operator reads it as a bug.
  assert.match(e.message, /registerAfterSeal/);
  assert.match(e.message, /allow/);
});

test("KNOB: a refused registration leaves the registry byte-for-byte as it was", () => {
  const r = new ToolRegistry({ registerAfterSeal: "deny" });
  r.register(tool("fs.write", "wiring"));
  r.seal();

  assert.throws(() => r.register(tool("fs.write", "late-shadow")));
  assert.throws(() => r.register(tool("net.post", "brand-new")));
  assert.equal(r.require("fs.write").description, "wiring", "the approved definition must still be the live one");
  assert.equal(r.get("net.post"), undefined);
  assert.deepEqual(Object.keys(r.manifests()), ["fs.write"]);
});

test("KNOB: sealing is idempotent and one-way", () => {
  const r = new ToolRegistry({ registerAfterSeal: "deny" });
  assert.equal(r.sealed, false);
  r.seal();
  r.seal();
  assert.equal(r.sealed, true);
  assert.equal("unseal" in r, false, "a seal that can be lifted in-process is not a seal");
});

// ---------------------------------------------------------------------------
// H20 — the docstring must not claim a recording the engine does not do
// ---------------------------------------------------------------------------

test("H20: `FunctionContext.now` does not claim to be recorded while nothing records it", () => {
  // Invariant 4 says all nondeterminism goes through a recorded effect. `ctx.now` is
  // INJECTED (Engine.#now, defaulting to Date.now) and no `effect.started{kind:"clock"}`
  // is ever appended, so a function body reading it replays differently.
  //
  // This guard is conditional on purpose: the day the engine records a clock read, the
  // first assertion stops holding and this test tells whoever did it to restore the
  // stronger docstring rather than leaving the weaker one in place.
  const here = fileURLToPath(new URL(".", import.meta.url));
  const engine = readFileSync(`${here}../../src/run/engine.ts`, "utf8");
  const registry = readFileSync(`${here}../../src/run/registry.ts`, "utf8");

  const recordsAClock = /kind:\s*"clock"/.test(engine);
  // `(?!\/\*\*)` keeps the capture inside the LAST comment before the declaration; without
  // it the match starts at the module docstring and swallows the whole file.
  const nowDoc = /\/\*\*((?:(?!\/\*\*)[\s\S])*?)\*\/\s*now\(\): number;/.exec(registry)?.[1];
  assert.ok(nowDoc !== undefined, "FunctionContext.now lost its docstring");

  if (recordsAClock) {
    assert.match(nowDoc, /\brecorded\b/i, "the engine records a clock now — say so on the seam");
  } else {
    // Phrase-level, deliberately. A regex cannot tell "is recorded" from "is not recorded"
    // by the word alone, so this pins the negation and bans the old sentence outright.
    assert.match(
      nowDoc,
      /not a recorded effect/i,
      "nothing appends a clock effect, so the seam must say it is not recorded",
    );
    assert.doesNotMatch(nowDoc, /^\s*\*?\s*Recorded clock\b/im, "the claim H20 refuted is back");
    assert.match(nowDoc, /inject/i, "say what it actually is: the engine's injected clock");
  }
});
