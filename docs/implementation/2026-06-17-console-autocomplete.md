# Implementation: Interactive Console Auto-Complete

- Slug: `2026-06-17-console-autocomplete` (matches the design doc)
- Design doc: `docs/design/2026-06-17-console-autocomplete.md`
- Status: closed
- Closing-commit: eaee749
- Closed-on: 2026-06-17
- Deferred: none
- `<TEST-CMD>`: `npm test` (i.e. `node --import tsx --test "test/**/*.test.ts"`)

> Review history: L2 was reviewed by independent fresh-eyes subagents (which caught
> a real single-segment-absolute-path defect in the path-domain spec before any code
> was written) and was never blocked by a severe issue. It closed under the
> two-generation rule after a user-authorized corroborating round over the 3-round
> cap. Round-by-round detail lives in git history.

## 1. Task Index

| Deliverable (design §2) | Acceptance (design §7) | Where |
|---|---|---|
| Pure completer module `src/complete.ts` (line→`[matches, substring]`) | AC-1..AC-9 | Phase 1, tasks T2/I2 |
| Three completion domains (command name / arg / path) | AC-1..AC-9 | Phase 1, tasks T2/I2 |
| `PROVIDER_NAMES` exported from `src/host.ts`; `known` repointed | AC-3, AC-11 | Phase 1, task I1 |
| Wire completer into `createInterface` (interactive path only) | AC-10, AC-11 | Phase 1, task I3 |
| Offline `test/complete.test.ts` covering every domain | AC-1..AC-9 | Phase 1, task T2 |

Design references by stable anchor (the design doc is consolidated at F, so section/Decision/AC
names are used instead of volatile line numbers): `docs/design/2026-06-17-console-autocomplete.md`
§2 Deliverables, §4 Key Design Decisions 1–7, §7 Acceptance Criteria AC-1..AC-11.

## 2. Phase Breakdown

This feature is a **single Phase**: one contiguous block of Deliverables, independently
committable, and `npm test` is green at the Phase exit. No invariant forces a split (per
loop-2 granularity rule), so it is not split.

### Phase 1 — Console auto-complete (commands + args + paths)

**Entry condition**: none (first Phase). Working tree clean on the task branch; `npm test`
green at baseline.

**Design document references** (by section/Decision/AC name — stable across the F consolidation
that will re-flow design line numbers):
- Module shape & domains: design §4 Decisions 1–3 and Decision 7.
- `/` disambiguation: design §4 Decision 4.
- Sync completer + no capability gate: design §4 Decisions 5–6.
- Provider single-source: design §2 Deliverable 4 + §5 "Single-source provider list".
- Acceptance: design §7 AC-1..AC-11.

**Module contract** (the shape tasks T2/I2 implement — fixes the `complete` API so the test
and the implementation agree; derived from design Decisions 2, 3, 7):

```ts
// src/complete.ts
export interface DirEntry { name: string; isDirectory: boolean; }
export interface CompleterContext {
  commandNames: () => readonly string[];   // live command names, WITHOUT leading "/"
  extensionIds: () => readonly string[];   // host.list() — loaded extension ids
  providerNames: readonly string[];        // PROVIDER_NAMES from host.ts
  readDir: (dir: string) => readonly DirEntry[]; // may throw; complete() catches → no matches
  homedir: () => string;                   // for leading "~/" expansion (injected for tests)
}
// readline's contract: returns [matches, substring]; readline replaces `substring`
// (the segment being completed) with the chosen match, so every match startsWith(substring).
export function complete(line: string, ctx: CompleterContext): [string[], string];
```

Domain dispatch (design Decision 2, evaluated top to bottom):
1. First token starts with `/` and the line has **no space yet** → command-name domain.
   `substring` = whole line; candidates = `commandNames()` each prefixed with `/`, filtered by
   `startsWith(line)`. (Decision 4: a leading `/` at line start is always a command, never an
   absolute path — so this branch must be reached *before* any path handling.)
2. First token is `/<name>` followed by a space and `name` ∈ `commandNames()` → argument domain.
   `substring` = the fragment after the command + single space. Dispatch:
   `provider` → `providerNames`; `reload` → `extensionIds()`; **any other command → `[]`**
   (no matches). An empty fragment returns the full set (filter by `startsWith("")`).
3. Otherwise (free text, or `/<unknown> …`) → path domain on the **last whitespace-delimited
   token**. Path-like iff the token contains `/` OR starts with `./`, `../`, `~/`, or `/`
   (Decision 3) — note every path-like token therefore contains at least one `/`. If not
   path-like → `[[], token]` (no matches). If path-like:
   - `slash = token.lastIndexOf("/")` (always ≥ 0 here); `dirPart = token.slice(0, slash)`,
     `base = token.slice(slash + 1)`.
   - Resolve the directory to **read** — the only place `~` is expanded:
     - `dirPart === ""` (a single-segment absolute path like `/Users`) → read `"/"` (the
       filesystem root, **not** `.`);
     - `dirPart` begins with `~` → read `homedir() + dirPart.slice(1)` (so `"~"` → `homedir()`,
       `"~/sub"` → `homedir() + "/sub"`);
     - otherwise → read `dirPart` verbatim (e.g. `"src"`, `"/Users/foo"`, `"."`).
   - `readDir(resolvedDir)` inside try/catch — any throw → return `[[], token]`.
   - Filter entries by `name.startsWith(base)`; **exclude dotfiles unless `base` starts with `.`**.
   - Reconstruct each match **uniformly** as `dirPart + "/" + entry.name` (the *original*
     `dirPart`, not the resolved/expanded one — so a leading `~`/`./` is preserved and
     `dirPart === ""` yields `"/" + name`), appending a trailing `/` when `entry.isDirectory`.
     This is what keeps every match `startsWith` the token substring.
   - `substring` = the whole token.

**Task list (TDD order — test tasks first):**

- **T1 (test, host)**: No new test needed — `selectProvider` regression is already covered by
  `test/host.test.ts:56-59` and `:122`. Confirm those exist; they are the regression guard for
  task I1. (No code in this task.)
- **T2 (test, completer)**: Write `test/complete.test.ts` importing `complete` from
  `../src/complete.js` and `PROVIDER_NAMES` from `../src/host.js`. Use a deterministic
  in-memory `CompleterContext`: `commandNames` returns a fixed list **including a synthetic
  name not in the host built-ins** (for AC-2), `extensionIds` returns `["memory","mcp"]`,
  `providerNames: PROVIDER_NAMES`, `readDir` is a **call-counting stub** over a fixed fake tree
  (e.g. `src/` → `[{name:"cli.ts",isDirectory:false},{name:"providers",isDirectory:true}]`),
  `homedir` returns a fixed `"/home/test"`. Assert, each protecting the named business
  invariant:
  - AC-1 — `complete("/pro", ctx)` ⇒ `[["/provider"], "/pro"]`; `complete("/", ctx)` ⇒ every
    command name, each leading with `/`. *(Invariant: command-name completion offers exactly the
    registry's `/`-prefixed names by prefix.)*
  - AC-2 — the synthetic command name appears in `complete("/", ctx)` output. *(Invariant: names
    come from the live registry, not a hardcoded list.)*
  - AC-3 — `complete("/provider an", ctx)` ⇒ `[["anthropic"], "an"]`; `complete("/provider ", ctx)`
    `[0]` deep-equals `[...PROVIDER_NAMES]`. *(Invariant: provider arg completion is the canonical
    set, asserted against the imported constant — never a hardcoded count.)*
  - AC-4 — `complete("/reload mem", ctx)` ⇒ `[["memory"], "mem"]`; `complete("/reload ", ctx)`
    `[0]` deep-equals `["memory","mcp"]`. *(Invariant: reload arg completion = live extension
    ids; empty fragment offers the full set.)*
  - AC-5 — `complete("/model gpt", ctx)` ⇒ `[[], "gpt"]`; `complete("/help any", ctx)`'s `[0]`
    is empty. *(Invariant: a command with no enumerable arg set yields no matches — silent
    no-op, not an error.)*
  - AC-6 — `complete("explain the src/cl", ctx)` ⇒ `[["src/cli.ts"], "src/cl"]`;
    `complete("explain the bug", ctx)`'s `[0]` is empty; `complete("ls src/", ctx)` includes
    `"src/providers/"` (trailing slash on the directory) and `"src/cli.ts"` (no trailing slash);
    a dotfile (`{name:".env"}`) is excluded for base `""` but included for `complete("cat ./.en", …)`
    when `readDir(".")` yields it; `complete("cat /Us", ctx)` with `readDir("/")` ⇒
    `[{name:"Users",isDirectory:true}]` yields `[["/Users/"], "/Us"]`. *(Invariant: path
    completion fires only on path-like tokens; dirs get a trailing `/`; dotfiles hidden unless
    explicitly prefixed; a single-segment absolute path reads the filesystem root, not cwd.)*
  - AC-7 — for one case in each of the three domains, assert `sub === <expected segment>` and
    every `m` in matches satisfies `m.startsWith(sub)`. *(Invariant: the readline substring
    contract — mismatch corrupts the typed line.)*
  - AC-8 — `complete("explain the src/cl", ctx)` increments the `readDir` call counter by
    **exactly 1**; assert the counter never exceeds 1 per call (no recursion). *(Invariant:
    bounded, non-recursive path cost.)*
  - AC-9 — `complete("/provider", ctx)` (leading `/`, no space) leaves the `readDir` counter at
    0. *(Invariant: a leading `/` is command-disambiguated, never path-read.)*
  - Path error: `complete("cat /no/such/dir/x", ctx)` where `readDir` throws ⇒ `[[], …]`
    (no throw escapes). *(Invariant: a failing readdir degrades to no-matches, never a crash.)*
  Acceptance command (red before I1–I2, green after): `node --import tsx --test test/complete.test.ts`
- **I1 (impl, host)**: In `src/host.ts`, add `export const PROVIDER_NAMES = ["anthropic", "openai", "gemini", "mock"] as const;`
  near the other exports, and change `selectProvider`'s line 237 `const known = [...]` to
  `const known = PROVIDER_NAMES;` (value-identical; `selectProvider` logic and signature
  unchanged). Acceptance: `node --import tsx --test test/host.test.ts` exits 0.
- **I2 (impl, completer)**: Create `src/complete.ts` implementing the module contract above so
  `test/complete.test.ts` passes. Pure module: only `node:path` helpers if needed; no `node:fs`
  import (the real `readDir`/`homedir` are injected by the caller). Use `.js` import specifiers.
  Acceptance: `node --import tsx --test test/complete.test.ts` exits 0.
- **I3 (impl, wiring)**: In `src/cli.ts`, wire the completer into the **interactive** readline
  interface only. Because `createInterface` (currently `:107`) runs before `createAgentHost`
  (`:127`) produces `commands`/`host`, restructure so `rl` is created **after**
  `createAgentHost`: change `const rl = …` to `let rl: Interface | undefined;` declared before
  `ui` (so `ui.confirm`'s existing `if (!rl) return args.yolo` guard still late-binds), and
  assign `rl = interactive ? createInterface({ input: stdin, output: stdout, completer }) : undefined;`
  immediately after `createAgentHost` returns and before `session_start` is emitted. Build
  `completer` as `(line) => complete(line, ctx)` with `ctx` reading the live `commands`/`host`,
  `PROVIDER_NAMES`, a real `readDir` = `(dir) => readdirSync(dir, { withFileTypes: true }).map(d => ({ name: d.name, isDirectory: d.isDirectory() }))`,
  and `homedir` from `node:os`. Do **not** touch the `--json`, `--eval`, or batch paths.
  Acceptance: `npm run typecheck` exits 0 AND `npm test` exits 0.

**Exit condition**: `src/complete.ts`, `test/complete.test.ts` exist; `src/host.ts` exports
`PROVIDER_NAMES`; `src/cli.ts` wires the completer on the interactive path only; `npm test` and
`npm run typecheck` both exit 0 (AC-10, AC-11); every AC-1..AC-9 assertion passes.

## 3. Engineering Constraints Index

- **Engineering norms** (`CLAUDE.md` House conventions): ESM + NodeNext — **always `.js`
  import specifiers** even for `.ts` sources; strict TypeScript (`noUncheckedIndexedAccess` etc.,
  no `any`); **zero new runtime dependencies** (only Node built-ins + existing); every feature
  ships an offline test (this is `test/complete.test.ts`).
- **Four-corner subagent template**: `references/loop-3-development.md` (dev / review / accept /
  fix, each a fresh subagent).
- **Commit conventions** (SKILL.md "Commit conventions"): Phase opener `feat(phase1): …`;
  within-round fix `fix(phase1-roundR): <failing-item-keyword>`; `npm test` / `npm run typecheck`
  results as trailers; **no mention of AI/model/tooling** in commit messages.

## 4. Data and Fixture Dependencies

- **No new fixtures, no real filesystem.** `test/complete.test.ts` injects an in-memory
  `CompleterContext` (a call-counting `readDir` over a fixed fake tree, a fixed `homedir`,
  fixed command/extension/provider lists). Offline and deterministic, consistent with the
  suite's MockProvider-only, no-network rule.
- Reuses the existing test runner wiring (`node --import tsx --test`), no new tooling.

## 5. Regression Protection

- `test/host.test.ts:56-59` (and `:122`) — `selectProvider` fallback + unknown-provider
  passthrough. These MUST stay green after task I1 repoints `known` to `PROVIDER_NAMES`; they
  are the proof the extraction is behavior-preserving.
- The **whole existing suite** stays green (`npm test`, AC-10). The only edited production files
  are `src/host.ts` (additive export + value-identical repoint) and `src/cli.ts` (interactive-
  path wiring); no non-interactive mode (`--json`/`--eval`/batch) code path is touched, so
  `test/server.test.ts`, the provider tests, and the integration tests must be unaffected.
- `npm run typecheck` (AC-11) is the guard that the new module and the `cli.ts`/`host.ts` edits
  satisfy the project's strict config.
