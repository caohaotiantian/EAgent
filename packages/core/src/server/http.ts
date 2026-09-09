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
 * ## WHAT `auth` DECIDES, AND THE ONE GAP LEFT IN IT
 *
 * Four things: admission (401 before routing, so an unauthenticated caller cannot discover
 * which routes exist); who a gate decision is recorded as and whether the approvers list
 * allows it; which idempotency slot a write lands in; and WHICH RUNS THE CALLER REACHES.
 *
 * That fourth one used to be the limit this section was named for — every valid credential
 * was a full operator credential — and it is closed. A run is owned by the principal that
 * submitted it, and two predicates govern the routes:
 *
 *   - `ownsRun` — owner, unowned, or operator — for `GET /runs`, `GET /runs/:id`,
 *     `GET /runs/:id/events`, `POST /runs/:id/commands` and `POST /runs/:id/oversight`;
 *   - `mayReachGates` — that, OR named on one of this run's gates — for the two routes that
 *     carry gates, and only those.
 *
 * **THE GAP BETWEEN THEM IS THE POINT.** Under `approval.separationOfDuties` the only
 * principal permitted to decide is by construction NOT the submitter, so scoping the gate
 * routes by owner would make every gate they guard unanswerable — supervision that looks
 * configured and cannot be exercised. The converse holds too: being named an approver is a
 * grant to answer one question, not a key to somebody's run, so it widens neither `GET
 * /runs/:id` nor the command route.
 *
 * **404, NEVER 403.** "Not yours" and "no such run" must be indistinguishable or the
 * refusal tells a stranger which ids are real. `GET /runs/:id/events` had no existence
 * check at all — it read a head of 0 and wrote a 200 — so scoping it without adding one
 * would have built a clean oracle rather than closing one.
 *
 * **A RUN NOBODY OWNS IS READABLE BY EVERY CREDENTIAL**, and "nobody" includes a SYNTHETIC
 * owner: `(shared-token)` and `(unidentified)` say what this perimeter concluded rather than
 * naming a person. That set is every journal written before ownership existed and every run
 * started without a principal, so an upgrade loses nothing and the permissive set only
 * shrinks. `ownedByNobody` is the one place that rule is spelled.
 *
 * **THE ESCAPE IS `AuthContext.operator`**, declared on an identity entry and validated as a
 * field that DECIDES — refused when malformed at all three doors rather than dropped,
 * because whether a deployment has an operator must not depend on whether a typo was truthy.
 * The shared token is an operator only when it is the SOLE credential: alone, every caller is
 * that principal and scoping is vacuous either way; alongside an identity source it is one
 * principal among several, and `#principal` falls back to it, so granting it unconditionally
 * would hand every service a full read of every human's runs.
 *
 * **AND `GET /gates` EXISTS BECAUSE OF ALL OF THIS.** `GET /runs` answers from the owner
 * column with no fold, which is what keeps a polling console cheap — and it means an approver
 * who is not the submitter cannot find the run their question lives on. The cross-run queue
 * returns the questions ADDRESSED to the caller, with the rendered payload, since `GET
 * /runs/:id` is closed to them and this is therefore the only place the question can reach
 * the person being asked. A stranger's queue excludes an unrestricted gate: answerable by
 * whoever reaches it must not mean published to everyone.
 *
 * ## WHAT IS STILL NOT SCOPED
 *
 * Gate payloads reaching a caller admitted by `mayReachGates` are redacted per the GRAPH's
 * declared classification, never per viewer. A named approver sees the questions addressed
 * to them and the ones addressed to nobody, filtered per gate — but within a gate the
 * redaction is the graph's, so two approvers on one gate see the same bytes.
 *
 * **THAT PARAGRAPH WAS A PROMISE NOTHING KEPT, FOR AS LONG AS IT HAS BEEN WRITTEN HERE.**
 * `redactPayload` was called on the event stream and on a projection's channels and outputs,
 * and at NEITHER gate route: `GET /runs/:id/gates` and `GET /gates` each joined the broker's
 * rendered payload straight onto the wire. Measured over real HTTP, one run, a channel
 * declared `secret_ref` and read by a `human_gate` node — before, on both routes:
 *
 *     payload.state = {"apiKey":"sk-live-DO-NOT-DISCLOSE","note":"ordinary note", …}
 *     payload.state = {"apiKey":"[secret]",              "note":"ordinary note", …}
 *
 * `gateWire` is what makes the paragraph true, and it is ONE function because there were two
 * routes building the same object two ways — the drift that produced this bug one layer up,
 * where `listRuns` was filtered at two of three sites. Read `redactGatePayload` for which
 * payload shapes the claim covers and where an absent graph falls closed.
 *
 * **AND "REDACTED PER THE GRAPH'S DECLARED CLASSIFICATION" WAS NOT TRUE OF THE OTHER SIX
 * ROUTES EITHER.** Fixing the two gate routes left every route that answers with a PROJECTION
 * or with a JOURNAL EVENT sweeping at a blanket `internal`, which is the detector backstop
 * alone: it catches a credential SHAPE and knows nothing about what the graph declared. So a
 * `secret_ref` channel whose value is ordinary prose — a passphrase, a seed phrase, an
 * internal URL — went out in full. Measured over real HTTP on one run, `vaultHint` declared
 * `secret_ref` and `owner` declared `pii`:
 *
 *     GET /runs/:id           "channels":{…,"owner":"ada@example.com","vaultHint":"the vault …"}
 *     GET /runs/:id/events    snapshot frame: the same object
 *     GET /runs/:id/events    event frame, run.submitted: "inputs":{…,"vaultHint":"the vault …"}
 *
 * Both frame kinds on the SSE stream, and the four other projection routes with them. The
 * event stream had the extra trap: `frame` redacted at `e.classification`, which READS like a
 * lookup and is `internal` on every event this runtime has ever written, because nothing
 * populates the field. `summarise` and `frame` now take the graph and reach the SAME
 * `redactChannels` the gate routes reach; `#summary` is the one place the pairing lives,
 * `CHANNEL_KEYED` names the five journal payload keys that are channel MAPS, and
 * `CHANNEL_VALUED` names the one that is a `{channel, value}` PAIR. The second table exists
 * because the first one's derivation — a grep for `Record<string, unknown>` — structurally
 * could not see a pair, so a fan-out's per-branch item went out in the clear for a wave after
 * the rest was closed. Read `CHANNEL_VALUED` for the re-derivation and its three legs.
 *
 * **AND A PROJECTION CARRIES CHANNEL DATA IN ITS `gates` SLICE TOO.** `GateRecord.writes` is
 * an approver's `edit` — the channels a human rewrote, the same map `gate.decided.writes`
 * carries on the stream — and `summarise` sent the gate records raw, so on all six of those
 * routes the value came back in the SAME body whose `channels` two keys above already read
 * `[secret]`. `gateRecordWire` closes it, and `gateWire`'s `{...g}` spread with it.
 *
 * **AND THE GRAPH ROUTES ARE OPEN TO EVERY CREDENTIAL ON PURPOSE.** `GET /graphs` and
 * `GET /graphs/by-hash/:hash` take `auth` for admission and apply no access predicate, so a
 * scoped non-operator whose `GET /runs` is empty still reads every workflow name, every graph
 * hash, and — from `by-hash` — every node id, every node type and every node's compiled
 * `posture`. That is deliberate, and it is written here because this section makes an
 * ENUMERATED claim and the enumeration used to be short by exactly these two routes: a reader
 * finished it believing ownership scoping covered every route but gate payloads.
 *
 * The argument for leaving them open, measured rather than asserted: a graph HAS NO OWNER to
 * scope by — `#graphByHash` scans `this.#graphs`, the constructor-supplied deployment
 * inventory, and never reaches the store, so no principal's graph can leak through it — and
 * `POST /runs` applies no per-workflow predicate, so a non-operator who can read the
 * inventory can already SUBMIT every workflow in it. Knowing a name is not a privilege when
 * invoking it is already granted. Scoping them would also break the console's `loadGraphs`
 * for any principal with no runs, which is every new operator, and would build the
 * hash-existence oracle the "404, NEVER 403" rule exists to forbid. If `POST /runs` ever
 * grows a per-workflow predicate, this paragraph is the first thing that stops being true.
 * Pinned by *EVERY CREDENTIAL READS THE GRAPH INVENTORY* in
 * `test/server/plane-watch-and-stop.test.ts`.
 *
 * **AND `POST /runs`'s DECLARED-INPUTS REFUSAL IS THE THIRD ROUTE, added knowingly.** Since the
 * change `TODO.md` §A0.17 asks for, a body naming a channel the graph does not declare comes back
 * 400 with the graph's whole declared input SET in the message — which is more than either
 * graph route hands out: `GET /graphs` returns `{name, graphHash, nodes: count, edges: count}`
 * and `by-hash` returns layout `{id, type}` plus `{layoutRank, maxInstances, posture}`, and
 * neither carries a channel name. So the enumeration above was short by one line the day that
 * check landed, which is the exact defect the previous paragraph exists to prevent, and this is
 * the line. The argument for it is the previous paragraph's own: a credential that receives
 * this message could already SUBMIT the workflow, and a channel name it must supply to submit
 * successfully is not a privilege withheld from it. The "404, NEVER 403" rule is untouched —
 * the check runs AFTER `graphIn`'s 404, so an unknown graph is still 404 and no input set is
 * named. If `POST /runs` ever grows a per-workflow predicate, this refusal has to move behind
 * it, because at that moment the set stops being something the caller could get any other way.
 *
 * ## AND THE CALLER MAY BE A BROWSER SOMEBODY ELSE IS DRIVING
 *
 * Everything above reasons about who can reach the socket. On the supported open posture
 * the answer is "the operator", and the operator runs a browser — which any web page they
 * visit can aim at `127.0.0.1` on their behalf. That omission is what made an open plane
 * shippable: `POST /runs` with `content-type: text/plain` is a CORS-SIMPLE request, so it
 * takes no preflight, and an HTML form with `enctype="text/plain"` reaches the same place
 * with no JavaScript at all — as a NAVIGATION, which is outside Chrome's Private Network
 * Access restrictions and implemented by nobody else. Reproduced end to end: a run
 * submitted, driven to its gate, and the gate APPROVED, with the journal recording
 * `gate.decided actor {"kind":"human","via":"api"}` for a decision made by a page.
 *
 * So three guards stand in front of routing, in `crossSite` and `#refusedHost` and
 * `#readBody`, and each covers a case the others cannot: `Sec-Fetch-Site` sees the
 * navigation that carries no CORS semantics, `Origin` covers the browser too old to send
 * it, and the Host allowlist covers DNS rebinding — after which the attacker's page
 * genuinely IS this origin and no origin check can tell. ABSENCE PASSES in the first two,
 * because curl, the CLI and every webhook sender send neither header, and a guard that
 * refuses on absence is a browser-only API rather than a perimeter.
 *
 * The blast radius they close is exactly `openToEveryCaller`. A tokened plane was already
 * immune — a cross-origin page cannot set `Authorization` without a preflight, and there
 * are no CORS response headers here to grant one — but "already immune" is a property of a
 * posture, and the open one is documented, supported, and what `loom serve` gives an
 * operator who omits `--token`.
 *
 */

import { constants as BUFFER } from "node:buffer";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import { SubscriberOverflowError, type EventBus } from "../bus.ts";
import { canonicalize } from "../canonical.ts";
import { httpStatusFor, isLoomError, toLoomError, CODES, err } from "../errors.ts";
import type { EdgeId, GateId, NodeId, RunId, Seq } from "../ids.ts";
import { SYSTEM_ACTOR, type HumanActor, type JournalEvent, type SubmittedBy } from "../journal/events.ts";
import type { RunSummary, StateStore } from "../journal/store.ts";
import type { RunGraph } from "../graph/spec.ts";
import { undeclaredInputsMessage } from "../graph/declared-inputs.ts";
import type { CommandActor, Engine } from "../run/engine.ts";
import { GateCallbackRouter, type CallbackEngine, type GateDispatcher } from "../run/delivery.ts";
import { gateDecisionOf, isSyntheticSubject, maxClassification, POSTURES, type Classification, type GateDecision, type Posture } from "../vocab.ts";
import type { GateSummary } from "../run/gates.ts";
import { gateOf, type GateRecord, type RunProjection } from "../run/projection.ts";
import { RunLog } from "../run/log.ts";
import { redactPayload } from "../security/redact.ts";
import { OTLP_RUN_ID_ATTR, OTLP_TRUNCATED_ATTR, spansFrom } from "../telemetry/spans.ts";
import { otlpTraceRequest } from "../telemetry/otlp.ts";
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
 * `subject` DECIDES TWO THINGS and describes the rest: whether a gate's approvers list admits
 * this caller, and which runs the caller reaches — see "WHAT `auth` DECIDES" in the module
 * docstring. Everywhere else it lands — the run's recorded submitter, the actor on a cancel —
 * it is audit, saying who acted rather than what they may touch.
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
  /**
   * Whether this credential may reach runs it does not own.
   *
   * THE ONE FIELD HERE THAT GRANTS. `subject` decides one thing — whether a gate's approvers
   * list admits this caller — and everything else on this record describes. This one widens
   * READ scope across the whole journal, so it joins `subject` and `kind` in the class of
   * fields `checkedAuth` REFUSES when malformed rather than dropping.
   *
   * An injected `IdentitySource` may set it. That is a deliberate trust position, not an
   * oversight: the source is the deployment's own code and it already supplies `subject`,
   * which decides whether a person may approve an irreversible action — a strictly larger
   * grant than reading. What a source still may not do is claim a synthetic subject.
   */
  readonly operator?: boolean;
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
  /**
   * How many of those principals hold an OPERATOR credential, if it knows.
   *
   * Advisory in exactly the way `principals` is, and for the same one consumer: the boot
   * warning. An operator credential reads every run in the journal, so a deployment is told
   * how many of those it has issued — and, when it has issued NONE while configuring several
   * principals, told that too, because "nobody can see anyone else's run, ever, including the
   * person debugging this" is a configuration the plane can detect and its operator cannot.
   *
   * A source that cannot say leaves it undefined, and the warning says the count is UNKNOWN
   * rather than asserting one. That is the honest reading and it is deliberately not the
   * loud-by-default treatment `principals` gets: an undeclared `principals` is assumed to be
   * many because a source exists to tell callers apart, whereas assuming many OPERATORS would
   * shout at every deployment that implements this interface.
   */
  readonly operators?: number;
  identify(req: IdentityRequest): Promise<AuthContext | undefined> | AuthContext | undefined;
  /**
   * Every subject this source could ever establish, if it can say.
   *
   * ADVISORY, and used for exactly one thing: `gateAnswerability` asks it whether a gate's
   * `approvers` list names anybody this deployment can produce, so `loom serve` can say at
   * boot that a graph names an approver no credential here will ever be. It GRANTS NOTHING
   * and REFUSES NOTHING; `#authorize` still decides, by comparing `Actor.subject` against
   * the list, and still throws `E_GATE_NOT_AUTHORIZED` for anyone not on it.
   *
   * **`undefined` MEANS "THIS SOURCE CANNOT ENUMERATE", AND IT MUST NEVER BE COLLAPSED WITH
   * AN EMPTY ARRAY.** An OIDC or mTLS source legitimately cannot list its population, and
   * the honest report for it is "not checked" — an empty array would say "this source can
   * authenticate nobody", which is a different fact and would make every named approver look
   * unreachable. Not implementing the method at all means the same thing as returning
   * `undefined`, which is why it is optional: an existing source keeps working and gets the
   * NOT CHECKED line rather than a wrong clean bill.
   *
   * It must never become a refusal either. Refusing to boot on "I cannot tell" would make
   * every non-enumerable source unbootable, and that is a guard turning an unknown into a
   * decision — the opposite direction from the one this project's rules ask for, because it
   * would DELETE a legitimate deployment rather than tighten one.
   *
   * **THROWING IS NOT CAUGHT, and the process does not boot.** That is deliberate and it is
   * the one place this method is allowed to stop anything: a source whose own directory
   * errored has not said "I cannot enumerate", it has failed, and a `catch {}` here could
   * not tell the two apart — it would report the failure as the answer `undefined`, which is
   * this codebase's named defect. `identify` makes the same distinction one method over:
   * `undefined` establishes nobody, throwing refuses.
   */
  knownSubjects?(): readonly string[] | undefined;
}

export interface BearerSubject {
  readonly token: string;
  readonly subject: string;
  /** Default `human`. A `service` entry is a named machine, not a person. */
  readonly kind?: AuthContext["kind"];
  readonly via?: HumanActor["via"];
  readonly mfa?: boolean;
  /**
   * Whether this credential may read every run, not only its own.
   *
   * Default `false`, and the default is the SAFE one — which is why a malformed value is
   * refused rather than dropped even though dropping would also fail closed: a field that
   * GRANTS must never be decided by whether a typo happened to be truthy.
   */
  readonly operator?: boolean;
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
  readonly operators: number;
  readonly #bySha = new Map<string, AuthContext>();
  /** Distinct subjects, sorted, so the boot report reads the same on every boot. */
  readonly #subjects: readonly string[];

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
      const operator = s.operator;
      if (token === "") throw err.validation(CODES.E_CONFIG_INVALID, `identity source "${this.name}": subject "${subject}" has an empty token`);
      if (subject === "") throw err.validation(CODES.E_CONFIG_INVALID, `identity source "${this.name}": a token maps to an empty subject`);
      // THE SAME TWO CHECKS `checkedAuth` MAKES, made here as well, by the rule the `kind`
      // refusal below states: a guard remembered in one caller is a guard the next caller
      // will not have. Without them a subject this seam cannot later accept constructs
      // fine and then throws `E_CONFIG_INVALID` as a 500 on EVERY request that principal
      // makes — fail-closed, but diagnosed at 3 a.m. instead of at boot, which is exactly
      // what the three-door rule exists to prevent.
      if (subject.length > MAX_IDENTITY_FIELD) {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `identity source "${this.name}": subject of ${subject.length} characters (the limit is ${MAX_IDENTITY_FIELD})`,
        );
      }
      if (isSyntheticSubject(subject) || SYNTHETIC_SUBJECTS.includes(subject)) {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `identity source "${this.name}": "${subject}" is a synthetic marker, not a subject — a parenthesised subject is what the ` +
            `control plane writes when it could not identify a caller, and no source may claim one.`,
        );
      }
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
      // REFUSED HERE TOO, by the paragraph above's own rule. This field grants read access to
      // every run in the journal, and `readIdentities` parses it out of a JSON file — where a
      // `"operator": "true"` is a plausible typo. Dropping a bad value would fail closed, and
      // that is precisely why the refusal is easy to argue away and still wrong: a deployment
      // would silently have no operators and learn it by finding that nobody can see anything.
      if (operator !== undefined && typeof operator !== "boolean") {
        throw err.validation(
          CODES.E_CONFIG_INVALID,
          `identity source "${this.name}": subject "${subject}" declares operator ${JSON.stringify(operator)}, which is neither true nor ` +
            `false. It is not dropped, because it grants read access to every run in the journal and a field that grants must not be ` +
            `decided by whether a typo was truthy.`,
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
        ...(operator === true ? { operator: true } : {}),
      });
    }
    // KEPT, not just counted. `knownSubjects` needs the members and this is the one place
    // they are all in hand; re-deriving them from `#bySha` would work today and would break
    // the moment two tokens map to one subject, which this class explicitly allows.
    this.#subjects = [...subjects].sort();
    this.principals = subjects.size;
    // Countable here, which is why the advisory field exists: this source knows exactly how
    // many operator credentials it issued, and the boot warning can say so instead of saying
    // "unknown" the way it must for an injected source.
    this.operators = opts.subjects.filter((x) => x.operator === true).length;
  }

  identify(req: IdentityRequest): AuthContext | undefined {
    const header = req.headers["authorization"] ?? "";
    if (!header.startsWith("Bearer ")) return undefined;
    return this.#bySha.get(sha256(header.slice(7)));
  }

  /**
   * THIS SOURCE CAN ENUMERATE, and it is the only one in the tree that can.
   *
   * Its whole population is the file the operator wrote, so "is `u:nobody` a subject here"
   * is a question with an answer — which is what makes the boot report say something rather
   * than shrug. An EMPTY array is a truthful answer for `new BearerTokenIdentity({subjects:
   * []})`: that source really can authenticate nobody, and every approver a graph names is
   * really unreachable through it.
   */
  knownSubjects(): readonly string[] {
    return this.#subjects;
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
  // A FIELD THAT GRANTS JOINS THE DECIDING CLASS. `operator` widens read scope over every
  // run in the journal, so a value that is neither `true`, `false` nor absent is refused the
  // way a third `kind` is — not dropped. Dropping would fail closed here, which is exactly
  // what makes the refusal easy to argue away and wrong anyway: a deployment whose source
  // returns `"true"` would silently have no operators, and would find out by discovering
  // nobody can see anything.
  const operator: unknown = readField("operator");
  if (operator !== undefined && typeof operator !== "boolean") {
    refuse(
      `operator of type ${operator === null ? "null" : typeof operator}, which is neither true nor false. ` +
        `It grants read access to every run in the journal, so it is refused rather than dropped`,
    );
  }

  const method: unknown = readField("method");
  const via: unknown = readField("via");
  const mfa: unknown = readField("mfa");
  const onBehalfOf: unknown = readField("onBehalfOf");
  return {
    kind,
    subject,
    ...(operator === true ? { operator: true } : {}),
    method: typeof method === "string" && method !== "" ? method.slice(0, MAX_IDENTITY_FIELD) : source,
    ...(isVia(via) ? { via } : {}),
    ...(typeof mfa === "boolean" ? { mfa } : {}),
    ...(typeof onBehalfOf === "string" && onBehalfOf !== "" && onBehalfOf.length <= MAX_IDENTITY_FIELD ? { onBehalfOf } : {}),
  };
}

/**
 * The principal a run is journaled as having been submitted for.
 *
 * A narrowing, not a rename: `AuthContext` also carries `via`, `mfa` and `onBehalfOf`, which
 * describe the REQUEST. `SubmittedBy` names the principal and is compared against approvers
 * lists and matched against a run's owner, so it carries only what identifies.
 *
 * A synthetic subject is passed through rather than dropped. `(shared-token)` and
 * `(unidentified)` are true statements about what the perimeter concluded, and a run owned by
 * "the shared credential" is a different fact from a run owned by nobody — which is what an
 * absent `submittedBy` means. Conflating them would make an upgrade look like a wipe.
 */
/**
 * `auth` on a route that cannot be reached without a credential.
 *
 * Not a check that is expected to fire — `#serve` 401s first, and an open plane mints
 * `(unidentified)` rather than nothing. It exists so that the impossible case is a loud 500
 * naming this file, instead of a quiet fallback to "no principal", which is the permissive
 * value everywhere it is read.
 */
function mustAuth(auth: AuthContext | undefined): AuthContext {
  if (auth === undefined) {
    throw err.internal(CODES.E_INTERNAL, "a guarded route was reached with no principal; #serve should have answered 401");
  }
  return auth;
}

/**
 * Who a run belongs to — THREE answers, because two of them must not be the same one.
 *
 * `nobody` is permissive and `unreadable` is not, and conflating them is the failure this
 * codebase has already named twice: *"an empty approvers list is the permissive case, so
 * 'named nobody' and 'could not read who it names' must never produce the same value."*
 * A journal is an input — an embedder can append anything, and a corrupt row is a real
 * shape — so a `submittedBy` whose subject is not a non-empty string is refused rather than
 * read as "unowned", which would make a malformed row world-readable.
 *
 * A SYNTHETIC SUBJECT IS A REAL OWNER, and an earlier version of this got it backwards.
 * `(shared-token)` and `(unidentified)` describe what the perimeter concluded rather than
 * naming a person, which made "treat them as nobody" look right — and on a MIXED plane it is
 * an escalation: every run the CI service submits with the shared token becomes readable and
 * **cancellable** by every human credential. Measured before the fix, on exactly the
 * arrangement this file documents as supported. Reading them as owners costs nothing where
 * they are minted, because there the whole deployment presents the same marker: on an open
 * plane every caller IS `(unidentified)`, and a sole shared token is an operator anyway. What
 * it costs is the upgrade — a plane that was open, then given identities, keeps those runs
 * for its operators only — and that is the right side to be wrong on, because the alternative
 * is a live cross-principal write.
 *
 * Runs with NO recorded principal keep the permissive rule they were promised: every journal
 * written before ownership existed is in that set, and it only ever shrinks.
 */
type Owner =
  | { readonly kind: "nobody" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "subject"; readonly subject: string };

function ownerOf(p: RunProjection): Owner {
  const by: unknown = p.submittedBy;
  if (by === undefined || by === null) return { kind: "nobody" };
  // Total reads: the type says `SubmittedBy`, and the value came out of a fold over a journal.
  const subject: unknown = typeof by === "object" ? (by as Record<string, unknown>)["subject"] : undefined;
  if (typeof subject !== "string" || subject === "") return { kind: "unreadable" };
  return { kind: "subject", subject };
}

/**
 * Whether this credential may reach THE RUN — its projection, its stream, its commands.
 *
 * Owner, unowned, or operator, and nothing else. Being named an approver on one of the run's
 * gates deliberately does NOT appear here: that is a grant to answer one question, not a key
 * to somebody's work, and the question is rendered server-side precisely so the approver needs
 * no other context to answer it. See `mayReachGates`, which is the wider rule and is confined
 * to the two routes that carry gates.
 */
function ownsRun(p: RunProjection, auth: AuthContext): boolean {
  if (auth.operator === true) return true;
  const owner = ownerOf(p);
  // `unreadable` falls through to `false`: an owner nobody can read is not an owner nobody
  // HAS, and only an operator gets past it.
  return owner.kind === "nobody" || (owner.kind === "subject" && owner.subject === auth.subject);
}

/**
 * Whether this credential may reach THE RUN'S GATES.
 *
 * `ownsRun`, OR named on one of them — and that second term is what keeps ownership from
 * breaking the thing ownership exists to protect. Under separation of duties the only
 * principal allowed to decide is by construction not the submitter, so a rule without it
 * would make every gate it guards unanswerable: supervision that looks configured and cannot
 * be exercised.
 *
 * NAMED, never "not excluded". A gate that names nobody is answerable by whoever reaches it,
 * and the dominant gate class — a posture-floor gate on a tool node — names nobody by
 * construction, so reading that as "visible to everybody" would hand every principal the
 * channel values in that gate's rendered payload. The test is therefore an explicit `some`
 * over gates that name the caller: a run with NO gates admits nobody through this term, where
 * an `every`-shaped predicate would be vacuously true and turn the route into a run-existence
 * oracle.
 */
function mayReachGates(p: RunProjection, auth: AuthContext): boolean {
  if (ownsRun(p, auth)) return true;
  // ANY STATE, not only `open`, and that is deliberate rather than an oversight. Restricting
  // it to open gates was tried and it turns a second approver's 409 into a 404: two people
  // are named, one decides, and the other — arriving a second later — is told the run does
  // not exist instead of that the question is already answered. Hiding a real conflict behind
  // "no such run" is worse than the access it saves, and the access it saves is small:
  // `visible()` bounds what such a caller can then SEE to the questions naming them, so what
  // an approver keeps after deciding is a view of the question they themselves answered.
  return Object.values(p.gates).some((g) => namesApprover(g, auth.subject));
}

/**
 * Whether this gate NAMES this subject — a total read of a journal-folded list.
 *
 * `approvers` is copied raw out of `gate.raised` by the fold, so its runtime shape is
 * whatever was appended. `Array.prototype.includes` on a STRING silently substring-matches,
 * which would admit `u:alice` to a gate naming `u:alice-contractor`, and on a number it
 * throws. Neither belongs in an authorization test.
 */
function namesApprover(g: GateRecord, subject: string): boolean {
  const approvers: unknown = g.approvers;
  return Array.isArray(approvers) && approvers.some((a) => a === subject);
}

/**
 * How many gates one queue answer may carry, and how far back it may look for them.
 *
 * Both are ceilings this file chooses, unlike `pageLimit`, which deliberately imposes none
 * because "inventing a maximum page size here would be a decision the store's interface
 * should make". That argument holds for a listing the store can answer from an index; it does
 * not hold for a route that FOLDS every candidate run, where an unbounded page is an
 * amplifier available to the lowest-privilege credential the deployment issues.
 *
 * The scan bound is the honest half: a question older than `MAX_QUEUE_SCAN` runs is not in
 * the answer, and the answer says so rather than pretending to be complete.
 */
const MAX_QUEUE_GATES = 200;
const MAX_QUEUE_SCAN = 500;
/**
 * How many gated runs `#armGatedRuns` may READ at boot, as against how many it may ARM.
 *
 * Two numbers because the scan pages now, and the thing worth bounding is not the thing
 * worth stopping on. `MAX_QUEUE_SCAN` bounds the runs armed — each costs a `RunContext` and
 * a rehydrated gate clock for the life of the run. This bounds the rows walked to find them,
 * because `raisedAGate` is "has EVER raised one" and the cost of rejecting one is a FOLD of
 * its whole journal. Without it, "page until 500 open gates are armed" on a journal with a
 * million decided gates is a `listen()` that never returns.
 *
 * IT IS THE BOUND THAT MAY BE HIT WITHOUT LOSING AN ANSWER, which is why it is allowed to be
 * a guess. A gate past it is bound by `#callbackEngine` when its decision arrives and by
 * `loom serve`'s gate clock on the next tick; what it delays is escalation on a plane where
 * neither has happened yet.
 */
const MAX_ARM_SCAN = 5_000;

function principalOf(auth: AuthContext): SubmittedBy {
  return { kind: auth.kind, subject: auth.subject, method: auth.method };
}

/**
 * The actor an operator command is journaled under — the ENVELOPE, not a payload field.
 *
 * A cancel is caused by its caller directly, so the event's own `actor` is the honest home;
 * `run.submitted` is the other way round and puts its principal in the payload. Three cases:
 *
 *   - **a person** ⇒ the human actor, carrying whatever the source vouched for. This is the
 *     whole point: "who cancelled this run" stops being "the software did";
 *   - **a named service** ⇒ `system:principal:<subject>`. `Actor` has no service arm, and a
 *     named service principal IS a system component in its vocabulary. The `principal:`
 *     prefix cannot collide with a built-in component name, and `GATE_SYSTEM_ACTORS` holds no
 *     `principal:*`, so this grants nothing anywhere;
 *   - **nobody identified** — an open plane, or the shared credential — ⇒
 *     `system:operator`, exactly what this path journaled before. A marker describes what the
 *     perimeter concluded rather than naming anyone, so `principal:(shared-token)` would
 *     claim a principal by that name. "An operator did it" is the most that can be said.
 *
 * IT DECIDES WHO THE CALLER IS, NOT WHAT THEY MAY DO, and the two non-human arms are refused
 * outright by two of the six verbs on `/runs/:id/commands` — `steer` and `rewind`, each in the
 * engine and each for its own reason. This function stays the one place the perimeter's answer
 * is computed; the floor lives with the verb that needs it, so a caller cannot get a different
 * answer by arriving through the library instead.
 */
function commandActor(auth: AuthContext | undefined): CommandActor {
  if (auth === undefined) return SYSTEM_ACTOR("operator");
  if (isSyntheticSubject(auth.subject) || SYNTHETIC_SUBJECTS.includes(auth.subject)) return SYSTEM_ACTOR("operator");
  if (auth.kind !== "human") return SYSTEM_ACTOR(`principal:${auth.subject}`);
  return {
    kind: "human",
    subject: auth.subject,
    via: auth.via ?? "api",
    ...(auth.mfa === undefined ? {} : { mfa: auth.mfa }),
    ...(auth.onBehalfOf === undefined ? {} : { onBehalfOf: auth.onBehalfOf }),
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
/**
 * The decision half of a gate's default idempotency key, with the caller's own malformed body
 * reported as the caller's.
 *
 * `canonicalize` is what makes one decision one key however its sender spelled it, and it
 * refuses what it cannot order — a `CanonicalizationError`, which is not a `LoomError`, so the
 * route reported a caller's `1e999` as `E_INTERNAL` and 500.
 */
function gateDecisionSlot(decision: unknown): string {
  try {
    return canonicalize(decision);
  } catch (e) {
    throw err.validation(CODES.E_RESOURCE_INVALID, `gate decision cannot be recorded: ${(e as Error).message}`);
  }
}

function idempotencySlot(auth: AuthContext | SubmittedBy | undefined, key: string): string {
  return JSON.stringify([auth?.method ?? "", auth?.kind ?? "", auth?.subject ?? "", key]);
}

/**
 * The 202 body — what is durable at ACK, in ONE place.
 *
 * TWO WRITERS, ONE SHAPE: the handler that accepts a submission and `#restoreIdempotency`,
 * which rebuilds the same answer for a run this process did not accept. A retry that crossed
 * a restart must be handed the body the original request got, and two copies of an object
 * literal is how those two drift.
 */
function acceptedBody(runId: RunId, graphHash: string): Record<string, unknown> {
  return { runId, graphHash, durable: ["run.submitted", "run.compiled"], note: "accepted means this WILL run, not that it HAS run" };
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
  /**
   * Graphs this plane may ATTACH but will never SUBMIT — the subgraphs its own runs delegate to.
   *
   * A `subgraph` node makes `Engine` mint a delegated run of its own, and that CHILD compiles the
   * subgraph resource: a spec that lives under `resources/`, never in `graphs/`. So a gate raised
   * inside a subgraph was listed by `GET /gates`, rendered with approve and reject buttons by the
   * console, and answerable by nothing — `#bindFromIndex` searched `graphs` for a hash that was
   * not in it, returned silently, and `resolveGate` answered 404 `E_RUN_NOT_FOUND "… is not
   * attached"`. Measured over a real socket after a restart, with `loom approve --graph <the
   * subgraph file>` succeeding on the same gate one command later: the operator had to hand-name
   * a file the ENGINE chose.
   *
   * A SECOND FIELD RATHER THAN MORE ENTRIES IN `graphs`, because `graphs` is three things at
   * once: the attach index, the inventory `GET /graphs` publishes, and the set `POST /runs`
   * accepts by name. A subgraph is a component of a workflow and not a workflow, so widening that
   * field would let a caller submit a leaf directly and would put every internal step in the
   * console's workflow list. `#graphByHash` is the only reader, which also means a child run's
   * channel values are redacted by the graph THAT run compiled rather than by `undefined`.
   */
  readonly subgraphs?: readonly RunGraph[];
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
  /**
   * The `Host` values this plane answers to — the DNS-rebinding guard.
   *
   * ABSENT derives it from the address actually bound, which is what a loopback
   * deployment wants and cannot state ahead of time: `listen(0)` does not know its port
   * until the socket exists. On a LOOPBACK bind the derived set is the bound address plus
   * `localhost`, `127.0.0.1` and `[::1]`, with and without the port. On any other bind
   * there is no derived set at all — the plane is directly routable, so rebinding buys an
   * attacker nothing it did not already have, and this file cannot know the name a proxy
   * or a service mesh will put in front of it.
   *
   * This is the one guard an `Origin` check cannot stand in for. After a rebind the
   * attacker's page IS this server's origin, by construction; what it is not is a name
   * this deployment answers to.
   *
   * A LIST REPLACES the derived set rather than adding to it — it is the whole answer, so
   * a deployment behind a proxy names the proxy's host and nothing else. The literal
   * `"*"` turns the check off, for a proxy that rewrites `Host` on the way through. The
   * EMPTY LIST is refused at construction: it is a plane no caller can reach, spelled
   * like a policy, and it is the same one-character deployment slip as an empty token.
   */
  readonly allowedHosts?: readonly string[];
  /**
   * WHERE A FRESHLY-ACCEPTED RUN IS HANDED OFF, instead of `void engine.advance(runId)`.
   *
   * The 202 handler drove every accepted run itself, immediately, with nothing bounding how
   * many of those ran at once. Measured: 60 submissions driven the way this handler drives
   * them produced **60 concurrent provider calls**, and the only money ceiling on the box was
   * whatever each graph happened to declare.
   *
   * IT IS NOT ADMISSION CONTROL AND MUST NEVER BECOME IT. This plane still answers 202
   * unconditionally — the body says "accepted means this WILL run" and that promise is
   * unchanged — and a `drive` that is full is expected to do NOTHING rather than to refuse.
   * The deployment's run clock re-derives the run from the journal and offers it again, which
   * is why the queue can be a scheduling hint whose loss is safe: it is not a data structure,
   * it is the journal.
   *
   * ABSENT KEEPS TODAY'S BEHAVIOUR — an unbounded `advance` per submission — so a library
   * embedder of `ControlPlane` sees no change. That default is the WIDER of the two, which is
   * the wrong direction for a ceiling and is a deliberate compatibility choice rather than an
   * oversight: this option bounds a resource, it grants no permission, and an embedder driving
   * their own runs unbounded is what they were already doing.
   */
  readonly drive?: (runId: RunId) => void;
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
 * Distinct `Idempotency-Key` values one process remembers.
 *
 * Read as a duration, not a size: entries land only on a successful submit, so this is
 * `MAX_IDEMPOTENT_SUBMITS ÷ submissions per minute` — about 17 HOURS at ten runs a minute, about an
 * hour at 170. REVERSE IT upward if a deployment submits faster than its clients retry.
 *
 * It bounds ENTRIES rather than bytes, and the key is caller-influenced: `idempotencySlot`
 * includes the raw header, which `node:http` bounds only by its own header limit. So the memory
 * this caps is a multiple of that limit, not of a small constant.
 */
const MAX_IDEMPOTENT_SUBMITS = 10_000;

/**
 * How many runs `#restoreIdempotency` may READ to find them, as against how many it may
 * restore.
 *
 * TWO NUMBERS BECAUSE THE TWO SETS ARE DIFFERENT SETS, and one number said they were the
 * same. The map counts KEYED submissions; a listing counts RUNS, and a submission with no
 * `Idempotency-Key` is a run that fills a row of the scan and restores nothing. So a journal
 * whose newest `MAX_IDEMPOTENT_SUBMITS` runs are all header-less restored NOTHING, however
 * recently the keyed run behind them was submitted: measured on one journal, one keyed run,
 * then 10 000 header-less ones, then a restart and a retry of the key — a second run, where
 * the same retry over the same journal without the 10 000 returns the first run's id.
 *
 * ITS SIZE IS A MEASURED COST. The walk pays one indexed `read(runId, 1, 1)` per row: on
 * `SqliteStateStore` over a 100 000-run journal, 10 000 rows is 161 ms, 50 000 is 789 ms and
 * 100 000 is 1.6 s — paid once per process, lazily, and only by a plane that receives an
 * `Idempotency-Key` at all. This is the bound that may be hit without losing an answer in the
 * ordinary case, because the walk STOPS as soon as it has restored a full map: a deployment
 * where most submissions carry a key reads about `MAX_IDEMPOTENT_SUBMITS` rows and pays what
 * it paid before.
 *
 * WHAT IT DOES NOT COVER, said plainly rather than left as a ratio to work out: a deployment
 * where fewer than one submission in five carries a key restores a SHORTER window than it
 * keeps live. Raise this together with `MAX_IDEMPOTENT_SUBMITS` if that is the deployment,
 * and read the cost per row above before choosing.
 */
const MAX_IDEMPOTENT_SCAN = 50_000;

/**
 * How much of a journal `GET /runs/:id/trace` will fold in one request.
 *
 * A journal is the one input to that route a caller supplies without limit, and unlike
 * `/runs/:id/events` — which streams, so the memory ceiling is one frame — a fold has to
 * hold every event to close a span. The bound is generous rather than tight: 100k events is
 * well past any run this engine schedules, and a run that exceeds it is answered with a
 * prefix and `truncated: true` rather than with an error, because `spansFrom` renders a
 * prefix as an in-flight trace and an in-flight trace is a normal thing to look at.
 */
const MAX_TRACE_EVENTS = 100_000;

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
 * `ControlPlaneOptions.allowedHosts` as a set, checked — `undefined` for "derive it".
 *
 * An EMPTY set is the encoding of `"*"`, and the two are one value on purpose: "answer to
 * any name" and "the check is off" are the same statement, and giving them one
 * representation is what stops a later edit from implementing only one of them.
 *
 * The empty LIST is refused instead of being read as either. It is the shape a `--host`
 * flag with no value, or a config array a template filtered down to nothing, produces —
 * and it would install a plane that refuses every request including `/health`, which an
 * operator reads as "the process is down" while the process is fine.
 */
function allowedHosts(configured: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (configured === undefined) return undefined;
  if (!Array.isArray(configured) || configured.some((h) => typeof h !== "string" || h.trim() === "")) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `ControlPlaneOptions.allowedHosts must be a list of non-empty host names — the values a caller may send in \`Host\`, ` +
        `such as ["loom.internal", "loom.internal:8787"]. Use ["*"] to answer to any name, or omit the option to derive the ` +
        `list from the address bound.`,
    );
  }
  if (configured.length === 0) {
    throw err.validation(
      CODES.E_CONFIG_INVALID,
      `ControlPlaneOptions.allowedHosts is the empty list, which would refuse EVERY request — including /health, so a load ` +
        `balancer would read this process as down while it is fine. Name the hosts this deployment answers to, pass ["*"] to ` +
        `answer to any of them, or omit the option to derive them from the address bound.`,
    );
  }
  return configured.includes("*") ? new Set<string>() : new Set(configured.map((h) => h.trim().toLowerCase()));
}

/**
 * Is this bind address one only THIS MACHINE can reach?
 *
 * The predicate behind two decisions that must never disagree: which names a bind derives
 * a `Host` allowlist for (`loopbackHosts`), and whether `listen` refuses to put a
 * tokenless plane on it. They were going to be two texts kept in step — one here and one
 * in `cli.ts` — and a perimeter check that is loopback for one of them and routable for
 * the other is worse than either answer taken alone.
 *
 * Takes a BARE address: brackets stripped, lowercased. The whole of `127.0.0.0/8` because
 * every one of those addresses routes to this host and nowhere else; `::1` because it is
 * the same socket over IPv6; `localhost` because it is the name an operator types for
 * both. `::ffff:127.0.0.1` is the IPv4-mapped spelling `server.address()` can hand back on
 * a dual-stack accept, so it counts too.
 *
 * EVERYTHING ELSE IS NON-LOOPBACK, including a hostname this process could resolve. That
 * is the fail-closed direction: `0.0.0.0` and `::` are every interface, a name resolves to
 * whatever DNS says today, and the cost of being wrong in the other direction is a plane
 * on a routable address that this file believed was private.
 */
function isLoopbackAddress(bare: string): boolean {
  if (bare === "localhost" || bare === "::1") return true;
  if (/^127\./.test(bare)) return true;
  return /^::ffff:127\./.test(bare);
}

/**
 * The names a LOOPBACK bind answers to, or `undefined` for a bind that gets no check.
 *
 * The set is the bound address plus the other two spellings of "this machine", with and
 * without the port, because a browser sends whichever one the operator typed and all
 * three are the same socket.
 *
 * A NON-LOOPBACK bind derives nothing, and that is a decision rather than an omission.
 * DNS rebinding exists to reach a service the attacker cannot route to; a plane on a
 * routable address is one they can already reach directly, so the guard buys nothing there
 * — while the name such a deployment actually answers to is a proxy's or a mesh's, which
 * this file cannot know and must not guess. `allowedHosts` is how that deployment says it.
 * The cross-site checks are unaffected and apply on every bind.
 */
function loopbackHosts(host: string, port: number): ReadonlySet<string> | undefined {
  const bare = host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!isLoopbackAddress(bare)) return undefined;
  const names = new Set<string>();
  for (const h of [bare.includes(":") ? `[${bare}]` : bare, "localhost", "127.0.0.1", "[::1]"]) {
    names.add(h);
    names.add(`${h}:${port}`);
  }
  return names;
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

/**
 * The three body fields of `POST /runs/:id/oversight`, checked and never cast.
 *
 * They are `cli.ts`'s `postureFlag`/`justificationFlag`/`ceilingScope` at the other door, and
 * they are duplicated rather than shared for the reason `#refuseUnidentifiedApproval` gives
 * about borrowing wording: the two doors take their input from different places — argv versus
 * a JSON body an untrusted client wrote — so the SHAPES they have to refuse differ, and the one
 * thing they must agree on is the answer, not the sentence.
 *
 * ALL THREE REFUSE WHEN THEY CANNOT DECIDE. A posture outside the union has no rank and every
 * comparison against it in `PolicyEngine.floorFor` is false; a blank justification is a
 * loosening with no account of itself; a scope naming another run journals a ceiling into this
 * run's log that the other run can never fold back. None of them has a permissive fallback.
 */
function postureOf(v: unknown): Posture {
  if (typeof v !== "string" || !POSTURES.includes(v as Posture)) {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `"to" must be one of ${POSTURES.map((p) => `"${p}"`).join(", ")}, not ${v === undefined ? "omitted" : typeof v === "string" ? `"${v}"` : typeof v}. ` +
        `It is journaled on policy.deescalated and folded into the run's ceilings, and a posture outside that set has no rank to compare against.`,
    );
  }
  return v as Posture;
}

function justificationOf(v: unknown): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `"why" must be a non-empty justification, not ${v === undefined ? "omitted" : typeof v === "string" ? "blank" : typeof v}. ` +
        `Lowering oversight is journaled with this text and replayed as a human input, so it is the only account of why supervision was reduced.`,
    );
  }
  return v;
}

function ceilingScopeOf(v: unknown, runId: RunId): string {
  const shape = `"scope" must be "run:${runId}" or "node:${runId}/<nodeId>"`;
  if (typeof v !== "string" || v === "") {
    throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `${shape}: it was ${v === undefined ? "omitted" : typeof v === "string" ? "empty" : typeof v}. There is no default scope.`);
  }
  const named = v.startsWith("run:") ? v.slice(4) : v.startsWith("node:") ? v.slice(5).split("/")[0]! : undefined;
  if (named === undefined || (v.startsWith("node:") && !/^node:[^/]+\/[^/]+$/.test(v))) {
    throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `${shape}, not "${v}". Those are the two scopes PolicyEngine reads.`);
  }
  if (named !== runId) {
    // NOT AN AUTHORIZATION CHECK — `ownsRun` above is. This is well-formedness with a durable
    // consequence: `PolicyEngine` keys ceilings by an opaque string and `Engine.deescalate`
    // appends to the log of the run in the URL, so a cross-run scope lowers the other run's
    // posture in THIS process and is re-seeded from a journal that other run never reads.
    // A loosening the journal cannot reconstruct is the first non-negotiable, inverted.
    throw err.validation(
      CODES.E_PROVIDER_BAD_REQUEST,
      `"scope" names run ${named} and this route names run ${runId}. The ceiling would be journaled in ${runId}'s log, ` +
        `so ${named} would lose it as soon as this process restarts.`,
    );
  }
  return v;
}

interface Route {
  readonly method: string;
  /**
   * Whether `HEAD` reaches this route's `GET` handler.
   *
   * PER ROUTE, AND NOT A BLANKET `HEAD ⇒ GET` REWRITE, which is the version that was
   * measured and rejected. Every route here declares `"GET"` or `"POST"` and `#serve`
   * compares the string exactly, so `HEAD /health` fell to the 404 arm — on the one route
   * that is uncredentialed BECAUSE "a load balancer probes it", and against a probe
   * (`option httpchk HEAD /health`) that discards the body the 404 explains itself in. A
   * plane out of rotation with every process healthy is the outage `#healthDiagnostics`
   * spends a paragraph arguing against, caused by the check rather than caught by it.
   *
   * The blanket rewrite also opens the SSE route, whose handler NEVER ENDS: measured on a
   * patched tree, `HEAD /runs/:id/events` held an open bus subscription until the client
   * aborted at 4003 ms, where today it is a clean 404. Trading a wrong 404 on one route
   * for a leaked connection on another is not a fix, so the mapping is opt-in and only
   * routes that finish declare it.
   *
   * `node:http` suppresses the body itself and `send` still sets an accurate
   * `content-length`, so a handler needs no HEAD branch.
   */
  readonly head?: true;
  readonly pattern: RegExp;
  handle(ctx: RequestContext): Promise<void>;
}

interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly params: readonly string[];
  readonly url: URL;
  /** Aborted when this request's deadline fires. See `#withDeadline`. */
  readonly signal: AbortSignal;
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
   * BOUNDED, and the bound is a TIME rather than a count however it is spelled. Eviction here
   * is the one in this pass with a correctness cost: `Engine.submit` mints a fresh `runId` and
   * nothing anywhere dedups on the key, so this map is the only thing collapsing a retry, and an
   * evicted key means a second run with whatever side effects the first one had.
   *
   * What makes the count safe is that entries are recorded only on SUCCESS, so filling the map
   * costs `MAX_IDEMPOTENT_SUBMITS` real submissions — each of them the very operation being
   * deduplicated. Divide by the deployment's submission rate to get the window a retry may
   * arrive in: at ten runs a minute that is about 17 hours — so a nightly job retrying the next
   * day is outside it, which is the case the number was chosen against.
   *
   * AND THE OTHER BOUND WAS THIS PROCESS'S LIFETIME, which the paragraph above did not say.
   * A map is not durable state, so a `loom serve` restart — a deploy, an OOM, a crash — made
   * that 17-hour window ZERO: the same key presented after it minted a second run with every
   * side effect of the first. Measured across two OS processes over one SQLite journal, same
   * key, same principal: two runs. See `#restoreIdempotency`, which rebuilds this map by
   * FOLDING, so the window is the count again and not the uptime.
   */
  readonly #idempotency = new Map<string, unknown>();
  /**
   * The submissions this process is CURRENTLY making, by slot — the map above holds the ones
   * it has finished.
   *
   * WHY TWO MAPS. `#idempotency` records a slot on SUCCESS, and everything between the read
   * that missed and that record is an `await`: the journal scan, then `engine.submit` itself.
   * A second request carrying the same key inside that window read the same empty slot and
   * submitted too, so the one header whose whole job is "do this once" produced two runs with
   * every irreversible tool call and every provider charge of each other. Measured against
   * this class with a store whose `listRuns` yields to the macrotask queue — which a library
   * embedder's store does and neither shipped store does, `MemoryStateStore` being in memory
   * and `SqliteStateStore` synchronous under an async facade: two concurrent `POST /runs`,
   * one `Idempotency-Key`, **202 202, two distinct run ids, two runs in the journal.**
   *
   * SO THE SLOT IS CLAIMED SYNCHRONOUSLY AT THE MISS. The claim is a promise put here in the
   * same tick as the read that missed, before the handler awaits anything, and a concurrent
   * caller that finds it awaits the first request's answer instead of making its own. That is
   * the only ordering with no window in it: any check-then-act separated by an `await` has
   * one, however short the await looks from the caller that wins the race.
   *
   * IT IS DELETED IN A `finally`, so an entry lives exactly as long as one in-flight request
   * and this map is bounded by concurrency rather than by the journal — unlike `#idempotency`,
   * which needs `MAX_IDEMPOTENT_SUBMITS` because its entries outlive their requests.
   *
   * A FAILED SUBMISSION IS NOT AN ANSWER, so the claim REJECTS and the slot is freed rather
   * than recording a failure everyone else is handed forever. The concurrent caller gets that
   * failure — it asked for the same operation, it gets the same answer — and the next request,
   * arriving after the claim is gone, tries again for itself.
   */
  readonly #inflightSubmits = new Map<string, Promise<unknown>>();
  /**
   * The rebuild of `#idempotency` from the journal — at most one in flight, and at most one
   * that SUCCEEDED.
   *
   * A PROMISE RATHER THAN A BOOLEAN, so that two concurrent submissions share ONE scan
   * instead of each starting its own. **It is not what keeps the second one from submitting,
   * and this said it was:** both callers await the same promise, both then read the same
   * empty slot, and both fell through to `engine.submit`. What decides that is the claim in
   * `#inflightSubmits`, made before either of them gets here.
   *
   * **AND IT IS CLEARED ON REJECTION, which memoising a promise does not do for you.** A
   * rejected promise stays rejected forever, so `#restoreIdempotency` awaiting this field
   * re-threw one dead store error on every later call: a single `SQLITE_BUSY`, one
   * reconnect, one odd row turned EVERY subsequent submission carrying an `Idempotency-Key`
   * into `500 E_INTERNAL` — with `retryable:false`, so a well-behaved client stopped
   * retrying — for the life of the process, while unkeyed submits and `/health` stayed
   * green. Measured against this class with a store that fails `listRuns` exactly once.
   *
   * REFUSING THE REQUEST IS STILL RIGHT and that half does not change: falling through to
   * `engine.submit` on a scan that did not finish is the duplicate run this whole mechanism
   * exists to prevent, so the caller gets an error. What changes is that the error is about
   * THIS request. The next one starts a new scan.
   */
  #idempotencyRestored: Promise<void> | undefined;
  /**
   * `runId -> the head this run had when its fold held NO open gate`.
   *
   * WHAT IT SAVES. `GET /gates` scans every run that has EVER raised a gate — that is what
   * the `raisedAGate` filter means, and the set only grows — and folds each one to discover
   * whether anything is still open. Most of that set is finished runs. Measured on 8 gated
   * runs after a restart, with every gate decided and ZERO open anywhere: `GET /gates` read
   * all 1184 events of those journals and returned `gates: []`, on every poll, and the
   * console polls it every 4 seconds. This makes the second poll read nothing.
   *
   * WHY IT CANNOT GO STALE, which is the only question a cache like this has to answer. The
   * key is the run's HEAD, and a head moves whenever anything is appended — including the
   * `gate.raised` that would make the memo wrong. Both stores write `run_head` inside the
   * same append that writes the events (`sqlite.ts`'s `BEGIN IMMEDIATE` block; `memory.ts`
   * derives it from the event list), so the head this listing returns is exact and not a
   * lagging index. A fold is deterministic, so "same run, same head" is "same answer".
   *
   * WHAT IT IS NOT ALLOWED TO BE. It answers ONE question — "did this run have any open gate
   * at this head" — which is a fact about the run and not about the caller, so it can never
   * decide who may see what. Whether a gate reaches a given principal is still recomputed
   * from the projection every time, because that answer depends on `ownsRun` and
   * `namesApprover` and this map knows nothing about either. And a MISS folds: absent means
   * "I have not looked", never "nothing there".
   *
   * IT IS NOT THE FIX THIS ROUTE NEEDS. The remaining cost is `engine.openGates`, which
   * re-folds from seq 1 a journal this handler has just folded incrementally one line
   * earlier — removable only by letting `HumanGateBroker.list` take a projection, which is
   * `run/gates.ts` and `run/engine.ts`. That is the cheap first move and it lives in the
   * kernel; this is the part that lives here.
   */
  readonly #gatelessAt = new Map<RunId, Seq>();
  /**
   * `ControlPlaneOptions.drive`, captured ONCE at construction.
   *
   * The same rule as `#token`, `#identity` and `#identityName`: `ControlPlaneOptions` is a
   * record a caller builds, so re-reading the field on every submission would let a mutated
   * options object change how many runs this plane drives at once, per request, with nothing
   * to see it happen.
   */
  readonly #drive: ((runId: RunId) => void) | undefined;
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
  readonly #subgraphs: readonly RunGraph[];
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
   * construction. See "WHAT `auth` DECIDES" in the module docstring.
   */
  readonly distinctPrincipals: number;
  /**
   * How many configured credentials may read every run, or `undefined` when unknowable.
   *
   * Advisory, like `distinctPrincipals`, and read by the boot warning alone. It grants
   * nothing: what grants is `AuthContext.operator`, per request.
   */
  readonly operatorCredentials: number | undefined;
  /**
   * `allowedHosts` as configured, captured like every other option. `undefined` is "derive
   * it from the bind"; an empty set is "`*`" — the check turned off on purpose.
   */
  readonly #configuredHosts: ReadonlySet<string> | undefined;
  /**
   * The names this plane answers to RIGHT NOW, or `undefined` for no check.
   *
   * Not `readonly`, and the only field that is not: the default is a fact about the socket
   * (`listen(0)` learns its port from the OS), so it cannot exist until `listen` returns.
   * Set there, from the address actually bound rather than from the one requested.
   */
  #allowedHosts: ReadonlySet<string> | undefined;
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
    // THE THIRD OPTION THAT BECOMES ITS OWN OPPOSITE. An empty list reads as "restrict the
    // hosts" and installs "answer to no host at all", which is a plane that 403s every
    // request while `/health` — reached by the same refusal — stops answering too. The
    // deliberate spelling of "no restriction" is `["*"]`, a value nothing can expand to by
    // accident, exactly as an open plane is the ABSENCE of a token rather than an empty one.
    this.#configuredHosts = allowedHosts(opts.allowedHosts);
    // THE COLLABORATORS, captured for the same reason as the numbers rather than for a
    // different one. `graphs` reached `/health` — the route that promises to answer from
    // process-local state alone — and `engine`, `store` and `bus` were re-read inside
    // `#streamEvents` and `#refuseUnidentifiedApproval` long after the routes had already
    // closed over them. `graphs` defaults to `{}` HERE so no use site has to remember to.
    this.#graphs = opts.graphs ?? {};
    this.#subgraphs = opts.subgraphs ?? [];
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
    // HOW MANY CREDENTIALS READ EVERYTHING, or `undefined` for "this plane cannot tell".
    //
    // `undefined` is a THIRD answer and not a zero. An injected `IdentitySource` need not
    // declare `operators`, and asserting a count it did not give would be the same class of
    // falsehood the warning below exists to prevent — so the warning says the number is
    // unknown instead. A shared token that is the SOLE credential contributes one, because
    // `#principal` grants it operator by construction; alongside an identity source it
    // contributes none, and neither does an open plane, where scoping is vacuous anyway.
    // VALIDATED THE WAY `principals` IS, three lines up, and off the same captured local.
    // It is advisory and grants nothing, which is exactly why an unvalidated read is easy to
    // ship and still wrong: `operators: null` made `null + 0 === 0` and the plane shouted
    // "NO OPERATOR CREDENTIAL IS CONFIGURED" at a deployment with several, and `"0"` made
    // `"00"` and suppressed the same diagnostic. A false warning is what `ownershipWarnings`
    // exists to retire; producing one here would be the defect it was written against.
    const declaredOps: unknown = source?.operators;
    const sourceOperators =
      source === undefined ? 0 : typeof declaredOps === "number" && Number.isInteger(declaredOps) && declaredOps >= 0 ? declaredOps : undefined;
    this.operatorCredentials =
      this.openToEveryCaller || sourceOperators === undefined
        ? undefined
        : sourceOperators + (token !== undefined && source === undefined ? 1 : 0);
    // EVERY NAME BELOW IS A FIELD OR A LOCAL, and `logFor` is why that matters rather than
    // being tidiness. It is a closure the constructor builds and `GateCallbackRouter` calls
    // PER REQUEST, from the unauthenticated callback route, to journal a refusal — so
    // `store`, `bus` and `now` spelled as `opts.store`, `opts.bus`, `opts.now` here were
    // reads of the caller's record long after the constructor returned, in the one place
    // whose output is durable. See the field block above for what that measured.
    this.#drive = opts.drive;
    const dispatcher = opts.dispatcher;
    this.#callbacks =
      dispatcher === undefined
        ? undefined
        : new GateCallbackRouter({
            dispatcher,
            engine: this.#callbackEngine(),
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
   * **A TOKENLESS PLANE IS REFUSED A NON-LOOPBACK ADDRESS.** `openToEveryCaller` and the
   * bind address are only ever both in view here, and together they are the difference
   * between a development convenience and an open control plane on the network. See the
   * comment at the top of the body; the fix is a `token` or an `identity` source, and the
   * default bind is unchanged.
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
  async listen(port: number, host = "127.0.0.1"): Promise<{ port: number; host: string; loopback: boolean }> {
    if (this.#server !== undefined) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `this ControlPlane is already listening; a second listen() would leave the first socket bound with no way to reach it — ` +
          `close() can only ever close the last. Call \`await plane.close()\` first if you meant to rebind.`,
      );
    }
    // **A TOKENLESS PLANE MAY NOT LEAVE THIS MACHINE**, and this is the one refusal in the
    // class that is about WHERE the socket is rather than what is on it.
    //
    // `openToEveryCaller` means `#principal` admits every request as `service/UNIDENTIFIED`
    // — so on a routable address, anyone who can reach the port can `POST /runs` (spend this
    // deployment's provider budget), `POST /runs/:id/gates/:gateId` (approve any open human
    // gate, which is the whole oversight perimeter), and `POST /runs/:id/commands`
    // (`cancel`, `pause`, `resume`, `advance`). Those three are read off `#buildRoutes` rather
    // than remembered: an earlier draft of this comment named `POST /runs/:id/decisions` and
    // `DELETE /runs/:id`, and NEITHER ROUTE EXISTS. That is not a posture; it is the absence
    // of one, and the default bind is the only thing that has ever stood in front of it.
    //
    // THE COMMANDS LIST IS FOUR VERBS, NOT SIX, and it shrank rather than being miscounted: the
    // route also takes `steer` and `rewind`, and both refuse a caller who is not a person. On an
    // open plane `commandActor` yields `SYSTEM_ACTOR("operator")` for every request, so neither
    // is reachable here at all. It used to say "cancel, rewind, advance", which was true when it
    // was written and stopped being true when `Engine.rewind` grew its human floor — naming the
    // verbs an anonymous caller ACTUALLY gets is the only version of this sentence that stays
    // honest, and it is the reason to read them off the switch rather than recall them.
    //
    // MEASURED, all six through this plane with no token and no identity source: `cancel` 200,
    // `pause` 200, `advance` 200, `resume` 409 `E_ILLEGAL_TRANSITION` (a refusal about the run's
    // STATE, not about who asked — it passed the authority check), `steer` 403 and `rewind` 403,
    // both `E_HUMAN_APPROVAL_REQUIRED`.
    //
    // REFUSED RATHER THAN WARNED, unlike everything `announce` prints, because the two
    // readings of `listen(0, "0.0.0.0")` on an open plane are "I am behind something that
    // authenticates" and "I did not think about it", and only one of them survives being
    // guessed at. The refusal has a fix that costs the first reading nothing: give the
    // plane a `token` or an `identity` source. There is no deployment that NEEDS zero
    // credential on a socket the network can reach.
    //
    // The empty string is caught here too, and it is the quiet one: `server.listen(port,
    // "")` binds `::` — measured, every interface — so a `--host "$LOOM_HOST"` with the
    // variable unset would otherwise WIDEN the perimeter by accident.
    if (this.openToEveryCaller && !isLoopbackAddress(host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase())) {
      throw err.validation(
        CODES.E_CONFIG_INVALID,
        `refusing to bind ${host === "" ? '"" (which binds EVERY interface)' : host}:${port} — this ControlPlane has no token and no ` +
          `identity source, so every caller is authorized. On a non-loopback address that hands POST /runs (spending this ` +
          `deployment's provider budget), POST /runs/:id/gates/:gateId (approving any open human gate) and ` +
          `POST /runs/:id/commands (cancel, pause, resume, advance) to anyone who can route to the port. ` +
          `Give the plane a token or an identity source, or bind 127.0.0.1 — the default — and put a proxy in front of it.`,
        { details: { host, port } },
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
      // BEFORE THE SOCKET ACCEPTS, and the comment on `#armGatedRuns` that says "BEFORE THE FIRST
      // REQUEST" used to sit AFTER `server.listen` had resolved — so every route answered while
      // the arming was still running, including the unauthenticated callback route the arming
      // exists to serve. Measured on the tree before this change, with a store whose `listRuns`
      // takes 200 ms: `GET /health` on the port `listen` was given answered **200** mid-scan; it
      // now refuses the connection until the scan is done. `server.listen` starts accepting
      // immediately and this method
      // awaits, so a scan after it is a scan with the door open; there is no third position. The
      // cost is that a probe arriving during boot gets a refused connection rather than a 200,
      // which is the honest answer and the one every load balancer already understands. The
      // alternative — answer 503 on every route until armed — puts a second state machine in
      // front of the whole plane to report the same fact less clearly.
      //
      // AFTER `#server` IS CLAIMED, which is the part that is easy to get wrong and was. An await
      // above that assignment leaves a window in which `#server` is `undefined` while a `listen`
      // is genuinely in progress — so the already-listening guard does not hold, and `close()`
      // resolves against a socket that does not exist yet and then one gets bound that nothing
      // holds a handle to. MEASURED with the scan above the assignment: `close()` 50 ms into a
      // 200 ms scan, and `listen()` went on to answer "bound"; `http.test.ts` completed all 128
      // of its assertions and the process never exited, holding one `TCPServerWrap`. Pinned by
      // *close() DURING THE ARMING SCAN LEAVES NOTHING BOUND* in
      // `test/server/product-lane-watch-and-stop.test.ts`, with the second-`listen` refusal
      // beside it as the other half of the same claim.
      await this.#armGatedRuns();
      // AND `close()` MAY HAVE WON WHILE IT RAN. It clears `#server` and resolves without waiting
      // for a socket that does not exist yet, so binding now would leave one bound that nothing
      // holds a handle to. Same answer as the `'close'` race below and for the same reason: the
      // caller asked for the socket to go away, and it never arrived.
      if (this.#server !== server) {
        throw err.cancelled(`listen(${host}:${port}) was ended by close() before the socket began listening; nothing is bound`, {
          details: { host, port },
        });
      }
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
    const bound = typeof address === "object" && address !== null ? address.port : port;
    // FROM THE ADDRESS ACTUALLY BOUND, which is the only reason this is here rather than
    // in the constructor: `listen(0)` learns its port from the OS, and a `Host` allowlist
    // that does not contain the port the browser typed refuses the console it is meant to
    // protect. Set before the first request can arrive — `listening` has fired, but the
    // event loop has not yet reached an accepted connection.
    this.#allowedHosts = this.#configuredHosts ?? loopbackHosts(host, bound);
    // THE ADDRESS, READ BACK OFF THE SOCKET, for the reason `port` is: `listen(0)` learns
    // its port from the OS and `listen(port, "localhost")` learns its address from the
    // resolver, so what the caller ASKED for is not what a boot banner may print. `cli.ts`
    // announces these two and warns on `loopback`; a banner that re-derived either from the
    // flags could promise a posture this process does not have.
    const boundHost = typeof address === "object" && address !== null ? address.address : host;
    return { port: bound, host: boundHost, loopback: isLoopbackAddress(boundHost.replace(/^\[/, "").replace(/\]$/, "").toLowerCase()) };
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

    // BEFORE THE DEADLINE AND BEFORE ROUTING, because a request that names a host this
    // plane does not have is not a request for this plane at all. It is the DNS-rebinding
    // arm of the browser guard: an `Origin` check cannot see this one, since after a
    // rebind the attacker's page really is this origin.
    const claimed = this.#refusedHost(url);
    if (claimed !== undefined) {
      send(res, 403, {
        error: {
          code: CODES.E_NOT_AUTHORIZED,
          message:
            `this plane does not answer to Host ${claimed} — a name it does not have is how a rebound DNS record reaches a ` +
            `loopback socket from a web page. Set ControlPlaneOptions.allowedHosts to the names this deployment really has, ` +
            `or ["*"] if a proxy rewrites Host on the way through.`,
        },
      });
      return;
    }

    try {
      // EVERYTHING is inside the deadline, identity resolution included. It used to start
      // after `#principal` had already been awaited, which left the one call in the path
      // that can block on a network — an injected `IdentitySource` — outside the bound
      // that exists to stop a request parking a socket forever.
      await this.#withDeadline(res, url, (signal) => this.#serve(req, res, url, signal));
    } catch (e) {
      const le = toLoomError(e);
      // `send` is a no-op once anything has been written — mid-stream, or after the
      // deadline answered for us — so this is "answer if you still can, then finish".
      send(res, httpStatusFor(le), { error: le.toJSON() });
      if (!res.writableEnded) res.end();
    }
  }

  /** Authenticate, then route. Split out only so the deadline can wrap the whole of it. */
  async #serve(req: IncomingMessage, res: ServerResponse, url: URL, signal: AbortSignal): Promise<void> {
    // FIRST, ahead of `#requiresBearer` and `#principal`, and the order is the rule this
    // module already states: nothing a stranger can reach may make the injected
    // `IdentitySource` do work. A cross-site prober is a stranger by definition, so it is
    // answered before anything deployment-supplied is consulted.
    const forged = crossSite(req, url);
    if (forged !== undefined) {
      send(res, 403, {
        error: {
          code: CODES.E_NOT_AUTHORIZED,
          message:
            `refused a cross-site request (${forged}). This plane is reachable from the operator's browser, so a page they ` +
            `merely visited could otherwise submit runs and answer gates as them. Open the console by typing its address ` +
            `rather than by following a link from another site. A client that is not a browser sends neither header and is ` +
            `unaffected.`,
        },
      });
      return;
    }

    const guarded = this.#requiresBearer(req, url);
    // ONLY for a guarded route. An injected identity source is deployment code that may
    // talk to a network, and no route a stranger can reach may be a way to make it do so
    // — not the callback route, not the console shell, and not `/health`, which used to
    // ask so that it could decide what to disclose. See `#healthDiagnostics`.
    const auth = guarded ? await this.#principal(req, url) : undefined;
    if (guarded && auth === undefined) {
      // 401 before routing, so an unauthenticated caller cannot even probe which
      // routes exist.
      send(res, 401, { error: { code: CODES.E_NOT_AUTHORIZED, message: "missing or invalid bearer token" } });
      return;
    }

    for (const route of this.#routes) {
      // HEAD reaches a GET handler only where the route says it may — see `Route.head`.
      if (req.method !== route.method && !(req.method === "HEAD" && route.head === true && route.method === "GET")) continue;
      const match = route.pattern.exec(url.pathname);
      if (match === null) continue;
      await route.handle({
        req,
        res,
        url,
        auth,
        signal,
        params: match.slice(1),
        body: () => this.#readBody(req),
        raw: () => this.#readRaw(req),
      });
      return;
    }
    send(res, 404, { error: { code: CODES.E_ROUTE_NOT_FOUND, message: `no route for ${req.method} ${url.pathname}` } });
  }

  /**
   * The `Host` this request asks for, WHEN it is not one this plane answers to.
   *
   * `undefined` is "fine", so the caller reads as a refusal rather than as a permission —
   * the same shape as `crossSite`, and the reason both are worded as questions about the
   * refusal: a guard that returns `true` for "allowed" inverts silently when someone
   * rewrites the condition.
   *
   * It reads `url.host` and not the header, deliberately. `new URL` has already lowercased
   * it, dropped a redundant `:80`, and bracketed an IPv6 literal, so one comparison covers
   * the spellings a header comparison would need four of — and an absolute-form request
   * target, which overrides `Host` in `requestUrl`, is checked as the thing that will
   * actually be routed.
   */
  #refusedHost(url: URL): string | undefined {
    const allowed = this.#allowedHosts;
    // No derived set (a non-loopback bind) and the explicit `["*"]` are one case: no check.
    if (allowed === undefined || allowed.size === 0) return undefined;
    return allowed.has(url.host.toLowerCase()) ? undefined : truncate(url.host);
  }

  /**
   * Which requests must present a credential. Every one but three, and all three are
   * listed here.
   *
   * `/health` is open because a load balancer probes it, and what it says to an
   * unauthenticated caller is only that the process is up. It is a LIVENESS probe and it
   * answers from process-local state alone — see `#healthDiagnostics` for what that
   * costs and why it is worth it. `auth` and `identity` are the two things it discloses to
   * anyone, and deliberately: each names a MECHANISM, and the console has to be able to
   * tell "sign in" from "this deployment cannot take your decision" before it has anything
   * to sign in with. Everything on that route with deployment CONTENT in it — the graph
   * inventory, the callback refusal counts — is behind `#healthDiagnostics`, and this
   * sentence is the file's own argument for the route being safe to leave open, so it has
   * to stay true of the payload rather than of the intent.
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
      if (!this.#sharedToken(req)) return undefined;
      // AN OPERATOR ONLY WHEN IT IS THE SOLE CREDENTIAL.
      //
      // The shared token names the deployment's own key rather than a person, so on a plane
      // that has only it, every caller is the same principal, owns every run, and scoping is
      // vacuous — declaring it an operator changes nothing and keeps the single-token
      // deployment byte-for-byte what it was.
      //
      // A MIXED plane is the case this condition exists for, and `#principal`'s own ordering
      // is why: the identity source is tried first and this is the FALLBACK, so the arrangement
      // this file documents as supported — Alice her own token, the CI job the shared one —
      // would otherwise hand every service in the deployment an operator credential over every
      // human's runs and gate payloads. There the shared token is one principal among several,
      // and a deployment that wants an operator says so on an identity entry.
      const sole = source === undefined;
      return { kind: "service", subject: SHARED_TOKEN_SUBJECT, method: "shared-token", ...(sole ? { operator: true } : {}) };
    }
    // An open plane authenticates nobody, so every caller presents this same marker, owns
    // every run it submits, and matches every run any other caller submitted. Scoping is
    // vacuous by construction and no operator grant is needed to make it so.
    return this.openToEveryCaller ? { kind: "service", subject: UNIDENTIFIED_SUBJECT, method: "open" } : undefined;
  }

  /**
   * Whether this `/health` caller sees the deployment as well as the liveness answer.
   *
   * TWO fields now, not one: the callback refusal counts and the graph inventory. What
   * they have in common is that neither is a fact about whether the process is up — one
   * says who is knocking, the other says what this deployment can be asked to do — and
   * both were reachable by anyone who could reach the port.
   *
   * The SHARED TOKEN and nothing else, which is the entire point: it is a configured
   * constant compared in constant time, with no I/O and no injected code behind it, so
   * `/health` can answer without consulting anything that might be down. It used to
   * consult `#principal`, and therefore the identity source — which made an SSO outage
   * into a load balancer draining every healthy process, an outage CAUSED by the health
   * check rather than caught by one. A probe that fails when a dependency fails is a
   * readiness probe wearing the wrong name.
   *
   * The cost, stated because it is real and it grew: a deployment that configures
   * `identity` and NO shared token cannot read `callbackRefusals` here at all, and now
   * cannot read the graph list here either. That is the right trade — the two options are
   * not alternatives, `token` is described as a service credential and these counts are a
   * service-shaped diagnostic — and the graph list has a credentialed route of its own in
   * `GET /graphs`, which is where the console reads it. But it is a cost.
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

  /**
   * Bind a run to the graph it compiled, using the graphs this plane was given.
   *
   * WHY THIS EXISTS: `Engine` methods that decide a gate or move a run require the run to be
   * ATTACHED, and this plane never attached anything — only `cli.ts` did, behind a `--graph`
   * flag. So a `serve` process could LIST every open gate on a run it did not submit and answer
   * none of them, while `GateSweeper` — which needs no attachment at all — went on expiring those
   * same gates into `run.failed`. After any restart or deploy, every open gate was visible,
   * unanswerable, and still on a clock.
   *
   * ONLY ON WRITE PATHS, AND ONLY AFTER AUTHORIZATION. Attaching costs a `RunContext` that
   * `#retire` frees only when the run ends, so doing it on a read route would let anyone holding
   * the lowest-privilege credential grow this process's memory by listing runs. The read routes
   * already work unattached — `projection` and `openGates` both fall back to the journal.
   *
   * A MISS IS NOT AN ERROR HERE. It leaves the run unattached and the caller gets the same
   * `E_RUN_NOT_FOUND` it would have got before, which is the honest answer: this deployment does
   * not hold that graph. And attaching the WRONG graph is not a risk this carries — `Engine`
   * refuses any graph that is not the one the run compiled, resources included.
   */
  /**
   * The compiled graph this plane holds for a HASH, or `undefined`.
   *
   * By hash and not by name because a run records the graph it compiled and never the key a
   * deployment filed it under. `#graphs` is small — a deployment's inventory, not a run's —
   * so a scan is the right shape and an index would be a cache nobody invalidates.
   *
   * SIX CALLERS AND FOUR OF THEM DECIDE A DISCLOSURE: the two gate routes, `#summary` (every
   * route that answers with a projection) and `#streamEvents` all read a run's channel
   * classifications through here, so a lookup that answered too generously would hand over
   * the values it is meant to withhold — under a STRANGER's classifications, which is worse
   * than falling closed and quieter. The other two are `#bindFromIndex`, which attaches, and
   * `GET /graphs/by-hash/:hash`, which serves structure. That is why this is a method rather
   * than a sixth copy of the `find`.
   *
   * PINNED BY `test/server/graph-by-hash.test.ts`, on a plane holding TWO graphs that disagree
   * about one channel's classification with a run of each — because it had no test at all, and
   * a verifier's mutant that ignored the hash and returned the first graph passed every
   * redaction test in the tree. Every one of those rigs held exactly one graph.
   */
  #graphByHash(hash: string | undefined): RunGraph | undefined {
    if (hash === undefined) return undefined;
    // THE DEPLOYMENT'S WORKFLOWS FIRST, then the subgraphs those workflows delegate to. The
    // second list exists because a delegated CHILD run compiles a `resources/subgraph/` spec that
    // is in no `graphs/` directory, so every hash lookup for a child — the attach on the gate
    // route, and the redaction pass on every projection that reaches the wire — used to miss.
    // See `ControlPlaneOptions.subgraphs` for why they are two fields and not one.
    return Object.values(this.#graphs).find((g) => g.graphHash === hash) ?? this.#subgraphs.find((g) => g.graphHash === hash);
  }

  /**
   * A projection on its way to the wire, redacted by the graph THAT run compiled.
   *
   * FIVE ROUTES ANSWER WITH A PROJECTION and every one of them carries the run's channels:
   * `GET /runs/:id`, the three `POST /runs/:id/commands` kinds, the gate-decision reply, and
   * the SSE `snapshot` frame. The pairing of "summarise" with "look the graph up" is the part
   * a sixth route would forget — `listRuns` filtered at two of three sites and the gate routes
   * redacted at zero of two, both in this file, both this shape — so the pair lives here and a
   * route may not spell it again.
   */
  #summary(p: RunProjection): unknown {
    return summarise(p, this.#graphByHash(p.graphHash));
  }

  /**
   * Rebuild `#idempotency` from the journal, once, on the first key this process has not seen.
   *
   * WHY IT EXISTS: `POST /runs` decided whether a submission was a duplicate by reading a
   * process-local `Map`, while `run.submitted.idempotencyKey` has been journaled on every run
   * since the field existed and was read by NOTHING in `src/` but an OTel attribute. So a
   * retry that crossed a process boundary — the client timed out, the plane was redeployed,
   * the request landed on a second replica — was indistinguishable from a new submission, and
   * the answer to "have I seen this key?" on a cold map was the PASSING one. The failure is
   * not a lost read: it is a duplicated WRITE, a second run with every irreversible tool call
   * and every provider charge of the first.
   *
   * FOLDING, NOT A COLUMN. The tempting fix is an index keyed by the slot beside `run_head`,
   * and it is the wrong shape twice over: `journal/store.ts`'s own header states the rule it
   * would break — "the journal is addressed PER RUN, so no decision may read a fact that spans
   * runs" — and adding the capability would touch two kernel files for a value the journal
   * already holds. Everything the slot is made of is in the payload: `idempotencySlot` needs
   * `auth.method`, `auth.kind`, `auth.subject` and the key, and `run.submitted` carries
   * `submittedBy: {kind, subject, method}` beside `idempotencyKey`. So this rebuilds the map
   * rather than teaching the store a second index.
   *
   * ONE ROW PER RUN, NOT A FOLD PER RUN. `run.submitted` is the FIRST event of a run by
   * construction, so the loop below reads one event and breaks. What is collected is filled
   * into the map from the BACK, so the eviction order after the restore is the insertion
   * order it would have had.
   *
   * IT PAGES, AND ITS TWO BOUNDS ARE DIFFERENT ON PURPOSE — the same shape and the same
   * reason as `#armGatedRuns`. This was one `listRuns(MAX_IDEMPOTENT_SUBMITS)`, which reads
   * as "the scan covers what the map holds" and does not: the map holds keyed submissions and
   * a listing holds RUNS, so on a plane where most submissions carry no header the whole
   * budget went on rows that restore nothing. `MAX_IDEMPOTENT_SCAN` bounds the rows read;
   * `MAX_IDEMPOTENT_SUBMITS` still bounds the entries restored, and reaching it stops the
   * walk — so the deployment this cost is added for is the only one that pays it.
   *
   * **AND `toSeq` IS PASSED, WHICH IS THE HALF "reads one event and breaks" DID NOT BUY.**
   * `read` is an async ITERABLE over a paged query: `SqliteStateStore` fetches 500 rows a
   * page, so breaking after the first one still materialised the first page of every run's
   * journal — the whole journal for anything shorter than that. On a 10 000-run journal
   * that is ~20 000 statements and ~1.5M rows, inside a request bounded by
   * `requestTimeoutMs`, paid by the first keyed submission after every restart. Measured at
   * ~1.2 s. `read(runId, 1, 1)` bounds the SQL `LIMIT` to the one row this loop wants.
   *
   * A KEY EQUAL TO THE RUN ID IS SKIPPED, and this is the one that would have been a hole.
   * `Engine.submit` journals `idempotencyKey: input.idempotencyKey ?? runId`, so a run
   * submitted with NO header still carries a key — its own id. Restoring those would let any
   * caller present a run id as an `Idempotency-Key` and be handed that run's 202 body,
   * including its `graphHash`, for a run they did not submit. The plane never puts a run id
   * in this map itself, so dropping them loses nothing.
   *
   * LAZY, so a plane that never receives an `Idempotency-Key` never pays for it, and a plane
   * that does pays once. A cold journal with many runs makes the FIRST keyed submission
   * slower; every one after it reads the map.
   *
   * WHAT IT DOES NOT CLOSE. This collapses a retry that crossed a RESTART, which is the
   * measured failure. It does not close a RACE between two live planes over one journal:
   * both scan, both miss, both submit. Closing that needs a uniqueness constraint the store
   * would have to enforce at insert — a different change, in a different file, and one that
   * an index on this key would not give either without it.
   */
  async #restoreIdempotency(): Promise<void> {
    const started = (this.#idempotencyRestored ??= (async () => {
      // Newest first, which is the order `listRuns` answers in.
      const found: { readonly slot: string; readonly body: Record<string, unknown> }[] = [];
      const taken = new Set<string>();
      let rowsRead = 0;
      let after: RunId | undefined;
      while (found.length < MAX_IDEMPOTENT_SUBMITS && rowsRead < MAX_IDEMPOTENT_SCAN) {
        const page = await this.#store.listRuns(
          Math.min(MAX_IDEMPOTENT_SUBMITS, MAX_IDEMPOTENT_SCAN - rowsRead),
          after === undefined ? {} : { after },
        );
        if (page.length === 0) break;
        rowsRead += page.length;
        for (const summary of page) {
          for await (const e of this.#store.read(summary.runId, 1 as Seq, 1 as Seq)) {
            if (e.type !== "run.submitted") break;
            const p = e.payload;
            // The run's own id, which no caller may present. See above.
            if (p.idempotencyKey === summary.runId) break;
            // `SubmittedBy` IS the part of an `AuthContext` the slot is made of — kind,
            // subject, method, the three `principalOf` writes and the three
            // `idempotencySlot` reads. A run written before ownership existed carries none
            // of them and folds to the same empty-string slot an unauthenticated caller
            // gets today, which is the permissive reading `submittedByOrUnowned` already
            // adopted for the same journals.
            const slot = idempotencySlot(p.submittedBy, p.idempotencyKey);
            // The NEWEST run holding a slot is the one restored, and a slot this process
            // filled itself outranks anything the journal says about it.
            if (!taken.has(slot) && !this.#idempotency.has(slot)) {
              taken.add(slot);
              found.push({ slot, body: acceptedBody(summary.runId, p.graphHash) });
            }
            break;
          }
          if (found.length >= MAX_IDEMPOTENT_SUBMITS) break;
        }
        const next = page[page.length - 1]!.runId;
        // A CURSOR THAT DOES NOT ADVANCE ENDS THE WALK, for the reason `#armGatedRuns` gives
        // at greater length: `after` is contractually exclusive, and a store that answers its
        // own boundary again would spin here inside a request.
        if (next === after) break;
        after = next;
      }
      // Oldest last-found first: this map evicts by insertion order.
      for (const entry of found.reverse()) this.#idempotency.set(entry.slot, entry.body);
    })());
    try {
      await started;
    } catch (e) {
      // ONLY IF IT IS STILL THIS ATTEMPT. Two concurrent submissions share one promise and
      // both land here; the first clears the field, and the second must not clear a fresh
      // scan a third request has since started. Compare the value, do not assume it.
      if (this.#idempotencyRestored === started) this.#idempotencyRestored = undefined;
      throw e;
    }
  }

  /**
   * Attach the runs this journal has parked on an OPEN gate, as the socket opens.
   *
   * A WARM START, NOT THE PERIMETER — and it used to be both, which is what made its bounds
   * matter so much. `#callbackEngine` binds the run on the callback route itself, after the
   * signature verifies, so a gate this scan never reaches is still answerable. What this
   * buys is the part no inbound request can trigger: `#bindFromIndex` re-arms the gate clock
   * (`rehydrateGates`), so a gate that must ESCALATE or EXPIRE while nobody posts anything
   * has a process holding its `DeliverySpec` from the moment the socket opens.
   *
   * WHY IT CANNOT SIMPLY BIND EVERYTHING ON THE REQUEST. `#bindFromIndex`'s own rule is
   * "only on write paths, and only AFTER authorization", and the callback route is the one
   * unauthenticated write on the plane: binding on arrival would let any stranger who can
   * guess a run id make this process fold a journal and hold a `RunContext` that `#retire`
   * frees only when the run ends. `#callbackEngine` is where that rule is satisfied — see it
   * for which of `GateCallbackRouter`'s checks have already run by then.
   *
   * WHAT THAT COST BEFORE EITHER EXISTED. On a plane that did not itself submit the run —
   * after a restart, after a deploy, or on a second replica over the same journal — a
   * CORRECTLY SIGNED approval on the URL the vendor was handed answered 404
   * `E_RUN_NOT_FOUND "… is not attached"`, and because step 3 had already admitted the
   * request as durable, a FALSE `gate.callback_rejected {reason:"not_found"}` landed in that
   * run's own journal while the run and the gate both existed and were open. The reason
   * string describes THIS PROCESS's attachment state and is read as a statement about the run.
   *
   * SO THE CAPABILITY MOVES INTO THE PLANE. `cli.ts`'s gate clock has done exactly this on
   * every tick (`armForeignGates`), but a library embedder calling `startControlPlane` with
   * no clock got a plane whose gate routes worked only for runs it submitted itself.
   * Property 2 says the things in the box are written against the surface a stranger uses; a
   * plane that needs the CLI to be answerable is the other thing.
   *
   * **IT PAGES, AND THE TWO BOUNDS ARE DIFFERENT ON PURPOSE.** This was one
   * `listRuns(MAX_QUEUE_SCAN, { raisedAGate: true })` whose result was then filtered down to
   * `awaiting_gate` — and `raisedAGate` means "has EVER raised one", ordered by the most
   * recent `gate.raised`. So on the only deployments this method is for — the ones that
   * actually use gates — the whole 500-row budget was spent on FINISHED runs and the open
   * gate at the back was never armed. Measured: 600 newer gated-and-decided runs in the
   * journal, one genuinely open gate behind them, plain restart, gate unarmed. `after` is
   * the cursor `listRuns` grew for exactly this, so the walk stops on what it has ARMED
   * (`MAX_QUEUE_SCAN` open gates) rather than on what it has READ.
   *
   * READING IS STILL BOUNDED, by `MAX_ARM_SCAN` rows, because the cost per row is a FOLD:
   * `projection` reads a run's whole journal, and "page to the end of the gated listing" on
   * a journal with a million decided gates is a boot that never finishes. The read bound is
   * the one that may now be hit without losing an answer — a gate past it is armed by
   * `#callbackEngine` when its decision arrives, and by `loom serve`'s clock on the next
   * tick.
   *
   * SILENT. A run whose graph this deployment does not hold is skipped by `#bindFromIndex`
   * and stays 404, which is the honest answer. A store that throws leaves the plane unarmed
   * rather than unbootable: every route binds lazily on its own, and refusing to serve at
   * all because one journal row is odd would be a worse failure than the one being fixed.
   *
   * **AND SILENT PER RUN, NOT PER BOOT, which is what "one journal row is odd" claims and
   * the code did not do.** The whole walk sat in one `try`, and the expensive half of the
   * walk — `projection`, a FOLD of a stranger's journal — was inside it, so the first row
   * whose events this binary cannot fold ended the scan for every run behind it. Measured on
   * one plane over one journal: an open gate armed at boot on a clean journal, and the SAME
   * gate unarmed once a single run with an unfoldable `state.reduced` row was appended ahead
   * of it — and it sorts ahead by construction, because `raisedAGate` orders by the most
   * recent `gate.raised`. One row a future version wrote, or one row written by hand, and a
   * deployment's gates silently stop being armed at boot.
   *
   * SO THE TWO FAILURES ARE SEPARATED. A run that cannot be folded or bound is skipped and
   * the walk goes on, exactly as a run that folded to `queued` is skipped; the outer guard
   * keeps only what it can actually recover from — `listRuns` itself failing, which is the
   * paging, not one run. That is also the answer for a mid-walk reorder: a cursor the store
   * refuses raises out of `listRuns` and stops the walk short, which is the "unarmed, not
   * unbootable" case above and not a per-run one.
   */
  async #armGatedRuns(): Promise<void> {
    try {
      let armed = 0;
      let read = 0;
      let after: RunId | undefined;
      while (armed < MAX_QUEUE_SCAN && read < MAX_ARM_SCAN) {
        const page = await this.#store.listRuns(
          Math.min(MAX_QUEUE_SCAN, MAX_ARM_SCAN - read),
          after === undefined ? { raisedAGate: true } : { raisedAGate: true, after },
        );
        if (page.length === 0) return;
        read += page.length;
        for (const summary of page) {
          try {
            // ONLY RUNS STILL WAITING. Attaching a finished run would cost a `RunContext`
            // apiece that nothing ever frees — and it is what the un-paged version spent its
            // entire budget deciding.
            //
            // THE FOLD IS THE COST, AND MOST ROWS DO NOT NEED IT. `raisedAGate` accumulates
            // forever, so on the only deployments this method is for — the ones that use gates
            // — the candidate set is dominated by runs that gated once and FINISHED, and the
            // whole read budget was spent folding their journals to conclude "not awaiting a
            // gate". Measured on an all-decided gated set: `MAX_ARM_SCAN` folds for zero arms,
            // inside `listen()`. `#endedAtHead` answers the same question for those rows from
            // ONE indexed row instead, and it only ever skips a run it has PROVEN terminal —
            // everything else falls through to the fold below, so no undecided gate is missed.
            if (await this.#endedAtHead(summary)) continue;
            if ((await this.#engine.projection(summary.runId))?.status !== "awaiting_gate") continue;
            await this.#bindFromIndex(summary.runId);
          } catch {
            // THIS run is not armed. Its neighbours are unaffected — see above.
            continue;
          }
          if (++armed >= MAX_QUEUE_SCAN) return;
        }
        const next = page[page.length - 1]!.runId;
        // A CURSOR THAT DOES NOT ADVANCE ENDS THE WALK. `after` is contractually EXCLUSIVE,
        // so a store that returns its own boundary again would spin this loop forever inside
        // `listen()` — a plane that never binds its socket. `cli.ts`'s run clock refuses the
        // same shape loudly; here the honest answer is to stop arming, because a boot that
        // does not complete is strictly worse than a warm start that is short.
        if (next === after) return;
        after = next;
      }
    } catch {
      /* unarmed, not unbootable — see above */
    }
  }

  /**
   * Remember that this run had no open gate at this head, so the next poll skips the fold.
   *
   * Bounded and evicted in insertion order, oldest first, following `#idempotency` and
   * `GateCallbackRouter.#admitRow`. It is a CACHE and nothing decides on it: an entry that a
   * restart erases costs one fold, and a head that has moved does not match, so the miss is
   * always the expensive answer rather than a wrong one.
   */
  #rememberGateless(summary: RunSummary): void {
    if (this.#gatelessAt.size >= MAX_QUEUE_SCAN) {
      const oldest = this.#gatelessAt.keys().next();
      if (oldest.done !== true) this.#gatelessAt.delete(oldest.value);
    }
    this.#gatelessAt.set(summary.runId, summary.headSeq);
  }

  /**
   * Did this run END at the seq the listing says is its head? A cheap, one-sided answer.
   *
   * `succeeded`, `failed` and `cancelled` are terminal and `run/projection.ts` refuses every
   * status transition out of them, so a run whose LAST event is one of the three cannot be
   * awaiting a gate — and answering that costs one indexed row rather than a fold of the whole
   * journal. `RunSummary` already carries `headSeq`, so there is not even a `head()` call.
   *
   * ONE-SIDED ON PURPOSE, AND THAT IS WHAT MAKES IT SAFE. `true` means "proven terminal";
   * `false` means "not proven", which includes a genuinely terminal run whose journal happens to
   * carry a later row (a `gate.decided` appended after a cancel), a `headSeq` that has moved
   * since the listing was taken, and a store that threw. Every one of those falls through to the
   * fold that was always there. So this can make the scan cheaper and cannot make it miss a gate
   * — a guard that cannot decide answers with the expensive truth, never the cheap one.
   */
  async #endedAtHead(summary: RunSummary): Promise<boolean> {
    if (summary.headSeq < 1) return false;
    try {
      for await (const e of this.#store.read(summary.runId, summary.headSeq, summary.headSeq)) {
        return e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled";
      }
    } catch {
      /* not proven — the caller folds */
    }
    return false;
  }

  /**
   * The `CallbackEngine` the unauthenticated gate route runs against — the engine, plus the
   * one bind that route could not make for itself.
   *
   * WHY IT EXISTS. `#armGatedRuns` arms what the journal holds at `listen()`, and that is a
   * one-shot: a gate raised on replica A five minutes after replica B booted is not in B's
   * scan and never will be. The published callback URL is sprayed across replicas by the
   * load balancer, so the vendor's correctly signed approval lands on B, `resolveGate` finds
   * no `RunContext`, and B answers 404 `E_RUN_NOT_FOUND` and writes a durable
   * `gate.callback_rejected {reason:"not_found"}` into the run's own journal while the gate
   * is open and on its expiry clock. **The replica set is the deployment `#armGatedRuns`
   * names as its motivation, and a boot-time scan cannot cover it by construction.**
   *
   * WHY IT IS SAFE HERE AND NOT ON ARRIVAL. `#bindFromIndex` may run "only on write paths,
   * and only AFTER authorization", and this route carries no credential — binding on arrival
   * would let anyone who can guess a run id make this process fold a journal and hold a
   * `RunContext`. `resolveGate` is not arrival. By the time `GateCallbackRouter.handle` calls
   * it, all six of these have already passed: the channel name matched one this deployment
   * configured; the channel VERIFIED the signature over the bytes as sent; the request
   * deadline had not passed; the run exists with an open gate; the callback names a human;
   * and that human is on the gate's approvers list when it has one. That is a strictly
   * NARROWER door than the bearer token the five authenticated write routes bind behind.
   *
   * `openGates` AND `projection` DELIBERATELY DO NOT BIND. Both answer from the journal on an
   * unattached run — `Engine.openGates` says so in as many words — so binding there would buy
   * nothing and would move the attach to before the signature is known good, which is the
   * whole distinction above. One bind, at the narrowest point that needs it.
   *
   * The methods are FORWARDED rather than the engine being handed over with one patched, so
   * the object `GateCallbackRouter` holds has exactly the three methods its interface names
   * and no route can reach the rest of the engine through it.
   */
  #callbackEngine(): CallbackEngine {
    // THE ROUTER'S OWN INTERFACE IS THE CONTRACT, so the widening happens here, once, rather
    // than at the call below. `CallbackEngine.resolveGate` types its `actor` as any `Actor`
    // while `Engine.resolveGate` accepts a human (or `system:replay` in replay mode) — the
    // narrowing that `Engine`'s own docstring calls structural. `Engine` satisfies
    // `CallbackEngine` and always did; what changed is only that this file now names the
    // conversion instead of getting it from method bivariance at the assignment.
    const engine = this.#engine as CallbackEngine;
    return {
      projection: (runId) => engine.projection(runId),
      openGates: (runId) => engine.openGates(runId),
      resolveGate: async (runId, input) => {
        // NOT SWALLOWED. A bind that throws is this plane failing to attach a run whose
        // decision it has already authenticated, and the caller must hear that rather than
        // the 404 it decays into. A graph this deployment does not hold is a `return`, not a
        // throw — see `#bindFromIndex` — and still ends as the honest "not attached".
        await this.#bindFromIndex(runId);
        return engine.resolveGate(runId, input);
      },
    };
  }

  async #bindFromIndex(runId: RunId): Promise<void> {
    const wanted = await this.#engine.compiledGraphHash(runId);
    const found = this.#graphByHash(wanted);
    if (found === undefined) return;
    this.#engine.attach(runId, found);
    // AND RE-ARM THE GATE CLOCK. `attach` binds the graph and restores nothing else, so a
    // restarted plane's sweeper held no `DeliverySpec` for any gate and expired the ones that
    // should have escalated — "exhausted its escalation chain with no decision", which was false.
    await this.#engine.rehydrateGates(runId);
  }

  async #withDeadline(res: ServerResponse, url: URL, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    // The 504 below quotes `ms`, so `ms` has to BE the deadline that fired rather than the
    // one that was configured. TWO things make that true and this line used to have only
    // one: the constructor refuses every value `setTimeout` would silently change (see
    // `MAX_TIMER_MS`), AND the value read here is the one the constructor validated. It
    // used to be `this.#opts.requestTimeoutMs`, so a record mutated after construction —
    // or a getter — put a number the check had never seen into `setTimeout` and into this
    // message, which is exactly the bug the check exists to prevent, reached around it.
    const ms = this.#requestTimeoutMs ?? 30_000;
    // THE HANDLER STILL IS NOT CANCELLED — nothing here can force that — but it can now be
    // TOLD, which is the difference between a decision that lands after its 504 and one that is
    // refused. `GateCallbackRouter` reads this after a channel's `parseCallback` settles and
    // declines to apply a decision whose caller has already been told the request failed.
    const expired = new AbortController();
    const timer = setTimeout(() => {
      expired.abort();
      // A wire code that `errors.ts` does not declare, written the way the 401 above is
      // written. Promoting it into `CODES` costs a design-document row as well — every
      // declared code must be named by one — and that is a reconciliation this change
      // does not own. The status is what a caller branches on either way.
      send(res, 504, {
        error: {
          code: CODES.E_REQUEST_TIMEOUT,
          message: `no response for ${url.pathname} within ${ms}ms`,
        },
      });
    }, ms);
    // Never hold the process open for a deadline that has not fired.
    timer.unref?.();
    try {
      await run(expired.signal);
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
    // THE SECOND RUNG OF THE BROWSER GUARD, and the one that does not depend on a header
    // the browser sets. The three content types below are the whole set a cross-site
    // request can send WITHOUT a preflight; `application/json` is not among them, so
    // requiring it means a page cannot reach any body-reading route here without asking
    // this server's permission first — and there are no CORS response headers to give it.
    //
    // HERE AND NOT PER ROUTE, for the same reason the object check below is here: three
    // routes read a field off this immediately, and a refusal each is three places to
    // forget. **The callback route is exempt BY CONSTRUCTION** — it reads `raw()` and
    // never `body()` — which is exactly the exemption wanted, since the vendor posting a
    // button click chooses its own media type, with no special case to keep in sync.
    //
    // An EMPTY body has already returned above: "no fields" is a coherent request, and it
    // carries nothing for a media type to describe.
    const ct = header(req, "content-type");
    if (ct === undefined || !/^application\/json\s*(;|$)/i.test(ct.trim())) {
      throw err.validation(
        CODES.E_PROVIDER_BAD_REQUEST,
        `every route here reads a JSON object, so a request with a body must send \`content-type: application/json\`, not ` +
          `${ct === undefined ? "none at all" : `"${truncate(ct)}"`}. text/plain, multipart/form-data and ` +
          `application/x-www-form-urlencoded are refused by name: they are the three shapes a web page can post to this ` +
          `plane cross-site without a preflight, which is a request the operator's browser makes and the operator did not.`,
      );
    }
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
          const graph = this.#graphByHash(hash);
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
        // The one route a load balancer probes, and the only one that needs HEAD.
        head: true,
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
            // WHAT THIS DEPLOYMENT CAN DO, WHICH IS NOT A LIVENESS FACT. Behind the same
            // predicate as the counter below, and it was not: a graph list names the
            // business actions this plane takes, and it is exactly the input a blind
            // cross-origin `POST /runs` needs to stop being blind. Every other field in
            // this literal carries the argument for its own disclosure; this one arrived
            // with none, three commits before the docstring that claimed `identity` was
            // the only thing here a stranger could read.
            //
            // A CONDITIONAL SPREAD and never `graphs: cond ? … : undefined`, because
            // `"graphs" in body` is what a client branches on and an explicit `undefined`
            // still answers true to it.
            ...(this.#healthDiagnostics(req) ? { graphs: Object.keys(this.#graphs) } : {}),
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
            // AND WHETHER THIS CREDENTIAL SEES OTHER PEOPLE'S RUNS. Without it a console
            // cannot tell "you have started nothing" from "you are scoped and somebody else
            // started everything", and an empty run list is the first thing a new operator
            // meets. It discloses a property of the caller's OWN credential and nothing
            // about anyone else's.
            operator: auth?.operator === true,
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
          // The claim on `slot`, settled on every path out of this handler below. `undefined`
          // for an unkeyed submission, which claims nothing and dedups nothing.
          let answered: ((accepted: unknown) => void) | undefined;
          let abandoned: ((reason: unknown) => void) | undefined;
          if (slot !== undefined) {
            // A duplicate submit BY THE SAME PRINCIPAL returns the ORIGINAL runId and
            // creates nothing. A different principal's identical key is a different slot.
            const seen = this.#idempotency.get(slot);
            if (seen !== undefined) {
              send(res, 202, seen);
              return;
            }
            // AND A SUBMISSION STILL IN FLIGHT IS ALSO A DUPLICATE, which reading only the
            // map above could not see: it records a slot on success, and the two `await`s
            // before that success are the window two concurrent retries both submitted in.
            // See `#inflightSubmits`.
            const inflight = this.#inflightSubmits.get(slot);
            if (inflight !== undefined) {
              send(res, 202, await inflight);
              return;
            }
            // CLAIMED IN THIS TICK, before the scan below and before `engine.submit`. Every
            // later caller finds the claim rather than an empty slot.
            const claim = new Promise<unknown>((resolve, reject) => {
              answered = resolve;
              abandoned = reject;
            });
            // A claim nobody happened to be waiting on still rejects when the submission
            // fails, and an unobserved rejection takes the process down. This is the
            // observer of last resort; the caller that awaits it gets the failure.
            void claim.catch(() => undefined);
            this.#inflightSubmits.set(slot, claim);
          }
          try {
            if (slot !== undefined) {
              // A MISS IS "I DO NOT KNOW", NOT "NEW", and it used to be answered with "new".
              // The map is process-local and the journal is not, so a cold map and an unseen
              // key are the same observation — and the passing answer to that is a second run
              // with every irreversible side effect of the first. Rebuild from the journal
              // before deciding. Once, lazily; see `#restoreIdempotency`.
              await this.#restoreIdempotency();
              const restored = this.#idempotency.get(slot);
              if (restored !== undefined) {
                answered?.(restored);
                send(res, 202, restored);
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

            // A BODY THAT CLAIMS A PRINCIPAL IS REFUSED, NOT IGNORED — the rule `#decider`
            // already applies to a claimed gate approver, and its argument transfers verbatim:
            // "a client that sends `actor` believes it is writing the audit trail; ignoring it
            // would leave that client confidently wrong about what the journal says." Silence
            // is worse here than at the gate, because the value being claimed is the one a
            // later phase scopes access on. Refused even when it AGREES with the credential:
            // unlike `#decider`'s `actor`, this is not a client restating who it is, it is a
            // client asserting a field the perimeter owns.
            for (const claimed of ["submittedBy", "actor", "principal"]) {
              if (input[claimed] === undefined) continue;
              throw err.policy(
                CODES.E_NOT_AUTHORIZED,
                `"${claimed}" is not accepted on this endpoint: who a run is submitted for comes from the credential, ` +
                  `never from the request body. Authenticate as the principal you mean to record.`,
              );
            }

            const name = workflow ?? "";
            // `graphIn`, NEVER a bare index — see its docstring for the six names that
            // reached `engine.submit` and came back 500.
            const graph = graphIn(this.#graphs, name);
            if (graph === undefined) {
              throw err.notFound(CODES.E_RESOURCE_NOT_FOUND, `no compiled graph named "${name}"`);
            }

            // THE SAME REFUSAL THE CLI HAS MADE SINCE `8c734ce`, and this door not making it is
            // `TODO.md` §A0.17. Measured on the binary at `c54b0c2` against
            // `examples/graphs/fan-out-join.json` (`"inputs": ["document"]`):
            // `{"inputs":{"documnet":"a b"}}` answered **202**, wrote `run.submitted`, and then
            // failed the run with `E_INTERNAL: E_CHANNEL_UNDECLARED: channel "document" …` —
            // naming a channel the caller never typed, classing a caller's typo as a bug in Loom,
            // and against a real provider SPENDING before the missing binding was found. That is
            // the shape the CLI's check exists to prevent, on the door that carries the traffic.
            //
            // AFTER `graphIn` because the declared set IS the graph's, and BEFORE `engine.submit`
            // because zero `run.submitted` rows is the whole point of the refusal. The `catch`
            // below frees the idempotency claim and the `finally` deletes the in-flight slot, so a
            // refused submission poisons nothing: the same key, corrected, is a fresh submission.
            //
            // IT IS A BREAK AND IT WAS TAKEN KNOWINGLY. A body that named an EXTRA key on top of
            // the declared ones — `{"document":"a b","notes":"extra"}` — answered 202 and
            // SUCCEEDED at `c54b0c2`, seeding `notes` as a run channel that is durable on
            // `run.submitted`, read by nothing, and rendered `[secret]` in every projection
            // forever. That caller now gets a 400 naming the key. Two things it is NOT: it is not
            // "nobody can be broken because `packages/core` is `private` at version `0.0.0`" —
            // that is a fact about npm, and a running `loom serve` has whatever scripts an
            // operator already pointed at it, which nothing in this repository can enumerate. And
            // it is not "these runs fail anyway" — the extra-key run SUCCEEDED. What decides it is
            // that `cli.ts` has refused this exact body since `8c734ce`, that two doors onto one
            // engine disagreeing about a legal submission is the whole of §A0.17, and CLAUDE.md's
            // "refusing is always allowed; loosening never is". A `spec.channels` rule would have
            // spared a graph that compiles with a GRAPH005_UNPRODUCED_READ warning and is seeded
            // over the wire; `graph/declared-inputs.ts` records why `spec.inputs` was kept
            // instead, and that graph is the residue.
            const undeclared = undeclaredInputsMessage(`"inputs"`, graph.spec, (inputs ?? {}) as Record<string, unknown>);
            if (undeclared !== undefined) throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, undeclared);

            const runId = await engine.submit({
              graph,
              // The check above narrowed this to `object`; the cast is the shape it proved.
              inputs: (inputs ?? {}) as Record<string, unknown>,
              workflow: name,
              ...(key === undefined ? {} : { idempotencyKey: key }),
              // FROM THE CREDENTIAL, NEVER THE BODY — see the refusal above.
              //
              // UNCONDITIONAL, and `auth` is asserted rather than defaulted. `#serve` answers
              // 401 before routing every guarded route, and an open plane still hands every
              // caller a principal, so `undefined` is unreachable here — but the conditional
              // that used to stand in its place had the PERMISSIVE value in its dead branch,
              // so the day `/runs` joined `#requiresBearer`'s carve-out list it would have
              // minted world-readable runs with nothing red. A dead branch whose value is the
              // weaker claim is a fail-open waiting for an unrelated edit.
              submittedBy: principalOf(mustAuth(auth)),
            });
            // 202, and the body says exactly what is durable — see the module docstring.
            const accepted = acceptedBody(runId, graph.graphHash);
            if (slot !== undefined) {
              // Insertion order, oldest first, following `GateCallbackRouter.#admitRow`.
              if (this.#idempotency.size >= MAX_IDEMPOTENT_SUBMITS) {
                const oldest = this.#idempotency.keys().next();
                if (oldest.done !== true) this.#idempotency.delete(oldest.value);
              }
              this.#idempotency.set(slot, accepted);
            }
            // The claim is settled BEFORE the response, so a caller waiting on it is handed
            // this run rather than the empty slot a `finally` one line later would leave.
            answered?.(accepted);
            send(res, 202, accepted);

            // Drive it after responding: the client is not made to wait on execution.
            //
            // THROUGH `drive` WHEN THE DEPLOYMENT SUPPLIED ONE, which is what puts a ceiling on
            // how many accepted runs this process drives at once. It is a hand-off and not a
            // gate: the 202 above is already sent, unconditionally, and a full dispatcher does
            // nothing rather than refusing — the deployment's run clock re-derives the run from
            // the journal and offers it again. See `ControlPlaneOptions.drive`.
            if (this.#drive !== undefined) {
              this.#drive(runId);
              return;
            }
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
                // WHAT THIS LINE USED TO SAY WAS FALSE ONCE THE RUN CLOCK EXISTED, and it is the
                // instruction half that was wrong rather than the diagnosis: "nothing is driving
                // this run" was true of a plane with no clock and is not true of `loom serve`,
                // whose `runClockTick` re-derives every `running` run with a `ready` task from
                // the journal on every tick and offers it again. Telling an operator that their
                // run is stranded — and that a manual POST is the only way back — is worse than
                // saying nothing, because it is a fact they can act on and it is wrong.
                //
                // A LIBRARY EMBEDDER WITH NO CLOCK IS THE CASE WHERE IT WAS TRUE, and that is
                // now the case this branch is FOR: `drive` is absent, so nothing above this
                // handler is bounding or retrying anything. The line says which of the two the
                // reader is in rather than asserting one.
                console.error(
                  `[loom] run ${runId} was ACCEPTED (202) and its first advance() FAILED: ${describeFailure(e)}. ` +
                    `The journal holds run.submitted and run.compiled and nothing after them. This plane was built with no ` +
                    `ControlPlaneOptions.drive, so nothing here will come back for it: POST /runs/${runId}/commands ` +
                    `{"kind":"advance"} to retry it, or run this plane behind a deployment with a run clock.`,
                );
              } catch {
                // Nothing above this frame can be told anything, and taking the process down
                // to report that a report failed is strictly worse than the silence.
              }
            });
          } catch (e) {
            // THE CLAIM IS FREED, NOT LEFT PENDING. A validation refusal, a missing graph, a
            // store that threw: none of them is an answer to hand the next caller, and a
            // claim that never settles is a same-key retry that hangs until its own timeout.
            abandoned?.(e);
            throw e;
          } finally {
            if (slot !== undefined) this.#inflightSubmits.delete(slot);
          }
        },
      },

      // THE SCOPED ROUTES. Each takes `auth` for admission AND for access, and the two
      // predicates differ on purpose — see `ownsRun` and `mayReachGates`.
      {
        method: "GET",
        pattern: /^\/gates$/,
        /**
         * THE APPROVER'S ENTRY POINT, and the route that stops ownership from breaking the
         * thing ownership exists to protect.
         *
         * `GET /runs` answers from the owner column with no fold, which is what keeps a
         * polling console cheap — and it means an approver who is not the submitter cannot
         * find the run their question lives on. Under separation of duties that approver is
         * by construction NOT the submitter, so without this route the oversight workflow
         * would be reachable only by `curl` against an id nobody had told them.
         *
         * WHAT IT RETURNS is the questions addressed to this caller, across runs: gates
         * naming them, every open gate on runs they own, and everything for an operator. An
         * unrestricted gate on a stranger's run is deliberately NOT here — it is answerable
         * by whoever reaches it, and putting it in every principal's queue would publish its
         * rendered payload, which carries the node's channel values.
         *
         * THE COST IS A FOLD PER CANDIDATE RUN, and it is NOT the shape `GateSweeper` pays.
         * An earlier version of this comment said it was, in three places; the sweeper's own
         * docstring says the opposite — its cost model is incremental, a cursor per run,
         * "O(Δ), not O(history)", and "a run nobody has written to costs a number comparison
         * and nothing else". This route has none of that: it folds, and `openGates` re-reads
         * a run's journal from seq 1 every call. Hence the two hard ceilings above, which
         * `pageLimit` deliberately does not impose, and the `truncated` flag: an unbounded
         * page here is an amplifier reachable by the lowest-privilege credential a
         * deployment issues.
         *
         * HALF OF THAT IS NOW PAID ONCE PER HEAD RATHER THAN PER POLL. `#gatelessAt`
         * remembers, per run, the head at which the fold found NO open gate, so the candidate
         * set's dominant member — a run that gated once and finished, which is what
         * `raisedAGate` accumulates forever — is skipped instead of re-folded. Measured on 8
         * gated runs, all finished, ZERO gates open, on a plane rebuilt over the same store:
         * poll #1 read 1184 journal events and polls #2 and #3 read 0. Warm, `Engine.#project`
         * was already incremental and this changes nothing.
         *
         * AND POLL #1 IS PAID BY `#endedAtHead`, because that map is empty by construction on a
         * cold process — which is the poll a restarted deployment makes, and the one where the
         * candidate set is at its worst. A run whose LAST event is terminal is skipped on one
         * indexed row instead of a fold; anything not proven terminal still folds.
         *
         * WHAT IS LEFT IS `openGates`, and it is the bigger half whenever a gate IS open:
         * `HumanGateBroker.list` calls `project(log)`, which does `log.read(1)` with no cursor
         * at all, so the route folds from seq 1 the same journal it folded incrementally one
         * line earlier and throws the cheap answer away. Measured warm, 8 runs each parked on
         * a gate: 1056 events per poll, every one of them from that second fold. The fix is to
         * let `list` take the projection this handler already holds — `run/gates.ts` and
         * `run/engine.ts`, both kernel, and a `fix` may touch them. It is removable
         * duplication and not a missing index.
         *
         * The eventual reversal is still a denormalised open-gate index beside `run_head` —
         * the same move `submitted_by` already is — at which point the scan bound and the
         * truncation flag both go away. Its hazard, which is the load-bearing part of that
         * change: an existing journal's `run_head` rows carry no counter, and reading a
         * missing one as "no open gate" would silently drop a live question from the only
         * place its approver can find it. Absent must mean "fold it anyway", exactly as an
         * absent entry in `#gatelessAt` does.
         */
        handle: async ({ res, url, auth }) => {
          const who = mustAuth(auth);
          // BOUNDED BY GATES, AND BY HOW FAR IT SCANS, and both bounds are hard.
          //
          // The first version took `pageLimit`, which deliberately imposes no maximum, and
          // spent it on RUNS: `?limit=9007199254740991` folded the whole journal, on a route
          // any credential can reach, with no rate limit and a deadline that abandons the
          // response without cancelling the work. Worse, the bound was the wrong UNIT — a
          // question addressed to an approver vanished from the only route that can show it
          // as soon as fifty newer runs existed, which is a denial of oversight in the route
          // added to keep ownership from denying oversight, and inducible by anyone who can
          // submit.
          const want = Math.min(pageLimit(url.searchParams.get("limit")), MAX_QUEUE_GATES);
          const out: unknown[] = [];
          let scanned = 0;
          let truncated = false;
          // GATED RUNS, NEWEST GATE FIRST — the same narrowing `GateSweeper` uses, and for the
          // same reason. This was `listRuns(MAX_QUEUE_SCAN)`, ordered by run id descending, so a
          // question addressed to an approver dropped out of the only route that shows it as
          // soon as MAX_QUEUE_SCAN newer runs existed — inducible by anyone who can submit, and
          // the entry above calls it a denial of oversight. Ordering by the most recent
          // `gate.raised` means only runs that have ever gated compete for the scan budget.
          for (const summary of await store.listRuns(MAX_QUEUE_SCAN, { raisedAGate: true })) {
            if (out.length >= want) {
              truncated = true;
              break;
            }
            scanned++;
            // ALREADY ANSWERED AT THIS HEAD. Counted in `scanned` because the walk really did
            // reach this run; skipped before the fold because the fold's answer is known. See
            // `#gatelessAt`.
            if (this.#gatelessAt.get(summary.runId) === summary.headSeq) continue;
            // AND ON THE FIRST POLL OF A COLD PROCESS, where that map is empty by construction,
            // the run's last event answers the same question for the candidate set's dominant
            // member — a run that gated once and finished. One indexed row instead of a fold,
            // and one-sided: only a run PROVEN terminal is skipped. See `#endedAtHead`.
            if (await this.#endedAtHead(summary)) {
              this.#rememberGateless(summary);
              continue;
            }
            const p = await engine.projection(summary.runId);
            if (p === undefined) continue;
            if (!Object.values(p.gates).some((g) => g.state === "open")) {
              this.#rememberGateless(summary);
              continue;
            }
            const mine = ownsRun(p, who);
            // A stranger's queue holds ONLY the questions naming them. An unrestricted gate is
            // answerable by whoever reaches it, and putting it in everyone's queue would
            // publish its rendered payload — the node's readable channel values — to the whole
            // deployment, which is the disclosure ownership exists to close.
            const wanted = Object.values(p.gates).filter((g) => g.state === "open" && (mine || namesApprover(g, who.subject)));
            if (wanted.length === 0) continue;
            // WITH THE RENDERED QUESTION, not just the record. A queue that lists gates
            // without saying what each one asks is a queue people clear rather than read —
            // and here it is worse than that, because `GET /runs/:id` is closed to a
            // non-owner, so this is the ONLY place the question can reach the person being
            // asked. The rendered half lives in the broker's memory, so a run this process
            // never attached contributes the record and no payload.
            const rendered = new Map((await engine.openGates(summary.runId)).map((g) => [g.gateId, g] as const));
            // PER RUN, because a cross-run queue spans graphs: the classification that decides
            // what a payload may say is declared by the graph THAT run compiled, and hoisting
            // this out of the loop would redact one run's channels by another's spec.
            const graph = this.#graphByHash(p.graphHash);
            for (const g of wanted) {
              out.push({ runId: summary.runId, ...gateWire(g, rendered.get(g.gateId), graph) });
            }
          }
          // SAID OUT LOUD, because a queue that silently drops a question an approver is
          // waiting on is worse than one that admits it is incomplete. `scanned` is how far
          // back the walk got; anything older than that is not represented.
          send(res, 200, { gates: out, truncated: truncated || scanned >= MAX_QUEUE_SCAN, scanned });
        },
      },

      {
        method: "GET",
        pattern: /^\/runs$/,
        // THE CHEAP PREDICATE, and the only route that uses it: mine, plus the ones nobody
        // owns, plus everything for an operator. It answers from the read-model column with
        // no fold, which is what keeps a 4-second console poll from folding every run in the
        // journal. An approver who is not the submitter does NOT find their run here; they
        // find their question on `GET /gates`, which is the route that exists for it.
        handle: async ({ res, url, auth }) => {
          const who = mustAuth(auth);
          const limit = pageLimit(url.searchParams.get("limit"));
          const runs = who.operator === true ? await store.listRuns(limit) : await store.listRuns(limit, { submittedByOrUnowned: who.subject });
          send(res, 200, { runs });
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)$/,
        // 404 means "no such run", never "not yours" — so a caller cannot use this route to
        // learn that a run exists.
        handle: async ({ res, params, auth }) => {
          const runId = runIdIn(params[0]!);
          const p = await engine.projection(runId);
          if (p === undefined || !ownsRun(p, mustAuth(auth))) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
          send(res, 200, this.#summary(p));
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/events$/,
        // Scoped inside `#streamEvents`, before its 200 is written — see the note there
        // about why the check cannot live out here.
        handle: async (ctx) => this.#streamEvents(ctx),
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/trace$/,
        /**
         * THE RUN'S TRACE, OVER HTTP — the half of TODO C.4 that is a pull rather than a push.
         *
         * `spansFrom` has produced a full span tree for several waves and the only thing that
         * could read it was `loom trace`, on the machine holding the journal. That is a
         * telemetry system nothing can observe: a console cannot draw a waterfall, and an
         * operator debugging a run on a control plane has to `ssh` to the box the journal is
         * on. This route is the read; `telemetry/otlp.ts`'s exporter is the push. They share
         * one encoder, so what a collector receives and what this answers cannot drift.
         *
         * `?format=otlp` GIVES THE COLLECTOR'S OWN BYTES, which is the point rather than a
         * convenience: an operator can `curl … | tee` it straight into a collector, and a
         * deployment that cannot reach a collector from the engine process — the common shape
         * behind a NAT — can have something else pull and forward. The default is the raw
         * `Span[]`, because that is what a console draws and it is one JSON parse from useful.
         *
         * IT DOES NOT SPLICE SUBGRAPHS, AND THAT IS THE DESIGN. A child run is its own trace
         * (`traceId` is `digest(runId)`), and `spansFrom` already mints a cross-trace
         * `SpanLink` for it — which under `format=otlp` is a real OTLP `Link{traceId, spanId}`
         * a collector resolves by itself. The intended shape is that a caller follows the link
         * with a second GET on `/runs/<childRunId>/trace`, which keeps each fetch's
         * authorization scoped to one run instead of silently widening it to every descendant.
         *
         * **THAT SECOND GET HAS TO BE PERCENT-ENCODED, AND UNTIL §A.36 IT COULD NOT BE MADE
         * AT ALL.** A child run id is `${parent}~${nodeId@branchPath#iteration}`, so it
         * carries `@` and `#`, and this route's capture used to be `([^/]+)` read straight out
         * of `params[0]` — so `%23` never became `#`, the store held no such key, and the run
         * was unreachable by URL while `GET /runs` listed it by its real id. Every run-id
         * capture on this plane now resolves through `runIdIn`, which is `safeDecode`; that
         * helper's docstring names the nine routes and argues why decoding widens no
         * authorization. `curl -G --data-urlencode` or one `encodeURIComponent` builds the
         * link, and `test/server/child-run-by-url.test.ts` fetches a real child's trace that
         * way. `TODO.md` §A.36 was the row; it said "three routes" and the grep said nine.
         *
         * `loom trace` SPLICES WHAT IT RENDERS AND DOES NOT SPLICE WHAT IT EXPORTS, and the
         * split is this route's rule applied twice rather than an inconsistency. A terminal
         * has no collector to do the join, so the picture is spliced; `--otlp` does have one,
         * so it sends one request per run and lets the collector walk the link. It could not
         * do otherwise even if it wanted to: `spliceSubgraph` REWRITES the child's `traceId`
         * onto the parent's, so a spliced export would put the same child spans on the wire
         * under a different id than this route answers for them — two doors disagreeing about
         * the identity of one span, which is what sharing one encoder exists to prevent.
         *
         * REDACTION IS THE FOLD'S, NOT THIS FILE'S, and the difference from the five
         * projection routes is worth stating because it looks like an omission. Those routes
         * carry channel VALUES, so they redact by the graph the run compiled; a span carries
         * no channel value — `state.reduced` contributes two hashes, and those are classified
         * `pii` in `ATTRIBUTE_CLASSES` and tokenised or dropped by `spansFrom`'s own
         * `redactAttributes` under a run-scoped key. Adding a second redactor here would
         * re-redact already-redacted text; the thing that must not happen is a THIRD fold,
         * and there is only one.
         *
         * BOUNDED, because a journal is the one input a caller supplies without limit and this
         * route materialises it. Past `MAX_TRACE_EVENTS` the fold is over a PREFIX, which
         * `spansFrom` renders honestly — unclosed spans get `status: "unset"` and an endTime at
         * the last event seen, exactly as an in-flight run does — and the response says
         * `truncated: true` so nobody reads a partial waterfall as a finished one.
         */
        handle: async ({ res, params, url, auth }) => {
          const runId = runIdIn(params[0]!);
          // 404 means "no such run", never "not yours" — the sibling routes' rule, and a
          // trace is reconnaissance about a run's whole shape, so it is not a weaker one.
          const p = await engine.projection(runId);
          if (p === undefined || !ownsRun(p, mustAuth(auth))) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
          const format = url.searchParams.get("format");
          if (format !== null && format !== "otlp" && format !== "spans") {
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `?format must be "spans" (the default) or "otlp", not "${format}"`);
          }
          const events: JournalEvent[] = [];
          let truncated = false;
          for await (const e of store.read(runId, 1 as Seq)) {
            if (events.length >= MAX_TRACE_EVENTS) {
              truncated = true;
              break;
            }
            events.push(e);
          }
          const spans = spansFrom(events);
          send(
            res,
            200,
            format === "otlp"
              ? otlpTraceRequest(spans, {
                  resourceAttributes: {
                    "service.name": "loom",
                    [OTLP_RUN_ID_ATTR]: runId,
                    // The `spans` branch below says this in the body; OTLP has no body field
                    // for it, so it says it here. Dropping it was this route's docstring
                    // promising a signal on one of its two branches.
                    ...(truncated ? { [OTLP_TRUNCATED_ATTR]: true } : {}),
                  },
                })
              : { runId, traceId: spans[0]?.traceId, spans, truncated },
          );
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/rewind-plan$/,
        /**
         * WHAT A REWIND WOULD UNDO, BEFORE ANYBODY AUTHORIZES IT.
         *
         * ITS OWN ROUTE RATHER THAN AN EIGHTH `commands` VERB, and — unlike `/oversight` below —
         * the reason IS the URL space rather than the journal: `commands` is a POST that acts,
         * this is a read, and the two do not belong behind one method. It answers the question
         * the `rewind` command's `planHash` asks, so the pair reads as one handshake.
         *
         * A GET THAT WRITES ONE ROW, which is the honest description and is why it is worth
         * stating. `Engine.planRewind` journals `operator.command{kind:"rewind.plan"}` so the
         * plan an operator was shown survives a restart — that is the half an inline confirm
         * callback cannot have. The append is IDEMPOTENT on the plan hash, so a console polling
         * this route writes once and not once per poll, which is what keeps a GET honest enough
         * to stay a GET.
         *
         * A HUMAN, AND `ownsRun`. The engine refuses a non-human caller, so this is a 403 for a
         * service token exactly as the `rewind` command is: gating the act while publishing the
         * reconnaissance — here are the run's undoable real-world effects, keyed and named —
         * would not be a floor. `ownsRun` for the same reason the command route asks it: being
         * an approver on one gate is not a key to the run.
         */
        handle: async ({ res, params, url, auth }) => {
          const runId = runIdIn(params[0]!);
          const who = mustAuth(auth);
          const existing = await engine.projection(runId);
          if (existing === undefined || !ownsRun(existing, who)) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
          const raw = url.searchParams.get("atSeq");
          const atSeq = raw === null ? Number.NaN : Number(raw);
          if (!Number.isSafeInteger(atSeq)) {
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `"atSeq" must be an integer seq to rewind to, not ${raw === null ? "absent" : `"${raw}"`}`);
          }
          // The bind the `rewind` command makes, for the same reason: the plan's third state is
          // "this engine cannot dispatch this", and a preview taken before the graph was bound
          // would report a rewind as undispatchable that the command would then run.
          await this.#bindFromIndex(runId);
          send(res, 200, await engine.planRewind(runId, atSeq as Seq, commandActor(auth) as HumanActor));
        },
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/commands$/,
        // Being named an approver on a run's gate lets you ANSWER the gate; it must not let
        // you cancel somebody else's run, so this route asks `ownsRun` — owner, unowned, or
        // operator — and never the wider gate rule.
        handle: async ({ res, params, body, auth }) => {
          const runId = runIdIn(params[0]!);
          const who = mustAuth(auth);
          const existing = await engine.projection(runId);
          if (existing === undefined || !ownsRun(existing, who)) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
          const cmd = await body();
          // WHO RAN THE COMMAND, on the envelope rather than in the payload, because a
          // cancel is caused by the caller directly — the split `SubmittedBy` documents.
          const by = commandActor(auth);
          // Bound before dispatch: `cancel`, `rewind` and `advance` all require the run to be
          // attached, and this plane attached nothing until now. A miss still 404s, which is the
          // honest answer — this deployment does not hold that graph.
          //
          // `cancel` NO LONGER DEPENDS ON THE LOOKUP, which was the gap this note used to record.
          // It runs no graph code — `#cancelTree` is "a projection and two appends" — and it is
          // what an operator reaches for when a graph has drifted, so `Engine.cancel` folds the
          // journal itself now rather than going through `#require`. The bind below still runs,
          // because `rewind` and `advance` genuinely need the graph; a miss leaves cancel working
          // and those two answering 404, which is the honest split.
          await this.#bindFromIndex(runId);
          switch (cmd["kind"]) {
            case "cancel":
              // `checkedReason`, not `cmd.reason ?? "operator"` off a cast — the value is
              // journaled on `operator.command` and quoted into every gate this closes.
              send(res, 200, this.#summary(await engine.cancel(runId, checkedReason(cmd["reason"], "operator"), by)));
              return;
            // NEITHER NEEDS THE BIND ABOVE, the same as `cancel`: both are a projection and two
            // appends. They are here rather than behind a second route because "what a human
            // did to this run" is one audit question, and `operator.command` is one answer.
            case "pause":
              send(res, 200, this.#summary(await engine.pause(runId, checkedReason(cmd["reason"], "operator"), by)));
              return;
            case "resume":
              send(res, 200, this.#summary(await engine.resume(runId, checkedReason(cmd["reason"], "operator"), by)));
              return;
            case "steer": {
              // SHAPE CHECKED HERE, LEGALITY CHECKED IN THE ENGINE. This route's job is to
              // refuse a body that is not a steer at all; whether the edges leave the node is
              // a question only the compiled graph answers, and `Engine.steer` asks it.
              const nodeId: unknown = cmd["node"];
              const take: unknown = cmd["take"];
              if (typeof nodeId !== "string") {
                throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `steer requires "node": the node whose route is overridden`);
              }
              if (!Array.isArray(take) || !take.every((t) => typeof t === "string")) {
                throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `steer requires "take": an array of edge ids`);
              }
              // `by` IS THE CALLER, and `Engine.steer` refuses a non-human one. A plane
              // authenticated by a service token therefore cannot steer, which is the point:
              // an operator may take a route with less oversight on it because they are a
              // person, and `commandActor` is where that person's identity comes from.
              send(
                res,
                200,
                this.#summary(
                  await engine.steer(
                    runId,
                    { nodeId: nodeId as NodeId, take: take as EdgeId[] },
                    checkedReason(cmd["reason"], "operator"),
                    by as HumanActor,
                  ),
                ),
              );
              return;
            }
            case "rewind": {
              const atSeq: unknown = cmd["atSeq"];
              if (typeof atSeq !== "number") {
                throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, "rewind requires atSeq");
              }
              // `by` IS THE CALLER, and `Engine.rewind` refuses a non-human one, exactly as
              // `steer` above does. This is the SECOND verb on this route to leave the group
              // that takes `commandActor`'s answer whatever it is, and the reason is stronger
              // than steer's: a rewind dispatches real-world undos and can suppress a
              // `gate.decided` a person spent their judgement on.
              //
              // IT IS A 403 WHERE A SERVICE TOKEN USED TO GET A 200 — measured before the
              // change, an `identify` returning `{kind: "service", subject: "svc:deployer"}`
              // rewound to seq 2 and the marker was journaled `system:principal:svc:deployer`.
              // A tightening is allowed and this one is required, but it is a behaviour an
              // operator meets in production, so the engine's refusal names both ways out:
              // authenticate as a person, or use `cancel`, which still accepts this caller.
              //
              // `planHash` IS THE OPERATOR'S ANSWER TO `GET /runs/:id/rewind-plan`, and a body
              // without one is a 400 here rather than a defaulted call. The engine refuses it too
              // — that check is the floor and this one is the error message: "rewind requires
              // planHash" reaches a caller who typed the request, where the engine's refusal
              // reaches a caller who wrote a program. Shape here, decision in the engine, which
              // is the split `steer` above already draws.
              //
              // AND IT IS CHECKED ONLY FOR A HUMAN CALLER, which is a refusal ORDER rather than a
              // weaker rule. `Engine.rewind` refuses a non-human FIRST and refuses a missing hash
              // second; a 400 raised here ahead of both would answer "your body is malformed" to
              // a service token whose real answer is 403, and it would lose the message that
              // names `--identity-file`. Measured as exactly that regression: an anonymous plane's
              // rewind returned 400 where the floor requires 403. The engine still refuses a
              // missing hash from a human, so nothing is loosened by deferring.
              const planHash: unknown = cmd["planHash"];
              if ((by as HumanActor).kind === "human" && (typeof planHash !== "string" || planHash.length === 0)) {
                throw err.validation(
                  CODES.E_PROVIDER_BAD_REQUEST,
                  `rewind requires "planHash": GET /runs/${runId}/rewind-plan?atSeq=${String(atSeq)} and send back the "planHash" it returns. ` +
                    `A rewind dispatches real-world undos, and an authorization for a list nobody saw is not one`,
                );
              }
              send(
                res,
                200,
                this.#summary(
                  await engine.rewind(runId, atSeq, checkedReason(cmd["reason"], "operator"), by as HumanActor, {
                    // A non-string reaches the engine as an empty hash, which the engine refuses.
                    // Passing it through unchanged and letting the floor decide is the fail-closed
                    // reading; coercing it to something plausible here would not be.
                    planHash: typeof planHash === "string" ? planHash : "",
                  }),
                ),
              );
              return;
            }
            case "advance":
              send(res, 200, this.#summary(await engine.advance(runId)));
              return;
            default:
              throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `unknown command "${String(cmd["kind"])}"`);
          }
        },
      },

      {
        method: "POST",
        pattern: /^\/runs\/([^/]+)\/oversight$/,
        /**
         * THE ONE ROUTE THAT LOWERS SOMETHING. Every other write on this plane tightens.
         *
         * ITS OWN ROUTE RATHER THAN A SEVENTH `commands` VERB, and the reason is the journal
         * rather than the URL space: `POST /runs/:id/commands` journals `operator.command`,
         * and a de-escalation is already `policy.deescalated` — it folds into `p.ceilings`,
         * `PolicyEngine.restore` re-seeds it, and `replay.ts` replays it as a human input.
         * Two durable vocabularies for one fact is exactly what that separation avoids, and
         * an auditor asking "what lowered oversight on this run" must have one place to look.
         *
         * `ownsRun`, NEVER `mayReachGates`. Being named an approver on one of this run's gates
         * is a grant to answer one question; it is not a key to the run's oversight posture.
         *
         * IT ADDS ONE REFUSAL AND REIMPLEMENTS NONE. `PolicyEngine.deescalate` refuses a
         * non-`human` actor, a deny-listed identity from three separate sources in descending
         * order of authority, and a blank justification; `#ceilingScope` below refuses a scope
         * naming another run. The refusal that is this route's own is for the case the library
         * never had: a caller the perimeter could not identify. `#decider` mints
         * `(unidentified)` for every non-human credential — the shared bearer token included,
         * which arrives as `(shared-token)` and collapses to it — and that is a statement about
         * the perimeter rather than a person, so it is refused HERE, before the engine, and
         * never allowed to fall back to the run's owner.
         */
        handle: async ({ res, params, body, auth }) => {
          const runId = runIdIn(params[0]!);
          const who = mustAuth(auth);
          const existing = await engine.projection(runId);
          if (existing === undefined || !ownsRun(existing, who)) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
          const input = await body();
          const claimed: unknown = input["actor"];
          if (claimed !== undefined && typeof claimed !== "string") {
            throw err.validation(CODES.E_PROVIDER_BAD_REQUEST, `"actor" must be a subject string when it is present, not ${typeof claimed}`);
          }
          const actor = this.#decider(auth, claimed);
          // UNCONDITIONAL, and that is the difference from `#refuseUnidentifiedApproval`, which
          // this route deliberately does NOT reuse: that one returns silently when the gate
          // names no approvers, because a gate naming nobody is answerable by whoever can
          // reach it. There is no such case here. Nothing in the graph can name a principal
          // as entitled to lower oversight, so "the perimeter identified nobody" is the whole
          // answer and it is a refusal.
          if (isSyntheticSubject(actor.subject) || SYNTHETIC_SUBJECTS.includes(actor.subject)) {
            throw err.policy(
              CODES.E_OVERSIGHT_LOOSEN_FORBIDDEN,
              `this credential identifies no person (method "${auth?.method ?? "none"}", subject "${actor.subject}"), and only a human may lower oversight. ` +
                `"${actor.subject}" is what this perimeter concluded, not somebody who can be held to a justification. ` +
                `Present a per-subject credential from an identity source — the shared bearer token authenticates a deployment.`,
            );
          }
          const scope = ceilingScopeOf(input["scope"], runId);
          const to = postureOf(input["to"]);
          const why = justificationOf(input["why"]);
          // AFTER every refusal above, so nothing an unauthorized caller sends makes this
          // process go looking for a graph — the ordering `POST /runs/:id/gates/:gateId` uses.
          await this.#bindFromIndex(runId);
          // A run this engine holds no context for is `E_RUN_NOT_FOUND` from `Engine.#require`,
          // never a silently-created ceiling on a run nobody folded.
          const p = await engine.deescalate(runId, scope, to, why, { kind: "human", id: actor.subject }, actor.via);
          send(res, 200, { runId, scope, from: existing.ceilings[scope], to, ceiling: p.ceilings[scope], justification: why });
        },
      },

      {
        method: "GET",
        pattern: /^\/runs\/([^/]+)\/gates$/,
        handle: async ({ res, params, auth }) => {
          const runId = runIdIn(params[0]!);
          const who = mustAuth(auth);
          const p = await engine.projection(runId);
          if (p === undefined || !mayReachGates(p, who)) throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          // Joined with the rendered payload where the broker still has it. A queue that
          // lists gates without saying what each one asks is a queue people clear rather
          // than read — and for a `subgraph` gate the question is in another run entirely.
          //
          // ONE ERROR IS EXPECTED HERE AND EVERYTHING ELSE IS NOT, and the catch used to
          // take both. A bare `catch(() => [])` answered 200 with a payload-less queue when
          // the broker's own read failed — the same list an operator sees on a healthy
          // restarted process, so a failure and a normal condition rendered identically.
          //
          // THE CASE IT NAMES IS NO LONGER REACHABLE, and the sentence is kept narrow rather
          // than deleted because the catch is still the right shape. `openGates` used to
          // throw `E_RUN_NOT_FOUND` for a run this engine had not attached; `Engine` now
          // falls back to `#logFor` for exactly that case ("a run this engine holds no
          // context for is not an unknown run"), so after a restart the gates arrive from
          // the journal and only the RENDERED payloads are missing, which is what the
          // ephemeral map being empty already means.
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
          // journal order. The residue is recorded in `design/loom/05-RESOURCES-OBSERVABILITY.md (deleted at f975f9f)` §3 with
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
          // AND THE LIST IS FILTERED TO THE GATES THIS CALLER IS ADMITTED TO, which is a
          // second decision from the one that let them through the door. Reaching this route
          // by being named on ONE gate must not hand over the rendered payload of every
          // OTHER gate on the run — those payloads carry the node's readable channel values,
          // and a question nobody asked this caller is a question they were not meant to see.
          // The submitter and an operator see the whole queue, because for them the run is
          // the unit; a named approver sees the questions addressed to them, plus the ones
          // addressed to nobody, which anyone reaching this run may already answer.
          //
          // AND AN UNRESTRICTED GATE IS NOT IN A STRANGER'S LIST, which the first version got
          // the other way round. "A gate that names nobody is answerable by whoever reaches
          // it" is true about DECIDING and says nothing about publishing: the same commit
          // enforces the opposite rule one route over, on `GET /gates`, with the argument
          // that answerable-by-whoever-reaches-it must not mean published-to-everyone. Two
          // routes over one set of gates must not disagree about who sees them, and the
          // narrower answer is the right one — a non-owner sees the questions ADDRESSED to
          // them.
          const visible = (g: GateRecord): boolean => ownsRun(p, who) || namesApprover(g, who.subject);
          const open = Object.values(p.gates).filter((g) => g.state === "open" && visible(g));
          // Partitioned rather than sorted with a `?? Infinity` key: `Infinity - Infinity` is
          // `NaN`, and a comparator that answers `NaN` for a pair silently discards the whole
          // ordering — the same inconsistent-comparator bug REGISTER A18 measured in
          // `spansFrom`'s `startTime` sort. Ranked gates in the queue's order, then the rest
          // in journal order, and each gate is emitted exactly once.
          const byId = new Map(detailed.map((g) => [g.gateId, g]));
          const graph = this.#graphByHash(p.graphHash);
          const wire = (g: (typeof open)[number]): unknown => gateWire(g, byId.get(g.gateId), graph);
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
          const runId = runIdIn(params[0]!);
          const gateId = params[1] as GateId;
          // A DOOR PRE-FILTER, NOT THE AUTHORIZATION. `HumanGateBroker.#authorize` is the
          // one chain, for this door and the four others, and it would refuse a decision this
          // check lets through whenever the gate names somebody else. What this adds is the
          // half `#authorize` cannot see: a gate that names NOBODY is answerable by whoever
          // can reach it, and after ownership "whoever can reach it" is a real set rather
          // than "everyone with a credential". `gates.ts` permits exactly this — callers may
          // keep their own checks as defence in depth; none of them may be the only one.
          const reachable = await engine.projection(runId);
          if (reachable === undefined || !mayReachGates(reachable, mustAuth(auth))) {
            throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
          }
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

          // AFTER `mayReachGates` above and after the decision is checked, so nothing a stranger
          // sends makes this process go looking for a graph.
          await this.#bindFromIndex(runId);

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
            //
            // AND THE DEFAULT SLOT CARRIES THE DECISION, which is the half that namespacing
            // by principal left standing: `String(gateId)` is the same string for every
            // decision one person ever sends about one gate, so their approve and their
            // later reject shared a slot. `#resolveOnce` tests the seen-key map BEFORE
            // `gate.state !== "open"`, so the second one returned `{resolved:false}` and this
            // route answered 200 — the sentence above, produced by the line under it.
            // Measured: `bob reject -> 200 {"decision":"reject"}` with `gate.decided` saying
            // approve and the guarded write already done.
            //
            // AN EXPLICIT HEADER STILL COLLAPSES A GENUINE RETRY, unchanged: a sender that
            // keys per message keeps one slot per message. What the default now says is
            // "this exact decision, from this principal, on this gate", so a DIFFERENT
            // decision falls through to the gate's own state check and gets the 409 it
            // deserves. It opens no memory vector: an entry is recorded only on a decision
            // that commits, and a gate commits once.
            //
            // OVER `checkedDecision`'s OUTPUT, never the raw body: that call constructs a
            // fresh checked object, so the caller cannot choose which of its fields the key
            // is made of.
            //
            // **AND CANONICALLY, BECAUSE THAT OBJECT IS NOT AS FRESH AS IT LOOKS.** The
            // `edit` arm of `gateDecisionOf` carries `writes` through BY REFERENCE, so
            // `JSON.stringify` of it was serialising the caller's own object in the caller's
            // own key order, at every depth. Two byte-different spellings of ONE edit are
            // then two slots, and the second one is not a retry any more: measured on the
            // skeleton's gate, `{"merged":{"a":1,"b":2}}` answered **200** and the same edit
            // re-sent as `{"merged":{"b":2,"a":1}}` answered **409 E_GATE_ALREADY_RESOLVED**,
            // where the identical bytes twice answer 200 and 200. `canonicalize` sorts keys,
            // so one decision is one key however its sender spelled it — and it refuses the
            // shapes it cannot order, which the journal this decision is about to be written
            // to refuses too.
            //
            // THAT REFUSAL IS THE CALLER'S, SO IT IS REPORTED AS THE CALLER'S. `canonicalize`
            // throws a `CanonicalizationError`, which is not a `LoomError`, so `httpStatusFor`
            // read no class off it and the route answered **500** for a body the caller wrote:
            // `{"decision":{"kind":"edit","writes":{"x":1e999}}}` parses to `Infinity`, which
            // `JSON.stringify` used to render as `null` and canonical form refuses outright.
            // Refusing is right and 500 is not — an internal error says the server is broken.
            idempotencyKey: idempotencySlot(auth, header(req, "idempotency-key") ?? `${String(gateId)}:${gateDecisionSlot(decision)}`),
          });
          // THE RESPONSE IS SCOPED TOO, and forgetting that made every other check on this
          // route decorative. `summarise` carries the run's channels, outputs, usage, every
          // task and every gate — strictly more than `GET /runs/:id`, which answers 404 to
          // exactly this caller, and strictly more than `GET /runs/:id/gates`, which filters
          // per gate. An approver who answered one question was handed the whole run as the
          // reply. A door that refuses a read and then performs it in the response to a write
          // is not a door.
          //
          // AND IT ECHOES THE RECORDED DECISION, NOT THE SUBMITTED ONE. This read
          // `decision.kind` — the value the caller had just sent — so the non-owner branch
          // reported what was ASKED FOR while the owner branch (`#summary`, through
          // `gateRecordWire`) reported what the journal holds. Two branches of one `send`
          // disagreeing about one gate is how "your rejection succeeded" got said about an
          // approval that stands. The slot above closes the path that reached it; this
          // closes the shape, because a door that reports a write must report what the
          // write did.
          //
          // The fallback is the submitted kind and it is not a guess: the only way here
          // with no gate in the projection is a decision the fold did not record, and
          // there is nothing truer to say about that than what was asked.
          send(
            res,
            200,
            ownsRun(p, mustAuth(auth)) ? this.#summary(p) : { runId, gateId, status: p.status, decision: gateOf(p, gateId)?.decision ?? decision.kind },
          );
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
              handle: async ({ req, res, params, raw, signal }: RequestContext): Promise<void> => {
                // `raw()` and not `body()`: the signature is over the bytes as sent, and
                // re-serializing a parsed object would verify a string nobody signed.
                const out = await this.#callbacks!.handle({
                  runId: runIdIn(params[0]!),
                  channel: safeDecode(params[1]!),
                  body: await raw(),
                  headers: headerMap(req),
                  signal,
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
   * `GRAPH020_UNKNOWN_FIELD` on an `approval` block and for a reason worth stating: whether
   * identity exists is deployment configuration, not graph configuration. The same graph is
   * perfectly answerable in a deployment with an identity source and unanswerable in one
   * without, and the compiler sees neither. What the compiler CAN refuse — an approval
   * rule it has no vocabulary for at all — it still does. `startControlPlane`
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
   * output, never through a second read of the input — which is REGISTER A12's sweep, and it is
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
   *
   * ## THE READER'S SPEED IS `res.write`'s ANSWER, AND IT USED TO BE DISCARDED
   *
   * Both loops below ignored what `write` returned, so nothing in this handler ever slowed
   * down for a client that had stopped reading — and the bus's 1024-slot queue could not
   * make up for it, because `Channel.push` hands an event to a parked waiter and returns
   * BEFORE the queue-length test. A synchronous loop body re-parks a waiter within a
   * microtask after every delivery, so the bound that exists to hold a slow subscriber was
   * never reached and the growth moved into `ServerResponse`'s userland buffer instead,
   * where nothing counts it and `Subscription.dropped` reports 0. Measured with a paused
   * reader: 20 000 events of ~1 KB left `writableLength` at 22 459 002 bytes.
   *
   * And when the loop DOES fall behind enough to fill the queue, `drop_oldest` discards
   * from the OLD end — a hole in the middle of the one stream whose stated contract is
   * that the client never silently misses an event. Measured at 4000 events: 3025
   * delivered, 976 holes, `1025 → 1027 → 1029 …`, ending on the run's real head so nothing
   * downstream could tell.
   *
   * So: `write` reports back-up, both loops `await drained(res)` on it, and the
   * subscription is `onOverflow: "close"`. A client that falls far enough behind is CUT —
   * the response ENDS, which is a signal — and `EventSource` reconnects with
   * `Last-Event-ID` and replays from the journal, gap-free, because the journal and not
   * this stream is the truth. That is invariant 8 in its exact shape: the backpressure
   * lands on admission to this stream, never on what is durable. Peak buffering per
   * connection is now one frame plus the socket's high-water mark.
   */
  async #streamEvents(ctx: RequestContext): Promise<void> {
    const { res, req, params } = ctx;
    const runId = runIdIn(params[0]!);
    const bus = this.#bus;

    // EXISTENCE AND OWNERSHIP, CHECKED TOGETHER AND BEFORE THE 200.
    //
    // This route has no 404 to add a scope to: `head` answers `0` for a run that has never
    // existed and the header is written unconditionally, so `GET /runs/r_madeup/events`
    // streams. Adding "404 if not yours" while leaving the unknown case at 200 would build a
    // clean existence oracle — exactly what the sibling route's "404 means 'no such run',
    // never 'not yours'" exists to prevent — so both cases answer identically, and they are
    // answered here rather than in the route table because the check has to happen before
    // `writeHead`, which this method owns.
    const scope = await this.#engine.projection(runId);
    if (scope === undefined || !ownsRun(scope, mustAuth(ctx.auth))) {
      throw err.notFound(CODES.E_RUN_NOT_FOUND, `run ${runId} not found`);
    }

    // READ ONCE, HERE, AND NOT PER FRAME. `#graphByHash` scans the deployment's inventory,
    // and this stream emits a frame per journal event — a run with a 10 000-event head would
    // pay the scan 10 000 times for an answer that cannot change, because `graphHash` is
    // fixed at submission and `Engine` refuses any graph that is not the one the run
    // compiled. The hash comes off the projection this route already had to read for its
    // ownership scope, so nothing extra is fetched.
    //
    // `undefined` — a run whose graph this deployment does not hold — is the fail-closed
    // case, and what it costs is stated in `redactChannels`: the stream still delivers every
    // event, its seq, its type and its actor; only the channel VALUES are withheld.
    const graph = this.#graphByHash(scope.graphHash);

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
    // AND SENT, NOT MERELY SET. `writeHead` fills a buffer that Node flushes with the first body
    // write, and this handler's first body write is the first EVENT — so a client that reconnects
    // caught up at head got a socket with a request on it and nothing coming back. Measured with
    // `curl -sN -D -` and `last-event-id: <head>`: five seconds, ZERO bytes, not even the status
    // line; with `last-event-id: 0` the headers came out at once, because a backlog existed to
    // push them. Two things follow from that and only the second is cosmetic: an intermediary
    // with an idle-response timeout cuts a stream that has emitted nothing, and the console's
    // connection pill never reaches "live" because `follow` sets it after `res.ok`, which is
    // after the headers arrive. `x-accel-buffering: no` one line up is the same intention aimed
    // at a proxy; this is the one aimed at the process's own socket.
    res.flushHeaders();

    // FALSE MEANS "STOP", and it is the last write's answer because the three are one
    // frame: once the buffer is over its high-water mark every write in the frame answers
    // false, and while it is under, only the last one can be the write that crosses it.
    const write = (event: string, id: number | undefined, data: unknown): boolean => {
      if (id !== undefined) res.write(`id: ${id}\n`);
      res.write(`event: ${event}\n`);
      return res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    // SUBSCRIBE BEFORE THE BASELINE, not after it.
    //
    // The baseline and the live tail are two sources, and the handler parks between them
    // whenever a slow client makes `write` report back-up. Subscribing afterwards meant an
    // event published during that park landed in neither: past the journal read's upper
    // bound, and before the subscription existed. That is a contiguous hole in the MIDDLE
    // of the stream — the exact shape this route refuses `drop_oldest` to avoid. The
    // subscription buffers while the baseline drains, and `sent` is what de-duplicates the
    // overlap.
    const sub = bus?.subscribe({ runId }, { queueSize: 1024, onOverflow: "close" });
    if (sub !== undefined) req.on("close", () => sub.dispose());

    let sent = resumed;
    if (!resumable || head - lastSeq > hot) {
      const p = await this.#engine.projection(runId);
      if (p !== undefined) {
        if (!write("snapshot", p.seq, this.#summary(p))) await drained(res);
        sent = Math.max(sent, p.seq);
      }
    } else {
      // `resumed`, not `lastSeq`. Equal on this branch — it is only reached when `resumable`
      // — and written this way so the validated value has ONE consumption point rather than
      // two spellings a later change can move apart, which is precisely how the live tail
      // below came to be reading the unvalidated one.
      for await (const e of this.#store.read(runId, resumed + 1)) {
        if (!write("event", e.seq, frame(e, graph))) await drained(res);
        sent = e.seq;
        // THE REPLAY BRANCH IS NOT THE COLD PATH IT SOUNDS LIKE: `lastSeq = 0` with a head
        // under `hotWindow` satisfies `resumable`, so EVERY fresh connection to a run with
        // fewer than 10 000 events comes through here. A client that vanished mid-replay
        // would otherwise have the whole journal read and serialised at it.
        if (res.writableEnded || res.destroyed) return;
      }
    }

    // `close`, not `drop_oldest`, and the two are not "the same loss with a different
    // signal": `drop_oldest` cuts at the OLD end, which is a hole this route promises it
    // will not have, while `close` cuts at the new end and leaves a contiguous prefix the
    // client can resume from. This handler's own contract is what decides it.
    if (sub === undefined) {
      res.end();
      return;
    }

    try {
      for await (const e of sub) {
        if (e.seq <= sent) continue;
        if (!write("event", e.seq, frame(e, graph))) await drained(res);
        if (res.writableEnded || res.destroyed) break;
        if (e.type === "run.completed" || e.type === "run.failed" || e.type === "run.cancelled") break;
      }
    } catch (e) {
      // A client that fell too far behind, ended rather than truncated. Without this the
      // throw reaches `#dispatch`, whose `send` no-ops on a response with headers already
      // sent — survivable, but it logs a 500 for an ordinary slow reader.
      if (!(e instanceof SubscriberOverflowError)) throw e;
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
 * A caller-supplied string on its way into a message. Bounded, because a header is not — AND
 * SANITISED, because every call site here lands the result in a 4xx JSON body an operator's own
 * tooling may print to a terminal, and a control byte in that body can forge or hide what gets
 * shown there: `\x1b[` forges color and cursor movement, `\r`/`\n` forges a second log line, a
 * raw NUL truncates whatever reads it next.
 *
 * MEASURED, NOT ASSUMED: today's callers are all header values, and Node's default HTTP parser
 * refuses any header carrying a C0 control or DEL — `X-Test: a\x1bb` closes the connection with a
 * plain 400, before this function or anything upstream of it ever runs. That is why the sanitiser
 * is exercised directly here rather than through a live request: no request carrying the bytes
 * this guards against can reach it while the parser stays strict. It stops being true the moment
 * a deployment sets `insecureHTTPParser: true` — Node then hands those same bytes straight
 * through — or the moment a call site reads something other than a header value, so this is
 * defence for that day rather than for one that has already been ruled out.
 *
 * One replacement character per control byte, so the 120-character bound this function has
 * always kept is unchanged for the plain strings that are the overwhelming common case.
 */
export function truncate(v: string): string {
  // eslint-disable-next-line no-control-regex -- the C0 range plus DEL IS the thing being matched
  const safe = /[\x00-\x1f\x7f]/.test(v) ? v.replace(/[\x00-\x1f\x7f]/g, "�") : v;
  return safe.length <= 120 ? safe : `${safe.slice(0, 120)}…`;
}

/**
 * WHY this request is another site's, or `undefined` if it is not one.
 *
 * Two rungs, because they fail on different browsers and cover different attacks.
 *
 * `Sec-Fetch-Site` FIRST. The browser sets it, page script cannot forge it — it is a
 * forbidden header name — and it is the only one of the two present on a NAVIGATION,
 * which is the case with no CORS semantics at all: `<form method="POST"
 * enctype="text/plain">` posts a body `JSON.parse` accepts, from any page, with no
 * JavaScript and no preflight. `same-site` is refused with `cross-site`: a sibling
 * subdomain is a different origin and there is no cookie here for "site" to be the right
 * boundary of. `none` is a user-initiated load — the address bar, a bookmark — and passes.
 *
 * Then `Origin`, for a browser too old to send the first. **ABSENT MUST PASS.** curl, the
 * CLI, every webhook sender and every service client send no `Origin`; refusing on absence
 * would turn this into a browser-only API, which is the opposite of a perimeter. `"null"`
 * — the opaque origin of a sandboxed iframe or a `data:` document — is REFUSED rather than
 * read as absent: declining to name yourself is a claim, not a silence. An origin that is
 * not a URL is refused for the same reason.
 *
 * The comparison is HOST only, not scheme: a plane behind a TLS-terminating proxy sees
 * `https://…` from the browser and `http://…` in `requestUrl`, and refusing that would
 * break the deployment shape this guard is least worried about.
 *
 * GET IS NOT EXEMPT, though every route here is read-only, and the exemption is what a
 * first draft reaches for so a cross-site link to the console keeps working. What it also
 * keeps working is `<iframe src="http://127.0.0.1:8787/">` on an attacker's page, with the
 * console's approve buttons positioned under something worth clicking. One rule, no method
 * carve-out, and a link to the console opened from another site is answered with a 403
 * that says how to open it directly.
 */
function crossSite(req: IncomingMessage, url: URL): string | undefined {
  const site = header(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") return `Sec-Fetch-Site: ${truncate(site)}`;

  const origin = header(req, "origin");
  if (origin === undefined) return undefined;
  if (origin === "null") return "Origin: null";
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return `Origin: ${truncate(origin)}`;
  }
  return host.toLowerCase() === url.host.toLowerCase() ? undefined : `Origin: ${truncate(origin)}`;
}

/**
 * Wait for a backed-up response to be read, or for the reader to go away.
 *
 * **THE `close` ARM IS LOAD-BEARING.** A client that vanishes mid-backup never emits
 * `drain`, so a bare `once(res, "drain")` parks the streaming loop forever and leaks the
 * subscription with it — and the handler's existing `req.on("close", …)` cannot rescue it,
 * because that resolves the channel's waiter, which is not what this promise is waiting on.
 *
 * Both arms carry their own `catch`, and the abort comes after the race has settled: the
 * LOSER's promise rejects when the signal fires, and a rejection nobody has handled is an
 * unhandled rejection in a process whose whole arrangement exists to avoid one.
 *
 * The early return is not an optimisation. `writableNeedDrain` goes false the instant the
 * buffer clears, which can happen between the `write` that answered false and this call —
 * and `drain` has then already been emitted, so waiting for the next one waits for a write
 * this loop is not going to make.
 */
async function drained(res: ServerResponse): Promise<void> {
  if (!res.writableNeedDrain || res.writableEnded || res.destroyed) return;
  const stop = new AbortController();
  const flushed = once(res, "drain", { signal: stop.signal }).catch(() => undefined);
  const gone = once(res, "close", { signal: stop.signal }).catch(() => undefined);
  try {
    await Promise.race([flushed, gone]);
  } finally {
    stop.abort();
  }
}

/**
 * A `Last-Event-ID` PARSED as a seq, or `NaN` for anything that is not one.
 *
 * Decimal digits and nothing else, because that is the whole set of ids this server issues:
 * `#streamEvents`' `write` emits `id: ${id}` for a `number`, and a client echoes back what
 * it was sent. `Number()` accepts a great deal more than that and answers with a perfectly
 * ordinary in-range integer for most of it — see `#streamEvents`' docstring for the row of
 * measurements. `NaN` loses every comparison in `resumable`, which is the one place in this
 * codebase where that is the wanted behaviour rather than the bug (REGISTER A12), and the
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
 * about a run that was accepted 202 and never started. See REGISTER A1.
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

/**
 * The run id out of a `([^/]+)` capture — percent-decoded, on every route that takes one.
 *
 * IT EXISTS BECAUSE A CHILD RUN WAS LISTED AND UNREACHABLE. `Engine`'s subgraph node mints
 * `${parent}~${task.taskId}` and a `TaskId` is `nodeId@branchPath#iteration`, so a delegated
 * run's id contains `@` and `#` — both of which `encodeURIComponent` escapes. Read raw, the
 * capture stayed `…~delegate%40root%230`, no store held that key, and every by-id route
 * answered `E_RUN_NOT_FOUND` for a run `GET /runs` had just listed by its real id. Measured
 * before the fix: parent trace 200, child trace 404, child summary 404, both ids present in
 * the list body. `TODO.md` §A.36 says "three routes"; the count is NINE — the route table
 * holds SEVENTEEN patterns (`/usr/bin/grep -ac '^\s*pattern:' packages/core/src/server/http.ts`)
 * and nine of them capture a run id — and being wrong by six is why
 * this is a named helper rather than a call site somebody remembers to copy.
 * `/usr/bin/grep -ac 'runIdIn(params\[0\]!)' server/http.ts` answers 9.
 *
 * THE NINE, so the claim is checkable rather than "all of them": `GET /runs/:id`,
 * `GET /runs/:id/events` (via `#streamEvents`, which reads `params[0]` itself),
 * `GET /runs/:id/trace`, `GET /runs/:id/rewind-plan`, `POST /runs/:id/commands`,
 * `POST /runs/:id/oversight`, `GET /runs/:id/gates`, `POST /runs/:id/gates/:gateId`, and
 * `POST /runs/:id/callbacks/:channel`.
 *
 * IT DOES NOT WIDEN AUTHORIZATION, and that is the question worth answering rather than
 * asserting, because "the plane accepts more URLs than it did" is true:
 *
 *  - **Routing is unaffected.** `#dispatch` matches `url.pathname` — the RAW path — against
 *    the patterns, and decoding happens inside the handler after the match. Measured against
 *    a `node:http` server: `/runs/a%2Fb/trace` arrives with `pathname` still
 *    `/runs/a%2Fb/trace`, so `^\/runs\/([^/]+)\/trace$` captures `a%2Fb`, and
 *    `/runs/a%2Fb%2Ftrace` matches that pattern NOT AT ALL rather than becoming a third
 *    segment. A `%2F` therefore cannot move a request to a different route or past
 *    `#requiresBearer`, whose callback carve-out tests the same raw pathname. The set of
 *    unauthenticated requests is byte-for-byte the set it was.
 *  - **Ownership is read off the RUN, never off the URL.** `ownsRun` and `mayReachGates` take
 *    the projection this id resolved to and compare it against the credential. Decoding
 *    changes WHICH run is found; it cannot change who may see the one that is. A caller who
 *    percent-encodes somebody else's run id gets the same 404 they got before, from the same
 *    check — and it is still 404 and not 403, so the door is not an existence oracle either.
 *  - **A child run is not a back door into its parent.** It is a run in its own right with
 *    its own `submittedBy` — copied from the parent's context — so `ownsRun` gives the
 *    parent's owner their own delegation and nobody else's.
 *  - **Aliasing is harmless.** `/runs/abc` and `/runs/%61%62%63` now name one run. They
 *    resolve to one projection, so one ownership answer; the only id that reaches the journal
 *    or an idempotency key is the decoded one.
 *  - **A run id is a store KEY, never a path.** `MemoryStateStore` is a `Map` and
 *    `SqliteStateStore` binds it as a parameter, so a decoded `/` or `..` is a lookup that
 *    misses, not traversal.
 *
 * `safeDecode` AND NOT `decodeURIComponent`, for the reason stated there: `%zz` throws
 * `URIError`, the dispatcher would call that a bug in Loom, and on the callback route the
 * sender is unauthenticated. Falling back to the undecoded segment turns a stranger's
 * nonsense into the 404 it deserves.
 *
 * THE GATE ID CAPTURE IS DELIBERATELY LEFT RAW. `newGateId` is `gate_${ulid()}` — Crockford
 * base32, and nothing `encodeURIComponent` touches — so decoding it would be a no-op that
 * implies a shape gate ids do not have. The same goes for `/graphs/by-hash/:hash`, which is
 * hex.
 */
function runIdIn(segment: string): RunId {
  return safeDecode(segment) as RunId;
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
 *
 * THE DECLARED PATH IS WHOLE-VALUE; THE DETECTOR BACKSTOP IS WINDOWED. `redactPayload`
 * bounds its sweep to the first 8 KB of each string leaf by default, because a journal
 * payload is model output at whatever length a model chose and one entry in `DETECTORS` is
 * quadratic in its input — unbounded, a 1 MB pem-shaped payload parked this thread, and this
 * one thread also carries every other request and every SSE frame. Nothing is truncated and
 * the classification arms are unaffected; what the bound costs is a detector run that BEGINS
 * past 8 KB in one leaf. See `DETECTORS` in `security/redact.ts`.
 *
 * **AND `e.classification` IS `internal` ON EVERY EVENT THIS RUNTIME HAS EVER WRITTEN.**
 * `JournalEvent.classification` is populated at exactly one place — `journal/store.ts`'s
 * `classification: e.classification ?? DEFAULT_CLASSIFICATION`, and `DEFAULT_CLASSIFICATION`
 * is `"internal"` — because no appender anywhere sets the field. So "the event's own declared
 * classification" was a blanket `internal` sweep wearing a lookup's clothes, and `internal` is
 * the detector backstop alone. Measured over real HTTP on `GET /runs/:id/events`, a channel
 * declared `secret_ref` whose value is deliberately NOT credential-shaped so the backstop has
 * nothing to catch:
 *
 *     event run.submitted  "inputs":{…,"vaultHint":"the vault passphrase is …"}   ← before
 *     event run.submitted  "inputs":{…,"vaultHint":"[secret]"}                    ← after
 *
 * `CHANNEL_KEYED` is what closes it, through the same `redactChannels` the two gate routes
 * reach — not a third spelling. The declared classification is left in place for every other
 * type: an event whose payload is not channel data has nothing a channel spec could say about
 * it, and the day an appender starts setting the field it still decides.
 */
function frame(e: JournalEvent, graph: RunGraph | undefined): unknown {
  const key = own(CHANNEL_KEYED, e.type);
  const pair = own(CHANNEL_VALUED, e.type);
  const p = e.payload;
  return {
    seq: e.seq,
    ts: e.ts,
    type: e.type,
    taskId: e.taskId,
    actor: e.actor,
    payload:
      (key === undefined && pair === undefined) || p === null || typeof p !== "object" || Array.isArray(p)
        ? redactPayload(p, e.classification)
        : // `fromEntries`, not a spread-and-overwrite: the same `__proto__` rule
          // `redactGatePayload` states, one function over.
          Object.fromEntries(
            Object.entries(p as Record<string, unknown>).map(([k, v]) => [
              k,
              k === key
                ? redactChannels(v, graph?.spec.channels)
                : k === pair
                  ? redactBinding(v, graph?.spec.channels)
                  : redactPayload(v, e.classification),
            ]),
          ),
  };
}

/**
 * Event type → the ONE payload key under it whose value is a map keyed by CHANNEL NAME.
 *
 * THE SET IS NAMED RATHER THAN SNIFFED, because "a claim that names its members can be
 * checked" and because a payload key that merely shares a name is not a channel map — the
 * event TYPE is what decides.
 *
 * **HOW THE MEMBERS WERE FOUND, so the next person can re-derive them rather than trust this
 * list.** THREE GREPS, ONE PER SHAPE A CHANNEL VALUE CAN TRAVEL IN — and the third is here
 * because the first two versions of this note claimed one grep was the whole derivation. See
 * `CHANNEL_VALUED` for what the missing legs cost. Leg 1, the map shape:
 * `grep -an 'Record<string, unknown>' packages/core/src/journal/events.ts` returns
 * seven declarations; five are channel maps and two are not:
 *
 *   - `run.submitted.inputs`   — `spec.inputs` ⊆ channel names.
 *   - `task.committed.writes`  — a node's PROPOSED writes, before the reducer folds them.
 *     Found by a test and not by reading: an earlier draft of this list had the reduced
 *     value and not the proposal, and the same secret went out one event earlier.
 *   - `state.reduced.values`   — the reducer's result. Its sibling `channels` field is the
 *     list of NAMES, which is metadata, and stays as it is.
 *   - `gate.decided.writes`    — an approver's EDIT. `allowEdit` names which channels a gate
 *     may rewrite, so these are channel values written by a human; optional, and absent on
 *     an ordinary approve.
 *   - `run.completed.outputs`  — `collectOutputs`, which iterates `spec.outputs`.
 *
 *   - NOT `policy.escalated.detail` — a rule's evidence, keyed by whatever the rule reports.
 *   - NOT `operator.command.args` — a command's arguments, keyed by parameter name.
 *
 * `channel.written` is absent for a different reason: it carries `valueDigest`, never a value.
 *
 * Legs 2 and 3 are `CHANNEL_VALUED`'s, and they cover the shapes this grep cannot see.
 */
const CHANNEL_KEYED: Readonly<Record<string, string>> = {
  "run.submitted": "inputs",
  "task.committed": "writes",
  "state.reduced": "values",
  "gate.decided": "writes",
  "run.completed": "outputs",
};

/**
 * Event type → the ONE payload key under it whose value is a `{channel, value}` PAIR.
 *
 * A SECOND TABLE BECAUSE THERE IS A SECOND SHAPE, and the first table's derivation could not
 * see it. `CHANNEL_KEYED`'s members were found by grepping `journal/events.ts` for
 * `Record<string, unknown>` — a search that is complete for MAP-shaped fields and blind to a
 * single channel and its value declared as one pair. `task.ready.binding` is exactly that
 * shape (`events.ts:168`, `{ readonly channel: string; readonly value: unknown }`), so
 * `frame` swept it at `e.classification` — a blanket `internal`, the detector backstop —
 * and a fan-out over a `secret_ref` channel put its per-branch item on the SSE stream in the
 * clear. Measured over real HTTP on `GET /runs/:id/events`, `secrets` and `item` both
 * declared `secret_ref`, before and after:
 *
 *     "type":"task.ready","payload":{"binding":{"channel":"item","value":"courier alpha knocks three times"},…}
 *     "type":"task.ready","payload":{"binding":{"channel":"item","value":"[secret]"},…}
 *
 * **THE RE-DERIVATION, COVERING BOTH SHAPES AND A THIRD.** Leg 1 is `CHANNEL_KEYED`'s grep.
 * Leg 2 finds every field that NAMES a channel —
 * `grep -an channel packages/core/src/journal/events.ts | grep -a readonly` — six
 * declarations, and the word means two different things among them:
 *
 *   - `task.ready.binding`            — a DATA channel and its value. The member below.
 *   - `state.reduced.channels`        — the list of NAMES that moved. Metadata; stays.
 *   - `channel.written`               — `{channel, reducer, valueDigest}`. A digest, never a value.
 *   - `gate.delivered.channel`        — a DELIVERY channel: slack, email, console. Not a data
 *     channel, and its `receipt` is the transport's id, not channel data.
 *   - `gate.delivery_failed.channel`  — the same homonym.
 *   - `gate.callback_rejected.channel`— the same homonym.
 *
 * Leg 3 catches a value declared with no channel at all: `grep -an ': unknown' events.ts`
 * returns five hits, three of them field declarations — the pair above, plus
 * `effect.completed.result` and `ErrorRecord.details`. NEITHER of those two is a member, and
 * the reason is the same one: no channel NAMES them, so there is no declaration to look up and
 * the detector sweep is the only mechanism they have ever had. That is a real limitation of
 * the declared path, stated rather than papered over.
 *
 * `gate.raised` carries no channel data by construction — its own docstring: "the rendered
 * `payload` deliberately stays out" — so it is on no leg of this derivation.
 */
const CHANNEL_VALUED: Readonly<Record<string, string>> = {
  "task.ready": "binding",
};

/**
 * One `{channel, value}` pair, its value redacted under the classification THAT channel's
 * spec declared.
 *
 * IT IS `redactChannels` WITH ONE ENTRY, NOT A FOURTH SPELLING OF THE LOOKUP. The pair is
 * rebuilt as a one-key map, pushed through the same function the gate routes and `summarise`
 * reach, and unwrapped by VALUE rather than by key — so `__proto__` as a channel name cannot
 * turn the unwrap into a prototype read, and every rule `redactChannels` states holds here
 * unchanged: an undeclared name falls closed at `secret_ref`, a declared-but-unclassified one
 * is `internal`, and a plane that does not hold the graph withholds the value.
 *
 * A FAN-OUT'S `as` IS A DECLARED CHANNEL, which is what makes that lookup the right one:
 * `graph/validate.ts` refuses `GRAPH007_UNKNOWN_ITEM` — "the per-branch item is a real
 * channel: the StateView has to serve it" — so the item channel carries its own
 * `classification`. What this does NOT do is consult the `over` channel the items came from;
 * a graph that fans a `secret_ref` list into a `public` item channel has declared that, and
 * re-deciding it here would put this file in the business of overruling a graph's own
 * declarations, which is `validate.ts`'s question and not the wire's.
 *
 * `channel` NOT BEING A STRING FALLS CLOSED. A journal is authoritative rather than
 * well-formed: nothing here can look up a name that is not a name, and "refusing is always
 * allowed; loosening never is".
 */
function redactBinding(pair: unknown, channels: Readonly<Record<string, { readonly classification?: Classification }>> | undefined): unknown {
  if (pair === null || typeof pair !== "object" || Array.isArray(pair)) return redactPayload(pair, "internal");
  const name = (pair as { readonly channel?: unknown }).channel;
  const raw = (pair as { readonly value?: unknown }).value;
  const value =
    typeof name === "string"
      ? Object.values(redactChannels({ [name]: raw }, channels) as Record<string, unknown>)[0]
      : redactPayload(raw, "secret_ref");
  // `fromEntries` over the WHOLE pair, so a field this runtime has not met yet is swept
  // rather than dropped — and so the `__proto__` rule one function over holds here too.
  return Object.fromEntries(
    Object.entries(pair as Record<string, unknown>).map(([k, v]) => [k, k === "value" ? value : redactPayload(v, "internal")]),
  );
}

/**
 * The wire shape of an open gate, with its payload redacted per the GRAPH's declared
 * classification.
 *
 * ONE FUNCTION BECAUSE THERE ARE TWO ROUTES. `GET /runs/:id/gates` joins the projection's
 * gate to the broker's `byId` map and `GET /gates` joins it to `rendered`; the two built
 * the same object independently and NEITHER redacted, while this file's header had claimed
 * since it was written that both did. The defect one layer up is the same shape — `listRuns`
 * filtered at two of three sites — so the join lives here and a route may not spell it again.
 *
 * WHAT IS REDACTED IS THE CHANNEL DATA, AND ONLY THAT. A gate record is what makes a queue
 * usable — which node, which id, who may answer, when it expires — and none of it is channel
 * data. Withholding it would answer a disclosure with a denial of oversight, which is the
 * trade `GET /gates` exists to refuse.
 */
function gateWire(g: GateRecord, detail: GateSummary | undefined, graph: RunGraph | undefined): Record<string, unknown> {
  return { ...gateRecordWire(g, graph), payload: redactGatePayload(detail?.payload, graph), deadline: detail?.deadline };
}

/**
 * One `GateRecord` on its way to the wire, its ONE channel-keyed field redacted per the
 * GRAPH's declared classification.
 *
 * **THE RECORD CARRIES CHANNEL DATA AND NOTHING TREATED IT AS SUCH.** `GateRecord.writes` is
 * documented in `projection.ts` as "`edit` only: the channels the human wrote" — a map
 * keyed by channel name, filled from `gate.decided.writes`, which `CHANNEL_KEYED` already
 * names on the event stream. `summarise` served `Object.values(p.gates)` raw: not redacted
 * per the graph, not even swept at `internal`. Measured over real HTTP, `receipt` declared
 * `secret_ref` and the gate answered `{kind:"edit", writes:{receipt:…, summary:…}}` — one
 * response body, before:
 *
 *     "gates":[{…,"writes":{"receipt":"the second courier knocks twice","summary":"ordinary note"}}]
 *     "channels":{…,"receipt":"[secret]"},"outputs":{"receipt":"[secret]"}
 *
 * — two keys apart, the same value, one redacted and one not. After, the `gates` slice reads
 * `"writes":{"receipt":"[secret]","summary":"ordinary note"}` and the rest of the record is
 * unchanged. It reaches all six `#summary` routes: `GET /runs/:id`, the three command
 * replies, the gate-decision reply and the SSE snapshot frame.
 *
 * ONE FUNCTION, TWO CALLERS, FOR THE REASON `gateWire` IS ONE FUNCTION. `gateWire` built the
 * gate-route object with `{...g}` — the same unredacted spread — so the two gate routes had
 * the same hole standing behind an `open`-only filter that keeps `writes` absent in practice.
 * A redaction that depends on a filter elsewhere staying true is the shape of defect this
 * file has now paid for three times, so the spread is gone and both callers come through here.
 *
 * EVERY OTHER FIELD IS METADATA THIS PROCESS AUTHORED — which node, which task, who may
 * answer, when it expires, what was decided — and gets the `internal` sweep, exactly as the
 * gate PAYLOAD's non-channel fields do in `redactGatePayload`. Withholding it would answer a
 * disclosure with a denial of oversight. `justification` is the one field a HUMAN typed, and
 * `internal` is all that is available for it: no channel names it, so there is no declaration
 * to look up.
 */
function gateRecordWire(g: GateRecord, graph: RunGraph | undefined): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(g as unknown as Record<string, unknown>).map(([k, v]) => [
      k,
      k === "writes" ? redactChannels(v, graph?.spec.channels) : redactPayload(v, "internal"),
    ]),
  );
}

/**
 * Redact a gate payload per the classification the GRAPH declared, NEVER per viewer.
 *
 * Per-graph rather than per-viewer is the deliberate choice and the header states it: two
 * approvers on one gate see the same bytes. Per-viewer would make the question depend on who
 * asked it — two approvers answering one gate would be answering two different renderings of
 * it, with one `contentDigest` on the record and no way to say which rendering each of them
 * read — and it would put the plane in the business of ranking approvers.
 *
 * WHAT THE DIGEST PINS IS NOT WHAT THIS SERVES, and that is worth saying rather than
 * implying. `GateRecord.contentDigest` is the broker's digest of the payload it RENDERED,
 * unredacted; every reader here sees one redaction of it. That is the same arrangement
 * `frame` already has with a journal payload, and it is fine for what the digest is for —
 * telling two raisings of one question apart — but it is not a receipt for the bytes a
 * particular human read.
 *
 * A BLANKET `internal` SWEEP, THE WAY `summarise` REDACTS A PROJECTION'S CHANNELS, IS NOT A
 * FIX HERE. `internal` is the detector backstop alone, so a `secret_ref` channel value comes
 * through in full — measured over real HTTP on both routes before this existed. The declared
 * classification is the mechanism `redact.ts` calls primary ("a lookup, not a guess"), and a
 * gate is very often raised BECAUSE a channel is classified: `dataFloorOf` floors a node
 * reading `secret_ref` at posture `in`. Serving that value in the clear at the gate the
 * classification demanded is the one place it must not happen.
 *
 * THE SET THIS COVERS IS TWO PAYLOAD SHAPES, BOTH AUTHORED BY `run/engine.ts`, and they carry
 * channel data under different keys belonging to different specs:
 *
 *   - `#gatePayload` → `state`, keyed by THIS graph's channels.
 *   - `#runSubgraph`'s mirror gate → `channels`, keyed by the CHILD's channels — the whole
 *     child channel map, not the child gate node's `reads` — declared in the spec frozen at
 *     `graph.subgraphs[payload.subgraph]`. A parent may carry a secret it never classified,
 *     so reading the parent's declarations for those names would answer `internal` for every
 *     one of them.
 *
 * Every other field is metadata this process authored — node, task, posture, cost — and gets
 * the `internal` sweep, which is what it got before and no less.
 */
function redactGatePayload(payload: unknown, graph: RunGraph | undefined): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return redactPayload(payload, "internal");
  const ref = (payload as { readonly subgraph?: unknown }).subgraph;
  // `fromEntries`, not `out[k] = v`: for the one key named `__proto__` an assignment sets the
  // PROTOTYPE and drops the field — the defect `redact.ts`'s `put` exists for, and this
  // rebuild would otherwise reintroduce it one function away.
  return Object.fromEntries(
    Object.entries(payload as Record<string, unknown>).map(([k, v]) => [
      k,
      k === "state"
        ? redactChannels(v, graph?.spec.channels)
        : k === "channels"
          ? redactChannels(v, graph === undefined || typeof ref !== "string" ? undefined : own(graph.subgraphs, ref)?.channels)
          : redactPayload(v, "internal"),
    ]),
  );
}

/**
 * One channel map, each value redacted under the classification its own spec declared.
 *
 * ABSENT IS `secret_ref`, WHICH IS THE FAIL-CLOSED HALF AND THE ONLY ANSWER AVAILABLE. A
 * plane that does not hold the graph a run compiled — a run submitted by another process,
 * every run after a restart of a differently-configured plane — cannot know which of these
 * names is a credential. "Refusing is always allowed; loosening never is": the alternative,
 * falling back to `internal`, IS the leak being fixed. What it costs is bounded and visible —
 * the gate, its approvers and its deadline all still arrive; only the values are withheld.
 *
 * A DECLARED channel with no `classification` is `internal`, the documented default, so an
 * ordinary unclassified channel reaches the approver unchanged. Only an UNDECLARED name falls
 * closed, because a name no spec accounts for is a name nothing has classified.
 */
function redactChannels(value: unknown, channels: Readonly<Record<string, { readonly classification?: Classification }>> | undefined): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return redactPayload(value, "internal");
  const one = ([name, v]: readonly [string, unknown]): [string, unknown] => {
    const declared = channels === undefined ? undefined : own(channels, name);
    // A name no spec declares is a name nothing has classified.
    if (declared === undefined || declared === null) return [name, redactPayload(v, "secret_ref")];
    const c = declared.classification;
    if (c === undefined) return [name, redactPayload(v, "internal")];
    // THE MEMBERSHIP TEST IS `vocab.ts`'s, AND IT IS NOT SPELLED AGAIN HERE.
    //
    // `maxClassification` OVER ONE ARGUMENT IS EXACTLY THAT TEST: identity for each of the
    // four, `secret_ref` for anything else, stated in its own docstring as "a classification
    // this vocabulary cannot read is the most sensitive one there is". This line used to read
    // `own(CLASSIFICATION_POSTURE_FLOOR, c) === undefined ? "secret_ref" : c` — a membership
    // test written against a POSTURE-FLOOR table, which is a third spelling of a question
    // `vocab.ts` already answers, in a tree that has just standardised on `isPosture` for the
    // posture half. `vocab.ts` exports no `isClassification`; this is its equivalent.
    //
    // AND THE UNKNOWN WORD IS STILL REACHABLE, though the compiler now refuses it. `validate.ts`
    // gained `GRAPH003_UNKNOWN_CLASSIFICATION` this same round, and it covers a resolved CHILD
    // spec too — measured, a parent whose child declares `classification: "confidential"` no
    // longer compiles. What it does not cover is the graph objects THIS class is handed:
    // `ControlPlaneOptions.graphs` takes already-compiled `RunGraph`s and re-validates nothing,
    // so a graph compiled by a build older than that check reaches this line with a word the
    // vocabulary has never heard. Such a value reads as `internal` everywhere it is compared
    // with `===`, which is `redact.ts`'s own fail-open; measured over real HTTP on exactly that
    // shape, an unknown classification served its channel in the clear.
    return [name, redactPayload(v, maxClassification(c))];
  };
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(one));
}

/**
 * An OWN property of a record, or `undefined` — never `Object.prototype`'s.
 *
 * The same rule `graphIn` spells for `#graphs`, and it matters more here: a bare
 * `channels[name]` answers the `Object` FUNCTION for `constructor`, whose `classification` is
 * `undefined`, which would read as "declared, unclassified" — a name nothing declared,
 * treated as safe.
 */
function own<T>(rec: Readonly<Record<string, T>>, name: string): T | undefined {
  return name !== "__proto__" && Object.prototype.hasOwnProperty.call(rec, name) ? rec[name] : undefined;
}

/**
 * A projection trimmed for the wire, its channel values redacted per the GRAPH's declared
 * classification.
 *
 * Task and gate maps are sent as arrays because a 500-branch run's task map is the
 * bulk of the payload and the client renders it as a list anyway.
 *
 * **THE `graph` ARGUMENT IS THE FIX FOR A DISCLOSURE, AND IT IS NOT OPTIONAL AT A CALL
 * SITE.** Every caller reads it from `#graphByHash(p.graphHash)`; passing `undefined`
 * deliberately is the fail-closed answer, not a shortcut. See `redactChannels`.
 */
function summarise(p: import("../run/projection.ts").RunProjection, graph: RunGraph | undefined): unknown {
  return {
    runId: p.runId,
    status: p.status,
    seq: p.seq,
    graphHash: p.graphHash,
    posture: p.posture,
    // Channel values reach a browser here, so they are swept on the way out — PER THE
    // CLASSIFICATION THE GRAPH DECLARED, through the same `redactChannels` the two gate
    // routes reach. Both of these maps are keyed by channel name: `p.channels` is the
    // channel state, and `p.outputs` is `collectOutputs`, which iterates `spec.outputs` —
    // a subset of the same names. So one lookup table answers both.
    //
    // WHAT WAS HERE BEFORE WAS A BLANKET `internal` SWEEP, AND `internal` IS THE DETECTOR
    // BACKSTOP ALONE. Measured over real HTTP on the SSE snapshot frame, one run, a channel
    // declared `secret_ref` and a channel declared `pii`, neither value credential-shaped
    // so the backstop had nothing to catch — before, and after:
    //
    //     "channels":{…,"owner":"ada@example.com","vaultHint":"the vault passphrase is …"}
    //     "channels":{…,"owner":"pii:…:string",   "vaultHint":"[secret]"}
    //
    // THE 8 KB BOUND IS `redactPayload`'s AND STILL APPLIES: `redactChannels` calls it once
    // per channel value. A channel value is agent output of unbounded length; `pem` in
    // `DETECTORS` is quadratic; and this handler is `await`-free through the sweep, so its
    // cost is not this request's latency but every concurrent client's. Measured before the
    // bound: benign 1 MB → 7 ms; pem-shaped 1 MB → 4767 ms, of which 4754 ms was event-loop
    // lag. Pinned by *A 1 MB pem-SHAPED CHANNEL VALUE DOES NOT STALL THE PLANE* in
    // `test/server/http.test.ts`.
    channels: redactChannels(p.channels, graph?.spec.channels),
    outputs: redactChannels(p.outputs, graph?.spec.channels),
    usage: p.usage,
    reservedUsd: p.reservedUsd,
    budgetExhausted: p.budgetExhausted,
    // ON THE WIRE BECAUSE `status` CANNOT CARRY IT. A run paused while it was waiting on a
    // gate that has since been answered reads `running` and takes no work — see
    // `RunProjection.paused` for why the pause is deliberately not the status. A console
    // that showed `running` alone would report the opposite of what is true, and the
    // operator who paused it has no other way to confirm the pause landed.
    paused: p.paused,
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
    // A GATE RECORD CARRIES CHANNEL DATA TOO, and this line used to serve it raw. `writes` is
    // an approver's `edit` — the channels a human rewrote — and it went out unredacted on all
    // six routes that answer with a projection, in the same body whose `channels` two keys
    // above already read `[secret]`. See `gateRecordWire`, which both this and the two gate
    // routes now reach.
    gates: Object.values(p.gates).map((g) => gateRecordWire(g, graph)),
  };
}

/**
 * What a deployment is told at boot about who can see whose runs.
 *
 * ONE COMPUTATION, TWO EMITTERS — `startControlPlane` and `loom serve`, which does not call
 * it and prints its own diagnostics with its own fixes. They said the same thing before this
 * because somebody kept them in step; they say the same thing now because there is one
 * function, and the day they disagreed the binary would have contradicted the library about
 * a security property.
 *
 * THE OLD WARNING IS GONE BECAUSE ITS PREMISE IS FALSE. It said every credential is a full
 * operator credential; runs are scoped now. A warning that is false is worse than none — it
 * is the thing an operator learns to skip — so what replaces it states only what is true:
 *
 *   - **an operator credential reads everything.** That is a real widening, deliberately
 *     configured, and worth naming at boot the way the callback hole is;
 *   - **how many there are, or that the number is unknown.** An injected `IdentitySource`
 *     need not declare `operators`, and inventing a count would repeat the defect above;
 *   - **NO operators at all, on a plane with several principals.** Nobody can see anyone
 *     else's run, ever, including the person debugging the deployment — a lockout the plane
 *     can detect and its operator will otherwise diagnose by accident.
 */
export function ownershipWarnings(plane: {
  readonly distinctPrincipals: number;
  readonly operatorCredentials: number | undefined;
  readonly openToEveryCaller: boolean;
}): readonly string[] {
  // One principal has nobody to be isolated from, and an open plane authenticates nobody, so
  // in both the scope is vacuous and a warning would fire where nothing is wrong.
  if (plane.openToEveryCaller || plane.distinctPrincipals <= 1) return [];
  const n = plane.operatorCredentials;
  if (n === undefined) {
    return [
      `RUNS ARE SCOPED TO THE PRINCIPAL THAT SUBMITTED THEM, and this plane cannot tell how many of its ` +
        `credentials are operators — the identity source declares no \`operators\` count. An operator credential reads, ` +
        `streams and cancels EVERY run in the journal. See the design notes D3.17.`,
    ];
  }
  if (n === 0) {
    return [
      `NO OPERATOR CREDENTIAL IS CONFIGURED, and runs are scoped to the principal that submitted them — so no ` +
        `credential can read, stream or cancel another's run, including yours while you debug this deployment. ` +
        `Set \`"operator": true\` on an identity entry if that is not what you meant.`,
    ];
  }
  return [
    `${n} OPERATOR CREDENTIAL${n === 1 ? "" : "S"} CONFIGURED — each reads, streams and cancels EVERY run in the ` +
      `journal, not only its own. Runs are otherwise scoped to the principal that submitted them, and a run with ` +
      `no recorded principal stays readable by every credential.`,
  ];
}

/**
 * ONE GATE'S DOORS, and what this process can and cannot say about them.
 *
 * THREE VERDICTS, NOT TWO, and that is the decision this type carries. "no dispatcher is
 * configured" and "a door exists but nothing here can say whether it admits the people this
 * gate names" are different facts, and collapsing them is how the suppression this replaced
 * got written: `unanswerableGraphs` returned `[]` whenever an identity source existed, and
 * `announce` skipped it entirely whenever a dispatcher existed. Two branches whose only
 * effect was to fall silent in the case they could not decide.
 *
 * A REPORT, NOT A GUARD. It grants nothing and refuses nothing, so it has no passing value
 * available to it — the only refusal a printer has is a refusal to CLAIM, which is what
 * `cannot-tell` is. It must never print `answerable` on a guess.
 */
export interface GateDoors {
  readonly graph: string;
  readonly nodeId: string;
  /** The subjects this gate's `approval.approvers` names. Non-empty, or the gate is not here. */
  readonly approvers: readonly string[];
  /** Every channel the node declares, across the base spec and every escalation tier. */
  readonly channels: readonly string[];
  /** Of those, the ones the loaded dispatcher says can be ANSWERED (they have `parseCallback`). */
  readonly answerableChannels: readonly string[];
  /** Of those, the ones it can only TELL. A pager is legitimately one of these. */
  readonly notifyOnlyChannels: readonly string[];
  /** Of those, the ones the dispatcher has no channel for: delivered nowhere but the console fallback. */
  readonly unknownChannels: readonly string[];
  readonly verdict: "answerable" | "no-door" | "cannot-tell";
  /** The fact the verdict rests on, in words an operator can act on. */
  readonly why: string;
}

/**
 * Every gate that names approvers, and which of this deployment's doors could answer it.
 *
 * THE PREMISE THE OLD VERSION RESTED ON WAS WRONG, and it is worth stating because the
 * question it answered has now changed. `channel.parseCallback !== undefined` is the
 * answerability test for a CHANNEL, and exactly one shipped channel has it — but a channel
 * is where a gate is TOLD, not where it is ANSWERED. `POST /runs/:id/gates/:gateId` is
 * registered unconditionally and `loom approve <runId> <gateId> --as ID` reaches
 * `Engine.resolveGate` with no dispatcher anywhere on the path. So nothing is STRANDED in
 * the sense the old name implied; what this reports is which of the two REMOTE doors — the
 * API and a signed callback — could carry an answer, and whether the plane can tell.
 *
 * WHAT MAKES A VERDICT DECIDABLE, in one place so nothing else has to re-derive it:
 *
 *  - `answerable` needs a POSITIVE demonstration: the identity source enumerates its
 *    subjects and one of them is on this gate's approvers list. Nothing else earns it.
 *  - `no-door` is decidable too: there is no identity source that could produce any named
 *    approver AND no declared channel this dispatcher can be answered through. Note the
 *    first half is satisfied both by "no identity source at all" and by "a source that
 *    enumerates and contains none of them" — the second is the case a boolean could not say.
 *  - `cannot-tell` is everything else, and it names the missing fact rather than shrugging:
 *    a source that cannot enumerate, or an answerable channel whose subject mapping this
 *    process cannot see. `GateCallbackRouter` never consults `identity`, so what a signed
 *    callback vouches for is genuinely invisible from here.
 *
 * The CLI door is deliberately not a verdict. `loom approve --as` authenticates nobody by
 * construction, so it is available to anyone with filesystem access to the journal and
 * cannot distinguish two deployments.
 */
export function gateAnswerability(opts: ControlPlaneOptions): readonly GateDoors[] {
  const source = opts.identity;
  // ONE CALL, into a local. `knownSubjects` is injected code, and a method that returns one
  // population to the "can it enumerate" test and another to the membership test would make
  // this report say something no source ever claimed — the same rule `BearerTokenIdentity`'s
  // constructor states about reading each field once.
  const known = source?.knownSubjects?.();
  const out: GateDoors[] = [];
  for (const [graph, g] of Object.entries(opts.graphs ?? {})) {
    for (const n of g.spec.nodes) {
      const approvers = n.humanGate?.approval?.approvers ?? [];
      if (approvers.length === 0) continue;
      const delivery = n.humanGate?.delivery;
      // EVERY TIER, not just the base spec. An escalation tier may name channels the base
      // spec does not, and a gate whose only answerable channel appears at tier 2 is still
      // answerable — reporting otherwise would be a false alarm on a correct deployment.
      const channels = [...new Set([...(delivery?.channels ?? []), ...(delivery?.escalation ?? []).flatMap((t) => t.channels ?? [])])];
      const resolved = channels.map((name) => ({ name, channel: opts.dispatcher?.channel(name) }));
      const answerableChannels = resolved.filter((c) => c.channel?.parseCallback !== undefined).map((c) => c.name);
      const notifyOnlyChannels = resolved.filter((c) => c.channel !== undefined && c.channel.parseCallback === undefined).map((c) => c.name);
      const unknownChannels = opts.dispatcher === undefined ? [] : resolved.filter((c) => c.channel === undefined).map((c) => c.name);

      const named = known === undefined ? undefined : approvers.filter((a) => known.includes(a));
      if (named !== undefined && named.length > 0) {
        out.push({
          graph,
          nodeId: n.id,
          approvers,
          channels,
          answerableChannels,
          notifyOnlyChannels,
          unknownChannels,
          verdict: "answerable",
          why: `${source?.name ?? "the identity source"} can authenticate ${named.join(", ")}`,
        });
        continue;
      }
      if (answerableChannels.length > 0) {
        out.push({
          graph,
          nodeId: n.id,
          approvers,
          channels,
          answerableChannels,
          notifyOnlyChannels,
          unknownChannels,
          verdict: "cannot-tell",
          why:
            `${answerableChannels.join(", ")} can carry an answer, but whether its subject mapping vouches for ` +
            `${approvers.join(", ")} is not visible from this process — a signed callback names its own approver and ` +
            `never consults the identity source`,
        });
        continue;
      }
      if (source === undefined) {
        out.push({
          graph,
          nodeId: n.id,
          approvers,
          channels,
          answerableChannels,
          notifyOnlyChannels,
          unknownChannels,
          verdict: "no-door",
          why: "there is no identity source, so no API caller can be any of these approvers, and no declared channel can be answered",
        });
        continue;
      }
      if (known === undefined) {
        out.push({
          graph,
          nodeId: n.id,
          approvers,
          channels,
          answerableChannels,
          notifyOnlyChannels,
          unknownChannels,
          verdict: "cannot-tell",
          why: `${source.name} cannot enumerate its subjects, so whether any of ${approvers.join(", ")} can hold a credential is unknown here`,
        });
        continue;
      }
      out.push({
        graph,
        nodeId: n.id,
        approvers,
        channels,
        answerableChannels,
        notifyOnlyChannels,
        unknownChannels,
        verdict: "no-door",
        why: `${source.name} enumerates ${String(known.length)} subject(s) and none of them is ${approvers.join(", ")}`,
      });
    }
  }
  return out;
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
  // NO SHORT-CIRCUIT ON `opts.dispatcher` OR ON `opts.identity`. Both used to exist and both
  // were the same mistake: a branch whose only effect was to fall silent in the case it could
  // not decide. What is printed now is the per-gate verdict, and the two that are worth an
  // operator's attention are printed for different reasons — `no-door` is a fact this process
  // established, `cannot-tell` is a fact it is missing and is saying so instead of nothing.
  const doors = gateAnswerability(opts);
  for (const d of doors.filter((x) => x.verdict === "no-door")) {
    // Louder, because the failure mode is a run that waits forever at a gate no remote door
    // can answer — and the operator's first sight of it is otherwise a 403 hours later.
    console.error(`[loom] NO DOOR — ${d.graph}/${d.nodeId} names ${d.approvers.join(", ")}: ${d.why}`);
  }
  for (const d of doors.filter((x) => x.verdict === "cannot-tell")) {
    console.error(`[loom] CANNOT TELL — ${d.graph}/${d.nodeId} names ${d.approvers.join(", ")}: ${d.why}`);
  }
  // WHO CAN SEE WHOSE RUNS, said out loud to the only person who can weigh it.
  //
  // Only when there is more than one principal, because with one there is nobody to be
  // isolated from and a warning that fires when nothing is wrong is a warning operators
  // learn to skip. `ownershipWarnings` decides the wording; both boot paths read it, so the
  // binary cannot contradict the library about a security property.
  for (const line of ownershipWarnings(plane)) console.error(`[loom] ${line}`);
  return { plane, port: bound };
}
