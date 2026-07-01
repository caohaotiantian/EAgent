# Decision — validated won't-build closures (batch 2): the deferred register long tail

**Slug:** `2026-07-01-deferred-closures-batch2` · **Tier:** decision record (no code change). Branch:
`chore/finish-followups-4`.

Under the "finish every deferred register item" directive, an adversarial **disposition workflow** (three
independent assessors, each briefed to *find* a useful, non-degrading, offline-buildable slice before
closing, plus a synthesis pass) dispositioned the remaining 19 items: **2 BUILD** (RW8a-3
refine-to-convergence, RW7c-2 traceparent propagation — both shipped) and **17 CLOSE (won't-build)**.
This records the 17, each with the validated rationale and the deployment alternative (so no capability
gap is left). This is the fresh-eyes gate for these closures.

## Kernel-headroom / contract-widening (spend the irreplaceable 2199/2200 line for near-zero gain)

- **RW4-1 — `Agent.fork()`** — a kernel method vs 0 headroom; its sole consumer (reasoning-search)
  deliberately diverges (needs a *pruned* child registry that drops re-fork/re-search tools = the
  recursion guard, plus dangling-`tool_use` pruning) that a generic `fork()` can't give. *Alt:*
  extensions compose the public `snapshot()`/`restore()`/`childScope()` with a per-site pruned registry
  (reasoning-search `forkChild`, subagents `makeChild`) — already offline-tested.
- **RW3-3 — `AgentHandle.spawnChild`** — widens a kernel handle vs 0 headroom; all 5 child sites share
  only `providers` + `childScope()`, while caps/ui/model/systemPrompt/maxTurns/thinking/registry/restore
  all diverge — a helper saves ~2 lines while forcing an 8-field options bag. *Alt:* each site keeps its
  explicit `new Agent({…})`; the divergence is real per-extension policy.
- **RW3-4 — `agentId`/`depth` on every `KernelEvents` payload** — breaks every handler/test pin and
  threads through every emit; the child/parent attribution need is already met by the W9.1
  `currentActingAgent()` seam with zero payload change (grep found no other consumer). *Alt:* handlers
  call `currentActingAgent()`; a spawning extension tags its own telemetry with its known depth.
- **RW6a-1 — `beforeDispatch` injecting brand-new tool-call ids** — forces retroactive mutation of an
  already-`emit`ed assistant message (else the tool_result orphans → provider 400s), desyncing every
  observer; and no built-in registers a `beforeDispatch` handler at all. *Alt:* a model that wants a
  call emits it; an extension runs a tool out-of-band by calling it directly. `beforeDispatch` stays
  reorder/drop-only.
- **RW6a-2 — add `beforeDispatch` to `SHARED_FILTER_POINTS`** — inert today (no registered handler ⇒
  children already run identical passthrough) and speculatively alters the governance-vs-context
  security split with no consumer; +1 kernel line vs 0 headroom. *Alt:* add it *when* a real
  child-`beforeDispatch` consumer exists and validates the turn/wave semantics.
- **RW5-1 — migrate fallback-routing onto `onProviderError`** — needs the kernel to move provider
  resolution inside the retry loop + add a provider-swap to the decision object (kernel lines vs 0
  headroom) for net-zero gain; both approaches share the identical pre-first-event failover reach.
  *Alt:* fallback-routing keeps the composite-provider wrapper (a failover chain is itself a Provider =
  zero kernel change); the two seams coexist.

## Correctness-hazard / no-consumer

- **RW7a-1 — time-travel delta/incremental blobs** — collide with the disk-bounding FIFO: `evictIfOverCap`
  unlinks the oldest node's blob (usually an ancestor), making descendant deltas unreconstructable →
  `restore()` breaks; refcount/re-base defeats the cap or is circular. Pure disk opt, no consumer.
  *Alt:* keep full-state-per-node + FIFO; tune the `cap` flag or point `EAGENT_TIME_TRAVEL_DIR` at a
  larger volume.
- **RW7a-2 — unify conversation rewind with git workspace rollback** — time-travel and checkpoint own
  disjoint id spaces with no shared seam; unifying needs the deferred id-alignment design and is fragile
  (git may be absent; snapshots fire at different lifecycle points → inherently unaligned). No consumer.
  *Alt:* operator pairs them manually (`/rewind <id>` then `/rollback <id>`).
- **DEFERRED-2 — secret-guard env-ref rewriting** — the "rewrite a literal to `$VAR` only when it exactly
  equals an existing env value" *safe* slice isn't safe: `net:fetch`/`mcp:call` take structured args with
  no shell expansion (a `$VAR` literal → broken auth), and `shell:exec` single-quoted values don't expand
  either — so it's silent mutation of executed output on a fail-open guard. *Alt:* secret-guard stays
  detect-and-HOLD (ask/block, names only the KIND); the operator moves the secret to an env var and
  re-issues.
- **RW6c-1 — real container/microVM sandbox backend** — gVisor/Firecracker/E2B need external deps + infra
  (not zero-dep, not offline-buildable); the injectable-backend variant is offline-testable but
  *degrading* — a runtime backend registry lets an injected `wrap()` silently drop confinement (e.g. omit
  `--unshare-net`) on the security boundary, and is inert with zero custom backends. *Alt:* a deployment
  adds a `case` to the pure `wrapCommand` switch (still offline unit-testable); the shipped OS-launcher
  tiers stay the zero-dep default.
- **DEFERRED-6 — skills `.skill` signature verification** — no producer/distribution channel: skills are
  local dirs off disk, so a verifier is inert (nothing signs) or degrading (rejects all existing unsigned
  skills). The poisoning threat is already covered by the shipped supply-chain scan + rug-pull
  fingerprint + frontmatter lint + tool scoping/gating. *Alt:* rely on the in-place hardening; a signed
  distribution channel is a separate future design.

## Inert / speculative-generality

- **DEFERRED-3 — routing N-tier + cost-feedback** — the tier *map* is already N-ready, but the
  *classifier* is intrinsically boolean (`Tier` is a 2-literal union; `classify` is an OR of 3
  predicates) — a 3rd tier is inert without a new graded-difficulty signal + thresholds. No consumer.
  *Alt:* stay 2-tier; a non-Claude deployment overrides `DEFAULT_TIERS` via the `tiers` store flag.
- **DEFERRED-4 — MCP resource subscriptions + change-notifications + templates** — MCP "SSE support" here
  is a finite `res.text()` reply parse, incompatible with a long-lived push stream; a real subscription
  needs new standing-reader/notification-dispatch/reconnect plumbing, and templates are inert
  (`read_resource` already takes concrete URIs). No consumer. *Alt:* use the shipped read side (cached
  `resources/list` + live `read_resource` + `/mcp refresh`).
- **RW7c-3 — otel real-collector live smoke** — offline-inert (always skips without a stood-up
  Jaeger/Tempo + a manual flag); it tests the collector's acceptance, not EAgent code — whose wire shape
  is already byte-pinned via the fetch stub. Adds an un-run-in-CI artifact. *Alt:* a deployment validates
  against its real collector out-of-band during rollout (`OTEL_EXPORTER_OTLP_*`).

## Working-guard / cosmetic (regress a default-on guard or add a footgun knob)

- **RW9-2 — headless-fork guard-UI convention divergence** — both current behaviors already fail-closed
  and were judged "arguably correct"; unifying either direction degrades a working guard (parent-ui
  circuit-breaker → N human interrupts across forks; acting-agent flow-guard → changes a default-on
  egress guard), and a config knob is a footgun on a safety surface with no consumer. *Alt:* keep the
  current conventions; both fail closed headless.
- **RW9-3 — citations × reasoning-search cross-fork fabricated-source warn** — a fork's `[src:N]` header
  lives in the child transcript only; `best_of_n` returns the child answer *text* (prose citation, not
  the header) under `agent:spawn` (never re-tagged), so a citations-only harvest can't fix it; the real
  fix is cross-fork id-namespacing coupling two default-OFF warn-only extensions for one spurious log
  line. *Alt:* both stay default-off; a future id-namespacing design handles it if it matters.
- **RW4-2 — per-session server state** — the remembered-cap leak is unreachable (yolo ⇒ no ask;
  non-yolo ⇒ only a DENY is remembered = fail-closed); the genuine residual is cross-session cost
  *observability* (intentional). Real isolation = N re-activated hosts (breaks the single-agent model) or
  a tenant-id kernel seam with no other consumer. *Alt:* deploy one single-tenant server process per
  tenant (per `server.ts`'s own docstring) — process-level isolation of CapabilityManager/store/cost for
  free.

## Register + closure

All 17 rows in `docs/DEFERRED-FOLLOWUPS.md` are annotated **CLOSED (won't-build) 2026-07-01** pointing
here. No code changed; the suite stays green. Every closure has a validated deployment alternative — none
leaves a capability gap.
