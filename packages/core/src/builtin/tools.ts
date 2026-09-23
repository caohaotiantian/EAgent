/**
 * The built-in tool set.
 *
 * Deliberately tiny — filesystem reads and writes inside a jail, and an HTTP fetch.
 * Everything else is a plugin. The point of shipping any at all is that a fresh
 * install can run a real graph without the user writing a tool first, which is what
 * makes the walking skeleton reproducible outside the test suite.
 *
 * Every one declares its irreversibility class honestly, because that class — not a
 * config file — decides the default oversight posture (D7.6).
 *
 * THESE ARE THE ONLY TOOLS IN THE SYSTEM THAT TOUCH A DISK OR A NETWORK, so whatever
 * they will not do IS the boundary — and all three of the things they will not do were
 * one line short of holding. The checks, each made where the argument's meaning is known
 * rather than deeper down where it is just a string:
 *
 *  - `opts.root` — where a path may land, compared as a REAL path, so a symlink is not a
 *    way out (`assertWithin`);
 *  - `opts.deny` — what inside the root is still off limits, because the root contains
 *    the journal;
 *  - `opts.egressAllowlist` — which hosts may be reached, re-checked on EVERY redirect,
 *    because the host that answers is not the host the model named.
 *
 * A fourth thing they will not do was added later, and it is a CORRECTNESS bound rather
 * than a security one: two fan-out branches writing the same relative path no longer land
 * on the same file. See `branchRoot`.
 */

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Script, createContext } from "node:vm";

import { CODES, err, isLoomError } from "../errors.ts";
import { encodeBranch, parseTaskId } from "../ids.ts";
import { assertWithin, runSandboxed } from "../sandbox/subprocess.ts";
import { locateEdit } from "./edit-match.ts";
import { globToRegExp, walk } from "./search-match.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../run/registry.ts";

export interface BuiltinOptions {
  /** The jail. Every path argument is resolved against it and may not escape. */
  readonly root: string;
  /**
   * Subtrees inside the root that are STILL out of reach. Required, and deliberately
   * without a default.
   *
   * The jail root is a workspace, and a workspace holds more than the model's working
   * files: `openWorkspace` puts `.loom/journal.db` in it, and the journal is the only
   * authoritative durable state there is (invariant 2). Containment alone therefore said
   * yes to the one write that destroys the run's own history — measured through the real
   * CLI, a `tool` node with `fs.write {path: ".loom/journal.db"}` reported
   * **`status: "succeeded"`** having truncated the database to nine bytes, and `fs.read`
   * of the same path returns everything ever journaled, past every redaction the event
   * path applies.
   *
   * It has no default BECAUSE a default would be inherited silently. An embedder calling
   * `builtinTools({ root })` with no second thought is the case that produced the hole;
   * `deny: []` is a sentence someone had to write, and `[dataDir]` is what `cli.ts`
   * writes. Entries may be absolute or relative to `root`, and are compared as REAL
   * paths — see `assertWithin`.
   *
   * `root` here means the WORKSPACE root in both spellings, never a branch's directory:
   * a relative entry is resolved once, up front, by `resolvedDeny`. See its docstring for
   * what would otherwise stop being denied.
   */
  readonly deny: readonly string[];
  /** Domains `net.fetch` may reach. Empty means the tool is not registered at all. */
  readonly egressAllowlist?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  /**
   * Program names `proc.exec` may run. Empty means the tool is not registered at all.
   *
   * Matched EXACTLY against the `command` argument — not as a prefix, not as a path. See
   * `procExec`, which explains why this list is the entire boundary rather than one check
   * among several: a child process does its own `open()`, so `assertWithin` and `deny`
   * stop applying the moment a shell is reachable through this list.
   */
  readonly execAllowlist?: readonly string[];
  /**
   * Environment variable NAMES `proc.exec` passes through. Absent means an empty
   * environment, which is the right default in a process that holds provider API keys.
   */
  readonly execEnvAllow?: readonly string[];
}

/** Absent on platforms without the flag, where this is an ordinary open. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Where a non-root branch's files go, relative to the workspace root.
 *
 * One directory, not one per run: `TaskId` is `nodeId@branchPath#iteration` and the
 * branch path is unique within a run, but NOT across runs — two runs of the same graph
 * produce the same coordinates. Runs sharing a workspace therefore still share these
 * directories, which is the same sharing `--workspace` already implies for the root
 * branch. Making it per-run needs a `runId` on `ToolContext`, which is an `engine.ts`
 * change and is not this one.
 */
const BRANCH_DIR = ".branches";

/**
 * THE JAIL IS PER BRANCH, and this is the whole of it.
 *
 * `cli.ts` builds `builtinTools(jail)` ONCE, with one `root`, for every run and every
 * branch and every worker in the process. So a fan-out over three items whose branches
 * each write `report.md` produced ONE file: the last writer won, the other two were
 * gone, and nothing was appended, printed or returned to say a write had been
 * overwritten by a sibling. Silent, and wrong in a way the journal cannot show, because
 * all three `effect.completed` records say the write succeeded — and each did.
 *
 * `ToolContext.taskId` is already the fix. It is DERIVED (invariant 3) —
 * `nodeId@branchPath#iteration` — and `engine.ts` passes the real one into every tool
 * call, so the branch coordinate is in hand at the one place that turns a relative path
 * into a real one. No engine change is involved in this file's version of the fix.
 *
 * THE ROOT BRANCH IS THE WORKSPACE ITSELF, unchanged. A graph with no fan-out has one
 * branch, `root`, and its files must keep landing where `--workspace` says — otherwise
 * every existing workspace, every operator's `ls`, and every graph that names an output
 * path breaks for a hazard it does not have.
 *
 * THE NAME IS FLAT, AND INJECTIVE OVER THE COORDINATES A COMPILED GRAPH CAN PRODUCE.
 * `encodeBranch` joins segments with `/`, and nesting child branches inside their parent's
 * directory would put a child's files inside the parent's workspace — a second collision
 * to fix the first. Replacing the separator with `+` is injective because `+` cannot occur
 * inside a segment: a segment is `edgeId[index]`, an index is digits, and an edge id is
 * `[A-Za-z0-9._-]` by `validate.ts`'s `SAFE_ID`, which is a COMPILE-time refusal
 * (`GRAPH003_BAD_ID`). It is deliberately not claimed of every string `decodeBranch` will
 * accept — that regex only excludes `[` and `]`, so a hand-built TaskId carrying a `+` can
 * collide. Nothing derives one: invariant 3 says the engine computes this id from the
 * graph, and the graph is what `SAFE_ID` governs.
 *
 * **WHAT THIS IS NOT.** It is not a privilege boundary and must not be described as one.
 * Every branch still shares one jail root, so a task that spells `.branches/root+fo[1]/x`
 * explicitly reaches a sibling's file, exactly as it always could. What is closed is the
 * ACCIDENT — two branches that each asked for `report.md` — which is the failure that
 * actually happens, because a graph author writes one path and the runtime runs it N
 * times. A privilege boundary between branches needs a jail per branch that the branch
 * cannot name its way out of, which is a sandbox change and not a path change.
 *
 * A malformed `taskId` THROWS out of `parseTaskId` rather than falling back to the root
 * branch. A fallback would silently restore the clobber for exactly the caller that got
 * the id wrong, and `E_INTERNAL: malformed task id: …` is the true diagnosis: invariant 3
 * says this id is derived, so a bad one is a bug above this file, not a user error.
 */
function branchRoot(root: string, deny: readonly string[], ctx: ToolContext): string | undefined {
  const branch = parseTaskId(ctx.taskId).branch;
  // `undefined`, not `root`. The callers need to know "this IS the workspace" in order to
  // skip the read fallback, and answering that by string-comparing two paths would couple
  // them to whether this function happens to return the argument it was given or a
  // resolved copy of it.
  if (branch.segments.length === 0) return undefined;
  // Through `assertWithin` so the derived directory is PROVEN to be inside the workspace
  // and outside every denied subtree, rather than assumed to be by an argument about
  // which characters `SAFE_ID` allows. The argument is true today; the check stays true
  // if `SAFE_ID` widens, and it costs one call per tool invocation.
  return assertWithin(root, join(BRANCH_DIR, encodeBranch(branch).replaceAll("/", "+")), deny);
}

/**
 * The deny-list, resolved ONCE against the workspace root.
 *
 * `assertWithin` resolves a relative deny entry against whatever root it is given, and
 * the root it is given is now the BRANCH's. So without this, `deny: [".loom"]` would name
 * `<workspace>/.loom` for the root branch and `<workspace>/.branches/root+fo[0]/.loom` for
 * a branch: one configured entry, a different directory per caller.
 *
 * **THIS IS NOT WHAT KEEPS THE JOURNAL OUT OF A BRANCH'S REACH, and an earlier version of
 * this comment claimed it was.** A branch's jail root does not contain `<workspace>/.loom`
 * at all, so every spelling of the real journal — `../../.loom/journal.db`, or a symlink
 * to it planted in the branch's own directory — is refused by CONTAINMENT, one step before
 * the deny-list is consulted; the test named for that asserts the containment message
 * precisely so this stays true rather than becoming a second claim about the same wall.
 * Resolving here is narrower than that: it makes a configured entry mean ONE directory
 * instead of one per task, which is a claim-drift bound, not a stronger boundary. Its only
 * behavioural effect is on a branch's own `<branch>/.loom`, which it leaves writable.
 */
function resolvedDeny(opts: BuiltinOptions): readonly string[] {
  return opts.deny.map((d) => resolve(opts.root, d));
}

/**
 * Open the leaf WITHOUT following a symlink, and read or write through the descriptor.
 *
 * `assertWithin` has already resolved every link and proved the result is inside the
 * jail, so by the time this runs the path names a real location. What it cannot promise
 * is that the location is still the same one a syscall later: a check and an `open` are
 * two operations, and between them a name can be replaced by a link. `O_NOFOLLOW` makes
 * that swap fail (ELOOP) rather than succeed somewhere else. It costs nothing in the
 * ordinary case — a path with no links left in it has no link for the flag to refuse —
 * and it narrows the race to the directory components, which no flag Node exposes can
 * close. Where the platform does not define the flag, the jail is exactly as strong as
 * `assertWithin` alone.
 */
function openLeaf(path: string, flags: number): number {
  return openSync(path, flags | NOFOLLOW, 0o666);
}

/** Absent on platforms without the flag (Windows), which have no FIFO to block on either. */
const NONBLOCK = constants.O_NONBLOCK ?? 0;

/**
 * Not a platform errno: this file's own name for "something is at this path and it is not a
 * regular file". `UNREADABLE_ERRNO` lists it, so `fs.read` answers `E_FS_UNREADABLE` for it.
 */
const NOT_REGULAR = "ENOTREG";

/**
 * READ A REGULAR FILE, AND REFUSE ANYTHING ELSE BEFORE IT CAN BLOCK (`TODO.md` §A.97).
 *
 * A blocking `open(O_RDONLY)` of a FIFO waits for a writer that may never come, and the task
 * has no bound below the node's `timeoutMs` — measured on the shipped `grant-access` with
 * `mkfifo out/access-ledger.json`: the run hung until a 10 s alarm killed it. The same wait
 * sits behind a character device (`/dev/zero` never ends) and a socket. So the open is
 * NON-BLOCKING, which returns at once for a FIFO with no writer, and the descriptor is
 * `fstat`ed before a byte is read: what is not a regular file is refused.
 *
 * AND WHEN THE OPEN ITSELF FAILS, the name is `lstat`ed to say why, because some kinds never
 * reach the `fstat`: the open fails with an errno that says nothing about what is there — measured
 * on macOS, a unix socket answers errno 102 (`"Unknown system error -102"`) and `/dev/tty`
 * `ENXIO`, so both became the retryable `E_TOOL_SOURCE_UNAVAILABLE` (review of §A.97). Something
 * at the path that is not a regular file is refused by KIND; an absent name keeps `ENOENT`, and a
 * symlink the `O_NOFOLLOW` open refused keeps `ELOOP`. (The `lstat` looks after the open, so a
 * name swapped in between is classified as it now is — the refusal is right either way, since
 * the open did not produce a regular file.)
 *
 * `O_NONBLOCK` changes nothing about a regular file: its reads never block to begin with.
 *
 * A directory is refused with the errno it always had (`EISDIR`); every other kind carries
 * `NOT_REGULAR`. Both read as UNREADABLE — never as NOT FOUND, because something is there. A
 * symlink at the leaf is left to the open, whose `O_NOFOLLOW` refuses it (`ELOOP`, unreadable).
 */
function readRegularLeaf(path: string): string {
  return readRegularBytes(path).toString("utf8");
}

/** `readRegularLeaf`'s bytes, undecoded — what `fs.restore` digests before it removes a file. */
function readRegularBytes(path: string): Buffer {
  let fd: number;
  try {
    fd = openLeaf(path, constants.O_RDONLY | NONBLOCK);
  } catch (e) {
    // The open failed: say what is there when it is not a regular file, rather than pass on an
    // errno that names nothing (see above). Absent, or a symlink the open refused, keeps its own.
    const seen = lstatSync(path, { throwIfNoEntry: false });
    if (seen !== undefined && !seen.isFile() && !seen.isSymbolicLink()) throw notRegular(seen);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw notRegular(st);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The refusal for something at the path that is not a regular file, naming what it is. */
function notRegular(st: { isDirectory(): boolean; isFIFO(): boolean; isSocket(): boolean; isCharacterDevice(): boolean; isBlockDevice(): boolean }): Error {
  const directory = st.isDirectory();
  const kind = directory
    ? "a directory"
    : st.isFIFO()
      ? "a FIFO"
      : st.isSocket()
        ? "a socket"
        : st.isCharacterDevice()
          ? "a character device"
          : st.isBlockDevice()
            ? "a block device"
            : "not a regular file";
  const code = directory ? "EISDIR" : NOT_REGULAR;
  return Object.assign(new Error(`${code}: ${kind}, not a regular file; refusing to read it`), { code });
}

/** The digest `fs.write` records for a file it CREATED, and `fs.restore` checks before removing it. */
function bytesDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * WHO THE CREATED FILE IS — recorded at write time, checked before `fs.restore` removes anything.
 *
 * A relative path re-resolved at restore time plus a digest of the bytes did NOT identify the file
 * (review of §A.99): a symlink planted at the path, or a parent directory swapped for one, made
 * the undo delete whatever the link pointed at if its bytes matched; a second run writing the same
 * bytes over the first run's file made the first run's rollback delete the second's; and a caller
 * passing `{created: true, wrote: <digest of any file>}` deleted any file in the jail.
 *
 * So the write records the file ITSELF: the device and inode the create produced. Strings,
 * because a journal holds JSON and these are 64-bit.
 *
 * NOT ITS CHANGE TIME, and that is the maintainer's rule rather than an omission (Q3: "delete,
 * refusing if the bytes differ"). A change time moves on every later write, so it refused the
 * run's OWN rollback: create then overwrite one path in one run, and the reverse rollback first
 * puts the create's bytes back — which moves the change time — and then the create's undo
 * refused a file whose bytes were exactly what it wrote, leaving it standing. The consequence of
 * dropping it is recorded, not guarded: a second run that overwrote this run's file with the SAME
 * bytes is removed by this run's rollback, since the file is then the inode this run created
 * holding exactly the bytes this run wrote (residue).
 */
interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
}

function identityOf(st: { readonly dev: bigint; readonly ino: bigint }): FileIdentity {
  return { dev: String(st.dev), ino: String(st.ino) };
}

function isIdentity(v: unknown): v is FileIdentity {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return ["dev", "ino"].every((k) => typeof o[k] === "string" && /^\d{1,40}$/.test(o[k] as string));
}

/** What an existing path held before an overwrite — `previous` only when it was a readable regular file. */
function priorAt(path: string): { readonly previous?: string; readonly created: false } {
  try {
    return { previous: readRegularLeaf(path), created: false };
  } catch {
    return { created: false };
  }
}

/**
 * Write the body, and hand back the `details` fields that let `fs.restore` undo it.
 *
 * `fs.restore` builds its arguments from the write's recorded `details` (`detailsOf` in
 * `run/engine.ts`), so whatever it will need is decided and journaled HERE, at write time — a
 * look at the disk at restore time would answer a different question after a restart, and on
 * replay would answer nothing.
 *
 * THE CREATE IS THE OPEN, NOT A LOOK BEFORE IT. The first open is `O_CREAT | O_EXCL`: if it
 * succeeds this call made the file, and the record says `created: true` with the file's identity
 * and a digest of the bytes; if it fails `EEXIST`, something was already there and this is an
 * overwrite — `previous` is what it held when it was a readable regular file, and nothing at all
 * otherwise, so its undo refuses. No window lies between deciding "created" and creating.
 */
function writeWithUndo(
  path: string,
  body: string,
): { readonly previous?: string; readonly created: boolean; readonly wrote?: string; readonly identity?: FileIdentity } {
  const bytes = Buffer.from(body, "utf8");
  let fd: number;
  try {
    fd = openLeaf(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") throw e;
    const prior = priorAt(path);
    writeLeaf(path, body);
    return prior;
  }
  let identity: FileIdentity;
  try {
    writeFileSync(fd, bytes);
    identity = identityOf(fstatSync(fd, { bigint: true }));
  } finally {
    closeSync(fd);
  }
  return { created: true, wrote: bytesDigest(bytes), identity };
}

/** Create-or-truncate and write, through a descriptor the OS opened without following. */
function writeLeaf(path: string, body: string): void {
  const fd = openLeaf(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
  try {
    writeFileSync(fd, body, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function builtinTools(opts: BuiltinOptions): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [fsRead(opts), fsWrite(opts), fsEdit(opts), fsGlob(opts), fsGrep(opts)];
  if ((opts.egressAllowlist ?? []).length > 0) tools.push(netFetch(opts));
  if ((opts.execAllowlist ?? []).length > 0) tools.push(procExec(opts));
  return tools;
}

/**
 * Run one allow-listed program, argv-only, inside the branch's directory.
 *
 * `runSandboxed` has been in this tree — hardened, with four listeners that may not throw
 * and a SIGTERM→grace→SIGKILL path measured against a child that never exits — with **zero
 * callers**. This is its first. Until now a graph could read files, write files, and fetch a
 * URL, and could not run anything, which is the gap between "a walking skeleton" and a
 * framework someone deploys an agent with.
 *
 * THE ALLOWLIST IS THE WHOLE BOUNDARY, and it is a different KIND of boundary from the one
 * above. `fs.read` and `fs.write` are contained by `assertWithin`, which works because the
 * argument's meaning is known here — a path is a path. A subprocess has no such property:
 * once `sh` is reachable, every containment in this file is advisory, because the child
 * reads `.loom/journal.db` with its own open() and never passes through `resolvedDeny`. So
 * the check that matters is *which binary*, made before the spawn, and there is nothing
 * downstream that recovers it.
 *
 * It therefore follows `egressAllowlist` exactly: **no default, and an empty list means the
 * tool is not registered at all.** An embedder who has not thought about which programs a
 * model may run gets a system that cannot run programs. That asymmetry is deliberate — the
 * `deny` docstring above records what an inherited default already cost this file once.
 *
 * `irreversible`, so `CLASS_DEFAULT_POSTURE` puts it at `in` — a human gate by default — and
 * `CLASS_AUTO_RETRYABLE` refuses to retry it. Both are right and neither is conservative
 * padding: the engine cannot know whether the argv it is re-running appends to a file, and
 * a tool that declared itself `reversible_write` would need `fs.restore`'s equivalent for
 * arbitrary programs, which does not exist and cannot.
 *
 * The environment is **empty unless named**. `buildEnv` drops everything not in `envAllow`,
 * so a provider key in the orchestrator's environment does not reach the child by default.
 */
function procExec(opts: BuiltinOptions): ToolDefinition {
  const allow = opts.execAllowlist ?? [];
  return {
    name: "proc.exec",
    version: "1.0",
    description: `Run one allow-listed program with arguments. Allowed: ${allow.join(", ")}.`,
    capabilities: ["proc:exec"],
    irreversibility: "irreversible",
    idempotent: false,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: `Program to run. One of: ${allow.join(", ")}.` },
        args: { type: "array", items: { type: "string" }, description: "Arguments, passed as an array — never a shell string." },
        timeoutMs: { type: "integer", default: 30_000 },
        stdin: { type: "string" },
      },
      required: ["command"],
    },
    execute: async (args, ctx) => {
      const command = String(args["command"]);
      // Exact match on the name, not a prefix and not a path. A prefix test admits
      // `gitk`, and accepting a path admits `./git` — a file the model just wrote with
      // `fs.write`, which would turn the allowlist into a formality.
      if (!allow.includes(command)) {
        return { content: `proc.exec: "${command}" is not allow-listed. Allowed: ${allow.join(", ")}.`, isError: true };
      }
      const raw = args["args"] ?? [];
      if (!Array.isArray(raw) || raw.some((a) => typeof a !== "string")) {
        return { content: "proc.exec: `args` must be an array of strings.", isError: true };
      }
      const deny = resolvedDeny(opts);
      // The branch's directory, for the same reason writes go there: two fan-out branches
      // running the same command must not share a working directory.
      const cwd = branchRoot(opts.root, deny, ctx) ?? opts.root;
      mkdirSync(cwd, { recursive: true });
      const stdin = args["stdin"];
      const result = await runSandboxed(
        {
          command,
          args: raw as readonly string[],
          cwd,
          timeoutMs: Number(args["timeoutMs"] ?? 30_000),
          ...(opts.execEnvAllow === undefined ? {} : { envAllow: opts.execEnvAllow }),
          ...(typeof stdin === "string" ? { stdin } : {}),
        },
        ctx.signal,
      );
      // A non-zero exit is a RESULT, not a tool failure: the model asked to run a program
      // and the program ran, so a failing build is an answer rather than a broken call.
      //
      // A TIMEOUT does not arrive here at all — `runSandboxed` throws `E_TOOL_TIMEOUT`
      // (subprocess.ts:855-860) rather than returning with `timedOut` set, so the flag on
      // `SandboxResult` is unreachable from this path. Letting the throw propagate is also
      // the better answer: it is a typed `LoomError` carrying `retryable`, and this tool's
      // `irreversible` class already means `CLASS_AUTO_RETRYABLE` will not act on it.
      const head = `exit=${String(result.code ?? "null")}${result.signal === null ? "" : ` signal=${result.signal}`}`;
      const body = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
      // A capped output is `details.truncated`, never a marker appended to `content` (§A.83,
      // `capBytes`). `bytes` is not reported: the sandbox discards what it does not keep, so the
      // size of the whole output is not known here.
      return {
        content: `${head}\n${body}`,
        details: {
          command,
          code: result.code,
          signal: result.signal,
          ms: result.ms,
          truncated: result.truncated,
        },
      };
    },
  };
}

/**
 * Where a READ looks, which is not simply the branch's own directory.
 *
 * Branch first, then the shared workspace. The fallback is not a convenience: a fan-out
 * over a list of filenames is the ordinary shape of this feature, and every one of those
 * branches reads a file the operator put in the workspace before the run started. Without
 * the fallback, confining writes would break every such graph — a larger regression than
 * the clobber being closed.
 *
 * The two lookups are NOT symmetric and that asymmetry is the point: a write goes to the
 * branch and only the branch, so nothing a branch does is visible to a sibling, while a
 * read sees the branch's own copy shadowing the shared one. That is an overlay, and it
 * has the property a graph author needs — write-then-read inside one branch returns what
 * this branch wrote, not what a sibling did.
 *
 * `existsSync` decides the layer, and it is a TOCTOU by construction: the file can vanish
 * between the check and the open. The consequence is bounded — the open then fails and
 * the tool returns `isError` — because both candidates were already proven inside the
 * jail. The check picks a layer; it is not what enforces containment.
 */
function readPath(opts: BuiltinOptions, ctx: ToolContext, rel: string): string {
  const deny = resolvedDeny(opts);
  const branch = branchRoot(opts.root, deny, ctx);
  if (branch === undefined) return assertWithin(opts.root, rel, deny);
  const mine = assertWithin(branch, rel, deny);
  return existsSync(mine) ? mine : assertWithin(opts.root, rel, deny);
}

/** Where a WRITE lands: the branch's own directory, with no fallback. */
function writePath(opts: BuiltinOptions, ctx: ToolContext, rel: string): string {
  const deny = resolvedDeny(opts);
  return assertWithin(branchRoot(opts.root, deny, ctx) ?? opts.root, rel, deny);
}

/**
 * The errno values that mean "something IS at this path and it cannot be read as a file".
 *
 * NAMED, and deliberately not "everything that is not ENOENT". What is left out — `EIO`,
 * `EMFILE`, `ENFILE`, `EAGAIN`, `ENAMETOOLONG`, anything a platform adds — stays UNTYPED, which
 * `#runToolNode` turns into `E_TOOL_SOURCE_UNAVAILABLE`: retryable, and still not "absent".
 * Either way it is not `E_FS_NOT_FOUND`, and that is the only code an `error` arm may read as
 * "there is nothing here".
 */
const UNREADABLE_ERRNO: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EISDIR", "ENOTDIR", "ELOOP", NOT_REGULAR]);

/**
 * THREE OUTCOMES THAT WERE ONE (`DESIGN.md` D8, `TODO.md` §A.90).
 *
 * This returned `{content: "cannot read …", isError: true}` for every failure, and
 * `#runToolNode` turned an untyped `isError` into `E_TOOL_SOURCE_UNAVAILABLE` — so a file that
 * does not exist, a file that exists and may not be read, and (one function up) a path the jail
 * refuses were ONE code, and an `error` arm written for the first silently handled the other
 * two. `examples/graphs/grant-access.json` rebuilt its access ledger from nothing on exactly
 * that, exit 0. The code now says which, and it reaches the arm through the node's reserved
 * error projection (`graph/spec.ts`, `ErrorProjection`).
 *
 * The message is unchanged, so a model reading `content` is told the same thing it always was.
 */
function readFailure(rel: string, e: unknown): ToolResult {
  const errno = (e as NodeJS.ErrnoException | undefined)?.code;
  const content = `cannot read ${rel}: ${(e as Error).message}`;
  const details = { path: rel, errno: String(errno) };
  if (errno === "ENOENT") return { content, isError: true, error: err.notFound(CODES.E_FS_NOT_FOUND, content, { details }) };
  if (errno !== undefined && UNREADABLE_ERRNO.has(errno)) {
    return { content, isError: true, error: err.policy(CODES.E_FS_UNREADABLE, content, { details }) };
  }
  return { content, isError: true };
}

/**
 * A SHORT READ IS A FACT BESIDE THE CONTENT, NEVER A MARKER INSIDE IT (`DESIGN.md` D8, `TODO.md`
 * §A.83).
 *
 * `fs.read`, `net.fetch` and `proc.exec` each appended their marker to `content` —
 * `…[truncated N chars]`, `…[truncated]`, `…[output truncated]` — and a `tool` node writes
 * `content` to its channel. So a capped JSON document reached the next body as a syntax error in
 * the FILE, and a format whose prefix still parses reached it as a whole document with part of it
 * missing, which is worse: a search for absences reads the missing part as compliance. The text is
 * now the prefix and nothing else; `truncated` and `bytes` go into `details`, which the journal
 * keeps and the fold turns into the node's reserved projection (`"<id>:error"` → `{ok: true,
 * truncated, bytes}`), where a body can read them without parsing anything.
 *
 * `max` COUNTS BYTES, as `maxBytes` always said and `bytes` always claimed. It compared
 * `text.length` — UTF-16 units — so a file of multi-byte text read back `bytes` that were not its
 * size and a cap that was not the one asked for. The cut is moved back to a UTF-8 character
 * boundary, so the prefix never ends in half a character (it may be up to three bytes short of
 * `max`); `bytes` is the size of the WHOLE source. The step back is at most three bytes — the
 * most a UTF-8 character can put past its first byte — so input that is not UTF-8 (a run of
 * continuation bytes) is cut at `max - 3` or later, never emptied.
 *
 * WHAT A MODEL IS TOLD: an agent's transcript is built from `content`, so the note that the text
 * is short is added there and only there, from these `details` (`modelToolContent` in
 * `run/engine.ts`) — never to `content`, which is what reaches a channel.
 */
function capBytes(all: Buffer, max: number): { readonly text: string; readonly bytes: number; readonly truncated: boolean } {
  if (!(all.length > max)) return { text: all.toString("utf8"), bytes: all.length, truncated: false };
  let end = Math.max(0, Math.floor(max));
  // A continuation byte (10xxxxxx) at the cut means a character straddles it: step back to its
  // first byte and leave the whole character out.
  const floor = Math.max(0, end - 3);
  while (end > floor && (all[end]! & 0xc0) === 0x80) end -= 1;
  return { text: all.subarray(0, end).toString("utf8"), bytes: all.length, truncated: true };
}

function fsRead(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.read",
    version: "1.0",
    description: "Read a UTF-8 text file from the workspace.",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        maxBytes: { type: "integer", default: 200_000 },
      },
      required: ["path"],
    },
    execute: (args, ctx) => {
      let path: string;
      try {
        path = readPath(opts, ctx, String(args["path"]));
      } catch (e) {
        // THE JAIL'S REFUSAL IS RETURNED, NOT THROWN, and that is what makes it a fact. A throw
        // out of `execute` becomes `effect.failed`, loses its code at `#invokeTool`'s catch
        // (`E_TOOL_SOURCE_UNAVAILABLE`, the collapse §A.90 is about), and is refused by replay
        // as a divergence. Returned, it is `effect.completed` with its code on it: replayable,
        // and an `error` arm can tell "refused" from "absent". Only the jail's own code is
        // caught — anything else is a bug above this file and keeps failing loudly.
        if (isLoomError(e) && e.code === CODES.E_CAP_DENIED) return { content: e.message, isError: true, error: e };
        throw e;
      }
      let bytes: Buffer;
      try {
        bytes = readRegularBytes(path);
      } catch (e) {
        return readFailure(String(args["path"]), e);
      }
      const cut = capBytes(bytes, Number(args["maxBytes"] ?? 200_000));
      return { content: cut.text, details: { path: String(args["path"]), bytes: cut.bytes, truncated: cut.truncated } };
    },
  };
}

function fsWrite(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.write",
    version: "1.0",
    description: "Write a UTF-8 text file into the workspace, creating directories as needed.",
    capabilities: ["fs:write"],
    // Reversible only because `fs.restore` exists to undo it; without a declared
    // compensation this would have to be `irreversible` and gate by default.
    irreversibility: "reversible_write",
    idempotent: true,
    compensation: { tool: "fs.restore" },
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, body: { type: "string" } },
      required: ["path", "body"],
    },
    execute: (args, ctx) => {
      const rel = String(args["path"]);
      const path = writePath(opts, ctx, rel);
      mkdirSync(dirname(path), { recursive: true });
      // Capture what stood at the path so `fs.restore` can put it back — or, when nothing did,
      // record the CREATE so it can remove the file (§A.99). A declared compensation that
      // cannot actually compensate is worse than none.
      const undo = writeWithUndo(path, String(args["body"]));
      return {
        content: `wrote ${rel}`,
        // `path` stays the RELATIVE path the graph asked for, in both `details` and
        // `writes`: `writes.written` becomes a channel value that a downstream node and a
        // human both read, and a branch-qualified path there would make the same node
        // write a different value on every branch of a fan-out. Where the bytes actually
        // landed is `at`, which is diagnostic and reported beside it rather than in place
        // of it — the same rule `net.fetch` follows for the host that answered.
        // `details.bytes` COUNTS BYTES — what landed on disk — because `details` reach the reserved
        // projection (§A.83), where `bytes` means bytes. It was the body's UTF-16 length. The
        // CHANNEL receipt `writes.written.bytes` keeps the UTF-16 count it always had: it is a
        // channel value shipped graphs already carry (`examples-triage.test.ts` pins it), and
        // changing what a channel holds is not this fix.
        details: { path: rel, bytes: Buffer.byteLength(String(args["body"]), "utf8"), ...undo, at: path },
        writes: { written: { path: rel, bytes: String(args["body"]).length } },
      };
    },
  };
}

/**
 * Replace a span in a file, without making the model reproduce the parts it is not changing.
 *
 * `fs.write` is the only edit primitive Loom had, and for editing it is the wrong one: it
 * costs output tokens proportional to the FILE rather than to the change, and it fails by
 * silently dropping whatever the model paraphrased on the way through. This is the primitive
 * an agent actually needs, and its one hard problem is that a model reconstructs `find` from
 * memory and gets the whitespace wrong — which `locateEdit` answers by relaxing whitespace
 * and escaping and nothing else.
 *
 * THE THREE REFUSALS ARE THE FEATURE. `ambiguous` (the span occurs twice), `disproportionate`
 * (the located span is far larger than what was asked for) and `not-found` all change
 * nothing and say so. A fuzzy-match edit tool that guesses is how a change lands in the
 * wrong function, and the file it lands in is one the human asked it to be careful with.
 *
 * `reversible_write` with `fs.restore` as its compensation, on the same terms as `fs.write`:
 * the prior content is captured BEFORE the write, because a declared compensation that
 * cannot actually compensate is worse than none.
 *
 * Reads through `readPath` (branch overlay, then workspace) and writes through `writePath`
 * (branch only). That asymmetry is inherited deliberately: an edit in a fan-out branch sees
 * the shared file if it has not touched it yet, and its result is visible to nobody else.
 */
function fsEdit(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.edit",
    version: "1.0",
    description:
      "Replace an exact span of a UTF-8 text file. Whitespace and escaping are matched leniently; " +
      "the edit is REFUSED if the span is ambiguous, disproportionate, or absent.",
    // Both, and the read half is not incidental: the ladder needs the current bytes to
    // locate the span, so this tool reads every file it writes.
    capabilities: ["fs:read", "fs:write"],
    irreversibility: "reversible_write",
    // A second identical edit finds `find` already replaced and refuses with `not-found`.
    // That is a refusal rather than a no-op, so re-running is not free and this is false.
    idempotent: false,
    compensation: { tool: "fs.restore" },
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        find: { type: "string", description: "The exact text to replace." },
        replace: { type: "string", description: "What to put in its place." },
        replaceAll: { type: "boolean", default: false, description: "Replace every occurrence rather than refusing an ambiguous one." },
      },
      required: ["path", "find", "replace"],
    },
    execute: (args, ctx) => {
      const rel = String(args["path"]);
      const find = String(args["find"]);
      const replace = String(args["replace"]);
      const replaceAll = args["replaceAll"] === true;

      // OUTSIDE the try. (`fs.read` now RETURNS the same refusal with `E_CAP_DENIED` on it rather
      // than throwing — `DESIGN.md` D8 — which keeps it a refusal by its CODE; this tool still
      // throws, so here it still ends as `effect.failed`.) `assertWithin` throws
      // `E_CAP_DENIED`, and that is a containment refusal, not a failed read: catching it
      // here would hand the model an ordinary tool error it is free to retry with a
      // different spelling, and would report a jail escape as a missing file.
      const readFrom = readPath(opts, ctx, rel);
      const path = writePath(opts, ctx, rel);

      let current: string;
      try {
        // Through `readRegularLeaf` for `fs.read`'s reason (§A.97): a FIFO here blocked too.
        current = readRegularLeaf(readFrom);
      } catch (e) {
        return { content: `cannot read ${rel}: ${(e as Error).message}`, isError: true };
      }

      const match = locateEdit(current, find, replaceAll);
      // `locateEdit` enforces uniqueness on its RELAXED rungs but not on the exact one —
      // it reports `{kind: "exact", count}` for a span occurring any number of times. Left
      // unchecked, `String.replace` then edits the FIRST occurrence and reports success,
      // which is the silent partial edit this tool exists to make impossible. The count is
      // right there in the result; refusing on it costs one line.
      if (match.kind === "exact" && match.count > 1 && !replaceAll) {
        return {
          content:
            `fs.edit: the text occurs ${String(match.count)} times in ${rel} — ` +
            `give more surrounding context, or pass replaceAll`,
          isError: true,
        };
      }
      if (match.kind === "not-found") {
        return { content: `fs.edit: no match for the given text in ${rel}`, isError: true };
      }
      if (match.kind === "ambiguous") {
        return {
          content: `fs.edit: the text matches more than one place in ${rel} — give more surrounding context, or pass replaceAll`,
          isError: true,
        };
      }
      if (match.kind === "disproportionate") {
        return {
          content: `fs.edit: the closest match in ${rel} is far larger than the text given, so it is refused rather than guessed`,
          isError: true,
        };
      }

      const span = match.span;
      // SPLICED BY INDEX, NOT `String.replace`, so the bytes written are the bytes asked for.
      // `replace` is model-authored text and `String.replace` reads `$&`, `` $` ``, `$'`, `$1`
      // and `$<name>` in it as SUBSTITUTION PATTERNS — all of which are ordinary content: `$'…'`
      // is shell ANSI-C quoting, `$&` is a regex replacement an agent is itself writing, `$1` is
      // a positional. Measured on `let cost = OLD;` with `find: "OLD"`, `replace: "$'y"` wrote
      // the whole rest of the file back into the line and returned success with `isError` unset.
      // The `replaceAll` arm is `split`/`join`, which is already literal, so the same tool had
      // two contradictory semantics selected by a boolean the model chooses.
      //
      // `indexOf` cannot miss: `locateEdit` returns `exact` only when `content.split(find)`
      // found the span and `relaxed` only after an explicit `content.indexOf(search) !== -1`.
      const at = current.indexOf(span);
      const updated = replaceAll
        ? current.split(span).join(replace)
        : current.slice(0, at) + replace + current.slice(at + span.length);
      const occurrences = replaceAll ? current.split(span).length - 1 : 1;

      // The write goes to the BRANCH path even though the read may have come from the
      // workspace. That is the overlay working as designed: the branch gets its own copy
      // carrying the edit, and the shared file is untouched.
      mkdirSync(dirname(path), { recursive: true });
      // Captured from the WRITE path, not from `current`: on the first edit in a branch
      // `current` came from the shared workspace file, and restoring that content to the
      // branch path would fabricate a file that never existed there. That first edit therefore
      // CREATES the branch copy, and is recorded as a create (§A.99): its undo removes the copy.
      const undo = writeWithUndo(path, updated);
      return {
        content: `edited ${rel} (${match.kind}${match.kind === "relaxed" ? `: ${match.strategy}` : ""}, ${String(occurrences)} occurrence${occurrences === 1 ? "" : "s"})`,
        details: { path: rel, match: match.kind, occurrences, bytes: Buffer.byteLength(updated, "utf8"), ...undo, at: path },
        writes: { written: { path: rel, bytes: updated.length } },
      };
    },
  };
}

/** Results past this are dropped, and the drop is stated in the content. */
const SEARCH_RESULT_CAP = 100;

/**
 * Wall-clock one search call may spend INSIDE regex matching, after which it refuses.
 *
 * THE RESULT CAPS WERE NEVER A BOUND ON THIS. `SEARCH_RESULT_CAP` and `GREP_FILE_CAP` bound how
 * many lines are scanned; neither bounds how long ONE `re.test(line)` takes, and that is where
 * the cost lives. `fs.grep` compiles `new RegExp(model_string)` and `fs.glob` compiles a
 * model-written glob, so a catastrophically-backtracking pattern is one tool argument away.
 * Measured at a638e7d, one file holding `"a" * n + "!"` and the pattern `(a+)+$`:
 *
 *     n = 24 →     876 ms      n = 28 →  14,105 ms
 *     n = 26 →   3,506 ms      n = 30 →  56,354 ms
 *
 * — roughly 4x per two characters, so n = 45 is hours. Node is single-threaded and this ran in a
 * SYNCHRONOUS `execute`, so nothing could interrupt it: the engine's node deadline is a
 * `Promise.race` on the same thread and an `AbortSignal` callback is queued behind the regex. A
 * 200 ms timer armed before the call had still not fired when it returned. Under `loom serve`
 * that is every run, the HTTP control plane, the gate SLA clock and `loom cancel` at once, which
 * is the goal's "watch it, stop it" gone. The docstring below used to assert the opposite.
 *
 * 2 s, AND THE NUMBER IS THE ORDINARY CASE'S, NOT THE ATTACK'S. Measured over this repo's own
 * `packages/core/src` — 62 files, 3.6 MB — a whole-tree `fs.grep "export function"` takes 8.8 ms
 * end to end, file reads included, and `fs.glob "**` + `/*.ts"` takes 1.2 ms. The budget is
 * therefore more than two orders of magnitude above everything a real search does, let alone the
 * matching alone. A search that needs more than two seconds of BACKTRACKING is not a search.
 *
 * WHAT THIS COSTS, re-measured over the same 62 files on 2026-09-03, best of three at 20
 * iterations, against the unbounded `a638e7d`:
 *
 *                                   a638e7d   unbatched   batched
 *     fs.grep "export function"      5.37 ms    8.27 ms    7.41 ms
 *     fs.grep + include "**​/*.ts"    5.31 ms    9.81 ms    7.34 ms
 *     fs.glob "**​/*.ts"              0.34 ms    0.58 ms    0.55 ms
 *
 * — about 1.4x for `fs.grep`, which is what a bound that arms a watchdog per batch costs.
 *
 * AND THE BUDGET IS NOT A FILE-COUNT LIMIT, which is what the middle column was on a large
 * workspace: see `GREP_LINE_BATCH` for the 60,000-file measurement where an ordinary literal
 * pattern was REFUSED, and for why both of `fs.grep`'s call sites had to be batched to fix it.
 *
 * WHAT IT DOES NOT BUY: the loop is still BLOCKED while a search runs — `execute` is synchronous
 * and this bounds the block rather than removing it. The bound is on MATCHING, not on the whole
 * call: walking a tree and reading its files is outside it, so the worst block a pathological
 * pattern can impose is the budget PLUS the traversal, and the traversal is a cost the ordinary
 * search on that tree pays too. Measured on the 60,000-file tree: `(a+)+$` refuses after
 * 4,384 ms, of which ~1,450 ms is the same walk a successful `fs.grep` of that tree spends.
 * Removing the block entirely means moving the scan to a worker thread, which is a bigger change
 * than this one and is not what the finding was about. Bounded and stoppable was.
 */
const MATCH_BUDGET_MS = 2_000;

/**
 * The scan, as a script `node:vm` can TERMINATE.
 *
 * THIS IS NOT `vm` USED AS A SANDBOX. CLAUDE.md is right that it is not one, and nothing here is
 * being isolated — the regex, the strings and this source are all ours. What `vm` uniquely
 * provides is `timeout`, the one mechanism in Node that interrupts SYNCHRONOUS execution, which
 * is exactly what a backtracking regex is. `resources/functions.ts` already depends on the same
 * property for the same reason, and it is verified here rather than assumed: driven against
 * `(a+)+$` and a 34-character line, `runInContext(…, {timeout: 200})` threw
 * `ERR_SCRIPT_EXECUTION_TIMEOUT` after 202 ms.
 *
 * A BATCH OF STRINGS PER CALL, not one call per string, and the two constants below say what a
 * call costs. `runInContext` with a `timeout` is 43 µs of fixed cost (it arms a watchdog), so
 * per-line calls would be 43 µs A LINE — three orders of magnitude over the match itself — for
 * no extra safety, since the budget is a total either way.
 *
 * `re` AND `lines` ARE HOISTED INTO LOCALS, which is not a style preference. They are globals of
 * a contextified sandbox, so every read of them inside the loop goes through the context's
 * interceptor rather than a slot. Measured over 90,000 lines: 13.10 ms reading the globals per
 * iteration, 1.20 ms with them hoisted, against 0.80 ms for the identical loop on the host. That
 * is the difference between this bound costing 6x and costing 1.5x.
 */
const SCAN_SCRIPT = new Script(
  "(() => { const L = lines, R = re, out = []; for (let i = 0; i < L.length; i++) { if (R.test(L[i])) out.push(i); } return out; })()",
  { filename: "loom:bounded-match" },
);

/**
 * Paths a search accumulates before spending one match call on them.
 *
 * `fs.glob` sees one path per `visit`, so without this it would pay the 43 µs fixed cost per
 * FILE. Measured over this repo's `packages/core/src` (62 files), unbuffered
 * `fs.glob "**​/*.ts"` cost 22.6 ms against a 0.8 ms baseline; buffered it is 1.4 ms.
 *
 * IT DELAYS `capped` BY A WHOLE BATCH, WHICH IS NOT "a few more paths" — the sentence that stood
 * here. `capped` is only observable at a flush, so a search that hits `SEARCH_RESULT_CAP` walks to
 * the end of the current buffer first. COUNTED, not reasoned about, on a 60,000-file tree of
 * two-line files, against the same code with both batch constants set to 1:
 *
 *                            walked   read    ms        unbatched: walked   read    ms
 *     fs.glob "**​/*.ts"         512      0   3.7                      101      0   7.9
 *     fs.grep "needle"         1536   1366  32.2                      101    101   9.1
 *
 * Both constants are in `fs.grep`'s number and the attribution matters: `GREP_LINE_BATCH` decides
 * when the CONTENT scan flushes, which is 4,096 lines ≈ 1,366 of these files, and the walk then
 * overshoots to the next multiple of THIS constant, 1,536. So the cap costs ~1,270 extra file
 * READS on that tree and a 3.5x slowdown on `fs.grep`'s capped fast path — while still being a
 * 2x WIN for `fs.glob`, whose cost is the per-call watchdog rather than the reads.
 *
 * Both numbers are tens of milliseconds and neither scales with the workspace, so the trade is
 * worth making; the cost is worth stating, because "a few more paths" reads as a rounding error
 * and 1,366 file reads is not one.
 *
 * SHARED WITH `fs.grep`'s `include` FILTER, which this docstring used to say needed no buffer.
 * That sentence — "`fs.grep` hands a whole file's lines over at once and needs no buffer" — was
 * the defect: it is true of the CONTENT scan and false of the include scan, which is one call
 * per path exactly like `fs.glob`'s. See `GREP_LINE_BATCH` for what it cost.
 */
const GLOB_SCAN_BATCH = 512;

/**
 * Lines `fs.grep` accumulates ACROSS FILES before spending one match call on them.
 *
 * THE PER-CALL COST IS A COST PER FILE WHEN THE FILES ARE SMALL, and a workspace is mostly small
 * files. `matchBudget` charges wall clock, `runInContext` with a `timeout` is a fixed 43-48 µs
 * because it arms a watchdog, and `fs.grep` was making two unbatched calls per file — `scan`
 * for `include` and `scan` for the content. At 60,000 files that is 120,000 watchdogs, ~5.4 s of
 * pure fixed cost against a 2,000 ms budget, so the budget was gone before any real matching
 * happened. MEASURED on a 60,000-file tree of two-line files: `fs.grep {pattern: "zzzzzzzz"}` —
 * a literal string, no `include` — REFUSED with "the pattern is too expensive to run" after
 * 3,289 ms, where the same tree at `a638e7d` answered `(no matches)` in 1,304 ms. An ordinary
 * search was made impossible by the guard that was supposed to bound a pathological one.
 *
 * 4,096, AND THE UNIT IS LINES RATHER THAN FILES because that is what the cost is per. A file
 * contributes as many lines as it has, so one batch is 4,096 lines whether that is one file or
 * four thousand, and the fixed cost lands at ~11 ns per line — at or below what testing a line
 * against a compiled regex costs, which is the point at which it stops being the thing that
 * decides the answer. It is not a bound on memory beyond one batch plus one file, since a file's
 * lines are queued whole and `GREP_FILE_CAP` already bounds a file at 1 MB.
 *
 * THE BUDGET IS STILL A TOTAL, so the catastrophic pattern is still terminated: a batch runs
 * under one `runInContext` timeout of whatever remains, and a pattern that backtracks
 * exponentially exhausts it inside the first batch exactly as it did inside the first file.
 */
const GREP_LINE_BATCH = 4_096;

/** Thrown out of `visit` when a search has spent `MATCH_BUDGET_MS`; caught at the tool's door. */
class MatchBudgetExhausted extends Error {}

/**
 * A matcher that cannot outlive its budget, however the pattern was written.
 *
 * ONE budget per tool CALL, not per file: a per-file deadline multiplies by the file count and
 * is therefore not a bound at all — a workspace of ten thousand files would licence ten thousand
 * times the stall. The remaining budget is what each `runInContext` is given, so the sum over a
 * whole search is the budget itself.
 *
 * `Date.now()` here is a stopwatch and not a recorded value: nothing journals it, no decision
 * folds from it, and `vm`'s own `timeout` reads the same clock. That is why this does not need
 * the injected clock the rest of the runtime insists on.
 */
function matchBudget(): (re: RegExp, lines: readonly string[]) => readonly number[] {
  const sandbox: { re: RegExp | undefined; lines: readonly string[] } = { re: undefined, lines: [] };
  const ctx = createContext(sandbox);
  let remaining = MATCH_BUDGET_MS;
  return (re, lines) => {
    if (lines.length === 0) return [];
    if (remaining <= 0) throw new MatchBudgetExhausted();
    sandbox.re = re;
    sandbox.lines = lines;
    const started = Date.now();
    try {
      return SCAN_SCRIPT.runInContext(ctx, { timeout: Math.max(1, Math.ceil(remaining)) }) as readonly number[];
    } catch (e) {
      // ONLY a timeout becomes exhaustion. Anything else out of a script this file wrote is a
      // real fault and must not be reported to the model as "your pattern was too expensive".
      if ((e as { code?: string }).code === "ERR_SCRIPT_EXECUTION_TIMEOUT") throw new MatchBudgetExhausted();
      throw e;
    } finally {
      remaining -= Date.now() - started;
    }
  };
}

/** The one refusal both searches give when their budget is gone. */
function budgetRefusal(tool: string, pattern: string): ToolResult {
  return {
    content:
      `${tool}: the pattern ${JSON.stringify(pattern)} is too expensive to run — it spent the ` +
      `${String(MATCH_BUDGET_MS)} ms match budget without finishing. Nested quantifiers such as ` +
      `(a+)+ backtrack exponentially; rewrite the pattern or narrow the search with path/include.`,
    isError: true,
  };
}

/** Bytes of any one file `fs.grep` will scan. A match past it is not found, and says so. */
const GREP_FILE_CAP = 1_000_000;

/**
 * Where a SEARCH looks: the branch's own files shadowing the workspace's, same as a read.
 *
 * `readPath` gives one file that answer; a search has to give it to a whole tree. The
 * traversal therefore runs twice — the branch directory, then the workspace — and a relative
 * path found in both is reported once, from the branch. `.branches` is skipped in the
 * workspace pass, or every branch would see every sibling's working files under a path that
 * is real but that no graph ever asked for.
 */
function searchRoots(opts: BuiltinOptions, ctx: ToolContext): { deny: readonly string[]; roots: { base: string; from: string }[] } {
  const deny = resolvedDeny(opts);
  const branch = branchRoot(opts.root, deny, ctx);
  const roots: { base: string; from: string }[] = [];
  if (branch !== undefined && existsSync(branch)) roots.push({ base: branch, from: branch });
  roots.push({ base: opts.root, from: opts.root });
  return { deny, roots };
}

/** Walk every search root, yielding each relative path once, branch shadowing workspace. */
function eachFile(
  opts: BuiltinOptions,
  ctx: ToolContext,
  sub: string | undefined,
  visit: (rel: string, abs: string) => void,
  shouldStop: () => boolean,
): void {
  const { deny, roots } = searchRoots(opts, ctx);
  const seen = new Set<string>();
  for (const { base, from } of roots) {
    if (shouldStop()) return;
    // The sub-path is confined against the ROOT it will be walked under, so `..` cannot
    // step from the branch directory into the workspace or out of either.
    let start: string;
    try {
      start = sub === undefined || sub === "." ? base : assertWithin(base, sub, deny);
    } catch {
      // A sub-path that does not exist under this root simply contributes nothing; the
      // other root may still have it. A genuine escape throws from the caller's own
      // `assertWithin` below, which runs before this.
      continue;
    }
    walk(
      start,
      from,
      { deny, ...(from === opts.root ? { skipDirs: [BRANCH_DIR] } : {}) },
      (rel, abs) => {
        if (seen.has(rel)) return;
        seen.add(rel);
        visit(rel, abs);
      },
      shouldStop,
    );
  }
}

function fsGlob(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.glob",
    version: "1.0",
    description: "Find files by glob pattern (e.g. src/**/*.ts), relative to the workspace root.",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob matched against root-relative POSIX paths. `**` spans directories." },
        path: { type: "string", description: "Subdirectory to search. Defaults to the workspace root." },
      },
      required: ["pattern"],
    },
    execute: (args, ctx) => {
      const sub = args["path"] === undefined ? undefined : String(args["path"]);
      // Outside any try: an escape here is a containment refusal, not an empty result.
      if (sub !== undefined) assertWithin(opts.root, sub, resolvedDeny(opts));

      const re = globToRegExp(String(args["pattern"]));
      const matches: string[] = [];
      let capped = false;
      // BOUNDED, because a glob compiles to a regex too. `globToRegExp` emits no nested
      // quantifier of its own, but `**/` becomes `(?:.*/)?` and a glob repeating it is a chain
      // of optional greedy groups whose backtracking is exponential in the glob length against a
      // deep path — measured, `"**/".repeat(10) + "zz"` against a 30-segment path had not
      // returned after two minutes. One matcher, so `fs.glob` and `fs.grep` cannot disagree.
      const scan = matchBudget();
      const pending: string[] = [];
      const flush = (): void => {
        if (pending.length === 0) return;
        for (const i of scan(re, pending)) {
          if (matches.length >= SEARCH_RESULT_CAP) {
            capped = true;
            break;
          }
          matches.push(pending[i]!);
        }
        pending.length = 0;
      };
      try {
        eachFile(
          opts,
          ctx,
          sub,
          (rel) => {
            pending.push(rel);
            if (pending.length >= GLOB_SCAN_BATCH) flush();
          },
          () => capped,
        );
        flush();
      } catch (e) {
        if (e instanceof MatchBudgetExhausted) return budgetRefusal("fs.glob", String(args["pattern"]));
        throw e;
      }
      matches.sort();
      return {
        content:
          matches.length === 0
            ? "(no matches)"
            : capped
              ? `${matches.join("\n")}\n… (truncated at ${String(SEARCH_RESULT_CAP)} files; narrow the pattern to see more)`
              : matches.join("\n"),
        details: { pattern: String(args["pattern"]), count: matches.length, truncated: capped },
      };
    },
  };
}

/**
 * Grep, with the regex compiled from the model's string.
 *
 * `new RegExp(userInput)` is normally a red flag, and what makes it acceptable here is the match
 * BUDGET, not the file cap and the result cap. This paragraph used to say the opposite — "the
 * cost of a pathological pattern is bounded by the file cap and the result cap rather than
 * unbounded" — and that sentence was false and was the reason nobody looked: those caps bound
 * how many lines are scanned, and the cost of a catastrophic pattern is in ONE `re.test`. See
 * `MATCH_BUDGET_MS` for the measurements and for what the budget does and does not buy.
 *
 * An invalid pattern is a tool error, not a throw — a model that wrote a bad regex should be
 * told so and allowed to fix it, which is the one case where returning `isError` beats raising.
 * An unaffordable pattern is answered the same way, for the same reason.
 */
function fsGrep(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.grep",
    version: "1.0",
    description: "Search file contents by regular expression. Returns path:line:text, read-only.",
    capabilities: ["fs:read"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Subdirectory to search. Defaults to the workspace root." },
        include: { type: "string", description: "Only search files whose path matches this glob." },
        ignoreCase: { type: "boolean", default: false },
      },
      required: ["pattern"],
    },
    execute: (args, ctx) => {
      const sub = args["path"] === undefined ? undefined : String(args["path"]);
      if (sub !== undefined) assertWithin(opts.root, sub, resolvedDeny(opts));

      let re: RegExp;
      try {
        re = new RegExp(String(args["pattern"]), args["ignoreCase"] === true ? "i" : "");
      } catch (e) {
        return { content: `fs.grep: invalid pattern — ${(e as Error).message}`, isError: true };
      }
      const include = args["include"] === undefined ? undefined : globToRegExp(String(args["include"]));

      const hits: string[] = [];
      let capped = false;
      // ONE budget for the whole call, spent across every file and both regexes — the pattern
      // and the `include` glob, since either can be the expensive one.
      const scan = matchBudget();

      // BOTH SCANS ARE BATCHED, for the reason `GREP_LINE_BATCH` gives: a `runInContext` costs
      // 43-48 µs whatever it is asked, so an unbatched call per file makes the budget a
      // FILE-COUNT limit rather than a matching limit. `fs.glob` was batched for exactly this and
      // this tool was left with two unbatched call sites.
      //
      // Paths are buffered, then filtered by `include`, then read; a file's lines join a running
      // buffer that is flushed whole. Traversal ORDER survives both buffers — the paths in a
      // batch keep their walk order and a file's lines are contiguous within it — so the hits
      // come out in the same order they did unbatched, which is what the output claims by
      // printing `path:line:` and never sorting.
      const pendingPaths: { rel: string; abs: string }[] = [];
      const pendingLines: string[] = [];
      const ownerRel: string[] = [];
      const ownerNo: number[] = [];

      const flushLines = (): void => {
        if (capped || pendingLines.length === 0) return;
        for (const i of scan(re, pendingLines)) {
          if (hits.length >= SEARCH_RESULT_CAP) {
            capped = true;
            break;
          }
          hits.push(`${ownerRel[i]!}:${String(ownerNo[i]!)}:${pendingLines[i]!.slice(0, 400)}`);
        }
        pendingLines.length = 0;
        ownerRel.length = 0;
        ownerNo.length = 0;
      };

      const queue = (rel: string, abs: string): void => {
        let text: string;
        try {
          // Bounded before it is scanned: a multi-gigabyte file in the workspace must
          // narrow the results, not exhaust the process.
          // `walk` yields regular files only, by DIRENT type; the name can be swapped for a FIFO
          // between that listing and this open, which `readRegularLeaf` refuses without blocking.
          text = readRegularLeaf(abs).slice(0, GREP_FILE_CAP);
        } catch {
          return;
        }
        // A NUL in the first chunk means binary; scanning it produces noise, not matches.
        if (text.includes("\u0000")) return;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          pendingLines.push(lines[i]!);
          ownerRel.push(rel);
          ownerNo.push(i + 1);
        }
        // Checked after a whole file rather than inside the loop, so one file's lines are never
        // split across two calls — which keeps a hit's line number and its text together without
        // any bookkeeping, and costs at most one file's lines of extra buffer.
        if (pendingLines.length >= GREP_LINE_BATCH) flushLines();
      };

      const flushPaths = (): void => {
        if (pendingPaths.length === 0) return;
        const batch = pendingPaths.splice(0);
        // NO `include`, NO CALL. The common shape is a search with no path filter at all, and
        // spending a watchdog per batch to learn that every path passes is pure cost.
        if (include === undefined) {
          for (const p of batch) {
            if (capped) return;
            queue(p.rel, p.abs);
          }
          return;
        }
        const keep = new Set(scan(include, batch.map((p) => p.rel)));
        for (let i = 0; i < batch.length; i++) {
          if (capped) return;
          if (keep.has(i)) queue(batch[i]!.rel, batch[i]!.abs);
        }
      };

      try {
        eachFile(
          opts,
          ctx,
          sub,
          (rel, abs) => {
            pendingPaths.push({ rel, abs });
            if (pendingPaths.length >= GLOB_SCAN_BATCH) flushPaths();
          },
          () => capped,
        );
        flushPaths();
        flushLines();
      } catch (e) {
        if (e instanceof MatchBudgetExhausted) return budgetRefusal("fs.grep", String(args["pattern"]));
        throw e;
      }

      return {
        content:
          hits.length === 0
            ? "(no matches)"
            : capped
              ? `${hits.join("\n")}\n… (truncated at ${String(SEARCH_RESULT_CAP)} matches; narrow the search to see more)`
              : hits.join("\n"),
        details: { pattern: String(args["pattern"]), count: hits.length, truncated: capped },
      };
    },
  };
}

/**
 * How many `Location` hops `net.fetch` will follow before giving up.
 *
 * Not a knob: it is the number of hops a legitimate GET needs (canonicalisation, then
 * a scheme or trailing-slash normalisation, with room to spare), and every hop past it
 * is a loop or a chain nobody should be walking on a model's say-so.
 */
const MAX_REDIRECTS = 5;

/**
 * The egress boundary, applied to ONE url.
 *
 * Scheme first, by name. `file:///etc/passwd` and `data:text/plain,…` have an EMPTY
 * hostname, so they were refused only because `""` happens to match no allowlist entry —
 * a coincidence, and a coincidence is not a boundary. The allowlist is about which hosts
 * may be reached; a URL with no host is a different question and gets a different answer.
 *
 * Then the host: default deny, matching exactly or as a suffix after a dot, so
 * "api.example.com" never matches "evil-api.example.com.attacker.net".
 *
 * A REFUSAL THROWS rather than returning an error result, on every hop for the same
 * reason it does on the first: an egress refusal is a capability denial, and the
 * dispatcher turns it into `effect.failed` + E6. A soft error would read as a fetch that
 * merely did not work.
 *
 * WHAT THIS DOES NOT CHECK IS THE ADDRESS. An allowlisted NAME that resolves to a
 * loopback or link-local address is reached, because the name is what the operator
 * granted and the resolution happens inside `fetch`, below anything this file can reach
 * without a dispatcher of its own. Literal private addresses are likewise allowed when
 * they are on the list — `--egress 127.0.0.1` is a coherent thing for an operator to ask
 * for, and refusing it would be this file overruling a decision it was handed. The
 * property being defended is narrower and worth stating exactly: **every host contacted
 * is one the operator named**, which is what the redirect chain took away.
 */
function assertEgressAllowed(url: URL, allow: readonly string[], hop: number): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw err.policy(CODES.E_CAP_DENIED, `net.fetch speaks http and https only, not the "${url.protocol}" scheme`, {
      details: { url: url.href, protocol: url.protocol, hop },
    });
  }
  const ok = allow.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));
  if (!ok) {
    throw err.policy(
      CODES.E_CAP_DENIED,
      hop === 0
        ? `egress to "${url.hostname}" is not on the allowlist`
        : `a redirect tried to send this request to "${url.hostname}", which is not on the allowlist`,
      { details: { host: url.hostname, allow, hop } },
    );
  }
}

function netFetch(opts: BuiltinOptions): ToolDefinition {
  const allow = opts.egressAllowlist ?? [];
  const doFetch = opts.fetch ?? globalThis.fetch;
  return {
    name: "net.fetch",
    version: "1.0",
    description: "HTTP GET a URL on the egress allowlist.",
    capabilities: ["net:fetch"],
    irreversibility: "read_only",
    idempotent: true,
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, maxBytes: { type: "integer", default: 100_000 } },
      required: ["url"],
    },
    /**
     * EVERY HOP IS CHECKED, because the allowlist governs which hosts are reached and not
     * which host the model typed.
     *
     * `fetch` defaults to `redirect: "follow"`, so one check before the call meant an
     * allowlisted host could hand the request to anywhere: reproduced offline, an
     * allowlisted server answering `302 Location: http://<host not on the list>/…` put
     * that host's body straight into the tool's `content` — the shape of the cloud
     * metadata endpoint, and of any loopback service on the box. `read_only` means
     * posture `out` and no gate, so nothing else stood in the way.
     *
     * `redirect: "manual"` hands the 3xx back instead, and the loop below re-runs the
     * whole boundary — scheme and host — on each `Location` before following it.
     */
    execute: async (args, ctx) => {
      const raw = String(args["url"]);
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return { content: `not a valid URL: ${raw}`, isError: true };
      }
      assertEgressAllowed(url, allow, 0);

      let res = await doFetch(url, { signal: ctx.signal, redirect: "manual" });
      let hops = 0;
      while (res.status >= 300 && res.status < 400 && res.headers.get("location") !== null) {
        const location = res.headers.get("location")!;
        // FIRST, and before anything below can return or throw: a 3xx body is nobody's
        // answer, and an unread one holds its socket. The refusal path is the one that
        // would leak it, and the refusal path is the one that runs under attack.
        await res.body?.cancel().catch(() => undefined);
        if (hops >= MAX_REDIRECTS) {
          return { content: `too many redirects (${MAX_REDIRECTS}) starting from ${raw}`, isError: true };
        }
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return { content: `redirected to something that is not a URL: ${location}`, isError: true };
        }
        assertEgressAllowed(next, allow, ++hops);
        url = next;
        res = await doFetch(url, { signal: ctx.signal, redirect: "manual" });
      }

      // Bytes, then decoded as UTF-8 — what `res.text()` did, INCLUDING dropping a leading UTF-8
      // byte-order mark, which `res.text()` strips and a `JSON.parse` downstream chokes on — so
      // `maxBytes` and `bytes` count the body's bytes after the mark, and the cut is `fs.read`'s
      // (`capBytes`): no marker in `content`.
      let body = Buffer.from(await res.arrayBuffer());
      if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) body = body.subarray(3);
      const cut = capBytes(body, Number(args["maxBytes"] ?? 100_000));
      return {
        content: cut.text,
        // `url` is where the bytes CAME FROM, which after a redirect is not what was
        // asked for. The journal records the host that answered, not the one that was named.
        details: { status: res.status, bytes: cut.bytes, truncated: cut.truncated, url: url.href, hops },
        isError: !res.ok,
      };
    },
  };
}

/**
 * The compensation for `fs.write`, registered alongside it by the CLI.
 *
 * Resolves through `writePath`, so it undoes the write in the branch that made it. A
 * compensation that resolved against the workspace while the write resolved against the
 * branch would restore a file nobody touched and leave the modified one standing, which
 * is worse than having no compensation at all — the rewind would look done.
 */
export function fsRestore(opts: BuiltinOptions): ToolDefinition {
  return {
    name: "fs.restore",
    version: "1.0",
    description: "Restore a file to its previous content, or remove a file the write created (the compensation for fs.write).",
    capabilities: ["fs:write"],
    irreversibility: "reversible_write",
    idempotent: true,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        previous: { type: "string" },
        created: { type: "boolean" },
        wrote: { type: "string" },
        at: { type: "string" },
        identity: { type: "object" },
      },
      required: ["path"],
    },
    execute: (args, ctx) => {
      const rel = String(args["path"]);
      const previous = args["previous"];
      // BOTH IS NEITHER. `fs.write` records one or the other; a record claiming a create AND a
      // prior content cannot be told apart from a forged one, so it is not acted on.
      if (typeof previous === "string" && args["created"] === true) {
        return { content: `refusing to restore ${rel}: the record says both that the write created it and what it held before`, isError: true };
      }
      if (typeof previous === "string") {
        writeLeaf(writePath(opts, ctx, rel), previous);
        return { content: `restored ${rel}` };
      }
      if (args["created"] === true) return removeCreated(opts, args, rel);
      return { content: `no previous content recorded for ${rel}`, isError: true };
    },
  };
}

/**
 * UNDO A CREATE BY REMOVING THE FILE — and only the file the recorded write made (`TODO.md` §A.99).
 *
 * Before this, `fs.restore` could not undo a create at all: a late veto on
 * `two-person-veto.json` in a fresh workspace failed the run, left the approved file standing, and
 * journaled `compensation.recorded{outcome: "failed"}` — "no previous content recorded".
 *
 * EVERY ARGUMENT COMES FROM THE JOURNAL: `at` (the absolute path the write landed on), `identity`
 * (device and inode — `FileIdentity`) and `wrote` (a digest of the bytes), all recorded by
 * `writeWithUndo`. Nothing is re-resolved from the relative `path`. The removal happens only when
 * ALL of these hold, and every other outcome REFUSES and leaves the disk as it is:
 *
 *  - `at` lies under THIS jail's root, outside every denied subtree. A record from another
 *    workspace is not this one's to judge — and must not be read as "already absent";
 *  - every directory between the root and the leaf is a real directory, not a symlink, checked
 *    with `lstat`, so a parent swapped for a link cannot redirect the removal;
 *  - the leaf, read with `lstat` (never followed), has the recorded device and inode — which a
 *    symlink, FIFO or directory put there cannot have — exactly ONE link (a hard link made to it
 *    is another name the removal would not account for), and bytes that digest to `wrote`;
 *  - and the removal is by that same absolute name.
 *
 * "ALREADY ABSENT" is the state the undo wants, and it is answered `compensated` ONLY when the
 * recorded path itself is missing under this same root (the leaf, or a directory above it). Any
 * error that is not a plain absence is a refusal.
 *
 * A CALLER WHO FORGES A RECORD must name a real file's device and inode as well as its digest;
 * without all three this refuses. That is what stands between a graph `tool`
 * node calling `fs.restore` directly and an arbitrary delete — the registry has no way to mark a
 * tool compensation-only. Residue: the checks and the removal are separate system calls, so a
 * swap landing between them is not detected; and a caller that can already `stat` the workspace can
 * supply a true identity (it holds `fs:write`, which could empty the same file anyway).
 */
function removeCreated(opts: BuiltinOptions, args: Record<string, unknown>, rel: string): ToolResult {
  const refuse = (why: string): ToolResult => ({ content: `refusing to remove ${rel}: ${why}`, isError: true });
  const at = args["at"];
  const identity = args["identity"];
  const wrote = args["wrote"];
  if (typeof at !== "string" || !isAbsolute(at) || !isIdentity(identity) || typeof wrote !== "string") {
    return refuse("the record does not say which file the write created (absolute path, device, inode and digest are all required)");
  }
  let root: string;
  try {
    root = realpathSync(opts.root);
  } catch (e) {
    return refuse(`the workspace root cannot be resolved (${(e as Error).message})`);
  }
  const inside = relative(root, at);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    return refuse(`it was written at ${at}, which is not under this workspace's root ${root}`);
  }
  for (const d of resolvedDeny(opts)) {
    let denied = d;
    try {
      denied = realpathSync(d);
    } catch {
      // A denied subtree that does not exist is compared by its lexical name.
    }
    const under = relative(denied, at);
    if (under === "" || (!under.startsWith("..") && !isAbsolute(under))) return refuse(`${at} is inside the denied subtree ${denied}`);
  }
  const absent: ToolResult = { content: `${rel} is already absent; the file the write created no longer stands` };
  let dir = root;
  for (const part of inside.split(sep).slice(0, -1)) {
    dir = join(dir, part);
    let st;
    try {
      st = lstatSync(dir, { throwIfNoEntry: false });
    } catch (e) {
      return refuse(`cannot inspect ${dir} (${(e as Error).message})`);
    }
    if (st === undefined) return absent;
    if (st.isSymbolicLink() || !st.isDirectory()) return refuse(`${dir} is no longer a real directory`);
  }
  let leaf;
  try {
    leaf = lstatSync(at, { bigint: true, throwIfNoEntry: false });
  } catch (e) {
    return refuse(`cannot inspect it (${(e as Error).message})`);
  }
  if (leaf === undefined) return absent;
  // A symlink, a directory or a special file at the path has its own inode, so the identity check
  // below is also the "is it still a regular file" check — `lstat` never follows the leaf.
  const now = identityOf(leaf);
  if (now.dev !== identity.dev || now.ino !== identity.ino) {
    return refuse("it is not the file the write created (another device or inode is at the path)");
  }
  if (leaf.nlink !== 1n) return refuse(`it has ${String(leaf.nlink)} links, and removing one name would leave the others holding its bytes`);
  let current: Buffer;
  try {
    current = readRegularBytes(at);
  } catch (e) {
    return refuse(`cannot read it to check its bytes (${(e as Error).message})`);
  }
  if (bytesDigest(current) !== wrote) {
    return refuse("its bytes changed since the write created it, and removing it would delete content the write did not produce");
  }
  rmSync(at);
  return { content: `removed ${rel}: the file the recorded write created (same device, inode and bytes)` };
}
