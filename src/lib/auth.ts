/**
 * auth.ts — the shell's thin auth layer.
 *
 * Two runtimes, one surface:
 *   - In the Tauri shell   : delegate to the Rust loopback-SSO commands
 *     (`login` / `logout` / `get_account` / `get_auth_token`, see lib/ipc.ts).
 *     The browser does the OAuth dance against auth.subunit.ai; Rust holds the
 *     tokens and only ever hands us a sanitized `Account` + a fresh bearer.
 *   - In a plain browser   : there's no Rust host, so we fall back to a token in
 *     localStorage (or a `?token=…` URL param) — the local atlas-api runs with
 *     AUTH_DEV_BYPASS, so an empty token is fine while building the frontend.
 *
 * The Atlas/Synapse module surfaces are ported VERBATIM from atlas-web, whose
 * `lib/session.js` reads its bearer from `window.__ATLAS_TOKEN__` when hosted in
 * a shell. So the single most important job here is to keep that global in sync
 * with whatever token is current — `primeAtlasToken()` does exactly that, and we
 * re-prime it on every login/logout and on the Rust `config-changed` event.
 *
 * Nothing here ever exposes a refresh token; `get_auth_token` already refreshes
 * inside Rust and returns only a short-lived access token.
 */

import {
  type Account,
  getAccount,
  getAuthToken,
  isTauri,
  login as ipcLogin,
  logout as ipcLogout,
  onConfigChanged,
} from "./ipc";

/** What the Atlas/Synapse modules read for their bearer (atlas-web session.js). */
declare global {
  interface Window {
    __ATLAS_TOKEN__?: string;
  }
}

const TOKEN_KEY = "atlas.token";

const SIGNED_OUT: Account = {
  email: "",
  plan: "free",
  workspace_id: "",
  avatar_url: "",
  logged_in: false,
};

// ── browser-mode token (dev / running the frontend in a tab) ────────────────

/** Read a dev token from localStorage, promoting a one-shot `?token=…` param. */
function readBrowserToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get("token");
    if (fromUrl) {
      localStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return fromUrl;
    }
  } catch {
    /* ignore malformed URLs */
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Set/clear the dev token (browser mode only). */
export function setBrowserToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be unavailable */
  }
  window.__ATLAS_TOKEN__ = token || undefined;
}

// ── unified token access ────────────────────────────────────────────────────

/**
 * The current bearer token, refreshed when in Tauri. Empty string when signed
 * out (or always, in local-dev where AUTH_DEV_BYPASS makes it optional).
 */
export async function getToken(): Promise<string> {
  if (isTauri()) {
    try {
      return await getAuthToken();
    } catch {
      return "";
    }
  }
  return readBrowserToken();
}

/**
 * Push the current token into `window.__ATLAS_TOKEN__` so the ported atlas-web
 * modules (which read that global) authenticate without any wiring of their own.
 * Safe to call repeatedly; returns the token it primed.
 */
export async function primeAtlasToken(): Promise<string> {
  const token = await getToken();
  if (typeof window !== "undefined") {
    window.__ATLAS_TOKEN__ = token || undefined;
  }
  return token;
}

// ── account ──────────────────────────────────────────────────────────────────

/** Sanitized account view. In browser mode we synthesize one from the token. */
export async function fetchAccount(): Promise<Account> {
  if (isTauri()) {
    try {
      return await getAccount();
    } catch {
      return SIGNED_OUT;
    }
  }
  const token = readBrowserToken();
  if (!token) return SIGNED_OUT;
  const claims = decodeJwt(token);
  return {
    email: claims?.email ?? claims?.sub ?? "dev@local",
    plan: claims?.plan ?? "dev",
    workspace_id: claims?.ws ?? (Array.isArray(claims?.wss) ? claims.wss[0] : "") ?? "",
    avatar_url: claims?.picture ?? "",
    logged_in: true,
  };
}

// ── login / logout ─────────────────────────────────────────────────────────

/**
 * Start sign-in. In Tauri this opens the browser loopback flow and resolves to
 * the account email once the callback lands (the Rust side is spawn_blocking so
 * the UI stays responsive — show a "waiting for browser" state while it runs).
 * In browser mode there's no flow; this is a no-op that just re-primes.
 */
export async function login(): Promise<string> {
  if (isTauri()) {
    const email = await ipcLogin();
    await primeAtlasToken();
    return email;
  }
  await primeAtlasToken();
  return readBrowserToken() ? "dev@local" : "";
}

/** Sign out and clear the Atlas token global. */
export async function logout(): Promise<void> {
  if (isTauri()) {
    await ipcLogout();
  } else {
    setBrowserToken("");
  }
  if (typeof window !== "undefined") window.__ATLAS_TOKEN__ = undefined;
}

/**
 * Subscribe to account changes. In Tauri this listens for the Rust
 * `subunit://config-changed` event; in browser mode it's a no-op unsubscribe.
 * The callback fires AFTER the Atlas token global has been re-primed.
 */
export function onAccountChange(cb: (account: Account) => void): () => void {
  if (!isTauri()) return () => {};
  let unlisten: (() => void) | undefined;
  let cancelled = false;
  onConfigChanged(async () => {
    await primeAtlasToken();
    cb(await fetchAccount());
  }).then((un) => {
    if (cancelled) un();
    else unlisten = un;
  });
  return () => {
    cancelled = true;
    unlisten?.();
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface JwtClaims {
  email?: string;
  sub?: string;
  plan?: string;
  ws?: string;
  wss?: string[];
  /** OIDC: public versioned avatar URL (only present when an avatar exists). */
  picture?: string;
}

/** Decode a JWT payload for display only — the server is the sole authority. */
function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

export type { Account };
