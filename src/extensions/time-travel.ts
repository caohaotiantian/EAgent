/**
 * time-travel — a persisted, branching checkpoint TREE for agent state.
 *
 * Wave 4 gave the kernel `Agent.snapshot()`/`restore()` (the full `AgentState`:
 * transcript, usage, model, provider, system prompt, thinking, and the monotonic
 * `step`), but nothing consumed it as history — the HTTP host only does a flat
 * per-session save/restore. The genuine gap is *time-travel*: rewind to turn N
 * and *fork* an alternate line of history. Resume (`journal`/`session`/`handoff`)
 * is forward-only and whole-log; `checkpoint.ts` rewinds the git *workspace*, not
 * the conversation. This extension is the missing piece, built purely on the
 * existing primitive — NO kernel change.
 *
 * Shape (LangGraph's lesson): a checkpoint TREE keyed by a unique, persisted
 * monotonic `id`. Each node carries a `parentId`, so rewind and fork are the same
 * restore primitive — restore a node and continue; subsequent checkpoints attach
 * as its children, forming a branch. The light index (`{ id, step, parentId,
 * label, ts }`) lives in `e.store`; the heavy `AgentState` blob is one file per
 * node under `.eagent/timetravel/<id>.json` (mirroring `handoff.ts`'s split), so
 * the store JSON stays small.
 *
 * Off by default (`EAGENT_TIME_TRAVEL=off` kill switch + an `enabled` store flag,
 * default false). Even when enabled, per-turn auto-checkpoint is a separate flag
 * (`auto`, default off). Declares NO capability — it reads/writes only the
 * agent's own state plus this extension's store and dir. `/rewind` restores
 * CONVERSATION state only; pair it with `checkpoint.ts`'s `/rollback` for files.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { CommandContext } from "../kernel/commands.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { AgentState } from "../kernel/types.js";

/** Light index node — the heavy `AgentState` lives in a per-node blob file. */
interface Node {
  id: string;
  step: number;
  parentId?: string;
  label?: string;
  /** Wall-clock creation time, display only. */
  ts: number;
}

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_TIME_TRAVEL === "off") return () => {};

  const cfg = () => ({
    enabled: e.store.get<boolean>("enabled", false) === true,
    auto: e.store.get<boolean>("auto", false) === true,
    cap: e.store.get<number>("cap", 64) ?? 64,
  });

  // Read the dir fresh each call so a test's EAGENT_TIME_TRAVEL_DIR override applies.
  const blobDir = (): string =>
    process.env.EAGENT_TIME_TRAVEL_DIR ??
    join(process.env.EAGENT_WORKSPACE ?? process.cwd(), ".eagent", "timetravel");
  const blobPath = (id: string): string => join(blobDir(), `${id}.json`);

  const readNodes = (): Record<string, Node> => e.store.get<Record<string, Node>>("nodes", {}) ?? {};
  const writeNodes = (nodes: Record<string, Node>): void => e.store.set("nodes", nodes);
  const readHead = (): string | undefined => e.store.get<string>("head");
  const writeHead = (id: string | undefined): void => e.store.set("head", id);

  /** The next id: a persisted, monotonic counter so ids are unique across restarts. */
  const nextId = (): string => {
    const seq = (e.store.get<number>("seq", 0) ?? 0) + 1;
    e.store.set("seq", seq);
    return String(seq);
  };

  const writeBlob = (id: string, state: AgentState): void => {
    mkdirSync(blobDir(), { recursive: true });
    writeFileSync(blobPath(id), JSON.stringify(state), "utf8");
  };

  /** Tolerant read: a corrupt or missing blob yields `undefined`. */
  const readBlob = (id: string): AgentState | undefined => {
    try {
      return JSON.parse(readFileSync(blobPath(id), "utf8")) as AgentState;
    } catch {
      return undefined;
    }
  };

  /**
   * Append a node: write the BLOB first, then set the index entry (so a crash
   * never leaves a dangling index→missing-blob, only a harmless orphan blob),
   * point `head` at it, then prune to the cap.
   */
  const addNode = (state: AgentState, label?: string): string => {
    const id = nextId();
    writeBlob(id, state);
    const nodes = readNodes();
    nodes[id] = { id, step: state.step, parentId: readHead(), label, ts: Date.now() };
    writeNodes(nodes);
    writeHead(id);
    evictIfOverCap();
    return id;
  };

  /**
   * Tree-coherent FIFO eviction: while over the cap, drop the
   * OLDEST node (lowest numeric id), RE-PARENT its children to its own parent (a
   * root's children become roots → a forest), and remove the index entry FIRST,
   * then unlink the blob. `head` is the newest node on every add path, so it is
   * never the evicted one; the head-move is defensive only.
   */
  const evictIfOverCap = (): void => {
    const { cap } = cfg();
    const nodes = readNodes();
    while (Object.keys(nodes).length > cap) {
      let oldest: Node | undefined;
      for (const n of Object.values(nodes)) {
        if (!oldest || Number(n.id) < Number(oldest.id)) oldest = n;
      }
      if (!oldest) break;
      const oldestId = oldest.id;
      for (const n of Object.values(nodes)) {
        if (n.parentId === oldestId) n.parentId = oldest.parentId;
      }
      if (readHead() === oldestId) {
        writeHead(Object.keys(nodes).find((k) => k !== oldestId));
      }
      delete nodes[oldestId];
      writeNodes(nodes);
      try {
        unlinkSync(blobPath(oldestId));
      } catch {
        // best-effort: a missing blob is fine
      }
    }
  };

  /**
   * Resolve a selector to a node: an exact `id` wins; otherwise a bare `step`
   * matching exactly one node selects it. An AMBIGUOUS step (more than one node
   * at that step, across branches) prints the candidate ids and refuses — `id`
   * is the unambiguous selector (no silent auto-pick).
   */
  const resolve = (sel: string, print: (line: string) => void): Node | undefined => {
    const nodes = readNodes();
    const exact = nodes[sel];
    if (exact) return exact;
    const matches = Object.values(nodes).filter((n) => String(n.step) === sel);
    if (matches.length > 1) {
      print(`ambiguous step ${sel}; specify an id: ${matches.map((m) => m.id).join(", ")}`);
      return undefined;
    }
    return matches[0];
  };

  // -- auto-checkpoint: one node per turn when enabled && auto ---------------
  // Wrapped in try/catch so a poisoned Message.meta that fails structuredClone
  // cannot break the loop.
  const offTurnEnd = e.on("turn_end", () => {
    const c = cfg();
    if (c.enabled && c.auto) {
      try {
        addNode(e.agent.snapshot());
      } catch {
        // poisoned meta — skip this auto-checkpoint
      }
    }
  });

  // -- /timetravel: management + capture ------------------------------------
  const offTimeTravel = e.registerCommand({
    name: "timetravel",
    description:
      "Manage the agent-state checkpoint tree. Usage: /timetravel [status|on|off|auto on|off|checkpoint [label]]",
    run: (ctx: CommandContext) => {
      const [verb, ...rest] = ctx.args.trim().split(/\s+/);
      switch (verb) {
        case "":
        case "status": {
          const c = cfg();
          ctx.print(
            `time-travel ${c.enabled ? "on" : "off"} auto=${c.auto ? "on" : "off"} ` +
              `nodes=${Object.keys(readNodes()).length} head=${readHead() ?? "-"}`,
          );
          return;
        }
        case "on":
          e.store.set("enabled", true);
          ctx.print("time-travel on");
          return;
        case "off":
          e.store.set("enabled", false);
          ctx.print("time-travel off");
          return;
        case "auto": {
          const sub = rest[0];
          if (sub === "on" || sub === "off") {
            e.store.set("auto", sub === "on");
            ctx.print(`time-travel auto ${sub}`);
          } else {
            ctx.print("usage: /timetravel auto on|off");
          }
          return;
        }
        case "checkpoint": {
          if (!cfg().enabled) {
            ctx.print("time-travel is off; enable it with /timetravel on");
            return;
          }
          const label = rest.join(" ").trim() || undefined;
          ctx.print(`checkpoint ${addNode(e.agent.snapshot(), label)}`);
          return;
        }
        default:
          ctx.print(`unknown subcommand: ${verb}`);
      }
    },
  });

  // -- /rewind: restore a node; the lineage continues from it ---------------
  const offRewind = e.registerCommand({
    name: "rewind",
    description: "Rewind agent (conversation) state to a checkpoint. Usage: /rewind <id|step>",
    run: (ctx: CommandContext) => {
      const sel = ctx.args.trim();
      if (!sel) {
        ctx.print("usage: /rewind <id|step>");
        return;
      }
      const node = resolve(sel, ctx.print);
      if (!node) {
        ctx.print(`no such checkpoint: ${sel}`);
        return;
      }
      const state = readBlob(node.id);
      if (!state) {
        ctx.print(`corrupt or missing checkpoint blob for ${node.id}`);
        return;
      }
      try {
        e.agent.restore(state);
        writeHead(node.id);
        ctx.print(`rewound to ${node.id}`);
      } catch (err) {
        // restore() throws while the agent is running — surface it cleanly.
        ctx.print(`cannot rewind: ${(err as Error).message}`);
      }
    },
  });

  // -- /fork: restore a node AND eagerly materialize the branch node --------
  const offFork = e.registerCommand({
    name: "fork",
    description: "Fork a new branch from a checkpoint. Usage: /fork <id|step> [label]",
    run: (ctx: CommandContext) => {
      const [sel, ...rest] = ctx.args.trim().split(/\s+/);
      if (!sel) {
        ctx.print("usage: /fork <id|step> [label]");
        return;
      }
      const node = resolve(sel, ctx.print);
      if (!node) {
        ctx.print(`no such checkpoint: ${sel}`);
        return;
      }
      const state = readBlob(node.id);
      if (!state) {
        ctx.print(`corrupt or missing checkpoint blob for ${node.id}`);
        return;
      }
      try {
        e.agent.restore(state);
        // head ← the forked node BEFORE addNode, so the new node's parent is it.
        writeHead(node.id);
        const label = rest.join(" ").trim() || undefined;
        ctx.print(`forked ${addNode(e.agent.snapshot(), label)} from ${node.id}`);
      } catch (err) {
        ctx.print(`cannot fork: ${(err as Error).message}`);
      }
    },
  });

  // -- /tree: render the node forest ----------------------------------------
  const offTree = e.registerCommand({
    name: "tree",
    description: "Render the agent-state checkpoint tree (* marks head).",
    run: (ctx: CommandContext) => {
      const nodes = readNodes();
      if (Object.keys(nodes).length === 0) {
        ctx.print("(no checkpoints)");
        return;
      }
      const head = readHead();
      // A root is a node with no parent, or whose parent was evicted (dangling).
      const childrenOf = (pid: string | undefined): Node[] =>
        Object.values(nodes)
          .filter((n) =>
            pid === undefined ? n.parentId === undefined || !(n.parentId in nodes) : n.parentId === pid,
          )
          .sort((a, b) => Number(a.id) - Number(b.id));
      const render = (n: Node, depth: number): void => {
        ctx.print(`${n.id === head ? "*" : " "} ${"  ".repeat(depth)}${n.id} step=${n.step}${n.label ? ` ${n.label}` : ""}`);
        for (const child of childrenOf(n.id)) render(child, depth + 1);
      };
      for (const root of childrenOf(undefined)) render(root, 0);
    },
  });

  return () => {
    for (const d of [offTurnEnd, offTimeTravel, offRewind, offFork, offTree]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
