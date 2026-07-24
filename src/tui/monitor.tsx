/**
 * The monitor/manager view (design D5, AC7): a multi-session dashboard over one
 * or more configured EAgent instances.
 *
 * `Monitor` holds an `InstanceClient` per configured instance, flattens their
 * live session snapshots into one sorted list, and renders it with status / usage
 * / cost. Selecting a row opens `DetailView`, which attaches that session's
 * per-session SSE feed through a P3 `RemoteSource` and renders it with the P4
 * `Transcript` component + `Coalescer` — the same transcript the single-session
 * client uses, not a re-implementation. Controls: stop (POST /sessions/:id/stop
 * via the instance client) and forget (client-side drop). All keyboard input is
 * owned by `Monitor`'s single `useInput`, branching on whether a session is open,
 * so the list and detail views never both consume a keystroke.
 *
 * The only `ink`/`react` importers in the engine repo live under `src/tui/`
 * (AC9); the model + instance client this consumes stay dependency-free.
 */

import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";

import { initialModel, type DisplayMode, type ViewModel } from "../view-model.js";
import { Coalescer } from "./coalesce.js";
import { Transcript } from "./app.js";
import { InstanceClient, type MonitorInstance, type SessionInfo } from "./instance.js";

/** One row of the flattened cross-instance list. */
interface Row {
  instanceIndex: number;
  instanceUrl: string;
  info: SessionInfo;
}

function tokensOf(u: SessionInfo["usage"]): number {
  return u.inputTokens + u.outputTokens;
}

/** Flatten every instance's session snapshot into a stable, sorted row list. */
function buildRows(clients: InstanceClient[]): Row[] {
  const rows: Row[] = [];
  clients.forEach((client, instanceIndex) => {
    for (const info of client.sessions()) rows.push({ instanceIndex, instanceUrl: client.url, info });
  });
  rows.sort((a, b) => a.instanceIndex - b.instanceIndex || a.info.id.localeCompare(b.info.id));
  return rows;
}

/** The detail transcript over one session's per-session SSE feed. */
function DetailView({
  client,
  id,
  mode,
  rows,
  columns,
}: {
  client: InstanceClient;
  id: string;
  mode: DisplayMode;
  rows: number;
  columns: number;
}): ReactElement {
  const source = useMemo(() => client.sourceFor(id), [client, id]);
  const [model, setModel] = useState<ViewModel>(() => initialModel(mode));
  const coalescer = useMemo(() => new Coalescer((m) => setModel(m), { mode }), [source, mode]);

  useEffect(() => {
    const sub = source.subscribe((ev) => coalescer.push(ev));
    return () => {
      sub.dispose();
      coalescer.flush();
      source.close();
    };
  }, [source, coalescer]);

  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>
        Detail · {id} <Text dimColor>@ {client.url}</Text>
      </Text>
      <Text dimColor>[b] back · [s] stop · [q] quit</Text>
      <Transcript model={model} rows={Math.max(1, rows - 2)} columns={columns} />
    </Box>
  );
}

/** One list row: cursor marker, live status, id, usage, cost, instance label. */
function RowLine({ row, selected, multi }: { row: Row; selected: boolean; multi: boolean }): ReactElement {
  const { info } = row;
  const status = info.running ? "running" : "idle";
  return (
    <Text inverse={selected} color={info.running ? "green" : undefined}>
      {selected ? "> " : "  "}
      {info.running ? "● " : "○ "}
      {info.id.padEnd(16)} {status.padEnd(8)} {String(tokensOf(info.usage)).padStart(7)} tok  ${info.costUsd.toFixed(4)}
      {multi ? `  ${new URL(row.instanceUrl).host}` : ""}
    </Text>
  );
}

export function Monitor({
  instances,
  mode = "auto",
  pollMs = 2000,
}: {
  instances: MonitorInstance[];
  mode?: DisplayMode;
  pollMs?: number;
}): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const termRows = stdout?.rows ?? 24;

  const clients = useMemo(() => instances.map((inst) => new InstanceClient(inst, { pollMs })), [instances, pollMs]);

  const [list, setList] = useState<Row[]>([]);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<{ instanceIndex: number; id: string } | null>(null);

  useEffect(() => {
    const subs = clients.map((client) => client.subscribe(() => setList(buildRows(clients))));
    for (const client of clients) client.start();
    setList(buildRows(clients));
    return () => {
      for (const sub of subs) sub.dispose();
      for (const client of clients) client.close();
    };
  }, [clients]);

  const rowCount = list.length;
  const cur = rowCount === 0 ? 0 : Math.min(cursor, rowCount - 1);

  useInput((char, key) => {
    if (selected) {
      if (key.escape || char === "b" || char === "h") {
        setSelected(null);
      } else if (char === "s") {
        void clients[selected.instanceIndex]?.stop(selected.id);
      } else if (char === "q") {
        exit();
      }
      return;
    }
    if (char === "q") {
      exit();
      return;
    }
    if (char === "r") {
      for (const client of clients) void client.refresh();
      return;
    }
    if (rowCount === 0) return;
    if (key.downArrow || char === "j") {
      setCursor((c) => Math.min(c + 1, rowCount - 1));
    } else if (key.upArrow || char === "k") {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return || char === "l") {
      const row = list[cur];
      if (row) setSelected({ instanceIndex: row.instanceIndex, id: row.info.id });
    } else if (char === "s") {
      const row = list[cur];
      if (row) void clients[row.instanceIndex]?.stop(row.info.id);
    } else if (char === "f") {
      const row = list[cur];
      if (row) clients[row.instanceIndex]?.forget(row.info.id);
    }
  });

  if (selected) {
    const client = clients[selected.instanceIndex];
    if (client) {
      return <DetailView client={client} id={selected.id} mode={mode} rows={termRows} columns={columns} />;
    }
  }

  const multi = clients.length > 1;
  return (
    <Box flexDirection="column" width={columns}>
      <Text bold>
        EAgent monitor <Text dimColor>· {clients.length} instance{clients.length === 1 ? "" : "s"} · {rowCount} session{rowCount === 1 ? "" : "s"}</Text>
      </Text>
      {rowCount === 0 ? (
        <Text dimColor>no sessions — waiting for the instances…</Text>
      ) : (
        list.map((row, i) => (
          <RowLine key={`${row.instanceIndex}:${row.info.id}`} row={row} selected={i === cur} multi={multi} />
        ))
      )}
      <Text dimColor>[j/k] move · [enter] open · [s] stop · [f] forget · [r] refresh · [q] quit</Text>
    </Box>
  );
}
