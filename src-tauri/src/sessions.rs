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

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::Command;
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
    /// Controlling TTY of the live `claude` process (e.g. "ttys014") — lets the
    /// cockpit bring the REAL Terminal.app tab to the front. None if not mapped.
    pub tty: Option<String>,
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

/// A running `claude` CLI process and what we can learn about it from `ps`/`lsof`.
struct LiveProc {
    pid: String,
    /// Controlling TTY ("ttys014") — the handle to its real Terminal.app tab.
    tty: Option<String>,
    /// The session uuid it's resuming, if launched with `-r/--resume <uuid>`.
    uuid: Option<String>,
    /// Working directory (only resolved for bare sessions, to map them by project).
    cwd: Option<String>,
}

/// Enumerate running `claude` CLI processes (pid + tty + resume-uuid), then resolve
/// the cwd of the bare ones via a single `lsof`. This is how the cockpit knows a
/// session is live AND which real terminal tab it lives in.
fn live_claude_procs() -> Vec<LiveProc> {
    let mut procs: Vec<LiveProc> = Vec::new();
    let out = match Command::new("ps").args(["-Ao", "pid=,tty=,command="]).output() {
        Ok(o) => o,
        Err(_) => return procs,
    };
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if !line.contains("claude") {
            continue;
        }
        let toks: Vec<&str> = line.split_whitespace().collect();
        if toks.len() < 3 {
            continue;
        }
        // Columns: pid, tty, then the command (argv0 = toks[2]). Only real `claude`
        // CLI processes — not a shell or `grep claude` that merely mentions it.
        let argv0 = toks[2];
        let is_claude = std::path::Path::new(argv0)
            .file_name()
            .map(|n| n == "claude")
            .unwrap_or(false)
            || argv0 == "claude";
        if !is_claude {
            continue;
        }
        let tty_raw = toks[1];
        let tty = if tty_raw.is_empty() || tty_raw == "??" || tty_raw == "?" {
            None
        } else {
            Some(tty_raw.to_string())
        };
        let mut uuid = None;
        for w in toks.windows(2) {
            if (w[0] == "-r" || w[0] == "--resume") && is_uuid(w[1]) {
                uuid = Some(w[1].to_string());
            }
        }
        procs.push(LiveProc { pid: toks[0].to_string(), tty, uuid, cwd: None });
    }

    // Resolve cwd for the BARE procs (no resume uuid) so we can map them by project.
    let bare: Vec<&str> = procs
        .iter()
        .filter(|p| p.uuid.is_none() && p.tty.is_some())
        .map(|p| p.pid.as_str())
        .collect();
    if !bare.is_empty() {
        if let Ok(o) = Command::new("lsof")
            .args(["-a", "-d", "cwd", "-Fpn", "-p", &bare.join(",")])
            .output()
        {
            let txt = String::from_utf8_lossy(&o.stdout);
            let mut cur = String::new();
            for line in txt.lines() {
                if let Some(p) = line.strip_prefix('p') {
                    cur = p.to_string();
                } else if let Some(n) = line.strip_prefix('n') {
                    if let Some(pr) = procs.iter_mut().find(|pr| pr.pid == cur) {
                        pr.cwd = Some(n.to_string());
                    }
                }
            }
        }
    }
    procs
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
    id: String,
    mtime_ms: u64,
    now: u64,
    live: bool,
    tty: Option<String>,
) -> Option<ClaudeSession> {
    let tail = read_tail(path, 96 * 1024);
    if tail.trim().is_empty() {
        return None;
    }

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
        tty,
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

    // 3. Liveness + real-terminal mapping from running `claude` processes (once).
    let procs = live_claude_procs();
    let uuid_tty: HashMap<String, String> = procs
        .iter()
        .filter_map(|p| match (&p.uuid, &p.tty) {
            (Some(u), Some(t)) => Some((u.clone(), t.clone())),
            _ => None,
        })
        .collect();

    let mut out: Vec<ClaudeSession> = Vec::with_capacity(cands.len());
    for c in cands {
        // The transcript filename is the canonical session uuid.
        let id = c
            .path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let tty = uuid_tty.get(&id).cloned();
        let live = tty.is_some();
        if let Some(mut s) = parse_session(&c.path, id, c.mtime, now, live, tty) {
            s.project_path = c.project_path;
            s.project_name = c.project_name;
            s.cwd_exists = c.cwd_exists;
            out.push(s);
        }
    }

    // 4. Map BARE live procs (no resume uuid) to a session by working directory:
    //    assign each to the newest still-unmapped session in its project, so a
    //    fresh terminal can still be brought to the front on click.
    for p in procs.iter().filter(|p| p.uuid.is_none() && p.tty.is_some()) {
        let cwd = match &p.cwd {
            Some(c) => c,
            None => continue,
        };
        if let Some(s) = out
            .iter_mut()
            .find(|s| s.tty.is_none() && &s.project_path == cwd)
        {
            s.tty = p.tty.clone();
            s.live = true;
            if s.status == "idle" || s.status == "done" {
                s.status = "waiting".to_string();
            }
        }
    }
    out
}

// ════════════════════════════════════════════════════════════════════════════
// Open the REAL terminal — the cockpit is an overview; clicking a session brings
// its actual Terminal.app tab to the front (or opens a fresh one + resumes it).
// ════════════════════════════════════════════════════════════════════════════

fn run_osascript(script: &str) -> Result<(), String> {
    let out = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Escape a string for embedding inside an AppleScript double-quoted literal.
fn as_escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}
/// POSIX single-quote a string for safe use inside a shell command.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Bring the Terminal.app tab on `tty` (e.g. "ttys014") to the front. The tty is
/// strictly validated so it can never break out of the AppleScript literal.
#[tauri::command]
pub fn focus_terminal(tty: String) -> Result<(), String> {
    let t = tty.trim().trim_start_matches("/dev/");
    let valid = t.starts_with("ttys")
        && t.len() <= 12
        && t[4..].chars().all(|c| c.is_ascii_digit())
        && t.len() > 4;
    if !valid {
        return Err("ungültige TTY".into());
    }
    let dev = format!("/dev/{t}");
    let script = format!(
        "tell application \"Terminal\"\n\
         activate\n\
         repeat with w in windows\n\
         repeat with tb in tabs of w\n\
         if tty of tb is \"{dev}\" then\n\
         set selected of tb to true\n\
         set index of w to 1\n\
         return\n\
         end if\n\
         end repeat\n\
         end repeat\n\
         end tell"
    );
    run_osascript(&script)
}

/// Open a NEW Terminal.app window and resume the session there (a real terminal —
/// the cockpit is just the overview, work happens in the actual terminal). `cwd` is
/// shell-quoted; `session_id` must be a uuid.
#[tauri::command]
pub fn open_terminal_resume(session_id: String, cwd: String) -> Result<(), String> {
    if !is_uuid(&session_id) {
        return Err("ungültige Session-ID".into());
    }
    let claude = crate::terminal::resolve_cmd("claude");
    let dir = if !cwd.is_empty() && Path::new(&cwd).is_dir() {
        cwd
    } else {
        dirs::home_dir()
            .map(|h| h.to_string_lossy().into_owned())
            .unwrap_or_else(|| "~".to_string())
    };
    let shell_cmd = format!(
        "cd {} && {} --resume {}",
        sh_quote(&dir),
        sh_quote(&claude),
        session_id
    );
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
        as_escape(&shell_cmd)
    );
    run_osascript(&script)
}
