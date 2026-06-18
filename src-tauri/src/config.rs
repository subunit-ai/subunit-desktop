//! Minimal on-disk config for the Subunit desktop shell.
//!
//! The shell only needs to persist the Subunit account session (tokens + email +
//! plan) so the loopback-SSO auth flow ported from echo-tauri keeps working
//! verbatim. Module backends (Atlas/Synapse) are reached over HTTP with the
//! access token; the modules themselves hold no extra local state here.
//!
//! File: `<config_dir>/subunit/desktop.json` (e.g. macOS:
//! `~/Library/Application Support/subunit/desktop.json`).

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Directory that holds `desktop.json`. Mirrors echo-tauri's `config_dir()`
/// pattern but under a `subunit/` namespace shared by the whole desktop app.
pub fn config_dir() -> PathBuf {
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("subunit")
}

fn config_path() -> PathBuf {
    config_dir().join("desktop.json")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Account email decoded from the access-token JWT (display only).
    pub account_email: String,
    /// Workspace tier (free/basic/pro/enterprise/...). Display only.
    pub plan: String,
    /// Active workspace id from the OAuth callback.
    pub subunit_workspace_id: String,

    // ---- Subunit cloud session (never sent to the frontend) ----
    pub subunit_access_token: String,
    pub subunit_refresh_token: String,
    pub subunit_token_issued_at: f64,
    pub subunit_token_expires_in: i32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            account_email: String::new(),
            plan: "free".to_string(),
            subunit_workspace_id: String::new(),
            subunit_access_token: String::new(),
            subunit_refresh_token: String::new(),
            subunit_token_issued_at: 0.0,
            subunit_token_expires_in: 0,
        }
    }
}

impl Config {
    /// Load from disk, falling back to defaults on a missing/corrupt file.
    pub fn load() -> Self {
        let path = config_path();
        match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
                log::warn!("config: parse {} failed ({e}) — using defaults", path.display());
                Config::default()
            }),
            Err(_) => Config::default(),
        }
    }

    /// Persist to disk (creates the directory). Best-effort, atomic-ish via a
    /// temp file + rename so a crash mid-write can't truncate the session.
    pub fn save(&self) -> anyhow::Result<()> {
        let dir = config_dir();
        std::fs::create_dir_all(&dir)?;
        let path = config_path();
        let tmp = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(self)?;
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// True if there's any stored session (access or refresh token present).
    pub fn logged_in(&self) -> bool {
        !self.subunit_access_token.is_empty() || !self.subunit_refresh_token.is_empty()
    }
}
