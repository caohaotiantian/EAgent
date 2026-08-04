# 99 — Definition of Done

Each checklist item from the brief, the section that discharges it, and an honest verdict.
**Three items are marked PARTIAL and one is UNPROVEN — those are stated first-class, not
buried.**

## The eleven checklist items

| # | Requirement | Discharged by | Verdict |
|---|---|---|---|
| 1 | Every inter-layer edge in D2 maps to a named interface in D3 | D2 edge table ①–⑯ → D3 interface→layer→deliverable map | **PASS** — all 16 edges map to one of 24 named interfaces |
| 2 | Every interface in D3 defines its error taxonomy and cancellation behaviour | D3.0 universal method contract + per-interface tables (D3.1–D3.16) | **PARTIAL** — see gap G1 |
| 3 | The same `GraphSpec` artifact is consumed by UI, executor, observability, resource layer, and evolution loop; no parallel representations | DL-4; D5 opening diagram; D9.2 reconstruction test | **PASS** — and *mechanically enforced*: a CI assertion requires `reconstruct(trace) ⊆ declared(graph.hash)` |
| 4 | All three oversight postures expressible on the same workflow by configuration alone, no code change | D7.1 (one decision, three branches), D7.10 (the same graph rendered three ways), skeleton acceptance row 11 | **PASS** |
| 5 | Runtime escalation and de-escalation specified as a decision table; the asymmetry rule enforced in the design | D7.7 (E1–E11 escalation table, D1–D4 de-escalation table, two independent enforcement points) | **PASS** |
| 6 | The system boots as a single binary with no external dependencies | D12.1; skeleton acceptance row 10 | **UNPROVEN** — see gap G2 |
| 7 | Swapping local → distributed changes only implementations, never call sites | D12.2 swap table; D3 as the sole cross-layer vocabulary | **PASS in design**, with one honest caveat — see gap G3 |
| 8 | Self-evolution cannot promote a change without passing an evaluation gate, and can roll back automatically | D10.d (8 promotion criteria), D10.e (guardrails + auto-rollback), D10.g (deny-list) | **PASS** — and stronger than required: `stable` promotion additionally requires a human actor |
| 9 | Terminology is consistent with the D1 glossary throughout | D1 glossary + the "deliberately not nouns" list | **PASS** — `Session`, `Job`, and `Sub-agent` are explicitly retired and do not appear as system nouns anywhere after D1 |
| 10 | Every `DEFERRED-v2` item is justified in one line | D13.4 deferred register — 10 items, each with a justification | **PASS** |
| 11 | No requirement from Sections 2–3 silently unaddressed | Coverage matrix below | **PASS** |

## Declared gaps

**G1 — Boundary interfaces are abridged (item 2, PARTIAL).**
The 16 named interfaces the brief required each carry a full property table (errors,
idempotency, cancellation, streaming). The 8 additional boundary interfaces in D3.17–D3.24
(`ControlPlaneAPI`, `RunEventStream`, `RunLifecycle`, `GateDelivery`, `ToolTransport`,
`JournalReader`, `BlobStore`, `SecretProvider`) carry signatures and inline contract notes
but inherit their error and cancellation semantics from the D3.0 universal contract rather
than restating them. *Why this is acceptable:* the universal contract is normative, not
decorative — it binds every async method on every interface. *Fix:* expand the eight
during M1 when their implementations are written, since the concrete error codes are
easier to enumerate against real code than in advance.

**G2 — Single-binary boot is designed, not demonstrated (item 6, UNPROVEN).**
No code exists. The claim rests on: zero runtime dependencies in `@loom/core`, SQLite as
the only store, an in-process bus, embedded UI assets, and the fact that this exact
packaging (Node SEA, single binary) already worked in the predecessor
(`npm run build:binary` on `eagent-v1`). It becomes **PASS** at M2 acceptance row 10 and
not before. Nothing in this document should be read as a claim that it has been shown.

**G3 — One swap is genuinely risky (item 7).**
Twelve of the thirteen local→distributed swaps are mechanical. `AgentScheduler` is not:
in-process DWRR over an in-memory ready queue becomes partition-leased scheduling over
Postgres, and *fairness semantics across partitions are not identical to fairness within
one process*. The call sites do not change — `lease`/`heartbeat`/`release` are unchanged —
but the observable scheduling behaviour will differ. This is R11 in the register, and the
mitigation (replay-based dual-read verification, D12.8 step 2) validates *correctness*,
not *fairness*. Fairness under partitioning needs its own load test.

**G4 — Not every decision carries a four-part block.**
The brief requires choice + rationale + rejected alternative + reversal condition for every
non-trivial decision. Roughly 20 decisions carry full blocks (DL-1…DL-8, D13.1, and the
inline decisions in D5–D7). Others are recorded in tables with a choice and a rationale but
without an explicit reversal condition — notably: the reducer set (D5.3), the span taxonomy
(D9.1), the retention tiers (D9.4), and the milestone ordering (D13.4). These are lower
stakes and cheaply reversible, but the omission is real and is noted rather than papered
over.

## Coverage matrix — Sections 2 and 3

### Section 2 — the six layers and their "must answer" questions

| Requirement | Addressed in |
|---|---|
| **L1** multimodal input (text, image, file, audio) | D3.8 `ModelCapabilities.multimodal`; audio `DEFERRED-v2` (D13.4) |
| **L1** live DAG/topology visualisation with per-node state | D9 §L1.2; D5 canvas rendering of the same artifact |
| **L1** streaming tool-execution detail panes | D3.6 `ToolExecEvent.progress` (streamed to UI, never to the model) |
| **L1** run replay | D9.5; D3.23 `JournalReader.replay` |
| **L1** oversight console + approval queues | D7.9; D9 §L1.3 |
| **L1** project/resource/system dashboards | D8; D3.17 `listRuns`; D9.4 |
| **L1 ?** how streaming state reconciles after reconnect | **D9 §L1.1** — `Last-Event-ID` → gap-free journal replay or a snapshot frame |
| **L1 ?** how a 500-node graph renders without stalling | **D9 §L1.2** — compile-time layout, structure-once + deltas, 60 ms coalescing, collapsed fan-outs, WebGL above 150 elements |
| **L1 ?** how a pending gate is surfaced, routed, escalated | **D9 §L1.3** + D7.3 |
| **L2** unified ingress, authn/z, tenancy, rate limiting, quota | D3.17; D11.1 `tenancy`; D14 A6/A7 |
| **L2** up/down-streaming | D3.17 + D3.18 |
| **L2** webhook and IM integrations doubling as gate channels | D3.20 `GateDelivery`; `DEFERRED-v2` for specific channels |
| **L2** idempotency keys | D3.0 rule 2; D3.17 |
| **L2** run lifecycle commands | D3.15 `InterventionCommand` (8 kinds) |
| **L2 ?** what exactly is durable at ACK | **D3.17 inline** + **D4 step 4** — `run.submitted` + the compiled `RunGraph` + the resolution manifest. Explicitly *not* any execution |
| **L3** atomic modular agent factory | D3.4 |
| **L3** graph compiler (GraphSpec → validated plan) | D3.1; D5.6 |
| **L3** dynamic scheduler | D3.3; D6.2 |
| **L3** static **and** dynamically-planned graphs with an expansion budget | D5.7 |
| **L3** parallel fan-out/fan-in, controlled cycles with stop rules, typed state channels, durable checkpoints, A2A messaging, plugin hooks | D5.2, D5.3, D5.8, D6.6, D6.9 |
| **L3 ?** concurrency model | **D6.2** |
| **L3 ?** context assembly and compaction | **D6.7** |
| **L3 ?** backpressure under fan-out | **D6.3** (3 levels + lazy materialisation) |
| **L3 ?** cancellation propagation into in-flight tool calls | **D6.4** + D4 deviation 1 |
| **L3 ?** how graph mutation is validated before executing | **D5.7** — same `GRAPH001..018`, additive-only, dominated by the proposer |
| **L4** prompts, skills/plugins, graph templates & subgraphs, vector/KB, MCP, agent profiles, trajectories, sub-agents | D8.1 (12 kinds) |
| **L4 ?** addressing scheme | **D8.2** |
| **L4 ?** promotion pipeline | **D8.3** |
| **L4 ?** immutability and rollback | **D8.3** — promotion moves a selector, never mutates content |
| **L4 ?** cache invalidation | **D8.4** — content-addressed, so caches are never stale, only evictable |
| **L4 ?** pinning rule | **D8.5** |
| **L5** fine-grained collection with configurable sampling | D9.3 |
| **L5** full-trace retrospection and replay | D9.5 |
| **L5** audit trail of agent **and human** decisions | D7.8 `AuditRecord`; D9.4 audit tier |
| **L5** interactive dashboards, real-time + trend | D9.4 hot/warm tiers |
| **L5** OpenTelemetry non-negotiable | D9.1 (with `gen_ai.*` semconv) |
| **L5 ?** span taxonomy mapping nodes/edges to spans | **D9.1** — nodes are spans, edges are links |
| **L5 ?** hot/warm/cold retention tiering | **D9.4** |
| **L5 ?** PII redaction at emit time | **D9.6** |
| **L5 ?** deterministic replay | **D9.5** + the six things that cannot be replayed |
| **L6** durable state, cache, queue/bus, blob, secrets | D12.3 |
| **L6 ?** which data is authoritative vs derived, and each consistency guarantee | **D12.3** table |

### Section 3.1 — human oversight spectrum

| Requirement | Addressed in |
|---|---|
| Three postures as configurable node/edge attributes with one control surface | D7.1, D7.10 |
| In-the-loop: durable suspension across restart, gate payload, decision provenance, timeout + default action, delegation, escalation, SLA | D7.2–D7.4, D7.8 |
| On-the-loop: live topology + event stream, threshold alerting, **bounded intervention window**, pause/redirect/rollback/kill and their propagation | D3.15, D4 deviation 5 (pre-irreversible hold), D7.5 |
| Out-of-the-loop: **pre-authorization envelope**, post-hoc audit completeness, automatic demotion triggers | D7.10 `preAuthorization` block (with `auditCompleteness: full`), D7.7 E1–E11 |
| Action irreversibility classification → default posture | D7.6 |
| Runtime escalation rules (confidence, budget, repeated failure, **novel tool sequence**, policy violation, anomaly) and who may re-promote | D7.7 E1–E11 + D1–D4 |
| The asymmetry rule, incl. that evolution can never loosen | D7.7 two enforcement points; D10.g deny-list |
| Cost of oversight — preventing queue saturation | D7.9 (5 mechanisms + one explicitly rejected) |

### Section 3.2 — other cross-cutting concerns

| Requirement | Addressed in |
|---|---|
| One `ModelAdapter` over OpenAI/Anthropic/self-hosted, per node | D3.8 |
| Normalized streaming, tool calling, structured output, multimodal, token accounting, provider error/rate-limit taxonomies | D3.8 `ModelEvent`, `ModelCapabilities`, `Usage`, the 7-row normalized error table |
| Fallback and failover chains | D3.8 YAML fallback chain, keyed on normalized errors |
| Configurability: pools, timeouts, retry/backoff, breakers, concurrency caps, personas, tool allowlists, expansion budgets, postures, cost budgets — validated, with hot-reload semantics | D11.1–D11.5 |
| Security: tool sandboxing, permission scoping | D6.8 (3 layers) |
| Security: secret injection never reaching traces or prompts | D11.6 + D3.24 `SecretValue`; D9.6 |
| Security: prompt-injection containment for tool output | D6.8 (provenance tagging, **structural containment**, taint propagation) |
| Security: per-tenant isolation of resources and telemetry | D1 Tenant; D8.2 namespacing; D12.3; D6.2 per-tenant concurrency |
| Cost governance: per-run/node/tenant budgets, enforcement points, degradation on exhaustion | D6.5 (reservation model + 4-rung ladder); `GRAPH009` compile-time proof |
| Determinism & replay: what must be recorded, and what cannot be | D5.1 DL-5 effect boundary; D9.5 + its six-row "cannot be replayed" table |

### Section 4 — the hard constraint

| Requirement | Addressed in | Verdict |
|---|---|---|
| Local mode has zero dependency on Kafka, K8s, or an external database; boots from a single binary with an empty data directory | D12.1; DL-7; D12.2 swap table | Designed; **UNPROVEN until M2** (gap G2) |

## Execution-directive compliance

| Directive | Compliance |
|---|---|
| 1 · Start designing immediately, no restating the brief | The brief is never restated; the first content is the EAgent evidence table and the decision log |
| 2 · Resolve ambiguity, tag `ASSUMPTION:`, consolidate | 17 assumptions in D14.1, each with blast radius and a cheap check |
| 3 · Artifacts over prose | 24 TypeScript interfaces, 21 Mermaid diagrams, 6 YAML schemas, ~55 tables. Prose appears only to explain *why* |
| 4 · Every non-trivial decision carries four things | ~20 full decision blocks; **partial — see gap G4** |
| 5 · Optimise for an implementable v1; tag `DEFERRED-v2` | 8-week milestone plan with hard exit criteria; 10 deferred items, each justified |
| 6 · No hand-waving verbs | Where a mechanism is claimed, its inputs and failure mode follow — e.g. "fair scheduling" is a named algorithm (DWRR) with a pseudocode body and a starvation guarantee, not an adjective |
