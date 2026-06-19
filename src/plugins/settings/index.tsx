/**
 * Settings — app preferences + software update.
 *
 * Native Subunit Liquid Glass surface. Two concerns:
 *   · ABOUT  — the app identity + the currently installed version.
 *   · UPDATE — manual "check for updates" + manual "download & install",
 *              backed by host.updater (the Tauri minisign `latest.json`
 *              pipeline the shell ships). The shell also runs a background
 *              check every 3 h; we subscribe to its signal so an update found
 *              while Settings is open shows up live.
 *
 * Download/install is ALWAYS user-triggered — we never auto-install (high blast
 * radius). On install the process restarts, so install() never resolves.
 *
 * Permissions: "updater" (version/check/install/onAvailable). auth + ui are ungated.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account, HostApi, PluginModule } from "../../plugin/types";
import { SubunitMark } from "../../components/SubunitMark";

const ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const RELEASES_URL = "https://github.com/subunit-ai/subunit-desktop/releases";

const Svg = (props: { d: string }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {props.d.split("|").map((p, i) => (
      <path key={i} d={p} />
    ))}
  </svg>
);

type Phase = "checking" | "uptodate" | "available" | "installing" | "error";

function SettingsView({ host }: { host: HostApi }) {
  const [account, setAccount] = useState<Account>(host.auth.account());
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [phase, setPhase] = useState<Phase>("checking");
  const [err, setErr] = useState("");
  const [checkedAt, setCheckedAt] = useState<string>("");
  const alive = useRef(true);

  useEffect(() => host.auth.onChange(setAccount), [host]);

  const runCheck = useCallback(async () => {
    setPhase("checking");
    setErr("");
    try {
      const { current: cur, available } = await host.updater.check();
      if (!alive.current) return;
      if (cur) setCurrent(cur);
      setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
      if (available) {
        setNext(available);
        setPhase("available");
      } else {
        setPhase("uptodate");
      }
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [host]);

  const install = useCallback(async () => {
    setPhase("installing");
    setErr("");
    try {
      // On success the app downloads, installs and RESTARTS — this never resolves.
      await host.updater.install();
    } catch (e) {
      if (!alive.current) return;
      setErr(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [host]);

  // Mount: read the installed version immediately, then check the endpoint.
  // Subscribe to the shell's background check so a later find shows up live.
  useEffect(() => {
    alive.current = true;
    host.updater.version().then((v) => alive.current && v && setCurrent(v)).catch(() => {});
    void runCheck();
    const off = host.updater.onAvailable((v) => {
      if (!alive.current) return;
      setNext(v);
      // Don't clobber an in-flight manual check or an install — both resolve to
      // the correct state themselves (same release endpoint).
      setPhase((p) => (p === "installing" || p === "checking" ? p : "available"));
    });
    return () => {
      alive.current = false;
      off();
    };
  }, [host, runCheck]);

  const busy = phase === "checking" || phase === "installing";

  // ── status card content per phase ──
  let icon = <span className="set-spin" role="status" aria-label="Wird geladen" />;
  let head = "Suche nach Updates…";
  let sub = "Prüfe das Subunit-Release-Verzeichnis.";
  let action: ReactNode = null;
  let tone = "neutral";

  if (phase === "uptodate") {
    tone = "ok";
    icon = <Svg d="M20 6 9 17l-5-5" />;
    head = "Subunit Desktop ist aktuell";
    sub = `Installiert: v${current || "—"}${checkedAt ? ` · geprüft ${checkedAt}` : ""}`;
    action = (
      <button className="btn-ghost minibtn" disabled={busy} onClick={() => void runCheck()}>
        Erneut suchen
      </button>
    );
  } else if (phase === "available") {
    tone = "new";
    icon = <Svg d="M12 3v12|M7 10l5 5 5-5|M5 21h14" />;
    head = `Version v${next} ist verfügbar`;
    sub = `Du hast v${current || "—"}. Das Update wird heruntergeladen und installiert — die App startet danach automatisch neu.`;
    action = (
      <button className="btn btn-primary minibtn" disabled={busy} onClick={() => void install()}>
        <Svg d="M12 3v12|M7 10l5 5 5-5|M5 21h14" />
        Herunterladen &amp; installieren
      </button>
    );
  } else if (phase === "installing") {
    tone = "new";
    icon = <span className="set-spin" role="status" aria-label="Wird geladen" />;
    head = "Update wird installiert…";
    sub = `v${next} wird heruntergeladen und installiert. Die App startet gleich automatisch neu — bitte nicht schließen.`;
  } else if (phase === "error") {
    tone = "err";
    icon = <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />;
    head = "Update-Prüfung fehlgeschlagen";
    sub = err || "Unbekannter Fehler.";
    action = (
      <button className="btn-ghost minibtn" disabled={busy} onClick={() => void runCheck()}>
        Erneut versuchen
      </button>
    );
  }

  return (
    <div className="set">
      <SettingsStyle />

      {/* ── About ── */}
      <div className="set-hero card center">
        <span className="set-mark">
          <SubunitMark size={34} />
        </span>
        <h1 className="set-title">Subunit Desktop</h1>
        <span className="set-ver">{current ? `Version ${current}` : "Version …"}</span>
        <p className="set-sub">
          Unsere native Glass-Shell — Atlas, Synapse, Dashboard, Chat, Call und Echo
          in einer App, lokal auf dem Mac.
        </p>
        <div className="hint center set-acct">
          {account.logged_in
            ? `Angemeldet als ${account.email} · ${account.plan}`
            : "Nicht angemeldet — über die Account-Pille oben rechts."}
        </div>
      </div>

      {/* ── Software update ── */}
      <div className="sect">Software-Update</div>
      <div className={`set-upd card tone-${tone}`}>
        <span className="set-upd-ic">{icon}</span>
        <div className="set-upd-tx">
          <div className="set-upd-head">{head}</div>
          <div className="set-upd-sub">{sub}</div>
        </div>
        <div className="set-upd-act">{action}</div>
      </div>

      <button
        className="set-link"
        onClick={() => host.ui.openExternal(RELEASES_URL)}
      >
        Alle Releases &amp; Changelog ansehen
        <Svg d="M7 17 17 7|M7 7h10v10" />
      </button>
    </div>
  );
}

function SettingsStyle() {
  return (
    <style>{`
.set{width:100%;max-width:560px;margin:0 auto;padding:34px 24px 56px}
.set-hero{padding:36px 28px 28px}
.set-mark{display:grid;place-items:center;width:74px;height:74px;border-radius:22px;margin:0 auto 18px;color:var(--cyan);background:var(--glass-2,rgba(6,182,212,.07));box-shadow:inset 0 1px 0 var(--rim),0 14px 34px -16px rgba(6,182,212,.45)}
.set-title{font-size:27px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.set-ver{display:inline-block;margin:10px auto 0;padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.26)}
.set-sub{font-size:14px;color:var(--ink2);line-height:1.55;margin:13px auto 0;max-width:40ch}
.set-acct{margin-top:14px}
.set-upd{display:flex;align-items:center;gap:15px;padding:17px 18px;margin-top:14px}
.set-upd-ic{flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;color:var(--ink2);background:var(--glass-2,rgba(120,120,128,.08));box-shadow:inset 0 1px 0 var(--rim)}
.set-upd-ic svg{width:22px;height:22px}
.set-upd.tone-ok .set-upd-ic{color:#0a9d63;background:rgba(16,185,129,.12)}
.set-upd.tone-new .set-upd-ic{color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.13)}
.set-upd.tone-err .set-upd-ic{color:#dc2626;background:rgba(239,68,68,.12)}
.set-upd-tx{flex:1;min-width:0}
.set-upd-head{font-size:14.5px;font-weight:600;letter-spacing:-.01em}
.set-upd-sub{font-size:12.5px;color:var(--ink2);line-height:1.5;margin-top:3px}
.set-upd-act{flex:none}
.set-upd-act .btn,.set-upd-act .btn-ghost{white-space:nowrap}
.set-upd-act svg{width:15px;height:15px}
.set-spin{width:20px;height:20px;border-radius:50%;border:2.2px solid var(--rim);border-top-color:var(--cyan);animation:set-rot .7s linear infinite}
@keyframes set-rot{to{transform:rotate(360deg)}}
.set-link{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:16px;padding:11px;border:none;background:none;cursor:pointer;font:inherit;font-size:12.5px;font-weight:550;color:var(--ink3);transition:color .15s}
.set-link:hover{color:var(--cyan)}
.set-link svg{width:14px;height:14px}
@media (prefers-reduced-motion:reduce){.set-spin{animation-duration:1.6s}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "settings",
    name: "Einstellungen",
    version: "1.0.0",
    description: "App-Version, Updates suchen & installieren.",
    icon: ICON,
    permissions: ["updater"],
    nav: { section: "ops", order: 90 },
    commands: [
      { id: "open", title: "Open Settings" },
      { id: "update", title: "Nach Updates suchen" },
    ],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<SettingsView host={host} />);
    const go = () => host.nav.navigate("settings");
    const off1 = host.events.on("command:settings:open", go);
    const off2 = host.events.on("command:settings:update", go);
    offCmd = () => {
      off1();
      off2();
    };
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
