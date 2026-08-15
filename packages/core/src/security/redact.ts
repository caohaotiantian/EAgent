/**
 * Redaction at emit time, and secrets that cannot be interpolated by accident.
 *
 * Two mechanisms, in order of how much they are trusted:
 *
 *   1. **Declared classification.** Channels and tool schema fields carry a
 *      `Classification`, so most redaction is a lookup, not a guess. This is the
 *      primary mechanism and the only one that is reliable.
 *
 *   2. **A detector sweep** over unclassified free text. This is a BACKSTOP for model
 *      output and it WILL have false negatives — which is exactly why secrets are
 *      never plain strings in the first place (see `SecretValue`).
 *
 * The ordering matters: a design that leads with detection is a design that has
 * already accepted leaks.
 *
 * NOTE ON PURPOSE. This exists to stop a credential or a personal detail in MODEL
 * OUTPUT from reaching a span or a browser. It is not an erasure mechanism and the
 * journal is never redacted — `state.reduced` payloads ARE the channel state, so a
 * redacted journal folds to corrupted state.
 *
 * WHICH BOUNDARY IS THIS APPLIED AT? THE **READ** ONE, EVERYWHERE — SAID HERE BECAUSE THE
 * ANSWER WAS EVERYWHERE ASSUMED AND NOWHERE WRITTEN, AND THE TWO ANSWERS HAVE OPPOSITE
 * FAILURE MODES. Every live caller redacts on the way OUT of the process: `server/http.ts`'s
 * `frame` on the event stream and its `summarise` on a projection's `channels` and
 * `outputs`, `telemetry/spans.ts`'s `close` on the three span bags, `GateDispatcher.deliver`
 * on a gate rendering. The journal underneath them all holds the real value, deliberately
 * (D9.6). So the design is: **one durable copy of the truth, and every reader is trusted to
 * redact.** Nothing in this module is called on the way IN.
 *
 * AND "EVERY READER IS TRUSTED TO REDACT" IS A PREMISE, NOT A GUARANTEE — the enumeration
 * above is what a `grep` finds, and the interesting entries are the reads it does NOT
 * contain. `summarise` sweeps `channels` and `outputs` and hands `error` and each task's
 * `error` straight on, two lines below; an `ErrorRecord` is a `message` and a `details`
 * this module has never seen. That is the cost of the read-boundary design stated exactly:
 * adding a reader is adding a redaction obligation, and forgetting one is silent.
 *
 * THAT CHOICE IS RIGHT FOR A CLASSIFIED VALUE AND WRONG FOR FOREIGN TEXT, WHICH IS THE
 * WHOLE OF WHAT THIS PARAGRAPH IS FOR. A payload carries its `Classification` with it, so a
 * reader added in three years still knows what it is holding and can redact it — the
 * decision is recoverable, and keeping the value is what makes an authenticated operator's
 * view and a channel's view two renderings of one fact instead of two facts. A string
 * SOMEBODY ELSE WROTE carries nothing. Once
 * `Request cannot be constructed from a URL that includes credentials: https://svc:pw@host`
 * is in `LoomError.message`, `errorRecord` has copied it into an append-only file, and from
 * that moment: it is indistinguishable from ordinary diagnostics, no classification marks
 * it, it is in every backup and every `journal.db` an operator can `sqlite3`, and no later
 * fix removes it. Read-boundary redaction defends the readers this repo currently has; it
 * defends nothing against the next one, and it never defends the store.
 *
 * **SO: A VALUE THIS DEPLOYMENT CONFIGURED, QUOTED BACK BY A STRING THIS PROCESS DID NOT
 * AUTHOR, MUST BE MASKED WHERE THE STRING IS BUILT — NOT WHERE IT IS READ.** `maskLiterals`
 * is that mechanism when the literal is in hand, and `url-credentials` in `DETECTORS` is it
 * when the credential is recognisable by POSITION rather than by value. Both are mechanism 1;
 * neither is a guess. The write-boundary sites, named so the next reader does not have to
 * find them: `providers/http.ts`'s `normalizeTransport` (an `Error.message` from undici or
 * from an injected `FetchLike`) and its `normalizeError` (`details.detail`, which is 500
 * bytes of the provider's own response body), and `run/delivery.ts`'s `describeFailure`
 * (a channel's failure text), which is the one of the three that already does it.
 *
 * **AND THE RESIDUAL, MEASURED RATHER THAN INFERRED, because a fix believed is a fix
 * unmade.** `normalizeTransport` masks userinfo on the arm that wraps a native error and
 * returns early on `isLoomError(e)` — an arm added for a sibling defect, which routes around
 * the redaction it was added beside. Same input, two roads, one process:
 *
 *     normalizeTransport(new TypeError(msg))        ⇒ "…: https://[redacted]@api.example.com/…"
 *     normalizeTransport(err.unavailable(CODE, msg)) ⇒ "…: https://svc:hunter2@api.example.com/…"
 *
 * — the second is what `errorRecord` writes. That file is not this one's to edit; what this
 * one owes it is a single mechanism to call, which is now here, and the READ boundaries are
 * closed either way: with the detector in the sweep, the same credential is masked out of
 * every span, every SSE frame and every gate delivery, including the ones already sitting in
 * journals written before this change.
 *
 * ONE CALLER ASKS MORE OF IT THAN THE REST, and that is worth knowing before editing
 * `walk`. Spans and the SSE stream redact on the way out of a process an operator
 * already trusts; `DeliverySpec.redact` (see `run/delivery.ts`) uses this to decide what
 * a THIRD PARTY may see, which a graph author declares by name and is entitled to
 * believe. So a classification arm that returns the value for some input is not a
 * conservative default there — it is the leak. `pii` covering only strings was exactly
 * that, for three waves.
 *
 * THAT CALLER ALSO CHANGED WHAT THE TOKEN HAS TO WITHSTAND, which is the point of
 * `piiToken`'s docstring and the reason to read it before touching the format. An
 * embedder tokenising its own free text is protecting a value it chose; a graph author
 * writing `redact: ["employeeId"]` is protecting whatever the workflow happens to carry,
 * and the leaves that names in practice — a number, a boolean, an epoch, an amount, a
 * postcode — have domains you can enumerate in milliseconds.
 *
 * AND IT CHANGED WHO THE TOKEN HAS TO WITHSTAND, which is a different question and the one
 * a key ANSWERS ONLY IF ITS SCOPE MATCHES ITS EXPOSURE. Keying `piiToken` closed the offline
 * brute force and opened a chosen-plaintext oracle in its place: one key for the whole
 * process meant anyone who could get values of their own choosing tokenised in it — submit a
 * graph whose payload carries them, read the tokens their own gate delivery produces — held
 * a lookup table that inverted every OTHER run's tokens, at the same low-entropy leaves that
 * motivated the key. `opts.scope` is that fix, and the rule it encodes is the one to apply
 * to the next transform of this shape: **the key's scope must be no wider than the audience
 * of what it produces.** See `tokenKey`.
 *
 * AND THEN A THIRD CALLER ASKED A QUESTION NEITHER OF THOSE ANSWERS: FOR HOW LONG? A key
 * minted per process satisfies both rules above and still breaks `telemetry/spans.ts`, whose
 * contract is that a trace is a PURE FUNCTION OF THE JOURNAL — so the same run folded in two
 * workers, or folded again a year later, must produce the same bytes. Process randomness
 * cannot do that, and no amount of scoping makes it. So the second rule has a twin:
 * **the key's LIFETIME must be no shorter than the correlation window its caller promises.**
 * Delivery promises correlation within one run and one process; a trace promises it forever.
 * `LOOM_PII_TOKEN_KEY` — a deployment secret, read from the environment, never journaled —
 * is what makes "forever" available, and `redactAttributes` omits a `pii` attribute outright
 * when it is unset rather than emitting a token nobody can reproduce. See `deploymentKey`.
 *
 * ONE WALK, TWO MODES, AND THE SECOND ONE IS WHY THIS FILE OWNS THE TRAVERSAL. `redact`
 * hides everything at the classification it is given; `redact(v, c, {only})` hides only
 * the named fields and leaves their neighbours legible, which is what a gate delivery
 * needs (D7.3: "a human cannot approve what they cannot see"). `run/delivery.ts` used to
 * carry its OWN walk for that, and the two disagreed about depth, about cycles and about
 * a function-valued property — the redactor of all places being the one with the
 * recursion bug. Delegating is what keeps them from disagreeing again.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.6.
 */

import { createHmac, randomBytes } from "node:crypto";

import { CLASSIFICATION_POSTURE_FLOOR, type Classification } from "../vocab.ts";

/**
 * A secret that cannot be stringified.
 *
 * `toString`, `toJSON`, template interpolation, and `util.inspect` all yield
 * `[secret]`. So an accidental `` `Bearer ${token}` `` produces `Bearer [secret]` — a
 * broken request, which someone notices — rather than a leaked credential in a
 * journal payload, which nobody notices.
 */
export class SecretValue {
  readonly #value: string;
  readonly ref: string;

  constructor(value: string, ref: string) {
    this.#value = value;
    this.ref = ref;
  }

  /** The ONLY way to read it. Named so it is greppable in review. */
  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return "[secret]";
  }
  toJSON(): string {
    return "[secret]";
  }
  get [Symbol.toStringTag](): string {
    return "SecretValue";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SecretValue(${this.ref})`;
  }
}

export function isSecret(v: unknown): v is SecretValue {
  return v instanceof SecretValue;
}

// ---------------------------------------------------------------------------
// Detectors — the backstop, not the plan
// ---------------------------------------------------------------------------

interface Detector {
  readonly name: string;
  readonly pattern: RegExp;
  /**
   * What the match becomes, when `[redacted:<name>]` would throw away the readable half.
   *
   * Every other entry matches a value ENTIRELY, so replacing the whole match loses
   * nothing but the secret. `url-credentials` matches a value in POSITION — the scheme
   * and the `@` that delimit it are part of the match and are not secret — so a fixed
   * replacement would turn `https://svc:pw@api.example.com` into
   * `[redacted:url-credentials]api.example.com`: the credential gone, and with it the
   * two facts an operator debugs a transport failure with.
   */
  readonly replace?: string;
}

/**
 * Deliberately conservative and few.
 *
 * A long list of clever patterns produces false positives, which train people to
 * ignore redaction; these are shapes that are essentially never legitimate content.
 */
const DETECTORS: readonly Detector[] = [
  { name: "pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "provider-key", pattern: /\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "bearer", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/g },
  /**
   * `scheme://userinfo@host` — the one place a URL is allowed to carry a secret, and THE
   * ONE ENTRY ON THIS LIST THAT IS NOT A GUESS.
   *
   * The list above is mechanism 2: patterns that resemble a secret, with false negatives
   * this file apologises for in its opening paragraph. This one is mechanism 1 wearing
   * mechanism 2's clothes — userinfo is a GRAMMATICAL POSITION in RFC 3986, not a shape,
   * so there is nothing to tune and nothing to miss about what a match means. It lives
   * here anyway because `sweep` is the TRAVERSAL that already reaches every string in
   * every payload, span attribute, event attribute and gate delivery in the codebase, and
   * a structural fact with no way to reach those is a structural fact nobody applies. The
   * sweep is the plumbing; it is not the epistemology.
   *
   * IT WAS A PRIVATE COPY IN `providers/http.ts` FIRST, which is why it is here now.
   * `run/delivery.ts` carried its own walk for `DeliverySpec.redact` until the two
   * disagreed about depth, cycles and function-valued properties, and the fix was to
   * delegate to this file rather than to keep them in step by hand. A credential redaction
   * that exists in one caller is the same arrangement one wave earlier: measured, the
   * identical string came out of `normalizeTransport`'s non-LoomError arm masked and out of
   * its `isLoomError` arm verbatim, and out of a `loom.gate` span verbatim, because only
   * one of the three roads had the copy.
   *
   * THE RUN STOPS AT THE AUTHORITY, so a path that merely contains an address
   * (`/v1/mail/a@b.example`) and a bare `mailto:` are both left alone — `[^/?#\s]*` cannot
   * cross the `/` that ends the authority, nor a second `@`. That restraint is not
   * politeness: a redactor that shreds ordinary diagnostics is one an operator turns off.
   *
   * LAST IN THE LIST, and the order is load-bearing for exactly one observable. A provider
   * key sitting in userinfo position is masked to the same bytes either way, but running
   * this entry FIRST replaces the token before `provider-key` can see it — so `hits` loses
   * the "a live provider key was in this string" alert while the output is unchanged. Named
   * by what it IS, then masked by where it SAT.
   */
  { name: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]{0,31}):\/\/[^/?#\s]*@/gi, replace: "$1://[redacted]@" },
];

export interface RedactionResult {
  readonly value: unknown;
  /**
   * What the walk had to act on, sorted and deduplicated.
   *
   * A DETECTOR name here means the DECLARED path missed something, which is a signal
   * worth alerting on rather than merely a redaction. The structural names —
   * `secret-value`, `secretish-key`, `secret-classified`, `cycle`, `unserializable` —
   * say the walk met a shape rather than guessed at one.
   *
   * `url-credentials` IS ON BOTH SIDES OF THAT LINE, which is why it is worth naming here.
   * It arrives through `DETECTORS`, so it reads as "the declared path missed something" —
   * true, and it is also a structural match rather than a guess, so unlike its neighbours it
   * has no false negatives to discount. Alert on it the way you would alert on
   * `secretish-key`: a credential was in free text somebody is about to read, and the
   * question is which WRITE boundary let it in. See the WHICH BOUNDARY note above.
   */
  readonly hits: readonly string[];
}

/**
 * Redact a value for emission.
 *
 * `pii` becomes a stable token — `pii:<12>:<type>` — so two occurrences of the same
 * value still correlate across a trace without the value being present. Correlation
 * without disclosure is what makes a redacted trace debuggable at all.
 *
 * `opts.only` narrows WHICH FIELDS are hidden: with it, the classification applies to
 * values reached through one of the named keys (at any depth, and to everything below
 * such a key) and every other leaf takes the legible path — the detector sweep for a
 * string, itself for anything else. Without it, the classification applies to the whole
 * value, which is what a span attribute and a journal payload want.
 *
 * `opts.scope` names the CORRELATION DOMAIN of the tokens: two `pii` leaves tokenise
 * identically exactly when they were redacted under the same scope, and a token says
 * nothing about a value tokenised under a different one. It is not a secret and it is not
 * a salt an attacker must not learn — in this codebase it is a run id — and its whole job
 * is to answer "who else's tokens is this comparable with?". Absent, the scope is THIS
 * PROCESS; see
 * `tokenKey` for when that is the right answer and when it is the defect.
 *
 * A `SecretValue` and a secret-ish KEY are hidden in both modes and at every depth: they
 * are facts about the value, not about what the caller asked to hide.
 *
 * BOTH OPTIONS FAIL CLOSED WHEN THEY ARE PRESENT AND UNUSABLE, and `hits` says which —
 * `unusable-only`, `unusable-scope`. Neither is a throw; see the comments in the body for
 * the caller that makes a throw here expensive.
 */
export function redact(
  value: unknown,
  classification: Classification = "internal",
  opts: { readonly only?: readonly string[]; readonly scope?: string } = {},
): RedactionResult {
  const hits: string[] = [];
  // A NON-ARRAY `only` HIDES EVERYTHING, and the STRING case is why this is not a
  // formality: `new Set("ssn")` is `{"s", "n"}`, so an untyped caller writing
  // `redactFields(payload, "ssn", "pii", runId)` hid two fields nobody named and left the
  // ssn itself in the clear, on the one path whose reader is a third party. "Present but
  // unusable" therefore reads as "no field list at all", which is the whole-value
  // classification — the hiding direction — rather than a list that matches nothing.
  const only = opts.only === undefined ? undefined : Array.isArray(opts.only) ? new Set<string>(opts.only) : undefined;
  if (opts.only !== undefined && only === undefined) hits.push("unusable-only");
  // DERIVED ONCE PER CALL AND ONLY IF A `pii` LEAF IS ACTUALLY MET. Lazily, so that
  // importing this module and redacting a span attribute cost no entropy and no HMAC; once,
  // so that a thousand-leaf payload derives one key rather than a thousand.
  //
  // A NON-STRING SCOPE IS NOT NO SCOPE. This read `typeof opts.scope === "string" ?
  // opts.scope : undefined`, and `undefined` is the PROCESS-WIDE domain — the exact
  // shared-key oracle `opts.scope` exists to close, reached through a type hole instead of a
  // design one and reached silently. It is deliberately NOT a throw: `redactFields` runs in
  // `GateDispatcher.deliver`'s prelude, outside every try in a file whose single rule is
  // that delivery has one exit, so a new throw there is a gate nobody is ever told about.
  // An unusable scope gets a domain of its own instead — one no string caller can spell,
  // because a named scope is always `scope:<name>` — so the token correlates with nothing
  // beyond other calls making the same mistake, and `hits` reports it.
  const scope: Scope = opts.scope === undefined ? undefined : typeof opts.scope === "string" ? opts.scope : UNUSABLE_SCOPE;
  if (scope === UNUSABLE_SCOPE) hits.push("unusable-scope");
  let key: Buffer | undefined;
  const out = walk(value, only === undefined, 0, {
    classification,
    only,
    hits,
    path: new Set(),
    key: () => (key ??= tokenKey(scope)),
  });
  return { value: out, hits: [...new Set(hits)].sort() };
}

/** The parts of a walk that never change, kept off the recursive signature. */
interface WalkState {
  readonly classification: Classification;
  /** Field names to hide, or `undefined` to hide everything. See `redact`. */
  readonly only: ReadonlySet<string> | undefined;
  readonly hits: string[];
  /** The containers on the path from the root to here — cycle detection, not memoisation. */
  readonly path: Set<object>;
  /** This call's token key, derived on first use. See `redact` and `tokenKey`. */
  readonly key: () => Buffer;
}

/**
 * A pathological payload must not blow the stack in the redactor of all places.
 *
 * 32 is far past any payload a human is asked to approve and far short of the stack.
 */
const MAX_DEPTH = 32;

function walk(value: unknown, hiding: boolean, depth: number, st: WalkState): unknown {
  if (depth > MAX_DEPTH) return "[depth-limit]";

  if (isSecret(value)) {
    st.hits.push("secret-value");
    // The ref is already fully qualified (`secret://env/NAME`); re-prefixing it
    // would produce a ref that resolves to nothing.
    return value.ref;
  }
  if (hiding && st.classification === "secret_ref") {
    st.hits.push("secret-classified");
    return "[secret]";
  }

  // Containers first, so that everything below this point is a LEAF and the `pii` arm
  // can be written once for all of them.
  if (value !== null && typeof value === "object") {
    // A CYCLE IS NOT A DEEP TREE, and the depth limit alone treats it as one: a
    // self-referential payload was expanded 32 levels deep before it stopped, and one
    // holding two references to itself expanded 2³² nodes and never came back. The
    // ancestor set costs one lookup per container and turns both into a marker. Sibling
    // SHARING is deliberately still expanded twice — two fields pointing at one object
    // are two fields, and rendering the second as `[cycle]` would be a lie an approver
    // reads. That leaves a wide shared DAG as the one shape still exponential here; it
    // needs a hand-built payload to reach and it is not what a cycle costs.
    if (st.path.has(value)) {
      st.hits.push("cycle");
      return "[cycle]";
    }
    st.path.add(value);
    try {
      if (Array.isArray(value)) return value.map((v) => walk(v, hiding, depth + 1, st));
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        // A key that names a secret redacts its value whatever the declared
        // classification says — belt and braces for hand-built payloads.
        if (SECRETISH_KEY.test(k)) {
          put(out, k, "[secret]");
          st.hits.push("secretish-key");
          continue;
        }
        // `only` widens on the way DOWN and never narrows: everything under a named
        // field is hidden, because `redact: ["requester"]` means the requester and not
        // the shell of the object that holds them.
        put(out, k, walk(v, hiding || st.only?.has(k) === true, depth + 1, st));
      }
      return out;
    } finally {
      st.path.delete(value);
    }
  }

  // A FUNCTION IS NOT A VALUE THIS CAN HAND ON, whatever the classification says.
  // `JSON.stringify` CALLS an own-enumerable `toJSON` — so a function copied onto the
  // redacted tree by reference is a payload rewriting itself AFTER redaction ran, on its
  // way out to a channel. Nothing legitimate is lost: the destination of every one of
  // these trees is JSON, which drops a function-valued property anyway. Replacing rather
  // than dropping keeps the key visible, so an approver sees that something was there.
  if (typeof value === "function") {
    st.hits.push("unserializable");
    return "[function]";
  }

  // EVERY LEAF, not only a string. This arm read `typeof value === "string"` and returned
  // everything else unchanged, so `pii` on a number was a no-op — and the fields people
  // most often mean by PII are numbers: an account id, a phone number stored without its
  // punctuation, a date of birth as an epoch. Nothing about "this is personal data"
  // implies "this is text", and the classification is the whole contract.
  //
  // `null` and `undefined` are the exception and stay: there is nothing there to
  // disclose, and tokenising absence would turn "no ssn on file" into a value that looks
  // like one. It also keeps `redact` from inventing a field that `exactOptionalPropertyTypes`
  // spent this codebase's whole life keeping distinct from an absent one.
  if (hiding && st.classification === "pii") {
    return value === null || value === undefined ? value : piiToken(value, st.key());
  }
  return typeof value === "string" ? sweep(value, st.hits) : value;
}

const SECRETISH_KEY = /^(?:.*_)?(?:password|passwd|secret|token|api[_-]?key|authorization|credential)s?$/i;

/**
 * Copy one key onto the rebuilt object — as a PROPERTY, even when it is named `__proto__`.
 *
 * `out[k] = v` is not a property write for that one key: it invokes the accessor
 * `Object.prototype` defines, which sets the object's PROTOTYPE when `v` is an object and
 * silently discards the write when it is not. `JSON.parse` creates a `__proto__` key as an
 * own data property, and `frozenClone` — the way every journal payload becomes a
 * projection value — is a `JSON.parse`. So a payload carrying that key came out of the
 * redactor with the field GONE from the rendering a human is shown, and with the redacted
 * copy wearing a foreign prototype.
 *
 * Reproduced: `{"command":"restart","__proto__":{"email":…}}` redacted to
 * `{"command":"restart"}` on the wire, with the redacted subtree hanging off the
 * prototype. Not a disclosure — the subtree is walked before it is assigned, so what moved
 * was the already-redacted copy — but D7.3's whole reason for a field list rather than a
 * whole-payload classification is that "a human cannot approve what they cannot see", and
 * a field that vanishes is exactly that failure arriving from the other side.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  out[key] = value;
}

/**
 * Short enough to be an accident, long enough that masking it would shred a message.
 *
 * Masking `"a"` out of free text hides nothing worth hiding and destroys the diagnosis
 * around it — and a redactor whose output is unreadable is a redactor someone turns off.
 */
const MIN_MASKABLE = 6;

/**
 * Mask a value THIS PROCESS ALREADY HOLDS out of text somebody else wrote.
 *
 * The other two mechanisms both act on values that arrive as data: a declared
 * classification tokenises a field, and the detector sweep guesses at free text. Neither
 * covers the third case — a string built elsewhere that happens to quote a value we
 * configured. `TypeError: Request cannot be constructed from a URL that includes
 * credentials: https://svc:pw@…` is undici's, not ours, and a Slack incoming-webhook URL
 * is a bearer credential in path form, so that message is a secret on its way to an
 * audit row.
 *
 * This is still mechanism 1, not mechanism 2: the value is KNOWN EXACTLY, so there is no
 * pattern to match, nothing to tune, and no false negatives to apologise for. It is
 * literal substring replacement — `split`/`join`, not a regex — so no caller has to
 * escape anything and no input can make it backtrack.
 *
 * LONGEST FIRST, which is the one subtle part: a URL and its own origin are both worth
 * masking and the origin is a PREFIX of the URL, so masking the origin first would leave
 * the path — the half that is actually the credential — sitting in the output.
 */
export function maskLiterals(text: string, literals: readonly string[], token = "[redacted]"): string {
  let out = text;
  for (const literal of [...new Set(literals)]
    .filter((l) => l.length >= MIN_MASKABLE)
    .sort((a, b) => b.length - a.length)) {
    out = out.split(literal).join(token);
  }
  return out;
}

/**
 * The token a `pii` leaf becomes: KEYED, so the holder cannot invert it; stable within a
 * SCOPE, so an approver can still tell one person's two fields from two people's.
 *
 * THE OLD ONE WAS A 48-BIT UNSALTED SHA-256 PREFIX that also published `typeof` and the
 * exact `String(value).length`, and it was invertible by anyone holding it for exactly the
 * leaves a graph-declared `redact` covers. A five-digit employee id was recovered from its
 * token in **18 ms** by hashing 0…99 999 and comparing — no key, no secret, nothing an
 * attacker had to obtain, because the construction was public and the domain was small.
 * That is fine for a high-entropy string an embedder chose to tokenise. It is not fine for
 * a number, a boolean, an epoch, an age, an amount, a postcode or a short enumeration, and
 * `DeliverySpec.redact` hands the result to a channel the design calls "outside the trust
 * boundary". A token that channel can invert does not do the one job it has.
 *
 * SO THE FOUR REQUIREMENTS, RESOLVED EXPLICITLY, because they pull against each other:
 *
 *   - **Reversible by whom?** By NOBODY, and nothing in this codebase reverses it — there
 *     is no lookaside table and no un-tokenise function, which is exactly why the value
 *     has to be recoverable somewhere ELSE. It is: the journal and the read model an
 *     authenticated operator reads keep the real value, deliberately (D9.6 — a redacted
 *     journal folds to corrupted channel state). "Tokenises reversibly" was in
 *     `DeliverySpec.redactAs` for as long as that field existed and was corrected to "it
 *     is a sha256 prefix, so it is not a way back to the value" — which replaced a wrong
 *     claim with a second wrong claim, since for a small domain a sha256 prefix is
 *     precisely a way back. The honest statement is the one this function can keep: the
 *     token is a HANDLE, and the value lives inside the boundary.
 *   - **Stable, and over what scope?** Over the scope the CALLER names, and this is the
 *     requirement the previous wave resolved in the wrong direction. A per-call random
 *     token would destroy the property an approval UI actually uses — "these two fields are
 *     the same person" — and a key derived from the value is no key at all; so that wave
 *     took one key for the whole process, which keeps every occurrence in a payload, in a
 *     delivery and in an escalation an hour later tokenising identically. It also keeps
 *     every occurrence in every OTHER caller's run tokenising identically, and `piiToken` is
 *     reachable with attacker-chosen input, so the process key was a chosen-plaintext
 *     oracle: tokenise your own domain through your own graph, read your own gate delivery,
 *     invert everybody's. Cheaper than the brute force it replaced. The four comparisons an
 *     operator actually makes — two fields in one payload, two gates in one run, tier 0
 *     against tier 2 an hour later, the payload against the escalation — are all INSIDE ONE
 *     RUN, so the run is the widest scope any of them needs and the narrowest that keeps
 *     them all. See `tokenKey`.
 *   - **Stable for how LONG, and across how many processes?** As long as the caller's own
 *     promise, which is not one answer. A gate delivery correlates within a run in the
 *     process that sent it, so a per-process key costs it nothing it claimed. A TRACE
 *     claims to be a pure function of the journal — two workers, and a re-fold years later
 *     — so a per-process key is not a weaker version of what it claims, it is a
 *     contradiction of it. That caller needs a DEPLOYMENT key, and the shape is the same
 *     HMAC with a root an operator supplies. See `deploymentKey`.
 *   - **Legible.** The type stays. It is what a debugger has left to work with and it is
 *     not disclosure — `:number` says an account-id-shaped field was present, which the
 *     field NAME already said. The LENGTH is gone: `String(value).length` is a direct
 *     disclosure about the value (17 tells you which of two colleagues' addresses this is)
 *     and it was also the attacker's first filter. A field list is what keeps the payload
 *     readable; the token does not have to.
 *   - **Zero dependencies.** `node:crypto`, like every other primitive here.
 *
 * The type is inside the MAC as well as beside it, so `1` and `"1"` — which `String`
 * flattens together — do not share a digest.
 *
 * `String(v)` and not a template: it is total for every non-object leaf, including a
 * symbol, where `` `${v}` `` throws. Objects, arrays and functions never reach here —
 * `walk` handles them one level up — so the values with no primitive conversion are not
 * this function's problem.
 */
function piiToken(value: unknown, key: Buffer): string {
  const text = typeof value === "string" ? value : String(value);
  const mac = createHmac("sha256", key).update(`${typeof value}:${text}`, "utf8").digest("hex");
  return `pii:${mac.slice(0, 12)}:${typeof value}`;
}

/**
 * A scope the caller supplied and this module cannot use. See `redact` and `tokenKey`.
 *
 * A symbol rather than a sentinel string, so that no value a caller can pass — including
 * the literal text of the label — lands in this domain by spelling it.
 */
const UNUSABLE_SCOPE: unique symbol = Symbol("loom.pii.unusable-scope");
type Scope = string | undefined | typeof UNUSABLE_SCOPE;

/** The environment variable a deployment puts its token key in. */
const KEY_ENV = "LOOM_PII_TOKEN_KEY";
/** 32 bytes, hex. The SHA-256 block-sized MAC key `randomBytes(32)` already produced. */
const KEY_HEX = /^[0-9a-fA-F]{64}$/;

let keyRaw: string | undefined;
let keyBytes: Buffer | undefined;

/**
 * The malformed values already warned about — a SET, and the reason is a small lesson.
 *
 * This was one slot (`keyRaw`), under a docstring that promised "once per distinct value",
 * so two malformed values alternating re-warned forever: measured, 8 calls over 2 distinct
 * values produced **6** warnings. That is the loud direction rather than the quiet one, so
 * it was not a leak — it was a claim in a docstring with its counterexample two lines below
 * it, and a warning that repeats is one an operator filters out, which is how the signal
 * this arm exists to send gets lost.
 *
 * BOUNDED, because `process.env` can be rewritten by the process itself and an unbounded
 * memo keyed by a value somebody else chooses is the shape this codebase refuses elsewhere.
 * Past the cap it degrades to warning on every change of value — noisier, never quieter,
 * and it takes a deployment rewriting this variable 32 times to get there.
 */
const warnedKeys = new Set<string>();
const MAX_WARNED_KEYS = 32;

/**
 * The DEPLOYMENT root key, or none — and the reason a trace can be a pure function of a
 * journal at all.
 *
 * WHY A CONFIGURED KEY, having argued the opposite. The previous shape of this file said a
 * configured key "would buy correlation across restarts at the price of a token that
 * survives a rotation". That is a real price and it is not the whole account, because it
 * was written before `redactAttributes` had a caller. `telemetry/spans.ts` opens by
 * promising that a trace is a pure function of the journal — replay verification, the
 * `reconstruct(trace) ⊆ declared(graph)` assertion, and any deployment where two workers
 * fold one run all rest on it — and a per-process key made that false the moment a span
 * attribute was classified `pii`. Two workers tracing one run produced attributes that
 * could not be correlated; a re-fold a year later produced a different trace from the run
 * it describes. **A deployment-scoped secret is the only shape that satisfies both
 * requirements**: same journal + same key ⇒ byte-identical trace forever, while a party
 * without the key still gets nothing.
 *
 * WHERE IT COMES FROM, and why the environment rather than `loom.yaml`. It is a MAC key.
 * The config file is content-addressed into `run.submitted`'s `configDigest` and rendered
 * by the console; a secret does not belong in either. `--token` and the callback secret
 * arrive the same way, for the same reason.
 *
 * ABSENT ⇒ DEGRADE, PRESENT-BUT-MALFORMED ⇒ REFUSE THE KEY AND SAY SO. The two are
 * different mistakes and deserve different answers.
 *
 *   - **Absent** is a deployment that has not asked for cross-process tokens. It does NOT
 *     refuse to start, and that is invariant 8 rather than a convenience: *telemetry may
 *     drop data; the journal may not*. Making a trace-attribute key a precondition of
 *     execution inverts exactly that. So the process key below still serves the callers
 *     whose correlation window is one process (`redactPayload`, `redactFields`), and
 *     `redactAttributes` — the one caller that promised determinism — emits NO `pii`
 *     attribute at all. Omitted rather than replaced by a constant: a constant would make
 *     `state.hash.before === state.hash.after` trivially true, i.e. it would manufacture
 *     the claim "this reduce changed nothing". Absence claims nothing, which is the whole
 *     difference (`04-OVERSIGHT`'s "named nobody" vs "could not read who it names").
 *   - **Malformed** is an operator who meant to configure this and did not. Ignoring it
 *     silently is the fail-open shape this wave exists to close, and throwing is not
 *     available — the first `pii` leaf is met inside `GateDispatcher.deliver`'s prelude,
 *     so a throw is a gate nobody hears about. It warns, once per distinct value (see
 *     `warnedKeys`, which is what makes that sentence true rather than aspirational), and
 *     is then treated as absent: the trace visibly loses the attributes, which is the
 *     second signal.
 *
 * ROTATION. A rotated key produces a trace that no longer correlates with the deployment's
 * own history, and that is not a defect to be engineered around — it is what rotating a MAC
 * key MEANS, and it is the property that makes rotation worth having. Two consequences are
 * accepted deliberately: tokens either side of a rotation read as different values, and
 * nothing in the token says which generation produced it. A `kid` prefix would fix the
 * second (`pii:<kid>:<mac>:<type>`), and it is NOT built because the token's shape is
 * asserted by four test files — two of them outside this change — and no reader in this
 * repo compares tokens across a rotation boundary today. If one ever does, that is the
 * change to make, and it is a breaking one.
 *
 * READING THIS IS CONFIGURATION, NOT NONDETERMINISM, and the distinction has to be said out
 * loud because the previous wave documented its per-process key as "the one piece of
 * nondeterminism outside the effect boundary" and that framing is what let a random key sit
 * under a function documented as pure. `ctx.effect` (invariant 4) exists so that a REPLAY
 * serves what the original run observed; an environment variable read once is the same kind
 * of input as a config file or a channel URL — it is fixed for the deployment, identical in
 * every worker, and it is not something the run observed. What was outside the boundary and
 * should not have been was the RANDOMNESS, and it is now confined to callers whose output
 * nothing compares across processes.
 */
function deploymentKey(): Buffer | undefined {
  const raw = process.env[KEY_ENV];
  if (raw === undefined || raw === "") return undefined;
  if (raw !== keyRaw) {
    keyRaw = raw;
    keyBytes = KEY_HEX.test(raw) ? Buffer.from(raw, "hex") : undefined;
    if (keyBytes === undefined && !warnedKeys.has(raw)) {
      if (warnedKeys.size < MAX_WARNED_KEYS) warnedKeys.add(raw);
      process.emitWarning(
        `${KEY_ENV} is set but is not 64 hex characters (32 bytes), so it is being IGNORED. ` +
          `pii span attributes will be omitted from traces and delivery tokens will be per-process. ` +
          `Generate one with: openssl rand -hex 32`,
        "LoomConfigWarning",
      );
    }
  }
  return keyBytes;
}

/**
 * The PROCESS root key, minted once, on first use, and never leaving this module.
 *
 * The fallback when no deployment key is configured, and it is now a fallback rather than
 * the design: it is right exactly for a caller whose tokens are read within the process
 * that minted them. NOT EXPORTED, deliberately — exporting it would make the one secret
 * that keeps a token uninvertible into something an embedder can log.
 *
 * LAZY so that importing this module costs no entropy, and so a process that never
 * redacts a `pii` leaf never asks the OS for any. `randomBytes` and not `randomUUID`:
 * this is a MAC key, and 32 bytes is the SHA-256 block-sized one.
 */
let PROCESS_KEY: Buffer | undefined;

/**
 * The key one `redact` call tokenises under: the root key, separated by SCOPE.
 *
 * `HMAC(root, "…v1\n" + label)` and not `root` itself, so that knowing every token in one
 * scope — which is exactly what a channel holding its own gate delivery knows — reveals
 * nothing about the tokens in another. Recovering the root from a scoped key, or one
 * scoped key from another, is inverting HMAC-SHA-256.
 *
 * THREE LABELS THAT CANNOT COLLIDE. A named scope becomes `scope:<name>`, an absent one
 * becomes `process`, and one the caller supplied in a shape this module cannot use becomes
 * `unusable-scope` — so a caller that literally passes `"process"` gets `scope:process` and
 * a domain of its own, and no string whatsoever reaches the other two. That matters because
 * scopes are not secret — the delivery path names the run id — and a naming scheme in which
 * a caller can spell the wider domain is a scheme where an attacker can opt back into the
 * oracle.
 *
 * WHEN THE PROCESS DEFAULT IS RIGHT, stated as a condition rather than a convenience,
 * because a default that silently fails open is how the shared key arrived in the first
 * place. It is right exactly when every reader of the token is already inside the trust
 * boundary AND nothing compares the token across processes. `redactPayload` is the one
 * consumer that meets both: its caller is `http.ts`'s `frame`, the event stream an
 * AUTHENTICATED operator reads, and one who can read the same values unredacted from the
 * journal and from `GET /runs/:id/gates` anyway (see the NOTE ON PURPOSE above and D9.6).
 *
 * **The moment a token under the default reaches a party outside the boundary, this is the
 * oracle again and that caller must name a scope.** `redactFields` — the gate-delivery path,
 * the one sink that is outside the boundary by definition — therefore does not have the
 * option: its `scope` is a required parameter, so forgetting is a compile error rather than
 * a review comment. `redactAttributes` is the same, and this sentence used to say so while
 * its `scope` was OPTIONAL — a claim about the one caller written as a claim about the
 * function, which is how the deployment-wide token described in that function's docstring
 * became reachable. It is now required there too, and a scope it cannot use omits the
 * attribute rather than falling back: no caller of either function can reach the `process`
 * label at all, by construction rather than by convention.
 *
 * THE PROCESS KEY IS THE LAST PIECE OF NONDETERMINISM IN THIS FILE, and it is still
 * deliberately outside `ctx.effect` (invariant 4) — re-checked rather than inherited. No
 * token minted under it is journaled, folded, hashed into a derived id, or compared against
 * a stored one: `replay.ts`'s `compare` reads task states, `channels` and `status`, all of
 * which are the journal's own unredacted values, and a replayed run re-delivers its gates
 * under a fresh `replayRunId`. The one caller that DID compare its output across processes
 * was `telemetry/spans.ts`, and that is what `deploymentKey` fixes. If a token ever becomes
 * an input to a derived id or to a durable comparison, this must move inside the effect
 * boundary.
 */
function tokenKey(scope: Scope): Buffer {
  const root = deploymentKey() ?? (PROCESS_KEY ??= randomBytes(32));
  const label = scope === undefined ? "process" : scope === UNUSABLE_SCOPE ? "unusable-scope" : `scope:${scope}`;
  return createHmac("sha256", root).update(`loom.pii.token.v1\n${label}`, "utf8").digest();
}

function sweep(text: string, hits: string[]): string {
  let out = text;
  for (const d of DETECTORS) {
    // `replace` with a global regex is stateless here because a fresh string is
    // produced each pass; `test` on a /g regex would carry lastIndex and miss.
    //
    // A DETECTOR'S OWN REPLACEMENT WHEN IT HAS ONE, because a pattern that matches a
    // POSITION rather than a value has readable text inside its own match — see
    // `Detector.replace`. The default keeps the shape's name in the output, which is what
    // makes a swept string say WHY a run of characters is missing.
    const replaced = out.replace(d.pattern, d.replace ?? `[redacted:${d.name}]`);
    if (replaced !== out) hits.push(d.name);
    out = replaced;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emit-time hooks
// ---------------------------------------------------------------------------

/**
 * Redact a payload on its way to a reader INSIDE the trust boundary.
 *
 * The name is older than the callers: nothing writes a redacted journal (D9.6 — a redacted
 * `state.reduced` folds to corrupted channel state), and the two live callers are both
 * `http.ts` framing what an authenticated operator reads. Tokens therefore correlate at
 * PROCESS scope here, which is what that operator wants and what `tokenKey` says is safe
 * for them: they can read the same values in the clear one route over.
 *
 * A caller shipping a payload to a third party wants `redactFields` and its required scope,
 * not this.
 */
export function redactPayload(payload: unknown, classification: Classification): unknown {
  return redact(payload, classification).value;
}

/**
 * Redact span attributes before they leave the process.
 *
 * Applied per attribute rather than to the whole bag, so a `pii`-classified attribute
 * tokenises while its neighbours keep their detector sweep.
 *
 * ONE SCOPE FOR THE WHOLE BAG, AND IT IS REQUIRED. A trace collector is outside the process
 * the way a delivery channel is. Two attributes of one span naming one person must read as
 * one person, so the scope cannot be per-attribute; and a span belongs to a run, so the
 * caller passes the run id rather than correlating this deployment's every trace under one
 * key.
 *
 * **It was OPTIONAL for one wave, and `deploymentKey` is what made that expensive.** An
 * omitted scope fell through to `tokenKey`'s `process` label — survivable while the root
 * was `randomBytes(32)` per process, because such a token correlated with nothing outside
 * the process that minted it. With `LOOM_PII_TOKEN_KEY` configured that label is derived
 * from the DEPLOYMENT root, so the same omission became a cross-run, cross-tenant,
 * permanent correlation domain: exactly the oracle a scope exists to close, reached by
 * leaving an argument out. Measured, one key, two processes:
 * `scope=run_a → pii:4bf49099d342:string`, `scope omitted → pii:167f42d19528:string`,
 * the second identical in both. The argument for leaving it optional was `tokenKey`'s own
 * docstring asserting that this function "names one too" — a true statement about its
 * single caller and never a statement about the function.
 *
 * **And a scope that is present but unusable costs the attributes rather than widening the
 * domain**, which is where this parts company with `redact` and `redactFields`. Those must
 * still deliver a gate, so an unusable scope gets a narrow domain of its own; nothing has
 * to be emitted here, and a trace that loses an attribute is invariant 8 working as
 * designed — telemetry may drop data. The alternative is a token whose correlation domain
 * the caller did not choose, which is the thing being fixed. It warns once per process,
 * because unlike an absent deployment key this is a caller BUG and not a posture.
 *
 * **A `pii` ATTRIBUTE IS OMITTED WHEN NO DEPLOYMENT KEY IS CONFIGURED**, which is the one
 * behaviour here that a reader will not expect and is the whole reason this function is not
 * a two-line loop. Its caller — `telemetry/spans.ts` — states that a trace is a pure
 * function of the journal, and a token minted under `tokenKey`'s per-process fallback makes
 * that false: two workers folding one run emit attributes that cannot be joined, and a
 * re-fold produces a different trace from the run it describes. Given the choice between a
 * token nobody can reproduce and no token at all, the second is the only one that keeps
 * both promises this file makes — un-inventible AND deterministic. What it costs is stated
 * plainly: without `LOOM_PII_TOKEN_KEY`, a trace loses `gate.approver`, the two state
 * hashes, `gate.content_digest` and an escalation's recipients. Set the variable and they
 * come back, identically in every process. See `deploymentKey`.
 *
 * A CLASSIFICATION IS TAKEN ONLY FROM AN OWN PROPERTY, AND ONLY IF IT IS ONE. This read
 * `classifications[k] ?? "internal"`, which on an ordinary object literal answers
 * `constructor` with a function — the same fail-open `reduceState`'s channel lookup has —
 * and which took any value at all as a classification, where `walk`'s `=== "pii"` /
 * `=== "secret_ref"` comparisons then quietly meant `internal`. An inherited name is not a
 * classification (so: `internal`, the documented default); a value that is not one of the
 * four IS a caller error, and the safe reading of "somebody meant to protect this" is the
 * most protective one, which is also the most visible: `[secret]`. A whole classification
 * MAP that is not a map takes the same reading for the same reason, and used to throw out
 * of `hasOwnProperty.call` — see `isClassificationMap` for why "not a map" cannot be spelled
 * `typeof m !== "object"`, and for the `Map` that read as "nothing here is sensitive".
 *
 * WHY THIS FUNCTION IS ALLOWED TO BE QUIET WHEN `reconstructGraph` IS NOT — the two used to
 * ask the same shape question and take opposite verdicts on the answer. Dropping an
 * attribute here can only ever REMOVE something from a trace: the journal keeps every value,
 * invariant 8 says telemetry may drop data, and no reader treats a missing attribute as an
 * assertion. `conformsToGraph` is a verification function, so its silence IS an assertion —
 * `ok: true` — and dropping a claim there certifies what it failed to read. The question to
 * ask of any guard is not "is quiet safe?" but "is this function's silence read as a claim?".
 *
 * THAT IS ALSO WHY THE TWO ARGUMENTS ARE GUARDED DIFFERENTLY, which looks like an
 * inconsistency and is the rule being applied twice. `attrs` keeps the loose
 * `=== null || typeof !== "object"` test: a `Map` or a `Date` there yields `{}` from
 * `Object.entries` and an array yields index keys, so every wrong shape REMOVES or renames,
 * and every value still goes through `redact`. `classifications` gets a strict one, because
 * its wrong shapes DISCLOSE.
 *
 * **AND THE TWO PARTED COMPANY AGAIN WHEN `reconstructGraph` DELETED ITS SHAPE TEST, which
 * is worth stating because the two files used to cite each other.** That function could
 * move the check onto its READS — a `loom.task` span that yields none of its four claims is
 * unreadable, whatever container it turned out to be. This one cannot: through a property
 * read, "the caller declared nothing for this key" and "the caller's declarations live in
 * internal slots" are the SAME observation, and the first must stay `internal` or every
 * trace turns into `[secret]`. So the shape question is the only thing separating them here,
 * it is undecidable in general, and `isClassificationMap` says exactly that rather than
 * gaining a fourth spelling. The reads are now total, which is a different property and one
 * that WAS reachable — see `attributeClass`.
 *
 * **WHAT "TOTAL" NAMES HERE, SPELLED OUT, BECAUSE THE LAST WAVE WROTE IT AS A PROPERTY OF
 * TWO ARGUMENTS AND IT WAS A PROPERTY OF FOUR READS.** "Both arguments of `redactAttributes`
 * are now total" stood in this file, in `05-RESOURCES-OBSERVABILITY.md` D9.2 and in
 * `HANDOFF`'s A18 while two of the reads behind it still threw, and the two survivors were
 * both SIBLINGS of the reads that had just been fixed — the shape test one line above the
 * `try` it was reasoned about, and the walk of a value one level below the enumeration that
 * was wrapped. The property this function now has, and the only one worth writing down, is:
 *
 *   **`redactAttributes` does not throw, for any value of any of its three arguments.**
 *
 * Measured rather than reasoned, because that is what the last version of this sentence was
 * not: 23 × 16 × 7 = 2,576 combinations of hostile `attrs` × `classifications` × `scope` —
 * every trap of a `Proxy` throwing, a revoked `Proxy`, a cycle, 200 levels of nesting, a
 * throwing element getter, a `toString`/`valueOf` bomb under a `pii` key, an own `__proto__`
 * from `JSON.parse`, and the ordinary shapes beside them — **0 threw**. Which is a claim about
 * THIS FUNCTION and about nothing else. `redact` and `walk` are
 * unchanged and are NOT total — a nested throwing getter still comes out of `redactPayload`
 * and `redactFields` — and `isClassificationMap` is still a named-shape refusal that a
 * `Proxy` defeats, which is a claim about what it can DECIDE and orthogonal to whether it
 * can throw. Every conjunct is held by a test: *A CLASSIFICATION MAP THAT THROWS COSTS ONE
 * ATTRIBUTE, NOT EVERY SPAN IN THE RUN* (`hasOwnProperty` and `get` traps), *A CLASSIFICATION
 * MAP WHOSE PROTOTYPE READ THROWS IS REFUSED, NOT PROPAGATED* (`getPrototypeOf`), *AN
 * ATTRIBUTE BAG THAT THROWS ON ENUMERATION REMOVES EVERYTHING* (`ownKeys`, `get` at depth 0),
 * and *A VALUE INSIDE THE BAG THAT THROWS COSTS ONE ATTRIBUTE* (depth ≥ 1).
 *
 * The ASYMMETRY survives all of that and is the more useful half of it: `attrs`' wrong shapes
 * still only ever REMOVE, so its guard stays loose and the new catch drops one attribute;
 * `classifications`' wrong shapes DISCLOSE, so every one of its failure modes — not a map,
 * not readable, not a classification — answers `secret_ref`. Totality is what neither
 * argument had; it is not the same statement as the asymmetry and it does not replace it.
 */
export function redactAttributes(
  attrs: Readonly<Record<string, unknown>>,
  classifications: Readonly<Record<string, Classification>>,
  scope: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Total in the value the caller hands over, because `SpanLink.attributes` and
  // `SpanEvent.attributes` are optional and a `null` there would throw in `Object.entries`.
  if (attrs === null || typeof attrs !== "object") return out;
  // The type says `string`; this says what a JS caller gets for handing over something
  // else, and `""` is in the refusal because a bare empty string is a scope label of its
  // own that no run id can spell.
  const scoped = typeof scope === "string" && scope !== "";
  if (!scoped) warnUnusableScope();
  const mintable = scoped && deploymentKey() !== undefined;
  // ENUMERATION IS A CALL WHEN THE BAG IS NOT OURS, and that is what the loose guard above
  // was NOT licensed by. `Object.entries` invokes `ownKeys`, `getOwnPropertyDescriptor` and
  // `get`; on a `Proxy` each of those is a trap that can throw, and a throw here is not
  // "removes" — it is `close` in `telemetry/spans.ts` losing EVERY span for the run, and for
  // `loom trace` the process. Measured: `ownKeys` and `get` traps both escaped
  // `redactAttributes` intact. Costing the bag restores the licence: nothing is emitted,
  // nothing leaks, and invariant 8 says telemetry may drop data.
  let entries: readonly (readonly [string, unknown])[];
  try {
    entries = Object.entries(attrs);
  } catch {
    return out;
  }
  for (const [k, v] of entries) {
    const classification = attributeClass(classifications, k);
    if (classification === "pii" && !mintable) continue;
    // ENUMERATING THE BAG AND WALKING A VALUE INSIDE IT ARE THE SAME HAZARD ONE LEVEL APART,
    // and only the first was guarded. `Object.entries` above is inside a `try` because it
    // invokes traps; `walk` runs `Object.entries` again on every nested container and
    // `Array.isArray(v) ? v.map(…)` on every nested array, and this call was bare. So the
    // shape the guard above was written for cost the whole bag when it sat at depth 0 and
    // the whole RUN when it sat at depth 1 — and at depth 1 it needs no `Proxy` at all.
    // Measured, one deployment key, scope `run_a`:
    //
    //   {payload: {get x() { throw new Error("nested getter") }}}        ⇒ Error: nested getter
    //   {payload: new Proxy({}, {ownKeys() { throw … }})}                ⇒ Error: nested ownKeys
    //   {payload: new Proxy([1], {get() { throw … }})}                   ⇒ Error: nested array get
    //
    // ONE ATTRIBUTE, NOT THE BAG, which is the finer answer the bag-level catch cannot give
    // and this one can: enumeration failing says nothing about any particular key, while a
    // walk that threw names exactly which value could not be rendered. Dropping it is the
    // removing direction this argument is guarded loosely under, and it is the same verdict
    // the `pii && !mintable` arm two lines up already reaches for a different reason.
    //
    // This is a property of `redactAttributes`, NOT of `redact`: `walk` is unchanged, and the
    // same value still comes out of `redactPayload` and `redactFields` — measured, both
    // `THROW depth 2` on `{deeper: {get boom() { throw }}}`. Those two are left alone here
    // because they are `run/delivery.ts`'s and `http.ts`'s callers rather than this file's
    // decision to make in a change about span attributes, and because widening the guard into
    // `walk` changes what a gate delivery renders. If it ever moves there, this catch
    // collapses into it.
    let redacted: unknown;
    try {
      redacted = redact(v, classification, { scope }).value;
    } catch {
      continue;
    }
    // `put`, not `out[k] = …`, and this file WROTE that helper for exactly this — see its
    // docstring. `walk` was taught it and this function, written later in the same file,
    // was not, so an attribute named `__proto__` left the process as the bag's PROTOTYPE
    // when its redacted value was an object and as NOTHING AT ALL when it was a string
    // (the accessor discards a primitive write in sloppy mode). `JSON.parse` makes that an
    // own data property, which is how any bag read back from a collector or a file gets
    // one. The classification lookup is unaffected: `attributeClass` already reads through
    // `hasOwnProperty`, so an own `__proto__` entry in the map is honoured and an inherited
    // name is not.
    put(out, k, redacted);
  }
  return out;
}

/**
 * Said once per process, because it is a caller bug rather than a deployment posture.
 *
 * The distinction is `deploymentKey`'s: an ABSENT key is a deployment that did not ask for
 * cross-process tokens and gets a poorer trace in silence; a scope this module cannot use
 * is a caller that asked for something and did not get it. The attributes going missing is
 * the second signal, and it is the one a reader of the trace sees.
 */
let warnedScope = false;
function warnUnusableScope(): void {
  if (warnedScope) return;
  warnedScope = true;
  process.emitWarning(
    `redactAttributes was called with a scope that is not a non-empty string, so every pii ` +
      `attribute is being OMITTED rather than tokenised under a wider domain. Pass the run id.`,
    "LoomConfigWarning",
  );
}

/**
 * THE CONTAINERS THIS CAN NAME AS WRONG — and, said plainly, the question it cannot decide.
 *
 * WHAT IT DECIDES. `typeof` answers `"object"` for `[]`, a `Map`, a `Date`, a `RegExp` and a
 * class instance, and NONE of them answers `hasOwnProperty` for an attribute name — a `Map`
 * keeps its entries in internal slots. So each one fell straight through to the documented
 * default `internal`, and `internal` is the arm that RETURNS THE VALUE. Measured, one
 * deployment key, scope `run_a`:
 *
 *   redactAttributes({"gate.approver":"u:alice"}, new Map([["gate.approver","pii"]]), "run_a")
 *     ⇒ { "gate.approver": "u:alice" }
 *
 * — the person, in the clear, on a span bound for a third-party collector, which is the
 * exact disclosure `ATTRIBUTE_CLASSES` exists to prevent, reached by handing the map over
 * in the wrong container. Those shapes are refused, and that is the whole of what this
 * decides.
 *
 * **WHAT IT CANNOT DECIDE, AND WHY THERE IS NO FOURTH SPELLING.** A `Proxy` with a
 * `getPrototypeOf` trap answers `Object.prototype` for a target of any kind whatsoever, so
 * the same `Map` gets through by adding one line — measured, same key and scope, the same
 * `u:alice` in the clear. This is not a gap to be closed by a better observable: **a `Proxy`
 * must tell the truth about exactly one thing, the extensibility of its target**, and every
 * ordinary object literal — including `ATTRIBUTE_CLASSES` — is extensible, so a test
 * requiring non-extensibility would turn every embedder's map into `[secret]`. *"Is this
 * value a plain bag?"* has no reliable answer in JavaScript. This function is therefore a
 * NAMED-SHAPE REFUSAL and not a decision procedure, and the honest reading of its `true` is
 * "not one of the containers I can recognise as wrong".
 *
 * **WHERE THE REAL GUARANTEE COMES FROM, since it is not from here.** `telemetry/spans.ts`
 * passes `ATTRIBUTE_CLASSES`, a module constant. That — not this predicate — is why the one
 * `pii` classification in this repo cannot be forged away. An embedder that hands over an
 * exotic container is the exposed party, its own run's attributes are what is exposed, and
 * `test/security/redact.test.ts`'s *A `Proxy` DEFEATS THE SHAPE TEST AND THE DISCLOSURE IS
 * REAL* holds the limit executable so it cannot be narrowed by accident.
 *
 * **AND WHY THE PREDICATE STAYS AT ALL**, rather than following `reconstructGraph`'s
 * example and moving onto the reads. That function could: a `loom.task` span that yields
 * none of its four claims is unreadable whatever it is made of, because "claims nothing" is
 * a verdict it is allowed to reach. Here the same observation is ambiguous and must stay
 * ambiguous — a key absent from a plain map and a key absent because the map keeps its
 * entries elsewhere are ONE observation through a property read, and the first has to answer
 * `internal` or every attribute in every trace becomes `[secret]`. Refusing the containers
 * that can be named is strictly better than refusing none of them.
 *
 * `null` PROTOTYPE COUNTS, and it is the shape the ONE real caller uses:
 * `ATTRIBUTE_CLASSES` in `telemetry/spans.ts` is `Object.create(null)`-based on purpose, so
 * a test written as `=== Object.prototype` alone would turn every span attribute in every
 * trace into `[secret]`.
 *
 * PROTOTYPE IDENTITY rather than `Object.prototype.toString`, which reads a caller-supplied
 * `Symbol.toStringTag` getter — a call, and one any object can spell to be believed.
 *
 * **`getPrototypeOf` IS A CALL TOO, AND THIS PARAGRAPH USED TO SAY SO AND THEN EXCUSE IT.**
 * It read: "the difference is that it cannot throw an ordinary getter's exception, and that
 * is the only claim made for it" — false, and the counterexample is one line:
 * `new Proxy({}, {getPrototypeOf() { throw new Error("gpo trap") }})` throws whatever it
 * likes, from a frame this function does not own. The real difference is narrower and is
 * still worth having: a `Symbol.toStringTag` getter is reachable on an ORDINARY object, so
 * the tag form is defeated by a value nobody had to build a `Proxy` for, while every
 * prototype trap requires one. Neither form is total on its own, so the totality lives at
 * the call site instead — `attributeClass` runs this test INSIDE its `try` and answers
 * `secret_ref` when it throws, exactly as it does for the two reads below it.
 *
 * A CROSS-REALM PLAIN OBJECT IS REFUSED, and that is a cost rather than an oversight — see
 * HANDOFF's cross-realm trap note. A map built inside a `node:vm` context carries THAT
 * realm's `Object.prototype`, so it reads as unusable and every attribute in the bag becomes
 * `[secret]`. Loud, fail-closed, and reachable only by an embedder classifying span
 * attributes from inside a vm; `ATTRIBUTE_CLASSES` is a module constant in this realm.
 */
function isClassificationMap(v: unknown): v is Readonly<Record<string, Classification>> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === null || proto === Object.prototype;
}

/** What `redactAttributes` will act on for one key. See its docstring for the two rules. */
function attributeClass(classifications: Readonly<Record<string, Classification>>, key: string): Classification {
  let declared: unknown;
  try {
    // A CLASSIFICATION MAP THAT IS NOT A MAP IS NOT AN EMPTY ONE. The same direction the arm
    // below takes for a value that is not a classification, one level up: `internal` here
    // would read "the caller says nothing in this bag is sensitive", which is the one thing a
    // caller who handed over a broken map has NOT said.
    //
    // ALL THREE READS OF THE CALLER'S MAP INSIDE ONE `try`, BECAUSE ALL THREE ARE CALLS —
    // and the shape test was the one left outside it. (Three is the whole count: the fourth
    // `hasOwnProperty` below is against `CLASSIFICATION_POSTURE_FLOOR`, a module constant,
    // with a `string` key.) This comment used to say "BOTH READS", naming
    // `hasOwnProperty` (which invokes `[[GetOwnProperty]]`, a `Proxy` trap) and the index
    // read (which invokes `get`, a trap and, on any ordinary object, a getter). Both were
    // measured escaping `redactAttributes` and therefore `spansFrom`, which costs the caller
    // every span for the run: `Error: gopd trap`, `Error: get trap`. `isClassificationMap`
    // sat one line ABOVE the `try` under a docstring that names `getPrototypeOf` as a call
    // on a `Proxy` in its own last paragraph — so the third call was documented as a call
    // and guarded as though it were a `typeof`. Measured, same shape as the other two:
    //
    //   redactAttributes({"gate.approver":"u:alice"},
    //                    new Proxy({}, {getPrototypeOf() { throw new Error("gpo trap") }}), "run_a")
    //     ⇒ Error: gpo trap, out of redactAttributes
    //
    // The test that pinned the other two even built its proxies with a well-behaved
    // `getPrototypeOf: () => Object.prototype`, because that is what it took to REACH the
    // reads it was about — the counterexample was a line of its own setup.
    if (!isClassificationMap(classifications)) return "secret_ref";
    if (!Object.prototype.hasOwnProperty.call(classifications, key)) return "internal";
    declared = classifications[key];
  } catch {
    // A READ THAT THREW IS NOT A KEY THAT IS ABSENT. `internal` is the documented answer for
    // "the caller declared nothing here"; a caller whose map detonates has declared nothing
    // of the kind, so this takes the same protective, visible reading the arm above gives a
    // map that is not a map.
    return "secret_ref";
  }
  // `CLASSIFICATION_POSTURE_FLOOR` is keyed by `Classification` and exported, so membership
  // in it IS the vocabulary — one list, in `vocab.ts`, rather than a second copy here that
  // a fifth classification would silently not join.
  return typeof declared === "string" && Object.prototype.hasOwnProperty.call(CLASSIFICATION_POSTURE_FLOOR, declared)
    ? (declared as Classification)
    : "secret_ref";
}

/**
 * A secret provider that hands back `SecretValue`s.
 *
 * `env` and `file` are the v1 backends; Vault and the K8s CSI driver are the v2 swap
 * behind the same signature.
 */
export interface SecretProvider {
  resolve(ref: string): SecretValue;
}

export function envSecretProvider(env: Readonly<Record<string, string | undefined>> = process.env): SecretProvider {
  return {
    resolve(ref: string): SecretValue {
      // `secret://env/NAME`
      const name = ref.replace(/^secret:\/\/env\//, "");
      const value = env[name];
      if (value === undefined) throw new Error(`secret "${ref}" is not set`);
      return new SecretValue(value, ref);
    },
  };
}
