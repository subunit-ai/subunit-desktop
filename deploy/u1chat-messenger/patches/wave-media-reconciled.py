# wave-media-reconciled.py — media-Welle, manuell auf den POST-REPLY-Zustand rekonziliert.
# Original (deploy-backend-media.sh) erwartet den PRISTINE-Zustand von addConvoMessage/
# listConvoMessages/Team-POST — reply hat dieselben Stellen umgeschrieben. Ergebnis hier:
#   - addConvoMessage(convoId, sender, body, replyTo, attachmentsJson) — BEIDE Erweiterungen
#   - listConvoMessages liefert attachments UND reply_*-Felder + edited/deleted
#   - Team-POST akzeptiert body + attachments + reply_to (leerer Body mit Anhang erlaubt)
# Der additive Rest (Tabellen/Helper/mediaContentType//api/media/:id) ist unverändert
# aus dem Original übernommen.
import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "getAttachmentById" in db or "/api/media/" in srv:
    print("ℹ️  Media/Anhänge bereits vorhanden — keine Änderung"); sys.exit(0)
if "reply_to" not in db:
    print("❌ reply-Migration fehlt — dieser Patch erwartet den post-reply-Zustand."); sys.exit(1)

# ============================== db.ts ==============================
# 1) listConvoMessages (post-reply-Form): attachments-Spalte mitlesen + parsen
lcm_old = '''export function listConvoMessages(id: string, limit = 300): any[] {
  return db.query(`SELECT m.id, m.sender,
      CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.body END AS body,
      m.created_at, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id ASC LIMIT ?`).all(id, limit) as any[];
}'''
lcm_new = '''export function listConvoMessages(id: string, limit = 300): any[] {
  // Die NEUESTEN `limit` holen (DESC LIMIT), dann ASC an den Client — bei >limit nicht die ältesten.
  const rows = db.query(`SELECT * FROM (
      SELECT m.id, m.sender,
        CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.body END AS body,
        m.attachments, m.created_at, m.reply_to,
        CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
        CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
        (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
      FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
      WHERE m.convo_id = ? ORDER BY m.id DESC LIMIT ?
    ) ORDER BY id ASC`).all(id, limit) as any[];
  return rows.map((r) => { try { r.attachments = r.attachments ? JSON.parse(r.attachments) : []; } catch { r.attachments = []; } return r; });
}'''
assert db.count(lcm_old) == 1, "listConvoMessages-Anker (post-reply) nicht eindeutig"
db = db.replace(lcm_old, lcm_new)

# 2) addConvoMessage (post-reply-Form): attachmentsJson-Param + last_text-Preview, replyTo bleibt
acm_old = '''export function addConvoMessage(convoId: string, sender: string, body: string, replyTo: number | null = null): any {
  const t = Date.now();
  db.run("INSERT INTO team_messages (convo_id, sender, body, created_at, reply_to) VALUES (?, ?, ?, ?, ?)", [convoId, sender, body, t, replyTo]);
  db.run("UPDATE team_convos SET updated_at = ?, last_text = ?, last_sender = ? WHERE id = ?", [t, body.slice(0, 200), sender, convoId]);
  return db.query(`SELECT m.id, m.sender, m.body, m.created_at, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      0 AS edited, 0 AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id DESC LIMIT 1`).get(convoId);
}'''
acm_new = '''export function addConvoMessage(convoId: string, sender: string, body: string, replyTo: number | null = null, attachmentsJson = ""): any {
  const t = Date.now();
  db.run("INSERT INTO team_messages (convo_id, sender, body, attachments, created_at, reply_to) VALUES (?, ?, ?, ?, ?, ?)",
    [convoId, sender, body, attachmentsJson || "", t, replyTo]);
  let atts: any[] = [];
  try { atts = attachmentsJson ? JSON.parse(attachmentsJson) : []; } catch {}
  const preview = body || attachmentPreview(atts);
  db.run("UPDATE team_convos SET updated_at = ?, last_text = ?, last_sender = ? WHERE id = ?", [t, preview.slice(0, 200), sender, convoId]);
  const row: any = db.query(`SELECT m.id, m.sender, m.body, m.created_at, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      0 AS edited, 0 AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id DESC LIMIT 1`).get(convoId);
  if (row) row.attachments = atts;
  return row;
}'''
assert db.count(acm_old) == 1, "addConvoMessage-Anker (post-reply) nicht eindeutig"
db = db.replace(acm_old, acm_new)

# 3) Neue Tabellen + Helper ans Ende (verbatim aus deploy-backend-media.sh)
db += r'''

// --- Subunit iOS: Medien-Serving + Team-Anhang-Verknüpfung (Zugriffskontrolle) ---
const tmCols = db.query("PRAGMA table_info(team_messages)").all() as any[];
if (!tmCols.some((c: any) => c.name === "attachments")) {
  db.run("ALTER TABLE team_messages ADD COLUMN attachments TEXT NOT NULL DEFAULT ''");
}
db.run(`CREATE TABLE IF NOT EXISTS team_msg_attachments (
  attachment_id TEXT NOT NULL,
  convo_id      TEXT NOT NULL,
  PRIMARY KEY (attachment_id, convo_id)
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tma_att ON team_msg_attachments(attachment_id)`);

export function getAttachmentById(id: string): any {
  return db.query("SELECT * FROM attachments WHERE id = ?").get(id);
}
export function linkAttachment(attachmentId: string, convoId: string) {
  db.run("INSERT OR IGNORE INTO team_msg_attachments (attachment_id, convo_id) VALUES (?, ?)", [attachmentId, convoId]);
}
export function mediaSharedWithMember(attachmentId: string, email: string): boolean {
  return !!db.query(`SELECT 1 FROM team_msg_attachments tma
    JOIN team_convo_members m ON m.convo_id = tma.convo_id
    WHERE tma.attachment_id = ? AND m.email = ? LIMIT 1`).get(attachmentId, email);
}
function attachmentPreview(atts: any[]): string {
  if (!atts || !atts.length) return "";
  const a = atts[0];
  return a.kind === "audio" ? "🎤 Sprachnachricht" : a.kind === "image" ? "📷 Foto" : "📎 " + (a.name || "Datei");
}
'''
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts (media, rekonziliert): attachments-Spalte + link-Tabelle + Helper + addConvoMessage/listConvoMessages")

# ============================== server.ts ==============================
# 1) Imports für die neuen Helper (Anker unverändert aus dem Original-Script)
imp_anchor = '''import {
  upsertTeamUser, setTeamUserName, listTeamUsers, getTeamUser,
  findDmConvo, createConvo, getConvo, convoMembers, isConvoMember,
  listConvosForUser, listConvoMessages, addConvoMessage,
} from "./db.ts";'''
assert srv.count(imp_anchor) == 1, "team-import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { getAttachmentById, linkAttachment, mediaSharedWithMember } from "./db.ts";''')

# 2) mediaContentType-Helper vor handle() (verbatim aus dem Original-Script)
handle_anchor = "async function handle(req: Request): Promise<Response> {"
assert srv.count(handle_anchor) == 1, "handle-Anker nicht eindeutig"
srv = srv.replace(handle_anchor, r'''// Content-Type fürs Medien-Serving aus Dateiendung/kind.
function mediaContentType(att: any): string {
  const ext = (String(att.name || "").match(/\.([A-Za-z0-9]+)$/)?.[1] || "").toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", aac: "audio/aac", ogg: "audio/ogg", pdf: "application/pdf",
  };
  if (map[ext]) return map[ext];
  if (att.kind === "audio") return "audio/mp4";
  return "application/octet-stream";
}

''' + handle_anchor)

# 3) Team-Message-POST (post-reply-Form): Anhänge zulassen + reply_to beibehalten
msg_old = '''    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = String(parsed.value.body || "").trim();
    if (!body) return json({ error: "empty" }, 400);
    if (body.length > MAX_MESSAGE_CHARS) return json({ error: "payload_too_large" }, 413);
    let teamReplyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (convoOwnsMessage(mConvoMsg[1], rid)) teamReplyTo = rid;
    }
    const msg = addConvoMessage(mConvoMsg[1], sess.email, body, teamReplyTo);
    teamPublish(mConvoMsg[1], "message", msg);
    return json(msg);'''
msg_new = r'''    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = String(parsed.value.body || "").trim();
    // Anhänge: NUR eigene (owner = sender) zulassen, Metadaten sanitisieren, an die Convo binden (Zugriffskontrolle).
    const rawAtts = Array.isArray(parsed.value.attachments) ? parsed.value.attachments : [];
    // Dedupe der ids VOR der Kappung (nicht nur die DB-Query kappen → keine Doppel-Anhänge).
    const reqIds = [...new Set(rawAtts.map((a: any) => String(a && a.id || "")).filter(Boolean))].slice(0, 10);
    const owned = reqIds.length ? getAttachmentsByIds(reqIds, sess.email) : [];
    const ownedSet = new Set(owned.map((a: any) => a.id));
    const KINDS = new Set(["image", "audio", "file"]);
    const atts = reqIds
      .filter((id: string) => ownedSet.has(id))
      .map((id: string) => {
        const a: any = rawAtts.find((x: any) => x && String(x.id) === id) || {};
        const o: any = { id, kind: KINDS.has(String(a.kind)) ? String(a.kind) : "file", name: String(a.name || "Datei").slice(0, 200) };
        if (Number(a.duration) > 0) o.duration = Number(a.duration);
        return o;
      });
    if (!body && atts.length === 0) return json({ error: "empty" }, 400);
    if (body.length > MAX_MESSAGE_CHARS) return json({ error: "payload_too_large" }, 413);
    let teamReplyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (convoOwnsMessage(mConvoMsg[1], rid)) teamReplyTo = rid;
    }
    for (const a of atts) linkAttachment(a.id, mConvoMsg[1]);
    const msg = addConvoMessage(mConvoMsg[1], sess.email, body, teamReplyTo, atts.length ? JSON.stringify(atts) : "");
    teamPublish(mConvoMsg[1], "message", msg);
    return json(msg);'''
assert srv.count(msg_old) == 1, "team-message-handler-Anker (post-reply) nicht eindeutig"
srv = srv.replace(msg_old, msg_new)

# 4) GET /api/media/:id vor den finalen 404 (verbatim aus dem Original-Script)
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
media_route = r'''  // --- Medien-Serving: Bytes NUR an Owner ODER Convo-Mitglied ---
  const mMedia = path.match(/^\/api\/media\/([0-9a-fA-F-]+)$/);
  if (mMedia && req.method === "GET") {
    const att = getAttachmentById(mMedia[1]);
    if (!att) return json({ error: "not found" }, 404);
    const allowed = att.owner === sess.email || mediaSharedWithMember(mMedia[1], sess.email);
    if (!allowed) return json({ error: "forbidden" }, 403);
    try {
      const file = Bun.file(att.path);
      if (!(await file.exists())) return json({ error: "gone" }, 404);
      return new Response(file, {
        headers: securityHeaders({ "content-type": mediaContentType(att), "cache-control": "private, max-age=86400" }),
      });
    } catch (e) {
      console.error("media_read_failed", redactLog(e));
      return json({ error: "read_failed" }, 500);
    }
  }

'''
srv = srv.replace(tail_anchor, media_route + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts (media, rekonziliert): media-Import + mediaContentType + Anhang+Reply-Message-Handler + /api/media/:id")
