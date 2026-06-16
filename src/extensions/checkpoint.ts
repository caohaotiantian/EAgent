/**
 * Workspace checkpointing — a git-backed undo for an autonomous agent.
 *
 * An agent that edits files and runs shell commands will eventually make a
 * mistake: a bad `edit`, an over-eager `rm`, a refactor that goes sideways.
 * The cheapest insurance is a snapshot taken JUST BEFORE each risky mutation,
 * so the working tree can be rolled back to a known-good point. pi ships a
 * git-checkpoint hook for exactly this; here it stays an extension.
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
 */

import { execFileSync } from "node:child_process";

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";

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
  /** Resolve the workspace root, allowing a store override for tests. */
  const workspace = (): string =>
    e.store.get<string>("workspaceDir") ?? process.env.EAGENT_WORKSPACE ?? process.cwd();

  /** Run a git subcommand in the workspace; return trimmed stdout or null on failure. */
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd: workspace(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  /** True when the workspace is inside a git work tree. */
  const isRepo = (): boolean => git(["rev-parse", "--is-inside-work-tree"]) === "true";

  const list = (): Checkpoint[] => e.store.get<Checkpoint[]>(LIST_KEY, []) ?? [];

  /** Append a checkpoint, capping the stored list to the most recent N and
   *  deleting the git refs of any snapshots that fall off the end. */
  const record = (cp: Checkpoint): void => {
    const all = [...list(), cp];
    const kept = all.slice(-MAX_CHECKPOINTS);
    for (const dropped of all.slice(0, all.length - kept.length)) {
      git(["update-ref", "-d", `${REF_PREFIX}${dropped.id}`]);
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
  const snapshot = (label: string, toolName?: string): Checkpoint | null => {
    if (!isRepo()) return null;
    let sha = git(["stash", "create"]) ?? "";
    if (sha === "") {
      // Clean tree (or stash-create no-op): pin HEAD as the restore point.
      sha = git(["rev-parse", "HEAD"]) ?? "";
    }
    if (sha === "") return null;
    const id = nextId();
    // Anchor the (otherwise dangling) stash-create commit under a real ref so it
    // survives `git gc` between snapshot and rollback. HEAD-pinned snapshots are
    // already reachable, but anchoring uniformly keeps restore simple.
    git(["update-ref", `${REF_PREFIX}${id}`, sha]);
    const cp: Checkpoint = { id, sha, label, at: new Date().toISOString(), toolName };
    record(cp);
    return cp;
  };

  // -- auto-snapshot before mutating tool calls -----------------------------
  // Best-effort: snapshot then return the decision unchanged. We never block,
  // and any failure is logged rather than thrown out of the hook.
  e.hook("beforeToolCall", (decision, ctx) => {
    try {
      const name = ctx.call.name;
      const caps = e.agent.tools.get(name)?.capabilities ?? [];
      if (caps.some((c) => MUTATING_CAPABILITIES.has(c))) {
        const cp = snapshot(`auto: ${name}`, name);
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
    run: (ctx: CommandContext) => {
      if (!isRepo()) {
        ctx.print("not a git repository");
        return;
      }
      const label = ctx.args.trim() || "manual";
      const cp = snapshot(label);
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
    run: (ctx: CommandContext) => {
      if (!isRepo()) {
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
    run: (ctx: CommandContext) => {
      if (!isRepo()) {
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
      const ok = git(["checkout", cp.sha, "--", "."]);
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
