# Design — Hardened server profile (Cycle 1)

Slug: `2026-07-11-hardened-server-profile`
Status: **L1 closed** — 3 rounds, all zero-severe; generals converged (5→3→3, all resolved). Ready for L2.

## 1. Background and Purpose

The HTTP server ships **`yolo`** (capability fallback `allow` — every ungranted capability
auto-granted, including `shell:exec`): `createHttpServer` calls `createAgentHost({… yolo: opts.yolo ??
true})` (`src/server.ts:115`) → `fallback: opts.yolo ? "allow" : "ask"` (`src/host.ts:244`). Meanwhile
the *enforcing* guards ship inert:

- `risk-guard` — `enabled: e.config.enabled("risk-guard", { default: false, … })` (`src/extensions/risk-guard.ts:98`): OFF.
- `provenance` — inner enforcement `enabled("provenance", { default: false, store })` (`src/extensions/provenance.ts:78`): OFF.
- `sandbox-tiers` — loaded ON (`default: true`, `src/extensions/sandbox-tiers.ts:75`) but `tier` defaults `"off"` → pass-through no-op (`src/extensions/sandbox-tiers.ts:76,118`).

So an operator wanting a locked-down deployment must today discover and flip four separate,
inconsistently-wired knobs. There is **no preset** (`grep -a hardened|preset` finds only unrelated hits).
A one-switch **hardened profile** turns the yolo server into a defense-in-depth posture: dangerous tool
calls are risk-classified, shell/code is filesystem-confined, and tool output is injection-defended.

## 2. Deliverables

- [ ] **D1** — a `hardened?: boolean` option on `AgentHostOptions` (`src/host.ts:164-178`), inherited by
      `ServeOptions` (`src/server.ts:40-56`). `createAgentHost` resolves it **internally** as
      `opts.hardened ?? config.bool("hardened", false)` right after `LayeredConfig` is built
      (`src/host.ts:208-212`) — where the config already exists, well before activation
      (`src/host.ts:285`), so there is no chicken-and-egg and no reintroduced `process.env` read.
      `config.bool` resolves env `EAGENT_HARDENED` (via `configEnvName`, `src/config.ts:55-56`) and the
      file key `hardened`, with **env winning over file** (value order override > env > file,
      `src/config.ts:106-113`) — so an operator's `EAGENT_HARDENED` cannot be un-hardened by a
      project-local `.eagent/config.json`. It is a **host-level** flag (not server-only): because both
      `createHttpServer` (`src/server.ts:115`) and `cli.ts` (`cli.ts:152`) call `createAgentHost`, any
      front end honors it — see KDD1.
- [ ] **D2 (runtime preset layer)** — an optional in-memory `preset` map on `LayeredConfig`
      (`src/config.ts`), consulted by `enabled()`/`bool()`/`string()`. When `hardened`, `createAgentHost`
      builds it (before the `BUILTIN_EXTENSIONS` activation loop at `src/host.ts:285`) with:
      `"risk-guard": true`, `"provenance": true`, `"sandbox.tier": "workspace-write"`. **Precedence —
      the preset sits directly below the env layer and above the override-store, uniformly** so it is
      **fail-secure** (no persisted/stale store value can weaken hardened): for `enabled(id)` —
      **env-veto > preset > override-store > `opts.store` "enabled" > code default**; for value keys
      `bool`/`string` — **env > preset > override-store > file > default**. Consequence: **the env var
      is the single escape hatch under hardened** — `EAGENT_RISK_GUARD=off` (env-veto) still disables a
      guard (AC4), and `EAGENT_SANDBOX_TIER=readonly` (env) still picks a different tier; a persisted
      `/config set …` (override-store) is *below* the preset and cannot weaken it (KDD3, R5). *Implementer
      note:* the base value-key order is `override > env > file` (`src/config.ts:106-113`); for a preset
      key the layer resolves at the preset before override/file are reached, and env is checked above the
      preset — so a preset value key effectively resolves `env > preset > (override/file unreached)`,
      which is the fail-secure order above (no observable difference from the general path, since a
      preset key always hits the preset layer). **No disk write** — the preset is runtime state that
      reverts when `hardened` is unset.
- [ ] **D3 (`sandbox-tiers` tier from config)** — `sandbox-tiers` reads its tier from
      `e.config.string("sandbox.tier")` (falling back to its existing store key `tier`), mirroring how it
      already reads `sandbox.backend` from config (`src/extensions/sandbox-tiers.ts:83`). This lets the
      runtime preset set the tier without a store write. Because the preset outranks both the
      override-store and the extension-store `tier` fallback (D2), hardened's `workspace-write` is
      **fail-secure** — neither a stale `/config set sandbox.tier off` nor a `/sandbox-tiers tier` value
      can weaken it; the only override is the env var `EAGENT_SANDBOX_TIER` (R5).
- [ ] **D4 (operator visibility)** — when `hardened` is active, the host prints a startup line naming
      what it enabled (`risk-guard`, `provenance`, and the **resolved** `sandbox.tier` from
      `config.string("sandbox.tier")` — not a hardcoded string, so an env override shows truthfully) and,
      if no sandbox backend is detected, warns that the tier is fail-open (no-op) on this host.
- [ ] **D5 (docs)** — SECURITY.md "Recommended deployment" + README server section: document
      `EAGENT_HARDENED=1`, exactly what it enables, that it is **orthogonal** to `yolo:false`
      (least-privilege), the no-backend sandbox fail-open caveat (R1), and the **override policy**: under
      hardened the env var is the single escape hatch for each preset key (`EAGENT_RISK_GUARD=off`,
      `EAGENT_PROVENANCE=off`, `EAGENT_SANDBOX_TIER=<tier>`); a persisted `/config set` is below the
      preset and does not weaken it (R5). Also note it is a host-level flag the CLI honors too (opt-in
      defense-in-depth).
- [ ] **D6 (tests)** — offline tests (below, §7): hardened seeds the three settings so the guards
      resolve enforcing; a kill switch still wins; non-hardened is unchanged.

## 3. Scope Boundary (NOT in scope)

- **Not changing the capability fallback.** Hardened does **not** flip `yolo→ask`. Least-privilege
  capability lockdown already exists as the orthogonal `yolo:false` option (SECURITY.md "Recommended
  deployment"). Flipping it here would *deny* `shell:exec` on the headless server (KDD2), making the
  shell-guards this preset enables **moot** — a direct contradiction.
- **Not enabling `planmode`.** Its approval gate is `ui.confirm` (`src/extensions/planmode.ts:69`),
  always `false` on the headless server, so it would block **all** mutating tools. Out of scope; it
  stays a separate opt-in.
- **Not setting `missingBackend="block"`.** That would refuse every shell command on a host without a
  sandbox backend (Linux w/o bwrap/firejail, Windows). The preset keeps the default fail-open (`"pass"`).
- **Not server-only, but the server is the primary target.** `hardened` is a **host-level** flag on
  `AgentHostOptions`, resolved inside `createAgentHost` (D1), so any front end that builds a host —
  server *and* CLI (`cli.ts:152`) — honors `EAGENT_HARDENED`. This is intentional (KDD1): hardening the
  CLI is opt-in and fail-secure (the CLI already runs `ask`-fallback, so hardened just adds the guards).
  The name is `hardened`, not `server.hardened`, to avoid implying a scope the shared `createAgentHost`
  seam cannot enforce.
- **Not changing any guard's internal logic** beyond D3's additive config read for the tier.
- **No new kernel lines** — this is host + config + extension, not `src/kernel/`.

## 4. Key Design Decisions

### KDD1 — Trigger: host-level `hardened` (`EAGENT_HARDENED`), resolved inside `createAgentHost`
- **Problem:** how does an operator turn the preset on, where is it read, and does it apply to the CLI
  as well as the server?
- **Options:** (a) a config key read **post-build** in `createHttpServer` like `server.host`
  (`src/server.ts:117`); (b) a direct `process.env` read pre-build in `createHttpServer`; (c) a new
  slash command; (d) resolve `opts.hardened ?? config.bool("hardened", false)` **inside**
  `createAgentHost`, right after `LayeredConfig` is built (`src/host.ts:208`).
- **Choice: (d), with a host-level key `hardened` (env `EAGENT_HARDENED`).** The preset must be known
  **during** host construction (before extensions activate, `src/host.ts:285`). (a) is a chicken-and-egg
  — `built.config` does not exist until `createAgentHost` returns. (c) is impossible — no command route
  (`src/server.ts:305`). (b) reintroduces the isolated `process.env.EAGENT_*` read `LayeredConfig`
  exists to eliminate. (d) uses the config already built at `src/host.ts:208`, so `config.bool` resolves
  env `EAGENT_HARDENED` (`configEnvName`, `src/config.ts:55-56`) and the file key `hardened` with
  **env > file** — no direct env read, no chicken-and-egg, and env-wins means a project `.eagent/
  config.json` cannot un-harden an operator's env var.
- **Scope decision (CLI honors it too):** because `createAgentHost` is the shared seam for **both**
  front ends (`src/server.ts:115`, `cli.ts:152`), the flag is host-level, not server-only — a
  `server.`-prefixed name would falsely imply a scope `createAgentHost` cannot enforce. The CLI honoring
  `EAGENT_HARDENED` is a deliberate, low-stakes feature: it is opt-in and fail-secure (the CLI already
  runs `ask`-fallback, so hardened only *adds* the guards; it never loosens anything). A server-only
  flag would require the rejected pre-build `process.env` read (b).

### KDD2 — Hardened = defense-in-depth (enable guards), NOT capability lockdown
- **Problem:** what does "hardened" change — the capability posture, the guards, or both?
- **Options:** (1) capability lockdown: `yolo:false` → deny high-authority caps; (2) defense-in-depth:
  keep caps, enable `risk-guard`/`sandbox-tiers`/`provenance`; (3) both.
- **Choice: (2).** The roadmap ask is literally "enable the guards that ship off." (3) is
  **self-contradictory**: `yolo:false` makes fallback `ask`, which on the headless server *denies*
  `shell:exec` (`ui.confirm → false`, `src/kernel/capabilities.ts:115-120`; `shell:exec` is not
  in the pre-grant list `["fs:read","fs:write","skill:read"]`, `src/host.ts:243`) — so `bash` never
  runs, and the shell-wrapping guards (`sandbox-tiers`, `risk-guard`) become no-ops. (1) already exists
  as the `yolo:false` knob, so it needs no new preset. (2) is the genuinely new, non-contradictory
  value: shell/code still run but **risk-classified, filesystem-confined, and injection-defended**.
  Documented as orthogonal to `yolo:false` (an operator may combine both, accepting that the guards then
  mostly idle).

### KDD3 — Apply as a runtime in-memory preset layer, NOT a persisted store seed
- **Problem:** the guards read their on/off from the override **config store** (`this.#over.get(id)`,
  `src/config.ts:145`) and tunables from file-backed extension stores. Seeding those to enable the
  guards would write to disk.
- **Options:** (a) `config.set(id, true)` into the file-backed override store; (b) an in-memory preset
  layer on `LayeredConfig`, checked below env-veto; (c) a dedicated `hardened-profile` extension that
  reconfigures the others.
- **Choice: (b).** Every store is file-backed (`FileBackend`, one JSON per namespace), so (a) makes
  hardened **sticky** — it persists after the env var is unset, and the server has no command route to
  revert it; a security *toggle* that cannot be toggled off is a footgun. (c) is heavier and races the
  load order. (b) is a small additive change: an optional `preset` map consulted in
  `enabled()`/`bool()`/`string()` directly below the env layer and above the override-store (exact
  per-lookup order in D2) — so it enables the guards at runtime, reverts cleanly when `hardened` is off,
  is **fail-secure** (no stale store value weakens it), and a kill switch (`EAGENT_RISK_GUARD=off`,
  env-veto, `src/config.ts:143`) still wins over the preset (AC4).

### KDD4 — Sandbox tier = `workspace-write`
- **Problem:** which tier does hardened set?
- **Options (`TIERS`, `src/extensions/lib/sandbox.ts:23`):** `readonly`, `workspace-write`, `no-network`.
- **Choice: `workspace-write`.** It confines subprocess writes to the workspace root + temp
  (`src/extensions/lib/sandbox.ts:100,111-116`) while keeping network — so provider/API and network
  tools still work. `readonly` breaks most real work; `no-network` breaks any subprocess needing the net
  (`--unshare-net`, `src/extensions/lib/sandbox.ts:126`). Caveat: without a detected backend the tier
  **fail-opens** (warns once, runs unsandboxed — `missingBackend="pass"`,
  `src/extensions/sandbox-tiers.ts:130-135`), so on a backend-less host hardened still classifies
  (risk-guard) and injection-defends (provenance) but does not confine — surfaced by D4's warning.

## 5. Dependencies and Assumptions

Verbatim source for each load-bearing claim:
- Override-store enable key is the **bare extension id**: `enabled()` reads `this.#over.get("risk-guard")`
  (`src/config.ts:145`); the preset uses the same keys. Env-veto precedes it: `this.#env(id) === "off"`
  (`src/config.ts:143`).
- The override config store + full `LayeredConfig` are built (`src/host.ts:210-212`) ~73 lines before
  the activation loop (`src/host.ts:285`) — the host can inject the preset before any extension calls
  `e.config.enabled(...)`.
- `provenance` two-tier gate: outer `enabled("provenance", {default:true})` (`src/extensions/provenance.ts:75`)
  + inner `enabled("provenance", {default:false, store})` (`:78`) — the preset key `provenance:true`
  satisfies the inner gate.
- **Enabling `risk-guard` blocks on the headless server** — resolved from source, no mode key needed.
  `type Mode = "ask" | "block"` (`src/extensions/risk-guard.ts:31`) — there is no non-gating "warn"
  mode. Default is `"ask"` (`:99`); **both** modes block on the server: `"block"` blocks directly
  (`:193`), `"ask"` calls `ui.confirm` (`:194`) which returns `false` (`src/server.ts:110`) ⇒ block
  (`:195`). So the preset enables `risk-guard` via the `enabled` flag alone; it does **not** touch the
  mode. `risk-guard` classifies **only** `shell:exec`-cap tools (`:34,:183`), so the classifier cost is
  confined to shell tools (R2).
- `sandbox-tiers` already reads `sandbox.backend` from config (`src/extensions/sandbox-tiers.ts:83`), so
  D3's `sandbox.tier` config read is a consistent, additive extension of that pattern.
- The suite runs offline against `MockProvider`; `risk-guard`'s classifier sub-call must be exercised
  with a scripted mock (no network).

## 6. Relationship with Existing Designs

- `docs/design/2026-07-10-session-isolation.md` (closed) established the server's process-boundary
  posture and the SECURITY.md "Recommended deployment" section this cycle extends. No conflict: that
  cycle documented deployment topology; this one adds an in-process defense-in-depth preset.
- Terminology anchors: CLAUDE.md (capabilities vocabulary, the `EAGENT_<NAME>=off` kill-switch
  convention) and the README extension table. No conflict with prior designs.

## 7. Acceptance Criteria (measurable / automatable)

Test file `test/hardened-profile.test.ts`, offline (`MockProvider`), plus the existing suite.

- **AC1 (guards resolve enforcing under hardened):** build a host with `hardened:true`; assert
  `built.config.enabled("risk-guard", {store})` `=== true`, `enabled("provenance", {store})` `=== true`,
  and `built.config.string("sandbox.tier") === "workspace-write"`. RED before D2/D3.
- **AC2 (behavioral — hardened actually blocks):** on a hardened, non-interactive host (server UI,
  `confirm → false`), a tool call the risk classifier (scripted mock) rates high-risk is **blocked**
  (returns an error `ToolResult`, not executed). RED before the preset wires risk-guard on.
- **AC3 (non-hardened unchanged):** without `hardened`, `enabled("risk-guard", {store})` `=== false`
  and `string("sandbox.tier")` is unset/`"off"` — regression guard that the preset is inert by default.
- **AC4 (kill switch beats preset):** with `hardened:true` **and** `EAGENT_RISK_GUARD=off`,
  `enabled("risk-guard", {store}) === false` — env-veto precedence over the preset layer.
- **AC5 (no persistence):** after building a hardened host, the on-disk config store namespace has **no**
  `risk-guard`/`provenance`/`sandbox.tier` keys written (the preset is in-memory) — assert the backing
  file is unchanged / the keys absent.
- **AC6 (gates):** `npm test` 0 fail; `npm run typecheck` 0; `npm run build` 0; `npm run eval` 5/5;
  `test/kernel-surface.test.ts` green with the kernel line count **unchanged** (no kernel edit).
- **AC7 (visibility):** `createHttpServer` with hardened returns/exposes a resolved `hardened:true` (or
  the startup banner is asserted via a captured logger), so D4 is testable.
- **AC8 (fail-secure — override-store cannot weaken the preset):** with `hardened:true` **and** a
  persisted override-store `sandbox.tier="off"` (and `risk-guard=false`), assert
  `config.string("sandbox.tier") === "workspace-write"` and `enabled("risk-guard",{store}) === true` —
  the preset outranks the override-store (D2). RED before the precedence is fixed.

Quality budget: the only hot-path cost is `risk-guard`'s classifier sub-call under hardened — one extra
provider round-trip on **every `shell:exec` tool call** (it fires before the risky/safe verdict is
known, `src/extensions/risk-guard.ts:183`), scoped to shell tools only. This is a deliberate opt-in
security/latency trade (R2), not a regression on the default (non-hardened) path — declared, not excluded.

## 8. Risks and Rollback

- **R1 — sandbox tier no-ops without a backend** (fail-open). A hardened host on Linux w/o bwrap/firejail
  or on Windows classifies + injection-defends but does not filesystem-confine. Mitigation: D4 warns at
  startup; SECURITY.md documents it. Not a regression (it is the existing fail-open default). Rollback: n/a.
- **R2 — risk-guard classifier adds a provider sub-call per `shell:exec` tool call** (latency + token
  cost under hardened, shell tools only). Mitigation: documented opt-in trade; `EAGENT_RISK_GUARD=off`
  disables it even under hardened (AC4). Rollback: unset `EAGENT_HARDENED`.
- **R3 — the `LayeredConfig` preset layer touches a widely-used module.** Additive: an optional preset
  field **attached via a setter after construction** (`hardened` is resolved from the already-built
  config, so the preset is applied to that same instance, not passed to its constructor — KDD1) plus a
  lookup branch. Every existing `enabled()`/`bool()`/`string()` caller and all 8 `LayeredConfig`
  construction sites are unaffected when no preset is set. The full suite + AC3 (non-hardened unchanged)
  guard against regression. Rollback: revert the `src/config.ts` hunk (the option becomes inert).
- **R5 — the preset overrides an operator's persisted `sandbox.tier` / `/config set` (by design,
  fail-secure).** Because the preset outranks the override-store and the extension-store tier fallback
  (D2), under hardened a persisted `/config set sandbox.tier off` cannot silently defeat confinement
  (the failure the earlier draft's `override-store > preset` order allowed), but neither can a persisted
  *stricter* `/sandbox-tiers tier readonly` be honored — the preset's `workspace-write` wins. This is
  the deliberate fail-secure trade: **the env var is the single override under hardened**
  (`EAGENT_SANDBOX_TIER=readonly` to go stricter, `EAGENT_RISK_GUARD=off` to drop a guard). Documented
  in D5; asserted by AC4 (env beats preset) + AC8 (override-store does *not*). Rollback: per-key.
- **Overall rollback:** revert D1–D4 hunks across `src/host.ts`, `src/server.ts`, `src/config.ts`,
  `src/extensions/sandbox-tiers.ts`; the feature is opt-in and inert by default, so revert is clean.
  Branch `chore/production-hardening` (PR #40), not merged.
