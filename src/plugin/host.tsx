/**
 * plugin/host.tsx — the HostApi implementation + the shell-side host context.
 *
 * The host owns every capability; plugins receive a PER-PLUGIN, permission-gated
 * `HostApi` from {@link makeHostApi}. The shell builds ONE {@link HostController}
 * (account state, theme, command registry, event bus, terminal demux) and hands
 * each mounted plugin a thin facade that:
 *   · attaches the bearer + resolves named backends (config.ts),
 *   · gates every method against the plugin's declared permissions,
 *   · namespaces storage + commands by plugin id,
 *   · routes terminal output/exit by pty id.
 *
 * Wiring sources (all REUSED, nothing reinvented):
 *   · auth      → lib/auth.ts (getToken / fetchAccount / onAccountChange) + lib/ipc.ts
 *   · backend   → lib/config.ts (BACKENDS map) + the bearer from auth
 *   · terminals → Tauri commands  spawn_terminal / list_terminals /
 *                 write_terminal / kill_terminal  + events
 *                 terminal://output  and  terminal://exit
 *   · notion    → Tauri command  notion_list_tasks / notion_update_task (host-side)
 *   · open url  → lib/ipc.ts openExternal (Rust open_external)
 *
 * In a plain browser (no Tauri), terminal/notion fall back to no-ops/throws so
 * the frontend still runs while building.
 */

import React, { createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  fetchAccount,
  getToken as authGetToken,
  onAccountChange,
} from "../lib/auth";
import {
  appVersion,
  checkForUpdates,
  installUpdate,
  isTauri,
  onUpdateAvailable,
  onUpdateProgress,
  openExternal,
} from "../lib/ipc";
import { BACKENDS, BACKEND_BASE_URL } from "../lib/config";
import type {
  Account,
  HostApi,
  HostCommand,
  Permission,
  PluginManifest,
  SseMessage,
  TermInfo,
  TerminalSpawnOpts,
} from "./types";

// ════════════════════════════════════════════════════════════════════════
// Tauri terminal command names the Rust side must expose (the contract).
// ════════════════════════════════════════════════════════════════════════
export const TERMINAL_COMMANDS = {
  spawn: "spawn_terminal", // (opts) -> id: string
  list: "list_terminals", // () -> TermInfo[]
  write: "write_terminal", // (id, data) -> ()
  kill: "kill_terminal", // (id) -> ()
} as const;
export const TERMINAL_EVENTS = {
  /** payload: { id: string; chunk: string } */
  output: "terminal://output",
  /** payload: { id: string; code: number } */
  exit: "terminal://exit",
} as const;

/** Tauri commands for the host-mediated Notion bridge. */
export const NOTION_COMMANDS = {
  list: "notion_list_tasks", // (opts?: { dbId?: string }) -> NotionTask[]
  update: "notion_update_task", // (id, patch) -> ()
} as const;

// PLACEHOLDER tasks until the Notion bridge is wired (TJ: "Notion später, erstmal
// Platzhalter"). The row ACTIONS are fully functional — "Lokal ausführen" really
// spawns a local pty, "Chat mit u1" really seeds the chat plugin; only the task
// SOURCE is mock. To go live: restore invoke(NOTION_COMMANDS.list) in notion.listTasks.
const PLACEHOLDER_TASKS = [
  { id: "t1", title: "Atlas: lokale qwen2.5:7b-Antwortqualität gegen Golden-Fixtures messen", status: "In progress", assignee: "u1" },
  { id: "t2", title: "Synapse: YouTube-Ingest gegen 3 echte Videos verifizieren", status: "Backlog", assignee: "u1" },
  { id: "t3", title: "Dashboard: Terminals an echte Notion-Tasks koppeln", status: "Backlog", assignee: "TJ" },
  { id: "t4", title: "memory-agent: WORKSPACE_GUARD_STRICT scharf schalten (Echo/Meet signieren)", status: "Blocked", assignee: "u1" },
  { id: "t5", title: "atlas-api: Hetzner-Deploy vorbereiten (compose + Tunnel + SSO)", status: "Backlog", assignee: "TJ" },
];

/** Tauri commands for the external-plugin discovery path (loader.ts). */
export const PLUGIN_COMMANDS = {
  /** () -> ExternalPluginDescriptor[] read from the <app_data>/plugins dir. */
  list: "list_plugins",
} as const;

// ════════════════════════════════════════════════════════════════════════
// HostController — the single shell-side capability owner.
// ════════════════════════════════════════════════════════════════════════

type Theme = "light" | "dark";

/** Listener bookkeeping for terminal output/exit, keyed by pty id. */
interface TermListeners {
  output: Set<(chunk: string) => void>;
  exit: Set<(code: number) => void>;
}

export class HostController {
  private account: Account = {
    email: "",
    plan: "free",
    workspace_id: "",
    logged_in: false,
  };
  private accountSubs = new Set<(a: Account) => void>();

  private theme: Theme = "light";
  private themeSubs = new Set<(t: Theme) => void>();

  /** Live ⌘K commands, keyed by namespaced id. */
  readonly commands = new Map<string, HostCommand>();
  private commandSubs = new Set<() => void>();

  /** Cross-plugin event bus. */
  private topics = new Map<string, Set<(d: unknown) => void>>();

  /** Per-pty listeners; populated lazily, fed by the single Tauri event bridge. */
  private terms = new Map<string, TermListeners>();
  private termBridge: Promise<UnlistenFn[]> | null = null;

  /** nav.navigate target — set by the shell. */
  navigate: (pluginId: string) => void = () => {};

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** Load the initial account + theme and subscribe to Rust account changes. */
  async init(): Promise<void> {
    // Sync the controller's theme to whatever main.tsx already applied to <html>
    // (anti-FOUC). The DOM class is the source of truth at boot.
    this.theme = document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";
    this.account = await fetchAccount();
    onAccountChange((a) => {
      this.account = a;
      for (const cb of this.accountSubs) cb(a);
    });
  }

  // ── account ──────────────────────────────────────────────────────────────
  getAccount(): Account {
    return this.account;
  }
  onAccount(cb: (a: Account) => void): () => void {
    this.accountSubs.add(cb);
    return () => this.accountSubs.delete(cb);
  }

  // ── theme ──────────────────────────────────────────────────────────────
  getTheme(): Theme {
    return this.theme;
  }
  setTheme(t: Theme): void {
    if (t === this.theme) return;
    this.theme = t;
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("subunit.theme", t);
    } catch {
      /* storage may be unavailable */
    }
    for (const cb of this.themeSubs) cb(t);
  }
  onTheme(cb: (t: Theme) => void): () => void {
    this.themeSubs.add(cb);
    return () => this.themeSubs.delete(cb);
  }

  // ── commands (⌘K) ────────────────────────────────────────────────────────
  registerCommand(cmd: HostCommand): () => void {
    this.commands.set(cmd.id, cmd);
    this.emitCommands();
    return () => {
      this.commands.delete(cmd.id);
      this.emitCommands();
    };
  }
  onCommands(cb: () => void): () => void {
    this.commandSubs.add(cb);
    return () => this.commandSubs.delete(cb);
  }
  private emitCommands(): void {
    for (const cb of this.commandSubs) cb();
  }

  // ── event bus ──────────────────────────────────────────────────────────
  emit(topic: string, data?: unknown): void {
    const subs = this.topics.get(topic);
    if (subs) for (const cb of [...subs]) cb(data);
  }
  on(topic: string, cb: (d: unknown) => void): () => void {
    let subs = this.topics.get(topic);
    if (!subs) this.topics.set(topic, (subs = new Set()));
    subs.add(cb);
    return () => subs!.delete(cb);
  }

  // ── terminals: single Tauri event bridge → per-id demux ────────────────────
  private listeners(id: string): TermListeners {
    let l = this.terms.get(id);
    if (!l) this.terms.set(id, (l = { output: new Set(), exit: new Set() }));
    return l;
  }
  /** Attach the global terminal://output|exit listeners once. */
  private ensureTermBridge(): Promise<UnlistenFn[]> {
    if (this.termBridge) return this.termBridge;
    if (!isTauri()) return (this.termBridge = Promise.resolve([]));
    this.termBridge = Promise.all([
      listen<{ id: string; chunk: string }>(TERMINAL_EVENTS.output, (e) => {
        const l = this.terms.get(e.payload.id);
        if (l) for (const cb of l.output) cb(e.payload.chunk);
      }),
      listen<{ id: string; code: number }>(TERMINAL_EVENTS.exit, (e) => {
        const l = this.terms.get(e.payload.id);
        if (l) for (const cb of l.exit) cb(e.payload.code);
      }),
    ]);
    return this.termBridge;
  }
  async spawnTerminal(opts: TerminalSpawnOpts): Promise<string> {
    await this.ensureTermBridge();
    return invoke<string>(TERMINAL_COMMANDS.spawn, { opts });
  }
  listTerminals(): Promise<TermInfo[]> {
    if (!isTauri()) return Promise.resolve([]);
    return invoke<TermInfo[]>(TERMINAL_COMMANDS.list);
  }
  writeTerminal(id: string, data: string): Promise<void> {
    return invoke<void>(TERMINAL_COMMANDS.write, { id, data });
  }
  killTerminal(id: string): Promise<void> {
    return invoke<void>(TERMINAL_COMMANDS.kill, { id });
  }
  onTermOutput(id: string, cb: (chunk: string) => void): () => void {
    void this.ensureTermBridge();
    const l = this.listeners(id);
    l.output.add(cb);
    return () => l.output.delete(cb);
  }
  onTermExit(id: string, cb: (code: number) => void): () => void {
    void this.ensureTermBridge();
    const l = this.listeners(id);
    l.exit.add(cb);
    return () => l.exit.delete(cb);
  }
}

// ════════════════════════════════════════════════════════════════════════
// Permission gating
// ════════════════════════════════════════════════════════════════════════

class PermissionError extends Error {
  constructor(pluginId: string, permission: string, member: string) {
    super(
      `Plugin "${pluginId}" called ${member} but did not declare the "${permission}" permission.`
    );
    this.name = "PermissionError";
  }
}

function has(manifest: PluginManifest, perm: Permission): boolean {
  return manifest.permissions.includes(perm);
}

/** Resolve a named backend base URL (config.ts). "atlas-api" → the dev/cloud base. */
function backendBase(name: string): string {
  // The shell's primary backend is atlas-api; named lookups map to the configured
  // base. Additional named backends can be added here as they come online.
  if (name === "atlas-api" || name === "local" || name === "cloud") {
    return name === "local"
      ? BACKENDS.local
      : name === "cloud"
        ? BACKENDS.cloud
        : BACKEND_BASE_URL;
  }
  return BACKEND_BASE_URL;
}

function joinUrl(base: string, path: string): string {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

// ════════════════════════════════════════════════════════════════════════
// makeHostApi — the per-plugin, permission-gated facade.
// ════════════════════════════════════════════════════════════════════════

const reactSurface = {
  React,
  createRoot: (container: Element | DocumentFragment) => {
    const root = createRoot(container);
    return {
      render: (children: unknown) => root.render(children as React.ReactNode),
      unmount: () => root.unmount(),
    };
  },
};

export function makeHostApi(
  manifest: PluginManifest,
  ctrl: HostController
): HostApi {
  const id = manifest.id;
  const ns = (key: string) => `plugin:${id}:${key}`;

  const gate = (perm: Permission, member: string) => {
    if (!has(manifest, perm)) throw new PermissionError(id, perm, member);
  };

  return {
    auth: {
      getToken: () => authGetToken(),
      account: () => ctrl.getAccount(),
      onChange: (cb) => ctrl.onAccount(cb),
    },

    backend: {
      baseUrl: (name) => backendBase(name),
      fetch: async (name, path, init) => {
        gate(`backend:${name}`, "backend.fetch");
        const token = await authGetToken();
        const headers = new Headers(init?.headers);
        if (token) headers.set("Authorization", `Bearer ${token}`);
        return fetch(joinUrl(backendBase(name), path), { ...init, headers });
      },
      sse: (name, path, body) => {
        gate(`backend:${name}`, "backend.sse");
        return sseIterable(name, path, body);
      },
    },

    terminals: {
      spawn: (opts) => {
        gate("terminals", "terminals.spawn");
        return ctrl.spawnTerminal(opts);
      },
      list: () => {
        gate("terminals", "terminals.list");
        return ctrl.listTerminals();
      },
      write: (tid, data) => {
        gate("terminals", "terminals.write");
        return ctrl.writeTerminal(tid, data);
      },
      kill: (tid) => {
        gate("terminals", "terminals.kill");
        return ctrl.killTerminal(tid);
      },
      onOutput: (tid, cb) => {
        gate("terminals", "terminals.onOutput");
        return ctrl.onTermOutput(tid, cb);
      },
      onExit: (tid, cb) => {
        gate("terminals", "terminals.onExit");
        return ctrl.onTermExit(tid, cb);
      },
    },

    notion: {
      listTasks: async (_opts) => {
        gate("notion", "notion.listTasks");
        return PLACEHOLDER_TASKS.map((t) => ({ ...t })); // placeholder until Notion is wired
      },
      updateTask: async (tid, patch) => {
        gate("notion", "notion.updateTask");
        const t = PLACEHOLDER_TASKS.find((x) => x.id === tid);
        if (t) Object.assign(t, patch); // placeholder mutate; real Notion sync later
      },
    },

    nav: {
      navigate: (pluginId) => ctrl.navigate(pluginId),
      registerCommand: (cmd) =>
        ctrl.registerCommand({ ...cmd, id: `${id}:${cmd.id}` }),
    },

    events: {
      emit: (topic, data) => ctrl.emit(topic, data),
      on: (topic, cb) => ctrl.on(topic, cb),
    },

    notifications: {
      notify: (title, body) => {
        gate("notifications", "notifications.notify");
        // Web Notifications API; falls back silently if unavailable/denied.
        try {
          if (typeof Notification !== "undefined") {
            if (Notification.permission === "granted") {
              new Notification(title, { body });
            } else if (Notification.permission !== "denied") {
              void Notification.requestPermission().then((p) => {
                if (p === "granted") new Notification(title, { body });
              });
            }
          }
        } catch {
          /* notifications unavailable */
        }
      },
    },

    storage: {
      get: async (key) => {
        gate("storage", "storage.get");
        try {
          const raw = localStorage.getItem(ns(key));
          return raw == null ? undefined : JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      set: async (key, val) => {
        gate("storage", "storage.set");
        try {
          localStorage.setItem(ns(key), JSON.stringify(val));
        } catch {
          /* storage may be unavailable / quota */
        }
      },
    },

    updater: {
      version: () => {
        gate("updater", "updater.version");
        return isTauri() ? appVersion() : Promise.resolve("dev");
      },
      check: async () => {
        gate("updater", "updater.check");
        if (!isTauri()) return { current: "dev", available: null };
        const [current, available] = await Promise.all([
          appVersion(),
          checkForUpdates(),
        ]);
        return { current, available: available || null };
      },
      install: () => {
        gate("updater", "updater.install");
        if (!isTauri())
          return Promise.reject(
            new Error("Updates sind nur in der Desktop-App verfügbar.")
          );
        return installUpdate();
      },
      onAvailable: (cb) => {
        gate("updater", "updater.onAvailable");
        if (!isTauri()) return () => {};
        let un: (() => void) | null = null;
        let cancelled = false;
        void onUpdateAvailable(cb).then((u) => {
          if (cancelled) u();
          else un = u;
        });
        return () => {
          cancelled = true;
          un?.();
        };
      },
      onProgress: (cb) => {
        gate("updater", "updater.onProgress");
        if (!isTauri()) return () => {};
        let un: (() => void) | null = null;
        let cancelled = false;
        void onUpdateProgress((p) => cb(p.pct)).then((u) => {
          if (cancelled) u();
          else un = u;
        });
        return () => {
          cancelled = true;
          un?.();
        };
      },
    },

    ui: {
      theme: () => ctrl.getTheme(),
      onTheme: (cb) => ctrl.onTheme(cb),
      openExternal: (url) => {
        void openExternal(url).catch(() => {});
      },
      react: reactSurface,
    },
  };
}

/**
 * SSE over fetch — POST `body` (JSON), stream the `text/event-stream` response,
 * yield `{event,data}`. `data` is JSON-parsed when possible, else the raw text.
 * Bearer is attached. Used by HostBackend.sse (already permission-gated).
 */
async function* sseIterable(
  name: string,
  path: string,
  body?: unknown
): AsyncIterable<SseMessage> {
  const token = await authGetToken();
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(joinUrl(backendBase(name), path), {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let evt = "message";
  const flush = (raw: string): SseMessage | null => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0 && event === "message") return null;
    const text = dataLines.join("\n");
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* keep raw text */
    }
    return { event, data };
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // SSE records are separated by a blank line.
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const record = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const msg = flush(record);
        if (msg) yield msg;
      }
    }
    if (buf.trim()) {
      const msg = flush(buf);
      if (msg) yield msg;
    }
  } finally {
    void evt;
    reader.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════════
// React context — shell components reach the controller via useHost().
// ════════════════════════════════════════════════════════════════════════

const HostContext = createContext<HostController | null>(null);

export const HostProvider = HostContext.Provider;

/** Access the shell-side HostController from any shell component. */
export function useHost(): HostController {
  const ctrl = useContext(HostContext);
  if (!ctrl) throw new Error("useHost() called outside <HostProvider>");
  return ctrl;
}
