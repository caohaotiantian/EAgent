/**
 * `!` shell mode and `Ctrl+G` external-editor handoff.
 *
 * Both are pure decisions plus one injected effect, so the rules are testable
 * and the side effect (spawning a shell, spawning `$EDITOR`) is swapped out in
 * tests rather than mocked globally.
 */

export interface ShellResult {
  command: string;
  stdout: string;
  exitCode: number;
}

/**
 * Whether the buffer is in shell mode, and the command if so.
 *
 * `!` must be the FIRST character: a bang inside a sentence is punctuation, and
 * treating `wow! that worked` as a shell command would be a nasty surprise.
 */
export function shellCommand(text: string): string | null {
  if (!text.startsWith("!")) return null;
  const command = text.slice(1).trim();
  return command === "" ? null : command;
}

/**
 * How a shell result enters the conversation. The command and its output become
 * a user message, so the model can answer questions about it on the next turn
 * without a second round trip.
 */
export function shellTranscriptEntry(r: ShellResult): string {
  const status = r.exitCode === 0 ? "" : ` (exit ${r.exitCode})`;
  return `$ ${r.command}${status}\n${r.stdout.trimEnd()}`;
}

/**
 * The editor command line for `Ctrl+G`. `$VISUAL` wins over `$EDITOR` — the
 * former means "a full-screen editor is fine", which is exactly this case.
 */
export function editorCommand(env: { VISUAL?: string; EDITOR?: string }): string | null {
  const chosen = env.VISUAL || env.EDITOR;
  return chosen && chosen.trim() !== "" ? chosen.trim() : null;
}

/**
 * Strip the comment block an external editor session may have been seeded with.
 * Leading `#` lines are context for the human, never part of the prompt.
 */
export function stripEditorComments(text: string): string {
  return text
    .split("\n")
    .filter((l) => !l.startsWith("#"))
    .join("\n")
    .trim();
}
