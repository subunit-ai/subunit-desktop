/**
 * plugin/loader.ts — the dynamic plugin registry + mount/unmount lifecycle.
 *
 * The shell is a thin host; this is the machinery that turns plugin MODULES
 * into mounted surfaces:
 *
 *   1. DISCOVER built-in plugins via `import.meta.glob("../plugins/* /index.tsx")`
 *      (lazy dynamic imports — Vite code-splits each plugin).
 *   2. DISCOVER external plugins via the Tauri `list_plugins` command, which
 *      reads `<app_data>/plugins/* /manifest.json`; each is loaded by dynamic
 *      import of its entry (loadExternal).
 *   3. REGISTER each discovered module's manifest (deduped by id; built-ins win
 *      a collision so a stray external bundle can't shadow a core surface).
 *   4. MOUNT/UNMOUNT on nav: only one plugin is mounted at a time into the stage
 *      container; switching unmounts the previous one first.
 *   5. ISOLATE failures: a throw in import/mount/unmount is caught and rendered
 *      as an inline error card — it must NOT take down the shell or other
 *      plugins. Each plugin gets a permission-gated HostApi (makeHostApi).
 *
 * The loader is UI-framework-agnostic: a plugin "mounts" by drawing into a DOM
 * container. Built-in plugins happen to use React (the host's instance), but the
 * loader only ever sees `mount(container, host)` / `unmount()`.
 */

import { invoke } from "@tauri-apps/api/core";
import { HostController, makeHostApi, PLUGIN_COMMANDS } from "./host";
import type { HostApi, PluginManifest, PluginModule } from "./types";
import { isTauri } from "../lib/ipc";

/** A discovered, registered plugin (built-in or external). */
export interface RegisteredPlugin {
  manifest: PluginManifest;
  source: "builtin" | "external";
  /** Lazily import the module (cached after first call). */
  load: () => Promise<PluginModule>;
}

/** What `list_plugins` returns from Rust for each external plugin dir. */
interface ExternalPluginDescriptor {
  id: string;
  dir: string;
  manifestPath: string;
  /** Absolute path / url to the module entry to dynamic-import. */
  entryPath: string;
}

// ── built-in discovery ────────────────────────────────────────────────────
// Each built-in plugin is a separate dynamic chunk under src/plugins/<id>/index.tsx.
// We import each ONCE at discover() to read its manifest, then cache the module.
const BUILTIN_GLOB = import.meta.glob<{ default: PluginModule }>(
  "../plugins/*/index.tsx"
);

// ════════════════════════════════════════════════════════════════════════
// PluginLoader
// ════════════════════════════════════════════════════════════════════════

export class PluginLoader {
  /** All registered plugins, keyed by manifest.id, sorted on read. */
  private registry = new Map<string, RegisteredPlugin>();

  /** The currently mounted plugin + its module + host (for unmount). */
  private active: {
    id: string;
    module: PluginModule;
    host: HostApi;
    container: HTMLElement;
  } | null = null;

  constructor(private ctrl: HostController) {}

  /**
   * Discover + register all plugins (built-in eagerly resolves manifests so the
   * dock can render before any plugin is mounted; external via list_plugins).
   * Idempotent-ish: re-running re-discovers externals (hot plugin install).
   */
  async discover(): Promise<RegisteredPlugin[]> {
    // Built-ins: import each module ONCE to read its manifest, then keep the
    // resolved module cached behind `load`.
    for (const [, importer] of Object.entries(BUILTIN_GLOB)) {
      try {
        const mod = (await importer()).default;
        this.register(mod.manifest, "builtin", () => Promise.resolve(mod));
      } catch (err) {
        console.error("[loader] built-in plugin failed to import:", err);
      }
    }
    // Externals: best-effort; never blocks the shell.
    try {
      for (const reg of await this.discoverExternals()) {
        // Built-ins win id collisions.
        if (this.registry.get(reg.manifest.id)?.source === "builtin") continue;
        this.registry.set(reg.manifest.id, reg);
      }
    } catch (err) {
      console.warn("[loader] external plugin discovery skipped:", err);
    }
    return this.list();
  }

  /** Register one plugin (deduped by id). */
  private register(
    manifest: PluginManifest,
    source: RegisteredPlugin["source"],
    load: () => Promise<PluginModule>
  ): void {
    this.registry.set(manifest.id, { manifest, source, load });
  }

  /** External discovery via Tauri `list_plugins`; no-op in a plain browser. */
  private async discoverExternals(): Promise<RegisteredPlugin[]> {
    if (!isTauri()) return [];
    const descriptors =
      (await invoke<ExternalPluginDescriptor[]>(PLUGIN_COMMANDS.list)) ?? [];
    const out: RegisteredPlugin[] = [];
    for (const d of descriptors) {
      try {
        out.push(await this.loadExternal(d.entryPath));
      } catch (err) {
        console.error(`[loader] external plugin "${d.id}" failed:`, err);
      }
    }
    return out;
  }

  /**
   * Load an external plugin module from its entry path/url and return its
   * registration. Dynamic `import(/* @vite-ignore *​/ entry)` so Vite leaves the
   * runtime URL alone. The module must default-export a PluginModule.
   */
  async loadExternal(entryPath: string): Promise<RegisteredPlugin> {
    const mod: { default: PluginModule } = await import(
      /* @vite-ignore */ entryPath
    );
    const plugin = mod.default;
    if (!plugin?.manifest?.id || typeof plugin.mount !== "function") {
      throw new Error(`invalid plugin entry: ${entryPath}`);
    }
    const reg: RegisteredPlugin = {
      manifest: plugin.manifest,
      source: "external",
      load: () => Promise.resolve(plugin),
    };
    this.registry.set(plugin.manifest.id, reg);
    return reg;
  }

  /** All registered plugins, sorted by section then order then name. */
  list(): RegisteredPlugin[] {
    const sectionRank: Record<string, number> = { core: 0, ops: 1, comms: 2 };
    return [...this.registry.values()].sort((a, b) => {
      const sa = sectionRank[a.manifest.nav.section] ?? 9;
      const sb = sectionRank[b.manifest.nav.section] ?? 9;
      if (sa !== sb) return sa - sb;
      if (a.manifest.nav.order !== b.manifest.nav.order)
        return a.manifest.nav.order - b.manifest.nav.order;
      return a.manifest.name.localeCompare(b.manifest.name);
    });
  }

  get(id: string): RegisteredPlugin | undefined {
    return this.registry.get(id);
  }

  /** The currently mounted plugin id, or null. */
  activeId(): string | null {
    return this.active?.id ?? null;
  }

  /**
   * Mount the plugin `id` into `container`, unmounting whatever was there. A
   * failure in import/mount is caught and rendered as an inline error card; the
   * shell stays alive. Returns true on success, false if it failed/unknown.
   */
  async mount(id: string, container: HTMLElement): Promise<boolean> {
    if (this.active?.id === id) return true;
    await this.unmountActive();

    const reg = this.registry.get(id);
    if (!reg) {
      this.renderError(container, "Unknown plugin", `No plugin registered with id "${id}".`);
      return false;
    }

    container.replaceChildren();
    try {
      const module = await reg.load();
      const host = makeHostApi(reg.manifest, this.ctrl);
      // Re-register manifest commands as live ⌘K entries while mounted.
      const unregisterCmds = (reg.manifest.commands ?? []).map((c) =>
        this.ctrl.registerCommand({
          id: `${reg.manifest.id}:${c.id}`,
          title: c.title,
          run: () => this.ctrl.emit(`command:${reg.manifest.id}:${c.id}`),
        })
      );
      await module.mount(container, host);
      this.active = { id, module, host, container };
      // Stash command unregisters on the active record via closure cleanup.
      this.activeCmdCleanup = () => unregisterCmds.forEach((u) => u());
      return true;
    } catch (err) {
      console.error(`[loader] mount "${id}" failed:`, err);
      this.renderError(
        container,
        `${reg.manifest.name} failed to load`,
        err instanceof Error ? err.message : String(err)
      );
      return false;
    }
  }

  private activeCmdCleanup: (() => void) | null = null;

  /** Unmount the active plugin (if any), isolating teardown failures. */
  async unmountActive(): Promise<void> {
    const a = this.active;
    if (!a) return;
    this.active = null;
    try {
      this.activeCmdCleanup?.();
    } catch (err) {
      console.error("[loader] command cleanup failed:", err);
    }
    this.activeCmdCleanup = null;
    try {
      a.module.unmount?.();
    } catch (err) {
      console.error(`[loader] unmount "${a.id}" failed:`, err);
    }
    a.container.replaceChildren();
  }

  /** Render the inline error-boundary card (design-system glass). */
  private renderError(container: HTMLElement, title: string, msg: string): void {
    const wrap = document.createElement("div");
    wrap.className = "plugin-error";
    const card = document.createElement("div");
    card.className = "plugin-error-card";
    const h = document.createElement("div");
    h.className = "plugin-error-title";
    h.textContent = title;
    const p = document.createElement("div");
    p.className = "plugin-error-msg";
    p.textContent = msg;
    card.append(h, p);
    wrap.append(card);
    container.replaceChildren(wrap);
  }
}
