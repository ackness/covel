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
use std::path::PathBuf;
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
        // `tauri dev`: paths live inside the src-tauri/ directory that
        // prepare-sidecar.mjs has just populated. CARGO_MANIFEST_DIR points
        // at src-tauri/ at build time, so everything is relative to it.
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let server = manifest_dir.join("resources").join("server");
        let bin = manifest_dir.join("binaries").join(node_file_name());
        (server, bin)
    } else {
        // Packaged bundle: tauri.conf.json copies staging → resources/server
        // and binaries/node → resources/bin/node.
        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("resource_dir: {}", e))?;
        let server = resource_dir.join("server");
        let bin = resource_dir.join("bin").join(node_file_name());
        (server, bin)
    };

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {}", e))?;

    let data_dir = app_data_dir.join("data");
    let config_dir = app_data_dir.join("config");
    let plugins_dir = app_data_dir.join("plugins");
    let worlds_dir = app_data_dir.join("worlds");

    for dir in [&data_dir, &config_dir, &plugins_dir, &worlds_dir] {
        fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {}", dir.display(), e))?;
    }

    let db_path = data_dir.join("covel.db");
    let llm_toml = config_dir.join("llm.toml");

    // STATIC_DIR: prefer web-dist staged next to server (apps/desktop build
    // also copies it, and server looks it up via SERVE_STATIC). If the
    // server_dir contains a sibling `web-dist`, use it; otherwise rely on
    // server's own fallback.
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
        db_path,
        llm_toml,
        user_plugins_dir: plugins_dir,
        user_worlds_dir: worlds_dir,
        user_config_dir: config_dir,
    })
}

fn node_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
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
    let _ = env_logger::Builder::from_default_env()
        .filter_level(log::LevelFilter::Info)
        .try_init();

    tauri::Builder::default()
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

