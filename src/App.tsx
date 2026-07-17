/**
 * App.tsx — the Subunit Desktop SHELL.
 *
 * A thin glass host: a left dock listing plugin nav entries (grouped by
 * nav.section, active = the one cyan), a titlebar (Subunit brand mark in the
 * dock head; account chip + theme toggle top-right), a content stage that the
 * loader mounts the active plugin into, and a ⌘K command palette aggregating
 * plugin nav + contributed commands.
 *
 * The shell holds NO module logic — it owns the HostController + PluginLoader
 * and wires nav → mount/unmount. Everything else is a plugin.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HostController, HostProvider, useHost } from "./plugin/host";
import { PluginLoader, type RegisteredPlugin } from "./plugin/loader";
import type { Account } from "./plugin/types";
import { login, logout } from "./lib/auth";
import { appVersion } from "./lib/ipc";
import { Avatar } from "./components/Avatar";
import { SubunitMark } from "./components/SubunitMark";
import { U1Assistant } from "./components/U1Assistant";

// ════════════════════════════════════════════════════════════════════════
// Bootstrap singletons (created once; App wires them into React state).
// ════════════════════════════════════════════════════════════════════════
const controller = new HostController();
const loader = new PluginLoader(controller);

// ── Section metadata for the dock groups. ──
const SECTIONS: { key: "core" | "ops" | "comms"; label: string }[] = [
  { key: "core", label: "Workspace" },
  { key: "ops", label: "Operations" },
  { key: "comms", label: "Communication" },
];

// ── Tiny inline icons used by the shell chrome itself. ──
const CmdIcon = () => (
  <svg viewBox="0 0 24 24">
    <path d="M9 9h6v6H9zM9 9V6a2 2 0 1 0-2 2h2zM15 9V6a2 2 0 1 1 2 2h-2zM9 15v3a2 2 0 1 1-2-2h2zM15 15v3a2 2 0 1 0 2-2h-2z" />
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);
const CaretIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width={14}
    height={14}
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ color: "var(--ink3)" }}
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/** Subunit crown brand mark — the real logo, monochrome (black on light, white
 *  on dark), sized as a proper lockup. No ping, no accent tint. */
const BrandMark = () => (
  <SubunitMark size={34} className="dock-brand-mark" title="Subunit" />
);

// ════════════════════════════════════════════════════════════════════════
// Theme toggle (design-system .themetog)
// ════════════════════════════════════════════════════════════════════════
function ThemeToggle() {
  const host = useHost();
  const [theme, setTheme] = useState(host.getTheme());
  useEffect(() => host.onTheme(setTheme), [host]);
  return (
    <button
      className="themetog no-drag"
      title={theme === "dark" ? "Switch to light" : "Switch to dark"}
      onClick={() => host.setTheme(theme === "dark" ? "light" : "dark")}
    >
      <svg className="ic-moon" viewBox="0 0 24 24">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
      </svg>
      <svg className="ic-sun" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19" />
      </svg>
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Account chip (top-right) — sign in / out via lib/auth
// ════════════════════════════════════════════════════════════════════════
/** A friendly display name derived from the account email local-part. */
function deriveName(email: string): string {
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ").trim();
  if (!local) return "Mein Konto";
  return local
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

const NAME_KEY = "subunit.displayName";

function AccountChip() {
  const host = useHost();
  const [account, setAccount] = useState<Account>(host.getAccount());
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState<string>("");
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => host.onAccount(setAccount), [host]);

  // Display name: a stored override, else derived from the email.
  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* storage unavailable */
    }
    setName(stored || (account.logged_in ? deriveName(account.email) : ""));
  }, [account.email, account.logged_in]);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const signIn = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await login();
    } catch (err) {
      console.error("[shell] sign-in failed:", err);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const signOut = useCallback(async () => {
    if (busy) return;
    setOpen(false);
    setBusy(true);
    try {
      await logout();
    } catch (err) {
      console.error("[shell] sign-out failed:", err);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const saveName = useCallback((v: string) => {
    const next = v.trim();
    setName(next);
    setEditing(false);
    try {
      if (next) localStorage.setItem(NAME_KEY, next);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      /* storage unavailable */
    }
  }, []);

  const initial = (name || account.email || "?").trim().charAt(0).toUpperCase() || "?";

  // Signed out → the chip is a direct sign-in button (no menu).
  if (!account.logged_in) {
    return (
      <button className="acct no-drag signin" disabled={busy} onClick={() => void signIn()}>
        {busy ? <span className="acct-spin" /> : <span className="ini">→</span>}
        <span className="acct-text">
          <span className="acct-name">{busy ? "Verbinde…" : "Anmelden"}</span>
        </span>
      </button>
    );
  }

  return (
    <div className="acct-wrap no-drag" ref={wrapRef}>
      <button
        className="acct"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        title={name || account.email}
      >
        {busy ? (
          <span className="acct-spin" />
        ) : (
          <Avatar url={account.avatar_url} className="ini" fallback={initial} />
        )}
        <span className="acct-text">
          <span className="acct-name">{name || deriveName(account.email)}</span>
          <span className="acct-plan">{account.plan}</span>
        </span>
        <CaretIcon />
      </button>

      {open && (
        <div className="acct-pop" role="menu">
          <div className="acct-pop-head">
            <Avatar url={account.avatar_url} className="acct-pop-av" fallback={initial} />
            <div className="acct-pop-id">
              {editing ? (
                <input
                  className="acct-pop-edit"
                  defaultValue={name}
                  autoFocus
                  placeholder="Dein Name"
                  onBlur={(e) => saveName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveName((e.target as HTMLInputElement).value);
                    if (e.key === "Escape") setEditing(false);
                  }}
                />
              ) : (
                <button className="acct-pop-name" onClick={() => setEditing(true)} title="Namen ändern">
                  {name || deriveName(account.email)}
                  <svg viewBox="0 0 24 24" width={12} height={12}>
                    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
              )}
              <span className="acct-pop-mail">{account.email}</span>
            </div>
          </div>
          <div className="acct-pop-row">
            <span className="acct-pop-k">Plan</span>
            <span className="acct-pop-v">{account.plan}</span>
          </div>
          <button className="acct-pop-out" onClick={() => void signOut()}>
            <svg viewBox="0 0 24 24" width={15} height={15}>
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Abmelden
          </button>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Command palette (⌘K)
// ════════════════════════════════════════════════════════════════════════
interface PaletteItem {
  id: string;
  label: string;
  hint: string;
  group: string;
  icon?: string; // inline SVG (nav glyphs)
  run: () => void;
}

function CommandPalette({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: PaletteItem[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.hint.toLowerCase().includes(q) ||
        it.group.toLowerCase().includes(q)
    );
  }, [items, query]);

  useEffect(() => {
    if (active >= filtered.length) setActive(Math.max(0, filtered.length - 1));
  }, [filtered, active]);

  if (!open) return null;

  const runActive = () => {
    const it = filtered[active];
    if (it) {
      onClose();
      it.run();
    }
  };

  // Group items preserving section order.
  const groups: { label: string; items: PaletteItem[] }[] = [];
  for (const it of filtered) {
    let g = groups.find((x) => x.label === it.group);
    if (!g) groups.push((g = { label: it.group, items: [] }));
    g.items.push(it);
  }

  return (
    <div
      className="cmdk-scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk" role="dialog" aria-modal="true">
        <div className="cmdk-input-row">
          <SearchIcon />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Search plugins and commands…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, filtered.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runActive();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
          />
          <span className="cmdk-esc">esc</span>
        </div>
        <div className="cmdk-list">
          {filtered.length === 0 ? (
            <div className="cmdk-empty">No matches</div>
          ) : (
            groups.map((g) => (
              <div key={g.label}>
                <div className="cmdk-group-label">{g.label}</div>
                {g.items.map((it) => {
                  const idx = filtered.indexOf(it);
                  return (
                    <button
                      key={it.id}
                      className={`cmdk-row${idx === active ? " is-active" : ""}`}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => {
                        onClose();
                        it.run();
                      }}
                    >
                      {it.icon && (
                        <span
                          className="cmdk-row-icon"
                          dangerouslySetInnerHTML={{ __html: it.icon }}
                        />
                      )}
                      <span className="cmdk-row-label">{it.label}</span>
                      <span className="cmdk-row-hint">{it.hint}</span>
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Shell (inside HostProvider)
// ════════════════════════════════════════════════════════════════════════
function Shell() {
  const host = useHost();
  const [plugins, setPlugins] = useState<RegisteredPlugin[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [errorIds, setErrorIds] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState("");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [cmdTick, setCmdTick] = useState(0); // bump when live commands change
  const stageRef = useRef<HTMLDivElement>(null);

  // Navigate = mount; expose to the host so plugins can nav().
  const navigate = useCallback(async (id: string) => {
    const container = stageRef.current;
    if (!container) return;
    setActiveId(id);
    const ok = await loader.mount(id, container);
    setErrorIds((prev) => {
      const next = new Set(prev);
      if (ok) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // One-time bootstrap: discover plugins, mount the first, wire host.navigate.
  useEffect(() => {
    host.navigate = (id: string) => void navigate(id);
    let cancelled = false;
    (async () => {
      const list = await loader.discover();
      if (cancelled) return;
      setPlugins(list);
      // Land on the Dashboard (the Ops board) by default; fall back to the first
      // registered plugin if it isn't present.
      const landing =
        list.find((p) => p.manifest.id === "dashboard")?.manifest.id ??
        list[0]?.manifest.id;
      if (landing) await navigate(landing);
    })();
    appVersion()
      .then(setVersion)
      .catch(() => setVersion(""));
    // React to live command registry changes (plugins registering at runtime).
    const off = host.onCommands(() => setCmdTick((t) => t + 1));
    return () => {
      cancelled = true;
      off();
    };
  }, [host, navigate]);

  // Global ⌘K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activePlugin = plugins.find((p) => p.manifest.id === activeId);

  // Build palette items: nav entries + live contributed commands.
  const paletteItems: PaletteItem[] = useMemo(() => {
    void cmdTick; // recompute when the live command registry changes
    const navItems: PaletteItem[] = plugins.map((p) => ({
      id: `nav:${p.manifest.id}`,
      label: p.manifest.name,
      hint: p.manifest.description,
      group: "Go to",
      icon: p.manifest.icon.trim().startsWith("<") ? p.manifest.icon : undefined,
      run: () => void navigate(p.manifest.id),
    }));
    const cmdItems: PaletteItem[] = [...host.commands.values()].map((c) => ({
      id: `cmd:${c.id}`,
      label: c.title,
      hint: c.id,
      group: "Commands",
      run: c.run,
    }));
    return [...navItems, ...cmdItems];
  }, [plugins, host, navigate, cmdTick]);

  // Group plugins by section for the dock.
  const grouped = useMemo(() => {
    return SECTIONS.map((s) => ({
      ...s,
      items: plugins.filter((p) => p.manifest.nav.section === s.key),
    })).filter((s) => s.items.length > 0);
  }, [plugins]);

  return (
    <div className="shell">
      {/* ── Left dock ── */}
      <aside className="dock">
        <div className="dock-brand">
          <BrandMark />
          <b>Sub<span className="brand-unit">unit</span></b>
        </div>
        <div className="dock-scroll">
          {grouped.map((g) => (
            <div className="dock-group" key={g.key}>
              <div className="dock-group-label">{g.label}</div>
              {g.items.map((p) => (
                <button
                  key={p.manifest.id}
                  className={`dock-item${
                    p.manifest.id === activeId ? " is-active" : ""
                  }${errorIds.has(p.manifest.id) ? " is-error" : ""}`}
                  onClick={() => void navigate(p.manifest.id)}
                  title={p.manifest.description}
                >
                  <span
                    className="dock-glyph"
                    dangerouslySetInnerHTML={{ __html: p.manifest.icon }}
                  />
                  <span className="dock-label">{p.manifest.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="dock-foot">
          <div className="dock-version">
            {version ? `v${version}` : "Subunit Desktop"}
          </div>
        </div>
      </aside>

      {/* ── Main column ── */}
      <div className="shell-main">
        <header className="titlebar">
          <SubunitMark
            className="titlebar-mark no-drag"
            size={20}
            title="Subunit"
          />
          <div className="titlebar-title">
            <h1 className="titlebar-name">
              {activePlugin?.manifest.name ?? "Subunit"}
            </h1>
            {activePlugin && (
              <span className="titlebar-sub">
                {activePlugin.manifest.description}
              </span>
            )}
          </div>
          <div className="titlebar-actions">
            <button
              className="cmd-trigger no-drag"
              onClick={() => setPaletteOpen(true)}
            >
              <CmdIcon />
              <span>Search</span>
              <span className="kbd">⌘K</span>
            </button>
            <AccountChip />
            <ThemeToggle />
          </div>
        </header>

        <main className="stage">
          <div className="stage-mount" ref={stageRef} />
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={paletteItems}
      />

      {/* Ubiquitous U1 helper — bottom-right on every page, knows the active page. */}
      <U1Assistant pageName={activePlugin?.manifest.name ?? "Subunit"} />
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// App — provides the HostController after init.
// ════════════════════════════════════════════════════════════════════════
export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    controller.init().finally(() => setReady(true));
  }, []);

  if (!ready) {
    return (
      <div className="shell">
        <div
          className="stage-loading"
          style={{ gridColumn: "1 / -1", flexDirection: "column", gap: 18 }}
        >
          <SubunitMark size={56} style={{ color: "var(--cyan)" }} />
          <span className="spinner" />
          Loading Subunit…
        </div>
      </div>
    );
  }

  return (
    <HostProvider value={controller}>
      <Shell />
    </HostProvider>
  );
}

export default App;
