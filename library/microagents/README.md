# Microagents

A microagent is **conditional domain knowledge**: a body of guidance that the
`microagents` extension injects into the agent's context **only when a trigger
keyword appears in the latest user message**. It is the middle ground between
always-on project context and model-pulled skills — zero cost when the topic
does not come up, present exactly when it does.

Use a microagent when you want: *"whenever the user mentions X, the agent should
remember these facts/rules."* Use a **template** instead when you want a whole
expert persona to delegate a task to.

## Format

```markdown
---
name: <optional; defaults to filename>
triggers: keyword-one, keyword-two   # required, comma-list, matched whole-word, case-insensitive
description: <optional one line>
---
The guidance to inject when a trigger word appears in the user's message.
```

A file with **no triggers is not a microagent** and is skipped. Matching is
whole-word (so `k8s` fires on "k8s" but not inside another token). Matched bodies
are injected as an ephemeral system note, prefix-filled under a size cap.

## Note on scope

These are usually **project-specific** — your repo's conventions, your infra
rules, your domain's gotchas. The one shipped example below is about working in
*this* repository; replace or extend it with the facts your work actually needs.
List what is active with `/microagents`.
