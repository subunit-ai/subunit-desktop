/**
 * Cockpit v3 — the live workspace over every Claude Code terminal on the Mac.
 *
 *   · LEFT  : a live list of all sessions (status + what they're doing) with a
 *             per-session MODE — Manuell / Notify / Autonom.
 *   · RIGHT : a big live pane that always shows the most-active terminal (its
 *             recent conversation, streamed from the transcript), with actions
 *             (Zum Terminal, ✦U1) and the mode switch.
 *
 * The ENGINE watches status transitions and acts per mode:
 *   · Notify  → U1 pings you when that session starts waiting for input.
 *   · Autonom → U1 (Opus, via u1_ask) reads the session, writes the next prompt,
 *               and sends it into the REAL terminal — but only when the global
 *               "Autonom" master is on, rate-limited, capped, and STOP-aware.
 *               (send_to_terminal itself refuses anything but a live claude tab.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/ipc";
import type { ClaudeSession, HostApi, SessionTurn } from "../../plugin/types";

type TStatus = "working" | "waiting" | "idle" | "done";
const STAT: Record<TStatus, { label: string; cls: string }> = {
  working: { label: "Arbeitet", cls: "work" },
  waiting: { label: "Wartet auf dich", cls: "wait" },
  idle: { label: "Bereit", cls: "idle" },
  done: { label: "Fertig", cls: "done" },
};

type Mode = "manual" | "notify" | "auto";
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "manual", label: "Manuell", hint: "Nur du steuerst diese Session" },
  { id: "notify", label: "Notify", hint: "U1 pingt dich, wenn die Session auf dich wartet" },
  { id: "auto", label: "Autonom", hint: "U1 schreibt + sendet selbst den nächsten Prompt (wenn Autonom global an)" },
];
const MODE_KEY = "subunit.cockpit.modes";
const MASTER_KEY = "subunit.cockpit.autonom";

const AUTO_SYSTEM =
  "Du bist U1 und hältst eine laufende Claude-Code-Session am Laufen. Die Session wartet auf den nächsten Input. " +
  "Gib AUSSCHLIESSLICH den nächsten Prompt zurück (1–2 Sätze), den ich an Claude senden soll, um sinnvoll voranzukommen — kein Markdown, keine Erklärung, kein Präfix. " +
  "Wenn die Aufgabe fertig wirkt, etwas unklar/riskant ist oder eine menschliche Entscheidung braucht, antworte EXAKT mit: STOP";

function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 45000) return "gerade eben";
  const m = Math.floor(d / 60000);
  if (m < 60) return `vor ${m} Min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std`;
  return `vor ${Math.floor(h / 24)} d`;
}
function askU1(question: string) {
  window.dispatchEvent(new CustomEvent("u1:ask", { detail: { question } }));
}
function loadModes(): Record<string, Mode> {
  try {
    return JSON.parse(localStorage.getItem(MODE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function Cockpit({
  host,
  sessions,
  refreshing,
  onRefresh,
  onResume,
  onC1,
}: {
  host: HostApi;
  sessions: ClaudeSession[];
  refreshing: boolean;
  onRefresh: () => void;
  onResume: (s: ClaudeSession) => void;
  onC1: () => void;
}) {
  const [modes, setModes] = useState<Record<string, Mode>>(loadModes);
  const [master, setMaster] = useState<boolean>(() => {
    try {
      return localStorage.getItem(MASTER_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [log, setLog] = useState<{ t: number; msg: string }[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  const setMode = useCallback((id: string, m: Mode) => {
    setModes((prev) => {
      const n = { ...prev, [id]: m };
      try {
        localStorage.setItem(MODE_KEY, JSON.stringify(n));
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);
  const toggleMaster = useCallback(() => {
    setMaster((v) => {
      const n = !v;
      try {
        localStorage.setItem(MASTER_KEY, n ? "1" : "0");
      } catch {
        /* ignore */
      }
      return n;
    });
  }, []);
  const addLog = useCallback((msg: string) => setLog((l) => [{ t: Date.now(), msg }, ...l].slice(0, 24)), []);

  const working = sessions.filter((s) => s.status === "working").length;
  const waiting = sessions.filter((s) => s.status === "waiting").length;

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? sessions[0] ?? null,
    [sessions, activeId]
  );
  // Auto-follow the most-active session unless the user pinned one.
  useEffect(() => {
    if (!pinned && sessions[0]) setActiveId(sessions[0].id);
  }, [sessions, pinned]);

  // Poll the active session's transcript for the live pane.
  useEffect(() => {
    if (!active) {
      setTurns([]);
      return;
    }
    let alive = true;
    const load = () =>
      host.terminals.sessionTranscript(active.id).then((t) => alive && setTurns(t)).catch(() => {});
    load();
    const iv = window.setInterval(load, 3000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [host, active?.id]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // ── engine: notify + autonomous handling on status transitions ──
  const prevStatus = useRef<Record<string, TStatus>>({});
  const notified = useRef<Set<string>>(new Set());
  const cooldown = useRef<Record<string, number>>({});
  const consec = useRef<Record<string, number>>({});
  const pending = useRef<Map<string, { id: string; tty: string; title: string }>>(new Map());
  const acc = useRef<Map<string, string>>(new Map());
  // keep latest values addressable from the once-mounted listener
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const masterRef = useRef(master);
  masterRef.current = master;

  // u1_ask listener for autonomous steps (own requestIds, prefixed "auto").
  useEffect(() => {
    if (!isTauri()) return;
    const offs: UnlistenFn[] = [];
    let alive = true;
    const reg = (p: Promise<UnlistenFn>) => p.then((u) => (alive ? offs.push(u) : u()));
    reg(
      listen<{ requestId: string; text: string }>("u1://delta", (e) => {
        if (pending.current.has(e.payload.requestId))
          acc.current.set(e.payload.requestId, (acc.current.get(e.payload.requestId) || "") + e.payload.text);
      })
    );
    reg(
      listen<{ requestId: string }>("u1://done", (e) => {
        const p = pending.current.get(e.payload.requestId);
        if (!p) return;
        const text = (acc.current.get(e.payload.requestId) || "").trim();
        pending.current.delete(e.payload.requestId);
        acc.current.delete(e.payload.requestId);
        if (!text || /^stop\b/i.test(text)) {
          addLog(`Autonom: STOP für „${p.title}" — wartet jetzt auf dich`);
          host.notifications.notify("Autonom pausiert — dein Zug", p.title);
          return;
        }
        host.terminals
          .sendToTerminal(p.tty, text)
          .then(() => addLog(`Autonom → „${p.title}": ${text.slice(0, 90)}`))
          .catch((err) => addLog(`Autonom-Sendefehler („${p.title}"): ${err instanceof Error ? err.message : String(err)}`));
      })
    );
    reg(
      listen<{ requestId: string; message: string }>("u1://error", (e) => {
        const p = pending.current.get(e.payload.requestId);
        if (!p) return;
        pending.current.delete(e.payload.requestId);
        acc.current.delete(e.payload.requestId);
        addLog(`Autonom-Fehler („${p.title}"): ${e.payload.message}`);
      })
    );
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, [host, addLog]);

  const triggerAuto = useCallback(
    async (s: ClaudeSession) => {
      if (!s.tty) return;
      cooldown.current[s.id] = Date.now() + 25000;
      consec.current[s.id] = (consec.current[s.id] || 0) + 1;
      addLog(`Autonom: U1 denkt für „${s.title}"…`);
      try {
        const trans = await host.terminals.sessionTranscript(s.id);
        const convo = trans
          .map((t) => `${t.role === "user" ? "Nutzer" : "Claude"}: ${t.text}`)
          .join("\n\n")
          .slice(-6000);
        const reqId = `auto${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        pending.current.set(reqId, { id: s.id, tty: s.tty, title: s.title });
        acc.current.set(reqId, "");
        await invoke("u1_ask", {
          requestId: reqId,
          provider: "claude",
          model: "opus",
          messages: [
            { role: "system", content: AUTO_SYSTEM },
            { role: "user", content: `Session „${s.title}" (Projekt ${s.projectName}) wartet auf Input.\n\nVerlauf:\n${convo}\n\nNächster Prompt?` },
          ],
          cwd: s.cwdExists ? s.projectPath : undefined,
        });
      } catch (e) {
        addLog(`Autonom-Start fehlgeschlagen („${s.title}"): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [host, addLog]
  );

  useEffect(() => {
    for (const s of sessions) {
      const prev = prevStatus.current[s.id];
      const mode = modesRef.current[s.id] || "manual";
      if (s.status === "waiting" && prev && prev !== "waiting") {
        if (mode === "notify" && !notified.current.has(s.id)) {
          notified.current.add(s.id);
          host.notifications.notify("U1: Session wartet auf dich", `${s.title} · ${s.projectName}`);
          addLog(`Notify: „${s.title}" wartet auf dich`);
        } else if (mode === "auto" && masterRef.current && s.tty) {
          const cnt = consec.current[s.id] || 0;
          if (Date.now() < (cooldown.current[s.id] || 0)) {
            /* cooling down */
          } else if (cnt >= 4) {
            host.notifications.notify("Autonom pausiert — bitte schauen", `${s.title}: 4× ohne dich`);
            addLog(`Autonom pausiert für „${s.title}" (4× in Folge) — bitte prüfen`);
          } else {
            void triggerAuto(s);
          }
        }
      }
      if (s.status === "working") {
        notified.current.delete(s.id); // it moved again → re-arm notify
      }
      prevStatus.current[s.id] = s.status as TStatus;
    }
  }, [sessions, host, addLog, triggerAuto]);

  // A user opening a session counts as human intervention → reset its auto counter.
  const openSession = useCallback(
    (s: ClaudeSession) => {
      consec.current[s.id] = 0;
      onResume(s);
    },
    [onResume]
  );

  const focusSession = useCallback((id: string) => {
    setActiveId(id);
    setPinned(true);
  }, []);

  const lastTurn = turns[turns.length - 1];
  const activeStat = active ? STAT[(active.status as TStatus)] ?? STAT.idle : STAT.idle;

  return (
    <section className="cw">
      <CockpitStyle />
      <div className="cw-head">
        <div className="cw-head-tx">
          <div className="cw-title">Arbeitsplatz</div>
          <div className="cw-sub">
            {sessions.length} Sessions · {working} arbeiten · {waiting} warten auf dich
          </div>
        </div>
        <div className="cw-head-r">
          <button
            className={`cw-master${master ? " on" : ""}`}
            onClick={toggleMaster}
            title="Globaler Schalter: lässt Autonom-Sessions selbst weiterarbeiten"
          >
            <span className="cw-master-dot" /> Autonom {master ? "AN" : "aus"}
          </button>
          {sessions.length > 0 && (
            <button className="cw-c1" onClick={onC1} title="C1: Cloud-Orchestrator über alle Sessions">
              <span className="cw-c1-badge">C1</span>
            </button>
          )}
          <button className="iconbtn cw-refresh" onClick={onRefresh} title="Aktualisieren">
            <span className={refreshing ? "cw-spin" : ""}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></svg>
            </span>
          </button>
        </div>
      </div>

      {sessions.length === 0 ? (
        <div className="cw-empty">
          <b>Keine aktiven Claude-Sessions</b>
          <span>Sobald du irgendwo ein Terminal mit <code>claude</code> offen hast, erscheint es hier — live.</span>
        </div>
      ) : (
        <div className="cw-grid">
          {/* live session list */}
          <div className="cw-list">
            {sessions.map((s) => {
              const st = STAT[(s.status as TStatus)] ?? STAT.idle;
              const mode = modes[s.id] || "manual";
              return (
                <button
                  key={s.id}
                  className={`cw-row ${st.cls}${s.id === active?.id ? " on" : ""}`}
                  onClick={() => focusSession(s.id)}
                >
                  <span className={`cw-dot ${st.cls}`} />
                  <span className="cw-row-tx">
                    <span className="cw-row-title">{s.title}</span>
                    <span className="cw-row-sub">{s.projectName} · {relTime(s.lastActivity)}</span>
                  </span>
                  {mode !== "manual" && <span className={`cw-mb ${mode}`}>{mode === "auto" ? "A" : "N"}</span>}
                </button>
              );
            })}
          </div>

          {/* big live pane */}
          <div className="cw-pane">
            {!active ? (
              <div className="cw-pane-empty">Wähle eine Session.</div>
            ) : (
              <>
                <div className="cw-pane-head">
                  <span className={`cw-dot ${activeStat.cls}`} />
                  <div className="cw-pane-tx">
                    <div className="cw-pane-title">{active.title}{active.live && <span className="cw-live">live</span>}</div>
                    <div className="cw-pane-meta">{active.projectName} · <span className={`cw-pill ${activeStat.cls}`}>{activeStat.label}</span> · {relTime(active.lastActivity)}{pinned && <button className="cw-unpin" onClick={() => setPinned(false)} title="Wieder der aktivsten folgen">↻ folgen</button>}</div>
                  </div>
                  <div className="cw-modes" role="group" aria-label="Modus">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        className={`cw-mode${(modes[active.id] || "manual") === m.id ? " on" : ""} ${m.id}`}
                        title={m.hint}
                        onClick={() => setMode(active.id, m.id)}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="cw-convo" ref={bodyRef}>
                  {turns.length === 0 ? (
                    <div className="cw-convo-empty">Noch kein Verlauf sichtbar…</div>
                  ) : (
                    turns.map((t, i) => (
                      <div key={i} className={`cw-turn ${t.role}`}>
                        <span className="cw-turn-who">{t.role === "user" ? "Du" : "Claude"}</span>
                        <div className="cw-turn-tx">{t.text}</div>
                      </div>
                    ))
                  )}
                  {active.status === "working" && lastTurn?.role === "user" && (
                    <div className="cw-turn assistant"><span className="cw-turn-who">Claude</span><div className="cw-turn-tx cw-working"><span className="cw-typing"><i /><i /><i /></span> arbeitet…</div></div>
                  )}
                </div>

                <div className="cw-pane-foot">
                  <button className="btn btn-primary minibtn" onClick={() => openSession(active)}>
                    {active.tty ? "Zum Terminal ↗" : "Öffnen ↗"}
                  </button>
                  <button className="cw-u1" onClick={() => askU1(`Zur Session „${active.title}" (${active.projectName}, Status ${activeStat.label}): ${active.lastPrompt || "—"}. Was sollte ich als Nächstes tun?`)}>✦ U1</button>
                  <div style={{ flex: 1 }} />
                  {(modes[active.id] || "manual") === "auto" && !master && <span className="cw-hint-auto">Autonom aus — Schalter oben an</span>}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {log.length > 0 && (
        <div className="cw-log">
          <span className="cw-log-h">U1-Aktivität</span>
          {log.slice(0, 3).map((l, i) => (
            <span key={i} className="cw-log-i">{l.msg}</span>
          ))}
        </div>
      )}
    </section>
  );
}

function CockpitStyle() {
  return (
    <style>{`
.cw{margin:0 2px 22px}
.cw-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:14px}
.cw-title{font-size:18px;font-weight:650;letter-spacing:-.02em}
.cw-sub{font-size:12.5px;color:var(--ink3);margin-top:4px}
.cw-head-r{display:flex;align-items:center;gap:8px;flex:none}
.cw-master{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:11.5px;font-weight:650;padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);cursor:pointer;transition:.15s}
.cw-master-dot{width:7px;height:7px;border-radius:50%;background:var(--ink3)}
.cw-master.on{border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.12);color:#b45309}
.cw-master.on .cw-master-dot{background:#f59e0b;box-shadow:0 0 0 0 rgba(245,158,11,.6);animation:cw-beat 1.3s ease-out infinite}
.cw-c1{display:grid;place-items:center;padding:0;width:auto;height:30px;border-radius:999px;border:1px solid rgba(99,102,241,.35);background:rgba(99,102,241,.08);cursor:pointer;padding:0 6px}
.cw-c1-badge{display:grid;place-items:center;width:22px;height:22px;border-radius:7px;font-size:10px;font-weight:800;color:#fff;background:linear-gradient(160deg,#818cf8,#6366f1)}
.cw-refresh{width:auto}.cw-refresh span{display:grid;width:32px;height:32px;border-radius:10px;place-items:center}.cw-refresh svg{width:16px;height:16px}
.cw-spin{animation:cw-rot .9s linear infinite}@keyframes cw-rot{to{transform:rotate(360deg)}}

.cw-grid{display:grid;grid-template-columns:288px 1fr;gap:14px;align-items:stretch;min-height:440px}
@media(max-width:980px){.cw-grid{grid-template-columns:1fr}}

.cw-list{display:flex;flex-direction:column;gap:4px;padding:8px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.6);-webkit-backdrop-filter:blur(28px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);max-height:560px;overflow-y:auto}
.cw-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:9px 10px;border:none;background:none;border-radius:10px;cursor:pointer}
.cw-row:hover{background:var(--fill-weak)}
.cw-row.on{background:rgba(6,182,212,.1)}
.cw-row.wait{background:rgba(251,191,36,.06)}.cw-row.wait.on{background:rgba(251,191,36,.13)}
.cw-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--ink3)}
.cw-dot.work{background:#34d399;animation:cw-beat 1.6s ease-out infinite}
.cw-dot.wait{background:#fbbf24;animation:cw-beat 1.1s ease-out infinite}
.cw-dot.idle{background:#94a3b8}.cw-dot.done{background:var(--ink3);opacity:.55}
@keyframes cw-beat{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 5px transparent}100%{box-shadow:0 0 0 0 transparent}}
.cw-row-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.cw-row-title{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-row-sub{font-size:10.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-mb{flex:none;width:18px;height:18px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:800;color:#fff}
.cw-mb.notify{background:#06b6d4}.cw-mb.auto{background:#f59e0b}

.cw-pane{display:flex;flex-direction:column;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(30px) saturate(1.7);-webkit-backdrop-filter:blur(30px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden;min-height:440px}
.cw-pane-empty,.cw-convo-empty{margin:auto;color:var(--ink3);font-size:13px;padding:30px}
.cw-pane-head{flex:none;display:flex;align-items:center;gap:11px;padding:14px 16px;border-bottom:1px solid var(--line)}
.cw-pane-tx{flex:1;min-width:0}
.cw-pane-title{font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cw-live{flex:none;font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#0a9d63;background:rgba(16,185,129,.13);border:1px solid rgba(16,185,129,.3);border-radius:5px;padding:1px 5px}
.cw-pane-meta{font-size:11.5px;color:var(--ink3);margin-top:3px;display:flex;align-items:center;gap:7px}
.cw-pill{font-size:10.5px;font-weight:650;padding:1px 7px;border-radius:999px}
.cw-pill.work{color:#0a9d63;background:rgba(16,185,129,.12)}.cw-pill.wait{color:#b7791f;background:rgba(251,191,36,.14)}.cw-pill.idle,.cw-pill.done{color:var(--ink3);background:var(--glass2)}
.cw-unpin{font:inherit;font-size:10.5px;color:var(--cyan-d,#0891b2);background:none;border:none;cursor:pointer;padding:0}
.cw-modes{flex:none;display:flex;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.cw-mode{font:inherit;font-size:10.5px;font-weight:650;padding:4px 9px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;white-space:nowrap;transition:.13s}
.cw-mode:hover{color:var(--ink)}
.cw-mode.on.manual{background:var(--ink);color:var(--bg,#fff)}
.cw-mode.on.notify{background:#06b6d4;color:#fff}
.cw-mode.on.auto{background:#f59e0b;color:#fff}

.cw-convo{flex:1;min-height:0;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.cw-turn{display:flex;flex-direction:column;gap:4px;max-width:92%}
.cw-turn.user{align-self:flex-end;align-items:flex-end}
.cw-turn-who{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--ink3)}
.cw-turn-tx{font-size:13px;line-height:1.55;padding:9px 13px;border-radius:13px;white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:hidden}
.cw-turn.user .cw-turn-tx{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:5px}
.cw-turn.assistant .cw-turn-tx{background:var(--glass2);border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:5px}
.cw-working{display:flex;align-items:center;gap:8px;color:var(--ink2)}
.cw-typing{display:inline-flex;gap:4px}.cw-typing i{width:6px;height:6px;border-radius:50%;background:var(--ink3);animation:cw-bounce 1.2s ease-in-out infinite}
.cw-typing i:nth-child(2){animation-delay:.15s}.cw-typing i:nth-child(3){animation-delay:.3s}
@keyframes cw-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}
.cw-pane-foot{flex:none;display:flex;align-items:center;gap:9px;padding:12px 16px;border-top:1px solid var(--line)}
.cw-u1{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid rgba(6,182,212,.3);background:rgba(6,182,212,.08);color:var(--cyan-d,#0891b2);cursor:pointer}
.cw-u1:hover{background:rgba(6,182,212,.15)}
.cw-hint-auto{font-size:11px;color:#b45309}

.cw-empty{text-align:center;padding:40px 18px;color:var(--ink2);border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge)}
.cw-empty b{display:block;font-size:15px;color:var(--ink);margin-bottom:6px}
.cw-empty span{font-size:12.5px}.cw-empty code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--glass2);padding:1px 5px;border-radius:5px}

.cw-log{display:flex;align-items:center;gap:10px;margin-top:12px;padding:9px 13px;border-radius:11px;background:rgba(99,102,241,.06);border:1px solid rgba(99,102,241,.18);overflow:hidden}
.cw-log-h{flex:none;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6366f1}
.cw-log-i{font-size:11.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-left:1px solid var(--line);padding-left:10px}
@media (prefers-reduced-motion:reduce){.cw-dot,.cw-master.on .cw-master-dot,.cw-typing i,.cw-spin{animation:none}}
`}</style>
  );
}
