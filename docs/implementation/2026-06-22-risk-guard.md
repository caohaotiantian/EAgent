# Implementation: `risk-guard` — LLM-based semantic risk analyzer

Slug: `2026-06-22-risk-guard`
Status: draft
Design doc: `docs/design/2026-06-22-risk-guard.md`

## 1. Task Index

| Design artifact | Location |
| --- | --- |
| Deliverables (6) | `docs/design/2026-06-22-risk-guard.md` §2 |
| Scope Boundary | §3 |
| Decision 4.1 capability-scoped analysis | §4.1 |
| Decision 4.2 off by default + env switch | §4.2 |
| Decision 4.3 ask/block mode (+ no-UI fail-closed approver) | §4.3 |
| Decision 4.4 verdict protocol + parse rule | §4.4 |
| Decision 4.5 fail-open on analyzer failure | §4.5 |
| Decision 4.6 no capability + recursion safety | §4.6 |
| Acceptance Criteria (10) | §7 |

`<TEST-CMD>` = `npm test` (`node --import tsx --test "test/**/*.test.ts"`).

## 2. Phase Breakdown

**Single Phase** — one self-contained guard extension, its test, a one-line host
registration, one `CLAUDE.md` inventory line, and one small additive change to
the shared test helper (`makeHarness` gains an optional `logger`, to let the
fail-open test assert the warning). Splitting would leave `<TEST-CMD>` unable to
import a half-written module, so it stays one Phase.

### Phase 1 — the `risk-guard` extension

**Entry condition**: L1 design passed (it has). No prior Phase.

**Design references**: `docs/design/2026-06-22-risk-guard.md` §2, §3, §4.1–§4.6,
§7 (all 10 criteria), §8.

**Module shape to build** (`src/extensions/risk-guard.ts`) — closures inside
`activate`, mirroring `flow-guard.ts`, plus one exported pure function so the
verdict parser is unit-testable (mirrors `prune.ts`'s exported pure function):

- `type Mode = "ask" | "block";`
- `const DEFAULT_SENSITIVE_CAPS = ["shell:exec"];`
- `const CLASSIFIER_SYSTEM_PROMPT` — a fixed prompt instructing the model to
  reply on one line starting with `SAFE` or `RISKY`, optionally `: <reason>`.
  (The planned tests do not branch on this text — their `MockProvider` subclass
  returns the verdict unconditionally — so no routing sentinel is required; the
  prompt only needs to be a clear, stable classification instruction.)
- `export interface Verdict { risky: boolean; reason?: string }`
- `export function parseVerdict(reply: string): Verdict | undefined` — pure.
  Read the first non-empty line; upper-case its leading whitespace-delimited
  token. Mapping (traces to design §4.4 + §4.5):
  - leading token `RISKY` → `{ risky: true, reason }` where `reason` is the text
    after the first `:` trimmed (may be empty; a missing colon is **not** a
    failure — empty reason is valid).
  - leading token `SAFE` → `{ risky: false }`.
  - anything else, or an empty/whitespace-only reply → `undefined`
    (unrecognized → the caller fails open *with a warning*).
- `cfg()` — reads, each call:
  - `enabled`: `process.env.EAGENT_RISK_GUARD === "off" ? false :
    (e.store.get<boolean>("enabled", false) ?? false)` — **off by default**
    (design §4.2; note the default is `false`, unlike `flow-guard`'s `true`).
  - `mode`: `e.store.get<Mode>("mode", "ask") ?? "ask"`.
  - `sensitiveCaps`: `e.store.get<string[]>("sensitiveCaps",
    DEFAULT_SENSITIVE_CAPS) ?? DEFAULT_SENSITIVE_CAPS`.
- `capsOf(name)` = `e.agent.tools.get(name)?.capabilities ?? []`
  (verbatim `flow-guard.ts:114`).
- `async classify(call: ToolCallBlock): Promise<Verdict | undefined>` — the
  recursion-safe sub-call (design §4.6, pattern from `memory.ts:78-93`):
  `const provider = e.agent.providers.get(); if (!provider) return undefined;`
  then stream `{ systemPrompt: CLASSIFIER_SYSTEM_PROMPT, messages: [oneUserMsg],
  tools: [], model: e.agent.model, signal: new AbortController().signal }`,
  concatenating the `done` event's assistant text; `return parseVerdict(text)`.
  `oneUserMsg` is a `Message` literal
  `{ role: "user", content: [{ type: "text", text: \`Tool: ${call.name}\nArguments: ${JSON.stringify(call.arguments)}\` }] }`
  (the `Message`/`text` shape from `src/kernel/types.ts`).
  Wrap the whole body in `try/catch`; on any throw return `undefined`.
- `e.hook("beforeToolCall", async (decision, ctx) => { … })`:
  1. `const { enabled, mode, sensitiveCaps } = cfg();`
  2. `if (!enabled || decision.block) return decision;` (passthrough — design
     §3, AC-5/AC-6; mirrors `flow-guard.ts:163`).
  3. `if (!capsOf(ctx.call.name).some((c) => sensitiveCaps.includes(c))) return
     decision;` (out-of-scope → no provider call; AC-4).
  4. `const verdict = await classify(ctx.call);`
  5. `if (verdict === undefined) { e.log.warn("risk-guard: classifier
     unavailable/unparseable; allowing", ctx.call.name); return decision; }`
     (fail open + observable; design §4.5, AC-7).
  6. `if (!verdict.risky) return decision;` (SAFE → pass; AC-3).
  7. Build `why = \`risk-guard: ${ctx.call.name} flagged risky${verdict.reason ?
     ": " + verdict.reason : ""}\``.
  8. `if (mode === "block") return { ...decision, block: true, reason: why };`
     (AC-1).
  9. `const allow = await e.agent.ui.confirm(\`${why}. Allow?\`); return allow ?
     decision : { ...decision, block: true, reason: \`risk-guard: denied — \` +
     why };` (AC-2; with no real UI, `confirm()` resolves `false` → blocks, the
     §4.3 fail-closed-approver behavior).
- `e.registerCommand({ name: "risk-guard", … })` — `on` / `off` set
  `enabled`; `ask`/`block` set `mode`; `status` (default) prints
  `risk-guard <on|off> (mode=…); sensitive=<caps>`. No throw on any arg.
- `activate` returns a teardown disposing the hook + command (mirror
  `flow-guard.ts:233-242`). No `e.grantCapability` (design §4.6).

**Helper change** (`test/helpers.ts`): add an optional `logger?: Logger` to the
`makeHarness` options and pass it to both the `Agent` and the `ExtensionHost`
(default stays `silentLogger`). Purely additive; every existing caller omits it
and is unaffected.

**Task list (TDD order — tests first):**

1. **TEST** `test/risk-guard.test.ts` — `parseVerdict`:
   *Invariant: only a `RISKY` leading token blocks; `SAFE` passes; anything else
   is unrecognized (→ caller fails open).* Assert:
   `parseVerdict("RISKY: deletes home")` → `{risky:true, reason:"deletes home"}`;
   `parseVerdict("RISKY (no colon)")` → `{risky:true, reason:""}` (missing colon
   is not a failure); `parseVerdict("SAFE")` → `{risky:false}`;
   `parseVerdict("safe, looks fine")` → `{risky:false}` (case-insensitive token);
   `parseVerdict("")` and `parseVerdict("I think maybe...")` → `undefined`;
   leading/blank lines are skipped to the first non-empty line.
2. **TEST** AC-1 risky→block: build the harness, register a tool with
   `capabilities:["shell:exec"]`, register risk-guard, set store `enabled=true`,
   `mode="block"`; install a classifier provider (a `MockProvider` subclass, set
   as default) that returns `"RISKY: removes the home directory"` and counts
   `stream` calls. Invoke
   `await h.agent.hooks.apply("beforeToolCall", {block:false, arguments:{}},
   {call:{type:"tool_call", id:"1", name:"run_shell", arguments:{cmd:"rm -rf ~"}}})`.
   Assert the returned `decision.block === true` and `decision.reason` includes
   `"removes the home directory"`, and the classifier was called once.
3. **TEST** AC-2 risky→ask: same setup, `mode="ask"`, classifier returns
   `"RISKY: …"`. With `makeHarness({ ui: { confirm: async () => false, notify(){} } })`
   the returned `decision.block === true`; with `confirm: async () => true` it is
   `false`. Assert `confirm` was called exactly once (count it in the stub).
4. **TEST** AC-3 safe→pass: classifier returns `"SAFE"`; in-scope tool; the
   returned decision is unchanged (`block===false`) and the UI `confirm` was
   **not** called.
5. **TEST** AC-4 out-of-scope→no call: register a tool with
   `capabilities:["fs:read"]` only; `enabled=true`; apply the hook for that tool;
   assert the classifier `stream`-call counter is `0` and the decision passes.
6. **TEST** AC-5 already-blocked passthrough: apply the hook with an input
   `{block:true, reason:"upstream", arguments:{}}` for an in-scope tool; assert
   the returned decision is unchanged (`block===true`, same reason) and the
   classifier counter is `0`.
7. **TEST** AC-6 disabled→no call: leave `enabled` at its default (do not set it)
   — assert an in-scope risky call passes with classifier counter `0`; then set
   `EAGENT_RISK_GUARD="off"` (saved/restored in `finally`, per
   `prune.test.ts:208-219`) with `enabled=true` and assert the same.
8. **TEST** AC-7 fail-open: (a) classifier provider whose `stream` throws →
   decision passes (`block===false`); (b) classifier returns a garbled line
   (`"hmm not sure"`) → decision passes. In both, assert a warning was recorded.
   The test constructs its **own** recording logger (an object whose `warn`
   pushes to an array) and passes it via `makeHarness({ logger })`, keeping its
   own reference to that object — it is **not** read back off the `Harness`
   (do not add a `logger` field to `Harness`). Note `e.log` is the *prefixed*
   extension logger (`extension.ts` `prefixed(logger,"risk-guard")`), so `warn`
   receives a leading `[risk-guard]` tag argument **plus** the message; assert on
   `warn` being called and on a **substring** of the message (e.g. `/risk-guard/`
   or `/allow/`), never exact first-argument equality. No throw escaped.
   The **no-provider** branch (`if (!provider) return undefined` → warn + pass)
   is covered transitively: it lands on the identical fail-open path as (a)/(b),
   and `parseVerdict("")` → `undefined` is unit-tested in task 1 — no provider
   deregistration is attempted (the harness always registers the mock default).
9. **TEST** AC-8 registration: via the harness, assert activating risk-guard adds
   exactly **one** `beforeToolCall` listener and **one** command, **zero** tools
   (delta assertions, per `prune.test.ts:222-233` adapted to `beforeToolCall`).
10. **TEST** AC-9 command: `/risk-guard on` then `status` reports `on`; `off`
    reports `off`; `ask`/`block` switch the mode (observe via `status` text);
    after `off`, an in-scope risky call passes with classifier counter `0`. No
    subcommand throws.
11. **IMPL** Write `src/extensions/risk-guard.ts` to satisfy tasks 1–10.
12. **IMPL** Add the optional `logger?` to `test/helpers.ts` `makeHarness`
    (additive).
13. **IMPL** Register `["risk-guard", riskGuard]` in `src/host.ts`
    `BUILTIN_EXTENSIONS` (after `flow-guard`, its sibling) + import.
14. **DOC** Add one inventory bullet to `CLAUDE.md` "Where things live"
    describing `risk-guard`.

**Per-task acceptance commands** (repo root):
- Targeted: `node --import tsx --test test/risk-guard.test.ts`
- Typecheck: `npm run typecheck`
- Full regression: `npm test`

**Exit condition**: `node --import tsx --test test/risk-guard.test.ts` → `# fail
0` covering AC-1…AC-9; `npm run typecheck` exit 0; `npm test` exit 0 (`# fail 0`,
0 skipped). `risk-guard` is in `BUILTIN_EXTENSIONS` and the `CLAUDE.md`
inventory.

## 3. Engineering Constraints Index

- **Engineering norms** (`CLAUDE.md` "House conventions"): ESM + NodeNext with
  `.js` specifiers even for `.ts`; strict TS (`noUncheckedIndexedAccess` etc.);
  **zero runtime deps except `jiti`** (Node built-ins only; the classifier uses
  the existing provider abstraction, not a new SDK); capabilities are the
  security vocabulary — this guard declares **no new capability** (it performs no
  side effect of its own, like `memory.ts`); every extension ships offline tests
  via `node:test` through `tsx`.
- **Four-corner subagent template**: `references/loop-3-development.md`.
- **Commit conventions**: `feat(phase1):` opener; `fix(phase1-roundR): <keyword>`
  within-round; `<TEST-CMD>`/`<ACCEPT-CMD>` trailers; no AI/model/tooling
  mentions.

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness` (extended with the optional `logger`).
- The classifier provider is a small **in-test `MockProvider` subclass** that
  counts `stream` calls and returns a per-test verdict string (or throws); no
  committed fixtures, no network. Because the unit ACs invoke the guard via
  `h.agent.hooks.apply("beforeToolCall", …)` directly (not the full agent loop),
  every `stream` call observed by that provider is a classifier call, which makes
  the "no provider call" assertions (AC-4/5/6) a simple counter check.
- Env vars touched (`EAGENT_RISK_GUARD`) and store flags are reset per test;
  env saved/restored in `finally` per `prune.test.ts:208-219`.

## 5. Regression Protection

- Phase 1; the regression surface is the **full existing suite** — `npm test`
  exit 0 (`# fail 0`, 0 skipped).
- The optional `logger` added to `makeHarness` is additive (default
  `silentLogger`); confirm no existing test breaks by re-running `npm test` after
  task 12. No existing test asserts an exact `makeHarness` option shape.
- Registering a new builtin in `host.ts` is additive; no test asserts a builtin
  count (verified for the prior `microagents` task; re-confirm with `npm test`).
- The new `beforeToolCall` listener returns the input decision unchanged on every
  path except an enabled+in-scope+RISKY verdict, so it cannot disturb
  `flow-guard`/`bash-policy`/`write-guard` decisions when off (the default) or
  out of scope.
