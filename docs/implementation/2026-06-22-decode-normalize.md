# Implementation: decode-normalize — pre-inspection decode/normalize feeding `bash-policy` and `risk-guard`

Status: open
Closing-commit: (fill at closeout)
Closed-on: (fill at closeout)
Deferred: host.ts registration; CLAUDE.md/README inventory (both to batch integration)

Design: `docs/design/2026-06-22-decode-normalize.md` (slug `2026-06-22-decode-normalize`, status PASSED).

This is a **library + two guard modifications**, not a standalone activatable
extension. The new `src/extensions/lib/decode.ts` is consumed directly by the
already-registered `bash-policy` and `risk-guard`. Tests load those two guards
via `host.use(id, activate)` (the established offline pattern, e.g.
`test/risk-guard.test.ts`, `test/recovery.test.ts`) and MUST NOT depend on
anything being added to `BUILTIN_EXTENSIONS`.

**BATCH MODE — do NOT touch `src/host.ts`, `CLAUDE.md`, or `README.md`.**
Registration in `BUILTIN_EXTENSIONS` and any inventory/count line are deferred to
a separate batch-integration step. `bash-policy`/`risk-guard` are already in
`BUILTIN_EXTENSIONS`; this change only edits their bodies plus adds the lib and
its test. The only files you may create/modify are:
`src/extensions/lib/decode.ts`, `src/extensions/bash-policy.ts`,
`src/extensions/risk-guard.ts`, `test/decode-normalize.test.ts`,
`test/bash-policy.test.ts` (extend), `test/risk-guard.test.ts` (extend), and this
implementation doc. **Do NOT bump the README extension count** — no new extension
id is introduced.

## 1. Task Index

Maps each design Deliverable (§2) and Acceptance Criterion (§7) to a phase task.

| Design Deliverable (§2) | Design AC (§7) | Phase task |
|---|---|---|
| `src/extensions/lib/decode.ts` — `normalizeForInspection` + named decoders (`decodeBase64`, `decodeHex`, `decodeRot13`, idiom matchers), `DECODE_DEPTH = 2`, imports `stripInvisible`, never throws, D7 emit gate | AC1-AC7 (unit) | T2-T7 (tests), T9-T14 (impl) |
| `bash-policy.ts` (modified) — union `normalizeForInspection(command)` into `candidates` (each re-run through `expandCommands`), gated by `EAGENT_DECODE_NORMALIZE !== "off"` (D5, D6) | AC8, AC9, AC10 (live) | T15, T16 (tests), T17 (impl) |
| `risk-guard.ts` (modified) — in `classify`, prepend `[decoded payload: <candidate>]` lines computed from `JSON.stringify(call.arguments)`, gated by `EAGENT_DECODE_NORMALIZE !== "off"` (D5, D6) | AC11, AC12 (live) | T18, T19 (tests), T20 (impl) |
| `test/decode-normalize.test.ts` — offline unit + integration suite | AC1-AC12 | T1-T8, T15, T16, T18, T19 |
| Kill switch `EAGENT_DECODE_NORMALIZE=off` (D6) | AC9, AC12 | T16, T19 (tests), T17, T20 (impl) |
| host.ts registration | — | **(deferred to batch integration)** — no new `BUILTIN_EXTENSIONS` entry; lib is consumed by already-registered guards |
| CLAUDE.md / README inventory line | — | **(deferred to batch integration)** — do NOT bump the README count |
| Regression: existing `bash-policy.test.ts` + `risk-guard.test.ts` green | AC10, AC12 | T21 (full-suite gate) |

## 2. Phase Breakdown

This is a **single phase**. The lib, the two guard edits, and their tests are one
cohesive change: the guards cannot decode without the lib, and the lib is dead
code until at least one guard consumes it, so splitting would leave intermediate
states with unexercised code. They share one kill switch and one design.

### Phase 1 — decode-normalize lib + bash-policy/risk-guard wiring (single phase)

**Entry condition:** Design doc PASSED (it has). Prerequisite source present and
verified: `src/extensions/content-guard.ts` exports `stripInvisible`
(content-guard.ts:64); `src/extensions/bash-policy.ts` exports `expandCommands`
(451), `evaluateAny` (562), `extractCommand` (213), and its `beforeToolCall`
handler builds `candidates = expandCommands(command)` then `evaluateAny(...)`
(bash-policy.ts:610-611); `src/extensions/risk-guard.ts` `classify` assembles the
user message `Tool: ${call.name}\nArguments: ${JSON.stringify(call.arguments)}`
(risk-guard.ts:99-106). Offline harness `test/helpers.ts` (`makeHarness`,
`MockProvider`) available.

**Design references:** §2 (Deliverables), §4 D1-D7 (decisions — especially **D7**
the emit gate, **D4** the depth bound, **D5** per-guard consumption, **D6** the
kill switch), §5 (Dependencies/Assumptions — non-throwing `Buffer.from`), §7
(AC1-AC12). The **decode SUBJECT for risk-guard is the whole `JSON.stringify(call.arguments)`
blob**, not a per-value extraction (Deliverable 3, D5) — this is load-bearing for
AC11 and the AC11 negative-coverage assertion.

**Task list (TDD order — every TEST task names the BUSINESS INVARIANT it protects
and precedes the impl it protects):**

- **T1 (test, scaffold):** Create `test/decode-normalize.test.ts` importing
  `normalizeForInspection` (and the named decoders as needed) from
  `../src/extensions/lib/decode.js`, plus `makeHarness` / `Harness` from
  `./helpers.js`. Import `node:assert/strict` and `node:test`. File scaffolding;
  subsequent test tasks add cases. (Helpers do not exist yet, so this file will
  not compile/run until T9+; that is expected in TDD — the unit test tasks below
  are authored before the impl they protect.)

- **T2 (test):** Unit — invariant *"a base64-wrapped destructive payload delivered
  via the `echo <b64>|base64 -d|sh` idiom is surfaced as a decoded candidate"*
  (AC1). Assert `normalizeForInspection("echo cm0gLXJmIC8=|base64 -d|sh")`
  includes a string matching `/rm -rf \//`.

- **T3 (test):** Unit — invariant *"a hex-escaped payload via the `printf '\xNN'|sh`
  idiom is surfaced"* (AC2). Assert
  `normalizeForInspection("printf '\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x2f'|sh")`
  includes a string matching `/rm -rf \//`.

- **T4 (test):** Unit — invariant *"a rot13'd command whose first decoded token is
  a known command is surfaced"* (AC3). Assert `normalizeForInspection("ez -es /")`
  includes `"rm -rf /"` (verified: `rot13("ez -es /") === "rm -rf /"`). This pins
  the D7 emit gate's **known-command tier** for the total rot13 decoder — contrast
  T6.

- **T5 (test):** Unit — invariant *"invisible-Unicode-obfuscated payloads are
  stripped before matching"* (AC4). Construct a `rm -rf /` with zero-width / tag
  codepoints interleaved (via `String.fromCodePoint`, e.g. U+200B, U+E0041) and
  assert the output includes a candidate matching `/^rm -rf \//` — exercising the
  imported `stripInvisible` (D1) through the helper, not directly.

- **T6 (test):** Unit — invariant *"the emit gate (D7), not raw-exclusion, drops
  total-decoder garbage so benign input yields an empty, dedup-clean candidate set"*
  (AC5). Assert `normalizeForInspection("ls -la")` returns **exactly** `[]`
  (`assert.deepEqual(normalizeForInspection("ls -la"), [])`), NOT merely a set
  excluding the raw input — `rot13("ls -la") = "yf -yn"` is produced and is `!==`
  raw, but first token `yf` is not a known command so conjunct-2 drops it;
  base64/hex of `"ls -la"` yield invalid UTF-8 so conjunct-1 drops them. Also
  assert no duplicates on a case that does emit (e.g. `new Set(out).size === out.length`).

- **T7 (test):** Unit — invariant *"fail-open on silent-garbage: a non-throwing
  bad-base64 decode emits no command-looking candidate"* (AC6). Assert
  `normalizeForInspection("echo not-valid-base64!!! | base64 -d")` does not throw
  and produces no candidate matching a real command family. The rejection is by
  D7's valid-UTF-8 / round-trip conjunct (the decoded bytes carry U+FFFD), **not**
  by try/catch — `Buffer.from(s,"base64")` never throws (design §5).

- **T8 (test):** Unit — invariant *"decode depth is bounded at 2, so cleartext one
  layer beyond the bound is never reached"* (AC7). With
  `tripleWrapped = base64(base64(base64("rm -rf /")))`
  (`= "WTIwd1oweFlTbTFKUXpnOQ=="`):
  - Assert `!normalizeForInspection(tripleWrapped).some(c => /rm -rf \//.test(c))`
    (cleartext is one decode beyond `DECODE_DEPTH = 2`). This is the load-bearing
    boundary assertion and it is gate-independent: the inner `rm -rf /` is one
    layer past the bound, so no emitted candidate is cleartext regardless of which
    intermediate strings pass the gate.
  - Do **not** assert `deepEqual(normalizeForInspection(tripleWrapped), [])` — the
    set is *not* empty. The depth-1 intermediate is `Y20wZ0xYSm1JQzg9` (no `=`
    padding, valid UTF-8, round-trips, first token matches conjunct-2's
    `/^[\w./-]+$/`), so it passes the D7 gate and IS emitted as a harmless junk
    candidate. Only the *depth-2* intermediate `cm0gLXJmIC8=` is `=`-padded and
    gate-rejected; emptiness was never the boundary's behavior (design AC7).
  - Assert the **double-wrapped** form `base64(base64("rm -rf /"))` IS decoded to
    cleartext: its candidate set includes a string matching `/rm -rf \//` (depth 2
    reaches it). Build wrappers in-test with
    `Buffer.from(s).toString("base64")`.

- **T9 (impl):** Create `src/extensions/lib/decode.ts`. Implement and export the
  named total decoders, each pure / no deps, each wrapped in try/catch returning
  `undefined` only on an unexpected throw (the common bad-input case is handled by
  the gate, not the catch — design §5, D7):
  - `decodeBase64(s: string): string | undefined` — `Buffer.from(s, "base64").toString("utf8")`.
  - `decodeHex(s: string): string | undefined` — `Buffer.from(s, "hex").toString("utf8")`.
  - `decodeRot13(s: string): string` — pure char map over ASCII letters (total —
    always returns output).
  - `\xNN` hex-escape parser for the `printf` idiom payload.
  Export `DECODE_DEPTH = 2`. Import `stripInvisible` from `../content-guard.js`
  (D1 — reuse, do not reimplement the INVISIBLE regex).

- **T10 (impl):** Implement the **idiom matchers** (substring scanners, so they
  find a blob embedded inside a larger string — required for AC11): an
  `echo <b64>|base64 -d|sh` matcher that extracts the base64 token and decodes it,
  and a `printf '\xNN…'` matcher that extracts the escape sequence and decodes it.
  These feed their inner payload through the same D7 emit gate (T12).

- **T11 (impl):** Implement the embedded/whole-string base64 and hex decode
  attempts (scan for plausible base64/hex tokens), and the rot13 whole-string
  attempt over the first token's command line.

- **T12 (impl):** Implement the **D7 emit gate** as a single function applied in
  `normalizeForInspection` to every produced candidate, with two conjuncts:
  1. **Valid-UTF-8 / round-trip** — for byte-decoders (base64, hex, `\xNN`), the
     decoded string must round-trip on re-encode and contain no U+FFFD
     replacement char. rot13 is already valid UTF-8 (permutes ASCII only) so it
     passes conjunct 1 and is gated solely by conjunct 2.
  2. **Command-plausibility** — candidate must differ from raw input AND its first
     whitespace-delimited token must be a syntactically valid command word
     (`/^[\w./-]+$/`, no U+FFFD). For **reversible-alphabet decoders (rot13)**
     strengthen this to require a **known command family**: the first token must be
     in a bundled `KNOWN_COMMAND` token set (`rm`, `sh`, `bash`, `curl`, `wget`,
     `dd`, `chmod`, `eval`, `nc`, …) — `"yf"` is not known so `rot13("ls -la")`
     emits nothing (T6); `"rm"` is known so `rot13("ez -es /")` emits (T4). Keep
     the gate in ONE place (do not push it into each decoder — D7 rejects option (b)).

- **T13 (impl):** Implement `normalizeForInspection(text: string): string[]`: run
  `stripInvisible` first and keep `text`; apply all decoders + idiom matchers up to
  `DECODE_DEPTH = 2` (re-feed the **raw decoded bytes** of each decode for one more
  layer — the T12 gate decides what to *emit*, not what to *recurse on*, so a
  `=`-padded intermediate that the gate suppresses is still traversed; bounded — no
  fixpoint, D4); push each candidate that passes the T12 gate; return the
  raw-excluded, **deduped** list (`new Set` dedup). Never throws (fail-open). No
  capability (D3 — only-expand, never a verdict; no side effects).

- **T14 (verify lib):** Run the unit suite; T2-T8 must pass.
  - Acceptance: `node --import tsx --test test/decode-normalize.test.ts` passes the
    unit cases; `npm run typecheck` exit 0.

- **T15 (test):** Live — invariant *"bash-policy in deny mode blocks an obfuscated
  `rm -rf /` that the literal `rm *` rule would miss"* (AC8). In
  `test/decode-normalize.test.ts` (and a parallel case extending
  `test/bash-policy.test.ts`), reuse the `shellTool(agent)` / `sawBlock(agent)`
  pattern from `test/bash-policy.test.ts:173-195`: load bash-policy via
  `h.host.use("bash-policy", e => { e.store.set("rules", [{ pattern: "rm *", action: "deny" }]); return bashPolicy(e); })`,
  drive a tool call `{ command: "echo cm0gLXJmIC8=|base64 -d|sh" }`, assert
  `didRun() === false` and `sawBlock(h.agent) === true` (model sees a `bash-policy:`
  block reason). Add a `printf '\xNN'` variant likewise.

- **T16 (test):** Live — invariant *"the kill switch restores literal-only matching:
  with `EAGENT_DECODE_NORMALIZE=off` the same obfuscated call RUNS, proving the
  decode layer is what caught it"* (AC9). Save/restore `process.env.EAGENT_DECODE_NORMALIZE`
  in `try/finally` (mirror `test/bash-policy.test.ts:691-708`): set it to `"off"`,
  drive the same `echo …|base64 -d|sh` deny-rule call, assert `didRun() === true`
  and `sawBlock === false`.

- **T17 (impl):** Modify `src/extensions/bash-policy.ts` `beforeToolCall` handler
  (after `const candidates = expandCommands(command)`, bash-policy.ts:610): when
  `process.env.EAGENT_DECODE_NORMALIZE !== "off"`, for each string from
  `normalizeForInspection(command)` run it through `expandCommands` and append the
  new (deduped) strings to `candidates` before `evaluateAny(candidates, rules, fallthrough)`
  (611). Off → `candidates` is exactly `expandCommands(command)` (byte-identical to
  today). Import `normalizeForInspection` from `./lib/decode.js`. Read the kill
  switch in the existing `cfg()` reader (alongside `EAGENT_BASH_POLICY`, D6) or
  inline at the union site — keep it one read. Do NOT change `evaluateAny`,
  `expandCommands`, or the verdict/label logic.

- **T18 (test):** Live — invariant *"risk-guard's judge prompt is annotated with
  the decoded payload when an argument is obfuscated, and a rot13'd-in-arg payload
  is NOT surfaced (the documented bash-policy asymmetry)"* (AC11). Extend
  `test/risk-guard.test.ts` (and/or add to `test/decode-normalize.test.ts`) using
  the `Classifier extends MockProvider` capture pattern (`test/risk-guard.test.ts:53-63`):
  the classifier's `stream` receives the user message; capture `req.messages` and
  assert the user-text contains `"[decoded payload:"` and the decoded `rm -rf /`
  for a call `{ cmd: "echo cm0gLXJmIC8=|base64 -d|sh" }` (the embedded
  `cm0gLXJmIC8=` is found by the substring idiom/base64 matcher inside the JSON
  blob). **Negative-coverage assertion:** for `{ cmd: "ez -es /" }` (a rot13'd
  arg), assert the user-text contains **no** `[decoded payload:` line — the
  whole-string rot13/known-command gate sees the JSON wrapper token `{"cmd":"ez` as
  the first token, which is not a known command (Deliverable 3, D5). Use
  `activate(h, { enabled: true, mode: ... })` (`test/risk-guard.test.ts:32-42`).

- **T19 (test):** Live — invariant *"with `EAGENT_DECODE_NORMALIZE=off` the
  risk-guard prompt is unchanged (no `[decoded payload:` line)"* (AC12).
  Save/restore the env var in `try/finally`; set `"off"`; capture the classifier's
  user message for `{ cmd: "echo cm0gLXJmIC8=|base64 -d|sh" }` and assert it
  contains no `[decoded payload:`.

- **T20 (impl):** Modify `src/extensions/risk-guard.ts` `classify`
  (risk-guard.ts:99-106): when `process.env.EAGENT_DECODE_NORMALIZE !== "off"`,
  compute `normalizeForInspection(JSON.stringify(call.arguments))` (the **whole
  arguments blob** — risk-guard has no `commandArgKey`, design D5), and for each
  candidate that differs from that raw blob, prepend a single
  `[decoded payload: <candidate>]` line to the classifier user message text. Off →
  the user message is byte-identical to today. Import `normalizeForInspection` from
  `./lib/decode.js`. Do NOT change the system prompt, `parseVerdict`, the
  `tools: []` recursion-safe sub-call shape, or the fail-open path.

- **T21 (verify full):** Run the whole offline suite and typecheck.
  - Acceptance: `node --import tsx --test test/decode-normalize.test.ts` passes;
    `npm run typecheck` exit 0; `npm test` exit 0 (AC10, AC12 regression — existing
    `bash-policy.test.ts` and `risk-guard.test.ts` stay green; AC10's benign
    `git status && rm -rf build` case continues to behave as the existing
    bash-policy tests assert).

**Per-task acceptance commands (runnable from repo root):**
- After T9-T13 (lib impl): `node --import tsx --test test/decode-normalize.test.ts`
  passes the unit cases (T2-T8); `npm run typecheck` exit 0.
- After T17 (bash-policy wiring): `node --import tsx --test test/bash-policy.test.ts`
  green; `node --import tsx --test test/decode-normalize.test.ts` passes the
  bash-policy live cases (T15/T16).
- After T20 (risk-guard wiring): `node --import tsx --test test/risk-guard.test.ts`
  green; `node --import tsx --test test/decode-normalize.test.ts` passes the
  risk-guard live cases (T18/T19).
- Phase exit: `npm run typecheck` exit 0 AND `npm test` exit 0.

**Exit condition:** `test/decode-normalize.test.ts` green;
`node --import tsx --test test/decode-normalize.test.ts` passes; `npm run typecheck`
exit 0; `npm test` exit 0 (full suite — existing `bash-policy.test.ts` and
`risk-guard.test.ts` unchanged-and-green); `src/host.ts`, `CLAUDE.md`, `README.md`
untouched.

## 3. Engineering Constraints Index

- **House conventions (`CLAUDE.md`):** ESM with `.js` import specifiers even when
  importing a `.ts` file (e.g. `import { stripInvisible } from "../content-guard.js"`,
  `import { normalizeForInspection } from "./lib/decode.js"`). Strict TypeScript
  (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`) — no `any`, model the types. **Zero runtime deps
  except `jiti`** — pure Node only (`Buffer.from`, string/regex); add no npm deps.
  The lib has no side effects so it declares **no capability** (consistent with
  `content-guard`, `recovery`, `prune` — D3). Kill-switch env var
  `EAGENT_DECODE_NORMALIZE=off`. The dispose loops in `bash-policy`/`risk-guard`
  must continue to never throw (you are not adding new disposers; do not break the
  existing teardown).
- **Decoders never throw:** each decoder is try/caught (fail-open returns
  `undefined`), but the common bad-input case is rejected by the D7 emit gate, not
  the catch (design §5).
- **Offline tests only (`node:test` via `tsx`):** the lib is pure; bash-policy
  integration uses no provider; risk-guard integration uses the scriptable
  `MockProvider` (`test/helpers.ts` `makeHarness`). No network, no API key.
- **Commit conventions:** `feat(phase1): …` opener; within-round fixes
  `fix(phase1-roundR): <keyword>`. Record `npm test` and `npm run typecheck`
  results as commit trailers. **No mention of AI / model / tooling** in commit
  messages. Branch first if on the default branch; commit/push only when asked.

## 4. Data and Fixture Dependencies

- **Reuse `test/helpers.ts`** — `makeHarness` (agent + `MockProvider` + extension
  host), `Harness` type, `silentLogger`, `autoUI`. No new fixtures.
- **bash-policy live harness:** reuse the `shellTool(agent, name?)` (registers a
  `shell:exec` tool flipping a `ran` flag) and `sawBlock(agent)` helpers from
  `test/bash-policy.test.ts:173-195`; load bash-policy via
  `h.host.use("bash-policy", activateFn)` seeding `rules` in `e.store.set` before
  returning `bashPolicy(e)` (pattern at `test/bash-policy.test.ts:215-219`).
- **risk-guard live harness:** reuse the `Classifier extends MockProvider`
  prompt-capture pattern and the `activate(h, cfg)` helper from
  `test/risk-guard.test.ts:32-63`; drive the hook via the harness/`applyHook`
  pattern (`test/risk-guard.test.ts:96-99`) or a full `agent.run`. Capture
  `req.messages` inside the overridden `stream` to inspect the user-message text.
- **Obfuscated payloads:** build base64 wrappers in-test with
  `Buffer.from(s).toString("base64")` (so the depth/dedup fixtures are
  self-documenting); the canonical single-base64 of `rm -rf /` is `cm0gLXJmIC8=`.
  Invisible-Unicode strings via `String.fromCodePoint` (mirror
  `test/content-guard.test.ts`).
- **Env-var fixtures:** save/restore `process.env.EAGENT_DECODE_NORMALIZE` in
  `try/finally` (mirror `test/bash-policy.test.ts:691-708`).

## 5. Regression Protection (which prior tests must stay green)

- **`test/bash-policy.test.ts`** — MUST stay green unchanged. The decode union only
  **adds** candidates to `evaluateAny`; with the kill switch on (default) and no
  decode differing from raw, the candidate set is identical to today, so existing
  no-op / deny / ask / wrapper-unwrap / compound-command cases are unaffected. AC10
  specifically: a benign `git status && rm -rf build` must behave exactly as the
  existing tests assert (decode adds no spurious block on non-encoded input).
- **`test/risk-guard.test.ts`** — MUST stay green unchanged. The annotation only
  **prepends** a line when a decode differs from the raw blob; with the kill switch
  on and no obfuscation, the classifier user message is byte-identical, so
  `parseVerdict`, block/ask, fail-open, out-of-scope, and disabled cases are
  unaffected (AC12).
- **`test/content-guard.test.ts`** — MUST stay green. `decode.ts` imports
  `stripInvisible` but does not modify `content-guard.ts`; the export contract is
  unchanged (a missing export would be a `npm run typecheck` failure).
- **Whole suite + typecheck:** `npm test` exit 0 and `npm run typecheck` exit 0 are
  hard gates (recorded as commit trailers). Strict mode means the new
  `decode.ts` must not introduce `any` or unchecked index access.
