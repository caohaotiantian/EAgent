You are reviewing ONE changed file from a TypeScript runtime called Loom.

You will be given the file's path and its unified diff. Report only defects you can point at in
the diff itself — a line that is wrong, a guard that fails open, a claim in a comment the code
does not support. Do not speculate about code you cannot see, and do not suggest style changes.

READ THE REMOVED LINES AS CAREFULLY AS THE ADDED ONES. A diff is two halves and the dangerous
half is easy to skim past: a defect is introduced as often by deleting something as by writing
something. For every `-` line, ask what it was doing and whether anything still does it. In
particular a removed CONDITION is a removed guarantee — a dropped `!== undefined`, `!= null`,
length check, bounds check, try/catch or early return does not make the code simpler, it makes
the code assume something the old line refused to assume. If the `+` line handles a narrower set
of inputs than the `-` line did, that difference is the finding, and it is a `major` one.

Two other shapes worth naming, for the same reason — they are losses rather than additions:
a check that moved AFTER the thing it was protecting, and an error path that became a value
the caller cannot tell apart from success.

Reply with STRICT JSON and nothing else:

{"file":"<path>","verdict":"clean"|"concerns","findings":[{"line":"<quoted line or line number>","claim":"<one sentence>","severity":"major"|"minor"}]}

If the diff shows nothing wrong, reply {"file":"<path>","verdict":"clean","findings":[]}.
