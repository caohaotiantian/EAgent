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
- **The whole evolution subsystem** — trajectory folding, cohort measurement, promotion ceilings,
  baselines. Capture and scoring exist; nothing calls them.
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

## G · Housekeeping carried into the sweep

- `packages/eagent/tui` — **deleted** as part of this sweep. Its removal breaks two tests that
  assert the directory exists, and touches the package guide, the README, the architecture doc, a
  release script and a display-surface test. It is a transaction, not a delete.
- The web frontend was already designed once and closed, and the terminal client already dropped
  once, in July 2026. That history is being retired with the rest — noted only so the sweep does
  not treat the leftovers as live work.
- `bin/loom` is gitignored and goes stale on any source edit; nothing rebuilds it automatically.
- Commits land under the human author's identity only. No assistant attribution, no co-author
  trailers, no assistant links in commit bodies or pull requests.
