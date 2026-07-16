# Prompts

Reusable **prompt building blocks** — rubrics, decomposition scaffolds, and
output-format snippets — meant to be *copied into* template bodies or pasted into
a run. Unlike `templates/`, `teams/`, `microagents/`, and `skills/`, this folder is
**not auto-loaded by any extension**; it is reference material for humans (and for
agents authoring new recipes).

Keep each fragment small and single-purpose so it composes. When a fragment proves
its worth inside several personas, consider promoting it into a shared base
template (via `extends:`) instead of copy-pasting.
