/**
 * WHY THIS FILE EXISTS: one rule, two doors, and they disagreed.
 *
 * A submission names channels; the graph declares which channels are inputs. Since `8c734ce`
 * `loom run --input '{"documnet":…}'` refuses that mismatch before the submit — and `POST /runs`
 * did not, for the reason that commit stated in its own docstring: "widening a wire contract is
 * not what a typo in an argv is evidence for." `TODO.md` §A0.17 is the evidence that was missing.
 * Measured on the binary built at `c54b0c2`, against `examples/graphs/fan-out-join.json`
 * (`"inputs": ["document"]`):
 *
 *     {"workflow":"fan-out-join","inputs":{"documnet":"a b"}}
 *       → 202, a durable run, then "status":"failed" with
 *         E_INTERNAL: E_CHANNEL_UNDECLARED: channel "document" is not in this node's declared
 *         reads — naming a channel the caller never typed, classing a caller's typo as a bug in
 *         Loom, and against a real provider SPENDING before the missing binding is found.
 *     {"workflow":"fan-out-join","inputs":{"document":"a b","notes":"extra"}}
 *       → 202, "status":"succeeded", and `notes` is a run channel forever: durable on
 *         `run.submitted`, read by nothing, rendered `[secret]` in every projection.
 *
 * TWO DOORS ONTO ONE ENGINE THAT DISAGREE ABOUT WHAT A LEGAL SUBMISSION IS is the defect, so the
 * fix is not a second copy of the rule — a copy is what drifts, and drift is what this row IS.
 * The rule lives here and both doors call it.
 *
 * IT RETURNS A MESSAGE AND THROWS NOTHING, because the two callers must not share an error class.
 * The CLI's caller is an operator at a keyboard and its refusal is configuration —
 * `E_CONFIG_INVALID`. The plane's caller is a program and its refusal is a bad request —
 * `E_PROVIDER_BAD_REQUEST`. What makes that a 400 is the CLASS and not the code:
 * `httpStatusFor` is `switch (readOwn(e, "class"))` and its own header says "class-driven, never
 * code-driven", so it is `err.validation` that decides the status, and the same code raised
 * through `err.policy` would be a 403. `undefined` means "nothing to say", so a caller that
 * forgets to throw is a caller that reads a value it never uses, rather than one that silently
 * loosens.
 *
 * IT IS NOT EXPORTED FROM `index.ts`. `scripts/check-surface.mjs` pins that name set; nothing
 * outside this package needs this function, and a shared internal is not a surface.
 *
 * IT LIVES IN `graph/` because `graph/spec.ts` is what defines `inputs`, and the whole of the rule
 * is a read of `spec.inputs`. It takes the `GraphSpec` rather than the `RunGraph` for the same
 * reason: the compiled envelope — hash, resources, capabilities — has no part in this question.
 */

import type { GraphSpec } from "./spec.ts";

/**
 * HOW MANY UNDECLARED KEYS THE MESSAGE NAMES BEFORE IT COUNTS THE REST.
 *
 * The CLI's caller typed the keys into argv and there are a handful. The plane's caller is a
 * program and the key set is CALLER-CONTROLLED — measured without this cap, a body of 500 keys
 * produced a 500-name error string, which is an amplification the request itself paid nothing
 * for. Eight is enough to show the operator a typo and its neighbours; past that the problem is
 * not which key, it is the shape of the request.
 *
 * It is NOT the whole bound. `MAX_NAMED` is also the MULTIPLIER on everything each named key
 * pulls in, which is what made the first version's "bounded in both dimensions" claim false —
 * see `MAX_GUESSES`.
 */
const MAX_NAMED = 8;

/**
 * HOW MUCH OF ONE KEY IS RENDERED. Capping the COUNT is not capping the LENGTH, and the second
 * was measured missing — this function against `{"a".repeat(900_000): 1}`, with and without the
 * clip:
 *
 *     WITHOUT clip: one 900,000-char key → message 900560 chars
 *     WITH    clip: one 900,000-char key → message    681 chars
 *
 * `server/http.ts`'s own `truncate` states the rule that was being broken one file over — "a
 * caller-supplied string on its way into a message. Bounded, because a header is not" — and 120
 * is its number, taken rather than invented so the two bounds are one bound.
 */
const MAX_KEY_CHARS = 120;

/**
 * HOW MANY NEAR-MISSES ONE KEY MAY PULL IN, AND HOW MUCH OF THE DECLARED SET IS PRINTED.
 *
 * THE FIRST VERSION OF THIS FILE CLAIMED THE MESSAGE WAS "BOUNDED IN BOTH DIMENSIONS" AND IT WAS
 * NOT, because `near` re-ran the declared list per named key and appended every prefix match
 * unbounded — so the real size was `MAX_NAMED × |declared|`, and `MAX_NAMED` is exactly the
 * multiplier a caller controls. Driven on that version:
 *
 *        589 chars  1 declared, 1 bad key                     (the baseline)
 *       4168 chars  40 declared, 8 caller keys with head "ch"
 *      19443 chars  2000 declared, 1 key "zz" (no guesses at all)
 *     202748 chars  2000 declared, 8 caller keys with head "so"   ← from a ~200-byte request
 *      42344 chars  2000 declared, the EMPTY key
 *
 * The empty key is the sharpest form and it was reachable: `"".slice(0, 2)` is `""`, and
 * `d.startsWith("")` is true of everything, so `{"": 1}` alone guessed the WHOLE declared set.
 * `near` now declines to guess below two characters — a two-character heuristic on a
 * zero- or one-character key is not a suggestion, it is the list again — and names at most three.
 *
 * AND THE DECLARED SET IS CAPPED AFTER ALL, which reverses this file's first argument. That
 * argument was "it comes from the graph the deployment published, not from the caller, so a
 * truncated declared set would withhold the one thing the caller needs". The first half is true
 * and the conclusion does not follow: a message that must be bounded cannot carry an unbounded
 * component, whoever chose its size, and the 19,443-char row above is that component with the
 * caller contributing two bytes. Twenty-four names is past any graph in this repository — the
 * largest declares five — so the truncation is unreachable in practice and the bound is real.
 */
const MAX_GUESSES = 3;
const MAX_DECLARED = 24;

/**
 * Neutralises the C0 control range, DEL and the C1 range, one replacement character per control
 * byte — replaced rather than dropped so the reader can see that something was there.
 * `\u007f-\u009f` (DEL through C1) is in the sweep for the same reason C0 is: a TERMINAL reads
 * that range too, not only C0.
 *
 * SHARED WITH `server/http.ts`'s `truncate`, which sanitised this same range via its own copy of
 * the literal until now — `TODO.md` A.39. Both bound a caller-supplied string on its way into an
 * operator-facing message: an ESC-bracket sequence forges color and cursor movement, CR/LF forges
 * a second log line, a raw NUL truncates whatever reads it next. It lives HERE rather than in
 * `server/http.ts` because `server/http.ts` already imports from `graph/` (`undeclaredInputsMessage`);
 * the reverse edge would put an HTTP-plane import inside graph code, the wrong direction.
 *
 * A fresh `RegExp` literal per call, not a shared module-level one: a `g`-flagged regex is
 * stateful (`lastIndex`), and while a `test`-then-`replace` pair happens to leave it reset by the
 * time the call returns, a shared instance is one future edit away from being read mid-scan.
 */
export function stripControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex -- the C0 range, DEL and the C1 range ARE the thing being matched
  const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
  return CONTROL.test(s) ? s.replace(CONTROL, "\ufffd") : s;
}

/**
 * A caller-supplied key on its way into a message: length-bounded and control-character-free.
 *
 * THE CONTROL-CHARACTER HALF IS FOR THE CLI DOOR. On the wire the key is JSON-escaped and inert,
 * but the same shared string is written to a TERMINAL by `loom run`, where a key containing
 * `[31m` or a newline rewrites the operator's screen. `server/http.ts`'s `truncate` — the
 * function whose 120 this borrows — now shares `stripControlChars` with this function, so the
 * two bounds and the one sanitising range are all one thing instead of three.
 *
 * THE SLICE IS OVER UTF-16 UNITS, so a key whose 120th and 121st units are a surrogate PAIR loses
 * its low half. That is left alone deliberately: the bound holds at 121 units, `JSON.stringify`
 * escapes the lone surrogate so the response stays well-formed JSON, and the cost is one
 * replacement glyph in a message about a key the caller mistyped.
 */
const clip = (k: string): string => {
  const cut = k.length <= MAX_KEY_CHARS ? k : `${k.slice(0, MAX_KEY_CHARS)}…`;
  return stripControlChars(cut);
};

/** `did you mean …?`, or nothing. Bounded by `MAX_GUESSES`, and silent below two characters. */
function near(declared: readonly string[], k: string): string {
  if (k.length < 2) return "";
  const head = k.toLowerCase().slice(0, 2);
  const guesses: string[] = [];
  for (const d of declared) {
    if (d !== k && d.toLowerCase().startsWith(head)) guesses.push(d);
    if (guesses.length === MAX_GUESSES) break;
  }
  return guesses.length === 0 ? "" : ` (did you mean ${guesses.map((g) => `"${clip(g)}"`).join(" or ")}?)`;
}

/**
 * The keys of `inputs` that `spec` does not declare as inputs, in the order they were given.
 *
 * `Object.keys` and not `for…in`: own enumerable keys only, so a `__proto__` or a `constructor`
 * on the request body is compared as the ordinary string it is rather than reaching a prototype.
 * A key that IS declared is legal whatever it is named — the declared set is the authority here,
 * and `state/channels.ts` is where a hostile channel NAME is answered.
 *
 * NOT EXPORTED. It is the better primitive of the two and a caller wanting structured error
 * `details` should reach for it — but nothing needs it today, and an export with no importer is
 * surface nobody asked for.
 */
function undeclaredInputs(spec: GraphSpec, inputs: Readonly<Record<string, unknown>>): string[] {
  // A SET, NOT `Array.includes`, and the difference is measurable rather than stylistic. The body
  // cap is 1 MiB (`server/http.ts`), which buys a caller roughly 150,000 keys, and the linear scan
  // made this `keys × declared`: 100,000 keys against 5,000 declared inputs blocked the event loop
  // for 439 ms in one request. The whole array is still built, because `and N more` has to count
  // what it is not naming — a filter that stopped at `MAX_NAMED` would have to say "some".
  const declared = new Set(spec.inputs);
  return Object.keys(inputs).filter((k) => !declared.has(k));
}

/**
 * The refusal to print, or `undefined` when every key is declared.
 *
 * `subject` is the noun for whatever named the keys — `"--input"` at the CLI, `` `"inputs"` `` on
 * the wire — because the sentence has to tell the caller where to go and edit, and the two callers
 * are editing different things.
 *
 * THE DECLARED SET IS ALWAYS PRINTED, not only the near-miss guess: the guess is a
 * same-first-two-letters heuristic, so it catches `documnet` and misses a wrong name that is not a
 * transposition, and a caller who was never going to guess needs the list rather than a shrug.
 *
 * THE TAIL NAMES THE COMPILER'S OWN FIX, and it used to name something false. It read "…the run
 * then fails four layers below the mistake, HAVING ALREADY BEEN SUBMITTED and — against a real
 * provider — already spent", which describes what the refusal PREVENTED as though it had happened:
 * on a 400 that sends a caller looking for a run id that does not exist. Worse, its first clause
 * ("a channel nothing reads") is not true of every refused key. Measured on the base tree, a
 * skeleton graph with a `hint` channel declared, written by nobody and READ by its first node:
 *
 *     compile ok = true   diagnostics = ["warning:GRAPH005_UNPRODUCED_READ"]
 *     submit {paths, hint} → status = awaiting_gate | hint channel = "read me"
 *
 * That graph compiles, that key IS read, and this rule refuses it — so the tail must state the
 * fix rather than a false diagnosis. It names GRAPH005_UNPRODUCED_READ and gives that
 * diagnostic's own remedy in a sentence rather than word for word; the `fix` field itself reads
 * ``add "${r}" to inputs:, or have an upstream node write it`` (`graph/validate.ts`). So this
 * rule is that warning, enforced at the door instead of printed and scrolled past, and the
 * refusal points at the place the author was already told.
 *
 * AND IT SAYS THE DIAGNOSTIC IS A WARNING, because a behaviour check reading the message as an
 * operator caught the version that did not. `loom compile` on a graph whose node reads an
 * undeclared channel prints
 * `! g005-probe.json: GRAPH005_UNPRODUCED_READ: node "plan" reads "notes", …` and then `ok`,
 * **exit 0** — so "which is what GRAPH005_UNPRODUCED_READ already says at compile time", printed
 * beside a hard 400, told the operator the compiler had stopped them when it had not.
 *
 * THE FAILURE-AND-SPEND CLAUSE IS SCOPED, for the same reason and by the same reader. It used to
 * assert, of every refused key, that the run "fails four layers below the mistake, after it has
 * been submitted and … after it has spent". That is true of the TYPO — `{"documnet":…}` really did
 * reach `E_INTERNAL: E_CHANNEL_UNDECLARED` — and FALSE of the EXTRA key, which at `c54b0c2`
 * answered 202 and SUCCEEDED at $0. One sentence covering both cannot assert either
 * unconditionally, so the half that holds for every refused key — the value does nothing — is
 * unconditional, and the half that holds only when the caller meant a channel the graph needs is
 * introduced by "where". An operator who checks a refusal's claim and finds it false stops reading
 * refusals, which is a worse outcome than saying less.
 *
 * `clip` GUARDS ONLY THE LENGTH, and on a key whose 120th and 121st UTF-16 units are a surrogate
 * PAIR the slice leaves a lone high surrogate. That is deliberate rather than unnoticed: the
 * bound still holds at 121 units, `JSON.stringify` escapes a lone surrogate to `\udXXX` so the
 * response body stays well-formed JSON, and the character renders as one replacement glyph. A
 * code-point-aware slice would buy a nicer glyph in a message about a key the caller mistyped.
 */
export function undeclaredInputsMessage(
  subject: string,
  spec: GraphSpec,
  inputs: Readonly<Record<string, unknown>>,
): string | undefined {
  const declared = spec.inputs;
  const undeclared = undeclaredInputs(spec, inputs);
  if (undeclared.length === 0) return undefined;
  const shown = undeclared.slice(0, MAX_NAMED);
  const rest = undeclared.length - shown.length;
  const namedDeclared = declared.slice(0, MAX_DECLARED);
  const restDeclared = declared.length - namedDeclared.length;
  return (
    `${subject} names ${undeclared.length === 1 ? "a channel" : "channels"} this graph does not declare as an input: ` +
    `${shown.map((k) => `"${clip(k)}"${near(declared, k)}`).join(", ")}${rest === 0 ? "" : ` and ${rest} more`}. ` +
    `It declares ${declared.length === 0 ? "no inputs at all" : namedDeclared.map((d) => `"${clip(d)}"`).join(", ")}` +
    `${restDeclared === 0 ? "" : ` and ${restDeclared} more`}. ` +
    `Nothing was submitted. Correct the spelling, or — if a node is meant to read this channel — add it ` +
    `to the graph's "inputs" list, which is what GRAPH005_UNPRODUCED_READ warns about at compile time ` +
    `without refusing.`
  );
}
