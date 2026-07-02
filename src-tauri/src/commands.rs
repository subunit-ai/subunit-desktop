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

/// App-wide managed state. The shell holds the persisted account config plus the
/// live local-terminal registry; modules talk to their backends over HTTP from
/// the frontend.
pub struct AppState {
    pub config: Mutex<Config>,
    /// Local PTY sessions spawned by plugins (terminals.rs).
    pub terminals: crate::terminal::TerminalManager,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        Self {
            config: Mutex::new(config),
            terminals: crate::terminal::TerminalManager::new(),
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

// ---- Local source files (Atlas: open / reveal a cited document) ----

/// Canonicalize `input` and require it to be an absolute path that EXISTS and
/// lives under the user's home directory. Returns the canonical path or None.
///
/// canonicalize() resolves `..` and symlinks AND requires existence, so a crafted
/// path cannot escape the home dir via a link or traversal. Confining to $HOME is
/// where the DSGVO-local Atlas raw store lives (…/subunit/atlas/.devdata/raw/…),
/// and keeps the shell from being driven to touch arbitrary system locations.
pub(crate) fn safe_home_path(input: &str) -> Option<std::path::PathBuf> {
    if input.is_empty() {
        return None;
    }
    let p = std::path::Path::new(input);
    if !p.is_absolute() {
        return None;
    }
    let canon = std::fs::canonicalize(p).ok()?;
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from)?;
    let home = std::fs::canonicalize(&home).unwrap_or(home);
    if !canon.starts_with(&home) {
        return None;
    }
    Some(canon)
}

/// Reveal a local file in Finder (selects it in its enclosing folder). The path
/// must be an existing absolute path under the user's home dir. Reveal never
/// executes the target — it only opens Finder at that location — so it is the
/// safe primary action for "show me where this came from".
#[tauri::command]
pub fn reveal_path(path: String) {
    let Some(p) = safe_home_path(&path) else {
        log::warn!("reveal_path: refusing path outside home / nonexistent");
        return;
    };
    // .spawn() (not .status()): hand off to LaunchServices without blocking the
    // event-loop thread on `open`'s exit. The spawn Err is the only thing we use.
    if let Err(e) = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(&p)
        .spawn()
    {
        log::warn!("reveal_path failed: {e}");
    }
}

/// Open a local file with the user's default app (Preview for a PDF, etc.). Same
/// home-confinement as `reveal_path`, PLUS an ALLOWLIST of viewable source-document
/// types. Anything else is refused — executables/bundles, internet-location files
/// (.webloc/.url that dispatch arbitrary URL handlers), and local markup (.html/.svg
/// that runs JS in a file:// origin) — so a crafted cited path can never drive-by
/// execute code or invoke a handler. Directories and extensionless files are refused.
#[tauri::command]
pub fn open_path(path: String) {
    let Some(p) = safe_home_path(&path) else {
        log::warn!("open_path: refusing path outside home / nonexistent");
        return;
    };
    if p.is_dir() {
        log::warn!("open_path: refusing directory");
        return;
    }
    // Viewable document / image / audio-video source types only.
    const ALLOW: &[&str] = &[
        "pdf", "txt", "text", "md", "markdown", "rst", "rtf", "log",
        "csv", "tsv", "json", "yaml", "yml",
        "doc", "docx", "odt", "pages", "ppt", "pptx", "key", "xls", "xlsx", "numbers", "epub",
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tiff", "tif", "bmp",
        "mp3", "m4a", "wav", "aac", "flac", "ogg", "mp4", "m4v", "mov",
    ];
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some(e) if ALLOW.contains(&e) => {}
        _ => {
            log::warn!("open_path: refusing non-viewable type {ext:?}");
            return;
        }
    }
    if let Err(e) = std::process::Command::new("/usr/bin/open").arg(&p).spawn() {
        log::warn!("open_path failed: {e}");
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

/// Download progress emitted to the frontend during `install_update`, so the
/// Settings UI can show a real percentage instead of an indeterminate spinner.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateProgress {
    /// Bytes downloaded so far.
    pub downloaded: u64,
    /// Total bytes, when the server reported a content length.
    pub total: Option<u64>,
    /// 0..100 percentage, or null when the total size is unknown.
    pub pct: Option<u32>,
}

/// Download + install the pending update, then relaunch. Emits
/// `subunit://update-progress` chunks while downloading.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    use tauri_plugin_updater::UpdaterExt;
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no update available".to_string())?;

    let progress_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let pct = total.and_then(|t| {
                    if t > 0 {
                        Some(((downloaded as f64 / t as f64) * 100.0).min(100.0) as u32)
                    } else {
                        None
                    }
                });
                let _ = progress_app.emit(
                    "subunit://update-progress",
                    UpdateProgress {
                        downloaded,
                        total,
                        pct,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
