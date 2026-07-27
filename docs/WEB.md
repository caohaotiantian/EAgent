# Web UI

The rich human surface for EAgent is a **browser SPA** served by `eagent-serve`
(same-origin). The CLI keeps the plain append-only renderer
(`src/engine-render.ts`); this UI is for streaming transcripts, display modes,
and multi-session monitoring.

## Build and open

```bash
npm install                 # engine
npm --prefix web install    # web deps (react, vite)
npm run build:web           # → web/dist
npm run serve               # or: node --import tsx src/server.ts
# open http://127.0.0.1:8787/
```

Optional: `EAGENT_WEB_ROOT=/path/to/dist` overrides the default `web/dist` search.

### Dev

```bash
# terminal 1
npm run serve
# terminal 2
npm run dev:web             # Vite on :5173, proxies API to :8787
```

## Features

| Mode | Routes | Backend |
| --- | --- | --- |
| **Chat** | `#/` | `POST /run` JSONL (live transcript + elicitation) |
| **Monitor** | `#/monitor` | `GET /sessions`, per-session SSE, stop, forget |

Display modes `auto` / `full` / `collapsed` use the shared pure view-model
(`src/view-model.ts`). Remote transcripts are **flat** (no per-fork agent ids on
the wire).

## Auth

If `/health` reports `auth: "required"`, enter the bearer token matching
`EAGENT_TOKEN`. The token is stored in **`sessionStorage` only** (Log out clears
it). Static assets load without a token so the UI can boot.

**Threat notes:** XSS in this origin can steal the token; a token grants full
server capability policy (often yolo). Prefer loopback + token for local use;
harden for any shared host (`SECURITY.md`).

## Layout

```
web/
  src/api/       fetch client (run JSONL, SSE, sessions)
  src/chat/      session Clear / ask state machines
  src/App.tsx    React UI
src/wire-events.ts   pure JSONL/SSE object → SourceEvent mapper
src/server.ts        static serve + auth-exempt GET for SPA
```
