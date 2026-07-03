/**
 * Team — the team-chat surface (Telegram-style), wired to the REAL u1-chat backend.
 *
 * ⚠️ ABSORBED by the Chat plugin (Subunit Messenger, 2026-07-02): the unified
 * chat rail now carries team convos WITH the full parity set (media, reactions,
 * reply, edit/delete, read receipts, typing, pins, group management). This
 * surface stays registered but `nav.section: "hidden"` keeps it out of the dock
 * (still reachable via ⌘K "Team" as a fallback).
 *
 * Chat with the workspace: DMs + group conversations over chat.subunit.ai
 * (`/api/team/*`), the SAME backend as subunit-ios. A left rail lists conversations
 * (with presence + unread), the right column is the live conversation with a glass
 * composer. Incoming messages, typing and read-receipts arrive over an SSE stream
 * (`/api/team/convos/:id/stream`); leaving a conversation aborts the stream so the
 * server frees the per-user slot.
 *
 * This is the human↔human lane — complementary to the KI-chat (Chat plugin, u1)
 * and the local U1 orb.
 *
 * Permissions: backend:u1-chat, storage (last-active), notifications.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";
import {
  createConvo,
  getConvo,
  getMe,
  isOnline,
  listConvos,
  listTeamUsers,
  sendTeamMessage,
  setPresence,
  streamConvo,
  type TeamConvoDTO,
  type TeamMessageDTO,
  type TeamUserDTO,
} from "../../lib/u1chat";

const ICON = `<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

const Svg = (props: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
    {props.d.split("|").map((p, i) => (
      <path key={i} d={/^\s*[Mm]/.test(p) ? p : `M${p}`} />
    ))}
  </svg>
);

const ICONS = {
  send: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  plus: "M12 5v14M5 12h14",
  group: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2|9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0|23 21v-2a4 4 0 0 0-3-3.87|16 3.13a4 4 0 0 1 0 7.75",
};

const STORE_ACTIVE = "activeConvo";

function relTime(ts?: number): string {
  if (!ts) return "";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "jetzt";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

function nameOf(email: string, name?: string): string {
  if (name && name.trim()) return name;
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  return local
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ") || email;
}

function initialOf(label: string): string {
  return (label.trim().charAt(0) || "?").toUpperCase();
}

/** A convo's display label + secondary line. */
function convoLabel(c: TeamConvoDTO): { title: string; isDM: boolean } {
  if (c.kind === "dm") return { title: c.other_name || nameOf(c.other || "", undefined), isDM: true };
  return { title: c.title || "Gruppe", isDM: false };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function TeamView({ host }: { host: HostApi }) {
  const [convos, setConvos] = useState<TeamConvoDTO[]>([]);
  const [users, setUsers] = useState<TeamUserDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [myEmail, setMyEmail] = useState("");
  const [pickOpen, setPickOpen] = useState(false);
  const [typingWho, setTypingWho] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);

  const refreshConvos = useCallback(async () => {
    const list = await listConvos(host);
    setConvos(list);
    return list;
  }, [host]);

  // ── bootstrap: identity, presence, convos, users ──
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const me = await getMe(host);
        if (alive) setMyEmail(me.email);
        // Mark ourselves present (also refreshes last_seen).
        const display = (me.email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
        void setPresence(host, nameOf(me.email, display)).catch(() => {});
        const [list] = await Promise.all([
          refreshConvos(),
          listTeamUsers(host)
            .then((u) => alive && setUsers(u))
            .catch(() => {}),
        ]);
        if (!alive) return;
        const saved = (await host.storage.get(STORE_ACTIVE)) as string | undefined;
        setActiveId((saved && list.find((c) => c.id === saved)?.id) || list[0]?.id || null);
      } catch (e) {
        if (alive) setError(authHint(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, refreshConvos]);

  // ── poll convo list (unread / last message across convos) ──
  useEffect(() => {
    const iv = window.setInterval(() => void refreshConvos().catch(() => {}), 15000);
    return () => window.clearInterval(iv);
  }, [refreshConvos]);

  // ── active convo: load history + live SSE stream (message|typing|read) ──
  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    void host.storage.set(STORE_ACTIVE, activeId);
    setTypingWho(null);
    const ac = new AbortController();
    let stopped = false;

    const addMessage = (msg: TeamMessageDTO) =>
      setMessages((prev) =>
        prev.some((m) => m.id === msg.id)
          ? prev.map((m) => (m.id === msg.id ? msg : m))
          : [...prev, msg].sort((a, b) => a.id - b.id)
      );

    void (async () => {
      let since = 0;
      try {
        const { messages: msgs } = await getConvo(host, activeId);
        if (stopped) return;
        setMessages(msgs);
        since = msgs.length ? msgs[msgs.length - 1].id : 0;
      } catch (e) {
        if (!stopped) setError(authHint(e));
      }
      // Live loop with reconnect (the loop ends when the convo switches/unmounts).
      while (!stopped && !ac.signal.aborted) {
        try {
          for await (const evt of streamConvo(host, activeId, since, ac.signal)) {
            if (evt.event === "message") {
              const msg = evt.data as TeamMessageDTO;
              since = Math.max(since, msg.id);
              addMessage(msg);
              // The message arrived → they're no longer typing; clear the ghost.
              if (msg.sender !== myEmail) {
                if (typingTimer.current) window.clearTimeout(typingTimer.current);
                setTypingWho(null);
              }
            } else if (evt.event === "typing") {
              const who = (evt.data as { email?: string })?.email;
              if (who && who !== myEmail) {
                setTypingWho(who);
                if (typingTimer.current) window.clearTimeout(typingTimer.current);
                typingTimer.current = window.setTimeout(() => setTypingWho(null), 3500);
              }
            }
            // "read" events are accepted (receipts) — not surfaced in this v1.
          }
        } catch {
          /* network blip → reconnect below unless aborted */
        }
        if (stopped || ac.signal.aborted) break;
        await sleep(1500);
      }
    })();

    return () => {
      stopped = true;
      ac.abort();
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
  }, [host, activeId, myEmail]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, typingWho]);

  const active = convos.find((c) => c.id === activeId) ?? null;

  const startDM = useCallback(
    async (email: string) => {
      setPickOpen(false);
      setError(null);
      try {
        const convo = await createConvo(host, { email });
        setConvos((prev) => (prev.some((c) => c.id === convo.id) ? prev : [convo, ...prev]));
        setActiveId(convo.id);
      } catch (e) {
        setError(authHint(e));
      }
    },
    [host]
  );

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !activeId || sending) return;
    setError(null);
    setDraft("");
    setSending(true);
    try {
      const msg = await sendTeamMessage(host, activeId, text);
      // Append immediately; the SSE echo (if any) dedups by id.
      setMessages((prev) =>
        prev.some((m) => m.id === msg.id) ? prev : [...prev, msg].sort((a, b) => a.id - b.id)
      );
      void refreshConvos().catch(() => {});
    } catch (e) {
      setError(authHint(e));
      setDraft(text); // restore on failure
    } finally {
      setSending(false);
    }
  }, [activeId, draft, host, refreshConvos, sending]);

  const sorted = [...convos].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0));
  const dmUsers = users.filter((u) => u.email !== myEmail);

  return (
    <div className="tm">
      <TeamStyle />

      {/* ── conversation rail ── */}
      <aside className="tm-rail">
        <div className="tm-rail-head">
          <div className="sect" style={{ margin: 0 }}>
            Team
          </div>
          <div className="tm-new-wrap">
            <button className="iconbtn tm-new" title="Neue Direktnachricht" onClick={() => setPickOpen((o) => !o)}>
              <span className="ic">
                <Svg d={ICONS.plus} />
              </span>
            </button>
            {pickOpen && (
              <div className="tm-pick" onMouseLeave={() => setPickOpen(false)}>
                <div className="tm-pick-h">Direktnachricht starten</div>
                {dmUsers.length === 0 ? (
                  <div className="tm-pick-empty">Keine weiteren Team-Mitglieder.</div>
                ) : (
                  dmUsers.map((u) => {
                    const label = nameOf(u.email, u.name);
                    return (
                      <button key={u.email} className="tm-pick-i" onClick={() => void startDM(u.email)}>
                        <span className="tm-av sm">
                          {initialOf(label)}
                          {isOnline(u.last_seen) && <span className="tm-presence" />}
                        </span>
                        <span className="tm-pick-n">{label}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>

        {loading ? (
          <div className="tm-rail-empty">
            <span className="spinner" />
          </div>
        ) : sorted.length === 0 ? (
          <div className="tm-rail-empty">
            <span>Noch keine Unterhaltungen.</span>
            <span className="tm-hint">Starte oben eine Direktnachricht mit „＋".</span>
          </div>
        ) : (
          <div className="tm-convos">
            {sorted.map((c) => {
              const { title, isDM } = convoLabel(c);
              const online = isDM && isOnline(c.other_seen);
              return (
                <button
                  key={c.id}
                  className={`tm-convo${c.id === activeId ? " is-active" : ""}`}
                  onClick={() => setActiveId(c.id)}
                >
                  <span className={`tm-av${isDM ? "" : " grp"}`}>
                    {isDM ? initialOf(title) : <Svg d={ICONS.group} />}
                    {online && <span className="tm-presence" />}
                  </span>
                  <span className="tm-convo-tx">
                    <span className="tm-convo-top">
                      <span className="tm-convo-title">{title}</span>
                      <span className="tm-convo-time">{relTime(c.updated_at)}</span>
                    </span>
                    <span className="tm-convo-prev">
                      {c.last_sender ? `${c.last_sender === myEmail ? "Du" : nameOf(c.last_sender)}: ` : ""}
                      {c.last_text || "Noch keine Nachrichten"}
                    </span>
                  </span>
                  {!!c.unread && c.unread > 0 && <span className="tm-unread">{c.unread}</span>}
                </button>
              );
            })}
          </div>
        )}
      </aside>

      {/* ── conversation ── */}
      <section className="tm-conv">
        {!active ? (
          <div className="tm-conv-blank">
            <span className="tm-blank-ic">
              <Svg d={ICONS.group} />
            </span>
            <b>Mit dem Team chatten</b>
            <span className="hint center">Wähle links eine Unterhaltung oder starte mit „＋" eine neue.</span>
          </div>
        ) : (
          <>
            <div className="tm-conv-head">
              {(() => {
                const { title, isDM } = convoLabel(active);
                const online = isDM && isOnline(active.other_seen);
                return (
                  <>
                    <span className={`tm-av${isDM ? "" : " grp"}`}>
                      {isDM ? initialOf(title) : <Svg d={ICONS.group} />}
                      {online && <span className="tm-presence" />}
                    </span>
                    <div className="tm-conv-id">
                      <div className="tm-conv-title">{title}</div>
                      <div className="tm-conv-sub">
                        {isDM
                          ? online
                            ? "online"
                            : active.other_seen
                              ? `zuletzt ${relTime(active.other_seen)}`
                              : "Direktnachricht"
                          : `${active.members?.length ?? 0} Mitglieder`}
                      </div>
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="tm-body" ref={bodyRef}>
              {messages.length === 0 ? (
                <div className="tm-empty">Noch keine Nachrichten — schreib die erste.</div>
              ) : (
                messages.map((m) => {
                  const mine = m.sender === myEmail;
                  return (
                    <div key={m.id} className={`tm-msg ${mine ? "me" : "them"}`}>
                      {!mine && active.kind === "group" && (
                        <span className="tm-msg-sender">{nameOf(m.sender)}</span>
                      )}
                      <div className="tm-bubble">{m.deleted ? <i className="tm-deleted">Nachricht gelöscht</i> : m.body}</div>
                    </div>
                  );
                })
              )}
              {typingWho && (
                <div className="tm-msg them">
                  <div className="tm-bubble tm-typing">
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              )}
              {error && <div className="tm-err">{error}</div>}
            </div>

            <div className="tm-composer">
              <textarea
                className="fld tm-input"
                placeholder={`Nachricht an ${convoLabel(active).title}…`}
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
                className="btn btn-primary minibtn tm-send"
                disabled={!draft.trim() || sending}
                onClick={() => void send()}
                title="Senden (Enter)"
              >
                {sending ? <span className="tm-spin" /> : <Svg d={ICONS.send} />}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function authHint(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/401|unauthorized/i.test(msg))
    return "Nicht angemeldet — melde dich oben rechts an, dann lädt der Team-Chat.";
  return msg || "Etwas ist schiefgelaufen.";
}

function TeamStyle() {
  return (
    <style>{`
.tm{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px;height:100%;padding:16px 18px 16px;max-width:1200px;margin:0 auto;width:100%}
@media(max-width:820px){.tm{grid-template-columns:1fr}.tm-rail{display:none}}

/* ── avatars + presence ── */
.tm-av{position:relative;flex:none;width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-size:15px;font-weight:650;color:#fff;background:linear-gradient(160deg,#22d3ee,#06b6d4);box-shadow:inset 0 1px 0 rgba(255,255,255,.3)}
.tm-av.grp{background:linear-gradient(160deg,#818cf8,#6366f1)}
.tm-av.grp svg{width:20px;height:20px;stroke:#fff}
.tm-av.sm{width:30px;height:30px;font-size:12px}
.tm-presence{position:absolute;right:-1px;bottom:-1px;width:11px;height:11px;border-radius:50%;background:#34d399;border:2px solid var(--bg,#fff)}
html.dark .tm-presence{border-color:#0b1220}

/* ── rail ── */
.tm-rail{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:16px 14px;display:flex;flex-direction:column;min-height:0}
.tm-rail-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.tm-new-wrap{position:relative}
.tm-new{width:auto}
.tm-new .ic{width:32px;height:32px;border-radius:10px}
.tm-new .ic svg{width:16px;height:16px}
.tm-pick{position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:248px;max-height:340px;overflow-y:auto;padding:6px;border-radius:var(--r-sm);border:1px solid var(--glass-edge2,var(--glass-edge));background:var(--menu-bg,var(--glass));backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.tm-pick-h{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:7px 9px 6px}
.tm-pick-empty{font-size:12px;color:var(--ink3);padding:8px 9px;line-height:1.5}
.tm-pick-i{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 8px;border:none;background:none;border-radius:9px;cursor:pointer;font:inherit;font-size:13px;color:var(--ink)}
.tm-pick-i:hover{background:var(--fill-weak)}
.tm-pick-n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-rail-empty{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--ink3);font-size:13px;text-align:center;padding:30px 8px;line-height:1.5}
.tm-hint{font-size:11.5px;color:var(--ink3)}
.tm-convos{display:flex;flex-direction:column;gap:4px;overflow-y:auto;min-height:0;flex:1}
.tm-convo{display:flex;align-items:center;gap:11px;text-align:left;width:100%;border:1px solid transparent;border-radius:var(--r-xs);background:transparent;padding:10px 10px;cursor:pointer;font-family:inherit;color:inherit;transition:background .16s,border-color .16s}
.tm-convo:hover{background:var(--glass2)}
.tm-convo.is-active{background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.28);box-shadow:inset 0 1px 0 var(--rim)}
.tm-convo-tx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.tm-convo-top{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.tm-convo-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
.tm-convo.is-active .tm-convo-title{color:var(--cyan-d)}
.tm-convo-time{font-size:10.5px;color:var(--ink3);flex:none}
.tm-convo-prev{font-size:12px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-unread{flex:none;min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;font-size:10.5px;font-weight:700;display:grid;place-items:center}

/* ── conversation ── */
.tm-conv{display:flex;flex-direction:column;min-height:0;background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden}
.tm-conv-blank{margin:auto;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px;max-width:36ch;padding:30px}
.tm-blank-ic{width:58px;height:58px;border-radius:18px;display:grid;place-items:center;background:rgba(99,102,241,.1);color:#6366f1}
.tm-blank-ic svg{width:28px;height:28px}
.tm-conv-blank b{font-size:18px;font-weight:600;letter-spacing:-.02em;color:var(--ink)}
.tm-conv-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--line)}
.tm-conv-id{min-width:0}
.tm-conv-title{font-size:15.5px;font-weight:600;letter-spacing:-.015em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-conv-sub{font-size:12px;color:var(--ink2);margin-top:1px}

.tm-body{flex:1;overflow-y:auto;min-height:0;padding:20px 20px 8px;display:flex;flex-direction:column;gap:8px}
.tm-empty{margin:auto;color:var(--ink3);font-size:13px;padding:30px}
.tm-msg{display:flex;flex-direction:column;gap:3px;max-width:74%}
.tm-msg.me{align-self:flex-end;align-items:flex-end}
.tm-msg.them{align-self:flex-start;align-items:flex-start}
.tm-msg-sender{font-size:10.5px;font-weight:700;color:var(--cyan-d,#0891b2);padding:0 4px}
.tm-bubble{font-size:14.5px;line-height:1.5;padding:10px 14px;border-radius:16px;white-space:pre-wrap;word-break:break-word;box-shadow:var(--shadow-sm)}
.tm-msg.them .tm-bubble{background:var(--fill-strong);border:1px solid var(--line);color:var(--prose);border-bottom-left-radius:5px}
.tm-msg.me .tm-bubble{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;border-bottom-right-radius:5px}
.tm-deleted{opacity:.6}
.tm-typing{display:flex;align-items:center;gap:5px}
.tm-typing i{width:7px;height:7px;border-radius:50%;background:var(--ink3);animation:tm-bounce 1.2s infinite ease-in-out}
.tm-typing i:nth-child(2){animation-delay:.18s}
.tm-typing i:nth-child(3){animation-delay:.36s}
@keyframes tm-bounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}
.tm-err{align-self:center;font-size:12px;color:#dc2626;background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:9px 13px;line-height:1.4;text-align:center;max-width:48ch}

.tm-composer{display:flex;align-items:flex-end;gap:10px;padding:14px 16px 16px;border-top:1px solid var(--line)}
.tm-input{margin-top:0;min-height:48px;max-height:160px;resize:none;line-height:1.5;padding:13px 15px}
.tm-send{width:auto;flex:none;padding:13px 15px}
.tm-send svg{width:18px;height:18px}
.tm-spin{width:16px;height:16px;border-radius:50%;border:2px solid rgba(255,255,255,.4);border-top-color:#fff;animation:tm-rot .7s linear infinite;display:inline-block}
@keyframes tm-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.tm-typing i,.tm-spin{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "team",
    name: "Team",
    version: "1.0.0",
    description: "Team-Chat — DMs & Gruppen mit dem Workspace, wie Telegram.",
    icon: ICON,
    permissions: ["backend:u1-chat", "storage", "notifications"],
    nav: { section: "hidden", order: 1 },
    commands: [{ id: "open", title: "Go to Team" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<TeamView host={host} />);
    offCmd = host.events.on("command:team:open", () => host.nav.navigate("team"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
