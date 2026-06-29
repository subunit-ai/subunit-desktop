/**
 * Chat — the KI-chat surface (claude.ai-style), wired to the REAL u1-chat backend.
 *
 * A native Subunit Liquid Glass chat: a left thread rail and a right conversation
 * column with a glass composer. Threads + messages are PERSISTENT and live on
 * chat.subunit.ai (`/api/threads/*`) — the SAME backend as the subunit-ios app, so
 * a conversation started on the phone continues here and vice-versa. Each thread is
 * a Claude Code session resumed server-side (`claude -p --resume`); replies STREAM
 * over SSE (delta|meta|done|error|ratelimit).
 *
 * This is the cloud lane. The ubiquitous U1 orb (⌘J, lib/components/U1Assistant)
 * stays the LOCAL lane (claude -p / ollama with file + terminal access) — the two
 * are complementary.
 *
 * It also LISTENS for the cockpit's `chat:seed` event: navigating here from a task
 * pre-fills the composer (and opens a fresh thread if none is active).
 *
 * Permissions: backend:u1-chat (threads API), storage (last-active + model),
 * notifications.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";
import {
  createThread,
  getThread,
  listThreads,
  streamThreadMessage,
  type MessageDTO,
  type ThreadDTO,
} from "../../lib/u1chat";

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

const ORB = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z";
const ICONS = {
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  plus: "M12 5v14M5 12h14",
};

const STORE_ACTIVE = "activeThread";
const STORE_MODEL = "model";
const MODELS: { id: string; label: string }[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
];

/** A message in the local view: server MessageDTO + a transient streaming flag. */
interface ViewMsg extends MessageDTO {
  streaming?: boolean;
}

function relTime(ts?: number): string {
  if (!ts) return "";
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
  const [threads, setThreads] = useState<ThreadDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ViewMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [loadingThreads, setLoadingThreads] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState<string>("opus");
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  // Latest active thread id, addressable from async loops without re-subscribing.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  // ── load thread list + restore the last active one ──
  const refreshThreads = useCallback(async () => {
    const list = await listThreads(host);
    setThreads(list);
    return list;
  }, [host]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const savedModel = (await host.storage.get(STORE_MODEL)) as string | undefined;
        if (savedModel && alive) setModel(savedModel);
        const saved = (await host.storage.get(STORE_ACTIVE)) as string | undefined;
        const list = await listThreads(host);
        if (!alive) return;
        // Merge: keep any locally-created thread (e.g. a seed that landed
        // mid-bootstrap) the server list doesn't have yet — don't clobber it.
        setThreads((prev) => {
          const ids = new Set(list.map((t) => t.id));
          const extra = prev.filter((t) => !ids.has(t.id));
          return [...extra, ...list];
        });
        // Only pick a landing thread if a seed hasn't already set one.
        if (!activeIdRef.current) {
          setActiveId((saved && list.find((t) => t.id === saved)?.id) || list[0]?.id || null);
        }
      } catch (e) {
        if (alive) setError(authHint(e));
      } finally {
        if (alive) setLoadingThreads(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [host]);

  // ── load the active thread's messages ──
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    let alive = true;
    void host.storage.set(STORE_ACTIVE, activeId);
    void (async () => {
      try {
        const { messages: msgs } = await getThread(host, activeId);
        if (alive) setMessages(msgs);
      } catch (e) {
        if (alive) setError(authHint(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, activeId]);

  // Abort any in-flight stream on unmount + mark unmounted so the fire-and-forget
  // send() loop doesn't setState on a torn-down component.
  useEffect(
    () => () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    },
    []
  );

  // ── react to the cockpit's "chat mit u1" seed ──
  useEffect(() => {
    return host.events.on("chat:seed", (data) => {
      const p = (data ?? {}) as SeedPayload;
      const title = p.title || "Aufgabe";
      setDraft(`Lass uns an dieser Aufgabe arbeiten: „${title}". `);
      // Ensure there's a thread to drop into; create one if the rail is empty.
      if (!activeIdRef.current) {
        void createThread(host, model)
          .then((t) => {
            setThreads((prev) => [t, ...prev]);
            setActiveId(t.id);
          })
          .catch((e) => setError(authHint(e)));
      }
    });
  }, [host, model]);

  const active = threads.find((t) => t.id === activeId) ?? null;

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const pickModel = useCallback(
    (m: string) => {
      setModel(m);
      void host.storage.set(STORE_MODEL, m);
    },
    [host]
  );

  const newThread = useCallback(async () => {
    setError(null);
    try {
      const t = await createThread(host, model);
      setThreads((prev) => [t, ...prev]);
      setActiveId(t.id);
      setMessages([]);
      setDraft("");
    } catch (e) {
      setError(authHint(e));
    }
  }, [host, model]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setError(null);

    // Resolve a target thread (create one if needed).
    let threadId = activeId;
    if (!threadId) {
      try {
        const t = await createThread(host, model);
        threadId = t.id;
        setThreads((prev) => [t, ...prev]);
        setActiveId(t.id);
      } catch (e) {
        setError(authHint(e));
        return;
      }
    }

    setDraft("");
    setSending(true);
    // Optimistic: append the user turn + an empty streaming assistant turn.
    setMessages((m) => [
      ...m,
      { role: "user", content: text, created_at: Date.now() },
      { role: "assistant", content: "", streaming: true },
    ]);

    const appendDelta = (t: string) =>
      setMessages((m) => {
        const next = m.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant") {
          next[next.length - 1] = { ...last, content: last.content + t };
        }
        return next;
      });

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const evt of streamThreadMessage(
        host,
        threadId,
        { content: text, model, effort: "high" },
        ac.signal
      )) {
        if (evt.event === "delta") {
          appendDelta((evt.data as { text?: string })?.text ?? "");
        } else if (evt.event === "meta") {
          const meta = evt.data as { title?: string; color?: string; category?: string };
          if (meta.title) {
            setThreads((prev) =>
              prev.map((t) =>
                t.id === threadId ? { ...t, title: meta.title!, color: meta.color, category: meta.category } : t
              )
            );
          }
        } else if (evt.event === "ratelimit") {
          host.notifications.notify("Rate-Limit erreicht", "u1 wartet kurz — der Stream läuft weiter.");
        } else if (evt.event === "error") {
          const m = (evt.data as { message?: string })?.message || "Antwort fehlgeschlagen.";
          setError(m);
        } else if (evt.event === "done") {
          const cost = (evt.data as { cost?: number })?.cost;
          setMessages((m) => {
            const next = m.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") next[next.length - 1] = { ...last, streaming: false, cost };
            return next;
          });
        }
      }
    } catch (e) {
      // Aborted streams are not errors.
      if (mountedRef.current && !(e instanceof DOMException && e.name === "AbortError")) {
        setError(authHint(e));
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (mountedRef.current) {
        setSending(false);
        // Clear any lingering streaming flag + refresh rail (titles/order).
        setMessages((m) =>
          m.map((x) => (x.streaming ? { ...x, streaming: false } : x))
        );
        void refreshThreads().catch(() => {});
      }
    }
  }, [activeId, draft, host, model, refreshThreads, sending]);

  const sorted = [...threads].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));

  return (
    <div className="cht">
      <ChatStyle />

      {/* ── thread rail ── */}
      <aside className="cht-rail">
        <div className="cht-rail-head">
          <div className="sect" style={{ margin: 0 }}>
            Stränge
          </div>
          <button className="iconbtn cht-new" title="Neuer Strang" onClick={() => void newThread()}>
            <span className="ic">
              <Svg d={ICONS.plus} />
            </span>
          </button>
        </div>

        {loadingThreads ? (
          <div className="cht-rail-empty">
            <span className="spinner" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="cht-rail-empty">
            <span>Noch keine Unterhaltungen.</span>
            <button className="btn-ghost minibtn" onClick={() => void newThread()}>
              Strang starten
            </button>
          </div>
        ) : (
          <div className="cht-threads">
            {sorted.map((t) => (
              <button
                key={t.id}
                className={`cht-thread${t.id === activeId ? " is-active" : ""}`}
                onClick={() => setActiveId(t.id)}
              >
                <div className="cht-thread-top">
                  <span className="cht-thread-title">{t.title || "Unterhaltung"}</span>
                  <span className="cht-thread-time">{relTime(t.updated_at)}</span>
                </div>
                <div className="cht-thread-prev">
                  {t.category ? t.category : t.status === "closed" ? "Archiviert" : "u1 · KI-Chat"}
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* ── conversation ── */}
      <section className="cht-conv">
        <div className="cht-conv-head">
          <span className="cht-orb">
            <Svg d={ORB} />
          </span>
          <div className="cht-conv-tx">
            <div className="cht-conv-title">{active?.title ?? "u1"}</div>
            <div className="cht-conv-sub">Unit One · persistent &amp; synchron mit deinem iPhone</div>
          </div>
          <div className="cht-model" role="group" aria-label="Modell">
            {MODELS.map((m) => (
              <button
                key={m.id}
                className={`cht-model-b${model === m.id ? " on" : ""}`}
                onClick={() => pickModel(m.id)}
                title={`Neue Antworten mit ${m.label}`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="cht-body" ref={bodyRef}>
          {!active || messages.length === 0 ? (
            <div className="cht-welcome">
              <span className="cht-welcome-orb">
                <Svg d={ORB} />
              </span>
              <b>Was bauen wir?</b>
              <span className="hint center">
                Schreib u1 direkt — Aufgaben, Debugging, Strategie. Die Threads sind
                persistent und laufen auf deinem iPhone weiter. Aus dem Cockpit
                gestartete Aufgaben landen hier im Composer.
              </span>
            </div>
          ) : (
            messages.map((m, i) => {
              const who = m.role === "assistant" ? "u1" : "tj";
              return (
                <div key={m.id ?? `i${i}`} className={`cht-msg ${who}`}>
                  {who === "u1" && (
                    <span className="cht-msg-orb">
                      <Svg d={ORB} />
                    </span>
                  )}
                  <div className="cht-bubble">
                    {m.content ||
                      (m.streaming ? (
                        <span className="cht-typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        ""
                      ))}
                  </div>
                </div>
              );
            })
          )}
          {error && <div className="cht-err">{error}</div>}
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
                void send();
              }
            }}
          />
          <button
            className="btn btn-primary minibtn cht-send"
            disabled={!draft.trim() || sending}
            onClick={() => void send()}
            title="Senden (Enter)"
          >
            {sending ? <span className="cht-spin" /> : <Svg d={ICONS.send} />}
          </button>
        </div>
      </section>
    </div>
  );
}

/** Map a thrown backend error to a friendly hint (401 → sign in). */
function authHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized/i.test(msg))
    return "Nicht angemeldet — melde dich oben rechts an, dann lädt der KI-Chat.";
  return msg || "Etwas ist schiefgelaufen.";
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

/* ── conversation ── */
.cht-conv{display:flex;flex-direction:column;min-height:0;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.cht-conv-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.cht-orb,.cht-msg-orb,.cht-welcome-orb{display:grid;place-items:center;border-radius:50%;background:linear-gradient(160deg,rgba(6,182,212,.22),rgba(6,182,212,.06));color:var(--cyan-d);flex:none}
.cht-orb{width:40px;height:40px}
.cht-orb svg{width:21px;height:21px}
.cht-conv-tx{min-width:0;flex:1}
.cht-conv-title{font-size:15.5px;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cht-conv-sub{font-size:12px;color:var(--ink2);margin-top:1px}
.cht-model{flex:none;display:flex;gap:2px;padding:2px;border-radius:999px;background:var(--fill-weak);border:1px solid var(--line)}
.cht-model-b{font:inherit;font-size:10.5px;font-weight:650;padding:4px 10px;border-radius:999px;border:none;background:none;color:var(--ink3);cursor:pointer;transition:.14s}
.cht-model-b:hover{color:var(--ink)}
.cht-model-b.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 3px 9px -4px rgba(6,182,212,.7)}

.cht-body{flex:1;overflow-y:auto;min-height:0;padding:22px 22px 8px;display:flex;flex-direction:column;gap:14px}
.cht-welcome{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:42ch;padding:30px 0}
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

.cht-typing{display:flex;align-items:center;gap:5px;padding:3px}
.cht-typing i{width:7px;height:7px;border-radius:50%;background:var(--ink3);animation:cht-bounce 1.2s infinite ease-in-out}
.cht-typing i:nth-child(2){animation-delay:.18s}
.cht-typing i:nth-child(3){animation-delay:.36s}
@keyframes cht-bounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}
.cht-err{align-self:center;font-size:12px;color:#dc2626;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:9px 13px;line-height:1.4;text-align:center;max-width:48ch}

.cht-composer{display:flex;align-items:flex-end;gap:10px;padding:14px 16px 16px;border-top:1px solid var(--line)}
.cht-input{margin-top:0;min-height:48px;max-height:160px;resize:none;line-height:1.5;padding:13px 15px}
.cht-send{width:auto;flex:none;padding:13px 15px}
.cht-send svg{width:18px;height:18px}
.cht-spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:cht-rot .7s linear infinite;display:inline-block}
@keyframes cht-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.cht-typing i,.cht-spin{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "chat",
    name: "Chat",
    version: "1.1.0",
    description: "KI-Chat mit u1 — persistente Threads, synchron mit subunit-ios.",
    icon: ICON,
    permissions: ["backend:u1-chat", "storage", "notifications"],
    nav: { section: "comms", order: 0 },
    commands: [
      { id: "open", title: "Go to Chat" },
      { id: "new", title: "Chat: new thread" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<ChatView host={host} />);
    offCmd = host.events.on("command:chat:open", () => host.nav.navigate("chat"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
