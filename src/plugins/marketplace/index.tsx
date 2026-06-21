/**
 * Marketplace — the Subunit hub, à la Adobe Creative Cloud.
 *
 * Two kinds of "programs":
 *   · STANDALONE apps (Echo, Sonar) — their own native Mac apps. The card detects
 *     whether <App>.app is in /Applications (host.apps.status), fetches the newest
 *     GitHub release (host.apps.latest), and offers Installieren / Aktualisieren
 *     (one-click download+install into /Applications, with progress) and Öffnen
 *     (launch the real Mac app).
 *   · MODULES (Atlas, Synapse, Chat, Call) — surfaces that live inside Subunit.
 *     "Öffnen" just navigates the shell to that plugin.
 *
 * Permissions: apps (status/latest/open/install/onProgress), notifications. nav +
 * ui are ungated. Built entirely from Subunit Liquid Glass classes + tokens.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/></svg>`;

const Svg = (props: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

// ── catalogue ────────────────────────────────────────────────────────────────

interface StandaloneApp {
  id: string;
  name: string;
  tagline: string;
  appName: string; // /Applications/<appName>.app
  bundleId: string;
  repo: string; // owner/name (newest release lookup)
  icon: string; // inline SVG path(s), "|"-separated
}

interface ModuleApp {
  id: string;
  name: string;
  tagline: string;
  pluginId: string; // nav target
  icon: string;
}

const STANDALONE: StandaloneApp[] = [
  {
    id: "echo",
    name: "Echo",
    tagline: "Diktat & Meeting-Transkription",
    appName: "Echo",
    bundleId: "ai.subunit.echo",
    repo: "subunit-ai/echo-tauri",
    icon: "M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z|M5 11a7 7 0 0 0 14 0|M12 18v3",
  },
  {
    id: "sonar",
    name: "Sonar",
    tagline: "Eigenständige Subunit-App",
    appName: "Sonar",
    bundleId: "ai.subunit.sonar",
    repo: "subunit-ai/sonar-tauri",
    icon: "M12 12h.01|M8.5 8.5a5 5 0 0 1 7 0|M5.5 5.5a9 9 0 0 1 13 0|M8.5 15.5a5 5 0 0 0 7 0",
  },
];

const MODULES: ModuleApp[] = [
  {
    id: "atlas",
    name: "Atlas",
    tagline: "Wissens-Recherche mit Quellen",
    pluginId: "atlas",
    icon: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20|M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z",
  },
  {
    id: "synapse",
    name: "Synapse",
    tagline: "Wissens-Ingest — die Datenkrake",
    pluginId: "synapse",
    icon: "M12 5a3 3 0 1 0 0-.01|M5 12a3 3 0 1 0 0-.01|M19 12a3 3 0 1 0 0-.01|M12 8v3|M9.6 13.4 7 11.6|M14.4 13.4 17 11.6",
  },
  {
    id: "chat",
    name: "Chat",
    tagline: "u1 im Gespräch",
    pluginId: "chat",
    icon: "M21 11.5a8.4 8.4 0 0 1-12 7.6L3 21l1.9-5.8A8.4 8.4 0 1 1 21 11.5Z",
  },
  {
    id: "call",
    name: "Call",
    tagline: "Voice-Anrufe, live transkribiert",
    pluginId: "call",
    icon: "M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z",
  },
];

/** Compare dotted numeric versions. >0 if a newer than b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ── standalone app card ──────────────────────────────────────────────────────

type AppState =
  | "checking"
  | "available" // not installed, installable
  | "installed" // installed, up to date
  | "update" // installed, newer available
  | "installing"
  | "error"; // not installed + couldn't resolve a release

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
    const [s, rel] = await Promise.allSettled([
      host.apps.status(app.appName),
      host.apps.latest(app.repo),
    ]);
    if (!alive.current) return;
    const inst = s.status === "fulfilled" && s.value.installed;
    const instVer = s.status === "fulfilled" ? s.value.version : null;
    setInstalled(inst ? instVer : null);
    if (rel.status === "fulfilled") {
      setLatest(rel.value.version);
      dmgRef.current = rel.value.dmgUrl;
    }
    if (inst) {
      if (rel.status === "fulfilled" && instVer && cmpVersion(rel.value.version, instVer) > 0)
        setState("update");
      else setState("installed");
    } else if (rel.status === "fulfilled") {
      setState("available");
    } else {
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
  }, [host, app.appName, app.name, refresh]);

  const open = useCallback(() => {
    void host.apps.open(app.bundleId, app.appName).catch((e) => {
      setErr(e instanceof Error ? e.message : String(e));
    });
  }, [host, app.bundleId, app.appName]);

  const phaseLabel =
    phase === "mount"
      ? "Entpacke…"
      : phase === "install"
        ? "Installiere…"
        : phase === "done"
          ? "Fertig"
          : "Lade…";

  return (
    <div className="mk-card">
      <span className="mk-ic mk-ic-app">
        <Svg d={app.icon} />
      </span>
      <div className="mk-tx">
        <div className="mk-name">
          {app.name}
          <span className="mk-badge">App</span>
        </div>
        <div className="mk-tag">{app.tagline}</div>
        <div className="mk-meta">
          {state === "checking" && "…"}
          {state === "available" && `Version ${latest} · nicht installiert`}
          {state === "installed" && `Version ${installed} · aktuell`}
          {state === "update" && `${installed} → ${latest} verfügbar`}
          {state === "installing" && `${phaseLabel}${pct != null ? ` ${pct} %` : ""}`}
          {state === "error" && (err || "Fehler")}
        </div>
        {state === "installing" && (
          <div
            className="mk-prog"
            role="progressbar"
            aria-valuenow={pct ?? 0}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="mk-prog-fill" style={{ width: `${pct ?? 5}%` }} />
          </div>
        )}
      </div>
      <div className="mk-act">
        {state === "checking" && <span className="mk-spin" role="status" aria-label="Prüfe" />}
        {state === "available" && (
          <button className="btn btn-primary minibtn" onClick={() => void install()}>
            Installieren
          </button>
        )}
        {state === "update" && (
          <>
            <button className="btn btn-primary minibtn" onClick={() => void install()}>
              Aktualisieren
            </button>
            <button className="btn-ghost minibtn" onClick={open}>
              Öffnen
            </button>
          </>
        )}
        {state === "installed" && (
          <button className="btn btn-primary minibtn" onClick={open}>
            Öffnen
          </button>
        )}
        {state === "installing" && <span className="mk-spin" role="status" aria-label="Installiert" />}
        {state === "error" && (
          <button className="btn-ghost minibtn" onClick={() => void refresh()}>
            Erneut
          </button>
        )}
      </div>
    </div>
  );
}

// ── module card ──────────────────────────────────────────────────────────────

function ModuleCard({ host, mod }: { host: HostApi; mod: ModuleApp }) {
  return (
    <div className="mk-card">
      <span className="mk-ic mk-ic-mod">
        <Svg d={mod.icon} />
      </span>
      <div className="mk-tx">
        <div className="mk-name">
          {mod.name}
          <span className="mk-badge mk-badge-mod">Modul</span>
        </div>
        <div className="mk-tag">{mod.tagline}</div>
        <div className="mk-meta">In Subunit · sofort verfügbar</div>
      </div>
      <div className="mk-act">
        <button className="btn btn-primary minibtn" onClick={() => host.nav.navigate(mod.pluginId)}>
          Öffnen
        </button>
      </div>
    </div>
  );
}

// ── view ─────────────────────────────────────────────────────────────────────

function MarketplaceView({ host }: { host: HostApi }) {
  return (
    <div className="mk">
      <MarketStyle />
      <div className="mk-hero">
        <h1>Programme</h1>
        <p>
          Dein Subunit-Hub — Standalone-Apps installieren &amp; öffnen, interne
          Module direkt starten.
        </p>
      </div>

      <div className="sect">Standalone-Apps</div>
      <div className="mk-grid">
        {STANDALONE.map((a) => (
          <AppCard key={a.id} host={host} app={a} />
        ))}
      </div>

      <div className="sect">In Subunit</div>
      <div className="mk-grid">
        {MODULES.map((m) => (
          <ModuleCard key={m.id} host={host} mod={m} />
        ))}
      </div>
    </div>
  );
}

function MarketStyle() {
  return (
    <style>{`
.mk{width:100%;max-width:920px;margin:0 auto;padding:30px 24px 56px}
.mk-hero{padding:4px 2px 18px}
.mk-hero h1{font-size:27px;font-weight:600;letter-spacing:-.035em}
.mk-hero p{font-size:14px;color:var(--ink2);margin-top:7px;max-width:54ch;line-height:1.5}
.mk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:14px;margin-top:12px}
.mk-card{display:flex;align-items:center;gap:15px;padding:16px 17px;border-radius:var(--r-sm);background:var(--glass);border:1px solid var(--rim);box-shadow:var(--shadow),inset 0 1px 0 var(--rim);min-height:78px}
.mk-ic{flex:none;width:48px;height:48px;border-radius:14px;display:grid;place-items:center;box-shadow:inset 0 1px 0 var(--rim)}
.mk-ic svg{width:25px;height:25px}
.mk-ic-app{color:#fff;background:linear-gradient(155deg,#22d3ee,#06b6d4);box-shadow:0 10px 24px -12px rgba(6,182,212,.6),inset 0 1px 0 var(--rim-cta)}
.mk-ic-mod{color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1)}
.mk-tx{flex:1;min-width:0}
.mk-name{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:650;letter-spacing:-.01em}
.mk-badge{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:6px;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.12);border:1px solid rgba(6,182,212,.22)}
.mk-badge-mod{color:var(--ink3);background:var(--glass-2,rgba(120,120,128,.1));border-color:var(--rim)}
.mk-tag{font-size:12.5px;color:var(--ink2);margin-top:2px;line-height:1.4}
.mk-meta{font-size:11.5px;color:var(--ink3);margin-top:5px}
.mk-prog{margin-top:8px;width:100%;max-width:240px;height:6px;border-radius:999px;overflow:hidden;background:var(--glass-2,rgba(120,120,128,.16));box-shadow:inset 0 1px 0 var(--rim)}
.mk-prog-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#06b6d4);transition:width .25s ease}
.mk-act{flex:none;display:flex;align-items:center;gap:7px}
.mk-act .btn,.mk-act .btn-ghost{white-space:nowrap}
.mk-spin{width:20px;height:20px;border-radius:50%;border:2.2px solid var(--rim);border-top-color:var(--cyan);animation:mk-rot .7s linear infinite}
@keyframes mk-rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.mk-spin{animation-duration:1.6s}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "marketplace",
    name: "Programme",
    version: "1.0.0",
    description: "Hub — Apps installieren & Module öffnen.",
    icon: ICON,
    permissions: ["apps", "notifications"],
    nav: { section: "core", order: 0 },
    commands: [{ id: "open", title: "Open Marketplace" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<MarketplaceView host={host} />);
    offCmd = host.events.on("command:marketplace:open", () =>
      host.nav.navigate("marketplace")
    );
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
