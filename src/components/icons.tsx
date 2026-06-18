/**
 * icons.tsx — the shell's stroke-icon set.
 *
 * Clean 24-viewBox line icons, `stroke="currentColor"`, width 2 — they inherit
 * the nav button's colour exactly like echo-tauri's sidebar glyphs. One module
 * icon per route plus a few chrome icons (search, command, account, update…).
 */

import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 17, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...rest}
    >
      {children}
    </svg>
  );
}

// ── module icons ─────────────────────────────────────────────────────────────

/** Atlas — a compass/north-star (knowledge navigation). */
export const AtlasIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M15.5 8.5 11 11l-2.5 4.5L13 13l2.5-4.5Z" fill="currentColor" stroke="none" />
  </Svg>
);

/** Synapse — a node firing into branches (ingest funnel). */
export const SynapseIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="12" r="2.4" />
    <circle cx="18" cy="6" r="2.2" />
    <circle cx="18" cy="18" r="2.2" />
    <path d="M8.2 11 16 6.6M8.2 13l7.8 4.4" />
  </Svg>
);

/** Chat — speech bubble. */
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 11.5a8.4 8.4 0 0 1-11.9 7.6L3 21l1.9-6.1A8.4 8.4 0 1 1 21 11.5Z" />
  </Svg>
);

/** Call — broadcast waves around a point. */
export const CallIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.4 8.4a5.1 5.1 0 0 0 0 7.2M15.6 8.4a5.1 5.1 0 0 1 0 7.2M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" />
    <circle cx="12" cy="12" r="2.1" fill="currentColor" stroke="none" />
  </Svg>
);

/** Echo — waveform bars (transcription). */
export const EchoIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12v0M8 8v8M12 4v16M16 8v8M20 12v0" />
  </Svg>
);

// ── chrome icons ──────────────────────────────────────────────────────────────

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Svg>
);

export const CommandIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z" />
  </Svg>
);

export const ArrowRightIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

export const ExternalIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 3h6v6M21 3l-9 9M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
  </Svg>
);

export const UpdateIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-3-6.7M21 4v4h-4" />
  </Svg>
);

export const UserIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20a8 8 0 0 1 16 0" />
  </Svg>
);

export const SignOutIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11" />
  </Svg>
);

export const SignInIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3M16 17l5-5-5-5M21 12H9" />
  </Svg>
);
