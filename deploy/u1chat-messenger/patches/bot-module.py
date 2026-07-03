# bot-module.py — Subunit Messenger Bot-Modul (CONTRACT-messenger.md Abschnitt B) + adversariale Review-Fixes.
# Geteilte Bot-Räume mit Account-ACL (Registry 4 Bots, env-überschreibbar), bot_messages-Schema,
# Routen /api/bots*, In-Memory-Fanout per botId, tmux-Inject mit Idle-Guard + reply_hint,
# /internal/bot-reply GANZ OBEN in handle() (vor Origin-Check/Auth), Reactions scope='bot'.
# Review-Fixes: async-Inject (MEDIUM-3), per-Session-Mutex (MEDIUM-4), Secret-Check-zuerst/Header
# (MEDIUM-5), geteilter SSE-Connection-Cap (LOW-8), <channel>-Escaping im Inject (LOW-11).
# Anwenden NACH allen 6 Wellen (braucht attachReactions/toggleReaction + REACTION_SET).
import sys
srv_p, db_p = sys.argv[1], sys.argv[2]
srv = open(srv_p, encoding="utf-8").read()
db  = open(db_p,  encoding="utf-8").read()

if "bot_messages" in db or "/api/bots" in srv:
    print("ℹ️  Bot-Modul bereits vorhanden — keine Änderung"); sys.exit(0)
if "attachReactions" not in db:
    print("❌ reactions-Welle fehlt — bitte ZUERST anwenden."); sys.exit(1)

# ============================== db.ts ==============================
db += r'''

// --- Subunit Messenger: Bot-Räume (GETEILT mit Account-ACL — nicht owner-scoped) ---
// Ein Raum pro Bot; wer rein darf, entscheidet die ACL in server.ts (Registry).
db.run(`CREATE TABLE IF NOT EXISTS bot_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      TEXT NOT NULL,
  sender      TEXT NOT NULL DEFAULT '',        -- Email des Senders, '' für Bot
  sender_name TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL,                   -- user | bot
  body        TEXT NOT NULL,
  reply_to    INTEGER,
  created_at  INTEGER NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_bot_msg ON bot_messages(bot_id, id)`);

const BOT_MSG_SELECT = `SELECT m.id, m.role, m.sender, m.sender_name, m.body, m.created_at, m.reply_to,
    CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender_name END AS reply_sender,
    CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text
  FROM bot_messages m LEFT JOIN bot_messages r ON r.id = m.reply_to`;

export function addBotMessage(botId: string, sender: string, senderName: string, role: string, body: string, replyTo: number | null = null): any {
  db.run("INSERT INTO bot_messages (bot_id, sender, sender_name, role, body, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [botId, sender, senderName, role, body, replyTo, Date.now()]);
  return db.query(`${BOT_MSG_SELECT} WHERE m.bot_id = ? ORDER BY m.id DESC LIMIT 1`).get(botId);
}
// Letzte `limit` Nachrichten (neueste zuerst holen, dann ASC an den Client — nicht die 300 ältesten).
export function listBotMessages(botId: string, limit = 300): any[] {
  const rows = db.query(`${BOT_MSG_SELECT} WHERE m.bot_id = ? ORDER BY m.id DESC LIMIT ?`).all(botId, limit) as any[];
  return rows.reverse();
}
export function botOwnsMessage(botId: string, msgId: number): boolean {
  return !!db.query("SELECT 1 FROM bot_messages WHERE id = ? AND bot_id = ?").get(msgId, botId);
}
export function lastBotMessage(botId: string): any {
  return db.query("SELECT role, body, created_at FROM bot_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1").get(botId);
}
'''
open(db_p, "w", encoding="utf-8").write(db)
print("✅ db.ts: bot_messages-Schema + addBotMessage/listBotMessages(newest-N)/botOwnsMessage/lastBotMessage")

# ============================== server.ts ==============================

# 1) Import der neuen db-Helfer (Anker = editdelete-Import-Zeile, existiert 1×)
imp_anchor = 'import { editThreadMessage, deleteThreadMessage, editTeamMessage, deleteTeamMessage } from "./db.ts";'
assert srv.count(imp_anchor) == 1, "editdelete-Import-Anker nicht eindeutig"
srv = srv.replace(imp_anchor, imp_anchor + '''
import { addBotMessage, listBotMessages, botOwnsMessage, lastBotMessage } from "./db.ts";''')

# 2) Registry + ACL + Fanout + SSE-Cap + async-Inject + Mutex (Modul-Level, vor decorateConvo)
deco_comment = "// DM/Gruppe aus Sicht des aktuellen Users aufbereiten (Titel, Gegenüber, Presence)."
assert srv.count(deco_comment) == 1, "decorateConvo-Kommentar-Anker nicht eindeutig"
bot_module = r'''// ===== Subunit Messenger: Bots (GETEILTE Räume mit Account-ACL — Telegram-Ersatz) =====
// Registry env-überschreibbar. ACL = kommaseparierte Emails (lowercased). Nicht-ACL → 404
// (kein Existenz-Leak). Privater Bot = Raum mit 1 Mensch, Gruppen-Bot = Telegram-Gruppen-Semantik.
const TJ_EMAILS = "tj@subunit.ai,tom.jedlitschka@subunit.ai,anthropic@subunit.ai";
function botAclEnv(name: string, fallback: string): string[] {
  return csv(process.env[name] || fallback).map((e) => e.toLowerCase());
}
type Bot = { id: string; name: string; session: string; acl: string[] };
const BOTS: Record<string, Bot> = {
  "u1-private": { id: "u1-private", name: "u1", session: process.env.U1_BOT_PRIVATE_SESSION || "unitone",
    acl: botAclEnv("U1_BOT_ACL_PRIVATE", TJ_EMAILS) },
  "u1-group":   { id: "u1-group", name: "u1 · Gruppe", session: process.env.U1_BOT_GROUP_SESSION || "unitone-group",
    acl: botAclEnv("U1_BOT_ACL_GROUP", TJ_EMAILS + ",erik.becker@subunit.ai") },
  "u1-erik":    { id: "u1-erik", name: "u1 · Erik", session: process.env.U1_BOT_ERIK_SESSION || "unitone-erik",
    acl: botAclEnv("U1_BOT_ACL_ERIK", "erik.becker@subunit.ai") },
  "u1-dirk":    { id: "u1-dirk", name: "u1 · Dirk", session: process.env.U1_BOT_DIRK_SESSION || "unitone-dirk",
    acl: botAclEnv("U1_BOT_ACL_DIRK", "dirk.jedlitschka@idolz.com") },
};
const BOT_INGEST_SECRET = process.env.U1_CHAT_BOT_INGEST_SECRET || "";
function botAcl(botId: string): string[] { return BOTS[botId]?.acl ?? []; }
function botFor(botId: string, email: string): Bot | null {
  const b = BOTS[botId];
  return b && botAcl(botId).includes(email) ? b : null;
}
function botOnline(session: string): boolean {
  // has-session ist instant + gebunden (Liste = 4) → spawnSync hier unkritisch (Idle-Poll ist es NICHT, s.u.).
  try { return Bun.spawnSync(["tmux", "has-session", "-t", session]).exitCode === 0; }
  catch { return false; }
}
function botDto(b: Bot): any {
  const last = lastBotMessage(b.id);
  return {
    id: b.id, name: b.name, online: botOnline(b.session), members: b.acl,
    last_text: last ? last.body : null, last_ts: last ? last.created_at : null,
    last_role: last ? last.role : null,
  };
}

// SSE-Fanout pro Bot-Raum (Raum-Key = botId — geteilter Raum, NICHT botId::owner).
type BotSub = (frame: string) => void;
const botSubs = new Map<string, Set<BotSub>>();
function botPublish(botId: string, event: string, data: any) {
  const subs = botSubs.get(botId);
  if (!subs) return;
  const frame = sse(event, data);
  for (const s of subs) { try { s(frame); } catch {} }
}

// Geteilter SSE-Connection-Cap (analog MAX_STREAMS) gegen Verbindungs-Erschöpfung — Team + Bot.
const MAX_SSE_PER_USER = intEnv("U1_CHAT_MAX_SSE_PER_USER", 8);
const MAX_SSE_GLOBAL = intEnv("U1_CHAT_MAX_SSE_GLOBAL", 64);
const sseByUser = new Map<string, number>();
let sseTotal = 0;
function acquireSse(email: string): boolean {
  const n = sseByUser.get(email) || 0;
  if (sseTotal >= MAX_SSE_GLOBAL || n >= MAX_SSE_PER_USER) return false;
  sseTotal += 1; sseByUser.set(email, n + 1);
  return true;
}
function releaseSse(email: string) {
  sseTotal = Math.max(0, sseTotal - 1);
  const n = Math.max(0, (sseByUser.get(email) || 1) - 1);
  if (n) sseByUser.set(email, n); else sseByUser.delete(email);
}

// Idle-Guard: Claude-Code-Pane gilt als idle <=> "bypass permissions" sichtbar UND NICHT
// "esc to interrupt". ASYNC (Bun.spawn, kein spawnSync) → blockiert den Event-Loop NICHT.
async function botPaneIdle(session: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["tmux", "capture-pane", "-p", "-t", session], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.includes("bypass permissions") && !out.includes("esc to interrupt");
  } catch { return false; }
}
// Injizierter Text/Absender werden neutralisiert, damit kein Mitglied ein zweites <channel …>-Tag
// mit fremder user-Attribution einschmuggeln kann (<, >, " → Look-alikes; Steuerzeichen raus).
function sanitizeInject(s: string): string {
  return s.replace(/[\u0000-\u001f]/g, " ").replaceAll("<", "‹").replaceAll(">", "›").replaceAll('"', "ʺ");
}
async function injectBotMessage(bot: Bot, senderName: string, senderEmail: string, body: string): Promise<boolean> {
  const text = sanitizeInject(body.replace(/\s+/g, " ").trim()).slice(0, 8000);
  const who = sanitizeInject(senderName).slice(0, 120);
  const uid = sanitizeInject(senderEmail).slice(0, 200);
  const tag = `<channel source="app" chat_id="app:${bot.id}" user="${who}" user_id="${uid}" ts="${new Date().toISOString()}" reply_hint="tg-send 'app:${bot.id}' '<deine antwort>'">${text}</channel>`;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (await botPaneIdle(bot.session)) {
      try {
        await Bun.spawn(["tmux", "send-keys", "-t", bot.session, "--", tag], { stdout: "ignore", stderr: "ignore" }).exited;
        await Bun.sleep(400);
        await Bun.spawn(["tmux", "send-keys", "-t", bot.session, "Enter"], { stdout: "ignore", stderr: "ignore" }).exited;
        return true;
      } catch { return false; }
    }
    await Bun.sleep(500);
  }
  return false;
}
// Per-tmux-Session serialisieren (Promise-Chain): parallele Injects (TJ+Erik gleichzeitig in u1-group)
// dürfen Tag/Enter NICHT verschränken. Fire-and-forget; Fehler-Publish läuft im Chain-Glied.
const botInjectChain = new Map<string, Promise<void>>();
function enqueueInject(bot: Bot, senderName: string, senderEmail: string, body: string): void {
  const prev = botInjectChain.get(bot.session) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => injectBotMessage(bot, senderName, senderEmail, body))
    .then((ok) => { if (!ok) botPublish(bot.id, "error", { message: `${bot.name} antwortet gerade nicht (beschäftigt/offline) — gleich nochmal.` }); })
    .catch(() => {});
  botInjectChain.set(bot.session, next);
  next.finally(() => { if (botInjectChain.get(bot.session) === next) botInjectChain.delete(bot.session); });
}

'''
srv = srv.replace(deco_comment, bot_module + deco_comment)

# 3) /internal/bot-reply GANZ OBEN in handle() — vor Origin-Check/Auth (Anker = handle-Prolog).
#    MEDIUM-5: Secret ZUERST — fehlt der konfigurierte Secret → fail-closed; Header wird VOR dem
#    Body-Read geprüft (unauth Caller wird abgewiesen ohne Body zu lesen); sonst Body-Secret als
#    erstes Feld, bevor chat_id/text verarbeitet werden. Body-Read strikt limitiert (64KB).
prolog = '''  const url = new URL(req.url);
  const path = url.pathname;
  const ip = clientIp(req);
'''
assert srv.count(prolog) == 1, "handle-Prolog-Anker nicht eindeutig"
ingest = r'''
  // Bot-Ingest (tg-send app:-Branch): secret-authed via safeEqual, MUSS vor Origin/CSRF/Session laufen.
  if (path === "/internal/bot-reply" && req.method === "POST") {
    if (!BOT_INGEST_SECRET) return json({ error: "unauthorized" }, 401);      // fail-closed ohne Secret
    const hdrSecret = req.headers.get("x-bot-ingest-secret");
    if (hdrSecret && !safeEqual(hdrSecret, BOT_INGEST_SECRET)) return json({ error: "unauthorized" }, 401);
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);        // striktes Limit (64KB)
    if (!parsed.ok) return parsed.response;
    if (!hdrSecret && !safeEqual(String(parsed.value.secret || ""), BOT_INGEST_SECRET)) return json({ error: "unauthorized" }, 401);
    const mChat = String(parsed.value.chat_id || "").match(/^app:([a-z0-9-]+)$/);
    const bot = mChat ? BOTS[mChat[1]] : undefined;
    if (!bot) return json({ error: "unknown_chat" }, 404);
    const text = String(parsed.value.text || "").trim();
    if (!text) return json({ error: "empty" }, 400);
    const msg = addBotMessage(bot.id, "", bot.name, "bot", text, null);
    botPublish(bot.id, "message", msg);
    return json({ ok: true });
  }
'''
srv = srv.replace(prolog, prolog + ingest)

# 4) Bot-Routen vor den finalen 404 (nach allen Wellen-Blöcken → REACTION_SET ist deklariert)
tail_anchor = '''  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });'''
assert srv.count(tail_anchor) == 1, "404-Anker nicht eindeutig"
routes = r'''  // ===== Bots (Subunit Messenger: geteilte Räume mit Account-ACL) =====
  if (path === "/api/bots" && req.method === "GET") {
    return json(Object.values(BOTS).filter((b) => b.acl.includes(sess.email)).map(botDto));
  }
  const mBot = path.match(/^\/api\/bots\/([a-z0-9-]+)$/);
  if (mBot && req.method === "GET") {
    const bot = botFor(mBot[1], sess.email);
    if (!bot) return json({ error: "not found" }, 404);
    return json({ bot: botDto(bot), messages: attachReactions("bot", listBotMessages(bot.id), sess.email) });
  }
  const mBotMsg = path.match(/^\/api\/bots\/([a-z0-9-]+)\/message$/);
  if (mBotMsg && req.method === "POST") {
    const bot = botFor(mBotMsg[1], sess.email);
    if (!bot) return json({ error: "not found" }, 404);
    const lim = rateLimit(`bot-msg:user:${sess.email}`, 60, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = String(parsed.value.body || "").trim();
    if (!body) return json({ error: "empty" }, 400);
    if (body.length > 8000) return json({ error: "payload_too_large" }, 413);
    let botReplyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (botOwnsMessage(bot.id, rid)) botReplyTo = rid;
    }
    const senderName = sess.email.split("@")[0];
    const msg = addBotMessage(bot.id, sess.email, senderName, "user", body, botReplyTo);
    // SSE-publish ZUSÄTZLICH zur JSON-Antwort (Client dedupt per id); Inject seriell (per Session) DANACH.
    botPublish(bot.id, "message", msg);
    enqueueInject(bot, senderName, sess.email, body);
    return json(msg);
  }
  const mBotStream = path.match(/^\/api\/bots\/([a-z0-9-]+)\/stream$/);
  if (mBotStream && req.method === "GET") {
    const bot = botFor(mBotStream[1], sess.email);
    if (!bot) return json({ error: "not found" }, 404);
    if (!acquireSse(sess.email)) return json({ error: "too_many_streams" }, 429);
    const sinceId = Number(url.searchParams.get("since") || "0") || 0;
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = (s: string) => { try { controller.enqueue(encoder.encode(s)); } catch {} };
        for (const m of listBotMessages(bot.id)) { if (m.id > sinceId) enc(sse("message", m)); }
        enc(": connected\n\n");
        const sub: BotSub = (frame) => enc(frame);
        let set = botSubs.get(bot.id);
        if (!set) { set = new Set(); botSubs.set(bot.id, set); }
        set.add(sub);
        const ping = setInterval(() => enc(": ping\n\n"), 25_000);
        cleanup = () => { clearInterval(ping); set!.delete(sub); if (set!.size === 0) botSubs.delete(bot.id); releaseSse(sess.email); };
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, {
      headers: securityHeaders({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }),
    });
  }
  const mBotReact = path.match(/^\/api\/bots\/([a-z0-9-]+)\/messages\/([0-9]+)\/react$/);
  if (mBotReact && req.method === "POST") {
    const bot = botFor(mBotReact[1], sess.email);
    if (!bot) return json({ error: "not found" }, 404);
    const msgId = Number(mBotReact[2]);
    if (!botOwnsMessage(bot.id, msgId)) return json({ error: "not found" }, 404);
    const lim = rateLimit(`react:user:${sess.email}`, 300, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const emoji = String(parsed.value.emoji || "");
    if (!REACTION_SET.has(emoji)) return json({ error: "invalid_emoji" }, 400);
    return json({ reactions: toggleReaction("bot", msgId, sess.email, emoji) });
  }

'''
srv = srv.replace(tail_anchor, routes + tail_anchor)
open(srv_p, "w", encoding="utf-8").write(srv)
print("✅ server.ts: Registry+ACL+Fanout+SSE-Cap + async-Inject+Mutex + /internal/bot-reply (secret-first) + 5 Bot-Routen")
