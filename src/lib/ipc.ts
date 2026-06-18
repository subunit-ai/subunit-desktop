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

/** True when running inside the Tauri shell (vs. a plain browser tab). */
export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
