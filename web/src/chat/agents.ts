/**
 * Derive per-agent work status from a view-model section tree.
 */

import type { Section } from "@eagent/view-model";

export type AgentStatus = {
  id: string;
  isRoot: boolean;
  streaming: boolean;
  toolsRunning: number;
  toolsDone: number;
  toolsError: number;
  labels: string[]; // tool names recently seen
};

function walk(sections: Section[], rootId: string | undefined, out: Map<string, AgentStatus>): void {
  for (const s of sections) {
    let st = out.get(s.actingId);
    if (!st) {
      st = {
        id: s.actingId,
        isRoot: rootId !== undefined ? s.actingId === rootId : s.actingId === s.rootId,
        streaming: false,
        toolsRunning: 0,
        toolsDone: 0,
        toolsError: 0,
        labels: [],
      };
      out.set(s.actingId, st);
    }
    if (s.status === "streaming") st.streaming = true;
    if (s.kind === "tool") {
      if (s.status === "streaming") st.toolsRunning++;
      else if (s.status === "error") st.toolsError++;
      else st.toolsDone++;
      if (!st.labels.includes(s.name)) st.labels.push(s.name);
    }
    if (s.children.length) walk(s.children, rootId, out);
  }
}

export function agentStatuses(sections: Section[], rootId?: string): AgentStatus[] {
  const map = new Map<string, AgentStatus>();
  walk(sections, rootId, map);
  return [...map.values()].sort((a, b) => {
    if (a.isRoot !== b.isRoot) return a.isRoot ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}

export type SessionRowView = {
  id: string;
  running: boolean;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  /** This browser's active chat session id */
  current: boolean;
  /** Not yet (or no longer) on the server pool */
  localOnly: boolean;
};

/** Merge server list with the local chat session so "current" always appears. */
export function mergeSessionList(
  server: Array<{
    id: string;
    running: boolean;
    usage: { inputTokens: number; outputTokens: number };
    costUsd: number;
  }>,
  currentId: string,
  currentRunning: boolean,
): SessionRowView[] {
  const seen = new Set<string>();
  const out: SessionRowView[] = [];
  for (const s of server) {
    seen.add(s.id);
    out.push({
      ...s,
      current: s.id === currentId,
      localOnly: false,
    });
  }
  if (!seen.has(currentId)) {
    out.unshift({
      id: currentId,
      running: currentRunning,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      current: true,
      localOnly: true,
    });
  }
  // Current session first when present on server too
  out.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}
