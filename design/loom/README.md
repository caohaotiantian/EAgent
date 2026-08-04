# Loom — architecture

> **Status:** design, pre-implementation.
> **Target:** a working single-node deployment in **6–8 weeks** by a small team, with
> the distributed path open but unbuilt.
> **Predecessor:** EAgent, frozen at tag `eagent-v1` on branch `init`. Reference, not
> dependency. `git worktree add ../eagent-ref init`.

## The one-sentence thesis

**The executable graph is the runtime; an agent loop is one node type inside it; and
every durable fact about a run is an append-only journal entry — so parallelism, human
gates, replay, and observability are all the same mechanism seen from different
angles.**

## Deliverable index

Read in order. Each file carries the `D<n>` headings from the brief verbatim.

| File | Deliverables | What it settles |
|---|---|---|
| [`00-OVERVIEW.md`](00-OVERVIEW.md) | Philosophy · Decision log · **D1** · **D2** | Why this shape; what EAgent taught us line by line; the canonical nouns; the six layers with a named interface on every edge |
| [`01-INTERFACES.md`](01-INTERFACES.md) | **D3** | All 16 interface contracts in TypeScript — signatures, error taxonomy, cancellation, idempotency, streaming, versioning |
| [`02-EXECUTION-GRAPH.md`](02-EXECUTION-GRAPH.md) | **D5** · **D4** | Node/edge taxonomy, typed state channels and reducers, the `GraphSpec` schema, a worked non-trivial example, compile-time validation, dynamic mutation, checkpoints — then the end-to-end walkthrough and five deviations |
| [`03-RUNTIME.md`](03-RUNTIME.md) | **D6** | Run/Task/Step lifecycle, fair scheduling, admission control, backpressure, cancellation propagation, context assembly and compaction, tool sandbox, hook points |
| [`04-OVERSIGHT.md`](04-OVERSIGHT.md) | **D7** | Three postures as one mechanism; gate FSM; durable suspension; intervention commands; irreversibility classification; escalation decision table; the asymmetry rule's two enforcement points; queue-saturation mitigations |
| [`05-RESOURCES-OBSERVABILITY.md`](05-RESOURCES-OBSERVABILITY.md) | **D8** · **D9** | Resource addressing and promotion, the pinning rule, MCP health; OTel span taxonomy, sampling, retention, replay, redaction |
| [`06-EVOLUTION.md`](06-EVOLUTION.md) | **D10** | Trajectory capture, the scoring function, synthesis, the offline gate, canary and auto-rollback, failure modes, and what this loop will not fix |
| [`07-CONFIG-DEPLOY.md`](07-CONFIG-DEPLOY.md) | **D11** · **D12** | Four-level configuration with security-asymmetric merge; single binary → K8s mesh with an implementation-swap table |
| [`08-PLAN.md`](08-PLAN.md) | **D13** · **D14** | Risk register, the walking skeleton, ordered milestones to v1, the assumption register, the open questions |
| [`99-DOD.md`](99-DOD.md) | Definition of Done | Every checklist item from the brief, the section that discharges it, and an honest pass/fail |

## Conventions

- `ASSUMPTION:` — an underspecified point resolved by fiat. All collected in **D14**.
- `DEFERRED-v2` — explicitly outside the 6–8 week v1, each with a one-line
  justification. All collected in **D13**.
- **Decision blocks** carry four things: the choice, the rationale, the rejected
  alternative, and the observable condition that reverses the decision.
- Types are **TypeScript**. Wire formats are **JSON Schema** or **YAML**. Diagrams are
  **Mermaid**. Prose exists only to explain *why*, never to restate a diagram.
