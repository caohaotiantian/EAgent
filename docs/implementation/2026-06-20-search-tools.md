# Implementation: dedicated `glob` / `grep` search tools

Slug: `2026-06-20-search-tools`
Design doc: `docs/design/2026-06-20-search-tools.md`

## 1. Task Index

| Design Deliverable (§2) | Design Acceptance Criterion (§7) | Phase |
| --- | --- | --- |
| `src/extensions/search.ts` — glob + grep tools | 1–9 | P1 |
| `test/search.test.ts` — offline tests | 2–9 | P1 |
| `src/host.ts` — register `search` in BUILTIN_EXTENSIONS | 10 | P1 |
| `CLAUDE.md` — inventory line | (doc only) | P1 |

Design Key Design Decisions: D1 (new extension), D2 (fs:read + parallel),
D3 (pure-Node walk + sep()-aware confine + symlink-skip), D4 (default-ignore
during descent), D5 (global 100-cap + short-circuit), D6 (`*`/`**`/`?` glob
translator, `**/` = zero-or-more leading segments).

## 2. Phase Breakdown

One new extension + its test + two small wiring edits; `npm test` green at the
end. **One Phase**, strict TDD order.

### Phase 1 — the `search` extension

**Entry condition:** baseline green — `npm test` `# fail 0` (284 pass on this
branch), `npm run typecheck` exit 0, clean tree.

**Design references:** `docs/design/2026-06-20-search-tools.md` §2, §4 D1–D6,
§7 AC 1–10, §8 R1–R3.

**Task list (TDD order — test tasks first):**

- **T1 (test): glob + confinement + ignore + symlink** in `test/search.test.ts`.
  Set `process.env.EAGENT_WORKSPACE` to a fresh `mkdtemp` dir (restore in
  `finally`), populate fixtures (`a.ts`, `src/b.ts`, `src/c/d.ts`,
  `notes.md`, `node_modules/x.ts`, `.git/y.ts`), register the extension via
  `h.host.use("search", search)`, and call the `glob` tool through the registry
  (`h.agent.tools.get("glob")!.execute({pattern}, ctx)` — build a minimal `ctx`
  with `require: async()=>{}`, `signal`, etc., or invoke through the agent). Each
  asserts a business invariant (*glob returns the right root-relative paths,
  confined, ignoring noise dirs, never following symlinks*):
  - AC-2: `glob("**/*.ts")` returns `a.ts`, `src/b.ts`, `src/c/d.ts` (sorted,
    root-relative); `glob("src/**/*.ts")` returns the two under `src/`, not `a.ts`
    (pins the `**/` zero-segment rule via the first case and the prefix rule via
    the second).
  - AC-8 (default-ignore): `node_modules/x.ts` and `.git/y.ts` are **not** in
    `glob("**/*.ts")` output.
  - AC-5(a) (confine): `glob("*", "../")` (path escaping root) returns an error
    result (`isError`), reads nothing outside root.
  - AC-5(b) (symlink): create an in-root symlink (`fs.symlinkSync`) to an
    out-of-root dir/file; assert `glob("**/*")` does not include the link target.
  Watch fail (module absent).

- **T2 (impl): the walk, the glob translator, and the `glob` tool** in
  `src/extensions/search.ts`. `export default function activate(e)`:
  `e.grantCapability("fs:read")` is already done by core-tools, but the search
  tools just declare `capabilities:["fs:read"]`. Implement:
  - `workspaceRoot()` = `process.env.EAGENT_WORKSPACE ? resolve(it) : cwd()` and
    a local `confine(root, p)` copying `core-tools.ts:31-38` **including** the
    `sep()`-aware boundary (`..${sep()}`) — not a hardcoded `"../"` (D3).
  - `globToRegExp(pattern)`: first escape regex metacharacters — note this turns
    the glob's own `*`/`?` into `\*`/`\?`, so the translation step targets the
    **escaped forms**: `\*\*/` → `(?:.*/)?` (zero or more leading segments),
    `\*\*` → `.*`, `\*` → `[^/]*`, `\?` → `[^/]`, anchored `^...$` (D6), applied in
    that priority order (the `**/` rule first). (Equivalently, scan the raw glob
    left-to-right emitting escaped literals and the above translations — either
    approach is fine as long as `**/` is handled before `**`/`*`.) Match against
    the **POSIX** root-relative path (replace `\\`→`/` on win32).
  - `walk(dir, root, onFile, shouldStop)`: `readdirSync(dir,{withFileTypes:true})`,
    **sorted by name** for a deterministic, platform-stable traversal order (this
    is what makes the AC-9b sentinel "reached only after the cap" reliable); for
    each `Dirent`: **skip if `isSymbolicLink()`** (D3/§3); skip directories named
    `.git`/`node_modules` (D4, applied to descent — the root itself is always
    entered); recurse into dirs, call `onFile(relPath)` for files; stop early when
    `shouldStop()` (D5). Each fs op wrapped so one unreadable entry can't abort
    the walk.
  - The `glob` tool (`defineTool`, `capabilities:["fs:read"]`,
    `executionMode:"parallel"`, params `{pattern, path?}`): resolve+confine the
    optional `path` (default root), walk collecting root-relative POSIX paths
    matching `globToRegExp(pattern)`, cap at **100** (short-circuit), sort,
    return them joined by `\n` with a truncation marker if capped; `fail(...)` on
    a confine error. Make T1 green.

- **T3 (test): grep + include + caps + binary** in `test/search.test.ts`:
  - AC-3: a file with `needle` on a known line → `grep("needle")` returns a
    result naming the file, the 1-based line number, and the line text.
  - AC-4 (include): `grep("needle", undefined, "*.md")` searches only `.md`
    files (a `.ts` file with `needle` is not reported).
  - AC-6 (no shell:exec) — **must run through the agent loop**, not a direct
    `execute()` (a hand-built `ctx.require` stub bypasses the dispatcher's
    capability check at `agent.ts:331-332`, making a direct-execute AC-6 vacuous).
    Use `makeHarness({fallback:"deny"})`, load **both** `core-tools` (whose
    activation calls `e.grantCapability("fs:read")`, `core-tools.ts:45`) **and**
    `search`, and a `MockProvider` responder scripting a `grep` (or `glob`) call
    (the `flow-guard.test.ts:36-54` pattern). Assert the tool **executed** (its
    result appears, not a "blocked"/capability-denied error): `fs:read` is granted
    so the `require("fs:read")` at dispatch passes, while `shell:exec` is denied
    by `fallback:"deny"` and is never requested — proving the search tools need
    only `fs:read`.
  - AC-7 (metadata): `h.agent.tools.get("grep")!.executionMode === "parallel"`
    and `.capabilities` deep-equal `["fs:read"]`; same for `glob`.
  - AC-9(b) (grep cap + short-circuit): create >100 matching lines plus a
    **sentinel** file (with a distinguishable match) that the walk reaches only
    after the cap; assert the result has 100 lines + a marker and the sentinel
    match is **absent** (proving short-circuit).
  - binary guard (R3): a file whose first bytes contain a NUL is skipped by grep.
  Watch the grep-specific ones fail (grep not implemented).

- **T4 (impl): the `grep` tool** in `src/extensions/search.ts`
  (`capabilities:["fs:read"]`, `executionMode:"parallel"`, params
  `{pattern, path?, include?}`): compile `new RegExp(pattern)` (`fail` on a bad
  regex); walk from the confined root; for each file, if `include` is set skip
  unless its relative path matches `globToRegExp(include)`; **sniff the first
  ~8 KB for a NUL byte and skip binaries** (R3); read UTF-8, scan lines, push
  `relPath:lineNo:lineText` for each regex match; cap at **100** matches globally
  and **short-circuit** the walk on reaching it (D5); return joined results with a
  truncation marker if capped. Make T3 green.

- **T5 (impl): wire + docs.** In `src/host.ts` add `import search from
  "./extensions/search.js";` and a `["search", search]` entry in
  `BUILTIN_EXTENSIONS` (near the other tool extensions, e.g. after `core-tools`).
  Add a one-line `search` entry to the extension inventory in `CLAUDE.md`
  describing the `fs:read`, parallel glob/grep tools. Run the full suite.

**Per-task acceptance commands** (repo root):

- T1–T4: `node --import tsx --test test/search.test.ts` — all subtests pass.
- T5 + Phase exit: `node --import tsx --test test/host.test.ts` (builtin set
  loads with `search`) **and** `npm run typecheck` exit 0 **and** `npm test`
  (`node --import tsx --test "test/**/*.test.ts"`) `# fail 0`.

**Exit condition:** typecheck 0; `npm test` `# fail 0` (≥ 284 prior + new
subtests); design AC 1–10 each map to a passing assertion.

## 3. Engineering Constraints Index

- **Project norms** — `CLAUDE.md` House conventions: ESM `.js` specifiers, strict
  TS (`noUncheckedIndexedAccess` — guard `readdirSync` entry/array indexing), no
  `any`, zero deps except `jiti` (Node `fs`/`path` only). Every extension is
  capability-gated with an offline test; mirror `core-tools` for `defineTool`,
  `ok`/`fail`, and the confine logic.
- **Four-corner template** — `references/loop-3-development.md`.
- **Commit conventions** — `feat(phase1): …`; `fix(phase1-roundR): <keyword>`;
  `npm test`/typecheck trailers; no AI/model/tooling mention.

## 4. Data and Fixture Dependencies

- **Reused:** `test/helpers.ts` `makeHarness`; `defineTool`/`ok`/`fail` from
  `src/kernel/define.js`; the registry (`h.agent.tools.get(name)`). No network.
- **New:** `test/search.test.ts`; all fixtures created **by the tests** under
  `mkdtemp` workspaces (set via `EAGENT_WORKSPACE`, restored in `finally`), incl.
  `fs.symlinkSync` for AC-5(b) and a NUL-containing file for the binary guard. No
  committed fixtures.

## 5. Regression Protection

- Full `npm test` stays `# fail 0`. In particular `test/host.test.ts` (the
  builtin set now includes `search`), and **no existing extension changes** —
  `core-tools`, `bash-policy`, `flow-guard` are untouched (design §3); `bash`
  search still works. `npm run typecheck` stays clean.
- Only `src/extensions/search.ts` (new), `test/search.test.ts` (new), the two
  additive lines in `src/host.ts`, and the one-line `CLAUDE.md` inventory change.
  No kernel change; the `ToolSpec`/dispatch contract is unchanged (the tools use
  the standard `defineTool` surface with `executionMode:"parallel"`, already a
  supported value per `define.ts:15`).
