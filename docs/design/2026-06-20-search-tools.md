# Design: dedicated `glob` / `grep` search tools (fs:read, parallel)

Status: closed
Closing-commit: 8454798
Closed-on: 2026-06-20
Deferred: none (closeout finding "grep symlink-skip tested only via glob" was
fixed in the closeout round; the "grep `include` matches the full relative path,
not basename" behavior is by-design per D6 — an `include:"*.md"` matches root-
level `.md` files, `**/*.md` matches nested ones — recorded, not a defect)
Slug: `2026-06-20-search-tools`

## 1. Background and Purpose

To find a file by name or a string in the codebase, an EAgent agent today has
exactly one option: shell out via the `bash` tool (`grep`, `find`, `ls`). But
`bash` declares the `shell:exec` capability — the most dangerous one in the
kernel (`core-tools.ts:201`: "equivalent to full host filesystem access") — and
it is `executionMode: "sequential"`. So a read-only search forces the agent to
(a) acquire `shell:exec` (which `bash-policy` gates and `flow-guard` treats as a
session-tainting *source* capability), and (b) serialize, because the dispatcher
cannot tell a parallel-safe `grep` from a parallel-unsafe `git push` when both
arrive as opaque command strings.

The upstream project [opencode](https://github.com/anomalyco/opencode) ships
**dedicated `glob` and `grep` tools** (`packages/opencode/src/tool/glob.ts`,
`grep.ts`) precisely so search is not a shell call. The Anthropic agent-design
guidance states the same principle: "Read-only tools like `glob` and `grep` can
be marked parallel-safe. When the same actions run through bash, the harness
can't tell a parallel-safe `grep` from a parallel-unsafe `git push`, so it must
serialize. … Promote to dedicated tools when you need to gate, render, audit, or
parallelize the action."

This task digests that into EAgent as a small `search` extension with two tools:

- **`glob`** — match files by glob pattern (e.g. `src/**/*.ts`), confined to the
  workspace root.
- **`grep`** — search file contents by regex, with an optional `include` glob
  filter, confined to the workspace root.

Both declare only **`fs:read`** (already auto-granted by `core-tools`) and run
**`executionMode: "parallel"`**. The payoff is exactly the two problems above:
the agent searches without ever touching `shell:exec` — so it avoids the
**unconditional source-capability taint** `flow-guard` applies to *every*
`shell:exec` call, and avoids any `bash-policy` prompt, for a benign search — and
independent searches run concurrently. (As with the existing `read` tool,
`flow-guard`'s *data-confinement* taint still applies if a search result's
content or path matches a sensitive pattern — that is information-flow, not
capability, and is the intended behavior; see D2.) Implementation is pure Node
(`fs`) — **no ripgrep binary and no shell**, keeping the zero-dependency rule and
the no-`shell:exec` property.

If we do not do this, every search remains a privileged, serialized shell call —
the agent must hold a dangerous capability and pay sequential latency for a
read-only operation.

## 2. Deliverables

- [x] `src/extensions/search.ts` — a `search` extension registering two
      `fs:read`, `executionMode:"parallel"` tools: `glob(pattern, path?)` and
      `grep(pattern, path?, include?)`. Pure-Node recursive walk confined to the
      workspace root, with a default-ignore set, result limits, and truncation
      markers.
- [x] `test/search.test.ts` — offline tests: glob matches by pattern; grep finds
      content with `file:line`; the `include` filter scopes grep; both confine to
      the workspace root (reject `../` escapes); both need only `fs:read` (work
      with `shell:exec` denied); default-ignore skips `node_modules`/`.git`;
      result limits truncate with a marker.
- [x] `src/host.ts` — register `search` in `BUILTIN_EXTENSIONS`.
- [x] `CLAUDE.md` — add a one-line `search` entry to the extension inventory.

## 3. Scope Boundary (NOT in scope)

- **No ripgrep / external binary / shell.** Pure Node `fs` only; the whole point
  is that search needs no `shell:exec`. (opencode shells out to ripgrep; EAgent
  cannot, and must not, for this property.)
- **No `.gitignore` parsing.** A small hardcoded default-ignore set (`.git`,
  `node_modules`) is skipped; full gitignore semantics are out of scope (a
  possible future enhancement, noted in Risks).
- **No replacement of `bash`.** `bash` stays; `glob`/`grep` are *additional*
  safer/faster paths for the read-only subset. Nothing about `core-tools`,
  `bash-policy`, or `flow-guard` changes.
- **No content rewriting / editing.** These are strictly read-only search tools.
- **No regex flavor beyond JS `RegExp`.** `grep`'s pattern is a JS regex; `glob`
  supports `*`, `**`, `?` translated to a regex. No PCRE, no ripgrep flags.
- **No symlink following at all.** The recursive walk **skips symbolic links**
  (it does not descend symlinked directories and does not read symlinked files),
  using `Dirent.isSymbolicLink()`. This is the mechanism that actually prevents a
  symlink *inside* the root from escaping *outside* it — the lexical `confine`
  check below cannot, since it does not resolve link targets. (The existing
  `read` tool follows symlinks lexically; `search` is deliberately stricter
  because a recursive walk amplifies the escape risk.)

## 4. Key Design Decisions

### D1. A new `search` extension, not additions to `core-tools`

- **Problem:** Where do the search tools live?
- **Options:** (a) add `glob`/`grep` to `core-tools.ts` (the four builtins);
  (b) a new `search` extension.
- **Choice:** (b).
- **Rationale:** CLAUDE.md frames `core-tools` as exactly "the four built-in
  tools — read, write, edit, bash". Search is a separable concern with its own
  tests and its own (parallel, read-only) execution profile; a dedicated
  extension keeps `core-tools` minimal and lets a host drop search independently.
  Rejected (a) to avoid swelling the canonical four-builtins file and conflating
  concerns.

### D2. `fs:read` capability + `executionMode: "parallel"` — the whole point

- **Problem:** What authority and execution profile should search declare?
- **Choice:** `capabilities: ["fs:read"]` and `executionMode: "parallel"`.
- **Rationale:** This is the dual win the task exists for. `fs:read` is
  auto-granted by `core-tools` (`core-tools.ts:45`) and is *not* a `flow-guard`
  **source** capability (default `shell:exec`, `flow-guard.ts:34`), so searching
  never incurs the unconditional source-taint a `shell:exec` `grep` does, and
  never trips `bash-policy`. (`flow-guard`'s *data-confinement* path
  (`flow-guard.ts:128-156`) still tags a result that reads a sensitive path or
  whose content matches a credential pattern — identical to the existing `read`
  tool, and the correct information-flow behavior; this task neither adds nor
  removes that.) `parallel` (the kernel's read-safe mode,
  contrasted with `bash`'s `sequential` at `core-tools.ts:204`) lets independent
  searches interleave — exactly the agent-design rationale for promoting
  read-only actions out of bash. Rejected `shell:exec`/`sequential`: that would
  reproduce the very problem being solved.

### D3. Pure-Node recursive walk confined to the workspace root

- **Problem:** How to enumerate/search files safely without a binary?
- **Choice:** A `readdirSync(..., {withFileTypes:true})` recursive walk rooted at
  `workspaceRoot()` (`$EAGENT_WORKSPACE ?? process.cwd()`, matching
  `core-tools.ts:22-24`), with the **same `confine`-style check** `core-tools`
  uses (`core-tools.ts:31-38`) applied to any caller-supplied `path` so it cannot
  lexically escape the root. The reimplemented `confine` must copy the
  **`sep()`-aware** boundary check (`core-tools.ts:34,40-42`) — `relative()`
  yields OS-native separators, so a hardcoded `"../"` would let `..\foo` slip
  through on win32. The walk additionally **skips symlinks** (§3), which is the
  real escape guard since lexical confine does not resolve link targets. `grep`
  reads each candidate file as UTF-8 and scans lines.
- **Rationale:** Re-uses EAgent's existing confinement invariant (the `read`
  tool's root) so the search tools have exactly the read scope `fs:read` already
  implies — no broader. Pure `fs` keeps the zero-dependency rule and the
  no-shell property. Because `confine`/`workspaceRoot` are not exported from
  `core-tools`, the extension reimplements the same small logic locally (an
  intentional, noted duplication — like `bash-policy`'s own wildcard matcher).

### D4. Default-ignore set; no gitignore

- **Problem:** A naive walk descends into `node_modules`/`.git`, which is slow
  and floods results.
- **Options:** (a) walk everything; (b) hardcoded default-ignore set; (c) full
  `.gitignore` parsing.
- **Choice:** (b) — skip directory entries named `.git` and `node_modules`
  encountered **during descent**. The skip applies to *child* entries the walk
  steps into; the **search root itself is always searched** (so an agent that
  explicitly passes `path:"node_modules/foo"` does get `foo` searched — the
  default-ignore governs recursion, not an explicit target).
- **Rationale:** (a) is unusable on any real repo (10⁵ files under
  `node_modules`). (c) is a meaningfully larger feature (parsing/merging nested
  `.gitignore`s) for marginal additional benefit on top of the two dirs that
  cause >99% of the noise. (b) is the Simplicity-First middle ground and matches
  the practical default of every code-search tool. The skip set is a small
  module constant; broadening it is a future change, not this task.

### D5. Result limits with explicit truncation markers

- **Problem:** A broad pattern can return thousands of paths/lines and blow the
  context window.
- **Choice:** `glob` caps at **100 files** (matching opencode `glob.ts:49`);
  `grep` caps at **100 matching lines** as a **single global result-count cap**
  across the whole result set (not per-file). Both **short-circuit the walk** the
  moment the cap is reached — `grep` stops scanning further files/lines once it
  has 100 matches (bounding latency, not just output). On hitting the cap,
  results stop and a trailing marker line states the cap was hit and suggests
  narrowing.
- **Rationale:** Bounded output is mandatory for a context-window-sensitive
  agent; opencode uses the same 100-file glob cap. The markers keep the
  truncation observable (the agent learns to narrow), mirroring opencode's
  truncation hint. (The `limits` extension's `afterToolCall` byte cap still
  applies as a backstop, but per-tool semantic caps give better output.)

### D6. Glob semantics: `*`, `**`, `?` → anchored regex

- **Problem:** What does a glob pattern mean?
- **Choice:** `**` matches any path span (including `/` and the empty span); `*`
  matches any run of non-`/` characters; `?` matches one non-`/` character; every
  other character is matched literally (regex metacharacters escaped). Critically,
  a leading **`**/` matches zero or more leading path segments** (translated so
  the `/` after `**` is optional), so `glob("**/*.ts")` matches a root-level
  `a.ts` as well as `src/b.ts` — the single most common glob-translator bug,
  pinned by acceptance criterion 2. The translated regex is anchored full-match
  against the **root-relative POSIX path** (separators normalized to `/`).
  `grep`'s `include` uses the same translator against each file's relative path.
- **Rationale:** This is the conventional glob subset every coding agent expects
  (`src/**/*.ts`), implemented as a small deterministic translator (no glob
  library — zero-dependency rule). Anchoring full-match avoids accidental
  substring matches. Matching against the POSIX relative path makes patterns
  portable and platform-independent. No `{a,b}` brace expansion (out of scope,
  §3) — keeps the translator minimal.

## 5. Dependencies and Assumptions

- **`ExtensionAPI`**: `e.registerTool`, `e.grantCapability` — already used by
  `core-tools`. Tools are registered with `capabilities:["fs:read"]` and
  `executionMode:"parallel"` via `defineTool` (`src/kernel/define.js`), the same
  helper every tool uses.
- **Capability enforcement**: the dispatcher calls `capabilities.require("fs:read",
  …)` before `execute` (`agent.ts:331-332`); `fs:read` is auto-granted by
  `core-tools` activation, so search works out of the box and is *independent of*
  `shell:exec`.
- **Workspace root**: `$EAGENT_WORKSPACE ?? process.cwd()` (as `core-tools`);
  confine logic reimplemented locally.
- **Node `fs`/`path`** stdlib only — no npm dependency.
- **Test harness**: `makeHarness` + a `mkdtemp` workspace (set `EAGENT_WORKSPACE`)
  populated with fixture files; tools invoked directly via the registry. Offline.

## 6. Relationship with Existing Designs

- **Composes with** the `bash-policy` and `flow-guard` work
  (`docs/design/2026-06-20-bash-policy.md`): by giving the agent an `fs:read`
  search path, this task *reduces* how often the agent needs `shell:exec` at all,
  so those guards fire less and `flow-guard` taints fewer sessions. No shared
  state; purely complementary. No supersession.
- **Mirrors `core-tools`** for the workspace-root confinement invariant
  (`core-tools.ts:21-37`), intentionally duplicating the small `workspaceRoot`/
  `confine` logic because it is not exported (noted so a reviewer does not flag
  it as missed reuse — same posture as `bash-policy`'s local wildcard matcher).
- Terminology anchor: CLAUDE.md ("everything is an extension"; "capabilities are
  the security vocabulary"; the four builtins are read/write/edit/bash).

## 7. Acceptance Criteria

Verified by `npm test` (offline) and `npm run typecheck` (exit 0). Tests use a
`mkdtemp` workspace set via `EAGENT_WORKSPACE`, restored in `finally`.

1. **Typecheck clean:** `npm run typecheck` exits 0 (walk indexing guarded).
2. **glob matches by pattern:** with fixture files `a.ts`, `src/b.ts`,
   `src/c/d.ts`, `glob("**/*.ts")` returns all three (root-relative paths,
   sorted), and `glob("src/**/*.ts")` returns the two under `src/` and not
   `a.ts`.
3. **grep finds content with location:** with a file containing `needle` on a
   known line, `grep("needle")` returns a result naming that file and line number
   and the matching line text.
4. **grep `include` filter:** `grep("needle", undefined, "*.md")` searches only
   `.md` files (a `.ts` file containing `needle` is not reported).
5. **Confinement:** (a) `glob`/`grep` with a `path` argument that resolves
   outside the workspace root (e.g. `"../"`) returns an error and reads nothing
   outside the root; (b) an in-root **symlink** pointing at an out-of-root file
   or directory is **not** followed — `glob("**/*")` does not return the link
   target and `grep` does not read through it (skipped via
   `Dirent.isSymbolicLink()`).
6. **No `shell:exec` needed:** with capability fallback `deny` and `shell:exec`
   explicitly denied but `fs:read` granted, `glob`/`grep` still execute
   successfully (proving they need only `fs:read`).
7. **Parallel + read-only metadata:** the registered `glob`/`grep` tools report
   `executionMode === "parallel"` and `capabilities` deep-equal `["fs:read"]`
   (no `shell:exec`).
8. **Default-ignore:** a fixture `node_modules/x.ts` and `.git/y.ts` are **not**
   returned by `glob("**/*.ts")`, while sibling source files are.
9. **Truncation (global cap + short-circuit):** (a) `glob` over >100 matching
   files returns exactly 100 paths and a trailing marker mentioning the limit;
   (b) `grep` whose matches exceed 100 returns exactly 100 result lines and a
   marker, and **short-circuits** — verified by placing the 101st+ match in files
   the walk would reach only after the cap and asserting they are not opened
   (e.g. via a sentinel: a file that, if read, would add a distinguishable match
   that must be absent from the capped output).
10. **Regression:** `npm test` reports `# fail 0` (≥ 284 prior tests plus the new
    subtests); existing extensions and the host builtin-set load test pass.

No latency budget declared: a bounded walk + per-file scan over a workspace is
the inherent cost of search and runs off the model hot path; excluded per the
Scope Boundary.

## 8. Risks and Rollback

- **R1 — Large/deep trees without gitignore.** Beyond `node_modules`/`.git`, a
  repo could hold other large generated dirs the walk still descends.
  *Mitigation:* the 100-result caps bound *output*; the walk itself is the
  unavoidable cost of search and is off the hot path. Full gitignore support is a
  documented future enhancement (§3), not required for correctness.
- **R2 — Symlink / path-escape.** A `path` arg or an in-root symlink could try to
  read outside the root. *Mitigation:* two layers — (1) the lexical `confine`
  check (with the `sep()`-aware boundary, D3) rejects a `path` arg that resolves
  outside the root; (2) the walk **skips symlinks entirely** (§3/D3), closing the
  gap that lexical confine alone leaves (an in-root link to an out-of-root
  target). The tools only ever declare `fs:read` — never broader than the
  existing `read` tool.
- **R3 — Binary files in grep.** Scanning a binary file as UTF-8 yields garbage
  lines. *Mitigation:* sniff the file's **first ~8 KB** for a NUL byte (the
  standard git-style heuristic) and skip the file if found — *before* decoding
  the whole file, so a multi-GB binary cannot defeat the bounded-output/latency
  intent. Documented as the binary guard in the impl.
- **Rollback:** remove the `search` entry from `BUILTIN_EXTENSIONS` and revert
  the CLAUDE.md line; delete `search.ts` + its test. The extension is inert when
  not loaded, holds no persisted state, and changes nothing in `core-tools` or
  the kernel — `bash` search is unaffected.
