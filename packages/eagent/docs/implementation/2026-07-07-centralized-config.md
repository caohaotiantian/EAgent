# Implementation: Centralized Configuration (`e.config`)

Slug: `2026-07-07-centralized-config`
Design doc: `docs/design/2026-07-07-centralized-config.md` (read it first).

## 1. Task Index

| Design Deliverable / AC | Design doc lines | Implemented in Phase |
|---|---|---|
| `src/config.ts` `LayeredConfig` | §2 (`src/config.ts` bullet) | P0 |
| Kernel `Config` interface + `e.config` wiring + ceiling bump | §2 (Kernel bullet), KDD-1/7 | P0 |
| `test/config.test.ts` unit tests | §7 AC 5–7 | P0 |
| `/config` command (`config-cmd.ts`) | §2 (config-cmd bullet), KDD-4/5 | P1 |
| Host/server/provider default sourcing | §2 (host/server bullet) | P1 |
| maxTurns family + agent-spawning migration + behavior test | §2 (maxTurns bullet), AC 10 | P2 |
| Guard / kill-switch migrations | §2 (exhaustive bullet), KDD-4 | P3, P4 |
| Value / dir migrations + `workspace` dedup | §2 (workspace), AC 9 | P5 |
| Remaining extensions + toggle-command migration + global invariant tests | §2, AC 7/8 | P6 |
| Docs (README/EXTENSIONS/ARCHITECTURE/CHANGELOG) | §2 (docs bullet), §6 | P7 |

`<TEST-CMD>` = `npm test` (`node --import tsx --test "test/**/*.test.ts"`).
Single-file `<ACCEPT-CMD>` form: `node --import tsx --test test/<name>.test.ts`.
Also available: `npm run typecheck`, `npm run build`, `npm run eval`.

## 2. The `Config` contract (authoritative for P0)

### 2.1 Kernel interface — `src/kernel/store.ts` (added below `Store`)

```ts
/** Layered, read-mostly configuration handed to every extension as `e.config`.
 *  Value keys resolve override > env > file > default; `enabled()` uses
 *  env-veto > override > store > default (NO file). See src/config.ts. */
export interface Config {
  get<T>(key: string, fallback: T): T;
  int(key: string, fallback: number): number;
  bool(key: string, fallback: boolean): boolean;
  string(key: string): string | undefined;
  enabled(key: string, opts?: { default?: boolean; store?: Pick<Store, "get"> }): boolean;
  set(key: string, value: string | number | boolean): void;
  unset(key: string): void;
  entries(): { key: string; value: unknown; source: "override" | "env" | "file" | "default" }[];
}
```

### 2.2 Implementation — `src/config.ts` (host, non-kernel)

- `class LayeredConfig implements Config`, constructed with
  `{ fileValues: Record<string,string|number|boolean>, overrideStore: Store }`.
  The `overrideStore` is `store.open("config")` from the host's `FileBackend`
  (persists at `~/.eagent/state/config.json`).
- **Env derivation:** `envName(key) = "EAGENT_" + key.toUpperCase().replace(/[.-]/g, "_")`.
  **`ENV_ALIASES: Record<string, string[]>`** for irregular legacy names, checked
  in addition to the derived name (first defined wins):
  - `mcp.maxReadBytes`: `["EAGENT_MAX_MCP_READ_BYTES"]`
  - `http.maxSseEventBytes`: `["EAGENT_MAX_SSE_EVENT_BYTES"]`
  - `server.maxSessions`: `["EAGENT_MAX_SESSIONS"]`
  - `server.host`: `["EAGENT_HOST"]`
  - `models.anthropic`: `["ANTHROPIC_MODEL"]`, `models.openai`: `["OPENAI_MODEL"]`,
    `models.gemini`: `["GEMINI_MODEL"]`
  - `providers.anthropic.baseUrl`: `["ANTHROPIC_BASE_URL"]`,
    `providers.openai.baseUrl`: `["OPENAI_BASE_URL"]`,
    `providers.gemini.baseUrl`: `["GEMINI_BASE_URL"]`
  A raw env read is `process.env[envName(key)] ?? <first set alias>`.
- **Value resolution** (`get`/`int`/`bool`/`string`): override store (`get(key)`)
  → env (raw string, typed-parsed) → `fileValues[key]` → fallback. `int` parses
  `Number()`, accepts finite; else fallback. `bool` true∈{`1,true,on,yes`},
  false∈{`0,false,off,no`}; else fallback. `string` returns the raw string or
  `undefined`.
- **`enabled(key, opts)`** (NO file layer):
  1. raw env for `key` `=== "off"` → `false`.
  2. else override store has `key` → coerce to bool and return it.
  3. else `opts.store` given → `Boolean(opts.store.get("enabled", opts.default ?? false))`.
  4. else `opts.default ?? false`.
- **`set`** writes the override store; **`unset`** deletes the key there.
- **`entries()`** returns, for every key ever read this process (tracked in a
  `Set` populated by the accessors) plus every key present in override/file, its
  resolved value and winning source; secret-substring keys
  (`/token|key|secret/i`) report `value: "«hidden»"`.
- The host's un-configured / env-only case is just `new LayeredConfig({
  fileValues: {}, overrideStore: new MemoryStore() })` — **no separate
  `envOnlyConfig` factory lives in `src/config.ts`** (the only `envOnlyConfig` is
  the kernel-internal one in §2.3, used solely as the `ExtensionHost` fallback).
- **File load** helper `loadConfigFile(paths: string[]): Record<string, …>`:
  read each JSON file (missing = skip, invalid = skip + return `{}` for that
  file), shallow-merge in order (project last wins).

### 2.3 Kernel wiring — `src/kernel/extension.ts`

- Extend the existing `store.js` import to also import `type Config`.
- `ExtensionAPI`: add `readonly config: Config;` (one doc line).
- `ExtensionHostOptions`: add `config?: Config;`.
- `ExtensionHost`: `readonly #config: Config;`; constructor
  `this.#config = opts.config ?? envOnlyConfig();`. `envOnlyConfig()` is a minimal
  **kernel-internal** factory defined in `src/kernel/store.ts` next to the
  `Config` interface (≤ ~12 lines, counts toward the ceiling): a `Config` whose
  value getters resolve `override(MemoryStore) > env(derived name only) > default`
  and whose `enabled()` follows the KDD-4 rule with no file layer. It is **not**
  exported from `index.ts` and **not** added to `EXPECTED_EXPORTS` — the kernel's
  public runtime surface is unchanged (design KDD-7). `extension.ts` imports it
  from `store.js` (intra-kernel) and wires `config: host.#config` into the `api`
  object. The full `LayeredConfig` in `src/config.ts` (file layer + `ENV_ALIASES`
  + `entries()` + secret-hiding) is the production implementation every real host
  constructs and passes via `opts.config`; `envOnlyConfig()` is only the
  no-config fallback used by tests that build `ExtensionHost` directly.
- `src/kernel/index.ts`: add **`export type { Config }`** to the `store.js`
  re-export block. This is type-only (erased) — no runtime key — so
  `Object.keys(kernel)` and `EXPECTED_EXPORTS` are **unchanged**.

### 2.4 Ceiling bump — `test/kernel-surface.test.ts`

Change the assertion `lines < 2200` → `lines < 2250` and the message. **Do not**
change `EXPECTED_EXPORTS` (the `Config` export is type-only; `envOnlyConfig` is
kernel-internal). Update the ceiling+actual-count sentences in `CLAUDE.md`,
`README.md`, `ARCHITECTURE.md` (P0, since the test/doc pair must stay consistent).

**Kernel line budget (must land `< 2250`).** Current summed count ≈ 2198.
Gross additions to `src/kernel/`: `Config` interface (~11) + kernel-internal
`envOnlyConfig()` (~12) + `extension.ts` wiring — import extension (0), field (1),
constructor (1), `api` wire (1) — + `index.ts` type export (1) ≈ **~27 gross →
~2250**, which fails the strict `<`. **Offset with no gutting of load-bearing comments**
(no behavior change) from `src/kernel/agent.ts`'s verbose block comments —
concrete candidates: the parenthetical W9.1 note at agent.ts:74, the
wave-shaping comment agent.ts:272–278, and the reconciliation comment
agent.ts:290–296 — to land ~2244 actual. The `test/kernel-surface.test.ts` `< 2250`
assertion is the mechanical gate that guarantees this at P0 acceptance.

> Self-containment note: keeping the single `envOnlyConfig` + the `Config`
> interface in `store.ts` avoids a kernel→host import (design KDD-7 option c,
> rejected). The full `LayeredConfig` (file + alias + entries) stays in
> `src/config.ts`; the host constructs it directly (no host-side `envOnlyConfig`).

## 3. Config-key registry (the KDD-6 migration table — authoritative for P2–P6)

Every row: **canonical key** | **type** | **default** (current value) | **legacy
env** (via derivation unless an alias is noted) | **current site**. Enablement
keys use `enabled(key, {default, store?})`; the `store?` column marks the ones
that thread an extension `store`. Grouped by migration Phase.

### P1 — host / server / providers
| key | type | default | legacy env | site |
|---|---|---|---|---|
| `agent.maxTurns` | int | 24 | `EAGENT_AGENT_MAX_TURNS` (new) | host.ts → `new Agent` |
| `agent.maxConcurrency` | int | 0 (⇒ Infinity) | new | host.ts |
| `agent.systemPrompt` | string | (kernel default) | new | host.ts |
| `thinking` | string | `off` | `EAGENT_THINKING` | host.ts:224 |
| `models.anthropic` | string | `claude-fable-5` | alias `ANTHROPIC_MODEL` | host.ts:204 |
| `models.openai` | string | `gpt-4o` | alias `OPENAI_MODEL` | host.ts:206 |
| `models.gemini` | string | `gemini-2.0-flash` | alias `GEMINI_MODEL` | host.ts:208 |
| `providers.*.baseUrl` | string | (provider default) | alias `*_BASE_URL` | host → provider `opts.baseUrl` |
| `http.maxSseEventBytes` | int | 16 MiB | alias `EAGENT_MAX_SSE_EVENT_BYTES` | host → provider → http.ts (http keeps env fallback) |
| `server.host` | string | `127.0.0.1` | alias `EAGENT_HOST` | server.ts:95,476 |
| `server.maxSessions` | int | 1000 | alias `EAGENT_MAX_SESSIONS` | server.ts:454 |

### P2 — agent-spawning + maxTurns
| key | type | default | legacy env | site |
|---|---|---|---|---|
| `subagents.maxTurns` | int | 8 | `EAGENT_SUBAGENTS_MAX_TURNS` (new; was `DEFAULT_MAX_TURNS`) | subagents.ts:47,200 |
| `subagents.lp` | enabled | on | `EAGENT_SUBAGENTS_LP` | subagents.ts:40 |
| `teams` | enabled | on | `EAGENT_TEAMS` | teams.ts:130 |
| `teams.dir` | string | `~/.eagent/teams` | `EAGENT_TEAMS_DIR` | teams.ts:125 |
| `teams.lead.maxTurns` | int | 16 | new (`LEAD_MAX_TURNS`) | teams.ts:109 |
| `teams.member.maxTurns` | int | 8 | new (`MEMBER_MAX_TURNS`) | teams.ts:113 |
| `sweep-edit` | enabled | on | `EAGENT_SWEEP_EDIT` | sweep-edit.ts:138 |
| `sweep-edit.maxTurns` | int | 8 | new (`DEFAULT_MAX_TURNS`) | sweep-edit.ts:40 |
| `dynamic-workflow.maxTurns` | int | 8 | new (`DEFAULT_AGENT_MAX_TURNS`) | dynamic-workflow.ts:48 |
| `templates` | enabled | on | `EAGENT_TEMPLATES` | templates.ts:94 |
| `templates.dir` | string | `~/.eagent/templates` | `EAGENT_TEMPLATES_DIR` | templates.ts:89 |

### P3 — guards / default-on kill switches (thread `store` where noted)
| key | type | default | store? | site |
|---|---|---|---|---|
| `content-guard` | enabled | on | yes (default-on) | content-guard.ts:103 |
| `secret-guard` | enabled | on | yes (default-on) | secret-guard.ts:109 |
| `provenance` | enabled | on | yes | provenance.ts:75 |
| `flow-guard` | enabled | on | yes (default-on) | flow-guard.ts:81 |
| `risk-guard` | enabled | off | yes (opt-in) | risk-guard.ts:98 |
| `risk-guard.timeoutMs` | int | 10000 | — | risk-guard.ts:38 |
| `write-guard` | enabled | on | — | write-guard.ts:60 |
| `circuit-breaker` | enabled | on | yes (default-on) | circuit-breaker.ts:81 |
| `decode.normalize` | enabled | on | — | risk-guard.ts:128, bash-policy.ts:619 |

### P4 — behavior / opt-in kill switches
| key | type | default | store? | site |
|---|---|---|---|---|
| `compact` | enabled | off | yes | compact.ts:169 |
| `prune` | enabled | on | — | prune.ts:51 |
| `recovery` | enabled | on | — | recovery.ts:103 |
| `drift-probe` | enabled | off | yes | drift-probe.ts:224 |
| `handoff` | enabled | off | yes | handoff.ts:425 |
| `handoff.resume` | enabled | off | yes | handoff.ts:435 |
| `reliability` | enabled | on | — | reliability.ts:83 |
| `routing` | enabled | on | — | routing.ts:195 |
| `fallback-routing` | enabled | on | — | fallback-routing.ts:160 |
| `output-contract` | enabled | on | — | output-contract.ts:99 |
| `citations` | enabled | on | — | citations.ts:91 |
| `reasoning-search` | enabled | on | — | reasoning-search.ts:171 |
| `time-travel` | enabled | on | — | time-travel.ts:59 |
| `skill-triggers` | enabled | on | — | skills-hardening.ts:294 |
| `web.paginate` | enabled | on | — | web.ts:114 |
| `cost` | enabled | on | yes | cost.ts:163 (`EAGENT_COST`; added post-draft) |

### P5 — values / dirs + `workspace` dedup
| key | type | default | legacy env | site(s) |
|---|---|---|---|---|
| `workspace` | string | `cwd()` | `EAGENT_WORKSPACE` | core-tools.ts:23, search.ts:26, write-guard.ts:30, limits.ts:60, handoff.ts:217, self.ts:37, context-files.ts:53, checkpoint.ts:67, microagents.ts:182, self-improve.ts:260,263, time-travel.ts:69, **lib/sandbox.ts:33** (param) |
| `skills.dir` | string | `~/.eagent/skills` | `EAGENT_SKILLS_DIR` | skills.ts:33 |
| `packages.dir` | string | `~/.eagent/packages` | `EAGENT_PACKAGES_DIR` | packages.ts:393 |
| `microagents` | enabled | on | `EAGENT_MICROAGENTS` | microagents.ts:117 |
| `microagents.dir` | string | `$workspace/.eagent/microagents` | `EAGENT_MICROAGENTS_DIR` | microagents.ts:182 |
| `time-travel.dir` | string | `$workspace/.eagent/timetravel` | `EAGENT_TIME_TRAVEL_DIR` | time-travel.ts:69 |
| `memory.entries` | enabled | on | `EAGENT_MEMORY_ENTRIES` | memory.ts:68 |
| `memory.embed` | enabled | on | `EAGENT_MEMORY_EMBED` | memory.ts:174 |
| `memory.embed.endpoint` | string | (unset) | `EAGENT_MEMORY_EMBED_ENDPOINT` | memory.ts:149 |
| `memory.embed.model` | string | `text-embedding-3-small` | `EAGENT_MEMORY_EMBED_MODEL` | memory.ts:151 |
| `memory.promoteAt` | int | 0 | `EAGENT_MEMORY_PROMOTE_AT` | memory.ts:241 |
| `checkpoint` | enabled | on | `EAGENT_CHECKPOINT` | checkpoint.ts:63 |
| `self-improve` | enabled | on | `EAGENT_SELF_IMPROVE` | self-improve.ts:253 |

(`EAGENT_MEMORY_EMBED_API_KEY`, memory.ts:152 — **secret, NOT migrated**, allowlisted in the completeness scan.)

### P6 — remaining + toggle-command migration + lib/otel
| key | type | default | legacy env | site |
|---|---|---|---|---|
| `mcp.resources` | enabled | on | `EAGENT_MCP_RESOURCES` | mcp.ts:498 |
| `mcp.servers` | string | (unset) | `EAGENT_MCP_SERVERS` | mcp.ts:541 |
| `mcp.maxReadBytes` | int | 16 MiB | alias `EAGENT_MAX_MCP_READ_BYTES` | mcp.ts:153 |
| `codeact.tier` | string | (store/`off`) | `EAGENT_CODEACT_TIER` | codeact.ts:193 |
| `sandbox.backend` | string | (detect) | `EAGENT_SANDBOX_BACKEND` | codeact.ts:199, sandbox-tiers.ts:83 |
| `evals` | enabled | on | `EAGENT_EVALS` | evals.ts:308 |
| `env-report` | enabled | on | `EAGENT_ENV_REPORT` | env-report.ts:136 |
| `goal` | enabled | on | `EAGENT_GOAL` | goal.ts:300 |
| `journal` | string+enable | `~/.eagent/journal.jsonl` | `EAGENT_JOURNAL` | journal.ts:28,31 |
| `reliability` (dup covered P4) | — | — | — | — |
| `otel` | enabled | on | `EAGENT_OTEL` | otel-exporter.ts:145 |
| `otel.propagateHosts` | string | `""` | `EAGENT_OTEL_PROPAGATE_HOSTS` | **lib/otel-context.ts:39** (param) |
| `ask` | enabled | on | `EAGENT_ASK` | ask.ts:53 |
| `tool-spill` | enabled | on | `EAGENT_TOOL_SPILL` | limits.ts:130 |
| `frontend` | string | (unset) | `EAGENT_FRONTEND` | headless-flags.ts:338 |
| **toggle-command migrations** (`/x on\|off` → `config.set`; §2 KDD-4): | | | | |
| `bash-policy` | enabled | on | `EAGENT_BASH_POLICY` | bash-policy.ts:587,656,660 |
| `sandbox-tiers` | enabled | on | `EAGENT_SANDBOX_TIERS` | sandbox-tiers.ts:75,197,201 |
| `budget-cap` | enabled | on | `EAGENT_BUDGET_CAP` | budget-cap.ts:224,430,435 |
| `config-hooks` | enabled | off | `EAGENT_CONFIG_HOOKS` | config-hooks.ts:431,647 |
| `headless-flags` | enabled | on | `EAGENT_HEADLESS_FLAGS` | headless-flags.ts:388,433,437 |
| `headless` | string | `auto` | `EAGENT_HEADLESS` | headless-flags.ts:338,443,445 (`force` sub-cmd → `set`/`unset`) |

> This table is the single source for AC 6 (defaults resolve), AC 7 (each legacy
> env changes the value), and AC 8 (nothing outside it/the secret allowlist keeps
> a `process.env.EAGENT_` read). Any `EAGENT_*` var in the design inventory not in
> a row above **stays a secret** (the two) or is a non-EAgent/system var (§3.2 of
> the design). If an implementer finds an `EAGENT_` read matching none of these,
> STOP and push back to L1 — do not invent a key.

## 4. Phase Breakdown

### Phase 0 — Facility + kernel wiring + unit tests

- **Entry:** clean tree on the working branch.
- **Design refs:** §2 (config.ts + kernel bullets), KDD-1/4/5/7, §7 AC 5–7.
- **Tasks (TDD order):**
  1. *(test)* `test/config.test.ts`: assert value precedence override > env > file
     > default (business invariant: a runtime override beats an env var beats a
     project file beats the code default); `int`/`bool` parse + invalid→fallback;
     `enabled()` (i) env `"off"` → false regardless of override/store/default,
     (ii) override honored, (iii) `store.get("enabled", default)` incl.
     store-empty-uses-default (a default-`true` gate stays true unset), (iv) the
     **config file is ignored for enablement** but `set()` is honored; `envName`
     derivation + each `ENV_ALIASES` entry resolves; `entries()` reports the
     winning source and hides secret-substring keys.
  2. *(test)* `test/config.test.ts`: `envOnlyConfig()` returns code defaults with
     no env/file/override (invariant: an un-configured host is unchanged).
  3. *(impl)* `src/config.ts` per §2.2.
  4. *(impl)* `src/kernel/store.ts`: add `Config` interface + `envOnlyConfig()`.
  5. *(impl)* `src/kernel/extension.ts`: `e.config` wiring per §2.3.
  6. *(impl)* `src/kernel/index.ts`: add `export type { Config }` only (no runtime
     export; `EXPECTED_EXPORTS` unchanged).
  7. *(impl)* `test/kernel-surface.test.ts`: ceiling `< 2250` + message only —
     **leave `EXPECTED_EXPORTS` unchanged** (§2.4). Apply the ≥ 4-line comment
     golf (§2.4). Update ceiling+count sentences in CLAUDE.md/README.md/
     ARCHITECTURE.md.
  8. *(impl)* `src/host.ts`: construct `LayeredConfig` (file paths
     `~/.eagent/config.json`, `./.eagent/config.json`; override store
     `store.open("config")`) and pass `config` to `new ExtensionHost({...})`. No
     extension migrations yet.
- **Acceptance:**
  - `node --import tsx --test test/config.test.ts` — pass.
  - `node --import tsx --test test/kernel-surface.test.ts` — pass (ceiling+exports).
  - `npm run typecheck` — exit 0.
  - `npm test` — exit 0 (nothing else changed behavior).
- **Exit:** `e.config` is injected and unit-tested; the whole suite is green;
  kernel line count < 2250.

### Phase 1 — `/config` command + host/server/provider defaults

- **Entry:** P0 exit.
- **Design refs:** §2 (config-cmd + host/server bullets), KDD-4/5; registry §3 P1.
- **Tasks (TDD order):**
  1. *(test)* `test/config-cmd.test.ts`: `/config list` prints resolved value +
     source for a value key and omits/hides a secret-substring key; `/config set
     k v` then `/config get k` reflects the override; `/config set` of an
     enablement key updates `enabled()`; `EAGENT_CONFIG=off` makes the command
     inert (invariant: the command reads/writes the injected config, not env).
  2. *(test)* `test/host-config.test.ts` (new): `createAgentHost` with
     `EAGENT_AGENT_MAX_TURNS=5` (mock provider, offline) yields
     `host.agent.maxTurns === 5`, and unset yields the default 24 (invariant: the
     host sources agent defaults from config end-to-end). Provider-model alias
     resolution (`models.anthropic` ← `ANTHROPIC_MODEL`) is covered at the
     `LayeredConfig` level in P0's `test/config.test.ts` — not asserted here,
     because forcing a live provider offline is impossible (the host fail-fasts
     without an API key).
  3. *(impl)* `src/extensions/config-cmd.ts`; append `["config", configCmd]` to
     `BUILTIN_EXTENSIONS` in `src/host.ts`.
  4. *(impl)* `src/host.ts`: source `agent.maxTurns`/`maxConcurrency`/
     `systemPrompt`/`thinking` and `models.*`/`providers.*.baseUrl` from config
     (registry §3 P1); pass `http.maxSseEventBytes` into provider construction.
  5. *(impl)* `src/server.ts`: source `server.host`/`server.maxSessions` from
     config (keep `EAGENT_TOKEN` a direct secret read).
- **Acceptance:**
  - `node --import tsx --test test/config-cmd.test.ts` — pass.
  - `node --import tsx --test test/host-config.test.ts` — pass.
  - `npm test` — exit 0.
- **Exit:** `/config` works; host/server/provider defaults flow from config.

### Phase 2 — agent-spawning + maxTurns family

- **Entry:** P1 exit. **Design refs:** §2 (maxTurns bullet), AC 10; registry §3 P2.
- **Tasks (TDD order):**
  1. *(test)* `test/subagents.test.ts` (extend): with `EAGENT_SUBAGENTS_MAX_TURNS=3`
     a spawned child is constructed with `maxTurns === 3` (AC 10 — the request's
     use case; invariant: the spawn turn-bound is config-driven, default 8
     preserved when unset).
  2. *(test)* `test/teams.test.ts` / `test/sweep-edit.test.ts` /
     `test/dynamic-workflow.test.ts`: the lead/member/sweep/workflow child
     turn-bounds read their config keys, defaults unchanged when unset.
  3. *(impl)* migrate `subagents.ts`, `teams.ts`, `sweep-edit.ts`,
     `dynamic-workflow.ts`, `templates.ts` to `e.config` per registry §3 P2
     (replace the `DEFAULT_*_MAX_TURNS`/`LEAD_*`/`MEMBER_*` consts and the
     `process.env` reads; keep each value as the inline default).
- **Acceptance:** the four/five touched test files pass individually via
  `node --import tsx --test test/<file>.test.ts`; `npm test` — exit 0.
- **Exit:** every `maxTurns` is config-settable; agent-spawning extensions read no
  `process.env.EAGENT_*`.

### Phase 3 — guards / default-on kill switches

- **Entry:** P2 exit. **Design refs:** KDD-4; registry §3 P3.
- **Tasks (TDD order):**
  1. *(test)* for each migrated guard, extend its test to assert `enabled()`
     fidelity: env `EAGENT_X=off` disables; the store `enabled` flag still toggles
     it (default-on stays on when the key is unset — the store-default path);
     invariant: the two-level gate is unchanged.
  2. *(impl)* migrate `content-guard`, `secret-guard`, `provenance`, `flow-guard`,
     `risk-guard` (+ `risk-guard.timeoutMs`), `write-guard`, `circuit-breaker`,
     and the `decode.normalize` reads (bash-policy/risk-guard) per registry §3 P3.
- **Acceptance:** each touched test file passes individually; `npm test` — exit 0.
- **Exit:** guard group reads config; enablement semantics identical.

### Phase 4 — behavior / opt-in kill switches

- **Entry:** P3 exit. **Design refs:** KDD-4; registry §3 P4.
- **Tasks (TDD order):**
  1. *(test)* for each, assert env-off disables and (opt-in) the store `enabled`
     flag gates as before.
  2. *(impl)* migrate `compact`, `prune`, `recovery`, `drift-probe`, `handoff`
     (+`handoff.resume`), `reliability`, `routing`, `fallback-routing`,
     `output-contract`, `citations`, `reasoning-search`, `time-travel`,
     `skills-hardening` (`skill-triggers`), `web` (`web.paginate`) per §3 P4.
- **Acceptance:** touched test files pass individually; `npm test` — exit 0.
- **Exit:** behavior-extension group reads config.

### Phase 5 — values / dirs + `workspace` dedup

- **Entry:** P4 exit. **Design refs:** §2 (workspace), AC 9; registry §3 P5.
- **Tasks (TDD order):**
  1. *(test)* `test/config-workspace.test.ts` (new): setting `EAGENT_WORKSPACE`
     (and `/config set workspace <dir>`) changes the workspace root resolved by a
     representative consumer of each family (a core-tools read path, a
     `lib/sandbox.ts` call) — invariant: one `workspace` key drives all consumers.
  2. *(test)* extend `memory`/`skills`/`checkpoint`/`microagents` tests for their
     dir/threshold keys (defaults preserved; env override honored).
  3. *(impl)* migrate the P5 registry rows; convert `lib/sandbox.ts` to take the
     workspace as a **parameter** from its extension callers (which pass
     `e.config.string("workspace") ?? cwd()`); no `lib/` env read remains.
- **Acceptance:** `node --import tsx --test test/config-workspace.test.ts` +
  touched files pass; `npm test` — exit 0.
- **Exit:** `workspace` is a single key; value/dir group reads config.

### Phase 6 — remaining extensions + toggle commands + global invariants

- **Entry:** P5 exit. **Design refs:** §2, AC 7/8, KDD-4; registry §3 P6.
- **Tasks (TDD order):**
  1. *(test)* `test/config-backcompat.test.ts` (new): data-driven over the full
     registry §3 (+`ENV_ALIASES`) — for each legacy env name, setting it changes
     the corresponding accessor's result (AC 7).
  2. *(test)* `test/config-completeness.test.ts` (new): scan `src/extensions/**`,
     `src/host.ts`, `src/server.ts`, `src/providers/**` — zero literal
     `process.env.EAGENT_*` **assignments** (exclude `host.ts` `.env` loader) and
     zero `process.env.EAGENT_*` **reads** except the 4-item allowlist (AC 8).
  3. *(test)* for the five toggle commands, assert `/x off` then `enabled()` is
     false via the override (not an env write), and a `process.env` write no longer
     occurs (spy/inspect); `/x on` sets the override true and notes an active
     env-off (invariant: toggles persist; env-off stays a hard veto).
  4. *(impl)* migrate the remaining P6 registry rows: `mcp` (+`maxReadBytes`,
     `servers`, `resources`), `codeact`/`sandbox-tiers` (`sandbox.backend`,
     `codeact.tier`), `evals`, `env-report`, `goal`, `journal`, `otel`
     (+`lib/otel-context.ts` param), `ask`, `limits` (`tool-spill`), `frontend`;
     and the five toggle commands (`bash-policy`, `sandbox-tiers`, `budget-cap`,
     `config-hooks`, `headless-flags` incl. the `force` value path) to
     `config.set`/`config.unset`.
- **Acceptance:**
  - `node --import tsx --test test/config-backcompat.test.ts` — pass.
  - `node --import tsx --test test/config-completeness.test.ts` — pass.
  - `npm test` — exit 0; `npm run typecheck` — exit 0; `npm run build` — exit 0;
    `npm run eval` — exit 0.
- **Exit:** exhaustive migration complete; the completeness + back-compat
  invariants hold; whole suite + build + eval green.

### Phase 7 — documentation

- **Entry:** P6 exit. **Design refs:** §2 (docs bullet), §6.
- **Tasks:**
  1. *(impl)* `README.md`: a "Configuration" section (precedence, `/config`, the
     key convention, the `.eagent/config.json` file) + confirm ceiling/count
     sentence updated. Extension-table rows for the new `config` extension.
  2. *(impl)* `docs/EXTENSIONS.md`: document `e.config` (peer to `e.store`),
     `enabled()` semantics, the value-vs-enablement layer rule.
  3. *(impl)* `ARCHITECTURE.md`: add `config` to the `ExtensionAPI` members list
     and `Config` to the supporting modules; confirm the ceiling/count.
  4. *(impl)* `CHANGELOG.md`: `Unreleased` entry — the facility, the `/config`
     command, the exhaustive migration, and the `/x off` persistence + hard
     env-off-veto behavior change (KDD-4).
- **Acceptance (all mechanical):**
  - `npm test` — exit 0 (docs don't affect tests).
  - `grep -a -l 2250 README.md ARCHITECTURE.md CLAUDE.md` lists all three
    (each states the new ceiling).
  - `grep -aErq "2,?200[- ]line|< *2200" README.md ARCHITECTURE.md CLAUDE.md; test $? -eq 1`
    (no stale `2200` ceiling claim remains — grep exits 1 = no match).
- **Exit:** docs reconciled with the code.

## 5. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" — ESM `.js` specifiers even
  for `.ts`; strict TS (`noUncheckedIndexedAccess` etc.), no `any`; **zero runtime
  deps except `jiti`** (config uses only `node:fs`/`JSON`/`process.env`); every
  extension capability-gated + offline-tested; **no Claude attribution in
  commits**. `config-cmd.ts` registers a command only (no privileged tool → no new
  capability); its `/config set` writes the override store.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md "Commit conventions" — `feat(phaseN):` /
  `fix(phaseN-roundR): <keyword>`, `<TEST-CMD>`/`<ACCEPT-CMD>` result trailers,
  **no AI/tooling mention**, land on a `chore/<slug>` branch, PR to `init`.
- **macOS grep:** source has non-ASCII glyphs — the completeness scan (P6) and any
  audit use `grep -a` or read files directly.
- **Test files are untypechecked** (`tsconfig` excludes `test/`; `npm test` is
  transpile-only) — verify test-file types by running them, not `tsc`.

## 6. Data and Fixture Dependencies

- No new external fixtures. Config unit tests construct `LayeredConfig` with
  in-memory `fileValues` + a `MemoryStore` override; env-layer tests set/restore
  `process.env` keys within the test (save/delete in a `finally`).
- Extension tests reuse each extension's existing offline harness; where a test
  currently mutates `process.env.EAGENT_X`, it may keep doing so (env is a valid
  config layer) **or** switch to constructing the extension with a `LayeredConfig`
  that has the override/file preset — either is acceptable; prefer the latter for
  new assertions to avoid global-state coupling.
- The completeness/back-compat tests are pure source scans / table drivers — no
  fixtures.

## 7. Regression Protection

- Every Phase ends with full `npm test` green — all prior-Phase extension tests,
  the kernel suite, and `test/config*.test.ts` must stay green.
- P0's `test/kernel-surface.test.ts` (exports + ceiling) and `test/config.test.ts`
  are load-bearing invariants re-run every subsequent Phase.
- P2's AC-10 behavior test, P5's workspace-dedup test, and P6's completeness +
  back-compat tests, once added, are permanent regression gates.
- `npm run eval` (offline evals) runs at P6 to catch any agent-loop behavior drift
  from the host default sourcing.
</content>
