/**
 * Config surface — paths and API key management.
 *
 * Frontends read `/api/config/info` at boot to discover where the server
 * thinks its data lives and whether it's a desktop deployment (i.e. the
 * server has access to `~/.covel/keys.env`).
 *
 * When `isDesktop: true`, the Settings UI may additionally use:
 *   GET  /api/config/keys        — list provider names with a configured key
 *   PUT  /api/config/keys        — upsert { [provider]: value } into keys.env
 *                                   (empty value removes the entry)
 *
 * The PUT handler also mutates the in-process `apiKeys` map so the user's
 * first chat-turn after saving picks up the new key without a restart.
 *
 * Electron and self-host desktop REST setups share this API; pure web tiers
 * (T2/T3) get `isDesktop: false` and fall back to the existing
 * X-Provider-Keys header flow driven by browser localStorage.
 */

import { Hono } from "hono";
import { resolve, join, dirname, isAbsolute } from "node:path";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { spawn } from "node:child_process";
import {
  patchDesktopConfigFile,
  readDesktopConfigFile,
} from "@covel/shared/desktop-config/node";
import {
  normalizeProviderKeyMap,
  providerKeyToId,
  readRuntimeEnv,
  toApiKeyEnvMap,
} from "@covel/shared";
import {
  emptySettingsPersistenceBundle,
  nextSettingsPersistenceBundle,
  parseSettingsPersistenceBundle,
  type SettingsPersistenceBundle,
} from "@covel/shared/settings-persistence";
import { errorBody, listBody, readJsonBody } from "../api-error.js";
import { parseEnvLines } from "../lib/env-file.js";
import { makeDesktopRestTokenGuard } from "./privileged-auth.js";
import {
  configureOutboundProxy,
  getOutboundProxyStatus,
  normalizeOutboundProxyConfig,
  type OutboundProxyMode,
} from "@covel/ai-provider";
import {
  readStoredProxyConfig,
  writeStoredProxyConfig,
} from "../lib/proxy-config.js";
import { getDesktopSystemProxyResolver } from "../lib/desktop-system-proxy.js";

export interface ConfigApiDeps {
  /** Mutable map shared with the gateway adapter. PUT handlers mutate in-place. */
  apiKeys: Record<string, string>;
}

export function createConfigApiRoutes(deps: ConfigApiDeps): Hono {
  const app = new Hono();
  const requireToken = makeDesktopRestTokenGuard();
  const initialCovelHome = resolveCovelHome();
  const systemProxyUrl = readRuntimeEnv().systemProxyUrl;
  const resolveSystemProxy = getDesktopSystemProxyResolver();
  try {
    configureOutboundProxy({
      ...(initialCovelHome
        ? readStoredProxyConfig(initialCovelHome)
        : { mode: "direct" as const }),
      systemProxyUrl,
      resolveSystemProxy,
    });
  } catch (error) {
    // A manually edited or previously persisted proxy must not prevent the
    // desktop sidecar from starting. Keep the file for user recovery and run
    // direct until a valid setting is saved.
    console.warn(
      "[proxy-config] Ignoring invalid stored proxy settings:",
      error,
    );
    configureOutboundProxy({
      mode: "direct",
      systemProxyUrl,
      resolveSystemProxy,
    });
  }

  app.get("/api/config/info", (c) => {
    const covelHome = resolveCovelHome();
    const env = readRuntimeEnv();
    const inDesktopMode = covelHome !== null;
    return c.json({
      isDesktop: inDesktopMode,
      covelHome: covelHome,
      dataRoot: resolveDataRoot(),
      dbPath: env.sqlitePath ?? null,
      logsDir: env.logsDir ?? null,
      llmTomlPath: env.llmToml ?? null,
      keysEnvPath: covelHome ? join(covelHome, "keys.env") : null,
      pluginsDir: env.userPluginsDir ?? null,
      worldsDir: env.userWorldsDir ?? null,
      // True when the desktop shell injected a per-launch bearer token. The
      // renderer must attach `Authorization: Bearer <token>` on privileged
      // config calls (settings read/write, key writes, data-root writes,
      // open-folder).
      requiresAuth: !!env.desktopRestToken,
    });
  });

  // GET /api/config/keys — list configured providers WITHOUT returning values.
  // Values travel only inside the server process; the UI shows "configured /
  // not configured" rather than echoing secrets back across HTTP.
  app.get("/api/config/keys", (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) return c.json(listBody([]));

    const file = join(covelHome, "keys.env");
    let entries: Record<string, string>;
    try {
      entries = readKeysEnv(file);
    } catch {
      return c.json(
        errorBody("keys.env could not be read safely", {
          code: "keys_file_unreadable",
        }),
        500,
      );
    }
    const providers: string[] = [];
    for (const key of Object.keys(entries)) {
      if (entries[key]) {
        providers.push(key);
      }
    }
    return c.json(listBody(providers));
  });

  // PUT /api/config/keys — body: { [provider]: value }
  // Empty string / null value → remove that provider's key.
  app.put("/api/config/keys", requireToken, async (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) {
      return c.json(
        errorBody("Key persistence is not available on this deployment.", {
          code: "key_persistence_unavailable",
        }),
        400,
      );
    }

    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    if (!body || typeof body !== "object") {
      return c.json(
        errorBody("Body must be { [provider]: value }", {
          code: "invalid_provider_keys_body",
        }),
        400,
      );
    }

    const file = join(covelHome, "keys.env");
    let entries: Record<string, string>;
    try {
      entries = readKeysEnv(file);
    } catch {
      return c.json(
        errorBody(
          "Refusing to overwrite an unreadable keys.env; repair or back it up first",
          { code: "keys_file_unreadable" },
        ),
        409,
      );
    }

    for (const [provider, raw] of Object.entries(
      body as Record<string, unknown>,
    )) {
      const providerId = providerKeyToId(provider);
      if (!providerId) continue;
      if (typeof raw === "string" && raw.trim()) {
        entries[providerId] = raw.trim();
        deps.apiKeys[providerId] = raw.trim();
      } else {
        delete entries[providerId];
        delete deps.apiKeys[providerId];
      }
    }

    writeKeysEnv(file, entries);
    return c.json({ ok: true });
  });

  // GET /api/config/settings — return the entire settings.json bundle.
  // Self-host desktop REST uses this in place of the Electron
  // `covel:settings:*` IPC channels. Web deployments never see
  // `isDesktop: true` so this never leaks on production web tiers.
  app.get("/api/config/settings", requireToken, (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) {
      return c.json(emptySettingsPersistenceBundle());
    }
    const file = join(covelHome, "settings.json");
    if (!existsSync(file)) {
      return c.json(emptySettingsPersistenceBundle());
    }
    try {
      return c.json(readSettingsBundle(file));
    } catch {
      // `save()` writes a full snapshot. Reporting corrupt/unreadable data as
      // an empty success would let the next one-field edit destroy the only
      // recoverable copy, so make SettingsStore enter its read-only failed
      // hydration state instead.
      return c.json(
        errorBody("settings.json could not be read safely", {
          code: "settings_file_invalid",
        }),
        500,
      );
    }
  });

  // PUT /api/config/settings — body: { entries, expectedRevision }.
  // Atomically rewrites the bundle. Mode 0600 to match `keys.env` — even
  // though `settings.json` should not contain secrets, the user might
  // import/export with `includeSecrets: true`.
  app.put("/api/config/settings", requireToken, async (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) {
      return c.json(
        errorBody("Not a desktop deployment", {
          code: "not_desktop_deployment",
        }),
        400,
      );
    }
    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    if (!body || typeof body !== "object") {
      return c.json(
        errorBody("Body must be { entries: object }", {
          code: "invalid_settings_body",
        }),
        400,
      );
    }
    const rawEntries = (body as { entries?: unknown }).entries;
    if (
      !rawEntries ||
      typeof rawEntries !== "object" ||
      Array.isArray(rawEntries)
    ) {
      return c.json(
        errorBody("Body must be { entries: object }", {
          code: "invalid_settings_body",
        }),
        400,
      );
    }
    const entries = rawEntries as Record<string, unknown>;
    const rawExpectedRevision = (body as { expectedRevision?: unknown })
      .expectedRevision;
    if (
      typeof rawExpectedRevision !== "number" ||
      !Number.isInteger(rawExpectedRevision) ||
      rawExpectedRevision < 0
    ) {
      return c.json(
        errorBody("Body must include expectedRevision: non-negative integer", {
          code: "invalid_settings_body",
        }),
        400,
      );
    }
    const expectedRevision = rawExpectedRevision;
    const file = join(covelHome, "settings.json");
    let current: SettingsPersistenceBundle;
    try {
      current = existsSync(file)
        ? readSettingsBundle(file)
        : emptySettingsPersistenceBundle();
    } catch {
      return c.json(
        errorBody(
          "Refusing to overwrite an unreadable settings.json; repair or back it up first",
          { code: "settings_file_invalid" },
        ),
        409,
      );
    }
    if (current.revision !== expectedRevision) {
      return c.json(
        errorBody("settings.json changed in another instance", {
          code: "settings_revision_conflict",
          details: { revision: current.revision },
        }),
        409,
      );
    }
    const payload = nextSettingsPersistenceBundle(entries, current.revision);
    writePrivateFileAtomic(file, JSON.stringify(payload, null, 2) + "\n");
    return c.json(payload);
  });

  app.get("/api/config/proxy", requireToken, (c) => {
    if (!resolveCovelHome()) {
      return c.json(
        errorBody("Proxy configuration is available only in desktop mode.", {
          code: "proxy_config_unavailable",
        }),
        400,
      );
    }
    return c.json(getOutboundProxyStatus());
  });

  app.put("/api/config/proxy", requireToken, async (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) {
      return c.json(
        errorBody("Proxy configuration is available only in desktop mode.", {
          code: "proxy_config_unavailable",
        }),
        400,
      );
    }
    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    if (!body || typeof body !== "object") {
      return c.json(
        errorBody("Body must be { mode, url? }", {
          code: "invalid_proxy_config",
        }),
        400,
      );
    }
    try {
      const rawMode = (body as { mode?: unknown }).mode;
      if (typeof rawMode !== "string") {
        throw new Error("Proxy mode is required.");
      }
      const config = normalizeOutboundProxyConfig({
        mode: rawMode as OutboundProxyMode,
        url: (body as { url?: string }).url,
      });
      // Fail before hot-applying when a hand-edited config is malformed. The
      // focused writer must never replace the only recoverable source copy.
      readDesktopConfigFile(join(covelHome, "config.toml"));
      const status = configureOutboundProxy({
        ...config,
        systemProxyUrl: readRuntimeEnv().systemProxyUrl,
        resolveSystemProxy,
      });
      // ProxyAgent construction above validates transport-specific details
      // such as credential escaping before the new value reaches disk.
      writeStoredProxyConfig(covelHome, config);
      return c.json(status);
    } catch (error) {
      return c.json(
        errorBody(error instanceof Error ? error.message : String(error), {
          code: "invalid_proxy_config",
        }),
        400,
      );
    }
  });

  // PUT /api/config/data-root — body: { path: string }
  // Rewrites `[paths] data_root` in `~/.covel/config.toml`. Does NOT move
  // existing data: the contract is "new location, fresh start; old data
  // stays where it is". Caller must restart the server to pick up.
  app.put("/api/config/data-root", requireToken, async (c) => {
    const covelHome = resolveCovelHome();
    if (!covelHome) {
      return c.json(
        errorBody("Not a desktop deployment", {
          code: "not_desktop_deployment",
        }),
        400,
      );
    }

    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    const newPath =
      body && typeof body === "object"
        ? (body as { path?: string }).path
        : undefined;
    if (!newPath || typeof newPath !== "string" || !newPath.trim()) {
      return c.json(
        errorBody("Body must include { path: string }", {
          code: "invalid_data_root_body",
        }),
        400,
      );
    }

    const trimmed = newPath.trim();
    if (!isAbsolute(trimmed)) {
      return c.json(
        errorBody("data_root must be an absolute path", {
          code: "data_root_not_absolute",
        }),
        400,
      );
    }

    try {
      writeDataRootInConfig(covelHome, trimmed);
    } catch (err) {
      return c.json(
        errorBody(
          `Could not write config.toml: ${err instanceof Error ? err.message : err}`,
          { code: "config_write_failed" },
        ),
        500,
      );
    }

    return c.json({ ok: true, restartRequired: true });
  });

  // POST /api/config/open-folder — body: { target: "config" | "data" | "logs" | "llm.toml" | "keys.env" }
  // Opens the requested folder or file in the platform default application.
  // The whitelist keeps callers from reaching arbitrary filesystem paths.
  app.post("/api/config/open-folder", requireToken, async (c) => {
    const parsed = await readJsonBody(c);
    if (parsed instanceof Response) return parsed;
    const body = parsed.body;
    const target =
      body && typeof body === "object"
        ? (body as { target?: string }).target
        : undefined;

    const covelHome = resolveCovelHome();
    const env = readRuntimeEnv();
    const targetMap: Record<string, string | null | undefined> = {
      config: covelHome,
      data: resolveDataRoot(),
      logs: env.logsDir,
      "llm.toml": covelHome ? join(covelHome, "llm.toml") : null,
      "keys.env": covelHome ? join(covelHome, "keys.env") : null,
    };

    if (!target || !(target in targetMap)) {
      return c.json(
        errorBody(
          `target must be one of: ${Object.keys(targetMap).join(", ")}`,
          { code: "invalid_open_target" },
        ),
        400,
      );
    }
    const path = targetMap[target];
    if (!path || !existsSync(path)) {
      return c.json(
        errorBody(`"${target}" is not available at ${path}`, {
          code: "open_target_unavailable",
        }),
        400,
      );
    }

    try {
      await openInFileManager(path);
      return c.json({ ok: true });
    } catch (err) {
      return c.json(
        errorBody(err instanceof Error ? err.message : String(err), {
          code: "open_target_failed",
        }),
        500,
      );
    }
  });

  return app;
}

/**
 * Spawn the platform file manager to reveal `folder`. We intentionally avoid
 * `shell: true` and pass the path as its own argv entry so arbitrary shell
 * metacharacters in the folder name stay literal.
 */
function openInFileManager(folder: string): Promise<void> {
  const cmd =
    platform() === "win32"
      ? "explorer"
      : platform() === "darwin"
        ? "open"
        : "xdg-open";
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, [folder], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", reject);
    // Detach so the child survives this request's end.
    child.unref();
    resolvePromise();
  });
}

function writeDataRootInConfig(covelHome: string, newPath: string): void {
  patchDesktopConfigFile(join(covelHome, "config.toml"), {
    paths: { data_root: newPath },
  });
}

/**
 * Effective data_root. Prefer the explicit `COVEL_DATA_ROOT` set by the
 * desktop shell (which already owns the real resolved value). Fallback:
 * derive from `COVEL_USER_WORLDS_DIR/..` so self-host deployments that
 * only wire worlds still give a sensible answer. Returns null when
 * nothing is configured.
 */
function resolveDataRoot(): string | null {
  const env = readRuntimeEnv();
  if (env.dataRoot) return env.dataRoot;
  if (env.userWorldsDir) {
    return resolve(env.userWorldsDir, "..");
  }
  return null;
}

/**
 * Desktop-mode gate. Writing `keys.env`, mutating `data_root`, and
 * firing platform `open` commands are **privileged** — we only expose
 * them when the caller process was explicitly started as a desktop shell.
 *
 * Trigger conditions (explicit only — filesystem presence is NOT enough):
 *   1. `COVEL_DESKTOP_REST=1` (opt-in flag for embedded/self-host cases)
 *   2. `COVEL_HOME` set by Electron
 *
 * A shared-backend deployment that happens to have `~/.covel/` on disk
 * (docker image bundling, admin home dir) therefore CAN'T reach these
 * endpoints, which prevents a remote client from editing server config.
 */
function resolveCovelHome(): string | null {
  const env = readRuntimeEnv();
  const explicitDesktop = env.desktopRest || !!env.covelHome;
  if (!explicitDesktop) return null;
  if (env.covelHome) return env.covelHome;
  const candidate = join(homedir(), ".covel");
  return existsSync(candidate) ? candidate : null;
}

function readKeysEnv(file: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!existsSync(file)) return result;
  for (const [key, val] of parseEnvLines(readFileSync(file, "utf-8"))) {
    result[key] = val;
  }
  return normalizeProviderKeyMap(result);
}

function readSettingsBundle(file: string): SettingsPersistenceBundle {
  return parseSettingsPersistenceBundle(
    JSON.parse(readFileSync(file, "utf-8")) as unknown,
  );
}

function writePrivateFileAtomic(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, contents, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch (err) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Preserve the original write error.
    }
    throw err;
  }
}

function writeKeysEnv(file: string, entries: Record<string, string>): void {
  const envEntries = toApiKeyEnvMap(entries);
  const header =
    `# Covel provider API keys. One KEY=VALUE per line.\n` +
    `# Managed by Settings → Desktop. Manual edits survive restarts.\n` +
    `# File mode is 0600 — keep it that way.\n\n`;
  const body = Object.entries(envEntries)
    // audit M2: reject values with CR/LF — a newline would inject extra
    // `KEY=VALUE` lines and poison other providers' key parsing.
    .filter(([k, v]) => {
      if (!k || typeof v !== "string" || !v.trim()) return false;
      if (/[\r\n]/.test(v)) {
        console.warn(
          `[config-api] Skipping key "${k}": value contains a newline`,
        );
        return false;
      }
      return true;
    })
    .map(([k, v]) => `${k}=${v.trim()}`)
    .join("\n");
  writePrivateFileAtomic(file, header + body + "\n");
}
