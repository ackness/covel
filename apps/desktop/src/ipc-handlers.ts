import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { loadKeysEnv, saveKeysEnv } from "./env-files.js";
import {
  importAsset,
  type ImportKind,
  type ImportResult,
} from "./import-assets.js";
import { writeLog } from "./logging.js";
import { writeDataRoot, type ensureUserPaths } from "./paths.js";
import { buildAppMenu, getMainWindow, isTrustedFrameUrl } from "./windows.js";
import { setDesktopLocaleFromSettings, t } from "./main-i18n.js";

/**
 * H-09 defense-in-depth: reject secret/config IPC unless the sender frame is
 * the trusted app origin (the local sidecar / dev server). The main-frame
 * navigation guard (windows.ts) is the primary block; this stops any other
 * frame (a stray iframe, a not-yet-committed cross-origin page) from reading
 * provider keys or the REST token via the `covelIpc` bridge.
 */
function isTrustedSender(
  event: Electron.IpcMainInvokeEvent,
  channel: string,
): boolean {
  if (isTrustedFrameUrl(event.senderFrame?.url)) return true;
  writeLog(
    "warn",
    `[ipc] blocked '${channel}' from untrusted origin: ${
      event.senderFrame?.url ?? "unknown"
    }`,
  );
  return false;
}

type DesktopPaths = ReturnType<typeof ensureUserPaths>;

export interface DesktopIpcHandlersDeps {
  readonly paths: DesktopPaths;
  readonly isDev: boolean;
  readonly getServerPort: () => number;
  readonly restToken: string;
  readonly retryStartup: () => void;
  readonly restartServer: () => Promise<
    | { readonly ok: true; readonly port: number }
    | { readonly ok: false; readonly port: number; readonly error: string }
  >;
  readonly getSettingsViaSidecar: () => Promise<Record<string, unknown>>;
  readonly saveSettingsViaSidecar: (
    entries: Record<string, unknown>,
  ) => Promise<void>;
  readonly saveKeysViaSidecar: (keys: Record<string, string>) => Promise<void>;
}

export function registerDesktopIpcHandlers({
  paths,
  isDev,
  getServerPort,
  restToken,
  retryStartup,
  restartServer,
  getSettingsViaSidecar,
  saveSettingsViaSidecar,
  saveKeysViaSidecar,
}: DesktopIpcHandlersDeps): void {
  ipcMain.handle("covel:get-info", async (event) => {
    // Returns `restToken` (privileged sidecar bearer) — gate on sender origin.
    if (!isTrustedSender(event, "covel:get-info")) return null;
    return {
      version: app.getVersion(),
      platform: process.platform,
      isDev,
      covelHome: paths.covelHome,
      dataRoot: paths.dataRoot,
      logsDir: paths.logsDir,
      dbPath: paths.dbPath,
      configTomlPath: paths.configTomlPath,
      llmTomlPath: paths.userLlmTomlPath,
      keysEnvPath: paths.userKeysEnvPath,
      serverPort: getServerPort(),
      // The renderer attaches `Authorization: Bearer <restToken>` on
      // privileged calls (PUT /api/config/{keys,settings,data-root},
      // POST /api/config/open-folder). The sidecar enforces it via
      // COVEL_DESKTOP_REST_TOKEN.
      restToken,
    };
  });

  ipcMain.handle("covel:retry-startup", () => {
    retryStartup();
  });

  ipcMain.handle("covel:open-logs-dir", async () => {
    await shell.openPath(paths.logsDir);
  });

  ipcMain.handle("covel:open-config-dir", async () => {
    await shell.openPath(paths.covelHome);
  });

  ipcMain.handle("covel:open-data-dir", async () => {
    await shell.openPath(paths.dataRoot);
  });

  ipcMain.handle("covel:restart-server", () => restartServer());

  // Pick a directory for the next data_root. Does NOT move data — that's
  // deliberate per the "drop-old-data" UX contract; app restart starts fresh
  // in the new location.
  ipcMain.handle("covel:pick-data-dir", async () => {
    const result = await dialog.showOpenDialog({
      title: t("dialog.dataDir.title"),
      properties: ["openDirectory", "createDirectory"],
      defaultPath: paths.dataRoot,
    });
    if (result.canceled || !result.filePaths[0]) return { path: null };
    writeDataRoot(result.filePaths[0]);
    return { path: result.filePaths[0] };
  });

  // API keys — plain `KEY=VALUE` lines at ~/.covel/keys.env. No encryption;
  // the primary store (browser localStorage) is plain text anyway, so
  // safeStorage only bought us a macOS Keychain prompt with no real security
  // uplift on an unsigned build.
  //
  // TODO(S-07): `covel:keys:load` returns the real decrypted key values to the
  // renderer. This is a deliberate tradeoff — the renderer needs the raw keys
  // to attach them via the `X-Provider-Keys` header and to mirror them into
  // `localStorage` (`covel:keys`) for the pure-web path. Intended proper fix:
  // encrypt `keys.env` at rest via Electron `safeStorage` (main process) AND
  // stop exposing raw values to the renderer — the renderer would see only a
  // per-provider "configured" status while the main process injects keys into
  // outbound requests. Not done here: safeStorage-at-rest alone buys nothing
  // while the localStorage mirror stays plaintext, and on unsigned builds
  // safeStorage degrades to a fixed key (no real encryption) plus a migration
  // path for existing plaintext files. Doing it right requires reworking the
  // whole key-flow (server-side injection), which is out of scope for S-07.
  ipcMain.handle("covel:keys:load", (event) => {
    // Returns RAW provider keys — reject any untrusted sender frame (H-09).
    if (!isTrustedSender(event, "covel:keys:load")) return {};
    return loadKeysEnv(paths.userKeysEnvPath);
  });
  ipcMain.handle("covel:keys:save", async (event, payload: unknown) => {
    if (!isTrustedSender(event, "covel:keys:save")) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    const keys: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof v === "string") keys[k] = v;
    }
    try {
      try {
        await saveKeysViaSidecar(keys);
      } catch (err) {
        writeLog("warn", "keys:save sidecar fallback:", err);
        saveKeysEnv(paths.userKeysEnvPath, keys);
      }
      return { ok: true };
    } catch (err) {
      writeLog("error", "keys:save failed:", err);
      return { ok: false };
    }
  });

  // Settings.json round-trip — the unified SettingsStore's desktop backend.
  // Read returns the `entries` map only; writes accept the full entries blob
  // and rewrite the file atomically with a timestamp for audit purposes.
  ipcMain.handle("covel:settings:load", (event) => {
    if (!isTrustedSender(event, "covel:settings:load")) return {};
    return getSettingsViaSidecar().catch(() => {
      try {
        const raw = fs.readFileSync(paths.userSettingsJsonPath, "utf-8");
        const parsed = JSON.parse(raw) as {
          entries?: Record<string, unknown>;
        };
        return parsed.entries ?? {};
      } catch {
        return {};
      }
    });
  });
  ipcMain.handle("covel:settings:save", async (event, payload: unknown) => {
    if (!isTrustedSender(event, "covel:settings:save")) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    const entries = payload as Record<string, unknown>;
    try {
      try {
        await saveSettingsViaSidecar(entries);
      } catch (err) {
        writeLog("warn", "settings:save sidecar fallback:", err);
        fs.mkdirSync(path.dirname(paths.userSettingsJsonPath), {
          recursive: true,
        });
        const bundle = {
          schemaVersion: 1,
          savedAt: new Date().toISOString(),
          entries,
        };
        fs.writeFileSync(
          paths.userSettingsJsonPath,
          JSON.stringify(bundle, null, 2) + "\n",
          { mode: 0o600 },
        );
        // mode only applies on file creation; re-assert 0600 so an existing
        // looser-permission settings.json (may carry secrets) gets tightened
        // (audit M1). chmod is a no-op on Windows but does not throw.
        fs.chmodSync(paths.userSettingsJsonPath, 0o600);
      }
      setDesktopLocaleFromSettings(entries);
      Menu.setApplicationMenu(buildAppMenu());
      return { ok: true };
    } catch (err) {
      writeLog("error", "settings:save failed:", err);
      return { ok: false };
    }
  });

  // Asset import — the sourcePath always originates from a native dialog in the
  // MAIN process (see `pickAndImport` below), never from a renderer-supplied
  // string. The old renderer-facing `covel:import:{plugin,world}` channels were
  // removed (audit S-08: arbitrary-path vector) — they had no callers.
  async function handleImport(
    kind: ImportKind,
    payload: unknown,
  ): Promise<ImportResult> {
    if (!payload || typeof payload !== "object") {
      return { ok: false, kind, message: t("import.invalidPayload") };
    }
    const sourcePath = (payload as { sourcePath?: string }).sourcePath;
    if (typeof sourcePath !== "string") {
      return { ok: false, kind, message: t("import.sourcePathRequired") };
    }
    try {
      const result = await importAsset(kind, sourcePath);
      writeLog(
        result.ok ? "info" : "warn",
        `import(${kind}) ${result.ok ? "ok" : "failed"}: ${
          result.message ?? result.itemName ?? ""
        }`,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeLog("error", `import(${kind}) threw: ${message}`);
      return { ok: false, kind, message };
    }
  }

  // Dialog-backed entry points. Open a native file chooser, then import.
  async function pickAndImport(kind: ImportKind): Promise<ImportResult> {
    const win = getMainWindow() ?? undefined;
    const picked = await dialog.showOpenDialog(win as BrowserWindow, {
      title:
        kind === "plugin"
          ? t("dialog.importPlugin.title")
          : t("dialog.importWorld.title"),
      properties: ["openFile", "openDirectory", "treatPackageAsDirectory"],
      filters: [
        { name: t("dialog.filter.zipArchives"), extensions: ["zip"] },
        { name: t("dialog.filter.allFiles"), extensions: ["*"] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, kind, message: t("import.cancelled") };
    }
    return handleImport(kind, { sourcePath: picked.filePaths[0] });
  }

  ipcMain.handle("covel:import:pick-plugin", () => pickAndImport("plugin"));
  ipcMain.handle("covel:import:pick-world", () => pickAndImport("world"));
}
