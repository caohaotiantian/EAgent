# Contributing to EAgent

Thanks for helping. EAgent is a minimalist AI-agent kernel: a tiny, stable core
plus an Emacs-grade extension surface. Almost every contribution should land as
an **extension**, not a change to the kernel — see *House conventions* below.

## Prerequisites

- **Node ≥ 22** (the project targets the current LTS; see `engines` in
  `package.json`).
- No API key is required. The full test suite runs offline against a
  deterministic mock provider.

```bash
npm install
```

## Key commands

```bash
npm test         # offline test suite (node:test via tsx) — no network, no API key
npm run typecheck # tsc --noEmit, strict
npm run build    # tsc -> dist/
npm run dev      # interactive REPL (src/cli.ts via tsx)
npm run serve    # HTTP server (src/server.ts; GET /health, POST /run; PORT=8787)
```

`npm test` drives everything through `MockProvider` (`src/providers/mock.ts`), a
scriptable, deterministic LLM. That is why the suite needs no network and no
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. Keep it that way — tests must run
offline.

For a live session, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and run
`npm run dev`; the provider is selected automatically (override with
`--provider`).

## House conventions

- **ESM + NodeNext.** Always use `.js` import specifiers, even when importing a
  `.ts` file (e.g. `import { defineTool } from "../kernel/define.js"`). This is
  required by `module: NodeNext` and `verbatimModuleSyntax`.
- **Strict TypeScript.** `strict`, `noUncheckedIndexedAccess`,
  `noImplicitOverride`, and `noFallthroughCasesInSwitch` are all on. Model the
  types; no `any` cop-outs.
- **Zero runtime dependencies except `jiti`.** Do not add npm dependencies.
  Providers use the global `fetch`; nothing pulls in an SDK.
- **Capabilities are the security vocabulary.** Any privileged tool declares the
  authority it needs (e.g. `fs:read`, `shell:exec`, `net:fetch`) and the
  dispatcher enforces it before `execute` runs. Gate every side effect behind a
  capability.
- **Every extension ships with an offline test.** One file per
  primitive/extension under `test/`, run via `node:test`.
- **The kernel-minimalism guard.** `test/kernel-surface.test.ts` pins the
  kernel's public surface and holds `src/kernel/` under a hard line ceiling. New
  capability is an **extension, not a kernel change**. If you find yourself
  editing the core, stop and ask whether it belongs in an extension — it almost
  always does.

## Writing an extension

An extension is a module with a default-exported activation function that
receives the `ExtensionAPI`:

```ts
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

Register everything through the `ExtensionAPI` (`registerTool`,
`registerProvider`, `registerCommand`, `on`, `hook`, `grantCapability`,
`store`). The host tracks every registration so a `/reload` tears the old
version down cleanly. The worked examples in `examples/extensions/` and the full
author's guide in [`docs/EXTENSIONS.md`](docs/EXTENSIONS.md) are the place to
start.

## Pull requests

Keep PRs tight and focused. Before opening one:

```bash
npm run typecheck
npm test
```

Both must be green — CI runs them on every PR. Include or update offline tests
for any new behavior, keep the kernel minimal (prefer an extension), and follow
the conventions above. The security model in [`SECURITY.md`](SECURITY.md) is
authoritative for anything that touches the filesystem, the shell, the network,
or LLM-authored code.
