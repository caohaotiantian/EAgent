/**
 * The embedded operator console.
 *
 * Vanilla JS and inline SVG, served as one document. No React, no bundler, no build
 * step — so it ships inside the same zero-dependency binary as everything else, and
 * `loom serve` gives you a working console with nothing installed.
 *
 * It implements the four rendering decisions from D9 §L1, which are the ones that
 * actually matter at 500 nodes:
 *
 *   1. **Structure once, deltas forever.** The graph is fetched once from
 *      `/graphs/:name` and cached by `graphHash`; after that only task-state changes
 *      stream over SSE.
 *   2. **Layout comes from the compiler.** Nodes are placed from `layoutRank`, which
 *      the compiler already computed, so the browser never runs a graph layout.
 *   3. **Fan-out collapses.** N branch instances of one node render as ONE element
 *      with a count badge; a 25-way fan-out is one shape until you ask for 25.
 *   4. **Deltas coalesce at 60 ms.** Twenty-five branches finishing at once produce
 *      one repaint, not twenty-five.
 *
 * A React console can come later against the same API. This one exists so the
 * oversight model is usable on day one — an approval queue nobody can reach is an
 * oversight model that does not exist.
 */

export const CONSOLE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Loom</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfd; --panel: #fff; --line: #e3e3e8; --ink: #16161a; --muted: #6b6b76;
    --accent: #3b5bdb; --ok: #2f9e44; --warn: #e8a317; --err: #d64545; --gate: #7048e8;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#131316; --panel:#1a1a1f; --line:#2c2c33; --ink:#ececf1; --muted:#9a9aa5;
            --accent:#748ffc; --ok:#51cf66; --warn:#ffd43b; --err:#ff8787; --gate:#b197fc; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:15px; margin:0; font-weight:650; letter-spacing:-0.01em; }
  header .sp { flex:1 }
  .pill { font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; padding:4px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  main { display:grid; grid-template-columns:300px 1fr 340px; gap:0; height:calc(100vh - 49px); }
  section { overflow:auto; padding:14px 16px; }
  section + section { border-left:1px solid var(--line); }
  h2 { font-size:11px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0 0 10px; font-weight:650; }
  .row { padding:8px 10px; border:1px solid var(--line); border-radius:8px; margin-bottom:6px; cursor:pointer; background:var(--panel); }
  .row:hover { border-color:var(--accent); }
  .row.sel { border-color:var(--accent); box-shadow:0 0 0 2px color-mix(in srgb, var(--accent) 20%, transparent); }
  .row code { font:600 11px/1 ui-monospace,Menlo,monospace; }
  .meta { color:var(--muted); font-size:11px; margin-top:2px; }
  svg { width:100%; height:auto; display:block; }
  .node rect { fill:var(--panel); stroke:var(--line); stroke-width:1.5; }
  .node text { font:600 11px ui-sans-serif,system-ui; fill:var(--ink); }
  .node .sub { font-weight:400; fill:var(--muted); font-size:10px; }
  .node.succeeded rect { stroke:var(--ok); fill:color-mix(in srgb, var(--ok) 10%, var(--panel)); }
  .node.failed rect { stroke:var(--err); fill:color-mix(in srgb, var(--err) 12%, var(--panel)); }
  .node.leased rect, .node.ready rect { stroke:var(--accent); }
  .node.awaiting_gate rect { stroke:var(--gate); fill:color-mix(in srgb, var(--gate) 14%, var(--panel)); }
  .node.skipped rect, .node.cancelled rect { stroke-dasharray:4 3; opacity:.6; }
  .edge { stroke:var(--line); stroke-width:1.5; fill:none; marker-end:url(#a); }
  .edge.taken { stroke:var(--accent); }
  .badge { font:700 10px ui-monospace,Menlo,monospace; fill:#fff; }
  .badge-bg { fill:var(--accent); }
  button { font:600 12px ui-sans-serif,system-ui; padding:7px 12px; border-radius:7px; border:1px solid var(--line);
           background:var(--panel); color:var(--ink); cursor:pointer; }
  button.primary { background:var(--ok); border-color:var(--ok); color:#fff; }
  button.danger  { background:var(--err); border-color:var(--err); color:#fff; }
  .gate { border:1px solid var(--gate); border-radius:8px; padding:10px; margin-bottom:8px; background:color-mix(in srgb, var(--gate) 8%, var(--panel)); }
  .gate .actions { display:flex; gap:6px; margin-top:8px; }
  pre { font:11px/1.45 ui-monospace,Menlo,monospace; background:var(--bg); border:1px solid var(--line);
        border-radius:7px; padding:9px; overflow:auto; max-height:230px; margin:6px 0 0; }
  .empty { color:var(--muted); font-size:12px; padding:8px 0; }
  label { display:block; font-size:11px; color:var(--muted); margin-top:8px; }
  input, textarea { width:100%; font:12px ui-monospace,Menlo,monospace; padding:6px 8px; border-radius:6px;
                    border:1px solid var(--line); background:var(--panel); color:var(--ink); }
</style>
</head>
<body>
<header>
  <h1>Loom</h1>
  <span class="pill" id="conn">connecting</span>
  <span class="sp"></span>
  <span class="pill" id="stat"></span>
</header>
<main>
  <section>
    <h2>Runs</h2>
    <div id="runs"><div class="empty">none yet</div></div>
    <h2 style="margin-top:18px">Start a run</h2>
    <label>workflow</label><input id="wf" placeholder="graph name">
    <label>inputs (JSON)</label><textarea id="in" rows="3">{}</textarea>
    <div style="margin-top:8px"><button id="go">submit</button></div>
  </section>

  <section>
    <h2>Graph</h2>
    <div id="canvas"><div class="empty">select a run</div></div>
  </section>

  <section>
    <h2>Oversight</h2>
    <div id="gates"><div class="empty">no pending decisions</div></div>
    <h2 style="margin-top:18px">State</h2>
    <pre id="state">—</pre>
  </section>
</main>

<script>
const $ = (id) => document.getElementById(id);
const api = (p, o) => fetch(p, o).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || r.statusText);
  return body;
});

let selected = null;
let stream = null;
let lastSeq = 0;
/** graphHash -> spec. Structure is fetched ONCE and cached; only deltas stream. */
const graphCache = new Map();
let current = { graph: null, tasks: new Map(), gates: [], channels: {}, status: "" };

// ── delta coalescing ────────────────────────────────────────────────────────
// 25 branches finishing at once must produce ONE repaint, not 25.
let pending = false;
function invalidate() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; draw(); }, 60);
}

// ── run list ────────────────────────────────────────────────────────────────
async function loadRuns() {
  const { runs } = await api("/runs");
  const el = $("runs");
  if (!runs.length) { el.innerHTML = '<div class="empty">none yet</div>'; return; }
  el.innerHTML = "";
  for (const r of runs) {
    const d = document.createElement("div");
    d.className = "row" + (r.runId === selected ? " sel" : "");
    d.innerHTML = '<code>' + r.runId.slice(0, 12) + '</code><div class="meta">' + r.headSeq + ' events</div>';
    d.onclick = () => select(r.runId);
    el.appendChild(d);
  }
}

async function select(runId) {
  selected = runId;
  lastSeq = 0;
  current = { graph: null, tasks: new Map(), gates: [], channels: {}, status: "" };
  if (stream) stream.close();
  await loadRuns();

  const run = await api("/runs/" + runId);
  applySnapshot(run);
  await ensureGraph(run.graphHash);

  // Resume from the seq we already have — the server replays gap-free from there,
  // or hands back a snapshot if we are outside the hot window.
  stream = new EventSource("/runs/" + runId + "/events?lastEventId=" + run.seq);
  lastSeq = run.seq;
  stream.onopen = () => ($("conn").textContent = "live");
  stream.onerror = () => ($("conn").textContent = "reconnecting");
  stream.addEventListener("snapshot", (e) => { applySnapshot(JSON.parse(e.data)); invalidate(); });
  stream.addEventListener("event", (e) => {
    lastSeq = Number(e.lastEventId || lastSeq);
    applyEvent(JSON.parse(e.data));
    invalidate();
  });
  invalidate();
}

function applySnapshot(run) {
  current.status = run.status;
  current.channels = run.channels || {};
  current.gates = (run.gates || []).filter((g) => g.state === "open");
  current.tasks = new Map((run.tasks || []).map((t) => [t.taskId, t]));
  current.graphHash = run.graphHash;
}

/** Incremental application — the whole point of streaming deltas. */
function applyEvent(ev) {
  const p = ev.payload || {};
  if (ev.type === "task.ready" && ev.taskId) {
    current.tasks.set(ev.taskId, { taskId: ev.taskId, nodeId: p.nodeId, state: "ready", take: [] });
  } else if (ev.type === "task.leased" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) t.state = "leased";
  } else if (ev.type === "task.committed" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) { t.state = p.status; t.take = p.take || []; }
  } else if (ev.type === "task.failed" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) { t.state = "failed"; t.error = p.error; }
  } else if (ev.type === "state.reduced") {
    Object.assign(current.channels, p.values || {});
  } else if (ev.type === "gate.raised") {
    current.gates.push({ gateId: p.gateId, nodeId: p.nodeId, state: "open" });
    current.status = "awaiting_gate";
  } else if (ev.type === "gate.decided") {
    current.gates = current.gates.filter((g) => g.gateId !== p.gateId);
  } else if (ev.type === "run.completed") { current.status = "succeeded"; }
  else if (ev.type === "run.failed") { current.status = "failed"; }
  else if (ev.type === "run.cancelled") { current.status = "cancelled"; }
}

async function ensureGraph(hash) {
  if (graphCache.has(hash)) { current.graph = graphCache.get(hash); return; }
  const g = await api("/graphs/by-hash/" + encodeURIComponent(hash)).catch(() => null);
  if (g) { graphCache.set(hash, g); current.graph = g; }
}

// ── rendering ───────────────────────────────────────────────────────────────
// The node BOX only. Spacing and positions come from the server — these two are here
// because the SVG shape has to be drawn at some size, and that is a drawing decision.
const W = 190, H = 52;

function draw() {
  $("stat").textContent = current.status || "";
  drawGraph();
  drawGates();
  $("state").textContent = JSON.stringify(current.channels, null, 1);
}

function drawGraph() {
  const el = $("canvas");
  const g = current.graph;
  if (!g) { el.innerHTML = '<div class="empty">select a run</div>'; return; }

  // Collapse fan-out: N instances of one node render as ONE shape with a count.
  const byNode = new Map();
  for (const t of current.tasks.values()) {
    const acc = byNode.get(t.nodeId) || { count: 0, states: [], take: new Set() };
    acc.count++;
    acc.states.push(t.state);
    for (const e of t.take || []) acc.take.add(e);
    byNode.set(t.nodeId, acc);
  }
  const taken = new Set();
  for (const acc of byNode.values()) for (const e of acc.take) taken.add(e);

  // GEOMETRY COMES FROM THE SERVER, cached by graphHash alongside the structure. This
  // function turns numbers into SVG and decides nothing about where anything goes —
  // which is the whole content of "the browser never runs graph layout".
  const parts = [];
  parts.push('<svg viewBox="0 0 ' + g.width + ' ' + g.height + '" role="img" aria-label="execution graph">');
  parts.push('<defs><marker id="a" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 z" fill="var(--line)"/></marker></defs>');

  for (const e of g.edges) {
    const cls = "edge" + (taken.has(e.id) ? " taken" : "");
    parts.push('<path class="' + cls + '" d="M' + e.x1 + ' ' + e.y1 + ' C' + e.x1 + ' ' + e.midY + ' ' + e.x2 + ' ' + e.midY + ' ' + e.x2 + ' ' + e.y2 + '"/>');
  }

  for (const node of g.nodes) {
    const acc = byNode.get(node.id);
    const state = acc ? dominant(acc.states) : "";
    const count = acc ? acc.count : 0;
    parts.push('<g class="node ' + state + '" transform="translate(' + node.x + ',' + node.y + ')">');
    parts.push('<rect width="' + W + '" height="' + H + '" rx="9"/>');
    parts.push('<text x="12" y="21">' + esc(node.id) + '</text>');
    parts.push('<text class="sub" x="12" y="37">' + esc(node.type) + (state ? " · " + state : "") + '</text>');
    if (count > 1) {
      parts.push('<circle class="badge-bg" cx="' + (W - 18) + '" cy="18" r="11"/>');
      parts.push('<text class="badge" x="' + (W - 18) + '" y="22" text-anchor="middle">' + count + '</text>');
    }
    parts.push('</g>');
  }
  parts.push('</svg>');
  el.innerHTML = parts.join("");
}

/** One shape, many branches: show the most interesting state, not an average. */
function dominant(states) {
  for (const s of ["failed", "awaiting_gate", "leased", "ready", "cancelled", "skipped", "succeeded"]) {
    if (states.includes(s)) return s;
  }
  return states[0] || "";
}

function drawGates() {
  const el = $("gates");
  if (!current.gates.length) { el.innerHTML = '<div class="empty">no pending decisions</div>'; return; }
  el.innerHTML = "";
  for (const g of current.gates) {
    const d = document.createElement("div");
    d.className = "gate";
    d.innerHTML = '<div><strong>' + esc(g.nodeId) + '</strong></div><div class="meta">' + esc(g.gateId) + '</div>';
    const actions = document.createElement("div");
    actions.className = "actions";
    const yes = document.createElement("button");
    yes.className = "primary"; yes.textContent = "approve";
    yes.onclick = () => decide(g.gateId, { kind: "approve" });
    const no = document.createElement("button");
    no.className = "danger"; no.textContent = "reject";
    no.onclick = () => {
      const reason = prompt("Why are you rejecting this?");
      // A rejection without a reason is refused server-side; asking here keeps the
      // decision provenance meaningful rather than a shrug.
      if (reason) decide(g.gateId, { kind: "reject", reason });
    };
    actions.append(yes, no);
    d.appendChild(actions);
    el.appendChild(d);
  }
}

async function decide(gateId, decision) {
  try {
    const run = await api("/runs/" + selected + "/gates/" + gateId, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, actor: "console" }),
    });
    applySnapshot(run);
    invalidate();
  } catch (e) { alert(e.message); }
}

$("go").onclick = async () => {
  try {
    const body = { workflow: $("wf").value.trim(), inputs: JSON.parse($("in").value || "{}") };
    const r = await api("/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await loadRuns();
    await select(r.runId);
  } catch (e) { alert(e.message); }
};

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

api("/health").then((h) => {
  $("conn").textContent = h.auth === "open" ? "open" : "authorized";
  if (h.graphs?.length) $("wf").value = h.graphs[0];
});
loadRuns();
setInterval(loadRuns, 4000);
</script>
</body>
</html>`;
