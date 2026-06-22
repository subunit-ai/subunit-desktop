/**
 * Marktplatz — the Subunit hub, à la Adobe Creative Cloud.
 *
 * A real store with a top segmented bar switching between three shelves:
 *   · PROGRAMME — standalone Mac apps (Echo, Sonar). Detect installed
 *     (host.apps.status), fetch newest release (host.apps.latest), one-click
 *     install/update into /Applications with progress, and launch the real app.
 *     Cards show the REAL app icon extracted from the installed bundle.
 *   · PLUGINS — the modules living inside Subunit (Cortex, Atlas, Synapse, Chat,
 *     Call, Echo, Dashboard). "Öffnen" navigates the shell to that plugin.
 *   · AGENTEN — the SNI agent-skill catalogue (Sentinel, Memory Agent, Architect,
 *     Pulse, …): what a customer can add to their agent network. Status + price +
 *     features; activation wires to the backend later.
 *
 * Permissions: apps (status/latest/open/install/onProgress), notifications. nav +
 * ui ungated. Built entirely from Subunit Liquid Glass classes + tokens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><path d="M3 9h18M9 9v12M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/></svg>`;

const Svg = (props: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

// ── catalogues ───────────────────────────────────────────────────────────────

interface StandaloneApp {
  id: string;
  name: string;
  tagline: string;
  appName: string;
  bundleId: string;
  repo: string;
  iconImg: string; // real bundle icon
}

interface ModuleApp {
  id: string;
  name: string;
  tagline: string;
  pluginId: string;
  icon: string;
  accent: string;
}

const STANDALONE: StandaloneApp[] = [
  { id: "echo", name: "Echo", tagline: "Diktat & Meeting-Transkription", appName: "Echo", bundleId: "ai.subunit.echo", repo: "subunit-ai/echo-tauri", iconImg: "/app-echo.png" },
  { id: "sonar", name: "Sonar", tagline: "Eigenständige Subunit-App", appName: "Sonar", bundleId: "ai.subunit.sonar", repo: "subunit-ai/sonar-tauri", iconImg: "/app-sonar.png" },
];

const MODULES: ModuleApp[] = [
  { id: "sni", name: "SNI", tagline: "Neural Interface — U1 und seine Skills", pluginId: "sni", accent: "#06b6d4", icon: "M12 5a3 3 0 1 0-2.6-4.5|M12 9.6v2.4|M10 11 6.9 8.6|M14 11l3.1-2.4" },
  { id: "atlas", name: "Atlas", tagline: "Wissens-Recherche mit Quellen", pluginId: "atlas", accent: "#fbbf24", icon: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20|M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" },
  { id: "synapse", name: "Synapse", tagline: "Wissens-Ingest — die Datenkrake", pluginId: "synapse", accent: "#06b6d4", icon: "M12 5a3 3 0 1 0 0-.01|M5 12a3 3 0 1 0 0-.01|M19 12a3 3 0 1 0 0-.01|M12 8v3|M9.6 13.4 7 11.6|M14.4 13.4 17 11.6" },
  { id: "dashboard", name: "Dashboard", tagline: "Ops-Board — Aufgaben & Terminals", pluginId: "dashboard", accent: "#36d399", icon: "M3 3h7v9H3z|M14 3h7v5h-7z|M14 12h7v9h-7z|M3 16h7v5H3z" },
  { id: "chat", name: "Chat", tagline: "u1 im Gespräch", pluginId: "chat", accent: "#a78bfa", icon: "M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z" },
  { id: "call", name: "Call", tagline: "Voice-Anrufe, live transkribiert", pluginId: "call", accent: "#38bdf8", icon: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" },
  { id: "echo", name: "Echo", tagline: "Diktat in Subunit", pluginId: "echo", accent: "#22d3ee", icon: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z|M5 11a7 7 0 0 0 14 0|M12 18v3" },
];

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── PROGRAMME: standalone app card ───────────────────────────────────────────
type AppState = "checking" | "available" | "installed" | "update" | "installing" | "error";

function AppCard({ host, app }: { host: HostApi; app: StandaloneApp }) {
  const [state, setState] = useState<AppState>("checking");
  const [installed, setInstalled] = useState<string | null>(null);
  const [latest, setLatest] = useState<string>("");
  const dmgRef = useRef<string>("");
  const [pct, setPct] = useState<number | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [err, setErr] = useState<string>("");
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    setErr("");
    const [s, rel] = await Promise.allSettled([host.apps.status(app.appName), host.apps.latest(app.repo)]);
    if (!alive.current) return;
    const inst = s.status === "fulfilled" && s.value.installed;
    const instVer = s.status === "fulfilled" ? s.value.version : null;
    setInstalled(inst ? instVer : null);
    if (rel.status === "fulfilled") {
      setLatest(rel.value.version);
      dmgRef.current = rel.value.dmgUrl;
    }
    if (inst) {
      if (rel.status === "fulfilled" && instVer && cmpVersion(rel.value.version, instVer) > 0) setState("update");
      else setState("installed");
    } else if (rel.status === "fulfilled") setState("available");
    else {
      setErr("Release nicht erreichbar");
      setState("error");
    }
  }, [host, app.appName, app.repo]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const off = host.apps.onProgress(app.appName, (p, ph) => {
      if (!alive.current) return;
      setPct(p);
      setPhase(ph);
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [host, app.appName, refresh]);

  const install = useCallback(async () => {
    if (!dmgRef.current) return;
    setState("installing");
    setPct(0);
    setPhase("download");
    setErr("");
    try {
      await host.apps.install(dmgRef.current, app.appName, app.bundleId);
      if (!alive.current) return;
      host.notifications.notify("Installiert", `${app.name} ist bereit.`);
      await refresh();
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
      setState("error");
    }
  }, [host, app.appName, app.bundleId, app.name, refresh]);

  const open = useCallback(() => {
    void host.apps.open(app.bundleId, app.appName).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [host, app.bundleId, app.appName]);

  const phaseLabel = phase === "mount" ? "Entpacke…" : phase === "install" ? "Installiere…" : phase === "done" ? "Fertig" : "Lade…";

  return (
    <div className="mk-card">
      <span className="mk-ic mk-ic-img"><img src={app.iconImg} alt="" /></span>
      <div className="mk-tx">
        <div className="mk-name">{app.name}<span className="mk-badge">App</span></div>
        <div className="mk-tag">{app.tagline}</div>
        <div className="mk-meta">
          {state === "checking" && "Prüfe…"}
          {state === "available" && `Version ${latest} · nicht installiert`}
          {state === "installed" && `Version ${installed} · aktuell`}
          {state === "update" && `${installed} → ${latest} verfügbar`}
          {state === "installing" && `${phaseLabel}${pct != null ? ` ${pct} %` : ""}`}
          {state === "error" && (err || "Fehler")}
        </div>
        {state === "installing" && (
          <div className="mk-prog" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <span className="mk-prog-fill" style={{ width: `${pct ?? 5}%` }} />
          </div>
        )}
      </div>
      <div className="mk-act">
        {state === "checking" && <span className="mk-spin" role="status" aria-label="Prüfe" />}
        {state === "available" && <button className="btn btn-primary minibtn" onClick={() => void install()}>Installieren</button>}
        {state === "update" && (
          <>
            <button className="btn btn-primary minibtn" onClick={() => void install()}>Aktualisieren</button>
            <button className="btn-ghost minibtn" onClick={open}>Öffnen</button>
          </>
        )}
        {state === "installed" && <button className="btn btn-primary minibtn" onClick={open}>Öffnen</button>}
        {state === "installing" && <span className="mk-spin" role="status" aria-label="Installiert" />}
        {state === "error" && <button className="btn-ghost minibtn" onClick={() => void refresh()}>Erneut</button>}
      </div>
    </div>
  );
}

// ── PLUGINS: module card ─────────────────────────────────────────────────────
function ModuleCard({ host, mod }: { host: HostApi; mod: ModuleApp }) {
  return (
    <div className="mk-card">
      <span className="mk-ic mk-ic-mod" style={{ "--a": mod.accent } as React.CSSProperties}><Svg d={mod.icon} /></span>
      <div className="mk-tx">
        <div className="mk-name">{mod.name}<span className="mk-badge mk-badge-mod">Plugin</span></div>
        <div className="mk-tag">{mod.tagline}</div>
        <div className="mk-meta">In Subunit · sofort verfügbar</div>
      </div>
      <div className="mk-act">
        <button className="btn btn-primary minibtn" onClick={() => host.nav.navigate(mod.pluginId)}>Öffnen</button>
      </div>
    </div>
  );
}

// ── view ─────────────────────────────────────────────────────────────────────
type Tab = "programme" | "plugins";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "programme", label: "Programme", hint: "Standalone-Apps für deinen Mac" },
  { id: "plugins", label: "Plugins", hint: "Module direkt in Subunit" },
];

function MarketView({ host }: { host: HostApi }) {
  const [tab, setTab] = useState<Tab>("programme");
  const active = TABS.find((t) => t.id === tab)!;

  return (
    <div className="mk">
      <MarketStyle />
      <div className="mk-hero">
        <h1>Marktplatz</h1>
        <p>Standalone-Apps installieren und Subunit-Module öffnen. <span style={{ opacity: 0.7 }}>Skills für U1 findest du im SNI.</span></p>
      </div>

      <div className="mk-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`mk-tab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="mk-tabhint">{active.hint}</div>

      <div className="mk-grid">
        {tab === "programme" && STANDALONE.map((a) => <AppCard key={a.id} host={host} app={a} />)}
        {tab === "plugins" && MODULES.map((m) => <ModuleCard key={m.id} host={host} mod={m} />)}
      </div>
    </div>
  );
}

function MarketStyle() {
  return (
    <style>{`
.mk{width:100%;max-width:940px;margin:0 auto;padding:30px 24px 56px}
.mk-hero{padding:4px 2px 16px}
.mk-hero h1{font-size:27px;font-weight:600;letter-spacing:-.035em}
.mk-hero p{font-size:14px;color:var(--ink2);margin-top:7px;max-width:56ch;line-height:1.5}

.mk-tabs{display:inline-flex;padding:4px;border-radius:13px;background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim)}
.mk-tab{border:none;background:none;padding:8px 20px;border-radius:9px;font:inherit;font-size:13.5px;font-weight:600;color:var(--ink2);cursor:pointer;transition:.16s}
.mk-tab:hover{color:var(--ink)}
.mk-tab.on{background:var(--glass);color:var(--ink);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim)}
.mk-tabhint{font-size:12px;color:var(--ink3);margin:10px 2px 4px;letter-spacing:.01em}

.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(390px,1fr));gap:14px;margin-top:10px}
.mk-card{display:flex;align-items:center;gap:15px;padding:16px 17px;border-radius:var(--r-sm);background:var(--glass);backdrop-filter:blur(28px) saturate(1.7);-webkit-backdrop-filter:blur(28px) saturate(1.7);border:1px solid var(--glass-edge);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);min-height:80px}
.mk-skill{align-items:flex-start}

.mk-ic{flex:none;width:52px;height:52px;border-radius:14px;display:grid;place-items:center;box-shadow:inset 0 1px 0 var(--rim)}
.mk-ic-img{padding:0;overflow:hidden;box-shadow:0 8px 20px -10px rgba(0,0,0,.5)}
.mk-ic-img img{width:52px;height:52px;object-fit:cover;border-radius:14px;display:block}
.mk-ic-mod{color:var(--a,var(--cyan));background:var(--glass2);border:1px solid var(--line)}
.mk-ic-mod svg{width:25px;height:25px;filter:drop-shadow(0 2px 6px var(--a))}
.mk-ic-skill{font-size:26px;background:var(--glass2);border:1px solid var(--line)}

.mk-tx{flex:1;min-width:0}
.mk-name{display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:650;letter-spacing:-.01em}
.mk-code{font-size:10.5px;font-weight:700;font-family:var(--mono,ui-monospace,monospace);color:var(--ink3)}
.mk-badge{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:6px;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.22)}
.mk-badge-mod{color:var(--ink3);background:var(--glass2);border-color:var(--rim)}
.mk-st-ok{color:#0a9d63;background:rgba(16,185,129,.12);border-color:rgba(16,185,129,.25)}
.mk-st-dev{color:#b7791f;background:rgba(251,191,36,.12);border-color:rgba(251,191,36,.25)}
.mk-st-plan{color:var(--ink3);background:var(--glass2);border-color:var(--rim)}
.mk-tag{font-size:12.5px;color:var(--ink2);margin-top:3px;line-height:1.45}
.mk-meta{font-size:11.5px;color:var(--ink3);margin-top:5px}
.mk-feats{display:flex;flex-wrap:wrap;gap:5px;margin-top:9px}
.mk-feat{font-size:10.5px;font-weight:550;padding:3px 8px;border-radius:999px;background:var(--glass2);border:1px solid var(--line);color:var(--ink2)}

.mk-prog{margin-top:8px;width:100%;max-width:240px;height:6px;border-radius:999px;overflow:hidden;background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim)}
.mk-prog-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#06b6d4);transition:width .25s ease}

.mk-act{flex:none;display:flex;align-items:center;gap:7px}
.mk-act-col{flex-direction:column;align-items:flex-end;gap:8px}
.mk-act .btn,.mk-act .btn-ghost{white-space:nowrap}
.mk-price{font-size:13px;font-weight:680;color:var(--ink);letter-spacing:-.01em}
.mk-soon{font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);padding:4px 10px;border-radius:999px;background:var(--glass2);border:1px solid var(--line)}
.mk-spin{width:20px;height:20px;border-radius:50%;border:2.2px solid var(--line);border-top-color:var(--cyan);animation:mk-rot .7s linear infinite}
@keyframes mk-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mk-spin{animation-duration:1.6s}.mk-tab,.mk-prog-fill{transition:none}}
@media (max-width:860px){.mk-grid{grid-template-columns:1fr}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "marketplace",
    name: "Marktplatz",
    version: "1.1.0",
    description: "Programme & Plugins — Apps und Module.",
    icon: ICON,
    permissions: ["apps", "notifications"],
    nav: { section: "core", order: 0 },
    commands: [{ id: "open", title: "Open Marktplatz" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<MarketView host={host} />);
    offCmd = host.events.on("command:marketplace:open", () => host.nav.navigate("marketplace"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
