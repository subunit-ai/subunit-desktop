import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "attachReactions" not in db:
    print("❌ Reaktions-Migration fehlt — bitte ZUERST deploy-backend-reactions.sh ausführen."); sys.exit(1)
if "reply_to" in db:
    print("ℹ️  Reply bereits vorhanden — keine Änderung"); sys.exit(0)

# ============================== db.ts ==============================

# 1) Additive Spalten (guarded via PRAGMA, idempotent)
db += r'''

// --- Subunit iOS: Nachrichten-Mutation (reply_to / edited / deleted) für messages + team_messages ---
for (const [tbl] of [["messages"], ["team_messages"]] as [string][]) {
  const cols = (db.query(`PRAGMA table_info(${tbl})`).all() as any[]).map((c) => c.name);
  if (!cols.includes("reply_to"))   db.run(`ALTER TABLE ${tbl} ADD COLUMN reply_to INTEGER`);
  if (!cols.includes("edited_at"))  db.run(`ALTER TABLE ${tbl} ADD COLUMN edited_at INTEGER`);
  if (!cols.includes("deleted_at")) db.run(`ALTER TABLE ${tbl} ADD COLUMN deleted_at INTEGER`);
}

// Edit/Delete-Helfer (Endpunkte kommen in Slice 3; nur eigene Nachrichten).
export function editThreadMessage(threadId: string, msgId: number, content: string): boolean {
  const r: any = db.run("UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND thread_id = ? AND role = 'user' AND deleted_at IS NULL",
    [content, Date.now(), msgId, threadId]);
  return (r?.changes ?? 0) > 0;
}
export function deleteThreadMessage(threadId: string, msgId: number): boolean {
  const r: any = db.run("UPDATE messages SET deleted_at = ?, content = '' WHERE id = ? AND thread_id = ? AND deleted_at IS NULL",
    [Date.now(), msgId, threadId]);
  return (r?.changes ?? 0) > 0;
}
export function editTeamMessage(convoId: string, msgId: number, sender: string, body: string): boolean {
  const r: any = db.run("UPDATE team_messages SET body = ?, edited_at = ? WHERE id = ? AND convo_id = ? AND sender = ? AND deleted_at IS NULL",
    [body, Date.now(), msgId, convoId, sender]);
  return (r?.changes ?? 0) > 0;
}
export function deleteTeamMessage(convoId: string, msgId: number, sender: string): boolean {
  const r: any = db.run("UPDATE team_messages SET deleted_at = ?, body = '' WHERE id = ? AND convo_id = ? AND sender = ? AND deleted_at IS NULL",
    [Date.now(), msgId, convoId, sender]);
  return (r?.changes ?? 0) > 0;
}
'''

# 2) getMessages: Zitat-Vorschau (Self-JOIN) + edited/deleted (Anker = post-reactions-Form)
gm_old = '''`SELECT m.id, m.role, m.content, m.created_at
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.thread_id = ? AND t.owner = ?
      ORDER BY m.id ASC`'''
assert db.count(gm_old) == 1, "getMessages-Query-Anker nicht eindeutig (Reaktions-Migration gelaufen?)"
gm_new = '''`SELECT m.id, m.role,
        CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.content END AS content,
        m.created_at, m.reply_to,
        CASE WHEN m.reply_to IS NULL THEN NULL ELSE
          (CASE r.role WHEN 'user' THEN 'Du' WHEN 'assistant' THEN 'u1' ELSE 'System' END) END AS reply_sender,
        CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.content, 1, 120) END AS reply_text,
        (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
      FROM messages m
      LEFT JOIN messages r ON r.id = m.reply_to
      JOIN threads t ON t.id = m.thread_id
      WHERE m.thread_id = ? AND t.owner = ?
      ORDER BY m.id ASC`'''
db = db.replace(gm_old, gm_new)

# 3) listConvoMessages: dito (Team)
lcm_old = '''db.query("SELECT id, sender, body, created_at FROM team_messages WHERE convo_id = ? ORDER BY id ASC LIMIT ?").all(id, limit) as any[];'''
assert db.count(lcm_old) == 1, "listConvoMessages-Anker nicht eindeutig"
lcm_new = '''db.query(`SELECT m.id, m.sender,
      CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.body END AS body,
      m.created_at, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id ASC LIMIT ?`).all(id, limit) as any[];'''
db = db.replace(lcm_old, lcm_new)

# 4) addMessage: reply_to-Spalte + Parameter
am_sig = "export function addMessage(threadId: string, owner: string, role: string, content: string) {"
assert db.count(am_sig) == 1, "addMessage-Signatur-Anker nicht eindeutig"
db = db.replace(am_sig, "export function addMessage(threadId: string, owner: string, role: string, content: string, replyTo: number | null = null) {")
am_ins = '''`INSERT INTO messages (thread_id, role, content, created_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM threads WHERE id = ? AND owner = ?)`,
    [threadId, role, content, t, threadId, owner],'''
assert db.count(am_ins) == 1, "addMessage-INSERT-Anker nicht eindeutig"
db = db.replace(am_ins, '''`INSERT INTO messages (thread_id, role, content, created_at, reply_to)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM threads WHERE id = ? AND owner = ?)`,
    [threadId, role, content, t, replyTo, threadId, owner],''')

# 5) addConvoMessage: reply_to-Parameter + Insert + Rückgabe mit Zitat-Vorschau
acm_sig = "export function addConvoMessage(convoId: string, sender: string, body: string): any {"
assert db.count(acm_sig) == 1, "addConvoMessage-Signatur-Anker nicht eindeutig"
db = db.replace(acm_sig, "export function addConvoMessage(convoId: string, sender: string, body: string, replyTo: number | null = null): any {")
acm_ins = '''db.run("INSERT INTO team_messages (convo_id, sender, body, created_at) VALUES (?, ?, ?, ?)", [convoId, sender, body, t]);'''
assert db.count(acm_ins) == 1, "addConvoMessage-INSERT-Anker nicht eindeutig"
db = db.replace(acm_ins, '''db.run("INSERT INTO team_messages (convo_id, sender, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?)", [convoId, sender, body, t, replyTo]);''')
acm_ret = '''return db.query("SELECT id, sender, body, created_at FROM team_messages WHERE convo_id = ? ORDER BY id DESC LIMIT 1").get(convoId);'''
assert db.count(acm_ret) == 1, "addConvoMessage-Return-Anker nicht eindeutig"
db = db.replace(acm_ret, '''return db.query(`SELECT m.id, m.sender, m.body, m.created_at, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      0 AS edited, 0 AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id DESC LIMIT 1`).get(convoId);''')

open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: reply_to/edited/deleted Spalten + Query-Erweiterung + addMessage/addConvoMessage")

# ============================== server.ts ==============================

# 1) Thread-POST: reply_to validieren + an addMessage durchreichen
th_add = 'addMessage(threadId, sess.email, "user", content);'
assert srv.count(th_add) == 1, "Thread-addMessage-Anker nicht eindeutig"
srv = srv.replace(th_add, '''let replyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (threadOwnsMessage(threadId, rid)) replyTo = rid;
    }
    addMessage(threadId, sess.email, "user", content, replyTo);''')

# 2) Team-POST: reply_to validieren + an addConvoMessage durchreichen
tm_add = 'const msg = addConvoMessage(mConvoMsg[1], sess.email, body);'
assert srv.count(tm_add) == 1, "Team-addConvoMessage-Anker nicht eindeutig"
srv = srv.replace(tm_add, '''let teamReplyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (convoOwnsMessage(mConvoMsg[1], rid)) teamReplyTo = rid;
    }
    const msg = addConvoMessage(mConvoMsg[1], sess.email, body, teamReplyTo);''')

open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: reply_to-Annahme (Thread + Team)")
