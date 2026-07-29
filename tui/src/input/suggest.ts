/**
 * Popup suggestions for `/` commands and `@` file mentions.
 *
 * Pure: directory reading arrives as an injected function, so every ranking and
 * trigger rule is testable offline. This is a rewrite rather than a reuse of the
 * engine's `complete.ts` — that one is readline-shaped (it returns the overwrite
 * tuple readline wants) and its path domain requires the token to contain a `/`,
 * so a bare `@src` would produce nothing.
 */

export interface Suggestion {
  /** What is inserted when accepted. */
  value: string;
  /** What is shown in the popup. */
  label: string;
  /** Right-hand hint — a command's description, or `dir` for a directory. */
  hint?: string;
  /** What ranking matches against. Defaults to `label`; commands set it to the
   *  bare name so a substring query is not defeated by the leading slash. */
  key?: string;
}

export interface SuggestContext {
  commands: () => { name: string; description: string }[];
  /** List one directory. Injected so tests need no filesystem. */
  readDir: (dir: string) => { name: string; isDirectory: boolean }[];
}

/** The active trigger, derived from the text before the cursor. */
export interface Trigger {
  kind: "command" | "file";
  /** Offset where the trigger token starts, so accepting can splice it out. */
  start: number;
  /** The text typed after the trigger character. */
  query: string;
}

/**
 * Find the popup trigger at the cursor, if any.
 *
 * `/` only triggers at the very start of the input — mid-sentence a slash is a
 * path separator or a date, not a command. `@` triggers anywhere it follows
 * whitespace, which is how a file is mentioned inside a sentence.
 */
export function findTrigger(text: string, cursor: number): Trigger | null {
  const before = text.slice(0, cursor);

  if (/^\/[^\s]*$/.test(before)) {
    return { kind: "command", start: 0, query: before.slice(1) };
  }

  const at = before.lastIndexOf("@");
  if (at !== -1) {
    const preceding = at === 0 ? "" : before[at - 1]!;
    const query = before.slice(at + 1);
    // Whitespace-anchored and no spaces inside, so `a@b.com` and a finished
    // mention followed by prose do not keep the popup open.
    if ((at === 0 || /\s/.test(preceding)) && !/\s/.test(query)) {
      return { kind: "file", start: at, query };
    }
  }

  return null;
}

/** Rank: exact prefix first, then substring, each alphabetical. */
function rank(candidates: Suggestion[], query: string): Suggestion[] {
  if (query === "") return candidates;
  const q = query.toLowerCase();
  const prefix: Suggestion[] = [];
  const substring: Suggestion[] = [];
  for (const c of candidates) {
    const v = (c.key ?? c.label).toLowerCase();
    if (v.startsWith(q)) prefix.push(c);
    else if (v.includes(q)) substring.push(c);
  }
  return [...prefix, ...substring];
}

const MAX = 10;

export function suggest(trigger: Trigger, ctx: SuggestContext): Suggestion[] {
  if (trigger.kind === "command") {
    const all = ctx.commands().map((c) => ({
      value: `/${c.name} `,
      label: `/${c.name}`,
      hint: c.description,
      key: c.name,
    }));
    return rank(all, trigger.query).slice(0, MAX);
  }

  // A file query splits into "the directory to list" and "the prefix to match".
  const slash = trigger.query.lastIndexOf("/");
  const dir = slash === -1 ? "." : trigger.query.slice(0, slash + 1);
  const prefix = slash === -1 ? trigger.query : trigger.query.slice(slash + 1);

  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = ctx.readDir(dir);
  } catch {
    return []; // an unreadable or non-existent directory is not an error here
  }

  const visible = entries.filter((e) => !e.name.startsWith(".") || prefix.startsWith("."));
  const all = visible.map((e) => ({
    value: `@${dir === "." ? "" : dir}${e.name}${e.isDirectory ? "/" : " "}`,
    label: `${dir === "." ? "" : dir}${e.name}${e.isDirectory ? "/" : ""}`,
    hint: e.isDirectory ? "dir" : undefined,
    key: e.name,
  }));

  return rank(all, prefix).slice(0, MAX);
}

/** Splice an accepted suggestion into the buffer, returning text and cursor. */
export function accept(
  text: string,
  cursor: number,
  trigger: Trigger,
  choice: Suggestion,
): { text: string; cursor: number } {
  const head = text.slice(0, trigger.start);
  const tail = text.slice(cursor);
  return { text: head + choice.value + tail, cursor: head.length + choice.value.length };
}
