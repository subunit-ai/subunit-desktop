/**
 * Typed wrappers over the Tauri Rust commands exposed by the shell.
 *
 * Command names + signatures mirror echo-tauri's auth contract verbatim
 * (`login`, `logout`, `app_version`) plus shell extras (`get_account`,
 * `get_auth_token`, `open_external`, updater). Import these instead of calling
 * `invoke` with raw strings so the contract stays in one place.
 *
 * Backend auth: for cloud mode, call `getAuthToken()` and attach it as
 * `Authorization: Bearer <token>` on your fetch() calls to atlas-api. In local
 * dev the sidecar runs with AUTH_DEV_BYPASS, so an empty token is fine.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Sanitized account view from Rust — NEVER contains tokens. */
export interface Account {
  email: string;
  plan: string;
  workspace_id: string;
  logged_in: boolean;
}

/** App version (CARGO_PKG_VERSION). */
export const appVersion = (): Promise<string> => invoke("app_version");

/** Current account (email/plan/logged_in). */
export const getAccount = (): Promise<Account> => invoke("get_account");

/** Fresh access token for Bearer-auth on atlas-api fetches ("" when signed out). */
export const getAuthToken = (): Promise<string> => invoke("get_auth_token");

/** Browser OAuth loopback sign-in. Resolves to the account email (or "Angemeldet"). */
export const login = (): Promise<string> => invoke("login");

/** Sign out (clears the stored session). */
export const logout = (): Promise<void> => invoke("logout");

/** Open an http(s) URL in the default browser. */
export const openExternal = (url: string): Promise<void> =>
  invoke("open_external", { url });

/** Open a local file with the default app (Rust validates: under $HOME, exists, non-executable). */
export const openPath = (path: string): Promise<void> =>
  invoke("open_path", { path });

/** Reveal a local file in Finder (Rust validates: under $HOME, exists). */
export const revealPath = (path: string): Promise<void> =>
  invoke("reveal_path", { path });

/** Check for an update; resolves to the new version or "" if up to date. */
export const checkForUpdates = (): Promise<string> => invoke("check_for_updates");

/** Download + install the pending update, then relaunch. */
export const installUpdate = (): Promise<void> => invoke("install_update");

/** Emitted by Rust when the stored account/plan changes (login/logout/refresh). */
export const onConfigChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen("subunit://config-changed", () => cb());

/** Emitted by Rust when an update is available; payload is the version string. */
export const onUpdateAvailable = (cb: (version: string) => void): Promise<UnlistenFn> =>
  listen<string>("subunit://update-available", (e) => cb(e.payload));

// ── Marketplace: standalone Subunit apps (apps.rs) ──────────────────────────

/** Whether a standalone Mac app is installed, and at what version. */
export interface AppStatusInfo {
  installed: boolean;
  version: string | null;
}
/** Newest GitHub release of a standalone app repo + its aarch64 .dmg URL. */
export interface LatestReleaseInfo {
  version: string;
  dmg_url: string;
}
/** Install progress for a standalone app download/install. */
export interface AppProgressInfo {
  app: string;
  pct: number | null;
  phase: string; // download | mount | install | done
}

// NOTE: Tauri command arg keys must match the Rust parameter names EXACTLY
// (snake_case) — same convention echo-tauri uses (`invoke("…", { rects })` ↔
// `fn …(rects: …)`). Do NOT camelCase these keys.

/** Is `<appName>.app` installed in /Applications + its version. */
export const appStatusOf = (appName: string): Promise<AppStatusInfo> =>
  invoke("app_status", { app_name: appName });

/** Newest release ("owner/name") + its aarch64 .dmg download URL. */
export const appLatest = (repo: string): Promise<LatestReleaseInfo> =>
  invoke("app_latest", { repo });

/** Launch an installed Mac app (by bundle id, falling back to name). */
export const openApp = (bundleId: string, appName: string): Promise<void> =>
  invoke("open_app", { bundle_id: bundleId, app_name: appName });

/** Download + install (or update) a standalone app into /Applications. The
 *  bundle id is verified against the installed bundle before swapping it in. */
export const installApp = (
  dmgUrl: string,
  appName: string,
  bundleId: string
): Promise<void> =>
  invoke("install_app", {
    dmg_url: dmgUrl,
    app_name: appName,
    expected_bundle_id: bundleId,
  });

/** Emitted repeatedly by Rust while a standalone app installs. */
export const onAppProgress = (
  cb: (p: AppProgressInfo) => void
): Promise<UnlistenFn> =>
  listen<AppProgressInfo>("subunit://app-progress", (e) => cb(e.payload));

// ── Synapse → real n8n webhooks (ingest.rs) ────────────────────────────────

/** Result of a Synapse webhook POST. */
export interface SynapseIngestResult {
  ok: boolean;
  status: number;
}

/** POST a JSON payload to the n8n Synapse webhook for `channel` (server-side). */
export const synapseIngest = (
  channel: string,
  payload: Record<string, unknown>
): Promise<SynapseIngestResult> =>
  invoke("synapse_ingest", { channel, payload });

/** Download progress emitted by Rust during `installUpdate`. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  pct: number | null;
}

/** Emitted repeatedly by Rust while an update downloads; payload is {downloaded,total,pct}. */
export const onUpdateProgress = (
  cb: (p: UpdateProgress) => void
): Promise<UnlistenFn> =>
  listen<UpdateProgress>("subunit://update-progress", (e) => cb(e.payload));

/** True when running inside the Tauri shell (vs. a plain browser tab). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
