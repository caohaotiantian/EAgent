/**
 * Minimal JSON syntax coloring for tool arguments (text-safe, no HTML inject).
 */

import type { ReactNode } from "react";

export function JsonView({ value }: { value: unknown }): ReactNode {
  let raw: string;
  try {
    raw = JSON.stringify(value, null, 2) ?? "null";
  } catch {
    raw = String(value);
  }
  const nodes: ReactNode[] = [];
  // strings | numbers | true/false/null | punctuation | keys already inside strings
  const re = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}\[\]],:)|(\s+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) nodes.push(raw.slice(last, m.index));
    if (m[1] !== undefined) {
      nodes.push(
        <span key={i++} className="json-key">
          {m[1]}
        </span>,
      );
      nodes.push(": ");
    } else if (m[2] !== undefined) {
      nodes.push(
        <span key={i++} className="json-str">
          {m[2]}
        </span>,
      );
    } else if (m[3] !== undefined) {
      nodes.push(
        <span key={i++} className="json-num">
          {m[3]}
        </span>,
      );
    } else if (m[4] !== undefined) {
      nodes.push(
        <span key={i++} className="json-kw">
          {m[4]}
        </span>,
      );
    } else if (m[5] !== undefined) {
      nodes.push(
        <span key={i++} className="json-punc">
          {m[5]}
        </span>,
      );
    } else if (m[6] !== undefined) {
      nodes.push(m[6]);
    }
    last = m.index + m[0]!.length;
  }
  if (last < raw.length) nodes.push(raw.slice(last));
  return <pre className="json-view">{nodes}</pre>;
}
