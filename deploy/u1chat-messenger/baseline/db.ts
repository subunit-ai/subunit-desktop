// db.ts — SQLite Thread-/Message-Store für u1 Chat.
// Threads = die Chats. id IST die Claude-Session-UUID (1:1 Mapping zur jsonl).
// "Nie löschen" → status: active | closed (closed = archiviert, jederzeit reopenbar).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const DATA_DIR = new URL("./data/", import.meta.url).pathname;
mkdirSync(DATA_DIR, { recursive: true });
const LEGACY_THREAD_OWNER = (process.env.U1_CHAT_LEGACY_OWNER || "legacy@subunit.ai").trim().toLowerCase();

function sqlString(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

export const db = new Database(DATA_DIR + "u1chat.db", { create: true });
db.run("PRAGMA journal_mode = WAL");

db.run(`CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,           -- = claude session-id (uuid)
  owner       TEXT NOT NULL DEFAULT ${sqlString(LEGACY_THREAD_OWNER)},
  title       TEXT NOT NULL DEFAULT 'Neuer Chat',
  color       TEXT NOT NULL DEFAULT '#64748b',
  category    TEXT NOT NULL DEFAULT 'misc',
  model       TEXT NOT NULL DEFAULT 'sonnet',
  status      TEXT NOT NULL DEFAULT 'active',  -- active | closed
  titled      INTEGER NOT NULL DEFAULT 0,      -- 1 = Auto-Titel schon vergeben
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`);

const threadColumns = db.query("PRAGMA table_info(threads)").all() as any[];
if (!threadColumns.some((col) => col.name === "owner")) {
  db.run(`ALTER TABLE threads ADD COLUMN owner TEXT NOT NULL DEFAULT ${sqlString(LEGACY_THREAD_OWNER)}`);
}

db.run(`CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id   TEXT NOT NULL,
  role        TEXT NOT NULL,              -- user | assistant
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id)
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_msg_thread ON messages(thread_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_threads_owner_updated ON threads(owner, updated_at)`);

const now = () => Date.now();

export function createThread(id: string, owner: string, model = "sonnet") {
  const t = now();
  db.run(
    "INSERT INTO threads (id, owner, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    [id, owner, model, t, t],
  );
  return getThread(id, owner);
}

export function getThread(id: string, owner: string): any {
  return db.query("SELECT * FROM threads WHERE id = ? AND owner = ?").get(id, owner);
}

export function listThreads(owner: string): any[] {
  // aktive zuerst, dann nach letzter Aktivität
  return db
    .query(
      "SELECT * FROM threads WHERE owner = ? ORDER BY (status='active') DESC, updated_at DESC",
    )
    .all(owner);
}

export function getMessages(threadId: string, owner: string): any[] {
  return db
    .query(`SELECT m.id, m.role,
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
      ORDER BY m.id ASC`)
    .all(threadId, owner);
}

export function countMessages(threadId: string, owner: string): number {
  const r: any = db
    .query(`SELECT COUNT(*) AS n
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.thread_id = ? AND t.owner = ?`)
    .get(threadId, owner);
  return r?.n ?? 0;
}

export function addMessage(threadId: string, owner: string, role: string, content: string, replyTo: number | null = null) {
  const t = now();
  db.run(
    `INSERT INTO messages (thread_id, role, content, created_at, reply_to)
      SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM threads WHERE id = ? AND owner = ?)`,
    [threadId, role, content, t, replyTo, threadId, owner],
  );
  db.run("UPDATE threads SET updated_at = ? WHERE id = ? AND owner = ?", [t, threadId, owner]);
}

const META_COLUMNS = new Set(["title", "color", "category", "titled", "status", "model"]);

export function setThreadMeta(
  id: string,
  owner: string,
  fields: Partial<{ title: string; color: string; category: string; titled: number; status: string; model: string }>,
) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  for (const [key] of entries) {
    if (!META_COLUMNS.has(key)) throw new Error(`invalid thread meta field: ${key}`);
  }
  const keys = entries.map(([key]) => key);
  const set = keys.map((k) => `${k} = ?`).join(", ");
  const vals = entries.map(([, value]) => value);
  db.run(`UPDATE threads SET ${set}, updated_at = ? WHERE id = ? AND owner = ?`, [...vals, now(), id, owner]);
}


// --- Subunit iOS: Anhänge (Foto/Datei/Audio) ---
db.run(`CREATE TABLE IF NOT EXISTS attachments (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  thread_id   TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL,
  bytes       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments(owner)`);

export function addAttachment(id: string, owner: string, kind: string, name: string, path: string, bytes: number) {
  db.run("INSERT INTO attachments (id, owner, kind, name, path, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, owner, kind, name, path, bytes, Date.now()]);
}
export function getAttachmentsByIds(ids: string[], owner: string): any[] {
  if (!ids.length) return [];
  const ph = ids.map(() => "?").join(",");
  return db.query(`SELECT * FROM attachments WHERE owner = ? AND id IN (${ph})`).all(owner, ...ids) as any[];
}


// --- Subunit iOS: Aufgaben (Home-Dashboard, owner-scoped) ---
db.run(`CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  title       TEXT NOT NULL,
  project     TEXT NOT NULL DEFAULT '',
  priority    TEXT NOT NULL DEFAULT 'mittel',   -- hoch | mittel | niedrig
  done        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner, done, updated_at)`);

export function listTasks(owner: string): any[] {
  return db.query(`SELECT id, title, project, priority, done, created_at, updated_at
    FROM tasks WHERE owner = ?
    ORDER BY done ASC, (priority='hoch') DESC, (priority='mittel') DESC, updated_at DESC`).all(owner) as any[];
}
export function getTask(id: string, owner: string): any {
  return db.query("SELECT id, title, project, priority, done, created_at, updated_at FROM tasks WHERE id = ? AND owner = ?").get(id, owner);
}
export function createTask(id: string, owner: string, title: string, project: string, priority: string) {
  const t = Date.now();
  db.run("INSERT INTO tasks (id, owner, title, project, priority, done, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
    [id, owner, title, project, priority, t, t]);
  return getTask(id, owner);
}
export function toggleTask(id: string, owner: string): any {
  db.run("UPDATE tasks SET done = 1 - done, updated_at = ? WHERE id = ? AND owner = ?", [Date.now(), id, owner]);
  return getTask(id, owner);
}
export function deleteTask(id: string, owner: string) {
  db.run("DELETE FROM tasks WHERE id = ? AND owner = ?", [id, owner]);
}

// --- Subunit iOS: Team-Messaging (Mensch↔Mensch im Workspace) ---
db.run(`CREATE TABLE IF NOT EXISTS team_users (
  email       TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  avatar      TEXT NOT NULL DEFAULT '',
  op          INTEGER NOT NULL DEFAULT 0,
  last_seen   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS team_convos (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL DEFAULT 'dm',
  title       TEXT NOT NULL DEFAULT '',
  dm_key      TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  last_text   TEXT NOT NULL DEFAULT '',
  last_sender TEXT NOT NULL DEFAULT ''
)`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_convo_dmkey ON team_convos(dm_key) WHERE dm_key <> ''`);
db.run(`CREATE TABLE IF NOT EXISTS team_convo_members (
  convo_id    TEXT NOT NULL,
  email       TEXT NOT NULL,
  PRIMARY KEY (convo_id, email)
)`);
db.run(`CREATE TABLE IF NOT EXISTS team_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  convo_id    TEXT NOT NULL,
  sender      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_team_msg_convo ON team_messages(convo_id, id)`);

export function upsertTeamUser(email: string, op: boolean, name?: string) {
  const t = Date.now();
  const display = name && name.trim() ? name.trim() : email.split("@")[0];
  db.run(`INSERT INTO team_users (email, name, op, last_seen, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET last_seen = excluded.last_seen, op = excluded.op`,
    [email, display, op ? 1 : 0, t, t]);
}
export function setTeamUserName(email: string, name: string) {
  db.run("UPDATE team_users SET name = ? WHERE email = ?", [name, email]);
}
export function listTeamUsers(): any[] {
  return db.query("SELECT email, name, avatar, op, last_seen FROM team_users ORDER BY name ASC").all() as any[];
}
export function getTeamUser(email: string): any {
  return db.query("SELECT email, name, avatar, op, last_seen FROM team_users WHERE email = ?").get(email);
}
export function findDmConvo(dmKey: string): any {
  return db.query("SELECT * FROM team_convos WHERE dm_key = ?").get(dmKey);
}
export function createConvo(id: string, kind: string, title: string, dmKey: string, createdBy: string, members: string[]) {
  const t = Date.now();
  db.run("INSERT INTO team_convos (id, kind, title, dm_key, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [id, kind, title, dmKey, createdBy, t, t]);
  for (const m of members) {
    db.run("INSERT OR IGNORE INTO team_convo_members (convo_id, email) VALUES (?, ?)", [id, m]);
  }
  return getConvo(id);
}
export function getConvo(id: string): any {
  return db.query("SELECT * FROM team_convos WHERE id = ?").get(id);
}
export function convoMembers(id: string): string[] {
  return (db.query("SELECT email FROM team_convo_members WHERE convo_id = ?").all(id) as any[]).map((r) => r.email);
}
export function isConvoMember(id: string, email: string): boolean {
  return !!db.query("SELECT 1 FROM team_convo_members WHERE convo_id = ? AND email = ?").get(id, email);
}
export function listConvosForUser(email: string): any[] {
  return db.query(`SELECT c.* FROM team_convos c
    JOIN team_convo_members m ON m.convo_id = c.id
    WHERE m.email = ? ORDER BY c.updated_at DESC`).all(email) as any[];
}
export function listConvoMessages(id: string, limit = 300): any[] {
  const rows = db.query(`SELECT m.id, m.sender,
      CASE WHEN m.deleted_at IS NOT NULL THEN '' ELSE m.body END AS body,
      m.created_at, m.attachments, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      (m.edited_at IS NOT NULL) AS edited, (m.deleted_at IS NOT NULL) AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id ASC LIMIT ?`).all(id, limit) as any[];
  return rows.map((r) => { try { r.attachments = (r.deleted || !r.attachments) ? [] : JSON.parse(r.attachments); } catch { r.attachments = []; } return r; });
}
export function addConvoMessage(convoId: string, sender: string, body: string, replyTo: number | null = null, attachmentsJson = ""): any {
  const t = Date.now();
  db.run("INSERT INTO team_messages (convo_id, sender, body, created_at, reply_to, attachments) VALUES (?, ?, ?, ?, ?, ?)", [convoId, sender, body, t, replyTo, attachmentsJson || ""]);
  let atts: any[] = [];
  try { atts = attachmentsJson ? JSON.parse(attachmentsJson) : []; } catch {}
  const preview = body || attachmentPreview(atts);
  db.run("UPDATE team_convos SET updated_at = ?, last_text = ?, last_sender = ? WHERE id = ?", [t, preview.slice(0, 200), sender, convoId]);
  const row: any = db.query(`SELECT m.id, m.sender, m.body, m.created_at, m.attachments, m.reply_to,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE r.sender END AS reply_sender,
      CASE WHEN m.reply_to IS NULL THEN NULL ELSE substr(r.body, 1, 120) END AS reply_text,
      0 AS edited, 0 AS deleted
    FROM team_messages m LEFT JOIN team_messages r ON r.id = m.reply_to
    WHERE m.convo_id = ? ORDER BY m.id DESC LIMIT 1`).get(convoId);
  if (row) row.attachments = atts;
  return row;
}


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
  return db.query("SELECT role, sender, body, created_at FROM bot_messages WHERE bot_id = ? ORDER BY id DESC LIMIT 1").get(botId);
}
