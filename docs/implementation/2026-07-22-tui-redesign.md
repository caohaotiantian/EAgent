# Implementation — TUI redesign: progressive disclosure

Slug: `2026-07-22-tui-redesign` (identical to the design doc)
Status: closed
Closing-commit: `d32b1d0` (phases 1–5, code+docs) + this closeout
Closed-on: 2026-07-22
Deferred: none
Superseded-by: `docs/implementation/2026-07-23-tui-ink-rebuild.md` (the Ink rebuild).

> L2 converged over 3 review rounds (round 3 clean PASS with a full AC→test-home
> coverage audit — all 15 ACs covered). All 5 phases executed via the L3 phase
> runner (dev→review→accept), each merged after a main-agent PhaseEnd verification
> (full acceptance-command set incl. `typecheck:test`, which `npm test` skips) + an
> E2E smoke. Phase commits: P1 c6de82b/dcacb56, P2 71c425f/68ed03c, P3 db9aa7f/f05e7e9,
> P4 b59b7a9, P5 609039c/d32b1d0.
Design doc: `docs/design/2026-07-22-tui-redesign.md` (L1 closed)
Audit: `docs/design/2026-07-22-tui-redesign-audit.md`

> **Trace rule.** Every task below maps to a design Deliverable (D1-D11) or
> Acceptance Criterion (AC1-AC12). No task introduces a requirement absent from
> the design doc; a discovered gap rolls back to L1, it is not patched here.

## 1. Task Index (design ↔ implementation)

| Design | What | Phase |
| --- | --- | --- |
| D1 (design §2), KDD1/KDD7/KDD10 (§4) | Pure view-model reducer (ordering, fork de-interleaving, nesting, full payload) | P1 |
| D2 (§2), KDD2 (§4) | Attribution + timestamp adapter (`currentActingAgent`/`currentRootAgent`) | P1 |
| D3 (§2), KDD5 (§4) | Inline renderer = new default; `fancy` gate; active region; concurrent-fork model | P1 |
| D9 (§2), KDD5 | Non-interactive parity (plain append) | P1 |
| D4 (§2), KDD6 (§4) | Display modes `full/collapsed/auto`; `/details`,`/expand`,`/collapse`; full-on-demand | P2 |
| D5 (§2), KDD8/KDD9 (§4) | Alt-screen TUI renderer: differential frames, raw keys, persistent bar, teardown | P3 |
| D6, D7 (§2) | Side panel (≥100 cols) + SIGWINCH reflow; startup suggest-hint | P4 |
| D8 (§2), KDD10 | Subagent nesting (reducer-level in P1; rendered in both backends) | P1 (model) / P3 (TUI) |
| D10 (§2) | Tests (interleaved through every phase, TDD-first) | P1-P4 |
| D11 (§2) | Docs: README, CHANGELOG, controls reference | P5 |
| AC1a/AC1b (§7) | Reducer + real-bus attribution de-interleaving | P1 |
| AC2/AC3 (§7) | Full params on demand; no over-truncation | P2 |
| AC4/AC5/AC6 (§7) | Preserve `agent_end` warnings, JSONL goldens, zero kernel change | P1 (regression, all phases) |
| AC7/AC7b/AC7c (§7) | Inline active-region containment, header content, resize | P1 |
| AC8 (§7) | TUI differential, gating, teardown, side panel, SIGWINCH | P3 (i,ii,iv) / P4 (iii,v) |
| AC9 (§7) | Subagent nesting: reducer tree (T1.2) + inline render & header (T1.8b) + TUI render & header (T3.4b) | P1 + P3 |
| AC10 (§7) | Mode/command behavior | P2 (commands) / P3 (Ctrl+T) |
| AC11 (§7) | Non-interactive parity (`--eval`, stdin-TTY/stdout-pipe, `TERM=dumb`, batch) | P1 |
| AC12 (§7) | Gates green | every phase |

## 2. Phase Breakdown

**Common commands** (CLAUDE.md _common-commands_):
- `<TEST-CMD>` = `npm test` (node:test via tsx, offline through MockProvider).
- Single file = `node --import tsx --test test/<file>.test.ts` (precedent:
  `silent-truncation-fix` ACs).
- Also gated: `npm run typecheck`, `npm run typecheck:test`, `npm run eval`,
  `npm run build`.

**New source modules (host layer, no kernel/extension touch):**
- `src/render/view-model.ts` — pure: `ViewModel` types, `DisplayMode`, `initialModel()`,
  `reduce(model, taggedEvent) → model`, `applyControl(model, action) → model`
  (expand/collapse/mode), and pure formatting helpers
  (`headerLine(section)`, `bodyLines(section)`). No ANSI escapes emitted at I/O;
  no `Date`/`Math.random`.
- `src/render/wire.ts` — `wireViewModel(agent, sink, opts)`: subscribes to
  `agent.hooks` for the intra-run events, tags each with `currentActingAgent()` /
  `currentRootAgent()` identity (via a `WeakMap<Agent,string>` id) + `opts.now()`
  timestamp, folds through `reduce`, and calls `sink(model, patch)`. Resets model
  on `agent_start` (root only — suppressed for forks). Returns a `Disposable[]`.
- `src/render/inline.ts` — `InlineRenderer`: consumes model patches, paints
  append-only with a bounded active region; exposes `applyControl`. Fancy vs
  plain chosen by the injected `fancy` flag.
- `src/render/tui.ts` — `TuiRenderer` (P3): alt-screen differential renderer +
  raw-key input + side panel.
- `src/render/tty.ts` — small shared helpers: the `Term` interface
  (`{ isTTY; columns; rows; write; setRawMode }`) so renderers take an injected
  terminal (real `process.stdout`/`stdin` in prod, a fake in tests); the shared
  spinner-frame constant; and a **pure, exported** predicate
  `isFancy(term: Term, opts: { interactive: boolean; term_env: string | undefined }) →
  boolean` = `interactive && term.isTTY && (term.columns ?? 0) > 0 && term_env !==
  "dumb"` (KDD5). Pure so the AC11 stdin-TTY/stdout-pipe and `TERM=dumb` axes are
  unit-tested in-process (no PTY, honoring the zero-dep charter). (Named `isFancy`,
  **not** `fancy`, so it does not shadow the local boolean `fancy` at the call
  site — `const fancy = isFancy(...)`.)

**`wireRendering` signature (host wiring):** `main()` computes `interactive`
(`stdin.isTTY && args.eval === undefined`, `cli.ts:113`) and calls
`wireRendering(agent, opts?)` where `opts = { fancy?: boolean; term?: Term; now?:
() => number }`. The `fancy` boolean is computed in `main()` as `const fancy =
isFancy(process.stdout, { interactive, term_env: process.env.TERM })` (where
`args.eval` is in scope) and passed in; `term`/`now` default to
`process.stdout`-backed real implementations. **The parameter is optional**, so the
pinned regression calls `wireRendering(agent)` (`test/cli.test.ts:127,139,154`)
still compile under `typecheck:test` and stay green (AC4). When `opts` is omitted
or `fancy` is falsy, the renderer is plain-append (the test/non-TTY default).

---

### Phase 1 — View model + attribution + inline default renderer (fixes problem a)

**Entry condition:** baseline green (§5); branch `chore/tui-redesign`.

**Design references:** D1/D2/D3/D8(model)/D9 (`design §2`), KDD1/KDD2/KDD5/KDD7/
KDD10 (`design §4`), AC1a/AC1b/AC2(data)/AC4/AC5/AC6/AC7/AC7b/AC7c/AC9/AC11
(`design §7`).

**Task list (TDD order — tests first):**

Tests (create):
- **T1.1** `test/render-view-model.test.ts` — **fork de-interleaving & order (AC1a).**
  Feed `reduce` a stream where two acting-agent ids emit `reasoning_delta`s
  interleaved under one `best_of_n` parent. Assert: each fork's text lands in its
  **own** sub-section; both nest under the one `reasoning-search` parent; ordered
  by first-delta arrival; **no** sub-section contains another fork's text.
  *Invariant: concurrent fork streams never merge; section order = first-arrival.*
  RED against a naive single-buffer reducer.
- **T1.2** `test/render-view-model.test.ts` — **single-parent nesting (AC9).** A
  spawn-class `tool_start` opens a card; a child's first delta (new acting id, same
  root) nests under the **unique open** spawn-class card. Also: with a concurrent
  non-spawn `bash` card open, the child still binds to the sole open spawn-class
  card (drift-proof classifier, KDD10). *Invariant: a child nests under its parent
  tool card when exactly one spawn-class card is open.*
- **T1.3** `test/render-view-model.test.ts` — **full-payload retention (AC2 data).** A
  `tool` section built from a `tool_start` with `JSON.stringify(args).length > 200`
  and a multi-line `tool_end` retains the **entire** args object and **every** line
  of `result.content` in the model. *Invariant: the model never elides tool data.*
- **T1.4** `test/render-view-model.test.ts` — **auto-collapsed transitions.** In the
  default mode, the latest section is expanded and the previous collapses when the
  next section begins. *Invariant: auto-collapsed keeps only the newest section
  open.*
- **T1.5** `test/render-inline.test.ts` — **active-region containment + coalescing
  (AC7 i,ii,iii).** Drive `InlineRenderer` with `fancy:true` over a fake `Term`
  (fixed `columns`) through a reasoning→answer run: (i) every emitted `\x1b[<n>A`
  has `n ≤ H`; (ii) each committed header/answer line appears exactly once in the
  output; (iii) a burst of K `reasoning_delta`s within one frame interval yields
  **≤1** active-region redraw. *Invariant: committed history is never rewritten;
  redraw storm is bounded.*
- **T1.6** `test/render-inline.test.ts` — **concurrent-fork region bound (AC7 iv).**
  With ≥3 concurrent forks streaming, the animated region height stays `≤ H`
  (aggregate progress line, not one line per fork). *Invariant: region height is
  independent of fork count.*
- **T1.7** `test/render-inline.test.ts` — **collapsed reasoning header content
  (AC7b).** On block end the committed header matches `/◆ Reasoning · \d+ tok ·
  [\d.]+s/`. *Invariant: the header carries the token count and elapsed seconds,
  not just the glyph.*
- **T1.8** `test/render-inline.test.ts` — **inline resize re-anchor (AC7c).** A
  fake-`Term` `columns`/`SIGWINCH` change crossing a wrap boundary drops +
  re-anchors the active region with no orphaned rows (or plain-append at width 0).
  *Invariant: resize never corrupts committed output.*
- **T1.8b** `test/render-inline.test.ts` — **subagent card rendering (AC9,
  inline half).** A scripted `spawn_agent` whose child emits its own
  `tool_start`/`text_delta` renders, in the **inline** backend, a card whose
  header **names the subagent + its task/prompt** and whose child sections are
  visibly **nested inside** that card (indented under it), not at top level.
  *Invariant: the rendered inline card names the subagent+task and nests the
  child's work — AC9's "both renderers" + "header names subagent+task" clauses,
  inline half.* (The reducer-tree half is T1.2; the TUI half is T3.4b.)
- **T1.9** `test/render-attribution.test.ts` — **real-bus attribution linchpin
  (AC1b).** Build a reasoning-search-shaped harness: ≥2 real `childScope()` forks
  (mirroring `src/extensions/reasoning-search.ts:172-181,274-276`) running the same
  MockProvider task under `Promise.allSettled`, wired through `wireViewModel`
  using the **real** `currentActingAgent()`. Assert the resulting model
  de-interleaves by fork with no cross-fork mixing. *Invariant: real ALS
  attribution separates concurrent fork deltas.* RED if attribution is stubbed to
  the root id.
- **T1.10** — **non-interactive parity (AC11), per-axis harness (a PTY dep is
  forbidden, CLAUDE.md zero-dep):**
  - **T1.10a** `test/cli.test.ts` (additions) — the **subprocess-testable** axes:
    `--eval` and piped batch via the existing `runCli` harness
    (`test/cli.test.ts:16-36`; piped stdio ⇒ `isTTY` false). Assert stdout contains
    **none** of `/\x1b\[\?1049/`, `/\x1b\[\d*A/`, or the shared spinner-frame
    constant.
  - **T1.10b** `test/render-tty.test.ts` — the **TTY-requiring** axes that a piped
    subprocess cannot fake: drive the **pure `isFancy(term, {interactive, term_env})`**
    predicate + the `InlineRenderer` with an injected fake `Term` encoding each
    axis — stdin-TTY/stdout-pipe (`term.isTTY:false`), `TERM=dumb` (`term_env:
    "dumb"`, both TTYs), and the width-0 case — asserting `fancy===false` and that
    the resulting render emits zero cursor/alt-screen/spinner bytes.
  *Invariant: machine / non-interactive / dumb-terminal / redirected-stdout paths
  emit zero cursor/alt-screen/spinner bytes, verified offline without a PTY.*
- **T1.11** (regression) `test/cli.test.ts:125-175` — **`agent_end` warnings (AC4)**
  stay green unchanged.
- **T1.12** (regression) `test/jsonl.test.ts`, `test/jsonl-adoption.test.ts` —
  **JSONL goldens + shared-mapper guard (AC5)** stay green.

Implementation (after the tests above are RED):
- **T1.13** `src/render/view-model.ts` — types + `reduce` + nesting (KDD10 drift-proof:
  a new child binds to the sole open spawn-class card on its root) + full-payload
  retention + auto-collapsed default.
- **T1.14** `src/render/tty.ts` — the injected `Term` interface + a `fromStdio()`
  real adapter.
- **T1.15** `src/render/wire.ts` — `wireViewModel`: subscribe, tag with
  `currentActingAgent()`/`currentRootAgent()` (`import … from "../kernel/agent.js"`
  — never construct a `type:"<event>"` JSONL literal, per AC5/the adoption guard),
  `WeakMap<Agent,string>` ids, `opts.now()` timestamp, `agent_start` reset.
- **T1.16** `src/render/inline.ts` — append-only painter; bounded active region
  (`H ≤ 4` = ≤3-line tail + 1 aggregate progress line); coalesced redraw; wrap math
  from `Term.columns`; plain-append when `!fancy`.
- **T1.17** `src/cli.ts` — reimplement `wireRendering(agent, opts?)` (optional
  `opts`, see the signature note in §2) to build the model + `InlineRenderer` via
  `wireViewModel`, painting fancy only when `opts.fancy` is true. **Keep verbatim**
  BOTH the existing `agent_end` warning handler (`cli.ts:337-346`, AC4) **and** the
  `error` handler (`cli.ts:329-331`) — dropping the latter would pass the tests
  (`cli.test.ts:170-174` only asserts warning *absence*) but silently regress error
  rendering. In `main()`, compute `const fancy = isFancy(process.stdout, {
  interactive, term_env: process.env.TERM })` (the pure predicate `isFancy`, §2 —
  named so it does not shadow the local `fancy`) and pass it as
  `wireRendering(agent, { fancy, … })`. Remove the `cli.ts:322/327` truncation (its
  data now lives in the model; full display is P2).

**Per-task acceptance commands:**
```
node --import tsx --test test/render-view-model.test.ts    # T1.1-T1.4
node --import tsx --test test/render-inline.test.ts        # T1.5-T1.8
node --import tsx --test test/render-tty.test.ts           # T1.10b (fancy predicate axes)
node --import tsx --test test/render-attribution.test.ts   # T1.9
node --import tsx --test test/cli.test.ts                  # T1.10a, T1.11
node --import tsx --test test/jsonl.test.ts test/jsonl-adoption.test.ts  # T1.12
git diff --quiet -- src/kernel && echo KERNEL-CLEAN        # AC6
npm test && npm run typecheck && npm run typecheck:test     # AC12 (partial)
```

**Exit condition:** problem (a) fixed — concurrent reasoning-search forks
de-interleave into ordered, attributed, auto-collapsed sections in the default
inline renderer; T1.1-T1.12 green; full `npm test` green; `git diff src/kernel`
empty; typechecks pass.

---

### Phase 2 — Display modes + commands (fixes problem b)

**Entry condition:** Phase 1 exit met.

**Design references:** D4 (`design §2`), KDD6 (`§4`), AC2/AC3/AC10 (`§7`).

**Task list (TDD order):**

Tests (create/extend):
- **T2.1** `test/render-modes.test.ts` — **mode transitions (AC10).** `applyControl`
  with `/details full` expands all sections; `collapsed` shows headers only; `auto`
  restores latest-expanded. *Invariant: each mode's collapse semantics per R-B.*
- **T2.2** `test/render-modes.test.ts` — **per-section expand/collapse (AC10).**
  `/expand n` opens exactly section n; `/collapse n` closes it; others unchanged.
  *Invariant: single-section control targets only that section.*
- **T2.3** `test/render-inline.test.ts` (extend) — **full params on demand (AC2).**
  A tool section with args >200 chars + multi-line result: in `collapsed`/`auto`
  the header shows a bounded summary; in `full` (or after `/expand n`) the rendered
  output contains the **entire** args string and **every** result line — substring
  equality, no `…`. *Invariant: full/expand shows untruncated content.*
- **T2.4** `test/render-modes.test.ts` — **no over-truncation guard (AC3).** Read
  each `src/render/*.ts` file and `src/cli.ts` via `readFileSync` + `assert.doesNotMatch`
  (the `test/jsonl-adoption.test.ts:12-38` precedent — **not** shell `grep`, which
  silently skips the non-ASCII render files that contain `◆`/`⠙`/`→`, giving a
  false green — CLAUDE.md macOS gotcha); assert no `slice(0, 79)` / `slice(0, 99)`
  display-truncation literal is present, and that the only width elision is a named
  summary-width constant used **only** for collapsed headers. *Invariant: the old
  aggressive truncation is gone and full mode elides nothing; the guard actually
  scans the glyph-bearing files.*

Implementation:
- **T2.5** `src/render/view-model.ts` — add `mode` to the model + `applyControl` cases
  (`setMode`, `expand`, `collapse`).
- **T2.6** `src/cli.ts` — register `/details`, `/expand`, `/collapse` host commands
  (in `registerHostCommands`) routing to the active renderer's `applyControl`;
  available in both renderers (commands, not keys).
- **T2.7** `src/render/inline.ts` — render each section per mode; a re-render on a
  control command reprints the affected sections below (progressive disclosure).

**Per-task acceptance commands:**
```
node --import tsx --test test/render-modes.test.ts
node --import tsx --test test/render-inline.test.ts
node --import tsx --test test/cli.test.ts
npm test && npm run typecheck && npm run typecheck:test
```

**Exit condition:** problem (b) fixed — full tool arguments + full results reachable
via `/details full` or `/expand n`; AC3 grep guard green; T2.1-T2.4 + full suite
green.

---

### Phase 3 — Alternate-screen TUI renderer (opt-in)

**Entry condition:** Phase 2 exit met.

**Design references:** D5 (`§2`), KDD8/KDD9 (`§4`), AC8(i,ii,iv)/AC10(Ctrl+T)
(`§7`).

**Task list (TDD order):**

Tests (create/extend):
- **T3.1** `test/render-tui.test.ts` — **differential frames (AC8 i).** Drive
  `TuiRenderer` over a fake `Term`; after one new section, frame 2 contains **no**
  `\x1b[2J` and emits `\x1b[0K` + rewrite for **exactly** the known-changed row
  indices the test controls. *Invariant: frames are differential, never a
  full-screen clear+repaint.*
- **T3.2** `test/render-tui.test.ts` — **capability gating (AC8 ii).** `/tui on`
  (and `--tui`) on a fake `Term` with `isTTY:false` or `TERM=dumb` refuses with an
  explanatory message and stays inline. *Invariant: the TUI never drives an
  incapable terminal.*
- **T3.3** `test/render-tui.test.ts` — **safe teardown (AC8 iv).** On exit / a
  simulated `SIGINT`, `restoreTerminal()` emits alt-screen exit + `setRawMode(false)`
  + cursor-show. *Invariant: the terminal is always restored, even on interrupt.*
- **T3.4** `test/render-tui.test.ts` — **focused-section key + slash-command
  repaint (AC10 TUI).** A fake-`Term` `Ctrl+T` keypress toggles the focused
  section's collapse state; and a `/details full` `applyControl` on the TUI
  renderer repaints the alt-screen frame with the section's expanded content.
  *Invariant: both the raw-mode single-key toggle and the slash-command path
  change the rendered TUI state — closing AC10's "both renderers" clause for the
  TUI half.*
- **T3.4b** `test/render-tui.test.ts` — **subagent card rendering (AC9, TUI half).**
  A scripted `spawn_agent` renders, in the **TUI** backend, a card whose header
  **names the subagent + task** with the child's sections **nested inside** it.
  *Invariant: AC9's "both renderers" + "header names subagent+task" clauses, TUI
  half* (completes AC9 with T1.2 reducer + T1.8b inline).

Implementation:
- **T3.5** `src/render/tui.ts` — enter/exit alt-screen; virtual line buffer +
  line-diff (only changed rows rewritten, no `\x1b[2J`); raw-key decode
  (Ctrl+T, arrows/PgUp/PgDn to scroll history); persistent bottom input+status bar;
  in-place collapse.
- **T3.6** `src/cli.ts` — `--tui` flag + `/tui on|off` command; KDD9 capability
  gate; register `restoreTerminal()` on exit/`SIGINT`/`SIGTERM`/`catch`/`/tui off`
  **before** entering the alt screen; suspend/restore readline around TUI ownership.

**Per-task acceptance commands:**
```
node --import tsx --test test/render-tui.test.ts
node --import tsx --test test/cli.test.ts
npm test && npm run typecheck && npm run typecheck:test
```

**Exit condition:** `/tui on` enters a differential alt-screen renderer with
raw-key controls and a persistent bar; refuses on incapable terminals; always
restores the terminal on teardown; T3.1-T3.4 + full suite green.

---

### Phase 4 — Side panel + suggest-hint

**Entry condition:** Phase 3 exit met.

**Design references:** D6/D7 (`§2`), AC8(iii,v) (`§7`).

**Task list (TDD order):**

Tests (extend):
- **T4.1** `test/render-tui.test.ts` — **side-panel gating (AC8 iii).** Panel
  present at `columns>=100`, absent below. *Invariant: panel only at wide widths.*
- **T4.2** `test/render-tui.test.ts` — **SIGWINCH reflow (AC8 v).** A fake-`Term`
  `columns` change crossing 100 makes the panel appear/disappear and the region
  reflow with no orphaned rows. *Invariant: resize across the boundary reflows
  cleanly.*
- **T4.3a** `test/render-tty.test.ts` — **startup suggest-hint decision (D7,
  positive + gating).** Drive the **pure** helper `shouldSuggestTui(term, {
  interactive, term_env, json })` (new, in `tty.ts` — mirrors `isFancy()`; the TTY-
  requiring positive case cannot be faked by a piped subprocess, round-1 G2) with
  an injected fake `Term`: a TUI-capable terminal (both TTYs, `TERM!=dumb`, inline
  active, non-json) returns `true`; each of `json`, non-TTY, and `TERM=dumb`
  returns `false`. *Invariant: the hint decision is true exactly in the
  interactive, TUI-capable, inline, non-json context.*
- **T4.3b** `test/cli.test.ts` — **hint suppressed on the subprocess axes (D7).**
  Via `runCli`: `--json` and `--eval` runs print **no** hint line on stdout
  (subprocess-runnable negative cases). *Invariant: no hint leaks into machine /
  non-interactive output.*

Implementation:
- **T4.4** `src/render/tui.ts` — right-hand panel (live tool/subagent/fork status)
  at `columns>=100`; `SIGWINCH` reflow.
- **T4.5** `src/render/tty.ts` + `src/cli.ts` — add the pure `shouldSuggestTui(...)`
  helper to `tty.ts`; in `main()`, print the startup hint once iff
  `shouldSuggestTui(process.stdout, { interactive, term_env: process.env.TERM,
  json: args.json })` (so the positive case is unit-tested in-process, honoring the
  zero-dep charter).

**Per-task acceptance commands:**
```
node --import tsx --test test/render-tui.test.ts
node --import tsx --test test/cli.test.ts
npm test && npm run typecheck && npm run typecheck:test
```

**Exit condition:** panel appears/reflows correctly by width; suggest-hint gated
correctly; T4.1-T4.3b + full suite green.

---

### Phase 5 — Docs + closeout

**Entry condition:** Phase 4 exit met.

**Design references:** D11 (`§2`).

**Task list:**
- **T5.1** `README.md` — add the new commands (`/details`, `/expand`, `/collapse`,
  `/tui`) and the `--tui` flag to the relevant tables, and a short "Display modes"
  subsection (full/collapsed/auto; the `◆ Reasoning` header; `fancy` vs plain).
- **T5.2** `CHANGELOG.md` — an entry for the progressive-disclosure TUI (both pain
  points fixed; new commands/flag; opt-in alt-screen TUI).
- **T5.3** `docs/` controls reference (extend `docs/JSONL.md`'s sibling area or a
  new `docs/TUI.md`) — document `/details`/`/expand`/`/collapse`/`/tui`, the TUI
  keys (Ctrl+T, arrows/PgUp/PgDn), the `fancy` predicate + `TERM=dumb`/pipe
  plain-append behavior, and the `N tok` estimate caveat (per AC7b's note).
- **T5.4** (regression) confirm `test/docs-drift.test.ts` green — **no
  `BUILTIN_EXTENSIONS` change** (KDD4: renderer is host code, not an extension), so
  the extension count is unchanged.

**Per-task acceptance commands:**
```
node --import tsx --test test/docs-drift.test.ts
npm test && npm run typecheck && npm run typecheck:test
npm run eval
npm run build
```

**Exit condition (AC12 full):** all five commands exit 0; docs consistent with the
shipped commands/flags.

## 3. Engineering Constraints Index

- **Engineering norms** (CLAUDE.md _engineering-norms_): ESM + NodeNext with `.js`
  import specifiers even for `.ts`; strict TS (`noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`) — model the types, no `any`;
  **zero runtime deps except `jiti`** (hand-rolled ANSI + `node:readline`/
  `process.stdin` raw mode only); tests via `node:test` + `tsx`, offline through
  `MockProvider`; comments explain the code, not the workflow (no `// Phase N` /
  `// per Decision` provenance in source).
- **Zero kernel change** (design §3, AC6): nothing under `src/kernel/` is edited;
  attribution imports the already-exported `currentActingAgent`/`currentRootAgent`.
- **Shared-mapper guard** (AC5): the new render code must **not** construct a
  `type:"<common-event>"` literal (`test/jsonl-adoption.test.ts` scans `cli.ts` +
  `server.ts`); the view-model uses a distinct field (e.g. `kind`), never `type`.
- **Four-corner subagent template**: `references/loop-3-development.md`.
- **Commit conventions** (SKILL.md): `feat(phaseN):` / `fix(phaseN-roundR):
  <keyword>`; `<TEST-CMD>`/`<ACCEPT-CMD>` results as trailers; **no** AI/model/tool
  mention, no `Co-Authored-By: Claude`, no `Claude-Session`/claude.ai trailer
  (CLAUDE.md house rule).

## 4. Data and Fixture Dependencies

- **Reuse:** `MockProvider` (`src/providers/mock.ts`) scripted with reasoning /
  text / tool turns (incl. `stopReason` for the `agent_end` regression);
  `stdoutOf` capture (`test/cli.test.ts:109-123`); the reasoning-search fork
  harness shape (`test/reasoning-search.test.ts:218-245`,
  `test/governed-subagents.test.ts:306-347`) for AC1b; the `makeHarness` helper
  (`test/helpers.ts`, imported by `test/cli.test.ts:10`).
- **New:** a **fake `Term`** test fixture (a `{ isTTY, columns, rows, write,
  setRawMode }` recording stub, and a keypress injector) — add to `test/helpers.ts`
  so `render-inline`/`render-tui` tests can drive fancy/TUI paths offline; a shared
  **spinner-frame constant** exported from `src/render/tty.ts` (its single home,
  per §2, alongside `isFancy()`) and imported by both the renderer and AC11's
  assertion; an `opts.now()` injected
  clock (a counter in tests) so timing is deterministic.

## 5. Regression Protection

- **Baseline (measured pre-change, this branch):** `npm test` = **1471 tests,
  1470 pass, 0 fail**; `typecheck`, `typecheck:test` exit 0. Every phase ends with
  the **full** suite green (count ≥ 1471 + new tests).
- **Cross-phase pins:** each later phase keeps all earlier `test/render-*.test.ts`
  green.
- **Always-green invariants (checked every phase):** `test/cli.test.ts:125-175`
  (agent_end warnings, AC4); `test/jsonl.test.ts` + `test/jsonl-adoption.test.ts`
  (JSONL + adoption, AC5); `git diff --quiet -- src/kernel` (AC6);
  `test/docs-drift.test.ts` (no extension-count change, KDD4);
  `test/kernel-surface.test.ts` (kernel ceiling untouched).
