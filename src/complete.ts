/**
 * The interactive console's Tab completer: a pure `(line, ctx)` transform
 * returning readline's `[matches, substring]` tuple across three domains —
 * slash-command name, command argument, and filesystem path. It depends on no
 * live TTY and imports no `node:fs`/`node:os`: the directory reader and home
 * directory are injected through `ctx`, so the whole transform is unit-testable
 * offline over a fake tree.
 *
 * readline replaces the returned `substring` (the segment being completed) with
 * the chosen match, so every match begins with that substring; mismatching the
 * two is the classic completer bug, so each domain returns the exact slice
 * readline will overwrite.
 */

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CompleterContext {
  /** Live command names, without the leading "/". */
  commandNames: () => readonly string[];
  /** Loaded extension ids (host.list()), for /reload argument completion. */
  extensionIds: () => readonly string[];
  /** The canonical provider set, for /provider argument completion. */
  providerNames: readonly string[];
  /** Reads one directory's entries; may throw — complete() catches and yields no matches. */
  readDir: (dir: string) => readonly DirEntry[];
  /** Home directory, used only to expand a leading "~/" in a path token. */
  homedir: () => string;
}

/**
 * Map an input line to readline's `[matches, substring]` tuple. The domain is
 * decided top to bottom: a leading "/" with no space is a command name; a known
 * "/<command> " prefix is that command's argument; anything else is a path
 * completion of the last token, but only when that token is path-like.
 */
export function complete(line: string, ctx: CompleterContext): [string[], string] {
  // Command-name domain: a leading "/" at the start of the line, still on the
  // first token (no space yet). A leading "/" here is always a command, never
  // an absolute path, so this branch precedes any path handling.
  if (line.startsWith("/") && !line.includes(" ")) {
    const matches = ctx
      .commandNames()
      .map((name) => `/${name}`)
      .filter((candidate) => candidate.startsWith(line));
    return [matches, line];
  }

  // Argument domain: "/<known-command> <fragment>". Dispatch by command name to
  // an enumerable value set; any non-enumerable command yields no matches.
  if (line.startsWith("/")) {
    const space = line.indexOf(" ");
    const name = line.slice(1, space);
    if (ctx.commandNames().includes(name)) {
      const fragment = line.slice(space + 1);
      const values =
        name === "provider"
          ? ctx.providerNames
          : name === "reload"
            ? ctx.extensionIds()
            : [];
      const matches = values.filter((value) => value.startsWith(fragment));
      return [matches, fragment];
    }
  }

  // Path domain: complete the last whitespace-delimited token, but only when it
  // is path-like (contains a "/", which every path prefix below also implies).
  const token = lastToken(line);
  if (!isPathLike(token)) return [[], token];

  const slash = token.lastIndexOf("/");
  const dirPart = token.slice(0, slash);
  const base = token.slice(slash + 1);

  // Resolve the directory to read — the only place "~" is expanded. An empty
  // dirPart is a single-segment absolute path (e.g. "/Users"), which reads the
  // filesystem root, not the cwd.
  const resolvedDir =
    dirPart === ""
      ? "/"
      : dirPart.startsWith("~")
        ? ctx.homedir() + dirPart.slice(1)
        : dirPart;

  let entries: readonly DirEntry[];
  try {
    entries = ctx.readDir(resolvedDir);
  } catch {
    return [[], token];
  }

  // Hidden entries are offered only when the base itself starts with "." —
  // standard shell behavior, so a path completion never dumps .git/.env.
  const showHidden = base.startsWith(".");
  const matches = entries
    .filter((entry) => entry.name.startsWith(base) && (showHidden || !entry.name.startsWith(".")))
    // Reconstruct from the *original* dirPart so a leading "~"/"./" is preserved
    // and dirPart === "" yields "/" + name. A directory gets a trailing "/" so
    // the user can keep descending.
    .map((entry) => `${dirPart}/${entry.name}${entry.isDirectory ? "/" : ""}`);
  return [matches, token];
}

/** The last whitespace-delimited token of the line ("" if the line ends in space). */
function lastToken(line: string): string {
  const parts = line.split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

/** A token is path-like iff it contains a "/" (every accepted path prefix has one). */
function isPathLike(token: string): boolean {
  return token.includes("/");
}
