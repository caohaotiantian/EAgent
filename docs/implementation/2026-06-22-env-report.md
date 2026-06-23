# Implementation: `env-report` — classify environmental failures and suppress the retry-nudge

Status: closed
Closing-commit: 34afd8f
Closed-on: 2026-06-22
Deferred: none
Design: `docs/design/2026-06-22-env-report.md` (PASSED)
Slug: `2026-06-22-env-report`
Mode: **batch** — see Engineering Constraints §3 (do NOT touch `host.ts` / `CLAUDE.md` / `README.md`).

This guide drives a fresh agent through **test-driven** development of the
`env-report` extension. Read the design first (`docs/design/2026-06-22-env-report.md`);
this document introduces **no requirement absent from it**. Every task below traces
to a design Deliverable (§2) or Acceptance Criterion (§7), cited inline.

The closest sibling is `recovery` (`src/extensions/recovery.ts`,
`test/recovery.test.ts`) — env-report is its deliberate inverse on the same
`afterToolCall` hook and reuses its **pure-helper test seam**, its
**no-op-disposer kill switch**, and its **never-throw dispose loop**. Read both
before starting.

---

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7, AC1–AC12) to a
phase task. All tasks are in the single phase (§2 below); there is no second
phase — the work is one extension file + its offline test, not separable.

| Design item | Where it lives | Phase task |
| --- | --- | --- |
| **Deliverable**: `src/extensions/env-report.ts` (afterToolCall guard, classify→surface→replace, `env_report` tool, kill switch) | `src/extensions/env-report.ts` | T2, T4, T6, T8, T10, T12, T14, T16 |
| **Deliverable**: exported `classifyEnv(content): EnvClass \| null` + `ENV_RULES` constant + `annotateEnv(result): ToolResult` | `src/extensions/env-report.ts` | T2 (classifyEnv/ENV_RULES), T6 (annotateEnv) |
| **Deliverable**: `test/env-report.test.ts` (offline, MockProvider via `makeHarness`, co-loads recovery+env-report, stub tools) | `test/env-report.test.ts` | T1, T3, T5, T7, T9, T11, T13, T15, T17 |
| **Deliverable**: host.ts registration | **(deferred to batch integration)** — not in this task | — |
| **Deliverable**: `env_report` tool surface (no slash command) | `src/extensions/env-report.ts` | T14 (tool), no command task (D3 justifies omission) |
| **Deliverable**: kill switch `EAGENT_ENV_REPORT=off` (no-op disposer) | `src/extensions/env-report.ts` | T16 |
| **Deliverable**: CLAUDE.md / README inventory line | **(deferred to batch integration)** — not in this task; do NOT bump README count | — |
| **AC1** typecheck/build clean, no `any`, no unchecked index | gate on every impl task | T2, T4, T6, …, T18 (`npm run typecheck`) |
| **AC2** classifier returns each env class on its real string | `test/env-report.test.ts` | T1 → T2 |
| **AC3** classifier returns `null` for recovery-matchable (self-inflicted) errors | `test/env-report.test.ts` | T1 → T2 |
| **AC4** classifier returns `null` for benign success-shaped string | `test/env-report.test.ts` | T1 → T2 |
| **AC5** `annotateEnv` gating + idempotency (success unchanged, env appends once, non-env unchanged) | `test/env-report.test.ts` | T5 → T6 |
| **AC6** hint replacement: strips `Recovery hint:`, adds route-around note | `test/env-report.test.ts` | T5 → T6 |
| **AC7** live: env error replaces the retry-nudge | `test/env-report.test.ts` | T7 → T8 |
| **AC8** live: non-env error keeps recovery's nudge | `test/env-report.test.ts` | T9 → T10 |
| **AC9** live: host signal `environment_issue` warn emitted | `test/env-report.test.ts` | T11 → T12 |
| **AC10** live: `env_report` tool surfaces a model-declared blocker + warn | `test/env-report.test.ts` | T13 → T14 |
| **AC11** kill switch: no rewrite, tool not registered | `test/env-report.test.ts` | T15 → T16 |
| **AC12** clean disposal: after `host.unload`, no rewrite + tool gone | `test/env-report.test.ts` | T17 → T18 |

---

## 2. Phase Breakdown — Single Phase: build `env-report` + its offline test

The deliverable is one new extension and one new test file. It is **not**
genuinely separable into multiple phases: the pure classifier, the
`annotateEnv` transform, the live guard, the `env_report` tool, the kill switch,
and disposal are one cohesive extension whose pieces share the same module and
the same test file. One phase.

### Entry condition

- Working tree on the task branch; `npm test` and `npm run typecheck` both green
  on the untouched baseline (run them first to confirm a clean start —
  `recovery.test.ts` must already pass; env-report must not regress it).
- `src/extensions/recovery.ts` read and understood (its `MARKER = "Recovery hint:"`
  at line 34, `annotate` at lines 94–100, kill switch at 103, dispose loop at
  107–113).
- `test/recovery.test.ts` read (the `sawHint` scanner at 101–106, the
  `host.use("recovery", recovery)` load pattern, the `EAGENT_RECOVERY` env
  save/restore-in-`finally` pattern at 149–171).
- `test/helpers.ts` read (`makeHarness` accepts `{ responder, logger }`; the
  injectable `logger` is the seam for the warn-capture spy — AC9/AC10).

### Design references

- Deliverables: design §2. Scope boundary (what NOT to build): design §3.
- Key decisions: D1 (register-after-recovery + rewrite its hint), D2 (fixed regex
  classifier, four classes, exact patterns), D3 (auto-classify **and** an
  `env_report` tool, **no** slash command), D4 (on-by-default + `EAGENT_ENV_REPORT=off`),
  D5 (never block, observe/annotate only, fail-open).
- Dependencies/assumptions: design §5 (`afterToolCall` signature, filter order,
  the `"Recovery hint:"` marker coupling, `ToolResult` shape, `defineTool`/`ok`,
  `makeHarness`).
- Acceptance: design §7 (AC1–AC12). Risks: §8 (R1 conservative patterns, R2
  ordering/marker coupling, R3 disjoint-from-recovery, fail-open).

### Task list (TDD order)

Every TEST task names the **business invariant** it protects and is written and
seen failing **before** the impl task that satisfies it. Group the unit tests
(T1) so they can all be written first, then drive each impl piece.

Per the established pattern (`recovery.ts:79–100`), the impl exposes three
pure/seam-level exports so the agent loop is not needed for the core logic:

- `ENV_RULES` — exported readonly array of `{ class: EnvClass; match: RegExp }`
  (mirrors `RECOVERY_RULES`, design §2 / D2).
- `classifyEnv(content: string): EnvClass | null` — first-match-wins over
  `ENV_RULES` (mirrors `recoveryHint`).
- `annotateEnv(result: ToolResult, kind?: EnvClass | null): ToolResult` — the
  guard transform (mirrors `annotate`): gates on `isError`, strips any
  `"Recovery hint:"` block, appends the route-around note once, idempotent. The
  optional `kind` lets the hook pass its already-computed verdict to skip a
  redundant sweep; omitted, the transform self-classifies, so the single-arg
  contract is unchanged.

The route-around **note** is a fixed string the design pins by its assertable
shape (AC6, AC7): it must match `/environment issue/i` **and** `/do NOT retry/i`,
and must convey "surface to the operator and route around." Define it as a single
exported/module const (e.g. `ENV_NOTE`) so the strip/idempotency check and the
tool reuse one literal. The `environment_issue` **signal** (AC9) is `e.log.warn`
with a message containing the literal substring `"environment_issue"` (design §3,
§5 — no new kernel event type).

---

#### T1 — TEST: pure classifier — class coverage, recovery-disjointness, benign no-op (AC2, AC3, AC4)

**Business invariant:** the classifier fires on the closed vocabulary of OS/runtime
environmental error strings (auth / missing-binary / network / permission) and
**never** on recovery's own self-inflicted, correctable error strings nor on
benign output — so env-report can never poach a case recovery should correct
(design D2 rationale; R3 disjointness).

Write `test/env-report.test.ts` importing `classifyEnv, ENV_RULES` from
`../src/extensions/env-report.js`. Assert (design §7 AC2/AC3/AC4 verbatim inputs):
- `classifyEnv("Error: ANTHROPIC_API_KEY is not set") === "auth"` and
  `classifyEnv("HTTP 401 Unauthorized") === "auth"`.
- `classifyEnv("/bin/sh: rg: command not found") === "missing-binary"` and
  `classifyEnv("spawn rg ENOENT") === "missing-binary"`.
- `classifyEnv("getaddrinfo ENOTFOUND api.example.com") === "network"` and
  `classifyEnv("connect ECONNREFUSED 127.0.0.1:443") === "network"`.
- `classifyEnv("EACCES: permission denied, open '/etc/x'") === "permission"`.
- `classifyEnv("Text not found in /tmp/x.ts.") === null` and
  `classifyEnv("Invalid arguments for edit") === null` (recovery's strings — AC3).
- `classifyEnv("Wrote 12 bytes to /tmp/x.ts") === null` (benign — AC4).

**Acceptance** (fails — module not yet present):
```
node --import tsx --test test/env-report.test.ts
```

#### T2 — IMPL: `ENV_RULES` + `classifyEnv` (Deliverable: exported helper; D2)

Create `src/extensions/env-report.ts`. Define `EnvClass = "auth" | "missing-binary"
| "network" | "permission"`. Define `ENV_RULES: readonly { class: EnvClass; match:
RegExp }[]` using the **exact** patterns the design pins in D2 (copy them verbatim —
note the design's explicit warning that the `auth` key/credential pattern has **no
leading `\b`** so `ANTHROPIC_API_KEY` matches). Implement `classifyEnv` as
first-match-wins (`for (const rule of ENV_RULES) if (rule.match.test(content))
return rule.class; return null;`). Export both.

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T1 now passes
npm run typecheck                                   # exit 0; no any, no unchecked index (AC1)
```

#### T3 — TEST: `annotateEnv` gating + idempotency + hint replacement (AC5, AC6)

**Business invariant:** the transform only ever touches a *failed env-class*
result; it leaves successes and non-env failures byte-for-byte unchanged, appends
the route-around note **exactly once** (idempotent), and when recovery already
appended a `"Recovery hint:"` block to an env-class failure it **replaces** it —
the model must end with "route around", never a retry-nudge (design D1; AC5/AC6).

Add to the test file, importing `annotateEnv, ENV_NOTE` (and the note's marker).
Assert:
- success unchanged: `annotateEnv({ content: "spawn rg ENOENT", isError: false })`
  returns content equal to input (gating on `isError`, AC5).
- non-env failure unchanged: `annotateEnv({ content: "the disk is on fire",
  isError: true })` returns content equal to input (AC5).
- env failure appends once and is idempotent: feed `{ content: "spawn rg ENOENT",
  isError: true }` → result matches `/environment issue/i` and `/do NOT retry/i`;
  feeding the result back through `annotateEnv` yields an unchanged `content`
  (AC5 idempotency — same contract as `recovery.ts:96`).
- replacement: feed `{ content: "spawn rg ENOENT\n\nRecovery hint: re-read the
  file…", isError: true }` → result `content` **does not** contain
  `"Recovery hint:"` **and** matches `/environment issue/i` and `/do NOT retry/i`
  (AC6).

**Acceptance** (fails — `annotateEnv`/`ENV_NOTE` not yet exported):
```
node --import tsx --test test/env-report.test.ts
```

#### T4 — IMPL: `ENV_NOTE` route-around note (Deliverable: the surface note; D1/D5)

Add an exported (or module-const, but exporting eases T3 import) `ENV_NOTE`
string that **matches `/environment issue/i` and `/do NOT retry/i`** and tells the
operator to surface + route around (design D1 wording, §7 AC6). Keep it one
literal reused by `annotateEnv` and the `env_report` tool. (No impl of
`annotateEnv` yet — that's T6; introduce the note now so T6 can reuse it.)

**Acceptance:**
```
npm run typecheck    # exit 0 (AC1)
```

#### T6 — IMPL: `annotateEnv` (Deliverable: exported guard transform; D1, D5)

Implement `annotateEnv(result: ToolResult): ToolResult`:
1. If `!result.isError` → return `result` unchanged (gating, AC5).
2. `const kind = classifyEnv(result.content)`; if `kind === null` → return
   `result` unchanged (non-env failures pass to recovery untouched, AC5/AC8).
3. **Strip** any recovery hint: detect the literal `"Recovery hint:"` substring
   (design D1 — env-report matches the literal, does **not** import recovery's
   private `MARKER`) and remove the appended block. recovery's append format is
   `\n\n${MARKER} ${hint}` (`recovery.ts:99`), so slice at the marker and trim the
   trailing whitespace/separator. Base the note on the **pre-hint** content.
4. **Idempotency:** if the (pre-hint) content already contains `ENV_NOTE`'s marker,
   return unchanged (AC5 second-pass no-op — same guard as `recovery.ts:96`).
5. Return `{ ...result, content: \`${base}\n\n${ENV_NOTE}\` }`.

Keep it pure (no `e`, no logging — the `e.log.warn` surfacing happens in the hook
body, T12, so the unit test stays log-free). Never set `terminate`/`block` (D5).

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T3 now passes
npm run typecheck                                   # exit 0 (AC1)
```

> Note on numbering: T5 is the test for `annotateEnv` written above as **T3** in
> reading order; the impl that satisfies it is this **T6**. (T4 introduced the
> note literal T6 depends on.) Keep test-before-impl: T3 is written and red
> before T6.

#### T7 — TEST: live — env error replaces the retry-nudge (AC7)

**Business invariant:** with `recovery` loaded **then** `env-report` (real chain
order, filters run in registration order — `hooks.ts:64–65,86–88`), an env-class
tool failure reaches the model carrying the route-around note and **NOT** a
`Recovery hint:` — the suppression composes through the actual agent loop, not
just the unit transform (design D1; R2 asserted-here).

In the test file, build a live harness with `makeHarness({ responder })` where the
responder scripts the model to call a stub tool then end. Co-load (in this order):
`await h.host.use("recovery", recovery)` then `await h.host.use("env-report",
activate)` (the env-report default export). Register an **inline stub tool** that
returns `{ isError: true, content: "spawn rg ENOENT" }` — register it via a third
`host.use("stub", e => e.registerTool(defineTool({ name: "envfail", … execute: ()
=> ({ isError: true, content: "spawn rg ENOENT" }) })))` (the `risk-guard.test.ts`
inline-tool pattern). Script the MockProvider: turn 0 `toolCalls: [{ name:
"envfail" }]`, turn 1 `{ text: "done" }`. Run `await h.agent.run("go")`.

Reuse a `sawHint`-style scanner over `role === "tool"` messages'
`tool_result` blocks (invert of `recovery.ts:101–106`). Assert the tool_result the
model saw: (a) matches the env note (`/environment issue/i` and `/do NOT retry/i`),
and (b) does **NOT** match `/Recovery hint:/`.

**Acceptance** (fails — `env-report` default export not yet wired to the hook):
```
node --import tsx --test test/env-report.test.ts
```

#### T8 — IMPL: `activate(e)` registering the `afterToolCall` guard (Deliverable: the guard; D1/D5)

Add `export default function activate(e: ExtensionAPI): () => void`. Register
`const off = e.hook("afterToolCall", (result) => { … })`. The hook body:
- Wrap in `try/catch` and **return the result unchanged on any internal error**
  (fail-open — design D5, §8 "Fail-open"; the `trace.ts:88–96` pattern).
- Call `const annotated = annotateEnv(result)`. (The `e.log.warn` surfacing is
  added in T12 — for now just return `annotated`.)
- Return `annotated`.

This composes after recovery because tests load env-report after recovery and
filters fire in registration order (design §5). Do not touch `recovery.ts`.

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T7 now passes
npm run typecheck                                   # exit 0 (AC1)
```

#### T9 — TEST: live — non-env error keeps recovery's nudge (AC8)

**Business invariant:** env-report is the *inverse* of recovery only for env-class
errors; a correctable, self-inflicted error still reaches the model with
recovery's nudge intact and **no** env note — env-report never poaches recovery's
domain (design D1 §6 "they compose"; R3).

Same co-load (recovery then env-report) and a stub tool returning
`{ isError: true, content: "Text not found in x.ts." }` (a recovery-matchable
string — `recovery.ts:44`). Run the agent. Assert the model-visible tool_result:
(a) **still** matches `/Recovery hint:/`, and (b) does **NOT** match the env note
(`/environment issue/i`).

**Acceptance** (must pass already if T8 is correct; write it red first by
confirming it relies on env-report leaving non-env failures alone):
```
node --import tsx --test test/env-report.test.ts
```

#### T10 — IMPL: confirm non-env pass-through (Deliverable; D1)

No new code if T6/T8 are correct: `annotateEnv` returns non-env failures unchanged
(T6 step 2), so recovery's hint survives. If T9 is red, the bug is an over-broad
`ENV_RULES` pattern matching `"Text not found"` — tighten the pattern per D2's
"conservative, anchored on unambiguous environmental tokens" mandate. Do **not**
add a recovery-specific exclusion; the rulesets are disjoint *by construction*
(R3).

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T9 passes
npm run typecheck                                   # exit 0
```

#### T11 — TEST: live — host signal `environment_issue` emitted (AC9)

**Business invariant:** an environmental blocker is **surfaced** to the operator,
never silently absorbed — the auto-classified env failure produces an
`e.log.warn` line containing `"environment_issue"` (design §2 "Surfaces"; §3; AC9).

Build the harness with a **capturing logger** (the `risk-guard.test.ts:241–245`
spy): `const warnings: unknown[][] = []; const logger = { debug(){}, info(){},
warn: (...a) => warnings.push(a), error(){} };` passed as `makeHarness({
responder, logger })`. Co-load recovery + env-report + the `envfail` stub (env
error). Run the agent. Assert `warnings.some(args => args.some(a => typeof a ===
"string" && /environment_issue/.test(a)))`.

**Acceptance** (fails — hook does not yet warn):
```
node --import tsx --test test/env-report.test.ts
```

#### T12 — IMPL: emit `environment_issue` on classification (Deliverable: surface; §3/§5)

In the `afterToolCall` hook body (T8), when `classifyEnv(result.content)` is
non-null (i.e. when `annotateEnv` actually rewrote the result), call
`e.log.warn("environment_issue", …)` with the matched class and a short reason
(e.g. the class name). Keep it inside the same `try/catch` so a logging failure
still fails open. Do **not** add a new kernel event type (design §3 — the signal is
`e.log.warn` + the appended note only).

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T11 passes
npm run typecheck                                   # exit 0
```

#### T13 — TEST: live — the `env_report` tool surfaces a model-declared blocker (AC10)

**Business invariant:** the model can **proactively** declare an environment
blocker it reasoned about (not read from an error string) and have it surfaced +
route-around-noted — Devin's `report_environment_issue` path (design D3; AC10).

Script the MockProvider to call the tool: turn 0 `toolCalls: [{ name:
"env_report", arguments: { reason: "GITHUB_TOKEN not set; cannot push" } }]`,
turn 1 `{ text: "done" }`. Use the capturing logger. Co-load env-report (recovery
optional here). Run the agent. Assert: (a) the `env_report` tool_result is
**successful** (`isError` falsy) and its content carries the route-around note
(`/environment issue/i`, `/do NOT retry/i`); (b) `warnings` records an
`"environment_issue"` warn line.

**Acceptance** (fails — tool not registered):
```
node --import tsx --test test/env-report.test.ts
```

#### T14 — IMPL: the `env_report` tool (Deliverable: model-callable tool; D3)

In `activate`, register via `e.registerTool(defineTool({ name: "env_report",
description: …, parameters: { type: "object", properties: { reason: { type:
"string", … } }, required: ["reason"] }, execute: (args) => { e.log.warn(
"environment_issue", String(args.reason)); return ok(\`${ENV_NOTE}\n\n${reason}\`);
} }))`. Declare **no capability** (design §3 — pure annotation, no host side
effect). Returns a **success** `ToolResult` via `ok` (`define.ts:42`), content =
the route-around note (+ the reason). No slash command (D3).

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T13 passes
npm run typecheck                                   # exit 0
```

#### T15 — TEST: kill switch `EAGENT_ENV_REPORT=off` (AC11)

**Business invariant:** the kill switch fully restores baseline behavior — env
errors are **not** rewritten (recovery's hint, if any, survives), no env note
appears, and the `env_report` tool is **not** registered — a single env var is the
instant escape hatch (design D4; §8 Rollback; AC11).

Set `process.env.EAGENT_ENV_REPORT = "off"` (save prior value, **restore in a
`finally`** — the `recovery.test.ts:149–171` pattern). Co-load recovery +
env-report + the `envfail` stub. Run the agent. Assert: (a) the tool_result
**does** carry recovery's behavior (i.e. env note absent — `!/environment issue/i`);
(b) `h.agent.tools.get("env_report") === undefined`.

**Acceptance** (fails — kill switch not yet honored):
```
node --import tsx --test test/env-report.test.ts
```

#### T16 — IMPL: kill switch (Deliverable: `EAGENT_ENV_REPORT=off` no-op disposer; D4)

At the top of `activate`: `if (process.env.EAGENT_ENV_REPORT === "off") return ()
=> {};` (the `recovery.ts:103` no-op-disposer pattern). With it set, neither the
hook nor the tool is registered.

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # T15 passes
npm run typecheck                                   # exit 0
```

#### T17 — TEST: clean disposal — no leak (AC12)

**Business invariant:** unloading the extension tears down **both** the
`afterToolCall` hook **and** the `env_report` tool — no orphaned hook keeps
rewriting results, no orphaned tool lingers (design §8 Rollback; AC12; the
`extension.ts:218–241` tracked-teardown contract).

Co-load recovery + env-report + the `envfail` stub, then `await
h.host.unload("env-report")` **before** running. Run the agent. Assert: (a) the
env-class tool_result is **not** rewritten (env note absent — recovery's behavior
restored); (b) `h.agent.tools.get("env_report") === undefined`.

**Acceptance** (passes if the dispose loop is correct):
```
node --import tsx --test test/env-report.test.ts
```

#### T18 — IMPL: dispose loop that never throws (Deliverable: clean teardown; §5)

`activate` returns a disposer that calls `off.dispose()` inside a `try/catch`
(teardown must not throw — the `recovery.ts:107–113` pattern). The
`e.registerTool` return is tracked by the host automatically
(`extension.ts:228`), so the tool is disposed on unload without manual bookkeeping;
the disposer only needs to cover the `e.hook` registration (or simply rely on the
host's combined teardown and return a never-throw no-op — match `recovery.ts`
exactly). Confirm both the hook and tool are gone after unload.

**Acceptance:**
```
node --import tsx --test test/env-report.test.ts   # all of T1–T17 pass
npm run typecheck                                   # exit 0 (AC1)
npm test                                            # full offline suite green; recovery.test.ts unaffected
```

### Exit condition

- `node --import tsx --test test/env-report.test.ts` passes (all of AC2–AC12).
- `npm run typecheck` exits 0 — no `any`, no unchecked index access (AC1).
- `npm test` exits 0 — the full offline suite is green; **`recovery.test.ts` is
  unaffected** (env-report never edited `recovery.ts`; see Regression Protection).
- Only `src/extensions/env-report.ts`, `test/env-report.test.ts`, and this
  `docs/` file changed. `host.ts`, `CLAUDE.md`, `README.md` **untouched** (batch).

---

## 3. Engineering Constraints Index

House rules (from `CLAUDE.md` and the prompt's house-rules block) the agent must
hold throughout:

- **ESM + NodeNext, `.js` specifiers.** Import `.ts` modules with a `.js`
  extension: `from "../kernel/define.js"`, `from "../src/extensions/recovery.js"`.
  Required by `module: NodeNext` + `verbatimModuleSyntax`. Use
  `import type { … }` for type-only imports (`ToolResult`, `ExtensionAPI`).
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are on. **No `any`.** Model
  the types (`EnvClass` union, `ENV_RULES` typed array). Indexed access into
  `ENV_RULES`/message arrays must account for `T | undefined` (use `for…of`, or
  the `!` only where a sibling test already does, e.g. `messages[i]!`).
- **Zero runtime dependencies except `jiti`.** Pure Node + `RegExp` only. No npm
  installs, no SDK, no `fetch`. (env-report makes **no** network/provider call —
  D2.)
- **Capability-gated side effects.** env-report declares **no capability**: it
  reads result text and writes to the log/transcript, no privileged side effect
  (design §3). The `env_report` tool also declares none (pure annotation).
- **Offline `node:test` against MockProvider.** Tests run via
  `node --import tsx --test`, no network, no `ANTHROPIC_API_KEY`. Drive the live
  path with `makeHarness` + scripted `MockProvider` + inline stub tools.
- **Kill-switch env var.** `EAGENT_ENV_REPORT=off` → no-op disposer
  (`recovery.ts:103`).
- **Never-throw dispose loop.** The returned deactivate wraps teardown in
  `try/catch` (`recovery.ts:107–113`).
- **Fail-open.** Every hook body is `try/catch`-wrapped and returns the result
  unchanged on any internal error (`trace.ts:88–96`; design D5, §8).

**Hook surface (for reference):** filters via `e.hook("afterToolCall", (result,
{ call }) => result)`; events via `e.on`; tools via `e.registerTool`; logging via
`e.log.warn`. The agent loop applies `afterToolCall` at `agent.ts:303`; filters
fire in registration order (`hooks.ts:64–65,86–88`). env-report uses **only**
`afterToolCall` + `registerTool` + `e.log` (design §5).

**Commit conventions:**

- Prefix `feat(phaseN)` for new work, `fix(phaseN-roundR)` for review-round fixes
  (single phase here → `feat(phase1)`).
- Trailers: include `npm test` and `npm run typecheck` results.
- **No mention of AI / model / tooling** in commit messages.
- Branch first if on the default branch; commit/push only when asked.

**Batch-mode constraints (CRITICAL — do NOT violate):**

- Do **NOT** modify `src/host.ts`, `CLAUDE.md`, or `README.md`. Registration in
  `BUILTIN_EXTENSIONS` and the inventory line are **deferred to a separate batch
  integration step**.
- Tests load the extension directly via `host.use("env-report", activate)` (and
  `host.use("recovery", recovery)`) — they must **NOT** depend on env-report being
  in `BUILTIN_EXTENSIONS`.
- Do **NOT** bump the README extension count.
- Touch only: `src/extensions/env-report.ts`, `test/env-report.test.ts`, and
  `docs/design/` + `docs/implementation/` (this guide).

---

## 4. Data / Fixture Dependencies

- **`test/helpers.ts` — reuse, do not reinvent.** `makeHarness({ responder,
  logger })` builds the offline `Agent` + `MockProvider` + `ExtensionHost`. The
  **injectable `logger`** is the seam for the warn-capture spy (AC9, AC10) — pass
  `{ debug(){}, info(){}, warn: (...a) => warnings.push(a), error(){} }`. Do not
  add a new helper; this is the established pattern (`risk-guard.test.ts:241–245`).
- **`MockProvider` responder script** (`src/providers/mock.ts`): an array of
  `MockTurn`s. Turn 0 issues the tool call (`{ toolCalls: [{ name: "envfail" }] }`
  or `{ name: "env_report", arguments: { reason } }`); turn 1 ends (`{ text:
  "done" }`). Deterministic, offline.
- **Inline stub tools** via `host.use("stub", e => e.registerTool(defineTool({
  name: "envfail", description: "…", parameters: { type: "object", properties: {}
  }, execute: () => ({ isError: true, content: "spawn rg ENOENT" }) })))` — the
  env-class / non-env error producers for the live tests. Pattern from
  `risk-guard.test.ts:34,75,84`. (Stub tools return env-class strings directly so
  no real failing infra is needed.)
- **`defineTool` / `ok`** from `../src/kernel/define.js` — construct the
  `env_report` tool (`ok` for the success result).
- **`sawHint`-style scanner** — adapt `recovery.test.ts:101–106`: filter
  `role === "tool"` messages, scan `tool_result` blocks' `content`. Use it both
  to assert the env note present and `/Recovery hint:/` absent (AC7) and inverted
  (AC8).
- **Env-var save/restore** — for the kill-switch test (AC11), save
  `process.env.EAGENT_ENV_REPORT`, set `"off"`, **restore in `finally`**
  (`recovery.test.ts:149–171`). Same for any test that toggles env.
- **No temp-file workspace needed.** Unlike `recovery.test.ts` (which uses a real
  `edit` against a scratch file), env-report's live tests use **stub tools that
  return scripted error strings** (design §7: "inline stub tools that return
  scripted env-class / non-env errors"), so no `mkdtempSync`/`EAGENT_WORKSPACE`
  fixture is required.

---

## 5. Regression Protection

These prior tests must **stay green** — env-report must not perturb them:

- **`test/recovery.test.ts` — the load-bearing regression.** env-report **must
  not edit `recovery.ts`** (design D1: no shared flag, no contract change). After
  this task, `node --import tsx --test test/recovery.test.ts` must pass unchanged.
  The design's AC8/T9 (non-env error keeps recovery's nudge) directly protects the
  "they compose" invariant from recovery's side.
- **The full offline suite — `npm test`.** Must exit 0. env-report adds one
  `afterToolCall` filter and one tool *only when explicitly loaded via
  `host.use`*; because it is **not** added to `BUILTIN_EXTENSIONS` in this batch
  task, no other test's harness picks it up — so trace / circuit-breaker /
  core-tools / search / every other extension test is untouched by construction.
- **`npm run typecheck` — exit 0.** The new strict-typed module must not introduce
  a type error anywhere (no `any`, no unchecked index).

Run, from repo root, to confirm no regression:
```
node --import tsx --test test/recovery.test.ts   # sibling unaffected
node --import tsx --test test/env-report.test.ts # new tests green
npm run typecheck                                 # exit 0
npm test                                          # full suite green
```

If `npm test` flags any *other* test, env-report has leaked beyond its files —
re-check that nothing edited `host.ts`/`recovery.ts` and that the extension is
loaded only via `host.use` in `test/env-report.test.ts`.
