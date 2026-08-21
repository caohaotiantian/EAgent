/**
 * The one predicate deciding whether to mount Ink.
 *
 * This replaces the deleted `isFancy`. Without it a piped or redirected run
 * would paint escape sequences into a file, which is exactly what the engine's
 * machine paths are built to avoid — so the TUI refuses to start and the caller
 * falls through to the headless runner instead.
 *
 * Pure and injected so every branch is testable without a real terminal.
 */

export interface TtyEnv {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  columns: number | undefined;
  /** `TERM`; a value of `dumb` is an explicit request for no cursor control. */
  term: string | undefined;
  /** `CI`; a set value means no human is watching. */
  ci: string | undefined;
}

/** Reasons the TUI declines to mount, in the order they are checked. */
export type RefusalReason =
  | "stdin is not a terminal"
  | "stdout is not a terminal"
  | "TERM=dumb"
  | "CI environment";

/** `null` means "mount the TUI"; a string is the reason not to. */
export function refusalReason(env: TtyEnv): RefusalReason | null {
  if (!env.stdinIsTTY) return "stdin is not a terminal";
  if (!env.stdoutIsTTY) return "stdout is not a terminal";
  // Width is deliberately NOT a refusal: some pty wrappers and multiplexers
  // report 0 until the first resize, and Ink falls back to 80 columns anyway.
  // isTTY already establishes that a terminal is on the other end.
  if (env.term === "dumb") return "TERM=dumb";
  if (env.ci !== undefined && env.ci !== "" && env.ci !== "0" && env.ci !== "false") return "CI environment";
  return null;
}

export function envFromProcess(): TtyEnv {
  return {
    stdinIsTTY: Boolean(process.stdin.isTTY),
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    columns: process.stdout.columns,
    term: process.env["TERM"],
    ci: process.env["CI"],
  };
}
