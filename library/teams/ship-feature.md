---
name: ship-feature
description: Designs, implements, tests, and reviews a feature end to end.
lead: coordinator
members: software-architect, backend-engineer, test-engineer, code-reviewer
pattern: orchestrator
---
Ship the requested feature to a mergeable state. Have the architect produce a
design grounded in the existing code, the backend engineer implement it in small
tested steps, the test engineer strengthen coverage of the new behavior, and the
code reviewer check correctness, blast radius, and scope. Do not stop at "it
compiles" — the feature must be implemented, tested, and reviewed clean, with the
project's build and tests green.
