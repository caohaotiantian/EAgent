# Design — Time-travel checkpoint tree (agent-state rewind + fork)

```
Status: closed
Closing-commit: f04d424
Closed-on: 2026-06-29
Deferred: RW7a-1 (delta-blob compression), RW7a-2 (conversation+workspace rewind unification), RW7a-3 (command-gating polish) — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-time-travel` · **Wave:** 7 (subsystem 1 of 3) · **Mode:** Full
**Source:** [`docs/ROADMAP.md`](../ROADMAP.md) · **Strategy:** [`2026-06-28-eagent-redesign-blueprint.md`](2026-06-28-eagent-redesign-blueprint.md) §3 P3.1 · **Research:** scratchpad `RESEARCH-FINDINGS-waves-6-8.md` §C (LangGraph branching checkpoints)

## 1. Background and the gap (code as truth)

A Wave-7 surface audit established what already exists, so this wave **extends, not duplicates**:

- **Resume across restart is already covered** three ways: `journal.ts` (auto JSONL write-ahead log of
  `Message`s + `/resume` whole-log replay), `session.ts` (`/save`/`/load` versioned envelope), `handoff.ts`
  (lossy summary resume). All durable (the host wires a disk-backed `FileBackend` for the `Store`,
  `host.ts:238`). **Do not rebuild these.**
- **The genuine gap is time-travel**: none of those is *step-addressable* (rewind to turn N) and none is a
  *branching tree* (fork an alternate line of history). They are whole-log or summary, forward-only.
- **The right foundation exists but no extension uses it**: Wave 4 added `Agent.snapshot()`/`restore()`
  capturing the **full** `AgentState` (messages, usage, model, providerName, systemPrompt, thinking,
  **`step`**) + a monotonic `#step`. **No extension calls it**; the only non-kernel/test callers are the
  HTTP host's per-session save/restore (`server.ts:113/333/348`) — which is orthogonal (it saves/restores
  *one* current state per session, with no tree, no step-addressing, no persistence-to-disk-as-history).
  So the step-aware, full-state primitive time-travel needs is present and has no branching/tree consumer.

Research (LangGraph durable execution / time-travel; Diagrid "checkpoints ≠ durable execution") is
decisive on shape: model checkpoints as a **branching tree** (parent-pointer per node), so **rewind** and
**fork** are *one* primitive — restore a node, and continuing from it either overwrites (rewind) or
creates a sibling line (fork). That same tree is what **Wave 8**'s reasoning-search controller will reuse
(each search branch = a fork), so building it right here pays twice.

This wave ships a `time-travel` extension: persist `Agent.snapshot()` to disk as a tree of nodes keyed by
a unique `id` (with `#step` as a display label — two branches can share a step number, since `restore()`
sets `#step` back and it then re-increments, so `id` not `step` is the node key), with `rewind`/`fork`/
`tree` commands. **No kernel change** (the primitive already exists).

## 2. Deliverables

- [ ] **D1** A new `time-travel` extension (`src/extensions/time-travel.ts`), off by default
  (`EAGENT_TIME_TRAVEL=off` kill switch + a store `enabled` flag default false), **no capability** (it
  reads/writes the agent's own state + the extension's store/dir). **No kernel change.**
- [ ] **D2** A persisted **checkpoint tree**: each node `{ id, step, parentId, label, ts, blobRef }` held
  in `e.store` (the lightweight index, capped at N nodes, default 64). `id` is a **persisted monotonic
  counter** (a store key incremented per node) so ids are unique and stable across restarts (AC-5); the heavy `AgentState` blob written
  to `.eagent/timetravel/<id>.json` (one file per node, mirroring `handoff.ts`'s `.eagent/handoffs/`
  pattern — keeps the store JSON small). `head` = the current node id (the lineage pointer). **Cap eviction
  is tree-coherent (KDD-3, G1):** evict the oldest node, but **re-parent its surviving children to its
  `parentId`** (a root's children become roots → the structure is a multi-root **forest**, which `/tree`
  renders by iterating all roots — D6). The evicted node is never `head` in practice (every add path sets
  `head ← new id` *before* the cap check, and eviction removes the *oldest*, so `head` = newest ≠ evicted
  whenever size ≥ 2); defensively, if it ever were head, move `head` to a surviving relative, never to
  `undefined`. **Write order — add path:** blob **before** the index `set` (a crash leaves a harmless
  orphan blob, never a dangling index→missing-blob, C3). **Evict path:** remove the index entry **first**,
  then delete the blob (a crash leaves an orphan blob, never a dangling index entry). The tolerant load
  guard (R4) reconciles orphan blobs.
- [ ] **D3** Capture: `/timetravel checkpoint [label]` snapshots now (`agent.snapshot()` → blob + node
  with `parentId = head`, `head ← new id`). (Capture is a **subcommand of `/timetravel`**, NOT a top-level
  `/checkpoint` — `checkpoint.ts` already registers `checkpoint`/`checkpoints`/`rollback` for the **git
  workspace**, and a same-named top-level command would silently *shadow* it since `time-travel` loads
  later, `CommandRegistry.get` returns `.at(-1)` — `commands.ts:43`. KDD-6, S1.) Optional
  **auto-checkpoint** at `turn_end` when enabled (one node per turn, gated by a store flag default off so
  the default-enabled posture is still cheap) — each new node's `parentId` is the prior `head`. The
  `turn_end` handler **wraps the snapshot in try/catch** so a poisoned `Message.meta` that fails
  `structuredClone` cannot break the loop (C1).
- [ ] **D4** **Rewind**: `/rewind <id|step>` → `agent.restore(node.state)` and `head ← node.id` (the
  lineage continues *from* that node; subsequent checkpoints are its children → a new branch forms
  naturally). Refuses while the agent is running (mirrors `restore()`'s own guard). **Selector resolution:**
  an `id` matches exactly; a bare `step` matching exactly one node selects it, but when a step is
  **ambiguous** across branches the command **prints the candidate ids and refuses** (no silent
  auto-pick) — `id` is the unambiguous selector. (Single rule, no "most-recent" tiebreak — G3.)
- [ ] **D5** **Fork**: `/fork <id|step> [label]` → same `restore(node.state)` but explicitly records a new
  child node immediately, so the tree shows an intentional branch point; `head` ← the new fork node.
  (Rewind and fork are the *same* restore primitive; fork just eagerly materializes the branch node.)
- [ ] **D6** **Tree view**: `/tree` renders the node **forest** (iterates every root — a root is a node
  whose `parentId` is unset; eviction can create multiple roots, D2), each as id, step, label, ts, `*` on
  head, indent by parent depth; `/timetravel [status|on|off|auto <on|off>|checkpoint [label]]` is the management command
  (status prints enabled/auto/node-count/head). Top-level convenience commands `/rewind`, `/fork`, `/tree`
  are **verified free** (no built-in registers them).
- [ ] **D7** Tests; registered in `BUILTIN_EXTENSIONS` (`host.ts`). Command names: `time-travel` owns
  `/timetravel`, `/rewind`, `/fork`, `/tree` — all distinct from `checkpoint.ts` (`checkpoint`,
  `checkpoints`, `rollback`), `session.ts`, `journal.ts` (`journal`, `resume`). **Note (S2): the
  canonical-set host test does NOT catch command-name collisions** — `CommandRegistry.list()` dedupes by
  key (`commands.ts:46-48`), so its `Set(names).size === names.length` assertion is a tautology (proof:
  `skills.ts` + `skills-hardening.ts` both register `skills` and the test is green — an *intentional*
  shadow). Collision-avoidance is therefore enforced by AC-7's **explicit disjoint-names** check, not by
  the existing canonical test.

## 3. Scope Boundary (NOT in scope)

- **No** kernel change — `snapshot()`/`restore()`/`AgentState`/`#step` already exist (Wave 4). This is a
  pure consumer of that primitive.
- **No** rebuild of resume (`journal`/`session`/`handoff` stay; this is *time-travel*, the orthogonal
  step-addressable + branching capability). No change to those extensions.
- **No** workspace/file rollback — that is `checkpoint.ts` (git working tree). This rewinds **agent
  conversation state only**; file state is explicitly out of scope (documented — KDD-5).
- **No** delta/incremental blob compression — full `AgentState` per node, FIFO-capped (simple, zero-dep;
  the cap bounds disk). Delta storage is a deferred optimization.
- **No** automatic fork-on-branch heuristics — forking is explicit (`/fork`) or via Wave 8's controller
  (which uses the kernel `snapshot()/restore()` directly, not this extension).
- **No** `Agent.fork()` kernel helper (RW4-1) — this extension proves the pattern at the extension layer;
  the kernel helper, if ever added, is Wave 8's call.

## 4. Key Design Decisions

### KDD-1 — Build on `Agent.snapshot()/restore()`, not on `journal`'s raw `Message[]`
*Problem:* what state does a checkpoint capture? *Options:* (a) reuse `journal`'s `Message[]` log;
(b) use the dormant `Agent.snapshot()` (full `AgentState`). *Choice:* **(b)** — `snapshot()` captures
usage/model/providerName/systemPrompt/thinking/**step** too, so a rewind restores the *exact* run state,
not just the transcript; it is step-aware (the tree key) and already deep-cloned + guarded. Building on
`journal`'s `Message[]` would silently drop usage/model/step — the duplication trap the audit flagged.
*Rejected:* (a) lossy, re-implements capture the kernel already does correctly.

### KDD-2 — Branching tree (parent pointers), so rewind and fork are one primitive
*Problem:* linear log vs tree. *Options:* (a) a linear undo stack (rewind discards the future);
(b) a tree where each node has a `parentId` and rewinding just moves `head`, so continuing from an
earlier node forms a sibling branch. *Choice:* **(b)** — the LangGraph lesson: a tree makes rewind and
fork the *same* operation (restore a node; new checkpoints attach as its children), preserves the
"future" as an alternate branch, and is exactly the structure Wave 8's search reuses. *Rejected:* (a)
loses alternate lines and would need a second mechanism for fork.

### KDD-3 — Light index in `Store`, heavy blob on disk (per-node file)
*Problem:* `AgentState` includes the full (growing) message list; storing every node's full state in the
one per-namespace store JSON would bloat it badly. *Options:* (a) everything in `e.store`; (b) tree index
(small: id/step/parent/label/ts) in `e.store`, blobs in `.eagent/timetravel/<id>.json`. *Choice:* **(b)**
— mirrors `handoff.ts`'s `.eagent/handoffs/` split; keeps the store JSON small and lets the cap prune
both index entries and their blob files together. **Write order: blob first, then the index `set`** so a
crash never leaves an index entry pointing at a missing blob — only a harmless orphan blob, reclaimable by
reconciling the dir against the index (C3). *Rejected:* (a) bloats the shared store file.

### KDD-4 — Off by default; auto-checkpoint separately gated
*Problem:* snapshotting every turn to disk has a cost. *Options:* (a) on by default with auto-capture;
(b) off by default, and even when enabled, auto-checkpoint is a separate store flag (default off) so
"enabled" gives the *commands* without per-turn disk writes. *Choice:* **(b)** — opt-in like
`fallback-routing`/`provenance`; an operator turns it on for an autonomous run, and turns on auto-capture
only when they want a node per turn. *Rejected:* (a) imposes disk I/O on every user.

### KDD-5 — Agent state only; workspace state is `checkpoint.ts`'s job (documented honestly)
*Problem:* rewinding the conversation but not the files can desync (the agent "un-remembers" an edit it
already made on disk). *Options:* (a) couple to `checkpoint.ts` (also roll back files on rewind);
(b) scope to agent state, document the caveat, and let an operator pair it with `/rollback` manually.
*Choice:* **(b)** — coupling two extensions is fragile (git may be absent; the workspace checkpoint ids
don't align with step ids) and violates the one-subsystem rule. Document that `/rewind` restores
*conversation* state only; combine with `checkpoint.ts`'s `/rollback` for files. *Rejected:* (a) cross-
extension coupling + a brittle id-alignment problem; a later design can unify them.

### KDD-6 — Capture is a `/timetravel` subcommand, not a top-level `/checkpoint` (collision avoidance)
*Problem:* a natural name for "snapshot now" is `/checkpoint` — but `checkpoint.ts` already registers
`checkpoint`/`checkpoints`/`rollback` (`checkpoint.ts:135/153/173`) for the **git workspace**, and
`CommandRegistry` stacks same-named commands returning `.at(-1)` (`commands.ts:43`); `time-travel` loads
*after* `checkpoint` (`host.ts`), so a top-level `/checkpoint` would **silently shadow** the workspace
command. *Options:* (a) `/checkpoint` (collides); (b) fold capture under `/timetravel checkpoint`.
*Choice:* **(b)** — namespaced under `/timetravel`, zero collision, and it keeps the conversation-vs-
workspace separation (KDD-5) intact at the command layer. The convenience verbs `/rewind`/`/fork`/`/tree`
are verified free of any built-in. *Rejected:* (a) hijacks an existing user command — and the canonical
test would NOT catch it (S2), so it would ship silently.

## 5. Dependencies and Assumptions

Depends on Wave 4's `Agent.snapshot()`/`restore()`/`AgentState`/`#step` (present, dormant). Assumes
`restore()` throws while running (it does — Wave 4) so `/rewind` refuses mid-run cleanly. Assumes
`agent.snapshot()` returns a structuredClone (it does) so persisting it as JSON is lossless for the
JSON-serializable `AgentState` (messages/usage/strings/number — no functions). Uses `node:fs` for the
blob dir (like `handoff.ts`/`checkpoint.ts`) and `e.store` (disk-backed under the host) for the index.
Independent of the other Wave-7 subsystems.

## 6. Relationship with Existing Designs

Strategy parent: blueprint §3 P3.1; research §C. Consumes the Wave-4 `forkable-state` primitive — giving
it its first *branching, persisted, step-addressable* consumer (the HTTP host already uses
`snapshot()/restore()` for flat per-session save/restore, `server.ts:113/333/348`, but no tree). Orthogonal
to `journal`/`session`/`handoff` (resume) and `checkpoint.ts` (workspace files). Is the extension-layer proof of the rewind/fork pattern that **Wave 8**'s reasoning-search
controller will use via the kernel primitive directly (RW4-1 `Agent.fork()` stays deferred to Wave 8).
README extension table gains a `time-travel` row + count 54→55; reconciled at F.

## 7. Acceptance Criteria (measurable, automatable)

- **AC-1** `npm run typecheck` 0. **AC-2** `npm test` 0 (existing 1016 + new).
- **AC-3 (checkpoint+rewind round-trip)** Enable; run a turn; `/timetravel checkpoint`; run more turns
  (transcript grows); `/rewind` to the checkpoint; assert `agent.messages` (and usage/model/step via a
  snapshot) equals the captured state — i.e. the later turns are gone and the restored `step` matches.
- **AC-4 (fork forms a branch)** `/timetravel checkpoint` at A; run a turn; `/timetravel checkpoint` at B
  (explicit — auto is off, so the B-line node must be captured); `/fork A`; run a different turn +
  `/timetravel checkpoint`; `/tree` shows **two** children under A (the B-line node and the fork line) —
  assert the tree has a node whose `parentId` is A on each branch and that `head` is on the fork line.
- **AC-5 (persistence across a fresh extension instance)** With the tree written, construct a fresh
  `time-travel` activation over the same store + blob dir; `/tree` lists the prior nodes and `/rewind`
  restores a node's state — proving disk durability (index in store, blob in the dir).
- **AC-6 (refuses mid-run / off-by-default)** `/rewind` while the agent is running surfaces a clean error
  (not a throw out of the command); with the extension loaded-but-disabled, `/timetravel checkpoint` is
  inert and no blob is written.
- **AC-7 (real disjoint-command-names check — NOT the tautological canonical test)** A test builds the
  command set from `BUILTIN_EXTENSIONS.filter(([id]) => id !== "time-travel")` (there is no
  `createAgentHost` exclude flag — `host.ts:180-264` loads all unconditionally — so filter the exported
  array and activate the filtered set onto a fresh registry), collects those command names, and asserts
  `time-travel`'s names (`timetravel`/`rewind`/`fork`/`tree`) are **disjoint** from that set (catches
  shadowing in either direction). Plus the canonical-set test green (`BUILTIN_EXTENSIONS.length` +1, no dup
  *tool* names). (Per S2 the canonical test's command-name assertion is a tautology — this disjoint check
  is the real gate.)
- **AC-8 (cap is tree-coherent)** Exceed the cap so a node with children (an **ancestor**) is evicted;
  assert (a) tree size ≤ cap, (b) the evicted node's blob file is deleted, (c) **every surviving node is
  reachable from some root** and has no dangling `parentId` (orphans were re-parented to the evicted
  node's parent, or became roots), and (d) `head` still resolves to a live node.

*Quality budget:* a snapshot is a structuredClone + one JSON write per checkpoint; bounded by the cap and
opt-in. Negligible on the default (disabled) path. Excluded.

## 8. Risks and Rollback

- **R1 — Conversation/workspace desync on rewind** (KDD-5). *Mitigation:* documented; `/rewind` restores
  conversation only; pair with `checkpoint.ts` `/rollback` for files. *Rollback:* `/timetravel off`.
- **R2 — Disk growth from full-state blobs.** *Mitigation:* tree-coherent cap (D2/KDD-3/AC-8) prunes
  index + blob together and re-parents orphans; off by default; auto-capture separately gated. *Rollback:*
  the kill switch; delete the dir.
- **R3 — `restore()` mid-run throw leaking out of a command.** *Mitigation:* catch + print a clean error
  (AC-6), mirroring the other commands' try/catch posture. *Rollback:* n/a.
- **R4 — Non-JSON-serializable state in a blob.** *Mitigation:* `AgentState` is messages/usage/strings/
  number — all JSON-safe; a defensive parse-guard on load skips a corrupt blob (like `journal`'s tolerant
  read). *Rollback:* n/a.
- **R5 — Command-name collision** silently shadowing `checkpoint.ts`'s `/checkpoint` (S1). *Mitigation:*
  capture is namespaced under `/timetravel checkpoint` (KDD-6), and AC-7 is a **real disjoint-names** check
  (load host minus time-travel, assert names disjoint) — NOT the canonical test, which is a tautology for
  command names (S2). *Rollback:* rename.
- **R6 — README extension table/count stale.** *Mitigation:* reconcile at F (54→55).

A single off-by-default extension consuming an existing kernel primitive; reverting the registration
removes it cleanly and touches nothing else.

## L1 Review Log

- **Round 1** — 2 SEVERE: S1 `/checkpoint` collides with `checkpoint.ts` (silent shadow; doc misstated its
  owned names); S2 the canonical-set host test is a **tautology** for command names (`list()` dedupes by
  key) so it can't catch collisions (proof: `skills`/`skills-hardening` both register `skills`, green). +
  general (FIFO prune orphans the tree; AC-4 unreproducible; id-vs-step keying). Fixed: capture →
  `/timetravel checkpoint`; AC-7 real disjoint-names check; tree-coherent eviction; id-keyed nodes.
- **Round 2** — 1 SEVERE (code-as-truth): §1 falsely claimed zero `snapshot/restore` callers outside
  kernel/tests — `server.ts:113/333/348` uses them (the "no *extension* uses it" is true). + 4 general
  (evict order; rewind-step resolution; root-head-on-evict; `/tree` forest). Fixed.
- **Round 3** — **zero severe, zero general** (one trivial citation off-by-one, fixed).
- **Round 4 (corroborating)** — **zero severe, zero general.** Two-generation satisfied. **L1 closed.**
