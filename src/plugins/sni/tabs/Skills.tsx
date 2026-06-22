/**
 * Skills — U1's capabilities.
 *
 * MODEL: there is one agent (U1); everything else is a SKILL you add to it.
 * This tab shows U1's ACTIVE skills (grouped by category) plus a marketplace of
 * skills you can ADD. Static/mock for now (toggle + add wire to the backend
 * later); fully demoable offline.
 */

import { useMemo, useState } from "react";
import type { HostApi } from "../../../plugin/types";
import {
  AGENTS,
  AVAILABLE_SKILLS,
  TIER_CONFIG,
  skillsOf,
  type AvailableSkill,
  type Tier,
} from "../agents";

const STATUS_LABEL: Record<string, string> = { running: "Aktiv", idle: "Bereit", stopped: "Aus", error: "Fehler" };

const ADD_STATUS: Record<AvailableSkill["status"], { label: string; cls: string; cta: string | null }> = {
  ready: { label: "Verfügbar", cls: "ok", cta: "Hinzufügen" },
  available: { label: "Auf Anfrage", cls: "ok", cta: "Anfragen" },
  development: { label: "In Entwicklung", cls: "dev", cta: null },
  planned: { label: "Geplant", cls: "plan", cta: null },
};

export default function SkillsTab({ host }: { host: HostApi }) {
  const skills = useMemo(() => skillsOf(AGENTS), []);
  const active = skills.filter((s) => s.status === "running").length;

  const byCat = useMemo(() => {
    return (Object.keys(TIER_CONFIG) as Tier[]).map((cat) => ({
      cat,
      ...TIER_CONFIG[cat],
      items: skills.filter((s) => s.tier === cat),
    })).filter((g) => g.items.length > 0);
  }, [skills]);

  const [adding, setAdding] = useState<string | null>(null);
  const add = (sk: AvailableSkill) => {
    setAdding(sk.code);
    host.notifications.notify(`${sk.name}`, "Skill wird mit U1 verbunden — Anbindung kommt bald.");
    window.setTimeout(() => setAdding(null), 1400);
  };

  return (
    <div className="sk">
      <SkillsStyle />

      <div className="sk-head">
        <div>
          <h2>U1 · Skills</h2>
          <p>U1 hat <b>{skills.length} Skills</b> — {active} aktiv. Skills erweitern, was U1 kann.</p>
        </div>
        <div className="sk-count"><b>{active}</b><span>aktiv</span></div>
      </div>

      {byCat.map((g) => (
        <div key={g.cat} className="sk-group">
          <div className="sk-group-h"><span className="sk-cat-dot" style={{ background: g.color }} />{g.label}<span className="sk-group-n">{g.items.length}</span></div>
          <div className="sk-grid">
            {g.items.map((s) => (
              <div key={s.code} className={`sk-card${s.status !== "running" ? " off" : ""}`} style={{ "--c": s.color } as React.CSSProperties}>
                <span className="sk-led" />
                <div className="sk-tx">
                  <div className="sk-name">{s.name}</div>
                  <div className="sk-role">{s.role}</div>
                </div>
                <div className="sk-meta">
                  <span className={`sk-st st-${s.status}`}>{STATUS_LABEL[s.status] ?? s.status}</span>
                  {s.status === "running" && <span className="sk-load">{s.cpu}%</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="sk-sect">Skills hinzufügen</div>
      <div className="sk-add-grid">
        {AVAILABLE_SKILLS.map((sk) => {
          const st = ADD_STATUS[sk.status];
          return (
            <div key={sk.code} className="sk-add">
              <span className="sk-add-ic">{sk.emoji}</span>
              <div className="sk-add-tx">
                <div className="sk-add-name">{sk.name}<span className={`sk-add-badge ${st.cls}`}>{st.label}</span></div>
                <div className="sk-add-desc">{sk.desc}</div>
                <div className="sk-add-abil">{sk.abilities.map((a) => <span key={a}>{a}</span>)}</div>
              </div>
              <div className="sk-add-act">
                <span className="sk-add-price">{sk.price}</span>
                {st.cta ? (
                  <button className="btn btn-primary minibtn" disabled={adding === sk.code} onClick={() => add(sk)}>
                    {adding === sk.code ? "…" : st.cta}
                  </button>
                ) : <span className="sk-soon">bald</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SkillsStyle() {
  return (
    <style>{`
.sk{display:flex;flex-direction:column;gap:16px}
.sk-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:2px}
.sk-head h2{font-size:22px;font-weight:600;letter-spacing:-.03em}
.sk-head p{font-size:13.5px;color:var(--ink2);margin-top:5px}
.sk-head b{color:var(--ink);font-weight:680}
.sk-count{flex:none;text-align:center;padding:10px 18px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow-sm)}
.sk-count b{display:block;font-size:24px;font-weight:700;color:var(--cyan-d,#0891b2);letter-spacing:-.02em}
.sk-count span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink3)}

.sk-group-h{display:flex;align-items:center;gap:9px;font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:6px 2px 10px}
.sk-cat-dot{width:9px;height:9px;border-radius:50%}
.sk-group-n{font-size:11px;color:var(--ink3);font-weight:600}
.sk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:11px}
.sk-card{display:flex;align-items:center;gap:12px;padding:14px 15px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(26px) saturate(1.6);-webkit-backdrop-filter:blur(26px) saturate(1.6);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);transition:transform .2s cubic-bezier(.2,.8,.2,1)}
.sk-card:hover{transform:translateY(-2px)}
.sk-card.off{opacity:.62}
.sk-led{flex:none;width:9px;height:9px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.sk-card.off .sk-led{background:var(--ink3);box-shadow:none}
.sk-tx{flex:1;min-width:0}
.sk-name{font-size:14.5px;font-weight:650;letter-spacing:-.01em}
.sk-role{font-size:12px;color:var(--ink2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sk-meta{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:3px}
.sk-st{font-size:10.5px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--ink3);background:var(--glass2)}
.sk-st.st-running{color:#0a9d63;border-color:rgba(16,185,129,.3);background:rgba(16,185,129,.1)}
.sk-st.st-idle{color:#b7791f;border-color:rgba(251,191,36,.3);background:rgba(251,191,36,.1)}
.sk-load{font-size:11px;font-weight:680;color:var(--ink2);font-family:var(--mono,ui-monospace,monospace)}

.sk-sect{font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:12px 2px 2px;padding-top:14px;border-top:1px solid var(--line)}
.sk-add-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:12px}
.sk-add{display:flex;align-items:flex-start;gap:13px;padding:15px 16px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.sk-add-ic{flex:none;width:46px;height:46px;border-radius:13px;display:grid;place-items:center;font-size:23px;background:var(--glass2);border:1px solid var(--line)}
.sk-add-tx{flex:1;min-width:0}
.sk-add-name{display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:650}
.sk-add-badge{font-size:9.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;padding:2px 7px;border-radius:6px;border:1px solid var(--rim)}
.sk-add-badge.ok{color:#0a9d63;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.25)}
.sk-add-badge.dev{color:#b7791f;background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.25)}
.sk-add-badge.plan{color:var(--ink3);background:var(--glass2)}
.sk-add-desc{font-size:12.5px;color:var(--ink2);margin-top:3px;line-height:1.45}
.sk-add-abil{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.sk-add-abil span{font-size:10.5px;font-weight:550;padding:3px 8px;border-radius:999px;background:var(--glass2);border:1px solid var(--line);color:var(--ink2)}
.sk-add-act{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:8px}
.sk-add-price{font-size:13px;font-weight:680;letter-spacing:-.01em}
.sk-soon{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:4px 10px;border-radius:999px;background:var(--glass2);border:1px solid var(--line)}
@media (prefers-reduced-motion:reduce){.sk-card{transition:none}}
@media (max-width:900px){.sk-add-grid{grid-template-columns:1fr}}
`}</style>
  );
}
