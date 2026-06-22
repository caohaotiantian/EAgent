# Implementation: `secret-guard` — keep secret VALUES out of tool args (and the transcript)

Slug: `2026-06-22-secret-guard`
Status: draft
Design doc: `docs/design/2026-06-22-secret-guard.md`

This guide drives a fresh agent through TDD development of `secret-guard`. It
introduces **no requirement absent from the design** — every task traces to a
design Deliverable (§2), Decision (§4), or Acceptance Criterion (§7). The build
is **batch mode**: it touches only the new extension module, its test, and this
doc. It does **not** edit `src/host.ts`, `CLAUDE.md`, or `README.md` — those are
deferred to a separate batch-integration step (design §2, the two `(deferred to
batch integration)` deliverables).

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7) to the phase
task that discharges it.

| Design artifact | Where in design | Discharged by |
| --- | --- | --- |
| Deliverable: `src/extensions/secret-guard.ts` (`activate` → one `beforeToolCall` filter + one `/secret-guard` command, dispose loop that never throws) | §2 | Tasks 9, 10, 11 |
| Deliverable: exported pure `scanSecrets(value): string[]` (returns KINDS, never the matched substring) | §2 | Task 1 (TEST), Task 9 (IMPL) |
| Deliverable: exported pure `scanArgs(args): string[]` (walks strings nested in arrays/objects, de-duped kinds) | §2 | Task 2 (TEST), Task 9 (IMPL) |
| Deliverable: known-credential pattern set copied **with attribution** from `flow-guard`'s `DEFAULT_SENSITIVE_CONTENT` (`flow-guard.ts:55-60`) — PEM / `AKIA…` / `sk-…` / `ghp_…`, no entropy gate | §2, §4 D1, D4 | Task 9 (IMPL) |
| Deliverable: `beforeToolCall` filter scoped to *leak-capable* tools (default `net:fetch`, `shell:exec`; store-overridable `leakCaps`), ask/block, names kind only | §2, §4 D2, D3 | Tasks 3–6 (TEST), Task 10 (IMPL) |
| Deliverable: `/secret-guard [on|off|ask|block|status]` command | §2 | Task 8 (TEST), Task 11 (IMPL) |
| Deliverable: kill switch `EAGENT_SECRET_GUARD=off` (checked in `cfg()`) | §2, §4 D5 | Task 6 (TEST), Task 9 (IMPL) |
| Deliverable: offline tests in `test/secret-guard.test.ts`, loaded via `host.use(id, activate)`, NOT depending on `BUILTIN_EXTENSIONS` | §2, §7 | Tasks 1–8 |
| Deliverable: `host.ts` `BUILTIN_EXTENSIONS` registration | §2 — **(deferred to batch integration)** | **Not in this phase** |
| Deliverable: `CLAUDE.md` / `README.md` inventory line, README count **not** bumped | §2 — **(deferred to batch integration)** | **Not in this phase** |
| Deliverable: this implementation log, reconciled at closeout | §2 | This file + Closure note |
| AC-1 each pattern matches its kind | §7 | Task 1 |
| AC-2 no false positive on benign | §7 | Task 1 |
| AC-3 value never echoed by `scanSecrets` | §7 | Task 1 |
| AC-4 benign-cap tool never gated, no confirm | §7 | Task 3 |
| AC-5 block mode blocks a leaky secret call, reason names kind, no literal value | §7 | Task 4 |
| AC-6 ask mode: deny blocks, allow passes, confirm once | §7 | Task 4 |
| AC-7 no secret → no prompt, no block | §7 | Task 5 |
| AC-8 kill switch (`EAGENT_SECRET_GUARD=off`), env restored in `finally` | §7 | Task 6 |
| AC-9 command toggles (`off`/`block`/`status`) | §7 | Task 8 |
| AC-10 clean teardown via `host.unload` | §7 | Task 7 |
| AC-11 nested args walked (arrays/objects) | §7 | Task 2 |
| Scope Boundary: no arg rewriting, no asterisk `transformContext` hook, no entropy gate, no non-leak-cap gating, no transcript scrubbing, no new capability | §3, §4 D6 | Honored by omission (no task adds these) |

## 2. Phase Breakdown

**Single Phase.** One self-contained guard extension plus its offline test. The
two integration deliverables (`host.ts` registration, `CLAUDE.md`/`README`
inventory) are **deferred to batch integration** and are explicitly **not** part
of this phase — so there is nothing separable to split off. Splitting the module
from its test would leave the targeted test command unable to import a
half-written module, so it stays one Phase.

### Phase 1 — the `secret-guard` extension

**Entry condition.** L1 design `docs/design/2026-06-22-secret-guard.md` is PASSED
(it is). No prior phase. The reference siblings already exist in-tree:
`src/extensions/flow-guard.ts` (regex source, D1), `src/extensions/risk-guard.ts`
(closest structural sibling — same `beforeToolCall` seam, same dual-mode command
shape), and the offline test patterns in `test/risk-guard.test.ts` /
`test/recovery.test.ts` (the `host.use` / `host.unload` load pattern).

**Design references.** §2 (Deliverables), §3 (Scope Boundary), §4 D1–D6, §5
(Dependencies — kernel `beforeToolCall` contract, `e.agent.ui.confirm`,
`capsOf`), §7 (all 11 ACs), §8 (Risks — the "secret value never echoed"
property).

**Module shape to build** (`src/extensions/secret-guard.ts`) — closures inside
`activate`, mirroring `risk-guard.ts`, plus **two** exported pure functions so
the detector is unit-testable in isolation (mirrors `risk-guard.ts`'s exported
`parseVerdict` and `prune.ts`'s exported pure function):

- `type Mode = "ask" | "block";`
- **Attribution comment + pattern table.** Copy `flow-guard`'s four credential
  regexes **verbatim with an attribution comment** (design D1 — copy, do *not*
  import flow-guard's non-exported `const`, to avoid load-order/circular coupling).
  Source is `flow-guard.ts:55-60`:
  - `-----BEGIN [A-Z ]*PRIVATE KEY-----` → kind `pem-private-key`
  - `AKIA[0-9A-Z]{16}` → kind `aws-access-key-id`
  - `sk-[A-Za-z0-9_-]{16,}` → kind `openai-secret-key` (any label containing
    `sk-`/`openai` satisfies AC-1/AC-5's `/sk-|openai/` matcher)
  - `ghp_[A-Za-z0-9]{36}` → kind `github-token`
  Represent as a list of `{ kind: string; re: RegExp }` (compile each with flag
  `"i"`, matching flow-guard's `compile`). **No entropy gate** (design D4). The
  pattern set should be shaped so an entropy gate is a later one-function
  addition, but ship v1 on the anchored patterns only.
- `export function scanSecrets(value: string): string[]` — **pure**. Returns the
  de-duplicated list of KIND labels whose regex matches `value`. Returns `[]` for
  a non-string or no match. **MUST NOT return the matched substring** — only kind
  labels (design §2, §8, AC-3). Iterate the pattern table, push `kind` on a
  `re.test(value)` hit, de-dup before returning.
- `export function scanArgs(args: Record<string, unknown>): string[]` — **pure**.
  Walk the argument *values* recursively: for a `string`, union in
  `scanSecrets(s)`; for an array, recurse each element; for a plain object,
  recurse each value; ignore numbers/booleans/null/undefined. Return the
  de-duplicated union of kinds (AC-11). A small internal recursive `walk(v)` over
  `unknown` keeps it `noUncheckedIndexedAccess`-safe (no index assumptions).
- `const DEFAULT_LEAK_CAPS = ["net:fetch", "shell:exec"];` (design D2; matches how
  `flow-guard` defines egress `net:fetch` and `risk-guard` scopes `shell:exec`).
- `cfg()` — reads, each call (mirror `flow-guard.ts:75-87` / `risk-guard.ts:78-83`):
  - `enabled`: `process.env.EAGENT_SECRET_GUARD === "off" ? false :
    (e.store.get<boolean>("enabled", true) ?? true)` — **on by default** (design
    D5; note the default is `true`, like `flow-guard`, unlike `risk-guard`).
  - `mode`: `e.store.get<Mode>("mode", "ask") ?? "ask"` — default `ask` (D3/D5).
  - `leakCaps`: `e.store.get<string[]>("leakCaps", DEFAULT_LEAK_CAPS) ??
    DEFAULT_LEAK_CAPS` (store-overridable, D2).
- `capsOf(name)` = `e.agent.tools.get(name)?.capabilities ?? []` (verbatim
  `flow-guard.ts:114` / `risk-guard.ts:86`, the `capsOf` pattern from D2/§5).
- `e.hook("beforeToolCall", async (decision, ctx) => { … })` — wrap the body in
  `try/catch`, **fail open** (on any throw `return decision` and `e.log.warn`):
  1. `const { enabled, mode, leakCaps } = cfg();`
  2. `if (!enabled || decision.block) return decision;` — passthrough when off,
     and **pass an already-blocked decision through untouched** (never un-block;
     design §8 hook-ordering, AC-5/AC-10 teardown; mirrors `risk-guard.ts:125`).
  3. `if (!capsOf(ctx.call.name).some((c) => leakCaps.includes(c))) return
     decision;` — out-of-scope (non-leak-capable) tools pass with no scan and no
     confirm (design D2, AC-4).
  4. Scan args. Prefer `decision.arguments` (the validated args the loop threads
     in, §5); `ctx.call.arguments` is the equivalent pre-validation copy and
     either is acceptable. If `decision.arguments` may be `{}` in a test that
     puts the secret only on `ctx.call.arguments`, union both — but the planned
     tests place the secret on the call args (`applyHook` passes args through the
     `ctx.call`), so scanning `ctx.call.arguments` is sufficient and simplest.
     `const kinds = scanArgs(ctx.call.arguments);`
  5. `if (kinds.length === 0) return decision;` — no secret → no prompt, no block
     (AC-7).
  6. Build the reason from **kind labels only**, never the value:
     `const why = \`secret-guard: a ${kinds.join(", ")} value is about to be sent
     via ${ctx.call.name}\`;`
  7. `if (mode === "block") return { ...decision, block: true, reason: why };`
     (AC-5).
  8. `const allow = await e.agent.ui.confirm(\`${why}. Allow?\`); return allow ?
     decision : { ...decision, block: true, reason: \`secret-guard: denied — \` +
     why };` (AC-6; with a denying UI `confirm()` resolves `false` → blocks).
  9. **The reason and the `ui.confirm` prompt MUST NOT contain the literal secret
     value** — only `kinds` (design §8, AC-3/AC-5). `kinds` comes from
     `scanArgs`/`scanSecrets`, which by contract return labels, not matches.
- `e.registerCommand({ name: "secret-guard", … })` — `on`/`off` set `enabled`;
  `ask`/`block` set `mode`; `status` (default) prints a line containing the
  on/off state, `mode=…`, and `leakCaps` (AC-9). No throw on any arg. Mirror
  `risk-guard.ts:141-168` / `flow-guard.ts:191-231`.
- `activate` returns a teardown disposing the hook + command in a loop with a
  per-dispose `try/catch` that **never throws** (mirror `risk-guard.ts:170-178`).
  **No `e.grantCapability`** — secret-guard has no side effect of its own (design
  §3, last bullet: no new capability).

**Test scaffolding to build** (`test/secret-guard.test.ts`) — adapt the
`test/risk-guard.test.ts` harness scaffolding (it is the closest sibling):

- `import secretGuard, { scanSecrets, scanArgs } from
  "../src/extensions/secret-guard.js";` and `import { defineTool } from
  "../src/kernel/define.js";`, `import type { ExtensionAPI } from
  "../src/kernel/extension.js";`, `import type { UI } from
  "../src/kernel/types.js";`, `import { makeHarness, type Harness } from
  "./helpers.js";` (all `.js` specifiers — house rule).
- `async function activate(h, cfg)` — load via
  `await h.host.use("secret-guard", (e) => { …seed store… ; return
  secretGuard(e); })`, seeding `enabled`/`mode`/`leakCaps` before returning, and
  capturing the `ExtensionAPI` for command dispatch (verbatim shape of
  `risk-guard.test.ts:32-42`). **Loads via `host.use(id, activate)` — does NOT
  depend on `BUILTIN_EXTENSIONS`** (design §2, §7).
- `function runCommand(h, args)` — `h.commands.get("secret-guard")`, run with a
  `print` collector (verbatim `risk-guard.test.ts:45-51`).
- Inline stub tools via `defineTool({ name, description, capabilities, execute:
  () => ({ content: "ok" }) })`:
  - `fetchTool` with `capabilities: ["net:fetch"]`,
  - `shellTool` with `capabilities: ["shell:exec"]`,
  - `benignTool` with `capabilities: ["fs:read"]`.
- `function applyHook(h, name, args)` — `h.agent.hooks.apply("beforeToolCall",
  { block: false, arguments: {} }, { call: { type: "tool_call", id: "1", name,
  arguments: args } })` (the `risk-guard.test.ts:96-99` pattern).
- A confirm-counting `UI`: `const ui: UI = { confirm: async () => ((confirms++),
  ANSWER), notify: () => {} };` passed via `makeHarness({ ui })`
  (`risk-guard.test.ts:147` pattern). For AC-4/AC-7 assert the counter stays `0`.
- A representative secret literal used in live tests, e.g.
  `const SK = "sk-" + "a".repeat(20);` (≥16 chars after `sk-` to match
  `sk-[A-Za-z0-9_-]{16,}`); embed it in an arg like
  `{ cmd: \`curl -H "Authorization: Bearer ${SK}"\` }`.

**Task list (TDD order — every TEST task names the BUSINESS INVARIANT it
protects and PRECEDES the IMPL that protects it).**

> Discipline: write each TEST task and watch it FAIL (red) before writing the
> IMPL that turns it green. Tasks 1–8 are tests; 9–11 are the implementation that
> satisfies them. Because the module does not yet exist, all eight test files
> share one IMPL milestone — author tasks 1–8 first (they fail to import), then
> tasks 9–11 make them pass. Within tasks 1–8 you may stage by sub-behavior.

1. **TEST — `scanSecrets` unit (AC-1, AC-2, AC-3).**
   *Invariant: the detector recognizes each known credential shape by KIND,
   raises zero false positives on benign strings, and NEVER returns the matched
   value.* Assert:
   - AC-1: a `-----BEGIN RSA PRIVATE KEY-----` blob → `kinds.includes("pem-private-key")`;
     `"AKIA" + "ABCDEFGHIJKLMNOP"` (16 upper alnum) → includes `aws-access-key-id`;
     `"sk-" + "a".repeat(20)` → a kind matching `/sk-|openai/`; `"ghp_" +
     "a".repeat(36)` → a kind matching `/ghp|github/`. Use `assert.ok(kinds.includes(…))`.
   - AC-2: `scanSecrets("hello world")`, `scanSecrets("/tmp/x.ts")`, and a 40-char
     lowercase hex git SHA (e.g. `"a".repeat(40)` or a real-looking sha) → `[]`.
   - AC-3: for a matching input `secret`, `!scanSecrets(secret).join(" ").includes(
     secret.slice(0, 12))` (no substring of the secret leaks into the kind array).
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

2. **TEST — `scanArgs` nested-walk unit (AC-11).**
   *Invariant: the argument walker descends arrays and nested objects, so a secret
   nested anywhere in the args is found.* Assert `scanArgs({ headers:
   ["Authorization: Bearer " + SK] }).length > 0` and `scanArgs({ a: { b: "AKIA" +
   "ABCDEFGHIJKLMNOP" } }).length > 0`; and a clean nested arg
   `scanArgs({ a: { b: "ls -la" } })` → `[]`.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

3. **TEST — benign-cap tool is never gated (AC-4).**
   *Invariant: a secret in the args of a non-leak-capable tool is NOT held — the
   guard fires only at the egress/exec boundary, so benign tools are never a
   false-positive source.* Register `benignTool` (`fs:read`), activate with
   `enabled:true`, apply the hook for `benignTool` with args carrying `SK`; assert
   the returned decision `block === false` and the confirm counter is `0`.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

4. **TEST — block mode holds a leaky secret call; ask mode deny/allow (AC-5, AC-6).**
   *Invariant: a secret value in a leak-capable tool's arg is HELD; in block mode
   the call is blocked with a reason that names the secret KIND and never the
   VALUE; in ask mode the human is asked and deny blocks / allow proceeds.*
   - AC-5 (block): `net:fetch` stub `post`, `enabled:true`, `mode:"block"`; apply
     hook with `{ headers: ["Authorization: Bearer " + SK] }` (or `shell:exec`
     stub with `{ cmd: 'curl -H "Authorization: Bearer ' + SK + '"' }`). Assert
     `out.block === true`, `out.reason` matches `/sk-|openai/`, **and**
     `!out.reason.includes(SK)` (the literal value is absent — AC-3/§8).
   - AC-6 (ask, deny): denying UI (`confirm: async () => ((confirms++), false)`),
     `mode:"ask"`; assert `out.block === true` and `confirms === 1`.
   - AC-6 (ask, allow): a fresh harness with allowing UI (`confirm: async () =>
     ((allows++), true)`), `mode:"ask"`; assert `out.block === false` and
     `allows === 1`.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

5. **TEST — clean args on a leak-capable tool pass without prompting (AC-7).**
   *Invariant: no secret in the args means no prompt and no block — the guard adds
   zero friction to ordinary leak-capable calls.* `shell:exec` stub, `enabled:true`,
   `mode:"ask"`, confirm counter; apply hook for `{ cmd: "ls -la" }`; assert
   `out.block === false` and the confirm counter is `0`.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

6. **TEST — kill switch disables the guard (AC-8).**
   *Invariant: `EAGENT_SECRET_GUARD=off` is an absolute off-ramp — a known secret
   on a leak-capable call passes and the user is never prompted.* Save
   `process.env.EAGENT_SECRET_GUARD`, set it to `"off"` inside a `try`, build a
   harness with a counting UI, register `shellTool`, activate with `enabled:true`,
   `mode:"block"`; apply hook for `{ cmd: '... ' + SK }`; assert `out.block ===
   false` and the confirm counter is `0`. **Restore the env var in `finally`**
   (per `risk-guard.test.ts:222-237` / `prune.test.ts` env save-restore).
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

7. **TEST — `host.unload` removes the `beforeToolCall` hook (AC-10).**
   *Invariant: teardown is clean — after unload the guard no longer intervenes and
   unload never throws.* Activate with `enabled:true`, `mode:"block"`; `await
   h.host.unload("secret-guard")`; then apply the hook for a `shell:exec` call
   carrying `SK`; assert `out.block === false` (the filter is gone). Optionally
   assert listener-count delta returns to baseline (the
   `risk-guard.test.ts:272-283` registration-delta pattern, applied around
   load→unload). The `host.unload` call must not throw.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

8. **TEST — `/secret-guard [on|off|ask|block|status]` works (AC-9).**
   *Invariant: the command is the runtime control surface — toggling it actually
   changes guard behavior, and `status` reports on/off, mode, and leakCaps.*
   Activate, register `shellTool`. `runCommand(h, "off")` then apply hook on a
   matching `shell:exec` call → `block === false`. `runCommand(h, "block")` then a
   subsequent matching call → `block === true`. `runCommand(h, "status")` joins to
   a string containing `on`/`off`, `mode=` (or the mode word), and a `leakCaps`
   token (e.g. `net:fetch` / `shell:exec`). No subcommand throws.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`

9. **IMPL — write `src/extensions/secret-guard.ts`: pure helpers + pattern table.**
   The attributed pattern table, `scanSecrets`, `scanArgs`, `DEFAULT_LEAK_CAPS`,
   `cfg()` (with the `EAGENT_SECRET_GUARD=off` kill switch and `enabled`/`mode`/
   `leakCaps` store reads), and `capsOf`. Turns tasks 1, 2, and the kill-switch
   half of task 6 green.
   - Acceptance: `node --import tsx --test test/secret-guard.test.ts`; `npm run typecheck`

10. **IMPL — the `beforeToolCall` filter.** Scope to leak-capable tools, scan
    args, pass an already-blocked decision through untouched, ask/block on a hit
    with a kind-only reason, `try/catch` fail-open. Turns tasks 3, 4, 5, 7 green.
    - Acceptance: `node --import tsx --test test/secret-guard.test.ts`; `npm run typecheck`

11. **IMPL — the `/secret-guard` command + dispose loop.** `on`/`off`/`ask`/
    `block`/`status`, and the teardown loop that disposes the hook and command and
    never throws. Turns tasks 7, 8 green.
    - Acceptance: `node --import tsx --test test/secret-guard.test.ts`; `npm run typecheck`

**Per-task acceptance commands** (runnable from repo root):
- Targeted: `node --import tsx --test test/secret-guard.test.ts`
- Typecheck: `npm run typecheck`
- Full regression: `npm test`

**Exit condition.**
- `node --import tsx --test test/secret-guard.test.ts` → `# fail 0`, covering
  AC-1…AC-11.
- `npm run typecheck` exit 0.
- `npm test` exit 0 (`# fail 0`, 0 skipped) — full suite green;
  `test/flow-guard.test.ts` unaffected.
- `src/host.ts`, `CLAUDE.md`, `README.md` are **untouched** (batch mode); the two
  integration deliverables remain `(deferred to batch integration)`.

## 3. Engineering Constraints Index

- **House conventions** (`CLAUDE.md` "House conventions"):
  - **ESM + NodeNext**: `.js` import specifiers even when importing a `.ts` file
    (e.g. `from "../kernel/extension.js"`, `from "../kernel/define.js"`).
  - **Strict TypeScript**: `strict`, `noUncheckedIndexedAccess`,
    `noImplicitOverride`, `noFallthroughCasesInSwitch` all on. **No `any`** —
    model the types (the recursive `walk` in `scanArgs` is typed over `unknown`).
  - **Zero runtime deps except `jiti`** — pure Node, regex only; no SDK, no new
    npm dependency.
  - **Capabilities are the security vocabulary** — secret-guard declares **no new
    capability** (no side effect of its own; matches `flow-guard`/`risk-guard`/
    `content-guard`, design §3).
  - **Kill-switch env var** — `EAGENT_SECRET_GUARD=off`, checked in `cfg()`.
  - **Dispose loop that never throws** — per-dispose `try/catch`.
  - **Every extension ships an offline `node:test` test** against the scriptable
    `MockProvider`/`makeHarness`; no network, no `ANTHROPIC_API_KEY`.
- **Hook surface used** (from the task brief / design §5):
  - `e.hook("beforeToolCall", (decision: ToolDecision, ctx: { call }) => …)` —
    the only filter registered; returns the decision, adding `block`/`reason`
    only on a hit.
  - `e.registerCommand({ name, description, run })` — the `/secret-guard` command.
  - `e.store.get/set` — `enabled`, `mode`, `leakCaps`.
  - `e.agent.tools.get(name)?.capabilities` (`capsOf`), `e.agent.ui.confirm`,
    `e.log.warn` (fail-open warning). `e.on(...)` is **not** needed (no observe
    events; single seam, design D6).
- **Batch-mode constraints (CRITICAL).** Do **NOT** modify `src/host.ts`,
  `CLAUDE.md`, or `README.md`. Do **NOT** add to `BUILTIN_EXTENSIONS`. Do **NOT**
  bump the README extension count. Tests MUST load via `host.use(id, activate)`
  and MUST NOT depend on the extension being a builtin. Only files touched this
  phase: `src/extensions/secret-guard.ts`, `test/secret-guard.test.ts`, this
  `docs/implementation/` log (and the `docs/design/` doc at closeout
  reconciliation).
- **Commit conventions.** `feat(phase1):` opener; `fix(phase1-roundR): <keyword>`
  for within-round fixes. Trailers carry `npm test` and `npm run typecheck`
  results. **No mention of AI/model/tooling** in commit messages.

## 4. Data and Fixture Dependencies

- **Reuse `test/helpers.ts` `makeHarness`** unchanged — `secret-guard` needs **no**
  helper change (unlike `risk-guard`, which added an optional `logger`; this guard
  does no model call and its tests do not assert on warnings, so `silentLogger`
  via the default harness is sufficient). Pass per-test `ui` through
  `makeHarness({ ui })` for the confirm-counting tests.
- **No committed fixtures, no network.** Secret literals are constructed inline in
  the test (e.g. `"sk-" + "a".repeat(20)`, `"AKIA" + "ABCDEFGHIJKLMNOP"`, `"ghp_"
  + "a".repeat(36)`, a `-----BEGIN RSA PRIVATE KEY-----` blob). The scriptable
  `MockProvider` from the harness suffices; the guard performs **no** provider
  call (pure regex), so no responder scripting is required for the live tests.
- **Inline stub tools** via `defineTool` declaring `net:fetch` / `shell:exec` /
  `fs:read` capabilities — the scope-resolution input for `capsOf`.
- **Env var touched** (`EAGENT_SECRET_GUARD`) and store flags are reset per test;
  the env var is saved before and **restored in `finally`** (AC-8, per
  `risk-guard.test.ts:222-237`).

## 5. Regression Protection

- **Single phase; the regression surface is the full existing suite** — `npm test`
  must end `# fail 0`, 0 skipped, after the phase.
- **`test/flow-guard.test.ts` must stay green** — secret-guard *copies* (does not
  import) flow-guard's regexes and does not modify `flow-guard.ts`, so flow-guard
  behavior is untouched (design §6, §8). Re-run the full suite to confirm.
- **The two sibling `beforeToolCall` guard tests stay green** —
  `test/risk-guard.test.ts`, `test/bash-policy.test.ts`, `test/write-guard.test.ts`
  (and any `test/content-guard.test.ts`). The new filter is **only loaded in its
  own test** (not added to `BUILTIN_EXTENSIONS` this phase), so it cannot appear
  on the seam in other tests' harnesses. Each guard only ever *adds* a `block` and
  never clears one, so composition is order-independent (design §8) — but in this
  phase composition is not even exercised outside `test/secret-guard.test.ts`.
- **No builtin-count assertion is disturbed** — because `host.ts` is **not**
  edited and the extension is **not** added to `BUILTIN_EXTENSIONS`, no test that
  counts builtins or asserts the README inventory can change. (This is precisely
  why batch mode keeps the integration deferred.)
- **`makeHarness` is unchanged**, so no existing caller is affected.

## Closure note

Phase 1 implemented on branch `20260622secretguard-dev-r1` (base
`c122bcea5a4842ebe6c318dbb00e0eaf76ad4a9c`). Built strictly TDD: the eight test
tasks (`test/secret-guard.test.ts`, 17 cases covering AC-1…AC-11) were authored
first and watched fail at red for the right reason — `ERR_MODULE_NOT_FOUND` on the
not-yet-existent `src/extensions/secret-guard.js` import — then the module
(`scanSecrets`/`scanArgs` pure helpers + attributed pattern table + `cfg()` with
the `EAGENT_SECRET_GUARD=off` kill switch + the leak-cap-scoped `beforeToolCall`
filter + the `/secret-guard` command + a never-throwing dispose loop) turned them
green. No `fix(phase1-roundR)` rounds were needed — the suite passed on the first
implementation pass.

Final results:
- Targeted: `node --import tsx --test test/secret-guard.test.ts` → tests 17,
  pass 17, fail 0.
- `npm run typecheck` → exit 0.
- `npm test` → tests 460, pass 460, fail 0, skipped 0 (full suite green;
  `test/flow-guard.test.ts` and the sibling guard tests unaffected).

Batch mode honored: `src/host.ts`, `CLAUDE.md`, and `README.md` are untouched —
only `src/extensions/secret-guard.ts`, `test/secret-guard.test.ts`, and these
two docs changed. The two integration deliverables (`host.ts` `BUILTIN_EXTENSIONS`
registration and the `CLAUDE.md`/`README` inventory line, count **not** bumped)
remain **deferred to batch integration**; the test loads the extension via
`host.use("secret-guard", activate)` and does not depend on it being a builtin.
