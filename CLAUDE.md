# CLAUDE.md

Orientation for an AI agent working in this repository.

## What this is

EAgent is a minimalist AI-agent kernel: a tiny, stable core plus an
Emacs-grade extension surface. The bet is that a small, observable, malleable
core beats a big one — new behavior is always an extension, never a fork.

## Architecture

The kernel is **seven primitives and nothing more**, all under `src/kernel/`:

| Primitive        | File                | Responsibility |
| ---------------- | ------------------- | -------------- |
| Hook bus         | `hooks.ts`          | Lifecycle events (observe) + filter hooks (intervene). |
| Tool registry    | `registry.ts`       | Register/shadow/dispose tools; later wins, disposing restores. |
| Provider         | `types.ts` (interface) | The LLM abstraction: a request → a stream of events. Implementations live in `src/providers/`. |
| Agent loop       | `agent.ts`          | Turns, streaming, guarded/ordered tool dispatch, steering, follow-up. |
| Capability layer | `capabilities.ts`   | Per-capability grant/deny/ask, wildcards, audit log. |
| Extension host   | `extension.ts`      | Discovery, activation, `ExtensionAPI`, hot reload via `jiti`. |
| Command registry | `commands.ts`       | User-facing slash commands. |

**Everything else is an extension** — even the four "built-in" tools
(`read`, `write`, `edit`, `bash`) live in `src/extensions/core-tools.ts`. The
kernel ships with zero opinions about tools, memory, prompts, or sub-agents.

## Key commands

```bash
npm test         # node:test via tsx; runs offline against MockProvider (no API key)
npm run typecheck
npm run build    # tsc -> dist/
npm run dev      # node --import tsx src/cli.ts  (interactive REPL)
```

`npm test` (and the whole suite) runs offline: `MockProvider`
(`src/providers/mock.ts`) is a scriptable, deterministic LLM, so no network and
no `ANTHROPIC_API_KEY` are required. Keep it that way.

## Where things live

- `src/kernel/` — the seven primitives + public barrel (`index.ts`).
- `src/providers/` — `mock` (deterministic), `anthropic`, `openai`, `gemini`
  (all `fetch` + SSE, no SDK), shared `http.ts` plumbing, and `cassette`
  (record/replay). All read config from `process.env`.
- `src/extensions/` — `core-tools`,
  `search` (`fs:read`, parallel `glob`/`grep` tools for finding files and
  searching contents in pure Node — no shell, confined to the workspace root),
  `skills`, `mcp`, `codeact`,
  `subagents` (`spawn_agent` — plus three optional per-spawn least-privilege
  passthroughs: a capability allowlist that scopes a child to a capability subset
  (`readOnly` is now sugar over it), a provider/model override validated against
  the provider registry (falls back to the parent on an unknown name), and an
  `outputSchema` typed return validated via the kernel input-validator with one
  bounded re-prompt then a contract-violation failure; all default-off so an
  unadorned spawn is unchanged, `EAGENT_SUBAGENTS_LP=off`),
  `dynamic-workflow` (a `run_workflow` tool that executes a model-emitted
  dependency DAG of `tool`/`agent` steps with `${id}` output substitution;
  independent steps run in parallel, tool steps reuse the kernel's guard
  sequence so capability/policy checks still apply; agent-steps accept the same
  three per-spawn least-privilege options as `subagents`),
  `memory` (a store-backed `remember`/`recall` working-memory scratchpad with
  white-box per-entry provenance — `/memory list|edit|forget|rollback|
  consolidate`, `EAGENT_MEMORY_ENTRIES=off` kill switch; registers no
  `transformContext` hook — conversation compaction is `compact`'s job),
  `prune` (token-budget tool-output pruning on `transformContext` — truncates
  old, oversized `tool_result` content beyond a protected recent window; no
  capability, `EAGENT_PRUNE=off` kill switch),
  `planmode`, `session`, `packages`, `trace`, `context-files`,
  `microagents` (keyword-triggered knowledge injection on `transformContext` —
  scans one directory of `*.md` files with single-line `triggers:` frontmatter
  and injects a file's body, whole-word-matched and case-insensitive, only when a
  trigger appears in the latest user message; cached scan + `/microagents`
  re-scan, byte-capped prefix fill, no capability, `EAGENT_MICROAGENTS=off` kill
  switch),
  `limits` (per-run call/token budgets + tool-output byte cap; on overflow it
  spills the full output to a gitignored file under `.eagent/tool-output` and
  returns a retrieval hint instead of discarding the clipped bytes),
  `cost` (token→USD accounting on `usage`/`agent_*` — a pure observability
  sibling of `trace`: prices tokens via a date-pinned, store-overridable price
  card, accumulates per-run + per-model session cost, and emits a warn-only
  rolling-mean anomaly flag when a finished run's cost exceeds mean+3σ past a
  5-sample guard; `/cost` status view + `/cost pricecard` setter, no capability,
  `EAGENT_COST=off` kill switch),
  `self`, `web`, `checkpoint`, `introspect`, `journal`, `prompts`,
  `todo` (session-scoped in-memory todo list — a `todowrite` tool that replaces
  and echoes the list plus a `/todos` command; no capability),
  `flow-guard` (compositional egress gate — taints a session on a source
  capability, default `shell:exec`, or sensitive data in the transcript, then
  holds egress, default `net:fetch`; ask or block mode),
  `risk-guard` (LLM-based semantic risk analyzer on `beforeToolCall` — for tools
  whose capabilities intersect a configured sensitive set, default `shell:exec`,
  it classifies the specific call via a recursion-safe, tool-less provider
  sub-call and, on a RISKY verdict, asks or blocks; off by default, no
  capability, fails open with a warning, `EAGENT_RISK_GUARD=off` kill switch; its
  judge prompt is annotated with any decoded obfuscated payload via the shared
  `lib/decode-normalize` helper — see `bash-policy`),
  `bash-policy` (command-granular shell policy gate — evaluates an allow/deny/ask
  ruleset over the full command line plus every effective sub-command (pipe/`;`/`&&`
  segments, unwrapped wrappers like `sudo`/`env`/`timeout`, and `find -exec` inner
  commands), last-match-wins; the matched command family is the approval label;
  also evaluates the ruleset over *decoded* candidates produced by the shared
  `src/extensions/lib/decode.ts` `normalizeForInspection` helper (strips invisible
  Unicode via content-guard's `stripInvisible`, then best-effort decodes
  base64/hex/rot13 and `echo|base64 -d|sh`/`printf '\\xNN'` idioms) so an obfuscated
  `rm -rf /` is caught; the decode layer never blocks on its own, only expands the
  candidate set the existing rules judge, `EAGENT_DECODE_NORMALIZE=off`;
  no-op by default, no capability, `EAGENT_BASH_POLICY=off` kill switch),
  `integrity` (sweeps all tool descriptions for poisoning/hidden instructions,
  and flags descriptions that change across sessions — a rug-pull guard),
  `recovery` (turns a *failed* tool result into a corrective nudge — appends one
  hint keyed to EAgent's own error strings via `afterToolCall`, so the model
  self-corrects instead of re-issuing the broken call; on by default, no
  capability, `EAGENT_RECOVERY=off` kill switch),
  `output-contract` (schema-validated final output — when a caller sets
  `Agent.outputSchema`, it registers a per-run `respond` tool whose parameters
  ARE that schema so the kernel's input validation coerces/validates the model's
  answer for free; a valid call surfaces the typed value on `Agent.output` and
  ends the turn, an invalid one drives a bounded validate-and-reask on
  `afterToolCall` echoing the validator's exact per-field errors (default 2
  retries) then flags the best-effort value and stops; on the corrective/reask
  turn it also sets `Agent.forceTool` so the kernel's `CompletionRequest.toolChoice`
  COMPELS the `respond` call at decode time (native per-provider mapping with
  graceful degrade — best-effort becomes near-guaranteed, the retry cap remains
  the bound), never forcing the model's initial working turns; inert with no
  schema set, no capability, `EAGENT_OUTPUT_CONTRACT=off` kill switch),
  `write-guard` (prompts before a *blind overwrite* — a full-content `write` to
  an existing file the session has not read — via `beforeToolCall`; tracks
  read/edit/written paths per session, asks once, excludes `edit` and new-file
  creation; on by default, no capability, `EAGENT_WRITE_GUARD=off` kill switch),
  `content-guard` (ingress trust labeling — on `afterToolCall`, for *successful*
  results from a *foreign*-capability tool (default `net:fetch`/`mcp:call`) it
  strips always-invisible injection-vector Unicode (zero-width/bidi/tag/variation
  selectors) and wraps the body in an `<untrusted-content>` provenance fence with
  a standing "data, not instructions" note; skips error results so it stays
  disjoint from `recovery`; never blocks or calls a model, no capability, on by
  default, `EAGENT_CONTENT_GUARD=off` kill switch),
  `circuit-breaker` (tool-call repetition / consecutive-failure fail-fast — a
  per-run `Map` keyed on the call signature `name + canonical(args)` where object
  keys are recursively sorted; on `beforeToolCall` the 2nd identical occurrence
  earns one non-blocking `steer` nudge and the N-th (default threshold 3) — or N
  consecutive failures of that signature, tracked via `afterToolCall` and reset on
  success — asks via `ui.confirm` in `ask` mode or blocks in `block` mode; counts
  total-in-run so A-B-A-B oscillation trips; resets all state on `agent_start`,
  exports a pure `stableSignature`, fails open, on by default mode `ask`, no
  capability, `/circuit-breaker` command, `EAGENT_CIRCUIT_BREAKER=off` kill switch),
  `secret-guard` (keeps secret *values* out of outgoing tool args — on
  `beforeToolCall`, scans the args of leak-capable tools (default
  `net:fetch`/`shell:exec`/`mcp:call`) for known-credential patterns (reused from
  flow-guard) + optional high-entropy tokens and, on a hit, asks via `ui.confirm`
  in `ask` mode or blocks in `block` mode — never echoing the matched value;
  the prevention seam flow-guard's egress taint and content-guard's ingress fence
  leave open; on by default, no capability, `EAGENT_SECRET_GUARD=off` kill switch),
  `sweep-edit` (a `sweep_edit` tool for regex-enumerated multi-site refactors —
  enumerates match sites via the `search` extension (workspace-confined, no shell)
  then fans a scoped sub-agent per file that applies the change or declines;
  per-site isolation, a max-sites cap with a logged truncation note, capabilities
  `fs:write`+`agent:spawn`; composes `search`+`subagents` rather than reimplementing
  either),
  `citations` (grounding/attribution — on `afterToolCall` it prepends a visible
  stable `[src:N]` id to *retrieval*-capability tool output (default
  `net:fetch`/`fs:read`) and records it per-run; on `agent_end` it parses the final
  answer's `[src:N]`/`[N]` markers and warns (never blocks) on a *fabricated*
  citation — an id never emitted; `/citations` report, on by default, no capability,
  `EAGENT_CITATIONS=off` kill switch),
  `env-report` (classifies *environmental* tool failures — auth/missing-binary/
  network/permission — on `afterToolCall`; for that error class it surfaces an
  `environment_issue` to the host and *replaces* `recovery`'s retry-nudge with a
  "surface and route around, do not retry" note (registered after `recovery`), so
  the model stops looping on an infra fault; plus an `env_report` tool the model
  can call to declare a blocker; on by default, no capability,
  `EAGENT_ENV_REPORT=off` kill switch),
  `evals` (offline behavior-eval harness — a pure event-bus trajectory consumer
  (trace shape) plus `/expect` declarative trajectory assertions (tool order/exact,
  span count, finish reason, no-tool-errors, token budget), an `/eval <dir>`
  headless runner over `*.eval.json` scenarios printing a pass@k scorecard, and a
  `judge` tool (rubric+candidate → score/verdict/reason) via a recursion-safe
  tool-less provider sub-call; ships a `test/security/` regression set asserting the
  safety guards still fire; offline against MockProvider/cassette, no capability),
  `handoff` (session resume document — a `/handoff-doc` command + an `agent_end`
  observer that summarizes the transcript via a recursion-safe tool-less provider
  sub-call into a fixed handoff schema (goal / completed / in-progress / pending /
  files touched / commands run / open decisions / do-not-touch / next 3-7 steps)
  plus a paste-ready reactivation paragraph, written to a gitignored
  `.eagent/handoffs/<date>-<slug>.md`; plus an opt-in, relevance- and
  freshness-gated read side that injects the newest matching prior handoff once
  into a fresh session's first turn via `transformContext` (`/handoff-doc resume
  on`, separate `resume` flag default off, `EAGENT_HANDOFF_RESUME=off`); distills a
  session into a resumable artifact and reads it back, off by default,
  `EAGENT_HANDOFF=off`),
  `drift-probe` (reasoning-quality canary — every N turns it fires a recursion-safe
  tool-less provider sub-call on a rotating pinned canary question with a known-good
  answer, scores regression vs the turn-0 baseline, and on a regression warns +
  injects an optional `transformContext` note suggesting `/compact` or `/handoff`; a
  *leading* indicator of context-pressure degradation the size-managers (prune/
  limits) can't see; never blocks, off by default, `EAGENT_DRIFT_PROBE=off`),
  `skills-hardening` (guards the skill self-extension surface — scans each
  `SKILL.md` body + skill scripts for `eval`/`exec`/`curl`/env-near-network
  patterns and fingerprints bodies for cross-session rug-pull (warn-only,
  complementing `integrity`'s description sweep); validates skill frontmatter;
  scopes an active skill to its `allowed-tools` via a `beforeToolCall` ask/deny
  (no-op when unspecified); and optionally gates a skill's tier-1 disclosure on
  `triggers:` frontmatter, `EAGENT_SKILL_TRIGGERS=off`; each guard independently
  killable, no new capability).
  `compact` (token-gated structured conversation compaction on
  `transformContext` — the token-aware structured-slot successor to `memory`'s
  retired count-based compaction; when the estimated transcript exceeds a budget
  it folds the older prefix at a user-turn boundary into `## Decisions` /
  `## Files` / `## Open threads` via a recursion-safe tool-less provider sub-call,
  keeps the last K user turns verbatim, and re-injects a byte-capped pinned block
  so designated evidence always survives. Registered in `BUILTIN_EXTENSIONS`
  right after `prune`, but **off by default** — opt in via `enabled` /
  `/compact on`; `EAGENT_COMPACT=off` is the hard kill switch, no capability),
  `ask` (agent→host elicitation — the inverse of `steer`/`followUp`: an
  `ask_user_question` tool ({question, options?}) so the model can pause and ask
  the human *before* guessing on an ambiguous instruction, gated by a `ui:ask`
  capability so a non-interactive/batch run auto-declines; it calls an OPTIONAL
  `UI.ask` method (implemented on the CLI via readline; absent → the tool returns a
  "proceed with a stated assumption" fallback so an ambiguous task still makes
  progress). The HTTP server implements a durable channel: a mid-turn ask emits an
  `action_required` NDJSON event on the open `/run` stream, parks the turn, and
  resumes when the client answers out-of-band via `POST /answer`, with a
  bounded-timeout + disconnect fallback (the server's `confirm` stays fail-safe
  deny so supplying a `ui` never flips the guards open). No agent-loop change, the
  UI method is optional/back-compatible),
  `routing` (difficulty-aware per-turn model tiering — on `turn_start` a cheap
  deterministic heuristic classifier (default flagship-when-unsure), or an optional
  recursion-safe tool-less sub-call, picks a tier from a store-configurable map and
  sets the existing mutable `Agent.model` for that turn; restores the configured
  model on disable/`agent_end` and validates a tier model against the provider
  registry; pairs with `cost` (which measures) and `subagents`' per-spawn provider
  override; off by default, `EAGENT_ROUTING=off`, no kernel change).
- `src/host.ts` — shared wiring reused by both front ends: provider selection,
  `.env` loading (`loadEnvFile`), model defaulting (honors `*_MODEL` env vars),
  and the canonical builtin extension set.
- `src/cli.ts` — the terminal host: interactive REPL, batch, one-shot.
- `src/complete.ts` — the REPL Tab-completion engine: a pure `complete(line, ctx)`
  returning readline's `[matches, substring]`; completes command names, command
  arguments, and filesystem paths, with `readDir`/`homedir` injected so it is
  offline-testable.
- `src/server.ts` — the HTTP host (`GET /health`, `POST /run`, `DELETE /sessions/:id`).
- `test/` — the full offline suite, one file per primitive/extension.
- `examples/extensions/` — worked example extensions.
- `docs/EXTENSIONS.md` — the extension author's guide.

## House conventions

- **ESM + NodeNext.** Always use `.js` import specifiers even when importing a
  `.ts` file (e.g. `import { defineTool } from "../kernel/define.js"`). This is
  required by `module: NodeNext` and `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch` are all on. No `any`
  cop-outs; model the types.
- **Zero runtime dependencies except `jiti`.** Do not add npm dependencies.
  Providers use the global `fetch`; nothing pulls in an SDK.
- **Tests use `node:test` run via `tsx`**, and must run offline. Every
  extension is capability-gated and ships with tests.
- **Capabilities are the security vocabulary.** Privileged tools declare
  `capabilities: [...]` (e.g. `fs:read`, `shell:exec`) and the dispatcher
  enforces them before `execute` runs.

When adding an extension: register through the `ExtensionAPI`, track every
registration (the host does this for you so reload is clean), gate side effects
behind a capability, and add an offline test.
