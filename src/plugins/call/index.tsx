/**
 * Call — call.subunit.ai launcher.
 *
 * A clean native Subunit Liquid Glass launcher card for our calling surface.
 * It opens call.subunit.ai in the browser (host.ui.openExternal) and shows what
 * the embedded experience will become. No iframe, no website bits merged in —
 * real on-system chrome.
 *
 * Permissions: none privileged (auth + ui are ungated).
 */

import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account, HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><path d="M15.5 10.5a6 6 0 0 0-2-2M18 8a10 10 0 0 0-2-2"/><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/></svg>`;

const CALL_URL = "https://call.subunit.ai";

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

const FEATURES: { icon: string; tt: string; ds: string }[] = [
  {
    icon: "M12 2a4 4 0 0 0-4 4v6a4 4 0 0 0 8 0V6a4 4 0 0 0-4-4Z|5 11a7 7 0 0 0 14 0|12 18v3",
    tt: "Voice-first",
    ds: "Glasklare Anrufe direkt aus dem Desktop.",
  },
  {
    icon: "M3 12h4l3 8 4-16 3 8h4",
    tt: "Live-Transkript",
    ds: "Echo schreibt mit — Sprecher getrennt.",
  },
  {
    icon: "M9 11l3 3 8-8|21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
    tt: "Action Items",
    ds: "Aufgaben landen automatisch im Ops Board.",
  },
];

function CallView({ host }: { host: HostApi }) {
  const [account, setAccount] = useState<Account>(host.auth.account());
  useEffect(() => host.auth.onChange(setAccount), [host]);

  return (
    <div className="cl">
      <CallStyle />

      <div className="cl-hero card center">
        <span className="cl-orb">
          <Svg d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />
          <span className="cl-ring" />
          <span className="cl-ring" />
        </span>
        <h1 className="cl-title">Call</h1>
        <p className="cl-sub">
          Unsere Anruf-Lane — voice-first, live transkribiert, mit Action-Items im
          Ops Board. Läuft auf call.subunit.ai.
        </p>

        <button
          className="btn btn-primary cl-cta"
          onClick={() => host.ui.openExternal(CALL_URL)}
        >
          <svg className="stroke" viewBox="0 0 24 24">
            <path d="M7 17 17 7|7 7h10v10" />
          </svg>
          call.subunit.ai öffnen
        </button>
        <div className="hint center cl-acct">
          {account.logged_in
            ? `Angemeldet als ${account.email}`
            : "Nicht angemeldet — über die Account-Pille oben rechts."}
        </div>
      </div>

      <div className="sect">Was kommt</div>
      <div className="stack cl-feats">
        {FEATURES.map((f) => (
          <div className="action alt cl-feat" key={f.tt}>
            <span className="ic">
              <Svg d={f.icon} />
            </span>
            <span className="tx">
              <div className="tt">{f.tt}</div>
              <div className="ds">{f.ds}</div>
            </span>
            <span className="pill wait">bald</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CallStyle() {
  return (
    <style>{`
.cl{width:100%;max-width:560px;margin:0 auto;padding:34px 24px 56px}
.cl-hero{padding:38px 28px 30px}
.cl-orb{position:relative;width:74px;height:74px;border-radius:50%;display:grid;place-items:center;margin:0 auto 20px;background:linear-gradient(160deg,#22d3ee,#06b6d4);color:#fff;box-shadow:0 16px 38px -14px rgba(6,182,212,.6),inset 0 1px 0 var(--rim-cta)}
.cl-orb svg{width:34px;height:34px;position:relative;z-index:1}
.cl-ring{position:absolute;inset:0;border-radius:50%;border:1.5px solid var(--cyan);opacity:0;animation:cl-ping 3.2s cubic-bezier(.2,.55,.35,1) infinite}
.cl-ring:nth-child(3){animation-delay:1.6s}
@keyframes cl-ping{0%{transform:scale(1);opacity:.5}100%{transform:scale(2.1);opacity:0}}
.cl-title{font-size:30px;font-weight:600;letter-spacing:-.035em;line-height:1.05}
.cl-sub{font-size:14.5px;color:var(--ink2);line-height:1.55;margin:10px auto 0;max-width:38ch}
.cl-cta{max-width:300px;margin:26px auto 0}
.cl-acct{margin-top:14px}
.cl-feats{margin-top:14px}
.cl-feat{cursor:default}
.cl-feat:hover{transform:none;box-shadow:var(--shadow),inset 0 1px 0 var(--rim)}
.cl-feat .pill{align-self:center}
@media (prefers-reduced-motion:reduce){.cl-ring{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "call",
    name: "Call",
    version: "1.0.0",
    description: "Voice calls — launch call.subunit.ai.",
    icon: ICON,
    permissions: [],
    nav: { section: "comms", order: 1 },
    commands: [{ id: "open", title: "Go to Call" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<CallView host={host} />);
    offCmd = host.events.on("command:call:open", () =>
      host.nav.navigate("call")
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
