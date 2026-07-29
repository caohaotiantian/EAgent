/**
 * Item renderers.
 *
 * One component per transcript item kind. They are deliberately dumb: every
 * decision about *what* happened lives in the reducer, so these only decide how
 * it looks. That split is what lets the layout change without risking the
 * ordering and attribution guarantees the reducer's tests pin.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import { argSummary, estTokens, type Item, type ToolItem } from "../model/transcript.js";

/** Last `n` lines of a chunked stream — a long build log must not scroll the UI. */
function tail(text: string, n: number): string[] {
  const lines = text.split("\n").filter((l) => l !== "");
  return lines.slice(-n);
}

function ToolCard({ item, live }: { item: ToolItem; live: boolean }): ReactElement {
  const mark = item.status === "error" ? "✗" : item.status === "streaming" ? "…" : "✓";
  const color = item.status === "error" ? "red" : item.status === "streaming" ? "yellow" : "green";
  const summary = argSummary(item.arguments);
  const elapsed = ((item.updatedAt - item.startedAt) / 1000).toFixed(1);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={color}>{mark}</Text>
        <Text bold> {item.name}</Text>
        {summary ? <Text dimColor> {summary}</Text> : null}
        <Text dimColor> · {elapsed}s</Text>
      </Text>
      {/* Live progress is shown only while the call runs; once it ends the
          result replaces it, so a finished card never carries both. */}
      {live && item.status === "streaming" && item.progress
        ? tail(item.progress, 5).map((l, i) => (
            <Text key={i} dimColor>
              {"  "}
              {l}
            </Text>
          ))
        : null}
      {item.status === "error" && item.result ? (
        <Text color="red">
          {"  "}
          {item.result.content.split("\n")[0]}
        </Text>
      ) : null}
    </Box>
  );
}

export function ItemView({ item, live = false }: { item: Item; live?: boolean }): ReactElement {
  if (item.kind === "tool") return <ToolCard item={item} live={live} />;

  if (item.kind === "user") {
    return (
      <Box marginTop={1}>
        <Text bold color="cyan">
          › {item.text}
        </Text>
      </Box>
    );
  }

  if (item.kind === "notice") {
    return <Text color="yellow">⚠ {item.text}</Text>;
  }

  if (item.kind === "reasoning") {
    // Finished reasoning collapses to a header: it is context for the answer,
    // not the answer, and a long chain would otherwise flood the window.
    if (item.status !== "streaming") {
      return (
        <Text dimColor>
          ◆ Reasoning · ~{estTokens(item.text)} tok
        </Text>
      );
    }
    return <Text dimColor>{item.text}</Text>;
  }

  return <Text>{item.text}</Text>;
}
