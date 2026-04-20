#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Covel desktop shell (Tauri).
//!
//! Boot sequence mirrors `apps/desktop` so the two shells stay swappable:
//!   1. Resolve bundled sidecar paths (`bin/node`, `server/`) and user data dirs
//!   2. Show splash window (index.html shipped under `splash/`)
//!   3. Spawn Node sidecar, poll `/api/health`
//!   4. Navigate splash to `http://127.0.0.1:<port>/session`
//!   5. On exit, kill the child.

mod sidecar;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow};

use crate::sidecar::{spawn_sidecar, wait_for_health, SidecarPaths, StartedSidecar};

#[derive(Default)]
struct SidecarState {
    child: Mutex<Option<tokio::process::Child>>,
}

#[derive(Serialize, Clone)]
struct StatusPayload<'a> {
    label: &'a str,
}

#[derive(Serialize, Clone)]
struct ErrorPayload {
    error: String,
}

fn emit_status(window: &WebviewWindow, label: &str) {
    let _ = window.emit("covel://status", StatusPayload { label });
}

fn emit_error(window: &WebviewWindow, err: &str) {
    let _ = window.emit(
        "covel://status",
        ErrorPayload {
            error: err.to_string(),
        },
    );
}

/// Resolve `bin/node` and `server/` paths depending on whether we are
/// running under `tauri dev` (paths point into the repo staging) or inside
/// a packaged app bundle (paths are under the app's `resources/`).
fn resolve_sidecar_paths(app: &AppHandle) -> Result<SidecarPaths, String> {
    let (server_dir, node_bin) = if cfg!(debug_assertions) {
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let server = manifest_dir.join("resources").join("server");
        let bin = manifest_dir.join("binaries").join(node_file_name());
        (server, bin)
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {}", e))?;
        let server = resource_dir.join("server");
        let bin = resource_dir.join("bin").join(node_file_name());
        (server, bin)
    };

    // New layout: all config under ~/.covel/, data under <data_root> (default
    // ~/.covel/data, user can redirect via [paths] data_root in config.toml).
    // See apps/desktop/src/paths.ts for the canonical contract; this mirror
    // must stay in sync.
    let home = covel_home();
    let user_config = UserConfig::load(&home);
    let data_root = user_config.resolved_data_root(&home);

    for dir in [
        &home,
        &home.join("plugins"),
        &data_root,
        &data_root.join("worlds"),
        &data_root.join("logs"),
    ] {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    }

    // Seed a commented config.toml on first launch so users can discover the
    // [paths] data_root and [logging] options.
    let cfg_path = home.join("config.toml");
    if !cfg_path.exists() {
        let _ = fs::write(&cfg_path, DEFAULT_CONFIG_TOML);
    }

    let db_path = data_root.join("covel.db");
    let llm_toml = home.join("llm.toml");
    let keys_env = home.join("keys.env");
    let logs_dir = data_root.join("logs");

    // STATIC_DIR: the staging build places web-dist as a sibling of server/.
    let static_dir = {
        let candidate = server_dir
            .parent()
            .map(|p| p.join("web-dist"))
            .filter(|p| p.exists());
        candidate
    };

    Ok(SidecarPaths {
        server_dir,
        node_bin,
        static_dir,
        data_root: data_root.clone(),
        db_path,
        llm_toml,
        keys_env,
        logs_dir,
        log_max_size_mb: user_config.log_max_size_mb(),
        log_max_files: user_config.log_max_files(),
        user_plugins_dir: home.join("plugins"),
        user_worlds_dir: data_root.join("worlds"),
        covel_home: home,
    })
}

const DEFAULT_CONFIG_TOML: &str = r#"# Covel user config.
# Edit [paths] data_root to move user data (SQLite db, worlds, logs) to
# another drive. Relative paths are resolved against this file's directory.

[paths]
# data_root = "/Volumes/External/covel-data"

[logging]
# Rolling log files under <data_root>/logs/. Each file caps at max_size_mb;
# max_files determines how many rotated files are kept before oldest is dropped.
max_size_mb = 10
max_files   = 10
"#;

#[derive(serde::Deserialize, Default)]
struct UserConfig {
    paths: Option<PathsSection>,
    logging: Option<LoggingSection>,
}

#[derive(serde::Deserialize)]
struct PathsSection {
    data_root: Option<String>,
}

#[derive(serde::Deserialize)]
struct LoggingSection {
    max_size_mb: Option<u64>,
    max_files: Option<u32>,
}

impl UserConfig {
    fn load(home: &Path) -> Self {
        let cfg_path = home.join("config.toml");
        let Ok(text) = fs::read_to_string(&cfg_path) else {
            return UserConfig::default();
        };
        match toml::from_str(&text) {
            Ok(cfg) => cfg,
            Err(err) => {
                log::warn!("config.toml parse failed ({}): using defaults", err);
                UserConfig::default()
            }
        }
    }

    fn resolved_data_root(&self, home: &Path) -> PathBuf {
        if let Some(p) = self
            .paths
            .as_ref()
            .and_then(|p| p.data_root.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let pb = PathBuf::from(p);
            if pb.is_absolute() {
                return pb;
            }
            return home.join(pb);
        }
        home.join("data")
    }

    fn log_max_size_mb(&self) -> u64 {
        self.logging.as_ref().and_then(|l| l.max_size_mb).unwrap_or(10)
    }

    fn log_max_files(&self) -> u32 {
        self.logging.as_ref().and_then(|l| l.max_files).unwrap_or(10)
    }
}

/// `~/.covel` — cross-platform config root, overridable via COVEL_HOME.
fn covel_home() -> PathBuf {
    if let Ok(custom) = std::env::var("COVEL_HOME") {
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    dirs::home_dir()
        .map(|h| h.join(".covel"))
        // Fallback to CWD if home_dir fails — extremely rare on modern OSes.
        .unwrap_or_else(|| PathBuf::from(".covel"))
}

fn node_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

/// Resolve the tauri-plugin-log target folder before AppHandle is available.
/// Reads config.toml if present so the log dir follows a redirected data_root;
/// otherwise defaults to `<covel_home>/data/logs`.
fn shared_logs_dir() -> PathBuf {
    let home = covel_home();
    let cfg = UserConfig::load(&home);
    cfg.resolved_data_root(&home).join("logs")
}

async fn boot(app: AppHandle) -> Result<u16, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("main window missing")?;

    emit_status(&window, "Resolving paths\u{2026}");
    let paths = resolve_sidecar_paths(&app)?;

    emit_status(&window, "Starting server\u{2026}");
    let StartedSidecar {
        child,
        port,
        health_url,
    } = spawn_sidecar(&paths).await?;

    // Store the child so we can kill it on window close / app quit.
    {
        let state: State<SidecarState> = app.state();
        *state.child.lock().unwrap() = Some(child);
    }

    emit_status(&window, "Waiting for health check\u{2026}");
    wait_for_health(&health_url).await?;

    Ok(port)
}

fn main() {
    // Resolve the log directory before Builder::default() so tauri-plugin-log
    // can attach its Folder target. config.toml is optional — if absent we
    // fall back to <covel_home>/data/logs.
    let logs_dir = shared_logs_dir();
    let _ = fs::create_dir_all(&logs_dir);
    let cfg = UserConfig::load(&covel_home());
    let max_bytes = u128::from(cfg.log_max_size_mb()) * 1024 * 1024;
    let keep_files = cfg.log_max_files().max(1) as usize;

    let log_builder = tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .max_file_size(max_bytes)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(keep_files))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Stdout,
        ))
        .target(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::Folder {
                path: logs_dir,
                file_name: Some("tauri-main".to_string()),
            },
        ));

    tauri::Builder::default()
        .plugin(log_builder.build())
        .manage(SidecarState::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let window = app
                .get_webview_window("main")
                .expect("main window missing");
            let _ = window.show();

            tauri::async_runtime::spawn(async move {
                match boot(handle.clone()).await {
                    Ok(port) => {
                        if let Some(window) = handle.get_webview_window("main") {
                            let url = format!("http://127.0.0.1:{}/session", port);
                            // eval is the most compatible way to navigate to
                            // an external origin in Tauri 2; WebviewWindow's
                            // navigate() is gated on specific feature flags.
                            let js = format!(
                                "window.location.replace({});",
                                serde_json::to_string(&url).unwrap()
                            );
                            // Give the splash a moment so the user sees
                            // "Ready" before the jump.
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            let _ = window.eval(&js);
                        }
                    }
                    Err(err) => {
                        log::error!("boot failed: {}", err);
                        if let Some(window) = handle.get_webview_window("main") {
                            emit_error(&window, &err);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri app")
        .run(move |app_handle, event| {
            if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
                kill_sidecar(app_handle);
            }
        });
}

fn kill_sidecar(app_handle: &AppHandle) {
    let state: State<SidecarState> = app_handle.state();
    let taken = state.child.lock().ok().and_then(|mut g| g.take());
    if let Some(mut child) = taken {
        log::info!("killing sidecar on exit");
        let _ = child.start_kill();
    }
}

