/**
 * session.ts — auth/workspace session for the Atlas console inside the Subunit shell.
 *
 * atlas-api gates every /api/m/* route behind a Bearer JWT minted by
 * auth.subunit.ai (the same SSO the Desktop shell uses via echo-tauri's loopback
 * flow). Token custody lives in the SHELL, not here:
 *
 *   - The shell's `routes/ModuleHost` calls `primeAtlasToken()` (src/lib/auth.ts)
 *     BEFORE this module mounts and re-primes on `subunit://config-changed`. That
 *     pushes the current bearer into `window.__ATLAS_TOKEN__`. This is the exact
 *     contract atlas-web's original `session.js` expected when hosted in a shell,
 *     so the ported console authenticates with zero extra wiring: we just read
 *     that global.
 *   - In a plain browser dev tab (no shell priming), we fall back to the atlas-web
 *     model: a token in localStorage (`atlas.token`) or `?token=…`, so the module
 *     still runs against a same-origin / VITE_API_BASE backend during development.
 *   - In local-dev bypass mode the sidecar runs with AUTH_DEV_BYPASS, so an empty
 *     token is fine; we synthesise a single "local" workspace so the UI renders.
 *
 * `refreshToken()` is kept as a defensive belt-and-suspenders pull (in case a
 * module is mounted outside the shell's priming path), but the steady-state
 * source of truth is `window.__ATLAS_TOKEN__`.
 *
 * atlas-api derives the per-workspace collection + HMAC signature server-side
 * from the JWT, so the client NEVER names a collection — it only tells the API
 * which of the user's workspaces is active (the JWT's `wss` set bounds what's
 * allowed).
 */

import { getAuthToken, isTauri } from "../../../lib/ipc";
import { IS_LOCAL_DEV } from "../../../lib/config";

const TOKEN_KEY = "atlas.token";
const WS_KEY = "atlas.workspace";

/** JWT payload claims we care about (purely for the UI — the server is authority). */
export interface TokenClaims {
  email?: string;
  ws?: string;
  wss?: string[];
  [k: string]: unknown;
}

declare global {
  interface Window {
    __ATLAS_TOKEN__?: string;
  }
}

function readUrlToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.toString());
      return t;
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * The current bearer (synchronous). Primary source is the shell-primed global
 * `window.__ATLAS_TOKEN__`; in a dev browser tab we read localStorage / the URL.
 */
export function getToken(): string {
  if (typeof window !== "undefined" && window.__ATLAS_TOKEN__) {
    return window.__ATLAS_TOKEN__;
  }
  return readUrlToken() || (typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) || "" : "");
}

/**
 * Defensive token refresh for paths that mount this module WITHOUT the shell's
 * `primeAtlasToken()` having run. In the Tauri shell this pulls a fresh token via
 * the `get_auth_token` IPC and writes it into the global the console reads. In a
 * browser tab it just resolves the dev token. Idempotent / safe to call.
 */
export async function refreshToken(): Promise<string> {
  if (typeof window !== "undefined" && window.__ATLAS_TOKEN__) {
    return window.__ATLAS_TOKEN__;
  }
  if (isTauri()) {
    let token = "";
    try {
      token = (await getAuthToken()) || "";
    } catch {
      token = "";
    }
    if (typeof window !== "undefined") window.__ATLAS_TOKEN__ = token || undefined;
    return token;
  }
  return getToken();
}

/** Set the dev token (browser tab only — the shell owns the token in Tauri). */
export function setToken(token: string): void {
  if (typeof window !== "undefined") window.__ATLAS_TOKEN__ = token || undefined;
  if (isTauri()) return;
  if (typeof localStorage === "undefined") return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function hasToken(): boolean {
  return Boolean(getToken());
}

/**
 * Decode the JWT payload (no verification — purely to read the user's email and
 * the `ws` / `wss` claims for the UI). The server is the only authority.
 */
export function decodeToken(): TokenClaims | null {
  const t = getToken();
  if (!t) return null;
  try {
    const [, payload] = t.split(".");
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json) as TokenClaims;
  } catch {
    return null;
  }
}

export function getActiveWorkspace(): string | null {
  const stored = typeof localStorage !== "undefined" ? localStorage.getItem(WS_KEY) : null;
  if (stored) return stored;
  const claims = decodeToken();
  const fromClaims =
    claims?.ws || (Array.isArray(claims?.wss) ? claims.wss[0] : null) || null;
  if (fromClaims) return fromClaims;
  // local-dev bypass: no token / no claims → synthesise a workspace so the UI renders.
  return IS_LOCAL_DEV ? "local" : null;
}

export function setActiveWorkspace(id: string | null): void {
  if (typeof localStorage === "undefined") return;
  if (id) localStorage.setItem(WS_KEY, id);
  else localStorage.removeItem(WS_KEY);
}

/** The workspace ids the JWT authorizes (used to render the switcher). */
export function getWorkspaceIds(): string[] {
  const claims = decodeToken();
  if (Array.isArray(claims?.wss) && claims.wss.length) return claims.wss;
  const single = claims?.ws;
  if (single) return [single];
  return IS_LOCAL_DEV ? ["local"] : [];
}
