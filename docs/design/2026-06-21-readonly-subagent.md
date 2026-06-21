# Light-Mode brief: read-only capability lane for sub-agents

Slug: `2026-06-21-readonly-subagent`
Tier: Light Mode (2 non-load-bearing files: `src/extensions/subagents.ts`,
`test/subagents.test.ts`. No new file, no host change, no breaking change, no new
external contract.)

## What / why

`spawn_agent` (`src/extensions/subagents.ts`) gives a child its own fresh
context and a pruned tool registry, but the child **shares the parent's
`CapabilityManager`** verbatim (`subagents.ts:58`) — so a spawned "explorer" or
"reviewer" has the *same* authority as the parent and can write files, run the
shell, or hit the network. The upstream `oh-my-opencode-slim` project ships
named per-agent permission profiles (a read-only explorer that denies
`edit/write/bash`); EAgent already owns the enforcement primitive (the
capability layer, "the security vocabulary") but exposes no way to spawn a child
into a restricted lane.

This change adds a single `readOnly` option to `spawn_agent`. When set, the
child runs against a fresh, strict capability manager that grants only read
capabilities (`fs:read`, `skill:read`) and denies everything else by fallback —
so any mutation or egress tool the child tries (`fs:write`, `shell:exec`,
`net:fetch`, `code:exec`, …) is refused at the capability boundary, while reads
and searches still work. It is the smallest possible expression of opencode's
profile idea, built entirely on the existing `CapabilityManager`.

## Explicit non-goals

- **No named-profile system.** Exactly one lane (`readOnly`) ships. A registry of
  profiles (explorer / librarian / fixer with per-profile MCP allowlists and
  temperatures) is the upstream's surface, not this change (Simplicity First).
- **No tool pruning.** The read-only child still *sees* mutation tools in its
  registry; they are *denied at call time* by the capability layer (the
  principled enforcement boundary). Hiding tools from the child's registry is a
  separate, optional polish, explicitly out of scope.
- **No change to default behavior.** `readOnly` defaults to `false`; an
  unspecified or `false` value keeps the child sharing the parent's capabilities
  exactly as today.
- **No new capability string** and no kernel change. The lane is composed from
  the existing `CapabilityManager` grant/deny/fallback API.
- **No per-mode divergence.** `readOnly` applies uniformly to `single`,
  `parallel`, and `chain` children.

## >1-option decision surfaced

**What authority does the read-only lane grant?** — options: (a) grant a broad
read set including `net:fetch` (so a read-only researcher can still browse);
(b) grant only local read capabilities (`fs:read`, `skill:read`) with fallback
`deny`, refusing network egress too. **Pick: (b).** A strict no-egress lane is
the safer, simpler default and doubles as an exfiltration guard (a read-only
child cannot phone home), consistent with EAgent's `flow-guard` posture.
Rejected (a) because "read-only but can reach the network" is a weaker, more
surprising guarantee, and a researcher that genuinely needs the web can be
spawned without `readOnly`. The chosen set is two explicit grants plus
`fallback: "deny"` — no magic numbers, a closed and reviewable list.

## Measurable acceptance command

`npm test` exit 0 (incl. updated `test/subagents.test.ts`) **and**
`npm run typecheck` exit 0. New tests assert, offline via `makeHarness` +
`MockProvider`:
1. **unit — the lane enforces**: the exported `readOnlyCapabilities()` manager
   resolves `require("fs:read")` and `require("skill:read")` but rejects
   `require("fs:write")`, `require("shell:exec")`, and `require("net:fetch")`
   with `CapabilityError`.
2. **behavioral — a read-only child cannot mutate**: a parent spawns a
   `readOnly: true` child scripted to call a flag-flipping `fs:write` tool; the
   tool body never runs (flag stays false — denied at the capability boundary).
3. **control — default child still can mutate**: the identical scenario with
   `readOnly` omitted (child shares the parent's `fallback: "allow"` manager)
   runs the tool body (flag flips true), proving default behavior is unchanged
   and the parent's capabilities are untouched.
4. **recursion guard intact**: the read-only child still omits `spawn_agent`
   (existing guarantee unaffected).

## Closure note

Status: closed. Closing-commit: 08818d0. Closed-on: 2026-06-21.
Acceptance: `npm test` exit 0 (339/339 pass, incl. the 3 new tests),
`npm run typecheck` exit 0. Fresh-eyes Light-Mode review: pass (tier confirmed
Light; zero severe, zero general; two advisory clarifications — the read grant
set is intentionally narrow, and the `ui` passed to `readOnlyCapabilities` is
inert under fallback deny, both by design). Deferred: none.
