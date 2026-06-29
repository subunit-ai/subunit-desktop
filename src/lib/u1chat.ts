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

export interface MessageDTO {
  id?: number;
  role: string; // "user" | "assistant" | "system"
  content: string;
  created_at?: number;
  cost?: number;
  reply_to?: number;
  reply_sender?: string;
  reply_text?: string;
  edited?: number;
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

export const sendTeamMessage = (
  host: HostApi,
  convoId: string,
  body: string,
  replyTo?: number
) =>
  sendJSON<TeamMessageDTO>(host, "POST", `/api/team/convos/${convoId}/message`, {
    body,
    ...(replyTo ? { reply_to: replyTo } : {}),
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
// Identity
// ════════════════════════════════════════════════════════════════════════════

export const getMe = (host: HostApi) => getJSON<MeDTO>(host, "/api/me");

/** True online if a team user's last_seen is within the last minute. */
export const isOnline = (lastSeen?: number): boolean =>
  typeof lastSeen === "number" && Date.now() - lastSeen < 60_000;
