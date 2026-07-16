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
| `templates/` | **Agent recipes** — one expert persona per `.md` (prompt + model + tools + capabilities) | `templates` ext (`/template`, `spawn_template`) | yes, via `templates.dir` |
| `teams/` | **Crews** — a lead + template-backed member experts + a coordination pattern | `teams` ext (`/team`, `run_team`) | yes, via `teams.dir` |
| `microagents/` | **Keyword-triggered domain knowledge** — injected into context when a trigger word appears | `microagents` ext (`/microagents`) | yes, via `microagents.dir` |
| `skills/` | **Skills** — `SKILL.md` folders (Anthropic skill standard), model-pulled procedures | `skills` ext (`/skills`, `skill_read`) | yes, via `skills.dir` |
| `prompts/` | **Reusable prompt fragments** — building blocks to paste into template bodies | *reference material* — humans, not an extension | no (copy-in) |

## How it is wired (the discoverability fix)

EAgent's material dirs default to `~/.eagent/*`. This repo redirects them to the
in-repo library through a **committed config file** at the repo root:
[`eagent.config.json`](../eagent.config.json). The host reads it as a
**project-level default that overrides your user-global `~/.eagent/config.json`**
(project-over-user — the conventional "more-local wins"). It is in turn overridden
by a local, gitignored `./.eagent/config.json`, any `EAGENT_*` env var, or a
`/config` override — so per-machine and per-run choices still win, but a personal
`~/.eagent/config.json` does **not** shadow the repo library. Config resolution
overall is `override > env > file > default`. Run any EAgent entry point from the
repo root and the library is live:

```bash
npm run dev        # REPL — /template list, /team list
npm run serve      # HTTP host
```

**Alternative wiring** (no committed config, or running from elsewhere): copy
[`.env.example`](../.env.example) to `.env` and adjust, or set the env vars
directly:

```bash
export EAGENT_TEMPLATES_DIR="$PWD/library/templates"
export EAGENT_TEAMS_DIR="$PWD/library/teams"
export EAGENT_MICROAGENTS_DIR="$PWD/library/microagents"
export EAGENT_SKILLS_DIR="$PWD/library/skills"
```

Pointing a `*.dir` at the library **replaces** that source (each extension reads a
single directory), so your `~/.eagent/*` files for that kind are not read while you
run from this repo. To use your own directory instead **in this repo**, override
the committed default with an env var (`EAGENT_TEMPLATES_DIR=...`), a local
`./.eagent/config.json`, or a `/config` set — or remove the key from
`eagent.config.json`. Editing `~/.eagent/config.json` will **not** override it (the
committed project config wins, project-over-user). Note that redirecting
`skills.dir` also changes where the `skill_create` tool *writes* a new skill (into
`library/skills/`, i.e. the repo tree) — so authored skills show up as uncommitted
repo changes, to be reviewed like any other library addition.

## Using it

```
/template list                      # every recipe in library/templates
/template show security-auditor     # persona + tools + capability scope
/team list                          # every crew in library/teams
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

## Authoring doctrine (absorbed from the wider agent-skills ecosystem)

**Description is the trigger.** The `description` frontmatter is what the model — and
a team lead choosing whom to delegate to — reads to decide whether to use an
artifact. State *what it does AND when to use it* in the description, never only in
the body. Be deliberately pushy ("use whenever the user mentions X, even if not
asked explicitly") and add explicit near-misses ("do not use when …", pointing at
the right alternative). A thin description that says what it is but not when will be
under-selected. (The new `planner`/`explore`/`verifier`/`first-principles` recipes
follow this shape — copy their frontmatter.)

**Skill resource layout.** A skill folder may bundle three kinds of resource, each
with a distinct role:
- `scripts/` — executable helpers. Run them (`--help` first); do **not** read their
  source unless you are patching one. Put a one-line usage header at the top.
- `references/` — detail loaded **on demand** (large tables, per-language notes).
  The `SKILL.md` body is a *router* that points to them, not an inline dump.
- `assets/` — files used **in the output** (templates, boilerplate), never loaded
  into context.
Keep `SKILL.md` a router under ~500 lines; a fact lives in the body **or** a
reference, never both. Full heuristics: `library/prompts/skill-authoring.md`.

**Instruction house style.** Imperative; explain the *why* behind each rule; treat
ALLCAPS ALWAYS/NEVER as a yellow flag (usually an unexplained rule in disguise);
delete instructions that don't earn their keep; generalize rather than overfit to
one example. Reusable tone rules are committed once in
`library/prompts/communication-style.md`.

## Maintenance

This library is maintained like the rest of the repo: changes land through PRs,
one expert (or one team) per logical change. Keep `description`s accurate (they are
what the lead sees when choosing whom to delegate to) and keep tool/capability
scopes as tight as the role allows. The frontmatter is validated at load time by
each extension — an invalid file is skipped with a warning, never fatal.
