/**
 * Echo module — launcher/placeholder.
 *
 * Echo (the transcription app) ships as its own standalone Tauri app
 * (echo-tauri); inside this shell it's a launcher surface, not an embed. The
 * action points at the Echo download/site.
 */

import { ComingSoon } from "./ComingSoon";
import { EchoIcon, ExternalIcon } from "../components/icons";
import { openExternal } from "../lib/ipc";

export default function EchoModule() {
  return (
    <ComingSoon
      icon={EchoIcon}
      title="Echo"
      blurb="Echo is the standalone transcription app — dictation and live meeting notes. It runs as its own desktop app; this entry will launch it from the shell."
      action={
        <button
          type="button"
          className="cta-ghost"
          onClick={() => openExternal("https://echo.subunit.ai")}
        >
          <ExternalIcon size={15} />
          About Echo
        </button>
      }
    />
  );
}
