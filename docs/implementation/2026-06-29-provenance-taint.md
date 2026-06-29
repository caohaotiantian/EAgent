# Implementation — Provenance / taint (CaMeL-lite)

**Slug:** `2026-06-29-provenance-taint` (matches design) · **Design:**
[`design/2026-06-29-provenance-taint.md`](../design/2026-06-29-provenance-taint.md)

`<TEST-CMD>` = `npm test` · `<TYPECHECK>` = `npm run typecheck`. Single-file accept:
`node --import tsx --test "<file>"`.

## 1. Task Index

| Phase | Deliverable | Design refs |
|---|---|---|
| 1 | D1-D5 the `provenance` extension + host registration | design §2 D1-D5, KDD-1..5, AC-1..AC-8 |

One Phase: a single new off-by-default extension (no kernel change) + one `BUILTIN_EXTENSIONS` line.
Independently committable; `npm test` green at the end.

## 2. Phase Breakdown

### Phase 1 — The `provenance` extension

- **Entry condition:** on latest `feat/redesign-superpowers` (Waves 1-5 + 6a merged). Baseline `npm test` green.
- **Design refs:** §2 D1-D5; KDD-1 (complementary axes), KDD-2 (segment-`includes`, minLen), KDD-3
  (escalate via `ui.confirm`, fail closed; default/strict), KDD-4 (closure state, no kernel field;
  governs children), KDD-5 (sink/foreign policy tables); AC-1..AC-8.
- **Files:** `src/extensions/provenance.ts` (new), `src/host.ts` (register, **after** `content-guard`),
  `test/provenance.test.ts` (new).
- **Task list (TDD order):**
  1. **(test)** `test/provenance.test.ts` — **gate on derived arg** (AC-3): build a host/agent slice with
     `core-tools` + `content-guard` + `provenance` (enabled). Register a foreign-cap tool (declares
     `net:fetch`) whose result contains a distinctive ≥24-char **single whitespace-bounded token** S (so
     it survives split-on-whitespace segmentation intact and the sink arg can `.includes(S)`), and a sink tool (declares
     `shell:exec` or `fs:write`). Drive the model (MockProvider responder) to (i) call the foreign tool,
     then (ii) call the sink tool with an arg containing S. With a stub `ui.confirm` returning **false**,
     assert the sink call is **blocked** (isError result, reason mentions the tool, no secret echoed).
     With `ui.confirm` returning **true**, assert it is **allowed** (executes).
  2. **(test)** **clean arg passes** (AC-4): a sink call whose args do NOT contain any untrusted segment
     is not escalated (no `confirm` consulted, executes); and an overlap shorter than `minLen` does not
     trigger.
  3. **(test)** **non-sink untouched** (AC-5): a non-privileged tool (no sink cap) with an arg derived
     from untrusted content is never escalated.
  4. **(test)** **off by default** (AC-6): extension loaded but not enabled → a derived sink call is not
     escalated.
  5. **(test)** **governs children** (AC-7): a `childScope` sub-agent (via `subagents`/an inline child)
     whose foreign read taints the store and which then calls a sink with the derived arg is escalated
     (shared-closure governance). [If wiring a real sub-agent is heavy, assert the equivalent: the same
     single provenance handler instance, invoked via a child bus from `parentBus.childScope()`, escalates.]
  6. **(test)** **strict mode** : in `strict` mode a derived sink call is blocked WITHOUT consulting
     `ui.confirm`.
  7. **(impl)** `src/extensions/provenance.ts`: default-export `activate(e)`; `EAGENT_PROVENANCE === "off"`
     → no-op. Config from store: `enabled` (default false), `mode` ("default"|"strict"), `foreignCaps`
     (default `["net:fetch","mcp:call","mcp:read"]`), `sinkCaps` (default
     `["shell:exec","net:fetch","mcp:call","fs:write"]`), `minLen` (default 24), `maxSegments` (default
     **256**, FIFO eviction). A closure `untrusted = new Set<string>()`. `capsOf(name) =
     e.agent.tools.get(name)?.capabilities ?? []` (the tool name is `ctx.call.name` in both handlers).
     The `h=<hash>` in the reason is a short **non-crypto** hash of the matched segment (inline djb2 — no
     `node:crypto` dep; it only needs to not echo the value, and no test pins its value). Register:
     - `afterToolCall`: if enabled, result not isError, and `capsOf(call.name)` intersects `foreignCaps`,
       split `result.content` into normalized segments (split on whitespace/newlines, keep spans with
       `length >= minLen`), add each to `untrusted` (evict oldest past `maxSegments`).
     - `beforeToolCall`: if enabled and `capsOf(call.name)` intersects `sinkCaps`, scan each string value
       in `decision.arguments`; if any `argValue.includes(segment)` for some `segment` of `untrusted`,
       then in `strict` mode return `{ ...decision, block: true, reason }`; else
       `const ok = await e.agent.ui.confirm(reason); return ok ? decision : { ...decision, block: true,
       reason }`. `reason` = `provenance: <tool> arg derives from untrusted content (len=<n>, h=<hash>)` —
       never the matched value. Return `decision` unchanged otherwise.
     - `/provenance [on|off|strict|status]` command (`on`→enabled+mode default; `strict`→enabled+strict;
       `off`→disabled; `status`→print enabled/mode/caps/store size). Declares **no** capability.
       Return a teardown disposing the hooks/command.
  8. **(impl)** `src/host.ts`: `import provenance from "./extensions/provenance.js";` and append
     `["provenance", provenance]` to `BUILTIN_EXTENSIONS` **after** `["content-guard", contentGuard]` (so
     provenance tags the fenced body the model sees).
  9. **(verify)** `node --import tsx --test "test/provenance.test.ts" "test/host.test.ts"` — the Wave-1
     canonical-set test absorbs the +1 extension (count derived from the list); no dup tool/command names.
- **Per-task accept commands:**
  - `node --import tsx --test "test/provenance.test.ts" "test/host.test.ts"`
  - `npm run typecheck`
- **Exit condition:** AC-3..AC-7 + strict-mode tests pass; off-by-default inert; host canonical-set green;
  `npm test` green; `npm run typecheck` 0.

## 3. Engineering Constraints Index

- **Engineering norms:** CLAUDE.md "House conventions" + "Adding an extension" — ESM NodeNext `.js`
  specifiers; strict TS (`noUncheckedIndexedAccess` — guard `capsOf` array access, the `.find`/Set iter);
  zero deps but jiti; offline tests; `EAGENT_PROVENANCE=off` kill switch; append to `BUILTIN_EXTENSIONS`;
  offline test; **no capability declared** (it routes trust, gates via the existing layer). No kernel change.
- **Four-corner subagent template:** `references/loop-3-development.md`.
- **Commit conventions:** SKILL.md — `feat(phase1):`; trailers; no AI attribution.

## 4. Data and Fixture Dependencies

Reuse `MockProvider` (function responder to script foreign-read-then-sink-call) and a stub `UI` with a
configurable `confirm` (true/false) — mirror how `test/flow-guard.test.ts` / `test/secret-guard.test.ts`
drive `ui.confirm`. Inline test tools declaring the relevant capabilities. Offline, no new fixtures.

## 5. Regression Protection

- `npm test` (full suite) green at Phase end. Off-by-default means the extension is inert in the shipped
  config, so existing suites (incl. `flow-guard`/`content-guard`/`secret-guard`) are unaffected — the
  core regression net.
- The Wave-1 `BUILTIN_EXTENSIONS` canonical-set host test (count == list length, no dup tool/command
  names) covers the new registration.
- No kernel change → `kernel-surface.test.ts` unaffected (kernel stays 2182 lines).

## L2 Review Log

- **Round 1** — **zero severe, zero general** (4 clarifications: maxSegments default, hash choice,
  `ctx.call.name`, single-token S). Folded all into tasks 1/7 for L3 determinism.
- **Round 2 (confirming)** — **zero severe, zero general.** Two-generation satisfied. **L2 closed.**
