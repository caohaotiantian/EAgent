---
name: root-cause-analysis
description: Find the true cause of a failure using ranked, falsifiable hypotheses and discriminating evidence before proposing any fix.
allowed-tools: read, grep, glob, bash, run_code
triggers: debug, root cause, failure, why is this failing, regression
---
# Root-cause analysis

Use this when something is failing and the cause is not obvious. The goal is to
change the *cause*, not to patch the first theory that fits.

## Procedure

1. **Reproduce.** Trigger the failure and record the exact observed behavior
   (error, wrong output, hang). A cause you cannot reproduce, you cannot verify.
2. **Hypothesize.** Write 3-5 ranked, falsifiable hypotheses. Each must make a
   concrete prediction ("if H1, then I will see Y"). If you cannot state the
   prediction, it is a vibe — discard it.
3. **Discriminate.** Find the single observation that differs between your top two
   hypotheses, and go get it. Let the evidence pick the cause; do not confirm the
   first plausible one.
4. **Name the cause** only once a hypothesis survives its discriminating test. If
   none survives, gather more evidence — do not guess.
5. **Fix the cause, minimally.** Change what actually produced the failure, one
   thing at a time. Add a test that fails before the fix and passes after.

## Guardrails

- **Non-determinism is a flake, not a fix target here.** If it passes on re-run
  with no code change, name it as a flake and treat it as its own problem — do not
  loosen an assertion, add a blind retry, or bump a timeout to force a green bar.
- **Single-hypothesis anchoring is the top failure mode.** If you find yourself
  patching theory #1 without having ruled out #2 and #3, stop and gather the
  discriminating evidence first.
