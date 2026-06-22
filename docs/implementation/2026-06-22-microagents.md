# Implementation: `microagents` — keyword-triggered knowledge injection

Slug: `2026-06-22-microagents`
Status: draft
Design doc: `docs/design/2026-06-22-microagents.md`

## 1. Task Index

| Design artifact | Design doc location |
| --- | --- |
| Deliverables (7 checkboxes) | `docs/design/2026-06-22-microagents.md` §2 |
| Scope Boundary (non-goals) | §3 |
| Decision 4.1 discovery dir (exact 2-level order) | §4.1 |
| Decision 4.2 scan latest `user` message; text-block extraction | §4.2 |
| Decision 4.3 case-insensitive whole-word match | §4.3 |
| Decision 4.4 reuse single-line frontmatter; comma-split triggers | §4.4 |
| Decision 4.5 size cap (prefix fill, `MAX_TOTAL_BYTES = 32*1024`) | §4.5 |
| Decision 4.6 cached scan; `/microagents` re-scans | §4.6 |
| Acceptance Criteria (10) | §7 |

`<TEST-CMD>` = `npm test` (i.e. `node --import tsx --test "test/**/*.test.ts"`).
`<ACCEPT-CMD>` set for the single Phase is listed under that Phase.

## 2. Phase Breakdown

This is a **single Phase**: one self-contained extension file plus its test, a
one-line host registration, and two doc lines. Splitting would leave
`<TEST-CMD>` unable to import a half-written module, violating the
"green at the end of every Phase" rule, so it stays one Phase (design §2; L2
granularity rule).

### Phase 1 — the `microagents` extension

**Entry condition**: L1 design doc passed (it has). No prior Phase.

**Design references**: `docs/design/2026-06-22-microagents.md` §2, §3, §4.1–§4.6,
§7 (all 10 criteria), §8.

**Module shape to build** (`src/extensions/microagents.ts`) — these named
exports exist so the pure logic is unit-testable without the harness, mirroring
`prune.ts`'s exported `pruneMessages`:

- `interface Microagent { name: string; triggers: string[]; body: string; description?: string }`
- `export function parseMicroagent(md: string, fallbackName: string): Microagent | undefined`
  — reuse the **exact** single-line frontmatter convention of
  `skills.ts:155-166` (file must open with `---` and contain a closing `\n---`;
  bare top-of-file `key: value` is **not** parsed — design advisory carried from
  L1 round 3). Split the `triggers` value on commas; trim + lowercase each;
  drop empties. Return `undefined` when there are zero non-empty triggers
  (enforces design §3 "no always-on"). `body` is the markdown after the
  frontmatter fence; `name` defaults to `fallbackName` (filename without `.md`).
- `export function triggered(userText: string, triggers: string[]): boolean`
  — case-insensitive **whole-word** match (design §4.3): lowercase `userText`,
  and for each (already-lowercased) trigger, accept only if it occurs with the
  char immediately before and after the match being non-alphanumeric or absent.
  (Alphanumeric = `/[a-z0-9]/` on the lowercased text; this makes `k8s` match at
  word edges and `cat` not match inside `category`.)
- `export function latestUserText(messages: Message[]): string | undefined`
  — the concatenation (space-joined) of `text`-block text from the last message
  whose `role === "user"`; `undefined` if there is no `user` message
  (design §4.2). Non-text blocks ignored.
- `export const MAX_TOTAL_BYTES = 32 * 1024;`
- `export function injectMicroagents(messages: Message[], microagents: Microagent[]): Message[]`
  — the pure transform. Reads its own kill switch (`EAGENT_MICROAGENTS === "off"`
  → return `messages` **by reference**). Compute `latestUserText`; if `undefined`
  → return `messages` by reference. Select microagents whose triggers fire,
  sorted by `name` (deterministic; design §4.5). Prefix-fill under
  `MAX_TOTAL_BYTES` using `Buffer.byteLength(body, "utf8")`: stop at the first
  body that would exceed the running total; never mid-truncate. If zero selected
  after filtering/capping → return `messages` **by reference**. Otherwise return
  a **new** array `[note, ...messages]` where `note` is one `system` message
  (`meta: { source: "microagents", ephemeral: true }`) whose text concatenates
  the selected bodies, each under a `### <name>` heading (mirror
  `context-files.ts:81-84` shape).
- `export function scanMicroagents(dir: string): Microagent[]`
  — `readdirSync(dir)` (try/catch → `[]` on failure), keep `*.md`, sort by
  filename, `readFileSync`+`parseMicroagent` each inside try/catch (skip
  unreadable/badly-fenced/trigger-less files). Degrade to `[]`, never throw
  (design §8).
- `export function microagentsDir(): string`
  — `process.env.EAGENT_MICROAGENTS_DIR ?? join(<workspace>, ".eagent",
  "microagents")`, `<workspace> = process.env.EAGENT_WORKSPACE ?? process.cwd()`
  (design §4.1 exact order; **no** `store`-backed layer).
- `export default function activate(e: ExtensionAPI): void`
  — cache `Microagent[] | undefined`; `discover()` scans once and caches;
  register `e.hook("transformContext", (m) => injectMicroagents(m, discover()))`;
  register the `/microagents` command which re-scans (refreshing the cache) and
  prints each microagent as `name` + `[triggers]`, or a `(no microagents in
  <dir>)` line when empty. No capability (`e.grantCapability` not called).

**Task list (TDD order — tests first):**

1. **TEST** `test/microagents.test.ts` — `parseMicroagent`:
   *Invariant: a file is a microagent iff it has ≥1 non-empty trigger, and
   triggers are comma-split + trimmed + lowercased.* Assert a fenced file with
   `triggers: Kubernetes, K8s` parses to `triggers === ["kubernetes","k8s"]`,
   `body` excludes the frontmatter; a fenced file with no `triggers` line, or
   `triggers:` empty, returns `undefined`; a file not opening with `---` returns
   `undefined`.
2. **TEST** `triggered`: *Invariant: whole-word, case-insensitive (design §4.3,
   AC-3/AC-4).* `triggered("scale KUBERNETES now", ["kubernetes"])` true;
   `triggered("list the category", ["cat"])` false;
   `triggered("feed the cat.", ["cat"])` true;
   `triggered("use k8s here", ["k8s"])` true; `triggered("xk8sy", ["k8s"])` false.
3. **TEST** `latestUserText`: *Invariant: last `user` message's text blocks,
   joined; tool/assistant ignored (design §4.2, AC-5).* For
   `[user("a kubernetes q"), assistant("x"), tool_result]`, returns the user
   text (the trailing tool/assistant messages do not shadow it); for a list with
   no user message, returns `undefined`; multiple text blocks in the user
   message are space-joined.
4. **TEST** `injectMicroagents` AC-1/AC-2/AC-3/AC-4/AC-5: with one microagent
   `{name:"k8s",triggers:["kubernetes","k8s"],body:"BODY-K8S"}` and messages
   whose latest user text is `"how do I scale kubernetes?"`, the result's first
   message is a `system` message containing `BODY-K8S`; with latest user text
   `"how do I scale a database?"` the result **is the input array by reference**
   (`assert.equal(out, input)`); case-insensitive and whole-word behavior is
   observable end-to-end via the body appearing / not appearing; AC-5 latest-user
   anchoring (last message a `tool_result`) still injects.
5. **TEST** `injectMicroagents` AC-6 size cap: two matching microagents both
   present when small. Then a concrete oversizing fixture so the test is
   reproducible: microagent `a` (sorts first) with a body of
   `MAX_TOTAL_BYTES - 100` bytes (e.g. `"A".repeat(MAX_TOTAL_BYTES - 100)`) and
   microagent `b` with a body of 200 bytes (`"B".repeat(200)`), both triggered.
   Assert only `a`'s body appears, `b`'s 200-byte body is **absent** (the next
   file would exceed the cap → prefix-fill stops), and `a`'s body is **not**
   mid-truncated (its full `MAX_TOTAL_BYTES - 100`-char string is a substring of
   the injected note).
6. **TEST** `injectMicroagents` AC-8 kill switch: with `EAGENT_MICROAGENTS=off`
   (saved/restored in a `finally`, per `prune.test.ts:208-219`), a would-match
   input returns **by reference** (`assert.equal(out, input)`).
7. **TEST** `scanMicroagents` AC-7: write temp `.md` files in a fresh temp dir
   (`mkdtempSync(join(tmpdir(), ...))`); a file with triggers is returned, a
   file without triggers is absent; a non-existent dir returns `[]` without
   throwing. Clean up the temp dir in a `finally`.
8. **TEST** AC-1 registration + AC-9 command via the harness
   (`makeHarness()`, `host.use("microagents", microagents)`): registering adds
   exactly **one** `transformContext` listener and **one** command, and **zero**
   tools (mirror `prune.test.ts:222-233`); invoke the `/microagents` command
   with `EAGENT_MICROAGENTS_DIR` pointed at a temp dir containing one microagent
   and assert the captured `print` output names the microagent and its triggers;
   point it at an empty/absent dir and assert the `(no microagents …)` line and
   no throw. Capture output with a hand-built `CommandContext` whose `print`
   pushes to an array (`commands.ts:10-16`), or via the registry.
9. **IMPL** Write `src/extensions/microagents.ts` to satisfy tasks 1–8.
10. **IMPL** Register `["microagents", microagents]` in
    `src/host.ts` `BUILTIN_EXTENSIONS` (after `context-files`, its sibling) and
    add the import line.
11. **IMPL/DOC** Add one inventory bullet to `CLAUDE.md` "Where things live"
    extension list (load-bearing doc) describing `microagents`. Add a one-line
    mention to `docs/EXTENSIONS.md` only if a natural spot exists; otherwise
    record "no EXTENSIONS.md change (it is prose, no per-extension table; no
    capability added)" in the Phase exit note (design §2 deliverable is
    conditional).

**Per-task acceptance commands** (runnable from repo root):

- Targeted suite: `node --import tsx --test test/microagents.test.ts`
- Typecheck: `npm run typecheck`
- Full regression: `npm test`

**Exit condition**: `node --import tsx --test test/microagents.test.ts` reports
`# fail 0` covering AC-1…AC-9; `npm run typecheck` exits 0; `npm test` exits 0
(`# fail 0`, no pre-existing subtest regressed) — design §7 AC-10. The new
extension appears in `BUILTIN_EXTENSIONS` and the `CLAUDE.md` inventory.

## 3. Engineering Constraints Index

- **Engineering norms**: `CLAUDE.md` "House conventions" role — ESM + NodeNext
  with `.js` import specifiers even for `.ts` imports; strict TS
  (`noUncheckedIndexedAccess` etc.); **zero runtime deps except `jiti`** (no new
  npm dep — use Node `fs`/`path`/`os` and `Buffer` only); capability-gated side
  effects (none here — pure read-only injection, consistent with `context-files`
  and `skills` tier-1 which take no capability); every extension ships offline
  tests via `node:test` run through `tsx`.
- **Four-corner subagent template**: `references/loop-3-development.md`.
- **Commit conventions**: SKILL.md "Commit conventions" — `feat(phase1):` for the
  opener, `fix(phase1-roundR): <keyword>` for within-round fixes; `<TEST-CMD>` /
  `<ACCEPT-CMD>` results as trailers; no mention of AI/model/tooling.

## 4. Data and Fixture Dependencies

- Reuse the existing test harness `test/helpers.ts` (`makeHarness`) for the
  registration + command tasks (task 8), exactly as `prune.test.ts` does.
- New fixtures are created **in-test** as temp dirs/files via
  `node:fs` `mkdtempSync` + `os.tmpdir()` (no committed fixture files), cleaned
  up in `finally`. The pure-function tasks (1–6) pass literal strings/objects
  and need no filesystem.
- Env vars touched in tests (`EAGENT_MICROAGENTS`, `EAGENT_MICROAGENTS_DIR`)
  must be saved and restored in `finally`, per the `prune.test.ts:208-219`
  pattern, so tests do not leak state across the suite.

## 5. Regression Protection

- This is Phase 1; the only prior-art regression surface is the **full existing
  suite**, which must stay green: `npm test` exits 0 (`# fail 0`).
- Registering a new builtin in `host.ts` must not break host/integration tests
  (`test/host.test.ts`, `test/integration.test.ts`, `test/scenario.test.ts`):
  re-run `npm test` after task 10. No existing test references
  `BUILTIN_EXTENSIONS` or asserts an exact builtin count (verified at L2 review),
  so registration is purely additive; still re-run `npm test` to confirm nothing
  order-dependent regresses.
- The new `transformContext` listener must be additive and order-independent
  (it returns the input by reference on the no-match path, so it cannot corrupt
  `prune`/`memory`/`context-files` output in the no-trigger case).

## Closure note

Status: closed. Closing-commit: 6cb9f96. Closed-on: 2026-06-22.
Phase 1 closed: dev (`feat(phase1)`), one within-round test-coverage fix
(`fix(phase1-round2)`), review 2 generations clean, accept-pass. Main-agent
Phase-end re-run: `npm test` exit 0 (385/385, 0 skipped), `npm run typecheck`
exit 0, `node --import tsx --test test/microagents.test.ts` exit 0 (11/11).
No `Deprecated` section (no L1/L2 rollbacks occurred).
Deferred: none.
