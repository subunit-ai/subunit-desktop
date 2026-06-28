//! Subunit desktop shell — Tauri backend entrypoint.
//!
//! A thin shell that hosts the Atlas / Synapse / Chat / Call / Echo modules in
//! the frontend. The Rust side owns exactly one concern: the Subunit account
//! session (loopback-SSO ported from echo-tauri) + the app lifecycle (single
//! instance, tray, updater). Module data flows over HTTP from the frontend.

mod apps; // marketplace: detect/open/install standalone Subunit apps
mod assistant; // ubiquitous U1 assistant — local ollama / claude -p (subscription)
mod auth;
mod ingest; // synapse → real n8n axon-ingest webhooks
mod commands;
mod config;
mod http; // shared pooled HTTP client for the cloud auth path
mod sessions; // read-only discovery of Claude Code sessions (the cockpit)
mod terminal; // local PTY terminals + external plugin discovery

/// Tauri event names the terminal reader thread emits (kept in sync with
/// `src/plugin/host.tsx` TERMINAL_EVENTS).
pub const EVENT_TERMINAL_OUTPUT: &str = "terminal://output";
pub const EVENT_TERMINAL_EXIT: &str = "terminal://exit";

use commands::AppState;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Crash/error reporting. No-op unless SUBUNIT_SENTRY_DSN is set (DSN lives in
    // env / CI, never in the repo). DSN baked at compile time (option_env!) so
    // shipped binaries report without the env var on the user's machine.
    let _sentry = sentry::init((
        option_env!("SUBUNIT_SENTRY_DSN").unwrap_or(""),
        sentry::ClientOptions {
            release: sentry::release_name!(),
            ..Default::default()
        },
    ));

    let cfg = config::Config::load();

    tauri::Builder::default()
        // Single-instance guard FIRST: a second launch hands focus to the
        // already-running window and exits instead of spawning a rival process.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(
            // File + stdout logging. The file lands in the OS log dir so it can
            // be pulled to diagnose field issues. Our own module logs at Debug;
            // noisy deps are clamped to Warn.
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("subunit_desktop_lib", log::LevelFilter::Debug)
                .level_for("reqwest", log::LevelFilter::Warn)
                .max_file_size(5_000_000)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("subunit".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::new(cfg))
        .invoke_handler(tauri::generate_handler![
            commands::app_version,
            commands::get_account,
            commands::get_auth_token,
            commands::login,
            commands::logout,
            commands::open_external,
            commands::open_path,
            commands::reveal_path,
            commands::check_for_updates,
            commands::install_update,
            // Local PTY terminals (terminal.rs).
            terminal::spawn_terminal,
            terminal::list_terminals,
            terminal::write_terminal,
            terminal::kill_terminal,
            // External plugin discovery (terminal.rs).
            terminal::list_plugins,
            // Project discovery for the cockpit (terminal.rs).
            terminal::list_projects,
            // Read-only Claude Code session discovery for the cockpit (sessions.rs).
            sessions::list_claude_sessions,
            // Bring a session's REAL Terminal.app tab to the front / open + resume.
            sessions::focus_terminal,
            sessions::open_terminal_resume,
            // Marketplace: standalone app detect/open/install (apps.rs).
            apps::app_status,
            apps::app_latest,
            apps::open_app,
            apps::install_app,
            // Synapse → real n8n webhooks (ingest.rs).
            ingest::synapse_ingest,
            // Ubiquitous U1 assistant — local providers (assistant.rs).
            assistant::u1_ask,
        ])
        .setup(|app| {
            log::info!(
                "Subunit {} starting (os={}, arch={})",
                app.package_info().version,
                std::env::consts::OS,
                std::env::consts::ARCH,
            );

            // System tray — open the shell or quit.
            let open = MenuItemBuilder::with_id("open", "Subunit öffnen").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Beenden").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&open])
                .separator()
                .item(&quit)
                .build()?;
            let mut tray = TrayIconBuilder::with_id("tray")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // Auto-update check — on launch AND every 3 h, so a long-running
            // instance surfaces a new release without a restart. We never
            // auto-install (high blast radius); we emit availability and the UI
            // triggers the install via `install_update`.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        if let Ok(updater) = handle.updater() {
                            match updater.check().await {
                                Ok(Some(update)) => {
                                    log::info!("update available: {}", update.version);
                                    let _ = handle.emit("subunit://update-available", update.version);
                                }
                                Ok(None) => {}
                                Err(e) => log::debug!("update check: {e}"),
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3 * 3600)).await;
                    }
                });
            }

            // Refresh the displayed plan from the active workspace tier on startup
            // (config.plan can be stale). Only if there's a stored session.
            {
                let logged_in = {
                    let st = app.state::<AppState>();
                    let v = st.config.lock().logged_in();
                    v
                };
                if logged_in {
                    let handle = app.handle().clone();
                    std::thread::spawn(move || crate::auth::refresh_plan(&handle));
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // macOS: a Dock-icon click sends Reopen — re-show the main window.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
