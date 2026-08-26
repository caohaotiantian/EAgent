(view) => {
  const raw = view.get("diff") ?? "";
  // One chunk per file, each carrying its own path so the reviewer can name it.
  const parts = String(raw).split("\ndiff --git ").filter((p) => p.trim() !== "");
  const files = parts.map((p, i) => {
    const body = i === 0 ? p : "diff --git " + p;
    const m = /b\/([^\s]+)/.exec(body);
    return { path: m ? m[1] : "unknown", diff: body.slice(0, 6000) };
  });
  return { writes: { files } };
}
