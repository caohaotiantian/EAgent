/**
 * The `/` and `@` suggestion popup.
 *
 * Drawn below the prompt, bounded to a handful of rows. Selection state lives
 * here; what to suggest and how to splice an acceptance live in
 * `input/suggest.ts`, which is where the tests are.
 */

import { Box, Text } from "ink";
import type { ReactElement } from "react";

import type { Suggestion } from "../input/suggest.js";

export function Suggestions({
  items,
  index,
}: {
  items: Suggestion[];
  index: number;
}): ReactElement | null {
  if (items.length === 0) return null;

  return (
    <Box flexDirection="column">
      {items.map((s, i) => (
        <Text key={s.label} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯" : " "} {s.label}
          {s.hint ? <Text dimColor> — {s.hint}</Text> : null}
        </Text>
      ))}
      <Text dimColor>tab or enter to accept · esc to dismiss</Text>
    </Box>
  );
}
