import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { loadKeysEnv, saveKeysEnv } from "./env-files.js";
import {
  importAsset,
  type ImportKind,
  type ImportResult,
} from "./import-assets.js";
import { writeLog } from "./logging.js";
import { writeDataRoot, type ensureUserPaths } from "./paths.js";
import {
  buildAppMenu,
  getMainWindow,
  isTrustedFrameUrl,
  isTrustedStartupFrameUrl,
} from "./windows.js";
import { setDesktopLocaleFromSettings, t } from "./main-i18n.js";
import {
  isSettingsEntries,
  readSettingsBundle,
  writeSettingsEntriesAtomic,
} from "./settings-json.js";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";

/**
 * Defense-in-depth: reject secret/config IPC unless the sender frame is
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

function isTrustedRecoverySender(
  event: Electron.IpcMainInvokeEvent,
  channel: string,
): boolean {
  const frame = event.senderFrame;
  const isMainFrame = frame !== null && frame === event.sender.mainFrame;
  if (
    isMainFrame &&
    (isTrustedFrameUrl(frame.url) || isTrustedStartupFrameUrl(frame.url))
  ) {
    return true;
  }
  writeLog(
    "warn",
    `[ipc] blocked '${channel}' from untrusted recovery frame: ${frame?.url ?? "unknown"}`,
  );
  return false;
}

type DesktopPaths = ReturnType<typeof ensureUserPaths>;

function isSidecarUnavailable(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && error.name === "SidecarUnavailableError")
  );
}

function revisionConflictResult(
  error: unknown,
): { ok: false; code: "settings_revision_conflict"; revision: number } | null {
  const candidate = error as { code?: unknown; revision?: unknown };
  return candidate?.code === "settings_revision_conflict" &&
    typeof candidate.revision === "number"
    ? {
        ok: false,
        code: "settings_revision_conflict",
        revision: candidate.revision,
      }
    : null;
}

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
  readonly getSettingsViaSidecar: () => Promise<SettingsPersistenceBundle>;
  readonly saveSettingsViaSidecar: (
    entries: Record<string, unknown>,
    expectedRevision: number,
  ) => Promise<SettingsPersistenceBundle>;
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

  // Audit 2026-07-16 L-4: these mutate the app / open OS paths, so gate them on
  // the same trusted-sender check the secret channels use — defense in depth
  // behind nav-pinning, so an untrusted frame can't drive restart/dir actions.
  ipcMain.handle("covel:retry-startup", (event) => {
    if (!isTrustedRecoverySender(event, "covel:retry-startup")) return;
    retryStartup();
  });

  ipcMain.handle("covel:open-logs-dir", async (event) => {
    if (!isTrustedRecoverySender(event, "covel:open-logs-dir")) return;
    await shell.openPath(paths.logsDir);
  });

  ipcMain.handle("covel:open-config-dir", async (event) => {
    if (!isTrustedSender(event, "covel:open-config-dir")) return;
    await shell.openPath(paths.covelHome);
  });

  ipcMain.handle("covel:open-data-dir", async (event) => {
    if (!isTrustedRecoverySender(event, "covel:open-data-dir")) return;
    await shell.openPath(paths.dataRoot);
  });

  ipcMain.handle("covel:restart-server", (event) => {
    if (!isTrustedSender(event, "covel:restart-server")) return;
    return restartServer();
  });

  // Pick a directory for the next data_root. Does NOT move data — that's
  // deliberate per the "drop-old-data" UX contract; app restart starts fresh
  // in the new location.
  ipcMain.handle("covel:pick-data-dir", async (event) => {
    if (!isTrustedSender(event, "covel:pick-data-dir")) return { path: null };
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
  // TODO: `covel:keys:load` returns the real decrypted key values to the
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
  // whole key-flow (server-side injection), which is out of scope here.
  ipcMain.handle("covel:keys:load", (event) => {
    // Returns RAW provider keys — reject any untrusted sender frame.
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
  // Read/write preserve the versioned bundle so the renderer can use CAS.
  ipcMain.handle("covel:settings:load", (event) => {
    if (!isTrustedSender(event, "covel:settings:load")) return null;
    return getSettingsViaSidecar().catch((error: unknown) => {
      if (!isSidecarUnavailable(error)) throw error;
      // A missing file is a fresh install, but an existing unreadable or
      // malformed bundle must reject hydration. Returning `{}` here would let
      // the next auto-save overwrite the only recoverable user settings.
      return readSettingsBundle(paths.userSettingsJsonPath);
    });
  });
  ipcMain.handle("covel:settings:save", async (event, payload: unknown) => {
    if (!isTrustedSender(event, "covel:settings:save")) return { ok: false };
    if (!payload || typeof payload !== "object") return { ok: false };
    const { entries, expectedRevision } = payload as {
      entries?: unknown;
      expectedRevision?: unknown;
    };
    if (
      !isSettingsEntries(entries) ||
      typeof expectedRevision !== "number" ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0
    ) {
      return { ok: false };
    }
    try {
      try {
        const bundle = await saveSettingsViaSidecar(entries, expectedRevision);
        setDesktopLocaleFromSettings(entries);
        Menu.setApplicationMenu(buildAppMenu());
        return { ok: true, bundle };
      } catch (err) {
        const conflict = revisionConflictResult(err);
        if (conflict) return conflict;
        if (!isSidecarUnavailable(err)) throw err;
        writeLog("warn", "settings:save sidecar fallback:", err);
        const bundle = writeSettingsEntriesAtomic(
          paths.userSettingsJsonPath,
          entries,
          expectedRevision,
        );
        setDesktopLocaleFromSettings(entries);
        Menu.setApplicationMenu(buildAppMenu());
        return { ok: true, bundle };
      }
    } catch (err) {
      const conflict = revisionConflictResult(err);
      if (conflict) return conflict;
      writeLog("error", "settings:save failed:", err);
      return { ok: false };
    }
  });

  // Asset import — the sourcePath always originates from a native dialog in the
  // MAIN process (see `pickAndImport` below), never from a renderer-supplied
  // string. The old renderer-facing `covel:import:{plugin,world}` channels were
  // removed (arbitrary-path vector) — they had no callers.
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

  // Audit 2026-07-16 L-4: these drive a native import dialog (installs a
  // plugin/world) — a strictly worse action than opening a dir — so gate them
  // on the same trusted-sender check as the other dialog-backed channels.
  ipcMain.handle("covel:import:pick-plugin", (event) => {
    if (!isTrustedSender(event, "covel:import:pick-plugin")) {
      return { ok: false, kind: "plugin", message: t("import.cancelled") };
    }
    return pickAndImport("plugin");
  });
  ipcMain.handle("covel:import:pick-world", (event) => {
    if (!isTrustedSender(event, "covel:import:pick-world")) {
      return { ok: false, kind: "world", message: t("import.cancelled") };
    }
    return pickAndImport("world");
  });
}
