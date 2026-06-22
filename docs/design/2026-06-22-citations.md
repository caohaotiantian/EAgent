# citations — tag retrieval outputs with stable ids and validate answer [id] markers

Status: open
Closing-commit: TBD
Closed-on: TBD
Deferred: host.ts registration + CLAUDE.md/README inventory (batch integration)

Design author: EAgent design team · Date: 2026-06-22

## 1. Background and Purpose

EAgent has no grounding or attribution mechanism. When the model answers from
content a retrieval tool returned — a fetched web page (`web` → `net:fetch`,
`src/extensions/web.ts:92`), a read file (`fs:read`), or a `glob`/`grep` search
result (`src/extensions/search.ts:132,177`, both `fs:read`) — the resulting
claim is **untraceable back to its source**, and a *hallucinated* citation goes
undetected: the model can write "according to [3]" with no source 3 ever having
existed.

Shipped assistants solve this by assigning **stable ids** to retrieved content
(Comet's `web:3`, dia's `screenshot:1`) that the model can *see*, then requiring
inline `[id]` citations with **zero fabricated ids**. EAgent already labels
foreign tool output for *trust* (`content-guard`, §6) but never assigns a
*citable identity*, and nothing checks that a cited id was actually emitted.

**Purpose.** Add a new `citations` extension — observability only, it never
blocks — that:

1. on `afterToolCall`, tags each **retrieval-tool** output (tools whose
   capabilities intersect a configured retrieval set, default
   `net:fetch` + `fs:read` + the search tools) by prepending a small
   `[src:N]` header line to the result content, and records `N → {tool, locator}`
   in a **per-run** map (reset on `agent_start`); and
2. on `agent_end`, parses the **final assistant answer** for citation markers
   (`[src:N]` / `[N]`) and verifies every cited id was actually emitted this
   run — warning (via `e.log` + a `/citations` report) on any **fabricated id**
   (cited but never emitted), and optionally flagging missing attribution.

It is the **attribution** counterpart to `content-guard`'s **trust** labeling:
both ride `afterToolCall` and tag capability-selected output, and the two
compose on the same result. It requires **zero kernel change** — it reads the
existing `afterToolCall` filter (`src/kernel/events.ts:59-63`), the `agent_start`
/ `agent_end` events (`src/kernel/events.ts:19-20`), and the public transcript
getter `e.agent.messages` (`src/kernel/agent.ts:98-100`).

## 2. Deliverables

- [x] `src/extensions/citations.ts` — the extension: capability-based retrieval
      detection (default `["net:fetch", "fs:read"]` covering `web`, `read`, and
      the `glob`/`grep` search tools, store-overridable via `retrievalCaps`),
      `on("agent_start")` per-run map reset, `afterToolCall` `[src:N]` header
      prepend + `N → {tool, locator}` record, `on("agent_end")` final-answer
      marker parse + fabricated-id warn, `/citations` report command,
      `EAGENT_CITATIONS=off` kill switch + `enabled` store flag, never-throw
      dispose loop.
- [x] `test/citations.test.ts` — offline `node:test` suite driven by
      `makeHarness` + a scripted `MockProvider` whose final answer contains both
      a good and a fabricated `[src:N]` marker, plus inline stub retrieval tools
      loaded directly via `host.use(id, activate)` (the established offline
      pattern, `test/recovery.test.ts:118`, `test/content-guard.test.ts:99`).
      Every acceptance criterion in §7 is a runnable assertion. Does **not**
      depend on the extension being in `BUILTIN_EXTENSIONS`.
- [ ] `src/host.ts` — register `citations` in `BUILTIN_EXTENSIONS`, adjacent to
      `content-guard`/`trace`. **(deferred to batch integration)**
- [x] `/citations` command — registered via `e.registerCommand`: prints the
      per-run report (ids emitted, ids cited, fabricated ids, missing-attribution
      flag) plus the `on|off|status` toggle, mirroring `/content-guard`
      (`src/extensions/content-guard.ts:129-154`).
- [x] Kill switch — `EAGENT_CITATIONS=off` env var (checked at activation) **and**
      an `e.store` `enabled` flag, mirroring `content-guard`
      (`src/extensions/content-guard.ts:103`).
- [ ] CLAUDE.md / README inventory line — one `citations` row reconciled at
      closeout. **(deferred to batch integration; do not bump the README
      extension count in this change.)**

## 3. Scope Boundary (NON-goals — Simplicity First)

- **Not a blocker.** Attribution is advisory. `citations` only warns and reports
  (§ D5). A correct answer is never withheld over a citation nit.
- **No model call.** Unlike `risk-guard`, `citations` never invokes a provider;
  validation is pure string parsing of the final assistant text.
- **No semantic checking.** It does **not** verify that the *claim* near a `[src:N]`
  marker is actually *supported* by source N's content — only that id N was
  emitted. Whether the citation is *apt* is out of scope (that needs an LLM judge;
  rejected as speculative).
- **No content rewriting / sanitization.** It prepends one header line and
  otherwise passes the body through verbatim. Stripping injection vectors is
  `content-guard`'s job (§6); `citations` does not duplicate it.
- **No persistence.** The id map is per-run, in-memory, reset on `agent_start`
  (§ D4). No journal, no disk, no cross-run history.
- **No locator extraction beyond a brief.** The recorded locator is a short
  best-effort string (tool name + a first-line/URL snippet), not a structured
  citation object. Bibliography formatting is out of scope.
- **No enforcement of a citation *style*** (footnotes, brackets, prose). It
  accepts `[src:N]` and `[N]` and nothing else (§ D3 risk mitigation).

## 4. Key Design Decisions

### D1 — Which tools get ids: capability-based vs tool-name list

**Problem.** The extension must decide which tool outputs are "retrieval" and
thus citable. New retrieval tools (a future `web_search`, an MCP fetcher) should
be covered without editing `citations`.

**Options.**
(a) A hard-coded tool-**name** allowlist (`["fetch", "read", "glob", "grep"]`).
(b) A **capability**-based retrieval set: a result is retrieval iff its
producing tool declares an intersecting capability, default
`["net:fetch", "fs:read"]`, store-overridable via `retrievalCaps`.

**Choice: (b), capability-based** — exactly mirroring `content-guard`'s
foreign-cap detection (`src/extensions/content-guard.ts:112-116`:
`e.agent.tools.get(name)?.capabilities ?? []` then `.some(c => caps.includes(c))`).
`net:fetch` covers `web` (`src/extensions/web.ts:92`); `fs:read` covers core
`read` and both search tools (`src/extensions/search.ts:134,179`).

**Why (a) rejected.** A name list is brittle: it silently fails to tag a renamed
or newly-added retrieval tool, and it does not generalize to MCP-provided
fetchers whose names are unknown at design time. Capabilities are EAgent's
security vocabulary and are already how `content-guard` selects the same class of
output — reusing that keeps the two extensions consistent and the retrieval set
overridable at runtime.

### D2 — Id placement: prepend a visible `[src:N]` header vs a side-channel

**Problem.** The id must reach the model so it *can* cite it, and must survive
co-residence with `content-guard`'s fence.

**Options.**
(a) Prepend a `[src:N]` header **line** to the result `content` (model-visible).
(b) Store the id only in `result.details` / a side map (model never sees it).

**Choice: (a), visible header.** The model can only cite an id it sees; this
matches Comet's visible-id approach. The header is a single short line:
`[src:N] <tool> — <locator>\n` prepended to the body.

**Composition with `content-guard` (ordering, justified).** Both ride
`afterToolCall`. Filters compose in registration order
(`src/kernel/extension.ts:232` → `hooks.filter`). To keep the id **outside** any
`<untrusted-content>` envelope and survive fencing, the `[src:N]` header must be
prepended **after** `content-guard` has fenced — i.e. `citations` registers
*after* `content-guard` in load order, so it sees the already-fenced string and
prepends its header to the front, yielding `[src:N] …\n` + `<standing note>` +
`<untrusted-content>…`.

The real composition invariant — and why there is **no double-fence / double-
tag** — is that **a restored tool result never re-enters `afterToolCall`.** Both
filters (`content-guard.fence` and the `[src:N]` prepend) run **only** in live
tool `dispatch` (`agent.ts:303`, `hooks.apply("afterToolCall", …)`). Every
restore path — `session` (`session.ts:127`), `journal` (`journal.ts:118`),
checkpoint — uses `e.agent.load(messages)`, which pushes messages **directly**
into the transcript (`agent.ts:137-139`: `this.#messages.push(…)`) and bypasses
the filter chain entirely. So a result that already carries `[src:N]` ahead of
the standing note is never re-run through either filter, and neither header is
ever re-applied.

This matters because it corrects a tempting but **false** justification: it is
*not* true that the `[src:N]` prepend is harmless to `content-guard`'s
idempotency "because the header is added by `citations`, not re-run through
`fence`." `fence()` keys idempotency **solely** off
`content.startsWith(STANDING_NOTE)` (`content-guard.ts:79`); once an `[src:N]\n`
line sits *ahead* of the standing note, `fence()` would **not** short-circuit and
**would** re-wrap into a double-fence — *if* `afterToolCall` ever re-ran on that
content. It never does (per the invariant above), so the conclusion (no double-
fence) holds — but for the restore-bypass reason, not the wrong "not re-run
through fence" reason.

Consequently, both `content-guard`'s own restore-idempotency check
(`content-guard.ts:76-78`) and `citations`' `[src:`-prefix skip (below, AC14)
are **defensive-only**: there is no live re-filter path either guards against.
They are cheap belt-and-suspenders against a future code path that *did* re-enter
`afterToolCall` on a stored result, and are documented here so the next author
does not assume such a re-filter path exists. The `citations` prepend is made
idempotent (skip if the content already begins with `[src:`) on the same
defensive basis.

**Why (b) rejected.** A side-channel id is invisible to the model, so it cannot
be cited at all — defeating the entire purpose. `details` is explicitly "never
sent to the model" (`src/kernel/types.ts:132`).

### D3 — What to validate: fabricated ids only vs also missing-attribution

**Problem.** Two attribution failures exist: citing an id that was never emitted
(fabrication), and giving a substantive answer that cites *nothing*.

**Options.**
(a) Detect **fabricated ids** only (cited-but-not-emitted).
(b) Detect fabricated ids **and** missing attribution, both as hard warns.
(c) Fabricated ids as the core warn; missing-attribution as an **optional,
off-by-default secondary** flag.

**Choice: (c).** A fabricated source is the real harm — it is a hallucinated
citation presented as grounding, which is actively misleading. That is always
warned. Missing-attribution (a substantive answer that emitted ≥1 retrieval id
but cited none) is a *softer* signal — many valid answers legitimately cite
nothing — so it is computed but gated behind a `warnMissing` store flag, default
**off**, to avoid nagging on every uncited answer.

**Why (a) rejected.** Dropping missing-attribution entirely removes a cheap,
useful signal that the wiring already computes (emitted-set vs cited-set); making
it *optional* costs almost nothing. **Why (b) rejected.** Making
missing-attribution a default warn turns a normal, correct, uncited answer into
noise on most runs — the opposite of useful observability, and it would train
users to ignore the warn channel.

### D4 — Detecting "the final answer" and per-run reset

**Problem.** Validation needs (i) the single piece of text that is the user-facing
answer, and (ii) a clean id map per run.

**Options.**
(a) Validate at `agent_end`, scanning the **last assistant text message** in
`e.agent.messages`; reset the id map on `agent_start`.
(b) Accumulate citations across every assistant message of the run.

**Choice: (a).** The final answer is the last assistant turn's text. At
`agent_end` the assistant message has already been pushed
(`src/kernel/agent.ts:181`) and `e.agent.messages` is a live public getter
(`src/kernel/agent.ts:98-100`), so the handler reads the last `role:"assistant"`
message's `text` block — the exact `lastText(agent)` helper already in the suite
(`test/helpers.ts:47-55`). The per-run id map resets on `agent_start`
(`src/kernel/events.ts:19`), the identical reset pattern `trace` uses
(`src/extensions/trace.ts:99-107` zeroes its span list on `agent_start`).

**Why (b) rejected.** Intermediate assistant turns are scratch reasoning, not the
delivered answer; counting their markers would flag working notes and conflate
"thinking out loud" with the final attributed claim. Scoping to the last text
message matches what the user actually reads.

### D5 — Action on a fabricated id: warn-only vs block

**Problem.** What does the extension *do* when it finds a fabricated citation?

**Options.**
(a) **Warn-only**: `e.log.warn` + record it in the `/citations` report.
(b) **Block / retry**: veto the answer or steer a correction.

**Choice: (a), warn-only.** Attribution is advisory and the fabrication is only
known at `agent_end` — *after* the answer is produced — where there is no clean
block seam anyway (`agent_end` is an observe event, not a filter,
`src/kernel/events.ts:20`). Blocking a substantively-good answer over a citation
nit is the wrong trade; surfacing it is the right one. This mirrors `trace`/
`cost`, which are pure observers.

**Why (b) rejected.** There is no veto point at `agent_end` (it is a
notification, not a `ToolDecision` filter), so "block" would mean a steered retry
loop — a heavyweight, potentially non-terminating intervention for an advisory
property. Out of proportion to the harm; explicitly a NON-goal (§3).

### D6 — Posture + kill switch: off-by-default vs on-by-default

**Problem.** `citations` *changes tool-output formatting* (it prepends a header
line the model sees), unlike pure observers (`trace`, `cost`) that change nothing.

**Options.**
(a) **Off by default**, opt-in via load + `enabled`.
(b) On by default like `content-guard`/`recovery`.

**Choice: (a), off by default.** Because it mutates retrieval output and asks the
model to adopt a citation convention, it is an *opt-in behavior change*, not a
silent safety net — so it should not alter every run's tool output unless the
operator wants citations. (Note: "off by default" here means the run-time
`enabled` store flag defaults to `false` and the README will not mark it
on-by-default; the extension still activates when loaded.) The
`EAGENT_CITATIONS=off` env var is the hard kill switch checked at activation
(returns a no-op disposer), exactly like `content-guard`
(`src/extensions/content-guard.ts:103`).

**Why (b) rejected.** `content-guard` is on-by-default because its fence is a
pure *defensive* wrap the model can ignore; `citations` instead introduces a
*positive* convention (cite these ids) and a header the model is meant to act on,
which is a product choice an operator should opt into. Defaulting it on would
impose a citation style on users who did not ask for one. This is a *format-and-
posture* choice; the `[src:N]` header **string** itself is a non-behavioral
format pick and self-justifies (any short, greppable, unambiguous prefix works —
`[src:` is chosen so the parser's emitted/cited regexes share one stem).

## 5. Dependencies and Assumptions

- **Kernel surfaces used (all existing, no change):**
  - `afterToolCall` filter `(value: ToolResult, ctx: { call: ToolCallBlock }) => ToolResult`
    (`src/kernel/events.ts:59-63`); registered via `e.hook("afterToolCall", …)`
    (`src/kernel/extension.ts:232`).
  - `agent_start` `{ input: Message }` and `agent_end` `{ reason: StopReason }`
    events (`src/kernel/events.ts:19-20`); registered via `e.on(…)`
    (`src/kernel/extension.ts:231`).
  - `e.agent.tools.get(name)?.capabilities` for retrieval detection
    (`src/extensions/content-guard.ts:114`).
  - `e.agent.messages` public getter (`src/kernel/agent.ts:98-100`) for the final
    answer text.
  - `e.store.get/set` for `enabled` / `retrievalCaps` / `warnMissing`
    (`src/extensions/content-guard.ts:105-108`).
  - `e.log.warn`, `e.registerCommand` (`src/kernel/extension.ts:235,230`).
- **Assumptions:**
  - The final answer is the last `role:"assistant"` message's first `text` block
    (`test/helpers.ts:47-55`). If the run ends with no assistant text (e.g. an
    error stop), there is nothing to validate and the handler no-ops.
  - Retrieval tools declare their capabilities truthfully (the kernel's standing
    assumption — capabilities are the security vocabulary).
  - The model cites in `[src:N]` or `[N]` form; other forms are not parsed (a
    deliberate, warn-only risk, § D3 / §8).
- **House rules:** ESM with `.js` specifiers; strict TS
  (`noUncheckedIndexedAccess`, no `any`); zero runtime deps (pure Node string
  ops, no regex deps); offline `node:test`; never-throw dispose loop. No new
  capability is declared — `citations` has no side effect beyond reformatting an
  already-permitted tool result and logging (matching `content-guard`, which
  declares none, `src/extensions/content-guard.ts:14`).

## 6. Relationship with Existing Designs

- **`content-guard` (`src/extensions/content-guard.ts`) — closest sibling.** Same
  `afterToolCall` seam, same capability-based output selection
  (`isForeign`/`foreignCaps` → here `isRetrieval`/`retrievalCaps`), same
  kill-switch posture. **Difference:** `content-guard` fences foreign content for
  *trust* (wrap as "data, not instructions"); `citations` tags retrieval content
  for *attribution* (assign a citable id). They **compose** on the same result
  (D2): `citations` loads *after* `content-guard` so the `[src:N]` header sits
  ahead of the fence. **No conflict** — disjoint concerns, defined ordering, and
  no double-application because a restored result never re-enters `afterToolCall`
  (it is `load`-ed straight into the transcript, `agent.ts:137-139`; the filter
  only fires in live `dispatch`, `agent.ts:303`). Each side's idempotency check
  is defensive-only (D2), not guarding a live re-filter path.
- **`trace` (`src/extensions/trace.ts`) / `journal`.** The event-consumer +
  per-run reset pattern (`on("agent_start")` zeroes per-run state,
  `src/extensions/trace.ts:99-107`). `citations` reuses it for its id map.
- **`cost` (`src/extensions/cost.ts`, `docs/design/2026-06-22-cost.md`).** Same
  pure-observer, `agent_start`-reset / `agent_end`-summary shape. (`cost` itself
  has no kill-switch env var; `citations` takes its `EAGENT_CITATIONS=off` +
  `enabled`-store-flag posture from `content-guard.ts:103,106`, the cited anchor.)
  `cost` measures *spend*; `citations` validates *attribution*.
- **De-duplication.** `content-guard` validates output **trust** (fences foreign
  content). `risk-guard` validates outgoing **calls**. `flow-guard` gates
  **egress**. None validates that a *grounded claim carries a real, non-fabricated
  source id*. `citations` is **attribution validation** — a distinct property.
  (No `output-contract` extension exists in this tree; the closest schema-shape
  validators are absent, so the "validates answer SHAPE vs ATTRIBUTION"
  distinction is noted but has no code to conflict with.)

## 7. Acceptance Criteria

Each is a runnable `node:test` assertion via `makeHarness` + a scripted
`MockProvider`, with inline stub retrieval tools and the extension loaded by
`host.use("citations", activate)`.

- **AC1 (id tagging — header present).** A successful `net:fetch` stub-tool
  result, after a run, carries a `[src:1] ` header line at the front of the
  model-visible `tool_result` content (asserted by reading the first
  `tool_result` block, as in `test/content-guard.test.ts:83-87`).
- **AC2 (capability gate — non-retrieval untouched).** A result from a tool
  declaring only a non-retrieval cap (e.g. `["shell:exec"]`) has **no** `[src:`
  header — byte-identical to the raw content.
- **AC3 (default retrieval caps cover search/read).** A stub tool declaring
  `["fs:read"]` gets a `[src:N]` header (proving the default set includes
  `fs:read`, covering `read`/`glob`/`grep`).
- **AC4 (monotonic ids).** Two retrieval results in one run receive `[src:1]`
  and `[src:2]` (distinct, increasing); the per-run map records both
  `1 → {tool}` and `2 → {tool}`.
- **AC5 (per-run reset).** After a second `agent.run`, the first tagged result of
  the new run is `[src:1]` again (map reset on `agent_start`).
- **AC6 (fabricated-id warn).** With a scripted final answer
  `"A [src:1] but also [src:9]"` where only `[src:1]` was emitted, the
  `/citations` report lists `9` under fabricated ids and a warn was logged
  (assert via a capturing logger passed to `makeHarness({ logger })`).
- **AC7 (clean answer — no false positive).** A final answer citing only emitted
  ids (`"see [src:1]"`) yields an **empty** fabricated-id set and **no** warn.
- **AC8 (`[N]` bare form is a scoped confirm, never a fabrication source).** A
  final answer `"per [1]"` with id 1 emitted is treated as a valid citation of
  id 1 (no fabricated flag). A bare `"per [7]"` with 7 **unemitted** is **not**
  flagged — an incidental bracketed integer (footnote/list artifact) must not
  raise a spurious fabricated-id warn (§8 fail-noisy risk). Fabrication is flagged
  **only** via the authoritative stem: `"per [src:7]"` with 7 unemitted **is**
  flagged. A reference-style link def `"[3]: http://…"` is not counted as a
  citation of 3.
- **AC9 (missing-attribution is off by default).** A substantive uncited answer
  after ≥1 emitted id produces **no** warn with default settings; setting the
  `warnMissing` store flag true makes the same run report a missing-attribution
  flag.
- **AC10 (`/citations` report shape).** `/citations` (or `status`) prints lines
  naming emitted-count, cited-ids, and fabricated-ids; `on`/`off` toggles the
  `enabled` flag (mirroring `test/content-guard.test.ts:200-213`).
- **AC11 (`EAGENT_CITATIONS=off` kill switch).** With the env var set, no
  `[src:N]` header is added (raw content survives), mirroring
  `test/content-guard.test.ts:175-187`.
- **AC12 (clean dispose — no leak).** After `host.unload("citations")`, a
  subsequent run adds no header — the `afterToolCall` hook and `on` handlers are
  gone (mirroring `test/content-guard.test.ts:189-198`).
- **AC13 (composition with `content-guard`).** With both loaded (`content-guard`
  first), a `net:fetch` result is **both** fenced (`<untrusted-content` present)
  **and** prefixed with a `[src:N]` header that sits *ahead of* the standing
  note. The header-outside-the-fence invariant is asserted **concretely by
  index**, not just by substring presence: `content.indexOf("[src:")` is `0` (or
  at least `< content.indexOf(STANDING_NOTE)` **and**
  `< content.indexOf("<untrusted-content")`), so the test cannot pass with the
  `[src:N]` header buried *inside* the envelope. `content-guard`'s idempotency is
  intact.
- **AC14 (idempotency).** Feeding an already-`[src:`-tagged content back through
  the `afterToolCall` filter adds no second header.

## 8. Risks and Rollback

- **Risk: header noise.** The `[src:N]` header adds one short line per retrieval
  result. *Mitigation:* a single minimal line; off-by-default `enabled`; the
  header is the *cheapest* form that the model can still cite.
- **Risk: missed marker from an unexpected citation format (fail-safe).** If the
  model cites in a form other than `[src:N]`/`[N]` (e.g. `(source 3)`), markers
  are missed. *Mitigation:* warn-only (never blocks, § D5); accept both `[src:N]`
  and `[N]`; a missed marker fails *safe* (no false fabrication — it simply
  isn't counted). The inverse — a real `[src:9]` with no emitted 9 — is the
  intended true positive.
- **Risk: spurious "fabricated" flag from an incidental bare `[N]` token
  (fail-noisy).** `[N]` is overloaded in model prose: a markdown footnote ref
  (`[9]`), a reference-style link definition (`[3]: http://…`), an enumerated-list
  artifact, or any incidental bracketed integer in the final answer matches the
  bare form (D3/AC8) and is read as a cited source id. If that integer was never
  emitted this run, the validator raises a *spurious* fabricated-id warn — the
  inverse of the fail-safe risk above, and it directly erodes the headline signal
  (fabricated-id detection) that is this design's core value. *Mitigation:* the
  `[src:N]` stem is the **authoritative** form and the only one we instruct the
  model to use; bare `[N]` matching is **scoped**, not free — a bare `[N]` is
  counted as a citation **only when `N` is in the emitted-id set** (i.e. bare form
  can *confirm* a real id but can never *introduce* a fabricated one), and any
  `[N]` immediately followed by a `:` (a reference-style link def `[3]:`) is
  excluded. So fabricated-id flags come **only** from the unambiguous `[src:N]`
  stem; bare `[N]` is a permissive secondary parse that can only ever match an
  already-emitted id. Net effect: the false-positive path is closed without
  reversing D3's "accept `[N]`" decision, and warn-only (§ D5) bounds the worst
  case regardless. AC8 is adjusted to assert this scoping: `"per [7]"` with 7
  **unemitted** is **not** flagged (it is an incidental token, not a fabricated
  citation); only a `[src:7]` stem with 7 unemitted is.
- **Risk: composition ordering with `content-guard`.** If load order were wrong
  the header could land *inside* the fence. *Mitigation:* `citations` registers
  after `content-guard` (D2); both filters are idempotent; AC13 pins the ordering
  and AC14 pins idempotency.
- **Risk: wrong "final answer" selection.** If the last assistant message is not
  the answer (rare), validation scans the wrong text. *Mitigation:* warn-only and
  no-op when there is no assistant text; scope is the last text block, matching
  the existing `lastText` helper.
- **Rollback.** `EAGENT_CITATIONS=off` (env, no-op disposer at activation), or set
  the `enabled` store flag false, or `host.unload("citations")` — each fully
  removes the header-prepend and the validation, restoring raw tool output (AC11,
  AC12). No persisted state to clean up (the id map is in-memory, per-run).
