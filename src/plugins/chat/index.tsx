/**
 * Chat — the Subunit Messenger: the desktop's Telegram replacement.
 *
 * ONE unified conversation rail over three lanes of the u1-chat backend
 * (chat.subunit.ai — the SAME service subunit-ios uses):
 *
 *   · Bots  (`/api/bots/*`)   — the persistent tmux bots (TJ-Bot, u1 · Gruppe,
 *     Erik, Dirk), account-scoped server-side: the roster only contains the bots
 *     the signed-in account may see. Bot rooms are SHARED — in the group room
 *     TJ + Erik both see everything, like the Telegram group.
 *   · Team  (`/api/team/*`)   — human↔human DMs + groups with full Telegram
 *     parity: media/voice, reactions, reply, edit/delete, read receipts,
 *     typing, pins, group management.
 *   · KI    (`/api/threads/*`)— claude.ai-style u1 threads (op-only), streamed
 *     over SSE, synced with the iPhone.
 *
 * The rail merges all three, sorted by activity, with search, filter chips,
 * unread badges and desktop notifications. Team unread is server-side
 * (read-state); bot unread is tracked client-side (host.storage).
 *
 * Cockpit interop: listens for `chat:seed` (prefills the KI composer) and the
 * palette commands `command:chat:open` / `command:chat:new`.
 *
 * Permissions: backend:u1-chat, storage, notifications.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";
import {
  chatSeedMailbox,
  createConvo,
  createThread,
  getMe,
  isOnline,
  listBots,
  listConvos,
  listTeamUsers,
  listThreads,
  setPresence,
  type BotDTO,
  type TeamConvoDTO,
  type TeamUserDTO,
  type ThreadDTO,
} from "../../lib/u1chat";
import { authHint, ICONS, initialOf, nameOf, relTime, Svg } from "./convo";
import { BotConvoView, KiThreadView, TeamConvoView } from "./lanes";
import { MessengerStyle } from "./style";

const ICON = `<svg viewBox="0 0 24 24"><path d="M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z"/></svg>`;

const STORE_ACTIVE = "activeItem";
const STORE_MODEL = "model";
const STORE_BOTREAD = "botRead";

type Filter = "all" | "bots" | "team" | "ki";

interface SeedPayload {
  taskId?: string;
  title?: string;
  status?: string;
  url?: string;
}

function MessengerView({ host }: { host: HostApi }) {
  const [bots, setBots] = useState<BotDTO[]>([]);
  const [convos, setConvos] = useState<TeamConvoDTO[]>([]);
  const [threads, setThreads] = useState<ThreadDTO[]>([]);
  const [users, setUsers] = useState<TeamUserDTO[]>([]);
  const [myEmail, setMyEmail] = useState("");
  const [kiAllowed, setKiAllowed] = useState(false);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState("opus");
  const [botRead, setBotRead] = useState<Record<string, number>>({});
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [groupDlg, setGroupDlg] = useState(false);
  const [groupTitle, setGroupTitle] = useState("");
  const [groupSel, setGroupSel] = useState<Set<string>>(new Set());

  const activeKeyRef = useRef<string | null>(null);
  activeKeyRef.current = activeKey;
  const myEmailRef = useRef("");
  myEmailRef.current = myEmail;
  // Per-item "last notified" watermark — dedupes poll- vs stream-triggered notes.
  const notifiedRef = useRef<Map<string, number>>(new Map());
  const bootstrappedRef = useRef(false);
  const seedCounter = useRef(0);

  // The SINGLE notification authority. Its per-key watermark (notifiedRef)
  // dedupes the live SSE path and the 12s rail poll against each other, so an
  // incoming message notifies exactly once regardless of which path saw it first.
  const maybeNotify = useCallback(
    (key: string, title: string, body: string, ts: number) => {
      const seen = notifiedRef.current.get(key) ?? 0;
      if (ts <= seen) return;
      notifiedRef.current.set(key, ts);
      if (!bootstrappedRef.current) return; // initial fill, not news
      if (key === activeKeyRef.current && document.hasFocus()) return;
      host.notifications.notify(title, body);
    },
    [host]
  );

  // ── data loading ──

  const refreshAll = useCallback(async () => {
    // Recover identity if the bootstrap getMe failed transiently — otherwise
    // myEmail stays "" and own messages read as foreign (+ self-notifications).
    if (!myEmailRef.current) {
      try {
        const me = await getMe(host);
        myEmailRef.current = me.email;
        setMyEmail(me.email);
      } catch {
        /* try again next poll */
      }
    }
    const [botsR, convosR, threadsR] = await Promise.allSettled([
      listBots(host),
      listConvos(host),
      listThreads(host),
    ]);

    const me = myEmailRef.current;
    let anyOk = false;
    if (botsR.status === "fulfilled") {
      anyOk = true;
      setBots(botsR.value);
      for (const b of botsR.value) {
        // Notify on any message not authored by me (bot reply: last_sender="").
        if (b.last_ts && (b.last_sender ?? "") !== me) {
          maybeNotify(`bot:${b.id}`, b.name, b.last_text || "Neue Nachricht", b.last_ts);
        }
      }
    }
    if (convosR.status === "fulfilled") {
      anyOk = true;
      setConvos(convosR.value);
      for (const c of convosR.value) {
        if (c.updated_at && c.last_sender && c.last_sender !== me) {
          const title = c.kind === "group" ? c.title || "Gruppe" : c.other_name || nameOf(c.other || "");
          maybeNotify(`team:${c.id}`, title, c.last_text || "Neue Nachricht", c.updated_at);
        }
      }
    }
    if (threadsR.status === "fulfilled") {
      anyOk = true;
      setKiAllowed(true);
      setThreads((prev) => {
        const ids = new Set(threadsR.value.map((t) => t.id));
        const extra = prev.filter((t) => !ids.has(t.id));
        return [...extra, ...threadsR.value];
      });
    } else if (/403|forbidden/i.test(String(threadsR.reason))) {
      anyOk = true; // a clean 403 is a valid answer (non-op user), not a failure
      setKiAllowed(false);
    }
    // Only arm notifications once a baseline actually loaded — otherwise a failed
    // first refresh (offline start) would treat old messages as fresh news.
    if (anyOk) bootstrappedRef.current = true;
  }, [host, maybeNotify]);

  // Bootstrap: identity → presence → data → restore state.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const me = await getMe(host);
        if (!alive) return;
        setMyEmail(me.email);
        myEmailRef.current = me.email;
        void setPresence(host, nameOf(me.email)).catch(() => {});
        const [savedModel, savedActive, savedRead] = await Promise.all([
          host.storage.get(STORE_MODEL),
          host.storage.get(STORE_ACTIVE),
          host.storage.get(STORE_BOTREAD),
        ]);
        if (!alive) return;
        if (typeof savedModel === "string") setModel(savedModel);
        if (savedRead && typeof savedRead === "object") setBotRead(savedRead as Record<string, number>);
        await refreshAll();
        if (!alive) return;
        if (typeof savedActive === "string" && !activeKeyRef.current) setActiveKey(savedActive);
      } catch (e) {
        if (alive) setError(authHint(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [host, refreshAll]);

  // Rail poll — previews, unread, presence, incoming-message notifications.
  useEffect(() => {
    const iv = window.setInterval(() => void refreshAll().catch(() => {}), 12000);
    return () => window.clearInterval(iv);
  }, [refreshAll]);

  useEffect(() => {
    if (activeKey) void host.storage.set(STORE_ACTIVE, activeKey);
  }, [host, activeKey]);

  // ── cockpit seed + palette commands ──

  const newKiThread = useCallback(async (): Promise<ThreadDTO | null> => {
    try {
      const t = await createThread(host, model);
      setThreads((prev) => [t, ...prev]);
      setActiveKey(`ki:${t.id}`);
      return t;
    } catch (e) {
      setError(authHint(e));
      return null;
    }
  }, [host, model]);

  useEffect(() => {
    const applySeed = (p: SeedPayload) => {
      const title = p.title || "Aufgabe";
      setSeed({ text: `Lass uns an dieser Aufgabe arbeiten: „${title}". `, n: ++seedCounter.current });
      const key = activeKeyRef.current;
      if (!key || !key.startsWith("ki:")) {
        const existing = threads.find((t) => t.status !== "closed");
        if (existing) setActiveKey(`ki:${existing.id}`);
        else void newKiThread();
      }
    };
    // Drain a seed the dashboard stashed before we were mounted (the live event
    // fired before our subscription existed), then listen for future ones.
    const stashed = chatSeedMailbox.take();
    if (stashed) applySeed(stashed);
    const offSeed = host.events.on("chat:seed", (data) => applySeed((data ?? {}) as SeedPayload));
    const offNew = host.events.on("command:chat:new", () => setNewOpen(true));
    return () => {
      offSeed();
      offNew();
    };
  }, [host, threads, newKiThread]);

  // ── lane callbacks ──

  const onBotActivity = useCallback(
    (botId: string, lastTs: number, lastRole: string, lastText: string) => {
      setBots((prev) =>
        prev.map((b) =>
          b.id === botId ? { ...b, last_ts: lastTs, last_role: lastRole, last_text: lastText } : b
        )
      );
      // Viewing the room = read.
      setBotRead((prev) => {
        if ((prev[botId] ?? 0) >= lastTs) return prev;
        const next = { ...prev, [botId]: lastTs };
        void host.storage.set(STORE_BOTREAD, next);
        return next;
      });
      notifiedRef.current.set(`bot:${botId}`, Math.max(notifiedRef.current.get(`bot:${botId}`) ?? 0, lastTs));
    },
    [host]
  );

  // Live incoming from an open lane → route through the ONE notify authority
  // (watermark-deduped against the poll). No separate notify path.
  const onIncoming = useCallback(
    (key: string, title: string, body: string, ts: number) => {
      maybeNotify(key, title, body, ts);
    },
    [maybeNotify]
  );

  const onLocalRead = useCallback((convoId: string) => {
    setConvos((prev) => prev.map((c) => (c.id === convoId ? { ...c, unread: 0 } : c)));
  }, []);

  const onConvosChanged = useCallback(() => void refreshAll().catch(() => {}), [refreshAll]);

  const onThreadMeta = useCallback(
    (id: string, meta: { title?: string; color?: string; category?: string }) => {
      setThreads((prev) => prev.map((t) => (t.id === id ? { ...t, ...meta } : t)));
    },
    []
  );

  const pickModel = useCallback(
    (m: string) => {
      setModel(m);
      void host.storage.set(STORE_MODEL, m);
    },
    [host]
  );

  const startDM = useCallback(
    async (email: string) => {
      setNewOpen(false);
      try {
        const convo = await createConvo(host, { email });
        setConvos((prev) => (prev.some((c) => c.id === convo.id) ? prev : [convo, ...prev]));
        setActiveKey(`team:${convo.id}`);
      } catch (e) {
        setError(authHint(e));
      }
    },
    [host]
  );

  const createGroup = useCallback(async () => {
    const title = groupTitle.trim();
    if (!title || groupSel.size === 0) return;
    try {
      const convo = await createConvo(host, { title, members: [...groupSel] });
      setGroupDlg(false);
      setGroupTitle("");
      setGroupSel(new Set());
      setConvos((prev) => (prev.some((c) => c.id === convo.id) ? prev : [convo, ...prev]));
      setActiveKey(`team:${convo.id}`);
    } catch (e) {
      setError(authHint(e));
    }
  }, [host, groupTitle, groupSel]);

  // ── rail entries ──

  interface Entry {
    key: string;
    kind: "bot" | "team" | "ki";
    title: string;
    preview: string;
    ts: number;
    unread: number;
    unreadDot: boolean;
    online?: boolean;
    avatar: React.ReactNode;
  }

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const b of bots) {
      out.push({
        key: `bot:${b.id}`,
        kind: "bot",
        title: b.name,
        preview: b.last_text || "Telegram-Brücke",
        ts: b.last_ts ?? 0,
        unread: 0,
        unreadDot: (b.last_ts ?? 0) > (botRead[b.id] ?? 0) && (b.last_sender ?? "") !== myEmail,
        online: b.online,
        avatar: (
          <span className="msn-av bot">
            <Svg d={ICONS.orb} />
            <span className={`msn-presence${b.online ? "" : " off"}`} />
          </span>
        ),
      });
    }
    for (const c of convos) {
      const isDM = c.kind === "dm";
      const title = isDM ? c.other_name || nameOf(c.other || "") : c.title || "Gruppe";
      const online = isDM && isOnline(c.other_seen);
      out.push({
        key: `team:${c.id}`,
        kind: "team",
        title,
        preview: c.last_sender
          ? `${c.last_sender === myEmail ? "Du" : nameOf(c.last_sender)}: ${c.last_text || ""}`
          : c.last_text || "Noch keine Nachrichten",
        ts: c.updated_at ?? 0,
        unread: c.unread ?? 0,
        unreadDot: false,
        online,
        avatar: (
          <span className={`msn-av${isDM ? "" : " grp"}`}>
            {isDM ? initialOf(title) : <Svg d={ICONS.group} />}
            {isDM && <span className={`msn-presence${online ? "" : " off"}`} />}
          </span>
        ),
      });
    }
    if (kiAllowed) {
      for (const t of threads) {
        if (t.status === "closed") continue;
        out.push({
          key: `ki:${t.id}`,
          kind: "ki",
          title: t.title || "u1 · KI",
          preview: t.category || "KI-Strang",
          ts: t.updated_at ?? 0,
          unread: 0,
          unreadDot: false,
          avatar: (
            <span className="msn-av ki">
              <Svg d={ICONS.orb} />
            </span>
          ),
        });
      }
    }
    const q = query.trim().toLowerCase();
    return out
      .filter((e) => (filter === "all" ? true : filter === e.kind || (filter === "bots" && e.kind === "bot")))
      .filter((e) => !q || e.title.toLowerCase().includes(q) || e.preview.toLowerCase().includes(q))
      .sort((a, b) => b.ts - a.ts);
  }, [bots, convos, threads, kiAllowed, botRead, myEmail, filter, query]);

  // ── active pane ──

  const activeBot = activeKey?.startsWith("bot:") ? bots.find((b) => `bot:${b.id}` === activeKey) : undefined;
  const activeConvo = activeKey?.startsWith("team:")
    ? convos.find((c) => `team:${c.id}` === activeKey)
    : undefined;
  const activeThread = activeKey?.startsWith("ki:")
    ? threads.find((t) => `ki:${t.id}` === activeKey && t.status !== "closed")
    : undefined;

  // A dangling active key (archived thread, left group) resolves to nothing →
  // fall back to the blank pane instead of showing a stale conversation.
  useEffect(() => {
    if (activeKey && !activeBot && !activeConvo && !activeThread && !loading) {
      setActiveKey(null);
    }
  }, [activeKey, activeBot, activeConvo, activeThread, loading]);

  // If the KI lane becomes unavailable (non-op) while its filter is active,
  // don't strand the rail on an empty, unselectable chip.
  useEffect(() => {
    if (filter === "ki" && !kiAllowed) setFilter("all");
  }, [filter, kiAllowed]);

  // Auto-dismiss the global error toast.
  useEffect(() => {
    if (!error || !activeKey) return;
    const t = window.setTimeout(() => setError(null), 6000);
    return () => window.clearTimeout(t);
  }, [error, activeKey]);

  const dmUsers = users.filter((u) => u.email !== myEmail);

  // Load team users once the identity is known (for DM picker + group dialog).
  useEffect(() => {
    if (!myEmail) return;
    let alive = true;
    void listTeamUsers(host)
      .then((u) => alive && setUsers(u))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [host, myEmail]);

  const chips: { id: Filter; label: string }[] = [
    { id: "all", label: "Alle" },
    { id: "bots", label: "Bots" },
    { id: "team", label: "Team" },
    ...(kiAllowed ? [{ id: "ki" as Filter, label: "KI" }] : []),
  ];

  return (
    <div className="msn">
      <MessengerStyle />

      {/* ── rail ── */}
      <aside className="msn-rail">
        <div className="msn-rail-head">
          <div className="sect" style={{ margin: 0 }}>
            Chat
          </div>
          <div className="msn-new-wrap">
            <button className="iconbtn msn-new" title="Neue Unterhaltung" onClick={() => setNewOpen((o) => !o)}>
              <span className="ic">
                <Svg d={ICONS.plus} />
              </span>
            </button>
            {newOpen && (
              <div className="msn-menu" onMouseLeave={() => setNewOpen(false)}>
                {kiAllowed && (
                  <>
                    <div className="msn-menu-h">u1</div>
                    <button
                      className="msn-menu-i"
                      onClick={() => {
                        setNewOpen(false);
                        void newKiThread();
                      }}
                    >
                      <Svg d={ICONS.orb} />
                      <span className="n">Neuer KI-Strang</span>
                    </button>
                    <div className="msn-menu-sep" />
                  </>
                )}
                <div className="msn-menu-h">Direktnachricht</div>
                {dmUsers.length === 0 ? (
                  <div className="msn-menu-empty">Keine weiteren Team-Mitglieder.</div>
                ) : (
                  dmUsers.map((u) => {
                    const label = nameOf(u.email, u.name);
                    return (
                      <button key={u.email} className="msn-menu-i" onClick={() => void startDM(u.email)}>
                        <span className="msn-av sm">
                          {initialOf(label)}
                          {isOnline(u.last_seen) && <span className="msn-presence" />}
                        </span>
                        <span className="n">{label}</span>
                      </button>
                    );
                  })
                )}
                <div className="msn-menu-sep" />
                <button
                  className="msn-menu-i"
                  onClick={() => {
                    setNewOpen(false);
                    setGroupDlg(true);
                  }}
                >
                  <Svg d={ICONS.group} />
                  <span className="n">Neue Gruppe…</span>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="msn-search">
          <Svg d={ICONS.search} />
          <input placeholder="Suchen…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

        <div className="msn-chips">
          {chips.map((c) => (
            <button
              key={c.id}
              className={`msn-chip${filter === c.id ? " on" : ""}`}
              onClick={() => setFilter(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="msn-rail-empty">
            <span className="spinner" />
          </div>
        ) : entries.length === 0 ? (
          <div className="msn-rail-empty">
            <span>{query ? "Keine Treffer." : "Noch keine Unterhaltungen."}</span>
          </div>
        ) : (
          <div className="msn-items">
            {entries.map((e) => (
              <button
                key={e.key}
                className={`msn-item${e.key === activeKey ? " is-active" : ""}`}
                onClick={() => setActiveKey(e.key)}
              >
                {e.avatar}
                <span className="msn-item-tx">
                  <span className="msn-item-top">
                    <span className="msn-item-title">{e.title}</span>
                    <span className="msn-item-time">{relTime(e.ts)}</span>
                  </span>
                  <span className="msn-item-prev">{e.preview}</span>
                </span>
                {e.unread > 0 && <span className="msn-unread">{e.unread}</span>}
                {e.unreadDot && <span className="msn-unread dot" />}
              </button>
            ))}
          </div>
        )}
      </aside>

      {/* ── conversation ── */}
      <section className="msn-conv">
        {activeBot ? (
          <BotConvoView
            key={activeBot.id}
            host={host}
            bot={activeBot}
            myEmail={myEmail}
            onActivity={onBotActivity}
            onIncoming={onIncoming}
          />
        ) : activeConvo ? (
          <TeamConvoView
            key={activeConvo.id}
            host={host}
            convo={activeConvo}
            myEmail={myEmail}
            users={users}
            onConvosChanged={onConvosChanged}
            onLocalRead={onLocalRead}
            onIncoming={onIncoming}
          />
        ) : activeThread ? (
          <KiThreadView
            key={activeThread.id}
            host={host}
            thread={activeThread}
            model={model}
            onPickModel={pickModel}
            seed={seed}
            onThreadsChanged={onConvosChanged}
            onThreadMeta={onThreadMeta}
          />
        ) : (
          <div className="msn-conv-blank">
            <span className="msn-blank-ic">
              <Svg d={ICONS.orb} />
            </span>
            <b>Subunit Messenger</b>
            <span className="hint center">
              {error
                ? error
                : "Bots, Team und KI in einem Ort — wähle links eine Unterhaltung oder starte mit „＋“ eine neue."}
            </span>
          </div>
        )}
      </section>

      {/* Global error toast — errors from the "+" menu, group dialog and new-thread
          are otherwise invisible while a conversation is open. Auto-dismisses. */}
      {error && activeKey && (
        <div className="msn-toast" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {/* ── group dialog ── */}
      {groupDlg && (
        <div className="msn-overlay" onClick={() => setGroupDlg(false)}>
          <div className="msn-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Neue Gruppe</h3>
            <input
              className="fld"
              placeholder="Gruppenname"
              value={groupTitle}
              autoFocus
              onChange={(e) => setGroupTitle(e.target.value)}
            />
            <div className="msn-dlg-users">
              {dmUsers.map((u) => {
                const on = groupSel.has(u.email);
                const label = nameOf(u.email, u.name);
                return (
                  <button
                    key={u.email}
                    className={`msn-dlg-u${on ? " on" : ""}`}
                    onClick={() =>
                      setGroupSel((prev) => {
                        const next = new Set(prev);
                        if (next.has(u.email)) next.delete(u.email);
                        else next.add(u.email);
                        return next;
                      })
                    }
                  >
                    <span className="box">{on && <Svg d={ICONS.check} w={3} />}</span>
                    <span className="msn-av sm">{initialOf(label)}</span>
                    <span>{label}</span>
                  </button>
                );
              })}
              {dmUsers.length === 0 && <div className="msn-menu-empty">Keine weiteren Team-Mitglieder.</div>}
            </div>
            <div className="msn-dlg-foot">
              <button className="btn btn-ghost minibtn" onClick={() => setGroupDlg(false)}>
                Abbrechen
              </button>
              <button
                className="btn btn-primary minibtn"
                disabled={!groupTitle.trim() || groupSel.size === 0}
                onClick={() => void createGroup()}
              >
                Gruppe erstellen
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "chat",
    name: "Chat",
    version: "2.0.0",
    description:
      "Subunit Messenger — Bots (TJ/Gruppe/Erik/Dirk), Team-Chat und KI-Stränge in einem Ort. Der Telegram-Ersatz.",
    icon: ICON,
    permissions: ["backend:u1-chat", "storage", "notifications"],
    nav: { section: "comms", order: 0 },
    commands: [
      { id: "open", title: "Go to Chat" },
      { id: "new", title: "Chat: neue Unterhaltung" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<MessengerView host={host} />);
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
