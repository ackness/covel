//! Node sidecar lifecycle.
//!
//! Spawns the bundled `bin/node` (or `bin/node.exe` on Windows) with
//! `server/node_modules/tsx/dist/cli.mjs server/src/index.ts`, mirroring
//! the Electron app's sidecar design. A free TCP port is probed, injected
//! via SERVER_PORT, and the caller polls `/api/health` before navigating
//! the webview.
//!
//! Mirror of `apps/desktop/src/main.ts` — keep the two in sync when the
//! server boot contract changes.

use std::net::{SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::time::Instant;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SidecarPaths {
    /// Directory containing `src/index.ts`, `node_modules/tsx`, `llm.toml`, ...
    pub server_dir: PathBuf,
    /// Absolute path to the bundled node executable.
    pub node_bin: PathBuf,
    /// Static web dist for SERVE_STATIC=true (served by the Hono server).
    pub static_dir: Option<PathBuf>,
    /// User-writable SQLite database path.
    pub db_path: PathBuf,
    /// User-editable llm.toml (may not exist — server falls back gracefully).
    pub llm_toml: PathBuf,
    /// User plugins / worlds dirs (optional; forwarded to server).
    pub user_plugins_dir: PathBuf,
    pub user_worlds_dir: PathBuf,
    pub user_config_dir: PathBuf,
}

pub struct StartedSidecar {
    pub child: Child,
    pub port: u16,
    pub health_url: String,
}

/// Find a free TCP port by binding to :0 and immediately releasing.
/// Not race-free, but good enough — the child is spawned within milliseconds.
fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Spawn the Node sidecar and return a handle + health URL. Does NOT wait
/// for /api/health — call `wait_for_health` after this.
pub async fn spawn_sidecar(paths: &SidecarPaths) -> Result<StartedSidecar, String> {
    verify_paths(paths)?;

    let port = pick_free_port().map_err(|e| format!("pick_free_port: {}", e))?;
    let health_url = format!("http://127.0.0.1:{}/api/health", port);

    let tsx_cli = paths
        .server_dir
        .join("node_modules")
        .join("tsx")
        .join("dist")
        .join("cli.mjs");
    let entry = paths.server_dir.join("src").join("index.ts");

    // Bundled plugins/worlds live next to src/ inside server_dir.
    let bundled_plugins = paths.server_dir.join("plugins");
    let bundled_worlds = paths.server_dir.join("worlds");

    let mut cmd = Command::new(&paths.node_bin);
    cmd.arg(&tsx_cli)
        .arg(&entry)
        .current_dir(&paths.server_dir)
        .env("SERVER_PORT", port.to_string())
        .env("STORE_BACKEND", "sqlite")
        .env("SQLITE_PATH", &paths.db_path)
        .env("NODE_ENV", "production")
        .env("SERVE_STATIC", "true")
        .env("COVEL_LLM_TOML", &paths.llm_toml)
        .env("COVEL_PLUGINS_DIR", &bundled_plugins)
        .env("COVEL_WORLDS_DIR", &bundled_worlds)
        .env("COVEL_USER_PLUGINS_DIR", &paths.user_plugins_dir)
        .env("COVEL_USER_WORLDS_DIR", &paths.user_worlds_dir)
        .env("COVEL_USER_CONFIG_DIR", &paths.user_config_dir)
        .env("COVEL_MEMORY_V1", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    if let Some(static_dir) = &paths.static_dir {
        cmd.env("STATIC_DIR", static_dir);
    }

    log::info!(
        "spawning sidecar: {} {} {}",
        paths.node_bin.display(),
        tsx_cli.display(),
        entry.display()
    );

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn sidecar: {}", e))?;

    // Pipe stdout/stderr to our log so the splash UI can surface failures.
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!("[server] {}", line);
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::warn!("[server:err] {}", line);
            }
        });
    }

    Ok(StartedSidecar {
        child,
        port,
        health_url,
    })
}

/// Poll the given URL until it responds 200 OK, or the timeout elapses.
pub async fn wait_for_health(url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| format!("reqwest client: {}", e))?;

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut interval = Duration::from_millis(150);

    while Instant::now() < deadline {
        if let Ok(res) = client.get(url).send().await {
            if res.status().is_success() {
                return Ok(());
            }
        }
        tokio::time::sleep(interval).await;
        interval = std::cmp::min(Duration::from_secs(1), interval.mul_f32(1.35));
    }
    Err(format!(
        "sidecar did not become healthy within {}s",
        HEALTH_TIMEOUT.as_secs()
    ))
}

fn verify_paths(paths: &SidecarPaths) -> Result<(), String> {
    check_exists(&paths.node_bin, "node binary")?;
    check_exists(&paths.server_dir, "server directory")?;
    check_exists(
        &paths.server_dir.join("src").join("index.ts"),
        "server entry",
    )?;
    check_exists(
        &paths
            .server_dir
            .join("node_modules")
            .join("tsx")
            .join("dist")
            .join("cli.mjs"),
        "tsx CLI",
    )?;
    Ok(())
}

fn check_exists(p: &Path, label: &str) -> Result<(), String> {
    if !p.exists() {
        return Err(format!("{} missing at {}", label, p.display()));
    }
    Ok(())
}
