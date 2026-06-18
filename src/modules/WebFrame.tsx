/**
 * WebFrame — load a live Subunit web surface inside the shell.
 *
 * Used by the Chat module to host chat.subunit.ai. The iframe origin must be in
 * the tauri.conf.json CSP `frame-src` allowlist (chat + call .subunit.ai are).
 * The hosted app authenticates with its own SSO session (cookie), so we show a
 * one-line note and an "open in browser" escape hatch in case the embedded
 * session needs a full browser to complete sign-in.
 */

import { useState } from "react";
import { openExternal } from "../lib/ipc";
import { ExternalIcon } from "../components/icons";

export function WebFrame({
  url,
  title,
  note,
}: {
  url: string;
  title: string;
  note?: string;
}) {
  const [loaded, setLoaded] = useState(false);

  return (
    <div className="webframe">
      <div className="webframe-bar">
        <span className="webframe-url">{new URL(url).host}</span>
        {note && <span className="webframe-note">{note}</span>}
        <button
          type="button"
          className="webframe-open"
          onClick={() => openExternal(url)}
          title="Open in browser"
        >
          <ExternalIcon size={14} />
          <span>Open in browser</span>
        </button>
      </div>
      <div className="webframe-stage">
        {!loaded && (
          <div className="webframe-loading" aria-live="polite">
            <span className="webframe-spinner" aria-hidden />
            Loading {title}…
          </div>
        )}
        <iframe
          className="webframe-iframe"
          src={url}
          title={title}
          onLoad={() => setLoaded(true)}
          allow="clipboard-read; clipboard-write; microphone; camera"
        />
      </div>
    </div>
  );
}
