/**
 * lib/sse.ts — a tiny, standards-correct Server-Sent-Events reader over a fetch
 * `Response` body.
 *
 * Both u1-chat streaming surfaces use the same on-wire framing
 * (`event: <name>\ndata: <json>\n\n`, blank-line-terminated records, `:`-prefixed
 * comment lines like `: ping` / `: connected` ignored):
 *   · KI-chat  : POST /api/threads/:id/message  → delta|meta|done|error|ratelimit
 *   · Team-chat: GET  /api/team/convos/:id/stream → message|typing|read
 *
 * We read both through one parser (instead of the host's POST-only sse helper) so
 * the SAME path handles GET streams AND honours cancellation: pass an
 * AbortController's signal into the originating `host.backend.fetch(...)`, and when
 * the consumer aborts (leaves the conversation), the body errors and this
 * generator returns — which frees the server's per-user stream slot. That
 * cancellation is load-bearing on the backend (MAX_STREAMS_PER_USER).
 */

export interface SseEvent {
  /** The SSE `event:` name (defaults to "message" when none is sent). */
  event: string;
  /** `data:` payload, JSON-parsed when possible, else the raw string. */
  data: unknown;
}

/** Parse one SSE record (text between blank lines) into an event, or null to skip. */
function parseRecord(raw: string): SseEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / heartbeat (": ping")
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  // Nothing meaningful (a bare heartbeat record) → skip.
  if (dataLines.length === 0 && event === "message") return null;
  const text = dataLines.join("\n");
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
  }
  return { event, data };
}

/**
 * Stream an SSE `Response` (from `host.backend.fetch`, bearer already attached) as
 * an async iterable of `{event, data}`. Yields nothing if the response has no body
 * or is not OK — the caller should check `res.ok` before iterating for real
 * surfaces; this guard just avoids throwing on a dead stream.
 */
export async function* readSSE(res: Response): AsyncIterable<SseEvent> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // Records are separated by a blank line; normalise CRLF first.
      buf = buf.replace(/\r\n/g, "\n");
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseRecord(record);
        if (evt) yield evt;
      }
    }
    // Flush any multi-byte UTF-8 sequence the decoder buffered across chunks.
    buf += decoder.decode();
    const tail = buf.trim();
    if (tail) {
      const evt = parseRecord(tail);
      if (evt) yield evt;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released / cancelled */
    }
  }
}
