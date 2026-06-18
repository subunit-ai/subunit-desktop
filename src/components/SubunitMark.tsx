/**
 * SubunitMark — the brand glyph for the shell chrome (sidebar header).
 *
 * An 8-point compass/north-star (violet core → cyan tips), ported in spirit from
 * atlas-web's AtlasLogoMark so the desktop shell, web app and iOS read as one
 * brand. Self-contained TSX (no cross-import from atlas-web's JSX). Mints a
 * unique gradient id per instance so several marks can share a page.
 */

import { useId } from "react";

const STAR_POINTS =
  "50,3 52.53,43.9 65.2,34.8 56.1,47.47 97,50 56.1,52.53 65.2,65.2 52.53,56.1 " +
  "50,97 47.47,56.1 34.8,65.2 43.9,52.53 3,50 43.9,47.47 34.8,34.8 47.47,43.9";

const coreTransform = (s: number) =>
  `translate(50 50) scale(${s}) translate(-50 -50)`;

export function SubunitMark({
  size = 22,
  glow = "drop-shadow(0 0 4px rgba(124,58,237,0.6)) drop-shadow(0 0 9px rgba(0,242,255,0.5))",
  twinkle = true,
}: {
  size?: number;
  glow?: string;
  twinkle?: boolean;
}) {
  const uid = useId().replace(/:/g, "");
  const bodyGrad = `sumStar-${uid}`;
  const coreGrad = `sumCore-${uid}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="Subunit"
      style={{ filter: glow, flex: "none" }}
    >
      <defs>
        <radialGradient id={bodyGrad} cx="50%" cy="50%" r="52%">
          <stop offset="0%" stopColor="#7c3aed" />
          <stop offset="52%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#00f2ff" />
        </radialGradient>
        <radialGradient id={coreGrad} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="38%" stopColor="#7df6ff" />
          <stop offset="100%" stopColor="#00f2ff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <polygon points={STAR_POINTS} fill={`url(#${bodyGrad})`} />
      <polygon
        points={STAR_POINTS}
        fill={`url(#${coreGrad})`}
        transform={coreTransform(0.52)}
        className={twinkle ? "mark-twinkle" : ""}
        style={{ transformOrigin: "center" }}
      />
      <circle cx="50" cy="50" r="3.1" fill="#ffffff" fillOpacity="0.95" />
    </svg>
  );
}
