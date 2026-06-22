# Design: `sweep-edit` — regex-enumerated multi-site refactor that fans a sub-agent per match

Slug: `2026-06-22-sweep-edit`
Status: draft

## 1. Background and Purpose

EAgent can edit exactly **one file per `edit` call**. The built-in `edit` tool
(`src/extensions/core-tools.ts:121-192`) takes a single `path`, an `old`
substring, and a `new` substring, replaces within that one file, and returns.
There is no primitive that takes "this same change, everywhere it applies."

The two extensions that come closest each stop short of the gap:

- `subagents` (`src/extensions/subagents.ts`) fans out **prompt** work —
  `single`/`parallel`/`chain` children on a list of *prompts the model wrote*
  (`subagents.ts:84-178`). It never derives that list from the tree.
- `dynamic-workflow` (`src/extensions/dynamic-workflow.ts`) executes a
  **model-authored DAG** — the model emits the whole `run_workflow` spec
  (`dynamic-workflow.ts:1-22`), including every step. The worklist is authored,
  not enumerated.

So a multi-site rename/refactor today is **N manual `edit` calls the model must
orchestrate by hand**: it must first grep, then read each hit, then issue one
`edit` per file, tracking which it has done. That is exactly the kind of
mechanical fan-out the model is bad at (it loses count, skips files, or burns
turns) and that a small primitive can do reliably.

The missing piece is an **auto-enumerate-then-fan-out edit**: take a regex + a
glob + one shared natural-language instruction, *enumerate* the matching sites
from the tree, and apply the same semantic change to each — tolerating that some
sites legitimately should not change (a false-positive regex hit).

What happens if we do not build it: every cross-tree refactor stays a hand-rolled
loop the model drives imperatively, with no isolation between sites (one bad edit
can derail the whole sequence) and no structured per-site report.

This extension adds a `sweep_edit` tool that **composes the two existing
mechanisms it must not reimplement**: it enumerates with the `search`
extension's workspace-confined grep, and it edits with a `subagents`-style
constrained child per site. The novelty is solely *deriving the worklist from a
regex over the tree*; the searching and the editing are reuse.

## 2. Deliverables

- [ ] `src/extensions/sweep-edit.ts` — a new extension registering one tool,
      `sweep_edit`, gated behind `fs:write` + `agent:spawn` (both reused, no new
      capability). Enumerates sites via the same pure-Node confined grep `search`
      uses, then spawns one constrained child per matched file.
- [ ] `test/sweep-edit.test.ts` — offline `node:test` against a real temp-file
      workspace (`EAGENT_WORKSPACE`) + a scripted `MockProvider`, loaded via
      `host.use("sweep-edit", sweepEdit)` (the `test/recovery.test.ts:118-119`
      pattern). Does **not** depend on `BUILTIN_EXTENSIONS`.
- [ ] Kill switch: `EAGENT_SWEEP_EDIT=off` — when set, `activate` registers
      nothing and returns a no-op dispose (mirrors `recovery.ts:103`).
- [ ] A `/sweeps` command explaining the tool's contract and the max-sites cap
      (mirrors the `/agents` command in `subagents.ts:180-190`).
- [ ] Dispose loop that never throws (try/catch around each `dispose`, per
      `recovery.ts:107-113`).
- [ ] **host.ts registration** in `BUILTIN_EXTENSIONS` — **(deferred to batch
      integration)**.
- [ ] **CLAUDE.md / README inventory line** (one-line entry; README extension
      count) reconciled at closeout — **(deferred to batch integration)**.
- [ ] `docs/implementation/2026-06-22-sweep-edit.md` — implementation log /
      closeout notes.

## 3. Scope Boundary (NON-goals — Simplicity First)

- **No new file walker, no shell, no ripgrep.** Enumeration reuses `search.ts`'s
  pure-Node confined grep semantics. We do not shell out and do not add a
  dependency (the repo is zero-runtime-deps except `jiti`).
- **No new edit primitive.** The actual mutation is performed by a child agent
  calling the existing `edit` tool. `sweep_edit` never reads or writes files
  itself beyond what `grep` already reads to enumerate.
- **No new capability string.** Reuse `fs:write` (the edits) + `agent:spawn`
  (the children). Following the `readonly-subagent` precedent
  (`docs/design/2026-06-21-readonly-subagent.md`), no kernel change.
- **No in-graph branching / dependency DAG.** This is not `dynamic-workflow`.
  Every site is independent; there are no `${id}` references, no `needs` edges,
  no cross-site data flow. A flat enumerated worklist only.
- **No interactive per-site approval UI, no diff preview, no dry-run mode.** The
  change is reviewable in git after the fact (the same posture as every other
  mutation in EAgent); a preview mode is a separate, optional polish.
- **No automatic re-sweep / fixpoint iteration.** One pass over the enumerated
  sites. The model re-invokes the tool if it wants another pass.
- **No cross-file coordination** (e.g. "rename the symbol *and* update its one
  definition site differently"). Each child sees only its own file; coordinated
  multi-file edits remain the model's job via separate calls.
- **No grandchild spawning.** Children inherit the recursion guard from the
  child-registry construction (no `spawn_agent`, no `sweep_edit` in the child
  registry).

## 4. Key Design Decisions

### D1 — How to enumerate the edit sites

**Problem.** `sweep_edit` needs the list of files (and the matched lines within
each) for a regex over the tree, confined to the workspace root, with no shell
escape.

**Options.**
(a) A new bespoke file walker inside `sweep-edit.ts`.
(b) Reuse `search.ts`'s confined pure-Node grep traversal.

**Choice: (b) — reuse `search`'s grep.** `search.ts` already implements exactly
the needed traversal: `workspaceRoot()` honoring `EAGENT_WORKSPACE`
(`search.ts:25-27`), a `confine()` boundary check that rejects `../` and stray
absolute paths (`search.ts:39-46`), symlink-skipping descent that ignores
`.git`/`node_modules` (`search.ts:99-119`), a binary-file NUL guard
(`search.ts:218-220`), and an `include`-glob filter (`search.ts:203,210`). It is
pure Node, already tested (`test/search.test.ts`), and runs with only `fs:read`.

Because `search.ts` does not export these helpers (they are module-private), the
clean reuse is to **invoke the registered `grep` tool through the agent's tool
registry** rather than copy its internals. `sweep_edit` resolves
`e.agent.tools.get("grep")` and calls its `execute({ pattern, include }, ctx)`,
then parses the `path:line:text` lines it returns (`search.ts:230`). This keeps a
single confined-traversal implementation and inherits its 100-result cap and
truncation marker (`search.ts:121-125`).

**Why (a) rejected.** A second walker duplicates the confinement and
symlink/binary guards — the precise security-sensitive code we least want two
copies of. A divergence between the two (e.g. one forgets the `sep()`-aware
boundary check at `search.ts:42`) is a workspace-escape bug. Simplicity First
says reuse the tested traversal.

### D2 — One sub-agent per site vs. one agent over the whole list

**Problem.** Given M matched files, do we spawn one child per file, or one child
handed the whole list?

**Options.**
(a) One child per matched file.
(b) One child given all M files and told to edit each.

**Choice: (a) — one child per site.** Isolation is the whole point: each child
has a fresh context scoped to *one* file path + its matched lines + the shared
instruction. A child may independently **decline** (false-positive tolerance), a
bad edit on one file cannot corrupt another, and each child's loop is bounded
(small `maxTurns`). The per-site results compose into the structured summary
`{file, status, note}`.

**Why (b) rejected.** A single child over the whole list reintroduces exactly the
manual-orchestration failure mode we are removing: it loses count across files,
one malformed edit aborts or pollutes the rest, and the long shared context
defeats the isolation that makes `subagents` valuable (`subagents.ts:13-19`).
Per-site is also trivially parallelizable (`Promise.all`, like
`subagents.ts:158`).

### D3 — Child privilege: full vs. scoped

**Problem.** What authority does each site-child run with?

**Options.**
(a) Share the parent's capability manager (full authority — `fs:read`,
`fs:write`, `shell:exec`, `net:fetch`, whatever the parent has).
(b) A scoped lane: the child may only **read and edit** the target file — no
network, no shell.

**Choice: (b) — scoped, least privilege.** A site-child's only legitimate job is
to `read` the one file and `edit` it (or decline). It has no business reaching
the network or the shell. The cleanest reuse is the **child tool registry** path
from `subagents.ts`: build the child's registry from the parent's tools minus
the spawn/sweep tools (`subagents.ts:210-217` `childRegistryFrom`) **and**
further restrict it to `read` + `edit` only, so the child literally cannot call
`bash` or a net tool — they are absent from its registry. Capability-wise the
child still needs `fs:read` + `fs:write`; we run it against the parent's manager
for those, but the *registry* is what removes egress tools — the child simply has
no `bash`/net tool to call. This is the same registry-pruning lever the
`subagents` **recursion guard** already uses in practice (`childRegistryFrom`,
`subagents.ts:210-217`, removes the spawn tools from the child registry so a
child cannot re-spawn). Note this is *not* the approach the readonly-subagent
design endorses: that doc explicitly **declines** tool-pruning as its enforcement
boundary ("denied at call time by the capability layer (the principled
enforcement boundary). Hiding tools from the child's registry is a separate,
optional polish, explicitly out of scope.", `2026-06-21-readonly-subagent.md:33-36`).
We diverge from it deliberately here because a writeable site-child cannot use
that doc's `readOnly` capability lane (it denies `fs:write` — see below), so the
registry is the only confinement lever left to us; the recursion guard is the
precedent that proves it works, not the readonly-subagent doc.

Note: `subagents`' `readOnly` lane (`subagents.ts:202-204`) grants `fs:read`
only and denies `fs:write`, so it is *too* restrictive here — a site-child must
write. So we do **not** reuse `readOnlyCapabilities()`; we instead constrain the
child's **tool set** to `[read, edit]` and let it run with `fs:read`+`fs:write`.

**Residual authority (be precise about the guarantee).** Because the child runs
against the *parent's* capability manager — not a scoped one — it still *holds*
whatever capabilities the parent holds (including `shell:exec`/`net:fetch` if the
parent has them). The confinement here is **defense-by-registry-omission, not
defense-by-capability**: egress is prevented only by the absence of `bash`/net
tools from the child registry, *not* by the capability layer denying those
capabilities. The two failure modes this leaves open: (1) if a tool carrying an
egress capability were ever added to the `[read, edit]` child registry, the
capability layer would *not* stop it (unlike the `readOnly` lane, which would
deny the capability regardless of which tool requested it); (2) the recursion
guard, not a capability denial, is what stops a child re-spawning. This is an
accepted tradeoff — the registry is a closed two-tool set we control — but it is
weaker than capability-scoping and is named again as a residual risk in §8.

**Why (a) rejected.** Full authority on a fanned-out child is gratuitous blast
radius: a too-broad regex would spawn many full-authority children, any of which
could run a shell command or exfiltrate. Least privilege is EAgent's stated
security posture ("capabilities are the security vocabulary"); a site editor
needs read+edit and nothing more.

### D4 — Capability surface: reuse vs. new

**Problem.** What capabilities does `sweep_edit` declare?

**Options.**
(a) Introduce a new capability (e.g. `edit:sweep`).
(b) Reuse `fs:write` (the edits) + `agent:spawn` (the children).

**Choice: (b) — reuse `fs:write` + `agent:spawn`.** The two authorities the tool
actually exercises already have names: it mutates files (`fs:write`, granted by
`core-tools.ts:46`) and it spawns children (`agent:spawn`, granted by
`subagents.ts:44`). Declaring `capabilities: ["fs:write", "agent:spawn"]` makes
the dispatcher enforce both before `execute` runs
(`agent.ts:331-333`), and `activate` grants both via `e.grantCapability`
(`extension.ts:233`).

**Why (a) rejected.** A new capability string would fragment the policy
vocabulary for no gain: a host that already trusts the agent to write files and
spawn agents has, by construction, authorized everything `sweep_edit` does.
Inventing `edit:sweep` forces every host policy to learn a new word that adds no
authority distinction. The `readonly-subagent` design set this precedent
explicitly ("No new capability string", `2026-06-21-readonly-subagent.md:40-41`).

### D5 — Cap on breadth (max sites) — threshold decision

**Problem.** A too-broad regex (e.g. `.`) could match hundreds of files and spawn
an unbounded number of children — a cost and blast-radius bomb.

**Options.**
(a) No cap — spawn one child per matched file, however many.
(b) A default `maxSites` cap (proposed default **50**), overridable per call,
that truncates the worklist and **logs** when it truncates.

**Choice: (b) — a default cap of 50, with a no-silent-cap log.** `search`'s grep
already caps *matches* at 100 (`RESULT_CAP`, `search.ts:19`), but matches are
lines, not files, and 100 line-matches can still be many distinct files; we want
a cap on **files = children spawned**. 50 is a conservative default (a real
rename touches tens of files, not hundreds); it is an explicit constant, not a
magic literal buried in a loop, and it is overridable via a `maxSites` parameter
for the rare legitimate wide sweep. When the worklist is truncated, the tool
**emits a warning via `e.log.warn`** and includes a `truncated: true` field in
the returned summary — so a truncation is never silent (consistent with
`search`'s visible truncation marker, `search.ts:122-124`).

**Why (a) rejected.** Unbounded fan-out is the single largest risk of this
primitive: a careless regex could spawn hundreds of model calls in one tool
invocation. A cap is the cheapest, most legible guard, and logging the
truncation preserves the operator's ability to notice and widen deliberately
(the "no-silent-cap" rule). The threshold of 50 is justified above; making it a
named, overridable constant keeps it tunable without code changes per call.

### D6 — Per-site failure handling

**Problem.** A child errors (its `edit` fails, it throws, it times out). Does the
whole sweep fail?

**Options.**
(a) First child error aborts the entire sweep.
(b) A child error fails **only that site** — recorded as `{status: "error"}` —
and the sweep proceeds.

**Choice: (b) — isolate failures per site.** Each child runs inside a try/catch;
on throw or on a child whose final text signals failure, that site's summary
entry is `{file, status: "error", note}` and the other sites are unaffected.
This is the natural consequence of D2's per-site isolation and matches how the
agent loop already wraps a single tool call so one failure becomes an error
*result*, not a crash (`agent.ts:295-306`).

**Why (a) rejected.** A whole-sweep abort on one bad file is hostile: the user
loses all the successful edits because file #7 had an odd encoding. Per-site
isolation means a sweep is partial-progress-safe and the structured summary tells
the model exactly which sites need a follow-up.

### D7 — Return shape (format choice; non-behavioral)

The tool returns a JSON-serialized array of `{file, status: "edited" | "declined"
| "error", note}` plus a header line with totals and the `truncated` flag. This
is a pure string/format choice — a structured, machine-and-model-legible summary
the model can act on — and self-justifies as the most legible shape; no behavior
hinges on it.

## 5. Dependencies and Assumptions

- **`search` extension must be loaded** (provides the `grep` tool `sweep_edit`
  resolves). The tool checks `e.agent.tools.get("grep")` at call time and returns
  a clear error result if absent — it does not silently no-op. In the canonical
  builtin set both `search` and `core-tools` load before this; tests load them
  explicitly via `host.use`.
- **`core-tools` must be loaded** (provides the `read` + `edit` tools the child
  registry is built from). Same call-time check + clear error if missing.
- Assumes `EAGENT_WORKSPACE`/cwd confinement is the trust boundary for file
  access — `sweep_edit` inherits it transitively through `grep` and `edit`
  (`search.ts:25-46`, `core-tools.ts:22-38`), so it cannot reach outside the
  workspace even though it composes them.
- Assumes the `Agent` constructor surface (`providers`, `capabilities`, `ui`,
  `logger`, `model`, `provider`, `systemPrompt`, `maxTurns`, `tools`) is stable —
  it is the same surface `subagents.ts:59-70` uses.
- ESM with `.js` import specifiers; strict TS (`noUncheckedIndexedAccess`, no
  `any`); zero new runtime deps. Offline `node:test` only.

## 6. Relationship with Existing Designs

Closest existing files (all read to ground this design):

- **`src/extensions/search.ts`** — the grep/glob enumeration this **reuses**
  (via the registered `grep` tool) for confined, pure-Node site discovery. No
  conflict: `sweep_edit` is a *consumer* of `grep`, adds no second walker.
- **`src/extensions/subagents.ts`** — the spawn mechanism this **reuses**
  (`Agent` construction at `:59-70`, `childRegistryFrom` recursion guard at
  `:210-217`, `finalText` harvesting at `:227-235`). `sweep_edit` adds its own
  tool but spawns children the same way. The `readOnly` lane (`:202-204`) is
  cited but **deliberately not reused** (D3): a site-child must write.
- **`src/extensions/dynamic-workflow.ts`** — the explicit **contrast**.
  `dynamic-workflow` runs a *model-emitted* DAG (`:1-22`); `sweep_edit` derives a
  *flat, enumerated* worklist from a regex. No `${id}` substitution, no `needs`
  edges, no heterogeneous steps. Marked as a non-goal in §3.
- **`src/extensions/core-tools.ts`** (`edit` at `:121-192`) and
  **`src/extensions/edit-match.ts`** (`locateEdit`) — the single-file edit
  primitive the child **reuses** unchanged. `sweep_edit` does not touch edit
  matching; it only routes which file each child edits.
- **`docs/design/2026-06-21-readonly-subagent.md`** — the precedent for "no new
  capability string, compose existing primitives" (cited in D4). D3 cites it as a
  *contrast*, not a precedent: that doc makes the **capability layer** its
  enforcement boundary and explicitly puts registry-pruning out of scope, whereas
  `sweep_edit` does the opposite (registry omission, because a writeable child
  cannot use its `readOnly` capability lane). The registry-pruning precedent
  `sweep_edit` actually relies on is the `subagents` recursion guard
  (`childRegistryFrom`), not this doc.

**De-dup statement.** `dynamic-workflow` executes a model-emitted DAG and
`subagents` spawns children on model-written prompts, but **neither derives the
worklist from a regex over the tree**. `sweep_edit` is the missing
auto-enumerate-then-fan-out edit primitive; the enumeration reuses `search`'s
grep and the editing reuses the sub-agent + `edit` tool — it reimplements
neither.

**First-design note:** N/A — this composes several existing extensions; all
relationships are cited above.

## 7. Acceptance Criteria

All automatable offline via `makeHarness` + a scripted `MockProvider`, with a
real temp-file workspace (`EAGENT_WORKSPACE`), loading the extension via
`host.use("sweep-edit", sweepEdit)` alongside `core-tools` and `search`. Each
child is a real `Agent.run`; the `MockProvider` responder branches on the child
system prompt (the `subagents.test.ts:35-48` pattern) to script each child's
`edit`-or-decline.

- **AC1 — enumeration fans one child per matched file.** Seed a temp workspace
  with 3 files matching the pattern + 1 non-matching. Script each child to issue
  an `edit`. Assert the returned summary has exactly 3 entries, all
  `status: "edited"`, and that the 3 files' contents changed on disk while the
  4th is byte-identical. *(Runnable: read each file post-run, `assert.equal` /
  `assert.notEqual` on contents; `assert.equal(summary.length, 3)`.)*

- **AC2 — a site may decline (false-positive tolerance).** Script one child to
  produce a final text that declines (no `edit` call); assert its summary entry
  is `status: "declined"`, that file is unchanged on disk, and the *other* sites
  are still `edited`. *(Runnable: `assert.equal(entry.status, "declined")` +
  `assert.equal(fileUnchanged, true)`.)*

- **AC3 — a child error fails only its site (D6).** Script one child to call
  `edit` with `old` text that is absent (so `edit` fails — `core-tools.ts:181`)
  and never recover; assert that site is `status: "error"`, its note carries the
  failure, and the remaining sites are still `edited`. *(Runnable:
  `assert.equal(entry.status, "error")` + assert the other entries `=== "edited"`
  + the sweep itself did not throw.)*

- **AC4 — capability gating (D4).** `sweep_edit` declares `capabilities:
  ["fs:write", "agent:spawn"]`, and the dispatcher enforces them before any child
  runs. A `fallback: "deny"` harness alone cannot demonstrate the denial here:
  loading `core-tools`+`search`+`sweep-edit` (required for `sweep_edit` to
  function at all) *grants* both `fs:write` (`core-tools.ts:46`) and `agent:spawn`
  (`subagents.ts:44` plus this extension's own `activate`, D4), and a matching
  grant short-circuits `require` *before* the fallback-deny path
  (`capabilities.ts:90-92` returns ahead of `:106-108`) — so the dispatcher would
  *allow*, not deny. (This is unlike the `bash`/`shell:exec` precedent in
  `core-tools.test.ts:146-152`, which only denies because `core-tools`
  deliberately does **not** grant `shell:exec` — `core-tools.ts:47-48`.) Instead,
  assert the gate two satisfiable ways: **(a)** add an explicit `deny` rule for
  one declared capability (a `deny` rule takes precedence over any grant,
  `capabilities.ts:86-88`). `makeHarness` forwards only `fallback`, so build the
  agent directly with a `new CapabilityManager({ deny: ["agent:spawn"] })` (the
  `cassette.test.ts:70-72` / `capabilities.test.ts:21` direct-construction
  pattern), load `core-tools`+`search`+`sweep-edit`, invoke `sweep_edit`, and
  assert the `tool_result` block is `isError` (denied at the dispatcher before any
  child runs); **and (b)** assert
  the tool spec's declared capability array directly:
  `assert.deepEqual(agent.tools.get("sweep_edit").capabilities, ["fs:write",
  "agent:spawn"])`, so the contract the dispatcher reads from
  (`agent.ts:331-333`) is pinned. *(Runnable: (a) `assert.equal(isError, true)` on
  the `tool_result` block under the deny rule; (b) `assert.deepEqual` on the spec
  `capabilities`.)*

- **AC5 — child is scoped to read+edit (D3).** Script a child to attempt a `bash`
  call; assert it resolves to an `Unknown tool` error (the tool is absent from
  the child's registry), the child's site still completes, and no shell ran.
  *(Runnable: assert the child transcript contains an `Unknown tool: bash`
  result; the `subagents.test.ts:174-214` recursion-guard pattern.)*

- **AC6 — max-sites cap truncates and logs (D5).** Seed `maxSites + 1` matching
  files; pass a small `maxSites` (e.g. 2). Assert exactly `maxSites` children ran
  (summary length === 2), the returned object has `truncated: true`, and a
  warning was emitted (capture via a `logger` whose `warn` pushes to an array,
  per `helpers.ts:9-14`). *(Runnable: `assert.equal(summary.length, 2)`,
  `assert.equal(truncated, true)`, `assert.ok(warnings.some(/truncat/i))`.)*

- **AC7 — missing dependency yields a clear error, not a crash (Dep §5).** Load
  `sweep-edit` *without* `search`; invoke `sweep_edit`; assert the result
  `isError` with a message naming the missing `grep` tool. *(Runnable:
  `assert.match(content, /grep/)` + `assert.equal(isError, true)`.)*

- **AC8 — kill switch.** With `EAGENT_SWEEP_EDIT=off`, `host.use(...)` then assert
  `agent.tools.has("sweep_edit") === false` and no `/sweeps` command registered.
  *(Runnable: `assert.equal(agent.tools.has("sweep_edit"), false)`.)*

- **AC9 — clean teardown.** `host.unload("sweep-edit")` removes the `sweep_edit`
  tool and `/sweeps` command and does not throw. *(Runnable: `await
  host.unload(...)` then `assert.equal(agent.tools.has("sweep_edit"), false)`.)*

- **AC10 — suite green.** `npm test` exit 0 and `npm run typecheck` exit 0 with
  the new test file included.

## 8. Risks and Rollback

- **Risk: a too-broad regex spawns many children (cost + blast radius).**
  Mitigated by the `maxSites` cap with a visible truncation log (D5), by the
  shared instruction letting each child decline (D2), and by the tool being
  opt-in — it only runs when the model explicitly calls `sweep_edit`.
- **Risk: a child mis-edits a file.** Mitigated by per-site isolation (a bad edit
  is contained to one file, D2/D6), the constrained child registry (read+edit
  only, no `bash`/net tool present, D3), and the fact that every change is
  reviewable in git afterward.
- **Risk: residual child authority — confinement is by registry omission, not
  capability (D3).** The site-child runs against the parent's capability manager,
  so it still *holds* the parent's grants (including `shell:exec`/`net:fetch` if
  the parent has them); egress is blocked only because no `bash`/net tool exists
  in its `[read, edit]` registry, not because the capability layer would deny it.
  AC5 reflects this scope precisely — it asserts `bash` is *absent from the
  registry* (an `Unknown tool` result), **not** that the capability layer denies a
  shell/net call. The residual exposure: if a tool carrying an egress capability
  ever leaked into the child registry, nothing in this design's enforcement path
  would stop it. Mitigated by keeping the child registry a closed, audited
  two-tool set (`[read, edit]`, built once in `sweep-edit.ts`, never extended from
  caller input) and by the recursion guard that already removes spawn tools; the
  stronger `readOnly` capability lane is unavailable because a site-child must
  write (D3). This is an accepted, named tradeoff, not a guarantee that the child
  is capability-confined.
- **Risk: cost of N sub-agents (N model calls per sweep).** Mitigated by the cap,
  the opt-in nature, and the small per-child `maxTurns` bound (a child either
  edits in one or two turns or declines). The structured summary lets the model
  decide whether a second narrower sweep is worth it rather than blindly retrying.
- **Risk: enumeration drift from `search`.** Avoided by *reusing* the registered
  `grep` tool rather than copying its traversal (D1) — there is exactly one
  confined walker.
- **Risk: divergence from BUILTIN_EXTENSIONS during batch deferral.** Tests load
  the extension directly via `host.use` and do not depend on registration, so the
  extension is fully validated before the batch-integration step wires it in.

**Kill switch.** `EAGENT_SWEEP_EDIT=off` — when set, `activate` registers no tool
and no command and returns a no-op dispose, mirroring `recovery.ts:103`.

**Rollback.** The tool is purely registered state with no persistence: it writes
no config, opens no store keys, and starts no background work. `host.unload(
"sweep-edit")` (or removing it from the builtin set after batch integration)
removes the tool and command cleanly via the tracked-disposable teardown
(`extension.ts:218-255`); there is nothing to migrate or clean up.
