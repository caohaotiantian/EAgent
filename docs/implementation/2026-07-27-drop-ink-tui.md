# Implementation — Drop the rich Ink TUI; keep the plain CLI + web substrate

Slug: `2026-07-27-drop-ink-tui`
Status: L2 closed (ready for L3)
Date: 2026-07-27
Design: `docs/design/2026-07-27-drop-ink-tui.md` (L1 closed)
L2-review: rounds 1–3; closed on consecutive clean r2+r3

## 1. Task Index

| Design ref | Location | Impl Phase |
| --- | --- | --- |
| D1 Remove Ink client surface | design §2 lines 54–62 | Phase 2 |
| D2 Zero-dep charter + permanent pin | design §2 lines 63–68 | Phase 2 (code pin), Phase 3 (charter prose) |
| D3 CLI plain-only / drop hint | design §2 lines 69–72 | Phase 2 |
| D4 Substrate preserve + SessionSource extract | design §2 lines 73–85 | Phase 1 (extract), Phase 2 (retain rest) |
| D5 Doc reconciliation | design §2 lines 86–92 | Phase 3 |
| D6 Green offline gates | design §2 lines 93–97 | Phase 2 exit + Phase 3 exit |
| AC1 Zero-dep pin | design §7 line 269 | Phase 2 |
| AC2 No TUI package surface | design §7 line 270 | Phase 2 |
| AC3 SessionSource re-homed + green | design §7 line 271 | Phase 1 |
| AC4 Monitor routes unchanged | design §7 line 272 | Phase 2 regression |
| AC5 Plain CLI path | design §7 line 273 | Phase 2 regression |
| AC6 Doc surface | design §7 line 274 | Phase 3 |
| AC7 Full gates | design §7 line 275 | Phase 3 |
| AC8 No startup TUI hint | design §7 line 276 | Phase 2 |
| KDD1–KDD6 | design §4 lines 139–206 | constraints on all phases |
| Scope / non-goals | design §3 lines 99–137 | no web UI, no InstanceClient keep, no history rewrite |

**Project test command (`<TEST-CMD>`):** `npm test`

## 2. Phase Breakdown

### Phase 1 — Extract `SessionSource` to host level (D4 extract, AC3)

**Entry condition:** Design L1 closed; working tree on tip that still has
`src/tui/source.ts` and `test/session-source.test.ts` importing
`../src/tui/source.js`.

**Design document references:** D4 (lines 73–85), KDD2 (lines 151–162), AC3
(line 271), §5 SessionSource import note (lines ~230–233).

**Task list (TDD order):**

1. **Test task — AC3 import path pin.** Update
   `test/session-source.test.ts` so the production import is
   `from "../src/session-source.js"` (not `../src/tui/source.js`). Keep every
   existing case (InProcessSource lifecycle ordering, fork de-interleave,
   run/stop/answer control, RemoteSource SSE parse/reconnect, frame shape
   mapping, POST run/answer/stop). Add (or keep) a one-line assert in that file
   or a tiny sibling check that `readFileSync` of the test source does not
   contain the string `tui/source` (do not rely on shell `grep` alone —
   macOS `grep` skips non-ASCII sources; use Node `readFileSync` or `grep -a`).
   **Invariant:** the offline contract for the monitor-API client still runs
   under the new module path; a missing extract fails the suite on
   resolve/import.
2. **Impl task — move module + rewrite relative imports.** Move
   `src/tui/source.ts` → `src/session-source.ts`. Update the file header
   (drop “lives under `src/tui/`”; state host-level monitor client reference).
   **Required import rewrite** (depth changes from `src/tui/` → `src/`):
   - `../kernel/agent.js` → `./kernel/agent.js`
   - `../kernel/types.js` → `./kernel/types.js`
   - `../attribution.js` → `./attribution.js`
   - `../view-model.js` → `./view-model.js`
   Node builtins (`node:http`, `node:https`) stay unchanged. Do **not** claim
   “content unchanged except header” — the relative paths must change.
3. **Impl task — retarget temporary TUI importers.** Until Phase 2 deletes
   `src/tui/`, update:
   - `src/tui/instance.ts`
   - `src/tui/coalesce.ts`
   - `src/tui/start.ts`
   - `src/tui/app.tsx`
   to import from `../session-source.js` (or type-only equivalents). Do **not**
   change SessionSource protocol or behavior.
4. **Impl task — no re-export stub.** Do not leave `src/tui/source.ts` as a
   barrel; Phase 2 deletes the tree. After step 2–3, `src/tui/source.ts` must
   not exist.

**Per-task / Phase acceptance commands:**

```bash
# AC3 — SessionSource offline suite under new path (true single-file)
node --import tsx --test test/session-source.test.ts

# Module exists at host path; old path gone
test -f src/session-source.ts && ! test -f src/tui/source.ts

# Import strings (Node, not bare grep — non-ASCII-safe)
node -e "const fs=require('fs'); const t=fs.readFileSync('test/session-source.test.ts','utf8'); if(t.includes('tui/source')) process.exit(1); if(!t.includes('session-source.js')) process.exit(1); const s=fs.readFileSync('src/session-source.ts','utf8'); if(s.includes('../attribution')||s.includes('../view-model')||s.includes('../kernel/')) process.exit(1);"

# Full suite still green with TUI still present
npm test
```

**Exit condition:** `src/session-source.ts` exists; no `src/tui/source.ts`;
`test/session-source.test.ts` imports host module; `npm test` exit 0; Phase 1
commit landed (`feat(phase1): extract SessionSource to host module`).

---

### Phase 2 — Delete Ink TUI, CLI hint, package surface; permanent zero-dep pin
(D1, D2 pin, D3, AC1, AC2, AC4, AC5, AC8)

**Entry condition:** Phase 1 exit condition met.

**Design document references:** D1 (54–62), D2 pin part (63–68), D3 (69–72),
D4 retain list (73–85), KDD1/KDD3/KDD5, AC1–AC2, AC4–AC5, AC8; §3 required
mechanical cleanup (tsx glob, jsx).

**Task list (TDD order):**

1. **Test task — permanent zero-dep + surface pin (AC1 + AC2).** Add
   `test/zero-dep.test.ts` that fails until cleanup lands. Invariants:
   - Read `package.json`: `Object.keys(dependencies ?? {})` ⊆ `["jiti"]`.
   - `dependencies` and `devDependencies` contain none of:
     `ink`, `react`, `@types/react`, `ink-testing-library`.
   - Walk `src/` and `test/` source files (`.ts`/`.tsx`/`.js`/`.mjs` as present);
     no import/from of `ink`, `ink-testing-library`, or `react` / `react/*`
     (same spirit as deleted `test/tui-isolation.test.ts` FORBIDDEN regex, with
     **no** `src/tui/` exception).
   - no `bin["eagent-tui"]`; no `scripts["build:tui"]` / `scripts["test:tui"]`;
     `scripts["test"]` does not include `*.test.tsx`;
   - `src/tui` and `test/tui` directories do not exist;
   - no `.tsx` files under `src/` or `test/`;
   - `tsconfig.json` and `tsconfig.test.json` have no `"jsx"` key and no include
     glob ending in `.tsx`.
2. **Test task — no TUI hint API (AC8) RED pin.** In the same
   `test/zero-dep.test.ts` (or sibling), walk all files under `src/` with
   `readFileSync` and assert:
   - the identifier `shouldSuggestTui` does not appear;
   - the product string `eagent-tui` does not appear.
   **Invariant:** no code path advertises a removed bin; the predicate is gone
   from `src/` — this test must fail while `src/cli.ts` / `src/tty.ts` still
   contain those strings, **before** impl removes them.
3. **Test task — trim obsolete positive tty cases.** After the AC8 pin exists,
   remove `shouldSuggestTui` **import, header mentions, and cases** from
   `test/tty.test.ts` (keep `isFancy` / `SPINNER_FRAMES`). Keep
   `test/cli.test.ts` negative asserts that stdout does not contain
   `eagent-tui` for `--json` / `--eval`.
4. **Impl task — delete Ink surface.** Delete:
   - entire `src/tui/` directory;
   - entire `test/tui/` directory;
   - `test/tui-isolation.test.ts`.
5. **Impl task — package.json / lockfile.** Remove `eagent-tui` bin; remove
   `build:tui` and `test:tui` scripts; remove `*.test.tsx` from `test` script;
   remove deps `ink`, `react` and devDeps `@types/react`, `ink-testing-library`;
   run `npm install` (or equivalent) so `package-lock.json` matches.
6. **Impl task — tsconfig cleanup.** Remove `"jsx"` and any `**/*.tsx` includes
   from `tsconfig.json` / `tsconfig.test.json` as required by AC2.
7. **Impl task — CLI + tty.** In `src/cli.ts`: remove `shouldSuggestTui` import
   and the startup hint block that prints `run eagent-tui`. In `src/tty.ts`:
   remove `shouldSuggestTui` and its docstring. Do not change
   `wireRendering` / `EngineRenderer` / `/details`/`/expand`/`/collapse`.
8. **Impl task — preserve substrate.** Confirm still present and untouched in
   behavior: `src/view-model.ts`, `src/attribution.ts`, `src/engine-render.ts`,
   `src/session-source.ts`, monitor routes in `src/server.ts`. No protocol edits.
   Optionally assert in `test/zero-dep.test.ts` or a one-liner that
   `src/server.ts` still contains the four monitor route path strings and
   `GET /sessions/:id` documentation (AC4 text half).

**Per-task / Phase acceptance commands:**

```bash
# AC1 + AC2 + AC8 offline pin (true single-file)
node --import tsx --test test/zero-dep.test.ts

# AC8 + plain CLI behavioral negatives
node --import tsx --test test/tty.test.ts test/cli.test.ts

# AC3 still green after TUI delete
node --import tsx --test test/session-source.test.ts

# AC4 monitor behavior + header still documents routes
node --import tsx --test test/server-monitor.test.ts
node -e "const s=require('fs').readFileSync('src/server.ts','utf8'); for (const n of ['GET    /sessions','GET    /sessions/:id','GET    /sessions/:id/events','POST   /sessions/:id/stop','GET    /events']) if(!s.includes(n)) { console.error('missing', n); process.exit(1); }"

# AC5 plain path (includes cli.test.ts per design AC5)
node --import tsx --test test/engine-plain-render.test.ts test/view-model.test.ts test/attribution.test.ts test/cli.test.ts

# Directory absence
! test -d src/tui
! test -d test/tui

# Full suite
npm test
```

**Exit condition:** All Phase 2 ACCEPT commands exit 0; commit
`feat(phase2): drop Ink eagent-tui; restore zero-dep engine pin`.

---

### Phase 3 — Doc reconciliation + full gates (D2 prose, D5, D6, AC6, AC7)

**Entry condition:** Phase 2 exit condition met.

**Design document references:** D2 charter prose (63–68), D5 (86–92), D6
(93–97), KDD4 (rewrite `docs/TUI.md` in place), AC6, AC7.

**Task list (TDD order):**

1. **Test task — doc surface pins (AC6).** Add **`test/docs-display-surface.test.ts`**
   (prefer a new file; do not overload `test/docs-drift.test.ts`, which is
   extension-count-only). Read files as UTF-8 and assert:
   - **CLAUDE.md:** mentions zero runtime deps except `jiti` (or equivalent
     house wording); does **not** grant `src/tui/` ink/react exception; does
     **not** document `src/tui/` / `eagent-tui` as a shipped front end.
   - **README.md:** no user instructions to run `eagent-tui`, `build:tui`, or
     `test:tui`; layout section does not list `src/tui/` as the Ink client.
   - **ARCHITECTURE.md:** no shipped Ink / `eagent-tui` / `src/tui/` front end;
     zero runtime deps except `jiti`.
   - **docs/TUI.md:** no `eagent-tui` install/usage/`build:tui`/`test:tui`
     instructions; describes plain CLI display; mentions planned web (or
     equivalent) for rich UI.
   - **CHANGELOG.md:** Unreleased (or newest top section) contains a **Removed**
     (or equivalent) note that the Ink `eagent-tui` client was dropped. Append
     under Unreleased; do not need to rewrite the historical “Added TUI” block
     from the prior cycle (history may remain; AC6 requires a removal note
     present).
   **Invariant:** docs cannot re-advertise the removed product surface without
   failing CI. This offline test is the **primary** AC6 pin (not shell grep).
2. **Impl task — rewrite docs.** Edit CLAUDE.md, ARCHITECTURE.md, README.md,
   CHANGELOG.md, docs/TUI.md per D5/AC6. Keep monitor endpoint documentation
   (they remain). Point rich UX at planned web frontend (Cycle B), not Ink.
3. **Impl task — charter only.** Ensure zero-dep prose matches KDD5 (engine
   exception list is only `jiti`; web frontend, when built, is a separate front
   end — do not pre-authorize UI frameworks in the engine).

**Per-task / Phase acceptance commands:**

```bash
# AC6 primary pin
node --import tsx --test test/docs-display-surface.test.ts

# Regression smoke (Phase 2 pins + plain path; full AC5 covered again by AC7 npm test)
node --import tsx --test test/server-monitor.test.ts test/engine-plain-render.test.ts test/view-model.test.ts test/attribution.test.ts test/cli.test.ts test/session-source.test.ts test/zero-dep.test.ts

# AC7 full gates
npm run typecheck
npm run typecheck:test
npm test
npm run eval
npm run build
npm run build:binary
```

**Exit condition:** All Phase 3 ACCEPT commands exit 0; commit
`feat(phase3): reconcile docs after dropping Ink TUI`. Design deliverables
D1–D6 checkboxes can be marked done at F closeout (not mid-Phase).

## 3. Engineering Constraints Index

- **Project engineering norms:** CLAUDE.md — ESM + NodeNext (`.js` import
  specifiers), strict TypeScript, **zero runtime deps in the engine except
  `jiti`**, offline `node:test` via `tsx`, capabilities vocabulary, no Claude
  Code attribution in commits, docs-drift discipline for extension counts
  (untouched here).
- **Four-corner L3 template:** skill file
  `~/.claude/skills/three-loop-workflow/references/loop-3-development.md`
  (dev → review → accept → fix).
- **Commit conventions:** `feat(phaseN):` / `fix(phaseN):` openers;
  `fix(phaseN-roundR): <keyword>` for within-round fixes; trailers for
  `<TEST-CMD>` / `<ACCEPT-CMD>` results; **no** AI co-author trailers.
- **Single-file ACCEPT form:** use `node --import tsx --test <files…>` when a
  Phase needs isolation; `npm test -- <file>` still expands the package `test`
  glob and runs the full suite (additive, not a filter).
- **macOS grep:** do not use bare `grep` as the sole pin on sources that may
  contain non-ASCII; use Node `readFileSync` offline tests or `grep -a`.

## 4. Data and Fixture Dependencies

| Resource | Reuse |
| --- | --- |
| `test/session-source.test.ts` | Rehome import only; keep MockProvider + ephemeral HTTP SSE stubs |
| `test/server-monitor.test.ts` | Regression only; no fixture changes |
| `test/engine-plain-render.test.ts`, `test/view-model.test.ts`, `test/attribution.test.ts`, `test/cli.test.ts`, `test/tty.test.ts` | Regression; tty/cli hint cases trimmed in Phase 2 |
| `test/tui/**`, `test/tui-isolation.test.ts` | **Deleted** in Phase 2; do not port Ink tests |
| `test/helpers.ts` | Unchanged harness for agents |
| New: `test/zero-dep.test.ts` | Phase 2 |
| New: `test/docs-display-surface.test.ts` (or equivalent) | Phase 3 |

No network, no API keys, no new binary fixtures.

## 5. Regression Protection

| After Phase | Must stay green |
| --- | --- |
| Phase 1 | Full `npm test` (TUI still present); especially `test/session-source.test.ts` |
| Phase 2 | `test/session-source.test.ts`, `test/server-monitor.test.ts`, plain-render/view-model/attribution/cli suites, `test/zero-dep.test.ts`; full `npm test` |
| Phase 3 | All of Phase 2 pins + `test/docs-display-surface.test.ts` + AC7 command chain |

**Do not** change kernel, extensions, JSONL, or monitor route handlers in any
Phase. Any such need is an L1 design conflict → stop and escalate.

## Commit plan (summary)

1. `feat(phase1): extract SessionSource to host module`
2. `feat(phase2): drop Ink eagent-tui; restore zero-dep engine pin`
3. `feat(phase3): reconcile docs after dropping Ink TUI`
