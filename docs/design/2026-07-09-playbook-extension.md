# Design: `playbook` extension — an ACE-style delta-merged, auto-injected insight playbook

```
Status: closed
Closing-commit: 5475cdb
Closed-on: 2026-07-09
Deferred: finding — cost.test.ts:33 comment "harness exposes no store backend" newly imprecise after helpers.ts gained `backend` (left unfixed: editing the verbatim-paired trace.test.ts/cost.test.ts comments is an out-of-scope drive-by; no external tracker — recorded in closeout); finding — buildInjection first-bullet byte-cap edge reachable only under a pathological sub-~74-byte playbook.maxBytes override (left unfixed to preserve the whole-bullet fill decision; no external tracker — recorded in closeout)
```

Task slug: `2026-07-09-playbook-extension`
Wave 1 of "absorb harness-engineering lessons into EAgent".

## 1. Background and Purpose

Lilian Weng's *Harness Engineering for Self-Improvement* (2026-07-04) and the
Agentic Context Engineering paper it cites (ACE, arXiv 2510.04618) make one
verified, self-contained claim worth absorbing: treat durable context as an
**evolving playbook of itemized bullet entries** that is (a) updated by
**deterministic delta-merge** — append a new bullet, or merge an insight into an
existing bullet incrementally — **never** by a monolithic LLM rewrite (a
monolithic rewrite measurably collapses context: ACE names this "context
collapse" and reports sharp accuracy drops), and (b) **auto-injected into context
each turn** so the accumulated know-how is always in front of the model. ACE
reports +10.6% on agent benchmarks and a ~17pp AppWorld gain from this pattern.

EAgent has the *substrate* but not this *pattern*. `memory.ts` stores discrete
provenance-tagged entries but deliberately registers **no** `transformContext`
hook (docstring, `memory.ts:13-15`) and has **no** delta-merge — `consolidate` is
only exact-duplicate dedupe (`memory.ts:421-447`); retrieval is model-pull only.
`compact.ts` injects on `transformContext` but summarizes the *conversation
prefix* into ephemeral slots via a paid model sub-call (`compact.ts:16-30`) — not
a durable, curated, delta-merged playbook. Nothing combines "durable growing
bulleted playbook" + "deterministic delta-merge" + "auto-injected each turn".

If we do not do this, the most-verified lesson from the survey stays a note in a
report instead of a usable capability, and EAgent keeps model-pull memory only —
insights the agent discovers are not reliably re-presented to it.

## 2. Deliverables

- [ ] `src/extensions/playbook.ts` — a single-file extension, default-exporting `activate(e)`, that:
  - [ ] maintains a durable, ordered list of bullet entries in its namespaced `e.store`;
  - [ ] supports **deterministic delta-merge**: `add` (append a new bullet) and `merge` (append an insight to an existing bullet by id — pure string op, no model call);
  - [ ] **auto-injects** the current playbook into context via a `transformContext` hook, as one leading ephemeral `system` message, when enabled;
  - [ ] ships **OFF** by default; enabled via `/playbook on` (stored flag) and hard-killed by `EAGENT_PLAYBOOK=off`;
  - [ ] registers a `/playbook` command: `on | off | list | add <text> | merge <id> <text> | forget <id> | clear`.
- [ ] `src/extensions/playbook.ts` appended to `BUILTIN_EXTENSIONS` in `src/host.ts` **immediately after `microagents`** (i.e. after `compact`, grouped with the other injectors, before `limits`) — placement rationale in §4, Decision 4.
- [ ] `test/playbook.test.ts` — offline `node:test` coverage for every Acceptance Criterion in §7.
- [ ] One-line row appended to the extension table in `README.md` (description + command + capability), matching the existing table format.

## 3. Scope Boundary (NOT in scope)

- **No LLM-driven curation.** No Generator/Reflector sub-calls, no paid model call anywhere in this extension. We absorb ACE's *Curator delta-merge + injection*, not its reflection loop. All merges are deterministic string operations.
- **No model-facing tools in Wave 1.** The playbook is populated only through the `/playbook` command (human/white-box control). Model-facing self-curation tools (`playbook_add`/`playbook_merge`, mirroring `memory.ts`'s `remember`) are a defensible next step but were **not** in the stated deliverable ("a `/playbook` command … at minimum") and are **deliberately deferred** to keep Wave 1 minimal (Simplicity First). Command population + injection + delta-merge fully demonstrate the ACE lesson.
- **No auto-population** from trajectories, failures, or events. (Automatic capture is a possible later wave, explicitly deferred.)
- **No semantic ranking / embeddings** (unlike `memory.ts`'s optional embedder). Injection is the full playbook in insertion order, byte-capped.
- **No archive/promotion tier** (unlike `memory.ts`). One flat capped list; oldest-drop on overflow.
- **No helpful/harmful counters** (ACE tracks these; out of scope for a minimal absorption).
- **No changes to `memory.ts` or `compact.ts`.** Coexistence is achieved purely by load-order placement and off-by-default (§4, Decision 4).
- **No new kernel lines.** This is an extension; `src/kernel/*` is untouched (the kernel-surface ceiling test must stay green).

## 4. Key Design Decisions

### Decision 1 — New extension vs. extending `memory.ts`
- **Problem:** the playbook could be a new mode of `memory.ts` or its own file.
- **Options:** (a) add a delta-merge + injection mode to `memory.ts`; (b) a new `playbook.ts` extension.
- **Choice: (b), a new extension.** `memory.ts`'s docstring states it *deliberately* registers no `transformContext` hook so "the two never fight over the seam" (`memory.ts:14`). The playbook's *defining* feature is auto-injection on exactly that seam. Bolting it onto `memory.ts` would violate that stated invariant and entangle two different lifecycles (keyed recall notes vs. an always-injected ordered list). A separate, single-responsibility extension matches the house rule "new behavior is always an extension" (CLAUDE.md).
- **Why (a) rejected:** breaks `memory.ts`'s explicit no-seam invariant; couples two eviction models; larger blast radius on a load-bearing, on-by-default extension.

### Decision 2 — Deterministic delta-merge semantics (the core lesson)
- **Problem:** how to update the playbook without "context collapse".
- **Options:** (a) LLM rewrites the whole playbook; (b) deterministic delta ops — `add` appends a new bullet, `merge` appends an insight string to a targeted existing bullet, with exact-duplicate delta deduped; (c) in-place full-text replace of a bullet (`edit`).
- **Choice: (b).** `add(text)` creates a new bullet `{ id, text, ord, ts }`. `merge(id, delta)` appends `delta` to the bullet as a new `MERGE_SEP`-delimited segment — `text + MERGE_SEP + delta` — **only if `delta` does not already exactly match one of the bullet's existing `MERGE_SEP`-delimited segments** (segment-exact dedupe, not raw-substring: a distinct delta that happens to be a substring of existing text is NOT dropped). This is idempotent, deterministic, and makes no model call — the minimal faithful realization of ACE's non-LLM curator merge, structurally unable to collapse context.
- **Why (a) rejected:** it *is* the failure mode the lesson exists to avoid (context collapse), plus it is non-deterministic and adds a paid call. **Why (c) rejected:** whole-bullet replace is a strictly larger, lossy operation than append-a-delta and is not needed to demonstrate the pattern; `forget` + `add` covers the rare replace case via the command.

### Decision 3 — Storage model: per-entry keys with an explicit order field
- **Problem:** represent an ordered, individually-mutable bullet list durably.
- **Options:** (a) one `Bullet[]` array under a single store key; (b) per-entry `bullet:<id>` keys with a monotonic `ord` field, sorted on read.
- **Choice: (b).** Mirrors `memory.ts`'s per-`note:` entry model (`memory.ts:31-56`), keeps `merge`/`forget` a single-key write, and avoids whole-array clobber. Ordering is an explicit monotonic `ord` integer (persisted counter under `seq`), sorted ascending on read — not a reliance on `Object.keys` order. Id generation copies `memory.ts:547-549` (per-activation random base + counter; zero-dep, no `crypto`).
- **Why (a) rejected:** a single-array value is the closest thing to a "monolithic blob" this design is trying to avoid in spirit, and every op would rewrite the whole array.
- **Separator robustness:** because `merge` splits a bullet's text on `MERGE_SEP` to compare segments, L2 must ensure a command-supplied `delta` cannot forge segment boundaries — choose a `MERGE_SEP` sentinel unlikely to occur in prose (e.g. a control/newline-based delimiter) and/or reject a `delta` containing it. No AC exercises this, but it must be a deliberate L2 choice.
- **Altitude note:** the concrete field/key names here (`bullet:<id>`, `seq`, `{id,text,ord,ts}`, the `… (N more not shown)` marker, constant names) are stated only to make the §7 Acceptance Criteria mechanically checkable; L2 owns the final identifiers so long as the tested behavior holds.

### Decision 4 — `transformContext` seam placement and coexistence
- **Problem:** the injected block must not be folded away by `compact`, must not bloat context, and must not fight `memory`/`compact`.
- **Evidence (verbatim):** filter hooks register by append — `list.push(reg)` (`hooks.ts:115`) — and apply in registration order — `for (const reg of [...list]) { acc = await reg.fn(acc, ...) }` (`hooks.ts:141-142`). Registration order = `BUILTIN_EXTENSIONS` load order (`host.ts:93-153`). `compact` is at `host.ts:105`; `context-files`/`microagents` (also injectors) are at `host.ts:115-116`, i.e. **after** `compact`. `microagents` injects as a leading ephemeral system note and returns the input array by reference when it injects nothing (`microagents.ts:117-148`).
- **Choice:** place `playbook` in `BUILTIN_EXTENSIONS` **immediately after `microagents`** (`host.ts:116`), before `limits` (`host.ts:117`) — i.e. after `compact` (`host.ts:105`) and grouped with the other injectors. Because its hook runs after `compact`'s, the injected block is added to the already-compacted message list and is therefore never folded into a summary. Inject as **one leading ephemeral `system` message** (`meta: { source: "playbook", ephemeral: true }`), returning the input **by reference** on the disabled / kill-switch / empty paths (identity, mirroring `microagents.ts`).
- **Coexistence with all seam users, not just `compact`:** the correctness requirement is only "run **after** `compact`" (so the block is not folded); the chosen slot satisfies it. Other `transformContext` registrants exist — some before the slot (`skills`, `templates`, `prune`, `context-files`, `microagents`, among others) and some after (`goal`, `config-hooks`, `handoff`, `drift-probe`, `skills-hardening`, per `host.ts:126-143`; `handoff` prepends only, and `skills-hardening` narrows only its own `skills`-sourced note — neither strips a leading ephemeral note). Playbook does **not** require being last: like `microagents`, it prepends a self-contained leading ephemeral note; a later injector prepending its own note leaves the playbook note intact and still in-context (the `microagents` precedent shows leading ephemeral notes reach the provider). `memory` shares no seam (no `transformContext` hook) → no conflict. `compact` and `playbook` both ship **OFF by default**, so the default install has zero interaction; bloat is bounded by Decision 5.
- **Why "before compact" rejected:** the block would land in the prefix `compact` folds → the playbook would be summarized (collapsed) into `## Decisions`/etc., defeating the purpose.

### Decision 5 — Byte cap and bullet-count cap (thresholds)
- **Problem:** the block is injected **every turn** (unlike `microagents`, which is conditional), so unbounded growth is a per-turn token cost.
- **Choice:**
  - **Injected byte cap `MAX_INJECT_BYTES = 8 * 1024` (8 KB), overridable via `config.int("playbook.maxBytes", …)`.** Fill bullets in `ord` order, whole bullets only, stop at the first that would overflow (the `microagents.ts:127-134` fill idea) — but, unlike `microagents` (which caps only the concatenated bodies and then adds a header on top), the budget here is the **whole injected message**: L2 must reserve bytes for the header line and the `… (N more not shown)` marker inside the cap so that the final `utf8` byte length of the system message is `≤ MAX_INJECT_BYTES` (the invariant AC 5(a) measures). 8 KB (a quarter of `microagents`/`context-files`' 32 KB) is chosen because playbook injects unconditionally on every turn whereas those inject conditionally/once; the tighter cap bounds the always-on cost.
  - **Stored bullet cap `MAX_BULLETS = 64`, overridable via `config.int("playbook.maxBullets", …)`.** Set to match `memory.ts`'s `DEFAULT_CORE_CAP = 64` (`memory.ts:27`) for precedent parity; the real limiter on injected size is the byte cap, so this is only a store-growth backstop. On `add` over cap, FIFO-drop the lowest-`ord` bullet (simpler than `memory`'s two-tier archive; a curated playbook does not need a searchable overflow tier — see Scope Boundary).
- **Rationale:** both caps are declared as measured Acceptance Criteria (§7.5), so the thresholds are enforced by test, not asserted.

### Decision 6 — Capability and enablement
- **Problem:** does the playbook need a capability, and how is it enabled?
- **Choice:** **no capability** — like `memory.ts` (`memory.ts:586-588`: "No capability is required: this is the agent's own private notebook"), the playbook writes only to its own namespaced store and injects text; it is not a gateway to fs/net. Enablement mirrors `compact.ts:24-29`: ships **OFF**, gated by `config.enabled("playbook", { default: false, store: e.store })` (the stored `enabled` flag set by `/playbook on|off`), with `EAGENT_PLAYBOOK=off` as the hard env veto read inside the hook and the tools/command.
- **Why a capability rejected:** no privileged authority is exercised; adding one would diverge from the directly-analogous `memory`/`microagents` precedent.

## 5. Dependencies and Assumptions

- **ExtensionAPI surface used:** `e.hook("transformContext", …)`, `e.registerCommand({ name, description, run })`, `e.store` (`get/set/delete/keys`, `store.ts:12-17`), `e.config` (`enabled/int/string`, `store.ts:26-35`). All exercised by `memory.ts`/`microagents.ts`/`compact.ts`. (No `e.registerTool` — Wave 1 has no model-facing tools; see §3.)
- **Runtime primitives:** `new Date().toISOString()` and `Math.random()` are available and already used in extensions (`memory.ts:548,620`). (The workflow-script prohibition on `Date`/`Math.random` does not apply to extension runtime code.)
- **Message shape:** a `system` message `{ role, content: [{ type: "text", text }], meta }` per `microagents.ts:142-147`.
- **Store persistence:** durable across restart only under `FileBackend`; tests use `MemoryBackend`/`MemoryStore` (`store.ts:63-86`). No cross-session guarantee beyond existing Store semantics is assumed.
- **Hook composition order** is registration/load order — see Decision 4 verbatim evidence (`hooks.ts:115,141`).

## 6. Relationship with Existing Designs

- Prior design docs: `docs/design/2026-07-07-centralized-config.md` (the `e.config` facility). This design **depends on** that facility (`config.enabled/int/string`) but does not conflict with it — it is a consumer, matching how `memory.ts`/`compact.ts` already read config.
- Terminology anchors: CLAUDE.md (kernel/extension vocabulary, capability set), the `README.md` extension table, and the docstrings of `memory.ts`, `compact.ts`, `microagents.ts`. Terms "entry/bullet", "delta-merge", "inject", "kill switch", "ephemeral" are used consistently with those sources.
- No conflict markers required: this adds a new, off-by-default extension and touches only `host.ts` (append) and `README.md` (append).

## 7. Acceptance Criteria (measurable, automatable — offline `node:test`)

1. **Identity when off:** with the extension disabled (default) **or** `EAGENT_PLAYBOOK=off`, the `transformContext` transform returns its input array **by reference** (`assert.strictEqual(out, input)`), even with bullets present.
2. **Injection when on:** with the extension enabled and bullets `[b1, b2]` present, the transform returns a **new** array (`out !== input`, `out.length === input.length + 1`) whose leading message is `role:"system"`, `meta.source:"playbook"`, `meta.ephemeral:true`, and whose text contains both bullet texts in ascending `ord` order.
3. **`add` appends a distinct bullet:** two `add` calls yield two bullets with distinct ids, both listed; `list` shows them in insertion order.
4. **Deterministic `merge`:** `merge(id, "X")` appends `"X"` as a new segment after the original (no other bullet changes); calling `merge(id, "X")` again is a **no-op** (idempotent — text unchanged); and a delta that is a **substring of but not equal to** an existing segment (e.g. `merge(id, "conf")` when a segment is `"config"`) **is** appended (segment-exact dedupe, not raw substring). The merge is a pure store transform — the extension holds no provider handle and the test constructs none.
5. **Caps enforced:** (a) with bullets whose combined size exceeds `MAX_INJECT_BYTES`, the injected system message's `utf8` byte length is `≤ MAX_INJECT_BYTES` and contains the `more not shown` truncation marker; (b) after `MAX_BULLETS + 5` `add` calls, the count of store keys **under the `bullet:` prefix** is exactly `MAX_BULLETS` (the `seq`/`enabled` keys are excluded from this count) and the earliest-added bullets are the ones dropped.
6. **`forget` / `clear`:** `forget(id)` removes exactly that bullet; `clear` removes all; both reflected in `list` and in the next injection.
7. **Kill-switch parity:** under `EAGENT_PLAYBOOK=off`, `/playbook add …` reports disabled (no store write) and injection is identity (subsumes AC 1 for the env path).
8. **Suite gates green:** `npm run typecheck` exits 0; `npm test` exits 0 (includes `test/kernel-surface.test.ts`, proving no kernel-line growth and public-surface stability).

Quality budget: the always-on per-turn injection cost is bounded and **measured** by AC 5(a) (≤ 8 KB). No latency budget applies — the extension makes no network/model call (Scope Boundary).

## 8. Risks and Rollback

- **Risk: per-turn context bloat.** Mitigated by off-by-default (Decision 6) + the 8 KB injected byte cap (Decision 5, AC 5a).
- **Risk: fighting `compact` / double-summarization.** Mitigated by post-`compact` load-order placement (Decision 4) + both off by default.
- **Risk: unbounded store growth.** Mitigated by `MAX_BULLETS` FIFO-drop (Decision 5, AC 5b).
- **Risk: stale/incorrect insights re-injected forever.** Mitigated by white-box `/playbook list|forget|clear` control (Deliverable 2) and off-by-default; the human/agent curates.
- **Risk: kernel-ceiling regression.** Mitigated: no `src/kernel/*` edits; AC 8 runs `test/kernel-surface.test.ts`.
- **Rollback:** runtime — `EAGENT_PLAYBOOK=off` or `/playbook off` (instant, identity transform). Permanent — remove the `BUILTIN_EXTENSIONS` line + delete `playbook.ts`/`playbook.test.ts` + the README row; the namespaced store file is orphaned harmlessly (no migration, no shared keys).
