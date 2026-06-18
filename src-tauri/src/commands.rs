//! Tauri IPC commands for the Subunit desktop shell.
//!
//! Auth command names + signatures are kept identical to echo-tauri so the
//! frontend auth contract is portable across both apps:
//!   - `login() -> String`          (account email or "Angemeldet")
//!   - `logout() -> ()`
//!   - `app_version() -> String`
//! Shell extras:
//!   - `get_account() -> Account`   (sanitized: email/plan/logged_in, NO tokens)
//!   - `get_auth_token() -> String` (fresh access token for the frontend's own
//!                                   fetch() calls to atlas-api; "" when signed
//!                                   out — dev mode uses AUTH_DEV_BYPASS so the
//!                                   empty token is fine locally)
//!   - `open_external(url) -> ()`   (http(s) only, opens the default browser)

use crate::config::Config;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// App-wide managed state. The shell only needs the persisted account config;
/// modules talk to their backends over HTTP from the frontend.
pub struct AppState {
    pub config: Mutex<Config>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
        }
    }
}

/// Account view handed to the frontend — secrets blanked. The frontend renders
/// the signed-in email + plan from this; it NEVER receives the raw tokens.
#[derive(Debug, Clone, Serialize)]
pub struct Account {
    pub email: String,
    pub plan: String,
    pub workspace_id: String,
    pub logged_in: bool,
}

#[tauri::command]
pub fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Current account (email/plan/logged_in). No tokens — a future XSS in a hosted
/// module surface must not be able to exfiltrate the session.
#[tauri::command]
pub fn get_account(state: State<'_, AppState>) -> Account {
    let c = state.config.lock();
    Account {
        email: c.account_email.clone(),
        plan: c.plan.clone(),
        workspace_id: c.subunit_workspace_id.clone(),
        logged_in: c.logged_in(),
    }
}

/// A fresh access token for the frontend to attach as `Authorization: Bearer …`
/// on its own fetch() calls to atlas-api (cloud mode). Refreshes first if the
/// token is expiring. Returns "" when signed out — the local dev sidecar runs
/// with AUTH_DEV_BYPASS so an empty token still works there.
#[tauri::command]
pub fn get_auth_token(app: AppHandle) -> String {
    crate::auth::ensure_fresh(&app);
    let st = app.state::<AppState>();
    let c = st.config.lock();
    c.subunit_access_token.clone()
}

/// Sign in via the browser OAuth loopback flow. `auth::login` blocks (waits up to
/// 30 min for the loopback callback), so run it on a blocking thread instead of
/// the command/main thread — otherwise the whole UI freezes until the user
/// finishes (or the timeout fires).
#[tauri::command]
pub async fn login(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || crate::auth::login(&app).map_err(|e| e.to_string()))
        .await
        .map_err(|e| format!("login task: {e}"))?
}

#[tauri::command]
pub fn logout(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let cfg = {
        let mut c = state.config.lock();
        c.subunit_access_token.clear();
        c.subunit_refresh_token.clear();
        c.subunit_token_issued_at = 0.0;
        c.subunit_token_expires_in = 0;
        c.subunit_workspace_id.clear();
        c.account_email.clear();
        c.plan = "free".to_string(); // signed out → no entitlement
        c.clone()
    };
    let res = cfg.save().map_err(|e| e.to_string());
    use tauri::Emitter;
    let _ = app.emit("subunit://config-changed", ());
    res
}

/// Open an external URL in the default browser. Only http(s) links are honoured —
/// a frontend-supplied `file:`, `javascript:` or custom-scheme value must not be
/// able to invoke an arbitrary OS handler.
#[tauri::command]
pub fn open_external(url: String) {
    let ok = url.starts_with("https://") || url.starts_with("http://");
    if !ok {
        log::warn!("open_external: refusing non-web URL");
        return;
    }
    if let Err(e) = tauri_plugin_opener::open_url(url, None::<&str>) {
        log::warn!("open_external failed: {e}");
    }
}

// ---- Updater ----

/// Check for an update; returns the available version or "" if up to date.
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => Ok(update.version),
        Ok(None) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Download + install the pending update, then relaunch.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
