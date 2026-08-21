# Design — TUI rebuild: a decoupled Ink client + HTTP/SSE instance monitor

Slug: `2026-07-23-tui-ink-rebuild`
Status: closed
Superseded-by: 2026-07-27-drop-ink-tui (Ink client surface only; plain renderer + monitor substrate retained)
Closing-commit: `da3efd8`
Closed-on: 2026-07-23
Deferred: none
Full-cycle outcome: L1 closed (3 adversarial-panel rounds, severe 2 → 0 → 0); L2
closed (4 rounds, severe → 5 → 4 → 0/0 clean); L3 phases P1–P6 all merged +
main-agent PhaseEnd-verified; F end-to-end review PASS (2 fresh non-author voters,
0 severe / 0 general).
Date: 2026-07-23
Research input: deep-research report (2026-07-23), adversarially verified.
Spike input: the Ink-in-SEA de-risking spike (recorded verbatim in §5).
Supersedes: `docs/design/2026-07-22-tui-redesign.md` (the hand-rolled `src/render/`
renderer) — see §6.

### User-confirmed intent (2026-07-23)

1. **Scope = both**: a best-in-class single-session interactive client **and** a
   monitor/manager that attaches to one or more running EAgent instances.
2. **Rebuild everything**: remove all of `src/render/`. The engine gets a **new,
   minimal, ordering-aware plain renderer** that **preserves** the two shipped
   pain-point fixes (reasoning-search de-interleaving; full tool params) on the
   non-Ink path (user decision, KDD5) — no regression.
3. **Dependencies allowed, isolated**: Ink/React are runtime deps of the **`src/tui/`
   module only**; kernel/providers/extensions/server/CLI-engine stay zero-dep;
   CLAUDE.md's charter is amended to say so (D10).
4. **Packaging = decouple**: `bin/eagent` stays the headless engine + plain/JSONL
   CLI (CJS SEA, unchanged); the Ink TUI is a **separate ESM front-end** run via
   Node, which is also the remote monitor client.

## 1. Background and Purpose

EAgent's human rendering currently lives in `src/render/` — a hand-rolled, zero-dep
view-model + inline/alt-screen renderer (the `2026-07-22-tui-redesign` work). It is
a bespoke terminal engine the project must maintain, is single-session and
in-process, and has no story for **monitoring/managing multiple running EAgent
instances**.

The goal is a dedicated, high-UX terminal UI on a vetted framework that is (1) a
rich single-session client and (2) a monitor/manager attaching to one or more
running EAgent HTTP hosts. Research (§5) recommends **Ink (React)** — highest
adoption (Claude Code, gemini-cli), offline-testable via `ink-testing-library`,
native-addon-free. A spike (§5) proved Ink renders/inputs/re-renders/resizes as an
**ESM** bundle but **cannot** embed in EAgent's current Node-24 CJS SEA binary
(top-level await in Ink+Yoga). Hence **decoupling**: the engine binary is unchanged
and zero-dep; the Ink TUI is a separate ESM module talking to the engine in-process
or over HTTP/SSE.

If we do nothing: EAgent keeps a bespoke renderer to hand-maintain, with no
multi-instance observability and no path to framework-grade UX.

## 2. Deliverables

- [ ] **D1 — TUI module (`src/tui/`, ESM, Ink).** The **only** place with the
      Ink/React dependency, launched by the invocation surface chosen in KDD6.
      Built/run as ESM via Node; **not** in the CJS SEA engine binary.
- [ ] **D2 — Session-source abstraction.** One interface the Ink view consumes — an
      ordered lifecycle-event stream + a control surface (run turn, answer
      elicitation, stop) — with **two** implementations: `InProcessSource` (imports
      the kernel/host, runs one agent locally, tags events via the **shared
      in-process attribution adapter** — the re-homed `wire`, `currentActingAgent()`/
      `currentRootAgent()` — the same adapter the engine plain renderer uses, KDD5)
      and `RemoteSource` (an HTTP+SSE client that reads the acting/session id **off
      the SSE frame**). Same view + shared reducer, two backends (KDD3).
- [ ] **D3 — Shared view-model core + Ink components.** The **shared, pure,
      offline-testable reducer** (`src/view-model.ts`, the neutral core of KDD5,
      zero-dep, no `ink`/`react`) folds tagged events into an ordered section tree
      (reasoning / answer / tool cards with nested sub-agent trees, attributed by
      acting agent) — consumed by **both** the Ink components **and** the engine
      plain renderer (D7). The Ink components render it: streaming text, collapsible
      reasoning, structured tool cards, a persistent input + status bar, keybindings.
      **Carries forward the superseded design's shipped UX** (its R-A/R-B/R-C):
      the three display modes `full`/`collapsed`/`auto-collapsed` + a `/details`
      toggle + per-section expand/collapse, and the ≥100-col in-session side panel —
      all natural as Ink components. A single fixed theme this cycle (a light/dark
      toggle + richer theming are follow-ons, §3).
- [ ] **D4 — Reasoning-flood mitigation.** Delta **coalescing** in the view-model
      adapter (batch high-rate `reasoning_delta`/`text_delta` into ≤1 React state
      update per frame interval) + **viewport windowing** (a full-screen Ink app
      lays out only the visible rows + collapsed headers; KDD4).
- [ ] **D5 — Monitor/manager view.** A multi-session dashboard (same Ink app) driven
      by `RemoteSource`s: list sessions across one or more **configured** instances
      (`{url, token}[]`, §5), live status/usage/cost, drill into a session's live
      SSE feed, controls (stop a running turn; forget a session), session/instance
      switching.
- [ ] **D6 — Server monitor endpoints (`src/server.ts`, zero-dep, Ink-free).**
      Additive routes the monitor needs and the host lacks (§5): `GET /sessions`
      (list `{id, running, usage, costUsd}`); a per-session **SSE** feed
      `GET /sessions/:id/events` and a global `GET /events` (both re-emit hook-bus
      events, **each frame tagged with its `session` id** so a multi-session client
      can demux the global stream); `POST /sessions/:id/stop` (`agent.stop()`). The
      per-session feed **filters the shared hooks bus by run-tree root agent** —
      reusing the exact tenant-isolation guard `/run` already uses
      (`currentRootAgent() === agent`, `server.ts:480/504`) — so a session's feed
      carries only its own events. Reuses the existing bearer auth + session pool.
      No kernel change. (Independently shippable + server-harness-testable without
      Ink — they ride along because the monitor needs them and they are small; §6
      notes the separate-cycle alternative.)
- [ ] **D7 — Engine minimal ordering-aware plain renderer + CLI rewire.** Remove
      `src/render/`'s **ANSI painters** (`inline/tui/tty`); **relocate** its pure
      reducer (`view-model`) **and** its in-process attribution adapter (`wire`,
      minus ANSI coupling) to shared neutral modules (KDD5/D3). Give the engine a
      **new, small, zero-dep** plain renderer wired in `cli.ts` that **consumes both
      the shared reducer and the shared in-process attribution adapter** and, on the
      non-Ink path (pipes, `--eval`, batch, dumb terminals,
      **and the SEA-binary interactive TTY**), still (a) **de-interleaves
      reasoning-search forks** by acting agent, (b) **collapses reasoning** to a
      header, (c) renders **tool cards** (name + key args + status; full content
      reachable), and (d) coalesces — so the two pain-point fixes are **preserved**
      (no alt-screen, no framework). It **preserves the `agent_end` abnormal-
      termination warnings** verbatim (superseded AC4; the warning tests span
      `test/cli.test.ts` ~150-210 — `wireRendering warns on a max_tokens truncation`
      at ~:172 onward). `wireRendering` (the exported CLI entry, imported by
      `test/cli.test.ts`) is **rewired** to this new renderer, keeping its export +
      `agent_end`/`error`
      handlers. `--json`/JSONL (`jsonl.ts`, `wireJsonRendering`) is unchanged.
- [ ] **D8 — Test-seam relocation + tests.** Before deleting `src/render/`, relocate
      the `Term` type-seam **out of** `test/helpers.ts` (which `import type { Term }
      from "../src/render/tty.js"` and is imported by ~86 test files) into the engine
      renderer's own module (or replace with the injected-terminal type), so deleting
      `src/render/` strands nothing. Offline `node:test`: pure reducer units;
      `ink-testing-library` component/frame tests (streaming, collapse, tool cards,
      nesting, monitor list); `RemoteSource` SSE-parse + reconnect against a stub
      server; new server-endpoint tests; **engine plain-renderer** tests
      (de-interleaving, `agent_end` warnings, `--json`/`--eval`/pipe parity); a guard
      that `src/kernel/` is untouched and that `ink`/`react` are imported **only**
      under `src/tui/` (scanning `src/` **and** `test/`).
- [ ] **D9 — Build & packaging.** A `build:tui` (esbuild ESM bundle with the two
      spike-proven shims — §5) producing the runnable TUI. `build:binary` (engine
      SEA) stays CJS and **excludes** `src/tui/`. `package.json`: `ink` + `react` are
      **runtime `dependencies`** (needed by `eagent tui` from a plain install);
      `ink-testing-library` is a **`devDependency`**. "Scoped to `src/tui/`" is an
      **import-graph guarantee** (AC9), not a package.json boundary; versions pinned
      (R7).
- [ ] **D10 — Docs.** README (the TUI invocation, monitor usage + multi-instance
      config, the new server endpoints, the Node-runtime requirement for the TUI);
      CHANGELOG; CLAUDE.md (amend the charter to "kernel/providers/extensions/server/
      CLI-engine are zero-runtime-dep; the `src/tui/` front-end may use vetted deps",
      consciously accepting the ~40-package cost for that module only; update "Where
      things live"); a `docs/TUI.md` controls/architecture reference; ARCHITECTURE.md
      if it enumerates the render layer.

## 3. Scope Boundary (NOT in scope)

- **No kernel change** (`src/kernel/*.ts`; gated). Attribution uses the exported
  `currentActingAgent()`/`currentRootAgent()`.
- **No dependency in the engine.** `ink`/`react` appear **only** under `src/tui/`;
  `src/kernel`, `src/providers`, `src/extensions`, `src/host.ts`, `src/server.ts`,
  `src/cli.ts`, `src/jsonl.ts`, the engine plain renderer, **and `test/` outside
  `test/tui/`** stay import-free of them (gated, AC9).
- **`bin/eagent` (engine SEA) unchanged in kind** — CJS, zero-dep, Node-version
  unchanged; the Ink TUI is **not** in the single binary (the confirmed decouple).
  A TUI binary is a possible follow-on, out of scope.
- **Interactive-UX delta on the SEA binary (stated, not silent):** the binary's
  interactive TTY path uses the D7 minimal ordering-aware plain renderer — it
  **preserves** the flood/truncation fixes but does **not** get the *rich* Ink
  full-screen experience (panels, live monitor); those require `eagent tui` (Node).
  This is a deliberate consequence of decoupling, not a pain-point regression.
- **`--json`/JSONL contract unchanged** (`jsonl.ts` + `wireJsonRendering` + goldens).
- **No new agent behavior** (tools, reasoning, sub-agents, reasoning-search, session
  isolation, capabilities, providers unchanged). Presentation + observability only.
- **Monitor is read-mostly + bounded controls** (observe; stop/forget a session;
  answer elicitations). No remote code exec, no cross-instance orchestration, no new
  auth scheme beyond the server's existing bearer token.
- **No mouse support; no config-file theming.** A single fixed theme this cycle
  (a light/dark toggle + richer theming are explicit follow-ons).
- **Windows** best-effort (not in the offline test matrix).

## 4. Key Design Decisions

### KDD1 — Framework: Ink (React), isolated to `src/tui/`
- **Problem:** which framework for a rich, testable, dependency-isolated front-end?
- **Options:** (A) **Ink (React)**; (B) blessed/neo-blessed; (C) OpenTUI; (D)
  hand-rolled ANSI (status quo `src/render/`); (E) a decoupled non-Node TUI (Go
  Bubble Tea / Rust ratatui) over the HTTP API.
- **Choice: (A).** Highest adoption (Claude Code, gemini-cli — §5); offline-testable
  (`ink-testing-library`); native-addon-free; stays in TS/Node so the client imports
  the kernel in-process trivially.
- **Reject (B):** blessed is largely unmaintained; forks are drop-ins, not a React-
  grade component/test story. **(C) OpenTUI:** Zig core via Bun FFI / native binaries
  — no clean Node/WASM path (§5). **(D):** the bespoke renderer this task retires; no
  framework ecosystem. **(E):** a second language fragments the codebase and can't
  import the kernel in-process; the decoupled *transport* is adopted (KDD3) without a
  second language.

### KDD2 — Decoupled architecture: engine unchanged, TUI a separate ESM front-end
- **Problem:** the spike (§5) proved Ink bundles only as **ESM** (top-level await in
  Ink+Yoga breaks CJS output), and a Node-≤24 SEA main is CJS — Ink can't embed in
  `bin/eagent` today.
- **Options:** (A) **decouple** — engine SEA stays CJS/zero-dep; TUI is a separate
  ESM module run via Node; (B) bump `build:binary` to Node ≥26 (ESM-SEA) to embed
  Ink; (C) a temp-asset shim loading an embedded ESM bundle from the CJS SEA.
- **Choice: (A)** (user-confirmed). Engine untouched, dependency isolated, and the
  same decoupling powers the remote monitor (KDD3). The TUI requires a Node runtime —
  accepted (D10). **Reject (B):** forces a Node-26 toolchain on the whole engine for
  a front-end concern; newer/less-proven. **Reject (C):** a fragile temp-file shim
  for no gain over (A).

### KDD3 — One view over a `SessionSource`: in-process OR remote HTTP/SSE
- **Problem:** the TUI must serve a local single session **and** monitoring of remote
  instances (single- and multi-agent). Do we need two source implementations, or can
  the abstraction collapse?
- **Options:** (A) **two sources behind one interface** — `InProcessSource` +
  `RemoteSource`; (B) **remote-only** — even the local client spawns/attaches to a
  local `serve` and talks HTTP; (C) **in-process-only** — no remote, defer the
  monitor.
- **Choice: (A).** An ordered event stream + a control surface (run/answer/stop),
  two implementations, one view model. **Reject (B):** forces a port + auth + a second
  process on the common local single-session case (heavier, more failure modes).
  **Reject (C):** the monitor must observe **remote** agents it did not spawn — an
  in-process-only source cannot. Two real consumers ship this cycle, so the
  abstraction is justified, not premature.
- **Multi-session:** the monitor holds N `SessionSource`s (per session/instance) + a
  list model; a detail view attaches one source.

### KDD4 — Reasoning-flood mitigation: coalesce (throughput) + viewport windowing (layout)
- **Problem:** research (§5) flags Ink's render-throughput ceiling; EAgent's
  reasoning-search fan-out is a high-rate multi-stream token flood.
- **Choice:** (a) **coalesce** deltas in the view-model adapter — at most one React
  state update per frame interval (≈16–33 ms), not per token (the proven mitigation
  from the superseded design); (b) **viewport windowing** — a full-screen Ink app
  renders only the visible rows + collapsed headers, never an unbounded transcript.
  Windowing is **inherent to a fixed-height full-screen viewport** (you can only show
  N rows), not a speculative optimization — it is how a full-screen TUI works, and it
  bounds the React tree Ink lays out each render. Measured by AC3 (coalescing) and
  AC4 (bounded frame height).
- **Reject:** rendering every delta (the flood); an Ink fork (the coalescing avoids
  the throughput need).

### KDD5 — The engine keeps a NEW minimal ordering-aware plain renderer (no regression)
- **Problem:** "remove all of `src/render/`" + decoupled packaging means the engine
  (no Ink) still renders for pipes/`--eval`/CI/dumb terminals **and the SEA-binary
  interactive TTY**. If that renderer is dumb-append, the reasoning-search flood +
  tool truncation return on the binary — undoing the shipped fix.
- **Options:** (A) keep the current `src/render/` inline renderer as the engine
  default; (B) **remove `src/render/`; build a new minimal ordering-aware plain
  renderer** in the engine; (C) remove `src/render/`; accept a dumb-append renderer
  and the flood/truncation regression on the plain/binary path.
- **Choice: (B)** (user decision, 2026-07-23). A small, zero-dep engine renderer that
  **de-interleaves** reasoning-search forks (via `currentActingAgent()`), **collapses
  reasoning** to a header, renders **tool cards** with reachable full content, and
  **coalesces** — no alt-screen, no framework. Preserves both fixes on every non-Ink
  path (AC-engine-plain). **Reject (A):** contradicts the rebuild + keeps the bespoke
  ANSI stack. **Reject (C):** consciously regresses the user's original goal for no
  benefit the minimal renderer doesn't give.
- **Mechanism — shared neutral core, not two implementations.** De-interleaving has
  two halves with different homes: (i) the id-**keyed** section separation + ordering
  + collapse + coalescing state + full-payload retention — the **reducer** — is a
  **pure, zero-dep, neutral module** (`src/view-model.ts`, imports no `ink`/`react`,
  AC9-clean) consumed by **both** the engine plain renderer (D7) **and** the Ink
  components (D3), written and tested **once** (AC1). (ii) the id-**attach**
  (*tagging* each event with its acting-agent id) is inherently **per-source** and
  **cannot** be one function: `InProcessSource` tags via the ALS
  (`currentActingAgent()`/`currentRootAgent()`), `RemoteSource` reads the id off the
  SSE frame. So the current `src/render/wire.ts` — whose real job is this **in-process
  attribution/framing** (not ANSI) — is **re-homed** (minus its ANSI coupling) to a
  shared neutral module (alongside `src/view-model.ts`) consumed by **both**
  `InProcessSource` (D2) **and** the engine plain renderer (D7), so the whole
  in-process de-interleaving path is written once. Thus "remove all of `src/render/`"
  means removing the bespoke **ANSI painters** (`inline`/`tui`/`tty`); the reducer and
  the in-process attribution adapter are **relocated** as neutral shared cores.
  **Reject** duplicating the reducer or the in-process tagging across renderers (the
  divergence Simplicity-First forbids).

### KDD6 — TUI invocation surface
- **Problem:** how does a user launch the Ink TUI, given the SEA engine binary has no
  Node/Ink and the superseded design shipped a `--tui` flag + `/tui` command
  (`cli.ts` registers a `tui` command; `package.json` already has an `eagent-serve`
  bin)?
- **Options:** (A) an **`eagent tui` subcommand** in the engine CLI that execs the
  ESM TUI via Node; (B) keep the superseded **`--tui` flag / `/tui`** command; (C) a
  **separate `eagent-tui` bin** (matching the existing `eagent-serve` bin), npm-only,
  absent from the SEA binary.
- **Choice: (C) a separate `eagent-tui` bin**, matching the `eagent-serve` precedent.
  It never appears in the CJS SEA binary (so the binary carries no command it cannot
  fulfill), it is discoverable via `package.json` bins, and it cleanly signals the
  Node requirement. The engine `eagent` on a capable TTY **suggests** `eagent-tui`.
  **Reject (A):** forces the SEA binary to carry a `tui` subcommand it can only answer
  with "install Node." **Reject (B):** the `--tui` flag lived in the now-removed
  alt-screen renderer; a flag on the engine binary implies an in-binary TUI that
  decoupling removes. Migration note: the superseded `--tui`/`/tui` are removed with
  `src/render/tui.ts`; `eagent-tui` replaces them.

### KDD7 — Server monitor endpoints (additive, zero-dep)
- **Problem:** the host exposes only `GET /sessions/:id` (single, point-in-time) and
  streams events only while *starting* a turn (`POST /run`); a monitor needs to
  enumerate sessions and subscribe to a live feed without mutating (§5, verified
  `server.ts:259,271,368`).
- **Options:** (A) **SSE** (`text/event-stream`) for the live feed; (B) WebSocket;
  (C) HTTP long-poll.
- **Choice: (A) SSE**, plus `GET /sessions` (list) and `POST /sessions/:id/stop`.
  SSE is the proven agent-monitor transport (§5), Node's `http` supports it natively
  (zero-dep), and it re-emits hook-bus events read-only. Reuses the existing session
  pool + bearer auth. **Reject (B):** needs a dep or hand-rolled framing; **Reject
  (C):** higher latency + connection churn than SSE for a live feed. No kernel change.

### KDD8 — Testing strategy for the Ink TUI
- **Problem:** everything must be offline-deterministic (`node:test`), but a real
  full-screen TUI ultimately runs in a TTY.
- **Options:** (A) **`ink-testing-library`** `render()`/`lastFrame()` over fake
  streams (component/frame snapshots, no TTY); (B) **in-CI PTY** integration tests
  driving the built bundle in a real pseudo-terminal; (C) **golden-frame byte
  comparison** of full ANSI output.
- **Choice: (A) for CI**, with the real-TTY render/input smoke as an **explicit
  out-of-CI manual/release gate** (§7 AC12). `ink-testing-library` is the standard,
  offline, deterministic tool (§5) and covers the component/frame behavior. **Reject
  (B) in CI:** `node:test` has no built-in PTY and `node-pty` is a native addon the
  zero-dep-adjacent test story avoids; the spike proved `pty.fork` works *ad hoc*
  (Python), but that is not a portable `node:test` gate — so PTY stays a manual gate.
  **Reject (C):** ANSI byte-goldens are brittle to Ink/terminal version drift; frame
  *content* assertions (A) are stabler. `RemoteSource` SSE and the server endpoints
  are plain offline HTTP tests (no TTY).

## 5. Dependencies and Assumptions

### Spike (throwaway, deleted) — Ink-in-SEA, 2026-07-23, Node v24.16.0 / macOS arm64, `esbuild` (latest via `npx`), verified via a `pty.fork` harness
- **Ink 6.8.0 + React 19.2.8**: ~40-package tree, **no native `.node` addons**;
  `yoga-layout` ships its WASM **base64-inlined in JS** (zero standalone `.wasm`) →
  bundleable.
- **`esbuild --format=cjs` (EAgent's `build-binary.mjs` recipe) FAILS on Ink** — the
  **linchpin of KDD2**: top-level await in `ink/build/reconciler.js` and
  `yoga-layout/dist/src/index.js` (`const Yoga = wrapAssembly(await loadYoga())`);
  plus a static import of optional `react-devtools-core`. This decision is also
  **user-confirmed** (intent #4), so it stands even if the exact esbuild failure mode
  shifts with tool versions.
- **`esbuild --format=esm` WORKS** with two shims (both required):
  `--alias:react-devtools-core=<empty-stub>` and a `--banner:js` `createRequire`
  shim. The 1.74 MB ESM bundle renders (Yoga flexbox/border/color), takes raw-mode
  input (`q`→`useInput`→`exit()`), live re-renders, stays alive under a real TTY.
- **SEA on Node ≤24 can't run the ESM bundle** (SEA main is CJS on the verified
  build target; Node's roadmap adds opt-in ESM-SEA on newer majors, not relied on
  here) → the decouple decision (KDD2).
- These are the only durable spike outputs; the scratch was mechanically deleted (so
  the CJS-fails-on-Ink finding is not re-runnable from the repo — noted per protocol).

### Research (deep-research report, 2026-07-23; adversarially verified)
- Ink is the highest-adoption Node/TS agent-TUI framework (Claude Code, gemini-cli);
  `ink-testing-library` gives offline `render()`/`lastFrame()` testing.
- Codex's TS→Rust move was a runtime-packaging signal (Node-install friction), not an
  Ink indictment — moot here (decoupled + engine binary unchanged).
- Decoupled client-server over HTTP+**SSE** is the proven monitor pattern (OpenCode
  `/event` emits `server.connected` then bus events; `GET /session` lists; opencode-
  manager attaches via an SSE proxy).
- Carried caveat: Ink render-throughput ceiling → KDD4.

### Codebase (verified)
- Attribution: `currentActingAgent`/`currentRootAgent` (`src/kernel/agent.ts:76,80`,
  exported `index.ts:15`).
- Server (`src/server.ts`): advertised routes at `:368` lack a list/stream endpoint;
  `/health` returns `sessions: sessions.size` (a **count**, `:259`); `GET
  /sessions/:id` is single + point-in-time (`:271-279`); **when a token is set, ALL
  non-`/health` routes are auth-gated** (`:263`) — so the new `GET /events`/`GET
  /sessions` are authed like the rest (favorable to the monitor); session pool =
  `Map<id, Agent>`; session agents **share one hooks bus** (`makeSessionAgent` sets
  `hooks: template.hooks`, ~`:380`); **per-session event filtering already exists and
  is proven** for `POST /run` (`currentRootAgent() === agent`, `server.ts:480/504`) —
  the new `GET /sessions/:id/events` reuses this exact guard (KDD7/D6/R4);
  `agent.stop()` exists.
- `--json`/JSONL: `wireRendering` (`src/cli.ts`, exported, imported by
  `test/cli.test.ts`; `agent_end` warnings at `cli.ts:448-458`, and the warning
  *tests* span `test/cli.test.ts` ~150-210, e.g. `wireRendering warns on a max_tokens
  truncation` at ~:172); `wireJsonRendering` + `src/jsonl.ts` (unchanged).
- Test seam: `test/helpers.ts` does `import type { Term } from "../src/render/tty.js"`
  and is imported by ~86 test files (must be relocated before deleting `src/render/`,
  D8).
- Build: `scripts/build-binary.mjs` = `tsc` → `esbuild --format=cjs` → SEA blob;
  `deps` = `{jiti}`; `package.json` bins include `eagent-serve`.
- **Baseline (confirm at L2):** `npm test`/`typecheck`/`typecheck:test`/`eval`/`build`
  green on the branch head.
- **Assumption:** the TUI runs where a Node runtime + `node_modules` (or the
  `build:tui` bundle) is present (dev, npm install); not from the bare SEA binary.
  The monitor is configured with a list of `{url, token}` instances.

## 6. Relationship with Existing Designs

- **⚠ Supersedes `docs/design/2026-07-22-tui-redesign.md`.** Its *value-model
  concepts* (attribution via `currentActingAgent()`, auto-collapse, full-payload-on-
  expand, subagent nesting, delta coalescing, the `agent_end`-warning contract) are
  **carried forward** — into the Ink components (rich path, D3/D4) **and** the engine
  minimal renderer (plain path, D7/KDD5), so **both pain-point fixes are preserved on
  every path**. Its *implementation* (`src/render/{view-model,wire,inline,tui,tty}.ts`)
  is **removed** (D7). A `Superseded-by` link is added at closeout. Source of truth
  going forward: this doc.
- **`docs/design/2026-07-10-cli-json.md` / `2026-07-11-jsonl-unify.md`** — the
  `--json`/JSONL path. **Preserve, no conflict** (§3).
- **`2026-07-10-session-isolation.md` / `2026-07-14-multitenant-isolation.md` /
  `2026-07-11-hardened-server-profile.md`** — the per-session pool + auth the monitor
  endpoints (KDD7) reuse. **Extend, no conflict.**
- **Decomposition (loop-1-design step 3).** This doc bundles a client + a monitor +
  additive server endpoints. Client and monitor form **one coherent presentation
  subsystem** (shared view model + `SessionSource`), so one design doc is right. The
  server endpoints (D6) are Ink-free and independently shippable; they **ride along**
  because the monitor requires them and they are small (three routes reusing existing
  auth/pool) — splitting them into their own L1→F cycle is a viable alternative,
  noted here and rejected only for cohesion (the monitor is untestable end-to-end
  without them).
- **CLAUDE.md** — the zero-dep charter is **amended** (D10): core (kernel/providers/
  extensions/server/CLI-engine) stays zero-runtime-dep; the `src/tui/` front-end may
  use vetted deps. This consciously accepts the ~40-package cost for that module only
  (R7). A load-bearing doc edit, part of this Full-Mode change.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (reducer de-interleaving & order):** interleaved `reasoning_delta`s from two
  acting-agent ids under one reasoning-search parent → each fork in its own ordered
  sub-section, no cross-fork mixing (pure unit; RED vs a single-buffer baseline).
- **AC2 (Ink renders the section tree):** an `ink-testing-library` test renders the
  transcript component from a scripted stream and asserts `lastFrame()` contains the
  reasoning header, an expanded tool card with **full untruncated** args, and a nested
  subagent card — over a fake TTY, offline.
- **AC3 (coalescing budget):** K `reasoning_delta`s within one frame interval commit
  **≤1** render/state update (the KDD4 throughput budget). Pure adapter unit.
- **AC4 (bounded viewport):** with a transcript far exceeding the viewport, the
  rendered frame height is bounded by the terminal rows (only visible window +
  collapsed headers laid out), independent of transcript length. `ink-testing-library`
  with a fixed fake `rows`.
- **AC5 (`RemoteSource` SSE):** against an in-process stub HTTP server emitting
  scripted SSE frames (`connected`, then `tool_start`/`text_delta`/`agent_end`),
  `RemoteSource` yields an ordered event stream matching the frames and reconnects
  after a dropped connection (offline).
- **AC6 (server endpoints):** `GET /sessions` lists live ids with
  `{running,usage,costUsd}`; `GET /sessions/:id/events` and `GET /events` respond
  `text/event-stream`, emit a `connected` event then a scripted bus event (global
  frames tagged with their `session` id); `POST /sessions/:id/stop` aborts a running
  turn (`agent.running` → false). Auth per `server.ts:263`: **when a token is
  configured**, a request omitting/mis-providing the bearer token → **401**; when no
  token is configured, the routes are **open (200)**. Server-harness tests.
- **AC6b (per-session SSE tenant isolation):** on a **two-session** server sharing
  one hooks bus, session A's `GET /sessions/:id/events` feed contains **only** session
  A's events while session B runs a turn — **no cross-session leakage** (the
  `currentRootAgent() === agent` filter, `server.ts:480/504`). Server-harness test;
  grounds R4.
- **AC7 (monitor list):** an `ink-testing-library` test drives the monitor view from a
  scripted multi-session `RemoteSource` and asserts the frame lists sessions with live
  status/usage and reflects a `stop`.
- **AC-engine-plain (no regression on the non-Ink path):** driving the engine plain
  renderer (D7) with two concurrent reasoning-search forks → their reasoning appears
  **de-interleaved** (each fork's text in its own section), reasoning **collapses** to
  a header, and a tool card's **full args are reachable** — asserted on captured
  output; and the **`agent_end` warnings** for `max_tokens`/`content_filter`/`refusal`
  are printed (carry-forward of superseded AC4; `test/cli.test.ts` warning tests pass,
  rewired to the new renderer).
- **AC8 (machine-path parity):** `--json` batch stdout byte-identical to the
  pre-change baseline for a fixed mock sequence; `--eval` + piped batch emit a plain
  line stream with **no** alt-screen/cursor/framework bytes; `test/jsonl.test.ts` +
  `test/jsonl-adoption.test.ts` pass unchanged.
- **AC9 (dependency isolation — offline):** a `readFileSync`-based source-scan test
  (the `test/jsonl-adoption.test.ts` precedent — **not** shell grep, macOS non-ASCII
  gotcha) asserts `ink`/`react` are imported **only** under `src/tui/` (not in
  `src/kernel`, `src/providers`, `src/extensions`, `src/host.ts`, `src/server.ts`,
  `src/cli.ts`, `src/jsonl.ts`, the engine renderer, or `test/` outside `test/tui/`).
  Primary CI check is this offline import-graph scan; a bundle grep of `build:binary`
  output is an optional release-time verification only.
- **AC10 (zero kernel change):** `git diff --stat src/kernel/` empty at close;
  `test/kernel-surface.test.ts` green.
- **AC11 (`src/render/` removed cleanly):** the directory no longer exists (its ANSI
  renderers removed, its pure reducer **relocated to `src/view-model.ts`**, KDD5/D3);
  **no source or test** imports `../render/*` (scan `src/` **and** `test/`); the
  `Term` seam is relocated (D8); old `src/render/*` tests are deleted or replaced.
- **AC12 (TUI builds; runs — automatable core + manual smoke):** `build:tui` exits 0
  and produces an ESM bundle; the bundle **imports and a `--help`/`--version`
  invocation exits 0 under Node** (headless, no TTY — automatable); the bundle size is
  **≤ 3 MB** (ceiling anchored on the 1.74 MB spike measurement; guards dependency
  bloat). The **real-TTY render/input smoke is an explicit out-of-CI manual/release
  gate** (documented in `docs/TUI.md`), since `node:test` has no portable PTY; the
  component render/input behavior itself is covered in CI by AC2/AC7.
- **AC13 (gates):** `npm test`, `npm run typecheck`, `npm run typecheck:test`,
  `npm run eval` (5/5), `npm run build`, `npm run build:binary` all exit 0; the SEA
  `bin/eagent` runs the plain CLI (`printf 'hi\n' | bin/eagent -p mock`).

## 8. Risks and Rollback

- **R1 — Ink-in-SEA (de-risked, §5):** the packaging risk is retired by decoupling
  (KDD2); the residual (TUI needs Node) is accepted + documented (D10). Full rollback
  restores `src/render/` from git (the superseded design is intact in history).
- **R2 — Ink render throughput under the flood.** Mitigated by KDD4 (coalesce +
  windowing), measured by AC3/AC4. If insufficient, escalate — not silently degrade.
- **R3 — Dependency creep into the engine.** A stray `ink`/`react` import in engine or
  `test/` (outside `test/tui/`) bloats the SEA bundle and violates the charter.
  Mitigated by AC9 (offline import-graph scan) failing the build.
- **R4 — SSE endpoint vs per-session concurrency/auth.** The read-only feed must not
  perturb the run lock or leak across tenants. Mitigated by reusing the session pool +
  bearer auth and the **proven per-session filter** `currentRootAgent() === agent`
  (`server.ts:480/504`, the same guard `/run` uses on the shared bus), read-only
  re-emission, and **AC6b** (a two-session no-leakage test); kernel/agent loop
  untouched.
- **R5 — Scope/size (largest task in the repo).** Mitigated by L2 phase ordering:
  server endpoints + `SessionSource` + reducer + **engine plain renderer** first
  (headless/plain, fully testable, no regression window), then Ink components, then
  the monitor, then delete `src/render/` + relocate the test seam **last** (the
  well-guarded cutover). Each phase independently green.
- **R6 — `src/render/` removal breaks the default before the TUI is ready.** Mitigated
  by R5: the engine plain renderer (D7) + the `Term`-seam relocation (D8) land
  **before** `src/render/` is deleted, so there is never a window with no renderer or
  a stranded test import.
- **R7 — Supply-chain / maintenance surface of the ~40-package Ink+React+Yoga tree.**
  The zero-dep charter existed to avoid exactly this. Mitigated by: pinned versions +
  committed lockfile; the dep imported **only** under `src/tui/` (AC9), so it never
  reaches the engine/binary/CI-critical paths; the charter amendment (D10/§6)
  consciously accepts this cost for the front-end module only. Rollback removes
  `src/tui/` + the deps.
- **Overall rollback:** the engine (kernel/providers/extensions/server/CLI-plain)
  stays functional and zero-dep throughout; reverting `src/tui/` + the D7/D8 cutover
  restores the prior renderer from git. Branch off `init` (fresh `chore/tui-ink`) to
  keep history clean of the superseded `src/render/` churn; PR-gated to `init`.
