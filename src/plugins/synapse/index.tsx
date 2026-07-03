/**
 * Synapse — the ingest + knowledge cockpit that FEEDS the brain Atlas reads.
 *
 * Three tabs over atlas-api's durable funnel:
 *   · Einspeisen  — pick a channel (Dokument/URL/YouTube/Text/Social), hand it a source,
 *                   POST /api/m/ingest/:channel → 202 {job_id}. A live pipeline panel polls
 *                   GET /api/m/jobs (queued → processing → done). The moment a job is "Im
 *                   Index" it is citable in Atlas. Dokument = real multipart file upload.
 *   · Review      — the Axon queue (GET /api/m/axon/pending): operator confirms a source
 *                   (keep) or discards it (POST .../discard + erase the doc from the brain).
 *   · Wissensbasis— everything ingested (GET /api/m/docs): open the original (file→default
 *                   app, url→browser) or erase it (DELETE /api/m/docs/:id — operator-aware,
 *                   purges the vectors from the brain too).
 *
 * Native Subunit Liquid Glass, ONE cyan accent, DSGVO-local (no cloud round-trip).
 *
 * Permissions: backend:atlas-api (the funnel) + notifications + files (open originals).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

// Datenkrake — the Synapse mark (giant squid), recolored via a CSS mask (.syn-dockmark).
const ICON = `<span class="syn-dockmark" aria-hidden="true"></span>`;

const Svg = (props: { d: string; w?: number }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={props.w ?? 1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={/^\s*[Mm]/.test(p) ? p : `M${p}`} />
    ))}
  </svg>
);

const CHECK = (
  <svg viewBox="0 0 24 24">
    <path d="M5 13l4 4L19 7" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ICONS = {
  doc: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 13h6|9 17h4",
  link: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5|14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
  play: "M22 8.6a3 3 0 0 0-2.1-2.1C18 6 12 6 12 6s-6 0-7.9.5A3 3 0 0 0 2 8.6 31 31 0 0 0 2 12a31 31 0 0 0 .1 3.4 3 3 0 0 0 2.1 2.1C6 18 12 18 12 18s6 0 7.9-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.1-3.4Z|10 9.5l5 2.5-5 2.5z",
  text: "M4 6h16|4 12h16|4 18h10",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z|3 12h18|12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18",
  open: "M14 3h7v7|M21 3l-9 9|M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5",
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  trash: "M3 6h18|8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2|19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6|10 11v6|14 11v6",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18|6 6l12 12",
  arrow: "M5 12h14|13 5l7 7-7 7",
  ask: "M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z",
};

// ── channels (Einspeisen) ────────────────────────────────────────────────────

type ChannelId = "document" | "url" | "youtube" | "text" | "social";
type Mode = "file" | "input" | "area";

interface Channel {
  id: ChannelId;
  title: string;
  desc: string;
  icon: string;
  mode: Mode;
  placeholder?: string;
  accept?: string;
}

const CHANNELS: Channel[] = [
  {
    id: "document",
    title: "Dokument",
    desc: "PDF, DOCX, Text, MD",
    icon: ICONS.doc,
    mode: "file",
    accept: ".pdf,.docx,.txt,.text,.md,.markdown,.rst,.rtf,.log,.csv,.tsv",
  },
  { id: "url", title: "URL", desc: "Webseite einlesen", icon: ICONS.link, mode: "input", placeholder: "https://…" },
  {
    id: "youtube",
    title: "YouTube",
    desc: "Transkript ziehen",
    icon: ICONS.play,
    mode: "input",
    placeholder: "https://youtube.com/watch?v=…",
  },
  {
    id: "text",
    title: "Text",
    desc: "Direkt einfügen",
    icon: ICONS.text,
    mode: "area",
    placeholder: "Text hier einfügen — wird als zitierfähige Notiz indexiert…",
  },
  {
    id: "social",
    title: "Social",
    desc: "Instagram, TikTok, X",
    icon: ICONS.globe,
    mode: "input",
    placeholder: "Link zum Beitrag (Instagram, TikTok, X …)",
  },
];

// ── jobs / pending / docs ─────────────────────────────────────────────────────

interface Job {
  job_id: string;
  channel: string;
  status: string;
  doc_id?: string | null;
  error?: string | null;
  source: string;
  created_at?: string;
}

interface Pending {
  id: string;
  job_id?: string | null;
  doc_id?: string | null;
  title: string;
  preview: string;
  created_at?: string;
}

interface Doc {
  doc_id: string;
  title: string;
  source_type: string;
  source_uri?: string | null;
  source_url?: string | null;
  channel: string;
  raw_path?: string | null;
  bytes?: number | null;
  captured_at?: string;
}

const isActive = (s: string) => s === "queued" || s === "processing";

function jobPill(status: string): { cls: string; label: string } {
  switch (status) {
    case "done":
      return { cls: "ok", label: "Im Index" };
    case "processing":
      return { cls: "proc", label: "Verarbeitet…" };
    case "queued":
      return { cls: "q", label: "Wartet" };
    case "skipped":
      return { cls: "skip", label: "Übersprungen" };
    case "error":
      return { cls: "err", label: "Fehler" };
    default:
      return { cls: "q", label: status };
  }
}

const CHANNEL_LABEL: Record<string, string> = {
  document: "Dokument",
  url: "URL",
  youtube: "YouTube",
  text: "Text",
  social: "Social",
  voice: "Sprache",
  meeting: "Meeting",
};

/** Pick a source-type icon. */
function typeIcon(t: string, hasFile: boolean): string {
  if (hasFile || t === "document" || t === "voice") return ICONS.doc;
  if (t === "youtube") return ICONS.play;
  if (t === "social") return ICONS.globe;
  if (t === "url") return ICONS.link;
  return ICONS.text;
}

function fmtBytes(n?: number | null): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "short", year: "numeric" });
}

function trimErr(e: string): string {
  return e.length > 80 ? `${e.slice(0, 77)}…` : e;
}

type Tab = "ingest" | "review" | "library";

function SynapseView({ host }: { host: HostApi }) {
  const [tab, setTab] = useState<Tab>("ingest");

  // Einspeisen state
  const [channel, setChannel] = useState<ChannelId>("document");
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // shared data
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [busy, setBusy] = useState<Set<string>>(() => new Set()); // per-row actions in flight
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  const wasActive = useRef(false);

  const active = CHANNELS.find((c) => c.id === channel)!;

  // ── refreshers ──────────────────────────────────────────────────────────────
  const refreshJobs = useCallback(async () => {
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/jobs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { jobs?: Job[] };
      setJobs(data.jobs ?? []);
      setJobsErr(null);
    } catch (err) {
      setJobsErr(err instanceof Error ? err.message : String(err));
    }
  }, [host]);

  const refreshPending = useCallback(async () => {
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/axon/pending");
      if (!res.ok) return;
      const data = (await res.json()) as { pending?: Pending[] };
      setPending(data.pending ?? []);
    } catch {
      /* badge stays as-is */
    }
  }, [host]);

  const refreshDocs = useCallback(async () => {
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/docs?limit=200");
      if (!res.ok) return;
      const data = (await res.json()) as { docs?: Doc[] };
      setDocs(data.docs ?? []);
    } catch {
      /* keep last */
    }
  }, [host]);

  // initial load (populates the tab badges)
  useEffect(() => {
    void refreshJobs();
    void refreshPending();
    void refreshDocs();
  }, [refreshJobs, refreshPending, refreshDocs]);

  // jobs heartbeat: fast while in flight, slow when idle. When a batch finishes
  // (active → idle), refresh docs + pending so the library/review reflect new sources.
  useEffect(() => {
    const anyActive = jobs.some((j) => isActive(j.status));
    if (wasActive.current && !anyActive) {
      void refreshDocs();
      void refreshPending();
    }
    wasActive.current = anyActive;
    const id = setInterval(() => void refreshJobs(), anyActive ? 1500 : 8000);
    return () => clearInterval(id);
  }, [jobs, refreshJobs, refreshDocs, refreshPending]);

  // light poll of the active tab's list
  useEffect(() => {
    if (tab === "review") {
      void refreshPending();
      const id = setInterval(() => void refreshPending(), 5000);
      return () => clearInterval(id);
    }
    if (tab === "library") {
      void refreshDocs();
    }
  }, [tab, refreshPending, refreshDocs]);

  // ── Einspeisen submit ─────────────────────────────────────────────────────────
  const pickChannel = useCallback((id: ChannelId) => {
    setChannel(id);
    setSource("");
    setFile(null);
    setSubmitErr(null);
  }, []);

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitErr(null);

    let path: string;
    let init: RequestInit;
    let label: string;

    if (active.mode === "file") {
      if (!file) {
        setSubmitErr("Wähle zuerst eine Datei.");
        return;
      }
      const form = new FormData();
      form.append("file", file);
      form.append("title", file.name);
      path = "/api/m/ingest/document";
      init = { method: "POST", body: form }; // no Content-Type → browser sets the boundary
      label = file.name;
    } else {
      const src = source.trim();
      if (!src) return;
      const isHttp = /^https?:\/\//i.test(src);
      if (channel === "url" || channel === "youtube" || channel === "social") {
        // social scrapes the post's meta (og:description) → it needs the post URL.
        if (!isHttp) {
          setSubmitErr("Bitte eine vollständige http(s)-URL angeben.");
          return;
        }
        path = `/api/m/ingest/${channel}`;
        init = jsonPost({ url: src });
      } else {
        path = "/api/m/ingest/text";
        init = jsonPost({ text: src, title: src.slice(0, 60).trim() || "Notiz" });
      }
      label = src;
    }

    setSubmitting(true);
    try {
      const res = await host.backend.fetch("atlas-api", path, init);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { detail?: string; error?: string };
          detail = body.detail || body.error || detail;
        } catch {
          /* keep status */
        }
        throw new Error(detail);
      }
      setSource("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      host.notifications.notify("An Synapse übergeben", `${active.title}: ${label}`);
      await refreshJobs();
    } catch (err) {
      setSubmitErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [active, channel, file, host, refreshJobs, source, submitting]);

  const canSubmit = active.mode === "file" ? !!file : !!source.trim();

  // ── Review actions ────────────────────────────────────────────────────────────
  const mark = (id: string, on: boolean) =>
    setBusy((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const confirmReview = useCallback(
    async (p: Pending) => {
      mark(p.id, true);
      try {
        const res = await host.backend.fetch("atlas-api", `/api/m/axon/confirm/${p.id}`, { method: "POST" });
        if (res.ok) setPending((ps) => ps.filter((x) => x.id !== p.id));
      } finally {
        mark(p.id, false);
      }
    },
    [host]
  );

  // Discard erases the source server-side (the /discard endpoint owns the doc lifecycle:
  // it deletes only a doc THIS job created, never a deduped original, and only on success).
  const discardReview = useCallback(
    async (p: Pending) => {
      mark(p.id, true);
      try {
        const res = await host.backend.fetch("atlas-api", `/api/m/axon/discard/${p.id}`, { method: "POST" });
        if (res.ok) {
          setPending((ps) => ps.filter((x) => x.id !== p.id));
          void refreshDocs();
        } else if (res.status === 409) {
          // Job still indexing — leave the row and tell the operator to retry.
          host.notifications.notify("Noch in Verarbeitung", "Quelle wird noch indexiert — gleich nochmal „Verwerfen“.");
        }
      } finally {
        mark(p.id, false);
      }
    },
    [host, refreshDocs]
  );

  // ── Library actions ───────────────────────────────────────────────────────────
  const openDoc = useCallback(
    (d: Doc) => {
      const url = d.source_url || (d.source_uri && /^https?:\/\//i.test(d.source_uri) ? d.source_uri : null);
      if (d.raw_path) host.ui.openPath(d.raw_path);
      else if (url) host.ui.openExternal(url);
    },
    [host]
  );

  const canOpen = (d: Doc) =>
    !!(d.raw_path || d.source_url || (d.source_uri && /^https?:\/\//i.test(d.source_uri)));

  const deleteDoc = useCallback(
    async (d: Doc) => {
      mark(d.doc_id, true);
      try {
        const res = await host.backend.fetch("atlas-api", `/api/m/docs/${d.doc_id}`, { method: "DELETE" });
        if (res.ok) {
          setDocs((ds) => ds.filter((x) => x.doc_id !== d.doc_id));
          void refreshPending();
        }
      } finally {
        mark(d.doc_id, false);
        setConfirmDel(null);
      }
    },
    [host, refreshPending]
  );

  const indexed = jobs.filter((j) => j.status === "done").length;

  return (
    <div className="syn">
      <SynapseStyle />

      <div className="syn-hero">
        <span className="syn-mark" aria-hidden="true" />
        <div className="syn-hero-tx">
          <h1>Synapse</h1>
          <p>
            Die Datenkrake. Speise Wissen ein, prüfe Quellen, verwalte die Wissensbasis —
            alles fließt in dieselbe Brain, die Atlas mit Beleg abfragt.
          </p>
        </div>
        <button className="syn-toatlas" title="Zu Atlas" onClick={() => host.nav.navigate("atlas")}>
          <Svg d={ICONS.ask} w={1.9} />
          In Atlas fragen
        </button>
      </div>

      {/* ── tab bar ── */}
      <div className="syn-tabs">
        <TabBtn id="ingest" cur={tab} set={setTab} label="Einspeisen" />
        <TabBtn id="review" cur={tab} set={setTab} label="Review" badge={pending.length || undefined} />
        <TabBtn id="library" cur={tab} set={setTab} label="Wissensbasis" badge={docs.length || undefined} />
      </div>

      {/* ── Einspeisen ── */}
      {tab === "ingest" && (
        <div className="syn-grid">
          <section className="card syn-funnel">
            <div className="sect" style={{ marginTop: 0 }}>
              Kanal
            </div>
            <div className="tiles syn-tiles">
              {CHANNELS.map((c) => (
                <button key={c.id} className={`tile${c.id === channel ? " sel" : ""}`} onClick={() => pickChannel(c.id)}>
                  <span className="ck">{CHECK}</span>
                  <span className="ic">
                    <Svg d={c.icon} />
                  </span>
                  <div className="tt">{c.title}</div>
                  <div className="ds">{c.desc}</div>
                </button>
              ))}
            </div>

            <div className="sect">Quelle</div>

            {active.mode === "file" ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={active.accept}
                  style={{ display: "none" }}
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setSubmitErr(null);
                  }}
                />
                <button className={`syn-drop${file ? " has" : ""}`} onClick={() => fileInputRef.current?.click()}>
                  <span className="syn-drop-ic">
                    <Svg
                      d={file ? "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 15l2 2 4-4" : "M12 16V4|7 9l5-5 5 5|4 20h16"}
                    />
                  </span>
                  {file ? (
                    <div className="syn-drop-tx">
                      <b>{file.name}</b>
                      <span>{fmtBytes(file.size)} · Klicken zum Ändern</span>
                    </div>
                  ) : (
                    <div className="syn-drop-tx">
                      <b>Datei wählen</b>
                      <span>PDF, DOCX, TXT, Markdown, CSV …</span>
                    </div>
                  )}
                </button>
              </>
            ) : active.mode === "area" ? (
              <textarea
                className="fld syn-area"
                placeholder={active.placeholder}
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            ) : (
              <input
                className="fld"
                placeholder={active.placeholder}
                value={source}
                onChange={(e) => setSource(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void submit();
                  }
                }}
              />
            )}

            {submitErr && (
              <div className="syn-note err" style={{ marginTop: 12 }}>
                {submitErr}
              </div>
            )}

            <button className="btn btn-primary syn-submit" disabled={!canSubmit || submitting} onClick={() => void submit()}>
              {submitting ? (
                <>Speise ein…</>
              ) : (
                <>
                  <svg className="stroke" viewBox="0 0 24 24">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                  Einspeisen
                </>
              )}
            </button>
            <div className="syn-foot">Lokal eingebettet, in der Subunit-Brain gespeichert — kein Cloud-Umweg.</div>
          </section>

          <aside className="syn-side">
            <div className="syn-side-head">
              <div className="sect" style={{ margin: 0 }}>
                Pipeline {jobs.length > 0 && <span className="badge">{jobs.length}</span>}
              </div>
              {indexed > 0 && <span className="syn-chip">{indexed} im Index</span>}
            </div>

            {jobsErr && jobs.length === 0 ? (
              <div className="syn-note err" style={{ marginTop: 12 }}>
                Pipeline nicht erreichbar: {jobsErr}
              </div>
            ) : jobs.length === 0 ? (
              <div className="syn-empty">
                <span className="syn-empty-ic">
                  <Svg d="M4 7h16|4 12h16|4 17h10" />
                </span>
                <b>Bereit</b>
                <span>Eingespeiste Quellen laufen hier durch — live von „Wartet“ bis „Im Index“.</span>
              </div>
            ) : (
              <ul className="syn-list">
                {jobs.map((j) => {
                  const pill = jobPill(j.status);
                  return (
                    <li key={j.job_id} className="syn-row">
                      <div className="syn-row-tx">
                        <div className="syn-row-t">{j.source || (CHANNEL_LABEL[j.channel] ?? j.channel)}</div>
                        <div className="syn-row-m">
                          {CHANNEL_LABEL[j.channel] ?? j.channel}
                          {j.status === "error" && j.error ? ` · ${trimErr(j.error)}` : ""}
                          {j.status === "skipped" ? " · bereits im Index" : ""}
                        </div>
                      </div>
                      <span className={`syn-pill ${pill.cls}`}>
                        {isActive(j.status) && <span className="syn-dot" />}
                        {pill.label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </aside>
        </div>
      )}

      {/* ── Review ── */}
      {tab === "review" && (
        <section className="card syn-pane">
          <div className="syn-pane-head">
            <div className="sect" style={{ margin: 0 }}>
              Zu prüfen {pending.length > 0 && <span className="badge">{pending.length}</span>}
            </div>
            <p className="syn-pane-sub">
              Web-, Social- und Dokument-Quellen landen zur Freigabe hier. Bestätigen = behalten,
              Verwerfen = aus der Brain entfernen.
            </p>
          </div>
          {pending.length === 0 ? (
            <div className="syn-empty pad">
              <span className="syn-empty-ic">
                <Svg d={ICONS.check} w={2} />
              </span>
              <b>Alles geprüft</b>
              <span>Keine offenen Quellen in der Warteschlange.</span>
            </div>
          ) : (
            <ul className="syn-list big">
              {pending.map((p) => (
                <li key={p.id} className="syn-row card-row">
                  <div className="syn-row-tx">
                    <div className="syn-row-t">{p.title || "Ohne Titel"}</div>
                    {p.preview && <div className="syn-row-prev">{p.preview}</div>}
                  </div>
                  <div className="syn-row-acts">
                    <button
                      className="syn-act ok"
                      disabled={busy.has(p.id)}
                      title="Bestätigen — behalten"
                      onClick={() => void confirmReview(p)}
                    >
                      <Svg d={ICONS.check} w={2} />
                    </button>
                    <button
                      className="syn-act danger"
                      disabled={busy.has(p.id)}
                      title="Verwerfen — aus der Brain entfernen"
                      onClick={() => void discardReview(p)}
                    >
                      <Svg d={ICONS.x} w={2} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── Wissensbasis ── */}
      {tab === "library" && (
        <section className="card syn-pane">
          <div className="syn-pane-head">
            <div className="sect" style={{ margin: 0 }}>
              Eingespeiste Quellen {docs.length > 0 && <span className="badge">{docs.length}</span>}
            </div>
            <p className="syn-pane-sub">Alles, was Atlas durchsuchen kann. Öffne das Original oder lösche eine Quelle (DSGVO).</p>
          </div>
          {docs.length === 0 ? (
            <div className="syn-empty pad">
              <span className="syn-empty-ic">
                <Svg d={ICONS.doc} />
              </span>
              <b>Noch leer</b>
              <span>Speise im Tab „Einspeisen“ die erste Quelle ein.</span>
            </div>
          ) : (
            <ul className="syn-list big">
              {docs.map((d) => {
                const openable = canOpen(d);
                const isFile = !!d.raw_path;
                const confirming = confirmDel === d.doc_id;
                return (
                  <li key={d.doc_id} className="syn-row card-row">
                    <span className="syn-row-ic">
                      <Svg d={typeIcon(d.source_type, isFile)} />
                    </span>
                    <div className="syn-row-tx">
                      <div className="syn-row-t">{d.title || d.doc_id}</div>
                      <div className="syn-row-m">
                        {CHANNEL_LABEL[d.channel] ?? d.channel}
                        {fmtDate(d.captured_at) ? ` · ${fmtDate(d.captured_at)}` : ""}
                        {fmtBytes(d.bytes) ? ` · ${fmtBytes(d.bytes)}` : ""}
                      </div>
                    </div>
                    <div className="syn-row-acts">
                      {confirming ? (
                        <>
                          <span className="syn-confirm">Löschen?</span>
                          <button
                            className="syn-act danger"
                            disabled={busy.has(d.doc_id)}
                            title="Endgültig löschen"
                            onClick={() => void deleteDoc(d)}
                          >
                            <Svg d={ICONS.check} w={2} />
                          </button>
                          <button className="syn-act" title="Abbrechen" onClick={() => setConfirmDel(null)}>
                            <Svg d={ICONS.x} w={2} />
                          </button>
                        </>
                      ) : (
                        <>
                          {openable && (
                            <button
                              className="syn-act"
                              title={isFile ? "Dokument öffnen" : "Im Browser öffnen"}
                              onClick={() => openDoc(d)}
                            >
                              <Svg d={ICONS.open} />
                            </button>
                          )}
                          {isFile && (
                            <button className="syn-act" title="Im Finder zeigen" onClick={() => host.ui.revealPath(d.raw_path!)}>
                              <Svg d={ICONS.folder} />
                            </button>
                          )}
                          <button className="syn-act danger" title="Löschen" onClick={() => setConfirmDel(d.doc_id)}>
                            <Svg d={ICONS.trash} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function TabBtn({ id, cur, set, label, badge }: { id: Tab; cur: Tab; set: (t: Tab) => void; label: string; badge?: number }) {
  return (
    <button className={`syn-tab${cur === id ? " on" : ""}`} onClick={() => set(id)}>
      {label}
      {badge != null && <span className="syn-tab-b">{badge}</span>}
    </button>
  );
}

function SynapseStyle() {
  return (
    <style>{`
.syn{width:100%;max-width:1040px;margin:0 auto;padding:26px 28px 56px}
.syn-hero{display:flex;align-items:center;gap:18px;margin:6px 2px 18px}
.syn-mark{flex:none;width:62px;height:62px;background:linear-gradient(155deg,var(--cyan),var(--cyan-ink));-webkit-mask:url(/synapse-squid.png) center/contain no-repeat;mask:url(/synapse-squid.png) center/contain no-repeat;filter:drop-shadow(0 7px 18px rgba(6,182,212,.38))}
.syn-hero-tx{min-width:0;flex:1}
.syn-hero h1{font-size:29px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.syn-hero p{font-size:14px;color:var(--ink2);line-height:1.5;margin-top:7px;max-width:54ch;letter-spacing:-.006em}
.syn-toatlas{flex:none;align-self:flex-start;display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--cyan-d);background:rgba(6,182,212,.09);border:1px solid rgba(6,182,212,.26);padding:8px 12px;border-radius:10px;cursor:pointer;transition:.16s}
.syn-toatlas:hover{background:rgba(6,182,212,.16);border-color:rgba(6,182,212,.4);transform:translateY(-1px)}
.syn-toatlas svg{width:14px;height:14px;fill:none;stroke:currentColor}

.syn-tabs{display:flex;gap:4px;margin:0 2px 18px;border-bottom:1px solid var(--line)}
.syn-tab{position:relative;display:inline-flex;align-items:center;gap:7px;padding:10px 14px 12px;font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink3);background:none;border:none;cursor:pointer;transition:color .15s}
.syn-tab:hover{color:var(--ink2)}
.syn-tab.on{color:var(--cyan-d)}
.syn-tab.on::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;border-radius:2px;background:var(--cyan)}
.syn-tab-b{min-width:18px;height:18px;padding:0 5px;display:inline-grid;place-items:center;font-size:10.5px;font-weight:700;border-radius:999px;background:var(--fill-soft);color:var(--ink3);font-variant-numeric:tabular-nums}
.syn-tab.on .syn-tab-b{background:rgba(6,182,212,.14);color:var(--cyan-d)}

.syn-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}
@media(max-width:900px){.syn-grid{grid-template-columns:1fr}}
.syn-funnel{padding:20px 22px}
.syn-tiles{flex-wrap:wrap}
.syn-tiles .tile{min-width:108px;flex:1}
.syn-area{min-height:118px;resize:vertical;line-height:1.5;font-size:14.5px}
.syn-submit{margin-top:18px}
.syn-foot{margin-top:12px;font-size:11.5px;color:var(--ink3);text-align:center}

.syn-note{font-size:11.5px;border-radius:12px;padding:9px 11px;line-height:1.4}
.syn-note.err{color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-line)}

.syn-drop{width:100%;display:flex;align-items:center;gap:14px;text-align:left;padding:16px;border:1.5px dashed var(--line2,rgba(120,140,170,.4));border-radius:14px;background:var(--fill-weak);cursor:pointer;transition:.18s}
.syn-drop:hover{border-color:rgba(6,182,212,.5);background:rgba(6,182,212,.05)}
.syn-drop.has{border-style:solid;border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.06)}
.syn-drop-ic{width:46px;height:46px;flex:none;border-radius:13px;display:grid;place-items:center;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.syn-drop-ic svg{width:23px;height:23px;fill:none;stroke:currentColor}
.syn-drop-tx{min-width:0}
.syn-drop-tx b{display:block;font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-drop-tx span{font-size:11.5px;color:var(--ink3)}

.syn-side{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;position:sticky;top:8px}
.syn-side-head{display:flex;align-items:center;justify-content:space-between}
.syn-chip{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--cyan-d);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.24);padding:3px 8px;border-radius:7px}

.syn-pane{padding:20px 22px}
.syn-pane-head{margin-bottom:6px}
.syn-pane-sub{font-size:12.5px;color:var(--ink3);line-height:1.5;margin-top:6px;max-width:64ch}

.syn-empty{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;color:var(--ink2);font-size:12.5px;padding:30px 10px 18px}
.syn-empty.pad{padding:46px 10px}
.syn-empty b{font-size:14px;font-weight:600;color:var(--ink)}
.syn-empty span{max-width:30ch;line-height:1.5}
.syn-empty-ic{width:46px;height:46px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.syn-empty-ic svg{width:23px;height:23px;fill:none;stroke:currentColor}

.syn-list{list-style:none;padding:0;margin:12px 0 0;display:flex;flex-direction:column;gap:9px}
.syn-list.big{margin-top:16px;gap:10px}
.syn-row{display:flex;align-items:center;gap:11px;padding:11px;border:1px solid var(--line);border-radius:12px;background:var(--fill-weak)}
.syn-row.card-row{padding:13px 14px}
.syn-row-ic{width:34px;height:34px;flex:none;border-radius:10px;display:grid;place-items:center;background:rgba(6,182,212,.11);color:var(--cyan-d)}
.syn-row-ic svg{width:17px;height:17px;fill:none;stroke:currentColor}
.syn-row-tx{flex:1;min-width:0}
.syn-row-t{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-row-m{font-size:11px;color:var(--ink3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-row-prev{font-size:11.5px;color:var(--ink3);margin-top:5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.syn-row-acts{flex:none;display:flex;align-items:center;gap:6px}
.syn-act{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;border:1px solid var(--line);background:var(--fill-weak);color:var(--ink2);cursor:pointer;transition:.15s}
.syn-act:hover{color:var(--cyan-d);border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.08)}
.syn-act.ok:hover{color:var(--ok);border-color:var(--ok-line);background:var(--ok-bg)}
.syn-act.danger:hover{color:var(--amber);border-color:var(--amber-line);background:var(--amber-bg)}
.syn-act:disabled{opacity:.45;cursor:default}
.syn-act svg{width:15px;height:15px;fill:none;stroke:currentColor}
.syn-confirm{font-size:11.5px;font-weight:600;color:var(--amber);margin-right:2px}

.syn-pill{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;padding:4px 9px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.syn-pill.ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}
.syn-pill.proc{color:var(--cyan-d);background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.3)}
.syn-pill.q{color:var(--ink3);background:var(--fill-soft);border-color:var(--line)}
.syn-pill.skip{color:var(--ink3);background:var(--fill-soft);border-color:var(--line)}
.syn-pill.err{color:var(--amber);background:var(--amber-bg);border-color:var(--amber-line)}
.syn-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:syn-pulse 1.1s ease-in-out infinite}
@keyframes syn-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
@media (prefers-reduced-motion:reduce){.syn-dot{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "synapse",
    name: "Synapse",
    version: "3.0.0",
    description: "Ingest + knowledge cockpit — feed, review and manage the brain Atlas reads.",
    icon: ICON,
    permissions: ["backend:atlas-api", "notifications", "files"],
    nav: { section: "core", order: 3 },
    commands: [{ id: "open", title: "Go to Synapse" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<SynapseView host={host} />);
    offCmd = host.events.on("command:synapse:open", () => host.nav.navigate("synapse"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
