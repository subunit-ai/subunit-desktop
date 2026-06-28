/**
 * Atlas — cited-RAG console over the workspace knowledge base.
 *
 * A native Subunit Liquid Glass question→answer surface. The question posts to
 * atlas-api via host.backend.sse ("/api/m/ask"); streamed tokens build the answer,
 * and `chunk`/`citations` events accumulate a SOURCES list where every entry is
 * OPENABLE back to its origin:
 *   · url sources  → host.ui.openExternal (browser)
 *   · file sources → host.ui.openPath (default app) + host.ui.revealPath (Finder)
 * The open-target is resolved server-side (Citation.open / RetrievedSource.open)
 * from the canonical `docs` row, so the client never guesses. Inline [n] markers in
 * the answer are clickable and jump to the matching source card.
 *
 * Calm, light-default, ONE cyan accent. Built for enterprises (DSGVO-local model).
 *
 * Permissions: backend:atlas-api, storage, files.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri } from "../../lib/ipc";
import type { HostApi, PluginModule, SseMessage } from "../../plugin/types";

/** Synthetic model option: retrieve locally, generate over the Max subscription. */
const ABO_MODEL = "abo:opus";

const ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>`;

const Svg = (props: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.9}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

const ICONS = {
  ask: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 13h6|9 17h4",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5|14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|3 12h18|12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18",
  play: "M5 3l14 9-14 9z",
  copy: "M9 9h10v10H9z|5 15V5h10",
  open: "M14 3h7v7|M21 3l-9 9|M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
};

type SourceKind = "url" | "file";

/** Server-resolved open-target (mirrors atlas-api SourceOpen). */
interface SourceOpen {
  kind: SourceKind;
  url?: string | null;
  path?: string | null;
  download: string;
  filename?: string | null;
  source_type: string;
}

interface Source {
  /** 1-based citation index — the [n] in the answer maps to this. */
  n: number;
  id: string;
  doc_id?: string;
  title: string;
  uri?: string | null;
  locator?: string | null;
  snippet?: string;
  score?: number;
  open?: SourceOpen | null;
}

/** One entry from GET /api/m/models (the answer-model picker feed). */
interface ModelOption {
  id: string;
  label: string;
  provider: string;
  kind: "local" | "cloud";
  available: boolean;
  reason?: string;
}

// Best-effort extraction of prose tokens from a streamed SSE message.
function extractToken(msg: SseMessage): string | null {
  const d = msg.data as Record<string, unknown> | string | undefined;
  if (typeof d === "string") {
    if (msg.event === "token" || msg.event === "delta" || msg.event === "message")
      return d;
    return null;
  }
  if (!d || typeof d !== "object") return null;
  for (const k of ["token", "delta", "text", "content", "answer", "chunk"]) {
    const v = (d as Record<string, unknown>)[k];
    if (typeof v === "string") return v;
  }
  return null;
}

function asOpen(raw: unknown): SourceOpen | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === "file" ? "file" : o.kind === "url" ? "url" : null;
  if (!kind) return null;
  return {
    kind,
    url: typeof o.url === "string" ? o.url : null,
    path: typeof o.path === "string" ? o.path : null,
    download: typeof o.download === "string" ? o.download : "",
    filename: typeof o.filename === "string" ? o.filename : null,
    source_type: typeof o.source_type === "string" ? o.source_type : "",
  };
}

// Best-effort extraction of one-or-many sources from a streamed SSE message.
// Handles the atlas-api shapes: `chunk` {sources:[…]} and `citations` […].
function extractSources(msg: SseMessage): Source[] {
  const d = msg.data as Record<string, unknown> | unknown[] | undefined;
  if (!d) return [];
  const raw: unknown[] | null = Array.isArray(d)
    ? d
    : Array.isArray((d as Record<string, unknown>).sources)
      ? ((d as Record<string, unknown>).sources as unknown[])
      : Array.isArray((d as Record<string, unknown>).citations)
        ? ((d as Record<string, unknown>).citations as unknown[])
        : msg.event === "source" || msg.event === "citation"
          ? [d]
          : null;
  if (!raw) return [];
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    const n = typeof o.n === "number" ? o.n : i + 1;
    return {
      n,
      id: String(o.id ?? o.doc_id ?? o.uri ?? `src-${n}`),
      doc_id: typeof o.doc_id === "string" ? o.doc_id : undefined,
      title: String(o.title ?? o.name ?? o.uri ?? `Quelle ${n}`),
      uri: typeof o.uri === "string" ? o.uri : typeof o.url === "string" ? o.url : null,
      locator:
        typeof o.locator === "string" || typeof o.locator === "number"
          ? String(o.locator)
          : null,
      snippet:
        typeof o.snippet === "string"
          ? o.snippet
          : typeof o.text === "string"
            ? o.text
            : undefined,
      score: typeof o.score === "number" ? o.score : undefined,
      open: asOpen(o.open),
    } satisfies Source;
  });
}

/** Pick a source-type icon for a source. */
function srcIcon(s: Source): keyof typeof ICONS {
  const t = s.open?.source_type;
  if (s.open?.kind === "file" || t === "document" || t === "voice") return "doc";
  if (t === "youtube") return "play";
  if (t === "social") return "globe";
  if (s.open?.kind === "url" || t === "url") return "link";
  return s.uri && /^https?:/i.test(s.uri) ? "link" : "doc";
}

/** Can this source be opened back to a real origin? */
function canOpen(s: Source): boolean {
  if (s.open?.kind === "url" && s.open.url) return true;
  if (s.open?.kind === "file" && s.open.path) return true;
  return !!(s.uri && /^https?:/i.test(s.uri));
}

/** A short human label for the locator (page / chunk / timestamp). */
function locatorLabel(loc: string | null | undefined): string | null {
  if (loc == null || loc === "") return null;
  if (/^\d+$/.test(loc)) return `Abschnitt ${Number(loc) + 1}`;
  return loc;
}

function AtlasView({ host }: { host: HostApi }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [cited, setCited] = useState<Set<number>>(new Set());
  const [via, setVia] = useState<"local" | "cloud" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState("");
  const [flashN, setFlashN] = useState<number | null>(null);
  const answerRef = useRef<HTMLDivElement>(null);
  const srcRefs = useRef<Map<number, HTMLLIElement>>(new Map());
  const cancelRef = useRef(false);
  const atlasReqRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    []
  );

  // Load the answer-model picker feed; restore the saved choice or fall back to
  // the server default. Optional — if /models is unreachable, ask uses the default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = (await host.storage.get("atlas.model")) as string | undefined;
        const res = await host.backend.fetch("atlas-api", "/api/m/models");
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { models: ModelOption[]; default?: string };
        // Offer "Claude · Abo (Opus)" — retrieval stays local, generation runs over
        // the Max subscription (claude -p). Only in the Tauri app (needs u1_ask).
        const aboOpt: ModelOption = {
          id: ABO_MODEL,
          label: "Claude · Abo (Opus)",
          provider: "anthropic",
          kind: "cloud",
          available: true,
        };
        setModels(isTauri() ? [aboOpt, ...(data.models ?? [])] : (data.models ?? []));
        const avail = (data.models ?? []).filter((m) => m.available);
        const pick =
          saved && avail.some((m) => m.id === saved)
            ? saved
            : data.default ?? avail[0]?.id ?? "";
        setModel(pick);
      } catch {
        /* models endpoint optional */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  const selectModel = useCallback(
    (id: string) => {
      setModel(id);
      void host.storage.set("atlas.model", id);
    },
    [host]
  );

  // Stream listener for the Abo (claude/Opus) generation path — appends tokens to the
  // answer for the active atlas request, filtered by requestId.
  useEffect(() => {
    if (!isTauri()) return;
    const offs: UnlistenFn[] = [];
    let alive = true;
    const reg = (p: Promise<UnlistenFn>) => p.then((u) => (alive ? offs.push(u) : u()));
    reg(
      listen<{ requestId: string; text: string }>("u1://delta", (e) => {
        if (e.payload.requestId !== atlasReqRef.current) return;
        // Stopped mid-stream → end the Abo request cleanly so busy can't get stuck.
        if (cancelRef.current) {
          atlasReqRef.current = null;
          setBusy(false);
          return;
        }
        setAnswer((a) => a + e.payload.text);
      })
    );
    reg(
      listen<{ requestId: string }>("u1://done", (e) => {
        if (e.payload.requestId !== atlasReqRef.current) return;
        atlasReqRef.current = null;
        setVia("cloud");
        setBusy(false);
      })
    );
    reg(
      listen<{ requestId: string; message: string }>("u1://error", (e) => {
        if (e.payload.requestId !== atlasReqRef.current) return;
        atlasReqRef.current = null;
        setError(e.payload.message || "Abo-Generierung fehlgeschlagen.");
        setBusy(false);
      })
    );
    return () => {
      alive = false;
      offs.forEach((o) => o());
    };
  }, []);

  // Atlas over the Max subscription: retrieve chunks locally, generate with Opus.
  const askViaAbo = useCallback(
    async (query: string) => {
      try {
        const res = await host.backend.fetch("atlas-api", "/api/m/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, n_results: 8 }),
        });
        if (!res.ok) throw new Error(`Suche fehlgeschlagen (${res.status})`);
        const data = (await res.json()) as {
          results: { title?: string; uri?: string | null; text?: string; source?: string }[];
        };
        const results = data.results ?? [];
        const srcs: Source[] = results.map((r, i) => ({
          n: i + 1,
          id: String(i + 1),
          title: r.title || r.source || `Quelle ${i + 1}`,
          uri: r.uri ?? null,
          snippet: (r.text || "").slice(0, 400),
          open: null,
        }));
        setSources(srcs);
        setCited(new Set(srcs.map((s) => s.n)));
        if (results.length === 0) {
          setAnswer("Keine passenden Quellen im Wissensspeicher gefunden.");
          setVia("cloud");
          setBusy(false);
          return;
        }
        const ctx = results
          .map((r, i) => `[${i + 1}] ${r.title || r.source || ""}\n${(r.text || "").slice(0, 1200)}`)
          .join("\n\n");
        const messages = [
          {
            role: "system",
            content:
              "Du beantwortest die Frage AUSSCHLIESSLICH anhand der nummerierten Quellen. Zitiere die genutzten Quellen inline mit [n]. Wenn die Quellen die Frage nicht hergeben, sag das ehrlich. Knapp, auf Deutsch.",
          },
          { role: "user", content: `Frage: ${query}\n\nQuellen:\n${ctx}` },
        ];
        const reqId = `atlas${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        atlasReqRef.current = reqId;
        await invoke("u1_ask", { requestId: reqId, provider: "claude", model: "opus", messages });
        // tokens + completion arrive via the listener above.
      } catch (e) {
        atlasReqRef.current = null;
        setError(e instanceof Error ? e.message : String(e));
        setBusy(false);
      }
    },
    [host]
  );

  const jumpToSource = useCallback((n: number) => {
    const el = srcRefs.current.get(n);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlashN(n);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashN(null), 1300);
  }, []);

  const openSource = useCallback(
    (s: Source) => {
      const o = s.open;
      if (o?.kind === "url" && o.url) return host.ui.openExternal(o.url);
      // Local DSGVO deployment: atlas-api runs on this Mac, so open.path is a real
      // local file. When atlas-api moves remote (Hetzner), open.path will be a
      // server path that openPath safely refuses; the fallback is the ws-scoped,
      // Bearer-authed `open.download` route (fetch-to-temp + open), wired then.
      if (o?.kind === "file" && o.path) return host.ui.openPath(o.path);
      if (s.uri && /^https?:/i.test(s.uri)) return host.ui.openExternal(s.uri);
    },
    [host]
  );

  const revealSource = useCallback(
    (s: Source) => {
      if (s.open?.kind === "file" && s.open.path) host.ui.revealPath(s.open.path);
    },
    [host]
  );

  const ask = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || busy) return;
      cancelRef.current = false;
      setBusy(true);
      setError(null);
      setAnswer("");
      setSources([]);
      setCited(new Set());
      setVia(null);
      setAsked(query);
      // Abo path: retrieve locally, generate over the subscription (Opus).
      if (model === ABO_MODEL && isTauri()) {
        await askViaAbo(query);
        return;
      }
      try {
        const stream = host.backend.sse("atlas-api", "/api/m/ask", {
          query,
          ...(model ? { model } : {}),
          top_k: 8,
        });
        for await (const msg of stream) {
          if (cancelRef.current) break;
          if (msg.event === "error") {
            const dd = msg.data as Record<string, unknown> | string;
            // atlas-api emits the text under `error` (sse.ts), not `message`.
            setError(
              typeof dd === "string"
                ? dd
                : String(
                    (dd as Record<string, unknown>)?.error ??
                      (dd as Record<string, unknown>)?.message ??
                      "Stream-Fehler"
                  )
            );
            continue;
          }
          if (msg.event === "done" || msg.event === "end") {
            const dd = msg.data as Record<string, unknown> | undefined;
            if (dd && typeof dd === "object" && (dd.via === "cloud" || dd.via === "local"))
              setVia(dd.via);
            break;
          }
          const tok = extractToken(msg);
          if (tok) setAnswer((a) => a + tok);

          const srcs = extractSources(msg);
          if (srcs.length) {
            // `citations` confirms which retrieved sources the model actually used.
            if (msg.event === "citations" || Array.isArray(msg.data))
              setCited((prev) => {
                const next = new Set(prev);
                for (const s of srcs) next.add(s.n);
                return next;
              });
            setSources((prev) => {
              const byN = new Map(prev.map((s) => [s.n, s]));
              for (const s of srcs) {
                const existing = byN.get(s.n);
                // Merge: keep the richest record (chunk has full set; citations may
                // refine open/snippet). Prefer a non-null open.
                byN.set(s.n, {
                  ...existing,
                  ...s,
                  open: s.open ?? existing?.open ?? null,
                  snippet: s.snippet ?? existing?.snippet,
                });
              }
              return [...byN.values()].sort((a, b) => a.n - b.n);
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, host, model, askViaAbo]
  );

  const stop = useCallback(() => {
    cancelRef.current = true;
    setBusy(false);
  }, []);

  const examples = [
    "Was haben wir zur Echo-Sprach-Architektur entschieden?",
    "Wie funktioniert die Meet-Pod-Diarization?",
    "Status der Nexus-Roadmap P2",
  ];

  // Render the answer with clickable [n] citation chips that jump to the source.
  const renderAnswer = (text: string) => {
    const parts: React.ReactNode[] = [];
    const re = /\[(\d{1,3})\]/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let key = 0;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parts.push(text.slice(last, m.index));
      const n = Number(m[1]);
      const known = sources.some((s) => s.n === n);
      parts.push(
        known ? (
          <button
            key={`c${key++}`}
            className="atl-cite"
            title={`Quelle ${n} anzeigen`}
            onClick={() => jumpToSource(n)}
          >
            {n}
          </button>
        ) : (
          <span key={`c${key++}`}>{m[0]}</span>
        )
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  };

  return (
    <div className="atl">
      <AtlasStyle />

      <div className="atl-hero">
        <h1>Atlas</h1>
        <p>
          Frag den Workspace. Antworten kommen mit Belegen aus unseren
          eingespeisten Quellen — jede Quelle direkt anklickbar und im Original
          zu öffnen. Nichts erfunden, alles lokal.
        </p>
      </div>

      <div className="card atl-ask">
        <div className="atl-askrow">
          <input
            className="fld atl-fld"
            placeholder="Stell eine Frage an die Wissensbasis…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void ask(question);
              }
            }}
          />
          {busy ? (
            <button className="btn btn-ghost minibtn atl-go" onClick={stop}>
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary minibtn atl-go"
              disabled={!question.trim()}
              onClick={() => void ask(question)}
            >
              <Svg d={ICONS.ask} />
              Fragen
            </button>
          )}
        </div>

        {models.length > 0 && (
          <div className="atl-models">
            <span className="atl-models-lbl">Modell</span>
            {models.map((m) => (
              <button
                key={m.id}
                className={`chip atl-model${m.id === model ? " on" : ""}${m.available ? "" : " off"}`}
                disabled={!m.available}
                title={m.available ? `${m.label} · ${m.provider}` : `${m.label} — ${m.reason ?? "nicht verfügbar"}`}
                onClick={() => m.available && selectModel(m.id)}
              >
                {m.label}
                {m.kind === "cloud" && <span className="atl-avv">AVV</span>}
              </button>
            ))}
          </div>
        )}

        {!asked && !busy && (
          <div className="atl-examples">
            {examples.map((ex) => (
              <button
                key={ex}
                className="chip atl-ex"
                onClick={() => {
                  setQuestion(ex);
                  void ask(ex);
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="callout atl-err">
          <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <div>
            <b>Atlas nicht erreichbar</b>
            <span>{error}</span>
          </div>
        </div>
      )}

      {(asked || busy) && (
        <div className="atl-grid">
          <section className="card atl-answer">
            <div className="atl-answer-head">
              <div className="sect" style={{ margin: 0 }}>
                Antwort
              </div>
              {busy && <span className="badge atl-livebadge">streaming…</span>}
              {!busy && answer && via && (
                <span className={`badge atl-via atl-via-${via}`}>
                  {via === "cloud" ? "via Cloud" : "lokal"}
                </span>
              )}
              {!busy && answer && (
                <button
                  className="iconbtn atl-copy"
                  title="Kopieren"
                  onClick={() => void navigator.clipboard?.writeText(answer)}
                >
                  <span className="ic">
                    <Svg d={ICONS.copy} />
                  </span>
                </button>
              )}
            </div>
            <div className="atl-q">{asked}</div>
            <div className="atl-prose" ref={answerRef}>
              {answer ? (
                <>
                  {renderAnswer(answer)}
                  {busy && <span className="atl-caret" />}
                </>
              ) : busy ? (
                <div className="atl-thinking">
                  <span className="spinner" />
                  Durchsuche Quellen…
                </div>
              ) : (
                <span className="hint">Keine Antwort.</span>
              )}
            </div>
          </section>

          <aside className="atl-sources">
            <div className="sect" style={{ marginTop: 0 }}>
              Quellen {sources.length > 0 && <span className="badge">{sources.length}</span>}
            </div>
            {sources.length === 0 ? (
              <div className="atl-nosrc">
                {busy ? "Belege werden gesammelt…" : "Keine Quellen zitiert."}
              </div>
            ) : (
              <ul className="list atl-srclist">
                {sources.map((s) => {
                  const openable = canOpen(s);
                  const loc = locatorLabel(s.locator);
                  const isFile = s.open?.kind === "file";
                  return (
                    <li
                      key={s.n}
                      ref={(el) => {
                        if (el) srcRefs.current.set(s.n, el);
                        else srcRefs.current.delete(s.n);
                      }}
                      className={`atl-src${openable ? " is-open" : ""}${
                        flashN === s.n ? " flash" : ""
                      }${cited.has(s.n) ? " cited" : ""}`}
                      role={openable ? "button" : undefined}
                      tabIndex={openable ? 0 : undefined}
                      title={
                        openable
                          ? isFile
                            ? "Dokument öffnen"
                            : "Im Browser öffnen"
                          : undefined
                      }
                      onClick={() => openable && openSource(s)}
                      onKeyDown={(e) => {
                        // Only the card itself activates — let inner buttons
                        // (reveal/open) handle their own Enter/Space.
                        if (e.currentTarget !== e.target) return;
                        if (openable && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          openSource(s);
                        }
                      }}
                    >
                      <span className="atl-src-n">{s.n}</span>
                      <span className="atl-src-ic">
                        <Svg d={ICONS[srcIcon(s)]} />
                      </span>
                      <div className="atl-src-tx">
                        <div className="atl-src-title">
                          {s.title}
                          {cited.has(s.n) && <span className="atl-src-tag">zitiert</span>}
                        </div>
                        <div className="atl-src-meta">
                          {loc && <span className="atl-src-loc">{loc}</span>}
                          {typeof s.score === "number" && (
                            <span className="atl-src-score">
                              {Math.round(s.score * 100)}% Treffer
                            </span>
                          )}
                          {!openable && (
                            <span className="atl-src-noorig">Inline-Quelle</span>
                          )}
                        </div>
                        {s.snippet && <div className="atl-src-snip">{s.snippet}</div>}
                      </div>
                      <div className="atl-src-actions">
                        {isFile && s.open?.path && (
                          <button
                            className="atl-src-act"
                            title="Im Finder zeigen"
                            onClick={(e) => {
                              e.stopPropagation();
                              revealSource(s);
                            }}
                          >
                            <Svg d={ICONS.folder} />
                          </button>
                        )}
                        {openable && (
                          <button
                            className="atl-src-act"
                            title={isFile ? "Dokument öffnen" : "Im Browser öffnen"}
                            onClick={(e) => {
                              e.stopPropagation();
                              openSource(s);
                            }}
                          >
                            <Svg d={ICONS.open} />
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function AtlasStyle() {
  return (
    <style>{`
.atl{width:100%;max-width:1040px;margin:0 auto;padding:26px 28px 56px}
.atl-hero{margin:6px 2px 20px}
.atl-hero h1{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.atl-hero p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:58ch;letter-spacing:-.006em}

.atl-ask{padding:18px}
.atl-askrow{display:flex;gap:10px;align-items:center}
.atl-fld{margin-top:0;flex:1}
.atl-go{width:auto;flex:none;display:inline-flex;align-items:center;gap:7px}
.atl-go svg{width:17px;height:17px}
.atl-models{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin-top:13px}
.atl-models-lbl{font-size:11px;font-weight:650;letter-spacing:.05em;text-transform:uppercase;color:var(--ink3);margin-right:2px}
.atl-model{font-weight:550;color:var(--ink2)}
.atl-model.on{border-color:rgba(6,182,212,.4);color:var(--cyan-d);background:rgba(6,182,212,.08)}
.atl-model.off{opacity:.5;cursor:not-allowed}
.atl-avv{margin-left:6px;font-size:9px;font-weight:700;letter-spacing:.04em;padding:1px 5px;border-radius:6px;background:var(--amber-bg);color:var(--amber)}
.atl-examples{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.atl-ex{font-weight:500;color:var(--ink2);max-width:100%}
.atl-ex:hover{color:var(--ink);border-color:var(--line2)}

.atl-err{margin:16px 0 0}

.atl-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;margin-top:18px;align-items:start}
@media(max-width:900px){.atl-grid{grid-template-columns:1fr}}

.atl-answer{padding:20px 22px;min-height:220px}
.atl-answer-head{display:flex;align-items:center;gap:10px}
.atl-answer-head .sect{flex:1}
.atl-livebadge{animation:atl-pulse 1.4s ease-in-out infinite}
@keyframes atl-pulse{50%{opacity:.45}}
.atl-via{font-weight:600;font-size:10.5px}
.atl-via-local{background:rgba(6,182,212,.1);color:var(--cyan-d);border-color:rgba(6,182,212,.3)}
.atl-via-cloud{background:var(--amber-bg);color:var(--amber)}
.atl-copy{width:auto}
.atl-copy .ic{width:30px;height:30px;border-radius:9px}
.atl-copy .ic svg{width:15px;height:15px}
.atl-q{font-size:16px;font-weight:600;letter-spacing:-.015em;color:var(--ink);margin:14px 0 12px;line-height:1.4}
.atl-prose{font-size:14.5px;line-height:1.7;color:var(--prose);white-space:pre-wrap;word-break:break-word;max-height:440px;overflow:auto}
.atl-cite{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 4px;margin:0 1px;vertical-align:baseline;font-size:10.5px;font-weight:700;line-height:1;color:var(--cyan-d);background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.28);border-radius:6px;cursor:pointer;transition:background .15s,transform .15s;font-variant-numeric:tabular-nums}
.atl-cite:hover{background:rgba(6,182,212,.22);transform:translateY(-1px)}
.atl-thinking{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--ink2);font-size:13.5px;padding:24px 0}
.atl-caret{display:inline-block;width:8px;height:1.05em;vertical-align:text-bottom;margin-left:2px;background:var(--cyan);border-radius:2px;animation:atl-blink 1s steps(2) infinite}
@keyframes atl-blink{50%{opacity:0}}

.atl-sources{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;position:sticky;top:8px}
.atl-nosrc{font-size:13px;color:var(--ink3);padding:14px 2px 4px;line-height:1.5}
.atl-srclist{margin-top:12px;gap:9px}
.atl-src{position:relative;display:flex;align-items:flex-start;gap:10px;padding:11px 11px 11px 12px;border:1px solid var(--line);border-radius:12px;background:var(--fill-weak)}
.atl-src.cited{border-color:rgba(6,182,212,.28)}
.atl-src.is-open{cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s,box-shadow .18s}
.atl-src.is-open:hover{transform:translateY(-1px);border-color:rgba(6,182,212,.45);box-shadow:0 6px 18px -12px rgba(6,182,212,.5)}
.atl-src.is-open:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
.atl-src.flash{animation:atl-flash 1.3s ease-out}
@keyframes atl-flash{0%,30%{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(6,182,212,.22)}100%{border-color:var(--line);box-shadow:none}}
.atl-src-n{flex:none;width:18px;height:18px;margin-top:1px;display:grid;place-items:center;font-size:10.5px;font-weight:700;color:var(--ink3);background:var(--fill-soft);border-radius:6px;font-variant-numeric:tabular-nums}
.atl-src.cited .atl-src-n{color:var(--cyan-d);background:rgba(6,182,212,.1)}
.atl-src-ic{width:28px;height:28px;border-radius:9px;flex:none;display:grid;place-items:center;background:rgba(6,182,212,.11);color:var(--cyan-d)}
.atl-src-ic svg{width:15px;height:15px}
.atl-src-tx{flex:1;min-width:0}
.atl-src-title{font-size:13px;font-weight:600;letter-spacing:-.01em;line-height:1.32;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.atl-src-tag{font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 5px;border-radius:5px;background:rgba(6,182,212,.12);color:var(--cyan-d)}
.atl-src-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;font-size:10.5px;color:var(--ink3)}
.atl-src-loc{color:var(--cyan-d);font-weight:600}
.atl-src-noorig{font-style:italic}
.atl-src-snip{font-size:11.5px;color:var(--ink3);margin-top:5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.atl-src-actions{flex:none;display:flex;flex-direction:column;gap:5px;align-items:center}
.atl-src-act{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;border:1px solid var(--line);background:var(--fill-weak);color:var(--ink2);cursor:pointer;transition:color .15s,border-color .15s,background .15s}
.atl-src-act:hover{color:var(--cyan-d);border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.08)}
.atl-src-act svg{width:14px;height:14px}
@media (prefers-reduced-motion:reduce){.atl-livebadge,.atl-caret,.atl-src.flash{animation:none}.atl-src.is-open:hover{transform:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "atlas",
    name: "Atlas",
    version: "1.1.0",
    description: "Cited retrieval over your workspace knowledge — open every source.",
    icon: ICON,
    permissions: ["backend:atlas-api", "storage", "files"],
    nav: { section: "core", order: 2 },
    commands: [{ id: "open", title: "Go to Atlas" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<AtlasView host={host} />);
    offCmd = host.events.on("command:atlas:open", () =>
      host.nav.navigate("atlas")
    );
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
