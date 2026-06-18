/**
 * sse.ts — a fetch-based Server-Sent-Events reader for POST + stream.
 *
 * Ported VERBATIM (behaviour-identical) from atlas-web/src/lib/sse.js, retyped
 * for the TypeScript shell. The browser's native `EventSource` can only issue
 * GET requests and can't set an Authorization header, so it's useless for
 * atlas-api's `POST /api/m/ask` (Bearer JWT + JSON body, streamed SSE). This
 * reader POSTs the body, then parses the `text/event-stream` response off the
 * fetch `ReadableStream`, decoding the wire format atlas-api emits via Hono's
 * `streamSSE` (atlas-api/src/lib/sse.ts):
 *
 *   event: <name>\n
 *   data: <json-or-text>\n
 *   \n                       <- blank line terminates one event
 *
 * Multi-line `data:` fields are joined with "\n" per the SSE spec. The terminal
 * frame is `event: done`. `event: error` carries `{ error, ... }`.
 */

/** A decoded SSE event off the wire. `data` is JSON-parsed when possible. */
export interface SSEEvent {
  event: string;
  id?: string;
  data: unknown;
  raw: string;
}

export interface SSEInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
}

/** Thrown when the HTTP response itself fails (non-2xx) before any stream. */
export class SSEHttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`sse_http_${status}`);
    this.name = "SSEHttpError";
    this.status = status;
    this.body = body;
  }
}

interface Delimiter {
  index: number;
  length: number;
}

/** Open an SSE stream over fetch and yield decoded events. */
export async function* sseFetch(url: string, init: SSEInit = {}): AsyncGenerator<SSEEvent> {
  const { method = "POST", headers = {}, body, signal } = init;

  const res = await fetch(url, {
    method,
    headers: {
      Accept: "text/event-stream",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body:
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    // Surface the JSON error envelope atlas-api returns on auth/validation failures.
    let parsed: unknown = null;
    const text = await res.text().catch(() => "");
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text || null;
    }
    throw new SSEHttpError(res.status, parsed);
  }
  if (!res.body) throw new SSEHttpError(res.status, "no_stream_body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: Delimiter | null;
      while ((sep = indexOfDelimiter(buffer)) !== null) {
        const rawEvent = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep.length);
        const parsed = parseEvent(rawEvent);
        if (parsed) yield parsed;
      }
    }
    // Flush any trailing event that didn't end with a blank line.
    const tail = buffer.trim();
    if (tail) {
      const parsed = parseEvent(tail);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

/** Find the next event delimiter (\n\n or \r\n\r\n), returning its index + length. */
function indexOfDelimiter(buf: string): Delimiter | null {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (crlf === -1 || (lf !== -1 && lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

/** Parse one raw SSE event block into { event, id, data, raw }. */
function parseEvent(rawEvent: string): SSEEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of rawEvent.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // Spec: a single leading space after the colon is stripped.
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);

    if (field === "event") event = val;
    else if (field === "data") dataLines.push(val);
    else if (field === "id") id = val;
    // `retry` and unknown fields are ignored.
  }

  if (dataLines.length === 0 && event === "message") return null;
  const rawData = dataLines.join("\n");
  let data: unknown = rawData;
  try {
    data = rawData ? JSON.parse(rawData) : null;
  } catch {
    data = rawData;
  }
  return { event, id, data, raw: rawData };
}

/** Callback-style convenience wrapper. */
export async function consumeSSE(
  url: string,
  init: SSEInit,
  onEvent: (evt: SSEEvent) => void,
): Promise<void> {
  for await (const evt of sseFetch(url, init)) {
    onEvent(evt);
  }
}
