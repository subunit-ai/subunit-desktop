import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "editThreadMessage" not in db:
    print("❌ reply-Migration fehlt — bitte ZUERST deploy-backend-reply.sh ausführen."); sys.exit(1)
if "Edit / Delete eigener Nachrichten" in srv:
    print("ℹ️  Edit/Delete bereits vorhanden — keine Änderung"); sys.exit(0)

# 1) Import der db-Helfer (Anker = von reactions hinzugefügte Import-Zeile, existiert 1×)
imp_anchor = 'import { attachReactions, toggleReaction, threadOwnsMessage, convoOwnsMessage } from "./db.ts";'
assert srv.count(imp_anchor) == 1, "reactions-Import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { editThreadMessage, deleteThreadMessage, editTeamMessage, deleteTeamMessage } from "./db.ts";''')

# 2) Routen vor den finalen 404
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
routes = r'''  // ===== Edit / Delete eigener Nachrichten (Telegram-Parität Slice 3) =====
  const mThreadEdit = path.match(/^\/api\/threads\/([0-9a-f-]+)\/messages\/([0-9]+)\/edit$/);
  if (mThreadEdit && req.method === "POST") {
    const t = getThread(mThreadEdit[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const content = String(parsed.value.content || "").trim();
    if (!content) return json({ error: "empty" }, 400);
    if (content.length > MAX_MESSAGE_CHARS) return json({ error: "payload_too_large" }, 413);
    return json({ ok: editThreadMessage(mThreadEdit[1], Number(mThreadEdit[2]), content) });
  }
  const mThreadDel = path.match(/^\/api\/threads\/([0-9a-f-]+)\/messages\/([0-9]+)\/delete$/);
  if (mThreadDel && req.method === "POST") {
    const t = getThread(mThreadDel[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    return json({ ok: deleteThreadMessage(mThreadDel[1], Number(mThreadDel[2])) });
  }
  const mTeamEdit = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/messages\/([0-9]+)\/edit$/);
  if (mTeamEdit && req.method === "POST") {
    if (!isConvoMember(mTeamEdit[1], sess.email)) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = String(parsed.value.body || "").trim();
    if (!body) return json({ error: "empty" }, 400);
    if (body.length > MAX_MESSAGE_CHARS) return json({ error: "payload_too_large" }, 413);
    return json({ ok: editTeamMessage(mTeamEdit[1], Number(mTeamEdit[2]), sess.email, body) });
  }
  const mTeamDel = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/messages\/([0-9]+)\/delete$/);
  if (mTeamDel && req.method === "POST") {
    if (!isConvoMember(mTeamDel[1], sess.email)) return json({ error: "not found" }, 404);
    return json({ ok: deleteTeamMessage(mTeamDel[1], Number(mTeamDel[2]), sess.email) });
  }

'''
srv = srv.replace(tail_anchor, routes + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: 4 Edit/Delete-Routen (Thread + Team)")
