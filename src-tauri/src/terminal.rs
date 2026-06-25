//! Local PTY terminals for the Subunit desktop shell.
//!
//! Plugins (the "ops" surfaces — Atlas tasks, the terminal plugin, etc.) need to
//! spawn + drive REAL local terminal sessions on the Mac: the same "customer
//! terminals" pattern the server runs, but local. This module owns that concern.
//!
//! A [`TerminalManager`] (held in `AppState`) keeps a map of live PTY sessions.
//! Each session is a `portable-pty` master/child pair plus a writer handle; a
//! dedicated background thread drains the PTY's reader and forwards every chunk
//! to the frontend as a `terminal://output` Tauri event. When the child exits,
//! the thread emits `terminal://exit` and marks the session not-running.
//!
//! Contract (matches `src/plugin/host.tsx` TERMINAL_COMMANDS / TERMINAL_EVENTS):
//!   commands  spawn_terminal({opts}) -> id
//!             list_terminals()       -> [TermInfo]
//!             write_terminal({id,data}) -> ()
//!             kill_terminal({id})       -> ()
//!   events    terminal://output  { id, chunk }
//!             terminal://exit    { id, code }
//!
//! `TermInfo` is serialized camelCase so the frontend gets `taskId` /
//! `startedAt` (the TS `TermInfo` uses `taskId`; extra fields are ignored).

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// A live terminal/pty session as reported to the frontend.
///
/// Mirrors the TS `TermInfo { id, title, cmd, taskId?, running }` (camelCase),
/// plus `startedAt` (epoch ms) which the frontend may use for ordering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermInfo {
    pub id: String,
    pub title: String,
    pub cmd: String,
    /// Optional Notion task linkage carried through from spawn opts.
    pub task_id: Option<String>,
    pub running: bool,
    /// Epoch milliseconds when the pty was spawned.
    pub started_at: u64,
    /// Project label — the working dir's basename (for the cockpit's grouping).
    pub project: String,
}

/// Spawn options from the frontend (`spawn_terminal({ opts })`). camelCase to
/// match the TS `TerminalSpawnOpts`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOpts {
    /// Program to run. Defaults to the local `claude` CLI if present, else $SHELL.
    pub cmd: Option<String>,
    pub args: Option<Vec<String>>,
    pub cwd: Option<String>,
    pub title: Option<String>,
    /// Optional Notion task linkage carried onto the resulting TermInfo.
    pub task_id: Option<String>,
}

/// One running PTY session. The reader thread owns the master's reader; we keep
/// the master (for resize/teardown), a boxed writer, the child handle (to kill),
/// and the live metadata.
struct Session {
    info: TermInfo,
    /// Whether the child is still alive — flipped to false by the reader thread
    /// on exit, or by an explicit kill.
    running: Arc<AtomicBool>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Kept alive so the PTY master isn't dropped (which would close the slave)
    /// while the session is active.
    _master: Box<dyn MasterPty + Send>,
}

/// App-wide terminal registry. Lives in `AppState`; one per app.
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Session>>,
    next_id: AtomicU64,
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        }
    }

    fn alloc_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed);
        format!("term-{n}")
    }
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

/// The default command for an interactive session: the local `claude` CLI if it
/// exists, otherwise the user's login shell, otherwise `/bin/sh`.
fn default_command() -> (String, Vec<String>) {
    if let Some(home) = dirs::home_dir() {
        let claude = home.join(".local/bin/claude");
        if claude.is_file() {
            return (claude.to_string_lossy().into_owned(), Vec::new());
        }
    }
    if let Ok(shell) = std::env::var("SHELL") {
        if !shell.is_empty() {
            // Login + interactive shell so the user's profile (PATH etc.) loads —
            // important for finding `claude`, project tools, etc.
            return (shell, vec!["-l".to_string(), "-i".to_string()]);
        }
    }
    ("/bin/sh".to_string(), Vec::new())
}

/// macOS GUI apps inherit a minimal PATH, so a bare command like `ollama` or `claude`
/// won't resolve. Resolve a bare cmd to its absolute path by probing the common bin
/// dirs (the same ones we add to the child PATH below). Falls back to the bare name.
fn resolve_cmd(cmd: &str) -> String {
    if cmd.contains('/') {
        return cmd.to_string();
    }
    let mut dirs_list: Vec<std::path::PathBuf> = Vec::new();
    if let Some(h) = dirs::home_dir() {
        dirs_list.push(h.join(".local/bin"));
        dirs_list.push(h.join("bin"));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs_list.push(d.into());
    }
    for d in dirs_list {
        let p = d.join(cmd);
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    cmd.to_string()
}

/// PATH the spawned PTY (and its subprocesses) should see — common tool locations
/// prepended to whatever the app inherited, so ollama/claude/brew tools resolve.
fn child_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(h) = dirs::home_dir() {
        parts.push(h.join(".local/bin").to_string_lossy().into_owned());
    }
    parts.push("/opt/homebrew/bin".into());
    parts.push("/usr/local/bin".into());
    let cur = std::env::var("PATH").unwrap_or_default();
    if !cur.is_empty() {
        parts.push(cur);
    } else {
        parts.push("/usr/bin:/bin".into());
    }
    parts.join(":")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Binaries whose args carry security weight: a crafted positional (e.g. a Notion
/// task title that begins with `-`) could be parsed as an agent FLAG — including a
/// permission-bypass — rather than the prompt.
fn is_agent_binary(cmd: &str) -> bool {
    let base = std::path::Path::new(cmd)
        .file_name()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    matches!(base.as_str(), "claude" | "claude-code" | "codex")
}

/// Defense-in-depth against argument injection for agent binaries. Before any `--`
/// end-of-options separator, every flag-looking arg (`-…`) MUST be on the allowlist;
/// after `--`, args are positional and allowed. This blocks a future plugin from
/// reintroducing the injection even if the frontend guard is bypassed. Non-agent
/// binaries (a plain shell, etc.) are not constrained here.
fn validate_agent_args(cmd: &str, args: &[String]) -> Result<(), String> {
    if !is_agent_binary(cmd) {
        return Ok(());
    }
    const ALLOWED: &[&str] = &[
        "-p", "--print", "-c", "--continue", "--resume", "--model",
        "--output-format", "--input-format", "--verbose", "--append-system-prompt",
    ];
    for a in args {
        if a == "--" {
            break; // end of options — everything after is a positional prompt
        }
        if a.starts_with('-') && !ALLOWED.contains(&a.as_str()) {
            return Err(format!(
                "refused unsafe argument for agent `{cmd}`: {a} (pass the prompt after `--`)"
            ));
        }
    }
    Ok(())
}

/// Spawn a local PTY session and stream its output to the frontend.
///
/// Returns the new session id. The reader thread emits `terminal://output`
/// chunks and a final `terminal://exit` with the child's exit code.
#[tauri::command]
pub fn spawn_terminal(app: AppHandle, opts: SpawnOpts) -> Result<String, String> {
    let state = app.state::<crate::commands::AppState>();
    let mgr = &state.terminals;

    let (cmd, default_args) = match opts.cmd {
        Some(c) if !c.is_empty() => (c, opts.args.unwrap_or_default()),
        _ => {
            let (c, a) = default_command();
            // An explicit cmd wins; with the default we ignore caller args unless
            // they were given alongside (rare). Prefer caller args if present.
            (c, opts.args.unwrap_or(a))
        }
    };

    // Defense-in-depth: refuse argument-injection into agent binaries (claude/codex).
    validate_agent_args(&cmd, &default_args)?;
    // Resolve bare commands (ollama/claude/…) to an absolute path (GUI-app PATH is minimal).
    let cmd = resolve_cmd(&cmd);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty: {e}"))?;

    let mut builder = CommandBuilder::new(&cmd);
    for a in &default_args {
        builder.arg(a);
    }
    if let Some(cwd) = &opts.cwd {
        if !cwd.is_empty() {
            builder.cwd(cwd);
        }
    } else if let Some(home) = dirs::home_dir() {
        builder.cwd(home);
    }
    // A sane TERM so curses apps (and `claude`) render correctly.
    builder.env("TERM", "xterm-256color");
    // Give the PTY (and its children) a PATH that finds ollama/claude/brew tools.
    builder.env("PATH", child_path());

    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| format!("spawn `{cmd}`: {e}"))?;
    // The slave handle is no longer needed once the child holds it; dropping it
    // avoids a lingering fd that would keep the PTY open after the child exits.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer: {e}"))?;

    let id = mgr.alloc_id();
    let title = opts
        .title
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| display_title(&cmd));
    let running = Arc::new(AtomicBool::new(true));

    // Project = the working dir's basename, so the cockpit can group terminals.
    let project = opts
        .cwd
        .as_deref()
        .filter(|c| !c.is_empty())
        .and_then(|c| std::path::Path::new(c).file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();

    let info = TermInfo {
        id: id.clone(),
        title,
        cmd: cmd.clone(),
        task_id: opts.task_id.clone(),
        running: true,
        started_at: now_ms(),
        project,
    };

    // Reader thread: drain the PTY, forward chunks, emit exit on EOF.
    {
        let app = app.clone();
        let id = id.clone();
        let running = running.clone();
        std::thread::Builder::new()
            .name(format!("pty-reader-{id}"))
            .spawn(move || {
                read_loop(app, id, reader, running);
            })
            .map_err(|e| format!("reader thread: {e}"))?;
    }

    mgr.sessions.lock().insert(
        id.clone(),
        Session {
            info,
            running,
            writer,
            child,
            _master: pair.master,
        },
    );

    log::info!("terminal {id} spawned: {cmd}");
    Ok(id)
}

/// Background reader: stream PTY bytes to the frontend until EOF, then reap the
/// child for an exit code and emit `terminal://exit`.
fn read_loop(
    app: AppHandle,
    id: String,
    mut reader: Box<dyn Read + Send>,
    running: Arc<AtomicBool>,
) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break, // EOF — child closed the PTY.
            Ok(n) => {
                // PTY output is bytes; the terminal emulator on the frontend
                // (xterm.js) decodes. Use lossy UTF-8 so partial multibyte
                // sequences at a chunk boundary don't drop the whole chunk.
                let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
                let _ = app.emit(
                    crate::EVENT_TERMINAL_OUTPUT,
                    OutputPayload {
                        id: id.clone(),
                        chunk,
                    },
                );
            }
            Err(e) => {
                // EIO is the normal "slave closed" signal on macOS/Linux when the
                // child exits; treat any read error as end-of-session.
                log::debug!("terminal {id} read ended: {e}");
                break;
            }
        }
    }

    running.store(false, Ordering::SeqCst);

    // Reap the child for its exit status. The Child handle lives in the session;
    // pull it out to wait without holding the lock across the (fast) wait.
    let code = {
        let state = app.state::<crate::commands::AppState>();
        let mut sessions = state.terminals.sessions.lock();
        if let Some(sess) = sessions.get_mut(&id) {
            sess.info.running = false;
            match sess.child.wait() {
                Ok(status) => status.exit_code() as i32,
                Err(_) => -1,
            }
        } else {
            // Session already removed (killed) — report a generic code.
            -1
        }
    };

    log::info!("terminal {id} exited: code={code}");
    let _ = app.emit(crate::EVENT_TERMINAL_EXIT, ExitPayload { id, code });
}

/// Derive a display title from a command path: the file stem (e.g.
/// "/Users/x/.local/bin/claude" -> "claude", "/bin/zsh" -> "zsh").
fn display_title(cmd: &str) -> String {
    std::path::Path::new(cmd)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| cmd.to_string())
}

/// Snapshot of all known sessions (running + finished-but-not-yet-pruned).
#[tauri::command]
pub fn list_terminals(state: State<'_, crate::commands::AppState>) -> Vec<TermInfo> {
    let sessions = state.terminals.sessions.lock();
    let mut out: Vec<TermInfo> = sessions.values().map(|s| s.info.clone()).collect();
    out.sort_by_key(|t| t.started_at);
    out
}

/// Write input (keystrokes/paste) to a session's PTY.
#[tauri::command]
pub fn write_terminal(
    state: State<'_, crate::commands::AppState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.terminals.sessions.lock();
    let sess = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("no terminal {id}"))?;
    if !sess.running.load(Ordering::SeqCst) {
        return Err(format!("terminal {id} is not running"));
    }
    sess.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write {id}: {e}"))?;
    sess.writer.flush().map_err(|e| format!("flush {id}: {e}"))?;
    Ok(())
}

/// Kill a session's child and drop it from the registry. The reader thread will
/// observe the PTY closing and emit `terminal://exit`.
#[tauri::command]
pub fn kill_terminal(
    state: State<'_, crate::commands::AppState>,
    id: String,
) -> Result<(), String> {
    let mut sess = {
        let mut sessions = state.terminals.sessions.lock();
        sessions
            .remove(&id)
            .ok_or_else(|| format!("no terminal {id}"))?
    };
    sess.running.store(false, Ordering::SeqCst);
    if let Err(e) = sess.child.kill() {
        log::debug!("kill {id}: {e}");
    }
    let _ = sess.child.wait();
    log::info!("terminal {id} killed");
    Ok(())
}

// ── event payloads ──────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
struct OutputPayload {
    id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
struct ExitPayload {
    id: String,
    code: i32,
}

// ════════════════════════════════════════════════════════════════════════════
// External plugin discovery
// ════════════════════════════════════════════════════════════════════════════

/// One external plugin dir, as handed to the loader (`loader.ts` consumes this).
/// camelCase to match the TS `ExternalPluginDescriptor`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalPluginDescriptor {
    /// Plugin id (from manifest.json — falls back to the dir name).
    pub id: String,
    /// Absolute path to the plugin directory.
    pub dir: String,
    /// Absolute path to the manifest.json.
    pub manifest_path: String,
    /// Dynamic-import target for the module entry (see resolution below).
    pub entry_path: String,
}

/// Discover external plugins under `<app_data_dir>/plugins/*/manifest.json`.
///
/// For each child dir of `plugins/` that contains a `manifest.json`, we read the
/// manifest to get the `id` (falling back to the dir name) and resolve the entry
/// the loader should dynamic-import. The entry is `manifest.entry` if present,
/// else the first of `index.js` / `index.mjs` / `entry.js` that exists. Missing
/// or malformed dirs are skipped (never fatal — the shell must boot regardless).
#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Vec<ExternalPluginDescriptor> {
    let base = match app.path().app_data_dir() {
        Ok(d) => d.join("plugins"),
        Err(e) => {
            log::debug!("list_plugins: no app_data_dir ({e})");
            return Vec::new();
        }
    };

    let entries = match std::fs::read_dir(&base) {
        Ok(e) => e,
        Err(_) => return Vec::new(), // plugins dir not created yet — fine.
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let manifest_path = dir.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }

        let raw = match std::fs::read_to_string(&manifest_path) {
            Ok(s) => s,
            Err(e) => {
                log::warn!("list_plugins: read {} failed: {e}", manifest_path.display());
                continue;
            }
        };
        let manifest: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(v) => v,
            Err(e) => {
                log::warn!(
                    "list_plugins: parse {} failed: {e}",
                    manifest_path.display()
                );
                continue;
            }
        };

        let dir_name = dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let id = manifest
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| dir_name.clone());

        // Resolve the entry the loader will dynamic-import.
        let entry_file = manifest
            .get("entry")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                for cand in ["index.js", "index.mjs", "entry.js", "index.cjs"] {
                    if dir.join(cand).is_file() {
                        return Some(cand.to_string());
                    }
                }
                None
            });

        let entry_path = match entry_file {
            Some(f) => dir.join(f),
            None => {
                log::warn!("list_plugins: no entry for plugin {id} in {}", dir.display());
                continue;
            }
        };

        out.push(ExternalPluginDescriptor {
            id,
            dir: dir.to_string_lossy().into_owned(),
            manifest_path: manifest_path.to_string_lossy().into_owned(),
            entry_path: entry_path.to_string_lossy().into_owned(),
        });
    }

    out
}
