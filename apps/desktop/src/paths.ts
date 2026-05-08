/**
 * Centralized path resolution for the Covel desktop app.
 *
 * New layout (2026-04):
 *
 *   ~/.covel/                     ← config root (small, stable)
 *     config.toml                 ← [paths] data_root pointer + [logging] params
 *     llm.toml                    ← user-editable LLM slot config
 *     keys.env                    ← API keys (KEY=VALUE plain text)
 *     plugins/                    ← user-installed plugins
 *
 *   <data_root>/                  ← default ~/.covel/data; user can redirect via config.toml
 *     covel.db                    ← SQLite
 *     worlds/                     ← user-created worlds
 *     logs/
 *       server-*.log              ← pino-roll output (10MB × 10 by default)
 *       electron-*.log            ← main-process log
 *     server.port
 *
 * Bundled (read-only) paths still live next to the app bundle.
 */

import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** True when running via `electron .` or similar unpackaged launch. */
export const isDev = !app.isPackaged;

// ── Config root (~/.covel) ──────────────────────────────────────

/**
 * Root of the user's Covel config. Stable across platforms — no reliance on
 * Electron's `app.getPath("userData")`. Overridable via COVEL_HOME env for
 * tests or unusual setups.
 */
export function covelHome(): string {
  return process.env.COVEL_HOME ?? path.join(os.homedir(), ".covel");
}

export function configTomlPath(): string {
  return path.join(covelHome(), "config.toml");
}

export function userLlmTomlPath(): string {
  return path.join(covelHome(), "llm.toml");
}

export function userKeysEnvPath(): string {
  return path.join(covelHome(), "keys.env");
}

export function userSettingsJsonPath(): string {
  return path.join(covelHome(), "settings.json");
}

export function userPluginsDir(): string {
  return path.join(covelHome(), "plugins");
}

interface CovelConfig {
  paths?: { data_root?: string };
  logging?: { max_size_mb?: number; max_files?: number };
}

function readConfig(): CovelConfig {
  const file = configTomlPath();
  if (!fs.existsSync(file)) return {};
  try {
    return parseToml(fs.readFileSync(file, "utf-8")) as CovelConfig;
  } catch (err) {
    console.warn(`[paths] config.toml parse failed:`, err);
    return {};
  }
}

/**
 * Where user data lives. Defaults to `<covelHome>/data` but can be
 * redirected via `[paths] data_root` in `config.toml` — useful when the
 * SQLite file grows large and the user wants it on an external drive.
 */
export function dataRoot(): string {
  const cfg = readConfig();
  const custom = cfg.paths?.data_root;
  if (custom && custom.trim()) {
    return path.isAbsolute(custom) ? custom : path.resolve(covelHome(), custom);
  }
  return path.join(covelHome(), "data");
}

export function userDbPath(): string {
  return path.join(dataRoot(), "covel.db");
}

export function userWorldsDir(): string {
  return path.join(dataRoot(), "worlds");
}

export function userLogsDir(): string {
  return path.join(dataRoot(), "logs");
}

export function userServerPortFile(): string {
  return path.join(dataRoot(), "server.port");
}

export function logRotationConfig(): { maxSizeMb: number; maxFiles: number } {
  const cfg = readConfig();
  return {
    maxSizeMb: cfg.logging?.max_size_mb ?? 10,
    maxFiles: cfg.logging?.max_files ?? 10,
  };
}

// ── Bundled (app-resource) paths ────────────────────────────────

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

export function resolveServerEntry(): string {
  const root = resolveProjectRoot();
  if (isDev) {
    return path.join(root, "apps/server/src/index.ts");
  }
  return path.join(root, "src/index.ts");
}

export function resolveBundledWorldsDir(): string {
  return path.join(resolveProjectRoot(), "worlds");
}

export function resolveBundledPluginsDir(): string {
  return path.join(resolveProjectRoot(), "plugins");
}

export function resolveBundledLlmToml(): string {
  return path.join(resolveProjectRoot(), "llm.toml");
}

/**
 * Find tsx CLI entry point. Packaged apps include node_modules under
 * `resources/server`.
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

export function resolvePreloadScript(): string {
  return path.resolve(__dirname, "./preload.mjs");
}

export function resolveWindowIconPath(): string | null {
  if (process.platform === "darwin") return null;

  const filename = process.platform === "win32" ? "icon.ico" : "icon.png";
  if (isDev) {
    return path.resolve(__dirname, `../resources/${filename}`);
  }
  return path.join(process.resourcesPath, filename);
}

// ── Composite helpers ───────────────────────────────────────────

export interface ResolvedPaths {
  readonly covelHome: string;
  readonly configTomlPath: string;
  readonly dataRoot: string;
  readonly dbPath: string;
  readonly logsDir: string;
  readonly userPluginsDir: string;
  readonly userWorldsDir: string;
  readonly userLlmTomlPath: string;
  readonly userKeysEnvPath: string;
  readonly userSettingsJsonPath: string;
  /** llm.toml the server actually reads — user override wins. */
  readonly effectiveLlmToml: string;
  /** Bundled worlds first, then user worlds. Filtered by existence. */
  readonly worldsDirs: readonly string[];
  /** Bundled plugins first, then user plugins. Filtered by existence. */
  readonly pluginsDirs: readonly string[];
  readonly logRotation: { maxSizeMb: number; maxFiles: number };
}

const DEFAULT_CONFIG_TOML = `# Covel user config.
# Edit [paths] data_root to move user data (SQLite db, worlds, logs) to
# another drive. Relative paths are resolved against this file's directory.

[paths]
# data_root = "/Volumes/External/covel-data"

[logging]
# Rolling log files under <data_root>/logs/. Each file caps at max_size_mb;
# max_files determines how many rotated files are kept before oldest is dropped.
max_size_mb = 10
max_files   = 10
`;

/**
 * Ensure `~/.covel/` and the resolved `<data_root>/` exist, seed a default
 * `config.toml` on first launch, and return every path the rest of the app
 * needs. Safe to call many times.
 */
export function ensureUserPaths(): ResolvedPaths {
  const home = covelHome();
  fs.mkdirSync(home, { recursive: true });

  // Seed a commented config.toml so users can discover the data_root option.
  const cfgFile = configTomlPath();
  if (!fs.existsSync(cfgFile)) {
    try {
      fs.writeFileSync(cfgFile, DEFAULT_CONFIG_TOML);
    } catch (err) {
      console.warn("[paths] Could not seed config.toml:", err);
    }
  }

  const data = dataRoot();
  const dirs = [userPluginsDir(), data, userWorldsDir(), userLogsDir()];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Seed user llm.toml from bundle on first launch so the Settings UI has
  // something visible to edit.
  const userLlm = userLlmTomlPath();
  const bundledLlm = resolveBundledLlmToml();
  if (!fs.existsSync(userLlm) && fs.existsSync(bundledLlm)) {
    try {
      fs.copyFileSync(bundledLlm, userLlm);
    } catch (err) {
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
    covelHome: home,
    configTomlPath: cfgFile,
    dataRoot: data,
    dbPath: userDbPath(),
    logsDir: userLogsDir(),
    userPluginsDir: userPluginsDir(),
    userWorldsDir: userWorldsDir(),
    userLlmTomlPath: userLlm,
    userKeysEnvPath: userKeysEnvPath(),
    userSettingsJsonPath: userSettingsJsonPath(),
    effectiveLlmToml,
    worldsDirs,
    pluginsDirs,
    logRotation: logRotationConfig(),
  };
}

/**
 * Update `[paths] data_root` in `config.toml`. Preserves other fields via a
 * read-modify-write, but uses a simple rewrite strategy — not a full TOML
 * round-trip. Good enough because we own the schema.
 */
export function writeDataRoot(newRoot: string): void {
  const cfgFile = configTomlPath();
  let current = "";
  try {
    current = fs.readFileSync(cfgFile, "utf-8");
  } catch {
    current = DEFAULT_CONFIG_TOML;
  }

  const normalized = newRoot.trim();
  const replacement = normalized
    ? `data_root = ${JSON.stringify(normalized)}`
    : `# data_root = "/Volumes/External/covel-data"`;

  // Replace an existing (possibly commented) data_root line under [paths],
  // else append a new one.
  const pattern = /^(\s*)(#\s*)?data_root\s*=.*$/m;
  let next: string;
  if (pattern.test(current)) {
    next = current.replace(
      pattern,
      (_m, indent: string) => `${indent}${replacement}`,
    );
  } else if (/^\[paths]/m.test(current)) {
    next = current.replace(/^\[paths]\s*$/m, `[paths]\n${replacement}`);
  } else {
    next = `${current.trimEnd()}\n\n[paths]\n${replacement}\n`;
  }

  fs.writeFileSync(cfgFile, next);
}
