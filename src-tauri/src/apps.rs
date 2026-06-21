//! Marketplace backend — detect / open / install standalone Subunit apps
//! (Echo, Sonar, …) the way Adobe Creative Cloud manages its apps.
//!
//! Four commands, all hardened against the obvious foot-guns (a plugin with the
//! "apps" capability must not be able to rm/-rf an arbitrary path or download
//! from an arbitrary host):
//!   · app_status(app_name)            → installed? + bundle version
//!   · app_latest(repo)                → newest GitHub release + its aarch64 .dmg
//!   · open_app(bundle_id, app_name)   → launch the installed Mac app
//!   · install_app(dmg_url, app_name)  → download → mount → stage → swap into
//!                                       /Applications, emitting progress
//!
//! install_app stages the new bundle next to the target and only swaps it in once
//! the copy fully succeeds, so a mid-install failure leaves the existing app intact.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Emitter};

// ── validation ──────────────────────────────────────────────────────────────

/// A safe app name = a plain bundle base name (no path separators / traversal).
/// We interpolate this into `/Applications/<name>.app` and an `rm -rf`, so it
/// MUST be tightly constrained.
fn valid_app_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '.' | '_' | '-'))
}

/// Only download installer images from OUR GitHub org's releases. Tighter than a
/// bare github.com check — a plugin can't point install_app at a stranger's repo.
fn allowed_dmg_url(url: &str) -> bool {
    url.starts_with("https://github.com/subunit-ai/")
}

/// Read CFBundleIdentifier from a bundle's Info.plist (identity verification).
fn bundle_identifier(app: &Path) -> Option<String> {
    let plist = app.join("Contents/Info.plist");
    Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(&plist)
        .arg("CFBundleIdentifier")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn app_path(app_name: &str) -> PathBuf {
    PathBuf::from(format!("/Applications/{app_name}.app"))
}

/// Read CFBundleShortVersionString from an installed bundle's Info.plist.
fn bundle_version(app: &Path) -> Option<String> {
    let plist = app.join("Contents/Info.plist");
    Command::new("/usr/bin/defaults")
        .arg("read")
        .arg(&plist)
        .arg("CFBundleShortVersionString")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

// ── app_status ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AppStatus {
    pub installed: bool,
    pub version: Option<String>,
}

/// Is `<app_name>.app` in /Applications, and at what version?
#[tauri::command]
pub fn app_status(app_name: String) -> Result<AppStatus, String> {
    if !valid_app_name(&app_name) {
        return Err("invalid app name".into());
    }
    let p = app_path(&app_name);
    if !p.exists() {
        return Ok(AppStatus {
            installed: false,
            version: None,
        });
    }
    Ok(AppStatus {
        installed: true,
        version: bundle_version(&p),
    })
}

// ── app_latest ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct LatestRelease {
    pub version: String,
    pub dmg_url: String,
}

/// Newest release of a public GitHub repo ("owner/name") + the browser download
/// URL of its `*aarch64.dmg` asset. Done in Rust so the webview CSP needn't open
/// up to api.github.com.
#[tauri::command]
pub async fn app_latest(repo: String) -> Result<LatestRelease, String> {
    if repo.contains("..") || repo.contains(' ') || repo.matches('/').count() != 1 {
        return Err("invalid repo".into());
    }
    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let body = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let res = crate::http::client()
            .get(&url)
            .header("User-Agent", "Subunit-Desktop")
            .header("Accept", "application/vnd.github+json")
            .send()
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("github api {}", res.status()));
        }
        res.text().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    let v: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let version = v
        .get("tag_name")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .trim_start_matches('v')
        .to_string();
    let dmg_url = v
        .get("assets")
        .and_then(|a| a.as_array())
        .and_then(|arr| {
            arr.iter().find_map(|a| {
                let name = a.get("name")?.as_str()?;
                if name.ends_with("aarch64.dmg") {
                    a.get("browser_download_url")?.as_str().map(str::to_string)
                } else {
                    None
                }
            })
        })
        .ok_or_else(|| "no aarch64 .dmg in latest release".to_string())?;
    Ok(LatestRelease { version, dmg_url })
}

// ── open_app ─────────────────────────────────────────────────────────────────

/// Launch an installed Mac app — by bundle id first, falling back to its name.
#[tauri::command]
pub fn open_app(bundle_id: String, app_name: String) -> Result<(), String> {
    if !valid_app_name(&app_name) {
        return Err("invalid app name".into());
    }
    if !bundle_id.is_empty()
        && bundle_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        let by_id = Command::new("/usr/bin/open").arg("-b").arg(&bundle_id).status();
        if matches!(by_id, Ok(s) if s.success()) {
            return Ok(());
        }
    }
    let by_name = Command::new("/usr/bin/open")
        .arg("-a")
        .arg(&app_name)
        .status()
        .map_err(|e| e.to_string())?;
    if by_name.success() {
        Ok(())
    } else {
        Err(format!("could not open {app_name}"))
    }
}

// ── install_app ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
struct AppProgress {
    app: String,
    /// 0..100, or null when the download size is unknown.
    pct: Option<u32>,
    /// "download" | "mount" | "install" | "done"
    phase: String,
}

/// Download the DMG, mount it, stage the bundle and swap it into /Applications.
/// Emits `subunit://app-progress` throughout. Rejects (leaving any existing app
/// intact) on any failure.
#[tauri::command]
pub async fn install_app(
    app: AppHandle,
    dmg_url: String,
    app_name: String,
    expected_bundle_id: String,
) -> Result<(), String> {
    if !valid_app_name(&app_name) {
        return Err("invalid app name".into());
    }
    if !allowed_dmg_url(&dmg_url) {
        return Err("installer URL is not from a trusted host".into());
    }

    let handle = app.clone();
    let name = app_name.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};

        let emit = |pct: Option<u32>, phase: &str| {
            let _ = handle.emit(
                "subunit://app-progress",
                AppProgress {
                    app: name.clone(),
                    pct,
                    phase: phase.into(),
                },
            );
        };

        // Per-invocation unique temp paths (process id + nanos) so concurrent
        // installs don't collide and a local attacker can't pre-create / hijack a
        // predictable mount point.
        let uniq = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let tmp_dmg = std::env::temp_dir().join(format!("subunit-{name}-{uniq}.dmg"));
        let mount = std::env::temp_dir().join(format!("subunit-mnt-{name}-{uniq}"));

        // 1) download → temp .dmg, streaming with progress (download = 0..90%).
        emit(Some(0), "download");
        let mut res = crate::http::client()
            .get(&dmg_url)
            .header("User-Agent", "Subunit-Desktop")
            .send()
            .map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Err(format!("download {}", res.status()));
        }
        let total = res.content_length();
        let mut file = std::fs::File::create(&tmp_dmg).map_err(|e| e.to_string())?;
        let mut downloaded: u64 = 0;
        let mut buf = [0u8; 65536];
        loop {
            let n = res.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            downloaded += n as u64;
            if let Some(t) = total {
                if t > 0 {
                    emit(Some(((downloaded as f64 / t as f64) * 90.0) as u32), "download");
                }
            }
        }
        drop(file);

        // 2) mount (private mount point, no Finder window).
        emit(Some(92), "mount");
        let _ = std::fs::create_dir_all(&mount);
        let attached = Command::new("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-noverify", "-noautoopen", "-mountpoint"])
            .arg(&mount)
            .arg(&tmp_dmg)
            .status()
            .map_err(|e| e.to_string())?;
        if !attached.success() {
            let _ = std::fs::remove_file(&tmp_dmg);
            let _ = std::fs::remove_dir_all(&mount);
            return Err("hdiutil attach failed".into());
        }
        // Tear down + remove the mount point + the temp dmg in one place, run on
        // EVERY exit path below.
        let cleanup = || {
            let _ = Command::new("/usr/bin/hdiutil")
                .args(["detach", "-force"])
                .arg(&mount)
                .status();
            let _ = std::fs::remove_dir_all(&mount);
            let _ = std::fs::remove_file(&tmp_dmg);
        };

        // 3) locate the bundle. Reject a symlinked .app (a malicious DMG could
        //    point it outside the mount).
        emit(Some(95), "install");
        let src = mount.join(format!("{name}.app"));
        match std::fs::symlink_metadata(&src) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => {
                cleanup();
                return Err(format!("{name}.app in the DMG is not a real bundle"));
            }
            Err(_) => {
                cleanup();
                return Err(format!("{name}.app not found inside the DMG"));
            }
        }

        // 4) stage next to the target, then verify identity BEFORE swapping in.
        let dst = app_path(&name);
        let staged = PathBuf::from(format!("/Applications/.{name}.app.staged-{uniq}"));
        let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
        let copied = Command::new("/bin/cp")
            .arg("-R")
            .arg(&src)
            .arg(&staged)
            .status()
            .map_err(|e| e.to_string());
        cleanup();
        let copied = copied.map_err(|e| {
            let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
            e
        })?;
        if !copied.success() {
            let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
            return Err("copy into /Applications failed (permission?)".into());
        }

        // Identity gate: the staged bundle MUST carry the bundle id we expect, so a
        // tampered/wrong DMG can't be installed under a trusted app's name.
        if !expected_bundle_id.is_empty() {
            match bundle_identifier(&staged) {
                Some(id) if id == expected_bundle_id => {}
                got => {
                    let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
                    return Err(format!(
                        "bundle identity mismatch (expected {expected_bundle_id}, got {})",
                        got.unwrap_or_else(|| "none".into())
                    ));
                }
            }
        }

        // 5) swap: park the old app aside, move the new one in, only then drop the
        //    old — so a failed move can be rolled back and never destroys the
        //    installed app.
        let backup = PathBuf::from(format!("/Applications/.{name}.app.bak-{uniq}"));
        if dst.exists() {
            let parked = Command::new("/bin/mv")
                .arg(&dst)
                .arg(&backup)
                .status()
                .map_err(|e| e.to_string())?;
            if !parked.success() {
                let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
                return Err("could not replace the existing app (permission?)".into());
            }
        }
        let moved = Command::new("/bin/mv")
            .arg(&staged)
            .arg(&dst)
            .status()
            .map_err(|e| e.to_string())?;
        if !moved.success() {
            // restore the old app from backup, drop the staged copy.
            if backup.exists() {
                let _ = Command::new("/bin/mv").arg(&backup).arg(&dst).status();
            }
            let _ = Command::new("/bin/rm").args(["-rf"]).arg(&staged).status();
            return Err("could not move the new app into place".into());
        }
        let _ = Command::new("/bin/rm").args(["-rf"]).arg(&backup).status();

        // clear quarantine so first launch isn't Gatekeeper-gated (our apps are
        // ad-hoc signed); only reached once identity is verified above.
        let _ = Command::new("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine"])
            .arg(&dst)
            .status();

        emit(Some(100), "done");
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(())
}
