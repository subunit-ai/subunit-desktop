/**
 * TopBar — the shell titlebar.
 *
 * The whole bar is a Tauri drag region (so the frameless window can be moved by
 * dragging it); interactive children opt back out via `data-tauri-drag-region`
 * being absent + a `no-drag` class. Shows the active module's title + hint, a
 * command-bar trigger (opens the ⌘K palette), the backend target pill, and the
 * update button.
 */

import { useLocation } from "react-router-dom";
import { moduleForPath } from "../lib/modules";
import { BACKEND_BASE_URL, IS_LOCAL_DEV } from "../lib/config";
import { CommandIcon, SearchIcon } from "./icons";
import { UpdateButton } from "./UpdateButton";

export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { pathname } = useLocation();
  const mod = moduleForPath(pathname);
  const target = IS_LOCAL_DEV ? "local" : "cloud";

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="topbar-title" data-tauri-drag-region>
        <h1 className="topbar-name">{mod?.label ?? "Subunit"}</h1>
        {mod?.hint && <span className="topbar-hint">{mod.hint}</span>}
      </div>

      <div className="topbar-actions no-drag">
        <button
          type="button"
          className="cmd-trigger"
          onClick={onOpenPalette}
          title="Command palette (⌘K)"
        >
          <SearchIcon size={15} />
          <span className="cmd-trigger-label">Jump to…</span>
          <kbd className="cmd-kbd">
            <CommandIcon size={11} />K
          </kbd>
        </button>

        <span
          className={`backend-pill ${target}`}
          title={BACKEND_BASE_URL}
        >
          <span className="backend-dot" aria-hidden />
          {target}
        </span>

        <UpdateButton />
      </div>
    </header>
  );
}
