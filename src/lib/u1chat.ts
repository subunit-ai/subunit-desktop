/**
 * lib/u1chat.ts — a typed client for the u1-chat backend (chat.subunit.ai), the
 * SAME service the subunit-ios app uses. One place that knows the wire shapes so
 * the KI-chat plugin, the Team-chat plugin and the Cockpit tasks panel all agree.
 *
 * Every call goes through `host.backend.fetch("u1-chat", …)`, which:
 *   · resolves the base to https://chat.subunit.ai (config.ts / backendBase),
 *   · attaches the short-lived Subunit bearer (audience "first-party" — accepted),
 *   · is gated by the caller's `backend:u1-chat` permission.
 *
 * Streaming endpoints are read via `lib/sse.ts readSSE` so GET streams work and an
 * AbortSignal can free the server's per-user stream slot on cancel.
 *
 * Auth/transport verified 2026-06-29: chat.subunit.ai accepts the desktop bearer
 * (RS256 vs auth.subunit.ai JWKS, aud ∋ "first-party", email @subunit.ai).
 */

import type { HostApi } from "../plugin/types";
import { readSSE, type SseEvent } from "./sse";

const B = "u1-chat";

// ════════════════════════════════════════════════════════════════════════════
// Wire shapes (mirror the iOS DTOs; ms-epoch timestamps throughout).
// ════════════════════════════════════════════════════════════════════════════

/** A KI thread = one Claude Code session, resumed server-side via `claude -p`. */
export interface ThreadDTO {
  id: string;
  title: string;
  color?: string;
  category?: string;
  model?: string;
  status?: string; // "active" | "closed"
  updated_at?: number;
  kind?: string; // "u1" | "bot" | "person"
}

/** An uploaded attachment reference (image | audio | file). */
export interface AttachmentDTO {
  id: string;
  kind: string; // "image" | "audio" | "file"
  name: string;
  url?: string;
  transcript?: string;
  duration?: number; // seconds (voice messages)
}

/** One emoji reaction aggregate on a message. */
export interface ReactionDTO {
  emoji: string;
  count: number;
  mine: boolean;
}

/** The curated reaction set — mirrors the server whitelist + iOS. */
export const REACTION_SET = ["👍", "🔥", "❤️", "✅", "👎", "🤔"] as const;

export interface MessageDTO {
  id?: number;
  role: string; // "user" | "assistant" | "system"
  content: string;
  created_at?: number;
  cost?: number;
  attachments?: AttachmentDTO[];
  reactions?: ReactionDTO[];
  reply_to?: number;
  reply_sender?: string;
  reply_text?: string;
  edited?: number; // sqlite bool: 0/1
  deleted?: number;
}

export interface TaskDTO {
  id: string;
  title: string;
  project?: string;
  priority?: string; // "hoch" | "mittel" | "niedrig"
  done: number; // 0 = open, else done
}

export interface TeamUserDTO {
  email: string;
  name?: string;
  avatar?: string;
  op?: number;
  last_seen: number; // ms-epoch; online if < 60s old
}

export interface TeamConvoDTO {
  id: string;
  kind: string; // "dm" | "group"
  title?: string;
  other?: string; // DM: other email
  other_name?: string; // DM: other display name
  other_seen?: number; // DM: their last_seen
  members?: string[];
  last_text?: string;
  last_sender?: string;
  updated_at?: number;
  unread?: number;
  other_read?: number; // DM read receipt: last msg id they read
  pinned_msg_id?: number;
  pinned_text?: string;
  pinned_sender?: string;
}

export interface TeamMessageDTO {
  id: number;
  sender: string; // email
  body: string;
  created_at?: number;
  attachments?: AttachmentDTO[];
  reactions?: ReactionDTO[];
  reply_to?: number;
  reply_sender?: string;
  reply_text?: string;
  edited?: number;
  deleted?: number;
}

export interface MeDTO {
  email: string;
  op?: boolean | number;
  csrf?: string;
}

// ── Bots (persistent tmux-bot rooms, account-scoped by server-side ACL) ──

/** A bot the signed-in account may talk to (roster is filtered server-side). */
export interface BotDTO {
  id: string; // "u1-private" | "u1-group" | "u1-erik" | "u1-dirk"
  name: string;
  online?: boolean;
  members?: string[]; // room members (ACL emails)
  last_text?: string | null;
  last_ts?: number | null; // ms epoch
  last_role?: string | null; // "user" | "bot" — client-side unread/notify
  last_sender?: string | null; // email of the last human sender ("" for bot)
}

/** One message in a bot room. Rooms are SHARED: every member sees everything. */
export interface BotMessageDTO {
  id: number;
  role: string; // "user" | "bot"
  sender: string; // email of the human sender, "" for the bot
  sender_name?: string;
  body: string;
  created_at?: number;
  reactions?: ReactionDTO[];
  reply_to?: number;
  reply_sender?: string;
  reply_text?: string;
}

// ════════════════════════════════════════════════════════════════════════════
// Low-level helpers
// ════════════════════════════════════════════════════════════════════════════

async function errMessage(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string; message?: string };
    return j.error || j.message || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function getJSON<T>(host: HostApi, path: string): Promise<T> {
  const res = await host.backend.fetch(B, path);
  if (!res.ok) throw new Error(await errMessage(res));
  return (await res.json()) as T;
}

async function sendJSON<T>(
  host: HostApi,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await host.backend.fetch(B, path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await errMessage(res));
  // Some endpoints (delete/edit) return no body.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ════════════════════════════════════════════════════════════════════════════
// KI threads (claude.ai-style, persistent, synced with subunit-ios)
// ════════════════════════════════════════════════════════════════════════════

export const listThreads = (host: HostApi) =>
  getJSON<ThreadDTO[]>(host, "/api/threads");

export const createThread = (host: HostApi, model = "opus") =>
  sendJSON<ThreadDTO>(host, "POST", "/api/threads", { model });

export const getThread = (host: HostApi, id: string) =>
  getJSON<{ thread: ThreadDTO; messages: MessageDTO[] }>(host, `/api/threads/${id}`);

export const closeThread = (host: HostApi, id: string) =>
  sendJSON<ThreadDTO>(host, "POST", `/api/threads/${id}/close`);

export const reopenThread = (host: HostApi, id: string) =>
  sendJSON<ThreadDTO>(host, "POST", `/api/threads/${id}/reopen`);

export interface ThreadSendBody {
  content: string;
  model?: string;
  effort?: string;
  reply_to?: number;
  attachment_ids?: string[];
}

/** POST a message and stream the assistant reply: delta|meta|done|error|ratelimit. */
export async function* streamThreadMessage(
  host: HostApi,
  threadId: string,
  body: ThreadSendBody,
  signal?: AbortSignal
): AsyncIterable<SseEvent> {
  const res = await host.backend.fetch(B, `/api/threads/${threadId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(await errMessage(res));
  yield* readSSE(res);
}

// ════════════════════════════════════════════════════════════════════════════
// Globale Nachrichten-Suche (Rail)
// ════════════════════════════════════════════════════════════════════════════

export interface SearchHitsDTO {
  team: { msg_id: number; convo_id: string; sender: string; snippet: string; created_at: number }[];
  threads: { msg_id: number; thread_id: string; role: string; snippet: string; created_at: number; title?: string }[];
  bots: { msg_id: number; bot_id: string; role: string; sender: string; sender_name?: string; snippet: string; created_at: number }[];
}

/** Server-seitige Suche über alle Unterhaltungen des Users (Backend 🔜 bis zum nächsten u1-chat-Deploy). */
export const searchMessages = (host: HostApi, q: string) =>
  getJSON<SearchHitsDTO>(host, `/api/search?q=${encodeURIComponent(q)}`);

/** Nachricht server-seitig in eine Team-Convo weiterleiten (Anhänge werden dort re-verlinkt). */
export const forwardMessage = (
  host: HostApi,
  targetConvoId: string,
  source: "team" | "bot" | "ki",
  sourceId: string,
  msgId: number
) => sendJSON<TeamMessageDTO>(host, "POST", `/api/team/convos/${targetConvoId}/forward`, { source, source_id: sourceId, msg_id: msgId });

// ════════════════════════════════════════════════════════════════════════════
// Tasks + projects (real, replaces the old Notion placeholder)
// ════════════════════════════════════════════════════════════════════════════

export const listTasks = (host: HostApi) => getJSON<TaskDTO[]>(host, "/api/tasks");

export const toggleTask = (host: HostApi, id: string) =>
  sendJSON<TaskDTO>(host, "POST", `/api/tasks/${id}/toggle`);

// ════════════════════════════════════════════════════════════════════════════
// Team chat (Telegram-style DMs + groups)
// ════════════════════════════════════════════════════════════════════════════

export const listConvos = (host: HostApi) =>
  getJSON<TeamConvoDTO[]>(host, "/api/team/convos");

export const listTeamUsers = (host: HostApi) =>
  getJSON<TeamUserDTO[]>(host, "/api/team/users");

export const getConvo = (host: HostApi, id: string) =>
  getJSON<{ convo: TeamConvoDTO; messages: TeamMessageDTO[] }>(
    host,
    `/api/team/convos/${id}`
  );

/** Create a DM (pass {email}) or a group (pass {title, members}). */
export const createConvo = (
  host: HostApi,
  payload: { email: string } | { title: string; members: string[] }
) => sendJSON<TeamConvoDTO>(host, "POST", "/api/team/convos", payload);

/** Attachment descriptor sent alongside a team message (ids from uploadFile). */
export interface SendAttachment {
  id: string;
  kind: string;
  name: string;
  duration?: number;
}

export const sendTeamMessage = (
  host: HostApi,
  convoId: string,
  body: string,
  replyTo?: number,
  attachments?: SendAttachment[]
) =>
  sendJSON<TeamMessageDTO>(host, "POST", `/api/team/convos/${convoId}/message`, {
    body,
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(attachments && attachments.length ? { attachments } : {}),
  });

export const setPresence = (host: HostApi, name: string) =>
  sendJSON<unknown>(host, "POST", "/api/team/presence", { name });

/** Live convo stream from ?since=<lastId>: message|typing|read. */
export async function* streamConvo(
  host: HostApi,
  convoId: string,
  since: number,
  signal?: AbortSignal
): AsyncIterable<SseEvent> {
  const res = await host.backend.fetch(
    B,
    `/api/team/convos/${convoId}/stream?since=${since}`,
    { headers: { Accept: "text/event-stream" }, signal }
  );
  if (!res.ok) throw new Error(await errMessage(res));
  yield* readSSE(res);
}

// ════════════════════════════════════════════════════════════════════════════
// Team chat — Telegram-parity surface (reactions, reply, edit/delete, read,
// typing, pins, group management). Wire shapes mirror the deployed waves.
// ════════════════════════════════════════════════════════════════════════════

export const reactTeamMessage = (
  host: HostApi,
  convoId: string,
  msgId: number,
  emoji: string
) =>
  sendJSON<{ reactions: ReactionDTO[] }>(
    host,
    "POST",
    `/api/team/convos/${convoId}/messages/${msgId}/react`,
    { emoji }
  );

export const editTeamMessage = (
  host: HostApi,
  convoId: string,
  msgId: number,
  body: string
) =>
  sendJSON<{ ok: boolean }>(
    host,
    "POST",
    `/api/team/convos/${convoId}/messages/${msgId}/edit`,
    { body }
  );

export const deleteTeamMessage = (host: HostApi, convoId: string, msgId: number) =>
  sendJSON<{ ok: boolean }>(
    host,
    "POST",
    `/api/team/convos/${convoId}/messages/${msgId}/delete`
  );

/** Mark everything up to `lastId` read (monotonic server-side). */
export const markRead = (host: HostApi, convoId: string, lastId: number) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/read`, {
    last_id: lastId,
  });

/** Signal "I'm typing" (server broadcasts + rate-limits; throttle client-side). */
export const sendTyping = (host: HostApi, convoId: string) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/typing`);

/** Pin a message (msgId = 0 unpins). */
export const pinMessage = (host: HostApi, convoId: string, msgId: number) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/pin`, {
    msg_id: msgId,
  });

export const renameConvo = (host: HostApi, convoId: string, title: string) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/rename`, {
    title,
  });

export const addConvoMember = (host: HostApi, convoId: string, email: string) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/members/add`, {
    email,
  });

export const leaveConvo = (host: HostApi, convoId: string) =>
  sendJSON<{ ok: boolean }>(host, "POST", `/api/team/convos/${convoId}/leave`);

// ════════════════════════════════════════════════════════════════════════════
// KI-thread parity (reactions + edit/delete own turns)
// ════════════════════════════════════════════════════════════════════════════

export const reactThreadMessage = (
  host: HostApi,
  threadId: string,
  msgId: number,
  emoji: string
) =>
  sendJSON<{ reactions: ReactionDTO[] }>(
    host,
    "POST",
    `/api/threads/${threadId}/messages/${msgId}/react`,
    { emoji }
  );

export const editThreadMessage = (
  host: HostApi,
  threadId: string,
  msgId: number,
  content: string
) =>
  sendJSON<{ ok: boolean }>(
    host,
    "POST",
    `/api/threads/${threadId}/messages/${msgId}/edit`,
    { content }
  );

export const deleteThreadMessage = (host: HostApi, threadId: string, msgId: number) =>
  sendJSON<{ ok: boolean }>(
    host,
    "POST",
    `/api/threads/${threadId}/messages/${msgId}/delete`
  );

// ════════════════════════════════════════════════════════════════════════════
// Bots — persistent tmux-bot rooms (TJ-Bot, Gruppe, Erik, Dirk), server-side
// account ACL. Shared-room semantics: all members read/write the same line.
// ════════════════════════════════════════════════════════════════════════════

export const listBots = (host: HostApi) => getJSON<BotDTO[]>(host, "/api/bots");

export const getBot = (host: HostApi, id: string) =>
  getJSON<{ bot: BotDTO; messages: BotMessageDTO[] }>(host, `/api/bots/${id}`);

/** Send a message into a bot room; the reply arrives on the SSE stream. */
export const sendBotMessage = (
  host: HostApi,
  botId: string,
  body: string,
  replyTo?: number
) =>
  sendJSON<BotMessageDTO>(host, "POST", `/api/bots/${botId}/message`, {
    body,
    ...(replyTo ? { reply_to: replyTo } : {}),
  });

/** Live bot-room stream from ?since=<lastId>: message|error. */
export async function* streamBot(
  host: HostApi,
  botId: string,
  since: number,
  signal?: AbortSignal
): AsyncIterable<SseEvent> {
  const res = await host.backend.fetch(B, `/api/bots/${botId}/stream?since=${since}`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!res.ok) throw new Error(await errMessage(res));
  yield* readSSE(res);
}

export const reactBotMessage = (
  host: HostApi,
  botId: string,
  msgId: number,
  emoji: string
) =>
  sendJSON<{ reactions: ReactionDTO[] }>(
    host,
    "POST",
    `/api/bots/${botId}/messages/${msgId}/react`,
    { emoji }
  );

// ════════════════════════════════════════════════════════════════════════════
// Uploads + protected media
// ════════════════════════════════════════════════════════════════════════════

/** Upload one file (multipart `kind` + `file`) → `{id, kind, name}`. Max 25 MB. */
export async function uploadFile(
  host: HostApi,
  file: File | Blob,
  kind: string,
  name: string
): Promise<{ id: string; kind: string; name: string }> {
  const form = new FormData();
  form.append("kind", kind);
  form.append("file", file, name);
  const res = await host.backend.fetch(B, "/api/uploads", {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error(await errMessage(res));
  return (await res.json()) as { id: string; kind: string; name: string };
}

/**
 * Fetch protected media bytes (`/api/media/:id`, owner or convo member) and hand
 * back an object URL. Cached per id for the app's lifetime — media is immutable.
 */
const mediaUrlCache = new Map<string, Promise<string>>();
export function mediaObjectUrl(host: HostApi, id: string): Promise<string> {
  let p = mediaUrlCache.get(id);
  if (!p) {
    p = (async () => {
      const res = await host.backend.fetch(B, `/api/media/${id}`);
      if (!res.ok) throw new Error(await errMessage(res));
      return URL.createObjectURL(await res.blob());
    })();
    // A failed fetch must not poison the cache — retry on next request.
    p.catch(() => mediaUrlCache.delete(id));
    mediaUrlCache.set(id, p);
  }
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
// Identity
// ════════════════════════════════════════════════════════════════════════════

export const getMe = (host: HostApi) => getJSON<MeDTO>(host, "/api/me");

// ── Cockpit → Chat seed hand-off ──
// host.events isn't sticky: the dashboard emits `chat:seed` and THEN navigates,
// so the chat plugin (mounted by that navigate) isn't subscribed yet and the
// event is lost. This module-level mailbox bridges the gap — the dashboard drops
// the payload here, the chat plugin drains it on mount. Both import this module,
// so they share the one instance.
export interface ChatSeed {
  taskId?: string;
  title?: string;
  status?: string;
  url?: string;
}
let pendingSeed: ChatSeed | null = null;
export const chatSeedMailbox = {
  put(seed: ChatSeed) {
    pendingSeed = seed;
  },
  take(): ChatSeed | null {
    const s = pendingSeed;
    pendingSeed = null;
    return s;
  },
};

/** True online if a team user's last_seen is within the last minute. */
export const isOnline = (lastSeen?: number): boolean =>
  typeof lastSeen === "number" && Date.now() - lastSeen < 60_000;
