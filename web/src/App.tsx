import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyControl,
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
  getSession,
  listSessions,
  loadToken,
  postAnswer,
  runTurn,
  saveToken,
  stopSession,
  subscribeSessionEvents,
} from "./api/client.js";
import { agentStatuses, mergeSessionList } from "./chat/agents.js";
import { reduceAsk, type AskState } from "./chat/ask-state.js";
import { hydrateFromMessages, type ChatTurn } from "./chat/history.js";
import { newSessionId, planClear, planSwitchSession, shouldAcceptFrame } from "./chat/session.js";
import { JsonView } from "./ui/json-view.js";
import { Markdown } from "./ui/markdown.js";

type Route = "chat" | "monitor";
type Turn = ChatTurn;

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
            ? s.name
            : `${estTokens(s.text)} tok`}
          {s.kind !== "tool" && s.actingId !== s.rootId ? ` · ${shortId(s.actingId)}` : ""}
          {s.kind === "tool" && s.actingId !== s.rootId ? ` · agent ${shortId(s.actingId)}` : ""}
        </span>
        <span className={`card-status ${st.cls}`}>{st.text}</span>
        <span className="card-status" style={{ color: "var(--muted)" }}>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="card-body">
          {s.kind === "answer" ? (
            <Markdown text={s.text} />
          ) : s.kind === "reasoning" ? (
            <div className="pre reasoning-body">{s.text}</div>
          ) : (
            <>
              <div className="tool-label">arguments</div>
              <JsonView value={s.arguments} />
              {s.result && (
                <>
                  <div className="tool-label">{s.result.isError ? "error output" : "output"}</div>
                  <div className="pre">{s.result.content}</div>
                </>
              )}
            </>
          )}
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
        className="ask-input"
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

function AgentPanel({ sections, rootId }: { sections: Section[]; rootId?: string }) {
  const agents = useMemo(() => agentStatuses(sections, rootId), [sections, rootId]);
  if (agents.length === 0) {
    return <div className="agent-empty">No agent activity yet this session.</div>;
  }
  return (
    <ul className="agent-list">
      {agents.map((a) => (
        <li key={a.id} className={`agent-item${a.streaming ? " agent-live" : ""}`}>
          <div className="agent-head">
            <span className="agent-name">{a.isRoot ? "Root agent" : `Sub-agent`}</span>
            <code className="agent-id">{shortId(a.id)}</code>
            {a.streaming ? <span className="pill live">working</span> : <span className="pill">idle</span>}
          </div>
          <div className="agent-stats">
            tools {a.toolsDone} done
            {a.toolsRunning > 0 ? ` · ${a.toolsRunning} running` : ""}
            {a.toolsError > 0 ? ` · ${a.toolsError} err` : ""}
          </div>
          {a.labels.length > 0 && (
            <div className="agent-tools">
              {a.labels.slice(0, 6).map((n) => (
                <span key={n} className="tool-chip">
                  {n}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<AskState>({ kind: "idle" });
  const [sessions, setSessions] = useState<
    Array<{ id: string; running: boolean; usage: { inputTokens: number; outputTokens: number }; costUsd: number }>
  >([]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ViewModel>(() => initialModel("auto"));
  const [showAgents, setShowAgents] = useState(true);
  /** Banner after switching into an existing server session from Sessions. */
  const [resumeNote, setResumeNote] = useState<string | null>(null);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (nearBottom || running) el.scrollTop = el.scrollHeight;
  }, [model.sections, turns, running, ask]);

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
    const t = setInterval(() => void refreshSessions(), 3000);
    const onFocus = () => void refreshSessions();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [route, refreshSessions]);

  // Keep monitor list fresh while chatting so current session appears after first run
  useEffect(() => {
    if (route !== "chat") return;
    void refreshSessions().catch(() => {});
  }, [route, sessionId, running, refreshSessions]);

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
    setTurns((t) => [
      ...t,
      { id: `${Date.now()}`, user: text, sectionFrom: model.sections.length },
    ]);
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
      void refreshSessions().catch(() => {});
    }
  }

  async function onClear() {
    const plan = planClear(sessionId, generation);
    abortRef.current?.abort();
    setSessionId(plan.currentId);
    setGeneration(plan.generation);
    setModel(initialModel(model.mode));
    setTurns([]);
    setAsk(reduceAsk(ask, { type: "clear" }));
    setError(null);
    setResumeNote(null);
    try {
      await stopSession(token, plan.previousId).catch(() => {});
      await deleteSession(token, plan.previousId).catch(() => {});
    } catch {
      /* best-effort */
    }
    void refreshSessions().catch(() => {});
  }

  /**
   * Bind Chat to an existing session and hydrate the transcript from
   * GET /sessions/:id (messages + usage). Further sends continue that session.
   */
  async function switchToSession(targetId: string, opts: { fromMonitor?: boolean } = {}) {
    if (!targetId) return;

    if (targetId === sessionId && opts.fromMonitor) {
      setDetailId(null);
      go("chat");
      // Re-fetch history in case the server advanced while we were on monitor.
      try {
        const detail = await getSession(token, targetId);
        const hydrated = hydrateFromMessages(detail.messages, model.mode);
        setTurns(hydrated.turns);
        setModel(hydrated.model);
        setResumeNote(
          `Session ${shortId(targetId)} · ${detail.messages.length} message(s) loaded. Continue below.`,
        );
      } catch {
        setResumeNote(`Already on session ${shortId(targetId)}.`);
      }
      return;
    }
    if (targetId === sessionId) return;

    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);

    const plan = planSwitchSession(sessionId, targetId, generation);
    setSessionId(plan.currentId);
    setGeneration(plan.generation);
    setAsk({ kind: "idle" });
    setError(null);
    setInput("");
    setDetailId(null);
    go("chat");

    try {
      const detail = await getSession(token, targetId);
      const hydrated = hydrateFromMessages(detail.messages, model.mode);
      setTurns(hydrated.turns);
      setModel(hydrated.model);
      const nUser = hydrated.turns.length;
      setResumeNote(
        `Loaded session ${shortId(targetId)} · ${detail.messages.length} message(s), ${nUser} user turn(s). Continue the conversation below.`,
      );
    } catch (e) {
      setTurns([]);
      setModel(initialModel(model.mode));
      setError(e instanceof Error ? e.message : String(e));
      setResumeNote(
        `Switched to ${shortId(targetId)} but history could not be loaded (session missing or unauthorized). New messages still use this id if the server accepts it.`,
      );
    }
    void refreshSessions().catch(() => {});
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
  const empty = turns.length === 0 && model.sections.length === 0;

  const sessionRows = useMemo(
    () => mergeSessionList(sessions, sessionId, running),
    [sessions, sessionId, running],
  );

  const go = (r: Route) => {
    location.hash = r === "monitor" ? "#/monitor" : "#/";
    setRoute(r);
    setSidebarOpen(false);
    if (r === "monitor") void refreshSessions();
  };

  const resizeTa = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  /** Sections belonging to turn i (until next turn or end). */
  const sectionsForTurn = (i: number): Section[] => {
    const from = turns[i]!.sectionFrom;
    const to = i + 1 < turns.length ? turns[i + 1]!.sectionFrom : model.sections.length;
    return model.sections.slice(from, to);
  };

  // Orphan sections before first turn (shouldn't happen) — show under agent
  const orphanSections = turns.length === 0 ? model.sections : model.sections.slice(0, turns[0]!.sectionFrom);

  return (
    <div className={`shell${sidebarOpen ? " sidebar-open" : ""}${showAgents && route === "chat" ? " with-agents" : ""}`}>
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
          <div className={`session-chip${running ? " live-chip" : ""}`} title={sessionId}>
            {running ? "● " : ""}session {shortId(sessionId)}
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
              {route === "chat" ? "Multi-agent transcript · shared view-model" : "Live multi-session monitor"}
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
                <button
                  type="button"
                  className={`btn btn-ghost${showAgents ? " btn-active" : ""}`}
                  onClick={() => setShowAgents((v) => !v)}
                  title="Toggle agent status panel"
                >
                  Agents
                </button>
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

        {resumeNote && (
          <div className="banner banner-info" role="status">
            {resumeNote}
            <button
              type="button"
              className="btn btn-ghost"
              style={{ marginLeft: 8, padding: "0.15rem 0.45rem" }}
              onClick={() => setResumeNote(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        {route === "chat" && (
          <div className="chat-layout">
            <div className="chat-col">
              <div className="transcript" ref={scrollRef}>
                <div className="transcript-inner">
                  {empty && (
                    <div className="empty">
                      <div className="empty-icon">✦</div>
                      <h2>What should we work on?</h2>
                      <p>
                        Turns stream over <code>POST /run</code>. Sub-agents appear nested when the server tags{" "}
                        <code>actingId</code> — open <strong>Agents</strong> or <strong>Sessions</strong> for live status.
                      </p>
                    </div>
                  )}

                  {orphanSections.length > 0 && (
                    <div className="msg">
                      <div className="avatar avatar-agent">E</div>
                      <div className="msg-body" style={{ maxWidth: "100%", flex: 1 }}>
                        <div className="stack">
                          {orphanSections.map((s, i) => (
                            <SectionCard
                              key={s.id}
                              s={s}
                              onToggleTop={() =>
                                setModel((m) =>
                                  applyControl(m, { kind: s.collapsed ? "expand" : "collapse", n: i + 1 }),
                                )
                              }
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {turns.map((turn, ti) => {
                    const secs = sectionsForTurn(ti);
                    const globalOffset = turn.sectionFrom;
                    return (
                      <div key={turn.id} className="turn">
                        <div className="msg msg-user">
                          <div className="avatar avatar-user">You</div>
                          <div className="msg-body">
                            <div className="msg-label">You</div>
                            <div className="bubble bubble-user">{turn.user}</div>
                          </div>
                        </div>
                        {(secs.length > 0 || (ti === turns.length - 1 && running)) && (
                          <div className="msg">
                            <div className="avatar avatar-agent">E</div>
                            <div className="msg-body" style={{ maxWidth: "100%", flex: 1 }}>
                              <div className="msg-label">EAgent</div>
                              <div className="stack">
                                {secs.map((s, i) => (
                                  <SectionCard
                                    key={s.id}
                                    s={s}
                                    onToggleTop={() =>
                                      setModel((m) =>
                                        applyControl(m, {
                                          kind: s.collapsed ? "expand" : "collapse",
                                          n: globalOffset + i + 1,
                                        }),
                                      )
                                    }
                                  />
                                ))}
                                {ti === turns.length - 1 && running && secs.length === 0 && (
                                  <div className="thinking-hint">
                                    <span className="pill live">Thinking</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

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
            </div>

            {showAgents && (
              <aside className="agents-panel">
                <div className="agents-head">
                  <h2>Agents</h2>
                  <span className="muted" style={{ fontSize: "0.75rem" }}>
                    work status
                  </span>
                </div>
                <AgentPanel sections={model.sections} rootId={model.rootId} />
              </aside>
            )}
          </div>
        )}

        {route === "monitor" && (
          <div className="monitor">
            <div className={`monitor-grid${detailId ? " split" : ""}`}>
              <div className="panel">
                <div className="panel-head">
                  <h2>Live sessions</h2>
                  <span className="pill" style={{ marginLeft: "auto" }}>
                    {sessionRows.length} total
                  </span>
                </div>
                <div className="panel-body">
                  {sessionRows.length === 0 ? (
                    <div className="empty-list">No sessions yet. Start a chat to create one.</div>
                  ) : (
                    <ul className="session-list">
                      {sessionRows.map((s) => (
                        <li key={s.id} className={`session-item${s.current ? " session-current" : ""}`}>
                          <div className="session-title-row">
                            <button
                              type="button"
                              className="session-id"
                              title="Open in Chat, load history, and continue"
                              onClick={() => void switchToSession(s.id, { fromMonitor: true })}
                            >
                              {s.id}
                            </button>
                            {s.current && <span className="pill current-pill">this chat</span>}
                            {s.localOnly && <span className="pill">local</span>}
                          </div>
                          <div className="session-stats">
                            {s.running ? <span className="pill live">running</span> : <span className="pill">idle</span>}
                            {" · "}
                            in {s.usage.inputTokens} / out {s.usage.outputTokens}
                            {" · "}${s.costUsd.toFixed(4)}
                          </div>
                          <div className="session-actions">
                            <button
                              type="button"
                              className="btn btn-primary"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              onClick={() => void switchToSession(s.id, { fromMonitor: true })}
                            >
                              {s.current ? "Open chat" : "Continue"}
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              onClick={() => setDetailId(s.id)}
                            >
                              Watch
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              disabled={s.localOnly && !s.running}
                              onClick={() => void stopSession(token, s.id).then(refreshSessions)}
                            >
                              Stop
                            </button>
                            <button
                              type="button"
                              className="btn btn-ghost"
                              style={{ fontSize: "0.75rem", padding: "0.3rem 0.5rem" }}
                              disabled={s.localOnly}
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
                  <div className="agents-inline">
                    <AgentPanel sections={detailModel.sections} rootId={detailModel.rootId} />
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

