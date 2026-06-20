# Design: Normalized Reasoning / Thinking Support

- Slug: `2026-06-20-reasoning-thinking-support`
- Status: closed
- Closing-commit: 7ab40dc
- Closed-on: 2026-06-20
- Deferred: none
- Tier: Full Mode (three-loop-workflow) — touches the kernel's stable contract
  (`src/kernel/types.ts`), a load-bearing file per CLAUDE.md ("the stable
  contract between the core and every extension").

> Provenance & review history: the implementation landed in commit `2f0890d`;
> this design is its Full-Mode record, authored and then put through fresh-eyes
> review. L1 design — round 1 raised three general issues (missing `events.ts`
> anchor for D3, the 232-vs-242 test-count framing, the undocumented Gemini-`off`
> asymmetry), all fixed; rounds 2 and 3 clean. L2 implementation — round 1 raised
> one general issue (per-file acceptance commands used `npm test -- <file>`, which
> the script's glob defeats), fixed to `node --import tsx --test <file>`; rounds 2
> and 3 clean. F whole-change review — pass, zero severe; one cosmetic general
> (a thinking block mislabeled in the memory fallback digest) fixed in closing
> commit `7ab40dc`. Round-by-round detail lives in git history.

## 1. Background and Purpose

EAgent's `Provider` primitive (`src/kernel/types.ts`) turns a request into a
stream of events. Until now that request carried no notion of *reasoning
effort*: there was no way to ask a model to think harder, and no way to surface a
model's chain-of-thought. Modern frontier models are reasoning-first — Claude
Opus 4.6+/Fable 5 (adaptive thinking + `output_config.effort`), OpenAI o-series /
GPT-5 (`reasoning_effort`), Gemini 2.5 (`thinkingConfig.thinkingBudget`) — and
EAgent could engage none of it. The default model is `claude-fable-5`, whose
thinking is always on; EAgent had no channel to tune or observe it.

The sibling harness `earendil-works/pi` solves this by normalizing one thinking
level in its agent core and letting each provider map it to its native control.
This task ports that idea into EAgent's Provider abstraction.

If we do not do this: EAgent cannot use reasoning models effectively, cannot
control the intelligence/latency/cost trade-off, and cannot render or audit model
reasoning. The gap widens as reasoning models become the default everywhere.

## 2. Deliverables

- [x] D1: A normalized `ThinkingLevel = "off" | "low" | "medium" | "high"` type
  on `CompletionRequest` (`src/kernel/types.ts`).
- [x] D2: A `ThinkingBlock` content block (`{ type: "thinking"; thinking; signature? }`)
  added to the `ContentBlock` union, so reasoning can be retained on a message and
  replayed where the provider requires it.
- [x] D3: A `reasoning_delta` `StreamEvent` variant (`src/kernel/types.ts`) and a
  matching `reasoning_delta` kernel hook event (`src/kernel/events.ts`,
  `KernelEvents`); the agent loop forwards provider `reasoning_delta`s to the hook
  bus.
- [x] D4: The agent threads `agent.thinking` into every `CompletionRequest`.
- [x] D5: Anthropic provider maps the level to adaptive thinking +
  `output_config.effort`, parses thinking/signature deltas into a `ThinkingBlock`,
  emits `reasoning_delta`, and re-serializes signed thinking blocks back onto the
  wire (dropping unsigned ones).
- [x] D6: OpenAI provider maps to `reasoning_effort` and surfaces
  `reasoning_content` deltas as reasoning (kept out of the answer text).
- [x] D7: Gemini provider maps to `thinkingConfig.thinkingBudget` /
  `includeThoughts` and surfaces `thought: true` parts as reasoning.
- [x] D8: Mock provider replays scriptable `reasoning` and records the requested
  level (`lastThinking`) for deterministic offline tests.
- [x] D9: Host + CLI wiring — `AgentHostOptions.thinking`, an `EAGENT_THINKING`
  env default, a `--think <level>` flag, reasoning rendered dimmed in the REPL and
  emitted in `--json` mode.
- [x] D10: Offline tests covering the request mapping, reasoning-delta surfacing,
  and the signed-block round-trip for each provider, plus host wiring.

## 3. Scope Boundary (NOT in scope)

- **No legacy `budget_tokens` path for Anthropic.** Modern Claude models reject
  it; EAgent's default is `claude-fable-5`. Pre-4.6 Anthropic models are not
  supported for thinking. (Out of scope by decision — see §4.1.)
- **No `xhigh` / `max` effort levels.** Four levels keep the neutral surface
  tight; extending the enum later is additive and non-breaking.
- **No cross-provider reasoning replay.** A `ThinkingBlock` produced by one
  provider is not sent to another (OpenAI/Gemini serializers drop thinking
  blocks; Anthropic only replays its own signed blocks). Reasoning is single-
  provider-per-session.
- **No persistence/format change.** Thinking blocks ride in the existing message
  `content` array; no session-file or transcript schema migration. (`isMessage`
  only checks `role`/`content` shape, which is unchanged.)
- **No per-tool or per-turn thinking override.** A single `agent.thinking` applies
  to the whole run.
- **No runtime `/think` slash command.** Control is via flag/env/`agent.thinking`
  field; a slash command would need a new extension and is deferred.

## 4. Key Design Decisions

### 4.1 Anthropic reasoning mapping: adaptive thinking + effort, not `budget_tokens`

- **Problem**: how to express a normalized level to Anthropic.
- **Options**: (a) legacy `thinking: {type:"enabled", budget_tokens:N}`;
  (b) adaptive thinking (`{type:"adaptive", display:"summarized"}`) +
  `output_config: {effort: level}`.
- **Choice**: (b). **Rejected (a)** because modern Claude models (Opus 4.7/4.8,
  Fable 5 — EAgent's default) return HTTP 400 on `budget_tokens`; it is removed,
  not merely deprecated. `effort` is the GA control. For `"off"` we send *neither*
  field, leaving the model default (which on always-thinking models is still on) —
  this avoids `{type:"disabled"}`, which 400s on Fable 5.

### 4.2 Reasoning as a first-class content block with a signature

- **Problem**: Anthropic requires the thinking block (with its opaque
  `signature`) to be echoed back, unmodified, when continuing a turn that used
  tools under extended thinking; omitting it returns 400. Where to store it?
- **Options**: (a) store it on `Message.meta`; (b) add a `ThinkingBlock` to the
  `ContentBlock` union.
- **Choice**: (b). **Rejected (a)** because `Message.meta` is explicitly never
  seen by `Provider.stream` (kernel contract), so it cannot round-trip to the
  wire. The block must live in `content`. Replay is gated on a non-empty
  `signature`: signed → re-serialize verbatim; unsigned (e.g. summary-only or
  cross-provider) → drop, so we never send a block Anthropic would reject.

### 4.3 Reasoning surfaced as a separate stream/hook event, not folded into text

- **Problem**: how should reasoning reach renderers/extensions?
- **Options**: (a) prepend reasoning to assistant text; (b) a dedicated
  `reasoning_delta` event parallel to `text_delta`.
- **Choice**: (b). **Rejected (a)** because reasoning is not the answer; folding
  it in would corrupt the transcript text, break extensions that read assistant
  text, and prevent dim/separate rendering. A parallel event mirrors the existing
  `text_delta` seam exactly.

### 4.4 A normalized four-value level, mapped per provider

- **Problem**: each provider has a different native dial (effort string, effort
  string, token budget).
- **Options**: (a) a provider-specific raw passthrough; (b) one neutral enum the
  kernel owns, mapped at each provider boundary.
- **Choice**: (b), matching `earendil-works/pi`. **Rejected (a)** because a raw
  passthrough leaks provider vocabulary into the kernel contract and every
  caller, defeating the point of the Provider abstraction. Gemini's budget map:
  off→0, low→1024, medium→8192, high→24576 tokens. Note one deliberate per-provider
  asymmetry on `"off"`: Anthropic and OpenAI **omit** their reasoning field
  entirely, but Gemini **sends an explicit `thinkingConfig` with `thinkingBudget:0`
  / `includeThoughts:false`** — that is how a Gemini 2.5 model is actively told not
  to think (omitting the config would instead leave it at the model default).

## 5. Dependencies and Assumptions

- Zero new runtime dependencies (house rule: only `jiti`). All providers remain
  `fetch` + SSE.
- Assumes the documented Anthropic streaming shapes for thinking: a
  `content_block` of `type:"thinking"`, `thinking_delta`/`signature_delta` content
  deltas, and that `output_config.effort` is the GA reasoning control on Claude
  Opus 4.6+/Fable 5. Verified against the Claude API reference current as of
  2026-06 (the `claude-api` skill bundle); this is the most time-sensitive claim
  and R1 owns its residual risk.
- Assumes OpenAI-compatible endpoints that expose reasoning do so on a sibling
  `delta.reasoning_content` field; absence is a no-op.
- Assumes Gemini 2.5 `thinkingConfig` shape (`thinkingBudget`, `includeThoughts`)
  and `thought: true` parts; older models ignore the config.
- Backward compatible: `thinking` is optional on the request and defaults to
  `"off"`; the new `ThinkingBlock`/`reasoning_delta` are additive union members.

## 6. Relationship with Existing Designs

- Prior designs: `docs/design/2026-06-17-console-autocomplete.md`,
  `docs/design/2026-06-20-dynamic-workflow.md`. No conflict — this change is on the
  Provider/agent-loop seam, orthogonal to autocomplete (CLI input) and
  dynamic-workflow (a tool extension). No succession relationship.
- The project CLAUDE.md is an orientation doc with no formal anchor-map / role
  vocabulary; terminology anchors are CLAUDE.md and the existing
  `src/kernel/types.ts` contract. `<TEST-CMD>` = `npm test`; `<ACCEPT-CMD>` =
  `npm run typecheck` and `npm run build` (from CLAUDE.md "Key commands").
- This extends the **Provider** and **Agent loop** primitives described in
  CLAUDE.md "Architecture"; it adds no new primitive (the seven-primitive rule
  holds). It adds members to the stable `types.ts` contract — additive, non-
  breaking.

## 7. Acceptance Criteria

All criteria are mechanically verifiable offline (no network, no API key).

- AC1 (D1–D4, D8): `npm run typecheck` exits 0 — the new types compile and the
  `ContentBlock` union extension breaks no existing handler.
- AC2 (D5): `test/anthropic.test.ts` asserts a non-`off` level emits
  `thinking:{type:"adaptive",display:"summarized"}` + `output_config:{effort:level}`
  on the request body, and `off` emits neither. Run:
  `node --import tsx --test test/anthropic.test.ts` (or full `npm test`), exit 0.
- AC3 (D5): `test/anthropic.test.ts` asserts streamed `thinking_delta`s surface as
  `reasoning_delta` events and assemble a `ThinkingBlock` carrying the streamed
  `signature`; and that a signed thinking block round-trips back to the wire while
  an unsigned one is dropped.
- AC4 (D6): `test/openai.test.ts` asserts `reasoning_effort` mapping (omitted on
  `off`) and that `reasoning_content` surfaces as `reasoning_delta` without
  appearing in the answer text.
- AC5 (D7): `test/gemini.test.ts` asserts the `thinkingConfig` budget mapping
  (`off`→budget 0) and that `thought:true` parts surface as reasoning, kept out of
  the answer text.
- AC6 (D3–D4, D8): `test/agent.test.ts` asserts the agent forwards `agent.thinking`
  to the provider (`provider.lastThinking`) and re-emits provider `reasoning_delta`
  as a hook event, retaining the thinking block on the assistant message.
- AC7 (D9): `test/host.test.ts` asserts `thinkingFromEnv` parses known levels and
  falls back to `off`, and `createAgentHost({thinking})` threads the level onto the
  agent.
- AC8: full `npm test` exits 0 (242 tests, of which ~10 are new for this change;
  no regression in the prior 232) and `npm run build` exits 0.
- Quality budget: this is a CLI/streaming change with no hot path; the relevant
  budget is correctness, realized as AC1–AC8. No latency/throughput budget applies
  (excluded here).

## 8. Risks and Rollback

- **R1: Anthropic rejects a replayed thinking block.** Mitigated by replaying only
  blocks with a non-empty `signature` and verbatim (`thinking` + `signature`); the
  round-trip test pins this. If wrong against the live API, the blast radius is a
  400 on Anthropic turns that used thinking + tools.
- **R2: `ContentBlock` union extension breaks an exhaustive consumer.** Mitigated
  by typecheck + the fresh-eyes review that audited every content-mapping site;
  all use `if/else`/`.filter` chains that ignore unknown blocks.
- **R3: A reasoning-exposing OpenAI/Gemini field name differs by endpoint.**
  Low impact — absence is a silent no-op (reasoning simply isn't surfaced); the
  answer path is unaffected.
- **Rollback**: the change is additive and behind `thinking` defaulting to `off`.
  Reverting commit `2f0890d` (plus this doc's closing commit) fully removes it with
  no migration, since no persisted format changed.
