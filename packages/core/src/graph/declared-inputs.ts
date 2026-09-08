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
 * `spec.inputs` is NOT capped: it comes from the graph the deployment published, not from the
 * caller, so its length is the graph author's own choice and a truncated declared set would
 * withhold the one thing the caller needs to fix the request.
 */
const MAX_NAMED = 8;

/**
 * HOW MUCH OF ONE KEY IS RENDERED. Capping the COUNT is not capping the LENGTH, and the second
 * was measured missing — this function against `{"a".repeat(900_000): 1}`, with and without the
 * clip:
 *
 *     WITHOUT clip: one 900,000-char key → message 900486 chars
 *     WITH    clip: one 900,000-char key → message    607 chars
 *
 * `server/http.ts`'s own `truncate` states the rule that was being broken one file over — "a
 * caller-supplied string on its way into a message. Bounded, because a header is not" — and 120
 * is its number, taken rather than invented so the two bounds are one bound.
 */
const MAX_KEY_CHARS = 120;

const clip = (k: string): string => (k.length <= MAX_KEY_CHARS ? k : `${k.slice(0, MAX_KEY_CHARS)}…`);

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
  const declared = spec.inputs ?? [];
  return Object.keys(inputs).filter((k) => !declared.includes(k));
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
  const undeclared = undeclaredInputs(spec, inputs);
  if (undeclared.length === 0) return undefined;
  const declared = spec.inputs ?? [];
  const near = (k: string): string => {
    const head = k.toLowerCase().slice(0, 2);
    const guesses = declared.filter((d) => d.toLowerCase().startsWith(head) && d !== k);
    return guesses.length === 0 ? "" : ` (did you mean ${guesses.map((g) => `"${g}"`).join(" or ")}?)`;
  };
  const shown = undeclared.slice(0, MAX_NAMED);
  const rest = undeclared.length - shown.length;
  return (
    `${subject} names ${undeclared.length === 1 ? "a channel" : "channels"} this graph does not declare as an input: ` +
    `${shown.map((k) => `"${clip(k)}"${near(k)}`).join(", ")}${rest === 0 ? "" : ` and ${rest} more`}. ` +
    `It declares ${declared.length === 0 ? "no inputs at all" : declared.map((d) => `"${d}"`).join(", ")}. ` +
    `Nothing was submitted. Correct the spelling, or — if a node is meant to read the channel — add it to ` +
    `the graph's inputs:, which is what GRAPH005_UNPRODUCED_READ already says at compile time. Seeding a ` +
    `channel the graph does not declare leaves it in the journal unread, and the run fails four layers ` +
    `below the mistake, after it has been submitted and, against a real provider, after it has spent.`
  );
}
