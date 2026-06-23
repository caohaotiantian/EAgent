# Design: `decode-normalize` — pre-inspection decode/normalize feeding `bash-policy` and `risk-guard`

Slug: `2026-06-22-decode-normalize`
Status: closed
Closing-commit: c7bfcaa
Closed-on: 2026-06-22
Deferred: finding — risk-guard rot13-in-JSON-arg decode asymmetry (documented D5 scope limitation; bash-policy covers rot13; base64/hex/idiom payloads covered for both)

## 1. Background and Purpose

EAgent's two command-inspecting guards both operate on **literal text only**:

- `bash-policy` (`src/extensions/bash-policy.ts`) reduces a shell command line to
  the candidate set its rules judge — the whole line plus each segment, each
  unwrapped inner program, and each `find -exec` command (`expandCommands`,
  bash-policy.ts:451-469) — then matches an allow/deny/ask ruleset over those
  candidates with `evaluateAny` (bash-policy.ts:562-577). Every candidate is
  produced by lexical splitting/normalization of the *raw* string; nothing
  decodes encoded payloads.
- `risk-guard` (`src/extensions/risk-guard.ts`) sends the raw call to an LLM
  judge. Its classifier prompt is assembled verbatim from the call name and
  `JSON.stringify(call.arguments)` (risk-guard.ts:99-106), so the model reasons
  over whatever literal bytes the call carries.

This is exploitable. An attacker hides a destructive command inside a benign-
looking wrapper so the **visible token is harmless**:

- `echo cm0gLXJmIC8=|base64 -d|sh` — the visible programs are `echo`/`base64`/`sh`;
  the base64 blob decodes to `rm -rf /`. A `rm *` deny rule in bash-policy never
  fires because no expanded candidate contains the string `rm`.
- `printf '\x72\x6d\x20\x2d\x72\x66\x20\x2f'|sh` — the hex escapes spell `rm -rf /`;
  the literal candidates contain only `printf`/`sh`.
- A rot13'd or zero-width / Unicode-tag-obfuscated command — the deny pattern
  matches none of the visible bytes, and the risk-guard judge reasons over an
  opaque blob it cannot interpret.

Verified by reading both files: `bash-policy.ts` and `risk-guard.ts` contain
**zero** decode or normalization logic. The only Unicode-stripping primitive in
the tree lives in `content-guard.ts` (`stripInvisible`, content-guard.ts:64-71),
and neither guard imports it.

**Purpose.** Add a thin, shared **pre-inspection decode layer**: a zero-dep
helper `normalizeForInspection(text): string[]` that returns a set of decoded
candidate strings (strip-invisible + best-effort base64/hex/rot13 and the
`echo <b64>|base64 -d|sh` / `printf '\xNN'` shell idioms). `bash-policy` unions
those candidates into the set its existing rules already judge; `risk-guard`
prepends a `[decoded payload: ...]` note to its judge prompt when a decode
differs from the raw text. The helper **never blocks and never mutates the
command** — it only widens the candidate set the *existing* allow/deny/ask and
LLM machinery evaluates. A decode error yields no extra candidate (fail-open).
`EAGENT_DECODE_NORMALIZE=off` restores literal-only matching in both guards.

What happens if we do not build it: trivially-obfuscated destructive or
exfiltrating commands slip past both guards because their visible tokens are
benign and their real payload is never decoded.

## 2. Deliverables

- [ ] `src/extensions/lib/decode.ts` — the shared helper module exporting
      `normalizeForInspection(text: string): string[]` (returns gated,
      raw-excluded, deduped decoded candidates) plus the small named decoders it
      composes (`decodeBase64`, `decodeHex`, `decodeRot13`, idiom matchers),
      bounded to `DECODE_DEPTH = 2`. Imports `stripInvisible` from
      `../content-guard.js`. Pure Node, no capability, never throws (each decoder
      is try/caught and returns `undefined` on failure). The decoders are
      **total** (rot13 always produces output; `Buffer.from(s,"base64"|"hex")`
      never throws on bad input — it silently yields garbage bytes), so try/catch
      alone does **not** reject the common bad-input case. `normalizeForInspection`
      therefore applies an explicit **emit gate** (D7) to every candidate before
      returning it: a candidate is kept only if it (a) decodes to valid UTF-8
      (the round-trip `Buffer.from(s,enc).toString("utf8")` contains no U+FFFD
      replacement char), and (b) is *command-plausible* — it differs from the raw
      input and looks like a shell command rather than arbitrary text (matches a
      conservative shell-token heuristic, see D7). A decoder that yields invalid
      UTF-8 or a non-plausible decode returns no candidate. This gate is what
      makes rot13 (total) and base64 (silent-garbage) safe to compose.
- [ ] `src/extensions/bash-policy.ts` (modified) — in the `beforeToolCall`
      handler, when `EAGENT_DECODE_NORMALIZE !== "off"`, union
      `normalizeForInspection(command)` into the `candidates` array fed to
      `evaluateAny` (after `expandCommands`, before the ruleset eval at
      bash-policy.ts:610-611), each decoded string itself run through
      `expandCommands` so a decoded `rm -rf /` is normalized/segmented like any
      command line. Off → literal-only (`expandCommands(command)` unchanged).
- [ ] `src/extensions/risk-guard.ts` (modified) — in `classify`, when
      `EAGENT_DECODE_NORMALIZE !== "off"`, compute decoded candidates for the
      arguments and, for any that differ from the raw text, prepend a single
      `[decoded payload: <candidate>]` line to the classifier's user message
      (risk-guard.ts:99-106). Off → raw prompt unchanged. **Decode SUBJECT (must
      be pinned — risk-guard has no `commandArgKey`):** risk-guard stringifies the
      *whole* arguments object — the classifier text is
      `Tool: ${call.name}\nArguments: ${JSON.stringify(call.arguments)}`
      (risk-guard.ts:103). The decode layer feeds `normalizeForInspection` the
      **same `JSON.stringify(call.arguments)` blob** (JSON wrapper and all, e.g.
      `{"cmd":"echo cm0gLXJmIC8=|base64 -d|sh"}`), *not* a per-value extraction.
      This is deliberate: the idiom/base64 matchers scan the whole string and still
      find `cm0gLXJmIC8=` inside the JSON, so AC-11 is achievable. **Documented
      coverage consequence (asymmetry vs bash-policy):** for a *whole-string* (non-
      idiom) decode attempt — rot13 or the known-command gate — the first
      whitespace token of the JSON blob is a wrapper fragment like `{"cmd":"echo`,
      which is never a known command, so a rot13'd payload sitting inside a
      risk-guard argument is NOT surfaced (the gate drops it), whereas bash-policy
      decodes a clean command line and would surface it. We accept this gap rather
      than add a `commandArgKey`/per-value extraction (out of scope — that is new
      structure on risk-guard's call shape, D5); the idiom and embedded-base64
      cases, which the threat model lists, are still covered because their matchers
      are substring scanners. (If per-value coverage is later wanted it is a
      follow-up that gives risk-guard a key map, not part of this change.)
- [ ] `test/decode-normalize.test.ts` — offline `node:test` suite: unit tests of
      `normalizeForInspection` (each encoding, depth bound, fail-open, raw
      exclusion, dedup), plus integration tests loading bash-policy and
      risk-guard directly via `host.use(id, activate)` (per `test/recovery.test.ts`
      and `test/risk-guard.test.ts`) with a MockProvider — NOT depending on the
      extensions being in `BUILTIN_EXTENSIONS`.
- [ ] Kill switch `EAGENT_DECODE_NORMALIZE=off` — read in both guards' config
      readers; when off, both fall back to literal-only behavior (asserted by a
      test).
- [ ] `host.ts` registration in `BUILTIN_EXTENSIONS` — **(deferred to batch
      integration)**. Note: `decode-normalize` is a *library + two guard
      modifications*, not a standalone activatable extension; the lib is consumed
      directly by `bash-policy`/`risk-guard`, which are already registered. No new
      `BUILTIN_EXTENSIONS` entry is required — to be confirmed at batch
      integration.
- [ ] CLAUDE.md / README inventory line — **(deferred to batch integration)**;
      reconciled at closeout. Do NOT bump the README extension count in this
      change (no new extension id is added; this is a shared decode layer behind
      `bash-policy`/`risk-guard`).

## 3. Scope Boundary (NON-goals — Simplicity First)

- **NOT a new verdict / new guard.** The helper never decides allow/deny/ask and
  never calls the model. It only expands inputs; `bash-policy`'s ruleset and
  `risk-guard`'s judge make every decision exactly as before.
- **NOT a command rewriter.** The raw command line passed to the underlying tool
  is never mutated; only the *inspection* candidate set / judge prompt is widened.
- **NOT a complete deobfuscator.** Only the documented real-world idioms are
  covered: base64, hex, rot13, `echo <b64>|base64 -d|sh`, `printf '\xNN'`. No
  gzip/zlib, no URL-encoding, no XOR/custom ciphers, no JS/Python `eval`
  unrolling, no arbitrary nested-shell evaluation. (See D2.)
- **NOT a sandbox or executor.** Decoding is pure string transformation; nothing
  is run, spawned, or `eval`'d.
- **NOT unbounded recursion.** Decode depth is capped at 2 (D4); pathological
  nested-encode inputs do not cause blow-up.
- **NOT a re-implementation of `stripInvisible`.** The invisible-Unicode pass is
  imported from `content-guard.ts`, not duplicated (D1).
- **NOT a new capability.** The helper has no side effects, so it is not
  capability-gated (consistent with `content-guard`, `recovery`, `prune`).

## 4. Key Design Decisions

### D1 — Strip invisible Unicode: reuse `content-guard`'s `stripInvisible` vs reimplement

**Problem.** Unicode-tag / zero-width / bidi obfuscation must be stripped before
matching, and `content-guard.ts` already owns exactly that primitive.

**Options.** (a) Import `stripInvisible` from `../content-guard.js`. (b)
Reimplement the invisible-codepoint regex locally in `decode.ts`.

**Choice: (a) reuse.** `stripInvisible` is already `export`ed (content-guard.ts:64)
and is pure (`{ text, stripped }` over the documented invisible categories,
content-guard.ts:56-71). `decode.ts` calls it and keeps `text`.

**Why (b) rejected.** Duplicating the INVISIBLE regex means two definitions of
"which codepoints are invisible" that can drift — a maintenance and correctness
hazard for a security primitive. The synthesis explicitly wanted the two surfaces
to **share** the strip primitive. Reuse is strictly less code and one source of
truth.

### D2 — Encoding coverage: focused set vs a larger deobfuscator

**Problem.** Which obfuscations to decode? Too few misses real attacks; too many
balloons the code, the false-candidate rate, and the maintenance surface.

**Options.** (a) The focused set: base64, hex, rot13, `echo <b64>|base64 -d|sh`,
`printf '\xNN'`. (b) A broad deobfuscator: also gzip/zlib, URL-encoding, octal,
HTML entities, XOR, `eval`/`$(...)` unrolling, custom alphabets.

**Choice: (a) the focused set.** These are precisely the documented real-world
shell-obfuscation idioms in the threat model (the four PROBLEM examples map 1:1).
Each is a small, total, pure decoder — and because each is *total* (it produces
output even for non-encoded input), `normalizeForInspection` is responsible for
deciding which decodes to *emit*, via the explicit emit gate in D7.

**Why (b) rejected.** Most of the broad set is rare-in-the-wild and each adds a
nontrivial decoder plus a false-candidate vector (e.g. any path that looks like
URL-encoding or octal would mis-decode benign args constantly). Decoders like
`eval`/`$(...)` unrolling approach "interpret arbitrary shell", which is exactly
the sandbox/executor we ruled out (Scope). Simplicity-First: cover the named
threats, stop there; a novel encoding is a follow-up extension, not speculative
code now. Missing a novel encoding is a *false negative* the existing guards
already had — this change strictly improves coverage and never regresses it.

### D3 — Helper authority: only-expand-candidates vs the helper itself making a verdict

**Problem.** Where does the decoded payload's authority live? If the helper can
itself block, a mis-decode becomes a false **block**.

**Options.** (a) The helper only **expands** the candidate set / annotates the
prompt; the existing rules and LLM judge decide. (b) The helper inspects its own
decodes and can directly block/flag.

**Choice: (a) only-expand.** A mis-decode adds one benign candidate string that
the *real* rules judge; if no rule matches it (and none will, for benign
content), nothing happens. The helper can never, by construction, produce a
verdict.

**Why (b) rejected.** Self-verdicting concentrates the blast radius of every
decode bug into a false block — the worst failure mode for a guard that sits in
front of legitimate work. Option (a) bounds the false-positive blast radius to
"an extra candidate the allow/deny/ask machinery evaluates", which for benign
content is a no-op, and for the deny rules is exactly the win we want. It also
keeps `decode.ts` free of any policy/state, so it stays a pure library.

### D4 — Decode depth bound (THRESHOLD)

**Problem.** Nested encodings (base64 of base64 of …) could drive unbounded
re-decoding and pathological CPU/memory on adversarial input.

**Options.** depth 1 (decode once); **depth 2**; unbounded (fixpoint).

**Choice: depth 2 (`DECODE_DEPTH = 2`).** Depth 1 catches the single-layer
threat-model idioms; depth 2 additionally catches one extra wrapping layer
(e.g. base64 wrapping a hex payload) — the realistic ceiling for hand-rolled
shell obfuscation — while keeping the candidate count and work bounded by a small
constant.

**Why the alternatives rejected.** Depth 1 is one decode short of the common
double-wrap and would miss `base64(hex(rm -rf /))`. Unbounded/fixpoint invites a
decode bomb: a crafted string that re-decodes into another decodable string
forever, exhausting CPU/memory inside a `beforeToolCall` filter — a DoS on the
guard. A small constant bound is the standard fail-safe; 2 is the minimum that
covers double-wrap. This is a behavioral threshold, justified above.

### D5 — Module location and how the two guards consume it

**Problem.** Where does the helper live, and how do two different guards (a
lexical matcher and an LLM judge) each ingest the decoded set?

**Options for location.** (a) `src/extensions/lib/decode.ts` (a shared lib
subdir). (b) Inline-duplicated in both guards. (c) Exported from `content-guard.ts`.

**Choice: (a) `src/extensions/lib/decode.ts`.** A single shared module both
guards import; new `lib/` subdir is the lowest-ceremony home for a cross-extension
helper.

**Why (b)/(c) rejected.** (b) duplicates the decoders across two files — the same
drift hazard as D1, doubled. (c) overloads `content-guard` (an ingress-fencing
extension) with shell-decoder responsibilities unrelated to its purpose; the only
thing we want *from* `content-guard` is `stripInvisible`, which we import.

**Consumption (per-guard, distinct because the two guards judge differently):**
- `bash-policy` — **candidate-set union.** After `expandCommands(command)`
  (bash-policy.ts:610), for each decoded candidate run it through `expandCommands`
  too and append the new strings, then `evaluateAny(candidates, …)`
  (bash-policy.ts:611) over the union. This reuses the exact `evaluateAny`
  last-match-wins machinery; a decoded `rm -rf /` is matched/labeled like any
  inner sub-command.
- `risk-guard` — **judge-prompt annotation.** The LLM already reads semantics, so
  it needs the *decoded text shown to it*, not a candidate list. The decode
  SUBJECT is the whole-arguments JSON blob `JSON.stringify(call.arguments)`
  (risk-guard.ts:103) — risk-guard has **no `commandArgKey`**, so there is no clean
  per-value command line to extract; `normalizeForInspection` scans the full
  stringified-arguments string (JSON wrapper included). For each decoded candidate
  that differs from that raw blob, prepend a `[decoded payload: <candidate>]` line
  to the classifier user message (risk-guard.ts:99-106). The verdict protocol
  (`parseVerdict`) is unchanged. **Coverage note:** the substring-scanning idiom /
  embedded-base64 matchers still find blobs inside the JSON (AC-11), but the
  whole-string rot13/known-command gate sees the JSON wrapper token (`{"cmd":"…`)
  as the first token and therefore does not surface rot13'd args here — a deliberate
  asymmetry vs the clean command line bash-policy decodes (see Deliverable 3).

A single decision (which surface gets union vs annotation) is justified by the two
guards being structurally different consumers; this is not a single-option choice.

### D6 — Kill switch `EAGENT_DECODE_NORMALIZE=off`

**Problem.** Operators need an instant disable that reverts to the prior,
literal-only behavior of both guards.

**Options.** (a) One shared env var read in both guards. (b) Per-guard env vars.
(c) No kill switch.

**Choice: (a) `EAGENT_DECODE_NORMALIZE=off`.** One env var, checked in each
guard's config reader, that toggles the decode union/annotation. Off → both
guards behave byte-identically to today (literal-only). This mirrors the project
convention (`EAGENT_CONTENT_GUARD`, `EAGENT_BASH_POLICY`, `EAGENT_RISK_GUARD`,
`EAGENT_RECOVERY`).

**Why rejected.** (b) two switches for one feature is needless surface — the
decode layer is conceptually one thing. (c) violates the house rule that every
behavior-changing extension ships a kill switch and is non-negotiable for a
security-path change.

### D7 — Emit gate: total decoders vs an empty/garbage-free candidate set

**Problem.** The composed decoders are **total**, not partial: rot13 produces
output for *any* input (`rot13("ls -la") = "yf -yn"`), and
`Buffer.from(s,"base64")` / `Buffer.from(s,"hex")` never throw on invalid input
— they silently yield garbage bytes (verified: `Buffer.from("build","base64")`
decodes to invalid-UTF-8 replacement chars, no throw). So a try/catch alone
rejects *nothing* in the case that actually matters. Without an explicit filter,
`normalizeForInspection("ls -la")` would emit at least `["yf -yn"]` (the rot13
decode, which is raw-excluded but still non-empty), and base64-garbage would emit
a junk candidate. We need a rule for *when a total decoder is allowed to emit*.

**Options.** (a) **Emit gate** — each decoder runs unconditionally, but
`normalizeForInspection` keeps a candidate only if it passes a per-candidate
validity + plausibility check. (b) Make each decoder self-gate internally (return
`undefined` unless its own output looks plausible). (c) No gate — emit every
decode and rely on D3 (downstream rules ignore benign candidates).

**Choice: (a) the emit gate**, a single check applied in `normalizeForInspection`
to every produced candidate, with two conjuncts:

1. **Valid-UTF-8 / round-trip check.** For byte-decoders (base64, hex, `\xNN`),
   re-encode the decoded string and require it to round-trip, and require the
   decoded text to contain no U+FFFD replacement char. `Buffer.from("build",
   "base64").toString("utf8")` fails this (it contains U+FFFD), so the garbage
   candidate is dropped — this is what AC-6 depends on. rot13 is already valid
   UTF-8 (it only permutes ASCII letters), so it passes conjunct 1 and is gated
   solely by conjunct 2.
2. **Command-plausibility check.** Keep a candidate only if it differs from the
   raw input *and* its first whitespace-delimited token is a syntactically valid
   command word (`/^[\w./-]+$/`, no U+FFFD). The strength of this conjunct is
   tiered by *how reversible* the decoder is:
   - **Byte-decoders (base64, hex, `\xNN`)** are already strongly gated by
     conjunct 1 (random bytes almost never round-trip to clean UTF-8 with a valid
     command word), so the syntactic command-word check suffices.
   - **Reversible-alphabet decoders (rot13)** decode *any* ASCII text to other
     valid UTF-8 with a plausible-looking first token, so the syntactic check is
     too weak — `rot13("ls -la") = "yf -yn"` has first token `"yf"`, which is a
     syntactically valid command word and would be kept. **For these decoders the
     gate therefore strengthens conjunct 2 to require a *known command family*:**
     the first token, run through bash-policy's family logic, must be a recognized
     program (or, in the helper's standalone form, must be in the bundled
     `KNOWN_COMMAND` token set: `rm`, `sh`, `bash`, `curl`, `wget`, `dd`, `chmod`,
     `eval`, `nc`, …). `"yf"` is not a known command, so `rot13("ls -la")` emits
     nothing and `normalizeForInspection("ls -la") === []` (AC-5);
     `rot13("ez -es /") = "rm -rf /"` has known-command first token `rm`, so it
     *is* emitted (AC-3).

In short: conjunct 1 (valid UTF-8) does most of the work for byte-decoders
(base64/hex/`\xNN`); the known-command tier of conjunct 2 does the work for the
always-total alphabet permutation (rot13). The idiom matchers
(`echo <b64>|base64 -d|sh`, `printf '\xNN'`) decode their inner payload through
the same gate.

**Why (b)/(c) rejected.** (b) pushes the same heuristic into each decoder,
duplicating the U+FFFD/known-command logic across `decodeRot13`/`decodeBase64`/…
— the drift hazard of D1/D5 again; the gate is one concept and belongs in one
place. (c) leaves `normalizeForInspection("ls -la")` returning `["yf -yn"]` and
the base64 of any benign arg returning replacement-char junk. While D3 bounds the
*blast radius* (a garbage candidate matches no deny rule, so it is a downstream
no-op), an ungated set still violates AC-5/AC-6 and needlessly inflates the
candidate count fed to `evaluateAny` and the risk-guard prompt on every call.
The gate is cheap (string ops on a bounded set) and keeps the emitted set tight.
This is a behavioral decision (the plausibility/known-command boundary); the
heuristic is intentionally conservative — it errs toward *not* emitting, so a
missed obfuscation is a false negative the guards already had (D2), never a false
block (D3).

## 5. Dependencies and Assumptions

- **Imports `stripInvisible` from `src/extensions/content-guard.ts`** (the
  exported pure function, content-guard.ts:64). Assumes `content-guard.ts` stays
  present and keeps exporting it — both true today; a missing export is a compile
  error caught by `npm run typecheck`.
- **Modifies `bash-policy.ts`'s `beforeToolCall` handler** (bash-policy.ts:595-627),
  reusing `expandCommands` (451) and `evaluateAny` (562). Assumes the candidate
  array fed to `evaluateAny` (610-611) remains the single inspection input — true.
- **Modifies `risk-guard.ts`'s `classify`** (risk-guard.ts:95-121), specifically
  the user-message assembly (99-106). Assumes the recursion-safe `tools: []`
  sub-call shape is unchanged — true.
- **Zero runtime dependencies** beyond Node built-ins: base64 via
  `Buffer.from(s, "base64")`, hex via `Buffer.from(s, "hex")` / manual `\xNN`
  parse, rot13 via a pure char map. No new npm deps (house rule). **Note these
  primitives are non-throwing on bad input:** `Buffer.from(s, "base64"|"hex")`
  silently yields garbage bytes for non-encoded strings rather than raising, so
  the "fail-open returns `undefined`" contract is enforced by D7's explicit
  valid-UTF-8 / round-trip emit gate, **not** by try/catch (which only guards the
  unexpected-throw case).
- **Offline-testable:** the helper is pure; bash-policy integration uses no
  provider; risk-guard integration uses the scriptable `MockProvider`
  (`test/helpers.ts` `makeHarness`).
- **Assumption — decoded bytes are best-effort, not authoritative.** A decode is
  only ever an *extra* candidate / annotation; correctness of the security
  decision still rests entirely on the existing rules and judge (D3).

## 6. Relationship with Existing Designs

This is the **pre-inspection decode layer** that makes the existing guards' rules
see the real payload. It adds no new verdict — only better inputs.

- **`content-guard.ts`** (closest, shared primitive) — exports `stripInvisible`
  (content-guard.ts:64), which this **imports** for the invisible-Unicode pass.
  Partial overlap with content-guard's Unicode handling is resolved by *sharing*
  the one primitive rather than duplicating it (D1). No conflict: content-guard
  fences *foreign tool results* on `afterToolCall`; decode-normalize feeds
  *command inspection* on `beforeToolCall`. Disjoint seams, disjoint purpose.
- **`bash-policy.ts`** — this extends its candidate/sub-command expansion
  (`expandCommands`, 451) and reuses `evaluateAny` (562). bash-policy splits
  sub-commands and matches families on **literal** text (verified: no decode).
  decode-normalize widens the candidate set feeding its *existing* ruleset. No
  conflict; the no-rules no-op and kill-switch fall-throughs are preserved.
- **`risk-guard.ts`** — this annotates its judge-prompt assembly
  (risk-guard.ts:99-106). risk-guard judges semantics over the **literal**
  stringified call (verified: no decode). decode-normalize prepends decoded
  payloads so the judge sees the real command. No conflict; the verdict protocol
  and fail-open path are untouched.

**Dedup note (verified):** bash-policy splits sub-commands; risk-guard judges
semantics; both operate on literal text with zero decode. This change is the one
missing piece — decode — shared by both, reusing content-guard's strip-invisibles
primitive. No functionality is duplicated.

**Originating-reference note:** this is not greenfield. The **content-guard**
design (`docs/design/2026-06-22-content-guard.md`) scoped this work: it exports
`stripInvisible` explicitly so "`decode-normalize` (a later task) reuses the exact
same strip primitive" (content-guard.md:29) and records that base64/hex/rot13
decoding "is the separate `decode-normalize` task's job, and it targets *outgoing
command* inspection (bash-policy / risk-guard), not ingress fencing"
(content-guard.md:69-71). This design is the dedicated build-out of that
already-named follow-up; there is no *prior decode/normalize design document*, but
content-guard is the originating reference that anticipated and bounded it. No
conflict — the two designs are consistent (this section discusses content-guard at
length above).

## 7. Acceptance Criteria

All assertions are runnable in `test/decode-normalize.test.ts` (offline,
`node:test` via `tsx`), unless noted.

**Helper unit (pure):**

1. `normalizeForInspection("echo cm0gLXJmIC8=|base64 -d|sh")` includes a string
   matching `/rm -rf \//`. (base64 + idiom)
2. `normalizeForInspection("printf '\\x72\\x6d\\x20\\x2d\\x72\\x66\\x20\\x2f'|sh")`
   includes a string matching `/rm -rf \//`. (hex `\xNN` + idiom)
3. `normalizeForInspection("ez -es /")` includes the rot13-decoded `rm -rf /`
   (verified: `rot13("ez -es /") === "rm -rf /"`, a char-wise ROT13 over ASCII
   letters). This decode passes the D7 emit gate because its first token `rm` is a
   known command — contrast AC-5, where the rot13 decode's first token is not.
   (rot13)
4. A zero-width/tag-obfuscated `rm -rf /` (invisible codepoints interleaved)
   yields a candidate matching `/^rm -rf \//` (strip-invisible via
   `stripInvisible`).
5. **Emit gate + dedup:** `normalizeForInspection("ls -la")` returns `[]`. Note
   the gate (D7), not raw-exclusion, is what makes this empty: rot13 is total, so
   `rot13("ls -la") = "yf -yn"` *is* produced and is `!==` the raw input, but its
   first token `yf` is not a known command, so the D7 command-plausibility
   conjunct drops it; base64/hex of `"ls -la"` yield invalid UTF-8 and are dropped
   by the valid-UTF-8 conjunct. The returned array also has no duplicates
   (`new Set(out).size === out.length`). (A weaker assertion — a set not
   containing the raw input — would NOT distinguish a correct `[]` from the
   un-gated `["yf -yn"]`, so the test asserts exactly `[]` here.)
6. **Fail-open (silent-garbage, non-throwing):**
   `normalizeForInspection("echo not-valid-base64!!! | base64 -d")` does not throw
   and produces no garbage candidate that matches a real command family. Note the
   decoder does **not** reject this by throwing — `Buffer.from(s,"base64")` never
   throws; the candidate is rejected by D7's valid-UTF-8 / round-trip emit gate
   (the decoded bytes contain a U+FFFD replacement char), not by try/catch.
7. **Depth bound (cleartext one layer beyond the bound is never reached):**
   `DECODE_DEPTH = 2` decodes at most two layers, so a triple-base64-wrapped
   `rm -rf /` reaches only its *intermediate* base64 layers — depth 2 stops one
   layer short of the cleartext. The load-bearing assertion is cleartext-absence,
   because "depth 2 stops short" means "does not reach cleartext", **not** "emits
   nothing": the intermediate strings the two decode layers produce are themselves
   fed back through the gate, and at least one of them passes it. With
   `tripleWrapped = base64(base64(base64("rm -rf /")))`
   (`= "WTIwd1oweFlTbTFKUXpnOQ=="`):
   - **Cleartext is NOT reached** — assert
     `assert.ok(!normalizeForInspection(tripleWrapped).some(c => /rm -rf \//.test(c)))`.
     This holds regardless of the gate, since the inner `rm -rf /` is one decode
     beyond the bound. This is the only correct, gate-independent boundary
     assertion for this fixture.
   - **The set is NOT empty — do not assert `deepEqual(..., [])`.** The
     candidate set turns on which intermediates the D7 gate admits, and the
     depth-1 intermediate of this triple-wrap is `Y20wZ0xYSm1JQzg9` (no `=`
     padding, valid UTF-8, round-trips on re-encode, and first whitespace token
     matches conjunct-2's command-word regex `/^[\w./-]+$/`). It therefore passes
     **both** conjuncts and IS emitted as a harmless junk candidate, so
     `normalizeForInspection(tripleWrapped)` is `["Y20wZ0xYSm1JQzg9"]`, not `[]`.
     Only the *depth-2* intermediate `cm0gLXJmIC8=` (= the single-base64 of
     `rm -rf /`) is `=`-padded and so rejected by the `/^[\w./-]+$/` regex —
     but rejecting that one layer does not empty the set, because the depth-1
     layer was already admitted. Pinning emptiness here is a factual error: it
     overlooks that the depth-1 intermediate of a triple-wrap is itself an
     un-padded, emittable candidate. The boundary fact worth pinning is the
     cleartext-absence above, not the size of the junk-candidate set.

   The **double-wrapped** form `base64(base64("rm -rf /"))` IS decoded to
   cleartext (depth 2 reaches it) and its candidate set includes a string matching
   `/rm -rf \//`.

**bash-policy integration (loaded via `host.use("bash-policy", activate)`):**

8. With rule `{ pattern: "rm *", action: "deny" }`, a tool call
   `{ command: "echo cm0gLXJmIC8=|base64 -d|sh" }` is **blocked** (the run-flag
   stays false and the model sees a `bash-policy:` block reason) — whereas today,
   without decode, it runs. (uses the `shellTool`/`sawBlock` harness pattern from
   `test/bash-policy.test.ts`).
9. With `EAGENT_DECODE_NORMALIZE=off`, the same obfuscated call **runs** (literal
   `echo`/`base64`/`sh` candidates miss the `rm *` rule), confirming the kill
   switch restores prior behavior.
10. **No regression:** the full existing `test/bash-policy.test.ts` suite passes
    unchanged (`npm test` green), and a benign `git status && rm -rf build` still
    behaves as the existing tests assert (decode adds no spurious block on
    non-encoded input).

**risk-guard integration (loaded via `host.use("risk-guard", activate)` with a
MockProvider capturing the prompt):**

11. For a call `{ cmd: "echo cm0gLXJmIC8=|base64 -d|sh" }` with risk-guard
    enabled, the classifier's user message (captured from the MockProvider
    `stream` request) contains `"[decoded payload:"` and the decoded `rm -rf /`.
    The decode subject is `JSON.stringify(call.arguments)` (the whole
    `{"cmd":"echo cm0gLXJmIC8=|base64 -d|sh"}` blob, risk-guard.ts:103) — the
    embedded `cm0gLXJmIC8=` is found by the substring-scanning base64/idiom matcher
    *inside* the JSON wrapper, which is why this passes despite there being no
    per-value `commandArgKey` extraction. **Negative-coverage assertion (pins the
    documented asymmetry):** a call carrying a *rot13'd* payload as an argument
    value (e.g. `{ cmd: "ez -es /" }`) adds **no** `[decoded payload:` line, because
    the whole-string rot13/known-command gate sees the JSON wrapper token
    (`{"cmd":"ez`) as the first token, which is not a known command — confirming
    the whole-blob subject and that rot13-in-arg is intentionally out of reach for
    risk-guard (unlike bash-policy, AC-3).
12. With `EAGENT_DECODE_NORMALIZE=off`, the same call's classifier message
    contains **no** `[decoded payload:` line (raw prompt unchanged), and the
    existing `test/risk-guard.test.ts` suite passes unchanged.

**Whole-suite gates:** `npm test` and `npm run typecheck` both pass (recorded as
commit trailers).

## 8. Risks and Rollback

- **Risk — false candidate (mis-decode of benign content).** A best-effort
  decoder could turn benign args into a command-looking string. *Mitigation
  (two layers):* first, the D7 emit gate drops decodes that are not valid UTF-8
  (the base64/hex silent-garbage case) or not command-plausible (the rot13
  total-decode case), so most benign mis-decodes never become candidates at all.
  Second, even for a candidate that slips the gate, the helper only ADDS a
  candidate the *real* rules judge and NEVER blocks on its own (D3); a benign
  mis-decode matches no deny rule, so it is a no-op. risk-guard only annotates the
  prompt; the judge still decides. The false-positive blast radius is bounded to
  "one extra candidate the existing machinery evaluates".
- **Risk — false negative (novel encoding missed).** The focused encoding set
  (D2) will not cover an unseen obfuscation. *Mitigation:* this is the prior state
  of the world (the guards already saw only literal text); the change strictly
  *adds* coverage and cannot regress detection. A new encoding is a follow-up.
- **Risk — pathological/nested input (decode bomb).** *Mitigation:* `DECODE_DEPTH = 2`
  bounds work to a small constant (D4); no fixpoint, no unbounded recursion. Each
  decoder is try/caught and returns `undefined` on an unexpected throw (fail-open),
  so a throw inside a decoder cannot break the `beforeToolCall` filter; the
  common bad-input case (which does *not* throw — D7) is handled by the emit gate,
  not the try/catch.
- **Risk — overlap with content-guard's Unicode pass.** *Mitigation:* the
  invisible-strip primitive is *shared by import* (`stripInvisible`,
  content-guard.ts:64), so there is one definition, not two drifting copies (D1).
- **Risk — performance on every shell call.** Decoding runs in `beforeToolCall`
  for `shell:exec` tools. *Mitigation:* bounded depth, small constant work, pure
  string ops, no I/O or provider call in the helper itself; risk-guard's provider
  cost is unchanged (still one sub-call, now with a longer prompt).

**Rollback / kill switch.** `EAGENT_DECODE_NORMALIZE=off` disables the decode
union and the judge-prompt annotation in both guards, restoring **literal-only**
matching — the exact pre-change behavior (asserted by AC-9 and AC-12). Because the
change is additive (a library plus two guarded branches that no-op when off and
when no decode differs from raw), reverting the env var is a complete, immediate
rollback with no state to clean up; a full code revert touches only `decode.ts`,
the two guarded branches, and the test.
