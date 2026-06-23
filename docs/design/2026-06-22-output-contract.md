# Design: `output-contract` extension — schema-validated final output via a `respond` tool + validate-and-reask

Status: closed
Closing-commit: 560f2a5946769a78fdb6074f46539090e221d4d4
Closed-on: 2026-06-23
Deferred: provider-side decode-time forcing (`toolChoice`/`responseFormat` on the Provider request + anthropic/openai/gemini/mock) — see Scope Boundary.

Slug: `2026-06-22-output-contract`

## 1. Background and Purpose

EAgent validates tool **input** rigorously. Before a tool runs, the kernel
coerces and validates the model's arguments against the tool's JSON Schema
(`src/kernel/agent.ts:314-341`, using the kernel validator `validate`,
`src/kernel/validate.ts:19`), and on a schema miss it refuses the call with a
precise per-field error (`agent.ts:328`, `:340`). Tools therefore always see
"schema-clean, coerced input — the kernel's contract" (`agent.ts:336-337`).

EAgent has **no equivalent for final output.** A run returns
`RunResult = { reason, messages }` (`agent.ts:54-57`), an untyped transcript.
Every caller that wants a *result* scrapes the last assistant **text** block and
hopes it parses:

- the HTTP host emits only `{ type: "done", reason, session, usage }`
  (`src/server.ts:215-217`) — there is no typed result field at all;
- `subagents` returns `finalText(messages)`, "the last assistant text block"
  (`src/extensions/subagents.ts:227-235`);
- `dynamic-workflow` does the same: `finalText(messages)` for each step's output
  (`src/extensions/dynamic-workflow.ts:449-450, 477-481`).

So EAgent is **input-validated but output-unvalidated** — a structural
asymmetry. A caller that needs a machine-checkable result (an HTTP client, a
workflow step that feeds one agent's output into another's input, an eval
harness) has no way to *demand* that the run end in a value conforming to a
declared schema. It gets prose and a JSON-parse gamble.

This task closes the asymmetry **for v1** by reusing the exact machinery the
input side already uses. A caller opts in by declaring an output JSON Schema
before the run. When set, a `respond` tool is registered whose **parameters are
that schema**; when the model calls `respond`, its arguments are validated and
coerced through the same `validate` (`validate.ts:19`) and surfaced as the run's
typed output, ending the turn. On a validation **failure**, the loop appends a
structured reask echoing the validator's *exact per-field error strings*
(`validate.ts:31, 49, 96`), bounded by a `maxOutputRetries` cap; after the cap
it returns the best-effort result flagged. With no schema declared, behavior is
byte-identical to today.

If we do not do this, EAgent's machine-to-machine consumers (server, subagents,
dynamic-workflow, evals) stay stuck on free-text scraping, and the validator
that already guarantees clean *input* is never turned around to guarantee clean
*output*.

## 2. Deliverables

- [ ] `src/extensions/output-contract.ts` — the extension: on activation it
      registers nothing observable until an output schema is requested; when
      `e.agent.outputSchema` is set it (a) dynamically registers a `respond` tool
      whose `parameters` **are** that schema, (b) nudges the model toward
      `respond` (system steer on first turn), (c) drives validate-and-reask from
      an **`afterToolCall` filter** (`agent.ts:303`, equivalently the `tool_end`
      event at `agent.ts:304`) — **not** from `respond.execute`, because on an
      *invalid* `respond` the kernel refuses at `agent.ts:327-329` and never
      reaches `execute` (`agent.ts:352`), so `execute`-resident reask/count logic
      would never run on a schema miss; `afterToolCall`/`tool_end` both fire on
      that refused result. From there: on a **valid** `respond` (the kernel passed
      validation and `execute` ran, returning `terminate:true`) it writes
      `e.agent.output` and the turn ends; on a **failed** `respond` (the kernel's
      `isError` "Invalid arguments for respond" result) it **steers** a reask
      carrying the exact per-field errors and increments the attempt count, up to
      `maxOutputRetries`; after the cap it surfaces the last
      (invalid-but-best-effort) value flagged **and calls `e.agent.stop()` to halt
      the loop** (D4 — the invalid-`respond` path is non-terminating, so an
      explicit stop is required to end the run). Pure
      helpers (`buildReask`, `validateOutput`) exported for unit testing. Env
      kill switch `EAGENT_OUTPUT_CONTRACT=off`. No new capability (no side
      effect: `respond` only records a value).
- [ ] Minimal kernel change — two **optional** public fields on the `Agent`
      class: `outputSchema?: JSONSchema` (caller sets before `run()`) and
      `output?: { value: unknown; ok: boolean }` (caller reads after `run()`).
      No change to `run()`'s signature, to `RunResult`, or to any kernel barrel
      export. (See D2 for why fields beat a `run()` option.)
- [ ] `test/output-contract.test.ts` — offline `node:test` via `makeHarness`
      (`test/helpers.ts:27`) with a scripted `MockProvider` (`src/providers/mock.ts:20`)
      covering: valid `respond` → typed `output` surfaced; invalid → reask
      carrying the **exact** validator error string → then valid → success;
      never-valid → cap reached, last value returned with `ok:false`; no schema
      set → `respond` unregistered and `output` undefined (backward-compat);
      kill switch; clean teardown.
- [ ] `output-contract` registered in `BUILTIN_EXTENSIONS` (`src/host.ts:72-113`).
- [ ] A `/respond` (or `/output`) command that prints the active output schema
      (if any) and the last surfaced output — read-only introspection, no state
      change.
- [ ] `EAGENT_OUTPUT_CONTRACT=off` kill switch (covered by a test).
- [ ] CLAUDE.md extension-inventory line for `output-contract` added (the
      inventory currently lists the set in `src/host.ts`; this adds one entry).
      The live baseline is **40 built-in extensions** (`BUILTIN_EXTENSIONS`,
      `src/host.ts:72-113`), so this entry takes the count to **41**, reconciled
      at closeout. `README.md:333` carries the count explicitly ("40 built-in
      extensions") and **must** be bumped to 41 — a required touch, not a
      conditional one.

`docs/EXTENSIONS.md` is **not** touched: per the `bash-policy` ruling
(`docs/design/2026-06-20-bash-policy.md`) and the `recovery` design
(`docs/design/2026-06-21-recovery-hooks.md:59-62`) it is the extension
*author's guide*, not a per-extension catalog.

## 3. Scope Boundary (NON-goals — Simplicity First)

- **NO provider-interface change. This is the load-bearing scope cut.**
  Decode-time forcing — adding a `toolChoice`/`responseFormat` field to
  `CompletionRequest` (`src/kernel/types.ts:203-211`) and teaching anthropic,
  openai, gemini, and mock to constrain decoding to the schema — is **explicitly
  deferred**. It is the riskiest path: it touches the kernel `Provider` contract
  (`types.ts:218-221`), all four providers, and Anthropic in particular does
  **not** accept an arbitrary `json_schema` decode constraint, so a uniform
  forcing field would degrade unevenly across providers and need a
  graceful-degrade path anyway. v1 delivers typed validated output with **zero**
  provider change, via the `respond` tool plus post-hoc validate-and-reask. The
  forcing field is a clean, separately-scoped follow-up that *layers onto* this
  design (the validator and the `respond` schema are already the shape it needs).
- **NO change to `RunResult` or to `run()`'s signature.** `RunResult` stays
  `{ reason, messages }` (`agent.ts:54-57`); the typed output is read off the
  optional `Agent.output` field (D2), so existing `run()` callers compile and
  behave identically.
- **NO new validation code and NO new dependency.** Output is validated by the
  existing kernel `validate` (`validate.ts:19`) — no Zod, no second validator
  (D5; jiti-only rule upheld).
- **NO wiring of the consumers in this task.** `server`/`subagents`/
  `dynamic-workflow` are noted as *future consumers* of `Agent.output` (Section
  6) but are **not** rewired here — that is a separate change per consumer.
- **NO multi-schema / per-turn schema switching.** One output schema per run,
  set before `run()`. Changing it mid-run is out of scope.
- **NO enforcement that the model *must* call `respond`.** v1 nudges and reasks;
  it cannot (without provider forcing, deferred above) guarantee the call. The
  cap + flagged result is the bound on a model that never complies (D4).
- **NO capability.** Recording a value the run already produced is not a side
  effect; the extension declares and requires none (mirrors `recovery`,
  `docs/design/2026-06-21-recovery-hooks.md:91`).

## 4. Key Design Decisions

### D1. v1 mechanism: `respond` tool + post-hoc validate-and-reask, NOT provider decode-time forcing

- **Problem:** How does a caller obtain a result *guaranteed* to satisfy a JSON
  Schema, given a provider abstraction that only "turns a request into a stream
  of events" (`types.ts:218-221`) with no native output-schema knob today?
- **Options:**
  1. **Provider decode-time forcing.** Add `responseFormat`/`toolChoice` to
     `CompletionRequest` and have each provider constrain decoding to the schema
     (OpenAI structured outputs, Gemini response schema, Anthropic forced
     tool-use as a stand-in). Output is correct *by construction*.
  2. **`respond` tool + post-hoc validate-and-reask (this design).** Register a
     `respond` tool whose parameters are the caller schema; validate its
     arguments with the existing `validate`; on failure, steer a precise reask;
     bound by a retry cap. No provider change.
- **Choice:** Option 2 for v1; Option 1 explicitly deferred (Scope Boundary).
- **Rationale:** Option 1 touches the kernel `Provider` contract *and* all four
  providers at once — the single highest-blast-radius surface in the repo — and
  Anthropic has no arbitrary-`json_schema` decode constraint, so Option 1 must
  *also* implement a graceful-degrade fallback that looks exactly like Option 2.
  Building the fallback first (Option 2), with **zero** provider risk, delivers
  the user-visible value (typed validated output) immediately and leaves Option
  1 as a strict, additive enhancement that reuses this design's schema and
  validator. **Rejected** Option 1 for v1 because it front-loads the riskiest,
  least-uniform work to get a result the post-hoc path already achieves; the
  forcing field is a follow-up, not a prerequisite.

### D2. How the caller passes the schema and reads the output: optional `Agent` fields vs a `run()` option

- **Problem:** The caller must (i) hand the agent the output schema before the
  run and (ii) read the validated output after it. What is the *smallest*
  backward-compatible kernel surface for that?
- **Options:**
  1. **Two optional public fields on `Agent`:** `outputSchema?: JSONSchema` (set
     before `run`) and `output?: { value: unknown; ok: boolean }` (read after).
     `run()`'s signature is untouched; the extension reads `e.agent.outputSchema`
     and writes `e.agent.output`.
  2. **Thread an options object through `run(input, opts?)`** carrying the schema,
     and add the result to `RunResult`.
- **Choice:** Option 1.
- **Rationale:** Existing `run(input)` callers (`server.ts:215`,
  `subagents.ts:81`, `dynamic-workflow.ts:449`, every test) **must** be
  unaffected. Option 2 changes the `run()` signature *and* `RunResult`
  (`agent.ts:54-57, 146`) — a contract change to the kernel's most-called method;
  even with an optional arg it widens two public shapes. Option 1 is purely
  *additive*: two optional fields default to `undefined`, so the kernel behaves
  identically when unset, and the `respond`/reask machinery lives entirely in the
  extension reading/writing those fields. The fields are *data on the instance*,
  not new barrel exports, so `kernel-surface.test.ts`'s pinned export list
  (`test/kernel-surface.test.ts:21-47`) stays green; the only growth is a few
  lines under the 2200-line kernel ceiling (`kernel-surface.test.ts:59-68`;
  current kernel ≈ 1762 lines, ~438 headroom). **Rejected** Option 2 because
  touching `run()`/`RunResult` is a larger, less-additive kernel-contract change
  for no functional gain over two optional fields. (A backward-compat test, AC8,
  pins that an unset `outputSchema` leaves `run()` byte-identical.)

### D3. The `respond` tool's parameters ARE the caller schema (dynamic per-run registration) vs a fixed generic param

- **Problem:** What schema does the model see when asked to produce output?
- **Options:**
  1. **Fixed generic param**, e.g. `respond(result: object)` — one static tool;
     the extension validates `result` against the caller schema afterward.
  2. **Dynamic registration:** when `outputSchema` is set, register a `respond`
     tool whose `parameters` field *is* the caller's schema, so the model sees
     the real required fields/types in the tool spec the provider receives
     (`agent.ts:256` lists `tool.spec` into the request).
- **Choice:** Option 2 — dynamic per-run registration.
- **Rationale:** The whole point is a *caller-enforced shape the model can see*.
  With Option 1 the model sees only "an object" and must guess the contract from
  the prompt — defeating the purpose. With Option 2 the schema is in the tool
  spec the provider streams to the model, so the model is shaped toward the right
  fields *and* the kernel's own input validation at `agent.ts:314, 338` already
  coerces/validates those arguments against that schema before `respond.execute`
  even runs — i.e. the existing input path does the validation for free; the
  extension's job narrows to surfacing the value and driving the reask on the
  kernel's reported failure. **How the extension obtains the per-run schema:** it
  reads `e.agent.outputSchema` (D2). Registration is lazy and disposable: on
  `agent_start` (`agent.ts:156`) if `outputSchema` is set, `e.registerTool(...)`
  the `respond` tool and keep its `Disposable`; on `agent_end` (`agent.ts:235`)
  dispose it, so a `respond` tool never lingers across runs that don't want one
  (and `outputSchema` may differ run to run). **Rejected** Option 1 because a
  generic param hides the contract from the model and the provider, throwing away
  the kernel's free input-validation of schema-typed arguments.

### D4. Validate-and-reask bounded by `maxOutputRetries` (default 2), echoing the validator's exact per-field errors; after the cap, return last flagged

- **Problem:** A model may emit `respond` with arguments that miss the schema, or
  never call `respond` at all. How many corrective rounds, with what feedback,
  and what happens when they run out?
- **Options for the bound:** (a) unbounded retry until valid — risks an infinite
  loop against an obstinate model; (b) a fixed `maxOutputRetries` cap, after
  which the run ends with the best-effort value flagged.
- **Choice:** (b), default `maxOutputRetries = 2` (so: initial attempt + 2
  corrective reasks = up to 3 `respond` attempts).
- **Threshold rationale:** 2 mirrors the kernel's own "bounded safety on loop
  iterations" instinct (`maxTurns`, `agent.ts:44-45`). One reask catches the
  common case (a missing required field the model adds when told precisely which
  one); a second covers a follow-on miss; beyond that, further rounds rarely
  converge and just burn turns/tokens — the same diminishing-returns logic that
  bounds `maxTurns`. It is a single named constant, overridable later, not a
  magic literal.
- **Reask content:** on a failed `respond`, the kernel's input validation already
  produced the exact errors and returned them in the tool_result
  (`agent.ts:328`: `"Invalid arguments for respond:\n- " + errors.join(...)`),
  where each error is a `validate.ts` string such as
  `"$.age: expected integer, got \"old\""` (`validate.ts:53`) or
  `"$.name: required property missing"` (`validate.ts:96`). The extension's reask
  **steers** (`agent.ts:122`, `e.agent.handle.steer`) a terse instruction that
  re-states those *exact* per-field error strings and asks the model to call
  `respond` again with corrected fields — reusing `validate.ts`'s strings
  verbatim, never re-deriving them.
- **After the cap:** the extension sets `e.agent.output = { value: <last
  coerced/attempted value>, ok: false }` and then **explicitly halts the loop**
  by calling `e.agent.stop()` (`agent.ts:132`), which aborts the in-flight run;
  the loop's signal check (`agent.ts:169, 177`) lands `reason = "stop"` and
  breaks. This explicit halt is **load-bearing**: on an
  *invalid* `respond` the kernel refuses before `execute` (`agent.ts:327-329`)
  and returns a **non-terminating** error tool_result, so the loop would
  otherwise advance to the next turn and re-call the model (`agent.ts:162-227`),
  running all the way to `maxTurns` (default 24, `agent.ts:95`) — far past the
  cap. Naming `stop()` is what makes "exactly 3 `respond` attempts, then end" (AC6)
  achievable; without it nothing ends the run at the cap. The result is a *clear
  flagged result* (best-effort value + `ok:false`) rather than a hang, a thrown
  error, or a runaway loop. **Rejected** unbounded retry (a) because a model that
  structurally cannot satisfy the schema would loop forever; the cap + explicit
  `stop()` turns "never valid" into a deterministic, inspectable outcome.

### D5. Reuse the kernel `validate` — NO new validator, NO Zod

- **Problem:** What validates the output value?
- **Decision:** The existing kernel validator `validate(schema, input)`
  (`validate.ts:19`), the same function that validates tool **input** at
  `agent.ts:314, 338`. Because the `respond` tool's parameters *are* the schema
  (D3), the kernel's existing input-validation path validates the output for
  free; the extension only needs `validate` directly for the `/respond` command
  preview and the exported `validateOutput` test helper.
- **Rationale (non-behavioral / forced):** This is the one validator in the repo,
  it is dependency-free (CLAUDE.md: "Zero runtime dependencies except jiti"), and
  its coercion semantics (string→number, default-fill, unknown-prop passthrough;
  `validate.ts:26-28, 110-124, 91-93`) are *exactly* what we want output to share
  with input — same contract on both sides closes the asymmetry precisely.
  Introducing a second validator (Zod or hand-rolled) would add a dependency,
  diverge coercion behavior between input and output, and duplicate code. There is
  no real alternative consistent with the house rules; this decision is recorded
  for completeness, not because a competing option survives scrutiny.

### D6. Backward compatibility: no `outputSchema` ⇒ byte-identical to today; `respond` inert/unregistered

- **Problem:** The default (no caller opt-in) must not change any existing
  behavior, and the extension is a builtin loaded for every run.
- **Options:** (a) always register `respond` and treat output as optional;
  (b) register `respond` and run the reask loop **only** when
  `e.agent.outputSchema` is set; otherwise the extension is fully inert.
- **Choice:** (b).
- **Rationale:** With no `outputSchema`, the model must not see a phantom
  `respond` tool (it would change the tool list the provider receives at
  `agent.ts:256`, perturbing behavior and tokens) and no reask may fire. Gating
  every action — tool registration, the steer-nudge, the reask loop — on
  `outputSchema` being set means the extension contributes **zero** to a run that
  did not opt in: same tool list, same transcript, same `RunResult`, and
  `Agent.output` stays `undefined`. This is the `recovery`/`prune` posture (on by
  default, but a strict no-op until its trigger condition holds) plus the
  `bash-policy` no-op-default discipline. **Rejected** (a) because an
  always-present `respond` tool is an observable behavior change for the 100% of
  runs that never asked for typed output. AC8 pins this.

## 5. Dependencies and Assumptions

- **`validate(schema, input) → { ok, value, errors }`** (`src/kernel/validate.ts:19`)
  — the kernel validator/coercer, reused unchanged. Its error strings
  (`validate.ts:31, 49, 53, 66, 96`) are the literal text echoed in reasks.
  Assumed stable (a pinned kernel export, `kernel-surface.test.ts:36`).
- **Kernel input-validation path** at `agent.ts:314-341`: when the model calls
  `respond`, the kernel validates the arguments against the tool's parameters
  (the caller schema) and, on failure, returns `"Invalid arguments for respond:\n
  - …"` (`agent.ts:328`) as the tool_result the next turn sees. The extension
  *relies* on this: it does not re-validate to *block*, it reads the kernel's
  outcome and decides surface-vs-reask.
- **`ToolResult.terminate`** (`src/kernel/types.ts:134-138`; honored at
  `agent.ts:215`) — `respond` returns `terminate: true` on a **valid** call so the
  turn ends once the contract is satisfied. (On an *invalid* call the kernel's own
  input-validation refuses before `execute` runs, `agent.ts:327-329`, so the
  `terminate` is never reached on failure — the loop continues, and the reask
  steers the next turn.)
- **`steer(message)`** (`src/kernel/agent.ts:122`, exposed as
  `e.agent.handle.steer`, `agent.ts:116`) injects the reask before the next LLM
  call — the documented "controllable from the outside" seam (`agent.ts:6-8`).
- **`stop()`** (`src/kernel/agent.ts:132`, called directly on the running `Agent`,
  `e.agent`, `extension.ts:61`) — aborts the in-flight run so the loop's signal
  check (`agent.ts:169, 177`) sets `reason = "stop"` and breaks. This is the
  explicit halt the extension fires **after the cap** (D4): without it, a never-valid
  `respond` would advance the loop turn-by-turn to `maxTurns` (`agent.ts:95, 162`)
  because the kernel's invalid-arg refusal (`agent.ts:327-329`) is *non-terminating*.
- **Lifecycle events** `agent_start` (`agent.ts:156`) and `agent_end`
  (`agent.ts:235`) for lazy per-run registration/disposal of `respond` (D3), via
  `e.on(...)`.
- **`afterToolCall` filter** (`agent.ts:303`) — **this** is what drives the
  invalid-path reask/attempt-count/`stop()`, **not** `respond.execute`. On an
  *invalid* `respond` the kernel refuses at `agent.ts:327-329`: `executeGuarded`
  returns the `"Invalid arguments for respond"` error result before reaching the
  `tool.execute` call (`agent.ts:352`), so any reask logic placed in `execute`
  would never run on a schema miss. But `runOne` still applies `afterToolCall`
  (`agent.ts:303`) and emits `tool_end` (`agent.ts:304`) on that refused result —
  both fire on every dispatched call, valid or refused — so the extension wires
  the reask there: inspect the `result` for the kernel's `isError` "Invalid
  arguments for respond" signal, steer the reask, bump the attempt count, and
  `stop()` at the cap. `respond.execute` runs **only on a valid call** (it just
  records the value and returns `terminate:true`); it is never the seam for the
  failure path. Together with the `agent_start`/`agent_end` listeners (D3) for
  lazy registration, no new hook point is needed (`tool_end` is the equivalent
  observe-side alternative to the `afterToolCall` filter).
- **`ExtensionAPI`** surface used: `e.registerTool` (returns a `Disposable`,
  `extension.ts:44`), `e.registerCommand`, `e.on`, `e.agent` (the running `Agent`,
  `extension.ts:61`), and an env read. No `e.hook` block, no capability.
- **`defineTool`** (`src/kernel/define.ts:26`) to construct `respond`; its
  `parameters` accepts the caller's `JSONSchema` directly (`define.ts:14, 33`).
- **Test harness** `makeHarness` + `MockProvider` scripting (`test/helpers.ts:27`,
  `src/providers/mock.ts:20-31`): a `respond` call is scripted as a `MockToolCall`
  `{ name: "respond", arguments: {...} }`; the multi-turn reask sequence is an
  array/function responder (`mock.ts:33-36`).
- **No new npm dependency** (jiti-only rule upheld). Strict TS, `.js` specifiers.

## 6. Relationship with Existing Designs

First design for **typed final output** in EAgent — there is no prior
output-contract/`respond` extension (`src/extensions/` has none). Closest
existing code and how this relates:

- **`src/kernel/validate.ts`** (the validator) — *reused, not duplicated.* This
  design turns the input validator around onto output, closing the
  input-validated/output-unvalidated asymmetry. No conflict; no change to
  `validate.ts`.
- **`src/kernel/agent.ts`** — the run loop, `RunResult`, the input-validation at
  `:314-341`, the terminate path at `:215`, and `steer` at `:122` are all reused.
  The **only** kernel touch is the two optional `Agent` fields (D2); `run()` and
  `RunResult` are unchanged. Marked: minimal kernel-contract touch (Risk R1).
- **`src/kernel/define.ts`** — `defineTool` builds `respond`; its `terminate`
  flag (via the returned `ToolResult`) ends the turn on a valid contract.
- **`src/extensions/recovery.ts`** (`docs/design/2026-06-21-recovery-hooks.md`) —
  the closest *behavioral cousin* and a deliberate **dedup boundary.** `recovery`
  appends a *generic* corrective string to **failed tool results** via
  `afterToolCall`, keyed to error *signatures*, with no model contract. This
  extension validates the **final answer** against a *caller-declared schema*,
  reasks with *precise per-field* errors, and yields a *typed* `Agent.output`.
  They are complementary, not overlapping: `recovery` nudges any failed tool;
  `output-contract` governs the run's *result shape*. The validate-and-reask loop
  pairs naturally with `recovery`'s self-correct nudge — both teach the model to
  fix a mechanical miss — but they fire on different signals and never share
  state. No conflict.
- **`src/extensions/subagents.ts:227-235`** and
  **`src/extensions/dynamic-workflow.ts:449-481`** (`finalText` scraping) and
  **`src/server.ts:215-217`** (`done` with no result field) — the three places
  that today scrape free text. They are noted as **future consumers** of
  `Agent.output` (a machine-checkable contract replaces the JSON-parse gamble) but
  are **explicitly NOT wired here** (Scope Boundary). No conflict — until rewired,
  they are untouched and behave identically.
- **Posture precedent:** `docs/design/2026-06-20-prune.md` and the `recovery`
  design (on-by-default builtin + `EAGENT_*=off` kill switch + strict no-op until
  trigger) — followed for D6 and the kill switch.

No terminology conflict. Anchors: CLAUDE.md ("everything is an extension",
"capabilities are the security vocabulary", zero-deps-except-jiti).

## 7. Acceptance Criteria

All verified by `npm test` (offline) and `npm run typecheck`. Live criteria load
**only** `core-tools` (for a baseline tool list) + `output-contract` into the
harness so any `respond`/reask behavior is unambiguously this extension's. The
output schema used throughout is
`{ type:"object", properties:{ name:{type:"string"}, age:{type:"integer"} },
required:["name","age"] }`.

1. **Typecheck clean:** `npm run typecheck` exits 0 with the new files (strict TS,
   `noUncheckedIndexedAccess`, no `any`).
2. **Valid `respond` → typed output surfaced:** set `agent.outputSchema = <schema>`,
   script the mock to emit one `respond` call with `{name:"Ada", age:36}`. After
   `agent.run(...)`: `assert.deepEqual(agent.output, { value: { name:"Ada",
   age:36 }, ok:true })` and `RunResult.reason === "stop"` (terminate path,
   `agent.ts:215`).
3. **`respond` tool is registered with the caller schema:** during a run with
   `outputSchema` set, `agent.tools.get("respond")?.spec.parameters` deep-equals
   the supplied schema (asserts D3 dynamic registration), and after the run the
   tool is disposed: `agent.tools.get("respond") === undefined`.
4. **Invalid → reask with EXACT per-field error → then valid → success:** script
   turn 1 = `respond({name:"Ada"})` (missing `age`); turn 2 = `respond({name:"Ada",
   age:36})`. Assert the transcript contains a steered reask message whose text
   `assert.match`es the literal validator string `"$.age: required property
   missing"` (`validate.ts:96`); final `agent.output` is `{ value:{name:"Ada",
   age:36}, ok:true }`.
5. **Coercion parity with input:** script `respond({name:"Ada", age:"36"})` (string
   age). Because `validate` coerces (`validate.ts:110-116`), `agent.output.value`
   is `{ name:"Ada", age:36 }` (number) with `ok:true` — output coercion matches
   input coercion exactly.
6. **Never-valid → cap reached, flagged:** with `maxOutputRetries = 2`, script the
   mock to emit `respond({name:"Ada"})` (always missing `age`) on every turn.
   After the run: `agent.output.ok === false`, `agent.output.value` is the
   last attempted value `{ name:"Ada" }` (best-effort), and the number of
   `respond` attempts in the transcript is exactly 3 (initial + 2 reasks). The
   loop terminated rather than looping unbounded **because the extension called
   `e.agent.stop()` at the cap** (D4): `RunResult.reason === "stop"` *and* the run
   ended well short of `maxTurns` (≪ 24). Note the kernel does **not** self-terminate
   here — an invalid `respond` yields a non-terminating error tool_result
   (`agent.ts:327-329`), so without the explicit `stop()` the loop would run to
   `maxTurns` and the "exactly 3 attempts" assertion would fail.
7. **Kill switch:** with `EAGENT_OUTPUT_CONTRACT=off` and `outputSchema` set,
   `agent.tools.get("respond") === undefined` during the run, no reask is steered,
   and `agent.output === undefined`.
8. **Backward compatibility (no opt-in ⇒ byte-identical):** with the extension
   loaded but `outputSchema` **unset**, a scripted plain-text run produces a
   `RunResult` and transcript identical to the same run with the extension *not*
   loaded (assert equal `reason` and equal final assistant text via `lastText`),
   `agent.tools.get("respond") === undefined`, and `agent.output === undefined`.
9. **Kernel surface unchanged:** `test/kernel-surface.test.ts` stays green — the
   two new `Agent` fields are instance data, not barrel exports, so
   `Object.keys(kernel)` is unchanged (`kernel-surface.test.ts:49-57`) and the
   kernel stays under the 2200-line ceiling (`:59-68`).
10. **Clean teardown:** disposing `output-contract` removes its `agent_start`/
    `agent_end` listeners and any registered `respond` tool — a subsequent run
    with `outputSchema` set registers no `respond` and surfaces no `output`
    (asserts no listener/tool leak; teardown never throws).

No latency budget is declared: the only added per-run work is one `validate` call
per `respond` attempt (already on the kernel's input path) plus a bounded number
of string steers — off any hot loop.

## 8. Risks and Rollback

- **R1 — A minimal kernel field is still a kernel-contract touch.** Two optional
  `Agent` fields widen the kernel's most central class. *Mitigation:* the fields
  are **optional and additive** (default `undefined`); `run()` and `RunResult` are
  untouched; AC8 pins that an unset `outputSchema` leaves `run()` byte-identical,
  and AC9 keeps `kernel-surface.test.ts` green (no new barrel export, under the
  line ceiling). If even two fields are judged too much core surface at review,
  the fallback is to carry the schema/output via `e.store` (`extension.ts:57`)
  keyed by run — **zero** kernel change — at the cost of a clunkier caller API;
  the field approach is preferred for ergonomics but is not load-bearing to the
  mechanism.
- **R2 — The model may never call `respond`.** Without provider forcing (deferred,
  Section 3) the call is not guaranteed. *Mitigation:* the reask loop + the
  `maxOutputRetries` cap (D4) turn "never complies" into a deterministic flagged
  result (`output.ok === false`) rather than an infinite loop or a hang; AC6 pins
  the exact attempt count and the flag. A caller that needs a *hard* guarantee
  waits for the deferred provider-forcing follow-up.
- **R3 — `validate` coercion semantics on output.** Output is coerced exactly as
  input (string→number, default-fill, unknown-prop passthrough). *Mitigation:*
  this is the **intended** symmetry (D5) — same contract both sides — and AC5
  pins it; there is no second, divergent validator to reconcile.
- **R4 — A phantom `respond` perturbing opt-out runs.** *Mitigation:* D6 gates all
  registration on `outputSchema`; AC8 pins byte-identical opt-out behavior.
- **Rollback / kill switch:** `EAGENT_OUTPUT_CONTRACT=off` disables the extension
  with no code change (AC7). Removing the one line from `BUILTIN_EXTENSIONS`
  (`src/host.ts`) and reverting the CLAUDE.md inventory line fully removes it; the
  extension holds no persisted state, and the two optional `Agent` fields are inert
  when never set (and removable in a follow-up if the `e.store` fallback is taken).
