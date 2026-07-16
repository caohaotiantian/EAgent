---
name: solve-hard-problem
description: A mixed expert crew for an open-ended, hard problem; the lead picks the pattern that fits.
lead: coordinator
members: software-architect, researcher, debugger, critic
pattern: auto
---
Solve the stated problem. It is open-ended: first decide what kind of problem it
is and choose the coordination pattern that fits (decompose-and-delegate for a
buildable task, parallel exploration for independent angles, generator-verifier or
consensus when the answer is uncertain and quality matters, blackboard when the
experts must build on each other's partial findings). Use the researcher to reduce
unknowns, the architect to structure a solution, the debugger to isolate causes
when something misbehaves, and the critic to break candidate answers before you
commit. Converge on a concrete, defensible solution and state your confidence and
the main risk that remains.
