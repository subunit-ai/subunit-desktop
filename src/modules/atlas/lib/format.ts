/**
 * format.ts — small display helpers shared across the Atlas + Synapse surfaces.
 * Ported VERBATIM (behaviour-identical) from atlas-web/src/lib/format.js.
 */

/** Relative "captured_at" label: "just now", "3h ago", "Mar 4", "Mar 4 2024". */
export function relativeTime(iso?: string | null): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const now = Date.now();
  const diff = Math.round((now - then.getTime()) / 1000); // seconds
  if (diff < 45) return "just now";
  if (diff < 90) return "1 min ago";
  const mins = Math.round(diff / 60);
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Absolute, full timestamp for tooltips. */
export function absoluteTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human file size from bytes. */
export function formatBytes(bytes?: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Score (0..1) → percentage label. */
export function scorePct(score?: number | null): string {
  if (score == null || Number.isNaN(score)) return "";
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/** A friendly title for a workspace id when the API gives us only the id. */
export function workspaceLabel(id?: string | null): string {
  if (!id) return "Workspace";
  // turn "acme-legal" / "acme_legal" into "Acme Legal"
  return id
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
