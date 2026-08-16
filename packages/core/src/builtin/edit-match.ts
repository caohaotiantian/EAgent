/**
 * Locating the span a model MEANT when its exact string does not occur.
 *
 * A whole-file write is the only edit primitive that always works, and it is the wrong one:
 * it makes the model reproduce every byte it is not changing, which costs output tokens
 * proportional to the file and fails by silently dropping the parts it paraphrased. An
 * `old string → new string` edit is the right primitive and it has one hard problem — the
 * model reconstructs the old string from context and gets the WHITESPACE wrong.
 *
 * So this relaxes whitespace and escaping, and nothing else. The ladder never relaxes
 * non-whitespace content, because a match that "looks close enough" is how an edit lands in
 * the wrong function. Five strategies are tried in order and the first that locates a
 * UNIQUE and PROPORTIONATE span wins; a span that matches in two places is `ambiguous` and a
 * span far larger than what was asked for is `disproportionate`. Both are refusals, not
 * best-effort guesses — the tool reports them and changes nothing.
 *
 * VENDORED from EAgent `src/extensions/lib/edit-match.ts` @ tag `eagent-v1`, unchanged
 * except for this docstring and the explicit `undefined` guards Loom's
 * `noUncheckedIndexedAccess` requires. It was chosen first of the whole 21k-LOC extension
 * tree because it is pure: zero imports, zero clock, zero randomness, so it carries none of
 * the invariant problems the rest of that tree does.
 */

export type EditMatch =
  | { kind: "exact"; span: string; count: number }
  | { kind: "relaxed"; span: string; strategy: string }
  | { kind: "ambiguous" }
  | { kind: "disproportionate" }
  | { kind: "not-found" };

type Replacer = (content: string, find: string) => Generator<string>;

function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4);
}

const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }
  if (searchLines.length === 0) return;

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;

    for (let j = 0; j < searchLines.length; j++) {
      const originalLine = originalLines[i + j];
      const searchLine = searchLines[j];
      if (originalLine === undefined || searchLine === undefined) {
        matches = false;
        break;
      }
      if (originalLine.trim() !== searchLine.trim()) {
        matches = false;
        break;
      }
    }

    if (matches) {
      let matchStartIndex = 0;
      for (let k = 0; k < i; k++) {
        matchStartIndex += (originalLines[k]?.length ?? 0) + 1;
      }

      let matchEndIndex = matchStartIndex;
      for (let k = 0; k < searchLines.length; k++) {
        matchEndIndex += originalLines[i + k]?.length ?? 0;
        if (k < searchLines.length - 1) {
          matchEndIndex += 1;
        }
      }

      yield content.substring(matchStartIndex, matchEndIndex);
    }
  }
};

const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string): string => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;

    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match?.[1]?.length ?? 0;
      }),
    );

    return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join("\n");
  };

  const normalizedFind = removeIndentation(find);
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string => {
    return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });
  };

  const unescapedFind = unescapeString(find);

  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    const unescapedBlock = unescapeString(block);

    if (unescapedBlock === unescapedFind) {
      yield block;
    }
  }
};

const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();

  if (trimmedFind === find) {
    return;
  }

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

const LADDER: ReadonlyArray<{ name: string; replacer: Replacer }> = [
  { name: "line-trimmed", replacer: LineTrimmedReplacer },
  { name: "whitespace-normalized", replacer: WhitespaceNormalizedReplacer },
  { name: "indentation-flexible", replacer: IndentationFlexibleReplacer },
  { name: "escape-normalized", replacer: EscapeNormalizedReplacer },
  { name: "trimmed-boundary", replacer: TrimmedBoundaryReplacer },
];

export function locateEdit(content: string, find: string, replaceAll: boolean): EditMatch {
  if (find.trim() === "") return { kind: "not-found" };

  const count = content.split(find).length - 1;
  if (count >= 1) return { kind: "exact", span: find, count };

  let seen = false;
  for (const { name, replacer } of LADDER) {
    for (const search of replacer(content, find)) {
      if (content.indexOf(search) === -1) continue;
      if (isDisproportionateMatch(search, find)) return { kind: "disproportionate" };
      if (replaceAll || content.indexOf(search) === content.lastIndexOf(search)) {
        return { kind: "relaxed", span: search, strategy: name };
      }
      seen = true;
    }
  }

  return seen ? { kind: "ambiguous" } : { kind: "not-found" };
}
