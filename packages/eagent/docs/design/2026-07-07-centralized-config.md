# Design: Centralized Configuration (`e.config`)

Slug: `2026-07-07-centralized-config`
Status: implemented (pending commit on `chore/centralized-config`)
Closed-on: 2026-07-07
Result: L1→L2→L3→F all passed fresh-reviewer gates. Facility + `/config` + exhaustive
migration of every `EAGENT_*` read (except the two secrets) landed; kernel 2244/2250;
`npm test` 1238 pass, build + eval green. The F review caught two severe defects
(config-hooks toggle asymmetry; `/config get` secret leak) — both fixed with regression
tests and corroborated. Deferred: none.

## 1. Background and Purpose

EAgent's configuration is read at **many independent, isolated sites, each with
its own ad-hoc mechanism**. A full inventory of `src/` (see the appendix) finds:

- **70 distinct `EAGENT_*` environment variables**, read directly via
  `process.env.EAGENT_*` at extension-activation or tool-execution time, spread
  across ~50 extensions plus `host.ts`/`server.ts`/`providers/`.
- **~130 hard-coded module-level tunable constants** (turn caps, byte caps,
  timeouts, thresholds, default model names, directories), each private to one
  file and un-overridable without editing source.
- **~30 store-backed enable/config flags** (`e.store.get("enabled")`, `mode`,
  numeric caps) — the runtime-toggle half of a two-level gate.

Four concrete problems follow:

1. **No single source of truth / zero discoverability.** To learn the knobs a
   developer must grep 50+ files. There is no command or file that lists them.
2. **Inconsistent precedence and parsing.** Enablement is variously `env !==
   "off"`, `env === "off"`, `env !== "off" AND store.enabled`, or store-only.
   Numbers are parsed by `Number()`, `Number() || 0`, `?? default`, each
   re-implemented per site.
3. **Duplicated, un-tunable defaults.** The exact pain in the request: the
   `maxTurns` bound is hard-coded across **four extensions (five values)** —
   `subagents` (8), `teams` lead (16) / member (8), `sweep-edit` (8),
   `dynamic-workflow` (8) — with no shared default and no way to set one per
   agent without editing source.
4. **Process-global coupling.** Reading `process.env` inside `activate()` makes
   tests mutate and restore global state, which is fragile and order-dependent.

**If we do nothing**, every new extension adds another isolated `process.env`
read and another hard-coded constant; the surface keeps growing and stays
undiscoverable and untestable, and "set `maxTurns` for a default extension
during development" continues to require a source edit and rebuild.

**Purpose:** introduce one layered configuration facility, `e.config`, that
every extension (and the host) reads through, with a deterministic precedence
chain, unified parsing, back-compatible env-var names, and a `/config` command
for discovery and runtime override.

## 2. Deliverables

- [ ] `src/config.ts` (host-level, non-kernel): `LayeredConfig` implementing the
      kernel `Config` interface — precedence **override > env > file > default**
      for value keys; typed accessors (`get`/`int`/`bool`/`string`/`enabled`/
      `set`/`entries`); an env-name derivation convention plus an explicit
      legacy-alias map; and an env-only default config used when a host supplies
      none (so an un-configured host behaves exactly as today). Pure,
      unit-tested, offline.
- [ ] Kernel: a `Config` interface in `src/kernel/store.ts` (co-located with
      `Store`, referencing `Store`); `readonly config: Config` added to
      `ExtensionAPI` and `config?: Config` to `ExtensionHostOptions` in
      `src/kernel/extension.ts`, wired into the per-extension `api` object;
      `export type { Config }` from `src/kernel/index.ts`. The kernel line
      ceiling moves from 2200 to **2250** as the deliberate, documented decision
      of KDD-7; the committed net add (interface + a kernel-internal
      `envOnlyConfig` fallback + wiring, offset by no gutting of load-bearing comments; see
      the L2 §2.4 budget) lands the summed count ~2244 actual — under 2250, avoiding
      any strict-`<` off-by-one. `Object.keys(kernel)` is unchanged (the `Config`
      export is type-only).
- [ ] `src/extensions/config-cmd.ts`: a new built-in exposing `/config`
      (`list`/`get <key>`/`set <key> <value>`/`unset <key>`/`reload`), showing
      each **value** key's resolved value and winning source, and each
      extension's enablement state. `/config set` writes the persisted runtime
      **override** layer (KDD-5); it may set both value keys and enablement keys
      (both are trusted, interactive writes — the untrusted vector is the config
      *file*, which KDD-4 excludes from enablement). Secret-substring keys
      (`*token*`/`*key*`/`*secret*`) are never printed. Appended to
      `BUILTIN_EXTENSIONS`; carries an `EAGENT_CONFIG=off` kill switch.
- [ ] The five extensions whose `/x on|off` command currently toggles by
      **writing/deleting `process.env.EAGENT_*`** (`bash-policy`, `headless-flags`,
      `budget-cap`, `sandbox-tiers`, and `config-hooks`' `on`-branch `delete`) are
      migrated so those commands call `e.config.set(key, …)` (the persisted
      override) instead of mutating `process.env` (`/x off` → `set(key,false)`,
      `/x on` → `set(key,true)`). Two documented, intentional consequences
      (KDD-4): a runtime `/x off` now **persists** across restarts (was
      process-local); and `/x on` no longer clears a real-environment
      `EAGENT_X=off` (env-off is a hard veto above the override). This removes
      every literal `process.env.EAGENT_*` *assignment* from `src/` (the dynamic
      `.env` loader at `host.ts:308`, `process.env[key]=…`, is the sanctioned
      env-entry bridge and is out of scope). Note `headless-flags` mutates **two**
      vars: the boolean kill switch `EAGENT_HEADLESS_FLAGS` (→ `set(key,bool)`) and
      the tri-state value `EAGENT_HEADLESS` written by its `force on|off|auto`
      sub-command (→ `config.set("headless", …)` for on/off and `config.unset` /
      the default for `auto`).
- [ ] `src/host.ts` + `src/server.ts`: construct one `LayeredConfig`, pass it to
      `ExtensionHost`, and source from it — the agent defaults (`agent.maxTurns`,
      `agent.maxConcurrency`, `agent.systemPrompt`, `thinking`), the provider
      **default models** (`ANTHROPIC_MODEL`/`OPENAI_MODEL`/`GEMINI_MODEL`,
      resolved in `host.ts` and set on `agent.model` — **not** via provider
      `opts`), provider **base URLs** (passed through the existing provider
      `opts.baseUrl` seam), the SSE cap (passed to providers → `http.ts` as an
      override, `http.ts` keeping its env read as the fallback), and the server
      knobs `server.host` / `server.maxSessions`.
- [ ] Exhaustive migration of **every `EAGENT_*` read except the two secrets**
      (KDD-6 / §3) to `e.config` (extensions) or the host config object
      (host/server/providers), preserving every current default and value-read
      behavior and honoring every legacy env-var name via the alias map. The
      *only* intentional behavior changes are the two enablement-toggle
      consequences for the five env-mutation commands (persistence + hard env-off
      veto), documented in KDD-4 and §8.
- [ ] `lib/` helpers that currently read env — `lib/sandbox.ts` →
      `EAGENT_WORKSPACE` and `lib/otel-context.ts` → `EAGENT_OTEL_PROPAGATE_HOSTS`
      (these are the only two `lib/` env reads; `EAGENT_DECODE_NORMALIZE` is read
      **inline in `bash-policy.ts:619` / `risk-guard.ts:128`**, not in
      `lib/decode.ts`, so it migrates in-place through those extensions'
      `e.config`) — take the resolved value as a **parameter** from their
      extension caller (which has `e.config`); no `lib/` file reads
      `process.env.EAGENT_*` after migration.
- [ ] Migration of the **enumerated operational-tunable constants** to config
      keys whose inline default is the current constant value — the exact list is
      the L2 migration table (KDD-6). It **must** include: the five `maxTurns`
      values (across four extensions) unified onto distinct, independently-settable
      keys (`subagents.maxTurns`, `teams.lead.maxTurns`, `teams.member.maxTurns`,
      `sweep-edit.maxTurns`, `dynamic-workflow.maxTurns`), the kernel default
      `agent.maxTurns` (24, host-sourced), the single `workspace` key that
      collapses the ~12 `EAGENT_WORKSPACE` reads, and every constant that already
      had an env var or a store setter.
- [ ] Tests (see §7 for the exact assertions): `test/config.test.ts`; a
      back-compat matrix; a completeness scan; a `workspace`-dedup test; updated
      extension tests that drive config instead of `process.env`; kernel-surface
      + (bumped) ceiling tests green.
- [ ] Docs: a new "Configuration" section in `README.md`; the `Config` API in
      `docs/EXTENSIONS.md`; the `ExtensionAPI`-members and supporting-module lists
      in `ARCHITECTURE.md`. The kernel-ceiling **and co-stated actual-count/slack**
      figures are updated to the new ceiling **2250** (and the new ~count) in all
      three places that state them: `CLAUDE.md` ("currently ~2,198 — one to two
      lines of slack"), `README.md:10-11` ("~2,200 lines, held just under a hard
      2,200-line ceiling"), and `ARCHITECTURE.md:348`. Plus a `CHANGELOG.md`
      entry noting the `/x off` persistence change (KDD-4).

## 3. Scope Boundary (explicit non-goals)

**In scope:** the migration boundary is **every `EAGENT_*` read except secrets**,
plus the host-level agent/provider/server defaults, plus the enumerated
operational-tunable constants (KDD-6).

**NOT in scope:**

1. **The two `EAGENT_*` secrets stay direct `process.env` reads.**
   `EAGENT_TOKEN` (server auth) and `EAGENT_MEMORY_EMBED_API_KEY`
   (`memory.ts:152`) are **not** migrated — config must never surface a secret
   via `/config list`. These are the *only* EAGENT-namespaced reads left out;
   both are explicitly allowlisted in the completeness scan (AC 8). (Non-EAGENT
   secrets — `*_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GOOGLE_API_KEY` — are likewise
   untouched.)
2. **Non-EAgent system / transport env stays direct.** `PATH`, `ComSpec`,
   `PORT`, and the OTel-standard names (`OTEL_EXPORTER_OTLP_*`) are external
   conventions, not EAgent config, and are not `EAGENT_`-prefixed; they remain
   direct reads. `EAGENT_OTEL` and `EAGENT_OTEL_PROPAGATE_HOSTS` **are** EAgent
   vars and **do** migrate.
3. **`providers/http.ts` keeps its env read as a fallback.**
   `EAGENT_MAX_SSE_EVENT_BYTES` is migrated by the host passing a config-sourced
   override into provider construction → `http.ts`; `http.ts` retains
   `process.env.EAGENT_MAX_SSE_EVENT_BYTES` as the ultimate fallback so a
   provider constructed without the host (tests) is unchanged. Not a carve-out
   from centralization — the config value wins when present.
4. **Pre-existing store-only rich config is not relocated.** Extensions that
   expose namespaced, command-settable numeric/string config purely via their own
   `store` (e.g. `budget-cap` USD caps, `limits`' six keys, `memory` caps set by
   slash commands) keep those **store** reads. Only their **env** half migrates.
   The store remains the runtime-toggle mechanism; `config.enabled(key, {store})`
   unifies the env+store two-level gate without moving persisted state (KDD-4).
   This deliberately avoids a data migration of `~/.eagent/state/*.json`.
5. **No new file format or live-watching.** Config file is flat JSON at the
   existing `.eagent/` paths, re-read on `/config reload` only (mirrors
   `config-hooks`). No YAML/TOML (would add a dependency), no nested objects, no
   fs-watch.
6. **No config schema/validation DSL** beyond the typed accessors.
7. **Algorithm-internal constants are not exposed** (KDD-6): protocol/schema
   versions (`mcp.ts PROTOCOL_VERSION`, `session.ts SESSION_VERSION`), scoring
   weights (`drift-probe` `W_*`, `cost` multipliers), and hard safety ceilings
   (`agent.ts MAX_PROVIDER_RETRIES`, `reasoning-search HARD_MAX_NODES`) stay
   plain constants — invariants, not operator knobs.

## 4. Key Design Decisions

### KDD-1 — Facility placement: a first-class `e.config` on `ExtensionAPI`

- **Problem:** where does centralized config live so every extension reads it
  uniformly?
- **Options:** (a) **`readonly config: Config` on `ExtensionAPI`**, peer to
  `e.store`/`e.log`, built once by the host and injected *[chosen]*; (b) a shared
  `src/extensions/lib/config.ts` reader imported by each extension (zero kernel
  change); (c) a new eighth kernel primitive.
- **Choice & rationale:** (a). Config is cross-cutting infrastructure of exactly
  the same class as `store` and `log`, already injected on `ExtensionAPI` as
  *supporting* concerns (not among the seven primitives). Injected config is
  per-host, swappable, and unit-testable without touching `process.env`. The user
  explicitly selected this option accepting the kernel cost.
- **Why (b) rejected:** a module singleton reading `process.env`/files lazily is
  the "pervasive global mutable state" `store.ts` explicitly rejects; not
  injected, so tests still mutate global state and a host cannot supply an
  alternate config.
- **Why (c) rejected:** it would break "seven primitives and nothing more" and
  cost more kernel lines than a supporting interface.

### KDD-2 — Config is a shared, non-namespaced key space with dotted keys

- **Problem:** `store` is namespaced per extension id. Should `config` be too?
- **Options:** (a) global dotted key space, extensions pass full keys
  (`e.config.int("subagents.maxTurns", 8)`) *[chosen]*; (b) per-extension
  namespaced view auto-prefixed by id.
- **Choice & rationale:** (a). Config is deliberately **cross-cutting**: shared
  keys like `agent.maxTurns` and `workspace` are read by several extensions and
  the host, and `/config list` must present one flat, greppable namespace that
  maps 1:1 to env var names. Auto-prefixing makes shared keys awkward and creates
  "prefixed or absolute?" ambiguity.
- **Why (b) rejected:** `store`'s per-extension isolation prevents cross-extension
  state coupling; config's value is the opposite — a shared, discoverable
  namespace.

### KDD-3 — Key ⇄ env-var mapping: convention + explicit legacy-alias map

- **Problem:** a dotted key must resolve an env var, but ~10 legacy names are
  irregular (`EAGENT_MAX_MCP_READ_BYTES` for `mcp.maxReadBytes`;
  `EAGENT_SUBAGENTS_LP` for `subagents.lp`).
- **Options:** (a) pure convention `foo.bar` → `EAGENT_FOO_BAR` only; (b)
  per-key explicit env name (a manifest); (c) **convention + a small
  `ENV_ALIASES` map** for irregular legacy names *[chosen]*.
- **Choice & rationale:** (c). The default derivation is `EAGENT_` +
  `key.toUpperCase()` with `.`→`_`; keys are chosen so the derived name equals the
  legacy name wherever possible, and the handful that cannot are registered in one
  `ENV_ALIASES: Record<canonicalKey, legacyEnvName[]>` table checked in addition
  to the derived name. This keeps every existing `.env` working (a hard
  requirement) while giving new keys a predictable convention.
- **Why (a) rejected:** breaks existing `.env` files for irregular names. **Why
  (b) rejected:** a full manifest duplicates the derivation for the 90% regular
  case and is more to maintain.

### KDD-4 — Enablement: `config.enabled(key, {default, store?})` — trusted layers only, config **file** excluded

- **Problem:** the pervasive gate is `env EAGENT_X === "off"` (a **hard veto**),
  combined for some extensions with a store `enabled` flag, and toggled at runtime
  either by mutating `process.env` (four pure kill-switches with no store) or by a
  store flag. All flavors must be preserved. The security constraint: a
  project-local `.eagent/config.json` in an **untrusted repo** must not change any
  extension's enablement in *either* direction — it must neither **enable** a
  default-off shell/guard extension (`config-hooks`, whose docstring
  `config-hooks.ts:28` ships it off precisely because "a config file can live in an
  untrusted repo and the `command` action executes shell") nor **disable** a
  default-on guard (`secret-guard`, `content-guard`, `provenance`).
- **The trust distinction:** the config **file** is the untrusted, repo-borne
  vector. The runtime **override** (the persisted `config` store namespace) is
  written *only* by interactive `/config set` and `/x on|off` commands — a
  trusted, local user action, exactly like today's env-mutation or store toggle.
  So override is trusted; file is not.
- **Options:** (a) full chain override > file > store > default (rejected — the
  file layer can flip enablement from an untrusted repo); (b) env-veto → store →
  default only, excluding *both* file and override (rejected — leaves pure
  kill-switches with no runtime toggle once their `process.env` writes are removed,
  breaking `/bash-policy off`); (c) **env-veto → override → store(default-threaded)
  → default, with the config *file* excluded** *[chosen]*.
- **Choice & rationale:** (c). `config.enabled(key, opts)` resolves, in order:
  1. If the **env** raw value is exactly `"off"` → `false` (hard kill, preserving
     today's env-wins-off).
  2. Else the persisted **override** (`config` store) for `key`, if set.
  3. Else `opts.store?.get("enabled", opts.default)` when a store is supplied —
     the default is threaded **into** the store lookup, so a default-on store gate
     (`otel-exporter.ts:145`, `store.get("enabled", true)`) stays on when the key
     is unset.
  4. Else `opts.default`.
  The config **file** is deliberately **not** consulted for enablement, closing
  the untrusted-repo hole in both directions. Value keys keep the full `override >
  env > file > default` chain (KDD-5); only enablement drops the file layer.
- **How each inventory flavor maps** (faithful, verified against the code):
  - Pure kill-switch, no store (`bash-policy`, `sandbox-tiers`, `budget-cap`,
    `headless-flags`): `enabled(key, {default:true})`. `/x off` → `config.set(key,
    false)` and `/x on` → `config.set(key, true)`, replacing the old
    `process.env` write/delete. **Behavior change (documented):** today `/x on`
    *deletes* a shell-set `EAGENT_X=off` and re-enables for the session; because
    env-off is step 1 (a hard veto) *above* the override, `/x on` now sets the
    override but **cannot clear a real-environment `EAGENT_X=off`** — it prints a
    note that the environment kill is in effect (unset the env var to enable).
    This is deliberate: it makes a shell `EAGENT_X=off` a firm operator kill that
    a runtime command cannot silently undo, at the cost of `/x on`'s old
    env-clearing side effect.
  - Opt-in, env + store (`compact`, `risk-guard`, `handoff`, …):
    `enabled(key, {default:false, store:e.store})`; `/x on|off` may keep writing
    `e.store.set("enabled", …)` (still honored via step 3) or move to
    `config.set` — both resolve identically.
  - Default-on guard, env + store-default-true (`secret-guard`, `content-guard`,
    `otel-exporter`): `enabled(key, {default:true, store:e.store})`.
- **Consequence documented:** the four pure-kill-switch runtime toggles move from
  process-local `process.env` writes to the persisted override, so `/x off` now
  survives a restart (an intentional, minor behavior change; §8).

### KDD-5 — Config file: flat JSON at existing `.eagent/` paths, project-over-user

- **Problem:** where do file-layer (value) overrides live and how do two files
  combine?
- **Options:** (a) `~/.eagent/config.json` then `./.eagent/config.json`, flat
  dotted keys, project-over-user (last wins), re-read on `/config reload`
  *[chosen]*; (b) nested-object JSON; (c) env-only (no file).
- **Choice & rationale:** (a) mirrors `config-hooks`' exact file-discovery model
  and the host's user-then-project extension precedence.
- **Why (b)/(c) rejected:** nested objects need a flattener for dotted-key lookup;
  env-only gives no persistent per-project config without editing shell profiles.

### KDD-6 — Which values migrate to config vs stay constants (enumerated)

- **Problem:** ~130 constants exist; blindly exposing all violates Simplicity
  First and bloats the key space, while "expose none" fails the `maxTurns` ask.
- **Options:** (a) expose every constant (rejected — a key per scoring weight is
  noise no one sets); (b) expose none (rejected — fails the request); (c)
  **expose the enumerated operator/developer-tunable set** *[chosen]*.
- **Choice & rationale:** (c). Migrate a constant iff it is an operator/developer
  tunable — turn caps, byte/size caps, timeouts, retry counts, thresholds,
  default model names, directories, and every value already env- or
  store-configurable. Keep as a plain constant any algorithm-internal or invariant
  value (§3.7). **The exact list is fixed in the L2 migration table** (one row per
  constant → config key + default), which makes the deliverable *bounded and
  verifiable*: AC 6 asserts every key in that table resolves its default absent
  config and honors its env override. The five `maxTurns` keys are in the list;
  `MAX_PROVIDER_RETRIES` and the invariants of §3.7 are explicitly not.

### KDD-7 — Kernel footprint: a deliberate ceiling bump (primary), golf (secondary)

- **Problem:** the kernel is at 2198/2200 (1 line slack); the surface test
  enforces `< 2200`. A `Config` interface (~9 lines) + `extension.ts` wiring
  (~8) + the `index.ts` type export nets ~14–18 lines — golf alone cannot absorb
  that from the kernel's already-load-bearing comments without harming clarity.
- **Options:** (a) golf-only (rejected — an honest estimate is ~20 net lines
  against 1 of slack; gutting 20 lines of the kernel's most-documented file is
  worse for the codebase than a bump); (b) **a deliberate ceiling bump to 2250,
  with opportunistic golf to keep the net small** *[chosen]*; (c) put the `Config`
  type in host and `import type` it into the kernel (rejected — inverts the
  kernel→host dependency the kernel's self-containment depends on).
- **Choice & rationale:** (b). A modest, documented ceiling bump is exactly the
  "explicit decision" the minimalism guard sanctions ("adding to the kernel means
  golfing something else out **or an explicit decision**", CLAUDE.md /
  `kernel-surface.test.ts`). `Config` is framed as a *supporting* interface added
  to the existing `store.ts` (not a new file, not an eighth primitive), and
  `export type { Config }` is type-only so the runtime `EXPECTED_EXPORTS` pin does
  **not** move. The bump sets the test ceiling to 2250 and updates the ceiling
  **and** the co-stated actual-count/slack figures in the three docs that state
  them (CLAUDE.md, README.md, ARCHITECTURE.md).

## 5. Dependencies and Assumptions

- **Zero new runtime dependencies** (house rule): `JSON.parse`, `node:fs`,
  `process.env` only.
- Reuses `StoreBackend`/`FileBackend` for the runtime-override layer (a `config`
  namespace), so overrides persist like other state.
- Assumes the `.eagent/` directory convention, and that provider files accept an
  `opts` object with an env fallback (verified: `anthropic.ts`/`openai.ts`/
  `gemini.ts` read `opts.X ?? process.env.X` for `apiKey`/`baseUrl`; the **model**
  default is resolved in `host.ts:201-209`, not the provider, so models are
  host-sourced).
- Assumes tests run offline against `MockProvider` with no env set; the env-only
  default config must make an un-configured host behave exactly as today.

## 6. Relationship with Existing Designs

`docs/design/` and `docs/implementation/` were removed in PR #35 (git history /
`CHANGELOG.md`); there is **no prior design document** to cite. Per the L1
template, terminology anchors are CLAUDE.md (_load-bearing-docs_,
_engineering-norms_), `README.md`, `ARCHITECTURE.md`, and the code. Terminology
here — *primitive*, *supporting module*, *extension*, *capability*, *hook bus*,
*store*, *kill switch*, *opt-in* — matches those.

**Consistency checks (⚠️ = doc must change in this task, tracked in §2):**

- CLAUDE.md lists the kernel supporting modules as `types`, `events`, `define`,
  `validate`, `store`, `index`. This design adds the `Config` **interface** to the
  existing `store.ts` — no new file, no new primitive — consistent with that
  taxonomy.
- ⚠️ `ARCHITECTURE.md:225` enumerates the `ExtensionAPI` public members and
  `:78-81` the supporting modules — both change when `config` is added; the docs
  deliverable updates them.
- ⚠️ The kernel line ceiling (`CLAUDE.md`, `README.md:10-11`,
  `ARCHITECTURE.md:348`) is stated as 2200 (with the ~2,198 actual count); KDD-7
  bumps it to 2250 and the docs deliverable updates the ceiling and actual-count
  figures in all three plus the test.

## 7. Acceptance Criteria (measurable / automatable)

1. `npm run typecheck` exits 0.
2. `npm test` exits 0, fully offline (no `ANTHROPIC_API_KEY`, no network).
3. `npm run build` exits 0.
4. `npm run eval` exits 0.
5. Kernel-surface test green: `Object.keys(kernel)` unchanged **and** summed
   `src/kernel/*.ts` line count `< 2250` (the bumped ceiling).
6. `test/config.test.ts` passes and asserts: value-key precedence override > env
   > file > default; `int`/`bool` parsing incl. invalid→fallback; and for
   `enabled()` — (i) returns `false` when env raw value is `"off"` regardless of
   override/store/default; (ii) reads the persisted **override** for enablement;
   (iii) returns `opts.store.get("enabled", default)` when a store is supplied,
   including the **store-empty-uses-default** path (a default-`true` store gate
   stays `true` with the key unset); (iv) **ignores the config *file*** for
   enablement (a file setting `x=false`/`x=true` does not change `enabled("x")`,
   while `config.set("x", …)` does); alias resolution returns the value for a
   legacy env name; `entries()` reports the winning source per value key; and
   **every config key in the L2 migration table returns its documented default
   with no config set, and its env override changes the result** (data-driven).
7. **Back-compat matrix** test: for every migrated legacy env name (data-driven
   from `ENV_ALIASES` + the convention), setting that env var changes the value
   returned by the corresponding `config` accessor.
8. **Completeness** scan test over `src/extensions/**/*.ts` (recursive, including
   `lib/`), `src/host.ts`, `src/server.ts`, **and `src/providers/**`**: (a) **zero
   literal `process.env.EAGENT_*` *assignments*** anywhere in `src/` (the five
   toggle commands now call `config.set`) — the dynamic `.env` loader
   (`host.ts:308`, `process.env[key]=…`) is not a literal `EAGENT_` assignment and
   is excluded; (b) **zero `process.env.EAGENT_*` *reads*** except an explicit
   allowlist of exactly `{config-cmd.ts (its own `EAGENT_CONFIG` kill switch),
   memory.ts:EAGENT_MEMORY_EMBED_API_KEY (secret), server.ts:EAGENT_TOKEN
   (secret), providers/http.ts:EAGENT_MAX_SSE_EVENT_BYTES (transport fallback)}`.
   Any other in-boundary `EAGENT_` read or any literal `EAGENT_` assignment fails
   the test.
9. **`workspace` dedup** test: all former `EAGENT_WORKSPACE` consumers resolve the
   workspace root through the single `workspace` config key (setting
   `EAGENT_WORKSPACE` or `/config set workspace <dir>` changes every consumer).
10. **Behavior** test (the request's exact use case): `EAGENT_SUBAGENTS_MAX_TURNS=3`
    — or `/config set subagents.maxTurns 3` — causes a spawned child agent to be
    constructed with `maxTurns === 3`.
11. **Quality budget:** no latency budget is declared — config resolution is an
    in-memory map lookup with a one-time file read at construction, off every hot
    path; explicitly excluded here rather than omitted. The `/config` surface is
    covered by AC 6–10.

## 8. Risks and Rollback

| Risk | Likelihood | Mitigation / Rollback |
|---|---|---|
| Kernel addition nets more lines than golf can absorb | **High** | Primary path is the deliberate ceiling bump to 2250 (KDD-7), not golf; the bump is a one-line test change + the doc figures. **Rollback:** revert the kernel commit — `e.config` is additive. |
| Behavior drift in a kill-switch / opt-in gate | Med | `config.enabled()` reproduces the two-level semantics incl. env-off veto (now a hard veto for the five previously env-clearable toggles — the one intended change, KDD-4) and *excludes* the file layer for enablement; back-compat matrix (AC 7) + each extension's own enablement tests; migrate one file per phase (L3). |
| A legacy env alias is missed → a user's `.env` silently stops working | Med | The recursive completeness scan (AC 8) forces every in-boundary `EAGENT_*` through config; the alias map is data-driven and unit-tested (AC 7); each phase re-runs the touched extension's tests. |
| Untrusted project config enables a shell-executing extension | Low | Structurally impossible under KDD-4 (enablement ignores file/override); AC 6 asserts it. |
| Completeness scan false-passes on `lib/` or `server.ts` | Med | AC 8 globs `src/extensions/**/*.ts` recursively **and** host/server; `lib/` helpers take config values as params (§2) so they hold no env read to miss. |
| Huge diff across ~50 files destabilizes the suite | High | Phase L3 by extension groups (L2); every phase independently green on `npm test`; the facility + tests land first so migrations only swap read-sites. |
| The four pure-kill-switch `/x off` toggles now persist across restarts (was process-local) | Low | Intentional and documented (KDD-4, CHANGELOG); persistence matches the store-flag opt-in extensions that already behave this way; `/x on` / `/config unset` clears it. Each toggle command's own test updated to assert the override path. |
| Printing a secret via `/config list` | Low | The two EAGENT secrets are never registered as config keys (§3.1); `/config list` shows only value keys read through config, and a `*token*`/`*key*`/`*secret*` substring denylist guards defensively. |

**Whole-change rollback:** the facility is additive. Reverting the migration
commits restores direct `process.env` reads; reverting the kernel commit removes
`e.config`. Because each migrated site keeps its original default inline, a
partial revert leaves behavior intact.

## Appendix A — Inventory summary (authoritative per-file detail fixed in L2)

- 70 `EAGENT_*` vars: kill switches (`=== "off"`), opt-in (`env !== "off" AND
  store.enabled`), values (dirs, byte caps, timeouts, thresholds, models). All
  migrate except the two secrets (`EAGENT_TOKEN`, `EAGENT_MEMORY_EMBED_API_KEY`).
- ~12 files independently read `EAGENT_WORKSPACE` → one `workspace` key.
- The five `maxTurns` values (four extensions) + `agent.ts` default (24) →
  distinct config keys.
- Provider default **models** → host-sourced from config; **base URLs** → provider
  `opts.baseUrl`; SSE cap → host override with `http.ts` env fallback.
- `lib/` env reads (`sandbox.ts` → `EAGENT_WORKSPACE`, `otel-context.ts` →
  `EAGENT_OTEL_PROPAGATE_HOSTS`) → caller-passed config values. (`decode.ts` reads
  no env; `EAGENT_DECODE_NORMALIZE` lives in `bash-policy.ts`/`risk-guard.ts`.)
- Five `/x on|off` commands mutate `process.env` today → migrate to
  `config.set` (`bash-policy`, `headless-flags`, `budget-cap`, `sandbox-tiers`,
  `config-hooks`).
- Scoped out: the two EAGENT secrets, non-EAgent system vars
  (`PATH`/`ComSpec`/`PORT`/`OTEL_*`-standard), algorithm-internal constants (§3.7),
  and store-only rich config (§3.4).
</content>
