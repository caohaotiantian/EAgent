# Status block (fragment)

A fenced, machine-parseable end-of-turn sentinel for autonomous or long-running
runs. A supervising loop reads it to decide whether to continue or stop. Emit it as
the **last** thing in the turn, one field per line, values on the same line.

```
STATUS: IN_PROGRESS | BLOCKED | COMPLETE
FILES_MODIFIED: <count>
WORK_TYPE: implementation | tests | docs | investigation
EXIT_SIGNAL: false
RECOMMENDATION: <one line: the single next action, or why you are blocked>
```

Contract for the reader (dual-condition exit gate):
- **Stop only when `STATUS: COMPLETE` AND `EXIT_SIGNAL: true`.** Either alone does
  not stop the loop.
- `EXIT_SIGNAL: false` **overrides** a `STATUS: COMPLETE` — if there is any doubt
  the work is truly done, keep the signal false.
- Match the field lines exactly (start-of-line, uppercase keys) so a regex can
  anchor on them.
