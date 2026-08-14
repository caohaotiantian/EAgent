# 99 — Definition of Done

Each checklist item from the brief, the section that discharges it, **and whether the
code now proves it**. Updated after M0–M6; see `JOURNAL.md` for the milestone log.

Legend: **PROVEN** — a test asserts it. **DESIGNED** — specified, not yet built.
**PARTIAL** — built with a stated limit.

## The eleven checklist items

| # | Requirement | Design | Code | Evidence |
|---|---|---|---|---|
| 1 | Every inter-layer edge in D2 maps to a named interface in D3 | PASS | **PARTIAL** | What a test asserts: the node taxonomy is exactly eight, pinned in both directions by `test/docs-drift.test.ts`, and all eight execute — `subgraph` was the last one the compiler accepted and the executor refused (`test/run/subgraph.test.ts`). What no test asserts is the mapping itself: "16 edges → 24 interfaces" was a count appearing in exactly one place in the corpus — this cell — with nothing deriving either number from D2 or D3, so it is deleted rather than restated. Every named interface has an implementation except the distributed swaps (G3) and `ToolExecutor`, whose single dispatch path is real and whose *seam* is not (D3.6) |
| 2 | Every interface defines its error taxonomy and cancellation behaviour | PASS | **PROVEN** | One `LoomError` taxonomy, class-driven retry and HTTP mapping, all tested. The 8 boundary interfaces now enumerate their own codes and cancellation behaviour (D3.17–D3.24) — G1 closed |
| 3 | One `GraphSpec` consumed by UI, executor, observability, resources, evolution — no parallel representations | PASS | **PROVEN** | `reconstruct(trace) ⊆ declared(graph.hash)` is a test, plus its negative (a tampered span claiming an undeclared edge fails it) |
| 4 | All three postures expressible by configuration alone | PASS | **PROVEN** | Skeleton row 11: the same graph runs autonomously when the gate node is removed; row 11b: a system floor of `in` gates a run that would otherwise be autonomous |
| 5 | Escalation/de-escalation as a decision table; asymmetry enforced | PASS | **PROVEN** | `run/escalation.ts` holds E1–E10 as data; all ten are wired and tested end to end, including two properties of the table itself — every rule only tightens, and every rule names itself in the journal |
| 6 | Boots as a single binary with no external dependencies | PASS (G2 closed) | **PROVEN** | The Design cell read "UNPROVEN (G2)" while the gap register below called G2 *closed, literally*, and the Code cell said PROVEN — one row saying three things. Re-established 2026-08-06 **after the last `src/` edit of the hardening programme**, which matters because the first three PROVENs each cited a binary older than the tree they claimed to verify — the third by 16 source files, found by `find packages/core/src -name '*.ts' -newer bin/loom`, which is the cheapest way to ask: `npm run build:binary` → `bin/loom`, one file, 114.8 MB, application bundle 541 KB, **0 third-party modules** (the build fails if any appear). That binary was then copied **alone** into an empty directory outside the repo, given a hand-written one-node `fs.write` graph, and run. `./loom compile ./hello.json` → `ok`, exit 0. `./loom run ./hello.json --input '{"body":"nineteen waves later"}'` → exit 0, printing a pretty-printed object carrying `runId`, `usage`, and `"status": "succeeded"` with `"outputs": {"written": {"bytes": 20, "path": "out.txt"}}` — 20 being the length of the input string. `out.txt` was on disk with those bytes, and the binary had created its own `.loom/` and `graphs/` beside itself; nothing else was present in the directory. Zero runtime deps also enforced by a parser-based CI guard. **This goes stale on the next `src/` edit** — `bin/loom` is gitignored and nothing rebuilds it, so the ordering claim above is the perishable part. To re-establish: `npm run build:binary`, then copy `bin/loom` alone into an empty directory and run the two commands |
| 7 | Local → distributed changes implementations, never call sites | PASS in design (G3) | **PARTIAL** | One conformance suite passes against both `MemoryStateStore` and `SqliteStateStore`, and another against `InProcessScheduler` and `LeasedScheduler` — the executor takes a `Scheduler`, so the swap is a constructor argument. Partition assignment (which runs a worker considers at all) is still G3 and still deferred |
| 8 | Self-evolution cannot promote without an eval gate, and can roll back | PASS | **PROVEN** | **11** promotion checks as a pure function — D10.d's eight, the two suite-provenance rules, and suite well-formedness (`0-suite`). The count read 9 here and "eight" in `gate.ts`'s own docstring while the function pushed eleven; one must-pass failure blocks promotion; a candidate lowering oversight is refused; rollback is a selector move, tested |
| 9 | Terminology consistent with D1 | PASS | **PROVEN** | `Session`, `Job`, `Sub-agent` appear nowhere in `src/` **code** — asserted by `test/docs-drift.test.ts`, which reads every `.ts` under `src/` with comments stripped. The row claimed PROVEN with no test behind it until that check was written; nine occurrences remain in prose, all of them sentences saying the concept is absent |
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
thirteen local→distributed swaps are mechanical; in-process selection over an in-memory
ready queue becoming partition-leased scheduling over Postgres is not. Correctness is
testable by replay; *fairness* under partitioning needs its own load test. Note that the
DWRR-over-Runs-then-Tenants fairness D3.3 specifies **is not built**: `Scheduler.select`
receives one run's projection, so cross-run fairness is not expressible at that seam at
all, let alone unfair. That is a second thing G3 owes, not a detail of the first.

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
| L1 gate surfacing / routing / escalation | **PARTIAL** | `run/delivery.ts`: injected channels, a zero-dep `WebhookChannel` on global `fetch`, a `ConsoleChannel` fallback that cannot fail, per-channel failure journaling, and a tiered escalation chain whose clock resets per tier — `test/run/delivery.test.ts`, including four separate ways delivery failure could have leaked into an approval. The return path is `SignedWebhookChannel.parseCallback` + `GateCallbackRouter` + `POST /runs/:id/callbacks/:channel` — `node --test packages/core/test/run/callback.test.ts`, against a real gated run — plus a socket-level pair in `test/server/http.test.ts` that posts a signed callback with no bearer (200, action ran) and a forged one (403, gate open, nothing journaled). **The limit:** a compiled graph cannot declare a `DeliverySpec` and `Engine` never passes one, so nothing but an embedder calling `HumanGateBroker.raise` directly reaches delivery at all; `bin/loom` wires no channels and no callback route; and nothing calls `sweepTimeouts`, so tiers advance only for a caller that sweeps. Mechanism proven, wiring absent — see `HANDOFF.md` **B1**–**B3** |
| L2 what is durable at ACK | **PROVEN** | The 202 body names the durable set; a test asserts the journal contains it |
| L2 idempotency keys | **PROVEN** | Duplicate submit returns the original `runId` and creates nothing |
| L3 concurrency model | **PROVEN** | Work parallel, commits serialized through one chain with `expectedSeq` |
| L3 backpressure under fan-out | **PROVEN** | `maxParallelism` bounds the in-flight wave; branches materialise lazily against a journaled `fanout.planned` width, so the join waits for the PLAN, not the first wave |
| L3 cancellation into in-flight tool calls | **PROVEN** | Signal chain to `SIGTERM`→grace→`SIGKILL` on the process group; unknown-outcome effects reported honestly |
| L3 context assembly and compaction | **PROVEN** | Context is rebuilt per Task from declared reads; the five-rung ladder is built, and rung 3's summarizer is a recorded effect so compaction stays replayable |
| L3 graph mutation validated before execution | **PROVEN** | `graph/mutate.ts`; `test/graph/mutate.test.ts`, incl. a mid-flight restart rebuilding the successor graph from the journal |
| L4 addressing, promotion, immutability, rollback, cache, pinning | **PROVEN** | `test/resources/store.test.ts`, including the pinning rule end to end |
| L5 span taxonomy | **PROVEN** | Spans derived from the journal; `gen_ai.*` conventions on model spans |
| L5 sampling | **PROVEN** | Deterministic per run; always keeps gated/failed/escalated/irreversible |
| L5 retention tiering | **PROVEN** | `journal/retention.ts`: tiers by age, a WORM audit tier with its own window, and `TierManager.archive` writing both. `test/journal/retention.test.ts`, incl. replaying a run rebuilt from cold storage alone and proving a cold-retention cut leaves the approval record intact |
| L5 PII redaction at emit | **PROVEN** | Applied to span attributes and the HTTP wire — deliberately NOT to the journal, which must keep real values. Justified by leak prevention, not by any erasure mandate |
| L5 deterministic replay | **PROVEN** | Zero model calls, zero side effects, zero file reads across a full replay |
| L6 trajectory capture + scoring | **PROVEN** | `evolution/trajectory.ts` + `evolution/score.ts`, both covered by `test/evolution/trajectory.test.ts`. Re-indexing verified to reorder; S4-only proven unable to reach golden or `stable` |
| L6 authoritative vs derived | **PROVEN** | `state.reduced` is the only event that changes channel state — asserted by reconstructing state from inputs + that event type alone |
| 3.1 durable suspension across restart | **PARTIAL** | This cell read "`kill -9` with a gate open, resumed from a new process". **No such test exists.** What exists is `test/run/skeleton.test.ts` row 6: a gated run on a `SqliteStateStore`, `store.close()`, a second store and a second `Engine` over the same file, recovered as `awaiting_gate` with no recovery step, approved, `succeeded`, and the deferred write executed exactly once. That proves the run holds nothing in engine memory — which is the invariant-2 half — and `test/run/oversight-survives-restart.test.ts` proves the same for the escalation ceiling and the accumulated spend. What it does **not** prove is what the row claimed: `close()` is a *clean* close, and as the last connection in WAL mode it checkpoints and removes the `-wal`/`-shm`, so the reopen never reads a hot WAL, and both engines live in one OS process. A dropped `journal_mode = WAL`, a lost `busy_timeout`, or an engine that started caching gate state outside the journal would leave this row green. The missing test is a real spawn, `SIGKILL`, an assertion that `journal.db-wal` is still on disk, and a resume from a genuinely new process — reproduced out of tree in 254 ms, so there is no cost argument. Recorded as **HANDOFF D12** |
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
