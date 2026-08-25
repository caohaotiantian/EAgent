# TODO

**Captured 2026-08-25, before the sweep.** The design corpus that held this backlog
(`design/loom/`, 14 documents; `packages/eagent/docs/`, 55) is being retired, so this file is
written to be **self-contained**: every item carries its own substance rather than a pointer into
a document that will not exist.

Nothing here is a plan. It is the set of things that were true about the code on the day the
redesign started, so that the redesign can decide each one deliberately instead of rediscovering
it. **An item surviving into the new design is a choice; an item being dropped is also a choice.**
Mark them off either way.

State at capture: 259 test files, 57 source files in `packages/core`, 106 in `packages/eagent`
(65 extensions), 3570 tests passing, zero-dep and public-surface guards green.

---

## A · Defects and unguarded behaviour

Each was verified against the code, not remembered.

- **Authoring warts, found by writing a real graph through `bin/loom`.** **(2) AND (3) ARE DONE**,
  and (3) turned out not to be a wart at all — see below. **(1) remains:** you cannot fan out from
  a graph's entry — a fan-out edge needs a source node, so every fan-out graph opens with a no-op
  `function` node whose only job is to exist. Not a correctness bug; it costs a user a node.

  **(2) closed** by `${x | json}`. The whole-string form still yields the VALUE, which is what a
  tool taking a structured argument needs; the filter is opt-in. Sized honestly in the commit:
  argument validation already refused the object before `execute` with an accurate message, so
  this removed a required workaround rather than a wrong value reaching a tool.

  **(3) was misread, and the truth was a real defect.** The warning was not noise-but-correct: it
  keyed on `graphBudget !== undefined`, so it fired on graphs that DO declare a ceiling — where
  its message ("the run budget cannot be proven") was false, since `Engine.submit` enforces
  `minDefined(caller, graph, deployment)` — and stayed silent on graphs declaring no budget at
  all, which nothing bounds: `PolicyEngine.reserve` skips its check when `runUsd` is undefined,
  `remainingUsd` returns Infinity, and `loom run` has no default. So the cheapest way to silence
  it was `delete policy.budget`, moving a graph from the bounded shape to the unbounded one.
  Now `GRAPH009_NO_BUDGET` covers the silent case and the old message says what is actually
  unprovable (`GRAPH009_BUDGET_OVERCOMMIT`'s sum). **The lesson worth keeping: "correct but
  noisy" was a conclusion reached by reading the warning, not by testing when it fires.**

- ~~**Confidentiality does not propagate, and a human ceiling erases it entirely.**~~ **HALF DONE.**
  A secret now FLOWS: `applySecretFlow` marks every channel a node writes after observing one that
  is `secret_ref`/`pii` or already carries a secret, folded at commit and rebuilt in
  `#restoreEvidence`. A laundered secret raises the hard floor to `in` exactly as taint does, so a
  human ceiling of `on` no longer erases it. The DECLARED classification stays clampable on
  purpose — it is written in the graph the human de-escalated, so their judgement covered it, and
  a fix that refused that too would make de-escalation impossible for any graph touching a secret.
  **Still open:** the compiler neither refuses nor warns about a laundering hop, so an author gets
  no diagnostic at authoring time; and the `dataFloor` in `validate.ts` still disagrees with
  `compile.ts` (below). Original finding, for the record:
  One `function` node copying a `secret_ref` channel into an `internal` (or unclassified) one drops
  the downstream node's floor from `in` to `on`, no gate is raised, and the plaintext reaches the
  tool — the compiler neither refuses nor warns. Separately, `effectivePosture`'s hard floor is
  `max(ceiling, tainted ? "in" : "on")`, which has terms for irreversibility and taint and **none
  for classification**, so a human ceiling of `on` erases a `secret_ref` floor with no laundering
  needed. The integrity axis has `applyTaint` as a working template; the confidentiality axis has
  no analogue. It must land at BOTH sites — `compile.ts`'s `dataFloor` and the engine's runtime
  `dataClassification` — because that pair has drifted before.
- ~~**`validate.ts` has no unknown-field check.**~~ **DONE.** `GRAPH020_UNKNOWN_FIELD` refuses any
  key a node block does not declare, and suggests the nearest real field. `ALLOWED_FIELDS` sits
  beside `REQUIRED_FIELDS` and is cross-checked against the interfaces it enumerates, because an
  allow-list that falls behind refuses correct graphs — worse than the hole it closed. It caught an
  invalid `humanGate: {prompt}` in a test graph of mine on its first run.
  **Still open:** the same check for a node's TOP-LEVEL fields (`id`, `reads`, `retry`, `unhandled`
  …) and for `GraphSpec` itself, neither of which is enumerated anywhere yet.
- **The journal amplifies a payload by `2N+2`.** **BOUNDED, NOT FIXED.** `prepare` now refuses a
  single canonical payload above 8 MiB (`E_PAYLOAD_TOO_LARGE`), which stops the runaway — a 256 MiB
  event used to be accepted at ~2.5 GiB of RSS — and says what to do instead. It does nothing about
  the amplification itself. **The real fix is payload externalisation**: a reference above a
  threshold, resolved on read. The write half is a threshold check in the same funnel; the read half
  is the hard part, because `foldRun` is SYNCHRONOUS and hands channel values straight to node
  bodies, so either the fold becomes async (touching the engine, gates, replay and audit) or the
  projection carries unresolved handles and replay's comparison learns to compare what they point
  at. `effect.completed` already carries `resultDigest`, so an externalised effect result keeps its
  identity for free; `task.committed` and `state.reduced` would need one. Original finding: Measured: `journal_bytes = payload × (2N + 2)`
  where N is the nodes a value flows through — `task.committed` and `state.reduced` each carry a
  full copy per hop, plus `run.submitted` and `run.completed`. One run, one 16 MiB value, four
  nodes = **160 MiB of SQLite**, fsynced. Nothing caps bytes anywhere: a 256 MiB single event is
  accepted by both stores. The one payload guard is `MAX_DEPTH` and it is byte-blind — 300-deep
  5 KB is refused, 2-deep 64 MiB is accepted. `foldRun` is NOT the problem (0.0 ms over 160 MiB;
  it copies references); the cost is in append and in replay, which re-materialises the whole
  journal at four sites and is strictly linear in bytes.
- ~~**`validate.ts` and `compile.ts` compute `dataFloor` from different sets.**~~ **DONE.** One
  exported `dataFloorOf` now, read by both. The drift was visible in the direction that matters: an
  author declaring `posture: "on"` beside a templated `secret_ref` read ran at `in` and was told
  NOTHING, because the validator computed the floor from `reads` alone and concluded the
  declaration was meaningful.

- **`E_ADMISSION_REJECTED` is raised by nothing.** `POST /runs` admits everything it can
  authenticate. There is no queue, no depth limit, no token bucket.
- **A provider rate limit sleeps holding the worker slot.** A 429 is absorbed by a retry that
  waits *inside* the concurrency slot, so one rate-limited provider can idle the whole node. This
  is the most consequential live defect in the list.
- **No circuit breaker.** Nothing measures a source's health and nothing withholds an unhealthy
  one. `SourceHealth` appears nowhere in the code.
- **A subgraph's cost ceiling binds nothing.** A child run's spend is settled *after* it finishes,
  so there is no point at which a cap could refuse rather than report.
- **`reads` is not enforced as the read set.** The compile rule covers edge conditions and router
  cases but never tool arguments, so a template can name a channel the node did not declare.
- **`reachableToolNames` does not descend into a subgraph**, so a subgraph node is classified
  `read_only` however irreversible its child is.
- **A branch choice made from untrusted content raises nothing.** Bounded twice (a router is
  confined to edges the author declared, and every target re-decides at full strictness), so it is
  a boundary rather than a hole — but it is an unexamined one.
- **Partial reads of untrusted values remain in ~25 files.** A revoked `Proxy` throws on
  `Array.isArray`; three files were swept, the rest were not. There are now three private copies of
  the same guard under three different names.
- **A rare suite flake, four sightings, never reproduced.** The last one was captured: a child
  process's stderr was read as a prefix. The lead is that the test helper waits for a known-last
  line on stdout and for nothing on stderr.

## B · Declared and wired to nothing

Mechanism that exists in the schema or the types and executes nowhere. Each is a place a reader
believes a feature is present.

- **Compensation edges** — a compile-time rollback proof and a rewind refusal exist; execution
  falls through and does nothing.
- **`JoinNode.timeoutMs`** — a barrier waits forever however small a number is written.
- **`Budget.tokens` and `Budget.wallMs`** — declared, never read; only cost binds.
- **`preAuthorization`** — a whole risk envelope (cost ceiling, blast radius, tool scope, data
  classification, allowed side effects, audit completeness, demotion triggers) that is not a field
  of the graph schema at all, so declaring one is silence.
- **Retention tiering** — proven by test, zero callers, so a journal never leaves the hot tier and
  grows without bound.
- **The evolution subsystem is now REACHABLE but not wired.** `agent().trajectory(runId)` folds a
  run into the shape the scorer reads, so capture has a caller for the first time. Still uncalled:
  cohort measurement, promotion ceilings and baselines — and the generator stays deferred, because
  under roughly thirty scored trajectories per cohort any candidate is fitted to noise.
- **Quorum, delegation and trust-tier approvals** — deliberate compile errors rather than silent
  downgrades. Implementing one means deleting its refusal in the same change.
- **The operator intervention surface** — no pause, resume, steer, redirect or kill; cancel exists.
- **The agent-to-agent mailbox** — designed, unbuilt; the edge kinds are seven with no eighth.
- **A worker pool for CPU-bound function bodies** — declared on the schema, warns at compile that
  it does nothing; a long body blocks the event loop and every task in the wave with it.
- **`run.cancelled.forced`** — written once as `false`, read by nobody, named by no document.
- **Eleven error codes and six event types with no writer**, each excused in a registry.
- **Nine declared-and-unread schema fields** beyond the above, and four constants whose docstrings
  claimed a consumer they did not have (now corrected in place).

## C · Unbuilt observability, which several other items depend on

- **Eight span names are designed and unbuilt**, and roughly fifteen documented span attributes are
  never set by anything.
- **Two documented reversal conditions are percentiles over spans nobody emits**, so each currently
  reads as a check that passed.
- **A trace cannot follow a subgraph.** The journal records the child run id; no span is built from
  it, so a parent trace offers no route to its child.
- **No scheduler-tick telemetry**, so queue behaviour is unmeasurable.

**This block gates the UI direction.** A richer operator surface over a plane that is not emitting
is a better view of nothing.

## D · Decisions that were blocked on the maintainer

Twenty-one, escalated 2026-08-24. Two are now answered — the UI is the web console, and the
terminal client is deleted. The rest stand, and the redesign may dissolve several of them rather
than answering them. **The five that change what gets built:**

1. **The first real workflow to port.** Nobody has yet used this system for something they actually
   needed. Every clause of the stated bar is verified by running; that is not the same evidence.
2. **The real numbers** — tenants, concurrent runs, runs/day, fan-out width. Several deferrals rest
   on the assumption that single-node is enough.
3. **When a compensation edge fires** — on task failure, on run failure, or on rewind.
4. **Rate-limit backpressure and admission control** — see A. The first half is a live bug.
5. **The identity and permission source of truth** for approvers.

The rest: which approval callback is mandatory · providers required at launch · what a join timeout
does · whether a function body's output becomes a journaled effect · the `preAuthorization`
envelope · token and wall-clock budgets · the subgraph span · a CPU worker pool · retention
tiering · quorum and delegation · `run.cancelled.forced` · the operator surface · the mailbox · the
circuit breaker.

## E · Deferred on purpose, with the reason — do not silently revive

Kept because re-deriving these costs more than reading them, and each was a real decision.

- **Distributed deployment.** A distributed v1 by a small team yields a distributed prototype, not a
  product. The interfaces are shaped for it; nothing is built.
- **Partition assignment and cross-run fairness.** Deciding which runs a worker considers needs a
  coordinator, and half a coordinator is worse than none.
- **Automated candidate generation, canaries and auto-promotion.** Under roughly thirty scored
  trajectories per cohort, any candidate is fitted to noise.
- **Subtractive graph mutation.** Additive-only keeps the executed graph a superset of the compiled
  one, which is what makes the compiled artifact meaningful.
- **Custom user-authored reducers.** Arbitrary code inside the determinism boundary.
- **Free-form agent chatter.** Makes termination unprovable and replay quadratic.
- **seccomp / Landlock.** Platform-specific; subprocess isolation plus a filesystem jail plus an
  egress allowlist covered the stated threat model.
- **Vendor callback parsing** (Slack, Teams, email). Delivery outward is built; the return trip
  needs per-vendor signature verification.

## F · Hard-won facts worth carrying forward

The archive is being deleted. These are the parts that cost real debugging time and would cost it
again. **They are stated as properties to preserve, not as history to honour.**

1. **Every durable fact must be rebuildable by folding the log.** Five separate in-memory fields
   held state a decision read, with no fold behind them; each one silently switched a guard off
   across a restart. The unit that needs a restore path is the *producer*, not the field.
2. **A vocabulary with two representations will drift**, and every gate walking the wrong one is
   silently switched off. Prefer a form the type checker can walk; where a test must do it, gate
   all representations as one set and read them from the source.
3. **A guard's permissive branch is where the surprise lives.** Refusals attract tests; the arm that
   lets something through does not.
4. **Mutation-test every guard.** Several tests in this codebase could not fail. A sweep only kills
   what it mutates, and a test whose expected value could also come from a fallback path is a
   tautology waiting to be discovered.
5. **Driving beats sweeping.** Every wave that found real defects found them by running a new shape
   of thing. Sweeps derived from the last finding mostly found nothing, because in a disciplined
   codebase most findings are exceptions rather than instances of a class.
6. **A test built from the same mental model as the fix certifies the model, not the mechanism.**
7. **Reproduce by running, not by reading** — including when correcting a document. A correction
   that replaces a false claim with a differently-false one is worse than the original, because it
   asserts verified accuracy and is believed harder.
8. **Name the set a claim covers.** "This boundary is total" cannot be checked; a claim that names
   its members can. A count nobody can enumerate is a count nobody checked.
9. **A self-describing claim has no fixed point.** State the invariant, not the measurement, when
   the claim is about the artifact containing it.
10. **`node:vm` is not a sandbox** — it is scoping. Untrusted code needs a process boundary.
11. **Absence is not zero, and an empty allow-list is the permissive case.** "Named nobody" and
    "could not read who it names" must never produce the same value.
12. **Approve means "go ahead", not "consider it done"** — on every node type except the gate
    itself, there is work behind the gate.
13. **A terminal operation is not final until every producer of the state it ends is stopped.**
14. **Cross-realm values look identical and are not**; assert on the prototype, and know that
    `Array.isArray` is realm-agnostic and throws on a revoked proxy.
15. **macOS `grep` silently skips files containing non-ASCII bytes.** Always `grep -a`; empty
    output from a plain grep is not evidence of absence.

## G · From the 2026 field survey — new work the redesign creates

Each traces to a decision in `DESIGN.md`.

- ~~**Declared effects (D2).**~~ **DONE for `function` nodes.** `FunctionNode.effects` names the
  tools a body may invoke; `reachableToolNames` sees them, so the capability ceiling, the
  unknown-tool diagnostic and the oversight floor all apply by the route a tool node's name
  already travelled — an irreversible declared effect gates the node with nobody configuring
  oversight. The body gets one bound invoker per name through `ctx.effects`, each routed through
  the single dispatch path and keyed by position in the call sequence.
  **Still open:** the same for `evaluator` bodies, and the sandbox. A resource-loaded body runs
  synchronously inside `vm.runInContext` and cannot await, so `ctx.effects` is honestly absent
  there rather than broken — giving a sandboxed body effects means an async bridge, which is its
  own design.
- ~~**Clock bound to the journal (D3).**~~ **DONE for `ctx.now`** — a body's clock is the task's
  journaled `task.leased` timestamp, so it reproduces on replay with nothing new written. Two
  reads in one body return the same instant, which is the property that makes replay total.
  **Still open: `Date` in the realm.** It stays absent, and the reason changed — not "no seed
  could make it reproducible" but "a frozen `Date` that silently never advances is more
  surprising than an absent one". Restoring it means binding the whole constructor to `ctx.now`.
  Bind `Temporal` in the same change when it becomes a default global.
- **The one-line agent surface (D1).** `agent({model, tools, prompt})` compiling to a one-node
  graph, so the journal, replay, gates and budgets apply to the hello-world.
- **Divergence must be terminal and loud.** The known failure mode of every replay-based runtime
  is a silent stall: the task retries forever without entering a failed state. A repeated
  divergence signature with no forward progress needs its own terminal state.
- **Two-axis labels (D4).** Integrity × confidentiality, most-restrictive, **unlabelled ⇒
  untrusted** — the last is the valuable half and the one this codebase does not have: a tool that
  is not `isExternal` writing data from anywhere is untainted today. Branch-coordinate scoping was
  built and reverted: sibling arms of a fan-out run the same node sequence so they taint
  identically, and the one divergent shape is refused by `GRAPH010_CONCURRENT_WRITE`. See
  `DESIGN.md` D4 for what would reopen it.
- **Prompt text into the artifact hash (D7).** A prompt edit currently changes what a resumed run
  does, silently.
- **Payload externalisation.** Above a byte threshold a payload moves out of the journal and
  leaves a reference. This is what actually bounds the store; retention tiering is downstream of
  it.
- **Proposed-API mechanism and a version pin (D5).**
- **One retry budget per run**, decremented across every layer. Engine retry × provider retry ×
  agent-loop retry currently multiply.

## H · Housekeeping carried into the sweep

- `packages/eagent/tui` — **deleted** as part of this sweep. Its removal breaks two tests that
  assert the directory exists, and touches the package guide, the README, the architecture doc, a
  release script and a display-surface test. It is a transaction, not a delete.
- The web frontend was already designed once and closed, and the terminal client already dropped
  once, in July 2026. That history is being retired with the rest — noted only so the sweep does
  not treat the leftovers as live work.
- `bin/loom` is gitignored and goes stale on any source edit; nothing rebuilds it automatically.
- Commits land under the human author's identity only. No assistant attribution, no co-author
  trailers, no assistant links in commit bodies or pull requests.
