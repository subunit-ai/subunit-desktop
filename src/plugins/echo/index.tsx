/**
 * Echo — launcher for our voice/dictation + meeting product.
 *
 * A clean native Subunit Liquid Glass launcher. Echo is its own Tauri app; from
 * here we surface its modes and hand off (host.ui.openExternal to echo.subunit.ai
 * — opening the native app deep-link is a later host capability). On-system glass,
 * not a website embed.
 *
 * Permissions: none privileged (auth + ui are ungated).
 */

import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account, HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>`;

const ECHO_URL = "https://echo.subunit.ai";

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

interface Mode {
  id: string;
  tt: string;
  ds: string;
  icon: string;
}

const MODES: Mode[] = [
  {
    id: "dictate",
    tt: "Diktat",
    ds: "Überall tippen mit der Stimme — 99 Sprachen, auto-detect.",
    icon: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z|5 11a7 7 0 0 0 14 0|12 18v3",
  },
  {
    id: "meet",
    tt: "Meet",
    ds: "Meetings live transkribiert, Sprecher getrennt (Pod-Diarization).",
    icon: "M17 11a5 5 0 1 0-10 0|2 21a8 8 0 0 1 16 0|22 21a6 6 0 0 0-5-5.9",
  },
  {
    id: "notes",
    tt: "Notizen",
    ds: "Sprachnotizen mit Verlauf, cloud-synchronisiert.",
    icon: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z|14 2v6h6|9 13h6|9 17h4",
  },
];

function EchoView({ host }: { host: HostApi }) {
  const [account, setAccount] = useState<Account>(host.auth.account());
  useEffect(() => host.auth.onChange(setAccount), [host]);

  return (
    <div className="ec">
      <EchoStyle />

      <div className="ec-hero card">
        <div className="ec-hero-row">
          <span className="ec-orb">
            <span className="ec-ring" />
            <span className="ec-ring" />
            <span className="ec-ring" />
            <Svg d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z|5 11a7 7 0 0 0 14 0|12 18v3" />
          </span>
          <div className="ec-hero-tx">
            <h1 className="ec-title">Echo</h1>
            <p className="ec-sub">
              Unsere Stimme-zu-Text-Engine — Diktat überall, Meetings live, Notizen
              synchronisiert. Läuft als eigene native App.
            </p>
          </div>
        </div>

        <button
          className="btn btn-primary ec-cta"
          onClick={() => host.ui.openExternal(ECHO_URL)}
        >
          <svg className="stroke" viewBox="0 0 24 24">
            <path d="M7 17 17 7|7 7h10v10" />
          </svg>
          Echo öffnen
        </button>
        <div className="hint center ec-acct">
          {account.logged_in
            ? `Profil: ${account.email} · ${account.plan}`
            : "Nicht angemeldet — über die Account-Pille oben rechts."}
        </div>
      </div>

      <div className="sect">Modi</div>
      <div className="ec-modes">
        {MODES.map((m) => (
          <button
            key={m.id}
            className="ec-mode"
            onClick={() => host.ui.openExternal(`${ECHO_URL}/${m.id}`)}
          >
            <span className="ec-mode-ic">
              <Svg d={m.icon} />
            </span>
            <div className="ec-mode-tt">{m.tt}</div>
            <div className="ec-mode-ds">{m.ds}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function EchoStyle() {
  return (
    <style>{`
.ec{width:100%;max-width:760px;margin:0 auto;padding:34px 24px 56px}
.ec-hero{padding:28px 28px 26px}
.ec-hero-row{display:flex;align-items:center;gap:20px}
.ec-orb{position:relative;width:66px;height:66px;border-radius:50%;flex:none;display:grid;place-items:center;background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 16px 38px -14px rgba(6,182,212,.6),inset 0 1px 0 var(--rim-cta)}
.ec-orb svg{width:30px;height:30px;position:relative;z-index:1}
.ec-ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--cyan);opacity:0;animation:ec-ping 6s cubic-bezier(.2,.55,.35,1) infinite}
.ec-ring:nth-child(2){animation-delay:2s}
.ec-ring:nth-child(3){animation-delay:4s}
@keyframes ec-ping{0%{transform:scale(.85);opacity:.55}45%{opacity:.18}100%{transform:scale(2.4);opacity:0}}
.ec-hero-tx{min-width:0}
.ec-title{font-size:28px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.ec-sub{font-size:14px;color:var(--ink2);line-height:1.55;margin-top:8px;max-width:46ch}
.ec-cta{max-width:280px;margin:24px 0 0}
.ec-acct{margin-top:14px;text-align:left}

.ec-modes{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:14px}
@media(max-width:640px){.ec-modes{grid-template-columns:1fr}}
.ec-mode{text-align:left;background:var(--glass2);backdrop-filter:blur(22px) saturate(1.5);-webkit-backdrop-filter:blur(22px) saturate(1.5);border:1.5px solid var(--line);border-radius:var(--r-sm);padding:18px 16px;cursor:pointer;font-family:inherit;color:inherit;box-shadow:var(--shadow-sm);transition:transform .2s cubic-bezier(.2,.8,.2,1),border-color .2s,box-shadow .2s}
.ec-mode:hover{transform:translateY(-2px);border-color:rgba(6,182,212,.4);box-shadow:0 18px 36px -18px rgba(6,182,212,.4)}
.ec-mode:active{transform:scale(.99)}
.ec-mode-ic{width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(6,182,212,.11);color:var(--cyan-d);margin-bottom:12px}
.ec-mode-ic svg{width:22px;height:22px}
.ec-mode-tt{font-size:15px;font-weight:600;letter-spacing:-.012em}
.ec-mode-ds{font-size:12.5px;color:var(--ink2);margin-top:5px;line-height:1.42}
@media (prefers-reduced-motion:reduce){.ec-ring{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "echo",
    name: "Echo",
    version: "1.0.0",
    description: "Voice-to-text — dictation, meetings and notes.",
    icon: ICON,
    permissions: [],
    nav: { section: "comms", order: 2 },
    commands: [{ id: "open", title: "Go to Echo" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<EchoView host={host} />);
    offCmd = host.events.on("command:echo:open", () =>
      host.nav.navigate("echo")
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
