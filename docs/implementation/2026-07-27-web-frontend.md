# Implementation — Web frontend (TUI feature parity, single-host)

Slug: `2026-07-27-web-frontend`
Status: L2 draft
Date: 2026-07-27
Design: `docs/design/2026-07-27-web-frontend.md` (L1 closed)

## 1. Task Index

| Design | Phase |
| --- | --- |
| D2 / KDD12 / AC4 pure mapper | Phase 1 |
| D4 / KDD8–9 / AC3 static + auth | Phase 2 |
| D2 client / D3 / AC5–8 / AC11–12 (pure + client tests) | Phase 3 |
| D1 SPA UI / D5–D7 / AC1 / AC7 / AC9–10 | Phase 4 |

`<TEST-CMD>`: `npm test`

## 2. Phase Breakdown

### Phase 1 — Pure wire mapper extract (AC4)

**Entry:** design L1 closed.

**Tasks (TDD):**

1. **Test:** add `test/wire-events.test.ts` covering
   `wireObjectToSourceEvent(obj, { session, at })` for text/reasoning/tool
   start/end/agent_end/action_required/usage/error; assert actingId=session.
2. **Impl:** create `src/wire-events.ts` with `SourceEvent` types + mapper
   extracted from `RemoteSource.#frameToEvent`.
3. **Impl:** refactor `src/session-source.ts` to import and call the pure
   mapper; re-export types if needed for existing tests.
4. **Regression:** `node --import tsx --test test/session-source.test.ts
   test/wire-events.test.ts`

**ACCEPT:**

```bash
node --import tsx --test test/wire-events.test.ts test/session-source.test.ts
npm test
```

**Exit:** commit `feat(phase1): extract pure wire-events mapper`

---

### Phase 2 — Static SPA serve + auth split (AC3)

**Entry:** Phase 1 green.

**Tasks (TDD):**

1. **Test:** extend `test/server-monitor.test.ts` or add
   `test/server-static.test.ts` for AC3(a–f) + reserved `GET /run`/`/answer`
   not SPA.
2. **Impl:** in `src/server.ts`:
   - resolve `EAGENT_WEB_ROOT` (default relative `web/dist`);
   - after `/health`, classify: exempt static GET → serve file / SPA fallback;
     else require auth when token set; API routes unchanged and first-match;
   - path traversal denial; content-type for html/js/css;
   - missing root: soft hint on `GET /` without 500.
3. **Regression:** existing monitor + run tests green.

**ACCEPT:**

```bash
node --import tsx --test test/server-static.test.ts test/server-monitor.test.ts
node --import tsx --test test/zero-dep.test.ts
npm test
```

**Exit:** commit `feat(phase2): serve web static assets with auth-exempt GET`

---

### Phase 3 — `web/` scaffold + pure client helpers (no full UI chrome yet)

**Entry:** Phase 2 green.

**Tasks (TDD):**

1. Scaffold `web/` Vite + React + TS (`web/package.json`, vite.config with
   alias to `../src/view-model.ts` and `../src/wire-events.ts`, proxy `/` API
   in dev except static).
2. **Test under `web/` (or root pure modules re-exported):**
   - chat run consumer (AC6);
   - clear/multi-turn (AC11);
   - HTTP wrappers with mock fetch (AC8);
   - no `dangerouslySetInnerHTML` scan (AC12).
3. Implement `web/src/api/*` and `web/src/chat/*` pure modules (no React
   required for tests).
4. Root scripts: `build:web`, `dev:web`, `test:web`.
5. Ensure root `package.json` deps unchanged (AC2).

**ACCEPT:**

```bash
npm run test:web
npm run build:web
test -f web/dist/index.html
node --import tsx --test test/zero-dep.test.ts
```

**Exit:** commit `feat(phase3): scaffold web client modules and pure tests`

---

### Phase 4 — React UI + docs + budgets (D1, D5–D7)

**Entry:** Phase 3 green.

**Tasks:**

1. React pages: Chat (`/` or hash default), Monitor (`/#/monitor`).
2. Wire token prompt (sessionStorage), list/stop/delete, JSONL run stream,
   elicitation chrome, display modes, Clear.
3. Bundle budget script in `web/` or `scripts/check-web-bundle.mjs` (AC7).
4. Docs: `docs/WEB.md`, README/CLAUDE/ARCHITECTURE/TUI/CHANGELOG (AC9).
5. Full AC10 gates.

**ACCEPT:**

```bash
npm run build:web
node scripts/check-web-bundle.mjs   # or npm run test:web includes budget
npm run typecheck && npm run typecheck:test && npm test && npm run eval
npm run build && npm run build:web && npm run test:web && npm run build:binary
```

**Exit:** commit `feat(phase4): web chat + monitor UI and docs`

## 3. Engineering Constraints

- CLAUDE.md: ESM NodeNext, zero engine runtime deps except `jiti`, offline tests.
- Web deps only under `web/`.
- No React under root `test/`.
- Commits: `feat(phaseN):` / `fix(phaseN-roundR):`; no AI trailers.
- L3 template: three-loop `loop-3-development.md`.

## 4. Fixtures

Reuse MockProvider + `createHttpServer` patterns from `test/server-monitor.test.ts`
and `test/session-source.test.ts`. Web pure tests use mock `fetch`.

## 5. Regression

| After | Must stay green |
| --- | --- |
| P1 | session-source, zero-dep, full `npm test` |
| P2 | server-monitor, zero-dep, full `npm test` |
| P3 | zero-dep + build:web + test:web |
| P4 | AC10 full chain |
