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

/**
 * u1-chat — the shared chat/team backend (same one the subunit-ios app talks to).
 * Powers persistent KI threads (`/api/threads/*`), team DMs/groups (`/api/team/*`),
 * tasks (`/api/tasks`) and projects. Bearer-authed with the SAME Subunit token as
 * atlas-api (auth.subunit.ai, audience "first-party"). It is NOT VITE_API_BASE-
 * switched: chat is always the cloud service (no local sidecar).
 */
const U1_CHAT = "https://chat.subunit.ai";

/**
 * Additional named module backends (the desktop hosts more than atlas-api now).
 * All Bearer-authed with the SAME Subunit token (auth.subunit.ai, audience
 * "first-party"); each is reachable via host.backend.fetch("<name>", …) once the
 * plugin declares the matching `backend:<name>` permission.
 *   · sni-api        → the u1 nervous-system telemetry service (live GPU/cron/cost)
 *   · transcribe-api → Echo's transcription / help backend
 *   · memory-agent   → the local semantic memory API (ChromaDB/bge-m3); the same
 *                      engine atlas-api wraps for /api/m/search. Local-only.
 */
const SNI = "https://sni.subunit.ai";
const TRANSCRIBE = "https://transcribe.subunit.ai";
const MEMORY_AGENT = "http://127.0.0.1:8001";

export const BACKEND_BASE_URL: string =
  import.meta.env.VITE_API_BASE?.replace(/\/+$/, "") ?? LOCAL_DEV;

/** True when we're pointed at the local dev sidecar (auth optional). */
export const IS_LOCAL_DEV = BACKEND_BASE_URL === LOCAL_DEV;

/**
 * The named-backend registry — the SINGLE SOURCE OF TRUTH for `backendBase()` in
 * host.tsx. Add a module backend HERE (one line) instead of editing host routing.
 * `atlas-api` intentionally follows VITE_API_BASE (sidecar in dev, cloud in prod);
 * the rest are fixed services.
 */
export const BACKENDS = {
  local: LOCAL_DEV,
  cloud: CLOUD,
  "atlas-api": BACKEND_BASE_URL,
  "u1-chat": U1_CHAT,
  "sni-api": SNI,
  "transcribe-api": TRANSCRIBE,
  "memory-agent": MEMORY_AGENT,
} as const;

/** A registered backend name. */
export type BackendName = keyof typeof BACKENDS;

/** Build a full API URL from a path (e.g. `api("/api/m/query")`). */
export function api(path: string): string {
  return `${BACKEND_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

/** Alias for {@link api} — spelled out for shell-side callers. */
export const apiUrl = api;
