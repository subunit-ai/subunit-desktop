/**
 * SynapseModule — the ingest funnel surface, mounted as a route in the Subunit
 * shell.
 *
 *   LEFT   the ingest funnel (drop a file · paste a URL/YouTube/social/meeting)
 *   CENTER the live ingest-job board (status followed over SSE)
 *   RIGHT  the Axon review queue (confirm / discard pending web & social ingests)
 *
 * Same atlas-api backend + Atlas design language as AtlasModule. Auth is handled
 * by the shell (echo-tauri loopback SSO): we pull a fresh token on mount via the
 * IPC bridge and re-pull on `subunit://config-changed`; in local-dev bypass the
 * token is optional.
 *
 * Authored against atlas-api/src/routes/ingest.ts.
 */
import { useEffect, useState, type JSX } from "react";
import IngestPanel from "./components/IngestPanel";
import JobsPanel, { type TrackedJob } from "./components/JobsPanel";
import AxonReview from "./components/AxonReview";
import AtlasLogo from "../atlas/components/AtlasLogo";
import OrbitRing from "../atlas/components/OrbitRing";
import type { Channel, IngestAccepted } from "../atlas/lib/api";
import { refreshToken } from "../atlas/lib/session";
import "../atlas/atlas.css";

export default function SynapseModule(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Bumped after a needs-review submission so the Axon queue refetches.
  const [axonRefresh, setAxonRefresh] = useState(0);

  // The shell primes `window.__ATLAS_TOKEN__` before mounting us; one defensive
  // refresh covers the standalone-mount case.
  useEffect(() => {
    let cancelled = false;
    refreshToken().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onAccepted = (job: IngestAccepted, label: string, channel: Channel): void => {
    setError(null);
    setJobs((prev) => [
      { jobId: job.job_id, channel, label, submittedAt: Date.now() },
      ...prev,
    ]);
    // web/social are server-side needs-review → nudge the Axon queue.
    if (channel === "url" || channel === "social") {
      setAxonRefresh((n) => n + 1);
    }
  };

  if (!ready) {
    return (
      <div className="bg-universe relative grid h-full place-items-center">
        <OrbitRing size={34} label="Connecting Synapse…" />
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      <div className="bg-universe pointer-events-none absolute inset-0 -z-10" aria-hidden="true" />

      <div className="flex h-full flex-col">
        <header className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <AtlasLogo size={30} />
            <div className="leading-tight">
              <p className="font-display text-[1rem] font-semibold text-ink">Synapse</p>
              <p className="text-[0.7rem] text-ink-dim">Ingest funnel · Axon review</p>
            </div>
          </div>
          {error && (
            <span className="rounded-lg border border-[rgba(255,90,120,0.4)] bg-[rgba(255,90,120,0.07)] px-3 py-1.5 text-[0.74rem] text-[#ff9aa8]">
              {error}
            </span>
          )}
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px_340px]">
          {/* LEFT — the funnel (scrolls on its own) */}
          <section className="scroll-thin min-h-0 overflow-y-auto pr-1">
            <IngestPanel onAccepted={onAccepted} onError={setError} />
          </section>

          {/* CENTER — live jobs */}
          <aside className="hidden min-h-0 flex-col overflow-hidden lg:flex">
            <JobsPanel jobs={jobs} onClear={() => setJobs([])} />
          </aside>

          {/* RIGHT — Axon review */}
          <aside className="hidden min-h-0 flex-col overflow-hidden lg:flex">
            <AxonReview refreshKey={axonRefresh} onError={setError} />
          </aside>
        </div>
      </div>
    </div>
  );
}
