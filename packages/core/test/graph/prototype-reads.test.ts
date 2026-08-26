/**
 * WHY THIS FILE EXISTS: a router `when` must read the DATA, not the prototype.
 *
 * `evaluate` resolved member access as a bare `o[e.prop]`, which walks the prototype chain.
 * Measured against the shipped evaluator, before the fix:
 *
 *     evaluateSource("a.constructor", {a:{b:1}})  ->  function Object() { [native code] }
 *     evaluateSource("a.__proto__",   {a:{b:1}})  ->  Object.prototype
 *     evaluateSource("a.hasOwnProperty", {a:{}})  ->  function hasOwnProperty() {…}
 *     checkExpr("a.constructor != null", …)       ->  ok, and TRUE for EVERY object
 *
 * So `when: payload.constructor != null` — a field-presence test an author would plausibly
 * write against untrusted JSON — was not a test of the payload at all. Its answer was fixed
 * before the payload existed, and a router chooses which edge runs next. Three lookups in the
 * same file had the same hole: the index form `a["constructor"]`, the bare channel reference
 * `constructor`, and `channels[name]` inside `inferType`, which is GRAPH004's unknown-channel
 * check — so `constructor` and `toString` passed validation as declared channels.
 *
 * THE SWEEPS BELOW ARE COMPUTED FROM THE RUNTIME, NOT LISTED BY HAND. A denylist of the four
 * famous names would leave `valueOf`, `isPrototypeOf`, `toLocaleString`, `__defineGetter__`
 * and whatever a later Node adds still reachable; naming the set as "every inherited key of
 * this value" is a claim that can be checked and that cannot go stale.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { checkExpr, evaluate, evaluateSource, parseExpr, type Ty } from "../../src/graph/expr.ts";

const ev = (src: string, scope: Record<string, unknown> = {}): unknown => evaluateSource(src, scope);

/** Every key reachable on `v` by inheritance — the whole chain, minus what `v` owns itself. */
function inheritedKeys(v: object): readonly string[] {
  const own = new Set(Object.getOwnPropertyNames(v));
  const out = new Set<string>();
  for (let p = Object.getPrototypeOf(v); p !== null; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) if (!own.has(k)) out.add(k);
  }
  return [...out];
}

// ── the reported defect, exactly as measured ─────────────────────────────────

test("THE FOUR MEASURED READS NOW ANSWER WITH ABSENCE", () => {
  assert.equal(ev("a.constructor", { a: { b: 1 } }), undefined, "was: function Object()");
  assert.equal(ev("a.__proto__", { a: { b: 1 } }), undefined, "was: Object.prototype");
  assert.equal(ev("a.hasOwnProperty", { a: {} }), undefined, "was: function hasOwnProperty()");

  // The fourth is the one that routes: it type-checked, and then evaluated TRUE for every
  // object alive. Deep field typing is permissive on purpose, so `ok` here is correct — what
  // had to change is the ANSWER.
  const r = checkExpr("a.constructor != null", { a: "object" as Ty });
  assert.equal(r.ok, true, "object fields stay permissively typed; that is not the bug");
  if (!r.ok) return;
  for (const payload of [{}, { b: 1 }, { nested: { x: 1 } }, []]) {
    assert.equal(evaluate(r.expr, { a: payload }), false, `still true for ${JSON.stringify(payload)}`);
  }
});

test("A ROUTER `when` TESTING FIELD PRESENCE ROUTES ON THE PAYLOAD, NOT ON THE PROTOTYPE", () => {
  // The end-to-end shape of the defect: two payloads, one with the field and one without,
  // must take DIFFERENT branches. Before the fix both were true, so the case always matched.
  const when = parseExpr("has(payload.approved) && payload.approved");
  assert.equal(evaluate(when, { payload: { approved: true } }), true);
  assert.equal(evaluate(when, { payload: { rejected: true } }), false);

  const proto = parseExpr("has(payload.constructor)");
  assert.equal(evaluate(proto, { payload: { approved: true } }), false);
  assert.equal(evaluate(proto, { payload: {} }), false);
});

// ── exhaustive: every inherited key, both syntaxes ───────────────────────────

test("EVERY INHERITED KEY OF AN OBJECT IS ABSENT — dot form and index form alike", () => {
  const keys = inheritedKeys({});
  assert.ok(keys.length >= 10, `the sweep found only ${keys.length} inherited keys — it broke, not the evaluator`);

  for (const k of keys) {
    assert.equal(ev(`a.${k}`, { a: { b: 1 } }), undefined, `a.${k} reached the prototype`);
    assert.equal(ev(`a["${k}"]`, { a: { b: 1 } }), undefined, `a["${k}"] reached the prototype`);
    assert.equal(ev(`has(a.${k})`, { a: { b: 1 } }), false, `has(a.${k}) reported presence`);
  }
});

test("EVERY INHERITED KEY OF AN ARRAY IS ABSENT — including the methods", () => {
  const keys = inheritedKeys([1, 2, 3]);
  assert.ok(keys.length >= 20, `the sweep found only ${keys.length} inherited keys — it broke`);
  assert.ok(keys.includes("map") && keys.includes("constructor"), "sanity: the sweep sees Array.prototype");
  assert.ok(!keys.includes("length"), "sanity: `length` is OWN on an array, so it is not in this set");

  for (const k of keys) {
    assert.equal(ev(`xs.${k}`, { xs: [1, 2, 3] }), undefined, `xs.${k} reached Array.prototype`);
  }
});

test("A BARE CHANNEL REFERENCE CANNOT NAME A PROTOTYPE KEY EITHER", () => {
  // `scope[e.name]` had the same hole: `constructor` with an EMPTY scope answered `Object`.
  for (const k of inheritedKeys({})) {
    assert.equal(ev(k, {}), undefined, `the bare reference \`${k}\` reached the scope's prototype`);
  }
  assert.equal(ev("constructor == null", {}), true);
});

test("GRAPH004's UNKNOWN-CHANNEL CHECK SEES PROTOTYPE NAMES AS UNKNOWN", () => {
  // `channels[e.name]` found `Object` for "constructor", so the check — its teeth — passed.
  for (const k of inheritedKeys({})) {
    const r = checkExpr(`${k} == null`, { real: "object" });
    assert.equal(r.ok, false, `"${k}" was accepted as a declared channel`);
    if (!r.ok) assert.match(r.errors.join(" | "), new RegExp(`unknown channel "${k}"`));
  }
  // And a channel that IS declared still resolves, with its declared type enforced.
  assert.equal(checkExpr("real.field == 1", { real: "object" }).ok, true);
  assert.equal(checkExpr("real > 1", { real: "string" }).ok, false, "declared types still bite");
});

test("A PROTOTYPE NAME IS NOT A BUILTIN, AND SAYS SO", () => {
  // `t.v in BUILTINS` walked the chain, so these parsed as calls and then died with the
  // nonsense "takes undefined argument(s)".
  for (const k of inheritedKeys({})) {
    assert.throws(() => parseExpr(`${k}(1)`), new RegExp(`unknown function "${k}"`), `${k}(1)`);
  }
  assert.throws(() => parseExpr("valueOf()"), /unknown function "valueOf"/);
});

// ── the controls: this is own-property access, NOT a denylist ────────────────

test("A KEY AN AUTHOR GENUINELY WROTE STILL READS, EVEN A FAMOUS ONE", () => {
  // `graph/yaml.ts` deliberately admits `constructor` and `__proto__` as ordinary document
  // keys (see test/graph/yaml.test.ts) — so a channel really can carry them, and shadowing
  // must WORK. A denylist "fix" fails exactly here.
  assert.equal(ev("a.constructor", { a: { constructor: "mine" } }), "mine");
  assert.equal(ev("a.toString", { a: { toString: 7 } }), 7);
  assert.equal(ev("a.hasOwnProperty", { a: { hasOwnProperty: false } }), false);
  assert.equal(ev('a["valueOf"]', { a: { valueOf: "data" } }), "data");

  // `__proto__` as data needs defineProperty to create — plain assignment invokes the setter.
  const withProto: Record<string, unknown> = {};
  Object.defineProperty(withProto, "__proto__", { value: "payload", enumerable: true, configurable: true });
  assert.equal(ev("a.__proto__", { a: withProto }), "payload");

  // …and as a channel name.
  assert.equal(ev("constructor", { constructor: 42 }), 42);
  assert.equal(checkExpr("constructor == null", { constructor: "object" as Ty }).ok, true);
});

test("ORDINARY DATA ACCESS, ARRAY INDEXING AND `length` ARE UNTOUCHED", () => {
  const scope = { v: { a: { b: [10, 20, 30] } }, xs: [1, 2, 3], s: "abc", n: 2 };
  assert.equal(ev("v.a.b[1]", scope), 20, "nested member + index");
  assert.equal(ev("v.a.b[-1]", scope), 30, "negative indices count from the end");
  assert.equal(ev('v["a"].b[0]', scope), 10, "index form of member access");
  assert.equal(ev("v.a.b[n]", scope), 30, "a computed index");
  assert.equal(ev("xs.length", scope), 3, "array `length` is an OWN property and still reads");
  assert.equal(ev("len(xs)", scope), 3);
  assert.equal(ev("len(s)", scope), 3);
  assert.equal(ev("contains(xs, 2)", scope), true);
  assert.equal(ev("xs[0] + xs[2]", scope), 4);
  assert.equal(ev("v.a.b[1] > 15 && len(xs) == 3", scope), true);

  // Absence still behaves as absence, by the same rule.
  assert.equal(ev("v.nope", scope), undefined);
  assert.equal(ev("xs[9]", scope), undefined);
  assert.equal(ev("s.length", scope), undefined, "PRE-EXISTING: member access on a string is not an object read");

  // A null-prototype payload — the projection may hand one over — reads its own data fine.
  const bare = Object.assign(Object.create(null), { b: 1 });
  assert.equal(ev("a.b", { a: bare }), 1);
});

test("AN INHERITED DATA PROPERTY IS STILL NOT DATA", () => {
  // Not a method — a plain value on the prototype. Own-property access is the rule, not
  // "skip the builtins".
  const child = Object.create({ inherited: "from the prototype" }) as Record<string, unknown>;
  child["mine"] = "own";
  assert.equal(ev("a.mine", { a: child }), "own");
  assert.equal(ev("a.inherited", { a: child }), undefined);
  assert.equal(ev("has(a.inherited)", { a: child }), false);
});

test("AN OWN ACCESSOR DOES NOT RUN — the language claims to be side-effect free", () => {
  let calls = 0;
  const trap = {};
  Object.defineProperty(trap, "boom", {
    get() {
      calls++;
      throw new Error("an expression executed user code");
    },
    enumerable: true,
    configurable: true,
  });

  assert.doesNotThrow(() => ev("a.boom", { a: trap }), "evaluation must stay total");
  assert.equal(ev("a.boom", { a: trap }), undefined);
  assert.equal(ev('a["boom"]', { a: trap }), undefined);
  assert.equal(calls, 0, "the getter ran — evaluation is no longer side-effect free");
});
