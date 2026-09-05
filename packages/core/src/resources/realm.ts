/**
 * ONE HARDENED COMPILE PATH FOR EVERY RESOURCE THAT IS CODE.
 *
 * `function` bodies and `hook` bodies are both published source, both pinned by digest, and
 * both have to be handed arguments without handing over the host realm with them. They differ
 * only in what those arguments ARE — `(view, ctx)` for a function node, `(input, ctx)` for a
 * hook. Everything else is identical, and everything else is the part that is easy to get
 * wrong: this module's predecessor shipped a live escape,
 *
 *     view.constructor.constructor("return globalThis")().process   → object
 *
 * where the globals had been rebuilt out of the context's own intrinsics and the ARGUMENTS
 * had not. The fix — rebuild the arguments inside the context from a JSON payload — is one
 * pattern applied at one seam. Forking it per resource kind would mean the next such fix
 * lands in one copy of two, so the seam is factored here and each caller supplies only its
 * BRIDGE: the few lines that turn a JSON payload into that kind's argument list.
 *
 * ## This is NOT a security boundary, and says so
 *
 * `node:vm` does not isolate untrusted code. A fresh context is a scoping mechanism. What it
 * buys is real but narrow: for the names this module governs, and for every argument it passes,
 * a body sees THAT CONTEXT'S OWN copies instead of the host's. It is NOT "no host object is ever
 * in its reach" — that is what this said, and `RealmOptions.globals` is a door the embedder opens
 * themselves: whatever they pass under a name this module does not govern arrives in the body
 * intact, host realm and all. The refusal in `refuseGovernedGlobals` guards the namespace; it
 * cannot vet a value, and it says so where an embedder will read it. Untrusted code belongs in
 * `sandbox/subprocess.ts`, behind a tool manifest and a capability. Code resources are assumption
 * A13: trusted, authored by whoever authors the graph.
 */

import vm from "node:vm";

import { CODES, err } from "../errors.ts";

/**
 * The globals this module RE-BINDS. **NOT the set a body may see** — the docstring said that for
 * a year and it was the half-truth this codebase keeps finding.
 *
 * `compileRealm` starts from `vm.createContext(Object.create(null))` — a NULL-PROTOTYPE sandbox,
 * and the null prototype is load-bearing rather than tidy. With a plain `{}` the sandbox carries
 * the HOST realm's `Object.prototype`, the global proxy's lookup walks into it, and
 * `globalThis.__proto__.constructor.constructor` is the host `Function`: measured, a published
 * hook body read `typeof process` as `"object"`, called `Date.now()` for a live timestamp, and
 * read a file off `process.getBuiltinModule("node:fs")`. The in-realm control
 * `({}).__proto__.constructor.constructor` returned `"undefined"` in the same run, which is what
 * identified the sandbox object rather than the intrinsics as the door.
 * `test/resources/realm-has-no-clock.test.ts` now carries that route in `CLOCK_PROBE`.
 * A fresh `vm` context already has every
 * ECMAScript intrinsic bound as a global. `safeGlobals` is an OVERLAY on that, not an allow-list:
 * it re-reads these names out of the context and shadows the two below. Everything else V8 puts
 * there is still there. What an embedder's `globals` may and may not do to this set is
 * `refuseGovernedGlobals`, and it is a separate promise from this one. Measured, in the realm a
 * hook body actually runs in:
 *
 *     console  eval  Function  Promise  RegExp  Symbol  Proxy  Reflect  BigInt  Iterator
 *     Map  Set  WeakMap  WeakSet  WeakRef  FinalizationRegistry  ArrayBuffer  SharedArrayBuffer
 *     DataView  Atomics  WebAssembly  every TypedArray  escape  unescape  decodeURI  encodeURI
 *     AggregateError  ReferenceError  SyntaxError  URIError  SuppressedError
 *     DisposableStack  AsyncDisposableStack
 *
 * That is not a hole being confessed — it is assumption A13 stated accurately. A code resource is
 * TRUSTED (authored by whoever authors the graph) and `node:vm` is scoping, not a sandbox; the
 * property this module actually buys is that a body sees THIS CONTEXT'S copies and never a host
 * object. Narrowing the ambient set to this list is a separate change with its own blast radius
 * (`Promise` and `RegExp` are plausibly load-bearing for existing bodies) and belongs in TODO.md,
 * not in a comment that pretends it already happened.
 *
 * WHAT IS CLOSED HERE IS THE CLOCK AND THE DRAW — not, as this line said, "every ambient route to
 * a value replay cannot reproduce". That absolute was false in two places, and a claim that names
 * its members is the only kind anyone can check. The members are `Date`, `Intl` and `Math.random`.
 * TWO AMBIENT ROUTES TO A NON-REPRODUCIBLE VALUE ARE STILL OPEN, and are named here rather than
 * left for the next reader to rediscover:
 *
 *   - THE HOST'S DEFAULT LOCALE. Shadowing the `Intl` binding does not reach the intrinsics behind
 *     `Number.prototype.toLocaleString` and `String.prototype.localeCompare` — the paragraph below
 *     says as much, approvingly, because it is what keeps those methods working. Called with NO
 *     locale argument they read the process's default. Measured in the hook realm, ONE pinned body,
 *     three values of `LC_ALL` on one machine:
 *
 *         en-US   (1234.5).toLocaleString() → "1,234.5"    "ä".localeCompare("z") → -1
 *         de-DE   (1234.5).toLocaleString() → "1.234,5"    "ä".localeCompare("z") → -1
 *         sv-SE   (1234.5).toLocaleString() → "1 234,5"    "ä".localeCompare("z") →  1
 *
 *     Same bytes, three answers. Closing it means removing two prototype methods from every body,
 *     which is the "narrow the ambient set" change with its own blast radius, not a line here.
 *   - GARBAGE COLLECTION. `WeakRef` and `FinalizationRegistry` are ambient (`typeof` is `"function"`
 *     for both, measured in the realm). What `deref()` answers is a fact about the host collector,
 *     not about the body's bytes. Measured, one cached hook body called twice: 500 `WeakRef`s made
 *     in the first call, `{"dead":0,"total":500}` on an immediate second call, and
 *     `{"dead":500,"total":500}` on a second call taken after `--expose-gc` sweeps across job
 *     boundaries. A body that branches on `deref() === undefined` is a body no replay reproduces.
 *
 * `test/resources/realm-has-no-clock.test.ts` pins the locale route as a MEASURED FACT — the realm's
 * no-argument `toLocaleString()` equals the host's, on whatever machine runs the suite — so the
 * absolute cannot come back without something going red. What IS closed, and closed here:
 *
 * `Math` STAYS, because its `random` is REPLACED rather than removed. `functions.ts`'s bridge
 * installs a PRNG seeded from a value the engine journals under `effectKey(taskId, "random", 0)`;
 * `hook-loader.ts`'s `DENY_RANDOM` installs a throwing stub, because a hook has no seed to serve
 * draws from. Either way no body reaches the platform's.
 *
 * `Date` is SHADOWED TO `undefined`, and the reason changed. It used to be "a clock read has no
 * seed that would make it reproducible"; that is no longer true — `ctx.now` is bound to the task's
 * journaled lease timestamp, so a body CAN read a reproducible time. What `Date` would add is a
 * second clock with different semantics: `Date.now()` inside a body would have to be frozen to the
 * same instant to stay replayable, and a frozen `Date` that silently never advances is more
 * surprising than one that is not there. Restoring it means binding the whole constructor to
 * `ctx.now`, which is real work and is recorded in TODO.md rather than half-done here.
 *
 * `Intl` IS SHADOWED FOR THE SAME REASON, and it is the second clock `Date`'s absence was
 * believed to have closed. `Intl.DateTimeFormat.prototype.format` called with NO ARGUMENT
 * defaults to the wall clock, so with `Date` gone a body could still read the time:
 *
 *     new Intl.DateTimeFormat("en-US", {timeZone: "UTC", dateStyle: "full", timeStyle: "full"})
 *       .format()
 *     → "Tuesday, August 25, 2026 at 11:16:07 AM Coordinated Universal Time"
 *
 * measured in the hook realm, through `createHookLoader`, before this line existed — while
 * `run/hooks.ts:89` promised a hook body "No clock and no randomness". `formatToParts()` is the
 * same read one method over, and `resolvedOptions()` leaks the host's time zone and locale, which
 * are ambient environment for the same reason a clock is. Shadowing the namespace closes all
 * three at once. It costs a body `toLocaleString` formatting options and nothing else: the
 * INTRINSICS behind `String.prototype.localeCompare` and `Number.prototype.toLocaleString` are
 * not reached through this binding and still work.
 *
 * SHADOWED TO `undefined`, NOT STUBBED TO THROW, and that is a compromise rather than a
 * preference. `hook-loader.ts`'s `DENY_RANDOM` argues the other way for `Math.random` — a stub
 * that names the capability beats `Cannot read properties of undefined`, which reads like the
 * author's own typo — and the argument is just as good here: what a body actually sees is
 * `Cannot read properties of undefined (reading 'DateTimeFormat')`. What stops it is that
 * `Date`'s treatment is PINNED: `test/resources/functions.test.ts` asserts `typeof Date` is
 * `"undefined"` inside a body. Stubbing `Intl` alone would leave the realm's two clocks refusing
 * in two different shapes, which is worse than either shape consistently. Both or neither, and
 * "both" changes a behaviour a test already holds — so it is written down, not half-done.
 */
const SAFE_GLOBAL_NAMES = [
  "JSON",
  "Math",
  "Number",
  "String",
  "Boolean",
  "Array",
  "Object",
  "Error",
  "TypeError",
  "RangeError",
  "isNaN",
  "isFinite",
  "parseInt",
  "parseFloat",
  "encodeURIComponent",
  "decodeURIComponent",
] as const;

/**
 * The read-back, parsed once. `safeGlobals` runs per REALM now that `compileRealm` builds one per
 * call, and re-parsing a sixteen-name object literal each time was a third of that call's cost.
 */
const READ_INTRINSICS = new vm.Script(`({ ${SAFE_GLOBAL_NAMES.join(", ")} })`, { filename: "loom:safeGlobals" });

function safeGlobals(context: object): Record<string, unknown> {
  const own = READ_INTRINSICS.runInContext(context) as Record<string, unknown>;
  // The two clocks, shadowed together because they ARE one concern — see the docstring. An own
  // data property set to `undefined` beats the context's, so `Date` and `Intl` are genuinely
  // gone from a body's reach rather than merely discouraged.
  return { ...own, Date: undefined, Intl: undefined };
}

/**
 * AN EMBEDDER MAY NOT OVERRIDE A NAME THIS MODULE GOVERNS, and finds out at compile.
 *
 * `compileRealm` used to merge `opts.globals` LAST — `Object.assign(context, safeGlobals(context),
 * opts.globals)` — so a caller-supplied global beat every shadow. Measured on the tree before this
 * function existed, with `createHookLoader({store, globals: {JSON, Date, Intl, Math}})`:
 *
 *     JSON.parse.constructor("return typeof process")()   → "object"     (the HOST realm)
 *     typeof Date  → "function"   Date.now()  → a live wall-clock read
 *     typeof Intl  → "object"     new Intl.DateTimeFormat(…).format()  → the wall clock
 *
 * Two separate promises broken by one line. The `Date`/`Intl` shadows are invariant 4 — a body
 * that reads a second clock is a body no replay reproduces — and invariant 5 says a guard is not
 * something a caller gets to switch off. And the 16 intrinsics are the ESCAPE this module's
 * predecessor shipped, one door over: a HOST `JSON` carries the host `Function` on its
 * `parse.constructor` exactly as a host `Object` did.
 *
 * The governed set is derived, not listed twice: it is whatever `safeGlobals` returns, so adding a
 * name there cannot leave this behind.
 *
 * TWO MECHANISMS, AND THE SECOND ONE HOLDS ALONE. `compileRealm` also assigns the shadows LAST
 * now, which is the order the docstrings always claimed. Measured by deleting this call outright
 * and re-running the probe above:
 *
 *     {"escape":"undefined","typeofDate":"undefined","typeofIntl":"undefined",
 *      "dateNowWorks":false,"intlRead":false}
 *
 * So the refusal is not what closes the hole — the order is. The refusal is what stops an embedder
 * silently getting a realm that ignored half their argument.
 *
 * REFUSED, NOT SILENTLY DROPPED. `createHookLoader` used to `delete globals["Math"]` on its way
 * past, which worked and told the embedder nothing — pass `{Date}` and you get a realm where
 * `Date` is `undefined` with no signal that your argument was ignored. That is the half-truth
 * shape this codebase keeps rediscovering. The blast radius of refusing was measured rather than
 * assumed: nothing under `src/` passes `globals` at all, and the only in-tree caller that does
 * passes `{TENANT: 7}`, which is not governed and still works.
 *
 * ## WHAT IT BUYS, AND WHAT IT PLAINLY DOES NOT — the remediation used to BE the exploit
 *
 * It buys ONE thing: an embedder who passes a governed name finds out at compile, instead of
 * receiving a realm that silently ignored half their argument. It stops accidental clobbering of a
 * shadow. It is a check on NAMES, so that is the whole of what it can buy.
 *
 * The message used to end *"Drop it, or inject it under a name of your own"* — which is advice to
 * do the dangerous thing. Doing exactly that hands the body everything the refusal just took away.
 * Measured, through `createHookLoader`, on the tree as it stands:
 *
 *     globals: {LOOKUP: {a: 1}}   LOOKUP.constructor.constructor("return typeof process")()
 *                                   → "object"                       (the HOST realm)
 *     globals: {MY_DATE: Date}    MY_DATE.now() > 1.7e12  → true      (a live wall clock)
 *     globals: {MY_MATH: Math}    MY_MATH.random() !== MY_MATH.random()  → true, AND a body
 *                                   assigning `MY_MATH.random = function () { return 42; }`
 *                                   left the HOST PROCESS's own `Math.random()` returning 42
 *                                   for every other caller in it
 *
 * A FOURTH MEASUREMENT RULES OUT "just harden the check". This walks `Object.keys`, which yields
 * no SYMBOLS; `Object.assign` copies them regardless. A bag whose only key is
 * `Symbol.for("SMUGGLED")` reports `Object.keys(bag)` → `[]`, is refused nothing, and lands the
 * host `Date` on the realm's `globalThis` where a body reads it as
 * `globalThis[Symbol.for("SMUGGLED")]` — `typeof` `"function"`, and
 * `.constructor.constructor("return typeof process")()` → `"object"`. Widening the check to
 * `Reflect.ownKeys` would close that ONE spelling and change nothing about the three above.
 *
 * The third measurement is the shape of the whole thing: nothing escaped a boundary. The embedder
 * handed the body a host object and the body used it. NO NAME CHECK CLOSES THAT — a pass-me-any-object option
 * IS that seam, and CLAUDE.md is already explicit that `node:vm` is scoping and not a sandbox.
 * The message therefore names the true remediation, which is about the VALUE and not the key:
 * pass a primitive. A plain `{a: 1}` is not a safe middle ground — it is the first measurement
 * above.
 *
 * THE ALTERNATIVE THAT WOULD ACTUALLY CLOSE IT, recorded so it is a decision and not an oversight:
 * rebuild `opts.globals` INSIDE the context from a JSON payload, exactly as `compileRealm`'s call
 * path already rebuilds a body's arguments — "ONLY JSON CROSSES" is this module's own pattern, one
 * seam over. `{TENANT: 7}` and `{LOOKUP: {a: 1}}` would survive it carrying the CONTEXT's
 * intrinsics, and `{MY_DATE: Date}` would stop being expressible at all. Its blast radius was
 * measured, not guessed: nothing under `src/` passes `globals`, and every in-tree caller passes
 * `{TENANT: 7}`. It is not done here because it narrows the value space of a published option from
 * "any value" to "JSON-shaped", which is a contract change that wants its own entry and its own
 * round — not a silent side effect of correcting a sentence. Until it happens, the sentence is the
 * honest one: this refusal guards a namespace, not a body.
 *
 * `internal`, not `validation`, and the same reasoning as the `bridge did not define its entry`
 * check below: a resource author cannot cause this. Only the code that CONSTRUCTED the loader can,
 * so it is a wiring mistake and belongs in the bucket an operator reads as "our bug".
 */
function refuseGovernedGlobals(governed: Record<string, unknown>, globals: RealmOptions["globals"], label: string): void {
  if (globals === undefined) return;
  for (const name of Object.keys(globals)) {
    if (!Object.hasOwn(governed, name)) continue;
    throw err.internal(
      CODES.E_INTERNAL,
      `globals for "${label}" may not include "${name}": the realm supplies its own — the 16 names in ` +
        `SAFE_GLOBAL_NAMES come from the context's own intrinsics, and Date and Intl are shadowed so a body ` +
        `cannot read a clock replay would not reproduce. Yours is a HOST object, and the realm assigns its ` +
        `own over it regardless, so keeping the key would only hide that half your argument was ignored. ` +
        `Remove it. RENAMING IT IS NOT THE FIX and this check cannot make it one: the check reads NAMES, so ` +
        `any object passed under any other name reaches the body whole — a host object carries the host ` +
        `realm on its constructor chain, and a host Date is a live clock. Pass a PRIMITIVE (a tenant id, a ` +
        `flag, a string) if the body needs a value from you.`,
    );
  }
}

/** Invoke a compiled body through its bridge. The payload is serialized; the answer is host-realm. */
export type RealmCall = (payload: unknown) => unknown;

export interface RealmOptions {
  /** The resource's content: a function expression. */
  readonly source: string;
  /** What to call this in an error — a ref or a digest. */
  readonly label: string;
  /** What kind of resource this is, for error text: `function`, `hook`. */
  readonly what: string;
  /**
   * Code defining `globalThis[entry] = function (payloadJson) { … __loomBody(…) }`.
   *
   * It runs INSIDE the context, so everything it builds carries the context's intrinsics —
   * which is the whole mechanism. A bridge that closes over a host value defeats it.
   */
  readonly bridge: string;
  /** The name `bridge` defines. */
  readonly entry: string;
  /**
   * Extra globals for the embedder's own use — a tenant id, a lookup table.
   *
   * NAMES THIS MODULE GOVERNS ARE REFUSED, not merged and not dropped: see
   * `refuseGovernedGlobals`. Whatever survives is assigned BEFORE the shadows, so even if that
   * check were removed the shadows would still win.
   *
   * WHAT SURVIVES IS HANDED TO THE BODY AS-IS, and that is the part an embedder has to read.
   * These values are not rebuilt in the context the way a call payload is: a host object passed
   * here is a host object in the body's hands, and `x.constructor.constructor("return typeof
   * process")()` answers `"object"` through any of them. The refusal above guards this module's
   * NAMES; it does not and cannot vet your VALUES. Pass primitives. See `refuseGovernedGlobals`
   * for the three measurements and for the change that would close it.
   */
  readonly globals?: Readonly<Record<string, unknown>> | undefined;
  readonly compileTimeoutMs: number;
  readonly callTimeoutMs: number;
}

/**
 * The one sentence that says what a code resource FILE has to be, at the one place that finds out
 * it isn't.
 *
 * It lives here, and not in each loader, because both refusals below are reached by
 * `createFunctionLoader` and `createHookLoader` alike — measured: a `module.exports` body in
 * `resources/function/` and the same body in `resources/hook/` produce character-identical text
 * apart from the leading kind. Two copies of this rule in two loaders is exactly how those two
 * files came to disagree about async bodies, and a rule the tool states twice is a rule that
 * eventually states two different things.
 *
 * Before this, the tool relayed V8 and nothing else: `did not evaluate: Unexpected token ';'`.
 * That names the character V8 choked on and never the rule the author broke, and the rule is not
 * guessable from the token — `module.exports`, `export default` and a top-level `const` fail at
 * three different tokens for one reason.
 */
const SHAPE_RULE =
  "a code resource file is a BARE FUNCTION EXPRESSION and nothing else. The loader evaluates " +
  "(<the whole file>), so its value IS the function: (view, ctx) => {…} for a function body, " +
  "(input, ctx) => {…} for a hook body. module.exports, export default and any top-level " +
  "statement are errors before the body ever runs — the file is EVALUATED, not imported";

/**
 * The other rule that belongs at the seam, and was enforced in one loader of two.
 *
 * F36 lived inside `functions.ts`'s `ARGUMENT_BRIDGE` as in-context JavaScript.
 * `hook-loader.ts` contained ZERO occurrences of the word `async`, and both call this function
 * — so the paragraph above, about two copies of one rule eventually stating two different
 * things, had already come true about this one.
 *
 * WHY AN ASYNC BODY CANNOT BE ALLOWED, in the words of the thing that measured it: `vm`'s
 * per-call `timeout` is the only interrupt this platform offers and it covers SYNCHRONOUS
 * execution only. An async body satisfies it by returning at its first `await`, and the
 * continuation resumes on the microtask queue where no timer, no `AbortSignal` and no deadline
 * reach it. Re-measured HERE, through the hook loader, because a rule moved on the strength of
 * an argument made about the other caller is a rule nobody has checked: with
 * `callTimeoutMs: 100` and a body spinning `for (let n = 0; n < 4e9; n++) {}` after an
 * `await 0`, the call returned `{"spun":true}` normally at 1,949 ms; the identical body written
 * synchronously threw `Script execution timed out after 100ms` at 103 ms.
 *
 * THE SECOND HARM IS THIS FILE'S OWN. `intoHostRealm` rebuilds a cross-realm object with the
 * host's intrinsics and passes anything else through untouched — and a cross-realm `Promise` is
 * "anything else", so `await` unwraps it after the rebuild is already behind it. Measured on one
 * hook loader: an async body's resolved object gave
 * `Object.getPrototypeOf(v) === Object.prototype` → `false`, the sync body → `true`. The leak
 * this module exists to close, reopened by the shape it did not refuse.
 *
 * TWO PREDICATES, because each catches a body the other misses, measured across a `vm`
 * boundary: an async function with an own `constructor` property answers `Nope` to
 * `.constructor.name` and `[object AsyncFunction]` to `Object.prototype.toString`; one with an
 * own `Symbol.toStringTag` answers the other way round. NOT A SECURITY CHECK either way — a
 * code resource is A13 trusted and could defeat both. What this catches is the MISTAKE, and the
 * mistake is the whole failure mode.
 *
 * AT LOAD RATHER THAN AT CALL, because the CLI compiles every published body at boot
 * (`cli.ts` `registerFunctions`) — so the message reaches an operator's terminal instead of
 * hanging a run that has already spent money.
 */
/**
 * Is the body an async function — decided WITHOUT READING A PROPERTY OFF IT.
 *
 * The first version asked `value.constructor` and `Object.prototype.toString.call(value)` on
 * the HOST side, after `runInContext` had returned. Both are interceptable: `constructor` is
 * an ordinary property a body may define as a getter, and `toString` consults
 * `Symbol.toStringTag`, which is another. Either one puts USER CODE on the host thread AFTER
 * the vm's `timeout` has stopped applying — measured by this lane's reviewer with a body whose
 * `constructor` getter spins 5e9 times, which the loader waited out. That is the exact hazard
 * `ASYNC_RULE` exists to describe, reintroduced by the check that enforces it.
 *
 * `getPrototypeOf` reads an internal slot. It runs no user code, and an async function's
 * prototype chain is not something a body can rewrite from inside without `Object`, which the
 * realm's own intrinsics govern. The comparison is against the AsyncFunction prototype taken
 * FROM THE SAME CONTEXT — a cross-realm `instanceof` is false, which is the trap the shape
 * check next door already documents.
 */
function isAsyncBody(context: vm.Context, value: unknown): boolean {
  // BOTH async shapes, and the second is not hypothetical: an `async function*` has
  // AsyncGeneratorFunction.prototype, NOT AsyncFunction.prototype, so a check that names only
  // the first lets it through. The predicate this replaced caught it by accident, through
  // `ctor.name.startsWith("Async")` matching two different constructors with one prefix —
  // which is why dropping to one prototype turned two of its tests red.
  //
  // A SYNCHRONOUS generator is deliberately absent. `function*` runs under the vm timeout like
  // any other synchronous body; it is `await` that escapes the deadline, and refusing a shape
  // the rule does not cover would be a refusal with no argument behind it.
  const protos = vm.runInContext(
    "[Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(async function* () {})]",
    context,
  ) as readonly object[];
  const proto: unknown = Object.getPrototypeOf(value);
  return protos.includes(proto as object);
}

const ASYNC_RULE =
  "an async function body cannot be bounded by any deadline. The vm timeout that enforces a " +
  "node's timeoutMs and a hook's callTimeoutMs covers synchronous execution only, so a body " +
  "that awaits keeps running after its caller has given up, with nothing able to stop it — " +
  "measured at callTimeoutMs 100, a body spinning after `await 0` returned at 1,949 ms where " +
  "the same body written synchronously was terminated at 103 ms. What it resolves to also " +
  "reaches the host un-rebuilt, carrying this context's prototypes. Write the body " +
  "synchronously. A body that must wait on something is describing an effect, and effects " +
  "belong on a tool node";

/**
 * THE SECOND SHAPE — and `ASYNC_RULE` did not cover it, which is the residue that docstring left.
 *
 * `ASYNC_RULE` refuses a body DECLARED `async`, decided from its prototype at load. A plain
 * `function () { return new Promise(…) }` is synchronous at the seam: it has the ordinary
 * Function prototype, it loads clean, and it hands back a thenable that `run/hooks.ts` and
 * `Engine.#dispatchBody` both `await`. `functions.ts` caught that second shape when the body
 * RETURNED; `hook-loader.ts` had no equivalent, and `test/resources/async-body-refused-at-the-
 * seam.test.ts` pinned the gap as a fact rather than closing it. Measured through the hook
 * loader at `callTimeoutMs: 100`, before this existed:
 *
 *     (input) => new Promise(res => res({late: true}))
 *       returned [object Promise] in 0 ms; resolved {"late":true};
 *       Object.getPrototypeOf(resolved) === Object.prototype  →  false
 *     (input) => new Promise(res => res(0)).then(() => { for (var n=0;n<4e9;n++){} … })
 *       returned in 0 ms, resolved at 1,948 ms
 *     the identical spin written synchronously
 *       threw `Script execution timed out after 100ms` at 102 ms
 *
 * Both harms `ASYNC_RULE` names, through the shape it does not name.
 *
 * AT THE SEAM, AND `functions.ts`'s COPY IS DELETED rather than joined by a second — the move
 * `ARGUMENT_BRIDGE`'s async check already made, for the reason `SHAPE_RULE` gives: two copies of
 * one rule in two loaders is how those two files came to disagree in the first place.
 *
 * THE TEST RUNS INSIDE THE CONTEXT, and that is the part worth reading twice. `typeof v.then` is
 * a property read, and a body may define `then` as a getter; done host-side, after
 * `runInContext` has returned, that getter is USER CODE ON THE HOST THREAD AFTER THE VM TIMEOUT
 * HAS STOPPED APPLYING — the exact hazard that moved `isAsyncBody` off `.constructor` and onto
 * `getPrototypeOf`, reintroduced by the check enforcing the rule next door. Run as part of the
 * call expression, the read is inside `vm`'s `timeout` and a spinning getter is terminated like
 * any other synchronous work.
 *
 * The refusal crosses back as a THROW gated on `.name`, never `instanceof`: a cross-realm error's
 * prototype is not the host's — the same trap the `SyntaxError` arm below documents.
 *
 * WHAT IT THROWS IS AN OBJECT LITERAL, not `new Error(…)`, and that was measured rather than
 * preferred. `Error` is a binding a body can replace, and the first version of this used it: a
 * body installing `globalThis.Error = function (m) { var e = new RealError(m);
 * Object.defineProperty(e, "name", {value: "Nope", writable: false}); return e; }` and then
 * returning a promise produced a bare `LoomThenableReturn` at the caller — the marker string, no
 * rule, no resource named. Fail-closed (the call still threw, no value crossed) but useless to
 * read. A literal consults no binding a body can reach.
 */
const THENABLE_MARK = "LoomThenableReturn";

const THENABLE_RULE =
  "no deadline can bound one. The vm timeout that enforces a node's timeoutMs and a hook's " +
  "callTimeoutMs covers synchronous execution only, and the body has already satisfied it by " +
  "returning — its continuation is on the microtask queue, where no timer, no AbortSignal and no " +
  "deadline reach it. Measured at callTimeoutMs 100, a body handing back a promise that spins " +
  "4e9 times returned in 0 ms and resolved at 1,948 ms, where the same work written synchronously " +
  "was terminated at 102 ms. What it resolves to is not rebuilt either: await unwraps the promise " +
  "after intoHostRealm is behind it, so a vm-context object reaches the host — measured, " +
  "Object.getPrototypeOf(resolved) === Object.prototype was false. THIS REFUSAL DOES NOT STOP THE " +
  "CONTINUATION and nothing in this process can; what it buys is a named failure and a value that " +
  "never crosses. Return the outcome directly. A body that must wait on something is describing " +
  "an effect, and effects belong on a tool node";

/**
 * A value whose `then` could not even be READ is refused too, under `intoHostRealm`'s rule.
 *
 * `typeof v.then` is not total: on a revoked `Proxy` it raises `TypeError: Cannot perform 'get'
 * on a proxy that has been revoked`, and a hook body returning one is the H4 case exactly.
 * Without this the call still failed — the TypeError propagates — but as a message about proxies,
 * naming no resource and no boundary. Refusing rather than reading on is the same choice
 * `intoHostRealm` makes and for the same reason: the three reads it is about to make throw on
 * this value too.
 *
 * THE RESIDUE THIS ADMITS: a `Proxy` whose `get` trap throws for `then` ALONE would survive the
 * host-side rebuild, and is refused here anyway. That is a guard refusing a value it cannot
 * classify, which is the direction a guard is allowed to be wrong in.
 */
const UNREADABLE_MARK = "LoomUnreadableReturn";

/**
 * Wrap the call expression in the in-context return guard. See `THENABLE_RULE`.
 *
 * `typeof v === "function"` is in the test because `await` unwraps a thenable FUNCTION exactly as
 * it does a thenable object, and a body returning one is the same mistake wearing a different
 * `typeof`.
 *
 * Written as an IIFE around the call rather than as a global helper the bridge installs: a global
 * is a name a body can overwrite between compile and call, and this one is not worth handing a
 * body a switch for. For the same reason it throws an OBJECT LITERAL and not `new Error(…)` —
 * see `THENABLE_RULE` for the body that defeated the `Error` version.
 *
 * ONE LINE, for `seedingRandom`'s reason one file over: `compileRealm` passes `opts.label` as the
 * `filename` of every script it runs here, so a multi-line wrapper puts frames at lines that look
 * like the body's own and are not. The concatenation below is across SOURCE lines; the string it
 * builds carries no newline.
 */
function guardingReturn(callExpr: string): string {
  const thenable = JSON.stringify(THENABLE_MARK);
  const unreadable = JSON.stringify(UNREADABLE_MARK);
  return (
    `(function (v) { if (v === null || (typeof v !== "object" && typeof v !== "function")) return v; ` +
    `var t; try { t = v.then; } catch (e) { var m = "the reason could not be read either"; ` +
    `try { m = String(e.message); } catch (e2) {} throw { name: ${unreadable}, message: m }; } ` +
    `if (typeof t === "function") { throw { name: ${thenable}, message: ${thenable} }; } ` +
    `return v; })(${callExpr})`
  );
}

/** ONE sentence for the shape, said by the in-context read and by the host-side one alike. */
function refuseThenable(where: string): never {
  throw err.validation(CODES.E_RESOURCE_INVALID, `${where} returned a promise, and ${THENABLE_RULE}.`);
}

/**
 * THE IN-CONTEXT READ IS ONE READ, AND A GETTER GETS TO ANSWER IT.
 *
 * Found by attacking the guard above rather than by reading it: a body returning
 * `{get then() { n++; return n > 1 ? function (r) { r(1); } : undefined; }}` answered `undefined`
 * to the guard's read and a FUNCTION to the next one — and the next one is the host's own `await`.
 * Measured before this check existed: that body's value crossed, carrying a callable `then` and
 * `Object.getPrototypeOf(v) === Object.prototype` true. A guard that reads a value the value
 * controls has to be applied to the thing that actually crosses, not to the thing it saw.
 *
 * SAFE TO READ HOST-SIDE, and that is the whole reason it can be a second check rather than a
 * second hazard: `intoHostRealm` copies with `Object.entries`, which INVOKES every getter and
 * stores its result, so a rebuilt object holds data properties only. The prototype test is what
 * confines this to rebuilt values — anything the rebuild passed through untouched still carries
 * its own prototype and is not read here, because reading it is the hazard `THENABLE_RULE`
 * describes.
 *
 * THE PROTOTYPE TEST IS AN INVARIANT OF THE REBUILD, AND THE REBUILD HAD TO EARN IT. It reads as
 * a free fact — `intoHostRealm` builds `out` from a host `{}`, so of course it has the host's
 * `Object.prototype` — and it was not one: `rebuild` copied with `out[k] = …`, and an own
 * enumerable `__proto__` key goes through `Object.prototype.__proto__`'s SETTER and RE-PARENTS
 * `out`. A body that returned one turned this test off and walked past. See `rebuild`, which
 * copies with `Object.defineProperty` for exactly this reason; without that line every sentence
 * above is conditional on the value's good behaviour.
 *
 * ## WHAT IT STILL DOES NOT CATCH — TWO MEMBERS, BOTH MEASURED ON THIS TREE
 *
 * Named because the pair is not a total answer, and enumerated because the previous version of
 * this paragraph named one member and gave it a reassurance that does not survive the second.
 *
 *   1. A body's thenable hidden inside a cross-realm `Map`. The rebuild passes it through, and
 *      the canonicalizer refuses it for being a `Map` at all — measured, `Map is not
 *      representable; use a plain object/array at <root>`. That IS the message worth getting.
 *   2. ANY OTHER PASS-THROUGH VALUE WITH A TWO-FACED `then` GETTER, and this one is not covered
 *      by 1's reassurance. `rebuild` returns a value as-is whenever its prototype's constructor
 *      is not named `Object`, which is every class instance, not just the built-ins. Measured
 *      through the hook loader at `callTimeoutMs: 100`, a body returning `new Thing()` where
 *      `Thing.prototype.then` is a getter answering `undefined` on its first read and a spinning
 *      function on its second:
 *
 *          PASS-THROUGH CROSSED at 1 ms; host proto? false
 *            AWAIT resolved at 1945 ms to {"late":1}
 *
 *      The in-context guard took the first face, this check declined to read at all, and
 *      `runFilters`' own `await h.body(...)` took the second. The canonicalizer does not save it
 *      either — measured, `canonicalize(new Thing())` is `{"a":1}`, not a refusal — and it would
 *      be too late if it did, because the continuation has already outrun the deadline by the
 *      time any value reaches it.
 *
 * MEMBER 2 IS LEFT OPEN DELIBERATELY, and the reason is that no read closes it. Reading `.then`
 * here would run the getter on the host thread — the hazard this check's gate exists to avoid —
 * and would still lose, because a getter that counts simply moves its second face to the `await`.
 * The answers that WOULD close it are refusing every non-plain return outright (which deletes the
 * clear canonicalizer message member 1 depends on) or a process boundary. It is the same
 * unbounded-continuation limit `THENABLE_RULE` and `UNREBUILDABLE_RULE` both end on, and it is
 * A13's to carry: a code resource is trusted, and this catches the value that arrives by mistake.
 */
function crossedAsThenable(v: unknown, where: string): boolean {
  if (v === null || typeof v !== "object") return false;
  try {
    if (Object.getPrototypeOf(v) !== Object.prototype) return false;
    return typeof (v as { then?: unknown }).then === "function";
  } catch (e) {
    // A pass-through value whose prototype trap throws only on a LATER call reaches here. Same
    // rule as the rebuild's: a value the host cannot inspect does not cross.
    refuseUnrebuildable(where, why(e));
  }
}

/**
 * The `name` of a thrown value, costing that value and never this caller.
 *
 * A body chooses what it throws, and a revoked `Proxy` is a legal thing to throw: reading any
 * property off one raises `TypeError: Cannot perform 'get' on a proxy that has been revoked`.
 * A bare `(e as Error).name` here would turn the marker test into a second failure with a
 * message about proxies. Not deciding means "not the marker", which rethrows the body's own
 * error unchanged — the refusing branch, since the call fails either way.
 */
function thrownName(e: unknown): string {
  try {
    const n = (e as { name?: unknown } | null)?.name;
    return typeof n === "string" ? n : "";
  } catch {
    return "";
  }
}

/**
 * ONE REALM PER CALL, compiled once.
 *
 * This built one `vm` context and every call ran in it, and both loaders cache what it returns
 * for the life of the process — so a body's writes to `globalThis`, to an intrinsic's prototype,
 * or to its own definition-time closure survived from one call to the next, across tasks and
 * across RUNS, while the body stayed branded realm-bounded. Measured at 95a3dde through
 * `createFunctionLoader` on `(view, ctx) => { globalThis.__n = (globalThis.__n || 0) + 1; … }`:
 * `{n:1}`, `{n:2}`, then `{n:3}` on a fresh `load` of the same ref, and the hook loader the same.
 * Under `loom serve`, run #2 of that graph journals `{n:2}`; a replay in a fresh process
 * re-executes the body and gets `{n:1}`; and `hermetic` was `true` — the one direction that field
 * may not be wrong in. `HOOK_BRIDGE` had closed this for exactly one name, re-installing
 * `Math.random` per call, and left the namespace open.
 *
 * So a call gets a context of its own: created empty, given its intrinsics back plus the
 * embedder's globals, the body and the bridge evaluated into it, the entry invoked, the context
 * dropped. Nothing a call does to its realm can reach the next call, because the next call's
 * realm does not exist yet. What IS shared is the compiled code — two `vm.Script`s built once
 * here — so the parse still happens once per digest, and the (digest, deadline) cache in
 * `functions.ts` and the per-digest cache in `hook-loader.ts` still bound the number of compiles.
 *
 * WHAT IT COSTS, measured on one machine over 2,000 calls of a trivial body: through the function
 * loader, 0.049 ms per call with the shared context and 0.32–0.36 ms with a realm per call. Broken
 * down on the bare `vm` API, per call: `createContext` 153 µs, reading the intrinsics back and
 * assigning them 4 µs, evaluating the body and bridge scripts 98 µs, the invoke itself 45 µs —
 * against 42 µs for the invoke alone in a shared realm. So a `function` task pays about a quarter
 * of a millisecond more, all of it V8 building a context, against the journal appends the same
 * task already makes. `test/resources/replay-lane-realm-fresh-per-call.test.ts` pins an absolute
 * bound with an order-of-magnitude margin.
 *
 * THE BRAND IS DECIDED ON THE FIRST REALM AND RE-CHECKED ON EVERY ONE. The three properties
 * `onlyGovernedCrossed`'s header names are functions of the source, the bridge and the globals,
 * so a realm that passed at compile passes at every call — unless the body's definition-time code
 * is itself nondeterministic, and then the call is REFUSED rather than run unbranded: a body the
 * replay report has vouched for does not get to become one it has not.
 *
 * WHAT THIS DOES NOT CLOSE: `opts.globals` are host values and are the same objects in every
 * realm, so an embedder that hands a body a mutable object has handed it cross-call state — and
 * a body's DEFINITION-TIME code now runs once at compile and once per call, so a side effect it
 * has on such an object is multiplied rather than removed. That is the hazard
 * `RealmOptions.globals` already names, and such a realm carries no brand.
 */
export function compileRealm(opts: RealmOptions): RealmCall {
  // PARSED ONCE. A body that does not parse fails here, before any realm exists.
  let bodyScript: vm.Script;
  let bridgeScript: vm.Script;
  try {
    // The content IS a function expression — no `module.exports` ceremony, no wrapper to get
    // wrong. It is KEPT IN THE CONTEXT rather than handed back, because the call happens in
    // there too.
    bodyScript = new vm.Script(`globalThis.__loomBody = (${opts.source});`, { filename: opts.label });
    bridgeScript = new vm.Script(opts.bridge, { filename: `${opts.label} (bridge)` });
  } catch (e) {
    throw didNotEvaluate(opts, e);
  }

  /** An empty context and the intrinsics read back out of it, before anything else can be seen. */
  const fresh = (): { context: vm.Context; governed: Record<string, unknown>; pristineRandom: unknown } => {
    // Created EMPTY, then given its own intrinsics back plus whatever the embedder injected.
    // Seeding it with host objects is what opened the bridge the first time.
    const context = vm.createContext(Object.create(null));
    // Read from the PRISTINE context, before anything the embedder sent can be seen by it: this
    // reads the 16 names back out of the context, so assigning `opts.globals` first would make it
    // re-read the embedder's copies and launder them into the "own intrinsics" set.
    const governed = safeGlobals(context);
    // `Math.random` AS THE CONTEXT SHIPPED IT, captured before one line of body or bridge text has
    // run. `shadowsHeld` compares against this identity; taking it later would compare a stub
    // against itself. `governed["Math"]` is the context's own `Math`, so this is a plain read of a
    // pristine object and no user code can be behind it.
    const pristineRandom = (governed["Math"] as { random?: unknown } | undefined)?.random;
    return { context, governed, pristineRandom };
  };

  /**
   * Populate a fresh realm: globals, then body, then bridge. Returns whether only governed names
   * crossed from the host — decided at the one moment the sandbox holds exactly what crossed.
   */
  const populate = (realm: ReturnType<typeof fresh>, timeoutMs: number): boolean => {
    // SHADOWS LAST — the order every docstring here has claimed and none had. This is the line
    // that actually closes the hole; `refuseGovernedGlobals` is what makes ignoring an embedder's
    // argument audible instead of silent. Measured with that call deleted: the escape, `Date` and
    // `Intl` all stay closed. See `refuseGovernedGlobals`.
    Object.assign(realm.context, opts.globals, realm.governed);
    // DERIVED HERE, AT THE ONE MOMENT THE SANDBOX HOLDS EXACTLY WHAT CROSSED FROM THE HOST. See
    // `onlyGovernedCrossed` for what is decided and why it is decided by a check. After this line
    // the body and the bridge run, and both write their own names onto `globalThis` — so a check
    // placed after them would have to whitelist those names and would grow a hole per bridge.
    const namespaceIsOwn = onlyGovernedCrossed(realm.context, realm.governed);
    bodyScript.runInContext(realm.context, { timeout: timeoutMs });
    bridgeScript.runInContext(realm.context, { timeout: timeoutMs });
    return namespaceIsOwn;
  };

  const first = fresh();
  refuseGovernedGlobals(first.governed, opts.globals, opts.label);
  let namespaceIsOwn: boolean;
  let value: unknown;
  try {
    namespaceIsOwn = populate(first, opts.compileTimeoutMs);
    value = (first.context as Record<string, unknown>)["__loomBody"];
  } catch (e) {
    throw didNotEvaluate(opts, e);
  }
  if (typeof value !== "function") {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      // UNCONDITIONAL here: nothing else evaluates to a non-function at this seam. A JSON object
      // in a `.js` body, or a body whose last expression is a config table, arrives here having
      // parsed cleanly, and the only useful thing to say is what the file was supposed to be.
      `${opts.what} resource "${opts.label}" evaluated to ${typeof value}, not a function — ${SHAPE_RULE}`,
    );
  }
  // ONE RULE, BOTH LOADERS. See `ASYNC_RULE`. Checked here rather than in each bridge because
  // `functions.ts` had it and `hook-loader.ts` did not, which is the SHAPE_RULE argument three
  // paragraphs up playing out on a second rule.
  if (isAsyncBody(first.context, value)) {
    throw err.validation(CODES.E_RESOURCE_INVALID, `${opts.what} resource "${opts.label}": ${ASYNC_RULE}.`);
  }
  if (typeof (first.context as Record<string, unknown>)[opts.entry] !== "function") {
    // A bridge that did not define its entry would fail later as `__loomInvoke is not
    // defined`, from inside a run, attributed to the body rather than to the bridge.
    throw err.internal(CODES.E_INTERNAL, `bridge for "${opts.label}" did not define ${opts.entry}`);
  }
  // THE BRAND IS DECIDED FROM A CHECK, ON THE REALM THAT ACTUALLY EXISTS. The three properties it
  // vouches for are named in `onlyGovernedCrossed`'s header: that function decided the second one
  // above, and `shadowsHeld` decides the first and third here. See `REALM_BOUND` for what
  // membership means and `isRealmBounded` for how it is read.
  const branded = namespaceIsOwn && shadowsHeld(first.context, first.governed, first.pristineRandom);

  const where = `${opts.what} resource "${opts.label}"`;
  const call: RealmCall = (payload) => {
    // A REALM OF ITS OWN, built the way the first one was. Its definition-time code is bounded by
    // the compile deadline, as it was at compile; the call itself by the call deadline below.
    const realm = fresh();
    const own = populate(realm, opts.compileTimeoutMs);
    if (branded && !(own && shadowsHeld(realm.context, realm.governed, realm.pristineRandom))) {
      // The compile-time realm passed and this one did not, so the body's definition-time code
      // did something on this call it did not do then. Refused rather than run: the brand on
      // `call` is what `ReplayReport.hermetic` rests on, and it cannot be revoked per call.
      throw err.validation(
        CODES.E_RESOURCE_INVALID,
        `${where} no longer passes the realm's determinism checks at call time — its definition-time code ` +
          `did something on this call that it did not do when it was compiled and branded, so the call is refused ` +
          `rather than run unvouched-for`,
      );
    }
    // ONLY JSON CROSSES *HERE*. Every value this call hands the body is rebuilt from this string
    // INSIDE the context, so no host object reaches it BY THIS ROUTE. `opts.globals` is the route
    // that is not this one, and it is not rebuilt — see `RealmOptions.globals`.
    let out: unknown;
    try {
      // WRAPPED, not read afterwards: the return guard is part of the expression `timeout`
      // bounds. See `THENABLE_RULE`.
      out = vm.runInContext(guardingReturn(`${opts.entry}(${JSON.stringify(JSON.stringify(payload))})`), realm.context, {
        timeout: opts.callTimeoutMs,
        filename: opts.label,
      });
    } catch (e) {
      const mark = thrownName(e);
      if (mark === THENABLE_MARK) refuseThenable(where);
      // Same sentence `intoHostRealm` says, because it is the same rule — the value simply
      // failed the FIRST read instead of one of the three that come after it.
      if (mark === UNREADABLE_MARK) refuseUnrebuildable(where, why(e));
      throw e;
    }
    const host = intoHostRealm(out, where);
    // AND THE SAME TEST ON THE VALUE THAT ACTUALLY CROSSES. See `crossedAsThenable`: the
    // in-context read is one read, and a `then` GETTER gets to answer it differently than it
    // answers the host's.
    if (crossedAsThenable(host, where)) refuseThenable(where);
    return host;
  };
  // THE ONLY PLACE THE BRAND IS APPLIED, AND IT IS APPLIED FROM A CHECK.
  if (branded) REALM_BOUND.add(call);
  return call;
}

/**
 * The refusal for a body that did not evaluate — at parse, or while its definition-time code ran.
 *
 * GATED ON `.name`, NEVER `instanceof`. A parse failure is the host's `SyntaxError` now that the
 * scripts are built with `vm.Script`, but a body that fails while EVALUATING throws from inside the
 * context, whose intrinsics are not the host's — so `e instanceof SyntaxError` was measured `false`
 * for both `module.exports = …;` and `export default …` when evaluation and parse were one step.
 * The obvious form would compile, pass review, and silently never fire, which is worse than not
 * adding the sentence.
 *
 * Gated at all, because this also catches errors the body itself raised while evaluating. A body
 * that throws on line 1 is not a shape mistake and must not be told it is one. The residual:
 * `module.exports = f` with no trailing semicolon parses and fails as a ReferenceError, `module is
 * not defined` — the same mistake, and it does NOT get this sentence. Widening the gate to name
 * that case is a separate judgement; it is recorded here rather than guessed at.
 */
function didNotEvaluate(opts: RealmOptions, e: unknown): Error {
  return err.validation(
    CODES.E_RESOURCE_INVALID,
    `${opts.what} resource "${opts.label}" did not evaluate: ${(e as Error).message}` +
      ((e as Error).name === "SyntaxError" ? ` — ${SHAPE_RULE}` : ""),
  );
}

/**
 * WHAT THE BRAND VOUCHES FOR — the named set, and the reason it is three CHECKS and not a branch.
 *
 * `isRealmBounded` feeds `ReplayReport.hermetic`, so the sentence behind it has to be one a
 * reader can hold against the realm: **this body ran under the determinism boundary, so
 * re-executing it produces what it produced before.** Three properties make that true, and each
 * one is measured on the realm rather than assumed from the code path that built it:
 *
 *   1. THE TWO CLOCKS ARE GONE. `Date` and `Intl` are own data properties whose value is
 *      `undefined` — still, at the end of compile, not merely at the moment `safeGlobals` set
 *      them. A body is an EXPRESSION and may run code at definition time, so
 *      `(function () { globalThis.Date = hostishThing; return f; })()` is a legal resource that
 *      un-shadows a clock for every later call. `shadowsHeld` reads the slot afterwards.
 *   2. NOTHING OF THE HOST'S IS IN THE NAMESPACE. Every own key the sandbox object carries when
 *      the assign finishes is a name `safeGlobals` produced, holding the exact value it
 *      produced. `onlyGovernedCrossed` decides it.
 *   3. THE DRAW IS NOT THE PLATFORM'S. `Math.random` is an own data property of the context's
 *      `Math` and is no longer the function the context shipped — which is what
 *      `functions.ts`'s `seedingRandom` and `hook-loader.ts`'s `denyingRandom` each splice in
 *      ahead of the body.
 *
 * DERIVED FROM A CHECK RATHER THAN FROM THE CODE PATH, and that is the whole correction. The
 * stamp used to be `opts.globals === undefined || Object.keys(opts.globals).length === 0` — a
 * test on the ARGUMENT, which is a proxy for the realm and not the realm. `Object.keys` yields
 * no symbols while `Object.assign` copies them, so a bag whose only key is `Symbol("MY_DATE")`
 * holding the host `Date` reported length `0`, landed on the realm's `globalThis`, AND KEPT THE
 * BRAND. Measured, through `compileRealm`, before this change:
 *
 *     Object.keys(globals).length      → 0
 *     isRealmBounded(call)             → true      ← the brand
 *     body: Object.getOwnPropertySymbols(globalThis)  → ["Symbol(MY_DATE)"]
 *           D.now() > 1.7e12                       → true      (a live wall clock)
 *           D.constructor.constructor("return typeof process")()  → "object"  (the HOST realm)
 *
 * `hermetic: true` on a run that is not reproducible, which is the one direction this field may
 * not be wrong in. Widening the old line to `Reflect.ownKeys` would have closed that ONE
 * spelling and left `{Promise: hostPromise}` — an ungoverned name, so `refuseGovernedGlobals`
 * allows it, and it overwrites the context's own `Promise` with the host's — and it would still
 * be a test on the argument, so the next global to arrive by some other route would inherit the
 * stamp for free. A check on the realm does not have that shape: **anything a future edit puts
 * into that namespace costs the brand automatically**, because the check enumerates what is
 * there instead of predicting it.
 *
 * WHAT IT STILL DOES NOT VOUCH FOR is unchanged and is named at `REALM_BOUND`: the host's
 * default locale and garbage collection are ambient inside the realm and are pinned as PASSING
 * tests in `test/resources/realm-has-no-clock.test.ts`.
 *
 * EVERY UNDECIDABLE CASE IS `false`. Both helpers run inside a `try` and answer `false` on a
 * throw: a `Proxy` `globals` bag whose `ownKeys` trap raises, a `Math` replaced by something
 * whose descriptor read fails. A guard that cannot decide refuses.
 */
function onlyGovernedCrossed(context: object, governed: Record<string, unknown>): boolean {
  try {
    // `vm.createContext(Object.create(null))` leaves the SANDBOX OBJECT empty — measured, `Reflect.ownKeys` of a
    // fresh one is `[]` while the context's own `globalThis` has 67 own keys — so every key here
    // is one the host PUT there, and this loop needs no allow-list of intrinsics to subtract.
    // `Reflect.ownKeys` and not `Object.keys`: it is the symbol half that carried the escape.
    for (const key of Reflect.ownKeys(context)) {
      if (typeof key !== "string" || !Object.hasOwn(governed, key)) return false;
      const d = Object.getOwnPropertyDescriptor(context, key);
      // `"value" in d` first: an ACCESSOR slot has no `value` and `Object.is(undefined, undefined)`
      // would pass a getter off as the `undefined` shadow.
      if (d === undefined || !("value" in d) || !Object.is(d.value, governed[key])) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Properties 1 and 3 of the boundary `onlyGovernedCrossed` names, read off the finished realm.
 *
 * DESCRIPTORS AND NEVER A PLAIN READ. `context.Date` would invoke a getter the body installed on
 * `globalThis` at definition time — user code, on the host thread, outside the `vm` timeout that
 * bounds everything else here. That is the hazard `crossedAsThenable` refuses to take for the
 * same reason, and a descriptor read takes none of it.
 *
 * THE ONE INPUT THAT STILL GETS THE BRAND, named because "is not the platform's" is a weaker
 * question than "is reproducible" and this is the gap between them. A body that WRAPS the
 * platform draw rather than replacing it installs a different function object, so check 3
 * passes. Measured, through `compileRealm` with no `seedingRandom` wrapper:
 *
 *     (function () { var real = Math.random;
 *                    Math.random = function () { return real(); };
 *                    return ((a, b) => ({ n: Math.random() })); })()
 *     branded = true   two calls -> {"n":0.5502795925972663} {"n":0.24002067160838125}
 *
 * IT IS NOT REACHABLE ON EITHER PRODUCT PATH, which is why the answer here is a name and not a
 * fourth check. `functions.ts`'s `seedingRandom` and `hook-loader.ts`'s `denyingRandom` splice
 * their assignment in as the wrapper's FIRST statement, ahead of any resource text, so a body
 * loaded from a `ResourceStore` never observes the platform `random` to capture it — that is
 * `DENY_UNSEEDED`'s own measured claim and the reason it exists. What is exposed is a direct
 * `compileRealm` caller who supplies neither wrapper, and such a caller has already lost the
 * brand on check 3 unless it replaces the draw with something of its own. Closing it properly
 * means the realm OWNING the seeded PRNG instead of trusting each bridge to install one, which
 * moves a contract and wants its own round.
 */
function shadowsHeld(context: object, governed: Record<string, unknown>, pristineRandom: unknown): boolean {
  try {
    for (const name of ["Date", "Intl"]) {
      const d = Object.getOwnPropertyDescriptor(context, name);
      if (d === undefined || !("value" in d) || d.value !== undefined) return false;
    }
    const math = Object.getOwnPropertyDescriptor(context, "Math");
    if (math === undefined || !("value" in math) || !Object.is(math.value, governed["Math"])) return false;
    const draw = Object.getOwnPropertyDescriptor(math.value as object, "random");
    // `pristineRandom` is `undefined` only if the context shipped no `Math.random`, which no
    // ECMAScript realm does; comparing against it anyway keeps the failure closed rather than
    // making `undefined === undefined` vouch for a `Math` with no draw at all.
    if (draw === undefined || !("value" in draw)) return false;
    return draw.value !== undefined && !Object.is(draw.value, pristineRandom);
  } catch {
    return false;
  }
}

/**
 * THE BRAND, AND WHY IT IS A `WeakSet` RATHER THAN A SYMBOL PROPERTY.
 *
 * `ReplayReport.hermetic` used to be a claim nothing could falsify on a graph of `function`
 * nodes: its two terms are indexed by effect key, and a `function` or `evaluator{assertion}`
 * body computes none, so no input made the field false while the bodies RE-EXECUTED LIVE. The
 * fix is not to journal a body's output — that would put a `function` member in the kernel's
 * forever-vocabulary in order to re-open a fail-open this project already paid to close, and
 * re-execution is the only thing that catches a body regression at all. The fix is to stop
 * claiming more than the runtime can vouch for, and this set is what it can vouch for: that a
 * body came out of `compileRealm` and the realm it came out of PASSED THE THREE CHECKS
 * `onlyGovernedCrossed`'s header names — no host value in its namespace, both clocks still
 * shadowed, the platform draw replaced — so its inputs are a JSON payload and its globals are
 * this context's own.
 *
 * A REGISTRY SYMBOL WOULD BE FORGEABLE, WHICH IS THE WHOLE POINT. `Symbol.for(k)` is reachable
 * by any code in the process holding the same string — `engine.ts`'s `REBIND_DEADLINE` is
 * `Symbol.for("@loom/core:function.rebindDeadline")` and is spelled out in two files — so an
 * embedder could stamp it on a host closure and the spoof would land on the PASSING side of the
 * flag.
 *
 * AND A MODULE-PRIVATE `Symbol()` IS FORGEABLE TOO, WHICH IS THE PART THAT HAD TO BE MEASURED
 * RATHER THAN REASONED. The obvious fix is `const REALM_BOUND = Symbol()` closed inside this
 * module, stamped with `Object.defineProperty(call, REALM_BOUND, …)`, on the argument that
 * "nothing outside this file can name it, so nothing outside this file can claim it". That
 * argument is FALSE, and the thing that makes it false is that a symbol used as a property key
 * is no longer private — the object carries it, and any holder of the object can read it back.
 * Measured against that spelling, three ways, all `true` where `false` was the whole point:
 *
 *     branded call            -> true
 *     own symbols on the call -> 1 [Symbol()]
 *     FORGED host closure     -> true      Object.getOwnPropertySymbols(branded), copied over
 *     FORGED via Reflect      -> true      Reflect.ownKeys(branded), same route
 *     FORGED via prototype    -> true      setPrototypeOf(closure, branded) — `in` walks the chain
 *
 * A `WeakSet` writes NOTHING onto the object, so there is nothing to enumerate and nothing to
 * copy, and `has` consults no prototype chain. Membership is a fact held in this module's own
 * closure about an identity, not a mark travelling on the value. It is also the reason there is
 * no exported adder: the only way into the set is to have been RETURNED BY `compileRealm`, so
 * possession of one branded call buys nothing that could be transferred to another object.
 * That difference is the difference between a brand and a hint, and a hint is not something a
 * replay report may rest a hermeticity claim on.
 *
 * The cost, stated: a `WeakSet` keyed on the call means a body's brand dies with the body, which
 * is correct — and it means `isRealmBounded` cannot answer for a body serialized and revived,
 * which nothing does and which would be a different claim anyway.
 *
 * WHAT THE BRAND DOES NOT MEAN, named because the field it feeds is exactly the kind that gets
 * read as total. A branded body is realm-bounded; it is not proven deterministic. Two ambient
 * routes to a value replay cannot reproduce are still open inside the realm and are pinned as
 * PASSING tests in `test/resources/realm-has-no-clock.test.ts` — `THE HOST'S DEFAULT LOCALE IS
 * AMBIENT` and `GARBAGE COLLECTION IS OBSERVABLE`. A THIRD ROUTE WAS OPEN AND UNNAMED, and it was
 * inside the runtime's own control: one context served every call, so a body's globals carried
 * its previous calls' state across tasks and runs. `compileRealm` builds a realm per call now, and
 * `test/resources/replay-lane-realm-fresh-per-call.test.ts` pins it. So `hermetic: true` with this conjunct means
 * "no body ran that the runtime could not vouch for", not "nothing nondeterministic happened".
 * The direction is what makes it progress rather than motion: the old inaccuracy over-claimed,
 * this one under-claims, and an under-claiming guard is the only kind that is safe to be wrong.
 */
const REALM_BOUND = new WeakSet<object>();

/**
 * Did this body come out of a `compileRealm` realm that passed the determinism checks?
 *
 * The three are named in `onlyGovernedCrossed`'s header. Note what this is NOT: "compiled by
 * `compileRealm`". A realm is compiled and then MEASURED, and one that ends up holding a host
 * value, an un-shadowed clock, or the platform's `Math.random` gets no brand.
 *
 * FALSE IS THE ANSWER FOR EVERYTHING THIS MODULE DID NOT MAKE, and that is the fail-closed
 * direction: a hand-registered host closure, a body from a realm carrying `opts.globals` that
 * reached the namespace, a plain object, `undefined`. Absence of evidence is reported as
 * unvouched-for, never as bounded, so nothing a caller can pass makes this answer `true` by
 * accident.
 *
 * NO `try` HERE, and its absence is the point rather than an omission: `WeakSet.prototype.has`
 * runs no user code. It does not read a property, does not invoke a getter, does not consult a
 * `has` trap, and does not walk a prototype chain — so unlike every other guard in this file it
 * has no undecidable case to fail closed on. A hostile `Proxy` gets `false` because it is not in
 * the set, which is the same answer for the same reason as every other stranger.
 */
export function isRealmBounded(fn: unknown): boolean {
  return typeof fn === "function" && REALM_BOUND.has(fn);
}

/**
 * Carry an existing brand onto a wrapper. **It cannot mint one**, and that is the whole design.
 *
 * A loader does not hand the engine the `RealmCall` this module branded — it hands back a
 * closure wrapping it, to translate a vm timeout into `E_TASK_TIMEOUT` and to build the payload.
 * So `isRealmBounded` was `true` on the realm call and `false` on the thing the engine actually
 * invokes, and every function body read as unvouched-for. That is the fail-closed direction and
 * therefore survivable, but it makes the answer useless: a term that is false for everything
 * distinguishes nothing.
 *
 * `from` must ALREADY be in the set. There is no argument to this function that adds a value to
 * `REALM_BOUND` on its own, so the only way in is still `compileRealm` deciding it, and a
 * wrapper is bounded exactly when the thing it wraps is. `REALM_BOUND` stays module-private and
 * the brand stays unforgeable — the property `hermetic` rests on, since a body that could brand
 * itself could vouch for itself.
 *
 * Returns `to` so it reads as a pass-through at the call site.
 */
export function carryRealmBrand<T>(from: unknown, to: T): T {
  if (typeof from === "function" && REALM_BOUND.has(from) && typeof to === "function") {
    REALM_BOUND.add(to as unknown as object);
  }
  return to;
}

/**
 * `intoHostRealm` — rebuild a value using the HOST's intrinsics, or refuse it. This block is the
 * argument for both halves; the machinery follows it.
 *
 * Recursive and structural: primitives pass through, arrays and plain objects are rebuilt, and
 * anything else (a function, a class instance, a cross-realm `Map`) is returned as-is so the
 * canonicalizer can reject it with its own clear message rather than this function silently
 * mangling it into `{}`.
 *
 * An object literal inside a `vm` context is built from THAT context's intrinsics, so
 * `{writes: {…}}` coming back has a different `Object.prototype` than anything in the host. It
 * looks identical, passes `typeof`, and fails `deepStrictEqual` — and any downstream prototype
 * check would quietly disagree with itself depending on whether a body was loaded or
 * hand-registered.
 *
 * ## AND IT IS WHERE AN EXTENSION'S VALUE ENTERS THE HOST, so it is where a value that cannot be
 * inspected has to be refused
 *
 * Every read this rebuild makes runs on the HOST thread, on an object an extension chose. Three
 * of them are not total, and none of the three was guarded — measured end to end on this tree,
 * a hook body and a function body each returning `Proxy.revocable({a:1},{}).proxy` after
 * revoking it:
 *
 *     TypeError: Cannot perform 'IsArray' on a proxy that has been revoked
 *
 * out of `Array.isArray`, and `Object.getPrototypeOf` and `Object.entries` throw on the same
 * value one line later. **`run/delivery.ts` and `telemetry/spans.ts` each carry a private guard
 * for exactly this — `isArrayValue` and `isList` — and `redact.ts` does NOT, which this sentence
 * claimed for months and `TODO.md` §A.19 copied.** Measured 2026-09-02: a grep for either name
 * over `security/redact.ts` returns nothing, and its four `Array.isArray` sites are ordinary. Two
 * files, named, rather than three asserted. A self-referential return is the same class through a
 * different door: `{o.self = o}` from a hook body exhausted the stack, measured,
 * `RangeError: Maximum call stack size exceeded`. Neither reached a caller as anything naming
 * the resource that produced it.
 *
 * ONE `try` AROUND THE WHOLE WALK, rather than a guarded copy of each read. It is not the cheaper
 * spelling of the same thing — it is a different claim, and the stronger one: any throw from any
 * read, present or added later, becomes the same refusal. Guarding `Array.isArray` alone would
 * have left `getPrototypeOf` and `entries` to be found separately, which is how this class gets
 * rediscovered.
 *
 * REFUSING, NOT DEGRADING, and that is the choice `run/delivery.ts` makes the other way on
 * purpose. There, a value that cannot be read is being RENDERED for a channel and "(unrenderable)"
 * is a true thing to print. Here the value is on its way to the canonicalizer and the journal;
 * passing it through means the same throw further downstream with nothing left naming the
 * resource. A guard that cannot decide what a value is refuses it.
 *
 * WHAT IT DOES NOT CLOSE, named rather than implied: a trap or getter that SPINS instead of
 * throwing. `Object.entries` on a `Proxy` whose `ownKeys` never returns is user code on the host
 * thread with the vm's timeout already satisfied, and no `try` reaches it. That is the same
 * unbounded-continuation limit `THENABLE_RULE` states, and like it, only a process boundary
 * (`sandbox/subprocess.ts`) closes it. Code resources are A13 trusted; what this catches is the
 * value that arrives by mistake or by a third party's proxy, not an author attacking their own run.
 */
const UNREBUILDABLE_RULE =
  "a value the host cannot inspect cannot cross this boundary. Rebuilding a return calls " +
  "Array.isArray, Object.getPrototypeOf and Object.entries on it, and all three throw on a " +
  "revoked Proxy, while a value that refers to itself exhausts the stack. Returning it anyway " +
  "would raise the same failure further downstream with nothing left to name the resource that " +
  "produced it. Return plain JSON-shaped data";

/** Why the rebuild could not finish, costing that value and never this caller. */
function why(e: unknown): string {
  try {
    const m = (e as { message?: unknown } | null)?.message;
    return typeof m === "string" ? m : "the reason could not be read either";
  } catch {
    return "the reason could not be read either";
  }
}

/** ONE sentence for the whole class, said by the rebuild and by the seam's first read alike. */
function refuseUnrebuildable(at: string, detail: string): never {
  throw err.validation(
    CODES.E_RESOURCE_INVALID,
    `${at} returned a value the host cannot rebuild: ${UNREBUILDABLE_RULE} — ${detail}.`,
  );
}

/**
 * `at` names the resource in the refusal — `compileRealm` passes `hook resource "hook/x@stable"`.
 * It has a default because this is exported and an embedder calling it directly has no ref to
 * give; what it must never be is absent from the message, which is what the raw `TypeError` was.
 */
export function intoHostRealm(value: unknown, at = "a code resource"): unknown {
  try {
    return rebuild(value);
  } catch (e) {
    refuseUnrebuildable(at, why(e));
  }
}

/** The walk itself. Every throw out of it is `intoHostRealm`'s refusal — see its docstring. */
function rebuild(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // `Array.from`, NOT `.map`: `map` goes through ArraySpeciesCreate, which uses the ARRAY'S OWN
  // constructor — so mapping a cross-realm array produces another cross-realm array and the
  // rebuild silently does nothing.
  if (Array.isArray(value)) return Array.from(value, rebuild);
  const proto = Object.getPrototypeOf(value) as unknown;
  // A plain object in ANY realm has either the null prototype or one whose own constructor is
  // named "Object" — which is what distinguishes it from a Map.
  const isPlain = proto === null || (proto as { constructor?: { name?: string } })?.constructor?.name === "Object";
  if (!isPlain) return value;
  const out: Record<string, unknown> = {};
  // `Object.defineProperty`, NOT `out[k] = …`, and the key that forces it is `__proto__`.
  //
  // Assignment goes through the ordinary [[Set]], which walks the prototype chain and finds
  // `Object.prototype.__proto__`'s ACCESSOR. So `out["__proto__"] = v` does not create a
  // property at all — it RE-PARENTS `out` to whatever the body chose. Measured, a hook body
  // returning `Object.defineProperty(o, "__proto__", {value: proto, enumerable: true, …})`
  // with `proto = {then: <spins 4e9 then resolves>}`, at `callTimeoutMs: 100`:
  //
  //     P6 CROSSED at 2 ms; host proto? false | typeof then: function
  //     P6 AWAIT resolved at 1950 ms to {"late":1} | host proto? false
  //
  // Both harms `THENABLE_RULE` names: the continuation outran the deadline by 19x, and a
  // vm-realm object reached the host. It defeated BOTH reads that are supposed to stop it —
  // the in-context guard saw an `o` whose own `then` is absent, and `crossedAsThenable` skipped
  // the result because the invariant it gates on, `getPrototypeOf(out) === Object.prototype`,
  // is exactly what the assignment had just broken. `defineProperty` never consults the
  // prototype chain, so the key lands as an own data property and the invariant holds.
  //
  // A REGRESSION, not an unclosed residue, and worth saying so: the host-side thenable check
  // 347cb98 replaced was UNGATED — it read `out.then` on whatever `intoHostRealm` returned, so
  // it caught this. Same body through the function loader, both trees: `OLD (347cb98^) REFUSED
  // at 1 ms`, `NEW CROSSED at 0 ms`. Narrowing a total check to a gated one is only safe when
  // the gate cannot be turned off by the value being gated, and this one could.
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    Object.defineProperty(out, k, { value: rebuild(v), writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/**
 * A code resource's content is either the source string itself or `{source}`.
 *
 * Both because the store's content is canonical JSON: a bare string round-trips fine, and an
 * object leaves room for metadata later without a migration.
 */
export function sourceOf(content: unknown, label: string, what: string): string {
  if (typeof content === "string") return content;
  if (content !== null && typeof content === "object") {
    const s = (content as { source?: unknown }).source;
    if (typeof s === "string") return s;
  }
  throw err.validation(
    CODES.E_RESOURCE_INVALID,
    `${what} resource "${label}" has no source: expected a string or {source: string}`,
  );
}
