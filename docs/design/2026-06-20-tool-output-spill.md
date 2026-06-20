# Design: lossless tool-output overflow — spill-to-file in `limits`

Status: draft
Slug: `2026-06-20-tool-output-spill`

## 1. Background and Purpose

EAgent's `limits` extension caps a single tool's output at a byte budget
(`DEFAULT_MAX_TOOL_OUTPUT_BYTES = 16384`) by **truncating in place**
(`src/extensions/limits.ts:87-103`): the overflow bytes are dropped and a
`[output truncated: N of M bytes shown]` marker is appended. The clipped content
is **gone** — if the answer the agent needed was in the dropped tail (a stack
trace, a later test failure, a config value), the model cannot recover it except
by re-running the tool with narrower arguments, which it often cannot express.

The upstream project [opencode](https://github.com/anomalyco/opencode) handles
this losslessly (`packages/opencode/src/tool/truncate.ts`): when output exceeds
the budget it **writes the full output to a file** and returns a preview plus a
hint telling the model exactly how to retrieve the rest (grep / read with
offset). No information is destroyed; it is moved out of the context window but
left addressable.

This task digests that idea into EAgent's existing `limits` extension: on
overflow, spill the **full** tool output to a file under the workspace and
replace the truncation marker with a retrieval hint that points the model at
EAgent's own `read` tool (which can slice the spill file by line range). The
context-window budget is still enforced — but the dropped bytes become
recoverable instead of lost.

If we do not do this, every truncation is a silent, irreversible information
loss, and the agent's only recourse to oversized output is to re-run tools
blindly.

## 2. Deliverables

- [ ] `src/extensions/limits.ts` — the `afterToolCall` truncation hook spills the
      full output to a file on overflow and emits a retrieval hint; a best-effort
      age-based cleanup of stale spill files on activation; new store-backed
      config (`spillToolOutput` on/off, `toolOutputDir`, `toolOutputRetentionDays`)
      surfaced through the existing `/limits` command; an `EAGENT_TOOL_SPILL=off`
      kill switch.
- [ ] `test/limits.test.ts` — offline tests: overflow spills the full content to
      a readable file + hint; under-limit is untouched and writes nothing; spill
      disabled falls back to the current in-context marker; a spill-write failure
      falls back to in-context truncation without throwing; `isError`/`details`/
      `terminate` survive the spill branch; retention cleanup removes stale files;
      the existing budget/command tests stay green.
- [ ] `CLAUDE.md` — update the one-line `limits` description to mention
      spill-to-file (the inventory currently says only "limits").

## 3. Scope Boundary (NOT in scope)

- **No change to the byte budget mechanism or the per-run call/token budgets.**
  Only the truncation *branch* of the `afterToolCall` hook changes; the budget
  hooks (`beforeToolCall`, `agent_start`, `usage`) are untouched.
- **No new extension.** Truncation already lives in `limits`; a second extension
  racing on the same `afterToolCall` content would be incoherent. This is an
  enhancement of the existing hook.
- **No new retrieval tool.** Retrieval reuses the existing `read` tool
  (offset/limit) and `bash` grep; the hint names them. No bespoke "read spill"
  command is added.
- **No kernel change.** `afterToolCall`'s contract (`ToolResult` in → out) is
  unchanged; all behavior stays inside the extension.
- **No cross-run index or registry of spill files.** Files are addressed only by
  the path embedded in each tool result. Cleanup is purely age-based on disk.
- **No compression / structured storage.** The spill file is the raw UTF-8
  output, verbatim.

## 4. Key Design Decisions

### D1. Enhance `limits`, not a new extension

- **Problem:** Where does spill-to-file live?
- **Options:** (a) a new `tool-spill` extension hooking `afterToolCall`; (b)
  enhance the truncation branch already in `limits`.
- **Choice:** (b).
- **Rationale:** Truncation is `limits`' existing responsibility
  (`limits.ts:87-103`); the spill is just "where the truncated bytes go". Two
  extensions both transforming `afterToolCall` content would race
  non-deterministically (filter order) and could double-truncate or fight over
  the marker. Folding the spill into the one hook that already owns truncation is
  the coherent, surgical choice. Rejected (a) because it manufactures a
  coordination problem the single-hook design does not have.

### D2. Spill location: `<workspaceRoot>/.eagent/tool-output/`

- **Problem:** Where to write the spill so the model can actually retrieve it?
- **Options:** (a) `os.tmpdir()` (like `codeact`); (b) `~/.eagent/tool-output`
  (like `skills`/`sessions`); (c) `<workspaceRoot>/.eagent/tool-output`.
- **Choice:** (c) `<workspaceRoot>/.eagent/tool-output/`, where `workspaceRoot`
  is `$EAGENT_WORKSPACE ?? process.cwd()` (matching `core-tools.ts:21-23`).
  Overridable via the `toolOutputDir` store key.
- **Rationale:** EAgent's `read` tool **confines to the workspace root**
  (`core-tools.ts:30-37`) — it refuses paths outside it. Only option (c) puts
  the spill file where the confined `read` tool can reach it, which is exactly
  what the retrieval hint must promise. (a) and (b) live outside the workspace,
  so `read` would reject them and the hint would only work via unconfined `bash`
  (which needs `shell:exec`, often denied) — defeating the purpose. `.eagent/` is
  **already gitignored** (`.gitignore`), so spill files never pollute version
  control. Rejected (a)/(b) on retrievability grounds.
- **Invariant + degradation (the coupling that makes the hint true):** the spill
  writer resolves the **same** `workspaceRoot` the `read` tool closes over at
  activation (`core-tools.ts:48`) — both compute `$EAGENT_WORKSPACE ??
  process.cwd()`, so in one process with stable env/cwd they agree. The default
  `toolOutputDir` (`<root>/.eagent/tool-output`) is therefore inside the root and
  the hint embeds a root-relative path. **If a host overrides `toolOutputDir` to
  a location outside `workspaceRoot`**, the file still writes but `read` would
  reject it; in that case the hint omits the relative path and suggests **bash
  grep/cat only** (the writer detects this with the same `confine`-style
  inside-root check the `read` tool uses). This keeps the hint honest rather than
  promising a `read` that would fail.

### D3. Retention: best-effort age-based cleanup on activation

- **Problem:** Spill files accumulate; unbounded growth fills the workspace.
- **Options:** (a) no cleanup; (b) count cap (keep newest N); (c) age-based
  retention sweep (delete files older than D days).
- **Choice:** (c), default 7 days, run once on activation, best-effort
  (failures logged, never thrown), configurable via `toolOutputRetentionDays`.
- **Rationale:** Mirrors opencode's 7-day `RETENTION` (`truncate.ts:13`). Age is
  the natural axis — a spill is only useful for the session that produced it;
  days-old files are dead. (a) leaks disk indefinitely. (b) could evict a file
  still referenced by the live transcript (newest-N by mtime can drop a file the
  model is mid-retrieving). On-activation timing keeps it off the hot path (no
  per-call `stat` sweep). Rejected (a) for the leak and (b) for the
  live-reference hazard.
- **Reload-safety:** the sweep is a plain best-effort function **called** inside
  `activate` (not registered as a hook or disposable), so it is idempotent and
  safe to re-run on every `jiti` hot reload — an age filter deleting nothing the
  second time. It is not added to the teardown disposable loop
  (`limits.ts:184-192`), which must stay non-throwing.

### D4. Retrieval hint names the `read` tool with offset/limit

- **Problem:** What does the model see so it can recover the dropped bytes?
- **Choice:** The truncated result content becomes:
  `<preview>\n\n[output truncated: N of M bytes shown; full output saved to
  <relpath>. Retrieve more with the read tool (offset/limit) or grep it via bash.]`
  where `<relpath>` is the spill path relative to the workspace root. The preview
  is truncated to `maxToolOutputBytes` **first** (exactly as today,
  `limits.ts:93`), then the hint is appended — so the hint length is purely
  additive on top of the existing cap, not double-counted into it.
- **Rationale:** A path with no instruction is a dead end; opencode's hint is
  explicit about *how* to read it (`truncate.ts:131-134`). Naming EAgent's own
  `read` tool (which the model already has) and its `offset`/`limit` parameters
  makes the recovery path concrete and confinement-correct (relative path inside
  the workspace). `bash grep` is mentioned as the secondary path for searching.

### D5. Fail-soft: a spill failure degrades to today's in-context truncation

- **Problem:** Writing the spill file can fail (read-only FS, quota, permission).
- **Choice:** Wrap the spill write in try/catch; on failure, fall back to the
  **current** behavior — in-context truncation with the existing
  `[output truncated: N of M bytes shown]` marker — and log a warning. Never
  throw.
- **Rationale:** `limits.ts:17` already states "a guardrail that crashes the run
  it guards is worse than no guardrail at all." The byte budget MUST still be
  enforced even when the spill cannot be written; losing the overflow (today's
  behavior) is an acceptable degradation, crashing the run is not.

### D6. Spill default-on, with config + env kill switch

- **Problem:** Is spilling on by default?
- **Choice:** Default **on** (`spillToolOutput` defaults true). Disable per-host
  via `/limits spillToolOutput=0` or the store; `EAGENT_TOOL_SPILL=off` is a hard
  kill switch (mirrors `EAGENT_FLOW_GUARD=off`). When off, behavior is exactly
  today's in-context truncation.
- **Rationale:** Lossless overflow is the better default — the whole point is to
  stop destroying information. The only side effect is a gitignored file under
  `.eagent/` written solely when output already overflows; that is a small,
  contained cost for recoverability. Hosts that want zero disk writes (read-only
  sandboxes) flip it off and get exactly the prior behavior, so the change is
  safely reversible. Rejected default-off because it would leave the loss-bug
  unfixed unless every host opts in.

## 5. Dependencies and Assumptions

- **`afterToolCall` filter hook** (`limits.ts:87`, `events.ts:59-63`): receives
  and returns a `ToolResult { content; isError?; details? }`. Unchanged contract.
- **`read` tool confinement** (`core-tools.ts:21-37`): spill path must be inside
  `workspaceRoot` for the hint to be actionable. The spill writer uses the same
  `$EAGENT_WORKSPACE ?? process.cwd()` resolution.
- **`.gitignore`** already contains `.eagent/`, so spill files are untracked.
- **Node `fs`** (`mkdirSync`, `writeFileSync`, `readdirSync`, `statSync`,
  `rmSync`) — already used elsewhere (`core-tools.ts`, `codeact.ts`); no new npm
  dependency.
- **Test harness** `makeHarness` + `MockProvider` (`test/helpers.ts`,
  `test/limits.test.ts`) drive the `afterToolCall` path offline. To keep the D2
  in-workspace invariant true under test, disk-touching tests set
  **`EAGENT_WORKSPACE` to a fresh `mkdtemp` dir** (restored in a `finally`) so
  that dir *is* the workspace root; the spill then defaults to
  `<mkdtemp>/.eagent/tool-output`, which is inside the root, so the
  relative-path/confine assertions (AC-2/AC-3) hold and nothing is written into
  the repo. (Setting `toolOutputDir` to a bare `mkdtemp` path would put the spill
  *outside* the harness root and is therefore only used by the
  override-degradation and fail-soft tests, not the happy-path ones.)

## 6. Relationship with Existing Designs

- Builds on `docs/design/2026-06-20-bash-policy.md` only by convention (same
  extension-as-policy thesis, same `e.store`/`/command`/env-kill-switch idiom);
  no functional dependency. No supersession.
- **Modifies** the existing `limits` extension's truncation behavior
  (`src/extensions/limits.ts:87-103`). The change is additive within the same
  hook: under-limit output is byte-for-byte unchanged; over-limit output gains a
  spill file and a richer marker (or, with spill off, is identical to today).
- Reuses the `read` tool (`core-tools.ts`) as the retrieval mechanism — an
  intentional cross-extension contract (the hint promises `read` works on the
  spill path), satisfied by D2's location choice. Flagged so a reviewer sees the
  coupling is deliberate, not accidental.

## 7. Acceptance Criteria

Verified by `npm test` (offline) and `npm run typecheck` (exit 0). Happy-path
disk tests set `EAGENT_WORKSPACE` to a `mkdtemp` dir (restored in `finally`) so
the spill lands at `<root>/.eagent/tool-output`; the override/fail-soft tests set
`toolOutputDir` explicitly.

1. **Typecheck clean:** `npm run typecheck` exits 0.
2. **Overflow spills the full content (live):** with `EAGENT_WORKSPACE` = a
   mkdtemp root, a tool returning content larger than `maxToolOutputBytes` yields
   a result whose `content` (a) is ≤ the byte cap plus the marker, (b) matches
   `/full output saved to /`, and (c) names a path; the file at that path
   **exists** and its bytes **equal the original full output**.
3. **Retrieval hint is `read`-actionable (live):** under the mkdtemp workspace,
   the spill path resolves inside the workspace root — a `confine(root, path)`
   check (same logic as `core-tools.ts:30-37`) succeeds, proving the `read` tool
   would accept it; assert the path does not escape the root.
4. **Under-limit is untouched (live):** content ≤ the cap returns byte-identical
   and **no file** is written to `toolOutputDir`.
5. **Spill disabled falls back (live):** with `spillToolOutput=0` (or
   `EAGENT_TOOL_SPILL=off`), oversized output returns the **current** in-context
   marker `/output truncated: \d+ of \d+ bytes shown/` and writes **no file**.
6. **Spill-write failure fails soft (live):** with `toolOutputDir` pointed at a
   path whose parent is an existing **file** (so the writer's `mkdirSync` throws,
   caught by D5's try/catch), oversized output still returns the in-context
   truncation marker, `isError` is unchanged, and the run does **not** throw.
7. **Result fields preserved on spill (live):** a tool returning an oversized
   result with `isError: true` and a `details`/`terminate` field yields, after
   spilling, the **same** `isError`, `details`, and `terminate` values (only
   `content` changes) — guarding the `...result` spread in the new branch.
8. **Retention cleanup (unit/live):** given spill files whose `mtime` is set
   older than `toolOutputRetentionDays` (via `fs.utimesSync`), activation deletes
   them while keeping a fresh file; and the sweep over a **missing** dir returns
   without throwing. (The "undeletable file" path is covered by the sweep's
   per-file try/catch by inspection, not asserted as a test — provoking an
   undeletable file offline is platform-fragile.)
9. **Regression:** the existing `limits` budget and `/limits` command tests stay
   green; `npm test` reports `# fail 0`.

No latency budget declared: the spill writes once per *already-oversized* tool
result (rare, off the hot path) and the cleanup runs once at activation — both
excluded from a performance budget per this Scope Boundary.

## 8. Risks and Rollback

- **R1 — Workspace clutter.** Spill files land under `<workspaceRoot>/.eagent/`.
  *Mitigation:* `.eagent/` is gitignored; files are written only on overflow and
  swept after `toolOutputRetentionDays`; `EAGENT_TOOL_SPILL=off` disables writing
  entirely.
- **R2 — Stale path in transcript after cleanup.** A retention sweep could delete
  a spill file whose path is still referenced by an old tool-result message.
  *Mitigation:* default retention is 7 days, far longer than a live session; the
  model attempting to `read` a swept path simply gets a normal "cannot read"
  error (no crash). Accepted as a benign, self-correcting edge.
- **R3 — Spill of sensitive output to disk.** Oversized output containing secrets
  is now written to a file. Note the precise trade: today the overflow *tail* is
  truncated-and-discarded, so it never touches disk at all; spill **persists that
  previously-discarded tail** (the in-window preview was always disk-eligible via
  the `write` tool, but the dropped remainder was not). *Mitigation:* it is inside
  the workspace the agent already reads/writes, gitignored, and swept after
  `toolOutputRetentionDays`; this is no broader than what the `write` tool can
  already place there. `flow-guard`'s taint model is unaffected (the spill is a
  local file write, not egress). Hosts with stricter needs use the kill switch
  (`EAGENT_TOOL_SPILL=off`), which restores exact prior behavior.
- **Rollback:** set `EAGENT_TOOL_SPILL=off` (instant, restores today's behavior),
  or revert the `limits.ts` diff and the one CLAUDE.md line; no persisted state
  beyond gitignored spill files, which the sweep or a manual `rm -rf .eagent/
  tool-output` removes.
