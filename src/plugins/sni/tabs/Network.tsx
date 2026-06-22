/**
 * Network — U1's Axone & Reflexe map.
 *
 * MODEL: there is one agent (U1); everything else is a SKILL. This tab documents
 * how those skills are WIRED together:
 *   • AXONE  — the directed workflows between two skills (derived from each skill's
 *     `axone` array). Each connection carries a synthesized n8n-style pipeline.
 *   • REFLEXE — the automatic triggers a skill reacts to (each skill's `reflexe`).
 *
 * A segmented toggle switches the two views. A skill filter narrows the grid.
 * Clicking any card opens a rich glass detail modal (ESC + backdrop close,
 * slide-up): a numbered workflow timeline, tech-stack pills, the connected
 * skills as colored chips, a version + "zuletzt aktualisiert" line.
 *
 * Everything is derived/mock — no backend yet — and fully demoable offline.
 * Subunit Liquid Glass: glass over an aurora mesh, ONE cyan accent.
 */

import { useEffect, useMemo, useState } from "react";
import type { HostApi } from "../../../plugin/types";
import { AGENTS, orchestratorOf, skillsOf, type Agent } from "../agents";

// ════════════════════════════════════════════════════════════════════════
// Derivation helpers — synthesize rich, deterministic detail from the registry.
// ════════════════════════════════════════════════════════════════════════

/** Tiny deterministic hash so synthesized numbers are stable per seed (no flicker). */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
function pick<T>(arr: readonly T[], seed: string): T {
  return arr[hash(seed) % arr.length];
}
function ver(seed: string): string {
  const h = hash(seed);
  return `${1 + (h % 4)}.${(h >> 3) % 10}`;
}
/** A stable "zuletzt aktualisiert" date in the recent past, derived from the seed. */
function lastUpdated(seed: string): string {
  const days = hash(seed) % 21; // 0..20 days ago
  const d = new Date(Date.now() - days * 86400000);
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** Verb palette to synthesize a short workflow label for a from→to connection. */
const AXON_VERBS = ["routet", "synchronisiert", "übergibt", "speist", "triggert", "meldet", "reichert an für", "koordiniert mit"] as const;
/** Per-axon connection "type" — drives the colored type pill in the modal. */
const AXON_TYPES = ["data", "sync", "command", "query", "event", "logic"] as const;
const AXON_TYPE_LABEL: Record<string, string> = {
  data: "Datenfluss", sync: "Synchronisation", command: "Steuerung",
  query: "Abfrage", event: "Event", logic: "Logik",
};
/** Tech stacks U1 can wire together — sampled deterministically per axon. */
const TECH_POOL = ["n8n", "Webhook", "ChromaDB", "Redis Queue", "Supabase", "REST API", "IMAP", "SMTP", "OpenAI Embeddings", "Cron", "WebSocket", "Postgres"] as const;

/** Reflex category taxonomy (ported from the SNI cortex data shape). */
type ReflexCat = "event" | "system" | "telemetry" | "security" | "logic" | "data" | "sync";
const REFLEX_CAT_LABEL: Record<ReflexCat, string> = {
  event: "Event", system: "System", telemetry: "Telemetrie",
  security: "Security", logic: "Logik", data: "Daten", sync: "Sync",
};
const REFLEX_CAT_COLOR: Record<ReflexCat, string> = {
  event: "#38bdf8", system: "#fb923c", telemetry: "#2dd4bf",
  security: "#f87171", logic: "#a78bfa", data: "#fbbf24", sync: "#34d399",
};
/** Keyword → category mapping so a trigger name lands in a sensible bucket. */
function reflexCategory(trigger: string): ReflexCat {
  const t = trigger.toLowerCase();
  if (/(alert|cpu|memory|downtime|health|recovery|ping|restart|balanc)/.test(t)) return "system";
  if (/(report|kpi|anomal|spike|engagement)/.test(t)) return "telemetry";
  if (/(dsgvo|compliance|audit|spam|threat|eskalation|fehler|vertrag)/.test(t)) return "security";
  if (/(sync|update|cache)/.test(t)) return "sync";
  if (/(ingest|embedding|dokument|query|validierung)/.test(t)) return "data";
  if (/(threshold|score|check|konflikt|filter|routing|schedule|timer)/.test(t)) return "logic";
  return "event";
}
const REFLEX_FREQ = ["Echtzeit — bei jedem Event", "Event-basiert", "Alle 30 Sekunden", "Alle 60 Sekunden", "Täglich (Cron-Scan)", "Wöchentlich"] as const;
const REFLEX_PERM = [
  { perm: "auto", label: "AUTO", color: "#10b981" },
  { perm: "auto", label: "AUTO", color: "#10b981" },
  { perm: "ask", label: "ASK", color: "#f59e0b" },
] as const;

// ── Derived model shapes ──────────────────────────────────────────────────

interface AxonConn {
  id: string;            // "S-01→S-02"
  from: Agent;
  to: Agent;
  color: string;         // source-skill color
  type: string;          // AXON_TYPES
  label: string;         // synthesized one-line workflow
  longDesc: string;
  steps: { label: string; desc: string }[];
  tools: string[];
  version: string;
  updated: string;
  related: Agent[];      // skills touched by this pipeline
}

interface ReflexEntry {
  id: string;            // "S-04::Dokument-Ingest"
  skill: Agent;
  trigger: string;
  cat: ReflexCat;
  catColor: string;
  perm: { perm: string; label: string; color: string };
  action: string;
  frequency: string;
  longDesc: string;
  steps: { label: string; desc: string }[];
  tools: string[];
  version: string;
  updated: string;
  siblings: string[];    // other reflexe on the same skill
}

/** Build the unique directed skill→skill connections from every skill's `axone`. */
function buildAxone(byCode: Map<string, Agent>): AxonConn[] {
  const out: AxonConn[] = [];
  const seen = new Set<string>();
  for (const src of byCode.values()) {
    if (src.orchestrator) continue; // U1 is the hub, shown via related — not a card source
    for (const code of src.axone) {
      if (code === src.code) continue;
      const dst = byCode.get(code);
      if (!dst || dst.orchestrator) continue; // skip links into U1 itself
      const id = `${src.code}→${dst.code}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const seed = id;
      const verb = pick(AXON_VERBS, seed);
      const type = pick(AXON_TYPES, seed + "t");
      const nTools = 3 + (hash(seed + "n") % 2);
      const tools: string[] = [];
      for (let i = 0; tools.length < nTools && i < TECH_POOL.length * 2; i++) {
        const cand = TECH_POOL[(hash(seed + "tool" + i)) % TECH_POOL.length];
        if (!tools.includes(cand)) tools.push(cand);
      }
      if (!tools.includes("n8n")) tools[0] = "n8n";
      const related = [byCode.get("U1"), src, dst].filter(Boolean) as Agent[];
      out.push({
        id, from: src, to: dst, color: src.color, type,
        label: `${src.name} ${verb} ${dst.name}`,
        longDesc: `Diese Axon-Bahn verbindet ${src.name} (${src.role}) mit ${dst.name} (${dst.role}). Wenn ${src.name} ein relevantes Signal verarbeitet, wird der Kontext über U1 orchestriert und als ${AXON_TYPE_LABEL[type].toLowerCase()} an ${dst.name} weitergereicht — ohne manuelles Zutun. U1 überwacht die Bahn und eskaliert bei Fehlern via Auto-Recovery.`,
        steps: [
          { label: "Signal", desc: `${src.name} erkennt ein verwertbares Ereignis und normalisiert die Nutzdaten.` },
          { label: "Routing über U1", desc: `U1 prüft den Kontext, wählt die Ziel-Bahn und attached Metadaten (Tenant, Priorität).` },
          { label: AXON_TYPE_LABEL[type], desc: `Payload wird per ${tools[0]} an ${dst.name} übergeben (idempotent, mit Retry).` },
          { label: "Verarbeitung", desc: `${dst.name} (${dst.role}) übernimmt, sendet Heartbeats und verbucht das Ergebnis.` },
          { label: "Quittung", desc: `Status fließt an U1 zurück und wird in den Reflex-Log geschrieben.` },
        ],
        tools, version: ver(seed), updated: lastUpdated(seed), related,
      });
    }
  }
  // Sort: by source code then target code for a stable, scannable grid.
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Flatten every reflex across all skills into rich entries. */
function buildReflexe(skills: Agent[]): ReflexEntry[] {
  const out: ReflexEntry[] = [];
  for (const skill of skills) {
    for (const trigger of skill.reflexe) {
      const id = `${skill.code}::${trigger}`;
      const cat = reflexCategory(trigger);
      const perm = REFLEX_PERM[hash(id) % REFLEX_PERM.length];
      const freq = pick(REFLEX_FREQ, id);
      const nTools = 2 + (hash(id + "n") % 2);
      const tools: string[] = ["n8n"];
      for (let i = 0; tools.length < nTools + 1 && i < TECH_POOL.length * 2; i++) {
        const cand = TECH_POOL[(hash(id + "tl" + i)) % TECH_POOL.length];
        if (!tools.includes(cand)) tools.push(cand);
      }
      out.push({
        id, skill, trigger, cat, catColor: REFLEX_CAT_COLOR[cat], perm,
        action: `${skill.name} startet die ${REFLEX_CAT_LABEL[cat]}-Routine und verbucht das Ergebnis.`,
        frequency: freq,
        longDesc: `Der Reflex „${trigger}" feuert automatisch, sobald die Bedingung im ${skill.name}-Skill (${skill.role}) erfüllt ist. Er läuft ohne Bestätigung (${perm.label}), schreibt einen Audit-Eintrag und meldet das Resultat an U1. Reflexe sind die unterste, schnellste Reaktionsebene — sie greifen, bevor ein Axon-Workflow überhaupt anläuft.`,
        steps: [
          { label: "Trigger", desc: `Bedingung „${trigger}" wird im ${skill.name}-Skill erfüllt.` },
          { label: "Guard", desc: `Permission-Gate (${perm.label}) + Dedup-Check verhindern Doppel-Feuern.` },
          { label: "Aktion", desc: `${REFLEX_CAT_LABEL[cat]}-Routine läuft (${freq.toLowerCase()}).` },
          { label: "Log & Melden", desc: `Audit-Eintrag wird geschrieben, U1 erhält den Status.` },
        ],
        tools, version: ver(id), updated: lastUpdated(id),
        siblings: skill.reflexe.filter((r) => r !== trigger),
      });
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════
// Component
// ════════════════════════════════════════════════════════════════════════

type View = "axone" | "reflexe";

export default function NetworkTab({ host: _host }: { host: HostApi }) {
  const byCode = useMemo(() => new Map(AGENTS.map((a) => [a.code, a])), []);
  const u1 = useMemo(() => orchestratorOf(AGENTS), []);
  const skills = useMemo(() => skillsOf(AGENTS), []);
  const axone = useMemo(() => buildAxone(byCode), [byCode]);
  const reflexe = useMemo(() => buildReflexe(skills), [skills]);

  const [view, setView] = useState<View>("axone");
  const [filter, setFilter] = useState<Set<string>>(new Set()); // empty = all
  const [openAxon, setOpenAxon] = useState<AxonConn | null>(null);
  const [openReflex, setOpenReflex] = useState<ReflexEntry | null>(null);

  const toggleFilter = (code: string) =>
    setFilter((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  const matches = (code: string) => filter.size === 0 || filter.has(code);

  const shownAxone = useMemo(
    () => axone.filter((a) => matches(a.from.code) || matches(a.to.code)),
    [axone, filter],
  );
  const shownReflexe = useMemo(
    () => reflexe.filter((r) => matches(r.skill.code)),
    [reflexe, filter],
  );

  const autoCount = reflexe.filter((r) => r.perm.perm === "auto").length;

  return (
    <div className="nw">
      <NetworkStyle />

      {/* Header */}
      <div className="nw-head">
        <div>
          <h2>Netzwerk</h2>
          <p>
            Wie U1 seine Skills verdrahtet — <b>{axone.length} Axone</b> (Workflows){" "}
            &amp; <b>{reflexe.length} Reflexe</b> (Auto-Trigger).
          </p>
        </div>
        <div className="nw-kpis">
          <div className="nw-kpi"><b>{axone.length}</b><span>Axone</span></div>
          <div className="nw-kpi on"><b>{autoCount}</b><span>Auto-Reflexe</span></div>
          <div className="nw-kpi"><b>{skills.length}</b><span>Skills</span></div>
        </div>
      </div>

      {/* Segmented toggle */}
      <div className="nw-seg" role="tablist">
        <button
          role="tab" aria-selected={view === "axone"}
          className={`nw-seg-b${view === "axone" ? " on" : ""}`}
          onClick={() => setView("axone")}
        >
          Axone <span className="nw-seg-n">{shownAxone.length}</span>
        </button>
        <button
          role="tab" aria-selected={view === "reflexe"}
          className={`nw-seg-b${view === "reflexe" ? " on" : ""}`}
          onClick={() => setView("reflexe")}
        >
          Reflexe <span className="nw-seg-n">{shownReflexe.length}</span>
        </button>
        <span className="nw-seg-glide" data-v={view} />
      </div>

      {/* Skill filter */}
      <div className="nw-filter">
        <button
          className={`nw-chip${filter.size === 0 ? " on" : ""}`}
          onClick={() => setFilter(new Set())}
        >
          Alle
        </button>
        {skills.map((s) => (
          <button
            key={s.code}
            className={`nw-chip${filter.has(s.code) ? " on" : ""}`}
            style={{ "--c": s.color } as React.CSSProperties}
            onClick={() => toggleFilter(s.code)}
          >
            <span className="nw-chip-dot" />
            {s.name}
          </button>
        ))}
      </div>

      {/* AXONE grid */}
      {view === "axone" && (
        <div className="nw-grid">
          {shownAxone.map((a) => (
            <button
              key={a.id}
              className="nw-card"
              style={{ "--c": a.color } as React.CSSProperties}
              onClick={() => setOpenAxon(a)}
            >
              <div className="nw-card-top">
                <span className="nw-flow">
                  <span className="nw-node" style={{ "--c": a.from.color } as React.CSSProperties}>{a.from.code}</span>
                  <span className="nw-arrow">
                    <svg viewBox="0 0 40 8" preserveAspectRatio="none"><line x1="0" y1="4" x2="34" y2="4" /><path d="M30 1 L38 4 L30 7" /></svg>
                  </span>
                  <span className="nw-node" style={{ "--c": a.to.color } as React.CSSProperties}>{a.to.code}</span>
                </span>
                <span className="nw-type">{AXON_TYPE_LABEL[a.type]}</span>
              </div>
              <div className="nw-card-label">{a.label}</div>
              <div className="nw-card-foot">
                <span className="nw-pair">{a.from.name} → {a.to.name}</span>
                <span className="nw-ver">v{a.version}</span>
              </div>
            </button>
          ))}
          {shownAxone.length === 0 && <div className="nw-empty">Keine Axone für diese Auswahl.</div>}
        </div>
      )}

      {/* REFLEXE grid */}
      {view === "reflexe" && (
        <div className="nw-grid">
          {shownReflexe.map((r) => (
            <button
              key={r.id}
              className="nw-card nw-rx-card"
              style={{ "--c": r.skill.color } as React.CSSProperties}
              onClick={() => setOpenReflex(r)}
            >
              <div className="nw-card-top">
                <span className="nw-node" style={{ "--c": r.skill.color } as React.CSSProperties}>{r.skill.code}</span>
                <span className="nw-rx-cat" style={{ "--cc": r.catColor } as React.CSSProperties}>{REFLEX_CAT_LABEL[r.cat]}</span>
              </div>
              <div className="nw-card-label">{r.trigger}</div>
              <div className="nw-card-foot">
                <span className="nw-pair">{r.skill.name}</span>
                <span className={`nw-perm p-${r.perm.perm}`} style={{ "--pc": r.perm.color } as React.CSSProperties}>{r.perm.label}</span>
              </div>
            </button>
          ))}
          {shownReflexe.length === 0 && <div className="nw-empty">Keine Reflexe für diese Auswahl.</div>}
        </div>
      )}

      {openAxon && <AxonModal axon={openAxon} onClose={() => setOpenAxon(null)} />}
      {openReflex && <ReflexModal reflex={openReflex} u1={u1} onClose={() => setOpenReflex(null)} />}
    </div>
  );
}

// ── Detail modals ─────────────────────────────────────────────────────────

function useEsc(onClose: () => void) {
  useEffect(() => {
    const fn = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [onClose]);
}

function StepTimeline({ steps, color }: { steps: { label: string; desc: string }[]; color: string }) {
  return (
    <div className="nw-tl">
      {steps.map((s, i) => (
        <div key={i} className="nw-tl-row">
          {i < steps.length - 1 && <span className="nw-tl-line" />}
          <span className="nw-tl-num" style={{ "--c": color } as React.CSSProperties}>{i + 1}</span>
          <div className="nw-tl-tx">
            <div className="nw-tl-l">{s.label}</div>
            <div className="nw-tl-d">{s.desc}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillChip({ s }: { s: Agent }) {
  return (
    <span className="nw-skchip" style={{ "--c": s.color } as React.CSSProperties}>
      <span className="nw-skchip-orb">{s.code}</span>
      <span className="nw-skchip-tx">
        <b>{s.name}</b>
        <i>{s.role}</i>
      </span>
    </span>
  );
}

function AxonModal({ axon, onClose }: { axon: AxonConn; onClose: () => void }) {
  useEsc(onClose);
  return (
    <div className="nw-ov" onClick={onClose}>
      <div className="nw-modal" style={{ "--c": axon.color } as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
        <span className="nw-modal-glow" />
        <button className="nw-x" onClick={onClose} aria-label="Schließen">✕</button>

        <div className="nw-modal-h">
          <div className="nw-modal-pills">
            <span className="nw-mp">{axon.id}</span>
            <span className="nw-mp tint">{AXON_TYPE_LABEL[axon.type]}</span>
            <span className="nw-mp live"><i />aktiv</span>
          </div>
          <h3>{axon.label}</h3>
          <div className="nw-modal-sub">v{axon.version} · zuletzt aktualisiert {axon.updated}</div>
        </div>

        <div className="nw-modal-b">
          <section>
            <div className="nw-lbl" style={{ "--c": axon.color } as React.CSSProperties}>Beschreibung</div>
            <p className="nw-desc">{axon.longDesc}</p>
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": axon.color } as React.CSSProperties}>Workflow-Pipeline</div>
            <StepTimeline steps={axon.steps} color={axon.color} />
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": axon.color } as React.CSSProperties}>Tech-Stack</div>
            <div className="nw-pills">{axon.tools.map((t) => <span key={t} className="nw-pill">{t}</span>)}</div>
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": axon.color } as React.CSSProperties}>Verbundene Skills</div>
            <div className="nw-chips">{axon.related.map((s) => <SkillChip key={s.code} s={s} />)}</div>
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": axon.color } as React.CSSProperties}>n8n-Topologie</div>
            <div className="nw-n8n">
              <div className="nw-n8n-flow">
                {axon.steps.map((_, n) => (
                  <span key={n} className="nw-n8n-step" style={{ animationDelay: `${n * 0.18}s` }}>
                    {n < axon.steps.length - 1 && <span className="nw-n8n-link" />}
                  </span>
                ))}
              </div>
              <span className="nw-n8n-id" style={{ fontFamily: "var(--mono,ui-monospace,monospace)" }}>
                WORKFLOW: {axon.from.code.toLowerCase()}-{axon.to.code.toLowerCase()}-bridge
              </span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function ReflexModal({ reflex, u1, onClose }: { reflex: ReflexEntry; u1?: Agent; onClose: () => void }) {
  useEsc(onClose);
  const related = [u1, reflex.skill].filter(Boolean) as Agent[];
  return (
    <div className="nw-ov" onClick={onClose}>
      <div className="nw-modal" style={{ "--c": reflex.catColor } as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
        <span className="nw-modal-glow" />
        <button className="nw-x" onClick={onClose} aria-label="Schließen">✕</button>

        <div className="nw-modal-h">
          <div className="nw-modal-pills">
            <span className="nw-mp">Reflex</span>
            <span className="nw-mp tint">{REFLEX_CAT_LABEL[reflex.cat]}</span>
            <span className="nw-mp perm" style={{ "--pc": reflex.perm.color } as React.CSSProperties}>{reflex.perm.label}</span>
          </div>
          <h3>{reflex.trigger}</h3>
          <div className="nw-modal-sub">
            <span style={{ color: reflex.skill.color, fontWeight: 700 }}>{reflex.skill.code}</span> {reflex.skill.name} · v{reflex.version} · zuletzt aktualisiert {reflex.updated}
          </div>
        </div>

        <div className="nw-modal-b">
          <section>
            <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Beschreibung</div>
            <p className="nw-desc">{reflex.longDesc}</p>
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Mechanik</div>
            <div className="nw-mech">
              <InfoRow label="Trigger" value={reflex.trigger} accent="#f97316" />
              <InfoRow label="Aktion" value={reflex.action} accent="#10b981" />
              <InfoRow label="Frequenz" value={reflex.frequency} accent="#3b82f6" />
            </div>
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Ablauf</div>
            <StepTimeline steps={reflex.steps} color={reflex.catColor} />
          </section>

          <section>
            <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Tech-Stack</div>
            <div className="nw-pills">{reflex.tools.map((t) => <span key={t} className="nw-pill">{t}</span>)}</div>
          </section>

          {reflex.siblings.length > 0 && (
            <section>
              <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Weitere Reflexe von {reflex.skill.name}</div>
              <div className="nw-pills">
                {reflex.siblings.map((r) => <span key={r} className="nw-pill soft">{r}</span>)}
              </div>
            </section>
          )}

          <section>
            <div className="nw-lbl" style={{ "--c": reflex.catColor } as React.CSSProperties}>Verbundene Skills</div>
            <div className="nw-chips">{related.map((s) => <SkillChip key={s.code} s={s} />)}</div>
          </section>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="nw-irow">
      <span className="nw-irow-l" style={{ color: accent }}>{label}</span>
      <span className="nw-irow-v">{value}</span>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Scoped styles (prefix .nw-) — Subunit Liquid Glass, ONE cyan accent.
// ════════════════════════════════════════════════════════════════════════

function NetworkStyle() {
  return (
    <style>{`
.nw{display:flex;flex-direction:column;gap:16px}

.nw-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:2px}
.nw-head h2{font-size:22px;font-weight:600;letter-spacing:-.03em}
.nw-head p{font-size:13.5px;color:var(--ink2);margin-top:5px}
.nw-head b{color:var(--ink);font-weight:680}
.nw-kpis{flex:none;display:flex;gap:9px}
.nw-kpi{text-align:center;min-width:62px;padding:9px 13px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim)}
.nw-kpi.on{border-color:rgba(6,182,212,.35)}
.nw-kpi b{display:block;font-size:20px;font-weight:700;letter-spacing:-.02em}
.nw-kpi.on b{color:var(--cyan-d,#0891b2)}
.nw-kpi span{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}

/* Segmented toggle */
.nw-seg{position:relative;display:inline-flex;align-self:flex-start;gap:2px;padding:4px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim)}
.nw-seg-b{position:relative;z-index:1;display:inline-flex;align-items:center;gap:7px;padding:7px 18px;border:none;background:none;cursor:pointer;font-size:12.5px;font-weight:650;color:var(--ink3);border-radius:calc(var(--r-sm) - 4px);transition:color .25s}
.nw-seg-b.on{color:#06202a}
.nw-seg-n{font-size:10.5px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--fill-weak);color:inherit;font-family:var(--mono,ui-monospace,monospace)}
.nw-seg-b.on .nw-seg-n{background:rgba(0,0,0,.14)}
.nw-seg-glide{position:absolute;z-index:0;top:4px;bottom:4px;width:calc(50% - 5px);border-radius:calc(var(--r-sm) - 4px);background:linear-gradient(135deg,#22d3ee,#06b6d4);box-shadow:0 4px 14px -4px rgba(6,182,212,.6),inset 0 1px 0 rgba(255,255,255,.4);transition:transform .32s cubic-bezier(.2,.8,.2,1)}
.nw-seg-glide[data-v="axone"]{transform:translateX(0)}
.nw-seg-glide[data-v="reflexe"]{transform:translateX(calc(100% + 3px))}

/* Skill filter */
.nw-filter{display:flex;flex-wrap:wrap;gap:7px}
.nw-chip{display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);font-size:12px;font-weight:600;cursor:pointer;transition:border-color .18s,background .18s,transform .18s}
.nw-chip:hover{transform:translateY(-1px)}
.nw-chip-dot{width:8px;height:8px;border-radius:50%;background:var(--c,#06b6d4);box-shadow:0 0 6px var(--c,#06b6d4)}
.nw-chip.on{color:var(--ink);border-color:var(--c,#06b6d4);background:var(--glass);box-shadow:0 0 0 1px var(--c,#06b6d4) inset,var(--shadow-sm)}
.nw-chip:first-child .nw-chip-dot{display:none}
.nw-chip:first-child{padding-left:13px}

/* Card grid */
.nw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
.nw-card{position:relative;display:flex;flex-direction:column;gap:11px;padding:15px 16px;text-align:left;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.7);-webkit-backdrop-filter:blur(28px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);cursor:pointer;overflow:hidden;transition:transform .2s cubic-bezier(.2,.8,.2,1),box-shadow .2s}
.nw-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--c,#06b6d4);opacity:.85}
.nw-card:hover{transform:translateY(-3px);box-shadow:0 18px 40px -18px var(--c,#06b6d4),var(--shadow),inset 0 1px 0 var(--rim)}
.nw-card-top{display:flex;align-items:center;justify-content:space-between;gap:8px}
.nw-flow{display:inline-flex;align-items:center;gap:8px}
.nw-node{flex:none;display:inline-grid;place-items:center;min-width:34px;height:24px;padding:0 7px;border-radius:7px;font-family:var(--mono,ui-monospace,monospace);font-size:11px;font-weight:800;color:#06202a;background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.42),rgba(0,0,0,.32));box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.nw-arrow{display:inline-flex;width:34px;height:8px;color:var(--ink3)}
.nw-arrow svg{width:100%;height:100%}
.nw-arrow line,.nw-arrow path{stroke:currentColor;stroke-width:1.4;fill:none;stroke-linecap:round;stroke-linejoin:round}
.nw-type{flex:none;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink3);padding:3px 8px;border-radius:6px;background:var(--glass2);border:1px solid var(--line)}
.nw-rx-cat{flex:none;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--cc,#38bdf8);padding:3px 8px;border-radius:6px;background:var(--glass2);border:1px solid var(--line)}
.nw-card-label{font-size:14px;font-weight:650;letter-spacing:-.01em;line-height:1.35;color:var(--ink)}
.nw-rx-card .nw-card-label{font-family:var(--mono,ui-monospace,monospace);font-size:13px;font-weight:600}
.nw-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:9px;border-top:1px solid var(--line)}
.nw-pair{font-size:11.5px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nw-ver{flex:none;font-size:10.5px;font-weight:680;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}
.nw-perm{flex:none;font-size:9.5px;font-weight:800;letter-spacing:.06em;padding:2px 7px;border-radius:5px;font-family:var(--mono,ui-monospace,monospace);color:var(--pc,#10b981);background:var(--glass2);border:1px solid var(--line)}
.nw-empty{grid-column:1 / -1;padding:34px;text-align:center;font-size:13px;color:var(--ink3);border:1px dashed var(--line2,var(--line));border-radius:var(--r-sm)}

/* ── Modal ── */
.nw-ov{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(8,12,20,.42);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);animation:nw-fade .22s ease}
.nw-modal{position:relative;width:100%;max-width:620px;max-height:86vh;overflow-y:auto;border-radius:var(--r);background:var(--glass);backdrop-filter:blur(34px) saturate(1.8);-webkit-backdrop-filter:blur(34px) saturate(1.8);border:1px solid var(--glass-edge);box-shadow:0 40px 100px -30px rgba(0,0,0,.5),0 0 0 1px var(--rim) inset,0 0 80px -40px var(--c,#06b6d4);animation:nw-up .36s cubic-bezier(.2,.9,.25,1)}
.nw-modal-glow{position:absolute;top:-70px;right:-70px;width:240px;height:240px;border-radius:50%;background:radial-gradient(circle,var(--c,#06b6d4),transparent 68%);opacity:.16;pointer-events:none}
.nw-x{position:absolute;top:14px;right:14px;z-index:2;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);background:var(--glass2);color:var(--ink2);font-size:13px;cursor:pointer;transition:background .15s,color .15s}
.nw-x:hover{color:var(--ink);background:var(--fill-weak)}

.nw-modal-h{position:relative;padding:24px 26px 18px;border-bottom:1px solid var(--line)}
.nw-modal-pills{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:13px}
.nw-mp{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;font-family:var(--mono,ui-monospace,monospace);padding:3px 9px;border-radius:6px;color:var(--ink2);background:var(--glass2);border:1px solid var(--line)}
.nw-mp.tint{color:var(--c,#06b6d4);border-color:var(--c,#06b6d4);background:var(--fill-weak)}
.nw-mp.live{color:#0a9d63;border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.1)}
.nw-mp.live i{width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:nw-beat 1.8s ease-out infinite}
.nw-mp.perm{color:var(--pc,#10b981);border-color:var(--pc,#10b981);background:var(--fill-weak)}
.nw-modal-h h3{font-size:21px;font-weight:680;letter-spacing:-.025em;line-height:1.25;color:var(--ink)}
.nw-modal-sub{margin-top:7px;font-size:11.5px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

.nw-modal-b{padding:22px 26px 26px;display:flex;flex-direction:column;gap:22px}
.nw-modal-b section{display:block}
.nw-lbl{font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--c,#06b6d4);margin-bottom:11px}
.nw-desc{font-size:13px;line-height:1.7;color:var(--ink2)}

/* Timeline */
.nw-tl{display:flex;flex-direction:column}
.nw-tl-row{position:relative;display:flex;gap:13px;padding-bottom:16px}
.nw-tl-row:last-child{padding-bottom:0}
.nw-tl-line{position:absolute;left:13px;top:28px;bottom:0;width:2px;background:linear-gradient(to bottom,var(--c,#06b6d4),transparent);opacity:.4}
.nw-tl-num{flex:none;width:28px;height:28px;border-radius:50%;display:grid;place-items:center;font-family:var(--mono,ui-monospace,monospace);font-size:11px;font-weight:800;color:var(--c,#06b6d4);background:var(--glass2);border:2px solid var(--c,#06b6d4);position:relative;z-index:1}
.nw-tl-tx{padding-top:2px}
.nw-tl-l{font-size:13px;font-weight:680;color:var(--ink);margin-bottom:2px}
.nw-tl-d{font-size:12px;color:var(--ink3);line-height:1.55}

/* Pills */
.nw-pills{display:flex;flex-wrap:wrap;gap:7px}
.nw-pill{font-size:11px;font-weight:600;font-family:var(--mono,ui-monospace,monospace);padding:4px 11px;border-radius:7px;color:var(--ink2);background:var(--glass2);border:1px solid var(--line)}
.nw-pill.soft{font-family:inherit;color:var(--ink3)}

/* Mechanik info rows */
.nw-mech{display:flex;flex-direction:column;gap:8px}
.nw-irow{display:flex;gap:12px;padding:10px 13px;border-radius:var(--r-xs);background:var(--glass2);border:1px solid var(--line)}
.nw-irow-l{flex:none;min-width:74px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;font-family:var(--mono,ui-monospace,monospace);padding-top:1px}
.nw-irow-v{font-size:12.5px;color:var(--ink2);line-height:1.5}

/* Skill chips */
.nw-chips{display:flex;flex-wrap:wrap;gap:8px}
.nw-skchip{display:inline-flex;align-items:center;gap:9px;padding:7px 13px 7px 8px;border-radius:11px;background:var(--glass2);border:1px solid var(--line)}
.nw-skchip-orb{flex:none;display:grid;place-items:center;min-width:30px;height:24px;padding:0 6px;border-radius:7px;font-family:var(--mono,ui-monospace,monospace);font-size:10px;font-weight:800;color:#06202a;background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.42),rgba(0,0,0,.3));box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.nw-skchip-tx{display:flex;flex-direction:column;line-height:1.25}
.nw-skchip-tx b{font-size:12.5px;font-weight:680;color:var(--ink)}
.nw-skchip-tx i{font-size:10px;font-style:normal;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

/* n8n topology */
.nw-n8n{display:flex;flex-direction:column;align-items:center;gap:14px;padding:24px;border-radius:var(--r-sm);border:1px dashed var(--c,#06b6d4);background:var(--fill-weak)}
.nw-n8n-flow{display:flex;align-items:center}
.nw-n8n-step{position:relative;width:34px;height:34px;border-radius:9px;background:var(--c,#06b6d4);background-image:linear-gradient(155deg,rgba(255,255,255,.2),rgba(0,0,0,.4));border:1px solid var(--c,#06b6d4);box-shadow:inset 0 1px 0 rgba(255,255,255,.3);animation:nw-pulse 1.8s ease-in-out infinite}
.nw-n8n-link{position:absolute;left:100%;top:50%;width:18px;height:2px;transform:translateY(-50%);background:linear-gradient(to right,var(--c,#06b6d4),transparent)}
.nw-n8n-id{font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3)}

@keyframes nw-fade{from{opacity:0}to{opacity:1}}
@keyframes nw-up{from{opacity:0;transform:translateY(24px) scale(.97)}to{opacity:1;transform:none}}
@keyframes nw-beat{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 6px rgba(52,211,153,0)}}
@keyframes nw-pulse{0%,100%{opacity:.7;transform:scale(1)}50%{opacity:1;transform:scale(1.07)}}

@media (prefers-reduced-motion:reduce){
  .nw-card,.nw-chip,.nw-seg-glide,.nw-seg-b{transition:none}
  .nw-ov,.nw-modal,.nw-mp.live i,.nw-n8n-step{animation:none}
  .nw-card:hover,.nw-chip:hover{transform:none}
}
@media (max-width:900px){
  .nw-head{flex-direction:column}
  .nw-kpis{align-self:stretch}.nw-kpi{flex:1}
  .nw-seg{align-self:stretch}.nw-seg-b{flex:1;justify-content:center}
  .nw-grid{grid-template-columns:1fr}
  .nw-modal-h h3{font-size:18px}
}
`}</style>
  );
}
