# Implementation: mcp-resources — ingest the read-only resources half of MCP

Status: open
Closing-commit: (pending)
Closed-on: (pending)
Deferred: host.ts registration; CLAUDE.md/README inventory (both to batch integration — see §2)

Design: `docs/design/2026-06-22-mcp-resources.md` (slug `2026-06-22-mcp-resources`, PASSED).

This task **extends the existing `mcp` extension in place** — it is not a new
extension. `mcp` is already a built-in in `BUILTIN_EXTENSIONS`, so there is no
`src/host.ts` edit and no README extension-count change in this task. The
offline tests load the extension the established way, `host.use("mcp",
activate)` (e.g. `test/recovery.test.ts:118`), and do **not** depend on any
host registration.

## 1. Task Index

Maps every design Deliverable (§2) and Acceptance Criterion (§7) to a Phase-1
task. No requirement here is absent from the design.

| Design Deliverable (§2) | Design AC (§7) | Phase-1 task |
|---|---|---|
| `parseResourceList(raw): McpResource[]` exported pure helper, filters foreign payload to non-empty-string `uri` (§2, D4) | AC5 | T1 (test) → T8 (impl) |
| `McpConnection` captures `initialize` result; gains cached `resources: McpResource[]`; new `resources/list` call in `start()` (eager, capped at `MAX_RESOURCES`, advertised-capability skip hint, fail-soft) (§2, D1/D4/D5/D6) | AC4, AC7 | T2/T4 (test) → T9/T10 (impl) |
| `activate()` registers one `mcp__<server>__read_resource(uri)` tool per server that advertises/returns resources, calling `resources/read`, gated by `mcp:read`, fail-open per resource (§2, D2/D3) | AC1, AC2, AC3, AC8 | T2/T3 (test) → T11/T12 (impl) |
| New `mcp:read` capability granted in `activate()`; tool declares `capabilities:["mcp:read"]` (§2, D3) | AC3 | T3 (test) → T11 (impl) |
| `/mcp resources [server]` + `/mcp refresh` command surface; `/mcp` prints per-server resource count (§2, D2/D5) | AC6 | T5 (test) → T13 (impl) |
| Kill switch `EAGENT_MCP_RESOURCES=off` (skip `resources/list`, register no tool, tools half untouched) (§2) | AC7 | T6 (test) → T14 (impl) |
| `src/extensions/content-guard.ts` — add `"mcp:read"` to `DEFAULT_FOREIGN_CAPS` (one-line, owned here, **non-optional**, §2/§6/§8) | (content-guard's own AC, added in T7) | T7 (test) → T15 (impl) |
| host.ts registration | n/a | **Deferred to batch integration** (§2: not applicable — additive inside an already-registered built-in; no `src/host.ts` edit) |
| CLAUDE.md/README inventory | n/a | **Deferred to batch integration** (§2: one-line description update reconciled at closeout; no README count bump) |
| Suite green | AC9 | Phase exit (`npm run typecheck` exit 0; `npm test` exit 0) |

## 2. Phase Breakdown

This is a **single phase**. The work is one additive diff to `mcp.ts`, its test
file, and one independent one-line edit to `content-guard.ts` with its own test.
These are not genuinely separable into ordered phases (the content-guard edit has
no dependency on mcp.ts ordering and vice versa); they share one exit gate.

### Phase 1 — mcp resources half (single phase)

**Entry condition:** L1 design doc PASSED (it has). Prerequisite extension
(`mcp`) already exists and is being extended in place; no other prerequisite.

**Design references:** `docs/design/2026-06-22-mcp-resources.md` §2
(Deliverables), §3 (NON-goals), §4 D1–D6 (decisions), §5 (Dependencies &
Assumptions), §6 (Relationship), §7 AC1–AC9, §8 (Risks/Rollback).

Key shapes pinned by the design, to implement against:
- `resources/list` returns `{ resources: [{ uri, name?, description?, mimeType? }] }`;
  keep only entries with a non-empty string `uri` (§5; mirrors the tool-list
  filter at `mcp.ts:360`).
- `resources/read` returns `{ contents: [{ uri, text?, blob?, mimeType? }] }`;
  surface concatenated `text` parts via `ok(...)` (mirrors `tools/call` text
  extraction at `mcp.ts:430`–`434`); ignore binary `blob` (§5).
- Catalog cap `MAX_RESOURCES = 1000`; description sample = first few URIs (§6 D6).
- Advertised-capability hint: read `capabilities.resources` from the cached
  `initialize` result; if clearly absent, skip the `resources/list` round-trip;
  but the **controlling** behavior is fail-soft on the call itself (§4 D4).
- Kill switch `EAGENT_MCP_RESOURCES=off`: `start()` skips `resources/list`
  entirely; no `read_resource` tool registered; tools half bit-for-bit unchanged
  (§2, §8).

**Task list (TDD order — every TEST task names the BUSINESS INVARIANT it
protects and precedes the impl it protects):**

#### Tests first

- **T1 (test) — `parseResourceList` filters junk (AC5).**
  Protects the invariant *"a foreign `resources/list` payload is narrowed to only
  entries with a non-empty string `uri`; everything else is dropped and a non-array
  input yields `[]`"* (the same trust-no-foreign-shape rule the tool list already
  enforces). In `test/mcp.test.ts`, import `parseResourceList` from
  `../src/extensions/mcp.js` and assert directly on crafted payloads (no server,
  parallel to the `parseServers` unit tests at `mcp.test.ts:37`): keeps
  `{ uri: "file:///a" }`; drops `null`, `{}`, `{ uri: 42 }`, `{ uri: "" }`;
  returns `[]` for a non-array input (e.g. `undefined`, `{}`, `"x"`).

- **T2 (test) — registration + read returns the body (AC1, AC2).**
  Protects *"after connecting to a server that advertises resources, the agent has
  a `mcp__<server>__read_resource` tool, and reading a known URI returns the
  server's resource body, not an error"*. Extend the in-test stdio fixture
  (`FIXTURE_SERVER`, `mcp.test.ts:63`) to answer `resources/list` (returning
  one resource `{ uri: "file:///readme.md", name: "readme", mimeType:
  "text/plain" }`) and `resources/read` (returning `{ contents: [{ uri,
  text: "RESOURCE BODY" }] }`), and to advertise `capabilities: { tools: {},
  resources: {} }` in its `initialize` result. New tests load via
  `host.use("mcp", activate)`:
  - AC1: `agent.tools.has("mcp__fixture__read_resource") === true` (parallels
    `mcp.test.ts:111`).
  - AC2: a scripted `MockProvider` turn calling `mcp__fixture__read_resource`
    with `{ uri: "file:///readme.md" }` produces a `tool_result` block whose
    `content` matches `/RESOURCE BODY/` and whose `isError` is falsy (parallels
    `mcp.test.ts:117`).

- **T3 (test) — capability is `mcp:read`, not `mcp:call`; deny blocks (AC3, AC8).**
  Protects *"the read tool is gated by the new read-only capability `mcp:read` and
  nothing else; an operator who denies `mcp:read` blocks the read"* (least-privilege
  split, D3) and *"teardown removes the tool"* (AC8).
  - AC3 (positive): `agent.tools.get("mcp__fixture__read_resource")?.capabilities`
    deep-equals `["mcp:read"]`; and the agent has been granted `mcp:read`.
  - AC3 (deny): with a `CapabilityManager` seeded with an explicit
    `deny: ["mcp:read"]` rule, the read call is blocked (its `tool_result.isError`
    is set). Per design §7 AC3, `makeHarness` plumbs only
    `{ responder, fallback, ui, logger }` and exposes no runtime `deny()`, so this
    case must **not** rely on the stock harness's options alone: construct
    `new CapabilityManager({ deny: ["mcp:read"], ui })` (the constructor accepts
    `deny`, `capabilities.ts:47`) and wire an `Agent` + `ExtensionHost` directly
    (mirroring `makeHarness`, `test/helpers.ts:27`–`44`), then `host.use("mcp",
    activate)`. A bare `fallback:"deny"` would NOT block — `activate()` grants
    `mcp:read`, and an explicit grant short-circuits to allow before the fallback
    is consulted (`capabilities.ts:90` vs `:106`); only a deny rule (`:86`), which
    precedes the grant, denies a granted capability.
  - AC8: after `host.dispose()`, `agent.tools.has("mcp__fixture__read_resource")
    === false` (parallels `mcp.test.ts:114`).

- **T4 (test) — no-resources server: no tool, no error (AC4).**
  Protects *"a server that does not support resources yields an empty catalog and
  NO read tool, and never aborts activation or the tools half"* (D4 fail-soft).
  Add a second fixture (or a parameterized variant) that advertises
  `capabilities: { tools: {} }` (no `resources` key) and returns the catch-all
  `-32601 method not found` for `resources/list` (the fixture's existing catch-all
  at `mcp.test.ts:85` already does this for unknown methods). Assert: activation
  does not throw; the tools half is still registered
  (`agent.tools.has("mcp__fixture__echo") === true`); and
  `agent.tools.has("mcp__fixture__read_resource") === false`.

- **T5 (test) — catalog command + cache + refresh (AC6).**
  Protects *"the operator/model can see the resource catalog via `/mcp resources`,
  `/mcp` reports the per-server resource count, and `/mcp refresh` re-runs
  `resources/list` so a server whose list changed is reflected after refresh while
  the cached `/mcp` count reflects the cache until then"* (D5). Assert: `/mcp
  resources` output contains the fixture's resource `uri` (`file:///readme.md`);
  `/mcp` output contains the resource count for `fixture`; after `/mcp refresh`
  the catalog still lists the resource(s). Use a fixture whose `resources/list`
  returns a different set on the second call (e.g. counts invocations) to prove
  refresh re-enumerates.

- **T6 (test) — kill switch (AC7).**
  Protects *"`EAGENT_MCP_RESOURCES=off` disables the entire resources half — no
  `read_resource` tool, no `resources/list` round-trip required — while the tools
  half is unaffected"*. With `process.env.EAGENT_MCP_RESOURCES = "off"` set for the
  case (restore in `finally`): `agent.tools.has("mcp__fixture__read_resource")
  === false`, `agent.tools.has("mcp__fixture__echo") === true`, and activation
  succeeds.

- **T7 (test) — content-guard default fences `mcp:read` bodies.**
  Protects *"a resource body read via an `mcp:read`-capability tool is fenced by
  content-guard's ingress sanitizer out of the box"* (§2/§6/§8 — the one-line
  default edit). In `test/content-guard.test.ts`, add one live case mirroring the
  `net:fetch` case at `content-guard.test.ts:105`: a stub tool declaring
  `capabilities:["mcp:read"]` returning known content, run the agent so it calls
  the stub, and assert the resulting `tool_result` content is wrapped in the
  `<untrusted-content source="...">` provenance envelope (i.e. `mcp:read` is now
  in `DEFAULT_FOREIGN_CAPS`). The suite has no existing assertion over the
  *contents* of `DEFAULT_FOREIGN_CAPS` to extend (§2), so add the behavioral case;
  do not assert structurally on the constant.

#### Impl second (each makes the matching test(s) above pass)

- **T8 (impl) — `parseResourceList` (makes T1 green).** Add an `McpResource`
  interface (`{ uri: string; name?: string; description?: string; mimeType?:
  string }`) and an exported pure helper
  `export function parseResourceList(raw: unknown): McpResource[]`. Narrow `raw`
  to its `resources` array if present; return `[]` for a non-array; filter to
  entries that are objects with a non-empty string `uri` (mirror the tool-list
  filter at `mcp.ts:360`). Cap to `MAX_RESOURCES = 1000` (D6). `raw` typed
  `unknown`, narrowed here — no `any`.

- **T9 (impl) — capture `initialize`; eager `resources/list` in `start()`
  (makes T2/T4 progress).** In `McpConnection`: add fields `resources:
  McpResource[] = []` and a private cached `initialize` result (today discarded
  at `mcp.ts:350`). In `start()`, after the existing `tools/list` block, add the
  resources enumeration:
  - Kill-switch gate: if `process.env.EAGENT_MCP_RESOURCES === "off"`, skip
    entirely (no `resources/list`, `resources` stays `[]`).
  - Advertised-capability hint (D4): if `capabilities.resources` is clearly absent
    from the cached `initialize` result, skip the `resources/list` round-trip.
  - Otherwise call `resources/list`, pass the raw payload through
    `parseResourceList`, and assign to `this.resources`. **Fail-soft (D4):** wrap
    the call + parse in `try/catch`; on a thrown transport error (e.g. `-32601`),
    a non-array, or garbage, log a warning, set `this.resources = []`, register no
    tool — never throw out of `start()`. Mirror the malformed-`tools/list`
    tolerance at `mcp.ts:360`. The tools-half code path is unchanged.

- **T10 (impl) — refresh hook (supports T5).** Add a method on `McpConnection`
  (e.g. `refreshResources(): Promise<void>`) that re-runs the same guarded
  `resources/list` + `parseResourceList` and updates `this.resources` in place,
  fail-soft like `start()`. Only the catalog is re-enumerated; bodies are always
  read live (D5).

- **T11 (impl) — grant `mcp:read`; register `read_resource` tool (makes
  T2/T3 green).** In `activate()`: add `e.grantCapability("mcp:read")` beside the
  existing `mcp:call` grant (`mcp.ts:376`). For each connection that has a
  non-empty `resources` catalog, register **one** tool
  `mcp__<server>__read_resource` with `capabilities: ["mcp:read"]`, a `uri: string`
  parameter, and a description carrying a capped sample of catalog URIs (D6). Its
  `execute` calls `await ctx.require("mcp:read")` then `connection.request(
  "resources/read", { uri }, ctx.signal)`, extracts the concatenated `text` parts
  from `result.contents` (mirroring `mcp.ts:430`–`434`), and returns `ok(...)`.
  Do **not** register the tool for a connection with an empty catalog (AC4/AC7).

- **T12 (impl) — fail-open per resource (supports T2; §8).** Wrap the
  `resources/read` call in the tool's `execute` in `try/catch`; on error return
  `fail("MCP resource read failed: ...")` (the `tools/call` pattern at
  `mcp.ts:435`) — one bad URI must not throw out of the tool or break other reads.

- **T13 (impl) — `/mcp resources` + `/mcp refresh`; count in `/mcp` (makes T5
  green).** Extend the existing `mcp` command (`mcp.ts:445`). Parse the command
  `args`: bare `/mcp` prints each server's tool count **and** resource count;
  `/mcp resources [server]` prints the cached catalog (`uri` per line, optionally
  filtered to one server); `/mcp refresh` calls `refreshResources()` on each
  connection and reports the refreshed counts. Keep the existing `(no MCP servers
  connected)` and per-server line behavior intact.

- **T14 (impl) — kill switch end-to-end (makes T6 green).** Ensure the
  `EAGENT_MCP_RESOURCES === "off"` gate in `start()` (T9) plus the
  "no catalog ⇒ no tool" rule (T11) together yield: no `read_resource` tool, no
  `resources/list` round-trip, tools half untouched. No `/mcp resources` catalog
  effect (empty catalog) when off.

- **T15 (impl) — content-guard default (makes T7 green).** One-line edit in
  `src/extensions/content-guard.ts:29`: change `DEFAULT_FOREIGN_CAPS` from
  `["net:fetch", "mcp:call"]` to `["net:fetch", "mcp:call", "mcp:read"]`. This is
  a **non-optional** owned deliverable (§2, §6, §8): without it, `mcp:read`
  resource bodies are unfenced by default because content-guard's `isForeign`
  check (`content-guard.ts:113`–`115`) only matches capabilities in `foreignCaps`.
  No other content-guard change.

**Per-task acceptance commands (runnable from repo root):**
- After T8: `node --import tsx --test test/mcp.test.ts` passes the
  `parseResourceList` unit case (T1).
- After T11/T12: `node --import tsx --test test/mcp.test.ts` passes the
  registration/read/capability/deny/teardown cases (T2/T3) and the no-resources
  case (T4).
- After T13: `node --import tsx --test test/mcp.test.ts` passes the catalog/cache/
  refresh case (T5).
- After T14: `node --import tsx --test test/mcp.test.ts` passes the kill-switch
  case (T6) and the **whole** `mcp.test.ts` is green.
- After T15: `node --import tsx --test test/content-guard.test.ts` passes
  (existing cases + the new `mcp:read` fencing case, T7).
- Phase exit: `npm run typecheck` exits 0 AND `npm test` exits 0.

**Exit condition:** `test/mcp.test.ts` and `test/content-guard.test.ts` green,
`npm run typecheck` exit 0, `npm test` exit 0 (full suite, no regression in the
existing MCP tests or the wider suite — AC9). host.ts registration and
CLAUDE.md/README inventory are **deferred to batch integration** (§2) and are NOT
part of this phase's exit.

## 3. Engineering Constraints Index

- **Engineering norms (`CLAUDE.md` House conventions):** ESM with `.js` import
  specifiers even for `.ts` files; strict TS (`strict`,
  `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, no `any` — the foreign `resources/list`/
  `resources/read` payloads are typed `unknown` and narrowed by
  `parseResourceList` and inline guards); **zero new runtime deps except jiti**
  (pure Node `fetch`/JSON, already in `mcp.ts` — no SDK); offline `node:test` via
  `tsx` against the scriptable `MockProvider` and the existing stdio fixture;
  kill-switch env var (`EAGENT_MCP_RESOURCES=off`); the existing dispose loop
  (`mcp.ts:459`) tears down every connection and needs no change (no new
  long-lived resource is added) — it must never throw.
- **Capability discipline:** privileged side effects are capability-gated. The
  read tool declares `capabilities: ["mcp:read"]` and calls `ctx.require("mcp:read")`
  before `resources/read`; `mcp:read` is granted in `activate()`. `mcp:call` is
  left untouched (additive, D3).
- **Batch mode (CRITICAL):** do NOT modify `src/host.ts`, `CLAUDE.md`, or
  `README.md`. `mcp` is already in `BUILTIN_EXTENSIONS`; registration and the
  inventory line are deferred to a separate batch-integration step. Tests load the
  extension via `host.use("mcp", activate)` and must NOT depend on the extension
  being in `BUILTIN_EXTENSIONS`. Do NOT bump the README extension count.
- **Files touched by this task (only these):** `src/extensions/mcp.ts`,
  `test/mcp.test.ts`, `src/extensions/content-guard.ts` (one line),
  `test/content-guard.test.ts` (one added case), `docs/design/`,
  `docs/implementation/`.
- **Commit conventions:** `feat(phase1): …` opener; `fix(phase1-roundR):
  <keyword>` within-round; `npm test` and `npm run typecheck` results as trailers;
  NO mention of AI/model/tooling in commit messages.

## 4. Data and Fixture Dependencies

- **Reuse `test/helpers.ts`** (`makeHarness`, `MockProvider` scriptable
  `responder`, `lastText`) for all cases except the AC3 deny case, which (per §7
  AC3) constructs `CapabilityManager`/`Agent`/`ExtensionHost` directly with
  `new CapabilityManager({ deny: ["mcp:read"], ui })` — mirroring `makeHarness`
  internals at `test/helpers.ts:27`–`44` — because the stock harness exposes no
  runtime `deny`.
- **Reuse and extend the existing in-test stdio fixture** (`FIXTURE_SERVER`,
  `mcp.test.ts:63`): add `resources/list` and `resources/read` handlers, and
  advertise `resources: {}` in the `initialize` `capabilities`. Add a
  no-resources variant (advertises only `tools: {}`, returns `-32601` for
  `resources/list` — the existing catch-all at `mcp.test.ts:85` already produces
  this for unknown methods) for AC4, and a list-changes-on-second-call variant for
  the refresh case (AC6). No new external fixtures; no network — all offline.
- **content-guard test (T7):** reuse that suite's existing stub-tool +
  `host.use` pattern (`runWithStub`, `content-guard.test.ts:95`–`121`) with a stub
  declaring `["mcp:read"]`.

## 5. Regression Protection

- **The full existing suite (`npm test`) must stay green** — the change is purely
  additive to the connect path and `activate()`; the tools-half code path
  (`tools/list`, `tools/call`, the `mcp__<server>__<tool>` registration loop, the
  `mcp:call` grant) is unchanged. Specifically the existing `test/mcp.test.ts`
  cases must stay green:
  - `detectSuspiciousDescription flags tool-poisoning markers …`
  - `parseServers skips a duplicate server name …`
  - `parseServers skips malformed entries …`
  - `registers the server's tool after the handshake` (AC1 of the original — the
    tools half still ingests).
  - `calling the MCP tool returns the server's textual result` (tools-half call
    path unaffected).
  - `the /mcp command lists the connected server` (the extended `/mcp` must still
    print `fixture` and `1 tool`).
- **`test/mcp-http.test.ts` must stay green (HTTP connect path)** — `start()` is
  transport-agnostic (`mcp.ts:349`), shared by stdio and HTTP, and T9 adds the new
  `resources/list` block right after `tools/list` in that shared method
  (`mcp.ts:349`–`363`). The HTTP fixture advertises `capabilities: { tools: {} }`
  with no `resources` key (`mcp-http.test.ts:72`) and returns `-32601` for unknown
  methods (`mcp-http.test.ts:92`), so the new block must no-op on this path — via
  the advertised-cap skip (no `resources` capability ⇒ don't probe) and, as a
  backstop, the fail-soft catch around `resources/list`. All three HTTP cases must
  stay green: `registers the HTTP server's tool after the handshake`, `calling the
  MCP tool over HTTP returns the server's textual result` (`mcp__httpfix__ping`
  call path), and `the /mcp command lists the connected HTTP server`.
- **`test/content-guard.test.ts` must stay green** — the only change is adding
  `"mcp:read"` to `DEFAULT_FOREIGN_CAPS`; the existing `net:fetch`/`fs:read`/
  `isError`/teardown/kill-switch cases are unaffected (the new cap only widens the
  foreign set, it does not narrow it).
- **`npm run typecheck` must stay clean** (strict mode; the new code must not
  introduce `any` or unchecked index access — foreign payloads narrowed via
  `parseResourceList` and inline guards).
