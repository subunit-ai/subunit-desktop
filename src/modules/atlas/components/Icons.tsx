/**
 * Icons — slim, consistent line icons (stroke = currentColor).
 * Star fills use currentColor so accent colour cascades from the parent.
 *
 * Ported from atlas-web/src/components/Icons.jsx (inherited VERBATIM from the
 * Atlas landing prototype). Retyped for the TypeScript shell.
 */
import type { SVGProps } from "react";
import type { JSX, ReactNode } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ children, size = 26, ...rest }: IconProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ---- Discovery Journey ---- */

export function IconOrient(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.2" />
      <polygon points="16.4 7.6 13.9 13.9 7.6 16.4 10.1 10.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconExplore(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9.2" strokeOpacity="0.85" />
      <circle cx="12" cy="12" r="4.6" strokeOpacity="0.55" />
      <line x1="12" y1="12" x2="19" y2="7" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="17.2" cy="8.4" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconConnect(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 7.5 L17.5 6 L15.5 17.5 L8.5 15.5 Z" strokeOpacity="0.7" />
      <line x1="6" y1="7.5" x2="15.5" y2="17.5" strokeOpacity="0.5" />
      {(
        [
          [6, 7.5],
          [17.5, 6],
          [15.5, 17.5],
          [8.5, 15.5],
        ] as const
      ).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.7" fill="currentColor" stroke="none" />
      ))}
    </Svg>
  );
}

export function IconAdvance(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="3 17 9.5 10.5 13.5 14.5 19 8" />
      <polyline points="14.5 8 19 8 19 12.5" />
      <path
        d="M7 4.6 L7.7 6.3 L9.4 7 L7.7 7.7 L7 9.4 L6.3 7.7 L4.6 7 L6.3 6.3 Z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

/* ---- Features ---- */

export function IconVectorDB(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <ellipse cx="11" cy="5.5" rx="7" ry="2.8" />
      <path d="M4 5.5 v6 a7 2.8 0 0 0 14 0 v-6" />
      <path d="M4 11.5 a7 2.8 0 0 0 14 0" />
      <path
        d="M19 16.5 L19.8 18.2 L21.5 19 L19.8 19.8 L19 21.5 L18.2 19.8 L16.5 19 L18.2 18.2 Z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function IconConstellation(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="4 7 9 5 14.5 9 20 6" strokeOpacity="0.6" />
      <polyline points="9 5 12 13 17.5 17" strokeOpacity="0.6" />
      <polyline points="12 13 7 17" strokeOpacity="0.6" />
      {(
        [
          [9, 5],
          [14.5, 9],
          [20, 6],
          [17.5, 17],
          [7, 17],
        ] as const
      ).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="1.3" fill="currentColor" stroke="none" />
      ))}
      <path
        d="M4 5.5 L4.6 6.9 L6 7.5 L4.6 8.1 L4 9.5 L3.4 8.1 L2 7.5 L3.4 6.9 Z"
        fill="currentColor"
        stroke="none"
      />
      <circle cx="12" cy="13" r="2" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconMapping(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M2.5 6.5 L9 4 L15 6.5 L21.5 4 V17.5 L15 20 L9 17.5 L2.5 20 Z" />
      <line x1="9" y1="4" x2="9" y2="17.5" strokeOpacity="0.5" />
      <line x1="15" y1="6.5" x2="15" y2="20" strokeOpacity="0.5" />
      <circle cx="12" cy="11" r="2.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSpark(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path
        d="M12 3 L13.4 9.2 L19.5 10.6 L13.4 12 L12 18.2 L10.6 12 L4.5 10.6 L10.6 9.2 Z"
        fill="currentColor"
        stroke="none"
      />
    </Svg>
  );
}

export function IconArrow(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <line x1="4" y1="12" x2="19" y2="12" />
      <polyline points="13 6 19 12 13 18" />
    </Svg>
  );
}

/* ---- Compass / Knowledge Compass ---- */

export function IconCompass(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <polygon points="15.6 8.4 13 13 8.4 15.6 11 11" fill="currentColor" stroke="none" />
      <polygon points="8.4 15.6 11 11 13 13" fill="currentColor" stroke="none" opacity="0.45" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconStrategy(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8.5" strokeOpacity="0.5" />
      <circle cx="12" cy="12" r="4.6" />
      <path d="M12 2 L12 5 M12 19 L12 22 M2 12 L5 12 M19 12 L22 12" strokeOpacity="0.7" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconGrowth(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="3 16.5 9 10.5 13 14.5 21 6" />
      <polyline points="15.5 6 21 6 21 11.5" />
      <circle cx="9" cy="10.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="14.5" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconOperations(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.4" />
      <path d="M12 2.5 v2.6 M12 18.9 v2.6 M21.5 12 h-2.6 M5.1 12 H2.5 M18.7 5.3 l-1.85 1.85 M7.15 16.85 L5.3 18.7 M18.7 18.7 l-1.85-1.85 M7.15 7.15 L5.3 5.3" />
    </Svg>
  );
}

export function IconEngineering(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="8 6.5 3.5 12 8 17.5" />
      <polyline points="16 6.5 20.5 12 16 17.5" />
      <line x1="13.5" y1="5" x2="10.5" y2="19" strokeOpacity="0.7" />
    </Svg>
  );
}

/* ---- Hero / CTA signature mark ---- */

export function IconCompassStar({ size = 26, ...rest }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" {...rest}>
      <path
        d="M12 0.6 L13.55 10.45 L23.4 12 L13.55 13.55 L12 23.4 L10.45 13.55 L0.6 12 L10.45 10.45 Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* ---- Social ---- */

export function IconLinkedIn({ size = 20, ...rest }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46v6.28zM5.34 7.43a2.07 2.07 0 1 1 0-4.14 2.07 2.07 0 0 1 0 4.14zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.73v20.54C0 23.22.79 24 1.77 24h20.45c.98 0 1.78-.78 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

export function IconX({ size = 20, ...rest }: IconProps): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" {...rest}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.967 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" />
    </svg>
  );
}

/* ---- App-surface icons ---- */

export function IconDocument(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M6 2.5h8L19 7v13.5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1Z" />
      <polyline points="14 2.5 14 7 19 7" />
      <line x1="8" y1="12" x2="16" y2="12" strokeOpacity="0.7" />
      <line x1="8" y1="15.5" x2="14" y2="15.5" strokeOpacity="0.7" />
    </Svg>
  );
}

export function IconLink(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M9.5 14.5 L14.5 9.5" />
      <path d="M7 12 L4.8 14.2 a3.1 3.1 0 0 0 4.4 4.4 L11.4 16.4" />
      <path d="M17 12 L19.2 9.8 a3.1 3.1 0 0 0-4.4-4.4 L12.6 7.6" />
    </Svg>
  );
}

export function IconSend(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 12 L20 4 L13 20 L11 13 Z" />
      <line x1="11" y1="13" x2="20" y2="4" strokeOpacity="0.6" />
    </Svg>
  );
}

export function IconSearch(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <line x1="16.2" y1="16.2" x2="21" y2="21" />
    </Svg>
  );
}

export function IconUpload(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 16.5 V19 a1 1 0 0 0 1 1 H19 a1 1 0 0 0 1-1 v-2.5" />
      <polyline points="8 8 12 4 16 8" />
      <line x1="12" y1="4" x2="12" y2="15" />
    </Svg>
  );
}

export function IconExternal(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M14 4h6v6" />
      <path d="M20 4 L11 13" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </Svg>
  );
}

export function IconCloud(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M7 18h9.5a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 7.2 9.5 3.75 3.75 0 0 0 7 18Z" />
    </Svg>
  );
}

export function IconShield(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M12 3 L19 6 V11.5 C19 16 15.8 19.3 12 21 C8.2 19.3 5 16 5 11.5 V6 Z" />
      <polyline points="9 12 11.2 14.2 15.2 9.6" strokeOpacity="0.85" />
    </Svg>
  );
}

export function IconCheck(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <polyline points="4 12.5 9.5 18 20 6" />
    </Svg>
  );
}

export function IconClose(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </Svg>
  );
}

/* ---- Source-type icons (the six ingest channels) ---- */

export function IconYouTube(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="2.5" y="5.5" width="19" height="13" rx="3.5" />
      <polygon points="10 9 16 12 10 15" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSocial(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <path d="M4 13a8 8 0 1 1 3.2 6.4L4 20.5l1.1-3.3A8 8 0 0 1 4 13Z" />
      <circle cx="9" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="13" cy="13" r="1" fill="currentColor" stroke="none" />
      <circle cx="17" cy="13" r="1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconVoice(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <rect x="9" y="2.5" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
      <line x1="8.5" y1="21.5" x2="15.5" y2="21.5" />
    </Svg>
  );
}

export function IconMeeting(p: IconProps): JSX.Element {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8.5" r="2.6" />
      <circle cx="16" cy="8.5" r="2.6" />
      <path d="M3 18.5c0-2.6 2.2-4.2 5-4.2s5 1.6 5 4.2" />
      <path d="M13.5 14.6c2.4.2 4.5 1.7 4.5 3.9" strokeOpacity="0.75" />
    </Svg>
  );
}

/* ---- Source-type dispatch ---- */

type IconComponent = (p: IconProps) => JSX.Element;

const SOURCE_ICON: Record<string, IconComponent> = {
  document: IconDocument,
  url: IconLink,
  youtube: IconYouTube,
  social: IconSocial,
  voice: IconVoice,
  meeting: IconMeeting,
};

/** Render the source-type icon for a doc's source_type / channel. */
export function SourceIcon({ type, size = 20, ...rest }: IconProps & { type?: string }): JSX.Element {
  const Cmp = (type && SOURCE_ICON[type]) || IconDocument;
  return <Cmp size={size} {...rest} />;
}

/** Short, human label for a source-type chip. */
export const SOURCE_LABEL: Record<string, string> = {
  document: "Document",
  url: "Web",
  youtube: "YouTube",
  social: "Social",
  voice: "Voice",
  meeting: "Meeting",
};
