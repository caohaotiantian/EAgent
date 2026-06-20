# Implementation: Dynamic Workflow Extension

- Slug: `2026-06-20-dynamic-workflow`
- Design doc: `docs/design/2026-06-20-dynamic-workflow.md`
- Status: closed
- Closing-commit: 459e31a
- Closed-on: 2026-06-20
- Deferred: none

## 1. Task Index

Maps each implementation Phase to the design Deliverables (§2) and Acceptance
Criteria (§7) it realizes. All paths are relative to the repo root.

| Artifact | Design ref |
| --- | --- |
| `src/extensions/dynamic-workflow.ts` (new) | Deliverables §2 bullets 1-7 |
| `test/dynamic-workflow.test.ts` (new) | Acceptance Criteria AC-1…AC-11 |
| `src/host.ts` (edit: one line in `BUILTIN_EXTENSIONS`) | Deliverable §2 "Registration", AC-12/AC-13 |
| `CLAUDE.md` (edit: one inventory line) | Deliverable §2 "Registration" |

Design Key Design Decisions referenced throughout: Decision 1 (DAG
representation), Decision 2 (step types), Decision 3 (`${id}` substitution +
auto-derived edges), Decision 4 (guard mirror, 7 stages + wrapper), Decision 5
(validation + `MAX_STEPS`), Decision 6 (parallel frontier + `executionMode`),
Decision 7 (recursion guard).

## 2. Phase Breakdown

This is a **single Phase**: the extension is one coherent, independently
committable unit (a new file + a new test file + two additive one-line edits to
existing files) that leaves `npm test` green. The design's two step types share
one scheduler, so splitting "tool steps" from "agent steps" would ship a
deliberately broken intermediate state — which the granularity rule forbids.
Within the Phase, tasks are ordered TDD-first.

### Phase 1 — The `dynamic-workflow` extension

**Entry condition**: L1 design closed (it is). Working tree clean on branch
`claude/eagent-dynamic-workflow-v9m6y4`.

**Design document references**:
- Deliverables: `docs/design/2026-06-20-dynamic-workflow.md` §2 (all bullets).
- Decisions: §4 Decisions 1-7 (the 7-stage guard mirror in Decision 4 is the
  load-bearing spec — implement it stage-for-stage).
- Acceptance Criteria: §7 AC-1…AC-13.
- Scope Boundary: §3 (do not add conditionals, persistence, retries, shared
  state, concurrency knobs, or workflow nesting).

**Data / fixture dependencies**: none new. Tests use the existing offline harness
`makeHarness` (`test/helpers.ts`) and `MockProvider` (`src/providers/mock.ts`),
exactly as `test/subagents.test.ts` does (the canonical precedent for an
agent-spawning extension test). No network, no API key, no temp files required.

**Task list (TDD order — write/extend the test file first, then implement until
each asserts green)**:

The test tasks below each name the **business invariant** they protect, not just
the call. Implement the extension only after the test for a behavior exists and
fails for the right reason.

1. **T1 — test scaffolding & `extractRefs`/`substitute` unit invariant (AC-1
   data-flow primitive).** In `test/dynamic-workflow.test.ts`, assert the
   exported pure helpers: `extractRefs("hello ${a} and ${b}")` → the set
   `{a,b}`; `extractRefs` over a nested `args` object finds refs in string
   leaves only; `substitute` replaces `${a}` with a provided output map value and
   leaves an unknown `${x}` (not a declared id) verbatim. *Invariant*: data flows
   between steps strictly through declared-id `${...}` tokens, and unrelated
   `${...}` text is never corrupted (Decision 3).
2. **T2 — validation rejects malformed specs up front, running nothing (AC-5,
   AC-6, AC-9, AC-10 first half).** Assert that a spec with (a) a cycle, (b) a
   `needs` entry pointing to an unknown id, (c) a duplicate `id`, (d) a `tool`
   step naming an unregistered tool, (e) a `tool` step naming `run_workflow`,
   (f) `> MAX_STEPS` steps, and (g) a step missing its required input each returns
   `isError: true` with a specific message **and a recording tool registered in
   the harness was never invoked**. Separately assert the Decision-3 companion: a
   `${unknownId}` token (not a declared step id) is **not** an error — it is left
   verbatim in the realized tool input. *Invariant*: an invalid model-emitted spec
   is rejected statically before any side effect, while legitimate `${...}` text
   is never corrupted (Decisions 3, 5).
3. **T3 — linear data flow and parallel fan-in (AC-1, AC-2).** Register a
   recording mock tool that captures the args it receives and returns a marker.
   Assert: for `b` referencing `${a}`, `a` runs before `b` and `b`'s captured
   input contains `a`'s output; for `c` referencing `${a}` and `${b}` (both
   dependency-free), `a` and `b` both run and `c`'s captured input contains both
   outputs. *Invariant*: dependency order and fan-in substitution are honored
   (Decisions 1, 3).
4. **T4 — tool-step guard is the faithful kernel mirror (AC-4, AC-7, AC-7b,
   AC-7c).** Using `makeHarness` and registering filters directly via
   `agent.hooks.filter("beforeToolCall", …)` / `agent.hooks.filter("afterToolCall", …)`
   (the public `HookBus`, `src/kernel/hooks.ts:69`; equivalently a tiny inline
   extension's `e.hook` as `planmode` does — either is fine):
   - capability: a tool declaring a capability is blocked under `fallback:"deny"`
     (step `error`, dependents `skipped`, **sibling in same frontier still
     completes**) and runs under a grant (AC-4);
   - `beforeToolCall` block: a registered filter that sets `block` vetoes the
     step (AC-7);
   - `beforeToolCall` rewrite + re-validate: a filter that rewrites an arg causes
     the recording tool to receive the **rewritten** value; a filter that
     rewrites to a schema-invalid value yields the "after guards" error and the
     tool is **not** executed (AC-7b, Decision 4 stage 6);
   - `afterToolCall` on every outcome: a filter that tags results tags both a
     successful step and a thrown/denied step, and the thrown step does not abort
     its sibling frontier (AC-7c, Decision 4 wrapper).
   *Invariant*: intra-workflow tool calls remain governed by exactly the kernel's
   guard sequence — no policy bypass (Decision 4).
5. **T5 — `agent` step + recursion guard (AC-3, AC-10 second half).** A mock
   responder discriminates a child by system prompt (as `test/subagents.test.ts`
   does) and returns a child answer; assert the `agent` step's output is the
   child's final text and is substitutable into a downstream step. Separately,
   assert `workflowChildRegistry(parentTools)` (exported helper) given a parent
   set containing `run_workflow` returns a registry with `.has("run_workflow")
   === false` while preserving the other tools. *Invariant*: agent steps embed
   isolated reasoning sub-tasks and cannot recurse into another workflow
   (Decisions 2, 7).
6. **T6 — fail-fast isolation across a diamond (AC-8).** Diamond `a → {b,c}`,
   `b → d`, where `b` errors: assert `a` and `c` complete, `d` is `skipped`, and
   the tool returns `isError: true` with the per-step rundown listing each
   status. *Invariant*: a failed branch skips only its transitive dependents;
   independent branches still complete (design §2 error model).
7. **T7 — `executionMode: "sequential"` is not interleaved (AC-11).** Register a
   `executionMode:"sequential"` tool instrumented to record concurrent entries
   (increment a counter on entry, await a microtask, decrement on exit, track the
   max). Two ready steps naming it → recorded max concurrency is 1. Two
   `parallel`-mode steps may overlap (control). *Invariant*: the kernel's
   sequential contract holds inside a workflow frontier (Decision 6).
8. **I1 — implement `src/extensions/dynamic-workflow.ts`** until T1-T7 pass.
   Required exports for testability (mirroring `subagents`' exported
   `childRegistryFrom`): `extractRefs`, `substitute`, `workflowChildRegistry`,
   and `MAX_STEPS`; plus the default `activate` registering the `run_workflow`
   tool (capability `workflow:run`, `executionMode:"sequential"` so the whole
   workflow is not interleaved with the parent's other tools) and the `/workflow`
   command. Build the guard helper as a single localized function with a comment
   stating it mirrors `Agent.executeGuarded` + `runOne` (`src/kernel/agent.ts:286-344`),
   implementing the 7 stages + wrapper from Decision 4. Imports only from
   `src/kernel/` (`define.js`, `extension.js` types, `agent.js`, `registry.js`,
   `types.js`, `validate.js`) — zero new npm deps, `.js` specifiers.
9. **I2 — wire into the host.** Append `["dynamic-workflow", dynamicWorkflow]` to
   `BUILTIN_EXTENSIONS` in `src/host.ts` (import the default as `dynamicWorkflow`,
   placed after `subagents` to keep the orchestration extensions together), and
   add one inventory line to the CLAUDE.md extension list naming the extension and
   its one-sentence purpose. *No existing test asserts the builtin count* (checked
   `test/host.test.ts`), so this stays green.

**Per-task acceptance commands** (runnable from repo root):

- New-file behavioral tests (T1-T7 + I1, all ACs except the regression gate):
  ```
  node --import tsx --test test/dynamic-workflow.test.ts
  ```
  Exit code 0 with every `AC-*`-named subtest passing.
- Type safety (AC-13), after I1/I2:
  ```
  npm run typecheck
  ```
  Exit code 0.
- Full-suite regression (AC-12), after I2:
  ```
  npm test
  ```
  Exit code 0 — the new file passes and **no existing test changes behavior**.

**Exit condition**: all three commands above exit 0; `src/extensions/dynamic-workflow.ts`
and `test/dynamic-workflow.test.ts` exist; `src/host.ts` and `CLAUDE.md` carry
their one-line additions; every AC-1…AC-13 has a corresponding passing assertion
or green gate.

## 3. Engineering Constraints Index

- **Project engineering norms** (CLAUDE.md "House conventions"): ESM + NodeNext,
  always `.js` import specifiers even for `.ts` sources; strict TypeScript
  (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`) — no `any` cop-outs; **zero runtime dependencies
  except `jiti`** (add none); tests use `node:test` via `tsx` and must run
  offline; every privileged tool declares `capabilities: [...]` and the
  dispatcher (here, our guard mirror) enforces them.
- **Capability discipline**: the `run_workflow` tool declares
  `capabilities: ["workflow:run"]`; the extension calls
  `e.grantCapability("workflow:run")` on activation (mirroring `subagents`'
  `e.grantCapability("agent:spawn")`). Tool-step capabilities are enforced by the
  guard mirror (Decision 4 stage 5).
- **Four-corner subagent template** for L3: `references/loop-3-development.md`.
- **Commit conventions** (SKILL.md "Commit conventions"): Phase opener
  `feat(phase1): …`; within-round fix `fix(phase1-roundR): <failing-item-keyword>`;
  include `npm test` / `npm run typecheck` results as trailers; **no mention of
  AI/model/tooling** in commit messages or any pushed artifact.

## 4. Data and Fixture Dependencies

- **Reused, no new fixtures**: `test/helpers.ts` (`makeHarness`, `lastText`,
  `silentLogger`, `MemoryBackend`), `src/providers/mock.ts` (`MockProvider`
  scripted by turn array or by a `(req, turnIndex) => MockTurn` responder that
  discriminates children on `req.systemPrompt`). Recording mock tools are defined
  inline in the test file (a tool whose `execute` pushes its received args into a
  captured array and returns a marker string) — the same technique
  `test/subagents.test.ts` and `test/planmode.test.ts` use. No external data.

## 5. Regression Protection

- `npm test` (the whole offline suite) must stay green — the new extension is
  additive; the only edits to existing files are one `BUILTIN_EXTENSIONS` line and
  one CLAUDE.md line. Particular attention to `test/host.test.ts` (builds
  `createAgentHost` with all builtins; it does not assert an extension count, so
  activating one more must not perturb it) and `test/subagents.test.ts` (the
  pattern this extension parallels — must be unaffected).
- `npm run typecheck` must stay green under the strict config — the new module and
  the two edits type-check.
</content>
