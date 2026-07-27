import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyControl,
  bodyLines,
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

function SectionView({ s, onToggle }: { s: Section; onToggle: () => void }) {
  return (
    <div className={`section ${s.kind}${s.status === "error" ? " error" : ""}`}>
      <div className="sec-head" onClick={onToggle} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        {headerLine(s)}
      </div>
      {!s.collapsed && (
        <div className="pre">
          {bodyLines(s).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {s.children.map((c) => (
            <SectionView key={c.id} s={c} onToggle={() => {}} />
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(routeFromHash);
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

  useEffect(() => {
    boundRef.current = { session: sessionId, generation };
  }, [sessionId, generation]);

  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    void getHealth(token)
      .then((h) => setAuthRequired(h.auth === "required"))
      .catch(() => setAuthRequired(false));
  }, [token]);

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
          if (ev.kind === "connected" || ev.kind === "reconnected" || ev.kind === "usage" || ev.kind === "error" || ev.kind === "action_required") {
            continue;
          }
          setDetailModel((m) => reduce(m, ev));
        }
      } catch {
        /* aborted or closed */
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

  return (
    <div className="app">
      <header>
        <strong>EAgent</strong>
        <a href="#/" className={route === "chat" ? "active" : ""} onClick={() => setRoute("chat")}>
          Chat
        </a>
        <a href="#/monitor" className={route === "monitor" ? "active" : ""} onClick={() => setRoute("monitor")}>
          Monitor
        </a>
        <span className="muted" style={{ marginLeft: "auto" }}>
          session {sessionId.slice(0, 8)}…
        </span>
      </header>

      {authRequired && !token && (
        <div className="panel">
          <p>This server requires a bearer token (`EAGENT_TOKEN`).</p>
          <div className="row">
            <input
              type="password"
              placeholder="Bearer token"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                saveToken(tokenDraft.trim());
                setToken(tokenDraft.trim());
              }}
            >
              Save
            </button>
          </div>
        </div>
      )}

      {token && (
        <div className="row muted" style={{ marginTop: "0.5rem" }}>
          <span>Token stored in sessionStorage</span>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              saveToken("");
              setToken("");
            }}
          >
            Log out
          </button>
        </div>
      )}

      {error && <p className="err">{error}</p>}

      {route === "chat" && (
        <>
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <label>
              Display{" "}
              <select value={mode} onChange={(e) => setMode(e.target.value as DisplayMode)}>
                <option value="auto">auto</option>
                <option value="full">full</option>
                <option value="collapsed">collapsed</option>
              </select>
            </label>
            <button type="button" className="secondary" onClick={() => void onClear()}>
              Clear
            </button>
            <button type="button" className="secondary" disabled={!running} onClick={() => void onStop()}>
              Stop
            </button>
            {running && <span className="muted">running…</span>}
          </div>

          <div className="panel">
            {userBubbles.map((b) => (
              <div key={b.id} className="user-bubble">
                <div className="muted">you</div>
                <div className="pre">{b.text}</div>
              </div>
            ))}
            {topSections.map((s, i) => (
              <SectionView
                key={s.id}
                s={s}
                onToggle={() =>
                  setModel((m) =>
                    applyControl(m, { kind: s.collapsed ? "expand" : "collapse", n: i + 1 }),
                  )
                }
              />
            ))}
            {topSections.length === 0 && userBubbles.length === 0 && (
              <p className="muted">Send a message to start a turn (uses POST /run JSONL).</p>
            )}
          </div>

          {ask.kind === "pending" && (
            <div className="panel ask">
              <p>{ask.ask.question}</p>
              {ask.ask.options && ask.ask.options.length > 0 ? (
                <div className="row">
                  {ask.ask.options.map((o) => (
                    <button key={o} type="button" onClick={() => void onAnswer(o)}>
                      {o}
                    </button>
                  ))}
                </div>
              ) : (
                <AskFreeText onSubmit={(t) => void onAnswer(t)} />
              )}
            </div>
          )}

          <div className="panel">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
              disabled={running || ask.kind === "pending"}
            />
            <div className="row" style={{ marginTop: "0.5rem" }}>
              <button type="button" disabled={running || ask.kind === "pending" || !input.trim()} onClick={() => void onSend()}>
                Send
              </button>
            </div>
          </div>
        </>
      )}

      {route === "monitor" && (
        <div className="panel">
          <div className="row">
            <strong>Sessions</strong>
            <button type="button" className="secondary" onClick={() => void refreshSessions()}>
              Refresh
            </button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>id</th>
                <th>running</th>
                <th>usage</th>
                <th>cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td>
                    <button type="button" className="secondary" onClick={() => setDetailId(s.id)}>
                      {s.id}
                    </button>
                  </td>
                  <td>{s.running ? "yes" : "no"}</td>
                  <td>
                    {s.usage.inputTokens}/{s.usage.outputTokens}
                  </td>
                  <td>{s.costUsd.toFixed(4)}</td>
                  <td className="row">
                    <button type="button" className="secondary" onClick={() => void stopSession(token, s.id).then(refreshSessions)}>
                      Stop
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => void deleteSession(token, s.id).then(refreshSessions)}
                    >
                      Forget
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {detailId && (
            <div style={{ marginTop: "1rem" }}>
              <div className="row">
                <strong>Live: {detailId}</strong>
                <button type="button" className="secondary" onClick={() => setDetailId(null)}>
                  Close
                </button>
              </div>
              {detailModel.sections.map((s) => (
                <SectionView key={s.id} s={s} onToggle={() => {}} />
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
    <div className="row">
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="Your answer" />
      <button type="button" disabled={!v.trim()} onClick={() => onSubmit(v.trim())}>
        Answer
      </button>
    </div>
  );
}
