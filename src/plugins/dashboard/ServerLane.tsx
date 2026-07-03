/**
 * ServerLane — die u1-Server-Terminals (tmux auf subunit-server) im Cockpit.
 *
 * „Zwei Hände, ein Gehirn": die Bot-/Arbeits-Sessions des Servers erscheinen
 * neben den lokalen Claude-Sessions. Read: `list_remote_sessions` (30s-Poll) +
 * `remote_capture` (5s, nur für die geöffnete Karte). Write: `remote_send` —
 * das unitone*-Gate erzwingt Rust, nicht dieses UI.
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../../lib/ipc";

interface RemoteSession {
  name: string;
  attached: boolean;
  lastActivity: number;
}

const NICE: Record<string, string> = {
  unitone: "u1 · TJ (privat)",
  "unitone-group": "u1 · Gruppe",
  "unitone-erik": "u1 · Erik",
  "unitone-dirk": "u1 · Dirk",
  "unitone-gate": "u1 · Gate",
};

function rel(ts: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "jetzt";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export function ServerLane() {
  const [sessions, setSessions] = useState<RemoteSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  // Session-Liste (30s) — ssh über Cloudflare ist nicht gratis, nicht hämmern.
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const load = () =>
      invoke<RemoteSession[]>("list_remote_sessions")
        .then((s) => {
          if (alive) {
            setSessions(s);
            setError(null);
          }
        })
        .catch((e) => {
          if (alive) setError(e instanceof Error ? e.message : String(e));
        });
    void load();
    const t = window.setInterval(load, 30_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  // Capture der geöffneten Karte (5s).
  useEffect(() => {
    if (!isTauri() || !open) return;
    let alive = true;
    const load = () =>
      invoke<string>("remote_capture", { session: open, lines: 40 })
        .then((s) => alive && setCapture(s))
        .catch(() => {});
    setCapture("");
    void load();
    const t = window.setInterval(load, 5_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open]);

  const send = useCallback(() => {
    if (!open || !draft.trim() || sending) return;
    const text = draft.trim();
    setSending(true);
    setDraft("");
    void invoke("remote_send", { session: open, text })
      .then(() => invoke<string>("remote_capture", { session: open, lines: 40 }))
      .then((s) => setCapture(s))
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setDraft((d) => (d ? d : text));
      })
      .finally(() => setSending(false));
  }, [open, draft, sending]);

  if (!isTauri()) return null;

  return (
    <section className="card dash-srv">
      <style>{CSS}</style>
      <div className="dash-panel-head">
        <div className="sect" style={{ margin: 0 }}>
          Server · subunit-server
        </div>
        {sessions && <span className="dash-proj-count">{sessions.length}</span>}
      </div>

      {error && <div className="dash-srv-err">{error}</div>}
      {!sessions && !error && (
        <div className="dash-panel-empty">
          <span className="spinner" /> Verbinde…
        </div>
      )}

      {sessions && (
        <div className="dash-srv-list">
          {sessions.map((s) => {
            const injectable = s.name.startsWith("unitone");
            const isOpen = open === s.name;
            return (
              <div key={s.name} className={`dash-srv-item${isOpen ? " open" : ""}`}>
                <button className="dash-srv-row" onClick={() => setOpen(isOpen ? null : s.name)}>
                  <span className={`dash-srv-dot${s.attached ? " on" : ""}`} />
                  <span className="dash-srv-name">{NICE[s.name] || s.name}</span>
                  <span className="dash-srv-meta">
                    {rel(s.lastActivity)}
                    {!injectable && " · read-only"}
                  </span>
                </button>
                {isOpen && (
                  <div className="dash-srv-body">
                    <pre className="dash-srv-pre">{capture || "Lade…"}</pre>
                    {injectable && (
                      <div className="dash-srv-send">
                        <input
                          className="fld"
                          placeholder={`An ${NICE[s.name] || s.name} tippen…`}
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              send();
                            }
                          }}
                        />
                        <button className="btn btn-primary minibtn" disabled={!draft.trim() || sending} onClick={send}>
                          {sending ? "…" : "Senden"}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {sessions.length === 0 && (
            <div className="dash-panel-empty">
              <b>Keine tmux-Sessions</b>
              <span>Auf dem Server läuft gerade kein tmux.</span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

const CSS = `
.dash-srv{display:flex;flex-direction:column;gap:10px}
.dash-srv-err{font-size:11.5px;color:var(--red,#b91c1c);padding:2px 4px}
.dash-srv-list{display:flex;flex-direction:column;gap:6px}
.dash-srv-item{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--glass2)}
.dash-srv-item.open{border-color:rgba(6,182,212,.4)}
.dash-srv-row{display:flex;align-items:center;gap:8px;width:100%;padding:8px 11px;background:none;border:none;cursor:pointer;font:inherit;color:var(--ink);text-align:left}
.dash-srv-row:hover{background:var(--fill)}
.dash-srv-dot{width:8px;height:8px;border-radius:50%;background:var(--line2,var(--line));flex:none}
.dash-srv-dot.on{background:var(--ok,#22c55e);box-shadow:0 0 6px rgba(34,197,94,.6)}
.dash-srv-name{font-size:12.5px;font-weight:650;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dash-srv-meta{font-size:10.5px;color:var(--ink3);flex:none}
.dash-srv-body{display:flex;flex-direction:column;gap:8px;padding:0 10px 10px}
.dash-srv-pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.5;color:var(--prose);white-space:pre-wrap;word-break:break-word;margin:0;max-height:260px;overflow-y:auto;padding:9px 10px;border-radius:9px;background:var(--fill-focus);border:1px solid var(--line)}
html.dark .dash-srv-pre{background:rgba(2,8,18,.55)}
.dash-srv-send{display:flex;gap:7px}
.dash-srv-send .fld{flex:1;min-width:0}
`;
