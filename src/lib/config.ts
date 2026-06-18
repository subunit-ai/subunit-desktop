/**
 * Backend configuration for the Subunit desktop shell.
 *
 * Two modes, selected by the VITE_API_BASE env var so the SAME code runs in
 * both without a rebuild branch:
 *   - local-dev sidecar : http://127.0.0.1:7850   (the local atlas-api we run;
 *                         it has AUTH_DEV_BYPASS so a token is optional)
 *   - cloud             : https://atlas-api.subunit.ai   (future Hetzner)
 *
 * Set it in `.env.local` (gitignored) or the shell env, e.g.
 *   VITE_API_BASE=http://127.0.0.1:7850   bun run dev
 * If unset we default to the local dev sidecar — the common path while building.
 */

const LOCAL_DEV = "http://127.0.0.1:7850";
const CLOUD = "https://atlas-api.subunit.ai";

export const BACKEND_BASE_URL: string =
  import.meta.env.VITE_API_BASE?.replace(/\/+$/, "") ?? LOCAL_DEV;

/** True when we're pointed at the local dev sidecar (auth optional). */
export const IS_LOCAL_DEV = BACKEND_BASE_URL === LOCAL_DEV;

/** Convenience map for callers that want to show/switch the target. */
export const BACKENDS = { local: LOCAL_DEV, cloud: CLOUD } as const;

/** Build a full API URL from a path (e.g. `api("/api/m/query")`). */
export function api(path: string): string {
  return `${BACKEND_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Alias for {@link api} — spelled out for shell-side callers. */
export const apiUrl = api;
