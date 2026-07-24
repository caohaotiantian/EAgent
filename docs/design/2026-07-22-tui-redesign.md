# Design — TUI redesign: progressive disclosure for reasoning & tool calls

Slug: `2026-07-22-tui-redesign`
Status: closed
Closing-commit: `d32b1d0` (phases 1–5, code+docs) + this closeout
Closed-on: 2026-07-22
Deferred: none
Superseded-by: `docs/design/2026-07-23-tui-ink-rebuild.md` (the Ink rebuild — the
hand-rolled `src/render/` renderer this doc designed was removed and replaced).
Date: 2026-07-22

> L1 converged over 3 adversarial-panel rounds (severe count 3 → 0 → 0; two
> consecutive severe-free rounds; every general + clarification finding resolved).
> Delivered in 5 L3 phases (P1 view model + inline default → fixes problem (a);
> P2 modes + commands → fixes problem (b); P3 alt-screen TUI; P4 side panel + hint;
> P5 docs). Final suite 1515 tests / 0 fail; kernel untouched (AC6); eval 5/5; build
> green. Both original pain points verified fixed by unit tests (AC1a/AC1b/AC2/AC9)
> and an end-to-end behavior demonstration (F-gate). Every Deliverable D1-D11 and
> Acceptance Criterion AC1a-AC12 realized.
Audit input: `docs/design/2026-07-22-tui-redesign-audit.md` (Steps 1-3; every
current-behavior claim here traces to a `file:line` there).

### Requirements (verbatim from the task request)

These fix several sub-decisions the design would otherwise have to invent; quoted
so downstream review can check the design against the actual ask, not a
paraphrase.

- **R-A (reasoning):** "Default display mode for reasoning: **auto-collapsed**.
  While the block is actively streaming → show the latest 1-3 lines (prefer tail,
  not head) + spinner / token count. When the block finishes → collapse to a
  single header line: `◆ Reasoning · N tok · Xs` (or equivalent). User can expand
  any collapsed reasoning block to full content with a key (e.g. Ctrl+T / Enter on
  the header) or a global `/details` toggle. All events must be inserted in strict
  chronological order of arrival. Never interleave or re-order randomly."
- **R-B (tool cards):** "Provide **three explicit display modes**: **full** →
  always show complete args + results; **collapsed** → only the card header;
  **auto-collapsed** → latest tool stays expanded until the next section appears;
  previous ones collapse. … Subagent calls must show the subagent name, the
  task/prompt given to it, and its own nested tool calls in the same card
  hierarchy."
- **R-C (layout):** "**Prefer alternate-screen + differential rendering** to
  avoid flicker and scrollback pollution. Keep a persistent bottom input/status
  bar. When terminal width ≥ ~100 columns, optionally show a narrow side panel …
  Keyboard: expand/collapse focused section, global toggle for 'show full
  details', scroll history independently of the input line."

### Confirmed intent (AskUserQuestion, 2026-07-22)

Architecture = **Hybrid** — inline progressive-disclosure as the *default*
renderer, plus an **opt-in alternate-screen full TUI**; suggest switching to the
TUI when the terminal supports it. The full TUI **includes** the ≥100-col live
side panel and raw-mode single-key expand/collapse/scroll in this cycle.

## 1. Background and Purpose

The interactive CLI (`npm run dev`) has one append-only human renderer,
`wireRendering` (`src/cli.ts:290-347`): color-coded `stdout.write`/`console.log`
driven by two closure booleans, with no viewport, collapse/expand, or per-agent
attribution (audit Step 2 §A, §E, §G). Two concrete pain points fall out:

- **(a) reasoning-search floods the window in non-chronological order.**
  `reasoning-search` forks up to 5 child agents that run concurrently
  (`reasoning-search.ts:274-276`); `childScope()` shares the parent's intra-run
  event handlers by reference (`hooks.ts:167-177`, `36-42`), so every fork's
  `reasoning_delta`/`text_delta` fires the same two-boolean renderer, which cannot
  demultiplex 5 streams (audit Step 3a).
- **(b) tool calls never show full parameters.** Arguments are cut to 79 chars
  (`cli.ts:322`) and results to the first line then 99 chars (`cli.ts:327`), with
  no expand, mode, or override (audit Step 3b).

If we do nothing: reasoning-search stays unusable interactively (the flood buries
the prompt and final answer), and debugging any run from the TUI is impossible
without dropping to `--json` and reading raw JSONL by eye.

Purpose: a presentation-layer redesign that renders every reasoning block, search
step, and tool call as a **first-class, ordered, collapsible** unit; makes full
tool parameters/results reachable on demand; and does so with **zero kernel
change** and no change to any non-UI agent logic.

## 2. Deliverables

- [ ] **D1 — View model (pure reducer).** A new offline-testable module
      `src/render/view-model.ts`: a **pure** reducer that folds the lifecycle
      event stream (each event pre-tagged by the D2 adapter with its acting/root
      agent id and a monotonic timestamp) into an **ordered list of Sections** —
      `reasoning`, `answer`, `tool` (with nested children for subagents), and a
      `reasoning-search` parent grouping N fork sub-sections. Each Section carries:
      attribution, `status` (streaming/success/error), start/last timestamps, a
      size tally, collapse state, and the **full untruncated** payload. Ordering
      is strict arrival order of each section's first event. No ANSI, no I/O, no
      clock of its own (time enters as tagged data). *Exact reducer signature and
      state shape are specified in L2.* Mirrors the `src/complete.ts` pure-module
      precedent.
- [ ] **D2 — Attribution + framing adapter.** In the host, subscribe to
      `agent.hooks` and, for each event, tag it with the emitting agent's identity
      via `currentActingAgent()` / `currentRootAgent()` (imported from
      `./kernel/agent.js`; exported `index.ts:15`; backing `e.agent` at
      `extension.ts:249-250`) and a monotonic timestamp from a host clock, then
      feed the reducer. Fork/subagent streams are separated by agent **object
      identity** (keyed in a `WeakMap`; the `autocontinue` keying precedent,
      `silent-truncation-fix` KDD3). *The map's value shape is an L2 detail.*
- [ ] **D3 — Inline renderer (new default).** `src/render/inline.ts`:
      append-only painter of the view model for the interactive TTY. It uses **no
      raw mode** (readline keeps ownership of the `› ` prompt) — cursor control is
      limited to redrawing a **bounded active region** below the last committed
      line. While a block streams it shows the **tail** of the latest 1-3 lines
      with a spinner + running size, redrawing only that region **without** the
      alternate screen, so native scrollback and pipe output stay intact; on block
      end it commits a one-line header `◆ Reasoning · N tok · Xs`. Concurrent
      reasoning-search forks (no cross-fork interleaving — forks are separate
      sections by attribution) render as the current live tail **plus one
      aggregate progress line** (`⠙ N forks · k done`); a fork commits its own
      collapsed `◆` header when it finishes. The animated region is therefore
      bounded to `H` lines regardless of fork count (KDD5). Tool calls render as
      collapsed cards (name + key-arg summary + status + duration). Replaces
      `wireRendering` as the default human renderer; preserves the `agent_end`
      warning lines verbatim (audit Step 4.1). *Exact ANSI sequences are an L2
      detail.*
- [ ] **D4 — Display modes + controls.** The three R-B modes `full | collapsed |
      auto-collapsed` (default **auto-collapsed** per R-A): auto-collapsed keeps
      the latest section expanded until the next begins, then collapses it; `full`
      keeps all expanded; `collapsed` shows only headers. Controls: a global
      `/details [full|collapsed|auto]` toggle and per-section `/expand <n>` /
      `/collapse <n>` — available in **both** renderers (they are commands, not
      keys, so they need no raw mode). The `Ctrl+T` single-key toggle and the
      focused-section keys are a **TUI-only** feature (D5), because raw-mode
      keypress capture cannot coexist with readline's line-editing in inline mode;
      inline mode satisfies R-A's "a key **or** a global `/details` toggle" via the
      commands. Expanding reveals **complete, untruncated** arguments + full
      result/stdout/stderr.
- [ ] **D5 — Alternate-screen TUI renderer (opt-in).** `src/render/tui.ts`: an
      alt-screen renderer over the same view model — a persistent bottom
      input+status bar, an independently scrollable history region, and raw-mode
      single-key controls (`Ctrl+T` expand/collapse the focused section, a global
      details-mode toggle, arrow/PgUp/PgDn to scroll history independently of the
      input line), and in-place collapse, using **differential frame updates**
      (R-C). This is the **only** renderer that enters raw mode + the alt screen.
      Activated by `--tui` or `/tui on|off`; refuses (with an explanation) on an
      unsupported terminal (KDD9). *Frame-diff algorithm and key decoding are L2.*
- [ ] **D6 — Side panel (≥100 cols).** When the TUI renderer is active and
      `stdout.columns >= 100`, a narrow right-hand panel showing live tool /
      subagent / fork status; below 100 cols everything stays inline. Reflows on
      `SIGWINCH`.
- [ ] **D7 — "Suggest switching" hint.** On startup, in a TUI-capable terminal,
      while inline mode is active, print one dismissable line that `/tui on`
      enables the full interface. **Startup only** — never in
      `--json`/`--eval`/non-TTY, and no mid-run trigger.
- [ ] **D8 — Subagent nesting.** A `spawn_agent` (and job/team) call renders as a
      tool card whose header names the subagent + its task/prompt, with the
      child's own reasoning + tool calls nested **inside** that card as
      sub-sections (attribution by acting agent), in both renderers (R-B).
- [ ] **D9 — Non-interactive parity.** `--json`, `--eval`, piped batch, and any
      non-interactive run keep today's behavior: `--json` byte-identical JSONL;
      `--eval`/batch a clean plain line stream (no cursor control, alt-screen, or
      spinner). The plain path is selected by the **single predicate in KDD5**.
- [ ] **D10 — Tests.** Offline `node:test`: reducer units (ordering, fork
      de-interleaving, collapse/mode transitions, full-payload retention,
      subagent nesting); an **end-to-end** attribution test driving concurrent
      forks on the real bus (AC1b); inline-renderer stdout tests (active-region
      containment, coalescing, collapse header, full content on expand, concurrent
      forks); mode/command tests; TUI-renderer tests via an injected fake TTY
      (differential frames, raw keys, side-panel gating, capability refusal,
      teardown); regression pins for `agent_end` warnings and JSONL goldens; a
      guard that `src/kernel/` is untouched.
- [ ] **D11 — Docs.** README (new commands + a "display modes" section), CHANGELOG,
      a keybindings/controls reference for the TUI keys and `/details`/`/tui`.
      CLAUDE.md only if an extension is added (KDD4 says none — expected **no**
      count change).

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** `src/kernel/*.ts` untouched (gated by AC6). Attribution
  uses the already-exported `currentActingAgent`/`currentRootAgent`. The kernel
  line ceiling (2260/2265) is not approached.
- **No change to `--json`/JSONL shapes.** `wireJsonRendering` + `src/jsonl.ts` and
  their goldens (`test/jsonl.test.ts`, `test/jsonl-adoption.test.ts`) preserved
  byte-for-byte. Any machine-event emission routes through `jsonl.ts` (the
  adoption guard), never hand-rolled.
- **No change to any non-UI agent logic.** Tool execution, dispatch/ordering,
  reasoning generation, `reasoning-search` fork behavior, session/checkpoint
  state, capabilities, providers unchanged. Presentation only; childScope
  propagation (`test/hooks.test.ts`) preserved — the fix demultiplexes in the
  renderer, it does not sever propagation.
- **No new npm dependency.** Hand-rolled ANSI + `node:readline`/`process.stdin`
  raw mode only (zero-dep charter).
- **Exact parent-card nesting under ≥2 concurrent spawn-class cards is best-effort,
  not guaranteed.** Deterministic and correct for the single-open-parent case
  (reasoning-search; parallel `spawn_agent`) per KDD10; when two distinct spawn
  calls are dispatched concurrently a child may visually nest under the wrong
  sibling card (never a content mis-attribution). Fixing it would need a kernel
  parent-seam, which is out of scope.
- **No change to `src/server.ts`** (renders no terminal).
- **No change to content/context caps** (`limits.ts` 16 KB, `prune.ts` 2 KB,
  `compact.ts`, `mcp.ts`, `web.ts`, …). Those bound tokens/memory, not the screen;
  "full content on expand" means the full `result.content` the renderer receives,
  which may already be context-capped upstream by design (audit Step 1).
- **No display-mode persistence across runs/sessions**, **no `--details`
  flag / `EAGENT_DETAILS` env** (mode is runtime-toggleable via `/details` + the
  key, which R-A/R-C require; a persisted startup default is not requested), and
  **no mouse support**. Keyboard + commands only.
- **Windows console** is best-effort: the ANSI/raw-mode path targets POSIX
  terminals (matching the repo's posix-only `build:binary`); on a non-capable
  terminal the TUI refuses and inline mode is used.

## 4. Key Design Decisions

### KDD1 — Two rendering backends over one shared, pure view model
- **Problem:** the user chose Hybrid (inline default + opt-in alt-screen TUI).
  How to build two renderers without duplicating the hard logic (de-interleaving,
  ordering, collapse, nesting)?
- **Options:** (A) inline only; (B) alt-screen TUI only; (C) **hybrid over a
  shared pure view-model reducer**; (D) hybrid with two independent renderers,
  each re-deriving structure from raw events.
- **Choice: (C).** A pure reducer folds events → an ordered section tree; `inline`
  and `tui` are thin painters of it. Isolates every non-trivial decision into one
  offline-testable unit (the `src/complete.ts` precedent) and guarantees the two
  backends cannot diverge on ordering/content.
- **Reject (A)/(B):** the user asked for both. **Reject (D):** duplicating reducer
  logic is the divergence Simplicity-First and the `lib/`-shared-helper convention
  forbid; the two backends would drift on exactly the hard cases (fork ordering,
  subagent nesting).

### KDD2 — Attribution via `currentActingAgent()` (out-of-band), not event payloads
- **Problem:** demultiplexing the fork flood needs the emitting agent, but no
  event payload carries an agent id (`events.ts:37-43`).
- **Options:** (A) add an agent id/depth to the kernel event payloads; (B) read
  `currentActingAgent()`/`currentRootAgent()` inside the handler (out-of-band
  ALS); (C) a rendering **extension** using `e.agent`/`e.rootAgent`.
- **Choice: (B).** The ALS seams are bound in `run()` (`agent.ts:227-229`),
  propagate across `await`, and are exported (`index.ts:15`). Zero kernel change;
  nothing added to the JSONL contract. **Evidence scope (honest):** the existing
  test `test/extension.test.ts:180-236` proves `currentActingAgent()` resolves to
  the fork inside a **`tool_start`** handler; the design **extends** that to
  concurrent `reasoning_delta`/`text_delta` under `Promise.allSettled` forks,
  which AC1b covers end-to-end on the real bus (this is the linchpin, so it is
  test-gated, not assumed).
- **Reject (A):** a kernel change against a 5-line ceiling that also alters golden
  JSONL payloads (`test/jsonl.test.ts`) — a breaking change to a closed contract,
  for data recoverable out-of-band. **Reject (C):** the renderer owns stdout,
  readline, and raw mode — terminal ownership is a **host** concern; `e.agent` is
  itself just `currentActingAgent() ?? host.agent` (`extension.ts:249-250`), so an
  extension buys nothing and adds a docs-drift transaction.

### KDD3 — Default = inline; TUI is opt-in and environment-gated
- **Problem:** should the alt-screen TUI be the default?
- **Options:** (A) TUI default when TTY; (B) **inline default, TUI opt-in via
  `--tui`/`/tui`, suggested when supported**; (C) inline only unless `--tui`.
- **Choice: (B)** (the user's "hybrid, and suggest switching in the supported
  terminal"). Inline is safe everywhere (pipes, dumb terminals, `--json`),
  preserves native scrollback, and already fixes both pain points; the alt-screen
  TUI — which *replaces* native scrollback with an in-app buffer — is a deliberate
  opt-in with a startup hint. `/tui` refuses on a non-TTY / `TERM=dumb` /
  insufficient-capability terminal.
- **Reject (A):** silently entering the alt-screen (losing scrollback, breaking
  Ctrl-C/pipe expectations) by default is a surprising, hard-to-revert change for
  every user. **Reject (C):** drops the "suggest switching" intent.

### KDD4 — Code in host modules (`src/render/`) + CLI commands, not an extension or kernel
- **Problem:** where does the renderer live?
- **Options:** (A) grow `wireRendering` in `cli.ts`; (B) **new `src/render/` host
  modules + commands in `registerHostCommands`**; (C) a new extension.
- **Choice: (B).** The renderer is host-owned (stdout, readline, raw mode,
  alt-screen). New pure/near-pure modules keep `cli.ts` thin and testable;
  `/details`/`/expand`/`/collapse`/`/tui` join the existing host commands
  (`cli.ts:393-457`). No `BUILTIN_EXTENSIONS` change ⇒ no docs-drift extension
  transaction.
- **Reject (A):** one growing function is untestable and mixes three concerns.
  **Reject (C):** an extension cannot cleanly own raw-mode stdin/alt-screen against
  the host's readline, and it triggers the docs-drift transaction for a host
  concern.

### KDD5 — Streaming presentation & the single plain-append predicate
- **Problem:** R-A wants a live 1-3 line tail + spinner during streaming that
  collapses to a header on block end, in the **default** inline renderer, without
  rewriting scrolled-past history — and the non-interactive paths must emit **zero**
  cursor/spinner bytes. What gets the "fancy" path, and how is timing/size shown
  from a pure reducer?
- **Options for the live tail:** (A) print every token inline (today — the flood);
  (B) **maintain a bounded active region (≤3 lines) redrawn in place, committed to
  a one-line header on block end**; (C) buffer all reasoning, print only the
  header (no live tokens). **Choice: (B)** — R-A explicitly wants the live 1-3 line
  tail; (A) is the flood; (C) drops the requested live view.
- **Single plain-append predicate (fixes the D9/AC11 gap):** the inline fancy path
  (spinner + active-region redraw) runs **only when `fancy === true`**, where
  `fancy = interactive && stdout.isTTY && (stdout.columns ?? 0) > 0 &&
  process.env.TERM !== "dumb"`. `interactive` (`stdin.isTTY && args.eval ===
  undefined`, `cli.ts:113,177`) excludes `--eval`/batch even on a TTY; the
  `stdout.isTTY && columns>0` conjuncts close the **stdin-TTY / stdout-pipe** case
  (`eagent > log.txt`), where cursor bytes must not leak into a file; and the
  `TERM !== "dumb"` conjunct honors R2's `TERM=dumb` plain-append lever (and
  matches KDD9's TUI gate). `--json`, `--eval`, piped batch, non-TTY, redirected
  stdout, and `TERM=dumb` all take the **plain append** path (zero cursor/spinner
  bytes). This single `fancy` predicate is the sole source of the **inline**
  spinner/active-region decision; D9, AC11, and R2's width/`TERM` fallbacks all
  derive from it (those conjuncts *are* the R2 fallbacks, folded into the one
  predicate — not separate gates). The **alt screen** is a strictly stronger,
  separate opt-in: entering it additionally requires the TUI (`--tui`/`/tui on`)
  and passes KDD9's capability gate, with `fancy` a necessary precondition only.
- **Timing/size without breaking reducer purity:** the D2 adapter stamps each
  event with a monotonic timestamp and the reducer tallies a block's size from the
  text it receives; the header's `N tok` is a **char-derived size estimate**
  (labelled as an estimate, not a provider token count — no event splits usage
  reasoning-vs-answer, `events.ts:50`) and `Xs` is `lastTs − firstTs`. The reducer
  stays pure (time and size are data it is handed).
- **Redraw coalescing (declared throughput budget):** deltas are **coalesced per
  frame** — the active region redraws at most once per frame interval (a fixed
  cadence) and on block end, not once per `reasoning_delta`. A burst of K deltas
  within one interval yields **1** redraw (AC7 asserts this bound), preventing a
  redraw storm on a fast stream.
- **Bounded active region under concurrent forks (fixes the ≤3-line conflict):**
  the *animated* (redrawn-in-place) region is capped to a fixed `H` lines
  regardless of fork count — **one** live tail (≤3 lines) for the most-recently
  active stream **plus one** aggregate progress line (`⠙ N forks · k done`), so
  `H ≤ 4`. Per-fork detail is **not** animated: each fork commits a static
  collapsed `◆` header above the active region as it finishes. Thus 5 concurrent
  forks do not produce 5 animated lines (the round-2 inconsistency); AC7 bounds
  the region height for both the single-stream and the ≥3-concurrent-fork case.
- *Exact escape sequences, the frame cadence, and the value of `H` are L2 details.*

### KDD6 — Display modes & controls (realizing R-A/R-B, with the simpler alternative weighed)
- **Problem:** what modes/default/controls, given R-A/R-B name them but a simpler
  model exists?
- **Options:** (A) **the R-B three modes `full|collapsed|auto-collapsed`, default
  auto-collapsed (R-A), controlled by `/details` + `/expand`/`/collapse` in both
  renderers, plus the TUI's `Ctrl+T` key (R-A/R-C)**; (B) a single fixed layout
  with only per-section expand/collapse (no global mode); (C) two modes
  (`full`/`collapsed`) without `auto-collapsed`.
- **Choice: (A).** R-B fixes the three mode names and semantics verbatim; R-A
  fixes the default (`auto-collapsed`) and requires "a key **or** a global
  `/details` toggle"; R-C fixes the global "show full details" toggle and
  per-section expand/collapse. This is requirements realization, not an invented
  default. Per KDD9, the single-key `Ctrl+T` lives only in the raw-mode TUI; inline
  satisfies R-A's "key **or** `/details`" via `/details` (+ `/expand`/`/collapse`).
- **Reject (B):** it drops `auto-collapsed` and the global toggle the spec
  explicitly asks for. **Reject (C):** `auto-collapsed` (latest-expanded) is the
  headline behavior in R-A/R-B; dropping it fails the ask. **Dropped from the
  original draft (scope):** a `--details` startup flag and `EAGENT_DETAILS` env —
  neither is in R-A/R-B/R-C and a persisted preference is speculative
  (Simplicity-First); the runtime `/details` toggle satisfies the requirement.

### KDD7 — Fork de-interleaving & ordering (mechanism following from KDD1+KDD2)
- **Problem:** N concurrent forks' deltas must never share a line region, and
  sections must appear in strict arrival order (R-A "never interleave / re-order
  randomly").
- **Options:** (A) **per-acting-agent buffering** — each fork accumulates into its
  own sub-section keyed by agent identity (KDD2), nested under the
  `reasoning-search`/`spawn_agent` parent section, top-level order = each section's
  first-event arrival; (B) timestamp-merge all fork deltas into one region ordered
  by arrival (the today-flood shape, i.e. AC1's naive single-buffer baseline); (C)
  serialize forks so only one streams at a time (a behavior change to
  reasoning-search — out of scope per §3).
- **Choice: (A)** — it follows directly from KDD1's shared reducer + KDD2's
  identity attribution. **Reject (B):** that *is* the flood — interleaves
  independent streams into one unreadable region. **Reject (C):** it would alter
  non-UI agent logic (reasoning-search concurrency), which §3 forbids; the fix must
  be presentation-only.

### KDD8 — TUI frame updates: differential vs full repaint
- **Problem:** R-C says "prefer … differential rendering to avoid flicker and
  scrollback pollution." Full-region single-write repaint is simpler; is the
  differential complexity warranted?
- **Options:** (A) **differential frame updates** — diff the previous vs next
  rendered lines and rewrite only changed rows; (B) full-region repaint — clear +
  rewrite the whole managed region each frame; (C) coarse dirty-region tracking —
  repaint only a changed sub-rectangle.
- **Choice: (A)**, on R-C's explicit preference. Trade-off acknowledged: (B) is
  materially simpler and, for a bounded region written in a single `write`, often
  flicker-free; but a full-region **clear**-then-repaint per token on a scrolling
  history + persistent bottom bar can flicker and fights the "scrollback
  pollution" R-C calls out, and the user asked for differential specifically. The
  choice is bounded by a **concrete observable budget**, not an unmeasured "avoid
  flicker": AC8(i) asserts a frame that changes *k* rows emits **no full-screen
  clear** and clear-line+rewrite for **only** the changed rows.
- **Reject (B):** contradicts R-C's stated preference and risks flicker on the
  scrolling region. **Reject (C):** more bookkeeping than a line-diff for no
  clarity gain at terminal line granularity.

### KDD9 — Terminal capability detection & safe teardown
- **Problem:** the TUI must not corrupt a terminal it cannot drive, and must always
  restore it.
- **Choice:** `/tui`/`--tui` is gated on `stdout.isTTY && stdin.isTTY && TERM !==
  "dumb" && setRawMode` availability; on failure it refuses with a message and
  stays inline (KDD3). A single `restoreTerminal()` (alt-screen exit + raw-mode
  off + cursor show) is registered on normal exit, `SIGINT`/`SIGTERM`, the `catch`
  path, and `/tui off` **before** the alt-screen is ever entered — mirroring the
  existing signal/dispose discipline (`cli.ts:186-214`). Single-option because it
  is a safety invariant, not a product choice; its alternatives (leave the terminal
  as-is on crash) are simply incorrect.
- **Inline mode has nothing to restore.** It enters neither raw mode nor the alt
  screen (D3/D4); its only teardown is a trailing newline to commit the active
  region on exit/interrupt. So `restoreTerminal()` and R1 are TUI-scoped by
  construction — there is no inline raw-mode-leak path to wire (this closes the
  round-2 "does inline use raw mode?" question: it does not).

### KDD10 — Child→parent card nesting (temporal open-card correlation)
- **Problem:** the ALS seams give only the **leaf** (`currentActingAgent`) and the
  **run-tree root** (`currentRootAgent`) — no intermediate/parent pointer and no
  depth (`agent.ts:74-80`). De-interleaving needs only leaf identity (KDD7), but
  **nesting** a fork/subagent section under its *specific* parent tool card (D8;
  R-B "same card hierarchy") is not derivable from leaf+root when two parent cards
  are open at once. Tool dispatch is concurrent by default (`maxConcurrency ===
  Infinity`, `agent.ts:136`; `Promise.all`, `:459-460`), so two concurrent
  spawn-class tool calls can each open a card and spawn children that both
  attribute as `(leaf=child, root=root)`.
- **Options:** (A) **temporal open-card correlation** — when a delta arrives from a
  not-yet-seen non-root agent, nest its new section under the **open spawn-class
  tool card on the same root**; (B) add a parent seam / depth to the kernel ALS;
  (C) flatten — render every child section at root level, never nested.
- **Choice: (A), with documented graceful degradation.** In the dominant cases the
  open spawn-class card is **unique**: `reasoning-search` is a *single* `best_of_n`
  /`tree_search`/`graph_search` tool call whose execute forks internally, and a
  parallel `spawn_agent` is a *single* call spawning N children — one open card, so
  nesting is deterministic and correct. When **≥2** spawn-class cards are open
  concurrently (two distinct spawn calls dispatched in one wave), the parent is
  ambiguous; the reducer attaches to the most-recently-opened open spawn-class card
  (deterministic, never a crash), and this rare case is a **documented cosmetic
  limitation** (§3) — a child's own content never leaks into another section (that
  is guaranteed by identity, KDD7); only which *sibling card* it visually nests
  under can be wrong. AC9 covers the single-parent nesting deterministically.
- **Spawn-class classification (L2 detail).** Because a spawn call can share a wave
  with a non-spawn card (e.g. `bash`) under `maxConcurrency === Infinity`, the
  reducer must decide which open card is "spawn-class" to keep the single-parent
  case deterministic. L2 defines this with a **drift-proof signal** — a child
  section appearing on a root whose only open tool card is `C` binds to `C`
  regardless of `C`'s name (identity-driven, so it tracks all six forking
  extensions in the audit — reasoning-search, subagents, subagent-jobs,
  dynamic-workflow, sweep-edit, templates — without a hardcoded allowlist to drift).
  A name allowlist is the fallback only if the identity signal proves insufficient.
- **Reject (B):** a kernel change (parent seam/depth) against the 5-line ceiling
  and the zero-kernel-change scope, for a cosmetic nesting nicety. **Reject (C):**
  it fails R-B/D8's explicit "nested inside that card" requirement for the common
  single-parent case, which (A) satisfies deterministically.

## 5. Dependencies and Assumptions

- **Attribution seam (verbatim):** `currentActingAgent`/`currentRootAgent`
  (`src/kernel/agent.ts:76,80`), exported `src/kernel/index.ts:15`, bound in
  `run()` `src/kernel/agent.ts:227-229`, backing `e.agent`
  `src/kernel/extension.ts:249-250` (`get agent() { return currentActingAgent() ??
  host.agent; }`). Existing coverage: `test/extension.test.ts:180-236` proves
  attribution inside a **`tool_start`** handler (`assert.notEqual(actingAtLeaf,
  parent, …)` / `assert.equal(rootAtLeaf, parent, …)` at ~234-235). Concurrent
  streaming-delta attribution is **new** and gated by AC1b.
- **childScope propagation (verbatim):** intra-run events shared by reference,
  five lifecycle events suppressed — `src/kernel/hooks.ts:167-177`, `36-42`;
  pinned `test/hooks.test.ts:120-179`.
- **Truncation to remove (verbatim):** `src/cli.ts:322` (`args.slice(0, 79)` when
  `> 80`), `src/cli.ts:327` (`head.slice(0, 99)` first-line when `> 100`).
- **Invariants to preserve (verbatim):** `agent_end` warnings
  `test/cli.test.ts:125-175`; JSONL goldens `test/jsonl.test.ts:39-164`;
  shared-mapper guard — import `./jsonl.js` + call `wireJsonl(` at
  `test/jsonl-adoption.test.ts:18-23`, no inline `type:"<common-event>"` at
  `test/jsonl-adoption.test.ts:25-38`.
- **Event set & order (verbatim):** emit sites `src/kernel/agent.ts:239-352`,
  `413-490`; payloads `src/kernel/events.ts:20-53` (no per-block token count;
  `usage` is per model-call, `events.ts:50`).
- **Keying precedent (verbatim):** a `WeakMap` keyed on the acting agent,
  `docs/design/2026-07-15-silent-truncation-fix.md` KDD3 (there `WeakMap<Agent,
  number>`). Here the map is keyed on agent **identity**; the value holds
  render/section state (shape is an L2 detail).
- **Assumptions:** the interactive REPL reuses **one** root `Agent` across user
  turns (`silent-truncation-fix` §KDD3; `agent.ts:227`), so the renderer resets
  per-run view state on `agent_start` (suppressed for forks, so a fork never
  resets it). `stdout.columns`/`isTTY`/`TERM`/`setRawMode` are readable/available
  on the interactive TTY. A host monotonic clock exists for D2 timestamps (the CLI
  is not a workflow script; `performance.now()`/`process.hrtime` are available).
- **Baseline (measured 2026-07-22, pre-change, this branch):** `npm test` = **1471
  tests, 1470 pass, 0 fail**; `npm run typecheck`, `npm run typecheck:test` exit 0.
  (Confirm `eval`/`build` at L2 start.)

## 6. Relationship with Existing Designs

- **`docs/design/2026-07-22-tui-redesign-audit.md`** — the current-state audit
  this design consumes; no conflict.
- **`docs/design/2026-07-15-silent-truncation-fix.md`** — added the `agent_end`
  warning handler to `wireRendering` and the per-acting-agent `WeakMap` keying.
  **Preserve, no conflict:** D3 keeps the exact warning lines (Step 4.1) and reuses
  the keying pattern (KDD2). The new inline renderer replaces the *body* of
  `wireRendering` but keeps its `agent_end` contract.
- **`docs/design/2026-07-10-cli-json.md` / `2026-07-11-jsonl-unify.md`** — the
  `--json`/JSONL path and the shared-mapper adoption guard. **Preserve, no
  conflict:** D9/§3 keep JSONL byte-shapes and route any machine emission through
  `jsonl.ts`.
- **`docs/design/2026-07-14-multitenant-isolation.md`** — introduced
  `currentRootAgent()` + the `rootAgentStore` ALS this design reads for
  attribution. **Consume, no conflict.**
- Terminology anchors: `CLAUDE.md` (kernel primitives, events, `EAGENT_<NAME>`
  convention, capability vocabulary) and `README.md` (extension table). No conflict
  markers required.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1a (reducer de-interleaving & order — pure unit):** feed the reducer an
  event stream where two forks (distinct acting-agent ids) emit `reasoning_delta`s
  interleaved; the section tree has each fork's tokens in its **own** sub-section,
  both under one `reasoning-search` parent, ordered by first-delta arrival, with
  **no** sub-section containing another fork's text. Pure test on `view-model.ts`.
  RED against a naive single-buffer baseline.
- **AC1b (attribution linchpin — end-to-end on the real bus):** a
  reasoning-search-shaped harness runs **2+ real concurrent forks**
  (`childScope()` children under `Promise.allSettled`) emitting interleaved
  `reasoning_delta`/`text_delta`; the D2 adapter (using the real
  `currentActingAgent()`) routes them so the resulting section tree de-interleaves
  by fork with no cross-fork mixing. This gates KDD2's linchpin claim; RED if
  attribution is stubbed to the root. (R5 cites *this* test.)
- **AC2 (full params on demand):** a `tool` section from a `tool_start` with
  `JSON.stringify(arguments).length > 200` and a multi-line `tool_end` result: in
  `collapsed`/`auto` the header shows a summary; in `full` (or after `/expand
  <n>`) the rendered output contains the **entire** arguments string and **every**
  line of `result.content` (substring equality, no `…`). Renderer test.
- **AC3 (no over-truncation regression):** grep guard — `src/render/*.ts` and the
  new `cli.ts` render path contain no `slice(0, 79)`/`slice(0, 99)` display
  truncation; the only elision is a summary width used **solely** for collapsed
  headers, and `full` mode applies none.
- **AC4 (agent_end warnings preserved):** `test/cli.test.ts:125-175` passes
  unchanged (warn on `max_tokens`/`content_filter`/`refusal`; silent on
  `end_turn`/`stop`/`error`).
- **AC5 (JSONL unchanged):** `test/jsonl.test.ts` and `test/jsonl-adoption.test.ts`
  pass unchanged; a `--json` batch run's stdout is byte-identical to the
  pre-change baseline for a fixed scripted mock sequence.
- **AC6 (zero kernel change):** `git diff --stat src/kernel/` empty at task close;
  `test/kernel-surface.test.ts` green.
- **AC7 (inline active-region containment + coalescing — declared incremental
  budget):** through the inline renderer at **fixed `columns`** (fake TTY): (i) in
  a scripted reasoning-then-answer run, cursor-up rewrites touch **only** the
  active region — asserted by a regex over emitted `\x1b[\d*A` sequences, none
  exceeding the region height `H` (`≤4`, per KDD5); (ii) once a header/answer line
  is committed it appears exactly once (never rewritten); (iii) a burst of K
  `reasoning_delta`s within one frame interval produces **≤1** active-region redraw
  (coalescing bound); (iv) with **≥3 concurrent forks** streaming (distinct acting
  ids), the redrawn region height still stays `≤ H` (the aggregate-progress-line
  model, not one line per fork). Assumption: fixed-columns fake TTY (wrapping is
  handled by R2's re-anchor, not asserted here).
- **AC7b (collapsed reasoning header content):** on block end in a scripted
  reasoning run, the single committed header line matches the concrete regex
  `/◆ Reasoning · \d+ tok · [\d.]+s/` — i.e. it actually carries the token count
  and the elapsed seconds (`lastTs − firstTs`), not just the glyph (verifies R-A's
  headline output). The header uses R-A's **literal `N tok`** (a bare integer); the
  "char-derived estimate" caveat (KDD5) is a semantic note documented in the D11
  controls reference, **not** a header glyph — no `~`/`est` prefix, so the bare
  `\d+ tok` regex holds.
- **AC7c (inline resize re-anchor):** through the inline renderer, a fake-TTY
  `columns`/`SIGWINCH` change crossing a wrap boundary drops + re-anchors the
  active region with **no orphaned rows** (or falls to plain append when width
  becomes `0`) — the R2 inline-resize mitigation, made mechanical (mirrors
  AC8(v) for the TUI).
- **AC8 (TUI differential + gating — fake TTY):** driven through an injected fake
  TTY (rows/cols/isTTY/setRawMode/write): (i) after one new section, frame 2
  contains **no** full-screen clear (`\x1b[2J`) and emits clear-line (`\x1b[0K`) +
  rewrite for **exactly** the known-changed row indices the test controls; (ii)
  `--tui`/`/tui on` on `isTTY:false` or `TERM=dumb` refuses with an explanatory
  message and stays inline; (iii) the side panel appears at `columns>=100`, absent
  below; (iv) teardown emits alt-screen exit + `setRawMode(false)` + cursor-show
  (terminal restored); (v) a `SIGWINCH`/`columns` change crossing 100 (from a fake
  TTY) makes the side panel appear/disappear and the region reflow, emitting no
  full-screen garble (no orphaned rows) — the D6 reflow claim, made mechanical.
- **AC9 (subagent nesting — deterministic single-parent):** a scripted
  `spawn_agent` whose child emits its own `tool_start`/`text_delta` produces a
  `tool` section whose header names the subagent + task and whose **children** are
  the child's nested sections, under the **unique open** spawn-class card (KDD10);
  asserted on the section tree and both renderers. (The ≥2-concurrent-parent case
  is scope-noted, §3, not asserted.)
- **AC10 (mode/command behavior):** `/details full|collapsed|auto`, `/expand <n>`,
  `/collapse <n>` change the rendered collapse state as R-A/R-B specify in **both**
  renderers; the TUI's `Ctrl+T` focused-section toggle is asserted via the fake-TTY
  key path (AC8). Unit + renderer tests.
- **AC11 (non-interactive parity):** `--eval`, a **stdin-TTY / stdout-pipe** run
  (`interactive` true but stdout not a TTY, the round-2 axis trap), a **`TERM=dumb`
  interactive TTY** (both TTYs but `TERM=dumb`, the round-3 axis), and piped batch
  each produce a plain line stream containing **none** of: alt-screen
  (`/\x1b\[\?1049/`), cursor-up (`/\x1b\[\d*A/`), or the spinner frames (the
  concrete set chosen at L2 — e.g. the braille frames `⠙⠹⠸…` or an ASCII
  `|/-\\` set — pinned as a shared constant the test imports so the assertion is
  exact); `--json` unchanged (AC5).
- **AC12 (gates):** `npm test`, `npm run typecheck`, `npm run typecheck:test`,
  `npm run eval` (5/5), `npm run build` all exit 0.

## 8. Risks and Rollback

- **R1 — Terminal left broken (raw mode / alt-screen not restored).** Highest
  severity. Mitigation: the single `restoreTerminal()` of KDD9, wired to exit /
  `SIGINT` / `SIGTERM` / `catch` / `/tui off`, registered before the alt-screen is
  entered. Test AC8(iv). Rollback: `/tui off` → inline; `--tui` off by default.
- **R2 — Inline active-region redraw corrupts output on wrapping/resize.** Cursor
  math breaks if a tail line wraps. Mitigation: compute wrapped-line count from
  `stdout.columns`; on `SIGWINCH` drop the active region and re-anchor; cap the
  **tail** to ≤3 unwrapped lines (the animated region is `H ≤ 4` per KDD5) and
  fall back to plain append when width is unknown/`0`. AC7 asserts the
  fixed-columns case and **AC7c** the inline `SIGWINCH`/resize re-anchor. Rollback:
  non-interactive, `TERM=dumb`, or redirected stdout all force plain append (the
  `fancy` predicate honors each — KDD5).
- **R3 — Regressing the `--json`/pipe contract.** Mitigation: machine paths never
  touch the new renderer (D9, the KDD5 predicate); the shared-mapper guard (AC5)
  fails the build on any inline `type:"<event>"`. Rollback: the JSONL path is a
  separate untouched function.
- **R4 — Scope/size.** Largest deliverable in the repo. Mitigation: the shared
  view model + inline renderer land and fix both pain points **before** the
  alt-screen TUI (L2 phase order D1→D4 first, D5→D8 after); value is realized and
  each phase is independently green; the TUI is additive and opt-in. Rollback per
  phase.
- **R5 — Concurrent-fork attribution fails in a real streaming handler.** The
  existing evidence is `tool_start`-scoped (KDD2/§5). Mitigation: **AC1b** drives
  2+ real concurrent forks through the real bus + the D2 adapter and asserts
  de-interleaving — the linchpin is test-gated, not assumed. If AC1b cannot be made
  to pass, STOP and escalate (the whole flood fix depends on it).
- **R6 — `currentActingAgent()` returns undefined in a handler.** Would collapse
  attribution to the root. Mitigation: `?? rootAgentId` fallback (the
  `extension.ts:249-250` shape); a delta with no acting agent renders under root —
  never a crash.
- **Overall rollback:** host-only and phase-isolated. Reverting `src/render/*` +
  the `cli.ts` wiring restores `wireRendering` exactly (kept in git history); no
  kernel/provider/extension/server code is touched, so a full revert cannot affect
  agent behavior. Branch `chore/tui-redesign`, PR-gated to `init`.
