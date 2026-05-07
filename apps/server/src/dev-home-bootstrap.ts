/**
 * Dev-only auto-bootstrap from `~/.covel/`.
 *
 * In dev (`NODE_ENV !== 'production'`) and outside the packaged desktop
 * sidecar (no `COVEL_DESKTOP_REST=1`), populate the relevant `COVEL_*`
 * env vars and `SQLITE_PATH` from `~/.covel/` before the rest of the
 * server boots. Without this, `pnpm dev` and `pnpm dev:electron` see an
 * empty repo-rooted state — bundled plugins only, no user-installed
 * plugins, fresh DB at `./data/covel.db`, no `~/.covel/keys.env` keys —
 * which doesn't match what the production desktop binary loads.
 *
 * The packaged desktop already sets `COVEL_DESKTOP_REST=1` plus explicit
 * `COVEL_USER_*` paths via `apps/desktop/src/main.ts`, so this module is
 * a no-op there. It is also a no-op when the user's home directory has
 * no `~/.covel/` (fresh checkouts on CI, ephemeral sandboxes, etc.).
 *
 * Existing process env values always win — `.env` / `.env.llm` overrides
 * are never overwritten. Each path is set only if both the env var is
 * unset AND the underlying file/directory actually exists.
 *
 * This module's top-level call runs at import time so the side effect
 * lands before `app.ts` evaluates its `readRuntimeEnv()` snapshot. Keep
 * imports light and synchronous.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setupServerLogFile } from "./server-log-tee.js";

interface BootstrapSummary {
  readonly applied: boolean;
  readonly home?: string;
  readonly setVars: readonly string[];
  readonly loadedKeys: number;
  readonly skipReason?: string;
  readonly serverLogFile?: string;
}

/**
 * Set `process.env[key] = candidate` only if the env var is currently unset.
 *
 * `mode` controls how we decide whether the candidate is usable:
 *  - `requireExists` (default) — the candidate must already exist on disk
 *    (suitable for *user-provided* resources like plugins/worlds/llm.toml; if
 *    the user hasn't created them, fall through to the server's defaults).
 *  - `ensureParent` — the candidate is a runtime artifact the server will
 *    create on first boot (e.g. the SQLite database file). The candidate file
 *    itself need not exist; we only ensure its parent directory is present so
 *    the server can write to it.
 */
function setIfMissing(
  key: string,
  candidate: string,
  applied: string[],
  mode: "requireExists" | "ensureParent" = "requireExists",
): void {
  if (process.env[key]) return;
  if (mode === "requireExists") {
    if (!fs.existsSync(candidate)) return;
  } else {
    fs.mkdirSync(path.dirname(candidate), { recursive: true });
  }
  process.env[key] = candidate;
  applied.push(key);
}

function loadKeysEnvIntoProcessEnv(filePath: string): number {
  if (!fs.existsSync(filePath)) return 0;
  let count = 0;
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return 0;
  }
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key || process.env[key]) continue;
    process.env[key] = value;
    count++;
  }
  return count;
}

/** Exported for tests. Production code triggers it via the side-effect call below. */
export function bootstrap(): BootstrapSummary {
  if (process.env.NODE_ENV === "production") {
    return {
      applied: false,
      setVars: [],
      loadedKeys: 0,
      skipReason: "production",
    };
  }
  if (process.env.COVEL_DESKTOP_REST === "1") {
    return {
      applied: false,
      setVars: [],
      loadedKeys: 0,
      skipReason: "desktop-sidecar",
    };
  }

  const home = process.env.COVEL_HOME ?? path.join(os.homedir(), ".covel");
  if (!fs.existsSync(home)) {
    return {
      applied: false,
      setVars: [],
      loadedKeys: 0,
      skipReason: "no-covel-home",
    };
  }

  const applied: string[] = [];
  setIfMissing("COVEL_USER_PLUGINS_DIR", path.join(home, "plugins"), applied);
  setIfMissing("COVEL_USER_WORLDS_DIR", path.join(home, "worlds"), applied);
  setIfMissing("COVEL_LLM_TOML", path.join(home, "llm.toml"), applied);
  setIfMissing(
    "SQLITE_PATH",
    path.join(home, "data", "covel.db"),
    applied,
    "ensureParent",
  );
  // Mirror the desktop layout: `<home>/data/logs/` collects both the
  // shell's `desktop.log` and our sidecar `server.log`. We populate
  // `COVEL_LOGS_DIR` so downstream code can locate it without
  // re-deriving the path.
  const logsDir = path.join(home, "data", "logs");
  setIfMissing("COVEL_LOGS_DIR", logsDir, applied, "ensureParent");

  const loadedKeys = loadKeysEnvIntoProcessEnv(path.join(home, "keys.env"));

  // Tee stdout/stderr to a NDJSON `server.log` so `pnpm dev:server`
  // output is durable. `COVEL_SERVER_LOG_FILE` lets users override the
  // path; setting it to an empty string disables the tee.
  const explicit = process.env.COVEL_SERVER_LOG_FILE;
  const serverLogFile =
    explicit === undefined
      ? path.join(process.env.COVEL_LOGS_DIR ?? logsDir, "server.log")
      : explicit.length > 0
        ? explicit
        : null;
  if (serverLogFile) {
    setupServerLogFile({
      filePath: serverLogFile,
      rotation: {
        maxSizeMb: Number(process.env.COVEL_LOG_MAX_SIZE_MB) || 10,
        maxFiles: Number(process.env.COVEL_LOG_MAX_FILES) || 10,
      },
    });
  }

  return {
    applied: true,
    home,
    setVars: applied,
    loadedKeys,
    serverLogFile: serverLogFile ?? undefined,
  };
}

/** Result of the import-time bootstrap call. Exported so tests can inspect it. */
export const summary = bootstrap();
if (summary.applied) {
  const parts = [
    `home=${summary.home}`,
    `vars=[${summary.setVars.join(", ") || "—"}]`,
    `keys=${summary.loadedKeys}`,
    summary.serverLogFile ? `serverLog=${summary.serverLogFile}` : null,
  ]
    .filter((p): p is string => p !== null)
    .join(" ");
  console.log(`[dev-home-bootstrap] applied ${parts}`);
} else if (
  summary.skipReason &&
  summary.skipReason !== "production" &&
  summary.skipReason !== "desktop-sidecar"
) {
  console.log(`[dev-home-bootstrap] skipped (${summary.skipReason})`);
}
