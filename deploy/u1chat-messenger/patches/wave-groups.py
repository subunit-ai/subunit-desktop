import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "decorateConvo" not in srv:
    print("❌ Team-Migration fehlt — bitte ZUERST deploy-backend-team-home.sh ausführen."); sys.exit(1)
if "pinned_msg_id" in db:
    print("ℹ️  Pins/Gruppen bereits vorhanden — keine Änderung"); sys.exit(0)

# ============================== db.ts ==============================
db += r'''

// --- Subunit iOS: Pins + Gruppen-Verwaltung ---
{
  const tc = (db.query("PRAGMA table_info(team_convos)").all() as any[]).map((c) => c.name);
  if (!tc.includes("pinned_msg_id")) db.run("ALTER TABLE team_convos ADD COLUMN pinned_msg_id INTEGER");
}
export function setPin(convoId: string, msgId: number) {
  db.run("UPDATE team_convos SET pinned_msg_id = ? WHERE id = ?", [msgId > 0 ? msgId : null, convoId]);
}
export function renameConvo(convoId: string, title: string) {
  db.run("UPDATE team_convos SET title = ? WHERE id = ?", [title, convoId]);
}
export function addConvoMember(convoId: string, email: string) {
  db.run("INSERT OR IGNORE INTO team_convo_members (convo_id, email) VALUES (?, ?)", [convoId, email]);
}
export function removeConvoMember(convoId: string, email: string) {
  db.run("DELETE FROM team_convo_members WHERE convo_id = ? AND email = ?", [convoId, email]);
}
export function getTeamMessageBrief(convoId: string, msgId: number): any {
  return db.query("SELECT sender, body FROM team_messages WHERE id = ? AND convo_id = ?").get(msgId, convoId);
}
'''
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: pinned_msg_id + setPin/renameConvo/addConvoMember/removeConvoMember/getTeamMessageBrief")

# ============================== server.ts ==============================

# 1) Import (Anker = team-home Import-Block, existiert 1×)
imp_anchor = '''  listConvosForUser, listConvoMessages, addConvoMessage,
} from "./db.ts";'''
assert srv.count(imp_anchor) == 1, "team-home-Import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { setPin, renameConvo, addConvoMember, removeConvoMember, getTeamMessageBrief } from "./db.ts";''')

# 2) decorateConvo: pinned_*-Vorschau (Anker = Original-Zeile, existiert 1×)
deco_anchor = '''    members, last_text: c.last_text, last_sender: c.last_sender, updated_at: c.updated_at,'''
assert srv.count(deco_anchor) == 1, "decorateConvo-Anker nicht eindeutig"
srv = srv.replace(deco_anchor, deco_anchor + '''
    pinned_msg_id: c.pinned_msg_id || null,
    pinned_text: c.pinned_msg_id ? (getTeamMessageBrief(c.id, c.pinned_msg_id)?.body ?? null) : null,
    pinned_sender: c.pinned_msg_id ? (getTeamMessageBrief(c.id, c.pinned_msg_id)?.sender?.split("@")[0] ?? null) : null,''')

# 3) Routen vor den finalen 404
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
routes = r'''  // ===== Pins + Gruppen-Verwaltung (Telegram-Parität Slice 5) =====
  const mPin = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/pin$/);
  if (mPin && req.method === "POST") {
    if (!isConvoMember(mPin[1], sess.email)) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const msgId = typeof parsed.value.msg_id === "number" ? Math.trunc(parsed.value.msg_id) : 0;
    if (msgId > 0 && !getTeamMessageBrief(mPin[1], msgId)) return json({ error: "not found" }, 404);
    setPin(mPin[1], msgId);
    return json({ ok: true });
  }
  const mRename = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/rename$/);
  if (mRename && req.method === "POST") {
    if (!isConvoMember(mRename[1], sess.email)) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const title = String(parsed.value.title || "").trim().slice(0, 80);
    if (!title) return json({ error: "empty" }, 400);
    renameConvo(mRename[1], title);
    return json({ ok: true });
  }
  const mAddMem = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/members\/add$/);
  if (mAddMem && req.method === "POST") {
    if (!isConvoMember(mAddMem[1], sess.email)) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const email = String(parsed.value.email || "").toLowerCase().trim();
    if (!email.endsWith("@" + ALLOWED_DOMAIN)) return json({ error: "invalid_target" }, 400);
    addConvoMember(mAddMem[1], email);
    return json({ ok: true });
  }
  const mLeave = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/leave$/);
  if (mLeave && req.method === "POST") {
    if (!isConvoMember(mLeave[1], sess.email)) return json({ error: "not found" }, 404);
    removeConvoMember(mLeave[1], sess.email);
    return json({ ok: true });
  }

'''
srv = srv.replace(tail_anchor, routes + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: decorateConvo (pinned_*) + /pin + /rename + /members/add + /leave")
