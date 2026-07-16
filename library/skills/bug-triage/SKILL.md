---
name: bug-triage
description: Triage a reported bug into an actionable report with a root-cause hypothesis and a confidence rating. Use whenever a bug or failure is reported and it is not yet clear what is wrong or where — before attempting a fix. Do not use once the cause is already known and you just need to implement the fix.
allowed-tools: read, grep, glob, bash
triggers: bug, triage, failing, broken, error report, investigate a failure
---
# Bug triage

Turn a vague bug report into a precise, actionable one. Investigate to a defensible
hypothesis; do not fix here.

## 1. Gate on a minimum-viable report
Before investigating, make sure you have: the expected vs actual behavior, a
reproduction (or how it was observed), and the environment. If a load-bearing piece
is missing and you cannot derive it, **stop and ask** rather than guess.

## 2. Check for duplicates
Search the codebase / issues for the same symptom before digging — the fastest fix
is "already known".

## 3. Investigate by hypothesis
- Reproduce and record the exact observed failure.
- Form 3-5 ranked, falsifiable hypotheses; seek the discriminating evidence that
  separates the top two (see the `root-cause-analysis` skill).
- **Stop-and-ask triggers** — escalate instead of guessing when: 3 hypotheses have
  failed their tests, the cause reaches into a dependency or external system you
  cannot inspect, or the fix would require a product/scope decision.

## 4. Rate confidence (tie it to evidence depth)
- **High** — reproduced, cause traced to a specific `file:line`, and a discriminating
  test confirmed it.
- **Medium** — a strong hypothesis with partial evidence; the exact line is not yet
  pinned.
- **Low** — a plausible direction only; more evidence needed.

## Report template
```
Summary:      <one line>
Severity:     <blocker | major | minor>
Repro:        <exact steps / inputs -> observed>
Expected:     <what should happen>
Root cause:   <hypothesis + file:line evidence>   (Confidence: High|Medium|Low)
Fix sketch:   <the minimal change that would address the cause>
Open:         <what is still unknown / what to ask>
```
