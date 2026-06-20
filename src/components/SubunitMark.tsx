/**
 * SubunitMark — the REAL Subunit logo, rendered everywhere in the app.
 *
 * This is not a trace: it masks the actual brand asset (`public/subunit-logo.png`,
 * derived from the canonical `white logo big.png`) so the in-app mark is pixel-
 * for-pixel our logo. A CSS mask keeps the exact silhouette while letting the
 * colour follow `currentColor`, so the one cyan accent (active dock item / hero)
 * and the per-theme ink both come from the caller — no palette is hardcoded.
 *
 * Same props as before (size / style / className / title), so every call site
 * (dock head, titlebar, settings hero) keeps working unchanged.
 */

import { type CSSProperties } from "react";

export interface SubunitMarkProps {
  /** Rendered square size in px. Default 26 (dock-head size). */
  size?: number;
  /** Extra class on the element. */
  className?: string;
  /** Inline style (e.g. `{ color: "var(--cyan)" }`). */
  style?: CSSProperties;
  /** Accessible title; omit for a decorative mark (aria-hidden). */
  title?: string;
}

/** URL of the real logo asset (white-on-transparent → used as a mask alpha). */
const LOGO_URL = "/subunit-logo.png";

export function SubunitMark({
  size = 26,
  className,
  style,
  title,
}: SubunitMarkProps) {
  const mask = `url(${LOGO_URL}) center / contain no-repeat`;
  return (
    <span
      className={className}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      title={title}
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: "none",
        // The real logo silhouette as a mask; fill = currentColor (theme/accent).
        backgroundColor: "currentColor",
        WebkitMask: mask,
        mask,
        ...style,
      }}
    />
  );
}

export default SubunitMark;
