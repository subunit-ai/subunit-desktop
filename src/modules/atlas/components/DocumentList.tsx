/**
 * DocumentList — the left pane's knowledge inventory for the active workspace.
 * Glass cards, one per doc: source-type icon, title, source-type label +
 * captured_at. A filter box scopes the list locally. The card highlighted by a
 * citation-chip click flashes + pins its border (highlightDocId).
 *
 * Ported from atlas-web/src/components/DocumentList.jsx.
 */
import { useMemo, useState, type JSX } from "react";
import { SourceIcon, SOURCE_LABEL, IconSearch } from "./Icons";
import { relativeTime, absoluteTime } from "../lib/format";
import type { Doc } from "../lib/api";

interface DocumentListProps {
  docs?: Doc[];
  loading?: boolean;
  error?: unknown;
  highlightDocId?: string | null;
  onOpenDoc?: (doc: Doc) => void;
  onRetry?: () => void;
}

export default function DocumentList({
  docs = [],
  loading = false,
  error = null,
  highlightDocId = null,
  onOpenDoc,
  onRetry,
}: DocumentListProps): JSX.Element {
  const [filter, setFilter] = useState("");
  const hasError = Boolean(error);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) =>
        (d.title || "").toLowerCase().includes(q) ||
        (d.source_type || "").toLowerCase().includes(q) ||
        (d.source_url || "").toLowerCase().includes(q),
    );
  }, [docs, filter]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Knowledge
        </span>
        <span className="text-[0.7rem] font-mono text-ink-dim">{docs.length}</span>
      </div>

      <label className="relative mb-3 block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-dim">
          <IconSearch size={15} />
        </span>
        <input
          className="field"
          style={{ paddingLeft: "2.1rem", fontFamily: "var(--font-display)" }}
          placeholder="Filter documents…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter documents"
        />
      </label>

      <div className="scroll-thin -mr-1 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {loading && <DocSkeleton />}

        {!loading && hasError && (
          <div className="glass p-4 text-sm text-ink-muted">
            <p className="mb-2 text-[#ff9aa8]">Couldn’t load documents.</p>
            {onRetry && (
              <button className="btn-ghost" style={{ padding: "0.45rem 0.9rem" }} onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}

        {!loading && !hasError && filtered.length === 0 && (
          <div className="glass p-4 text-center text-sm text-ink-muted">
            {docs.length === 0 ? "No documents in this workspace yet." : "No matches."}
          </div>
        )}

        {!loading &&
          !hasError &&
          filtered.map((doc) => {
            const type = doc.source_type || doc.channel || "document";
            const highlighted = doc.doc_id === highlightDocId;
            return (
              <button
                key={doc.doc_id}
                id={`doc-card-${doc.doc_id}`}
                type="button"
                onClick={() => onOpenDoc?.(doc)}
                className={`glass glass-pick block w-full p-3 text-left ${
                  highlighted ? "glass-active glass-flash" : ""
                }`}
                title={doc.title}
              >
                <div className="flex items-start gap-3">
                  <span
                    className="mt-0.5 shrink-0 text-violet-soft"
                    style={{ filter: "drop-shadow(0 0 6px rgba(139,92,246,0.5))" }}
                  >
                    <SourceIcon type={type} size={20} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.9rem] font-medium text-ink">
                      {doc.title || "Untitled"}
                    </p>
                    <p className="mt-1 flex items-center gap-2 text-[0.7rem] text-ink-dim">
                      <span className="uppercase tracking-wide">{SOURCE_LABEL[type] || type}</span>
                      <span aria-hidden="true">·</span>
                      <time dateTime={doc.captured_at} title={absoluteTime(doc.captured_at)}>
                        {relativeTime(doc.captured_at)}
                      </time>
                    </p>
                  </div>
                </div>
              </button>
            );
          })}
      </div>
    </div>
  );
}

function DocSkeleton(): JSX.Element {
  return (
    <div className="space-y-2" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="glass p-3" style={{ opacity: 0.5 }}>
          <div className="flex items-center gap-3">
            <div className="h-5 w-5 rounded bg-[rgba(139,92,246,0.2)] animate-pulse" />
            <div className="flex-1 space-y-2">
              <div
                className="h-3 rounded bg-[rgba(140,160,255,0.14)] animate-pulse"
                style={{ width: `${70 - i * 6}%` }}
              />
              <div className="h-2 w-1/3 rounded bg-[rgba(140,160,255,0.1)] animate-pulse" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
