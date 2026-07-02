/**
 * chat/lanes.tsx — the three conversation lanes of the messenger, sharing the
 * Bubble/Composer layer from convo.tsx:
 *
 *   · BotConvoView  — a persistent bot ROOM (`/api/bots/*`). Shared semantics:
 *                     every ACL member sees every message; the bot replies via
 *                     the server-side tmux bridge and lands on the SSE stream.
 *   · TeamConvoView — human↔human DM/group (`/api/team/*`) with the full
 *                     Telegram-parity set: media, reactions, reply, edit/delete,
 *                     read receipts, typing, pins, group management.
 *   · KiThreadView  — the claude.ai-style KI thread lane (`/api/threads/*`,
 *                     op-only), SSE-streamed replies, synced with subunit-ios.
 *
 * Each lane owns its message state + SSE loop; the index owns the rail, the
 * roster polling and notification routing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostApi } from "../../plugin/types";
import {
  addConvoMember,
  closeThread,
  deleteTeamMessage,
  deleteThreadMessage,
  editTeamMessage,
  editThreadMessage,
  getBot,
  getConvo,
  getThread,
  leaveConvo,
  markRead,
  pinMessage,
  reactBotMessage,
  reactTeamMessage,
  reactThreadMessage,
  renameConvo,
  sendBotMessage,
  sendTeamMessage,
  sendTyping,
  streamBot,
  streamConvo,
  streamThreadMessage,
  isOnline,
  type BotDTO,
  type BotMessageDTO,
  type MessageDTO,
  type ReactionDTO,
  type SendAttachment,
  type TeamConvoDTO,
  type TeamMessageDTO,
  type TeamUserDTO,
  type ThreadDTO,
} from "../../lib/u1chat";
import {
  authHint,
  Bubble,
  Composer,
  DateSep,
  ICONS,
  initialOf,
  isPermanent,
  nameOf,
  relTime,
  sleep,
  Svg,
  type EditTarget,
  type ReplyTarget,
} from "./convo";

// ── shared helpers ──

function upsertById<T extends { id: number }>(prev: T[], msg: T): T[] {
  return prev.some((m) => m.id === msg.id)
    ? prev.map((m) => (m.id === msg.id ? msg : m))
    : [...prev, msg].sort((a, b) => a.id - b.id);
}

function patchReactions<T extends { id: number; reactions?: ReactionDTO[] }>(
  prev: T[],
  msgId: number,
  reactions: ReactionDTO[]
): T[] {
  return prev.map((m) => (m.id === msgId ? { ...m, reactions } : m));
}

/**
 * "Near bottom" is captured on the user's scroll events — i.e. BEFORE the next
 * message is appended — so a single tall incoming message can't push the anchor
 * past the threshold and strand the view. Default (never scrolled) = stick.
 */
const nearBottom = new WeakMap<HTMLElement, boolean>();
function onBodyScroll(e: React.UIEvent<HTMLElement>) {
  const el = e.currentTarget;
  nearBottom.set(el, el.scrollHeight - el.scrollTop - el.clientHeight < 140);
}
/** Scroll to bottom — always on `force`, else only when the user was near it. */
function autoScroll(el: HTMLElement | null, force = false) {
  if (!el) return;
  if (force || nearBottom.get(el) !== false) el.scrollTop = el.scrollHeight;
}

const sameDay = (a?: number, b?: number) =>
  !!a && !!b && new Date(a).toDateString() === new Date(b).toDateString();

function FindBar(p: { q: string; onQ: (q: string) => void; count: number; onClose: () => void }) {
  return (
    <div className="msn-findbar">
      <Svg d={ICONS.search} />
      <input
        autoFocus
        placeholder="In dieser Unterhaltung suchen…"
        value={p.q}
        onChange={(e) => p.onQ(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && p.onClose()}
      />
      <span className="cnt">{p.q.trim() ? `${p.count} Treffer` : ""}</span>
      <button className="msn-hbtn" onClick={p.onClose} title="Suche schließen">
        <Svg d={ICONS.x} />
      </button>
    </div>
  );
}

const countMatches = (bodies: string[], q: string) => {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  return bodies.filter((b) => b.toLowerCase().includes(needle)).length;
};

// ════════════════════════════════════════════════════════════════════════════
// Bot room
// ════════════════════════════════════════════════════════════════════════════

export function BotConvoView(p: {
  host: HostApi;
  bot: BotDTO;
  myEmail: string;
  /** Latest room activity (rail preview + read tracking). */
  onActivity: (botId: string, lastTs: number, lastRole: string, lastText: string) => void;
  /** An incoming (not-mine) message arrived live — index decides to notify. */
  onIncoming: (key: string, title: string, body: string, ts: number) => void;
}) {
  const { host, bot, myEmail } = p;
  const [messages, setMessages] = useState<BotMessageDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [sending, setSending] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onActivityRef = useRef(p.onActivity);
  onActivityRef.current = p.onActivity;
  const onIncomingRef = useRef(p.onIncoming);
  onIncomingRef.current = p.onIncoming;

  useEffect(() => {
    setMessages([]);
    setReply(null);
    setError(null);
    setFind(null);
    const ac = new AbortController();
    let stopped = false;

    void (async () => {
      let since = 0;
      let loaded = false;
      try {
        const { messages: msgs } = await getBot(host, bot.id);
        if (stopped) return;
        setMessages(msgs);
        since = msgs.length ? msgs[msgs.length - 1].id : 0;
        loaded = true;
        const last = msgs[msgs.length - 1];
        if (last)
          onActivityRef.current(bot.id, last.created_at ?? Date.now(), last.role, last.body);
        requestAnimationFrame(() => autoScroll(bodyRef.current, true));
      } catch (e) {
        if (!stopped) setError(authHint(e));
      }
      while (!stopped && !ac.signal.aborted) {
        try {
          for await (const evt of streamBot(host, bot.id, since, ac.signal)) {
            if (evt.event === "message") {
              const msg = evt.data as BotMessageDTO;
              since = Math.max(since, msg.id);
              setMessages((prev) => upsertById(prev, msg));
              onActivityRef.current(bot.id, msg.created_at ?? Date.now(), msg.role, msg.body);
              if (loaded && (msg.role === "bot" || msg.sender !== myEmail)) {
                onIncomingRef.current(
                  `bot:${bot.id}`,
                  msg.role === "bot" ? bot.name : msg.sender_name || nameOf(msg.sender),
                  msg.body,
                  msg.created_at ?? Date.now()
                );
              }
            } else if (evt.event === "error") {
              setError((evt.data as { message?: string })?.message || "Bot nicht erreichbar.");
            }
          }
        } catch (e) {
          // Route absent (un-migrated backend) or no access → stop, don't spam.
          if (isPermanent(e)) break;
        }
        if (stopped || ac.signal.aborted) break;
        await sleep(1500);
      }
    })();

    return () => {
      stopped = true;
      ac.abort();
    };
  }, [host, bot.id, bot.name, myEmail]);

  useEffect(() => autoScroll(bodyRef.current), [messages]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text) return true;
      setError(null);
      setSending(true);
      const replyTo = reply?.id;
      setReply(null);
      try {
        const msg = await sendBotMessage(host, bot.id, text, replyTo);
        setMessages((prev) => upsertById(prev, msg));
        onActivityRef.current(bot.id, msg.created_at ?? Date.now(), msg.role, msg.body);
        requestAnimationFrame(() => autoScroll(bodyRef.current, true));
        return true;
      } catch (e) {
        setError(authHint(e));
        return false;
      } finally {
        setSending(false);
      }
    },
    [host, bot.id, reply]
  );

  const react = useCallback(
    (msgId: number, emoji: string) => {
      void reactBotMessage(host, bot.id, msgId, emoji)
        .then((r) => setMessages((prev) => patchReactions(prev, msgId, r.reactions)))
        .catch((e) => setError(authHint(e)));
    },
    [host, bot.id]
  );

  const isGroup = (bot.members?.length ?? 0) > 1;
  const memberLine = (bot.members ?? [])
    .map((m) => (m === myEmail ? "Du" : nameOf(m)))
    .join(", ");
  const bodies = messages.map((m) => m.body);

  return (
    <>
      <div className="msn-head">
        <span className="msn-av bot">
          <Svg d={ICONS.orb} />
          <span className={`msn-presence${bot.online ? "" : " off"}`} />
        </span>
        <div className="msn-head-tx">
          <div className="msn-head-title">{bot.name}</div>
          <div className="msn-head-sub">
            {bot.online ? "online" : "offline"} · {isGroup ? memberLine : "Telegram-Brücke — geteilter Verlauf"}
          </div>
        </div>
        <div className="msn-head-actions">
          <button
            className={`msn-hbtn${find !== null ? " on" : ""}`}
            title="In der Unterhaltung suchen"
            onClick={() => setFind((f) => (f === null ? "" : null))}
          >
            <Svg d={ICONS.search} />
          </button>
        </div>
      </div>
      {find !== null && (
        <FindBar q={find} onQ={setFind} count={countMatches(bodies, find)} onClose={() => setFind(null)} />
      )}

      <div className="msn-body-scroll" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !error ? (
          <div className="msn-empty">
            Noch keine Nachrichten — schreib {bot.name} direkt.
            <br />
            Antworten kommen aus derselben Session wie auf Telegram.
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const mine = m.role === "user" && m.sender === myEmail;
            const senderLabel =
              !mine && m.role === "user"
                ? m.sender_name || nameOf(m.sender)
                : undefined;
            const showSender =
              !!senderLabel && (!prev || prev.sender !== m.sender || !sameDay(prev.created_at, m.created_at));
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {(!prev || !sameDay(prev.created_at, m.created_at)) && m.created_at && (
                  <DateSep ts={m.created_at} />
                )}
                <Bubble
                  host={host}
                  domId={`bot-${bot.id}-${m.id}`}
                  mine={mine}
                  senderLabel={showSender ? senderLabel : undefined}
                  avatar={
                    !mine ? (
                      m.role === "bot" ? (
                        <span className="msn-av bot sm">
                          <Svg d={ICONS.orb} />
                        </span>
                      ) : (
                        <span className="msn-av sm">{initialOf(m.sender_name || nameOf(m.sender))}</span>
                      )
                    ) : undefined
                  }
                  body={m.body}
                  markdown={m.role === "bot"}
                  time={m.created_at}
                  reactions={m.reactions}
                  replySender={m.reply_sender}
                  replyText={m.reply_text}
                  highlight={find ?? undefined}
                  actions={{
                    onReact: (e) => react(m.id, e),
                    onReply: () =>
                      setReply({
                        id: m.id,
                        sender: m.role === "bot" ? bot.name : m.sender_name || nameOf(m.sender),
                        text: m.body.slice(0, 120),
                      }),
                  }}
                />
              </div>
            );
          })
        )}
        {error && <div className="msn-err">{error}</div>}
      </div>

      <Composer
        host={host}
        placeholder={`Nachricht an ${bot.name}…`}
        busy={sending}
        reply={reply}
        onCancelReply={() => setReply(null)}
        onSend={(text) => send(text)}
      />
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Team convo (DM / group)
// ════════════════════════════════════════════════════════════════════════════

export function TeamConvoView(p: {
  host: HostApi;
  convo: TeamConvoDTO;
  myEmail: string;
  users: TeamUserDTO[];
  onConvosChanged: () => void;
  onLocalRead: (convoId: string) => void;
  onIncoming: (key: string, title: string, body: string, ts: number) => void;
}) {
  const { host, convo, myEmail } = p;
  const [messages, setMessages] = useState<TeamMessageDTO[]>([]);
  const [typingWho, setTypingWho] = useState<string | null>(null);
  const [otherRead, setOtherRead] = useState(0);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [find, setFind] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pinned, setPinned] = useState<{ id: number; text: string; sender: string } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<number | null>(null);
  const lastTypingSent = useRef(0);
  const lastSentRead = useRef(0);
  const onIncomingRef = useRef(p.onIncoming);
  onIncomingRef.current = p.onIncoming;
  const onLocalReadRef = useRef(p.onLocalRead);
  onLocalReadRef.current = p.onLocalRead;
  const onConvosChangedRef = useRef(p.onConvosChanged);
  onConvosChangedRef.current = p.onConvosChanged;

  const sendReadUpTo = useCallback(
    (lastId: number) => {
      if (lastId <= lastSentRead.current || !document.hasFocus()) return;
      lastSentRead.current = lastId;
      void markRead(host, convo.id, lastId).catch(() => {});
      onLocalReadRef.current(convo.id);
    },
    [host, convo.id]
  );

  useEffect(() => {
    setMessages([]);
    setReply(null);
    setEdit(null);
    setFind(null);
    setError(null);
    setTypingWho(null);
    setOtherRead(convo.other_read ?? 0);
    setPinned(
      convo.pinned_msg_id
        ? { id: convo.pinned_msg_id, text: convo.pinned_text ?? "", sender: convo.pinned_sender ?? "" }
        : null
    );
    lastSentRead.current = 0;
    const ac = new AbortController();
    let stopped = false;

    void (async () => {
      let since = 0;
      let loaded = false;
      try {
        const { messages: msgs } = await getConvo(host, convo.id);
        if (stopped) return;
        setMessages(msgs);
        since = msgs.length ? msgs[msgs.length - 1].id : 0;
        loaded = true;
        if (since) sendReadUpTo(since);
        requestAnimationFrame(() => autoScroll(bodyRef.current, true));
      } catch (e) {
        if (!stopped) setError(authHint(e));
      }
      while (!stopped && !ac.signal.aborted) {
        try {
          for await (const evt of streamConvo(host, convo.id, since, ac.signal)) {
            if (evt.event === "message") {
              const msg = evt.data as TeamMessageDTO;
              since = Math.max(since, msg.id);
              setMessages((prev) => upsertById(prev, msg));
              if (msg.sender !== myEmail) {
                if (typingTimer.current) window.clearTimeout(typingTimer.current);
                setTypingWho(null);
                sendReadUpTo(msg.id);
                if (loaded && !msg.deleted) {
                  onIncomingRef.current(
                    `team:${convo.id}`,
                    nameOf(msg.sender),
                    msg.body || "Anhang",
                    msg.created_at ?? Date.now()
                  );
                }
              }
            } else if (evt.event === "typing") {
              const who = (evt.data as { email?: string })?.email;
              if (who && who !== myEmail) {
                setTypingWho(who);
                if (typingTimer.current) window.clearTimeout(typingTimer.current);
                typingTimer.current = window.setTimeout(() => setTypingWho(null), 3500);
              }
            } else if (evt.event === "read") {
              const d = evt.data as { email?: string; last_id?: number };
              if (d.email && d.email !== myEmail && typeof d.last_id === "number") {
                setOtherRead((r) => Math.max(r, d.last_id!));
              }
            }
          }
        } catch (e) {
          if (isPermanent(e)) break;
        }
        if (stopped || ac.signal.aborted) break;
        await sleep(1500);
      }
    })();

    const onFocus = () => {
      setMessages((msgs) => {
        const last = msgs[msgs.length - 1];
        if (last) sendReadUpTo(last.id);
        return msgs;
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      ac.abort();
      window.removeEventListener("focus", onFocus);
      if (typingTimer.current) window.clearTimeout(typingTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, convo.id, myEmail]);

  useEffect(() => autoScroll(bodyRef.current), [messages, typingWho]);

  const onTyping = useCallback(() => {
    const now = Date.now();
    if (now - lastTypingSent.current > 2500) {
      lastTypingSent.current = now;
      void sendTyping(host, convo.id).catch(() => {});
    }
  }, [host, convo.id]);

  const send = useCallback(
    async (text: string, atts: SendAttachment[]): Promise<boolean> => {
      setError(null);
      setSending(true);
      try {
        if (edit) {
          await editTeamMessage(host, convo.id, edit.id, text);
          setMessages((prev) =>
            prev.map((m) => (m.id === edit.id ? { ...m, body: text, edited: 1 } : m))
          );
          setEdit(null);
        } else {
          const msg = await sendTeamMessage(host, convo.id, text, reply?.id, atts);
          setReply(null);
          setMessages((prev) => upsertById(prev, msg));
          onConvosChangedRef.current();
          requestAnimationFrame(() => autoScroll(bodyRef.current, true));
        }
        return true;
      } catch (e) {
        setError(authHint(e));
        return false;
      } finally {
        setSending(false);
      }
    },
    [host, convo.id, edit, reply]
  );

  const react = useCallback(
    (msgId: number, emoji: string) => {
      void reactTeamMessage(host, convo.id, msgId, emoji)
        .then((r) => setMessages((prev) => patchReactions(prev, msgId, r.reactions)))
        .catch((e) => setError(authHint(e)));
    },
    [host, convo.id]
  );

  const doDelete = useCallback(
    (msgId: number) => {
      void deleteTeamMessage(host, convo.id, msgId)
        .then(() =>
          setMessages((prev) => prev.map((m) => (m.id === msgId ? { ...m, deleted: 1, body: "" } : m)))
        )
        .catch((e) => setError(authHint(e)));
    },
    [host, convo.id]
  );

  const doPin = useCallback(
    (msgId: number, text: string, sender: string) => {
      void pinMessage(host, convo.id, msgId)
        .then(() => {
          setPinned(msgId ? { id: msgId, text, sender } : null);
          onConvosChangedRef.current();
        })
        .catch((e) => setError(authHint(e)));
    },
    [host, convo.id]
  );

  const isGroup = convo.kind === "group";
  const title = isGroup ? convo.title || "Gruppe" : convo.other_name || nameOf(convo.other || "");
  const online = !isGroup && isOnline(convo.other_seen);
  const bodies = messages.map((m) => m.body);
  const addableUsers = p.users.filter(
    (u) => u.email !== myEmail && !(convo.members ?? []).includes(u.email)
  );

  return (
    <>
      <div className="msn-head">
        <span className={`msn-av${isGroup ? " grp" : ""}`}>
          {isGroup ? <Svg d={ICONS.group} /> : initialOf(title)}
          {!isGroup && <span className={`msn-presence${online ? "" : " off"}`} />}
        </span>
        <div className="msn-head-tx">
          <div className="msn-head-title">{title}</div>
          <div className="msn-head-sub">
            {isGroup
              ? `${convo.members?.length ?? 0} Mitglieder`
              : online
                ? "online"
                : convo.other_seen
                  ? `zuletzt ${relTime(convo.other_seen)}`
                  : "Direktnachricht"}
          </div>
        </div>
        <div className="msn-head-actions">
          <button
            className={`msn-hbtn${find !== null ? " on" : ""}`}
            title="In der Unterhaltung suchen"
            onClick={() => setFind((f) => (f === null ? "" : null))}
          >
            <Svg d={ICONS.search} />
          </button>
          {isGroup && (
            <>
              <button className="msn-hbtn" title="Gruppe verwalten" onClick={() => setMenuOpen((o) => !o)}>
                <Svg d={ICONS.dots} />
              </button>
              {menuOpen && (
                <div className="msn-menu" onMouseLeave={() => setMenuOpen(false)}>
                  <div className="msn-menu-h">Gruppe</div>
                  <button
                    className="msn-menu-i"
                    onClick={() => {
                      setMenuOpen(false);
                      const t = window.prompt("Neuer Gruppenname:", convo.title || "");
                      if (t && t.trim()) {
                        void renameConvo(host, convo.id, t.trim())
                          .then(() => onConvosChangedRef.current())
                          .catch((e) => setError(authHint(e)));
                      }
                    }}
                  >
                    <Svg d={ICONS.edit} />
                    <span className="n">Umbenennen</span>
                  </button>
                  {addableUsers.length > 0 && <div className="msn-menu-h">Mitglied hinzufügen</div>}
                  {addableUsers.map((u) => (
                    <button
                      key={u.email}
                      className="msn-menu-i"
                      onClick={() => {
                        setMenuOpen(false);
                        void addConvoMember(host, convo.id, u.email)
                          .then(() => onConvosChangedRef.current())
                          .catch((e) => setError(authHint(e)));
                      }}
                    >
                      <Svg d={ICONS.plus} />
                      <span className="n">{nameOf(u.email, u.name)}</span>
                    </button>
                  ))}
                  <div className="msn-menu-sep" />
                  <button
                    className="msn-menu-i"
                    onClick={() => {
                      setMenuOpen(false);
                      void leaveConvo(host, convo.id)
                        .then(() => onConvosChangedRef.current())
                        .catch((e) => setError(authHint(e)));
                    }}
                  >
                    <Svg d={ICONS.x} />
                    <span className="n">Gruppe verlassen</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {find !== null && (
        <FindBar q={find} onQ={setFind} count={countMatches(bodies, find)} onClose={() => setFind(null)} />
      )}

      {pinned && (
        <div
          className="msn-pinbar"
          onClick={() => document.getElementById(`team-${convo.id}-${pinned.id}`)?.scrollIntoView({ block: "center" })}
          title="Zur angepinnten Nachricht springen"
        >
          <Svg d={ICONS.pin} />
          <span className="msn-pinbar-tx">
            <b>{pinned.sender || "Angepinnt"}</b>
            {pinned.text}
          </span>
          <button
            className="msn-bar-x"
            title="Lösen"
            onClick={(e) => {
              e.stopPropagation();
              doPin(0, "", "");
            }}
          >
            <Svg d={ICONS.x} />
          </button>
        </div>
      )}

      <div className="msn-body-scroll" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !error ? (
          <div className="msn-empty">Noch keine Nachrichten — schreib die erste.</div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const mine = m.sender === myEmail;
            const showSender =
              !mine && isGroup && (!prev || prev.sender !== m.sender || !sameDay(prev.created_at, m.created_at));
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {(!prev || !sameDay(prev.created_at, m.created_at)) && m.created_at && (
                  <DateSep ts={m.created_at} />
                )}
                <Bubble
                  host={host}
                  domId={`team-${convo.id}-${m.id}`}
                  mine={mine}
                  senderLabel={showSender ? nameOf(m.sender) : undefined}
                  avatar={!mine && isGroup ? <span className="msn-av sm">{initialOf(nameOf(m.sender))}</span> : undefined}
                  body={m.body}
                  deleted={!!m.deleted}
                  edited={!!m.edited}
                  attachments={m.attachments}
                  reactions={m.reactions}
                  replySender={m.reply_sender ? nameOf(m.reply_sender) : undefined}
                  replyText={m.reply_text}
                  time={m.created_at}
                  read={mine && !isGroup ? otherRead >= m.id : undefined}
                  highlight={find ?? undefined}
                  actions={{
                    onReact: (e) => react(m.id, e),
                    onReply: () => {
                      setEdit(null);
                      setReply({ id: m.id, sender: nameOf(m.sender), text: (m.body || "Anhang").slice(0, 120) });
                    },
                    onPin: () => doPin(m.id, (m.body || "Anhang").slice(0, 120), nameOf(m.sender)),
                    ...(mine && !m.deleted
                      ? {
                          onEdit: () => {
                            setReply(null);
                            setEdit({ id: m.id, text: m.body });
                          },
                          onDelete: () => doDelete(m.id),
                        }
                      : {}),
                  }}
                />
              </div>
            );
          })
        )}
        {typingWho && (
          <div className="msn-msg them">
            <div className="msn-msg-col">
              <span className="msn-msg-sender">{nameOf(typingWho)}</span>
              <div className="msn-bubble">
                <span className="msn-typing">
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </div>
          </div>
        )}
        {error && <div className="msn-err">{error}</div>}
      </div>

      <Composer
        host={host}
        placeholder={`Nachricht an ${title}…`}
        busy={sending}
        allowAttach
        allowVoice
        reply={reply}
        onCancelReply={() => setReply(null)}
        edit={edit}
        onCancelEdit={() => setEdit(null)}
        onTyping={onTyping}
        onSend={(text, atts) => send(text, atts)}
      />
    </>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// KI thread (op-only lane)
// ════════════════════════════════════════════════════════════════════════════

interface ViewMsg extends MessageDTO {
  streaming?: boolean;
}

const MODELS: { id: string; label: string }[] = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
];

export function KiThreadView(p: {
  host: HostApi;
  thread: ThreadDTO;
  model: string;
  onPickModel: (m: string) => void;
  seed: { text: string; n: number } | null;
  onThreadsChanged: () => void;
  onThreadMeta: (id: string, meta: { title?: string; color?: string; category?: string }) => void;
}) {
  const { host, thread, model } = p;
  const [messages, setMessages] = useState<ViewMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<ReplyTarget | null>(null);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [find, setFind] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const onThreadsChangedRef = useRef(p.onThreadsChanged);
  onThreadsChangedRef.current = p.onThreadsChanged;
  const onThreadMetaRef = useRef(p.onThreadMeta);
  onThreadMetaRef.current = p.onThreadMeta;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const loadThread = useCallback(async () => {
    const { messages: msgs } = await getThread(host, thread.id);
    if (mountedRef.current) setMessages(msgs);
  }, [host, thread.id]);

  useEffect(() => {
    setMessages([]);
    setReply(null);
    setEdit(null);
    setFind(null);
    setError(null);
    void loadThread()
      .then(() => requestAnimationFrame(() => autoScroll(bodyRef.current, true)))
      .catch((e) => mountedRef.current && setError(authHint(e)));
  }, [loadThread]);

  useEffect(() => autoScroll(bodyRef.current), [messages]);

  const send = useCallback(
    async (text: string, atts: SendAttachment[]): Promise<boolean> => {
      if (sending) return true;
      setError(null);

      if (edit) {
        try {
          await editThreadMessage(host, thread.id, edit.id, text);
          setMessages((prev) => prev.map((m) => (m.id === edit.id ? { ...m, content: text, edited: 1 } : m)));
          setEdit(null);
          return true;
        } catch (e) {
          setError(authHint(e));
          return false;
        }
      }

      setSending(true);
      const replyTo = reply?.id;
      setReply(null);
      setMessages((m) => [
        ...m,
        {
          role: "user",
          content: text || (atts.length ? `[${atts.map((a) => a.name).join(", ")}]` : ""),
          created_at: Date.now(),
          ...(replyTo ? { reply_to: replyTo } : {}),
        },
        { role: "assistant", content: "", streaming: true },
      ]);

      const appendDelta = (t: string) =>
        setMessages((m) => {
          const next = m.slice();
          const last = next[next.length - 1];
          if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + t };
          return next;
        });

      const ac = new AbortController();
      abortRef.current = ac;
      try {
        for await (const evt of streamThreadMessage(
          host,
          thread.id,
          {
            content: text,
            model,
            effort: "high",
            ...(replyTo ? { reply_to: replyTo } : {}),
            ...(atts.length ? { attachment_ids: atts.map((a) => a.id) } : {}),
          },
          ac.signal
        )) {
          if (evt.event === "delta") {
            appendDelta((evt.data as { text?: string })?.text ?? "");
          } else if (evt.event === "meta") {
            const meta = evt.data as { title?: string; color?: string; category?: string };
            if (meta.title) onThreadMetaRef.current(thread.id, meta);
          } else if (evt.event === "ratelimit") {
            host.notifications.notify("Rate-Limit erreicht", "u1 wartet kurz — der Stream läuft weiter.");
          } else if (evt.event === "error") {
            setError((evt.data as { message?: string })?.message || "Antwort fehlgeschlagen.");
          } else if (evt.event === "done") {
            const d = evt.data as { cost?: number; error?: string };
            // A run can fail via the done frame's error field, not only an
            // `error` event — surface it instead of ending silently blank.
            if (d.error) setError(d.error);
            setMessages((m) => {
              const next = m.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant") next[next.length - 1] = { ...last, streaming: false, cost: d.cost };
              return next;
            });
          }
        }
      } catch (e) {
        if (mountedRef.current && !(e instanceof DOMException && e.name === "AbortError")) {
          setError(authHint(e));
        }
      } finally {
        if (abortRef.current === ac) abortRef.current = null;
        if (mountedRef.current) {
          setSending(false);
          setMessages((m) => m.map((x) => (x.streaming ? { ...x, streaming: false } : x)));
          onThreadsChangedRef.current();
          // Refetch for server-side ids (enables reactions on the new turns).
          void loadThread().catch(() => {});
        }
      }
      // Optimistic user turn is already rendered → keep the composer cleared.
      return true;
    },
    [host, thread.id, model, sending, reply, edit, loadThread]
  );

  const react = useCallback(
    (msgId: number, emoji: string) => {
      void reactThreadMessage(host, thread.id, msgId, emoji)
        .then((r) => setMessages((prev) => patchReactions(prev as { id: number; reactions?: ReactionDTO[] }[], msgId, r.reactions) as ViewMsg[]))
        .catch((e) => setError(authHint(e)));
    },
    [host, thread.id]
  );

  const bodies = messages.map((m) => m.content);

  return (
    <>
      <div className="msn-head">
        <span className="msn-av ki">
          <Svg d={ICONS.orb} />
        </span>
        <div className="msn-head-tx">
          <div className="msn-head-title">{thread.title || "u1 · KI"}</div>
          <div className="msn-head-sub">Unit One · persistent &amp; synchron mit deinem iPhone</div>
        </div>
        <div className="msn-head-actions">
          <div className="msn-model" role="group" aria-label="Modell">
            {MODELS.map((m) => (
              <button
                key={m.id}
                className={`msn-model-b${model === m.id ? " on" : ""}`}
                onClick={() => p.onPickModel(m.id)}
                title={`Neue Antworten mit ${m.label}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            className={`msn-hbtn${find !== null ? " on" : ""}`}
            title="Im Strang suchen"
            onClick={() => setFind((f) => (f === null ? "" : null))}
          >
            <Svg d={ICONS.search} />
          </button>
          <button className="msn-hbtn" title="Strang-Optionen" onClick={() => setMenuOpen((o) => !o)}>
            <Svg d={ICONS.dots} />
          </button>
          {menuOpen && (
            <div className="msn-menu" onMouseLeave={() => setMenuOpen(false)}>
              <button
                className="msn-menu-i"
                onClick={() => {
                  setMenuOpen(false);
                  void closeThread(host, thread.id)
                    .then(() => onThreadsChangedRef.current())
                    .catch((e) => setError(authHint(e)));
                }}
              >
                <Svg d={ICONS.trash} />
                <span className="n">Strang archivieren</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {find !== null && (
        <FindBar q={find} onQ={setFind} count={countMatches(bodies, find)} onClose={() => setFind(null)} />
      )}

      <div className="msn-body-scroll" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && !error ? (
          <div className="msn-empty">
            Was bauen wir? Schreib u1 direkt — Aufgaben, Debugging, Strategie.
            <br />
            Die Stränge laufen auf deinem iPhone weiter.
          </div>
        ) : (
          messages.map((m, i) => {
            const prev = messages[i - 1];
            const mine = m.role !== "assistant";
            return (
              <div key={m.id ?? `i${i}`} style={{ display: "contents" }}>
                {(!prev || !sameDay(prev.created_at, m.created_at)) && m.created_at && (
                  <DateSep ts={m.created_at} />
                )}
                <Bubble
                  host={host}
                  domId={m.id ? `ki-${thread.id}-${m.id}` : undefined}
                  mine={mine}
                  avatar={
                    !mine ? (
                      <span className="msn-av ki sm">
                        <Svg d={ICONS.orb} />
                      </span>
                    ) : undefined
                  }
                  body={m.content}
                  markdown={!mine}
                  deleted={!!m.deleted}
                  edited={!!m.edited}
                  streaming={m.streaming}
                  reactions={m.reactions}
                  replySender={m.reply_sender}
                  replyText={m.reply_text}
                  time={m.created_at}
                  cost={m.cost}
                  highlight={find ?? undefined}
                  actions={
                    m.id
                      ? {
                          onReact: (e) => react(m.id!, e),
                          onReply: () => {
                            setEdit(null);
                            setReply({
                              id: m.id!,
                              sender: mine ? "Du" : "u1",
                              text: m.content.slice(0, 120),
                            });
                          },
                          ...(mine && !m.deleted
                            ? {
                                onEdit: () => {
                                  setReply(null);
                                  setEdit({ id: m.id!, text: m.content });
                                },
                                onDelete: () => {
                                  void deleteThreadMessage(host, thread.id, m.id!)
                                    .then(() =>
                                      setMessages((prev) =>
                                        prev.map((x) => (x.id === m.id ? { ...x, deleted: 1, content: "" } : x))
                                      )
                                    )
                                    .catch((e) => setError(authHint(e)));
                                },
                              }
                            : {}),
                        }
                      : undefined
                  }
                />
              </div>
            );
          })
        )}
        {error && <div className="msn-err">{error}</div>}
      </div>

      <Composer
        host={host}
        placeholder="Nachricht an u1…"
        busy={sending}
        allowAttach
        reply={reply}
        onCancelReply={() => setReply(null)}
        edit={edit}
        onCancelEdit={() => setEdit(null)}
        seed={p.seed}
        onSend={(text, atts) => send(text, atts)}
      />
    </>
  );
}
