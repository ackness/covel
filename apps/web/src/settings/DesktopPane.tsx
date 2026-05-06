/**
 * Desktop-only pane for the Settings dialog.
 *
 * Visible only when running inside the Electron/Tauri shell (detected via
 * `isDesktopApp()`). Exposes paths and actions: open config / data / logs
 * folders, change data_root, restart the backend server, reset onboarding.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AlertTriangle,
	FolderOpen,
	FileText,
	RotateCw,
	Info,
	Loader2,
	RefreshCcw,
	HardDrive,
	FileCode,
	KeyRound,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
	hasElectronIpc,
	getDesktopInfo,
	isDesktopApp,
	openLogsDir,
	openConfigDir,
	openDataDir,
	openLlmToml,
	openKeysEnv,
	pickDataDir,
	reloadServerAndWait,
} from "@/lib/desktop-bridge.js";
import { resetOnboarding } from "@/components/onboarding-wizard.js";
import { useSession } from "@/stores/session-store.js";

interface DesktopInfo {
	version: string;
	platform: string;
	isDev: boolean;
	covelHome: string;
	dataRoot: string;
	logsDir: string;
	dbPath: string;
	configTomlPath: string;
	llmTomlPath: string;
	keysEnvPath: string;
	serverPort: number;
}

export function DesktopPane() {
	const { t } = useTranslation();
	const { state } = useSession();
	const [info, setInfo] = useState<DesktopInfo | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	// First-launch llm.toml detection (O-6). Only surface on desktop builds
	// where opening the file actually works; Web users can't edit the sidecar
	// config file anyway. `state.llmConfig.configured === false` means the
	// server booted without any `[covel.<slot>]` sections and is running on
	// the built-in DeepSeek fallback — a state the user almost certainly
	// wants to know about before it silently consumes credits.
	const showLlmMissingBanner =
		isDesktopApp() && state.llmConfig?.configured === false;

	useEffect(() => {
		getDesktopInfo()
			.then((i) => setInfo(i as DesktopInfo | null))
			.catch(() => {});
	}, []);

	async function refreshInfo() {
		setBusy("refresh");
		try {
			const i = await getDesktopInfo();
			setInfo(i as DesktopInfo | null);
		} finally {
			setBusy(null);
		}
	}

	async function handleRestart() {
		if (!hasElectronIpc()) {
			setToast(t("settings.desktopRestartElectronOnly"));
			setTimeout(() => setToast(null), 3000);
			return;
		}
		setBusy("restart");
		try {
			await reloadServerAndWait({
				message: t("reload.reloadingServer", "Restarting backend…"),
			});
		} catch (err) {
			setToast(err instanceof Error ? err.message : "Restart failed");
			setBusy(null);
			setTimeout(() => setToast(null), 3000);
		}
		// On success the helper calls window.location.reload(); any code path
		// that reaches here means we need to leave `busy` cleared.
	}

	async function handlePickDataDir() {
		setBusy("pick");
		try {
			let manualPath: string | undefined;
			if (!hasElectronIpc()) {
				const entered = window.prompt(
					"Enter an absolute path for the new data directory:\n\n" +
						"Examples:\n  /Users/me/Documents/covel\n  /Volumes/External/covel-data\n\n" +
						"Changing this will not move existing data — the new location starts fresh.",
					info?.dataRoot ?? "",
				);
				if (!entered || !entered.trim()) return;
				manualPath = entered.trim();
			}
			const picked = await pickDataDir(manualPath);
			if (picked) {
				setToast(`Data root set to ${picked}. Restart the app to apply.`);
				await refreshInfo();
			}
		} catch (err) {
			setToast(
				err instanceof Error ? err.message : "Could not change data root",
			);
		} finally {
			setBusy(null);
			setTimeout(() => setToast(null), 5000);
		}
	}

	function handleResetOnboarding() {
		resetOnboarding();
		setToast("Onboarding will show on next launch");
		setTimeout(() => setToast(null), 3000);
	}

	return (
		<div className="space-y-5">
			{toast && (
				<div className="text-xs px-3 py-2 rounded bg-primary/10 border border-primary/20 text-primary">
					{toast}
				</div>
			)}

			{showLlmMissingBanner && (
				<div className="border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 rounded space-y-2">
					<div className="flex items-start gap-2">
						<AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
						<div className="space-y-1 flex-1">
							<p className="text-xs font-medium text-amber-900 dark:text-amber-200">
								{t(
									"settings.desktopLlmMissingTitle",
									"No LLM slots configured yet",
								)}
							</p>
							<p className="text-[11px] text-amber-800/80 dark:text-amber-200/70 leading-relaxed">
								{t(
									"settings.desktopLlmMissingHint",
									"Click below to open ~/.covel/llm.toml and add at least one [covel.<slot>] section.",
								)}
							</p>
						</div>
					</div>
					<Button
						size="sm"
						variant="outline"
						className="h-7 text-xs"
						onClick={() => openLlmToml().catch((err) => setToast(String(err)))}
					>
						<FileCode className="w-3 h-3 mr-1.5" />
						{t("settings.desktopEditLlm")}
					</Button>
				</div>
			)}

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{t("settings.desktopDataLocations")}
				</h3>
				<div className="space-y-2 text-xs">
					<InfoRow
						label={t("settings.desktopDataConfig")}
						value={info?.covelHome ?? "—"}
						mono
					/>
					<InfoRow
						label={t("settings.desktopDataData")}
						value={info?.dataRoot ?? "—"}
						mono
					/>
					<InfoRow
						label={t("settings.desktopDataDb")}
						value={info?.dbPath ?? "—"}
						mono
					/>
					<InfoRow
						label={t("settings.desktopDataLogs")}
						value={info?.logsDir ?? "—"}
						mono
					/>
				</div>
				<div className="flex flex-wrap gap-2 pt-1">
					<Button size="sm" variant="outline" onClick={() => openConfigDir()}>
						<FolderOpen className="w-3 h-3 mr-1.5" />
						{t("settings.desktopOpenConfig")}
					</Button>
					<Button size="sm" variant="outline" onClick={() => openDataDir()}>
						<FolderOpen className="w-3 h-3 mr-1.5" />
						{t("settings.desktopOpenData")}
					</Button>
					<Button size="sm" variant="outline" onClick={() => openLogsDir()}>
						<FileText className="w-3 h-3 mr-1.5" />
						{t("settings.desktopOpenLogs")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={handlePickDataDir}
						disabled={busy !== null}
					>
						<HardDrive className="w-3 h-3 mr-1.5" />
						{t("settings.desktopChangeData")}
					</Button>
				</div>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{t("settings.desktopEditFiles")}
				</h3>
				<div className="text-xs text-muted-foreground">
					{t("settings.desktopEditFilesHint")}
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						size="sm"
						variant="outline"
						onClick={() => openLlmToml().catch((err) => setToast(String(err)))}
					>
						<FileCode className="w-3 h-3 mr-1.5" />
						{t("settings.desktopEditLlm")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={() => openKeysEnv().catch((err) => setToast(String(err)))}
					>
						<KeyRound className="w-3 h-3 mr-1.5" />
						{t("settings.desktopEditKeys")}
					</Button>
				</div>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{t("settings.desktopServer")}
				</h3>
				<div className="text-xs text-muted-foreground">
					{t("settings.desktopServerPort")}
					<span className="font-mono text-foreground">
						{info?.serverPort ?? "?"}
					</span>
					.
				</div>
				<div className="text-[11px] text-muted-foreground leading-relaxed">
					{t("settings.desktopRestartHint")}
				</div>
				<div className="flex flex-wrap gap-2">
					{hasElectronIpc() && (
						<Button
							size="sm"
							variant="outline"
							onClick={handleRestart}
							disabled={busy !== null}
						>
							{busy === "restart" ? (
								<Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
							) : (
								<RotateCw className="w-3 h-3 mr-1.5" />
							)}
							{t("settings.desktopApplyConfigChanges")}
						</Button>
					)}
					<Button
						size="sm"
						variant="outline"
						onClick={refreshInfo}
						disabled={busy !== null}
					>
						<RefreshCcw className="w-3 h-3 mr-1.5" />
						{t("settings.desktopRefresh")}
					</Button>
				</div>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{t("settings.desktopTutorial")}
				</h3>
				<div className="text-xs text-muted-foreground">
					{t("settings.desktopResetOnboardingHint")}
				</div>
				<Button size="sm" variant="outline" onClick={handleResetOnboarding}>
					{t("settings.desktopResetOnboarding")}
				</Button>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
					{t("settings.desktopAbout")}
				</h3>
				<div className="space-y-1 text-xs">
					<InfoRow
						label={t("settings.desktopVersion")}
						value={info?.version ?? "—"}
					/>
					<InfoRow
						label={t("settings.desktopPlatform")}
						value={info?.platform ?? "—"}
					/>
					<InfoRow
						label={t("settings.desktopMode")}
						value={
							info
								? info.isDev
									? t("settings.desktopModeDev")
									: t("settings.desktopModeProd")
								: "—"
						}
					/>
				</div>
				<div className="flex items-start gap-1.5 pt-1 text-xs text-muted-foreground">
					<Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
					<span>
						{t("settings.desktopKeysNote", {
							path: info?.keysEnvPath ?? "~/.covel/keys.env",
						})}
					</span>
				</div>
			</section>
		</div>
	);
}

function InfoRow({
	label,
	value,
	mono,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="flex items-start gap-3">
			<span className="text-muted-foreground min-w-[80px]">{label}:</span>
			<span
				className={`flex-1 break-all ${mono ? "font-mono text-[11px]" : ""}`}
			>
				{value}
			</span>
		</div>
	);
}
