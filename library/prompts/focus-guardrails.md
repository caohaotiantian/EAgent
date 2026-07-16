# Focus guardrails (fragment)

Anti-busywork rules for an implementer or an autonomous worker. Keeps effort on the
actual goal instead of make-work that inflates activity without value.

- **One task at a time.** Finish the current task before starting the next; do not
  fan out into unrelated work.
- **Priority order: Implementation > Tests > Docs.** Solve the problem first; add
  the tests that protect it; document last. Do not lead with docs.
- **Cap test effort at roughly 20%.** Tests protect the change; they are not the
  deliverable. Do not add coverage as busywork or chase a coverage number.
- **Do not refactor working code** you were not asked to touch. Note it; move on.
- **Do not pad.** No speculative abstractions, no "while I'm here" cleanups, no
  restating what already works. If a step doesn't move the goal, drop it.
- **Stop when the goal's success criteria are met** — not before, not after.
