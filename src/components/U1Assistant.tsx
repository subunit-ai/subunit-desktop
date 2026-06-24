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
import { getToken } from "../lib/auth";
import { SubunitMark } from "./SubunitMark";

const CHAT = "https://chat.subunit.ai";
const THREAD_KEY = "subunit.u1.thread";

interface Msg {
  role: "user" | "u1";
  text: string;
}

/** Stream a u1-chat message: POST → SSE (event: delta {text} | done | error). */
async function streamU1(
  threadId: string,
  content: string,
  token: string,
  onDelta: (t: string) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(`${CHAT}/api/threads/${threadId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`u1 ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const rec = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of rec.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      const payload = data.join("\n");
      if (event === "delta") {
        try {
          onDelta((JSON.parse(payload) as { text?: string }).text ?? "");
        } catch {
          /* ignore malformed chunk */
        }
      } else if (event === "done") {
        return;
      } else if (event === "error") {
        let m = "Die Antwort konnte nicht erzeugt werden.";
        try {
          m = (JSON.parse(payload) as { message?: string }).message ?? m;
        } catch {
          /* keep default */
        }
        throw new Error(m);
      }
    }
  }
}

export function U1Assistant({ pageName }: { pageName: string }) {
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const threadRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const acRef = useRef<AbortController | null>(null);

  // Restore the persistent thread id.
  useEffect(() => {
    try {
      threadRef.current = localStorage.getItem(THREAD_KEY);
    } catch {
      /* storage unavailable */
    }
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

  // Tear down any in-flight stream on unmount.
  useEffect(() => () => acRef.current?.abort(), []);

  const ensureThread = useCallback(async (token: string): Promise<string> => {
    if (threadRef.current) return threadRef.current;
    const res = await fetch(`${CHAT}/api/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`u1 ${res.status}`);
    const data = (await res.json()) as { thread?: { id?: string }; id?: string };
    const id = data.thread?.id ?? data.id;
    if (!id) throw new Error("kein Thread");
    threadRef.current = id;
    try {
      localStorage.setItem(THREAD_KEY, id);
    } catch {
      /* ignore */
    }
    return id;
  }, []);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;
      setErr(null);
      setInput("");
      setMsgs((m) => [...m, { role: "user", text }, { role: "u1", text: "" }]);
      setBusy(true);
      const ac = new AbortController();
      acRef.current = ac;
      try {
        const token = await getToken();
        if (!token) throw new Error("Nicht angemeldet — melde dich oben rechts an, um U1 zu fragen.");
        const threadId = await ensureThread(token);
        // Pass the current page as context so U1 answers about where you are.
        const content = `[Kontext: Der Nutzer ist in der Subunit-Desktop-App, aktuell auf der Seite „${pageName}".]\n\n${text}`;
        await streamU1(
          threadId,
          content,
          token,
          (delta) =>
            setMsgs((m) => {
              const next = m.slice();
              const last = next[next.length - 1];
              if (last && last.role === "u1") next[next.length - 1] = { role: "u1", text: last.text + delta };
              return next;
            }),
          ac.signal
        );
      } catch (e) {
        if (ac.signal.aborted) return;
        const m = e instanceof Error ? e.message : String(e);
        setErr(m);
        // Drop the empty u1 bubble on failure.
        setMsgs((cur) => {
          const n = cur.slice();
          if (n.length && n[n.length - 1].role === "u1" && !n[n.length - 1].text) n.pop();
          return n;
        });
      } finally {
        setBusy(false);
        acRef.current = null;
      }
    },
    [busy, ensureThread, pageName]
  );

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
