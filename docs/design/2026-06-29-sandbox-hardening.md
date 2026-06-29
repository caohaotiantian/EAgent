# Design — sandbox hardening (RW6c-4, SBPL escaping, real-backend coverage)

**Slug:** `2026-06-29-sandbox-hardening` · **Wave:** 9 (subsystem W9.3 of 6) · **Mode:** Full
**Source:** [`docs/audits/2026-06-29-production-readiness-audit.md`](../audits/2026-06-29-production-readiness-audit.md) §3 (sandbox/codeact), RW6c-4, §5 (SBPL escaping).

## 1. Background and the gap (code as truth)

`src/extensions/lib/sandbox.ts` is the shared OS-launcher confinement layer (pure string builders) under
the shell tier (`sandbox-tiers`) and code tier (`codeact`). Three gaps, all fail-closed today (a broken
wrapper denies rather than leaks), but each is a real correctness/coverage hole:

- **RW6c-4 — codeact `readonly` tier is broken (ENOENT) under bwrap.** `codeact` writes its snippet to a
  per-call `mkdtemp` dir under `/tmp` (`codeact.ts:96`, `dir = mkdtempSync(join(tmpdir(),…))`) and calls
  `wrapCommand(backend, tier, inner, { root: dir })` (`codeact.ts:130`, `cwd: dir` `:137`). The bwrap branch
  always adds `--tmpfs /tmp` (`sandbox.ts:110`), which shadows the host `/tmp` — including the snippet dir.
  Write tiers re-expose it via `--bind root root` (`:111`), but the **readonly** tier adds no bind, so the
  snippet is invisible → interpreter ENOENT. Fails closed; bwrap-only; narrow (`readonly` + default
  `TMPDIR=/tmp`); workspace-write/no-network and sandbox-exec/firejail are unaffected. Pinned by
  `test/sandbox-tiers.test.ts:70-72`; documented (`DEFERRED-FOLLOWUPS.md`, `README.md`).
- **SBPL `root` interpolated unescaped.** The sandbox-exec profile embeds `root` directly:
  `(subpath "${root}")` (`sandbox.ts:100`) — no escaping of `"`/`\`, unlike the bwrap/firejail branches which
  `shquote(root)` (`:111,:118`). An operator `EAGENT_WORKSPACE` containing `"` or `\` yields a malformed
  SBPL profile → sandbox-exec refuses (fail-closed) — but the write tier then doesn't run as intended.
- **Real backends are never invoked by any test.** `wrapCommand` emits security-critical strings (SBPL
  `deny network*`/`file-write*` `:97-103`; bwrap `--unshare-net`/`--bind` `:110-113`; firejail
  `--net=none`/`--read-write` `:117-119`) but no test runs a real binary: `sandbox-tiers.test.ts:47-99`
  re-asserts the builder's own output, `codeact.test.ts:170-192` routes through a fake `echo '[[WRAPPED]]'`
  shim, and `binExists` (`:131-141`) has zero coverage. A flag that is accepted-but-non-confining on a real
  host would pass the whole suite. (Silent residual risk — confinement is asserted only as strings.)

## 2. Deliverables

- [ ] **D1 (RW6c-4)** — in `wrapCommand`'s bwrap branch, for **non-write** tiers add a **read-only** re-bind
  of `root` after `--tmpfs /tmp`: `else parts.push("--ro-bind", shquote(root), shquote(root));` (paired with
  the existing `if (writeTier) … "--bind" …`). This re-exposes codeact's snippet dir **read-only** under the
  `readonly` tier (fixing ENOENT) **without** granting write (the guarantee holds), and is a harmless RO
  no-op for the shell `readonly` tier (whose `root` is the workspace, already RO-visible via `--ro-bind / /`
  and not under `/tmp`). One line; KDD-1.
- [ ] **D2 (SBPL escaping)** — add a tiny `sbplString(s)` helper that escapes `\` then `"`
  (`s.replaceAll("\\","\\\\").replaceAll('"','\\"')`) and apply it to `root` in the sandbox-exec subpath:
  `(subpath "${sbplString(root)}")`. The other subpaths are constant literals (safe). Pure; no behavior
  change for paths without `"`/`\`. KDD-2.
- [ ] **D3 (real-backend confinement tests + `binExists` coverage)** — add **backend-gated** integration
  tests (skip when `detectBackend(process.platform, binExists) === "none"`, mirroring `codeact.test.ts:121`'s
  `python3` skip-gate). **CRITICAL framing (review S):** on macOS `detectBackend` **always** returns
  `sandbox-exec`, so these tests **EXECUTE on the dev/CI mac (and any Linux with bwrap) — they do not skip
  there** — so every assertion MUST pass against the *real* backend or it breaks `npm test`/AC-2. They run a
  **real** command through `wrapCommand` and assert **observable** confinement, not string identity. The
  per-call `root` MUST be a fresh dir **under `os.tmpdir()`** (so the readonly case actually exercises the
  D1 `--tmpfs /tmp` shadowing — otherwise it passes pre-D1 and guards nothing; review G2):
  - under `no-network`: a subprocess network attempt **fails** (a connect to a closed loopback port / an
    unreachable host → non-zero exit; no real egress).
  - under `readonly` (post-D1): a snippet written in `root` **runs** (no ENOENT — guards D1) **and** a write
    to `root` **fails** (proves the RO guarantee — a clean in-bounds write-denial, no out-of-root target
    needed).
  - under `workspace-write`: a write **inside** `root` **succeeds**; an out-of-root write **fails** — the
    target MUST be **outside the sandbox write-whitelist**, which on sandbox-exec includes `root` +
    `/private/tmp` + `/private/var/folders` (`sandbox.ts:101`) and on bwrap includes the writable
    `--tmpfs /tmp` — so a temp-based path is wrongly *allowed*. Use a **`$HOME`-based** target
    (`join(os.homedir(), ".eagent-sbtest-<unique>")`): writable without a sandbox, denied by both backends;
    clean it up in `finally` (if confinement works the file is never created). Document this constraint.
  Plus a unit test for `binExists` (finds `/bin/sh` via the bin name `sh`; misses a bogus name) — Unix-only,
  consistent with the sandbox being Unix-only. KDD-3. **Impl notes (r2 generals):** the no-network target
  MUST be loopback (`127.0.0.1:<closed-port>`) or an RFC-reserved unreachable address (TEST-NET
  `192.0.2.0/24`) — never a real hostname (egress safety, G-2); derive the backend from
  `detectBackend(process.platform, binExists)` (real), NOT a forced `EAGENT_SANDBOX_BACKEND`, and ensure no
  leakage from `codeact.test.ts`'s shim test which sets/restores that var (G-3). On macOS (sandbox-exec, no
  tmpfs) the readonly "snippet runs" assertion is trivially true, so D1's mac-side regression guard is the
  AC-D1 string assertion; the observable bwrap guard runs under RW9.3-1's Linux CI job (G-1, acknowledged).

## 3. Out of scope

A Linux-CI **bwrap job** (so the gated tests actually execute in CI, not just skip) is an infra change —
registered as a deferred follow-up (RW9.3-1), not done here. The by-design items (sandbox fail-OPEN on a
missing backend; `no-network` not confining in-process `net:fetch`; codeact `tier:off` default) are
unchanged — they are documented deliberate choices (audit §4).

## 4. Key Design Decisions

### KDD-1 — Read-only re-bind for codeact's snippet (don't relocate it, don't loosen readonly)
*Problem:* the readonly snippet must be readable inside bwrap after `--tmpfs /tmp` shadows `/tmp`. *Options:*
(a) write the snippet under the **workspace** root instead of `/tmp` (covered by `--ro-bind / /`) — but it
pollutes the user workspace and collides with `fs:*` confinement; (b) **`--ro-bind root root` for non-write
tiers** — re-exposes exactly the per-call dir, read-only. *Choice:* **(b)** — minimal (one line), preserves
the readonly guarantee (RO, not RW), and is a safe no-op for the shell readonly tier. *Rejected:* (a) side
effects in the user's tree.

### KDD-2 — SBPL needs its own escaping, not `shquote`
*Problem:* `root` sits inside an SBPL double-quoted string, a different grammar from `/bin/sh` single
quotes. *Options:* (a) reuse `shquote` (wrong — single-quote rules don't apply inside an SBPL `"…"`);
(b) a dedicated `sbplString` escaping `\` then `"`. *Choice:* **(b)** — correct for the SBPL literal; the
ordering (`\` before `"`) avoids double-escaping. *Rejected:* (a) produces a still-malformed profile.

### KDD-3 — Tests assert observable confinement, gated on a real backend
*Problem:* string-identity tests can't catch an accepted-but-non-confining flag. *Options:* (a) keep
string assertions only; (b) add backend-gated tests that run a real binary and assert network/write are
actually denied. *Choice:* **(b)** — they execute where a backend exists (dev/CI-with-bwrap) and **skip**
(not fail) where absent, so the offline suite stays green while real confinement is finally exercised.
*Rejected:* (a) the current blind spot.

## 5. Acceptance Criteria (measurable)

- **AC-1** typecheck 0. **AC-2** `npm test` 0 (existing string tests stay green — D1 adds an arg only on the
  readonly path; verify `sandbox-tiers.test.ts` expectations are updated to include the new `--ro-bind`).
  **No kernel change.**
- **AC-D1** `wrapCommand("bwrap","readonly",cmd,{root})` output contains `--ro-bind <root> <root>` after
  `--tmpfs /tmp` and **no** `--bind` (write) for `root`; write tiers still emit `--bind` (RW). A
  backend-gated test: a codeact-style snippet under `readonly` **runs** (no ENOENT) and a write to it fails.
- **AC-D2** `wrapCommand("sandbox-exec","workspace-write",cmd,{root:'/a/b"c\\d'})` yields a profile whose
  subpath is the escaped form (`\"`, `\\`), and the profile is well-formed; a path without specials is byte-
  identical to today.
- **AC-D3** backend-gated: no-network blocks a network call; workspace-write blocks an out-of-root write
  (and allows in-root); readonly allows read+run, blocks write. `binExists` unit: true for `sh`, false for
  a bogus name. All **skip** cleanly when no backend is present.

## 6. Risks and Rollback

- **R1 — D1 changes existing string-assertion tests.** *Mitigation:* update `sandbox-tiers.test.ts`
  readonly expectations to include `--ro-bind root root`; AC-2 requires the suite green. *Residual:* none —
  the change is additive on the readonly path.
- **R2 — backend-gated tests are non-deterministic across environments.** *Mitigation:* they **skip** when
  no backend, and assert only coarse pass/fail (exit code / thrown error), not output; network test targets
  a closed loopback port or a guaranteed-unreachable host to avoid real egress. *Residual:* a CI runner
  with a backend but an unusual policy could differ — hence RW9.3-1 (a dedicated bwrap CI job) is staged.
- **R3 — `sbplString` ordering bug.** *Mitigation:* AC-D2 pins both specials; escape `\` first.
- *Rollback:* D1/D2 are one-line pure-function edits; D3 is additive tests. Revert any independently. No
  kernel change.
