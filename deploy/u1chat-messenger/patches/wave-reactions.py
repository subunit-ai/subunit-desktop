import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "CREATE TABLE IF NOT EXISTS reactions" in db or "/messages/" in srv:
    print("ℹ️  Reaktionen bereits vorhanden — keine Änderung"); sys.exit(0)

# ============================== db.ts ==============================

# 1) getMessages: m.id mitliefern (ohne ID keine Reaktion). Genau 1× vorhanden.
sel_anchor = "SELECT m.role, m.content, m.created_at"
assert srv.count("getMessages") >= 0
assert db.count(sel_anchor) == 1, "getMessages-SELECT-Anker nicht eindeutig"
db = db.replace(sel_anchor, "SELECT m.id, m.role, m.content, m.created_at")

# 2) reactions-Tabelle + Helper anhängen
db += r'''

// --- Subunit iOS: Nachrichten-Reaktionen (Telegram-Parität) ---
// Generisch über alle Flächen: scope ∈ "thread" | "team" | "bot". msg_id = id der jeweiligen
// Nachrichtentabelle (eigener Autoincrement-Raum je scope ⇒ (scope,msg_id) ist eindeutig).
db.run(`CREATE TABLE IF NOT EXISTS reactions (
  scope       TEXT NOT NULL,
  msg_id      INTEGER NOT NULL,
  reactor     TEXT NOT NULL,
  emoji       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (scope, msg_id, reactor, emoji)
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(scope, msg_id)`);

// Aggregat für eine Nachricht aus Sicht von `me`: [{ emoji, count, mine }].
export function reactionsForMsg(scope: string, msgId: number, me: string): any[] {
  const rows = db.query("SELECT emoji, reactor FROM reactions WHERE scope = ? AND msg_id = ?").all(scope, msgId) as any[];
  const em = new Map<string, { count: number; mine: boolean }>();
  for (const r of rows) {
    let a = em.get(r.emoji);
    if (!a) { a = { count: 0, mine: false }; em.set(r.emoji, a); }
    a.count++; if (r.reactor === me) a.mine = true;
  }
  return Array.from(em.entries()).map(([emoji, a]) => ({ emoji, count: a.count, mine: a.mine }));
}

// Toggle: eigene Reaktion an/aus. Liefert das neue Aggregat (aus Sicht des Reagierenden).
export function toggleReaction(scope: string, msgId: number, reactor: string, emoji: string): any[] {
  const has = db.query("SELECT 1 FROM reactions WHERE scope = ? AND msg_id = ? AND reactor = ? AND emoji = ?").get(scope, msgId, reactor, emoji);
  if (has) {
    db.run("DELETE FROM reactions WHERE scope = ? AND msg_id = ? AND reactor = ? AND emoji = ?", [scope, msgId, reactor, emoji]);
  } else {
    db.run("INSERT OR IGNORE INTO reactions (scope, msg_id, reactor, emoji, created_at) VALUES (?, ?, ?, ?, ?)", [scope, msgId, reactor, emoji, Date.now()]);
  }
  return reactionsForMsg(scope, msgId, reactor);
}

// Hängt jeder Nachricht in `msgs` ihr Reaktions-Aggregat an (eine Range-Query, kein N+1).
export function attachReactions(scope: string, msgs: any[], me: string): any[] {
  if (!msgs.length) return msgs;
  const ids = msgs.map((m) => m.id).filter((x) => typeof x === "number");
  if (!ids.length) return msgs.map((m) => ({ ...m, reactions: [] }));
  const lo = Math.min(...ids), hi = Math.max(...ids);
  const rows = db.query("SELECT msg_id, emoji, reactor FROM reactions WHERE scope = ? AND msg_id >= ? AND msg_id <= ?").all(scope, lo, hi) as any[];
  const byMsg = new Map<number, Map<string, { count: number; mine: boolean }>>();
  for (const r of rows) {
    let em = byMsg.get(r.msg_id);
    if (!em) { em = new Map(); byMsg.set(r.msg_id, em); }
    let a = em.get(r.emoji);
    if (!a) { a = { count: 0, mine: false }; em.set(r.emoji, a); }
    a.count++; if (r.reactor === me) a.mine = true;
  }
  return msgs.map((m) => {
    const em = byMsg.get(m.id);
    const reactions = em ? Array.from(em.entries()).map(([emoji, a]) => ({ emoji, count: a.count, mine: a.mine })) : [];
    return { ...m, reactions };
  });
}

// Eigentumsprüfung: gehört die Nachricht zu diesem Thread / dieser Konversation?
export function threadOwnsMessage(threadId: string, msgId: number): boolean {
  return !!db.query("SELECT 1 FROM messages WHERE id = ? AND thread_id = ?").get(msgId, threadId);
}
export function convoOwnsMessage(convoId: string, msgId: number): boolean {
  return !!db.query("SELECT 1 FROM team_messages WHERE id = ? AND convo_id = ?").get(msgId, convoId);
}
'''
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: getMessages.id + reactions-Tabelle + Helper")

# ============================== server.ts ==============================

# 1) Imports der neuen db-Helfer (Anker = stabiler Original-Import-Block, existiert 1×)
imp_anchor = '''  addMessage, setThreadMeta, addAttachment, getAttachmentsByIds,
} from "./db.ts";'''
assert srv.count(imp_anchor) == 1, "db-import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { attachReactions, toggleReaction, threadOwnsMessage, convoOwnsMessage } from "./db.ts";''')

# 2) Thread-GET: Reaktionen an die Nachrichten hängen
th_get = 'return json({ thread: t, messages: getMessages(mThread[1], sess.email) });'
assert srv.count(th_get) == 1, "Thread-GET-Anker nicht eindeutig"
srv = srv.replace(th_get, 'return json({ thread: t, messages: attachReactions("thread", getMessages(mThread[1], sess.email), sess.email) });')

# 3) Team-Convo-GET: Reaktionen an die Nachrichten hängen
tm_get = 'return json({ convo: decorateConvo(getConvo(mConvo[1]), sess.email), messages: listConvoMessages(mConvo[1]) });'
assert srv.count(tm_get) == 1, "Team-GET-Anker nicht eindeutig"
srv = srv.replace(tm_get, 'return json({ convo: decorateConvo(getConvo(mConvo[1]), sess.email), messages: attachReactions("team", listConvoMessages(mConvo[1]), sess.email) });')

# 4) React-Routen vor den finalen 404 (Anker existiert 1×, identisch zu früheren Wellen)
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
routes = r'''  // ===== Reaktionen (Telegram-Parität Slice 1) =====
  // Kuratiertes Set mit Signal-Semantik (👍 Go · 🔥/❤️ merk-dir-das · ✅ erledigt · 👎 anders · 🤔 unklar).
  const REACTION_SET = new Set(["👍", "🔥", "❤️", "✅", "👎", "🤔"]);
  const mThreadReact = path.match(/^\/api\/threads\/([0-9a-f-]+)\/messages\/([0-9]+)\/react$/);
  if (mThreadReact && req.method === "POST") {
    const t = getThread(mThreadReact[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    const msgId = Number(mThreadReact[2]);
    if (!threadOwnsMessage(mThreadReact[1], msgId)) return json({ error: "not found" }, 404);
    const lim = rateLimit(`react:user:${sess.email}`, 300, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const emoji = String(parsed.value.emoji || "");
    if (!REACTION_SET.has(emoji)) return json({ error: "invalid_emoji" }, 400);
    return json({ reactions: toggleReaction("thread", msgId, sess.email, emoji) });
  }
  const mTeamReact = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/messages\/([0-9]+)\/react$/);
  if (mTeamReact && req.method === "POST") {
    if (!isConvoMember(mTeamReact[1], sess.email)) return json({ error: "not found" }, 404);
    const msgId = Number(mTeamReact[2]);
    if (!convoOwnsMessage(mTeamReact[1], msgId)) return json({ error: "not found" }, 404);
    const lim = rateLimit(`react:user:${sess.email}`, 300, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const emoji = String(parsed.value.emoji || "");
    if (!REACTION_SET.has(emoji)) return json({ error: "invalid_emoji" }, 400);
    return json({ reactions: toggleReaction("team", msgId, sess.email, emoji) });
  }

'''
srv = srv.replace(tail_anchor, routes + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: Imports + Thread/Team-GET-Reaktionen + 2 React-Routen")
