/**
 * Security — infrastructure health + financial guard.
 *
 * Two halves of the same promise: U1 runs on real iron (CPU/RAM/Disk donuts,
 * uptime + load tiles) and U1 runs a COST-GOVERNED operation (budget meters with
 * soft/warning/hard thresholds, a 14-day cost chart with a cumulative overlay and
 * a hard-limit reference line, an alert ledger, and editable limits).
 *
 * Static/mock for now — derived from a deterministic seed so it's stable per
 * session yet credible. Real /api/security wiring is a later phase; fully
 * demoable offline. Subunit Liquid Glass — glass cards, ONE cyan accent.
 */

import { useMemo, useState } from "react";
import type { HostApi } from "../../../plugin/types";

// ── currency helpers (the operation thinks in EUR, bills in USD) ────────────
const USD_TO_EUR = 0.92;
const fmt = (v: number, d = 2) => (v || 0).toFixed(d);
const eur = (usd: number) => `${fmt((usd || 0) * USD_TO_EUR)}€`;
const usd = (v: number) => `$${fmt(v)}`;

// Severity palette — built only from the allowed accents + a derived amber/red.
const SEV = {
  info: { c: "#06b6d4", bg: "rgba(6,182,212,.08)", bd: "rgba(6,182,212,.22)", mark: "~" },
  warn: { c: "#b7791f", bg: "rgba(251,191,36,.1)", bd: "rgba(251,191,36,.28)", mark: "!" },
  critical: { c: "#c0392b", bg: "rgba(239,68,68,.09)", bd: "rgba(239,68,68,.26)", mark: "!!" },
} as const;
type Sev = keyof typeof SEV;

// ── deterministic mock generator (seeded so a session is stable) ────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Day {
  date: string;
  label: string;
  weekday: string;
  cost: number; // USD
  calls: number;
  billing: boolean;
}

function buildDays(n: number): Day[] {
  const rnd = mulberry32(0x5e0001);
  const out: Day[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const dow = d.getDay();
    const weekend = dow === 0 || dow === 6;
    // Base load with a slow upward drift + a couple of credible spikes.
    let base = 6 + Math.sin(i / 2.4) * 2.1 + (n - i) * 0.18;
    if (weekend) base *= 0.45;
    base += (rnd() - 0.4) * 3.4;
    if (i === 3) base = 16.8; // a spike day (over hard limit)
    if (i === 9) base = 12.1; // a warning-band day
    const cost = Math.max(0.4, base);
    const billing = i === 3 || i === 1; // a couple of console-billed days
    out.push({
      date: iso,
      label: iso.slice(5).replace("-", "."),
      weekday: ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][dow],
      cost: Math.round(cost * 100) / 100,
      calls: Math.round(180 + rnd() * 640 + (weekend ? -90 : 0)),
      billing,
    });
  }
  return out;
}

// Live-ish server gauges (seeded, stable per session).
const SRV = (() => {
  const r = mulberry32(0xab12);
  return {
    cpu: Math.round(28 + r() * 22),
    ram: Math.round(58 + r() * 16),
    disk: Math.round(38 + r() * 10),
    uptime: "143d 08h 22m",
    load: [0.45, 0.38, 0.41] as const,
    conns: 1247,
    os: "Ubuntu 22.04 LTS",
    node: "v20.11.0",
    gpu: "GTX 1070 Ti",
  };
})();

interface Alert { id: number; sev: Sev; msg: string; ago: string; }
const ALERTS: Alert[] = [
  { id: 1, sev: "critical", msg: "Tages-Hard-Limit erreicht — Skill-Throttle aktiv (S-07 Content pausiert)", ago: "vor 6 Min" },
  { id: 2, sev: "warn", msg: "Cache-Write-Anteil 34 % > Ziel 30 % — Pulse-Routing prüft Modellwahl", ago: "vor 41 Min" },
  { id: 3, sev: "warn", msg: "Kosten-Spike: heute 2.3× über 7-Tage-Schnitt (Anomalie-Scan)", ago: "vor 1 Std" },
  { id: 4, sev: "info", msg: "Disk 41 % — nächster Snapshot-Prune in 18 Std geplant", ago: "vor 3 Std" },
  { id: 5, sev: "info", msg: "Health-Check ok — alle Nodes nominal, Load 0.45", ago: "vor 4 Std" },
];

export default function SecurityTab({ host: _host }: { host: HostApi }) {
  const days = useMemo(() => buildDays(14), []);
  const today = days[days.length - 1];

  // Editable limits (USD internally, EUR in the UI). Local state only.
  const [dailySoft, setDailySoft] = useState(10);
  const [dailyWarn, setDailyWarn] = useState(13);
  const [dailyHard, setDailyHard] = useState(15);
  const [monthSoft, setMonthSoft] = useState(150);
  const [monthWarn, setMonthWarn] = useState(185);
  const [monthHard, setMonthHard] = useState(200);

  const mtd = useMemo(() => {
    // Month-to-date = the visible window stands in for the month so far.
    const total = days.reduce((s, d) => s + d.cost, 0);
    const avg = total / days.length;
    const remaining = 30 - days.length;
    const projected = total + avg * Math.max(0, remaining);
    const calls = days.reduce((s, d) => s + d.calls, 0);
    return { total, avg, remaining, projected, calls };
  }, [days]);

  const todayCost = today.cost;
  const guard: { status: string; sev: Sev } =
    todayCost >= dailyHard
      ? { status: "CRITICAL", sev: "critical" }
      : todayCost >= dailyWarn
        ? { status: "WARNING", sev: "warn" }
        : { status: "NOMINAL", sev: "info" };

  return (
    <div className="se">
      <SecurityStyle />

      {/* ── header + guard verdict ─────────────────────────────────────── */}
      <div className="se-head">
        <div>
          <h2>Sicherheit</h2>
          <p>Infrastruktur-Health &amp; Kosten-Wächter — wir fahren einen kosten-gesteuerten Betrieb.</p>
        </div>
        <div className={`se-verdict sev-${guard.sev}`}>
          <span className="se-verdict-dot" />
          <div>
            <b>{guard.status}</b>
            <span>Guard · {ALERTS.filter((a) => a.sev !== "info").length} aktiv</span>
          </div>
        </div>
      </div>

      {/* ── SERVER STATUS ──────────────────────────────────────────────── */}
      <div className="se-card">
        <div className="se-card-h">
          <span className="se-card-t">Server-Status</span>
          <span className="se-live"><i />online</span>
        </div>
        <div className="se-srv">
          <div className="se-donuts">
            <Donut label="CPU" pct={SRV.cpu} />
            <Donut label="RAM" pct={SRV.ram} />
            <Donut label="Disk" pct={SRV.disk} />
          </div>
          <div className="se-srv-tiles">
            <InfoTile k="OS" v={SRV.os} />
            <InfoTile k="Uptime" v={SRV.uptime} accent />
            <InfoTile k="Load Avg" v={SRV.load.join(" / ")} />
            <InfoTile k="Verbindungen" v={SRV.conns.toLocaleString("de-DE")} />
            <InfoTile k="GPU" v={SRV.gpu} />
            <InfoTile k="Node" v={SRV.node} />
          </div>
        </div>
      </div>

      {/* ── FINANCIAL GUARD: headline numbers ──────────────────────────── */}
      <div className="se-money">
        <MoneyStat k="Heute" v={eur(todayCost)} sub={usd(todayCost)} accent />
        <MoneyStat k="Monat aktuell" v={eur(mtd.total)} sub={`${usd(mtd.total)} · ${days.length} Tage`} />
        <MoneyStat k="Monat Prognose" v={eur(mtd.projected)} sub={`${mtd.remaining} Tage Rest`} />
        <MoneyStat k="API-Calls (MTD)" v={mtd.calls.toLocaleString("de-DE")} sub={`Ø ${eur(mtd.avg)}/Tag`} />
      </div>

      {/* ── budget meters ──────────────────────────────────────────────── */}
      <div className="se-card">
        <div className="se-card-h"><span className="se-card-t">Budget</span></div>
        <div className="se-meters">
          <BudgetMeter label="Heute" current={todayCost} soft={dailySoft} warn={dailyWarn} hard={dailyHard} />
          <BudgetMeter label="Monat" current={mtd.total} soft={monthSoft} warn={monthWarn} hard={monthHard} />
        </div>
      </div>

      {/* ── cost chart ─────────────────────────────────────────────────── */}
      <div className="se-card">
        <div className="se-card-h">
          <span className="se-card-t">Kostenverlauf · 14 Tage</span>
          <div className="se-legend">
            <span><i className="se-lg-bar" />Tag</span>
            <span><i className="se-lg-bil" />Billing</span>
            <span><i className="se-lg-line" />Kumulativ</span>
            <span><i className="se-lg-hard" />Hard-Limit</span>
          </div>
        </div>
        <CostChart days={days} hard={dailyHard} soft={dailySoft} />
      </div>

      {/* ── alerts + editable limits ───────────────────────────────────── */}
      <div className="se-grid2">
        <div className="se-card">
          <div className="se-card-h"><span className="se-card-t">Alerts</span><span className="se-alert-n">{ALERTS.length}</span></div>
          <div className="se-alerts">
            {ALERTS.map((a) => (
              <div key={a.id} className={`se-alert sev-${a.sev}`}>
                <span className="se-alert-mark">{SEV[a.sev].mark}</span>
                <span className="se-alert-msg">{a.msg}</span>
                <span className="se-alert-ts">{a.ago}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="se-card">
          <div className="se-card-h"><span className="se-card-t">Guard-Limits</span><span className="se-hint">Klicken zum Ändern</span></div>
          <div className="se-lim-grp">Tägliche Limits</div>
          <div className="se-lims">
            <LimitInput label="Soft" hint="Telegram-Alert" tone="warn" value={dailySoft} onChange={setDailySoft} />
            <LimitInput label="Warning" hint="Letzte Warnung" tone="warn" value={dailyWarn} onChange={setDailyWarn} />
            <LimitInput label="Hard" hint="Skill-Throttle" tone="crit" value={dailyHard} onChange={setDailyHard} />
          </div>
          <div className="se-lim-grp">Monatliche Limits</div>
          <div className="se-lims">
            <LimitInput label="Soft" hint="Telegram-Alert" tone="warn" value={monthSoft} onChange={setMonthSoft} />
            <LimitInput label="Warning" hint="Letzte Warnung" tone="warn" value={monthWarn} onChange={setMonthWarn} />
            <LimitInput label="Hard" hint="Skill-Throttle" tone="crit" value={monthHard} onChange={setMonthHard} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── donut ring gauge ────────────────────────────────────────────────────────
function Donut({ label, pct }: { label: string; pct: number }) {
  const R = 50;
  const C = 2 * Math.PI * R;
  const off = C * (1 - Math.min(100, pct) / 100);
  const hot = pct >= 85;
  return (
    <div className="se-donut">
      <svg viewBox="0 0 120 120" className="se-donut-svg">
        <defs>
          <linearGradient id={`se-dgrad-${label}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={R} className="se-donut-bg" />
        <circle
          cx="60" cy="60" r={R}
          className={`se-donut-fg${hot ? " hot" : ""}`}
          stroke={hot ? "#c0392b" : `url(#se-dgrad-${label})`}
          strokeDasharray={C} strokeDashoffset={off}
          transform="rotate(-90 60 60)"
        />
        <text x="60" y="60" className="se-donut-pct" textAnchor="middle" dominantBaseline="central"
          fontFamily="var(--mono,ui-monospace,monospace)">{Math.round(pct)}%</text>
      </svg>
      <span className="se-donut-l">{label}</span>
    </div>
  );
}

function InfoTile({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className={`se-info${accent ? " on" : ""}`}>
      <span className="se-info-k">{k}</span>
      <span className="se-info-v">{v}</span>
    </div>
  );
}

function MoneyStat({ k, v, sub, accent }: { k: string; v: string; sub: string; accent?: boolean }) {
  return (
    <div className={`se-mstat${accent ? " on" : ""}`}>
      <div className="se-mstat-k">{k}</div>
      <div className="se-mstat-v">{v}</div>
      <div className="se-mstat-s">{sub}</div>
    </div>
  );
}

// ── budget meter with soft / warning / hard threshold markers ───────────────
function BudgetMeter({ label, current, soft, warn, hard }: { label: string; current: number; soft: number; warn: number; hard: number }) {
  const pct = hard > 0 ? Math.min(100, (current / hard) * 100) : 0;
  const softPct = hard > 0 ? Math.min(100, (soft / hard) * 100) : 0;
  const warnPct = hard > 0 ? Math.min(100, (warn / hard) * 100) : 0;
  // Color-coded green→amber→red as it approaches the limit.
  const tone = current >= hard ? "crit" : current >= warn ? "warn" : current >= soft ? "soft" : "ok";
  return (
    <div className="se-meter">
      <div className="se-meter-h">
        <span className="se-meter-l">{label}</span>
        <span className={`se-meter-v tone-${tone}`}>{eur(current)} / {eur(hard)}</span>
      </div>
      <div className="se-meter-track">
        <span className={`se-meter-fill tone-${tone}`} style={{ width: `${Math.max(1.5, pct)}%` }} />
        <i className="se-mark soft" style={{ left: `${softPct}%` }} />
        <i className="se-mark warn" style={{ left: `${warnPct}%` }} />
        <i className="se-mark hard" style={{ left: "100%" }} />
      </div>
      <div className="se-meter-scale">
        <span>{eur(soft)}</span>
        <span>{eur(warn)}</span>
        <span>{eur(hard)}</span>
      </div>
    </div>
  );
}

// ── SVG bar + cumulative-line cost chart with a hard-limit reference line ────
function CostChart({ days, hard, soft }: { days: Day[]; hard: number; soft: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 800, H = 220;
  const PAD = { t: 18, r: 56, b: 30, l: 48 };
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;

  const values = days.map((d) => d.cost * USD_TO_EUR);
  const cumulative = values.reduce<number[]>((acc, v, i) => {
    acc.push(i === 0 ? v : acc[i - 1] + v);
    return acc;
  }, []);
  const maxVal = Math.max(...values, hard * USD_TO_EUR, 1) * 1.08;
  const maxCum = Math.max(...cumulative, 1);
  const n = days.length;
  const xStep = n > 1 ? plotW / (n - 1) : plotW;
  const barW = Math.max(6, Math.min(26, plotW / n - 6));
  const hardE = hard * USD_TO_EUR;
  const softE = soft * USD_TO_EUR;
  const yOf = (v: number) => PAD.t + plotH - (v / maxVal) * plotH;
  const xOf = (i: number) => PAD.l + (n > 1 ? i * xStep : plotW / 2);

  const linePts = cumulative.map((v, i) => ({ x: xOf(i), y: PAD.t + plotH - (v / maxCum) * plotH }));
  const linePath = linePts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${linePts[n - 1].x.toFixed(1)},${PAD.t + plotH} L${linePts[0].x.toFixed(1)},${PAD.t + plotH} Z`;
  const yTicks = 4;
  const hv = hover !== null ? days[hover] : null;

  return (
    <div className="se-chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="se-chart-svg" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="se-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#06b6d4" />
          </linearGradient>
          <linearGradient id="se-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* y grid + left axis (Tag €) */}
        {Array.from({ length: yTicks + 1 }, (_, i) => {
          const y = PAD.t + (i / yTicks) * plotH;
          const val = maxVal - (i / yTicks) * maxVal;
          return (
            <g key={i}>
              <line x1={PAD.l} y1={y} x2={W - PAD.r} y2={y} className="se-grid" />
              <text x={PAD.l - 8} y={y + 3} textAnchor="end" className="se-axis"
                fontFamily="var(--mono,ui-monospace,monospace)">{fmt(val, val >= 10 ? 0 : 1)}€</text>
            </g>
          );
        })}

        {/* soft + hard reference lines */}
        {softE <= maxVal && (
          <g>
            <line x1={PAD.l} y1={yOf(softE)} x2={W - PAD.r} y2={yOf(softE)} className="se-ref soft" />
            <text x={W - PAD.r + 4} y={yOf(softE) + 3} className="se-ref-l soft"
              fontFamily="var(--mono,ui-monospace,monospace)">SOFT</text>
          </g>
        )}
        {hardE <= maxVal && (
          <g>
            <line x1={PAD.l} y1={yOf(hardE)} x2={W - PAD.r} y2={yOf(hardE)} className="se-ref hard" />
            <text x={W - PAD.r + 4} y={yOf(hardE) + 3} className="se-ref-l hard"
              fontFamily="var(--mono,ui-monospace,monospace)">HARD</text>
          </g>
        )}

        {/* cumulative area + line */}
        <path d={areaPath} fill="url(#se-area)" />
        <path d={linePath} className="se-cum-line" />

        {/* bars + x labels + cumulative dots */}
        {days.map((d, i) => {
          const val = values[i];
          const x = xOf(i) - barW / 2;
          const barH = Math.max(2, (val / maxVal) * plotH);
          const y = PAD.t + plotH - barH;
          const isH = hover === i;
          const over = val >= hardE;
          const near = val >= softE;
          const fill = over ? "#c0392b" : d.billing ? "#0e7490" : "url(#se-bar)";
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} style={{ cursor: "pointer" }}>
              <rect x={x - 4} y={PAD.t} width={barW + 8} height={plotH} fill="transparent" />
              <rect x={x} y={y} width={barW} height={barH} rx="2.5" fill={fill} opacity={isH ? 1 : near ? 0.92 : 0.78} />
              {isH && <rect x={x - 1.5} y={y - 1.5} width={barW + 3} height={barH + 3} rx="3.5" className="se-bar-ring" />}
              {(n <= 14 || i % 2 === 0) && (
                <text x={xOf(i)} y={H - PAD.b + 14} textAnchor="middle"
                  className={isH ? "se-xlab on" : "se-xlab"} fontFamily="var(--mono,ui-monospace,monospace)">{d.label}</text>
              )}
              <circle cx={linePts[i].x} cy={linePts[i].y} r={isH ? 4 : 2.4} className="se-cum-dot" stroke={isH ? "#fff" : "none"} strokeWidth="1.2" />
            </g>
          );
        })}

        {/* right axis (Kum €) */}
        {[0, 0.5, 1].map((p) => (
          <text key={p} x={W - PAD.r + 4} y={PAD.t + (1 - p) * plotH + 3} className="se-axis cum"
            fontFamily="var(--mono,ui-monospace,monospace)">{fmt(p * maxCum, p * maxCum >= 100 ? 0 : 1)}€</text>
        ))}
        <text x={PAD.l - 40} y={PAD.t - 6} className="se-axis-t" fontFamily="var(--mono,ui-monospace,monospace)">TAG €</text>
        <text x={W - PAD.r + 4} y={PAD.t - 6} className="se-axis-t cum" fontFamily="var(--mono,ui-monospace,monospace)">KUM €</text>
      </svg>

      {hv && (
        <div className="se-tip">
          <div className="se-tip-d">{hv.label} · {hv.weekday}</div>
          <div className="se-tip-v">{eur(hv.cost)}</div>
          <div className="se-tip-s">{usd(hv.cost)} · Kum {fmt(cumulative[hover as number])}€</div>
          <div className="se-tip-meta">
            <span>{hv.calls.toLocaleString("de-DE")} Calls</span>
            <span className={hv.billing ? "bil" : "ses"}>{hv.billing ? "BILLING" : "SESSION"}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── editable limit input (click to edit, EUR in UI, USD in state) ───────────
function LimitInput({ label, hint, tone, value, onChange }: {
  label: string; hint: string; tone: "warn" | "crit"; value: number; onChange: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const eurValue = value * USD_TO_EUR;

  const begin = () => { setDraft(fmt(eurValue)); setEditing(true); };
  const save = () => {
    const v = parseFloat(draft);
    if (!isNaN(v) && v >= 0) onChange(Math.round((v / USD_TO_EUR) * 100) / 100);
    setEditing(false);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") setEditing(false);
  };

  if (editing) {
    return (
      <div className={`se-lim editing tone-${tone}`}>
        <div className="se-lim-h"><span className="se-lim-l">{label}</span></div>
        <div className="se-lim-edit">
          <input
            type="number" step="0.5" min="0" autoFocus value={draft}
            onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={save}
          />
          <span>€</span>
        </div>
        <div className="se-lim-hint">↵ Speichern · Esc Abbrechen</div>
      </div>
    );
  }
  return (
    <div className={`se-lim tone-${tone}`} role="button" tabIndex={0} onClick={begin}
      onKeyDown={(e) => { if (e.key === "Enter") begin(); }}>
      <div className="se-lim-h"><span className="se-lim-l">{label}</span><span className="se-lim-edit-tag">EDIT</span></div>
      <div className="se-lim-v">{eur(value)}</div>
      <div className="se-lim-sub">{usd(value)}</div>
      <div className="se-lim-hint">{hint}</div>
    </div>
  );
}

function SecurityStyle() {
  return (
    <style>{`
.se{display:flex;flex-direction:column;gap:16px}

/* header + verdict */
.se-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:2px}
.se-head h2{font-size:22px;font-weight:600;letter-spacing:-.03em}
.se-head p{font-size:13.5px;color:var(--ink2);margin-top:5px;max-width:60ch}
.se-verdict{flex:none;display:flex;align-items:center;gap:11px;padding:10px 16px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim)}
.se-verdict-dot{width:10px;height:10px;border-radius:50%;flex:none}
.se-verdict b{display:block;font-size:14px;font-weight:700;letter-spacing:.02em}
.se-verdict span{font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}
.se-verdict.sev-info .se-verdict-dot{background:#10b981;box-shadow:0 0 8px rgba(16,185,129,.5)}
.se-verdict.sev-info b{color:#0a9d63}
.se-verdict.sev-warn{border-color:rgba(251,191,36,.32)}
.se-verdict.sev-warn .se-verdict-dot{background:#fbbf24;box-shadow:0 0 8px rgba(251,191,36,.5)}
.se-verdict.sev-warn b{color:#b7791f}
.se-verdict.sev-critical{border-color:rgba(239,68,68,.34)}
.se-verdict.sev-critical .se-verdict-dot{background:#ef4444;box-shadow:0 0 9px rgba(239,68,68,.55);animation:se-beat 1.6s ease-out infinite}
.se-verdict.sev-critical b{color:#c0392b}
@keyframes se-beat{0%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}100%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}

/* cards */
.se-card{padding:17px 18px;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(28px) saturate(1.7);-webkit-backdrop-filter:blur(28px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.se-card-h{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:15px}
.se-card-t{font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2)}
.se-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:#0a9d63}
.se-live i{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:se-pulse 1.8s ease-out infinite}
@keyframes se-pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
.se-hint,.se-alert-n{font-size:10.5px;font-weight:600;color:var(--ink3)}
.se-alert-n{padding:2px 8px;border-radius:999px;background:var(--glass2);border:1px solid var(--line)}

/* server status */
.se-srv{display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:center}
.se-donuts{display:flex;gap:18px}
.se-donut{display:flex;flex-direction:column;align-items:center;gap:9px}
.se-donut-svg{width:96px;height:96px}
.se-donut-bg{fill:none;stroke:var(--glass2);stroke-width:9}
.se-donut-fg{fill:none;stroke-width:9;stroke-linecap:round;transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1);filter:drop-shadow(0 0 5px rgba(6,182,212,.45))}
.se-donut-fg.hot{filter:drop-shadow(0 0 5px rgba(239,68,68,.5))}
.se-donut-pct{fill:var(--ink);font-size:21px;font-weight:700;letter-spacing:-.02em}
.se-donut-l{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.07em;color:var(--ink3)}
.se-srv-tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.se-info{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-radius:var(--r-xs,10px);background:var(--glass2);border:1px solid var(--line)}
.se-info.on{border-color:rgba(6,182,212,.3)}
.se-info-k{font-size:9.5px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}
.se-info-v{font-size:13px;font-weight:650;color:var(--ink);font-family:var(--mono,ui-monospace,monospace);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.se-info.on .se-info-v{color:var(--cyan-d,#0891b2)}

/* money stats */
.se-money{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.se-mstat{padding:14px 16px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(26px) saturate(1.7);-webkit-backdrop-filter:blur(26px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.se-mstat.on{border-color:rgba(6,182,212,.35)}
.se-mstat-k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}
.se-mstat-v{font-size:22px;font-weight:700;letter-spacing:-.02em;margin-top:5px;font-family:var(--mono,ui-monospace,monospace)}
.se-mstat.on .se-mstat-v{color:var(--cyan-d,#0891b2)}
.se-mstat-s{font-size:11px;color:var(--ink3);margin-top:3px;font-family:var(--mono,ui-monospace,monospace)}

/* budget meters */
.se-meters{display:flex;flex-direction:column;gap:18px}
.se-meter-h{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px}
.se-meter-l{font-size:12px;font-weight:650;color:var(--ink2)}
.se-meter-v{font-size:12.5px;font-weight:700;font-family:var(--mono,ui-monospace,monospace)}
.se-meter-v.tone-ok{color:#0a9d63}.se-meter-v.tone-soft{color:#b7791f}.se-meter-v.tone-warn{color:#b7791f}.se-meter-v.tone-crit{color:#c0392b}
.se-meter-track{position:relative;height:9px;border-radius:999px;background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim);overflow:visible}
.se-meter-fill{display:block;height:100%;border-radius:999px;transition:width .6s cubic-bezier(.2,.8,.2,1)}
.se-meter-fill.tone-ok{background:linear-gradient(90deg,#22d3ee,#06b6d4)}
.se-meter-fill.tone-soft{background:linear-gradient(90deg,#fbbf24,#f59e0b)}
.se-meter-fill.tone-warn{background:linear-gradient(90deg,#f59e0b,#ea7a17)}
.se-meter-fill.tone-crit{background:linear-gradient(90deg,#ef4444,#c0392b)}
.se-mark{position:absolute;top:-3px;width:2px;height:15px;border-radius:2px;transform:translateX(-1px)}
.se-mark.soft{background:rgba(251,191,36,.7)}
.se-mark.warn{background:rgba(234,122,23,.7)}
.se-mark.hard{background:rgba(239,68,68,.85)}
.se-meter-scale{display:flex;justify-content:space-between;margin-top:6px}
.se-meter-scale span{font-size:9.5px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

/* chart */
.se-legend{display:flex;gap:14px}
.se-legend span{display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--ink3);font-weight:600}
.se-legend i{display:inline-block}
.se-lg-bar{width:9px;height:9px;border-radius:2px;background:linear-gradient(180deg,#22d3ee,#06b6d4)}
.se-lg-bil{width:9px;height:9px;border-radius:2px;background:#0e7490}
.se-lg-line{width:11px;height:2px;background:#06b6d4}
.se-lg-hard{width:11px;height:0;border-top:1px dashed #c0392b}
.se-chart{position:relative}
.se-chart-svg{width:100%;height:auto;display:block}
.se-grid{stroke:var(--line);stroke-dasharray:4 4}
.se-axis{fill:var(--ink3);font-size:9px}
.se-axis.cum{fill:var(--cyan-d,#0891b2);opacity:.65;text-anchor:start}
.se-axis-t{fill:var(--ink3);font-size:8px;letter-spacing:.05em}
.se-axis-t.cum{fill:var(--cyan-d,#0891b2);opacity:.7}
.se-ref{stroke-width:1}
.se-ref.soft{stroke:#f59e0b;stroke-dasharray:4 4;opacity:.45}
.se-ref.hard{stroke:#c0392b;stroke-dasharray:6 3;opacity:.55}
.se-ref-l{font-size:8px;letter-spacing:.05em}
.se-ref-l.soft{fill:#b7791f;opacity:.6}
.se-ref-l.hard{fill:#c0392b;opacity:.75}
.se-cum-line{fill:none;stroke:#06b6d4;stroke-width:2;opacity:.8}
.se-cum-dot{fill:#06b6d4}
.se-bar-ring{fill:none;stroke:#06b6d4;stroke-width:1.4;opacity:.55}
.se-xlab{fill:var(--ink3);font-size:8px}
.se-xlab.on{fill:var(--cyan-d,#0891b2);font-weight:700}
.se-tip{position:absolute;top:6px;right:6px;min-width:170px;padding:11px 14px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(20px) saturate(1.7);-webkit-backdrop-filter:blur(20px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow);pointer-events:none}
.se-tip-d{font-size:11.5px;font-weight:700;color:var(--cyan-d,#0891b2);font-family:var(--mono,ui-monospace,monospace)}
.se-tip-v{font-size:21px;font-weight:800;letter-spacing:-.02em;margin-top:3px;font-family:var(--mono,ui-monospace,monospace)}
.se-tip-s{font-size:10px;color:var(--ink3);margin-top:1px;font-family:var(--mono,ui-monospace,monospace)}
.se-tip-meta{display:flex;justify-content:space-between;align-items:center;margin-top:7px;font-size:9px;font-family:var(--mono,ui-monospace,monospace)}
.se-tip-meta span{color:var(--ink3)}
.se-tip-meta .bil{color:#0e7490;font-weight:700;letter-spacing:.06em}
.se-tip-meta .ses{color:#0a9d63;font-weight:700;letter-spacing:.06em}

/* alerts + limits row */
.se-grid2{display:grid;grid-template-columns:1.15fr 1fr;gap:14px;align-items:start}
.se-alerts{display:flex;flex-direction:column;gap:8px}
.se-alert{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;padding:10px 13px;border-radius:var(--r-sm);font-size:12px}
.se-alert-mark{font-weight:800;font-family:var(--mono,ui-monospace,monospace);font-size:11px}
.se-alert-msg{color:var(--ink);line-height:1.4}
.se-alert-ts{font-size:10px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace);white-space:nowrap}
.se-alert.sev-info{background:rgba(6,182,212,.06);border:1px solid rgba(6,182,212,.18)}
.se-alert.sev-info .se-alert-mark{color:#0891b2}
.se-alert.sev-warn{background:rgba(251,191,36,.09);border:1px solid rgba(251,191,36,.24)}
.se-alert.sev-warn .se-alert-mark{color:#b7791f}
.se-alert.sev-critical{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.24)}
.se-alert.sev-critical .se-alert-mark{color:#c0392b}

.se-lim-grp{font-size:10.5px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin:4px 2px 9px}
.se-lim-grp:not(:first-of-type){margin-top:16px;padding-top:14px;border-top:1px solid var(--line)}
.se-lims{display:grid;grid-template-columns:repeat(3,1fr);gap:9px}
.se-lim{padding:11px 12px;border-radius:var(--r-xs,10px);background:var(--glass2);border:1px solid var(--line);cursor:pointer;transition:border-color .18s ease,box-shadow .18s ease;outline:none}
.se-lim:hover,.se-lim:focus-visible{border-color:rgba(6,182,212,.32);box-shadow:0 0 0 3px rgba(6,182,212,.08)}
.se-lim.editing{cursor:default}
.se-lim.editing.tone-warn{border-color:rgba(245,158,11,.4);box-shadow:0 0 12px rgba(245,158,11,.14)}
.se-lim.editing.tone-crit{border-color:rgba(239,68,68,.4);box-shadow:0 0 12px rgba(239,68,68,.14)}
.se-lim-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.se-lim-l{font-size:9.5px;font-weight:680;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}
.se-lim.tone-warn .se-lim-l{color:#b7791f}
.se-lim.tone-crit .se-lim-l{color:#c0392b}
.se-lim-edit-tag{font-size:8px;font-weight:700;letter-spacing:.06em;color:var(--ink3);opacity:.55}
.se-lim-v{font-size:19px;font-weight:700;letter-spacing:-.02em;font-family:var(--mono,ui-monospace,monospace)}
.se-lim.tone-warn .se-lim-v{color:#b7791f}
.se-lim.tone-crit .se-lim-v{color:#c0392b}
.se-lim-sub{font-size:10px;color:var(--ink3);margin-top:1px;font-family:var(--mono,ui-monospace,monospace)}
.se-lim-hint{font-size:9.5px;color:var(--ink3);margin-top:5px}
.se-lim-edit{display:flex;align-items:center;gap:6px;margin-top:2px}
.se-lim-edit input{flex:1;min-width:0;font-size:18px;font-weight:700;font-family:var(--mono,ui-monospace,monospace);color:var(--ink);background:var(--glass);border:1px solid var(--glass-edge);border-radius:var(--r-xs,8px);padding:5px 9px;outline:none}
.se-lim-edit input::-webkit-outer-spin-button,.se-lim-edit input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.se-lim-edit span{font-size:16px;font-weight:700;color:var(--ink2)}

@media (prefers-reduced-motion:reduce){
  .se-live i,.se-verdict.sev-critical .se-verdict-dot{animation:none}
  .se-donut-fg,.se-meter-fill,.se-lim{transition:none}
}
@media (max-width:900px){
  .se-money{grid-template-columns:repeat(2,1fr)}
  .se-srv{grid-template-columns:1fr;gap:20px}
  .se-donuts{justify-content:space-around}
  .se-srv-tiles{grid-template-columns:repeat(2,1fr)}
  .se-grid2{grid-template-columns:1fr}
  .se-head{flex-direction:column;align-items:flex-start}
}
`}</style>
  );
}
