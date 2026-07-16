# Review rubric (fragment)

A reusable rubric to drop into any reviewer-style persona. Grade findings by real
severity and report most-severe first.

Review lenses, in order:
1. **Correctness** — does it do what it claims? Trace one concrete failing input
   (inputs to wrong output) for any suspected bug. Cite `file:line`.
2. **Blast radius** — are all consumers of the changed contract updated, including
   files outside the diff?
3. **Scope** — anything beyond the task (drive-by refactor, reformat, speculative
   abstraction)? Flag it.
4. **Clarity & consistency** — matches the codebase's style; names and comments are
   honest about what the code does.
5. **Tests** — does new behavior have a test that fails without the change?

Severity: **blocker** (must fix) > **general** (should fix) > **nit** (cosmetic).
Do not inflate — inflation wastes the reader's attention and hides real blockers.
