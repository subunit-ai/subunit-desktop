/**
 * Dashboard — the flagship built-in plugin: a glass Ops board.
 *
 * LEFT/MAIN  : a Notion-synced TASK list (host.notion.listTasks) rendered as
 *              glass rows with status pills. Each row has two actions:
 *                · "Chat mit u1"     → host.nav.navigate("chat") + host.events.emit
 *                                       seeds the chat plugin with the task.
 *                · "Lokal ausführen" → host.terminals.spawn({ cmd:"claude",
 *                                       args:["-p", task.title], taskId }) and
 *                                       opens that terminal in the right pane.
 * RIGHT/PANEL: "Aktive Terminals" — host.terminals.list() live; each a glass row
 *              (title · task · running dot · output preview). Clicking opens an
 *              xterm-like terminal pane: host.terminals.onOutput streams into a
 *              .codebox, an input field writes back via host.terminals.write.
 *
 * Every surface is built from Subunit Liquid Glass classes + tokens only. The
 * desktop two-column layout + terminal pane sizing live in a scoped <style>
 * (plugin-root class `dash`), expressed entirely through design-system tokens —
 * no new palette, fonts, or glass recipe.
 *
 * Permissions: notion, terminals, events(ungated), nav(ungated), notifications,
 * storage.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ClaudeSession,
  HostApi,
  NotionTask,
  PluginModule,
  ProjectInfo,
  TermInfo,
} from "../../plugin/types";

// Dock glyph — a control board (mirrors the original reference icon).
const ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/></svg>`;

// Cross-plugin topic the Chat plugin subscribes to when seeded from a task.
const CHAT_SEED_TOPIC = "chat:seed";

// ── small inline icon helpers (design-system stroke conventions) ──────────────
const Svg = (props: { d: string; fill?: boolean }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} fill={props.fill ? "currentColor" : "none"} />
    ))}
  </svg>
);

const ICONS = {
  chat: "M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z",
  play: "M7 5l11 7-11 7V5Z",
  refresh: "M21 12a9 9 0 1 1-3-6.7|21 4v4h-4",
  terminal: "M5 7l5 5-5 5|13 17h6",
  task: "M9 11l3 3 8-8|21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  close: "M18 6 6 18|6 6l12 12",
  spark: "M12 3v6m0 6v6m9-9h-6M9 12H3|18.4 5.6l-4.2 4.2m-4.4 4.4-4.2 4.2",
} as const;

// ── status → pill class (design-system .pill live/wait/gone) ──────────────────
function statusPill(status?: string): { cls: string; label: string } {
  const s = (status ?? "").toLowerCase();
  if (/done|complete|fertig|erledigt|abgeschlossen/.test(s))
    return { cls: "live", label: status || "Done" };
  if (/progress|doing|läuft|in arbeit|active|wip/.test(s))
    return { cls: "wait", label: status || "In progress" };
  if (/block|wait|hold|paused|warten/.test(s))
    return { cls: "wait", label: status || "Blocked" };
  return { cls: "gone", label: status || "Backlog" };
}

// ════════════════════════════════════════════════════════════════════════════
// Terminal pane — xterm-like view for one pty.
// ════════════════════════════════════════════════════════════════════════════
/**
 * Render raw PTY bytes as readable text. Local tools (e.g. `ollama run`) draw a
 * live spinner with ANSI escape + private-mode sequences (cursor hide, synced
 * output, line clears) which show up as garbage in a plain <pre>. Strip those
 * and apply carriage-return line discipline so each spinner redraw collapses to
 * its final text. General-purpose: also cleans claude/codex output.
 */
function cleanTerminal(raw: string): string {
  // Minimal terminal line-discipline: emulate the cursor so ANSI escapes, the
  // private cursor/sync modes and the carriage-style redraws that `ollama run`'s
  // spinner emits collapse to clean text — instead of raw bytes in a <pre>.
  const lines: string[] = [];
  let line = "";
  let col = 0;
  const put = (ch: string) => {
    if (col === line.length) line += ch;
    else line = line.slice(0, col) + ch + line.slice(col + 1);
    col++;
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\x1b") {
      if (raw[i + 1] === "[") {
        // CSI: ESC [ params intermediates final
        let j = i + 2;
        while (j < raw.length && /[0-9;?]/.test(raw[j])) j++;
        while (j < raw.length && raw[j] >= " " && raw[j] <= "/") j++;
        const final = raw[j];
        const params = raw.slice(i + 2, j).replace(/\?/g, "");
        if (final === "G")
          col = 0; // cursor to column 1 (spinner redraw)
        else if (final === "K")
          line = line.slice(0, col); // erase to end of line
        else if (final === "D")
          col = Math.max(0, col - (parseInt(params || "1", 10) || 1));
        else if (final === "C") col += parseInt(params || "1", 10) || 1;
        // colours/cursor-mode (m, h, l, …) are simply dropped
        i = j;
        continue;
      }
      if (raw[i + 1] === "]") {
        // OSC: ESC ] ... (BEL | ST)
        let j = i + 2;
        while (
          j < raw.length &&
          raw[j] !== "\x07" &&
          !(raw[j] === "\x1b" && raw[j + 1] === "\\")
        )
          j++;
        i = raw[j] === "\x1b" ? j + 1 : j;
        continue;
      }
      i += 1; // other ESC + one byte
      continue;
    }
    if (c === "\n") {
      lines.push(line);
      line = "";
      col = 0;
      continue;
    }
    if (c === "\r") {
      col = 0;
      continue;
    }
    if (c === "\t") {
      put(" ");
      continue;
    }
    if (c < " ") continue; // drop remaining control chars
    put(c);
  }
  lines.push(line);
  return lines.join("\n").replace(/[ \t]+$/gm, "");
}

function TerminalPane({
  host,
  term,
  onClose,
}: {
  host: HostApi;
  term: TermInfo;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<string>("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(term.running);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Stream output → codebox; track exit. Re-subscribes when the pty id changes.
  useEffect(() => {
    setLines("");
    setRunning(term.running);
    const offOut = host.terminals.onOutput(term.id, (chunk) =>
      setLines((prev) => (prev + chunk).slice(-20000))
    );
    const offExit = host.terminals.onExit(term.id, (code) => {
      setRunning(false);
      setLines((prev) => `${prev}\n\n[process exited with code ${code}]`);
    });
    return () => {
      offOut();
      offExit();
    };
  }, [host, term.id, term.running]);

  // Keep the codebox pinned to the newest output.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const submit = useCallback(() => {
    const data = input;
    setInput("");
    void host.terminals.write(term.id, data + "\n");
  }, [host, input, term.id]);

  const kill = useCallback(() => {
    void host.terminals.kill(term.id);
  }, [host, term.id]);

  return (
    <div className="card dash-termpane">
      <div className="hd dash-termhd">
        <span className={`dash-dot ${running ? "on" : "off"}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 className="dash-termtitle">{term.title}</h1>
          <p>
            {term.cmd}
            {term.taskId ? " · linked task" : ""} ·{" "}
            {running ? "running" : "exited"}
          </p>
        </div>
        {running && (
          <button className="btn btn-danger minibtn" onClick={kill}>
            Stop
          </button>
        )}
        <button className="iconbtn dash-x" onClick={onClose} title="Close pane">
          <span className="ic">
            <Svg d={ICONS.close} />
          </span>
        </button>
      </div>

      <div className="codebox dash-codebox" ref={bodyRef}>
        {lines ? (
          <pre className="dash-pre">{cleanTerminal(lines)}</pre>
        ) : (
          <div className="dash-emptyterm">
            <span className="spinner" />
            Waiting for output…
          </div>
        )}
      </div>

      <div className="dash-terminput">
        <input
          className="fld dash-termfld"
          placeholder={running ? "Type and press Enter…" : "Process exited"}
          value={input}
          disabled={!running}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          className="btn btn-primary minibtn dash-termsend"
          disabled={!running}
          onClick={submit}
        >
          <Svg d={ICONS.send} />
        </button>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Terminals panel (right column) — live list of ptys.
// ════════════════════════════════════════════════════════════════════════════
// ── Cockpit: per-terminal status + attention + U1 orchestration ──────────────
type TStatus = "working" | "waiting" | "idle" | "done";
const STAT: Record<TStatus, { label: string; cls: string }> = {
  working: { label: "Arbeitet", cls: "work" },
  waiting: { label: "Wartet auf dich", cls: "wait" },
  idle: { label: "Bereit", cls: "idle" },
  done: { label: "Fertig", cls: "done" },
};

/** Hand a question to the ubiquitous U1 assistant (it opens + answers). */
function askU1(question: string) {
  window.dispatchEvent(new CustomEvent("u1:ask", { detail: { question } }));
}

/**
 * Watch every terminal: derive status from output timing (working when output
 * flows, "wartet auf dich" when a still-running pty goes quiet ≥10s — i.e. Claude
 * finished its turn and needs you) and NOTIFY once on that transition.
 */
function useTerminalStatus(host: HostApi, terms: TermInfo[]) {
  const lastOut = useRef<Record<string, number>>({});
  const notified = useRef<Set<string>>(new Set());
  const [status, setStatus] = useState<Record<string, TStatus>>({});
  const [previews, setPreviews] = useState<Record<string, string>>({});

  useEffect(() => {
    const offs = terms.map((t) =>
      host.terminals.onOutput(t.id, (chunk) => {
        lastOut.current[t.id] = Date.now();
        notified.current.delete(t.id); // fresh output → it's working again
        const tail = chunk.split("\n").map((l) => l.trim()).filter(Boolean).pop();
        if (tail) setPreviews((p) => ({ ...p, [t.id]: tail.replace(/\s+/g, " ").slice(0, 140) }));
      })
    );
    return () => offs.forEach((o) => o());
  }, [host, terms]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const next: Record<string, TStatus> = {};
      for (const t of terms) {
        if (!t.running) {
          next[t.id] = "done";
          continue;
        }
        const seen = lastOut.current[t.id];
        if (seen == null) next[t.id] = "idle";
        else {
          const idle = now - seen;
          next[t.id] = idle < 4000 ? "working" : idle >= 10000 ? "waiting" : "idle";
        }
        if (next[t.id] === "waiting" && !notified.current.has(t.id)) {
          notified.current.add(t.id);
          host.notifications.notify("Wartet auf dich", `${t.title}${t.project ? ` · ${t.project}` : ""}`);
        }
      }
      setStatus(next);
    };
    tick();
    const iv = window.setInterval(tick, 2500);
    return () => window.clearInterval(iv);
  }, [host, terms]);

  const waiting = terms.filter((t) => status[t.id] === "waiting");
  return { status, previews, waiting };
}

function TerminalsPanel({
  host,
  terms,
  projects,
  refreshing,
  activeId,
  onOpen,
  onNew,
  onRefresh,
}: {
  host: HostApi;
  terms: TermInfo[];
  projects: ProjectInfo[];
  refreshing: boolean;
  activeId: string | null;
  onOpen: (t: TermInfo) => void;
  onNew: (p: ProjectInfo) => void;
  onRefresh: () => void;
}) {
  const { status, previews, waiting } = useTerminalStatus(host, terms);
  const [pickOpen, setPickOpen] = useState(false);

  // Group terminals by project (working dir basename).
  const groups = useMemo(() => {
    const m = new Map<string, TermInfo[]>();
    for (const t of terms) {
      const p = t.project || "Allgemein";
      const arr = m.get(p) ?? [];
      arr.push(t);
      m.set(p, arr);
    }
    return [...m.entries()];
  }, [terms]);

  const overview = () => {
    const lines = terms.map((t) => `• ${t.title}${t.project ? ` (${t.project})` : ""} — ${STAT[status[t.id] ?? "idle"].label}`).join("\n");
    askU1(`Das sind meine ${terms.length} offenen Terminals${waiting.length ? `, ${waiting.length} warten auf mich` : ""}:\n${lines}\n\nGib mir einen kurzen Überblick + was ich als Nächstes tun sollte.`);
  };

  return (
    <aside className="dash-panel">
      <CockpitStyle />
      <div className="dash-panel-head">
        <div className="sect" style={{ margin: 0 }}>
          Cockpit{waiting.length > 0 && <span className="ck-attn">{waiting.length} wartet</span>}
        </div>
        <div className="ck-head-act">
          {terms.length > 0 && (
            <button className="ck-u1" onClick={overview} title="U1: Überblick über alle Terminals">✦ U1</button>
          )}
          <div className="ck-pick-wrap">
            <button className="ck-new" onClick={() => setPickOpen((o) => !o)} title="Terminal in Projekt starten">＋ Terminal</button>
            {pickOpen && (
              <div className="ck-pick" onMouseLeave={() => setPickOpen(false)}>
                <div className="ck-pick-h">Projekt wählen</div>
                {projects.length === 0 ? (
                  <div className="ck-pick-empty">Keine Projekte gefunden</div>
                ) : (
                  projects.map((p) => (
                    <button key={p.path} className="ck-pick-i" onClick={() => { setPickOpen(false); onNew(p); }}>
                      <span className="ck-pick-n">{p.name}</span>
                      {p.git && <span className="ck-pick-git">git</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <button className="iconbtn dash-mini" onClick={onRefresh} title="Refresh">
            <span className={`ic ${refreshing ? "dash-spin" : ""}`}><Svg d={ICONS.refresh} /></span>
          </button>
        </div>
      </div>

      {terms.length === 0 ? (
        <div className="dash-panel-empty">
          <span className="ic"><Svg d={ICONS.terminal} /></span>
          <b>Keine laufenden Terminals</b>
          <span>Starte oben mit „＋ Terminal“ eines in einem Projekt (oder per „Lokal ausführen“) — es erscheint hier live, gruppiert nach Projekt, mit Status &amp; Ping wenn es auf dich wartet.</span>
        </div>
      ) : (
        <div className="ck-groups">
          {groups.map(([proj, ts]) => (
            <div key={proj} className="ck-group">
              <div className="ck-group-h"><span className="ck-group-n">{proj}</span><span className="ck-group-c">{ts.length}</span></div>
              <ul className="list dash-termlist">
                {ts.map((t) => {
                  const st = status[t.id] ?? "idle";
                  return (
                    <li
                      key={t.id}
                      className={`dash-termrow ck-row ${STAT[st].cls}${t.id === activeId ? " is-active" : ""}`}
                      onClick={() => onOpen(t)}
                    >
                      <span className={`ck-dot ${STAT[st].cls}`} />
                      <div className="dash-termrow-tx">
                        <div className="dash-termrow-title">{t.title}</div>
                        <div className="dash-termrow-prev">{previews[t.id] || (t.taskId ? "verknüpfte Aufgabe" : t.cmd) || "—"}</div>
                      </div>
                      <div className="ck-row-r">
                        <span className={`pill ck-pill ${STAT[st].cls}`}>{STAT[st].label}</span>
                        <button
                          className="ck-u1 sm"
                          title="U1 zu diesem Terminal fragen"
                          onClick={(e) => {
                            e.stopPropagation();
                            askU1(`Mein Terminal „${t.title}"${t.project ? ` (Projekt ${t.project})` : ""} ist gerade „${STAT[st].label}". Letzte Ausgabe: ${previews[t.id] || "—"}. Was ist hier los und was soll ich tun?`);
                          }}
                        >✦</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function CockpitStyle() {
  return (
    <style>{`
.ck-attn{margin-left:9px;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:#b7791f;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.3);padding:2px 8px;border-radius:999px;animation:ck-attn 1.8s ease-in-out infinite}
@keyframes ck-attn{0%,100%{opacity:1}50%{opacity:.55}}
.ck-head-act{display:flex;align-items:center;gap:6px}
.ck-pick-wrap{position:relative}
.ck-new{font:inherit;font-size:11.5px;font-weight:650;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink);cursor:pointer;white-space:nowrap;transition:.15s}
.ck-new:hover{border-color:rgba(6,182,212,.4);color:var(--cyan-d,#0891b2)}
.ck-pick{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:230px;max-height:320px;overflow-y:auto;padding:6px;border-radius:var(--r-sm);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.ck-pick-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:7px 9px 6px}
.ck-pick-empty{font-size:12px;color:var(--ink3);padding:8px 9px}
.ck-pick-i{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;text-align:left;padding:8px 9px;border:none;background:none;border-radius:9px;cursor:pointer;font:inherit;font-size:12.5px;color:var(--ink)}
.ck-pick-i:hover{background:var(--fill-weak)}
.ck-pick-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ck-pick-git{flex:none;font-size:9px;font-weight:700;text-transform:uppercase;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.22);border-radius:5px;padding:1px 5px}
.ck-u1{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:11.5px;font-weight:650;padding:5px 11px;border-radius:999px;border:1px solid rgba(6,182,212,.3);background:rgba(6,182,212,.08);color:var(--cyan-d,#0891b2);cursor:pointer;transition:.15s;white-space:nowrap}
.ck-u1:hover{background:rgba(6,182,212,.15);border-color:rgba(6,182,212,.5)}
.ck-u1.sm{padding:0;width:24px;height:24px;justify-content:center;flex:none}
.ck-groups{display:flex;flex-direction:column;gap:14px;margin-top:6px;overflow-y:auto}
.ck-group-h{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 7px;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3)}
.ck-group-c{font-weight:600}
.ck-dot{flex:none;width:9px;height:9px;border-radius:50%;background:var(--ink3)}
.ck-dot.work{background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:ck-beat 1.6s ease-out infinite}
.ck-dot.wait{background:#fbbf24;box-shadow:0 0 0 0 rgba(251,191,36,.6);animation:ck-beat 1.1s ease-out infinite}
.ck-dot.idle{background:#94a3b8}.ck-dot.done{background:var(--ink3);opacity:.6}
@keyframes ck-beat{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
.ck-row.wait{background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.28)}
.ck-row-r{display:flex;align-items:center;gap:6px;flex:none}
.ck-pill.work{color:#0a9d63;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.25)}
.ck-pill.wait{color:#b7791f;background:rgba(251,191,36,.14);border:1px solid rgba(251,191,36,.3)}
.ck-pill.idle{color:var(--ink2);background:var(--glass2);border:1px solid var(--line)}
.ck-pill.done{color:var(--ink3);background:var(--glass2);border:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){.ck-attn,.ck-dot.work,.ck-dot.wait{animation:none}}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Arbeitsplatz — every Claude Code session on the Mac (external terminals incl.)
// ════════════════════════════════════════════════════════════════════════════
/** Relative time, German, compact. */
function relTime(ms: number): string {
  const d = Date.now() - ms;
  if (d < 45000) return "gerade eben";
  const m = Math.floor(d / 60000);
  if (m < 60) return `vor ${m} Min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `vor ${h} Std`;
  const days = Math.floor(h / 24);
  return `vor ${days} ${days === 1 ? "Tag" : "Tagen"}`;
}

/** Notify once when a LIVE session goes working → waiting (Claude needs you). */
function useSessionAttention(host: HostApi, sessions: ClaudeSession[]) {
  const prev = useRef<Record<string, string>>({});
  useEffect(() => {
    for (const s of sessions) {
      const was = prev.current[s.id];
      // Fired the instant a session stops producing output (Claude finished its
      // turn → your move). working → waiting is exactly that moment.
      if (s.status === "waiting" && was === "working") {
        host.notifications.notify("Claude wartet auf dich", `${s.title} · ${s.projectName}`);
      }
      prev.current[s.id] = s.status;
    }
  }, [host, sessions]);
}

function SessionCard({
  s,
  onResume,
}: {
  s: ClaudeSession;
  onResume: (s: ClaudeSession) => void;
}) {
  const [showTodos, setShowTodos] = useState(false);
  const st = STAT[(s.status as TStatus)] ?? STAT.idle;
  return (
    <div
      className={`sb-card ${st.cls}`}
      role="button"
      tabIndex={0}
      title="Öffnen: Session in einem Terminal fortsetzen"
      onClick={() => onResume(s)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onResume(s);
        }
      }}
    >
      <div className="sb-card-top">
        <span className={`ck-dot ${st.cls}`} />
        <div className="sb-card-tx">
          <div className="sb-card-title">
            {s.title}
            {s.live && <span className="sb-live">live</span>}
          </div>
          <div className="sb-card-prompt">{s.lastPrompt || s.summary || "—"}</div>
        </div>
        <span className={`pill ck-pill ${st.cls}`}>{st.label}</span>
      </div>

      <div className="sb-card-meta">
        <span className="sb-when">{relTime(s.lastActivity)}</span>
        {!s.cwdExists && <span className="sb-warn">Ordner fehlt</span>}
        {s.todos.length > 0 && (
          <button className="sb-todos-c" onClick={(e) => { e.stopPropagation(); setShowTodos((v) => !v); }}>
            {s.todos.length} offen{showTodos ? " ▾" : " ▸"}
          </button>
        )}
      </div>

      {showTodos && s.todos.length > 0 && (
        <ul className="sb-todos">
          {s.todos.slice(0, 6).map((t, i) => (
            <li key={i} className={t.status === "in_progress" ? "doing" : ""}>
              <span className="sb-todo-dot" />
              {t.content}
            </li>
          ))}
          {s.todos.length > 6 && <li className="sb-todo-more">+ {s.todos.length - 6} weitere</li>}
        </ul>
      )}

      <div className="sb-card-act">
        <button
          className="ck-u1 sm"
          title="U1 zu dieser Session fragen"
          onClick={(e) => {
            e.stopPropagation();
            askU1(
              `Meine Claude-Session „${s.title}" im Projekt ${s.projectName} ist „${st.label}". Sie arbeitet an: ${s.lastPrompt || s.summary || "—"}.${s.todos.length ? ` Offene Punkte: ${s.todos.map((t) => t.content).join("; ")}.` : ""} Gib mir einen kurzen Überblick + was ich als Nächstes tun sollte.`
            );
          }}
        >
          ✦
        </button>
        <button
          className="sb-resume"
          title="Session in einem Terminal hier fortsetzen"
          onClick={(e) => {
            e.stopPropagation();
            onResume(s);
          }}
        >
          Fortsetzen
        </button>
      </div>
    </div>
  );
}

function SessionsBoard({
  host,
  sessions,
  refreshing,
  onResume,
  onRefresh,
}: {
  host: HostApi;
  sessions: ClaudeSession[];
  refreshing: boolean;
  onResume: (s: ClaudeSession) => void;
  onRefresh: () => void;
}) {
  useSessionAttention(host, sessions);
  const [showDone, setShowDone] = useState(false);

  const working = sessions.filter((s) => s.status === "working").length;
  const waiting = sessions.filter((s) => s.status === "waiting").length;
  const doneCount = sessions.filter((s) => s.status === "done").length;

  // Default to the live workspace (hide long-finished sessions behind a toggle).
  const shown = useMemo(
    () => (showDone ? sessions : sessions.filter((s) => s.status !== "done")),
    [sessions, showDone]
  );

  // Group by project, projects ordered by their most-recent session.
  const groups = useMemo(() => {
    const m = new Map<string, ClaudeSession[]>();
    for (const s of shown) {
      const arr = m.get(s.projectName) ?? [];
      arr.push(s);
      m.set(s.projectName, arr);
    }
    return [...m.entries()].sort(
      (a, b) =>
        Math.max(...b[1].map((s) => s.lastActivity)) - Math.max(...a[1].map((s) => s.lastActivity))
    );
  }, [shown]);

  const overview = () => {
    const lines = sessions
      .slice(0, 24)
      .map((s) => `• [${(STAT[(s.status as TStatus)] ?? STAT.idle).label}] ${s.title} (${s.projectName}) — ${s.lastPrompt || s.summary || "—"}`)
      .join("\n");
    askU1(
      `Das ist mein Arbeitsplatz: ${sessions.length} Claude-Sessions${waiting ? `, ${waiting} warten auf mich` : ""}${working ? `, ${working} arbeiten gerade` : ""}.\n${lines}\n\nVerschaff mir einen Überblick: Wo stehe ich, was wartet auf mich, was sollte ich als Nächstes anpacken?`
    );
  };

  return (
    <section className="sb">
      <SessStyle />
      <div className="sb-head">
        <div className="sb-head-tx">
          <div className="sb-title">
            Arbeitsplatz
            {waiting > 0 && <span className="ck-attn">{waiting} wartet auf dich</span>}
          </div>
          <div className="sb-sub">
            Alle Claude-Code-Sessions auf dem Mac — live, nach Projekt sortiert. {working} aktiv · {sessions.length} gesamt
          </div>
        </div>
        <div className="sb-head-r">
          {sessions.length > 0 && (
            <button className="ck-u1" onClick={overview} title="U1: Überblick über alle Sessions">
              ✦ U1 Überblick
            </button>
          )}
          <button className="iconbtn dash-mini" onClick={onRefresh} title="Aktualisieren">
            <span className={`ic ${refreshing ? "dash-spin" : ""}`}>
              <Svg d={ICONS.refresh} />
            </span>
          </button>
        </div>
      </div>

      {shown.length === 0 ? (
        <div className="sb-empty">
          <span className="ic"><Svg d={ICONS.terminal} /></span>
          <b>{sessions.length === 0 ? "Keine aktiven Claude-Sessions gefunden" : "Alles abgearbeitet"}</b>
          <span>
            {sessions.length === 0 ? (
              <>
                Sobald du irgendwo auf dem Mac ein Terminal mit <code>claude</code> offen hast,
                erscheint es hier — mit Projekt, Status, woran es arbeitet und offenen Aufgaben.
              </>
            ) : (
              <>Aktuell arbeitet oder wartet keine Session. {doneCount} ältere sind ausgeblendet.</>
            )}
          </span>
        </div>
      ) : (
        <div className="sb-groups">
          {groups.map(([proj, ss]) => (
            <div key={proj} className="sb-group">
              <div className="sb-group-h">
                <span className="sb-group-n">{proj}</span>
                <span className="sb-group-c">{ss.length}</span>
              </div>
              <div className="sb-cards">
                {ss.map((s) => (
                  <SessionCard key={s.id} s={s} onResume={onResume} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {doneCount > 0 && (
        <button className="sb-more" onClick={() => setShowDone((v) => !v)}>
          {showDone ? "Ältere ausblenden" : `+ ${doneCount} ältere Session${doneCount === 1 ? "" : "s"} anzeigen`}
        </button>
      )}
    </section>
  );
}

function SessStyle() {
  return (
    <style>{`
.sb{margin:0 2px 22px}
.sb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:14px}
.sb-title{font-size:18px;font-weight:650;letter-spacing:-.02em;display:flex;align-items:center}
.sb-sub{font-size:12.5px;color:var(--ink3);margin-top:4px}
.sb-head-r{display:flex;align-items:center;gap:7px;flex:none}
.sb-groups{display:flex;flex-direction:column;gap:16px}
.sb-group-h{display:flex;align-items:center;gap:8px;padding:0 2px 9px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3)}
.sb-group-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-group-c{font-weight:600;color:var(--ink3);background:var(--glass2);border:1px solid var(--line);border-radius:999px;padding:0 8px;font-size:10.5px}
.sb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.sb-card{display:flex;flex-direction:column;gap:9px;padding:14px 15px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s}
.sb-card:hover{transform:translateY(-1px);border-color:rgba(6,182,212,.45)}
.sb-card:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.sb-card.work{border-color:rgba(16,185,129,.3)}
.sb-card.wait{border-color:rgba(251,191,36,.34);background:rgba(251,191,36,.05)}
.sb-card-top{display:flex;align-items:flex-start;gap:10px}
.sb-card-tx{flex:1;min-width:0}
.sb-card-title{font-size:14px;font-weight:650;letter-spacing:-.01em;display:flex;align-items:center;gap:7px;line-height:1.3}
.sb-live{flex:none;font-size:9px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#0a9d63;background:rgba(16,185,129,.13);border:1px solid rgba(16,185,129,.3);border-radius:5px;padding:1px 5px}
.sb-card-prompt{font-size:12px;color:var(--ink2);margin-top:4px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sb-card .ck-dot{margin-top:4px}
.sb-card .ck-pill{flex:none;align-self:flex-start}
.sb-card-meta{display:flex;align-items:center;gap:9px;font-size:11px;color:var(--ink3)}
.sb-when{font-variant-numeric:tabular-nums}
.sb-warn{color:#b7791f;font-weight:600}
.sb-todos-c{font:inherit;font-size:11px;font-weight:650;color:var(--cyan-d,#0891b2);background:none;border:none;cursor:pointer;padding:0}
.sb-todos{list-style:none;margin:0;padding:8px 0 2px;display:flex;flex-direction:column;gap:5px;border-top:1px solid var(--line)}
.sb-todos li{display:flex;align-items:flex-start;gap:7px;font-size:11.5px;color:var(--ink2);line-height:1.4}
.sb-todo-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--ink3);margin-top:5px}
.sb-todos li.doing{color:var(--ink);font-weight:600}
.sb-todos li.doing .sb-todo-dot{background:#fbbf24}
.sb-todo-more{color:var(--ink3);font-size:10.5px}
.sb-card-act{display:flex;align-items:center;gap:7px;margin-top:auto;padding-top:2px}
.sb-resume{flex:1;font:inherit;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink);cursor:pointer;transition:.15s}
.sb-resume:hover{border-color:rgba(6,182,212,.45);color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.07)}
.sb-empty{text-align:center;padding:34px 18px;color:var(--ink2);border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge)}
.sb-empty .ic{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;margin:0 auto 13px;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.sb-empty .ic svg{width:22px;height:22px}
.sb-empty b{display:block;font-size:15px;font-weight:600;color:var(--ink);margin-bottom:6px}
.sb-empty span{font-size:12.5px;line-height:1.55;display:block;max-width:46ch;margin:0 auto}
.sb-empty code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;background:var(--glass2);padding:1px 5px;border-radius:5px}
.sb-more{display:block;margin:14px auto 0;font:inherit;font-size:12px;font-weight:600;color:var(--ink3);background:none;border:none;cursor:pointer;padding:6px 12px;border-radius:999px}
.sb-more:hover{color:var(--cyan-d,#0891b2);background:var(--fill-weak)}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Task list (main column)
// ════════════════════════════════════════════════════════════════════════════
function TaskList({
  tasks,
  loading,
  error,
  onChat,
  onRun,
  onRefresh,
  runningTaskIds,
}: {
  tasks: NotionTask[];
  loading: boolean;
  error: string | null;
  onChat: (t: NotionTask) => void;
  onRun: (t: NotionTask) => void;
  onRefresh: () => void;
  runningTaskIds: Set<string>;
}) {
  return (
    <section className="dash-main">
      <div className="dash-main-head">
        <div>
          <div className="ptitle">Aufgaben</div>
          <div className="psub">
            Notion-synchronisiert · an u1 delegieren oder lokal mit Claude
            ausführen.
          </div>
        </div>
        <button className="btn-ghost minibtn dash-refresh" onClick={onRefresh}>
          <span className={`dash-ic ${loading ? "dash-spin" : ""}`}>
            <Svg d={ICONS.refresh} />
          </span>
          Aktualisieren
        </button>
      </div>

      {error && <div className="callout dash-err">
        <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        <div>
          <b>Notion nicht erreichbar</b>
          <span>{error}</span>
        </div>
      </div>}

      {loading && tasks.length === 0 ? (
        <div className="dash-loading">
          <span className="spinner" />
          Lade Aufgaben…
        </div>
      ) : tasks.length === 0 && !error ? (
        <div className="card center dash-tasks-empty">
          <div className="dash-empty-ic">
            <Svg d={ICONS.task} />
          </div>
          <b>Keine offenen Aufgaben</b>
          <span className="hint center">
            Sobald in Notion Tasks anstehen, erscheinen sie hier als Glass-Reihen.
          </span>
        </div>
      ) : (
        <div className="dash-tasks">
          {tasks.map((t) => {
            const pill = statusPill(t.status);
            const running = runningTaskIds.has(t.id);
            return (
              <div className="dash-task" key={t.id}>
                <div className="dash-task-main">
                  <div className="dash-task-top">
                    <span className={`pill ${pill.cls}`}>{pill.label}</span>
                    {running && <span className="badge">läuft lokal</span>}
                  </div>
                  <div className="dash-task-title">{t.title || "Untitled"}</div>
                  {typeof t.assignee === "string" && t.assignee && (
                    <div className="dash-task-meta">{t.assignee}</div>
                  )}
                </div>
                <div className="dash-task-actions">
                  <button
                    className="btn-ghost minibtn dash-act"
                    onClick={() => onChat(t)}
                    title="Diese Aufgabe mit u1 besprechen"
                  >
                    <span className="dash-ic">
                      <Svg d={ICONS.chat} />
                    </span>
                    Chat mit u1
                  </button>
                  <button
                    className="btn btn-primary minibtn dash-act"
                    onClick={() => onRun(t)}
                    title="Lokal mit Claude ausführen"
                  >
                    <span className="dash-ic">
                      <Svg d={ICONS.play} />
                    </span>
                    Lokal ausführen
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Dashboard view (composes main + panel + pane)
// ════════════════════════════════════════════════════════════════════════════
function DashboardView({ host }: { host: HostApi }) {
  const [tasks, setTasks] = useState<NotionTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);

  const [terms, setTerms] = useState<TermInfo[]>([]);
  const [termsRefreshing, setTermsRefreshing] = useState(false);
  const [activeTerm, setActiveTerm] = useState<TermInfo | null>(null);
  const [runningTaskIds, setRunningTaskIds] = useState<Set<string>>(new Set());

  // The Arbeitsplatz: every Claude Code session on the Mac (external incl.).
  const [sessions, setSessions] = useState<ClaudeSession[]>([]);
  const [sessionsRefreshing, setSessionsRefreshing] = useState(false);

  // Scroll the terminal rail into view when a pane opens (e.g. after a session click).
  const railRef = useRef<HTMLDivElement>(null);

  // Local answer models (the downloaded ollama ones) used by "Lokal ausführen".
  const [runModels, setRunModels] = useState<{ id: string; label: string }[]>([]);
  const [runModel, setRunModel] = useState<string>("");

  // ── Notion tasks ──
  const loadTasks = useCallback(async () => {
    setTasksLoading(true);
    setTasksError(null);
    try {
      const list = await host.notion.listTasks();
      setTasks(list);
    } catch (err) {
      setTasksError(err instanceof Error ? err.message : String(err));
    } finally {
      setTasksLoading(false);
    }
  }, [host]);

  // ── Terminals ──
  const loadTerms = useCallback(async () => {
    setTermsRefreshing(true);
    try {
      const list = await host.terminals.list();
      setTerms(list);
      // Keep the active pane in sync (running flag may have flipped).
      setActiveTerm((cur) =>
        cur ? list.find((t) => t.id === cur.id) ?? cur : cur
      );
    } catch {
      /* terminals backend not present (browser) — leave empty */
    } finally {
      setTermsRefreshing(false);
    }
  }, [host]);

  // ── Claude sessions (the Arbeitsplatz) ──
  const loadSessions = useCallback(async () => {
    setSessionsRefreshing(true);
    try {
      const list = await host.terminals.sessions();
      setSessions(list);
    } catch {
      /* not in Tauri / no backend — leave empty */
    } finally {
      setSessionsRefreshing(false);
    }
  }, [host]);

  // Resume any discovered session in a fresh in-app terminal (claude --resume <id>
  // in its project dir) — bridges an external session into the cockpit.
  const resumeSession = useCallback(
    async (s: ClaudeSession) => {
      // Defense-in-depth: only resume a uuid-shaped id (it becomes a `claude
      // --resume <id>` arg). Non-uuid ids can't come from a real session anyway.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s.id)) {
        host.notifications.notify("Fortsetzen nicht möglich", "Session-ID ungültig.");
        return;
      }
      try {
        const id = await host.terminals.spawn({
          cmd: "claude",
          args: ["--resume", s.id],
          cwd: s.cwdExists ? s.projectPath : undefined,
          title: s.title,
        });
        host.notifications.notify("Session fortgesetzt", `${s.title} · ${s.projectName}`);
        await loadTerms();
        const list = await host.terminals.list();
        setActiveTerm(list.find((t) => t.id === id) ?? null);
      } catch (e) {
        host.notifications.notify(
          "Fortsetzen fehlgeschlagen",
          e instanceof Error ? e.message : String(e)
        );
      }
    },
    [host, loadTerms]
  );

  // Projects the cockpit can open a terminal in.
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  useEffect(() => {
    host.terminals.projects().then(setProjects).catch(() => setProjects([]));
  }, [host]);

  // Open an interactive shell in a project → it shows in the cockpit, grouped.
  const newTerminal = useCallback(
    async (proj: ProjectInfo) => {
      try {
        const id = await host.terminals.spawn({ cmd: "zsh", cwd: proj.path, title: proj.name });
        host.notifications.notify("Terminal gestartet", proj.name);
        await loadTerms();
        const list = await host.terminals.list();
        setActiveTerm(list.find((t) => t.id === id) ?? null);
      } catch (e) {
        host.notifications.notify("Fehler", e instanceof Error ? e.message : String(e));
      }
    },
    [host, loadTerms]
  );

  // Load the LOCAL answer models (the downloaded ollama ones) for "Lokal ausführen".
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = (await host.storage.get("dashboard.runModel")) as string | undefined;
        const res = await host.backend.fetch("atlas-api", "/api/m/models");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          models: { id: string; label: string; kind: string; available: boolean }[];
          default?: string;
        };
        const local = (data.models ?? [])
          .filter((m) => m.kind === "local" && m.available)
          .map((m) => ({ id: m.id, label: m.label }));
        setRunModels(local);
        const pick =
          saved && local.some((m) => m.id === saved)
            ? saved
            : data.default ?? local[0]?.id ?? "";
        setRunModel(pick);
      } catch {
        /* offline / no backend — "Lokal ausführen" falls back to a default model */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  const selectRunModel = useCallback(
    (id: string) => {
      setRunModel(id);
      void host.storage.set("dashboard.runModel", id);
    },
    [host]
  );

  useEffect(() => {
    void loadTasks();
    void loadTerms();
    void loadSessions();
    // Poll terminals + Claude sessions so the board stays live.
    const iv = window.setInterval(() => void loadTerms(), 2500);
    const sv = window.setInterval(() => void loadSessions(), 4000);
    return () => {
      window.clearInterval(iv);
      window.clearInterval(sv);
    };
  }, [loadTasks, loadTerms, loadSessions]);

  // ── Row actions ──
  const onChat = useCallback(
    (t: NotionTask) => {
      host.events.emit(CHAT_SEED_TOPIC, {
        taskId: t.id,
        title: t.title,
        status: t.status,
        url: t.url,
      });
      host.nav.navigate("chat");
    },
    [host]
  );

  const onRun = useCallback(
    async (t: NotionTask) => {
      // Argument-injection guard: a task title starting with "-" could be parsed as a
      // claude FLAG (e.g. an agent permission-bypass) instead of the prompt — and task
      // titles will come from Notion (external content). Refuse such titles, and pass
      // the prompt AFTER a "--" end-of-options separator so it's always positional.
      const prompt = (t.title ?? "").trim();
      if (!prompt || prompt.startsWith("-")) {
        host.notifications.notify(
          "Lokaler Start abgelehnt",
          "Unsicherer Aufgaben-Titel (leer oder beginnt mit „-“)."
        );
        return;
      }
      try {
        // Run the task on a LOCAL model (the downloaded ollama ones) — not the cloud.
        // `ollama run <model> <prompt>`: the prompt is positional, so the "-" guard
        // above (rejecting titles starting with "-") stops it being read as a flag.
        const llm = runModel || "qwen2.5:7b-instruct";
        const id = await host.terminals.spawn({
          cmd: "ollama",
          args: ["run", llm, prompt],
          taskId: t.id,
          title: t.title,
        });
        setRunningTaskIds((s) => new Set(s).add(t.id));
        host.notifications.notify("Lokal gestartet", `${llm} arbeitet an: ${t.title}`);
        await loadTerms();
        // Open the freshly spawned pty in the pane.
        const list = await host.terminals.list();
        const fresh = list.find((x) => x.id === id);
        if (fresh) setActiveTerm(fresh);
      } catch (err) {
        host.notifications.notify(
          "Start fehlgeschlagen",
          err instanceof Error ? err.message : String(err)
        );
      }
    },
    [host, loadTerms, runModel]
  );

  const openTerm = useCallback((t: TermInfo) => setActiveTerm(t), []);
  const closePane = useCallback(() => setActiveTerm(null), []);

  // When a terminal pane opens (e.g. via a session-card click), bring it into view.
  useEffect(() => {
    if (activeTerm) railRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [activeTerm]);

  const activeTermId = activeTerm?.id ?? null;

  const headline = useMemo(() => {
    const live = terms.filter((t) => t.running).length;
    return live > 0 ? `${live} aktiv` : `${tasks.length} Aufgaben`;
  }, [terms, tasks.length]);

  return (
    <div className="dash">
      <DashStyle />

      <div className="dash-hero">
        <div className="dash-hero-tx">
          <h1>Ops Board</h1>
          <p>
            Notion-Aufgaben, an u1 delegierbar oder lokal mit Claude ausführbar —
            mit Live-Terminals direkt daneben.
          </p>
        </div>
        <span className="chip dash-hero-chip">
          <Svg d={ICONS.spark} />
          {headline}
        </span>
      </div>

      {runModels.length > 0 && (
        <div className="dash-runbar">
          <span className="dash-runbar-lbl">Lokal ausführen mit</span>
          {runModels.map((m) => (
            <button
              key={m.id}
              className={`chip dash-runchip${m.id === runModel ? " on" : ""}`}
              onClick={() => selectRunModel(m.id)}
              title={`Aufgaben lokal mit ${m.label} ausführen`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}

      <SessionsBoard
        host={host}
        sessions={sessions}
        refreshing={sessionsRefreshing}
        onResume={resumeSession}
        onRefresh={loadSessions}
      />

      <div className="dash-grid">
        <TaskList
          tasks={tasks}
          loading={tasksLoading}
          error={tasksError}
          onChat={onChat}
          onRun={onRun}
          onRefresh={loadTasks}
          runningTaskIds={runningTaskIds}
        />

        <div className="dash-rail" ref={railRef}>
          {activeTerm ? (
            <TerminalPane host={host} term={activeTerm} onClose={closePane} />
          ) : (
            <TerminalsPanel
              host={host}
              terms={terms}
              projects={projects}
              refreshing={termsRefreshing}
              activeId={activeTermId}
              onOpen={openTerm}
              onNew={newTerminal}
              onRefresh={loadTerms}
            />
          )}

          {/* When a pane is open, keep a compact terminal switcher beneath it. */}
          {activeTerm && terms.length > 1 && (
            <div className="dash-switcher">
              <div className="sect" style={{ margin: "0 0 8px" }}>
                Wechseln
              </div>
              <div className="dash-switcher-row">
                {terms.map((t) => (
                  <button
                    key={t.id}
                    className={`chip dash-switch-chip${
                      t.id === activeTermId ? " on" : ""
                    }`}
                    onClick={() => openTerm(t)}
                  >
                    <span className={`dash-dot ${t.running ? "on" : "off"}`} />
                    {t.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Scoped layout — desktop two-column + terminal pane. Tokens ONLY.
// ════════════════════════════════════════════════════════════════════════════
function DashStyle() {
  return (
    <style>{`
.dash{width:100%;max-width:1200px;margin:0 auto;padding:26px 28px 56px}
.dash-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:18px;margin:6px 2px 22px}
.dash-hero-tx h1{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.dash-hero-tx p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:54ch;letter-spacing:-.006em}
.dash-hero-chip{cursor:default;gap:7px;padding:8px 14px;font-weight:600}
.dash-hero-chip svg{width:14px;height:14px;stroke:var(--cyan-d)}

.dash-runbar{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 2px 16px}
.dash-runbar-lbl{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);margin-right:2px}
.dash-runchip{font-weight:550;color:var(--ink2)}
.dash-runchip.on{border-color:rgba(6,182,212,.4);color:var(--cyan-d);background:rgba(6,182,212,.08)}
.dash-grid{display:grid;grid-template-columns:minmax(0,1fr) 384px;gap:20px;align-items:start}
@media(max-width:980px){.dash-grid{grid-template-columns:1fr}}

/* ── main: tasks ── */
.dash-main{min-width:0}
.dash-main-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin-bottom:16px}
.dash-refresh{display:inline-flex;align-items:center;gap:8px;width:auto}
.dash-ic{display:inline-flex;width:16px;height:16px}
.dash-ic svg,.dash-mini .ic svg,.dash-mini2 svg{width:16px;height:16px}
.dash-err{margin:0 0 16px}
.dash-tasks{display:flex;flex-direction:column;gap:12px}
.dash-task{display:flex;align-items:center;gap:16px;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r-sm);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);padding:16px 18px;transition:transform .22s cubic-bezier(.2,.8,.2,1),box-shadow .22s}
.dash-task:hover{transform:translateY(-1px);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.dash-task-main{flex:1;min-width:0}
.dash-task-top{display:flex;align-items:center;gap:8px}
.dash-task-title{font-size:15.5px;font-weight:600;letter-spacing:-.012em;margin-top:8px;line-height:1.35}
.dash-task-meta{font-size:12.5px;color:var(--ink3);margin-top:4px}
.dash-task-actions{display:flex;gap:9px;flex:none}
.dash-act{display:inline-flex;align-items:center;gap:7px;width:auto;white-space:nowrap}
@media(max-width:640px){.dash-task{flex-direction:column;align-items:stretch}.dash-task-actions{justify-content:flex-end}}

.dash-loading,.dash-emptyterm{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--ink2);font-size:13.5px;padding:48px 0}
.dash-tasks-empty{padding:40px 28px}
.dash-empty-ic,.dash-panel-empty .ic{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;margin:0 auto 14px;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.dash-empty-ic svg,.dash-panel-empty .ic svg{width:22px;height:22px}
.dash-tasks-empty b{display:block;font-size:16px;font-weight:600;color:var(--ink);margin-bottom:6px}

/* ── rail / panel ── */
.dash-rail{display:flex;flex-direction:column;gap:16px;position:sticky;top:8px}
.dash-panel{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px 18px 16px}
.dash-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.dash-mini{width:auto}
.dash-mini .ic{width:32px;height:32px;border-radius:10px}
.dash-panel-empty{text-align:center;padding:26px 14px 18px;color:var(--ink2)}
.dash-panel-empty b{display:block;font-size:14.5px;font-weight:600;color:var(--ink);margin-bottom:5px}
.dash-panel-empty span{font-size:12.5px;line-height:1.5;display:block;max-width:30ch;margin:0 auto}

.dash-termlist{margin-top:10px;gap:9px}
.dash-termrow{cursor:pointer;align-items:center;gap:11px;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s,background .18s}
.dash-termrow:hover{transform:translateY(-1px);border-color:var(--line2)}
.dash-termrow.is-active{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.08)}
.dash-termrow-tx{flex:1;min-width:0}
.dash-termrow-title{font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-termrow-prev{font-size:11.5px;color:var(--ink3);font-family:ui-monospace,"SF Mono",Menlo,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}

.dash-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dash-dot.on{background:var(--ok);box-shadow:0 0 0 3px var(--ok-bg)}
.dash-dot.off{background:var(--ink3);opacity:.6}

/* ── terminal pane ── */
.dash-termpane{padding:16px 16px 14px;display:flex;flex-direction:column;gap:12px}
.dash-termhd{margin:0;align-items:center;gap:11px}
.dash-termtitle{font-size:16px;font-weight:600;letter-spacing:-.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-termhd p{font-size:11.5px;color:var(--ink3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dash-x{width:auto}
.dash-x .ic{width:30px;height:30px;border-radius:9px}
.dash-x .ic svg{width:15px;height:15px}
.dash-codebox{text-align:left;margin:0;padding:14px 15px;height:340px;overflow:auto;background:var(--fill-focus);border-color:var(--line)}
html.dark .dash-codebox{background:rgba(2,8,18,.6)}
.dash-pre{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;line-height:1.55;color:var(--prose);white-space:pre-wrap;word-break:break-word;margin:0}
.dash-terminput{display:flex;gap:9px;align-items:center}
.dash-termfld{margin-top:0;font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:13px;padding:12px 14px}
.dash-termsend{width:auto;flex:none;padding:12px 14px}
.dash-termsend svg{width:17px;height:17px}

/* ── switcher beneath an open pane ── */
.dash-switcher{padding:0 2px}
.dash-switcher-row{display:flex;flex-wrap:wrap;gap:7px}
.dash-switch-chip{gap:7px}
.dash-switch-chip.on{border-color:rgba(6,182,212,.4);color:var(--cyan-d)}

.dash-spin{animation:dash-rot .9s linear infinite}
@keyframes dash-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.dash-spin{animation:none}}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Plugin module
// ════════════════════════════════════════════════════════════════════════════
let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "dashboard",
    name: "Dashboard",
    version: "1.0.0",
    description:
      "Ops board — Notion tasks, delegate to u1 or run locally, live terminals.",
    icon: ICON,
    permissions: ["notion", "terminals", "notifications", "storage", "backend:atlas-api"],
    nav: { section: "ops", order: 0 },
    commands: [
      { id: "open", title: "Go to Ops Board" },
      { id: "refresh", title: "Dashboard: refresh tasks" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<DashboardView host={host} />);
    offCmd = host.events.on("command:dashboard:open", () =>
      host.nav.navigate("dashboard")
    );
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
