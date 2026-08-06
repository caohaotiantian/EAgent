/**
 * The control plane: the only externally reachable surface.
 *
 * `node:http` only — no framework — so `@loom/core` stays zero-dependency and the
 * single binary keeps working.
 *
 * Two contracts matter more than the routes:
 *
 *   1. **What is durable at ACK.** A `202` means `run.submitted`, `run.compiled`, and
 *      the resolution manifest are in the journal. It does NOT mean anything ran. A
 *      client that reads 202 as "it happened" will be wrong exactly when it matters.
 *
 *   2. **Reconnect is gap-free.** `GET /runs/:id/events` honours `Last-Event-ID`, and
 *      because `seq` is gap-free per run and the journal is the truth, "did I miss
 *      anything?" is always answerable. The client never has to guess.
 *
 * And a third that took three waves to notice: **who you are is decided by the
 * credential, never by the request body.** `subject` began life as an audit label, and
 * when approvers lists started being matched against it, it silently became an
 * authorization key that the caller was still typing in themselves. One shared bearer
 * token plus `{"actor":"u:security-lead"}` decided a gate that named the security lead.
 * The `AuthContext` this file resolves — from an injected `IdentitySource`, or from the
 * shared token, or from nothing at all — is now the only source of a decider's subject,
 * and a body that claims one is refused rather than ignored. See `#decider`.
 *
 * And a fourth, learned the same way: **a credential that admits everyone is not a
 * credential, and the plane refuses to start on one.** `token: ""` made `#sharedToken`'s
 * constant-time compare true for every caller — including one sending no `Authorization`
 * header — while `/health` reported `auth: "required"`, `/whoami` handed out a principal,
 * and both boot warnings stayed silent, because the empty string counted as a configured
 * secret. One character of deployment slip (`--token "$LOOM_TOKEN"`, variable unset)
 * bought a perimeter that lied about itself. `BearerTokenIdentity` had refused the
 * identical configuration since it was written; the plane now does too, at construction,
 * so a misconfigured deployment fails to start rather than starting wide open. The one
 * way to be open is to configure NOTHING — an absence, not a value — see
 * `ControlPlane.openToEveryCaller`, which is the single fact `/health`, `#principal` and
 * both boot paths read.
 *
 * And two deliberate holes, described where they are cut: `POST
 * /runs/:id/callbacks/:channel` is reachable without the bearer token, because the
 * service posting to it does not have one; and `GET /` serves the console's static shell,
 * because a browser cannot put a bearer token on a top-level navigation. See
 * `#requiresBearer`.
 *
 * One rule spans both of those and `/health`, the third open route: **nothing a stranger
 * can reach may cause the injected `IdentitySource` to be called.** It is deployment code
 * that talks to a network, so any open route that consults it is an amplifier — an
 * unauthenticated request turned into load on the SSO — and, worse, a way for that SSO's
 * outage to become this process's. `/health` broke the rule to decide what to disclose,
 * and decides it from the shared token instead. Nor does it read anything OFF the source
 * at request time: the label it discloses is captured once, at construction.
 *
 * ## THE LIMIT: authentication is not authorization
 *
 * **Every valid credential is a full operator credential.** `auth` decides WHO you are
 * and whether you get in at all; it does not decide WHAT you may touch. A run is not
 * scoped to the principal that submitted it, so any principal this deployment can
 * authenticate may read, stream and cancel any other principal's run — `GET /runs`,
 * `GET /runs/:id`, `GET /runs/:id/events`, `POST /runs/:id/commands`. Gate payloads come
 * with that: `GET /runs/:id/gates` returns them redacted per the GRAPH's declared
 * classification, never per viewer, so "everyone sees everything" is a statement about
 * real data and not about a placeholder.
 *
 * What `auth` DOES decide is three things and stops: admission (401 before routing), who
 * a gate decision is recorded as and whether the approvers list allows it, and which
 * idempotency slot a write lands in. Every one of those is about the CALLER; none is
 * about the run.
 *
 * This is a DECISION, not an omission, and it is a v1 decision. D3.17 gives every method
 * an `auth` parameter precisely so it CAN scope access, and this implementation does not.
 * Scoping needs a durable owner — the submitting principal
 * recorded on `run.submitted`, folded into the `runs` read model, and an operator role or
 * explicit grant to escape it — and durable state is the engine's to write, not this
 * file's. Half of it, an in-process ownership map, would be worse than none: it would
 * evaporate on restart and read as isolation while providing none.
 *
 * What stops the limit from being silent: it is stated here, stated in D3.17, pinned by a
 * test that exercises one principal reading another's run, and SHOUTED AT BOOT whenever
 * more than one principal is configured — see `ControlPlane.distinctPrincipals`. The
 * warning exists because configuring per-subject identities implies isolation to anyone
 * who does it, and a false implication is worse than an absence.
 *
 * See design/loom/01-INTERFACES.md D3.17–D3.18 and D3.20.
 */

import { constants as BUFFER } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { EventBus } from "../bus.ts";
import { httpStatusFor, isLoomError, toLoomError, CODES, err } from "../errors.ts";
import type { GateId, RunId } from "../ids.ts";
import type { HumanActor, JournalEvent } from "../journal/events.ts";
import type { StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import type { Engine } from "../run/engine.ts";
import { GateCallbackRouter, type GateDispatcher } from "../run/delivery.ts";
import { gateDecisionOf, isSyntheticSubject, type GateDecision } from "../vocab.ts";
import { gateOf } from "../run/projection.ts";
import { RunLog } from "../run/log.ts";
import { redactPayload } from "../security/redact.ts";
import { layoutGraph } from "./layout.ts";
import { CONSOLE_HTML } from "./console.ts";

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The subject recorded when a decision arrives through the API and the deployment gave
 * the plane no way to learn WHOSE hand it was.
 *
 * It is the honest statement and not a name: the request was accepted by the perimeter,
 * and nobody was identified. The parentheses are deliberate — they match the
 * `(unknown)` channel literal in `GateCallbackRouter` and they make the string read as a
 * marker rather than as a subject id, because it will be printed next to real ones.
 *
 * IT IS NOT A SKELETON KEY. A gate that names approvers is refused before this value can
 * be tested against the list, so a graph that literally wrote `(unidentified)` into its
 * `approvers` would still not be answerable by an unidentified caller — see
 * `#refuseUnidentifiedApproval`. That check is in this file because `approvers` is an
 * opaque string list the compiler does not constrain.
 */
export const UNIDENTIFIED_SUBJECT = "(unidentified)";

/**
 * The subject recorded when the SHARED bearer token admitted a caller.
 *
 * Synthetic in the same way `UNIDENTIFIED_SUBJECT` is: it names a CREDENTIAL, not a
 * person. Every service in the deployment holds this token, so the honest statement is
 * "one of the things that has the shared token", and the parentheses say so.
 *
 * Module-private on purpose. Nothing outside this file mints it, and nothing outside this
 * file should be able to spell it — see `SYNTHETIC_SUBJECTS`.
 */
const SHARED_TOKEN_SUBJECT = "(shared-token)";

/**
 * Every subject this file INVENTS, in one list.
 *
 * Each is a statement about the perimeter rather than a name: "nobody was identified",
 * "the shared credential was presented". An injected `IdentitySource` may claim none of
 * them — returning `(unidentified)` turns the absence of identity into a name, and
 * returning `(shared-token)` impersonates the plane's own service principal.
 *
 * ONE LIST, checked in ONE place, because the first version of that check named a single
 * marker inline and the other one — minted two hundred lines away, in `#principal` — was
 * simply forgotten. A third marker added later is refused by construction rather than by
 * whoever remembers this paragraph.
 */
const SYNTHETIC_SUBJECTS: readonly string[] = [UNIDENTIFIED_SUBJECT, SHARED_TOKEN_SUBJECT];

/** What an `IdentitySource` is shown. Headers, because that is where credentials ride. */
export interface IdentityRequest {
  readonly method: string;
  readonly path: string;
  /** Lower-cased header names, single-valued. */
  readonly headers: Readonly<Record<string, string | undefined>>;
}

/**
 * Who the transport says is calling — resolved from the credential, never from a body.
 *
 * `kind` is the load-bearing field. `human` means "this credential belongs to a person
 * whose subject id is `subject`", and it is the ONLY kind that may satisfy a gate's
 * approvers list. `service` means the credential authenticates a deployment or a job:
 * legitimate for submitting runs and reading projections, never a person. The design
 * names this type in D3.17; this is its shape.
 *
 * It answers WHO, and in this implementation nothing else. Two principals with different
 * subjects have identical access to every run in the journal — see "THE LIMIT" in the
 * module docstring. `subject` is an authorization key for exactly one decision, a gate's
 * approvers list, and for nothing else.
 */
export interface AuthContext {
  readonly kind: "human" | "service";
  /** For a human, the id an approvers list is matched against. */
  readonly subject: string;
  /** How identity was established — an `IdentitySource` name, or `shared-token`. */
  readonly method: string;
  /**
   * The channel this credential belongs to, recorded on the decision. Defaults to `api`.
   *
   * It describes the CREDENTIAL, not the request: someone who takes their console token
   * to `curl` is still recorded as `console`. That is the deployment's own declaration
   * about what it issued, and the alternative — inferring a channel from a User-Agent —
   * would be a guess written into an audit record.
   */
  readonly via?: HumanActor["via"];
  readonly mfa?: boolean;
  readonly onBehalfOf?: string;
}

/**
 * The seam a deployment plugs OIDC, mTLS or an internal SSO into.
 *
 * Injected for the same reason `DeliveryChannel` is: `@loom/core` must not learn any
 * vendor's API to stay zero-dependency, and identity is the most vendor-shaped thing in
 * a deployment. Everything the core needs is a subject and whether it belongs to a
 * person.
 *
 * Two rules, both fail-closed:
 *
 *  - **`undefined` means "this credential establishes nobody"**, not "let them through".
 *    The plane then tries the shared token, and answers 401 if that fails too.
 *  - **Throwing refuses the request.** A source whose upstream is down must throw (a
 *    `LoomError` with class `unavailable` becomes a 503); it must never return
 *    `undefined` and let the caller be treated as anonymous. An identity outage that
 *    degrades to "no identity" is how oversight quietly stops being enforced.
 *
 * It is only shown headers, method and path. The plane speaks plain HTTP — TLS is
 * terminated in front of it — so a client certificate reaches this seam as whatever
 * header the terminating proxy sets, and there is no socket to inspect here.
 */
export interface IdentitySource {
  /**
   * Named in `/health` and in refusals, so a misconfiguration is diagnosable.
   *
   * READ ONCE, when the `ControlPlane` is constructed, and bounded by `sourceLabel`.
   * `/health` is reachable without a credential and must answer from process-local state,
   * so a property that could run code — a getter, a Proxy — is not something it may touch
   * per request.
   */
  readonly name: string;
  /**
   * How many distinct principals this source can establish, if it knows.
   *
   * ADVISORY, and used for exactly one thing: deciding whether `startControlPlane` is
   * worth warning that this deployment has several principals and no isolation between
   * them (see `ControlPlane.distinctPrincipals`). It grants nothing and refuses nothing.
   *
   * A source that cannot say leaves it undefined and is assumed to have MANY — a source
   * exists to tell callers apart, so silence fails loud. Declaring `0` or `1` is what
   * suppresses the warning, and either is only honest for a source that really does
   * authenticate that many.
   *
   * `0` IS AN ANSWER, not a silence: it says "this source can authenticate nobody", which
   * `BearerTokenIdentity({subjects: []})` truthfully reports. It used to be folded in with
   * the undeclared case and warn about an isolation nothing implied — the empty source is
   * the one arrangement where several principals plainly do NOT exist, and a warning that
   * fires there is a warning operators learn to skip everywhere.
   */
  readonly principals?: number;
  identify(req: IdentityRequest): Promise<AuthContext | undefined> | AuthContext | undefined;
}

export interface BearerSubject {
  readonly token: string;
  readonly subject: string;
  /** Default `human`. A `service` entry is a named machine, not a person. */
  readonly kind?: AuthContext["kind"];
  readonly via?: HumanActor["via"];
  readonly mfa?: boolean;
}

/**
 * The built-in identity source: one bearer token per subject.
 *
 * Enough for the single binary, and deliberately no more. It answers the one question
 * the oversight layer asks — "whose token is this?" — with no directory, no session, and
 * no dependency. A deployment with real users replaces it by implementing
 * `IdentitySource`; nothing above this class knows which one it has.
 *
 * Tokens are indexed by SHA-256 of the token rather than by the token itself, and the
 * digest is what the lookup compares. That keeps the comparison independent of how much
 * of the presented string is right — a `Map` keyed by the raw secret is fine in theory
 * and one refactor away from a `startsWith` — and it keeps the raw secrets out of a heap
 * dump's key space.
 *
 * Two configurations are refused at construction rather than at 3 a.m.: an empty token,
 * and one token mapped to two subjects. The second is the interesting one — an ambiguous
 * credential would make "who approved this" depend on Map insertion order.
 */
export class BearerTokenIdentity implements IdentitySource {
  readonly name: string;
  /** Distinct SUBJECTS, not tokens: two credentials for one person are one principal. */
  readonly principals: number;
  readonly #bySha = new Map<string, AuthContext>();

  constructor(opts: { readonly subjects: readonly BearerSubject[]; readonly name?: string }) {
    this.name = opts.name ?? "bearer-token";
    const subjects = new Set<string>();
    for (const s of opts.subjects) {
      // ONE READ PER FIELD, into a `const`. This is configuration and not a live seam, but
      // it is still someone else's object: a getter that returns one subject to the
      // ambiguity check and another to the map would produce exactly the ambiguous
      // credential the check exists to refuse.
      const token = s.token;
      const subject = s.subject;
      const kind = s.kind;
      const via = s.via;
      const mfa = s.mfa;
      if (token === "") throw err.validation(CODES.E_CONFIG_INVALID, `identity source "${this.name}": subject "${subject}" has an empty token`);
      if (subject === "") throw err.validation(CODES.E_CONFIG_INVALID, `identity source "${this.name}": a token maps to an empty subject`);
      // THE THIRD REFUSED CONFIGURATION, and it is a fail-OPEN rather than an ambiguity.
      // `kind ?? "human"` below is right for an ABSENT field and was also what answered a
      // MISTYPED one, because nothing here could tell them apart — and the value it falls
      // back to is the STRONGER claim: `human` is the only kind that can satisfy a gate's
      // approvers list. `readIdentities` reads this file from JSON and drops what it does
      // not recognize, so `"kind": "servce"` — or `"SERVICE"` — turned a deployment's CI
      // credential into a person who may approve production actions, with `/whoami`, the
      // journal and the console all reporting a human because by then it was one.
      //
      // Refused here as well as in `readIdentities` on purpose. `checkedAuth` states the
      // rule for the injected seam ("fields that DECIDE … are refused when wrong") and a
      // guard that has to be remembered in the one caller that parses a file is a guard
      // the next caller will not have.
      if (kind !== undefined && kind !== "human" && kind !== "service") {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `identity source "${this.name}": subject "${subject}" declares kind ${JSON.stringify(kind)}, which is neither "human" nor ` +
            `"service". It is not dropped, because the default an absent kind takes is "human" — the one kind that can answer a gate ` +
            `naming approvers — so a mistyped "service" would silently become a person who may approve.`,
        );
      }
      const key = sha256(token);
      const clash = this.#bySha.get(key);
      if (clash !== undefined && clash.subject !== subject) {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `identity source "${this.name}": one token maps to both "${clash.subject}" and "${subject}"`,
        );
      }
      subjects.add(subject);
      this.#bySha.set(key, {
        kind: kind ?? "human",
        subject,
        method: this.name,
        ...(via === undefined ? {} : { via }),
        ...(mfa === undefined ? {} : { mfa }),
      });
    }
    this.principals = subjects.size;
  }

  identify(req: IdentityRequest): AuthContext | undefined {
    const header = req.headers["authorization"] ?? "";
    if (!header.startsWith("Bearer ")) return undefined;
    return this.#bySha.get(sha256(header.slice(7)));
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * How long a string an identity source may put into a record the journal will keep.
 *
 * A subject over this is REFUSED rather than truncated, and the difference matters: a
 * truncated authorization key is how `u:alice-contractor` silently becomes `u:alice`.
 * `DeliveryChannel`'s channel name is bounded for the same reason — injected code writes
 * into durable rows, and "it wouldn't do that" is not a bound.
 */
const MAX_IDENTITY_FIELD = 256;

/**
 * The journal's closed `via` vocabulary, written as a TOTAL map over the union.
 *
 * A `Set<string>` — which is what `cli.ts` had — compiles happily after someone adds a
 * member to `HumanActor["via"]` and silently starts rejecting it. This does not: the
 * `Record` is exhaustive, so the build breaks at the vocabulary that fell behind.
 */
const VIA_VOCABULARY: Readonly<Record<HumanActor["via"], true>> = {
  console: true,
  slack: true,
  feishu: true,
  teams: true,
  email: true,
  api: true,
  cli: true,
};

function isVia(v: unknown): v is HumanActor["via"] {
  // `hasOwn` and not `in`: `"constructor" in VIA_VOCABULARY` is true.
  return typeof v === "string" && Object.hasOwn(VIA_VOCABULARY, v);
}

/** A source's own `name`, bounded. It is injected too, and it reaches `/health`. */
function sourceLabel(source: IdentitySource): string {
  const name: unknown = source.name;
  return typeof name === "string" && name !== "" ? name.slice(0, MAX_IDENTITY_FIELD) : "(unnamed)";
}

/**
 * What an injected `IdentitySource` returned, checked before anything acts on it.
 *
 * `IdentitySource` sits on the far side of the same trust boundary as `DeliveryChannel`:
 * it is the deployment's own code, and a type annotation stops being a guarantee at a
 * seam. What comes back is an AUTHORIZATION KEY — matched against a gate's approvers list
 * and written into the journal as the subject of a decision — so it is validated rather
 * than cast, exactly as `defaultDecision` validates a channel's parsed callback.
 *
 * The two treatments are split on what a field DOES:
 *
 *  - fields that DECIDE — `subject` and `kind` — are refused when wrong. A missing,
 *    empty, over-long or non-string subject has no safe reading, and neither does a third
 *    `kind`; picking one writes a name into an audit record on the strength of a bug. The
 *    refusal is `internal` (500) with `E_CONFIG_INVALID`, because the caller cannot fix
 *    it and retrying will not help — what is broken is the deployment's source.
 *  - fields that DESCRIBE — `via`, `mfa`, `onBehalfOf` — are dropped when wrong, which is
 *    `readIdentities`' stated rule ("an unknown one is dropped, not coerced") applied to
 *    every source rather than only to the file the CLI reads. A `via` outside the closed
 *    vocabulary would corrupt a fold over the journal; taking the whole deployment down
 *    because an SSO added a label it liked is the wrong trade, and the `api` a dropped
 *    `via` falls back to is true — the decision did arrive over the API.
 *
 * EVERY SYNTHETIC MARKER is refused as a claimed subject — from `SYNTHETIC_SUBJECTS`,
 * which is the whole list rather than the one that was remembered. These are this file's
 * own words for what the perimeter concluded, not names: a source that returns
 * `(unidentified)` turns the absence of identity into a person, and one that returns
 * `(shared-token)` claims to BE the plane's shared-token service principal.
 */
function checkedAuth(who: unknown, source: string): AuthContext {
  // A declaration and not a const arrow, so its `never` narrows the flow below: `subject`
  // really is a string after its check, with no cast to say so.
  function refuse(what: string): never {
    throw err.internal(CODES.E_CONFIG_INVALID, `identity source "${source}" returned ${what}`);
  }

  if (typeof who !== "object" || who === null) refuse(`${typeof who}, which is not an AuthContext`);

  // A PROPERTY ACCESS AT THIS SEAM IS A CALL, AND THIS FUNCTION SAID SO WHILE MAKING SIX
  // BARE ONES. The paragraph below the reads used to state the rule — "a getter or a Proxy
  // answers the two reads differently … treat it as one" — as an argument for reading each
  // field ONCE. Reading it once is half of it: a getter that THROWS is not a value that
  // differs, it is no value at all, and it came out of this frame as a raw `TypeError`. The
  // route reports that as `E_INTERNAL` plus the getter's own words, which is the one thing
  // this function exists not to say — the deployment's source is what is broken, and the
  // refusal is supposed to name it. `readField` is `run/delivery.ts`'s `readProp` with the
  // primitive short-circuit already spent (`who` is an object by the line above); it is a
  // private copy for the reason that one is private, and the two must not drift.
  const raw = who as Record<string, unknown>;
  const readField = (key: string): unknown => {
    try {
      return raw[key];
    } catch {
      // Conflated with "absent", deliberately: every field below already has a total
      // reading for absence — the two that DECIDE refuse, the four that DESCRIBE fall back
      // — so a caller that has to tell the two apart is a caller that has to handle a throw
      // again.
      return undefined;
    }
  };

  const subject: unknown = readField("subject");
  if (typeof subject !== "string" || subject === "") refuse("a subject that is not a non-empty string");
  if (subject.length > MAX_IDENTITY_FIELD) refuse(`a subject of ${subject.length} characters (the limit is ${MAX_IDENTITY_FIELD})`);
  // THE SHAPE, NOT ONLY THE LIST. The list is what this file mints today; the parenthesised
  // FORM is what a marker looks like, and refusing it means a source cannot claim
  // `(admin)` or `(system)` either — markers this plane does not mint but a reader of a
  // journal would take for one of its own. `isSyntheticSubject` is the same rule the
  // compiler applies to an `approvers` list, stated once in `vocab.ts`.
  if (SYNTHETIC_SUBJECTS.includes(subject) || isSyntheticSubject(subject)) {
    refuse(
      `"${subject}" as a subject — a parenthesised subject is a synthetic marker like this control plane's own ` +
        `(${SYNTHETIC_SUBJECTS.join(", ")}), which describe what the perimeter concluded rather than name anyone, ` +
        `and no source may claim one`,
    );
  }

  const kind: unknown = readField("kind");
  // AND THE REFUSAL ITSELF HAD TO BE MADE TOTAL, which is the quieter half: this read
  // `JSON.stringify(kind)`, and `JSON.stringify` CALLS a caller-supplied `toJSON`. So the
  // check fired correctly and then the sentence describing the failure detonated, turning a
  // clean 500 with the source's name into the same raw `TypeError`. `JSON.stringify` of a
  // string cannot throw; nothing else is handed to it.
  if (kind !== "human" && kind !== "service") {
    refuse(
      `kind ${typeof kind === "string" ? JSON.stringify(kind.slice(0, MAX_IDENTITY_FIELD)) : `of type ${kind === null ? "null" : typeof kind}`}, ` +
        `which is neither "human" nor "service"`,
    );
  }

  // EVERY FIELD IS READ EXACTLY ONCE, INTO A `const`, and `via` was the one exception —
  // read once to test against the closed vocabulary and once to use. `who` is whatever an
  // injected source returned: a getter or a Proxy answers the two reads differently, so
  // the check passed on `console` while `telepathy` went into the journal.
  const method: unknown = readField("method");
  const via: unknown = readField("via");
  const mfa: unknown = readField("mfa");
  const onBehalfOf: unknown = readField("onBehalfOf");
  return {
    kind,
    subject,
    method: typeof method === "string" && method !== "" ? method.slice(0, MAX_IDENTITY_FIELD) : source,
    ...(isVia(via) ? { via } : {}),
    ...(typeof mfa === "boolean" ? { mfa } : {}),
    ...(typeof onBehalfOf === "string" && onBehalfOf !== "" && onBehalfOf.length <= MAX_IDENTITY_FIELD ? { onBehalfOf } : {}),
  };
}

/**
 * The idempotency namespace one caller's `Idempotency-Key` lives in.
 *
 * JSON-encoded rather than joined by a separator, so that no subject can be spelled to
 * collide with another's slot — the key is caller-chosen and the subject is source-chosen,
 * and a `:` in either would otherwise be a way to reach across.
 *
 * `method` and `kind` are in the slot as well as `subject` because the same name reached
 * through two different credentials is not obviously the same caller, and the two ways of
 * being wrong are not symmetric: too fine a slot costs a duplicate run, too coarse a slot
 * hands one principal another's.
 *
 * BOTH idempotent writes use it — run submission and gate resolution. The gate route did
 * not, and relied instead on `GateBroker.resolve` prefixing `actorId(actor)`, which
 * distinguishes identified humans and nobody else: every service principal and every
 * open-plane caller resolves to the same `UNIDENTIFIED_SUBJECT`. One helper, both doors,
 * so the next writer cannot get half of it.
 */
function idempotencySlot(auth: AuthContext | undefined, key: string): string {
  return JSON.stringify([auth?.method ?? "", auth?.kind ?? "", auth?.subject ?? "", key]);
}

// ---------------------------------------------------------------------------

export interface ControlPlaneOptions {
  readonly engine: Engine;
  readonly store: StateStore;
  readonly bus?: EventBus;
  /**
   * The SHARED bearer token: a service credential, not a person.
   *
   * It admits a caller to the API. It can never satisfy a gate's approvers list, because
   * every service in the deployment holds it and it therefore names nobody.
   *
   * **The empty string is REFUSED at construction.** It is not "no token" and it is not a
   * weak token — it authenticated EVERY caller, including one presenting no `Authorization`
   * header at all, while `/health` went on reporting `auth: "required"` and both boot
   * warnings stayed silent. One character of deployment slip (`--token "$LOOM_TOKEN"` with
   * the variable unset) produced a plane that looks supervised and is not.
   *
   * **OMITTING this option, together with `identity`, is how a deployment asks for an open
   * plane** — logged loudly at start, and reported as `auth: "open"`. That is deliberately
   * the ABSENCE of configuration rather than a value: no string an unset variable can
   * expand to spells it, so an open plane cannot be reached by substitution. There is no
   * `open: true` for the same reason — a second spelling of a posture is a second thing to
   * get wrong, and this one would be reachable by a typo.
   */
  readonly token?: string;
  /**
   * How a HUMAN is identified. Absent means no caller can prove who they are, so gates
   * that name approvers become unanswerable through the API — deliberately, and with an
   * error that says so.
   *
   * IT DOES NOT PARTITION ANYTHING. Configuring per-subject identities buys exactly one
   * thing — a gate can name an approver and the right person can answer it — and no
   * isolation between principals whatsoever: each of them reads, streams and cancels
   * every run in the journal. `startControlPlane` says so out loud when more than one
   * principal is configured, because this is the option whose presence implies otherwise.
   */
  readonly identity?: IdentitySource;
  /**
   * Time-to-first-byte deadline per request. Default 30 s.
   *
   * It bounds the wait BEFORE a response begins, so it cannot truncate an SSE stream
   * that has already started, and it covers every route rather than just the
   * unauthenticated one — any handler can hang before its first byte, and the
   * unauthenticated one is merely where a stranger gets to choose.
   *
   * A whole number from 1 to `MAX_TIMER_MS`. Anything else is refused by the constructor,
   * and the range is not defensive typing — see the refusal for what a larger one does.
   */
  readonly requestTimeoutMs?: number;
  /** Graphs the control plane will accept by name. Compiled ahead of time. */
  readonly graphs?: Readonly<Record<string, RunGraph>>;
  readonly now?: () => number;
  /**
   * Request body cap. Default 1 MiB; a whole number from 0 to V8's max string length.
   *
   * `NaN` and `Infinity` are refused because they do not loosen this cap, they DELETE it —
   * `size > NaN` is false for every size — and it is the one limit in this record with an
   * unauthenticated caller on the far side. `0` is legal and means "no request bodies".
   */
  readonly maxBodyBytes?: number;
  /**
   * How far back a reconnect may replay before getting a snapshot instead. Default 10 000.
   *
   * Same range and the same reason: `head - lastSeq > NaN` is false, so a `NaN` here makes
   * every reconnect replay the journal event by event instead of ever taking a snapshot.
   */
  readonly hotWindow?: number;
  /**
   * Channels that may be ANSWERED, which opens the unauthenticated callback route.
   *
   * ABSENT is the default and means the route does not exist and neither does its auth
   * carve-out — a deployment that never wired an inbound channel does not get an
   * endpoint it has to reason about. Present, the route accepts exactly the channels
   * this dispatcher knows that implement `parseCallback`.
   */
  readonly dispatcher?: GateDispatcher;
}

/**
 * The largest delay a Node timer can hold — 2³¹−1 ms, about 24.8 days.
 *
 * `setTimeout` keeps its delay in a 32-bit signed integer and TRUNCATES anything larger to
 * ONE MILLISECOND. It does not saturate and it does not throw; it prints a
 * `TimeoutOverflowWarning` that names no call site. `src/cli.ts` carries the same constant
 * for the durations it reads out of flags and config files, and says more about why;
 * neither exports it, because a platform fact does not belong on the pinned public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The other two caller-supplied numbers, bounded — because a cap is a GUARD and `NaN`
 * silently removes one.
 *
 * `MAX_TIMER_MS`'s sibling, and the correction to the sweep that produced it. That sweep
 * was organised by PLATFORM API — `grep -ranE '(setTimeout|setInterval|AbortSignal\.timeout
 * |\.listen)\(' packages/core/src` — so it cleared `maxBodyBytes` and `hotWindow` on the
 * grounds that they "reach no platform API with a range". True, and beside the point: what
 * makes a number dangerous is what it is COMPARED AGAINST, not what consumes it. Every
 * comparison against `NaN` is `false`, so a knob whose whole job is to say "stop here"
 * stops nothing.
 *
 * Reproduced against this class, 8 MiB of JSON at `POST /runs` with the default cap at
 * 1 MiB:
 *
 *     maxBodyBytes (default) → 400 E_PROVIDER_BAD_REQUEST "request body exceeds 1048576 bytes"
 *     maxBodyBytes: NaN      → the whole 8 MiB buffered, concatenated and JSON.parsed
 *     maxBodyBytes: Infinity → the same
 *
 * That is the one member of this family a REMOTE party has leverage on: the request-body
 * cap is what stands between an unauthenticated `POST /runs/:id/callbacks/:channel` and
 * this process's heap, and one `NaN` in a config file removes it while every other surface
 * goes on reporting a healthy plane. `hotWindow: NaN` is quieter — the `head - lastSeq >
 * hot` test goes false, so every reconnect takes the REPLAY branch and a run with a million
 * events is streamed frame by frame to a browser that asked for a snapshot.
 *
 * `0` stays legal for both: "accept no request body" and "always snapshot" are things an
 * operator can coherently want, exactly as `gracePeriodMs: 0` is. The ceiling is V8's
 * maximum string length because `#readBody` ends at `raw.toString("utf8")`, so a cap above
 * it is a cap this process could not honour even if the memory were there.
 */
function boundedCount(v: unknown, where: string, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > BUFFER.MAX_STRING_LENGTH) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `ControlPlaneOptions.${where} must be a whole number from 0 to ${BUFFER.MAX_STRING_LENGTH}, not ` +
        `${typeof v === "number" ? String(v) : typeof v}. It is a ${what}, and every comparison against \`NaN\` is false — ` +
        `so a cap set to one is not a loose cap, it is no cap, while /health goes on reporting a healthy plane.`,
    );
  }
  return v;
}

/**
 * How long `close()` waits for a mid-response connection before cutting it.
 *
 * NOT a knob: an operator is not choosing a policy here, they are choosing how long
 * shutdown blocks, and the answer for a plane whose signature response is an endless SSE
 * stream is "briefly". It matches `sandbox/subprocess.ts`'s `DEFAULT_GRACE_MS` on purpose
 * — same shape, same reasoning: ask politely, then insist.
 */
const CLOSE_GRACE_MS = 2000;

/** The ONE path that skips the bearer check. Kept beside the check that reads it. */
const CALLBACK_PATH = /^\/runs\/([^/]+)\/callbacks\/([^/]+)$/;

/** How many runs `GET /runs` lists when the caller does not say. */
const DEFAULT_RUN_PAGE = 50;

/**
 * `?limit=` — REFUSED when it is not a page size, never guessed at.
 *
 * This was `Number(raw ?? "50")` followed by `listRuns(Number.isFinite(limit) ? limit :
 * 50)`, and it is the caller-supplied-number defect one layer out from the ones the
 * constructor now bounds: FINITENESS is the single property a `LIMIT` clause does not care
 * about, so the guard rejected `abc` by silently substituting a different page size and
 * passed every other malformed value straight into SQL. Measured against both stores with
 * six runs in each:
 *
 *     ?limit=abc  → 6 runs   (the guard's silent 50 — a malformed input, answered 200)
 *     ?limit=-1   → SqliteStateStore 6, MemoryStateStore 5
 *     ?limit=1.5  → SqliteStateStore THREW "datatype mismatch"; MemoryStateStore 1
 *     ?limit=1e21 → SqliteStateStore THREW "datatype mismatch"
 *
 * Three failures on one expression. `-1` is `LIMIT -1`, which SQLite reads as **no limit**
 * — the cap the caller asked for, deleted by the caller — while the memory store reads the
 * same value as `slice(0, -1)` and drops the newest run, so one request has two answers
 * and neither was requested. `1.5` reaches the real store as a `datatype mismatch`, which
 * `#dispatch` maps to a 500: "a bug in Loom", for a query string a stranger typed.
 *
 * 400 IS THE LOUD ANSWER FOR A REQUEST, the way refusing to start is for configuration:
 * the caller can fix it and is the only one who can. The ceiling is
 * `Number.MAX_SAFE_INTEGER` and it is a PLATFORM bound rather than a page policy —
 * `listRuns(2 ** 53)` is fine and `listRuns(1e21)` is a `datatype mismatch` — because
 * inventing a maximum page size here would be a decision the store's interface should
 * make, and one nobody could find later.
 */
function pageLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_RUN_PAGE;
  // `Number("")` and `Number(" ")` are 0, which is a legal page size nobody typed, so the
  // emptiness check is not tidiness — it is the difference between "no runs" and "no
  // value". `Number("0x2")` is 2 for the same family of reasons.
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n)) {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `?limit must be a whole number of runs from 0 to ${Number.MAX_SAFE_INTEGER}, not "${raw}". It is passed to the journal as a ` +
        `page size: a negative one is read as NO limit by SQLite and as "drop the newest" by the in-memory store, and a fractional ` +
        `one is a datatype mismatch the API would report as an internal error. Omit it for ${DEFAULT_RUN_PAGE}.`,
    );
  }
  return n;
}

/**
 * A compiled graph by name — THE lookup, so no route indexes the map directly.
 *
 * `#graphs` is an ordinary object, so `graphs["constructor"]` answers with the `Object`
 * FUNCTION and `graphs["__proto__"]` with `Object.prototype`: not `undefined`, therefore
 * "found", and `POST /runs`'s `if (graph === undefined) throw notFound` — the only thing
 * between a caller-chosen string and `engine.submit` — never fired. Measured on an open
 * plane with one graph configured, one request per name:
 *
 *     {"workflow":"constructor"}    → 500 E_INTERNAL TypeError: Cannot read properties of undefined (reading 'nodes')
 *     {"workflow":"__proto__"}      → 500, the same
 *     {"workflow":"toString"}       → 500, the same
 *     {"workflow":"valueOf"}        → 500, the same
 *     {"workflow":"hasOwnProperty"} → 500, the same
 *     {"workflow":"isPrototypeOf"}  → 500, the same
 *     {"workflow":"nope"}           → 404 E_RESOURCE_NOT_FOUND
 *
 * `E_INTERNAL` is this system's word for "a bug in Loom", handed out for a string a
 * stranger typed into a request body. Nothing was journaled on the way — `submit` threw
 * before writing — so the cost is the misfiled status and what it does to an operator
 * reading their error rates, not a corrupt run.
 *
 * THE TWO CONDITIONS ARE `gateIn`'s, DELIBERATELY, and this is the third place in this
 * repo that needs them: `projection.ts`'s `gateOf`/`gateIn` for gate ids and `redact.ts`'s
 * `put` for the write half. A third VARIANT — a null-prototype copy, a `Map` — would be a
 * third thing to get right; the same two lines are one thing to remember. Only `__proto__`
 * has a setter on `Object.prototype`, so only it corrupts on write; every other inherited
 * name misleads on read, which `hasOwnProperty` answers.
 */
function graphIn(graphs: Readonly<Record<string, RunGraph>>, name: string): RunGraph | undefined {
  return name !== "__proto__" && Object.prototype.hasOwnProperty.call(graphs, name) ? graphs[name] : undefined;
}

/**
 * The decision this API will forward — the four-member union, CHECKED, never cast.
 *
 * `POST /runs/:id/gates/:gateId` read `(await body()) as { decision?: GateDecision }` and
 * asked only whether the field was present. `GateDecision` has four members with required
 * fields per member, everything downstream branches on `kind === "reject"`, and a cast
 * checks none of it — so every unreadable decision was a GO-AHEAD. Measured end to end on
 * the skeleton graph, one fresh run each, the last column being whether the action BEHIND
 * the gate actually ran:
 *
 *     {"kind":"approve"}             → 200 succeeded  writes=1  gate.decided decision="approve"
 *     {"kind":"reject","reason":…}   → 200 failed     writes=0  gate.decided decision="reject"
 *     {"kind":"REJECT"}              → 200 succeeded  writes=1  gate.decided decision="REJECT"
 *     "reject"                       → 200 succeeded  writes=1  gate.decided, no decision field
 *     {}   /   42   /   [1]          → 200 succeeded  writes=1  gate.decided, no decision field
 *     {"kind":"nope"}                → 200 succeeded  writes=1  gate.decided decision="nope"
 *     {"kind":"redirect"}            → 200 succeeded  writes=1
 *     {"kind":"reject"}  (no reason) → 500 E_INTERNAL writes=0
 *     {"kind":"edit"}    (no writes) → 500 E_INTERNAL writes=0
 *
 * An operator's caps-lock approves a production action, and the journal keeps
 * `decision: "REJECT"` beside it — a word in no vocabulary, recorded as what a human
 * decided. That is D7.9's "looks supervised, is not" reached by typing, and it is the
 * Traps list's *approve means "go ahead"* one layer up: **anything not understood defaulted
 * to the permissive reading.**
 *
 * THE ACCEPTANCE SET IS NO LONGER THIS FUNCTION'S TO STATE. It was written from
 * `ownedDecision` in `run/delivery.ts`, member for member, "so the two doors agree and
 * unifying them later is a deletion rather than a reconciliation" — and by the time that
 * was checked there were THREE such switches (this one, that one, and `run/replay.ts`'s,
 * whose `default:` arm answered `{kind:"approve"}`), guarding a broker that asserted the
 * set not at all. They had already drifted. `gateDecisionOf` in `vocab.ts` is the one
 * statement now; this door keeps only what is genuinely its own — an HTTP status and a
 * message naming the field the caller got wrong, which a total function returning
 * `undefined` cannot give them.
 *
 * It reads plain data — `#readBody` is a `JSON.parse` with no reviver — so a field may be
 * read twice without the two reads disagreeing, unlike `checkedAuth`'s input. That is why
 * the messages below may re-read `kind` after the guard has answered.
 */
function checkedDecision(v: unknown): GateDecision {
  function refuse(why: string): never {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `"decision" ${why}. It must be one of {"kind":"approve"}, {"kind":"reject","reason":"…"}, ` +
        `{"kind":"edit","writes":{…}} or {"kind":"redirect","take":["edgeId"]} — this endpoint refuses what it cannot read ` +
        `rather than treating it as approval.`,
    );
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    refuse(`is ${v === null ? "null" : Array.isArray(v) ? "an array" : typeof v}, which is not a decision`);
  }
  const d = v as Record<string, unknown>;
  const decision = gateDecisionOf(d);
  if (decision === undefined) {
    const kind: unknown = d["kind"];
    if (kind === "reject") refuse('is a rejection with no reason — "reject" requires a non-empty `reason`');
    if (kind === "edit") refuse('is an edit with no `writes` object — "edit" requires `writes` to be a JSON object of channel values');
    if (kind === "redirect") refuse('is a redirect with no `take` — "redirect" requires `take` to be an array of edge ids');
    refuse(`names kind ${JSON.stringify(kind)}, which is not one of "approve", "reject", "edit", "redirect"`);
  }
  // A rejection with no reason is the one member whose missing field used to be a 500. The
  // reason stays REQUIRED rather than defaulted — "why was this refused" is the whole value
  // of a rejection in the audit trail, and `cli.ts`'s `--reject` with no value supplies
  // `(no reason given)` explicitly rather than leaving it blank. `gateDecisionOf` decides
  // the SHAPE (a string); non-empty is this door's policy and `HumanGateBroker.#validate`
  // states it again at the point of use.
  if (decision.kind === "reject" && decision.reason.trim() === "") {
    refuse('is a rejection with no reason — "reject" requires a non-empty `reason`');
  }
  return decision;
}

/**
 * An operator's reason for a cancel or a rewind — a string, because it is JOURNALED.
 *
 * `engine.cancel(runId, cmd.reason ?? "operator")` writes it into `operator.command`'s
 * payload and interpolates it into every gate cancellation the tree produces, so it came
 * off the same cast as `decision` and reached the journal as whatever was sent. Absent
 * stays legal and means the default the route already supplies.
 */
function checkedReason(v: unknown, fallback: string): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string") {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `"reason" must be a string, not ${Array.isArray(v) ? "an array" : v === null ? "null" : typeof v}: it is journaled on operator.command ` +
        `and quoted into the cancellation of every gate this command closes. Omit it for "${fallback}".`,
    );
  }
  return v;
}

interface Route {
  readonly method: string;
  readonly pattern: RegExp;
  handle(ctx: RequestContext): Promise<void>;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: readonly string[];
  readonly url: URL;
  /**
   * Who the credential says is calling; `undefined` when nothing established anyone.
   *
   * On every route that requires the bearer token this is non-`undefined` by the time a
   * handler runs — `#serve` has already answered 401 otherwise. It is ALWAYS `undefined`
   * on the three open routes, whatever the caller presented, because resolving a
   * principal there would mean calling an injected identity source on a stranger's
   * behalf. A handler that wants to distinguish credentialed callers on an open route
   * has to do it from process-local state; `/health` does.
   */
  readonly auth: AuthContext | undefined;
  /** A JSON object, always — `#readBody` refuses `null`, an array and every scalar. */
  body(): Promise<Record<string, unknown>>;
  /** The bytes, unparsed. Only a signature check has any business with these. */
  raw(): Promise<Buffer>;
}

export class ControlPlane {
  readonly #routes: readonly Route[];
  /**
   * Run submissions already ACKed, keyed by `Idempotency-Key` **and by principal**.
   *
   * The key alone was a shared namespace. That was sound while the plane had exactly one
   * principal and became a cross-principal collision the moment it had per-subject ones:
   * the header is a string the CALLER chooses, and two teams both call their nightly job
   * "nightly". Whoever submitted second was handed the first's `runId` — and with it the
   * projection and the event stream of a run they did not submit — while their own
   * submission was silently never made. See `idempotencySlot`.
   *
   * It is process-lifetime and unbounded, which is a stated limit and not a design: one
   * small entry per distinct key, for the life of the process. Bounding it changes what
   * "idempotent" means at this boundary — an evicted key stops collapsing, so a slow
   * retry becomes a second run — and that is a decision with its own test rather than a
   * line to slip into this one.
   */
  readonly #idempotency = new Map<string, unknown>();
  readonly #callbacks: GateCallbackRouter | undefined;
  /**
   * The identity source's own name, read ONCE here and never off the object again.
   *
   * `null` when there is no source. Capturing it is what makes `/health`'s claim to
   * answer "from process-local state alone" true: `name` is a property on an injected
   * object, so reading it per request is running deployment code on the one route a
   * stranger can reach, and a source whose name is a getter could answer two probes
   * differently or two error messages inconsistently.
   *
   * A source whose `name` getter throws therefore takes the process down at construction,
   * where an operator is watching — the same trade `BearerTokenIdentity` makes for an
   * ambiguous token.
   */
  readonly #identityName: string | null;
  /**
   * The identity source itself, resolved from the options ONCE.
   *
   * `ControlPlaneOptions` is a record a caller builds, and `identity` is the field on it
   * that holds behaviour rather than a value. Re-reading it per request is the same
   * mistake as re-reading `via`, one level up: `/health` would name the source captured at
   * construction while requests authenticated against whatever the property answered this
   * time. One read, one source, for the life of the process.
   */
  readonly #identity: IdentitySource | undefined;
  /**
   * The shared token, read ONCE and validated, or `undefined` when there is none.
   *
   * Captured for the same reason `#identity` is, and it was the missing half of that rule:
   * `ControlPlaneOptions` is a record a caller builds, so re-reading `opts.token` on every
   * request means a getter could answer the constructor's validation with one value and
   * `#sharedToken` with another. One read, one secret, for the life of the process.
   */
  readonly #token: string | undefined;
  /**
   * EVERY option, read ONCE at construction — there is no `#opts` field to re-read.
   *
   * Captured for the reason `#token` and `#identity` were: `ControlPlaneOptions` is a
   * record a CALLER builds, so a property on it can be a getter, a Proxy, or simply
   * assigned again later, and a per-request read means the value the constructor validated
   * is not the value the request enforces.
   *
   * **THIS USED TO BE A COUNT AND THE COUNT WAS WRONG.** The docstring here said
   * `maxBodyBytes` and `hotWindow` "were the last two options still read off `#opts` per
   * request"; there were five, and the one it missed is the option in this record with a
   * reproduction written next to its refusal. Measured against this class, with the plain
   * record MUTATED after construction — no getter required — and an identity source
   * answering in 5 ms:
   *
   *     before mutation → 200 {"runs":[]}
   *     after  mutation → 504 "no response for /runs within 2147483648ms"
   *
   * which is verbatim the failure `requestTimeoutMs`'s constructor check exists to
   * prevent, on a plane whose constructor validated 30 000. `graphs` was read on
   * `/health`, which is the one route a stranger reaches and the route whose whole promise
   * is that it "answers from process-local state alone".
   *
   * **AND THE RULE THAT REPLACED THE COUNT WAS ALSO WRONG, WHICH IS THE USEFUL PART.** It
   * read "the constructor is the only method that may name the options record", and by that
   * spelling the class already complied while the property did not: `logFor`, the factory
   * this constructor hands `GateCallbackRouter`, is a CLOSURE OVER `opts`, so `opts.store`,
   * `opts.bus` and `opts.now` were read *inside the constructor's own source text* and
   * *per request*, from the one route reachable without a credential. WHERE a read is
   * written and WHEN it happens are different questions, and only the second one matters.
   *
   * Reproduced against this class, plain assignment after `listen` — no getter, no Proxy —
   * with a correctly-signed callback naming a different run (a refusal past the perimeter,
   * so `GateCallbackRouter` journals it through `logFor`):
   *
   *     record.store = someOtherStore;  record.now = () => 4102444800000;
   *     POST /runs/:id/callbacks/slack  → 400 E_PROVIDER_BAD_REQUEST (as designed)
   *     the run's OWN journal           → (no refusal row)
   *     the store swapped in            → 1:gate.callback_rejected@4102444800000
   *
   * The one durable record that an unauthenticated endpoint is being hammered went to a
   * store this plane was never constructed with, stamped from a clock it was never
   * constructed with, while every other route went on writing to the real one. That is
   * invariant 2 reached around by an assignment.
   *
   * The rule, restated so it is about time rather than about syntax: **no value used to
   * serve a request may be read off the options record after the constructor returns —
   * including by a function the constructor created.** Every collaborator below is
   * therefore captured into a field, and the closure reads the FIELDS.
   * `test/server/http.test.ts`'s *THE OPTIONS RECORD IS READ AT CONSTRUCTION AND NEVER
   * AGAIN* now wires a dispatcher and drives a durable callback refusal, because the
   * version that did not could not see any of this: with no `dispatcher` in the record
   * there is no `logFor`, so the test asserted zero reads of a closure that was never
   * built.
   *
   * `undefined` keeps its meaning for the two caps and the deadline — "use the default" —
   * and the defaults stay at the use sites, so these fields carry no policy.
   */
  readonly #maxBodyBytes: number | undefined;
  readonly #hotWindow: number | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #graphs: Readonly<Record<string, RunGraph>>;
  readonly #engine: Engine;
  readonly #store: StateStore;
  readonly #bus: EventBus | undefined;
  /**
   * The injected clock, captured like every other collaborator.
   *
   * A field rather than a local `const` because it is read from a CLOSURE that outlives the
   * constructor — `logFor` — and a field is what makes "the closure reads captured state"
   * checkable by reading the closure instead of by tracing what `opts` was at the time.
   */
  readonly #now: (() => number) | undefined;
  /**
   * WHETHER A CALLER WHO PRESENTS NOTHING IS ADMITTED — decided once, read everywhere.
   *
   * `/health`'s `auth` field, `#healthDiagnostics`, `#principal`'s last line and both boot
   * paths' "NO TOKEN" warning are five readings of this one fact, and they used to be five
   * separate derivations of `token === undefined && identity === undefined`. An empty
   * token made four of them disagree with the fifth — the plane admitted everyone while
   * `/health` said `required` — which is what turned a comparison bug into a perimeter that
   * lied about itself. Deriving them all from one field is what keeps the story single.
   *
   * Public because the boot paths are outside this class: `startControlPlane` for the
   * library and `loom serve` for the single binary. It is a fact about CONFIGURATION; no
   * request has to have arrived and no injected code is consulted.
   */
  readonly openToEveryCaller: boolean;
  /**
   * How many principals this deployment can authenticate — all of which have IDENTICAL,
   * UNSCOPED access to every run.
   *
   * `Infinity` when an identity source will not declare a count. The shared token is one
   * principal; an open plane is one principal; a source contributes what it declares, and
   * a source that declares ZERO contributes zero — a plane no caller can get into, which
   * is a different thing from one whose callers are not isolated.
   *
   * Exposed rather than kept private because it is the input to the boot warning, and
   * both boot paths need it: `startControlPlane` for the library, `loom serve` for the
   * single binary. It is a fact about CONFIGURATION — no request has to have arrived, and
   * no injected code is consulted to compute it, because both halves were read at
   * construction. See "THE LIMIT" in the module docstring for what is not scoped.
   */
  readonly distinctPrincipals: number;
  #server: Server | undefined;
  /**
   * The in-flight `close()`, so a second one waits for the socket instead of for nothing.
   *
   * It is a SEPARATE field from `#server` because the two answer different questions and
   * the bug was reading one for the other: `#server === undefined` means "not accepting",
   * which becomes true at the START of a close, while "released" only becomes true at its
   * end — up to `CLOSE_GRACE_MS` later. `undefined` here means no close is in flight.
   */
  #closing: Promise<void> | undefined;

  constructor(opts: ControlPlaneOptions) {
    // REFUSED HERE, so a misconfigured deployment fails to start instead of starting wide
    // open. `BearerTokenIdentity` refuses the identical configuration two hundred lines
    // above, and the plane owed its own perimeter the same strictness: an empty expectation
    // makes `#sharedToken`'s constant-time compare true for every caller, credential or no
    // credential, while `/health`, `/whoami` and both boot warnings keep saying the
    // opposite. A weak secret is a risk; this was no secret at all, spelled like one.
    //
    // The fix has to be a refusal rather than a fallback to "open", because the two
    // possible readings of an empty token — "they meant no auth" and "their variable was
    // unset" — are indistinguishable here and only one of them is survivable. The message
    // names the deliberate alternative so an operator who really did mean an open plane
    // knows how to say it.
    //
    // The condition is ANYTHING OF LENGTH ZERO and not just `""`, because what breaks the
    // compare is the length: a caller who reached past the type with `[]` would get the
    // same open plane by the same arithmetic. The type says `string`, and a type stops
    // being a guarantee at the point where being wrong costs the perimeter.
    const token = opts.token;
    if (token !== undefined && (typeof token !== "string" || token === "")) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        typeof token === "string"
          ? `ControlPlaneOptions.token is the empty string, which would authenticate EVERY caller — including one presenting no Authorization header — ` +
              `while /health still reported auth "required". This is what \`--token "$LOOM_TOKEN"\` does when the variable is unset. ` +
              `Set a real token, or omit both this option and \`identity\` to run an open plane on purpose.`
          : `ControlPlaneOptions.token must be a non-empty string, not ${typeof token}: the shared-token compare is over LENGTH, ` +
              `so anything of length zero authenticates every caller.`,
      );
    }
    this.#token = token;
    // THE OTHER OPTION THAT BECOMES ITS OWN OPPOSITE, refused at the same point and for
    // the same reason: a value that reads as one posture and installs another.
    //
    // `#withDeadline` hands this to `setTimeout`, which truncates a delay above
    // `MAX_TIMER_MS` to ONE MILLISECOND. Reproduced against a live plane whose identity
    // source answers in 5 ms — a fast SSO by any standard — where one increment is the
    // whole difference:
    //
    //     requestTimeoutMs=2147483648 → 504 "no response for /runs within 2147483648ms"
    //     requestTimeoutMs=2147483647 → 200 {"runs":[]}
    //
    // The 504 quotes 24.8 days at an operator whose deadline was a millisecond, and it is
    // INTERMITTENT — a handler that beats the tick still answers — so it presents as
    // flapping 504s on every route rather than as a broken configuration. Zero and
    // negatives arrive at the same place by a shorter route: `??` defaults only on
    // `undefined`, so `0` is a deadline that has already passed.
    //
    // REFUSED RATHER THAN CLAMPED, on `cli.ts`'s argument at `positive`: a clamp has no one
    // safe direction across the callers of a duration, and a silent clamp is the defect
    // itself. Nothing real is refused — 24.8 days is not a request deadline anybody means.
    const deadline = opts.requestTimeoutMs;
    if (deadline !== undefined && (typeof deadline !== "number" || !Number.isInteger(deadline) || deadline <= 0 || deadline > MAX_TIMER_MS)) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `ControlPlaneOptions.requestTimeoutMs must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS} (~24.8 days), not ` +
          `${typeof deadline === "number" ? String(deadline) : typeof deadline}. Node keeps a timer delay in 32 bits and truncates ` +
          `a larger one to ONE MILLISECOND, so this would answer 504 to every request slower than a millisecond — on every route, ` +
          `quoting the deadline you asked for in the body.`,
      );
    }
    this.#requestTimeoutMs = deadline;
    // THE TWO CAPS, refused at the same point and for the same reason — see `boundedCount`.
    // A `NaN` here is not a loose limit, it is the absence of one, and the request-body cap
    // is the only member of this family with a remote party on the far side.
    this.#maxBodyBytes = boundedCount(opts.maxBodyBytes, "maxBodyBytes", "cap on how many bytes of request body are buffered");
    this.#hotWindow = boundedCount(opts.hotWindow, "hotWindow", "threshold that decides replay-versus-snapshot on reconnect");
    // THE COLLABORATORS, captured for the same reason as the numbers rather than for a
    // different one. `graphs` reached `/health` — the route that promises to answer from
    // process-local state alone — and `engine`, `store` and `bus` were re-read inside
    // `#streamEvents` and `#refuseUnidentifiedApproval` long after the routes had already
    // closed over them. `graphs` defaults to `{}` HERE so no use site has to remember to.
    this.#graphs = opts.graphs ?? {};
    this.#engine = opts.engine;
    this.#store = opts.store;
    this.#bus = opts.bus;
    this.#now = opts.now;
    const source = opts.identity;
    this.#identity = source;
    this.#identityName = source === undefined ? null : sourceLabel(source);
    // The posture, decided once. Configuring NOTHING is the only way to be open — an
    // absence, not a value, so no expansion of an unset variable can produce it.
    this.openToEveryCaller = token === undefined && source === undefined;
    // Read once, at construction, and validated: `principals` is injected too. Anything
    // that is not a whole non-negative number is "this source will not say", which is the
    // loud answer rather than the quiet one.
    //
    // ZERO IS AN ANSWER, and it used to fall into the silent-source branch. A source
    // declaring it can authenticate NOBODY — `BearerTokenIdentity({subjects: []})` — became
    // `Infinity` and fired the isolation warning, which this rule reserves for deployments
    // where isolation is IMPLIED. A warning that fires on the empty case is one operators
    // learn to skip, and it is then not there for the case it was written for.
    const declared: unknown = source?.principals;
    const fromSource =
      source === undefined
        ? 0
        : typeof declared === "number" && Number.isInteger(declared) && declared >= 0
          ? declared
          : Infinity;
    // An open plane has exactly one principal: the anonymous `service` context `#principal`
    // yields. Otherwise it is what the configured credentials establish — possibly zero,
    // for a source that can authenticate nobody and no shared token, which is a plane no
    // caller can get into. Zero is the honest count there, and it warns about nothing.
    this.distinctPrincipals = this.openToEveryCaller ? 1 : (token === undefined ? 0 : 1) + fromSource;
    // EVERY NAME BELOW IS A FIELD OR A LOCAL, and `logFor` is why that matters rather than
    // being tidiness. It is a closure the constructor builds and `GateCallbackRouter` calls
    // PER REQUEST, from the unauthenticated callback route, to journal a refusal — so
    // `store`, `bus` and `now` spelled as `opts.store`, `opts.bus`, `opts.now` here were
    // reads of the caller's record long after the constructor returned, in the one place
    // whose output is durable. See the field block above for what that measured.
    const dispatcher = opts.dispatcher;
    this.#callbacks =
      dispatcher === undefined
        ? undefined
        : new GateCallbackRouter({
            dispatcher,
            engine: this.#engine,
            logFor: (runId) =>
              new RunLog(runId, {
                store: this.#store,
                ...(this.#bus === undefined ? {} : { bus: this.#bus }),
                ...(this.#now === undefined ? {} : { now: this.#now }),
              }),
            ...(this.#now === undefined ? {} : { now: this.#now }),
          });
    this.#routes = this.#buildRoutes();
  }

  /**
   * Bind the socket, or REJECT — never die from an event nobody listens to.
   *
   * Every other refusal in this class happens before the socket exists. This is the
   * failure ON it, and it is the one none of them could reach: the bind is the first
   * thing here that can fail for a reason no amount of validating the *number* removes.
   * `--port 1` is a whole number in range; so is `--port 80`; so is any port another
   * process already holds.
   *
   * It used to resolve from the `listening` callback with no `'error'` listener attached,
   * which cost two things at once. Node turns an `'error'` on an `EventEmitter` with no
   * listener into an UNCAUGHT EXCEPTION, so `loom serve --port 1` ended as
   * `Unhandled 'error' event … listen EACCES: permission denied 127.0.0.1:1` over a raw
   * stack trace — the exact failure `cli.ts`'s `httpPort` docstring cited as its reason
   * for existing, still reachable through every legal value it admits. And the promise
   * never settled, so an embedder who caught the exception was left awaiting a bind that
   * had already failed.
   *
   * `E_CONFIG_INVALID` deliberately, and not a transport class: EADDRINUSE and EACCES are
   * different syscall errnos with one operator action between them — choose another port,
   * or stop what is holding this one. The OS's own `code`/`errno`/`syscall` go in
   * `details` so the diagnosis is not lost in the translation.
   *
   * THE LISTENER IS REMOVED ONCE LISTENING, which is a choice rather than an oversight. A
   * permanent one could only swallow — there is nothing here to report through — and a
   * plane that keeps running with a dead server while every surface says it is healthy is
   * the failure mode this whole file is arranged against. A post-`listening` `'error'`
   * therefore still ends the process, loudly, which for an accept-time failure is the
   * honest outcome. It is also, deliberately, not something this repo can drive from a
   * test: `#server` is private, so a guard for it would be one nothing holds.
   *
   * **A SECOND `listen` WHILE ONE IS BOUND IS REFUSED**, and the refusal is the point of
   * `#server` existing at all. It used to overwrite the field, which made the first
   * `Server` unreachable: `#server` is private, so nothing — not `close()`, not the
   * caller — could ever reach it again, and it stayed bound and serving for the life of
   * the process while `close()` resolved successfully having closed only the second. On a
   * tokenless plane that is a control-plane socket nobody knows is open.
   *
   * Refused rather than silently closing the first, for the reason the constructor refuses
   * an empty token rather than defaulting to open: the two readings of `listen(a);
   * listen(b)` — "move the plane to b" and "my retry ran twice and I did not notice" — are
   * indistinguishable here, and only one of them survives being guessed at. Closing the
   * first would abort the in-flight requests of a socket the caller never named. The
   * deliberate spelling of a rebind is `await close()` then `listen`, which is two calls
   * because it is two decisions.
   *
   * **A RETRY AFTER A FAILED BIND IS NOT A SECOND `listen`**, and this is why the refusal
   * is "while one is BOUND" rather than "ever". `listen(80)` → EACCES → `listen(8080)` is
   * the ordinary shape, and nothing is bound when it happens, so the error path releases
   * the field. Making the legitimate case unreachable would have been the same class of
   * over-refusal this method exists to avoid.
   *
   * A PORT NO SOCKET CAN HOLD throws SYNCHRONOUSLY out of `server.listen`, which is a
   * different path from the bind failures above and used to escape this contract entirely:
   * `ERR_SOCKET_BAD_PORT` is a `RangeError`, so `listen(-1)` and `listen(65536)` rejected
   * with a raw platform error carrying no `E_CONFIG_INVALID`, no `details`, and none of the
   * text a caller was promised. Measured — `-1`, `65536`, `1.5`, `NaN` and `2 ** 31` all
   * take it, while `"80"` (a string) reaches the OS and fails EACCES like any other
   * privileged port. It is caught and mapped here so the contract has one shape.
   *
   * **`close()` DURING A BIND IS A THIRD OUTCOME, and it used to be no outcome at all.**
   * Two settle paths — `'listening'` and `'error'` — cover the two ways a bind can end,
   * and there is a third way it can end: someone else takes the socket away. Node's
   * `emitListeningNT` is `if (self._handle) self.emit('listening')`, and `Server.close`
   * nulls `_handle` synchronously, so a `close()` landing in the tick between
   * `server.listen(...)` and that callback silences BOTH paths. Reproduced against this
   * class: `const p = plane.listen(0); plane.close();` → `close()` resolved, and `p` had
   * **still not settled after 1500 ms** — for the same reason and with the same cost as
   * the missing `'error'` listener above, one event later. `'close'` is therefore the
   * third listener, and it rejects: nothing is bound and nothing will be.
   */
  async listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    if (this.#server !== undefined) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `this ControlPlane is already listening; a second listen() would leave the first socket bound with no way to reach it — ` +
          `close() can only ever close the last. Call \`await plane.close()\` first if you meant to rebind.`,
      );
    }
    const server = createServer((req, res) => {
      // NOTHING MAY ESCAPE THIS CALLBACK. It is invoked from `Server.emit`, so a
      // synchronous throw or a dropped rejection here becomes an uncaught exception with
      // no handler above it — which ends the process, and with it every in-flight run and
      // every open gate's return path. This route is reachable without a credential, so
      // "some future edit throws on a malformed request" is a matter of when.
      //
      // `#dispatch` catches its own errors; this is the layer that makes that a guarantee
      // rather than a habit.
      this.#dispatch(req, res).catch((e: unknown) => lastResort(res, e));
    });
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        // ONE detach for all three, because there are now three of them and the pairwise
        // version was already one edit from being wrong: `onError` removed `onListening`
        // and vice versa, so adding a third listener to that shape means remembering it in
        // two places. Whichever fires first, none of the others is left on the emitter.
        const detach = (): void => {
          server.removeListener("error", onError);
          server.removeListener("listening", onListening);
          server.removeListener("close", onClosed);
        };
        const onError = (e: NodeJS.ErrnoException): void => {
          detach();
          reject(
            err.validation(CODES.E_CONFIG_INVALID, `could not bind ${host}:${port} — ${e.message}`, {
              details: { host, port, code: e.code, errno: e.errno, syscall: e.syscall },
              cause: e,
            }),
          );
        };
        const onListening = (): void => {
          detach();
          resolve();
        };
        // `close()` won the race. NOT `E_CONFIG_INVALID`: nothing about the configuration
        // is wrong and a retry on another port would be the wrong advice — the caller
        // asked for the socket to go away and it did. `cancelled` is what the rest of the
        // system already means by "your operation was ended by another one".
        const onClosed = (): void => {
          detach();
          reject(
            err.cancelled(`listen(${host}:${port}) was ended by close() before the socket began listening; nothing is bound`, {
              details: { host, port },
            }),
          );
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.once("close", onClosed);
        // SYNCHRONOUS throws land here, in the executor, and reject this promise directly
        // without passing `onError` — so they are re-mapped in the catch below rather than
        // escaping raw. Splitting the mapping would be two contracts for one failure.
        server.listen(port, host);
      });
    } catch (e) {
      // NOTHING IS BOUND, so the field must be released or the retry that follows a bind
      // error — the one legitimate second `listen` — would hit the refusal above.
      //
      // ONLY IF IT IS STILL OURS. The `close()`-during-bind path above rejects from a
      // `'close'` that `close()` itself caused, and `close()` cleared `#server` first and
      // may already have returned — so a `listen` the caller made next would have its
      // brand-new `Server` erased from under it by this line, leaving a bound socket
      // nothing can reach. That is the exact failure the second-`listen` refusal exists to
      // prevent, arrived at from the other side.
      if (this.#server === server) this.#server = undefined;
      // The `Server` is abandoned here and is still an EventEmitter. `onError` is a `once`
      // and may already have fired, and `onListening` never will, so the object is left
      // with nothing listening for `'error'` — which is this method's own defect, one
      // object over. A permanent swallow is the honest listener for a handle nobody holds:
      // there is no caller left to report to, and the promise has already been rejected
      // with the reason. `close()` releases whatever the failed listen still holds; on a
      // server that never bound it is a no-op that emits nothing.
      server.removeAllListeners("listening");
      server.on("error", () => undefined);
      server.close();
      if (isLoomError(e)) throw e;
      const re = e as NodeJS.ErrnoException;
      throw err.validation(CODES.E_CONFIG_INVALID, `could not bind ${host}:${port} — ${re.message}`, {
        details: { host, port, code: re.code, errno: re.errno, syscall: re.syscall },
        cause: e,
      });
    }
    const address = server.address();
    return { port: typeof address === "object" && address !== null ? address.port : port };
  }

  /**
   * Stop serving, and RESOLVE — `server.close` alone does neither reliably.
   *
   * `Server.close` stops accepting and then waits for every connection that is "sending a
   * request or waiting for a response" to finish. An SSE stream on `/runs/:id/events` is
   * by construction never finished, so `close()` used to hang forever against the one
   * client this plane is built to serve — the console. Measured on a raw server holding a
   * single open `text/event-stream` response: `close()` had **still not called back after
   * 1500 ms**, and `loom serve`'s SIGINT handler awaits exactly this promise.
   *
   * So: stop accepting, release the keep-alive sockets that are merely idle, and give
   * anything genuinely mid-response a bounded grace before it is cut. It is deliberately
   * the same shape as `sandbox/subprocess.ts`'s SIGTERM → grace → SIGKILL, for the same
   * reason — waiting forever for something that will never finish is not politeness.
   *
   * The one thing it does NOT do is drain: a caller that wants requests finished must stop
   * routing to this plane before calling. `close()` means stop, and a method that means
   * "stop" has to be able to.
   *
   * **A SECOND CONCURRENT `close()` JOINS THE FIRST rather than resolving.** `#server` is
   * cleared before the wait — deliberately, so a `listen` is admitted the moment the
   * socket stops accepting — and that made the `server === undefined` line, which is there
   * for "nothing was ever bound", also answer "another close is halfway through". It
   * resolved instantly and said the socket was released while the first call was still
   * inside its grace window with a connection attached: the same "resolve while an endless
   * response holds the socket" this method's own comment rejects, reached through a second
   * caller instead of through a race. Reproduced with one mid-request connection —
   * `second close resolved after 0 ms`, `first close resolved after 2001 ms` — and a
   * SIGINT handler that fires twice is the shape that reaches it. `#closing` is that
   * in-flight promise, so both callers learn the same fact at the same time.
   */
  async close(): Promise<void> {
    const server = this.#server;
    // Nothing bound. Either nothing ever was — resolve, `close()` is idempotent — or a
    // concurrent call is still releasing the socket, in which case the honest answer is
    // ITS promise, not a fresh one.
    if (server === undefined) return this.#closing;
    // Cleared FIRST, so a `listen` after this point is admitted even if a stubborn
    // connection makes the wait below take the full grace.
    this.#server = undefined;
    const closing = this.#release(server);
    this.#closing = closing;
    try {
      await closing;
    } finally {
      // Only if it is still ours: `listen` + `close` can have run again while this one
      // waited out its grace, and clearing unconditionally would strand that later caller
      // on a `#closing` of `undefined` — the early return above, back again.
      if (this.#closing === closing) this.#closing = undefined;
    }
  }

  /** The wait itself, split out only so `close()` can hand the same promise to everyone. */
  async #release(server: Server): Promise<void> {
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    // The awaited promise stays `stopped`, not a race against the timer: `close()` must
    // resolve when the socket is ACTUALLY closed, and the forcer is what makes that
    // reachable rather than what stands in for it. A race would resolve while an
    // endless response still held the socket — the same lie in a shorter timeframe.
    const forcer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
    try {
      await stopped;
    } finally {
      clearTimeout(forcer);
    }
  }

  // ── dispatch ──────────────────────────────────────────────────────────────

  async #dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = requestUrl(req);
    if (url === undefined) {
      // Before the bearer check on purpose: there is no path yet to decide anything
      // about, and 400 tells a prober nothing except that its bytes were not a request.
      send(res, 400, { error: { code: CODES.E_PROVIDER_BAD_REQUEST, message: "malformed request target or Host header" } });
      return;
    }

    try {
      // EVERYTHING is inside the deadline, identity resolution included. It used to start
      // after `#principal` had already been awaited, which left the one call in the path
      // that can block on a network — an injected `IdentitySource` — outside the bound
      // that exists to stop a request parking a socket forever.
      await this.#withDeadline(res, url, () => this.#serve(req, res, url));
    } catch (e) {
      const le = toLoomError(e);
      // `send` is a no-op once anything has been written — mid-stream, or after the
      // deadline answered for us — so this is "answer if you still can, then finish".
      send(res, httpStatusFor(le), { error: le.toJSON() });
      if (!res.writableEnded) res.end();
    }
  }

  /** Authenticate, then route. Split out only so the deadline can wrap the whole of it. */
  async #serve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const guarded = this.#requiresBearer(req, url);
    // ONLY for a guarded route. An injected identity source is deployment code that may
    // talk to a network, and no route a stranger can reach may be a way to make it do so
    // — not the callback route, not the console shell, and not `/health`, which used to
    // ask so that it could decide what to disclose. See `#healthDiagnostics`.
    const auth = guarded ? await this.#principal(req, url) : undefined;
    if (guarded && auth === undefined) {
      // 401 before routing, so an unauthenticated caller cannot even probe which
      // routes exist.
      send(res, 401, { error: { code: "E_NOT_AUTHORIZED", message: "missing or invalid bearer token" } });
      return;
    }

    for (const route of this.#routes) {
      if (req.method !== route.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      await route.handle({
        req,
        res,
        url,
        auth,
        params: match.slice(1),
        body: () => this.#readBody(req),
        raw: () => this.#readRaw(req),
      });
      return;
    }
    send(res, 404, { error: { code: "E_RUN_NOT_FOUND", message: `no route for ${req.method} ${url.pathname}` } });
  }

  /**
   * Which requests must present a credential. Every one but three, and all three are
   * listed here.
   *
   * `/health` is open because a load balancer probes it, and what it says to an
   * unauthenticated caller is only that the process is up. It is a LIVENESS probe and it
   * answers from process-local state alone — see `#healthDiagnostics` for what that
   * costs and why it is worth it. `identity` is the one thing it discloses to anyone, and
   * deliberately: it names a mechanism, and the console has to be able to tell "sign in"
   * from "this deployment cannot take your decision" before it has anything to sign in
   * with.
   *
   * `GET /` is open because it is the console's static shell and **a browser cannot put a
   * bearer token on a top-level navigation.** Behind the token, the console is a page that
   * cannot load in any deployment that has one — which is how the shipped UI came to be
   * usable only on an open plane. What is served is a compile-time constant with no run,
   * graph or subject in it; every call the page then makes is credentialed like anyone
   * else's, including `/whoami`.
   *
   * `POST /runs/:id/callbacks/:channel` is open because **the caller cannot hold the
   * token.** Slack, PagerDuty and an internal approvals service post a button click from
   * their own infrastructure; handing them the control plane's bearer token to send back
   * would put a credential that can start and cancel runs into three vendors' logs. The
   * HMAC signature is that route's authentication instead, and it is a strictly narrower
   * one: it authenticates a single gate decision rather than the whole API.
   *
   * The carve-out is scoped by method AND path AND configuration — it does not exist at
   * all unless a dispatcher was wired — and everything behind it is refused by
   * `GateCallbackRouter` unless the signature verifies. Widening this predicate is the
   * one edit in this file that turns the control plane into an open one.
   */
  #requiresBearer(req: IncomingMessage, url: URL): boolean {
    if (url.pathname === "/health") return false;
    if (req.method === "GET" && url.pathname === "/") return false;
    if (this.#callbacks !== undefined && req.method === "POST" && CALLBACK_PATH.test(url.pathname)) return false;
    return true;
  }

  /**
   * Who is calling, in strict order: a configured identity source, then the shared token.
   *
   * The order matters. A specific identity beats a generic one, so a deployment that
   * hands `u:alice` her own token and its CI job the shared one gets a person for her and
   * a service for the job — and only she can answer a gate that names her.
   *
   * `undefined` is "nobody", which the caller turns into 401. It is returned rather than
   * an "anonymous principal" so that the type system carries the distinction all the way
   * to the decision site: there is no object here that a later edit could accidentally
   * treat as a person.
   *
   * OPEN is the one case that yields a principal without a credential, and it exists only
   * when NEITHER a token nor an identity source was configured — the arrangement that
   * already prints "every caller is authorized" at boot. It is a `service` principal on
   * purpose: an open plane knows even less about who is calling than a shared token does,
   * so it must not be able to name a person either.
   */
  async #principal(req: IncomingMessage, url: URL): Promise<AuthContext | undefined> {
    const source = this.#identity;
    if (source !== undefined) {
      // Not wrapped in a try: a source that fails must refuse the request, not degrade to
      // "no identity established". The throw becomes a 503 or a 500 by its own class.
      const who = await source.identify({ method: req.method ?? "GET", path: url.pathname, headers: headerMap(req) });
      // Checked, not cast: what a source returns is an authorization key, and the seam is
      // injected. See `checkedAuth`. The label is the one captured at construction, so
      // every refusal in this process names the source the same way. (`#identityName` is
      // non-null exactly when `source` is defined — they are set from each other — so the
      // fallback below is unreachable and present only to keep the type honest.)
      if (who !== undefined) return checkedAuth(who, this.#identityName ?? "(unnamed)");
    }
    if (this.#token !== undefined) {
      return this.#sharedToken(req) ? { kind: "service", subject: SHARED_TOKEN_SUBJECT, method: "shared-token" } : undefined;
    }
    return this.openToEveryCaller ? { kind: "service", subject: UNIDENTIFIED_SUBJECT, method: "open" } : undefined;
  }

  /**
   * Whether this `/health` caller sees the diagnostics as well as the liveness answer.
   *
   * The SHARED TOKEN and nothing else, which is the entire point: it is a configured
   * constant compared in constant time, with no I/O and no injected code behind it, so
   * `/health` can answer without consulting anything that might be down. It used to
   * consult `#principal`, and therefore the identity source — which made an SSO outage
   * into a load balancer draining every healthy process, an outage CAUSED by the health
   * check rather than caught by one. A probe that fails when a dependency fails is a
   * readiness probe wearing the wrong name.
   *
   * The cost, stated because it is real: a deployment that configures `identity` and NO
   * shared token cannot read `callbackRefusals` here at all. That is the right trade —
   * the two options are not alternatives, `token` is described as a service credential
   * and these counts are a service-shaped diagnostic — but it is a cost.
   *
   * An OPEN plane discloses them to everyone, because it discloses everything to everyone.
   * Withholding one counter from a caller who may read the whole journal is theatre.
   */
  #healthDiagnostics(req: IncomingMessage): boolean {
    if (this.openToEveryCaller) return true;
    return this.#sharedToken(req);
  }

  /**
   * Constant-time compare, so the token cannot be recovered by timing the 401.
   *
   * THE EMPTY EXPECTATION IS THE ONE INPUT THIS COMPARISON CANNOT SURVIVE: `presented`
   * padded to length 0 and sliced to length 0 is `""` whatever was presented,
   * `timingSafeEqual` of two zero-length buffers is `true`, and `0 === 0` passes the
   * length check — so every caller matches, including one with no `Authorization` header.
   * The constructor refuses that configuration, which is why this function may assume a
   * non-empty secret.
   *
   * The guard below is therefore unreachable, and is kept deliberately: it makes the
   * function safe to read on its own, and it fails CLOSED — an empty expectation matches
   * nobody here rather than everybody — so if a future edit ever loses the constructor's
   * refusal, the result is a plane nobody can reach instead of one anybody can.
   */
  #sharedToken(req: IncomingMessage): boolean {
    const expected = this.#token;
    if (expected === undefined || expected === "") return false;
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented.padEnd(expected.length, "\0").slice(0, expected.length));
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b) && presented.length === expected.length;
  }

  /**
   * Answer 504 if a request produces nothing within the deadline.
   *
   * The hole this closes is on the unauthenticated route: a `parseCallback` that hangs —
   * a channel awaiting a network call with no timeout of its own is enough — holds an
   * anonymous request open forever, with nothing journaled, nothing counted, and a socket
   * consumed. Repeat until the process runs out of them.
   *
   * It covers the WHOLE request and not just the handler, which is a correction: the two
   * pieces of injected code in the path are a channel's `parseCallback` and an
   * `IdentitySource.identify`, and identity was resolved before the timer started. A
   * hanging SSO is the same socket-exhaustion bug on every guarded route, and unlike the
   * callback route it is reachable by a caller with no valid credential at all — because
   * finding out whether they have one is what hangs.
   *
   * It is a TIME-TO-FIRST-BYTE bound, not a handler lifetime: once a response has begun
   * the timer does nothing, which is what lets the same rule cover SSE without cutting a
   * long stream off. `node:http`'s own `requestTimeout` bounds RECEIVING a request and
   * says nothing about how long a handler may think.
   *
   * The losing handler is not cancelled — there is nothing here to cancel it with, and
   * pretending otherwise would be worse than saying so. It runs to completion against a
   * response that is already finished, which `send` tolerates. A decision that lands
   * after its 504 is still journaled; the client simply has to re-read to see it.
   */
  async #withDeadline(res: ServerResponse, url: URL, run: () => Promise<void>): Promise<void> {
    // The 504 below quotes `ms`, so `ms` has to BE the deadline that fired rather than the
    // one that was configured. TWO things make that true and this line used to have only
    // one: the constructor refuses every value `setTimeout` would silently change (see
    // `MAX_TIMER_MS`), AND the value read here is the one the constructor validated. It
    // used to be `this.#opts.requestTimeoutMs`, so a record mutated after construction —
    // or a getter — put a number the check had never seen into `setTimeout` and into this
    // message, which is exactly the bug the check exists to prevent, reached around it.
    const ms = this.#requestTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      // A wire code that `errors.ts` does not declare, written the way the 401 above is
      // written. Promoting it into `CODES` costs a design-document row as well — every
      // declared code must be named by one — and that is a reconciliation this change
      // does not own. The status is what a caller branches on either way.
      send(res, 504, {
        error: {
          code: "E_REQUEST_TIMEOUT",
          message: `no response for ${url.pathname} within ${ms}ms`,
        },
      });
    }, ms);
    // Never hold the process open for a deadline that has not fired.
    timer.unref?.();
    try {
      await run();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The body as bytes, capped.
   *
   * The cap is load-bearing on the callback route in a way it is not elsewhere: that
   * route is unauthenticated, so an uncapped read there is a memory-exhaustion target
   * anyone on the network can pull. It is enforced while streaming, before the bytes are
   * concatenated, so a 100 MB POST costs one chunk rather than 100 MB.
   */
  async #readRaw(req: IncomingMessage): Promise<Buffer> {
    const max = this.#maxBodyBytes ?? 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      // Stop reading and answer. The rest of the upload is never buffered — draining it
      // to be polite is exactly what the sender wanted — and `node:http` tears the socket
      // down once the response ends with the request unconsumed.
      if (size > max) throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `request body exceeds ${max} bytes`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }

  /**
   * The body as a parsed JSON OBJECT — the type is the guarantee, not a cast.
   *
   * What comes back is PLAIN DATA — `JSON.parse` with no reviver produces objects with
   * own data properties and nothing else — so a handler may read the same field twice
   * without the two reads disagreeing. That is why `cmd.kind` and `input.decision` are
   * read twice here and why `checkedAuth` may not read a field twice: one is a parse of
   * bytes this process received, the other is a property access on an object injected
   * code returned, and only one of them can run code.
   *
   * **AND IT IS AN OBJECT, WHICH IT DID NOT USED TO BE.** Every write route did
   * `(await body()) as {…}` and then read a field off the result, and `JSON.parse("null")`
   * is `null`. Four bytes:
   *
   *     POST /runs                   null → 500 E_INTERNAL "Cannot read properties of null (reading 'workflow')"
   *     POST /runs/:id/commands      null → 500 E_INTERNAL "… (reading 'kind')"
   *     POST /runs/:id/gates/:gateId null → 500 E_INTERNAL "… (reading 'decision')"
   *
   * `E_INTERNAL` is this system's word for "a bug in Loom", for a body a caller chose —
   * the same defect `graphIn` closes on the path and `pageLimit` closes on the query
   * string. The scalars below it were quieter and the same shape: `POST /runs` with a body
   * of `42` answered `404 no compiled graph named ""`, diagnosing a missing graph for a
   * request that never named one.
   *
   * REFUSED HERE AND NOT PER ROUTE, because all three read a field immediately and a
   * refusal each is three places to forget. An EMPTY body stays `{}` — "no fields" is a
   * coherent request that the routes already diagnose themselves — and an array is refused
   * with the scalars, because no route here takes one and `[]` reads every field as
   * `undefined`, which is the silent version of this same bug.
   */
  async #readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await this.#readRaw(req);
    if (raw.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "request body is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      // `typeof x === "object"` on its own admits `null` and every array, which is why both
      // are named. A `Map`, `Date` or `RegExp` cannot come out of `JSON.parse` with no
      // reviver, so they are not reachable here — the two that are, are checked.
      throw err.validation(
        CODES.E_PROVIDER_BAD_REQUEST,
        `request body parsed as ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed}, and every route here takes a ` +
          `JSON object. Send {} for a request with no fields.`,
      );
    }
    return parsed as Record<string, unknown>;
  }

  // ── routes ────────────────────────────────────────────────────────────────

  #buildRoutes(): readonly Route[] {
    const engine = this.#engine;
    const store = this.#store;

    return [
      {
        method: "GET",
        pattern: /^\/$/,
        handle: async ({ res }) => {
          // The console ships inside the binary: one document, no bundler, no build
          // step. An approval queue nobody can reach is an oversight model that does
          // not exist.
          //
          // Served WITHOUT a credential, which is the second carve-out in this file and
          // the narrower of the two: a browser cannot attach an Authorization header to
          // a top-level navigation, so a shell behind the token is a console that cannot
          // load anywhere it is needed. What ships is a constant — no run, no graph, no
          // name of either — and every call it then makes is credentialed like any other
          // client's. It discloses that this is a Loom control plane, which `/health`
          // already does.
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(CONSOLE_HTML);
        },
      },

      {
        method: "GET",
        pattern: /^\/graphs$/,
        handle: async ({ res }) => {
          send(res, 200, {
            graphs: Object.entries(this.#graphs).map(([name, g]) => ({
              name,
              graphHash: g.graphHash,
              nodes: g.spec.nodes.length,
              edges: g.spec.edges.length,
            })),
          });
        },
      },

      {
        method: "GET",
        pattern: /^\/graphs\/by-hash\/([^/]+)$/,
        handle: async ({ res, params }) => {
          const hash = decodeURIComponent(params[0]!);
          const graph = Object.values(this.#graphs).find((g) => g.graphHash === hash);
          if (graph === undefined) throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no graph with hash ${hash}`);
          // Structure ONCE, keyed by hash: the client caches it and only deltas stream
          // afterwards. The GEOMETRY ships with it — positions and edge control points
          // are computed here, so "the browser never runs graph layout" is a fact about
          // the payload rather than a claim about code nobody can measure.
          const layout = layoutGraph(graph);
          send(res, 200, {
            graphHash: graph.graphHash,
            width: layout.width,
            height: layout.height,
            nodes: layout.nodes,
            edges: layout.edges,
            plans: Object.fromEntries(
              Object.entries(graph.plans).map(([id, p]) => [id, { layoutRank: p.layoutRank, maxInstances: p.maxInstances, posture: p.posture }]),
            ),
          });
        },
      },

      {
        method: "GET",
        pattern: /^\/health$/,
        handle: async ({ req, res }) => {
          const callbacks = this.#callbacks;
          send(res, 200, {
            ok: true,
            // THE SAME FIELD `#principal` DECIDES FROM, not a second derivation of it.
            // These two disagreed for exactly one configuration — an empty shared token —
            // and that disagreement is what made the hole silent: the plane admitted
            // everyone while this line went on saying "required".
            auth: this.openToEveryCaller ? "open" : "required",
            // WHETHER A HUMAN CAN BE IDENTIFIED AT ALL, and therefore whether a gate
            // naming approvers can ever be answered here. Unauthenticated because the
            // console needs it before it has a credential, to tell "sign in" apart from
            // "this deployment cannot take your decision". It names a mechanism, which
            // is not a secret; the credentials it checks are not disclosed.
            //
            // The LABEL, captured at construction — not a read of `identity.name`. This
            // route promises to answer from process-local state, and a property on an
            // injected object is not that: a getter here is deployment code invoked by an
            // unauthenticated request, on the one route whose whole value is that it
            // cannot be made to fail by something else failing.
            identity: this.#identityName,
            graphs: Object.keys(this.#graphs),
            // WHAT THE JOURNAL IS NOT ALLOWED TO HOLD. A forged-signature campaign
            // against the unauthenticated callback route writes no journal row on
            // purpose — see `GateCallbackRouter` — so without this, "someone is hammering
            // our approval endpoint" is a fact the process knows and nobody can read.
            // It is a bounded, process-lifetime counter: lossy, which is exactly what
            // invariant 8 permits of everything that is not the journal.
            //
            // BEHIND THE SHARED TOKEN, though `/health` itself is not, and the two are
            // not in tension: the liveness answer stays free because a load balancer
            // needs it, while the refusal counts would otherwise hand the forger a
            // feedback channel — poll it, watch your own counter move, and learn that
            // your traffic is reaching the process rather than dying in a WAF. The
            // SHARED token and not a principal, because resolving a principal means
            // asking an injected source, and this endpoint answers without asking
            // anything that can be down — see `#healthDiagnostics`. Omitted entirely,
            // not zeroed, when there is no dispatcher: the route does not exist, so
            // neither does its counter.
            ...(callbacks === undefined || !this.#healthDiagnostics(req) ? {} : { callbackRefusals: callbacks.refusals() }),
          });
        },
      },

      {
        method: "GET",
        pattern: /^\/whoami$/,
        handle: async ({ res, auth }) => {
          // Behind the token like everything else, and the answer to the question the
          // console has to be able to ask before it shows an approve button: whose
          // decision will this be? A UI that cannot answer it invites people to click
          // approve believing they are someone the journal will not name.
          send(res, 200, {
            kind: auth?.kind ?? "service",
            subject: auth?.subject ?? UNIDENTIFIED_SUBJECT,
            method: auth?.method ?? "open",
            // Whether this credential can answer a gate that names approvers — the one
            // thing a UI needs before it draws the button.
            canApproveNamedGates: auth?.kind === "human",
            ...(auth?.via === undefined ? {} : { via: auth.via }),
          });
        },
      },

      {
        method: "POST",
        pattern: /^\/runs$/,
        handle: async ({ req, res, body, auth }) => {
          const input = await body();
          const key = header(req, "idempotency-key");
          const slot = key === undefined ? undefined : idempotencySlot(auth, key);
          if (slot !== undefined) {
            const seen = this.#idempotency.get(slot);
            // A duplicate submit BY THE SAME PRINCIPAL returns the ORIGINAL runId and
            // creates nothing. A different principal's identical key is a different slot.
            if (seen !== undefined) {
              send(res, 202, seen);
              return;
            }
          }

          // BOTH FIELDS ARE CHECKED AND NEITHER WAS. This handler read them off a cast —
          // `as { workflow?: string; inputs?: Record<string, unknown> }` — and `runInputs`
          // in `cli.ts` states the rule that cast breaks, in its own docstring, for the
          // very same value: "`inputs` is a channel map, the signature says
          // `Record<string, unknown>`, and a cast is not a check." That door refuses an
          // array; this one accepted one. Measured: `{"inputs":[1,2]}`, `"hello"`, `42`,
          // `null` and `true` each answered **202** and started a run, and 202 means
          // `run.submitted` is DURABLE — so the array is in the journal as the run's
          // channel map for every later reader to cope with.
          //
          // `workflow` is the one that can reach further than the response: it is used as a
          // lookup key and then written to `run.submitted` verbatim, so an object whose
          // `toString` names a real graph passes `hasOwnProperty` and is journaled as the
          // workflow. Absent stays legal for both — "" finds no graph and gives the 404
          // below, which is the honest answer to a request that named none.
          const workflow: unknown = input["workflow"];
          if (workflow !== undefined && typeof workflow !== "string") {
            throw err.validation(
              CODES.E_PROVIDER_BAD_REQUEST,
              `"workflow" must be the name of a compiled graph, not ${Array.isArray(workflow) ? "an array" : workflow === null ? "null" : typeof workflow}. ` +
                `It is used as a lookup key AND journaled on run.submitted.`,
            );
          }
          const inputs: unknown = input["inputs"];
          if (inputs !== undefined && (typeof inputs !== "object" || inputs === null || Array.isArray(inputs))) {
            throw err.validation(
              CODES.E_PROVIDER_BAD_REQUEST,
              `"inputs" must be a JSON object of channel values, not ${Array.isArray(inputs) ? "an array" : inputs === null ? "null" : typeof inputs}. ` +
                `Omit it to start with no inputs.`,
            );
          }

          const name = workflow ?? "";
          // `graphIn`, NEVER a bare index — see its docstring for the six names that
          // reached `engine.submit` and came back 500.
          const graph = graphIn(this.#graphs, name);
          if (graph === undefined) {
            throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no compiled graph named "${name}"`);
          }

          const runId = await engine.submit({
            graph,
            // The check above narrowed this to `object`; the cast is the shape it proved.
            inputs: (inputs ?? {}) as Record<string, unknown>,
            workflow: name,
            ...(key === undefined ? {} : { idempotencyKey: key }),
          });
          // 202, and the body says exactly what is durable — see the module docstring.
          const accepted = {
            runId,
            graphHash: graph.graphHash,
            durable: ["run.submitted", "run.compiled"],
            note: "accepted means this WILL run, not that it HAS run",
          };
          if (slot !== undefined) this.#idempotency.set(slot, accepted);
          send(res, 202, accepted);

          // Drive it after responding: the client is not made to wait on execution.
          //
          // AND THE REJECTION IS REPORTED, WHICH IT USED TO NOT BE. This was
          // `.catch(() => undefined)`, which dropped every failure of the one call that
          // drives a freshly-accepted run. The 202 four lines up says, in those words,
          // "accepted means this WILL run, not that it HAS run" — a promise about the
          // future — and a silent catch is exactly what makes that promise unfalsifiable:
          // the journal stops at `run.compiled`, `GET /runs/:id` reports `queued`, and the
          // reason exists nowhere. That is this file's own rule about silence, on its own
          // write path.
          //
          // The response has already been sent, so the CLIENT cannot be told and awaiting
          // `advance` first is the thing the 202 exists to avoid. The operator can be, and
          // `startControlPlane`'s boot warnings are the precedent for the sink. The line
          // names the recovery because there is one: another `advance`.
          void engine.advance(runId).catch((e: unknown) => {
            // THE LAST FRAME. This runs inside a `.catch` on a promise nobody awaits, so a
            // throw here is an unhandled rejection and the process — which is why the
            // reason is rendered by `describeFailure` (total by construction) and not by
            // `toLoomError`, whose `String(e)` throws on a value with no primitive
            // conversion. The `try` is the backstop for the rest: `console.error` itself,
            // and a `name`/`message` getter that traps.
            try {
              console.error(
                `[loom] run ${runId} was ACCEPTED (202) and its first advance() FAILED: ${describeFailure(e)}. ` +
                  `The journal holds run.submitted and run.compiled and nothing after them, so nothing is driving this run — ` +
                  `POST /runs/${runId}/commands {"kind":"advance"} to retry it.`,
              );
            } catch {
              // Nothing above this frame can be told anything, and taking the process down
              // to report that a report failed is strictly worse than the silence.
            }
          });
        },
      },

      // THE FOUR UNSCOPED ROUTES. Each takes `auth` for admission and none of them for
      // access: every principal sees and commands every run. Stated once here rather than
      // four times, and in full in the module docstring under "THE LIMIT" — the one place
      // to change when a run learns who submitted it.
      {
        method: "GET",
        pattern: /^\/runs$/,
        // EVERY run, not this principal's. `listRuns` has no owner to filter on.
        handle: async ({ res, url }) => {
          send(res, 200, { runs: await store.listRuns(pageLimit(url.searchParams.get("limit"))) });
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)$/,
        // Any principal's run. 404 means "no such run", never "not yours".
        handle: async ({ res, params }) => {
          const p = await engine.projection(params[0] as RunId);
          if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${params[0]} not found`);
          send(res, 200, summarise(p));
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/events$/,
        // Any principal's stream, redacted per the graph's classification, not per viewer.
        handle: async (ctx) => this.#streamEvents(ctx),
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/commands$/,
        // The one that is not a read: any principal may cancel or rewind any run.
        handle: async ({ res, params, body }) => {
          const runId = params[0] as RunId;
          const cmd = await body();
          switch (cmd["kind"]) {
            case "cancel":
              // `checkedReason`, not `cmd.reason ?? "operator"` off a cast — the value is
              // journaled on `operator.command` and quoted into every gate this closes.
              send(res, 200, summarise(await engine.cancel(runId, checkedReason(cmd["reason"], "operator"))));
              return;
            case "rewind": {
              const atSeq: unknown = cmd["atSeq"];
              if (typeof atSeq !== "number") {
                throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "rewind requires atSeq");
              }
              send(res, 200, summarise(await engine.rewind(runId, atSeq, checkedReason(cmd["reason"], "operator"))));
              return;
            }
            case "advance":
              send(res, 200, summarise(await engine.advance(runId)));
              return;
            default:
              throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `unknown command "${String(cmd["kind"])}"`);
          }
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/gates$/,
        handle: async ({ res, params }) => {
          const runId = params[0] as RunId;
          const p = await engine.projection(runId);
          if (p === undefined) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          // Joined with the rendered payload where the broker still has it. A queue that
          // lists gates without saying what each one asks is a queue people clear rather
          // than read — and for a `subgraph` gate the question is in another run entirely.
          //
          // ONE ERROR IS EXPECTED HERE AND EVERYTHING ELSE IS NOT, and the catch used to
          // take both. `openGates` throws `E_RUN_NOT_FOUND` when the run is not attached to
          // this engine, which is the ORDINARY state after a restart — the gates are in the
          // journal and the rendered payloads were only ever in memory — so degrading to
          // "no payloads" is the right answer for that one and only that one. A bare
          // `catch(() => [])` also answered 200 with a payload-less queue when the broker's
          // own read failed, which is the same list an operator sees on a healthy restarted
          // process: a failure and a normal condition rendered identically.
          const detailed = await engine.openGates(runId).catch((e: unknown) => {
            if (isLoomError(e) && e.code === CODES.E_RUN_NOT_FOUND) return [];
            throw e;
          });
          // THE ORDER IS THE BROKER'S, FOR EVERY GATE THE BROKER RANKED — D7.9 row 5, which
          // until now reached nobody. `HumanGateBroker.list` has ranked its answer since the
          // row was built and this handler used it only as a lookup Map for
          // `payload`/`deadline`, serving `Object.values(p.gates)` — JOURNAL order — to every
          // caller of the one API a queue is read through. Mechanism built, tested, and wired
          // to nothing.
          //
          // **"MOST URGENT FIRST" IS NOT WHAT THIS RESPONSE CAN CLAIM, and the counterexample
          // is the ordinary case rather than an exotic one**, which is why the sentence above
          // carries its qualifier. `openGates` throws `E_RUN_NOT_FOUND` for a run this engine
          // has not attached — the state of every run after a restart — and the catch above
          // turns that into `[]`, so the queue then ranks NOTHING and the whole response is
          // journal order. The residue is recorded in `05-RESOURCES-OBSERVABILITY.md` §3 with
          // the one export that closes it (`gateQueueOrder` is a pure function of the
          // projection and is module-private in `run/gates.ts`).
          //
          // THE SET IS THE PROJECTION'S AND ONLY THE ORDER IS THE BROKER'S, which is not
          // pedantry: serving the broker's list directly would answer "no gates" for a
          // restarted run whose gates are durable and open, which is the failure mode this
          // whole endpoint exists against. So the projection decides WHICH, always, and the
          // queue decides the order of the ones it ranked; anything it did not rank keeps
          // journal order, behind them.
          //
          // AND THE RANK IS NOT RECOMPUTED HERE. `gateQueueOrder` is one function in
          // `run/gates.ts`; a second ranking in this file is the "two validators for one
          // union" arrangement that agrees on the day it is written and drifts after.
          const ranked = new Map(detailed.map((g, i) => [g.gateId, i] as const));
          const open = Object.values(p.gates).filter((g) => g.state === "open");
          // Partitioned rather than sorted with a `?? Infinity` key: `Infinity - Infinity` is
          // `NaN`, and a comparator that answers `NaN` for a pair silently discards the whole
          // ordering — the same inconsistent-comparator bug HANDOFF A18 measured in
          // `spansFrom`'s `startTime` sort. Ranked gates in the queue's order, then the rest
          // in journal order, and each gate is emitted exactly once.
          const byId = new Map(detailed.map((g) => [g.gateId, g]));
          const wire = (g: (typeof open)[number]): unknown => ({
            ...g,
            payload: byId.get(g.gateId)?.payload,
            deadline: byId.get(g.gateId)?.deadline,
          });
          const gates = [
            ...open.filter((g) => ranked.has(g.gateId)).sort((a, b) => ranked.get(a.gateId)! - ranked.get(b.gateId)!),
            ...open.filter((g) => !ranked.has(g.gateId)),
          ].map(wire);
          send(res, 200, { gates });
        },
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/gates\/([^/]+)$/,
        handle: async ({ req, res, params, body, auth }) => {
          const runId = params[0] as RunId;
          const gateId = params[1] as GateId;
          const input = await body();
          const claimed: unknown = input["actor"];
          if (input["decision"] === undefined) {
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "a gate resolution requires a decision");
          }
          // CHECKED, NOT CAST — see `checkedDecision` for the eight shapes that used to
          // approve and run the action behind the gate. It runs BEFORE `#decider` so that
          // an unreadable decision is refused for what it is, rather than being answered
          // with an authorization error that sends its author looking at credentials.
          const decision = checkedDecision(input["decision"]);
          if (claimed !== undefined && typeof claimed !== "string") {
            // `#decider` compares this against the credential's subject and interpolates it
            // into the refusal, so a non-string would be `[object Object]` in an error
            // about identity. Its own rule — the subject comes from the credential — is
            // unchanged; this only makes the claim it refuses a legible one.
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `"actor" must be a subject string when it is present, not ${typeof claimed}`);
          }

          const actor = this.#decider(auth, claimed);
          if (actor.subject === UNIDENTIFIED_SUBJECT) await this.#refuseUnidentifiedApproval(runId, gateId, auth);

          const p = await engine.resolveGate(runId, {
            gateId,
            decision,
            actor,
            // DERIVED FROM THE CREDENTIAL, not the body. The old fallback interpolated
            // the body's `actor`, so the same decision arrived under a different key
            // whenever the caller typed a different name — an idempotency key anyone
            // could vary is not one.
            //
            // NAMESPACED BY PRINCIPAL, exactly as `POST /runs` is, and for the same reason
            // the same way round. `GateBroker.resolve` prefixes `actorId(actor)`, which
            // was read as "two principals never share a slot" — true only for identified
            // HUMANS. `#decider` collapses every service credential and every open-plane
            // caller to `UNIDENTIFIED_SUBJECT`, so two different services answering one
            // gate hashed to one key: the second one's decision was swallowed as "already
            // handled" and answered 200. A rejection that never happened, reported as
            // success, is the worst shape this endpoint has.
            idempotencyKey: idempotencySlot(auth, header(req, "idempotency-key") ?? String(gateId)),
          });
          send(res, 200, summarise(p));
        },
      },

      // The unauthenticated one. Registered only when a dispatcher exists, so the
      // carve-out in `#requiresBearer` and the route it opens are switched by the same
      // configuration and cannot get out of step.
      ...(this.#callbacks === undefined
        ? []
        : [
            {
              method: "POST",
              pattern: CALLBACK_PATH,
              handle: async ({ req, res, params, raw }: RequestContext): Promise<void> => {
                // `raw()` and not `body()`: the signature is over the bytes as sent, and
                // re-serializing a parsed object would verify a string nobody signed.
                const out = await this.#callbacks!.handle({
                  runId: params[0] as RunId,
                  channel: safeDecode(params[1]!),
                  body: await raw(),
                  headers: headerMap(req),
                });
                send(res, 200, {
                  gateId: out.gateId,
                  decision: out.decision.kind,
                  // Echoed so the caller can see WHO the signature was taken to vouch
                  // for. A service that expected one subject and reads back another has
                  // a mapping bug, and this is where it shows up.
                  actor: out.actor,
                  status: out.projection.status,
                });
              },
            },
          ]),
    ];
  }

  /**
   * The human a gate decision will be recorded as — from the credential, never the body.
   *
   * Three cases, and the middle one is the defect this replaced:
   *
   *  - an identified person ⇒ their subject, with whatever the source vouched for
   *    (`via`, `mfa`, `onBehalfOf`) carried onto the record;
   *  - a service credential or an open plane ⇒ `UNIDENTIFIED_SUBJECT`. True, unusable as
   *    an approver, and not a name;
   *  - a body that CLAIMS a subject the credential does not support ⇒ refused.
   *
   * The third is a refusal rather than a silent drop on purpose. A client that sends
   * `actor` believes it is writing the audit trail; ignoring it would leave that client
   * confidently wrong about what the journal says. Refusing tells it, once, that this
   * endpoint takes identity from the credential. An `actor` that AGREES with the
   * authenticated subject is not a claim about anyone else and is simply allowed.
   */
  #decider(auth: AuthContext | undefined, claimed: string | undefined): HumanActor {
    const person = auth?.kind === "human" ? auth : undefined;
    if (claimed !== undefined && claimed !== person?.subject) {
      throw err.policy(
        CODES.E_NOT_AUTHORIZED,
        person === undefined
          ? `this request carries no human identity, so it cannot decide as "${claimed}": the approver's subject comes from the credential, never from the request body`
          : `this credential authenticates "${person.subject}", not "${claimed}": the approver's subject comes from the credential, never from the request body`,
      );
    }
    if (person === undefined) return { kind: "human", subject: UNIDENTIFIED_SUBJECT, via: "api" };
    return {
      kind: "human",
      subject: person.subject,
      via: person.via ?? "api",
      ...(person.mfa === undefined ? {} : { mfa: person.mfa }),
      ...(person.onBehalfOf === undefined ? {} : { onBehalfOf: person.onBehalfOf }),
    };
  }

  /**
   * Refuse an unidentified decision on a gate that names approvers, and say why.
   *
   * DEFENCE IN DEPTH, not the enforcement point — `HumanGateBroker.#authorize` is, for
   * every door including this one, and it would refuse this too. Two things are worth the
   * extra read of the projection:
   *
   *  1. **The error names the misconfiguration.** From the broker alone the answer is
   *     `does not name "(unidentified)" as an approver`, which sends an operator looking
   *     at their graph when the missing piece is in their deployment config.
   *  2. **`approvers` is an opaque string list.** The compiler accepts any non-empty
   *     string, so nothing stops a graph from naming `(unidentified)` and thereby
   *     authorizing every anonymous caller. Refusing before the list is consulted closes
   *     that by construction rather than by a naming convention.
   *
   * It is a RUNTIME refusal and not a compile-time one, which is the opposite of
   * `GRAPH014_APPROVAL_UNSUPPORTED` and for a reason worth stating: whether identity
   * exists is deployment configuration, not graph configuration. The same graph is
   * perfectly answerable in a deployment with an identity source and unanswerable in one
   * without, and the compiler sees neither. What the compiler CAN refuse — an approval
   * rule the runtime does not implement at all — it still does. `startControlPlane`
   * closes the remaining gap by naming the affected graphs loudly at boot, which is the
   * earliest moment both halves are in the same process.
   */
  async #refuseUnidentifiedApproval(runId: RunId, gateId: GateId, auth: AuthContext | undefined): Promise<void> {
    const p = await this.#engine.projection(runId);
    // `gateOf`, NEVER `p.gates[gateId]` — the last bare index in this file, on a key that
    // comes off the URL. `p.gates["constructor"]` answers with the `Object` FUNCTION, whose
    // `approvers` is `undefined`, which `?? []` then reads as the PERMISSIVE case: "this
    // gate names nobody". The Traps list is explicit that "named nobody" and "could not
    // read who it names" must never produce the same value, and this is the second of the
    // two producing the first.
    //
    // NOTHING OBSERVABLE CHANGES TODAY and the note says so rather than claiming a fix:
    // every such gateId is refused one layer down by `HumanGateBroker.resolve`, which has
    // called `gateOf` since it was written, so `POST /runs/:id/gates/__proto__` answered
    // 404 `E_GATE_NOT_FOUND` before this line and answers it after — measured, along with
    // `constructor` and `toString`. What changes is that this file no longer contains the
    // lookup `gateOf`'s own docstring exists to replace, in the one function whose stated
    // job is being the FIRST line for a graph that names `(unidentified)`.
    const approvers = (p === undefined ? undefined : gateOf(p, gateId))?.approvers ?? [];
    if (approvers.length === 0) return;
    // The captured label, so the sentence and the `details` cannot disagree — they used to
    // be two separate reads of `identity.name`, which is an injected property.
    const source = this.#identityName;
    throw err.policy(
      CODES.E_GATE_NOT_AUTHORIZED,
      source === null
        ? `gate "${gateId}" names approvers, and this control plane has no identity source configured, so no caller can prove who they are. ` +
          `Set ControlPlaneOptions.identity (BearerTokenIdentity is built in) and present a per-subject credential — the shared bearer token authenticates a deployment, not a person.`
        : `gate "${gateId}" names approvers, and this credential identifies no person (method "${auth?.method ?? "none"}"). ` +
          `Present a credential the "${source}" identity source recognizes.`,
      { details: { gateId, identity: source } },
    );
  }

  /**
   * SSE with gap-free reconnect.
   *
   * `Last-Event-ID` inside the hot window replays from `seq+1`; outside it, the client
   * gets one `snapshot` frame and then the live tail. Either way the client knows
   * whether it is looking at a continuation or a fresh baseline.
   *
   * **AN ID THAT IS NOT A SEQ TAKES THE SNAPSHOT BRANCH, and widening the guard to say so
   * is a correction rather than a hardening.** `!Number.isFinite(lastSeq)` was written for
   * `abc` and answers it correctly — a `snapshot` frame is a baseline the client can SEE
   * it received, which is what makes contract 2 in the module docstring true. Every other
   * malformed id stayed on the replay branch and became an OFFSET: `store.read(runId,
   * lastSeq + 1)`. Measured on a run with 88 events, `Last-Event-ID: 1.5` returned 86
   * event frames beginning at seq 3 — event 2 gone, status 200, nothing anywhere saying
   * the stream was not a continuation — and the same offset against the SQLite store
   * returns no events at all. A gap the client cannot detect is the one outcome
   * "gap-free" rules out, so the guard is about what a seq IS, not about `NaN`.
   *
   * **AND A SHAPE CHECK IS NOT AN EXISTENCE CHECK, which is the half that widening
   * missed.** "A whole number from 0 up" is the right question about the shape of an id and
   * the whole question only if every well-formed id is one this run issued. `head -
   * lastSeq > hot` is FALSE when `lastSeq` is ABOVE `head` — the difference is negative —
   * so an id ahead of head took the replay branch, read nothing, and then had the live
   * tail's `e.seq <= lastSeq` skip everything the run went on to produce. Measured on a run
   * parked at a gate with head 88, two clients reconnecting at the same instant, the gate
   * then answered (head 88 → 102):
   *
   *     Last-Event-ID: 88       (caught up)     → 14 frames, 0 snapshot
   *     Last-Event-ID: 5000088  (ahead of head) →  0 frames, 0 snapshot
   *
   * Same status, no snapshot, no error: byte-identical to a legitimately caught-up
   * reconnect, and the client silently missed the rest of the run. `head` is therefore read
   * BEFORE the guard and is part of it — an id is resumable when it is a seq this run has
   * actually reached, and `lastSeq === head` (the ordinary caught-up case) still is.
   *
   * **THAT PARAGRAPH NAMED TWO HALVES AND THE `resumable` GUARD CLOSED ONE OF THEM.** The
   * replay branch reading nothing was the half a `head`-aware guard can fix, because the
   * branch is what it selects. The live tail's `if (e.seq <= lastSeq) continue` is a SECOND
   * use of the same number, forty lines further down, past the branch — so an id ahead of
   * head now takes the snapshot branch AND then skips every event the run goes on to
   * produce, because they are all `<= 5000088`. Re-measured on the same rig, a run parked at
   * a gate with head 88, the gate then answered (head 88 → 102):
   *
   *     Last-Event-ID: 88       (caught up)     → 14 frames, 0 snapshot
   *     Last-Event-ID: abc      (not a seq)     →  1 snapshot + 14 frames
   *     Last-Event-ID: 5000088  (ahead of head) →  1 snapshot +  0 frames
   *
   * `abc` is the control, and it shows what the fix has to produce: `NaN` loses `e.seq <=
   * lastSeq` the same way it loses every other comparison, so the malformed case was tailing
   * correctly all along and the well-formed-but-impossible one was not. A client that
   * reconnects, receives a baseline, and then receives nothing further while the run finishes
   * is exactly *"the client NEVER silently misses events"* broken — the snapshot only made it
   * a visible baseline followed by an invisible gap.
   *
   * So the live tail is floored on `resumed`, the seq the client has actually been brought up
   * to, and not on the id it ASKED with. They are the same number on the replay branch and
   * they are not the same number anywhere else. The rule generalises past this defect: a
   * caller-supplied value that has been VALIDATED must be consumed through the validation's
   * output, never through a second read of the input — which is HANDOFF A12's sweep, and it is
   * the rule `telemetry/spans.ts`'s `shouldExport` writes out for `ratio`. This function
   * applied it at one of its two use sites.
   *
   * **A THIRD WAY TO MISS AN EVENT HERE IS OPEN AND IS RECORDED RATHER THAN FIXED — HANDOFF
   * A20.** The baseline (snapshot or replay) is taken and the bus is subscribed to
   * AFTERWARDS, and `EventBus.subscribe` hands back an empty channel, so anything appended
   * between the two lines is in neither. Reproduced by parking `projection()` while the run
   * finished: baseline at seq 88, run reached 102, client received **one snapshot frame and
   * nothing else**. `EventBus.replayThenTail` exists for precisely this ordering and says so
   * in its own docstring; this is the one reconnect path that does not use it. It is a
   * restructure rather than a guard — a bare move of the `subscribe` call reintroduces the
   * hole through the queue, since a long replay can overflow 1024 slots under `drop_oldest` —
   * so it is an entry and not a line in this change.
   *
   * **AND BOTH OF THOSE WIDENINGS TESTED THE NUMBER `Number()` PRODUCED RATHER THAN WHAT A
   * SEQ IS, which is the rule the paragraphs above state.** `Number` is a coercion, not a
   * parse: it accepts hex, exponent notation, a leading sign, a trailing `.0` and
   * surrounding whitespace, and every one of those yields a whole number in range, so the
   * widened guard waved it through and `store.read(runId, lastSeq + 1)` treated it as an
   * offset. Measured on a run with head 88: `0x58` → 88, `8e1` → 80, `+88` → 88, `88.0` →
   * 88, `" 88 "` → 88 — and `0x58`, landing exactly on head, returned **zero frames and no
   * snapshot**, which is the "byte-identical to a caught-up reconnect" outcome the paragraph
   * above this one was written about, reached from the other side.
   *
   * Every id this server issues is decimal digits, because `write` emits `id: ${seq}` for a
   * `number`. So `seqIn` accepts exactly that, and everything else is not an id — the same
   * verdict the fractional case gets, and for the same reason.
   */
  async #streamEvents(ctx: RequestContext): Promise<void> {
    const { res, req, params } = ctx;
    const runId = params[0] as RunId;
    const bus = this.#bus;

    const lastHeader = header(req, "last-event-id") ?? ctx.url.searchParams.get("lastEventId") ?? undefined;
    // AN EMPTY ID IS "I HAVE NOTHING", the same statement as no id at all — a client sends
    // it before it has ever received a frame. Everything else is PARSED rather than coerced.
    const lastSeq = lastHeader === undefined || lastHeader === "" ? 0 : seqIn(lastHeader);
    // Read before `resumable`, because it is one of its terms.
    const head = await this.#store.head(runId);
    // A seq is a whole number from 0 up: 0 is "I have nothing", and there is no fractional
    // or negative one. AND it must be one this run reached — `<= head`, so the caught-up
    // reconnect at exactly `head` stays a replay and an id nobody was ever issued does not.
    // Not a 400, because a reconnect must always be answerable — the snapshot IS the
    // answer, and it is one the client can tell apart from a replay.
    const resumable = Number.isSafeInteger(lastSeq) && lastSeq >= 0 && lastSeq <= head;
    // WHAT THE CLIENT HAS, WHICH IS NOT WHAT IT ASKED WITH. The live tail below skips
    // everything at or under this, and `lastSeq` is the wrong number for it on the snapshot
    // branch: an unresumable id is by definition not a seq this client holds, so flooring on
    // it discards events the client has never seen. `0` is "the snapshot is the baseline;
    // deliver everything after it", which is what the `NaN` case already got for free and the
    // only reason the malformed-id path was never observed to lose the tail. Wherever
    // `resumable` holds the two are the same number, so the ONLY behaviour this changes is
    // the unresumable one — including the resumable-but-cold reconnect, which is on the
    // snapshot branch and keeps its `lastSeq` floor, and needs no separate argument because
    // the subscription opens after `head` is read and every event it delivers has a seq
    // above `head`.
    const resumed = resumable ? lastSeq : 0;
    const hot = this.#hotWindow ?? 10_000;

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    const write = (event: string, id: number | undefined, data: unknown): void => {
      if (id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    if (!resumable || head - lastSeq > hot) {
      const p = await this.#engine.projection(runId);
      if (p !== undefined) write("snapshot", p.seq, summarise(p));
    } else {
      // `resumed`, not `lastSeq`. Equal on this branch — it is only reached when `resumable`
      // — and written this way so the validated value has ONE consumption point rather than
      // two spellings a later change can move apart, which is precisely how the live tail
      // below came to be reading the unvalidated one.
      for await (const e of this.#store.read(runId, resumed + 1)) write("event", e.seq, frame(e));
    }

    if (bus === undefined) {
      res.end();
      return;
    }

    const sub = bus.subscribe({ runId }, { queueSize: 1024, onOverflow: "drop_oldest" });
    const stop = (): void => sub.dispose();
    req.on("close", stop);

    try {
      for await (const e of sub) {
        if (e.seq <= resumed) continue;
        write("event", e.seq, frame(e));
        if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") break;
      }
    } finally {
      sub.dispose();
      res.end();
    }
  }
}

// ---------------------------------------------------------------------------

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * A `Last-Event-ID` PARSED as a seq, or `NaN` for anything that is not one.
 *
 * Decimal digits and nothing else, because that is the whole set of ids this server issues:
 * `#streamEvents`' `write` emits `id: ${id}` for a `number`, and a client echoes back what
 * it was sent. `Number()` accepts a great deal more than that and answers with a perfectly
 * ordinary in-range integer for most of it — see `#streamEvents`' docstring for the row of
 * measurements. `NaN` loses every comparison in `resumable`, which is the one place in this
 * codebase where that is the wanted behaviour rather than the bug (HANDOFF A12), and the
 * caller therefore gets the snapshot branch: a baseline it can SEE it received.
 *
 * No length cap: an absurd run of digits parses to a number far above `head` or past
 * `MAX_SAFE_INTEGER`, and `resumable` refuses both. The header itself is bounded by
 * `node:http`.
 */
function seqIn(raw: string): number {
  return /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

/**
 * A rejection from injected code, rendered for a log line WITHOUT trusting it.
 *
 * `toLoomError` is the normal answer and is not usable here: it does `String(e)`, which
 * THROWS on a value with no primitive conversion — `Object.create(null)` is one — and the
 * one caller of this function is a `.catch` on a promise nobody awaits, where the only
 * backstop is that caller's own `try`, and reaching it means the operator is told NOTHING
 * about a run that was accepted 202 and never started. See HANDOFF A1.
 *
 * **THIS DOCSTRING CLAIMED TOTALITY AND THE COUNTEREXAMPLE WAS THE FUNCTION'S OWN FIRST
 * BRANCH.** It read `if (isLoomError(e)) return \`${e.code}: ${e.message}\`;` outside the
 * only `try` in the body, justified as "`LoomError` is ours and its fields are plain" — true
 * of every `LoomError` this process constructs, and not a statement about the VALUE, because
 * `isLoomError` is `e instanceof LoomError` and **`instanceof` proves a prototype, not
 * provenance**. That is HANDOFF's own trap note, which the next sentence of this docstring
 * cited to justify wrapping the `Error` branch. `Object.create(LoomError.prototype, {code:
 * {get() { throw }}})` is one line, and so is a `Proxy` whose `getPrototypeOf` trap makes
 * the `instanceof` ITSELF throw — before any branch is chosen.
 *
 * So the order is now: decide what can be decided WITHOUT touching the value (`typeof` and
 * `null`, facts reading cannot change), then put everything that touches it — the two
 * `instanceof` tests included — inside one `try`. Each read is checked to be a string rather
 * than interpolated, because a `code` that is an object runs its own `toString` on the way
 * into a template. TOTAL, and now tested on the branch that was not: *A REJECTION WEARING
 * `LoomError.prototype` IS STILL REPORTED*.
 */
function describeFailure(e: unknown): string {
  // Nothing is read here, so nothing can throw here.
  if (e === null || (typeof e !== "object" && typeof e !== "function")) {
    return `a rejection of type ${e === null ? "null" : typeof e} that is not an Error`;
  }
  try {
    // A FIELD IS CHECKED, NOT INTERPOLATED. `${v}` on a `code` that is an object runs that
    // object's own `toString`, which is the same untrusted call this branch is wrapped for.
    const text = (v: unknown): string => (typeof v === "string" ? v : `(${v === null ? "null" : typeof v})`);
    if (isLoomError(e)) return `${text(e.code)}: ${text(e.message)}`;
    if (e instanceof Error) return `${text(e.name)}: ${text(e.message)}`;
  } catch {
    return "a rejection whose class or fields could not be read";
  }
  return `a rejection of type ${typeof e} that is not an Error`;
}

/**
 * The request target as a URL, or `undefined` when the caller did not send one.
 *
 * `Host: a b` is a header value llhttp accepts and `new URL` rejects, so this parse is
 * reachable by one unauthenticated packet on a raw socket — no token, no signature, not
 * even a real runId. It used to run outside the handler's try block, where the throw
 * propagated through `Server.emit` and killed the process. `Host: [`, `Host: %%` and an
 * absolute-form target of `http://[` do the same thing.
 *
 * The parse is total here, and the caller answers 400. A stranger sending nonsense is
 * not an internal error and must not be able to make the server behave as though it were.
 */
function requestUrl(req: IncomingMessage): URL | undefined {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  } catch {
    return undefined;
  }
}

/**
 * The catch of last resort, for a rejection `#dispatch` did not already handle.
 *
 * It answers if it still can and hangs up if it cannot. What it must never do is throw:
 * this runs inside a promise handler attached to a `node:http` request callback, and a
 * throw here is the uncaught exception the whole arrangement exists to prevent.
 */
function lastResort(res: ServerResponse, e: unknown): void {
  try {
    const le = toLoomError(e);
    send(res, httpStatusFor(le), { error: le.toJSON() });
    if (!res.writableEnded) res.end();
  } catch {
    res.destroy();
  }
}

/**
 * Percent-decode without letting a malformed escape become a 500.
 *
 * `decodeURIComponent("%zz")` throws `URIError`, which the dispatcher would map to
 * "a bug in Loom". On an unauthenticated route it is not a bug in Loom; it is a stranger
 * sending nonsense, and the undecoded string will simply match no channel.
 */
function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** All headers, flattened. A channel needs the pair it signs with, and names vary. */
function headerMap(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) out[k] = Array.isArray(v) ? v[0] : v;
  return out;
}

/**
 * One JSON response, or nothing if this response is already spoken for.
 *
 * The guard is what makes the request deadline safe: after a 504 the handler that lost
 * the race is still running and will eventually try to answer, and `writeHead` on a
 * finished response throws `ERR_HTTP_HEADERS_SENT` — inside a promise nobody is awaiting
 * any more. Dropping the second answer is the correct behaviour anyway; a client cannot
 * be told two things.
 */
function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

/**
 * The wire shape of an event, redacted on the way out.
 *
 * The journal keeps real values — it is the source of truth, and redacting it would
 * corrupt channel state. Anything crossing the process boundary is redacted using the
 * event's own declared classification.
 */
function frame(e: JournalEvent): unknown {
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    taskId: e.taskId,
    actor: e.actor,
    payload: redactPayload(e.payload, e.classification),
  };
}

/**
 * A projection trimmed for the wire.
 *
 * Task and gate maps are sent as arrays because a 500-branch run's task map is the
 * bulk of the payload and the client renders it as a list anyway.
 */
function summarise(p: import("../run/projection.ts").RunProjection): unknown {
  return {
    runId: p.runId,
    status: p.status,
    seq: p.seq,
    graphHash: p.graphHash,
    posture: p.posture,
    // Channel values reach a browser here, so they are swept on the way out. The
    // per-channel classification lives in the GraphSpec; without it in hand the
    // conservative `internal` sweep still catches credential shapes in model output.
    channels: redactPayload(p.channels, "internal"),
    outputs: redactPayload(p.outputs, "internal"),
    usage: p.usage,
    reservedUsd: p.reservedUsd,
    budgetExhausted: p.budgetExhausted,
    unknownEffects: p.unknownEffects,
    error: p.error,
    tasks: Object.values(p.tasks).map((t) => ({
      taskId: t.taskId,
      nodeId: t.nodeId,
      state: t.state,
      attempt: t.attempt,
      branch: t.branch.segments.map((s) => `${s.edgeId}[${s.index}]`).join("/"),
      take: t.take,
      error: t.error,
    })),
    gates: Object.values(p.gates),
  };
}

/**
 * Graphs whose gates name approvers no caller of THIS PLANE'S API could ever be.
 *
 * The earliest point at which "this deployment cannot identify anyone" and "this graph
 * requires a named person" are both in the same process. The compiler can see the second
 * and never the first, so this is where the two meet — at boot, by name, rather than at
 * the first refused approval.
 *
 * IT ANSWERS ABOUT ONE OF THE TWO DOORS, and the title used to overstate that. A signed
 * callback names its own approver — `GateCallbackRouter` never consults `identity`, which
 * is the entire reason that route is reachable without a bearer token — so a deployment
 * with an answerable channel can answer these gates while having no identity source at
 * all. This function cannot see that: `ControlPlaneOptions.dispatcher` says a route
 * exists, not whether a channel's subject mapping produces the subjects a graph named.
 * The caller with both facts in view is the deployment layer, and `loom serve` is where
 * the two are weighed — see `announce` in `cli.ts`.
 */
export function unanswerableGraphs(opts: ControlPlaneOptions): readonly string[] {
  if (opts.identity !== undefined) return [];
  return Object.entries(opts.graphs ?? {})
    .filter(([, g]) => g.spec.nodes.some((n) => (n.humanGate?.approval?.approvers ?? []).length > 0))
    .map(([name]) => name);
}

/** Convenience for tests and the CLI. */
export async function startControlPlane(opts: ControlPlaneOptions, port = 0): Promise<{ plane: ControlPlane; port: number }> {
  // BEFORE the socket. An empty `token` is refused in here, so a deployment that meant to
  // pass a secret and passed nothing never binds a port — a plane that started and then
  // refused every request would still be in rotation, but this one is never in service.
  const plane = new ControlPlane(opts);
  const { port: bound } = await plane.listen(port);
  if (plane.openToEveryCaller) {
    // Loud, because an open control plane can start runs that spend money. Read off the
    // plane rather than re-derived from `opts`, so this line and `/health` cannot disagree.
    console.error("[loom] control plane started with NO TOKEN — every caller is authorized");
  }
  const stranded = unanswerableGraphs(opts);
  if (stranded.length > 0) {
    // Louder, because the failure mode is a run that waits forever at a gate nobody can
    // answer — and the operator's first sight of it is otherwise a 403 hours later.
    console.error(
      `[loom] NO IDENTITY SOURCE — gates naming approvers cannot be answered through the API. Affected graphs: ${stranded.join(", ")}`,
    );
  }
  // THE LIMIT, SAID OUT LOUD to the only person who can weigh it.
  //
  // Only when there is more than one principal, because with one there is nobody to be
  // isolated from and a warning that fires when nothing is wrong is a warning operators
  // learn to skip. It fires on the arrangement that IMPLIES isolation — several
  // credentials, several names — which is precisely when the absence of scoping is a
  // surprise rather than a given.
  const principals = plane.distinctPrincipals;
  if (principals > 1) {
    console.error(
      `[loom] EVERY CREDENTIAL IS A FULL OPERATOR CREDENTIAL — ` +
        `${Number.isFinite(principals) ? `${principals} principals are` : "more than one principal is"} configured, and runs are NOT scoped to the principal that submitted them: ` +
        `any of them can read, stream and cancel any other's run, gate payloads included. See design/loom/01-INTERFACES.md D3.17.`,
    );
  }
  return { plane, port: bound };
}
