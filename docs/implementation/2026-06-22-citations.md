# Implementation guide — citations

Status: closed
Closing-commit: b6b0d26
Closed-on: 2026-06-22
Deferred: none

Tag retrieval outputs with stable ids and validate answer `[id]` markers.

- **Design (FINAL, PASSED):** `docs/design/2026-06-22-citations.md` — read it in
  full before starting. This guide introduces **no** requirement absent from
  that design.
- **Closest sibling to copy from:** `src/extensions/content-guard.ts` (same
  `afterToolCall` seam, same capability-based output selection, same kill-switch
  posture) and its test `test/content-guard.test.ts`.
- **Reset/observer shape to copy from:** `src/extensions/trace.ts`
  (`on("agent_start")` per-run reset, `src/extensions/trace.ts:99-107`).
- **Offline load pattern to copy from:** `test/recovery.test.ts:118-119`
  (`host.use(id, activate)` — never depend on `BUILTIN_EXTENSIONS`).

This is a **single-phase**, two-file change. Batch-integration steps
(`host.ts` registration, `CLAUDE.md`/`README` inventory) are explicitly
**deferred** and out of scope here — see §3 and the design Deliverables.

---

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7) to a phase task
in §2 below. Every AC is a runnable assertion; every Deliverable is covered.

| Design item | Where | Phase task |
| --- | --- | --- |
| Deliverable: `src/extensions/citations.ts` | §2 Deliverables | T2–T11 (impl), T13 |
| Deliverable: `test/citations.test.ts` | §2 Deliverables | T1, T2…T12 (each test task) |
| Deliverable: `host.ts` registration | §2 (deferred) | **deferred to batch integration** — do NOT touch |
| Deliverable: `/citations` command | §2 | T10 (test), T11 (impl) |
| Deliverable: `EAGENT_CITATIONS=off` kill switch + `enabled` store flag | §2 | T9 (test), T2 (impl), T13 |
| Deliverable: CLAUDE.md / README inventory line | §2 (deferred) | **deferred to batch integration** — do NOT touch, do NOT bump count |
| AC1 (id tagging — header present) | §7 | T3 |
| AC2 (capability gate — non-retrieval untouched) | §7 | T3 |
| AC3 (default caps cover search/read — `fs:read`) | §7 | T3 |
| AC4 (monotonic ids `[src:1]`,`[src:2]` + map records both) | §7 | T4 |
| AC5 (per-run reset → `[src:1]` again) | §7 | T5 |
| AC6 (fabricated-id warn + `/citations` lists it) | §7 | T6 |
| AC7 (clean answer — no false positive) | §7 | T7 |
| AC8 (`[N]` bare form scoped confirm; `[src:N]` is authoritative source; `[3]:` excluded) | §7 | T8 |
| AC9 (missing-attribution off by default; `warnMissing` flag flips it) | §7 | T9b |
| AC10 (`/citations` report shape + `on`/`off` toggles `enabled`) | §7 | T10 |
| AC11 (`EAGENT_CITATIONS=off` kill switch) | §7 | T9 |
| AC12 (clean dispose — no leak after `host.unload`) | §7 | T12 |
| AC13 (composition with `content-guard`; header ahead of fence, asserted by index) | §7 | T11b |
| AC14 (idempotency — already-`[src:`-tagged content gets no 2nd header) | §7 | T8b |
| Warn-only never blocks (D5) | §3/§D5 | invariant asserted in T6/T7 |

---

## 2. Phase Breakdown — Single Phase: `citations` extension

There is exactly one phase. The work is not genuinely separable: the extension
file and its test co-evolve through one TDD loop, all sharing one `activate(e)`
and one test file.

### Entry condition

- Working tree on the task branch (`init` worktree at
  `/private/tmp/eagent-wt/citations`); `npm test` and `npm run typecheck` green
  before any change.
- Design `docs/design/2026-06-22-citations.md` read in full.
- No edits to `src/host.ts`, `CLAUDE.md`, `README.md` (batch mode — §3).

### Design references

- §1 Purpose, §2 Deliverables, §4 Decisions D1–D6, §5 Dependencies, §7 AC1–AC14,
  §8 Risks.
- Anchor file for kill-switch + `enabled` posture:
  `src/extensions/content-guard.ts:103,106` (env check returns no-op disposer;
  `enabled` via `e.store.get<boolean>("enabled", default)`). **Note the default
  differs:** `citations` `enabled` defaults to **`false`** (D6 — off by default),
  whereas content-guard defaults to `true`. The *env kill switch* line
  (`if (process.env.EAGENT_CITATIONS === "off") return () => {};`) mirrors
  `content-guard.ts:103` exactly.
- Capability-based retrieval detection: `content-guard.ts:112-116`
  (`e.agent.tools.get(name)?.capabilities ?? []` then `.some(c => caps.includes(c))`).
- Final-answer extraction: the `lastText(agent)` helper, `test/helpers.ts:47-55`
  (last `role:"assistant"` message's first `text` block). Use `e.agent.messages`
  in the extension (`src/kernel/agent.ts:98-100`).
- Per-run reset on `agent_start`: pattern from `src/extensions/trace.ts:99-107`.

### Constants and shape (from design — implement, do not invent beyond these)

- `DEFAULT_RETRIEVAL_CAPS = ["net:fetch", "fs:read"]` (§2, D1: covers `web` via
  `net:fetch`; `read`/`glob`/`grep` via `fs:read`). Store-overridable via
  `retrievalCaps`.
- Header line prepended to retrieval result content:
  `[src:N] <tool> — <locator>\n` (D2). `<locator>` is a short best-effort string
  (tool name + first-line/URL snippet) — design §3 NON-goal forbids anything
  richer.
- Per-run state: a map `N → { tool, locator }`, an id counter, reset on
  `agent_start` (D4). In-memory only — no persistence (§3).
- Stems for parsing the final answer (D3, §8): authoritative `[src:N]`; permissive
  bare `[N]`. **Scoping rule (§8, AC8):** a bare `[N]` is counted as a citation
  **only when `N` is in the emitted-id set** (it can confirm a real id, never
  introduce a fabricated one); a `[N]` immediately followed by `:` (reference-style
  link def `[3]:`) is excluded. Fabricated-id flags come **only** from `[src:N]`.
- `warnMissing` store flag, default **`false`** (D3 choice (c)) — missing-attribution
  is computed but only warned when the flag is set.
- `EAGENT_CITATIONS=off` env kill switch checked at activation (returns no-op
  disposer); `enabled` store flag default `false` (D6).
- **Never block, never call a model** (§3, D5). On a fabricated id: `e.log.warn`
  + record in the `/citations` report. `agent_end` is an observe event, not a
  filter — there is no veto seam and none must be introduced.
- **Fail-safe:** wrap the `afterToolCall` body and the `agent_end` handler so a
  throw never breaks the run (the extension fails open, like content-guard).
- **Never-throw dispose loop:** `try { d.dispose() } catch { /* teardown must
  not throw */ }` over every registration (`content-guard.ts:156-164`).

### Task list (TDD order — every TEST names the business invariant it protects and precedes the impl it protects)

> All test tasks live in one growing file `test/citations.test.ts`. Tests use
> `makeHarness` (`test/helpers.ts`) + a scripted `MockProvider`, inline stub
> retrieval tools (copy the `stubTool` helper from
> `test/content-guard.test.ts:66-80`), and load the extension via
> `host.use("citations", activate)`. Use a capturing logger passed as
> `makeHarness({ logger })` to spy on `e.log.warn` (AC6). The "first
> `tool_result` content" reader is `firstResultContent`,
> `test/content-guard.test.ts:82-87`.

**T1 — Test scaffolding + first failing test (RED).**
Create `test/citations.test.ts`: imports, the `stubTool` and `firstResultContent`
helpers, a capturing logger factory (`{ warns: string[]; logger: Logger }`), and
a scripted-provider helper. Write the first assertion (T3's AC1) so it fails for
the right reason (module not found).
- Acceptance: `node --import tsx --test test/citations.test.ts` fails because
  `src/extensions/citations.ts` does not exist yet (RED, expected).

**T2 — Impl: minimal `activate(e)` skeleton + kill switch (GREEN scaffolding).**
Create `src/extensions/citations.ts`: `export default function activate(e:
ExtensionAPI): () => void`. First line is the env kill switch
(`if (process.env.EAGENT_CITATIONS === "off") return () => {};`,
anchor `content-guard.ts:103`). Add the `cfg()` reader for
`enabled` (default `false`), `retrievalCaps` (default `DEFAULT_RETRIEVAL_CAPS`),
`warnMissing` (default `false`) — mirroring `content-guard.ts:105-108`. Register
an `afterToolCall` filter and `on("agent_start")`/`on("agent_end")` handlers as
no-ops for now, plus the never-throw dispose loop returning all disposers.
- **Invariant (structural):** the extension activates cleanly and tears down
  without throwing; the kill-switch path returns a no-op disposer.
- Acceptance: `npm run typecheck` exits 0;
  `node --import tsx --test test/citations.test.ts` runs (the AC1 test may still
  fail because tagging is not implemented — that is T3).

**T3 — TEST: retrieval output is tagged; non-retrieval is not; `fs:read` is covered (AC1, AC2, AC3).**
Three assertions. **Business invariant protected:** *only* tool output whose
producing tool declares a retrieval capability becomes citable — a `[src:N]`
header is prepended to retrieval output (AC1: `net:fetch` stub → first
`tool_result` starts with `[src:1] `), a non-retrieval-only tool's output is
byte-identical to raw (AC2: `["shell:exec"]` stub → no `[src:` prefix), and the
default retrieval set includes `fs:read` so `read`/`glob`/`grep` are covered
(AC3: `["fs:read"]` stub → gets a header). The `enabled` flag must be set true
in these tests (default is off) — set it via the store before the run (mirror how
content-guard tests rely on its default; here you must opt in).
- Acceptance: `node --import tsx --test test/citations.test.ts` — these three
  fail (RED) before T3-impl.

**T3-impl — Impl: capability-gated `[src:N]` header prepend on `afterToolCall`.**
In the `afterToolCall` filter: if `!enabled || result.isError ||
content.startsWith("[src:")` (idempotency skip) return unchanged; if the
producing tool (`ctx.call.name`) declares no intersecting retrieval cap, return
unchanged (`isRetrieval`, copy `content-guard.ts:112-116`); else allocate the
next id `N`, record `N → { tool, locator }` in the per-run map, and return
`{ ...result, content: "[src:N] <tool> — <locator>\n" + content }`. Wrap the body
in try/catch returning the original `result` on throw (fail-safe).
- Acceptance: `node --import tsx --test test/citations.test.ts` AC1/AC2/AC3 green;
  `npm run typecheck` exits 0.

**T4 — TEST: monotonic ids + map records both (AC4).**
**Business invariant protected:** ids are stable and distinct within a run —
two retrieval results get `[src:1]` then `[src:2]`, and both `1` and `2` are
recorded in the per-run map. Script two retrieval tool calls in one run; assert
both headers present and increasing.
- Acceptance: `node --import tsx --test test/citations.test.ts` AC4 fails (RED)
  before T4-impl (if the counter is wrong).

**T4-impl — Impl: monotonic id counter.**
Ensure the id allocator increments per tagged result and the map carries each.
- Acceptance: AC4 green; `npm run typecheck` 0.

**T5 — TEST: per-run reset (AC5).**
**Business invariant protected:** the id map is per-run, not cumulative — after a
second `agent.run`, the first tagged result of the new run is `[src:1]` again.
- Acceptance: AC5 fails (RED) before the reset handler is wired.

**T5-impl — Impl: `on("agent_start")` resets the map + counter.**
Zero the per-run map and id counter on `agent_start` (pattern
`trace.ts:99-107`).
- Acceptance: AC5 green; `npm run typecheck` 0.

**T6 — TEST: fabricated-id warn (AC6) + warn-only never blocks (D5).**
**Business invariant protected:** a cited-but-never-emitted id is surfaced as a
warning and recorded for the report, and the run still completes (warn-only,
never blocks). Script the final answer text to contain a good and a fabricated
marker, e.g. `"A [src:1] but also [src:9]"` with only `[src:1]` emitted. Assert:
(a) a warn was logged (capturing logger sees the fabricated id `9`); (b) the run
completed normally (no throw, assistant message present). The `/citations` report
listing `9` is asserted alongside in T10, but you may assert the in-memory
last-run validation here too.
- Acceptance: AC6 fails (RED) before the `agent_end` validator.

**T6-impl — Impl: `on("agent_end")` parses final answer, warns on fabricated ids.**
On `agent_end`: if `!enabled` no-op. Read the final answer = last
`role:"assistant"` text block from `e.agent.messages` (logic of `lastText`,
`helpers.ts:47-55`); if none, no-op (§5 assumption). Parse cited ids using the
two stems (see scoping in T8). Compute `fabricated = citedViaSrcStem \ emitted`
(only the authoritative `[src:N]` stem can introduce a fabricated id). For each
fabricated id, `e.log.warn(...)`. Store the last-run validation result (emitted
ids, cited ids, fabricated ids, missing-attribution flag) for `/citations`. Wrap
the whole handler in try/catch (fail-safe) — and it must **never** call
`steer`/`followUp`/block (D5).
- Acceptance: AC6 green; `npm run typecheck` 0.

**T7 — TEST: clean answer — no false positive (AC7).**
**Business invariant protected:** a final answer citing only emitted ids
(`"see [src:1]"`) yields an empty fabricated set and **no** warn — the validator
does not cry wolf on correct attribution.
- Acceptance: AC7 fails (RED) if the parser over-flags; green after T6-impl is
  correct.

**T8 — TEST: bare `[N]` scoping + `[src:N]` authoritative + `[3]:` excluded (AC8).**
**Business invariant protected:** fabricated-id flags come *only* from the
unambiguous `[src:N]` stem; an incidental bracketed integer (footnote/list
artifact) must never raise a spurious fabricated-id warn (§8 fail-noisy risk).
Assert all four sub-cases from AC8: `"per [1]"` with 1 emitted → valid citation
of 1, not flagged; `"per [7]"` with 7 **unemitted** → **not** flagged (incidental
token); `"per [src:7]"` with 7 unemitted → **flagged**; `"[3]: http://…"` →
**not** counted as a citation of 3.
- Acceptance: AC8 fails (RED) if scoping is missing.

**T8-impl — Impl: scoped bare-`[N]` parse.**
Parse `[src:N]` stems (authoritative — these populate `citedViaSrcStem` and feed
fabrication). Parse bare `[N]` stems separately, excluding any `[N]` immediately
followed by `:`, and count a bare `[N]` as a citation **only when `N` is in the
emitted set**. Use pure-Node string/regex ops (no deps).
- Acceptance: AC8 green; `npm run typecheck` 0.

**T8b — TEST + already covered: idempotency (AC14).**
**Business invariant protected:** feeding already-`[src:`-tagged content back
through the `afterToolCall` filter adds no second header (defensive idempotency,
D2). The `content.startsWith("[src:")` skip from T3-impl already provides this;
add an explicit test that invokes the filter path twice (or runs a tool whose raw
content already begins with `[src:`) and asserts a single header. If T3-impl's
skip is present this is green immediately (still write the test — it pins the
invariant).
- Acceptance: AC14 green.

**T9 — TEST: `EAGENT_CITATIONS=off` kill switch (AC11) — restore env in finally.**
**Business invariant protected:** the env kill switch fully disables tagging —
with `EAGENT_CITATIONS=off` no `[src:N]` header is added (raw content survives).
Set `process.env.EAGENT_CITATIONS = "off"` inside the test and **restore it in a
`finally`** (mirror `test/content-guard.test.ts:175-187`).
- Acceptance: AC11 green (the env check is already in T2-impl).

**T9b — TEST: missing-attribution off by default; `warnMissing` flips it (AC9).**
**Business invariant protected:** a substantive uncited answer after ≥1 emitted
id produces **no** warn under default settings (avoids nagging, D3 choice (c)),
but setting the `warnMissing` store flag `true` makes the same run report a
missing-attribution flag.
- Acceptance: AC9 fails (RED) before the missing-attribution computation.

**T9b-impl — Impl: optional missing-attribution flag.**
In the `agent_end` validator, compute `missingAttribution = (emitted.size >= 1)
&& (citedIds.size === 0)`. Record it in the last-run validation always; emit a
warn for it **only** when `warnMissing` is true. Default `warnMissing` false.
- Acceptance: AC9 green; `npm run typecheck` 0.

**T10 — TEST: `/citations` report shape + `on`/`off` toggle (AC10) and lists fabricated `9` (AC6 report half).**
**Business invariant protected:** the `/citations` command surfaces the last-run
validation (emitted-count, cited-ids, fabricated-ids) and `on`/`off` toggles the
`enabled` flag. After the AC6 run, `/citations` (or `status`) lists `9` under
fabricated ids; `on`/`off` flip `enabled` (mirror
`test/content-guard.test.ts:200-213`). Get the command via
`h.commands.get("citations")` and run with a `print` collector.
- Acceptance: AC10 (+ AC6 report half) fails (RED) before T11-impl.

**T11-impl — Impl: `/citations` command.**
Register via `e.registerCommand` (copy the `switch (arg)` shape from
`content-guard.ts:129-154`): `on` → `store.set("enabled", true)`; `off` →
`store.set("enabled", false)`; default/`status` → print enabled state,
retrieval-caps, emitted-count, cited-ids, fabricated-ids, and the
missing-attribution flag from the last-run validation.
- Acceptance: AC10 green; `npm run typecheck` 0.

**T11b — TEST: composition with `content-guard` (AC13).**
**Business invariant protected:** the `[src:N]` header sits *ahead of*
content-guard's fence so the citable id is **outside** the untrusted envelope
(D2). Load `content-guard` **first**, then `citations`; run a `net:fetch` stub.
Assert: content includes `<untrusted-content` (fenced) **and** includes `[src:`
**and** — asserted by index — `content.indexOf("[src:") === 0` (or at least
`< content.indexOf(STANDING_NOTE)` **and** `< content.indexOf("<untrusted-content")`),
so the test cannot pass with the header buried inside the envelope. Import
`STANDING_NOTE`? It is not exported; assert against the literal `<untrusted-content`
index and `[src:` index (the design's "or at least" clause permits the
`<untrusted-content` index comparison). Confirm content-guard idempotency is
intact (single fence).
- **No production-code change required** beyond registering `citations` after
  `content-guard` *in the test's load order* — the extension itself does not know
  about content-guard. This is a wiring/ordering assertion, not new impl.
- Acceptance: AC13 green; `npm run typecheck` 0.

**T12 — TEST: clean dispose — no leak (AC12).**
**Business invariant protected:** after `host.unload("citations")`, a subsequent
run adds **no** header — the `afterToolCall` hook and `on` handlers are gone (no
leaked registrations). Mirror `test/content-guard.test.ts:189-198`.
- Acceptance: AC12 green (the never-throw dispose loop from T2 already returns all
  disposers).

**T13 — Final fail-safe + posture review (no new behavior).**
Re-read the extension against §8: confirm `afterToolCall` and `agent_end`
handlers each fail open (try/catch, return original/no-op on throw); confirm the
dispose loop swallows throws; confirm `enabled` and `warnMissing` defaults are
`false`; confirm no provider call, no block/steer anywhere; confirm no new
capability is declared (§5 — `citations` declares none, like `content-guard`).
- Acceptance: `node --import tsx --test test/citations.test.ts` passes;
  `npm run typecheck` exits 0; `npm test` exits 0 (full suite green;
  `content-guard.test.ts` unaffected).

### Exit condition

- `node --import tsx --test test/citations.test.ts` — all assertions pass (AC1–AC14).
- `npm run typecheck` — exit 0.
- `npm test` — exit 0 (entire offline suite green, including unchanged
  `content-guard.test.ts`).
- Only `src/extensions/citations.ts`, `test/citations.test.ts`,
  `docs/design/2026-06-22-citations.md` (status/closeout), and this implementation
  doc touched. `src/host.ts`, `CLAUDE.md`, `README.md` **untouched**.

---

## 3. Engineering Constraints Index

**House rules (CLAUDE.md "House conventions"):**

- **ESM + NodeNext:** always use `.js` import specifiers even for `.ts` files
  (`import type { ExtensionAPI } from "../kernel/extension.js"`,
  `import type { ToolResult } from "../kernel/types.js"`).
- **Strict TypeScript:** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. **No `any`** — model
  the types (use `e.store.get<T>(key, default)` with explicit type args).
- **Zero runtime dependencies except `jiti`.** Pure Node only — string/regex ops
  for parsing; no new npm deps, no SDK.
- **Capability-gated where it has side effects:** `citations` declares **no** new
  capability — it only reformats an already-permitted tool result and logs
  (matches `content-guard`, §5). Do not add one.
- **Offline `node:test` via `tsx`, against the scriptable `MockProvider`.** No
  network, no `ANTHROPIC_API_KEY`. Keep it that way.
- **Kill-switch env var** (`EAGENT_CITATIONS=off`) checked at activation, returns
  no-op disposer.
- **Never-throw dispose loop** over every tracked registration.
- **Fail open:** the handlers wrap their bodies so a throw never breaks the run.

**Batch-mode constraints (CRITICAL — this change only):**

- **Do NOT modify `src/host.ts`, `CLAUDE.md`, or `README.md`.** Registration in
  `BUILTIN_EXTENSIONS` and the inventory/count line are **deferred to a separate
  batch-integration step** (marked deferred in the design Deliverables).
- Tests **must** load the extension directly via `host.use("citations",
  activate)` (the established offline pattern, `test/recovery.test.ts:118`) and
  **must NOT** depend on the extension being in `BUILTIN_EXTENSIONS`.
- **Do NOT bump the README extension count.**
- Only touch: `src/extensions/citations.ts`, `test/citations.test.ts`,
  `docs/design/`, `docs/implementation/`.

**Commit conventions:**

- Prefix: `feat(phaseN)` for new work, `fix(phaseN-roundR)` for review-fix rounds
  (single phase → `feat(phase1)`).
- Trailers: include `npm test` and `npm run typecheck` results.
- **No mention of AI / model / tooling** in commit messages.

---

## 4. Data / Fixture Dependencies

- **`test/helpers.ts` — reuse, do not reinvent.** `makeHarness({ responder,
  logger })` builds the Agent + MockProvider + ExtensionHost + CommandRegistry.
  `lastText(agent)` is the canonical last-assistant-text extractor (the same logic
  the extension's `agent_end` validator implements). Pass a **capturing logger**
  via `makeHarness({ logger })` to spy on `e.log.warn` (AC6/AC9). The
  default `silentLogger` is in this file if you need a no-op.
- **Inline stub retrieval tools:** copy the `stubTool(name, caps, result)`
  helper from `test/content-guard.test.ts:66-80` (grants caps, registers a
  `defineTool` whose `execute` returns `ok(content)`/`fail(content)`). Use it to
  make `net:fetch`, `fs:read`, and `shell:exec` stubs.
- **First-tool-result reader:** copy `firstResultContent(agent)` from
  `test/content-guard.test.ts:82-87`.
- **Scripted `MockProvider`** (`src/providers/mock.ts`): `provider.script([{
  toolCalls: [{ name, arguments: {} }] }, { text: "final answer with [src:1] and
  [src:9]" }])`. The **final** `{ text }` turn is the answer the `agent_end`
  validator parses.
- **No filesystem fixtures, no temp dirs needed** — all tools are inline stubs;
  the id map is in-memory and per-run.

---

## 5. Regression Protection

The full offline suite must stay green (`npm test` exit 0). In particular:

- **`test/content-guard.test.ts` must remain unaffected.** `citations` shares the
  `afterToolCall` seam but is loaded independently in its own tests; content-guard
  tests load only `content-guard` (and, in one case, `recovery`). Because this
  change does **not** touch `host.ts`, `citations` is not in `BUILTIN_EXTENSIONS`
  and cannot perturb any other test's wiring. Confirm content-guard's
  fence/idempotency assertions (AC3–AC9 there) still pass.
- **`test/recovery.test.ts`** — the other `afterToolCall` consumer; unchanged.
- **Every per-primitive/per-extension test under `test/`** must stay green —
  this change adds two files and touches no kernel or shared wiring, so there is
  no expected fan-out, but `npm test` is the gate.
- Acceptance for regression: `npm test` exits 0 with no new failures or skips
  attributable to this change.
