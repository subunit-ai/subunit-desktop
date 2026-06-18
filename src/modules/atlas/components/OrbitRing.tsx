/**
 * OrbitRing — the Atlas "thinking" indicator.
 *
 * A luminous core circled by two counter-rotating orbit rings, each carrying a
 * bright satellite. Pure CSS animation (keyframes live in atlas.css and are
 * neutralised under prefers-reduced-motion). Used while the ask stream is
 * retrieving + before the first delta token lands.
 *
 * Ported from atlas-web/src/components/OrbitRing.jsx.
 */
import type { JSX } from "react";

interface OrbitRingProps {
  size?: number;
  label?: string;
  className?: string;
}

export default function OrbitRing({
  size = 30,
  label = "Navigating…",
  className = "",
}: OrbitRingProps): JSX.Element {
  const s = size;
  return (
    <span
      className={`inline-flex items-center gap-3 ${className}`}
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span
        className="relative inline-block shrink-0"
        style={{ width: s, height: s }}
        aria-hidden="true"
      >
        <span
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full animate-pulse-glow"
          style={{
            width: s * 0.26,
            height: s * 0.26,
            background: "radial-gradient(circle, #ffffff 0%, #7df6ff 45%, #00f2ff 100%)",
            boxShadow: "0 0 10px 2px rgba(0,242,255,0.7)",
          }}
        />

        <span
          className="absolute inset-0 rounded-full animate-orbit"
          style={{ border: "1.4px solid rgba(167,139,255,0.32)" }}
        >
          <span
            className="absolute rounded-full"
            style={{
              width: s * 0.16,
              height: s * 0.16,
              top: -s * 0.05,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#a78bff",
              boxShadow: "0 0 8px 1px rgba(139,92,246,0.85)",
            }}
          />
        </span>

        <span
          className="absolute rounded-full animate-orbit-rev"
          style={{
            inset: s * 0.2,
            border: "1.2px solid rgba(0,242,255,0.3)",
          }}
        >
          <span
            className="absolute rounded-full"
            style={{
              width: s * 0.13,
              height: s * 0.13,
              bottom: -s * 0.04,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#7df6ff",
              boxShadow: "0 0 7px 1px rgba(0,242,255,0.85)",
            }}
          />
        </span>
      </span>

      {label && (
        <span className="kicker" style={{ letterSpacing: "0.22em", fontSize: "0.66rem" }}>
          {label}
        </span>
      )}
    </span>
  );
}
