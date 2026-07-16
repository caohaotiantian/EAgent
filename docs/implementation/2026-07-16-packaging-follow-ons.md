# Implementation — Packaging follow-ons: single-binary build + `/library install`

Slug: `2026-07-16-packaging-follow-ons`
Design: `docs/design/2026-07-16-packaging-follow-ons.md`
Status: closed
Closing-commit: `e48c018` (phases 1-3; each phase closed clean in one round)
Closed-on: 2026-07-16
Deferred: none of this doc's own items; see the design doc's Deferred line.
Outcome: Phase 1 `bc4fa6e` (entryShouldRun + 3 unit tests), Phase 2 `5f96a85`
(`/library` extension + 9 offline tests + doc-count sync 64→65), Phase 3 `e48c018`
(`build:binary` + README). All ACs met — AC1 (guard unit), AC3-AC6 (library offline),
AC7 (gates green, no kernel change), AC2 (binary boot) proven end-to-end.

## Overview

Three phases, each independently revertible, each gated by an offline `<ACCEPT-CMD>`
except the binary's E2E smoke (AC2), which is a documented one-time step recorded at
F (§3 of the design; it needs `npx` network + a ~115 MB artifact, so it is not a
`npm test` gate).

Sequencing rationale:

- **Phase 1 (guard, D1/D6a)** is the load-bearing prerequisite for the binary — the
  SEA binary only boots because `entryShouldRun` fires on `isSea()`. It is a pure,
  offline-unit-tested `src/cli.ts` refactor. Ships first so Phase 3's build has a
  bootable engine.
- **Phase 2 (`/library`, D4/D5/D6b)** is functionally independent of Phase 1 — a new
  extension + registration + offline tests. Ordered second because it is the larger
  surface; failures here never touch the guard.
- **Phase 3 (build script + packaging + docs, D2/D3/D7)** is additive packaging that
  consumes Phase 1's guard. Its AC2 E2E smoke is deferred to F.

No phase touches `src/kernel/`. Each phase is RED-first: the failing test is written
and observed to fail before the implementation lands.

`<TEST-CMD>` = `npm test`. Per-phase `<ACCEPT-CMD>` are listed below. The full gate
set at F is `npm test`, `npm run typecheck`, `npm run typecheck:test`,
`npm run build`, `npm run eval`.

**Baseline (confirm before Phase 1):** on `chore/packaging` at HEAD,
`npm test` / `typecheck` / `typecheck:test` / `build` / `eval` are green. Record the
`npm test` test-count as the regression baseline.

---

## Phase 1 — SEA-aware entry guard (D1, D6a)

**Scope:** `src/cli.ts` only, plus a unit test in `test/cli.test.ts`. Traces to D1,
KDD1, AC1, and the AC7 "existing subprocess cli tests still pass" clause.

**Deliverables:**

1. Add `import { isSea } from "node:sea";` to `src/cli.ts` (top imports).
2. Replace the `isEntryPoint()` function (`cli.ts:486-494`) with an **exported pure**
   function:
   ```ts
   export function entryShouldRun(
     argv1: string | undefined,
     importMetaUrl: string,
     isSea: boolean,
   ): boolean {
     if (isSea) return true;
     if (!argv1) return false;
     try {
       return importMetaUrl === pathToFileURL(realpathSync(argv1)).href;
     } catch {
       return false;
     }
   }
   ```
   The realpath branch, the `!argv1 → false`, and the `try/catch → false` are
   preserved verbatim from the current guard (KDD1 reject-A: the realpath/symlink-bin
   case must stay fixed).
3. Rewrite the call site (`cli.ts:495-500`) to feed globals in:
   ```ts
   if (entryShouldRun(process.argv[1], import.meta.url, isSea())) {
     main().catch((err) => {
       console.error(err);
       process.exit(1);
     });
   }
   ```
   Keep the explanatory comment block above it (updated to mention the SEA branch).

**RED-first test (D6a, AC1):** add a `describe("entryShouldRun", …)` block to
`test/cli.test.ts` importing `entryShouldRun` from `../src/cli.js`, asserting:
- `entryShouldRun(undefined, "file:///x", true) === true` (SEA true regardless of argv1);
- `entryShouldRun("/whatever", "file:///x", true) === true`;
- `isSea=false`, argv1 whose `pathToFileURL(realpathSync(argv1)).href` equals the passed
  `importMetaUrl` → `true` (use this test file's own realpath'd URL as both inputs);
- `isSea=false`, mismatched url → `false`;
- `isSea=false`, `argv1=undefined` → `false`;
- `isSea=false`, argv1 that makes `realpathSync` throw (a path that does not exist) →
  `false`.

Observe the new `describe` block fail (import of `entryShouldRun` is undefined) before
step 2 lands, then pass after. **Importing `entryShouldRun` must not launch the CLI** —
this is exactly the import-safety property the guard exists for; the existing subprocess
cli tests confirm the call site still fires for real entry.

**Surgical-change note:** do not touch any other part of `cli.ts`. The only orphan to
watch: `isEntryPoint` is renamed/inlined away — ensure no other reference remains
(`grep -n isEntryPoint src/cli.ts` → none after).

**`<ACCEPT-CMD>` (Phase 1):**
```
node --import tsx --test test/cli.test.ts   # AC1 + existing subprocess cli tests
npm run typecheck                            # node:sea import typechecks (src)
npm run typecheck:test                       # test file typechecks
npm test                                      # no regression vs baseline count
```
All exit 0; `npm test` count = baseline + the new `entryShouldRun` assertions.

---

## Phase 2 — `/library` extension (D4, D5, D6b)

**Scope:** new file `src/extensions/library.ts`; one line in `src/host.ts`
(`BUILTIN_EXTENSIONS`); new file `test/library.test.ts`. Traces to D4, D5, KDD4, KDD5,
KDD6, AC3, AC4, AC5, AC6.

**Deliverables:**

1. `src/extensions/library.ts` — default-export `activate(e: ExtensionAPI)`:
   - Kill switch: `const enabled = () => e.config.enabled("library", { default: true });`
     Each command handler returns early with a disabled note when `!enabled()`
     (mirrors `templates.ts:470/548`). `EAGENT_LIBRARY=off` resolves this off.
   - Source dir: `const librarySrc = () => e.config.string("library.dir") ?? join(process.cwd(), "library");`
     (env `EAGENT_LIBRARY_DIR` via `configEnvName`).
   - Kinds: `const KINDS = ["templates", "teams", "skills", "microagents"] as const;`
     (`prompts` excluded — reference-only, not a loaded tier; §KDD4).
   - `list`: for each kind, list `<librarySrc>/<kind>` **entries** via `readdirSync`
     (guarded by `existsSync`) and print `kind` + count + names. Count *entries*, not
     `*.md` — a `skills` entry is a **directory** (a skill bundle, e.g.
     `code-review-checklist/`), whereas templates/teams/microagents are flat `.md`
     files. If `librarySrc` absent, print a clean "no library found at <path>; set
     `library.dir`" (KDD5).
   - `install [--home|--project] [kind...]`:
     - Parse flags: `--home` → tier `"home"`, `--project` (default) → `"project"`.
       Remaining args = kind filter (default = all `KINDS`); reject unknown kinds with
       a usage line.
     - **Capability gate (KDD-G1):** before any write,
       `try { await e.agent.capabilities.require("fs:write", "library"); } catch (err) { if (err instanceof CapabilityError) { ctx.print(\`Cannot install: ${err.message}\`); return; } throw err; }`
       (verbatim shape of `session.ts:75-83`).
     - For each selected kind, resolve the target from
       `const dirs = resourceDirs(e.config, kind);` then
       `const target = tier === "home" ? dirs[0]! : (dirs[1] ?? dirs[0]!);`
       — `resourceDirs` never returns an empty array (always `[home, project]` or
       `[override]`), so the non-null `dirs[0]!` is sound and satisfies
       `noUncheckedIndexedAccess` (feeding a `string | undefined` `target` to
       `mkdirSync`/`join`/`cpSync` would otherwise fail the Phase 2 `typecheck` gate).
       When a `<kind>.dir` override collapses `dirs` to length 1, `dirs[1]` is
       `undefined` so `dirs[1] ?? dirs[0]!` is the sole entry and the `--home/--project`
       flag is a reported no-op (KDD4 target-derivation). This makes `microagents`'
       project target the workspace-rooted `<workspace>/.eagent/microagents` automatically.
     - Copy each `<librarySrc>/<kind>` **entry** into `target`, **per-entry
       skip-existing**: with `const kindDir = join(librarySrc(), kind);`,
       `mkdirSync(target, { recursive: true })`, then for each entry
       name from `readdirSync(kindDir)`,
       `if (existsSync(join(target, name))) { skipped++ } else { cpSync(join(kindDir, name), join(target, name), { recursive: true }); copied++ }`.
       `cpSync(..., { recursive: true })` copies **both** a flat `.md` file and a
       `skills/<bundle>/` directory (skills entries are directories — recursive is
       mandatory or `cpSync` throws on them). Skip-existing is per top-level entry name
       (KDD6 — never clobber). Print `kind: copied N, skipped (exists) M → <target>`.
   - Register via `e.registerCommand({ name: "library", description: "...", run })`.
     `run` may be `async` (the install path awaits `require`).
   - Grant nothing at activate time (unlike `session.ts` which pre-grants) — the
     command self-enforces `fs:write` per call so a deny-fallback manager blocks it
     (AC6). Do **not** call `e.grantCapability("fs:write")` (that would defeat AC6).
   - Top docstring: purpose, `EAGENT_LIBRARY=off`, the shipped-binary `library.dir`
     caveat (KDD5).
2. `src/host.ts` — append `library` to `BUILTIN_EXTENSIONS` (import + array entry),
   placed after `templates`/`skills`/`teams` so those kinds' helpers are loaded
   (order is not load-bearing here — `/library` reads dirs directly — but keep it
   grouped with the resource extensions).

**RED-first test (D6b):** `test/library.test.ts`, offline, MockProvider, with HOME and
cwd isolated to temp dirs (restore in `finally`). Assertions:
- **AC3:** temp `library.dir` holding `templates/foo.md`; `process.chdir(tempProject)`;
  run `/library install --project templates`; assert `foo.md` exists at
  `<tempProject>/.eagent/templates/foo.md`; then `/template list` (with
  `EAGENT_TEMPLATES_DIR` unset so the layered read applies) lists `foo`. **Derivation
  sub-assert:** set `EAGENT_WORKSPACE=<tempWs>` (≠ cwd), run
  `/library install --project microagents`, assert files land in
  `<tempWs>/.eagent/microagents`, not cwd.
- **AC4:** pre-create `<tempProject>/.eagent/templates/foo.md` with sentinel content;
  run install; assert the file's content is unchanged (not clobbered) and the report
  says skipped.
- **AC5:** HOME→tempH; `/library install --home templates`; assert copy into
  `<tempH>/.eagent/templates/`.
- **AC6:** `EAGENT_LIBRARY=off` → `/library` prints the disabled note, writes nothing.
  Separately, with a deny-fallback capability manager (no `fs:write` grant), assert
  `/library install` prints `Cannot install:` and writes nothing (the `require` throws
  `CapabilityError`). `/library list` lists kind counts.

Run the new test file, observe RED (module `../src/extensions/library.js` missing)
before deliverable 1, then GREEN.

**Test harness note:** drive commands through the host the same way existing extension
tests invoke a registered command (construct the host with MockProvider, look up the
`library` command in the command registry, call its `run(ctx)` with a `ctx.print`
collector). Reuse the *harness mechanism* from `test/session.test.ts` (the `/save`
command test) — build host, `h.commands.get(name)`, call `run({ agent, args, print })`.
**Caveat:** `session.test.ts` uses `makeHarness({ fallback: "allow" })` and `session.ts`
self-grants `fs:write`, so its `/save` tests only ever traverse the *granted* side of
`capabilities.require` — it is **not** a template for the AC6 *deny* path. For AC6 the
deny fixture is new: construct `makeHarness({ fallback: "deny" })` (supported by the
test helpers) and rely on `library.ts` deliberately **not** granting `fs:write`, so
`require("fs:write", "library")` throws `CapabilityError` and the handler prints
`Cannot install:` and writes nothing.

**`<ACCEPT-CMD>` (Phase 2):**
```
node --import tsx --test test/library.test.ts   # AC3–AC6
npm run typecheck                                # library.ts typechecks (src)
npm run typecheck:test                           # test file typechecks
npm test                                          # library registered, no regression
```
All exit 0.

---

## Phase 3 — build script + packaging + docs (D2, D3, D7)

**Scope:** new `scripts/build-binary.mjs`; `package.json` (`build:binary` script);
`.gitignore` (`bin/`); `README.md` ("Build a single binary" section + `/library` row
in the extension table). Traces to D2, D3, D7, KDD2, KDD3, R2, R5. AC2 (binary boots)
is a **documented one-time E2E smoke recorded at F**, not part of this phase's offline
gate.

**Deliverables:**

1. `scripts/build-binary.mjs` — Node ESM script (`#!/usr/bin/env node`) that runs the
   proven recipe with `execFileSync`/`spawnSync`, each step logged, non-zero exit on
   any failure:
   - `tsc` (via `npm run build`) → `dist/`.
   - `npx esbuild dist/cli.js --bundle --platform=node --format=cjs --target=node22
     --define:import.meta.url='"file:///eagent-sea.bin"' --outfile=<tmp>/eagent-bundle.cjs`
     (KDD2 — the `--define` prevents a CJS `import.meta` load-crash).
   - write `<tmp>/sea-config.json` (`{ "main": "<tmp>/eagent-bundle.cjs", "output":
     "<tmp>/eagent.blob", "disableExperimentalSEAWarning": true }`).
   - `node --experimental-sea-config <tmp>/sea-config.json`.
   - `mkdirSync("bin", { recursive: true })`; copy the running `node` to `bin/eagent`.
   - macOS-only (`process.platform === "darwin"`): `codesign --remove-signature bin/eagent`.
   - `npx postject bin/eagent NODE_SEA_BLOB <tmp>/eagent.blob --sentinel-fuse
     NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA`.
   - macOS-only: `codesign --sign - bin/eagent`.
   - Print the final path + `du -h bin/eagent`.
   Use `node:os.tmpdir()`/a scratch dir for intermediates; no reliance on
   `Date.now()`/random (deterministic temp subdir name is fine).
2. `package.json` — add `"build:binary": "node scripts/build-binary.mjs"` to `scripts`.
3. `.gitignore` — add `bin/` (the built binary is an artifact, KDD3).
4. `README.md` — a "Build a single binary" subsection: `npm run build:binary` →
   `bin/eagent`; note it targets the **host platform only** (R2); note `bun build
   --compile` / `deno compile` as cleaner ESM-native alternatives not adopted here
   (§3 no-new-tool); honestly state the shipped-binary `library.dir` caveat (KDD5/D7):
   a distributed binary has no `library/` beside it, so `/library install` is a
   repo/dev convenience unless `library.dir` points at a shipped copy. Add a `/library`
   row to the extension table (command + `fs:write` capability + one-line description).

**No new test** — this phase adds no offline-testable runtime behavior (the guard it
depends on is already pinned by Phase 1's AC1). Its correctness is `npm run build`
staying green plus the deferred AC2 smoke.

**`<ACCEPT-CMD>` (Phase 3):**
```
npm run build            # tsc still green (no src regression)
npm run typecheck        # src typechecks
npm test                 # full suite green (unchanged from Phase 2)
node -e "const p=require('./package.json'); if(!p.scripts['build:binary']) process.exit(1)"   # D3 script present
grep -qx 'bin/' .gitignore   # D3 gitignore present
node --check scripts/build-binary.mjs   # build script parses
```
All exit 0. **AC2 (binary boots)** is executed once at F:
`npm run build:binary && printf 'hi\n' | env -i HOME="$HOME" PATH="$PATH" bin/eagent -p mock`
→ boots, mock answers, no activation failures; evidence recorded in the F closeout
(skip-with-reason if `npx` network is unavailable, per R5).

---

## Cross-phase acceptance (run at F, before closeout)

- **AC7 (gates + no regression):** `npm test` (0), `npm run typecheck` (0),
  `npm run typecheck:test` (0), `npm run build` (0), `npm run eval` (5/5).
- **No `src/kernel/` change:** `git diff --name-only <base>..HEAD -- src/kernel/` empty
  (the kernel line-ceiling test in `test/kernel-surface.test.ts` also stays green).
- **AC2** recorded (above).

## Rollback

- **Phase 1:** revert `src/cli.ts` to the inline `isEntryPoint()` guard + drop the
  `entryShouldRun` test block. Independent of Phases 2–3.
- **Phase 2:** delete `src/extensions/library.ts`, remove the `BUILTIN_EXTENSIONS`
  entry, delete `test/library.test.ts`. Independent.
- **Phase 3:** delete `scripts/build-binary.mjs`, the `build:binary` script line, the
  `bin/` gitignore line, and the README section. Purely additive; no runtime impact.
- Branch `chore/packaging`, stacked on `chore/layered-resource-dirs`, PR-gated to
  `init`.

## Deferred / follow-ons (from design §3)

- `--force`/overwrite for `/library install` (KDD6 leaves skip-existing only).
- Cross-compilation matrix / multi-OS CI release workflow.
- `self-improve` template-asset bundling in the CJS binary (degradation accepted).
- Embedding `library/` in the binary (rejected — violates the split).
