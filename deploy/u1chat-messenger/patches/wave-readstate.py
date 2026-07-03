import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "decorateConvo" not in srv:
    print("❌ Team-Migration fehlt — bitte ZUERST deploy-backend-team-home.sh ausführen."); sys.exit(1)
if "read_state" in db:
    print("ℹ️  Read-State bereits vorhanden — keine Änderung"); sys.exit(0)

# ============================== db.ts ==============================
db += r'''

// --- Subunit iOS: Read-State (Ungelesen-Zähler + Read-Receipts) ---
db.run(`CREATE TABLE IF NOT EXISTS read_state (
  convo_id     TEXT NOT NULL,
  email        TEXT NOT NULL,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (convo_id, email)
)`);
export function setRead(convoId: string, email: string, lastId: number) {
  db.run(`INSERT INTO read_state (convo_id, email, last_read_id, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(convo_id, email) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id), updated_at = excluded.updated_at`,
    [convoId, email, lastId, Date.now()]);
}
export function unreadCount(convoId: string, email: string): number {
  const r: any = db.query(`SELECT COUNT(*) AS n FROM team_messages
    WHERE convo_id = ? AND sender != ?
      AND id > COALESCE((SELECT last_read_id FROM read_state WHERE convo_id = ? AND email = ?), 0)`)
    .get(convoId, email, convoId, email);
  return r?.n ?? 0;
}
export function otherReadId(convoId: string, email: string): number {
  const r: any = db.query("SELECT COALESCE(MAX(last_read_id), 0) AS r FROM read_state WHERE convo_id = ? AND email != ?")
    .get(convoId, email);
  return r?.r ?? 0;
}
'''
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: read_state-Tabelle + setRead/unreadCount/otherReadId")

# ============================== server.ts ==============================

# 1) Import (Anker = team-home Import-Block, existiert 1×)
imp_anchor = '''  listConvosForUser, listConvoMessages, addConvoMessage,
} from "./db.ts";'''
assert srv.count(imp_anchor) == 1, "team-home-Import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { setRead, unreadCount, otherReadId } from "./db.ts";''')

# 2) decorateConvo: unread + other_read mitliefern
deco_anchor = '''    members, last_text: c.last_text, last_sender: c.last_sender, updated_at: c.updated_at,'''
assert srv.count(deco_anchor) == 1, "decorateConvo-Anker nicht eindeutig"
srv = srv.replace(deco_anchor, deco_anchor + '''
    unread: unreadCount(c.id, me), other_read: otherReadId(c.id, me),''')

# 3) Routen vor den finalen 404
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
routes = r'''  // ===== Read-State + Typing (Telegram-Parität Slice 4) =====
  const mRead = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/read$/);
  if (mRead && req.method === "POST") {
    if (!isConvoMember(mRead[1], sess.email)) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const lastId = typeof parsed.value.last_id === "number" ? Math.trunc(parsed.value.last_id) : 0;
    if (lastId > 0) {
      setRead(mRead[1], sess.email, lastId);
      teamPublish(mRead[1], "read", { email: sess.email, last_id: lastId });
    }
    return json({ ok: true });
  }
  const mTyping = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/typing$/);
  if (mTyping && req.method === "POST") {
    if (!isConvoMember(mTyping[1], sess.email)) return json({ error: "not found" }, 404);
    const lim = rateLimit(`typing:user:${sess.email}`, 120, 60 * 1000);
    if (lim) return lim;
    teamPublish(mTyping[1], "typing", { email: sess.email });
    return json({ ok: true });
  }

'''
srv = srv.replace(tail_anchor, routes + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: decorateConvo (unread/other_read) + /read + /typing")
