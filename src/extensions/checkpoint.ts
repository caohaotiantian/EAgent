/**
 * Workspace checkpointing — a git-backed undo for an autonomous agent.
 *
 * An agent that edits files and runs shell commands will eventually make a
 * mistake: a bad `edit`, an over-eager `rm`, a refactor that goes sideways.
 * The cheapest insurance is a snapshot taken JUST BEFORE each risky mutation,
 * so the working tree can be rolled back to a known-good point. Here that
 * insurance stays an extension.
 *
 * The mechanism is `git stash create`, which writes a commit that captures the
 * current working tree and index WITHOUT touching either — a pure snapshot of
 * the workspace. We anchor that commit under `refs/eagent/checkpoints/<id>` so
 * `git gc` cannot prune it, record its SHA in the extension store, and restore
 * from it with `git checkout <sha> -- .`. The
 * `beforeToolCall` filter auto-snapshots before any tool declaring a mutating
 * capability (`fs:write`, `shell:exec`, `code:exec`) runs, and never blocks.
 *
 * Every git call is best-effort and wrapped: a failure is logged or printed,
 * never thrown out of a hook or command.
 *
 * On by default. The auto-snapshot hook runs git ASYNCHRONOUSLY (never blocking
 * the event loop), serialized through a per-activation queue so concurrent
 * mutating tool calls cannot race on checkpoint ids or refs. It ships an
 * `EAGENT_CHECKPOINT=off` kill switch (per the house convention) that disables
 * the extension entirely — no hook, no commands.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";

const execFileAsync = promisify(execFile);

/** Capabilities whose tools mutate the workspace and so warrant a snapshot. */
const MUTATING_CAPABILITIES = new Set(["fs:write", "shell:exec", "code:exec"]);

/** Store key holding the snapshot list. */
const LIST_KEY = "checkpoints";
/** Keep at most this many snapshots; the oldest are dropped. */
const MAX_CHECKPOINTS = 50;
/** Ref namespace anchoring snapshot commits so `git gc` cannot prune them. */
const REF_PREFIX = "refs/eagent/checkpoints/";

/** A recorded restorable point in the workspace's history. */
interface Checkpoint {
  /** A short, monotonically increasing identifier. */
  id: string;
  /** The SHA of the snapshot commit (stash-create) or HEAD when clean. */
  sha: string;
  label: string;
  /** ISO timestamp of creation. */
  at: string;
  /** The tool whose call triggered an auto-snapshot, if any. */
  toolName?: string;
}

export default function activate(e: ExtensionAPI): void {
  // Kill switch: the auto-snapshot hook runs git on every mutating tool call, so
  // an operator must be able to opt out. When off, register nothing (no hook, no
  // commands) — mirrors time-travel's EAGENT_TIME_TRAVEL.
  if (!e.config.enabled("checkpoint", { default: true })) return;

  /** Resolve the workspace root, allowing a store override for tests. */
  const workspace = (): string =>
    e.store.get<string>("workspaceDir") ?? e.config.string("workspace") ?? process.cwd();

  /** Run a git subcommand in the workspace; return trimmed stdout or null on failure. */
  const git = async (args: string[]): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd: workspace(), encoding: "utf8" });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  /** True when the workspace is inside a git work tree. */
  const isRepo = async (): Promise<boolean> =>
    (await git(["rev-parse", "--is-inside-work-tree"])) === "true";

  const list = (): Checkpoint[] => e.store.get<Checkpoint[]>(LIST_KEY, []) ?? [];

  /** Append a checkpoint, capping the stored list to the most recent N and
   *  deleting the git refs of any snapshots that fall off the end. */
  const record = async (cp: Checkpoint): Promise<void> => {
    const all = [...list(), cp];
    const kept = all.slice(-MAX_CHECKPOINTS);
    for (const dropped of all.slice(0, all.length - kept.length)) {
      await git(["update-ref", "-d", `${REF_PREFIX}${dropped.id}`]);
    }
    e.store.set(LIST_KEY, kept);
  };

  /** The next id: one past the highest numeric id seen so far. */
  const nextId = (): string => {
    const max = list().reduce((m, cp) => Math.max(m, Number(cp.id) || 0), 0);
    return String(max + 1);
  };

  /**
   * Create a snapshot of the current working tree + index without disturbing
   * them. `git stash create` returns a dangling commit SHA, or empty output
   * when the tree is clean — in which case we fall back to recording HEAD so a
   * checkpoint always points at something restorable. Returns the checkpoint
   * or null if not a repo / git failed.
   */
  const snapshot = async (label: string, toolName?: string): Promise<Checkpoint | null> => {
    if (!(await isRepo())) return null;
    let sha = (await git(["stash", "create"])) ?? "";
    if (sha === "") {
      // Clean tree (or stash-create no-op): pin HEAD as the restore point.
      sha = (await git(["rev-parse", "HEAD"])) ?? "";
    }
    if (sha === "") return null;
    const id = nextId();
    // Anchor the (otherwise dangling) stash-create commit under a real ref so it
    // survives `git gc` between snapshot and rollback. HEAD-pinned snapshots are
    // already reachable, but anchoring uniformly keeps restore simple.
    await git(["update-ref", `${REF_PREFIX}${id}`, sha]);
    const cp: Checkpoint = { id, sha, label, at: new Date().toISOString(), toolName };
    await record(cp);
    return cp;
  };

  // Serialize every snapshot (auto-hook + manual command) through one promise
  // chain so concurrent mutating tool calls cannot interleave nextId()/
  // update-ref/record() and race on ids or refs. The tail is de-fanged so a
  // hypothetical rejection cannot poison the chain for the next snapshot.
  let tail: Promise<unknown> = Promise.resolve();
  const enqueueSnapshot = (label: string, toolName?: string): Promise<Checkpoint | null> => {
    const p = tail.then(() => snapshot(label, toolName));
    tail = p.then(() => {}, () => {});
    return p;
  };

  // -- auto-snapshot before mutating tool calls -----------------------------
  // Best-effort: snapshot then return the decision unchanged. We never block the
  // event loop, and any failure is logged rather than thrown out of the hook.
  e.hook("beforeToolCall", async (decision, ctx) => {
    try {
      const name = ctx.call.name;
      const caps = e.agent.tools.get(name)?.capabilities ?? [];
      if (caps.some((c) => MUTATING_CAPABILITIES.has(c))) {
        const cp = await enqueueSnapshot(`auto: ${name}`, name);
        if (cp) e.log.debug(`checkpoint ${cp.id} before ${name}`);
      }
    } catch (err) {
      e.log.warn("auto-snapshot failed:", err);
    }
    return decision;
  });

  // -- commands -------------------------------------------------------------

  e.registerCommand({
    name: "checkpoint",
    description: "Snapshot the workspace now (git-backed); prints the checkpoint id.",
    run: async (ctx: CommandContext) => {
      if (!(await isRepo())) {
        ctx.print("not a git repository");
        return;
      }
      const label = ctx.args.trim() || "manual";
      const cp = await enqueueSnapshot(label);
      if (!cp) {
        ctx.print("checkpoint failed: could not create a snapshot");
        return;
      }
      ctx.print(`checkpoint ${cp.id} created (${cp.label})`);
    },
  });

  e.registerCommand({
    name: "checkpoints",
    description: "List recorded workspace checkpoints (id, label, time, tool).",
    run: async (ctx: CommandContext) => {
      if (!(await isRepo())) {
        ctx.print("not a git repository");
        return;
      }
      const cps = list();
      if (cps.length === 0) {
        ctx.print("no checkpoints yet");
        return;
      }
      for (const cp of cps) {
        const tool = cp.toolName ? ` [${cp.toolName}]` : "";
        ctx.print(`${cp.id}\t${cp.label}\t${cp.at}${tool}`);
      }
    },
  });

  e.registerCommand({
    name: "rollback",
    description: "Restore the working tree to a checkpoint (latest if no id given).",
    run: async (ctx: CommandContext) => {
      if (!(await isRepo())) {
        ctx.print("not a git repository");
        return;
      }
      const cps = list();
      if (cps.length === 0) {
        ctx.print("no checkpoints to roll back to");
        return;
      }
      const wanted = ctx.args.trim();
      const cp = wanted ? cps.find((c) => c.id === wanted) : cps.at(-1);
      if (!cp) {
        ctx.print(`no checkpoint with id ${wanted}`);
        return;
      }
      // Restore tracked files to the snapshot. NOTE: a checkout does NOT delete
      // files that were newly created after the snapshot — that is a deliberate,
      // safe limitation (we never run `git clean` by default, so a rollback can
      // never silently destroy untracked work).
      const ok = await git(["checkout", cp.sha, "--", "."]);
      if (ok === null) {
        ctx.print(`rollback failed: could not restore checkpoint ${cp.id}`);
        return;
      }
      ctx.print(
        `rolled back to checkpoint ${cp.id} (${cp.label}); tracked files restored. ` +
          `Newly created files are left in place.`,
      );
    },
  });
}
