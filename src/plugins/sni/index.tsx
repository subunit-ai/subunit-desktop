/**
 * Cortex — SNI's signature neural map, native in Subunit Liquid Glass.
 *
 * The Subunit Neural Interface (sni.subunit.ai) visualises the agency's agent
 * "nervous system": U1 the orchestrator at the core, 11 specialist agents on
 * three tier rings, wired by AXONE (connections) and firing REFLEXE (triggers).
 * The original SNI Cortex is a 1200-line 3D force graph; this is a clean, premium
 * reinterpretation — a 2D glass neural map with glowing synapses, a contextual
 * agent inspector, a system HUD and a live synapse log.
 *
 * The map well is a deep-glass "viewport into the cortex" (dark in BOTH themes,
 * per SNI's technical aesthetic) while the surrounding chrome follows the theme.
 *
 * Permissions: none privileged (nav + ui are ungated). Data is the ported SNI
 * registry (agents.ts); wiring it to the live bot host is a later phase.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";
import {
  AGENTS,
  LOG_TEMPLATES,
  TIER_LABEL,
  type Agent,
  type Tier,
} from "./agents";
import HomeTab from "./tabs/Home";
import SkillsTab from "./tabs/Skills";
import NetworkTab from "./tabs/Network";
import ReflexeTab from "./tabs/Reflexe";
import U1Tab from "./tabs/U1";
import SecurityTab from "./tabs/Security";
import Cortex3DTab from "./tabs/Cortex3D";

const ICON = `<svg viewBox="0 0 24 24"><path d="M12 5a3 3 0 1 0-2.6-4.5"/><circle cx="12" cy="12" r="2.4"/><circle cx="5.5" cy="7.5" r="1.8"/><circle cx="18.5" cy="7.5" r="1.8"/><circle cx="6" cy="17" r="1.8"/><circle cx="18" cy="17" r="1.8"/><path d="M10 11 6.9 8.6M14 11l3.1-2.4M10.7 13.4 7.3 15.8M13.3 13.4l3.4 2.4M12 9.6V6"/></svg>`;

const W = 820;
const H = 720;
const CENTER = { x: W / 2, y: H / 2 };
// Radii leave headroom so the outer (deep) ring + its labels never clip the well.
const RING_R: Record<Tier, number> = { core: 150, surface: 238, deep: 318 };
const RING_OFFSET: Record<Tier, number> = { core: -90, surface: -54, deep: -67 };

type Pos = { x: number; y: number };

/** Deterministic node layout: U1 at center, others on tier rings. */
function layout(agents: Agent[]): Record<string, Pos> {
  const pos: Record<string, Pos> = { U1: { ...CENTER } };
  const groups: Record<Tier, Agent[]> = { surface: [], core: [], deep: [] };
  for (const a of agents) if (a.code !== "U1") groups[a.tier].push(a);
  (Object.keys(groups) as Tier[]).forEach((tier) => {
    const list = groups[tier];
    const r = RING_R[tier];
    list.forEach((a, i) => {
      const ang = ((RING_OFFSET[tier] + (i / list.length) * 360) * Math.PI) / 180;
      pos[a.code] = { x: CENTER.x + r * Math.cos(ang), y: CENTER.y + r * Math.sin(ang) };
    });
  });
  return pos;
}

interface Edge {
  from: string;
  to: string;
  color: string;
  active: boolean;
  d: string;
}

function buildEdges(agents: Agent[], pos: Record<string, Pos>): Edge[] {
  const byCode = new Map(agents.map((a) => [a.code, a]));
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const a of agents) {
    for (const t of a.axone) {
      const key = [a.code, t].sort().join("~");
      if (seen.has(key)) continue;
      seen.add(key);
      const p1 = pos[a.code];
      const p2 = pos[t];
      if (!p1 || !p2) continue;
      // Subtle perpendicular bow for an organic, synaptic feel.
      const mx = (p1.x + p2.x) / 2;
      const my = (p1.y + p2.y) / 2;
      const dx = p2.x - p1.x;
      const dy = p2.y - p1.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(40, len * 0.12);
      const cx = mx + (-dy / len) * bow;
      const cy = my + (dx / len) * bow;
      const both = byCode.get(a.code)?.status === "running" && byCode.get(t)?.status === "running";
      edges.push({
        from: a.code,
        to: t,
        color: a.color,
        active: both,
        d: `M${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`,
      });
    }
  }
  return edges;
}

const STATUS_LABEL: Record<Agent["status"], string> = {
  running: "Aktiv",
  idle: "Bereit",
  stopped: "Gestoppt",
  error: "Fehler",
};

// ── HUD stat tile ─────────────────────────────────────────────────────────────
function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="cx-stat">
      <div className="cx-stat-v">{v}</div>
      <div className="cx-stat-k">{k}</div>
      {sub && <div className="cx-stat-sub">{sub}</div>}
    </div>
  );
}

// ── Agent inspector (right rail when selected) ───────────────────────────────
function Inspector({
  agent,
  onPick,
  onClose,
}: {
  agent: Agent;
  onPick: (code: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="cx-insp">
      <div className="cx-insp-top">
        <span className="cx-insp-orb" style={{ "--c": agent.color } as React.CSSProperties}>
          {agent.code === "U1" ? "U1" : agent.code.replace("S-", "")}
        </span>
        <div className="cx-insp-id">
          <div className="cx-insp-name">{agent.name}</div>
          <div className="cx-insp-role">{agent.role}</div>
        </div>
        <button className="cx-x" onClick={onClose} title="Schließen">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      <div className="cx-insp-meta">
        <span className={`cx-pill st-${agent.status}`}>
          <i /> {STATUS_LABEL[agent.status]}
        </span>
        <span className="cx-pill tier">{TIER_LABEL[agent.tier]}</span>
        <span className="cx-pill code">{agent.code}</span>
      </div>

      <p className="cx-insp-desc">{agent.desc}</p>

      <div className="cx-gauges">
        <div className="cx-gauge">
          <div className="cx-gauge-h"><span>CPU</span><b>{agent.cpu}%</b></div>
          <div className="cx-bar"><span style={{ width: `${Math.min(100, agent.cpu)}%`, background: agent.color }} /></div>
        </div>
        <div className="cx-gauge">
          <div className="cx-gauge-h"><span>RAM</span><b>{agent.mem} MB</b></div>
          <div className="cx-bar"><span style={{ width: `${Math.min(100, (agent.mem / 700) * 100)}%`, background: agent.color }} /></div>
        </div>
      </div>

      <div className="cx-sect">Axone · {agent.axone.length}</div>
      <div className="cx-chips">
        {agent.axone.map((c) => (
          <button key={c} className="cx-chip ax" onClick={() => onPick(c)}>
            {c}
          </button>
        ))}
      </div>

      <div className="cx-sect">Reflexe · {agent.reflexe.length}</div>
      <div className="cx-chips">
        {agent.reflexe.map((r) => (
          <span key={r} className="cx-chip rf">{r}</span>
        ))}
      </div>
    </div>
  );
}

// ── Live synapse log (right rail when nothing selected) ──────────────────────
interface LogEntry { id: number; code: string; color: string; msg: string; type: string; ts: string }

function LiveLog({ entries }: { entries: LogEntry[] }) {
  return (
    <div className="cx-log">
      <div className="cx-log-h">
        <span className="cx-log-dot" />
        Synapsen-Log
      </div>
      <div className="cx-log-list">
        {entries.map((e) => (
          <div key={e.id} className={`cx-log-row t-${e.type}`}>
            <span className="cx-log-agent" style={{ color: e.color }}>{e.code}</span>
            <span className="cx-log-msg">{e.msg}</span>
            <span className="cx-log-ts">{e.ts}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main view ────────────────────────────────────────────────────────────────
function CortexView({ host: _host }: { host: HostApi }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [mode, setMode] = useState<"axone" | "reflexe">("axone");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logId = useRef(0);

  const pos = useMemo(() => layout(AGENTS), []);
  const edges = useMemo(() => buildEdges(AGENTS, pos), [pos]);
  const byCode = useMemo(() => new Map(AGENTS.map((a) => [a.code, a])), []);
  const selectedAgent = selected ? byCode.get(selected) : undefined;

  // Aggregate HUD stats (skills only — U1 is the one agent).
  const stats = useMemo(() => {
    const skills = AGENTS.filter((a) => !a.orchestrator);
    const running = skills.filter((a) => a.status === "running").length;
    const cpu = AGENTS.reduce((s, a) => s + a.cpu, 0);
    const mem = AGENTS.reduce((s, a) => s + a.mem, 0);
    return { running, total: skills.length, cpu, mem };
  }, []);

  // Stream the live synapse log.
  useEffect(() => {
    const push = () => {
      const t = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
      const agent = byCode.get(t.agent);
      const now = new Date();
      const ts = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      setLogs((prev) =>
        [{ id: logId.current++, code: t.agent, color: agent?.color ?? "#06b6d4", msg: t.msg, type: t.type, ts }, ...prev].slice(0, 7),
      );
    };
    push();
    const iv = window.setInterval(push, 2600);
    return () => window.clearInterval(iv);
  }, [byCode]);

  // Which edges touch the focused (hover/selected) node?
  const focus = hovered ?? selected;
  const isLit = (e: Edge) => !focus || e.from === focus || e.to === focus;

  return (
    <div className="cx">
      <CortexStyle />

      <div className="cx-head">
        <div className="cx-head-tx">
          <p>Das Nervensystem — U1 und seine {AGENTS.length - 1} Skills, verbunden über Axone &amp; Reflexe.</p>
        </div>
        <div className="cx-seg" role="tablist">
          <button className={mode === "axone" ? "on" : ""} onClick={() => setMode("axone")}>Axone</button>
          <button className={mode === "reflexe" ? "on" : ""} onClick={() => setMode("reflexe")}>Reflexe</button>
        </div>
      </div>

      <div className="cx-hud">
        <Stat k="Skills aktiv" v={`${stats.running}/${stats.total}`} sub="Live" />
        <Stat k="Σ CPU" v={`${stats.cpu}%`} />
        <Stat k="Σ RAM" v={`${(stats.mem / 1000).toFixed(2)} GB`} />
        <Stat k="Tiers" v="3" sub="Surface · Core · Deep" />
      </div>

      <div className="cx-main">
        <div className="cx-stage">
          <svg
            className="cx-svg"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label="U1 im Kern mit seinen Skills auf drei Ringen (Surface, Core, Deep), verbunden durch Axone, feuernde Reflexe."
          >
            <defs>
              <radialGradient id="cx-well" cx="50%" cy="42%" r="75%">
                <stop offset="0%" stopColor="rgba(8,40,64,.55)" />
                <stop offset="100%" stopColor="rgba(4,10,22,0)" />
              </radialGradient>
              <filter id="cx-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="3.2" result="b" />
                <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>

            {/* tier rings */}
            {(["deep", "surface", "core"] as Tier[]).map((t) => (
              <circle key={t} className="cx-ring" cx={CENTER.x} cy={CENTER.y} r={RING_R[t]} />
            ))}
            <circle cx={CENTER.x} cy={CENTER.y} r={RING_R.deep + 20} fill="url(#cx-well)" />

            {/* axone edges (hidden in reflexe mode) */}
            {mode === "axone" &&
              edges.map((e) => (
                <path
                  key={`${e.from}~${e.to}`}
                  className={`cx-edge${e.active ? " act" : ""}${isLit(e) ? " lit" : " dim"}`}
                  d={e.d}
                  stroke={e.color}
                />
              ))}

            {/* nodes */}
            {AGENTS.map((a) => {
              const p = pos[a.code];
              if (!p) return null;
              const isU1 = a.code === "U1";
              const r = isU1 ? 34 : 22;
              const sel = selected === a.code;
              const dimNode = focus && focus !== a.code && mode === "axone"
                ? !(byCode.get(focus)?.axone.includes(a.code) || a.axone.includes(focus))
                : false;
              return (
                <g
                  key={a.code}
                  className={`cx-node${sel ? " sel" : ""}${dimNode ? " ndim" : ""}`}
                  transform={`translate(${p.x} ${p.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${a.code} ${a.name} — ${a.role}, ${STATUS_LABEL[a.status]}`}
                  aria-pressed={sel}
                  onMouseEnter={() => setHovered(a.code)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(a.code)}
                  onBlur={() => setHovered(null)}
                  onClick={() => setSelected(sel ? null : a.code)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelected(sel ? null : a.code);
                    }
                  }}
                  style={{ "--c": a.color } as React.CSSProperties}
                >
                  <title>{`${a.code} ${a.name} — ${a.role}`}</title>
                  {/* reflex pulse rings (reflexe mode, running agents) */}
                  {mode === "reflexe" && a.status === "running" && (
                    <>
                      <circle className="cx-pulse" r={r} />
                      <circle className="cx-pulse d2" r={r} />
                    </>
                  )}
                  <circle className="cx-node-halo" r={r + 9} />
                  <circle className="cx-node-bg" r={r} />
                  <circle className="cx-node-ring" r={r} />
                  <text
                    className="cx-node-tx"
                    dy={isU1 ? 5 : 4}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    style={{ fontSize: isU1 ? 15 : 11 }}
                  >
                    {isU1 ? "U1" : a.code.replace("S-", "")}
                  </text>
                  {/* status dot */}
                  <circle className={`cx-node-st st-${a.status}`} cx={r * 0.72} cy={-r * 0.72} r={4.2} />
                  {/* name label under non-U1 nodes */}
                  {!isU1 && (
                    <text className="cx-node-lbl" dy={r + 15}>{a.name}</text>
                  )}
                  {/* reflex count badge in reflexe mode */}
                  {mode === "reflexe" && (
                    <text className="cx-node-rf" dy={r + (isU1 ? 26 : 28)}>{a.reflexe.length} Reflexe</text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* tier legend */}
          <div className="cx-legend" aria-hidden="true">
            {(["core", "surface", "deep"] as Tier[]).map((t) => (
              <span key={t} className={`cx-leg tier-${t}`}>{TIER_LABEL[t]}</span>
            ))}
          </div>
        </div>

        <div className="cx-rail">
          {selectedAgent ? (
            <Inspector agent={selectedAgent} onPick={(c) => setSelected(c)} onClose={() => setSelected(null)} />
          ) : (
            <LiveLog entries={logs} />
          )}
        </div>
      </div>
    </div>
  );
}

function CortexStyle() {
  return (
    <style>{`
.cx{width:100%}
.cx-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:16px}
.cx-head h1{font-size:27px;font-weight:600;letter-spacing:-.035em}
.cx-head p{font-size:13.5px;color:var(--ink2);margin-top:5px;max-width:60ch}
.cx-seg{display:inline-flex;padding:3px;border-radius:12px;background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim);flex:none}
.cx-seg button{border:none;background:none;padding:7px 16px;border-radius:9px;font:inherit;font-size:13px;font-weight:600;color:var(--ink2);cursor:pointer;transition:.16s}
.cx-seg button.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 6px 16px -8px rgba(6,182,212,.7)}

.cx-hud{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
.cx-stat{padding:14px 16px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);border:1px solid var(--line2,var(--glass-edge));box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.cx-stat-v{font-size:22px;font-weight:680;letter-spacing:-.02em;color:var(--ink)}
.cx-stat-k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin-top:3px}
.cx-stat-sub{font-size:11px;color:var(--cyan-d,#0891b2);margin-top:2px}

.cx-main{display:grid;grid-template-columns:minmax(0,1fr) 326px;gap:14px;align-items:stretch}
.cx-stage{position:relative;border-radius:var(--r);overflow:hidden;min-height:560px;
  background:radial-gradient(120% 100% at 50% 0%,#0b2236 0%,#071322 55%,#050b16 100%);
  border:1px solid rgba(120,180,230,.14);box-shadow:var(--shadow),inset 0 1px 0 rgba(150,200,240,.1),inset 0 0 90px rgba(2,8,18,.6)}
.cx-svg{display:block;width:100%;height:100%}

.cx-ring{fill:none;stroke:rgba(130,180,230,.1);stroke-width:1}
.cx-edge{fill:none;stroke-width:1.5;opacity:.32;transition:opacity .25s,stroke-width .25s}
.cx-edge.lit{opacity:.6}
.cx-edge.dim{opacity:.08}
.cx-edge.act{stroke-dasharray:5 9;animation:cx-flow 1.1s linear infinite}
.cx-edge.act.lit{opacity:.85;stroke-width:2}
@keyframes cx-flow{to{stroke-dashoffset:-28}}

.cx-node{cursor:pointer;transition:opacity .25s;outline:none}
.cx-node:focus-visible .cx-node-ring{stroke-width:3.6}
.cx-node:focus-visible .cx-node-halo{opacity:.4}
.cx-node.ndim{opacity:.34}
.cx-node-halo{fill:var(--c);opacity:0;transition:opacity .2s;filter:blur(7px)}
.cx-node:hover .cx-node-halo,.cx-node.sel .cx-node-halo{opacity:.34}
.cx-node-bg{fill:rgba(8,18,32,.92)}
.cx-node-ring{fill:none;stroke:var(--c);stroke-width:2.2;filter:drop-shadow(0 0 6px var(--c))}
.cx-node.sel .cx-node-ring{stroke-width:3.4}
.cx-node-tx{fill:#eaf6ff;font-weight:700;text-anchor:middle;font-family:var(--mono,ui-monospace,monospace);letter-spacing:.02em}
.cx-node-lbl{fill:rgba(200,225,250,.72);font-size:10.5px;font-weight:600;text-anchor:middle}
.cx-node-rf{fill:rgba(150,200,240,.55);font-size:9px;text-anchor:middle;letter-spacing:.03em}
.cx-node-st{stroke:rgba(8,18,32,.9);stroke-width:1.5}
.cx-node-st.st-running{fill:#34d399}.cx-node-st.st-idle{fill:#fbbf24}.cx-node-st.st-stopped{fill:#94a3b8}.cx-node-st.st-error{fill:#f87171}
.cx-pulse{fill:none;stroke:var(--c);stroke-width:1.5;opacity:0;transform-origin:center;animation:cx-pulse 2.4s ease-out infinite}
.cx-pulse.d2{animation-delay:1.2s}
@keyframes cx-pulse{0%{opacity:.5;transform:scale(1)}100%{opacity:0;transform:scale(2.4)}}

.cx-legend{position:absolute;left:16px;bottom:14px;display:flex;gap:8px}
.cx-leg{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;padding:4px 9px;border-radius:999px;background:rgba(10,22,38,.6);border:1px solid rgba(130,180,230,.18);color:rgba(200,225,250,.8);backdrop-filter:blur(8px)}
.cx-leg.tier-core{border-color:rgba(0,240,255,.4);color:#7fe9ff}
.cx-leg.tier-surface{border-color:rgba(255,107,53,.35);color:#ffb088}
.cx-leg.tier-deep{border-color:rgba(45,212,191,.35);color:#7fe9d4}

/* right rail */
.cx-rail{display:flex;flex-direction:column;min-height:560px}
.cx-insp,.cx-log{flex:1;display:flex;flex-direction:column;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(30px) saturate(1.6);-webkit-backdrop-filter:blur(30px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);padding:16px;overflow:hidden}

.cx-insp-top{display:flex;align-items:center;gap:12px}
/* Darken via a black overlay (no color-mix() — works in every WKWebView). */
.cx-insp-orb{flex:none;width:46px;height:46px;border-radius:14px;display:grid;place-items:center;font-weight:800;font-size:15px;font-family:var(--mono,ui-monospace,monospace);color:#fff;background:var(--c);background-image:linear-gradient(155deg,rgba(255,255,255,.18),rgba(0,0,0,.42));box-shadow:0 8px 20px -8px var(--c),inset 0 1px 0 rgba(255,255,255,.3)}
.cx-insp-id{flex:1;min-width:0}
.cx-insp-name{font-size:17px;font-weight:680;letter-spacing:-.02em}
.cx-insp-role{font-size:12.5px;color:var(--ink2);margin-top:1px}
.cx-x{flex:none;width:30px;height:30px;border-radius:9px;border:1px solid var(--line);background:var(--glass2);display:grid;place-items:center;cursor:pointer;color:var(--ink2)}
.cx-x svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.cx-insp-meta{display:flex;flex-wrap:wrap;gap:6px;margin-top:13px}
.cx-pill{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:650;padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2)}
.cx-pill i{width:6px;height:6px;border-radius:50%;background:currentColor}
.cx-pill.st-running{color:#0a9d63;border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.1)}
.cx-pill.st-idle{color:#b7791f;border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)}
.cx-pill.st-stopped,.cx-pill.st-error{color:#dc2626;border-color:rgba(239,68,68,.3);background:rgba(239,68,68,.1)}
.cx-pill.tier,.cx-pill.code{color:var(--cyan-d,#0891b2)}
.cx-insp-desc{font-size:13px;color:var(--ink2);line-height:1.55;margin:14px 0 4px}
.cx-gauges{display:flex;flex-direction:column;gap:10px;margin:12px 0 4px}
.cx-gauge-h{display:flex;justify-content:space-between;font-size:12px;color:var(--ink2);margin-bottom:5px}
.cx-gauge-h b{color:var(--ink);font-weight:680}
.cx-bar{height:7px;border-radius:999px;background:var(--glass2);overflow:hidden;box-shadow:inset 0 1px 0 var(--rim)}
.cx-bar span{display:block;height:100%;border-radius:999px;transition:width .5s cubic-bezier(.2,.8,.2,1)}
.cx-sect{font-size:11px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin:16px 0 8px}
.cx-chips{display:flex;flex-wrap:wrap;gap:6px;overflow-y:auto}
.cx-chip{font-size:11.5px;font-weight:600;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2)}
.cx-chip.ax{cursor:pointer;font-family:var(--mono,ui-monospace,monospace);transition:.15s}
.cx-chip.ax:hover{border-color:rgba(6,182,212,.4);color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.08)}
.cx-chip.rf{color:var(--ink2)}

.cx-log-h{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);padding-bottom:12px;border-bottom:1px solid var(--line)}
.cx-log-dot{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:cx-beat 1.8s ease-out infinite}
@keyframes cx-beat{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
.cx-log-list{display:flex;flex-direction:column;gap:2px;margin-top:10px;overflow:hidden}
.cx-log-row{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:baseline;padding:7px 6px;border-radius:9px;animation:cx-in .35s ease}
.cx-log-row:hover{background:var(--fill-weak)}
@keyframes cx-in{from{opacity:0;transform:translateY(-5px)}to{opacity:1;transform:none}}
.cx-log-agent{font-size:11px;font-weight:700;font-family:var(--mono,ui-monospace,monospace)}
.cx-log-msg{font-size:12px;color:var(--ink);line-height:1.4;min-width:0}
.cx-log-ts{font-size:10px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}
.cx-log-row.t-warn .cx-log-msg{color:#b7791f}
.cx-log-row.t-success .cx-log-agent{filter:saturate(1.2)}

@media (prefers-reduced-motion:reduce){
  .cx-edge.act,.cx-pulse,.cx-log-dot,.cx-log-row{animation:none}
  .cx-edge.act{stroke-dasharray:none}
  .cx-node,.cx-node-halo,.cx-node-ring,.cx-edge,.cx-chip.ax,.cx-seg button,.cx-bar span{transition:none}
}
@media (max-width:1080px){.cx-main{grid-template-columns:1fr}.cx-rail{min-height:340px}}
@media (max-width:760px){
  .cx-hud{grid-template-columns:repeat(2,1fr)}
  .cx{padding:18px 14px 32px}
  .cx-head{flex-direction:column;align-items:flex-start;gap:12px}
}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// SNI shell — the full Neural Interface as one module with internal tabs.
// (Übersicht + Cortex are live; the rest are an honest, in-app roadmap that the
//  next build phases fill in — see SNI-PLAN.md.)
// ════════════════════════════════════════════════════════════════════════════

type TabId = "home" | "cortex" | "skills" | "network" | "reflexe" | "u1" | "security";

interface TabDef {
  id: TabId;
  label: string;
  /** For not-yet-built tabs: the planned functions, shown as an honest roadmap. */
  soon?: { phase: string; lead: string; bullets: string[] };
}

const SNI_TABS: TabDef[] = [
  { id: "home", label: "Übersicht" },
  { id: "cortex", label: "Cortex" },
  { id: "skills", label: "Skills" },
  { id: "network", label: "Netzwerk" },
  { id: "reflexe", label: "Reflexe" },
  { id: "u1", label: "U1" },
  { id: "security", label: "Sicherheit" },
];

/** Friendly display name from the signed-in email (mirrors the shell chip). */
function nameFromEmail(email: string): string {
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  if (!local) return "";
  return local.split(" ").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function ComingTab({ def }: { def: TabDef }) {
  const s = def.soon!;
  return (
    <div className="sni-soon">
      <span className="sni-soon-phase">{s.phase} · in Arbeit</span>
      <h2>{def.label}</h2>
      <p>{s.lead}</p>
      <ul className="sni-soon-list">
        {s.bullets.map((b) => (
          <li key={b}><span className="sni-soon-tick" />{b}</li>
        ))}
      </ul>
    </div>
  );
}

/** The Cortex tab — a 3D engine (default) with the 2D map as a fallback view. */
function CortexTab({ host }: { host: HostApi }) {
  const [viz, setViz] = useState<"3d" | "2d">("3d");
  useEffect(() => {
    let on = true;
    void host.storage.get("sni.cortexViz").then((v) => {
      if (on && (v === "2d" || v === "3d")) setViz(v);
    });
    return () => { on = false; };
  }, [host]);
  const pick = (v: "3d" | "2d") => {
    setViz(v);
    void host.storage.set("sni.cortexViz", v);
  };
  return (
    <div className="cxw">
      <div className="cxw-bar">
        <div className="cxw-seg" role="tablist">
          <button className={viz === "3d" ? "on" : ""} onClick={() => pick("3d")}>3D</button>
          <button className={viz === "2d" ? "on" : ""} onClick={() => pick("2d")}>2D</button>
        </div>
      </div>
      {viz === "3d" ? (
        // The 3D engine is position:absolute;inset:0 — give it a sized, relatively
        // positioned box so its canvas + HUD stay HERE and never overlap the tab bar.
        <div className="cxw-stage"><Cortex3DTab host={host} /></div>
      ) : (
        <CortexView host={host} />
      )}
      <style>{`.cxw-bar{display:flex;justify-content:flex-end;margin-bottom:10px}.cxw-seg{display:inline-flex;padding:3px;border-radius:11px;background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim)}.cxw-seg button{border:none;background:none;padding:5px 15px;border-radius:8px;font:inherit;font-size:12.5px;font-weight:650;color:var(--ink2);cursor:pointer;transition:.15s}.cxw-seg button.on{background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 5px 14px -6px rgba(6,182,212,.7)}.cxw-stage{position:relative;height:74vh;min-height:540px;border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow),inset 0 1px 0 rgba(150,200,240,.1)}`}</style>
    </div>
  );
}

function SNIShell({ host }: { host: HostApi }) {
  const [tab, setTab] = useState<TabId>("home");
  const [name, setName] = useState<string>("");

  // Restore the last tab + the display name.
  useEffect(() => {
    let on = true;
    void host.storage.get("sni.tab").then((v) => {
      if (on && typeof v === "string" && SNI_TABS.some((t) => t.id === v)) setTab(v as TabId);
    });
    const acc = host.auth.account();
    if (acc.logged_in) setName(nameFromEmail(acc.email));
    return () => { on = false; };
  }, [host]);

  const pick = (id: TabId) => {
    setTab(id);
    void host.storage.set("sni.tab", id);
  };

  const active = SNI_TABS.find((t) => t.id === tab)!;

  return (
    <div className="sni">
      <SNIStyle />
      <div className="sni-bar" role="tablist">
        {SNI_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`sni-tab${tab === t.id ? " on" : ""}`} onClick={() => pick(t.id)}>
            {t.label}
            {t.soon && <span className="sni-tab-dot" title="in Arbeit" />}
          </button>
        ))}
      </div>
      <div className="sni-body">
        {tab === "home" && <HomeTab name={name} />}
        {tab === "cortex" && <CortexTab host={host} />}
        {tab === "skills" && <SkillsTab host={host} />}
        {tab === "network" && <NetworkTab host={host} />}
        {tab === "reflexe" && <ReflexeTab host={host} />}
        {tab === "u1" && <U1Tab host={host} />}
        {tab === "security" && <SecurityTab host={host} />}
        {active.soon && <ComingTab def={active} />}
      </div>
    </div>
  );
}

function SNIStyle() {
  return (
    <style>{`
.sni{width:100%;max-width:1240px;margin:0 auto;padding:24px 22px 48px}
.sni-bar{display:flex;gap:2px;border-bottom:1px solid var(--line);margin-bottom:20px;overflow-x:auto;scrollbar-width:none}
.sni-bar::-webkit-scrollbar{display:none}
.sni-tab{position:relative;flex:none;border:none;background:none;padding:11px 15px 13px;font:inherit;font-size:13.5px;font-weight:600;color:var(--ink3);cursor:pointer;transition:color .15s;white-space:nowrap}
.sni-tab:hover{color:var(--ink2)}
.sni-tab.on{color:var(--ink)}
.sni-tab.on::after{content:"";position:absolute;left:11px;right:11px;bottom:-1px;height:2px;border-radius:2px;background:linear-gradient(90deg,#22d3ee,#06b6d4);box-shadow:0 0 8px rgba(6,182,212,.5)}
.sni-tab-dot{display:inline-block;width:5px;height:5px;border-radius:50%;background:var(--ink3);margin-left:6px;vertical-align:middle;opacity:.6}
.sni-body{min-height:300px}

.sni-soon{max-width:560px;margin:40px auto;padding:30px 28px;text-align:left;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(30px) saturate(1.7);-webkit-backdrop-filter:blur(30px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.sni-soon-phase{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.24);padding:4px 11px;border-radius:999px}
.sni-soon h2{font-size:22px;font-weight:600;letter-spacing:-.03em;margin:14px 0 6px}
.sni-soon p{font-size:14px;color:var(--ink2);line-height:1.5}
.sni-soon-list{list-style:none;margin:18px 0 0;padding:0;display:flex;flex-direction:column;gap:11px}
.sni-soon-list li{display:flex;align-items:flex-start;gap:11px;font-size:13.5px;color:var(--ink);line-height:1.45}
.sni-soon-tick{flex:none;width:7px;height:7px;border-radius:50%;margin-top:6px;background:linear-gradient(160deg,#22d3ee,#06b6d4);box-shadow:0 0 6px rgba(6,182,212,.5)}
@media (max-width:900px){.sni{padding:18px 14px 32px}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "sni",
    name: "SNI",
    version: "1.0.0",
    description: "Subunit Neural Interface — U1 und seine Skills.",
    icon: ICON,
    permissions: ["storage"],
    nav: { section: "core", order: 1 },
    commands: [{ id: "open", title: "Go to SNI" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<SNIShell host={host} />);
    offCmd = host.events.on("command:sni:open", () => host.nav.navigate("sni"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
