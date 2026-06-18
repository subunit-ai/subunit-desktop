/**
 * SourcesPanel — the right pane. One glass card per citation, plus a header that
 * carries the DSGVO "answered locally / via cloud" provenance badge from the ask
 * `done` event. While the answer is still streaming we show the retrieved
 * sources (chunk event) so the user sees the grounding immediately.
 *
 * Ported from atlas-web/src/components/SourcesPanel.jsx.
 */
import { type JSX } from "react";
import SourceCard, { type SourceItem } from "./SourceCard";
import OrbitRing from "./OrbitRing";
import { IconCloud, IconShield } from "./Icons";
import type { Citation, RetrievedSource } from "../lib/api";

interface SourcesPanelProps {
  citations?: Citation[];
  sources?: RetrievedSource[];
  via?: string | null;
  cloudBadge?: string | null;
  loading?: boolean;
  activeN?: number | null;
  onOpenDoc?: (docId: string) => void;
  onActivate?: (n: number) => void;
}

export default function SourcesPanel({
  citations = [],
  sources = [],
  via,
  cloudBadge,
  loading = false,
  activeN = null,
  onOpenDoc,
  onActivate,
}: SourcesPanelProps): JSX.Element {
  // Prefer the final citations; fall back to the live-retrieved sources so the
  // panel is never empty mid-stream. Both share the {n, doc_id, title, …} shape.
  const items: SourceItem[] = citations.length ? citations : sources;
  const hasItems = items.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between px-1">
        <span className="kicker" style={{ fontSize: "0.62rem", letterSpacing: "0.28em" }}>
          Sources
        </span>
        {via === "cloud" ? (
          <span className="badge-cloud" title="This answer used the cloud model">
            <IconCloud size={12} />
            {cloudBadge || "via cloud"}
          </span>
        ) : via === "local" ? (
          <span
            className="badge-local"
            title="Answered locally — nothing left your infrastructure"
          >
            <IconShield size={12} />
            local
          </span>
        ) : (
          hasItems && <span className="font-mono text-[0.7rem] text-ink-dim">{items.length}</span>
        )}
      </div>

      <div className="scroll-thin -mr-1 min-h-0 flex-1 space-y-2.5 overflow-y-auto pr-1">
        {!hasItems && loading && (
          <div className="glass flex items-center justify-center p-6">
            <OrbitRing size={26} label="Retrieving…" />
          </div>
        )}

        {!hasItems && !loading && (
          <div className="glass p-5 text-center text-sm text-ink-muted">
            <p>Citations appear here.</p>
            <p className="mt-1 text-[0.78rem] text-ink-dim">
              Every claim in an answer links to the source it came from.
            </p>
          </div>
        )}

        {items.map((c) => (
          <SourceCard
            key={`${c.n}-${c.doc_id || (c as RetrievedSource).id}`}
            citation={c}
            active={activeN === c.n}
            onOpen={onOpenDoc}
            onActivate={onActivate}
          />
        ))}
      </div>
    </div>
  );
}
