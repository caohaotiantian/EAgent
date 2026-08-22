# Loom — architecture

> **Status:** design + implementation in progress. M0–M6 are built and green
> (`npm run check`); see [`JOURNAL.md`](JOURNAL.md) for the milestone log and the
> decisions taken while building, and [`99-DOD.md`](99-DOD.md) for what the code now
> *proves* versus what remains designed.
> **Target:** a working single-node deployment in **6–8 weeks** by a small team, with
> the distributed path open but unbuilt.
> **Predecessor:** EAgent — now `packages/eagent/` in this repo and developed here, no longer
> a dependency of `@loom/core` and never imported by it. The frozen pre-monorepo tree is tag
> `eagent-v1` on branch `init`.

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
| [`JOURNAL.md`](JOURNAL.md) | Implementation log | Append-only. Milestone status board, decisions taken while building, and the bugs that changed the design |
| [`99-DOD.md`](99-DOD.md) | Definition of Done | Every checklist item, the section that discharges it, and whether the **code proves it** |
| [`HANDOFF.md`](HANDOFF.md) | **Re-entry point** | Where things stand, what is left, how to work here, and the traps. Read this first |
| [`REGISTER.md`](REGISTER.md) | Defect archive | Entries `A1`…`E8` with their reproductions. Grep it |

## Conventions

- `HANDOFF.md` — **start here.** Where things stand, what is left, and what will bite you.
  Its *What is left* section is the working queue, and every entry there was verified against
  `src/` rather than recalled.
- `REGISTER.md` — the defect archive behind it, entries `A1`…`E8`, each with the command or
  reproduction that established it. **Grep it, do not read it.** Many entries are RESOLVED and
  kept deliberately, so a reader can tell "this was fixed" from "this was never true".
- `ASSUMPTION:` — an underspecified point resolved by fiat. All collected in **D14**.
- `DEFERRED-v2` — explicitly outside the 6–8 week v1, each with a one-line
  justification. All collected in **D13**.
- `DESIGNED-NOT-BUILT(loom.scheduler.tick)` and `NOT-IN-CODE(E_SUBSCRIBER_OVERFLOW)` —
  **an identifier this document names that does not exist in `src/`.** Enforced by
  `packages/core/test/docs-drift.test.ts`, which reads both the markdown and the code and
  fails when they disagree; a marker is the only way to name an absent identifier without
  the suite going red. Which of the two words applies is a real distinction, and the test's
  registry pins it per symbol so the softer one cannot become the cheaper one:
  **DESIGNED-NOT-BUILT** is a debt — the design describes it and somebody is expected to
  build it. **NOT-IN-CODE** is a statement of absence — the document names the identifier
  only to say it is not there, because the contract says so or because it was removed, and
  there is nothing to build. Five rules make either an admission rather than a mute button:
  1. it names **one identifier** — `loom.*` for a span or a telemetry attribute, `E_*` for
     an error code. Concepts that are not identifiers (a state in an FSM, a scheduling
     policy, a method) get prose;
  2. it is **file-scoped** — marking a span in D9 does not license an unqualified claim
     about it in D12, because a reader of D12 has to be told there too;
  3. the **test's registry must carry it, must list this file, and must agree on the
     spelling** — each registry row pins the exact set of documents allowed to carry that
     marker. So *marking* is two edits in two files, even for an identifier that is already
     registered;
  4. a **stale marker fails** — mark something that exists and the suite goes red, so the
     caveat cannot outlive the gap and the day the span is emitted you are told to delete
     the paragraph hedging it. **"Absent from `src/`" is decided per family, by the test
     rather than by your reading of the code**, and the two families are decided
     differently. `src/` is `packages/core/src/`, walked recursively, `.ts` files only. A
     `loom.*` symbol counts as PRESENT when `telemetry/spans.ts` produces it as a span name
     or an attribute, **or** when the string literal appears anywhere else under `src/` —
     with TypeScript comments stripped first, so a name that lives only in a comment is
     still absent. That second half exists because the same literal once moved one
     directory out of `spans.ts` and went invisible to the guard while five documents
     hedged it. An `E_*` symbol counts as present when it is a key of the `CODES` table:
     DECLARED, not raised. A code in the table that nothing ever throws is "built" as far
     as this rule can tell, and may not be marked;
  5. **an HTML comment does not count** — wrap a marker in `<!--` … `-->` and the guard
     finds it and *rejects* it. Rule 2 exists so the reader of *this* file is told, and a
     caveat that renders as nothing tells nobody.

  Rule 3 is the cost of the *supported* escape, and not a claim that nothing else can
  silence the guard. It was written here as if it were, which is the more dangerous kind of
  error: a zero-width character inside an identifier used to hide a claim for one keystroke
  with an identical rendered diff and no edit to the test at all. That one is closed (the
  scanner strips format characters, inline HTML comments and emphasis, and closes up line
  breaks). A **homoglyph** — Cyrillic `о` in `lооm.scheduler.tick` — is not, and cannot be
  without a confusable table this package will not carry. Treat the guard as a tripwire for
  drift, not as a proof.

  `grep -rnE 'DESIGNED-NOT-BUILT|NOT-IN-CODE' design/loom/` is the inventory of what this
  corpus names and the code does not have.
- **Cite symbols, not line numbers**, for anything in a file under active edit.
  `HumanGateBroker.raise`'s dispatcher branch survives a refactor; `gates.ts:191` was
  wrong within a week and pointed a reader at an unrelated payload literal. Line numbers
  are for a permalink, never for a design document.
- **Decision blocks** carry four things: the choice, the rationale, the rejected
  alternative, and the observable condition that reverses the decision.
- **Splitting built from unbuilt inside one artifact:** leave the built rows in the table
  or the diagram, and move the unbuilt ones *below* it under a heading that says
  **"Designed, not implemented — do not merge these back into the table above."** D7.7's
  E11 row and D7.3's gate lifecycle both use this. A caveat merged back into the main
  artifact reads as an enforced rule within one edit.
- Types are **TypeScript**. Wire formats are **JSON Schema** or **YAML**. Diagrams are
  **Mermaid**. Prose exists only to explain *why*, never to restate a diagram.
