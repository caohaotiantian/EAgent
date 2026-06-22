# Implementation: `output-contract` extension — schema-validated final output via a `respond` tool + validate-and-reask

Status: open
Closing-commit: TBD
Closed-on: TBD
Deferred: provider-side decode-time forcing (`toolChoice`/`responseFormat`) — see design §3 Scope Boundary; out of scope here.

Slug: `2026-06-22-output-contract`
Design: `docs/design/2026-06-22-output-contract.md` (PASSED)

This guide takes a fresh agent from a green tree to a closed feature in TDD order.
It introduces **no requirement absent from the design**; every task traces to a
design Deliverable (design §2, lines 55–100) and an Acceptance Criterion
(design §7, lines 404–464). Where the design and this guide disagree, the design
wins — re-read it first.

---

## 1. Task Index

Maps design **Deliverables** (§2) and **Acceptance Criteria** (§7, AC1–AC10) to
the phase tasks below. Single Phase (P1); the task numbers are the `P1.N` IDs in §2.

| Design Deliverable (§2) | Design AC (§7) | Phase task |
| --- | --- | --- |
| Minimal kernel surface: two optional `Agent` fields `outputSchema?: JSONSchema`, `output?: { value: unknown; ok: boolean }` (design §2 line 77–81; D2 line 168–195) | AC8 (line 448), AC9 (line 453) | P1.3 (test), P1.5 (impl) |
| `src/extensions/output-contract.ts` — lazy `respond` registration, steer-nudge, `afterToolCall`-driven validate-and-reask, cap + `stop()`, exported `buildReask`/`validateOutput`, kill switch, no capability (design §2 line 55–76; D1/D3/D4/D5/D6) | AC2–AC8, AC10 | P1.2 (unit test), P1.4 (live test), P1.6 (impl) |
| `test/output-contract.test.ts` — offline `node:test` via `makeHarness` + scripted `MockProvider` (design §2 line 82–88) | all | P1.2, P1.4 |
| `output-contract` registered in `BUILTIN_EXTENSIONS` (design §2 line 89; `src/host.ts:72-113`) | AC8 baseline (extension loaded) | P1.7 (impl) |
| `/respond` (or `/output`) read-only introspection command (design §2 line 90–92) | — (read-only; no dedicated AC, exercised incidentally) | P1.6 (impl, in the extension) |
| `EAGENT_OUTPUT_CONTRACT=off` kill switch (design §2 line 93) | AC7 (line 445) | P1.4 (test), P1.6 (impl) |
| CLAUDE.md inventory entry + README count bump 40→41 (design §2 line 94–100) | — (doc; reconciled at closeout) | P1.8 (impl) |
| Kernel surface / line-ceiling unchanged (design §2 line 77–81; D2) | AC9 (line 453) | guaranteed by P1.5 (regression, no new barrel export) |
| Typecheck clean (strict TS, no `any`, `noUncheckedIndexedAccess`) | AC1 (line 413) | every impl task; gate at exit |

The output schema used **throughout the live tests** (design §7 line 409–411) is the
single fixture:

```ts
const SCHEMA: JSONSchema = {
  type: "object",
  properties: { name: { type: "string" }, age: { type: "integer" } },
  required: ["name", "age"],
};
```

Declare it as a plain `JSONSchema`-typed literal (`import type { JSONSchema } from
"../src/kernel/types.js"`) — **not** `as const`. Under strict TS, `as const` makes
`required` a `readonly ["name","age"]` tuple and the property `type`s deeply-readonly,
which is **not** assignable to `JSONSchema` (`required?: string[]`,
`src/kernel/types.ts:110-119`) — so `agent.outputSchema = SCHEMA` and
`defineTool({ parameters: SCHEMA })` would fail typecheck (`TS2322`, breaking AC1).
A plain typed literal matches the existing convention (`test/agent.test.ts:19`).

---

## 2. Phase Breakdown

This feature is one kernel touch (two optional fields), one extension file, one
test file, one host-registration line, and two doc lines (CLAUDE.md + README). It
is the smallest independently-committable unit that leaves `npm test` green and
maps to the entire Deliverables block. Per the granularity rule it is a **single
Phase** — the kernel-field change and the extension are not genuinely separable
(the extension is dead without the fields, and the fields are inert without the
extension; AC8 even pins that the fields default to `undefined` so the extension
is the only thing that exercises them). Tasks within the Phase are ordered so the
kernel fields land before the extension that reads/writes them.

### Phase 1 — kernel fields + `output-contract` extension (single Phase)

**Entry condition:** L1 design `docs/design/2026-06-22-output-contract.md` is
PASSED (it is). On the current tree, before any change, both gates are green:

```bash
npm run typecheck    # exit 0
npm test             # exit 0
```

Confirm the live baseline the design relies on (design §2 line 96–99): `src/host.ts`
`BUILTIN_EXTENSIONS` (`:73-112`) has **40** entries and `README.md:333` reads "40
built-in extensions"; the kernel is **1762** lines (≈438 headroom under the 2200
ceiling, design D2 line 192–193). Count the tuples precisely with

```bash
awk '/BUILTIN_EXTENSIONS: \[/{f=1} f&&/^\];/{f=0} f&&/^  \["/{c++} END{print c}' src/host.ts   # 40
```

— **not** `grep -c '\["' src/host.ts`, which returns **42** because it also matches
`PROVIDER_NAMES` (`:116`) and the `grant: [...]` array (`:175`); that proxy never
equals the tuple count. If any of these has drifted, reconcile the count math
before starting — the design's "40 → 41" and "under the ceiling" claims must hold.

**Design references:**
- Deliverables: design §2, lines 55–100.
- Key Design Decisions: D1 (line 142), D2 (line 168), D3 (line 197), D4 (line 225),
  D5 (line 268), D6 (line 287).
- Dependencies/Assumptions: design §5, lines 307–361.
- Acceptance Criteria: design §7, lines 404–464.
- Risks: design §8, lines 466–494.

Verified kernel/source anchors this Phase wires into (read each before coding):
- `RunResult = { reason, messages }` and `Agent.run()` — `src/kernel/agent.ts:54-57`,
  `:146-239`. Untouched in signature/shape (design §3 line 121–124, D2).
- `Agent` class fields block — `src/kernel/agent.ts:62-96`. The two optional fields
  are added here as instance data (NOT to the kernel barrel `src/kernel/index.js`).
- `agent_start` emit — `src/kernel/agent.ts:156`; `agent_end` emit — `:235`. Lazy
  per-run `respond` registration/disposal hangs off these (D3 line 218–221).
- Input-validation path — `src/kernel/agent.ts:308-353`. On a schema miss the kernel
  returns `"Invalid arguments for ${call.name}:\n- ${errors.join("\n- ")}"`
  (`:328`) **before** `tool.execute` (`:352`) — so the reask path **cannot** live
  in `respond.execute` (design §2 line 60–66, §5 line 337–351).
- `afterToolCall` filter + `tool_end` emit — `src/kernel/agent.ts:303-304`. Both fire
  on every dispatched call, valid or refused — this is the reask seam (design §5
  line 337–351).
- `steer(message)` — `src/kernel/agent.ts:122-124` (via `e.agent.handle.steer`,
  `:116`). `stop()` — `src/kernel/agent.ts:132-134` (call `e.agent.stop()` directly).
- Validator + its literal error strings — `src/kernel/validate.ts:19` (`validate`),
  required-missing string at `:96` (`"$.name: required property missing"`),
  integer/number string at `:49`/`:53`, string-→number coercion at `:110-116`.
- `defineTool` — `src/kernel/define.ts:26` (its `parameters` accepts a `JSONSchema`
  directly, `:33`).
- `ExtensionAPI` — `src/kernel/extension.ts:41-62`: `registerTool` (returns a
  `Disposable`, `:44`), `registerCommand` (`:46`), `on` (`:48`), `agent` (the
  running `Agent`, `:61`), `store` (`:58`). The host auto-tracks every registration
  for clean reload (`extension.ts:228-236`).
- `ToolResult.terminate` — `src/kernel/types.ts:134-138`, honored at
  `src/kernel/agent.ts:215` (`results.every((r) => r.result.terminate)` ⇒ `reason="stop"`).
- Harness — `test/helpers.ts:27` (`makeHarness`), `:47` (`lastText`); host `use`
  (`extension.ts:120`) / `unload` (`extension.ts:182`).
- Mock scripting — `src/providers/mock.ts:20-36` (`MockToolCall`/`MockTurn`/`MockResponder`;
  array = sequential turns, function = `(req, turnIndex) => MockTurn`).

#### Task list, in TDD order

Every TEST task names the **business invariant** it protects and **precedes** the
impl task it protects. The unit tests (P1.2) need exported pure helpers; those
helpers are implemented in P1.6, but the *tests are written first* and fail to
compile/run until P1.6 lands — that is the intended red state. Group the kernel
field change (P1.5) and the extension (P1.6) so the test file (P1.2/P1.4) goes red
first, then green.

---

**P1.1 (test) — Pin the green baseline.** Before editing, run `npm test` and
`npm run typecheck`; both must be 0. Capture the current `npm test` tail (the
`ok N` count) so you can confirm later that every prior test stayed green and only
new ones were added. No file change. *Invariant: the tree is green before we start;
any later red is ours.*

**P1.2 (test) — Unit tests for the exported pure helpers (`validateOutput`, `buildReask`).**
Create `test/output-contract.test.ts`. Import `validateOutput` and `buildReask`
from `../src/extensions/output-contract.js` and (for later) the harness from
`./helpers.js`. Write these **first** (they protect the validation/reask contract
independent of the agent loop, mirroring design D5 line 268 and the D4 reask-content
rule line 242–251):

- **`validateOutput` — valid passes (design D5, AC2 shape).** With `SCHEMA`,
  `validateOutput(SCHEMA, { name: "Ada", age: 36 })` returns `{ ok: true, value: { name: "Ada", age: 36 } }`.
  *Invariant: a conforming arg-object validates and surfaces the coerced typed value.*
- **`validateOutput` — coercion parity with input (design AC5, line 432).**
  `validateOutput(SCHEMA, { name: "Ada", age: "36" }).value` deep-equals
  `{ name: "Ada", age: 36 }` (number, not string) with `ok: true`. *Invariant:
  output coercion is byte-for-byte the input coercion (`validate.ts:110-116`) — one
  validator, one contract on both sides.*
- **`validateOutput` — invalid yields the EXACT per-field error (design D4, AC4).**
  `validateOutput(SCHEMA, { name: "Ada" })` returns `ok: false` and an `errors`
  array containing the literal string `"$.age: required property missing"`
  (`validate.ts:96`). Assert with `assert.ok(errors.includes("$.age: required property missing"))`.
  *Invariant: validation failures expose the validator's verbatim per-field strings —
  never a re-derived or paraphrased message.*
- **`buildReask` — the reask text carries the exact validator strings verbatim
  (design D4, line 242–251).** Given the errors from the invalid case above,
  `buildReask([...errors])` returns a string that `assert.match`es
  `/\$\.age: required property missing/` and instructs the model to call `respond`
  again. *Invariant: the corrective reask re-states the validator's exact strings;
  it does not invent its own wording for the per-field error.*

> Note (design §5 line 337–351): `validateOutput` is a thin wrapper over the kernel
> `validate` (`validate.ts:19`), exported only as the test/`/respond`-preview seam.
> The live path does NOT call it to *block* — the kernel's own input validation
> (`agent.ts:314,328`) already validates `respond` arguments; the extension reads
> that outcome. Keeping `validateOutput` a pure re-export-shaped helper (no new
> validation logic, design §3 line 125–127) is what keeps the coercion identical.

**Acceptance for P1.2** (red until P1.6 lands, then green):
```bash
node --import tsx --test test/output-contract.test.ts
```

**P1.3 (test) — Kernel-surface regression guard stays green.** Add no new test
here; instead, *note* that `test/kernel-surface.test.ts` is the guard for the
kernel-field change (AC9, design line 453). The two new `Agent` fields are
**instance data, not barrel exports**, so `Object.keys(kernel)` (`kernel-surface.test.ts:49-57`)
and the 2200-line ceiling (`:59-68`) must both stay green. This task is a checklist
item, executed by running:
```bash
node --import tsx --test test/kernel-surface.test.ts
```
*Invariant (AC9): adding output-contract grows zero kernel public surface and stays
under the line ceiling — the minimalism guard is untouched.*

**P1.4 (test) — Live agent-loop tests via `makeHarness` + scripted `MockProvider`.**
In the same `test/output-contract.test.ts`, write the live cases. Load **only**
`core-tools` (baseline tool list) **and** `output-contract` via `h.host.use(...)`
(design §7 line 407–408 — so any `respond`/reask is unambiguously this extension's).
Set `h.agent.outputSchema = SCHEMA` before `h.agent.run(...)` except where noted.
Script turns as `MockTurn[]` (sequential) or a `(req, turnIndex) => MockTurn`
function (`mock.ts:33-36`); a `respond` call is `{ toolCalls: [{ name: "respond", arguments: {...} }] }`.

- **(a) Valid `respond` → typed output surfaced + turn ends (design AC2 line 415,
  AC3 line 420).** Script one turn: `respond({ name: "Ada", age: 36 })`. After
  `run`: `assert.deepEqual(agent.output, { value: { name: "Ada", age: 36 }, ok: true })`
  and `result.reason === "stop"` (terminate path, `agent.ts:215`). Also assert that
  **during** the run `agent.tools.get("respond")?.spec.parameters` deep-equals
  `SCHEMA` (AC3 — D3 dynamic registration; capture it from inside a scripted turn
  or via a `tool_start`/`agent_start` listener) and that **after** the run
  `agent.tools.get("respond") === undefined` (AC3 disposal on `agent_end`).
  *Invariant: a valid `respond` surfaces the validated typed object as the run
  output AND ends the turn; the `respond` tool's parameters ARE the caller schema
  and it is disposed after the run.*
- **(b) Invalid → reask with the EXACT per-field error → then valid → success
  (design AC4 line 426).** Script turn 1 = `respond({ name: "Ada" })` (missing
  `age`); turn 2 = `respond({ name: "Ada", age: 36 })`. Assert the transcript
  contains a steered reask message whose text `assert.match`es the literal
  `/\$\.age: required property missing/` (`validate.ts:96`), and final
  `agent.output` deep-equals `{ value: { name: "Ada", age: 36 }, ok: true }`.
  *Invariant: an invalid `respond` triggers a reask carrying the validator's exact
  per-field error string, and a corrected retry succeeds.*
- **(c) Coercion parity (design AC5 line 432).** Script `respond({ name: "Ada", age: "36" })`
  (string age). Assert `agent.output.value` deep-equals `{ name: "Ada", age: 36 }`
  (number) with `ok: true`. *Invariant: output coercion matches input coercion
  exactly — the same `validate` on both sides.*
- **(d) Never-valid → cap reached, flagged, no infinite loop (design AC6 line 434).**
  With the extension's `maxOutputRetries = 2`, script the mock to emit
  `respond({ name: "Ada" })` (always missing `age`) on **every** turn (use the
  function responder so it never runs out). After `run`:
  `agent.output.ok === false`; `agent.output.value` is the last attempted value
  `{ name: "Ada" }` (best-effort); the number of `respond` attempts in the
  transcript is **exactly 3** (initial + 2 reasks); `result.reason === "stop"`; and
  the run ended well short of `maxTurns` (assert a concrete ceiling: the turn count
  is `≤ 4` — one turn per `respond` attempt plus the cap-halt turn — i.e. far below
  the `maxTurns` default of 24; pick the exact bound from your scripted turn count,
  but it must be a fixed mechanical number, not `≪ 24`). *Invariant: a model that can never satisfy the schema yields a
  deterministic flagged result after exactly the cap, because the extension calls
  `e.agent.stop()` at the cap (design D4 line 252–266) — NOT an unbounded loop and
  NOT a run to `maxTurns`.*
- **(e) Kill switch (design AC7 line 445).** Set `process.env.EAGENT_OUTPUT_CONTRACT = "off"`
  before `h.host.use("output-contract", ...)` (restore in `finally`), set
  `agent.outputSchema = SCHEMA`, script a `respond` call. Assert: during the run
  `agent.tools.get("respond") === undefined`, no reask is steered, and
  `agent.output === undefined`. *Invariant: the env kill switch makes the extension
  fully inert even with a schema set.*
- **(f) Backward-compat: no schema set ⇒ byte-identical to today (design AC8 line 448).**
  Load the extension but leave `outputSchema` **unset**. Run a scripted plain-text
  turn. Assert the `RunResult.reason` and final assistant text (via `lastText`,
  `helpers.ts:47`) equal those of the *same* run with the extension **not** loaded
  (build a second bare harness with only `core-tools`); assert
  `agent.tools.get("respond") === undefined` throughout and `agent.output === undefined`.
  *Invariant: a run that did not opt in sees no phantom `respond` tool, no reask,
  and an unchanged `RunResult` — the extension contributes zero (design D6).*
- **(g) Clean teardown / no leak (design AC10 line 457).** Load `output-contract`,
  then `await h.host.unload("output-contract")`. Set `outputSchema = SCHEMA`, run a
  scripted `respond` turn. Assert no `respond` tool is registered during the run and
  `agent.output === undefined` (the `agent_start`/`agent_end` listeners and any
  `respond` registration were removed). The unload/dispose must not throw.
  *Invariant: disposing the extension removes every listener and registration — no
  cross-run leak; teardown never throws.*

**Acceptance for P1.4** (red until P1.6/P1.5 land, then green):
```bash
node --import tsx --test test/output-contract.test.ts
```

**P1.5 (impl) — Add the two optional `Agent` fields (the minimal kernel surface).**
In `src/kernel/agent.ts`, inside the `Agent` class field block (`:62-96`, after the
existing public fields such as `maxTurns`), add **exactly** (design §2 line 77–81, D2):
```ts
/** Caller-set before run(): if present, output-contract registers a respond tool whose parameters are this schema. */
outputSchema?: JSONSchema;
/** Caller-read after run(): the validated final output (ok) or best-effort value (ok:false). undefined when no schema was set. */
output?: { value: unknown; ok: boolean };
```
Import `JSONSchema` from `./types.js` if not already imported (`.js` specifier,
house rule). Do **not** touch `run()`'s signature, `RunResult` (`:54-57`), or the
kernel barrel `src/kernel/index.ts` — these fields are instance data only. Do not
initialize them in the constructor; `undefined` is the backward-compat default
(D6, AC8). *Protects: AC8, AC9, and is the surface P1.6 reads/writes.*

**Acceptance for P1.5:**
```bash
npm run typecheck                                   # exit 0
node --import tsx --test test/kernel-surface.test.ts   # AC9: still green, no new export, under ceiling
```

**P1.6 (impl) — Create `src/extensions/output-contract.ts`.** Implement the
extension exactly per design §2 line 55–76, D3 (line 197), D4 (line 225), D6 (line 287),
and §5 (line 307–361). Concretely:

- **Constant:** `const maxOutputRetries = 2` (design D4 line 233 — single named
  constant, not a magic literal).
- **Exported pure helpers** (the P1.2 seams; no new behavior, design §3 line 125–127):
  - `export function validateOutput(schema: JSONSchema, value: unknown): { ok: boolean; value: unknown; errors: string[] }`
    — thin wrapper returning the kernel `validate(schema, value)` (`validate.ts:19`)
    result. Used by the `/respond` preview and the unit tests; the live path relies
    on the kernel's own input validation, not this.
  - `export function buildReask(errors: string[]): string` — builds the terse
    corrective instruction that **re-states the exact validator strings verbatim**
    (`errors.join("\n- ")`, design D4 line 242–251) and asks the model to call
    `respond` again with corrected fields. Never re-derive error text.
- **`export default function activate(e: ExtensionAPI): () => void`:**
  - If `process.env.EAGENT_OUTPUT_CONTRACT === "off"`, return a no-op teardown
    immediately (kill switch, AC7).
  - Per-run state: an `attempts` counter (number of `respond` calls seen this run)
    and a handle on the live `respond` registration `Disposable`. Reset on each
    `agent_start`.
  - On `agent_start` (`e.on("agent_start", ...)`, `agent.ts:156`): if
    `e.agent.outputSchema` is set, lazily `e.registerTool(...)` a `respond` tool
    built with `defineTool` (`define.ts:26`) whose `parameters` **are**
    `e.agent.outputSchema` (D3); keep its `Disposable`. Reset `attempts = 0`.
    Optionally steer a one-line system nudge toward `respond` on the first turn
    (design §2 line 57–59 — gate it on `outputSchema` being set). If `outputSchema`
    is unset, do nothing (D6, AC8).
  - `respond.execute(args)`: this runs **only on a valid call** (the kernel's input
    validation passed, `agent.ts:314,338`). Write
    `e.agent.output = { value: args, ok: true }` and return `{ content: "...", terminate: true }`
    so the turn ends (`agent.ts:215`). No capability — recording a value is not a
    side effect (design §2 line 76, §3 line 136–138).
  - On `afterToolCall` (`e.hook("afterToolCall", (result, { call }) => result)`,
    `agent.ts:303`) — **this is the reask seam, NOT `execute`** (design §5 line 337–351,
    §2 line 60–66): only act when `call.name === "respond"` and the result is the
    kernel's invalid-arg refusal (`result.isError` and `result.content` starts with
    `"Invalid arguments for respond"`, `agent.ts:328`). On that signal:
    - `attempts += 1`.
    - If `attempts <= maxOutputRetries`: extract the per-field error lines from
      `result.content` (the kernel already formatted them with `\n- `), call
      `e.agent.handle.steer(...)` with the reask (design D4 line 248–251) to inject
      it before the next LLM call (`agent.ts:122`), then return `result` unchanged.
      Note: `steer` takes a `Message` (`types.ts:245`,
      `AgentHandle.steer(message: Message)`), but `buildReask` returns a `string`
      (P1.6 below) — wrap it: `e.agent.handle.steer(text("user", buildReask(errors)))`,
      using the kernel `text(role, body)` helper (`src/kernel/types.ts:87`, already
      the steer idiom in `compact`/`drift-probe`/`memory`). A bare string will not
      typecheck.
    - If `attempts > maxOutputRetries` (cap reached): set
      `e.agent.output = { value: <last attempted args from call.arguments>, ok: false }`
      and call `e.agent.stop()` (`agent.ts:132`) to halt the loop — **load-bearing**:
      the invalid-arg refusal is non-terminating, so without `stop()` the run would
      advance to `maxTurns` (design D4 line 252–266, AC6). Return `result` unchanged.
    - Count carefully so the transcript shows **exactly 3 `respond` attempts** when
      never-valid (initial attempt counts as `attempts=1`; reasks fire at 1 and 2;
      cap halt fires at the 3rd attempt — match AC6's "initial + 2 reasks").
  - On `agent_end` (`e.on("agent_end", ...)`, `agent.ts:235`): dispose the `respond`
    registration so it never lingers across runs (D3 line 218–221).
  - **`/respond` (or `/output`) command** (`e.registerCommand`, design §2 line 90–92):
    read-only; prints the active `e.agent.outputSchema` (if any) and the last
    `e.agent.output`. No state change. Use `validateOutput` only for a preview if
    desired.
  - **Teardown:** return a function that disposes every tracked `Disposable`
    (`agent_start`/`agent_end`/`afterToolCall`/command registrations, plus any live
    `respond` registration) inside a throw-guarded `try/catch` so teardown never
    throws (house rule; AC10). The host also auto-tracks registrations
    (`extension.ts:228-236`), but dispose explicitly for the listeners you hold.

House rules in force here: `.js` import specifiers even for `.ts`
(`import { defineTool } from "../kernel/define.js"`, `import { validate } from "../kernel/validate.js"`,
`import { text } from "../kernel/types.js"` (value import — the steer-message helper),
`import type { ExtensionAPI } from "../kernel/extension.js"`, `import type { JSONSchema, Message, ToolResult } from "../kernel/types.js"`);
strict TS, no `any`, model the `output`/`respond`-arg types; zero new deps; pure
Node.

**Acceptance for P1.6:**
```bash
node --import tsx --test test/output-contract.test.ts   # P1.2 + P1.4 now green
npm run typecheck                                        # exit 0
```

**P1.7 (impl) — Register in `BUILTIN_EXTENSIONS`.** In `src/host.ts`: add
`import outputContract from "./extensions/output-contract.js";` alongside the other
extension imports (`:29-68`), and add the tuple `["output-contract", outputContract]`
to the `BUILTIN_EXTENSIONS` array (`:73-112`). Position is not load-bearing (order
only matters for id-collision precedence, irrelevant here); place it adjacent to
the other reliability/result extensions (e.g. near `recovery`/`prune`) or at the
end of the list. This takes the tuple count from **40 → 41** (design §2 line 96–99).
Count tuples precisely (the awk one-liner in the acceptance block) — do **not** use
`grep -c '\["'`, which over-counts by also matching `PROVIDER_NAMES` (`:116`) and the
`grant: [...]` array (`:175`). Mirror the existing single-default-import style.

**Acceptance for P1.7:**
```bash
# Precise count of BUILTIN_EXTENSIONS tuples (NOT `grep -c '\["'`, which also
# matches PROVIDER_NAMES at :116 and the `grant: [...]` array at :175):
awk '/BUILTIN_EXTENSIONS: \[/{f=1} f&&/^\];/{f=0} f&&/^  \["/{c++} END{print c}' src/host.ts   # expect 41 (was 40)
npm run typecheck                          # exit 0
node --import tsx --test test/host.test.ts # builtin registration still green
```

**P1.8 (impl) — Reconcile the inventory at closeout (CLAUDE.md + README).**
- **CLAUDE.md:** add a one-line `output-contract` entry to the extension inventory
  bullet under "Where things live" (design §2 line 94–95), in the same terse style
  as the `recovery`/`prune`/`todo` entries: name it; say it registers a schema-typed
  `respond` tool (per-run, parameters = the caller's `outputSchema`) and drives
  validate-and-reask on `afterToolCall`, surfacing the validated final output on
  `Agent.output`; note "no capability" and `EAGENT_OUTPUT_CONTRACT=off`.
- **README.md:333** — bump the literal "40 built-in extensions" to "41 built-in
  extensions" (design §2 line 98–100 — a **required** touch, not conditional).
- `docs/EXTENSIONS.md` is **NOT** touched (design §2 line 102–105 — it is the
  author's guide, not a per-extension catalog).
- At closeout, fill this doc's and the design's `Closing-commit`/`Closed-on` and
  flip both `Status:` to `closed`.

**Acceptance for P1.8:**
```bash
grep -n "output-contract" CLAUDE.md        # one new inventory line
grep -n "built-in extension" README.md     # README:333 reads "41 built-in extensions"
```

#### Phase exit condition

All of the following hold from repo root:

```bash
node --import tsx --test test/output-contract.test.ts   # exit 0 — AC2–AC8, AC10
node --import tsx --test test/agent.test.ts              # exit 0 — unchanged (regression)
node --import tsx --test test/kernel-surface.test.ts     # exit 0 — AC9 (no new export, under ceiling)
npm run typecheck                                        # exit 0 — AC1
npm test                                                 # exit 0 — whole suite, esp. all provider tests unchanged
```

The single canonical Phase gate is **`npm test` exit 0 AND `npm run typecheck`
exit 0**, with `BUILTIN_EXTENSIONS` containing `output-contract` (count 41),
CLAUDE.md inventory updated, and `README.md` count bumped to 41. No design
requirement remains unimplemented; no requirement absent from the design was added.

---

## 3. Engineering Constraints Index

- **House conventions (CLAUDE.md "House conventions"):**
  - **ESM + NodeNext** — always use `.js` import specifiers even when importing a
    `.ts` file (`import { defineTool } from "../kernel/define.js"`). Required by
    `module: NodeNext` + `verbatimModuleSyntax`.
  - **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`,
    `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. No `any` — model the
    `output` and `respond`-argument types.
  - **Zero runtime dependencies except `jiti`** — pure Node only; the validator is
    `src/kernel/validate.ts`, reused unchanged (design D5). No Zod, no second
    validator, no SDK.
  - **Tests are `node:test` via `tsx`, fully offline** — drive everything through
    `MockProvider` (`src/providers/mock.ts`) and `makeHarness` (`test/helpers.ts:27`).
    No network, no `ANTHROPIC_API_KEY`.
  - **Capabilities are the security vocabulary** — `output-contract` declares and
    requires **none** (recording a value is not a side effect; mirrors `recovery`,
    design §2 line 76, §3 line 136–138).
  - **Kill switch** — `EAGENT_OUTPUT_CONTRACT=off` returns a no-op teardown (the
    `recovery`/`prune` posture: on-by-default builtin, strict no-op until trigger).
  - **Teardown never throws** — dispose every tracked `Disposable` inside a
    throw-guarded `try/catch` (the `todo`/`integrity`/`recovery` teardown idiom).
  - **Extension registration** — register through the `ExtensionAPI` (`e.registerTool`,
    `e.registerCommand`, `e.on`); the host auto-tracks for clean reload
    (`extension.ts:228-236`).
- **Minimalism guard** — the only kernel change is two optional `Agent` instance
  fields (design D2). Do **not** add a kernel barrel export, do **not** change
  `run()`/`RunResult`. `test/kernel-surface.test.ts` (export list + 2200-line
  ceiling) must stay green (AC9).
- **Hook surface (use these, no new hook point):** events via `e.on` —
  `agent_start`, `agent_end`, `tool_end{call,result}`; filters via `e.hook` —
  `afterToolCall{ToolResult,{call}}`. `e.agent` exposes the running `Agent`
  (`outputSchema`, `output`, `tools`, `handle.steer`, `stop()`); `e.agent.handle.steer`
  injects the reask — it takes a `Message` (`types.ts:245`), so wrap the
  `buildReask(errors)` string with `text("user", ...)` (`types.ts:87`);
  `e.agent.stop()` halts at the cap. (`tool_end` is the
  observe-side equivalent to `afterToolCall`; the design picks `afterToolCall`,
  §5 line 337–351.)
- **Commit conventions (SKILL.md):** `feat(phase1):` for the Phase opener,
  `fix(phase1-roundR): <keyword>` for within-round fixes. Add `npm test` and
  `npm run typecheck` results as commit trailers. **No mention of AI/model/tooling**
  in commit messages. Per the repo's commit footer rule, end the commit message
  with the `Claude-Session:` trailer.

---

## 4. Data / Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness` (`:27`), `silentLogger`, `autoUI`,
  and `lastText` (`:47`, used by AC8/the backward-compat assertion). No new harness.
- **Reuse `MockProvider` scripting** (`src/providers/mock.ts:20-36`): a `respond`
  call is a `MockToolCall` `{ name: "respond", arguments: {...} }`; multi-turn reask
  sequences are a `MockTurn[]` (sequential) or a `(req, turnIndex) => MockTurn`
  function (use the function for the never-valid AC6 case so it never exhausts).
- **The single output-schema fixture** (design §7 line 409–411) declared inline in
  the test file (the `SCHEMA` constant above). No committed fixture file.
- **Env var** — the kill-switch test sets/reads `process.env.EAGENT_OUTPUT_CONTRACT`;
  set it **before** `h.host.use("output-contract", ...)` and restore it in a
  `finally`.
- **No network, no API key** — offline rule upheld. No temp files are needed (unlike
  `recovery`, this extension has no filesystem side effect; load only `core-tools`
  for the baseline tool list per design §7 line 407–408).

---

## 5. Regression Protection

These prior suites **must stay green** (run the whole `npm test`; these are the ones
to watch):

- **`test/agent.test.ts`** — the run loop, `RunResult`, terminate path, `steer`,
  `stop`, the input-validation path the extension relies on. The two new optional
  `Agent` fields default to `undefined`, and AC8 pins that an unset `outputSchema`
  leaves `run()` byte-identical, so this suite must not change. (Required by the
  IMPL spec: `agent.test.ts` stays green.)
- **`test/kernel-surface.test.ts`** — AC9: the new fields are instance data, not
  barrel exports, so `Object.keys(kernel)` is unchanged and the kernel stays under
  the 2200-line ceiling (≈1762 + a handful of lines). (Required by the IMPL spec.)
- **All provider tests** — `test/anthropic.test.ts`, `test/openai.test.ts`,
  `test/gemini.test.ts`, `test/mock.test.ts` (and `cassette`/`http` if present):
  unchanged — there is **no** provider-interface change (design §3 line 109–120;
  decode-time forcing is deferred). (Required by the IMPL spec: all provider tests
  unchanged.)
- **`test/host.test.ts`** — builtin registration: adding `output-contract` to
  `BUILTIN_EXTENSIONS` (count 40 → 41) must not break host wiring or load order;
  any assertion that counts builtins, if present, is the one interaction to
  reconcile (update the count deliberately).
- **`test/validate.test.ts`** — the validator is reused unchanged (design D5);
  this suite must stay green and is the source of truth for the literal error
  strings (`"$.age: required property missing"`) the live reask asserts.

Because the extension is a strict no-op unless `outputSchema` is set (design D6,
AC8) and adds no capability and no provider change, no existing test that runs
without `outputSchema` can change behavior. The only legitimate reconciliations
are (a) a builtin-count assertion in `host.test.ts`, and (b) the doc-count strings
(CLAUDE.md / README) — both intended by this Phase. Any other red is a real
interaction to investigate; run `npm test` and read the first failure.
