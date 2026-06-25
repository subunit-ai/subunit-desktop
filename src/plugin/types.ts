/**
 * plugin/types.ts — the Subunit Desktop plugin contract.
 *
 * The shell is a THIN HOST. Every feature surface (Dashboard, Atlas, Synapse,
 * Chat, Call, Echo) is a PLUGIN, registered + mounted/unmounted at runtime by
 * the loader (see loader.ts). v1 ships built-in plugins through the SAME
 * dynamic path that can also load external bundles from the plugins dir.
 *
 * A plugin module's DEFAULT export is a `PluginModule`:
 *
 *   import type { PluginModule } from "../../plugin/types";
 *   const plugin: PluginModule = {
 *     manifest: { id: "dashboard", name: "Dashboard", … },
 *     mount(container, host) { … render into `container` using host.* … },
 *     unmount() { … tear down … },
 *   };
 *   export default plugin;
 *
 * React plugins render into `container` with the HOST-provided React (the host
 * owns the single React instance — do NOT bundle a second one). The mount fn
 * may be async; the loader awaits it.
 *
 * Capabilities reach plugins ONLY through the injected `HostApi`. Every member
 * is permission-gated: a method whose backing permission is not listed in the
 * plugin's `manifest.permissions` throws synchronously on call. Declare what
 * you use.
 */

// ════════════════════════════════════════════════════════════════════════
// Manifest
// ════════════════════════════════════════════════════════════════════════

/** Where a plugin lives in the left dock, and how it's ordered within a group. */
export interface PluginNav {
  /** Dock group. "core" = primary surfaces, "ops" = tooling, "comms" = talk. */
  section: "core" | "ops" | "comms";
  /** Sort order within the section (ascending). */
  order: number;
}

/** A command a plugin contributes to the ⌘K palette via the manifest. */
export interface PluginCommandDecl {
  /** Stable id, unique within the plugin (namespaced by the host as `<pluginId>:<id>`). */
  id: string;
  /** Human title shown in the palette. */
  title: string;
}

/** Permission strings a plugin may declare; gates the matching HostApi surface. */
export type Permission =
  | `backend:${string}` // e.g. "backend:atlas-api" — backend.fetch/sse to that named backend
  | "terminals" // local pty spawn/list/write/kill + output/exit streams
  | "notion" // notion.listTasks / updateTask via the host
  | "notifications" // notifications.notify
  | "storage" // storage.get / set (per-plugin namespaced)
  | "updater" // updater.version / check / install / onAvailable (app self-update)
  | "apps" // marketplace: detect/open/install standalone Subunit apps
  | "ingest" // synapse.ingest → the real n8n axon-ingest webhooks
  | (string & {}); // forward-compatible: unknown permissions are simply ungranted

/**
 * The plugin's identity + declared capabilities. For built-in plugins this is
 * the exported `manifest`; for external bundles it is read from the on-disk
 * `manifest.json` (Tauri `list_plugins`) and re-validated against the module's
 * own exported manifest at load time.
 */
export interface PluginManifest {
  /** Stable unique id (also the dir name for external plugins, and the nav key). */
  id: string;
  /** Display name (dock label, titlebar). */
  name: string;
  /** Semver-ish version string. */
  version: string;
  /** One-line description (palette hint, about). */
  description: string;
  /** Inline SVG string (preferred) OR an asset path. Rendered in the dock. */
  icon: string;
  /** Declared capabilities — see {@link Permission}. */
  permissions: Permission[];
  /** Dock placement. */
  nav: PluginNav;
  /** Optional ⌘K commands contributed via the manifest. */
  commands?: PluginCommandDecl[];
}

// ════════════════════════════════════════════════════════════════════════
// Plugin module shape (the default export contract)
// ════════════════════════════════════════════════════════════════════════

/**
 * The default export of every plugin module (built-in `src/plugins/<id>/index.tsx`
 * or external entry). `mount` renders into `container`; `unmount` (optional)
 * tears down. Both run inside the loader's per-plugin error boundary.
 */
export interface PluginModule {
  manifest: PluginManifest;
  /** Render the plugin into `container`. May be async; the loader awaits it. */
  mount(container: HTMLElement, host: HostApi): void | Promise<void>;
  /** Tear down (unsubscribe, unmount React root, free resources). */
  unmount?(): void;
}

// ════════════════════════════════════════════════════════════════════════
// Domain data shapes
// ════════════════════════════════════════════════════════════════════════

/**
 * Sanitized account view (mirrors `commands::Account` from Rust — NEVER carries
 * tokens). `getToken()` is the only path to a bearer, and it is short-lived.
 */
export interface Account {
  email: string;
  plan: string;
  workspace_id: string;
  logged_in: boolean;
}

/** A local terminal/pty session, as reported by the Tauri terminal commands. */
export interface TermInfo {
  /** Opaque session id returned by `spawn`. */
  id: string;
  /** Display title (from spawn opts or derived from the command). */
  title: string;
  /** The launched command (program). */
  cmd: string;
  /** Optional task linkage (for ops surfaces that tie a pty to a Notion task). */
  taskId?: string;
  /** Whether the pty is still alive (false once the exit event fired). */
  running: boolean;
  /** Project label — the working dir's basename (cockpit grouping); "" if none. */
  project?: string;
}

/** A Notion task surfaced to ops plugins via the host. */
export interface NotionTask {
  id: string;
  title: string;
  status?: string;
  url?: string;
  /** Free-form remaining Notion props (assignee, due, etc.) — plugin-defined use. */
  [key: string]: unknown;
}

// ════════════════════════════════════════════════════════════════════════
// HostApi — the ONLY way plugins reach capabilities (permission-gated)
// ════════════════════════════════════════════════════════════════════════

/** One server-sent event from a `backend.sse` stream. */
export interface SseMessage {
  event: string;
  data: unknown;
}

export interface HostAuth {
  /** Fresh short-lived bearer ("" when signed out / dev-bypass). */
  getToken(): Promise<string>;
  /** Current sanitized account (synchronous snapshot). */
  account(): Account;
  /** Subscribe to account changes; returns an unsubscribe fn. */
  onChange(cb: (account: Account) => void): () => void;
}

export interface HostBackend {
  /** Resolve a named backend to its base URL (e.g. "atlas-api" -> config base). */
  baseUrl(name: string): string;
  /**
   * fetch() against a named backend with the Bearer attached. `path` is joined
   * to the backend base. Gated by the `backend:<name>` permission.
   */
  fetch(name: string, path: string, init?: RequestInit): Promise<Response>;
  /**
   * POST `body` (JSON) and stream the SSE response as an async iterable of
   * `{event,data}`. Bearer attached. Gated by the `backend:<name>` permission.
   */
  sse(name: string, path: string, body?: unknown): AsyncIterable<SseMessage>;
}

/** Options for spawning a local pty. */
export interface TerminalSpawnOpts {
  /** Program to run (defaults to the user's shell when omitted). */
  cmd?: string;
  args?: string[];
  cwd?: string;
  title?: string;
  /** Optional Notion task linkage carried on the resulting TermInfo. */
  taskId?: string;
}

/** A project directory the cockpit can open a terminal in. */
export interface ProjectInfo {
  name: string;
  path: string;
  git: boolean;
}

export interface HostTerminals {
  spawn(opts: TerminalSpawnOpts): Promise<string /* id */>;
  list(): Promise<TermInfo[]>;
  /** Project dirs (~/subunit, ~/Documents…) to spawn a terminal in (cockpit). */
  projects(): Promise<ProjectInfo[]>;
  write(id: string, data: string): Promise<void>;
  kill(id: string): Promise<void>;
  /** Subscribe to output chunks for one pty; returns an unsubscribe fn. */
  onOutput(id: string, cb: (chunk: string) => void): () => void;
  /** Subscribe to the exit of one pty; returns an unsubscribe fn. */
  onExit(id: string, cb: (code: number) => void): () => void;
}

export interface HostNotion {
  listTasks(opts?: { dbId?: string }): Promise<NotionTask[]>;
  updateTask(id: string, patch: Record<string, unknown>): Promise<void>;
}

/** A live command registered at runtime via `nav.registerCommand`. */
export interface HostCommand {
  id: string;
  title: string;
  run: () => void;
}

export interface HostNav {
  /** Switch the active plugin (by id). */
  navigate(pluginId: string): void;
  /** Register a ⌘K command at runtime; returns an unregister fn. */
  registerCommand(cmd: HostCommand): () => void;
}

export interface HostEvents {
  /** Broadcast on a topic to other plugins + the shell. */
  emit(topic: string, data?: unknown): void;
  /** Subscribe to a topic; returns an unsubscribe fn. */
  on(topic: string, cb: (data: unknown) => void): () => void;
}

export interface HostNotifications {
  notify(title: string, body?: string): void;
}

/** Per-plugin namespaced key/value store (persisted via the host). */
export interface HostStorage {
  get(key: string): Promise<unknown>;
  set(key: string, val: unknown): Promise<void>;
}

/** Software-update status reported by the host updater. */
export interface UpdateState {
  /** Currently installed app version (e.g. "0.2.4"). */
  current: string;
  /** Newer version available from the signed release endpoint, or null if up to date. */
  available: string | null;
}

/**
 * App self-update surface, backed by the Tauri minisign updater (the same
 * `latest.json` pipeline the shell ships). Permission-gated by "updater".
 */
export interface HostUpdater {
  /** The currently installed app version. */
  version(): Promise<string>;
  /** Query the release endpoint; resolves installed + available versions. */
  check(): Promise<UpdateState>;
  /**
   * Download + install the pending update and relaunch the app. On success the
   * process restarts so the returned promise never resolves; it REJECTS when no
   * update is pending or the download / signature check fails.
   */
  install(): Promise<void>;
  /** Subscribe to the shell's background "update available" signal; returns an unsubscribe fn. */
  onAvailable(cb: (version: string) => void): () => void;
  /**
   * Subscribe to download progress during install(): `pct` is 0..100, or null
   * when the total size is unknown. Returns an unsubscribe fn.
   */
  onProgress(cb: (pct: number | null) => void): () => void;
}

/** A standalone Subunit app's install state (Echo, Sonar, …). */
export interface AppInstallState {
  installed: boolean;
  /** Installed bundle version, or null when not installed / unreadable. */
  version: string | null;
}

/** Newest release of a standalone app + the download URL of its installer. */
export interface AppRelease {
  version: string;
  dmgUrl: string;
}

/**
 * Marketplace surface — manage standalone Subunit Mac apps (Echo, Sonar) the way
 * Adobe Creative Cloud does: detect installed, fetch the newest release, install
 * /update into /Applications, and launch. Permission-gated by "apps".
 */
export interface HostApps {
  /** Is `<appName>.app` installed in /Applications, and at what version. */
  status(appName: string): Promise<AppInstallState>;
  /** Newest release of a public repo ("owner/name") + its installer URL. */
  latest(repo: string): Promise<AppRelease>;
  /** Launch an installed Mac app (by bundle id, falling back to its name). */
  open(bundleId: string, appName: string): Promise<void>;
  /**
   * Download + install (or update) the app into /Applications. The installed
   * bundle's identifier is verified against `bundleId` before it is swapped in.
   * Resolves when the new bundle is in place; rejects (leaving any existing app
   * intact) on failure.
   */
  install(dmgUrl: string, appName: string, bundleId: string): Promise<void>;
  /** Subscribe to install progress for one app; returns an unsubscribe fn. */
  onProgress(
    appName: string,
    cb: (pct: number | null, phase: string) => void
  ): () => void;
}

/**
 * Synapse ingest — POST a source to the REAL n8n axon-ingest webhooks
 * (n8n.subunit.ai/webhook/synapse/<channel>), routed server-side so the browser
 * CORS/CSP constraints don't apply. Permission-gated by "ingest".
 */
export interface HostIngest {
  /** Channels backed by a real n8n webhook. */
  channels: readonly ["website", "youtube", "document", "meeting"];
  /** POST `payload` (JSON) to the n8n Synapse webhook for `channel`. */
  send(
    channel: "website" | "youtube" | "document" | "meeting",
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; status: number }>;
}

export interface HostUi {
  /** Current theme. */
  theme(): "light" | "dark";
  /** Set the app theme (persists + applies shell-wide). Ungated. */
  setTheme(theme: "light" | "dark"): void;
  /** Subscribe to theme changes; returns an unsubscribe fn. */
  onTheme(cb: (theme: "light" | "dark") => void): () => void;
  /** Open an http(s) URL in the default browser (Rust `open_external`). */
  openExternal(url: string): void;
  /**
   * The host-provided React + ReactDOM client, so plugins render with the
   * shell's single instance instead of bundling a second copy.
   */
  react: HostReact;
}

/**
 * The host's React surface, injected so plugin bundles share ONE React. A
 * built-in plugin can also just `import React from "react"` (same instance in
 * the bundle); external plugins must use this.
 */
export interface HostReact {
  // Intentionally untyped at the module boundary to avoid a hard react type
  // dep in external bundles; built-ins cast it to `typeof React`.
  React: unknown;
  createRoot: (container: Element | DocumentFragment) => {
    render: (children: unknown) => void;
    unmount: () => void;
  };
}

/**
 * The capability surface injected at `mount`. Every method is permission-gated
 * by the owning plugin's `manifest.permissions`; calling an ungranted surface
 * throws. This is the entire contract between a plugin and the world.
 */
export interface HostApi {
  auth: HostAuth;
  backend: HostBackend;
  terminals: HostTerminals;
  notion: HostNotion;
  nav: HostNav;
  events: HostEvents;
  notifications: HostNotifications;
  storage: HostStorage;
  updater: HostUpdater;
  apps: HostApps;
  ingest: HostIngest;
  ui: HostUi;
}
