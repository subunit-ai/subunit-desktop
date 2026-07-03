// email.ts — Postfach für u1-chat: Inbound-Store (bun:sqlite, zero-dep) + List/Read/Flag + Send (Resend).
// Pre-auth: POST /api/email/inbound (X-Inbound-Secret, von n8n S-03). Post-auth (sess): messages/send/flags.
import { Database } from "bun:sqlite";

const DB_PATH = process.env.U1_EMAIL_DB || new URL("./email.sqlite", import.meta.url).pathname;
const db = new Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY, folder TEXT NOT NULL DEFAULT 'inbox',
  from_addr TEXT, from_name TEXT, to_addr TEXT, subject TEXT, body TEXT,
  ts INTEGER NOT NULL, unread INTEGER NOT NULL DEFAULT 1, starred INTEGER NOT NULL DEFAULT 0
)`);

const INBOUND_SECRET = process.env.U1_EMAIL_INBOUND_SECRET || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.U1_EMAIL_FROM || "Unit One <u1@subunit.ai>";
const J = (d: any, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const uid = () => crypto.randomUUID();

function mapRow(r: any) {
  return { id: r.id, folder: r.folder, from: r.from_addr, fromName: r.from_name, to: r.to_addr, subject: r.subject, body: r.body, preview: String(r.body || "").replace(/\s+/g, " ").slice(0, 120), date: fmtDate(r.ts), unread: !!r.unread, starred: !!r.starred };
}
function fmtDate(ts: number) {
  const d = new Date(ts); const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

export async function emailInbound(req: Request): Promise<Response> {
  if (!INBOUND_SECRET || req.headers.get("x-inbound-secret") !== INBOUND_SECRET) return J({ error: "forbidden" }, 403);
  let b: any; try { b = await req.json(); } catch { return J({ error: "bad json" }, 400); }
  const from = String(b.from || b.fromAddress || "");
  const fromAddr = (from.match(/<([^>]+)>/) || [])[1] || from;
  const fromName = String(b.fromName || (from.split("<")[0] || "").trim() || fromAddr);
  db.run(`INSERT OR IGNORE INTO emails (id,folder,from_addr,from_name,to_addr,subject,body,ts,unread,starred) VALUES (?,?,?,?,?,?,?,?,1,0)`,
    [uid(), "inbox", fromAddr, fromName, String(b.to || "u1@subunit.ai"), String(b.subject || "(kein Betreff)"), String(b.text || b.body || ""), Date.now()]);
  return J({ ok: true });
}

export async function emailRoutes(req: Request, path: string, _sess: { email: string }): Promise<Response | null> {
  const m = req.method;
  if (path === "/api/email/folders" && m === "GET") {
    const c = (f: string) => (db.query(`SELECT COUNT(*) c FROM emails WHERE folder=?`).get(f) as any).c;
    return J({ folders: [
      { id: "inbox", count: c("inbox"), unread: (db.query(`SELECT COUNT(*) c FROM emails WHERE folder='inbox' AND unread=1`).get() as any).c },
      { id: "starred", count: (db.query(`SELECT COUNT(*) c FROM emails WHERE starred=1`).get() as any).c },
      { id: "sent", count: c("sent") }, { id: "archive", count: c("archive") },
    ] });
  }
  if (path === "/api/email/messages" && m === "GET") {
    const folder = new URL(req.url).searchParams.get("folder") || "inbox";
    const rows = folder === "starred"
      ? db.query(`SELECT * FROM emails WHERE starred=1 ORDER BY ts DESC LIMIT 200`).all()
      : db.query(`SELECT * FROM emails WHERE folder=? ORDER BY ts DESC LIMIT 200`).all(folder);
    return J({ messages: (rows as any[]).map(mapRow) });
  }
  const mId = path.match(/^\/api\/email\/messages\/([a-f0-9-]+)$/);
  if (mId && m === "GET") {
    const r = db.query(`SELECT * FROM emails WHERE id=?`).get(mId[1]) as any;
    if (!r) return J({ error: "not found" }, 404);
    db.run(`UPDATE emails SET unread=0 WHERE id=?`, [mId[1]]);
    return J({ message: mapRow({ ...r, unread: 0 }) });
  }
  const mAct = path.match(/^\/api\/email\/messages\/([a-f0-9-]+)\/(read|star|archive)$/);
  if (mAct && m === "POST") {
    const id = mAct[1], act = mAct[2];
    if (act === "read") db.run(`UPDATE emails SET unread=0 WHERE id=?`, [id]);
    else if (act === "star") db.run(`UPDATE emails SET starred=CASE WHEN starred=1 THEN 0 ELSE 1 END WHERE id=?`, [id]);
    else db.run(`UPDATE emails SET folder='archive' WHERE id=?`, [id]);
    return J({ ok: true });
  }
  if (path === "/api/email/send" && m === "POST") {
    let b: any; try { b = await req.json(); } catch { return J({ error: "bad json" }, 400); }
    const to = String(b.to || "").trim(); if (!to) return J({ error: "to required" }, 400);
    if (!RESEND_KEY) return J({ error: "RESEND_API_KEY fehlt" }, 500);
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${RESEND_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ from: FROM, to, subject: String(b.subject || ""), text: String(b.body || "") }) });
    if (!r.ok) return J({ error: `resend ${r.status}` }, 502);
    db.run(`INSERT INTO emails (id,folder,from_addr,from_name,to_addr,subject,body,ts,unread,starred) VALUES (?,?,?,?,?,?,?,?,0,0)`,
      [uid(), "sent", "u1@subunit.ai", "Unit One", to, String(b.subject || ""), String(b.body || ""), Date.now()]);
    return J({ ok: true });
  }
  return null;
}
