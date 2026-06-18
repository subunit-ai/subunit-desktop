/**
 * JobsPanel — the live ingest-job board.
 *
 * The parent (SynapseModule) holds the list of jobs the user submitted this
 * session. Each row follows its job's status over SSE
 * (GET /api/m/jobs/:id/stream): the server emits a `status` event on every
 * transition (queued → processing → done/skipped/error) and a terminal `done`
 * frame. We render a live status chip + the resolved doc_id when it lands.
 *
 * Authored against atlas-api/src/routes/ingest.ts (the `status` event payload
 * shape + the done/skipped terminal set).
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { jobStreamUrl, sseAuthHeaders, type Channel, type JobStatus } from "../../atlas/lib/api";
import { sseFetch } from "../../atlas/lib/sse";
import { SourceIcon, SOURCE_LABEL } from "../../atlas/components/Icons";
import OrbitRing from "../../atlas/components/OrbitRing";

/** A job the user submitted this session. */
export interface TrackedJob {
  jobId: string;
  channel: Channel;
  label: string;
  submittedAt: number;
}

interface JobsPanelProps {
  jobs: TrackedJob[];
  onClear?: () => void;
}

export default function JobsPanel({ jobs, onClear }: JobsPanelProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Jobs
        </span>
        {jobs.length > 0 && onClear && (
          <button
            type="button"
            className="text-[0.7rem] text-ink-dim transition-colors hover:text-ink-muted"
            onClick={onClear}
          >
            Clear
          </button>
        )}
      </div>

      <div className="scroll-thin -mr-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {jobs.length === 0 ? (
          <div className="glass p-5 text-center text-sm text-ink-muted">
            <p>No jobs yet.</p>
            <p className="mt-1 text-[0.78rem] text-ink-dim">
              Submitted ingests appear here with live status.
            </p>
          </div>
        ) : (
          jobs.map((job) => <JobRow key={job.jobId} job={job} />)
        )}
      </div>
    </div>
  );
}

type LiveStatus = JobStatus | "not_found" | "unknown" | "connecting";

interface StatusEvent {
  status?: string;
  doc_id?: string | null;
  error?: string | null;
  attempts?: number;
}

function JobRow({ job }: { job: TrackedJob }): JSX.Element {
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [docId, setDocId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    let active = true;

    (async () => {
      try {
        for await (const evt of sseFetch(jobStreamUrl(job.jobId), {
          method: "GET",
          headers: sseAuthHeaders(),
          signal: controller.signal,
        })) {
          if (!active) break;
          if (evt.event === "status") {
            const d = (evt.data ?? {}) as StatusEvent;
            if (d.status) setStatus(d.status as LiveStatus);
            if (d.doc_id) setDocId(d.doc_id);
            if (d.error) setError(d.error);
          } else if (evt.event === "done") {
            const d = (evt.data ?? {}) as StatusEvent;
            if (d.status) setStatus(d.status as LiveStatus);
            if (d.doc_id) setDocId(d.doc_id);
            break;
          }
        }
      } catch {
        if (active && !controller.signal.aborted) setStatus("unknown");
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [job.jobId]);

  const terminal = status === "done" || status === "skipped";
  const failed = status === "error" || status === "not_found" || status === "unknown";
  const inFlight = !terminal && !failed;
  // Map the live status onto the status-chip data-status palette in atlas.css.
  const chipStatus =
    status === "connecting" ? "queued" : status === "not_found" ? "error" : status;

  return (
    <div className="glass p-3.5">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 shrink-0 text-violet-soft"
          style={{ filter: "drop-shadow(0 0 6px rgba(139,92,246,0.5))" }}
        >
          <SourceIcon type={job.channel} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-[0.88rem] font-medium text-ink" title={job.label}>
              {job.label}
            </p>
            <span className="status-chip shrink-0" data-status={chipStatus}>
              {inFlight && <OrbitRing size={12} label="" />}
              {statusLabel(status)}
            </span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.68rem] text-ink-dim">
            <span className="uppercase tracking-wide text-violet-soft">
              {SOURCE_LABEL[job.channel] || job.channel}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{job.jobId.slice(0, 8)}</span>
            {docId && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono text-cyan-soft" title={docId}>
                  doc {docId.slice(0, 8)}
                </span>
              </>
            )}
          </p>
          {error && <p className="mt-1 text-[0.7rem] text-[#ff9aa8]">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function statusLabel(status: LiveStatus): string {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "queued":
      return "Queued";
    case "processing":
      return "Processing";
    case "done":
      return "Done";
    case "skipped":
      return "Skipped";
    case "error":
      return "Error";
    case "not_found":
      return "Not found";
    default:
      return "Unknown";
  }
}
