/**
 * Meet — the live meeting app, embedded natively in Subunit.
 *
 * meet.subunit.ai is a full meeting tool (host/guest, live transcription over
 * wss://transcribe.subunit.ai, voiceprint enrollment/diarization, recap, PDF).
 * It already ships an EMBED mode (`?embed=1`): the iframe announces
 * `{type:"meet-ready"}` to its parent, and the host replies with the subunit
 * access token via postMessage (origin-pinned to tauri://localhost). So we embed
 * the LIVE meet UI in an iframe and hand it our token — plug-and-play, always the
 * current version, pre-authenticated with the Subunit session.
 *
 * Ecosystem integration is automatic + server-side: finished meetings flow
 * through meet-intelligence → the axon-meeting-ingest pipeline into the knowledge
 * base, so they become queryable in Atlas. The app needs no wiring for that.
 *
 * Permissions: none privileged (auth.getToken + ui are ungated). Mic/camera are
 * granted by the app's Info.plist + entitlements; the iframe requests them.
 */

import { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { HostApi, PluginModule } from "../../plugin/types";

const ICON = `<svg viewBox="0 0 24 24"><path d="M15 10l4.5-2.5v9L15 14M4 6h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/></svg>`;

const MEET_ORIGIN = "https://meet.subunit.ai";
const MEET_EMBED = `${MEET_ORIGIN}/?embed=1`;

function MeetView({ host }: { host: HostApi }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [nonce, setNonce] = useState(0); // bump to reload the iframe

  // Token handshake: Meet posts {type:"meet-ready"}; we reply with the subunit
  // access token (Meet pins the reply to our origin, so this is safe).
  useEffect(() => {
    let alive = true;
    const onMsg = async (e: MessageEvent) => {
      if (e.origin !== MEET_ORIGIN) return;
      if (e.data && e.data.type === "meet-ready") {
        let token = "";
        try {
          token = await host.auth.getToken();
        } catch {
          /* not signed in — Meet falls back to its own SSO inside the frame */
        }
        if (!alive) return;
        frameRef.current?.contentWindow?.postMessage(
          { type: "meet-token", token: token || null },
          MEET_ORIGIN
        );
        setReady(true);
      }
    };
    window.addEventListener("message", onMsg);
    return () => {
      alive = false;
      window.removeEventListener("message", onMsg);
    };
  }, [host, nonce]);

  return (
    <div className="mt">
      <MeetStyle />
      <header className="mt-bar">
        <div className="mt-id">
          <span className="mt-dot" data-on={ready} />
          <div className="mt-tx">
            <b>Meet</b>
            <span>Live-Transkription · Meetings landen automatisch in deinem Wissen (Atlas)</span>
          </div>
        </div>
        <div className="mt-actions">
          <button
            className="btn-ghost minibtn"
            onClick={() => {
              setReady(false);
              setNonce((n) => n + 1);
            }}
            title="Neu laden"
          >
            Neu laden
          </button>
          <button
            className="btn-ghost minibtn"
            onClick={() => host.ui.openExternal(MEET_ORIGIN)}
            title="Im Browser öffnen"
          >
            ↗ Browser
          </button>
        </div>
      </header>

      <div className="mt-stage">
        {!ready && (
          <div className="mt-load">
            <span className="spinner" />
            Meet wird geladen…
          </div>
        )}
        <iframe
          key={nonce}
          ref={frameRef}
          className="mt-frame"
          src={MEET_EMBED}
          title="Subunit Meet"
          allow="microphone; camera; display-capture; clipboard-write; autoplay"
        />
      </div>
    </div>
  );
}

function MeetStyle() {
  return (
    <style>{`
.mt{display:flex;flex-direction:column;height:calc(100vh - 56px);width:100%}
.mt-bar{flex:none;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 18px;background:var(--glass);backdrop-filter:blur(28px) saturate(1.7);-webkit-backdrop-filter:blur(28px) saturate(1.7);border-bottom:1px solid var(--glass-edge);box-shadow:inset 0 1px 0 var(--rim)}
.mt-id{display:flex;align-items:center;gap:11px;min-width:0}
.mt-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--ink3)}
.mt-dot[data-on="true"]{background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:mt-beat 1.8s ease-out infinite}
@keyframes mt-beat{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 7px rgba(52,211,153,0)}}
.mt-tx{display:flex;flex-direction:column;min-width:0}
.mt-tx b{font-size:14.5px;font-weight:650;letter-spacing:-.01em}
.mt-tx span{font-size:11.5px;color:var(--ink3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mt-actions{flex:none;display:flex;gap:7px}
.mt-actions .btn-ghost{white-space:nowrap}
.mt-stage{position:relative;flex:1;min-height:0;background:var(--bg,#0a1422)}
.mt-load{position:absolute;inset:0;z-index:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--ink2);font-size:13px}
.mt-frame{display:block;width:100%;height:100%;border:0;background:transparent}
@media (prefers-reduced-motion:reduce){.mt-dot[data-on="true"]{animation:none}}
`}</style>
  );
}

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "meet",
    name: "Meet",
    version: "1.0.0",
    description: "Live-Meetings — transkribiert, fließen in dein Wissen.",
    icon: ICON,
    permissions: [],
    nav: { section: "comms", order: 2 },
    commands: [{ id: "open", title: "Go to Meet" }],
  },
  mount(container, host) {
    root = createRoot(container);
    root.render(<MeetView host={host} />);
    offCmd = host.events.on("command:meet:open", () => host.nav.navigate("meet"));
  },
  unmount() {
    offCmd?.();
    offCmd = null;
    root?.unmount();
    root = null;
  },
};

export default plugin;
