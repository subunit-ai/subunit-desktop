/**
 * C1 — the orchestrating CLOUD instance over all of TJ's Claude sessions.
 *
 * C1 is the cloud counterpart to the local U1 assistant: it runs on Opus (via the
 * Max subscription, `claude -p` — reusing the `u1_ask` engine) and looks ACROSS the
 * whole cockpit. Three levels, switchable:
 *   · Überblick  — C1 reads every session + todos and returns a prioritized briefing.
 *   · Vorschlag  — plus a one-line next prompt per session; you click to send it into
 *                  the REAL terminal (host.terminals.sendToTerminal → only delivered
 *                  if a live `claude` owns that tty).
 *   · Autonom    — C1 sends the prompts itself after a 5 s grace (with a Not-Aus).
 *
 * C1 asks Opus for strict JSON; we parse it on `done`. Free-text fallback if parsing
 * fails (shown as the briefing).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/ipc";
import type { ClaudeSession, HostApi } from "../../plugin/types";

type C1Mode = "overview" | "suggest" | "auto";
const C1_MODE_KEY = "subunit.c1.mode";

const MODES: { id: C1Mode; label: string; hint: string }[] = [
  { id: "overview", label: "Überblick", hint: "Nur drüberschauen — Briefing + Empfehlungen" },
  { id: "suggest", label: "Vorschlag", hint: "Prompt pro Session vorschlagen, du sendest per Klick" },
  { id: "auto", label: "Autonom", hint: "C1 sendet die Prompts selbst (mit Not-Aus)" },
];

interface C1Item { id: string; assessment?: string; suggestion?: string }
interface C1Result { overview: string; items: C1Item[] }

const C1_SYSTEM =
  "Du bist C1, die orchestrierende Cloud-Instanz über TJs offene Claude-Code-Terminals (Sessions). " +
  "Du schaust über ALLE Sessions und hilfst TJ, den Überblick zu behalten und voranzukommen — wie ein Lead, der die Lage überblickt. " +
  "Analysiere die Sessions (Status, Projekt, woran sie arbeiten, offene Todos). " +
  "Antworte AUSSCHLIESSLICH mit JSON (keine Code-Fences, kein Text drumherum) im Schema: " +
  '{"overview":"2-4 Sätze Gesamtlage: was läuft, was wartet auf TJ, was ist die Priorität","items":[{"id":"<sessionId>","assessment":"1 knapper Satz zum Stand","suggestion":"EIN einzeiliger, sofort sendbarer nächster Prompt für DIESE Session — oder leerer String wenn gerade nichts zu tun ist"}]}. ' +
  "Nur Sessions, die sinnvoll einen nächsten Schritt brauchen, bekommen eine nicht-leere suggestion. Deutsch.";

function parseC1(text: string): C1Result | null {
  let t = text.trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b < 0 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (o && typeof o.overview === "string" && Array.isArray(o.items)) return o as C1Result;
  } catch {
    /* not JSON */
  }
  return null;
}

export function C1Panel({
  host,
  sessions,
  onClose,
}: {
  host: HostApi;
  sessions: ClaudeSession[];
  onClose: () => void;
}) {
  const [mode, setMode] = useState<C1Mode>(() => {
    try {
      return (localStorage.getItem(C1_MODE_KEY) as C1Mode) || "overview";
    } catch {
      return "overview";
    }
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<C1Result | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, "sending" | "ok" | "err" | "skipped">>({});
  const [auto, setAuto] = useState<number | null>(null);
  const reqRef = useRef<string | null>(null);
  const accRef = useRef("");
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const autoTimer = useRef<number | null>(null);
  // Always-fresh view of the sessions for the autonomous path: the 5 s grace lets a
  // session flip working→waiting→working again, so we must re-check status/tty at the
  // MOMENT of sending — never against the render-time snapshot the countdown captured.
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const byId = useMemo(() => {
    const m = new Map<string, ClaudeSession>();
    for (const s of sessions) m.set(s.id, s);
    return m;
  }, [sessions]);

  const pickMode = (m: C1Mode) => {
    setMode(m);
    try {
      localStorage.setItem(C1_MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  const send = async (it: C1Item, opts?: { auto?: boolean }) => {
    // Resolve the session from the LIVE list (not the countdown's stale snapshot).
    const s = sessionsRef.current.find((x) => x.id === it.id) ?? byId.get(it.id);
    const text = (it.suggestion || "").trim();
    if (!s?.tty || !text) return;
    // Autonomous send: refuse if the session is no longer waiting for input — C1 must
    // never type into a session that resumed working during the grace period.
    if (opts?.auto && s.status !== "waiting") {
      setSent((p) => ({ ...p, [it.id]: "skipped" }));
      return;
    }
    setSent((p) => ({ ...p, [it.id]: "sending" }));
    try {
      await host.terminals.sendToTerminal(s.tty, text);
      setSent((p) => ({ ...p, [it.id]: "ok" }));
    } catch {
      setSent((p) => ({ ...p, [it.id]: "err" }));
    }
  };

  const cancelAuto = () => {
    if (autoTimer.current) {
      window.clearInterval(autoTimer.current);
      autoTimer.current = null;
    }
    setAuto(null);
  };

  const startAuto = (items: C1Item[]) => {
    let n = 5;
    setAuto(n);
    autoTimer.current = window.setInterval(() => {
      n -= 1;
      setAuto(n);
      if (n <= 0) {
        cancelAuto();
        items.forEach((it) => void send(it, { auto: true }));
      }
    }, 1000);
  };

  // Stream listener (C1 reuses the u1_ask engine, filtered by its own requestId).
  useEffect(() => {
    if (!isTauri()) return;
    const offs: UnlistenFn[] = [];
    let alive = true;
    const reg = (p: Promise<UnlistenFn>) => p.then((u) => (alive ? offs.push(u) : u()));
    reg(
      listen<{ requestId: string; text: string }>("u1://delta", (e) => {
        if (e.payload.requestId === reqRef.current) accRef.current += e.payload.text;
      })
    );
    reg(
      listen<{ requestId: string }>("u1://done", (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        reqRef.current = null;
        setBusy(false);
        const text = accRef.current;
        const parsed = parseC1(text);
        if (parsed) {
          setResult(parsed);
          setRaw(null);
          if (modeRef.current === "auto") {
            const sendable = parsed.items.filter(
              (it) => (it.suggestion || "").trim() && byId.get(it.id)?.tty
            );
            if (sendable.length) startAuto(sendable);
          }
        } else {
          setRaw(text.trim() || "Keine Antwort.");
        }
      })
    );
    reg(
      listen<{ requestId: string; message: string }>("u1://error", (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        reqRef.current = null;
        setBusy(false);
        setErr(e.payload.message || "C1 fehlgeschlagen.");
      })
    );
    return () => {
      alive = false;
      offs.forEach((o) => o());
      if (autoTimer.current) window.clearInterval(autoTimer.current);
    };
  }, [byId]);

  const analyze = () => {
    if (!isTauri()) {
      setErr("C1 läuft nur in der Subunit-App (Cloud-Opus über dein Abo).");
      return;
    }
    if (busy || reqRef.current) return;
    setErr(null);
    setResult(null);
    setRaw(null);
    setSent({});
    cancelAuto();
    accRef.current = "";
    const payload = sessions.slice(0, 30).map((s) => ({
      id: s.id,
      project: s.projectName,
      status: s.status,
      live: s.live,
      title: s.title,
      lastPrompt: s.lastPrompt,
      todos: s.todos.map((t) => t.content),
    }));
    const messages = [
      { role: "system", content: C1_SYSTEM },
      { role: "user", content: `Hier sind meine ${payload.length} offenen Sessions als JSON:\n${JSON.stringify(payload)}` },
    ];
    const reqId = `c1${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    reqRef.current = reqId;
    setBusy(true);
    invoke("u1_ask", { requestId: reqId, provider: "claude", model: "opus", messages }).catch((e) => {
      reqRef.current = null;
      setBusy(false);
      setErr(e instanceof Error ? e.message : String(e));
    });
  };

  const items = (result?.items ?? []).filter((it) => byId.has(it.id));
  const sendableCount = items.filter((it) => (it.suggestion || "").trim() && byId.get(it.id)?.tty).length;

  return (
    <div className="c1-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <C1Style />
      <div className="c1" role="dialog" aria-label="C1 Orchestrator">
        <div className="c1-head">
          <span className="c1-badge">C1</span>
          <div className="c1-head-tx">
            <b>Cloud-Orchestrator</b>
            <span>Opus überblickt deine {sessions.length} Sessions</span>
          </div>
          <button className="c1-x" onClick={onClose} aria-label="Schließen">
            <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="c1-modes" role="group" aria-label="C1-Reichweite">
          {MODES.map((m) => (
            <button key={m.id} className={`c1-mode${mode === m.id ? " on" : ""}`} title={m.hint} onClick={() => pickMode(m.id)}>
              {m.label}
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <button className="btn btn-primary minibtn c1-run" disabled={busy} onClick={analyze}>
            {busy ? <span className="c1-spin" /> : "✦"} {busy ? "C1 denkt…" : "Analysieren"}
          </button>
        </div>

        <div className="c1-body">
          {err && <div className="c1-err">{err}</div>}

          {auto !== null && (
            <div className="c1-auto">
              <span>Autonom: C1 sendet in <b>{auto}s</b> an {sendableCount} Session{sendableCount === 1 ? "" : "s"}…</span>
              <button className="c1-stop" onClick={cancelAuto}>■ Not-Aus</button>
            </div>
          )}

          {result && (
            <>
              <div className="c1-overview">{result.overview}</div>
              {items.length === 0 ? (
                <div className="c1-empty">C1 sieht aktuell keinen offenen nächsten Schritt.</div>
              ) : (
                <div className="c1-items">
                  {items.map((it) => {
                    const s = byId.get(it.id)!;
                    const sug = (it.suggestion || "").trim();
                    const canSend = !!sug && !!s.tty;
                    const st = sent[it.id];
                    return (
                      <div key={it.id} className="c1-item">
                        <div className="c1-item-h">
                          <span className="c1-item-proj">{s.projectName}</span>
                          <span className="c1-item-title">{s.title}</span>
                        </div>
                        {it.assessment && <div className="c1-item-ass">{it.assessment}</div>}
                        {sug && (
                          <div className="c1-sug">
                            <span className="c1-sug-q">→ {sug}</span>
                            {mode !== "overview" && (
                              <button
                                className={`c1-send${st === "ok" ? " ok" : ""}`}
                                disabled={!canSend || st === "sending" || st === "ok"}
                                title={s.tty ? "In das echte Terminal senden" : "Session hat kein offenes Terminal"}
                                onClick={() => void send(it)}
                              >
                                {st === "ok" ? "✓ gesendet" : st === "sending" ? "…" : st === "err" ? "Fehler – nochmal" : st === "skipped" ? "arbeitet – manuell senden ↵" : s.tty ? "Senden ↵" : "kein Terminal"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {raw && <div className="c1-raw">{raw}</div>}

          {!result && !raw && !busy && !err && (
            <div className="c1-intro">
              <p>C1 ist die <b>Cloud-Instanz</b> (Opus über dein Abo), die über alle deine Terminals schaut.</p>
              <ul>
                <li><b>Überblick</b> — Lagebericht + Prioritäten</li>
                <li><b>Vorschlag</b> — nächster Prompt pro Session, du sendest per Klick</li>
                <li><b>Autonom</b> — C1 sendet selbst (mit Not-Aus)</li>
              </ul>
              <p className="c1-intro-go">Wähle eine Stufe und „Analysieren“.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function C1Style() {
  return (
    <style>{`
.c1-scrim{position:fixed;inset:0;z-index:260;display:grid;place-items:center;background:var(--scrim,rgba(8,16,28,.55));backdrop-filter:blur(6px);animation:c1-fade .15s ease}
@keyframes c1-fade{from{opacity:0}to{opacity:1}}
.c1{width:min(680px,94vw);max-height:86vh;display:flex;flex-direction:column;border-radius:var(--r);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(42px) saturate(1.8);-webkit-backdrop-filter:blur(42px) saturate(1.8);box-shadow:0 28px 80px -22px rgba(0,0,0,.55),inset 0 1px 0 var(--rim);overflow:hidden;animation:c1-pop .2s cubic-bezier(.2,.8,.2,1)}
@keyframes c1-pop{from{opacity:0;transform:translateY(12px) scale(.98)}to{opacity:1;transform:none}}
.c1-head{flex:none;display:flex;align-items:center;gap:12px;padding:15px 16px;border-bottom:1px solid var(--line)}
.c1-badge{flex:none;width:38px;height:38px;border-radius:11px;display:grid;place-items:center;font-weight:800;font-size:15px;letter-spacing:.02em;color:#fff;background:linear-gradient(160deg,#818cf8,#6366f1);box-shadow:0 6px 16px -6px rgba(99,102,241,.7)}
.c1-head-tx{flex:1;display:flex;flex-direction:column;line-height:1.2}
.c1-head-tx b{font-size:15px;font-weight:680}
.c1-head-tx span{font-size:11.5px;color:var(--ink3)}
.c1-x{width:30px;height:30px;border-radius:9px;border:none;background:none;cursor:pointer;color:var(--ink3);display:grid;place-items:center}
.c1-x:hover{background:var(--fill-weak);color:var(--ink)}.c1-x svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.c1-modes{flex:none;display:flex;align-items:center;gap:6px;padding:12px 16px;border-bottom:1px solid var(--line)}
.c1-mode{font:inherit;font-size:12px;font-weight:650;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;transition:.14s}
.c1-mode:hover{color:var(--ink)}
.c1-mode.on{background:linear-gradient(160deg,#818cf8,#6366f1);color:#fff;border-color:transparent}
.c1-run{width:auto;display:inline-flex;align-items:center;gap:7px}
.c1-body{flex:1;min-height:0;overflow-y:auto;padding:16px}
.c1-err{font-size:12.5px;color:#dc2626;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:10px 12px;margin-bottom:12px}
.c1-auto{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;margin-bottom:14px;border-radius:12px;background:rgba(99,102,241,.1);border:1px solid rgba(99,102,241,.3);font-size:13px;color:var(--ink)}
.c1-stop{font:inherit;font-size:12px;font-weight:700;padding:6px 12px;border-radius:999px;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.1);color:#dc2626;cursor:pointer}
.c1-overview{font-size:14px;line-height:1.6;color:var(--ink);background:var(--glass2);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:14px}
.c1-empty{font-size:13px;color:var(--ink3);text-align:center;padding:18px}
.c1-items{display:flex;flex-direction:column;gap:10px}
.c1-item{padding:12px 14px;border-radius:12px;background:var(--glass);border:1px solid var(--glass-edge)}
.c1-item-h{display:flex;align-items:baseline;gap:8px}
.c1-item-proj{flex:none;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}
.c1-item-title{font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.c1-item-ass{font-size:12.5px;color:var(--ink2);line-height:1.45;margin-top:5px}
.c1-sug{display:flex;align-items:center;gap:10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
.c1-sug-q{flex:1;min-width:0;font-size:12.5px;color:var(--cyan-d,#0891b2);font-weight:550;line-height:1.4}
.c1-send{flex:none;font:inherit;font-size:11.5px;font-weight:650;padding:6px 12px;border-radius:999px;border:1px solid rgba(99,102,241,.4);background:rgba(99,102,241,.1);color:#5b5bd6;cursor:pointer;white-space:nowrap;transition:.14s}
.c1-send:hover:not(:disabled){background:rgba(99,102,241,.18)}
.c1-send:disabled{opacity:.5;cursor:default}
.c1-send.ok{color:#0a9d63;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.3)}
.c1-raw{font-size:13px;line-height:1.6;color:var(--ink);white-space:pre-wrap;background:var(--glass2);border:1px solid var(--line);border-radius:12px;padding:13px 15px}
.c1-intro{color:var(--ink2);font-size:13px;line-height:1.6}
.c1-intro b{color:var(--ink)}
.c1-intro ul{margin:10px 0;padding-left:18px;display:flex;flex-direction:column;gap:4px}
.c1-intro-go{color:var(--ink3);margin-top:8px}
.c1-spin,.c1-send :where(.c1-spin){width:13px;height:13px;border-radius:50%;border:2px solid rgba(255,255,255,.45);border-top-color:#fff;animation:c1-rot .7s linear infinite;display:inline-block}
@keyframes c1-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.c1-scrim,.c1,.c1-spin{animation:none}}
`}</style>
  );
}
