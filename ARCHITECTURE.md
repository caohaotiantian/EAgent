# EAgent Architecture

This is the design document for EAgent: what the kernel is, why it is shaped the
way it is, and how a turn actually flows through the code. It is meant to be
accurate to the source — file references point at the code that implements each
claim.

## The thesis

Emacs has survived for four decades because of a single architectural decision:
a small C core that hosts a language in which *almost everything is redefinable
at runtime*. Primitives live in the core; policy lives in the extension
language. EAgent applies that decision to AI agents.

The kernel is **seven primitives and nothing more**. It ships with zero opinions
about tools, prompts, memory, sub-agents, or UI. The four "built-in" tools
(`read`, `write`, `edit`, `bash`) are themselves an extension. Everything you
would want to change is a hot-reloadable extension you can edit while the agent
is running. The bet is the same one Emacs and pi make: a minimal, observable,
malleable core beats a big one — new behavior is always an extension, never a
fork.

The whole core lives under `src/kernel/` and is held below a hard line ceiling
by a test (see *The minimalism guard* below).

## The seven primitives

All seven live in `src/kernel/`, and are the entire intended public surface of
the kernel (re-exported from `src/kernel/index.ts`).

| Primitive            | File                          | Responsibility |
| -------------------- | ----------------------------- | -------------- |
| **Hook bus**         | `src/kernel/hooks.ts`         | Lifecycle events (observe) and filter hooks (intervene) — Emacs *hooks* + *advice*. |
| **Tool registry**    | `src/kernel/registry.ts`      | Register / shadow / dispose tools and providers; a later definition wins, disposing it restores the prior one. |
| **Provider**         | `src/kernel/types.ts`         | The single thing the kernel knows about an LLM: a request becomes a stream of events. |
| **Agent loop**       | `src/kernel/agent.ts`         | Turns, streaming, guarded and ordered tool dispatch, steering, follow-up, and stop conditions. |
| **Capability layer** | `src/kernel/capabilities.ts`  | Per-capability allow / deny / ask, wildcards, and an audit log. |
| **Extension host**   | `src/kernel/extension.ts`     | Discovery, activation, the `ExtensionAPI`, and hot reload via `jiti`. |
| **Command registry** | `src/kernel/commands.ts`      | User-facing slash commands — `M-x` for agents. |

Supporting modules round out the kernel without being primitives in their own
right: `types.ts` (shared types plus `Usage` accounting helpers), `events.ts`
(the typed event/filter maps), `define.ts` (`defineTool` and result helpers),
`validate.ts` (JSON-Schema argument validation), and `store.ts` (the namespaced
persistent `Store` with memory and file backends).

### Hook bus — `src/kernel/hooks.ts`

The nervous system. It offers two complementary mechanisms:

- **Notifications** (`on` / `emit`) — fire-and-forget lifecycle signals.
  Handlers run in registration order and one throwing does not abort the rest
  (errors are surfaced through a redirectable reporter and the loop continues).
- **Filters** (`filter` / `apply`) — a value is threaded through each handler,
  which may transform it or short-circuit. An optional `shouldStop` predicate
  halts the chain once a terminal value (e.g. a veto) is produced, so a later
  filter cannot override a decision already made. Filter errors are fatal to the
  chain by design.

Both are typed against map interfaces so extensions get autocomplete and the
compiler catches payload mistakes.

### Tool registry — `src/kernel/registry.ts`

Holds tools and providers. Registration returns a `Disposable`; registering a
tool under an existing name *shadows* the previous one, and disposing the new
registration restores the prior definition. This is what makes a hot reload a
clean swap rather than an accumulation.

### Provider — `src/kernel/types.ts`

A `Provider` is the LLM abstraction: given a request (system prompt, messages,
tool specs, model, abort signal) it returns an async iterable of stream events
(`text_delta`, `done`, …). The kernel knows nothing else about an LLM — not the
wire format, not auth, not retries. Concrete providers live in `src/providers/`.

### Agent loop — `src/kernel/agent.ts`

The one piece that must be small, correct, and observable, because everything
else hangs off it. See *The agent loop* below.

### Capability layer — `src/kernel/capabilities.ts`

Authority for tools and extensions, expressed as dotted strings (`fs:read`,
`shell:exec`, `net:fetch`, …). See *The capability model* below.

### Extension host — `src/kernel/extension.ts`

Discovers, activates, reloads, and tears down extensions, and defines the public
`ExtensionAPI`. See *The extension host* below.

### Command registry — `src/kernel/commands.ts`

Holds user-facing slash commands (`/help`, `/tools`, `/reload`, …). Extensions
register commands through the `ExtensionAPI`; the front ends dispatch them.

## The agent loop

A turn, as implemented in `Agent.run` / `streamTurn` / `dispatch`:

1. **Drain steering.** Any messages injected via `steer()` are appended to the
   transcript before the model is called, then `turn_start` is emitted.
2. **Assemble context (filterable).** The current transcript is passed through
   the `transformContext` filter hook, so extensions can compact, inject memory,
   or RAG the prompt without touching the loop.
3. **Stream from the provider.** The selected provider streams events;
   `text_delta` events are re-emitted on the bus, and the terminal `done` event
   yields the assistant message, a stop reason, and `Usage`.
4. **Account usage.** The reported `Usage` is summed into the agent's cumulative
   total and a `usage` event is emitted (`{ usage, cumulative }`). This is what
   `/usage` and the `trace` extension read.
5. **Dispatch tool calls (guarded and ordered).** Tool-call blocks in the
   assistant message are run through `dispatch`. Tools may run in parallel, but
   if any requested tool declares `executionMode: "sequential"` the whole batch
   runs in order. Results are always appended in the order the model requested
   them, regardless of completion order. Each call goes through `runOne` →
   `executeGuarded`:
   - arguments are validated against the tool's JSON Schema;
   - the `beforeToolCall` filter can rewrite the arguments or block the call;
   - each declared capability is required (`capabilities.require`) before the
     body runs;
   - the result passes through the `afterToolCall` filter;
   - `tool_start` / `tool_end` events bracket the call.
6. **Decide whether to continue.** If the assistant produced no tool calls, the
   loop drains any queued **follow-up** messages and continues, or otherwise
   stops with the model's stop reason. If every tool result is marked
   `terminate`, the loop stops. A `maxTurns` safety bound (default 24) caps a
   single `run`.

Two injection points make a running agent controllable from outside:
**steering** injects a message before the next model call (interruptions,
corrections), and **follow-up** queues work for when the loop would otherwise
idle (automation). Both are exposed to tools through the capability-limited
`AgentHandle`.

## The hook model: observe and intervene

The hook bus maps cleanly onto Emacs's two extension idioms:

- **Lifecycle events** (Emacs *hooks*) are notifications you subscribe to with
  `on`: `agent_start`, `turn_start`, `message`, `text_delta`, `tool_start`,
  `tool_end`, `usage`, `turn_end`, `agent_end`, `error`, plus session/reload
  signals. They observe; they cannot change the value.

- **Filter hooks** (Emacs *advice*) thread a value through your handler that you
  can transform or veto. There are three seams:
  - `transformContext` — reshape the messages before they reach the model
    (compaction, memory, context-file injection, RAG).
  - `beforeToolCall` — approve, rewrite, or block a tool call before it runs.
  - `afterToolCall` — post-process a tool result (truncation, redaction).

These three seams are where memory strategies, plan-mode approvals, safety
gates, and resource limits plug in without modifying the loop.

## The capability model

The kernel exists to run LLM-directed — and optionally LLM-authored — code, so
authority is explicit rather than ambient. A capability is a dotted string
naming an authority: `fs:read`, `fs:write`, `shell:exec`, `code:exec`,
`net:fetch`, `skill:write`, `mcp:call`, `agent:spawn`, `pkg:install`,
`self:extend`. Tools declare what they need; the dispatcher enforces the
declaration before the tool body runs.

Decisions come from an ordered policy in `CapabilityManager`:

1. an explicit **deny** pattern → deny (takes precedence);
2. an explicit **grant** pattern → allow;
3. otherwise the **fallback** decision — `ask` by default (prompt the human),
   `allow` for trusted/automated runs (`--yolo`), `deny` for locked-down ones.

Patterns support a trailing `*` wildcard segment (`fs:*`, `*`). Every check is
recorded in an audit log that `/caps` can inspect. This layer is the one thing
pi deliberately omits — reasonable for a trusted single-user coding agent, but
EAgent makes LLM-authored code a first-class mode, so it carries the capability
layer from day one. It enforces *authority*; it does not pretend to sandbox
arbitrary in-process code (see `SECURITY.md`).

## The extension host

An extension is a module with a default-exported activation function that
receives the `ExtensionAPI`:

```ts
export default function activate(e: ExtensionAPI) {
  e.registerTool(myTool);
  e.on("turn_end", () => { /* ... */ });
  return () => cleanup(); // optional deactivate
}
```

The activation function may be async. The `ExtensionAPI` is the single,
versioned public surface — `registerTool`, `registerProvider`,
`registerCommand`, `on`, `hook`, `grantCapability`, a namespaced `store`, `log`,
the `agent`, the `commands` registry, plus `reload`, `loadExtension`, and
`unloadExtension`. It follows VS Code's discipline: minimal, additive, never
broken.

**Tracked disposables make reload clean.** Every registration the host hands an
extension is wrapped so the host owns its `Disposable`. On `reload`, the host
disposes the old extension's combined teardown (restoring shadowed tools,
removing hooks and commands), re-imports the module, and re-activates it. Any
function or `Disposable` an extension returns from `activate` is added to that
teardown, so deactivation is precise. `unload` tears an extension down without
reactivating.

**Discovery and hot reload.** The host discovers extension files in a list of
directories (project `.eagent/extensions/` then user `~/.eagent/extensions/`,
most-specific last so it wins on id collision). Files are loaded via `jiti`,
which evaluates TypeScript with no build step; the loader is configured with
`moduleCache: false` so re-importing a file on reload re-evaluates it.
`loadExtension` is the uniform seam through which built-ins, discovered,
self-authored, and package-installed extensions all flow, so reload and unload
work on them identically.

## The provider abstraction

Providers turn a request into a stream of events and nothing more. Three ship in
`src/providers/`:

- **`mock`** — a scriptable, deterministic LLM. It is why the entire test suite
  runs offline and why you can explore the agent with no API key.
- **`anthropic`** — fetch + SSE, no SDK. Prompt-caches the stable system+tools
  prefix and reports `Usage` per completion.
- **`openai`** — fetch + SSE, no SDK, the same event contract.

The two live providers share `src/providers/http.ts`, which centralizes the
retry/backoff logic (429/5xx and network errors, honoring `retry-after`), SSE
parsing, and usage accounting. Their `fetch` is injectable for testing.

## Host and front ends

The kernel is deliberately oblivious to which front end drives it. The shared
*host* wiring lives in `src/host.ts`: `createAgentHost` selects a provider from
configuration, constructs the `CapabilityManager`, `Agent`, `ExtensionHost`, and
`CommandRegistry`, registers the providers, and loads the canonical built-in
extension set (`BUILTIN_EXTENSIONS`) in order before discovering project/user
extensions. `host.ts` is a host, not part of the kernel — it has opinions (which
providers, which extensions); the kernel stays neutral.

Four front ends share that one assembly, so they all load exactly the same
extensions:

- **Interactive REPL** — `src/cli.ts` when stdin is a TTY: `/help`, `/tools`,
  `/reload`, etc.
- **One-shot** — `eagent -e "…"` runs a single turn and exits; `--json` emits
  lifecycle events as JSONL on stdout (diagnostics go to stderr).
- **Batch** — piped, non-interactive stdin, processed line by line.
- **HTTP server** — `src/server.ts` (`eagent-serve`, default `PORT` 8787),
  `node:http` only. `GET /health` returns `{ ok, model, extensions }`;
  `POST /run` with `{ "input": "…" }` streams lifecycle events as newline-
  delimited JSON. It runs with the `allow` capability fallback by default.

## The minimalism guard

`test/kernel-surface.test.ts` pins the kernel's complete public surface: adding
a new export to `src/kernel/index.ts` fails the test until the author either
moves the addition into an extension or deliberately updates the expected list.
A second assertion holds the total line count of `src/kernel/` under a hard
ceiling (2200 lines). Together they make core growth a conscious decision — new
capability is an extension by construction.

## Data flow

```
   user / front end (REPL · one-shot · batch · HTTP server)
            │  agent.run(input)
            ▼
   ┌──────────────────────── Agent loop (agent.ts) ─────────────────────────┐
   │  drain steering ─► transformContext (filter) ─► provider.stream(req)    │
   │        ▲                                                │               │
   │        │ follow-up                          text_delta / done + usage   │
   │        │                                                ▼               │
   │   continue? ◄── append tool results ◄── dispatch(calls)                 │
   │                                              │                          │
   │                       beforeToolCall (filter)│ validate args            │
   │                       capability.require ────┤ capabilities.ts          │
   │                       tool.execute ──────────┤ registry.ts              │
   │                       afterToolCall (filter) ┘                          │
   └────────────────────────────────────────────────────────────────────────┘
            │  events on the hook bus (hooks.ts): tool_start/tool_end,
            ▼  message, usage, turn_*, agent_* …  observed by extensions
   trace · memory · limits · planmode · session · context-files · …
```

## Built-in extensions

Each is a single file under `src/extensions/`, rides the `ExtensionAPI`, ships
with offline tests, and gates privileged work behind a capability. They load in
the order listed in `BUILTIN_EXTENSIONS` (`src/host.ts`).

| Extension       | What it adds |
| --------------- | ------------ |
| `core-tools`    | The four base tools `read`, `write`, `edit`, `bash`, workspace-confined and capability-gated (`fs:read`, `fs:write`, `shell:exec`). |
| `skills`        | LLM-authored skills via Anthropic's `SKILL.md` standard with progressive disclosure; authoring is gated behind `skill:write`. |
| `mcp`           | Model Context Protocol client (stdio, newline-delimited JSON-RPC 2.0); registers each server's tools as `mcp__<server>__<tool>`. |
| `codeact`       | Code-as-action: `run_code` runs JS/Python in a subprocess boundary with a scrubbed env and timeout (`code:exec`). |
| `subagents`     | `spawn_agent` runs isolated child agents in single / parallel / chain modes (`agent:spawn`). |
| `memory`        | Context compaction via `transformContext` (cached branch summaries) plus a `remember`/`recall` scratchpad. |
| `planmode`      | Human-in-the-loop approval gate before mutating tools run, via `beforeToolCall`. |
| `session`       | Save / load / handoff of transcripts as file-based memory (`fs:read`, `fs:write`). |
| `packages`      | Install extensions from `path:` / `git:` / `npm:` sources — the Emacs `package.el` analog (`pkg:install`, installs with `--ignore-scripts`). |
| `trace`         | Observability: a per-run span tree, metrics, and token usage, all derived from the event bus. |
| `context-files` | Discovers `AGENTS.md` / `CLAUDE.md` up the tree and injects them as per-project instructions. |
| `limits`        | Resource guardrails: tool-output truncation and per-run tool-call budgets, via hooks. |
| `self`          | The agent authors and hot-loads its own TypeScript extensions at runtime (`self:read`, `self:extend`). |
| `web`           | Capability-gated, size-bounded HTTP access via `fetch_url` (`net:fetch`). |
| `checkpoint`    | Git-backed workspace snapshots before mutating tools, with rollback. |

See `docs/EXTENSIONS.md` for the extension author's guide.
