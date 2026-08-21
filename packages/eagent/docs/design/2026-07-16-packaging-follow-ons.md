# Design — Packaging follow-ons: single-binary build + `/library install`

Slug: `2026-07-16-packaging-follow-ons`
Status: closed
Closing-commit: `e48c018` (phases 1-3; F end-to-end review clean, no fix)
Closed-on: 2026-07-16
Deferred: (1) full Windows packaging — the build script targets posix (macOS
proven, Linux via the same recipe minus codesign); the half-gesture `npx.cmd`
branch was dropped for honesty. (2) `--force`/overwrite for `/library install`
(skip-existing only, KDD6). (3) cross-compilation matrix / multi-OS CI release
(Node SEA builds one host target, §3). (4) `self-improve`'s template asset is inert
in the CJS binary (its `import.meta.url` path resolves to the `--define` stub);
bundling the asset is out of scope, activation still succeeds. (5) `server.ts:674`
uses a naive `file://${argv[1]}` entry guard rather than cli.ts's realpath form — a
pre-existing divergence this cycle did not touch (the binary compiles only
`dist/cli.js`, so only the CLI needs the SEA-aware guard). All non-blocking.

## 1. Background and Purpose

Two follow-ons complete the "immutable compiled engine + raw, opt-in resource
tree" split. Both are packaging; neither touches the kernel.

**A — a reproducible `npm run build:binary`.** EAgent already compiles to a single
standalone Node-SEA executable (proven this session: a ~115 MB arm64 binary that
boots all 64 extensions and runs offline). But the build was a hand-run recipe with
one wart: `src/cli.ts` runs `main()` at module top level guarded by `isEntryPoint()`
(`cli.ts:486-499`), which compares `import.meta.url` to `pathToFileURL(realpathSync(
process.argv[1]))`. In a SEA binary `process.argv[1]` is not a script path, so the
guard returns false and `main()` never fires — the prototype worked around it by
appending a `main()` call to the bundle. There is no committed way to build the
binary, and no clean fix for the guard.

**B — a `/library install` command.** The layered-resource cycle made `library/`
the *opt-in* official library: users enable it by copying `library/<kind>/*` into a
tier. That is documentation-only today — there is no command to do it. This closes
the opt-in loop.

If we do nothing: the binary stays a manual recipe with a guard workaround, and
opting into the official library stays a manual `cp`.

## 2. Deliverables

- [x] **D1 — SEA-aware entry guard (`src/cli.ts`)** — refactor `isEntryPoint()`
      into a **pure, exported, unit-testable** function
      `entryShouldRun(argv1: string | undefined, importMetaUrl: string, isSea: boolean): boolean`
      that returns `true` when `isSea` is true OR when
      `importMetaUrl === pathToFileURL(realpathSync(argv1)).href`. The call site
      passes `process.argv[1]`, `import.meta.url`, and `isSea()` (`import { isSea }
      from "node:sea"`). Preserves every current entry path (`npm run dev`, the
      installed bin, the subprocess cli tests) and additionally fires in a SEA
      binary — no bundle patch needed. Retains the current guard's `if (!argv1)
      return false` + `try/catch` around `realpathSync` (an `undefined` or
      unresolvable `argv1` returns `false`, never throws).
- [x] **D2 — `scripts/build-binary.mjs`** — a Node ESM build script implementing
      the proven recipe: `tsc` → `npx esbuild dist/cli.js --bundle --platform=node
      --format=cjs --target=node22 --define:import.meta.url='"file:///eagent-sea.bin"'`
      → `node --experimental-sea-config` → `cp $(node) bin/eagent` → `npx postject`
      inject → **macOS-only** `codesign` (guarded on `process.platform === "darwin"`;
      skipped on linux). Uses ONLY `npx` (esbuild/postject) — no committed npm
      dependency. Writes to `bin/eagent`.
- [x] **D3 — `npm run build:binary` + `.gitignore`** — add the `build:binary`
      script to `package.json` (`node scripts/build-binary.mjs`) and `bin/` to
      `.gitignore` (the built binary is an artifact, not committed).
- [x] **D4 — `/library` command (`src/extensions/library.ts`)** — a new extension
      registering `/library` with subcommands: `list` (show the official library's
      offerings per kind) and `install [--home|--project] [kind...]` (copy
      `<librarySrc>/<kind>/*` into a resource tier). `<librarySrc>` =
      `config.string("library.dir") ?? join(process.cwd(), "library")`. **The install
      target for each kind is derived from `resourceDirs(config, kind)`** (the shared
      helper) so it always equals a location the layered read actually scans:
      `--home` → the home entry (dirs[0]), `--project` (default) → the project entry
      (dirs[1]), and when a `<kind>.dir` override makes the kind single-source the
      target is that single dir (the `--home`/`--project` flag is a no-op, reported).
      This makes `microagents`' project tier correctly `<workspace>/.eagent/microagents`
      (not blindly cwd). Default kinds = **all** of
      `templates`/`teams`/`skills`/`microagents`. Before copying, the handler **must
      call `await e.agent.capabilities.require("fs:write", "library")`** — commands are
      NOT auto-gated like tools, so a command enforces capabilities itself (precedent:
      `session.ts:76`, the `/save` command). Kill switch `EAGENT_LIBRARY=off`.
      **Never overwrites** an existing same-named resource — reports copied vs
      skipped-existing.
- [x] **D5 — register** `library` in `BUILTIN_EXTENSIONS` (`src/host.ts`).
- [x] **D6 — tests** — (a) `test/cli.test.ts`: unit-test `entryShouldRun` across all
      branches (isSea true → true regardless of argv1; realpath match → true;
      mismatch/undefined argv1/throw → false). (b) `test/library.test.ts`
      (offline, MockProvider, temp `library.dir` + temp home/project tiers, HOME
      isolated): `install --project templates` copies into `<cwd>/.eagent/templates`
      and they load via the layered read; an existing same-named file is **not**
      clobbered (reported skipped); `install --home` targets `~/.eagent`;
      `EAGENT_LIBRARY=off` disables; `/library list` lists offerings. (c) The
      binary build is verified by a **documented one-time E2E smoke** (AC2), NOT a
      per-phase `npm test` gate — see §7.
- [x] **D7 — docs** — README "Build a single binary" section (`npm run build:binary`;
      per-platform-target caveat; `bun`/`deno --compile` noted as cleaner ESM-native
      alternatives); `/library` documented in the extension table. Honestly note the
      shipped-binary caveat (D-KDD5): a distributed binary has no `library/` beside
      it, so `/library install` is a repo/dev convenience unless `library.dir` points
      at a shipped copy.

## 3. Scope Boundary (NOT in scope)

- **No kernel change.** All work in `src/cli.ts` (host front-end), a new extension,
  a build script, `package.json`, `.gitignore`, README. Kernel ceiling untouched.
- **`build:binary` is NOT a `npm test` gate.** It needs `npx esbuild`/`postject`
  (a one-time network download) and produces a ~115 MB artifact — unsuitable as an
  offline CI unit gate. Its correctness = the offline `entryShouldRun` unit test +
  a documented one-time E2E smoke (AC2). The `cli.ts` guard IS unit-tested offline.
- **No `bun`/`deno` install.** Policy blocked installing bun this session; the docs
  recommend `bun build --compile` / `deno compile` as cleaner ESM-native options,
  but the committed build uses the no-new-tool Node-SEA path.
- **No cross-compilation matrix / CI release workflow.** Node SEA builds one target
  (the host platform); a multi-OS release matrix is a noted follow-on.
- **The binary does NOT bundle `library/`.** The binary is the engine; resources
  stay external raw files — the whole point of the split. `/library install`
  populates a tier from the raw `library/`, it does not embed it.
- **No `--force`/overwrite for `/library install`.** Skip-existing only (KDD6); a
  force flag is a follow-on.
- **`self-improve` template degradation is accepted, not fixed.** In the CJS bundle
  its source-relative `import.meta.url` template path resolves to the `--define`
  stub, so its template feature is inert in the binary (activation still succeeds).
  Documented; fixing it (bundling the asset) is out of scope.

## 4. Key Design Decisions

### KDD1 — SEA-aware guard as a pure injected function
- **Problem:** the current `isEntryPoint()` reads `process.argv[1]`/`import.meta.url`
  directly, so the `isSea()===true` branch cannot be unit-tested without building a
  binary, and the SEA fix must not break the three existing entry paths.
- **Options:** (A) add `|| isSea()` inline inside `isEntryPoint()` (reads globals —
  untestable true-SEA branch); (B) extract a pure
  `entryShouldRun(argv1, importMetaUrl, isSea)` the call site feeds globals into.
- **Choice: (B).** All four branches (SEA true; realpath match; mismatch; throw) are
  covered by a plain offline unit test with no binary. The realpath logic is
  preserved verbatim (the symlinked-bin case the current guard handles stays fixed).
  **Reject (A):** the load-bearing new branch (SEA) would ship untested — exactly
  what the prototype's bundle-patch hid.

### KDD2 — keep the `import.meta.url` `--define` in the CJS bundle
- **Problem:** now that the guard fires via `isSea()`, is the `--define:import.meta.url`
  still needed?
- **Choice: keep it.** The CJS bundle still contains other `import.meta.url` uses
  (`self-improve`'s template path, and the guard's own `import.meta.url` read on the
  non-SEA branch). Without the define, CJS `import.meta` is empty → `fileURLToPath("")`
  crashes at load. The define makes those resolve to a benign stub; `self-improve`'s
  template is then inert (activation still succeeds), the guard's SEA branch fires
  regardless. **Reject dropping it:** a load-time crash for one saved token.

### KDD3 — binary output at `bin/eagent`
- **Options:** (A) `bin/eagent` (new dir, add to `.gitignore`); (B) `dist/eagent`
  (`dist/` already gitignored).
- **Choice: (A).** `dist/` is the `tsc` output; mixing a 115 MB binary into it is
  confusing and risks `npm run build` cleanup semantics. `bin/` is the conventional
  home for an executable. **Reject (B):** overloads the compile-output dir.

### KDD4 — `/library install` defaults: project tier, all kinds
- **Options for target:** home (`~/.eagent`, global) vs project (`<cwd>/.eagent`,
  local). **Choice: project.** Installing into the project tier keeps the enabled
  resources scoped to the workspace you ran the command in (and, with the layered
  read, they win over home) — the least-surprising default for "enable the library
  here". `--home` opts into global. **Reject home-default:** silently populating the
  user's global tree from any cwd is more surprising.
- **Kinds default = all** (`templates`/`teams`/`skills`/`microagents`) — the whole
  library; a kind list narrows it. (`prompts` is reference-only, not a loaded tier —
  excluded.)
- **Target derivation (correctness):** the concrete target dir for each kind is taken
  from `resourceDirs(config, kind)` — `--home` = entry 0, `--project` = entry 1, a
  single-source `<kind>.dir` override = the sole entry — so the copied files always
  land where the layered read scans, including `microagents`' workspace-rooted
  project tier and any override. Blindly writing `<cwd>/.eagent/<kind>` would
  mis-install those cases.

### KDD5 — `library.dir` resolution + the shipped-binary caveat
- **Problem:** where is the official library's source? For the repo it is `<cwd>/library`.
  A *distributed* binary has no `library/` beside it.
- **Choice:** `config.string("library.dir") ?? join(process.cwd(), "library")`. For
  the repo/dev case this "just works". For a shipped binary, `/library install`
  errors cleanly ("no library found at <path>; set `library.dir`") unless the
  distributor ships a `library/` and sets `library.dir`. **This is a real limitation
  — documented honestly (D7), not over-claimed.** The alternative (embedding library/
  in the binary) is rejected in §3 — it violates the split.

### KDD6 — clobber policy: skip-existing + report
- **Options:** overwrite silently; skip-existing + report; add `--force`.
- **Choice: skip-existing + report.** Never destroy a user's edited resource; the
  command prints `copied: N, skipped (exists): M`. A `--force` is a follow-on (§3).
  **Reject silent overwrite:** data loss on a re-run.

## 5. Dependencies and Assumptions

- **`node:sea.isSea()`** — exported on Node ≥ 22 (verified on Node 24: `typeof
  isSea === "function"`, returns `false` outside SEA). Engine is `node >=22`.
  `@types/node` (^22) ships `sea.d.ts` (`declare module "node:sea"`;
  `function isSea(): boolean`), so `import { isSea } from "node:sea"` typechecks
  under strict TS — no shim needed (closes the AC7 typecheck dependency).
- **The proven build recipe** — verbatim this session: esbuild CJS bundle (852 KB)
  + `--define:import.meta.url` → `sea-config.json` → `node --experimental-sea-config`
  → `cp node` → `postject` with fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
  + `--macho-segment-name NODE_SEA` → macOS `codesign --remove-signature` /
  `--sign -`. Produced a runnable 115 MB arm64 binary; all 64 extensions activated.
- **`npx esbuild`/`postject`** are transient (downloaded on first run), NOT
  `package.json` deps — preserving "zero runtime deps except jiti".
- **Current `cli.ts` guard** (verbatim `cli.ts:486-499`): `isEntryPoint()` +
  `if (isEntryPoint()) main().catch(...)`.
- **Command/kill-switch + capability pattern** — `config-cmd.ts:40`
  `e.registerCommand({...})` with an `EAGENT_<NAME>=off` gate. **Commands are NOT
  auto-gated** (the `Command`/`CommandContext` interface has no `capabilities` field,
  unlike tools which are auto-enforced at `agent.ts:523`); a command enforces a
  capability by calling `await e.agent.capabilities.require("fs:write", "library")`
  itself — precedent `session.ts:76` (`/save` gates `fs:write` exactly this way).
- **The stacked layered-resource model** — `library/` is opt-in; resources read
  layered home+project (from `chore/layered-resource-dirs`, this branch's base). So
  a `/library install`-copied resource loads via the layered read (AC4).
- **`fs` for copy** — `node:fs` `cpSync`/`readdirSync`/`existsSync`; skip-existing
  is a per-file `existsSync` check before copy.
- **Measured baseline:** `npm test`, `typecheck`, `typecheck:test`, `eval`, `build`
  green (confirmed at closeout: 1470 pass / 0 fail / 1 skip, eval 5/5, AC2 binary
  boot proven — 115 MB, all 65 extensions incl. `library` load).

## 6. Relationship with Existing Designs

- `docs/design/2026-07-16-layered-resource-dirs.md` (this branch's base) — made
  `library/` opt-in; `/library install` (D4) is the automation of that doc's
  "copy into a tier" opt-in step. No conflict; direct continuation.
- `docs/design/2026-07-15-silent-truncation-fix.md` — added the `isEntryPoint()`
  guard + `wireRendering` export (for import-safety). D1 refactors that guard to be
  SEA-aware + testable; it preserves the import-safety behavior. Reaffirms, no
  conflict.
- No prior design covers packaging/SEA. Terminology anchors: CLAUDE.md + README.

## 7. Acceptance Criteria (measurable / automatable)

- **AC1 (guard unit — offline):** `entryShouldRun(undefined, url, true) === true`;
  `entryShouldRun("/x", url, true) === true`; with `isSea=false`,
  `entryShouldRun(<path whose realpath's file URL === importMetaUrl>, importMetaUrl,
  false) === true` and a mismatch/undefined/throw → `false`. RED before D1. Command:
  `node --import tsx --test test/cli.test.ts`.
- **AC2 (binary boots — documented one-time E2E smoke, not a `npm test` gate):**
  `npm run build:binary` produces `bin/eagent`; run it in a clean env
  (`env -i HOME=$HOME bin/eagent -p mock` piped a prompt) and it boots + the mock
  answers, with no activation failures. Evidence recorded in the F closeout (needs
  `npx` network + ~115 MB; run manually/CI, not per-phase).
- **AC3 (`/library install --project` — offline):** with a temp `library.dir`
  holding `templates/foo.md` and a temp project cwd (the test `process.chdir`s into
  the temp project dir, restored in `finally` — the templates/teams/skills project
  root is `process.cwd()`), `/library install --project
  templates` copies `foo.md` into `<cwd>/.eagent/templates/`, and `/template list`
  then lists `foo` (loads via the layered read). **Also assert the target is derived
  from `resourceDirs`:** with `EAGENT_WORKSPACE` set to a temp dir ≠ cwd,
  `install --project microagents` writes into `<workspace>/.eagent/microagents` (the
  microagents read root), not cwd. RED before D4. Command:
  `node --import tsx --test test/library.test.ts`.
- **AC4 (skip-existing — offline):** a pre-existing `<cwd>/.eagent/templates/foo.md`
  is NOT overwritten by `install`; the result reports it skipped (`skipped (exists)`).
- **AC5 (`--home` targets home — offline):** with HOME→tempH, `install --home
  templates` copies into `tempH/.eagent/templates/`.
- **AC6 (`/library list` + kill switch + capability):** `/library list` lists the
  kinds/counts; `EAGENT_LIBRARY=off` makes `/library` inert; the handler calls
  `e.agent.capabilities.require("fs:write", "library")` before copying, so under a
  deny-fallback capability manager the install is blocked/errors (assert it).
- **AC7 (gates + no regression):** `npm test` exits 0 (all prior tests pass, incl.
  the existing `cli.test.ts` subprocess tests — the guard refactor preserves them);
  `typecheck`, `typecheck:test`, `build` exit 0; `eval` 5/5; no `src/kernel/` change.

## 8. Risks and Rollback

- **R1 — the guard refactor breaks the CLI / subprocess cli tests.** `main()` must
  still run when `argv1` is `cli.ts`/`dist/cli.js` (npm run dev, subprocess tests).
  Mitigated: `entryShouldRun` keeps the realpath branch verbatim; `isSea` is purely
  additive (false outside a binary). AC1 + the existing `test/cli.test.ts`
  subprocess tests pin it. Rollback: revert `cli.ts` to the inline guard.
- **R2 — `build:binary` is platform-specific.** macOS `codesign` steps are guarded
  on `darwin`; linux skips them. The binary targets the host platform only
  (documented). Rollback: delete `scripts/build-binary.mjs` + the script/gitignore
  lines.
- **R3 — `/library install` clobbers a user's edited resource.** Mitigated by
  skip-existing (KDD6) + AC4. Rollback: disable via `EAGENT_LIBRARY=off` or revert D4.
- **R4 — shipped-binary `library.dir` confusion.** `/library install` errors cleanly
  when no library source is found; the limitation is documented (KDD5/D7). Rollback:
  n/a (doc-level).
- **R5 — `build:binary` E2E smoke needs network (`npx`) + is heavy.** Kept OUT of the
  `npm test` gate (§3); run manually/at F. If `npx` is unavailable the smoke is
  recorded skipped with a reason; the guard unit test still gates the functional part.
- **Overall rollback:** D1 (cli.ts) and D4/D5 (extension) are independently
  revertible; D2/D3 (build script + package.json/gitignore) are additive packaging.
  Branch `chore/packaging`, stacked on `chore/layered-resource-dirs`, PR-gated.
