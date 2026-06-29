# Implementation — Time-travel checkpoint tree

```
Status: closed
Closing-commit: f04d424
Closed-on: 2026-06-29
Deferred: RW7a-1, RW7a-2, RW7a-3 — docs/DEFERRED-FOLLOWUPS.md
```

**Slug:** `2026-06-29-time-travel` (matches design) · **Design:**
[`design/2026-06-29-time-travel.md`](../design/2026-06-29-time-travel.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D7 the `time-travel` extension + host registration | design §2 D1-D7, KDD-1..6, AC-1..AC-8 |

One Phase: a single new off-by-default extension (no kernel change) consuming the existing
`Agent.snapshot()/restore()` primitive + one `BUILTIN_EXTENSIONS` line. Independently committable.

## 2. Phase Breakdown

### Phase 1 — The `time-travel` extension

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-6 merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D7; KDD-1 (build on snapshot, not journal), KDD-2 (branching tree), KDD-3
  (index in store / blob on disk, write-ordering), KDD-4 (off-by-default + auto separately gated), KDD-5
  (agent state only), KDD-6 (capture namespaced under `/timetravel`); AC-1..AC-8.
- **Files:** `src/extensions/time-travel.ts` (new), `src/host.ts` (register), `test/time-travel.test.ts`
  (new).
- **Data model (closure + store):**
  - Store keys (namespaced by the extension): `enabled` (bool, default false), `auto` (bool, default
    false), `cap` (number, **default 64** — the node cap, store-overridable so AC-8 can set it small),
    `nodes` (`Record<string, Node>` — the index), `head` (string id | undefined), `seq` (number — the
    persisted monotonic id counter).
  - `interface Node { id: string; step: number; parentId?: string; label?: string; ts: number; }`. `ts`
    is a wall-clock `Date.now()` for display only (allowed in an extension — `packages.ts`/`limits.ts`
    call `Date.now()`; only Workflow scripts forbid it); tests assert *structure*, not `ts`. "Oldest"
    for eviction = the node with the **lowest numeric `id`** (the monotonic counter), not `ts`.
  - Blob dir (workspace-relative, matching `handoff.ts:213-215` `.eagent/handoffs/` and `checkpoint.ts`):
    `EAGENT_TIME_TRAVEL_DIR ?? join(EAGENT_WORKSPACE ?? process.cwd(), ".eagent", "timetravel")` — the
    `EAGENT_<NAME>_DIR` house override convention (`skills.ts:33`/`templates.ts:89`), so tests point it at
    a `mkdtemp` dir without touching the real workspace. Create with `mkdirSync(..., { recursive: true })`.
- **Task list (TDD order):**
  1. **(test)** `test/time-travel.test.ts` — **checkpoint+rewind round-trip** (AC-3): a host slice with the
     extension enabled; run a turn (MockProvider), `/timetravel checkpoint`, run more turns,
     `/rewind <id>`; assert `agent.messages` length + content and a fresh `agent.snapshot().step` equal the
     captured node's state (later turns gone).
  2. **(test)** **fork forms a branch** (AC-4): `/timetravel checkpoint` (A) → run+`/timetravel checkpoint`
     (B) → `/fork A` → run+`/timetravel checkpoint`; assert the index has two nodes whose `parentId === A`
     and `head` is on the fork line.
  3. **(test)** **persistence across a fresh instance** (AC-5): write a tree, then activate a SECOND
     `time-travel` over the same store + blob dir; `/tree` lists prior nodes and `/rewind <id>` restores —
     proving disk durability. (Use a shared store backend + the same blob dir across the two activations.)
  4. **(test)** **refuses mid-run / off-by-default** (AC-6): `/rewind` while `agent` is running prints a
     clean error (no throw out of the command — catch `restore()`'s "agent is running" throw); with the
     extension loaded but `enabled=false`, `/timetravel checkpoint` is inert (no node added, no blob file).
  5. **(test)** **disjoint command names** (AC-7): build the command set from
     `BUILTIN_EXTENSIONS.filter(([id]) => id !== "time-travel")` activated onto a fresh `ExtensionHost`
     (or collect via the host's registries), and assert `["timetravel","rewind","fork","tree"]` are
     disjoint from it. Plus the canonical-set host test stays green.
  6. **(test)** **tree-coherent cap** (AC-8): set a tiny cap; add enough nodes to evict an ancestor; assert
     tree size ≤ cap, the evicted blob file is gone, every survivor is reachable from a root (no dangling
     `parentId`), and `head` resolves to a live node.
  7. **(impl)** `src/extensions/time-travel.ts`: default-export `activate(e)`; `EAGENT_TIME_TRAVEL === "off"`
     → no-op return. Helpers (closure over `e`): `cfg()` (enabled/auto), `readNodes()/writeNodes()`,
     `readHead()/writeHead()`, `nextId()` (bump `seq`), `blobPath(id)`, `writeBlob(id,state)` /
     `readBlob(id)` (JSON, tolerant parse → undefined on corrupt, R4), `addNode(state,label)` (blob FIRST
     then index `set`, KDD-3; `parentId=head`; `head←id`; then `evictIfOverCap()`),
     `evictIfOverCap()` (while size > `cfg().cap`: pick the **oldest = lowest numeric `id`**; re-parent its
     children to its `parentId`; if it were `head` move head to a survivor; **remove index entry first,
     then unlink the blob**), `resolve(sel)` (id exact, else nodes with `step===sel`; if >1 print
     candidates + return undefined). Register:
     - `e.on("turn_end", …)`: if `enabled && auto`, `try { addNode(e.agent.snapshot()) } catch { /* poisoned meta — skip */ }` (C1).
     - `e.registerCommand({ name: "timetravel", … })`: subcommands `status` (print enabled/auto/count/head),
       `on`/`off` (set `enabled`), `auto on|off` (set `auto`), `checkpoint [label]` (guard `enabled`;
       `addNode(e.agent.snapshot(), label)`; print the new id).
     - `e.registerCommand({ name: "rewind", … })`: `const node = resolve(arg)`; if none → print + return;
       `const state = readBlob(node.id); if (!state) { print("corrupt/missing checkpoint"); return; }`
       (readBlob is `AgentState | undefined` — this guard is required for strict-TS, AC-1); then
       `try { e.agent.restore(state); writeHead(node.id); } catch (err) { print(clean error) }` (catches
       the running-agent throw, AC-6).
     - `e.registerCommand({ name: "fork", … })`: like rewind (resolve → readBlob guard → restore), then
       **`writeHead(node.id)` BEFORE `addNode(...)`** so the new fork node's `parentId = head = the forked
       node` (AC-4's "child under A"); `addNode(e.agent.snapshot(), label)`; print the new id.
     - `e.registerCommand({ name: "tree", … })`: render the forest — find roots (`!parentId` or parent not
       in index), DFS with indent, `*` on head.
     - Declares **no** capability. Wrap registrations; the extension may `return` void (host tracks
       registrations for reload, like `codeact.ts`) OR return a disposer — match the prevailing style.
  8. **(impl)** `src/host.ts`: `import timeTravel from "./extensions/time-travel.js";` and append
     `["time-travel", timeTravel]` to `BUILTIN_EXTENSIONS`.
  9. **(verify)** `node --import tsx --test "test/time-travel.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Accept:** `node --import tsx --test "test/time-travel.test.ts" "test/host.test.ts"`; `npm run typecheck`.
- **Exit:** AC-3..AC-8 pass; off-by-default inert; disjoint command names; host canonical-set green;
  `npm test` green; typecheck 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" + "Adding an extension" — ESM NodeNext `.js`
  specifiers; strict TS (`noUncheckedIndexedAccess` — guard `nodes[id]` access, `.find`); zero deps but
  jiti (`node:fs`/`node:path` only); offline tests; `EAGENT_TIME_TRAVEL=off` kill switch; **no capability**;
  append to `BUILTIN_EXTENSIONS`; **no kernel change** (consumes `snapshot()/restore()/AgentState`/`#step`).
  Blob/dir handling mirrors `handoff.ts`/`checkpoint.ts`; store is disk-backed under the host.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; no AI attribution.

## 4. Data and Fixture Dependencies

`MockProvider` to script multi-turn runs. A shared `Store` backend + a temp blob dir (set
`EAGENT_TIME_TRAVEL_DIR` to a `mkdtemp` dir) so AC-5 (fresh instance over the same store + dir) and AC-6
(no blob when disabled) are deterministic and never touch the real workspace. Save/restore any env var the
test sets. Offline; no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. Off-by-default (the kill switch + `enabled` default false)
  keeps the extension inert in the shipped config, so existing suites are unaffected — the core net.
- The canonical-set host test covers the registration (+1 extension; no dup *tool* names); AC-7 adds the
  real command-disjointness check the canonical test cannot provide.
- No kernel change → `kernel-surface.test.ts` unaffected (kernel stays 2182). No change to
  `journal`/`session`/`handoff`/`checkpoint` (orthogonal).

## L2 Review Log

- **Round 1** — zero severe + 2 general (cap config unspecified → added `cap` store key; blob-dir used a
  net-new `EAGENT_STATE_DIR` + wrong "mirror" citation + diverged from design's workspace-relative path →
  fixed to `EAGENT_TIME_TRAVEL_DIR ?? workspace/.eagent/timetravel`) + clarifications (rewind
  `readBlob` undefined-guard; fork `writeHead`-before-`addNode`; eviction oldest = lowest id). All folded.
- **Round 2** — **zero severe, zero general** (one cosmetic env-var asymmetry, fixed).
- **Round 3 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
