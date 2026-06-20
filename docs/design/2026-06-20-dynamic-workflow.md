# Design: Dynamic Workflow Extension

- Slug: `2026-06-20-dynamic-workflow`
- Status: closed
- Closing-commit: 459e31a
- Closed-on: 2026-06-20
- Deferred: none
- Tier: Full Mode (three-loop-workflow)

> Review history: L1 design — round 1 raised two severe issues (the tool-step
> guard mirror dropped the kernel's post-guard re-validation and mislocated
> `afterToolCall`) plus general issues; all fixed, rounds 2 and 3 clean. L2
> implementation — rounds 1 and 2 clean. L3 development — one fresh-eyes review,
> clean (the guard-mirror fidelity verified stage-for-stage against
> `src/kernel/agent.ts`), plus one cosmetic post-review cleanup. Round-by-round
> detail lives in git history.

## 1. Background and Purpose

EAgent today can decompose work in exactly two shapes: the single linear agent
loop (`src/kernel/agent.ts`), and the `subagents` extension
(`src/extensions/subagents.ts`), which spawns child agents in `single`,
`parallel`, or `chain` modes. Neither can express the shape that production
agent systems converge on for non-trivial tasks: a **dynamic workflow** — a
graph of inter-dependent steps, emitted by the model at runtime, where a step's
output feeds named downstream steps, independent steps run concurrently, and the
data dependencies between heterogeneous steps (tool calls *and* sub-agent
reasoning) are explicit.

The research synthesis (`docs/RESEARCH-workflows-and-agents.md`) shows this is
the orchestrator-workers / LLMCompiler / ReWOO pattern: the LLM emits a task DAG
whose edges are variable references (`#E2` / `${id}`), and a scheduler executes
it by dependency order, fanning out the ready frontier. Anthropic's taxonomy
calls the dynamic variant "orchestrator-workers… subtasks aren't pre-defined,
[they're] determined… based on input." A foundational result is that **the agent
loop is the degenerate (single-ready-node) case of a DAG scheduler** — so adding
a small ready-set scheduler as an extension is a natural, faithful increment, not
a new paradigm.

The gap `subagents` leaves: it has no notion of a *dependency between steps* and
no *data flow* between them other than `chain`'s blind "previous result"
relaying. It cannot say "run A and B in parallel, then feed both their outputs
into C, and separately run D (a file read) whose result also feeds C." A dynamic
workflow can.

If we do not do this: every multi-step task with a non-linear dependency
structure must be flattened by the model into a lossy `chain`, or hand-walked
turn-by-turn through the loop — slower, with no parallelism across independent
branches and no explicit, observable plan.

## 2. Deliverables

- [x] A new extension `src/extensions/dynamic-workflow.ts` registering one tool,
      `run_workflow`, gated behind a new `workflow:run` capability. The tool
      accepts a **workflow spec** (an array of steps) emitted by the model, and
      executes it as a dependency DAG.
- [x] Two step types: `tool` (invoke a registered tool by name with args) and
      `agent` (spawn an isolated child agent on a prompt, reusing the `subagents`
      child-construction pattern).
- [x] **Data flow by `${id}` substitution**: any string leaf in a step's `args`
      or `prompt` containing `${otherStepId}` is replaced, before that step runs,
      with the referenced step's string output. Referenced ids are automatically
      added to the step's dependency set (LLMCompiler-style auto-derived edges),
      unioned with any explicit `needs: string[]`.
- [x] A **topological scheduler** (Kahn's algorithm) that runs the ready frontier
      each round, executing independent steps concurrently and dependent steps
      after their inputs resolve. Up-front validation rejects unknown step ids,
      duplicate ids, references to unknown steps, cycles, an unknown tool name,
      and a step count over `MAX_STEPS`.
- [x] **Tool-step guarding that does not bypass existing policy**: a `tool` step
      is run through a faithful mirror of the kernel's guard sequence
      (`Agent.executeGuarded` + the `runOne` wrapper, `src/kernel/agent.ts:286-344`)
      — see Decision 4 for the exact stage order, including the **post-guard
      argument re-validation** and the `afterToolCall`-runs-on-every-outcome
      semantics. It reuses the agent's public `hooks` / `capabilities` surface, so
      `planmode`, `flow-guard`, and `integrity` continue to govern tool calls made
      inside a workflow.
- [x] **Fail-fast-with-isolation error model**: a step that errors marks its
      transitive dependents `skipped`; independent branches still complete; the
      tool returns `isError: true` when any step errored or was skipped, with a
      full per-step status rundown so the model can revise and re-call (the
      replanning loop lives in the model, not the tool).
- [x] A `/workflow` slash command that explains the spec shape and step types
      (mirrors `subagents`' `/agents` help command).
- [x] Registration in `BUILTIN_EXTENSIONS` (`src/host.ts`) and a one-line entry
      in the CLAUDE.md extension inventory.
- [x] An offline test file `test/dynamic-workflow.test.ts` (node:test via tsx,
      `MockProvider`, no network) covering every Acceptance Criterion.
- [x] `docs/design/2026-06-20-dynamic-workflow.md` (this file) and
      `docs/implementation/2026-06-20-dynamic-workflow.md`.

## 3. Scope Boundary (NOT in scope)

- **No conditional / branching edges, no in-graph routing.** A step cannot say
  "run C only if B's output matches X". The graph is a pure dependency DAG.
  Conditional control flow comes from the model **regenerating** the workflow
  (re-calling `run_workflow`) after seeing results — that is where the
  "dynamic" lives. Routing as an in-spec primitive is out of scope.
- **No persistence / durability / resumability / checkpointing.** A workflow
  executes within a single `run_workflow` tool call. If the process dies
  mid-run, the workflow is lost; there is no resume. (Temporal/LangGraph-style
  durable execution is explicitly out of scope — see research §4.)
- **No automatic replanning loop inside the tool.** The tool executes one spec
  and returns. It does not itself call the model to revise the plan. The model
  replans by issuing another `run_workflow` call.
- **No per-step retry / backoff policy.** A failing step fails (and skips its
  dependents). Retries are the model's to re-issue. (Research lists retry as
  nice-to-have.)
- **No structured shared-state object with reducers** (LangGraph channels). The
  only inter-step data mechanism is `${id}` string substitution. A step's output
  is its tool result `content` or its child agent's final assistant text — a
  string.
- **No streaming of partial step results to the UI.** The result is returned when
  the whole workflow settles. (Per-step kernel events are not emitted; see
  Decision 6.)
- **No new kernel primitive and no modification to `src/kernel/`.** This is a
  pure extension composing the public `Agent` surface, exactly as `subagents`
  does. (See Decision 4 for why the guard is reused rather than refactored into
  the kernel.)
- **No concurrency-limit knob.** The ready frontier runs via `Promise.all`; the
  blast radius is bounded structurally by `MAX_STEPS` (Decision 5), not by a
  configurable worker pool.
- **No nesting of workflows.** A workflow `agent` step's child agent does not
  receive the `run_workflow` tool (recursion guard, Decision 7); a `tool` step
  may not name `run_workflow`.

## 4. Key Design Decisions

### Decision 1 — Workflow representation: dependency DAG of steps

- **Problem**: how is a workflow represented in the tool's parameters so the
  model can emit it and the scheduler can execute it?
- **Options**: (a) a linear ordered step list (what `subagents chain` already
  is); (b) an explicit **dependency DAG** — a flat array of steps each carrying a
  unique `id` and a dependency set; (c) a full graph with typed nodes *and*
  conditional edges + a shared mutable state object (LangGraph `StateGraph`).
- **Choice**: (b). A flat `steps[]` array where each step has an `id`, a `type`,
  inputs (`args` or `prompt`), and dependencies derived from `${id}` references
  unioned with optional explicit `needs`. The scheduler resolves order by
  topological sort.
- **Why (a) rejected**: a linear list cannot express parallel independent
  branches or fan-in (multiple steps → one), which is the entire value-add over
  the existing `subagents chain` mode. Shipping (a) would duplicate `subagents`.
- **Why (c) rejected**: conditional edges + reducer-merged shared state is the
  LangGraph data model — powerful but far past "minimum code that solves the
  stated problem". A minimalist kernel extension should not carry a graph
  runtime. The dynamism it would add (in-graph branching) is instead delivered by
  model re-invocation (Scope Boundary), which needs zero new machinery.

### Decision 2 — Step types: `tool` and `agent`

- **Problem**: what can a step *do*?
- **Options**: (a) `tool` steps only (an LLMCompiler-style pure tool DAG);
  (b) `agent` steps only (an orchestrator-workers DAG of sub-agents);
  (c) both.
- **Choice**: (c). A `tool` step invokes a registered tool by name with `args`
  (the workhorse: parallel reads/edits/searches with explicit data deps). An
  `agent` step spawns an isolated child agent on a `prompt` (the
  orchestrator-worker dimension: a reasoning sub-task with its own fresh
  context), reusing the proven `subagents` child-construction pattern.
- **Why not (a)**: omitting `agent` steps would make a workflow unable to embed
  open-ended reasoning sub-tasks — the orchestrator-workers pattern the research
  identifies as the canonical *dynamic* workflow.
- **Why not (b)**: routing every step through a full child agent is wasteful for
  what is a single deterministic tool call, and loses the per-tool capability
  gate granularity. Tool steps are the cheaper, more common case.
- **Marginal complexity is low**: `agent` steps **re-implement** (not import) the
  `subagents` child shape — `subagents`' `makeChild`/`runChild`/`buildChildRegistry`
  are closures inside its `activate` (`src/extensions/subagents.ts:53-71`), so they
  are not importable; only `childRegistryFrom` is exported (`subagents.ts:175`),
  and it omits the wrong tool (`spawn_agent`) for our purposes (Decision 7). This
  extension therefore writes its own small `makeChild`/`runChild`/`finalText`
  following the same proven shape (shared providers + capabilities, pruned
  registry). There is no third step type (e.g. a bare "LLM call" distinct from an
  agent) — an `agent` step with a single-shot prompt already covers it.

### Decision 3 — Inter-step data flow: `${id}` string substitution with auto-derived edges

- **Problem**: how does a step consume an upstream step's output, and how are
  dependency edges established?
- **Options**: (a) a structured shared-state object each step reads/writes, with
  per-key reducers (LangGraph); (b) **`${id}` string substitution** — a step's
  string inputs may embed `${upstreamId}`, replaced at run time by that step's
  string output (ReWOO `#E2` / LLMCompiler argument refs); (c) implicit
  positional relaying (`subagents chain`'s "Previous result:" prefix).
- **Choice**: (b), and **dependency edges are auto-derived from the references**
  (`extractRefs(step)`), unioned with any explicit `needs: string[]` for
  ordering-only dependencies that pass no data. A step runs only after every
  step in its effective dependency set has succeeded; substitution then resolves.
- **Why (a) rejected**: a typed shared-state + reducers model is the bulk of
  LangGraph's surface area — out of proportion for this extension. A string is a
  sufficient and fully observable payload.
- **Why (c) rejected**: positional relaying cannot express "C needs A *and* B" or
  reference a specific upstream by name; it is exactly the limitation we are
  removing.
- **Why auto-derive edges**: requiring the model to separately and correctly
  declare `needs` for every `${id}` it writes is an error-prone redundancy and
  the classic "missing-dependency → race" failure mode (research §A). Deriving
  the edge from the reference makes a referenced-but-unsequenced step
  structurally impossible. Explicit `needs` remains available for the rarer
  ordering-only dependency (run after X, but don't consume X's text).
- **Substitution scope**: a deep walk over the step's `args` object (and the
  `prompt` string) replacing `${id}` tokens in **string leaves only**. Only a
  token whose inner value equals a **declared step id** is treated as a reference
  (and thus an auto-derived edge); a `${...}` whose inner value is not a declared
  step id is **left verbatim** — it may be legitimate user text (e.g. a shell
  `${HOME}` inside a `bash` arg), and silently corrupting it would be worse than
  passing it through. The model sees any unresolved `${...}` echoed back in the
  per-step rundown (Decision 6), so a typo'd reference is observable and
  self-correctable. (The *hard* "unknown step id" validation error, Decision 5,
  applies to an explicit **`needs`** entry — a declared ordering edge that must
  point at a real step — not to free `${...}` text.)
- **Substitution happens *before* the guard's `validate`** (Decision 4 stage 1
  precedes stage 2). Consequence: if `${id}` is substituted into a field the
  tool's schema types as non-string (e.g. `number`), the substituted text then
  flows through the kernel `validate` coercion (`"3"`→`3`) exactly as a
  hand-written literal would — substitution introduces no special typing path.
- **Empty upstream output**: a step's output is a string and may be `""` (a tool
  returning empty `content`, or an `agent` child whose `finalText` finds no text
  block — `subagents.ts:192-200` returns `""`). `${id}` then substitutes the
  empty string. This is intentional and observable: the per-step rundown
  (Decision 6) shows the empty output, so the model can see *why* a downstream
  input looked blank and revise. No special-casing.

### Decision 4 — Tool-step guarding reuses the kernel guard via the public Agent surface

- **Problem**: a `tool` step executes a registered tool *without* going through
  the kernel's `Agent` loop. The kernel's `executeGuarded` is where argument
  validation, the `beforeToolCall` filter (which `planmode`, `flow-guard`, and
  `integrity` hook into), capability enforcement, and the `afterToolCall` filter
  all happen. If the workflow calls `tool.execute()` directly, **all of that
  policy is bypassed** — a model could smuggle a mutating or egress tool call
  inside a workflow to dodge plan-mode approval and the egress gate. That is a
  security regression.
- **Options**: (a) call `tool.execute()` directly (fast, but bypasses all
  policy — rejected outright); (b) **mirror `executeGuarded` inside the
  extension**, driving the agent's public `hooks` bus and `capabilities` manager
  for each tool step; (c) refactor the kernel to expose a public
  `Agent.invokeTool(call)` that both the loop and the workflow call (DRY, single
  source of truth).
- **Choice**: (b), mirroring the kernel **stage-for-stage**. The verified
  reference is `Agent.executeGuarded` wrapped by `runOne`
  (`src/kernel/agent.ts:286-344`); the mirror reproduces it exactly:
  1. **Substitute** `${id}` references into the step's `args` (Decision 3),
     producing the concrete argument object.
  2. `validate(tool.spec.parameters, args)` → `{ok, value, errors}`; let
     `current = ok ? value : args` (the coerced args, or the raw args if
     invalid) — exactly as `agent.ts:305-306`.
  3. `e.agent.hooks.apply("beforeToolCall", {block:false, arguments:current},
     {call}, d => d.block)`; if the returned decision is `block`, the step's
     result is a "blocked" error — `agent.ts:308-317`.
  4. If step 2's `ok` was false, return the invalid-arguments error **now**
     (after `beforeToolCall`, matching `agent.ts:318-320`).
  5. `await e.agent.capabilities.require(cap, name)` for each declared capability
     — `agent.ts:322-324`.
  6. **Re-validate the guard's (possibly rewritten) arguments**:
     `validate(tool.spec.parameters, decided.arguments)` → `final`; if
     `!final.ok`, return the "after guards" invalid-arguments error. This stage
     is load-bearing — a `beforeToolCall` filter may rewrite args and the kernel
     contract is that the tool still receives schema-clean, coerced input
     (`agent.ts:326-332`). Omitting it would pass unvalidated guard-rewritten
     args to the tool.
  7. `tool.execute(final.value, ctx)` — `agent.ts:343`.
  - **Wrapper semantics (the `runOne` layer, `agent.ts:286-297`)**: stages 1-7
    run inside a `try`; **any throw** (e.g. a `CapabilityError` from
    `capabilities.require`, `capabilities.ts:85`) is caught and converted to
    `{content: <error text>, isError: true}` — it must **not** abort the
    surrounding `Promise.all` frontier or tank sibling steps. Then, on **every
    outcome** (success, blocked, invalid, or thrown), the result is passed through
    `e.agent.hooks.apply("afterToolCall", result, {call})` before becoming the
    step's recorded result. (`tool_start`/`tool_end` events are not re-emitted —
    Decision 6.)
  - The `ToolContext` passed to `tool.execute` reuses the outer `run_workflow`
    call's `ctx` field-by-field: **`signal`** = the outer call's `ctx.signal` (so
    aborting the parent workflow propagates to in-flight sub-steps — the same
    abort signal the kernel threads at `agent.ts:336`), **`ui`/`agent`/`log`/`progress`**
    = the outer call's (all four are reused as-is; `progress` is a *required*
    member of `ToolContext`, `types.ts:146`, so it must be carried), **`toolCallId`**
    = a per-step `wf:<stepId>`, and **`require`** bound to
    `e.agent.capabilities.require`. The synthetic
    `call: ToolCallBlock` passed to the hooks is `{id: "wf:<stepId>", name,
    arguments}`.
- **Why not (c)** *for v1*: it is the cleaner long-term design (no duplicated
  guard, no drift), but it modifies `src/kernel/agent.ts` — one of the seven
  primitives the project's core bet keeps small and stable. Touching the kernel
  to serve one extension contradicts "everything else is an extension". (b) keeps
  the kernel byte-for-byte unchanged, exactly as `subagents` reuses `providers`
  and `capabilities` without modifying the loop. **The duplication risk is
  explicitly accepted and bounded**: the guard helper is a single function with a
  comment stating it mirrors `Agent.executeGuarded`'s order, and AC-7 asserts a
  `beforeToolCall` block actually vetoes a workflow tool step (proving the mirror
  is wired, so drift surfaces as a failing test). If a second extension ever needs
  the same guarded invoke, that is the trigger to promote it into the kernel
  (recorded as future work, not done here).
- **Reaching `e.agent.hooks`**: the `HookBus` is a public `readonly` field on
  `Agent`; the curated `ExtensionAPI` exposes `hook()`/`on()` to *register* but
  not to *apply*. The workflow is itself a dispatcher of sub-tool-calls, so
  threading those sub-calls through the same hook bus is the behavior that keeps
  the kernel's guarantees intact. This is called out explicitly so the reviewer
  can challenge it rather than have it pass by silent omission.

### Decision 5 — Up-front validation and the `MAX_STEPS` bound

- **Problem**: a model-emitted spec is untrusted input and can be malformed
  (cycles, dangling refs, unknown tools) or unboundedly large.
- **Choice**: validate the whole spec **before executing any step**, rejecting
  with a single actionable error (the model can then fix and re-call):
  duplicate `id`; empty/over-`MAX_STEPS` step list; a **`needs`** entry
  referencing an unknown step id (a `${...}` token that is not a declared id is
  *not* an error — Decision 3, left verbatim); a self-dependency; a cycle (Kahn's
  algorithm leaves nodes unscheduled); `type: "tool"` naming an unregistered tool
  or naming `run_workflow` itself; a step missing its required input (`tool` for a
  `tool` step, `prompt` for an `agent` step).
- **`MAX_STEPS`** is a module constant (default **32**). Rationale: it bounds a
  runaway generated plan (research's "bounded autonomy") while comfortably
  exceeding any hand-written workflow. It is a constant, not a config surface —
  Simplicity First; if it ever needs tuning that is a future decision.
- **Why up-front**: executing a partially-valid DAG then failing midway wastes
  tool calls and leaves confusing partial state. Cycle/ref errors are cheap to
  detect statically and are pure spec bugs.

### Decision 6 — Execution semantics: parallel ready frontier, respecting `executionMode`

- **Problem**: how is the ready frontier executed each round, and how does that
  interact with tools the kernel marks `executionMode: "sequential"` (e.g.
  `bash`, `run_code`) which must never be interleaved?
- **Choice**: each scheduler round computes the ready set (steps whose
  dependencies have all succeeded). It is executed with the **same heuristic the
  kernel's `dispatch` uses** (verified at `src/kernel/agent.ts:273-284`): if any
  ready *tool* step names a tool whose `executionMode` is `"sequential"`, the
  whole round runs **sequentially**; otherwise the round runs concurrently via
  `Promise.all`. `agent` steps participate in the concurrent round like
  `subagents parallel` mode.
- **Honest limitation on `agent` steps and global sequential tools**: this rule
  serializes sequential-mode tools only *within one round's frontier of direct
  `tool` steps*. Two concurrent `agent` steps can each, inside their own child
  loop, invoke the same global sequential tool (e.g. `bash`) at the same
  wall-clock moment — the kernel's per-batch rule only serializes calls within a
  single dispatch batch, and **`subagents parallel` already has exactly this
  property today**. So cross-`agent`-step isolation of a sequential tool is *not*
  guaranteed; this is inherited, pre-existing behavior, not a new risk introduced
  here. Stated plainly so it is not mistaken for a guarantee.
- **Why**: mirroring the kernel's existing per-batch rule (rather than inventing
  a new policy) keeps the `sequential` contract intact for tools that rely on it,
  with no new concept. It is "match existing patterns", not gold-plating.
- **Output/observability**: the tool result `content` is a per-step rundown
  (`[id] (status): output`), and `details` carries the structured
  `{id, type, status, output}[]` for renderers. Per-step kernel events
  (`tool_start`/`tool_end`) are **not** re-emitted for sub-steps (the
  `run_workflow` call itself already emits them); the structured rundown is the
  observability surface for v1.

### Decision 7 — Recursion guard for `agent` steps

- **Problem**: an `agent` step spawns a child agent; if that child can call
  `run_workflow`, workflows nest unboundedly.
- **Choice**: a dedicated, exported registry-builder
  `workflowChildRegistry(parentTools)` constructs the child's tools as the
  parent's active tools **minus `run_workflow`** — analogous to `subagents`'
  `childRegistryFrom` (`subagents.ts:175`) but omitting *this* extension's own
  entry point rather than `spawn_agent`. (It does not also drop `spawn_agent`:
  each extension guards only its own recursion; cross-extension nesting depth is
  bounded by `maxTurns`/`MAX_STEPS`, below.) A `tool` step additionally may not
  name `run_workflow` (validation, Decision 5). Exporting the builder lets AC-10
  assert the omission directly, exactly as `subagents` exports `childRegistryFrom`
  for its recursion test.
- **Why**: each extension guards its own recursion by omitting its own entry
  point from children — a local, composable rule. Cross-extension nesting depth
  (a workflow `agent` step whose child uses `spawn_agent`) remains bounded by the
  child's `maxTurns` and the parent `MAX_STEPS`, consistent with how `subagents`
  already behaves; eliminating it entirely is out of scope.

## 5. Dependencies and Assumptions

- **Runtime / house rules**: Node ≥ 22, ESM + NodeNext (`.js` import specifiers),
  strict TypeScript, zero new npm dependencies. The extension imports only from
  `src/kernel/` (`define`, `extension` types, `agent`, `registry`, `types`,
  `validate`) and `node:`-nothing (pure in-process logic).
- **Public Agent surface relied upon** (all already used by `subagents` except
  the two marked †, which are public `readonly` fields):
  `e.agent.providers`, `e.agent.capabilities`, `e.agent.ui`, `e.agent.logger`,
  `e.agent.model`, `e.agent.providerName`, `e.agent.tools` (a `ToolRegistry`),
  and †`e.agent.hooks` (the `HookBus`, for `apply("beforeToolCall"/"afterToolCall")`).
  Plus `validate` from `src/kernel/validate.js` (the same util the kernel
  dispatcher uses).
- **Capability**: a new `workflow:run` capability, granted by the extension via
  `e.grantCapability("workflow:run")` and declared on the `run_workflow` tool, so
  the workflow entry point is itself governed by the capability layer. Tool steps
  additionally require their own tools' capabilities (Decision 4).
- **Assumption**: a step's output is adequately represented as a string (tool
  `content`, or child agent final text). Tools that return rich `details` still
  expose their human-legible `content` for substitution; structured-payload
  threading is out of scope (Scope Boundary).
- **Assumption**: `MockProvider` (`src/providers/mock.ts`) can script a parent
  turn that emits a `run_workflow` tool call and script child-agent turns by
  system-prompt discrimination, exactly as `test/subagents.test.ts` does — so the
  whole feature is testable offline.

## 6. Relationship with Existing Designs

`docs/design/` contains one prior design,
`2026-06-17-console-autocomplete.md` (a host-UI feature, no overlap). Per the L1
convention, terminology anchors are CLAUDE.md (Architecture: "seven primitives";
House conventions) and the project README. Companion research:
`docs/RESEARCH-workflows-and-agents.md` and `docs/RESEARCH-agent-kernel-design.md`.

Touch points / closest existing patterns (no conflicts found):

- `src/extensions/subagents.ts:42-200` — the child-agent construction. Note
  `makeChild`/`runChild`/`buildChildRegistry` are **closures inside `activate`
  (lines 53-71), not exports**; only `childRegistryFrom` (line 175) and `finalText`
  (line 192) are module-scope. The `agent` step type therefore **re-implements**
  this shape (Decision 2) rather than importing it, and uses its own
  `workflowChildRegistry` (Decision 7) since `childRegistryFrom` omits
  `spawn_agent`, not `run_workflow`.
- `src/kernel/agent.ts` `executeGuarded` / `dispatch` — the guard sequence
  Decision 4 mirrors and the `executionMode` batch heuristic Decision 6 mirrors.
  This design **reads** that code to mirror it but does **not** modify it.
- `src/kernel/define.ts` — `defineTool`, `ok`, `fail`.
- `src/kernel/validate.ts` — `validate(schema, args)` reused for tool-step arg
  validation.
- `src/host.ts` `BUILTIN_EXTENSIONS` — append `["dynamic-workflow", dynamicWorkflow]`.
- `src/extensions/planmode.ts` / `flow-guard` / `integrity` — these register
  `beforeToolCall` filters; Decision 4 exists specifically so they keep governing
  intra-workflow tool steps. This design **depends on** their hook continuing to
  fire, which it ensures by routing tool steps through `e.agent.hooks`.

⚠ None detected (no design/contract is altered). The only edits to existing files
are additive: one line appended to `BUILTIN_EXTENSIONS` in `src/host.ts`, and one
inventory line added to the CLAUDE.md extension list (CLAUDE.md:48-55). The latter
is a **contract-doc touch** — the extension inventory is part of the project's
load-bearing documentation — so it is called out explicitly here rather than
treated as a throwaway edit; it adds an entry without changing any existing rule
or wording.

## 7. Acceptance Criteria (measurable / automatable, realized at L2)

All run offline via `MockProvider`, no API key. AC-1…AC-11 are behavioral
assertions in `test/dynamic-workflow.test.ts`; AC-12/AC-13 are the global
regression gate.

- **AC-1 (linear data flow)**: a 2-step workflow where step `b` references
  `${a}` runs `a` then `b`, and `b`'s realized input contains `a`'s output
  string. Assert via a recording mock tool that captures the args it received.
- **AC-2 (parallel + fan-in)**: steps `a` and `b` (no deps) both run; step `c`
  references `${a}` and `${b}`; `c` runs after both and its input contains both
  outputs. Assert `a` and `b` are dispatched before `c` and `c` sees both.
- **AC-3 (agent step)**: an `agent` step spawns a child agent (discriminated by
  system prompt in the mock) whose final text becomes the step output and is
  substitutable into a downstream step.
- **AC-4 (tool step honors capabilities)**: a `tool` step naming a tool that
  declares a capability is **blocked** when the capability manager's fallback is
  `deny` (the thrown `CapabilityError` is caught per-step → status `error`,
  dependents `skipped`, **sibling steps in the same frontier still complete**),
  and **runs** when the capability is granted.
- **AC-5 (cycle rejected)**: a spec where `a` needs `b` and `b` needs `a` returns
  `isError: true` with a cycle message and executes **no** step (assert the
  recording tool was never called).
- **AC-6 (dangling dependency / unknown tool / duplicate id rejected)**: a
  `needs` entry pointing to an unknown id, a `tool` step naming an unregistered
  tool, and a duplicate `id` each return `isError: true` up front with a specific
  message; no step runs. Companion (Decision 3): a `${unknownId}` token that is
  not a declared step id is **not** rejected — it is left verbatim in the realized
  input (asserted via a recording tool).
- **AC-7 (guard not bypassed — `beforeToolCall` still fires)**: with a
  `beforeToolCall` filter registered that blocks a specific tool, a workflow
  `tool` step naming that tool is vetoed (status `error`/blocked), proving
  Decision 4's guard reuse — the kernel policy is not bypassed by the workflow.
- **AC-7b (post-guard re-validation — Decision 4 stage 6)**: with a
  `beforeToolCall` filter that *rewrites* a tool step's arguments, the tool's
  `execute` receives the rewritten-**and-revalidated** args (assert via a
  recording tool), proving the mirror does not skip `agent.ts:326-332`. A
  companion case: a filter that rewrites an arg to a schema-invalid value yields
  the "after guards" invalid-arguments error and the tool is **not** executed.
- **AC-7c (`afterToolCall` runs on every outcome)**: with an `afterToolCall`
  filter that tags results, the tag appears on a successful tool step's result
  **and** on a step whose tool threw / was capability-denied — proving the
  `runOne`-layer semantics (`agent.ts:286-297`) are mirrored and a thrown step
  does not abort its sibling frontier.
- **AC-8 (fail-fast isolation)**: in a diamond where `b` (depends on `a`) errors,
  step `c` (also depends on `a`, independent of `b`) still completes, and `d`
  (depends on `b`) is `skipped`; the tool returns `isError: true` with the
  per-step rundown.
- **AC-9 (`MAX_STEPS` bound)**: a spec with `MAX_STEPS + 1` steps returns
  `isError: true` with a bound message and runs nothing.
- **AC-10 (recursion guard)**: a `tool` step naming `run_workflow` is rejected at
  validation; and the exported `workflowChildRegistry(parentTools)` helper, given
  a parent tool set that includes `run_workflow`, returns a registry whose
  `.has("run_workflow")` is `false` (the `ToolRegistry.has` accessor used by
  `subagents`' own recursion test) while preserving the other tools (asserted via
  `.list()`/`.get()`).
- **AC-11 (`executionMode` sequential not interleaved)**: with two ready `tool`
  steps both naming a `executionMode: "sequential"` tool instrumented to record
  concurrent entries, the recorded maximum concurrency is 1 (they do not
  overlap); two `parallel`-mode steps are allowed to overlap.
- **AC-12 (suite regression)**: `npm test` exits 0 — the new file passes and no
  existing test changes behavior.
- **AC-13 (typecheck)**: `npm run typecheck` exits 0 under the project's strict
  config (`strict`, `noUncheckedIndexedAccess`, …).

**Quality budget**: this is an internal tool surface (model-facing), not a
user-facing hot path; there is no latency/throughput SLA to assert. The relevant
quality attribute — that intra-workflow tool calls remain policy-governed — is
realized as a *correctness* criterion (AC-4, AC-7), not a performance budget. A
wall-clock budget over `Promise.all` of mock tools would not be a stable CI
assertion; structural bounds (`MAX_STEPS`, AC-9) cover the runaway case instead.

## 8. Risks and Rollback

- **Risk: the Decision-4 guard mirror drifts from `Agent.executeGuarded`.** If
  the kernel changes its guard order, the extension's copy goes stale and could
  silently bypass a new policy step. *Mitigation*: AC-7 asserts the
  `beforeToolCall` block path is live; a code comment marks the mirror; the guard
  is a single localized helper. *Residual*: a *newly added* guard stage the
  kernel introduces later would not be reflected until someone updates the
  extension — recorded as a known maintenance coupling.
- **Risk: unbounded parallel fan-out exhausts API budget.** A wide independent
  frontier issues many concurrent tool/agent calls. The worst-case concurrent
  burst is the **widest independent layer** of the DAG; `MAX_STEPS=32` bounds the
  *total* step count (AC-9), which caps that width too (a layer cannot exceed the
  total). *Mitigation*: this `Promise.all` fan-out matches the already-unbounded
  `subagents parallel` behavior, so it introduces no new class of risk; a
  per-frontier concurrency knob is out of scope (Scope Boundary).
- **Risk: `${id}` substitution collides with legitimate `${…}` user text.**
  *Mitigation*: only tokens whose inner value equals a **declared step id** are
  substituted (Decision 3); all other `${…}` text is left verbatim.
- **Risk: a sequential-mode tool is interleaved inside a workflow, violating its
  contract** (e.g. two `bash` steps racing). *Mitigation*: Decision 6 mirrors the
  kernel's per-batch sequential rule; AC-11 asserts no overlap.
- **Risk: recursion / workflow-in-workflow blowup.** *Mitigation*: Decision 7's
  omission guard + the `tool`-naming-`run_workflow` validation (AC-10).
- **Rollback**: the feature is additive and isolated. Reverting is deleting
  `src/extensions/dynamic-workflow.ts` + `test/dynamic-workflow.test.ts`, removing
  the one `BUILTIN_EXTENSIONS` line in `src/host.ts`, and removing the CLAUDE.md
  inventory line. No kernel, no other extension, and no non-workflow path is
  touched, so revert is mechanical and total.
</content>
</invoke>
