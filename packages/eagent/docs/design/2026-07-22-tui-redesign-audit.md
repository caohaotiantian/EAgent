# TUI Rendering — Current-State Audit & UX Diagnosis

Slug: `2026-07-22-tui-redesign-audit`
Status: audit (input to the `2026-07-22-tui-progressive-disclosure` design)
Date: 2026-07-22
Method: read-only sweep of the rendering/event surface. Central files
(`cli.ts`, `reasoning-search.ts`, `hooks.ts`, `agent.ts`, `events.ts`,
`extension.ts`, `index.ts`) read first-hand in full; the periphery (subagents,
truncation sites, flags/config, and the pinning tests) corroborated by a 7-way
parallel read-only audit. Every claim below carries a verbatim `file:line`
anchor. **No source file was modified.**

> **The code is the source of truth.** This audit only records what the code
> does today; it proposes nothing. Redesign proposals live in the companion
> design doc.

---

## Step 1 — File inventory (every file that implements each concern)

The kernel is presentation-agnostic: it emits lifecycle events on a hook bus and
holds **zero** opinions about rendering. All human-facing rendering lives in the
**host** (`src/cli.ts`). The table maps each audited concern to the files that
implement it.

| Concern | File(s) | Role |
| --- | --- | --- |
| **Terminal rendering / layout / panels** | `src/cli.ts` (`wireRendering`, 290-347; `banner`, 470-479; the `C` color map, 88-95) | The **entire** human TUI. Append-only `stdout.write`/`console.log` + ANSI color escapes. No layout engine, no panels. |
| **Message / event streaming & ordering** | `src/kernel/agent.ts` (emit sites), `src/kernel/hooks.ts` (`HookBus`), `src/kernel/events.ts` (`KernelEvents`) | The kernel emits `text_delta`/`reasoning_delta`/`message`/`tool_start`/`tool_end`/`tool_batch_end`/`turn_*`/`usage` in run order; the renderer paints them in arrival order. |
| **Reasoning / "reasoning-search" / CoT display** | `src/cli.ts` (`reasoning_delta` handler, 295-301); `src/extensions/reasoning-search.ts` (fork spine, `best_of_n`/`tree_search`/`graph_search`) | Reasoning tokens stream dimmed inline; reasoning-search forks N child agents whose streams reach the same renderer. |
| **Tool-call rendering (bash / subagent / shell / fn / MCP)** | `src/cli.ts` (`tool_start` 320-323, `tool_end` 324-328) | One `→ name args` line + one `✓/✗ head` line per call. Same code path for every tool including `spawn_agent`. |
| **Parameter / result truncation & elision (display)** | `src/cli.ts:322` (args → 80 chars), `src/cli.ts:327` (result → first line, 100 chars) | The **only two display-truncation sites** in the codebase. |
| **Collapse / expand / auto-hide** | *(none)* | No such code exists anywhere. Proven by absence (see Step 2 §G). |
| **Scroll / viewport / alternate-screen** | *(none)* | No cursor-movement, clear-screen, alt-screen, or viewport code. The terminal's own scrollback is the only "history." |
| **Input / prompt** | `src/cli.ts` (`repl` 373-391, `rl.question("› ")`; `batch` 240-255) | Line-based `readline`; a transient `› ` prompt printed per turn. No persistent status/input bar. |
| **Keyboard / signals** | `src/cli.ts` (readline `SIGINT` 190-198; process `SIGINT`/`SIGTERM` 205-213) | Only Ctrl-C (abort turn / exit) and shutdown. No raw mode, no keypress handling. |
| **Flags / config / commands (verbosity)** | `src/cli.ts` (`parseArgs` 40-67, `USAGE` 69-86, `registerHostCommands` 393-457); `src/config.ts`; `src/extensions/config-cmd.ts` | `--json` is the only render switch. **No** verbosity/detail/collapse flag, env var, config key, or slash command exists. |
| **Programmatic / machine render (contrast)** | `src/cli.ts` (`wireJsonRendering` 350-359); `src/jsonl.ts` (`wireJsonl`, `eventToJsonl`) | `--json` mode. Emits full, **untruncated** events as JSONL. This is the only way to see full tool params today. |
| **Attribution seam (the enabler)** | `src/kernel/agent.ts` (`currentActingAgent` 76, `currentRootAgent` 80); `src/kernel/extension.ts:249-250`; `src/kernel/index.ts:15` | AsyncLocalStorage seams that identify the emitting agent inside a handler. Exported; not yet used by the renderer. |

Extensions that fork child agents onto the shared bus (relevant to the flood):
`reasoning-search.ts:177`, `subagents.ts:95`, `subagent-jobs.ts:176`,
`dynamic-workflow.ts:500`, `sweep-edit.ts:249`, `templates.ts:404` — all use
`e.agent.hooks.childScope()`.

Content/context caps that are **not** display truncation (out of scope, must not
be touched): `limits.ts` (`DEFAULT_MAX_TOOL_OUTPUT_BYTES = 16384`, caps tool
result *content* into the transcript), `prune.ts` (`TOOL_OUTPUT_MAX_CHARS =
2000`, transcript pruning), `compact.ts`, `context-files.ts`, `microagents.ts`,
`mcp.ts`, `web.ts`, `handoff.ts`, `playbook.ts`, `teams.ts`. These bound tokens
/ memory / OOM, not the screen.

---

## Step 2 — Exact current behavior (grounded)

### A. How messages/events are ordered and inserted into the view

Within **one** agent's turn the emission order is strictly deterministic and
serialized — every `emit` is `await`ed (`agent.ts`):

1. `agent_start` then a `message` for the user input (`agent.ts:239-243`).
2. Per turn: `turn_start` (`:253`) → stream loop emits `text_delta` (`:417`) /
   `reasoning_delta` (`:419`) *as the provider yields them* → `usage` (`:444`) →
   push assistant msg → `message` (`:261`) → `beforeDispatch` filter → `dispatch`
   → per tool `tool_start` (`:480`) … `tool_end` (`:488`) → `tool_batch_end`
   (`:294`) → tool-result `message` (`:324`) → `turn_end` (`:326`).
3. `agent_end` once, in `finally` (`:351`).

`HookBus.emit` runs handlers sequentially in registration order and provides **no
mutual exclusion across concurrent `emit` calls** (`hooks.ts:88-100`). So while a
single bus preserves per-event order, two *overlapping* `emit` calls (from two
concurrent agents, or two concurrent tools) interleave at every `await`/microtask
boundary. Tool dispatch is concurrent by default: `maxConcurrency` is `Infinity`
(`agent.ts:136`), so a wave runs via `Promise.all(calls.map(runOne))`
(`agent.ts:459-460`) and multiple tools' `tool_end` (and anything emitted inside
their `execute`) interleave by completion time (`agent.ts:479-490`).

The human renderer inserts nothing structurally — it appends. `wireRendering`
handlers only `stdout.write(...)`/`console.log(...)`; there is no model of
"sections," no re-ordering, no correlation id.

### B. What happens when reasoning-search (or equivalent) is enabled

`reasoning-search.ts` builds each fork as `new Agent({ …, hooks:
e.agent.hooks.childScope() })` (`:172-181`) and runs up to `DEFAULT_MAX_N = 5`
(`:58`) of them **concurrently**: `const runs = children.map((c) => c.run(task));
… await Promise.allSettled(runs)` (`:274-276`). `tree_search` (`:385-390`) and
`graph_search` (`:481-488`) use the same concurrent `Promise.allSettled` spine.

`childScope()` (`hooks.ts:167-177`) seeds the child bus with the parent's
per-event handler `Set`s **by reference** for every event *except* the five in
`SUPPRESSED_LIFECYCLE_EVENTS` = `{agent_start, agent_end, session_start,
session_shutdown, reload}` (`hooks.ts:36-42`). Therefore each fork's
`reasoning_delta`/`text_delta`/`message`/`tool_start`/`tool_end` fire **the very
same handlers** `wireRendering` registered on the parent bus. Pinned by
`test/hooks.test.ts:120-179` and demonstrated end-to-end by
`test/reasoning-search.test.ts:218-245` ("2 parent + 3 child usage events arrive
on the parent bus").

Net effect: the moment reasoning-search runs, 3-5 independent token streams are
multiplexed onto one append-only sink with **one** shared `streaming`/`thinking`
flag pair (`cli.ts:291-292`).

### C. Exactly how tool parameters are truncated / hidden

Two literal-constant truncations, both in `wireRendering`, both cosmetic:

- **Arguments** (`cli.ts:320-323`):
  ```ts
  const args = JSON.stringify(call.arguments);
  console.log(C.cyan(`→ ${call.name}`) + " " + C.dim(args.length > 80 ? args.slice(0, 79) + "…" : args));
  ```
  The full arguments object is JSON-stringified then cut to **79 chars + `…`**
  when longer than 80. A long `bash` command, an `edit` with file bodies, or a
  nested MCP payload is unrecoverable from the terminal.

- **Result** (`cli.ts:324-328`):
  ```ts
  const head = result.content.split("\n")[0] ?? "";
  console.log(`  ${mark} ${C.dim(head.length > 100 ? head.slice(0, 99) + "…" : head)}`);
  ```
  Two compounding truncations: keep **only the first line**, then cut that line
  to **99 chars + `…`**. Stack traces, multi-line command output, and subagent
  transcripts are invisible.

The event layer carries the **full** data — `tool_start: { call }` with the whole
`call.arguments`, `tool_end: { call, result }` with the whole `result.content`
(`events.ts:41-43`; `types.ts:21-26`). Truncation is purely a renderer choice.
The `--json` path proves it: `eventToJsonl` emits full arguments and full content
(`jsonl.ts:56-65`), pinned byte-for-byte by `test/jsonl.test.ts:39-54`.

Subagents render through the **same** flat handler. For a `spawn_agent` call the
parent sees one `tool_start` (`→ spawn_agent <args≤79ch>`) and one `tool_end`
(`✓ <first line of the child's final answer>`), while the child's own inner
`tool_start`/`tool_end` print as **identical, unindented** `→ …`/`✓ …` lines
interleaved between them (`subagents.ts:84-96` uses `childScope`; the only
per-child labelling anywhere is the `[child i]` prefix on the *aggregated result
string*, `subagents.ts:257-264` — not on any event).

### D. Existing flags / config / keybindings for verbosity / detail / expand

**None exist.** The complete flag surface is `parseArgs` (`cli.ts:40-67`):
`--model/-m`, `--provider/-p`, `--think` (reasoning *effort*, not display),
`--eval/-e`, `--yolo`, `--ext`, `--help/-h`, `--version/-v`, `--json`. `--json`
is the only render switch and it toggles machine-vs-human output, not detail.

- No display env var: env names derive as `EAGENT_<KEY>` (`config.ts:52-57`) and
  no consumed key maps to verbosity/detail/render/width. `/config set
  render.truncate 500` would persist an override nothing reads (`config-cmd.ts`,
  key-agnostic).
- No relevant slash command: host commands are `/help /reload /extensions /caps
  /model /provider /clear` (`cli.ts:393-457`); none touch display.
- No keybinding surface: input is line-based `readline` (`cli.ts:373-380`); the
  only key handling is the `SIGINT` handler (`cli.ts:190-198`). No `setRawMode`,
  no `keypress` listener — there is nothing to hang an expand/collapse key on
  today.
- No width/layout: `isTTY` is read only to pick interactive-vs-batch
  (`cli.ts:113`) and for headless detection (`headless-flags.ts:366-369`);
  **`stdout.columns` is never read**.

### E. Reasoning render state machine (`cli.ts:295-319`)

Two booleans, `streaming` and `thinking`. First `reasoning_delta` writes a dimmed
`🧠 ` once and sets `thinking`; each delta appends dimmed text with no
inter-delta separator. First `text_delta` writes `\n` to close thinking, writes a
green `⏺ ` once, sets `streaming`, appends raw text. The **only** block terminator
is the assistant `message` event, which writes `\n` and resets both flags — and
it is global, not keyed to any stream.

### F. The programmatic path (must not change)

`wireJsonRendering` (`cli.ts:350-359`) delegates the six streaming events to
`wireJsonl` and adds `agent_end`/`error`. `wireJsonl` (`jsonl.ts:86-95`)
subscribes `text_delta, reasoning_delta, message, tool_start, tool_end, usage`
and passes each raw payload through `eventToJsonl`. No truncation. This path is
golden-pinned (see Step 4).

### G. Proof of absence (collapse/expand/viewport/alt-screen)

The only ANSI the renderer ever emits are SGR color codes (`C`, `cli.ts:88-95`:
`\x1b[2m`/`[1m`/`[3xm`). There are **no** cursor-movement (`cursorTo`,
`moveCursor`), clear-line/clear-screen (`\x1b[2J`, `clearLine`), or alternate-
screen (`smcup`/`rmcup`, `\x1b[?1049h`) sequences anywhere in `cli.ts` or
`jsonl.ts`. Every handler does only `stdout.write`/`console.log`. A window full
of interleaved reasoning simply scrolls past, append-only, with no way to reflow
or collapse it.

---

## Step 3 — Current UX diagnosis

### Problem (a): reasoning-search fills the window with responses in random / non-chronological order

The symptom is a **structural consequence** of three facts composing, not a bug
in any single line:

1. **Fan-out is concurrent.** `reasoning-search` runs up to 5 forks at once via
   `Promise.allSettled` (`reasoning-search.ts:274-276`), each streaming its own
   reasoning + answer.
2. **Fork streams reach the parent renderer, untagged.** `childScope()` shares
   the parent's intra-run event handler `Set`s by reference (`hooks.ts:167-177`),
   suppressing only 5 lifecycle events (`hooks.ts:36-42`) — so every fork's
   `reasoning_delta`/`text_delta` invokes the same `wireRendering` handlers
   (`cli.ts:295-312`). The bus provides no cross-emit ordering (`hooks.ts:88-100`),
   and no event payload carries an agent id/depth/source (`events.ts:37-43`).
3. **The renderer cannot demultiplex.** Its entire state is two closure booleans
   (`cli.ts:291-292`). Two booleans cannot separate five streams, so the deltas
   are appended in raw async-arrival order — which *is* chronological per stream,
   but reads as "random" because five chronologically-independent streams are
   spliced together with no framing and one shared `🧠`/`⏺` prefix.

> Quoted crux — `cli.ts:291-301`:
> ```ts
> let streaming = false;
> let thinking = false;
> agent.hooks.on("reasoning_delta", ({ text }) => {
>   if (!thinking) { stdout.write(C.dim("🧠 ")); thinking = true; }
>   stdout.write(C.dim(text));   // <- every fork's tokens land here, unattributed
> });
> ```

Because there is also no viewport/alt-screen (§G), the flood pushes the prompt
and any final answer off-screen into scrollback with no anchoring.

### Problem (b): tool calls never show full parameters; truncation is too aggressive for debugging

Both truncations are unconditional literal constants in the renderer, with no
override:

> `cli.ts:322` — arguments cut to 79 chars:
> ```ts
> console.log(C.cyan(`→ ${call.name}`) + " " + C.dim(args.length > 80 ? args.slice(0, 79) + "…" : args));
> ```
> `cli.ts:327` — result cut to first-line-then-99-chars:
> ```ts
> console.log(`  ${mark} ${C.dim(head.length > 100 ? head.slice(0, 99) + "…" : head)}`);
> ```

The full data is present at the event layer and in `--json` (`jsonl.ts:56-65`),
so nothing is lost upstream — it is simply **unreachable from the human TUI**.
There is no expand key, no `/details`, no display mode, and (§C) subagent inner
calls collapse into the same flat, truncated two-line format with no nesting.

---

## Step 4 — Invariants a redesign must preserve (from the pinning tests)

The renderer's streaming/tool output is **almost entirely unpinned** — no test
asserts the `→`/`⏺`/`🧠` glyphs, the 79/99-char truncation, first-line-only
results, or any streaming *order* (`test/cli.test.ts` uses an in-process
stdout capture, 109-123, but only `/match`es warning text). This gives a redesign
wide latitude. The hard constraints are:

1. **`agent_end` warning lines** (`test/cli.test.ts:125-175`): `wireRendering`
   must still print a line matching `/⚠ response/` + the reason for
   `max_tokens`/`content_filter`/`refusal` (and `/truncat/i` + `/MAX_TOKENS/` for
   `max_tokens`), and stay **silent** on `end_turn`/`stop`/`error`.
2. **JSONL byte-shapes** (`test/jsonl.test.ts:39-164`): the six `eventToJsonl`
   shapes and `wireJsonl`'s 6-subscription order/dispose are golden. The `--json`
   path must not change.
3. **Shared-mapper guard** (`test/jsonl-adoption.test.ts:25-38`): `cli.ts` and
   `server.ts` must import `./jsonl.js` and call `wireJsonl(`, and must **not**
   inline any `type: "<common-event>"` object literal for the six common events.
   → *A new human render path must route machine events through `jsonl.ts`, never
   hand-roll them.*
4. **childScope propagation** (`test/hooks.test.ts:120-179`,
   `test/governed-subagents.test.ts:306-347`): child intra-run events must keep
   reaching the parent bus; child lifecycle stays suppressed; usage counted once.
   → *The flood fix must demultiplex in the renderer, not sever propagation.*
5. **Attribution is recoverable** (`test/extension.test.ts:188-233`,
   `test/acting-agent-seam.test.ts`): inside a propagated child event, `e.agent`
   = the acting (child) agent, `e.rootAgent` = the root. This is
   `currentActingAgent()`/`currentRootAgent()`, backed at
   `extension.ts:249-250`:
   ```ts
   get agent() { return currentActingAgent() ?? host.agent; },
   get rootAgent() { return currentRootAgent() ?? host.agent; },
   ```

## Step 5 — The design enabler (out-of-band attribution, zero kernel change)

The renderer has no per-event agent id (`events.ts:37-43`), but it does **not
need one**. `currentActingAgent()`/`currentRootAgent()` (`agent.ts:76,80`,
exported at `index.ts:15`) are AsyncLocalStorage seams bound in `run()`
(`agent.ts:227-229`); ALS context propagates across `await`, so inside a
`reasoning_delta`/`text_delta`/`tool_start` handler `currentActingAgent()`
returns the exact agent that emitted it, and `currentActingAgent() !==
currentRootAgent()` cleanly flags "this is a fork/subagent stream." `cli.ts`
already imports from `./kernel/agent.js`. Therefore the entire de-interleaving +
attribution fix — and everything in problem (b) — can live in the **host layer
with no kernel change**, honoring both the "new behavior is an extension, never a
core fork" charter and the 5-line kernel ceiling headroom (2260/2265).

---

## Open items carried into design (not decided here)

- How much TUI machinery to build: an alternate-screen + differential renderer
  (true in-place collapse/expand/scroll/side-panel) vs. a lighter inline
  progressive-disclosure model. Genuine trade-off (scope/risk vs. fidelity to the
  "modern agent TUI" ask) — escalate to the user before drafting Key Design
  Decisions.
- Where the new renderer code lives: grow `wireRendering` in `cli.ts` vs. extract
  a pure, offline-testable module (mirroring `src/complete.ts`).
- Whether non-interactive paths (`--json`, `--eval`, piped batch) are entirely
  exempt (they must keep today's line-streaming for pipes/machines).
