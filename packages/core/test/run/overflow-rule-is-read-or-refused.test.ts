/**
 * A PROJECTION FIELD NOBODY VALIDATES, ONE FIELD OVER FROM `take`.
 *
 * `readTake` refuses a `take` it cannot read, because a bound nobody can read is not a licence
 * to widen. `applyOverflow` had the same gap in `maxTokens` and `overflow` and answered it two
 * different wrong ways. Measured through `assembleContext` at rung 2, before this:
 *
 *     {"maxTokens":10,"overflow":"truncate_tail"} -> rung 2 | channel c = ["aaaaaaaaaaaaaaaaaaaa"]
 *     {"maxTokens":10,"overflow":"TRUNCATE_TAIL"} -> THROWS TypeError | Cannot read properties of undefined (reading 'slice')
 *     {"maxTokens":10,"overflow":"nonsense"}      -> THROWS TypeError | Cannot read properties of undefined (reading 'slice')
 *     {"maxTokens":"abc","overflow":"truncate_tail"} -> rung 2 | channel c = []
 *
 * The `switch` carried no `default`, so an unknown rule fell off the end as `undefined` and the
 * caller dereferenced it — a bare `TypeError`, not a `LoomError`, out of prompt assembly. And
 * `maxTokens: "abc"` makes the `keep` arithmetic `NaN`, so `slice(0, NaN)` emptied the channel
 * silently: the node was shown an empty list where its author asked for a bounded one, with no
 * diagnostic anywhere.
 *
 * NOTHING CHECKS EITHER FIELD AT COMPILE. `compile` runs `unknownKeys` over
 * `contextProjection` and reads the key NAMES only, so `overflow: "TRUNCATE_TAIL"` — a plausible
 * thing to write by hand — compiles clean. The compile-time diagnostic belongs in
 * `graph/validate.ts` with the other projection checks; this is the runtime half, and it is the
 * half that has to hold for a graph built by an embedder rather than compiled from a file.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { assembleContext } from "../../src/run/context.ts";
import type { AssembleInput } from "../../src/run/context.ts";

/** Long enough that the ladder reaches rung 2, which is the only rung that applies `overflow`. */
const LONG = Array.from({ length: 400 }, () => "aaaaaaaaaaaaaaaaaaaa");

function input(projection: unknown): AssembleInput {
  return {
    system: "s",
    instruction: "i",
    channels: { c: LONG },
    channelSpecs: { c: { type: "array", reduce: "replace", contextProjection: projection } },
  } as unknown as AssembleInput;
}

test("AN UNKNOWN `overflow` RULE IS REFUSED, not dereferenced as `undefined`", async () => {
  for (const rule of ["TRUNCATE_TAIL", "nonsense", "", 7, null]) {
    await assert.rejects(
      () => assembleContext(input({ maxTokens: 10, overflow: rule }), { maxTokens: 120 }),
      (e: { code?: string; message?: string }) => {
        assert.equal(e.code, "E_GRAPH_INVALID", `overflow ${JSON.stringify(rule)} must be a typed refusal, got ${String(e.code)}`);
        assert.match(e.message ?? "", /overflow/, "and the message names the field");
        return true;
      },
      `overflow: ${JSON.stringify(rule)} must refuse`,
    );
  }
});

test("A `maxTokens` THAT IS NOT A POSITIVE TOKEN BOUND IS REFUSED, not silently emptied", async () => {
  // `slice(0, NaN)` is `[]`, so this was the quiet one: the author asked for a bound and the
  // node was shown nothing at all. `-5` is the same defect with a sign on it — it passed the
  // finite test and then truncated nothing, because `rendered.slice(0, -20)` removes nothing.
  //
  // `"10"` IS NOT IN THIS LIST, and an earlier version of it put it there. A quoted number is
  // what hand-written YAML gives, `readTake` reads it for exactly that reason, and before that
  // refusal `maxTokens: "10"` produced byte-identical output to `maxTokens: 10`. Refusing it
  // turned a working graph into a failing one; the ordinary-half test below pins that it does
  // not any more.
  for (const bound of ["abc", null, {}, NaN, -5, 0]) {
    await assert.rejects(
      () => assembleContext(input({ maxTokens: bound, overflow: "truncate_tail" }), { maxTokens: 120 }),
      (e: { code?: string; message?: string }) => {
        assert.equal(e.code, "E_GRAPH_INVALID", `maxTokens ${JSON.stringify(bound)} must be a typed refusal`);
        assert.match(e.message ?? "", /maxTokens/, "and the message names the field");
        return true;
      },
      `maxTokens: ${JSON.stringify(bound)} must refuse`,
    );
  }
});

test("A TYPO'D `overflow` ON A CHANNEL UNDER ITS OWN BOUND STAYS INERT, as it was", async () => {
  // `projectAll` calls `applyOverflow` for EVERY projected channel once the ladder reaches rung
  // 2, so checking `overflow` at the top of it made one typo anywhere kill the whole assembly —
  // including on a channel that never reaches the switch. Here `d` is far under its bound and
  // its rule is misspelled; `c` is the one that actually overflows.
  const r = await assembleContext(
    {
      system: "s",
      instruction: "i",
      channels: { c: LONG, d: ["x"] },
      channelSpecs: {
        c: { type: "array", reduce: "replace", contextProjection: { maxTokens: 10, overflow: "truncate_tail" } },
        d: { type: "array", reduce: "replace", contextProjection: { maxTokens: 100000, overflow: "TRUNCATE_TAIL" } },
      },
    } as never,
    { maxTokens: 120 },
  );
  assert.deepEqual(r.channels["c"], ["aaaaaaaaaaaaaaaaaaaa"], "the channel that overflows is truncated");
  assert.deepEqual(r.channels["d"], ["x"], "and the one that does not is untouched, misspelled rule and all");
});

test("THE ORDINARY HALF: a readable projection still truncates exactly as it did", async () => {
  // A QUOTED BOUND IS A BOUND. One reader for `take` and `maxTokens`, because there is one
  // problem behind them: YAML makes `10` and `"10"` a quoting accident apart.
  const quoted = await assembleContext(input({ maxTokens: "10", overflow: "truncate_tail" }), { maxTokens: 120 });
  assert.deepEqual(quoted.channels["c"], ["aaaaaaaaaaaaaaaaaaaa"], 'maxTokens: "10" reads as 10, which is what it did before any of this');

  // The whole point of the refusals above is that this case is untouched. `truncate_tail` and
  // `summarize` both take the array arm at rung 2; `error` refuses, which it always did.
  for (const rule of ["truncate_tail", "summarize"]) {
    const r = await assembleContext(input({ maxTokens: 10, overflow: rule }), { maxTokens: 120 });
    assert.equal(r.rung, 2, `${rule}: the ladder reaches the rung that applies the projection`);
    assert.deepEqual(r.channels["c"], ["aaaaaaaaaaaaaaaaaaaa"], `${rule}: bounded to what fits, not emptied`);
  }

  // And the third rule still refuses on its own terms, which is the distinction that matters:
  // `error` is a rule the author CHOSE, and its refusal names the bound rather than the field.
  await assert.rejects(
    () => assembleContext(input({ maxTokens: 10, overflow: "error" }), { maxTokens: 120 }),
    (e: { code?: string; message?: string }) => {
      assert.equal(e.code, "E_CONTEXT_OVERFLOW", "a declared `error` rule is not an unreadable one");
      assert.match(e.message ?? "", /exceeded 10 tokens/);
      return true;
    },
  );
});
