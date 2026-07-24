/**
 * Transcript line flattening + viewport windowing (design D4/KDD4, AC4).
 *
 * The pure bridge between the shared `ViewModel` section tree and Ink's flat
 * column of `<Text>` rows. `transcriptLines` walks the reducer's ordered,
 * de-interleaved tree into display lines (a collapsed section contributes only
 * its header; an expanded one its full, untruncated body; children nest one
 * indent deeper), reusing the model's own `headerLine`/`bodyLines` so the rich
 * client and the engine plain renderer format identically. `windowLines` keeps
 * only the trailing `rows` — the bounded viewport a full-screen TUI lays out,
 * independent of history depth, so Ink's per-render layout cost stays bounded.
 *
 * Pure and offline-testable (no `ink`/`react`); the component in `app.tsx`
 * consumes it. Kept out of `view-model.ts` because line-to-row mapping is a
 * presentation concern of this front end, not the shared reducer.
 */

import { bodyLines, headerLine, type Section, type SectionKind, type SectionStatus, type ViewModel } from "../view-model.js";

export interface DisplayLine {
  /** The rendered text (without indentation — the component applies the pad). */
  text: string;
  kind: SectionKind;
  status: SectionStatus;
  /** True for a section's header line, false for a body/continuation line. */
  header: boolean;
  /** Nesting depth: 0 top-level, +1 per subagent/spawn level. */
  indent: number;
}

/** Flatten the section tree into ordered display lines, honoring collapse state. */
export function transcriptLines(model: ViewModel): DisplayLine[] {
  const out: DisplayLine[] = [];
  const walk = (s: Section, indent: number): void => {
    out.push({ text: headerLine(s), kind: s.kind, status: s.status, header: true, indent });
    if (!s.collapsed) {
      for (const line of bodyLines(s)) out.push({ text: line, kind: s.kind, status: s.status, header: false, indent });
    }
    for (const child of s.children) walk(child, indent + 1);
  };
  for (const s of model.sections) walk(s, 0);
  return out;
}

/**
 * Keep only the trailing `rows` lines — the bounded viewport (AC4). A
 * full-screen transcript shows its live tail; scrollback is the terminal's job.
 * `rows <= 0` (an unmeasured terminal) means "no bound" — render everything.
 */
export function windowLines(lines: DisplayLine[], rows: number): DisplayLine[] {
  if (rows <= 0 || lines.length <= rows) return lines;
  return lines.slice(lines.length - rows);
}
