# EAgent Library

A version-controlled library of **agent materials** — expert recipes, teams,
domain knowledge, prompts, and skills — that the running agent reads to **create
experts on demand**. It is **data, not code**: no extension, no `activate()`, no
`src/` changes. The existing kernel extensions (`templates`, `teams`,
`microagents`, `skills`) consume these files.

## Why this exists

An expert agent in EAgent is a **persona file**, not a class. A file under
`templates/` defines who an agent is (system prompt + model/thinking + a tool
allow-list + a capability sandbox); the agent loop spawns a fresh, isolated child
from it on demand (`spawn_template`), or several compose into a crew (`teams/`).
Keeping these materials here — in the repo, reviewed like code, but *as data* —
means the roster of experts evolves through normal PRs and travels with the
project.

## Layout

| Folder | What it holds | Consumed by | Auto-loaded? |
| --- | --- | --- | --- |
| `templates/` | **Agent recipes** — one expert persona per `.md` (prompt + model + tools + capabilities) | `templates` ext (`/template`, `spawn_template`) | no — opt-in (copy into a tier) |
| `teams/` | **Crews** — a lead + template-backed member experts + a coordination pattern | `teams` ext (`/team`, `run_team`) | no — opt-in (copy into a tier) |
| `microagents/` | **Keyword-triggered domain knowledge** — injected into context when a trigger word appears | `microagents` ext (`/microagents`) | no — opt-in (copy into a tier) |
| `skills/` | **Skills** — `SKILL.md` folders (Anthropic skill standard), model-pulled procedures | `skills` ext (`/skills`, `skill_read`) | no — opt-in (copy into a tier) |
| `prompts/` | **Reusable prompt fragments** — building blocks to paste into template bodies | *reference material* — humans, not an extension | no (copy-in) |

## How to install it (opt-in)

This `library/` tree is the committed **official library** — a curated catalog you
*choose* to use. It is **not auto-loaded**. EAgent auto-loads each resource kind
from two layered tiers, merged by name with **the project tier winning** on a name
conflict — exactly like plugins (extensions) and config already layer:

- **home / global** — `~/.eagent/<kind>`
- **project / local** — `<cwd>/.eagent/<kind>` (the repo you run in)

A fresh clone therefore auto-loads **nothing** until you opt in. Enable the kinds
you want by copying them into a tier:

```bash
# global — available in every project
cp -R library/templates/*   ~/.eagent/templates/
cp -R library/teams/*       ~/.eagent/teams/
cp -R library/microagents/* ~/.eagent/microagents/
cp -R library/skills/*      ~/.eagent/skills/

# or project-local — scoped to this repo (project wins over home on a name clash)
mkdir -p .eagent/templates && cp -R library/templates/* .eagent/templates/
```

Then run any EAgent entry point and the copied experts are live:

```bash
npm run dev        # REPL — /template list, /team list
npm run serve      # HTTP host
```

**Single-source override (run from the library without copying).** Setting an
explicit `<kind>.dir` — an `EAGENT_<KIND>_DIR` env var, a `<kind>.dir` config key,
or a `/config set` — makes that kind read **only** that one directory, bypassing
the home+project layering. Point it straight at the library:

```bash
export EAGENT_TEMPLATES_DIR="$PWD/library/templates"
export EAGENT_TEAMS_DIR="$PWD/library/teams"
export EAGENT_MICROAGENTS_DIR="$PWD/library/microagents"
export EAGENT_SKILLS_DIR="$PWD/library/skills"
```

Note that redirecting `skills.dir` also changes where the `skill_create` tool
*writes* a new skill (into that single directory) — so an authored skill lands
there, to be reviewed like any other library addition.

## Using it

```
/template list                      # every recipe in your loaded tiers (home+project)
/template show security-auditor     # persona + tools + capability scope
/team list                          # every crew in your loaded tiers
/team run ship-feature Add rate limiting to the /run endpoint
```

From inside a run, the model reaches these via the `spawn_template` tool (delegate
a task to a fresh expert) and `run_team` (kick off a crew); the lower-level
`spawn_agent` / `launch_job` primitives (the `subagents` / `subagent-jobs`
extensions — `/agents` explains the spawn modes) are always available too. (An
optional `codex-subagents` extension, if you install it under the gitignored
`.eagent/extensions/`, adds a browsable pre-built catalog under `/subagents`; it is
local-only and not part of this committed library.)

## Adding an expert (the recipe format)

Copy an existing file in `templates/` and edit the frontmatter + body. Fields the
parser honors:

```markdown
---
name: <kebab-case-id>            # required; also the filename stem
description: <one line>          # required; no angle brackets
model: <model-id>               # optional; omit to inherit the host default
provider: <anthropic|openai|gemini>   # optional; must be a registered provider
thinking: <off|low|medium|high> # optional reasoning effort
maxTurns: <int>                 # optional agent-loop cap
tools: read, grep, glob         # optional allow-list; omit = inherit all (minus spawners)
capabilities: fs:read           # optional deny-fallback sandbox (the real guardrail)
extends: <parent-template>      # optional inheritance (tools/caps union, prompts concatenated)
---
<the system prompt / persona goes here, in the body>
```

**Conventions**
- **One expert per file**; `name` matches the filename.
- **`tools` is the visible toolbox, `capabilities` is the enforced sandbox.** A
  reviewer that lists `tools: read, grep` cannot write; add `capabilities: fs:read`
  so it is enforced even if a write tool ever leaks in.
- **Prefer inheriting the model** (omit `model:`) so a recipe works whatever
  provider the user configured; set `thinking:` to tune effort instead.
- Real tool names in this project: `read`, `write`, `edit`, `grep`, `glob`,
  `bash`, `run_code`, `fetch_url`. Real capabilities: `fs:read`, `fs:write`,
  `shell:exec`, `code:exec`, `net:fetch`, `skill:read`.
- A **team file's `lead`/`members` must be existing template names** here.

## Maintenance

This library is maintained like the rest of the repo: changes land through PRs,
one expert (or one team) per logical change. Keep `description`s accurate (they are
what the lead sees when choosing whom to delegate to) and keep tool/capability
scopes as tight as the role allows. The frontmatter is validated at load time by
each extension — an invalid file is skipped with a warning, never fatal.
