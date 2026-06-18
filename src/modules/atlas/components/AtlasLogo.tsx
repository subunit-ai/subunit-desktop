/**
 * AtlasLogo — a four-pointed compass star (north star).
 *
 * `AtlasLogoMark` is the bare SVG glyph (reused for the navbar lockup, footer,
 * and the large hero watermark). It mints a unique gradient id per instance so
 * multiple marks can share a page without clashing defs.
 *
 * Ported from atlas-web/src/components/AtlasLogo.jsx (the canonical Atlas mark).
 */
import { useId, type CSSProperties, type JSX } from "react";

// 8-point compass star (viewBox 0 0 100 100, centre 50,50).
const STAR_POINTS =
  "50,3 52.53,43.9 65.2,34.8 56.1,47.47 97,50 56.1,52.53 65.2,65.2 52.53,56.1 " +
  "50,97 47.47,56.1 34.8,65.2 43.9,52.53 3,50 43.9,47.47 34.8,34.8 47.47,43.9";

const coreTransform = (s: number): string =>
  `translate(50 50) scale(${s}) translate(-50 -50)`;

interface MarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  glow?: string;
  twinkle?: boolean;
}

export function AtlasLogoMark({
  size = 40,
  className = "shrink-0",
  style,
  glow = "drop-shadow(0 0 4px rgba(124,58,237,0.6)) drop-shadow(0 0 9px rgba(0,242,255,0.5))",
  twinkle = true,
}: MarkProps): JSX.Element {
  const uid = useId().replace(/:/g, "");
  const bodyGrad = `atlasStar-${uid}`;
  const coreGrad = `atlasCore-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="Atlas"
      className={className}
      style={{ filter: glow, ...style }}
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
        className={twinkle ? "animate-twinkle" : ""}
        style={{ transformOrigin: "center" }}
      />

      <circle cx="50" cy="50" r="3.1" fill="#ffffff" fillOpacity="0.95" />
    </svg>
  );
}

interface LogoProps {
  size?: number;
  withWordmark?: boolean;
  className?: string;
}

export default function AtlasLogo({
  size = 40,
  withWordmark = false,
  className = "",
}: LogoProps): JSX.Element {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <AtlasLogoMark size={size} />

      {withWordmark && (
        <span
          className="font-display font-semibold tracking-[0.04em] text-ink"
          style={{ fontSize: size * 0.52 }}
        >
          Atlas
        </span>
      )}
    </div>
  );
}
