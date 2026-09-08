/**
 * THE EXTENSION SURFACE'S RULES WERE REAL AND ENFORCED, AND TAUGHT NOWHERE THE AUTHOR LOOKS.
 *
 * A code resource must be a bare function expression. That rule is enforced — `compileRealm`
 * evaluates `(<the file>)` and reads the value back — and until this suite existed it was
 * WRITTEN down in exactly one source comment, in a file an extension author has no reason to
 * open. What the tool said when the rule was broken was V8's own text and nothing else:
 *
 *     function resource "function/count@stable" did not evaluate: Unexpected token ';'
 *
 * That names the character V8 choked on. It does not name the rule, and the rule is not
 * recoverable from the token: `module.exports = f;` fails at `';'`, `export default f` fails at
 * `'export'`, and `const f = …; f` fails at `'const'` — three tokens, one mistake.
 *
 * This suite holds the seam that fixed it. It asserts against the loaders' OWN refusals and
 * against the compiler's OWN closed vocabularies, never against a second copy of either — a
 * hand-written list in a test rots the same way `examples/README.md`'s "Both graphs" rotted
 * against four graphs, and rots silently, which is worse.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { REQUIRED_BLOCK } from "../src/graph/spec.ts";
import { createFunctionLoader } from "../src/resources/functions.ts";
import { createHookLoader } from "../src/resources/hook-loader.ts";
import { ResourceStore } from "../src/resources/store.ts";
import { HOOK_POINTS } from "../src/run/hooks.ts";
import { REDUCER_NAMES } from "../src/state/channels.ts";

const ACTOR = { kind: "human", id: "u:test" } as const;

function storeWith(kind: "hook" | "function", source: unknown) {
  const store = new ResourceStore({ now: () => 1 });
  const ref = store.publish({ kind, name: "probe", content: source, actor: ACTOR });
  store.promote(ref, "canary", ACTOR);
  store.promote(ref, "stable", ACTOR);
  return store;
}

/** Load `<kind>/probe@stable` and hand back the refusal's message, or fail if it loaded. */
function refusalFor(kind: "hook" | "function", source: unknown): string {
  const store = storeWith(kind, source);
  const load =
    kind === "hook"
      ? () => createHookLoader({ store }).load("hook/probe@stable")
      : () => createFunctionLoader({ store }).load("function/probe@stable");
  try {
    load();
  } catch (e) {
    return (e as Error).message;
  }
  assert.fail(`${kind} body ${JSON.stringify(source)} loaded; it was supposed to be refused`);
}

// The three spellings an author reaches for. Each fails at a DIFFERENT token, which is why the
// token alone cannot teach the rule.
const WRONG_SHAPES: readonly (readonly [string, string])[] = [
  ["module.exports", "module.exports = function (a, b) { return {}; };"],
  ["export default", "export default function (a, b) { return {}; }"],
  ["a named const", "const f = (a, b) => ({}); f"],
];

for (const kind of ["function", "hook"] as const) {
  for (const [label, source] of WRONG_SHAPES) {
    test(`a ${kind} body written as ${label} is told what a body IS, not which token V8 hit`, () => {
      const said = refusalFor(kind, source);
      assert.match(said, /did not evaluate: Unexpected token/, "V8's own text stays — it locates the mistake");
      assert.match(said, /BARE FUNCTION EXPRESSION/, "and the rule that was broken is now named");
      assert.match(said, /module\.exports, export default and any top-level statement/);
      // The signature is half the rule: an author who gets `module.exports` wrong usually also
      // does not know what arguments arrive.
      assert.match(said, /\(view, ctx\)/);
      assert.match(said, /\(input, ctx\)/);
    });
  }

  test(`a ${kind} body that parses to something that is not a function is told the same rule`, () => {
    const said = refusalFor(kind, `({ notAFunction: true })`);
    assert.match(said, /evaluated to object, not a function/);
    assert.match(said, /BARE FUNCTION EXPRESSION/);
  });

  test(`a ${kind} body whose OWN code throws is NOT told it has the wrong shape`, () => {
    // The `did not evaluate` arm catches the body's own errors too. Attaching shape advice to
    // every one of them would send an author who wrote a correct expression hunting for a
    // `module.exports` they never typed. This is why the sentence is gated at all.
    const said = refusalFor(kind, `(() => { throw new Error("mine"); })()`);
    assert.match(said, /did not evaluate: mine/);
    assert.doesNotMatch(said, /BARE FUNCTION EXPRESSION/);
  });
}

test("the gate reads the error's NAME, because instanceof is false across the realm boundary", () => {
  // This is the measurement the whole mechanism turns on and the one a reader will not believe.
  // The SyntaxError raised out of `vm.runInContext` is built by the CONTEXT'S constructor, so
  // its prototype is not the host's and `e instanceof SyntaxError` is FALSE. Gating the sentence
  // the obvious way would typecheck, read correctly, and never once fire.
  //
  // Asserted through the loader rather than through a bare `vm` probe, so the property is
  // checked on the path that actually carries it.
  const store = storeWith("function", "module.exports = function (a, b) { return {}; };");
  try {
    createFunctionLoader({ store }).load("function/probe@stable");
    assert.fail("the malformed body must refuse");
  } catch (e) {
    assert.equal((e as Error).name, "LoomError", "the loader re-raises as a LoomError, not the raw SyntaxError");
    // What the loader saw is the only thing that can be checked from out here, and it is the
    // sentence itself: it is present, therefore the `.name` read matched where `instanceof`
    // could not have.
    assert.match((e as Error).message, /Unexpected token ';' — a code resource file is a BARE FUNCTION EXPRESSION/);
  }
});

// ── the closure, and where it is written down ───────────────────────────────

/**
 * README.md's "Extending it, and where that stops" quotes three compiler `fix:` lines verbatim.
 * A doc that quotes a closed set is a doc that rots the moment the set moves, and this one has
 * rotted before — `examples/README.md` said "Both graphs" against four graphs for long enough
 * that two independent readers reported it.
 *
 * So the check is against the COMPILER'S OWN runtime tables, never a second list written here:
 * `REQUIRED_BLOCK` is `validate.ts`'s only runtime enumeration of `NodeType` (its own comment
 * says so), `REDUCER_NAMES` is what `GRAPH003_UNKNOWN_REDUCER`'s fix joins, and `HOOK_POINTS`
 * is what `GRAPH003_UNKNOWN_HOOK_POINT`'s fix joins. Add a node type and this goes red naming
 * the README, which is the only warning anyone gets that a published bound moved.
 */
const README = readFileSync(new URL("../../../README.md", import.meta.url), "utf8");

test("README's fork-required list quotes the compiler's OWN closed sets, member for member", () => {
  for (const [what, members] of [
    ["node type", Object.keys(REQUIRED_BLOCK)],
    ["reducer", [...REDUCER_NAMES]],
    ["hook point", [...HOOK_POINTS]],
  ] as const) {
    // Joined exactly as the `fix:` line joins them, so this fails if the ORDER moves too — the
    // README is quoting a line a user will compare character by character against their terminal.
    assert.ok(
      README.includes(members.join(", ")),
      `README.md no longer quotes the ${what} set as the compiler prints it: expected "${members.join(", ")}"`,
    );
  }
});

test("the embedder/CLI split the README states is the one scripts/surface.json actually pins", () => {
  // The correction this section exists to carry: an in-process tool needs a fork from the CLI
  // and NOT from a library embedder. That is not an opinion, it is which names are on the pinned
  // surface — so it is checked against the pin file and the barrel rather than restated.
  const surface = readFileSync(new URL("../../../scripts/surface.json", import.meta.url), "utf8");
  const barrel = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(surface, /"ToolRegistry"/, "an embedder registers a host-realm tool through this");
  assert.doesNotMatch(surface, /"openWorkspace"/, "…and the CLI's own door is not on the surface");
  assert.doesNotMatch(surface, /"compileRealm"/);
  assert.doesNotMatch(barrel, /cli\.ts/, "index.ts does not re-export cli.ts, which is why the split exists");
  assert.doesNotMatch(barrel, /resources\/realm\.ts/);
});

// ── the async refusal must not itself run user code on the host thread ────────

test("the async check reads no property off the body, so a hostile getter never runs", () => {
  // The refusal exists because an async body outruns the vm's `timeout`. The first version of
  // the check asked `value.constructor` and `Object.prototype.toString.call(value)` on the HOST
  // side, after `runInContext` returned — and both are interceptable, so enforcing the rule
  // reintroduced the hazard the rule describes.
  //
  // ASSERTED BY EFFECT, NOT BY ELAPSED TIME. The reviewer found this with a getter that spins,
  // and a spin is the wrong thing for a test to measure: "no assertion whose truth depends on
  // elapsed time" is the rule, and a duration bound is exactly that — it fails on a loaded
  // machine and passes on a fast one. These getters THROW instead. If either is read the load
  // dies with that message; if neither is, the body loads and the property was never touched.
  const hostile = `(function () {
     const f = (a, b) => ({ ok: 1 });
     Object.defineProperty(f, "constructor", { get() { throw new Error("GETTER-RAN:constructor"); } });
     Object.defineProperty(f, Symbol.toStringTag, { get() { throw new Error("GETTER-RAN:toStringTag"); } });
     return f;
   })()`;
  const fn = createFunctionLoader({ store: storeWith("function", hostile) }).load("function/probe@stable");
  assert.equal(typeof fn, "function", "a synchronous body still loads, and no getter was read");
});

test("…and every async shape is still refused, in both loaders", () => {
  // `async function*` carries AsyncGeneratorFunction.prototype, not AsyncFunction.prototype —
  // a prototype check naming only the first lets it through, which is how the narrower version
  // of this fix turned two of the seam's own tests red.
  for (const kind of ["function", "hook"] as const) {
    for (const body of ["async (a, b) => ({ ok: 1 })", "async function* (a, b) { yield 1; }"]) {
      assert.match(refusalFor(kind, body), /async function body cannot be bounded by any deadline/);
    }
  }
});

/**
 * THE TWO COUNTS THE SECTION OPENS WITH, CHECKED AGAINST THE TABLE AND THE BULLETS.
 *
 * The test above pins the three fork-required sets, member for member, and nothing pinned the
 * NUMBERS the section leads with — so "Twelve things need no fork. Three do" could drift from
 * its own table in either direction, silently, which is the failure mode this whole section is
 * an argument against. It has drifted once already: the twelve was an UNDERCOUNT, because five
 * `EngineOptions` members were reachable from a library embedder and not from argv and had no
 * rows at all.
 *
 * Counted off the DOCUMENT rather than restated here: the "no fork" number is the body rows of
 * the table (every line between the header separator and the blank line that ends it), and the
 * "fork required" number is the bullets under that heading. A count written a second time in
 * this file would be the same rot one file over.
 */
test("README's extensibility section counts its own rows", () => {
  const section = README.slice(README.indexOf("## Extending it, and where that stops"));
  const head = section.indexOf("| what | how | measured |");
  assert.ok(head > 0, "the no-fork table is gone — this gate now checks nothing");
  const rows = section
    .slice(head)
    .split("\n")
    .slice(2) // the header row and its `|---|` separator
    .filter((l) => l.startsWith("|")).length;

  const forkHead = section.indexOf("**Fork required.**");
  assert.ok(forkHead > 0);
  const bullets = section
    .slice(forkHead)
    .split("\n\n")[1]!
    .split("\n")
    .filter((l) => l.startsWith("- **")).length;

  const said = /\*\*([A-Z][a-z]+) things need no fork\. ([A-Z][a-z]+) do\*\*/.exec(section);
  assert.ok(said, "the section no longer states its two counts in the sentence this gate reads");
  const WORDS: Readonly<Record<string, number>> = {
    Three: 3,
    Four: 4,
    Five: 5,
    Six: 6,
    Seven: 7,
    Eight: 8,
    Nine: 9,
    Ten: 10,
    Eleven: 11,
    Twelve: 12,
    Thirteen: 13,
    Fourteen: 14,
    Fifteen: 15,
    Sixteen: 16,
    Seventeen: 17,
    Eighteen: 18,
    Nineteen: 19,
    Twenty: 20,
  };
  assert.equal(WORDS[said[1]!], rows, `the section says ${said[1]!} no-fork rows and the table has ${String(rows)}`);
  assert.equal(WORDS[said[2]!], bullets, `the section says ${said[2]!} fork-required rows and there are ${String(bullets)} bullets`);
});
