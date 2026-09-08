/**
 * A restricted YAML subset, for authoring only.
 *
 * The canonical on-disk form of a `GraphSpec` is JSON, and that is not negotiable: YAML
 * has several representations of the same document, and a hash over "several
 * representations" is not a hash. So this parses YAML into a plain value and hands JSON
 * to everything downstream — nothing here ever touches a digest.
 *
 * ## Why a subset, and why write one at all
 *
 * The design's open thread T1 asked: take a YAML dependency, or write a subset parser?
 * `@loom/core` has zero runtime dependencies, which is checked in CI and demonstrated by
 * a single binary that boots from an empty directory. Spending that on authoring sugar
 * would be a poor trade.
 *
 * A full YAML parser is genuinely large — anchors, aliases, tags, multiple documents,
 * five scalar styles, implicit typing rules that turn `NO` into `false` and `1:30` into
 * a sexagesimal number. Almost none of it appears in a hand-written GraphSpec.
 *
 * **What is supported:** nested block mappings and sequences, inline `#` comments,
 * `key: value` scalars, block scalars (`|` and `>`), single- and double-quoted strings,
 * JSON-style flow collections (`[a, b]`, `{a: 1}`), `null`/`true`/`false`, numbers, and
 * `---` opening one document.
 *
 * **What is REFUSED, loudly, with a line number:** anchors (`&`), aliases (`*`), tags
 * (`!!`), merge keys (`<<`), multiple documents, and tabs for indentation. Refusing is
 * the whole point — a parser that silently mis-handles an anchor produces a graph the
 * author did not write, and the compiler would then validate the wrong thing perfectly.
 *
 * `ASSUMPTION: hand-authored GraphSpecs do not need anchors. If that turns out false,
 * the reversal is to take a YAML dependency in the CLI layer only — never in core.`
 */

import { CODES, err } from "../errors.ts";

export interface ParseYamlOptions {
  /** Used in error messages. */
  readonly filename?: string;
}

const REFUSED: readonly { readonly test: RegExp; readonly what: string }[] = [
  { test: /(^|\s)&[A-Za-z0-9_-]+(\s|$)/, what: "an anchor (&name)" },
  { test: /(^|\s)\*[A-Za-z0-9_-]+(\s|$)/, what: "an alias (*name)" },
  { test: /(^|\s)!!?[A-Za-z]/, what: "a tag (!!type)" },
  { test: /^\s*<<\s*:/, what: "a merge key (<<:)" },
];

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

/**
 * The raw source, and the raw line ranges block scalars claimed as content.
 *
 * `src` was already threaded through every structural function so `blockScalar` could read the
 * lines rather than the ones `parseYaml` prepared; `blocks` rides along for the reverse trip.
 * `parseYaml`'s document scan runs before block structure is known, so it cannot decide on its
 * own whether a `---` is a second document or a line of somebody's prompt — it records the
 * question and `blockScalar`, the ONE place that decides where a block ends, answers it. A
 * second, lexical pass that found block spans for itself would be a second definition of that
 * boundary, free to disagree with the first, which is the silent mis-read this module refuses
 * anchors to avoid.
 */
interface Doc {
  readonly src: readonly string[];
  /** `[from, to)` in raw 0-based line indices. */
  readonly blocks: [number, number][];
}

const SECOND_DOCUMENT = "a second document (---); this subset reads one document per file";

/**
 * Parse a YAML document into a plain JSON-shaped value.
 *
 * Throws `E_GRAPH_INVALID` with a line number on anything outside the subset. An author
 * who used an anchor deserves to be told so, not to be handed a graph that quietly means
 * something else.
 */
export function parseYaml(source: string, opts: ParseYamlOptions = {}): unknown {
  const where = opts.filename ?? "<yaml>";
  const lines: Line[] = [];
  let docs = 0;

  // A LEADING BOM IS NOT CONTENT. An editor that writes one made `\ufeffa: 1` parse as a key
  // named `\ufeffa`, and the document then failed at line 2 with "content after the document
  // ended" — a diagnostic pointing at the wrong line for a file with nothing wrong with it.
  //
  // AND A LONE `\r` IS A LINE ENDING. Splitting on `/\r?\n/` read a classic-Mac or
  // `\r`-terminated file as ONE line, so `a: 1\rb: 2` parsed as the single key `a` with the
  // value `"1\rb: 2"` — the silent mis-read this module refuses anchors to avoid.
  const src = source.replace(/^\ufeff/, "").split(/\r\n|\n|\r/);
  const doc: Doc = { src, blocks: [] };
  // Raw indices of every `---` that WOULD be a second document. Whether it is one depends on
  // block structure, which nothing knows yet.
  const strayDocs: number[] = [];
  src.forEach((raw, i) => {
    const no = i + 1;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) {
      throw fail(where, no, "a tab in the indentation — YAML indentation must be spaces");
    }
    const stripped = stripComment(raw);
    if (stripped.trim() === "") return;
    if (/^---\s*$/.test(stripped.trim())) {
      // A leading `---` OPENS the document; one that arrives after content has been read
      // starts a second, which this subset does not do — UNLESS it is a line of a block
      // scalar, where `---` is content and not syntax. Recorded rather than refused here, and
      // decided below once `blockScalar` has said which raw lines it took. Either way the line
      // is dropped from `lines`, exactly as `...` is: the block scalar reads `src`, so the raw
      // read puts it back.
      docs++;
      if (docs > 1 || lines.length > 0) strayDocs.push(i);
      return;
    }
    if (/^\.\.\.\s*$/.test(stripped.trim())) return;

    // AGAINST THE LINE WITH ITS QUOTED SPANS BLANKED, because these four patterns are about
    // YAML SYNTAX and a quoted string is not syntax. `d: "Tom &Jerry x"` was refused as an
    // anchor and `d: "2 *3 x"` as an alias — two false refusals in the loud direction, in the
    // check whose whole argument is that a loud refusal beats a silent mis-read.
    const bare = blankQuoted(stripped);
    for (const r of REFUSED) {
      if (r.test.test(bare)) throw fail(where, no, `${r.what}, which this subset does not support`);
    }
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimEnd(), no });
  });

  // A stray `---` with no structure at all around it cannot be inside anything.
  if (lines.length === 0) {
    if (strayDocs.length > 0) throw fail(where, strayDocs[0]! + 1, SECOND_DOCUMENT);
    return null;
  }

  // THE PARSE ERROR IS THE ONE THAT LOSES. A document with a genuine second `---` parses as
  // its two halves concatenated, so whatever it then fails on is a consequence rather than the
  // fault; the recorded `---` is the fault, and keeps the line number and the message it always
  // had. It costs one thing, said out loud: a document broken in two ways where the OTHER
  // fault comes first now reports that other fault, because the pre-scan's refusals still fire
  // in line order and this one no longer does.
  const stray = (): number | undefined => strayDocs.find((i) => !doc.blocks.some(([a, b]) => i >= a && i < b));
  let value: unknown;
  let next: number;
  try {
    [value, next] = parseBlock(lines, 0, lines[0]!.indent, where, doc);
  } catch (e) {
    const inside = stray();
    if (inside !== undefined) throw fail(where, inside + 1, SECOND_DOCUMENT);
    throw e;
  }
  const outside = stray();
  if (outside !== undefined) throw fail(where, outside + 1, SECOND_DOCUMENT);
  if (next < lines.length) throw fail(where, lines[next]!.no, "content after the document ended; check the indentation");
  return value;
}

/** Convenience: parse and assert the result is an object, which every spec is. */
export function parseYamlSpec(source: string, opts: ParseYamlOptions = {}): Record<string, unknown> {
  const value = parseYaml(source, opts);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw fail(opts.filename ?? "<yaml>", 1, `expected a mapping at the top level, got ${describe(value)}`);
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

function parseBlock(lines: readonly Line[], start: number, indent: number, where: string, doc: Doc): [unknown, number] {
  const first = lines[start];
  if (first === undefined) return [null, start];
  return first.text.trimStart().startsWith("- ") || first.text.trim() === "-"
    ? parseSequence(lines, start, indent, where, doc)
    : parseMapping(lines, start, indent, where, doc);
}

function parseSequence(lines: readonly Line[], start: number, indent: number, where: string, doc: Doc): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw fail(where, line.no, "unexpected indentation inside a sequence");
    const body = line.text.trimStart();
    if (!body.startsWith("-")) break;

    const rest = body.slice(1).trim();
    if (rest === "") {
      // `-` alone: the item is the nested block beneath it.
      const child = lines[i + 1];
      if (child === undefined || child.indent <= indent) {
        out.push(null);
        i++;
        continue;
      }
      const [value, next] = parseBlock(lines, i + 1, child.indent, where, doc);
      out.push(value);
      i = next;
      continue;
    }

    // `- key: value` opens a mapping whose indentation is the column after the dash.
    if (isMappingStart(rest)) {
      const inner = line.indent + (body.length - body.slice(1).trimStart().length);
      const synthetic: Line[] = [{ indent: inner, text: " ".repeat(inner) + rest, no: line.no }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= inner) {
        synthetic.push(lines[j]!);
        j++;
      }
      const [value, consumed] = parseMapping(synthetic, 0, inner, where, doc);
      if (consumed < synthetic.length) throw fail(where, synthetic[consumed]!.no, "unexpected content in a sequence item");
      out.push(value);
      i = j;
      continue;
    }

    out.push(scalar(rest, line.no, where));
    i++;
  }
  return [out, i];
}

function parseMapping(lines: readonly Line[], start: number, indent: number, where: string, doc: Doc): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) throw fail(where, line.no, "unexpected indentation inside a mapping");
    const body = line.text.trimStart();
    if (body.startsWith("- ")) break;

    const split = splitKey(body);
    if (split === undefined) throw fail(where, line.no, `expected "key: value", got ${JSON.stringify(body)}`);
    const [key, rest] = split;
    // A duplicate key in JSON silently wins; here it is an error, because in a GraphSpec
    // it means two declarations disagree and one of them is being ignored.
    //
    // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so `constructor`,
    // `toString` and every other name `Object.prototype` carries was reported as a
    // duplicate of a key the author never wrote — a refusal quoting a line with nothing
    // wrong with it.
    if (Object.hasOwn(out, key)) throw fail(where, line.no, `duplicate key "${key}"`);

    if (rest === "") {
      const child = lines[i + 1];
      if (child === undefined || child.indent <= indent) {
        put(out, key, null);
        i++;
        continue;
      }
      const [value, next] = parseBlock(lines, i + 1, child.indent, where, doc);
      put(out, key, value);
      i = next;
      continue;
    }

    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const [text, next] = blockScalar(lines, i + 1, indent, rest.startsWith(">"), rest.endsWith("-"), doc, where, line.no);
      put(out, key, text);
      i = next;
      continue;
    }

    put(out, key, scalar(rest, line.no, where));
    i++;
  }
  return [out, i];
}

/**
 * Write a parsed key as a KEY, whatever it is called.
 *
 * `out[key] = value` is not an assignment for one name: `__proto__` has a setter on
 * `Object.prototype`, so that line changes the object's prototype and stores nothing. The
 * key then vanishes from the parsed document — a line the author wrote, silently dropped,
 * which is exactly the mis-read this subset refuses anchors to avoid. `defineProperty`
 * makes it an own data property like any other, so a `__proto__` channel reaches the
 * compiler's id charset rule instead of disappearing before it.
 */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(out, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  out[key] = value;
}

/**
 * A block scalar reads the RAW source lines, not the ones `parseYaml` prepared for structure.
 *
 * `parseYaml` strips comments and drops blank lines before block structure is known, so three
 * separate edits were being made to text nobody asked it to touch. Measured at 95a3dde:
 *
 *     d: |  /   line one # not a comment in YAML  /   line two   ->  "line one\nline two\n"
 *     d: |  /   para one  /  (blank)  /  para two              ->  "para one\npara two\n"
 *     d: |  /   a  /  # b  /  c                                ->  "a\nc\n"
 *
 * Every one is a silent mis-read producing a value no author wrote, in the module whose stated
 * contract is that a loud refusal beats one. Inside a block scalar there IS no comment syntax and
 * a blank line is content, so the fix is to read the source instead of the prepared line —
 * `lines` still decides where the block ENDS, because indentation is structure.
 *
 * A LINE INDENTED BELOW THE BLOCK'S FIRST IS REFUSED RATHER THAN SLICED. `text.slice(firstIndent)`
 * cut such a line mid-word: `k: |` / six-space `first` / three-space `second` produced
 * `"first\nond\n"`, character-corrupted with no diagnostic. It is malformed YAML and this subset
 * says so with a line number.
 *
 * TRAILING BLANK LINES ARE DROPPED, which is YAML's clip chomping and is also what makes the
 * blank line BETWEEN a block and the next key not part of the block. Trailing whitespace WITHIN
 * a line is still trimmed, which real YAML preserves; it is invisible, it is what this parser has
 * always done, and no fixture in the tree depends on either reading.
 *
 * **THIS IS HASH-CHANGING FOR SOMEBODY ELSE'S GRAPH FILE.** Every YAML document the suite parses
 * is byte-identical before and after, and the one that compiles keeps its `graphHash` — but that
 * is a fact about THIS tree. A user graph whose `prompt: |` contains a `#` line or a blank line
 * now parses to different text and therefore hashes differently, so `graphsByHash` lookups,
 * promoted hashes and cached compiles for such a file stop matching. The new reading is the
 * correct one and the old value was never what the author wrote; the migration is real all the
 * same and belongs in a release note rather than only here.
 *
 * AND `---` IS CONTENT IN HERE TOO, which was the last member of the family this function can
 * reach. One shape outside it survives, and naming it is cheaper than implying it does not
 * exist: a block scalar opened by a BARE sequence item (`- |`) is not part of this subset at
 * all, so `---` under one is still reported as a second document rather than as unsupported
 * syntax. Nothing legitimate is lost — `- |` does not parse either way — but the message is
 * the wrong one for that input. The
 * document scan runs before block structure is known, so it could not tell a second document
 * from a line of somebody's prompt; it now RECORDS the question and this function answers it,
 * by reporting the raw lines it took into `doc.blocks`. That keeps one definition of where a
 * block ends — a scan that worked the spans out for itself would be a second one, free to
 * disagree. `...` needed none of this: the scan only DROPS it and the raw read puts it back,
 * which is now what happens to `---` as well.
 */
function blockScalar(
  lines: readonly Line[],
  start: number,
  indent: number,
  folded: boolean,
  chomp: boolean,
  doc: Doc,
  where: string,
  headerNo: number,
): [string, number] {
  const src = doc.src;
  // THE BLOCK'S INDENT COMES FROM THE FIRST NON-BLANK RAW LINE, not from `lines[start]`. `lines`
  // has already dropped blank and comment-only lines, so a block whose FIRST line is a comment had
  // that line silently deleted — `script: |` beginning `# what this does` lost it — and, worse,
  // the indent was then measured from a LATER line, so a legal document was refused:
  // `a: |` / two-space `# note` / four-space `x` / two-space `y` threw "line indented 2 where its
  // first line is indented 4". Reading the raw lines fixes both, and the diagnostic then names the
  // block's real indent.
  const from = headerNo;
  let blockIndent: number | undefined;
  for (let k = from; k < src.length; k++) {
    const raw = src[k]!;
    if (raw.trim() === "") continue;
    const ind = raw.length - raw.trimStart().length;
    if (ind <= indent) break;
    blockIndent = ind;
    break;
  }
  if (blockIndent === undefined) return ["", start];

  // Claimed AS THE WALK ADVANCES, not after it: the walk can throw on a badly indented line,
  // and `parseYaml` reads this to decide whether a recorded `---` was content. A block that
  // refuses one of its lines has still claimed the ones above it, so a `---` among them does
  // not get re-diagnosed as a second document on the way out.
  const claim: [number, number] = [from, from];
  doc.blocks.push(claim);

  const collected: string[] = [];
  let r = from;
  for (; r < src.length; r++) {
    const raw = src[r]!;
    if (raw.trim() === "") {
      claim[1] = r + 1;
      collected.push("");
      continue;
    }
    const ind = raw.length - raw.trimStart().length;
    if (ind <= indent) break;
    claim[1] = r + 1;
    if (ind < blockIndent) {
      throw fail(
        where,
        r + 1,
        `a block scalar line indented ${String(ind)} where its first line is indented ${String(blockIndent)}; ` +
          `every line of a block scalar must be indented at least as far as its first`,
      );
    }
    collected.push(raw.slice(blockIndent).trimEnd());
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();

  // The block ends at raw index `r`; step `lines` past everything the block consumed.
  let i = start;
  while (i < lines.length && lines[i]!.no <= r) i++;

  const joined = folded ? fold(collected) : collected.join("\n");
  return [chomp ? joined : joined + (collected.length > 0 ? "\n" : ""), i];
}

/**
 * YAML's folding rule: a single line break becomes a space, and `n` blank lines become `n` breaks.
 *
 * `collected.join(" ")` was right only while blank lines were being thrown away upstream. Once
 * they were preserved it produced RUNS OF SPACES for a paragraph break — `prompt: >` with two
 * paragraphs came out `"You are a reviewer.  Answer in one line."` and with two blank lines
 * `"…   Be brief."` — a value no author wrote, in the fix whose whole subject is values no author
 * wrote. `prompt: >` with paragraphs is an ordinary graph shape.
 */
function fold(lines: readonly string[]): string {
  let out = "";
  let blanks = 0;
  let started = false;
  for (const line of lines) {
    if (line === "") {
      blanks++;
      continue;
    }
    if (!started) out = line;
    else out += (blanks > 0 ? "\n".repeat(blanks) : " ") + line;
    started = true;
    blanks = 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Scalars and flow collections
// ---------------------------------------------------------------------------

/** `key: value`, honouring quotes so a colon inside a string does not split it. */
function splitKey(body: string): [string, string] | undefined {
  let quote: string | undefined;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ":" && (i + 1 === body.length || body[i + 1] === " ")) {
      const key = body.slice(0, i).trim();
      return [unquote(key), body.slice(i + 1).trim()];
    }
  }
  return undefined;
}

function isMappingStart(text: string): boolean {
  return splitKey(text) !== undefined && !text.startsWith("{") && !text.startsWith("[");
}

function scalar(text: string, no: number, where: string): unknown {
  if (text.startsWith("[") || text.startsWith("{")) return flow(text, no, where);
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);

  if (text === "null" || text === "~" || text === "") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  // DELIBERATELY NOT the YAML 1.1 booleans. `yes`, `no`, `on`, `off` becoming booleans is
  // the single most notorious YAML footgun — and `on` is a posture value in this system,
  // so silently turning `posture: on` into `posture: true` would be catastrophic.
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(text) || /^-?\d+[eE][+-]?\d+$/.test(text)) return Number(text);
  return text;
}

/**
 * Flow collections — `[a, b]` and `{k: v}`.
 *
 * Hand-parsed rather than regex-quoted-then-`JSON.parse`d. The first attempt did the
 * latter and broke on `capabilities: [fs:write]`: the regex saw the colon in a capability
 * NAME as a key separator and produced `["fs":write]`. Any regex that distinguishes those
 * two colons is already a parser, so this is the parser.
 */
function flow(text: string, no: number, where: string): unknown {
  const p = new FlowReader(text, no, where);
  const value = p.value();
  p.skipSpace();
  if (!p.done) throw fail(where, no, `trailing content in the flow collection ${JSON.stringify(text)}`);
  return value;
}

class FlowReader {
  #i = 0;
  // Explicit fields, not parameter properties: `erasableSyntaxOnly` is on, so the type
  // annotations must be erasable and nothing may generate runtime code.
  readonly src: string;
  readonly no: number;
  readonly where: string;

  constructor(src: string, no: number, where: string) {
    this.src = src;
    this.no = no;
    this.where = where;
  }

  get done(): boolean {
    return this.#i >= this.src.length;
  }

  skipSpace(): void {
    while (this.#i < this.src.length && /\s/.test(this.src[this.#i]!)) this.#i++;
  }

  value(): unknown {
    this.skipSpace();
    const c = this.src[this.#i];
    if (c === "[") return this.#sequence();
    if (c === "{") return this.#mapping();
    return scalar(this.#bare(), this.no, this.where);
  }

  #sequence(): unknown[] {
    this.#i++; // [
    const out: unknown[] = [];
    this.skipSpace();
    if (this.src[this.#i] === "]") {
      this.#i++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      this.skipSpace();
      const c = this.src[this.#i++];
      if (c === "]") return out;
      if (c !== ",") throw fail(this.where, this.no, `expected "," or "]" in a flow sequence`);
    }
  }

  #mapping(): Record<string, unknown> {
    this.#i++; // {
    const out: Record<string, unknown> = {};
    this.skipSpace();
    if (this.src[this.#i] === "}") {
      this.#i++;
      return out;
    }
    for (;;) {
      this.skipSpace();
      const key = unquote(this.#bare());
      this.skipSpace();
      if (this.src[this.#i++] !== ":") throw fail(this.where, this.no, `expected ":" after "${key}" in a flow mapping`);
      // The same two rules as a block mapping, for the same two reasons — a flow
      // collection is a spelling, not a different document model.
      if (Object.hasOwn(out, key)) throw fail(this.where, this.no, `duplicate key "${key}"`);
      put(out, key, this.value());
      this.skipSpace();
      const c = this.src[this.#i++];
      if (c === "}") return out;
      if (c !== ",") throw fail(this.where, this.no, `expected "," or "}" in a flow mapping`);
    }
  }

  /**
   * One scalar token.
   *
   * A bare token runs to the next structural character. Inside a MAPPING a colon is
   * structural and inside a SEQUENCE it is not — which is exactly the `[fs:write]` case,
   * so the reader tracks it rather than guessing.
   */
  #bare(): string {
    const start = this.#i;
    const c = this.src[this.#i];
    if (c === '"' || c === "'") {
      this.#i++;
      while (this.#i < this.src.length && this.src[this.#i] !== c) {
        if (this.src[this.#i] === "\\") this.#i++;
        this.#i++;
      }
      this.#i++;
      return this.src.slice(start, this.#i);
    }
    while (this.#i < this.src.length && !",[]{}".includes(this.src[this.#i]!)) {
      // A colon ENDS a token only when it is followed by a space or a value — which is
      // how `{k: v}` differs from `[fs:write]`.
      if (this.src[this.#i] === ":" && this.#inMapping) break;
      this.#i++;
    }
    return this.src.slice(start, this.#i).trim();
  }

  get #inMapping(): boolean {
    // Scan back for the nearest unclosed opener.
    let depth = 0;
    for (let j = this.#i - 1; j >= 0; j--) {
      const c = this.src[j]!;
      if (c === "}" || c === "]") depth++;
      else if (c === "{" || c === "[") {
        if (depth === 0) return c === "{";
        depth--;
      }
    }
    return false;
  }
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      if (c === "\\") i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (opensQuote(line, i)) quote = c;
    else if (c === "#" && (i === 0 || line[i - 1] === " ")) return line.slice(0, i);
  }
  return line;
}

/**
 * A quote character only OPENS a quoted span at the start of a token.
 *
 * Any `\'` counted as an opening quote, so an apostrophe inside a plain scalar swallowed the
 * rest of the line: `d: don't do this # a note` parsed as `"don't do this # a note"`, comment
 * included, where real YAML gives `"don't do this"`. Apostrophes are ordinary in prose and a
 * `description:` is prose, so this is the common case rather than an exotic one.
 */
function opensQuote(line: string, i: number): boolean {
  const c = line[i];
  if (c !== '"' && c !== "'") return false;
  if (i === 0) return true;
  const prev = line[i - 1]!;
  return prev === " " || prev === "\t" || prev === ":" || prev === "," || prev === "[" || prev === "{" || prev === "-";
}

/**
 * The line with every CLOSED quoted span replaced by spaces — syntax only, no content.
 *
 * `REFUSED` looks for anchors, aliases, tags and merge keys, which are YAML SYNTAX. Applied to the
 * raw line they also matched the same characters inside a STRING, so `d: "Tom &Jerry x"` was
 * refused as an anchor and `d: "2 *3 x"` as an alias.
 *
 * AN UNTERMINATED QUOTE RETURNS THE LINE UNBLANKED, which is the fail-closed answer and was not
 * the first one. Blanking to end-of-line made all four refusals reachable by leaving a quote open:
 * `d: "abc &anc x` threw `an anchor (&name)` at 95a3dde and parsed clean here, as did the alias,
 * tag and merge-key forms. A guard answering its undecidable case with the passing value is the
 * lens this repo finds most of its defects with, and this was one.
 */
function blankQuoted(line: string): string {
  const out = [...line];
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote !== undefined) {
      out[i] = " ";
      if (c === "\\" && i + 1 < line.length) {
        out[++i] = " ";
        continue;
      }
      if (c === quote) quote = undefined;
      continue;
    }
    if (opensQuote(line, i)) {
      quote = c;
      out[i] = " ";
    }
  }
  return quote === undefined ? out.join("") : line;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "a sequence" : typeof v;
}

function fail(where: string, line: number, what: string): Error {
  return err.validation(CODES.E_GRAPH_INVALID, `${where}:${line}: ${what}`, { details: { line } });
}
