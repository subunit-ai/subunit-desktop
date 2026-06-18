# Subunit Desktop

The Subunit desktop app — a **Tauri 2 + React shell** that hosts the Subunit
modules. It mirrors the native `subunit-ios` app; both consume the same backends.

The Rust shell skeleton is cloned from the proven `echo-tauri` (updater,
code-signing, loopback-SSO auth). `echo-tauri` itself is a read-only reference —
never edit it from here.

## Modules

Each module is a route in the shell (`src/App.tsx`):

| Module    | Route       | Backend / target                                  |
| --------- | ----------- | ------------------------------------------------- |
| Atlas     | `/atlas`    | atlas-api `/api/m/*` — cited-RAG knowledge console |
| Synapse   | `/synapse`  | atlas-api `/api/m/ingest/:channel` — ingest funnel |
| Chat      | `/chat`     | https://chat.subunit.ai (webview/iframe)          |
| Call      | `/call`     | https://call.subunit.ai (stub)                    |
| Echo      | `/echo`     | launcher/placeholder (echo-tauri is its own app)  |

## Backend config

`src/lib/config.ts` exposes `BACKEND_BASE_URL`, selected via the `VITE_API_BASE`
env var so the same code runs in both modes:

- **local-dev sidecar** — `http://127.0.0.1:7850` (the local atlas-api; runs with
  `AUTH_DEV_BYPASS`, so a token is optional). This is the default when unset.
- **cloud** — `https://atlas-api.subunit.ai` (future Hetzner). Attach a Bearer
  token from `getAuthToken()` (see `src/lib/ipc.ts`).

Copy `.env.example` → `.env.local` to set it.

## Develop

```sh
bun install                 # uses ~/.bun/bin/bun
bun run dev                 # vite on :5174 (frontend only)
bun run tauri dev           # full Tauri app (Rust shell + frontend)
```

## Build

```sh
bun run build               # tsc + vite build → ./dist  (frontendDist = ../dist)
bun run tauri build         # bundle the app (needs cargo + rustc)
```

Build contract:

- Vite dev server: port **5174** (`strictPort`) ↔ `tauri.conf.json` `devUrl`.
- Vite `outDir`: **`dist`** (repo root) ↔ `tauri.conf.json` `frontendDist` `../dist`.

## Auth / IPC contract

The Rust shell exposes these Tauri commands (typed wrappers in `src/lib/ipc.ts`):

| Command             | Signature                  | Notes                                       |
| ------------------- | -------------------------- | ------------------------------------------- |
| `app_version`       | `() -> String`             | CARGO_PKG_VERSION                           |
| `get_account`       | `() -> Account`            | `{email, plan, workspace_id, logged_in}` — NO tokens |
| `get_auth_token`    | `() -> String`             | fresh access token for Bearer-auth; "" when signed out |
| `login`             | `() -> String`             | browser OAuth loopback; resolves to email   |
| `logout`            | `() -> ()`                 | clears the stored session                   |
| `open_external`     | `(url) -> ()`              | http(s) only                                |
| `check_for_updates` | `() -> String`             | new version or "" if up to date             |
| `install_update`    | `() -> ()`                 | download + install + relaunch               |

Events emitted by Rust:

- `subunit://config-changed` — account/plan changed (login/logout/refresh).
- `subunit://update-available` — payload is the new version string.

The loopback-SSO flow is identical to echo-tauri: it opens
`auth.subunit.ai/sonar-login?state=<csrf>&port=<port>` in the browser and waits
on a `127.0.0.1:<port>/callback` redirect. Same accounts.

## Code signing / updater

Same structure as echo-tauri (`tauri.conf.json` `plugins.updater`,
`bundle.macOS.signingIdentity` `-` ad-hoc). The minisign `pubkey` is a
placeholder (`PLACEHOLDER_MINISIGN_PUBKEY_BASE64`) and the signing keys are env
placeholders — wire the real keys before the first release.
