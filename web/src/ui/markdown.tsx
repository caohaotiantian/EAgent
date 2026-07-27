/**
 * Lightweight Markdown subset for chat answers (no new npm deps).
 * Supports: fenced code, inline code, **bold**, *italic*, links, paragraphs, lists.
 * Renders as React nodes with text-safe defaults (no raw HTML passthrough).
 */

import type { ReactNode } from "react";

function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // code | bold | italic | link
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0]!;
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={`${keyBase}-c${i++}`} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("**")) {
      nodes.push(
        <strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>,
      );
    } else if (tok.startsWith("*")) {
      nodes.push(<em key={`${keyBase}-i${i++}`}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("[")) {
      const label = m[2] ?? "";
      const href = m[3] ?? "";
      const safe = href.startsWith("http://") || href.startsWith("https://") || href.startsWith("/");
      nodes.push(
        safe ? (
          <a key={`${keyBase}-a${i++}`} href={href} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          <span key={`${keyBase}-a${i++}`}>{label}</span>
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ text }: { text: string }): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  const fence = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let bi = 0;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(
        <div key={`p${bi++}`} className="md-block">
          {blocks(text.slice(last, m.index), `p${bi}`)}
        </div>,
      );
    }
    const lang = m[1] || "";
    const code = m[2] ?? "";
    parts.push(
      <pre key={`f${bi++}`} className="md-fence" data-lang={lang || undefined}>
        <code>{code.replace(/\n$/, "")}</code>
      </pre>,
    );
    last = m.index + m[0]!.length;
  }
  if (last < text.length) {
    parts.push(
      <div key={`p${bi++}`} className="md-block">
        {blocks(text.slice(last), `p${bi}`)}
      </div>,
    );
  }
  return <div className="md">{parts}</div>;
}

function blocks(chunk: string, keyBase: string): ReactNode[] {
  const lines = chunk.split("\n");
  const out: ReactNode[] = [];
  let list: string[] = [];
  let li = 0;
  const flushList = () => {
    if (!list.length) return;
    out.push(
      <ul key={`${keyBase}-ul${li++}`} className="md-ul">
        {list.map((item, i) => (
          <li key={i}>{inline(item, `${keyBase}-li${li}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      list.push(bullet[1] ?? "");
      continue;
    }
    flushList();
    if (!line.trim()) {
      out.push(<div key={`${keyBase}-sp${i}`} className="md-sp" />);
      continue;
    }
    out.push(
      <p key={`${keyBase}-p${i}`} className="md-p">
        {inline(line, `${keyBase}-p${i}`)}
      </p>,
    );
  }
  flushList();
  return out;
}
