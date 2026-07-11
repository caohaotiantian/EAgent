# Design — Unify the CLI `--json` and HTTP `/run` JSONL schemas (Cycle 7)

Slug: `2026-07-11-jsonl-unify`
Status: **L1 closed** — rounds 3 and 4 both passed (zero severe, zero general) by two independent fresh reviewers; two-generation termination satisfied. Every source-specific claim was verified against the code. Ready for L2.

## 1. Background and Purpose

The CLI `--json` renderer (`wireJsonRendering`, `src/cli.ts:333-347`) and the HTTP `/run` streamer
(`streamRun`, `src/server.ts:310-416`) each **hand-roll** `JSON.stringify(obj) + "\n"` off the **same**
`agent.hooks` bus, but emit **divergent** shapes for the same events. Most divergences are accidental:

| event | CLI (`cli.ts`) | server (`server.ts`) | kind |
| --- | --- | --- | --- |
| `text_delta`/`message`/`usage` | identical | identical | — |
| `reasoning_delta` | `{type,text}` :338 | **absent** | accidental (server doesn't subscribe) |
| `tool_start`/`tool_end` | has `id` :340-343 | **no `id`** :383-386 | accidental (server drops `call.id`) |
| `error` | hook-sourced `{type,where,message}` :346 | catch-synthesized `{type,message}` :408 | shape-only (the server's `error` is a synthesized `catch`, not the error hook — so its `where` is a catch-supplied constant, D3) |
| terminal | `agent_end{reason,usage}` :345 | `done{reason,session,usage}` :406 | **name divergence** (+ `session` essential) |
| `action_required` | absent | `{type,id,question,options}` :346 | essential server-only |

A consumer can't write one parser for both, and there is no single source of shape truth. The user
chose (2026-07-11): **unify the terminal to one canonical name** (with a deprecation window) and **add
`reasoning_delta` to the HTTP stream**. The CLI `--json` schema is the richer, de-facto-documented one
(`docs/design/2026-07-10-cli-json.md`), so the unification brings the **server up to the CLI's shape**
via one shared serializer — the canonical schema *is* essentially the CLI's current one.

## 2. Deliverables

- [ ] **D1 (shared serializer, `src/jsonl.ts` — new, zero-dep)** — the single source of shape truth:
      `eventToJsonl(type, payload) → object` (a pure mapper holding the canonical object shape for every
      event: `text_delta`, `reasoning_delta`, `message`, `tool_start{id,name,arguments}`,
      `tool_end{id,name,isError,content}`, `usage{usage,cumulative}`, `agent_end{reason,usage,session?}`,
      `error{where,message}`, `action_required{id,question,options}`), and `wireJsonl(emit, agent) →
      Disposable[]` that registers the **six common streaming handlers** (`text_delta`,
      `reasoning_delta`, `message`, `tool_start`, `tool_end`, `usage`) on `agent.hooks`, each writing
      `emit(eventToJsonl(...))`. **Home: `src/jsonl.ts`** (top-level, next to `cli.ts`/`server.ts` — NOT
      `src/extensions/lib/`, which is the extension layer; the front ends are not extensions). Both front
      ends import it. **Byte-identity invariants** the mapper must preserve (else AC2 breaks): exact
      **key insertion order** (`JSON.stringify` serializes in insertion order), the `?? false`
      (`tool_end.isError`) and `?? null` (`action_required.options`) coalescing, and **omitting** fields
      the current serializers drop (`usage.model` from `events.ts:50`; `tool_end.step` from `events.ts:43`).
- [ ] **D2 (CLI adopts the shared serializer — behavior-identical)** — `wireJsonRendering` (`cli.ts:333`)
      calls `wireJsonl(emit, agent)` for the common events + keeps its own `agent_end` (hook) and `error`
      handlers, all shaped via `eventToJsonl`. **The CLI `--json` output must be byte-identical to today**
      (the CLI is already the canonical schema) — a golden test pins it (AC2).
- [ ] **D3 (server adopts the shared serializer + canonicalizes)** — `streamRun` (`server.ts:310`) uses
      `wireJsonl(write, agent)` for the common events, which **additively fixes** the accidental gaps:
      `tool_start`/`tool_end` now carry `id`, and **`reasoning_delta` is now emitted** (user decision).
      **Terminal — pinned emission order (G1):** the server writes the legacy `{type:"done", reason,
      session, usage}` line **first**, then the canonical `agent_end` (with `session`) **last** — so the
      **last line is the canonical terminal** and a new consumer reading "last line = terminal" gets
      `agent_end`, while an old consumer scanning for `type:"done"` still finds it (deprecation window;
      `done` marked deprecated in docs, removed in a future release — user chose this path). **This
      changes existing behavior** where the last line was `done`. The `test/server.test.ts` terminal
      assertions that **key on `type:"done"`** (`:123,:175,:420,:452,:521`) **must be updated** to expect
      the canonical `agent_end` as the last line (and, where they assert the terminal payload, additionally
      assert a legacy `done` line is present) — see AC5. The assertions that read `.at(-1)` but check only
      `session`/`usage` (`:144-145,:219`) **stay green unmodified**, because the canonical
      `agent_end{reason,usage,session}` carries both fields.
      **`error` stays wired per-front-end** (the server never subscribes to the error hook; it
      **synthesizes** an error line in its `catch`, `server.ts:407-408`, so its `error.where` is a
      **catch-supplied constant** the server sets, not a hook-sourced `where` — the mapper just gives it
      the `{type,where,message}` shape). `action_required` stays server-only (shaped via `eventToJsonl`).
      The terminal + `action_required` stay wired per-front-end (different sourcing) but their *shape*
      comes from the mapper.
- [ ] **D4 (docs — the canonical JSONL contract)** — a new "JSONL event schema" doc section (in
      `docs/EXTENSIONS.md` or a `docs/` page, cross-linked from README's `/run` line) enumerating the
      canonical event shapes (now shared by both front ends), noting the server-only `session`/
      `action_required`, and the **`done` → `agent_end` deprecation** (the server emits both during the
      window; consumers should migrate to `agent_end`). CHANGELOG entry (flag the additive server changes
      + the terminal deprecation). Update `docs/design/2026-07-10-cli-json.md`'s contract framing (the
      "existing `--json` JSONL contract" / "public contract… escalate" note at `cli-json.md:5-7` and the
      "No change to the JSONL event schema" non-goal at `:28-29`) to point at the new canonical doc.
- [ ] **D5 (tests)** — `test/jsonl.test.ts` (mapper units: each `eventToJsonl` shape); CLI golden
      (AC2 — `--json` byte-identical); server `/run` (AC3 — now emits `id`/`where`/`reasoning_delta`/
      `agent_end`+legacy `done`); the shared-serializer wiring registers/disposes cleanly.

## 3. Scope Boundary (NOT in scope)

- **Not changing the CLI `--json` schema.** It is already canonical; D2 is a behavior-preserving refactor
  (byte-identical, AC2). The unification moves the **server** to match — not the reverse.
- **Not removing `done` in this cycle** — the deprecation window keeps it (server dual-emits `agent_end`
  + `done`); removal is a future release (documented). The user chose the deprecation-window path over a
  clean break.
- **Not changing `action_required` or `session`** — genuinely server-essential (the durable `POST
  /answer` channel; the session map). They stay server-only, shaped via the mapper.
- **Not changing the underlying hook events, agent behavior, or the non-`--json` CLI rendering** — this
  reshapes only the two JSONL serializers into one.
- **No kernel change, no new dependency** — `src/jsonl.ts` is zero-dep, ESM `.js` specifiers.

## 4. Key Design Decisions

### KDD1 — canonical terminal = `agent_end`; the server changes (not the CLI)
- **Problem:** which terminal name is canonical, and which front end changes?
- **Options:** (a) canonical `done` (CLI changes `agent_end`→`done`); (b) canonical `agent_end` (server
  changes `done`→`agent_end`).
- **Choice: (b).** `agent_end` aligns with the kernel's actual lifecycle event name (vocabulary
  consistency), and the CLI `--json` schema is the **de-facto-documented contract**
  (`docs/design/2026-07-10-cli-json.md`) whereas the server `/run` shape is **undocumented** — so
  changing the server breaks fewer documented consumers. (a) would rename the documented CLI terminal, the
  one change that doc explicitly guards against.

### KDD2 — deprecation window for `done` (dual-emit), not a clean break
- **Problem:** the server `done`→`agent_end` rename is breaking for any `/run` consumer keying on `type`.
- **Choice (user decision):** the server emits **both** `agent_end` (canonical) and the legacy `done`
  during a transition window (documented deprecated; removed in a future release). Rejected: a clean break
  (drop `done` immediately) — the user chose the safer deprecation window despite the added scope. The
  dual-emit is two terminal lines transitionally; a consumer keys on whichever it knows.

### KDD3 — one shared mapper (shape) + a `wireJsonl` helper (common wiring); terminal/server-only wired per-front-end
- **Problem:** how much to share, given the terminal + `action_required` are sourced differently (CLI's
  `agent_end` from a hook; the server's terminal synthesized post-snapshot with `session`;
  `action_required` from the elicitation sink, not a hook).
- **Choice:** `eventToJsonl` (the mapper) is the single source of **shape** truth for **all** events;
  `wireJsonl` shares only the **six common streaming** hook registrations. The terminal + server-only
  events stay wired per-front-end (their sourcing genuinely differs) but pull their object shape from the
  mapper — so field names live in exactly one place without forcing an artificial shared wiring.

### KDD4 — add `reasoning_delta` to the HTTP stream (additive, user decision)
- **Choice (user decision):** the server subscribes to `reasoning_delta` and emits it via the mapper —
  symmetric with the CLI, fixing the accidental omission. Additive (a consumer ignoring it is
  unaffected). Documented trade: it streams model reasoning over HTTP (the user accepted this).

## 5. Dependencies and Assumptions

Verbatim source:
- CLI emit + shapes: `cli.ts:334-346` (`emit` → `process.stdout.write`; `agent_end` :345 from the hook;
  `error` :346 with `where`; `id` on tool events :340-343). Hook-driven, process-lifetime agent.
- Server emit + shapes: `server.ts:323-326` (`write` with `closed` guard), `:380-388` (per-turn `subs`,
  no `id`, no `reasoning_delta`), `:406` `done{reason,session,usage}` synthesized from `agent.run()`
  return (`:389`), `:346` `action_required` from `elicit.ask`, `:408` `error` no `where`. Per-turn
  subscribe/dispose (`:380-388`, `:413`).
- Both write `JSON.stringify(obj) + "\n"` (`cli.ts:335`, `server.ts:325`). Same `agent.hooks` bus
  (`events.ts:22-53`); `ToolCallBlock.id` available both sides (`types.ts:23`).
- CLI `--json` is a de-facto contract (`docs/design/2026-07-10-cli-json.md:5-7,11`); server `/run` shape
  is undocumented (`README.md:343` only says "streams JSONL").
- **Assumption:** the CLI refactor is byte-identical because `eventToJsonl` reproduces the exact current
  CLI object shapes (verified field-by-field at L3 against `cli.ts:337-346`). AC2 (golden) pins it.

## 6. Relationship with Existing Designs

- Supersedes the ad-hoc serializers; updates `docs/design/2026-07-10-cli-json.md`'s contract note to
  point at the new canonical schema doc (D4). No conflict — that doc anticipated this ("if a reviewer
  judges `--json` a public contract... escalate"); this cycle formalizes it. Terminology anchors:
  CLAUDE.md (the hook events), the README `/run` description.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (mapper units):** `test/jsonl.test.ts` — `eventToJsonl("tool_start", {call})` →
  `{type:"tool_start", id, name, arguments}`; `eventToJsonl("error", {where, message})` →
  `{type:"error", where, message}`; etc. — each canonical shape asserted. RED before D1.
- **AC2 (CLI byte-identical — the contract guard).** `wireJsonRendering` is a **private** closure inside
  `cli.ts` (not exported) and the CLI's `MockProvider` path isn't subprocess-scriptable to an arbitrary
  turn, so byte-identity is pinned by **three layered checks**, not one golden:
    1. **Mapper units (AC1)** already pin each event's exact object shape (fields + order + coalescing).
    2. **In-process wiring golden:** `test/jsonl.test.ts` drives `wireJsonl(emit, agent)` against a
       **scripted mock agent** that fires the six common hook events (a hooks stub with `.on`), collects
       the `emit`ted lines, and asserts they are **exactly** the strings the pre-refactor CLI produced for
       those events (`text_delta`/`reasoning_delta`/`message`/`tool_start`{id}/`tool_end`{id}/`usage`) —
       `wireJsonl` **is exported** from `src/jsonl.ts` precisely so this is testable without reaching into
       `cli.ts`'s private closure.
    3. **Subprocess end-to-end (scoped):** the existing `test/cli.test.ts` `--json` subprocess test
       (`:29`; `runCli(["-p","mock","--json"], "hi\n/help\n")` at `:32`) today asserts only that every stdout line
       is **valid JSONL carrying a `type`** (no human text leaks) — it does **not** byte-pin event shapes.
       It **stays green unchanged** (guards end-to-end that the refactor keeps stdout clean/valid), and
       this cycle **extends** it with one assertion — the **last** emitted line's `type` is `agent_end` —
       to pin the live CLI terminal end-to-end. (A full subprocess byte-golden isn't added: the CLI mock
       can't be scripted to an arbitrary tool-calling turn, which is exactly why layer 2 exists.)
  Together: (1) pins each event's shape, (2) pins the shared wiring's output **byte-for-byte** against the
  old CLI strings, (3) pins the live CLI end-to-end for the scriptable path (validity + `agent_end`
  terminal). Byte-identity of the **six common streaming events** rests on layers 1+2; the **per-front-end
  terminal `agent_end` and `error`** (not covered by layer-2's `wireJsonl` golden, since they're wired
  outside it) rest on the layer-1 mapper units, which pin their fields + key order + coalescing. Layer 3
  is the end-to-end regression guard.
- **AC3 (server canonicalized):** a `/run` test asserts the server now emits `tool_start`/`tool_end`
  **with `id`**, `error` **with `where`**, a **`reasoning_delta`** line (given a reasoning-emitting mock),
  a canonical **`agent_end`** terminal (with `session`), AND the legacy **`done`** line (deprecation
  window). `action_required` still emitted for an elicitation. RED before D3.
- **AC4 (both front ends share the mapper):** a test (or a grep-assert) confirms both `cli.ts` and
  `server.ts` import `eventToJsonl`/`wireJsonl` and neither hand-rolls a divergent event object for a
  common event. (Review-verified + a `grep` check.)
- **AC5 (gates + the server-test carve-out):** `npm test` 0 fail; `npm run typecheck` 0; `npm run
  typecheck:test` 0; `npm run build` 0; `npm run eval` 5/5; `test/kernel-surface.test.ts` green (kernel
  line count **unchanged** — no `src/kernel/` edit). `test/cli.test.ts` stays green (the `--json`
  subprocess test extended by one `agent_end`-terminal assertion, AC2 layer 3; every other assertion
  unchanged). `test/server.test.ts` mostly stays green, **but the 5 terminal assertions that key on
  `type:"done"` (`:123,:175,:420,:452,:521`) are deliberately updated** by this cycle to expect the
  canonical `agent_end` as the last line (and, where they assert the terminal payload, additionally assert
  a legacy `done` line is present) — that edit **is** the behavior change D3 introduces, so those specific
  assertion updates are in-scope and expected, not a regression. The `.at(-1)` assertions that check only
  `session`/`usage` (`:144-145,:219`) **stay green unmodified** (canonical `agent_end` carries both).
  Every other `server.test.ts` assertion stays green.

## 8. Risks and Rollback

- **R1 — the CLI refactor drifts the `--json` contract.** The CLI `--json` is the de-facto contract;
  any byte change breaks consumers. Mitigation: AC2 golden test pins byte-identity; `eventToJsonl`
  reproduces the exact shapes. Rollback: revert the `cli.ts` hunk (keep the old inline serializer).
- **R2 — server `done`→`agent_end` breaks a `/run` consumer.** Mitigated by the deprecation window
  (dual-emit `agent_end` + `done`); AC3 asserts both are emitted. Documented migration. Rollback: revert
  the server terminal hunk (keep `done` only).
- **R3 — `reasoning_delta` over HTTP exposes model reasoning** (user-accepted). Documented in D4/CHANGELOG.
  A consumer/operator who doesn't want it ignores the event (additive). Rollback: drop the server
  `reasoning_delta` subscription.
- **R4 — the shared `wireJsonl` mis-wires or double-registers** (both fronts register the same hooks).
  Each front end calls `wireJsonl` once and disposes the returned subscriptions (CLI: process-lifetime;
  server: per-turn in `finally`). AC5 (existing cli/server tests green) + the wiring test guard it.
  Rollback: revert to per-front-end inline registration.
- **Overall rollback:** revert the `cli.ts`/`server.ts`/`src/jsonl.ts`/test/doc hunks; the server changes
  are the only behavioral delta (additive + the terminal deprecation). Branch `chore/production-hardening`
  (PR #40), not merged.
