# Implementation — TUI rebuild: decoupled Ink client + HTTP/SSE monitor

Slug: `2026-07-23-tui-ink-rebuild` (identical to the design doc)
Status: closed
Closing-commit: `da3efd8`
Closed-on: 2026-07-23
Deferred: none
Supersedes: `docs/implementation/2026-07-22-tui-redesign.md`
Full-cycle outcome: L2 closed (4 rounds, severe → 5 → 4 → 0/0); L3 phases P1–P6 all
merged (6711bf9 · aba9df3 · 566fe91 · b49e9f8+b73d9c0 · c6fc5c7+b585c6b ·
189aaa4+da3efd8) + main-agent PhaseEnd-verified each; F end-to-end review PASS.
Design doc: `docs/design/2026-07-23-tui-ink-rebuild.md`

> **Trace rule.** Every task maps to a design Deliverable (D1-D10) or Acceptance
> Criterion (AC1-AC13, AC6b, AC-engine-plain). No task adds a requirement absent
> from the design; a discovered gap rolls back to L1.

## 1. Task Index (design ↔ phase)

| Design | Phase |
| --- | --- |
| D6 server endpoints; AC6/AC6b | P1 |
| Shared reducer core (`src/view-model.ts`) + in-process attribution adapter (re-homed `wire`); `Term`-seam relocation; D7/D8/KDD5/AC11 | P2 |
| Engine minimal plain renderer + `cli.ts` rewire; D7/AC-engine-plain/AC8 | P2 |
| Delete `src/render/` ANSI painters (`inline/tui/tty`); AC11 | P2 |
| D2 `SessionSource` (`InProcessSource` + `RemoteSource`); AC5 | P3 |
| D1/D3/D4 Ink module + components + `build:tui` + `eagent-tui` bin; AC2/AC3/AC4/AC12; KDD6 | P4 |
| D5 monitor/manager view; AC7 | P5 |
| D9 deps/build; D10 docs; AC9/AC13; charter amend | across P1-P6, closed P6 |

**Common commands** (CLAUDE.md _common-commands_): `<TEST-CMD>` = `npm test`;
single file = `node --import tsx --test test/<file>.test.ts`; also gated:
`npm run typecheck`, `typecheck:test`, `eval`, `build`, `build:binary`. New:
`build:tui` (added P4).

## 2. Phase Breakdown

### Phase 1 — Server monitor endpoints (additive, zero-dep, Ink-free)

**Entry:** baseline green. **Design refs:** D6, KDD7, AC6/AC6b (`design §2/§4/§7`),
plus §5 codebase facts (`server.ts:263/380/480/504`).

**Tasks (TDD order):**
- **T1.1** (test) `test/server-monitor.test.ts` — **`GET /sessions` list (AC6).**
  With two live sessions, the route returns an array of `{id, running, usage,
  costUsd}` for both; auth per `server.ts:263` (401 when a token is configured and
  omitted; 200 open when none). *Invariant: the monitor can enumerate sessions
  without knowing ids.*
- **T1.2** (test) — **`POST /sessions/:id/stop` (AC6).** Aborts a running turn: the
  target session's `agent.running` → false; unknown id → 404; auth-gated. *Invariant:
  the monitor can stop a running turn.*
- **T1.3** (test) — **per-session SSE feed + tenant isolation (AC6/AC6b).** `GET
  /sessions/:id/events` responds `content-type: text/event-stream`, emits a
  `connected` event, then, while **that** session runs a scripted turn, streams its
  bus events; and on a **two-session** server, session A's feed contains **only** A's
  events while B runs (no cross-session leakage). *Invariant: the shared hooks bus is
  filtered by run-tree root agent (`currentRootAgent() === agent`); no tenant leak.*
- **T1.4** (test) — **global `GET /events` with session-tagged frames (AC6).** SSE
  stream; each frame carries a `session` id; a `connected` first event. *Invariant: a
  multi-session client can demux the global stream.*

Impl (after RED):
- **T1.5** `src/server.ts` — add `GET /sessions` (map the session pool to
  `{id, running, usage, costUsd}` via `agent.usage` + `costUsdFor`), `GET
  /sessions/:id/events` + `GET /events` (SSE: set headers, write `event: connected`,
  subscribe to `agent.hooks` and re-emit hook-bus events through `eventToJsonl`,
  filtering per session by `currentRootAgent() === agent` — the `:480/504` precedent;
  global feed tags each frame with the session id), `POST /sessions/:id/stop`
  (`agent.stop()`). Reuse the existing auth gate + `sendJson` + session pool. Update
  the advertised routes list (`:368`). **No kernel change.**

**Acceptance:**
```
node --import tsx --test test/server-monitor.test.ts
node --import tsx --test test/host.test.ts test/hardened-profile.test.ts
git diff --quiet -- src/kernel && echo KERNEL-CLEAN
npm test && npm run typecheck && npm run typecheck:test
```
**Exit:** the four monitor routes work with tenant isolation + auth; full suite green;
kernel untouched. (Independently shippable — no renderer change yet.)

---

### Phase 2 — Shared cores + engine plain renderer; retire the alt-screen surface

**Entry:** P1 green. **Design refs:** D7, D8, KDD5, **KDD6** (authorizes removing
`--tui`/`/tui`), AC-engine-plain, AC8, AC11. §5 anchors: `Term` seam
`test/helpers.ts:10` (→ ~86 test files); `wireRendering`/`agent_end`
`cli.ts:448-458`; warning tests `test/cli.test.ts` ~150-210. **`src/render/tty.ts`
symbol split** — SURVIVING (relocate to `src/tty.ts`): `Term`, `fromStdio`, `isFancy`,
`shouldSuggestTui` (with `canUseTui`'s raw-mode/TTY/non-dumb conjuncts **inlined** so it
compiles standalone — see T2.6), `SPINNER_FRAMES`, and **`RenderController`** — the
shared display-control seam (`applyControl` + `mode`) that the DEFAULT renderer
implements and the `/details`//`/expand`//`/collapse` command layer routes through; it
is NOT alt-screen-only, so the engine plain renderer keeps it (T2.7). DELETE (genuinely
alt-screen-only): `RenderBackend` (its `onModel`/`notice` frame-routing is alt-screen-
coupled) and `canUseTui` (folded into `shouldSuggestTui`). **Alt-screen surface to
remove** (coupled to the deleted painters): `cli.ts` `--tui` flag (`:75` + `Args.tui`),
`/tui` command (`:722`), `createTuiHost`/`TuiHost` (`:533`), `attachRawKeys`/
`resumeLineInput`, the `wireRendering` `backend` routing; and the coupled
`test/cli.test.ts` blocks (imports `:9`/`:13-15`; `RenderBackend` backend-routing
`:224-242`; `--tui` keep-alive `:355`; `resumeLineInput` `:379`) — but `FakeController`/
`displayCommands`/`stripAnsi` **survive**, the `/details`//`/expand`//`/collapse`
command-dispatch tests (`~:290-353`) keep driving `FakeController` unchanged, and only the
lone real-`InlineRenderer` test (`~:342-353`) is **rewired** to the engine renderer (which
implements `RenderController`).

**Tasks (TDD order):**

Relocate (pure move, no behavior change; suite stays green throughout):
- **T2.1** — move the pure reducer `src/render/view-model.ts` → **`src/view-model.ts`**;
  the in-process attribution adapter `src/render/wire.ts` → **`src/attribution.ts`**
  (strip ANSI coupling; keep the `currentActingAgent()`/`currentRootAgent()` tagging +
  coalescing-timestamp role); and the **surviving** tty seam (`Term`, `fromStdio`,
  `isFancy`, `shouldSuggestTui`, `SPINNER_FRAMES`, **`RenderController`**)
  `src/render/tty.ts` → **`src/tty.ts`** (the design-sanctioned relocation home the
  engine renderer + the `eagent-tui` hint both consume; D7/D8). Fold `canUseTui`'s
  raw-mode/TTY/non-dumb conjuncts **into** `shouldSuggestTui` so it compiles without
  `canUseTui` (the gate still reflects that `eagent-tui` inherits the current terminal —
  see T2.6; `canUseTui`-the-function persists in the temporary `render/tty.ts` remnant
  until T2.9 deletes it — only `shouldSuggestTui`'s call site is inlined here). Relocate
  the surviving reducer tests too: `test/render-view-model.test.ts` (`reduce` coverage) →
  **`test/view-model.test.ts`**, and fold `test/render-modes.test.ts`'s `applyControl` +
  mode-transition coverage **into** `test/view-model.test.ts` — do **not** delete it (it
  is the sole coverage of the surviving `applyControl`, load-bearing for both the engine
  renderer and the Ink components); **dedupe** the `fold`/`call`/`result` helpers the two
  merged files both declare. Its anti-truncation **source-scan** arm stays green at T2.1
  by **dropping** the `readdirSync(src/render)` directory enumeration + `renderFiles.length
  >= 4` self-check (both fail once `view-model.ts` relocates at T2.1 and the dir is deleted
  at T2.9) in favor of an **explicit scanned-file list**: repoint the summary-width
  `readFileSync` to `src/view-model.ts`, keep the full-body target on the still-present
  `src/render/inline.ts`, and add the `src/engine-render.ts` arm in **T2.7** once that file
  exists (a literal T2.1 pointing the scan at `src/engine-render.ts` would `ENOENT` before
  T2.7). Repoint every importer — the
  enumerated live ones are
  `test/helpers.ts:10` (`Term`), `src/cli.ts:29` (`fromStdio`/`isFancy`/`shouldSuggestTui`/
  `Term` → `src/tty.js`) and `:30` (`wireViewModel` → `src/attribution.js`),
  `test/cli.test.ts:14` (`SPINNER_FRAMES`/`RenderController` → `src/tty.js`) and `:15`
  (`ControlAction`/`DisplayMode` → `src/view-model.js`), the still-present painter TESTS
  that **value**-import the moved modules — `test/render-inline.test.ts`,
  `test/render-tui.test.ts`, `test/render-attribution.test.ts` (repoint at T2.1 even though
  they are relocated/deleted later at T2.6/T2.9, else `npm test` throws
  `ERR_MODULE_NOT_FOUND` in the interim) — and the still-present `src/render/{inline,tui}` +
  the `render/tty.ts` remnant (temporary); **`npm test` + `npm run typecheck:test` are the
  completeness backstop** (plain `npm run typecheck` excludes `test/`, so it would miss a
  stranded test-file import) for any importer not listed here. **Full suite green.**
  *Invariant: no import strands; behavior identical (pure move).*

Tests (RED before the impl):
- **T2.2** `test/engine-plain-render.test.ts` — **de-interleaving preserved
  (AC-engine-plain).** Two concurrent reasoning-search forks (real `childScope()`
  under `Promise.allSettled`, the `test/render-attribution.test.ts` harness) → each
  fork's reasoning in its **own** section (no cross-fork mixing); reasoning
  **collapses** to a header. *Invariant: the reasoning-search fix survives on the
  non-Ink path.*
- **T2.3** `test/engine-plain-render.test.ts` — **full tool params reachable
  (AC-engine-plain).** A tool card shows name + key args; full untruncated args +
  result reachable (the mode/expand the engine renderer keeps). *Invariant: the
  truncation fix survives.*
- **T2.4** `test/cli.test.ts` (rewired) — **`agent_end` warnings preserved
  (AC-engine-plain).** The `max_tokens`/`content_filter`/`refusal` warning tests
  (~150-210) pass, driving the **rewired** `wireRendering`. *Invariant: abnormal-
  termination warnings still print.*
- **T2.5** — **machine-path parity (AC8).** `--json` batch stdout byte-identical to
  baseline; `--eval`/piped batch a plain line stream with no alt-screen/cursor bytes;
  `test/jsonl.test.ts` + `test/jsonl-adoption.test.ts` unchanged.
- **T2.6** `test/tty.test.ts` (relocated from `render-tty.test.ts`) — assertions for
  the **surviving** predicates `isFancy`/`shouldSuggestTui`/`SPINNER_FRAMES` against
  their new `src/tty.js` home; `shouldSuggestTui`'s positive case still requires a
  raw-mode-capable `Term` (the folded-in `canUseTui` conjuncts: TTY + `setRawMode`
  present + non-dumb + interactive/non-json), which is correct because the suggested
  `eagent-tui` process inherits this same terminal. `render-tty.test.ts`'s
  `InlineRenderer`-driven plain-render **byte-parity** axes (which import the deleted
  `InlineRenderer`) do **not** come along: move them to `test/engine-plain-render.test.ts`
  (driving the **engine renderer** through a fake non-TTY `Term`) or drop them as subsumed
  by the T2.5 subprocess parity (AC8) — never carry the deleted-`InlineRenderer` import
  into `tty.test.ts`. *Invariant: the retained predicate behavior — including the raw-mode
  gate — keeps coverage after the split.*

Impl + cutover:
- **T2.7** `src/engine-render.ts` (new) — the minimal ordering-aware plain renderer:
  consumes `src/view-model.ts` + `src/attribution.ts` + `src/tty.ts`; plain ANSI
  (colors only, no alt-screen, no active-region redraw); coalesces; **implements the
  retained `RenderController` seam** (`applyControl` + `mode`, imported from
  `src/tty.ts`) so the `/details`//`/expand`//`/collapse` command layer drives it
  unchanged; keeps a `/details`-equivalent + expand for full content on demand;
  preserves the `agent_end`/`error` handlers verbatim. Now that this file exists,
  **extend** the anti-truncation source-scan (folded into `test/view-model.test.ts` at
  T2.1) to add `src/engine-render.ts` as a scanned no-truncation target.
- **T2.8** `src/cli.ts` — **rewire** `wireRendering` (keep the export; drop the
  `backend` alt-screen opt) to the new engine renderer; **re-type** `ActiveRenderer {
  current?: RenderController }` and the `registerHostCommands` display-command wiring
  (`:34`/`:179`/`:217`/`:254`) to import `RenderController` from **`src/tty.ts`**
  (retained) and route `/details`//`/expand`//`/collapse` to the engine renderer that
  implements it; and **remove the alt-screen surface** (KDD6): the `--tui` flag
  (`parseArgs` + `Args.tui`), the `/tui` command registration, `createTuiHost`/
  `TuiHost`, `attachRawKeys`/`resumeLineInput`, and the backend routing; **repurpose**
  the startup hint to suggest **`eagent-tui`** (reusing `shouldSuggestTui` from
  `src/tty.ts`). No `src/render/*` import remains.
- **T2.9** — **delete** `src/render/{inline,tui,tty}.ts` (painters; tty's survivors
  already relocated in T2.1) and the obsolete **painter** tests (`render-inline`,
  `render-tui`); `render-attribution` → `test/attribution.test.ts`, while
  `render-view-model`/`render-modes` were already folded into `test/view-model.test.ts`
  in T2.1 (their `reduce` + `applyControl` coverage is **kept**, not dropped). **Rewrite
  `test/cli.test.ts` imports precisely**: drop `:9` `attachRawKeys`/`resumeLineInput`
  (removed in T2.8) and `:13` `InlineRenderer` + `:14` `RenderBackend` (deleted);
  **repoint** `:14` `SPINNER_FRAMES` and `RenderController` → `../src/tty.js`
  (survivors) and `:15` `ControlAction`/`DisplayMode` → `../src/view-model.js`.
  **Keep the command-layer scaffolding** — `FakeController` (a recording
  `RenderController` double that records `.calls`), `displayCommands`, and `stripAnsi`
  all **survive** (generic dispatch scaffolding, not alt-screen); the
  `/details`//`/expand`//`/collapse` command-dispatch tests keep driving `FakeController`
  and their `.calls`-granularity assertions **unchanged**. **Rewire only** the single test
  that instantiates the real `InlineRenderer` (`~:342-353`) to drive the **engine
  renderer** as the `RenderController` instead (its applied-control state stays observable
  via the retained `.mode` getter, so its assertion keeps its granularity). **Remove only
  the genuinely alt-screen tests**: `RenderBackend` backend-routing (`~:224-242`), `--tui`
  keep-alive (`~:355`), `resumeLineInput` (`~:379`). **Keep** the `agent_end` warning
  tests. *Invariant (the green-gate is authoritative — line refs are drift guidance, not
  gospel):* after the rewrite `npm test` + `typecheck:test` are green, the
  `/details`//`/expand`//`/collapse` dispatch coverage + `agent_end` warnings survive, and
  no alt-screen test remains. Verify AC11 via a **`readFileSync` scan (not shell grep —
  macOS non-ASCII gotcha)** that no `src/`/`test/` file imports `../render/*` and
  `src/render/` no longer exists.

**Acceptance:**
```
node --import tsx --test test/engine-plain-render.test.ts test/tty.test.ts
node --import tsx --test test/cli.test.ts
node --import tsx --test test/jsonl.test.ts test/jsonl-adoption.test.ts
node --import tsx --test test/view-model.test.ts test/attribution.test.ts   # relocated
node --import tsx --test test/render-removed.test.ts   # readFileSync scan: no ../render/* import; dir gone (AC11)
git diff --quiet -- src/kernel && echo KERNEL-CLEAN
npm test && npm run typecheck && npm run typecheck:test && npm run build && npm run build:binary
printf 'hi\n' | bin/eagent -p mock   # engine plain CLI still works
```
**Exit:** `src/render/` gone; the alt-screen surface (`--tui`/`/tui`/createTuiHost/
attachRawKeys/resumeLineInput) removed; `test/cli.test.ts` rewired + green; the engine
plain renderer preserves de-interleaving + tool-full-params + `agent_end` warnings +
`--json` parity; SEA `bin/eagent` builds + runs the plain CLI; full suite green; kernel
untouched. **The cutover phase — after it the engine is Ink-free, zero-dep, non-regressed.**

---

### Phase 3 — `SessionSource` abstraction (`InProcessSource` + `RemoteSource`)

**Entry:** P2 green. **Design refs:** D2, KDD3, AC5.

**Tasks (TDD order):**
- **T3.1** (test) `test/session-source.test.ts` — **`InProcessSource` (AC5-ish,
  in-process).** Wraps a local `Agent`; subscribing yields the ordered lifecycle
  events tagged via the shared `src/attribution.ts`; the control surface (run/answer/
  stop) drives the agent. *Invariant: the in-process source is a faithful ordered
  event stream + control.*
- **T3.2** (test) — **`RemoteSource` SSE parse + reconnect (AC5).** Against an
  in-process stub HTTP server emitting scripted SSE frames (`connected`, then
  `tool_start`/`text_delta`/`agent_end`, each with a `session` id), `RemoteSource`
  yields an ordered stream matching the frames, exposes the control surface via
  `POST /run`/`/answer`/`/sessions/:id/stop`, and **reconnects** after a dropped
  connection. *Invariant: the remote source faithfully mirrors a server session
  offline-testably.*

Impl:
- **T3.3** `src/tui/source.ts` — the `SessionSource` interface + `InProcessSource`
  (imports kernel/host + `src/attribution.ts`) + `RemoteSource` (Node `http` client +
  a small SSE line parser + reconnect/backoff). (Lives under `src/tui/` — it is a TUI
  concern; the engine does not import it. But it imports the neutral shared cores, not
  Ink.)

**Acceptance:**
```
node --import tsx --test test/session-source.test.ts
git diff --quiet -- src/kernel && echo KERNEL-CLEAN
npm test && npm run typecheck && npm run typecheck:test
```
**Exit:** both sources pass their offline tests; full suite green; kernel untouched.
(No Ink yet; `RemoteSource` uses only Node `http`.)

---

### Phase 4 — Ink TUI module: single-session client

**Entry:** P3 green. **Design refs:** D1, D3, D4, KDD1, KDD4, KDD6, KDD8, AC2/AC3/AC4/
AC9/AC12/AC13. Spike build recipe (§5): esbuild ESM + the two shims.

**Tasks (TDD order):**
- **T4.1** (build + JSX toolchain) — add `ink`, `react` to `package.json`
  **dependencies** and `ink-testing-library` + `@types/react` to **devDependencies**
  (pinned). **JSX toolchain:** components are **`.tsx`** under `src/tui/`; add
  `"jsx": "react-jsx"` to `tsconfig.json` and ensure its `include` compiles
  `src/tui/**/*.tsx` (so `typecheck` + `npm run build` type-check the Ink surface —
  the strict-TS norm must reach it), and to `tsconfig.test.json` for `test/tui/**`.
  **Tests:** Ink component tests are **`.tsx`** (`test/tui/*.test.tsx`) — extend the
  `npm test` glob (`test/**/*.test.ts` → also match `.test.tsx`, e.g. via a
  `test:tui` script `node --import tsx --test "test/tui/**/*.test.tsx"` folded into
  `test`, or broaden the glob) so AC2/AC3/AC4/AC7 actually run in CI. Add `build:tui`
  (esbuild `--format=esm --jsx=automatic` + `--alias:react-devtools-core=<stub>` +
  the `createRequire` `--banner:js`, per §5) → the self-contained ESM bundle
  **`dist/tui/bundle.mjs`** (the AC12 size-gated artifact); confirm the standard
  `npm run build` (tsc) emits `dist/tui/main.js` for the `eagent-tui` bin on a plain
  install with `node_modules` present (`prepublishOnly` = `npm run build`). Add the
  **`eagent-tui`** bin (`package.json` bin, matching `eagent-serve`) → `dist/tui/main.js`.
  **No `build:binary` change** is needed for AC9: `build-binary.mjs` esbuilds from
  `dist/cli.js`'s import graph, which never reaches `src/tui/` after P2 (esbuild
  tree-shakes it); AC9 is enforced by the T4.4 import-graph `readFileSync` scan (an
  optional release-time bundle grep is verification only).
- **T4.2** (test) `test/tui/transcript.test.tsx` — **Ink renders the section tree
  (AC2).** `ink-testing-library` `render()` of the transcript component from a
  scripted `InProcessSource`-shaped stream; `lastFrame()` contains the reasoning
  header, an expanded tool card with **full untruncated** args, and a nested subagent
  card. *Invariant: the rich client shows the section tree + full params + nesting.*
- **T4.3** (test) — **coalescing budget (AC3)** + **bounded viewport (AC4).** K
  `reasoning_delta`s within one frame interval → ≤1 state update; a transcript far
  exceeding the fake `rows` → bounded frame height. *Invariant: the flood is
  coalesced + windowed.*
- **T4.4** (test) `test/tui-isolation.test.ts` — **dependency isolation (AC9).** A
  `readFileSync` scan asserts `ink`/`react` imported **only** under `src/tui/`
  (checking `src/kernel`, `src/providers`, `src/extensions`, `src/host.ts`,
  `src/server.ts`, `src/cli.ts`, `src/jsonl.ts`, `src/engine-render.ts`,
  `src/view-model.ts`, `src/attribution.ts`, and `test/` outside `test/tui/`). Not
  shell grep (macOS non-ASCII gotcha).

Impl:
- **T4.5** `src/tui/` — the Ink components (transcript, reasoning-collapse, tool card,
  subagent tree, input+status bar, the three display modes + `/details` + side panel
  carried forward from the superseded design), consuming `src/view-model.ts`; the
  coalescing adapter; `src/tui/main.tsx` entry driving an `InProcessSource` for the
  local single session; KDD6 `eagent`-side "suggest `eagent-tui`" hint.

**Acceptance:**
```
node --import tsx --test "test/tui/transcript.test.tsx" test/tui-isolation.test.ts
npm run build:tui                                   # exits 0
node -e "const s=require('fs').statSync('dist/tui/bundle.mjs').size; if(s>3145728){console.error('bundle',s,'> 3MB');process.exit(1)} console.log('bundle',s,'<= 3MB (AC12)')"
node dist/tui/bundle.mjs --help                     # self-contained bundle invocation exits 0 (AC12)
npm test && npm run typecheck && npm run typecheck:test && npm run build:binary
git diff --quiet -- src/kernel && echo KERNEL-CLEAN
```
**Exit:** the Ink single-session client renders (ink-testing-library), coalesces +
windows, is dependency-isolated (AC9), builds via `build:tui` (≤3 MB), and
`eagent-tui` launches it; the SEA engine binary still builds Ink-free. (Real-TTY
render/input = the documented out-of-CI manual smoke, AC12.)

---

### Phase 5 — Monitor/manager view (multi-session dashboard)

**Entry:** P4 green. **Design refs:** D5, AC7.

**Tasks (TDD order):**
- **T5.1** (test) `test/tui/monitor.test.tsx` — **monitor list (AC7).** Drive the
  monitor view from a scripted multi-session `RemoteSource` (or several); assert the
  frame lists sessions with live status/usage/cost, supports session/instance
  switching to a detail view (attaching one source's SSE feed), and reflects a `stop`.
  *Invariant: the monitor observes + controls multiple sessions across configured
  instances.*

Impl:
- **T5.2** `src/tui/monitor.tsx` + the multi-instance config (`{url, token}[]`) — the
  list model over N `RemoteSource`s + the global `/events` demux; a detail view
  attaching a per-session feed; controls (stop/forget); wire `eagent-tui --monitor`
  (or a monitor entry).

**Acceptance:**
```
node --import tsx --test "test/tui/monitor.test.tsx"
git diff --quiet -- src/kernel && echo KERNEL-CLEAN
npm test && npm run typecheck && npm run typecheck:test
npm run build:tui
```
**Exit:** the monitor lists/observes/controls multiple sessions from scripted remote
sources; full suite green; kernel untouched.

---

### Phase 6 — Docs, charter, closeout

**Entry:** P5 green. **Design refs:** D10, AC13.

**Tasks:**
- **T6.1** `README.md` — the TUI (`eagent-tui`), monitor usage + `{url, token}[]`
  config, the new server endpoints, the Node-runtime requirement for the TUI.
- **T6.2** `CLAUDE.md` — **amend the zero-dep charter** to "kernel/providers/
  extensions/server/CLI-engine are zero-runtime-dep; the `src/tui/` front-end may use
  vetted deps (`ink`/`react`), pinned + import-isolated (AC9)"; update "Where things
  live" (`src/tui/`, `src/view-model.ts`, `src/attribution.ts`, `src/engine-render.ts`;
  `src/render/` removed). Update ARCHITECTURE.md if it enumerates the render layer.
- **T6.3** `CHANGELOG.md` + `docs/TUI.md` (controls/architecture/keys; the out-of-CI
  PTY smoke procedure).
- **T6.4** (regression) `test/docs-drift.test.ts` green (no `BUILTIN_EXTENSIONS`
  change; the TUI is host code, not an extension).

**Acceptance (AC13 full):**
```
node --import tsx --test test/docs-drift.test.ts
npm test && npm run typecheck && npm run typecheck:test && npm run eval
npm run build && npm run build:binary && npm run build:tui
```
**Exit:** all gates exit 0; docs match the shipped surface; charter amended.

## 3. Engineering Constraints Index

- **Engineering norms** (CLAUDE.md _engineering-norms_): ESM + NodeNext `.js`
  specifiers; strict TS (`noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`), no `any`; **zero runtime deps in the engine** (`ink`/`react`
  only under `src/tui/`, AC9); `node:test` + `tsx` offline; comments explain code, not
  workflow.
- **Zero kernel change** (AC10): nothing under `src/kernel/`.
- **JSONL adoption guard** unchanged (`--json` path untouched; the engine plain
  renderer must not hand-roll `type:"<event>"` literals — it uses `src/view-model.ts`
  `kind`).
- **Four-corner subagent template**: `references/loop-3-development.md`.
- **Commit conventions**: `feat(phaseN):` / `fix(phaseN-roundR): <keyword>`; results
  as trailers; **no** AI/model/tool mention, no `Co-Authored-By: Claude`, no
  `Claude-Session` trailer.
- **PTY caveat:** raw-TTY behavior is not reproducible in the offline suite; the
  real-TTY smoke (P4 AC12) is a documented manual gate. A `pty.fork` harness exists in
  the scratchpad for manual verification.

## 4. Data and Fixture Dependencies

- **Reuse:** `MockProvider`; `makeHarness`/`siblingAgent` (`test/helpers.ts`);
  the reasoning-search fork harness (`test/render-attribution.test.ts`,
  `test/reasoning-search.test.ts`); the server test harness
  (`test/host.test.ts`/`test/hardened-profile.test.ts`); the `stdoutOf` capture.
- **New:** a stub SSE HTTP server (Node `http`) emitting scripted frames (P3);
  `ink-testing-library` `render()`/`lastFrame()` fixtures (P4/P5); a `{url, token}[]`
  monitor-config fixture; pinned `ink`/`react`/`ink-testing-library` versions +
  committed lockfile.

## 5. Regression Protection

- **Baseline (confirm at P1 start):** `npm test` + `typecheck` + `typecheck:test` +
  `eval` + `build` + `build:binary` green on the branch head.
- **Always-green invariants (every phase):** `git diff --quiet -- src/kernel` (AC10);
  `test/jsonl.test.ts` + `test/jsonl-adoption.test.ts` (AC8); `test/cli.test.ts`
  `agent_end` warnings after P2 (AC-engine-plain); `test/kernel-surface.test.ts`;
  `test/docs-drift.test.ts`; the AC9 isolation scan after P4.
- **Cutover safety (P2):** the engine plain renderer + `Term`-seam relocation land
  before the `src/render/` painters are deleted (R6) — never a window with no
  renderer or a stranded import.
