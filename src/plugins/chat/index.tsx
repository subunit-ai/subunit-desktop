/**
 * Chat — u1 chat surface.
 *
 * A native Subunit Liquid Glass chat: a left thread .list (persisted via
 * host.storage) and a right conversation column with a glass composer. The real
 * backend is chat.subunit.ai / u1-chat (thread.id = CC session, resumed over the
 * subscription); this skeleton ships the full native chrome + local thread
 * state, with a single send() seam to wire to that backend. It also LISTENS for
 * the dashboard's `chat:seed` event: navigating here from a task pre-fills the
 * composer + opens a thread scoped to that task.
 *
 * Permissions: storage, notifications. (Backend wiring lands at the send() seam.)
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z"/></svg>`;

const Svg = (props: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

const ICONS = {
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  plus: "M12 5v14M5 12h14",
  task: "M9 11l3 3 8-8|21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
};

interface Msg {
  id: string;
  role: "u1" | "tj";
  text: string;
  ts: number;
}

interface Thread {
  id: string;
  title: string;
  taskId?: string;
  messages: Msg[];
  updated: number;
}

const STORE_KEY = "threads";

function uid(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function relTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "gerade eben";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

interface SeedPayload {
  taskId?: string;
  title?: string;
  status?: string;
  url?: string;
}

function ChatView({ host }: { host: HostApi }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [thinking, setThinking] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const persist = useCallback(
    (next: Thread[]) => {
      setThreads(next);
      void host.storage.set(STORE_KEY, next);
    },
    [host]
  );

  // Load persisted threads once.
  useEffect(() => {
    void (async () => {
      const stored = (await host.storage.get(STORE_KEY)) as Thread[] | undefined;
      const list = Array.isArray(stored) ? stored : [];
      setThreads(list);
      setActiveId(list[0]?.id ?? null);
      setLoaded(true);
    })();
  }, [host]);

  // React to the dashboard's "chat mit u1" seed.
  useEffect(() => {
    return host.events.on("chat:seed", (data) => {
      const p = (data ?? {}) as SeedPayload;
      const title = p.title || "Aufgabe";
      setThreads((prev) => {
        // Reuse an existing thread for this task if present.
        const existing = p.taskId
          ? prev.find((t) => t.taskId === p.taskId)
          : undefined;
        if (existing) {
          setActiveId(existing.id);
          return prev;
        }
        const thread: Thread = {
          id: uid(),
          title: title.slice(0, 60),
          taskId: p.taskId,
          messages: [],
          updated: Date.now(),
        };
        setActiveId(thread.id);
        const next = [thread, ...prev];
        void host.storage.set(STORE_KEY, next);
        return next;
      });
      setDraft(`Lass uns an dieser Aufgabe arbeiten: „${title}“. `);
    });
  }, [host]);

  const active = threads.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, thinking]);

  const newThread = useCallback(() => {
    const thread: Thread = {
      id: uid(),
      title: "Neue Unterhaltung",
      messages: [],
      updated: Date.now(),
    };
    persist([thread, ...threads]);
    setActiveId(thread.id);
    setDraft("");
  }, [persist, threads]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    let targetId = activeId;
    let base = threads;

    // Auto-create a thread if none is active.
    if (!targetId) {
      const thread: Thread = {
        id: uid(),
        title: text.slice(0, 48),
        messages: [],
        updated: Date.now(),
      };
      base = [thread, ...threads];
      targetId = thread.id;
      setActiveId(thread.id);
    }

    const userMsg: Msg = { id: uid(), role: "tj", text, ts: Date.now() };
    const withUser = base.map((t) =>
      t.id === targetId
        ? {
            ...t,
            title: t.messages.length === 0 ? text.slice(0, 48) : t.title,
            messages: [...t.messages, userMsg],
            updated: Date.now(),
          }
        : t
    );
    persist(withUser);
    setDraft("");
    setThinking(true);

    // ── send() seam ──────────────────────────────────────────────────────────
    // Wire to chat.subunit.ai / u1-chat here (thread.id = CC session, resumed via
    // `claude -p --resume` over the subscription). Until then we echo a native
    // placeholder so the chrome is fully exercised.
    window.setTimeout(() => {
      const reply: Msg = {
        id: uid(),
        role: "u1",
        text:
          "🫡 Verbunden mit der u1-Chat-Lane (chat.subunit.ai). Dieser Strang ist eine echte CC-Session — sobald die Bearer-Lane steht, antworte ich hier live. Nächster Schritt: sag mir, was wir bauen.",
        ts: Date.now(),
      };
      setThreads((prev) => {
        const next = prev.map((t) =>
          t.id === targetId
            ? { ...t, messages: [...t.messages, reply], updated: Date.now() }
            : t
        );
        void host.storage.set(STORE_KEY, next);
        return next;
      });
      setThinking(false);
    }, 650);
  }, [activeId, draft, host, persist, threads]);

  const sorted = [...threads].sort((a, b) => b.updated - a.updated);

  return (
    <div className="cht">
      <ChatStyle />

      {/* ── thread rail ── */}
      <aside className="cht-rail">
        <div className="cht-rail-head">
          <div className="sect" style={{ margin: 0 }}>
            Stränge
          </div>
          <button className="iconbtn cht-new" title="Neuer Strang" onClick={newThread}>
            <span className="ic">
              <Svg d={ICONS.plus} />
            </span>
          </button>
        </div>

        {!loaded ? (
          <div className="cht-rail-empty">
            <span className="spinner" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="cht-rail-empty">
            <span>Noch keine Unterhaltungen.</span>
            <button className="btn-ghost minibtn" onClick={newThread}>
              Strang starten
            </button>
          </div>
        ) : (
          <div className="cht-threads">
            {sorted.map((t) => {
              const last = t.messages[t.messages.length - 1];
              return (
                <button
                  key={t.id}
                  className={`cht-thread${t.id === activeId ? " is-active" : ""}`}
                  onClick={() => setActiveId(t.id)}
                >
                  <div className="cht-thread-top">
                    <span className="cht-thread-title">{t.title}</span>
                    <span className="cht-thread-time">{relTime(t.updated)}</span>
                  </div>
                  <div className="cht-thread-prev">
                    {t.taskId && (
                      <span className="cht-tasktag">
                        <Svg d={ICONS.task} />
                      </span>
                    )}
                    {last ? last.text : "Leer"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {/* ── conversation ── */}
      <section className="cht-conv">
        <div className="cht-conv-head">
          <span className="cht-orb">
            <Svg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
          </span>
          <div className="cht-conv-tx">
            <div className="cht-conv-title">{active?.title ?? "u1"}</div>
            <div className="cht-conv-sub">
              {active?.taskId ? "An eine Notion-Aufgabe gebunden" : "Unit One · dein Team-Mitglied"}
            </div>
          </div>
        </div>

        <div className="cht-body" ref={bodyRef}>
          {!active || active.messages.length === 0 ? (
            <div className="cht-welcome">
              <span className="cht-welcome-orb">
                <Svg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
              </span>
              <b>Was bauen wir?</b>
              <span className="hint center">
                Schreib u1 direkt — Aufgaben, Debugging, Strategie. Aus dem Ops
                Board gestartete Aufgaben landen hier als eigener Strang.
              </span>
            </div>
          ) : (
            active.messages.map((m) => (
              <div key={m.id} className={`cht-msg ${m.role}`}>
                {m.role === "u1" && (
                  <span className="cht-msg-orb">
                    <Svg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
                  </span>
                )}
                <div className="cht-bubble">{m.text}</div>
              </div>
            ))
          )}
          {thinking && (
            <div className="cht-msg u1">
              <span className="cht-msg-orb">
                <Svg d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z" />
              </span>
              <div className="cht-bubble cht-typing">
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>

        <div className="cht-composer">
          <textarea
            className="fld cht-input"
            placeholder="Nachricht an u1…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="btn btn-primary minibtn cht-send"
            disabled={!draft.trim()}
            onClick={send}
            title="Senden (Enter)"
          >
            <Svg d={ICONS.send} />
          </button>
        </div>
      </section>
    </div>
  );
}

function ChatStyle() {
  return (
    <style>{`
.cht{display:grid;grid-template-columns:264px minmax(0,1fr);gap:16px;height:100%;padding:16px 18px 16px;max-width:1200px;margin:0 auto;width:100%}
@media(max-width:820px){.cht{grid-template-columns:1fr}.cht-rail{display:none}}

/* ── rail ── */
.cht-rail{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:16px 14px;display:flex;flex-direction:column;min-height:0}
.cht-rail-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.cht-new{width:auto}
.cht-new .ic{width:32px;height:32px;border-radius:10px}
.cht-new .ic svg{width:16px;height:16px}
.cht-rail-empty{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--ink3);font-size:13px;text-align:center;padding:30px 8px;line-height:1.5}
.cht-threads{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;flex:1}
.cht-thread{text-align:left;width:100%;border:1px solid transparent;border-radius:var(--r-xs);background:transparent;padding:11px 12px;cursor:pointer;font-family:inherit;color:inherit;transition:background .16s,border-color .16s,transform .16s cubic-bezier(.2,.8,.2,1)}
.cht-thread:hover{background:var(--glass2)}
.cht-thread:active{transform:scale(.99)}
.cht-thread.is-active{background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.28);box-shadow:inset 0 1px 0 var(--rim)}
.cht-thread-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cht-thread-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.cht-thread.is-active .cht-thread-title{color:var(--cyan-d)}
.cht-thread-time{font-size:10.5px;color:var(--ink3);flex:none}
.cht-thread-prev{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--ink3);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cht-tasktag{display:inline-flex;width:13px;height:13px;flex:none;color:var(--cyan-d)}
.cht-tasktag svg{width:13px;height:13px}

/* ── conversation ── */
.cht-conv{display:flex;flex-direction:column;min-height:0;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.cht-conv-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.cht-orb,.cht-msg-orb,.cht-welcome-orb{display:grid;place-items:center;border-radius:50%;background:linear-gradient(160deg,rgba(6,182,212,.22),rgba(6,182,212,.06));color:var(--cyan-d);flex:none}
.cht-orb{width:40px;height:40px}
.cht-orb svg{width:21px;height:21px}
.cht-conv-tx{min-width:0}
.cht-conv-title{font-size:15.5px;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cht-conv-sub{font-size:12px;color:var(--ink2);margin-top:1px}

.cht-body{flex:1;overflow-y:auto;min-height:0;padding:22px 22px 8px;display:flex;flex-direction:column;gap:14px}
.cht-welcome{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:38ch;padding:30px 0}
.cht-welcome-orb{width:58px;height:58px}
.cht-welcome-orb svg{width:30px;height:30px}
.cht-welcome b{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}

.cht-msg{display:flex;align-items:flex-end;gap:9px;max-width:78%}
.cht-msg.tj{align-self:flex-end;flex-direction:row-reverse}
.cht-msg.u1{align-self:flex-start}
.cht-msg-orb{width:28px;height:28px}
.cht-msg-orb svg{width:15px;height:15px}
.cht-bubble{font-size:14.5px;line-height:1.55;padding:12px 15px;border-radius:18px;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-sm)}
.cht-msg.u1 .cht-bubble{background:var(--fill-strong);border:1px solid var(--line);color:var(--prose);border-bottom-left-radius:6px}
.cht-msg.tj .cht-bubble{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:6px;box-shadow:0 12px 26px -12px rgba(6,182,212,.5),inset 0 1px 0 var(--rim-cta)}

.cht-typing{display:flex;align-items:center;gap:5px;padding:15px}
.cht-typing i{width:7px;height:7px;border-radius:50%;background:var(--ink3);animation:cht-bounce 1.2s infinite ease-in-out}
.cht-typing i:nth-child(2){animation-delay:.18s}
.cht-typing i:nth-child(3){animation-delay:.36s}
@keyframes cht-bounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}

.cht-composer{display:flex;align-items:flex-end;gap:10px;padding:14px 16px 16px;border-top:1px solid var(--line)}
.cht-input{margin-top:0;min-height:48px;max-height:160px;resize:none;line-height:1.5;padding:13px 15px}
.cht-send{width:auto;flex:none;padding:13px 15px}
.cht-send svg{width:18px;height:18px}
@media (prefers-reduced-motion:reduce){.cht-typing i{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "chat",
    name: "Chat",
    version: "1.0.0",
    description: "Talk to u1 — threaded, task-aware conversations.",
    icon: ICON,
    permissions: ["storage", "notifications"],
    nav: { section: "comms", order: 0 },
    commands: [
      { id: "open", title: "Go to Chat" },
      { id: "new", title: "Chat: new thread" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<ChatView host={host} />);
    offCmd = host.events.on("command:chat:open", () =>
      host.nav.navigate("chat")
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
