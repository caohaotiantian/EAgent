# 99 — Definition of Done

Each checklist item from the brief, the section that discharges it, **and whether the
code now proves it**. Updated after M0–M6; see `JOURNAL.md` for the milestone log.

Legend: **PROVEN** — a test asserts it. **DESIGNED** — specified, not yet built.
**PARTIAL** — built with a stated limit.

## The eleven checklist items

| # | Requirement | Design | Code | Evidence |
|---|---|---|---|---|
| 1 | Every inter-layer edge in D2 maps to a named interface in D3 | PASS | **PROVEN** | 16 edges → 24 interfaces; every one now has an implementation except `GateDelivery` (deferred) and the distributed swaps |
| 2 | Every interface defines its error taxonomy and cancellation behaviour | PARTIAL (G1) | **PARTIAL** | One `LoomError` taxonomy, 50 codes, class-driven retry and HTTP mapping, all tested. The 8 boundary interfaces still inherit rather than restate — G1 stands |
| 3 | One `GraphSpec` consumed by UI, executor, observability, resources, evolution — no parallel representations | PASS | **PROVEN** | `reconstruct(trace) ⊆ declared(graph.hash)` is a test, plus its negative (a tampered span claiming an undeclared edge fails it) |
| 4 | All three postures expressible by configuration alone | PASS | **PROVEN** | Skeleton row 11: the same graph runs autonomously when the gate node is removed; row 11b: a system floor of `in` gates a run that would otherwise be autonomous |
| 5 | Escalation/de-escalation as a decision table; asymmetry enforced | PASS | **PARTIAL** | `maxPosture`/`isLoosening` + `deescalate` requiring a `HumanActor` + the evolution deny-list are all tested. The E1–E11 *automatic* triggers are implemented for budget and taint only |
| 6 | Boots as a single binary with no external dependencies | UNPROVEN (G2) | **PROVEN** | `loom run` against **compiled** `dist/cli.js` from an empty directory: creates the journal, runs a real graph, writes a real file. Zero runtime deps enforced by a parser-based CI guard. *SEA packaging itself is build tooling, not yet wired* |
| 7 | Local → distributed changes implementations, never call sites | PASS in design (G3) | **PARTIAL** | One conformance suite passes against both `MemoryStateStore` and `SqliteStateStore`. The scheduler swap (G3) remains the genuinely risky one and is unbuilt |
| 8 | Self-evolution cannot promote without an eval gate, and can roll back | PASS | **PROVEN** | 9 promotion criteria as a pure function; one must-pass failure blocks promotion; a candidate lowering oversight is refused; rollback is a selector move, tested |
| 9 | Terminology consistent with D1 | PASS | **PROVEN** | `Session`, `Job`, `Sub-agent` appear nowhere in `src/` |
| 10 | Every `DEFERRED-v2` justified in one line | PASS | PASS | D13.4, plus new deferrals recorded in `JOURNAL.md` |
| 11 | No requirement from §2–3 silently unaddressed | PASS | **PARTIAL** | Coverage matrix below, now with implementation status |

## Gaps, restated honestly

**G1 — boundary interfaces abridged.** *Still open.* The 16 required interfaces carry
full property tables; the 8 additional boundary interfaces inherit their semantics from
the universal contract. `ControlPlaneAPI` and `RunEventStream` are now implemented and
tested, so their real error codes could be enumerated — that is the next cheap win.

**G2 — single-binary boot.** *Closed.* Demonstrated against the compiled CLI. What
remains is packaging: `node --experimental-sea-config` to produce one file. That is a
build step, not an architectural question.

**G3 — the scheduler swap is genuinely risky.** *Still open and unchanged.* Twelve of
thirteen local→distributed swaps are mechanical; in-process DWRR over an in-memory
ready queue becoming partition-leased scheduling over Postgres is not. Correctness is
testable by replay; *fairness* under partitioning needs its own load test.

**G4 — not every decision carries a four-part block.** *Improved.* The implementation
journal now records ~30 decisions in the four-part form, including several the design
did not anticipate (`RUN_FATAL_CODES`, `startedEffects` vs `unknownEffects`, absence
semantics in the expression language, identity-aware resource digests).

**G5 — NEW: the web console does not exist.** L1 is specified (D9 §L1) and the control
plane it would consume is built and tested, but no UI code exists. The 500-node
rendering strategy and the oversight queue are unvalidated.

## Coverage matrix — implementation status

Only rows whose status changed from the design-time matrix are listed; everything else
remains as documented in the original matrix above the fold.

| Requirement | Status | Where |
|---|---|---|
| L1 streaming reconciliation after reconnect | **PROVEN** | `Last-Event-ID` resumes at `seq+1`, contiguous; out-of-window yields a `snapshot` frame. `test/server/http.test.ts` |
| L1 500-node rendering | **DESIGNED** | Layout ranks are computed at compile and shipped in the `RunGraph`; no renderer exists (G5) |
| L1 gate surfacing / routing / escalation | **PARTIAL** | Gates are listed and resolved over HTTP and CLI. Delivery channels and SLA sweep are implemented in the broker but untested against a real channel |
| L2 what is durable at ACK | **PROVEN** | The 202 body names the durable set; a test asserts the journal contains it |
| L2 idempotency keys | **PROVEN** | Duplicate submit returns the original `runId` and creates nothing |
| L3 concurrency model | **PROVEN** | Work parallel, commits serialized through one chain with `expectedSeq` |
| L3 backpressure under fan-out | **PARTIAL** | `maxParallelism` bounds the in-flight wave (tested). Lazy materialisation and token buckets are unbuilt (T5) |
| L3 cancellation into in-flight tool calls | **PROVEN** | Signal chain to `SIGTERM`→grace→`SIGKILL` on the process group; unknown-outcome effects reported honestly |
| L3 context assembly and compaction | **PARTIAL** | Context is rebuilt per Task from declared reads. The compaction ladder is unbuilt |
| L3 graph mutation validated before execution | **DESIGNED** | `compileMutation` is specified; unbuilt |
| L4 addressing, promotion, immutability, rollback, cache, pinning | **PROVEN** | `test/resources/store.test.ts`, including the pinning rule end to end |
| L5 span taxonomy | **PROVEN** | Spans derived from the journal; `gen_ai.*` conventions on model spans |
| L5 sampling | **PROVEN** | Deterministic per run; always keeps gated/failed/escalated/irreversible |
| L5 retention tiering | **DESIGNED** | Unbuilt |
| L5 PII redaction at emit | **PARTIAL** | Classification is carried on every event; the redactor itself is unbuilt |
| L5 deterministic replay | **PROVEN** | Zero model calls, zero side effects, zero file reads across a full replay |
| L6 authoritative vs derived | **PROVEN** | `state.reduced` is the only event that changes channel state — asserted by reconstructing state from inputs + that event type alone |
| 3.1 durable suspension across restart | **PROVEN** | `kill -9` with a gate open, resumed from a new process |
| 3.1 irreversibility → default posture | **PROVEN** | An irreversible tool gates even when the graph says `out` |
| 3.1 asymmetry rule | **PROVEN** | `deescalate` rejects non-human actors; the evolution identity is refused even when disguised as human |
| 3.2 model agnosticism + fallback chains | **PROVEN** | Anthropic + OpenAI adapters, normalized taxonomy, chains keyed on codes |
| 3.2 content filter never falls through | **PROVEN** | A chain naming `E_CONTENT_FILTERED` fails at *construction* |
| 3.2 tool sandboxing | **PARTIAL** | Subprocess confinement built and tested; seccomp/cgroups deferred |
| 3.2 secret injection never reaching traces or prompts | **PARTIAL** | Env allowlist proven (a child reads `undefined` for an engine secret); a `SecretValue` wrapper is unbuilt |
| 3.2 prompt-injection containment | **PROVEN** | The tool allowlist is computed from the node spec before the turn; an injected tool name is refused pre-dispatch |
| 3.2 cost governance | **PROVEN** | Reservation-based budgets; `GRAPH009` proves `Σ(branch budgets) ≤ run budget` at compile |
| 3.2 determinism & replay limits | **PROVEN** | Six honest limits documented; the unknown-outcome case marks a replay non-hermetic |

## What is left before this is a product

1. **The web console** (G5) — the largest single gap.
2. **SEA packaging** — one build step to turn the CLI into a literal single file.
3. **Redaction and `SecretValue`** — designed, and the classification metadata that
   drives them is already carried on every event.
4. **The compaction ladder** and **lazy fan-out materialisation** (T5).
5. **Dynamic graph mutation** — specified in D5.7, unbuilt.
6. **Distributed swap** (G3) — deliberately deferred; the interfaces are shaped for it.
