# Light-Mode brief — flow-guard sensitive-path recursion (GUARD-2)

Status: closed
Closing-commit: (this commit)
Closed-on: 2026-07-02

**Slug:** `2026-07-02-flow-guard-path-recursion` · **Tier:** Light (`src/extensions/flow-guard.ts` +
`test/flow-guard.test.ts`; additive recursion with an inherited depth bound, no breaking change, no new
contract, no decision). Source: `docs/DEFERRED-FOLLOWUPS.md` GUARD-2. Branch: `chore/audit-gaps-2`.

## What / why

`flow-guard`'s sensitive-**path** taint trigger scans only the **top-level** arg values
(`flow-guard.ts:129-138`: `for (const v of Object.values(call.arguments)) if (typeof v === "string" &&
…)`), so a sensitive path nested in a sub-object (`{opts:{path:"~/.ssh/id_rsa"}}`) is **never tainted on
the path axis** — asymmetric with the two sibling scanners (`provenance.ts:56-65` depth-bounded leaf
walk; `secret-guard.ts` full recursion, now bounded by GUARD-1). No shipped `fs:read` tool nests its
path (core-tools/search pass a top-level string), so today's impact is nil; the gap bites a third-party
/ MCP `fs:read` tool. The content axis (`:151`) remains a backstop.

**Change:** replace the top-level `for` loop with a **depth-bounded recursive** string-leaf search that
returns the first matching path (to preserve the existing `sensitive-path:${v}` reason), mirroring the
sibling scanners: add `const MAX_SCAN_DEPTH = 8;` and a `findSensitivePath(v, depth)` that returns the
matching string or `undefined` — a string leaf is tested against `c.sensitivePaths` regardless of depth;
below `depth <= 0` it stops descending arrays/objects. Keep the `pending.set(call.id, …)` recording
identical (still `sensitive-path:${hit}`).

## Explicit non-goals (Simplicity First)

- Depth `8` mirrors provenance/secret-guard — not a new decision.
- No change to the capability trigger (`:124`), the content axis (`:151`), the `message`-handler tagging
  (`:145`), the default-ON posture, or the reason string format.
- No new capability, dependency, or kernel change.

## Any >1-option decision surfaced

None — the sibling-scanner recursion pattern applied to flow-guard's path axis; depth constant inherited.

## Measurable acceptance command

- `node --import tsx --test test/flow-guard.test.ts` exit 0 — a NEW test: an `fs:read` call with a
  sensitive path **nested in a sub-object** (`{opts:{path:"~/.ssh/id_rsa"}}`, using the extension's
  configured sensitivePaths) is now tainted (the resulting tool message carries `flowGuardTaint`
  including `sensitive-path:…`); reverting the recursion leaves it untainted (discriminator). A control:
  a **top-level** sensitive path is still tainted (byte-identical to today), and a non-sensitive nested
  path is not tainted.
- `npm test` exit 0 · `npm run typecheck` exit 0 · `npm run eval` exit 0 · `src/kernel/` untouched · no
  new dependency.

## Closure

**Closed** 2026-07-02. flow-guard's sensitive-path taint now recurses a depth-bounded (`MAX_SCAN_DEPTH=8`)
string-leaf search, so a path nested in a sub-object taints too — symmetric with provenance/secret-guard.
Byte-identical for top-level paths; reason format (`sensitive-path:<path>`) unchanged; scoped to the
`fs:read` block. Light-Mode fresh review **pass** (clean first round; same-regex-deeper-reach confirmed,
no over-taint, genuine red→green discriminator). Gates: flow-guard 14 pass, `npm test` 1185 pass / 0
fail / 1 skip, typecheck 0, eval 5/5, `src/kernel/` untouched, no new dependency.
