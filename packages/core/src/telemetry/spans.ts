/**
 * Spans, derived FROM the journal.
 *
 * Not a parallel emission path. The usual design emits telemetry alongside execution,
 * which creates a second source of truth that can disagree with the first — and the
 * disagreement always surfaces during an incident, when it is least affordable.
 * Here a trace is a pure function of the journal, so:
 *
 *   - sampling can never lose something the journal has (it only drops export);
 *   - a run recorded before this file existed still produces a trace;
 *   - `reconstruct(trace) ⊆ declared(graph)` is a real assertion about execution,
 *     not about the tracer.
 *
 * The shape mirrors OpenTelemetry (and `gen_ai.*` semantic conventions for model
 * calls) without importing it, so `@loom/core` stays zero-dependency. An exporter
 * package maps these to OTLP.
 *
 * EDGES ARE LINKS, NOT SPANS: a 500-node run with 2,000 edges produces ~500 task
 * spans, not 2,500.
 *
 * A TRACE COLLECTOR IS OUTSIDE THE TRUST BOUNDARY, and this file is the SECOND EGRESS
 * PATH — the first being `run/delivery.ts`, which hands a gate to a channel. The two
 * were treated differently for far too long: the delivery path learned that a field a
 * graph author declared secret must not be reconstructible by the party it is sent to,
 * while this one went on exporting an unkeyed digest of a person's id, an unkeyed digest
 * of the gate payload, and an unkeyed digest of the whole channel map — to a backend
 * that is very often a third-party SaaS, i.e. arguably the MORE exposed of the two.
 *
 *   - a `sha256` prefix is not a pseudonym when the domain is a company directory. The
 *     approver id was recovered from a four-name candidate list in **0.011 ms**;
 *   - a digest of a payload is a CONFIRMATION ORACLE for every field in it. A five-digit
 *     `employeeId` redacted out of the Slack rendering was recovered from
 *     `gate.content_digest` in **50 ms** by hashing candidates against it;
 *   - `state.hash.before/after` is `digest(channelMap)`, so it is the same oracle over
 *     the whole of channel state — 63 ms for the same id, reached through a hash the
 *     previous wave's sweep filed as "journal and store, both inside the boundary".
 *
 * So every value on that list goes through the SAME keyed primitive `redact.ts` gave
 * `piiToken` — see `ATTRIBUTE_CLASSES`, which is the classification map
 * `redactAttributes` was built to take and, until now, was never given — under a key
 * SCOPED TO THE RUN, which `tokenKey` requires of any caller whose reader is outside the
 * boundary and which `redactFields` already does for gate delivery.
 *
 * WHAT IS DELIBERATELY NOT DONE: dropping those fields. A keyed token is a pure function
 * of its input, so `before(n+1) === after(n)`, "these two gates asked the same question",
 * and "the same person answered both" all survive it exactly. Only *guessing the input*
 * dies, which is the whole of what was wrong. The values themselves stay legible inside
 * the boundary, in the journal, where `gate.id` and `task.id` reach them.
 *
 * AND THE KEY THOSE TOKENS ARE MINTED UNDER IS THE DEPLOYMENT'S, NOT THE PROCESS'S —
 * which is the sentence that keeps the first paragraph of this file true. Closing the
 * inversion by calling `piiToken` was correct and, for one wave, it made the opening claim
 * false: `redact.ts`'s root key was `randomBytes(32)` per process, so the same journal
 * produced different span BYTES in every process. Two workers tracing one run emitted
 * `gate.approver` values nothing could join — in the distributed deployment these
 * interfaces are shaped for, that is the whole feature — and a replayed run's trace could
 * not be compared with the original's. Nothing in the repo actually performed that
 * comparison (`conformsToGraph` and `reconstructGraph` read `graph.hash`, `node.id`,
 * `task.id` and the two edge lists, none of which is classified `pii`; `run/replay.ts`
 * recomputes against the JOURNAL and never reads a span), so what broke was the CONTRACT
 * rather than a caller — which is exactly the kind of breakage nobody notices until the
 * day it matters.
 *
 * The resolution is `LOOM_PII_TOKEN_KEY`: same journal + same deployment key ⇒
 * byte-identical trace, in any process, forever; a collector without the key still gets
 * nothing. With no key configured, `redactAttributes` OMITS a `pii` attribute rather than
 * emitting one nobody can reproduce, so this file's two promises — un-inventible and
 * deterministic — are never traded against each other. `redact.ts` owns the key and the
 * whole of that argument; see `deploymentKey` there, including why reading it is
 * configuration rather than nondeterminism under invariant 4.
 *
 * See design/loom/05-RESOURCES-OBSERVABILITY.md D9.1–D9.2, and D9.6 for why the journal
 * is never redacted.
 */

import { digestOf } from "../canonical.ts";
import { redactAttributes } from "../security/redact.ts";
import type { EdgeId, NodeId, RunId } from "../ids.ts";
import { isEvent, type JournalEvent } from "../journal/events.ts";
import type { GraphSpec } from "../graph/spec.ts";
import type { Classification } from "../vocab.ts";

export type SpanKind = "internal" | "server" | "client";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanLink {
  readonly spanId: string;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface SpanEvent {
  readonly name: string;
  readonly time: number;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTime: number;
  readonly endTime: number;
  readonly status: SpanStatus;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly links: readonly SpanLink[];
  readonly events: readonly SpanEvent[];
}

/**
 * What a key on a span MEANS, so `redactAttributes` can act on it.
 *
 * BY KEY AND NOT BY ARM, which is the whole design. `close` is the one place a span
 * leaves this file, so a table consulted there covers every attribute however it got
 * onto the span — set at `start`, patched by `attr`, or handed in as `close`'s `extra` —
 * and covers the ones a future arm adds without that arm having to remember. The
 * alternative, a classification argument per call site, is the shape `04-OVERSIGHT`'s
 * own trap note calls out: a guard that is missed twice should be made unrepresentable
 * rather than re-added.
 *
 * `pii` is chosen for its MECHANISM as much as its name: `redact`'s `pii` arm is the
 * keyed HMAC, i.e. the only transform here that is stable, uninvertible, and total over
 * leaves. Nothing on this list is *literally* a person except `gate.approver`; the other
 * three are digests, and a digest of a small domain is a lookup key rather than a
 * pseudonym. Same defect, so the same treatment.
 *
 * A CONSEQUENCE WORTH STATING: because the classification is a property of the KEY, a
 * key may not mean two things. `gate.approver` used to hold either a hashed human
 * subject or the bare word `system`, and tokenising the second would manufacture the
 * appearance of a person having decided — so the actor KIND moved to
 * `gate.approver_kind` and `gate.approver` now holds a person or nothing at all.
 *
 * The keys are flat rather than namespaced because they are matched against span
 * attributes AND span-event attributes, which are two bags with one vocabulary; `to` is
 * an event attribute (`gate.escalated`) and the rest are span attributes. If a future
 * arm wants a non-personal `to`, it needs a different word, not an exception.
 *
 * NO PROTOTYPE, and this is now load-bearing in two directions rather than one. It was
 * written when `redactAttributes` looked a key up with `classifications[k] ?? "internal"`,
 * where `classifications["constructor"]` answers with a function rather than `undefined` —
 * the same fail-open `reduceState`'s channel lookup has, and the one `gateIn` was written
 * against. That lookup is now `attributeClass`, which reads through
 * `Object.prototype.hasOwnProperty`, so the belt is no longer the only thing holding this
 * up. The braces are: `isClassificationMap` accepts a `null` prototype BECAUSE of this
 * line, and a shape test written as `=== Object.prototype` alone would turn every span
 * attribute in every trace into `[secret]`. Keep the two facts together — this construction
 * and that acceptance are one decision written in two files.
 */
const ATTRIBUTE_CLASSES: Readonly<Record<string, Classification>> = Object.assign(
  Object.create(null) as Record<string, Classification>,
  {
    /** A person. The domain is a company directory — often the graph's own `approvers`. */
    "gate.approver": "pii",
    /** `digest(gate payload)` — a confirmation oracle for every field the channel redacted. */
    "gate.content_digest": "pii",
    /** `digest(whole channel map)` — the same oracle over all of state, twice per reduce. */
    "state.hash.before": "pii",
    "state.hash.after": "pii",
    /** `gate.escalated`'s recipient list: `user:…, role:…` joined by `formatRecipients`. */
    to: "pii",
  } satisfies Record<string, Classification>,
);

/**
 * Deterministic ids, so two traces of the same run are byte-comparable.
 *
 * `digestOf` and nothing else: a span id is a pure function of the run id and the
 * coordinates of the thing it names. Nothing here is keyed, and nothing here should be —
 * a run id is not a secret (see HANDOFF A13's "checked and NOT this defect" list) and a
 * keyed span id would be a *different* id in a deployment that rotated its key, which is
 * the one property a span id may not have.
 */
function spanId(...parts: readonly string[]): string {
  return digestOf(parts.join("|")).slice("sha256:".length, "sha256:".length + 16);
}

interface Open {
  name: string;
  kind: SpanKind;
  start: number;
  parent: string;
  attributes: Record<string, unknown>;
  links: SpanLink[];
  events: SpanEvent[];
}

/**
 * Fold a journal into a span tree.
 *
 * Unclosed spans (a run still in flight, or one that died mid-Task) are emitted with
 * `endTime` at the last observed event and `status: "unset"` — an in-flight trace is
 * a normal thing to look at, not an error.
 */
export function spansFrom(events: readonly JournalEvent[]): readonly Span[] {
  if (events.length === 0) return [];
  // `digestOf` is `createHash().update(v, "utf8")`, which throws `ERR_INVALID_ARG_TYPE` for a
  // non-string — and it takes `shouldExport` with it, so a malformed run id is a run nothing
  // can decide about rather than a run that is exported. `idText` is the file's existing
  // answer for "render an id that is not one", and it keeps `spanId`/`traceId` DERIVED,
  // which is the property the trace rests on: a constant traceId merges two runs into one
  // waterfall.
  const runId = idText(events[0]!.runId) as RunId;
  const traceId = digestOf(runId).slice("sha256:".length, "sha256:".length + 32);
  const rootId = spanId(runId, "run");

  const open = new Map<string, Open>();
  const done: Span[] = [];
  let lastTs = typeof events[0]!.ts === "number" && Number.isFinite(events[0]!.ts) ? events[0]!.ts : 0;

  const start = (id: string, o: Open): void => {
    if (!open.has(id)) open.set(id, o);
  };
  const close = (id: string, ts: number, status: SpanStatus, extra: Record<string, unknown> = {}): void => {
    const o = open.get(id);
    if (o === undefined) return;
    open.delete(id);
    done.push({
      traceId,
      spanId: id,
      ...(o.parent === "" ? {} : { parentSpanId: o.parent }),
      name: o.name,
      kind: o.kind,
      startTime: o.start,
      endTime: ts,
      status,
      // Redacted HERE, not in the journal.
      //
      // The journal is the source of truth and must keep real values — redacting it
      // would corrupt channel state, since `state.reduced` payloads ARE the state.
      // Spans leave the process, so they are redacted on the way out.
      //
      // ALL THREE BAGS, and that is the fix rather than a tidy-up. `attributes` was
      // redacted from the day this file was written and `events` and `links` were
      // handed on RAW, which was invisible while every event attribute was a closed
      // enum (`by`, `action`) — and stopped being invisible the moment the
      // `gate.escalated` arm put an operator-authored recipient list on an event.
      // Reproduced: a bearer token in `run.suspended`'s reason reached the exporter
      // intact through the event while the identical string in `gate.reason` came out
      // `[redacted:provider-key]` one field away. `links` carries no attributes today
      // — D9.1's producer-Task links are designed and unbuilt — so redacting it buys
      // nothing now and is the difference between a hole that is closed and a hole
      // that reopens when somebody writes the feature.
      //
      // SCOPED TO THE RUN, which `tokenKey` states as a CONDITION rather than an option:
      // the process-default key is right exactly when every reader of the token is already
      // inside the boundary, and a trace collector is not. Under the default, a collector
      // holding two runs' traces could tell that both reached byte-identical channel state,
      // or that one person answered a gate in each — an equality oracle across runs and
      // across tenants, granted to a party that holds neither value. `runId` is the same
      // scope `redactFields` names for gate delivery, for the same reason, and it costs
      // only the cross-run half of correlation: everything a trace is read for — the
      // state chain, a repeated question, the same approver twice — is within one run.
      attributes: redactAttributes({ ...o.attributes, ...extra }, ATTRIBUTE_CLASSES, runId),
      links: o.links.map((l) =>
        l.attributes === undefined ? l : { spanId: l.spanId, attributes: redactAttributes(l.attributes, ATTRIBUTE_CLASSES, runId) },
      ),
      events: o.events.map((ev) =>
        ev.attributes === undefined
          ? ev
          : { name: ev.name, time: ev.time, attributes: redactAttributes(ev.attributes, ATTRIBUTE_CLASSES, runId) },
      ),
    });
  };
  const attr = (id: string, patch: Record<string, unknown>): void => {
    const o = open.get(id);
    if (o !== undefined) Object.assign(o.attributes, patch);
  };
  const note = (id: string, name: string, ts: number, attributes?: Record<string, unknown>): void => {
    open.get(id)?.events.push(attributes === undefined ? { name, time: ts } : { name, time: ts, attributes });
  };

  for (const e of events) {
    // ONE READ OF THE JOURNAL'S `ts`, AND IT IS A NUMBER OR IT IS THE LAST ONE — because
    // the alternative is a trace that is WRONG rather than one that fails.
    //
    // `ts` was handed straight to `startTime`/`endTime`, and the span sort is
    // `a.startTime - b.startTime`, which is `NaN` for any non-number. `NaN` is falsy, so the
    // `|| (a.spanId < b.spanId ? -1 : 1)` tie-break fires and every pair involving the bad
    // span is ordered by a HASH — an intransitive comparator, so it can reorder two
    // WELL-FORMED spans relative to each other too. Measured: a journal whose
    // `run.submitted` carried `ts: "x"` folded to `startTimes=[1020,"x"]`,
    // `order=loom.task,loom.run` — the run span, which starts first, sorted LAST. `ts: null`
    // gave a span with `startTime: null, endTime: null`.
    //
    // Carrying `lastTs` forward is the fail-readable direction: the event is placed where
    // the journal last was, the waterfall stays monotonic and transitive, and nothing is
    // invented that a reader could mistake for a measurement. A throw would cost the caller
    // every span for the run, which is what the twelve LOUD partial reads in this function
    // already do and what makes them a separate decision.
    const ts = typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : lastTs;
    lastTs = ts;
    // ONE READ OF THE JOURNAL'S `taskId`, TESTED POSITIVELY — and `=== undefined` was
    // neither. `null` passed it, and `taskSpan` is derived under the same test, so
    // `spanId(runId, "task", null)` came back a perfectly ordinary string: `[…, null].join
    // ("|")` renders `null` as the EMPTY one. Every taskless event in a journal therefore
    // folded into ONE `loom.task` span keyed on the empty task id — two Tasks' claims
    // merged, `"task.id": null` on the result — and a gate arm parenting on `taskSpan ??
    // rootId` got a defined parent id for a span nothing ever started, i.e. an ORPHAN.
    //
    // `""` is refused for the same reason and by the same test, and this comment used to
    // claim that doing so merely agreed with the engine: "`run/gates.ts` and
    // `run/engine.ts` both STRIP `taskId` from an append when a gate's folded id is `""`".
    // VERIFIED AGAINST BOTH FILES, AND IT IS TWO-THIRDS TRUE, WHICH IS THE WORSE KIND.
    //
    //   - `run/gates.ts` strips it at TWO appends — `#commitForOpenGate` (the clock's
    //     timeouts, escalations and expiries) and `resolveBatch`'s `lead`. It does NOT strip
    //     it in `raise` (`{ taskId: req.taskId }`) or in `resolve`
    //     (`{ taskId: gate.taskId }`), which are the raise and the DECISION — the two
    //     appends a gate cannot happen without;
    //   - `run/engine.ts`'s `cancelOpenGates` strips the field from the EVENT, not from an
    //     append. That holds only because every one of its call sites appends with no
    //     append-level `taskId` of its own; the store spreads one over every event that
    //     lacks its own (`prepare`: `e.taskId ?? input.taskId ?? null`), so an append-level
    //     stamp would put the id straight back.
    //
    // And `""` is NOT NULLISH, so that same `??` chain passes it through untouched.
    // Measured, one `gate.raised` written with `taskId: ""` on the event and on the append,
    // read straight back out — `memory` and `sqlite` agree:
    //
    //     [{"type":"gate.raised","hasTaskId":true,"taskId":""}]
    //
    // So a journal CAN carry `taskId: ""`, through the public `HumanGateBroker.raise`, and
    // this test is the place that is total rather than the place that agrees. (What neither
    // store can hand over is `taskId: null`: both map a NULL `task_id` column to an ABSENT
    // field. That shape reaches here from a hand-written or legacy journal, which this repo
    // folds routinely. Trusted means "we do not defend against it", not "it cannot be
    // malformed".)
    const tid = typeof e.taskId === "string" && e.taskId !== "" ? e.taskId : undefined;
    const taskSpan = tid === undefined ? undefined : spanId(runId, "task", tid);

    if (isEvent(e, "run.submitted")) {
      start(rootId, {
        name: "loom.run",
        kind: "server",
        start: ts,
        parent: "",
        attributes: {
          "run.id": runId,
          "workflow.name": e.payload.workflow,
          "graph.hash": e.payload.graphHash,
          "idempotency.key": e.payload.idempotencyKey,
          "config.digest": e.payload.configDigest,
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "run.compiled")) {
      attr(rootId, { "graph.nodes": e.payload.nodes, "graph.edges": e.payload.edges, "resources.pinned": e.payload.resolutionManifest.length });
      continue;
    }
    if (isEvent(e, "run.started")) {
      attr(rootId, { "oversight.posture": e.payload.posture });
      continue;
    }
    if (isEvent(e, "run.suspended")) {
      note(rootId, "run.suspended", ts, { reason: e.payload.reason });
      continue;
    }
    if (isEvent(e, "run.resumed")) {
      note(rootId, "run.resumed", ts, { by: e.payload.by });
      continue;
    }
    if (isEvent(e, "run.completed")) {
      close(rootId, ts, "ok", {
        "run.status": "succeeded",
        "usage.input_tokens": e.payload.usage.inputTokens,
        "usage.output_tokens": e.payload.usage.outputTokens,
        "cost.total_usd": e.payload.usage.costUsd,
      });
      continue;
    }
    if (isEvent(e, "run.failed")) {
      close(rootId, ts, "error", { "run.status": "failed", "error.code": e.payload.error.code });
      continue;
    }
    if (isEvent(e, "run.cancelled")) {
      close(rootId, ts, "error", {
        "run.status": "cancelled",
        "cancel.clean": e.payload.clean,
        // The honest field: effects that started and never reported an outcome.
        "cancel.unknown_effects": e.payload.unknownEffects.length,
      });
      continue;
    }

    // ── gate arms, ABOVE the task-scope guard ───────────────────────────────────
    //
    // A GATE THAT EXISTS IS ON THE TRACE, WHETHER OR NOT ITS EVENT CARRIES A `taskId`.
    // These five arms used to sit BELOW the guard, so a gate raised by an event with no
    // `taskId` produced no `loom.gate` span at all — not mis-drawn, ABSENT — while
    // `run/projection.ts` and `GET /runs/:id/gates` showed it perfectly. A whole gate,
    // its escalations, its approver and its decision, missing from the one artefact an
    // incident review opens. That is the same failure the previous wave found when every
    // timeout and expiry the gate clock produced was invisible for exactly this reason.
    //
    // Whether the engine can APPEND an event with no `taskId` at all is a live question
    // (`run/engine.ts`'s `cancelOpenGates` and `run/gates.ts`'s `#commitForOpenGate` each
    // branch on `gate.taskId === ""`, so the shape is contemplated in the tree) — and it is
    // a question this file does not have to answer. Parenting on the Task when there is one
    // and on the run when there is not is correct under both answers, and costs nothing
    // under the common one. What is settled, and measured under `tid` above, is the
    // neighbouring question: an event carrying `taskId: ""` is appendable through
    // `HumanGateBroker.raise` today, on both stores.
    if (isEvent(e, "gate.raised")) {
      start(spanId(runId, "gate", e.payload.gateId), {
        name: "loom.gate",
        kind: "internal",
        start: ts,
        // The Task that raised it when there is one, and the RUN when there is not —
        // never nothing. See the block comment above these arms.
        parent: taskSpan ?? rootId,
        attributes: {
          "gate.id": e.payload.gateId,
          "node.id": e.payload.nodeId,
          "gate.policy_ref": e.payload.policyRef,
          // Pins WHAT THE APPROVER SAW — and is tokenised on the way out, because the
          // raw digest is a confirmation oracle for the payload it addresses. Guess a
          // value, rebuild the payload around it, hash, compare: a five-digit
          // `employeeId` that `DeliverySpec.redact` had just hidden from the channel
          // fell in 50 ms. So the field a graph author redacted for Slack was
          // reconstructible from the trace of the same gate, which makes this the
          // delivery leak arriving by the other road.
          //
          // Tokenising keeps the ONE question a trace can answer with it — "is this the
          // same content as that one?", which is what a duplicate-gate search and D7.9's
          // deduplication both ask — and drops the one it should never have answered.
          // The dispute itself is settled inside the boundary: `gate.id` is right here in
          // the clear, and the journal holds the real digest against it.
          "gate.content_digest": e.payload.contentDigest,
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "gate.decided")) {
      close(spanId(runId, "gate", e.payload.gateId), ts, e.payload.decision === "reject" ? "error" : "ok", {
        "gate.decision": e.payload.decision,
        "gate.latency_ms": e.payload.latencyMs,
        // THE SUBJECT GOES ON RAW AND LEAVES TOKENISED, because `ATTRIBUTE_CLASSES` says
        // `gate.approver` is `pii` and `close` is the only way out of this file.
        //
        // It used to read `digestOf(e.actor.subject).slice(7, 19)` under the comment "the
        // approver identity is hashed, never emitted in the clear" — an UNKEYED 48-bit
        // prefix, which is a pseudonym only if the input is unguessable. An approver id is
        // the opposite of unguessable: it is a company directory, and very often it is the
        // graph's own `approvers` list, which `gate.raised` journals in the clear a few
        // events earlier. Inverted from a four-name list in 0.011 ms. `piiToken`'s keyed
        // HMAC is what "hashed" has meant in `redact.ts` since the delivery path met the
        // same argument; there is no reason for the trace collector to get the older one.
        //
        // TWO KEYS, because one key may not mean two things (see `ATTRIBUTE_CLASSES`).
        // `gate.approver` is a PERSON or absent; the actor kind is its own attribute. That
        // also turns "which gates did the clock decide rather than a human?" from a
        // format-sniff on the value into a filter, which is the oversight question a
        // reviewer actually opens a trace to ask.
        ...(e.actor.kind === "human" ? { "gate.approver": e.actor.subject } : {}),
        "gate.approver_kind": e.actor.kind,
      });
      continue;
    }
    if (isEvent(e, "gate.escalated")) {
      // AN ESCALATION IS NEITHER A START NOR A TERMINAL EVENT, which is why this arm was
      // missing: every other gate event either opens the span or closes it, and there was no
      // shape for "the same question, asked of somebody else". So a gate that went to tier 2
      // traced IDENTICALLY to one nobody ever escalated — and D9.1's taxonomy has claimed
      // `gate.escalations` as an attribute since it was drawn.
      //
      // Both halves, because they answer different questions. The attribute is the HIGHEST
      // tier reached, which is what a trace search filters on ("show me the gates that woke
      // the director"); the events are the chain, with who was told and when the clock was
      // reset to, which is what an incident review reads. A count would lose the second and
      // a list would make the first a scan.
      //
      // `to` IS THE ONLY OPERATOR-AUTHORED STRING ON ANY SPAN EVENT, and putting it there
      // is what made the events' missing redaction cost something rather than merely be
      // untidy: `formatRecipients` renders `user:alice@example.com, role:sre-manager`, so
      // an escalation chain published a named person's address to the collector while
      // `gate.approver` two events later was — however badly — hidden. It is `pii` in
      // `ATTRIBUTE_CLASSES` for the same reason the approver is, and it keeps the same
      // residue: two tiers with the same recipients tokenise alike, `tier` stays in the
      // clear, and the names are one journal read away for anyone entitled to them.
      const id = spanId(runId, "gate", e.payload.gateId);
      attr(id, { "gate.escalations": e.payload.tier });
      note(id, "gate.escalated", ts, {
        tier: e.payload.tier,
        to: e.payload.to,
        ...(e.payload.deadline === undefined ? {} : { deadline: e.payload.deadline }),
      });
      continue;
    }
    if (isEvent(e, "gate.timeout")) {
      // `default_action` IS NOT A TERMINAL SHAPE, and closing on it told the wrong story
      // twice over: the span ended with `gate.decision: "timeout"` and the `gate.decided`
      // riding in the SAME append then found a closed span and was dropped. So a gate the
      // clock's pre-authorized decision APPROVED traced as one nobody answered — the exact
      // inversion, on the one arm where an approval and a timeout are both true.
      //
      // The fold in `run/projection.ts` has always made this distinction (`action !==
      // "default_action"` is not an expiry); this file did not. Noted rather than dropped,
      // because "the SLA is what produced this decision" is the fact the row exists to
      // carry, and the decision that follows it says who.
      const id = spanId(runId, "gate", e.payload.gateId);
      if (e.payload.action === "default_action") {
        note(id, "gate.timeout", ts, { action: e.payload.action });
        continue;
      }
      close(id, ts, "error", { "gate.decision": "timeout", "gate.action": e.payload.action });
      continue;
    }
    if (isEvent(e, "gate.cancelled")) {
      // A WITHDRAWN QUESTION IS NOT AN UNANSWERED ONE.
      //
      // Cancel — and every failure and completion path — closes a run's open gates, so
      // this is a common terminal shape rather than a corner. Without this arm the span
      // stayed open, fell out of the end-of-journal sweep with `status: "unset"` and no
      // decision attribute, and read in a trace exactly like a gate still waiting for a
      // human: the wrong end time and the wrong story.
      //
      // `error` rather than `unset`, for two reasons that agree. It is what the
      // `run.cancelled` and `task.cancelled` arms of this same fold already do with a
      // cancellation; and it leaves `unset` on a `loom.gate` span meaning one thing only
      // — this gate never closed — which is the reading an operator scanning a trace
      // needs. `gate.decision` carries WHICH terminal shape it was, so "withdrawn",
      // "rejected" and "timed out" stay three facts rather than one red span.
      //
      // No `gate.approver` and no `gate.approver_kind`: a cancel is written by the engine,
      // and naming a system component in either field would manufacture the appearance of
      // someone having decided. The pair belongs to `gate.decided` and to nothing else.
      //
      // `close` is a no-op on a span already closed, which is the span-side mirror of the
      // fold's only-from-`open` guard in `run/projection.ts`: a cancel arriving after a
      // decision retracts nothing, here or there.
      close(spanId(runId, "gate", e.payload.gateId), ts, "error", {
        "gate.decision": "cancelled",
        // Free text, and the only field the payload carries besides the id. It is what
        // separates "an operator withdrew this" from "the budget floor closed it"
        // without a second lookup; `redactAttributes` gives it the same backstop sweep
        // as every other attribute on the way out.
        "gate.reason": e.payload.reason,
      });
      continue;
    }

    // THE TASK-SCOPE GUARD, and everything below it is genuinely Task-scoped: each arm
    // either patches the Task's own span (`attr(taskSpan, …)`, which cannot exist without
    // one) or mints a child whose span id is derived from the taskId. A taskless event
    // reaching one of those is not a span drawn in the wrong place, it is a span with no
    // coordinates — unlike a gate, which has a `gateId` of its own. Telemetry may drop
    // data (invariant 8); it may not invent it.
    if (taskSpan === undefined || tid === undefined) continue;

    if (isEvent(e, "task.ready")) {
      // `binding: null` IS NOT `binding: undefined`, and the difference was a thrown
      // TypeError rather than a wrong attribute: `null.channel` came out of `spansFrom` and
      // the caller lost EVERY span for the run — not one dropped attribute but the whole
      // trace, and for `loom trace` the whole process.
      //
      // `?.` IS THE WHOLE FIX, and the longer version it replaced — an explicit
      // `=== null || typeof !== "object"` before the read — was measured to be an equivalent
      // mutant: `?.` is already total over both nullish values, and a property read on any
      // other primitive answers `undefined` rather than throwing. Reading the CHANNEL and
      // testing that, rather than testing the container, is also what keeps `undefined` out
      // of the bag: `exactOptionalPropertyTypes` distinguishes an absent attribute from one
      // present and undefined everywhere else in this codebase, and an OTLP exporter does
      // too.
      const itemChannel = e.payload.binding?.channel;
      // Recorded on the (not yet started) span's attributes so `edges.in` survives
      // even for a Task that never got leased.
      start(taskSpan, {
        name: "loom.task",
        kind: "internal",
        start: ts,
        parent: rootId,
        attributes: {
          // `tid`, not a SECOND read of `e.taskId` — and this is a CONSISTENCY statement
          // rather than a guard, said plainly because a mutation sweep found no test that
          // can tell the two apart and there is no test to write. The two reads can differ
          // only if `taskId` is a getter that answers differently the second time, and a
          // journal event is JSON: `frozenClone` and both stores' row maps produce data
          // properties. So this buys nothing today and states the rule the sweep behind
          // HANDOFF A12 asks of every value read twice — the span id above is derived from
          // the first read, and an attribute that could disagree with the id it is filed
          // under would be the wrong kind of cheap.
          "task.id": tid,
          "node.id": e.payload.nodeId,
          "branch.path": e.payload.branchPath,
          "edges.in": claimedList(e.payload.edgesIn),
          ...(itemChannel === undefined ? {} : { "branch.item_channel": itemChannel }),
        },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "task.leased")) {
      attr(taskSpan, { "task.attempt": e.payload.attempt, "worker.id": e.payload.workerId });
      note(taskSpan, "task.leased", ts);
      continue;
    }
    if (isEvent(e, "task.progress")) {
      note(taskSpan, "task.progress", ts);
      continue;
    }
    if (isEvent(e, "policy.decided")) {
      const id = spanId(runId, "policy", tid, String(e.seq));
      start(id, {
        name: "loom.policy",
        kind: "internal",
        start: ts,
        parent: taskSpan,
        attributes: {
          "policy.effect": e.payload.effect,
          "policy.posture": e.payload.posture,
          "policy.reasons": claimedList(e.payload.reasons),
          "irreversibility.class": e.payload.irreversibility,
        },
        links: [],
        events: [],
      });
      close(id, ts, e.payload.effect === "deny" ? "error" : "ok");
      continue;
    }
    if (isEvent(e, "effect.started")) {
      const id = spanId(runId, "effect", e.payload.key);
      start(id, {
        name: e.payload.kind === "model" ? "loom.model" : "loom.tool",
        kind: "client",
        start: ts,
        parent: taskSpan,
        attributes: { "loom.effect.key": e.payload.key, "effect.kind": e.payload.kind },
        links: [],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "model.called")) {
      const id = spanId(runId, "effect", e.payload.key);
      attr(id, {
        // gen_ai.* semantic conventions, so an OTLP exporter needs no translation.
        "gen_ai.system": e.payload.provider,
        "gen_ai.request.model": e.payload.model,
        "gen_ai.response.finish_reason": e.payload.finishReason,
        "gen_ai.usage.input_tokens": e.payload.usage.inputTokens,
        "gen_ai.usage.output_tokens": e.payload.usage.outputTokens,
        "loom.cost_usd": e.payload.usage.costUsd,
      });
      continue;
    }
    if (isEvent(e, "tool.called")) {
      const id = spanId(runId, "effect", e.payload.key);
      attr(id, {
        "tool.name": e.payload.name,
        "tool.version": e.payload.version,
        "tool.irreversibility": e.payload.irreversibility,
        "tool.idempotent": e.payload.idempotent,
      });
      continue;
    }
    if (isEvent(e, "effect.completed")) {
      close(spanId(runId, "effect", e.payload.key), ts, "ok", { "effect.outcome": "completed" });
      continue;
    }
    if (isEvent(e, "effect.failed")) {
      close(spanId(runId, "effect", e.payload.key), ts, "error", {
        "effect.outcome": "failed",
        "error.code": e.payload.error.code,
      });
      continue;
    }
    if (isEvent(e, "state.reduced")) {
      const id = spanId(runId, "reduce", String(e.seq));
      start(id, {
        name: "loom.state.reduce",
        kind: "internal",
        start: ts,
        parent: taskSpan,
        attributes: {
          channels: claimedList(e.payload.channels),
          "branch.count": e.payload.branchCount,
          skipped: e.payload.skipped,
          degraded: e.payload.degraded,
          // `stateHash` is `digest(state)` over the WHOLE channel map, so exporting it
          // raw is the `gate.content_digest` oracle again with every channel in scope
          // rather than one gate's payload — and twice per reduce. The previous wave's
          // class-sweep looked straight at these and filed them as "journal and store,
          // both inside the boundary": true of `state/channels.ts`, which computes them,
          // and false of this file, which ships them. A digest is not classified by where
          // it is COMPUTED.
          //
          // Tokenised, and the chain survives verbatim: the token is a pure function of
          // the hash, so `after(n) === before(n+1)` still holds, "this reduce changed
          // nothing" is still `before === after`, and only "which state was that?" dies.
          // Replay verification never reads a span — `run/replay.ts` recomputes against
          // the JOURNAL — so the thing D9.6 and 07-CONFIG-DEPLOY promise is untouched.
          "state.hash.before": e.payload.stateHashBefore,
          "state.hash.after": e.payload.stateHashAfter,
        },
        links: [],
        events: [],
      });
      close(id, ts, "ok");
      continue;
    }
    if (isEvent(e, "task.committed")) {
      attr(taskSpan, { "edges.taken": claimedList(e.payload.take), "task.status": e.payload.status });
      close(taskSpan, ts, e.payload.status === "succeeded" ? "ok" : "error");
      continue;
    }
    if (isEvent(e, "task.failed")) {
      attr(taskSpan, { "error.code": e.payload.error.code });
      continue;
    }
    if (isEvent(e, "task.cancelled")) {
      close(taskSpan, ts, "error", { "task.status": "cancelled", "cancel.clean": e.payload.clean });
      continue;
    }
    if (isEvent(e, "task.skipped")) {
      close(taskSpan, ts, "unset", { "task.status": "skipped" });
      continue;
    }
    if (isEvent(e, "checkpoint.created")) {
      const id = spanId(runId, "checkpoint", String(e.seq));
      start(id, {
        name: "loom.checkpoint",
        kind: "internal",
        start: ts,
        parent: taskSpan,
        attributes: { "checkpoint.seq": e.payload.atSeq, "checkpoint.kind": e.payload.kind, open_tasks: e.payload.openTasks },
        links: [],
        events: [],
      });
      close(id, ts, "ok");
      continue;
    }
  }

  // Everything still open belongs to a run that has not finished (or that died).
  for (const id of [...open.keys()]) close(id, lastTs, "unset");

  // Deterministic order, so two traces of the same journal are byte-identical.
  return done.sort((a, b) => a.startTime - b.startTime || (a.spanId < b.spanId ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Graph reconstruction
// ---------------------------------------------------------------------------

/**
 * An id, as this function will report it — TOTAL, because a trace is untrusted input.
 *
 * `String(v)` is total for every primitive including a symbol and a bigint, and is NOT
 * total for an object or a function: those run a caller-supplied `toString`, which can
 * throw or, worse, return something different the second time. `HANDOFF`'s "`instanceof`
 * proves a prototype, not provenance" is the same lesson one boundary over — the
 * booby-trapped value that detonated inside `LoomError.toJSON`. So a non-primitive is
 * named by its shape rather than asked what it is called.
 *
 * **"IT CANNOT EQUAL ANY DECLARED ID" IS WHAT THAT USED TO SAY, AND IT IS FALSE — nothing
 * validates the FORMAT of a node or edge id, so `(object)` is a legal one.** Reproduced: a
 * `loom.task` span claiming `"edges.taken": {}` reconstructs to the edge `(object)`, and
 * against a spec declaring `edges: [{id: "(object)"}]` the assertion answers
 * `{"ok":true,…,"unknownEdges":[]}` — an unreadable claim CERTIFYING. The exploit is not
 * available to whoever tampered with the trace, because they would also have to have written
 * the graph, and the graph is the trusted half here; so this is a stated limit rather than an
 * open hole. **Making it unrepresentable is a `graph/validate.ts` change** — refuse a node or
 * edge id matching `^\(.*\)$`, the four shapes this function can emit — and until that exists
 * the honest claim is the weaker one: a non-primitive is REPORTED under a name it did not
 * choose, rather than lost, which is the direction this function is for.
 */
function idText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null) return "(null)";
  if (typeof v === "object" || typeof v === "function") return `(${typeof v})`;
  return String(v);
}

/**
 * ONE property of a value from OUTSIDE, read TOTALLY — and the only way `reconstructGraph`
 * reads a CLAIM.
 *
 * **THAT SENTENCE USED TO END "and the only way this file reads one", WHICH WAS NEVER TRUE
 * AND WAS EXPENSIVE IN EXACTLY TWO PLACES — AND THE SECOND WAS FOUND BY THE FIX FOR THE
 * FIRST BEING BELIEVED.** The paragraphs below name every read it was wrong about: three now
 * fixed and three groups listed and left, which is the only form of that sentence anybody can
 * check. The first expensive one was
 * `for (const id of list)` in `reconstructGraph`: `Array.isArray` is true for a `Proxy` over
 * an array and for an ordinary array with an accessor at index 0, so a bag that ANSWERED with
 * one could still detonate inside the loop and take the whole conformance check with it.
 * Measured, on a two-span trace whose `loom.run` span was intact:
 *
 *     "edges.taken": <array with a getter at [0] that throws>   ⇒ Error: element getter
 *     "edges.taken": new Proxy(["e1"], {get() { throw … }})     ⇒ Error: proxy get
 *
 * That is `reconstructGraph`'s own docstring claim — "its only remaining move is to ANSWER"
 * — with a third move in the same function: THROW, which is the fail-neither-yes-nor-no a
 * verification function may not have. The element reads go through this now.
 *
 * **AND THE SECOND WAS THE SAME LOOP ONE LEVEL UP, IN THE SAME FUNCTION, LEFT BEHIND BY THE
 * CHANGE THAT NAMED IT.** `for (const [i, s] of spans.entries())` reads `.entries` off the
 * untrusted ARGUMENT and then a `[[Get]]` per element, which the array iterator performs —
 * so the container the inner fix was standing on had exactly the hole the inner fix closed.
 * Measured, node v24.16.0, `Array.isArray` answering `true` to all three:
 *
 *     spans = <array with a getter at [0] that throws>          ⇒ Error: outer element getter
 *     spans = new Proxy([span], {get() { throw … }})            ⇒ Error: outer get trap
 *     spans = new Proxy([span], {get: entries-only trap})       ⇒ Error: outer entries trap
 *
 * **"MAKE THE READS TOTAL" IS A CLAIM ABOUT A SET OF READS, SO THE CLAIM IS ONLY AS GOOD AS
 * THE ENUMERATION** — the Traps list says this and this file has now paid for it twice, both
 * times with the survivor a few lines from the fix. The set for `reconstructGraph` is: the
 * argument's list-ness (`isList`), its `length`, each element, each element's `name` and
 * `attributes`, each claim, each claim's list-ness, its `length`, and its elements. All of
 * them go through `readProp` or `isList`, and nothing else in that function touches the trace.
 *
 * **THE READS IN THIS FILE THAT ARE STILL BARE, NAMED RATHER THAN FIXED**, because the
 * sentence above is worth only as much as this list:
 *
 *   - `spansFrom`'s twelve journal reads — HANDOFF A18, deliberately loud, and one decision
 *     rather than twelve edits;
 *   - `conformsToGraph`'s `spec.nodes` / `spec.edges` — a `GraphSpec` this repo compiled;
 *   - `conformsToGraph`'s `reconstructed.nodes` / `.edges`. Its `unreadableSpans` — the
 *     list-ness AND the `length` the verdict is computed from — IS guarded and these two are
 *     not, which looks like the sibling omission this file has now corrected three times and
 *     is the same rule taking a different verdict: a missing `unreadableSpans` CERTIFIES
 *     (`?? []` ⇒ `ok: true`), while a missing `nodes` throws out of `.filter`. Quiet is the
 *     defect; loud on a hand-built input to a CI assertion is not. The ELEMENTS of
 *     `unreadableSpans` are likewise not copied, and that is the same call: they are reported
 *     and decide nothing.
 *
 * ~~`shouldExport`'s `policy.headRatio` / `policy.alwaysKeep` — a deployment's own
 * configuration, and `headRatio` is validated positively before it is used.~~ **STRUCK
 * THROUGH RATHER THAN DELETED, BECAUSE THE REASONING IS THE LESSON AND IT WAS COPIED OUT OF
 * HERE INTO A SWEEP TABLE AS "correct — total".** Both halves of that line were true and
 * neither was a statement about safety: `headRatio` is validated, and it was validated AFTER
 * a bare read that a getter could make throw; `!== false` is total over VALUES and the
 * property ACCESS in front of it is not. `shouldExport`'s own docstring rules that failure
 * out in as many words ("NOT A THROW … an exporter dying per run over a telemetry knob"), so
 * this was a claim with its counterexample two lines below it. Both reads now go through this
 * function. **Where a read is written, what its value is validated against, and whether the
 * access itself can throw are three questions, and only the third one is totality.**
 *
 * A TRACE is the argument this file's own premise names as untrusted — "a value this
 * function's premise says need not have come from `spansFrom`" — and inside
 * `reconstructGraph` every read of one now goes through here or through `isList`, which is
 * `Array.isArray` in a `try` for the reason `isList` gives.
 *
 * A copy of `run/delivery.ts`'s `readProp`, and a deliberate one: that function is
 * module-private, `packages/core/src/index.ts` re-exports this file with `export *`, and
 * exporting an internal accessor to share it would put a new name on the pinned public
 * surface. The rule is the same one, and the rest of this comment is why it replaced a
 * shape test rather than sitting beside one.
 *
 * THE SHAPE TEST THAT USED TO STAND HERE HAD FOUR ITERATIONS AND WAS NEVER THE RIGHT
 * QUESTION. `isAttributeBag` asked "is this value a plain bag?", first as
 * `typeof v !== "object"` (arrays walked through), then as prototype identity plus
 * `Array.isArray`, chosen over `Object.prototype.toString` because the tag form reads a
 * caller-supplied `Symbol.toStringTag` getter. That reasoning was sound and the result was
 * still forged in one line: `getPrototypeOf` is a `Proxy` trap, so
 * `new Proxy(new Map(…), {getPrototypeOf: () => Object.prototype})` passed the test and then
 * answered `undefined` to every claim — `unreadableSpans=[]  ok=true  edges=[]`, the exact
 * fail-open each iteration was written to close.
 *
 * **A `Proxy` can forge every observable an inspector can ask for, the sole exception being
 * a non-extensible target, so "is this a plain bag?" has no reliable answer in JavaScript
 * and no fifth iteration is worth writing.** What DOES have an answer is the question the
 * reads themselves ask, and it is the stronger question anyway: a span that says `loom.task`
 * and yields none of `node.id`, `task.id`, `edges.in`, `edges.taken` is a span whose claims
 * could not be read, whatever its bag turned out to be made of — which catches `{}` and
 * `Object.create(null)`, the plainest bags there are and the two no shape test ever asked
 * about. A forged bag that ANSWERS is not a hole either: answering is participating, and its
 * answers go through the same subset test an honest span's do.
 *
 * `undefined` for anything unreadable, deliberately conflated with "absent": a caller that
 * has to tell those apart is a caller that has to handle a throw again. Primitives short out
 * before the access, so an element that is not an object at all costs no try/catch.
 */
function readProp(v: unknown, key: string): unknown {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return undefined;
  try {
    return (v as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * `Array.isArray`, asked TOTALLY — the second half of the sentence above, and it was not
 * true of the bare call.
 *
 * **`IsArray` FOLLOWS A PROXY TO ITS TARGET, WHICH IS WHY THIS FILE REACHES FOR IT, AND ON
 * A REVOKED ONE IT THROWS** — the revoked handler is `null`, so there is nothing to follow:
 * `TypeError: Cannot perform 'IsArray' on a proxy that has been revoked`, node v24.16.0.
 * Un-forgeable and safe-to-ask are different properties, and `readProp`'s docstring named
 * this as one of the two ways an untrusted trace is read totally while all three call sites
 * were bare. That is the Traps list's own platform note (`run/delivery.ts` paid for it at
 * four sites) arriving one file later.
 *
 * FALSE IS THE VERDICT AT EVERY CALL SITE, and it has to be checked at each rather than
 * assumed, because "not a list" means something different in each and all three must fail
 * CLOSED:
 *
 *   - the argument of `reconstructGraph` ⇒ `unreadableSpans: ["(unreadable)"]`, a refusal;
 *   - a claim's container ⇒ ONE unknown edge named by its shape, reported and refused;
 *   - `conformsToGraph`'s `unreadableSpans` ⇒ `["(unreadable)"]`, so `ok` is false.
 *
 * None of the three can be reached by an honest array, so nothing legitimate changes verdict.
 *
 * **AND THIS DECIDES WHETHER THE VALUE IS A LIST, NOT WHETHER IT IS SAFE TO READ — a
 * distinction all three call sites need, because `IsArray` unwraps a `Proxy` to its TARGET.**
 * A `Proxy` over `[]` whose every trap throws is a list, truthfully, and every subsequent
 * read of it still throws. So `true` here licenses nothing: each site follows it with
 * `readProp` for the `length` that bounds the walk and `readProp` for each element. That was
 * not true when this helper was written — `conformsToGraph` read `unreadableSpans.length`
 * bare one line under the guard, and a 252-combination sweep found exactly that one survivor,
 * which is this file's sibling split for the third time. A guard and the reads it appears to
 * protect are two separate claims.
 */
function isList(v: unknown): boolean {
  try {
    return Array.isArray(v);
  } catch {
    return false;
  }
}

/**
 * A list the JOURNAL claimed, copied — and a container that is not a list is ONE claim, not
 * an iterable.
 *
 * `[...e.payload.edgesIn]` splits a STRING into characters. Measured: `edgesIn: "e1"` folded
 * to `"edges.in": ["e","1"]`, so `reconstructGraph` reported TWO ghost edges where the
 * journal claimed one — a FABRICATION, in the input to `conformsToGraph`, which is the
 * assertion a CI job reads. It also throws outright on `undefined`, `null` or a number,
 * which costs the caller every span for the run.
 *
 * `reconstructGraph` in this same file already takes the correct verdict on exactly this
 * class — "a container that is not a list is ONE unknown edge" — and the journal side did
 * not. This is that verdict, applied to the four spread sites, so both halves of the file
 * answer the question the same way.
 *
 * The elements are read through `readProp` under a bounded `length` for the reason the
 * `Array.isArray` docstring above gives: the container test licenses nothing about the
 * reads that follow it, and an ordinary array can carry an accessor at index 0.
 */
function claimedList(v: unknown): readonly unknown[] {
  // THE UNREADABLE CONTAINER IS RENDERED, NOT PASSED ON — and this is the half that a fix
  // stopping at "do not spread it" gets wrong. Returning `[v]` keeps the hostile value, and
  // the next reader is `redactAttributes`, whose `walk` calls `.map` on anything
  // `Array.isArray` accepts: a `Proxy` over `[]` claiming `length: 2 ** 32 - 1` was refused
  // HERE and then walked THERE, four billion times. `idText` is the same rendering
  // `reconstructGraph` gives a claim's container one screen down — a marker naming the
  // shape, which is what an attribute for an unreadable claim can honestly be.
  if (!isList(v)) return [idText(v)];
  const n = readProp(v, "length");
  // THE BOUND IS A COST GUARD, NOT A VALUE GUARD, AND NO TEST HOLDS IT — stated here rather
  // than left to be rediscovered. Deleting it does not change any answer: the walk below
  // eventually throws (`out` cannot hold 2 ** 32 - 1 entries) and the `catch` returns the
  // same marker. Measured, `length: 2 ** 32 - 1`: **17.6 seconds and several GB** to arrive
  // at the identical `["(object)"]`. Tests here are offline and deterministic, so a wall
  // clock cannot pin it; the difference is real and is exactly the denial-of-service a
  // trace-rendering path should not offer.
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_CLAIMED) return [idText(v)];
  try {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(readProp(v, String(i)));
    return out;
  } catch {
    return [idText(v)];
  }
}

/** A bound on a hostile `length`, far above anything a compiled graph produces. */
const MAX_CLAIMED = 65_536;

export interface ReconstructedGraph {
  readonly nodes: readonly NodeId[];
  readonly edges: readonly EdgeId[];
  readonly graphHash: string;
  readonly instances: readonly string[];
  /**
   * Spans whose claims could not be read at all, named by POSITION (`#0`, `#3`) in the
   * array as it was handed in.
   *
   * Non-empty means this reconstruction is INCOMPLETE, and `conformsToGraph` refuses a
   * trace that carries one. Position rather than span id because reading an id off a span
   * whose shape is already wrong is one more untrusted read of the same kind.
   *
   * FOUR WAYS IN. The first three are statements about a READ rather than about a container
   * — see `readProp` for why the container question was abandoned:
   *
   *   - the element yielded no `name` this function can dispatch on (a `null` element, a
   *     primitive, a `name` getter that throws, a `name` that is not a string);
   *   - a `loom.run` span yielded no `graph.hash`;
   *   - a `loom.task` span yielded none of `node.id`, `task.id`, `edges.in`, `edges.taken`.
   *
   * The fourth is about the ARGUMENT rather than about an element, so it is named `(unreadable)`
   * rather than by position: `reconstructGraph` was handed something that is not an array of
   * spans at all, so there are no positions to name. `conformsToGraph` already spelled that
   * case exactly this way for its own list-shaped input one function down and
   * `reconstructGraph` did not — the same question asked twice in one file with two answers,
   * the second being `TypeError: spans.entries is not a function` out of a verification path.
   *
   * **What is NOT here is a span this function reads no claims from at all** — a
   * `loom.gate`, a `loom.model`, anything a future arm adds. It used to be, as a side
   * effect of where the bag check sat, and that breadth was never sound: a `loom.gate` span
   * with an empty bag was accepted then exactly as it is now. This field says "there was
   * nothing I could not read *of what this function reads*", and the claims come from two
   * span names.
   */
  readonly unreadableSpans: readonly string[];
}

/**
 * Rebuild the graph that ACTUALLY executed, from spans alone.
 *
 * This is the mechanical enforcement of "one artifact, no parallel representations":
 * if the executor ever took an edge the GraphSpec does not declare, or ran a node it
 * does not contain, the CI assertion below fails.
 *
 * A SPAN THAT CLAIMS NOTHING AND A SPAN WHOSE CLAIMS CANNOT BE READ ARE TWO DIFFERENT
 * THINGS, and the second is why `unreadableSpans` exists. Every other guard in this
 * function is free to be quiet, because a claim it cannot parse is still REPORTED — as
 * an unknown node, an unknown edge, or a hash that matches nothing. The attribute-bag
 * check had nowhere to report to, so it `continue`d, and a `loom.task` span with a
 * malformed bag contributed no claims while the trace went on asserting that the Task
 * ran. `conformsToGraph` then answered `ok: true`. Measured, on a two-span trace whose
 * `loom.run` span was intact:
 *
 *   bag = undefined | null | 7 | "edges.taken:ghost-edge"  ⇒  ok=true, nodes=[] edges=[]
 *
 * That guard was ADDED to harden this function against an untrusted trace, and before it
 * the same input threw — ugly, and correct. In a function whose entire job is to refuse
 * a claim, a fail-open does not degrade a feature; it inverts the check.
 *
 * AND THE VERDICT WAS RIGHT THROUGH FOUR WRONG TESTS, WHICH IS WHY THE TEST IS GONE AND THE
 * VERDICT IS NOW A PROPERTY OF THE READS. `isAttributeBag` was defeated by a `Proxy` with a
 * `getPrototypeOf` trap and, more embarrassingly, by `{}` — see `readProp`. Every claim
 * below is read through it, and a span goes into `unreadableSpans` when the reads that
 * decide it come back empty: no dispatchable `name`, or a `loom.run` with no `graph.hash`,
 * or a `loom.task` with none of its four. A hostile bag can no longer choose between
 * "unreadable" and "silent"; its only remaining move is to ANSWER, which puts it in the
 * subset test with everybody else.
 *
 * **AND "ITS ONLY REMAINING MOVE IS TO ANSWER" HAD A THIRD MOVE UNTIL THE ANSWERS THEMSELVES
 * WERE READ TOTALLY.** A bag could answer `edges.taken` with a value `Array.isArray` accepts
 * — a `Proxy` over an array, or an ordinary array carrying an accessor at index 0 — and then
 * throw out of `for (const id of list)`, which is not "unreadable", not "silent" and not an
 * answer: it is `reconstructGraph` raising, so `conformsToGraph` is never called and the CI
 * assertion returns neither `ok: true` nor `ok: false`. Two reads short of the claim, in the
 * one loop the claim is about. Both the element reads and the length that bounds them now go
 * through `readProp`, and a list that will not say how long it is takes the same verdict as a
 * container that is not a list: ONE unknown edge, named by its shape.
 *
 * **AND THE THIRD MOVE WAS AVAILABLE TO THE TRACE ITSELF, NOT ONLY TO A BAG INSIDE IT, WHICH
 * THE PARAGRAPH ABOVE DID NOT COVER AND THE CODE UNDER IT DID NOT EITHER.** `for (const [i, s]
 * of spans.entries())` is the same loop over the same kind of untrusted container, so an
 * argument that passed `Array.isArray` could throw from `.entries` or from any element and
 * take the whole assertion with it — the fix for the inner list was written while standing on
 * the outer one. The argument is now walked by `length`-bounded indexing through `readProp`,
 * and its three verdicts are the ones already in use: not a list, or a `length` this cannot
 * read, ⇒ `["(unreadable)"]`; an element this cannot read ⇒ `#i`, the same answer a `null`
 * element gets. `Array.isArray` itself is asked through `isList`, because the bare call throws
 * on a revoked `Proxy` — see `isList`.
 */
export function reconstructGraph(spans: readonly Span[]): ReconstructedGraph {
  const nodes = new Set<NodeId>();
  const edges = new Set<EdgeId>();
  const instances = new Set<string>();
  const unreadable: string[] = [];
  let graphHash = "";

  // THE ARGUMENT IS A TRACE, AND A TRACE IS UNTRUSTED — including the array around it. This
  // is `conformsToGraph`'s `Array.isArray(claimed)` guard, which was written for exactly this
  // shape one function away and against a hand-built value from the same kind of caller. Here
  // the bare `spans.entries()` answered `TypeError: spans.entries is not a function`, which
  // is a verification function neither certifying nor refusing. The verdict is the one that
  // function already chose for the same question: something it could not read, reported.
  //
  // `isList`, NOT `Array.isArray`: the bare call throws on a revoked `Proxy`, which is a
  // throw out of the guard that exists to prevent one. See `isList`.
  if (!isList(spans)) {
    return { nodes: [], edges: [], graphHash: "", instances: [], unreadableSpans: ["(unreadable)"] };
  }

  // AND `isList` IS NOT ENOUGH, WHICH IS THE READ THAT FALSIFIED `readProp`'S CLAIM. It is
  // proxy-agnostic — it unwraps to the target — and an ordinary array can carry an accessor
  // at index 0, so `for (const [i, s] of spans.entries())` read `.entries` off the untrusted
  // container and then, per element, a `[[Get]]` the array iterator performs. Both threw
  // straight out of `reconstructGraph`. This is bit-for-bit the defect the `edges.taken` loop
  // eighty lines down was fixed for, on the container that loop's fix was holding: `length`
  // first, because it decides how many more reads there are, then each element through
  // `readProp`.
  //
  // A LENGTH THIS CANNOT READ IS THE ARGUMENT VERDICT, not zero and not `#0`: there are no
  // positions to name when the position count is the thing that could not be read, and
  // falling to `n = 0` would certify a trace by refusing one property. The bound is the same
  // one the inner list takes, and so is its LIMIT, stated rather than assumed away: a
  // container is free to claim `Number.MAX_SAFE_INTEGER` elements and buy a long loop. That is
  // not newly reachable — measured, `%ArrayIteratorPrototype%.next` reads `length` on EVERY
  // step, so `spans.entries()` iterated a lying proxy's claimed length too (5 iterations and
  // SIX length reads for a one-element array claiming 5). This reads it once and trusts the
  // one answer, which is strictly fewer chances for a second read to differ.
  const count = readProp(spans, "length");
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    return { nodes: [], edges: [], graphHash: "", instances: [], unreadableSpans: ["(unreadable)"] };
  }

  for (let i = 0; i < count; i++) {
    // An element that cannot be read is `undefined`, and `readProp(undefined, "name")` is
    // `undefined` too — so it lands on the `#i` refusal below with a `null` element and a
    // throwing `name` getter, which is one rule for "this is not a span" rather than a third
    // one invented here.
    const s = readProp(spans, String(i));
    // READ ONCE, INTO A CONST, AND TOTALLY — and `name` was none of the three. It was read
    // twice (`=== "loom.run"`, then `!== "loom.task"`) off a value this function's premise
    // says need not have come from `spansFrom`, so a getter answering `loom.task` and then
    // `loom.run` failed the first test and passed the skip: the span's claims were never
    // read, and a trace asserting an undeclared node AND an undeclared edge came back
    // `ok: true`. That is A12's "name every site that reads it and ask whether the second
    // read can answer differently", applied to the value that STEERS the loop rather than
    // to one it reports.
    //
    // An element with no readable `name` is not a span. That is the element-level refusal a
    // `null` in the array used to get from a container test, restated as a property of the
    // first read — same verdict, one line, and it now also covers a `name` getter that
    // throws.
    const name = readProp(s, "name");
    if (typeof name !== "string") {
      unreadable.push(`#${i}`);
      continue;
    }
    const attributes = readProp(s, "attributes");

    // `idText`, not `String()`. The bare coercion this replaced was the same untrusted read
    // the three below were fixed for: `String(v)` runs a caller-supplied `toString`, which
    // can throw — killing the whole conformance check — or answer differently the second
    // time.
    //
    // AN ABSENT HASH IS NOW UNREADABLE RATHER THAN THE EMPTY STRING. It used to leave
    // `graphHash` at `""`, "which matches only a caller that asked about the empty hash" —
    // true, and one conjunct thinner than it needed to be, since `conformsToGraph(r, spec,
    // "")` is a call anybody can make. Every `loom.run` span this repo emits carries the
    // hash; one that does not yielded nothing this function reads.
    if (name === "loom.run") {
      const claimed = readProp(attributes, "graph.hash");
      if (claimed === undefined) {
        unreadable.push(`#${i}`);
        continue;
      }
      graphHash = idText(claimed);
      continue;
    }
    // NOT JUDGED, and that is deliberate: this function reads no claim off a `loom.gate` or
    // a `loom.model`, so there is no claim of theirs it can fail to read. See
    // `unreadableSpans`.
    if (name !== "loom.task") continue;

    // A NON-STRING ID IS AN UNKNOWN ID, NOT AN ABSENT ONE, and the difference is the
    // direction this function fails in. These three reads used to be `typeof x ===
    // "string"` guards that SKIPPED anything else — so a span claiming
    // `"edges.taken": [{}]` reconstructed to no edge at all and `conformsToGraph` said
    // `ok`. That is fail-open in the one function whose entire job is to refuse a trace
    // claiming something the graph does not declare; the tampering case it is tested
    // against ("a trace claims an undeclared edge") is caught only because the tamper
    // happened to be a string. `String(id)` cannot collide with a declared id it is not
    // equal to, so coercing reports it as unknown instead of losing it.
    //
    // ABSENT still means absent: a `loom.task` span with no `node.id` contributes no
    // node, because inventing `"undefined"` would report a node nobody claimed. ALL FOUR
    // absent is a different statement, and it is the one the four bag tests were reaching
    // for: the span says a Task ran and yields nothing about which.
    const node = readProp(attributes, "node.id");
    const task = readProp(attributes, "task.id");
    const edgesIn = readProp(attributes, "edges.in");
    const edgesTaken = readProp(attributes, "edges.taken");
    if (node === undefined && task === undefined && edgesIn === undefined && edgesTaken === undefined) {
      unreadable.push(`#${i}`);
      continue;
    }
    if (node !== undefined) nodes.add(idText(node) as NodeId);
    if (task !== undefined) instances.add(idText(task));
    for (const list of [edgesIn, edgesTaken]) {
      if (list === undefined) continue;
      // A CONTAINER THAT IS NOT A LIST IS ONE UNKNOWN EDGE, NOT NO EDGES. `if
      // (Array.isArray(list))` alone dropped the whole claim when the container was the
      // wrong shape — the identical fail-open the comment above describes for a single id,
      // one level up: `"edges.taken": {}` reconstructed to no edge at all and
      // `conformsToGraph` said `ok`. Reporting it as one unknown edge named by its shape
      // cannot manufacture a match with a declared id, and it cannot be silently lost.
      if (!isList(list)) {
        edges.add(idText(list) as EdgeId);
        continue;
      }
      // AND A LIST THIS CANNOT WALK IS ONE UNKNOWN EDGE TOO, which is the same rule as the
      // line above and was the read that falsified `readProp`'s "the only way this file reads
      // one". `Array.isArray` is realm-agnostic and PROXY-agnostic: it unwraps to the target,
      // so `new Proxy(["e1"], {get() { throw … }})` passes it, and so does an ordinary array
      // with an accessor defined at index 0. `for (const id of list)` then reads
      // `Symbol.iterator` and each element off a value this function's premise says it did not
      // build, and both reads threw straight out of `reconstructGraph`.
      //
      // `length` FIRST, because it is the read that decides how many more there are, and a
      // list that will not answer it has told us nothing about its contents rather than that
      // it has none. Falling to `n = 0` there would be the fail-open this whole function is a
      // correction of — a hostile bag buying silence by refusing one property.
      const len = readProp(list, "length");
      if (typeof len !== "number" || !Number.isSafeInteger(len) || len < 0) {
        edges.add(idText(list) as EdgeId);
        continue;
      }
      // An element that cannot be read is `undefined`, which `idText` renders `"undefined"` —
      // the same text a genuinely absent element already produced through `for…of`, and an id
      // that is reported and refused rather than lost. `readProp`'s docstring makes that
      // conflation deliberately.
      for (let j = 0; j < len; j++) edges.add(idText(readProp(list, String(j))) as EdgeId);
    }
  }

  return {
    nodes: [...nodes].sort(),
    edges: [...edges].sort(),
    graphHash,
    instances: [...instances].sort(),
    // Already in ascending position order, and NOT sorted as text: `#10` sorts before `#2`.
    unreadableSpans: unreadable,
  };
}

export interface ConformanceResult {
  readonly ok: boolean;
  readonly unknownNodes: readonly NodeId[];
  readonly unknownEdges: readonly EdgeId[];
  readonly hashMatches: boolean;
  /** Carried through from `ReconstructedGraph`. Non-empty ⇒ `ok` is false. */
  readonly unreadableSpans: readonly string[];
}

/**
 * `reconstruct(trace) ⊆ declared(graph.hash)`. A CI assertion, not a metric.
 *
 * FOUR CONJUNCTS, AND THE FOURTH IS A REFUSAL RATHER THAN A SUBSET TEST. The first three
 * say "everything the trace claimed is declared"; `unreadableSpans` says "and there was
 * nothing I could not read", which is the difference between certifying a trace and
 * certifying the readable part of one. Without it a tampered span is indistinguishable
 * from an honest one that happened to claim nothing.
 */
export function conformsToGraph(reconstructed: ReconstructedGraph, spec: GraphSpec, graphHash: string): ConformanceResult {
  const declaredNodes = new Set(spec.nodes.map((n) => n.id));
  const declaredEdges = new Set(spec.edges.map((e) => e.id));
  const unknownNodes = reconstructed.nodes.filter((n) => !declaredNodes.has(n));
  const unknownEdges = reconstructed.edges.filter((e) => !declaredEdges.has(e));
  const hashMatches = reconstructed.graphHash === graphHash;
  // A RECONSTRUCTION THIS CANNOT READ IS ONE IT MAY NOT CERTIFY, which is the same rule
  // `reconstructGraph` applies to a span one layer down. `?? []` here would be the fail-open
  // again, arriving through a caller — a hand-built `ReconstructedGraph` with the field
  // missing would certify — so a value that is not a list counts as one thing it could not
  // read rather than as none.
  //
  // AND `isList` ALONE WAS NOT THE GUARD IT LOOKS LIKE, WHICH IS THIS FILE'S OWN SIBLING
  // SPLIT ARRIVING A THIRD TIME. `Array.isArray` unwraps a `Proxy` to its target, so a
  // `Proxy` over `[]` whose every trap throws is ACCEPTED as a list — correctly, it is one —
  // and the very next read of it, `unreadableSpans.length` in the `ok` expression below, was
  // bare. Found by sweeping this function rather than by reading it: 252 hostile
  // reconstructions, one survivor, and the survivor was the read the new guard had just
  // decided was safe to make. So the length goes through `readProp` and takes the same
  // verdict a `length` gets everywhere else in this file — a container that will not say how
  // long it is has told us nothing about its contents, which is one thing this function could
  // not read, which is `ok: false`.
  //
  // THE ELEMENTS ARE NOT COPIED, and that is the limit rather than an oversight: they decide
  // nothing here, and a caller that then renders them (`loom trace` does `JSON.stringify` on
  // this result) is reading a value IT built. This is a claim about the VERDICT — that one is
  // always produced — not about what a hostile `ReconstructedGraph` can do to its own author.
  const claimed: unknown = reconstructed.unreadableSpans;
  const claimedLength = isList(claimed) ? readProp(claimed, "length") : undefined;
  // READ ONCE, INTO A CONST, AND DECIDED ON — never read a second time in the `ok`
  // expression. A container whose `length` answers `0` and then `1` would otherwise be
  // validated here and consulted there, which is A12's "name every site that reads it and ask
  // whether the second read can answer differently" applied to the value that decides the
  // verdict.
  const readable = typeof claimedLength === "number" && Number.isSafeInteger(claimedLength) && claimedLength >= 0;
  const unreadableSpans = readable ? (claimed as readonly string[]) : ["(unreadable)"];
  const unreadableCount = readable ? (claimedLength as number) : 1;
  return {
    ok: unknownNodes.length === 0 && unknownEdges.length === 0 && hashMatches && unreadableCount === 0,
    unknownNodes,
    unknownEdges,
    hashMatches,
    unreadableSpans,
  };
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface SamplingPolicy {
  /** Head ratio for ordinary runs, 0..1. */
  readonly headRatio: number;
  /** Always keep a run that gated, escalated, errored, or touched an irreversible tool. */
  readonly alwaysKeep?: boolean;
}

/**
 * Said once per process, because a sampling policy is a deployment's configuration and not
 * a per-run value. Same shape and same reasoning as `redactAttributes`' scope warning:
 * the knob did not do what its author wrote, and the only other symptom is data that is
 * not there.
 */
let warnedRatio = false;
function warnUnusableHeadRatio(ratio: unknown): void {
  if (warnedRatio) return;
  warnedRatio = true;
  process.emitWarning(
    `SamplingPolicy.headRatio is ${typeof ratio === "number" ? String(ratio) : `a ${typeof ratio}`}, ` +
      `which is not a ratio in [0, 1], so head sampling is DISABLED and every run is being exported. ` +
      `Set headRatio to a number between 0 and 1.`,
    "LoomConfigWarning",
  );
}

/**
 * Decide whether a run's spans are exported.
 *
 * Sampling applies to EXPORT ONLY — the journal is never sampled — so a sampled-out
 * run is still fully replayable and auditable. That separation is what makes a low
 * head ratio safe.
 *
 * A HEAD RATIO THAT IS NOT A RATIO EXPORTS, AND SAYS SO. The three tests below are
 * `>= 1`, `<= 0` and `bucket < ratio`, and `NaN`, `undefined` and an object lose ALL
 * THREE — so a mistyped sampling policy used to export nothing whatsoever, which is
 * observationally identical to the `headRatio: 0` an operator might well have configured
 * on purpose. `null` and any negative reached the same silence through `null <= 0` and
 * `-1 <= 0`, both of which are true. A validation failure indistinguishable from a
 * legitimate configuration is the quietest defect this file can carry, so the range test
 * is written POSITIVELY and covers the whole domain in one comparison pair.
 *
 * THE DIRECTION IS EXPORT, and it is argued rather than defaulted. Sampling is a COST
 * optimisation over data the journal already holds in full (D9.3), so when its parameter
 * cannot be read the honest fallback is not to optimise; it is also the visible one, since
 * a collector suddenly holding every run is noticed in a day and a collector quietly
 * holding none is noticed the day somebody goes looking for the one trace that mattered.
 * This is where the rule parts company with `redactAttributes`' unusable scope, which
 * DROPS: there the alternative is disclosing under a key the caller did not choose, so
 * quiet is strictly safer. Here nothing is disclosed either way, and quiet is only quiet.
 *
 * NOT A THROW, for `WebhookChannel.#timeout`'s reason rather than for convenience: this
 * function has no construction moment at which a refusal could stop an unstartable
 * process, so a throw here is an exporter dying per run over a telemetry knob — which
 * invariant 8 has an opinion about.
 *
 * **AND THAT PARAGRAPH HAD ITS COUNTEREXAMPLE TWO LINES BELOW IT UNTIL THE POLICY READS WENT
 * THROUGH `readProp`.** It ruled out a throw and then reached `policy.headRatio` and
 * `policy.alwaysKeep` bare, so a getter, a `null` policy or a revoked `Proxy` produced
 * precisely the exporter-dying-per-run it argues against. The claim is now measured and it is
 * SCOPED, because a claim that will not say what it ranges over is the one that widens by
 * being read generously: **no value of `policy` — including `null`, a primitive, a revoked
 * `Proxy`, or a record whose every trap throws — makes this function throw.** `events` is NOT
 * in that claim. It is the run's own journal, `e.type` and `e.payload` are read bare here as
 * they are throughout `spansFrom`, and making them total is HANDOFF A18's single deliberate
 * decision rather than an edit to smuggle in beside a config fix.
 */
export function shouldExport(events: readonly JournalEvent[], policy: SamplingPolicy): boolean {
  // THROUGH `readProp`, BECAUSE "NOT A THROW" WAS A CLAIM ABOUT THE VALUE AND THE DEFECT WAS
  // IN THE ACCESS. `policy.headRatio` was a bare property read on a record the DEPLOYMENT
  // supplies, so `{get headRatio() {throw}}`, a `null` policy and a revoked `Proxy` each did
  // exactly what the paragraph above rules out — an exporter dying per run over a telemetry
  // knob. A validated value reached through an unguarded read is validated and then not
  // reached. `undefined` for anything unreadable is the same conflation `readProp` makes
  // everywhere else, and it is the right one here twice over: an unreadable ratio fails the
  // positive test below and EXPORTS, and an unreadable `alwaysKeep` is not the exact `false`
  // that turns the tail rules off, so it KEEPS.
  const ratio: unknown = readProp(policy, "headRatio");
  // Positive, and total: `NaN`, `undefined`, `null`, a string, an object and both
  // infinities all fail one of these, and no separate `Number.isNaN` arm is needed because
  // `NaN` loses every comparison — which is the whole reason this entry exists.
  if (!(typeof ratio === "number" && ratio >= 0 && ratio <= 1)) {
    warnUnusableHeadRatio(ratio);
    return true;
  }
  if (readProp(policy, "alwaysKeep") !== false) {
    for (const e of events) {
      if (
        e.type === "gate.raised" ||
        e.type === "run.failed" ||
        e.type === "policy.escalated" ||
        e.type === "budget.exhausted" ||
        (e.type === "tool.called" &&
          ((e.payload as { irreversibility?: string }).irreversibility === "irreversible" ||
            (e.payload as { irreversibility?: string }).irreversibility === "externally_visible"))
      ) {
        return true;
      }
    }
  }
  // `ratio`, not three more reads of `policy.headRatio`. The value was validated once; a
  // record whose property answers differently the second time would otherwise be validated
  // and then not used, which is the second half of A12's sweep ("for each caller-supplied
  // VALUE, name every site that reads it and ask whether the second read can answer
  // differently") applied to the value this entry is about.
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  // Deterministic per run, so the decision is stable across processes and reruns —
  // never Math.random().
  // `idText` for the same reason `spansFrom` uses it: `digestOf` throws on a non-string, and
  // this function's whole job is to answer yes or no about a run.
  const runId = events.length === 0 ? "" : idText(events[0]!.runId);
  const bucket = parseInt(digestOf(runId).slice(7, 11), 16) / 0xffff;
  return bucket < ratio;
}
