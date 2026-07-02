/**
 * Home — the SNI command-center landing.
 *
 * Time-of-day greeting, a system-integrity gauge, aggregate agent telemetry,
 * a server/GPU health card and a recent-activity feed. Static/mock for now
 * (real /api/gpu + live WS wiring is a later phase); fully demoable offline.
 *
 * Subunit Liquid Glass — glass cards over an aurora mesh, ONE cyan accent.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AGENTS, LOG_TEMPLATES, TIER_CONFIG, orchestratorOf, skillsOf, type Tier } from "../agents";
import type { HostApi } from "../../../plugin/types";
import { sni, useSniResource, type SniGpu } from "../../../lib/sni";

// Demo fallback for the GPU card until the sni-live server lever is pulled
// (deploy/sni-live/). The real GPU is the server's GTX 1070 Ti.
const MOCK_GPU: SniGpu = {
  name: "GTX 1070 Ti", tempC: 54, utilization: 63,
  memUsedMB: 5800, memTotalMB: 8192, powerDraw: 168, powerLimit: 180,
};

function greeting(h: number): string {
  if (h < 5) return "Gute Nacht";
  if (h < 11) return "Guten Morgen";
  if (h < 18) return "Guten Tag";
  return "Guten Abend";
}

const TYPE_DOT: Record<string, string> = { info: "#38bdf8", success: "#34d399", warn: "#fbbf24" };

export default function HomeTab({ name, host }: { name: string; host: HostApi }) {
  const u1 = useMemo(() => orchestratorOf(AGENTS), []);
  const stats = useMemo(() => {
    const skills = skillsOf(AGENTS);
    const running = skills.filter((a) => a.status === "running").length;
    const cpu = AGENTS.reduce((s, a) => s + a.cpu, 0);
    const mem = AGENTS.reduce((s, a) => s + a.mem, 0);
    // System integrity = active-skills ratio.
    const integrity = Math.round((running / skills.length) * 100);
    const byTier = (Object.keys(TIER_CONFIG) as Tier[]).map((t) => ({
      tier: t,
      ...TIER_CONFIG[t],
      count: skills.filter((a) => a.tier === t).length,
      active: skills.filter((a) => a.tier === t && a.status === "running").length,
    })).filter((g) => g.count > 0);
    return { running, total: skills.length, cpu, mem, integrity, byTier };
  }, []);

  const greet = useMemo(() => greeting(new Date().getHours()), []);

  // Recent activity feed.
  const [feed, setFeed] = useState<{ id: number; code: string; color: string; msg: string; type: string; ts: string }[]>([]);
  const fid = useRef(0);
  useEffect(() => {
    const byCode = new Map(AGENTS.map((a) => [a.code, a]));
    const push = () => {
      const t = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
      const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      setFeed((p) => [{ id: fid.current++, code: t.agent, color: byCode.get(t.agent)?.color ?? "#06b6d4", msg: t.msg, type: t.type, ts }, ...p].slice(0, 5));
    };
    push();
    const iv = window.setInterval(push, 3200);
    return () => window.clearInterval(iv);
  }, []);

  // Integrity ring geometry.
  const R = 52;
  const C = 2 * Math.PI * R;
  const off = C * (1 - stats.integrity / 100);

  // Live GPU telemetry (/api/gpu) with graceful demo fallback — swaps to live
  // automatically once the sni-live server lever is pulled.
  const gpuRes = useSniResource(host, sni.gpu, MOCK_GPU, { refreshMs: 5000 });
  const g = gpuRes.data;
  const vramPct = g.memTotalMB ? Math.round((g.memUsedMB / g.memTotalMB) * 100) : 0;

  return (
    <div className="sh">
      <HomeStyle />

      <div className="sh-greet">
        <div className="sh-greet-tx">
          <h1>{greet}{name ? `, ${name}` : ""}.</h1>
          <p>U1 ist online — {stats.running} von {stats.total} Skills aktiv.</p>
        </div>
        <div className="sh-integrity">
          <svg viewBox="0 0 130 130" className="sh-ring">
            <circle cx="65" cy="65" r={R} className="sh-ring-bg" />
            <circle cx="65" cy="65" r={R} className="sh-ring-fg" strokeDasharray={C} strokeDashoffset={off} transform="rotate(-90 65 65)" />
          </svg>
          <div className="sh-integrity-tx">
            <b>{stats.integrity}%</b>
            <span>Integrität</span>
          </div>
        </div>
      </div>

      <div className="sh-stats">
        <Stat v={`${stats.running}/${stats.total}`} k="Skills aktiv" accent />
        <Stat v={`${stats.cpu}%`} k="Σ CPU-Last" />
        <Stat v={`${(stats.mem / 1000).toFixed(2)} GB`} k="Σ RAM" />
        <Stat v="14d 06h" k="Uptime" />
      </div>

      <div className="sh-grid">
        {/* Orchestrator card */}
        <div className="sh-card sh-u1">
          <div className="sh-card-h"><span className="sh-card-t">Orchestrator</span><span className="sh-live"><i />live</span></div>
          {u1 && (
            <div className="sh-u1-body">
              <span className="sh-u1-orb" style={{ "--c": u1.color } as React.CSSProperties}>{u1.code}</span>
              <div className="sh-u1-id">
                <div className="sh-u1-name">{u1.name}</div>
                <div className="sh-u1-role">{u1.role}</div>
                <div className="sh-u1-meta">{u1.cpu}% CPU · {u1.mem} MB · {u1.axone.length} Skills</div>
              </div>
            </div>
          )}
          <div className="sh-tiers">
            {stats.byTier.map((t) => (
              <div key={t.tier} className="sh-tier">
                <span className="sh-tier-dot" style={{ background: t.color }} />
                <span className="sh-tier-l">{t.label}</span>
                <span className="sh-tier-c">{t.active}/{t.count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Server / GPU health — live /api/gpu, demo fallback */}
        <div className="sh-card">
          <div className="sh-card-h"><span className="sh-card-t">Server &amp; GPU</span><SourceBadge source={gpuRes.source} /></div>
          <div className="sh-gpu">
            <Gauge label="VRAM" v={vramPct} unit="%" />
            <Gauge label="GPU-Last" v={Math.round(g.utilization)} unit="%" />
            <Gauge label="Temp" v={Math.round(g.tempC)} unit="°C" max={90} />
            <Gauge label="Power" v={Math.round(g.powerDraw ?? 0)} unit="W" max={g.powerLimit ?? 300} />
          </div>
        </div>

        {/* Recent activity */}
        <div className="sh-card sh-feed">
          <div className="sh-card-h"><span className="sh-card-t">Letzte Aktivität</span></div>
          <div className="sh-feed-list">
            {feed.map((e) => (
              <div key={e.id} className="sh-feed-row">
                <span className="sh-feed-dot" style={{ background: TYPE_DOT[e.type] ?? "#94a3b8" }} />
                <span className="sh-feed-code" style={{ color: e.color }}>{e.code}</span>
                <span className="sh-feed-msg">{e.msg}</span>
                <span className="sh-feed-ts">{e.ts}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Live/Demo source indicator — green pulse when the SNI server answers, amber "Demo" on fallback. */
function SourceBadge({ source }: { source: "live" | "demo" }) {
  return source === "live" ? (
    <span className="sh-live"><i />live</span>
  ) : (
    <span className="sh-badge demo" title="SNI-Server nicht erreichbar — Demo-Daten">Demo</span>
  );
}

function Stat({ v, k, accent }: { v: string; k: string; accent?: boolean }) {
  return (
    <div className={`sh-stat${accent ? " on" : ""}`}>
      <div className="sh-stat-v">{v}</div>
      <div className="sh-stat-k">{k}</div>
    </div>
  );
}

function Gauge({ label, v, unit, max = 100 }: { label: string; v: number; unit: string; max?: number }) {
  const pct = Math.min(100, (v / max) * 100);
  const hot = pct > 80;
  return (
    <div className="sh-gauge">
      <div className="sh-gauge-h"><span>{label}</span><b>{v}{unit}</b></div>
      <div className="sh-gauge-bar"><span style={{ width: `${pct}%`, background: hot ? "#f87171" : undefined }} /></div>
    </div>
  );
}

function HomeStyle() {
  return (
    <style>{`
.sh{display:flex;flex-direction:column;gap:16px}
.sh-greet{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:6px 4px 2px}
.sh-greet h1{font-size:28px;font-weight:600;letter-spacing:-.035em}
.sh-greet p{font-size:14px;color:var(--ink2);margin-top:6px}
.sh-integrity{position:relative;flex:none;width:108px;height:108px;display:grid;place-items:center}
.sh-ring{width:108px;height:108px}
.sh-ring-bg{fill:none;stroke:var(--glass2);stroke-width:9}
.sh-ring-fg{fill:none;stroke:#06b6d4;stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 6px rgba(6,182,212,.5))}
.sh-integrity-tx{position:absolute;text-align:center}
.sh-integrity-tx b{display:block;font-size:24px;font-weight:680;letter-spacing:-.02em}
.sh-integrity-tx span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}

.sh-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.sh-stat{padding:14px 16px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);border:1px solid var(--line2,var(--glass-edge));box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.sh-stat.on{border-color:rgba(6,182,212,.35)}
.sh-stat-v{font-size:21px;font-weight:680;letter-spacing:-.02em}
.sh-stat.on .sh-stat-v{color:var(--cyan-d,#0891b2)}
.sh-stat-k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin-top:3px}

.sh-grid{display:grid;grid-template-columns:1.1fr 1fr;grid-auto-rows:auto;gap:14px}
.sh-feed{grid-column:1 / -1}
.sh-card{padding:17px 18px;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(30px) saturate(1.7);-webkit-backdrop-filter:blur(30px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.sh-card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sh-card-t{font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2)}
.sh-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:#0a9d63}
.sh-live i{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:sh-beat 1.8s ease-out infinite}
@keyframes sh-beat{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
.sh-badge{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:7px}
.sh-badge.ok{color:#0a9d63;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.25)}
.sh-badge.demo{color:#a16207;background:rgba(202,138,4,.12);border:1px solid rgba(202,138,4,.28);cursor:default}

.sh-u1-body{display:flex;align-items:center;gap:14px;padding-bottom:14px;border-bottom:1px solid var(--line)}
.sh-u1-orb{flex:none;width:54px;height:54px;border-radius:16px;display:grid;place-items:center;font-weight:800;font-size:17px;font-family:var(--mono,ui-monospace,monospace);color:#06202a;background:var(--c);background-image:linear-gradient(155deg,rgba(255,255,255,.4),rgba(0,0,0,.12));box-shadow:0 10px 24px -10px var(--c),inset 0 1px 0 rgba(255,255,255,.4)}
.sh-u1-name{font-size:17px;font-weight:680;letter-spacing:-.02em}
.sh-u1-role{font-size:12.5px;color:var(--ink2);margin-top:1px}
.sh-u1-meta{font-size:11.5px;color:var(--ink3);margin-top:5px;font-family:var(--mono,ui-monospace,monospace)}
.sh-tiers{display:flex;gap:18px;margin-top:13px}
.sh-tier{display:flex;align-items:center;gap:7px}
.sh-tier-dot{width:8px;height:8px;border-radius:50%}
.sh-tier-l{font-size:12px;color:var(--ink2)}
.sh-tier-c{font-size:12px;font-weight:680;color:var(--ink)}

.sh-gpu{display:grid;grid-template-columns:1fr 1fr;gap:13px 18px}
.sh-gauge-h{display:flex;justify-content:space-between;font-size:12px;color:var(--ink2);margin-bottom:5px}
.sh-gauge-h b{color:var(--ink);font-weight:680}
.sh-gauge-bar{height:7px;border-radius:999px;background:var(--glass2);overflow:hidden;box-shadow:inset 0 1px 0 var(--rim)}
.sh-gauge-bar span{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#06b6d4);transition:width .6s cubic-bezier(.2,.8,.2,1)}

.sh-feed-list{display:flex;flex-direction:column;gap:1px}
.sh-feed-row{display:grid;grid-template-columns:auto auto 1fr auto;gap:9px;align-items:baseline;padding:8px 6px;border-radius:9px;animation:sh-in .35s ease}
.sh-feed-row:hover{background:var(--fill-weak)}
@keyframes sh-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
.sh-feed-dot{width:7px;height:7px;border-radius:50%;align-self:center}
.sh-feed-code{font-size:11px;font-weight:700;font-family:var(--mono,ui-monospace,monospace)}
.sh-feed-msg{font-size:12.5px;color:var(--ink);min-width:0}
.sh-feed-ts{font-size:10.5px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

@media (prefers-reduced-motion:reduce){.sh-live i,.sh-feed-row{animation:none}.sh-ring-fg,.sh-gauge-bar span{transition:none}}
@media (max-width:900px){.sh-stats{grid-template-columns:repeat(2,1fr)}.sh-grid{grid-template-columns:1fr}}
`}</style>
  );
}
