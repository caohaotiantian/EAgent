# Design — Drop the rich Ink TUI; keep the plain CLI + web substrate

Slug: `2026-07-27-drop-ink-tui`
Status: L1 closed (ready for L2)
Date: 2026-07-27
L1-review: rounds 1–4; closed on consecutive clean r3+r4 (0 severe / 0 general)
Supersedes (partial): `docs/design/2026-07-23-tui-ink-rebuild.md` — **only** the
Ink client / `eagent-tui` / `src/tui/` surface and the ink/react charter exception.
The shared plain renderer, view-model, attribution, and HTTP/SSE monitor endpoints
from that design **remain** (see §4 KDD1, §6).

### User-confirmed intent (2026-07-27)

1. **Drop the rich TUI** — the Ink (React) `eagent-tui` client does not satisfy
   product needs.
2. **Keep the simple implementation** — the zero-dep engine plain renderer
   (`src/engine-render.ts` over `view-model` / `attribution` / `tty`) is the only
   terminal human surface.
3. **Rich display moves to the web** — a browser UI is the future rich surface,
   with TUI feature parity as the Cycle B v1 target (single-session streaming
   transcript + multi-session monitor over `eagent-serve` HTTP/SSE).
4. **Sequencing** — this document is **Cycle A only** (drop Ink TUI + preserve
   substrate). Cycle B (full web frontend at TUI feature parity) is a **separate**
   L1→L2→L3→F cycle that starts after Cycle A closes. No web UI code lands here.
5. **No parallel in-repo task** covers the same domain (no open `docs/design/*web*`
   draft; the only related closed designs are the TUI redesign/rebuild docs).

## 1. Background and Purpose

Commit `2d07535` (local-only as of design date; tip of `init` ahead of
`origin/init`) landed a two-layer human-render architecture:

- **Shared neutral cores** (zero-dep): `src/view-model.ts`, `src/attribution.ts`,
  `src/tty.ts`.
- **Engine plain renderer**: `src/engine-render.ts`, wired by `src/cli.ts` for
  every non-Ink path (REPL, pipes, `--eval`, batch, SEA binary interactive TTY).
- **Rich Ink client**: `src/tui/` + `eagent-tui` bin, runtime deps `ink@6.8.0` +
  `react@19.2.8`, isolation gate `test/tui-isolation.test.ts`.
- **HTTP/SSE monitor endpoints** on `src/server.ts` (monitor set of four:
  `GET /sessions`, `GET /sessions/:id/events`, `GET /events`,
  `POST /sessions/:id/stop`, plus session summary `GET /sessions/:id`) for the
  multi-session monitor.

The product decision is that a **browser** is the right rich surface, not a
full-screen terminal framework. Keeping Ink adds maintenance cost (deps, esbuild
bundle, dual bins, isolation tests, docs drift) and a UX path the user will not
use.

If we do nothing: the repo ships (once pushed) a rich client that will not be the
product direction, while the web work still needs the same substrate.

## 2. Deliverables

- [ ] **D1 — Remove the Ink client surface.** Delete `src/tui/` (including
      Ink-only and ink-free helpers that are *not* extracted — e.g. `instance.ts`
      `InstanceClient`, `coalesce.ts`, `app.tsx`, `monitor.tsx`, …), `test/tui/`,
      `test/tui-isolation.test.ts`, the `eagent-tui` bin, `build:tui` / `test:tui`
      scripts, and all `ink` / `react` / `@types/react` / `ink-testing-library`
      dependencies. **Required package cleanup:** drop the empty
      `"test/**/*.test.tsx"` glob from the default `test` script (and `jsx` from
      `tsconfig` if no `.tsx` remains). No remaining import of `ink` or `react`
      anywhere in the tree.
- [ ] **D2 — Restore the engine zero-dep charter.** Amend CLAUDE.md /
      ARCHITECTURE.md / README so the only runtime dependency remains `jiti` (no
      ink/react exception). SEA binary stays Ink-free by construction (it never
      imported `src/tui/`). Replace the deleted isolation suite with a permanent
      offline pin (see D6 / AC1): runtime `dependencies` ⊆ `{ jiti }` and no
      `ink`/`react` imports under `src/` or `test/`.
- [ ] **D3 — CLI is plain-only.** Keep `wireRendering` → `EngineRenderer` as the
      sole interactive human path. Remove the startup “run eagent-tui” hint and
      the `shouldSuggestTui` predicate (and its tests). Keep `/details`,
      `/expand`, `/collapse` on the plain renderer.
- [ ] **D4 — Preserve web substrate (no behavior change).** The **only** retained
      substrate is:
      - `src/view-model.ts`, `src/attribution.ts`, `src/tty.ts` (minus
        `shouldSuggestTui`), `src/engine-render.ts`
      - HTTP/SSE monitor endpoints on `src/server.ts` and `test/server-monitor.test.ts`
      - **`SessionSource` extracted** out of the deleted `src/tui/source.ts` into a
        host-level module (e.g. `src/session-source.ts`) so the Node remote client
        + offline contract tests (`test/session-source.test.ts`) survive as the
        documented monitor-API client reference for Cycle B.
      **Not substrate** (deleted with `src/tui/`, reimplemented in Cycle B if
      needed): `InstanceClient` (`instance.ts`), delta coalescing, Ink views,
      monitor.tsx UI, args/main entry. “Preserve web substrate” does **not** mean
      “all former remote-monitor client code survives.”
- [ ] **D5 — Doc reconciliation.** Update CLAUDE.md, ARCHITECTURE.md, README.md,
      CHANGELOG.md, and **rewrite in place** `docs/TUI.md` (keep the path; no
      rename) so it describes the plain CLI display only and points rich UX at
      “web frontend (planned Cycle B)”, with no `eagent-tui` usage instructions.
      Close the superseded Ink-client claims in the relationship section of this
      doc; do not re-open the closed `2026-07-23` design’s status block beyond a
      supersedes note if needed at F.
- [ ] **D6 — Green offline gates.** `npm run typecheck`, `npm run typecheck:test`,
      `npm test`, `npm run eval`, `npm run build`, and `npm run build:binary` all
      pass with no `build:tui` / `test:tui` requirement. A permanent offline test
      (e.g. `test/zero-dep.test.ts`) enforces AC1 so the charter cannot regress
      silently after `tui-isolation` is gone.

## 3. Scope Boundary

**In scope (Cycle A):**

- Delete Ink TUI code, bins, scripts, deps, and isolation tests — including
  ink-free helpers that are not extracted (`InstanceClient`, coalesce, etc.).
- CLI hint / `shouldSuggestTui` removal.
- SessionSource re-home (file move + import path fixes; no protocol change).
- Doc and changelog updates listed in D5 (rewrite `docs/TUI.md` in place).
- **Required** mechanical cleanup forced by the delete: drop `*.test.tsx` from
  the default `test` script glob; drop `jsx` from `tsconfig` if no `.tsx` remains.
- Permanent zero-dep offline pin replacing `tui-isolation` (D2/D6/AC1).

**Out of scope (explicit non-goals):**

- **Any web frontend** (HTML/CSS/JS app, static hosting, SPA framework choice,
  CORS policy beyond what already exists, auth UX in a browser). That is **Cycle B**.
- **Preserving `InstanceClient` / multi-instance demux client** — deleted with
  `src/tui/`; Cycle B reimplements multi-host attachment in the browser if needed.
- Changing kernel primitives, extension set, capability model, or `BUILTIN_EXTENSIONS`.
- Changing JSONL / `--json` machine streams or `POST /run` semantics.
- Redesigning the view-model reducer, display modes, or plain-render UX beyond
  removing TUI-only affordances (the startup hint).
- Changing monitor endpoint shapes (Cycle B consumes them as-is; any API gap is a
  Cycle B design issue or a follow-on).
- Rewriting git history of `2d07535` (land Cycle A as a new commit on top; the
  TUI commit remains historical fact even if unpushed). Verified tip:
  `git rev-parse --short HEAD` → `2d07535` on design date; the closed design’s
  `da3efd8` closing-commit is the F closeout hash of that earlier cycle, not
  necessarily the current branch tip.
- Removing `SessionSource` entirely (rejected in KDD2 — keeps a tested client
  contract for Cycle B).
- Reintroducing the pre-`2d07535` hand-rolled `src/render/` alt-screen path.

**Quality budgets intentionally excluded:**

- Bundle size / Lighthouse / browser a11y — no web UI in this cycle.
- Terminal paint latency — plain renderer behavior is unchanged except hint removal.
- No new performance SLO; regression bar is existing offline suite green.

## 4. Key Design Decisions

### KDD1 — What survives the drop (substrate vs full revert)

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Keep neutral cores + plain renderer + monitor HTTP/SSE; drop only Ink client** (chosen) | Matches user intent; Cycle B reuses view-model + server API; no CLI regression | Leaves host modules that Ink introduced; docs must say “web later” |
| B. Full revert of `2d07535` (back to pre-TUI render path) | Smaller tree | Loses view-model de-interleaving / tool-card UX on CLI; destroys monitor API Cycle B needs; fights “keep the simple implementation” (that implementation *is* engine-render) |
| C. Keep Ink sources disabled / unshipped | Fast | Dead code, deps, and isolation charter remain |

**Choice: A.** The user asked to keep the simple implementation and use web for
rich display — not to unwind the plain-renderer architecture.

### KDD2 — Fate of `SessionSource` (`src/tui/source.ts`)

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Extract to host-level `src/session-source.ts`** (chosen) | Module is already ink-free; offline tests pin SSE frame mapping + reconnect; Node reference client for monitor API; Cycle B can port protocol with a known oracle | One more host file after TUI is gone |
| B. Delete with `src/tui/` | Smaller | Loses tested RemoteSource contract; Cycle B re-derives SSE framing from server code alone |
| C. Leave under empty `src/tui/` | Minimal move | Nonsense package layout after bin removal |

**Choice: A.** Extract is a surgical re-home, not a redesign. Browser Cycle B still
implements its own EventSource client; the Node `RemoteSource` remains the
contract test oracle and any future headless remote tooling.

### KDD3 — Startup hint / `shouldSuggestTui`

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Remove predicate + hint entirely** (chosen) | No false product promise; less dead API | Cycle B may later want a “open web UI” hint — reintroduce then |
| B. Repurpose text to “web UI coming / open URL” | Forward-looking | No web server UI yet; would lie or be vague |
| C. Keep hint pointing at removed bin | — | Broken UX |

**Choice: A.**

### KDD4 — Documentation product story

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Rewrite `docs/TUI.md` as plain-display doc; README drops `eagent-tui` section; note web as planned** (chosen) | One human-facing display doc; no broken install instructions | Temporary “planned web” mention until Cycle B |
| B. Delete `docs/TUI.md` and fold into README only | Fewer files | Loses progressive-disclosure detail the plain CLI still needs |
| C. Leave TUI.md describing Ink | — | Drift and false docs |

**Choice: A, rewrite in place.** Keep the path `docs/TUI.md` (no rename) to avoid
link churn across README/CLAUDE/ARCHITECTURE; rewrite content so the filename is
historical but the doc describes plain CLI display + planned web.

### KDD5 — Dependency / charter policy after the drop

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Strict zero runtime deps again except `jiti`** (chosen) | Matches pre-Ink charter; SEA and engine story stay clean | Cycle B web stack is separate packaging (not the engine) |
| B. Leave a “future web may add deps” hole in the engine charter | — | Confuses engine vs web packaging |

**Choice: A.** Cycle B’s web frontend is a **separate front end** (like `eagent-tui`
was), not a license to put UI frameworks in the engine/kernel.

### KDD6 — Relationship to Cycle B (web at TUI feature parity)

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Hard boundary: no web code in Cycle A** (chosen) | Independent shippable drop; smaller review surface | Rich UX gap until B lands |
| B. Scaffold empty `web/` package now | Starts B early | Violates multi-subsystem split; scope creep |

**Choice: A.** Cycle B design will target TUI feature parity: single-session
streaming transcript (reasoning/answer/tools/sub-agents, collapsible sections,
display modes) + multi-session monitor (list, live SSE, stop), consuming existing
monitor + `/run`/`/answer` endpoints.

## 5. Dependencies and Assumptions

- **Git tip:** local `init` includes `2d07535` (TUI rebuild). Cycle A commits **on
  top**; does not require that commit to be on `origin` first.
- **Offline suite** remains the gate: MockProvider, no API keys
  (`npm test`, `npm run eval`).
- **HTTP session/monitor routes** (verbatim from `src/server.ts` file header,
  lines 15–19). Two groups, both **unchanged** by Cycle A:

  **Monitor set (4)** — listed together in the server comment at lines 22–25 as
  “the monitor endpoints (`/sessions` list, the two SSE feeds, `/sessions/:id/stop`)”:

  ```
  GET    /sessions              → list live sessions [{ id, running, usage, costUsd }]
  GET    /sessions/:id/events   → a per-session live SSE feed (tenant-isolated)
  POST   /sessions/:id/stop     → abort a running turn (agent.stop())
  GET    /events                → a global SSE feed; each frame tagged with its session
  ```

  **Session summary (1)** — pre-existing session introspection, same path prefix:

  ```
  GET    /sessions/:id          → a session's usage + cost summary
  ```

  AC4 pins the **monitor set of four** plus the summary route remaining present
  and `test/server-monitor.test.ts` green.
- **SessionSource import today** (verbatim):
  `test/session-source.test.ts` imports from `../src/tui/source.js` — L3 must
  retarget to the extracted module path.
- **CLI hint site** (verbatim pattern): `src/cli.ts` prints
  `run eagent-tui` when `shouldSuggestTui(...)` is true; tests assert the hint is
  absent from `--json` / `--eval` streams — after removal, those negative
  assertions stay; positive TUI-hint tests are deleted or rewritten as “no hint”.
- **Assumption:** no in-flight parallel PR reintroduces `src/tui/` or depends on
  the `eagent-tui` bin. If one appears, serialize before merge.
- **Assumption:** users of the unpushed TUI commit are the author only; no
  external consumers of `eagent-tui` need a deprecation window.

## 6. Relationship with Existing Designs

| Document | Relationship |
| --- | --- |
| `docs/design/2026-07-23-tui-ink-rebuild.md` | **Partial supersession.** Retains D7-class plain renderer + shared view-model + monitor endpoints + SessionSource concept. **Supersedes / retracts** D1 Ink module, D3 Ink components, D4 Ink-specific coalescing/windowing as product surface, D6 `eagent-tui` bin packaging, D10 ink/react charter exception, and all AC items that require `npm run build:tui` / Ink rendering. |
| `docs/design/2026-07-22-tui-redesign.md` | Historical; already superseded by 2026-07-23. Cycle A does **not** revive `src/render/`. |
| `docs/design/2026-07-14-multitenant-isolation.md` | Unchanged; monitor SSE tenant isolation (`currentRootAgent()`) stays. |
| `docs/design/2026-07-11-jsonl-unify.md` / CLI JSON | Unchanged machine streams. |

**Warning:** Do not interpret “drop TUI” as “drop view-model”. That would
conflict with KDD1 and with the closed 2026-07-23 decision to keep plain-path
pain-point fixes.

Terminology anchors: CLAUDE.md (front ends, zero-dep charter), README
“Four engine front ends” / interactive display sections, `docs/TUI.md`.

## 7. Acceptance Criteria

Each criterion is automatable:

| ID | Criterion | Measurement |
| --- | --- | --- |
| AC1 | No Ink/React + zero-dep pin | Permanent offline test (e.g. `test/zero-dep.test.ts`, run under `npm test`): (a) `package.json` runtime `dependencies` keys ⊆ `{ jiti }`; (b) no `ink` / `react` / `@types/react` / `ink-testing-library` in `dependencies` or `devDependencies`; (c) no `from "ink"` / `from "react"` (or equivalent) import under `src/` or `test/`. Replaces deleted `test/tui-isolation.test.ts`. |
| AC2 | No TUI package / build surface | `package.json` has no `eagent-tui` bin, no `build:tui` / `test:tui` scripts, and the default `test` script has no `*.test.tsx` glob; `test -d src/tui` is false; `test -d test/tui` is false; no `.tsx` under `src/` or `test/`; `tsconfig.json` / `tsconfig.test.json` have no `"jsx"` key and no `**/*.tsx` include once none remain |
| AC3 | SessionSource still offline-tested | `test/session-source.test.ts` imports the extracted host module (not `src/tui/`); `npm test -- test/session-source.test.ts` passes |
| AC4 | Session/monitor HTTP routes unchanged + green | `npm test -- test/server-monitor.test.ts` passes; `src/server.ts` header still documents the **monitor set of four** (`GET /sessions`, `GET /sessions/:id/events`, `POST /sessions/:id/stop`, `GET /events`) **and** `GET /sessions/:id` summary (§5) |
| AC5 | Plain CLI path intact | `npm test -- test/engine-plain-render.test.ts test/view-model.test.ts test/attribution.test.ts test/cli.test.ts` passes; no `eagent-tui` string in `src/cli.ts` |
| AC6 | Doc surface reconciled (D5) | Automateable text pins (grep / offline test, or shell asserts in ACCEPT): (a) CLAUDE.md states engine runtime deps are zero except `jiti` and does **not** grant an `src/tui/` ink/react exception or document `src/tui/` as a shipped front end; (b) README.md does not instruct users to run `eagent-tui` / `build:tui` / `test:tui` and does not list `src/tui/` as a layout entry for a shipped Ink client; (c) ARCHITECTURE.md does not document Ink / `eagent-tui` / `src/tui/` as a shipped front end and states zero runtime deps except `jiti`; (d) `docs/TUI.md` has no `eagent-tui` install/usage/`build:tui`/`test:tui` instructions and describes plain CLI display + planned web for rich UI; (e) CHANGELOG Unreleased (or equivalent top entry) notes removal of the Ink `eagent-tui` client (not how to install it) |
| AC7 | Project gates green | `npm run typecheck && npm run typecheck:test && npm test && npm run eval && npm run build && npm run build:binary` all exit 0 |
| AC8 | No startup TUI hint | `shouldSuggestTui` is absent from `src/`; `npm test -- test/tty.test.ts test/cli.test.ts` pass; interactive path does not print `eagent-tui` |

**Quality budget:** none declared (see §3 exclusions). Regression budget = AC7.

## 8. Risks and Rollback

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Accidental deletion of view-model / monitor endpoints | D4 + AC3/AC4 pin them; L3 review traces each delete | `git revert` Cycle A commit(s) |
| SessionSource extract breaks imports | Single module move + update `test/session-source.test.ts`; run that file first | Revert extract commit |
| Docs drift fails CI / human confusion | D5 + AC6; touch CLAUDE/README/ARCHITECTURE/CHANGELOG/TUI.md in same change set as code | Revert |
| Local-only TUI commit never pushed; Cycle A confuses history | Document in §5; commit message “drop Ink TUI…” on top of `2d07535` | Soft-reset only if author chooses pre-push rewrite (out of scope) |
| Cycle B delayed → product has only plain CLI rich-ish UX | Accepted; plain renderer already has sections/modes | N/A |
| External script calls `eagent-tui` | Assumption: author-only; CHANGELOG notes removal | Revert or temporary shim (not planned) |

**Rollback mechanism:** single or stacked git reverts of Cycle A commits restore
`src/tui/` and deps from history. No data migration.

## Deferred to Cycle B (not this design)

- Web app package layout, framework, and build.
- Browser client for SSE + `/run`/`/answer`.
- Feature parity matrix vs former `eagent-tui` (transcript + monitor).
- Multi-instance attach logic formerly in `InstanceClient` (`src/tui/instance.ts`)
  — reimplement in the browser if multi-host monitor remains a v1 requirement.
- Optional CLI hint to open a web URL once a UI exists.
- Any monitor API extensions the browser needs (CORS, static file hosting, WebSocket, etc.).
