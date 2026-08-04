# Handoff

State as of 2026-08-05, branch `loom`, head `bdedd23`.

For *why* decisions were made, read `JOURNAL.md` (append-only, newest last). For what the
system is, read `README.md` → `00-OVERVIEW.md`. This file is only: **what is left, what to
read first, and what will bite you.**

---

## Where things stand

```
716 tests passing · 0 runtime dependencies · 426 pinned exports · 49 source files
bin/loom — 114 MB single binary, 282 KB application bundle, 0 third-party modules
```

Verified working from an empty directory: copy `bin/loom` in, write a graph by hand in
JSON or YAML, `./loom compile` then `./loom run`. It writes a real file.

All eight node types execute. All ten escalation rules fire. Every open thread (T1–T7) is
closed. `npm run check` is the gate and it is green.

---

## What is left

Three categories, and the distinction matters: **(A)** blocked by a constraint we chose,
**(B)** deferred by an explicit design decision, **(C)** genuinely unbuilt and unblocked.

Start with (C). Nothing there is hard; they were missed rather than decided against.

### (C) Unbuilt and unblocked — start here

#### C1 · Inbound gate callbacks (`GateDelivery.parseCallback`)

**Status:** declared in D3.20, zero implementation. **This is the largest real gap.**

Wave E built *outbound* delivery — `DeliveryChannel.deliver`, a `WebhookChannel` on global
`fetch`, a `ConsoleChannel` fallback, per-channel failure journaling, and a tiered
escalation chain. What does not exist is the return path: a Slack button click, a
PagerDuty acknowledgement, or an approvals-service POST arriving as a `GateDecision`.

Today a gate raised through a webhook can only be answered through the HTTP API or the
console. That is *safe* — no path bypasses `HumanGateBroker.resolve` — but it makes the
webhook channel a notifier rather than a decision surface, which is half a feature.

**Where the seam is:** `src/run/delivery.ts`. Add `parseCallback(raw, target)` to
`DeliveryChannel`; wire an HTTP route in `src/server/http.ts` that dispatches to the named
channel and then calls `engine.resolveGate`.

**What makes it security-sensitive, and non-negotiable:**

- **Verify the signature before anything else.** An unauthenticated callback endpoint is a
  way to approve production actions by POSTing JSON.
- **Enforce a replay window.** A captured approval must not be replayable tomorrow.
- **Map the caller to a real `Actor`.** `resolve` records who decided; a channel that
  reports `{kind: "system"}` destroys the audit trail's entire point.
- The existing idempotency key in `resolve` already collapses a double-click, a webhook
  retry, and a channel retry into one decision — reuse it, do not invent a second one.

**Done looks like:** a test that forges a callback with a bad signature and asserts the
gate stays open.

#### C2 · Approval-queue saturation (D7.9)

**Status:** designed in full, zero implementation. Neither `batching` nor `trust` appears
anywhere in `src/`.

D7.9 specifies two mechanisms for when a human is the bottleneck:

- **Batching** — group gates by a key (`node.id + plan.namespace`) inside a window, so
  twenty near-identical approvals arrive as one decision over twenty items.
- **Trust tiers** — after N consecutive approvals with no rejects and no edits, sample
  rather than gate every instance.

**Read the design section before touching this**, because the second mechanism is a
*loosening* and the design says so explicitly: enabling trust tiers is subject to D7.7's
asymmetry rule. It must go through `PolicyEngine.deescalate` — human actor, justification,
journaled — and not through a config flag. Default is OFF and should stay OFF.

Batching is the safer half and is worth doing first; it is pure UX with no oversight
implications.

#### C3 · Fairness under partitioning is untested

The `Scheduler` seam exists with two implementations passing one conformance suite
(`test/run/scheduler.test.ts`). What is untested is behaviour under *contention*: two
`LeasedScheduler`s against one journal, with lease expiry racing real execution.

That is a test, not a feature. It would meaningfully de-risk G3 (below) for a day's work.

### (B) Deferred by explicit design decision — do not "fix" these casually

Each has a one-line justification in `08-PLAN.md`'s `DEFERRED-v2` register. Read it before
reopening any of them; they were closed for reasons, not forgotten.

| Item | The reason, compressed |
|---|---|
| **G3 · partition assignment** | Selection is now a seam; deciding *which runs a worker considers* needs a coordinator, and half a coordinator is worse than none |
| **Evolution synthesis + canary + auto-promotion** | Under ~30 scored trajectories per cohort, any candidate is fitted to noise. Capture and scoring ship; the generator does not |
| **Subtractive graph mutation** | Additive-only keeps the executed graph a superset of the compiled one. Removal asks "what happened to the branch already running through the deleted edge?", which has no cheap answer |
| **seccomp / Landlock** | Platform-specific; subprocess + fs jail + egress allowlist covers the v1 threat model |
| **Custom user-authored reducers** | Arbitrary code inside the determinism boundary |
| **Free-form agent chatter / blackboard** | Makes termination unprovable and replay quadratic |
| **Distributed deployment (K8s/Postgres/NATS/S3)** | A distributed v1 by a small team yields a distributed prototype, not a product |

### (A) Blocked by a constraint we chose

| Item | The constraint |
|---|---|
| **Browser paint at 500 nodes** | Layout is measured (0.95 ms) and the console provably computes no positions. Timing the *paint* needs a headless browser, which the zero-dep rule keeps out of `@loom/core`. If it matters, measure it in a separate package — do not add the dependency here |

---

## Documentation drift to fix

Four register entries no longer describe the code. None is dangerous; all are misleading
to a newcomer. Fix the register, not the code — the code is right in each case.

| Where | Says | Actually |
|---|---|---|
| `08-PLAN.md` A8 | "Gate delivery in v1 is console-only" | Outbound delivery ships with a webhook channel and an escalation chain (Wave E). Only the *inbound* path (C1) is missing |
| `08-PLAN.md` A12 | "UI stack is React + Vite + Zustand" | The console is hand-written vanilla JS + inline SVG, one document, no bundler. A React console can come later against the same API |
| `08-PLAN.md` A11 | "audit records for 7 years" | `DEFAULT_RETENTION.audit` is `Infinity`, deliberately — no external mandate applies (GDPR was ruled out of scope), and "keep forever unless someone says otherwise" fails safe |
| `08-PLAN.md` A2 | "Node 22+" | `engines: >=24.0.0`. Native TS type stripping and `node:sqlite` both require it |

The `DEFERRED-v2` register's "Slack / Feishu / Teams / email gate delivery" row is also
now half-true: a Slack *incoming webhook* works today via `WebhookChannel`. What remains
deferred is vendor-specific callback parsing, which is C1.

---

## Working on this codebase

```bash
npm run check                            # THE gate: typecheck + 716 tests + both guards
npm test                                 # tests only
node scripts/check-surface.mjs --write   # re-pin the public surface, then COMMIT surface.json
npm run build:binary                     # bin/loom; fails if any node_modules input appears
```

**Two CI guards will stop you, on purpose:**

- **zero-dep** — parses every source file; a bare import specifier that is not `node:` fails
  the build. It is a TS-parser check, not a regex, so it will not false-positive on a
  string.
- **surface** — pins all 426 public exports. Adding one is fine; it just has to be
  deliberate. Re-pin and commit `scripts/surface.json` in the same change.

**Toolchain facts that shape the code** (all in `CLAUDE.md`, repeated because they cause
the most confusion):

- Node 24 native type stripping. Tests run `.ts` directly — no build step, no `tsx`.
- `erasableSyntaxOnly` is on: **no enums, no namespaces, no parameter properties.** The
  last one bites; use explicit field assignments in constructors.
- Source imports use `.ts` specifiers. `tsc` rewrites to `.js` on emit. Never write `.js`.
- `exactOptionalPropertyTypes` is on: `foo?: T` and `foo: T | undefined` differ. Build
  objects conditionally — `...(x === undefined ? {} : { x })`.

**Conventions that are load-bearing, not stylistic:**

- Every module docstring says *why it exists*, not what it does.
- Every non-obvious decision gets a `JOURNAL.md` entry with its reversal condition.
- Tests are offline and deterministic. Inject clocks and ids; never read the wall clock.
- **Commits under the human author's identity only.** No AI attribution, no
  `Co-Authored-By`, no assistant links. Non-negotiable, carried over from EAgent.

---

## Traps

Each of these cost real debugging time. They are recorded in `JOURNAL.md` in full; this is
the short list so you recognise the shape.

**Absence is not zero.** `verdict.score < 0.7` is **false** when `verdict` is absent, in
both the expression language and `isLowConfidence`. The idiom is `has(v) && v.x < 1`. A
system that coerced absence to `0` would escalate every run whose evaluator returned a
bare `{pass: true}` — and an alarm that always fires is one people learn to ignore.

**Approve means "go ahead", not "consider it done".** On a `human_gate` node, approving
completes it — that node *is* the decision. On every other node type there is work behind
the gate. This was a real bug: the run reported success and the action never happened.

**A read model can silently encode a deployment assumption.** `task.leased` always carried
a `workerId` and a fencing token; the fold turned it into a state and threw both away,
because with one worker there is nothing to ask. If you add a second worker to anything,
check what the projection is discarding.

**`node:vm` is not a sandbox.** `resources/functions.ts` uses it for *scoping* — so a
trusted `function` body cannot reach `process.env` by accident. Untrusted code goes
through `sandbox/subprocess.ts`. The docstring says this; do not let it drift.

**Cross-realm values look identical and are not.** Objects a `vm` body returns have a
different `Object.prototype`. Worse: `Array.prototype.map` goes through
`ArraySpeciesCreate` and uses the *array's own* constructor, so mapping a cross-realm array
does nothing at all. `intoHostRealm` uses `Array.from`. `Array.isArray` is realm-agnostic
and will pass either way — assert on the prototype.

**Under reserve-worst-case, "80% consumed" is ambiguous.** Committed exposure peaks at the
reservation and falls back when `settle` credits the real cost — a 40× swing with the mock
adapter. A check only at commit reads the trough and never fires. E2 checks at both.

**A tool cannot know a graph's channel names.** `mapToolWrites` routes a tool's own write
vocabulary onto the node's declared channels. Found by using the binary for four minutes;
every built-in tool had been unusable by any graph that had not guessed its internals.

---

## The one habit worth keeping

Every wave of this build found defects by running a *new shape* of thing, not by adding
tests to an existing shape. A restart found the gate bug. A branch that recovers found the
join bug. A router found three compiler over-approximations. Four minutes as a *user* —
copying the binary into an empty directory and hand-writing a graph — found the tool
channel bug that three test workflows structurally could not.

When something feels covered, it is covered *for the shapes that exist*. Build a new one.
