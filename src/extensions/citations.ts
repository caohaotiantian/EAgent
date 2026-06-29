/**
 * citations — attribution tagging for retrieval tool results.
 *
 * EAgent has no grounding mechanism: when the model answers from content a
 * retrieval tool returned (a fetched web page via `net:fetch`, a read file or
 * `glob`/`grep` search via `fs:read`), the claim is untraceable back to its
 * source and a *hallucinated* citation ("according to [3]") goes undetected.
 *
 * This extension is the *attribution* counterpart to `content-guard`'s *trust*
 * labeling — both ride the `afterToolCall` filter and tag capability-selected
 * output, and the two compose on the same result. It:
 *
 *  1. on `afterToolCall`, for a *successful* result from a *retrieval* tool
 *     (one whose capabilities intersect a configured retrieval set, default
 *     `net:fetch` + `fs:read`), prepends a visible `[src:N] <tool> — <locator>`
 *     header to the body and records `N → {tool, locator}` in a per-run map
 *     (reset on `agent_start`); and
 *  2. on `agent_end`, parses the final assistant answer's `[src:N]`/`[N]`
 *     markers and warns (via `e.log.warn` + a `/citations` report) on any
 *     *fabricated id* (cited but never emitted this run), optionally flagging
 *     missing attribution.
 *
 * It never blocks, never calls a model, declares no capability, holds only
 * per-run in-memory state, and fails open. Off by default at run time (the
 * `enabled` store flag defaults to `false`); the `EAGENT_CITATIONS=off` env var
 * is the hard kill switch checked at activation (returns a no-op disposer).
 */

import { currentActingAgent, type Agent } from "../kernel/agent.js";
import type { ExtensionAPI } from "../kernel/extension.js";
import type { ToolResult } from "../kernel/types.js";

/** Capabilities whose declaring tool produces citable/retrieval output. */
const DEFAULT_RETRIEVAL_CAPS = ["net:fetch", "fs:read"];

/** The prefix every emitted id header (and the idempotency skip) keys off. */
const SRC_PREFIX = "[src:";

interface Config {
  enabled: boolean;
  retrievalCaps: string[];
  warnMissing: boolean;
}

/** What a single emitted id points back at (a brief best-effort locator). */
interface Source {
  tool: string;
  locator: string;
}

/** The validation of the last completed run, surfaced by `/citations`. */
interface LastRun {
  emitted: number[];
  cited: number[];
  fabricated: number[];
  missingAttribution: boolean;
}

/** All `[src:N]` ids cited in the final answer (authoritative — may fabricate). */
function parseSrcCitations(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\[src:(\d+)\]/g;
  for (const m of text.matchAll(re)) out.add(Number(m[1]));
  return out;
}

/**
 * All bare `[N]` ids cited in the final answer, EXCLUDING `[src:N]` (handled
 * separately) and EXCLUDING reference-style link defs `[N]:` (a `[N]`
 * immediately followed by a colon). The bare form is permissive and can only
 * ever *confirm* an already-emitted id — never introduce a fabricated one (the
 * caller scopes it to the emitted set), so an incidental bracketed integer
 * (footnote/list artifact) never raises a spurious fabricated-id warn.
 */
function parseBareCitations(text: string): Set<number> {
  const out = new Set<number>();
  // [N] not preceded by "src:" and not immediately followed by ":".
  const re = /\[(\d+)\](?!:)/g;
  for (const m of text.matchAll(re)) out.add(Number(m[1]));
  return out;
}

/** A short best-effort locator: the first non-empty line of the body, clipped. */
function locatorOf(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = firstLine.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

export default function activate(e: ExtensionAPI): () => void {
  if (process.env.EAGENT_CITATIONS === "off") return () => {};

  const cfg = (): Config => ({
    enabled: e.store.get<boolean>("enabled", false) ?? false,
    retrievalCaps: e.store.get<string[]>("retrievalCaps", DEFAULT_RETRIEVAL_CAPS) ?? DEFAULT_RETRIEVAL_CAPS,
    warnMissing: e.store.get<boolean>("warnMissing", false) ?? false,
  });

  // Per-run state, keyed by the ACTING agent so concurrent forks don't commingle
  // ids. Reset on the parent's agent_start; a child seeds lazily on its first
  // tagged result (agent_start is suppressed for children). (W9.1.)
  interface CiteState {
    sources: Map<number, Source>;
    nextId: number;
  }
  const states = new WeakMap<Agent, CiteState>();
  const stateFor = (agent: Agent): CiteState => {
    let s = states.get(agent);
    if (!s) states.set(agent, (s = { sources: new Map(), nextId: 1 }));
    return s;
  };
  let lastRun: LastRun | undefined;

  /** A result is retrieval iff its producing tool declares an intersecting cap. */
  const isRetrieval = (name: string, retrievalCaps: string[]): boolean => {
    const caps = e.agent.tools.get(name)?.capabilities ?? [];
    return caps.some((c) => retrievalCaps.includes(c));
  };

  /** The final answer = the last assistant message's concatenated text blocks. */
  const finalAnswer = (): string => {
    const msgs = e.agent.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!;
      if (m.role !== "assistant") continue;
      // Concatenate every text block: a model may split its answer across blocks
      // (or emit an empty leading text block before a thinking block).
      let text = "";
      for (const b of m.content) if (b.type === "text") text += b.text;
      if (text.length > 0) return text;
    }
    return "";
  };

  const onStart = e.on("agent_start", () => {
    // A fresh run starts a fresh id map and counter (per-run scoping) for the
    // acting (parent) agent.
    states.set(currentActingAgent() ?? e.agent, { sources: new Map(), nextId: 1 });
  });

  const offFilter = e.hook("afterToolCall", (result: ToolResult, ctx): ToolResult => {
    try {
      const c = cfg();
      if (!c.enabled || result.isError) return result;
      // Idempotency (defensive): already-tagged content gets no second header.
      if (result.content.startsWith(SRC_PREFIX)) return result;
      if (!isRetrieval(ctx.call.name, c.retrievalCaps)) return result;

      const st = stateFor(currentActingAgent() ?? e.agent);
      const id = st.nextId++;
      const locator = locatorOf(result.content);
      st.sources.set(id, { tool: ctx.call.name, locator });
      const header = `${SRC_PREFIX}${id}] ${ctx.call.name} — ${locator}\n`;
      return { ...result, content: header + result.content };
    } catch {
      // Fail open: a throw here must never break the run.
      return result;
    }
  });

  const onEnd = e.on("agent_end", () => {
    try {
      const c = cfg();
      if (!c.enabled) return;
      const answer = finalAnswer();
      if (answer === "") return; // nothing to validate (§5 assumption)

      const emitted = new Set(stateFor(currentActingAgent() ?? e.agent).sources.keys());

      // Authoritative stem — these can introduce a fabricated id.
      const srcCited = parseSrcCitations(answer);
      // Permissive bare form — counted ONLY when it confirms an emitted id.
      const bareCited = parseBareCitations(answer);

      const cited = new Set<number>();
      for (const n of srcCited) cited.add(n);
      for (const n of bareCited) if (emitted.has(n)) cited.add(n);

      // Fabrication comes ONLY from the authoritative [src:N] stem.
      const fabricated: number[] = [];
      for (const n of srcCited) if (!emitted.has(n)) fabricated.push(n);

      const missingAttribution = emitted.size >= 1 && cited.size === 0;

      lastRun = {
        emitted: [...emitted].sort((a, b) => a - b),
        cited: [...cited].sort((a, b) => a - b),
        fabricated: fabricated.sort((a, b) => a - b),
        missingAttribution,
      };

      for (const n of fabricated) {
        e.log.warn(`citations: fabricated source id [src:${n}] — cited but never emitted this run`);
      }
      if (missingAttribution && c.warnMissing) {
        e.log.warn(
          `citations: missing attribution — ${emitted.size} source id(s) emitted but the answer cited none`,
        );
      }
    } catch {
      // Fail open: validation must never break the run.
    }
  });

  const offCmd = e.registerCommand({
    name: "citations",
    description: "Tag retrieval outputs with stable [src:N] ids and validate answer citations. Usage: /citations [on|off|status]",
    run: (cmd) => {
      const arg = cmd.args.trim();
      switch (arg) {
        case "on":
          e.store.set("enabled", true);
          cmd.print("citations on");
          break;
        case "off":
          e.store.set("enabled", false);
          cmd.print("citations off");
          break;
        default: {
          const { enabled, retrievalCaps, warnMissing } = cfg();
          const r = lastRun;
          cmd.print(`citations ${enabled ? "on" : "off"}; retrieval-caps=${retrievalCaps.join(",")}; warn-missing=${warnMissing}`);
          if (r) {
            cmd.print(`last run — emitted: ${r.emitted.length} [${r.emitted.join(",")}]`);
            cmd.print(`last run — cited: [${r.cited.join(",")}]`);
            cmd.print(`last run — fabricated: [${r.fabricated.join(",")}]`);
            cmd.print(`last run — missing-attribution: ${r.missingAttribution}`);
          } else {
            cmd.print("last run — (no run validated yet)");
          }
        }
      }
    },
  });

  return () => {
    for (const d of [onStart, offFilter, onEnd, offCmd]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
