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
 * WHAT A SPAN IS ALLOWED TO LOSE, AND WHAT IT IS NOT ALLOWED TO CARRY — invariant 8, in the
 * one direction that is easy to get backwards. *Telemetry may drop data; the journal may
 * not.* Read forwards that licenses everything this file already does: an unusable scope
 * costs the `pii` attributes, a missing `LOOM_PII_TOKEN_KEY` costs them too, a value that
 * throws mid-walk costs one attribute, and a sampled-out run costs the whole trace. Read
 * BACKWARDS it is a prohibition rather than a licence: **a span may be poorer than the
 * journal and may never be richer.** The journal is the source of truth and is not redacted,
 * so "richer" cannot mean an extra fact; it can only mean a fact the journal holds under a
 * classification and this file ships without one. That is what `ATTRIBUTE_CLASSES` and the
 * `close`-only egress are between them for.
 *
 * CHECKED, RATHER THAN ASSERTED, BECAUSE THE LAST TWO DEFECTS HERE WERE BOTH "a second bag
 * nobody enumerated". `done.push` happens in `close` and nowhere else, `close` runs all
 * three bags through `redactAttributes`, and the end-of-journal sweep closes what is still
 * open through the same function — so there is one egress. What that egress hands on is
 * deliberately narrow, and the narrowing is where the real protection is: the fold takes
 * `binding.channel` and never `binding.value`, `state.reduced`'s `channels` and never its
 * `values`, `effect.completed`'s key and never its `result`, `run.completed`'s usage and
 * never its `outputs`, and an error's `code` and never its `message` or `details`. Every
 * payload field a secret actually travels in is left in the journal, where an authenticated
 * operator reads it and a collector does not.
 *
 * WHICH LEAVES THE FREE TEXT, and that is where this file leaked. `gate.reason` and
 * `run.suspended`'s reason are operator- and channel-authored strings, and `to` is a
 * recipient list; the first two get `redact.ts`'s detector sweep and the third is `pii`.
 * The sweep did not know the shape a credential most often takes — `scheme://user:pass@host`
 * — so a gate withdrawn by a channel that quoted its own URL put a live password on a span
 * bound for a third-party collector, in the clear, while `providers/http.ts` masked the
 * identical string one road over. `url-credentials` in `DETECTORS` is that hole closed, in
 * the one walk rather than in this file, so the SSE stream and gate delivery close with it.
 * See the WHICH BOUNDARY note in `security/redact.ts` for why a fix there is still only half
 * of it: the journal keeps what the write boundary let through, and this file is downstream
 * of that by construction.
 *
 * **AND THE SWEEP OVER THAT FREE TEXT IS A WINDOW, NOT THE WHOLE STRING** — the sentence
 * above says "get `redact.ts`'s detector sweep" and this is the width of it. Those strings
 * have no declared length and `pem` in `DETECTORS` is quadratic in its input, so `close`
 * takes `redactAttributes`' default `maxSweepBytes` (8 KB per string leaf) and a detector run
 * beginning past it is not found. Nothing is truncated and no attribute is dropped for
 * length; what changed is only how far the BACKSTOP looks. The declared path —
 * `ATTRIBUTE_CLASSES`, and the deliberately narrow set of payload fields this fold reads at
 * all — is unaffected, which is where the real protection was already stated to live.
 */

import { digestOf } from "../canonical.ts";
import { redactAttributes } from "../security/redact.ts";
import { effectKey } from "../ids.ts";
import type { EdgeId, NodeId, RunId, TaskId } from "../ids.ts";
import { isEvent, type EventPayloads, type JournalEvent } from "../journal/events.ts";
import type { GraphSpec } from "../graph/spec.ts";
import { isHardToUndo, type Classification, type IrreversibilityClass } from "../vocab.ts";

export type SpanKind = "internal" | "server" | "client";
export type SpanStatus = "unset" | "ok" | "error";

export interface SpanLink {
  readonly spanId: string;
  /**
   * The trace the linked span lives in, when it is not this one — and the field exists
   * because of the subgraph arms below.
   *
   * A link was a bare `spanId` while D9.1's producer-Task links were the only design for
   * one, and those are same-trace: a span id alone resolves. A child run is a DIFFERENT
   * trace (`traceId` is `digest(runId)` and the child's run id is `${parent}~${taskId}`),
   * so a bare span id points at nothing an OTLP collector can follow — `SpanContext`
   * requires both halves. Optional rather than required so every existing producer of a
   * same-trace link keeps its shape.
   */
  readonly traceId?: string;
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
 * a run id is not a secret (see REGISTER A13's "checked and NOT this defect" list) and a
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
/**
 * The resource attribute naming which run a span batch came from, for an OTLP export.
 *
 * HERE, AND NOT AT THE EXPORTER, because `registries.test.ts` holds one rule about this
 * vocabulary: one file owns it. An attribute spelled in a second file is a name that can be
 * spelled two ways, and the guard caught exactly that — `server/http.ts` minted `"loom.run_id"`
 * of its own when the trace route was added. It is not a span NAME (the taxonomy is nine and §D.2
 * answered "no ninth"), but it is telemetry vocabulary and the rule is about the vocabulary.
 */
export const OTLP_RUN_ID_ATTR = "loom.run_id";

/**
 * The resource attribute saying the fold this batch came from was over a PREFIX of the journal.
 *
 * Here for the same reason as `OTLP_RUN_ID_ATTR` — one file owns the `loom.*` vocabulary — and
 * present at all because `?format=otlp` had no way to say it. The trace route bounds its fold at
 * `MAX_TRACE_EVENTS` and its docstring promises the response says `truncated: true` "so nobody
 * reads a partial waterfall as a finished one"; the `spans` branch kept that promise and the
 * `otlp` branch silently dropped it, because `ExportTraceServiceRequest` has no field for it.
 * A resource attribute is where OTLP puts a fact about the batch rather than about a span.
 *
 * ONLY EMITTED WHEN TRUE. An absent attribute and `false` mean the same thing to a collector,
 * and the honest signal is the one that appears exactly when there is something to say.
 */
export const OTLP_TRUNCATED_ATTR = "loom.trace.truncated";

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
  // The FIRST READABLE instant in the journal, not `0`. When the first event's `ts` is
  // unreadable the loop below carries `lastTs` forward, and seeding it at the epoch would
  // put the run's own span at 1970 and every span before the first good `ts` with it — a
  // fabricated measurement, which is the failure mode this whole guard exists to avoid.
  // Scanning forward costs one pass over a list already in memory and finds the earliest
  // instant the journal actually claims.
  let lastTs = events.find((x) => typeof x.ts === "number" && Number.isFinite(x.ts))?.ts ?? 0;

  /**
   * The order spans were STARTED in, which is journal order, which is causal order.
   *
   * The tie-break below used to be `spanId`, and a span id is a digest — so two spans starting
   * in the same millisecond were ordered by a hash. Measured on a four-node run: `collect`
   * (a join) and `write` (the node that consumes it) both reached `task.ready` at ts …882080,
   * and the trace printed `write` ABOVE `collect`, reversing the one edge between them. A
   * millisecond is simply too coarse to order tasks — this run put five of them inside nine.
   *
   * `seq` is the total order the journal already has, and this loop consumes events in it, so
   * an incrementing ordinal at `start` recovers it without threading `e.seq` through fifteen
   * call sites or putting a new `loom.*` attribute on the exported span.
   */
  const startOrder = new Map<string, number>();
  let startOrdinal = 0;

  /**
   * THE SUBGRAPH LEDGER, and the reason there are two maps rather than one.
   *
   * A `subgraph` node's child is a separate run with its own journal, so THIS fold can only
   * ever produce a link — see the SUBGRAPH arms below. What it needs to carry across events
   * is which effect span the child's `subgraph.started` opened, and it is asked two
   * different questions about that:
   *
   *   - `subgraph.completed` asks BY CHILD RUN ID, because that is the only id on its
   *     payload and matching on it cannot pair a completion with the wrong child;
   *   - `task.committed` / `task.cancelled` / `task.skipped` ask BY TASK, because a child
   *     the parent never heard finish has to be closed by the parent's own terminal event
   *     rather than left open. That list's LENGTH is also the effect ordinal, which is what
   *     keeps the span id equal to the one `effect.started` will derive.
   */
  const subgraphSpanOf = new Map<string, string>();
  const subgraphSpansOfTask = new Map<string, string[]>();
  /** The same ids as a set, because `effect.completed` asks only "is this one of them?". */
  const subgraphSpanIds = new Set<string>();
  const start = (id: string, o: Open): void => {
    if (open.has(id)) return;
    open.set(id, o);
    startOrder.set(id, startOrdinal++);
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
      //
      // AND THE SWEEP INSIDE IT IS WINDOWED, WHICH IS A COST RATHER THAN A PROTECTION.
      // `redactAttributes` bounds the detector backstop to the first 8 KB of each string
      // leaf by default. The three bags carry operator- and channel-authored free text of no
      // declared length — `gate.reason`, `run.suspended`'s reason, `policy.reasons` — and one
      // entry in `DETECTORS` is quadratic in its input, so unbounded this fold is a `loom
      // trace` that parks rather than one that fails. Nothing is truncated; a detector run
      // that BEGINS past 8 KB in one attribute is what the bound lets past, and dropping the
      // attribute instead (which invariant 8 would license, and which the three arms in
      // `redactAttributes` already do) would lose the reason an operator opened the trace
      // for. `security/redact.ts`'s `DETECTORS` states the trade in full.
      attributes: redactAttributes({ ...o.attributes, ...extra }, ATTRIBUTE_CLASSES, runId),
      // THE REBUILD IS FIELD-BY-FIELD AND `traceId` IS ONE OF THE FIELDS — said here because
      // this arm reconstructs the link rather than patching it, so a field it forgets is
      // silently DROPPED rather than left alone. `traceId` was added for the subgraph link
      // below and is the first optional field a link has ever had; the redaction branch is
      // the only place in this file that could lose it, and losing it turns a
      // follow-the-child link into a span id in nobody's trace.
      links: o.links.map((l) =>
        l.attributes === undefined
          ? l
          : {
              spanId: l.spanId,
              ...(l.traceId === undefined ? {} : { traceId: l.traceId }),
              attributes: redactAttributes(l.attributes, ATTRIBUTE_CLASSES, runId),
            },
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
  /**
   * A CHILD THE PARENT NEVER HEARD FINISH IS NOT A CHILD STILL WORKING.
   *
   * Every non-success exit of `#runSubgraph` returns BEFORE the batch that writes
   * `effect.started` / `effect.completed` / `subgraph.completed`, so a failed child, a
   * cancelled one, and one that gave up on a gate all leave the parent's journal holding a
   * `subgraph.started` and nothing else about the child. Left alone, that span fell out of
   * the end-of-journal sweep with `status: "unset"` at the LAST event in the run — which
   * renders exactly like a child still in flight, at the wrong end time, on the one span a
   * reader opened the trace to look at.
   *
   * The parent's own terminal task event is the honest place to close it: it is the moment
   * the parent stopped waiting. A RETRY is deliberately not that moment — `task.failed`
   * without a commit is the retryable-unavailable path, where the child genuinely is still
   * going and the parent will re-enter — so this fires on `task.committed`, `task.cancelled`
   * and `task.skipped` only, and a span that spans three attempts is telling the truth.
   *
   * `subgraph.status: "unreported"` is the one value on that key that is not a child run
   * status, and it means precisely that: THIS journal records no verdict, go read the
   * child's. Claiming `failed` here would be inventing one — the parent knows its own task
   * failed and not whether the child failed, was cancelled, or is still running.
   */
  const closeUnreportedSubgraphs = (taskId: string, ts: number, status: SpanStatus): void => {
    for (const id of subgraphSpansOfTask.get(taskId) ?? []) {
      if (open.has(id)) close(id, ts, status, { "subgraph.status": "unreported" });
    }
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
          // WHICH BATCH ONE CLICK WOULD CLOSE — present iff this gate joined one, which is
          // this file's usual "absent means absent" (see `subgraph.budget_usd` and
          // `branch.item_channel`). A boolean would answer "was it batched?" and lose the
          // question a reader of a saturated queue actually asks, which is WHICH gates merged;
          // the value is the founder's gateId, so grouping on it is a filter rather than a
          // scan and "was it batched?" is still `present`.
          //
          // THE ID AND NOTHING ELSE OFF THAT PAYLOAD, and the omission is the load-bearing
          // half. `batch.deliveryDigest` is `digest(the founder's DeliverySpec)` — its
          // recipients and its redact list — which is `gate.content_digest`'s confirmation
          // oracle over a domain SMALLER than a gate payload: a handful of channels and a
          // recipient list are guessable in the way this file's header says a company
          // directory is. It stays in the journal, where `gate.id` reaches it. `windowMs` and
          // `maxBatch` are the batch's governance and disclose nothing, but they are not in
          // C.2's documented set and a span attribute nobody asked for is still a vocabulary
          // this file has to keep.
          //
          // NO `ATTRIBUTE_CLASSES` ENTRY, deliberately: a gateId is not a digest and not a
          // person, and `gate.id` two lines up is already in the clear on this very span.
          ...(typeof e.payload.batch?.id === "string" ? { "gate.batched": e.payload.batch.id } : {}),
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
          // REGISTER A12 asks of every value read twice — the span id above is derived from
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
          // THE CAPABILITY THE DECISION WAS ABOUT — optional on the payload, so absent here
          // when absent there rather than rendered as `undefined`, which is what
          // `exactOptionalPropertyTypes` and an OTLP exporter both distinguish.
          //
          // AND IT IS ABSENT ON EVERY JOURNAL THIS BINARY WRITES, WHICH IS A FACT ABOUT
          // `run/engine.ts` AND NOT ABOUT THIS FOLD. Both of its `policy.decided` appends
          // build the payload literally and neither includes `capability`, although
          // `PolicyEngine.decide` is handed `capabilities: this.#capabilitiesOf(node)` one
          // statement earlier — measured on a driven `two-person-approval` run, three
          // `policy.decided` rows, none carrying the key. So this reads a field the
          // vocabulary declares and the writer forgot; it is the fold's half of C.2 and it
          // does not close that row on its own.
          ...(typeof e.payload.capability === "string" ? { capability: e.payload.capability } : {}),
        },
        links: [],
        events: [],
      });
      close(id, ts, e.payload.effect === "deny" ? "error" : "ok");
      continue;
    }
    if (isEvent(e, "effect.started")) {
      const id = spanId(runId, "effect", e.payload.key);
      // Hoisted out of the `name:` ternary because the ATTRIBUTES need the same answer: a
      // `tool.*` key belongs on a `loom.tool` span and nowhere else, which is the rule
      // `tool.name` / `tool.version` / `tool.irreversibility` / `tool.idempotent` already
      // follow. The three NAME literals stay inline on `name:` for the reason below.
      //
      // THREE ARMS OVER SEVEN KINDS, AND THE SEVEN ARE A CLOSED LIST — `effect.started.kind` in
      // `journal/events.ts` is `model | tool | subgraph | summarize | random | compensate |
      // quote`. The
      // partition is total because `Unplaced` below is checked against that union, NOT because
      // three arms happen to cover it today: a reviewer falsified the earlier wording of this
      // sentence by appending a seventh kind, which compiled clean and landed on `loom.effect`
      // in silence.
      //
      // The partition was TWO arms and it put three kinds in the wrong one. `modelish` was
      // right; its negation was not, because `!modelish` is not `tool`. Measured by driving a
      // `function` body containing `Math.random()` through `Engine` — the engine journals the
      // PRNG seed as `effect.started {kind: "random"}` under `effectKey(task, "random", 0)`,
      // and this fold turned it into:
      //
      //     loom.tool  effect.kind=random  tool.name=undefined
      //
      // A seed draw, in a trace, named a tool call. The same negation sent `subgraph` to
      // `loom.tool`, which `cli.ts`'s trace renderer already had to paper over by printing
      // the kind in parentheses — its comment says adding a name "would be a taxonomy change,
      // which is a design decision and is recorded as one rather than taken here". This is
      // that decision, taken: TODO C.1 registers `loom.effect` as designed-and-unbuilt, and
      // it is exactly the name for an effect that is neither a model call nor a tool call.
      //
      // WHY NOT A GENERIC PARENT OVER ALL FOUR, which is the other reading of `loom.effect`:
      // it would either mint a second span per effect (doubling the row count this file's
      // header explicitly budgets — "~500 task spans, not 2,500") or rename `loom.model` and
      // `loom.tool` out of existence, losing the `gen_ai.*` and `tool.*` groupings that are
      // the reason those two names are worth having. A parent whose only content is the union
      // of its children is not a taxonomy, it is an indirection. So `loom.effect` is the
      // REMAINDER arm — the kinds with no more specific span — and the specific names keep
      // meaning exactly what they say.
      //
      // `compensate` is a tool call and stays one: `#callTool` takes `effectKind: "tool" |
      // "compensate"` and journals `tool.called` on both paths, so a compensation span
      // carries `tool.name` and `tool.version` like any other.
      const modelish = e.payload.kind === "model" || e.payload.kind === "summarize";
      const toolish = e.payload.kind === "tool" || e.payload.kind === "compensate";
      // AND THE THIRD ARM IS NAMED, so the partition is total by CONSTRUCTION rather than by a
      // sentence claiming to be. The claim above used to say "a seventh kind would not typecheck
      // against it without being placed", and that was false: the `name:` ternary below ends in
      // an untyped `else`, so appending `| "sleep"` to `effect.started.kind` compiled clean and
      // landed silently on `loom.effect`. Driven, and it is why this line exists.
      //
      // `Exclude` over the union is what holds the claim: a seventh kind that is in none of the
      // three lists makes `_Unplaced` non-empty and this assignment stops compiling, naming the
      // kind nobody placed. Costs one line and no runtime.
      //
      // `quote` IS PLACED HERE DELIBERATELY, and the temptation was `modelish`. It is asked of a
      // model adapter, so it looks like a model call — but it reaches no provider, bills nothing
      // and has no `model.called` beside it, so `loom.model` would put `gen_ai.*` groupings on a
      // span with no generation and DOUBLE the model-span count per agent turn, against this
      // file's own row budget ("~500 task spans, not 2,500"). `loom.effect` is the remainder arm
      // for exactly this: an effect that is neither a model call nor a tool call.
      const otherish = e.payload.kind === "subgraph" || e.payload.kind === "random" || e.payload.kind === "quote";
      type Placed = "model" | "summarize" | "tool" | "compensate" | "subgraph" | "random" | "quote";
      type Unplaced = Exclude<EventPayloads["effect.started"]["kind"], Placed>;
      // `[X] extends [never]` and not `X extends never`: the bare form is a DISTRIBUTIVE
      // conditional, which over `never` distributes across nothing and yields `never` rather
      // than `true`. And not `const u: Unplaced[] = []` either, which was the first attempt and
      // is vacuous — an empty array is assignable to every array type, so it accepted a seventh
      // kind in silence exactly as the untyped `else` had. Measured both ways by appending
      // `| "sleep"` to the union and re-running `tsc`.
      const allKindsArePlaced: [Unplaced] extends [never] ? true : false = true;
      void allKindsArePlaced;
      start(id, {
        // `summarize` rides with `model` because it IS a model call — the journal now says
        // so honestly. The literals stay on this line on purpose, and the reason has OUTLIVED
        // the guard that used to be named here: `docs-drift.test.ts` went with the design
        // corpus at `f975f9f` and `git ls-files | grep -a docs-drift` returns nothing at HEAD,
        // so citing it was pointing at a check that cannot run. What survives is the READING —
        // `/usr/bin/grep -an 'name: "loom\.' packages/core/src/telemetry/spans.ts` is how the
        // built span-name set is counted (TODO C.1 does exactly that). It returns seven, and
        // this ternary hides TWO of the nine rather than one: `loom.model` and `loom.tool`.
        // The count is still right by accident and for a different reason than it was, because
        // the seventh literal it does see used to be the `subgraph.started` arm saying
        // `loom.tool` — the mis-classification itself — and now says `loom.effect`, which is
        // the name that arm should always have had. A lookup table would hide all nine. So:
        // the literal, on the `name:` line, still.
        name: modelish ? "loom.model" : toolish ? "loom.tool" : otherish ? "loom.effect" : "loom.effect",
        kind: "client",
        start: ts,
        parent: taskSpan,
        attributes: {
          "loom.effect.key": e.payload.key,
          "effect.kind": e.payload.kind,
          // WHICH ATTEMPT PERFORMED THIS EFFECT — journaled on every `effect.started` and,
          // until now, the one third of that payload this fold read and threw away. The span
          // is downstream of the journal and may be poorer than it (invariant 8), but being
          // poorer for no reason is not a decision anybody made here.
          //
          // ON THE `loom.tool` ARM ONLY, because the documented key is `tool.attempt` and a
          // `tool.*` key on a `loom.model` span would be a spelling this file invented. A
          // model turn's attempt is therefore still dropped; that is a naming gap in C.2's
          // table, not a claim that the value is unavailable.
          //
          // `toolish`, NOT `!modelish` — and this was the same defect as the name above,
          // wearing the same disguise. The negation put `tool.attempt` on the `random` and
          // `compensate` spans too, so the very rule this comment states was broken by the
          // line enforcing it: a `tool.*` key sat on a PRNG seed draw. `compensate` keeps it
          // because a compensation IS a tool call; `random` and `subgraph` lose it because
          // they are not, which is the same partition the name uses and deliberately so.
          //
          // EVERY WRITER IN `run/engine.ts` PASSES THE LITERAL `1` — all five sites, measured
          // — so this reads a constant against today's engine. It is a faithful read of a
          // journaled field rather than a derivation, so a journal that ever carries a second
          // attempt renders it without this file changing again.
          ...(toolish ? { "tool.attempt": e.payload.attempt } : {}),
        },
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
    // ── the subgraph arms ───────────────────────────────────────────────────────
    //
    // ONE TREE OR TWO, ANSWERED: **two on the wire, one on the screen.** The fold LINKS;
    // `spliceSubgraph` — a separate, pure function a caller reaches for after doing its own
    // I/O — joins two folds into one picture. The argument, because it is the whole design:
    //
    //   - `spansFrom` is a pure fold over ONE journal, and the child's events are in
    //     ANOTHER one under `${parent}~${taskId}`. Reaching them is I/O, and this function
    //     may not do I/O for the same reason `foldRun` may not: a projection you cannot
    //     rebuild synchronously from the events in hand is not a projection. So the fold
    //     produces the only thing the parent's journal actually holds — the child's run id,
    //     its ref, its graph hash, its budget slice, and whatever terminal facts came back.
    //   - Splicing is what an OPERATOR wants, and it is a claim the wire format should not
    //     make on its own: it rewrites the child's `traceId` to the parent's and parents a
    //     span on one that lives in another journal. Both are fine in a renderer and wrong
    //     in an exporter, where the two runs are two traces that a collector joins BY THE
    //     LINK. Doing it in the fold would also mean `spansFrom(parent)` could not be
    //     computed without a store, which is the property this file opens by claiming.
    //
    // So the honest boundary is preserved in the data and the readable picture is one
    // function call away, and neither is paid for by the other.
    //
    // THE SPAN IS THE EFFECT SPAN, NOT A SECOND ONE BESIDE IT. `#runSubgraph` journals
    // `subgraph.started` when it submits the child, and `effect.started` + `effect.completed`
    // + `subgraph.completed` in ONE batch after the child finished — so a span built from the
    // effect pair alone is ZERO-WIDTH for a child that ran for an hour, and a span built from
    // `subgraph.started` under its own id would be a second row for one thing. Opening the
    // effect span here, under the id `effect.started` will derive, gives one span whose width
    // is the child's actual life. `start` is a no-op on an id already open, so the
    // `effect.started` arm above needs no change and still covers a journal that somehow
    // carries the effect pair without the `subgraph.started`.
    //
    // THE ORDINAL IS COUNTED, NOT ASSUMED. `effectKey(task, "subgraph", n)` is the engine's
    // own convention and `#runSubgraph`'s single call site passes `0` today; counting the
    // starts this task has already made is that same numbering rather than a constant that
    // would silently address the FIRST child's span if a second ever appeared.
    if (isEvent(e, "subgraph.started")) {
      const child = idText(e.payload.childRunId);
      const opened = subgraphSpansOfTask.get(tid) ?? [];
      const id = spanId(runId, "effect", effectKey(tid as TaskId, "subgraph", opened.length));
      opened.push(id);
      subgraphSpansOfTask.set(tid, opened);
      subgraphSpanOf.set(child, id);
      subgraphSpanIds.add(id);
      start(id, {
        // THE SAME NAME THE `effect.started` ARM WOULD GIVE IT, and it has to be: `start` is a
        // no-op on an open id, so whichever of the two arms fires first names the span for
        // good. This one normally wins (`subgraph.started` is journaled at submit, the effect
        // pair only after the child finished), and the other one covers a journal that lost
        // the start — so if these two literals ever disagree, the span's name would depend on
        // which events a read happened to contain. They agree: `subgraph` is in this file's
        // `loom.effect` arm above, for the reason stated there.
        name: "loom.effect",
        kind: "client",
        start: ts,
        parent: taskSpan,
        attributes: {
          "loom.effect.key": effectKey(tid as TaskId, "subgraph", opened.length - 1),
          "effect.kind": "subgraph",
          "subgraph.ref": e.payload.ref,
          // THE WHOLE ROUTE, and it costs one attribute. Without it the most interesting
          // node in the graph is where the trace goes blind: the reader can see that a
          // child ran and has no way to name the run it was.
          "subgraph.child_run_id": child,
          "subgraph.graph_hash": e.payload.graphHash,
          // `null` means unbounded (the payload says so), and an attribute reading
          // `subgraph.budget_usd: null` is a limit that looks declared. Absent means absent.
          ...(e.payload.budgetUsd === null || e.payload.budgetUsd === undefined ? {} : { "subgraph.budget_usd": e.payload.budgetUsd }),
        },
        // A LINK, WITH BOTH HALVES OF A SPAN CONTEXT. The child's root span id is a pure
        // function of its run id — `spanId(childRunId, "run")` — so this is derivable here
        // without reading a byte of the child's journal, which is exactly why linking is
        // what a pure fold can honestly do. `traceId` rides along because the child is a
        // different trace and a bare span id would resolve in nobody's.
        links: [
          {
            spanId: spanId(child, "run"),
            traceId: digestOf(child).slice("sha256:".length, "sha256:".length + 32),
            attributes: { "run.id": child, "subgraph.ref": e.payload.ref },
          },
        ],
        events: [],
      });
      continue;
    }
    if (isEvent(e, "subgraph.completed")) {
      // BY CHILD RUN ID, and a completion whose start is not in this journal is DROPPED
      // rather than given a span: the id it would be filed under is derived from an ordinal
      // this fold never saw, so inventing one would draw a subgraph in the wrong place.
      // (Reachable through a rewind that suppressed the start, or a truncated read.)
      const id = subgraphSpanOf.get(idText(e.payload.childRunId));
      if (id === undefined) continue;
      close(id, ts, e.payload.status === "succeeded" ? "ok" : "error", {
        "effect.outcome": "completed",
        // THE CHILD'S OWN VERDICT, which is the fact this arm exists for: a parent whose
        // task succeeded tells you nothing about whether the child it delegated to did.
        "subgraph.status": e.payload.status,
        "subgraph.outputs": claimedList(e.payload.outputs).length,
        // The child's whole spend, which `#runSubgraph` settles against the parent's
        // ceilings — so a reader can see where a parent's budget went without opening the
        // child's journal. `outputs` is a COUNT and never the values: the fold's narrow-egress
        // rule (see the header) reads a key and never a result.
        "usage.input_tokens": e.payload.usage.inputTokens,
        "usage.output_tokens": e.payload.usage.outputTokens,
        "cost.total_usd": e.payload.usage.costUsd,
      });
      continue;
    }

    if (isEvent(e, "effect.completed")) {
      const id = spanId(runId, "effect", e.payload.key);
      // A SUBGRAPH IS CLOSED BY ITS OWN COMPLETION, one event later in the SAME append.
      // `effect.completed` carries no `kind`, so without this test the span closed here and
      // the `subgraph.completed` that follows found a closed span and was dropped — the
      // child's status, its usage and its output count lost to an ordering inside one batch.
      // Both events carry the same `ts`, so nothing about the span's width depends on which
      // one closes it; what depends on it is whether the child's verdict is on the trace.
      if (subgraphSpanIds.has(id)) continue;
      close(id, ts, "ok", { "effect.outcome": "completed" });
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
      closeUnreportedSubgraphs(tid, ts, e.payload.status === "succeeded" ? "unset" : "error");
      close(taskSpan, ts, e.payload.status === "succeeded" ? "ok" : "error");
      continue;
    }
    if (isEvent(e, "task.failed")) {
      attr(taskSpan, { "error.code": e.payload.error.code });
      continue;
    }
    if (isEvent(e, "task.cancelled")) {
      closeUnreportedSubgraphs(tid, ts, "error");
      close(taskSpan, ts, "error", { "task.status": "cancelled", "cancel.clean": e.payload.clean });
      continue;
    }
    if (isEvent(e, "task.skipped")) {
      closeUnreportedSubgraphs(tid, ts, "unset");
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

  // Deterministic order, so two traces of the same journal are byte-identical — and, on a tie,
  // the order the journal put them in rather than the order their digests happen to fall in.
  return done.sort((a, b) => a.startTime - b.startTime || (startOrder.get(a.spanId) ?? 0) - (startOrder.get(b.spanId) ?? 0));
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
 *   - `spansFrom`'s twelve journal reads — REGISTER A18, deliberately loud, and one decision
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

/**
 * `ReconstructedGraph.graphHash` when the trace claimed more than one — a REFUSAL wearing
 * the shape of an answer that nothing can match.
 *
 * Parenthesised for the same reason `idText`'s `(null)` and `(object)` are: it is a marker
 * naming a shape, not a value from the trace, and this file's readers already know that
 * spelling. It inherits `idText`'s stated limit too — nothing validates the FORMAT of a
 * graph hash, so `conformsToGraph(r, spec, "(multiple)")` is a call anybody can make and
 * would certify. That is the weaker honest claim rather than an open hole: every hash this
 * repo computes is `sha256:…` from `digestOf`, and the caller supplying the expected hash
 * is the trusted half here — it is the TRACE this function defends against.
 */
const MULTIPLE_GRAPHS = "(multiple)";

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
  // A SET, BECAUSE A SPLICED TRACE HAS MORE THAN ONE `loom.run` SPAN. See `MULTIPLE_GRAPHS`.
  const hashes = new Set<string>();

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
      hashes.add(idText(claimed));
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
    // ONE GRAPH OR A REFUSAL — and until `spliceSubgraph` existed there was no third case,
    // which is why the old `graphHash = …` was LAST-WRITE-WINS and nobody noticed. A spliced
    // trace carries the parent's `loom.run` span and the child's, each claiming its own hash,
    // so the verdict `conformsToGraph` reached depended on which run's span happened to sort
    // last — certifying a two-graph trace against whichever spec the caller held. `hashMatches`
    // is a claim about ONE graph; a trace covering two cannot satisfy it, and the honest
    // answer is a hash equal to neither.
    graphHash: hashes.size > 1 ? MULTIPLE_GRAPHS : ([...hashes][0] ?? ""),
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
// Following a subgraph
// ---------------------------------------------------------------------------

/**
 * The child runs this trace points at — the READ half of the subgraph link.
 *
 * Exported rather than left as three lines in `cli.ts` because the attribute key is the
 * contract: a caller that has to spell `"subgraph.child_run_id"` itself is a second copy of
 * the vocabulary, and this file has already paid twice for a bag nobody enumerated. It is
 * also the whole of what a caller needs to know before doing the I/O the fold refuses to do:
 * fold the parent, ask this, read those journals, fold each, `spliceSubgraph`.
 *
 * Deduplicated and in first-seen order, which for a fold of one journal is the order the
 * children were started in.
 *
 * TOTAL over a hostile trace, like everything else on this side of the file: the argument is
 * a value whose premise says it need not have come from `spansFrom`, so the container, its
 * length and every element go through `isList` / `readProp`, and an element that answers
 * nothing readable contributes nothing rather than throwing. An unreadable trace yields no
 * children, which is the fail-CLOSED direction here — the cost of a missed link is a picture
 * that stops at the boundary, which is exactly where it stopped before this existed.
 */
export function childRunIdsOf(spans: readonly Span[]): readonly string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!isList(spans)) return out;
  const n = readProp(spans, "length");
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return out;
  for (let i = 0; i < n; i++) {
    const claimed = readProp(readProp(readProp(spans, String(i)), "attributes"), "subgraph.child_run_id");
    if (typeof claimed !== "string" || claimed === "" || seen.has(claimed)) continue;
    seen.add(claimed);
    out.push(claimed);
  }
  return out;
}

/**
 * Join a child run's fold into its parent's, for a reader — the SPLICE half.
 *
 * PURE, AND SEPARATE FROM `spansFrom`, which is the decision this pair exists to record.
 * The fold cannot reach a child's journal without becoming asynchronous, and a `spansFrom`
 * that needs a store is no longer the pure function of one journal this file opens by
 * claiming. So the caller does the I/O — `cli.ts`'s `trace` reads each linked run and folds
 * it — and this function performs the two edits that turn two traces into one tree:
 *
 *   - every child span takes the PARENT'S `traceId`. One tree is one trace id; a spliced
 *     child keeping its own is two trees wearing one, and no viewer would draw it;
 *   - the child's ROOT span takes the parent's subgraph span as its parent, found through
 *     the link the fold already minted. Nothing is matched by run id or by name: the join
 *     is the link, so a trace with no link splices nothing.
 *
 * NOTHING IS INVENTED AND NOTHING IS DROPPED. A child span whose id is already present is
 * skipped, so a caller walking a queue that reaches the same child twice gets the same
 * answer — `loom trace` does exactly that. Ids cannot collide by accident: `spanId` is
 * derived from the run id, and two runs have two ids.
 *
 * WHAT THIS COSTS, SAID PLAINLY. `pii` attributes are tokenised at `close` under the RUN
 * that produced them, so a spliced tree carries tokens minted under two scopes: the same
 * approver in a parent and in its child does not compare equal. That is a truthful picture
 * of a real boundary — two journals, two replays, two gate sets — and it errs in the
 * tightening direction, which is the only direction this repo allows a scope to move.
 *
 * AND WHAT IT DOES TO CONFORMANCE, stated as narrowly as it is true: a spliced trace covers two
 * graphs, so `reconstructGraph` reports `graphHash: "(multiple)"` rather than certifying
 * against whichever `loom.run` span sorted last. That is a SENTINEL NO REAL HASH MATCHES, not
 * a refusal — a caller who passes `"(multiple)"` as the expected hash still gets a match, and
 * `MULTIPLE_GRAPHS`' own docstring says so. The distinction matters because the trace is the
 * untrusted half here and the caller is not: this defends against a trace claiming to be one
 * graph, and does not pretend to defend against a caller who asks the wrong question. `loom trace` therefore computes conformance over the PARENT's own fold,
 * which is the question it was always answering.
 *
 * Total over both arguments for `childRunIdsOf`'s reason; an unreadable argument splices
 * nothing.
 */
export function spliceSubgraph(parent: readonly Span[], child: readonly Span[]): readonly Span[] {
  const base = readSpans(parent);
  const incoming = readSpans(child);
  // AN EMPTY PARENT SPLICES NOTHING — there is no tree to splice into, and grafting a child
  // into thin air would invent a root the caller did not ask for. `loom trace` cannot reach
  // this: a parent with no spans has no links, so the queue is empty.
  if (base.length === 0 || incoming.length === 0) return base;

  const traceId = base[0]!.traceId;
  const present = new Set(base.map((s) => s.spanId));
  // WHICH PARENT SPAN CLAIMS WHICH CHILD ROOT — built from `links`, which is the one place
  // the fold wrote the join down. A link whose target is not a root in `child` matches
  // nothing and costs nothing.
  const linkTarget = new Map<string, string>();
  for (const s of base) for (const l of s.links) if (typeof l.spanId === "string") linkTarget.set(l.spanId, s.spanId);

  const out: Span[] = [...base];
  for (const s of incoming) {
    if (present.has(s.spanId)) continue;
    present.add(s.spanId);
    const graft = s.parentSpanId === undefined ? linkTarget.get(s.spanId) : undefined;
    out.push({
      ...s,
      traceId,
      ...(graft === undefined ? {} : { parentSpanId: graft }),
    });
  }
  // Stable by start time, so the merged array is still the waterfall `spansFrom` promises.
  // A tie keeps insertion order — parent spans before the child spans grafted under them —
  // which is what `cli.ts`'s tree walk reads for sibling order.
  return out.sort((a, b) => a.startTime - b.startTime);
}

/**
 * A trace, read as a list of spans this file can work with — the shared front door for the
 * two functions above.
 *
 * An element is kept only if the three fields the splice actually writes are readable
 * (`spanId`, `traceId`, `startTime`); everything else rides along on the clone. Skipping
 * rather than throwing is `readProp`'s conflation one level up: a rendering function that
 * dies on a malformed span costs the operator the whole picture, and invariant 8 says
 * telemetry may drop data.
 *
 * **THE CLONE IS A READ TOO, AND THE SPREAD IS THE ONE THAT IS NOT `readProp`.** `{...s}`
 * runs `ownKeys`, a descriptor lookup and a `[[Get]]` per key, all of them `Proxy` traps —
 * so a claim of totality that stopped at the field reads would have had its counterexample
 * in the line below it, which is the split this file has now paid for four times. It is in a
 * `try` and a span that will not be copied is one this function did not read.
 *
 * `links` IS REBUILT RATHER THAN CARRIED, for the same reason and one level in: `isList`
 * unwraps a `Proxy` to its target, so a link bag that ANSWERS the container test can still
 * throw out of the `for…of` in `spliceSubgraph` — the `edges.taken` defect, in the one loop
 * the join is about. Bounded indexing through `readProp`, and a link with no readable
 * `spanId` joins nothing and is dropped.
 *
 * `MAX_CLAIMED` bounds the walk, so a trace claiming more than 65,536 spans splices nothing
 * at all. Stated rather than hidden: it is a cost guard, the bound is far above any run this
 * repo produces, and the failure is a picture that stops at the boundary — where it stopped
 * before this function existed.
 */
function readSpans(v: unknown): Span[] {
  if (!isList(v)) return [];
  const n = readProp(v, "length");
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_CLAIMED) return [];
  const out: Span[] = [];
  for (let i = 0; i < n; i++) {
    const s = readProp(v, String(i));
    const id = readProp(s, "spanId");
    const traceId = readProp(s, "traceId");
    const startTime = readProp(s, "startTime");
    if (typeof id !== "string" || typeof traceId !== "string" || typeof startTime !== "number") continue;
    try {
      out.push({ ...(s as Span), spanId: id, traceId, startTime, links: readLinks(readProp(s, "links")) });
    } catch {
      continue;
    }
  }
  return out;
}

/** A span's `links`, walked the way every other untrusted list in this file is. */
function readLinks(v: unknown): readonly SpanLink[] {
  if (!isList(v)) return [];
  const n = readProp(v, "length");
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_CLAIMED) return [];
  const out: SpanLink[] = [];
  for (let i = 0; i < n; i++) {
    const l = readProp(v, String(i));
    const target = readProp(l, "spanId");
    if (typeof target !== "string") continue;
    const traceId = readProp(l, "traceId");
    const attributes = readProp(l, "attributes");
    out.push({
      spanId: target,
      ...(typeof traceId === "string" ? { traceId } : {}),
      ...(attributes === undefined ? {} : { attributes: attributes as Readonly<Record<string, unknown>> }),
    });
  }
  return out;
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
 * they are throughout `spansFrom`, and making them total is REGISTER A18's single deliberate
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
          isHardToUndo((e.payload as { irreversibility?: IrreversibilityClass }).irreversibility as IrreversibilityClass))
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
