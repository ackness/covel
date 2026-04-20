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
    /// Directory containing `src/index.ts`, `node_modules/tsx`, bundled worlds/plugins.
    pub server_dir: PathBuf,
    /// Absolute path to the bundled node executable.
    pub node_bin: PathBuf,
    /// Static web dist for SERVE_STATIC=true (served by the Hono server).
    pub static_dir: Option<PathBuf>,
    /// Resolved user data root — <covel_home>/data unless config.toml
    /// redirected. Forwarded explicitly as COVEL_DATA_ROOT so the server
    /// doesn't have to reverse-engineer it from worlds_dir/..
    pub data_root: PathBuf,
    /// SQLite database under <data_root>/covel.db.
    pub db_path: PathBuf,
    /// User-editable ~/.covel/llm.toml.
    pub llm_toml: PathBuf,
    /// Plain-text KEY=VALUE env file at ~/.covel/keys.env. Contents are
    /// read at spawn time and merged into the sidecar environment.
    pub keys_env: PathBuf,
    /// <data_root>/logs — shared with tauri-plugin-log.
    pub logs_dir: PathBuf,
    pub log_max_size_mb: u64,
    pub log_max_files: u32,
    /// ~/.covel/plugins — user plugins merged on top of bundled.
    pub user_plugins_dir: PathBuf,
    /// <data_root>/worlds — user-created worlds.
    pub user_worlds_dir: PathBuf,
    /// ~/.covel — passed through as COVEL_HOME + COVEL_USER_CONFIG_DIR.
    pub covel_home: PathBuf,
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
        .env("COVEL_HOME", &paths.covel_home)
        .env("COVEL_DATA_ROOT", &paths.data_root)
        .env("COVEL_DESKTOP_REST", "1")
        .env("COVEL_LLM_TOML", &paths.llm_toml)
        .env("COVEL_PLUGINS_DIR", &bundled_plugins)
        .env("COVEL_WORLDS_DIR", &bundled_worlds)
        .env("COVEL_USER_PLUGINS_DIR", &paths.user_plugins_dir)
        .env("COVEL_USER_WORLDS_DIR", &paths.user_worlds_dir)
        .env("COVEL_USER_CONFIG_DIR", &paths.covel_home)
        .env("COVEL_LOGS_DIR", &paths.logs_dir)
        .env("COVEL_LOG_MAX_SIZE_MB", paths.log_max_size_mb.to_string())
        .env("COVEL_LOG_MAX_FILES", paths.log_max_files.to_string())
        .env("COVEL_MEMORY_V1", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    // Merge ~/.covel/keys.env (plain KEY=VALUE lines) into the child env
    // so the server's dynamic `*_API_KEY` scan finds provider credentials
    // without the user having to touch shell env / dotfiles.
    for (k, v) in read_env_file(&paths.keys_env) {
        cmd.env(k, v);
    }

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

/// Parse a `.env`-style file into an iterable. Missing file → empty.
/// Strips matching single/double quotes around values, skips blanks and
/// comment lines. Keeps implementation minimal — no interpolation support.
fn read_env_file(path: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Ok(contents) = std::fs::read_to_string(path) else {
        return out;
    };
    for line in contents.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(eq) = trimmed.find('=') {
            let key = trimmed[..eq].trim().to_string();
            let mut val = trimmed[eq + 1..].trim().to_string();
            if (val.starts_with('"') && val.ends_with('"'))
                || (val.starts_with('\'') && val.ends_with('\''))
            {
                val = val[1..val.len() - 1].to_string();
            }
            if !key.is_empty() {
                out.push((key, val));
            }
        }
    }
    out
}
