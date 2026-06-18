/**
 * SourceCard — one citation as a glass card in the right pane.
 * Shows the [n] index, title, source-type icon + label, captured_at, retrieval
 * score, snippet, and an "open source" button that GETs /api/m/docs/:id.
 *
 * The card is registered with an id (source-card-<n>) so a citation-chip click
 * can scroll it into view + flash it.
 *
 * Ported from atlas-web/src/components/SourceCard.jsx.
 */
import { type JSX } from "react";
import { SourceIcon, SOURCE_LABEL, IconExternal } from "./Icons";
import { relativeTime, absoluteTime, scorePct } from "../lib/format";
import type { Citation, RetrievedSource } from "../lib/api";

export type SourceItem = Citation | RetrievedSource;

interface SourceCardProps {
  citation: SourceItem;
  active?: boolean;
  onOpen?: (docId: string) => void;
  onActivate?: (n: number) => void;
}

export default function SourceCard({
  citation,
  active = false,
  onOpen,
  onActivate,
}: SourceCardProps): JSX.Element {
  const c = citation as Citation & RetrievedSource;
  const { n, doc_id, title, captured_at, score, snippet, locator, uri } = c;
  const type = c.source_type || c.channel || "document";

  return (
    <div
      id={`source-card-${n}`}
      className={`glass glass-pick p-3.5 ${active ? "glass-active glass-flash" : ""}`}
      onClick={() => onActivate?.(n)}
      role="group"
      aria-label={`Source ${n}: ${title}`}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md font-mono text-[0.72rem] font-semibold"
          style={{
            color: "#cdbcff",
            background: "rgba(139,92,246,0.16)",
            border: "1px solid rgba(167,139,255,0.4)",
          }}
        >
          {n}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 truncate text-[0.88rem] font-medium text-ink" title={title}>
              {title || "Untitled source"}
            </p>
            {score != null && (
              <span
                className="shrink-0 font-mono text-[0.66rem] text-cyan-soft"
                title="retrieval score"
              >
                {scorePct(score)}
              </span>
            )}
          </div>

          <p className="mt-1 flex flex-wrap items-center gap-2 text-[0.68rem] text-ink-dim">
            <span className="inline-flex items-center gap-1 text-violet-soft">
              <SourceIcon type={type} size={13} />
              <span className="uppercase tracking-wide">{SOURCE_LABEL[type] || type}</span>
            </span>
            {captured_at && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={captured_at} title={absoluteTime(captured_at)}>
                  {relativeTime(captured_at)}
                </time>
              </>
            )}
            {locator && (
              <>
                <span aria-hidden="true">·</span>
                <span className="truncate" title={locator}>
                  {locator}
                </span>
              </>
            )}
          </p>

          {snippet && (
            <p className="mt-2 line-clamp-3 text-[0.78rem] leading-relaxed text-ink-muted">
              {snippet}
            </p>
          )}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              className="btn-ghost"
              style={{ padding: "0.4rem 0.8rem", fontSize: "0.78rem" }}
              onClick={(e) => {
                e.stopPropagation();
                if (doc_id) onOpen?.(doc_id);
              }}
            >
              <IconExternal size={14} />
              Open source
            </button>
            {uri && (
              <span className="truncate font-mono text-[0.64rem] text-ink-dim" title={uri}>
                {uri}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
