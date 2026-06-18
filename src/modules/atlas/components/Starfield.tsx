/**
 * Starfield — subtle animated constellation canvas.
 * Floating points drift slowly; nearby points link with faint hairlines, and
 * the pointer draws a gentle web nearby. DPR-aware, cleans up after itself, and
 * falls back to a static field when reduced-motion is on.
 *
 * Ported from atlas-web/src/components/Starfield.jsx (inherited VERBATIM from
 * the Atlas landing prototype). Used as the login / empty-state background.
 */
import { useEffect, useRef, type JSX } from "react";

const PALETTE = ["#6d7bf5", "#8b5cf6", "#22d3ee", "#aab4e8", "#c9d4ff"];

interface Constellation {
  anchor: [number, number];
  scale: number;
  points: [number, number][];
  edges: [number, number][];
}

const CONSTELLATIONS: Constellation[] = [
  {
    // Großer Wagen / Big Dipper — top right
    anchor: [0.79, 0.17],
    scale: 0.135,
    points: [
      [-2.0, -0.15],
      [-1.25, -0.5],
      [-0.5, -0.58],
      [0.25, -0.46],
      [0.45, 0.5],
      [1.5, 0.4],
      [1.4, -0.55],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 6],
      [6, 3],
    ],
  },
  {
    // Orion — lower left
    anchor: [0.18, 0.64],
    scale: 0.12,
    points: [
      [-0.75, -1.2],
      [0.7, -1.35],
      [-0.35, 0.0],
      [0.02, 0.08],
      [0.4, 0.16],
      [-0.7, 1.2],
      [0.85, 1.25],
    ],
    edges: [
      [0, 2],
      [2, 5],
      [1, 4],
      [4, 6],
      [2, 3],
      [3, 4],
    ],
  },
  {
    // Kassiopeia — the "W", top left
    anchor: [0.16, 0.19],
    scale: 0.1,
    points: [
      [-1.7, 0.35],
      [-0.85, -0.3],
      [0.0, 0.3],
      [0.85, -0.35],
      [1.7, 0.22],
    ],
    edges: [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  },
  {
    // Cygnus / Northern Cross — lower right
    anchor: [0.85, 0.72],
    scale: 0.1,
    points: [
      [0, -1.35],
      [0, 0.12],
      [-1.15, 0.0],
      [1.15, 0.12],
      [0, 1.4],
    ],
    edges: [
      [0, 1],
      [1, 4],
      [2, 1],
      [1, 3],
    ],
  },
];

interface Star {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  c: string;
  tw: number;
  ts: number;
}

interface FigNode {
  x: number;
  y: number;
  tw: number;
  ts: number;
}

interface Fig {
  pts: FigNode[];
  edges: [number, number][];
}

interface StarfieldProps {
  className?: string;
  density?: number;
}

export default function Starfield({ className = "", density = 0.0001 }: StarfieldProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let w = 0;
    let h = 0;
    let raf = 0;
    let stars: Star[] = [];
    let figs: Fig[] = [];
    const mouse = { x: -9999, y: -9999 };
    const LINK = 112;
    const MOUSE_LINK = 230;

    const make = (): Star => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.18,
      vy: (Math.random() - 0.5) * 0.18,
      r: Math.random() * 1.3 + 0.45,
      c: PALETTE[(Math.random() * PALETTE.length) | 0],
      tw: Math.random() * Math.PI * 2,
      ts: 0.5 + Math.random() * 1,
    });

    const resize = (): void => {
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(200, Math.max(55, Math.floor(w * h * density)));
      stars = Array.from({ length: count }, make);

      const S = Math.min(w, h);
      figs = CONSTELLATIONS.map((c) => {
        const cx = c.anchor[0] * w;
        const cy = c.anchor[1] * h;
        const u = c.scale * S;
        const pts: FigNode[] = c.points.map(([px, py]) => ({
          x: cx + px * u,
          y: cy + py * u,
          tw: Math.random() * Math.PI * 2,
          ts: 0.4 + Math.random() * 0.7,
        }));
        return { pts, edges: c.edges };
      });
    };

    const drawConstellations = (t: number): void => {
      for (const fig of figs) {
        ctx.strokeStyle = "rgba(0, 242, 255, 0.2)";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        for (const [a, b] of fig.edges) {
          ctx.moveTo(fig.pts[a].x, fig.pts[a].y);
          ctx.lineTo(fig.pts[b].x, fig.pts[b].y);
        }
        ctx.stroke();

        ctx.shadowBlur = 8;
        ctx.shadowColor = "rgba(0, 242, 255, 0.85)";
        ctx.fillStyle = "#bff0ff";
        for (const p of fig.pts) {
          ctx.globalAlpha = reduce ? 0.75 : 0.55 + 0.4 * Math.sin(t * 0.0012 * p.ts + p.tw);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
      }
    };

    const draw = (t: number): void => {
      ctx.clearRect(0, 0, w, h);

      drawConstellations(t);

      for (const s of stars) {
        if (!reduce) {
          s.x += s.vx;
          s.y += s.vy;
          if (s.x < -20) s.x = w + 20;
          else if (s.x > w + 20) s.x = -20;
          if (s.y < -20) s.y = h + 20;
          else if (s.y > h + 20) s.y = -20;
        }
      }

      for (let i = 0; i < stars.length; i++) {
        const a = stars[i];
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < LINK * LINK) {
            const f = 1 - Math.sqrt(d2) / LINK;
            const alpha = f * f * 0.18 + f * 0.05;
            ctx.strokeStyle = `rgba(132, 148, 250, ${alpha})`;
            ctx.lineWidth = 0.6;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }

        const mdx = a.x - mouse.x;
        const mdy = a.y - mouse.y;
        const md2 = mdx * mdx + mdy * mdy;
        if (md2 < MOUSE_LINK * MOUSE_LINK) {
          const dist = Math.sqrt(md2);
          const mf = 1 - dist / MOUSE_LINK;
          const alpha = mf * mf * 0.55 + mf * 0.12;
          ctx.strokeStyle = `rgba(120, 224, 255, ${alpha})`;
          ctx.lineWidth = 0.5 + mf * 0.7;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(mouse.x, mouse.y);
          ctx.stroke();
          if (!reduce) {
            a.x -= (mdx / dist) * 0.26;
            a.y -= (mdy / dist) * 0.26;
          }
        }
      }

      for (const s of stars) {
        const tw = reduce ? 0.75 : 0.5 + 0.4 * Math.sin(t * 0.001 * s.ts + s.tw);
        ctx.globalAlpha = tw;
        ctx.fillStyle = s.c;
        ctx.shadowBlur = 7;
        ctx.shadowColor = s.c;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;

      if (!reduce) raf = requestAnimationFrame(draw);
    };

    const onMove = (e: PointerEvent): void => {
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
    };
    const onLeave = (): void => {
      mouse.x = -9999;
      mouse.y = -9999;
    };

    const ro = new ResizeObserver(() => {
      resize();
      if (reduce) draw(0);
    });
    ro.observe(canvas);

    resize();
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    if (reduce) draw(0);
    else raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [density]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
