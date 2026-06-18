/**
 * KnowledgeCompass — the CompassRose motif salvaged from the Atlas landing hero
 * and repurposed as a DOMAIN / WORKSPACE switcher.
 *
 * The faceted 3D north-star sits inside a bezel. Each workspace is a waypoint
 * pegged around the rim; the active workspace's waypoint glows, and the star's
 * needle swings to point at it (a soft spring eases the rotation). Grab a ray
 * and fling it to spin the star — momentum + spring carry it back. Reduced-motion
 * → no rotation, the needle snaps and the waypoints stay static.
 *
 * Ported from atlas-web/src/components/KnowledgeCompass.jsx.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from "react";

const LONG = [0, 90, 180, 270]; // cardinal rays
const SHORT = [45, 135, 225, 315]; // diagonal rays

function facets(len: number, sh: number, shD: number): { light: string; dark: string } {
  return {
    light: `0,${-len} ${-sh},${-shD} 0,0`,
    dark: `0,${-len} ${sh},${-shD} 0,0`,
  };
}
const LONG_R = facets(168, 13, 26);
const SHORT_R = facets(94, 9, 18);

const RADIANS = Math.PI / 180;

export interface CompassWorkspace {
  id: string;
  name: string;
}

interface KnowledgeCompassProps {
  workspaces?: CompassWorkspace[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}

interface GrabState {
  grabbed: boolean;
  off: number;
  havePrev: boolean;
}

export default function KnowledgeCompass({
  workspaces = [],
  activeId,
  onSelect,
  className = "",
}: KnowledgeCompassProps): JSX.Element {
  const starRef = useRef<SVGGElement | null>(null);
  const rotRef = useRef(0);
  const velRef = useRef(0);
  const targetRef = useRef(0);
  const grabRef = useRef<GrabState>({ grabbed: false, off: 0, havePrev: false });

  const [hoverId, setHoverId] = useState<string | null>(null);

  const layout = useMemo(() => {
    const n = Math.max(workspaces.length, 1);
    return workspaces.map((ws, i) => ({
      ...ws,
      angle: (360 / n) * i, // deg, 0 at top, clockwise
    }));
  }, [workspaces]);

  const activeAngle = useMemo(() => {
    const found = layout.find((w) => w.id === activeId);
    return found ? found.angle : 0;
  }, [layout, activeId]);

  useEffect(() => {
    targetRef.current = activeAngle;
  }, [activeAngle]);

  useEffect(() => {
    const g = starRef.current;
    if (!g) return;
    const svg = g.ownerSVGElement;
    if (!svg) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      rotRef.current = activeAngle;
      g.setAttribute("transform", `rotate(${activeAngle})`);
      return;
    }

    let raf = 0;
    const SPRING = 0.012;
    const FRICTION = 0.9;
    const RETURN_CAP = 5.0;
    const VMAX = 5;
    const MAXDRAG = 28;

    const tick = (): void => {
      const grab = grabRef.current;
      if (!grab.grabbed) {
        const d = ((((targetRef.current - rotRef.current) % 360) + 540) % 360) - 180;
        velRef.current += d * SPRING;
        velRef.current *= FRICTION;
        if (velRef.current > RETURN_CAP) velRef.current = RETURN_CAP;
        else if (velRef.current < -RETURN_CAP) velRef.current = -RETURN_CAP;
        rotRef.current += velRef.current;
      }
      g.setAttribute("transform", `rotate(${rotRef.current.toFixed(2)})`);
      raf = requestAnimationFrame(tick);
    };

    const onMove = (e: PointerEvent): void => {
      const r = svg.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const rv = (dist * 400) / r.width;
      const aScreen = Math.atan2(dx, -dy) / RADIANS;
      const grab = grabRef.current;

      if (!grab.grabbed) {
        const a = (((aScreen - rotRef.current) % 360) + 360) % 360;
        const nearest = Math.round(a / 45) * 45;
        const off = Math.abs(((a - nearest + 540) % 360) - 180);
        const rayLen = nearest % 90 === 0 ? 168 : 94;
        const halfWidth = 20 * (1 - rv / rayLen) + 9;
        if (grab.havePrev && rv > 8 && rv < rayLen + 12 && off < halfWidth) {
          grab.grabbed = true;
          grab.off = aScreen - rotRef.current;
          velRef.current = 0;
        }
      } else if (rv > 210 || dist < 5) {
        grab.grabbed = false;
      } else {
        let d = ((((aScreen - grab.off - rotRef.current) % 360) + 540) % 360) - 180;
        if (d > MAXDRAG) d = MAXDRAG;
        else if (d < -MAXDRAG) d = -MAXDRAG;
        rotRef.current += d;
        velRef.current = d > VMAX ? VMAX : d < -VMAX ? -VMAX : d;
      }
      grab.havePrev = true;
    };
    const onLeave = (): void => {
      grabRef.current.grabbed = false;
      grabRef.current.havePrev = false;
    };

    raf = requestAnimationFrame(tick);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [activeAngle]);

  const pickId = hoverId ?? activeId;

  return (
    <div className={`relative ${className}`}>
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 h-[150%] w-[150%] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(circle, rgba(124,58,237,0.30) 0%, rgba(99,102,241,0.12) 32%, rgba(0,242,255,0.05) 52%, transparent 70%)",
          filter: "blur(40px)",
        }}
        aria-hidden="true"
      />

      <svg
        viewBox="-200 -200 400 400"
        className="relative h-full w-full"
        fill="none"
        role="img"
        aria-label="Workspace compass"
      >
        <defs>
          <linearGradient id="kc-light" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#dcccff" />
            <stop offset="55%" stopColor="#a78bff" />
            <stop offset="100%" stopColor="#7c3aed" />
          </linearGradient>
          <linearGradient id="kc-dark" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#7c3aed" />
            <stop offset="60%" stopColor="#5b21b6" />
            <stop offset="100%" stopColor="#3b1280" />
          </linearGradient>
          <radialGradient id="kc-core" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#d4c5ff" />
            <stop offset="45%" stopColor="#8b5cf6" />
            <stop offset="100%" stopColor="#7c3aed" stopOpacity="0" />
          </radialGradient>
        </defs>

        <circle cx="0" cy="0" r="190" stroke="rgba(140,160,255,0.14)" strokeWidth="1.5" />
        <circle cx="0" cy="0" r="176" stroke="rgba(0,242,255,0.10)" strokeWidth="1" />

        {layout.map((ws) => {
          const rad = (ws.angle - 90) * RADIANS;
          const x = Math.cos(rad) * 188;
          const y = Math.sin(rad) * 188;
          const isActive = ws.id === activeId;
          const isPick = ws.id === pickId;
          return (
            <g
              key={ws.id}
              transform={`translate(${x} ${y})`}
              className="cursor-pointer"
              onPointerEnter={() => setHoverId(ws.id)}
              onPointerLeave={() => setHoverId((h) => (h === ws.id ? null : h))}
              onClick={() => onSelect?.(ws.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect?.(ws.id);
                }
              }}
            >
              <circle r="22" fill="transparent" />
              <circle
                r={isActive ? 7.5 : isPick ? 6.5 : 5}
                fill={isActive ? "#7df6ff" : isPick ? "#a78bff" : "#5f6791"}
                style={{
                  filter: isActive
                    ? "drop-shadow(0 0 8px rgba(0,242,255,0.9))"
                    : isPick
                      ? "drop-shadow(0 0 6px rgba(139,92,246,0.7))"
                      : "none",
                  transition: "r 0.25s ease, fill 0.25s ease",
                }}
              />
            </g>
          );
        })}

        <g ref={starRef}>
          {SHORT.map((a) => (
            <g key={a} transform={`rotate(${a})`} opacity="0.9">
              <polygon points={SHORT_R.dark} fill="url(#kc-dark)" />
              <polygon points={SHORT_R.light} fill="url(#kc-light)" />
            </g>
          ))}
          {LONG.map((a) => (
            <g key={a} transform={`rotate(${a})`}>
              <polygon points={LONG_R.dark} fill="url(#kc-dark)" />
              <polygon points={LONG_R.light} fill="url(#kc-light)" />
            </g>
          ))}
          <circle cx="0" cy="0" r="34" fill="url(#kc-core)" />
          <circle cx="0" cy="0" r="5" fill="#e7ddff" />
        </g>
      </svg>
    </div>
  );
}
