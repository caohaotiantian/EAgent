# Implementation: `playbook` extension

Task slug: `2026-07-09-playbook-extension` (matches `docs/design/2026-07-09-playbook-extension.md`).

## 1. Task Index

| Design artifact | Design doc location |
| --- | --- |
| Deliverables (extension file, host wiring, tests, README row) | `docs/design/2026-07-09-playbook-extension.md` §2 |
| Scope Boundary (no LLM curation, no model-facing tools, no embeddings/archive/counters, no kernel edits) | §3 |
| Key Design Decisions 1–6 (new ext; segment-exact delta-merge; per-entry store + `ord`; post-`compact` seam; 8 KB / 64 caps; no capability, off-by-default) | §4 |
| Acceptance Criteria 1–8 | §7 |
| Risks and Rollback | §8 |

## 2. Phase Breakdown

One Phase: the extension, its host wiring, and the README row are a single contiguous Deliverable block that lands together and leaves `npm test` green. (Splitting host-wiring into its own Phase would produce a Phase whose only content is a one-line array insert + README row — too thin to be independently meaningful. Per L2 granularity, size by scope, not time.)

### Phase 1 — the `playbook` extension, wired and tested

**Entry condition:** L1 design doc passed (it has). No prior Phase.

**Design document references:** `docs/design/2026-07-09-playbook-extension.md` §2 (Deliverables), §4 Decisions 1–6, §7 AC 1–8.

**Design shape to implement (from §4, restated so a fresh agent needs no session context):**
- `src/extensions/playbook.ts`, default-export `activate(e: ExtensionAPI): () => void` (return a dispose loop that never throws, mirroring `memory.ts:674-682`).
- **Storage (Decision 3):** one bullet per store key `bullet:<id>`, value `Bullet = { id: string; text: string; ord: number; ts: string }`. A monotonic `ord` comes from a persisted counter at store key `seq` (read-increment-write). Id generator copied from `memory.ts:547-549` (per-activation random base + counter; no `crypto`). Read helpers list `bullet:`-prefixed keys and sort ascending by `ord`.
- **Delta-merge (Decision 2):** `MERGE_SEP` = a prose-unlikely **ASCII** sentinel — use a control char such as `"\x1f"` (US, unit separator; invisible, ASCII, avoids the macOS non-ASCII grep gotcha per CLAUDE.md), rendered as a readable separator (e.g. `"; "`) only when building the injection text. Reject or strip a `delta` that itself contains the raw separator so it cannot forge segment boundaries. `add(text)` → new `Bullet` at the next `ord`, then enforce `MAX_BULLETS` by FIFO-dropping the lowest-`ord` bullet(s). `merge(id, delta)` → if `delta` exactly equals an existing `MERGE_SEP`-delimited segment of the target bullet's text, no-op; else set text = `text + MERGE_SEP + delta`. Deterministic, no provider handle anywhere in the file.
- **Injection (Decision 4/5):** `injectPlaybook(messages, bullets, config)` mirrors `injectMicroagents` (`microagents.ts:117-148`): returns `messages` **by reference** when the kill switch/disabled or when there is nothing to inject; else returns `[note, ...messages]` where `note` is `{ role:"system", content:[{type:"text",text}], meta:{ source:"playbook", ephemeral:true } }`. Bullets are rendered in `ord` order; fill whole bullets until adding the next would push the **whole message** (header + bodies + marker) over `MAX_INJECT_BYTES = 8*1024` — reserve header+marker bytes inside the budget (do NOT copy `microagents`' body-only cap); if any bullet is dropped append a single `… (N more not shown)` marker line. Enable gate: performed in the `activate` transformContext closure (where `e.store`/`e.config` are in scope) via `config.enabled("playbook", { default: false, store: e.store })` — the hard env veto `EAGENT_PLAYBOOK=off` is built into `enabled` (`store.ts:56`). `injectPlaybook`/`buildInjection` stay pure (bullets + `maxBytes` in, note out); the closure does the gate check and only calls them when enabled, so the exported pure functions need no `store` argument.
- **Command (Deliverable):** register `/playbook` with sub-commands `on | off | list | add <text> | merge <id> <text> | forget <id> | clear`. `on`/`off` set the stored `enabled` flag (`e.store.set("enabled", true/false)`). Under `EAGENT_PLAYBOOK=off`, `add`/`merge`/`forget`/`clear` report disabled and perform no store write (kill-switch parity, AC 7); `list`/`on`/`off` may still run. No capability (Decision 6).
- **Host wiring:** append `["playbook", playbook]` to `BUILTIN_EXTENSIONS` in `src/host.ts` **immediately after the `["microagents", microagents]` line** (host.ts:116), before `["limits", limits]` — and add the matching `import playbook from "./extensions/playbook.js";` next to the other extension imports.
- **README:** append one row to the extension table in `README.md` matching the existing column format (name/description • command `/playbook` • capability: none • kill switch `EAGENT_PLAYBOOK=off`).

**Exported surface for direct unit testing** (pure, host-free — mirrors microagents exporting `injectMicroagents`): export `injectPlaybook`, `mergeSegments(text, delta, sep)`, `buildInjection(bullets, maxBytes)` (returns the note text or `undefined`), and the `Bullet` type, plus the `default` `activate`.

**Task list, in TDD order** (write `test/playbook.test.ts` first; each test names the invariant it protects):

1. **TEST** `mergeSegments`: appending a new delta yields `text + SEP + delta`; a delta exactly equal to an existing segment is a **no-op** (idempotent); a delta that is a *substring of but not equal to* an existing segment **is** appended (segment-exact, not raw-substring). Protects Decision 2 determinism/non-collapse. *(AC 4)*
2. **TEST** `buildInjection` / `injectPlaybook` byte cap: given bullets whose combined size exceeds `MAX_INJECT_BYTES`, the produced note text's `Buffer.byteLength(text,"utf8") <= MAX_INJECT_BYTES` **and** contains the `more not shown` marker. Protects the always-on cost budget. *(AC 5a)*
3. **TEST** `injectPlaybook` identity: with the kill switch off (`envOnlyConfig()` + `EAGENT_PLAYBOOK=off`) OR disabled config, returns the input array by reference (`assert.strictEqual`), even with bullets present; with no bullets, also by reference. Protects the off-path zero-cost invariant. *(AC 1)*
4. **TEST** `injectPlaybook` injection shape: enabled + bullets `[b1,b2]` → new array, `out.length === input.length+1`, leading msg `role:"system"`, `meta.source:"playbook"`, `meta.ephemeral:true`, text contains both bodies in `ord` order. *(AC 2, pure-function level)*
5. **TEST** harness activate + real seam (two-phase): `makeHarness()`, `await host.use("playbook", activate)`. **(i)** while still disabled, add a bullet and assert `h.agent.hooks.apply("transformContext", msgs, { turn:0, model:"mock" })` returns `msgs` unchanged (identity). **(ii)** then enable via `e.store.set("enabled", true)` and assert the same `apply` call now returns a new array whose leading message is the playbook note. Protects end-to-end wiring across both gate states. *(AC 2, integration)*
6. **TEST** `/playbook` command round-trips: `add` twice → `list` shows two distinct ids in insertion order (AC 3); `merge <id> <text>` mutates only that bullet, second identical merge is a no-op (AC 4 via command); `forget <id>` removes exactly one; `clear` empties. Drive commands via the `CommandRegistry` the way `memory.test.ts` does (`h.host.use` then invoke the registered command). *(AC 3, 4, 6)*
7. **TEST** store bullet cap: after `MAX_BULLETS + 5` `add` calls, `store.keys().filter(k => k.startsWith("bullet:")).length === MAX_BULLETS` and the earliest-added ids are the dropped ones. *(AC 5b)*
8. **TEST** kill-switch parity: with `EAGENT_PLAYBOOK=off` set in `process.env` for the block, `/playbook add x` performs no store write (bullet count unchanged) and reports disabled; restore env after. *(AC 7)*
9. **IMPL** write `src/extensions/playbook.ts` to make tasks 1–8 pass (storage, `mergeSegments`, `buildInjection`/`injectPlaybook`, `activate` with hook + command + dispose loop).
10. **IMPL** wire `src/host.ts` (import + `BUILTIN_EXTENSIONS` row after `microagents`) and append the `README.md` extension-table row.

**Per-task acceptance commands** (runnable from repo root):
- Playbook suite (tasks 1–8): `node --import tsx --test test/playbook.test.ts`
- Typecheck (AC 8): `npm run typecheck`
- Full offline suite incl. `test/kernel-surface.test.ts` — proves no kernel-line growth / surface stability (AC 8): `npm test`

**Exit condition:** `node --import tsx --test test/playbook.test.ts` passes (all 8 test tasks green), `npm run typecheck` exits 0, and `npm test` exits 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM + NodeNext with `.js` import specifiers even for `.ts`; strict TS (`noUncheckedIndexedAccess` etc., model the types, no `any`); zero runtime deps except `jiti` (use global only, no SDK); single-file capability-gated extension with an `EAGENT_<NAME>=off` kill switch; append to `BUILTIN_EXTENSIONS`; offline `node:test`. Kernel untouched (`src/kernel/*` unchanged — the ceiling test in `test/kernel-surface.test.ts` must stay green).
- **Four-corner subagent template:** `references/loop-3-development.md` (dev → review → accept → fix, each a fresh subagent).
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phase1): …` opener; `fix(phase1-roundR): <keyword>` within-round; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; no AI/tooling mention.

## 4. Data and Fixture Dependencies

- Reuse `test/helpers.ts` `makeHarness` (config + host + `MemoryBackend` store) and `envOnlyConfig()` from `src/kernel/store.js` for pure-function kill-switch tests. Reuse `text()` from `src/kernel/types.js` to build messages (as `microagents.test.ts:29` does).
- No new fixtures needed: bullets are created in-test via `/playbook add`; the store is the in-memory `MemoryBackend`. No filesystem fixtures (unlike microagents' `.md` scan).

## 5. Regression Protection

- `npm test` must stay fully green — in particular `test/kernel-surface.test.ts` (public-surface + kernel-line ceiling), `test/compact.test.ts` and `test/memory.test.ts` (the other `transformContext`/store users this extension must not perturb; it registers its own hook and its own store namespace, touching neither).
- Adding the `BUILTIN_EXTENSIONS` row must not change any existing extension's behavior; the new hook is off by default, so default-install context transforms are byte-identical (assert indirectly via the untouched `compact`/`microagents` suites remaining green).
