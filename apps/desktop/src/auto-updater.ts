/**
 * Auto-updater wiring — opt-in.
 *
 * This module is a SCAFFOLD. The `electron-updater` package is not a hard
 * dependency of the desktop app: it is loaded lazily so a developer build
 * that hasn't set up a publish channel will not fail to start.
 *
 * To enable in production:
 *   1. `pnpm --filter @covel/desktop add electron-updater`
 *   2. Uncomment the `publish:` block in `electron-builder.yml`
 *   3. Set `COVEL_AUTO_UPDATE=1` in the packaged environment
 *   4. Ensure the built app has a valid signature (required by electron-updater
 *      for security — it verifies the update artifact's code signature).
 *
 * Environment variables:
 *   COVEL_AUTO_UPDATE=1  — enable update checks (default: off)
 *   COVEL_UPDATE_CHANNEL — override release channel (latest|beta|alpha)
 */

import type { BrowserWindow } from "electron";

type LogFn = (level: "info" | "warn" | "error", ...parts: unknown[]) => void;

export interface AutoUpdaterOptions {
	/** Target window to notify about update progress. */
	readonly window: () => BrowserWindow | null;
	/** Logging callback (wired to the persistent log). */
	readonly log: LogFn;
	/** When true, skip all update logic (dev mode or tests). */
	readonly disabled?: boolean;
}

export async function initAutoUpdater(opts: AutoUpdaterOptions): Promise<void> {
	if (opts.disabled) return;
	if (process.env.COVEL_AUTO_UPDATE !== "1") {
		opts.log(
			"info",
			"auto-updater disabled (set COVEL_AUTO_UPDATE=1 to enable)",
		);
		return;
	}

	// Lazy-load so electron-updater is optional at install time.
	let autoUpdater: unknown;
	try {
		// `electron-updater` is not declared in package.json dependencies (it is
		// an opt-in runtime extra), so TypeScript can't resolve the module at
		// compile time — this is expected. esbuild marks it external, and the
		// dynamic import returns null when the package is absent.
		// @ts-expect-error -- optional runtime dependency
		const mod = await import("electron-updater").catch(() => null);
		if (!mod) {
			opts.log(
				"warn",
				"auto-updater: `electron-updater` is not installed — skipping",
			);
			return;
		}
		autoUpdater = (mod as { autoUpdater?: unknown }).autoUpdater;
	} catch (err) {
		opts.log("warn", "auto-updater: import failed:", err);
		return;
	}
	if (!autoUpdater) return;

	type Updater = {
		channel?: string;
		autoDownload: boolean;
		logger: unknown;
		on(event: string, handler: (...args: unknown[]) => void): void;
		checkForUpdatesAndNotify(): Promise<unknown>;
	};
	const updater = autoUpdater as Updater;

	const channel = process.env.COVEL_UPDATE_CHANNEL;
	if (channel) updater.channel = channel;

	// Show download progress but require user consent before installing.
	updater.autoDownload = true;

	updater.logger = {
		info: (...args: unknown[]) => opts.log("info", "[auto-updater]", ...args),
		warn: (...args: unknown[]) => opts.log("warn", "[auto-updater]", ...args),
		error: (...args: unknown[]) => opts.log("error", "[auto-updater]", ...args),
		debug: () => undefined,
	};

	const notify = (channel: string, payload: unknown): void => {
		const win = opts.window();
		if (win && !win.isDestroyed()) {
			win.webContents.send(channel, payload);
		}
	};

	updater.on("checking-for-update", () => notify("covel:update:checking", {}));
	updater.on("update-available", (info: unknown) =>
		notify("covel:update:available", info),
	);
	updater.on("update-not-available", () =>
		notify("covel:update:not-available", {}),
	);
	updater.on("download-progress", (info: unknown) =>
		notify("covel:update:progress", info),
	);
	updater.on("update-downloaded", (info: unknown) =>
		notify("covel:update:downloaded", info),
	);
	updater.on("error", (err: unknown) =>
		notify("covel:update:error", String(err)),
	);

	try {
		await updater.checkForUpdatesAndNotify();
	} catch (err) {
		opts.log("warn", "auto-updater: initial check failed:", err);
	}
}
