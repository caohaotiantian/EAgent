import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyControl,
  bodyLines,
  estTokens,
  headerLine,
  initialModel,
  reduce,
  type DisplayMode,
  type Section,
  type ViewModel,
} from "@eagent/view-model";
import type { SourceEvent } from "@eagent/wire-events";
import {
  deleteSession,
  getHealth,
  listSessions,
  loadToken,
  postAnswer,
  runTurn,
  saveToken,
  stopSession,
  subscribeSessionEvents,
  type SessionRow,
} from "./api/client.js";
import { reduceAsk, type AskState } from "./chat/ask-state.js";
import { newSessionId, planClear, shouldAcceptFrame } from "./chat/session.js";

type Route = "chat" | "monitor";

function routeFromHash(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  return h.startsWith("monitor") ? "monitor" : "chat";
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function statusLabel(s: Section): { text: string; cls: string } {
  if (s.status === "error") return { text: "error", cls: "err" };
  if (s.status === "success") return { text: "done", cls: "ok" };
  return { text: "live", cls: "run" };
}

function kindLabel(s: Section): string {
  if (s.kind === "reasoning") return "Think";
  if (s.kind === "answer") return "Answer";
  return "Tool";
}

function SectionCard({
  s,
  depth = 0,
  onToggleTop,
}: {
  s: Section;
  depth?: number;
  /** Top-level only: parent drives expand via view-model controls */
  onToggleTop?: () => void;
}) {
  const [localOpen, setLocalOpen] = useState(!s.collapsed);
  const isTop = depth === 0 && onToggleTop;
  const open = isTop ? !s.collapsed : localOpen;
  const st = statusLabel(s);

  const toggle = () => {
    if (isTop && onToggleTop) onToggleTop();
    else setLocalOpen((v) => !v);
  };

  return (
    <div className={`card card-${s.kind}${s.status === "error" ? " card-error" : ""}`}>
      <button type="button" className="card-head" onClick={toggle} aria-expanded={open}>
        <span className="card-kind">{kindLabel(s)}</span>
        <span className="card-title" title={headerLine(s)}>
          {s.kind === "tool"
            ? `${s.name}${
                Object.keys(s.arguments).length > 0
                  ? ` · ${Object.keys(s.arguments).slice(0, 2).join(", ")}${Object.keys(s.arguments).length > 2 ? "…" : ""}`
                  : ""
              }`
            : `${estTokens(s.text)} tok`}
        </span>
        <span className={`card-status ${st.cls}`}>{st.text}</span>
        <span className="card-status" style={{ color: "var(--muted)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="card-body">
          <div className="pre">
            {bodyLines(s).map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
          {s.children.length > 0 && (
            <div className="card-children">
              {s.children.map((c) => (
                <SectionCard key={c.id} s={c} depth={depth + 1} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AskFreeText({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="chip-row" style={{ width: "100%" }}>
      <input
        style={{
          flex: 1,
          minWidth: "12rem",
          padding: "0.45rem 0.65rem",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--bg-elevated)",
        }}
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder="Type your answer…"
        onKeyDown={(e) => {
          if (e.key === "Enter" && v.trim()) onSubmit(v.trim());
        }}
      />
      <button type="button" className="btn btn-primary" disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>
        Submit
      </button>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [token, setToken] = useState(loadToken);
  const [authRequired, setAuthRequired] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [sessionId, setSessionId] = useState(newSessionId);
  const [generation, setGeneration] = useState(0);
  const [model, setModel] = useState<ViewModel>(() => initialModel("auto"));
  const [userBubbles, setUserBubbles] = useState<{ id: string; text: string }[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState>({ kind: "idle" });
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ViewModel>(() => initialModel("auto"));
  const abortRef = useRef<AbortController | null>(null);
  const boundRef = useRef({ session: sessionId, generation });
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    boundRef.current = { session: sessionId, generation };
  }, [sessionId, generation]);

  useEffect(() => {
    const onHash = () => {
      setRoute(routeFromHash());
      setSidebarOpen(false);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void getHealth(token)
      .then((h) => setAuthRequired(h.auth === "required"))
      .catch(() => setAuthRequired(false));
  }, [token]);

  // Auto-scroll transcript when content grows (ChatGPT / Open WebUI pattern)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || running) el.scrollTop = el.scrollHeight;
  }, [model.sections, userBubbles, running, ask]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await listSessions(token));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [token]);

  useEffect(() => {
    if (route !== "monitor") return;
    void refreshSessions();
    const t = setInterval(() => void refreshSessions(), 5000);
    const onFocus = () => void refreshSessions();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [route, refreshSessions]);

  useEffect(() => {
    if (!detailId) return;
    const ac = new AbortController();
    setDetailModel(initialModel("auto"));
    void (async () => {
      try {
        for await (const ev of subscribeSessionEvents(token, detailId, ac.signal)) {
          if (
            ev.kind === "connected" ||
            ev.kind === "reconnected" ||
            ev.kind === "usage" ||
            ev.kind === "error" ||
            ev.kind === "action_required"
          ) {
            continue;
          }
          setDetailModel((m) => reduce(m, ev));
        }
      } catch {
        /* aborted */
      }
    })();
    return () => ac.abort();
  }, [detailId, token]);

  const applyEvent = useCallback((ev: SourceEvent, boundSession: string, boundGen: number) => {
    if (!shouldAcceptFrame(boundSession, boundGen, boundRef.current.session, boundRef.current.generation)) return;
    if (ev.kind === "action_required") {
      setAsk((s) => reduceAsk(s, { type: "show", ask: { id: ev.id, question: ev.question, options: ev.options } }));
      return;
    }
    if (ev.kind === "connected" || ev.kind === "reconnected" || ev.kind === "usage" || ev.kind === "error") {
      if (ev.kind === "error") setError(ev.message);
      setAsk((s) => (s.kind === "pending" ? reduceAsk(s, { type: "stream_frame" }) : s));
      return;
    }
    setAsk((s) => (s.kind === "pending" ? reduceAsk(s, { type: "stream_frame" }) : s));
    setModel((m) => reduce(m, ev));
  }, []);

  async function onSend() {
    const text = input.trim();
    if (!text || running) return;
    setInput("");
    setError(null);
    setUserBubbles((b) => [...b, { id: `${Date.now()}`, text }]);
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    const boundSession = sessionId;
    const boundGen = generation;
    try {
      const gen = runTurn(token, sessionId, text, ac.signal);
      let step = await gen.next();
      while (!step.done) {
        applyEvent(step.value, boundSession, boundGen);
        step = await gen.next();
      }
      const result = step.value;
      if (!result.ok) {
        setError(result.busy ? "Session busy (409) — wait for the current turn." : result.error);
      }
    } finally {
      setRunning(false);
      setAsk((s) => reduceAsk(s, { type: "stream_end" }));
      abortRef.current = null;
      taRef.current?.focus();
    }
  }

  async function onClear() {
    const plan = planClear(sessionId, generation);
    abortRef.current?.abort();
    setSessionId(plan.currentId);
    setGeneration(plan.generation);
    setModel(initialModel(model.mode));
    setUserBubbles([]);
    setAsk(reduceAsk(ask, { type: "clear" }));
    setError(null);
    try {
      await stopSession(token, plan.previousId).catch(() => {});
      await deleteSession(token, plan.previousId).catch(() => {});
    } catch {
      /* best-effort */
    }
  }

  async function onStop() {
    try {
      await stopSession(token, sessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    abortRef.current?.abort();
    setAsk((s) => reduceAsk(s, { type: "stop" }));
    setRunning(false);
  }

  async function onAnswer(text: string) {
    if (ask.kind !== "pending") return;
    const res = await postAnswer(token, ask.ask.id, text);
    if (res.status === "resolved") setAsk(reduceAsk(ask, { type: "resolved" }));
    else if (res.status === "gone") {
      setAsk(reduceAsk(ask, { type: "gone" }));
      setError("Elicitation no longer pending (timeout or already answered).");
    } else {
      setAsk(reduceAsk(ask, { type: "retry_error" }));
      setError(res.error);
    }
  }

  const mode = model.mode;
  const setMode = (m: DisplayMode) => setModel((prev) => applyControl(prev, { kind: "mode", mode: m }));
  const topSections = useMemo(() => model.sections, [model.sections]);
  const empty = userBubbles.length === 0 && topSections.length === 0;

  const go = (r: Route) => {
    location.hash = r === "monitor" ? "#/monitor" : "#/";
    setRoute(r);
    setSidebarOpen(false);
  };

  const resizeTa = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  return (
    <div className={`shell${sidebarOpen ? " sidebar-open" : ""}`}>
      <button type="button" className="sidebar-backdrop" aria-label="Close menu" onClick={() => setSidebarOpen(false)} />

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div className="brand-text">
            <strong>EAgent</strong>
            <span>Agent workspace</span>
          </div>
        </div>

        <nav className="nav">
          <button type="button" className={`nav-item${route === "chat" ? " active" : ""}`} onClick={() => go("chat")}>
            <span className="ico">💬</span> Chat
          </button>
          <button type="button" className={`nav-item${route === "monitor" ? " active" : ""}`} onClick={() => go("monitor")}>
            <span className="ico">📡</span> Sessions
          </button>
        </nav>

        <div className="sidebar-foot">
          <div className="session-chip" title={sessionId}>
            session {shortId(sessionId)}
          </div>
          <div className="token-row">
            <label>API token</label>
            {token ? (
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "100%" }}
                onClick={() => {
                  saveToken("");
                  setToken("");
                }}
              >
                Log out
              </button>
            ) : (
              <span className="muted" style={{ fontSize: "0.75rem" }}>
                {authRequired ? "Required by server" : "Optional"}
              </span>
            )}
          </div>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <button type="button" className="menu-btn" aria-label="Menu" onClick={() => setSidebarOpen(true)}>
            ☰
          </button>
          <div>
            <div className="topbar-title">{route === "chat" ? "Chat" : "Sessions"}</div>
            <div className="topbar-meta">
              {route === "chat" ? "Streaming transcript · view-model sections" : "Live multi-session monitor"}
            </div>
          </div>
          <div className="topbar-actions">
            {running && (
              <span className="pill live" aria-live="polite">
                Running
              </span>
            )}
            {route === "chat" && (
              <>
                <select className="select" value={mode} onChange={(e) => setMode(e.target.value as DisplayMode)} title="Display mode">
                  <option value="auto">Auto collapse</option>
                  <option value="full">Expand all</option>
                  <option value="collapsed">Headers only</option>
                </select>
                <button type="button" className="btn btn-ghost" onClick={() => void onClear()}>
                  New chat
                </button>
                <button type="button" className="btn btn-danger" disabled={!running} onClick={() => void onStop()}>
                  Stop
                </button>
              </>
            )}
            {route === "monitor" && (
              <button type="button" className="btn btn-ghost" onClick={() => void refreshSessions()}>
                Refresh
              </button>
            )}
          </div>
        </div>

        {authRequired && !token && (
          <div className="banner banner-auth">
            <strong>Authentication required</strong>
            <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginTop: 4 }}>
              Enter the same value as <code>EAGENT_TOKEN</code>. Stored in sessionStorage only.
            </div>
            <div className="row">
              <input
                type="password"
                placeholder="Bearer token"
                value={tokenDraft}
                onChange={(e) => setTokenDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tokenDraft.trim()) {
                    saveToken(tokenDraft.trim());
                    setToken(tokenDraft.trim());
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  saveToken(tokenDraft.trim());
                  setToken(tokenDraft.trim());
                }}
              >
                Continue
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="banner banner-error" role="alert">
            {error}
            <button type="button" className="btn btn-ghost" style={{ marginLeft: 8, padding: "0.15rem 0.45rem" }} onClick={() => setError(null)}>
              Dismiss
            </button>
          </div>
        )}

        {route === "chat" && (
          <>
            <div className="transcript" ref={scrollRef}>
              <div className="transcript-inner">
                {empty && (
                  <div className="empty">
                    <div className="empty-icon">✦</div>
                    <h2>What should we work on?</h2>
                    <p>
                      Messages stream over <code>POST /run</code>. Reasoning, answers, and tools render as collapsible cards — same
                      view-model as the CLI.
                    </p>
                  </div>
                )}

                {/* Interleave is approximate: users first, then agent stack for the turn.
                    Multi-turn: all users then cumulative sections — acceptable for v1 polish. */}
                {userBubbles.map((b) => (
                  <div key={b.id} className="msg msg-user">
                    <div className="avatar avatar-user">You</div>
                    <div className="msg-body">
                      <div className="msg-label">You</div>
                      <div className="bubble bubble-user">{b.text}</div>
                    </div>
                  </div>
                ))}

                {topSections.length > 0 && (
                  <div className="msg">
                    <div className="avatar avatar-agent">E</div>
                    <div className="msg-body" style={{ maxWidth: "100%", flex: 1 }}>
                      <div className="msg-label">EAgent</div>
                      <div className="stack">
                        {topSections.map((s, i) => (
                          <SectionCard
                            key={s.id}
                            s={s}
                            onToggleTop={() =>
                              setModel((m) =>
                                applyControl(m, {
                                  kind: s.collapsed ? "expand" : "collapse",
                                  n: i + 1,
                                }),
                              )
                            }
                          />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {ask.kind === "pending" && (
                  <div className="ask-card">
                    <h3>Question for you</h3>
                    <p>{ask.ask.question}</p>
                    {ask.ask.options && ask.ask.options.length > 0 ? (
                      <div className="chip-row">
                        {ask.ask.options.map((o) => (
                          <button key={o} type="button" className="chip" onClick={() => void onAnswer(o)}>
                            {o}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <AskFreeText onSubmit={(t) => void onAnswer(t)} />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="composer-wrap">
              <div className="composer">
                <textarea
                  ref={taRef}
                  value={input}
                  rows={1}
                  placeholder="Message EAgent…"
                  disabled={running || ask.kind === "pending"}
                  onChange={(e) => {
                    setInput(e.target.value);
                    resizeTa();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void onSend();
                    }
                  }}
                />
                <div className="composer-bar">
                  <span className="composer-hint">Enter to send · Shift+Enter newline</span>
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={running || ask.kind === "pending" || !input.trim()}
                    onClick={() => void onSend()}
                  >
                    Send
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {route === "monitor" && (
          <div className="monitor">
            <div className={`monitor-grid${detailId ? " split" : ""}`}>
              <div className="panel">
                <div className="panel-head">
                  <h2>Live sessions</h2>
                  <span className="pill" style={{ marginLeft: "auto" }}>
                    {sessions.length} total
                  </span>
                </div>
                <div className="panel-body">
                  {sessions.length === 0 ? (
                    <div className="empty-list">No sessions yet. Start a chat to create one.</div>
                  ) : (
                    <ul className="session-list">
                      {sessions.map((s) => (
                        <li key={s.id} className="session-item">
                          <button type="button" className="session-id" onClick={() => setDetailId(s.id)}>
                            {s.id}
                          </button>
                          <div className="session-stats">
                            {s.running ? <span className="pill live">running</span> : <span className="pill">idle</span>}
                            {" · "}
                            in {s.usage.inputTokens} / out {s.usage.outputTokens}
                            {" · "}${s.costUsd.toFixed(4)}
                          </div>
                          <div className="session-actions">
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              onClick={() => void stopSession(token, s.id).then(refreshSessions)}
                            >
                              Stop
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              onClick={() => void deleteSession(token, s.id).then(refreshSessions)}
                            >
                              Forget
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>

              {detailId && (
                <div className="panel">
                  <div className="panel-head">
                    <h2>Live stream</h2>
                    <code className="muted" style={{ fontSize: "0.75rem" }}>
                      {shortId(detailId)}
                    </code>
                    <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto" }} onClick={() => setDetailId(null)}>
                      Close
                    </button>
                  </div>
                  <div className="detail-stream">
                    {detailModel.sections.length === 0 ? (
                      <div className="empty-list">Waiting for events on this session…</div>
                    ) : (
                      detailModel.sections.map((s) => <SectionCard key={s.id} s={s} />)
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
