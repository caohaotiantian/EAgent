---
name: shell-strategy
triggers: bash, shell, git, npm, docker, terminal, command
description: Non-interactive-safe shell habits so commands never hang in a headless agent session
---
You are running shell commands in a non-interactive (no TTY) session. Commands that
wait for a pager or a prompt will hang forever. Keep the shell non-blocking:

- **Disable pagers.** Use `git --no-pager <cmd>` or set `GIT_PAGER=cat`; pipe
  long output to `cat`. Never rely on `less`/`more`/`vim` opening.
- **Assume yes.** Pass `-y` / `--yes` / `--non-interactive` to installers and
  scaffolders (`npm`, `apt`, `pip`, generators); set `CI=1` where tools honor it.
- **Never launch an interactive program** (`vim`, `nano`, `top`, a REPL, `ssh`
  without a command, `git rebase -i`). Use the non-interactive equivalent or a
  flag.
- **Bound anything that can run long or stream.** Add explicit limits/timeouts and
  `--max-count`/`head` on searches; do not `tail -f`.
- **Prefer idempotent, single-purpose commands** you can verify by exit code over
  one giant pipeline whose failure point is ambiguous.
