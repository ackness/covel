import { dialog, shell, type MessageBoxOptions } from "electron";
import { shouldPromptForUpdate } from "./app-update.js";
import {
  readIgnoredUpdateVersion,
  writeIgnoredUpdateVersion,
} from "./app-update-state.js";
import { getMainWindow } from "./windows.js";
import { writeLog } from "./logging.js";
import { t } from "./main-i18n.js";

const LATEST_RELEASE_URL = "https://github.com/AcKnEsS/covel/releases/latest";

export interface LatestCovelRelease {
  readonly version: string;
  readonly name: string | null;
  readonly publishedAt: string;
}

export interface AppUpdateNotificationDeps {
  readonly currentVersion: string;
  readonly stateFile: string;
  readonly fetchLatestRelease: () => Promise<LatestCovelRelease>;
}

/** Check once at startup and show a platform-native prompt for a newer release. */
export async function showAppUpdateNotification(
  deps: AppUpdateNotificationDeps,
): Promise<void> {
  let release: LatestCovelRelease;
  try {
    release = await deps.fetchLatestRelease();
  } catch (error) {
    // Update discovery is best-effort and must never make startup noisy.
    writeLog("warn", "App update check failed:", error);
    return;
  }

  const ignoredVersion = readIgnoredUpdateVersion(deps.stateFile);
  if (
    !shouldPromptForUpdate(deps.currentVersion, release.version, ignoredVersion)
  ) {
    return;
  }

  const options: MessageBoxOptions = {
    type: "info",
    title: t("update.title"),
    message: t("update.message", { version: release.version }),
    detail: t("update.detail", { currentVersion: deps.currentVersion }),
    buttons: [t("update.openRelease"), t("update.ignoreVersion")],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const win = getMainWindow();
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);

  if (result.response === 0) {
    await shell.openExternal(LATEST_RELEASE_URL);
    return;
  }
  try {
    writeIgnoredUpdateVersion(deps.stateFile, release.version);
  } catch (error) {
    writeLog("warn", "Could not persist ignored app-update version:", error);
  }
}
