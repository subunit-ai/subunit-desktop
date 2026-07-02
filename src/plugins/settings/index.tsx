/**
 * Settings — the app's preferences hub.
 *
 * A macOS System-Settings-style surface: a LEFT section sidebar + a content
 * pane on the right. Sections:
 *
 *   · Erscheinungsbild  — theme switcher (host.ui.setTheme / onTheme) + live preview.
 *   · Konto             — account identity; inline-editable display name persisted
 *                         to localStorage "subunit.displayName" (mirrors the titlebar chip).
 *   · Software-Update   — the EXISTING updater UI (version / check / install w/ progress,
 *                         backed by host.updater) PLUS a persisted auto-check toggle.
 *   · Modelle           — GET /api/m/models via host.backend; pick a default model
 *                         (persisted); cloud models with an AVV note. Graceful offline.
 *   · Benachrichtigungen— web Notification permission + persisted pref + a test notify.
 *   · Verbindung        — backend target + live reachability dot (cloud vs local).
 *   · Über              — version, description, links, credits.
 *
 * Download/install is ALWAYS user-triggered — we never auto-install (high blast
 * radius). On install the process restarts, so install() never resolves.
 *
 * Permissions: "updater" (version/check/install/onAvailable/onProgress),
 * "storage" (persisted prefs), "backend:atlas-api" (models + health),
 * "notifications" (test notify). auth + ui are ungated.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Account, HostApi, PluginModule } from "../../plugin/types";
import { SubunitMark } from "../../components/SubunitMark";
import { BACKENDS } from "../../lib/config";

const ICON = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const GITHUB_URL = "https://github.com/subunit-ai/subunit-desktop";
const RELEASES_URL = "https://github.com/subunit-ai/subunit-desktop/releases";

// localStorage key shared with the titlebar account chip (see App.tsx).
const NAME_KEY = "subunit.displayName";
// host.storage keys (per-plugin namespaced by the shell).
const K_AUTO_UPDATE = "settings.autoUpdate";
const K_DEFAULT_MODEL = "settings.defaultModel";
const K_NOTIFY_PREF = "settings.notifyEnabled";

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

// ── derive a friendly display name from an email local-part (mirror App.tsx) ──
function deriveName(email: string): string {
  const local = email.split("@")[0] ?? "";
  if (!local) return "Mein Konto";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

type SectionId =
  | "appearance"
  | "account"
  | "update"
  | "models"
  | "notifications"
  | "connection"
  | "about";

interface SectionDef {
  id: SectionId;
  label: string;
  hint: string;
  icon: string;
  tint: string;
}

const SECTIONS: SectionDef[] = [
  { id: "appearance", label: "Erscheinungsbild", hint: "Theme & Darstellung", icon: "M12 3v2|M12 19v2|M5.6 5.6l1.4 1.4|M17 17l1.4 1.4|M3 12h2|M19 12h2|M5.6 18.4 7 17|M17 7l1.4-1.4", tint: "#06b6d4" },
  { id: "account", label: "Konto", hint: "Identität & Plan", icon: "M20 21a8 8 0 1 0-16 0|M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", tint: "#7c5cf0" },
  { id: "update", label: "Software-Update", hint: "Version & Updates", icon: "M12 3v12|M7 10l5 5 5-5|M5 21h14", tint: "#0a9d63" },
  { id: "models", label: "Modelle", hint: "Standard & Cloud", icon: "M4 7h16|M4 12h16|M4 17h10|M9 4v16", tint: "#0891b2" },
  { id: "notifications", label: "Benachrichtigungen", hint: "Hinweise & Test", icon: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9|M13.7 21a2 2 0 0 1-3.4 0", tint: "#d97706" },
  { id: "connection", label: "Verbindung", hint: "Backend & Status", icon: "M5 12.5a7 7 0 0 1 14 0|M8.5 15.5a3.5 3.5 0 0 1 7 0|M2 9a11 11 0 0 1 20 0|M12 19h.01", tint: "#e11d48" },
  { id: "about", label: "Über", hint: "App-Info & Links", icon: "M12 16v-4|M12 8h.01|M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", tint: "#586b82" },
];

// ════════════════════════════════════════════════════════════════════════
// Root
// ════════════════════════════════════════════════════════════════════════

function SettingsView({ host }: { host: HostApi }) {
  const [section, setSection] = useState<SectionId>("appearance");

  return (
    <div className="set">
      <SettingsStyle />
      <div className="set-shell">
        {/* ── section sidebar ── */}
        <nav className="set-side" aria-label="Einstellungen">
          <div className="set-side-brand">
            <span className="set-side-mark">
              <SubunitMark size={20} />
            </span>
            <span className="set-side-ttl">Einstellungen</span>
          </div>
          <div className="set-side-list">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav${section === s.id ? " on" : ""}`}
                onClick={() => setSection(s.id)}
                aria-current={section === s.id ? "page" : undefined}
              >
                <span
                  className="set-nav-ic"
                  style={{ "--c": s.tint } as React.CSSProperties}
                >
                  <Svg d={s.icon} />
                </span>
                <span className="set-nav-tx">
                  <span className="set-nav-l">{s.label}</span>
                  <span className="set-nav-h">{s.hint}</span>
                </span>
              </button>
            ))}
          </div>
        </nav>

        {/* ── content pane ── */}
        <div className="set-pane">
          {section === "appearance" && <AppearanceSection host={host} />}
          {section === "account" && <AccountSection host={host} />}
          {section === "update" && <UpdateSection host={host} />}
          {section === "models" && <ModelsSection host={host} />}
          {section === "notifications" && <NotificationsSection host={host} />}
          {section === "connection" && <ConnectionSection host={host} />}
          {section === "about" && <AboutSection host={host} />}
        </div>
      </div>
    </div>
  );
}

// ── shared header for a content section ──
function PaneHead({ title, sub }: { title: string; sub: string }) {
  return (
    <header className="set-head">
      <h1 className="set-h1">{title}</h1>
      <p className="set-h-sub">{sub}</p>
    </header>
  );
}

// ── a labelled settings row (left: label/desc, right: control) ──
function Row({
  label,
  desc,
  children,
  block,
}: {
  label: string;
  desc?: string;
  children?: ReactNode;
  block?: boolean;
}) {
  return (
    <div className={`set-row${block ? " block" : ""}`}>
      <div className="set-row-tx">
        <div className="set-row-l">{label}</div>
        {desc && <div className="set-row-d">{desc}</div>}
      </div>
      {children && <div className="set-row-ctl">{children}</div>}
    </div>
  );
}

function Switch({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch" aria-label={label}>
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
    </label>
  );
}

function LinkBtn({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className="set-link" onClick={onClick}>
      {children}
      <Svg d="M7 17 17 7|M7 7h10v10" />
    </button>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 1) Erscheinungsbild
// ════════════════════════════════════════════════════════════════════════

function AppearanceSection({ host }: { host: HostApi }) {
  const [theme, setTheme] = useState<"light" | "dark">(host.ui.theme());

  useEffect(() => host.ui.onTheme(setTheme), [host]);

  const pick = useCallback(
    (t: "light" | "dark") => {
      host.ui.setTheme(t);
      setTheme(t); // optimistic; onTheme confirms shell-wide
    },
    [host]
  );

  const opts: { id: "light" | "dark"; label: string; sub: string }[] = [
    { id: "light", label: "Hell", sub: "Frosted Glass auf hellem Grund" },
    { id: "dark", label: "Dunkel", sub: "Tiefes Navy, gedämpfte Ränder" },
  ];

  return (
    <div className="set-sec">
      <PaneHead
        title="Erscheinungsbild"
        sub="Wähle das App-Theme. Die Änderung greift sofort in der gesamten Shell."
      />
      <div className="card set-block">
        <div className="set-theme-grid">
          {opts.map((o) => (
            <button
              key={o.id}
              className={`set-theme${theme === o.id ? " on" : ""} set-theme-${o.id}`}
              onClick={() => pick(o.id)}
              aria-pressed={theme === o.id}
            >
              <span className="set-theme-prev" aria-hidden="true">
                <span className="set-theme-bar" />
                <span className="set-theme-card">
                  <span className="set-theme-dot" />
                  <span className="set-theme-line" />
                  <span className="set-theme-line short" />
                </span>
              </span>
              <span className="set-theme-meta">
                <span className="set-theme-l">
                  {o.label}
                  {theme === o.id && (
                    <span className="set-theme-chk">
                      <Svg d="M20 6 9 17l-5-5" />
                    </span>
                  )}
                </span>
                <span className="set-theme-s">{o.sub}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="set-note">
          Aktiv:{" "}
          <b>{theme === "dark" ? "Dunkel" : "Hell"}</b> · Das Theme wird
          gespeichert und beim nächsten Start wiederhergestellt.
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 2) Konto
// ════════════════════════════════════════════════════════════════════════

function AccountSection({ host }: { host: HostApi }) {
  const [account, setAccount] = useState<Account>(host.auth.account());
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => host.auth.onChange(setAccount), [host]);

  // Display name: stored override, else derived from the email (mirror App.tsx).
  useEffect(() => {
    let stored = "";
    try {
      stored = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* storage unavailable */
    }
    setName(stored || (account.logged_in ? deriveName(account.email) : ""));
  }, [account.email, account.logged_in]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const startEdit = useCallback(() => {
    setDraft(name);
    setEditing(true);
  }, [name]);

  const commit = useCallback(() => {
    const v = draft.trim();
    const next = v || (account.logged_in ? deriveName(account.email) : "");
    setName(next);
    try {
      if (v) localStorage.setItem(NAME_KEY, v);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      /* storage unavailable */
    }
    setEditing(false);
  }, [draft, account.email, account.logged_in]);

  const initials = (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("");

  return (
    <div className="set-sec">
      <PaneHead
        title="Konto"
        sub="Deine Subunit-Identität auf diesem Mac. Abmelden findest du in der Account-Pille oben rechts."
      />

      <div className="card set-block">
        <div className="set-acct-top">
          <span className="set-avatar" aria-hidden="true">
            {account.logged_in ? initials || "U1" : "–"}
          </span>
          <div className="set-acct-id">
            {editing ? (
              <input
                ref={inputRef}
                className="fld set-name-fld"
                value={draft}
                placeholder="Anzeigename"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
            ) : (
              <button className="set-name" onClick={startEdit}>
                {name || "Mein Konto"}
                <span className="set-name-edit" aria-hidden="true">
                  <Svg d="M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                </span>
              </button>
            )}
            <div className="set-acct-mail">
              {account.logged_in ? account.email : "Nicht angemeldet"}
            </div>
          </div>
          {account.logged_in && (
            <span className="set-plan">{account.plan || "—"}</span>
          )}
        </div>

        <div className="set-divider" />

        <Row label="Anzeigename" desc="Lokal gespeichert · erscheint in der Titelleiste.">
          {editing ? (
            <button className="btn-ghost minibtn" onClick={commit}>
              Sichern
            </button>
          ) : (
            <button className="btn-ghost minibtn" onClick={startEdit}>
              Bearbeiten
            </button>
          )}
        </Row>
        <Row
          label="Workspace"
          desc={account.logged_in ? account.workspace_id || "—" : "—"}
        />
        <Row label="Plan" desc="Dein aktiver Subunit-Tarif.">
          <span className={`pill ${account.logged_in ? "live" : "gone"}`}>
            {account.logged_in ? account.plan || "Aktiv" : "Offline"}
          </span>
        </Row>
      </div>

      {!account.logged_in && (
        <div className="set-note warn">
          Du bist nicht angemeldet. Melde dich über die Account-Pille oben
          rechts an, um Modelle, Sync und Cloud-Features zu nutzen.
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 3) Software-Update  (PRESERVES the existing updater logic)
// ════════════════════════════════════════════════════════════════════════

type Phase = "checking" | "uptodate" | "available" | "installing" | "error";

function UpdateSection({ host }: { host: HostApi }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [phase, setPhase] = useState<Phase>("checking");
  const [progress, setProgress] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [checkedAt, setCheckedAt] = useState("");
  const [autoCheck, setAutoCheck] = useState(true);
  const alive = useRef(true);

  const runCheck = useCallback(async () => {
    setPhase("checking");
    setErr("");
    try {
      const { current: cur, available } = await host.updater.check();
      if (!alive.current) return;
      if (cur) setCurrent(cur);
      setCheckedAt(
        new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
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
    setProgress(null);
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

  // Mount: read installed version immediately, then check; subscribe to the
  // shell's background find + download progress.
  useEffect(() => {
    alive.current = true;
    host.updater
      .version()
      .then((v) => alive.current && v && setCurrent(v))
      .catch(() => {});
    void runCheck();
    const off = host.updater.onAvailable((v) => {
      if (!alive.current) return;
      setNext(v);
      // Don't clobber an in-flight manual check or an install.
      setPhase((p) => (p === "installing" || p === "checking" ? p : "available"));
    });
    const offProg = host.updater.onProgress((pct) => {
      if (alive.current) setProgress(pct);
    });
    return () => {
      alive.current = false;
      off();
      offProg();
    };
  }, [host, runCheck]);

  // Load the persisted auto-check preference.
  useEffect(() => {
    let on = true;
    host.storage
      .get(K_AUTO_UPDATE)
      .then((v) => {
        if (on && typeof v === "boolean") setAutoCheck(v);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [host]);

  const toggleAuto = useCallback(
    (v: boolean) => {
      setAutoCheck(v);
      void host.storage.set(K_AUTO_UPDATE, v).catch(() => {});
    },
    [host]
  );

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
    head =
      progress != null
        ? `Update wird installiert… ${progress} %`
        : "Update wird installiert…";
    sub = `v${next} wird heruntergeladen und installiert. Die App startet gleich automatisch neu — bitte nicht schließen.`;
    action =
      progress != null ? (
        <div
          className="set-prog"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="set-prog-fill" style={{ width: `${progress}%` }} />
        </div>
      ) : null;
  } else if (phase === "error") {
    tone = "err";
    icon = (
      <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    );
    head = "Update-Prüfung fehlgeschlagen";
    sub = err || "Unbekannter Fehler.";
    action = (
      <button className="btn-ghost minibtn" disabled={busy} onClick={() => void runCheck()}>
        Erneut versuchen
      </button>
    );
  }

  return (
    <div className="set-sec">
      <PaneHead
        title="Software-Update"
        sub="Subunit Desktop aktualisiert sich über die signierte Release-Pipeline. Installation ist immer manuell."
      />

      <div className="set-verline">
        <span className="set-ver-k">Installierte Version</span>
        <span className="set-ver-v">{current ? `v${current}` : "…"}</span>
      </div>

      <div className={`set-upd card tone-${tone}`}>
        <span className="set-upd-ic">{icon}</span>
        <div className="set-upd-tx">
          <div className="set-upd-head">{head}</div>
          <div className="set-upd-sub">{sub}</div>
        </div>
        <div className="set-upd-act">{action}</div>
      </div>

      <div className="card set-block tight">
        <Row
          label="Automatisch nach Updates suchen"
          desc="Die Shell prüft im Hintergrund alle 3 Stunden auf neue Versionen."
        >
          <Switch
            on={autoCheck}
            onChange={toggleAuto}
            label="Automatisch nach Updates suchen"
          />
        </Row>
      </div>

      <LinkBtn onClick={() => host.ui.openExternal(RELEASES_URL)}>
        Alle Releases &amp; Changelog ansehen
      </LinkBtn>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 4) Modelle
// ════════════════════════════════════════════════════════════════════════

interface ModelEntry {
  id: string;
  name: string;
  cloud: boolean;
  ctx?: number;
  size?: string;
}

type Loadable = "loading" | "ready" | "offline";

// Tolerant parse of /api/m/models — backends vary; accept several shapes.
function parseModels(raw: unknown): ModelEntry[] {
  const arr: unknown[] = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { models?: unknown[] })?.models)
    ? (raw as { models: unknown[] }).models
    : Array.isArray((raw as { data?: unknown[] })?.data)
    ? (raw as { data: unknown[] }).data
    : [];
  return arr
    .map((m): ModelEntry | null => {
      if (typeof m === "string") return { id: m, name: m, cloud: false };
      if (m && typeof m === "object") {
        const o = m as Record<string, unknown>;
        const id = String(o.id ?? o.name ?? o.model ?? "");
        if (!id) return null;
        const cloud =
          o.cloud === true ||
          o.local === false ||
          o.type === "cloud" ||
          (typeof o.provider === "string" &&
            o.provider !== "local" &&
            o.provider !== "ollama");
        const ctxRaw = o.context ?? o.ctx ?? o.context_length;
        return {
          id,
          name: String(o.name ?? o.label ?? id),
          cloud,
          ctx: typeof ctxRaw === "number" ? ctxRaw : undefined,
          size:
            typeof o.size === "string"
              ? o.size
              : typeof o.parameters === "string"
              ? o.parameters
              : undefined,
        };
      }
      return null;
    })
    .filter((m): m is ModelEntry => m !== null);
}

function ModelsSection({ host }: { host: HostApi }) {
  const [state, setState] = useState<Loadable>("loading");
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [defaultId, setDefaultId] = useState<string>("");

  const load = useCallback(async () => {
    setState("loading");
    try {
      const res = await host.backend.fetch("atlas-api", "/api/m/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setModels(parseModels(json));
      setState("ready");
    } catch {
      setModels([]);
      setState("offline");
    }
  }, [host]);

  useEffect(() => {
    void load();
  }, [load]);

  // Load the persisted default model.
  useEffect(() => {
    let on = true;
    host.storage
      .get(K_DEFAULT_MODEL)
      .then((v) => {
        if (on && typeof v === "string") setDefaultId(v);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [host]);

  const pickDefault = useCallback(
    (id: string) => {
      setDefaultId(id);
      void host.storage.set(K_DEFAULT_MODEL, id).catch(() => {});
    },
    [host]
  );

  const local = useMemo(() => models.filter((m) => !m.cloud), [models]);
  const cloud = useMemo(() => models.filter((m) => m.cloud), [models]);

  return (
    <div className="set-sec">
      <PaneHead
        title="Modelle"
        sub="Wähle das Standardmodell für lokale Anfragen. Cloud-Modelle stehen je nach Plan bereit."
      />

      {state === "loading" && (
        <div className="card set-block set-center">
          <span className="set-spin" role="status" aria-label="Lädt" />
          <div className="set-note">Modelle werden geladen…</div>
        </div>
      )}

      {state === "offline" && (
        <div className="card set-block tone-err set-center">
          <Svg d="M12 9v4|M12 17h.01|M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <div className="set-row-l" style={{ marginTop: 10 }}>
            Backend nicht erreichbar
          </div>
          <div className="set-note">
            Die Modell-Liste konnte nicht von <code>atlas-api</code> geladen
            werden. Prüfe die Verbindung unter „Verbindung“.
          </div>
          <button className="btn-ghost minibtn" onClick={() => void load()} style={{ marginTop: 14 }}>
            Erneut laden
          </button>
        </div>
      )}

      {state === "ready" && (
        <>
          <div className="set-sublabel">
            Lokale Modelle <span className="set-count">{local.length}</span>
          </div>
          {local.length === 0 ? (
            <div className="set-note">Keine lokalen Modelle gefunden.</div>
          ) : (
            <div className="card set-block tight set-list">
              {local.map((m) => (
                <button
                  key={m.id}
                  className={`set-model${defaultId === m.id ? " on" : ""}`}
                  onClick={() => pickDefault(m.id)}
                  aria-pressed={defaultId === m.id}
                >
                  <span className="set-radio" aria-hidden="true">
                    {defaultId === m.id && <i />}
                  </span>
                  <span className="set-model-tx">
                    <span className="set-model-n">{m.name}</span>
                    <span className="set-model-m">
                      {[
                        m.size,
                        m.ctx ? `${(m.ctx / 1000).toFixed(0)}k Kontext` : null,
                        "lokal",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                  {defaultId === m.id && (
                    <span className="pill live">Standard</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {cloud.length > 0 && (
            <>
              <div className="set-sublabel">
                Cloud-Modelle <span className="set-count">{cloud.length}</span>
              </div>
              <div className="card set-block tight set-list">
                {cloud.map((m) => (
                  <div key={m.id} className="set-model cloud">
                    <span className="set-model-glyph" aria-hidden="true">
                      <Svg d="M18 10h1a4 4 0 0 1 0 8H6a5 5 0 1 1 .9-9.9A6 6 0 0 1 18 10z" />
                    </span>
                    <span className="set-model-tx">
                      <span className="set-model-n">{m.name}</span>
                      <span className="set-model-m">
                        {[
                          m.ctx ? `${(m.ctx / 1000).toFixed(0)}k Kontext` : null,
                          "Cloud",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    <span className="pill gone">Cloud</span>
                  </div>
                ))}
              </div>
              <div className="set-note avv">
                <Svg d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <span>
                  Cloud-Modelle verarbeiten Daten extern. Für den produktiven
                  Einsatz ist ein <b>Auftragsverarbeitungsvertrag (AVV)</b> mit
                  Subunit erforderlich.
                </span>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 5) Benachrichtigungen
// ════════════════════════════════════════════════════════════════════════

type NotifPerm = "default" | "granted" | "denied" | "unsupported";

function readPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotifPerm;
}

function NotificationsSection({ host }: { host: HostApi }) {
  const [perm, setPerm] = useState<NotifPerm>(readPerm());
  const [enabled, setEnabled] = useState(false);
  const [sentAt, setSentAt] = useState("");

  // Load the persisted preference.
  useEffect(() => {
    let on = true;
    host.storage
      .get(K_NOTIFY_PREF)
      .then((v) => {
        if (on && typeof v === "boolean") setEnabled(v);
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [host]);

  const toggle = useCallback(
    async (v: boolean) => {
      if (v && typeof Notification !== "undefined" && Notification.permission === "default") {
        try {
          const res = await Notification.requestPermission();
          setPerm(res as NotifPerm);
          if (res !== "granted") v = false;
        } catch {
          /* permission flow unavailable */
        }
      }
      setEnabled(v);
      void host.storage.set(K_NOTIFY_PREF, v).catch(() => {});
    },
    [host]
  );

  const sendTest = useCallback(() => {
    host.notifications.notify(
      "Subunit Desktop",
      "Test-Benachrichtigung — die Zustellung funktioniert."
    );
    setSentAt(
      new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    );
  }, [host]);

  const permLabel: Record<NotifPerm, string> = {
    granted: "Erlaubt",
    denied: "Blockiert",
    default: "Nicht angefragt",
    unsupported: "Nicht verfügbar",
  };
  const permTone: Record<NotifPerm, string> = {
    granted: "live",
    denied: "gone",
    default: "wait",
    unsupported: "gone",
  };

  return (
    <div className="set-sec">
      <PaneHead
        title="Benachrichtigungen"
        sub="Erhalte Hinweise zu Updates, abgeschlossenen Aufgaben und Agenten-Ereignissen."
      />

      <div className="card set-block">
        <Row
          label="Benachrichtigungen aktivieren"
          desc="Beim Einschalten fragt das System ggf. die Erlaubnis ab."
        >
          <Switch
            on={enabled && perm !== "denied"}
            onChange={(v) => void toggle(v)}
            label="Benachrichtigungen aktivieren"
          />
        </Row>
        <div className="set-divider" />
        <Row label="Systemberechtigung" desc="Status der Web-Notification-Erlaubnis.">
          <span className={`pill ${permTone[perm]}`}>{permLabel[perm]}</span>
        </Row>
        {perm === "denied" && (
          <div className="set-note warn">
            Benachrichtigungen sind im System blockiert. Aktiviere sie in den
            macOS-Systemeinstellungen unter „Mitteilungen“.
          </div>
        )}
      </div>

      <div className="card set-block tight">
        <Row
          label="Test-Benachrichtigung"
          desc={
            sentAt
              ? `Zuletzt gesendet um ${sentAt}.`
              : "Sende eine Beispiel-Mitteilung, um die Zustellung zu prüfen."
          }
        >
          <button className="btn-ghost minibtn" onClick={sendTest}>
            <Svg d="M22 2 11 13|M22 2 15 22l-4-9-9-4 20-7z" />
            Senden
          </button>
        </Row>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 6) Verbindung
// ════════════════════════════════════════════════════════════════════════

// ── multi-backend health matrix: is EACH Subunit backend reachable from this Mac? ──
type ProbeState = "checking" | "online" | "degraded" | "offline";

interface Probe {
  name: string;
  url: string;
  env: "local" | "cloud";
  state: ProbeState;
  code?: number;
  ms?: number;
}

const isLocalUrl = (u: string) =>
  /localhost|127\.0\.0\.1|0\.0\.0\.0|\.local(?::|\/|$)/.test(u);

// The real module backends to probe — mirrors lib/config BACKENDS, minus the
// local/cloud aliases (which just duplicate atlas-api's base).
const PROBE_NAMES = Object.keys(BACKENDS).filter((n) => n !== "local" && n !== "cloud");

function ConnectionSection({ host }: { host: HostApi }) {
  const [probes, setProbes] = useState<Probe[]>(() =>
    PROBE_NAMES.map((name) => {
      let url = "";
      try {
        url = host.backend.baseUrl(name);
      } catch {
        url = "";
      }
      return { name, url, env: isLocalUrl(url) ? "local" : "cloud", state: "checking" as ProbeState };
    })
  );
  const [checkedAt, setCheckedAt] = useState("");
  const [copied, setCopied] = useState(false);
  const alive = useRef(true);

  // One probe: any HTTP answer means the service is UP (even a 404 for a missing
  // /health route); a thrown fetch means unreachable (down / no network / CORS).
  const probeOne = useCallback(
    async (name: string): Promise<Partial<Probe>> => {
      const t0 = Date.now();
      try {
        const res = await host.backend.fetch(name, "/health");
        return { state: res.ok ? "online" : "degraded", code: res.status, ms: Date.now() - t0 };
      } catch {
        return { state: "offline", ms: Date.now() - t0 };
      }
    },
    [host]
  );

  const pingAll = useCallback(async () => {
    setProbes((ps) => ps.map((p) => ({ ...p, state: "checking" as ProbeState })));
    const results = await Promise.all(
      PROBE_NAMES.map(async (name) => ({ name, ...(await probeOne(name)) }))
    );
    if (!alive.current) return;
    setProbes((ps) => ps.map((p) => ({ ...p, ...(results.find((r) => r.name === p.name) ?? {}) })));
    setCheckedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }, [probeOne]);

  useEffect(() => {
    alive.current = true;
    void pingAll();
    return () => {
      alive.current = false;
    };
  }, [pingAll]);

  const copyDiagnostics = useCallback(async () => {
    let version = "";
    try {
      version = await host.updater.version();
    } catch {
      /* version unavailable */
    }
    const lines = [
      "Subunit Desktop — Diagnose",
      `Version: v${version || "?"}`,
      `Theme:   ${host.ui.theme()}`,
      `System:  ${navigator.platform || navigator.userAgent}`,
      `Zeit:    ${new Date().toISOString()}`,
      "",
      "Backends:",
      ...probes.map(
        (p) =>
          `  ${p.name.padEnd(15)} ${p.state.padEnd(9)} ${(p.ms != null ? `${p.ms}ms` : "").padEnd(8)}${p.code ? `HTTP ${p.code}  ` : ""}${p.url}`
      ),
    ];
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => {
        if (alive.current) setCopied(false);
      }, 1800);
    } catch {
      /* clipboard unavailable */
    }
  }, [host, probes]);

  const onlineCount = probes.filter((p) => p.state === "online").length;
  const anyChecking = probes.some((p) => p.state === "checking");
  const tone: Record<ProbeState, string> = { online: "ok", degraded: "wait", offline: "err", checking: "wait" };
  const pillTone: Record<ProbeState, string> = { online: "live", degraded: "wait", offline: "gone", checking: "wait" };
  const label: Record<ProbeState, string> = { online: "Erreichbar", degraded: "Gestört", offline: "Offline", checking: "Prüfe…" };

  return (
    <div className="set-sec">
      <PaneHead
        title="Verbindung"
        sub="Erreichbarkeit aller Subunit-Backends von diesem Mac aus — die schnellste Diagnose, wenn etwas hakt."
      />

      <div className="set-health-head">
        <span className="set-health-sum">
          <b>{onlineCount}</b> von {probes.length} erreichbar
          {checkedAt && <span className="set-health-t"> · {checkedAt}</span>}
        </span>
        <div className="set-health-act">
          <button className="btn-ghost minibtn" onClick={() => void copyDiagnostics()}>
            {copied ? "Kopiert ✓" : "Diagnose kopieren"}
          </button>
          <button className="btn-ghost minibtn" disabled={anyChecking} onClick={() => void pingAll()}>
            Alle prüfen
          </button>
        </div>
      </div>

      <div className="card set-block tight set-list">
        {probes.map((p) => (
          <div key={p.name} className="set-health">
            <span className={`set-dot ${tone[p.state]}`} aria-hidden="true" />
            <div className="set-health-id">
              <div className="set-health-n">
                {p.name}
                <span className={`set-env ${p.env}`}>{p.env === "local" ? "Lokal" : "Cloud"}</span>
              </div>
              <div className="set-health-url" title={p.url}>
                {p.url || "—"}
              </div>
            </div>
            <div className="set-health-r">
              {p.ms != null && p.state !== "checking" && <span className="set-health-ms">{p.ms} ms</span>}
              <span className={`pill ${pillTone[p.state]}`}>
                {label[p.state]}
                {p.code && p.state === "degraded" ? ` ${p.code}` : ""}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="set-note">
        „Erreichbar" heißt: das Backend hat auf <code>/health</code> geantwortet. „Gestört" = geantwortet, aber mit
        Fehlercode. „Offline" = keine Antwort (Dienst aus, Netz weg oder CORS geblockt).
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// 7) Über
// ════════════════════════════════════════════════════════════════════════

function AboutSection({ host }: { host: HostApi }) {
  const [version, setVersion] = useState("");

  useEffect(() => {
    let on = true;
    host.updater
      .version()
      .then((v) => on && v && setVersion(v))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [host]);

  return (
    <div className="set-sec">
      <PaneHead title="Über" sub="Subunit Desktop — unsere native Glass-Shell." />

      <div className="card set-block set-center set-about">
        <span className="set-mark">
          <SubunitMark size={34} />
        </span>
        <h2 className="set-about-ttl">Subunit Desktop</h2>
        <span className="set-ver-pill">
          {version ? `Version ${version}` : "Version …"}
        </span>
        <p className="set-about-sub">
          Atlas, Synapse, Dashboard, Chat, Call und Echo in einer App — lokal
          auf dem Mac, über die Subunit Liquid-Glass-Oberfläche.
        </p>

        <div className="set-about-links">
          <button className="btn-ghost minibtn" onClick={() => host.ui.openExternal(GITHUB_URL)}>
            <Svg d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 6.2-1.5 6.2-6.7A5.2 5.2 0 0 0 20 4.8 4.9 4.9 0 0 0 19.9 1S18.7.6 16 2.5a13.4 13.4 0 0 0-7 0C6.3.6 5.1 1 5.1 1A4.9 4.9 0 0 0 5 4.8 5.2 5.2 0 0 0 3.7 8.4c0 5.2 3.2 6.4 6.2 6.7A3.4 3.4 0 0 0 9 17.7V22" />
            GitHub
          </button>
          <button className="btn-ghost minibtn" onClick={() => host.ui.openExternal(RELEASES_URL)}>
            <Svg d="M12 3v12|M7 10l5 5 5-5|M5 21h14" />
            Releases
          </button>
        </div>

        <div className="set-credits">
          Gebaut von der <b>subunit</b>-Crew · u1 &amp; TJ · © {new Date().getFullYear()}
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Styles  (all classes scoped with the `set-` prefix; reuses shared
// component classes where sensible: .card .btn .btn-primary .btn-ghost
// .minibtn .fld .pill .switch)
// ════════════════════════════════════════════════════════════════════════

function SettingsStyle() {
  return (
    <style>{`
.set{width:100%;height:100%}
.set code{font-family:var(--mono,ui-monospace,monospace);font-size:.92em;background:var(--glass2);padding:1px 5px;border-radius:6px}
.set-shell{display:grid;grid-template-columns:248px 1fr;gap:0;max-width:1000px;margin:0 auto;min-height:100%;align-items:start}

/* ── sidebar ── */
.set-side{position:sticky;top:0;align-self:start;padding:26px 14px 26px 4px}
.set-side-brand{display:flex;align-items:center;gap:10px;padding:6px 10px 16px}
.set-side-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;color:var(--cyan);background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim)}
.set-side-ttl{font-size:14.5px;font-weight:680;letter-spacing:-.02em}
.set-side-list{display:flex;flex-direction:column;gap:2px}
.set-nav{display:flex;align-items:center;gap:11px;width:100%;padding:9px 10px;border:1px solid transparent;border-radius:var(--r-xs);background:none;cursor:pointer;font:inherit;text-align:left;transition:background .15s,border-color .15s}
.set-nav:hover{background:var(--fill-weak)}
.set-nav.on{background:var(--glass);border-color:var(--line2);box-shadow:var(--shadow-sm),inset 0 1px 0 var(--rim)}
.set-nav-ic{flex:none;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:#fff;background:var(--c);background-image:linear-gradient(155deg,rgba(255,255,255,.34),rgba(0,0,0,.34))}
.set-nav-ic svg{width:17px;height:17px}
.set-nav-tx{display:flex;flex-direction:column;min-width:0;line-height:1.25}
.set-nav-l{font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.set-nav-h{font-size:11px;color:var(--ink3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── content pane ── */
.set-pane{padding:30px 26px 56px;min-width:0}
.set-sec{display:flex;flex-direction:column;animation:set-fade .28s ease}
@keyframes set-fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.set-head{margin-bottom:18px}
.set-h1{font-size:24px;font-weight:680;letter-spacing:-.035em;line-height:1.08}
.set-h-sub{font-size:13.5px;color:var(--ink2);line-height:1.55;margin-top:8px;max-width:54ch}

.set-block{padding:8px 20px;margin-bottom:14px}
.set-block.tight{padding-top:4px;padding-bottom:4px}
.set-center{text-align:center;padding:26px 22px}
.set-note{font-size:12.5px;color:var(--ink2);line-height:1.55;margin-top:12px}
.set-note.warn{color:var(--amber);background:var(--amber-bg);border:1px solid var(--amber-line);border-radius:var(--r-sm);padding:11px 14px}
.set-note.avv{display:flex;gap:9px;align-items:flex-start;margin-top:10px}
.set-note.avv svg{flex:none;width:16px;height:16px;color:var(--cyan-d,#0891b2);stroke:currentColor;fill:none;stroke-width:1.8;margin-top:1px}
.set-sublabel{display:flex;align-items:center;gap:8px;font-size:11.5px;font-weight:680;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3);margin:18px 2px 9px}
.set-count{font-size:11px;font-weight:700;color:var(--ink2);background:var(--glass2);border-radius:999px;padding:1px 8px}

/* ── rows ── */
.set-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0}
.set-row + .set-row{border-top:1px solid var(--line)}
.set-row.block{flex-direction:column;align-items:stretch}
.set-row-tx{min-width:0}
.set-row-l{font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink)}
.set-row-d{font-size:12px;color:var(--ink3);line-height:1.5;margin-top:3px}
.set-row-ctl{flex:none}
.set-divider{height:1px;background:var(--line);margin:0 -20px}

.set-link{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;margin-top:2px;padding:11px;border:none;background:none;cursor:pointer;font:inherit;font-size:12.5px;font-weight:550;color:var(--ink3);transition:color .15s}
.set-link:hover{color:var(--cyan)}
.set-link svg{width:14px;height:14px}

/* ── appearance ── */
.set-theme-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px 0}
.set-theme{display:flex;flex-direction:column;gap:0;padding:0;border:1.5px solid var(--line);border-radius:var(--r-sm);background:var(--glass2);cursor:pointer;overflow:hidden;transition:border-color .16s,box-shadow .16s,transform .16s;text-align:left}
.set-theme:hover{transform:translateY(-1px)}
.set-theme.on{border-color:var(--cyan);box-shadow:0 0 0 3px rgba(6,182,212,.14)}
.set-theme-prev{display:block;height:84px;padding:13px;position:relative}
.set-theme-light .set-theme-prev{background:linear-gradient(168deg,#f4f8fd,#e9eff7)}
.set-theme-dark .set-theme-prev{background:linear-gradient(168deg,#0d1626,#0a1120)}
.set-theme-bar{position:absolute;top:0;left:0;right:0;height:9px}
.set-theme-light .set-theme-bar{background:rgba(255,255,255,.7)}
.set-theme-dark .set-theme-bar{background:rgba(255,255,255,.06)}
.set-theme-card{display:block;margin-top:11px;border-radius:9px;padding:9px;box-shadow:inset 0 1px 0 rgba(255,255,255,.4)}
.set-theme-light .set-theme-card{background:rgba(255,255,255,.78)}
.set-theme-dark .set-theme-card{background:rgba(255,255,255,.08);box-shadow:inset 0 1px 0 rgba(255,255,255,.08)}
.set-theme-dot{display:inline-block;width:13px;height:13px;border-radius:50%;background:var(--cyan);box-shadow:0 0 8px rgba(6,182,212,.6)}
.set-theme-line{display:block;height:5px;border-radius:3px;margin-top:7px}
.set-theme-line.short{width:55%}
.set-theme-light .set-theme-line{background:rgba(11,27,48,.16)}
.set-theme-dark .set-theme-line{background:rgba(255,255,255,.16)}
.set-theme-meta{display:flex;flex-direction:column;padding:11px 13px 13px;background:var(--glass)}
.set-theme-l{display:flex;align-items:center;gap:7px;font-size:13.5px;font-weight:680;letter-spacing:-.01em;color:var(--ink)}
.set-theme-chk{display:grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--cyan);color:#fff}
.set-theme-chk svg{width:11px;height:11px;stroke:#fff;stroke-width:3}
.set-theme-s{font-size:11.5px;color:var(--ink3);margin-top:3px}

/* ── account ── */
.set-acct-top{display:flex;align-items:center;gap:15px;padding:14px 0}
.set-avatar{flex:none;width:52px;height:52px;border-radius:16px;display:grid;place-items:center;font-weight:780;font-size:18px;font-family:var(--mono,ui-monospace,monospace);color:#06202a;background:var(--cyan);background-image:linear-gradient(155deg,rgba(255,255,255,.42),rgba(0,0,0,.12));box-shadow:0 10px 24px -10px var(--cyan),inset 0 1px 0 rgba(255,255,255,.4)}
.set-acct-id{flex:1;min-width:0}
.set-name{display:inline-flex;align-items:center;gap:8px;border:none;background:none;cursor:pointer;font:inherit;font-size:18px;font-weight:680;letter-spacing:-.02em;color:var(--ink);padding:0}
.set-name-edit{display:grid;place-items:center;width:15px;height:15px;color:var(--ink3);opacity:0;transition:opacity .15s}
.set-name:hover .set-name-edit{opacity:1}
.set-name-edit svg{width:13px;height:13px}
.set-name-fld{margin-top:0;max-width:280px;font-size:15px;padding:9px 12px}
.set-acct-mail{font-size:13px;color:var(--ink2);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.set-plan{flex:none;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.26);padding:4px 11px;border-radius:999px}

/* ── update ── */
.set-verline{display:flex;align-items:center;justify-content:space-between;padding:11px 18px;margin-bottom:12px;border-radius:var(--r-sm);background:var(--glass2);border:1px solid var(--line);box-shadow:inset 0 1px 0 var(--rim)}
.set-ver-k{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--ink3)}
.set-ver-v{font-size:14px;font-weight:700;font-family:var(--mono,ui-monospace,monospace);color:var(--ink)}
.set-upd{display:flex;align-items:center;gap:15px;padding:17px 18px;margin-bottom:12px}
.set-upd-ic{flex:none;width:42px;height:42px;border-radius:12px;display:grid;place-items:center;color:var(--ink2);background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim)}
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
.set-prog{width:120px;height:6px;border-radius:999px;overflow:hidden;background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim)}
.set-prog-fill{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#22d3ee,#06b6d4);transition:width .25s ease}

/* ── models ── */
.set-list{display:flex;flex-direction:column;padding:6px 14px}
.set-model{display:flex;align-items:center;gap:12px;width:100%;padding:13px 6px;border:none;background:none;cursor:pointer;font:inherit;text-align:left;border-radius:10px;transition:background .14s}
.set-model + .set-model{border-top:1px solid var(--line)}
button.set-model:hover{background:var(--fill-weak)}
.set-model.cloud{cursor:default}
.set-radio{flex:none;width:18px;height:18px;border-radius:50%;border:2px solid var(--line2);display:grid;place-items:center}
.set-model.on .set-radio{border-color:var(--cyan)}
.set-radio i{width:9px;height:9px;border-radius:50%;background:var(--cyan)}
.set-model-glyph{flex:none;width:18px;height:18px;color:var(--ink3)}
.set-model-glyph svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.8}
.set-model-tx{flex:1;min-width:0;display:flex;flex-direction:column}
.set-model-n{font-size:13.5px;font-weight:600;letter-spacing:-.01em;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.set-model-m{font-size:11.5px;color:var(--ink3);margin-top:2px;font-family:var(--mono,ui-monospace,monospace)}
.set-block.tone-err svg{width:30px;height:30px;color:#dc2626;stroke:currentColor;fill:none;stroke-width:1.8}

/* ── connection ── */
.set-conn-top{display:flex;align-items:center;gap:14px;padding:14px 0}
.set-dot{flex:none;width:13px;height:13px;border-radius:50%;position:relative}
.set-dot.ok{background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,.5);animation:set-beat 1.9s ease-out infinite}
.set-dot.err{background:#f87171}
.set-dot.wait{background:#fbbf24}
@keyframes set-beat{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}100%{box-shadow:0 0 0 8px rgba(52,211,153,0)}}
.set-conn-id{flex:1;min-width:0}
.set-conn-name{font-size:15px;font-weight:680;letter-spacing:-.01em;color:var(--ink);display:flex;align-items:center;gap:8px}
.set-conn-url{font-size:12px;color:var(--ink3);margin-top:3px;font-family:var(--mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.set-env{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:3px 8px;border-radius:7px}
.set-env.local{color:#0a9d63;background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.25)}
.set-env.cloud{color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.26)}

/* ── health matrix ── */
.set-health-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:11px}
.set-health-sum{font-size:13px;color:var(--ink2)}
.set-health-sum b{color:var(--ink);font-size:14.5px}
.set-health-t{color:var(--ink3)}
.set-health-act{display:flex;gap:8px;flex:none}
.set-health-act .btn-ghost{margin-top:0}
.set-health{display:flex;align-items:center;gap:13px;padding:13px 6px}
.set-health + .set-health{border-top:1px solid var(--line)}
.set-health-id{flex:1;min-width:0}
.set-health-n{display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:650;letter-spacing:-.01em;color:var(--ink);font-family:var(--mono,ui-monospace,monospace)}
.set-health-url{font-size:11.5px;color:var(--ink3);margin-top:2px;font-family:var(--mono,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.set-health-r{flex:none;display:flex;align-items:center;gap:9px}
.set-health-ms{font-size:11px;color:var(--ink3);font-family:var(--mono,ui-monospace,monospace)}

/* ── about ── */
.set-about{padding:32px 24px}
.set-mark{display:grid;place-items:center;width:72px;height:72px;border-radius:22px;margin:0 auto 16px;color:var(--cyan);background:var(--glass2);box-shadow:inset 0 1px 0 var(--rim),0 14px 34px -16px rgba(6,182,212,.45)}
.set-about-ttl{font-size:23px;font-weight:680;letter-spacing:-.03em}
.set-ver-pill{display:inline-block;margin:10px auto 0;padding:4px 12px;border-radius:999px;font-size:12.5px;font-weight:600;color:var(--cyan-d,#0891b2);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.26)}
.set-about-sub{font-size:13.5px;color:var(--ink2);line-height:1.55;margin:14px auto 0;max-width:42ch}
.set-about-links{display:flex;gap:10px;justify-content:center;margin-top:20px;flex-wrap:wrap}
.set-about-links .btn-ghost{margin-top:0}
.set-about-links svg{width:15px;height:15px}
.set-credits{font-size:11.5px;color:var(--ink3);margin-top:20px}

/* ── spinner ── */
.set-spin{display:inline-block;width:22px;height:22px;border-radius:50%;border:2.2px solid var(--rim);border-top-color:var(--cyan);animation:set-rot .7s linear infinite}
@keyframes set-rot{to{transform:rotate(360deg)}}

@media (prefers-reduced-motion:reduce){
  .set-spin{animation-duration:1.6s}
  .set-sec{animation:none}
  .set-dot.ok{animation:none}
  .set-theme,.set-prog-fill{transition:none}
}
@media (max-width:900px){
  .set-shell{grid-template-columns:1fr}
  .set-side{position:static;padding:18px 8px 4px}
  .set-side-list{flex-direction:row;flex-wrap:wrap;gap:6px}
  .set-nav{width:auto;flex:1 1 auto;min-width:140px}
  .set-pane{padding:14px 14px 48px}
  .set-theme-grid{grid-template-columns:1fr}
}
`}</style>
  );
}

// ════════════════════════════════════════════════════════════════════════
// Plugin module
// ════════════════════════════════════════════════════════════════════════

let root: Root | null = null;
let offCmd: (() => void) | null = null;

const plugin: PluginModule = {
  manifest: {
    id: "settings",
    name: "Einstellungen",
    version: "1.1.0",
    description:
      "Theme, Konto, Updates, Modelle, Benachrichtigungen, Verbindung & App-Info.",
    icon: ICON,
    permissions: [
      "updater",
      "storage",
      "notifications",
      // Health-Matrix probes every real module backend (Verbindung section).
      "backend:atlas-api",
      "backend:u1-chat",
      "backend:sni-api",
      "backend:transcribe-api",
      "backend:memory-agent",
    ],
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
