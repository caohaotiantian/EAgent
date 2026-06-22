# Design: mcp-resources — ingest the read-only resources half of MCP

Status: PASSED
Slug: `2026-06-22-mcp-resources`

## 1. Background and Purpose

The Model Context Protocol has two server-published surfaces: **tools** (verbs
the model invokes) and **resources** (the read-only *data* half — file contents,
repository state, knowledge-graph nodes — published so a client can read them
*without* spending a tool call). Every reference MCP server (filesystem, git,
memory, "everything") exposes resources; for many servers it is the larger,
more useful half.

EAgent's `mcp` extension (`src/extensions/mcp.ts`) ingests **only** the tools
half. `McpConnection.start()` performs the `initialize` / `initialized`
handshake and then calls exactly one enumeration method, `tools/list`
(`mcp.ts:356`); it registers each tool as `mcp__<server>__<tool>`
(`mcp.ts:396`, `mcp.ts:413`) gated behind the `mcp:call` capability
(`mcp.ts:376`, `mcp.ts:417`). It **never** calls `resources/list` or
`resources/read` — verified by grep over `src/`: the only match for
`resources`/`listResources`/`readResource` anywhere in the source tree is an
unrelated comment in `cli.ts`. An EAgent agent connected to a filesystem or git
MCP server is therefore blind to half of what that server offers: it can call
the server's *verbs* but cannot read the *data* the server publishes.

This task **extends** the existing `mcp` extension (not a fork): on connect to
each server it ALSO enumerates `resources/list`, caches the catalog, and exposes
a single `mcp__<server>__read_resource(uri)` tool that calls `resources/read`.
The result is the missing read-only half of the MCP surface, ingested through
the same arm's-length transport, the same handshake, and (D3) the same
capability machinery the tools half already uses.

## 2. Deliverables

- [x] `src/extensions/mcp.ts` — **extended in place** (additive diff, no fork):
  `McpConnection` gains a cached `resources: McpResource[]` field populated by a
  new `resources/list` call inside `start()`; `activate()` registers, per server
  that advertises resources, one `mcp__<server>__read_resource` tool that calls
  `resources/read`; the `/mcp` command line also prints the per-server resource
  count.
- [x] An exported pure helper `parseResourceList(raw): McpResource[]` that
  defensively filters a foreign `resources/list` payload to entries with a
  non-empty string `uri` (mirroring the existing tool-list filter at
  `mcp.ts:360`), unit-tested in isolation.
- [x] `test/mcp.test.ts` — **extended**: the in-test stdio fixture server gains
  `resources/list` and `resources/read` handlers; new offline tests load the
  extension via `host.use("mcp", activate)` (the established pattern, e.g.
  `test/recovery.test.ts:118`) and assert registration, read, the
  no-resources-server path, the catalog cache + refresh command, and the kill
  switch.
- [x] `/mcp resources [server]` command surface (the catalog the model/operator
  can see) and `/mcp refresh` (re-run `resources/list`) — registered on the
  existing `mcp` command (D2, D5).
- [x] Kill switch `EAGENT_MCP_RESOURCES=off` — when set, `start()` skips
  `resources/list` entirely and no `read_resource` tool is registered (the tools
  half is untouched).
- [x] `src/extensions/content-guard.ts` — **one-line edit, owned here:** add
  `"mcp:read"` to `DEFAULT_FOREIGN_CAPS` (`content-guard.ts:29`, currently
  `["net:fetch", "mcp:call"]`) so resource bodies are fenced by content-guard's
  ingress sanitizer out of the box, exactly like `mcp:call` tool output (§6, §8).
  This is a non-optional deliverable, not a coordination note: shipping `mcp:read`
  without it leaves resource bodies — untrusted foreign content — *unfenced* by
  default, because content-guard's `isForeign` check
  (`content-guard.ts:113`–`115`) only matches capabilities in `foreignCaps`.
  A new offline test in content-guard's own suite ships with it: the suite has
  no existing assertion over the *contents* of `DEFAULT_FOREIGN_CAPS` to extend
  (it exercises `net:fetch`/`fs:read` only behaviorally, `content-guard.test.ts`
  lines 105–121), so this adds one — preferably a live case proving an
  `mcp:read`-capability tool's success result is now fenced (mirroring the
  `net:fetch` case at `content-guard.test.ts:105`), not a structural assert on
  the constant.
- [ ] **host.ts registration: not applicable / deferred to batch integration.**
  `mcp` is already a built-in in `BUILTIN_EXTENSIONS`; this change is additive
  *inside* that already-registered extension, so no new `BUILTIN_EXTENSIONS`
  entry exists to add. No `src/host.ts` edit in this task.
- [ ] **CLAUDE.md/README inventory: (deferred to batch integration).** The
  `mcp` extension already has an inventory line; the one-line description update
  ("ingests tools and resources") and any README wording are reconciled at
  closeout in the batch step. No README extension-count bump (the count is
  unchanged — this is not a new extension).

## 3. Scope Boundary (explicit NON-goals — Simplicity First)

- **No `resources/templates/list` (URI templates).** MCP also lets servers
  publish *parameterized* resource templates. Out of scope: the concrete
  `resources/list` + `resources/read` pair is the read-only data half the
  PROBLEM names; templates are a speculative second surface. A `read_resource`
  tool already accepts an arbitrary `uri`, so a model that knows a template's
  shape can still read a concrete URI.
- **No `resources/subscribe` / `notifications/resources/updated` (live
  subscriptions).** Subscriptions require a server→client push path and cache
  invalidation; EAgent's transport is request/response per call. Out of scope;
  `/mcp refresh` (D5) is the manual re-enumeration instead.
- **No `transformContext` injection of resource bodies into the prompt.** The
  catalog and bodies are pulled *on demand* via the tool, not auto-pushed into
  context (D2). This is the central Simplicity-First choice.
- **No resource-content sanitization/fencing re-implemented here.** Resource
  bodies are untrusted foreign content, but de-fanging incoming foreign output is
  `content-guard`'s job, not this extension's. This task does not re-implement
  ingress hardening — but it does *wire* the existing fence to cover the new
  capability: a one-line edit adds `mcp:read` to content-guard's default
  `foreignCaps` so bodies are fenced by capability exactly like `mcp:call` output
  (owned §2 deliverable; see §6, §8). Ingestion and fencing stay separate
  mechanisms; this task only ensures the existing fence's default reaches the new
  surface.
- **No new transport, no SDK, no protocol rewrite.** Resources ride the exact
  `Transport.request` path the tools half uses; both stdio and HTTP transports
  are reused unchanged.
- **No pagination cursor follow.** `resources/list` may return a `nextCursor`;
  we read the first page and cap it (D6), we do not loop cursors. A capped
  catalog is sufficient for the model to discover what to read.

## 4. Key Design Decisions

### D1. When to enumerate: `resources/list` on connect (eager) vs. lazily on first read

- **Problem.** When does the connection learn what resources a server offers?
- **Options.** (a) **Eager** — call `resources/list` once inside
  `McpConnection.start()`, right after `tools/list` (`mcp.ts:356`), and cache the
  result on the connection. (b) **Lazy** — call `resources/list` only the first
  time the model invokes the read tool or the `/mcp resources` command.
- **Choice: (a) eager, cached.** It mirrors exactly how the tools half already
  works (`tools/list` is called on connect and cached in `conn.tools`), so the
  catalog is known the moment the server is connected — `/mcp` can show the
  count, and the `read_resource` tool's description can carry a sample of URIs.
  One extra request per server at activation is negligible (activation already
  does `initialize` + `initialized` + `tools/list`), and it keeps the
  connect-time code path uniform: both halves are enumerated in one place.
- **Why (b) rejected.** Lazy enumeration means `/mcp` cannot report what a server
  offers until something touches it, and it complicates the read tool with a
  first-call enumeration side effect and its own error path. It buys nothing —
  the catalog is small and the server is already connected — while losing the
  "catalog known on connect" property that makes the surface discoverable. It
  also diverges from the tools-half pattern for no reason.

### D2. How to expose resources: a `read_resource` **tool** vs. `transformContext` injection of resource handles

- **Problem.** How does the model actually get at resource data?
- **Options.** (a) Register one `mcp__<server>__read_resource(uri)` **tool** per
  server that calls `resources/read`; surface the catalog via the read tool's
  description and the `/mcp resources` command. (b) On every turn, inject the
  resource catalog (and/or bodies) into the message list via a
  `transformContext` filter so the model "just sees" the resources.
- **Choice: (a) a tool.** Reading is then **explicit** (the model decides to
  read a specific URI), **capability-gated** (the same `ctx.require(...)` guard
  the tools half uses — D3), and it **does not bloat context**: a server that
  publishes thousands of resources, or megabyte file bodies, would blow the
  token budget if auto-injected every turn, whereas a tool pulls exactly the one
  URI the model asks for. The catalog the model needs to *choose* a URI is
  surfaced cheaply — capped, name+uri only — in the tool description and the
  `/mcp resources` command, not as full bodies in context.
- **Why (b) rejected.** `transformContext` runs every turn over the whole
  message list; injecting resource bodies there re-pays the token cost on every
  turn and, for large servers, is unbounded — the exact context-bloat failure
  `prune` exists to clean up. It also makes reads *implicit* and **ungated**:
  foreign resource bytes would enter context without any `mcp:*` capability
  check, defeating the arm's-length posture that motivates the whole `mcp`
  extension. (b) is the speculative, heavier option; (a) is the minimum that
  solves "let the agent read resources."

### D3. Capability: reuse `mcp:call` vs. a new sibling `mcp:read`

- **Problem.** Which capability gates `resources/read`?
- **Options.** (a) Reuse the existing `mcp:call` (granted at `mcp.ts:376`,
  required at `mcp.ts:423`). (b) Declare and grant a new sibling `mcp:read`,
  required only by the read-resource tool.
- **Choice: (b) a new `mcp:read`.** Reading data and invoking a verb are
  genuinely different privileges: `resources/read` is read-only and side-effect
  free, while `tools/call` can mutate the world. Splitting the capability lets an
  operator grant the agent *read* access to MCP servers while still gating, or
  denying, tool *calls* — least-privilege, which is the entire point of EAgent's
  capability vocabulary. The cost is one extra `e.grantCapability("mcp:read")`
  line and `capabilities: ["mcp:read"]` on the one new tool; the machinery
  (`grant` → `ctx.require`) is identical to `mcp:call`, so there is no new
  mechanism, only a new label. Verified net-new: grep finds no existing
  `mcp:read` anywhere in `src/`.
- **Why (a) rejected.** Reusing `mcp:call` is one line shorter but conflates two
  trust levels: an operator who wants "this agent may read my repo's MCP
  resources but must not call mutating tools" could not express that — granting
  `mcp:call` for reads would also unlock every write-capable tool. The
  least-privilege split is a real behavioral gain for a trivial cost, and it
  stays additive: `mcp:call` is untouched, so the tools half's gating is
  unchanged. (Both capabilities are granted by the same extension; a deployment
  that wants the old all-or-nothing behavior simply grants both, which is the
  default.)

### D4. A server that does not support resources (capabilities negotiation)

- **Problem.** Not every MCP server implements resources. The `initialize`
  result carries a server `capabilities` object (the fixture returns
  `capabilities: { tools: {} }` at `mcp.test.ts:76`); a server with no
  `resources` key does not support the half. How do we handle it — and how do we
  handle a server that *omits* the capability but answers anyway, or *advertises*
  it but returns junk?
- **Options.** (a) Gate strictly on the advertised `initialize.capabilities`:
  only call `resources/list` if `capabilities.resources` is present. (b) Always
  attempt `resources/list` and treat any failure (method-not-found error, thrown
  transport error, malformed payload) as "no resources" — empty catalog, no
  tool, never fatal.
- **Choice: (b), with the advertised capability as a cheap skip hint.** We read
  `capabilities.resources` from the cached `initialize` result; if it is clearly
  absent we skip the `resources/list` call (saving a round-trip). But because
  foreign servers are not trusted to advertise honestly, the controlling
  behavior is the **fail-soft** path: if `resources/list` is attempted and
  errors (e.g. JSON-RPC `-32601 method not found`, like the fixture's catch-all
  at `mcp.test.ts:85`) or returns a non-array/garbage payload, we catch it, log a
  warning, set the catalog to empty, and register **no** read tool — exactly the
  pattern `start()` already uses to tolerate a malformed `tools/list`
  (`mcp.ts:360`). No-resources is never an error and never aborts connection or
  the tools half.
- **Why (a)-alone rejected.** Trusting the advertised capability as the *only*
  gate is brittle against a server that supports resources but under-advertises
  (we'd never read them) or one that advertises but errors on read (we'd surface
  a broken tool). Foreign code does not get to be trusted about its own shape —
  the same reason `start()` already re-validates the tool list rather than
  trusting it. The advertised flag is a fast-path optimization, not the
  correctness boundary.

### D5. Cache the `resources/list` result; offer a refresh

- **Problem.** The catalog can change (a git server's resources shift as the repo
  changes). Re-enumerate every read, or cache?
- **Options.** (a) Cache the catalog on the connection at connect (D1) and read
  from cache; provide a `/mcp refresh` command that re-runs `resources/list` to
  re-populate it. (b) Re-call `resources/list` on every catalog access.
- **Choice: (a) cache + explicit refresh.** Caching matches the tools half
  (`conn.tools` is enumerated once and reused) and keeps `/mcp resources` and the
  tool-description sample cheap (no round-trip to render the catalog). When the
  operator knows the server's resources changed, `/mcp refresh` re-runs
  `resources/list` on each connection and updates the cache in place. Crucially,
  the **`read_resource` tool always calls `resources/read` live** against the URI
  — only the *catalog* (the list of what exists) is cached, never the resource
  *bodies* — so a cached catalog never serves stale content, only a possibly
  stale *index* of URIs, which refresh corrects.
- **Why (b) rejected.** Re-enumerating on every access pays a round-trip to
  render a list that rarely changes, and would make `/mcp` and the tool
  description slow/failure-prone for a property (the catalog) that is cheap to
  cache and explicitly refreshable. Since bodies are read live regardless,
  per-access re-enumeration buys no freshness that matters.

### D6. Catalog cap (string/format guard, non-behavioral)

- A server may publish an enormous `resources/list`. We cap the cached catalog
  at a fixed `MAX_RESOURCES = 1000` entries and the description sample at the
  first few URIs. This is a defensive bound on memory/context, not a behavioral
  policy lever; a single fixed constant is acceptable here because it is a
  size guard, not a decision between behaviors. (The read tool still accepts any
  `uri` string, so a capped catalog never prevents reading a known URI.)

## 5. Dependencies and Assumptions

- **The existing `mcp` transport and handshake.** Resources reuse
  `McpConnection.request(method, params, signal)` (`mcp.ts:366`), which proxies
  to `Transport.request` (`mcp.ts:112`) — identical for stdio and HTTP. No new
  transport code.
- **The `initialize` result is reachable.** D4's capability hint needs the server
  `capabilities` object from `initialize`. Today `start()` discards the
  `initialize` result (`mcp.ts:350`); this task captures it into a field so
  `capabilities.resources` can be inspected. Additive, no behavior change to the
  tools path.
- **Tool/result shapes.** `resources/read` returns `{ contents: [{ uri, text?,
  blob?, mimeType? }] }`; we surface the concatenated `text` parts via `ok(...)`
  (mirroring the `tools/call` text extraction at `mcp.ts:430`–`434`), and ignore
  binary `blob` for now (text is what the model consumes).
- **Capability machinery.** `e.grantCapability` (`extension.ts:233`) and
  `ctx.require(capability)` (`types.ts:158`) — the same two calls the tools half
  uses — gate the read tool under `mcp:read` (D3).
- **House rules.** ESM with `.js` specifiers even for `.ts`; strict TS
  (`noUncheckedIndexedAccess`, no `any` — the foreign payload is typed as
  `unknown` and narrowed by `parseResourceList`); zero new runtime deps (pure
  Node `fetch`/JSON, already in `mcp.ts`); offline `node:test` via the existing
  stdio fixture; kill switch; the existing dispose loop (`mcp.ts:459`) already
  tears down every connection and needs no change (no new long-lived resource is
  added).
- **Assumption.** A server's `resources/read` for a URI returned by its own
  `resources/list` either succeeds or errors per-URI; one bad resource must not
  break the others (handled by per-call `try/catch` returning `fail(...)`, like
  `tools/call` at `mcp.ts:435`).

## 6. Relationship with Existing Designs

- **Closest / the file being extended: `src/extensions/mcp.ts`.** This is a
  net-new *protocol surface* on an extension that already speaks MCP, not a new
  extension. It reuses the connect path (`start()`, `mcp.ts:349`), the
  `Transport`/`McpConnection` abstraction, the capabilities-negotiation seam
  (`initialize` with `capabilities: {}` at `mcp.ts:352`, whose *response*
  capabilities we now read), the tool-registration loop (`mcp.ts:393`), and the
  `/mcp` command (`mcp.ts:445`). The `mcp:call` grant (`mcp.ts:376`) is left
  intact; a sibling `mcp:read` is added beside it (D3).
- **No existing design doc covers MCP resources.** Grep of `docs/design/*.md`
  and the SPEC's shortlist confirm no prior task touches the MCP surface — this
  is the **first design** for the resources half. The existing `mcp` extension
  has no standalone design doc (it predates the docs/design convention).
- **Dedup vs. `content-guard` (`2026-06-22-content-guard.md`).** Verified
  complementary, not overlapping. `content-guard` *sanitizes/fences* incoming
  foreign tool output but does **not** *ingest* resources — it only acts on
  results that already exist. Its foreign-capability set keys on `mcp:call`
  (`content-guard` D2 cites `mcp.ts:417`), and its `DEFAULT_FOREIGN_CAPS`
  (`content-guard.ts:29`) is `["net:fetch", "mcp:call"]` — which does **not**
  include `mcp:read`. So that resource bodies are fenced by that ingress sanitizer
  out of the box, **this task owns the one-line edit** adding `mcp:read` to
  `DEFAULT_FOREIGN_CAPS` (a §2 deliverable, not a deferred note): without it,
  resource bodies read via `mcp:read` would be unfenced by default, since
  content-guard's `isForeign` check only matches capabilities in `foreignCaps`.
  No code conflict: `mcp-resources` produces the foreign content and wires the
  default fence, `content-guard` fences it — the two compose.
- **No conflict with `flow-guard` / `risk-guard`.** Both key off capabilities;
  `mcp:read` is a read-only capability they may treat like any other foreign
  capability without change. This task does not modify them.

## 7. Acceptance Criteria (measurable / automatable)

All verified by `npm test` (`test/mcp.test.ts`, extended) unless noted. The
in-test stdio fixture (`mcp.test.ts:63`) is extended to answer `resources/list`
(returning, e.g., one resource `{ uri: "file:///readme.md", name: "readme",
mimeType: "text/plain" }`) and `resources/read` (returning `{ contents: [{ uri,
text: "RESOURCE BODY" }] }`).

- **AC1 — registration.** After `host.use("mcp", activate)` against a fixture
  that advertises resources, `agent.tools.has("mcp__fixture__read_resource")` is
  `true` (parallels `mcp.test.ts:111`).
- **AC2 — read returns the body.** A scripted `MockProvider` turn calling
  `mcp__fixture__read_resource` with `{ uri: "file:///readme.md" }` produces a
  `tool_result` block whose `content` matches `/RESOURCE BODY/` and whose
  `isError` is falsy (parallels `mcp.test.ts:117`).
- **AC3 — capability is `mcp:read`, not `mcp:call`.** The registered
  `read_resource` tool's `capabilities` array equals `["mcp:read"]`
  (assert on `agent.tools.get("mcp__fixture__read_resource")?.capabilities`),
  and `agent.capabilities` has been granted `mcp:read`. With a
  `CapabilityManager` seeded with an explicit `deny: ["mcp:read"]` rule, the read
  call is blocked (its `tool_result.isError` is set) — proving the gate is the
  new capability. Note `makeHarness` (`test/helpers.ts:27`) plumbs only
  `{ responder, fallback, ui, logger }` into the `CapabilityManager` and there is
  no runtime `deny()` method, so this case cannot use the stock harness as-is: it
  either constructs `CapabilityManager`/`Agent` directly with
  `new CapabilityManager({ deny: ["mcp:read"], ui })` (the constructor *does*
  accept `deny`, `capabilities.ts:47`) or threads a `deny` option through a small
  one-field `makeHarness` extension. (A bare `fallback: "deny"` would *not* block: the extension grants
  `mcp:read` in `activate()`, and in `CapabilityManager.require`
  (`capabilities.ts:85`) an explicit grant (line 90) short-circuits to allow
  *before* the fallback (line 106) is consulted; only a deny rule (line 86),
  which takes precedence over the grant, actually denies a granted capability.)
- **AC4 — no-resources server: no tool, no error.** Pointed at a fixture that
  advertises `capabilities: { tools: {} }` and returns `-32601` for
  `resources/list`, the extension activates cleanly, registers the tool half as
  before, registers **no** `read_resource` tool
  (`agent.tools.has("mcp__fixture__read_resource") === false`), and activation
  does not throw.
- **AC5 — `parseResourceList` filters junk (unit).** `parseResourceList` keeps
  only entries with a non-empty string `uri`, drops `null`/`{}`/`{uri: 42}`, and
  returns `[]` for a non-array input — asserted directly on crafted payloads,
  no server (parallels the `parseServers` unit tests at `mcp.test.ts:37`).
- **AC6 — catalog command + cache.** `/mcp resources` prints the fixture's
  resource `uri`(s); after `/mcp refresh` (which re-runs `resources/list`) the
  catalog still lists them (and a fixture that changes its list between calls
  reflects the change after refresh, proving refresh re-enumerates while the
  base `/mcp` count reflects the cache).
- **AC7 — kill switch.** With `EAGENT_MCP_RESOURCES=off`,
  `agent.tools.has("mcp__fixture__read_resource")` is `false`, the tools half is
  unaffected (`agent.tools.has("mcp__fixture__echo") === true`), and no
  `resources/list` round-trip is required for activation to succeed.
- **AC8 — clean teardown.** After `host.dispose()`, the `read_resource` tool is
  gone and the connection is closed (no leaked subprocess) — the existing dispose
  loop covers it; asserted via `agent.tools.has(...) === false` post-dispose
  (parallels `mcp.test.ts:114`).
- **AC9 — suite green.** `npm run typecheck` exits 0 and `npm test` exits 0 (no
  regression in the existing MCP tests or the wider suite).

## 8. Risks and Rollback

- **A server advertises resources but errors on a specific read.** Mitigation:
  fail-open *per resource* — the `read_resource` execute wraps
  `resources/read` in `try/catch` and returns `fail("MCP resource read failed:
  ...")` for that URI (the `tools/call` pattern at `mcp.ts:435`), never throwing
  out of the tool. One bad URI does not break the catalog or other reads.
- **A server advertises resources but errors on `resources/list`.** Mitigation:
  D4 fail-soft — caught, warned, empty catalog, no tool registered; activation
  and the tools half are unaffected.
- **Resource content is untrusted foreign data.** Mitigation: ingress
  fencing/sanitization is `content-guard`'s job, and this task **wires the fence
  on by default** — the §2 deliverable adds `mcp:read` to content-guard's
  `DEFAULT_FOREIGN_CAPS` (`content-guard.ts:29`), so resource bodies are fenced
  like `mcp:call` output the moment both extensions are loaded, with no operator
  action. This closes the gap on merge rather than leaving it to a separate edit;
  content-guard remaining store-overridable and fail-open is a deployment knob on
  top of a safe default, not the default itself.
- **Large resource lists / large bodies blow memory or context.** Mitigation:
  the catalog is capped at `MAX_RESOURCES` (D6) and only `uri`/`name` (not
  bodies) are cached or shown; bodies are pulled one URI at a time by the tool
  (D2), so context cost is bounded by what the model explicitly reads, and
  `limits`/`prune` apply to the read output like any other tool result.
- **Extra connect-time round-trip.** One added `resources/list` per server at
  activation; negligible, and skipped entirely when the server does not advertise
  resources (D4) or when the kill switch is set.
- **Kill switch.** `EAGENT_MCP_RESOURCES=off` disables the entire resources half
  (no `resources/list`, no `read_resource` tool, no `/mcp resources` command
  effect) while leaving the tools half — the whole pre-existing `mcp` behavior —
  bit-for-bit unchanged.
- **Rollback.** The change is purely additive: the `mcp.ts` diff (and the
  `test/mcp.test.ts` additions) plus the one-line `content-guard.ts`
  `DEFAULT_FOREIGN_CAPS` addition. Reverting those restores the tools-only
  behavior exactly (and content-guard's prior default `foreignCaps`); no schema,
  storage, CLI contract, or new built-in registration is introduced, so removal
  is total and immediate.
