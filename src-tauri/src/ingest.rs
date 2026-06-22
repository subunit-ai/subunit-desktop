//! Synapse ingest — POST to the REAL n8n axon-ingest webhooks.
//!
//! The production Synapse pipeline runs as n8n workflows whose webhooks live at
//! `https://n8n.subunit.ai/webhook/synapse/<channel>` (website / youtube /
//! document / meeting, POST, no auth). n8n sends no CORS headers, so a webview
//! fetch would be blocked — we POST from Rust instead (server-side, no CORS/CSP),
//! the same pattern as apps.rs. Channel is validated against an allowlist before
//! it's interpolated into the URL.

use serde::Serialize;
use serde_json::Value;

const N8N_BASE: &str = "https://n8n.subunit.ai/webhook/synapse";
const CHANNELS: [&str; 4] = ["website", "youtube", "document", "meeting"];

#[derive(Debug, Clone, Serialize)]
pub struct IngestResult {
    pub ok: bool,
    pub status: u16,
}

/// POST `payload` (JSON) to the n8n Synapse webhook for `channel`.
#[tauri::command]
pub async fn synapse_ingest(channel: String, payload: Value) -> Result<IngestResult, String> {
    if !CHANNELS.contains(&channel.as_str()) {
        return Err(format!("unbekannter Synapse-Kanal: {channel}"));
    }
    let url = format!("{N8N_BASE}/{channel}");
    tauri::async_runtime::spawn_blocking(move || -> Result<IngestResult, String> {
        // Do NOT follow redirects: the webhooks sit behind Cloudflare Access, which
        // 302-redirects unauthenticated requests to a login page. Following that
        // would turn a real failure into a misleading 200. A 3xx/4xx/5xx is honestly
        // surfaced as ok:false with its status so the UI never fakes success.
        let client = reqwest::blocking::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(45))
            .build()
            .map_err(|e| e.to_string())?;
        let res = client
            .post(&url)
            .header("User-Agent", "Subunit-Desktop")
            .json(&payload)
            .send()
            .map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        Ok(IngestResult {
            ok: (200..300).contains(&status),
            status,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
