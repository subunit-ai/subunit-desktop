/**
 * Synapse — the ingest funnel.
 *
 * Pick a channel (Document / URL / YouTube / Text / Notion), feed a source, and
 * it's queued into the knowledge base via atlas-api POST /api/m/ingest. A jobs
 * .list polls /api/m/jobs so you watch each source move queued → processing →
 * done. Everything Atlas can answer over starts here.
 *
 * Native Subunit Liquid Glass: selection tiles (.tiles/.tile/.sel/.ck), a glass
 * field, and a status .list with pills. ONE cyan accent.
 *
 * Permissions: backend:atlas-api, notifications, storage.
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

type ChannelId = "document" | "url" | "youtube" | "text" | "notion";

interface Channel {
  id: ChannelId;
  title: string;
  desc: string;
  icon: string;
  /** Placeholder for the source field. null = no field (e.g. file picker stub). */
  placeholder: string;
  multiline?: boolean;
}

const CHANNELS: Channel[] = [
  {
    id: "document",
    title: "Dokument",
    desc: "PDF, Markdown, Text",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 13h6|9 17h4",
    placeholder: "Pfad oder URL zum Dokument…",
  },
  {
    id: "url",
    title: "URL",
    desc: "Webseite einlesen",
    icon: "M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5|14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5",
    placeholder: "https://…",
  },
  {
    id: "youtube",
    title: "YouTube",
    desc: "Transkript ziehen",
    icon: "M22 8.6a3 3 0 0 0-2.1-2.1C18 6 12 6 12 6s-6 0-7.9.5A3 3 0 0 0 2 8.6 31 31 0 0 0 2 12a31 31 0 0 0 .1 3.4 3 3 0 0 0 2.1 2.1C6 18 12 18 12 18s6 0 7.9-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 22 12a31 31 0 0 0-.1-3.4Z|10 9.5l5 2.5-5 2.5z",
    placeholder: "https://youtube.com/watch?v=…",
  },
  {
    id: "text",
    title: "Text",
    desc: "Direkt einfügen",
    icon: "M4 6h16|4 12h16|4 18h10",
    placeholder: "Text hier einfügen…",
    multiline: true,
  },
  {
    id: "notion",
    title: "Notion",
    desc: "Seite oder DB",
    icon: "M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z|8 9h7|8 13h7|8 17h4",
    placeholder: "Notion-Seiten-URL oder ID…",
  },
];

interface Job {
  id: string;
  source: string;
  channel?: string;
  status: string; // queued | processing | done | failed | …
  progress?: number;
  error?: string;
}

function jobPill(status: string): { cls: string; label: string } {
  const s = status.toLowerCase();
  if (/done|complete|ready|indexed/.test(s)) return { cls: "live", label: "Fertig" };
  if (/fail|error/.test(s)) return { cls: "wait", label: "Fehler" };
  if (/process|running|ingest|embed/.test(s))
    return { cls: "wait", label: "Verarbeite" };
  return { cls: "gone", label: "Queued" };
}

function normalizeJobs(raw: unknown): Job[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as Record<string, unknown>)?.jobs)
      ? ((raw as Record<string, unknown>).jobs as unknown[])
      : [];
  return arr.map((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>;
    return {
      id: String(o.id ?? o.job_id ?? `job-${i}`),
      source: String(o.source ?? o.url ?? o.title ?? o.name ?? "—"),
      channel: typeof o.channel === "string" ? o.channel : (typeof o.type === "string" ? o.type : undefined),
      status: String(o.status ?? o.state ?? "queued"),
      progress: typeof o.progress === "number" ? o.progress : undefined,
      error: typeof o.error === "string" ? o.error : undefined,
    };
  });
}

function SynapseView({ host }: { host: HostApi }) {
  const [channel, setChannel] = useState<ChannelId>("url");
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobsErr, setJobsErr] = useState<string | null>(null);
  const [jobsLoading, setJobsLoading] = useState(true);
  // Optimistic jobs added locally before the backend reflects them.
  const localRef = useRef<Job[]>([]);

  const active = CHANNELS.find((c) => c.id === channel)!;

  const loadJobs = useCallback(async () => {
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/jobs");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const server = normalizeJobs(data);
      // Drop local optimistic entries the server now knows about.
      const serverIds = new Set(server.map((j) => j.id));
      localRef.current = localRef.current.filter((j) => !serverIds.has(j.id));
      setJobs([...localRef.current, ...server]);
      setJobsErr(null);
    } catch (err) {
      setJobsErr(err instanceof Error ? err.message : String(err));
    } finally {
      setJobsLoading(false);
    }
  }, [host]);

  useEffect(() => {
    void loadJobs();
    const iv = window.setInterval(() => void loadJobs(), 3000);
    return () => window.clearInterval(iv);
  }, [loadJobs]);

  const submit = useCallback(async () => {
    const src = source.trim();
    if (!src || submitting) return;
    setSubmitting(true);
    setSubmitErr(null);
    const optimistic: Job = {
      id: `local-${Date.now()}`,
      source: src,
      channel,
      status: "queued",
    };
    localRef.current = [optimistic, ...localRef.current];
    setJobs((j) => [optimistic, ...j]);
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, type: channel, source: src, url: src }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSource("");
      host.notifications.notify("Quelle eingespeist", `${active.title}: ${src}`);
      await loadJobs();
    } catch (err) {
      // Roll the optimistic row back to a failed state so it's visible.
      localRef.current = localRef.current.map((j) =>
        j.id === optimistic.id ? { ...j, status: "failed" } : j
      );
      setJobs((js) =>
        js.map((j) => (j.id === optimistic.id ? { ...j, status: "failed" } : j))
      );
      setSubmitErr(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [active.title, channel, host, loadJobs, source, submitting]);

  return (
    <div className="syn">
      <SynapseStyle />

      <div className="syn-hero">
        <span className="syn-mark" aria-hidden="true" />
        <div className="syn-hero-tx">
          <h1>Synapse</h1>
          <p>
            Die Datenkrake. Speise Wissen ein — Dokumente, Links, Videos. Jede Quelle
            wird indexiert und sofort über Atlas abfragbar.
          </p>
        </div>
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
                onClick={() => setChannel(c.id)}
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
          {active.multiline ? (
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

          {submitErr && <div className="err" style={{ textAlign: "left" }}>{submitErr}</div>}

          <button
            className="btn btn-primary syn-submit"
            disabled={!source.trim() || submitting}
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
        </section>

        {/* ── jobs ── */}
        <aside className="syn-jobs">
          <div className="syn-jobs-head">
            <div className="sect" style={{ margin: 0 }}>
              Jobs {jobs.length > 0 && <span className="badge">{jobs.length}</span>}
            </div>
            <button
              className="iconbtn syn-mini"
              title="Aktualisieren"
              onClick={() => void loadJobs()}
            >
              <span className="ic">
                <Svg d="M21 12a9 9 0 1 1-3-6.7|21 4v4h-4" />
              </span>
            </button>
          </div>

          {jobsErr && (
            <div className="syn-joberr">Jobs-Endpoint nicht erreichbar · {jobsErr}</div>
          )}

          {jobsLoading && jobs.length === 0 ? (
            <div className="syn-jobs-empty">
              <span className="spinner" />
              Lade Jobs…
            </div>
          ) : jobs.length === 0 ? (
            <div className="syn-jobs-empty">
              <span className="syn-empty-ic">
                <Svg d="M4 7h16|4 12h16|4 17h10" />
              </span>
              <b>Noch keine Jobs</b>
              <span>Eingespeiste Quellen erscheinen hier mit Live-Status.</span>
            </div>
          ) : (
            <ul className="list syn-joblist">
              {jobs.map((j) => {
                const pill = jobPill(j.status);
                return (
                  <li key={j.id} className="syn-job">
                    <div className="syn-job-tx">
                      <div className="syn-job-src">{j.source}</div>
                      <div className="syn-job-meta">
                        {j.channel ?? "ingest"}
                        {j.error ? ` · ${j.error}` : ""}
                      </div>
                    </div>
                    <span className={`pill ${pill.cls}`}>{pill.label}</span>
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

function SynapseStyle() {
  return (
    <style>{`
.syn{width:100%;max-width:1040px;margin:0 auto;padding:26px 28px 56px}
.syn-hero{display:flex;align-items:center;gap:18px;margin:6px 2px 22px}
.syn-mark{flex:none;width:66px;height:66px;background:linear-gradient(155deg,var(--cyan),var(--cyan-ink));-webkit-mask:url(/synapse-squid.png) center/contain no-repeat;mask:url(/synapse-squid.png) center/contain no-repeat;filter:drop-shadow(0 7px 18px rgba(6,182,212,.38))}
.syn-hero-tx{min-width:0}
.syn-hero h1{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.syn-hero p{font-size:14.5px;color:var(--ink2);line-height:1.5;margin-top:8px;max-width:52ch;letter-spacing:-.006em}

.syn-grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}
@media(max-width:900px){.syn-grid{grid-template-columns:1fr}}

.syn-funnel{padding:20px 22px}
.syn-tiles{flex-wrap:wrap}
.syn-tiles .tile{min-width:118px}
.syn-area{min-height:120px;resize:vertical;line-height:1.5;font-size:14.5px}
.syn-submit{margin-top:18px}

.syn-jobs{background:var(--glass);backdrop-filter:blur(34px) saturate(1.7);-webkit-backdrop-filter:blur(34px) saturate(1.7);border:1px solid var(--glass-edge);border-radius:var(--r);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:18px;position:sticky;top:8px}
.syn-jobs-head{display:flex;align-items:center;justify-content:space-between}
.syn-mini{width:auto}
.syn-mini .ic{width:32px;height:32px;border-radius:10px}
.syn-mini .ic svg{width:16px;height:16px}
.syn-joberr{font-size:11.5px;color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-line);border-radius:12px;padding:9px 11px;margin-top:12px;line-height:1.4}
.syn-jobs-empty{display:flex;flex-direction:column;align-items:center;gap:9px;text-align:center;color:var(--ink2);font-size:12.5px;padding:30px 10px 18px}
.syn-jobs-empty b{font-size:14px;font-weight:600;color:var(--ink)}
.syn-jobs-empty span{max-width:26ch;line-height:1.5}
.syn-empty-ic{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:linear-gradient(160deg,rgba(6,182,212,.16),rgba(6,182,212,.04));color:var(--cyan-d)}
.syn-empty-ic svg{width:22px;height:22px}
.syn-joblist{margin-top:12px;gap:9px}
.syn-job{align-items:center;gap:11px}
.syn-job-tx{flex:1;min-width:0}
.syn-job-src{font-size:13.5px;font-weight:600;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.syn-job-meta{font-size:11px;color:var(--ink3);margin-top:3px;text-transform:capitalize;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "synapse",
    name: "Synapse",
    version: "1.0.0",
    description: "Ingest funnel — feed documents, links and video into Atlas.",
    icon: ICON,
    permissions: ["backend:atlas-api", "notifications", "storage"],
    nav: { section: "core", order: 2 },
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
