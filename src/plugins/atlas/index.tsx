/**
 * Atlas — cited-RAG console.
 *
 * A native Subunit Liquid Glass question→answer surface over the workspace
 * knowledge base. The question .fld posts to atlas-api via host.backend.sse
 * ("/api/m/ask"); streamed tokens build the answer area, and `source`/`citation`
 * events accumulate into a sources list. Calm, light-default, ONE cyan accent —
 * NOT the old atlas-web violet skin.
 *
 * The SSE contract is intentionally tolerant: it accepts the common shapes a RAG
 * endpoint emits (token/delta/answer for prose; sources/source/citations for the
 * reference list; done/end to finish) so it lights up against the real backend
 * without a server change, and degrades to a clean error card if unreachable.
 *
 * Permissions: backend:atlas-api, storage.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule, SseMessage } from "../../plugin/types";

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
  copy: "M9 9h10v10H9z|5 15V5h10",
};

interface Source {
  id: string;
  title: string;
  url?: string;
  snippet?: string;
  score?: number;
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
    // Some backends send the raw token as the data line.
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

// Best-effort extraction of one-or-many sources from a streamed SSE message.
function extractSources(msg: SseMessage): Source[] {
  const d = msg.data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return [];
  const raw =
    (Array.isArray(d) ? d : null) ??
    (Array.isArray((d as Record<string, unknown>).sources)
      ? ((d as Record<string, unknown>).sources as unknown[])
      : null) ??
    (Array.isArray((d as Record<string, unknown>).citations)
      ? ((d as Record<string, unknown>).citations as unknown[])
      : null) ??
    (msg.event === "source" || msg.event === "citation" ? [d] : null);
  if (!raw) return [];
  return raw.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? o.url ?? `src-${i}`),
      title: String(o.title ?? o.name ?? o.url ?? `Quelle ${i + 1}`),
      url: typeof o.url === "string" ? o.url : undefined,
      snippet:
        typeof o.snippet === "string"
          ? o.snippet
          : typeof o.text === "string"
            ? o.text
            : undefined,
      score: typeof o.score === "number" ? o.score : undefined,
    };
  });
}

function AtlasView({ host }: { host: HostApi }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asked, setAsked] = useState("");
  const answerRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>("");

  useEffect(() => {
    const el = answerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

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
        setModels(data.models ?? []);
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

  const ask = useCallback(
    async (q: string) => {
      const query = q.trim();
      if (!query || busy) return;
      cancelRef.current = false;
      setBusy(true);
      setError(null);
      setAnswer("");
      setSources([]);
      setAsked(query);
      try {
        const stream = host.backend.sse("atlas-api", "/api/m/ask", {
          query,
          ...(model ? { model } : {}),
          top_k: 8,
        });
        for await (const msg of stream) {
          if (cancelRef.current) break;
          if (msg.event === "error") {
            const d = msg.data as Record<string, unknown> | string;
            setError(typeof d === "string" ? d : String((d as Record<string, unknown>)?.message ?? "Stream error"));
            continue;
          }
          if (msg.event === "done" || msg.event === "end") break;
          const tok = extractToken(msg);
          if (tok) setAnswer((a) => a + tok);
          const srcs = extractSources(msg);
          if (srcs.length)
            setSources((prev) => {
              const seen = new Set(prev.map((s) => s.id));
              return [...prev, ...srcs.filter((s) => !seen.has(s.id))];
            });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy, host, model]
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

  return (
    <div className="atl">
      <AtlasStyle />

      <div className="atl-hero">
        <h1>Atlas</h1>
        <p>
          Frag den Workspace. Antworten kommen mit Belegen aus unseren
          eingespeisten Quellen — nichts erfunden.
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
                  {answer}
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
                {sources.map((s) => (
                  <li
                    key={s.id}
                    className={`atl-src${s.url ? " is-link" : ""}`}
                    onClick={() => s.url && host.ui.openExternal(s.url)}
                  >
                    <span className="atl-src-ic">
                      <Svg d={s.url ? ICONS.link : ICONS.doc} />
                    </span>
                    <div className="atl-src-tx">
                      <div className="atl-src-title">{s.title}</div>
                      {s.snippet && (
                        <div className="atl-src-snip">{s.snippet}</div>
                      )}
                    </div>
                    {typeof s.score === "number" && (
                      <span className="badge atl-score">
                        {Math.round(s.score * 100)}%
                      </span>
                    )}
                  </li>
                ))}
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
.atl-hero p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:52ch;letter-spacing:-.006em}

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

.atl-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;margin-top:18px;align-items:start}
@media(max-width:900px){.atl-grid{grid-template-columns:1fr}}

.atl-answer{padding:20px 22px;min-height:220px}
.atl-answer-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.atl-livebadge{animation:atl-pulse 1.4s ease-in-out infinite}
@keyframes atl-pulse{50%{opacity:.45}}
.atl-copy{width:auto}
.atl-copy .ic{width:30px;height:30px;border-radius:9px}
.atl-copy .ic svg{width:15px;height:15px}
.atl-q{font-size:16px;font-weight:600;letter-spacing:-.015em;color:var(--ink);margin:14px 0 12px;line-height:1.4}
.atl-prose{font-size:14.5px;line-height:1.65;color:var(--prose);white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
.atl-thinking{display:flex;flex-direction:column;align-items:center;gap:10px;color:var(--ink2);font-size:13.5px;padding:24px 0}
.atl-caret{display:inline-block;width:8px;height:1.05em;vertical-align:text-bottom;margin-left:2px;background:var(--cyan);border-radius:2px;animation:atl-blink 1s steps(2) infinite}
@keyframes atl-blink{50%{opacity:0}}

.atl-sources{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;position:sticky;top:8px}
.atl-nosrc{font-size:13px;color:var(--ink3);padding:14px 2px 4px;line-height:1.5}
.atl-srclist{margin-top:12px;gap:9px}
.atl-src{align-items:flex-start;gap:11px}
.atl-src.is-link{cursor:pointer;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s}
.atl-src.is-link:hover{transform:translateY(-1px);border-color:rgba(6,182,212,.4)}
.atl-src-ic{width:30px;height:30px;border-radius:9px;flex:none;display:grid;place-items:center;background:rgba(6,182,212,.11);color:var(--cyan-d)}
.atl-src-ic svg{width:16px;height:16px}
.atl-src-tx{flex:1;min-width:0}
.atl-src-title{font-size:13.5px;font-weight:600;letter-spacing:-.01em;line-height:1.3}
.atl-src-snip{font-size:11.5px;color:var(--ink3);margin-top:4px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.atl-score{flex:none;align-self:center}
@media (prefers-reduced-motion:reduce){.atl-livebadge,.atl-caret{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "atlas",
    name: "Atlas",
    version: "1.0.0",
    description: "Cited retrieval over your workspace knowledge.",
    icon: ICON,
    permissions: ["backend:atlas-api", "storage"],
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
