//! assistant.rs — the ubiquitous U1 assistant runs LOCALLY (no remote backend).
//!
//! TJ wants U1 answering without a cloud backend (which hit CORS / op-gating from
//! the webview). Two local providers, switchable in the UI:
//!   · "local"  → a downloaded ollama model (HTTP at 127.0.0.1:11434, streamed)
//!   · "claude" → a Claude Code session over the Max SUBSCRIPTION: the local
//!                `claude -p` CLI (no API key), streamed from its stdout.
//! (More providers can slot in later.)
//!
//! Optional RAG: when the caller passes `memory`, the latest user message is first
//! grounded against the u1 long-term memory (atlas-api `/api/m/search`) and the
//! retrieved chunks are prepended as a system turn — best-effort, never fatal.
//!
//! `u1_ask` returns immediately and does the work on a thread, streaming the answer
//! to the frontend as `u1://delta` events, ending with `u1://done` (or `u1://error`
//! on failure). Each call carries a `requestId` so the UI can ignore stale streams.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

pub const EVENT_U1_DELTA: &str = "u1://delta";
pub const EVENT_U1_DONE: &str = "u1://done";
pub const EVENT_U1_ERROR: &str = "u1://error";

const OLLAMA_CHAT: &str = "http://127.0.0.1:11434/api/chat";
const DEFAULT_LOCAL_MODEL: &str = "qwen2.5:7b-instruct";
/// Hard ceiling per request so a stalled model/CLI can't wedge a thread forever.
/// (The frontend has its own, shorter inactivity watchdog for snappy UX recovery.)
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

/// One chat turn from the frontend (role: system | user | assistant).
#[derive(Debug, Clone, Deserialize)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// Optional RAG grounding for a `u1_ask` turn. When present, assistant.rs queries the
/// u1 long-term memory (atlas-api `/api/m/search`) with the latest user message and
/// prepends the retrieved chunks as a system turn. Best-effort: any failure/empty
/// result simply means u1 answers without extra context.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryOpts {
    /// atlas-api base URL (e.g. http://127.0.0.1:7850 or https://atlas-api.subunit.ai).
    pub base: String,
    /// Bearer for the cloud atlas-api; omit/empty for the local AUTH_DEV_BYPASS sidecar.
    #[serde(default)]
    pub token: Option<String>,
    /// How many chunks to retrieve (default 6, clamped 1..=20).
    #[serde(default)]
    pub n_results: Option<u32>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    request_id: String,
    text: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    request_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    request_id: String,
    message: String,
}

fn emit_delta(app: &AppHandle, id: &str, text: &str) {
    let _ = app.emit(
        EVENT_U1_DELTA,
        DeltaPayload { request_id: id.to_string(), text: text.to_string() },
    );
}
fn emit_done(app: &AppHandle, id: &str) {
    let _ = app.emit(EVENT_U1_DONE, DonePayload { request_id: id.to_string() });
}
fn emit_error(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        EVENT_U1_ERROR,
        ErrorPayload { request_id: id.to_string(), message: message.to_string() },
    );
}

/// A model identifier is only ever used as a CLI/API value; constrain it to a safe
/// charset so it can never be coerced into a flag or shell metacharacter.
fn safe_model(m: &str) -> bool {
    !m.is_empty()
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | ':' | '-' | '_' | '/'))
}

/// Ask U1 locally. Streams the answer via `u1://*` events; returns immediately.
/// When `memory` is supplied, the latest user message is first grounded against the
/// u1 long-term memory (atlas-api) and the retrieved context is prepended.
#[tauri::command]
pub fn u1_ask(
    app: AppHandle,
    request_id: String,
    provider: String,
    model: String,
    messages: Vec<ChatMsg>,
    cwd: Option<String>,
    memory: Option<MemoryOpts>,
) -> Result<(), String> {
    let model = if safe_model(&model) { model } else { String::new() };
    std::thread::spawn(move || {
        // Best-effort RAG grounding before generation (no-op if memory is None or
        // nothing relevant is found).
        let messages = match &memory {
            Some(m) => prepend_memory(m, messages),
            None => messages,
        };
        match provider.as_str() {
            "local" => run_ollama(&app, &request_id, &model, &messages),
            // cwd lets the (agentic) claude CLI read the project the user is working in.
            "claude" => run_claude(&app, &request_id, &model, &messages, cwd.as_deref()),
            other => emit_error(&app, &request_id, &format!("Unbekannter Anbieter: {other}")),
        }
    });
    Ok(())
}

/// One hit from atlas-api `/api/m/search`.
#[derive(Deserialize)]
struct SearchHit {
    title: Option<String>,
    source: Option<String>,
    text: Option<String>,
}
#[derive(Deserialize)]
struct SearchResp {
    results: Option<Vec<SearchHit>>,
}

/// Retrieve grounding context from the u1 long-term memory. Returns a formatted
/// system-prompt block, or None on any error / empty result (best-effort).
fn retrieve_memory(base: &str, token: Option<&str>, query: &str, n: u32) -> Option<String> {
    let url = format!("{}/api/m/search", base.trim_end_matches('/'));
    let mut req = crate::http::client()
        .post(&url)
        .timeout(Duration::from_secs(8))
        .json(&serde_json::json!({ "query": query, "n_results": n }));
    if let Some(t) = token {
        if !t.is_empty() {
            req = req.bearer_auth(t);
        }
    }
    let resp = req.send().ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let results = resp.json::<SearchResp>().ok()?.results.unwrap_or_default();
    let mut ctx = String::from(
        "Kontext aus dem u1-Langzeitgedächtnis (nutze ihn, wenn er zur Frage passt; \
         wenn nicht, ignoriere ihn — erfinde nichts):\n\n",
    );
    let mut used = 0usize;
    for r in results.iter() {
        let text = r.text.as_deref().unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let title = r.title.as_deref().or(r.source.as_deref()).unwrap_or("Quelle");
        let snippet: String = text.chars().take(1200).collect();
        used += 1;
        ctx.push_str(&format!("[{used}] {title}\n{snippet}\n\n"));
    }
    if used == 0 {
        None
    } else {
        Some(ctx)
    }
}

/// Prepend retrieved memory as a leading system turn (no-op if nothing relevant).
fn prepend_memory(m: &MemoryOpts, messages: Vec<ChatMsg>) -> Vec<ChatMsg> {
    let Some(query) = messages
        .iter()
        .rev()
        .find(|x| x.role == "user")
        .map(|x| x.content.clone())
    else {
        return messages;
    };
    let n = m.n_results.unwrap_or(6).clamp(1, 20);
    match retrieve_memory(&m.base, m.token.as_deref(), &query, n) {
        Some(ctx) => {
            let mut out = Vec::with_capacity(messages.len() + 1);
            out.push(ChatMsg { role: "system".to_string(), content: ctx });
            out.extend(messages);
            out
        }
        None => messages,
    }
}

/// Local ollama model via its streaming chat API (no CORS — this is server-side).
fn run_ollama(app: &AppHandle, id: &str, model: &str, messages: &[ChatMsg]) {
    let model = if model.is_empty() { DEFAULT_LOCAL_MODEL } else { model };
    let body = serde_json::json!({
        "model": model,
        "messages": messages.iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect::<Vec<_>>(),
        "stream": true,
    });
    let resp = crate::http::client()
        .post(OLLAMA_CHAT)
        .timeout(REQUEST_TIMEOUT)
        .json(&body)
        .send();
    let resp = match resp {
        Ok(r) => r,
        Err(e) => {
            emit_error(app, id, &format!("Lokales Modell nicht erreichbar (läuft ollama?): {e}"));
            return;
        }
    };
    if !resp.status().is_success() {
        emit_error(app, id, &format!("Lokales Modell antwortete {}", resp.status()));
        return;
    }
    let reader = BufReader::new(resp);
    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(t) = v["message"]["content"].as_str() {
                if !t.is_empty() {
                    emit_delta(app, id, t);
                }
            }
            if v["done"].as_bool() == Some(true) {
                break;
            }
        }
    }
    emit_done(app, id);
}

/// Claude Code over the Max subscription: the local `claude -p` CLI (no API key).
/// We flatten the conversation into a single prompt and stream stdout as it writes.
fn run_claude(app: &AppHandle, id: &str, model: &str, messages: &[ChatMsg], cwd: Option<&str>) {
    let mut sys = String::new();
    let mut turns: Vec<String> = Vec::new();
    for m in messages {
        match m.role.as_str() {
            "system" => {
                if !sys.is_empty() {
                    sys.push_str("\n\n");
                }
                sys.push_str(&m.content);
            }
            "assistant" => turns.push(format!("U1: {}", m.content)),
            _ => turns.push(format!("Nutzer: {}", m.content)),
        }
    }
    // The prompt always begins with "Nutzer:"/"U1:", so it can never be read as a
    // flag — no leading-dash injection risk even though it's a positional arg.
    let prompt = if turns.is_empty() {
        "Hallo".to_string()
    } else {
        turns.join("\n\n")
    };

    let claude = crate::terminal::resolve_cmd("claude");
    let mut cmd = Command::new(&claude);
    cmd.arg("-p");
    if !model.is_empty() {
        cmd.args(["--model", model]);
    }
    if !sys.is_empty() {
        cmd.arg("--append-system-prompt").arg(&sys);
    }
    cmd.arg(&prompt);
    cmd.env("PATH", crate::terminal::child_path());
    // Run in the project the user attached as context (so claude can read its files),
    // falling back to HOME.
    let dir = cwd
        .filter(|c| !c.is_empty() && std::path::Path::new(c).is_dir())
        .map(std::path::PathBuf::from)
        .or_else(dirs::home_dir);
    if let Some(d) = dir {
        cmd.current_dir(d);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(app, id, &format!("Claude (Abo) nicht startbar — ist die Claude-CLI installiert? ({e})"));
            return;
        }
    };

    // Take the pipes BEFORE sharing the child, then drain stderr on its own thread
    // so a full stderr pipe can't deadlock the stdout read.
    let stderr = child.stderr.take();
    let stdout = child.stdout.take();
    let err_handle = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_string(&mut s);
        }
        s
    });

    let child = Arc::new(Mutex::new(child));
    let finished = Arc::new(AtomicBool::new(false));
    let timed_out = Arc::new(AtomicBool::new(false));

    // Watchdog: if claude runs past the ceiling (hang / waiting for input), kill it
    // so the stdout read unblocks and the UI never wedges. The stdout read does NOT
    // hold the child lock, so the watchdog can lock + kill without deadlock.
    {
        let child = child.clone();
        let finished = finished.clone();
        let timed_out = timed_out.clone();
        let app = app.clone();
        let id = id.to_string();
        std::thread::spawn(move || {
            let mut waited = Duration::ZERO;
            let step = Duration::from_millis(200);
            while waited < REQUEST_TIMEOUT {
                if finished.load(Ordering::Acquire) {
                    return;
                }
                std::thread::sleep(step);
                waited += step;
            }
            if !finished.load(Ordering::Acquire) {
                timed_out.store(true, Ordering::Release);
                if let Ok(mut c) = child.lock() {
                    let _ = c.kill();
                }
                emit_error(
                    &app,
                    &id,
                    "Zeitüberschreitung — Claude hat zu lange gebraucht. Nochmal versuchen oder auf „Lokal“ wechseln.",
                );
            }
        });
    }

    if let Some(out) = stdout {
        let mut reader = BufReader::new(out);
        let mut buf = [0u8; 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    if !chunk.is_empty() {
                        emit_delta(app, id, &chunk);
                    }
                }
                Err(_) => break,
            }
        }
    }

    finished.store(true, Ordering::Release);
    let status = child.lock().map(|mut c| c.wait()).unwrap_or_else(|_| {
        Err(std::io::Error::new(std::io::ErrorKind::Other, "lock poisoned"))
    });
    let errtxt = err_handle.join().unwrap_or_default();
    if timed_out.load(Ordering::Acquire) {
        return; // watchdog already emitted the error
    }
    match status {
        Ok(s) if s.success() => emit_done(app, id),
        Ok(s) => {
            let msg = if errtxt.trim().is_empty() {
                format!(
                    "Claude beendet mit Code {} — evtl. nicht eingeloggt? Im Terminal `claude` prüfen.",
                    s.code().unwrap_or(-1)
                )
            } else {
                errtxt.trim().to_string()
            };
            emit_error(app, id, &msg);
        }
        Err(e) => emit_error(app, id, &format!("Claude-Fehler: {e}")),
    }
}
