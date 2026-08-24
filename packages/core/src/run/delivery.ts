/**
 * Gate delivery, and the escalation chain.
 *
 * Raising a gate makes the decision durable. DELIVERING it is what makes the decision
 * happen — a gate nobody was told about is an outage with extra steps, and a queue you
 * have to remember to check is not oversight.
 *
 * The rule the whole file is arranged around:
 *
 * > **DELIVERY FAILURE NEVER AUTO-APPROVES.**
 *
 * Every channel failing is a *notification* problem, not an authorization one. The gate
 * stays open, the failure is journaled, and the only ways out remain a human decision or
 * the declared timeout policy. Anything else would make an unreachable Slack workspace
 * into a way to approve a production restart.
 *
 * Channels are injected and the built-ins use only `fetch` and a callback, so this stays
 * zero-dependency. A real Slack or PagerDuty integration is a `DeliveryChannel` living
 * outside `@loom/core`, which is where a vendor SDK belongs.
 *
 * The second half of the file is the RETURN path — a button click coming back as a
 * decision. It is arranged around a second rule:
 *
 * > **THE SIGNATURE IS THE ONLY AUTHENTICATION AN INBOUND CALLBACK HAS.**
 *
 * Slack does not hold the control plane's bearer token, so the callback route is
 * reachable without one. That makes the HMAC check the entire perimeter: verify it over
 * the RAW BYTES before parsing, before looking up a gate, before any durable write, or
 * the endpoint is a way to approve a production action by POSTing JSON.
 *
 * See design/loom/04-OVERSIGHT.md D7.3 and 01-INTERFACES.md D3.20.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { digest } from "../canonical.ts";
import { CODES, err, isLoomError, LoomError, type Code, type ErrorClass } from "../errors.ts";
import type { GateId, RunId } from "../ids.ts";
import { SYSTEM_ACTOR, type HumanActor } from "../journal/events.ts";
import { maskLiterals, redact } from "../security/redact.ts";
import { gateDecisionOf, maxClassification, type Classification, type GateDecision } from "../vocab.ts";
import type { GateSummary, ResolveInput } from "./gates.ts";
import type { RunLog } from "./log.ts";
import { isTerminal, openGates as openGateRecords, type GateRecord, type RunProjection } from "./projection.ts";

/**
 * Who a gate is routed to. Resolved by the channel, not by the broker.
 *
 * `kind` and `id` are what this module reads and all `graph/validate.ts` checks — and a
 * graph may declare MORE on an entry (a vendor's channel id, a locale, whatever the channel
 * doing the resolving needs). The compiler admits those keys, so the dispatcher carries
 * them: a `Recipient` is resolved by the channel, which makes the channel the one party
 * that could use them. See `ownedRecipients` for the copy and for that decision.
 */
export interface Recipient {
  readonly kind: "user" | "role" | "group";
  readonly id: string;
}

export interface DeliveryTarget {
  /**
   * The gate itself — and its `payload` is the REDACTED one, not the gate's own.
   *
   * `GateSummary` is the broker's join of the durable record with the payload a human
   * reads, so it carries a `payload` of its own, and for three waves the dispatcher put
   * the summary on the target verbatim next to the redacted copy. The field below said
   * "a channel never sees what the classification said to hide" while this one handed
   * over exactly that, by reference. `GateDispatcher.deliver` now splices the redacted
   * payload into the summary too, so the two fields agree and neither is a way back.
   *
   * Everything else on it is the gate's ADDRESS and its CLOCK — `gateId`, `runId`,
   * `nodeId`, `deadline`, `tier` — which is what the built-in channels read and all any
   * channel needs. IT IS ALSO THE GATE'S AUTHORIZATION, which is the half that sentence
   * left out for a wave: `approvers` and `allowEdit` ride on a `GateSummary` too, they
   * arrive as the compiled graph node's own arrays, and a shallow spread handed them over
   * BY REFERENCE — so a channel could `push` itself into the approvers list of the next
   * gate on that node. `shownGate` copies every container now; see `deliver`'s prelude.
   *
   * `contentDigest` was the one field still derived from the unredacted payload, and it
   * was an inversion oracle over every field the redact list hid; a channel now gets the
   * digest of what it was SHOWN — with a redact list, every hidden POSITION rendered as one
   * constant; without one, the digest of the copy it was handed, which for everything the
   * journal can carry is the journal's own digest.
   *
   * WHAT THE DIGEST IS A FUNCTION OF IS THE CLAIM, AND IT HAS A CONDITION: **for a plain
   * JSON value, at a depth `redact` still walks, that the payload does not also carry at a
   * position the list did not name**, a hidden position is the constant `[secret]` in the
   * digested tree — so no hidden value is an input to it and there is nothing for a guesser
   * to converge on. Outside that condition a hidden position's value IS an input: a
   * `SecretValue` renders its own `ref`, so *which* secret sits there moves the digest. That
   * is not a new disclosure — the channel is handed the same rendering by the same arm — but
   * it is a different claim, and the unconditional version of this sentence stood here for a
   * wave with its counterexample in the pinning file all along (*A HIDDEN POSITION IS NOT
   * ALWAYS THE CONSTANT*). `deliver`'s prelude enumerates and measures the arms.
   *
   * It is a stronger claim than "the channel can recompute it" rather than a synonym for it.
   * The digest is NOT in general checkable by the channel holding it; see `deliver` for who
   * it is for, why that is the right trade, and what it costs.
   */
  readonly gate: GateSummary;
  /**
   * Where it is routed, as objects this module built — every field the graph declared.
   *
   * A copy because the compiled graph holds these objects and a channel that edits one
   * changes who the NEXT tier is told; whole because `graph/validate.ts` admits keys beyond
   * `{kind, id}` and a channel is the party that resolves them. See `ownedRecipients`.
   */
  readonly recipients: readonly Recipient[];
  /**
   * Already redacted. A channel never sees what the classification said to hide.
   *
   * Read that as a claim about THIS WHOLE OBJECT and not about this field, because a
   * channel is handed the object: it held once for `payload` alone while `gate.payload`
   * sat next to it unredacted, which is a promise kept in the letter and broken in the
   * only reading anyone has.
   *
   * AND THE WHOLE OBJECT INCLUDES ITS IDENTITIES, not only its values. The second time this
   * failed, nothing on it disclosed anything — `gate.approvers` was the right list, shown to
   * a party entitled to see it, and it was the SAME ARRAY the compiled graph would hand the
   * next gate on that node. Both halves are now pinned by an identity walk over the target
   * rather than by a list of field names, which is what missed this one.
   */
  readonly payload: unknown;
  /** Which escalation tier this is. 0 is the original delivery. */
  readonly tier: number;
}

export interface DeliveryChannel {
  readonly name: string;
  /**
   * Deliver, returning a RECEIPT — an id the channel can be asked about later.
   *
   * Throwing means "not delivered". A channel that swallows its own errors and returns
   * a receipt anyway is worse than no channel: it converts a silent non-delivery into a
   * recorded delivery, and the SLA sweep will then blame the human.
   */
  deliver(target: DeliveryTarget, signal: AbortSignal): Promise<string>;
  /**
   * The return path: turn a signed inbound request into a decision, or throw.
   *
   * OPTIONAL, and its absence is the honest answer for most channels — `ConsoleChannel`
   * has no inbound path and must not be made to fake one. Presence is therefore
   * meaningful: `channel.parseCallback !== undefined` is exactly the test for "this
   * channel can be answered", and a channel that defined the method and then refused
   * every call would destroy that signal.
   *
   * Implementations MUST verify authenticity over `req.body` — the bytes as received —
   * before parsing them, and MUST reject a request whose timestamp is outside the
   * replay window. They must return the human the signature vouches for; a channel that
   * cannot name one must throw rather than invent `unknown`.
   *
   * Verification only. Authorization against the gate's `approvers`, the gate's state,
   * and the decision itself all belong to `GateCallbackRouter` and `HumanGateBroker`,
   * because a channel that could decide those would be a second guard chain.
   */
  parseCallback?(req: CallbackRequest): Promise<CallbackDecision>;
}

/**
 * An inbound callback, as bytes.
 *
 * `body` is a `Uint8Array` and not a parsed object ON PURPOSE. `JSON.parse` followed by
 * `JSON.stringify` does not round-trip byte-identically — key order, number formatting
 * and unicode escapes all survive the first hop and not the second — so a signature
 * verified against a re-serialization is verified against a string the sender never
 * produced. It passes for the payloads a test happens to use and fails in production,
 * which is the worst available failure mode for an authentication check.
 */
export interface CallbackRequest {
  /** The raw request body. Never re-serialize this before signing over it. */
  readonly body: Uint8Array;
  /** Lower-cased header names, as `node:http` delivers them. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Injected wall clock, for the replay window. Tests must not wait for real time. */
  readonly now: number;
}

export interface CallbackDecision {
  /** From the SIGNED body. The route checks it against the address that was posted to. */
  readonly runId: RunId;
  readonly gateId: GateId;
  readonly decision: GateDecision;
  /** The human the signature vouches for. Never `{kind: "system"}`. */
  readonly actor: HumanActor;
  /**
   * Feeds `HumanGateBroker.resolve`'s existing key, and no other mechanism.
   *
   * Deriving it from the request rather than minting one is what makes a channel retry
   * of the identical bytes collapse into the one decision that was already recorded.
   */
  readonly idempotencyKey: string;
}

/** One escalation tier: after this long, tell these people instead. */
export interface EscalationTier {
  readonly afterMs: number;
  readonly to?: readonly Recipient[];
  /** Channels for this tier. Absent ⇒ reuse the gate's channels. */
  readonly channels?: readonly string[];
  /** Terminal tier: the chain is exhausted and the gate expires. */
  readonly action?: "fail";
}

export interface DeliverySpec {
  readonly channels: readonly string[];
  readonly recipients?: readonly Recipient[];
  /**
   * Field names to redact before delivery, matched recursively by key.
   *
   * DEVIATION from D7.2's `redact: [pii]`. A classification tokenises the WHOLE payload,
   * which defeats the point of a gate: a human cannot approve what they cannot see. So
   * the knob is the field set, and everything outside it stays legible — the approver
   * reads the command and the blast radius, and never reads the email address.
   *
   * Applied here, before any channel is called. A channel is outside the trust boundary,
   * and redacting in the UI would already be too late.
   *
   * NOT AN ERASURE MANDATE, which is the other half of "applied here". The journal keeps
   * the real values and so does the read model an authenticated operator reads through
   * `GET /runs/:id/gates` — a redacted journal folds to corrupted channel state (D9.6).
   * This list decides what leaves the trust boundary, not what the system remembers.
   */
  readonly redact?: readonly string[];
  /**
   * How redacted fields are rendered. Default `pii`, which tokenises IRREVERSIBLY.
   *
   * The token is stable across occurrences so a channel can still tell "the same
   * requester again" from "a different one" — WITHIN ONE RUN, which is the scope the key
   * has and the scope this sentence means. Two runs tokenise the same person differently,
   * on purpose: a channel that could compare across runs could also build the table.
   *
   * THIS LINE HAS NOW BEEN WRONG THREE TIMES, and each correction was narrower than the
   * last, which is what a claim about a hash looks like while it is being sized properly.
   * It said the token is "reversible" for as long as the field existed, which was the
   * opposite of what `piiToken` was for. That was corrected to "it is a sha256 prefix, so
   * it is not a way back to the value" — true of a high-entropy string and false of a
   * five-digit id, which fell to a brute force in 18 ms. That was corrected to "keyed, so
   * the holder cannot invert it" — true of a holder who cannot CHOOSE what gets tokenised,
   * and false of anyone who can submit a graph, because one key for the whole process makes
   * their own gate delivery a tokenising oracle for everybody else's runs. A property of a
   * key is not a property of a key SHARED WITH THE ATTACKER. See `piiToken` and `tokenKey`.
   *
   * FLOORED AT `pii` — `public` and `internal` classify data as not sensitive, and asking
   * for a hidden field to be rendered as not-sensitive rendered it as itself. See
   * `redactFields`.
   */
  readonly redactAs?: Classification;
  readonly escalation?: readonly EscalationTier[];
}

/**
 * Why a callback was refused — a CLOSED SET, and that is the point.
 *
 * This token is what lands in `gate.callback_rejected`. The event is reachable by an
 * unauthenticated stranger, so the reason may not carry anything they typed: an
 * attacker who can write free text into an audit row can forge the audit row's own
 * story. Every message that *does* quote a caller stays in the HTTP response, which is
 * not durable and which only that caller reads.
 */
export const CALLBACK_REJECTIONS = [
  "unknown_channel",
  "signature",
  "timestamp",
  "malformed",
  "run_mismatch",
  "not_found",
  "already_resolved",
  "not_authorized",
  "timeout",
  "internal",
] as const;

export type CallbackRejection = (typeof CALLBACK_REJECTIONS)[number];

/**
 * The reason → code mapping, in ONE place.
 *
 * D3.20 lets `parseCallback` raise `E_GATE_NOT_AUTHORIZED`, `E_GATE_NOT_FOUND` and
 * `E_GATE_ALREADY_RESOLVED`. A bad signature and a stale timestamp are both the first
 * of those: the caller failed to prove it may answer this gate, and saying so in more
 * detail would tell a prober which half it got wrong.
 *
 * `E_PROVIDER_BAD_REQUEST` is the one addition, for a request that verified and then
 * turned out to be nonsense. That is a real integration bug in a service that holds the
 * secret, and answering it with 403 would send its author looking for a key problem
 * they do not have.
 */
export function callbackRejection(reason: CallbackRejection, message: string): LoomError {
  const init = { details: { reason } };
  switch (reason) {
    case "signature":
    case "timestamp":
    case "not_authorized":
      return err.policy(CODES.E_GATE_NOT_AUTHORIZED, message, init);
    case "unknown_channel":
    case "not_found":
      return err.notFound(CODES.E_GATE_NOT_FOUND, message, init);
    case "already_resolved":
      return err.conflict(CODES.E_GATE_ALREADY_RESOLVED, message, init);
    case "malformed":
    case "run_mismatch":
      return err.validation(CODES.E_PROVIDER_BAD_REQUEST, message, init);
    case "timeout":
      // THE DEPLOYMENT RAN OUT OF TIME, NOT THE CALLER, so it is neither a bad request nor a
      // policy refusal — the work was abandoned, which is what `cancelled` means here.
      //
      // NOT `E_REQUEST_TIMEOUT`, though that code now exists — it is the control plane's own
      // deadline on an inbound request, and this is a gate delivery giving up on an outbound
      // one. The caller has already seen its 504; this is the audit row for the abandoned work.
      return err.cancelled(message, init);
    case "internal":
      return err.internal(CODES.E_INTERNAL, message, init);
  }
}

/**
 * The rejections a caller reaches WITHOUT having shown it belongs here.
 *
 * Three of them are the checks a caller passes by HOLDING THE CHANNEL'S SECRET, and they
 * are therefore the checks that can be decided with no state at all — no run, no gate, no
 * read model. `GateCallbackRouter.handle` answers them before it looks anything up, so a
 * stranger cannot make the control plane do work or write a row by POSTing at a URL that
 * was, by construction, handed to a third party.
 *
 * `internal` is the fourth, and it is here for a different reason. It is what an UNTYPED
 * throw out of `parseCallback` becomes, and an untyped throw is precisely the case where
 * the channel reported no verdict on the signature at all. A channel is injected code; one
 * whose `parseCallback` throws before it checks anything — a plain integration bug — used
 * to buy an unauthenticated stranger one durable row per POST, headers empty, on a live
 * gated run. A channel that blew up proves nothing about the caller, so the caller has not
 * earned a row.
 *
 * WHAT THIS SET DOES NOT COVER, because the placement is the distinction: it is consulted
 * at exactly one point, the catch around `parseCallback`. An `internal` raised AFTER
 * verification — the approvers read model being unavailable, say — is still journaled,
 * because by then `parseCallback` has returned and the caller demonstrably used the secret.
 */
const PERIMETER_REJECTIONS: ReadonlySet<CallbackRejection> = new Set([
  "unknown_channel",
  "signature",
  "timestamp",
  "internal",
]);

/**
 * The bucket a refusal is counted under when no configured channel was ever named.
 *
 * A LITERAL, not the name off the URL. The counter is keyed by channel, so keying it by
 * attacker-supplied bytes would make an unauthenticated route into an unbounded map —
 * the memory-exhaustion vector the counter exists to be safe from.
 */
const UNNAMED_CHANNEL = "(unknown)";

/**
 * How many refusals ONE run may put in its own journal, per process.
 *
 * Sized for the legitimate case and not for the attack: a gate refusing the wrong person,
 * a service retrying a body it has got wrong, a mapping bug clicked at a few times. Past
 * that the rows repeat and stop being evidence, and `refusals()` carries the volume.
 *
 * REVERSE IT if a deployment finds a real run that legitimately exceeds this — the number
 * is a guess about human behaviour, not a property of the protocol.
 */
const MAX_DURABLE_REFUSALS_PER_RUN = 32;

/** How many runs that cap is tracked for at once. Bounded memory, oldest evicted. */
const MAX_TRACKED_RUNS = 1024;

// ---------------------------------------------------------------------------
// THE BOUNDARY
// ---------------------------------------------------------------------------
//
// Four waves running, the untyped exit out of this file was a read of a value that came
// from injected code, on an error path. Each was found one property over from the last —
// `describeCause`'s `name`, then `journalMessage`'s `message`, then `rejectionReasonOf`'s
// `details`, then `parsed.runId` — and each was fixed where it was found. That is not a
// series of unrelated bugs; it is the same bug, uncovered four times, and a fifth local
// `try` would only move the frontier one property further along.
//
// So the arrangement is inverted. There is ONE place where a value from outside becomes a
// value this module built, and EVERYTHING downstream reads the owned copy:
//
//   - a channel's thrown error       → `ownError`      (a `LoomError` we constructed)
//   - a channel's parsed callback    → `ownedCall`     (every property, read and checked)
//   - a channel's receipt            → `usableReceipt` (a string, or a failure)
//   - a channel's name               → `channelName`   (once, at construction)
//   - an id crossing into a lookup   → `safeGateId`    (a string that is only a string)
//   - a vendor hook's answer         → `ownedDecision` + the `typeof` on `subjectOf`
//   - an engine's or a store's throw → `ownError`, at every await ON THE CALLBACK PATH
//
// THAT LAST LINE SAID "at every await that can reject" AND THIS FILE IS ITS OWN
// COUNTEREXAMPLE: `GateDispatcher.deliver`'s closing `await log.append(...)` is not owned.
// Reproduced with a `RunLog` whose `append` rejects with `Object.create(null)` — `deliver`
// exits with a value for which `instanceof Error` is false. It is left that way ON PURPOSE
// and the scope is the reason. Owning an error costs its `details`, which is the store's own
// diagnosis of why an append failed; the argument for paying that on the callback path is
// that the next reader there is `toLoomError` in the HTTP layer, on the one route reachable
// without a credential, where a partial read loses the refusal entirely. `deliver`'s caller
// is `HumanGateBroker.raise` inside the engine. Nothing unauthenticated reads it, nothing
// branches on its shape, and the gate is durable before delivery starts — so the trade runs
// the other way. Say which awaits, not "every".
//
// Each of those is TOTAL: it returns a value for every input, including a proxy whose
// traps all throw. Downstream of them, a bare `x.y` is allowed and is the point — the
// property "no injected value is read bare" is then checkable by looking at this list and
// the handful of call sites, rather than by remembering which getter somebody hardened.
//
// THREE THINGS THE BOUNDARY GUARDS AGAINST, and they are one thing: the object you were
// handed is not the object you assumed.
//
//   1. a property is a CALL — a getter or a proxy trap runs, and may throw;
//   2. a value is not the TYPE it claims — `deliver` promising a `string` may resolve a
//      symbol, and the type system stops caring at the interface;
//   3. a name may resolve through a PROTOTYPE — a bare `gates["__proto__"]` answers with
//      `Object.prototype`, so a gate nobody raised reads as one that exists. (The lookup
//      in `projection.ts` closed this at its own door too; both stay.)
//
// WHAT IS DELIBERATELY OUTSIDE IT, stated so the property above is a claim and not a
// slogan. Two kinds of value are still read bare, both of them the ENGINE'S rather than a
// channel's:
//
//   - the `GateSummary` and `DeliverySpec` that `GateDispatcher.deliver` is CALLED with.
//     Its prelude reads `gate.gateId`, `gate.payload`, and — since the redaction fix —
//     every own property of the summary, because it spreads it to splice the redacted
//     payload in. All of that is outside any try;
//   - the `RunProjection` that `resolveGate` resolves and `handle` hands back in
//     `CallbackResult`. The HTTP layer reads `.status` off it.
//
// WHAT THAT EXCLUSION COSTS, measured rather than asserted, because "outside the boundary"
// is easier to write than to price. `deliver` does `names.map(...)` on `tierChannels`'
// answer, which is `spec.channels` verbatim: `{channels: "console"}` exits `deliver` with
// `TypeError: names.map is not a function`, and `{}` with `Cannot read properties of
// undefined`. `formatRecipients` is the same read one file along — `gates.ts`'s `#fireTimeout`
// hands it `tierRecipients(spec, tier)` while building `gate.escalated`. BOTH ARE CLOSED FOR
// A COMPILED GRAPH and only for one: `checkDelivery` refuses a `channels` that is not a name
// list, and refuses a non-array `escalation` — and it does NOT refuse a non-array
// `recipients`, which is why `ownedRecipients` has to cope with one at run time. The residual
// is an embedder driving `GateDispatcher` or `HumanGateBroker` directly with a hand-built
// spec, which is a configuration error at its own door, on the trusted side, with no
// unauthenticated party anywhere near it. The cheap way to close the rest is one more
// `bad(...)` in `checkDelivery`, not a second guard chain here.
//
// Both are read models this process folded out of its own journal, on the trusted side of
// the boundary. Owning them would mean copying a read model on every call and would say
// nothing true about where the untrusted values come in — which is `DeliveryChannel` and
// nothing else. What is NOT excused by that argument is an error the engine or the store
// THROWS: those go through `ownError` like a channel's, because a refusal that cannot be
// recorded is the failure this whole arrangement exists to prevent, and because the next
// reader of an escaping throw is `toLoomError` in the HTTP layer, whose `String(e)` is
// partial for exactly the values that reach it here.

/**
 * ONE property of a value from OUTSIDE, read TOTALLY — and the only way this module reads
 * one.
 *
 * A property access is a function call whenever the value is not ours: a getter runs, a
 * proxy trap runs, and either may throw. That is a nuisance almost everywhere and a
 * SEVERITY here, because the reads on this module's error paths happen *inside* catch
 * blocks — `rejectionReasonOf` from `handle`'s catch and from `#refuse`, `journalMessage`
 * while building a journal batch several channels' records depend on. A throw from one of
 * those is not a bad message; it is the untyped exit the surrounding contract exists to
 * remove, and it costs whatever the catch was on its way to doing. Three separate waves
 * have now found a reader or a formatter in exactly that position, which is the argument
 * for one accessor rather than a fourth local `try`.
 *
 * `undefined` for anything unreadable, deliberately conflated with "absent": a caller that
 * has to tell those apart is a caller that has to handle a throw again. Primitives short
 * out before the access, so a bare string cause costs no try/catch.
 *
 * It does NOT make the values safe — only the READ safe. Everything downstream still
 * checks the type it got and bounds the length it got, because a readable value from
 * outside is still a value from outside.
 */
function readProp(v: unknown, key: string): unknown {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return undefined;
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** What an unreadable throw degrades to on the way IN: the channel reported nothing. */
const INBOUND_FALLBACK: { readonly class: ErrorClass; readonly code: Code } = {
  class: "internal",
  code: CODES.E_INTERNAL,
};

/** …and on the way OUT: whatever happened inside the channel, the gate was not delivered. */
const OUTBOUND_FALLBACK: { readonly class: ErrorClass; readonly code: Code } = {
  class: "unavailable",
  code: CODES.E_GATE_DELIVERY_FAILED,
};

/** Said when the thrown value carried no message of any kind — `Promise.reject()`. */
const NO_MESSAGE = "a channel threw a value carrying no message";

function isRejection(v: unknown): v is CallbackRejection {
  return typeof v === "string" && (CALLBACK_REJECTIONS as readonly string[]).includes(v);
}

/**
 * A value a CHANNEL threw, REBUILT as an error this module owns. Total, for any input.
 *
 * `toLoomError` cannot be this, in two different ways, and both were live bugs:
 *
 *   - it returns `e` UNCHANGED when `isLoomError(e)`, and `isLoomError` is an `instanceof`
 *     — which proves the prototype and nothing about provenance. A channel is injected
 *     code in this process and can construct a `LoomError` as easily as we can. So the
 *     booby-trapped accessor that `readProp` was added to survive escaped WITH the error:
 *     `handle` exited "typed", and then `LoomError.toJSON` read `this.details` bare and the
 *     HTTP error path detonated it one layer out. Hardening the readers inside this file
 *     while handing the object itself to callers who read it bare is not a boundary; it is
 *     a boundary with a hole shaped exactly like the value that was supposed to stop.
 *   - it builds its message with `String(e)`, which throws outright for a value with no
 *     primitive conversion (`Object.create(null)`). On this path a normalizer that throws
 *     loses the refusal entirely — not journaled, not counted, out as a bare TypeError.
 *
 * WHAT SURVIVES THE COPY is exactly what the taxonomy needs and nothing else. `class` and
 * `code` are validated and copied, because `retryable` is derived from the class and the
 * engine checks it before it consults `retry.onlyIf` — so an operator's cancel has to stay
 * `cancelled`/`E_CANCELLED`. The message is bounded. `details` is REPLACED by an owned
 * `{reason}` when the value carried a token from the closed set, and dropped otherwise: it
 * is the one field of an error that is unbounded, arbitrary, and copied verbatim into a
 * journal row by `errorRecord`, and the token is the only part of it this module reads.
 * The original rides in `cause`, which `toJSON` and `errorRecord` both drop, so a debugger
 * still has all of it and no durable row does.
 */
function ownError(e: unknown, fallback: { readonly class: ErrorClass; readonly code: Code } = INBOUND_FALLBACK): LoomError {
  const cls = readProp(e, "class");
  const code = readProp(e, "code");
  const name = readProp(e, "name");
  const reason = readProp(readProp(e, "details"), "reason");
  // `toLoomError`'s one special case, kept: an abort is the operator's doing, and the
  // class decides both `retryable` and the status code an operator sees.
  const aborted = !isErrorClass(cls) && name === "AbortError";
  return new LoomError(
    isErrorClass(cls) ? cls : aborted ? "cancelled" : fallback.class,
    typeof code === "string" && code !== "" ? code.slice(0, MAX_CODE) : aborted ? CODES.E_CANCELLED : fallback.code,
    ownMessage(e, name),
    {
      cause: e,
      ...(isRejection(reason) ? { details: { reason } } : {}),
    },
  );
}

/** The one string of a thrown value that a caller ever sees, bounded and total. */
function ownMessage(e: unknown, name: unknown): string {
  const message = readProp(e, "message");
  if (typeof message !== "string") {
    // Not an Error shape at all: a bare string, a symbol, a null-prototype object.
    // `describeCause` is the total printer, and it already bounds what it produces.
    const described = describeCause(e);
    return described === "" ? NO_MESSAGE : described;
  }
  // `LoomError` names itself in `code`; anything else is worth naming, because "fetch
  // failed" without "TypeError" in front of it has lost the half an operator recognises.
  const prefix = typeof name === "string" && name !== "" && name !== "LoomError" ? `${name}: ` : "";
  return `${prefix}${message}`.slice(0, MAX_CHANNEL_MESSAGE);
}

/**
 * Recover the token from anything thrown on the callback path, for the journal.
 *
 * TOTAL, because every caller is a catch block — `handle`'s, and `#refuse`'s on the way to
 * writing the audit row — so a throw from here is a refusal that lands in NEITHER sink and
 * leaves `handle` exiting untyped. It is total by CONSTRUCTION rather than by care: it
 * owns the value first, and `reasonOf` then reads an error this module built.
 *
 * IT DEGRADES DOWNWARD, never sideways. An unreadable `details` costs the precise token
 * and falls through to the code, which is coarser but still the channel's own verdict; an
 * unreadable code falls to `internal`, which `PERIMETER_REJECTIONS` treats as "the channel
 * reported nothing" and therefore counts rather than journals. Both are safe directions:
 * the worst outcome is a less specific reason, never a missing record.
 */
export function rejectionReasonOf(e: unknown): CallbackRejection {
  return reasonOf(ownError(e));
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts — whichever comes first.
 *
 * The point is NOT to cancel `work`; nothing can. It is to stop the caller's frame
 * awaiting it, so every continuation from there up unwinds and drops what it was holding.
 * On the callback route that is a request body, buffered by an unauthenticated stranger.
 *
 * `signal === undefined` means "no deadline" and returns `work` untouched — an embedder
 * calling `GateCallbackRouter.handle` directly has no request deadline to offer, and an
 * absent signal must not read as an expired one.
 *
 * THE LISTENER IS REMOVED IN A `finally`, and that is not tidiness. One `AbortSignal` is
 * shared by every await in a request, so a listener left behind per call would accumulate
 * on a live signal until the request ended — and `node` warns at eleven, which is the
 * shape of a leak fixed by adding a leak. `once: true` covers the abort path; the
 * `finally` covers the far more common one where `work` wins and the signal never fires.
 */
function raceDeadline<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(callbackRejection("timeout", "the request deadline passed before the channel answered"));
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(callbackRejection("timeout", "the request deadline passed before the channel answered"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  // `work` is still awaited by the race, so a rejection out of it is never unhandled —
  // which is what an unobserved promise would become the moment this function returned
  // the deadline's rejection instead.
  return Promise.race([work, expired]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  });
}

/** The token of an error we OWN. Bare reads, because that is what owning it bought. */
function reasonOf(le: LoomError): CallbackRejection {
  const reason = (le.details as { readonly reason?: unknown } | undefined)?.reason;
  if (isRejection(reason)) return reason;
  // A LoomError raised deeper down — by `resolve`, or by the engine — carries no token.
  switch (le.code) {
    case CODES.E_GATE_NOT_FOUND:
    case CODES.E_RUN_NOT_FOUND:
      return "not_found";
    case CODES.E_GATE_ALREADY_RESOLVED:
      return "already_resolved";
    case CODES.E_GATE_NOT_AUTHORIZED:
      return "not_authorized";
    case CODES.E_PROVIDER_BAD_REQUEST:
    case CODES.E_HUMAN_APPROVAL_REQUIRED:
      return "malformed";
    default:
      return "internal";
  }
}

/**
 * A `CallbackDecision` a channel returned, rebuilt field by field as one we own.
 *
 * `parseCallback` is an INTERFACE, so every property of what it resolves is a call into
 * injected code — and the router's reads of them sat outside every try, on the one route a
 * stranger can reach without a credential. A throwing getter on `runId` or `actor` made
 * `handle` exit untyped with the refusal in NEITHER sink, which is precisely the failure
 * this file has now closed at three other properties.
 *
 * Every field is read once, checked, and copied. `undefined` is the single failure value
 * for all of them, and every caller FAILS CLOSED on it: an unreadable `runId` cannot equal
 * the addressed one, an unreadable actor names no human, an unusable decision or
 * idempotency key is a callback this router will not forward. Nothing is invented — a
 * substituted subject would record a decision by somebody who did not make it.
 */
interface OwnedCall {
  /** Compared against the address, never used to address anything. Unbounded on purpose. */
  readonly runId: string | undefined;
  readonly gateId: GateId;
  readonly decision: GateDecision | undefined;
  readonly actor: HumanActor | undefined;
  readonly idempotencyKey: string | undefined;
}

function ownedCall(v: unknown): OwnedCall {
  const runId = readProp(v, "runId");
  const key = readProp(v, "idempotencyKey");
  return {
    runId: typeof runId === "string" ? runId : undefined,
    gateId: safeGateId(readProp(v, "gateId")),
    decision: ownedDecision(readProp(v, "decision")),
    actor: ownedActor(readProp(v, "actor")),
    // Bounded because `HumanGateBroker.resolve` keeps it in a process-lifetime map key.
    idempotencyKey: typeof key === "string" && key !== "" ? key.slice(0, MAX_ID) : undefined,
  };
}

/**
 * The human a channel says it speaks for, or nobody.
 *
 * The subject is REFUSED rather than truncated when it is too long: bounding an identity
 * changes who it names, and a journal row saying a decision was made by a subject nobody
 * can be asked about is the one thing the audit trail exists to prevent. `via` is checked
 * against the closed set because it is journaled and a caller-chosen value there is a
 * field that says whatever a channel felt like; the extras a `HumanActor` may carry are
 * copied when they are the type they claim, because dropping them loses audit detail a
 * legitimate channel meant to record.
 *
 * `via` IS THE ONE FIELD HERE THAT SUBSTITUTES RATHER THAN REFUSES, and the audit rule says
 * to say why. It is REQUIRED on `HumanActor`, so "omit it" is not available, and refusing
 * the callback over a label would let a channel's typo block an approval nobody disputes.
 * `"api"` is not invented: every decision reaching this function arrived over the callback
 * route, so it is the one substitution on this path that cannot be wrong about a fact —
 * unlike `subject`, which is the field that DECIDES, and which is refused.
 */
function ownedActor(v: unknown): HumanActor | undefined {
  if (readProp(v, "kind") !== "human") return undefined;
  const subject = readProp(v, "subject");
  if (typeof subject !== "string" || subject === "" || subject.length > MAX_ID) return undefined;
  const via = readProp(v, "via");
  const onBehalfOf = readProp(v, "onBehalfOf");
  const mfa = readProp(v, "mfa");
  return {
    kind: "human",
    subject,
    via: isVia(via) ? via : "api",
    ...(typeof onBehalfOf === "string" && onBehalfOf !== "" ? { onBehalfOf: onBehalfOf.slice(0, MAX_ID) } : {}),
    ...(typeof mfa === "boolean" ? { mfa } : {}),
  };
}

/**
 * The wire shape of a decision, validated rather than cast — and OWNED rather than passed.
 *
 * One validator for both directions: `SignedWebhookChannel` parses its own body through it
 * (where the input came from `JSON.parse` and is already ours), and the router runs a
 * channel's returned decision through it (where every read is a call into injected code).
 * Two copies of this would drift, and the copy that drifted would be the one on the path
 * nobody was watching.
 *
 * A `redirect` or an `edit` arriving over a webhook is a legitimate answer; what is not
 * legitimate is a fifth kind, or a rejection with no reason. The SHAPE is all that is
 * checked — whether an `edit` may touch a given channel is `resolve`'s call, against the
 * gate's own `allowEdit`.
 *
 * `writes` and `take` go through `ownedJson` because they are the two fields that travel
 * onward INTO A JOURNAL ROW. Passing the channel's own object would put a value with live
 * getters inside `resolve`, where `canonicalize` runs after the idempotency key has already
 * been claimed — so a hostile `writes` would fail the append and leave the key spent,
 * turning a later legitimate retry into a silent no-op.
 *
 * AND THE SHAPE OF `writes` IS ASKED OF THE INPUT, for the reason `ownedWrites` and
 * `ownedBatch` ask it there — this was the third site in the file to ask it of an `ownedJson`
 * RESULT, and the only one whose answer DECIDES A GATE. `ownedJson` reports `{}` for every
 * object whose data is not in own properties, and `{}` passes `typeof … === "object"`, so a
 * `Map` of a human's edits was accepted and journaled as an edit that edited nothing.
 * Reproduced end to end through `GateCallbackRouter.handle`: `gate.decided` recorded
 * `{"decision":"edit","writes":{}}` and the action behind the gate RAN, for a `Map`, a `Set`
 * and a class instance alike.
 *
 * `take` asks the same question of the same result and is CORRECT AS IT STANDS, which is the
 * distinction worth keeping: `{}` does not look like an array, so every degraded copy fails
 * that check and the callback is refused. `writes` is the one field whose degraded copy is
 * indistinguishable from a legitimate answer, so it is the one that needed the input.
 *
 * REFUSING is the recoverable direction and is why this is `undefined` rather than a marker:
 * the caller is told `malformed`, the gate stays open, and the human can answer again. A
 * decision recorded against their name cannot be un-made. `ownedWrites` renders a marker
 * instead because its reader is a human being shown a question, not a resolver applying one.
 */
function ownedDecision(v: unknown): GateDecision | undefined {
  // THE ACCEPTANCE SET COMES FROM `gateDecisionOf`; WHAT IS LEFT HERE IS OWNERSHIP.
  //
  // This function used to state the union member by member, and so did `checkedDecision`
  // in `server/http.ts` and `run/replay.ts`'s switch — three statements of one vocabulary,
  // in front of a broker that stated it nowhere. They agreed only because each was copied
  // from the last, and they had already drifted on the two things below. Those two are the
  // part that is genuinely this door's: the value arrives from a VENDOR ADAPTER, so its
  // reason is bounded and its containers are copied before anything downstream keeps them.
  const decision = gateDecisionOf(v);
  if (decision === undefined) return undefined;

  const reason = decision.kind === "approve" ? undefined : decision.reason?.slice(0, MAX_REASON);
  const withReason = reason === undefined ? {} : { reason };

  switch (decision.kind) {
    case "approve":
      return decision;
    case "reject":
      return reason === undefined || reason.trim() === "" ? undefined : { kind: "reject", reason };
    case "edit": {
      // THE INPUT IS SHAPE-CHECKED BEFORE THE COPY, AND THE COPY AGAIN AFTER. `ownedJson`
      // reports `{}` for every object whose data is not in own properties, so a `Map` of
      // edits would survive a check made only on the RESULT and be recorded as an edit that
      // edited nothing — on a gate a human had just been asked to edit. `gateDecisionOf`
      // decides that `writes` is an object and not an array; whether it is a PLAIN one is
      // this door's question, because only here can the answer be a vendor's `Map`.
      if (!isPlainRecord(decision.writes)) return undefined;
      const writes = ownedJson(decision.writes);
      if (!isPlainRecord(writes)) return undefined;
      return { kind: "edit", writes: writes as Record<string, unknown>, ...withReason };
    }
    case "redirect":
      // `take` needs no round trip: `gateDecisionOf` built the array itself out of values
      // it proved were strings, so it is already owned and holds no live code.
      return { kind: "redirect", take: decision.take, ...withReason };
  }
}

/**
 * A value from outside, copied into one built here — or nothing.
 *
 * A JSON round trip and not a hand-rolled walk, because the destination IS json: these
 * values end up in a journal payload, so anything the round trip cannot represent is
 * something the append would have refused anyway. It runs every getter and every proxy
 * trap ONCE, inside a try, and what comes back is a plain tree with no live code in it —
 * which is the whole point, since the next reader of it is `canonicalize`, in a place
 * where a throw costs more than the value.
 */
function ownedJson(v: unknown): unknown {
  try {
    const json = JSON.stringify(v);
    return json === undefined ? undefined : (JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

/**
 * The one read of a channel's `name`, and it happens at CONSTRUCTION.
 *
 * `name` is injected code's property like any other: a getter that throws made
 * `new GateDispatcher` exit untyped, and a getter returning a different string each time
 * made the map's keys and the counter's keys disagree — which is the memory-exhaustion
 * vector the refusal counter's docstring claims to be safe from "by construction". One
 * read, checked, and every later use is of the string that read produced.
 *
 * A CHANNEL THAT WILL NOT SAY WHAT IT IS CALLED IS A CONFIGURATION ERROR, not a channel to
 * route around. It cannot be looked up by a graph, cannot key a counter, and cannot name a
 * journal row; registering it under a substitute would make a gate silently undeliverable
 * at 3am instead of unstartable at deploy time.
 */
function channelName(c: DeliveryChannel): string {
  const name = readProp(c, "name");
  if (typeof name !== "string" || name === "" || name.length > MAX_CHANNEL_NAME) {
    throw err.validation(CODES.E_CONFIG_INVALID, "a delivery channel must have a name that is a plausible string");
  }
  return name;
}

// ---------------------------------------------------------------------------
// Built-in channels
// ---------------------------------------------------------------------------

export interface ConsoleChannelOptions {
  /** Where a queued gate goes. Defaults to collecting in memory. */
  readonly sink?: (line: string, target: DeliveryTarget) => void;
}

/**
 * The always-available fallback.
 *
 * It cannot fail, which is what makes it the fallback: the console queue is where a gate
 * lands when every other channel is down, so that "nobody was told" is never the outcome.
 *
 * WITH ONE EXCEPTION, WHICH IS IN THIS CLASS'S GIFT AND NOT IN A CALLER'S: a `sink` an
 * operator injected may throw, and `deliver` deliberately does not catch it. Everything the
 * DEFAULT construction does — queue the target, render a line — is total for any target,
 * hostile getters and revoked proxies included. Read `deliver` for the eight ways that was
 * false, and for why the sink is the one read whose throw is a real delivery failure.
 * Stating the exception here is the point: the sentence above stood unqualified while the
 * method four lines down had a `throw` in it that the same wave put there on purpose.
 */
export class ConsoleChannel implements DeliveryChannel {
  readonly name = "console";
  readonly queued: DeliveryTarget[] = [];
  readonly #sink: ConsoleChannelOptions["sink"];

  constructor(opts: ConsoleChannelOptions = {}) {
    this.#sink = opts.sink;
  }

  /**
   * IT CANNOT FAIL, WHICH IS A CLAIM ABOUT EVERY READ IN THE METHOD AND NOT ABOUT ONE OF
   * THEM.
   *
   * What resolving a receipt here ASSERTS is exactly one thing: **this target is in the
   * queue where a human will find it, and the sink was told.** Everything else the method
   * touches is RENDERING — a line for a person to read — and a rendering may not decide
   * whether a gate was queued. So the push is first, every read after it is total, and any
   * position that could not be rendered says so instead of throwing.
   *
   * The reads were partial in eight ways, and the previous wave closed one of them. It
   * replaced a bare `Array.isArray` with `isArrayValue` under the sentence "so the format is
   * total" — while the FORMAT, `formatRecipients`, went on reading the elements, `r.kind`
   * and `r.id` bare, and `${…}` coerced both. Every one of these was MEASURED on node
   * v24.16.0 against this class with a sink, and every one THREW:
   *
   * | the target | what threw |
   * |---|---|
   * | an array with a throwing accessor at `[0]` | `Error: index getter` |
   * | an entry with a throwing `kind` getter | `Error: kind getter` |
   * | an entry whose `id` throws on ToString | `Error: toString` |
   * | an entry that is a revoked proxy | `TypeError: Cannot perform 'get' on a proxy that has been revoked` |
   * | a proxy over an array whose `map` trap throws | `Error: map trap` |
   * | `gate.gateId` / `gate.nodeId` / `tier` throwing on ToString | that value's own error |
   * | no `gate` on the target at all | `TypeError: Cannot read properties of undefined` |
   *
   * AND THE FIRST FOUR ARE REACHABLE THROUGH THE DISPATCHER, which is the half that makes
   * this a severity rather than an embedder's own foot. `ownedRecipients`' degrade path
   * answers an entry it could not copy with `addressOnly`, and `addressOnly` used to copy
   * `kind` and `id` UNCHECKED — so a live object with a throwing `toString` arrived here
   * inside an otherwise well-formed list. Reproduced end to end through `GateDispatcher`
   * with `recipients: [{kind: {toString(){throw}}, id: "sre", self: <cycle>}]`:
   * **`delivered: 0, failed: 2, fellBack: false`**, journal `gate.delivery_failed ×2`. The
   * one channel that exists so that "nobody was told" is never the outcome produced exactly
   * that outcome — the same sentence the previous wave wrote here, still true, one read
   * along.
   *
   * The queue push stays above the format, because a gate landing where a human will find
   * it must not be contingent on anything being renderable about it. Every marker is
   * `formatRecipients`' and `shownText`'s, so a reader learns one vocabulary.
   *
   * "ANYONE" AND THE MARKER ARE STILL DIFFERENT FACTS. An EMPTY list renders "anyone"; a
   * non-list renders `(unrenderable)`, because a graph may declare ONE recipient where the
   * type says a list of them (`checkDelivery`'s `asArray` skips a non-array, so nothing
   * refuses it at compile time) and "the graph named nobody" is a claim about routing that
   * nothing here can support. The test is inside `formatRecipients` now rather than here, so
   * the two callers of it cannot come to disagree — see that function.
   *
   * `sink` CAN STILL THROW AND IS DELIBERATELY NOT CAUGHT, which is the same sentence read
   * against a different value and comes out the other way. Rendering a routing list is not
   * the notification; the sink IS, for a deployment whose console is a log line rather than
   * `queued`. Swallowing its throw would return a receipt for a notification that did not
   * happen — "a channel that swallows its own errors and returns a receipt anyway is worse
   * than no channel", which is `DeliveryChannel.deliver`'s own rule. So a broken sink is a
   * delivery failure and is journaled as one; an unrenderable target is not, and was.
   */
  deliver(target: DeliveryTarget): Promise<string> {
    this.queued.push(target);
    // EVERY READ THROUGH `readProp`, including `target` itself: an embedder is the party
    // this class's claim is made to, and `target.gate.gateId` on a target with no `gate` is
    // a `TypeError` before any marker gets a chance to stand in for anything.
    const gate = readProp(target, "gate");
    const gateId = safeGateId(readProp(gate, "gateId"));
    const to = formatRecipients(readProp(target, "recipients") as readonly Recipient[]) || "anyone";
    this.#sink?.(`gate ${gateId} on node ${shownText(readProp(gate, "nodeId"))} awaits ${to}`, target);
    // The receipt names the delivery and is checked by `usableReceipt` like any other, so a
    // marker in either position is a usable receipt and a throw here would not be.
    return Promise.resolve(`console:${gateId}:${shownText(readProp(target, "tier"))}`);
  }
}

export interface WebhookChannelOptions {
  readonly name?: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to the global. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * An HTTP webhook — the one real channel that costs no dependency.
 *
 * A Slack incoming webhook, a PagerDuty Events endpoint, and an internal approvals
 * service are all this shape, so one implementation covers the realistic cases without
 * `@loom/core` learning any vendor's API.
 */
export class WebhookChannel implements DeliveryChannel {
  readonly name: string;
  readonly #opts: WebhookChannelOptions;
  /**
   * The strings that may never appear in an error this channel produces.
   *
   * THE URL IS OFTEN THE CREDENTIAL. A Slack incoming webhook is a bearer token in path
   * form; `https://user:pass@host/` is one outright. `fetch` quotes the URL it was handed
   * into its own message — `TypeError: Request cannot be constructed from a URL that
   * includes credentials: https://svc:S3CRET@…` — and `undelivered` puts the cause chain
   * in `details`, which `ErrorRecord` copies into the journal verbatim. That put a secret
   * in the audit log, which is the one place a secret cannot be rotated out of.
   *
   * Masking here, in the object that owns the string, is what makes "the URL never leaves
   * this channel" a property rather than a running bet on which vendor messages happen to
   * quote it.
   *
   * The bare HOSTNAME is deliberately NOT masked: `getaddrinfo ENOTFOUND hooks.example.com`
   * is what an operator diagnoses a dead channel with, and a host is not a secret — the
   * path and the userinfo are.
   */
  readonly #secrets: readonly string[];
  /**
   * This channel's name, PROVED to be a string, and the message built from it.
   *
   * Both exist so the last resort in `#failure` can build no string at all. `name` is
   * typed `string` and is one in every real configuration, but it arrives from a config
   * object like everything else here, and a last resort that interpolates a value it did
   * not check is a last resort with the primary arm's failure mode. Checking it ONCE, at
   * construction, moves that from delivery time to config time — where a bad value is a
   * startup error rather than an untyped exit from an interface promising one code.
   */
  readonly #label: string;
  readonly #lastResort: string;

  constructor(opts: WebhookChannelOptions) {
    this.name = opts.name ?? "webhook";
    this.#opts = opts;
    this.#secrets = urlSecrets(opts.url);
    this.#label = typeof this.name === "string" ? this.name.slice(0, MAX_CHANNEL_NAME) : "webhook";
    this.#lastResort = `${this.#label} could not be reached`;
  }

  /**
   * ONE CODE OUT, and the whole method is a try block because of it.
   *
   * D3's boundary taxonomy says `deliver` raises `E_GATE_DELIVERY_FAILED` **only**, and
   * says why that is load-bearing: any other code tempts a caller into branching, and
   * every branch out of "the notification failed" that is not "leave the gate open" is a
   * way to approve something nobody approved. Mapping only the non-2xx arm honoured the
   * letter of that on the arm that almost never fires. `fetch` REJECTS for the two
   * failures that actually happen — the endpoint is unreachable (`TypeError: fetch
   * failed`) and the endpoint hangs (a `TimeoutError` `DOMException`, because
   * `AbortSignal.timeout` aborts rather than returning a response) — and both used to
   * leave here unmapped. A hung webhook reached the journal as `E_INTERNAL`, which the
   * taxonomy defines as "a bug in Loom" and which alerts accordingly.
   *
   * `JSON.stringify` on a circular or BigInt-bearing payload throws too, which is why
   * the body construction is inside the try rather than above it.
   *
   * CANCEL IS THE ONE EXCEPTION, and it is the taxonomy's own: the table gives cancel its
   * own column precisely because it is not one of the codes a method raises. An operator
   * aborting a dispatch is not a channel that failed, and journaling it as one blames the
   * network for a person's action. It is also the one failure that must not be retried,
   * and `E_CANCELLED` is not retryable while `E_GATE_DELIVERY_FAILED` is. The gate stays
   * open either way, which is the property the single-code rule exists to protect.
   *
   * NOTHING RUNS ABOVE THE TRY, and that is now literally true. `AbortSignal.timeout(-1)`
   * throws a `RangeError`, and reading `target.gate` runs a getter the caller wrote, so
   * both used to be exits that skipped the mapping entirely. `const timeoutMs =
   * this.#opts.timeoutMs ?? 10_000` was still up there afterwards, three lines under a
   * comment saying nothing was: `#opts` is a config object, and a throwing getter on it
   * was an untyped exit like any other. Every local is DECLARED above with a default and
   * ASSIGNED inside; the catch copes with any of them still holding its default.
   *
   * `callbackFor` is called INSIDE the try for the same reason: it interpolates
   * `target.gate.runId`, which is a getter the caller wrote, and a subclass's override is
   * code this class did not write. A gate that cannot be given an answer address is a
   * delivery failure like any other, not an untyped exit.
   */
  async deliver(target: DeliveryTarget, signal: AbortSignal): Promise<string> {
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    let gateId = UNKNOWN_GATE;
    let timeout: AbortSignal | undefined;
    try {
      gateId = safeGateId(target.gate.gateId);
      // BOUNDED, NOT DEFAULTED, and the `??` that stood here was A12's shape exactly: the
      // number goes to `AbortSignal.timeout`, which keeps its delay in a 32-bit signed
      // integer and TRUNCATES rather than saturating or throwing. `timeoutMs: 2 ** 31` is a
      // legal-looking "plenty of headroom" value and it is ONE MILLISECOND — measured, with
      // a `TimeoutOverflowWarning` naming no call site — so every delivery failed instantly
      // under the message `did not answer within 2147483648ms`. A message that is its own
      // counterexample, and the outcome this file exists to prevent: nobody is told.
      //
      // Refused HERE and not in the constructor, which is the one thing this differs from
      // `#label` and `callbackBase` in: *NOTHING RUNS ABOVE THE TRY* pins that a config
      // value that cannot be READ is a delivery failure rather than an unstartable process,
      // and one that cannot be USED belongs on the same path. `cli.ts`'s `positive` already
      // refuses these at boot for a channel out of a channels file; this is the same refusal
      // for the embedder constructing the class directly.
      timeoutMs = this.#timeout(gateId);
      timeout = AbortSignal.timeout(timeoutMs);
      const callback = this.callbackFor(target.gate.runId);
      const res = await (this.#opts.fetch ?? globalThis.fetch)(this.#opts.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.#opts.headers },
        body: JSON.stringify({
          gateId,
          runId: target.gate.runId,
          nodeId: target.gate.nodeId,
          tier: target.tier,
          recipients: target.recipients,
          deadline: target.gate.deadline,
          payload: target.payload,
          // ABSENT rather than null when there is nowhere to answer. A receiver can then
          // tell "this deployment published no address" from "this deployment published a
          // broken one", and the nine waves' worth of receivers that were told the address
          // out of band keep seeing exactly the body they were written against.
          ...(callback === undefined ? {} : { callback }),
        }),
        signal: AbortSignal.any([signal, timeout]),
      });
      if (!res.ok) {
        throw this.#undelivered(gateId, "status", `${this.name} returned ${res.status} for gate ${gateId}`, {
          status: res.status,
        });
      }
      // Prefer the service's own id — a receipt you cannot look up is a receipt in name only.
      const text = await res.text().catch(() => "");
      return text.trim() === "" ? `${this.name}:${gateId}:${target.tier}` : text.trim().slice(0, MAX_RECEIPT);
    } catch (e) {
      throw this.#failure(e, gateId, signal, timeout, timeoutMs);
    }
  }

  /**
   * WHERE THE RECEIVER SHOULD ANSWER — `undefined` here, because nobody can answer this.
   *
   * The outbound payload used to say who is being asked and what about, and never where to
   * reply, so every receiver had to be handed the address and the shared secret out of
   * band. That is tolerable for an approvals service you also wrote and hostile for
   * anything else: the round trip becomes undocumentable, and two deployments of the same
   * service need two different configurations of it.
   *
   * IT IS `undefined` ON THIS CLASS AND THAT IS THE DESIGN, not an omission. A plain
   * `WebhookChannel` has no `parseCallback`, so `GateCallbackRouter` refuses every POST at
   * its own door with `unknown_channel` — publishing an address here would advertise an
   * endpoint that answers 404, which is worse than publishing none. `parseCallback !==
   * undefined` is this file's one test for "answerable"; the address that only exists for
   * answerable channels lives on the class that has it, so the two cannot disagree.
   *
   * THE CORE CANNOT COMPUTE THIS. A control plane behind a proxy, a tunnel or a load
   * balancer does not know its own public origin — `req.headers.host` is the caller's
   * claim, not a fact — so the base is deployment configuration and its ABSENCE is a
   * working configuration, not an error. See `SignedWebhookChannel`'s override for what
   * goes in it and, deliberately, what does not.
   */
  protected callbackFor(
    _runId: unknown,
  ): { readonly url: string; readonly channel: string; readonly signature: Readonly<Record<string, unknown>> } | undefined {
    return undefined;
  }

  /**
   * The catch path, written as a TOTAL function — which is the only kind worth having here.
   *
   * A handler that can itself throw does not narrow the contract, it relocates the breach:
   * the whole point of mapping delivery failures is that `deliver` has one exit, and a
   * `TypeError` raised while FORMATTING the failure is exactly the untyped exit the mapping
   * was built to remove. Everything below reads from a value a channel chose — its `name`,
   * its `message`, its `cause` — and every one of those reads can be a getter that throws
   * or a proxy trap. So the reads live in a try, and the last resort is assembled from
   * fields this object owns, reading nothing from the thrown value at all.
   *
   * THE LAST RESORT BUILDS NO STRING. It used to interpolate `gateId`, which comes from
   * `target.gate.gateId` — a value the caller wrote, so a `gateId` whose `toString` throws
   * failed the PRIMARY arm's template and then failed the last resort's identically. A last
   * resort that can fail the same way as the primary is not one. `gateId` is now proved to
   * be a string on the way in (`safeGateId`), and the message here is one this object built
   * at construction out of a checked `name` — so this arm interpolates nothing at all.
   */
  #failure(
    e: unknown,
    gateId: GateId,
    signal: AbortSignal,
    timeout: AbortSignal | undefined,
    timeoutMs: number,
  ): LoomError {
    try {
      // Our own verdict first: a response that arrived and said 503 is a delivery failure
      // even if the caller lost interest a millisecond later.
      if (isLoomError(e) && e.code === CODES.E_GATE_DELIVERY_FAILED) return e;
      if (signal.aborted) {
        return err.cancelled(`${this.name} delivery of gate ${gateId} was cancelled`, { cause: e });
      }
      return timeout?.aborted === true
        ? this.#undelivered(gateId, "timeout", `${this.name} did not answer within ${timeoutMs}ms for gate ${gateId}`, { cause: e })
        : this.#undelivered(gateId, "transport", `${this.name} could not be reached for gate ${gateId}`, { cause: e });
    } catch {
      // Reached only by a value engineered to break the description — a proxy whose traps
      // throw, an `AbortSignal` that is not one. The cause is dropped rather than retried:
      // it is the thing that just failed to be read.
      return undelivered(this.#label, gateId, "transport", this.#lastResort, { secrets: this.#secrets });
    }
  }

  /**
   * The configured timeout, or a delivery failure that names the knob.
   *
   * `0` stays legal — "abort on the next tick" is a coherent posture and a bound is not a
   * place to smuggle a policy in — and so does every value between it and the largest delay
   * a timer can hold. What is refused is every value that would be silently REINTERPRETED:
   * `NaN`, `Infinity`, a negative, a fraction, a string, and anything above 2³¹−1.
   */
  #timeout(gateId: GateId): number {
    const v: unknown = this.#opts.timeoutMs;
    if (v === undefined) return DEFAULT_TIMEOUT_MS;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_TIMER_MS) {
      throw this.#undelivered(
        gateId,
        "config",
        `${this.#label} has a timeoutMs that is not a whole number of milliseconds a timer can hold (0…${MAX_TIMER_MS})`,
      );
    }
    return v;
  }

  /** `undelivered`, with this channel's name and its URL's mask filled in. */
  #undelivered(
    gateId: GateId,
    reason: "timeout" | "transport" | "status" | "config",
    message: string,
    extra: { readonly status?: number; readonly cause?: unknown } = {},
  ): LoomError {
    return undelivered(this.name, gateId, reason, message, { ...extra, secrets: this.#secrets });
  }
}

/** The gate an error is about when reading `target.gate` is what threw. */
const UNKNOWN_GATE = "(unknown)" as GateId;

/** How long a webhook may take before the gate is treated as undelivered. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The largest delay `setTimeout` and `AbortSignal.timeout` hold, and the ceiling on every
 * duration this file accepts.
 *
 * Above it the platform TRUNCATES into a 32-bit signed integer — it does not saturate and
 * it does not throw — so `2 ** 31` is one millisecond, with a `TimeoutOverflowWarning`
 * naming no call site. `cli.ts` carries the same constant for the same reason; it is
 * duplicated rather than shared because exporting it would put a platform fact on the
 * pinned public surface.
 */
const MAX_TIMER_MS = 2_147_483_647;

/** Long enough for any real channel name, short enough that no name becomes a message. */
const MAX_CHANNEL_NAME = 64;

/** Long enough for any vendor's message id, short enough that no receipt is a payload. */
const MAX_RECEIPT = 200;

/**
 * A gate id that is SAFE TO INTERPOLATE AND SAFE TO JOURNAL, or the literal for one.
 *
 * `GateSummary.gateId` is typed as a branded string and is one for every gate the broker
 * raises. It still arrives through an object the caller assembled, so it can be a getter
 * returning something that is not a string — and a non-string here does not throw where it
 * is read, it throws in the first template that quotes it, which is inside the error
 * handler. Proving it once, on the way in, is what lets every arm below build a message.
 *
 * Bounded for the same reason `boundedId` bounds the inbound one: this string reaches a
 * journal payload, and an id nobody meant to be a kilobyte should not become one.
 *
 * THE INBOUND PATH USES IT TOO, for a stronger reason than interpolation. `parsed.gateId`
 * comes from `parseCallback` — injected code — and lands in `gate.callback_rejected`,
 * where every other field is bounded by construction (`channel` is a configured key,
 * `reason` is a closed set). Unbounded it was a kilobyte in an audit row; NOT A STRING it
 * was worse, because `canonicalize` refuses a function or a symbol and the refusal to
 * canonicalize happened inside `#refuse` — so the row was lost, the counter never ran, and
 * `handle` exited untyped. `UNKNOWN_GATE` says "a gate was named and it was unusable",
 * which is a different fact from the field being absent ("nothing was parsed yet").
 *
 * AND A PLAUSIBLE STRING IS NOT ENOUGH, which is the third shape of "the object you were
 * handed is not the object you assumed". `RunProjection.gates` is a plain object, so a
 * bare `gates["__proto__"]` answers with `Object.prototype`: a gate that was never raised
 * reads as one that EXISTS and is not open, which was a 409 telling a caller it lost a race
 * that never happened, plus a durable row asserting `already_resolved` about a lifecycle no
 * gate ever had. Every name a plain object answers to without anybody having put it there
 * is refused here — an inherited key is not an id, it is an accessor into a prototype — so
 * the lookup misses and `not_found` is both the honest answer and the one the row records.
 *
 * THE LOOKUP ITSELF IS CLOSED TOO, and this docstring said otherwise for a wave. `resolve`
 * does not index bare; it calls `gateOf`, which goes through `projection.ts`'s `gateIn`
 * (`name !== "__proto__"` plus `Object.prototype.hasOwnProperty`). An authenticated
 * `POST /runs/:id/gates/__proto__` answers **404 `E_GATE_NOT_FOUND`**, and so do
 * `toString`, `constructor` and `valueOf`. This guard is therefore defence in depth rather
 * than the only door — which is the arrangement this codebase has twice been burned for NOT
 * having, so keep both.
 */
function safeGateId(v: unknown): GateId {
  if (typeof v !== "string" || v === "" || INHERITED_KEYS.has(v)) return UNKNOWN_GATE;
  return v.slice(0, MAX_ID) as GateId;
}

/**
 * The names `{}` already answers to: `__proto__`, `constructor`, `toString`, and the rest.
 *
 * Read off the prototype rather than listed, so it cannot drift from what the runtime
 * actually inherits. Nothing legitimate is lost by refusing them: `newGateId` mints
 * `gate_<ulid>`.
 */
const INHERITED_KEYS: ReadonlySet<string> = new Set(Object.getOwnPropertyNames(Object.prototype));

/**
 * The receipt a channel resolved, or `undefined` if it did not resolve one.
 *
 * A RECEIPT IS A STRING BY CONTRACT AND A VALUE FROM OUTSIDE IN FACT — the same gap the
 * error side spent three waves closing, one branch over. Two things went wrong with
 * trusting the type:
 *
 *   - the value goes into `gate.delivered`, and `canonicalize` refuses a symbol, a bigint,
 *     a function and a cycle. That throw landed in `log.append`, AFTER every channel had
 *     reported, and rejected the whole dispatch — so one channel resolving nonsense erased
 *     every other channel's row, success and failure alike. Exactly the failure the error
 *     side had just been totalized against.
 *   - `undefined` counted as a DELIVERY, because the dispatcher's split was `"receipt" in
 *     r` and the key is present with an undefined value. So a channel that resolved
 *     nothing was journaled as having delivered, and the fallback — the safety net for
 *     "nobody was told" — was suppressed at the moment it was most needed.
 *
 * SO A CHANNEL THAT DOES NOT RESOLVE A USABLE STRING HAS FAILED, not delivered. That is
 * `DeliveryChannel.deliver`'s own rule read in the only direction it can be enforced from
 * here: "a channel that swallows its own errors and returns a receipt anyway is worse than
 * no channel", because it turns a silent non-delivery into a recorded delivery and the SLA
 * sweep then blames the human. We cannot detect a channel that lies with a plausible
 * string; we can refuse to record a delivery on the strength of a value that is not one.
 *
 * Blank counts as absent: a receipt is "an id the channel can be asked about later", and
 * `WebhookChannel` already refuses to hand back an empty one — it substitutes its own.
 * The rule belongs at the dispatcher, which is where every channel passes.
 */
function usableReceipt(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const bounded = v.slice(0, MAX_RECEIPT);
  return bounded.trim() === "" ? undefined : bounded;
}

/**
 * What a configured webhook URL must never leak, in every form a message may quote it in.
 *
 * THE NORMALIZED HREF IS THE IMPORTANT ONE, and it was the one missing. Nothing quotes the
 * string an operator typed: `fetch` builds a `Request`, the `Request` constructor parses
 * and re-serializes the URL, and every message downstream — undici's credentials refusal,
 * a TLS error, a vendor SDK's log line — names `new URL(url).href`. So a configuration that
 * differs from its own href leaked: an explicit `:443` (dropped), an upper-case host
 * (lower-cased), a dot segment (resolved), a space (percent-encoded). For each of those the
 * raw literal never matched, the ORIGIN still did — an origin is a prefix of its own href —
 * and what was left in `details.cause` was the path. The path is the half that is the
 * credential: a Slack incoming webhook is a bearer token in path form.
 *
 * So: the raw string, the href, the href without its query, the origin, the path on its
 * own (for a client that logs a request line and puts the host in a header), and the
 * userinfo. `maskLiterals` masks longest-first, so the longer forms always win over the
 * prefixes they contain and no half of a credential is ever left behind.
 *
 * THE USERINFO IS BOTH HALVES, and for a wave it was neither. Both entries were gated on
 * `if (u.password !== "")`, so `https://<token>@host/path` — userinfo with no colon in it,
 * which is how a bearer token rides in a URL and the form `callbackBaseUrl` refuses by name
 * — put NOTHING in this list. The href carries the userinfo, so a message quoting the whole
 * URL was masked and the hole looked closed; a message naming the credential on its own —
 * a proxy's 407, an auth layer's log line — was not, which is the "one form masked, its
 * neighbours not" shape one field over from the normalized-href fix above. Username,
 * password and the `user:pass` pair are each pushed when they are non-empty, because WHICH
 * HALF IS THE SECRET IS NOT OURS TO DECIDE: `https://<key>@host` carries it in the username
 * with no password at all, and `https://<user>:<key>@host` carries it in the password. Both
 * are ordinary ways an API key is written into a URL.
 *
 * THE CLAIM IS BOUNDED BY `maskLiterals`, which ignores any literal under six characters so
 * that masking cannot shred the message around it. Measured: with `svc` in the list, `407
 * for user svc at host` comes back unchanged. So `https://svc:pw@host` masks neither half,
 * and what this list covers is credentials rather than every string in a userinfo.
 *
 * The bare HOSTNAME is still deliberately absent — see `WebhookChannel.#secrets`.
 *
 * A URL that does not parse still contributes its literal: an unusable config is not a
 * reason to stop masking the string somebody wrote in it.
 */
function urlSecrets(url: string): readonly string[] {
  const out = [url];
  try {
    const u = new URL(url);
    out.push(u.href, u.origin);
    if (u.pathname !== "" && u.pathname !== "/") {
      out.push(`${u.origin}${u.pathname}`, u.pathname);
    }
    if (u.username !== "") out.push(u.username);
    if (u.password !== "") out.push(u.password);
    if (u.username !== "" || u.password !== "") out.push(`${u.username}:${u.password}`);
  } catch {
    // Not a URL. `fetch` will refuse it, and that refusal quotes the string — which is
    // already in `out`.
  }
  return out;
}

/**
 * The single code, with the detail that keeps it from being useless.
 *
 * "Delivery failed" on its own makes an operator guess between DNS, TLS, a timeout and a
 * 500, so the cause rides in `details` — which `LoomError.toJSON` includes and which is
 * redacted before it reaches a span. The native error itself goes in `cause`, which
 * `toJSON` deliberately drops: a stack and a provider payload are for a debugger, not for
 * the journal.
 *
 * `message` stays free of the underlying text FOR THE BUILT-IN CHANNEL, whose failures are
 * already named by `reason`. It is the field `gate.delivery_failed` records, and the
 * event's payload has no room for structure. `channelFailure` is the one caller that does
 * fold a description in, because for an arbitrary injected channel `reason: "transport"`
 * says nothing at all — and it folds in `describeCause`, which is bounded and total,
 * rather than a vendor string of unknown length.
 *
 * That bound covers the values a channel THROWS. The `LoomError` a channel BUILDS never
 * reaches here at all — it goes through `ownError`, which bounds the same string on the
 * same reasoning; and `journalMessage` bounds whatever arrives at the row regardless.
 */
function undelivered(
  channel: string,
  gateId: GateId,
  reason: "timeout" | "transport" | "status" | "receipt" | "config",
  message: string,
  extra: { readonly status?: number; readonly cause?: unknown; readonly secrets?: readonly string[] } = {},
): LoomError {
  return err.unavailable(CODES.E_GATE_DELIVERY_FAILED, message, {
    details: {
      channel,
      gateId,
      reason,
      ...(extra.status === undefined ? {} : { status: extra.status }),
      ...(extra.cause === undefined ? {} : { cause: describeCause(extra.cause, extra.secrets) }),
    },
    // The native error, for a debugger. `toJSON` and `errorRecord` both drop it, so it is
    // the one copy of the underlying failure that never reaches a journal row or a span —
    // and therefore the one that is not masked. Printing an error object with its cause
    // chain will still show the configured URL, on a host that already holds that URL in
    // its own config.
    ...(extra.cause === undefined ? {} : { cause: extra.cause }),
  });
}

/**
 * The cause chain as one bounded line, because `fetch` hides the answer one level down.
 *
 * Undici reports every transport failure as `TypeError: fetch failed` and puts the fact
 * an operator needs — `ENOTFOUND`, `ECONNREFUSED`, a certificate error — in `cause`. Four
 * levels and 300 characters is enough for every real chain and short enough that a
 * hostile endpoint cannot make this the biggest thing in an error.
 *
 * TOTAL, and that is not decoration. This runs inside a catch block, so a throw from here
 * IS the untyped exit that the one-code contract exists to remove — and every read below
 * is on a value a channel chose. `String(x)` throws outright on a value with no primitive
 * conversion (`Object.create(null)`, `{toString: null, valueOf: null}`), a getter is a
 * call that can throw, and a proxy can trap all of them. Each read goes through `readProp`
 * and the one remaining conversion has its own try, so a level degrades to `[unprintable
 * …]` in isolation: a useless string in an error is strictly better than an error nobody
 * can catch by code.
 *
 * PER READ, not per level, which is the difference `readProp` makes here. A `name` getter
 * that threw used to abandon the whole level INCLUDING its `cause`, so one hostile
 * property truncated a chain that was otherwise perfectly readable.
 */
function describeCause(e: unknown, secrets: readonly string[] = []): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur !== undefined && cur !== null; depth++) {
    const name = readProp(cur, "name");
    const message = readProp(cur, "message");
    let part: string;
    if (typeof name === "string" && typeof message === "string") {
      part = `${name}: ${message}`;
    } else {
      try {
        part = String(cur);
      } catch {
        part = `[unprintable ${safeTag(cur)}]`;
      }
    }
    // MASK BEFORE BOUNDING. Truncating first can cut a credential in half and leave the
    // first half in the output — a leak that also looks like a formatting bug. The string
    // is already in memory by this point, so the only cost is one more copy of it.
    //
    // Each level is still bounded before the join, not after: a channel that throws a
    // megabyte of string should not make us build a megabyte of string to discard it.
    parts.push(maskLiterals(part, secrets, "[redacted:url]").slice(0, 300));
    cur = readProp(cur, "cause");
  }
  return parts.join(" <- ").slice(0, 300);
}

/** `[object Foo]`, or nothing — the only description of a value that cannot throw. */
function safeTag(v: unknown): string {
  try {
    return Object.prototype.toString.call(v);
  } catch {
    // A proxy may trap `Symbol.toStringTag`. There is nothing left to ask it.
    return "value";
  }
}

export interface SignedWebhookChannelOptions extends WebhookChannelOptions {
  /**
   * The shared secret, and the whole perimeter.
   *
   * Required, not optional: a signed channel with signing turned off is a channel that
   * looks authenticated in a config file and is not.
   */
  readonly callbackSecret: string;
  /**
   * This deployment's PUBLIC base URL, so a delivered gate says where to answer.
   *
   * `https://loom.example.com` or `https://ops.example.com/loom` — origin and optional
   * path prefix, nothing more. `deliver` appends `/runs/{runId}/callbacks/{channel}` to
   * it, which is `ControlPlane`'s route, and puts the result in the outbound body.
   *
   * ABSENT IS A WORKING CONFIGURATION and is silent here: `@loom/core` cannot know its own
   * public origin behind a proxy or a tunnel, and an internal approvals service that was
   * told the address out of band is exactly the deployment this shipped as for nine waves.
   * What the absence costs is that the round trip is undocumentable from the payload
   * alone, which is why `loom serve` — the one layer that knows both that a callback route
   * is open and that no address was published — warns about the combination at boot. A
   * refusal would be wrong at this layer: the library cannot tell a deployment that
   * publishes its address out of band from one that forgot.
   *
   * EMPTY IS REFUSED, like every other empty perimeter value in this codebase: `""` and a
   * URL that will not parse both mean "the variable was unset", and a base that silently
   * became `undefined` would publish no address while the config file says it does.
   *
   * USERINFO IS REFUSED TOO, and that is the one rule worth stating separately. The
   * outbound `url` is a credential we HOLD — a Slack incoming webhook is a bearer token in
   * path form — which is why `urlSecrets` masks it out of every error this channel
   * produces. This URL is the opposite: an address we deliberately DISCLOSE, in the clear,
   * to whoever we just posted a gate to. So it is masked nowhere, and the way to keep "the
   * callback URL is not a credential" true rather than hoped is to refuse a configuration
   * that puts one in it.
   */
  readonly callbackBaseUrl?: string;
  /** How far a callback's timestamp may sit from now, either way. Default 5 minutes. */
  readonly toleranceMs?: number;
  readonly timestampHeader?: string;
  readonly signatureHeader?: string;
  /** Which `Actor.via` a decision from this channel records. Default: the channel name if it is one. */
  readonly via?: HumanActor["via"];
  /** Read the approver's id out of a vendor's payload shape. */
  readonly subjectOf?: (body: Readonly<Record<string, unknown>>) => string | undefined;
  /** Read the decision out of a vendor's payload shape. */
  readonly decisionOf?: (body: Readonly<Record<string, unknown>>) => GateDecision | undefined;
}

/**
 * `Actor.via` as a runtime check that CANNOT drift from the type — `ERROR_CLASSES`'s twin.
 *
 * A `Record<HumanActor["via"], true>` is exhaustive by compilation: add a member to the
 * union in `journal/events.ts` and this literal stops type-checking until it is added here.
 * The `Set<string>` that stood here would instead have gone on silently REFUSING the new
 * member, which for `ownedActor` means a legitimate channel's route recorded as `api`.
 * `cli.ts` keeps the same map for the same reason, one door along.
 */
const VIA: Readonly<Record<HumanActor["via"], true>> = {
  console: true,
  slack: true,
  feishu: true,
  teams: true,
  email: true,
  api: true,
  cli: true,
};

/** `hasOwn` and not `in`: `"constructor" in VIA` is true, and `constructor` is not a route. */
function isVia(v: unknown): v is HumanActor["via"] {
  return typeof v === "string" && Object.hasOwn(VIA, v);
}

/** Long enough for a real id, short enough that no field becomes a journal payload. */
const MAX_ID = 128;
const MAX_REASON = 2000;

/**
 * A webhook that can be ANSWERED, not merely notified.
 *
 * The signing scheme is Slack's, deliberately: HMAC-SHA256 over `v0:{timestamp}:{body}`,
 * hex, in a header. The shape matters more than the vendor — binding the timestamp INTO
 * the signed material is what makes the replay window enforceable. A timestamp that is
 * checked but not signed is a timestamp the attacker edits, and then a captured approval
 * is replayable forever.
 *
 * It is a separate class from `WebhookChannel` rather than a flag on it so that
 * `parseCallback !== undefined` keeps meaning "answerable". A `WebhookChannel` that grew
 * an inbound method which throws unless a secret happens to be configured would answer
 * that question with "maybe".
 *
 * It is also the only channel that PUBLISHES ITS ADDRESS — the outbound payload carries
 * where to answer and how to sign, when a deployment has told it its public base URL. Same
 * rule, read the other way: only a channel that can be answered may say where. See
 * `callbackBaseUrl` and `callbackFor`.
 */
export class SignedWebhookChannel extends WebhookChannel {
  readonly #secret: string;
  readonly #toleranceMs: number;
  readonly #tsHeader: string;
  readonly #sigHeader: string;
  readonly #via: HumanActor["via"];
  readonly #subjectOf: SignedWebhookChannelOptions["subjectOf"];
  readonly #decisionOf: SignedWebhookChannelOptions["decisionOf"];
  /** The validated base, with any trailing slash removed, or nothing. See the option. */
  readonly #callbackBase: string | undefined;

  constructor(opts: SignedWebhookChannelOptions) {
    super(opts);
    // NOT A STRING IS THE SAME REFUSAL AS EMPTY, and the check was `=== ""` alone — the hole
    // `http.ts`'s bearer token was found in (REGISTER E8), one perimeter over: `null`, `0` and
    // `[]` are none of them `""`. `createHmac` refuses them at SIGNING time instead, inside
    // `parseCallback`, where the router turns the throw into `internal`, counts it and
    // journals nothing — so a deployment publishes an answer address and refuses every
    // answer, discovered at 3am rather than at boot.
    if (typeof opts.callbackSecret !== "string" || opts.callbackSecret === "") {
      throw err.validation(CODES.E_CONFIG_INVALID, `channel "${this.name}" has an empty or unusable callback secret`);
    }
    this.#secret = opts.callbackSecret;
    // THE REPLAY WINDOW IS A COMPARISON, AND `NaN` LOSES EVERY COMPARISON. This is A12's
    // third correction in its own words — ask what the number is compared against, not which
    // platform API consumes it — and the answer here is `Math.abs(now - ts * 1000) >
    // this.#toleranceMs`, the second half of this file's perimeter. Measured: with
    // `toleranceMs: NaN` a correctly-signed 2017 timestamp was ACCEPTED as current, so a
    // captured approval was replayable forever and nothing anywhere said so. `Infinity` is
    // the same, a negative refuses everything, and a fraction and a numeric string are the
    // unit slips `cli.ts` already refuses for a channel read out of a channels file.
    this.#toleranceMs = boundedDuration(opts.toleranceMs, "toleranceMs", this.name) ?? 300_000;
    this.#tsHeader = (opts.timestampHeader ?? "x-loom-timestamp").toLowerCase();
    this.#sigHeader = (opts.signatureHeader ?? "x-loom-signature").toLowerCase();
    // THE CONFIGURED `via` GOES THROUGH THE SAME CHECK AS EVERY OTHER PRODUCER, and it was
    // the one that did not: `opts.via ?? …` took a config value verbatim, while the
    // channel-name path below it and `ownedActor`'s inbound path are both gated on `VIA`.
    // The field is journaled vocabulary, so an unchecked one is a `gate.decided` row naming
    // a route that does not exist.
    //
    // DROPPED, NOT REFUSED — `cli.ts`'s rule for the same field read from a config file:
    // dropping is safe exactly when the value it falls back to is TRUE, and every decision
    // this class produces arrived over the callback route, so the fallback is a fact about
    // the request rather than a substitute for the operator's intent. (`callbackSecret`,
    // `toleranceMs` and `callbackBaseUrl` refuse instead, because for each of those there
    // is no true value to fall back TO.)
    this.#via = isVia(opts.via) ? opts.via : isVia(this.name) ? this.name : "api";
    this.#subjectOf = opts.subjectOf;
    this.#decisionOf = opts.decisionOf;
    // At CONSTRUCTION, like every other read of a config object in this file: a base URL
    // that is wrong is a process that does not start, not a gate delivered at 3am with an
    // address nobody can post to.
    this.#callbackBase = callbackBase(opts.callbackBaseUrl, this.name);
  }

  /**
   * The answer address, and everything needed to sign for it EXCEPT the secret.
   *
   * WHAT IS IN IT is exactly what a receiver needs and could not otherwise have: the URL,
   * and the signing scheme in enough detail to build a header — the string that is MACed,
   * the two header names (both configurable, so a Slack-shaped receiver and a
   * Loom-shaped one read different ones), the digest encoding, and the replay window, so a
   * receiver that queues approvals knows how stale a signature may be before it is refused
   * rather than discovering it as an intermittent 403.
   *
   * WHAT IS NOT IN IT: `callbackSecret`. Never, under any option. This body is posted to a
   * third party over a network we do not control and lands in whatever that party logs;
   * the secret is the entire perimeter of the return path, and a perimeter that travels
   * with the message it protects is not one. It is also unnecessary — the receiver already
   * holds the secret, because it is the party the secret was shared with. `channel` is
   * echoed beside the URL so a receiver keying several Loom deployments by channel name
   * does not have to parse it back out of a path.
   *
   * The channel segment is percent-encoded and the run segment is not, which mirrors the
   * route rather than guessing at it: `ControlPlane` decodes the channel and reads the run
   * verbatim. A `RunId` is a ULID, so encoding it would be the identity function anyway;
   * doing it would encode a disagreement with the route into a URL nobody reads until it
   * fails to match.
   */
  protected override callbackFor(
    runId: unknown,
  ): { readonly url: string; readonly channel: string; readonly signature: Readonly<Record<string, unknown>> } | undefined {
    const base = this.#callbackBase;
    if (base === undefined) return undefined;
    return {
      url: `${base}/runs/${String(runId)}/callbacks/${encodeURIComponent(this.name)}`,
      channel: this.name,
      signature: {
        scheme: "hmac-sha256",
        // `sign`'s own two facts, said once each: what is MACed, and how it is rendered.
        signedPayload: "v0:{timestamp}:{body}",
        signatureFormat: "v0={hex}",
        timestampHeader: this.#tsHeader,
        signatureHeader: this.#sigHeader,
        timestampUnit: "seconds",
        toleranceMs: this.#toleranceMs,
      },
    };
  }

  /** The header value a sender must produce for these bytes at this timestamp. */
  sign(body: Uint8Array | string, timestamp: string): string {
    return `v0=${this.#mac(body, timestamp)}`;
  }

  #mac(body: Uint8Array | string, timestamp: string): string {
    const mac = createHmac("sha256", this.#secret);
    // Two updates rather than a concatenated string: the body stays BYTES the whole way
    // and is never round-tripped through a decode/encode that could normalize it.
    mac.update(`v0:${timestamp}:`);
    mac.update(typeof body === "string" ? Buffer.from(body, "utf8") : body);
    return mac.digest("hex");
  }

  async parseCallback(req: CallbackRequest): Promise<CallbackDecision> {
    // ── 1. AUTHENTICITY, FIRST AND OVER THE RAW BYTES ───────────────────────
    // Nothing below this point may run for an unsigned request: not JSON.parse, not a
    // gate lookup, not a journal append. Everything after this line treats the body as
    // something the secret holder wrote.
    const timestamp = req.headers[this.#tsHeader];
    const presented = req.headers[this.#sigHeader];
    if (timestamp === undefined || presented === undefined) {
      throw callbackRejection("signature", "callback is unsigned");
    }
    // The one thing checked before the MAC, and it is a check ON the MAC's own input:
    // the signed string is `v0:{ts}:{body}`, so a timestamp containing a colon would
    // make it ambiguous about where the timestamp ends and the body begins. Digits only
    // keeps the encoding injective. It reads nothing from the body and has no effects.
    if (!/^\d{1,15}$/.test(timestamp)) {
      throw callbackRejection("timestamp", "callback timestamp is not a unix time in seconds");
    }
    if (!timingSafeStringEqual(presented, this.sign(req.body, timestamp))) {
      throw callbackRejection("signature", "callback signature does not verify");
    }

    // ── 2. THE REPLAY WINDOW ────────────────────────────────────────────────
    // The timestamp was inside the signed material, so it is the sender's and not the
    // attacker's. Checking it now — after authenticity, because it is a decision about
    // a value we have just proved was signed — is what stops a captured approval being
    // posted again tomorrow, when the thing it approved means something else.
    if (Math.abs(req.now - Number(timestamp) * 1000) > this.#toleranceMs) {
      throw callbackRejection("timestamp", "callback timestamp is outside the replay window");
    }

    // ── 3. ONLY NOW, THE CONTENT ────────────────────────────────────────────
    const body = decodeObject(req.body);
    const runId = boundedId(body["runId"], "runId") as RunId;
    const gateId = boundedId(body["gateId"], "gateId") as GateId;

    // THE TWO VENDOR HOOKS ARE INJECTED CODE TOO, and the last thing on this path that is.
    // They are configuration rather than a channel, which is why they are cheap to forget:
    // a `subjectOf` that answers Slack's `{id}` object instead of the id inside it type-
    // checks at the call site and fails `subject.length > MAX_ID` silently (a non-string
    // has no length), so a decision used to leave here naming an OBJECT as its human. The
    // router's boundary catches that now — but a channel whose stated contract is "return
    // the human the signature vouches for" should not depend on its caller to enforce it.
    const subject = (this.#subjectOf ?? defaultSubject)(body);
    if (typeof subject !== "string" || subject === "" || subject.length > MAX_ID) {
      // A channel that filled this in with "unknown" would leave `resolve` recording a
      // decision nobody can be asked about, which is the whole value of the audit trail.
      throw callbackRejection("malformed", "callback names no approver");
    }

    // Through the same validator the default goes through, for the same reason: a hook is
    // a vendor-shape adapter, not an authority on what a `GateDecision` may be.
    const decision = ownedDecision((this.#decisionOf ?? defaultDecision)(body));
    if (decision === undefined) throw callbackRejection("malformed", "callback carries no usable decision");

    return {
      runId,
      gateId,
      decision,
      actor: { kind: "human", subject, via: this.#via },
      // The signature itself. Identical bytes at an identical timestamp produce an
      // identical key, so a channel retry lands on `resolve`'s existing idempotency
      // check instead of on a second mechanism invented here.
      idempotencyKey: this.#mac(req.body, timestamp),
    };
  }
}

/**
 * A configured public base URL, checked once, or nothing.
 *
 * Four refusals, and each of them is a value that would otherwise publish a wrong address
 * or a right one with a secret in it:
 *
 *   - **empty, or not a string.** The same shape as `--token ""` and `callbackSecret: ""`:
 *     an unset variable expanded into a config file. Falling back to "publish no address"
 *     would leave the file saying one thing and the wire saying another.
 *   - **not a URL, or not http(s).** `deliver` appends path segments to this string; a
 *     value that is not a URL produces something a receiver cannot post to, discovered at
 *     the first gate rather than at boot.
 *   - **userinfo.** See the option's docstring: this URL is disclosed on purpose, so a
 *     credential in it is a credential disclosed on purpose.
 *   - **a query or a fragment.** The run and channel segments are appended to the PATH, so
 *     `https://host/?t=1` would compose `https://host/?t=1/runs/…` — a URL that parses,
 *     never matches the route, and looks fine in a config file.
 *
 * The trailing slash is stripped rather than refused: `https://host/` and `https://host`
 * are the same address to everyone except a string concatenation, and refusing the form
 * every operator types would be pedantry rather than safety.
 */
function callbackBase(raw: string | undefined, channel: string): string | undefined {
  if (raw === undefined) return undefined;
  // ANNOTATED, not inferred. TypeScript only treats a call as never-returning when the
  // callee is a function declaration or a `const` with an EXPLICIT type — without the
  // annotation the `catch` below reads as falling through and `u` is used unassigned.
  const refuse: (why: string) => never = (why) => {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `channel "${channel}" has a callbackBaseUrl that ${why}. It must be this deployment's PUBLIC origin ` +
        `(optionally with a path prefix), e.g. "https://loom.example.com" — omit it entirely to deliver gates ` +
        `with no answer address, which is a working configuration.`,
    );
  };
  if (typeof raw !== "string" || raw === "") {
    refuse(`is empty (\`--callback-base-url "$PUBLIC_URL"\` with the variable unset does this)`);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    refuse(`is not a URL: ${JSON.stringify(raw.slice(0, MAX_CHANNEL_MESSAGE))}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") refuse(`is ${u.protocol} — a callback address is posted over HTTP`);
  if (u.username !== "" || u.password !== "") {
    refuse("carries credentials in its userinfo — this URL is POSTED to the receiver, so anything in it is disclosed");
  }
  if (u.search !== "" || u.hash !== "") refuse("carries a query string or a fragment — the run and channel segments append to its PATH");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/**
 * A configured duration, checked once at construction — or nothing, meaning "not supplied".
 *
 * The same rule as `WebhookChannel.#timeout` and as `cli.ts`'s `positive`: a whole number of
 * milliseconds in `[0, MAX_TIMER_MS]`. It is a CONSTRUCTOR refusal here because nothing on
 * this path has a delivery to fail instead — a channel whose replay window is not a window
 * is a channel that should not have started.
 */
function boundedDuration(v: number | undefined, field: string, channel: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_TIMER_MS) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `channel "${channel}" has a ${field} that is not a whole number of milliseconds in [0, ${MAX_TIMER_MS}]`,
    );
  }
  return v;
}

/** Constant-time compare that survives a length mismatch, which `timingSafeEqual` throws on. */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Compare something of the right length anyway, so a wrong-length signature does
    // not return measurably faster than a wrong-content one.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}

function decodeObject(body: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw callbackRejection("malformed", "callback body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw callbackRejection("malformed", "callback body is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Bounded because a signed field can still reach the journal.
 *
 * `gateId` is journaled on a rejection, so an unbounded one would let whoever holds the
 * secret write a megabyte into an audit row by accident.
 */
function boundedId(v: unknown, field: string): string {
  if (typeof v !== "string" || v === "" || v.length > MAX_ID) {
    throw callbackRejection("malformed", `callback ${field} is missing or not a plausible id`);
  }
  return v;
}

/** Slack sends `user: {id}`; an internal approvals service usually sends a bare string. */
function defaultSubject(body: Readonly<Record<string, unknown>>): string | undefined {
  for (const key of ["actor", "subject", "user", "approver"]) {
    const v = body[key];
    if (typeof v === "string" && v !== "") return v;
    if (typeof v === "object" && v !== null) {
      const id = (v as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") return id;
    }
  }
  return undefined;
}

/**
 * The wire shape of a decision, off a body this channel just parsed.
 *
 * One line, because the validation lives at the boundary (`ownedDecision`) and there is no
 * second copy of it here. The body came out of `JSON.parse`, so it is already a value we
 * own; running it through the same checker as a channel's returned decision costs a walk
 * and buys the guarantee that the two paths cannot answer differently.
 */
function defaultDecision(body: Readonly<Record<string, unknown>>): GateDecision | undefined {
  const raw = body["decision"];
  return typeof raw !== "object" || raw === null ? undefined : ownedDecision(raw);
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export interface DeliveryOutcome {
  readonly delivered: readonly { readonly channel: string; readonly receipt: string }[];
  readonly failed: readonly { readonly channel: string; readonly error: LoomError }[];
  /** True when NOT ONE channel succeeded — the gate stays open regardless. */
  readonly fellBack: boolean;
}

export interface DispatcherOptions {
  readonly channels: readonly DeliveryChannel[];
  /**
   * Where a gate goes when every declared channel fails. Must not itself be able to
   * fail; the built-in `ConsoleChannel` is the intended value.
   *
   * That is a REQUIREMENT ON THE CONFIGURATION, and the dispatcher no longer assumes it
   * was met: one that throws is journaled as a failed channel like any other, because the
   * alternative was a throw that escaped before any row was written and took the record of
   * every other channel's failure with it.
   *
   * A `ConsoleChannel` CONSTRUCTED WITH A `sink` MEETS THE REQUIREMENT ONLY AS WELL AS THE
   * SINK DOES — `deliver` does not catch it, on purpose, because for such a deployment the
   * sink IS the notification. The default construction meets it unconditionally.
   */
  readonly fallback?: DeliveryChannel;
  readonly now?: () => number;
}

/**
 * Delivers a gate over its declared channels, in parallel, and journals what happened.
 *
 * Parallel and not sequential because delivery is a notification: telling Slack should
 * not wait on a webhook that is timing out. Every outcome — success and failure — is
 * journaled, so "why did nobody see this?" is answerable after the fact.
 */
export class GateDispatcher {
  readonly #channels: Map<string, DeliveryChannel>;
  readonly #fallback: DeliveryChannel | undefined;
  /**
   * The fallback's name, read ONCE, here.
   *
   * Same rule as the map above it: a channel's `name` is injected code's property, and a
   * name read twice need not be the same name twice. The map is keyed by the read at
   * construction, so every row that names a channel is keyed by that read too.
   */
  readonly #fallbackName: string;

  /**
   * The ONE read of every channel's name — see `channelName` for why it throws.
   *
   * It reads nothing else off the channels, deliberately: `deliver` and `parseCallback`
   * are read at their call sites, inside the try that maps what they do.
   */
  constructor(opts: DispatcherOptions) {
    this.#channels = new Map(opts.channels.map((c) => [channelName(c), c]));
    this.#fallback = opts.fallback;
    this.#fallbackName = opts.fallback === undefined ? FALLBACK_CHANNEL : channelName(opts.fallback);
  }

  channel(name: string): DeliveryChannel | undefined {
    return this.#channels.get(name);
  }

  async deliver(
    log: RunLog,
    gate: GateSummary,
    spec: DeliverySpec,
    opts: { tier?: number; signal?: AbortSignal } = {},
  ): Promise<DeliveryOutcome> {
    const tier = opts.tier ?? 0;
    const signal = opts.signal ?? new AbortController().signal;
    const names = tierChannels(spec, tier);
    const recipients = tierRecipients(spec, tier);

    // REDACT ONCE, AND HAND OUT NOTHING THAT STILL POINTS AT THE ORIGINAL.
    //
    // `{gate, recipients, payload, tier}` was the whole defect. `redactFields` returns a
    // NEW tree, so `payload` was the redacted rendering — and `gate` was the summary this
    // method was CALLED with, whose own `payload` is the object that rendering was made
    // from. Two fields of one target, one of them the answer to the other, on an interface
    // whose docstring promises "a channel never sees what the classification said to
    // hide". The channel did not even have to look for it: `target.gate.payload` is a
    // plausible thing to write, and it was the unredacted value by reference.
    //
    // So the summary a channel gets is the summary with the REDACTED payload spliced in,
    // and it is spliced rather than deleted because a channel reading `target.gate.payload`
    // should get the question a human is being asked — not `undefined`, which reads as "no
    // payload" and would send an integrator looking for the field that has it.
    //
    // AND THE SPLICE WAS A SHALLOW SPREAD, WHICH IS THE SAME DEFECT AT THE FIELDS THAT
    // DECIDE RATHER THAN THE ONE THAT DISCLOSES. `{...gate}` copies `approvers` and
    // `allowEdit` BY REFERENCE, and those arrays are not the summary's: `engine.ts` builds a
    // gate request with `approvers: node.humanGate?.approval?.approvers ?? []`, the compiled
    // graph node's own array, which every later raise on that node reads again. So a channel
    // — the party this file's boundary note calls untrusted, and the one whose whole job is
    // to be handed this object — held the AUTHORIZATION LIST of every future gate on that
    // node, and `push` was the entire exploit. Reproduced: a channel appending `"mallory"`
    // during tier-0 delivery of run A, and run B's `gate.raised` journaling
    // `approvers: ["sre-lead", "mallory"]`. The gate being delivered is safe (the append
    // canonicalized before delivery started); the next one is not. That is `gates.ts`'s
    // "AUTHORIZATION IS READ FROM THE JOURNAL, NEVER FROM THIS BROKER'S MEMORY" met from the
    // other side — by editing what is about to BE the journal.
    //
    // `recipients` is the same shape one field along: `tierRecipients` returns the delivery
    // spec's own array, so a channel could edit who tier 1 is told. Both go out as copies
    // now — see `shownGate` and `ownedRecipients` — and the property is pinned as an
    // IDENTITY check over the whole target rather than as a list of field names, because a
    // list of field names is what this was.
    //
    // AND IT WENT ON BEING A LIST OF FIELD NAMES, because the test that replaced it built
    // its fixture from one. `GateRecord.batch` arrived after this paragraph was written,
    // `{...gate}` shared it, and the identity walk saw nothing because no `batch` was ever
    // put on the fixture. The fixture is a mapped type over `GateSummary` now, so the next
    // container field is a compile error in the test before it is an aliasing hole here.
    //
    // AND THE DIGEST IS RE-DERIVED, WHEN ANYTHING WAS HIDDEN — which this comment used to
    // argue was unnecessary, in a paragraph that named the attack and then mis-sized it.
    // It said `gate.contentDigest` is "the same bargain `piiToken` already makes — stable
    // enough to correlate, irreversible — but a channel that can guess the WHOLE payload
    // can confirm the guess with it". The channel does not have to guess the whole payload:
    // it was handed the whole payload, with the hidden leaves replaced. So it reassembles
    // the original with one candidate in the hole and hashes. Measured on the redacted tree
    // this method produces: a five-digit id recovered from `contentDigest` in **52 ms**,
    // and that oracle does not care how good the token beside it is.
    //
    // THE FIRST FIX HANDED OVER A TOKEN OF THE DIGEST, and it cost the field the one
    // property it is kept for. `contentDigest` is "the same question you were asked before"
    // — 04-OVERSIGHT.md D7.3 defines it as the sha256 of the payload SHOWN TO THE HUMAN —
    // and a token is process-scoped, so a gate re-delivered after a restart read as a
    // different question. What the field is FOR was traded away to protect it.
    //
    // SO IT IS RE-DERIVED FROM WHAT THE CHANNEL IS SHOWN, with every hidden POSITION
    // rendered as the constant `[secret]` rather than as a token. That is deterministic
    // across processes and across runs, so the restart property comes back, and it is the
    // design's own definition of the field rather than a substitute for it.
    //
    // WHO THE FIELD IS FOR, because this comment answered that with one reader and there
    // are three, and they do not all want the same digest:
    //
    //   1. an AUDITOR settling "the approver was shown the wrong diff" (D7.8). They are
    //      INSIDE the trust boundary and hold the journal, so what they need is a digest
    //      they can RE-DERIVE months later from the real payload plus this spec. That
    //      requirement is what rules out digesting the tokenised tree the channel actually
    //      received: `tokenKey`'s root is `randomBytes(32)` per process and deliberately
    //      unexportable, so a digest over tokens is a number NOBODY can check again once
    //      that process exits — the auditor least of all. A rendering nobody can reproduce
    //      settles no dispute, which is the whole job of the field;
    //   2. an OPERATOR correlating a RE-DELIVERY — tier 0 against tier 2 an hour later, or
    //      the same gate after a restart. Same requirement, same consequence;
    //
    //      AND THIS DOES NOT CHANGE IF THE TOKEN KEY BECOMES DEPLOYMENT-WIDE. A configured
    //      key makes tokens stable across processes, which would make "digest the tokenised
    //      tree" reproducible — by whoever holds that key, for as long as it is not rotated,
    //      and never by the channel. Both arguments still land: an audit artefact whose
    //      verifiability depends on a rotatable secret is uncheckable the day it rotates,
    //      and the key is OPTIONAL, so the construction has to be right with none set. The
    //      digest below touches no key at all: `secret_ref` mints no token.
    //
    //   3. a CHANNEL DEDUPLICATING a retry storm (D7.9 row 3), which wants "same digest ⇔
    //      same question" and is the one reader this deliberately fails. See WHAT THAT
    //      COSTS below; dedup reads the JOURNALED digest, which is inside the boundary.
    //
    // AND IT IS NOT AN ORACLE — but not for the reason that stood here, which was "not an
    // oracle by CONSTRUCTION rather than by strength: the channel can compute it itself
    // from the tree in its hand, so it carries no information the channel did not already
    // hold". THAT IS FALSE, and it is false for exactly the payloads redaction matters most
    // for. It was carried by the single input the pinning test used — a non-null scalar
    // leaf. `redact`'s `secret_ref` arm fires ABOVE the container walk and its `pii` arm
    // below it, so a redacted OBJECT collapses to one constant in the digested tree while
    // the delivered tree keeps its shape and tokenises the leaves; a redacted `null` stays
    // `null` on the wire and reads `[secret]` in the digest, so nothing in the tree even
    // marks the position; and two DIFFERENT redact lists can produce a BYTE-IDENTICAL
    // delivered tree with two different digests, which makes the recomputation not merely
    // hard but UNDEFINED — no function of what the channel holds can answer both. All four
    // are pinned by *THE DIGEST A CHANNEL IS GIVEN IS NOT A DIGEST IT CAN CHECK*.
    //
    // THE PROPERTY THAT DOES HOLD IS ABOUT THE DIGEST'S INPUTS, AND IT HAS A CONDITION.
    // A position the redact list names is the literal `[secret]` in the digested tree —
    // **for a plain JSON value, at a depth `redact` still walks, that the payload does not
    // also carry somewhere the list did not name** — so no hidden value is an input to the
    // digest and there is nothing for a guesser to converge on, which is what the 52 ms
    // brute force did and what "not an oracle" has to mean.
    //
    // THE CONDITION IS NOT DECORATION; the unconditional version of this sentence is the
    // recomputability claim's own failure repeated one step along — a property read off the
    // inputs the pinning sweep used (shallow, plain, scalar-or-container) and then written
    // as if it were universal. `redact`'s walk has two arms ABOVE the `secret_ref` one, and
    // each is a named position that is not the constant. Both are measured by *A HIDDEN
    // POSITION IS NOT ALWAYS THE CONSTANT*:
    //
    //   - a `SecretValue` at a named position renders its `ref` (`isSecret` fires first), so
    //     WHICH secret it is moves the digest: `secret://env/PROD_DB_PASSWORD` and
    //     `secret://env/STAGING_DB_PASSWORD` produce two different delivered digests;
    //   - a named position deeper than `MAX_DEPTH` renders `[depth-limit]`, so "at whatever
    //     depth" is false past 32 — though there the value is still not an input;
    //   - and a value the payload ALSO carries at a position nobody named is digested there,
    //     in the clear, which is the author's own doing and not the redactor's.
    //
    // Neither of the first two is a NEW disclosure — the channel is handed the same
    // rendering by the same arm — but this is a claim about what the digest is a FUNCTION
    // OF, and in the first case a hidden position's value is one of its inputs. Say the
    // condition rather than the conclusion; the conclusion is what got restated in three
    // files. (`redactAs: "secret_ref"` remains the one configuration where the channel can
    // also recompute it, because there the delivered tree IS the digested one.)
    //
    // WHAT THAT COSTS, stated because it is a real loss and not a rounding error: two gates
    // whose payloads differ ONLY inside the redact list now carry the same delivered digest.
    // That is not a shortcut, it is the whole problem — a digest that is stable across
    // processes AND distinguishes a hidden value is a deterministic public function of that
    // value, which is the 52 ms brute force written a third way. A deployment that needs the
    // two told apart must not hide the field that tells them apart. The JOURNALED digest on
    // `gate.raised` is untouched and still covers the real payload, so dedup and audit
    // inside the boundary lose nothing.
    //
    // With no redact list the channel gets the digest of the payload it was handed, which
    // for everything the journal can carry IS the journal's own digest: nothing was hidden,
    // so "shown" and "raised" are the same payload and confirming a guess about it tells the
    // channel what it is already holding. The two part company only where the copy does —
    // see the note on `contentDigest` below — and there the field follows what was SENT.
    //
    // AND WITH NO REDACT LIST IT ALSO GETS A COPY, which is the same sentence read in the
    // OUTBOUND direction and was the hole in it. "`redactFields` returns a NEW tree, so
    // nothing the channel holds points at the original" is the property this prelude rests
    // on — and `redactFields` SHORT-CIRCUITS on an empty list and returns the caller's own
    // tree, which is the DEFAULT: most gates declare nothing to hide. So a channel was
    // handed the broker's live payload object by reference. Reproduced with a channel that
    // writes one field: the broker's `#ephemeral` payload changed, and with it the question
    // `HumanGateBroker.list` reports, the question `GET /runs/:id/gates` serves an operator,
    // and the question the NEXT ESCALATION TIER is delivered — while `gate.raised` and its
    // `contentDigest` still record the real one. That is "the approver was shown the wrong
    // diff" (D7.8) arriving from the channel side, and the digest that exists to settle it
    // is the only thing that would ever disagree.
    //
    // `ownedJson` and not a hand-rolled clone, because it is this file's existing answer to
    // "a value from outside becomes a value we built" and because every delivery's
    // destination is JSON anyway — `WebhookChannel` is about to stringify it. IT FALLS BACK
    // TO THE CALLER'S TREE rather than to `undefined`: a payload JSON cannot represent (a
    // bigint, a cycle) is still a gate somebody must answer, and handing on the original is
    // exactly today's behaviour rather than a new failure. The redacted branch needs none of
    // this — `redact` rebuilds every container on the way down.
    const fields = spec.redact ?? [];
    const payload =
      fields.length === 0
        ? (ownedJson(gate.payload) ?? gate.payload)
        : redactFields(gate.payload, fields, spec.redactAs ?? "pii", gate.runId);
    // THE DIGEST IS OF THE TREE THAT WAS SENT, on both branches, which is the field's own
    // definition (D7.3: it pins WHAT THE APPROVER ACTUALLY SAW) rather than a second one.
    // The no-redact branch used to keep `gate.contentDigest` — the journal's digest, taken
    // by `canonicalize` — while handing over `ownedJson(gate.payload)`, a JSON round trip,
    // and the two do not describe the same bytes: `canonicalize` reads own enumerable keys
    // and IGNORES A PROTOTYPE, while `JSON.stringify` calls an INHERITED `toJSON`. Measured:
    // a payload whose class defines `toJSON` was delivered as `{"command":"kubectl delete ns
    // prod"}` under the digest of `{"command":"kubectl rollout restart deploy/api"}` — the
    // field that exists to settle "the approver was shown the wrong diff" (D7.8) asserting
    // the diff they were not shown.
    //
    // It costs nothing for every payload the journal can carry: a round trip that changes
    // nothing leaves the digest at the journal's own value, which is what the no-redact
    // branch always meant to say. When the sent tree cannot be content-addressed at all the
    // answer is the marker, for `shownDigest`'s reason — a digest of a tree the channel was
    // NOT shown is precisely the claim this field may not make.
    const contentDigest = shownDigest(fields.length === 0 ? payload : gate.payload, fields, gate.runId);
    const target: DeliveryTarget = { gate: shownGate(gate, payload, contentDigest), recipients: ownedRecipients(recipients), payload, tier };
    // ONE READ, before anything can fail. It is used in the failure mapping and in every
    // row below, and a re-read from inside `Promise.all`'s catch would be a throw that
    // rejects the whole dispatch — losing the successful channels' rows with it.
    const gateId = gate.gateId;

    const results = await Promise.all(
      names.map(async (name) => {
        const channel = this.#channels.get(name);
        if (channel === undefined) {
          return {
            channel: name,
            error: err.notFound(CODES.E_GATE_DELIVERY_FAILED, `no delivery channel named "${name}"`),
          };
        }
        try {
          // The receipt is CHECKED, not taken on the type's word — see `usableReceipt`.
          // A channel that resolves something unusable has not told us it delivered, so
          // this arm can still produce a failure.
          const raw: unknown = await channel.deliver(target, signal);
          const receipt = usableReceipt(raw);
          return receipt === undefined
            ? { channel: name, error: noReceipt(name, gateId, raw) }
            : { channel: name, receipt };
        } catch (e) {
          return { channel: name, error: channelFailure(name, gateId, e, signal) };
        }
      }),
    );

    // SPLIT ON THE ERROR, not on the receipt. `"receipt" in r` is TRUE for `{channel,
    // receipt: undefined}` — the key is present, the value is not — so a channel that
    // resolved nothing landed in `delivered`, was journaled as a delivery, and suppressed
    // the fallback. `usableReceipt` above means no such record reaches here any more, and
    // splitting on the discriminator that is either present-and-defined or absent means a
    // future one could not either.
    const delivered = results.filter((r): r is { channel: string; receipt: string } => !("error" in r));
    const failed = results.filter((r): r is { channel: string; error: LoomError } => "error" in r);

    let fellBack = false;
    if (delivered.length === 0 && this.#fallback !== undefined) {
      // EVERY channel failed. The gate does not open, close, or approve — it queues
      // where a human will find it, and the failure is on the record.
      //
      // IN A TRY, even though `DispatcherOptions.fallback` says it must not be able to
      // fail and `ConsoleChannel` cannot. The fallback is injected like any other channel,
      // and a throw from here would escape before a single row was written — losing the
      // record of every channel's failure, which is the one thing the fallback exists so
      // that somebody can read afterwards. A fallback that threw caught nothing, so
      // `fellBack` stays false and its own failure joins the others on the record.
      //
      // AND ITS RECEIPT IS CHECKED LIKE ANY OTHER. `fellBack: true` is the row that says
      // "a human will find this in the console queue"; a fallback that resolved nothing
      // has not earned it, and claiming it would be the same silent non-delivery one level
      // further down, where nothing is left to catch it.
      try {
        const raw: unknown = await this.#fallback.deliver(target, signal);
        const receipt = usableReceipt(raw);
        if (receipt === undefined) {
          failed.push({ channel: this.#fallbackName, error: noReceipt(this.#fallbackName, gateId, raw) });
        } else {
          delivered.push({ channel: this.#fallbackName, receipt });
          fellBack = true;
        }
      } catch (e) {
        failed.push({ channel: this.#fallbackName, error: channelFailure(this.#fallbackName, gateId, e, signal) });
      }
    }

    await log.append([
      ...delivered.map((d) => ({
        type: "gate.delivered" as const,
        payload: { gateId, channel: d.channel, receipt: d.receipt },
        actor: SYSTEM_ACTOR("gate-delivery"),
      })),
      ...failed.map((f) => ({
        type: "gate.delivery_failed" as const,
        payload: {
          gateId,
          channel: f.channel,
          // NOT `f.error.message`. This read used to sit outside any try, on an error a
          // channel may have chosen, so a `LoomError` whose `message` is a throwing getter
          // rejected the dispatch HERE — after every channel had already reported — and
          // erased the `gate.delivered` rows of the ones that worked.
          error: journalMessage(f.error),
          tier,
          fellBack,
        },
        actor: SYSTEM_ACTOR("gate-delivery"),
      })),
    ]);

    return { delivered, failed, fellBack };
  }
}

/**
 * Whatever an INJECTED channel threw, mapped onto the documented code — class included.
 *
 * `toLoomError(e)` was here, and its fallback is `E_INTERNAL`: "a bug in Loom", which
 * alerts. So a vendor channel rejecting with a bare string paged an on-call about somebody
 * else's defect. The dispatcher cannot know what went wrong inside a channel; what it does
 * know is that a gate was not delivered, and the taxonomy already has a code for that.
 *
 * THE CLASS TRAVELS WITH THE CODE, which is why this does not simply pass a `fallbackCode`
 * to `toLoomError` — that would produce `E_GATE_DELIVERY_FAILED` in class `internal`.
 * `retryable` is DERIVED from the class, and the engine checks `error.retryable` before it
 * ever consults `retry.onlyIf`, so one code arriving in two classes would make the same
 * declarative retry policy work for a webhook and silently not work for a vendor channel.
 * Every other construction site of this code uses `err.unavailable`; this one now agrees.
 *
 * A channel raising a real `LoomError` keeps its CLASS and its CODE — an operator's cancel
 * stays `E_CANCELLED` and stays non-retryable — but it does not pass through as the object
 * the channel built; see `ownError`.
 */
function channelFailure(channel: string, gateId: GateId, e: unknown, signal: AbortSignal): LoomError {
  try {
    if (isLoomError(e)) return ownError(e, OUTBOUND_FALLBACK);
    // A channel that failed while the dispatch was being cancelled is the operator's doing
    // and not the vendor's — the same precedence `WebhookChannel` applies to its own arms.
    if (signal.aborted) return err.cancelled(`delivery of gate ${gateId} over "${channel}" was cancelled`, { cause: e });
    // `describeCause` rather than the raw value: it is total, it is bounded, and the message
    // is the half of this error that `gate.delivery_failed` records.
    return undelivered(channel, gateId, "transport", `channel "${channel}" did not deliver gate ${gateId}: ${describeCause(e)}`, {
      cause: e,
    });
  } catch {
    // `instanceof` runs a proxy's `getPrototypeOf` trap, so even the FIRST line here can
    // throw on a value a channel chose. The stake is higher than one bad error: this runs
    // inside `Promise.all`, so a throw would reject the whole dispatch and the successful
    // channels' `gate.delivered` rows would never be written — one hostile channel would
    // erase the record of the others' work.
    //
    // SO THIS ARM INTERPOLATES NOTHING. It used to build `channel "${channel}" did not
    // deliver gate ${gateId}` — the same template as the primary arm, over the same two
    // caller-written values — which made the last resort fail exactly where the primary
    // had. Both still ride in `details`, where they are stored and never stringified.
    return undelivered(channel, gateId, "transport", CHANNEL_LAST_RESORT);
  }
}

/**
 * "You said you delivered it and did not say what with", as the one code.
 *
 * `reason: "receipt"` and not `"transport"` because the two send an operator to different
 * places: transport is the vendor being down, and this is the INTEGRATION being wrong —
 * a channel whose `deliver` resolves the wrong shape, which no amount of retrying fixes.
 * It stays `E_GATE_DELIVERY_FAILED` in class `unavailable` like every other arm, because
 * the single-code rule is what keeps a caller from branching on it, and every branch out
 * of "the notification failed" that is not "leave the gate open" is a way to approve
 * something nobody approved.
 *
 * The message says the TYPE and never the value: `typeof` runs no getter and trips no
 * proxy trap, while the value itself is the thing that just proved it cannot be trusted in
 * a template. The try is still there because `channel` and `gateId` are the caller's and
 * the primary arm quotes both — the same shape as `channelFailure`'s last resort, and for
 * the same reason.
 */
function noReceipt(channel: string, gateId: GateId, receipt: unknown): LoomError {
  try {
    const what = typeof receipt === "string" ? "an empty receipt" : `${typeof receipt} for a receipt`;
    return undelivered(channel, gateId, "receipt", `channel "${channel}" reported delivery of gate ${gateId} with ${what}`);
  } catch {
    return undelivered(channel, gateId, "receipt", NO_RECEIPT_LAST_RESORT);
  }
}

/** Said when there is nothing left that can safely be said. Built from no input at all. */
const CHANNEL_LAST_RESORT = "a channel did not deliver the gate";

/** Its receipt-side twin, and interpolating nothing for the same reason. */
const NO_RECEIPT_LAST_RESORT = "a channel reported a delivery without a usable receipt";

/** The name a fallback's row is keyed by when the fallback would not say what it is called. */
const FALLBACK_CHANNEL = "(fallback)";

/** A third party's prose, bounded before it can become the biggest thing in an audit row. */
const MAX_CHANNEL_MESSAGE = 300;

/** Long enough for every code in the taxonomy, short enough not to be a payload. */
const MAX_CODE = 64;

/**
 * Every `ErrorClass`, as a runtime check that CANNOT drift from the type.
 *
 * A `Record<ErrorClass, true>` is exhaustive by compilation: add a class to the union in
 * `errors.ts` and this literal stops type-checking until it is added here too. A
 * hand-maintained array would silently start rejecting the new class instead, and the
 * penalty for a stale entry here is a channel's error losing its class.
 */
const ERROR_CLASSES: Readonly<Record<ErrorClass, true>> = {
  validation: true,
  policy: true,
  not_found: true,
  conflict: true,
  exhausted: true,
  unavailable: true,
  timeout: true,
  cancelled: true,
  internal: true,
};

function isErrorClass(v: unknown): v is ErrorClass {
  return typeof v === "string" && Object.hasOwn(ERROR_CLASSES, v);
}

/**
 * The one string of an error that reaches `gate.delivery_failed`, bounded and total.
 *
 * THE BOUND IS THE PART THAT FIRES. Not every message here comes from a channel: a
 * `DeliverySpec` naming a channel that does not exist produces `no delivery channel named
 * "…"`, and that name is whatever a graph author wrote — so an audit row could carry a
 * kilobyte of it. Bounding at the row is the one place that covers every producer.
 *
 * THE TOTAL READ IS BELT AND BRACES, and honestly so: after `ownError` every error in
 * `failed` is one this module constructed, so no test can reach the unreadable arm. It
 * stays because this is the LAST read before a durable write that several channels'
 * records depend on, and the cost of being wrong here is not a bad message — it is every
 * row in the batch, the successful channels' included. One `readProp` is cheaper than a
 * file that is one careless `return e` away from that again.
 */
function journalMessage(e: LoomError): string {
  const message = readProp(e, "message");
  return typeof message === "string" ? message.slice(0, MAX_CHANNEL_MESSAGE) : `[unprintable ${safeTag(message)}]`;
}

// ---------------------------------------------------------------------------
// The return path
// ---------------------------------------------------------------------------

/**
 * The slice of the engine an inbound callback needs — deliberately three methods.
 *
 * Narrow because this is the one caller reachable without credentials. A router holding
 * the whole `Engine` could submit runs, cancel them, and rewind them; holding this can
 * read a projection and answer a gate, which is the entire job.
 */
export interface CallbackEngine {
  projection(runId: RunId): Promise<RunProjection | undefined>;
  openGates(runId: RunId): Promise<readonly GateSummary[]>;
  resolveGate(runId: RunId, input: ResolveInput): Promise<RunProjection>;
}

export interface CallbackRouterOptions {
  readonly dispatcher: GateDispatcher;
  readonly engine: CallbackEngine;
  /**
   * A journal writer for one run, used only for `gate.callback_rejected`.
   *
   * A second `RunLog` against a run the engine also writes is safe by construction:
   * `append` retries on `E_SEQ_CONFLICT` because a rejection is an unconditional fact,
   * and a gate being open means the run is suspended and nothing is committing.
   */
  readonly logFor: (runId: RunId) => RunLog;
  readonly now?: () => number;
}

export interface CallbackInput {
  /** Channel name, from the request path. Attacker-controlled until it matches one. */
  readonly channel: string;
  /** The run the request was addressed to. Checked against the SIGNED runId. */
  readonly runId: RunId;
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /**
   * The REQUEST's deadline, so a decision cannot land after its caller was told it failed.
   *
   * Optional because an embedder calling `handle` directly has no deadline to offer, and an
   * absent signal means "no deadline" rather than "expired". Adding a member to this interface
   * changes no exported NAME, so `check-surface.mjs` — which pins the name set and nothing else
   * — neither notices nor needs to.
   */
  readonly signal?: AbortSignal;
}

export interface CallbackResult {
  readonly gateId: GateId;
  readonly decision: GateDecision;
  readonly actor: HumanActor;
  readonly projection: RunProjection;
}

/**
 * One dispatch path for inbound callbacks.
 *
 * The ORDER of the checks below is the security property, so it is written as a sequence
 * and not as a set of guards scattered across a handler:
 *
 *   1. the named channel exists and has an inbound path at all;
 *   2. the channel verifies the signature and the replay window over the RAW BYTES —
 *      before any lookup, before any durable write;
 *   3. ADMISSION: the address names a run that exists, is not terminal, and has an open
 *      gate — this decides whether a refusal may be journaled, not whether it is refused;
 *   4. the signed run matches the addressed one;
 *   5. the caller is a human, and an approver if the gate lists any;
 *   6. `HumanGateBroker.resolve` decides everything else — idempotency first, then gate
 *      state — because it already owns those and a second copy would drift.
 *
 * **(2) BEFORE (3) IS THE WHOLE FIX.** The callback URL contains the runId and is handed
 * to a third party, so it is not a secret. With the lookup first, 200 unsigned POSTs at
 * a *finished* run appended 200 `gate.callback_rejected` rows, and the response codes
 * told an unauthenticated prober which runs existed (403 "unsigned" for a real gated run,
 * 404 for a fictional one). Verifying first collapses both: an unsigned request now gets
 * the same 403 whatever it addresses, having touched no state at all.
 *
 * THE TENSION THAT CREATES, stated because it is not obvious: verifying first means that
 * when a request fails, we do not yet know the run exists — and appending to a run that
 * does not exist would conjure a journal for it. So refusals land in two different
 * places, on purpose, and the rule joining them is:
 *
 * > **EVERY REFUSAL IS RECORDED SOMEWHERE — JOURNALED WHEN ADMISSION ALLOWS IT, COUNTED
 * > OTHERWISE. NOTHING IS REFUSED SILENTLY.**
 *
 *   - **Journaled**, into THAT RUN'S journal, when step 3 admits it: a live run with an
 *     open gate, refused after the signature verified. By then the caller has demonstrably
 *     used the channel's secret, so the row is bounded by the set of secret holders and is
 *     the one signal worth keeping durably: a service we trust doing something it may not.
 *
 *     BE PRECISE ABOUT THAT BOUND, because it rests on the channel as well as the secret.
 *     "The signature verified" is the CHANNEL'S report, not something this router observed;
 *     `parseCallback` is injected code. So: an untyped throw out of `parseCallback` — the
 *     shape of a channel bug — is counted and not journaled, because a channel that blew
 *     up reported no verdict at all (see `PERIMETER_REJECTIONS`), and without that an
 *     unauthenticated stranger bought one durable row per POST. What remains trusted is a
 *     channel that returns a TYPED rejection: `malformed` says "I verified, and then the
 *     body was nonsense", and there is nothing left to check that claim against. The bound
 *     is therefore *secret-holders, for any channel that honours `parseCallback`'s stated
 *     contract; channel correctness otherwise* — which is why that contract is stated as a
 *     MUST on the interface rather than left to convention.
 *
 *     AND THEN BOUND IT ANYWAY, because "channel correctness otherwise" is not a bound.
 *     The dangerous shape is not a channel that throws — that one is covered above — but a
 *     channel that RETURNS a decision without having verified anything, which is what a
 *     forgotten MAC check looks like and which the router cannot distinguish from a real
 *     verification. So the number of refusals ONE run may journal is capped per process
 *     (`#admitRow`); past the cap the refusal is counted like any other withheld one. A
 *     legitimate deployment never reaches it, and a broken channel costs 32 rows instead
 *     of one per POST until someone notices.
 *   - **Counted**, in `refusals()`, for everything else — the forged, the unsigned and the
 *     replayed, which prove nothing and may address a fictional run; and the signed
 *     refusals that arrive after the run is over, which admission withholds. The counter is
 *     process-lifetime, bounded by (configured channels + 1) × the closed reason set, and
 *     lossy on restart. Invariant 8 is exactly this shape: telemetry may drop data, the
 *     journal may not, so the lossy sink is the one that gets to be unbounded in traffic.
 *
 * An earlier version of this paragraph pointed at telemetry as the place a perimeter
 * refusal showed up. That was false: spans are DERIVED from the journal (telemetry/spans.ts),
 * so an event that is not journaled produces no span, and a forged-signature campaign left
 * no trace anywhere — 500 forged POSTs moved no row, no span and no counter. `refusals()`
 * is the sink that comment was describing, now that it exists.
 *
 * Every refusal — journaled, counted, or both — leaves the gate OPEN. Nothing here can
 * approve anything; it can only forward a decision that survived all six.
 */
export class GateCallbackRouter {
  readonly #dispatcher: GateDispatcher;
  readonly #engine: CallbackEngine;
  readonly #logFor: (runId: RunId) => RunLog;
  readonly #now: () => number;
  /**
   * Refusals this process withheld from the journal, counted per channel and reason.
   *
   * BOUNDED BY CONSTRUCTION, which is the only reason an unauthenticated route may touch
   * it: `channel` is either a name the dispatcher was configured with or the single
   * `UNNAMED_CHANNEL` literal, and `reason` is `CALLBACK_REJECTIONS`. The map therefore
   * cannot exceed (configured channels + 1) × 9 entries no matter how much traffic
   * arrives — the counts grow, the memory does not.
   *
   * THE FIRST HALF OF THAT USED TO BE A HOPE. The key came from `channel.name`, read fresh
   * off the injected channel on every refusal, while the dispatcher's map had been keyed by
   * a single read at construction — so a `name` that is a non-constant getter made every
   * POST a new entry, which is the memory-exhaustion vector this paragraph claims to be
   * safe from. The key is now `input.channel`, which a successful dispatcher lookup has
   * already proved equal to one of those construction-time keys.
   */
  readonly #withheld = new Map<string, { readonly channel: string; readonly reason: CallbackRejection; count: number }>();
  /**
   * Durable refusal rows this process has written, per run — the amplification cap.
   *
   * The journaled row is justified by "the caller demonstrably used the channel's secret",
   * and that is the CHANNEL'S report. `PERIMETER_REJECTIONS` covers a channel that THROWS
   * before verifying; it cannot cover a channel that RETURNS without verifying, which is
   * the more common integration bug precisely because it looks like success. There is
   * nothing the router can check it against — so the amplification is bounded instead of
   * detected, which is what invariant 8 prescribes: backpressure hits admission, and the
   * lossy sink takes the overflow.
   *
   * Process-lifetime and lossy on restart, exactly like `#withheld` and for the same
   * reason. It is not an audit record; it is the thing that keeps one from being flooded.
   */
  readonly #journaled = new Map<RunId, number>();

  constructor(opts: CallbackRouterOptions) {
    this.#dispatcher = opts.dispatcher;
    this.#engine = opts.engine;
    this.#logFor = opts.logFor;
    this.#now = opts.now ?? Date.now;
  }

  /**
   * What was refused without a durable row, since this process started.
   *
   * NOT AN AUDIT RECORD, and it must never be read as one: it is lossy on restart, it
   * carries no timestamps and no identities, and it is deliberately allowed to be all of
   * those things because it is not the journal. What it answers is the one question the
   * journal cannot: "is someone hammering our approval endpoint?" — a signal that only
   * exists in aggregate, and exactly the class invariant 8 says may be dropped.
   *
   * Monotonic and unresettable. A counter with a reset is a counter an attacker clears.
   */
  refusals(): readonly { readonly channel: string; readonly reason: CallbackRejection; readonly count: number }[] {
    // A COPY, sorted for a stable read. Handing out the live records would let a caller
    // edit the counter through the object it was shown.
    return [...this.#withheld.values()]
      .map((r) => ({ channel: r.channel, reason: r.reason, count: r.count }))
      .sort((a, b) =>
        a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0,
      );
  }

  /**
   * One withheld refusal.
   *
   * The pair is kept in the VALUE rather than parsed back out of the key: a channel name
   * is whatever a deployment wrote in its config, and a key format that has to be split
   * is a key format that eventually splits wrong.
   */
  #count(channel: string, reason: CallbackRejection): void {
    const key = JSON.stringify([channel, reason]);
    const seen = this.#withheld.get(key);
    if (seen === undefined) this.#withheld.set(key, { channel, reason, count: 1 });
    else seen.count += 1;
  }

  /**
   * Whether THIS run may still put a refusal in its own journal. Consumes the budget.
   *
   * A CAP, not a mute: the first refusals are written, so the fact that someone started
   * hammering a live gate is durable, with its reason token, at the address it happened.
   * What the cap removes is the tail — which carries no information the counter does not,
   * and which an unauthenticated caller was otherwise free to make arbitrarily long.
   *
   * The tracker itself is bounded, and EVICTS rather than refuses when it is full. An
   * entry can only be created by a live run with an open gate — an address the engine
   * created, not one a caller chose — so the map is bounded by the deployment's own runs
   * rather than by traffic. Refusing on a full tracker would make it a lever: fill it, and
   * every NEW run's audit rows go quiet. Evicting means the worst a full tracker does is
   * let an old run's budget start again, which errs toward recording too much.
   */
  #admitRow(runId: RunId): boolean {
    const written = this.#journaled.get(runId) ?? 0;
    if (written >= MAX_DURABLE_REFUSALS_PER_RUN) return false;
    if (written === 0 && this.#journaled.size >= MAX_TRACKED_RUNS) {
      // Insertion order: the first key is the run this has been tracking longest.
      const oldest = this.#journaled.keys().next();
      if (oldest.done !== true) this.#journaled.delete(oldest.value);
    }
    this.#journaled.set(runId, written + 1);
    return true;
  }

  async handle(input: CallbackInput): Promise<CallbackResult> {
    // ── 1. IS THERE AN INBOUND PATH BY THAT NAME AT ALL ─────────────────────
    // `input.channel` is the caller's bytes UNTIL this lookup succeeds, and a CONFIGURED
    // NAME the moment it does: the dispatcher's map was keyed by one read of each
    // channel's `name` at construction, so a hit means these bytes equal one of those
    // keys. Everything below therefore uses `input.channel` and never `channel.name` —
    // re-reading `name` off injected code gives a value nothing has bounded, and the
    // counter it keys is reachable by anyone who can POST here.
    const channel = this.#dispatcher.channel(input.channel);
    const name = input.channel;
    // READING THE METHOD IS ITSELF A READ OF INJECTED CODE, and it was the first thing
    // this router touched on the untrusted object with no try around it — so a channel
    // with a throwing `parseCallback` accessor made `handle` exit untyped with the attempt
    // in neither sink. A channel that will not hand over its parser has reported nothing
    // about the caller, which is the `internal` case `PERIMETER_REJECTIONS` describes:
    // counted, and never worth a durable row.
    let parse: DeliveryChannel["parseCallback"];
    try {
      parse = channel?.parseCallback?.bind(channel);
    } catch (e) {
      this.#count(name, "internal");
      throw ownError(e);
    }
    if (channel === undefined || parse === undefined) {
      // The name came off the URL, so it is never echoed and never journaled: there is
      // no gate to attribute the attempt to, and an unauthenticated endpoint that
      // writes a row per unknown name is a way to grow somebody else's journal. It IS
      // counted, under a literal — the name a stranger chose is not a map key.
      this.#count(UNNAMED_CHANNEL, "unknown_channel");
      throw callbackRejection("unknown_channel", "no callback channel by that name");
    }

    // ── 2. AUTHENTICITY, BEFORE ANY LOOKUP ──────────────────────────────────
    // Cheap, stateless, and the actual perimeter. A perimeter failure returns from here
    // having read nothing and written nothing, so it is neither an oracle nor a lever —
    // it increments a counter, which is neither. Anything else is held: the caller used
    // the secret, and what it did with it belongs in the run's journal — once step 3
    // confirms there is a run to put it in.
    //
    // "The caller used the secret" is the CHANNEL saying so, which is why `internal` is a
    // perimeter reason HERE and only here: an untyped throw out of `parseCallback` means
    // the channel reported nothing, and a channel that blew up must not be able to spend
    // an unauthenticated stranger's POST as a durable row.
    //
    // BOTH ARMS CROSS THE BOUNDARY HERE, and nothing below reads what the channel handed
    // back. What it RETURNED becomes an `OwnedCall`, every property read once and checked;
    // what it THREW becomes a `LoomError` this module constructed. The alternative — the
    // arrangement this replaced — was to keep the channel's own object and harden each
    // reader of it in turn, which is how the same untyped exit was found four times, one
    // property further along each time.
    let verified:
      | { readonly ok: true; readonly call: OwnedCall }
      | { readonly ok: false; readonly error: LoomError };
    try {
      // RACED AGAINST THE DEADLINE RATHER THAN AWAITED, so this frame stops holding the
      // request. `await parse(…)` suspends `handle` with `input` — and therefore
      // `input.body` — live in its continuation, and the whole chain above it
      // (`ControlPlane.#serve`, `#withDeadline`) is suspended on this one. A channel whose
      // `parseCallback` never settles kept that chain alive for the lifetime of the
      // process, on a route reachable WITHOUT A CREDENTIAL: one buffered body per hung
      // POST, repeat until the process runs out of memory. Racing lets every frame from
      // here up unwind at the deadline and drop its reference.
      //
      // WHAT THIS DOES NOT DO, because nothing in JavaScript can: cancel the channel's
      // promise. If the channel captured the body itself, the channel still holds it. The
      // half core owns is released; the half injected code owns is injected code's.
      const parsed = await raceDeadline(parse({ body: input.body, headers: input.headers, now: this.#now() }), input.signal);
      verified = { ok: true, call: ownedCall(parsed) };
    } catch (e) {
      // NO DEADLINE CHECK HERE, and its absence is load-bearing rather than an oversight.
      // `raceDeadline` rejects with `callbackRejection("timeout", …)`, whose token
      // `reasonOf` reads straight back — and `timeout` is deliberately NOT in
      // `PERIMETER_REJECTIONS`, so it falls through to `verified = {ok: false}` and is
      // counted once by the check below. A second check here would be a guard no test can
      // fail: written, it survived its own mutation while all 85 tests stayed green.
      //
      // It also changes an answer for the worse in the one corner where it fires. A
      // channel that legitimately reports `signature` at about the moment the deadline
      // passes should be counted as `signature`, not relabelled as our clock — the
      // refusal is more informative, and it is the channel's report either way.
      const error = ownError(e);
      const reason = reasonOf(error);
      if (PERIMETER_REJECTIONS.has(reason)) {
        this.#count(name, reason);
        throw error;
      }
      verified = { ok: false, error };
    }

    // A parse that RESOLVED after the deadline is refused on the same terms: a decision
    // must not be applied minutes after the human who sent it was told the POST failed.
    // The race covers the hang; this covers the settle-just-too-late, and both land on one
    // counter. Reachable when `parse` and the timer resolve in the same tick.
    if (input.signal?.aborted === true) {
      this.#count(name, "timeout");
      throw callbackRejection("timeout", "the request deadline passed before the channel answered");
    }

    // ── 3. ADMISSION, FOR DURABILITY ────────────────────────────────────────
    // Journaling a rejection is a durable write reachable from outside, so it is bounded
    // here: a live run with an open gate is the only address at which one is worth
    // keeping. A DECIDED gate is not an open one — accepting those is what let a finished
    // run be made to grow, since a run's gates never leave its projection.
    //
    // Note what this does NOT gate: reaching `resolve`. A webhook sender retries, and the
    // retry of a decision already recorded must keep answering 200 rather than turning
    // into a 404 that reads as "your approval was lost". Retries and conflicts write
    // nothing, so they need no admission — only the audit row does.
    //
    // IN A TRY, because `CallbackEngine` is an injected interface too — three methods, not
    // the `Engine` class — and this await sat above every one of them. A read model that
    // rejects left `handle` exiting untyped with the attempt in neither sink, on the one
    // route reachable without a credential. `durable` is computed here as well: it reads
    // the projection, so a projection that cannot be read is one no row can be justified
    // against, which is the same answer the `undefined` arm gives.
    let admitted: { readonly durable: boolean } | undefined;
    try {
      const projection = await this.#engine.projection(input.runId);
      admitted =
        projection === undefined
          ? undefined
          : { durable: !isTerminal(projection.status) && openGateRecords(projection).length > 0 };
    } catch (e) {
      throw await this.#refuse(false, input.runId, name, undefined, ownError(e));
    }
    if (admitted === undefined) {
      // Not an oracle any more: only a caller that already produced a valid signature
      // over these bytes can tell this answer apart from the ones below. There is no
      // journal to write to — that is the whole point — so the counter takes it.
      this.#count(name, "not_found");
      throw callbackRejection("not_found", "no open gate at that address");
    }
    const durable = admitted.durable;

    if (!verified.ok) throw await this.#refuse(durable, input.runId, name, undefined, verified.error);
    // EVERY FIELD BELOW IS OURS. `call` came through `ownedCall`, so `gateId` is a bounded
    // string that names no prototype, `actor` is a human this module built or nothing, and
    // `decision` is a shape this module validated — read as many times as is convenient,
    // because none of them can run a channel's code any more. What the checks below do is
    // decide, not defend.
    const call = verified.call;
    const gateId = call.gateId;

    if (call.runId !== input.runId) {
      throw await this.#refuse(
        durable,
        input.runId,
        name,
        gateId,
        callbackRejection("run_mismatch", "the signed callback names a different run"),
      );
    }
    // A channel is injected code outside this module. The types say `HumanActor`; this
    // says so at runtime, because a channel reporting `system` would put "the software
    // approved it" in the journal and the type system is not where that gets caught.
    //
    // THE FIRST LINE, NOT THE ONLY ONE, and the note that used to sit here overstated it.
    // It said deleting this check let a channel forge an approval by naming `replay`, via
    // `isAuthorizedActor`'s `system` allow-list. That chain does not reach: `#engine` is an
    // interface, and the implementation every deployment injects — `Engine.resolveGate` —
    // refuses a non-human actor at its own door and never gets as far as the broker, unless
    // the engine was constructed with a replay store. The transcript that claim came with
    // could not be reproduced; the callback test now pins what the second line really does.
    //
    // WHAT IS TRUE, and why the check stays:
    //
    //   - a REPLAY-ENABLED engine does admit a system actor, and then the old chain is
    //     real: `subject` is an extra property a `system` actor may carry, so the approvers
    //     check below reads it and PASSES, and `isAuthorizedActor`'s `system` arm accepts
    //     `replay`, `executor:subgraph` and `gate-broker:timeout`;
    //   - a gate that names NO approvers skips `isAuthorizedActor` entirely, so the
    //     engine's door is the only other thing between a non-human actor and a decision;
    //   - `CallbackEngine` is three methods, not the `Engine` class. A guarantee this
    //     router makes may not be contingent on which object was injected behind it;
    //   - the refusal is typed, reasoned and journaled HERE, at the boundary that saw it,
    //     rather than arriving as whatever the engine happened to raise.
    //
    // The `subject === ""` half has no second line at all: an empty subject passes every
    // check downstream and writes `gate.decided` for a human nobody can be asked about.
    // `ownedCall` folds all three of those into one answer — `undefined` is "this callback
    // names no human I can record", whether the actor was `system`, was empty, was a
    // kilobyte, or could not be read at all.
    const actor = call.actor;
    if (actor === undefined) {
      throw await this.#refuse(
        durable,
        input.runId,
        name,
        gateId,
        callbackRejection("not_authorized", "a callback must name the human it speaks for"),
      );
    }
    // A DECISION THIS ROUTER CANNOT FORWARD IS NOT A DECISION. Both fields are required by
    // `CallbackDecision` and by `ResolveInput`, so "absent" and "not the shape it claims"
    // are the same integration bug — and forwarding either would put a value with live
    // getters inside `resolve`, past the point where the idempotency key has been claimed.
    // Refused before the approvers read model is consulted: there is nothing to authorize.
    const decision = call.decision;
    const idempotencyKey = call.idempotencyKey;
    if (decision === undefined || idempotencyKey === undefined) {
      throw await this.#refuse(
        durable,
        input.runId,
        name,
        gateId,
        callbackRejection(
          "malformed",
          decision === undefined ? "callback carries no usable decision" : "callback carries no usable idempotency key",
        ),
      );
    }

    // AUTHENTICITY IS NOT AUTHORIZATION. The signature proves the approvals service sent
    // this; the approvers list decides whether that person may answer THIS gate.
    //
    // FAIL CLOSED if the list cannot be read. "Nobody is listed" and "I could not find
    // out who is listed" are different facts, and treating the second as the first would
    // turn an unavailable read model into a way past the approvers check. The `find` and
    // the COPY are inside the try for the same reason the await is: they read an array the
    // engine returned, and a list that cannot be walked is one that was not read.
    let approvers: readonly string[];
    try {
      const open = await this.#engine.openGates(input.runId);
      approvers = [...(open.find((g) => g.gateId === gateId)?.approvers ?? [])];
    } catch (e) {
      throw await this.#refuse(durable, input.runId, name, gateId, ownError(e));
    }
    if (approvers.length > 0 && !approvers.includes(actor.subject)) {
      throw await this.#refuse(
        durable,
        input.runId,
        name,
        gateId,
        callbackRejection("not_authorized", "the caller is not an approver for this gate"),
      );
    }

    try {
      // Unknown gate, already-resolved gate, a retry of a decision already recorded, a
      // forbidden `edit` channel: all of them are `resolve`'s, not ours.
      const after = await this.#engine.resolveGate(input.runId, { gateId, decision, actor, idempotencyKey });
      return { gateId, decision, actor, projection: after };
    } catch (e) {
      throw await this.#refuse(durable, input.runId, name, gateId, ownError(e));
    }
  }

  /**
   * Put the refusal on the record where the record is warranted, then hand the error back.
   *
   * `durable` is step 3's answer and nothing else — the caller never decides it locally,
   * because "may this write?" answered in six places is six places to get it wrong. When
   * it is false the refusal still happens, with the same code and the same message; the
   * row is withheld because there is no live gate for it to be about, and the attempt goes
   * to the counter instead. EXACTLY ONE of the two, never both: a counter that also
   * shadowed the journaled rows would be a partial mirror of the audit trail, and a
   * partial mirror is the thing someone eventually reconciles against.
   *
   * When the row IS written the append is NOT swallowed. If the journal is unavailable
   * the caller gets that failure instead of a tidy 403 — the gate is still open either
   * way, and a security event silently not recorded is worse than a confusing status code.
   * Two things are true about that failure and neither used to be: the refusal goes to the
   * COUNTER, because a journal outage may not be the reason an attack left no trace
   * anywhere; and it exits TYPED, because `logFor` is injected like everything else here
   * and the next thing to see it is `toLoomError` in the HTTP layer, whose `String(e)` is
   * the same partial read this boundary exists to stop handing people.
   *
   * Coalescing repeated rejections into one row carrying a count was considered and
   * rejected: a window that flushes only when the NEXT attempt arrives loses the tail
   * exactly when an attacker stops, and invariant 8 does not let the journal drop a fact
   * it has admitted. Admission is the bound instead — the secret, a live run, an open
   * gate, and a per-run cap — which is where invariant 8 says the backpressure belongs.
   *
   * THE CAP IS THE FOURTH ADMISSION TERM and the newest. The first three bound the row by
   * "the caller used the channel's secret", which is a claim the CHANNEL makes: a
   * `parseCallback` that returns without verifying — the integration bug that looks like
   * success — makes it for free, once per POST, forever. `#admitRow` bounds what that can
   * cost. It changes nothing for a channel that behaves: 32 refusals on one run is far
   * past anything a legitimate one produces.
   *
   * `e` IS TYPED `LoomError` AND THAT IS THE POINT. Every caller owns its value at the
   * boundary it crossed — `ownError` in each catch, `callbackRejection` for the refusals
   * this router decides — so the compiler now says what three waves of comments used to:
   * nothing a channel or an engine built reaches this method, and the reads below are of
   * an object we constructed. The error is returned rather than thrown so that the caller
   * writes `throw await this.#refuse(...)` and the refusal cannot be recorded without also
   * being raised.
   */
  async #refuse(
    durable: boolean,
    runId: RunId,
    channel: string,
    gateId: GateId | undefined,
    e: LoomError,
  ): Promise<LoomError> {
    const reason = reasonOf(e);
    if (durable && this.#admitRow(runId)) {
      try {
        await this.#logFor(runId).append([
          {
            type: "gate.callback_rejected",
            // BOUNDED AT THE ROW, as well as at the one caller — the same argument
            // `journalMessage` makes on the outbound half. `channel` is a configured key and
            // `reason` is a closed set, so this was the only field on an
            // unauthenticated-reachable row that a producer could get wrong; the write is
            // the one place every producer passes through, and it costs a `slice`.
            payload: { channel, reason, ...(gateId === undefined ? {} : { gateId: safeGateId(gateId) }) },
            actor: SYSTEM_ACTOR("gate-callback"),
          },
        ]);
      } catch (appendFailure) {
        // No row landed, so this refusal has no sink yet — and the one thing that may not
        // happen is for it to have none. Counting it keeps "exactly one" true (the journal
        // took nothing), and the caller still gets the STORE's failure rather than the
        // refusal, because "we could not record this" is the more urgent fact.
        this.#count(channel, reason);
        throw ownError(appendFailure);
      }
    } else {
      this.#count(channel, reason);
    }
    return e;
  }
}

/**
 * Replace the named fields, wherever they appear, and leave everything else alone.
 *
 * Recursive by KEY NAME rather than by path: `email` is `email` whether it sits at the
 * top level or three objects down, and a path list would silently miss the nested one.
 *
 * IT RETURNS A NEW TREE, which is the property `GateDispatcher.deliver` depends on and
 * the one that made the leak it once closed possible: anything still holding the tree
 * that went IN holds the unredacted values, however carefully the copy is handled.
 * Nothing except a named field is copied deeply enough to matter — a leaf that is neither
 * an object nor an array is shared, and a shared immutable is not a channel of any kind —
 * but every object and array on the way down is rebuilt, so no *container* is common to
 * both trees.
 *
 * THE WALK ITSELF IS `redact`'S, and that is the whole body of this function now. It used
 * to be a second walk over the same class of data, in a different file, with different
 * robustness — and the differences were all in the wrong direction:
 *
 *   - **a function survived by reference**, because `typeof v !== "object"` is true of one,
 *     so an own-enumerable `toJSON` was copied onto the redacted tree and
 *     `WebhookChannel.deliver`'s `JSON.stringify` then CALLED it. A payload could rewrite
 *     itself after redaction had run, on its way out to a third party;
 *   - **no depth limit and no cycle detection**, in the redactor of all places, while
 *     `redact` twenty lines away had both. A self-referential payload was a `RangeError`
 *     out of the dispatcher rather than a delivered gate.
 *
 * Two walks over one class of data is the drift; one walk with a `only` option is the fix.
 *
 * WHAT COMES WITH IT IS MORE HIDING ON THE MOST UNTRUSTED SINK IN THE SYSTEM, which sounds
 * unambiguously good and runs straight into D7.3's "a human cannot approve what they cannot
 * see". So THE LINE, DECIDED, and pinned by *WHAT A DELIVERY HIDES THAT THE GRAPH DID NOT
 * NAME*. Three things are hidden here that no `redact` list asked for:
 *
 *   - a `SecretValue`, which renders as its own ref — a fact about the VALUE (`isSecret`
 *     asks the value what it is);
 *   - a detector's credential shape inside free text, which renders `[redacted:<name>]`
 *     and leaves the prose around it intact — also a fact about the value, a guessed one,
 *     which is why mechanism 2 is a backstop and not a policy;
 *   - a KEY that names a secret (`SECRETISH_KEY`), which renders `[secret]` — AND THIS ONE
 *     IS A FACT ABOUT THE NAME.
 *
 * THAT THIRD DISTINCTION WAS ELIDED HERE FOR A WAVE, and it matters because the argument
 * this paragraph makes — "a credential is never the thing being approved; it is the thing
 * that must not reach Slack" — is a claim about VALUES, and a rule on names both over- and
 * under-approximates it. Both directions are now pinned by *…AND THE SECOND OF THE THREE IS
 * A RULE ABOUT THE NAME, WHICH CUTS BOTH WAYS*, with the payload that reaches them:
 *
 *   - OVER. `SECRETISH_KEY` ends in `s?`, so `secrets` matches — and `{action: "rotate",
 *     secrets: ["stripe-live", "db-primary"]}` is a gate whose MANIFEST is the thing being
 *     approved. The approver is asked "may I rotate [secret]?". `tokens` matches too, and
 *     on an agent framework a token is a unit of spend, not a credential; so does
 *     `max_tokens`, through the `(?:.*_)?` prefix. Those are D7.3's own failure;
 *   - UNDER (now closed by the VALUE detector, not by these name rules).
 *     `db_url: "postgres://svc:hunter2@db.internal:5432/app"` is a real credential
 *     under a name no rule names, and no detector matches a DSN. It reaches the channel
 *     verbatim. The rule is a heuristic, so `redact` remains the mechanism a graph author
 *     is entitled to believe, and this is a backstop that misses.
 *
 * IT IS KEPT ANYWAY, and the argument is narrower than the one it replaces: on the most
 * untrusted sink in the system a name that says "credential" is worth one constant of
 * caution, and the cost is bounded by the SHAPE of the hiding rather than by the rule's
 * accuracy — each of the three leaves the key in place and puts a legible marker in the
 * value, so an approver sees that something was there and can REFUSE to approve blind
 * rather than being shown a payload with a hole they cannot detect. Over-hiding is a
 * refusable gate; under-hiding is a leak. `SECRETISH_KEY` lives in `security/redact.ts`,
 * where its other caller is a span attribute with a different audience — widening or
 * narrowing it is a decision about both sinks, not about this one.
 *
 * NOTHING ELSE IS HIDDEN. A field the list does not name and no rule above matches keeps
 * its value verbatim — a number, a date, a name, an amount, ordinary prose.
 *
 * AN EMPTY LIST STILL SHORT-CIRCUITS, returning the caller's own tree. Nothing was
 * declared hidden, so there is nothing to hide behind and no copy worth making — and the
 * protections above only exist for a payload this function actually walks.
 *
 * THE CLASSIFICATION IS FLOORED AT `pii`, and that is not the caller's declaration being
 * overridden for fun. `Classification` says how sensitive DATA IS; `redactAs` borrows it
 * to say how a hidden field is RENDERED, and two of its four values classify data as not
 * sensitive — so `redactAs: "internal"` reached `redact`'s detector sweep, which is a
 * backstop for free text, and returned the value verbatim for anything no detector
 * matched. A graph author who writes `redact: ["ssn"], redactAs: "internal"` has said
 * plainly that the field is not for the channel; a rendering that renders it is not a
 * rendering. Flooring composes the only safe direction — more hiding, never less — which
 * is the same rule the posture lattice runs on.
 *
 * The floor leaves the two values that mean something alone: `pii` correlates without
 * disclosing, `secret_ref` renders `[secret]` and correlates not at all.
 *
 * `scope` IS REQUIRED, and it is the one parameter here with no default on purpose. It
 * names the correlation domain of the tokens (see `redact` and `tokenKey`): every caller of
 * this function is shipping the result OUTSIDE the trust boundary, which is precisely the
 * condition under which `tokenKey`'s process-wide default is a chosen-plaintext oracle. A
 * default would make forgetting it a review comment; requiring it makes forgetting it a
 * compile error, which is what this codebase does with a guard that has been missed once.
 * Pass the run id.
 */
export function redactFields(value: unknown, fields: readonly string[], as: Classification, scope: string): unknown {
  if (fields.length === 0) return value;
  return redact(value, maxClassification(as, "pii"), { only: fields, scope }).value;
}

/**
 * The summary a channel is handed: the gate's own fields, with nothing shared.
 *
 * `{...gate}` is a SHALLOW spread, and `GateSummary` carries four containers that are not
 * copies of anything — `approvers` and `allowEdit` arrive from the compiled graph node and
 * are re-read by every later raise on it, `writes` and `take` come off the projection. So
 * the spread handed a channel a live reference to the AUTHORIZATION LIST of the next gate on
 * that node, and `push` was the exploit. See `GateDispatcher.deliver`'s prelude for the
 * reproduction; `DeliveryTarget.payload` for why "a channel never sees what the
 * classification said to hide" has to be read as a claim about the whole object.
 *
 * IT IS TOTAL FOR EVERY VALUE ON EVERY FIELD, and the wording matters because the weaker
 * version of this sentence — "total in the shapes it copies" — was how a partial one passed
 * review. It runs in `deliver`'s prelude, outside every try in a file whose single rule is
 * that delivery has one exit, so anything it can throw on is a gate nobody is ever told
 * about. What it used to rest on was `Array.isArray`, "asks without invoking anything": TRUE
 * of the values it recognised, false of a revoked proxy, and beside the point for the branch
 * it guarded, which then SPREAD the array and ran every element getter. Both are closed —
 * see `ownedList` for the spread and `isArrayValue` for the ask — and what is left is five
 * total copiers over five bare field reads of the ENGINE'S OWN read model, which is the
 * exclusion `THE BOUNDARY` states and prices.
 *
 * THE FIELD LIST HERE IS NOT THE GUARANTEE. A list of names is exactly what let `approvers`
 * through when it was added to `GateRecord`, so the property is pinned as an IDENTITY check
 * over the whole target — *…AND THE RULE IS STRUCTURAL* — which goes red on the next
 * container field whether or not anybody remembers this function.
 *
 * IT SAID THAT WHILE `batch` WAS OPEN, which is the same claim failing the same way one
 * field later. `GateRecord.batch` — D7.9 row 2's `{id, key}`, folded from `gate.raised.batch`
 * and put on the record BY REFERENCE (`projection.ts`) — is a container the summary carries,
 * and the spread shared it. The test could not see it: its fixture named the four fields it
 * knew about, so there was no `batch` on the target to be shared. A structural rule pinned by
 * a hand-written fixture is a rule about that fixture. The fixture is now derived from
 * `GateSummary` by a mapped type, so a container field with no entry in it is a COMPILE
 * error and the identity walk then covers it at runtime.
 *
 * AND THE MAPPED TYPE HAS NOW EARNED ITSELF ONCE MORE, in the only way a structural rule ever
 * gets evidence: a `decidedBy` field arrived on `GateRecord` carrying the journal event's own
 * `Actor` OBJECT, from a change that had no reason to think about delivery, and the fixture
 * stopped COMPILING before anybody read this function. It is `Actor["kind"]` today — a
 * string, and therefore not this function's problem — because "every object-valued field on
 * this type is one more thing `GateDispatcher` must copy rather than share" became a reason
 * to narrow it. The rule paid for itself in the design of a field in another file.
 *
 * AND WHAT AN UNREADABLE FIELD BECOMES IS DECIDED PER FIELD, HERE. `ownedList` answers
 * `undefined` for both "absent" and "could not be copied", and those two point in opposite
 * directions for every field below — so the call site distinguishes them rather than the
 * copier, and the direction is always the one that does not widen. `?? []` on `approvers`
 * was the opposite: it turned "I could not read who this gate names" into "the gate named
 * nobody", which is the permissive reading and the one substitution `ownedList`'s own
 * docstring says may never be made.
 */
function shownGate(gate: GateSummary, payload: unknown, contentDigest: string): GateSummary {
  // READ ONCE EACH. A field read twice need not answer twice the same — `channelName`'s
  // lesson — and each of these is then asked two questions.
  const approvers: readonly string[] | undefined = gate.approvers;
  const excluded: readonly string[] | undefined = gate.excludedApprovers;
  const allowEdit = gate.allowEdit;
  const take = gate.take;
  const writes = gate.writes;
  const batch = gate.batch;
  return {
    ...gate,
    payload,
    contentDigest,
    // ABSENT is "the gate named nobody" and stays `[]`. UNREADABLE is a different fact and
    // gets a name no subject holds, so a channel rendering the list shows that somebody was
    // named and that we could not say who. Nothing here authorizes anything — `resolve`
    // reads approvers from the journal — so the cost of the marker is a rendering, and the
    // cost of `[]` was a false statement about who is being asked.
    approvers: approvers === undefined ? [] : (ownedList(approvers) ?? [UNRENDERABLE]),
    // ABSENT stays absent here, unlike `approvers`, because the two absences say different
    // things: a gate that names no approvers is asking everyone, and `[]` renders that
    // truthfully; a gate with no exclusion is not asking anything about exclusion at all, and
    // `[]` would render as "these people are barred: nobody" — a rule the author never wrote.
    // Unreadable takes the marker for the same reason it does above: somebody is barred and
    // we cannot say who.
    ...(excluded === undefined ? {} : { excludedApprovers: ownedList(excluded) ?? [UNRENDERABLE] }),
    // The same rule the other way up: absent means UNCONSTRAINED here (`GateRecord.allowEdit`
    // — "Absent = unconstrained; `[]` = none"), so an unreadable one may not become absent.
    // `[]` is the narrow answer, and narrowing is the direction a value we could not read is
    // allowed to move.
    allowEdit: allowEdit === undefined ? undefined : (ownedList(allowEdit) ?? []),
    // `take === undefined` has already answered "absent", so `undefined` from `ownedList`
    // here means UNREADABLE and nothing else — and `[]` would say the human selected no
    // edges, which is a decision they did not make.
    ...(take === undefined ? {} : { take: ownedList(take) ?? [UNRENDERABLE] }),
    // A DEEP copy, because a shallow one would share the channel values inside it. An open
    // gate has no decision, so this is defence in depth for a caller driving the dispatcher
    // directly — but `{}` is not a way to say that the copy failed; see `ownedWrites`.
    ...(writes === undefined ? {} : { writes: ownedWrites(writes) }),
    // The container this function's own "nothing is shared" claim missed. See above.
    ...(batch === undefined ? {} : { batch: ownedBatch(batch) }),
    // …and the one the mapped type caught the hour it landed. `decidedBy` is the JOURNAL
    // EVENT'S OWN actor object, handed to the projection by reference, so sharing it is the
    // `approvers` hole with a different field name.
    //
    // AN UNCOPYABLE ACTOR DEGRADES TO A SYSTEM ONE, which is this field's fail-closed
    // direction rather than a substitution: `decidedBy`'s own docstring says every reader
    // treats absent — and anything that is not `kind: "human"` — as "not a human's", which
    // is what `#inheritable` needs. It is NOT dropped, because absent and unreadable are
    // different facts, and it names `(unrenderable)` rather than a component that exists, so
    // no channel can read it as a part of this system having decided anything.
  };
}

/**
 * The batch a gate merged into, copied rather than shared.
 *
 * Two scalars, so the `ownedJson` pass is about IDENTITY rather than about depth: the object
 * on the record is the one `projection.ts` folded off `gate.raised.batch` and put on the
 * record unchanged, so handing it over gave a channel a write into the projection's own
 * record of which batch this gate is in — and a batch decides something, which is why the
 * field is folded rather than remembered.
 *
 * TOTAL, like everything else in this prelude. The whole-copy path is the fast one; the
 * degrade is PER KEY and not a rebuild of the fields this function happens to know the names
 * of — `ownedRecipients`' lesson, and this record has already grown three (`windowMs`,
 * `maxBatch`, `deliveryDigest`) since it was two. `id` and `key` are then made to be the
 * strings the type says they are, `id` through `safeGateId` so it also names no prototype.
 *
 * AND THE SHAPE CHECK IS ON THE INPUT, which it was not: this function was written in the
 * same change that moved `ownedWrites`' check off the result, 170 lines below, and it kept
 * the spelling that change removed. `isPlainRecord(ownedJson(batch))` asks whether the COPY
 * is a record, and `ownedJson` answers `{}` for every object whose data is not in own
 * properties — so a batch it could not carry came back `{}`, which is a batch with no `id`
 * and no `key`: what a gate in NO batch looks like to the channel reading it. Measured, each
 * rendering a real batch as an absent one: `new Map([["id","gate_first"],["key",
 * "policy:restart"]])` → `{}`, `new Set([…])` → `{}`, a class instance holding `#private`
 * state → `{}`. And the one shape that failed the result check fell to the per-key walk,
 * where an array's own names are its indices: `["gate_first","policy:restart"]` rendered
 * `{"0":…,"1":…,"length":2}`, a batch with a field called `length`.
 *
 * A batch is WHICH OTHER GATES THIS DECISION ALSO ANSWERS (D7.9 row 2), which is why the
 * field is folded from the journal rather than remembered — so "answer these two together"
 * quietly rendering as "answer this one" is the same substitution `{}` was for an edit, one
 * field over. The marker pair (`id: "(unknown)"`, `key: "(unrenderable)"`) says a batch was
 * named and could not be read, which a channel can act on and `{}` was not.
 *
 * AND THE NORMALIZATION IS UNCONDITIONAL, WHICH THE SENTENCE FOUR PARAGRAPHS UP ASSERTED AND
 * THE CODE DID NOT DO. "`id` and `key` are then made to be the strings the type says they
 * are" was written of a function whose whole-copy path RETURNED before reaching them, so the
 * two paths of one function answered one question two ways and the docstring described only
 * the slow one. What this function ASSERTS is a property of its RETURN TYPE — a record
 * nothing else holds, whose `id` is a plausible gate id and whose `key` is a string — and a
 * claim about the return type cannot be contingent on which branch built it. Measured
 * through `GateDispatcher.deliver`, the whole-copy path against the same input made
 * uncopyable by one added cycle:
 *
 * | `gate.batch` | whole copy (before) | degrade path |
 * |---|---|---|
 * | `{id: 42, key: {nested: true}}` | `{"id":42,"key":{"nested":true}}` | `{"id":"(unknown)","key":"(unrenderable)"}` |
 * | `{id: "__proto__", key: "k"}` | `"__proto__"` kept as the id | `(unknown)` |
 * | `{id: "g", key: "x".repeat(400)}` | 400 characters | sliced to `MAX_ID` |
 * | `{}` | `{}` — the shape a gate in NO batch has | the marker pair |
 * | `{id: null, key: null}` | `null`, `null` | the marker pair |
 *
 * The last two are the same substitution the paragraph above says the marker pair exists to
 * prevent, arrived at through the branch nobody re-read. The fast path now FILLS `out` and
 * falls through; it is still the fast path, because a copy that succeeded is not walked
 * twice through `ownedJson`.
 *
 * WHAT THE TWO PATHS STILL DISAGREE ABOUT, and why that one is left standing: WHICH NAMES
 * are the record's fields. `JSON.stringify` carries own ENUMERABLE string keys and calls
 * `toJSON`; `ownNames` reports own names enumerable or not and calls nothing. So a
 * non-enumerable own field is dropped by the whole copy and shown by the walk. That question
 * has two defensible answers — the journal's own view (`canonicalize` reads own enumerable
 * keys, so the whole copy agrees with what could ever have been stored) against the walk's —
 * and no signature to arbitrate between them, which is exactly what made the `id`/`key`
 * disagreement above a defect and leaves this one a limit. See `isPlainRecord`.
 */
function ownedBatch(batch: NonNullable<GateRecord["batch"]>): NonNullable<GateRecord["batch"]> {
  const out: Record<string, unknown> = {};
  if (isPlainRecord(batch)) {
    const whole = ownedJson(batch);
    if (isPlainRecord(whole)) {
      // THE FAST PATH FILLS `out` AND FALLS THROUGH. It used to RETURN here, and that is
      // one function answering one question two ways — see the docstring's last block.
      for (const name of ownNames(whole)) put(out, name, readProp(whole, name));
    } else {
      for (const name of ownNames(batch)) {
        const value = ownedJson(readProp(batch, name));
        put(out, name, value === undefined ? UNRENDERABLE : value);
      }
    }
  }
  const key = out["key"];
  return {
    ...out,
    id: safeGateId(out["id"]),
    key: typeof key === "string" ? key.slice(0, MAX_ID) : UNRENDERABLE,
  } as NonNullable<GateRecord["batch"]>;
}

/**
 * One list, COPIED — and any other container copied too, rather than passed by reference.
 *
 * The else branch used to be `: v`, which is the aliasing hole the `approvers` fix closed,
 * one shape over: `Array.isArray` answers "no" for a plain object, a `Map`, a `Date` and a
 * `RegExp` alike, and each of those went to a channel as the object the ENGINE still holds.
 * The identity walk that pins the array case cannot see it, because its fixture is a real
 * array. What is NOT done here is substituting an empty list for a shape we did not expect:
 * `[]` on `approvers` is the PERMISSIVE reading — "the gate named nobody" — and that is the
 * one thing a value we could not read may never be turned into.
 *
 * ITS ONLY CALLER DID EXACTLY THAT, eighteen lines above this sentence, for as long as the
 * sentence stood: `ownedList(gate.approvers) ?? []`. This function answers `undefined` for
 * "absent" and for "could not be copied" alike, so honouring the rule is the CALLER'S to do
 * and `shownGate` now does it per field — read the two apart there, not here, because which
 * direction is permissive differs by field and only the call site knows.
 *
 * TOTAL, because it runs in `deliver`'s prelude, outside every try in a file whose single
 * rule is that delivery has one exit. IT WAS NOT, and the exception was the branch its own
 * totality argument named as safe: `Array.isArray(v) ? [...v] : …`. **A SPREAD IS A READ OF
 * THE ELEMENTS** — it calls the array's own iterator, which calls `[[Get]]` per index, which
 * is a getter or a proxy trap on a value this module did not build. Reproduced on a real
 * array with an accessor at index 1: `deliver` exited with the caller's own `Error`, no
 * delivery, no fallback, no journal row. That is the identical defect `ownedRecipients` was
 * fixed for 45 lines down, in the wave before this one, under the sentence "the elements now
 * go through `readProp` like every other read of a value from outside" — and the sentence
 * did not travel to the neighbour it was written next to.
 *
 * So the shape is now that function's, exactly: **whole copy, then per-index degrade.**
 * `ownedJson` runs every getter and trap once inside a try; when the tree defeats it, the
 * walk is over the array's OWN INDEX NAMES (`indexNames`) through `readProp`, because
 * `length` on a proxy is a trap that can answer 2³²−1 and there is no `ownedJson` above it
 * any more to bound the result.
 *
 * AN EMPTY WALK IS NOT AN EMPTY LIST. `ownNames` answers `[]` for a proxy whose `ownKeys`
 * trap throws, and returning that `[]` would be the caller writing `?? []` all over again in
 * the one place this function's docstring forbids it — the whole copy has already FAILED, so
 * nothing here can honestly say the gate named nobody. `undefined` sends the decision back
 * to the call site, where the permissive direction differs per field.
 *
 * THE COPY IS DEEP NOW, where the spread's was shallow. That paragraph used to read "a
 * shallow copy is a deep one for the three fields this serves, all of them declared lists of
 * strings — the day a list of CONTAINERS reaches it, the elements are shared again": that day
 * no longer has a hole in it, since `ownedJson` rebuilds every container on the way down.
 *
 * The copy is FAITHFUL for every shape the types permit and BEST-EFFORT for the rest, which
 * is the honest way round: measured, a `Map` or a `Set` here JSON-copies to `{}` because its
 * entries are not own properties. Nothing in the tree produces one — `projection.ts` folds
 * arrays out of the journal — and what is kept in every case is the property this function
 * exists for, that the channel holds nothing the engine also holds.
 */
function ownedList<T>(v: readonly T[] | undefined): readonly T[] | undefined {
  if (v === undefined) return undefined;
  const whole = ownedJson(v);
  if (whole !== undefined) return whole as readonly T[];
  if (!isArrayValue(v)) return undefined;
  const out: unknown[] = [];
  for (const key of indexNames(v)) {
    const element = ownedJson(readProp(v, key));
    out.push(element === undefined ? UNRENDERABLE : element);
  }
  return out.length === 0 ? undefined : (out as readonly T[]);
}

/**
 * The routing list a channel is handed, as objects this module built — ALL of them, not the
 * two fields this file happens to know the names of.
 *
 * `tierRecipients` returns `spec.recipients` — the DELIVERY SPEC'S own array, out of the
 * compiled graph, and measured: `compileOrThrow` puts the author's own recipient objects on
 * the plan. So both the array and each `Recipient` in it were live references, and a channel
 * editing one changes who the next tier is told: the `approvers` defect one field along.
 *
 * IT USED TO REBUILD EACH ENTRY AS `{kind, id}`, which is two separate defects:
 *
 *   - **the reads are calls.** `r.kind` on a value assembled outside this module runs a
 *     getter, in a prelude that sits outside every try. The audit that cleared this line
 *     said "passed through unchanged, no getter run … total by construction"; neither half
 *     was true, and the cost of the throw is the delivery, the fallback, and both journal
 *     rows — a gate nobody is told about, which is what this file exists to prevent;
 *   - **it deleted what the compiler admits.** `graph/validate.ts`'s `checkRecipient`
 *     validates `kind` and `id` and accepts every other key, so a graph may carry vendor
 *     routing metadata on a recipient — and a `Recipient` is "resolved by the channel, not
 *     by the broker", which makes the channel the one party that would use it. The compiler
 *     admitting a field the dispatcher silently drops is the disagreement; it is resolved in
 *     the direction that keeps the graph author's declaration meaningful, because closing
 *     the shape at compile time would refuse a portable graph in the deployment whose
 *     channel needs the field — the argument `checkDelivery`'s own docstring makes for not
 *     checking channel names.
 *
 * `ownedJson` does both jobs at once: one pass, every getter run inside a try, a plain tree
 * out with no live code and no container shared at any depth. It degrades DOWNWARD when JSON
 * cannot represent something — per entry, then to the ADDRESS, which is what routing needs
 * and is all the outbound body could have carried anyway.
 *
 * AND THE DEGRADE PATH IS INSIDE THE BOUNDARY TOO, which it was not: `recipients.map(…)`
 * READS THE ELEMENTS, and the only way to reach that line is for `ownedJson` to have failed
 * — which a throwing element getter is exactly how to do. So the shape that sent us down here
 * was re-run outside every try, in a prelude whose whole rule is that delivery has one exit.
 * Reproduced on a real array with a throwing index getter: `deliver` exited with the
 * channel's own `Error`, no delivery, no fallback, no journal row. The elements now go
 * through `readProp` like every other read of a value from outside, and the walk is over the
 * array's OWN INDEX NAMES rather than `0…length` — `length` on a proxy is a trap that can
 * answer 2³²−1, and `ownedJson` is not there to bound it any more.
 *
 * "NO LIVE CODE AND NO CONTAINER SHARED AT ANY DEPTH" HAD A COUNTEREXAMPLE IN ITS OWN DEGRADE
 * PATH for as long as it stood, and the claim is only now true. `addressOnly` copied `kind`
 * and `id` with a bare `readProp`, which is a total READ of a value it then handed on
 * UNCHANGED — measured, `target.recipients[0].kind === <the caller's own object>` was true —
 * so an entry the whole copy failed on delivered the very thing this function exists to
 * remove. It goes through `ownedJson` per field now. The same change closed the other half:
 * an entry nothing could be read from used to become `{kind: undefined, id: undefined}`, an
 * address of nobody rather than a marker, indistinguishable from a recipient that declares
 * neither field. See `addressOnly`.
 */
function ownedRecipients(recipients: readonly Recipient[]): readonly Recipient[] {
  // ONE PASS for every real case: the list, its entries, and everything under them.
  //
  // A NON-LIST IS PASSED ON AS A COPY OF WHATEVER IT WAS, not as `[]`. A graph declaring one
  // recipient instead of a list of them compiles — `checkDelivery`'s `asArray` skips a
  // non-array, so `checkRecipient` never runs on it. `[]` would answer that mistake with
  // "the graph named nobody", which is a claim about routing that nothing here can support.
  //
  // WHAT HAPPENS TO IT DOWNSTREAM IS NOT ONE THING, and the sentence that stood here said it
  // was: "every channel then fails loudly on `recipients.map`, which is a diagnosis". This
  // file's own `WebhookChannel` NEVER CALLS `.map` — it puts `recipients` in a JSON body —
  // so measured, with `recipients: {kind: "role", id: "sre-oncall"}`, it DELIVERED, receipt
  // and all, and shipped `{"kind":"role","id":"sre-oncall"}` where the receiver's schema says
  // array. `ConsoleChannel` used to call `.map` through `formatRecipients`, and the loud
  // failure there was not a diagnosis either: it was a delivery failure, and since the
  // built-in fallback IS a `ConsoleChannel` it failed identically — `delivered: 0, failed: 2,
  // fellBack: false`. `formatRecipients` answers `(unrenderable)` for a non-list now and
  // reads nothing bare, so the fallback holds; the malformed value still reaches a channel
  // that will take it, which is the honest description of passing it through.
  // Refusing the declaration belongs in `checkDelivery`, where the shape is known at compile
  // time and where a graph author reads the diagnostic.
  const whole = ownedJson(recipients);
  if (whole !== undefined) return whole as readonly Recipient[];
  // JSON could not represent the list AS A WHOLE — a cycle, a bigint, a getter that threw.
  // Degrade per entry, so one exotic recipient costs its own fields and not everybody's.
  // `isArrayValue` and not `Array.isArray`: the bare call throws on a revoked proxy, which
  // is a value that reaches exactly this line, having just defeated `ownedJson`.
  //
  // `[]` IS WHAT NOTHING-CARRIED-OVER LOOKS LIKE, and the sentence here used to say it is
  // "reached only when there is no list to walk AND no copy to hand over" — the walk can
  // also come back empty, since `ownNames` answers `[]` for a proxy whose `ownKeys` trap
  // throws. `ownedList` answers `undefined` for that case and lets its caller choose the
  // direction; this one HAS no third answer, because `DeliveryTarget.recipients` is a
  // `Recipient[]`. It stays `[]` because routing is not authorization: the cost is a
  // console line saying "anyone" where nobody could be read, on a spec no compiled graph
  // can produce (a graph document is JSON, so `ownedJson` cannot fail on one).
  if (!isArrayValue(recipients)) return [];
  const out: Recipient[] = [];
  for (const key of indexNames(recipients)) {
    const entry = readProp(recipients, key);
    out.push((ownedJson(entry) ?? addressOnly(entry)) as Recipient);
  }
  return out;
}

/**
 * The own INDEX names of an array-shaped value, in the order a JSON copy would carry them.
 *
 * Own names of an array are its indices in ascending order, then `length` and anything else
 * somebody hung on it — none of which `ownedJson` would have carried either. The walk is over
 * these rather than over `0…length` because `length` on a proxy is a trap that can answer
 * 2³²−1, and on the degrade path there is no `ownedJson` above to bound the result.
 *
 * ONE COPY, shared by the THREE walks over a list from outside (`ownedList`,
 * `ownedRecipients`, `formatRecipients`), so they cannot come to disagree about what an
 * array's elements ARE. It said "the two degrade paths" while `formatRecipients` was still
 * calling `map`; the third caller is what closed that.
 *
 * What an unreadable element BECOMES stays with each caller, and they differ FOR A REASON
 * THAT IS ABOUT THE ELEMENT TYPE, not about the caller's taste. `ownedList` serves lists of
 * STRINGS (`approvers`, `allowEdit`, `take`), so a bare `(unrenderable)` is in shape there.
 * `ownedRecipients` serves a list of RECORDS every reader indexes into — `formatRecipients`
 * reads `.kind` and `.id`, `WebhookChannel` ships the record to a vendor whose schema wants
 * both — so a bare string element would be a shape no channel can read, and the marker goes
 * in the FIELD instead, keeping the record. The sentence here used to be "an address of
 * nothing routes, a marker renders", which is how `{kind: undefined, id: undefined}` came to
 * stand for an entry nobody could read; an address of nothing routes NOWHERE.
 */
function indexNames(v: unknown): readonly string[] {
  return ownNames(v).filter((key) => ARRAY_INDEX.test(key));
}

/** A canonical array index, so the degrade walk carries exactly what a JSON copy would. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/**
 * The two fields a `Recipient` is ADDRESSED by, COPIED. The fallback, never the rule.
 *
 * `{kind: readProp(r, "kind"), id: readProp(r, "id")}` was two defects wearing one docstring
 * — "read totally" is a claim about the READ, and both of the things this function is for
 * are claims about the VALUE:
 *
 *   - **an unreadable entry became an ADDRESS, not a marker.** `readProp` answers
 *     `undefined` for a field it could not read, so an entry nothing could be read from
 *     produced `{kind: undefined, id: undefined}` — which `JSON.stringify` renders `{}`, and
 *     which is byte-identical to what a recipient DECLARING neither field produces on the
 *     whole-copy path. Measured through `GateDispatcher.deliver`, a revoked proxy and a
 *     literal `{}` in the recipients list came out of the dispatcher as the same value,
 *     `[{}]`, rendering `undefined:undefined` in both cases. A channel therefore could not
 *     tell "this recipient could not be read" from "this recipient names nobody", and only
 *     one of those is a fact about the graph. `ownedList` had been given an explicit marker
 *     for the same case in the same wave; this one was filed on the other side of the split.
 *   - **it SHARED whatever came back.** `ownedRecipients`' docstring promises "a plain tree
 *     with no live code and no container shared at any depth", and this path is the only way
 *     to reach it — so the promise had a counterexample inside its own function. Measured:
 *     `target.recipients[0].kind === <the caller's own object>` was **true** for an entry
 *     whose own copy failed.
 *
 * Both close with one change: each field goes through `ownedJson`, so what survives is a
 * copy and what does not is the marker in that field's position, which keeps the RECORD
 * shape every reader of a recipient indexes into.
 *
 * `undefined` AND NOT `??`, because `null` must not become the marker: the whole-copy path
 * carries a `null` field through as `null`, and the two paths of one function may not answer
 * the same question differently — `ownedBatch`'s lesson, three helpers up.
 *
 * WHAT IT COSTS, stated rather than hidden: a field that is genuinely ABSENT on an entry
 * whose own copy failed for some other reason is marked as unreadable. `readProp` cannot
 * tell absent from unreadable and its docstring says a caller that needs to is a caller that
 * has to handle a throw again. The direction is the one that does not widen — saying "we
 * could not read this" about an absent field costs a rendering, while saying "absent" about
 * an unreadable one is a claim about who is being paged.
 */
function addressOnly(r: unknown): Recipient {
  return { kind: ownedField(r, "kind"), id: ownedField(r, "id") } as Recipient;
}

/** One field of an entry the whole copy could not carry: a copy of it, or the marker. */
function ownedField(r: unknown, name: string): unknown {
  const value = ownedJson(readProp(r, name));
  return value === undefined ? UNRENDERABLE : value;
}

/**
 * The write-set a channel shows an approver: a copy, with a FAILED RENDER SAID rather than
 * rendered as an empty edit.
 *
 * `ownedJson(gate.writes) ?? {}` collapsed the WHOLE set on one unrepresentable value — a
 * bigint, a cycle, a getter that threw — and `{}` is exactly what an edit that writes
 * nothing looks like to the human being asked to approve it. Every field that WAS
 * representable went with it. It is the class `conformsToGraph` was fixed for one file over
 * — a function whose silence is READ AS A CLAIM, rather than one that merely removes
 * something the way `redactAttributes` does.
 *
 * So it degrades DOWNWARD, per key, the way `rejectionReasonOf` and `describeCause` do: the
 * fields that render are shown, and each one that does not is the marker in its own
 * position, so the approver can see that something is there and REFUSE to approve blind.
 * When nothing at all could be rendered — including a `writes` that is not a record — the
 * marker takes the place of the whole set, because `{}` may only ever mean `{}`.
 *
 * THAT LAST SENTENCE WAS FALSE, AND THE REASON IS THE SHAPE CHECK'S PLACEMENT: it asked
 * whether the RESULT was a record, and `ownedJson` answers `{}` for every object whose data
 * is not in own properties. Measured, each a non-empty write set rendered as an empty edit:
 * `new Map([["findings","ok"],["prod_state","drain"]])` → `{}`, `new Set([…])` → `{}`, a
 * class instance holding `#private` state → `{}`. And one that did not empty but lied a
 * different way: an ARRAY passed the result check nowhere and fell to the per-key walk, so
 * `["findings","prod_state"]` rendered `{"0":"findings","1":"prod_state","length":2}` — an
 * edit to a channel called `length`.
 *
 * So the check is on the INPUT: a write set is a plain record, its own names are all of it,
 * and anything else is the marker. The per-key walk then keeps its meaning — it runs on a
 * shape whose keys ARE its fields — and `{}` comes back only from a `{}` that went in.
 * A class instance with legible own fields loses per-key detail it used to keep; over-marking
 * is a gate an approver can refuse, and `{}` was one they would approve.
 */
function ownedWrites(writes: unknown): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (isPlainRecord(writes)) {
    const whole = ownedJson(writes);
    if (isPlainRecord(whole)) return whole as Readonly<Record<string, unknown>>;
    for (const key of ownNames(writes)) {
      const value = ownedJson(readProp(writes, key));
      put(out, key, value === undefined ? UNRENDERABLE : value);
    }
  }
  if (Object.keys(out).length === 0) put(out, UNRENDERABLE, true);
  return out;
}

/**
 * A record whose OWN NAMES ARE PLAUSIBLY ALL OF IT — the shapes whose keys are not their
 * fields, refused.
 *
 * `typeof v === "object"` is true of a `Map`, a `Set`, a `Date` and every class instance, and
 * for each of those the own names are not the data. The prototype is the question that tells
 * them apart, and it is asked in a try because `getPrototypeOf` is a proxy trap like any
 * other. The array question goes through `isArrayValue` for the same reason: both are calls,
 * and both throw on a revoked proxy.
 *
 * WHICH SIDE IT IS APPLIED TO DECIDES WHAT IT PROVES, and this docstring used to claim one
 * answer for both. It said `JSON.parse` "only ever produces arrays and `Object.prototype`
 * objects, so this is also the exact test for 'the round trip carried the shape through'".
 * The premise is true and the conclusion does not follow from it, because it is a statement
 * about the round trip's OUTPUT being used to license a test on its INPUT:
 *
 *   - **On a value `ownedJson` PRODUCED it is exact.** `JSON.parse` yields `null`, a number,
 *     a string, a boolean, an array, or an `Object.prototype` object and nothing else, so
 *     "is a record" and "is a JSON object" are the same question there. That is what the
 *     result checks in `ownedWrites` and `ownedDecision`'s `edit` arm rely on, and they are
 *     sound.
 *   - **On an INPUT it is NECESSARY AND NOT SUFFICIENT.** It rules out exactly the shapes
 *     whose own names are not their data, which is the property the per-key walks need — and
 *     it establishes nothing about whether a round trip will carry the input through.
 *     Measured, node v24.16.0, each of these passing `isPlainRecord` on the way in:
 *
 *     | input | `ownedJson` of it |
 *     |---|---|
 *     | `{toJSON(){return 7}, id: "g1"}` | `7` — a number, not a record |
 *     | `{toJSON(){return "g1"}}` | `"g1"` |
 *     | `{toJSON(){return undefined}}` | `undefined` — the copy FAILS |
 *     | `{toJSON(){return ["a"]}}` | `["a"]` — an array |
 *     | `{id: "g1"}` + a non-enumerable own `key` | `{"id":"g1"}` — the field is gone |
 *     | `{id: "g1", key: undefined}` | `{"id":"g1"}` — same |
 *
 * The first four are caught downstream, because the result check refuses them and the
 * per-key walk runs instead. The last two are NOT: the copy succeeds, it is a record, and it
 * is missing a field that `ownNames` — the walk's own notion of what the fields are — would
 * have reported. So `isPlainRecord(input)` and `isPlainRecord(ownedJson(input))` can both be
 * true of a copy that is not the input, and no caller here can tell.
 *
 * That is a LIMIT and not a bug, stated so the next reader does not have to re-derive it: a
 * field JSON structurally cannot carry is a field `canonicalize` could never have stored
 * either (it reads own ENUMERABLE keys), so the whole-copy path agrees with the journal and
 * the walk over-shows. Both `ownedWrites` and `ownedBatch` inherit the disagreement; see the
 * last block of `ownedBatch` for why it is left standing where the `id`/`key` one was not.
 */
function isPlainRecord(v: unknown): boolean {
  if (v === null || typeof v !== "object" || isArrayValue(v)) return false;
  try {
    const proto: unknown = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

/**
 * `Array.isArray`, made TOTAL — the one inspector a proxy cannot forge, and the one this
 * prelude kept asking outside a try.
 *
 * `IsArray` follows a proxy to its target, so no handler can make a non-array answer yes and
 * none can make an array answer no. That is exactly why three helpers here reach for it —
 * *"a `Proxy` must tell the truth about exactly one observable"* — and it is why the second
 * half went unnoticed: IT IS NOT TOTAL. On a REVOKED proxy it THROWS, because the revoked
 * handler is `null` and `IsArray` refuses rather than answering. Measured, node v24.16.0:
 * `TypeError: Cannot perform 'IsArray' on a proxy that has been revoked`.
 *
 * That was the last bare call in a prelude whose totality is the property `deliver` rests on.
 * Every other accessor here already survives a revoked proxy — `JSON.stringify`,
 * `getOwnPropertyNames`, `getPrototypeOf` and a plain `[[Get]]` all throw on one too, and
 * `ownedJson`, `ownNames`, `isPlainRecord` and `readProp` each catch.
 *
 * "NOT AN ARRAY" IS THE SAFE ANSWER, which is what makes the catch a degrade rather than a
 * guess: every caller's non-array branch either copies through `ownedJson` or renders a
 * marker, and neither invokes anything on the value. A `true` for a proxy WRAPPING an array
 * is safe for the same reason — the walk that follows reads it through `ownNames` and
 * `readProp`, never through the iterator.
 */
function isArrayValue(v: unknown): boolean {
  try {
    return Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * Said in the position of a value that could not be rendered for a channel.
 *
 * One literal for the whole prelude — a write-set field, a write set entire, an approver
 * list that could not be copied, a batch key — because a channel reading two markers should
 * not have to learn that they mean the same thing. It is parenthesised for the reason
 * `UNKNOWN_GATE` and `UNIDENTIFIED_SUBJECT` are: nothing a system names for itself may be
 * mistakable for something a person or a graph named.
 */
const UNRENDERABLE = "(unrenderable)";

/** The own property names of a value from outside, or none. `ownKeys` is a proxy trap too. */
function ownNames(v: unknown): readonly string[] {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return [];
  try {
    return Object.getOwnPropertyNames(v);
  } catch {
    return [];
  }
}

/**
 * `out[key] = value`, except for the one key where that means something else entirely.
 *
 * `out["__proto__"] = v` SETS THE PROTOTYPE and adds no key, so the field would vanish from
 * the rendering while changing what the object inherits. `security/redact.ts` writes its
 * own copies the same way, for the same reason.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * The content address of the payload AS SHOWN, with every hidden position FLATTENED.
 *
 * "As shown" is the field's own definition (D7.8) and is not literally what the channel
 * receives, which is the precision this docstring lacked. Under the default `redactAs:
 * "pii"` a hidden leaf reaches the channel as a token and reaches this digest as the
 * constant `[secret]`; a hidden OBJECT or ARRAY reaches the channel with its shape intact
 * and reaches this digest as a single `[secret]`, because `redact`'s `secret_ref` arm
 * fires above the container walk. The two coincide exactly when `redactAs` is
 * `"secret_ref"`, or when nothing is hidden.
 *
 * WITH AN EMPTY FIELD LIST IT IS THE DIGEST OF THE TREE ITSELF, `redactFields` having
 * short-circuited — which is how `deliver` uses it on the no-redact branch, so that the
 * digest describes the bytes that were sent there too. See the note at the call site.
 *
 * THAT FLATTENING IS THE POINT, twice over. It makes the digest independent of the token
 * key — so it is stable across a restart and re-derivable by an auditor holding the
 * journal, which is what the field is FOR — and it makes no hidden value an input to the
 * digest, UNDER THE CONDITION `deliver`'s prelude states: a plain JSON value, at a depth
 * `redact` still walks, that the payload does not also carry at a position nobody named.
 * `isSecret` and `MAX_DEPTH` are the two arms above the flattening one, and a `SecretValue`
 * at a named position puts its `ref` — hence which secret it is — into this digest. What
 * the flattening does NOT make it is recomputable by the channel; see
 * `GateDispatcher.deliver` for the three readers, the four inputs that defeat
 * recomputation, and the cost.
 *
 * IN A TRY, because `digest` is the one call in `deliver`'s prelude that can THROW —
 * `canonicalize` refuses a bigint, a symbol, a non-finite number and an `undefined` array
 * element — and the prelude sits outside every try in a file whose single rule is that
 * `deliver` has one exit. A payload that reaches it is one `HumanGateBroker.raise` could
 * not have raised, since `raise` content-addresses the same payload first; a caller driving
 * the dispatcher directly can still build one.
 *
 * THE FALLBACK IS A MARKER AND NOT THE JOURNAL'S DIGEST, which is the whole decision here.
 * Falling back to `gate.contentDigest` would hand the channel the digest of the UNREDACTED
 * payload — the inversion oracle this branch exists to remove — reached through the one
 * input that makes the safe path fail. A degradation that restores the defect on a
 * hand-built payload is not a degradation. What a channel loses instead is dedup for that
 * one delivery, which is the cheaper half by a long way.
 */
function shownDigest(payload: unknown, fields: readonly string[], scope: string): string {
  try {
    return digest(redactFields(payload, fields, "secret_ref", scope));
  } catch {
    return UNDIGESTIBLE;
  }
}

/** Said when the payload shown to a channel cannot be content-addressed at all. */
const UNDIGESTIBLE = "(undigestible)";

/** Channels for a tier: the tier's own if it names any, otherwise the gate's. */
export function tierChannels(spec: DeliverySpec, tier: number): readonly string[] {
  if (tier === 0) return spec.channels;
  return spec.escalation?.[tier - 1]?.channels ?? spec.channels;
}

/** Recipients for a tier. Escalating means telling someone ELSE, not shouting louder. */
export function tierRecipients(spec: DeliverySpec, tier: number): readonly Recipient[] {
  if (tier === 0) return spec.recipients ?? [];
  return spec.escalation?.[tier - 1]?.to ?? spec.recipients ?? [];
}

/**
 * The next escalation tier and its new deadline, or `undefined` when exhausted.
 *
 * THE CLOCK RESETS on escalation. A tier that inherited the original deadline would
 * breach the instant it was reached, walking the whole chain in one sweep and paging
 * the director about something the on-call had not yet had a chance to see.
 */
export function nextTier(
  spec: DeliverySpec,
  currentTier: number,
  now: number,
): { readonly tier: number; readonly deadline: number } | undefined {
  const next = spec.escalation?.[currentTier];
  if (next === undefined || next.action === "fail") return undefined;
  return { tier: currentTier + 1, deadline: now + next.afterMs };
}

export function isChainExhausted(spec: DeliverySpec, currentTier: number): boolean {
  const next = spec.escalation?.[currentTier];
  return next === undefined || next.action === "fail";
}

/**
 * A recipient list, for a channel that wants one string — TOTAL, because both of its
 * callers are places where a throw costs a page nobody gets.
 *
 * `recipients.map((r) => `${r.kind}:${r.id}`)` was four reads of a value from outside with
 * nothing above them: the `map` lookup, the element, the two fields, and two ToString
 * coercions. Its two callers cost differently and BOTH cost more than a rendering:
 *
 *   - `ConsoleChannel.deliver`, THE FALLBACK. Measured: `delivered: 0, failed: 2,
 *     fellBack: false` — see that method's table;
 *   - `HumanGateBroker`'s escalation, which builds `gate.escalated{to}` from
 *     `tierRecipients(spec, tier)` — the COMPILED GRAPH'S OWN ARRAY, which no `owned*`
 *     helper has ever touched. A throw there lands in `sweepTimeouts`' per-gate `catch`,
 *     whose whole point is that one gate must not abort the sweep. So the throw is
 *     SWALLOWED and the gate never escalates — not once, but on every later sweep, since
 *     nothing about the gate has moved. Reproduced with one escalation tier whose recipient
 *     has a throwing `kind` getter: four sweeps over 3 000 s, `fired: 0` each time, journal
 *     `1:gate.raised 2:run.suspended 3:gate.delivered` and nothing after it, gate still at
 *     tier 0 on its original deadline. The on-call was told once; the manager is never told,
 *     and no row anywhere says why. **A silent permanent non-escalation is the worst outcome
 *     this subsystem has**, and it was reachable from a graph that compiled.
 *
 * WHAT THE STRING ASSERTS is "these are the parties this tier was told about, as the routing
 * list named them". Two consequences fix its shape:
 *
 *   - AN ENTRY IS NEVER DROPPED. Omitting one would say the list does not contain it, which
 *     is a false statement about routing and the same silence-read-as-a-claim the `?? []` on
 *     `approvers` was. Every own index gets a position in the output, readable or not.
 *   - A FIELD IT COULD NOT READ IS THE MARKER, not a gap and not `undefined`. `undefined` is
 *     what the old coercion produced for a missing field and it is a value NAME — a
 *     recipient whose `kind` is the string `"undefined"` rendered identically. `(…)` is
 *     parenthesised for `UNRENDERABLE`'s own reason: nothing a system names for itself may
 *     be mistakable for something a person or a graph named.
 *
 * THE LIMIT, STATED BECAUSE IT IS REAL: this reads through `readProp`, whose documented
 * conflation of "absent" with "unreadable" it inherits, so `(unrenderable)` in a field
 * position means only *the routing list does not name a usable string here*. Where that
 * difference matters it is made UPSTREAM AND IN THE OBJECT rather than in this line —
 * `ownedRecipients` marks a field it could not read and leaves an absent one absent, so a
 * channel routing on the recipient can tell them apart even though a human reading one line
 * cannot. A rendering may not claim a distinction its reads cannot support.
 *
 * The walk is over own INDEX names (`indexNames`) and not `map`: `length` on a proxy is a
 * trap that can answer 2³²−1, and `map` is itself a `[[Get]]` a proxy can throw from.
 * `isArrayValue` and not `Array.isArray`, because the bare call throws on a revoked proxy.
 */
export function formatRecipients(recipients: readonly Recipient[]): string {
  // A NON-LIST IS THE MARKER AND AN EMPTY LIST IS `""`, which `ConsoleChannel` renders
  // "anyone". The two are different facts and the test lives here, in the one place both
  // callers pass through, rather than in one caller where the other could not see it.
  if (!isArrayValue(recipients)) return UNRENDERABLE;
  const parts: string[] = [];
  for (const key of indexNames(recipients)) {
    const r = readProp(recipients, key);
    parts.push(`${shownText(readProp(r, "kind"))}:${shownText(readProp(r, "id"))}`);
  }
  return parts.join(", ");
}

/**
 * A value from outside as one bounded string, WITHOUT ASKING IT ANYTHING IT CAN REFUSE.
 *
 * `${v}` is a call — `Symbol.toPrimitive`, then `valueOf`, then `toString`, any of which a
 * value assembled elsewhere may throw from, and two of the reproductions in
 * `ConsoleChannel.deliver`'s table are exactly that. `typeof` invokes nothing (the same
 * property `boundedBytes` relies on in `sandbox/subprocess.ts`), and `String` over a
 * PRIMITIVE cannot throw, so the switch below is total by construction rather than by a try.
 *
 * Everything that is not a plain scalar — an object, a function, a symbol, a bigint, `null`,
 * `undefined`, a blank string, a non-finite number — is the marker. That is deliberately
 * wider than "it threw": a rendering that shows `[object Object]` where a role name belongs
 * has told a human something false about who was paged, and `String(Symbol())` throws
 * outright. Bounded to `MAX_ID` for `describeCause`'s reason — this string reaches a journal
 * payload through `gate.escalated{to}`, and an id nobody meant to be a kilobyte should not
 * become one.
 */
function shownText(v: unknown): string {
  switch (typeof v) {
    case "string":
      return v === "" ? UNRENDERABLE : v.slice(0, MAX_ID);
    case "number":
      return Number.isFinite(v) ? String(v) : UNRENDERABLE;
    case "boolean":
      return String(v);
    default:
      return UNRENDERABLE;
  }
}

export function gateDeliveryError(gateId: GateId, reason: string): LoomError {
  return err.unavailable(CODES.E_GATE_DELIVERY_FAILED, `gate "${gateId}" was not delivered: ${reason}`);
}
