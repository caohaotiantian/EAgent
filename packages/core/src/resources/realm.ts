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
 * `compileRealm` starts from `vm.createContext({})`, and a fresh `vm` context already has every
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

function safeGlobals(context: object): Record<string, unknown> {
  const own = vm.runInContext(`({ ${SAFE_GLOBAL_NAMES.join(", ")} })`, context) as Record<string, unknown>;
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

export function compileRealm(opts: RealmOptions): RealmCall {
  // Created EMPTY, then given its own intrinsics back plus whatever the embedder injected.
  // Seeding it with host objects is what opened the bridge the first time.
  const context = vm.createContext({});
  // Read from the PRISTINE context, before anything the embedder sent can be seen by it: this
  // reads the 16 names back out of the context, so assigning `opts.globals` first would make it
  // re-read the embedder's copies and launder them into the "own intrinsics" set.
  const governed = safeGlobals(context);
  refuseGovernedGlobals(governed, opts.globals, opts.label);
  // SHADOWS LAST — the order every docstring here has claimed and none had. This is the line that
  // actually closes the hole; `refuseGovernedGlobals` above is what makes ignoring an embedder's
  // argument audible instead of silent. Measured with that call deleted: the escape, `Date` and
  // `Intl` all stay closed. See `refuseGovernedGlobals`.
  Object.assign(context, opts.globals, governed);
  let value: unknown;
  try {
    // The content IS a function expression — no `module.exports` ceremony, no wrapper to get
    // wrong. It is KEPT IN THE CONTEXT rather than handed back, because the call happens in
    // there too.
    vm.runInContext(`globalThis.__loomBody = (${opts.source});`, context, {
      timeout: opts.compileTimeoutMs,
      filename: opts.label,
    });
    vm.runInContext(opts.bridge, context, {
      timeout: opts.compileTimeoutMs,
      filename: `${opts.label} (bridge)`,
    });
    value = (context as Record<string, unknown>)["__loomBody"];
  } catch (e) {
    throw err.validation(
      CODES.E_RESOURCE_INVALID,
      `${opts.what} resource "${opts.label}" did not evaluate: ${(e as Error).message}` +
        // GATED ON `.name`, NEVER `instanceof`. The error is constructed by the VM CONTEXT'S
        // SyntaxError, whose prototype is not the host's, so `e instanceof SyntaxError` is FALSE
        // for both `module.exports = …;` and `export default …` — measured, both spellings, both
        // false, both `name === "SyntaxError"`. The obvious form would compile, pass review, and
        // silently never fire, which is worse than not adding the sentence.
        //
        // Gated at all, because this arm also catches errors the body itself raised while
        // evaluating. A body that throws on line 1 is not a shape mistake and must not be told it
        // is one. The residual: `module.exports = f` with no trailing semicolon parses and fails
        // as a ReferenceError, `module is not defined` — the same mistake, and it does NOT get
        // this sentence. Widening the gate to name that case is a separate judgement; it is
        // recorded here rather than guessed at.
        ((e as Error).name === "SyntaxError" ? ` — ${SHAPE_RULE}` : ""),
    );
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
  if (isAsyncBody(context, value)) {
    throw err.validation(CODES.E_RESOURCE_INVALID, `${opts.what} resource "${opts.label}": ${ASYNC_RULE}.`);
  }
  if (typeof (context as Record<string, unknown>)[opts.entry] !== "function") {
    // A bridge that did not define its entry would fail later as `__loomInvoke is not
    // defined`, from inside a run, attributed to the body rather than to the bridge.
    throw err.internal(CODES.E_INTERNAL, `bridge for "${opts.label}" did not define ${opts.entry}`);
  }

  return (payload) => {
    // ONLY JSON CROSSES *HERE*. Every value this call hands the body is rebuilt from this string
    // INSIDE the context, so no host object reaches it BY THIS ROUTE. `opts.globals` is the route
    // that is not this one, and it is not rebuilt — see `RealmOptions.globals`.
    const out = vm.runInContext(`${opts.entry}(${JSON.stringify(JSON.stringify(payload))})`, context, {
      timeout: opts.callTimeoutMs,
      filename: opts.label,
    });
    return intoHostRealm(out);
  };
}

/**
 * Rebuild a value using the HOST's intrinsics.
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
 */
export function intoHostRealm(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  // `Array.from`, NOT `.map`: `map` goes through ArraySpeciesCreate, which uses the ARRAY'S OWN
  // constructor — so mapping a cross-realm array produces another cross-realm array and the
  // rebuild silently does nothing.
  if (Array.isArray(value)) return Array.from(value, intoHostRealm);
  const proto = Object.getPrototypeOf(value) as unknown;
  // A plain object in ANY realm has either the null prototype or one whose own constructor is
  // named "Object" — which is what distinguishes it from a Map.
  const isPlain = proto === null || (proto as { constructor?: { name?: string } })?.constructor?.name === "Object";
  if (!isPlain) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = intoHostRealm(v);
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
