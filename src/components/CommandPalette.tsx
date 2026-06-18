/**
 * CommandPalette — the ⌘K (Ctrl+K) command bar.
 *
 * A glass overlay that fuzzy-filters two kinds of commands:
 *   - navigation : jump to any module route
 *   - actions    : sign in/out, check for updates, open the web chat externally
 *
 * Keyboard-first: ↑/↓ to move, ⏎ to run, Esc to close. Opened/closed by the
 * parent (App) which owns the global ⌘K listener; this component focuses its
 * input on open and resets the query + selection each time.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MODULES } from "../lib/modules";
import { login, logout } from "../lib/auth";
import { checkForUpdates, installUpdate, isTauri, openExternal } from "../lib/ipc";
import {
  ArrowRightIcon,
  ExternalIcon,
  SignInIcon,
  SignOutIcon,
  UpdateIcon,
} from "./icons";
import type { ComponentType, ReactNode } from "react";

interface Command {
  id: string;
  label: string;
  group: "Modules" | "Actions";
  hint?: string;
  icon: ComponentType<{ size?: number }>;
  run: () => void | Promise<void>;
}

/** Cheap subsequence fuzzy match (chars in order, gaps allowed). */
function fuzzyMatch(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return i === q.length;
}

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const nav: Command[] = MODULES.map((m) => ({
      id: `nav:${m.path}`,
      label: m.label,
      group: "Modules",
      hint: m.hint,
      icon: m.icon,
      run: () => navigate(m.path),
    }));

    const actions: Command[] = [
      {
        id: "act:chat-external",
        label: "Open chat in browser",
        group: "Actions",
        hint: "chat.subunit.ai",
        icon: ExternalIcon,
        run: () => openExternal("https://chat.subunit.ai"),
      },
    ];
    if (isTauri()) {
      actions.push(
        {
          id: "act:signin",
          label: "Sign in",
          group: "Actions",
          hint: "Browser SSO",
          icon: SignInIcon,
          run: async () => {
            await login();
          },
        },
        {
          id: "act:signout",
          label: "Sign out",
          group: "Actions",
          hint: "Clear session",
          icon: SignOutIcon,
          run: () => logout(),
        },
        {
          id: "act:update",
          label: "Check for updates",
          group: "Actions",
          hint: "Install if available",
          icon: UpdateIcon,
          run: async () => {
            const v = await checkForUpdates();
            if (v) await installUpdate();
          },
        },
      );
    }
    return [...nav, ...actions];
  }, [navigate]);

  const filtered = useMemo(
    () =>
      commands.filter(
        (c) => fuzzyMatch(query, c.label) || fuzzyMatch(query, c.hint ?? ""),
      ),
    [commands, query],
  );

  // reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after the overlay paints
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // keep the active index in range as the filter narrows
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  async function runAt(index: number) {
    const cmd = filtered[index];
    if (!cmd) return;
    onClose();
    try {
      await cmd.run();
    } catch {
      /* surfaced elsewhere; never break the palette */
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (filtered.length ? (a + 1) % filtered.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) =>
        filtered.length ? (a - 1 + filtered.length) % filtered.length : 0,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAt(active);
    }
  }

  // group rendering while keeping a flat index for keyboard nav
  let flatIndex = -1;
  const groupNames: Command["group"][] = ["Modules", "Actions"];
  const groups = groupNames
    .map((name) => ({ name, items: filtered.filter((c) => c.group === name) }))
    .filter((g) => g.items.length > 0);

  return (
    <div
      className="cmdk-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="cmdk-input-row">
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Jump to a module or run an action…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
          />
          <kbd className="cmdk-esc">esc</kbd>
        </div>

        <div className="cmdk-list">
          {filtered.length === 0 && (
            <div className="cmdk-empty">No matching commands</div>
          )}
          {groups.map((g) => (
            <div key={g.name} className="cmdk-group">
              <div className="cmdk-group-label">{g.name}</div>
              {g.items.map((c) => {
                flatIndex++;
                const idx = flatIndex;
                const Icon = c.icon;
                return (
                  <CmdRow
                    key={c.id}
                    active={idx === active}
                    onHover={() => setActive(idx)}
                    onClick={() => runAt(idx)}
                    icon={<Icon size={17} />}
                    label={c.label}
                    hint={c.hint}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CmdRow({
  active,
  onHover,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onHover: () => void;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      className={`cmdk-row${active ? " is-active" : ""}`}
      onMouseMove={onHover}
      onClick={onClick}
    >
      <span className="cmdk-row-icon" aria-hidden>
        {icon}
      </span>
      <span className="cmdk-row-label">{label}</span>
      {hint && <span className="cmdk-row-hint">{hint}</span>}
      <span className="cmdk-row-go" aria-hidden>
        <ArrowRightIcon size={14} />
      </span>
    </button>
  );
}
