# Interactive display and the `eagent-tui` client

EAgent has two terminal display surfaces over **one shared, pure view model**
(`src/view-model.ts`), so both render the same ordered, collapsible section tree
and both fix the same two pain points — a `reasoning-search` fork flood and tool
parameter/result truncation:

1. **The default CLI renderer** (`src/engine-render.ts`) — a minimal, zero-dep,
   append-only plain renderer built into the engine. It is what the plain `eagent`
   REPL, `--eval`, batch, pipes, dumb terminals, and the standalone `bin/eagent`
   binary use. No framework, no alt screen.
2. **`eagent-tui`** — a rich full-screen **Ink (React)** client, a separate ESM
   front end run via Node. It renders the section tree live and adds a multi-session
   **monitor** dashboard. `ink`/`react` live only under `src/tui/` and are **not**
   in the engine binary.

Both are **host code** — no kernel change. The `--json` and HTTP `/run` streams
are unaffected; they emit the machine JSONL schema documented in
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
cursor-control or alt-screen bytes. There is no in-place spinner or active-region
redraw (that live experience is the `eagent-tui` client); a section is committed to
the transcript when it finishes.

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

An out-of-range section number is a no-op, never an error. The same `/details`,
`/expand`, and `/collapse` controls work in the `eagent-tui` client (typed into its
input bar).

On a raw-mode-capable, non-`dumb` interactive TTY, startup prints a one-line hint
suggesting `eagent-tui`. The hint is **startup-only** and never appears in `--json`,
`--eval`, or a non-TTY run.

## `eagent-tui` — the rich Ink client

`eagent-tui` is a full-screen Ink client that renders the same section tree **live**
— streaming text, collapsible reasoning, structured tool cards, nested sub-agents, a
persistent input + status bar, and a **side panel at ≥ 100 columns** (streaming
tool/subagent/fork status), with **delta coalescing** (≤ 1 React commit per frame
interval) + **viewport windowing** (only the visible rows + collapsed headers are
laid out, bounded by the terminal `rows`) so the reasoning-search flood stays smooth.

```bash
eagent-tui                          # rich single-session client (a local agent)
eagent-tui -p anthropic -m <model>  # pick a provider/model (default: mock, offline)
eagent-tui --monitor                # multi-session dashboard (see below)
```

Its single-session mode drives the same `createAgentHost` assembly in-process (an
`InProcessSource`), so it loads the same extensions and runs identical agent
behavior — only the view is richer.

### Flags

| Flag | Meaning |
| --- | --- |
| `-p, --provider <name>` | `anthropic` \| `openai` \| `gemini` \| `mock`. |
| `-m, --model <name>` | Model id (e.g. `claude-fable-5`, `gpt-4o`). |
| `--details <mode>` | Initial display mode: `full` \| `collapsed` \| `auto` (default `auto`). |
| `--yolo` | Auto-grant capabilities (no approval prompts). |
| `--monitor` | Run the multi-session monitor dashboard instead of a local session. |
| `--instance <url[,token]>` | A monitor target host (repeatable; default a local `eagent-serve`). |
| `-h, --help` | Print help and exit (headless — no TTY needed). |
| `-v, --version` | Print the version and exit. |

### Single-session controls

The client owns one input bar; type into it and press **Enter**:

| Input | What it does |
| --- | --- |
| a line of text | Run it as a turn. |
| `/details [full\|collapsed\|auto]` | Set the display mode. |
| `/expand <n>` / `/collapse <n>` | Expand / collapse top-level section *n*. |
| `/quit` (or `/exit`) | Leave the client. |
| `Ctrl+C` | Leave the client. |

The Ink client needs an interactive TTY. Run under a pipe/redirect it prints a
message and exits non-zero — use `eagent --json` or `eagent -e` for scripts.

## The multi-session monitor

`eagent-tui --monitor` attaches to one or more running EAgent HTTP hosts and shows
their live sessions — a read-mostly dashboard with bounded controls (stop a running
turn; forget a session). It does **not** spawn agents; it observes remote ones over
HTTP/SSE.

```bash
# Attach to two hosts (a bearer token after the comma is optional per host):
eagent-tui --monitor \
  --instance http://127.0.0.1:8787 \
  --instance https://box.example:8787,<token>
```

Each `--instance url[,token]` adds one entry to the monitor's `{ url, token }[]`
configuration; the URL is split on the **first** comma only, so a token may itself
contain commas. With **no** `--instance`, the monitor defaults to a local
`eagent-serve` on `http://127.0.0.1:8787` (honoring `EAGENT_TOKEN` if set).

Per instance it polls `GET /sessions` for the authoritative `{id, running, usage,
costUsd}` snapshot and subscribes to the global `GET /events` SSE feed for
sub-poll-interval liveness, demuxing each frame by the `session` id the server tags
it with. Opening a session attaches a per-session `RemoteSource` to its
`GET /sessions/:id/events` feed.

### Monitor keys

Session list:

| Key | Action |
| --- | --- |
| `j` / `k` (or `↓` / `↑`) | Move the selection down / up. |
| `Enter` (or `l`) | Open the selected session's live detail view. |
| `s` | Stop the selected session's running turn (`POST /sessions/:id/stop`). |
| `f` | Forget the selected session (a durable client-side dismiss; never `DELETE`s on the server). |
| `r` | Re-poll every instance now. |
| `q` | Quit. |

Session detail view:

| Key | Action |
| --- | --- |
| `b` (or `Esc` / `h`) | Back to the session list. |
| `s` | Stop this session's running turn. |
| `q` | Quit. |

## Server monitor endpoints

The monitor rides four additive, read-mostly endpoints on `src/server.ts`
(zero-dep, Ink-free, reusing the existing bearer auth + session pool; no kernel
change):

| Endpoint | Purpose |
| --- | --- |
| `GET /sessions` | List live sessions: `[{ id, running, usage, costUsd }]`. |
| `GET /sessions/:id/events` | A per-session SSE feed, **tenant-isolated** by run-tree root agent (`currentRootAgent() === agent`, the same filter `/run` uses) so it carries only that session's events. |
| `GET /events` | A **global** SSE feed; each frame is tagged with its originating `session` id so a multi-session client can demux it. |
| `POST /sessions/:id/stop` | Abort the session's running turn (`agent.stop()`). |

Both SSE feeds respond `content-type: text/event-stream` and emit an
`event: connected` frame first. When `EAGENT_TOKEN` is configured, all of these are
`Authorization: Bearer <token>`-gated like the rest of the server; when it is not,
they are open (trusted local use).

## Architecture

```
src/view-model.ts    pure reducer: tagged events → ordered, collapsible section tree
src/attribution.ts   in-process attribution adapter (currentActingAgent/RootAgent)
src/tty.ts           the injected Term seam, isFancy/shouldSuggestTui, RenderController
src/engine-render.ts the engine's minimal zero-dep plain renderer (consumes the three above)
src/tui/
  source.ts          SessionSource: InProcessSource (local agent) + RemoteSource (HTTP+SSE)
  instance.ts        per-instance monitor client (polls /sessions, demuxes /events)
  app.tsx            the single-session Ink transcript (coalesce + windowing)
  monitor.tsx        the multi-session dashboard (list + detail + controls)
  main.tsx / args.ts the eagent-tui entry + pure argv parser
```

The reducer (`src/view-model.ts`) and the in-process attribution adapter
(`src/attribution.ts`) are **neutral shared cores** — zero-dep, no `ink`/`react` —
consumed by **both** the engine plain renderer and the Ink components, so
de-interleaving, ordering, collapse, coalescing, and full-payload retention are
written and tested once.

**Dependency isolation (enforced).** `test/tui-isolation.test.ts` is a
`readFileSync`-based source scan (not shell grep — macOS silently skips files with
non-ASCII glyphs) asserting `ink`/`react` are imported **only** under `src/tui/`,
never in the kernel, providers, extensions, `host.ts`, `server.ts`, `cli.ts`,
`jsonl.ts`, the neutral cores, or `test/` outside `test/tui/`. The SEA `bin/eagent`
binary never imports `src/tui/`, so esbuild tree-shakes Ink away and the engine
binary stays zero-dep.

## Build and run

```bash
npm run build        # tsc → dist/ (emits dist/tui/main.js for the eagent-tui bin)
npm run build:tui    # esbuild → dist/tui/bundle.mjs (a self-contained ESM bundle)
npm run test:tui     # the Ink component/frame tests (ink-testing-library, offline)
```

`build:tui` runs esbuild with `--format=esm --jsx=automatic`, an empty
`react-devtools-core` alias, and a `createRequire` banner (the two shims Ink's ESM
bundle needs). The bundle is size-gated at ≤ 3 MB. `build:binary` (the SEA engine)
is unchanged — it esbuilds from `dist/cli.js`'s import graph, which never reaches
`src/tui/`.

## Manual real-TTY smoke (out of CI)

Raw-mode / alternate-screen behavior is **not reproducible in the offline
`node:test` suite** — `node:test` has no portable pseudo-terminal, and `node-pty`
is a native addon the zero-dep-adjacent test story avoids. The component render and
input logic are covered offline by `ink-testing-library` (`test/tui/*.test.tsx`);
the real-TTY render/input path is an **explicit out-of-CI manual/release gate**.

Verify it by driving the built bundle inside a real pseudo-terminal with Python's
`pty` module (present in the standard library — no dependency):

```bash
npm run build:tui
python3 - <<'PY'
import os, pty, sys, time

def read(fd):
    # Echo the child's output so a human can watch the frame render.
    data = os.read(fd, 4096)
    os.write(sys.stdout.fileno(), data)
    return data

pid, fd = pty.fork()
if pid == 0:                       # child: run the TUI in the pty
    os.execvp("node", ["node", "dist/tui/bundle.mjs", "-p", "mock"])
else:                              # parent: drive it
    time.sleep(1.0)
    os.write(fd, b"hi\r")          # run a turn
    time.sleep(1.0)
    os.write(fd, b"/details full\r")
    time.sleep(0.5)
    os.write(fd, b"/quit\r")       # leave cleanly
    try:
        while read(fd):
            pass
    except OSError:
        pass                       # the child closed the pty on exit
PY
```

Check by eye that the frame renders (Yoga flexbox layout, colored sections), that
typed input reaches the turn, that `/details full` re-renders expanded, and that
`/quit` restores the terminal. For the monitor, start a host
(`npm run serve`), run a turn against it, then launch
`node dist/tui/bundle.mjs --monitor` in the pty and drive the `j`/`k`/`enter`/`s`/`q`
keys. Neither path is a CI gate.

## The `N tok` estimate

The `N tok` count in a `◆ Reasoning`/`◆ Answer` header is a **char-derived
estimate** (roughly `ceil(chars / 4)`), not a provider token count — no lifecycle
event splits usage between reasoning and answer, so an exact per-block count is not
available. Treat it as a relative size indicator, not a billing figure. For exact
accounting use the `usage` events — `/usage`, `/cost`, or the JSONL `usage` line
(see [`JSONL.md`](JSONL.md)).
