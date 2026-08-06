/**
 * Design-document drift.
 *
 * The design documents are the contract surface, and a contract that quietly stops
 * describing the code is worse than no contract — it is a confident wrong answer. These
 * tests read the documents and check the claims that can be checked mechanically.
 *
 * Deliberately narrow. Only facts a machine can verify are pinned here; prose stays
 * prose, and the JOURNAL is a record of what happened and is never rewritten to match.
 *
 * Three registries carry the exceptions, all of the same shape — an exact set, each row
 * with a reason, so that closing a gap fails the suite and sends its author to the
 * paragraph that has been promising it:
 *
 *   - `DESIGNED_NOT_BUILT` — identifiers the corpus names that `src/` does not have.
 *   - `NEVER_RAISED` — error codes that exist and that nothing throws.
 *   - `NEVER_APPENDED` — event types that exist and that nothing writes. Newest, and added
 *     because a declared-folded-never-appended event was the root cause of a severe
 *     authorization defect; see its docstring.
 *
 * ## THE ABSENCE MARKERS — read this before silencing anything
 *
 * Three consecutive review waves each found a design document asserting something the
 * code does not do — a span emitted nowhere, an error code nothing raises — and each
 * time a human had to grep for it. The checks below read BOTH the markdown and `src/`
 * and fail on the disagreement, so the noticing is mechanical.
 *
 * A design document is allowed to name something that is not in the code. It is not
 * allowed to do so *silently*. The escape hatch is two markers, spelled exactly:
 *
 *     DESIGNED-NOT-BUILT(loom.scheduler.tick)   — designed, unbuilt. Build it or delete
 *                                                 the design.
 *     NOT-IN-CODE(E_SUBSCRIBER_OVERFLOW)        — named only to say it is ABSENT: a
 *                                                 negative statement about the contract,
 *                                                 or history. Nothing to build.
 *
 * The second spelling exists because the first is a claim, and an author writing "the
 * contract is that `publish` never throws, so there is no `E_SUBSCRIBER_OVERFLOW`" was
 * forced to mark it DESIGNED — telling the next reader to go build a code the paragraph
 * had just argued should not exist. The registry pins which spelling a symbol may carry,
 * so the softer word cannot become the cheaper word.
 *
 * Both obey five rules, which together are the reason a marker cannot be used to make an
 * inconvenient failure go away:
 *
 *  1. **It names one identifier, in parentheses.** `loom.*` for a span or telemetry
 *     attribute, `E_*` for an error code — the two families a marker MAY name. (The guard
 *     tracks a third, `GRAPH\d+` compiler rules, and deliberately does not let a marker
 *     silence one: a rule the compiler cannot emit is an author writing graphs against a
 *     diagnostic that will never arrive, and there is no version of that worth a caveat.)
 *     Anything else fails, so the marker cannot decay into a general-purpose "ignore me".
 *     Concepts that are not identifiers (a state in an FSM, a scheduling policy, a
 *     method) get prose, not a marker.
 *  2. **It is file-scoped.** A marker covers the identifier only in the file that carries
 *     it. Marking `loom.scheduler.tick` in D9 does not license an unqualified claim about
 *     it in D12 — a reader of D12 has to be told there too.
 *  3. **The registry below must carry it, AND must list the file, AND must agree on the
 *     spelling.** Each row pins `markedIn`: the exact set of documents allowed to carry
 *     that marker, checked as an equality. So *marking* is two edits in two files, one of
 *     them this test, even for an identifier that is already registered.
 *
 *     That is a statement about the marker, and NOT a claim that two edits are the only
 *     way to make a failure disappear — see "What a determined author can still do".
 *  4. **A stale marker fails.** Every registry entry is checked to be genuinely absent
 *     from `src/`. Mark something that exists and the suite goes red, so markers cannot
 *     be sprayed defensively and cannot outlive the gap they describe: the day the span
 *     is emitted, this test tells you to delete the caveat.
 *  5. **A marker inside an HTML comment silences nothing.** `<!-- DESIGNED-NOT-BUILT(x) -->`
 *     is found by the guard and rejected by it. Rule 2's entire rationale is that the
 *     reader of *this* document has to be told, and a caveat that renders as nothing
 *     tells nobody.
 *
 * Grep the corpus with `grep -rnE 'DESIGNED-NOT-BUILT|NOT-IN-CODE' design/loom/`. The
 * convention is also recorded in `design/loom/README.md` under Conventions, which is
 * where an author who has never opened this file will look.
 *
 * ## Evasion, and what the scanner does about it
 *
 * A regex over markdown is fooled by markdown, and by Unicode. Four ways of writing an
 * identifier used to read as no identifier at all:
 *
 *   - emphasis inside it — `loom.**schedule**.admit`;
 *   - a line break inside it — `loom.` ⏎ `schedule.admit`;
 *   - a character that renders as nothing inside it — `loo<U+200B>m.schedule.admit`;
 *   - an inline HTML comment inside it — `loom.<!-- -->schedule.admit`.
 *
 * The last two are worse than the first two, because they render as nothing: the document
 * a reviewer reads is unchanged, so the diff looks like a whitespace edit or like nothing
 * at all. `scannable()` normalizes all four away, and `EVASIONS` is the corpus that pins
 * it, one row per way that has actually been tried.
 *
 * THE CLASS OF "RENDERS AS NOTHING" IS NOT `\p{Cf}`, and this file said it was. Stripping
 * `\p{Cf}` closed U+200B/200C/200D/FEFF/00AD and the bidi controls, and left open U+034F
 * COMBINING GRAPHEME JOINER, the variation selectors U+FE00–FE0F and U+E0100–U+E01EF, the
 * Mongolian free variation selectors, and the Hangul fillers — `\p{Mn}` and `\p{Lo}`, all
 * of them invisible, each of them enough on its own to silence a `loom.*` claim. The class
 * that means what a reader's eye means is Default_Ignorable_Code_Point; `INVISIBLE` strips
 * it in union with `\p{Cf}`, over code points rather than code units, and the six rows this
 * added to `EVASIONS` were each watched to fail first.
 *
 * The joins and the emphasis deletions both needed care, because the obvious version of
 * either cries wolf. ONE RULE COVERS BOTH: **A NORMALIZATION MAY RECOVER A CLAIM; IT MAY
 * NEVER INVENT ONE.** A cut is kept only if a name the guard already knows straddles it.
 * So prose ending a line with `loom.run.` stays two lines instead of becoming a claim about
 * `loom.run.the`; and `` `loom.run` `` followed by a plural `s` keeps its backtick instead
 * of becoming a claim about `loom.runs`. See `straddles` and `scannable`.
 *
 * ## What a determined author can still do
 *
 * Reproduced, not assumed — each of these was run against this file's scanner, and the
 * first is pinned as a test (`THE CONFUSABLE BYPASSES ARE STILL OPEN`) so that closing it
 * fails the suite rather than quietly outdating this paragraph:
 *
 *   - **A confusable.** `lооm.scheduler.tick` with Cyrillic `о` is invisible to the eye and
 *     to this guard, in one file, with no edit here. So are fullwidth `ｌｏｏｍ` and the
 *     mathematical alphanumerics. NFKC — the cheap answer — closes the last two and does
 *     nothing for the first, because Cyrillic `о` is a different letter rather than a
 *     compatibility variant, and that is demonstrated in the test rather than argued here.
 *     Closing the first needs a confusable skeleton table, which is either a runtime
 *     dependency (invariant 1 forbids it) or a hand-maintained table far larger than the
 *     guard it protects.
 *   - **A line break inside a name the guard has never heard of.** Unknown names are not
 *     joined, by design (above). What survives on the first line is usually still
 *     identifier-shaped, so the failure is LOUD but names something nobody wrote —
 *     `loom.brand.` ⏎ `new` is reported as a claim about `loom.brand`. It is silent only
 *     when the fragment is not identifier-shaped (`loom.` ⏎ `foo`) or is itself a name
 *     that exists (`loom.run` ⏎ `ner.tick`).
 *   - **Emphasis inside the FIRST segment of a name the guard has never heard of.** The
 *     same limit, one pass earlier and with no loud half: `loom.**brand**.new` keeps its
 *     asterisks, because no known name straddles them, and `loom.*` matches no span
 *     pattern — so nothing at all is reported. Emphasis later in the name
 *     (`loom.brand.**new**`) is loud-and-wrong instead, reporting `loom.brand`. This is the
 *     price of not crying wolf on `` `loom.run` ``+`s`, and it was paid deliberately: the
 *     file's own header calls a guard that cries wolf fatal, and calls silence a limit.
 *
 * So the guard raises the price of hiding a claim. It is a tripwire for drift, not a proof
 * against an author with commit rights, and rule 3's "two edits in two files" is the cost
 * of the SUPPORTED escape, not a bound on every escape.
 *
 * WHAT THIS GUARD STILL CANNOT SEE is written down at the bottom of the file, under
 * "The stricter version". Read it before assuming a green suite means the docs are true.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CODES } from "../src/errors.ts";
import { EVENT_TYPES } from "../src/journal/events.ts";
import { ESCALATION_RULES } from "../src/run/escalation.ts";

/** The compiler's own taxonomies, so the test cannot drift from the code either. */
const NODE_TYPES = ["function", "agent", "tool", "router", "join", "evaluator", "human_gate", "subgraph"] as const;
const EDGE_KINDS = ["seq", "conditional", "fanout", "join", "error", "compensation", "loop"] as const;

const DESIGN_DIR = fileURLToPath(new URL("../../../design/loom/", import.meta.url));
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * The characters that render as NOTHING — the class this guard strips before it reads.
 *
 * `\p{Cf}` alone was WRONG, and was announced in this file as having closed the hole. It
 * covers the zero-width space and joiners, the soft hyphen, the BOM and the bidi controls,
 * and it covers none of these, every one of which is invisible and every one of which
 * silenced a `loom.*` claim completely (see `EVASIONS`):
 *
 *   - U+034F COMBINING GRAPHEME JOINER and U+FE00–FE0F VARIATION SELECTOR-1..16, `\p{Mn}`;
 *   - U+E0100–U+E01EF VARIATION SELECTOR-17..256, `\p{Mn}` and ASTRAL;
 *   - U+180B–U+180D MONGOLIAN FREE VARIATION SELECTOR, `\p{Mn}`;
 *   - U+115F, U+1160, U+3164, U+FFA0 — the Hangul fillers, `\p{Lo}`. Letters.
 *
 * The class that means "renders as nothing" is Default_Ignorable_Code_Point, which is what
 * a reader's eye is actually using. It is not a superset of `\p{Cf}` — U+0600 ARABIC NUMBER
 * SIGN is a format character that renders — so the union of the two is stripped, and the
 * only claim made for the union is the one the tests below check: it contains no line
 * terminator, so removing it never moves a line number, and it contains nothing visible, so
 * removing it cannot join two things a reader sees apart.
 *
 * Written `/…/gu` and applied to whole strings rather than to `raw[i]`: a lone surrogate
 * matches no property escape, so a code-unit walk cannot see U+E0100 at all.
 *
 * WHAT THIS DOES NOT CLOSE is the confusable — `lооm` with Cyrillic `о` — and that is not
 * a character class at all. `THE CONFUSABLE BYPASSES ARE STILL OPEN` pins it, with the
 * reason the cheap fix does not work.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const stripInvisible = (s: string): string => s.replace(INVISIBLE, "");
/** The same class without `g`, so `.test` is stateless. DERIVED, so the two cannot drift. */
const IS_INVISIBLE = new RegExp(INVISIBLE.source, "u");

/**
 * One design document, with the characters a reader cannot see already gone.
 *
 * Stripped HERE rather than only in `scannable`, so that every check reading a document
 * as plain text — the taxonomy `includes`, the table-row `split`, the marker scan — is
 * looking at what renders, not at what was typed. Removing an `INVISIBLE` never moves a
 * line number, which the test below this file's scanner checks rather than asserting.
 */
const design = (name: string): string => stripInvisible(readFileSync(join(DESIGN_DIR, name), "utf8"));

/** Files that are not text, and so cannot make a claim about the code. */
const NOT_TEXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".woff", ".woff2"]);

/**
 * Every design document except the JOURNAL — RECURSIVELY, and at any extension.
 *
 * Both of those are load-bearing. A non-recursive `readdir` filtered to `.md` let a whole
 * document escape every check below by living in a subdirectory or being called
 * `NOTES.txt`, which is a bypass nobody would have to intend.
 *
 * The JOURNAL is append-only history — a record of what was true when it was written, so
 * "drift" is not a defect in it and rewriting it to match today's code would destroy the
 * only account of how the code got here.
 */
function textFilesUnder(dir: string, skip: ReadonlySet<string>): readonly string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => !skip.has(f))
    .filter((f) => !NOT_TEXT.has(extname(f).toLowerCase()))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
}

const DESIGN_FILES: readonly string[] = textFilesUnder(DESIGN_DIR, new Set(["JOURNAL.md"]));

/** Every `.ts` under `src/`, so "does the code do this?" is asked of all of it. */
function sourceFiles(): readonly string[] {
  return readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(SRC_DIR, f))
    .sort();
}

// ── Reading a document without being fooled by markdown ──────────────────────

/** Characters markdown uses for emphasis. `_` is NOT here: it is legal inside `E_*`. */
const EMPHASIS = new Set(["*", "`", "~"]);
const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_.]/.test(c);

/** How far back a join may reach. Bounded, and never past the start of the line. */
const TAIL_WINDOW = 96;

/** A normalized document plus a map from an index in it back to a source line. */
interface Scan {
  readonly text: string;
  line(index: number): number;
}

/** Every `[start, end)` in `text` that spells a name this guard has already heard of. */
function knownNameSpans(text: string, known: ReadonlySet<string>): readonly (readonly [number, number])[] {
  const out: (readonly [number, number])[] = [];
  for (const re of [SPAN_RE, CODE_RE, GRAPH_RE]) {
    for (const m of text.matchAll(re)) {
      const name = m[1]!;
      if (known.has(name)) out.push([m.index, m.index + name.length] as const);
    }
  }
  return out;
}

/**
 * THE ONE RULE BOTH PASSES OBEY: **a normalization may recover a claim; it may never
 * invent one.**
 *
 * A cut at offset `cut` — a closed-up line break, a deleted emphasis run, a deleted inline
 * HTML comment — is allowed only if some name the guard already knows STRADDLES it: begins
 * strictly before it and ends strictly after it. Known means emitted by `spans.ts`,
 * declared in `errors.ts`, emitted by `validate.ts`, or named in the registry below —
 * including registered names that do not exist, so wrapping cannot spread one silently.
 *
 * Pass 2 used to be the only pass with this rule, and pass 1 was the poorer for it. What
 * pass 2 replaced was a table of five tail/next regex pairs keyed to the three identifier
 * families: any line ending `…folded into loom.run.` followed by a lowercase word became a
 * claim about `loom.run.the`, and "every code is prefixed E_" followed by a capital became
 * `E_RETRIES`. What pass 1 did until this wave is the same defect in one line rather than
 * two: `` `loom.run` `` followed by a plural `s` had its closing backtick deleted, because
 * a trailing letter is an identifier character, and the guard reported a span called
 * `loom.runs` — a name nobody wrote, in a document that says `loom.run`.
 */
const straddles = (spans: readonly (readonly [number, number])[], cut: number): boolean =>
  spans.some(([s, e]) => s < cut && e > cut);

/** Would closing up this line break spell an identifier the guard already knows? */
const joinSpellsAKnownName = (tail: string, rest: string, known: ReadonlySet<string>): boolean =>
  straddles(knownNameSpans(tail + rest, known), tail.length);

/**
 * Normalize a document so an identifier survives being written in markdown.
 *
 * Two passes.
 *
 * **Pass 1 — characters a reader cannot see.** The `INVISIBLE` characters go first and
 * unconditionally. Then emphasis between identifier characters is removed, so
 * `loom.**schedule**.admit` scans as `loom.schedule.admit`; emphasis with a non-identifier
 * on either side is kept, which is why the phrase "a `loom.*` namespace" does not turn into
 * a claim about a span called `loom.namespace`. An HTML comment *inside* an identifier —
 * `loom.<!-- -->schedule.admit`, which renders as one word — goes the same way as
 * emphasis; one spanning a line break does not, because deleting it would move every line
 * number after it.
 *
 * Then — and this is the half that was missing — every one of those deletions that does
 * not sit inside a name the guard knows is PUT BACK. Without it, `isIdentChar` accepting a
 * trailing letter meant that `` `loom.run` `` followed by a plural `s` had its closing
 * backtick deleted and was reported as a span called `loom.runs`. A trailing letter is an
 * identifier character and is also, far more often, English.
 *
 * **Pass 2 — line breaks that sever an identifier.** Closed up under exactly the same rule;
 * see `straddles` and `joinSpellsAKnownName`.
 *
 * HONEST LIMIT — what a break can still do, all of it reproduced against this function:
 *
 *  - A break inside a name the guard KNOWS is closed up wherever it falls, including the
 *    middle of a segment: `loom.sched` ⏎ `ule.pick` and `E_ADMIS` ⏎ `SION_REJECTED` are
 *    both joined, because the joined text spells something real.
 *  - A break inside a name the guard has NEVER HEARD OF is not closed up — and the result
 *    is not invisibility, it is a WRONG NAME. `loom.brand.` ⏎ `new` leaves `loom.brand` on
 *    the first line, which is identifier-shaped, so the guard fails and reports a claim
 *    about `loom.brand` — a name nobody wrote, pointing at a line that does not contain
 *    it. That is the "guard gives wrong instructions" failure in miniature, so the failure
 *    messages below say so explicitly rather than leaving the reader to work it out.
 *  - It is genuinely SILENT only where the surviving fragment is not identifier-shaped
 *    (`loom.` ⏎ `foo`, `E` ⏎ `_FOO`, `GRAPH` ⏎ `014` for a rule that does not exist) or is
 *    itself a name that exists (`loom.run` ⏎ `ner.tick` reads as a claim about `loom.run`,
 *    which passes).
 *  - Emphasis inside an unknown name is the same three cases, one pass earlier, and the
 *    first segment is the silent one: `loom.**brand**.new` reports nothing at all.
 *    `EMPHASIS inside an UNKNOWN name is the same limit, one pass earlier` runs all three.
 */
function scannable(input: string, known: ReadonlySet<string> = KNOWN): Scan {
  // ── Pass 1 ────────────────────────────────────────────────────────────────
  // The invisible characters go first and whole-string, so the walk below never has to
  // ask about them and never sees half of an astral one.
  const raw = stripInvisible(input);
  let chars: string[] = [];
  let at: number[] = [];
  /** Every deletion made below, so the ones that spell nothing can be put back. */
  const cuts: { readonly at: number; readonly text: string; readonly line: number }[] = [];
  let line = 1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\r") continue;
    if (c === "\n") {
      chars.push("\n");
      at.push(line);
      line++;
      continue;
    }
    const prev = chars[chars.length - 1];
    if (EMPHASIS.has(c)) {
      let j = i;
      while (j < raw.length && EMPHASIS.has(raw[j]!)) j++;
      if (isIdentChar(prev) && isIdentChar(raw[j])) {
        cuts.push({ at: chars.length, text: raw.slice(i, j), line });
        i = j - 1;
        continue;
      }
    }
    if (c === "<" && raw.startsWith("<!--", i)) {
      const close = raw.indexOf("-->", i + 4);
      const end = close < 0 ? -1 : close + 3;
      if (end > 0 && !raw.slice(i, end).includes("\n") && isIdentChar(prev) && isIdentChar(raw[end])) {
        cuts.push({ at: chars.length, text: raw.slice(i, end), line });
        i = end - 1;
        continue;
      }
    }
    chars.push(c);
    at.push(line);
  }

  // Pass 1, second half: PUT BACK every cut that does not sit inside a known name.
  //
  // Decided against the fully-cut text, because a name is often only spelled once every
  // cut in it has been made — `loom.**schedule**.pick` needs both. A cut nothing straddles
  // was joining two things a reader reads apart: an inline-code name and the `s` that
  // pluralises it. Putting it back costs the guard nothing, because whatever was on the
  // left of it is still there to be matched on its own.
  const rejected = cuts.length === 0 ? [] : ((): typeof cuts => {
    const spans = knownNameSpans(chars.join(""), known);
    return cuts.filter((cut) => !straddles(spans, cut.at));
  })();
  if (rejected.length > 0) {
    const undone: string[] = [];
    const undoneAt: number[] = [];
    let k = 0;
    for (let i = 0; i <= chars.length; i++) {
      while (k < rejected.length && rejected[k]!.at === i) {
        for (const ch of rejected[k]!.text) {
          undone.push(ch);
          undoneAt.push(rejected[k]!.line);
        }
        k++;
      }
      if (i < chars.length) {
        undone.push(chars[i]!);
        undoneAt.push(at[i]!);
      }
    }
    chars = undone;
    at = undoneAt;
  }

  // ── Pass 2 ────────────────────────────────────────────────────────────────
  const flat = chars.join("");
  const keep = new Array<boolean>(chars.length).fill(true);
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\n") continue;
    // Where the next line really begins, past indentation and blockquote markers.
    let j = i + 1;
    while (j < chars.length && (chars[j] === " " || chars[j] === "\t" || chars[j] === ">")) j++;
    if (j >= chars.length) continue;
    let end = j;
    while (end < chars.length && chars[end] !== "\n") end++;
    // From the start of the line, so the lookbehinds see what really precedes the name.
    const from = Math.max(flat.lastIndexOf("\n", i - 1) + 1, i - TAIL_WINDOW);
    if (!joinSpellsAKnownName(flat.slice(from, i), flat.slice(j, end), known)) continue;
    for (let k = i; k < j; k++) keep[k] = false;
  }

  const out: string[] = [];
  const lines: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (!keep[i]) continue;
    out.push(chars[i]!);
    lines.push(at[i]!);
  }
  return {
    text: out.join(""),
    line: (index: number) => lines[index] ?? lines[lines.length - 1] ?? 1,
  };
}

/** `<!-- … -->` blanked to spaces, so offsets and line numbers are unchanged. */
function withoutHtmlComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/**
 * Strip TypeScript comments, keeping strings, templates and regex literals intact.
 *
 * Needed because "is this error code referenced?" was answered from the raw text, so a
 * code named only in a `/** … *\/` docstring counted as a call site. That is a silent
 * false negative in the one check whose entire purpose is catching declared-but-unraised
 * codes. Regex literals are tracked because `/[&<>"]/` otherwise opens a string that eats
 * the rest of the line.
 */
function stripTsComments(src: string): string {
  // A `/` starts a regex literal, rather than a division, exactly after one of these.
  // NOT after a KEYWORD (`return /re/`, `typeof /re/`) — the previous significant
  // character is then a letter and this reads it as division. `src/` contains no such
  // site (`grep -rn 'return /[^/*]' packages/core/src` is empty) and the failure mode if
  // one appears is a mangled line, not a wrong verdict about a code: the mangling can
  // only ever REMOVE an occurrence, which grows `NEVER_RAISED` and fails loudly.
  const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">"]);
  let out = "";
  let prev = "";
  let i = 0;
  const emit = (c: string): void => {
    out += c;
    if (!/\s/.test(c)) prev = c;
  };
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      emit(c);
      i++;
      while (i < src.length) {
        const e = src[i]!;
        if (e === "\\") {
          out += e + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        emit(e);
        i++;
        if (e === c) break;
      }
      continue;
    }
    if (c === "/" && REGEX_AFTER.has(prev)) {
      emit(c);
      i++;
      let inClass = false;
      while (i < src.length && src[i] !== "\n") {
        const e = src[i]!;
        if (e === "\\") {
          out += e + (src[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (e === "[") inClass = true;
        else if (e === "]") inClass = false;
        emit(e);
        i++;
        if (e === "/" && !inClass) break;
      }
      continue;
    }
    emit(c);
    i++;
  }
  return out;
}

// ── The identifiers this guard tracks ────────────────────────────────────────

/**
 * The two marker spellings, captured as `(spelling, symbol)`.
 *
 * `DESIGNED-NOT-BUILT` is a debt; `NOT-IN-CODE` is a statement of absence. Neither is a
 * substring of the other, so the alternation cannot match the tail of the longer one.
 */
const MARKER_RE = /(DESIGNED-NOT-BUILT|NOT-IN-CODE)\(([^()\s]+)\)/g;
/** A `loom.*` telemetry name. Stops before `/v1`, `<runId>`, and a trailing period. */
const SPAN_RE = /(?<![A-Za-z0-9_.])(loom\.[a-z][a-zA-Z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)/g;
/** An error code, anchored so `GRAPH014_GATE_GATES_NOTHING` is not read as `E_GATES_NOTHING`. */
const CODE_RE = /(?<![A-Za-z0-9_])(E_[A-Z][A-Z0-9_]*)/g;
const GRAPH_RE = /(?<![A-Za-z0-9_])(GRAPH\d+)/g;

const matches = (text: string, re: RegExp): readonly string[] => [...text.matchAll(re)].map((m) => m[1]!);

interface Hit {
  readonly name: string;
  readonly line: number;
}

/** Every identifier of one family in a document, with the line a reader would look at. */
const hits = (scan: Scan, re: RegExp): readonly Hit[] =>
  [...scan.text.matchAll(re)].map((m) => ({ name: m[1]!, line: scan.line(m.index) }));

// ── What `telemetry/spans.ts` actually emits ─────────────────────────────────

const SPANS_TS = stripTsComments(readFileSync(join(SRC_DIR, "telemetry/spans.ts"), "utf8"));
const LOOM_LITERAL = /"(loom\.[a-zA-Z0-9_.]+)"/g;
/** A `loom.*` string in KEY position: `"loom.effect.key": …`. An attribute, not a span. */
const LOOM_ATTR_KEY = /"(loom\.[a-zA-Z0-9_.]+)"\s*:/g;

/**
 * Span names, taken from the VALUE of a `name:` property.
 *
 * Structural on purpose. Scraping every quoted `loom.*` literal read the two attribute
 * names `spans.ts` sets — `loom.effect.key`, `loom.cost_usd` — as spans, and the guard
 * papered over it with a hardcoded exception list. That list is the bug: the fix the
 * registry asks for on `loom.replayed` is to SET IT AS AN ATTRIBUTE, which under the old
 * rule would have reported a ninth span and told the author to add a row to D9.1's
 * taxonomy table for something that is not a span. A guard that gives wrong instructions
 * gets disabled.
 */
const spanNames = new Set<string>();
for (const line of SPANS_TS.split("\n")) {
  const at = line.search(/(?<![A-Za-z0-9_.])name:/);
  if (at < 0) continue;
  for (const m of line.slice(at).matchAll(LOOM_LITERAL)) spanNames.add(m[1]!);
}
const attrNames = new Set(matches(SPANS_TS, LOOM_ATTR_KEY));
/** Everything in the `loom.*` namespace the code really produces, of either kind. */
const builtTelemetry = new Set([...spanNames, ...attrNames]);

/** `loom.*` tokens that were never telemetry: an apiVersion and a config filename. */
const NON_TELEMETRY = new Set(["loom.dev", "loom.yaml"]);

const declaredCodes = new Set(Object.keys(CODES));

/**
 * Identifiers the design names that DO NOT EXIST in `src/`.
 *
 * Adding a row here is a claim about the code, and the tests below verify it. Each `why`
 * is for the person who has to decide whether to build the thing or delete the paragraph.
 * `markedIn` is rule 3: the exact documents allowed to carry the marker, so spreading a
 * caveat to a new document is a reviewed act rather than a one-line edit.
 *
 * `marker` pins WHICH SPELLING the symbol may carry — `DESIGNED-NOT-BUILT` for a gap
 * somebody is expected to close, `NOT-IN-CODE` for a name the corpus mentions only to say
 * it is absent. Pinning it is the point: without it, the second spelling is simply the
 * one that sounds less like a debt, and every row drifts toward it.
 */
const DESIGNED_NOT_BUILT: ReadonlyArray<{
  readonly symbol: string;
  readonly why: string;
  readonly marker: "DESIGNED-NOT-BUILT" | "NOT-IN-CODE";
  readonly markedIn: readonly string[];
}> = [
  // Spans. `telemetry/spans.ts` derives a span from journal events, so a span exists
  // exactly when some event folds into it — and nothing in `EVENT_TYPES` covers ingress,
  // compilation, admission, selection, or context assembly.
  {
    symbol: "loom.request",
    why: "no journal event covers ingress; the control plane's first append is run.submitted",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.compile",
    why: "compilation finishes before the first append, so there is nothing to fold",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.schedule.admit",
    why: "admission control is unbuilt (D6.3); no event, no span",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.schedule.pick",
    why: "Scheduler.select emits nothing, and has no dwrr policy, deficit, or task class to put on a span",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "08-PLAN.md"],
  },
  {
    symbol: "loom.context.assemble",
    why: "run/context.ts assembles but journals nothing",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "03-RUNTIME.md", "05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.effect",
    why: "effect.started/completed fold into loom.model and loom.tool; there is no effect span of its own",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.scheduler.tick",
    why: "there is no scheduler tick loop to instrument — and DL-1's reversal condition is written against this span",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["00-OVERVIEW.md", "05-RESOURCES-OBSERVABILITY.md", "07-CONFIG-DEPLOY.md", "08-PLAN.md", "README.md"],
  },
  {
    symbol: "loom.replay",
    why: "a replay run journals like any other; no separate span namespace exists",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["05-RESOURCES-OBSERVABILITY.md"],
  },
  {
    symbol: "loom.replayed",
    why: "an ATTRIBUTE, not a span: spans.ts never sets it, so a replayed effect looks live in a trace",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["02-EXECUTION-GRAPH.md", "05-RESOURCES-OBSERVABILITY.md"],
  },

  // Error codes named by the design that `errors.ts` does not declare.
  {
    symbol: "E_SUBSCRIBER_OVERFLOW",
    why:
      "NOT a gap, and the argument got sharper when the bus learned to signal an overflow rather than swallow it. " +
      "`publish` still never throws — that half of D3.9 is what protects the executor — but an " +
      '`onOverflow: "close"` subscription\'s ITERATOR now throws `SubscriberOverflowError` once it has drained what it ' +
      "holds, so a cut stream and a finished run are no longer the same terminal outcome. That thrown value is " +
      "deliberately a plain Error carrying a resume seq and NOT a `LoomError` with a `Code`: it never crosses a " +
      "process edge, so declaring the code would promote a local control-flow fact into boundary vocabulary a " +
      "`retry.onlyIf` list or an HTTP status map could name. Which is why marking it DESIGNED-NOT-BUILT read as an " +
      "instruction the paragraph itself argues against",
    marker: "NOT-IN-CODE",
    // README carries it as the worked example of the second spelling, exactly as it
    // carries `loom.scheduler.tick` for the first.
    markedIn: ["01-INTERFACES.md", "README.md"],
  },
  {
    symbol: "E_MAILBOX_UNDECLARED",
    why: "there is no Mailbox in src/ at all — D6.6 says so in the same breath",
    marker: "DESIGNED-NOT-BUILT",
    markedIn: ["03-RUNTIME.md"],
  },
];

/** Is this identifier absent from the code — the thing a marker asserts? */
function absentFromCode(symbol: string): boolean {
  if (symbol.startsWith("loom.")) return !builtTelemetry.has(symbol);
  if (symbol.startsWith("E_")) return !declaredCodes.has(symbol);
  return false;
}

const registered = new Set(DESIGNED_NOT_BUILT.map((e) => e.symbol));
const registeredMarker = new Map(DESIGNED_NOT_BUILT.map((e) => [e.symbol, e.marker] as const));

/** The GRAPH rules `validate.ts` can really emit. Read once; three checks want it. */
const VALIDATE_TS = readFileSync(join(SRC_DIR, "graph/validate.ts"), "utf8");
const emittedGraphRules = new Set(matches(VALIDATE_TS, /code: "(GRAPH\d+)_[A-Z_]+"/g));

/**
 * Every identifier this guard has ever heard of, of any family — and the input to the
 * join rule in `scannable`.
 *
 * "Known" deliberately includes names that DO NOT EXIST but are registered above. A
 * wrapped `loom.scheduler.tick` must still be joined and still be reported, or wrapping
 * would be a way to spread a registered symbol into a document with no marker in it.
 */
const KNOWN: ReadonlySet<string> = new Set<string>([
  ...builtTelemetry,
  ...NON_TELEMETRY,
  ...registered,
  ...declaredCodes,
  ...emittedGraphRules,
]);

// ── The corpus, read and normalized once ─────────────────────────────────────

/** `name → { raw, scan, markers }`, read and normalized once. */
interface Doc {
  readonly raw: string;
  readonly scan: Scan;
  /** Markers a reader can actually see. The ones in HTML comments are not here. */
  readonly markers: ReadonlySet<string>;
  /** Every marker, visible or not — the input to the HTML-comment check. */
  readonly allMarkers: ReadonlySet<string>;
  /** `symbol → the spelling this document used`, for the rule-3 spelling check. */
  readonly spellings: ReadonlyMap<string, string>;
}

const markerPairs = (text: string): readonly (readonly [string, string])[] =>
  [...text.matchAll(MARKER_RE)].map((m) => [m[2]!, m[1]!] as const);

const DOCS: ReadonlyMap<string, Doc> = new Map(
  DESIGN_FILES.map((f) => {
    const raw = design(f);
    const visible = markerPairs(withoutHtmlComments(raw));
    return [
      f,
      {
        raw,
        scan: scannable(raw),
        markers: new Set(visible.map(([symbol]) => symbol)),
        allMarkers: new Set(markerPairs(raw).map(([symbol]) => symbol)),
        spellings: new Map(visible),
      },
    ] as const;
  }),
);

test("NO MARKER IS STALE — everything the registry calls unbuilt is really absent from src/", () => {
  // Rule 4. This is what stops a marker from outliving the gap it describes: build the
  // span (or set the attribute), and the guard tells you which paragraph now understates
  // the system.
  const wrong = DESIGNED_NOT_BUILT.filter((e) => !absentFromCode(e.symbol)).map((e) => e.symbol);
  assert.deepEqual(wrong, [], "these EXIST in src/ — delete the marker and the caveat around it");
});

test("only span names and error codes may be marked, and only through the registry", () => {
  // Rules 1 and 3. Marking costs an edit here as well as in the doc.
  const bad: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const symbol of doc.allMarkers) {
      if (!symbol.startsWith("loom.") && !symbol.startsWith("E_")) bad.push(`${file}: ${symbol} — a marker names an identifier, not a concept`);
      else if (!registered.has(symbol)) bad.push(`${file}: ${symbol} — add it to DESIGNED_NOT_BUILT with a reason, deliberately`);
    }
  }
  assert.deepEqual(bad, []);
});

test("A SYMBOL CARRIES THE SPELLING THE REGISTRY GIVES IT", () => {
  // The other half of the two-spelling scheme, and the whole reason it is safe to have
  // two. `NOT-IN-CODE` says "there is nothing to build here", which is the answer an
  // author under time pressure would rather give — so which word applies is decided in
  // the registry, with a reason, and not in the document being written.
  const wrong: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const [symbol, spelling] of doc.spellings) {
      const expected = registeredMarker.get(symbol);
      if (expected !== undefined && expected !== spelling) {
        wrong.push(`${file}: ${spelling}(${symbol}) — the registry says ${expected}`);
      }
    }
  }
  assert.deepEqual(wrong, [], "change the registry row, or use the word it gives you");
});

test("A MARKER IN AN HTML COMMENT SILENCES NOTHING", () => {
  // Rule 5. `<!-- DESIGNED-NOT-BUILT(loom.request) -->` is one edit in one file that
  // renders as nothing at all, so it tells the reader of that file nothing.
  //
  // It is NOT "the cheapest bypass there was" — that was this file claiming more than it
  // could do. A zero-width character inside the identifier was cheaper (one character,
  // no marker at all) and equally invisible; `scannable` now removes those, and a
  // homoglyph, which nothing here removes, is cheaper still. See the header.
  const hidden: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const symbol of doc.allMarkers) {
      if (!doc.markers.has(symbol)) hidden.push(`${file}: ${symbol} — marked inside an HTML comment, where no reader will see it`);
    }
  }
  assert.deepEqual(hidden, [], "put the caveat in the prose; the point is that the reader of THIS file is told");
});

test("EACH REGISTRY ENTRY IS MARKED IN EXACTLY THE FILES IT CLAIMS", () => {
  // Rule 3, as an equality rather than an existence check. Too few files means a caveat
  // that exists only in the test suite, which is precisely the readership that did not
  // need telling. Too many means the marker spread without anyone deciding it should.
  const drift: string[] = [];
  for (const entry of DESIGNED_NOT_BUILT) {
    const actual = [...DOCS].filter(([, d]) => d.markers.has(entry.symbol)).map(([f]) => f).sort();
    const claimed = [...entry.markedIn].sort();
    if (actual.length === 0) drift.push(`${entry.symbol}: in the registry, marked in no design document`);
    else if (actual.join(",") !== claimed.join(",")) {
      drift.push(`${entry.symbol}: marked in [${actual.join(", ")}], registry says [${claimed.join(", ")}]`);
    }
  }
  assert.deepEqual(drift, [], "update `markedIn` in the same change that moves the marker");
});

/**
 * Appended to every "the design names X and the code does not have it" failure.
 *
 * Because one shape of that failure names something the author never wrote: a line break
 * inside an identifier the guard does not know leaves a truncated prefix behind, and the
 * prefix is what gets reported. Sending someone to grep for `loom.brand` when the document
 * says `loom.brand.new` is the "guard gives wrong instructions" failure, and the cheapest
 * fix is to say so in the message rather than to pretend the case does not exist.
 */
const WRONG_NAME_HINT = " (if you did not write that name, look for a line break inside the one you did)";

const MARK_IT = (what: string): string =>
  `build it, delete it, or mark it in that file — DESIGNED-NOT-BUILT(${what}) if it is a gap, ` +
  "NOT-IN-CODE(…) if the document names it only to say it is absent";

// ── Span names: doc vs `telemetry/spans.ts` ──────────────────────────────────

test("EVERY loom.* NAME THE DESIGN USES IS ONE SPANS.TS PRODUCES, OR IS MARKED IN THAT FILE", () => {
  // The check that would have caught `loom.scheduler.tick` — asserted in four documents,
  // emitted nowhere, and load-bearing for DL-1's reversal condition, so "measure its p99"
  // read as a check that passed when it was a p99 over zero samples.
  //
  // Span names and attribute names are both accepted here, because a document naming
  // `loom.cost_usd` is naming something real. Which of the two it is matters only to the
  // eight-span count below.
  const drift: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const h of hits(doc.scan, SPAN_RE)) {
      if (builtTelemetry.has(h.name) || NON_TELEMETRY.has(h.name) || doc.markers.has(h.name)) continue;
      drift.push(`${file}:${h.line} claims ${h.name}, which spans.ts does not produce${WRONG_NAME_HINT}`);
    }
  }
  assert.deepEqual(drift, [], MARK_IT("a span or attribute"));
});

test("every quoted loom.* literal in spans.ts is either a span NAME or an attribute KEY", () => {
  // The partition the two checks around this one depend on. A `loom.*` literal in some
  // third position — a comparison against a name the file never sets, say — would be
  // silently binned as one or the other, so it fails loudly instead and asks to be
  // classified.
  const unclassified = [...new Set(matches(SPANS_TS, LOOM_LITERAL))].filter((s) => !spanNames.has(s) && !attrNames.has(s)).sort();
  assert.deepEqual(unclassified, [], "teach this guard which of the two it is before the counts below can be trusted");
});

test("spans.ts emits exactly the eight the design says it does", () => {
  // The other direction, and the reason D9.1's "today that is eight" cannot rot: a ninth
  // span with no row in the taxonomy is a trace attribute nobody can look up.
  const emitted = [...spanNames].sort();
  assert.equal(emitted.length, 8, `spans.ts now emits ${emitted.length} spans: ${emitted.join(", ")} — update D9.1 and this count together`);
  const doc = design("05-RESOURCES-OBSERVABILITY.md");
  const undocumented = emitted.filter((s) => !doc.includes(`\`${s}\``));
  assert.deepEqual(undocumented, [], "a span the taxonomy table has no row for");
});

// ── Error codes: doc vs `errors.ts`, both directions ─────────────────────────

test("every error code any design document names exists in errors.ts", () => {
  // Generalises the D3.17 taxonomy check to the whole corpus: a `retry.onlyIf` list is
  // written against whatever code the reader last saw, wherever they saw it.
  const drift: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const h of hits(doc.scan, CODE_RE)) {
      if (declaredCodes.has(h.name) || doc.markers.has(h.name)) continue;
      drift.push(`${file}:${h.line} names ${h.name}, which errors.ts does not declare${WRONG_NAME_HINT}`);
    }
  }
  assert.deepEqual(drift, [], MARK_IT("an error code"));
});

test("every error code errors.ts declares is named by some design document", () => {
  // A code an operator can read out of `run.failed{error.code}` and cannot look up is a
  // code they will guess at. The bar is low on purpose — one mention anywhere but the
  // JOURNAL, which is history rather than reference.
  const named = new Set([...DOCS.values()].flatMap((d) => matches(d.scan.text, CODE_RE)));
  const undocumented = [...declaredCodes].filter((c) => !named.has(c)).sort();
  assert.deepEqual(undocumented, [], "declared in errors.ts, described in no design document");
});

/**
 * Codes that exist and that NOTHING RAISES.
 *
 * This is the tractable half of "does the method really throw what the doc says". A code
 * referenced nowhere but its own declaration cannot be thrown by anything, whatever the
 * table claims — which is exactly how `E_ADMISSION_REJECTED` came to head a three-level
 * admission-control design with no admission control under it.
 *
 * Pinned as an exact set, so implementing one of these fails here and sends its author to
 * the paragraph that has been promising it. Shrinking the list is progress; growing it is
 * a decision to declare a code before its call site, which is allowed and should be seen.
 */
const NEVER_RAISED: readonly string[] = [
  "E_ADMISSION_REJECTED", // D6.3 level 1. Nothing admits, so nothing rejects.
  "E_CHECKPOINT_NOT_FOUND",
  "E_GATE_REQUIRED",
  "E_INSUFFICIENT_COHORT",
  "E_JOIN_TIMEOUT", // D5 join timeouts: the spec field is honoured, the code is not used.
  "E_LEASE_LOST", // the executor never arms the fence; see HANDOFF A2.
  "E_POLICY_UNAVAILABLE",
  "E_SECRET_UNAVAILABLE",
  "E_STORAGE_FULL",
  "E_TASK_TIMEOUT",
  "E_TOOL_NOT_IDEMPOTENT",
  "E_TOOL_SCHEMA_INVALID",
  "E_TOO_LATE",
];

test("THE CODES NOTHING RAISES ARE EXACTLY THE ONES PINNED HERE", () => {
  // COMMENTS DO NOT COUNT AS CALL SITES. They used to: `referenced` was collected from
  // the raw text, so a newly declared code would never enter this list if one docstring
  // happened to name it — a silent false negative in the check that exists to catch
  // exactly the `E_ADMISSION_REJECTED` shape. About a fifth of `src/`'s `E_*` occurrences
  // outside `errors.ts` are in comments — one comment is all it takes — so this was never
  // a theoretical hole. Today the pinned list is the same either way, which is the point:
  // the fix is a tightening, not a correction.
  const referenced = new Set<string>();
  for (const file of sourceFiles()) {
    if (file.endsWith("/errors.ts")) continue; // the declaration is not a raise
    for (const code of matches(stripTsComments(readFileSync(file, "utf8")), CODE_RE)) referenced.add(code);
  }
  const unraised = [...declaredCodes].filter((c) => !referenced.has(c)).sort();
  assert.deepEqual(
    unraised,
    [...NEVER_RAISED].sort(),
    "a code became raisable (or stopped being raised) — reconcile the design paragraph that promises it, then update this list",
  );
});

// ── Event types: declared vs appended ────────────────────────────────────────

/**
 * Event types that exist in the vocabulary and that NOTHING APPENDS.
 *
 * The same shape as `NEVER_RAISED`, one layer down, and it exists because that shape has
 * already cost a severe defect. `gate.cancelled` was declared in `journal/events.ts`,
 * listed in `EVENT_TYPES`, and FOLDED by `run/projection.ts` — which is what made it so
 * easy to believe in — and appended by nothing. So cancelling a run left its gates `open`;
 * `HumanGateBroker.resolve` admits any gate whose state is `open`; and a decision on that
 * leftover gate appends `run.resumed`, which the fold reads as `status: "running"`. A
 * cancelled run could be walked back to `succeeded` by an approver who was never told it
 * had been cancelled. Reproduced against the tree this check was written in: cancel, then
 * approve, and the projection reported `succeeded`. The declaration, the taxonomy entry
 * and the fold all looked like the feature existed; only "who appends it?" was going to
 * find it.
 *
 * It is not on the list below, because an appender landed in `run/engine.ts` while this
 * check was being written and the check reported it. That is the intended behaviour of an
 * exact set: closing a gap fails this test and sends its author here to delete the row.
 *
 * HONEST LIMIT: this reads `type: "…"` literals out of `src/`, which is APPEND-SHAPED, not
 * proof of an append. It can only fail in the safe direction for the check's purpose —
 * something that constructs an event-shaped object without appending it would hide an
 * unappended type — and the complete version is the same fixture-journal work the
 * attribute check needs (see the bottom of this file), where the answer comes from running
 * the engine and reading back what landed in the store.
 *
 * Shrinking the list is progress. Growing it is a decision to add a word to the vocabulary
 * before anything says it, which is allowed and should be seen.
 */
const NEVER_APPENDED: readonly { readonly type: string; readonly why: string }[] = [
  {
    type: "budget.reserved",
    why: "PolicyEngine.reserve holds the reservation in memory and journals nothing, so D6.5's three-level budget table and D8 step 6 both name an event that is never written — a crashed worker's reservation cannot be recovered by folding",
  },
  { type: "budget.settled", why: "PolicyEngine.settle, same: the balance moves in memory only" },
  {
    type: "channel.written",
    why: "a reduction is journaled whole as state.reduced; there is no per-channel event. The fold in projection.ts is dead code",
  },
  {
    type: "config.reloaded",
    why: "there is no reload path in src/ at all — no SIGHUP handler, no admin endpoint. D11 designs both",
  },
  {
    type: "hook.applied",
    why: "hooks are declared in a GraphSpec, validated by the compiler and pinned by the resolver, and then nothing ever invokes one; so a rewriting hook could not be journaled even if it ran",
  },
  {
    type: "task.cancelled",
    why: "the same gap as gate.cancelled: cancel() appends run.cancelled only, so in-flight Tasks keep whatever state they last had and the task.cancelled arm of spans.ts is unreachable. D5's cancellation sequence and its join `any` short-circuit both say the executor appends it",
  },
  {
    type: "task.skipped",
    why: "nothing marks a Task skipped, so the `skipped` task state is unreachable — which also makes the join's onBranchError accounting count a population that cannot exist",
  },
  {
    type: "task.started",
    why: "declared, appended by nothing and folded by nothing: leasing is the start (task.leased), and no code distinguishes the two. Delete it, or make leasing and starting different facts",
  },
];

test("D3.10's 'closed EventType set' IS THE CLOSED EVENT TYPE SET", () => {
  // Found in the final sweep, and invisible to every other check in this file: the
  // vocabulary block in D3.10 listed 39 of the 48 types in `EVENT_TYPES`, under a heading
  // calling it closed and "the whole system's vocabulary of durable facts". None of the
  // guards above look at it — `EVENT_TYPES` is checked for APPENDERS and error codes are
  // checked against the corpus, but nothing compared the enumeration itself.
  //
  // The nine missing ones included `gate.cancelled`, whose declared-folded-never-appended
  // status was the root cause of a severe authorization defect. An auditor reading the
  // vocabulary off this page would not have known it existed to ask about.
  //
  // Both directions, because each is a different failure: a type in the code and not the
  // doc is an undocumented durable fact, and a type in the doc and not the code is a fact
  // an integrator will write a fold for and never receive.
  const doc = design("01-INTERFACES.md");
  const open = doc.indexOf("The closed `EventType` set");
  assert.ok(open > 0, "the vocabulary block moved — find it and re-point this check");
  const fence = doc.indexOf("```", open);
  const listed = doc.slice(fence + 3, doc.indexOf("```", fence + 3)).split(/\s+/).filter(Boolean);

  const declared = new Set<string>(EVENT_TYPES);
  const undocumented = EVENT_TYPES.filter((t) => !listed.includes(t));
  assert.deepEqual(undocumented, [], "in EVENT_TYPES, absent from D3.10's list — a durable fact nobody can look up");
  const invented = listed.filter((t) => !declared.has(t));
  assert.deepEqual(invented, [], "listed in D3.10, absent from EVENT_TYPES — an event an integrator would fold for and never see");
  assert.equal(listed.length, EVENT_TYPES.length, "the list has a duplicate");
});

test("EVERY DECLARED EVENT TYPE HAS AN APPENDER, except the ones pinned here", () => {
  const appended = new Set<string>();
  for (const file of sourceFiles()) {
    if (file.endsWith("/journal/events.ts")) continue; // the declaration is not an append
    // `type: "x.y"` is how a NewEvent is written. A fold is `isEvent(e, "x.y")` or
    // `e.type === "x.y"`, neither of which matches — which is the distinction that
    // matters, since every unappended type below IS folded somewhere.
    for (const m of stripTsComments(readFileSync(file, "utf8")).matchAll(/(?<![A-Za-z0-9_])type:\s*"([a-z_]+\.[a-z_]+)"/g)) {
      appended.add(m[1]!);
    }
  }
  const unappended = EVENT_TYPES.filter((t) => !appended.has(t)).sort();
  assert.deepEqual(
    unappended,
    NEVER_APPENDED.map((e) => e.type).sort(),
    "an event type gained (or lost) its only appender — reconcile the design paragraph that promises it, then update this list",
  );
});

test("every unappended event type is one this file can name a reason for", () => {
  // The registry is the point, not the count: a blanket skip would have let
  // `gate.cancelled` sit in the vocabulary indefinitely, since nothing about it looks
  // wrong from any single file.
  const thin = NEVER_APPENDED.filter((e) => e.why.length < 40).map((e) => e.type);
  assert.deepEqual(thin, [], "say what stands in for the event, or what would have to be built");
  const known = new Set<string>(EVENT_TYPES);
  const unknown = NEVER_APPENDED.map((e) => e.type).filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], "pinned here, absent from EVENT_TYPES — the vocabulary moved under this list");
});

test("GateDelivery.deliver raises WHAT ITS TAXONOMY ROW CLAIMS, checked by running it", () => {
  // The row above is pinned against itself, which by construction cannot catch a
  // doc-vs-code disagreement. This one reads the row and then makes a real channel fail.
  //
  // Deliberately BEHAVIOURAL rather than static. The first version sliced
  // `WebhookChannel.deliver`'s body and collected `CODES.E_*` from it, and it broke the
  // same afternoon: the mapping moved into `#failure` and `#undelivered`, so the body
  // named no code at all and the test reported the method raised nothing. That is the
  // "which method raises which code" problem in miniature — see the note at the bottom of
  // this file. Driving the method is immune to where the constructor lives.
  //
  // Cancellation is excluded because the row puts it in its own column: `E_CANCELLED` is
  // not retryable and `E_GATE_DELIVERY_FAILED` is, so collapsing them would make an
  // abandoned delivery look like one worth retrying.
  const doc = design("01-INTERFACES.md");
  const row = doc.split("\n").find((l) => l.includes("`GateDelivery`") && l.includes("`deliver`"));
  assert.ok(row, "the GateDelivery.deliver row moved");
  const claimed = matches(row, CODE_RE).filter((c) => c !== "E_CANCELLED");
  assert.deepEqual(claimed, ["E_GATE_DELIVERY_FAILED"], "the row changed; this test encodes what the old one promised");

  return (async () => {
    const { WebhookChannel } = await import("../src/run/delivery.ts");
    const { isLoomError } = await import("../src/errors.ts");
    const channel = new WebhookChannel({
      url: "https://approvals.invalid/hook",
      // Offline and deterministic: the transport is injected and always refuses.
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const target = {
      gate: { gateId: "g1", runId: "r1", nodeId: "n1", deadline: undefined },
      recipients: [],
      payload: {},
      tier: 0,
    } as unknown as Parameters<typeof channel.deliver>[0];

    const e = await channel.deliver(target, new AbortController().signal).then(
      () => undefined,
      (err: unknown) => err,
    );
    assert.ok(isLoomError(e), `deliver exited untyped: ${String(e)}`);
    assert.equal(e.code, claimed[0], "the row and the running method disagree about what `deliver` throws");
  })();
});

// ── D3: a doc interface vs the class of the same name ────────────────────────

/**
 * Method names a `ts` block in a design document declares for one interface.
 *
 * Everything nested is blanked first, so a parameter object's fields cannot be mistaken
 * for methods, and TS comments are stripped — which doubles as the escape hatch: a method
 * that is designed and not built gets COMMENTED OUT inside the block, where it still
 * renders in the fence for a reader and no longer claims to exist.
 */
function declaredInterfaces(text: string): ReadonlyMap<string, readonly string[]> {
  const found = new Map<string, readonly string[]>();
  for (const m of text.matchAll(/^export interface ([A-Za-z][A-Za-z0-9_]*)[^{]*\{/gm)) {
    const open = text.indexOf("{", m.index);
    let depth = 0;
    let end = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}" && --depth === 0) {
        end = i;
        break;
      }
    }
    if (end < 0) continue;
    found.set(m[1]!, methodsOf(stripTsComments(text.slice(open + 1, end))));
  }
  return found;
}

/**
 * Words that can be followed by `(` inside a TYPE, and so are not method names.
 *
 * Without this, `multimodal: readonly ("image" | "audio")[]` — an ordinary readonly tuple
 * or union property, written in D3 today — parses as a method called `readonly`, and the
 * check below reports `ModelCapabilities.readonly() — declared in the doc, absent from the
 * class`: a failure that is false, unactionable, and fires on a legitimate declaration.
 * The rest are the same shape: `new (…) => T` is a construct signature, `x is (A | B)` a
 * type predicate, `keyof`/`typeof`/`infer`/`unique` type operators, `extends`/`in`
 * conditional and mapped types, `import("…")` a type import.
 *
 * The cost is a method LITERALLY NAMED one of these, which would go unchecked. That is the
 * right way round: a missed check is coverage this file never had, and a false failure on
 * a valid declaration is how a guard gets switched off.
 */
const NOT_A_METHOD = new Set(["readonly", "new", "keyof", "typeof", "infer", "unique", "is", "asserts", "extends", "in", "import"]);

function methodsOf(body: string): readonly string[] {
  let depth = 0;
  let top = "";
  for (const c of body) {
    if (c === "{") {
      depth++;
      top += " ";
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
      top += " ";
    } else top += depth === 0 ? c : c === "\n" ? "\n" : " ";
  }
  return [...new Set(matches(top, /(?:^|[;\s])([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(/g))].filter((m) => !NOT_A_METHOD.has(m));
}

/** `export class X` in `src/`, so a doc interface named `X` can be checked against it. */
function exportedClasses(): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const file of sourceFiles()) {
    for (const m of stripTsComments(readFileSync(file, "utf8")).matchAll(/^export class ([A-Za-z][A-Za-z0-9_]*)/gm)) {
      found.set(m[1]!, file);
    }
  }
  return found;
}

/** `export interface X` in `src/`, parsed exactly as the doc side is. */
function exportedInterfaces(): ReadonlyMap<string, { readonly file: string; readonly methods: ReadonlySet<string> }> {
  const found = new Map<string, { file: string; methods: ReadonlySet<string> }>();
  for (const file of sourceFiles()) {
    for (const [name, methods] of declaredInterfaces(readFileSync(file, "utf8"))) {
      found.set(name, { file, methods: new Set(methods) });
    }
  }
  return found;
}

/**
 * The doc interfaces that have a counterpart in `src/`, pinned by name.
 *
 * An exact set rather than a floor, because a floor was the bug. `checked >= 3` passed on
 * whatever happened to line up: four interfaces of forty-nine, one of which (`LoomError`)
 * declares no methods at all, so the real reach was three interfaces and fourteen names
 * while the assertion read like coverage. The other forty-five were dropped by a silent
 * `continue`.
 *
 * Growing this list is progress and costs one line. Shrinking it means a class or an
 * interface was renamed and a doc block stopped being checked, which is exactly the event
 * a floor cannot see.
 */
const CHECKED_INTERFACES: readonly string[] = [
  // NINE that contribute method names, and every name they compare. Counted, because a
  // list of eighteen "checked" interfaces reads as more reach than it has: half of it
  // declares nothing to check. 3 + 2 + 5 + 3 + 6 + 1 + 5 + 2 + 3 = the 30 below.
  "EventBus (interface)", //         publish, subscribe, replayThenTail
  "GraphCompiler (interface)", //    compile, analyze
  "HumanGateBroker (class)", //      raise, resolve, list, rehydrate, sweepTimeouts
  "ModelAdapter (interface)", //     stream, priceOf, estimateOf
  "PolicyEngine (class)", //         decide, effectivePosture, escalate, deescalate, reserve, settle
  "SecretProvider (interface)", //   resolve
  "StateStore (interface)", //       append, read, head, listRuns, close
  "StateView (interface)", //        get, require
  "ToolRegistry (class)", //         register, get, list
  // And NINE whose doc block declares no method at all — pure data shapes, plus
  // `ToolDefinition`, which is one and was filed under "contributes method names" while
  // contributing none. They are listed rather than filtered out so that "checked" cannot
  // quietly count them as coverage; the method-name floor below is the number that means
  // something, and none of these moves it.
  "AuditRecord (interface)",
  "CallbackDecision (interface)",
  "CallbackRequest (interface)",
  "Diagnostic (interface)",
  "LoomError (class)",
  "ResolvedRef (interface)",
  "ToolDefinition (interface)",
  "Trajectory (interface)",
  "TrajectoryStep (interface)",
];

test("A DOC INTERFACE DECLARES ONLY METHODS THE CODE OF THAT NAME REALLY HAS", async () => {
  // The narrow, high-precision slice of "the design names a method that does not exist".
  //
  // Two code sides, because `src/` has two kinds of counterpart and only one of them
  // exists at runtime:
  //
  //  - a CLASS is checked by importing it and walking the prototype chain. No refactor can
  //    misreport a real prototype.
  //  - an INTERFACE is erased at runtime, so it is checked by parsing its declaration with
  //    the same `declaredInterfaces` used on the doc side. That is parsing, which this
  //    file distrusts on principle — but here both sides are *declarations*, machine
  //    readable by construction, and the alternative (used until this wave) was to skip
  //    them, which is how D3 came to promise `ModelAdapter.countTokens`, a method nobody
  //    could call, while the code had `estimateOf`.
  //
  // Signatures are NOT compared: `raise(log, req)` and `raise(req, signal?)` differ in ways
  // a parameter list cannot adjudicate, and a guard that flagged every reworded type would
  // be turned off within a week.
  //
  // This is what caught `HumanGateBroker.claim`/`delegate` (D7.3's table already said they
  // were unbuilt, so the corpus contradicted itself), `ToolRegistry.health`,
  // `PolicyEngine.posture`, and then — once the interface side was added —
  // `GraphCompiler.compileMutation`, `ModelAdapter.countTokens`, `StateStore.projection`
  // and `StateStore.query`.
  const classes = exportedClasses();
  const interfaces = exportedInterfaces();
  const drift: string[] = [];
  const checked: string[] = [];
  let names = 0;
  let skipped = 0;

  for (const [file, doc] of DOCS) {
    for (const [name, methods] of declaredInterfaces(doc.raw)) {
      const src = classes.get(name);
      const iface = interfaces.get(name);
      let have: ReadonlySet<string> | undefined;
      let where = "";

      if (src !== undefined) {
        const mod = (await import(pathToFileURL(src).href)) as Record<string, unknown>;
        const ctor = mod[name];
        if (typeof ctor !== "function") continue;
        const own = new Set<string>();
        for (let p: object | null = ctor.prototype as object; p !== null && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
          for (const k of Object.getOwnPropertyNames(p)) own.add(k);
        }
        have = own;
        where = `the class in ${src.slice(SRC_DIR.length)}`;
        checked.push(`${name} (class)`);
      } else if (iface !== undefined) {
        have = iface.methods;
        where = `the interface in ${iface.file.slice(SRC_DIR.length)}`;
        checked.push(`${name} (interface)`);
      } else {
        // Contract-only: D3 describes a boundary nothing in `src/` is named after. Whether
        // each of those is a promise or a description is a judgement, not a test — see the
        // note at the bottom of this file.
        skipped++;
        continue;
      }

      names += methods.length;
      for (const method of methods) {
        if (!have.has(method)) drift.push(`${file}: ${name}.${method}() — declared in the doc, absent from ${where}`);
      }
    }
  }

  assert.deepEqual(
    [...new Set(checked)].sort(),
    [...CHECKED_INTERFACES].sort(),
    `${checked.length} doc interfaces have a counterpart in src/ and ${skipped} do not — if this shrank, a rename took a doc block out of the check`,
  );
  // 30, which is what it compares today and what the nine method-declaring rows above add
  // up to. A floor rather than an equality because ADDING a method to a doc block that is
  // already checked is ordinary authoring and should not cost a test edit; taking one away
  // — by renaming the counterpart, which is the event this whole block exists to catch —
  // has to fail. The message states the number it really is, because the previous one said
  // 25 and read like coverage.
  assert.ok(names >= 30, `only ${names} method names compared, against a reach of 30 — a doc block stopped lining up with src/`);
  assert.deepEqual(drift, [], "build it, or comment it out inside the `ts` block and say in prose that it is not built");
});

// ── D3.17–D3.24: the boundary error taxonomy (gap G1) ────────────────────────

test("EVERY ERROR CODE THE INTERFACE DOC NAMES ACTUALLY EXISTS", () => {
  // G1 was closed by enumerating each boundary interface's codes. This is what keeps it
  // closed: a code renamed in `errors.ts` and not in the doc fails here, rather than
  // being discovered by someone writing a `retry.onlyIf` list against a code that never
  // fires.
  const doc = design("01-INTERFACES.md");
  const section = doc.slice(doc.indexOf("### The boundary error taxonomy"));
  const codes = new Set([...section.matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1]!));

  assert.ok(codes.size >= 20, `only ${codes.size} codes in the taxonomy table — did the section move?`);
  const missing = [...codes].filter((c) => !(c in CODES));
  assert.deepEqual(missing, [], "the doc names codes that do not exist");
});

test("the boundary taxonomy covers all eight boundary interfaces", () => {
  const doc = design("01-INTERFACES.md");
  const section = doc.slice(doc.indexOf("### The boundary error taxonomy"));
  for (const name of [
    "ControlPlaneAPI",
    "RunEventStream",
    "RunLifecycle",
    "GateDelivery",
    "ToolTransport",
    "JournalReader",
    "BlobStore",
    "SecretProvider",
  ]) {
    assert.ok(section.includes(`\`${name}\``), `${name} has no row in the taxonomy table`);
  }
});

test("GateDelivery.deliver still raises exactly ONE code", () => {
  // Load-bearing, not descriptive. Every branch out of "the notification failed" that is
  // not "leave the gate open" is a way to approve something nobody approved.
  const doc = design("01-INTERFACES.md");
  const row = doc.split("\n").find((l) => l.includes("`GateDelivery`") && l.includes("`deliver`"));
  assert.ok(row);
  const codes = [...row.matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1]);
  assert.deepEqual(codes, ["E_GATE_DELIVERY_FAILED"]);
});

// ── D7.7: the escalation table ───────────────────────────────────────────────

test("every rule in the code appears in the design's escalation table", () => {
  const doc = design("04-OVERSIGHT.md");
  for (const rule of Object.values(ESCALATION_RULES)) {
    assert.ok(
      doc.includes(`| ${rule.code} |`),
      `${rule.id} claims to be ${rule.code}, which the design table does not have`,
    );
  }
});

test("the design's E-codes and the code's E-codes are the same set", () => {
  const doc = design("04-OVERSIGHT.md");
  const table = doc.slice(doc.indexOf("### Escalation decision table"), doc.indexOf("**What approval means.**"));
  const declared = new Set([...table.matchAll(/^\| (E\d+) \|/gm)].map((m) => m[1]!));
  const implemented = new Set(Object.values(ESCALATION_RULES).map((r) => r.code as string));
  assert.deepEqual([...declared].sort(), [...implemented].sort());
});

// ── D9.4: retention ──────────────────────────────────────────────────────────

test("D1's REPLACED TERMS are absent from src/ — the DoD row 9 that said a test asserts this", () => {
  // 99-DOD.md row 9 read "PASS | **PROVEN** | `Session`, `Job`, `Sub-agent` appear nowhere
  // in `src/`", under a legend that defines PROVEN as "a test asserts it". No test did.
  // That is the exact shape this file exists to catch, one level up: a status word
  // asserting evidence that does not exist. Writing the check was cheaper than downgrading
  // the row, so here it is.
  //
  // COMMENTS ARE EXCLUDED, and that is the honest reading rather than a convenience: D1
  // replaced these terms in the MODEL, and `server/http.ts` says "no directory, no
  // session, and no groups" in prose — a sentence about their absence is not the concept
  // leaking back in. Nine occurrences across `src/` are of that kind; none is code.
  const RENAMED = /(?<![A-Za-z])(sessions?|jobs?|sub-?agents?)(?![a-z])/gi;
  const leaked: string[] = [];
  for (const file of sourceFiles()) {
    for (const m of stripTsComments(readFileSync(file, "utf8")).matchAll(RENAMED)) {
      leaked.push(`${file.slice(SRC_DIR.length)}: ${m[0]}`);
    }
  }
  assert.deepEqual(leaked, [], "D1 replaced these with Run, Task and subgraph — use those, or change D1 and the DoD row");
});

test("the DoD does not claim anything is PROVEN without naming its evidence", () => {
  // A status word with no evidence column is a status word that will rot.
  const doc = design("99-DOD.md");
  for (const line of doc.split("\n")) {
    if (!line.startsWith("|") || !line.includes("**PROVEN**")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const evidence = cells[cells.length - 2] ?? "";
    assert.ok(evidence.length > 25, `a PROVEN row with no evidence:\n  ${line}`);
  }
});

// ── D5: the node and edge taxonomy ───────────────────────────────────────────

test("the design's node types are exactly the ones the compiler accepts", () => {
  // D5.1 fixes the node taxonomy at eight. If the code grows a ninth without the design
  // growing one too, "the kernel is seven primitives and a node taxonomy of eight" has
  // quietly stopped being true.
  const doc = design("02-EXECUTION-GRAPH.md");
  for (const type of NODE_TYPES) {
    assert.ok(doc.includes(`\`${type}\``), `node type "${type}" appears nowhere in D5`);
  }
  assert.equal(NODE_TYPES.length, 8, "update D5 and this count together, deliberately");
});

test("the design's edge kinds are exactly the ones the compiler accepts", () => {
  const doc = design("02-EXECUTION-GRAPH.md");
  for (const kind of EDGE_KINDS) {
    assert.ok(doc.includes(`\`${kind}\``), `edge kind "${kind}" appears nowhere in D5`);
  }
  assert.equal(EDGE_KINDS.length, 7);
});

test("every GRAPH rule the compiler can emit is documented", () => {
  // A diagnostic an author cannot look up is a diagnostic they will guess at.
  const doc = design("02-EXECUTION-GRAPH.md");
  assert.ok(emittedGraphRules.size >= 20, `only found ${emittedGraphRules.size} GRAPH rules — did the code shape change?`);
  const undocumented = [...emittedGraphRules].filter((r) => !doc.includes(r));
  assert.deepEqual(undocumented, [], "the compiler can emit rules D5 never mentions");
});

test("every GRAPH rule the DESIGN names is one the compiler can emit", () => {
  // The other direction, across the whole corpus rather than D5 alone. A rule an author
  // is told to expect and that no code path produces is worse than an undocumented one:
  // they will write the graph to avoid a diagnostic that was never coming.
  const drift: string[] = [];
  for (const [file, doc] of DOCS) {
    for (const h of hits(doc.scan, GRAPH_RE)) {
      if (!emittedGraphRules.has(h.name)) drift.push(`${file}:${h.line} names ${h.name}, which validate.ts cannot emit${WRONG_NAME_HINT}`);
    }
  }
  assert.deepEqual(drift, []);
});

// ── The guard's own guards ───────────────────────────────────────────────────
//
// Everything above is only as good as the scanner under it, and the scanner is the part
// that failed silently: a claim written `loom.**schedule**.admit` was not a claim at all
// as far as the old line-by-line regex was concerned. These pin the scanner against the
// ways around it that have actually been tried.

/**
 * The invisible characters used below, as escapes.
 *
 * Escapes rather than literals on purpose: a reviewer of this file has to be able to SEE
 * which character each row is about, and a literal U+200B in a source line is exactly as
 * invisible here as it is in a design document. (It used to be a literal, under a comment
 * that said it was an escape — the same shape of false claim this file exists to catch.)
 */
const ZWSP = "\u200B"; //    ZERO WIDTH SPACE          — \p{Cf}
const SHY = "\u00AD"; //     SOFT HYPHEN               — \p{Cf}
const CGJ = "\u034F"; //     COMBINING GRAPHEME JOINER — \p{Mn}, NOT \p{Cf}
const VS1 = "\uFE00"; //     VARIATION SELECTOR-1      — \p{Mn}, NOT \p{Cf}
const VS17 = "\u{E0100}"; // VARIATION SELECTOR-17     — \p{Mn}, NOT \p{Cf}, and ASTRAL
const HFILL = "\u3164"; //   HANGUL FILLER             — \p{Lo}, NOT \p{Cf}

/**
 * Confusables. NOT invisible — each is a DIFFERENT LETTER that looks like the one it
 * replaces, which is why no character class can strip them and why they are pinned below
 * as OPEN rather than closed.
 */
const CYR_O = "\u043E"; // CYRILLIC SMALL LETTER O, indistinguishable from `o`
const FULLWIDTH_LOOM = "\uFF4C\uFF4F\uFF4F\uFF4D";
const MATH_LOOM = "\u{1D5C5}\u{1D5C8}\u{1D5C8}\u{1D5C6}";

/** `input → the identifier a reader plainly sees in it`. */
const EVASIONS: readonly { readonly how: string; readonly text: string; readonly re: RegExp; readonly expect: string }[] = [
  { how: "plain prose", text: "the loom.schedule.pick span", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "inline code", text: "the `loom.schedule.pick` span", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "bold around the name", text: "**`loom.schedule.pick`**", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "a table cell", text: "| 8 | `loom.schedule.pick` | dwrr |", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "bold INSIDE the name", text: "loom.**schedule**.pick", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "wrapped after the dot", text: "the `loom.\n  schedule.pick` span", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "wrapped before the dot", text: "the `loom\n  .schedule.pick` span", re: SPAN_RE, expect: "loom.schedule.pick" },
  // New in this wave: the joins used to be keyed to a break at a segment boundary, so a
  // break anywhere else was invisible. A known name is now joined wherever it is cut.
  { how: "wrapped MID-SEGMENT", text: "the `loom.sched\n  ule.pick` span", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "wrapped across a blockquote", text: "> the `loom.\n> schedule.pick` span", re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "inside an HTML comment", text: "<!-- loom.schedule.pick -->", re: SPAN_RE, expect: "loom.schedule.pick" },
  // The ones that render as NOTHING, and so were invisible in a diff as well as to the
  // scanner. Each is one edit in one file, with no marker and no test edit.
  { how: "a zero-width space inside the name", text: `the loo${ZWSP}m.schedule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "a soft hyphen inside the name", text: `the loom.sched${SHY}ule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  // …and the four that `\p{Cf}` does not contain. Stripping `\p{Cf}` was announced as
  // closing "the invisible class" and did not: the combining grapheme joiner and the
  // variation selectors are `\p{Mn}`, the Hangul fillers are `\p{Lo}`, all render as
  // nothing, and each one silenced a `loom.*` claim outright.
  { how: "a combining grapheme joiner inside the name", text: `the loom.sched${CGJ}ule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "a variation selector inside the name", text: `the loom.sched${VS1}ule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  // Astral, so it is two UTF-16 code units: the char-by-char strip in `scannable` could
  // not see it even after the class was widened, until the strip moved to code points.
  { how: "an ASTRAL variation selector inside the name", text: `the loom.sched${VS17}ule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "a Hangul filler inside the name", text: `the loom.sched${HFILL}ule.pick span`, re: SPAN_RE, expect: "loom.schedule.pick" },
  { how: "an error code, combining grapheme joiner inside", text: `raises E${CGJ}_ADMISSION_REJECTED`, re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "a rule, variation selector inside", text: `rejected by GRAPH${VS1}014`, re: GRAPH_RE, expect: "GRAPH014" },
  { how: "an HTML comment inside the name", text: "the loom.<!-- x -->schedule.pick span", re: SPAN_RE, expect: "loom.schedule.pick" },
  // The other half of the pass-1 defect, and the reason the fix is a RESTORE rather than a
  // narrower deletion rule. An identifier character in front of the opening backtick got
  // that backtick deleted too, which put a digit immediately before `loom.` — and `SPAN_RE`
  // has a lookbehind, so the claim vanished entirely. Restoring the unjustified cut brings
  // it back.
  { how: "inline code preceded by a digit", text: "see D9.1`loom.run` for the closing attributes", re: SPAN_RE, expect: "loom.run" },
  { how: "an error code, wrapped at the underscore", text: "raises E_ADMISSION_\n  REJECTED when full", re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "an error code, wrapped before the underscore", text: "raises E_ADMISSION\n  _REJECTED when full", re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "an error code, wrapped MID-WORD", text: "raises E_ADMIS\n  SION_REJECTED when full", re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "an error code, emphasis inside", text: "raises `E_**ADMISSION**_REJECTED`", re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "an error code, zero-width inside", text: `raises E${ZWSP}_ADMISSION_REJECTED`, re: CODE_RE, expect: "E_ADMISSION_REJECTED" },
  { how: "a rule, emphasis inside the number", text: "rejected by GRAPH**014**", re: GRAPH_RE, expect: "GRAPH014" },
  { how: "a rule, wrapped inside the number", text: "rejected by GRAPH0\n  14 at compile", re: GRAPH_RE, expect: "GRAPH014" },
  { how: "a rule, wrapped before the number", text: "rejected by GRAPH\n  014 at compile", re: GRAPH_RE, expect: "GRAPH014" },
  { how: "a rule, zero-width inside", text: `rejected by GRAPH${ZWSP}014`, re: GRAPH_RE, expect: "GRAPH014" },
];

test("THE SCANNER SEES THROUGH EVERY EVASION THAT HAS BEEN TRIED", () => {
  const missed = EVASIONS.filter((e) => !matches(scannable(e.text).text, e.re).includes(e.expect)).map((e) => e.how);
  assert.deepEqual(missed, [], "an identifier a reader can plainly see, that the guard cannot");
});

test("THE INVISIBLE CLASS IS THE ONE A READER'S EYE USES, and it moves no line number", () => {
  // Both halves of the claim in `INVISIBLE`'s docstring, checked rather than asserted.
  //
  // The first half is why the class was widened: `\p{Cf}` was announced here as having
  // closed the zero-width bypass and had not. `\p{Mn}` and `\p{Lo}` both contain
  // characters that render as nothing, and each of them silenced a claim outright.
  for (const [what, c] of [["CGJ", CGJ], ["VS-1", VS1], ["VS-17", VS17], ["Hangul filler", HFILL]] as const) {
    assert.ok(!/\p{Cf}/u.test(c), `${what} is not \\p{Cf} — which is why \\p{Cf} alone was the wrong class`);
    assert.ok(IS_INVISIBLE.test(c), `${what} renders as nothing and must be stripped`);
  }
  for (const [what, c] of [["ZWSP", ZWSP], ["soft hyphen", SHY]] as const) {
    assert.ok(IS_INVISIBLE.test(c), `${what} was already closed and must stay closed`);
  }

  // The second half. `design()` strips before anything counts lines, so a stripped
  // character that WAS a line terminator would silently renumber every failure message
  // after it — the guard would then send its reader to the wrong line, which is the same
  // "wrong instructions" failure as inventing a name.
  for (const [what, c] of [["LF", "\n"], ["CR", "\r"], ["LS", "\u2028"], ["PS", "\u2029"]] as const) {
    assert.ok(!IS_INVISIBLE.test(c), `${what} is a line terminator and must not be in the strip class`);
  }
  const doc = `line one ${ZWSP}\nline two ${CGJ}\nthe ${VS17}loom.run span\n`;
  assert.equal(stripInvisible(doc).split("\n").length, doc.split("\n").length, "stripping changed the line count");
  const scan = scannable(doc);
  assert.equal(scan.line(scan.text.indexOf("loom.run")), 3, "and the line map still points at the line a reader would open");
});

/**
 * Confusables — the bypass this guard does NOT close, written as a test so the boundary is
 * mechanical rather than a paragraph somebody has to believe.
 *
 * Each row is a `loom.*` claim a reader sees plainly and the scanner does not see at all.
 * If any of them starts being seen, this test fails and asks for the header to be
 * rewritten — the same discipline the registries above use for the gaps they pin.
 */
const CONFUSABLES: readonly { readonly how: string; readonly text: string; readonly nfkcCloses: boolean }[] = [
  { how: "Cyrillic U+043E for Latin o", text: `the lo${CYR_O}m.schedule.pick span`, nfkcCloses: false },
  { how: "fullwidth letters", text: `the ${FULLWIDTH_LOOM}.schedule.pick span`, nfkcCloses: true },
  { how: "mathematical sans-serif letters", text: `the ${MATH_LOOM}.schedule.pick span`, nfkcCloses: true },
];

test("THE CONFUSABLE BYPASSES ARE STILL OPEN — and here is what closing them would cost", () => {
  // Reproduced, not assumed. The header says a homoglyph is invisible to this guard; this
  // is that sentence, run.
  for (const { how, text } of CONFUSABLES) {
    assert.deepEqual(matches(scannable(text).text, SPAN_RE), [], `${how}: the guard now sees this — say so in the header`);
  }

  // And the reason the answer is a confusable table rather than one more `normalize()`
  // call. NFKC — the normalization anyone reaches for first, and free — closes the two
  // COMPATIBILITY rows and does nothing at all for the Cyrillic one, because Cyrillic `о`
  // is a different letter and not a compatibility variant of anything. Closing that row
  // needs a skeleton table, which is a runtime dependency (invariant 1 forbids it) or a
  // hand-maintained table larger than the guard it protects.
  for (const { how, text, nfkcCloses } of CONFUSABLES) {
    const seen = matches(scannable(text.normalize("NFKC")).text, SPAN_RE).includes("loom.schedule.pick");
    assert.equal(seen, nfkcCloses, `${how}: NFKC's effect on it changed`);
  }
});

/**
 * Ordinary hard-wrapped prose, in the four shapes where the old join rules fired.
 *
 * Every entry here MANUFACTURED A CLAIM before this wave — verified by running the old
 * rules over it, not by reasoning about them:
 *
 *   | the shape                                   | what the guard used to read |
 *   |---------------------------------------------|-----------------------------|
 *   | a wrapped table cell ending in a span name   | `loom.run.the`              |
 *   | a nested list item ending in a span name     | `loom.gate.the`             |
 *   | a blockquote continued on the next line      | `loom.task.the`             |
 *   | "everything is prefixed E_" + a capital      | `E_RETRIES`                 |
 *
 * None of those names exists, so each one failed the check above and sent its author to a
 * line that does not contain the name they were shown. That is the failure this file calls
 * fatal in its own header — a guard that cries wolf gets switched off — and the previous
 * version of this test pinned four inputs that tripped no join rule at all, so the property
 * it claimed to protect was untested.
 */
const INNOCENT: readonly { readonly how: string; readonly text: string }[] = [
  { how: "a `loom.*` namespace, wrapped", text: "a `loom.*` namespace for everything else\nnamespace rules follow" },
  { how: "a sentence ending in a span name", text: "derived from the journal by the span\nloom.run is the root" },
  { how: "a wrapped table cell", text: "| 3 | folded into `loom.run`.\n  the rest follows | x |" },
  { how: "a nested list item", text: "- the fold\n  - closes `loom.gate`.\n    the approver is hashed" },
  { how: "a blockquote across lines", text: "> a span exists when an event folds into `loom.task`.\n> the rest is derived" },
  { how: "a hyphenated word at the break", text: "the executor is single-\nthreaded, so `loom.task`\nspans never interleave" },
  { how: "the namespace prefix at a line end", text: "everything else lives under `loom.`\nnothing outside it is ours" },
  { how: "an error-code prefix at a line end", text: "every boundary code is prefixed E_\nRETRIES are not codes at all" },
  { how: "a rule prefix at a line end", text: "the compiler rule family is GRAPH\n99 diagnostics do not exist" },
  { how: "plain markdown", text: "the taxonomy is fixed. e.g.\nsomething follows\n**bold** text and *emphasis* and `code`" },
  // NOT the join rule — PASS 1. An inline-code identifier followed by a letter or a digit
  // had its closing backtick deleted, because `isIdentChar` says a trailing `s` is an
  // identifier character, and the two halves were spliced into a name nobody wrote. This
  // is ordinary English, not an evasion: every one of these is how an author refers to
  // more than one of something.
  { how: "a pluralised inline-code span name", text: "each of the `loom.run`s under a tenant" },
  { how: "a pluralised inline-code span name, bolded", text: "the **`loom.gate`**s a run opens" },
  { how: "a suffixed inline-code span name", text: "the `loom.task`ish spans are internal" },
  { how: "a pluralised inline-code error code", text: "two `E_GATE_REQUIRED`S in one run" },
  { how: "a pluralised inline-code rule", text: "the `GRAPH014`0 series is not a thing" },
  { how: "an inline-code name after a digit", text: "see D9.1`loom.run` for the closing attributes" },
];

test("THE SCANNER DOES NOT INVENT IDENTIFIERS OUT OF ORDINARY HARD-WRAPPED PROSE", () => {
  // A join may recover a claim; it may never invent one. `loom.run` below is written, in
  // full, on one line — everything else these inputs could be read as (`loom.run.the`,
  // `loom.gate.the`, `loom.task.the`, `loom.nothing`, `E_RETRIES`, `GRAPH99`) is a name
  // nobody typed.
  const invented: string[] = [];
  for (const { how, text } of INNOCENT) {
    const scan = scannable(text);
    const seen = [...matches(scan.text, SPAN_RE), ...matches(scan.text, CODE_RE), ...matches(scan.text, GRAPH_RE)];
    for (const name of seen) if (!text.includes(name)) invented.push(`${how}: read ${name}, which is not written anywhere in it`);
  }
  assert.deepEqual(invented, [], "the scanner manufactured a claim out of prose");

  // …and the joins that DO fire still leave the line map usable.
  const scan = scannable(INNOCENT.map((i) => i.text).join("\n\n"));
  assert.equal(scan.line(scan.text.indexOf("loom.run")), 5, "line numbers survive normalization");
});

test("a break inside an UNKNOWN name is loud and wrong, not silent", () => {
  // The honest limit on `scannable`, pinned so it cannot quietly become something else.
  // An unknown name is not joined, so what reaches the checks is the truncated prefix —
  // which still fails, under a name the author never wrote. `WRONG_NAME_HINT` is on those
  // failures for exactly this case.
  const scan = scannable("the `loom.brand.\n  new` span");
  assert.deepEqual(matches(scan.text, SPAN_RE), ["loom.brand"], "the truncated prefix is what gets reported");

  // Silent only when the prefix is itself a name that exists.
  const quiet = scannable("the `loom.run\n  ner.tick` span");
  assert.deepEqual(matches(quiet.text, SPAN_RE), ["loom.run"], "a built prefix swallows the claim — the one hole left here");
});

test("EMPHASIS inside an UNKNOWN name is the same limit, one pass earlier", () => {
  // The price of the pass-1 fix, stated as a test rather than as a paragraph, because it
  // is a REGRESSION in reach and not only a correction: before the straddle rule, emphasis
  // between two identifier characters was deleted unconditionally, so `loom.**brand**.new`
  // was normalized to a name and reported. It no longer is, and the reason is the case
  // directly below it — the same unconditional deletion turned `` `loom.run` `` plus a
  // plural `s` into a report about `loom.runs`, and a guard that reports names nobody
  // wrote gets switched off. Silence in the rare case buys correctness in the common one.
  assert.deepEqual(matches(scannable("the loom.**brand**.new span").text, SPAN_RE), [], "silent: `loom.*` is not span-shaped");

  // Loud-but-wrong as soon as the emphasis is anywhere after the first segment, which is
  // the same shape as a line break inside an unknown name, and carries the same hint.
  assert.deepEqual(matches(scannable("the loom.brand.**new** span").text, SPAN_RE), ["loom.brand"]);

  // And the recovery it must not cost: a name the guard KNOWS is still put back together,
  // wherever the emphasis falls inside it.
  assert.deepEqual(matches(scannable("the loom.**schedule**.pick span").text, SPAN_RE), ["loom.schedule.pick"]);
});

test("methodsOf reads METHODS, and not the type syntax around them", () => {
  // The `readonly (` case is not hypothetical: `ModelCapabilities` in D3 declares
  // `multimodal: readonly ("image" | "audio" | "pdf")[]`, and the day anything in `src/`
  // is named `ModelCapabilities` the old parser would have failed the suite over a method
  // called `readonly` that no author wrote and no fix could satisfy.
  const body = [
    "readonly provider: string;",
    'multimodal: readonly ("image" | "audio" | "pdf")[];',
    "factory: new (spec: GraphSpec) => Runner;",
    "narrow(x: unknown): x is (Model | Tool);",
    "stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;",
    "get<T = unknown>(channel: string): T | undefined;",
    "onEvent: (e: JournalEvent) => void;",
  ].join("\n");
  assert.deepEqual([...methodsOf(body)].sort(), ["get", "narrow", "stream"]);
});

test("stripTsComments removes comments and nothing else", () => {
  // Pinned because the naive version — no regex-literal tracking — let `/[&<>\"]/` open a
  // string that swallowed the rest of the line, which is a silent way to lose a call site.
  const src = [
    'const a = CODES.E_REAL;',
    '// a comment naming E_COMMENTED',
    '/** a docstring naming E_DOCSTRING */',
    'const b = "a string naming E_STRING";',
    'const c = s.replace(/[&<>"]/g, "x") + CODES.E_AFTER_REGEX;',
    'const d = `a template naming E_TEMPLATE and a // slash`;',
  ].join("\n");
  assert.deepEqual([...matches(stripTsComments(src), CODE_RE)].sort(), ["E_AFTER_REGEX", "E_REAL", "E_STRING", "E_TEMPLATE"]);
});

test("the document walk is recursive and does not care about the extension", () => {
  // A `readdir` without `recursive`, filtered to `.md`, let a whole document out of every
  // check above for the price of a subdirectory or a rename.
  const root = mkdtempSync(join(tmpdir(), "loom-docs-drift-"));
  try {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "top.md"), "x");
    writeFileSync(join(root, "nested", "deep.md"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    writeFileSync(join(root, "JOURNAL.md"), "x");
    writeFileSync(join(root, "diagram.png"), "x");
    assert.deepEqual(textFilesUnder(root, new Set(["JOURNAL.md"])), [join("nested", "deep.md"), "notes.txt", "top.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The stricter version, and why it is not here ─────────────────────────────
//
// What the checks above CANNOT see, written down so a green suite is not mistaken for a
// true document:
//
//  - **Which method raises which code.** D3.17's table is per-`interface.method`; the
//    guard only asks whether a code exists and whether anything anywhere raises it. So a
//    row that lists `E_TOOL_TIMEOUT` under `JournalReader.replay` would pass. Closing
//    that needs the throw sites attributed to the method that surfaces them, and no
//    regex can do it: `err.policy(...)` is raised in `delivery.ts` and observed at
//    `ControlPlaneAPI.answerGate` three frames up, so the reachable set is a call-graph
//    question. This was tried on ONE method and failed inside a day — the static version
//    of the `deliver` check above read the codes named in the method body, and a refactor
//    that moved the mapping into `#failure` left the body naming none, so the guard
//    happily reported that `deliver` raises nothing. Rewriting it to RUN the method fixed
//    it. Scaling that is (a) a `@raises` annotation per boundary method, checked against
//    its own body plus its annotated callees — cheap, and only as honest as the
//    annotations — or (b) a harness that drives every boundary method through its failure
//    modes and records what it threw, which is a conformance suite rather than a doc test
//    and is the direction worth taking when the boundary surface stops moving. Either way
//    the lesson is already paid for: prefer running the code to parsing it.
//
//  - **Method SIGNATURES.** The check above compares names only. `sweepTimeouts(now)` and
//    `sweepTimeouts(log, now?)` are both "a method called sweepTimeouts", and the doc was
//    wrong about the parameters for months. Arity via `Function.length` is a trap:
//    default and rest parameters are not counted, so `sweepTimeouts(log, now = …)` reports
//    1 — exactly matching the wrong signature. A real check would compare the doc's
//    parameter list against the emitted `.d.ts`, which exists (`tsc -b` writes it) and is
//    the honest next step. It is not taken here because this test must not depend on a
//    build having run: `npm test` is expected to pass in a clean tree.
//
//  - **Interfaces with no counterpart in `src/` at all.** Thirty-one of the corpus's
//    forty-nine `export interface` blocks name no `src/` symbol. They are contract-only by
//    design, and checking them would mean deciding, per interface, whether it is a promise
//    or a description — a judgement, not a test.
//
//    ONE of the thirty-one is not contract-only and is skipped anyway: `JournalEvent` is an
//    `export interface` here and an `export type` — a mapped discriminated union — in
//    `journal/events.ts`, and `exportedInterfaces()` only reads `export interface`. Its
//    members happen to agree today (checked by hand this wave). Widening the parser to
//    `export type` would need the union arms flattened, which is a different parse.
//
//  - **ENUMERATIONS written as prose lists.** The last sweep found D3.10's "closed
//    `EventType` set" listing 39 of 48 types, missing `gate.cancelled` among others — the
//    very event whose absence caused a severe authorization defect. It is guarded now, by
//    name and in both directions. Nothing generalises that: the corpus has other fenced
//    lists (`Posture`, `IrreversibilityClass`, `Classification`, the `NodeType` and
//    `EdgeKind` taxonomies) and only the last two are checked, because each needs a
//    hand-written anchor to the constant it mirrors. The three unchecked ones were verified
//    by hand this wave and agreed; the next person to change one has no tripwire.
//
//    The eighteen that DO have a counterpart are all checked now, classes by import and
//    `interface`s by parsing their declaration. Until this wave only the four with a class
//    were, and the note here said the other fourteen "would need the same `.d.ts` reading
//    as signatures" — which was true of signatures and not of NAMES. Adding the parsed
//    side found four methods D3 promised that no caller could reach. The `.d.ts` argument
//    stands for parameter lists and for nothing else.
//
//  - **Attribute names.** `loom.task` is emitted, but D9.1 credits it with `node.type`,
//    which `spans.ts` sets nowhere. This was ASSESSED for a guard and rejected, and the
//    reason is specific rather than general squeamishness:
//
//      1. `spans.ts` writes attribute keys both quoted (`"node.id":`) and bare
//         (`channels:`, `skipped:`, `open_tasks:`). A regex can extract the quoted ones
//         exactly and the bare ones not at all — bare keys are indistinguishable from
//         every other property in the file (`name:`, `kind:`, `parent:`). A guard built on
//         the quoted half would report a set it calls complete and is not, which is worse
//         than no guard.
//      2. The complete set is available by RUNNING `spansFrom` and reading
//         `Object.keys(span.attributes)` — and that is the shape worth building. It needs
//         a fixture journal, and the fixture's own coverage is then provable rather than
//         assumed: assert it contains every one of the 48 `EVENT_TYPES`, and any attribute
//         the fold can set has been reached. That fixture is ~48 typed payloads and is the
//         single largest piece of work in this file's future; it belongs next to the span
//         tests, not here.
//      3. Even with the set in hand, the DOC side is a table cell, not a declaration.
//         D9.1 writes `usage.*`, `state.hash.before/after`, and `tasks.total/failed/skipped`
//         — three different shorthands, none of them an attribute key. Pinning them means
//         teaching the guard to expand prose, which is where it starts crying wolf.
//
//     So the accounting lives in D9.1's delta table instead, maintained by hand and
//     pointed at from D8's walkthrough. When (2) exists, the delta table becomes
//     generated and this paragraph can be deleted.
//
//  - **Prose.** "first-class dashboards from day one" is only checkable because it names
//    a span. A sentence that claims the same thing without naming one is invisible here.
