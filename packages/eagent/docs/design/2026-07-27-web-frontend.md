# Design — Web frontend (TUI feature parity, single-host)

Slug: `2026-07-27-web-frontend`
Status: closed
Closing-commit: `925bd55`
Closed-on: 2026-07-27
Deferred: multi-host monitor; wire actingId; CLI open-url hint
Date: 2026-07-27
L1-review: rounds 1–10; closed on consecutive clean r9+r10 (0 severe / 0 general)
Depends on: `docs/design/2026-07-27-drop-ink-tui.md` (Cycle A closed — plain CLI +
monitor HTTP/SSE + `SessionSource` substrate retained).

### User-confirmed intent (2026-07-27)

1. **Product:** full web UI at former **TUI feature parity** — single-session
   streaming transcript (reasoning / answer / tools / nested sub-agents where the
   wire allows, collapsible sections, display modes) **and** multi-session
   monitor (list, live SSE, stop).
2. **Packaging:** static SPA **served by `eagent-serve`** (same-origin in prod).
3. **Stack:** **Vite + React + TypeScript** under a separate `web/` tree; web
   dependencies never enter the engine runtime chart (`jiti` only).
4. **Monitor scope v1:** **single-host** multi-session (one base URL + optional
   bearer token). Multi-host attach deferred.
5. **No parallel in-repo task** covers this domain (Cycle A closed; no other
   open `docs/design/*web*` draft).

## 1. Background and Purpose

Cycle A removed the Ink `eagent-tui` client. The product direction is a **browser**
as the rich surface. The engine already exposes:

- Human-oriented section tree via pure `src/view-model.ts` (+ formatting helpers).
- HTTP API: `POST /run` (JSONL), `POST /answer`, session CRUD, and the **monitor
  set** (`GET /sessions`, `GET /sessions/:id/events`, `GET /events`,
  `POST /sessions/:id/stop`) plus `GET /sessions/:id` summary
  (`src/server.ts` header, lines 10–20).
- Node reference client `src/session-source.ts` (`RemoteSource`) documenting
  remote event mapping and the known **flat-transcript** remote limitation
  (no per-fork `actingId` on the wire — `session-source.ts` lines 278–281).

Without a web UI, rich multi-session observability and a live collapsible
transcript exist only as a plain append-only CLI and raw HTTP/SSE.

## 2. Deliverables

- [x] **D1 — `web/` SPA.** Vite + React + TypeScript app with two primary modes
      (v1 **parity cut-line** — see §3):
      - **Chat / transcript:** client-generated session id (UUID); multi-turn
        accumulation with user “clear”; stream a turn via **`POST /run` JSONL
        body** (KDD4); display modes `auto` | `full` | `collapsed`; expand/
        collapse; input; stop; mid-turn elicitation from `action_required` on
        that JSONL stream → `POST /answer`; surface busy **409** on send.
      - **Monitor:** single-host `GET /sessions` list (`id`, `running`, `usage`,
        `costUsd`); open detail via per-session SSE; stop
        (`POST /sessions/:id/stop`); forget (`DELETE /sessions/:id`) when idle.
- [x] **D2 — Browser API client + pure wire mapper.** Fetch-based client for
      REST + **chat JSONL** + **monitor SSE** (KDD4/KDD5). Export a **pure**
      `frameToTaggedEvent` (or equivalent) from a host-shared pure module that
      both Node `RemoteSource` and the web client import — **no** private
      method copy. Offline tests pin the mapper once.
- [x] **D3 — Shared pure view-model.** SPA folds `src/view-model.ts`
      (`initialModel`, `reduce`, `applyControl`). DOM renders from `Section`
      fields; CLI helpers `headerLine`/`bodyLines` are optional, not the UI
      contract. Web must **not** import `session-source` (Node http),
      `attribution` (ALS), `server`, or `cli`.
- [x] **D4 — Static hosting on `eagent-serve`.** Zero new engine runtime deps.
      API routes first; **static GET assets + SPA `index.html` are auth-exempt**
      (KDD9), like `/health`. SPA fallback for unmatched GETs that are not API
      prefixes. Path-traversal denied. Missing web root → soft hint, API still
      works. Dev: Vite proxy to API (forwards `Authorization`; no prod CORS).
- [x] **D5 — Auth UX.** `/health` → if `auth: "required"`, prompt for token;
      store in **`sessionStorage` only** (KDD10); send `Authorization: Bearer`
      on all API/SSE/JSONL requests. Document XSS→token risk + yolo server
      authority in `docs/WEB.md` + SECURITY cross-link.
- [x] **D6 — Build/test/docs.** Root scripts `build:web`, `dev:web`, `test:web`
      (web tests live under `web/`, **not** root `test/` so zero-dep scan stays
      React-free). Offline engine tests for static serve + pure mapper.
      New **`docs/WEB.md`**; update `docs/TUI.md` to point rich UI at web;
      README / CLAUDE / ARCHITECTURE / CHANGELOG.
- [x] **D7 — Quality budget.** Gzipped production assets ceiling (KDD7); ACCEPT
      fails if exceeded. Text-safe DOM rendering of model/tool strings (no
      `dangerouslySetInnerHTML` of untrusted content).

## 3. Scope Boundary

**In scope**

- Single-host chat + monitor SPA, static serve from `eagent-serve`, browser
  client, pure wire mapper extract, view-model reuse, docs/scripts/tests above.
- Minimal server changes: static file + SPA fallback + **auth-exempt static GET**
  (KDD9). Does **not** shadow API routes.

**v1 parity cut-line (in)** — must ship:

| Capability | Notes |
| --- | --- |
| Streaming reasoning + answer | Via `/run` JSONL |
| Tool cards + results | Full args/results in model |
| Display modes auto/full/collapsed | `applyControl` |
| Expand/collapse section n | Same |
| Mid-turn elicitation | From `/run` JSONL `action_required` |
| Stop running turn | Monitor + chat |
| Session list + usage/cost | `GET /sessions` |
| Forget idle session | `DELETE` |
| Token-gated API | Bearer + sessionStorage |

**v1 parity cut-line (out)** — explicit non-goals:

- Multi-host monitor; ≥100-col side panel; Ink keybinding parity; delta
  coalescing as a separate subsystem; concurrent-fork tree de-interleave over
  HTTP (flat remote transcript); capability-ask UI (server remains operator-
  configured yolo/ask); CLI “open web” hint; WebSocket; React in SEA/engine deps;
  OAuth / multi-user accounts; TLS in-process.

**Quality budgets**

- **Declared:** gzipped production bundle ceiling (D7 / KDD7 / AC7); text-safe
  rendering (D7).
- **Excluded this cycle:** Lighthouse a11y score, paint p99, SSE reconnect
  latency SLO.

## 4. Key Design Decisions

### KDD1 — Packaging / same-origin vs CORS

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Static SPA on `eagent-serve` (chosen)** | Same-origin; no CORS; one process for local use; matches user intent | Server must serve files carefully (API route precedence) |
| B. Separate origin + CORS | Clean package split | CORS surface, cookies/token edge cases, two ports always |
| C. Embed React in SEA | One binary UX | Breaks zero-dep charter; large binary |

**Choice: A.**

### KDD2 — UI stack

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Vite + React + TS (chosen)** | Component model for section tree; fast HMR; user-confirmed | Web deps to maintain under `web/` |
| B. Vanilla TS | Fewer deps | More DOM code for parity |
| C. No-build HTML | Zero toolchain | Poor TS/view-model reuse at scale |

**Choice: A.** Web `package.json` / lockfile isolated under `web/` (or workspace)
so root engine `dependencies` remain `{ jiti }` only (`test/zero-dep.test.ts`).

### KDD3 — View-model reuse

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Import `src/view-model.ts` into the web build (chosen)** | Single source of truth; CLI and web cannot diverge on reduce | Vite must resolve NodeNext `.js` imports; path config |
| B. Duplicate reducer in `web/` | Isolation | Drift risk |
| C. Publish view-model as npm package | Clean boundaries | Overkill for monorepo |

**Choice: A.** Import **only** pure `view-model` (+ type-only kernel types it
pulls). Forbidden from `web/`: `session-source`, `attribution`, `server`, `cli`,
providers, extensions.

### KDD4 — Event path (chat vs monitor) — elicitation-correct

**Fact (verbatim path):** `action_required` is written on the **`POST /run`
JSONL body** (`src/server.ts` streamRun ask sink, ~line 523). Per-session SSE
(`streamSse`) re-emits `wireJsonl` + `agent_end` + `error` only — **not**
`action_required`. Node `RemoteSource.#post` drains `/run` without parsing;
stub tests that inject `action_required` on SSE do not match production.

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Split paths (chosen):** chat = parse **`POST /run` JSONL**; monitor passive detail = **SSE** | Elicitation works without server schema change; monitor stays attach-friendly | Two client readers; chat must not rely on SSE for ask |
| B. Also emit `action_required` on SSE | Unifies RemoteSource + web | Extra server emission; still need /run for run control |
| C. SSE-only for chat (RemoteSource as-is) | Matches old TUI remote | **Breaks elicitation** on real server |

**Choice: A.**

- **Chat:** `POST /run` with `session`; read NDJSON body; map each line via pure
  mapper → `reduce`; on `action_required`, show UI and `POST /answer`; disable
  send while running; handle **409** busy.
- **Monitor list:** poll or refresh `GET /sessions` (interval or manual).
- **Monitor detail:** `GET /sessions/:id/events` SSE (or fetch-stream per KDD5)
  for live observation **without** requiring an open `/run` from this browser.
  Live-from-attach only (no history replay).
- **Do not** require global `GET /events` for v1 (optional later).

**Pending elicitation UI dismiss (normative — chat only):** clear the ask chrome
on any of:

| Trigger | Why |
| --- | --- |
| Successful `POST /answer` (**2xx**) | Prompt resolved |
| `POST /answer` → **404** | Ask already gone (timeout / prior answer / turn end); dismiss + non-blocking notice |
| `POST /answer` → **400 / 401 / 413 / network** | Ask **still pending** on server; **keep** chrome; surface error; allow retry |
| Clear (KDD11) | Full chat reset |
| Chat stop | Run aborted |
| `/run` stream terminal | Reader end, `agent_end`, transport error, or abort — server may already have settled the ask with `null` on disconnect |
| Any further **parsed** `/run` JSONL object after `action_required` without a client answer (any `type` field) | Server-side timeout/settle continues the turn; client must not keep a blocking modal |

There is **no** cancel/withdrawn wire event. Late `/answer` after timeout is 404.

**Ask chrome:** when `options` is a non-empty array, render choice chips; when
`options` is `null`, absent, or **empty array**, free-text input (matches JSONL /
mapper).

### KDD5 — Auth on streaming responses (SSE)

Browser `EventSource` cannot set `Authorization`.

| Option | Pros | Cons |
| --- | --- | --- |
| **A. fetch() streaming for SSE routes with Bearer header (chosen)** | No token in query/URL; same auth as REST | Reconnect logic hand-rolled (backoff like RemoteSource) |
| B. Token query param on SSE only | Native EventSource | Logs/Referer risk |
| C. Cookie login session | Clean EventSource | New auth model |

**Choice: A** as the **only** v1 path (no query-token fallback in v1).

### KDD6 — Monitor scope

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Single-host multi-session (chosen)** | Matches user | No multi-instance |
| B. Multi-host | Full former `--monitor` | Deferred |

**Choice: A.**

### KDD7 — Bundle size budget

| Option | Pros | Cons |
| --- | --- | --- |
| **A. ≤ 350 KiB gzipped sum of `web/dist/**/*.{js,css}` excluding `*.map` (chosen)** | Measurable | May need code-split |
| B. No budget | Faster ship | Silent bloat |
| C. ≤ 150 KiB | Very lean | Likely blocks React baseline |

**Choice: A.** `index.html` not counted in the sum; source maps excluded.

### KDD8 — Server static root configuration

| Option | Pros | Cons |
| --- | --- | --- |
| **A. `EAGENT_WEB_ROOT` env + default `web/dist` (chosen)** | Ops override | SEA path docs needed |
| B. Embedded in SEA always | Always present | Binary bloat / charter tension |
| C. file:// only | — | Broken fetch |

**Choice: A.** Missing root: API works; `GET /` returns a plain-text/JSON build
hint (not 500). npm `files` need not ship `web/dist` in v1 (document build step).

### KDD9 — Static assets vs auth gate

**Fact:** After `/health`, all other routes currently require Bearer when
`EAGENT_TOKEN` is set (`src/server.ts` ~272–275).

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Auth-exempt: GET static files + SPA index under web root (chosen)** | UI can boot, then prompt for token | Must not exempt API paths |
| B. Token required before any HTML | “Secure by default” | Chicken-and-egg; cannot load JS to enter token |
| C. Public API too | — | Breaks SECURITY model |

**Choice: A.** Classify each request first:

1. `/health` → always open.
2. **Exempt static GET** (file under web root or SPA `index.html` fallback for
   non-reserved GET paths) → no auth.
3. **Everything else** (including unknown paths when token is set) → require
   Bearer (**401 before 404**).
4. Never SPA-fallback reserved API prefixes
   (`/run`, `/answer`, `/sessions…`, `/events`, `/health`).

### KDD10 — Token storage

| Option | Pros | Cons |
| --- | --- | --- |
| **A. sessionStorage (chosen)** | Cleared with tab; less durable XSS window than localStorage persistence across sessions | Re-enter token per tab |
| B. localStorage | Survives reload | Longer-lived theft |
| C. Memory only | Safest | Lost on refresh |

**Choice: A.** Document XSS→token = full agent authority when server is yolo.

### KDD11 — Multi-turn transcript semantics

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Accumulate sections across runs; user “Clear” resets (chosen)** | Chat-like history | Large DOM over time |
| B. Reset model on every run (synthesize agent_start) | CLI-like | Loses prior turn in UI |
| C. Server-side history only | — | No server history API |

**Choice: A**, with **Clear = full chat reset** (allowed even while a turn is
busy). **Order is normative** (mint first so the generation guard is live):

1. `previousId = currentSessionId`; **always mint a new `currentSessionId`
   (UUID)** first. Optionally also bump a monotonic `generation` bound to the
   open reader as an **additive** drop-guard (not a substitute for minting).
2. Abort any open `/run` fetch/reader. The consumer drops **all** further frames
   for that reader when `boundSession !== currentSessionId` (or generation
   mismatch). Do **not** rely on a `session` field on every JSONL line — most
   `/run` events omit it (`eventToJsonl` / `wireJsonl`).
3. `viewModel = initialModel(mode)`; clear user-bubble chrome and any pending
   elicitation UI.
4. Best-effort `POST /sessions/{previousId}/stop` then `DELETE
   /sessions/{previousId}` (ignore 404/409).

Display-only clear (same UUID, no mint) is **rejected** — it would desync UI
from server context (server accumulates by session id — `src/server.ts` header
~27–28).

**UI footguns (normative):**

- **Busy flag** is “`/run` stream open”, **not** `viewModel.done` alone —
  `reduce` sets `done` on `agent_end` and only clears it on `agent_start`, which
  the remote wire never sends; a stuck `done` must not block send incorrectly or
  be the sole spinner signal.
- **User messages** are SPA chrome (bubbles outside the section tree). v1 does
  **not** add a `user` section kind to `view-model`.
- **Chat stop** uses the same `POST /sessions/:id/stop` as monitor while a JSONL
  body may still be open; client aborts the fetch reader after stop.

### KDD12 — Pure mapper module layout

| Option | Pros | Cons |
| --- | --- | --- |
| **A. Extract pure mapper + wire types to e.g. `src/wire-events.ts`; RemoteSource + web import it (chosen)** | One oracle; AC4 pins once | Small engine file add |
| B. Duplicate under web/ | Faster | Drift |
| C. Keep private on RemoteSource | — | Cannot share |

**Choice: A.** Move mapper I/O types (`SourceEvent` or equivalent including
meta kinds `action_required` / `usage` / `error` / `connected` / `reconnected`)
into the pure module so **web never imports `session-source.ts`**.

Signature (normative):

```ts
wireObjectToSourceEvent(
  obj: Record<string, unknown>,
  ctx: { session: string; at: number },
): SourceEvent | undefined
```

`ctx` supplies `actingId`/`rootId`/`at` tags (remote flat transcript: acting ===
session). Input `obj` is a **parsed** JSON object (one JSONL line or SSE
`data:` payload), not raw SSE framing. SSE `event: connected` framing stays in
the transport layer (not this pure function). Optional pure `SseParser` may
move beside it or be reimplemented under `web/` — L2 picks one, not both.

Node-only HTTP stays in `session-source.ts`.

### KDD13 — Package / base URL / monitor refresh / routes defaults

| Topic | Choice |
| --- | --- |
| Layout | Plain `web/package.json` + root scripts `cd web && …` (not monorepo workspace required) |
| API base | Relative URLs in production (same-origin); Vite dev proxy forwards `Authorization` |
| **Client routes** | Hash or path routes that **do not** collide with API prefixes: `/` (chat), `/#/monitor` or `/ui/monitor` — **not** `/sessions`, `/events`, `/run`, `/answer`, `/health`. Full page load of a client route must hit SPA fallback, not an API path. |
| Monitor list refresh | Default: refresh on tab focus + every **5s** while Monitor view is mounted; manual refresh control |
| Monitor detail | Live-from-attach only (SSE); no history replay API in v1 |
| Token logout | UI control clears `sessionStorage` key and re-prompts |
| Passive monitor + ask | Monitor detail does **not** show mid-turn elicitation in v1 (ask only on chat `/run` stream) |
| Bundle budget in CI | AC7 measured as part of `build:web` or `test:web` (AC10 chain) |

## 5. Dependencies and Assumptions

- **Cycle A complete** on the working branch (plain renderer, monitor routes,
  zero-dep pin, `session-source`).
- **Wire shapes** (verbatim server header, `src/server.ts` lines 10–20):

  ```
  GET    /health
  POST   /run             → JSONL stream
  POST   /answer
  GET    /sessions
  GET    /sessions/:id
  GET    /sessions/:id/events  → SSE
  POST   /sessions/:id/stop
  GET    /events               → SSE (global)
  DELETE /sessions/:id
  ```

- **Remote attribution limitation** (verbatim comment intent from
  `src/session-source.ts` 278–281): remote feed has no per-agent id; acting ===
  root (session). Web transcript parity is **section collapse / tool cards /
  modes**, not full concurrent-fork tree de-interleave.
- **Engine zero-dep:** only `jiti` in root `dependencies`; Vite/React are
  `web/` devDependencies or `web/dependencies`, never root engine runtime.
- **Node ≥ 22** (existing engines field).
- **Assumption:** operators terminate TLS at a reverse proxy when exposing
  beyond localhost; design does not add HTTPS to `eagent-serve`.

## 6. Relationship with Existing Designs

| Document | Relationship |
| --- | --- |
| `docs/design/2026-07-27-drop-ink-tui.md` | **Prerequisite / succession.** Cycle A deferred web UI, InstanceClient, CORS, static hosting to Cycle B. This design **implements** that deferred product surface (single-host). Does **not** reintroduce Ink. |
| `docs/design/2026-07-23-tui-ink-rebuild.md` | Historical UX reference for parity (transcript modes, monitor list/stop). **Not** re-adopting Ink packaging (superseded for client surface). |
| `docs/design/2026-07-14-multitenant-isolation.md` | Unchanged; SSE tenant filter stays. |
| `docs/JSONL.md` | Consumption contract for event types; no schema change. |

**Warning:** Do not put React into the engine charter “exception” slot Cycle A
closed. Web is a **separate front end**, same pattern as the former Ink client
but browser-hosted and statically served.

## 7. Acceptance Criteria

| ID | Criterion | Measurement |
| --- | --- | --- |
| AC1 | Web app builds | `npm run build:web` exits 0; `web/dist/index.html` exists |
| AC2 | Engine zero-dep + no root React | `node --import tsx --test test/zero-dep.test.ts` passes; root `package.json` runtime deps ⊆ `{ jiti }`; root deps/devDeps have no `react`/`vite`/`ink` |
| AC3 | Static + API + auth split | Offline server test with temp web root + `EAGENT_TOKEN` set: (a) `GET /` → 200 HTML **without** Authorization; (b) `GET /health` → 200 JSON without token; (c) `GET /sessions` without token → 401; (d) `GET /sessions` with Bearer → 200 array; (e) static assets (e.g. `/app.js`) served when present; unknown paths 404 (hash client routes — SPA only at `/`); (f) path `../` traversal attempt → 404/400 not file leak |
| AC4 | Pure wire mapper | Offline test of exported pure mapper: fixtures for `text_delta`, `reasoning_delta`, `tool_start`/`tool_end`, `agent_end`, `action_required`, `usage`, `error` map correctly; `RemoteSource` uses the same export (import graph assertion or unit call) |
| AC5 | View-model UI logic | Offline test: scripted events → `reduce` + `applyControl` assert section count / modes (no browser) |
| AC6 | Chat JSONL + elicitation path | Offline pure consumer: (a) NDJSON with `action_required` → pending ask; (b) further parsed line without client answer → **dismissed** ask; (c) answer helper: **404** → dismissed, **400**/network → still pending; (d) documents ask is on `/run` body not SSE |
| AC7 | Bundle budget | Script: sum gzip of `web/dist/**/*.{js,css}` excluding `*.map` ≤ **350 × 1024** bytes |
| AC8 | HTTP client surface | Offline mock-fetch tests: `listSessions` parses `{id,running,usage,costUsd}[]`; `stopSession` POSTs `.../stop`; `deleteSession` DELETEs; chat `run` attaches Bearer; non-2xx `/run` including **409** maps to a structured busy/error result (not a silent throw-away) |
| AC9 | Docs | `docs/WEB.md` exists; README build/open steps; CLAUDE/ARCHITECTURE describe web as rich surface; `docs/TUI.md` points to web; CHANGELOG Added; no `eagent-tui` install instructions |
| AC10 | Project gates | `npm run typecheck && npm run typecheck:test && npm test && npm run eval && npm run build && npm run build:web && npm run test:web` exit 0; `build:binary` exit 0 |
| AC11 | Multi-turn + Clear | Offline: (a) two scripted turn sequences into one model without `agent_start` → section count grows; (b) Clear → empty sections, mode preserved, **session id changes**; (c) after Clear, applying further deltas from the **old** run binding does **not** increase section count (generation/session guard) |
| AC12 | Text-safe rendering | Offline: walk `web/src` forbids `dangerouslySetInnerHTML` (zero matches) **or** allowlist-empty; component test renders tool result string as text content (no HTML execution of `<img onerror=…>` fixture) |
| AC3 note | Extend AC3 | Also: `GET /run` and `GET /answer` must **not** return SPA `index.html` (404/405) when web root is configured |

**Manual smoke (F, not CI):** mock provider; open UI without token when auth open; run one turn with streamed text; trigger ask if available; monitor list; stop; with token required, load static then enter token.

## 8. Risks and Rollback

| Risk | Mitigation | Rollback |
| --- | --- | --- |
| Static routes shadow API | API match first; reserved path list (AC3) | Revert static patch |
| Auth blocks SPA load | KDD9 auth-exempt static GET (AC3a) | — |
| Elicitation missing on SSE | Chat uses `/run` JSONL (KDD4, AC6) | — |
| XSS steals sessionStorage token | Text-safe render; SECURITY/WEB docs; short-lived sessionStorage | Operator uses hardened + short sessions |
| Bundle exceeds 350 KiB | Code-split chat vs monitor | Design amendment only |
| SEA users lack `web/dist` | Document `build:web`; soft-fail | N/A |
| View-model import breaks under Vite | Alias; AC1 | Extract/copy only with design amendment |
| Scope creep multi-host | Explicit non-goal | Reject |

**Rollback:** revert Cycle B commits; server without static root behaves as today;
CLI unaffected.

## Deferred (follow-ons)

- Multi-host monitor; global `GET /events` demux UI.
- Wire-level acting-agent ids for remote fork de-interleave.
- Emit `action_required` on SSE for passive monitors (optional server enhancement).
- CLI hint to open the web UI URL.
- Optional embed of `web/dist` into SEA packaging.
- Advanced virtualization / infinite scroll for huge transcripts.
- Capability-ask UI when server fallback is `ask` (not yolo).
