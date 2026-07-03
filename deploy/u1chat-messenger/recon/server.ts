// server.ts — u1 Chat Backend (natives Bun.serve, null externe Deps).
// Exponiert via Cloudflare-Tunnel: chat.subunit.ai → localhost:3000.
// Auth: Login via auth.subunit.ai (nur verifizierte @subunit.ai-Accounts),
// danach eigene signierte Session (HttpOnly-Cookie). Ohne U1_CHAT_SECRET startet der Server NICHT.
import { randomBytes, randomUUID, createHmac, timingSafeEqual, webcrypto } from "node:crypto";
import {
  createThread, getThread, listThreads, getMessages, countMessages,
  addMessage, setThreadMeta, addAttachment, getAttachmentsByIds,
} from "./db.ts";
import { attachReactions, toggleReaction, threadOwnsMessage, convoOwnsMessage } from "./db.ts";
import { editThreadMessage, deleteThreadMessage, editTeamMessage, deleteTeamMessage } from "./db.ts";
import { addBotMessage, listBotMessages, botOwnsMessage, lastBotMessage } from "./db.ts";
import { listTasks, getTask, createTask, toggleTask, deleteTask } from "./db.ts";
import {
  upsertTeamUser, setTeamUserName, listTeamUsers, getTeamUser,
  findDmConvo, createConvo, getConvo, convoMembers, isConvoMember,
  listConvosForUser, listConvoMessages, addConvoMessage,
} from "./db.ts";
import { setPin, renameConvo, addConvoMember, removeConvoMember, getTeamMessageBrief } from "./db.ts";
import { getAttachmentById, linkAttachment, mediaSharedWithMember } from "./db.ts";
import { setRead, unreadCount, otherReadId } from "./db.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { streamClaude, classify } from "./claude.ts";
import { emailInbound, emailRoutes } from "./email.ts";

const PORT = Number(process.env.PORT || "3000");
const PUBLIC = new URL("./public/", import.meta.url).pathname;
// SPS-Register (Home-Projekte). Override via U1_CHAT_PROJECTS_JSON.
const PROJECTS_JSON = process.env.U1_CHAT_PROJECTS_JSON || new URL("../../config/projects.json", import.meta.url).pathname;
const encoder = new TextEncoder();

// --- Auth: delegiert an auth.subunit.ai, danach eigene signierte Session ---
const SECRET = process.env.U1_CHAT_SECRET || "";
if (!SECRET) {
  console.error("✋ u1 Chat startet NICHT: U1_CHAT_SECRET muss gesetzt sein (.env) — sonst keine sichere Session.");
  process.exit(1);
}
const AUTH_URL = process.env.AUTH_URL || "http://localhost:7841";
const AUTH_JWKS_URL = process.env.AUTH_JWKS_URL || "https://auth.subunit.ai/.well-known/jwks.json";
const AUTH_ISSUER = process.env.AUTH_ISSUER || "https://auth.subunit.ai";
const AUTH_AUDIENCES = csv(process.env.AUTH_AUDIENCE || "first-party");
const ALLOWED_DOMAIN = (process.env.U1_CHAT_DOMAIN || "subunit.ai").toLowerCase();
// Zentrales Web-SSO (Redirect-Flow über auth.subunit.ai/sso). AUTH_PUBLIC_URL ist
// die Browser-erreichbare URL (Redirect-Ziel), AUTH_URL bleibt der lokale Server-Call.
const AUTH_PUBLIC_URL = (process.env.AUTH_PUBLIC_URL || "https://auth.subunit.ai").replace(/\/$/, "");
const APP_SLUG = process.env.U1_CHAT_APP_SLUG || "u1-chat";
const CHAT_PUBLIC_URL = (process.env.U1_CHAT_PUBLIC_URL || "https://chat.subunit.ai").replace(/\/$/, "");
const SSO_REDIRECT_URI = CHAT_PUBLIC_URL + "/api/auth/callback";
const STATE_COOKIE = "u1_oauth_state";
const COOKIE = "u1sess";
const LOGIN_CSRF_COOKIE = "u1login_csrf";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage
const JWT_CLOCK_SKEW_SEC = 60;

const configuredModels = csv(process.env.U1_CHAT_ALLOWED_MODELS || "sonnet,opus");
const ALLOWED_MODELS = new Set(configuredModels.length ? configuredModels : ["sonnet", "opus"]);
const configuredDefaultModel = String(process.env.U1_CHAT_DEFAULT_MODEL || "sonnet").trim();
const DEFAULT_MODEL = ALLOWED_MODELS.has(configuredDefaultModel)
  ? configuredDefaultModel
  : (ALLOWED_MODELS.has("sonnet") ? "sonnet" : String(ALLOWED_MODELS.values().next().value));

const MAX_LOGIN_BODY_BYTES = intEnv("U1_CHAT_MAX_LOGIN_BODY_BYTES", 4096);
const MAX_THREAD_BODY_BYTES = intEnv("U1_CHAT_MAX_THREAD_BODY_BYTES", 2048);
const MAX_MESSAGE_BODY_BYTES = intEnv("U1_CHAT_MAX_MESSAGE_BODY_BYTES", 64 * 1024);
const MAX_MESSAGE_CHARS = intEnv("U1_CHAT_MAX_MESSAGE_CHARS", 20_000);
const MAX_STREAMS_PER_USER = intEnv("U1_CHAT_MAX_STREAMS_PER_USER", 1);
const MAX_STREAMS_GLOBAL = intEnv("U1_CHAT_MAX_STREAMS_GLOBAL", 4);

const LOGIN_IP_LIMIT = intEnv("U1_CHAT_LOGIN_IP_LIMIT", 12);
const LOGIN_USER_LIMIT = intEnv("U1_CHAT_LOGIN_USER_LIMIT", 8);
const THREAD_CREATE_IP_LIMIT = intEnv("U1_CHAT_THREAD_CREATE_IP_LIMIT", 30);
const THREAD_CREATE_USER_LIMIT = intEnv("U1_CHAT_THREAD_CREATE_USER_LIMIT", 20);
const MESSAGE_IP_LIMIT = intEnv("U1_CHAT_MESSAGE_IP_LIMIT", 60);
const MESSAGE_USER_LIMIT = intEnv("U1_CHAT_MESSAGE_USER_LIMIT", 40);
const LOGIN_WINDOW_MS = intEnv("U1_CHAT_LOGIN_WINDOW_MS", 15 * 60 * 1000);
const THREAD_CREATE_WINDOW_MS = intEnv("U1_CHAT_THREAD_CREATE_WINDOW_MS", 60 * 60 * 1000);
const MESSAGE_WINDOW_MS = intEnv("U1_CHAT_MESSAGE_WINDOW_MS", 60 * 60 * 1000);

const DEFAULT_ALLOWED_ORIGINS = [
  "https://chat.subunit.ai",
  `http://localhost:${PORT || 3000}`,
  `http://127.0.0.1:${PORT || 3000}`,
];
const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...csv(process.env.U1_CHAT_ALLOWED_ORIGINS || "")]);
const ALLOWED_HOSTS = new Set([
  "chat.subunit.ai",
  "localhost",
  "127.0.0.1",
  "::1",
  ...csv(process.env.U1_CHAT_ALLOWED_HOSTS || ""),
  ...[...ALLOWED_ORIGINS].map((origin) => {
    try { return new URL(origin).hostname.toLowerCase(); }
    catch { return ""; }
  }).filter(Boolean),
]);

const b64url = (s: string) => Buffer.from(s).toString("base64url");
const macOf = (payload: string) => createHmac("sha256", SECRET).update(payload).digest("hex");
const csrfOf = (sessionToken: string) => createHmac("sha256", SECRET).update("csrf:" + sessionToken).digest("base64url");

function csv(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter(Boolean);
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeEqual(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Session-Cookie: base64url(JSON{email,exp}).hmac — manipulationssicher + ablaufend.
function makeSession(email: string, op: boolean): string {
  const payload = b64url(JSON.stringify({ email, op, exp: Date.now() + TTL_MS }));
  return `${payload}.${macOf(payload)}`;
}
function readSession(tok: string | undefined): { email: string; op?: boolean; exp: number } | null {
  if (!tok) return null;
  const dot = tok.lastIndexOf(".");
  if (dot < 0) return null;
  const payload = tok.slice(0, dot), mac = tok.slice(dot + 1);
  const expect = macOf(payload);
  if (!safeEqual(mac, expect)) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!obj.exp || Date.now() > obj.exp || typeof obj.email !== "string") return null;
    return { email: obj.email.toLowerCase(), op: obj.op === true, exp: obj.exp };
  } catch { return null; }
}

function cookieVal(req: Request, name: string): string | undefined {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : undefined;
}
const setCookie = (val: string, maxAge: number) =>
  `${COOKIE}=${val}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const setLoginCsrfCookie = (val: string, maxAge: number) =>
  `${LOGIN_CSRF_COOKIE}=${val}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const setStateCookie = (val: string, maxAge: number) =>
  `${STATE_COOKIE}=${val}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

function makeLoginCsrf(): string {
  const nonce = randomBytes(16).toString("base64url");
  return `${nonce}.${createHmac("sha256", SECRET).update("login-csrf:" + nonce).digest("base64url")}`;
}

function validLoginCsrf(token: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const nonce = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", SECRET).update("login-csrf:" + nonce).digest("base64url");
  return safeEqual(mac, expected);
}

function contentSecurityPolicy(nonce?: string): string {
  const scriptSrc = ["'self'", "https://cdn.jsdelivr.net"];
  const styleSrc = ["'self'"];
  if (nonce) {
    scriptSrc.push(`'nonce-${nonce}'`);
    styleSrc.push(`'nonce-${nonce}'`);
  }
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    `style-src ${styleSrc.join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function securityHeaders(extra: Record<string, string> = {}, nonce?: string): Headers {
  const headers = new Headers(extra);
  headers.set("content-security-policy", contentSecurityPolicy(nonce));
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("cross-origin-opener-policy", "same-origin");
  return headers;
}

async function html(file: "index.html" | "login.html"): Promise<Response> {
  const nonce = randomBytes(16).toString("base64");
  const loginCsrf = file === "login.html" ? makeLoginCsrf() : "";
  const body = (await Bun.file(PUBLIC + file).text())
    .replaceAll("__CSP_NONCE__", nonce)
    .replaceAll("__LOGIN_CSRF__", loginCsrf);
  const headers = securityHeaders({ "content-type": "text/html; charset=utf-8" }, nonce);
  if (loginCsrf) headers.append("set-cookie", setLoginCsrfCookie(loginCsrf, 10 * 60));
  return new Response(body, {
    headers,
  });
}

const json = (data: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ "content-type": "application/json", ...extra }),
  });

const sse = (event: string, data: any) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function redactLog(value: unknown): string {
  const raw = value instanceof Error ? (value.stack || value.message) : String(value);
  return raw
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g, "[redacted-jwt]")
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN\s*=\s*)["']?[^"'\s]+/g, "$1[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted-token]")
    .slice(0, 2000);
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (req.headers.get("cf-connecting-ip")
    || req.headers.get("x-real-ip")
    || (fwd ? fwd.split(",")[0] : "")
    || "unknown").trim();
}

type JsonRead = { ok: true; value: any } | { ok: false; response: Response };
async function readJsonLimited(req: Request, maxBytes: number): Promise<JsonRead> {
  const len = Number(req.headers.get("content-length") || "0");
  if (Number.isFinite(len) && len > maxBytes) {
    return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  }
  const text = await req.text();
  if (encoder.encode(text).length > maxBytes) {
    return { ok: false, response: json({ error: "payload_too_large" }, 413) };
  }
  if (!text.trim()) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(text) }; }
  catch { return { ok: false, response: json({ error: "invalid_json" }, 400) }; }
}

function hostnameFromHost(host: string | null): string {
  if (!host) return "";
  try { return new URL("http://" + host).hostname.toLowerCase(); }
  catch { return ""; }
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function validateOriginHost(req: Request): Response | null {
  const host = req.headers.get("host");
  const hostname = hostnameFromHost(host);
  if (!hostname || !ALLOWED_HOSTS.has(hostname)) return json({ error: "bad_host" }, 403);

  const origin = req.headers.get("origin");
  if (!origin) return json({ error: "bad_origin" }, 403);
  if (ALLOWED_ORIGINS.has(origin)) return null;

  try {
    const o = new URL(origin);
    if (host && o.host === host && (o.protocol === "https:" || (o.protocol === "http:" && isLocalHost(o.hostname)))) {
      return null;
    }
  } catch {}
  return json({ error: "bad_origin" }, 403);
}

function validateCsrf(req: Request, sessionToken: string): Response | null {
  const token = req.headers.get("x-csrf-token") || "";
  const expected = csrfOf(sessionToken);
  if (!safeEqual(token, expected)) return json({ error: "csrf_failed" }, 403);
  return null;
}

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
function rateLimit(key: string, limit: number, windowMs: number): Response | null {
  const now = Date.now();
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count <= limit) return null;
  const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return json({ error: "rate_limited" }, 429, { "retry-after": String(retry) });
}

type LoginBackoff = { failures: number; lockUntil: number };
const loginBackoff = new Map<string, LoginBackoff>();
function loginBackoffKey(ip: string, email: string): string {
  return `${ip}:${email}`;
}
function loginLocked(key: string): Response | null {
  const b = loginBackoff.get(key);
  if (!b || b.lockUntil <= Date.now()) return null;
  const retry = Math.max(1, Math.ceil((b.lockUntil - Date.now()) / 1000));
  return json({ error: "rate_limited", message: "Zu viele Login-Versuche. Bitte später erneut versuchen." }, 429, { "retry-after": String(retry) });
}
function recordLoginFailure(key: string) {
  const old = loginBackoff.get(key);
  const failures = (old?.failures || 0) + 1;
  const lockMs = failures >= 5 ? Math.min(15 * 60 * 1000, 30_000 * 2 ** Math.min(failures - 5, 5)) : 0;
  loginBackoff.set(key, { failures, lockUntil: lockMs ? Date.now() + lockMs : 0 });
}
function clearLoginFailure(key: string) {
  loginBackoff.delete(key);
}

let jwksCache: { keys: any[]; expiresAt: number } | null = null;
async function jwksKeys(): Promise<any[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  const res = await fetch(AUTH_JWKS_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const data = await res.json().catch(() => ({} as any));
  const keys = Array.isArray(data.keys) ? data.keys : [];
  jwksCache = { keys, expiresAt: Date.now() + 5 * 60 * 1000 };
  return keys;
}

function decodeJwtJson(part: string): any | null {
  try { return JSON.parse(Buffer.from(part, "base64url").toString("utf8")); }
  catch { return null; }
}

function audienceMatches(aud: unknown): boolean {
  if (typeof aud === "string") return AUTH_AUDIENCES.includes(aud);
  if (Array.isArray(aud)) return aud.some((item) => typeof item === "string" && AUTH_AUDIENCES.includes(item));
  return false;
}

async function verifiedJwtClaims(token: string): Promise<any | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const header = decodeJwtJson(parts[0]);
  const claims = decodeJwtJson(parts[1]);
  if (!header || !claims || header.alg !== "RS256") return null;

  const keys = await jwksKeys();
  const jwk = keys.find((key) => key.kty === "RSA" && (!header.kid || key.kid === header.kid));
  if (!jwk) return null;

  const key = await webcrypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    Buffer.from(parts[2], "base64url"),
    encoder.encode(parts[0] + "." + parts[1]),
  );
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== AUTH_ISSUER) return null;
  if (!audienceMatches(claims.aud)) return null;
  if (typeof claims.exp !== "number" || claims.exp <= now - JWT_CLOCK_SKEW_SEC) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now + JWT_CLOCK_SKEW_SEC) return null;
  return claims;
}

function validModel(raw: unknown, fallback = DEFAULT_MODEL): string | null {
  const model = raw == null || raw === "" ? fallback : String(raw);
  return ALLOWED_MODELS.has(model) ? model : null;
}

const activeStreamsByUser = new Map<string, number>();
let activeStreams = 0;
function acquireStream(email: string): Response | null {
  const byUser = activeStreamsByUser.get(email) || 0;
  if (activeStreams >= MAX_STREAMS_GLOBAL || byUser >= MAX_STREAMS_PER_USER) {
    return json({ error: "too_many_streams" }, 429);
  }
  activeStreams += 1;
  activeStreamsByUser.set(email, byUser + 1);
  return null;
}
function releaseStream(email: string) {
  activeStreams = Math.max(0, activeStreams - 1);
  const byUser = Math.max(0, (activeStreamsByUser.get(email) || 1) - 1);
  if (byUser) activeStreamsByUser.set(email, byUser);
  else activeStreamsByUser.delete(email);
}

// Login gegen auth.subunit.ai — nur verifizierte @subunit.ai-Accounts dürfen rein.
async function authLogin(email: string, password: string):
  Promise<{ ok: true; email: string; op: boolean } | { ok: false; status: number; error: string }> {
  let r: Response;
  try {
    r = await fetch(AUTH_URL + "/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, client_id: "u1-chat", device_label: "u1-chat-web" }),
    });
  } catch {
    return { ok: false, status: 502, error: "auth_unreachable" };
  }
  if (!r.ok) {
    return { ok: false, status: 401, error: r.status === 403 ? "email_not_verified" : "invalid_credentials" };
  }
  const data = await r.json().catch(() => ({} as any));
  let claims: any | null;
  try {
    claims = await verifiedJwtClaims(String(data.access_token || ""));
  } catch (e) {
    console.error("auth_jwks_verify_failed", redactLog(e));
    return { ok: false, status: 502, error: "auth_unreachable" };
  }
  if (!claims) return { ok: false, status: 401, error: "invalid_credentials" };
  const claimedEmail = String(claims.email || "").toLowerCase();
  if (claimedEmail !== email || !claims.email_verified || !claimedEmail.endsWith("@" + ALLOWED_DOMAIN)) {
    return { ok: false, status: 403, error: "not_allowed" };
  }
  return { ok: true, email: claimedEmail, op: claims.op === true };
}

// --- Team-Messaging: in-memory SSE-Fanout pro Konversation (keine externe Dep) ---
type TeamSub = (frame: string) => void;
const teamSubs = new Map<string, Set<TeamSub>>();
// Presence-Write-Debounce: max. 1 DB-Write/30s pro User (kein WAL-Strom auf der geteilten Connection).
const presenceSeen = new Map<string, number>();
function teamPublish(convoId: string, event: string, data: any) {
  const subs = teamSubs.get(convoId);
  if (!subs) return;
  const frame = sse(event, data);
  for (const s of subs) { try { s(frame); } catch {} }
}

// ===== Subunit Messenger: Bots (GETEILTE Räume mit Account-ACL — Telegram-Ersatz) =====
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
    last_role: last ? last.role : null, last_sender: last ? last.sender : null,
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

// DM/Gruppe aus Sicht des aktuellen Users aufbereiten (Titel, Gegenüber, Presence).
function decorateConvo(c: any, me: string): any {
  const members = convoMembers(c.id);
  let title = c.title;
  let other = "", otherName = "", otherSeen = 0;
  if (c.kind === "dm") {
    other = members.find((m: string) => m !== me) || me;
    const u = getTeamUser(other);
    otherName = (u && u.name) || other.split("@")[0];
    otherSeen = (u && u.last_seen) || 0;
    title = otherName;
  }
  return {
    id: c.id, kind: c.kind, title, other, other_name: otherName, other_seen: otherSeen,
    members, last_text: c.last_text, last_sender: c.last_sender, updated_at: c.updated_at,
    pinned_msg_id: c.pinned_msg_id || null,
    pinned_text: c.pinned_msg_id ? (getTeamMessageBrief(c.id, c.pinned_msg_id)?.body ?? null) : null,
    pinned_sender: c.pinned_msg_id ? (getTeamMessageBrief(c.id, c.pinned_msg_id)?.sender?.split("@")[0] ?? null) : null,
    unread: unreadCount(c.id, me), other_read: otherReadId(c.id, me),
  };
}

// Home-Projekte: archived/done ausblenden, nach Aktivität ranken.
const PROJECT_STATUS_RANK: Record<string, number> = {
  active: 0, live: 1, maintained: 2, plan: 3, incubating: 4,
};
function projectRank(status: string): number {
  return status in PROJECT_STATUS_RANK ? PROJECT_STATUS_RANK[status] : 9;
}

// Content-Type fürs Medien-Serving aus Dateiendung/kind.
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

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const ip = clientIp(req);

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

  // E-Mail-Inbound (n8n S-03): secret-authed, MUST run before the origin/CSRF guard (no Bearer/Origin).
  if (path === "/api/email/inbound" && req.method === "POST") return emailInbound(req);

  // Origin/Host-Check schuetzt ambiente Cookie-Auth (Browser). Native Clients (Subunit iOS)
  // authentisieren per Bearer-JWT (nicht ambient) und senden keinen Origin -> fuer sie ueberspringen.
  const isBearerReq = (req.headers.get("authorization") || "").startsWith("Bearer ");
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !isBearerReq) {
    const badOrigin = validateOriginHost(req);
    if (badOrigin) return badOrigin;
  }

  // --- Auth: zentrales Web-SSO (auth.subunit.ai/sso) ---
  // Startet den Flow: state-Cookie + Redirect zur zentralen Login-Seite.
  if (path === "/api/auth/login" && req.method === "GET") {
    const state = randomBytes(24).toString("base64url");
    const u = new URL(AUTH_PUBLIC_URL + "/sso/authorize");
    u.searchParams.set("app", APP_SLUG);
    u.searchParams.set("redirect_uri", SSO_REDIRECT_URI);
    u.searchParams.set("state", state);
    const headers = securityHeaders({ location: u.toString() });
    headers.append("set-cookie", setStateCookie(state, 600));
    return new Response(null, { status: 302, headers });
  }

  // Rücksprung von auth.subunit.ai: code→token→Session.
  if (path === "/api/auth/callback" && req.method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const stateCookie = cookieVal(req, STATE_COOKIE) || "";
    const failRedirect = (reason: string) => {
      const headers = securityHeaders({ location: "/?auth_error=" + encodeURIComponent(reason) });
      headers.append("set-cookie", setStateCookie("", 0));
      return new Response(null, { status: 302, headers });
    };
    if (!code || !state || !stateCookie || !safeEqual(state, stateCookie)) return failRedirect("state");

    let data: any;
    try {
      const r = await fetch(AUTH_URL + "/sso/token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, app: APP_SLUG, redirect_uri: SSO_REDIRECT_URI }),
      });
      if (!r.ok) return failRedirect("exchange");
      data = await r.json();
    } catch {
      return failRedirect("unreachable");
    }

    let claims: any | null;
    try { claims = await verifiedJwtClaims(String(data.access_token || "")); }
    catch { return failRedirect("verify"); }
    if (!claims) return failRedirect("verify");

    const email = String(claims.email || "").toLowerCase();
    if (!claims.email_verified || !email.endsWith("@" + ALLOWED_DOMAIN)) return failRedirect("domain");

    const sessionToken = makeSession(email, claims.op === true);
    const headers = securityHeaders({ location: "/" });
    headers.append("set-cookie", setCookie(sessionToken, Math.floor(TTL_MS / 1000)));
    headers.append("set-cookie", setStateCookie("", 0));
    return new Response(null, { status: 302, headers });
  }

  // --- Auth: Cookie-Session (Browser) ODER Bearer-JWT (native Clients: Subunit iOS) ---
  // Der Bearer-Token ist exakt der auth.subunit.ai-JWT, den der Web-Callback oben schon via
  // verifiedJwtClaims prueft -- nur per Header praesentiert statt via code->token-Exchange.
  const sessionToken = cookieVal(req, COOKIE);
  let sess = readSession(sessionToken);
  let bearerAuth = false;
  if (!sess && isBearerReq) {
    let claims: any | null = null;
    try { claims = await verifiedJwtClaims((req.headers.get("authorization") || "").slice(7).trim()); }
    catch { claims = null; }
    const bemail = String(claims?.email || "").toLowerCase();
    if (claims && claims.email_verified && bemail.endsWith("@" + ALLOWED_DOMAIN)) {
      sess = { email: bemail, op: claims.op === true, exp: (Number(claims.exp) || 0) * 1000 };
      bearerAuth = true;
    }
  }
  if (!sess) {
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      if (url.searchParams.get("auth_error")) return html("login.html");
      return new Response(null, { status: 302, headers: securityHeaders({ location: "/api/auth/login" }) });
    }
    return json({ error: "unauthorized" }, 401);
  }
  // CSRF nur fuer Cookie-POSTs (Bearer ist nicht ambient -> kein CSRF noetig).
  if (req.method === "POST" && !bearerAuth) {
    const badCsrf = validateCsrf(req, sessionToken || "");
    if (badCsrf) return badCsrf;
  }

  // Team-Presence: online halten + Directory befüllen — gedrosselt auf max. 1 DB-Write/30s pro User
  // (die geteilte Connection bedient auch den Claude-Stream; kein Write-on-every-request).
  const _pt = Date.now();
  if (_pt - (presenceSeen.get(sess.email) || 0) > 30_000) {
    presenceSeen.set(sess.email, _pt);
    try { upsertTeamUser(sess.email, sess.op === true); } catch {}
  }

  if (path === "/api/logout" && req.method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: securityHeaders({ "content-type": "application/json", "set-cookie": setCookie("", 0) }),
    });
  }
  if (path === "/api/me" && req.method === "GET") {
    return json({ email: sess.email, op: sess.op === true, csrf: csrfOf(sessionToken) });
  }

  // --- statische Files ---
  if (req.method === "GET" && (path === "/" || path === "/index.html")) return html("index.html");

  // --- API ---
  if (path.startsWith("/api/threads") && sess.op !== true) {
    return json({ error: "forbidden" }, 403);
  }

  if (path === "/api/threads" && req.method === "GET") {
    return json(listThreads(sess.email));
  }

  if (path === "/api/threads" && req.method === "POST") {
    const limitedIp = rateLimit(`thread-create:ip:${ip}`, THREAD_CREATE_IP_LIMIT, THREAD_CREATE_WINDOW_MS);
    if (limitedIp) return limitedIp;
    const limitedUser = rateLimit(`thread-create:user:${sess.email}`, THREAD_CREATE_USER_LIMIT, THREAD_CREATE_WINDOW_MS);
    if (limitedUser) return limitedUser;

    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const model = validModel(parsed.value.model);
    if (!model) return json({ error: "invalid_model" }, 400);
    const id = randomUUID();
    const t = createThread(id, sess.email, model);
    return json(t);
  }

  const mThread = path.match(/^\/api\/threads\/([0-9a-f-]+)$/);
  if (mThread && req.method === "GET") {
    const t = getThread(mThread[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    return json({ thread: t, messages: attachReactions("thread", getMessages(mThread[1], sess.email), sess.email) });
  }

  const mClose = path.match(/^\/api\/threads\/([0-9a-f-]+)\/(close|reopen)$/);
  if (mClose && req.method === "POST") {
    const t = getThread(mClose[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    setThreadMeta(mClose[1], sess.email, { status: mClose[2] === "close" ? "closed" : "active" });
    return json(getThread(mClose[1], sess.email));
  }

  // --- Nachricht senden → SSE-Stream ---
  const mMsg = path.match(/^\/api\/threads\/([0-9a-f-]+)\/message$/);
  if (mMsg && req.method === "POST") {
    const limitedIp = rateLimit(`message:ip:${ip}`, MESSAGE_IP_LIMIT, MESSAGE_WINDOW_MS);
    if (limitedIp) return limitedIp;
    const limitedUser = rateLimit(`message:user:${sess.email}`, MESSAGE_USER_LIMIT, MESSAGE_WINDOW_MS);
    if (limitedUser) return limitedUser;

    const threadId = mMsg[1];
    const t = getThread(threadId, sess.email);
    if (!t) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const content = String(parsed.value.content || "").trim();
    if (!content) return json({ error: "empty" }, 400);
    if (content.length > MAX_MESSAGE_CHARS || encoder.encode(content).length > MAX_MESSAGE_BODY_BYTES) {
      return json({ error: "payload_too_large" }, 413);
    }

    const currentModel = validModel(t.model, DEFAULT_MODEL) || DEFAULT_MODEL;
    const model = validModel(parsed.value.model, currentModel);
    if (!model) return json({ error: "invalid_model" }, 400);
    if (model !== t.model) setThreadMeta(threadId, sess.email, { model });

    const streamLimit = acquireStream(sess.email);
    if (streamLimit) return streamLimit;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseStream(sess.email);
    };

    const isFirst = countMessages(threadId, sess.email) === 0;
    let replyTo: number | null = null;
    if (typeof parsed.value.reply_to === "number" && Number.isFinite(parsed.value.reply_to)) {
      const rid = Math.trunc(parsed.value.reply_to);
      if (threadOwnsMessage(threadId, rid)) replyTo = rid;
    }
    addMessage(threadId, sess.email, "user", content, replyTo);

    // Anhänge (Subunit iOS): absolute Pfade als Manifest vor den Prompt — u1 liest sie mit seinen Tools.
    const attIds = Array.isArray(parsed.value.attachment_ids) ? parsed.value.attachment_ids.map(String) : [];
    const atts = attIds.length ? getAttachmentsByIds(attIds, sess.email) : [];
    const manifest = atts.map((a: any) => `[Anhang ${a.kind}: ${a.path}]`).join("\n");
    const promptForClaude = manifest ? manifest + "\n\n" + content : content;
    const VALID_EFFORT = new Set(["low", "medium", "high", "max"]);
    const effort = VALID_EFFORT.has(String(parsed.value.effort)) ? String(parsed.value.effort) : "";

    const stream = new ReadableStream({
      async start(controller) {
        const enc = (s: string) => controller.enqueue(encoder.encode(s));
        try {
          let full = "";
          for await (const ev of streamClaude(threadId, promptForClaude, isFirst, model, effort)) {
            if (ev.kind === "delta") {
              full += ev.text;
              enc(sse("delta", { text: ev.text }));
            } else if (ev.kind === "ratelimit") {
              enc(sse("ratelimit", ev.info));
            } else if (ev.kind === "done") {
              full = ev.text || full;
              enc(sse("done", { cost: ev.cost, error: ev.error }));
            } else if (ev.kind === "error") {
              enc(sse("error", { message: ev.message }));
            }
          }
          if (full.trim()) addMessage(threadId, sess.email, "assistant", full);

          // Selbst-organisierend: nach dem ersten Austausch Titel + Farbe ziehen.
          if (isFirst && !t.titled) {
            try {
              const meta = await classify(content);
              setThreadMeta(threadId, sess.email, { ...meta, titled: 1 });
              enc(sse("meta", meta));
            } catch (e) {
              console.error("classify_failed", redactLog(e));
            }
          }
        } catch (e) {
          console.error("stream_failed", redactLog(e));
          enc(sse("error", { message: "Die Antwort konnte nicht erzeugt werden." }));
        } finally {
          release();
          controller.close();
        }
      },
      cancel() {
        release();
      },
    });

    return new Response(stream, {
      headers: securityHeaders({
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      }),
    });
  }

  // --- Slash-Command (server-seitig, nie als LLM-Content) ---
  const mCmd = path.match(/^\/api\/threads\/([0-9a-f-]+)\/command$/);
  if (mCmd && req.method === "POST") {
    const t = getThread(mCmd[1], sess.email);
    if (!t) return json({ error: "not found" }, 404);
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const command = String(parsed.value.command || "");
    const arg = parsed.value.arg != null ? String(parsed.value.arg) : undefined;
    if (command === "model") {
      const model = validModel(arg);
      if (!model) return json({ error: "invalid_model" }, 400);
      setThreadMeta(mCmd[1], sess.email, { model });
      return json({ ok: true, effect: `Modell → ${model}` });
    }
    // compact/cost/context: an die CC-Session durchreichen (Verhalten am Gerät verifizieren).
    if (["compact", "cost", "context"].includes(command)) {
      return json({ ok: true, effect: `/${command} an die Session gesendet` });
    }
    return json({ error: "unknown_command" }, 400);
  }

  // --- Medien-Upload (multipart) — Ablage absolut, u1 liest per Pfad ---
  if (path === "/api/uploads" && req.method === "POST") {
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: "bad_form" }, 400); }
    const file = form.get("file");
    const kind = String(form.get("kind") || "file");
    if (!(file instanceof File)) return json({ error: "no_file" }, 400);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length > 25 * 1024 * 1024) return json({ error: "payload_too_large" }, 413);
    const id = randomUUID();
    const safeOwner = sess.email.replace(/[^a-z0-9@._-]/gi, "_");
    const dir = resolvePath(process.env.AGENT_WORKDIR || join(PUBLIC, "..", "agent-workspace"), "uploads", safeOwner);
    mkdirSync(dir, { recursive: true });
    const ext = (file.name.match(/\.[A-Za-z0-9]+$/)?.[0] || "");
    const filePath = join(dir, id + ext);
    writeFileSync(filePath, bytes);
    addAttachment(id, sess.email, kind, file.name || (id + ext), filePath, bytes.length);
    return json({ id, kind, name: file.name || (id + ext) });
  }

  // ===== HOME: Projekte (read-only, aus dem SPS-Register) =====
  if (path === "/api/projects" && req.method === "GET") {
    try {
      const raw: any = await Bun.file(PROJECTS_JSON).json();
      const out = Object.entries(raw.projects || {})
        .map(([slug, p]: [string, any]) => ({
          slug,
          name: slug,
          vision: String(p.vision || ""),
          status: String(p.status || ""),
          version: String(p.version || ""),
          url: String(p.url || ""),
        }))
        .filter((p) => p.status !== "archived" && p.status !== "done")
        .sort((a, b) => projectRank(a.status) - projectRank(b.status) || a.name.localeCompare(b.name));
      return json(out);
    } catch (e) {
      console.error("projects_read_failed", redactLog(e));
      return json([]);
    }
  }

  // ===== HOME: Aufgaben (owner-scoped CRUD) =====
  if (path === "/api/tasks" && req.method === "GET") {
    return json(listTasks(sess.email));
  }
  if (path === "/api/tasks" && req.method === "POST") {
    const lim = rateLimit(`task-create:user:${sess.email}`, 120, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const title = String(parsed.value.title || "").trim().slice(0, 280);
    if (!title) return json({ error: "empty" }, 400);
    const project = String(parsed.value.project || "").trim().slice(0, 80);
    const PRIOS = new Set(["hoch", "mittel", "niedrig"]);
    const priority = PRIOS.has(String(parsed.value.priority)) ? String(parsed.value.priority) : "mittel";
    return json(createTask(randomUUID(), sess.email, title, project, priority));
  }
  const mTaskToggle = path.match(/^\/api\/tasks\/([0-9a-f-]+)\/toggle$/);
  if (mTaskToggle && req.method === "POST") {
    const updated = toggleTask(mTaskToggle[1], sess.email);
    if (!updated) return json({ error: "not found" }, 404);
    return json(updated);
  }
  const mTask = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/);
  if (mTask && req.method === "DELETE") {
    if (!getTask(mTask[1], sess.email)) return json({ error: "not found" }, 404);
    deleteTask(mTask[1], sess.email);
    return json({ ok: true });
  }

  // ===== TEAM: Messaging (Mensch↔Mensch, NICHT op-gated, aber auth-pflichtig) =====
  if (path === "/api/team/users" && req.method === "GET") {
    return json(listTeamUsers().filter((u: any) => u.email !== sess.email));
  }
  if (path === "/api/team/presence" && req.method === "POST") {
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (parsed.ok && typeof parsed.value.name === "string" && parsed.value.name.trim()) {
      setTeamUserName(sess.email, parsed.value.name.trim().slice(0, 80));
    }
    return json({ ok: true });
  }
  if (path === "/api/team/convos" && req.method === "GET") {
    return json(listConvosForUser(sess.email).map((c: any) => decorateConvo(c, sess.email)));
  }
  if (path === "/api/team/convos" && req.method === "POST") {
    const lim = rateLimit(`convo-create:user:${sess.email}`, 60, 60 * 1000);
    if (lim) return lim;
    const parsed = await readJsonLimited(req, MAX_THREAD_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const target = String(parsed.value.email || "").toLowerCase().trim();
    if (target) {
      if (!target.endsWith("@" + ALLOWED_DOMAIN) || target === sess.email) return json({ error: "invalid_target" }, 400);
      const dmKey = [sess.email, target].sort().join("|");
      let convo = findDmConvo(dmKey);
      if (!convo) convo = createConvo(randomUUID(), "dm", "", dmKey, sess.email, [sess.email, target]);
      return json(decorateConvo(convo, sess.email));
    }
    const groupTitle = String(parsed.value.title || "").trim().slice(0, 80);
    const raw = Array.isArray(parsed.value.members) ? parsed.value.members.map((m: any) => String(m).toLowerCase().trim()) : [];
    const members = Array.from(new Set([sess.email, ...raw.filter((m: string) => m.endsWith("@" + ALLOWED_DOMAIN))]));
    if (members.length < 2) return json({ error: "need_members" }, 400);
    const convo = createConvo(randomUUID(), "group", groupTitle || "Gruppe", "", sess.email, members);
    return json(decorateConvo(convo, sess.email));
  }
  const mConvo = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)$/);
  if (mConvo && req.method === "GET") {
    if (!isConvoMember(mConvo[1], sess.email)) return json({ error: "not found" }, 404);
    return json({ convo: decorateConvo(getConvo(mConvo[1]), sess.email), messages: attachReactions("team", listConvoMessages(mConvo[1]), sess.email) });
  }
  const mConvoMsg = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/message$/);
  if (mConvoMsg && req.method === "POST") {
    if (!isConvoMember(mConvoMsg[1], sess.email)) return json({ error: "not found" }, 404);
    const limIp = rateLimit(`team-msg:ip:${ip}`, 240, 60 * 1000);
    if (limIp) return limIp;
    const limited = rateLimit(`team-msg:user:${sess.email}`, 180, 60 * 1000);
    if (limited) return limited;
    const parsed = await readJsonLimited(req, MAX_MESSAGE_BODY_BYTES);
    if (!parsed.ok) return parsed.response;
    const body = String(parsed.value.body || "").trim();
    // Anhänge: NUR eigene (owner = sender) zulassen, Metadaten sanitisieren, an die Convo binden (Zugriffskontrolle).
    const rawAtts = Array.isArray(parsed.value.attachments) ? parsed.value.attachments : [];
    const reqIds = rawAtts.map((a: any) => String(a && a.id || "")).filter(Boolean).slice(0, 10);
    const owned = reqIds.length ? getAttachmentsByIds(reqIds, sess.email) : [];
    const ownedSet = new Set(owned.map((a: any) => a.id));
    const KINDS = new Set(["image", "audio", "file"]);
    const atts = rawAtts
      .filter((a: any) => a && ownedSet.has(String(a.id)))
      .map((a: any) => {
        const o: any = { id: String(a.id), kind: KINDS.has(String(a.kind)) ? String(a.kind) : "file", name: String(a.name || "Datei").slice(0, 200) };
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
    return json(msg);
  }
  const mConvoStream = path.match(/^\/api\/team\/convos\/([0-9a-f-]+)\/stream$/);
  if (mConvoStream && req.method === "GET") {
    const convoId = mConvoStream[1];
    if (!isConvoMember(convoId, sess.email)) return json({ error: "not found" }, 404);
    const sinceId = Number(url.searchParams.get("since") || "0") || 0;
    let cleanup = () => {};
    const stream = new ReadableStream({
      start(controller) {
        const enc = (s: string) => { try { controller.enqueue(encoder.encode(s)); } catch {} };
        for (const m of listConvoMessages(convoId)) { if (m.id > sinceId) enc(sse("message", m)); }
        enc(": connected\n\n");
        const sub: TeamSub = (frame) => enc(frame);
        let set = teamSubs.get(convoId);
        if (!set) { set = new Set(); teamSubs.set(convoId, set); }
        set.add(sub);
        const ping = setInterval(() => enc(": ping\n\n"), 25_000);
        cleanup = () => { clearInterval(ping); set!.delete(sub); if (set!.size === 0) teamSubs.delete(convoId); };
      },
      cancel() { cleanup(); },
    });
    return new Response(stream, {
      headers: securityHeaders({ "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }),
    });
  }

  if (path.startsWith("/api/email/")) { if (sess.op !== true) return json({ error: "forbidden" }, 403); const _er = await emailRoutes(req, path, sess); if (_er) return _er; }
  // ===== Reaktionen (Telegram-Parität Slice 1) =====
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

  // ===== Edit / Delete eigener Nachrichten (Telegram-Parität Slice 3) =====
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

  // ===== Read-State + Typing (Telegram-Parität Slice 4) =====
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

  // --- Medien-Serving: Bytes NUR an Owner ODER Convo-Mitglied ---
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

  // ===== Pins + Gruppen-Verwaltung (Telegram-Parität Slice 5) =====
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

  // ===== Bots (Subunit Messenger: geteilte Räume mit Account-ACL) =====
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

  return new Response("not found", { status: 404, headers: securityHeaders({ "content-type": "text/plain; charset=utf-8" }) });
}

const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 0, // lange Streams nicht abwürgen
  async fetch(req) {
    try {
      return await handle(req);
    } catch (e) {
      console.error("request_failed", redactLog(e));
      return json({ error: "internal_error" }, 500);
    }
  },
});

console.log(`🔷 u1 Chat läuft auf http://127.0.0.1:${server.port}`);
