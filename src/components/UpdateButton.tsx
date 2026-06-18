/**
 * UpdateButton — the top-bar "update available" pill.
 *
 * Hidden until Rust emits `subunit://update-available` (or a manual check finds
 * one). Clicking installs + relaunches via `install_update`. Glows so a pending
 * update is unmissable; goes quiet while installing. No-op outside Tauri.
 */

import { useEffect, useState } from "react";
import {
  checkForUpdates,
  installUpdate,
  isTauri,
  onUpdateAvailable,
} from "../lib/ipc";
import { UpdateIcon } from "./icons";

export function UpdateButton() {
  const [version, setVersion] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const sub = onUpdateAvailable((v) => alive && setVersion(v));
    // also do a one-shot check at startup in case the event already fired
    checkForUpdates()
      .then((v) => alive && v && setVersion(v))
      .catch(() => {});
    return () => {
      alive = false;
      sub.then((un) => un());
    };
  }, []);

  if (!version) return null;

  async function handleInstall() {
    setInstalling(true);
    setError("");
    try {
      await installUpdate();
      // relaunches on success; if we get here it's still working
    } catch (e) {
      setError(e instanceof Error ? e.message : "update failed");
      setInstalling(false);
    }
  }

  return (
    <button
      type="button"
      className={`update-pill${error ? " err" : ""}`}
      onClick={handleInstall}
      disabled={installing}
      title={error || `Update to v${version}`}
    >
      <span className="update-glyph" aria-hidden>
        <UpdateIcon size={14} />
      </span>
      <span className="update-label">
        {installing ? "Installing…" : error ? "Retry update" : `Update v${version}`}
      </span>
    </button>
  );
}
