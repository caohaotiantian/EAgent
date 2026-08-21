---
name: code-review
description: Reviews a change from several angles, then verifies each candidate finding before reporting.
lead: coordinator
members: explore, code-reviewer, verifier
pattern: generator-verifier
---
Review the target change for real defects. Have the explorer gather the diff and
the surrounding code that the change could affect (callers, related files). Have the
code reviewer produce candidate findings from multiple angles — correctness, blast
radius across untouched consumers, scope creep, and test coverage — each grounded in
file:line. Then have the verifier independently confirm each candidate: mark it
CONFIRMED (a concrete failing case reproduces it), PLAUSIBLE (real concern, not
demonstrated), or REFUTED (does not hold), quoting the deciding evidence. Report only
CONFIRMED and PLAUSIBLE findings, most-severe first, and prefer a few high-confidence
findings over a long list of nitpicks. Do not modify the code — this crew reviews and
verifies, it does not fix.
