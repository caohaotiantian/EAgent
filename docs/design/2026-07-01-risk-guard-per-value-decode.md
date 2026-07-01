# Light-Mode brief — risk-guard per-value decode (per-value rot13) (DEFERRED-1)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-01
Deferred: none (DEFERRED-1 resolved).

**Slug:** `2026-07-01-risk-guard-per-value-decode` · **Tier:** Light (3 files: `src/extensions/risk-guard.ts`
+ `test/risk-guard.test.ts` + `test/decode-normalize.test.ts` [blast-radius, see below]; additive,
strict superset of today's decode candidates; no breaking change, no new contract, no migration, no
unresolved decision; risk-guard is **off by default** so no default behavior change). Source:
`docs/DEFERRED-FOLLOWUPS.md` DEFERRED-1. Branch: `chore/finish-followups-3`.

**Blast-radius (an existing test pinned the old asymmetry):** `test/decode-normalize.test.ts:244`
("AC11 (negative): a rot13'd arg is NOT surfaced … whole-blob asymmetry") asserted the *old* behavior
this change deliberately resolves — that a rot13'd arg value is out of reach. It is flipped to a
**positive** test ("AC11 (per-value): a rot13'd arg VALUE is surfaced per-value") asserting the new
contract (`[decoded payload: rm -rf /]`). A `src/`+`test/` sweep found this is the **only** consumer
pinning the asymmetry; the original design `docs/design/2026-06-22-decode-normalize.md` (§8 AC-11)
documented it as intentional-at-the-time and is left as historical (superseded by this brief for that
one AC).

## What / why

`risk-guard` (a `beforeToolCall` LLM-judge, **off by default**) pre-inspects a call by running the
shared `normalizeForInspection` decoder over the **whole stringified args blob** (`risk-guard.ts:107-113`).
The base64/hex/`echo|base64 -d`/`printf` idioms are **substring** scanners, so an embedded payload is
found inside the JSON wrapper. But **rot13** is a *whole-string* decode gated on its first token being a
known command family (`lib/decode.ts:198,144-145`): rot13-ing the whole blob yields
`{"pbzznaq": …}` → `{"command": …}` whose first token `{"command":` is not a command, so a **rot13'd
command inside a specific arg value** (`{"cmd": "ez -es /"}`, where `"ez -es /"` is rot13 of `rm -rf /`)
is **not** surfaced. The `risk-guard.ts:102` comment documents exactly this ("risk-guard has no per-value
`commandArgKey`").

**Change:** in `risk-guard`'s decode-annotation loop, in addition to normalizing the whole blob, also
run `normalizeForInspection` over **each string-leaf value** of `call.arguments` (recursively, for
nested objects/arrays). A rot13'd value is then the *whole* subject, so the existing rot13 path + gate
surfaces it (`normalizeForInspection("ez -es /")` → rot13 → `rm -rf /`, first token `rm` ∈
`KNOWN_COMMANDS` → surfaced). Dedupe the emitted `[decoded payload: …]` lines across the whole-blob and
per-value passes.

## Explicit non-goals (Simplicity First)

- **No change to `lib/decode.ts`** (the shared decoder) and therefore **no change to `bash-policy`**
  (default-ON, scans the `command` string, not a JSON args blob). This stays risk-guard-scoped, so a
  default-on guard's behavior is untouched.
- **No `commandArgKey` mapping.** Scanning **all** string leaves (not just a designated command arg) is
  simpler and covers more; the same gate keeps false positives down. bash-policy keeps its own
  `commandArgKey` (unrelated).
- **Byte-identical when `EAGENT_DECODE_NORMALIZE=off`** (the whole loop is skipped) and when risk-guard
  is disabled (its default). The per-value pass only **adds** candidates (a strict superset), never
  removes — so no existing risk-guard assertion flips.
- No new capability, no new dependency, no kernel change.

## Any >1-option decision surfaced

- **Where to fix** — (a) risk-guard-only, feed each string-leaf value through the existing
  `normalizeForInspection` (**chosen**); (b) extend `lib/decode.ts` to emit per-quoted-string rot13
  candidates (would change the default-ON `bash-policy`'s candidate set — larger blast radius); (c) add
  a `commandArgKey` to risk-guard (needs per-tool config for a single edge). **Chosen (a)**: smallest,
  reuses the gate verbatim, no shared-lib/default-on-guard impact, and catches per-value base64/hex too
  as a bonus (all decoders run per value, not just rot13). (b)/(c) are larger for no extra coverage.

## Measurable acceptance command

- `node --import tsx --test test/risk-guard.test.ts` exit 0 — a NEW test: a tool call whose arg VALUE
  is `rot13("rm -rf /")` = `"ez -es /"` (and NOT bash — a non-command tool) produces a
  `[decoded payload: rm -rf /]` annotation line in the classifier prompt (assert via the same
  provider-capture mechanism existing risk-guard tests use); a control where the value rot13s to a
  non-command (e.g. `"hello"`) surfaces nothing; and `EAGENT_DECODE_NORMALIZE=off` yields the
  byte-identical (no-annotation) prompt. Existing risk-guard whole-blob decode tests stay green.
- `node --import tsx --test test/decode-normalize.test.ts` exit 0 — the flipped AC11 (per-value)
  asserts the rot13'd arg VALUE is now surfaced; the positive whole-blob AC11 (base64) stays green.
- `npm test` exit 0 (full suite) · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/`
  untouched · no new dependency.

## Closure

**Closed** 2026-07-01. `risk-guard` now decode-normalizes each string-leaf arg value (`stringLeaves` +
a per-value `annotate` pass with a `seen` dedup, `risk-guard.ts`) in addition to the whole blob, so a
rot13'd command in one arg value is surfaced to the judge — resolving the documented whole-blob
asymmetry. Strict superset of the old candidates (whole-blob never dropped); off by default;
`lib/decode.ts`/bash-policy untouched. Blast-radius: the one existing test pinning the old asymmetry
(`decode-normalize.test.ts` AC11) is flipped to a positive per-value test. Light-Mode fresh review
**pass** (clean first round; Light tier confirmed; strict-superset + RED discriminator + blast-radius
sweep all verified). Gates: risk-guard 17 pass, decode-normalize 13 pass, `npm test` 1158 pass / 0 fail
/ 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
