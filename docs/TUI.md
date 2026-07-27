# Interactive display (plain CLI)

EAgent’s shipped human display is the **engine plain renderer** over one shared,
pure view model (`src/view-model.ts`). It fixes two long-standing pain points —
a `reasoning-search` fork flood and tool parameter/result truncation — without a
full-screen terminal framework.

1. **The default CLI renderer** (`src/engine-render.ts`) — a minimal, zero-dep,
   append-only plain renderer built into the engine. It is what the plain `eagent`
   REPL, `--eval`, batch, pipes, dumb terminals, and the standalone `bin/eagent`
   binary use. No framework, no alt screen.
2. **Web front end** — rich multi-session display (streaming transcript + monitor)
   lives in the browser SPA under `web/`, served by `eagent-serve`. See
   [`WEB.md`](WEB.md).

Host code only — no kernel change. The `--json` and HTTP `/run` streams are
unaffected; they emit the machine JSONL schema documented in
[`JSONL.md`](JSONL.md).

## The default CLI renderer

Each reasoning block, answer, and tool call is an **ordered, collapsible section**
— progressive disclosure. Concurrent `reasoning-search` forks are attributed per
acting agent and rendered as separate, de-interleaved sections in strict arrival
order (never one interleaved, non-chronological region). A finished reasoning or
answer block collapses to a one-line header (`◆ Reasoning · N tok · Xs`); a tool
call renders as a card (`→ <name> <args-summary> ✓ Xs`, the mark being `✓` success
/ `✗` error / `…` running); a subagent call nests the child's own work inside its
card.

The renderer is **append-only** — every line is written exactly once, native
scrollback is preserved, and none of the machine/non-interactive paths ever leak
cursor-control or alt-screen bytes. A section is committed to the transcript when
it finishes.

### Display modes

The **display mode** decides which sections render expanded:

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Only the **newest** top-level section stays expanded; older ones collapse to their headers as new sections begin. |
| `full` | Every section expanded — all arguments and every result line shown. |
| `collapsed` | Headers only; no bodies. |

Expanding a section (via `full` mode or `/expand <n>`) reveals the **complete,
untruncated** content — the entire arguments object and every line of the
result/stdout/stderr. The only elision anywhere is a bounded argument summary on a
*collapsed* card header; `full` mode elides nothing. Because the transcript is
append-only, `/expand`/`/collapse`/`/details` reprint the affected section(s) below
what came before rather than rewriting scrolled-past lines.

### Commands

These are host slash commands (commands, not raw-mode keys), available in the
default CLI:

| Command | What it does |
| --- | --- |
| `/details [full\|collapsed\|auto]` | Set the display mode. With no argument, prints the current mode. |
| `/expand <n>` | Expand top-level section *n* (1-based) to its full content. |
| `/collapse <n>` | Collapse top-level section *n* back to its header. |

An out-of-range section number is a no-op, never an error.

## Shared substrate (for CLI and future web)

| Module | Role |
| --- | --- |
| `src/view-model.ts` | Pure reducer: lifecycle events → ordered section tree. |
| `src/attribution.ts` | Tags events with acting/root agent for fork de-interleave. |
| `src/tty.ts` | Injected `Term` + `isFancy` + `RenderController`. |
| `src/engine-render.ts` | Append-only plain renderer used by the CLI. |
| `src/session-source.ts` | `InProcessSource` / `RemoteSource` over monitor HTTP/SSE. |
| `src/server.ts` monitor routes | `GET /sessions`, `GET /sessions/:id/events`, `GET /events`, `POST /sessions/:id/stop` (+ session summary `GET /sessions/:id`). |

The engine runtime dependency set is **only `jiti`** (enforced by
`test/zero-dep.test.ts`). A web UI package, when added, stays outside that engine
charter.
