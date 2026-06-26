//! sessions.rs — discover Claude Code sessions across the Mac (read-only).
//!
//! Claude Code writes every session to
//! `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, appending as the
//! conversation progresses — INCLUDING sessions running in external terminals
//! (Terminal.app / iTerm / VS Code). The cockpit reads these transcripts (it never
//! taps a TTY — macOS can't) to give TJ a live overview of every Claude session:
//! which project it belongs to, what it's working on, its open todos, and whether
//! it's working / waiting for him / idle.
//!
//! Everything here is best-effort and read-only: a malformed transcript, a missing
//! dir, or a failed `lsof` must never panic — we just skip and return what we have.

use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

/// One open todo extracted from a session's latest TodoWrite state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub content: String,
    /// "pending" | "in_progress" | "completed" (Claude's own statuses).
    pub status: String,
}

/// A Claude Code session as surfaced to the cockpit. camelCase for the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    /// Session id (the .jsonl stem / the `sessionId` field in the transcript).
    pub id: String,
    /// Decoded working directory the session runs in.
    pub project_path: String,
    /// Human label — the cwd's basename (cockpit grouping).
    pub project_name: String,
    /// Claude's generated session title (`ai-title`); falls back to the last prompt.
    pub title: String,
    /// The most recent user prompt — "what it's working on".
    pub last_prompt: String,
    /// The latest assistant reply text (a short progress signal); may be empty.
    pub summary: String,
    /// "working" | "waiting" | "idle" | "done" (derived from recency + liveness).
    pub status: String,
    /// True when a running `claude` process currently holds this transcript open.
    pub live: bool,
    /// Last activity (transcript mtime), epoch milliseconds.
    pub last_activity: u64,
    /// Whether the session's working directory still exists on disk.
    pub cwd_exists: bool,
    /// Latest open todos Claude tracked (best-effort; often empty).
    pub todos: Vec<TodoItem>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn truncate(s: &str, n: usize) -> String {
    let s = s.trim().replace(['\n', '\r', '\t'], " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() <= n {
        s
    } else {
        let mut out: String = s.chars().take(n).collect();
        out.push('…');
        out
    }
}

/// Decode `~/.claude/projects/<name>` back to the original cwd.
///
/// Claude encodes the cwd by replacing every `/` with `-`. Because real directory
/// names can also contain `-`, the encoding is ambiguous (e.g.
/// `-Users-tomsync-subunit-subunit-desktop` could split many ways). We resolve it
/// greedily against the real filesystem: at each level, take the LONGEST
/// hyphen-joined token run that names an existing directory; fall back to a single
/// token when nothing matches (the dir was probably deleted).
fn decode_project_path(encoded: &str) -> String {
    let toks: Vec<&str> = encoded
        .trim_start_matches('-')
        .split('-')
        .filter(|t| !t.is_empty())
        .collect();
    if toks.is_empty() {
        return "/".to_string();
    }
    let mut base = std::path::PathBuf::from("/");
    let mut i = 0;
    while i < toks.len() {
        // Greedily extend the segment with hyphen-joined tokens while a longer name
        // exists on disk; commit the longest existing match.
        let mut seg = toks[i].to_string();
        let mut best_len = 1usize;
        let mut probe = toks[i].to_string();
        let mut j = i + 1;
        while j < toks.len() {
            probe = format!("{probe}-{}", toks[j]);
            if base.join(&probe).exists() {
                seg = probe.clone();
                best_len = j - i + 1;
            }
            j += 1;
        }
        // If we couldn't resolve this segment on disk at all, the rest of the path
        // is undecidable (the dir was likely deleted) — keep the remaining tokens
        // hyphen-joined as ONE segment rather than fabricating extra '/' levels.
        if best_len == 1 && !base.join(&seg).exists() {
            base = base.join(toks[i..].join("-"));
            break;
        }
        base = base.join(&seg);
        i += best_len;
    }
    base.to_string_lossy().into_owned()
}

/// True for a canonical session-id (8-4-4-4-12 hex uuid).
fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    s.len() == 36
        && b.iter().enumerate().all(|(i, &c)| match i {
            8 | 13 | 18 | 23 => c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Session ids that a running `claude` process is actively resuming — the precise
/// "this session is live" signal. We scan `ps` for `claude … (-r|--resume) <uuid>`.
/// (claude doesn't hold the transcript fd open, so lsof can't see it; the argv is
/// the reliable source.) Best-effort: empty set if `ps` fails. Bare `claude`
/// sessions without an id in argv fall back to recency.
fn live_session_ids() -> HashSet<String> {
    let mut ids = HashSet::new();
    let out = std::process::Command::new("ps").args(["-Ao", "command="]).output();
    if let Ok(o) = out {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            if !line.contains("claude") {
                continue;
            }
            let toks: Vec<&str> = line.split_whitespace().collect();
            for w in toks.windows(2) {
                if (w[0] == "-r" || w[0] == "--resume") && is_uuid(w[1]) {
                    ids.insert(w[1].to_string());
                }
            }
        }
    }
    ids
}

/// Read up to `max` bytes from the END of a file (cheap tailing of big transcripts).
fn read_tail(path: &Path, max: u64) -> String {
    let mut f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(max);
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

/// Pull display text out of a transcript `message` (content is a string or an array
/// of blocks; we keep only the `text` blocks).
fn extract_text(msg: Option<&serde_json::Value>) -> String {
    let m = match msg {
        Some(m) => m,
        None => return String::new(),
    };
    match m.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => {
            let mut parts = Vec::new();
            for b in arr {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|x| x.as_str()) {
                        parts.push(t);
                    }
                }
            }
            parts.join(" ")
        }
        _ => String::new(),
    }
}

/// Recursively find the latest `todos` array (TodoWrite state) inside a JSON entry.
/// Depth-bounded — transcripts are untrusted and polled often; a pathologically
/// nested payload must not overflow the stack.
fn find_todos(v: &serde_json::Value, depth: usize) -> Option<Vec<TodoItem>> {
    if depth > 200 {
        return None;
    }
    match v {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::Array(arr)) = map.get("todos") {
                let mut out = Vec::new();
                for it in arr {
                    let content = it
                        .get("content")
                        .and_then(|x| x.as_str())
                        .or_else(|| it.get("activeForm").and_then(|x| x.as_str()))
                        .or_else(|| it.get("title").and_then(|x| x.as_str()))
                        .unwrap_or("");
                    if content.is_empty() {
                        continue;
                    }
                    let status = it
                        .get("status")
                        .and_then(|x| x.as_str())
                        .unwrap_or("pending")
                        .to_string();
                    out.push(TodoItem {
                        content: truncate(content, 110),
                        status,
                    });
                }
                if !out.is_empty() {
                    return Some(out);
                }
            }
            for val in map.values() {
                if let Some(r) = find_todos(val, depth + 1) {
                    return Some(r);
                }
            }
            None
        }
        serde_json::Value::Array(arr) => {
            for it in arr {
                if let Some(r) = find_todos(it, depth + 1) {
                    return Some(r);
                }
            }
            None
        }
        _ => None,
    }
}

/// Parse one session transcript (tail) into a [`ClaudeSession`] (project fields
/// filled by the caller). Returns None for an unreadable/empty transcript.
fn parse_session(
    path: &Path,
    mtime_ms: u64,
    now: u64,
    live_ids: &HashSet<String>,
) -> Option<ClaudeSession> {
    let tail = read_tail(path, 96 * 1024);
    if tail.trim().is_empty() {
        return None;
    }

    let mut id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut title = String::new();
    let mut last_prompt = String::new();
    let mut summary = String::new();
    let mut todos: Vec<TodoItem> = Vec::new();

    for line in tail.lines() {
        let line = line.trim();
        if line.is_empty() || !line.starts_with('{') {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // partial first line / non-JSON — skip
        };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("ai-title") => {
                if let Some(t) = v.get("aiTitle").and_then(|x| x.as_str()) {
                    title = t.to_string();
                }
                // Only trust a transcript-supplied sessionId if it's uuid-shaped —
                // this id flows to `claude --resume <id>` via the resume action.
                if let Some(s) = v.get("sessionId").and_then(|x| x.as_str()) {
                    if is_uuid(s) {
                        id = s.to_string();
                    }
                }
            }
            Some("last-prompt") => {
                if let Some(p) = v.get("lastPrompt").and_then(|x| x.as_str()) {
                    last_prompt = p.to_string();
                }
            }
            Some("user") => {
                // extract_text keeps only text blocks, so a tool_result-only user
                // turn yields "" and is naturally skipped; a real prompt is kept.
                let t = extract_text(v.get("message"));
                if !t.trim().is_empty() {
                    last_prompt = t;
                }
            }
            Some("assistant") => {
                let t = extract_text(v.get("message"));
                if !t.trim().is_empty() {
                    summary = t;
                }
            }
            _ => {}
        }
        if let Some(found) = find_todos(&v, 0) {
            todos = found;
        }
    }

    if title.trim().is_empty() {
        title = if !last_prompt.trim().is_empty() {
            truncate(&last_prompt, 60)
        } else {
            "Claude-Session".to_string()
        };
    }

    // Keep only OPEN todos (pending / in_progress), newest state, capped.
    todos.retain(|t| t.status != "completed" && t.status != "done");
    todos.truncate(12);

    let live = live_ids.contains(&id);
    let age = now.saturating_sub(mtime_ms);
    let status = if age < 10_000 {
        "working"
    } else if live {
        "waiting"
    } else if age < 8 * 60_000 {
        "waiting"
    } else if age < 6 * 3_600_000 {
        "idle"
    } else {
        "done"
    }
    .to_string();

    Some(ClaudeSession {
        id,
        project_path: String::new(),
        project_name: String::new(),
        title: truncate(&title, 90),
        last_prompt: truncate(&last_prompt, 220),
        summary: truncate(&summary, 220),
        status,
        live,
        last_activity: mtime_ms,
        cwd_exists: false,
        todos,
    })
}

/// List Claude Code sessions across all known project dirs (newest activity first).
///
/// Read-only: scans `~/.claude/projects/*/*.jsonl`, tail-parses each recent
/// transcript, and cross-references running `claude` processes for liveness. Skips
/// transcripts older than ~10 days and caps the result so a long history stays snappy.
#[tauri::command]
pub fn list_claude_sessions() -> Vec<ClaudeSession> {
    let root = match dirs::home_dir() {
        Some(h) => h.join(".claude/projects"),
        None => return Vec::new(),
    };
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };

    let now = now_ms();
    let home = dirs::home_dir();
    const MAX_AGE_MS: u64 = 10 * 24 * 3_600_000;
    const CAP: usize = 80;

    // 1. Gather candidate transcripts (cheap metadata only) across all projects.
    struct Cand {
        path: std::path::PathBuf,
        mtime: u64,
        project_path: String,
        project_name: String,
        cwd_exists: bool,
    }
    let mut cands: Vec<Cand> = Vec::new();
    for proj in entries.flatten() {
        let pdir = proj.path();
        if !pdir.is_dir() {
            continue;
        }
        let encoded = pdir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let decoded = decode_project_path(&encoded);
        let cwd_exists = Path::new(&decoded).is_dir();
        let project_name = if home.as_deref().map(|h| h.to_string_lossy() == *decoded).unwrap_or(false) {
            "Home (~)".to_string()
        } else {
            Path::new(&decoded)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| encoded.clone())
        };

        // Only top-level .jsonl files are sessions (subdirs like `subagents/` are
        // internal workflow agents — not user terminals).
        let files = match std::fs::read_dir(&pdir) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let p = f.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = match f.metadata() {
                Ok(m) if m.is_file() => m,
                _ => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now.saturating_sub(mtime) > MAX_AGE_MS {
                continue;
            }
            cands.push(Cand {
                path: p,
                mtime,
                project_path: decoded.clone(),
                project_name: project_name.clone(),
                cwd_exists,
            });
        }
    }

    // 2. Newest-first, capped — so we only PARSE (tail-read) the freshest CAP files,
    //    not the user's entire history, on every poll.
    cands.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    cands.truncate(CAP);

    // 3. Parse just those (liveness from running `claude` processes, once).
    let live = live_session_ids();
    let mut out: Vec<ClaudeSession> = Vec::with_capacity(cands.len());
    for c in cands {
        if let Some(mut s) = parse_session(&c.path, c.mtime, now, &live) {
            s.project_path = c.project_path;
            s.project_name = c.project_name;
            s.cwd_exists = c.cwd_exists;
            out.push(s);
        }
    }
    out
}
