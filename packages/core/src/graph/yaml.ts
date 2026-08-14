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

  source.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) {
      throw fail(where, no, "a tab in the indentation — YAML indentation must be spaces");
    }
    const stripped = stripComment(raw);
    if (stripped.trim() === "") return;
    if (/^---\s*$/.test(stripped.trim())) {
      // A leading `---` OPENS the document; one that arrives after content has been read
      // starts a second, which this subset does not do.
      docs++;
      if (docs > 1 || lines.length > 0) {
        throw fail(where, no, "a second document (---); this subset reads one document per file");
      }
      return;
    }
    if (/^\.\.\.\s*$/.test(stripped.trim())) return;

    for (const r of REFUSED) {
      if (r.test.test(stripped)) throw fail(where, no, `${r.what}, which this subset does not support`);
    }
    lines.push({ indent: stripped.length - stripped.trimStart().length, text: stripped.trimEnd(), no });
  });

  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent, where);
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

function parseBlock(lines: readonly Line[], start: number, indent: number, where: string): [unknown, number] {
  const first = lines[start];
  if (first === undefined) return [null, start];
  return first.text.trimStart().startsWith("- ") || first.text.trim() === "-"
    ? parseSequence(lines, start, indent, where)
    : parseMapping(lines, start, indent, where);
}

function parseSequence(lines: readonly Line[], start: number, indent: number, where: string): [unknown[], number] {
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
      const [value, next] = parseBlock(lines, i + 1, child.indent, where);
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
      const [value, consumed] = parseMapping(synthetic, 0, inner, where);
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

function parseMapping(lines: readonly Line[], start: number, indent: number, where: string): [Record<string, unknown>, number] {
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
      const [value, next] = parseBlock(lines, i + 1, child.indent, where);
      put(out, key, value);
      i = next;
      continue;
    }

    if (rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
      const [text, next] = blockScalar(lines, i + 1, indent, rest.startsWith(">"), rest.endsWith("-"));
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

function blockScalar(lines: readonly Line[], start: number, indent: number, folded: boolean, chomp: boolean): [string, number] {
  const collected: string[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent > indent) {
    collected.push(lines[i]!.text.slice(lines[start]!.indent));
    i++;
  }
  const joined = folded ? collected.join(" ") : collected.join("\n");
  return [chomp ? joined : joined + (collected.length > 0 ? "\n" : ""), i];
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
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || line[i - 1] === " ")) return line.slice(0, i);
  }
  return line;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  return Array.isArray(v) ? "a sequence" : typeof v;
}

function fail(where: string, line: number, what: string): Error {
  return err.validation(CODES.E_GRAPH_INVALID, `${where}:${line}: ${what}`, { details: { line } });
}
