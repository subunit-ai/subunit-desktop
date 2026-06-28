/**
 * U1Assistant — a ubiquitous, context-aware U1 helper (Notion-AI style).
 *
 * A small U1 orb sits bottom-right on EVERY page. Click it (or ⌘J) and a glass
 * popover opens where you ask U1 about whatever you're doing — it knows which
 * page you're on and streams its answer inline.
 *
 * Backend: the REAL u1 — chat.subunit.ai (unitone-chat, `claude -p --resume`),
 * Bearer-authed with the Subunit token (the /api is NOT behind Cloudflare Access,
 * it just needs the bearer). One persistent thread continues across pages, so the
 * conversation has memory. The current page is passed as context on each turn.
 *
 * Shell-level (not a plugin): lives in App.tsx, above the stage, so it's present
 * everywhere and reads the active page from the shell.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../lib/ipc";
import { SubunitMark } from "./SubunitMark";
import type { ClaudeSession, ProjectInfo } from "../plugin/types";

/** A piece of context the user attached (Notion-style @) — a project or a session. */
interface CtxItem {
  key: string;
  kind: "project" | "session";
  label: string;
  path?: string;
  detail?: string;
}

/** Where U1 runs — local model or Claude over the Max subscription. */
type Provider = "claude" | "local";
const PROVIDER_KEY = "subunit.u1.provider";
const PROVIDERS: { id: Provider; label: string; model: string; hint: string }[] = [
  { id: "claude", label: "Claude · Abo", model: "opus", hint: "Opus über dein Max-Abo (claude -p)" },
  { id: "local", label: "Lokal", model: "qwen2.5:7b-instruct", hint: "On-device via ollama, privat" },
];

const U1_SYSTEM =
  "Du bist U1 (Unit One), TJs operativer KI-Partner — kein generischer Assistent. " +
  "Du läufst lokal in der Subunit-Desktop-App auf dem Mac. Sprich von „wir/uns“, sei direkt, " +
  "kompetent und knapp, mit Markdown wenn es hilft, und beende mit einem klaren nächsten Schritt. Antworte auf Deutsch.";

interface Msg {
  role: "user" | "u1";
  text: string;
}

// Tauri streaming events from assistant.rs (u1_ask).
const U1_EVENTS = { delta: "u1://delta", done: "u1://done", error: "u1://error" } as const;
interface DeltaEvt { requestId: string; text: string }
interface DoneEvt { requestId: string }
interface ErrEvt { requestId: string; message: string }

export function U1Assistant({ pageName }: { pageName: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>(() => {
    try {
      return (localStorage.getItem(PROVIDER_KEY) as Provider) || "claude";
    } catch {
      return "claude";
    }
  });
  // Notion-style attached context (projects / sessions U1 should access).
  const [ctx, setCtx] = useState<CtxItem[]>([]);
  const [attachOpen, setAttachOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [attachSessions, setAttachSessions] = useState<ClaudeSession[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reqRef = useRef<string | null>(null);
  const lastActivityRef = useRef(0);
  // Latest msgs in a ref so the once-mounted stream listener appends correctly.
  const msgsRef = useRef<Msg[]>([]);
  useEffect(() => {
    msgsRef.current = msgs;
  }, [msgs]);

  const pickProvider = useCallback((p: Provider) => {
    setProvider(p);
    try {
      localStorage.setItem(PROVIDER_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  // Lazy-load the attach picker's projects + sessions when it opens.
  useEffect(() => {
    if (!attachOpen || !isTauri()) return;
    invoke<ProjectInfo[]>("list_projects").then(setProjects).catch(() => {});
    invoke<ClaudeSession[]>("list_claude_sessions").then(setAttachSessions).catch(() => {});
  }, [attachOpen]);

  const addProject = useCallback((p: ProjectInfo) => {
    setCtx((c) => (c.some((x) => x.key === `p:${p.path}`) ? c : [...c, { key: `p:${p.path}`, kind: "project", label: p.name, path: p.path }]));
    setAttachOpen(false);
  }, []);
  const addSession = useCallback((s: ClaudeSession) => {
    setCtx((c) => (c.some((x) => x.key === `s:${s.id}`) ? c : [...c, { key: `s:${s.id}`, kind: "session", label: s.title, path: s.cwdExists ? s.projectPath : undefined, detail: s.lastPrompt }]));
    setAttachOpen(false);
  }, []);
  const removeCtx = useCallback((key: string) => setCtx((c) => c.filter((x) => x.key !== key)), []);

  // Stream listener (mounted once): append deltas / finish / error for the active request.
  useEffect(() => {
    if (!isTauri()) return;
    const offs: UnlistenFn[] = [];
    let alive = true;
    const reg = (p: Promise<UnlistenFn>) => p.then((u) => (alive ? offs.push(u) : u()));
    const appendDelta = (t: string) =>
      setMsgs((m) => {
        const next = m.slice();
        const last = next[next.length - 1];
        if (last && last.role === "u1") next[next.length - 1] = { role: "u1", text: last.text + t };
        return next;
      });
    reg(
      listen<DeltaEvt>(U1_EVENTS.delta, (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        lastActivityRef.current = Date.now();
        appendDelta(e.payload.text);
      })
    );
    reg(
      listen<DoneEvt>(U1_EVENTS.done, (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        reqRef.current = null;
        setBusy(false);
      })
    );
    reg(
      listen<ErrEvt>(U1_EVENTS.error, (e) => {
        if (e.payload.requestId !== reqRef.current) return;
        reqRef.current = null;
        setBusy(false);
        setErr(e.payload.message || "Antwort fehlgeschlagen.");
        setMsgs((cur) => {
          const n = cur.slice();
          if (n.length && n[n.length - 1].role === "u1" && !n[n.length - 1].text) n.pop();
          return n;
        });
      })
    );
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, []);

  // Inactivity watchdog: if a request produces no delta/done/error for a while
  // (hung model/CLI), unstick the UI so "busy" can never wedge forever.
  useEffect(() => {
    const iv = window.setInterval(() => {
      if (reqRef.current && Date.now() - lastActivityRef.current > 90000) {
        reqRef.current = null;
        setBusy(false);
        setErr("Zeitüberschreitung — U1 hat zu lange nicht geantwortet. Nochmal versuchen oder den Anbieter wechseln.");
        setMsgs((cur) => {
          const n = cur.slice();
          if (n.length && n[n.length - 1].role === "u1" && !n[n.length - 1].text) n.pop();
          return n;
        });
      }
    }, 5000);
    return () => window.clearInterval(iv);
  }, []);

  // ⌘J / Ctrl-J toggles; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Focus the input + scroll to bottom when opening / on new messages.
  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, open]);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      // reqRef is a synchronous guard against double-submit (busy may not have
      // re-rendered yet between two fast clicks).
      if (!text || busy || reqRef.current) return;
      setErr(null);
      setInput("");
      if (!isTauri()) {
        setErr("Der Assistent läuft in der Subunit-App (lokales Modell oder Claude-Abo) — im Browser nicht verfügbar.");
        return;
      }
      // Build the conversation (system + prior turns + new question) for the model.
      const history = msgsRef.current
        .map((m) => ({ role: m.role === "u1" ? "assistant" : "user", content: m.text }))
        .filter((m) => m.content.trim());
      // Attached context — tell U1 where it is + what it may access. For the claude
      // provider we ALSO set cwd to the first attached project so it can read files.
      const ctxLines = ctx.map((c) =>
        c.kind === "project"
          ? `- Projekt „${c.label}" — Ordner ${c.path}. Du kannst die Dateien dort direkt lesen.`
          : `- Claude-Session „${c.label}"${c.detail ? ` (arbeitet an: ${c.detail})` : ""}${c.path ? ` — Ordner ${c.path}` : ""}.`
      );
      const ctxBlock = ctxLines.length ? `\n\nAngehängter Kontext (du hast Zugriff darauf):\n${ctxLines.join("\n")}` : "";
      const cwd = ctx.find((c) => c.path)?.path;
      const messages = [
        { role: "system", content: `${U1_SYSTEM}\n\nDu hilfst gerade auf der Seite „${pageName}".${ctxBlock}` },
        ...history,
        { role: "user", content: text },
      ];
      setMsgs((m) => [...m, { role: "user", text }, { role: "u1", text: "" }]);
      setBusy(true);
      const reqId = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      reqRef.current = reqId;
      lastActivityRef.current = Date.now();
      const conf = PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0];
      try {
        // Returns immediately; the answer streams back via the u1://* listener.
        await invoke("u1_ask", { requestId: reqId, provider, model: conf.model, messages, cwd });
      } catch (e) {
        reqRef.current = null;
        setBusy(false);
        setErr(e instanceof Error ? e.message : String(e));
        setMsgs((cur) => {
          const n = cur.slice();
          if (n.length && n[n.length - 1].role === "u1" && !n[n.length - 1].text) n.pop();
          return n;
        });
      }
    },
    [busy, pageName, provider, ctx]
  );

  // Plugins (e.g. E-Mail) can ask U1 with their own context via a window event:
  //   window.dispatchEvent(new CustomEvent("u1:ask", { detail: { question } }))
  useEffect(() => {
    const onAsk = (e: Event) => {
      const q = (e as CustomEvent<{ question?: string }>).detail?.question;
      if (typeof q === "string" && q.trim()) {
        setOpen(true);
        void ask(q);
      }
    };
    window.addEventListener("u1:ask", onAsk as EventListener);
    return () => window.removeEventListener("u1:ask", onAsk as EventListener);
  }, [ask]);

  const SUGGESTIONS = [
    `Was kann ich auf „${pageName}" tun?`,
    "Fasse den aktuellen Stand zusammen",
    "Woran arbeiten wir gerade?",
  ];

  return (
    <>
      <AssistantStyle />
      {/* floating orb */}
      <button
        className={`u1a-fab${open ? " on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="U1 fragen (⌘J)"
        aria-label="U1 fragen"
      >
        <SubunitMark size={22} style={{ color: "#fff" }} />
        <span className="u1a-fab-ping" />
      </button>

      {open && (
        <div className="u1a-pop" role="dialog" aria-label="U1 Assistent">
          <div className="u1a-head">
            <span className="u1a-orb"><SubunitMark size={16} style={{ color: "#fff" }} /></span>
            <div className="u1a-head-tx">
              <b>U1</b>
              <span className="u1a-ctx">auf: {pageName}</span>
            </div>
            <div className="u1a-prov" role="group" aria-label="Wo U1 läuft">
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  className={`u1a-prov-b${provider === p.id ? " on" : ""}`}
                  title={p.hint}
                  onClick={() => pickProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <button className="u1a-x" onClick={() => setOpen(false)} aria-label="Schließen">
              <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>

          <div className="u1a-body" ref={bodyRef}>
            {msgs.length === 0 ? (
              <div className="u1a-empty">
                <span className="u1a-empty-orb"><SubunitMark size={26} style={{ color: "var(--cyan)" }} /></span>
                <p>Frag mich was — ich kenne die Seite, auf der du bist, und das ganze System.</p>
                <div className="u1a-sugg">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} className="u1a-sugg-b" onClick={() => void ask(s)}>{s}</button>
                  ))}
                </div>
              </div>
            ) : (
              msgs.map((m, i) => (
                <div key={i} className={`u1a-msg ${m.role}`}>
                  {m.role === "u1" && <span className="u1a-msg-orb"><SubunitMark size={13} style={{ color: "#fff" }} /></span>}
                  <div className="u1a-bub">
                    {m.text || (busy && i === msgs.length - 1 ? <span className="u1a-typing"><i /><i /><i /></span> : "")}
                  </div>
                </div>
              ))
            )}
            {err && <div className="u1a-err">{err}</div>}
          </div>

          <div className="u1a-ctxbar">
            <div className="u1a-add-wrap">
              <button className="u1a-add" onClick={() => setAttachOpen((o) => !o)} title="Kontext anhängen (Projekt / Session)">+</button>
              {attachOpen && (
                <div className="u1a-attach" onMouseLeave={() => setAttachOpen(false)}>
                  <div className="u1a-attach-sec">Projekte</div>
                  {projects.length === 0 ? (
                    <div className="u1a-attach-empty">—</div>
                  ) : (
                    projects.slice(0, 12).map((p) => (
                      <button key={p.path} className="u1a-attach-i" onClick={() => addProject(p)}>
                        <span className="u1a-attach-d project" /> {p.name}
                        {p.git && <span className="u1a-attach-git">git</span>}
                      </button>
                    ))
                  )}
                  <div className="u1a-attach-sec">Sessions</div>
                  {attachSessions.length === 0 ? (
                    <div className="u1a-attach-empty">—</div>
                  ) : (
                    attachSessions.slice(0, 12).map((s) => (
                      <button key={s.id} className="u1a-attach-i" onClick={() => addSession(s)}>
                        <span className="u1a-attach-d session" /> <span className="u1a-attach-t">{s.title}</span>
                        <span className="u1a-attach-proj">{s.projectName}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <span className="u1a-chip page" title="Aktuelle Seite">{pageName}</span>
            {ctx.map((c) => (
              <span key={c.key} className={`u1a-chip ${c.kind}`} title={c.path || c.detail || c.label}>
                <span className={`u1a-chip-d ${c.kind}`} />
                {c.label}
                <button className="u1a-chip-x" onClick={() => removeCtx(c.key)} aria-label="Entfernen">×</button>
              </span>
            ))}
          </div>

          <div className="u1a-input">
            <textarea
              ref={inputRef}
              className="u1a-ta"
              placeholder="U1 fragen…"
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(input);
                }
              }}
            />
            <button className="u1a-send" disabled={!input.trim() || busy} onClick={() => void ask(input)} aria-label="Senden">
              {busy ? <span className="u1a-spin" /> : <svg viewBox="0 0 24 24"><path d="M7 11l5-5 5 5M12 6v12" /></svg>}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function AssistantStyle() {
  return (
    <style>{`
.u1a-fab{position:fixed;right:22px;bottom:22px;z-index:300;width:52px;height:52px;border-radius:50%;border:none;display:grid;place-items:center;cursor:pointer;background:linear-gradient(160deg,#22d3ee,#06b6d4);box-shadow:0 12px 30px -8px rgba(6,182,212,.7),inset 0 1px 0 rgba(255,255,255,.4);transition:transform .18s cubic-bezier(.2,.8,.2,1)}
.u1a-fab:hover{transform:translateY(-2px) scale(1.04)}
.u1a-fab.on{transform:scale(.92)}
.u1a-fab-ping{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--cyan);opacity:0;animation:u1a-ping 3.4s cubic-bezier(.2,.55,.35,1) infinite;pointer-events:none}
@keyframes u1a-ping{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.7);opacity:0}}

.u1a-pop{position:fixed;right:22px;bottom:84px;z-index:300;width:390px;max-width:calc(100vw - 36px);height:540px;max-height:calc(100vh - 120px);display:flex;flex-direction:column;border-radius:var(--r);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(40px) saturate(1.8);-webkit-backdrop-filter:blur(40px) saturate(1.8);box-shadow:0 24px 70px -20px rgba(0,0,0,.5),inset 0 1px 0 var(--rim);overflow:hidden;animation:u1a-in .2s cubic-bezier(.2,.8,.2,1)}
@keyframes u1a-in{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:none}}
.u1a-head{flex:none;display:flex;align-items:center;gap:10px;padding:13px 14px;border-bottom:1px solid var(--line)}
.u1a-orb{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:linear-gradient(160deg,#22d3ee,#06b6d4);box-shadow:0 5px 14px -6px rgba(6,182,212,.7)}
.u1a-head-tx{flex:1;display:flex;flex-direction:column;line-height:1.15}
.u1a-head-tx b{font-size:14px;font-weight:680}
.u1a-ctx{font-size:11px;color:var(--cyan-d,#0891b2)}
.u1a-prov{flex:none;display:flex;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.u1a-prov-b{font:inherit;font-size:10.5px;font-weight:650;padding:4px 9px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;white-space:nowrap;transition:.14s}
.u1a-prov-b:hover{color:var(--ink)}
.u1a-prov-b.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 3px 9px -4px rgba(6,182,212,.7)}
.u1a-x{width:28px;height:28px;border-radius:8px;border:none;background:none;cursor:pointer;color:var(--ink3);display:grid;place-items:center}
.u1a-x:hover{background:var(--fill-weak);color:var(--ink)}
.u1a-x svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}

.u1a-body{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}
.u1a-empty{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;padding:10px}
.u1a-empty-orb{width:54px;height:54px;border-radius:16px;display:grid;place-items:center;background:rgba(6,182,212,.1);box-shadow:inset 0 1px 0 var(--rim)}
.u1a-empty p{font-size:13px;color:var(--ink2);line-height:1.5;max-width:30ch}
.u1a-sugg{display:flex;flex-direction:column;gap:7px;width:100%;margin-top:4px}
.u1a-sugg-b{font:inherit;font-size:12.5px;font-weight:550;text-align:left;padding:9px 12px;border-radius:11px;border:1px solid var(--line);background:var(--glass2);color:var(--ink);cursor:pointer;transition:.15s}
.u1a-sugg-b:hover{border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.06);color:var(--cyan-d,#0891b2)}

.u1a-msg{display:flex;gap:8px;align-items:flex-start}
.u1a-msg.user{justify-content:flex-end}
.u1a-msg-orb{flex:none;width:24px;height:24px;border-radius:7px;display:grid;place-items:center;background:linear-gradient(160deg,#22d3ee,#06b6d4);margin-top:1px}
.u1a-bub{font-size:13.5px;line-height:1.55;padding:9px 13px;border-radius:14px;max-width:80%;white-space:pre-wrap;word-break:break-word}
.u1a-msg.user .u1a-bub{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:5px}
.u1a-msg.u1 .u1a-bub{background:var(--glass2);border:1px solid var(--line);color:var(--ink);border-bottom-left-radius:5px}
.u1a-typing{display:inline-flex;gap:4px;padding:2px 0}
.u1a-typing i{width:6px;height:6px;border-radius:50%;background:var(--ink3);animation:u1a-bounce 1.2s ease-in-out infinite}
.u1a-typing i:nth-child(2){animation-delay:.15s}.u1a-typing i:nth-child(3){animation-delay:.3s}
@keyframes u1a-bounce{0%,80%,100%{transform:translateY(0);opacity:.4}40%{transform:translateY(-4px);opacity:1}}
.u1a-err{font-size:12px;color:#dc2626;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:9px 11px;line-height:1.4}

.u1a-ctxbar{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px 0}
.u1a-add-wrap{position:relative;flex:none}
.u1a-add{width:24px;height:24px;border-radius:8px;border:1px dashed var(--line2,var(--line));background:var(--glass2);color:var(--ink2);font-size:16px;line-height:1;cursor:pointer;display:grid;place-items:center;padding:0}
.u1a-add:hover{color:var(--cyan-d,#0891b2);border-color:rgba(6,182,212,.5)}
.u1a-attach{position:absolute;left:0;bottom:calc(100% + 6px);z-index:40;width:250px;max-height:300px;overflow-y:auto;padding:6px;border-radius:var(--r-sm);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.u1a-attach-sec{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:8px 8px 5px}
.u1a-attach-empty{font-size:11.5px;color:var(--ink3);padding:3px 8px}
.u1a-attach-i{display:flex;align-items:center;gap:7px;width:100%;text-align:left;padding:7px 8px;border:none;background:none;border-radius:8px;cursor:pointer;font:inherit;font-size:12px;color:var(--ink)}
.u1a-attach-i:hover{background:var(--fill-weak)}
.u1a-attach-t{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.u1a-attach-proj{flex:none;font-size:9.5px;color:var(--ink3)}
.u1a-attach-git{margin-left:auto;font-size:9px;font-weight:700;text-transform:uppercase;color:var(--cyan-d,#0891b2)}
.u1a-attach-d{flex:none;width:7px;height:7px;border-radius:2px}
.u1a-attach-d.project{background:var(--cyan,#22d3ee);border-radius:2px}
.u1a-attach-d.session{background:#818cf8;border-radius:50%}
.u1a-chip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:600;padding:3px 5px 3px 8px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);max-width:160px}
.u1a-chip.page{padding:3px 9px;color:var(--cyan-d,#0891b2);border-color:rgba(6,182,212,.28);background:rgba(6,182,212,.07)}
.u1a-chip-d{flex:none;width:6px;height:6px}
.u1a-chip-d.project{background:var(--cyan,#22d3ee);border-radius:2px}
.u1a-chip-d.session{background:#818cf8;border-radius:50%}
.u1a-chip-x{border:none;background:none;color:var(--ink3);cursor:pointer;font-size:14px;line-height:1;padding:0 1px;border-radius:4px}
.u1a-chip-x:hover{color:var(--ink);background:var(--fill-weak)}
.u1a-input{flex:none;display:flex;align-items:flex-end;gap:8px;padding:11px 12px;border-top:1px solid var(--line)}
.u1a-ta{flex:1;resize:none;max-height:120px;border:1px solid var(--line);background:var(--fill-weak);border-radius:13px;padding:10px 12px;font:inherit;font-size:13.5px;color:var(--ink);outline:none;line-height:1.4}
.u1a-ta:focus{border-color:rgba(6,182,212,.45)}
.u1a-send{flex:none;width:38px;height:38px;border-radius:11px;border:none;cursor:pointer;display:grid;place-items:center;background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 6px 16px -6px rgba(6,182,212,.7);transition:.15s}
.u1a-send:disabled{opacity:.45;cursor:default;box-shadow:none}
.u1a-send svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.u1a-spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:u1a-rot .7s linear infinite}
@keyframes u1a-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.u1a-fab-ping,.u1a-typing i,.u1a-spin{animation:none}}
`}</style>
  );
}

export default U1Assistant;
