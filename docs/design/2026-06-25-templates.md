# Design: Agent Templates

Slug: `2026-06-25-templates`
Status: draft (L1)

## 1. Background and Purpose

EAgent can already construct a specialized agent: the `Agent` constructor
(`src/kernel/agent.ts:38-53`, `AgentOptions`) takes a `systemPrompt`, `model`,
`provider`, `thinking`, `maxTurns`, a `tools` registry, and a `capabilities`
manager, and `subagents.ts` already builds fully-configured child agents from
exactly this shape (`src/extensions/subagents.ts:77-113`). But there is **no way
to name, save, reuse, or compose** such a configuration. Every specialization is
hand-assembled inline and thrown away.

A **template** is a named, file-based, reusable specification of a
domain-tailored agent — a system prompt plus a tool allow-list, capability
scope, and model/run settings — that can **inherit** from another template and
be **applied** two ways: spawned as an isolated sub-agent (*delegate*) or used to
reconfigure the current session agent (*become*).

If we do not do this: domain specialists remain copy-paste prompt strings with no
reuse; there is no inheritance, so shared traits (a house style, a safe tool
subset) are duplicated; and the eventual goal — **orchestrating multi-agent
teams** — has no unit to orchestrate. Templates are the missing noun. This cycle
delivers the noun; team orchestration (the verb) is a separate follow-up cycle
that consumes it (see §3 Scope Boundary).

## 2. Deliverables

- [ ] `src/extensions/templates.ts` — a single extension exporting pure,
  offline-testable functions (`parseTemplate`, `validateTemplate`,
  `scanTemplates`, `resolveTemplate`, `injectCatalog`, `templateChildRegistry`)
  plus a default `activate(e)` that registers: an **opt-in** tier-1
  `transformContext` catalog injector (default off; §4.6), a `spawn_template`
  tool (delegate; §4.5), a `beforeToolCall` allow-list veto for the *become* path
  (registered once at activate, inert until a template is active; §4.5), and a
  `/template` command (with `/templates` alias) for `list` / `show` / `use` /
  `reset` / `catalog on|off`.
- [ ] `templates` registered in `BUILTIN_EXTENSIONS` (`src/host.ts`), placed
  immediately **after `dynamic-workflow`** so the `subagents` →
  `dynamic-workflow` multi-agent pair stays adjacent. `templates` registers only
  new names (`spawn_template`, `/template`) and shadows nothing, so placement
  after the cluster is safe.
- [ ] `test/templates.test.ts` — offline `node:test`/`tsx`/`MockProvider` suite,
  AC-numbered, covering every Acceptance Criterion in §7.
- [ ] `README.md` — one extension-table row (in the built-in-extensions table
  whose header is `| Extension | What it adds | Commands | Capability |`;
  Capability column = `agent:spawn`, the delegate gate — *become* adds no
  capability), and the three `44`→`45` count updates (`README.md:337`,
  `CLAUDE.md:65`, `CLAUDE.md:79`).
- [ ] No kernel change; no new npm dependency; no new capability in the kernel
  vocabulary.

## 3. Scope Boundary (NOT in scope)

- **Multi-agent team orchestration** — a coordinator that runs several
  template-backed agents collaboratively, with role hand-off / shared task
  state. This is the explicit **follow-up cycle** that builds on this one. This
  cycle stops at: a template can be *spawned* as one sub-agent, and several can
  be spawned via the existing `spawn_agent` modes by the orchestrating model.
- **Dynamic extension-code loading per template.** The request says templates
  define agents via "prompts, tools, and extensions." This cycle deliberately
  reduces the "extensions" axis to its **safe subset**: a tool allow-list +
  capability scope selecting from already-loaded extensions' tools — a template
  does **not** call `loadExtension` to install new extension *code* (unsafe
  in-process / no-sandbox, heavy). See Decision 4.4. This is a v1 reduction of
  the requested "extensions" axis, not the full feature.
- **A template-authoring tool** (no `template_create`). Templates are authored by
  writing files, exactly like `microagents`. No `skill:write`-style cap is added.
- **Multiple inheritance / mixins.** Single-parent `extends` only (Decision 4.3).
- **Capability *narrowing* for the *become* path.** The live session's
  `CapabilityManager` is additive with no revoke (`capabilities.ts`); *become*
  therefore enforces only the **tool allow-list** (a name filter), not a
  capability filter — tools that remain run under the unchanged live manager.
  True capability sandboxing is a *delegate*-only guarantee (fresh scoped
  manager). See Decision 4.5.
- **`provider` switching on the *become* path.** A template's `provider` override
  is honored only on *delegate* (the child `Agent` is constructed with it).
  *become* deliberately does **not** swap the live session provider mid-run, to
  avoid a surprising provider change underneath an active session. See 4.5.
- **Project/user precedence layering of template directories.** One directory
  with an env override, mirroring `microagents` Decision 4.1 (Decision 4.8).
- **Catalog size-capping / pagination.** When the opt-in catalog is on it lists
  name+description only; templates are expected to be few (Decision 4.6).
- **REPL Tab-completion of `/template`'s sub-words** (`use <name>`, etc.).
  Command-name completion follows the existing registry-driven mechanism in
  `complete.ts`; sub-argument completion is deferred.
- **No quality budget on latency/throughput**: this is not a hot path. The only
  measured quality attribute is per-turn context cost from catalog injection,
  which is opt-in and bounded to name+description (covered by AC-7).

## 4. Key Design Decisions

### 4.1 Ship as an extension, not a kernel primitive

- **Problem:** Where does template logic live?
- **Options:** (a) a new kernel primitive / `AgentTemplate` type in
  `src/kernel/`; (b) a single extension under `src/extensions/`.
- **Choice:** (b) an extension. **Rationale:** the project's core bet is "new
  behavior is always an extension, never a core fork"; the kernel is pinned under
  a 2,200-line ceiling (`test/kernel-surface.test.ts`) and exposes exactly the
  seam a template needs (`AgentOptions`, the public mutable `agent.systemPrompt`/
  `agent.model`/`agent.thinking`/`agent.maxTurns` re-read each turn, and the
  `transformContext` + `beforeToolCall` hooks). **Reject (a):** adds a primitive
  for policy that composes entirely from existing primitives — a direct
  philosophy violation and a ceiling risk, with zero capability gained.

### 4.2 File-based frontmatter + markdown definition

- **Problem:** What is a template, on disk?
- **Options:** (a) a markdown file with single-line frontmatter + body;
  (b) programmatic registration via a new API/tool; (c) store-backed JSON.
- **Choice:** (a). A flat file `<name>.md` under the templates directory. The
  frontmatter is read with the **same generic single-line `key: value` parser**
  that `skills.ts` exposes (`parseFrontmatter`, `skills.ts:160-171`; zero YAML
  dependency); the markdown body **is the system prompt**. Validation is a
  templates-specific scan-time check (Decision 4.9) — **not** skills'
  `validateFrontmatter`, whose allowed-key set
  (`{name, description, allowed-tools, triggers}`, `skills.ts:174`) would reject
  every template field. **Rationale:** mirrors the two closest analogs
  (`skills.ts`, `microagents.ts`), is inspectable as data, hot-reloads, composes
  by reference, and adds no dependency. **Reject (b):** not inspectable, diverges
  from the house pattern, harder to compose. **Reject (c):** templates are
  author-edited artifacts, not agent-written state; files are diff-able and
  shareable. Flat `<name>.md` (not a `skills`-style folder) because a template
  carries no scripts — it is pure definition (mirrors `microagents`).

  **Frontmatter fields** (all optional except `name`, `description`; comma lists
  parsed from a single line):

  | key            | type                  | meaning |
  | -------------- | --------------------- | ------- |
  | `name`         | kebab-case str        | template id (required; validated, 4.9) |
  | `description`  | str                   | one line for the catalog (required; validated, 4.9) |
  | `extends`      | str                   | parent template name (single inheritance) |
  | `model`        | str                   | model override |
  | `provider`     | str                   | registered provider name (delegate-only; 4.5) |
  | `thinking`     | `off`/`low`/`medium`/`high` | reasoning effort (the exact `ThinkingLevel` tokens, `types.ts:194`) |
  | `maxTurns`     | positive integer      | loop bound |
  | `tools`        | comma list            | tool-name allow-list |
  | `capabilities` | comma list            | capability-pattern allow-list (delegate; author-declared grant, 4.4) |

  The markdown body (after the closing `---`) is the domain system prompt.

### 4.3 Single inheritance with a typed merge

- **Problem:** How does composition/inheritance work? (User chose "inherit".)
- **Options:** (a) single `extends: parent` with field override; (b) multiple
  `extends: [a, b]` mixins; (c) reference-only (link, never merge config).
- **Choice:** (a). `resolveTemplate` walks the single-parent chain root→leaf and
  merges with fixed rules: **scalars** (`model`, `provider`, `thinking`,
  `maxTurns`) — child value wins when set, else inherited; **list fields**
  (`tools`, `capabilities`) — **union** (parent ∪ child, de-duplicated, order
  stable); **system prompt** — **concatenation** in root-first order across the
  whole chain (root body, then each descendant body, each separated by a blank
  line `"\n\n"`), so a child refines a base persona. **Rationale:** predictable,
  covers the stated reuse cases (shared house style, shared safe tool subset),
  trivial to specify and test. **Reject (b):** merge order and conflict
  resolution across multiple parents is subtle and unrequested (Simplicity
  First). **Reject (c):** does not satisfy "inheriting"; reuse would still be
  copy-paste. **Cycle / depth safety:** the walk carries a visited-set; a cycle
  (`a→b→a`) or an unknown parent returns a typed resolution **error result**
  (never throws, never loops) — see AC-5, AC-6. The concatenation contract is
  **new** (subagents replaces, not concatenates); AC-4's `"\n\n"` separator and
  root-first order are the authoritative spec.

### 4.4 "Extensions" realized as tool allow-list + capability scope (a v1 reduction)

- **Problem:** The request lists "tools, and extensions." The kernel has no
  "extensions attached to an agent" concept; tool visibility is the active
  registry, and extension *code* is loaded process-wide. What does a template
  control?
- **Options:** (a) a template names extensions and the host `loadExtension`s
  their code when applied; (b) a template selects, by name, a **subset of the
  tools already provided by loaded extensions**, plus a capability scope;
  (c) both.
- **Choice:** (b). A template's `tools` field is an allow-list over the live
  registry; its `capabilities` field scopes authority on the delegate path.
  **Rationale:** `loadExtension` runs arbitrary code in-process with no sandbox
  (`extension.ts:16-23` documents the host enforces only the capability layer) —
  having a *data file* trigger code loading is a security and complexity
  escalation that the foundation cycle must not take on. Selecting from
  already-loaded tools delivers the user-visible outcome ("this specialist can
  only read and search") safely and immediately. **Reject (a)/(c):** unsafe,
  heavy, and beyond the foundation scope; deferred. **This is a deliberate v1
  reduction of the requested "extensions" axis to its safe subset, surfaced here
  and in §3 — not a claim that templates fully satisfy that axis.**
- **Capability trust model.** A template file's `capabilities` list is an
  **author-declared grant**: on the delegate path it constructs a fresh
  deny-fallback `CapabilityManager` that **grants exactly those patterns**
  (`scopedCapabilities`, `subagents.ts:293`). Like a sub-agent allow-list, it can
  therefore name a capability the current session would deny — so it *scopes
  relative to inherit-everything*, but does **not** "never grant". This is
  intended: template files are author-trusted on disk, exactly like skills and
  microagents.

### 4.5 Two application paths over one resolver: delegate + become

- **Problem:** How is a resolved template applied? (User chose "both".)
- **Options:** (a) delegate only (spawn a sub-agent); (b) become only
  (reconfigure the session agent); (c) both, sharing one `resolveTemplate`.
- **Choice:** (c).
  - **Delegate** — the `spawn_template` tool builds a fresh child `Agent`
    (as `subagents.ts:77-113` does) with the resolved `systemPrompt`/`model`/
    `provider`/`thinking`/`maxTurns`, a **filtered child tool registry**
    (`templateChildRegistry`, §below), and a **scoped capability manager** when
    `capabilities` is set (reusing `scopedCapabilities`, exported at
    `subagents.ts:293`), else the parent manager. Runs the child on a `prompt`;
    returns its final answer. A capability set ⇒ a genuine sandbox.
  - **Become** — `/template use <name>` mutates the live agent's public fields
    `systemPrompt`, `model`, `thinking`, `maxTurns` (each re-read every turn —
    exactly how `routing` rides `agent.model`; `agent.ts:71-76,277-282`). It does
    **not** change `agent.providerName` (provider is delegate-only; §3). It saves
    the **pristine baseline once** (the first `use` records the original four
    fields; a later `use` overwrites the active config but must **not** re-record
    the baseline, so `reset` always returns to pristine — AC-10). `/template
    reset` restores the baseline.
- **The become veto** is a single `beforeToolCall` listener **registered once at
  activate** and gated by module-scope active-template state (inert while no
  template is active — the same inert-until-set discipline as `agent.forceTool`,
  and the early-return-when-inactive shape of `write-guard.ts:74`). While a
  template with a `tools` allow-list is active it **blocks any tool not in the
  allow-list** (a name filter). Allow-listed tools that remain run under the
  **unchanged live capability manager** — *become* reduces the tool *set*, not
  the authority of the tools that survive. `/template show` prints both the
  blocked-by-default note and "allowed tools keep full session capabilities — for
  true scoping, use delegate". The veto state is **module-scoped (per process)**,
  which is correct for the single-agent CLI/REPL host; a multi-session server
  would need session-scoped state (deferred).
- **`templateChildRegistry(parentTools, allowlist)`** is a **new templates-local**
  pure function (not subagents' `childRegistryFrom`, which strips only
  `spawn_agent`). In one pass it keeps a tool iff `(allowlist is empty OR
  name ∈ allowlist)` **and** `name ∉ {spawn_agent, spawn_template}`. Stripping
  **both** spawn-tool names is the recursion guard for the delegate path; it must
  not be delegated to `childRegistryFrom` (which would miss `spawn_template`).
- **Rationale:** one resolver, two thin adapters; delegate is the substrate the
  team-orchestration follow-up consumes; become is the cheapest live demo.
  **Reject (a)/(b):** the user asked for both, and the incremental cost over one
  is two small wrappers.

### 4.6 Opt-in tier-1 catalog discovery via `transformContext`

- **Problem:** For the orchestrating model to autonomously call `spawn_template`,
  it must know which templates exist — but a foundation cycle should not impose a
  standing per-turn token cost before team orchestration exists to consume it.
- **Options:** (a) inject a name+description catalog every turn (skills' tier-1
  pattern, always on); (b) inject the catalog **opt-in** (default off via a store
  flag toggled by `/template catalog on`), with discovery-by-error as the
  always-on fallback; (c) no model-facing discovery at all.
- **Choice:** (b). By default no catalog is injected (zero standing cost). The
  human discovers templates via `/templates`; the model discovers them via
  `spawn_template`'s error on an **unknown name**, which lists the available
  template names. Turning the catalog **on** (`/template catalog on`, persisted in
  `e.store`) makes `injectCatalog` prepend one ephemeral `system` message listing
  `- <name>: <description>` per template — for fully autonomous orchestration.
  `injectCatalog` returns the message array **by reference** (no allocation) when
  the flag is off, the kill switch is off, or there are no templates (the
  `skills`/`microagents` no-op shape). **Rationale:** mirrors the opt-in
  convention (`compact` ships off: `/compact on` + `EAGENT_COMPACT=off`) and pays
  the per-turn cost only when the consuming behavior is wanted, while still
  letting a switched-on model self-discover. **Reject (a):** standing per-turn
  cost before orchestration exists — against Simplicity First. **Reject (c):** a
  blind model never learns templates exist; discovery-by-error needs *some* path
  to a first `spawn_template` call, which the tool description provides, but a
  catalog is the proper autonomous-discovery surface when enabled. No size cap in
  v1 (templates expected few; deferred, §3).

### 4.7 Reuse `agent:spawn`; add no new capability

- **Problem:** Does templates need new capabilities?
- **Options:** (a) add `template:read`/`template:write`; (b) reuse the existing
  vocabulary.
- **Choice:** (b). Reading template files is `fs:read` (host pre-granted);
  `spawn_template` declares `capabilities: ["agent:spawn"]` and the extension
  `grantCapability("agent:spawn")`, exactly like `subagents`. **Rationale:** the
  in-use capability set is deliberately fixed (CLAUDE.md); there is no authoring
  tool, so no write authority is needed. **Reject (a):** expands the security
  vocabulary for no new authority.

### 4.8 One templates directory with an env override

- **Problem:** Where are templates found?
- **Options:** (a) layered project+user dirs with precedence; (b) a single dir
  with an env override.
- **Choice:** (b). `EAGENT_TEMPLATES_DIR ?? join(homedir(), ".eagent",
  "templates")`, an exact match to `skills.ts` `skillsRoot()` (`skills.ts:33`);
  it mirrors `microagents` only in *structure* (one dir + one env override), not
  base path (microagents roots at the workspace). **Rationale:** Simplicity
  First — no layering knob is needed yet.
  **Reject (a):** unrequested complexity; can be added later without breaking the
  format.

### 4.9 Validate frontmatter at scan time (templates has no authoring boundary)

- **Problem:** `skills` sanitizes frontmatter (kebab-case `name`; `description`
  must contain no `<`/`>` — the hidden-tag injection vector, `skills.ts:203`)
  **only at its `skill_create` authoring boundary** (`skills.ts:107`); its *read*
  path `scanSkills` does **not** validate. Templates has **no authoring tool**
  (files only, §3), so there is no author boundary — and a template `description`
  flows into the model context via the opt-in catalog (4.6). An unsanitized
  `<`-bearing description is exactly the injection skills guards against.
- **Options:** (a) validate at **scan time** and skip invalid files (like
  `scanSkills` skips an unreadable folder); (b) trust on-disk files, no
  validation; (c) validate only at an authoring boundary (does not exist here).
- **Choice:** (a). `scanTemplates` admits a file only if `validateTemplate`
  passes: `name` kebab-case `^[a-z0-9]+(-[a-z0-9]+)*$` (≤64); `description`
  non-empty (≤1024) with no `<`/`>`; `thinking` ∈ `{off,low,medium,high}` if
  present; `maxTurns` a positive integer if present; unknown keys rejected
  (allowed set = the 4.2 fields). A failing file is **skipped with a logged
  warning** — never admitted to the catalog or resolver, never fatal. **Trade-off
  — strict-skip vs lenient-sanitize:** strict-skip is chosen (an invalid template
  is invisible, a clear and testable contract) over admitting-then-sanitizing
  (which hides authoring mistakes silently); the logged warning keeps a typo from
  vanishing without trace. **Reject (b):** re-opens the angle-bracket injection
  vector and lets malformed templates corrupt resolution. **Reject (c):** no
  authoring boundary exists. An `extends` pointing at a skipped (invalid) parent
  surfaces as the unknown-parent error (AC-6).

## 5. Dependencies and Assumptions

- **Runtime:** Node `fs`/`os`/`path` only; zero new npm deps (house rule).
- **Reused exports:** `scopedCapabilities` is a **public exported helper** of
  `subagents.ts` (`subagents.ts:293`); this design is its second direct consumer
  (it is currently called only inside `subagents.ts`). `subagents.ts` is already
  an export hub for sibling extensions — `dynamic-workflow` consumes its
  `resolveChildCapabilities`/`resolveChildProvider`/`resolveOutputSchema`/
  `runTypedChild` (`dynamic-workflow.ts:31-37`) — which establishes the
  cross-extension-reuse precedent (but note `dynamic-workflow` does **not** import
  `scopedCapabilities` directly). Also: `Agent` from `src/kernel/agent.js`;
  `defineTool`/`ok`/`fail` from `src/kernel/define.js`. `validate` is **not**
  needed (no typed-return contract in v1 — deferred).
- **Assumption (verified):** `agent.systemPrompt`/`model`/`thinking`/`maxTurns`
  are public mutable fields re-read each turn (`agent.ts:71-76`; used in the
  request at `agent.ts:277-282`); `agent.providerName` (the field name — *not*
  `agent.provider`) is likewise public (`agent.ts:73`) and looked up each turn via
  `this.providers.get(this.providerName)` (`agent.ts:267`), but *become* leaves it
  untouched by design (§3, 4.5). `routing` already mutates `agent.model` live,
  establishing the pattern.
- **Assumption:** `beforeToolCall` returns a decision that can block a call with a
  reason (the `ToolDecision`/filter shape, `events.ts:50-66`; veto exemplar
  `write-guard.ts:74-87`); the veto reads module-scope active-template state.
- **Format assumption:** single-line frontmatter; comma-separated lists on one
  line (no nested YAML), consistent with `skills.ts:160-171`.

## 6. Relationship with Existing Designs

- **`docs/design/2026-06-22-microagents.md`** (closed) — adopted patterns:
  frontmatter + markdown via the shared single-line parser (its §4.4),
  `transformContext` injection with by-reference no-op (its §4.2/§4.5 spirit),
  `EAGENT_<NAME>=off` kill switch, single-dir + env override (its §4.1). No
  conflict.
- **`docs/design/2026-06-22-subagents-least-privilege.md`** (closed) — this
  design **reuses** its exported `scopedCapabilities` helper (`subagents.ts:293`)
  and its recursion-guard discipline (child registry omits the spawn tool —
  here generalized to omit **both** spawn tools, §4.5). The delegate path is a
  sibling of `spawn_agent`. No conflict; an additive consumer.
- **`src/extensions/skills.ts`** (no design doc; predates the convention) — the
  loading pattern (`skillsRoot()`, `scanSkills`, tier-1 catalog injection, the
  `parseFrontmatter` parser) is the direct template-side model. Note the
  validation difference made explicit in Decision 4.9: skills validates at its
  authoring boundary, templates at scan time.
- **Naming caution (not a conflict):** `src/extensions/prompts.ts` manages
  **text** templates (named strings with `$1`/`$*` placeholders). "Template" in
  *this* design means an **agent** template (prompt + tools + caps + model). The
  two are orthogonal; the README row and docstring say "agent template" to avoid
  drift. No source of truth is in conflict.
- **First agent-template design:** no prior agent-profile/template design exists;
  terminology anchors are CLAUDE.md and the patterns above.

## 7. Acceptance Criteria (each offline-automatable in `test/templates.test.ts`)

- **AC-1 parse:** `parseTemplate(md, "fallback")` returns
  `{name, description, extends?, model?, provider?, thinking?, maxTurns?,
  tools?: string[], capabilities?: string[], systemPrompt}` with frontmatter
  fields read, comma lists split/trimmed, `thinking` carried as one of the exact
  `off/low/medium/high` tokens, `maxTurns` coerced to a number, and `systemPrompt`
  = the body after the closing fence. Malformed input (no fence) degrades to a
  defined result (empty frontmatter / body) — never throws.
- **AC-2 scan + validate:** `scanTemplates(dir)` discovers `*.md` files, returns
  entries sorted by name; a missing directory returns `[]` (no throw); a file
  failing `validateTemplate` — non-kebab `name`, a `<`/`>` in `description`, an
  out-of-set `thinking`, a non-integer `maxTurns`, or an unknown key — is
  **excluded** from the returned catalog (and a warning is logged).
- **AC-3 resolve (no extends):** `resolveTemplate("solo", catalog)` returns the
  template's own fields unchanged.
- **AC-4 resolve (single inherit, 2- and 3-level):** for `child {extends: base}`:
  a scalar set on child overrides base; a scalar absent on child is inherited;
  `tools`/`capabilities` are the de-duplicated union; `systemPrompt` equals
  `base.body + "\n\n" + child.body`. For a 3-level chain `root→mid→leaf`, the
  concatenation is root-first: `root.body + "\n\n" + mid.body + "\n\n" +
  leaf.body`.
- **AC-5 cycle safety:** a cycle (`a extends b`, `b extends a`) resolves to a
  typed error result naming the cycle; the call terminates (no stack overflow /
  infinite loop).
- **AC-6 unknown parent:** `extends: nope` (absent/skipped target) resolves to a
  typed error result naming the missing template; no throw.
- **AC-7 catalog injection (opt-in):** with the catalog flag **on**, ≥1 template,
  and the kill switch on, `injectCatalog(messages, catalog, true)` prepends one
  `system` message (`meta.source === "templates"`, `meta.ephemeral === true`)
  listing `- <name>: <description>` per template; with the flag **off** (default),
  zero templates, **or** `EAGENT_TEMPLATES=off`, it returns the **same array
  reference** (no allocation, no injection).
- **AC-8 kill switch:** with `EAGENT_TEMPLATES=off`: no catalog injection (AC-7),
  `spawn_template` returns an error result stating templates are disabled, and
  `/template use` refuses with a disabled message.
- **AC-9 delegate registry + run:** `templateChildRegistry(parentTools,
  allowlist)` yields a registry containing exactly `allowlist ∩ parentTools`
  **minus** `spawn_agent` and `spawn_template`; an empty/absent allow-list yields
  all parent tools minus those two. A delegated child specifically **cannot** see
  `spawn_template` (recursion guard). End-to-end: `spawn_template` on a template
  with `tools: read` runs a `MockProvider` child and returns its final answer; a
  template with `provider: <registered>` constructs the child with that provider.
- **AC-10 become + reset (incl. use→use→reset):** `/template use <name>` sets
  `agent.systemPrompt`/`model`/`thinking`/`maxTurns` to the resolved values
  (leaving `agent.providerName` unchanged) and the `beforeToolCall` veto blocks a
  tool outside the allow-list (asserted via a blocked decision). A second
  `/template use <other>` applies the new config **without** re-recording the
  baseline. `/template reset` restores the pristine pre-first-`use` values and
  disarms the veto (a previously blocked tool is allowed again).
- **AC-11 registration:** activating `templates` registers exactly one tool
  (`spawn_template`), the `/template` command (+ `/templates` alias), exactly one
  `transformContext` listener, and exactly one `beforeToolCall` listener
  (registered at activate, inert until armed) — asserted via exact harness count
  deltas; `/templates` prints the catalog names and `/template catalog on|off`
  toggles the store flag read by AC-7.
- **AC-12 no regression (meta):** `npm test` exits 0 and `npm run typecheck`
  exits 0 with `templates` in `BUILTIN_EXTENSIONS`; the kernel-surface line
  ceiling is unaffected (extension-only change).

## 8. Risks and Rollback

- **Risk — catalog context bloat** if a user has many templates. *Mitigation:*
  the catalog is **opt-in (default off)** so there is no standing per-turn cost;
  when on it is name+description only; `EAGENT_TEMPLATES=off` hard-disables.
  *Deferred:* a size cap (§3). *Rollback:* leave the catalog off, set the kill
  switch, or drop the row from `BUILTIN_EXTENSIONS`.
- **Risk — become veto over-blocks** a tool the user needs mid-session.
  *Mitigation:* the veto is armed only while a template with a `tools` allow-list
  is active; `/template reset` disarms instantly. *Rollback:* reset or kill
  switch.
- **Risk — false sense of sandboxing on become** (capabilities not narrowed; the
  allow-list is a name filter, so allow-listed tools keep full session
  authority). *Mitigation:* documented asymmetry (Decision 4.5, §3); `/template
  show` prints what is and isn't enforced and points to delegate for true
  scoping; delegate is the genuine sandbox.
- **Risk — frontmatter injection / malformed file** (`<`-bearing description into
  the catalog; bad fields). *Mitigation:* scan-time `validateTemplate`
  (Decision 4.9, AC-2) skips invalid files with a warning before they reach the
  catalog or resolver.
- **Risk — runaway recursion** via template-spawned agents. *Mitigation:*
  `templateChildRegistry` strips **both** spawn tools (AC-9), so a child cannot
  re-spawn.
- **Risk — inheritance cycle.** *Mitigation:* visited-set cycle detection and a
  typed error result (AC-5), with graceful unknown-parent handling (AC-6).
- **Risk — module-scoped become state** in a hypothetical multi-session host.
  *Mitigation:* acceptable for the single-agent CLI/REPL (the only current host);
  session-scoped state is deferred and noted (§4.5).
- **Overall rollback:** the change is one extension file + one
  `BUILTIN_EXTENSIONS` line + docs; remove the line (or `EAGENT_TEMPLATES=off`)
  to fully disable. No kernel change to revert.
