/**
 * Centralized path resolution for the Covel desktop app.
 *
 * Design goals:
 *   1. `dev` and `prod` should behave identically where possible.
 *      All mutable data lives under `app.getPath('userData')` in both modes.
 *   2. Bundled/read-only assets (server source, default worlds, default llm.toml)
 *      live next to the app bundle. They are NEVER written to at runtime.
 *   3. User-writable resources (db, logs, custom plugins, custom worlds, user llm.toml)
 *      live under userData and are created on first launch.
 *
 * Directory layout (userData):
 *   <userData>/
 *     data/
 *       covel.db           -- SQLite database
 *     logs/
 *       app-YYYY-MM-DD.log -- Rolling app logs (main + server)
 *       startup-<ts>.log   -- Per-startup diagnostics
 *     plugins/             -- User-installed plugins (merged with bundled plugins)
 *     worlds/              -- User-created / imported worlds
 *     config/
 *       llm.toml           -- User-editable LLM config (overrides bundled)
 *       settings.json      -- UI preferences backup
 *     server.port          -- Last known server port (for restart / diagnostics)
 */

import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** True when running via `electron .` or similar unpackaged launch. */
export const isDev = !app.isPackaged;

// ── Immutable install paths ──────────────────────────────────────

/**
 * Root of the repository when running in dev, or `resourcesPath/server`
 * when running in a packaged app. Read-only at runtime.
 */
export function resolveProjectRoot(): string {
  if (isDev) {
    // apps/desktop/dist/main.mjs → project root is ../../..
    return path.resolve(__dirname, "../../..");
  }
  return path.join(process.resourcesPath!, "server");
}

/**
 * Absolute path to the server entry file.
 *
 * Dev layout（仓库源码）：root/apps/server/src/index.ts
 * Prod layout（pnpm deploy 打包后的独立目录）：root/src/index.ts
 */
export function resolveServerEntry(): string {
  const root = resolveProjectRoot();
  if (isDev) {
    return path.join(root, "apps/server/src/index.ts");
  }
  return path.join(root, "src/index.ts");
}

/** Default bundled worlds directory (read-only in prod). */
export function resolveBundledWorldsDir(): string {
  return path.join(resolveProjectRoot(), "worlds");
}

/** Default bundled plugins directory (read-only in prod). */
export function resolveBundledPluginsDir(): string {
  return path.join(resolveProjectRoot(), "plugins");
}

/** Default bundled llm.toml (read-only in prod, used as initial seed). */
export function resolveBundledLlmToml(): string {
  return path.join(resolveProjectRoot(), "llm.toml");
}

/**
 * Find tsx CLI entry point by scanning node_modules/.pnpm for tsx.
 * Packaged apps include node_modules under `resources/server`.
 */
export function resolveTsx(): string {
  const baseDir = resolveProjectRoot();

  const direct = path.join(baseDir, "node_modules/tsx/dist/cli.mjs");
  if (fs.existsSync(direct)) return direct;

  const pnpmDir = path.join(baseDir, "node_modules/.pnpm");
  if (fs.existsSync(pnpmDir)) {
    for (const entry of fs.readdirSync(pnpmDir)) {
      if (entry.startsWith("tsx@")) {
        const candidate = path.join(
          pnpmDir,
          entry,
          "node_modules/tsx/dist/cli.mjs",
        );
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  throw new Error(`tsx not found in ${baseDir}`);
}

/** Location of the preload script produced by esbuild. */
export function resolvePreloadScript(): string {
  return path.resolve(__dirname, "./preload.mjs");
}

// ── Mutable user paths ───────────────────────────────────────────

/**
 * Shared reverse-DNS data directory name used by both Electron and Tauri
 * shells. Bundle identifiers stay distinct (so macOS LaunchServices keeps
 * the two apps apart), but user state lives in one place.
 */
const SHARED_APP_DIR = "com.covel.app";

/**
 * Override `userData` to the shared reverse-DNS directory before Electron
 * resolves any path. Must run before `app.whenReady()` (and before any
 * call that materialises userData — session cookies, logs, etc).
 *
 * By default Electron picks `<appData>/<name>` where name = package.json
 * `name` field (→ "@covel/desktop"). We replace it with
 * `<appData>/com.covel.app/` so the Tauri shell sees the same data.
 */
export function applySharedUserDataPath(): void {
  const shared = path.join(app.getPath("appData"), SHARED_APP_DIR);
  app.setPath("userData", shared);

  // One-shot migration from the legacy name-based directory. We only
  // copy when the shared location has no db yet, so a user who has
  // already moved to com.covel.app won't get their state clobbered.
  migrateLegacyUserData(shared);
}

function migrateLegacyUserData(newRoot: string): void {
  const newDb = path.join(newRoot, "data", "covel.db");
  if (fs.existsSync(newDb)) return;

  const appDataRoot = app.getPath("appData");
  const candidates = [
    // Electron's historical default for this project
    path.join(appDataRoot, "@covel", "desktop"),
  ];

  for (const legacy of candidates) {
    const legacyDb = path.join(legacy, "data", "covel.db");
    if (!fs.existsSync(legacyDb)) continue;

    try {
      fs.mkdirSync(newRoot, { recursive: true });
      copyDirRecursive(legacy, newRoot);
      console.log(`[paths] migrated ${legacy} → ${newRoot}`);
    } catch (err) {
      console.warn(`[paths] legacy data migration failed:`, err);
    }
    return;
  }
}

function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/** Root of user-writable state. */
export function userDataRoot(): string {
  return app.getPath("userData");
}

export function userDbPath(): string {
  return path.join(userDataRoot(), "data", "covel.db");
}

export function userLogsDir(): string {
  return path.join(userDataRoot(), "logs");
}

export function userPluginsDir(): string {
  return path.join(userDataRoot(), "plugins");
}

export function userWorldsDir(): string {
  return path.join(userDataRoot(), "worlds");
}

export function userConfigDir(): string {
  return path.join(userDataRoot(), "config");
}

export function userLlmToml(): string {
  return path.join(userConfigDir(), "llm.toml");
}

export function userSettingsJson(): string {
  return path.join(userConfigDir(), "settings.json");
}

export function userServerPortFile(): string {
  return path.join(userDataRoot(), "server.port");
}

// ── Composite helpers ───────────────────────────────────────────

export interface ResolvedPaths {
  readonly userData: string;
  readonly dbPath: string;
  readonly logsDir: string;
  readonly userPluginsDir: string;
  readonly userWorldsDir: string;
  readonly userConfigDir: string;
  readonly userLlmToml: string;
  readonly effectiveLlmToml: string;
  readonly worldsDirs: readonly string[];
  readonly pluginsDirs: readonly string[];
}

/**
 * Resolve all user paths, ensure directories exist, and pick the effective
 * llm.toml (user override wins over bundled default).
 *
 * This is safe to call many times. Missing directories are created.
 */
export function ensureUserPaths(): ResolvedPaths {
  const dirs = [
    path.dirname(userDbPath()),
    userLogsDir(),
    userPluginsDir(),
    userWorldsDir(),
    userConfigDir(),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Seed user llm.toml from bundle on first launch (so users have something to edit)
  const userLlm = userLlmToml();
  const bundledLlm = resolveBundledLlmToml();
  if (!fs.existsSync(userLlm) && fs.existsSync(bundledLlm)) {
    try {
      fs.copyFileSync(bundledLlm, userLlm);
    } catch (err) {
      // Non-fatal: server will fall back to bundled path
      console.warn("[paths] Could not seed user llm.toml:", err);
    }
  }

  const effectiveLlmToml = fs.existsSync(userLlm) ? userLlm : bundledLlm;

  const worldsDirs = [resolveBundledWorldsDir(), userWorldsDir()].filter((p) =>
    fs.existsSync(p),
  );
  const pluginsDirs = [resolveBundledPluginsDir(), userPluginsDir()].filter(
    (p) => fs.existsSync(p),
  );

  return {
    userData: userDataRoot(),
    dbPath: userDbPath(),
    logsDir: userLogsDir(),
    userPluginsDir: userPluginsDir(),
    userWorldsDir: userWorldsDir(),
    userConfigDir: userConfigDir(),
    userLlmToml: userLlm,
    effectiveLlmToml,
    worldsDirs,
    pluginsDirs,
  };
}
