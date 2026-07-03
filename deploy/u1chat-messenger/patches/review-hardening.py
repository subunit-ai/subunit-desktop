# review-hardening.py — Adversariale Review-Fixes an den iOS-verbatim-abgeleiteten Stellen
# (readstate/groups/Team-Stream), plus DB. Läuft GANZ AM ENDE der Kette (nach bot-module: braucht
# acquireSse/releaseSse; nach widening/attachments-on-delete).
# Findings: LOW-7 Rate-Limits auf /read /pin /rename /members/add /leave;
#           LOW-8 (Team-Seite) geteilter SSE-Connection-Cap auf den Team-Stream;
#           LOW-9 unreadCount ignoriert soft-gelöschte; LOW-10 read-Broadcast sendet monotonen Wert.
import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "team-mut:user" in srv or "readIdFor" in db:
    print("ℹ️  review-hardening bereits angewandt — keine Änderung"); sys.exit(0)
for need_srv in ("acquireSse", "mPin", "mRead && req.method"):
    if need_srv not in srv:
        print(f"❌ Voraussetzung fehlt in server.ts: {need_srv} — Reihenfolge prüfen."); sys.exit(1)
if "unreadCount" not in db:
    print("❌ read_state-Migration (unreadCount) fehlt in db.ts."); sys.exit(1)

# ============================== db.ts ==============================

# LOW-9: unreadCount zählt soft-gelöschte NICHT mehr mit (deleted_at IS NULL).
uc_old = '''  const r: any = db.query(`SELECT COUNT(*) AS n FROM team_messages
    WHERE convo_id = ? AND sender != ?
      AND id > COALESCE((SELECT last_read_id FROM read_state WHERE convo_id = ? AND email = ?), 0)`)
    .get(convoId, email, convoId, email);'''
assert db.count(uc_old) == 1, "unreadCount-Anker nicht eindeutig"
uc_new = '''  const r: any = db.query(`SELECT COUNT(*) AS n FROM team_messages
    WHERE convo_id = ? AND sender != ? AND deleted_at IS NULL
      AND id > COALESCE((SELECT last_read_id FROM read_state WHERE convo_id = ? AND email = ?), 0)`)
    .get(convoId, email, convoId, email);'''
db = db.replace(uc_old, uc_new)

# LOW-10: Helper, der den serverseitig gespeicherten (monotonen) last_read_id zurückgibt.
assert db.count("export function otherReadId") == 1, "otherReadId-Anker nicht eindeutig"
db = db.replace(
  "export function otherReadId(convoId: string, email: string): number {",
  '''export function readIdFor(convoId: string, email: string): number {
  const r: any = db.query("SELECT last_read_id FROM read_state WHERE convo_id = ? AND email = ?").get(convoId, email);
  return r?.last_read_id ?? 0;
}
export function otherReadId(convoId: string, email: string): number {''')

open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: unreadCount ignoriert Soft-Deletes (LOW-9) + readIdFor-Helper (LOW-10)")

# ============================== server.ts ==============================

# Import des neuen db-Helfers (Anker = readstate-Import-Zeile, existiert 1×)
imp_anchor = 'import { setRead, unreadCount, otherReadId } from "./db.ts";'
assert srv.count(imp_anchor) == 1, "readstate-Import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, 'import { setRead, unreadCount, otherReadId, readIdFor } from "./db.ts";')

# LOW-7 + LOW-10: /read komplett ersetzen (Rate-Limit + monotoner Broadcast-Wert).
read_old = '''  const mRead = path.match(/^\\/api\\/team\\/convos\\/([0-9a-f-]+)\\/read$/);
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
  }'''
assert srv.count(read_old) == 1, "/read-Anker nicht eindeutig"
read_new = '''  const mRead = path.match(/^\\/api\\/team\\/convos\\/([0-9a-f-]+)\\/read$/);
  if (mRead && req.method === "POST") {
    if (!isConvoMember(mRead[1], sess.email)) return json({ error: "not found" }, 404);
    const lim = rateLimit(`team-mut:user:${sess.email}`, 240, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const lastId = typeof parsed.value.last_id === "number" ? Math.trunc(parsed.value.last_id) : 0;
    if (lastId > 0) {
      setRead(mRead[1], sess.email, lastId);
      // Monoton: den GESPEICHERTEN (max) Wert broadcasten, nie ein rohes Zurückspringen.
      teamPublish(mRead[1], "read", { email: sess.email, last_id: readIdFor(mRead[1], sess.email) });
    }
    return json({ ok: true });
  }'''
srv = srv.replace(read_old, read_new)

# LOW-7: Rate-Limit auf /pin /rename /members/add /leave (je nach isConvoMember-Check).
for var in ("mPin", "mRename", "mAddMem", "mLeave"):
    anchor = f'''  if ({var} && req.method === "POST") {{
    if (!isConvoMember({var}[1], sess.email)) return json({{ error: "not found" }}, 404);'''
    assert srv.count(anchor) == 1, f"{var}-Anker nicht eindeutig"
    srv = srv.replace(anchor, anchor + f'''
    const lim{var} = rateLimit(`team-mut:user:${{sess.email}}`, 120, 60 * 1000);
    if (lim{var}) return lim{var};''')

# LOW-8 (Team-Seite): geteilter SSE-Connection-Cap auf den Team-Stream (acquire vor Sub, release im cleanup).
ts_acq_old = '''    if (!isConvoMember(convoId, sess.email)) return json({ error: "not found" }, 404);
    const sinceId = Number(url.searchParams.get("since") || "0") || 0;
    let cleanup = () => {};'''
assert srv.count(ts_acq_old) == 1, "Team-Stream-Acquire-Anker nicht eindeutig"
srv = srv.replace(ts_acq_old, '''    if (!isConvoMember(convoId, sess.email)) return json({ error: "not found" }, 404);
    if (!acquireSse(sess.email)) return json({ error: "too_many_streams" }, 429);
    const sinceId = Number(url.searchParams.get("since") || "0") || 0;
    let cleanup = () => {};''')
ts_rel_old = '''        cleanup = () => { clearInterval(ping); set!.delete(sub); if (set!.size === 0) teamSubs.delete(convoId); };'''
assert srv.count(ts_rel_old) == 1, "Team-Stream-Release-Anker nicht eindeutig"
srv = srv.replace(ts_rel_old, '''        cleanup = () => { clearInterval(ping); set!.delete(sub); if (set!.size === 0) teamSubs.delete(convoId); releaseSse(sess.email); };''')

open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: Rate-Limits /read+/pin+/rename+/members-add+/leave (LOW-7) + Team-Stream-Cap (LOW-8) + monotoner read-Broadcast (LOW-10)")
