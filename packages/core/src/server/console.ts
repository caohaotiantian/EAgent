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
 *
 * Four things here are not cosmetic:
 *
 *   - **The run controls are the goal's fifth verb, and the page had none.** "Install it,
 *     describe what they want done, have it run against a real provider, watch it, STOP it,
 *     and trust what it did" lists five verbs; this page implemented submit, watch and
 *     approve, and referenced `POST /runs/:id/commands` zero times. The only ways to stop a
 *     run were `curl` with a hand-copied run id and a hand-set bearer token, or `loom cancel`
 *     on the machine holding the journal. An emergency stop that requires curl is not an
 *     emergency stop, and the argument is the same one this file already makes about the
 *     approval queue. `pause` was worse than absent: `summarise` puts `paused` on the wire
 *     specifically so a console can render it, and `applySnapshot` dropped it, so a run
 *     paused from the CLI looked identical to one that had silently stalled. See
 *     `drawControls`, and the `run.suspended`/`run.resumed` arms of `applyEvent`.
 *   - **The oversight queue is read from `/runs/:id/gates`, not from the run summary.**
 *     Those are two different orderings of the same set: `summarise` sends
 *     `Object.values(p.gates)` — journal order — and only `/runs/:id/gates` carries D7.9
 *     row 5's rank, most urgent first. This page rendered the first one for as long as the
 *     rank existed, so the ordering was built, tested, and read by nobody. See `loadGates`
 *     for why it corrects rather than replaces.
 *   - **It carries a credential and claims no identity.** It used to post
 *     `actor: "console"` with no token at all, which meant every gate that named an
 *     approver answered the shipped UI with 403 while anyone hand-rolling the same POST
 *     could name whoever they liked. The page now sends `Authorization` and lets the
 *     server say who that is; `/whoami` is what it shows in the header.
 *   - **The stream is `fetch`, not `EventSource`.** `EventSource` cannot set a header,
 *     so the only way to authenticate it is a token in the query string — which lands in
 *     every access log and proxy trace between here and the browser. Reading the SSE
 *     framing by hand is thirty lines and keeps the credential in a header.
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
  .controls { display:flex; gap:6px; align-items:center; margin-bottom:10px; min-height:31px; }
  .controls .note { color:var(--muted); font-size:11px; }
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
  <input id="tok" type="password" placeholder="access token" autocomplete="off" style="width:190px">
  <span class="pill" id="who">nobody</span>
  <span class="pill" id="stat"></span>
</header>
<main>
  <section>
    <h2>Awaiting you</h2>
    <div id="mine"><div class="empty">nothing</div></div>
    <h2 style="margin-top:18px">Runs</h2>
    <div id="runs"><div class="empty">none yet</div></div>
    <h2 style="margin-top:18px">Start a run</h2>
    <label>workflow</label><input id="wf" placeholder="graph name">
    <label>inputs (JSON)</label><textarea id="in" rows="3">{}</textarea>
    <div style="margin-top:8px"><button id="go">submit</button></div>
  </section>

  <section>
    <h2>Graph</h2>
    <div id="controls" class="controls"></div>
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

// ── the credential ──────────────────────────────────────────────────────────
// The ONE place identity enters. Nothing below ever puts a name in a request body:
// the server reads the token and decides who that is, which is the only arrangement
// in which "u:security-lead approved this" means anything.
let token = localStorage.getItem("loom.token") || "";
const auth = () => (token ? { authorization: "Bearer " + token } : {});

const api = (p, o = {}) => fetch(p, { ...o, headers: { ...(o.headers || {}), ...auth() } }).then(async (r) => {
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || r.statusText);
  return body;
});

/**
 * A path built from ids the SERVER minted — every segment percent-encoded.
 *
 * A delegated run's id is the parent's id, a tilde, and a TaskId — and a TaskId is spelled
 * nodeId@branchPath#iteration, so a child run's id carries both an at-sign and a hash.
 * Concatenated raw into a URL the hash starts a fragment the browser never sends: the plane saw
 * /runs/<parent>~delegate@root and answered 404 E_ROUTE_NOT_FOUND — for a gate its own /gates
 * response had listed one request earlier, with approve and reject buttons rendered beside it.
 * Every by-id capture on the plane resolves through runIdIn, which decodes; this is the other
 * half of that pair, and it is the half that lives in the page.
 */
const path = (...segments) => "/" + segments.map(encodeURIComponent).join("/");

async function whoami() {
  try {
    const me = await api("/whoami");
    $("who").textContent = me.subject;
    $("who").title = me.canApproveNamedGates
      ? "gates that name approvers can be answered as " + me.subject
      : "this credential identifies no person, so gates naming approvers are refused";
  } catch (e) {
    $("who").textContent = "nobody";
    $("who").title = e.message;
  }
}

let selected = null;
let stream = null;
let lastSeq = 0;
/**
 * Which selection a stream belongs to.
 *
 * A run id is not enough: re-selecting the SAME run — which signing in does — would
 * otherwise leave the previous follower sleeping in its backoff, waking up, seeing its
 * run still selected, and opening a second stream that applies every event twice.
 */
let epoch = 0;
/** graphHash -> spec. Structure is fetched ONCE and cached; only deltas stream. */
const graphCache = new Map();
let current = { graph: null, tasks: new Map(), gates: [], channels: {}, status: "", paused: false };

// ── delta coalescing ────────────────────────────────────────────────────────
// 25 branches finishing at once must produce ONE repaint, not 25.
let pending = false;
function invalidate() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; draw(); }, 60);
}

// ── the questions addressed to this credential, across runs ─────────────────
//
// GET /runs is scoped to the SUBMITTER, and an approver is by construction somebody else —
// so without this panel the one workflow the console exists for is unreachable for exactly
// the person it is meant for: they would see an empty run list and no way to find the
// question waiting on them. GET /gates is the cross-run queue and it carries the rendered
// payload, because GET /runs/:id is closed to a non-owner and this is therefore the ONLY
// place the question can reach the person being asked.
async function loadMine() {
  const el = $("mine");
  let gates;
  try {
    ({ gates } = await api("/gates"));
  } catch (e) {
    el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (!gates.length) { el.innerHTML = '<div class="empty">nothing</div>'; return; }
  el.innerHTML = "";
  for (const g of gates) {
    const d = document.createElement("div");
    d.className = "row";
    // The deadline is journal data and may be anything; new Date(x).toISOString() throws a
    // RangeError on a non-date, and the try above covers only the fetch — so one bad row
    // would abort the panel mid-render and leave it half-drawn with no error anywhere.
    const due = Number.isFinite(g.deadline) ? new Date(g.deadline).toISOString().slice(11, 19) : null;
    d.innerHTML = '<code>' + esc(g.nodeId) + '</code><div class="meta">' + esc(String(g.runId).slice(0, 12)) +
      (due ? ' · due ' + due : '') + '</div>';
    const actions = document.createElement("div");
    actions.className = "meta";
    for (const kind of ["approve", "reject"]) {
      const b = document.createElement("button");
      b.textContent = kind;
      // Answered WHERE IT IS SHOWN. Routing through select() first would need
      // GET /runs/:id, which a non-owner cannot read — the panel would render and its
      // buttons would 404.
      b.onclick = () => decideOn(g.runId, g.gateId, kind === "approve" ? { kind: "approve" } : { kind: "reject", reason: "rejected from the console" });
      actions.appendChild(b);
    }
    d.appendChild(actions);
    el.appendChild(d);
  }
}

// ── run list ────────────────────────────────────────────────────────────────
async function loadRuns() {
  const el = $("runs");
  let runs;
  try {
    ({ runs } = await api("/runs"));
  } catch (e) {
    // A credentialed plane with no token entered is the FIRST thing a new operator
    // sees. Saying so beats an empty list and a console error nobody opens.
    el.innerHTML = '<div class="empty">' + esc(e.message) + '</div>';
    return;
  }
  if (!runs.length) { el.innerHTML = '<div class="empty">none yet</div>'; return; }
  el.innerHTML = "";
  for (const r of runs) {
    const d = document.createElement("div");
    d.className = "row" + (r.runId === selected ? " sel" : "");
    // esc() ON BOTH, like every other render site on this page. Run ids are engine-minted
    // ULIDs today, so this was safe by a property of the ID FORMAT rather than of the code —
    // and the format has already widened once (child run ids carry at-signs and hashes,
    // which is why runIdIn exists). This page holds the operator's token in localStorage and
    // approve buttons wired to it, so it is the highest-value XSS target in the product.
    d.innerHTML = '<code>' + esc(String(r.runId).slice(0, 12)) + '</code><div class="meta">' + esc(String(r.headSeq)) + ' events</div>';
    d.onclick = () => select(r.runId);
    el.appendChild(d);
  }
}

/**
 * The oversight queue, MOST URGENT FIRST — D7.9 row 5.
 *
 * GET /runs/:id carries the gates too, and in JOURNAL order: summarise() sends
 * Object.values(p.gates) and knows nothing about rank. GET /runs/:id/gates is the ranked
 * one, and it also carries each gate's rendered payload and deadline, which the run summary
 * does not. So the panel a human reads top-down is read from there.
 *
 * IT CORRECTS, IT NEVER BLANKS. applySnapshot still seeds current.gates from the run
 * summary, so a failure here degrades to the right SET in the wrong ORDER — which is what
 * this page did before it asked at all. Blanking the queue when one request fails would be
 * the "no pending decisions" lie, on the panel where that lie costs the most.
 *
 * mine is the same epoch guard follow() uses: a reply for a run the operator has already
 * navigated away from must not repaint the one they are looking at.
 *
 * WHAT THE EPOCH DOES NOT ORDER, said rather than left to be assumed: two calls for the SAME
 * selection can land out of order, and the loser overwrites with a list one gate stale. That
 * is bounded and self-correcting — every gate frame issues another fetch, and both answers
 * are ranked lists of the same run — so it is a limit and not a defect. If it ever needs to
 * be exact, the fix is a per-call token, not a wider epoch.
 */
async function loadGates(runId, mine) {
  try {
    const { gates } = await api(path("runs", runId, "gates"));
    if (selected !== runId || epoch !== mine || !Array.isArray(gates)) return;
    current.gates = gates;
    invalidate();
  } catch (e) { /* the seeded list stands */ }
}

async function select(runId) {
  selected = runId;
  const mine = ++epoch;
  lastSeq = 0;
  current = { graph: null, tasks: new Map(), gates: [], channels: {}, status: "", paused: false };
  if (stream) stream.abort();
  await loadRuns();

  const run = await api(path("runs", runId));
  applySnapshot(run);
  await ensureGraph(run.graphHash);
  await loadGates(runId, mine);

  lastSeq = run.seq;
  invalidate();
  // Resume from the seq we already have — the server replays gap-free from there,
  // or hands back a snapshot if we are outside the hot window.
  void follow(runId, mine);
}

/**
 * The event stream, over fetch so the credential can ride in a header.
 *
 * EventSource would be shorter and cannot carry one; the alternative is a token in the
 * query string, which is a credential written into every log between here and the
 * browser. This also gives us the reconnect that EventSource would have done for free —
 * hence the loop, which resumes from lastSeq and therefore cannot silently skip events.
 */
async function follow(runId, mine) {
  while (selected === runId && epoch === mine) {
    const ctrl = new AbortController();
    stream = ctrl;
    try {
      const res = await fetch(path("runs", runId, "events"), {
        headers: { accept: "text/event-stream", "last-event-id": String(lastSeq), ...auth() },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error("stream " + res.status);
      $("conn").textContent = "live";
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf("\n\n")) >= 0) {
          onFrame(buf.slice(0, cut));
          buf = buf.slice(cut + 2);
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
    }
    if (selected !== runId || epoch !== mine) return;
    $("conn").textContent = "reconnecting";
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** One SSE frame: id / event / data lines. */
function onFrame(raw) {
  let id, name, data;
  for (const line of raw.split("\n")) {
    if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("event: ")) name = line.slice(7);
    else if (line.startsWith("data: ")) data = JSON.parse(line.slice(6));
  }
  if (data === undefined) return;
  if (name === "snapshot") applySnapshot(data);
  else {
    if (id !== undefined) lastSeq = id;
    applyEvent(data);
  }
  invalidate();
  // RE-RANK WHENEVER THE QUEUE'S MEMBERSHIP CAN HAVE CHANGED. applyEvent appends a new
  // gate and removes a decided one, which keeps the SET right at 60 ms and cannot keep the
  // ORDER right — rank is a function of deadlines and batch sizes, not of arrival. A
  // snapshot replaces the whole list with the run summary's journal order and needs the same
  // correction. Only on those frames: task deltas are the high-frequency ones and they do
  // not touch the queue.
  if (name === "snapshot" || data.type === "gate.raised" || data.type === "gate.decided") void loadGates(selected, epoch);
}

function applySnapshot(run) {
  current.status = run.status;
  // A PAUSE IS NOT A STATUS, so it has to be read separately or it is not read at all.
  // summarise() sends this field for exactly this reason — "the operator who paused it has
  // no other way to confirm the pause landed" — and this line was missing, so the console
  // could not display a pause it also could not cause. A run paused while waiting on a gate
  // that has since been answered reads "running"; only this says otherwise.
  //
  // A SERVER THAT SENDS NOTHING READS AS "not paused", and that is the honest default here
  // rather than a convenient one: the field is a required boolean on the projection, so an
  // absent value means a plane too old to have the pause at all, and the button it renders
  // ("pause") is the one such a plane would accept.
  current.paused = run.paused === true;
  current.channels = run.channels || {};
  current.gates = (run.gates || []).filter((g) => g.state === "open");
  current.tasks = new Map((run.tasks || []).map((t) => [t.taskId, t]));
  current.graphHash = run.graphHash;
}

/**
 * The statuses nothing moves a run out of, and the events that would try.
 *
 * THE SAME RULE foldRun() APPLIES, and this page used to claim that and not have it. Its arms
 * were written as "the same two lines", which was true of the two lines they copied and not of
 * the guard those lines sit under: projection.ts refuses every RUN_STATUS_EVENT once the status
 * is terminal, because a cancel is not un-cancelled by a later timeout and a run does not succeed
 * after it failed. Without it a run.resumed arriving after run.cancelled — which the SLA sweeper
 * and a second operator can both produce — set the status back to "running", and drawControls()
 * put pause, advance and cancel back on the screen for a run that had ended. The page and the
 * journal then disagreed about the one fact the page exists to show.
 */
const TERMINAL = ["succeeded", "failed", "cancelled"];
const RUN_STATUS_EVENTS = ["run.started", "run.suspended", "run.resumed", "run.completed", "run.failed", "run.cancelled"];

/** Incremental application — the whole point of streaming deltas. */
function applyEvent(ev) {
  const p = ev.payload || {};
  if (RUN_STATUS_EVENTS.includes(ev.type) && TERMINAL.includes(current.status)) return;
  if (ev.type === "task.ready" && ev.taskId) {
    current.tasks.set(ev.taskId, { taskId: ev.taskId, nodeId: p.nodeId, state: "ready", take: [] });
  } else if (ev.type === "task.leased" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) t.state = "leased";
  } else if (ev.type === "task.committed" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) { t.state = p.status; t.take = p.take || []; }
  } else if (ev.type === "task.failed" && ev.taskId) {
    const t = current.tasks.get(ev.taskId); if (t) { t.state = "failed"; t.error = p.error; }
  } else if (ev.type === "task.skipped" && ev.taskId) {
    // A.45: THE SAME RULE projection.ts's fold APPLIES — upsertTask(p, e.taskId, { state:
    // "skipped" }), no more and no less. Before this arm existed, a branch a skip join
    // absorbed kept whatever state its preceding task.failed had left it in (failed) and
    // stayed there, so the live console over-reported severity in the one view whose job is
    // to show the worst thing in a collapsed fan-out — fail-safe (STATE_PRIORITY ranks
    // failed above skipped) but still a disagreement with GET /runs/:id.
    const t = current.tasks.get(ev.taskId); if (t) t.state = "skipped";
  } else if (ev.type === "task.cancelled" && ev.taskId) {
    // Same rule, same reason: upsertTask(p, e.taskId, { state: "cancelled" }). A task still
    // leased or awaiting_gate when its run was cancelled used to stay that way on screen
    // forever — the run showed cancelled while one of its tasks looked like it was still
    // going.
    const t = current.tasks.get(ev.taskId); if (t) t.state = "cancelled";
  } else if (ev.type === "task.retry_scheduled" && ev.taskId) {
    // Same rule again — projection.ts's arm sets state: "retrying". Without this a task
    // being retried after a deferral kept showing failed from the attempt that just ended.
    const t = current.tasks.get(ev.taskId); if (t) t.state = "retrying";
  } else if (ev.type === "state.reduced") {
    Object.assign(current.channels, p.values || {});
  } else if (ev.type === "gate.raised") {
    current.gates.push({ gateId: p.gateId, nodeId: p.nodeId, state: "open" });
    current.status = "awaiting_gate";
    // projection.ts's gate.raised arm also sets the RAISING TASK's own state to
    // awaiting_gate (upsertTask(p, e.taskId, { state: "awaiting_gate" })), not only the
    // run's. Without this line the gated node kept showing leased in the graph until it
    // was answered, disagreeing with the projection the whole time it was on screen.
    if (ev.taskId) { const t = current.tasks.get(ev.taskId); if (t) t.state = "awaiting_gate"; }
  } else if (ev.type === "gate.decided") {
    current.gates = current.gates.filter((g) => g.gateId !== p.gateId);
  } else if (ev.type === "run.suspended") {
    // What foldRun() does with this event, in this page's vocabulary; the terminal guard at the
    // top of this function is the rest of it. Without these a pause taken from the CLI, or from
    // another browser tab, changed nothing on screen: tasks simply
    // stopped appearing, which is indistinguishable from a stall. "interrupted" is
    // the status for every non-gate suspension, and only an OPERATOR's sets the pause —
    // budget and backoff suspend without anybody having decided anything.
    current.status = p.reason === "gate" ? "awaiting_gate" : "interrupted";
    if (p.reason === "operator") current.paused = true;
  } else if (ev.type === "run.resumed") {
    // And only an operator's resume clears it: the "by" field is "gate" for the broker's resume and
    // "timer" for the sweeper's, and neither is a human saying the run should carry on.
    current.status = "running";
    if (p.by === "operator") current.paused = false;
  } else if (ev.type === "run.completed") { current.status = "succeeded"; }
  else if (ev.type === "run.failed") { current.status = "failed"; }
  else if (ev.type === "run.cancelled") { current.status = "cancelled"; }
}

async function ensureGraph(hash) {
  if (graphCache.has(hash)) { current.graph = graphCache.get(hash); return; }
  const g = await api(path("graphs", "by-hash", hash)).catch(() => null);
  if (g) { graphCache.set(hash, g); current.graph = g; }
}

// ── rendering ───────────────────────────────────────────────────────────────
// The node BOX only. Spacing and positions come from the server — these two are here
// because the SVG shape has to be drawn at some size, and that is a drawing decision.
const W = 190, H = 52;

function draw() {
  $("stat").textContent = (current.status || "") + (current.paused ? " · paused" : "");
  drawControls();
  drawGraph();
  drawGates();
  $("state").textContent = JSON.stringify(current.channels, null, 1);
}

/**
 * STOP IT — the verb the goal sentence names and this page did not have.
 *
 * All three post the same body to POST /runs/:id/commands and all three come back with a run
 * summary, so applySnapshot(run) is the whole of the client half. The route already asks
 * ownsRun() and already refuses a non-human where it must; nothing here is a second check.
 *
 * WHY NOT steer AND rewind. Both are refused outright to a credential that is not a person,
 * and rewind needs the planHash handshake from GET /runs/:id/rewind-plan — a second screen,
 * not a button.
 *
 * WHY cancel PROMPTS. checkedReason() journals the value on operator.command and quotes it
 * into every gate the cancel closes, so a shrug default degrades real audit text. The reject
 * button already established this. It is also the confirmation: a second confirm() on top
 * would be a guard in front of a guard.
 *
 * WHY advance IS HERE AT ALL. It is the answer to a run that is ready and stalled, and it is
 * the one verb behind #bindFromIndex — so on a plane that does not hold the graph it 404s
 * with a message about binding. That message is shown unchanged rather than guessed at.
 */
function drawControls() {
  const el = $("controls");
  el.innerHTML = "";
  if (!selected) return;
  if (TERMINAL.includes(current.status)) {
    el.innerHTML = '<span class="note">' + esc(current.status) + ' · nothing left to stop</span>';
    return;
  }
  const add = (label, cls, run, title) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (cls) b.className = cls;
    if (title) b.title = title;
    b.onclick = run;
    el.appendChild(b);
  };
  if (current.paused) add("resume", "", () => command("resume", "resumed from the console"), "let this run take work again");
  else add("pause", "", () => command("pause", "paused from the console"), "stop leasing new work; nothing in flight is killed");
  add("advance", "", () => command("advance"), "offer ready tasks now — for a run that has stalled");
  add("cancel", "danger", () => {
    // The reason is journaled and quoted into every gate this closes, so it is asked for
    // rather than defaulted — and asking IS the confirmation.
    const reason = prompt("Why are you cancelling this run?");
    if (reason) command("cancel", reason);
  }, "stop this run and close its open gates");
}

/** One operator command. The response is a run summary, so the page reseeds from it. */
async function command(kind, reason) {
  try {
    const run = await api(path("runs", selected, "commands"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reason === undefined ? { kind } : { kind, reason }),
    });
    applySnapshot(run);
    invalidate();
    // The head moved, so the run list's event count is stale; the queue may have lost the
    // gates a cancel closed.
    await loadRuns();
    await loadGates(selected, epoch);
    await loadMine();
  } catch (e) { alert(e.message); }
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
    // WHO MAY ANSWER, shown next to the buttons. A queue that hides the approvers list
    // is a queue where "why was I refused?" is answered by a 403 and nothing else.
    const named = (g.approvers || []).length ? " · needs " + esc((g.approvers || []).join(", ")) : "";
    d.innerHTML = '<div><strong>' + esc(g.nodeId) + '</strong></div><div class="meta">' + esc(g.gateId) + named + '</div>';
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

// One decision, addressed by run — the form the cross-run queue needs, since it holds gates
// from runs that are not the selected one and may not be selectable at all.
async function decideOn(runId, gateId, decision) {
  try {
    await api(path("runs", runId, "gates", gateId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await loadMine();
    if (runId === selected) await loadGates(selected, epoch);
  } catch (e) { alert(e.message); }
}

async function decide(gateId, decision) {
  try {
    // NO actor field. The server takes the decider's subject from the credential this
    // request carries; a name typed here would be a claim it refuses, and rightly.
    const run = await api(path("runs", selected, "gates", gateId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    applySnapshot(run);
    invalidate();
    // The response is a run summary, so it reseeds the queue in journal order — the same
    // correction the snapshot frame needs, for the same reason.
    await loadGates(selected, epoch);
    await loadMine();
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

// Signing in is one field. It re-asks who we are, reloads what the credential can see,
// and reconnects the stream — the token is only ever sent as a header.
$("tok").value = token;
$("tok").onchange = async () => {
  token = $("tok").value.trim();
  localStorage.setItem("loom.token", token);
  await whoami();
  await loadRuns();
  await loadMine();
  // Entering a token backfills the box a pre-credential 401 left empty.
  await loadGraphs();
  if (selected) await select(selected);
};

// The graph names come from the CREDENTIALED route, not from /health. /health is a
// liveness probe reachable without a credential, and the list of workflows a deployment
// can run is not a liveness fact — it names the business actions this plane takes. Before
// a credential is entered this 401s, which is the answer, not an error to shout about:
// the operator has one field to fill in and the page already says so.
async function loadGraphs() {
  // Never over a name the operator has already typed. The load is async and the field is
  // editable from the first paint, so the only safe write is into an empty box.
  if ($("wf").value) return;
  try {
    const { graphs } = await api("/graphs");
    if (graphs.length && !$("wf").value) $("wf").value = graphs[0].name;
  } catch { /* no credential yet, or none this credential may see */ }
}

api("/health").then((h) => {
  $("conn").textContent = h.auth === "open" ? "open" : "authorized";
  // On the input rather than the identity pill, which whoami owns — two writers on one
  // element is a race whose loser is whichever request was slower.
  if (!h.identity) $("tok").placeholder = "no identity source";
});
whoami();
loadRuns();
loadGraphs();
// ONE TICK FOR BOTH, not two timers. Two independent intervals drift into pairs and double
// the request rate, and the expensive half is /gates — which folds every candidate run.
setInterval(() => { void loadRuns(); void loadMine(); }, 4000);
</script>
</body>
</html>`;
