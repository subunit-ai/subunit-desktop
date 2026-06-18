/**
 * SubunitMark — the Subunit crown emblem as a crisp inline SVG.
 *
 * Traced from the brand mark (`subunit logo schwarz.png`): a faceted hollow
 * crown with three peaks + deep V-notches, inner spikes, a central stem node,
 * two inner leg-wedges, and three descending circuit lines ending in small
 * dots. Drawn on a 0..512 viewBox with the same vertex set as the app icon so
 * the in-app mark and the dock icon read as one shape.
 *
 * Colour is driven by `currentColor` (set the parent's `color` to the cyan
 * accent or ink per theme). Stroke weight scales with the rendered size so the
 * mark stays crisp from a 22px titlebar glyph up to a hero lockup.
 *
 * Liquid-Glass note: this is pure geometry — no palette is hardcoded. The one
 * cyan accent comes from the caller (e.g. `style={{ color: "var(--cyan)" }}`).
 */

import { type CSSProperties } from "react";

export interface SubunitMarkProps {
  /** Rendered square size in px. Default 26 (dock-head size). */
  size?: number;
  /** Stroke weight in viewBox units (0..512). Default auto-tuned per size. */
  strokeWidth?: number;
  /** Extra class on the <svg>. */
  className?: string;
  /** Inline style (e.g. `{ color: "var(--cyan)" }`). */
  style?: CSSProperties;
  /** Accessible title; omit for a decorative mark (aria-hidden). */
  title?: string;
}

export function SubunitMark({
  size = 26,
  strokeWidth,
  className,
  style,
  title,
}: SubunitMarkProps) {
  // Auto-tune stroke for legibility: heavier at small sizes, finer when large.
  const sw = strokeWidth ?? (size <= 24 ? 22 : size <= 40 ? 19 : 16);

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={style}
    >
      {title ? <title>{title}</title> : null}

      {/* ── Outer crown silhouette (one closed path):
            center peak → right V-notch → right peak → right shoulder →
            base fold → mirror back up the left side. ── */}
      <path
        d="M256 56
           L300 156
           L360 122
           L436 180
           L402 264
           L256 312
           L110 264
           L76 180
           L152 122
           L212 156
           Z"
      />

      {/* ── Internal creases ── */}
      {/* center peak ridge → stem node */}
      <path d="M256 96 L256 312" />
      {/* inner spikes from the V-notches diving to the node */}
      <path d="M300 156 L256 252" />
      <path d="M212 156 L256 252" />
      {/* outer-peak creases down to the shoulder fold */}
      <path d="M360 122 L402 264" />
      <path d="M152 122 L110 264" />

      {/* ── Inner leg-wedges flanking the stem ── */}
      <path d="M168 284 L168 366 L218 330" />
      <path d="M344 284 L344 366 L294 330" />

      {/* ── Circuit lines + ring dots ── */}
      <path d="M256 312 L256 438" />
      <path d="M256 330 L208 364 L208 410" />
      <path d="M256 330 L304 364 L304 410" />
      <circle cx="256" cy="456" r="13" fill="currentColor" stroke="none" />
      <circle cx="208" cy="430" r="11" fill="currentColor" stroke="none" />
      <circle cx="304" cy="430" r="11" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default SubunitMark;
