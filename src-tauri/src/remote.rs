//! remote.rs — Server-Terminals (tmux auf subunit-server) im Cockpit.
//!
//! „Zwei Hände, ein Gehirn": die u1-Bot-/Arbeits-Sessions laufen als tmux auf
//! dem Server; das Cockpit zeigt sie neben den lokalen Claude-Sessions.
//! Read-Lane: `tmux list-sessions` + `capture-pane`. Write-Lane: `send-keys`,
//! hart auf `unitone*`-Sessions begrenzt (nie in fremde/main-Sessions tippen).
//!
//! SSH nutzt die User-Config (`Host subunit-server`, Cloudflare-ProxyCommand) —
//! GUI-Apps erben einen minimalen PATH, in dem `cloudflared` fehlt, deshalb
//! bekommt der ssh-Prozess den erweiterten `child_path()` aus terminal.rs.

use serde::Serialize;
use std::process::Command;

const SSH_HOST: &str = "subunit-server";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSession {
    pub name: String,
    pub attached: bool,
    /// Letzte tmux-Aktivität, epoch ms.
    pub last_activity: u64,
}

/// Session-Namen strikt validieren — sie landen in einer remote Shell-Zeile.
fn valid_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// POSIX-Single-Quote fürs Remote-Ende (ssh joint argv zu einer Shell-Zeile).
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn ssh_output(remote_cmd: &str, timeout_hint: u64) -> Result<String, String> {
    let mut cmd = Command::new("/usr/bin/ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg(format!("ConnectTimeout={timeout_hint}"))
        .arg(SSH_HOST)
        .arg(remote_cmd)
        .env("PATH", crate::terminal::child_path());
    let out = cmd.output().map_err(|e| format!("ssh: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("ssh fehlgeschlagen: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Alle tmux-Sessions auf dem Server (Name, attached, letzte Aktivität).
#[tauri::command]
pub async fn list_remote_sessions() -> Result<Vec<RemoteSession>, String> {
    // Blocking ssh in einem async command → Tauri führt es auf einem Worker aus;
    // spawn_blocking hält den Main-Thread garantiert frei.
    tauri::async_runtime::spawn_blocking(|| {
        let raw = ssh_output(
            "tmux list-sessions -F '#{session_name}|#{session_attached}|#{session_activity}' 2>/dev/null || true",
            6,
        )?;
        let mut out = Vec::new();
        for line in raw.lines() {
            let mut it = line.trim().splitn(3, '|');
            let (Some(name), Some(att), Some(act)) = (it.next(), it.next(), it.next()) else {
                continue;
            };
            if !valid_session(name) {
                continue;
            }
            out.push(RemoteSession {
                name: name.to_string(),
                attached: att != "0",
                last_activity: act.parse::<u64>().unwrap_or(0) * 1000,
            });
        }
        out.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        Ok(out)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Die letzten `lines` Zeilen einer Server-Session (Plaintext, ohne ANSI).
#[tauri::command]
pub async fn remote_capture(session: String, lines: u32) -> Result<String, String> {
    if !valid_session(&session) {
        return Err("ungültiger Session-Name".into());
    }
    let n = lines.clamp(5, 200);
    tauri::async_runtime::spawn_blocking(move || {
        ssh_output(
            &format!(
                "tmux capture-pane -p -t {} -S -{n} 2>/dev/null | sed -e 's/[[:space:]]*$//'",
                sh_quote(&session)
            ),
            6,
        )
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Text (+Enter) in eine Server-Session tippen — NUR `unitone*` (u1-Sessions).
/// Literal via `send-keys -l`, Enter separat; Text wird sh-gequotet.
#[tauri::command]
pub async fn remote_send(session: String, text: String) -> Result<(), String> {
    if !valid_session(&session) || !session.starts_with("unitone") {
        return Err("Senden ist nur an unitone-Sessions erlaubt".into());
    }
    let oneline = text
        .replace(['\n', '\r', '\u{2028}', '\u{2029}'], " ")
        .trim()
        .to_string();
    if oneline.is_empty() {
        return Err("leerer Text".into());
    }
    if oneline.len() > 4000 {
        return Err("Text zu lang".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let s = sh_quote(&session);
        ssh_output(
            &format!(
                "tmux send-keys -t {s} -l -- {} && sleep 0.15 && tmux send-keys -t {s} Enter",
                sh_quote(&oneline)
            ),
            8,
        )
        .map(|_| ())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
