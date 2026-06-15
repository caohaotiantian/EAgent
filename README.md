# EAgent

**A minimalist AI agent with a tiny stable core and Emacs-grade extensibility.**

Emacs has survived forty years because of one decision: a small C core hosting a
language in which *almost everything is redefinable at runtime*. Primitives live
in the core; policy lives in the extension language. EAgent applies that decision
to AI agents.

The kernel is **seven primitives and nothing more**. There are no built-in tools,
no hard-coded prompt strategy, no memory policy, no sub-agents baked in. The four
"built-in" tools (`read`, `write`, `edit`, `bash`) are themselves an extension.
Everything you'd want to change is a hot-reloadable extension you can edit while
the agent is running.

```
┌──────────────────────── kernel (stable, ~small) ─────────────────────────┐
│  hook bus · tool registry · provider abstraction · agent loop            │
│  capability layer · extension host · command registry                    │
└───────────────────────────────────────────────────────────────────────────┘
        ▲ registers tools / hooks / commands / providers
┌───────┴───────────────────────── extensions ─────────────────────────────┐
│  core-tools (read/write/edit/bash) · skills (LLM-authored) · your code …  │
└───────────────────────────────────────────────────────────────────────────┘
```

## Why another agent

Most agents are a feature pile with an opaque, shifting core. EAgent inverts that:
a core small enough to read in one sitting, and a single extension surface powerful
enough that new behavior never requires forking. The bet — the same one pi and
Emacs make — is that a minimal, observable, malleable core beats a big one.

## Quickstart

```bash
npm install
npm run build
npm test          # 36 tests, no network or API key required

# talk to it offline (a deterministic mock LLM drives everything):
node dist/cli.js -e "hello"

# load an example extension and poke around:
printf '/tools\n/uptime\n/quit\n' | node dist/cli.js --ext examples/extensions/clock.ts
```

For a live model, set `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_BASE_URL`)
and the CLI uses the real Anthropic provider automatically:

```bash
ANTHROPIC_API_KEY=sk-... node dist/cli.js -m claude-fable-5
```

Interactive session commands: `/help`, `/tools`, `/skills`, `/extensions`,
`/reload`, `/caps`, `/model`, `/provider`, `/clear`, `/quit`.

## The seven primitives

| Primitive            | File                       | Responsibility |
| -------------------- | -------------------------- | -------------- |
| **Hook bus**         | `src/kernel/hooks.ts`      | Lifecycle events (observe) + filter hooks (intervene) — Emacs hooks & advice. |
| **Tool registry**    | `src/kernel/registry.ts`   | Register/shadow/dispose tools; a later definition wins, disposing restores the prior one. |
| **Provider**         | `src/kernel/types.ts`      | The one thing the kernel knows about an LLM: a request → a stream of events. |
| **Agent loop**       | `src/kernel/agent.ts`      | Turns, streaming, guarded & ordered tool dispatch, steering, follow-up, stop conditions. |
| **Capability layer** | `src/kernel/capabilities.ts` | Per-capability allow / deny / ask, wildcards, an audit log. |
| **Extension host**   | `src/kernel/extension.ts`  | Discovery, activation, the `ExtensionAPI`, and hot reload via `jiti`. |
| **Command registry** | `src/kernel/commands.ts`   | User-facing slash commands (`M-x` for agents). |

Everything else — tools, memory, prompts, compaction, UI, sub-agents, MCP — is
meant to be an extension. The kernel ships with zero opinions about them.

## The three modes of extensibility

EAgent deliberately supports three different ways to extend it, mapped onto three
different mechanisms rather than blurred into one.

**(a) Live programmability** — trusted TypeScript extensions, hot-reloaded with no
build step. Edit a file, run `/reload`, and the new behavior takes effect in the
running process. Every registration is tracked, so a reload tears the old version
down cleanly and brings the new one up.

```ts
// .eagent/extensions/hello.ts  — auto-discovered, then `/reload`
import { defineTool, ok } from "eagent";
export default function activate(e) {
  e.registerTool(defineTool({
    name: "greet",
    description: "Greet someone by name.",
    parameters: { type: "object", properties: { who: { type: "string" } }, required: ["who"] },
    execute: (args) => ok(`Hello, ${args.who}!`),
  }));
}
```

**(b) A stable plugin API** — the `ExtensionAPI` is a single, versioned surface
(`registerTool`, `registerProvider`, `registerCommand`, `on`, `hook`,
`grantCapability`, `store`). It follows VS Code's discipline: minimal, additive,
never broken. This is also where an MCP client belongs — as an extension over a
process boundary, not in the core.

**(c) LLM-authored skills** — the agent writes its own capabilities. The built-in
`skills` extension implements Anthropic's `SKILL.md` standard with progressive
disclosure: only skill names + descriptions are injected each turn (cheap), full
instructions load on demand, and authoring (`skill_create`) is gated behind the
`skill:write` capability. This is self-extension with a seatbelt.

## Hooks: observe and intervene

Lifecycle **events** are notifications you subscribe to:

```ts
e.on("tool_end", ({ call, result }) => log(call.name, result.isError));
```

**Filter hooks** are advice — a value threaded through your handler that you can
transform or veto:

```ts
// Approve, rewrite, or block any tool call before it runs.
e.hook("beforeToolCall", (decision, { call }) => {
  if (call.name === "bash" && /rm -rf \//.test(String(call.arguments.command)))
    return { ...decision, block: true, reason: "destructive command" };
  return decision;
});

// Reshape the prompt just before it reaches the model (compaction, memory, RAG).
e.hook("transformContext", (messages) => [systemNote, ...messages]);
```

`transformContext`, `beforeToolCall`, and `afterToolCall` are the three seams
where memory strategies, plan-mode approvals, safety gates, and context
engineering plug in — without touching the loop.

## Built-in extensions

Everything below is an extension — none of it is in the kernel, and any of it can
be replaced or removed. Each is a single file under `src/extensions/`, ships with
offline tests, and gates privileged work behind a capability.

| Extension     | What it adds | Commands | Capability |
| ------------- | ------------ | -------- | ---------- |
| `core-tools`  | `read`, `write`, `edit`, `bash` | `/tools` | `fs:read`, `fs:write`, `shell:exec` |
| `skills`      | LLM-authored skills via `SKILL.md` with progressive disclosure | `/skills` | `skill:read`, `skill:write` |
| `mcp`         | Model Context Protocol client (stdio, newline-delimited JSON-RPC 2.0); registers each server's tools as `mcp__<server>__<tool>` | `/mcp` | `mcp:call` |
| `codeact`     | code-as-action: `run_code` runs JS/Python in a subprocess boundary (scrubbed env, timeout) | `/code` | `code:exec` |
| `subagents`   | `spawn_agent` runs isolated child agents in single / parallel / chain modes | `/agents` | `agent:spawn` |
| `memory`      | context compaction via `transformContext` (cached branch summaries) + `remember`/`recall` scratchpad | `/compact`, `/memory` | — |
| `planmode`    | human-in-the-loop approval gate before mutating tools run | `/plan` | — |
| `session`     | save / load / handoff for transcripts (file-based memory) | `/save`, `/load`, `/sessions`, `/handoff` | `fs:read`, `fs:write` |
| `packages`    | install extensions from `path:` / `git:` / `npm:` sources (Emacs `package.el` analog) | `/pkg-add`, `/pkg-list`, `/pkg-remove` | `pkg:install` |
| `trace`       | observability: per-run span tree, metrics, and token usage, all from the event bus | `/trace`, `/usage`, `/trace-save` | — |
| `context-files` | discovers `AGENTS.md` / `CLAUDE.md` up the tree and injects them (per-project instructions) | `/context`, `/context-reload` | — |

The MCP client configures servers from `EAGENT_MCP_SERVERS` (a JSON array of
`{ name, command, args?, env? }`). Skills live under `~/.eagent/skills/` (override
with `EAGENT_SKILLS_DIR`).

## Capabilities: the one thing pi omits

pi runs extensions in-process with full privileges and tells you to containerize.
That's reasonable for a trusted coding agent — but EAgent makes *LLM-authored
code* a first-class mode, so it carries an explicit capability layer from day one.

A capability is a dotted authority: `fs:read`, `fs:write`, `shell:exec`,
`net:fetch`, `skill:write`. Tools declare what they need; the dispatcher enforces
it before the tool body runs. Decisions come from an ordered policy
(grant → deny → ask), wildcards are supported (`fs:*`, `*`), and every check is
recorded in an audit log you can inspect with `/caps`.

```ts
e.registerTool(defineTool({
  name: "fetch",
  description: "HTTP GET a URL.",
  capabilities: ["net:fetch"],     // enforced automatically before execute()
  execute: async (args, ctx) => { /* ... */ },
}));
```

**Security stance.** The in-process extension path is for *trusted* code only.
There is no reliable in-process JavaScript sandbox (`node:vm` is explicitly not a
security boundary; `vm2` is abandoned). Untrusted or LLM-generated *code* that
touches the network, the filesystem outside a scratch dir, or credentials belongs
behind a real OS/VM boundary (container, microVM). The capability layer is the
seam where that boundary plugs in; EAgent enforces authority but does not pretend
to sandbox arbitrary code in-process.

## Embedding the kernel

The kernel is usable headless, without the CLI:

```ts
import { Agent } from "eagent";
import { MockProvider } from "eagent/providers/mock";

const agent = new Agent({ capabilities: /* ... */ });
agent.providers.register(new MockProvider([
  { toolCalls: [{ name: "add", arguments: { a: 2, b: 3 } }] },
  { text: "The sum is 5." },
]), { default: true });
// register tools, then:
const { reason, messages } = await agent.run("add 2 and 3");
```

The `MockProvider` is a scriptable, deterministic LLM. It is why the entire test
suite runs offline and why you can explore the agent with no API key.

## Design choices worth knowing

- **In-process, trusted extensions** (pi's trade-off): power and live reloading
  over isolation. Untrusted code is a separate, sandboxed path, not this one.
- **Ordered tool results.** Tools may run in parallel, but results are always
  appended in the order the model requested them. One `sequential` tool forces
  the whole batch to run in order.
- **Steering vs. follow-up.** Steering injects a message before the next model
  call (interruptions, corrections); follow-up queues work for when the loop
  would otherwise idle (automation).
- **Scoped state.** Each extension gets a namespaced persistent `store` — the
  explicit fix for Emacs's global-mutable-state mistake.
- **Stable API discipline.** One typed `ExtensionAPI`; additive, never broken.
- **Token accounting.** Providers report `Usage` on every completion; the agent
  sums it and emits a `usage` event (see `/usage`).
- **Resilient networking.** The Anthropic provider retries 429/5xx and network
  errors with exponential backoff (honoring `retry-after`), and its `fetch` is
  injectable for testing.
- **Filesystem confinement.** `read`/`write`/`edit` are scoped to a workspace
  root (`$EAGENT_WORKSPACE` or cwd), rejecting `../` escapes — defense in depth
  over the `fs:*` capabilities.

See `docs/EXTENSIONS.md` for the full extension author's guide.

## Layout

```
src/kernel/      the seven primitives + public barrel (index.ts)
src/providers/   mock (deterministic) and anthropic (fetch + SSE, no SDK)
src/extensions/  core-tools, skills, mcp, codeact, subagents, memory,
                 planmode, session, packages — all riding the ExtensionAPI
src/cli.ts       the terminal host: interactive REPL + batch + one-shot
examples/        a worked example extension (clock & guardrails)
test/            the full suite, every primitive and extension, offline
```

## License

MIT. Heavily inspired by [pi](https://github.com/earendil-works/pi), Emacs, and
the broader lineage of malleable, live-programmable systems.
