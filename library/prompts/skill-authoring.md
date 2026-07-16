# Skill / recipe authoring (fragment)

Heuristics for writing a good `SKILL.md`, template, or microagent — distilled from
the wider agent-skills ecosystem and adapted to EAgent's context-frugality bet.

**The context window is a public good.** Only add what the model does not already
know. Do not restate general programming knowledge; capture the specific,
non-obvious thing (this project's convention, this API's gotcha, the exact
sequence that is fragile).

**Match the format to the degrees of freedom:**
- Many valid paths -> write prose guidance and let the model reason.
- One preferred pattern with variation -> give a parameterized script or template.
- A fragile, must-be-exact sequence -> give the exact script and say "run this".

**Bundled resources have three roles (skills):**
- `scripts/` — executable helpers. Run them; do **not** read their source unless
  you are patching one. Put a one-line usage header at the top of each.
- `references/` — detail loaded **on demand** (large tables, per-language notes).
  The SKILL.md body is a router that points to them; it does not inline them.
- `assets/` — files used **in the output** (templates, boilerplate), never loaded
  into context.

**Keep SKILL.md a router**, not an encyclopedia: under ~500 lines. A fact lives in
the body **or** a reference, never both.

**Description is the trigger.** State what it does **and when to use it** in the
frontmatter `description` (not the body). Be pushy ("use whenever the user mentions
X"), and add explicit near-misses ("do not use when …"). See the description
doctrine in `library/README.md`.

**House instruction style:** imperative; explain the *why* behind a rule; treat
ALLCAPS ALWAYS/NEVER as a yellow flag (usually a symptom of an unexplained rule);
delete any instruction that doesn't earn its keep; generalize, don't overfit to one
example.
