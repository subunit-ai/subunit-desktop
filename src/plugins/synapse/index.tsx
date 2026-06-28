/**
 * Synapse — the ingest funnel that FEEDS the brain Atlas reads.
 *
 * Pick a channel (Dokument / URL / YouTube / Text), hand it a source, and it's POSTed
 * to atlas-api's DURABLE ingest funnel (POST /api/m/ingest/:channel → 202 {job_id}).
 * A standalone worker drains the queue (extract → embed → store) into the canonical
 * brain collection, so the moment a job reaches "Im Index" it is citable in Atlas.
 * The pipeline panel polls GET /api/m/jobs, so every source is watched live
 * queued → processing → done. This is the WRITE side of the same loop Atlas reads.
 *
 *   · Dokument → multipart file upload (PDF / DOCX / TXT / MD / CSV …)
 *   · URL / YouTube → JSON {url}
 *   · Text → JSON {text, title}
 *
 * Native Subunit Liquid Glass: selection tiles, a glass field, a live status list,
 * ONE cyan accent. Built for enterprises (DSGVO-local model, no cloud round-trip).
 *
 * Permissions: backend:atlas-api (the funnel) + notifications (least privilege).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

// Datenkrake — the Synapse mark (giant squid). A silhouette recolored to the dock's
// currentColor via a CSS mask (.syn-dockmark in index.css), so it themes + goes cyan when active.
const ICON = `<span class="syn-dockmark" aria-hidden="true"></span>`;

const Svg = (props: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

const CHECK = (
  <svg viewBox="0 0 24 24">
    <path
      d="M5 13l4 4L19 7"
      fill="none"
      stroke="#fff"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** atlas-api ingest channels Synapse drives (each has a real extractor server-side). */
type ChannelId = "document" | "url" | "youtube" | "text";

/** How the source is supplied for a channel. */
type Mode = "file" | "input" | "area";

interface Channel {
  id: ChannelId;
  title: string;
  desc: string;
  icon: string;
  mode: Mode;
  /** Placeholder for input/area modes. */
  placeholder?: string;
  /** accept filter for the file picker (document). */
  accept?: string;
}

const CHANNELS: Channel[] = [
  {
    id: "document",
    title: "Dokument",
    desc: "PDF, DOCX, Text, MD",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 13h6|9 17h4",
    mode: "file",
    accept: ".pdf,.docx,.txt,.text,.md,.markdown,.rst,.rtf,.log,.csv,.tsv",
  },
  {
    id: "url",
    title: "URL",
    desc: "Webseite einlesen",
    icon: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5|14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
    mode: "input",
    placeholder: "https://…",
  },
  {
    id: "youtube",
    title: "YouTube",
    desc: "Transkript ziehen",
    icon: "M22 8.6a3 3 0 0 0-2.1-2.1C18 6 12 6 12 6s-6 0-7.9.5A3 3 0 0 0 2 8.6 31 31 0 0 0 2 12a31 31 0 0 0 .1 3.4 3 3 0 0 0 2.1 2.1C6 18 12 18 12 18s6 0 7.9-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.1-3.4Z|10 9.5l5 2.5-5 2.5z",
    mode: "input",
    placeholder: "https://youtube.com/watch?v=…",
  },
  {
    id: "text",
    title: "Text",
    desc: "Direkt einfügen",
    icon: "M4 6h16|4 12h16|4 18h10",
    mode: "area",
    placeholder: "Text hier einfügen — wird als zitierfähige Notiz indexiert…",
  },
];

// ── jobs (atlas-api /api/m/jobs) ────────────────────────────────────────────

interface Job {
  job_id: string;
  channel: string;
  status: string; // queued | processing | done | skipped | error
  doc_id?: string | null;
  error?: string | null;
  source: string;
  created_at?: string;
}

const isActive = (s: string) => s === "queued" || s === "processing";

/** Map a job status to a pill (class + label). */
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

function SynapseView({ host }: { host: HostApi }) {
  const [channel, setChannel] = useState<ChannelId>("document");
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = CHANNELS.find((c) => c.id === channel)!;
  const indexed = jobs.filter((j) => j.status === "done").length;

  // ── jobs polling ──────────────────────────────────────────────────────────
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

  // Initial load.
  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

  // Heartbeat: poll fast (1.5s) while a job is in flight, slow (8s) when idle. The
  // slow beat keeps the panel recovering after a backend blip (initial load that
  // errored on a mid-restart atlas-api) and reflects jobs ingested by OTHER surfaces
  // (voice/meeting/social), not only Synapse's own submissions. Exactly one timer,
  // re-armed on each jobs change, torn down on unmount.
  useEffect(() => {
    const anyActive = jobs.some((j) => isActive(j.status));
    const id = setInterval(() => void refreshJobs(), anyActive ? 1500 : 8000);
    return () => clearInterval(id);
  }, [jobs, refreshJobs]);

  // ── channel switch resets the source field/file ─────────────────────────────
  const pickChannel = useCallback((id: ChannelId) => {
    setChannel(id);
    setSource("");
    setFile(null);
    setSubmitErr(null);
  }, []);

  const onFilePicked = useCallback((f: File | null) => {
    setFile(f);
    setSubmitErr(null);
  }, []);

  // ── submit → POST to the durable funnel ─────────────────────────────────────
  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitErr(null);

    // Build the request for the active channel.
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
      // NOTE: no Content-Type — the browser sets the multipart boundary.
      init = { method: "POST", body: form };
      label = file.name;
    } else {
      const src = source.trim();
      if (!src) return;
      if (channel === "url" || channel === "youtube") {
        if (!/^https?:\/\//i.test(src)) {
          setSubmitErr("Bitte eine vollständige http(s)-URL angeben.");
          return;
        }
        path = `/api/m/ingest/${channel}`;
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: src }),
        };
      } else {
        // text
        path = "/api/m/ingest/text";
        init = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: src, title: src.slice(0, 60).trim() || "Notiz" }),
        };
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
      // Accepted — clear the field, surface the queue immediately and start polling.
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

  return (
    <div className="syn">
      <SynapseStyle />

      <div className="syn-hero">
        <span className="syn-mark" aria-hidden="true" />
        <div className="syn-hero-tx">
          <h1>Synapse</h1>
          <p>
            Die Datenkrake. Speise Wissen ein — Dokumente, Links, Videos, Text. Jede
            Quelle wird indexiert und ist sofort über Atlas mit Beleg abfragbar.
          </p>
        </div>
        {indexed > 0 && (
          <button
            className="syn-toatlas"
            title="Zu Atlas — die eingespeisten Quellen abfragen"
            onClick={() => host.nav.navigate("atlas")}
          >
            <Svg d="M22 2 11 13|22 2l-7 20-4-9-9-4 20-7Z" />
            {indexed} im Index · in Atlas fragen
          </button>
        )}
      </div>

      <div className="syn-grid">
        {/* ── ingest funnel ── */}
        <section className="card syn-funnel">
          <div className="sect" style={{ marginTop: 0 }}>
            Kanal
          </div>
          <div className="tiles syn-tiles">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                className={`tile${c.id === channel ? " sel" : ""}`}
                onClick={() => pickChannel(c.id)}
              >
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
                onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
              />
              <button
                className={`syn-drop${file ? " has" : ""}`}
                onClick={() => fileInputRef.current?.click()}
              >
                <span className="syn-drop-ic">
                  <Svg
                    d={
                      file
                        ? "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 15l2 2 4-4"
                        : "M12 16V4|7 9l5-5 5 5|4 20h16"
                    }
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
            <div className="syn-joberr" style={{ marginTop: 12 }}>
              {submitErr}
            </div>
          )}

          <button
            className="btn btn-primary syn-submit"
            disabled={!canSubmit || submitting}
            onClick={() => void submit()}
          >
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

          <div className="syn-foot">
            Lokal eingebettet, in der Subunit-Brain gespeichert — kein Cloud-Umweg.
          </div>
        </section>

        {/* ── pipeline log ── */}
        <aside className="syn-jobs">
          <div className="syn-jobs-head">
            <div className="sect" style={{ margin: 0 }}>
              Pipeline {jobs.length > 0 && <span className="badge">{jobs.length}</span>}
            </div>
            <span className="syn-wh" title="Durable atlas-api Ingest-Funnel">funnel</span>
          </div>

          {jobsErr && jobs.length === 0 ? (
            <div className="syn-joberr" style={{ marginTop: 12 }}>
              Pipeline nicht erreichbar: {jobsErr}
            </div>
          ) : jobs.length === 0 ? (
            <div className="syn-jobs-empty">
              <span className="syn-empty-ic">
                <Svg d="M4 7h16|4 12h16|4 17h10" />
              </span>
              <b>Bereit</b>
              <span>
                Eingespeiste Quellen laufen durch den Ingest-Funnel und erscheinen hier —
                live von „Wartet“ bis „Im Index“.
              </span>
            </div>
          ) : (
            <ul className="list syn-joblist">
              {jobs.map((j) => {
                const pill = jobPill(j.status);
                const done = j.status === "done";
                return (
                  <li key={j.job_id} className="syn-job">
                    <div className="syn-job-tx">
                      <div className="syn-job-src">
                        {j.source || (CHANNEL_LABEL[j.channel] ?? j.channel)}
                      </div>
                      <div className="syn-job-meta">
                        {CHANNEL_LABEL[j.channel] ?? j.channel}
                        {j.status === "error" && j.error ? ` · ${trimErr(j.error)}` : ""}
                        {j.status === "skipped" ? " · bereits im Index" : ""}
                      </div>
                    </div>
                    <span className={`syn-pill ${pill.cls}`}>
                      {(j.status === "processing" || j.status === "queued") && (
                        <span className="syn-dot" />
                      )}
                      {pill.label}
                    </span>
                    {done && (
                      <button
                        className="syn-job-go"
                        title="In Atlas abfragen"
                        onClick={() => host.nav.navigate("atlas")}
                      >
                        <Svg d="M5 12h14|13 5l7 7-7 7" />
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function trimErr(e: string): string {
  return e.length > 80 ? `${e.slice(0, 77)}…` : e;
}

function SynapseStyle() {
  return (
    <style>{`
.syn{width:100%;max-width:1040px;margin:0 auto;padding:26px 28px 56px}
.syn-hero{display:flex;align-items:center;gap:18px;margin:6px 2px 22px}
.syn-mark{flex:none;width:66px;height:66px;background:linear-gradient(155deg,var(--cyan),var(--cyan-ink));-webkit-mask:url(/synapse-squid.png) center/contain no-repeat;mask:url(/synapse-squid.png) center/contain no-repeat;filter:drop-shadow(0 7px 18px rgba(6,182,212,.38))}
.syn-hero-tx{min-width:0;flex:1}
.syn-hero h1{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.syn-hero p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:52ch;letter-spacing:-.006em}
.syn-toatlas{flex:none;align-self:flex-start;display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;letter-spacing:-.005em;color:var(--cyan-d);background:rgba(6,182,212,.09);border:1px solid rgba(6,182,212,.26);padding:8px 12px;border-radius:10px;cursor:pointer;transition:.16s}
.syn-toatlas:hover{background:rgba(6,182,212,.16);border-color:rgba(6,182,212,.4);transform:translateY(-1px)}
.syn-toatlas svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}

.syn-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}
@media(max-width:900px){.syn-grid{grid-template-columns:1fr}}

.syn-funnel{padding:20px 22px}
.syn-tiles{flex-wrap:wrap}
.syn-tiles .tile{min-width:120px}
.syn-area{min-height:120px;resize:vertical;line-height:1.5;font-size:14.5px}
.syn-submit{margin-top:18px}
.syn-foot{margin-top:12px;font-size:11.5px;color:var(--ink3);text-align:center;letter-spacing:-.005em}

/* file picker / dropzone */
.syn-drop{width:100%;display:flex;align-items:center;gap:14px;text-align:left;padding:16px 16px;border:1.5px dashed var(--line2,rgba(120,140,170,.4));border-radius:14px;background:var(--fill-weak);cursor:pointer;transition:.18s}
.syn-drop:hover{border-color:rgba(6,182,212,.5);background:rgba(6,182,212,.05)}
.syn-drop.has{border-style:solid;border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.06)}
.syn-drop-ic{width:46px;height:46px;flex:none;border-radius:13px;display:grid;place-items:center;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.syn-drop-ic svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.syn-drop-tx{min-width:0}
.syn-drop-tx b{display:block;font-size:14px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-drop-tx span{font-size:11.5px;color:var(--ink3)}

.syn-jobs{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;position:sticky;top:8px}
.syn-jobs-head{display:flex;align-items:center;justify-content:space-between}
.syn-wh{font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.24);padding:3px 8px;border-radius:7px}
.syn-joberr{font-size:11.5px;color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-line);border-radius:12px;padding:9px 11px;line-height:1.4}
.syn-jobs-empty{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;color:var(--ink2);font-size:12.5px;padding:30px 10px 18px}
.syn-jobs-empty b{font-size:14px;font-weight:600;color:var(--ink)}
.syn-jobs-empty span{max-width:28ch;line-height:1.5}
.syn-empty-ic{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.syn-empty-ic svg{width:22px;height:22px}
.syn-joblist{margin-top:12px;gap:9px;list-style:none;padding:0;display:flex;flex-direction:column}
.syn-job{display:flex;align-items:center;gap:10px;padding:10px 11px;border:1px solid var(--line);border-radius:12px;background:var(--fill-weak)}
.syn-job-tx{flex:1;min-width:0}
.syn-job-src{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-job-meta{font-size:11px;color:var(--ink3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-pill{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:700;letter-spacing:.01em;padding:4px 9px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
.syn-pill.ok{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line)}
.syn-pill.proc{color:var(--cyan-d);background:rgba(6,182,212,.1);border-color:rgba(6,182,212,.3)}
.syn-pill.q{color:var(--ink3);background:var(--fill-soft);border-color:var(--line)}
.syn-pill.skip{color:var(--ink3);background:var(--fill-soft);border-color:var(--line)}
.syn-pill.err{color:var(--amber);background:var(--amber-bg);border-color:var(--amber-line)}
.syn-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:syn-pulse 1.1s ease-in-out infinite}
@keyframes syn-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1)}}
.syn-job-go{flex:none;width:26px;height:26px;border-radius:8px;display:grid;place-items:center;border:1px solid var(--line);background:var(--fill-weak);color:var(--ink2);cursor:pointer;transition:.15s}
.syn-job-go:hover{color:var(--cyan-d);border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.08)}
.syn-job-go svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
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
    version: "2.0.0",
    description: "Ingest funnel — feed documents, links and video into the brain Atlas reads.",
    icon: ICON,
    permissions: ["backend:atlas-api", "notifications"],
    nav: { section: "core", order: 3 },
    commands: [{ id: "open", title: "Go to Synapse" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<SynapseView host={host} />);
    offCmd = host.events.on("command:synapse:open", () =>
      host.nav.navigate("synapse")
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
