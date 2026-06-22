/**
 * Cortex3D — THE signature 3D neural engine (the visual the product owner loves).
 *
 * A faithful port of the original SNI cortex (Cortex.jsx / cortexUtils.jsx /
 * CortexHUD / CortexControls / CortexMinimap), rebuilt for Subunit Desktop:
 *
 *   • A pure <canvas> 2D context simulating true 3D — NO WebGL (WKWebView-safe).
 *   • Perspective projection (FOV ~900), force-directed tier layout with the
 *     orchestrator (U1) at the core and its SKILLS on core/surface/deep shells,
 *     Z-depth painter sort.
 *   • The U1 CROWN: corona halo, two counter-rotating precessing orbital rings
 *     with satellites, a rotating scanner arc + trailing fade, a rotating inner
 *     hexagon, radiating ticks — phase-locked to a global clock, dimming dormant.
 *   • A VECTOR SPHERE: a large golden-spiral point cloud (~2000 pts, 5 colour
 *     clusters) breathing on a sine, front-hemisphere emphasis + limb glow.
 *   • Axone EDGES as glowing 3D lines with travelling pulses; reflex ORBITALS as
 *     diamonds orbiting each skill node.
 *   • Interaction: drag-rotate (clamp ±90°), wheel/pinch zoom (0.08–4×), gentle
 *     idle auto-rotate, hit-detection → a glass inspector overlay.
 *   • Glass overlays: HUD chip strip, layer toggles, tier chips, zoom controls,
 *     and a minimap with a viewport frame. DPR + resize aware.
 *   • prefers-reduced-motion → slow / near-static. Dark canvas well in BOTH themes.
 *
 * MODEL: ONE agent — U1 (orchestratorOf) — everything else is a SKILL (skillsOf).
 * UI never says "agents".
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { HostApi } from "../../../plugin/types";
import { AGENTS, skillsOf, orchestratorOf, TIER_CONFIG, type Agent, type Tier } from "../agents";

// ── tuning constants (ported) ───────────────────────────────────────────────
const U1_RADIUS = 42;
const SKILL_RADIUS = 32;
const SPRING_STRENGTH = 0.003;
const REPULSION = 48000;
const DAMPING = 0.85;
const SIM_STEPS = 360;

const VECTOR_COUNT = 2000;
const WORLD_SPHERE_R = 1060;
const SPHERE_POINT_RADIUS = 5;

const CLUSTER_COLORS = ["#0891b2", "#2563eb", "#a78bfa", "#ef4444", "#e67e22"];
const CLUSTER_WEIGHTS = [1.0, 1.6, 1.0, 0.5, 0.8];

const TIER_DIST: Record<Tier, number> = {
  core: TIER_CONFIG.core.ring + 30,       // ~180
  surface: TIER_CONFIG.surface.ring + 100, // ~338
  deep: TIER_CONFIG.deep.ring + 160,       // ~478
};

const AXON_TYPE_COLORS: Record<string, string> = {
  command: "#f59e0b", data: "#3b82f6", sync: "#06b6d4", logic: "#8b5cf6",
  query: "#60a5fa", io: "#ec4899", process: "#14b8a6", telemetry: "#10b981", security: "#ef4444",
};

const LAYERS = [
  { key: "axons", label: "Axone", color: "#a78bfa" },
  { key: "reflexes", label: "Reflexe", color: "#22d3ee" },
  { key: "vectors", label: "Vektoren", color: "#fbbf24" },
  { key: "grid", label: "Grid", color: "#94a3b8" },
] as const;
type LayerKey = (typeof LAYERS)[number]["key"];

const TIERS: Tier[] = ["surface", "core", "deep"];

// ── helpers ─────────────────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** A stable per-edge axon "type" so edge colours don't flicker. */
function axonType(code: string): string {
  let h = 2166136261;
  for (let i = 0; i < code.length; i++) { h ^= code.charCodeAt(i); h = Math.imul(h, 16777619); }
  const keys = Object.keys(AXON_TYPE_COLORS);
  return keys[(h >>> 0) % keys.length];
}

// ── sphere point cloud (golden-spiral clusters) ─────────────────────────────
interface SpherePoint { x: number; y: number; z: number; cluster: number; similarity: number; }
function generateSpherePoints(count: number, numClusters: number): SpherePoint[] {
  const centers: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < numClusters; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / numClusters);
    const theta = Math.PI * (3 - Math.sqrt(5)) * i;
    centers.push({ x: Math.sin(phi) * Math.cos(theta), y: Math.cos(phi), z: Math.sin(phi) * Math.sin(theta) });
  }
  let totalW = 0;
  const weights = CLUSTER_WEIGHTS.slice(0, numClusters);
  weights.forEach((w) => (totalW += w));
  const points: SpherePoint[] = [];
  const baseSpread = 0.78;
  for (let c = 0; c < numClusters; c++) {
    const cen = centers[c];
    const perCluster = Math.round((count * weights[c]) / totalW);
    const spread = baseSpread * Math.sqrt(weights[c]);
    for (let j = 0; j < perCluster; j++) {
      const nx = cen.x + (Math.random() - 0.5) * spread;
      const ny = cen.y + (Math.random() - 0.5) * spread;
      const nz = cen.z + (Math.random() - 0.5) * spread;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      points.push({ x: nx / len, y: ny / len, z: nz / len, cluster: c, similarity: 0.4 + Math.random() * 0.6 });
    }
  }
  return points;
}

// ── 3D perspective projection (ported verbatim) ─────────────────────────────
interface Proj { sx: number; sy: number; scale: number; z: number; depth: number; }
function project3D(x: number, y: number, z: number, rotX: number, rotY: number, cx: number, cy: number, zoom: number): Proj {
  const tx = x - cx, ty = y - cy, tz = z;
  const x1 = tx * Math.cos(rotY) - tz * Math.sin(rotY);
  const z1 = tx * Math.sin(rotY) + tz * Math.cos(rotY);
  const y2 = ty * Math.cos(rotX) - z1 * Math.sin(rotX);
  const z2 = ty * Math.sin(rotX) + z1 * Math.cos(rotX);
  const fov = 900 / Math.min(1, zoom);
  const depth = Math.max(0.3, fov / (fov + z2));
  const scale = depth * zoom;
  return { sx: cx + x1 * scale, sy: cy + y2 * scale, scale, z: z2, depth };
}

// ── force-directed 3D tier layout (ported) ──────────────────────────────────
interface LayoutNode { x: number; y: number; z: number; vx: number; vy: number; vz: number; agent: Agent; }
interface Layout { nodes: Record<string, LayoutNode>; edges: { from: string; to: string }[]; }
function computeForceLayout3D(agents: Agent[], orchCode: string, width: number, height: number): Layout {
  const cx = width / 2, cy = height / 2;
  const tierGroups: Record<Tier, Agent[]> = { core: [], surface: [], deep: [] };
  agents.forEach((a) => { if (a.code !== orchCode) tierGroups[a.tier].push(a); });

  const nodes: Record<string, LayoutNode> = {};
  agents.forEach((agent) => {
    if (agent.code === orchCode) {
      nodes[orchCode] = { x: cx, y: cy, z: 0, vx: 0, vy: 0, vz: 0, agent };
      return;
    }
    const tier = agent.tier;
    const tierR = TIER_DIST[tier];
    const list = tierGroups[tier];
    const idx = list.indexOf(agent);
    const count = list.length || 1;
    const phi = Math.acos(1 - (2 * (idx + 0.5)) / count);
    const theta = Math.PI * (3 - Math.sqrt(5)) * idx;
    nodes[agent.code] = {
      x: cx + tierR * Math.sin(phi) * Math.cos(theta),
      y: cy + tierR * Math.sin(phi) * Math.sin(theta),
      z: tierR * Math.cos(phi),
      vx: 0, vy: 0, vz: 0, agent,
    };
  });

  const edges: { from: string; to: string }[] = [];
  const edgeSet = new Set<string>();
  agents.forEach((agent) => {
    agent.axone?.forEach((target) => {
      const key = [agent.code, target].sort().join("-");
      if (!edgeSet.has(key) && nodes[target]) { edgeSet.add(key); edges.push({ from: agent.code, to: target }); }
    });
  });

  for (let iter = 0; iter < SIM_STEPS; iter++) {
    const codes = Object.keys(nodes);
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const a = nodes[codes[i]], b = nodes[codes[j]];
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const f = REPULSION / (dist * dist);
        const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
        a.vx -= fx; a.vy -= fy; a.vz -= fz;
        b.vx += fx; b.vy += fy; b.vz += fz;
      }
    }
    edges.forEach((edge) => {
      const a = nodes[edge.from], b = nodes[edge.to];
      const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
      const other = edge.from === orchCode ? edge.to : edge.from;
      const otherTier = nodes[other]?.agent.tier ?? "surface";
      const target = edge.from === orchCode || edge.to === orchCode ? TIER_DIST[otherTier] : 280;
      const f = (dist - target) * SPRING_STRENGTH;
      const fx = (dx / dist) * f, fy = (dy / dist) * f, fz = (dz / dist) * f;
      a.vx += fx; a.vy += fy; a.vz += fz;
      b.vx -= fx; b.vy -= fy; b.vz -= fz;
    });
    codes.forEach((code) => {
      const n = nodes[code];
      if (code === orchCode) {
        n.vx += (cx - n.x) * 0.01; n.vy += (cy - n.y) * 0.01; n.vz += -n.z * 0.01;
      } else {
        const targetR = TIER_DIST[n.agent.tier];
        const dx = n.x - cx, dy = n.y - cy, dz = n.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
        const radialF = (dist - targetR) * 0.005;
        n.vx -= (dx / dist) * radialF; n.vy -= (dy / dist) * radialF; n.vz -= (dz / dist) * radialF;
      }
      n.vx *= DAMPING; n.vy *= DAMPING; n.vz *= DAMPING;
      n.x += n.vx; n.y += n.vy; n.z += n.vz;
      const pad = 70, zPad = Math.min(width, height) * 0.45;
      n.x = Math.max(pad, Math.min(width - pad, n.x));
      n.y = Math.max(pad, Math.min(height - pad, n.y));
      n.z = Math.max(-zPad, Math.min(zPad, n.z));
    });
  }
  return { nodes, edges };
}

// ── reflex orbital + edge derivations ───────────────────────────────────────
interface Orbital { id: string; reflexId: string; skillCode: string; baseAngle: number; orbitR: number; color: string; parentX: number; parentY: number; parentZ: number; }
interface Inspect { agent: Agent; }

// ════════════════════════════════════════════════════════════════════════════
export default function Cortex3DTab({ host: _host }: { host: HostApi }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const orch = useMemo(() => orchestratorOf(AGENTS)!, []);
  const skills = useMemo(() => skillsOf(AGENTS), []);
  const orchCode = orch.code;

  const [dims, setDims] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1.0);
  const [zoomLabel, setZoomLabel] = useState(100);
  const [inspect, setInspect] = useState<Inspect | null>(null);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ axons: true, reflexes: true, vectors: true, grid: true });
  const [activeTiers, setActiveTiers] = useState<Tier[]>(["surface", "core", "deep"]);
  const [autoRotate, setAutoRotate] = useState(true);

  const reduceMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    []
  );

  // rotation + interaction refs
  const rotX = useRef(-0.28);
  const rotY = useRef(0.45);
  const dragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef({ x: 0, y: 0 });
  const lastInteract = useRef(0);
  const animFrame = useRef(0);
  const timeRef = useRef(0);
  const spherePts = useRef<SpherePoint[]>([]);
  const zoomRef = useRef(zoom);
  const layersRef = useRef(layers);
  const tiersRef = useRef(activeTiers);
  const autoRef = useRef(autoRotate);
  const selRef = useRef<string | null>(selectedCode);
  const hoverRef = useRef<string | null>(null);

  useEffect(() => { zoomRef.current = zoom; setZoomLabel(Math.round(zoom * 100)); }, [zoom]);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { tiersRef.current = activeTiers; }, [activeTiers]);
  useEffect(() => { autoRef.current = autoRotate; }, [autoRotate]);
  useEffect(() => { selRef.current = selectedCode; }, [selectedCode]);

  useEffect(() => { spherePts.current = generateSpherePoints(VECTOR_COUNT, CLUSTER_COLORS.length); }, []);

  const layout = useMemo<Layout | null>(() => {
    if (dims.width === 0) return null;
    return computeForceLayout3D(AGENTS, orchCode, dims.width, dims.height);
  }, [dims.width, dims.height, orchCode]);

  const orbitals = useMemo<Orbital[]>(() => {
    if (!layout) return [];
    const out: Orbital[] = [];
    AGENTS.forEach((agent) => {
      const node = layout.nodes[agent.code];
      if (!node) return;
      (agent.reflexe || []).forEach((reflexId, i) => {
        out.push({
          id: `reflex-${agent.code}-${reflexId}`,
          reflexId, skillCode: agent.code,
          baseAngle: (i / agent.reflexe.length) * Math.PI * 2, orbitR: 55,
          color: "#22d3ee", parentX: node.x, parentY: node.y, parentZ: node.z,
        });
      });
    });
    return out;
  }, [layout]);

  // ── resize observer ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      const w = Math.round(width), h = Math.round(height);
      setDims((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // ── minimap renderer ──
  const minimapRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = minimapRef.current;
    if (!canvas || !layout || dims.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = 150, H = 108, dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = W / dims.width, sy = H / dims.height;
    ctx.clearRect(0, 0, W, H);
    layout.edges.forEach((e) => {
      const a = layout.nodes[e.from], b = layout.nodes[e.to];
      if (!a || !b) return;
      ctx.beginPath(); ctx.moveTo(a.x * sx, a.y * sy); ctx.lineTo(b.x * sx, b.y * sy);
      ctx.strokeStyle = "rgba(0,240,255,0.10)"; ctx.lineWidth = 0.5; ctx.stroke();
    });
    Object.entries(layout.nodes).forEach(([code, n]) => {
      const isU1 = code === orchCode, isSel = code === selectedCode;
      const color = n.agent.color;
      const r = isU1 ? 4 : isSel ? 3.4 : 2.3;
      if (isSel) { ctx.beginPath(); ctx.arc(n.x * sx, n.y * sy, r + 3, 0, Math.PI * 2); ctx.fillStyle = hexToRgba(color, 0.22); ctx.fill(); }
      ctx.beginPath(); ctx.arc(n.x * sx, n.y * sy, r, 0, Math.PI * 2);
      ctx.fillStyle = isSel || isU1 ? color : hexToRgba(color, 0.6); ctx.fill();
    });
    const vpW = (W / zoom), vpH = (H / zoom);
    ctx.setLineDash([3, 3]); ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 1;
    ctx.strokeRect((W - vpW) / 2, (H - vpH) / 2, vpW, vpH); ctx.setLineDash([]);
  }, [layout, dims, zoom, selectedCode, orchCode]);

  // ── hit detection ──
  const hitTest = useCallback((clientX: number, clientY: number): string | null => {
    if (!layout) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left, sy = clientY - rect.top;
    const W = dims.width, H = dims.height, cx = W / 2, cy = H / 2;
    const rx = rotX.current, ry = rotY.current, z = zoomRef.current;
    let best: string | null = null, bestDist = Infinity;
    Object.keys(layout.nodes).forEach((code) => {
      const node = layout.nodes[code];
      const p = project3D(node.x, node.y, node.z, rx, ry, cx, cy, z);
      const baseR = code === orchCode ? U1_RADIUS : SKILL_RADIUS;
      const r = Math.min(code === orchCode ? 54 : 40, Math.max(code === orchCode ? 14 : 10, baseR * p.depth * z)) + 8;
      const dx = sx - p.sx, dy = sy - p.sy, d = dx * dx + dy * dy;
      if (d < r * r && d < bestDist) { bestDist = d; best = code; }
    });
    return best;
  }, [layout, dims, orchCode]);

  // ── render loop ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !layout || dims.width === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = dims.width, H = dims.height, cx = W / 2, cy = H / 2;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const u1Node = layout.nodes[orchCode];

    const connectedSet = (): Set<string> | null => {
      const eff = hoverRef.current ?? selRef.current;
      if (!eff) return null;
      const agent = AGENTS.find((a) => a.code === eff);
      if (!agent) return null;
      const set = new Set<string>([eff]);
      agent.axone?.forEach((a) => set.add(a));
      return set;
    };
    const visible = (code: string): boolean =>
      code === orchCode ? true : tiersRef.current.includes(AGENTS.find((a) => a.code === code)!.tier);

    const draw = () => {
      const dt = reduceMotion ? 0.004 : 0.016;
      timeRef.current += dt;
      const t = timeRef.current;
      const rx = rotX.current, ry = rotY.current, zoomV = zoomRef.current;
      const L = layersRef.current;

      if (autoRef.current && !dragging.current && !reduceMotion && t - lastInteract.current > 2.4) {
        rotY.current += 0.0016;
      }

      // dark canvas well — same in BOTH themes
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "#0b2236");
      bg.addColorStop(1, "#050b16");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const vig = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.2, cx, cy, Math.max(W, H) * 0.72);
      vig.addColorStop(0, "rgba(0,240,255,0.04)");
      vig.addColorStop(1, "rgba(2,6,14,0.55)");
      ctx.fillStyle = vig; ctx.fillRect(0, 0, W, H);

      const connected = connectedSet();
      const isActive = (code: string) => !connected || connected.has(code);

      // project all nodes
      const proj: Record<string, Proj & { agent: Agent }> = {};
      Object.entries(layout.nodes).forEach(([code, node]) => {
        proj[code] = { ...project3D(node.x, node.y, node.z, rx, ry, cx, cy, zoomV), agent: node.agent };
      });
      const sortedCodes = Object.keys(proj).sort((a, b) => proj[b].z - proj[a].z);

      // ── grid ──
      if (L.grid) {
        ctx.strokeStyle = "rgba(120,180,220,0.045)"; ctx.lineWidth = 1;
        for (let gx = 0; gx < W; gx += 60) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, H); ctx.stroke(); }
        for (let gy = 0; gy < H; gy += 60) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(W, gy); ctx.stroke(); }
      }

      // ── VECTOR SPHERE ──
      if (L.vectors && spherePts.current.length) {
        const breath = 1 + Math.sin(t * 0.55) * 0.018;
        const worldR = WORLD_SPHERE_R * breath;
        const sC = project3D(u1Node.x, u1Node.y, u1Node.z, rx, ry, cx, cy, zoomV);
        const sCx = sC.sx, sCy = sC.sy;
        const edgeP = project3D(u1Node.x + worldR, u1Node.y, u1Node.z, rx, ry, cx, cy, zoomV);
        const sR = Math.abs(edgeP.sx - sCx);

        const pts = spherePts.current.map((p, i) => {
          const floatScale = 1 + Math.sin(t * 0.9 + i * 0.37) * 0.004;
          const pp = project3D(
            u1Node.x + p.x * worldR * floatScale,
            u1Node.y + p.y * worldR * floatScale,
            u1Node.z + p.z * worldR * floatScale,
            rx, ry, cx, cy, zoomV
          );
          const lz = p.x * Math.sin(ry) + p.z * Math.cos(ry);
          const localViewZ = p.y * Math.sin(rx) + lz * Math.cos(rx);
          return { ...pp, idx: i, cluster: p.cluster, similarity: p.similarity, localViewZ };
        }).sort((a, b) => b.z - a.z);

        pts.forEach((p) => {
          const color = CLUSTER_COLORS[p.cluster % CLUSTER_COLORS.length];
          const cull = Math.max(0, Math.min(1, (zoomV - 0.18) / 0.08));
          const frontFade = p.localViewZ < 0
            ? Math.max(0, Math.min(1, (p.localViewZ + 0.96) / 0.1)) * cull + (1 - cull)
            : 1.0;
          const zoomBoost = Math.max(1, 0.25 / zoomV);
          const insideBoost = 1 + (1 - cull) * 0.8;
          const limb = 1 - Math.abs(p.localViewZ);
          const limbBright = limb * limb * 0.35;
          const alpha = Math.min(0.95, (0.26 + p.depth * 0.46 + limbBright) * zoomBoost * insideBoost) * frontFade;
          const pr = Math.max(1.2, SPHERE_POINT_RADIUS * p.scale * (1 + p.similarity * 0.4));
          ctx.beginPath(); ctx.arc(p.sx, p.sy, pr, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, alpha);
          ctx.shadowColor = color; ctx.shadowBlur = p.depth > 1 ? 5 : 2;
          ctx.fill(); ctx.shadowBlur = 0;
        });

        ctx.font = "700 8px var(--mono, monospace)";
        ctx.fillStyle = "rgba(251,191,36,0.22)"; ctx.textAlign = "center";
        ctx.fillText("VECTOR · CHROMADB", sCx, sCy + sR + 16);
      }

      // ── EDGES ──
      if (L.axons) {
        layout.edges.forEach((edge, edgeIdx) => {
          const a = proj[edge.from], b = proj[edge.to];
          if (!a || !b || !visible(edge.from) || !visible(edge.to)) return;
          const active = isActive(edge.from) && isActive(edge.to);
          const avgDepth = (a.depth + b.depth) * 0.5;
          const axonId = edge.to === orchCode ? edge.from : edge.to;
          const edgeColor = AXON_TYPE_COLORS[axonType(axonId)];
          const fog = Math.max(0.5, Math.min(1, avgDepth));
          ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
          ctx.strokeStyle = active ? hexToRgba(edgeColor, (0.22 + avgDepth * 0.34) * fog) : "rgba(255,255,255,0.04)";
          ctx.lineWidth = active ? Math.max(0.8, avgDepth * 2.2 * zoomV * fog) : 0.5;
          ctx.stroke();
          if (active) {
            const highlighted = !!selRef.current;
            for (let pi = 0; pi < 2; pi++) {
              const progress = (t * 0.12 + edgeIdx * 0.31 + pi * 0.5) % 1;
              const px = a.sx + (b.sx - a.sx) * progress;
              const py = a.sy + (b.sy - a.sy) * progress;
              const pd = a.depth + (b.depth - a.depth) * progress;
              ctx.beginPath(); ctx.arc(px, py, (highlighted ? 2.2 : 1.4) * pd, 0, Math.PI * 2);
              ctx.fillStyle = hexToRgba(edgeColor, highlighted ? 0.95 : 0.55);
              ctx.shadowColor = edgeColor; ctx.shadowBlur = highlighted ? 8 : 4; ctx.fill(); ctx.shadowBlur = 0;
            }
          }
        });
      }

      // ── REFLEX ORBITALS ──
      if (L.reflexes) {
        orbitals.forEach((ro) => {
          if (!visible(ro.skillCode)) return;
          const active = isActive(ro.skillCode);
          if (!active && selRef.current) return;
          const ang = ro.baseAngle + t * 0.3;
          const ox = ro.parentX + Math.cos(ang) * ro.orbitR;
          const oy = ro.parentY + Math.sin(ang) * ro.orbitR;
          const oz = ro.parentZ + Math.sin(ang * 0.7) * 20;
          const rp = project3D(ox, oy, oz, rx, ry, cx, cy, zoomV);
          const size = 4 * rp.scale;
          const alpha = active ? 0.5 + rp.depth * 0.35 : 0.08;
          ctx.save(); ctx.translate(rp.sx, rp.sy); ctx.rotate(Math.PI / 4);
          ctx.beginPath(); ctx.rect(-size, -size, size * 2, size * 2);
          ctx.fillStyle = hexToRgba(ro.color, alpha * 0.5); ctx.fill();
          ctx.strokeStyle = hexToRgba(ro.color, active ? alpha : 0.06); ctx.lineWidth = 1; ctx.stroke();
          ctx.restore();
        });
      }

      // ── NODES (painter-sorted) ──
      sortedCodes.forEach((code) => {
        if (!visible(code)) return;
        const p = proj[code];
        const agent = p.agent;
        const active = isActive(code);
        const isU1 = code === orchCode;
        const isHov = hoverRef.current === code;
        const isSel = selRef.current === code;
        const baseR = isU1 ? U1_RADIUS : SKILL_RADIUS;
        const r = Math.min(isU1 ? 54 : 40, Math.max(isU1 ? 14 : 10, baseR * p.depth * zoomV)) * (isHov ? 1.08 : 1);
        const color = agent.color;
        const fog = Math.max(0.5, Math.min(1, p.depth));
        const aF = active ? Math.max(0.35, p.depth) * fog : 0.1 * fog;

        if (isU1) {
          const u1t = t * (active ? 1 : 0.3);
          // corona halo
          const coronaR = r * 3.2;
          const cg = ctx.createRadialGradient(p.sx, p.sy, r * 0.8, p.sx, p.sy, coronaR);
          cg.addColorStop(0, hexToRgba(color, 0.22 * aF));
          cg.addColorStop(0.45, hexToRgba(color, 0.07 * aF));
          cg.addColorStop(1, "transparent");
          ctx.beginPath(); ctx.arc(p.sx, p.sy, coronaR, 0, Math.PI * 2); ctx.fillStyle = cg; ctx.fill();

          const u1w = layout.nodes[code];
          const orbR1 = (r + 16) / p.scale, orbR2 = (r + 24) / p.scale;
          const prec1 = u1t * 0.38, prec2 = u1t * 0.26, N = 48;
          // ring 1
          ctx.beginPath();
          for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const op = project3D(u1w.x + Math.cos(a) * Math.cos(prec1) * orbR1, u1w.y + Math.sin(a) * orbR1, u1w.z + Math.cos(a) * Math.sin(prec1) * orbR1, rx, ry, cx, cy, zoomV);
            i === 0 ? ctx.moveTo(op.sx, op.sy) : ctx.lineTo(op.sx, op.sy);
          }
          ctx.strokeStyle = hexToRgba(color, 0.55 * aF); ctx.lineWidth = 1.3; ctx.stroke();
          const s1a = t * 1.1;
          const sat1 = project3D(u1w.x + Math.cos(s1a) * Math.cos(prec1) * orbR1, u1w.y + Math.sin(s1a) * orbR1, u1w.z + Math.cos(s1a) * Math.sin(prec1) * orbR1, rx, ry, cx, cy, zoomV);
          ctx.beginPath(); ctx.arc(sat1.sx, sat1.sy, Math.max(1, 2.8 * sat1.depth * zoomV), 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.95 * aF); ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
          // ring 2 (counter)
          ctx.beginPath();
          for (let i = 0; i <= N; i++) {
            const a = (i / N) * Math.PI * 2;
            const op = project3D(u1w.x + Math.cos(a) * orbR2, u1w.y + Math.sin(a) * Math.sin(prec2) * orbR2, u1w.z + Math.sin(a) * Math.cos(prec2) * orbR2, rx, ry, cx, cy, zoomV);
            i === 0 ? ctx.moveTo(op.sx, op.sy) : ctx.lineTo(op.sx, op.sy);
          }
          ctx.strokeStyle = hexToRgba(color, 0.38 * aF); ctx.lineWidth = 1; ctx.stroke();
          const s2a = -t * 0.82 + 1.4;
          const sat2 = project3D(u1w.x + Math.cos(s2a) * orbR2, u1w.y + Math.sin(s2a) * Math.sin(prec2) * orbR2, u1w.z + Math.sin(s2a) * Math.cos(prec2) * orbR2, rx, ry, cx, cy, zoomV);
          ctx.beginPath(); ctx.arc(sat2.sx, sat2.sy, Math.max(1, 2.2 * sat2.depth * zoomV), 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(color, 0.8 * aF); ctx.shadowColor = color; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
          // scanner arc + trailing fade
          const scanA = u1t * 1.4;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 9, scanA, scanA + Math.PI * 0.55);
          ctx.strokeStyle = hexToRgba(color, 0.85 * aF); ctx.lineWidth = 1.8; ctx.stroke();
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 9, scanA + Math.PI * 0.55, scanA + Math.PI * 0.95);
          ctx.strokeStyle = hexToRgba(color, 0.2 * aF); ctx.lineWidth = 1.2; ctx.stroke();
          // dashed orbit
          ctx.beginPath(); ctx.arc(p.sx, p.sy, r + 9, 0, Math.PI * 2);
          ctx.strokeStyle = hexToRgba(color, 0.18 * aF); ctx.setLineDash([2, 7]); ctx.lineWidth = 0.8; ctx.stroke(); ctx.setLineDash([]);
          // inner hexagon
          const hexA = u1t * 0.22;
          ctx.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = hexA + (i / 6) * Math.PI * 2;
            const hx = p.sx + Math.cos(a) * r * 0.52, hy = p.sy + Math.sin(a) * r * 0.52;
            i === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
          }
          ctx.closePath(); ctx.strokeStyle = hexToRgba(color, 0.45 * aF); ctx.lineWidth = 1; ctx.stroke();
          // radiating ticks
          for (let i = 0; i < 4; i++) {
            const ta = u1t * 1.4 + (i / 4) * Math.PI * 2;
            ctx.beginPath();
            ctx.moveTo(p.sx + Math.cos(ta) * (r + 6), p.sy + Math.sin(ta) * (r + 6));
            ctx.lineTo(p.sx + Math.cos(ta) * (r + 14), p.sy + Math.sin(ta) * (r + 14));
            ctx.strokeStyle = hexToRgba(color, 0.6 * aF); ctx.lineWidth = 1.5; ctx.stroke();
          }
        } else if (active && isSel) {
          const pulseR = r + 6 + Math.sin(t * 2.5) * 4;
          ctx.beginPath(); ctx.arc(p.sx, p.sy, pulseR, 0, Math.PI * 2);
          ctx.strokeStyle = hexToRgba(color, 0.2 * aF); ctx.lineWidth = 1.5; ctx.stroke();
        }

        // glow
        if (active) {
          const glowR = r + (isSel ? 22 : 14);
          const g = ctx.createRadialGradient(p.sx, p.sy, r * 0.5, p.sx, p.sy, glowR);
          g.addColorStop(0, hexToRgba(color, (isSel ? 0.35 : 0.18) * aF));
          g.addColorStop(1, "transparent");
          ctx.beginPath(); ctx.arc(p.sx, p.sy, glowR, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
        }
        // body
        ctx.beginPath(); ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
        ctx.fillStyle = active ? `rgba(8,16,30,${Math.min(0.95, 0.7 + aF * 0.25)})` : "rgba(8,16,30,0.30)"; ctx.fill();
        ctx.strokeStyle = active ? hexToRgba(color, (isSel ? 1 : 0.85) * aF) : hexToRgba(color, 0.12);
        ctx.lineWidth = isSel ? 3.5 : active ? 2.5 : 0.8; ctx.stroke();
        if (active) { ctx.beginPath(); ctx.arc(p.sx, p.sy, r - 4, 0, Math.PI * 2); ctx.strokeStyle = hexToRgba(color, 0.15); ctx.lineWidth = 1; ctx.stroke(); }

        // labels
        if (r > 10) {
          const sc = Math.min(1.6, p.depth * zoomV);
          const fs = Math.max(7, (isU1 ? 18 : 13) * sc);
          ctx.font = `900 ${fs}px var(--mono, monospace)`;
          ctx.fillStyle = active ? hexToRgba(color, aF) : hexToRgba(color, 0.12);
          ctx.textAlign = "center"; ctx.textBaseline = "middle";
          ctx.fillText(code, p.sx, p.sy - (isU1 ? 4 : 2) * sc);
          if (active && r > 14) {
            ctx.font = `700 ${Math.max(5, (isU1 ? 8 : 7) * sc)}px var(--mono, monospace)`;
            ctx.fillStyle = `rgba(255,255,255,${0.45 * aF})`;
            ctx.fillText(agent.name.toUpperCase(), p.sx, p.sy + (isU1 ? 14 : 11) * sc);
          }
          if (active && !isU1 && r > 18) {
            ctx.font = `600 ${Math.max(5, 7 * sc)}px var(--mono, monospace)`;
            ctx.fillStyle = hexToRgba(color, 0.35 * aF);
            ctx.fillText((agent.role || "").toUpperCase(), p.sx, p.sy + r + 12 * sc);
          }
        }
        // status dot
        if (active) {
          const sc2 = agent.status === "running" ? "#10b981" : agent.status === "idle" ? "#f59e0b" : "#ef4444";
          ctx.beginPath(); ctx.arc(p.sx + r - 4 * p.depth, p.sy - r + 4 * p.depth, Math.max(2, 3 * p.depth), 0, Math.PI * 2);
          ctx.fillStyle = sc2; ctx.shadowColor = sc2; ctx.shadowBlur = 6 * p.depth; ctx.fill(); ctx.shadowBlur = 0;
        }
      });

      animFrame.current = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(animFrame.current);
  }, [layout, dims, orbitals, orchCode, reduceMotion]);

  // ── pointer interactions (non-passive wheel + touch) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      lastInteract.current = timeRef.current;
      setZoom((z) => Math.max(0.08, Math.min(4, z * (e.deltaY > 0 ? 0.92 : 1.08))));
    };
    let touchDist: number | null = null;
    const onTS = (e: TouchEvent) => {
      e.preventDefault();
      lastInteract.current = timeRef.current;
      if (e.touches.length === 1) {
        dragging.current = true;
        dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        dragOrigin.current = { ...dragStart.current };
      } else if (e.touches.length === 2) {
        const dx = e.touches[1].clientX - e.touches[0].clientX, dy = e.touches[1].clientY - e.touches[0].clientY;
        touchDist = Math.sqrt(dx * dx + dy * dy);
      }
    };
    const onTM = (e: TouchEvent) => {
      e.preventDefault();
      lastInteract.current = timeRef.current;
      if (e.touches.length === 1 && dragging.current) {
        rotY.current += (e.touches[0].clientX - dragStart.current.x) * 0.005;
        rotX.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX.current + (e.touches[0].clientY - dragStart.current.y) * 0.005));
        dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      } else if (e.touches.length === 2 && touchDist !== null) {
        const dx = e.touches[1].clientX - e.touches[0].clientX, dy = e.touches[1].clientY - e.touches[0].clientY;
        const d = Math.sqrt(dx * dx + dy * dy);
        setZoom((z) => Math.max(0.08, Math.min(4, (z * d) / touchDist!)));
        touchDist = d;
      }
    };
    const onTE = (e: TouchEvent) => {
      if (e.changedTouches.length === 1 && dragOrigin.current) {
        const moved = Math.abs(e.changedTouches[0].clientX - dragOrigin.current.x) + Math.abs(e.changedTouches[0].clientY - dragOrigin.current.y);
        if (moved < 8) {
          const hit = hitTest(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
          applySelect(hit);
        }
      }
      touchDist = null; dragging.current = false;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTS, { passive: false });
    el.addEventListener("touchmove", onTM, { passive: false });
    el.addEventListener("touchend", onTE, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove", onTM);
      el.removeEventListener("touchend", onTE);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hitTest]);

  const applySelect = useCallback((code: string | null) => {
    if (!code) { setSelectedCode(null); setInspect(null); return; }
    const agent = AGENTS.find((a) => a.code === code);
    setSelectedCode((prev) => (prev === code ? null : code));
    setInspect((prev) => (prev?.agent.code === code ? null : agent ? { agent } : null));
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    dragging.current = true; lastInteract.current = timeRef.current;
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragOrigin.current = { x: e.clientX, y: e.clientY };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragging.current) {
      lastInteract.current = timeRef.current;
      rotY.current += (e.clientX - dragStart.current.x) * 0.005;
      rotX.current = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rotX.current + (e.clientY - dragStart.current.y) * 0.005));
      dragStart.current = { x: e.clientX, y: e.clientY };
    } else {
      const hit = hitTest(e.clientX, e.clientY);
      hoverRef.current = hit;
      if (canvasRef.current) canvasRef.current.style.cursor = hit ? "pointer" : "grab";
    }
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (dragging.current) {
      const moved = Math.abs(e.clientX - dragOrigin.current.x) + Math.abs(e.clientY - dragOrigin.current.y);
      if (moved < 5) applySelect(hitTest(e.clientX, e.clientY));
    }
    dragging.current = false;
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") { setInspect(null); setSelectedCode(null); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const toggleLayer = (k: LayerKey) => setLayers((p) => ({ ...p, [k]: !p[k] }));
  const toggleTier = (tier: Tier) =>
    setActiveTiers((p) => (p.includes(tier) ? (p.length > 1 ? p.filter((x) => x !== tier) : p) : [...p, tier]));
  const resetView = () => { setZoom(1.0); rotX.current = -0.28; rotY.current = 0.45; };

  // ── HUD aggregates ──
  const running = skills.filter((s) => s.status === "running").length + (orch.status === "running" ? 1 : 0);
  const totalCpu = AGENTS.reduce((s, a) => s + a.cpu, 0);
  const totalMem = AGENTS.reduce((s, a) => s + a.mem, 0);
  const totalAxone = new Set(AGENTS.flatMap((a) => a.axone || [])).size;
  const totalReflexe = new Set(AGENTS.flatMap((a) => a.reflexe || [])).size;

  return (
    <div className="cx3" ref={containerRef}>
      <canvas
        className="cx3-canvas"
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => { dragging.current = false; hoverRef.current = null; }}
      />

      {/* HUD chip strip */}
      <div className="cx3-hud">
        <div className="cx3-chip"><span className="cx3-chip-l">Skills</span><b style={{ color: "#10b981" }}>{running}/{AGENTS.length}</b></div>
        <div className="cx3-chip"><span className="cx3-chip-l">ΣCPU</span><b style={{ color: totalCpu > 80 ? "#ef4444" : "#fbbf24" }}>{totalCpu}%</b></div>
        <div className="cx3-chip"><span className="cx3-chip-l">ΣRAM</span><b style={{ color: "#3b82f6" }}>{(totalMem / 1024).toFixed(1)}GB</b></div>
        <div className="cx3-chip"><span className="cx3-chip-l">Axone</span><b style={{ color: "#a78bfa" }}>{totalAxone}</b></div>
        <div className="cx3-chip"><span className="cx3-chip-l">Reflexe</span><b style={{ color: "#22d3ee" }}>{totalReflexe}</b></div>
      </div>

      {/* Controls: layers, tiers, auto-rotate */}
      <div className="cx3-ctrl">
        <div className="cx3-ctrl-h">Layer</div>
        <div className="cx3-toggles">
          {LAYERS.map((l) => (
            <button
              key={l.key}
              className={`cx3-tog${layers[l.key] ? " on" : ""}`}
              style={{ "--c": l.color } as React.CSSProperties}
              onClick={() => toggleLayer(l.key)}
            >
              <span className="cx3-tog-sw" /><span>{l.label}</span>
            </button>
          ))}
        </div>
        <div className="cx3-ctrl-h">Tier</div>
        <div className="cx3-tiers">
          {TIERS.map((tier) => {
            const on = activeTiers.includes(tier);
            const tc = TIER_CONFIG[tier].color;
            return (
              <button
                key={tier}
                className={`cx3-tier${on ? " on" : ""}`}
                style={{ "--c": tc } as React.CSSProperties}
                onClick={() => toggleTier(tier)}
              >
                {TIER_CONFIG[tier].label}
              </button>
            );
          })}
        </div>
        <button className={`cx3-tog cx3-auto${autoRotate ? " on" : ""}`} style={{ "--c": "#00f0ff" } as React.CSSProperties} onClick={() => setAutoRotate((p) => !p)}>
          <span className="cx3-tog-sw" /><span>Auto-Rotate</span>
        </button>
      </div>

      {/* Minimap */}
      <div className="cx3-mini">
        <span className="cx3-mini-l">Map</span>
        <canvas ref={minimapRef} className="cx3-mini-c" />
      </div>

      {/* Zoom controls */}
      <div className="cx3-zoom">
        <button className="cx3-zb" onClick={() => setZoom((z) => Math.max(0.08, z * 0.8))} aria-label="Verkleinern">−</button>
        <button className="cx3-zr" onClick={resetView}>{zoomLabel}%</button>
        <button className="cx3-zb" onClick={() => setZoom((z) => Math.min(4, z * 1.2))} aria-label="Vergrößern">+</button>
      </div>

      {/* Inspector */}
      {inspect && (
        <div className="cx3-insp" style={{ "--c": inspect.agent.color } as React.CSSProperties}>
          <span className="cx3-insp-glow" />
          <button className="cx3-insp-x" onClick={() => applySelect(null)} aria-label="Schließen">✕</button>
          <div className="cx3-insp-h">
            <span className="cx3-insp-orb">{inspect.agent.code}</span>
            <div className="cx3-insp-ht">
              <b>{inspect.agent.name}</b>
              <i>{inspect.agent.role}</i>
            </div>
          </div>
          <div className={`cx3-insp-status s-${inspect.agent.status}`}>
            <i />{inspect.agent.status === "running" ? "Aktiv" : inspect.agent.status === "idle" ? "Bereit" : inspect.agent.code === orchCode ? "Orchestrator" : inspect.agent.status}
            <span className="cx3-insp-tier">{TIER_CONFIG[inspect.agent.tier].label}</span>
          </div>
          <p className="cx3-insp-desc">{inspect.agent.desc}</p>
          <div className="cx3-insp-stats">
            <div className="cx3-stat"><span>CPU</span><b>{inspect.agent.cpu}%</b><div className="cx3-bar"><div style={{ width: `${Math.min(100, inspect.agent.cpu)}%`, background: inspect.agent.color }} /></div></div>
            <div className="cx3-stat"><span>RAM</span><b>{inspect.agent.mem} MB</b><div className="cx3-bar"><div style={{ width: `${Math.min(100, (inspect.agent.mem / 640) * 100)}%`, background: inspect.agent.color }} /></div></div>
          </div>
          <div className="cx3-insp-sec">
            <span className="cx3-sec-l">Axone · {inspect.agent.axone.length}</span>
            <div className="cx3-axone">
              {inspect.agent.axone.map((code) => {
                const t = AGENTS.find((a) => a.code === code);
                return (
                  <button key={code} className="cx3-axchip" style={{ "--c": t?.color || "#06b6d4" } as React.CSSProperties} onClick={() => t && applySelect(code)}>
                    <span>{code}</span>{t ? ` ${t.name}` : ""}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="cx3-insp-sec">
            <span className="cx3-sec-l">Reflexe · {inspect.agent.reflexe.length}</span>
            <div className="cx3-reflexe">
              {inspect.agent.reflexe.map((rx) => (
                <span key={rx} className="cx3-rxchip">{rx}</span>
              ))}
            </div>
          </div>
        </div>
      )}

      <style>{`
.cx3{position:absolute;inset:0;overflow:hidden;touch-action:none;background:#050b16;font-family:var(--mono,ui-monospace,monospace)}
.cx3-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab}
.cx3-canvas:active{cursor:grabbing}

/* HUD chip strip */
.cx3-hud{position:absolute;top:16px;left:16px;display:flex;gap:8px;z-index:5;flex-wrap:wrap;max-width:62%}
.cx3-chip{display:flex;flex-direction:column;gap:2px;padding:7px 12px;border-radius:var(--r-sm,10px);background:var(--glass,rgba(10,22,38,.78));border:1px solid var(--glass-edge,rgba(255,255,255,.08));box-shadow:var(--shadow-sm,0 4px 14px rgba(0,0,0,.3));backdrop-filter:blur(12px);min-width:54px}
.cx3-chip-l{font-size:7.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3,rgba(200,220,235,.4))}
.cx3-chip b{font-size:15px;font-weight:800;letter-spacing:-.02em}

/* Controls */
.cx3-ctrl{position:absolute;top:16px;right:16px;width:188px;display:flex;flex-direction:column;gap:8px;padding:13px;border-radius:var(--r,14px);background:var(--glass,rgba(10,22,38,.82));border:1px solid var(--glass-edge,rgba(255,255,255,.08));box-shadow:var(--shadow,0 12px 40px rgba(0,0,0,.4));backdrop-filter:blur(16px);z-index:6}
.cx3-ctrl-h{font-size:8px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:var(--ink3,rgba(200,220,235,.4));margin-top:2px}
.cx3-toggles{display:flex;flex-direction:column;gap:3px}
.cx3-tog{display:flex;align-items:center;gap:9px;padding:5px 8px;border-radius:7px;border:none;background:transparent;cursor:pointer;width:100%;text-align:left;font-family:inherit;font-size:9.5px;color:var(--ink3,rgba(200,220,235,.32));letter-spacing:.04em;transition:background .18s ease,color .18s ease}
.cx3-tog.on{color:var(--ink,#eaf4fb);background:var(--fill-weak,rgba(0,240,255,.05))}
.cx3-tog-sw{flex:none;position:relative;width:24px;height:14px;border-radius:7px;background:var(--fill-weak,rgba(255,255,255,.07));border:1px solid var(--line,rgba(255,255,255,.1));transition:border-color .18s ease}
.cx3-tog-sw::after{content:"";position:absolute;top:1px;left:1px;width:10px;height:10px;border-radius:50%;background:var(--ink3,rgba(200,220,235,.3));transition:left .18s ease,background .18s ease,box-shadow .18s ease}
.cx3-tog.on .cx3-tog-sw{border-color:var(--c,#06b6d4)}
.cx3-tog.on .cx3-tog-sw::after{left:12px;background:var(--c,#06b6d4);box-shadow:0 0 7px var(--c,#06b6d4)}
.cx3-auto{margin-top:2px}
.cx3-tiers{display:flex;gap:4px}
.cx3-tier{flex:1;padding:5px 0;border-radius:6px;background:var(--fill-weak,rgba(255,255,255,.03));border:1px solid var(--line,rgba(255,255,255,.06));color:var(--ink3,rgba(200,220,235,.28));font-family:inherit;font-size:8px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;transition:all .18s ease}
.cx3-tier.on{color:var(--c,#06b6d4);border-color:var(--c,#06b6d4);background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.12),rgba(0,0,0,.5))}

/* Minimap */
.cx3-mini{position:absolute;bottom:74px;left:16px;display:flex;flex-direction:column;gap:4px;z-index:5}
.cx3-mini-l{font-size:7.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink3,rgba(200,220,235,.35))}
.cx3-mini-c{width:150px;height:108px;border-radius:var(--r-sm,10px);border:1px solid var(--glass-edge,rgba(255,255,255,.08));background:var(--glass,rgba(10,22,38,.7));box-shadow:var(--shadow-sm,0 4px 14px rgba(0,0,0,.3))}

/* Zoom */
.cx3-zoom{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:3px;border-radius:100px;background:var(--glass,rgba(10,22,38,.82));border:1px solid var(--glass-edge,rgba(255,255,255,.08));box-shadow:var(--shadow-sm,0 4px 14px rgba(0,0,0,.3));backdrop-filter:blur(12px);z-index:5}
.cx3-zb{width:28px;height:28px;border-radius:50%;border:1px solid var(--line,rgba(255,255,255,.08));background:var(--fill-weak,rgba(255,255,255,.04));color:var(--ink2,rgba(220,235,245,.6));font-size:15px;cursor:pointer;display:grid;place-items:center;line-height:1;transition:background .15s ease}
.cx3-zb:hover{background:var(--fill-weak,rgba(0,240,255,.12))}
.cx3-zr{background:transparent;border:none;color:var(--ink3,rgba(200,220,235,.4));font-family:inherit;font-size:9.5px;padding:0 10px;cursor:pointer}

/* Inspector */
.cx3-insp{position:absolute;top:16px;left:50%;transform:translateX(-50%);width:min(360px,calc(100% - 32px));max-height:calc(100% - 110px);overflow:auto;padding:18px;border-radius:var(--r,14px);background:var(--glass,rgba(10,22,38,.92));border:1px solid var(--glass-edge,rgba(255,255,255,.1));box-shadow:var(--shadow,0 18px 50px rgba(0,0,0,.5));backdrop-filter:blur(20px);z-index:20;animation:cx3-up .26s cubic-bezier(.2,.9,.25,1)}
.cx3-insp-glow{position:absolute;top:-1px;left:18px;right:18px;height:2px;border-radius:2px;background:var(--c,#06b6d4);box-shadow:0 0 16px var(--c,#06b6d4);opacity:.8}
.cx3-insp-x{position:absolute;top:12px;right:12px;width:24px;height:24px;border-radius:7px;border:1px solid var(--line,rgba(255,255,255,.1));background:var(--fill-weak,rgba(255,255,255,.04));color:var(--ink2,rgba(220,235,245,.6));font-size:11px;cursor:pointer;display:grid;place-items:center}
.cx3-insp-x:hover{color:var(--ink,#eaf4fb)}
.cx3-insp-h{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.cx3-insp-orb{flex:none;display:grid;place-items:center;min-width:42px;height:42px;padding:0 8px;border-radius:11px;font-weight:900;font-size:14px;color:#04161f;background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.4),rgba(0,0,0,.32));box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 0 18px var(--c,#06b6d4)}
.cx3-insp-ht{display:flex;flex-direction:column;line-height:1.3}
.cx3-insp-ht b{font-size:17px;font-weight:760;color:var(--ink,#eaf4fb);font-family:var(--mono,ui-monospace,monospace)}
.cx3-insp-ht i{font-size:11px;font-style:normal;color:var(--ink3,rgba(200,220,235,.5))}
.cx3-insp-status{display:flex;align-items:center;gap:7px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--ink2,rgba(220,235,245,.6));margin-bottom:12px}
.cx3-insp-status i{width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:cx3-beat 1.6s ease-out infinite}
.cx3-insp-status.s-idle i{background:#f59e0b;box-shadow:0 0 8px #f59e0b}
.cx3-insp-status.s-error i{background:#ef4444;box-shadow:0 0 8px #ef4444}
.cx3-insp-status.s-stopped i{background:#94a3b8;box-shadow:none;animation:none}
.cx3-insp-tier{margin-left:auto;padding:2px 9px;border-radius:100px;font-size:8.5px;color:var(--ink3,rgba(200,220,235,.45));border:1px solid var(--line,rgba(255,255,255,.1));background:var(--fill-weak,rgba(255,255,255,.04))}
.cx3-insp-desc{font-size:12px;line-height:1.55;color:var(--ink2,rgba(220,235,245,.62));margin:0 0 14px;font-family:inherit}
.cx3-insp-stats{display:flex;gap:10px;margin-bottom:14px}
.cx3-stat{flex:1;display:flex;flex-direction:column;gap:3px;padding:9px 11px;border-radius:var(--r-xs,8px);background:var(--glass2,rgba(255,255,255,.03));border:1px solid var(--line,rgba(255,255,255,.07))}
.cx3-stat span{font-size:8px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3,rgba(200,220,235,.4))}
.cx3-stat b{font-size:15px;font-weight:800;color:var(--ink,#eaf4fb)}
.cx3-bar{height:3px;border-radius:2px;background:var(--fill-weak,rgba(255,255,255,.07));overflow:hidden;margin-top:2px}
.cx3-bar>div{height:100%;border-radius:2px;transition:width .5s ease}
.cx3-insp-sec{margin-bottom:12px}
.cx3-sec-l{display:block;font-size:8.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3,rgba(200,220,235,.42));margin-bottom:7px;padding-bottom:5px;border-bottom:1px solid var(--line2,rgba(255,255,255,.05))}
.cx3-axone{display:flex;flex-wrap:wrap;gap:6px}
.cx3-axchip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px 4px 5px;border-radius:100px;font-family:inherit;font-size:10px;color:var(--ink2,rgba(220,235,245,.7));background:var(--glass2,rgba(255,255,255,.03));border:1px solid var(--line,rgba(255,255,255,.08));cursor:pointer;transition:border-color .15s ease}
.cx3-axchip span{display:grid;place-items:center;min-width:24px;height:18px;padding:0 4px;border-radius:5px;font-size:8.5px;font-weight:800;color:#04161f;background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.4),rgba(0,0,0,.32))}
.cx3-axchip:hover{border-color:var(--c,#06b6d4)}
.cx3-reflexe{display:flex;flex-wrap:wrap;gap:6px}
.cx3-rxchip{padding:4px 11px;border-radius:100px;font-size:10px;color:#22d3ee;background:rgba(34,211,238,.08);border:1px solid rgba(34,211,238,.22)}

@keyframes cx3-up{from{opacity:0;transform:translateX(-50%) translateY(-14px) scale(.97)}to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}
@keyframes cx3-beat{0%{box-shadow:0 0 0 0 rgba(16,185,129,.5)}100%{box-shadow:0 0 0 6px rgba(16,185,129,0)}}

@media (prefers-reduced-motion:reduce){
  .cx3-insp{animation:none}
  .cx3-insp-status i{animation:none}
  .cx3-tog,.cx3-tier,.cx3-tog-sw::after,.cx3-bar>div{transition:none}
}
@media (max-width:900px){
  .cx3-hud{max-width:calc(100% - 32px)}
  .cx3-ctrl{width:160px;padding:10px}
  .cx3-mini{display:none}
  .cx3-insp{width:calc(100% - 24px);left:12px;transform:none;animation:cx3-up-m .24s ease}
  .cx3-insp-x{top:10px;right:10px}
}
@keyframes cx3-up-m{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:none}}
`}</style>
    </div>
  );
}
