/**
 * U1 — the orchestrator control room.
 *
 * MODEL (per TJ): there is exactly ONE agent — U1 — and everything else is a
 * SKILL you add to it. This tab is U1 itself: its identity, its 24-hour cron
 * schedule, the token-cost it burns, a text bridge to talk to it, and the
 * flagship voice orb. U1 is found by FLAG via orchestratorOf(AGENTS), never by a
 * hardcoded code.
 *
 * Ported from the SNI U1Profile/U1Chat/VoiceCall reference (different stack) and
 * reframed onto the Liquid Glass design system. The text chat ("Neural Bridge") is
 * LIVE — it streams the real u1 over chat.subunit.ai (a persistent thread, synced
 * with the Chat module + iOS). Timeline / cost / voice-orb stay mock/derived for
 * now (no usage/cron API yet). Math.random/new Date are runtime, so they're fine.
 *
 * Subunit Liquid Glass — glass cards over an aurora mesh, ONE cyan accent.
 * Every class is scoped `.u1-` so styles never collide with other tabs.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { HostApi } from "../../../plugin/types";
import { AGENTS, orchestratorOf } from "../agents";
import { createThread, getThread, streamThreadMessage } from "../../../lib/u1chat";

// ─────────────────────────────────────────────────────────────────────────
// Cron schedule — U1's day. 96 fifteen-minute slots (24h × 4).
// ─────────────────────────────────────────────────────────────────────────

interface Job {
  id: string;
  name: string;
  icon: string;
  hour: number; // start hour (0..23)
  min: number; // start minute (0|15|30|45)
  duration: number; // minutes
  color: string;
  model: string;
  recurring?: boolean; // every 2h
}

const JOBS: Job[] = [
  { id: "notion", name: "Notion Sync", icon: "📋", hour: 4, min: 30, duration: 15, color: "#a78bfa", model: "sonnet-4-6" },
  { id: "nacht", name: "Nacht-Sync", icon: "🌙", hour: 4, min: 45, duration: 15, color: "#818cf8", model: "sonnet-4-6" },
  { id: "morning", name: "Morning Briefing", icon: "☀️", hour: 5, min: 0, duration: 60, color: "#fbbf24", model: "flash-3" },
  { id: "weekly", name: "Weekly Summary", icon: "📊", hour: 7, min: 30, duration: 15, color: "#a78bfa", model: "sonnet-4-6" },
  { id: "work", name: "Work Block", icon: "💼", hour: 8, min: 0, duration: 150, color: "#06b6d4", model: "opus-4-6" },
  { id: "midday", name: "Lead-Pipeline", icon: "🛰️", hour: 13, min: 0, duration: 45, color: "#36d399", model: "sonnet-4-6" },
  { id: "evening", name: "Evening Sync", icon: "🌆", hour: 22, min: 0, duration: 45, color: "#f472b6", model: "sonnet-4-6" },
  { id: "session", name: "Session Log", icon: "📝", hour: 23, min: 45, duration: 15, color: "#94a3b8", model: "sonnet-4-6" },
  { id: "heartbeat", name: "Heartbeat", icon: "💓", hour: 0, min: 0, duration: 5, color: "#22d3ee", model: "llama-70b", recurring: true },
];

const TOTAL_SLOTS = 96;
const SLOTS_PER_HOUR = 4;

const slotOf = (h: number, m: number) => h * SLOTS_PER_HOUR + Math.floor(m / 15);
const slotTime = (slot: number) => {
  const h = Math.floor((slot * 15) / 60);
  const m = (slot * 15) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

/** slot index → owning Job (or null). Recurring jobs fill every-2h slots. */
function buildSlotMap(jobs: Job[]): (Job | null)[] {
  const map = new Array<Job | null>(TOTAL_SLOTS).fill(null);
  for (const j of jobs) {
    if (j.recurring) {
      for (let h = 0; h < 24; h += 2) {
        const s = slotOf(h, 0);
        if (!map[s]) map[s] = j;
      }
      continue;
    }
    const start = slotOf(j.hour, j.min);
    const count = Math.max(1, Math.ceil(j.duration / 15));
    for (let i = 0; i < count; i++) {
      const s = start + i;
      if (s < TOTAL_SLOTS && !map[s]) map[s] = j;
    }
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────
// Voice orb — the flagship "talk to U1" visual. Multi-layer breathing canvas,
// ported from the SNI drawOrb(). 8 state colors; idle breathes, others cycle.
// ─────────────────────────────────────────────────────────────────────────

type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "reasoning"
  | "speaking"
  | "command"
  | "connecting"
  | "error";

const STATE_COLORS: Record<OrbState, [number, number, number]> = {
  idle: [6, 182, 212],
  listening: [56, 189, 248],
  thinking: [52, 211, 153],
  reasoning: [249, 115, 22],
  speaking: [34, 211, 238],
  command: [168, 85, 247],
  connecting: [100, 116, 139],
  error: [239, 68, 68],
};

const STATE_LABEL: Record<OrbState, string> = {
  idle: "BEREIT",
  listening: "HÖRT ZU",
  thinking: "DENKT",
  reasoning: "ARBEITET",
  speaking: "SPRICHT",
  command: "BEFEHL",
  connecting: "VERBINDE…",
  error: "FEHLER",
};

function drawOrb(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  state: OrbState,
  amplitude: number,
  t: number,
) {
  const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const cx = w / 2;
  const cy = h / 2;
  const baseR = Math.min(w, h) * 0.22;

  const breath = 0.5 + 0.5 * Math.sin(t * 1.5);
  const pulse = 0.3 + 0.4 * breath + 0.3 * amplitude;
  const radius = baseR * (0.8 + 0.4 * pulse);

  ctx.clearRect(0, 0, w, h);

  // Outer glow layers (5 stacked radial gradients → depth).
  for (let i = 5; i > 0; i--) {
    const glowR = radius + i * 18;
    const alpha = (0.06 * pulse * (6 - i)) / 5;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 0.8})`);
    grad.addColorStop(0.6, `rgba(${color[0]},${color[1]},${color[2]},${alpha * 0.3})`);
    grad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Core orb gradient.
  const coreGrad = ctx.createRadialGradient(cx - radius * 0.2, cy - radius * 0.2, radius * 0.05, cx, cy, radius);
  coreGrad.addColorStop(0, `rgba(${Math.min(255, color[0] + 80)},${Math.min(255, color[1] + 80)},${Math.min(255, color[2] + 80)},${0.6 + 0.4 * pulse})`);
  coreGrad.addColorStop(0.5, `rgba(${color[0]},${color[1]},${color[2]},${0.5 + 0.3 * pulse})`);
  coreGrad.addColorStop(1, `rgba(${Math.round(color[0] * 0.5)},${Math.round(color[1] * 0.5)},${Math.round(color[2] * 0.5)},0.3)`);
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = coreGrad;
  ctx.fill();

  // Inner highlight (top-left light source).
  const hlGrad = ctx.createRadialGradient(cx - radius * 0.15, cy - radius * 0.2, 0, cx, cy, radius * 0.6);
  hlGrad.addColorStop(0, `rgba(255,255,255,${0.18 * pulse})`);
  hlGrad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2);
  ctx.fillStyle = hlGrad;
  ctx.fill();

  // Center bright dot.
  const dotR = radius * 0.12;
  const dotGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, dotR);
  dotGrad.addColorStop(0, `rgba(255,255,255,${0.4 * pulse})`);
  dotGrad.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
  ctx.beginPath();
  ctx.arc(cx, cy, dotR, 0, Math.PI * 2);
  ctx.fillStyle = dotGrad;
  ctx.fill();

  // Animated rings while active.
  if (state === "speaking" || state === "thinking" || state === "reasoning" || state === "listening") {
    const ringR = radius + 8 + Math.sin(t * 3) * 6;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.18 + 0.1 * Math.sin(t * 4)})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const ringR2 = radius + 20 + Math.sin(t * 2 + 1) * 8;
    ctx.beginPath();
    ctx.arc(cx, cy, ringR2, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${0.07 + 0.04 * Math.sin(t * 3)})`;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function VoiceOrb() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(false);
  const [state, setState] = useState<OrbState>("idle");
  const stateRef = useRef<OrbState>("idle");
  const ampRef = useRef(0);
  const timeRef = useRef(0);

  // A scripted "call" — cycle through states so it FEELS alive (visual only).
  const SEQUENCE: OrbState[] = ["connecting", "listening", "thinking", "reasoning", "speaking", "listening"];
  const seqRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Render loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion:reduce)").matches;
    const dpr = window.devicePixelRatio || 1;
    const size = 260;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let running = true;
    const animate = () => {
      if (!running) return;
      timeRef.current += reduce ? 0.012 : 0.03;
      // Speaking/listening gives the orb a little simulated amplitude jitter.
      const s = stateRef.current;
      const live = s === "speaking" || s === "listening";
      ampRef.current = live ? 0.35 + Math.random() * 0.4 : ampRef.current * 0.9;
      drawOrb(ctx, size, size, s, ampRef.current, timeRef.current);
      raf = requestAnimationFrame(animate);
    };
    animate();
    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  // Scripted state machine while "in a call".
  useEffect(() => {
    if (!active) {
      setState("idle");
      return;
    }
    seqRef.current = 0;
    setState(SEQUENCE[0]);
    const iv = window.setInterval(() => {
      seqRef.current = (seqRef.current + 1) % SEQUENCE.length;
      setState(SEQUENCE[seqRef.current]);
    }, 2600);
    return () => window.clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const color = STATE_COLORS[state] ?? STATE_COLORS.idle;
  const rgb = `rgb(${color[0]},${color[1]},${color[2]})`;

  return (
    <div className="u1-orb-wrap">
      <button
        className="u1-orb-btn"
        onClick={() => setActive((a) => !a)}
        aria-label={active ? "Call beenden" : "Mit U1 sprechen"}
      >
        <canvas ref={canvasRef} className="u1-orb-canvas" style={{ width: 260, height: 260 }} />
      </button>
      <div className="u1-orb-state" style={{ color: rgb, textShadow: `0 0 18px rgba(${color[0]},${color[1]},${color[2]},.5)` }}>
        {STATE_LABEL[state]}
        {active && <span className="u1-orb-sess">· LIVE</span>}
      </div>
      <button className={`u1-orb-cta${active ? " on" : ""}`} onClick={() => setActive((a) => !a)}>
        {active ? "Call beenden" : "Mit U1 sprechen"}
      </button>
      <p className="u1-orb-hint">Sprach-Bridge zur Voice-WS — visuelle Vorschau (Mic-Anbindung kommt).</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Text chat — LIVE u1 over chat.subunit.ai (persistent thread, synced w/ iOS).
// ─────────────────────────────────────────────────────────────────────────

interface Msg {
  id: number;
  sender: "u1" | "user";
  text: string;
}

function Chat({ host, color }: { host: HostApi; color: string }) {
  const [messages, setMessages] = useState<Msg[]>([
    { id: 0, sender: "u1", text: "Unit One online. Frag mich was — ich ziehe Kontext aus unserem geteilten Gedächtnis." },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(1);
  const threadRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  // Restore the persistent u1 thread (the SAME cloud thread as the Chat module and
  // subunit-ios). Offline / no saved thread just keeps the greeting.
  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const saved = (await host.storage.get("u1.thread")) as string | undefined;
        if (!saved) return;
        threadRef.current = saved;
        const { messages: msgs } = await getThread(host, saved);
        if (!alive.current || !msgs?.length) return;
        const mapped = msgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m, i) => ({ id: i + 1, sender: (m.role === "user" ? "user" : "u1") as Msg["sender"], text: m.content }));
        if (mapped.length) {
          setMessages(mapped);
          idRef.current = mapped.length + 1;
        }
      } catch {
        /* keep greeting */
      }
    })();
    return () => {
      alive.current = false;
      abortRef.current?.abort();
    };
  }, [host]);

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setError(null);
    // Ensure a persistent thread (continues across restarts; syncs with iOS).
    let threadId = threadRef.current;
    if (!threadId) {
      try {
        const t = await createThread(host, "opus");
        threadId = t.id;
        threadRef.current = t.id;
        void host.storage.set("u1.thread", t.id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Verbindung zu u1 fehlgeschlagen.");
        return;
      }
    }
    setInput("");
    setSending(true);
    const uId = idRef.current++;
    const aId = idRef.current++;
    setMessages((p) => [...p, { id: uId, sender: "user", text }, { id: aId, sender: "u1", text: "" }]);

    const appendDelta = (t: string) =>
      setMessages((p) => {
        const next = p.slice();
        const last = next[next.length - 1];
        if (last && last.sender === "u1") next[next.length - 1] = { ...last, text: last.text + t };
        return next;
      });

    const ac = new AbortController();
    abortRef.current = ac;
    try {
      for await (const evt of streamThreadMessage(
        host,
        threadId,
        { content: text, model: "opus", effort: "high" },
        ac.signal,
      )) {
        if (evt.event === "delta") appendDelta((evt.data as { text?: string })?.text ?? "");
        else if (evt.event === "error")
          setError((evt.data as { message?: string })?.message || "Antwort fehlgeschlagen.");
        // "meta" / "ratelimit" / "done" need no UI here — the Bridge is a lean console.
      }
    } catch (e) {
      if (alive.current && !(e instanceof DOMException && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
        // Drop the empty streaming bubble on a hard failure.
        setMessages((p) =>
          p.length && p[p.length - 1].sender === "u1" && !p[p.length - 1].text ? p.slice(0, -1) : p,
        );
      }
    } finally {
      if (abortRef.current === ac) abortRef.current = null;
      if (alive.current) setSending(false);
    }
  };

  const lastEmptyU1 =
    sending &&
    messages[messages.length - 1]?.sender === "u1" &&
    !messages[messages.length - 1]?.text;

  return (
    <div className="u1-card u1-chat">
      <div className="u1-card-h">
        <span className="u1-card-t">Neural Bridge</span>
        <span className="u1-live"><i style={{ background: color }} />live</span>
      </div>
      <div className="u1-chat-log">
        {messages.map((m, i) => (
          <div key={m.id} className={`u1-msg ${m.sender}`}>
            <span className="u1-msg-who">{m.sender === "user" ? "TJ" : "UNIT ONE"}</span>
            <div className="u1-bubble">
              {m.text ||
                (lastEmptyU1 && i === messages.length - 1 ? (
                  <span className="u1-typing"><i /><i /><i /></span>
                ) : (
                  ""
                ))}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      {error && (
        <div style={{ fontSize: "12px", color: "#dc2626", padding: "4px 6px", lineHeight: 1.4 }}>{error}</div>
      )}
      <div className="u1-chat-in">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Befehl an U1 eingeben…"
        />
        <button className="btn btn-primary" onClick={() => void send()} disabled={!input.trim() || sending}>
          Senden
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Cost tracker — heute / Monat / Gesamt / Prognose + a 14-day sparkbar.
// All derived/mock (no usage API yet).
// ─────────────────────────────────────────────────────────────────────────

interface CostFigs {
  today: number;
  month: number;
  total: number;
  projection: number;
  perDay: number;
  days14: number[];
}

function deriveCost(): CostFigs {
  // A plausible synthetic 14-day spend curve (€), weekdays heavier.
  const now = new Date();
  const days14: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const wd = d.getDay();
    const base = wd === 0 || wd === 6 ? 0.6 : 1.7; // weekend dip
    const jitter = 0.4 + ((Math.sin(d.getDate() * 1.3 + wd) + 1) / 2) * 0.9;
    days14.push(+(base * jitter).toFixed(2));
  }
  const today = days14[days14.length - 1];
  const dayOfMonth = now.getDate();
  const perDay = +(days14.reduce((s, v) => s + v, 0) / days14.length).toFixed(2);
  const month = +(perDay * dayOfMonth + 50 * 0).toFixed(2); // no untracked baseline this month
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const projection = +(perDay * daysInMonth).toFixed(2);
  const total = +(month + 214.7).toFixed(2); // historical baseline
  return { today, month, total, projection, perDay, days14 };
}

function CostTracker() {
  const c = useMemo(deriveCost, []);
  const max = Math.max(...c.days14, 0.01);
  const todayStr = new Date().toISOString().slice(0, 10);
  const monthName = new Date().toLocaleDateString("de-DE", { month: "long", year: "numeric" });

  return (
    <div className="u1-card u1-cost">
      <div className="u1-card-h">
        <span className="u1-card-t">Token-Kosten</span>
        <span className="u1-badge">live geschätzt</span>
      </div>
      <div className="u1-cost-figs">
        <CostFig k="Heute" v={c.today} accent />
        <CostFig k={monthName} v={c.month} sub="bisher" />
        <CostFig k="Prognose" v={c.projection} sub="Monatsende" />
        <CostFig k="Gesamt" v={c.total} sub="seit Start" />
      </div>
      <div className="u1-spark">
        <div className="u1-spark-h">
          <span>Letzte 14 Tage</span>
          <span className="u1-spark-avg">Ø {c.perDay.toFixed(2)} € / Tag</span>
        </div>
        <div className="u1-spark-bars">
          {c.days14.map((v, i) => {
            const d = new Date();
            d.setDate(d.getDate() - (13 - i));
            const isToday = d.toISOString().slice(0, 10) === todayStr;
            return (
              <div key={i} className="u1-spark-col" title={`${d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })} · ${v.toFixed(2)} €`}>
                <span
                  className={`u1-spark-bar${isToday ? " today" : ""}`}
                  style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
                />
                <span className="u1-spark-day">{d.getDate()}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CostFig({ k, v, sub, accent }: { k: string; v: number; sub?: string; accent?: boolean }) {
  return (
    <div className={`u1-cfig${accent ? " on" : ""}`}>
      <div className="u1-cfig-v">{v.toFixed(2)} €</div>
      <div className="u1-cfig-k">{k}</div>
      {sub && <div className="u1-cfig-sub">{sub}</div>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The tab.
// ─────────────────────────────────────────────────────────────────────────

export default function U1Tab({ host }: { host: HostApi }) {
  const u1 = useMemo(() => orchestratorOf(AGENTS), []);
  const color = u1?.color ?? "#00f0ff";

  const slotMap = useMemo(() => buildSlotMap(JOBS), []);
  const [nowSlot, setNowSlot] = useState(() => {
    const n = new Date();
    return slotOf(n.getHours(), n.getMinutes());
  });
  const nowHour = Math.floor((nowSlot * 15) / 60);

  // Re-tick the "now" marker every 20s so it stays honest in a long demo.
  useEffect(() => {
    const iv = window.setInterval(() => {
      const n = new Date();
      setNowSlot(slotOf(n.getHours(), n.getMinutes()));
    }, 20000);
    return () => window.clearInterval(iv);
  }, []);

  const [hover, setHover] = useState<{ slot: number; job: Job } | null>(null);

  const scheduled = JOBS.filter((j) => !j.recurring);
  const busySlots = slotMap.filter(Boolean).length;
  const freeHours = Math.floor(((TOTAL_SLOTS - busySlots) * 15) / 60);

  // Uptime since a fixed launch date — purely derived.
  const onlineDays = useMemo(
    () => Math.max(1, Math.floor((Date.now() - new Date("2026-03-04T00:00:00+01:00").getTime()) / 86400000)),
    [],
  );

  return (
    <div className="u1">
      <U1Style />

      {/* Profile header */}
      <div className="u1-hero u1-card">
        <span className="u1-avatar" style={{ "--c": color } as React.CSSProperties}>🔷</span>
        <div className="u1-hero-id">
          <div className="u1-hero-name">
            {u1?.name ?? "Unit One"}
            <span className="u1-status"><i />Online</span>
          </div>
          <div className="u1-hero-role">{u1?.role ?? "Orchestrator"} · AI Operations Lead @ subunit</div>
          <div className="u1-hero-tags">
            <span className="u1-tag model">claude-sonnet-4-6</span>
            <span className="u1-tag">{onlineDays}d online</span>
            <span className="u1-tag">{u1?.axone.length ?? 0} Skills verdrahtet</span>
          </div>
        </div>
        <div className="u1-hero-stats">
          <div className="u1-hstat"><b>{u1?.cpu ?? 12}%</b><span>CPU</span></div>
          <div className="u1-hstat"><b>{u1?.mem ?? 340}</b><span>MB RAM</span></div>
          <div className="u1-hstat"><b>{u1?.reflexe.length ?? 5}</b><span>Reflexe</span></div>
        </div>
      </div>

      {/* 24h timeline */}
      <div className="u1-card u1-tl">
        <div className="u1-card-h">
          <span className="u1-card-t">24-Stunden-Zeitplan</span>
          <span className="u1-tl-meta">{scheduled.length} Cron-Jobs · {freeHours}h frei</span>
        </div>

        <div className="u1-tl-grid" role="img" aria-label="U1 Tagesplan, 24 Stunden">
          {slotMap.map((job, i) => {
            const isNow = i === nowSlot;
            const on = !!job;
            return (
              <div
                key={i}
                className={`u1-slot${on ? " on" : ""}${isNow ? " now" : ""}`}
                style={on ? ({ "--c": job!.color } as React.CSSProperties) : undefined}
                onMouseEnter={() => job && setHover({ slot: i, job })}
                onMouseLeave={() => setHover((h) => (h?.slot === i ? null : h))}
              >
                {isNow && <span className="u1-now-pin" />}
                {hover?.slot === i && job && (
                  <div className="u1-pop">
                    <div className="u1-pop-arrow" />
                    <div className="u1-pop-h">
                      <span className="u1-pop-ic">{job.icon}</span>
                      <span className="u1-pop-name">{job.name}</span>
                    </div>
                    <div className="u1-pop-row">{slotTime(i)} · {job.duration} min</div>
                    <div className="u1-pop-row dim">{job.model}{job.recurring ? " · alle 2h" : ""}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="u1-tl-hours">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className={h === nowHour ? "now" : ""}>{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>
          ))}
        </div>

        <div className="u1-legend">
          {scheduled.map((j) => (
            <span key={j.id} className="u1-leg">
              <span className="u1-leg-dot" style={{ background: j.color }} />
              {j.icon} {j.name}
            </span>
          ))}
          <span className="u1-leg recurring">
            <span className="u1-leg-dot" style={{ background: "#22d3ee" }} />
            💓 Heartbeat · alle 2h
          </span>
        </div>
      </div>

      {/* Lower grid: orb · chat · cost */}
      <div className="u1-grid">
        <div className="u1-card u1-orb-card">
          <div className="u1-card-h">
            <span className="u1-card-t">Voice</span>
            <span className="u1-live"><i style={{ background: color }} />bereit</span>
          </div>
          <VoiceOrb />
        </div>

        <Chat host={host} color={color} />

        <CostTracker />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

function U1Style() {
  return (
    <style>{`
.u1{display:flex;flex-direction:column;gap:16px}
.u1-card{padding:17px 18px;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(30px) saturate(1.7);-webkit-backdrop-filter:blur(30px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.u1-card-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.u1-card-t{font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2)}
.u1-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:650;color:var(--ink2)}
.u1-live i{width:7px;height:7px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:u1-beat 1.8s ease-out infinite}
@keyframes u1-beat{0%{box-shadow:0 0 0 0 rgba(34,211,238,.5)}100%{box-shadow:0 0 0 7px rgba(34,211,238,0)}}
.u1-badge{font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:3px 8px;border-radius:7px;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.22)}

/* hero */
.u1-hero{display:flex;align-items:center;gap:18px;position:relative;overflow:hidden}
.u1-avatar{flex:none;width:72px;height:72px;border-radius:20px;display:grid;place-items:center;font-size:32px;background:var(--c);background-image:linear-gradient(155deg,rgba(255,255,255,.22),rgba(0,0,0,.42));box-shadow:0 14px 30px -12px var(--c),inset 0 1px 0 rgba(255,255,255,.4)}
.u1-hero-id{flex:1;min-width:0}
.u1-hero-name{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:680;letter-spacing:-.03em}
.u1-status{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#0a9d63;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);border-radius:999px;padding:3px 10px}
.u1-status i{width:6px;height:6px;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;animation:u1-beat 2s ease-out infinite}
.u1-hero-role{font-size:13px;color:var(--ink2);margin-top:6px}
.u1-hero-tags{display:flex;flex-wrap:wrap;gap:7px;margin-top:11px}
.u1-tag{font-size:11px;font-weight:600;font-family:var(--mono,ui-monospace,monospace);color:var(--ink2);background:var(--glass2);border:1px solid var(--line);border-radius:8px;padding:4px 9px}
.u1-tag.model{color:#7c5fe0;background:rgba(167,139,250,.12);border-color:rgba(167,139,250,.25)}
.u1-hero-stats{flex:none;display:flex;gap:10px}
.u1-hstat{min-width:62px;text-align:center;padding:10px 8px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line)}
.u1-hstat b{display:block;font-size:18px;font-weight:700;letter-spacing:-.02em}
.u1-hstat span{font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}

/* timeline */
.u1-tl-meta{font-size:11px;font-weight:600;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}
.u1-tl-grid{display:grid;grid-template-columns:repeat(96,1fr);gap:1px;height:54px;border-radius:var(--r-sm);overflow:visible;padding:1px;background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim)}
.u1-slot{position:relative;height:100%;background:transparent;border-radius:1px;transition:background .2s ease}
.u1-slot:first-child{border-top-left-radius:var(--r-xs);border-bottom-left-radius:var(--r-xs)}
.u1-slot:last-child{border-top-right-radius:var(--r-xs);border-bottom-right-radius:var(--r-xs)}
.u1-slot.on{background:var(--c);background-image:linear-gradient(180deg,rgba(255,255,255,.16),rgba(0,0,0,.28));cursor:pointer}
.u1-slot.on:hover{background-image:linear-gradient(180deg,rgba(255,255,255,.32),rgba(0,0,0,.12));z-index:5}
.u1-slot.now{box-shadow:0 0 10px rgba(34,211,238,.6),inset 0 0 0 1px rgba(34,211,238,.8)}
.u1-now-pin{position:absolute;top:-6px;left:50%;width:3px;height:calc(100% + 12px);transform:translateX(-50%);border-radius:2px;background:#22d3ee;box-shadow:0 0 10px rgba(34,211,238,.9);animation:u1-pin 1.6s ease-in-out infinite;z-index:6}
@keyframes u1-pin{0%,100%{opacity:.55;box-shadow:0 0 6px rgba(34,211,238,.6)}50%{opacity:1;box-shadow:0 0 14px rgba(34,211,238,1)}}

.u1-pop{position:absolute;bottom:calc(100% + 12px);left:50%;transform:translateX(-50%);width:172px;padding:10px 12px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.7);-webkit-backdrop-filter:blur(28px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow);z-index:40;pointer-events:none;animation:u1-pop .14s ease}
@keyframes u1-pop{from{opacity:0;transform:translate(-50%,4px)}to{opacity:1;transform:translate(-50%,0)}}
.u1-pop-arrow{position:absolute;bottom:-5px;left:50%;width:10px;height:10px;transform:translateX(-50%) rotate(45deg);background:var(--glass);border-right:1px solid var(--glass-edge);border-bottom:1px solid var(--glass-edge)}
.u1-pop-h{display:flex;align-items:center;gap:7px;margin-bottom:5px}
.u1-pop-ic{font-size:14px}
.u1-pop-name{font-size:13px;font-weight:680;letter-spacing:-.01em}
.u1-pop-row{font-size:11px;color:var(--ink2);font-family:var(--mono,ui-monospace,monospace);line-height:1.6}
.u1-pop-row.dim{color:var(--ink3)}

.u1-tl-hours{display:grid;grid-template-columns:repeat(24,1fr);margin-top:7px}
.u1-tl-hours span{font-size:9px;color:var(--ink3);text-align:left;font-family:var(--mono,ui-monospace,monospace)}
.u1-tl-hours span.now{color:#0891b2;font-weight:700}

.u1-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;padding-top:13px;border-top:1px solid var(--line)}
.u1-leg{display:inline-flex;align-items:center;gap:7px;font-size:11px;color:var(--ink2);background:var(--glass2);border:1px solid var(--line);border-radius:8px;padding:5px 10px}
.u1-leg.recurring{color:var(--cyan-d,#0891b2)}
.u1-leg-dot{width:8px;height:8px;border-radius:3px;flex:none}

/* lower grid */
.u1-grid{display:grid;grid-template-columns:0.8fr 1.1fr 1fr;gap:14px;align-items:start}

/* orb */
.u1-orb-card{display:flex;flex-direction:column}
.u1-orb-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:6px 0 4px}
.u1-orb-btn{background:none;border:none;padding:0;cursor:pointer;line-height:0;border-radius:50%}
.u1-orb-canvas{display:block}
.u1-orb-state{font-size:11px;font-weight:700;letter-spacing:.18em;font-family:var(--mono,ui-monospace,monospace)}
.u1-orb-sess{margin-left:8px;opacity:.55}
.u1-orb-cta{font-size:12px;font-weight:680;letter-spacing:.02em;padding:9px 22px;border-radius:999px;cursor:pointer;border:1px solid rgba(6,182,212,.35);color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.08);transition:transform .2s cubic-bezier(.2,.8,.2,1),background .2s ease}
.u1-orb-cta:hover{transform:translateY(-1px);background:rgba(6,182,212,.14)}
.u1-orb-cta.on{color:#dc2626;border-color:rgba(239,68,68,.35);background:rgba(239,68,68,.08)}
.u1-orb-hint{font-size:10.5px;color:var(--ink3);text-align:center;max-width:230px;line-height:1.5}

/* chat */
.u1-chat{display:flex;flex-direction:column;min-height:0}
.u1-chat-log{flex:1;display:flex;flex-direction:column;gap:13px;overflow-y:auto;max-height:300px;padding:2px 4px 6px}
.u1-msg{display:flex;flex-direction:column;max-width:84%}
.u1-msg.user{align-self:flex-end;align-items:flex-end}
.u1-msg.u1{align-self:flex-start;align-items:flex-start}
.u1-msg-who{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink3);margin:0 6px 4px;font-family:var(--mono,ui-monospace,monospace)}
.u1-msg.user .u1-msg-who{color:#7c5fe0}
.u1-msg.u1 .u1-msg-who{color:var(--cyan-d,#0891b2)}
.u1-bubble{font-size:13.5px;line-height:1.55;padding:11px 15px;border-radius:16px;animation:u1-in .26s ease}
@keyframes u1-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.u1-msg.user .u1-bubble{color:var(--ink);background:rgba(129,140,248,.16);border:1px solid rgba(129,140,248,.28);border-bottom-right-radius:4px}
.u1-msg.u1 .u1-bubble{color:var(--ink);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.24);border-bottom-left-radius:4px}
.u1-typing{display:inline-flex;gap:4px;align-items:center}
.u1-typing i{width:6px;height:6px;border-radius:50%;background:var(--cyan-d,#0891b2);opacity:.5;animation:u1-dot 1.1s ease-in-out infinite}
.u1-typing i:nth-child(2){animation-delay:.18s}
.u1-typing i:nth-child(3){animation-delay:.36s}
@keyframes u1-dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}
.u1-chat-in{display:flex;gap:9px;margin-top:13px;padding-top:13px;border-top:1px solid var(--line)}
.u1-chat-in input{flex:1;min-width:0;font-size:13.5px;padding:10px 14px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line);color:var(--ink);outline:none;transition:border-color .2s ease}
.u1-chat-in input:focus{border-color:rgba(6,182,212,.45)}
.u1-chat-in .btn{flex:none}

/* cost */
.u1-cost-figs{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.u1-cfig{padding:13px 14px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line)}
.u1-cfig.on{border-color:rgba(6,182,212,.35);background:rgba(6,182,212,.06)}
.u1-cfig-v{font-size:20px;font-weight:700;letter-spacing:-.02em;font-family:var(--mono,ui-monospace,monospace)}
.u1-cfig.on .u1-cfig-v{color:var(--cyan-d,#0891b2)}
.u1-cfig-k{font-size:11px;font-weight:600;color:var(--ink2);margin-top:3px;text-transform:capitalize}
.u1-cfig-sub{font-size:9.5px;color:var(--ink3);margin-top:1px;text-transform:uppercase;letter-spacing:.04em}
.u1-spark{margin-top:14px}
.u1-spark-h{display:flex;justify-content:space-between;align-items:baseline;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);margin-bottom:8px}
.u1-spark-avg{font-family:var(--mono,ui-monospace,monospace);color:var(--ink2)}
.u1-spark-bars{display:flex;align-items:flex-end;gap:3px;height:60px}
.u1-spark-col{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end}
.u1-spark-bar{width:100%;border-radius:3px 3px 0 0;background:linear-gradient(180deg,rgba(167,139,250,.7),rgba(167,139,250,.35));transition:height .5s cubic-bezier(.2,.8,.2,1)}
.u1-spark-bar.today{background:linear-gradient(180deg,#22d3ee,#06b6d4)}
.u1-spark-day{font-size:8px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

@media (prefers-reduced-motion:reduce){
  .u1-live i,.u1-status i,.u1-now-pin,.u1-bubble,.u1-typing i{animation:none}
  .u1-pop{animation:none}
  .u1-spark-bar,.u1-orb-cta,.u1-chat-in input{transition:none}
}
@media (max-width:900px){
  .u1-grid{grid-template-columns:1fr}
  .u1-hero{flex-wrap:wrap}
  .u1-hero-stats{width:100%}
  .u1-cost-figs{grid-template-columns:repeat(2,1fr)}
}
`}</style>
  );
}
