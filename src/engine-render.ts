/**
 * The engine's plain, ordering-aware renderer.
 *
 * Folds the shared view model into an append-only transcript for every non-Ink
 * terminal — pipes, `--eval`, batch, dumb terminals, and the SEA binary's
 * interactive TTY. It de-interleaves concurrent reasoning-search forks (each
 * fork's stream is a nested section the reducer separates by acting agent),
 * collapses finished reasoning to a one-line header, and renders tool cards whose
 * full, untruncated args + result are revealed on demand via `/details`/`/expand`.
 * No alt screen and no active-region redraw: every line is written exactly once,
 * so native scrollback and piped output stay intact — the machine paths carry no
 * cursor bytes by construction. The `RenderController` seam lets the host's
 * display commands drive it exactly as the display modes require.
 */

import type { RenderController, Term } from "./tty.js";
import {
  applyControl as applyControlToModel,
  bodyLines,
  headerLine,
  initialModel,
  type ControlAction,
  type DisplayMode,
  type Section,
  type ViewModel,
} from "./view-model.js";

export interface EngineRenderOptions {
  term: Term;
}

export class EngineRenderer implements RenderController {
  readonly #term: Term;
  #committed = 0;
  #run = -1;
  #model: ViewModel = initialModel();

  /** Every committed line, in order — the test-observable transcript. */
  committedLines: string[] = [];

  constructor(opts: EngineRenderOptions) {
    this.#term = opts.term;
  }

  /** The active display mode — read by `/details` with no argument. */
  get mode(): DisplayMode {
    return this.#model.mode;
  }

  /** Consume a model update and commit every newly-finished top-level section. */
  onModel(model: ViewModel): void {
    this.#model = model;
    if (model.run !== this.#run) {
      // A fresh run: the prior run's sections were all committed on its agent_end,
      // so reset the per-run commit bookkeeping.
      this.#run = model.run;
      this.#committed = 0;
    }
    this.#commit(model);
  }

  /**
   * Apply a `/details`/`/expand`/`/collapse` control and reveal the result. The
   * transcript is append-only, so a revealed section is reprinted — with its new,
   * untruncated body — below what came before rather than rewriting scrolled-past
   * lines. A control arrives while the agent is idle, so nothing streams beneath.
   */
  applyControl(action: ControlAction): void {
    this.#model = applyControlToModel(this.#model, action);
    const m = this.#model;
    const indices = action.kind === "mode" ? m.sections.map((_, i) => i) : [action.n - 1];
    for (const i of indices) {
      const s = m.sections[i];
      if (!s) continue;
      for (const line of commitLines(s, 0)) this.#write(line);
    }
  }

  /** Commit every finished top-level section (all but the last while streaming; all
   *  of them once the run ends). Each line is written exactly once, so committed
   *  history is never rewritten — safe on any stream. */
  #commit(model: ViewModel): void {
    const upto = model.done ? model.sections.length : model.sections.length - 1;
    while (this.#committed < upto) {
      for (const line of commitLines(model.sections[this.#committed]!, 0)) this.#write(line);
      this.#committed++;
    }
  }

  #write(line: string): void {
    this.#term.write(line + "\n");
    this.committedLines.push(line);
  }
}

/** The permanent rendering of a finished section (+ its nested children). Collapse
 *  state (set by the display mode or a per-section control) is the single switch:
 *  an expanded section reveals its full, untruncated body — reasoning/answer text or
 *  a tool card's complete args + result — while a collapsed one shows only its
 *  header (which carries the bounded arg summary). */
function commitLines(s: Section, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const out: string[] = [pad + headerLine(s)];
  if (!s.collapsed) for (const l of bodyLines(s)) out.push(pad + "  " + l);
  for (const child of s.children) out.push(...commitLines(child, indent + 1));
  return out;
}
