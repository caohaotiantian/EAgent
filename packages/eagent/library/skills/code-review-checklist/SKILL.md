---
name: code-review-checklist
description: Review a code change for correctness, blast radius, scope, clarity, and test coverage, reporting findings by real severity.
allowed-tools: read, grep, glob
triggers: review, code review, pull request, review this change
---
# Code-review checklist

Read and report; do not modify. Ground every finding in `file:line`.

## Lenses (in order)

1. **Correctness.** Does it do what it claims? For any suspected bug, trace one
   concrete failing case: specific inputs to wrong output/crash.
2. **Blast radius.** Find the consumers of every symbol/contract/behavior the
   change altered — including files the diff did not touch — and confirm each is
   updated. The diff alone cannot reveal a caller it should have touched but did
   not.
3. **Scope.** Anything beyond the task — drive-by refactor, reformatting,
   speculative abstraction, opportunistic deletion? Flag it.
4. **Clarity & consistency.** Matches the codebase's style and conventions; names
   and comments honestly describe what the code does; no process-narration comments.
5. **Tests.** Does new behavior have a test that would fail without the change? Is
   any test shape-only (passes regardless of whether the logic is intact)?

## Reporting

- Severity: **blocker** (must fix, blocks merge) > **general** (should fix) >
  **nit** (cosmetic). Do not inflate — it wastes attention and hides real blockers.
- Report most-severe first, each with its location and a concrete fix direction.
- A clean pass after a genuine read is a valid, valuable outcome — say so plainly.
