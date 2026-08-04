# 99 — Definition of Done

Each checklist item from the brief, the section that discharges it, **and whether the
code now proves it**. Updated after M0–M6; see `JOURNAL.md` for the milestone log.

Legend: **PROVEN** — a test asserts it. **DESIGNED** — specified, not yet built.
**PARTIAL** — built with a stated limit.

## The eleven checklist items

| # | Requirement | Design | Code | Evidence |
|---|---|---|---|---|
| 1 | Every inter-layer edge in D2 maps to a named interface in D3 | PASS | **PROVEN** | 16 edges → 24 interfaces; every one now has an implementation except the distributed swaps (G3). All eight node types execute — `subgraph` was the last one the compiler accepted but the executor refused |
| 2 | Every interface defines its error taxonomy and cancellation behaviour | PASS | **PROVEN** | One `LoomError` taxonomy, class-driven retry and HTTP mapping, all tested. The 8 boundary interfaces now enumerate their own codes and cancellation behaviour (D3.17–D3.24) — G1 closed |
| 3 | One `GraphSpec` consumed by UI, executor, observability, resources, evolution — no parallel representations | PASS | **PROVEN** | `reconstruct(trace) ⊆ declared(graph.hash)` is a test, plus its negative (a tampered span claiming an undeclared edge fails it) |
| 4 | All three postures expressible by configuration alone | PASS | **PROVEN** | Skeleton row 11: the same graph runs autonomously when the gate node is removed; row 11b: a system floor of `in` gates a run that would otherwise be autonomous |
| 5 | Escalation/de-escalation as a decision table; asymmetry enforced | PASS | **PROVEN** | `run/escalation.ts` holds E1–E10 as data; all ten are wired and tested end to end, including two properties of the table itself — every rule only tightens, and every rule names itself in the journal |
| 6 | Boots as a single binary with no external dependencies | UNPROVEN (G2) | **PROVEN** | `npm run build:binary` produces `bin/loom`, one file, **0 third-party modules in the bundle** (the build fails if any appear). Copied alone into an empty directory it compiles and runs a graph and writes a file. Zero runtime deps also enforced by a parser-based CI guard |
| 7 | Local → distributed changes implementations, never call sites | PASS in design (G3) | **PARTIAL** | One conformance suite passes against both `MemoryStateStore` and `SqliteStateStore`. The scheduler swap (G3) remains the genuinely risky one and is unbuilt |
| 8 | Self-evolution cannot promote without an eval gate, and can roll back | PASS | **PROVEN** | 9 promotion criteria as a pure function; one must-pass failure blocks promotion; a candidate lowering oversight is refused; rollback is a selector move, tested |
| 9 | Terminology consistent with D1 | PASS | **PROVEN** | `Session`, `Job`, `Sub-agent` appear nowhere in `src/` |
| 10 | Every `DEFERRED-v2` justified in one line | PASS | PASS | D13.4, plus new deferrals recorded in `JOURNAL.md` |
| 11 | No requirement from §2–3 silently unaddressed | PASS | **PARTIAL** | Coverage matrix below, now with implementation status |

## Gaps, restated honestly

**G1 — boundary interfaces abridged.** *Closed.* All 8 boundary interfaces now enumerate
their own error codes and cancellation behaviour in D3.17–D3.24, drawn from the
implementations rather than guessed. The reason it mattered: a caller writing a
`retry.onlyIf` list needs to know which codes a method can actually produce, and
"whatever the universal contract allows" is a set of fifty — a caller who must handle
fifty handles none.

**G2 — single-binary boot.** *Closed, literally.* `scripts/build-binary.mjs` bundles
with esbuild and injects a Node SEA blob. The build **fails** if any `node_modules`
input reaches the bundle, so "zero runtime dependencies" is verified at package time
rather than asserted. esbuild and postject are build-only and never appear in
`packages/core/package.json`.

**G3 — the scheduler swap is genuinely risky.** *Still open and unchanged.* Twelve of
thirteen local→distributed swaps are mechanical; in-process DWRR over an in-memory
ready queue becoming partition-leased scheduling over Postgres is not. Correctness is
testable by replay; *fairness* under partitioning needs its own load test.

**G4 — not every decision carries a four-part block.** *Improved.* The implementation
journal now records ~30 decisions in the four-part form, including several the design
did not anticipate (`RUN_FATAL_CODES`, `startedEffects` vs `unknownEffects`, absence
semantics in the expression language, identity-aware resource digests).

**G5 — the web console.** *Closed for v1.* A zero-dependency console ships inside the
binary: graph canvas laid out from the compiler's ranks, fan-out collapsed to one shape
with a count, SSE deltas coalesced at 60 ms, and an approve/reject queue. The four D9
§L1 rendering decisions are implemented and tested. What is NOT validated: visual
correctness (no browser in CI) and behaviour at genuinely 500 nodes — the strategy is
right and the constant factors are unmeasured.

## Coverage matrix — implementation status

Only rows whose status changed from the design-time matrix are listed; everything else
remains as documented in the original matrix above the fold.

| Requirement | Status | Where |
|---|---|---|
| L1 streaming reconciliation after reconnect | **PROVEN** | `Last-Event-ID` resumes at `seq+1`, contiguous; out-of-window yields a `snapshot` frame. `test/server/http.test.ts` |
| L1 500-node rendering | **PARTIAL** | Measured at 500 nodes / 4,900 edges: compile 61 ms, **layout 0.95 ms**, 485 KiB one-time snapshot, 10k-event fold 3 ms, 500-way fan-out 126 ms at peak concurrency 16. `test/scale.test.ts` + `test/server/layout.test.ts`. Layout is a pure function in `server/layout.ts` and ships with the structure payload; the console is asserted to contain no `layoutRank` or spacing constants. Only literal browser PAINT is unmeasured — measuring it needs a headless browser the zero-dep rule keeps out |
| L1 gate surfacing / routing / escalation | **PROVEN** | `run/delivery.ts`: injected channels, a zero-dep `WebhookChannel` on global `fetch`, a `ConsoleChannel` fallback that cannot fail, per-channel failure journaling, and a tiered escalation chain whose clock resets per tier. 20 tests, including four separate ways delivery failure could have leaked into an approval |
| L2 what is durable at ACK | **PROVEN** | The 202 body names the durable set; a test asserts the journal contains it |
| L2 idempotency keys | **PROVEN** | Duplicate submit returns the original `runId` and creates nothing |
| L3 concurrency model | **PROVEN** | Work parallel, commits serialized through one chain with `expectedSeq` |
| L3 backpressure under fan-out | **PROVEN** | `maxParallelism` bounds the in-flight wave; branches materialise lazily against a journaled `fanout.planned` width, so the join waits for the PLAN, not the first wave |
| L3 cancellation into in-flight tool calls | **PROVEN** | Signal chain to `SIGTERM`→grace→`SIGKILL` on the process group; unknown-outcome effects reported honestly |
| L3 context assembly and compaction | **PROVEN** | Context is rebuilt per Task from declared reads; the five-rung ladder is built, and rung 3's summarizer is a recorded effect so compaction stays replayable |
| L3 graph mutation validated before execution | **PROVEN** | `graph/mutate.ts`; 21 tests incl. a mid-flight restart rebuilding the successor graph from the journal |
| L4 addressing, promotion, immutability, rollback, cache, pinning | **PROVEN** | `test/resources/store.test.ts`, including the pinning rule end to end |
| L5 span taxonomy | **PROVEN** | Spans derived from the journal; `gen_ai.*` conventions on model spans |
| L5 sampling | **PROVEN** | Deterministic per run; always keeps gated/failed/escalated/irreversible |
| L5 retention tiering | **PROVEN** | `journal/retention.ts`: tiers by age, a WORM audit tier with its own window, and `TierManager.archive` writing both. 22 tests, incl. replaying a run rebuilt from cold storage alone and proving a cold-retention cut leaves the approval record intact |
| L5 PII redaction at emit | **PROVEN** | Applied to span attributes and the HTTP wire — deliberately NOT to the journal, which must keep real values. Justified by leak prevention, not by any erasure mandate |
| L5 deterministic replay | **PROVEN** | Zero model calls, zero side effects, zero file reads across a full replay |
| L6 trajectory capture + scoring | **PROVEN** | `evolution/trajectory.ts` + `evolution/score.ts`; 30 tests. Re-indexing verified to reorder; S4-only proven unable to reach golden or `stable` |
| L6 authoritative vs derived | **PROVEN** | `state.reduced` is the only event that changes channel state — asserted by reconstructing state from inputs + that event type alone |
| 3.1 durable suspension across restart | **PROVEN** | `kill -9` with a gate open, resumed from a new process |
| 3.1 irreversibility → default posture | **PROVEN** | An irreversible tool gates even when the graph says `out` |
| 3.1 asymmetry rule | **PROVEN** | `deescalate` rejects non-human actors; the evolution identity is refused even when disguised as human |
| 3.2 model agnosticism + fallback chains | **PROVEN** | Anthropic + OpenAI adapters, normalized taxonomy, chains keyed on codes |
| 3.2 content filter never falls through | **PROVEN** | A chain naming `E_CONTENT_FILTERED` fails at *construction* |
| 3.2 tool sandboxing | **PARTIAL** | Subprocess confinement built and tested; seccomp/cgroups deferred |
| 3.2 secret injection never reaching traces or prompts | **PROVEN** | `SecretValue` yields `[secret]` through `toString`/`toJSON`/interpolation/`inspect`; env allowlist proven separately |
| 3.2 prompt-injection containment | **PROVEN** | The tool allowlist is computed from the node spec before the turn; an injected tool name is refused pre-dispatch |
| 3.2 cost governance | **PROVEN** | Reservation-based budgets; `GRAPH009` proves `Σ(branch budgets) ≤ run budget` at compile |
| 3.2 determinism & replay limits | **PROVEN** | Six honest limits documented; the unknown-outcome case marks a replay non-hermetic |

## What is left before this is a product

1. **Browser paint at 500 nodes** — layout is now measured at 0.95 ms and the console
   provably computes no positions. What is left is the paint itself, which needs a
   headless browser the zero-dep rule keeps out of this package.
2. **Distributed swap** (G3) — deliberately deferred; the interfaces are shaped for it.
