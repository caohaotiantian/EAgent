/**
 * Terminal seam for the engine plain renderer.
 *
 * `Term` is the narrow surface the renderer depends on, so a test can drive it
 * with an injected fake in place of `process.stdout` / `process.stdin`.
 * `fromStdio()` is the real adapter; its getters read live so a resize
 * (`columns` change) is observed on the next paint. `isFancy()` is the single
 * predicate that decides the interactive human path — every non-interactive /
 * dumb-terminal / redirected-stdout fallback folds into its conjuncts, so the
 * machine paths emit zero cursor bytes by construction.
 */

import type { ControlAction, DisplayMode } from "./view-model.js";

/** The minimal terminal surface a renderer needs. Injected so it is testable. */
export interface Term {
  readonly isTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  write(s: string): void;
  /** Present only on a raw-mode-capable input TTY. */
  setRawMode?(raw: boolean): void;
}

/**
 * The renderer surface the host's display commands drive. The engine plain
 * renderer implements it, so `/details`/`/expand`/`/collapse` work as commands
 * (not raw-mode keys), and a test double can record the applied controls.
 */
export interface RenderController {
  /** Apply a display control and reveal the result. */
  applyControl(action: ControlAction): void;
  /** The active display mode (for `/details` with no argument). */
  readonly mode: DisplayMode;
}

/**
 * The braille spinner frames. Exported as the single source so the
 * non-interactive-parity assertion can import the exact set and prove none of
 * them leak into a machine / piped stream.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * The one predicate gating the interactive human path. Named `isFancy` (not
 * `fancy`) so it never shadows a local `const fancy = isFancy(...)` at a call
 * site. `interactive` already excludes `--eval`/batch; the `isTTY`/`columns`
 * conjuncts close the stdin-TTY / stdout-pipe (`eagent > log`) case;
 * `term_env !== "dumb"` honors the dumb-terminal lever.
 */
export function isFancy(term: Term, opts: { interactive: boolean; term_env: string | undefined }): boolean {
  return opts.interactive && term.isTTY && (term.columns ?? 0) > 0 && opts.term_env !== "dumb";
}

/** The real adapter over a Node write stream + input stream. Getters read live. */
export function fromStdio(
  out: NodeJS.WriteStream = process.stdout,
  inp: NodeJS.ReadStream = process.stdin,
): Term {
  return {
    get isTTY(): boolean {
      return Boolean(out.isTTY);
    },
    get columns(): number | undefined {
      return out.columns;
    },
    get rows(): number | undefined {
      return out.rows;
    },
    // A property lookup at call time (not a bound method) so a test that swaps
    // `process.stdout.write` to capture output still sees the writes.
    write: (s: string): void => {
      out.write(s);
    },
    setRawMode:
      inp.isTTY && typeof inp.setRawMode === "function" ? (raw: boolean): void => void inp.setRawMode(raw) : undefined,
  };
}
