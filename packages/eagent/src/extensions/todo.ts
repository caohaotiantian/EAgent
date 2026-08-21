/**
 * todo — a session-scoped, in-memory todo list.
 *
 * Long-horizon agentic runs drift: the model re-derives the plan each turn and
 * drops steps. A live todo list externalizes that plan. `todowrite` *replaces*
 * the whole list (the model always sends the full updated set, so there is no
 * per-item patch protocol and no partial-update race) and echoes the canonical
 * render back, so the next turn sees the authoritative state without re-reading
 * the transcript. A `/todos` command shows the same view to the human.
 *
 * The list is pure in-memory bookkeeping — no filesystem, shell, or network —
 * so the tool declares no capability. State is session-scoped and cleared on
 * session reset. Writes are validated for shape (enums + non-empty content); a
 * malformed write fails with a correcting message and does not mutate the list.
 */

import { type Agent } from "../kernel/agent.ts";
import { defineTool, fail, ok } from "../kernel/define.ts";
import type { ExtensionAPI } from "../kernel/extension.ts";

type Status = "pending" | "in_progress" | "completed" | "cancelled";
type Priority = "high" | "medium" | "low";

interface TodoItem {
  content: string;
  status: Status;
  priority: Priority;
}

const STATUSES: readonly Status[] = ["pending", "in_progress", "completed", "cancelled"];
const PRIORITIES: readonly Priority[] = ["high", "medium", "low"];

const GLYPH: Record<Status, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
  cancelled: "-",
};

function render(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos)";
  const done = items.filter((i) => i.status === "completed").length;
  const header = `Todos (${done}/${items.length} done):`;
  const lines = items.map((i) => `- [${GLYPH[i.status]}] ${i.content} (${i.priority})`);
  return [header, ...lines].join("\n");
}

type ValidateResult = { ok: true; items: TodoItem[] } | { ok: false; message: string };

function validate(raw: unknown): ValidateResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "todowrite expects an object with a `todos` array" };
  }
  const todos = (raw as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) {
    return { ok: false, message: "`todos` must be an array of todo items" };
  }
  const items: TodoItem[] = [];
  for (let i = 0; i < todos.length; i++) {
    const entry = todos[i];
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, message: `todos[${i}] must be an object with content, status, and priority` };
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.content !== "string" || e.content.length === 0) {
      return { ok: false, message: `todos[${i}].content must be a non-empty string` };
    }
    if (typeof e.status !== "string" || !STATUSES.includes(e.status as Status)) {
      return { ok: false, message: `todos[${i}].status must be one of: ${STATUSES.join(", ")}` };
    }
    if (typeof e.priority !== "string" || !PRIORITIES.includes(e.priority as Priority)) {
      return { ok: false, message: `todos[${i}].priority must be one of: ${PRIORITIES.join(", ")}` };
    }
    items.push({ content: e.content, status: e.status as Status, priority: e.priority as Priority });
  }
  return { ok: true, items };
}

/** Store key holding `(agent) => TodoItem[]`, so a front end can render the
 *  checklist directly instead of parsing the human output of `/todos`. Mirrors
 *  `JOBS_ACCESSOR_KEY` / `COST_ACCESSOR_KEY`. */
export const TODO_ACCESSOR_KEY = "todoItems";

export default function activate(e: ExtensionAPI): () => void {
  // Session-scoped list, keyed on the run-tree ROOT (`e.rootAgent`) so it is shared
  // across a session's fork tree but isolated BETWEEN sessions (each on its own
  // Agent). The `session_start` reset (below) still clears the session's entry on
  // a reload.
  const byRoot = new WeakMap<Agent, { items: TodoItem[] }>();
  const stateFor = (agent: Agent): { items: TodoItem[] } => {
    let s = byRoot.get(agent);
    if (!s) byRoot.set(agent, (s = { items: [] }));
    return s;
  };

  e.store.set(TODO_ACCESSOR_KEY, (agent: Agent): TodoItem[] => byRoot.get(agent)?.items ?? []);

  const offTool = e.registerTool(
    defineTool({
      name: "todowrite",
      description:
        "Replace the session todo list with the full set of items and get the current list back. " +
        "Use it for multi-step work (3+ distinct steps): keep exactly one item `in_progress` at a " +
        "time, and mark an item `completed` only after the work is actually done. Each item is " +
        "{content, status: pending|in_progress|completed|cancelled, priority: high|medium|low}.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string" },
                priority: { type: "string" },
              },
              required: ["content", "status", "priority"],
            },
          },
        },
        required: ["todos"],
      },
      execute: (args) => {
        const v = validate(args);
        if (!v.ok) return fail(v.message);
        const st = stateFor(e.rootAgent);
        st.items = v.items;
        return ok(render(st.items));
      },
    }),
  );

  const offCmd = e.registerCommand({
    name: "todos",
    description: "Show the current session todo list.",
    run: (c) => c.print(render(stateFor(e.rootAgent).items)),
  });

  const reset = () => {
    stateFor(e.rootAgent).items = [];
  };
  const offStart = e.on("session_start", reset);
  const offDown = e.on("session_shutdown", reset);

  return () => {
    for (const d of [offTool, offCmd, offStart, offDown]) {
      try {
        d.dispose();
      } catch {
        // teardown must not throw
      }
    }
  };
}
