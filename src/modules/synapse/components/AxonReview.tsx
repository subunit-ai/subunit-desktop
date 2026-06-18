/**
 * AxonReview — the operator review queue.
 *
 * Web & social ingests land here (server-side `needsReview`) before they join the
 * workspace knowledge map. The operator confirms (keep) or discards (reject) each
 * pending entry:
 *   GET  /api/m/axon/pending          → the queue
 *   POST /api/m/axon/confirm/:id       → approve
 *   POST /api/m/axon/discard/:id       → reject
 *
 * Authored against atlas-api/src/routes/ingest.ts.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import {
  axonPending,
  axonConfirm,
  axonDiscard,
  type AxonPending,
} from "../../atlas/lib/api";
import { relativeTime, absoluteTime } from "../../atlas/lib/format";
import { IconCheck, IconClose } from "../../atlas/components/Icons";
import OrbitRing from "../../atlas/components/OrbitRing";

interface AxonReviewProps {
  /** Bumped by the parent after a new submission so the queue refetches. */
  refreshKey?: number;
  onError: (message: string) => void;
}

export default function AxonReview({ refreshKey = 0, onError }: AxonReviewProps): JSX.Element {
  const [pending, setPending] = useState<AxonPending[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setPending(await axonPending());
    } catch (err) {
      onError(err instanceof Error ? err.message : "axon_load_failed");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const act = async (id: string, kind: "confirm" | "discard"): Promise<void> => {
    if (actingId) return;
    setActingId(id);
    // Optimistically drop the row; restore on failure.
    const prev = pending;
    setPending((p) => p.filter((r) => r.id !== id));
    try {
      if (kind === "confirm") await axonConfirm(id);
      else await axonDiscard(id);
    } catch (err) {
      setPending(prev);
      onError(err instanceof Error ? err.message : `axon_${kind}_failed`);
    } finally {
      setActingId(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Axon review
        </span>
        <span className="font-mono text-[0.7rem] text-ink-dim">{pending.length}</span>
      </div>

      <div className="scroll-thin -mr-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {loading && pending.length === 0 && (
          <div className="glass flex items-center justify-center p-6">
            <OrbitRing size={26} label="Loading queue…" />
          </div>
        )}

        {!loading && pending.length === 0 && (
          <div className="glass p-5 text-center text-sm text-ink-muted">
            <p>Nothing to review.</p>
            <p className="mt-1 text-[0.78rem] text-ink-dim">
              Web & social ingests wait here for your approval before joining the map.
            </p>
          </div>
        )}

        {pending.map((row) => (
          <div key={row.id} className="glass p-3.5">
            <div className="flex items-start justify-between gap-2">
              <p className="min-w-0 truncate text-[0.88rem] font-medium text-ink" title={row.title}>
                {row.title || "Untitled"}
              </p>
              <time
                className="shrink-0 text-[0.66rem] text-ink-dim"
                dateTime={row.created_at}
                title={absoluteTime(row.created_at)}
              >
                {relativeTime(row.created_at)}
              </time>
            </div>

            {row.preview && (
              <p className="mt-2 line-clamp-3 text-[0.78rem] leading-relaxed text-ink-muted">
                {row.preview}
              </p>
            )}

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: "0.4rem 0.85rem", fontSize: "0.78rem" }}
                disabled={actingId === row.id}
                onClick={() => void act(row.id, "confirm")}
              >
                <IconCheck size={14} />
                Confirm
              </button>
              <button
                type="button"
                className="btn-ghost"
                style={{ padding: "0.4rem 0.85rem", fontSize: "0.78rem" }}
                disabled={actingId === row.id}
                onClick={() => void act(row.id, "discard")}
              >
                <IconClose size={14} />
                Discard
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
