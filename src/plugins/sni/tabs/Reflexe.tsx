/**
 * Reflexe — U1's Scripts & Workflows browser.
 *
 * MODEL: there is one agent (U1); everything else is a SKILL. A REFLEX is an
 * automatic trigger/script that belongs to a skill (derived from each skill's
 * `reflexe` array). An AXON is a workflow — a wiring between skills (derived
 * from each skill's `axone` connections).
 *
 * Two sub-tabs: "Reflexe" (triggers/scripts) ↔ "Axone" (workflows), a live
 * full-text search, a stats header, and a scannable glass list with a permission
 * badge (auto | fragen | sperren), a status dot, an owning-skill chip, a run
 * counter and a local active/inactive toggle. Static/mock for now (toggle + run
 * wire to the backend later); fully demoable offline.
 *
 * Subunit Liquid Glass — glass rows, ONE cyan accent. All classes prefixed `.rx-`.
 */

import { useMemo, useState } from "react";
import type { HostApi } from "../../../plugin/types";
import { AGENTS, skillsOf, type Agent } from "../agents";

type Permission = "auto" | "fragen" | "sperren";

const PERM_CONFIG: Record<Permission, { label: string; cls: string; dot: string }> = {
  auto: { label: "Auto", cls: "auto", dot: "#34d399" },
  fragen: { label: "Fragen", cls: "ask", dot: "#fbbf24" },
  sperren: { label: "Gesperrt", cls: "deny", dot: "#f87171" },
};

interface Reflex {
  id: string;
  name: string;
  skill: Agent;
  desc: string;
  permission: Permission;
  active: boolean;
  runs: number;
  kind: string; // trigger flavour
  lastRun: string; // relative, e.g. "vor 4 min"
}

interface Axon {
  id: string;
  name: string;
  from: Agent;
  to: Agent;
  desc: string;
  active: boolean;
  steps: number;
  runs: number;
  avgMs: number;
  successPct: number;
}

/* ── deterministic-ish mock derivation ─────────────────────────────────── */

// A tiny seeded hash so the same reflex name always derives the same numbers
// (stable across renders) without a backend.
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

const KIND_OF: { test: RegExp; kind: string; verb: string }[] = [
  { test: /trigger|eingang|request|neukunde|neuer/i, kind: "Event", verb: "feuert bei eingehendem Ereignis" },
  { test: /reminder|timer|schedule|frist|24h/i, kind: "Zeitplan", verb: "läuft auf festem Zeitplan" },
  { test: /check|scan|audit|validierung|threshold|detect|filter/i, kind: "Prüfung", verb: "validiert Bedingungen kontinuierlich" },
  { test: /alert|eskalation|spike|anomalie|downtime/i, kind: "Alarm", verb: "eskaliert an U1 bei Schwellwert" },
  { test: /update|convert|sync|reply|ingest|cache|recovery|balancing|complete/i, kind: "Aktion", verb: "führt eine automatische Aktion aus" },
];

function describe(name: string, skill: Agent): { kind: string; desc: string } {
  const m = KIND_OF.find((k) => k.test.test(name));
  const kind = m?.kind ?? "Aktion";
  const verb = m?.verb ?? "wird vom Skill ausgelöst";
  return { kind, desc: `${skill.name} — ${verb}.` };
}

// Permission heuristic: external-effect reflexe ask/deny, internal ones auto.
function permFor(name: string, skill: Agent): Permission {
  if (/eskalation|reply|post|dsgvo|compliance|vertrag|churn/i.test(name)) return "fragen";
  if (/spam|downtime|threat/i.test(name)) return "sperren";
  // idle skills default to a stricter posture for their non-trivial reflexe.
  if (skill.status === "idle" && seed(name + skill.code) > 0.55) return "fragen";
  return "auto";
}

function relTime(r: number): string {
  const mins = Math.floor(r * 720); // 0..12h
  if (mins < 1) return "gerade eben";
  if (mins < 60) return `vor ${mins} min`;
  const h = Math.floor(mins / 60);
  return `vor ${h} h`;
}

function buildReflexe(skills: Agent[]): Reflex[] {
  const out: Reflex[] = [];
  for (const skill of skills) {
    for (const name of skill.reflexe) {
      const r = seed(name + skill.code);
      const { kind, desc } = describe(name, skill);
      out.push({
        id: `${skill.code}:${name}`,
        name,
        skill,
        desc,
        permission: permFor(name, skill),
        // idle skills' reflexe start inactive; otherwise mostly active.
        active: skill.status !== "idle" && r > 0.12,
        runs: Math.floor(r * 3800) + 4,
        kind,
        lastRun: relTime(seed(name + "ts")),
      });
    }
  }
  // Stable, useful order: active first, then by run-count desc.
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.runs - a.runs);
}

const AXON_TEMPLATES: { match: [string, string]; name: string; desc: string }[] = [
  { match: ["S-01", "S-02"], name: "Lead → Kontakt-Sync", desc: "Qualifizierter Lead wird automatisch als Kontaktprofil angelegt und segmentiert." },
  { match: ["S-05", "S-04"], name: "Inbox → Wissen-Ingest", desc: "Eingehende Mails mit Anhängen werden klassifiziert und in die Wissensdatenbank eingespeist." },
  { match: ["S-04", "S-07"], name: "Wissen → Content-Pipeline", desc: "RAG-Kontext speist die Content-Engine für faktenbasierte Texte." },
  { match: ["S-07", "S-06"], name: "Content → Social-Publish", desc: "Generierter Content wird formatiert und für Social-Posting eingeplant." },
  { match: ["S-08", "S-10"], name: "Analyse → Monitor-Loop", desc: "KPI-Anomalien lösen ein Infrastruktur-Health-Audit aus." },
  { match: ["S-02", "S-03"], name: "Kontakt → Termin-Buchung", desc: "Follow-Up-fällige Kontakte erhalten automatisch einen Buchungsvorschlag." },
  { match: ["S-09", "S-04"], name: "Onboarding → Dossier", desc: "Neukunden-Dokumente werden gesammelt und ein Wissens-Dossier erstellt." },
  { match: ["S-11", "S-04"], name: "Legal → Audit-Trail", desc: "Compliance-Scans schreiben revisionssichere Audit-Logs in die Wissensbasis." },
];

function buildAxone(all: Agent[]): Axon[] {
  const byCode = new Map(all.map((a) => [a.code, a]));
  const out: Axon[] = [];
  for (const t of AXON_TEMPLATES) {
    const from = byCode.get(t.match[0]);
    const to = byCode.get(t.match[1]);
    if (!from || !to) continue;
    const r = seed(t.name);
    out.push({
      id: `${t.match[0]}>${t.match[1]}`,
      name: t.name,
      from,
      to,
      desc: t.desc,
      active: from.status === "running" && to.status === "running" && r > 0.15,
      steps: Math.floor(r * 5) + 3,
      runs: Math.floor(r * 1400) + 12,
      avgMs: Math.floor(r * 2200) + 280,
      successPct: 92 + Math.floor(r * 8),
    });
  }
  return out.sort((a, b) => Number(b.active) - Number(a.active) || b.runs - a.runs);
}

/* ── component ─────────────────────────────────────────────────────────── */

export default function ReflexeTab({ host }: { host: HostApi }) {
  const skills = useMemo(() => skillsOf(AGENTS), []);
  const baseReflexe = useMemo(() => buildReflexe(skills), [skills]);
  const baseAxone = useMemo(() => buildAxone(AGENTS), []);

  const [section, setSection] = useState<"reflexe" | "axone">("reflexe");
  const [search, setSearch] = useState("");
  // Local toggle overrides keyed by id (no backend yet).
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const reflexe = useMemo(
    () => baseReflexe.map((r) => ({ ...r, active: toggled[r.id] ?? r.active })),
    [baseReflexe, toggled],
  );
  const axone = useMemo(
    () => baseAxone.map((a) => ({ ...a, active: toggled[a.id] ?? a.active })),
    [baseAxone, toggled],
  );

  const q = search.trim().toLowerCase();
  const filteredReflexe = useMemo(
    () =>
      q
        ? reflexe.filter(
            (r) =>
              r.name.toLowerCase().includes(q) ||
              r.desc.toLowerCase().includes(q) ||
              r.skill.name.toLowerCase().includes(q) ||
              r.skill.code.toLowerCase().includes(q) ||
              r.kind.toLowerCase().includes(q),
          )
        : reflexe,
    [reflexe, q],
  );
  const filteredAxone = useMemo(
    () =>
      q
        ? axone.filter(
            (a) =>
              a.name.toLowerCase().includes(q) ||
              a.desc.toLowerCase().includes(q) ||
              a.from.name.toLowerCase().includes(q) ||
              a.to.name.toLowerCase().includes(q),
          )
        : axone,
    [axone, q],
  );

  // Stats (over the unfiltered set — they describe the whole registry).
  const stats = useMemo(() => {
    const active = reflexe.filter((r) => r.active).length;
    const byPerm = (Object.keys(PERM_CONFIG) as Permission[]).map((p) => ({
      perm: p,
      ...PERM_CONFIG[p],
      count: reflexe.filter((r) => r.permission === p).length,
    }));
    const totalRuns = reflexe.reduce((s, r) => s + r.runs, 0);
    return { total: reflexe.length, active, byPerm, totalRuns };
  }, [reflexe]);

  const axStats = useMemo(() => {
    const active = axone.filter((a) => a.active).length;
    return { total: axone.length, active };
  }, [axone]);

  const toggle = (id: string, current: boolean, label: string) => {
    const next = !current;
    setToggled((p) => ({ ...p, [id]: next }));
    host.notifications.notify(label, next ? "Reflex aktiviert." : "Reflex pausiert.");
  };

  const run = (label: string) => {
    host.notifications.notify(label, "Reflex einmalig ausgelöst — Anbindung kommt bald.");
  };

  return (
    <div className="rx">
      <ReflexeStyle />

      <div className="rx-head">
        <div>
          <h2>Reflexe &amp; Axone</h2>
          <p>
            Automatische Trigger und Skill-Workflows von U1.{" "}
            <b>{stats.active}</b> von <b>{stats.total}</b> Reflexen aktiv.
          </p>
        </div>
        <div className="rx-runtotal">
          <b>{stats.totalRuns.toLocaleString("de-DE")}</b>
          <span>Auslösungen gesamt</span>
        </div>
      </div>

      {/* Stats strip */}
      <div className="rx-stats">
        <div className="rx-stat on">
          <div className="rx-stat-v">{stats.active}/{stats.total}</div>
          <div className="rx-stat-k">Aktiv</div>
        </div>
        {stats.byPerm.map((p) => (
          <div key={p.perm} className="rx-stat">
            <div className="rx-stat-v">
              <span className="rx-stat-dot" style={{ background: p.dot }} />
              {p.count}
            </div>
            <div className="rx-stat-k">{p.label}</div>
          </div>
        ))}
        <div className="rx-stat">
          <div className="rx-stat-v">{axStats.active}/{axStats.total}</div>
          <div className="rx-stat-k">Axone aktiv</div>
        </div>
      </div>

      {/* Controls: sub-tabs + search */}
      <div className="rx-controls">
        <div className="rx-tabs" role="tablist">
          <button
            role="tab"
            aria-selected={section === "reflexe"}
            className={`rx-tab${section === "reflexe" ? " on" : ""}`}
            onClick={() => setSection("reflexe")}
          >
            Reflexe<span className="rx-tab-n">{filteredReflexe.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={section === "axone"}
            className={`rx-tab${section === "axone" ? " on" : ""}`}
            onClick={() => setSection("axone")}
          >
            Axone<span className="rx-tab-n">{filteredAxone.length}</span>
          </button>
        </div>
        <div className="rx-search">
          <svg viewBox="0 0 24 24" className="rx-search-ic" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            placeholder={section === "reflexe" ? "Reflexe durchsuchen…" : "Axone durchsuchen…"}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            spellCheck={false}
          />
          {search && (
            <button className="rx-search-x" onClick={() => setSearch("")} aria-label="Suche leeren">
              ×
            </button>
          )}
        </div>
      </div>

      {/* List */}
      {section === "reflexe" ? (
        <div className="rx-list">
          {filteredReflexe.length === 0 ? (
            <div className="rx-empty">Keine Reflexe für „{search}".</div>
          ) : (
            filteredReflexe.map((r) => {
              const perm = PERM_CONFIG[r.permission];
              return (
                <div
                  key={r.id}
                  className={`rx-row${r.active ? "" : " off"}`}
                  style={{ "--c": r.skill.color } as React.CSSProperties}
                >
                  <span className={`rx-led${r.active ? "" : " idle"}`} />
                  <div className="rx-row-main">
                    <div className="rx-row-top">
                      <span className="rx-name">{r.name}</span>
                      <span className={`rx-perm ${perm.cls}`}>{perm.label}</span>
                      <span className="rx-kind">{r.kind}</span>
                    </div>
                    <div className="rx-desc">{r.desc}</div>
                    <div className="rx-row-foot">
                      <span className="rx-chip">
                        <i style={{ background: r.skill.color }} />
                        {r.skill.code} · {r.skill.name}
                      </span>
                      <span className="rx-foot-sep" />
                      <span className="rx-runs">{r.runs.toLocaleString("de-DE")} Läufe</span>
                      <span className="rx-foot-sep" />
                      <span className="rx-last">{r.lastRun}</span>
                    </div>
                  </div>
                  <div className="rx-actions">
                    <button
                      className="rx-run"
                      onClick={() => run(r.name)}
                      title="Einmalig auslösen"
                      aria-label="Einmalig auslösen"
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </button>
                    <button
                      className={`rx-toggle${r.active ? " on" : ""}`}
                      role="switch"
                      aria-checked={r.active}
                      aria-label={r.active ? "Reflex pausieren" : "Reflex aktivieren"}
                      onClick={() => toggle(r.id, r.active, r.name)}
                    >
                      <span className="rx-knob" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="rx-list">
          {filteredAxone.length === 0 ? (
            <div className="rx-empty">Keine Axone für „{search}".</div>
          ) : (
            filteredAxone.map((a) => (
              <div
                key={a.id}
                className={`rx-row rx-axon${a.active ? "" : " off"}`}
                style={{ "--c": a.from.color, "--c2": a.to.color } as React.CSSProperties}
              >
                <span className={`rx-led${a.active ? "" : " idle"}`} />
                <div className="rx-row-main">
                  <div className="rx-row-top">
                    <span className="rx-name">{a.name}</span>
                    <span className={`rx-perm ${a.active ? "auto" : "off"}`}>
                      {a.active ? "Aktiv" : "Inaktiv"}
                    </span>
                    <span className="rx-kind">{a.steps} Schritte</span>
                  </div>
                  <div className="rx-flow">
                    <span className="rx-flow-node" style={{ "--n": a.from.color } as React.CSSProperties}>
                      {a.from.code}
                    </span>
                    <span className="rx-flow-arrow">
                      <svg viewBox="0 0 40 12" aria-hidden="true">
                        <path d="M0 6h32" />
                        <path d="M28 2l6 4-6 4" />
                      </svg>
                    </span>
                    <span className="rx-flow-node" style={{ "--n": a.to.color } as React.CSSProperties}>
                      {a.to.code}
                    </span>
                    <span className="rx-flow-names">{a.from.name} → {a.to.name}</span>
                  </div>
                  <div className="rx-desc">{a.desc}</div>
                  <div className="rx-row-foot">
                    <span className="rx-runs">{a.runs.toLocaleString("de-DE")} Läufe</span>
                    <span className="rx-foot-sep" />
                    <span className="rx-last">⌀ {a.avgMs} ms</span>
                    <span className="rx-foot-sep" />
                    <span className="rx-ok">{a.successPct}% Erfolg</span>
                  </div>
                </div>
                <div className="rx-actions">
                  <button
                    className="rx-run"
                    onClick={() => run(a.name)}
                    title="Workflow einmalig ausführen"
                    aria-label="Workflow einmalig ausführen"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </button>
                  <button
                    className={`rx-toggle${a.active ? " on" : ""}`}
                    role="switch"
                    aria-checked={a.active}
                    aria-label={a.active ? "Axon pausieren" : "Axon aktivieren"}
                    onClick={() => toggle(a.id, a.active, a.name)}
                  >
                    <span className="rx-knob" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ReflexeStyle() {
  return (
    <style>{`
.rx{display:flex;flex-direction:column;gap:16px}

.rx-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px}
.rx-head h2{font-size:22px;font-weight:600;letter-spacing:-.03em}
.rx-head p{font-size:13.5px;color:var(--ink2);margin-top:5px}
.rx-head b{color:var(--ink);font-weight:680}
.rx-runtotal{flex:none;text-align:right;padding:10px 18px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm)}
.rx-runtotal b{display:block;font-size:22px;font-weight:700;color:var(--cyan-d,#0891b2);letter-spacing:-.02em;font-family:var(--mono,ui-monospace,monospace)}
.rx-runtotal span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}

.rx-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.rx-stat{padding:13px 15px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.8);-webkit-backdrop-filter:blur(28px) saturate(1.8);border:1px solid var(--line2,var(--glass-edge));box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.rx-stat.on{border-color:rgba(6,182,212,.35)}
.rx-stat-v{display:flex;align-items:center;gap:7px;font-size:20px;font-weight:680;letter-spacing:-.02em;font-family:var(--mono,ui-monospace,monospace)}
.rx-stat.on .rx-stat-v{color:var(--cyan-d,#0891b2)}
.rx-stat-dot{width:9px;height:9px;border-radius:50%;flex:none}
.rx-stat-k{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3);margin-top:3px}

.rx-controls{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.rx-tabs{display:inline-flex;gap:3px;padding:3px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim)}
.rx-tab{display:inline-flex;align-items:center;gap:7px;padding:7px 16px;border:none;background:transparent;border-radius:var(--r-xs,8px);font-size:13px;font-weight:650;color:var(--ink2);cursor:pointer;transition:background .18s,color .18s}
.rx-tab:hover{color:var(--ink)}
.rx-tab.on{background:linear-gradient(155deg,#22d3ee,#06b6d4);color:#06202a;box-shadow:0 6px 16px -8px rgba(6,182,212,.7),inset 0 1px 0 rgba(255,255,255,.35)}
.rx-tab-n{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--glass);color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}
.rx-tab.on .rx-tab-n{background:rgba(255,255,255,.32);color:#06202a}

.rx-search{position:relative;display:flex;align-items:center;flex:1;min-width:200px;max-width:340px}
.rx-search-ic{position:absolute;left:12px;width:16px;height:16px;fill:none;stroke:var(--ink3);stroke-width:2;stroke-linecap:round;pointer-events:none}
.rx-search input{width:100%;box-sizing:border-box;padding:9px 32px 9px 36px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim);font-size:13px;color:var(--ink);outline:none;transition:border-color .18s,box-shadow .18s}
.rx-search input::placeholder{color:var(--ink3)}
.rx-search input:focus{border-color:rgba(6,182,212,.5);box-shadow:0 0 0 3px rgba(6,182,212,.14),inset 0 1px 0 var(--rim)}
.rx-search-x{position:absolute;right:8px;width:20px;height:20px;display:grid;place-items:center;border:none;background:var(--glass2);border-radius:50%;color:var(--ink2);font-size:15px;line-height:1;cursor:pointer}
.rx-search-x:hover{color:var(--ink);background:var(--fill-weak)}

.rx-list{display:flex;flex-direction:column;gap:9px}
.rx-empty{padding:30px;text-align:center;font-size:13px;color:var(--ink3);border-radius:var(--r-sm);background:var(--glass);border:1px dashed var(--line2,var(--glass-edge))}

.rx-row{position:relative;display:grid;grid-template-columns:auto 1fr auto;gap:13px;align-items:center;padding:13px 15px 13px 16px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(26px) saturate(1.6);-webkit-backdrop-filter:blur(26px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);overflow:hidden;transition:transform .18s cubic-bezier(.2,.8,.2,1),border-color .18s}
.rx-row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c);opacity:.85}
.rx-row:hover{transform:translateY(-1px);border-color:var(--line2,var(--glass-edge))}
.rx-row.off{opacity:.6}
.rx-row.off::before{opacity:.3}

.rx-led{flex:none;width:9px;height:9px;border-radius:50%;background:#34d399;box-shadow:0 0 8px rgba(52,211,153,.8);align-self:center}
.rx-led.idle{background:var(--ink3);box-shadow:none}

.rx-row-main{min-width:0}
.rx-row-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.rx-name{font-size:14px;font-weight:680;letter-spacing:-.01em;font-family:var(--mono,ui-monospace,monospace)}
.rx-perm{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:6px;border:1px solid var(--rim)}
.rx-perm.auto{color:#0a9d63;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.28)}
.rx-perm.ask{color:#b7791f;background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.3)}
.rx-perm.deny{color:#c0392b;background:rgba(248,113,113,.14);border-color:rgba(248,113,113,.3)}
.rx-perm.off{color:var(--ink3);background:var(--glass2);border-color:var(--line)}
.rx-kind{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:2px 8px;border-radius:6px;background:var(--glass2);border:1px solid var(--line)}

.rx-desc{font-size:12px;color:var(--ink2);margin-top:5px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.rx-row-foot{display:flex;align-items:center;gap:9px;margin-top:8px;flex-wrap:wrap}
.rx-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--ink2);padding:3px 9px 3px 7px;border-radius:999px;background:var(--glass2);border:1px solid var(--line);font-family:var(--mono,ui-monospace,monospace)}
.rx-chip i{width:7px;height:7px;border-radius:50%;flex:none}
.rx-foot-sep{width:3px;height:3px;border-radius:50%;background:var(--ink3);opacity:.5}
.rx-runs,.rx-last{font-size:11px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}
.rx-ok{font-size:11px;font-weight:650;color:#0a9d63;font-family:var(--mono,ui-monospace,monospace)}

.rx-actions{flex:none;display:flex;align-items:center;gap:9px}
.rx-run{width:30px;height:30px;flex:none;display:grid;place-items:center;border-radius:9px;border:1px solid var(--glass-edge);background:var(--glass2);color:var(--ink2);cursor:pointer;transition:color .16s,border-color .16s,background .16s,transform .12s}
.rx-run svg{width:14px;height:14px;fill:currentColor}
.rx-run:hover{color:var(--cyan-d,#0891b2);border-color:rgba(6,182,212,.4);background:rgba(6,182,212,.1)}
.rx-run:active{transform:scale(.92)}

.rx-toggle{position:relative;flex:none;width:42px;height:24px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);cursor:pointer;padding:0;transition:background .2s,border-color .2s;box-shadow:inset 0 1px 2px rgba(0,0,0,.08)}
.rx-toggle.on{background:linear-gradient(155deg,#22d3ee,#06b6d4);border-color:transparent;box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 4px 12px -6px rgba(6,182,212,.7)}
.rx-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.rx-toggle.on .rx-knob{transform:translateX(18px)}

/* Axon flow */
.rx-axon::before{background:linear-gradient(180deg,var(--c),var(--c2))}
.rx-flow{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.rx-flow-node{display:inline-grid;place-items:center;min-width:30px;height:22px;padding:0 7px;border-radius:7px;font-size:11px;font-weight:700;font-family:var(--mono,ui-monospace,monospace);color:#06202a;background:var(--n);background-image:linear-gradient(155deg,rgba(255,255,255,.4),rgba(0,0,0,.14));box-shadow:0 4px 10px -6px var(--n)}
.rx-flow-arrow svg{width:34px;height:11px;fill:none;stroke:var(--ink3);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rx-flow-names{font-size:11px;color:var(--ink2);margin-left:2px}

@media (prefers-reduced-motion:reduce){
  .rx-row,.rx-run,.rx-toggle,.rx-knob,.rx-tab,.rx-search input{transition:none}
}
@media (max-width:900px){
  .rx-head{flex-direction:column}
  .rx-runtotal{align-self:flex-start;text-align:left}
  .rx-stats{grid-template-columns:repeat(3,1fr)}
  .rx-controls{flex-direction:column;align-items:stretch}
  .rx-search{max-width:none}
  .rx-desc{white-space:normal}
}
`}</style>
  );
}
