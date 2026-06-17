# Design: Interactive Console Auto-Complete

- Slug: `2026-06-17-console-autocomplete`
- Status: closed
- Closing-commit: eaee749
- Closed-on: 2026-06-17
- Deferred: none
- Tier: Full Mode (three-loop-workflow)

> Review history: L1 was reviewed by independent fresh-eyes subagents and was never
> blocked by a severe issue. It closed after a user-authorized corroborating review
> round taken over the 3-round cap (the design had converged clean; a standing
> policy was authorized to auto-run one corroborating round on clean-at-cap
> convergence). The completion scope (commands + arguments + filesystem paths) was
> a user-confirmed decision. Round-by-round detail lives in git history.

## 1. Background and Purpose

EAgent's interactive console (`src/cli.ts`, the `repl()` loop built on
`node:readline/promises`) currently offers no Tab completion. A user typing a
slash command must remember and type its exact name (`/provider`, `/extensions`,
…); a user referencing a file path in free-text input gets no help. The list of
valid commands is dynamic — extensions register their own — so there is no fixed
cheat-sheet to memorize, which makes the absence of completion especially costly.

`node:readline` already supports a `completer` option on `createInterface`, and
EAgent does not pass one. Wiring a completer is a small, self-contained host
improvement that makes the REPL noticeably more usable.

If we do not do this: the REPL stays harder to use than it needs to be, the
dynamic command surface stays undiscoverable except via `/help`, and a
zero-cost-to-the-kernel UX win goes unrealized.

## 2. Deliverables

- [x] A pure, exported completer module `src/complete.ts` exposing a function
      that maps `(line, context)` to readline's `[matches, substring]` tuple,
      with no dependency on a live TTY so it is unit-testable offline.
- [x] The completer is wired into the interactive REPL by passing it to
      `createInterface` in `src/cli.ts` (interactive path only; `--json`,
      `--eval`, and piped-batch paths are untouched).
- [x] Three completion domains, dispatched from the parsed line:
      (a) slash-command **name** completion (against the live command registry);
      (b) context-sensitive **argument** completion for the commands whose value
      set is enumerable (`/provider`, `/reload`);
      (c) filesystem **path** completion of a path-like trailing token in
      free-text input.
- [x] A `PROVIDER_NAMES` constant exported from `src/host.ts`, created by
      **extracting the literal `["anthropic", "openai", "gemini", "mock"]` that
      already exists inline at `src/host.ts:237`** into a named export. The
      completer consumes it, and `selectProvider`'s existing `known` reference is
      repointed at it. This is a behavior-preserving literal-extraction (it
      *removes* a duplicate rather than adding an abstraction), scoped to those
      two lines — not a refactor of `selectProvider`'s logic (see Decision 2).
- [x] An offline test file `test/complete.test.ts` covering every domain,
      including the disambiguation and "no completion" cases, with the directory
      reader injected so no real filesystem state is required.
- [x] `docs/design/2026-06-17-console-autocomplete.md` (this file) and
      `docs/implementation/2026-06-17-console-autocomplete.md`.

## 3. Scope Boundary (NOT in scope)

- **No completion for non-enumerable arguments.** `/model` takes a free-form
  string with no canonical list; it gets **no** argument completion (and no path
  completion — a model name is not a path). Only `/provider` and `/reload` get
  argument completion. `/ext`/`--ext` is a CLI flag, not a REPL command, so it is
  out of scope.
- **No completion of free-text prose into LLM-meaningful tokens.** Only a
  *path-like* trailing token is completed in free text (see Decision 3). General
  natural-language autocompletion / history-based suggestion is out of scope.
- **No fuzzy / substring / case-insensitive matching.** Completion is strict
  prefix matching only (the readline contract and shell convention).
- **No changes to non-interactive modes** (`--json`, `--eval`, piped batch). They
  have no readline interface and must stay byte-for-byte unchanged.
- **No new kernel primitive, no new extension, no capability declaration.** This
  is host UI sugar in `src/cli.ts` + `src/complete.ts`; the kernel stays oblivious
  (see Decision 6).
- **No async completer, no recursive directory walking, no caching layer.**
- **No latency micro-benchmark.** Path completion performs at most one
  non-recursive directory read per Tab; a wall-clock budget for a single local
  `readdir` is not a meaningful or stable CI assertion. The cost is bounded
  structurally instead (Acceptance Criterion AC-8), which is the property that
  actually matters. This is the explicit section-7 quality-budget exclusion.

## 4. Key Design Decisions

### Decision 1 — Where the completer logic lives

- **Problem**: the completion logic must be unit-testable, but `src/cli.ts`'s
  helpers are not exported and `repl()` requires a live TTY.
- **Options**: (a) inline closure inside `cli.ts`; (b) a separate exported pure
  function module `src/complete.ts` that `cli.ts` imports and wires in.
- **Choice**: (b). The completer is a pure string→tuple transform; isolating it
  lets the offline suite assert its behavior directly (Goal-Driven Execution
  requires mechanically-verifiable acceptance).
- **Why (a) rejected**: a closure over `repl()` internals cannot be exercised
  without a pseudo-TTY, so acceptance would rest on author confidence — forbidden.

### Decision 2 — Line parsing and domain dispatch

- **Problem**: one completer must serve three domains; it needs an unambiguous
  rule for which domain a given line is in.
- **Choice** (single rule, evaluated top to bottom):
  1. Line's first token starts with `/` **and** contains no space yet (still
     typing the command word) → **command-name** completion against the live
     registry, each candidate rendered with its leading `/`.
  2. First token is `/<known-command>` followed by a space → **argument**
     completion dispatched per command (`/provider` → the `PROVIDER_NAMES`
     constant; `/reload` → `host.list()` extension ids — and an empty fragment
     offers the full set for either; any other command → no matches).
  3. Otherwise (free text, or a `/unknown ` command) → **path** completion of the
     trailing whitespace-delimited token, *only if* that token is path-like
     (Decision 3); else no matches.
- **Why**: this mirrors the REPL's existing Enter-time grammar exactly
  (`line.startsWith("/")` already dispatches a command in `repl()`), so what Tab
  offers is always consistent with what Enter will do. Any other split would let
  the completer suggest things the REPL cannot act on.
- **Options considered & rejected**: a flat "complete everything everywhere"
  approach (offer commands *and* paths *and* args for every line) — rejected as
  noisy and inconsistent with the dispatch grammar.
- **`/provider` is enumerable-*plus-passthrough*, not closed.** The live
  `/provider` command (`src/cli.ts:343`) accepts *any* string and
  `selectProvider` passes an unrecognized name straight through
  (`src/host.ts:238`), which is what lets a user point at a custom
  OpenAI-compatible endpoint (README's Ollama example). Argument completion
  therefore *offers* the canonical `PROVIDER_NAMES` set as a discovery aid; it does
  **not** constrain the command — a user can still type and Enter a name outside
  the set. Completion suggesting only canonical names while the command stays open
  is intentional, mirroring how a shell completes common values without forbidding
  others.

### Decision 3 — When a free-text trailing token is "path-like"

- **Problem**: free text goes to the LLM, not a shell. Completing *every*
  trailing word as a path would dump directory listings onto ordinary prose.
- **Options**: (a) always path-complete the last token; (b) only when the token
  contains a `/` or starts with a path prefix (`./`, `../`, `~/`, `/`); (c) only
  when the token already matches an existing file.
- **Choice**: (b). It matches user intent (a token with a separator is a path),
  is predictable, and is exactly the case the user's confirmed example shows
  (`… src/cl⇥ → src/cli.ts`).
- **Why others rejected**: (a) is noisy — Tab on "explain the bug" would list the
  cwd; (c) is surprising — a freshly-typed bare filename gives no feedback and no
  way to discover why.
- **Documented limitation**: a *bare* top-level filename with no separator
  (`cli.ts`) does not path-complete until a separator is present. Accepted for v1;
  recorded in Risks.

### Decision 4 — Disambiguating a leading `/`: command vs absolute path

- **Problem**: `/provider` (a command) and `/Users/foo` (an absolute path) both
  start with `/`. The completer must pick one when `/` is the first character.
- **Choice**: at the **start of the line** (first token, no space yet) a leading
  `/` always means **command-name** completion. Absolute paths remain completable
  when they are *not* the first token (e.g. `cat /Users/foo/ba⇥`, where `/Users/…`
  is the trailing token under Decision 3).
- **Why**: the REPL already reserves a leading `/` at line start for commands
  (`repl()` dispatches `line.startsWith("/")` as a command). The completer must
  honor that grammar or it would offer path completions for input the REPL will
  instead try to run as a command.
- **Documented limitation**: an absolute path typed as the literal first token of
  a turn (`/etc/hosts please read`) will offer command completions, not paths.
  Rare; the workaround is a leading word or `./`. Recorded in Risks.

### Decision 5 — Synchronous completer

- **Problem**: readline accepts both a synchronous completer (`(line) =>
  [matches, sub]`) and an async one.
- **Choice**: synchronous, using a single `readdirSync` for path completion.
- **Why**: a sync completer is the simplest correct readline integration, keeps
  the completion function a plain `(line) => tuple` transform, and is
  deterministic to test (the injected reader returns synchronously). Async adds
  callback/promise surface for a single local directory read with no
  user-perceptible benefit and complicates testing.

### Decision 6 — No capability gate for directory reads

- **Problem**: path completion reads directory entries off the local filesystem.
  EAgent gates filesystem reads behind the `fs:read` capability for the `read`
  *tool*. Does the completer need the same gate?
- **Choice**: **no** capability gate.
- **Rationale**: capabilities gate *agent/tool* side effects — actions the model
  initiates that could exfiltrate or mutate. Tab completion is host UI initiated
  by the user pressing a key in their own terminal; the directory names never
  enter the transcript, never reach the model, and never leave the user's
  machine. It is the exact analogue of bash/zsh path completion. Gating it would
  prompt the user for permission to complete their own typing, which is absurd and
  contradicts the purpose. This decision is called out explicitly so the L1
  reviewer can challenge it rather than have it pass by silent omission.
- **Precision on the "never enters the transcript" claim**: the guarantee is
  about the completion *act* — the directory listing readline shows is never
  captured into the transcript or sent to the model. If the user then Tab-expands
  a path and presses Enter, the expanded path string enters the turn exactly as if
  they had typed it by hand; that is the user's own input and introduces no new
  exfiltration channel, so it does not change the decision. That submitted input
  is then governed by the *existing* egress machinery (`flow-guard`'s taint logic,
  `integrity`'s transcript watch) exactly as hand-typed input is — the completer
  adds no path around those gates.

### Decision 7 — readline return contract (`[matches, substring]`)

- **Problem**: readline replaces the returned `substring` with the chosen match,
  so `substring` must equal exactly the slice readline will overwrite, or
  completion corrupts the line.
- **Choice**: the returned `substring` is **the segment being completed**, and
  every match is a full string that begins with that substring:
  - command-name domain: `substring` = the whole line (e.g. `/pro`); matches are
    full command tokens (`/provider`).
  - argument domain: `substring` = the argument fragment after the command+space
    (e.g. `an` in `/provider an`); matches are full values (`anthropic`).
  - path domain: `substring` = the whole trailing token (e.g. `src/cl`); matches
    are full paths (`src/cli.ts`), with a trailing `/` appended to directories so
    the user can keep descending.
- **Why**: returning the precise replaced segment is the only contract readline
  honors; mismatches are the classic completer bug, so it is fixed here and
  asserted in tests (AC-7).
- **Dotfile convention**: hidden entries (names starting with `.`) are offered
  only when the path token's base segment itself starts with `.` — standard shell
  behavior, avoids dumping `.git`/`.env` on every path completion.

## 5. Dependencies and Assumptions

- **Runtime**: Node ≥ 22 (already required; `package.json` `engines`).
- **APIs used**: `node:readline/promises` `createInterface({ completer })`;
  `node:fs` `readdirSync(dir, { withFileTypes: true })` for path completion.
- **Live data sources** (read at completion time, never cached): the command
  registry (`commands.list()` → live command names, including extension-registered
  ones) and `host.list()` (loaded extension ids for `/reload`).
- **Single-source provider list**: the provider set for `/provider` argument
  completion is the exported `PROVIDER_NAMES` constant in `src/host.ts`
  (`["anthropic", "openai", "gemini", "mock"]`), formed by naming the literal that
  `selectProvider` *already* declares inline at `src/host.ts:237`. The offerable
  provider set and the set `selectProvider` recognizes for passthrough detection
  are identical today and intentionally share one name; the change is the
  extraction itself (a duplicate becomes a single named constant), not new
  coupling of completion to provider-resolution logic — `selectProvider`'s control
  flow and signature are unchanged. If the two sets ever need to diverge, that is a
  future decision, explicitly out of scope here. This is an additive export to the
  already-public `./host` surface.
- **Assumption**: the completer is only installed on the interactive
  (`stdin.isTTY` && no `--eval`) path, where `rl` exists. No other entry point
  constructs a readline interface.
- **Assumption**: zero new npm dependencies (house rule); only Node built-ins.
- **Assumption**: the directory reader is injectable into the path-completion
  function (defaulting to `node:fs`), so tests stay offline and deterministic
  without touching real cwd state.

## 6. Relationship with Existing Designs

`docs/design/` contains no prior design documents (this is the first); per the L1
convention, terminology anchors are the project README and the CLAUDE.md
_engineering-norms_ / _language-policy_ roles (House conventions: ESM + NodeNext
`.js` specifiers, strict TypeScript, zero runtime deps except `jiti`, every
feature ships an offline test).

Touch points in existing code (no conflicts found):
- `src/cli.ts:107` — `createInterface({ input: stdin, output: stdout })` is where
  the `completer` option is added.
- `src/cli.ts:299-363` — `registerHostCommands` defines `/provider` (enumerable
  set) and `/reload` (extension ids), confirming those are the enumerable-arg
  commands.
- `src/kernel/commands.ts:46` — `CommandRegistry.list()` returns the live,
  sorted, shadow-resolved command set the name-completion domain consumes.
- `src/host.ts:237` — the inline `known` literal whose value is extracted into the
  exported `PROVIDER_NAMES` constant; `known`'s reference is repointed at the
  constant (value unchanged) and `/provider` argument completion reads the same
  constant. Adds one export to the already-public `./host` surface; behavior is
  unchanged.

No existing design or contract is altered (the `host.ts` change is an additive
export plus a behavior-preserving literal extraction). ⚠ None detected.

## 7. Acceptance Criteria (measurable / automatable, realized at L2)

AC-1 through AC-9 are **per-domain pure-function assertions** against
`src/complete.ts` with an injected directory reader. AC-10 and AC-11 are the
**global regression gate** (whole-suite commands, a separate class). All run
offline, no API key.

- **AC-1 (command name)**: `complete("/pro", ctx)` → `[["/provider"], "/pro"]`
  when `/provider` is the only `/pro*` command; `complete("/", ctx)` returns every
  registered command name, each leading with `/`.
- **AC-2 (command name reflects live registry)**: a command registered only in
  `ctx` (simulating an extension-registered command) appears in `complete("/", ctx)`
  output — proving names come from the live registry, not a hardcoded list.
- **AC-3 (provider arg)**: `complete("/provider an", ctx)` →
  `[["anthropic"], "an"]`; `complete("/provider ", ctx)` returns exactly the
  exported `PROVIDER_NAMES` constant (the test imports and asserts against that
  constant, not a hardcoded count, so a future provider addition cannot leave the
  test enforcing a stale list).
- **AC-4 (reload arg)**: `complete("/reload mem", ctx)` with `host.list()` =
  `["memory", "mcp", …]` → `[["memory"], "mem"]`; `complete("/reload ", ctx)`
  (empty fragment) → the full `host.list()` set (the user may still press Enter on
  an empty arg for "reload all"; completion only *offers* the per-id list).
- **AC-5 (non-enumerable arg → empty)**: `complete("/model gpt", ctx)` →
  `[[], "gpt"]` (no completion); `complete("/help any", ctx)` → no matches. The
  intended user-facing behavior of "no matches" is a silent no-op (readline does
  nothing / emits the terminal bell), which is the standard shell convention for
  an uncompletable token — not an error message. This silent-no-op feel is the
  intended behavior, not an oversight.
- **AC-6 (path-like vs prose, and dir formatting)**: `complete("explain the src/cl", ctx)`
  with an injected reader for `src/` containing `cli.ts` →
  `[["src/cli.ts"], "src/cl"]`; `complete("explain the bug", ctx)` → no matches
  (token not path-like). When the injected reader reports a directory entry, the
  completion for it ends with a trailing `/` (so the user can keep descending);
  a plain file does not. Dotfiles are offered only when the path token's base
  segment itself starts with `.`.
- **AC-7 (readline substring contract)**: for each domain the returned substring
  equals exactly the segment to be replaced, and every match `startsWith` that
  substring (asserted directly, since a mismatch is the classic completer bug).
- **AC-8 (bounded path cost)**: completing a path token invokes the injected
  directory reader **at most once** per Tab and never recursively — asserting the
  no-directory-walking guarantee from the Scope Boundary as a single, focused
  call-count check (the trailing-slash formatting is asserted under AC-6).
- **AC-9 (disambiguation)**: `complete("/provider", ctx)` (leading `/`, first
  token) is treated as command completion, never path completion — the injected
  directory reader is **not** called.
- **AC-10 (suite regression)**: `npm test` exits 0 — the new test file passes and
  no existing test changes behavior.
- **AC-11 (type safety)**: `npm run typecheck` exits 0 — the new module and the
  `src/cli.ts` / `src/host.ts` edits type-check under the project's strict config.

## 8. Risks and Rollback

- **Risk: completer fires at the `[y/N]` confirm prompt too.** The `completer`
  is bound to the whole readline interface, so Tab during `ui.confirm`'s
  `rl.question` also triggers it. *Mitigation*: harmless — worst case Tab offers
  an irrelevant completion at a y/N prompt; it cannot submit or corrupt the
  answer. Documented, not gated. (readline gives the completer no prompt context,
  so suppressing it there is not cleanly possible and not worth complexity.)
- **Risk: substring/match mismatch corrupts the typed line.** The single most
  common completer bug. *Mitigation*: AC-7 asserts the contract for every domain.
- **Risk: a missing/permission-denied directory throws inside the completer**,
  which readline would surface as a crash mid-keystroke. *Mitigation*: the path
  domain wraps its `readdir` and returns "no matches" on any error — never throws
  out of the completer.
- **Risk (documented limitations, accepted for v1)**: a bare top-level filename
  with no separator does not path-complete (Decision 3); an absolute path as the
  literal first token of a turn is read as a command (Decision 4). Both have
  trivial workarounds (`./name`, leading word) and are low-frequency.
- **Rollback**: the feature is additive and isolated. Reverting is removing the
  `completer:` option from `createInterface` in `src/cli.ts`, deleting
  `src/complete.ts` + `test/complete.test.ts`, and reverting `src/host.ts` to its
  inline provider literal (dropping the `PROVIDER_NAMES` export). No kernel,
  extension, or non-interactive path is touched, so revert is mechanical and total.
