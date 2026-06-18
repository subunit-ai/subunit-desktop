/**
 * api.ts — typed client for atlas-api's mobile lane (/api/m/*), wired into the
 * Subunit shell.
 *
 * Ported from atlas-web/src/lib/api.js. Two adaptations for the shell:
 *   1. URLs are built with the shell's `api()` helper (src/lib/config.ts), which
 *      prepends BACKEND_BASE_URL (local sidecar :7850 by default, or the cloud
 *      atlas-api). atlas-api's mobile lane lives under `/api/m/*`.
 *   2. The Bearer token comes from the shell session (Tauri IPC `get_auth_token`
 *      in production; localStorage in a dev browser tab). In local-dev bypass the
 *      token is empty and the sidecar accepts it.
 *
 * Contract (authored against atlas-api/src/types.ts + src/lib/sse.ts):
 *   - Bearer JWT on every request (auth.subunit.ai SSO), optional in dev bypass.
 *   - POST /api/m/ask streams Server-Sent Events with NAMED events:
 *         chunk     { sources: RetrievedSource[] }   (retrieved sources, up front)
 *         delta     { token: string }                (answer tokens, many)
 *         citations Citation[]                        (final citation set, once)
 *         done      { cost, via, cloud_badge?, thread_id, message_id }  (terminal)
 *         error     { error: string }                (recoverable / fatal)
 *         ping      {}                                (heartbeat — ignored)
 *   - All other routes are plain JSON.
 */

import { api } from "../../../lib/config";
import { getToken } from "./session";
import { sseFetch, SSEHttpError, type SSEInit } from "./sse";

// ---------------------------------------------------------------------------
// Wire types — mirror atlas-api/src/types.ts
// ---------------------------------------------------------------------------

export type Channel = "document" | "url" | "youtube" | "social" | "voice" | "meeting";
export type SourceType = Channel;
export type JobStatus = "queued" | "processing" | "done" | "error" | "skipped";
export type AxonStatus = "pending" | "approved" | "rejected";

export interface Doc {
  doc_id: string;
  workspace_id?: string;
  title: string;
  source_type: SourceType;
  source_uri?: string | null;
  source_url?: string | null;
  sha256?: string | null;
  captured_at: string;
  channel: Channel;
  raw_path?: string | null;
  bytes?: number | null;
}

export interface RetrievedSource {
  n: number;
  id: string;
  doc_id: string;
  title: string;
  uri: string | null;
  locator: string | null;
  score: number;
  snippet: string;
}

export interface Citation {
  n: number;
  doc_id: string;
  title: string;
  uri: string | null;
  locator: string | null;
  score: number;
  snippet: string;
  /** Some surfaces use a card key fallback; kept optional for tolerance. */
  id?: string;
  source_type?: SourceType;
  channel?: Channel;
  captured_at?: string;
}

export interface AskDone {
  cost: number;
  via: "local" | "cloud";
  cloud_badge?: string;
  thread_id: string;
  message_id: string;
}

export interface IngestAccepted {
  job_id: string;
  status: "queued";
  idempotency_key?: string;
}

export interface JobStatusRow {
  job_id: string;
  channel?: Channel;
  status: JobStatus | "not_found" | "unknown";
  doc_id?: string | null;
  error?: string | null;
  attempts?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AxonPending {
  id: string;
  workspace_id: string;
  job_id: string | null;
  doc_id: string | null;
  title: string;
  preview: string;
  status: AxonStatus;
  created_at: string;
}

export interface SearchHit {
  id: string;
  doc_id: string;
  title: string;
  uri: string | null;
  text: string;
  score: number;
  source: string;
  category: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** Build a fully-qualified /api/m path against the shell's backend base URL. */
function murl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return api(`/api/m${p}`);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const token = getToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const errObj = body as { error?: string } | null;
    const msg = (errObj && errObj.error) || res.statusText || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

async function getJson<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(murl(path), { method: "GET", headers: authHeaders(), ...opts });
  return jsonOrThrow<T>(res);
}

async function postJson<T>(
  path: string,
  payload: unknown,
  { idempotencyKey }: { idempotencyKey?: string } = {},
): Promise<T> {
  const headers = authHeaders({ "Content-Type": "application/json" });
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(murl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(payload ?? {}),
  });
  return jsonOrThrow<T>(res);
}

// ---------------------------------------------------------------------------
// Docs
// ---------------------------------------------------------------------------

/** GET /api/m/docs — the active workspace's document list. */
export async function listDocs({
  limit,
  channel,
}: { limit?: number; channel?: string } = {}): Promise<Doc[]> {
  const qs = new URLSearchParams();
  if (limit) qs.set("limit", String(limit));
  if (channel) qs.set("channel", channel);
  const q = qs.toString();
  const body = await getJson<Doc[] | { docs?: Doc[] }>(`/docs${q ? `?${q}` : ""}`);
  return Array.isArray(body) ? body : (body?.docs ?? []);
}

/** GET /api/m/docs/:id — doc metadata (the raw download is a separate request). */
export async function getDoc(docId: string): Promise<Doc> {
  return getJson<Doc>(`/docs/${encodeURIComponent(docId)}`);
}

/**
 * Open a doc's raw original (GET /api/m/docs/:id). Streams it with the
 * Authorization header and hands the browser a blob URL so the JWT never lands
 * in history / server logs. Falls back to a download when popups are blocked.
 */
export async function openDoc(docId: string): Promise<{ filename: string }> {
  const res = await fetch(murl(`/docs/${encodeURIComponent(docId)}`), {
    method: "GET",
    headers: authHeaders(),
  });
  if (!res.ok) throw new ApiError("open_failed", res.status, null);
  const disposition = res.headers.get("Content-Disposition") || "";
  const nameMatch = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const filename = nameMatch ? decodeURIComponent(nameMatch[1]) : docId;
  const blob = await res.blob();
  const href = URL.createObjectURL(blob);
  const win = window.open(href, "_blank", "noopener");
  if (!win) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
  return { filename };
}

// ---------------------------------------------------------------------------
// Search / jobs / ingest
// ---------------------------------------------------------------------------

/** POST /api/m/search — raw semantic search, no generation. */
export async function search(
  query: string,
  { n_results = 8, filter }: { n_results?: number; filter?: Record<string, unknown> } = {},
): Promise<SearchHit[]> {
  const body = await postJson<{ results?: SearchHit[] }>("/search", {
    query,
    n_results,
    filter,
  });
  return body?.results ?? [];
}

/** GET /api/m/jobs/:id — ingest job status. */
export async function getJob(jobId: string): Promise<JobStatusRow> {
  return getJson<JobStatusRow>(`/jobs/${encodeURIComponent(jobId)}`);
}

/** POST /api/m/ingest/:channel (JSON channels) — accepted async (202 {job_id}). */
export async function ingest(
  channel: Channel,
  payload: Record<string, unknown>,
  { idempotencyKey }: { idempotencyKey?: string } = {},
): Promise<IngestAccepted> {
  return postJson<IngestAccepted>(`/ingest/${encodeURIComponent(channel)}`, payload, {
    idempotencyKey,
  });
}

/**
 * POST /api/m/ingest/:channel (file channels: document, voice) — multipart upload.
 * Sends the raw bytes as a `file` field; the server persists the original and
 * enqueues the job. Returns 202 {job_id}.
 */
export async function ingestFile(
  channel: Extract<Channel, "document" | "voice">,
  file: File,
  { title, language, idempotencyKey }: { title?: string; language?: string; idempotencyKey?: string } = {},
): Promise<IngestAccepted> {
  const form = new FormData();
  form.set("file", file);
  if (title) form.set("title", title);
  if (language) form.set("language", language);
  if (idempotencyKey) form.set("idempotency_key", idempotencyKey);
  const headers = authHeaders();
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(murl(`/ingest/${encodeURIComponent(channel)}`), {
    method: "POST",
    headers, // do NOT set Content-Type — the browser sets the multipart boundary
    body: form,
  });
  return jsonOrThrow<IngestAccepted>(res);
}

/** The job-stream URL (GET /api/m/jobs/:id/stream) for the SSE follower. */
export function jobStreamUrl(jobId: string): string {
  return murl(`/jobs/${encodeURIComponent(jobId)}/stream`);
}

/** Build the auth headers used for an SSE follow (Bearer when present). */
export function sseAuthHeaders(): Record<string, string> {
  return authHeaders();
}

// ---------------------------------------------------------------------------
// Axon review queue
// ---------------------------------------------------------------------------

/** GET /api/m/axon/pending — per-workspace review queue. */
export async function axonPending(): Promise<AxonPending[]> {
  const body = await getJson<{ pending?: AxonPending[] }>("/axon/pending");
  return body?.pending ?? [];
}

/** POST /api/m/axon/confirm/:id — approve a pending review entry. */
export async function axonConfirm(id: string): Promise<{ id: string; status: AxonStatus }> {
  return postJson(`/axon/confirm/${encodeURIComponent(id)}`, {});
}

/** POST /api/m/axon/discard/:id — reject a pending review entry. */
export async function axonDiscard(id: string): Promise<{ id: string; status: AxonStatus }> {
  return postJson(`/axon/discard/${encodeURIComponent(id)}`, {});
}

// ---------------------------------------------------------------------------
// ask — cited-RAG over SSE
// ---------------------------------------------------------------------------

export interface AskHandlers {
  onSources?: (sources: RetrievedSource[]) => void;
  onDelta?: (token: string, full: string) => void;
  onCitations?: (citations: Citation[]) => void;
  onDone?: (meta: Partial<AskDone>) => void;
  onError?: (message: string) => void;
}

export interface AskOpts {
  threadId?: string;
  nResults?: number;
  filter?: Record<string, unknown>;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface AskResult {
  text: string;
  citations: Citation[];
  sources: RetrievedSource[];
  done: Partial<AskDone> | null;
}

/**
 * Stream a cited answer. Resolves after the stream ends with the assembled state.
 */
export async function ask(
  query: string,
  handlers: AskHandlers = {},
  opts: AskOpts = {},
): Promise<AskResult> {
  const { threadId, nResults = 8, filter, idempotencyKey, signal } = opts;
  const headers = authHeaders();
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const state: AskResult = { text: "", citations: [], sources: [], done: null };

  const init: SSEInit = {
    method: "POST",
    headers,
    body: {
      query,
      thread_id: threadId,
      n_results: nResults,
      filter,
      idempotency_key: idempotencyKey,
    },
    signal,
  };

  try {
    for await (const evt of sseFetch(murl("/ask"), init)) {
      const { event, data } = evt;
      switch (event) {
        case "ping":
          break;
        case "chunk": {
          const sources = Array.isArray(data)
            ? (data as RetrievedSource[])
            : ((data as { sources?: RetrievedSource[] })?.sources ?? []);
          state.sources = sources;
          handlers.onSources?.(sources);
          break;
        }
        case "delta": {
          const token =
            typeof data === "string" ? data : ((data as { token?: string })?.token ?? "");
          if (token) {
            state.text += token;
            handlers.onDelta?.(token, state.text);
          }
          break;
        }
        case "citations": {
          const cites = Array.isArray(data)
            ? (data as Citation[])
            : ((data as { citations?: Citation[] })?.citations ?? []);
          state.citations = cites;
          handlers.onCitations?.(cites);
          break;
        }
        case "done":
          state.done = data && typeof data === "object" ? (data as Partial<AskDone>) : {};
          handlers.onDone?.(state.done);
          break;
        case "error":
          handlers.onError?.((data as { error?: string })?.error || "stream_error");
          break;
        default:
          break;
      }
    }
  } catch (err) {
    if (signal?.aborted) return state; // caller cancelled — not an error
    if (err instanceof SSEHttpError) {
      const errBody = err.body as { error?: string } | null;
      const msg =
        err.status === 401
          ? "unauthorized"
          : errBody?.error || `ask_failed_${err.status}`;
      handlers.onError?.(msg);
      throw new ApiError(msg, err.status, err.body);
    }
    handlers.onError?.(err instanceof Error ? err.message : "stream_failed");
    throw err;
  }

  return state;
}
