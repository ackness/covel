import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, RotateCw, Upload } from "lucide-react";
import type { SettingsExportBundle } from "@covel/shared";
import { Button } from "@/components/ui/button.js";
import { useSettingsStore } from "./use-settings.js";

/**
 * Import / Export / Reset pane. Always visible, even when no entries exist
 * in the `data` group.
 */
export function DataPane() {
	const { t } = useTranslation();
	const store = useSettingsStore();
	const fileRef = useRef<HTMLInputElement>(null);
	const [includeSecrets, setIncludeSecrets] = useState(false);
	const [pending, setPending] = useState<{
		bundle: SettingsExportBundle;
		keys: Set<string>;
		includeSecrets: boolean;
	} | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	async function handleExport() {
		const bundle = await store.export({ includeSecrets });
		const blob = new Blob([JSON.stringify(bundle, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `covel-settings-${new Date().toISOString().slice(0, 10)}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		flash(t("settings.exported"));
	}

	async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (!file) return;
		const text = await file.text();
		try {
			const bundle = JSON.parse(text) as SettingsExportBundle;
			if (
				!bundle ||
				bundle.schemaVersion !== 1 ||
				typeof bundle.entries !== "object"
			) {
				throw new Error("bad bundle");
			}
			setPending({
				bundle,
				keys: new Set(Object.keys(bundle.entries)),
				includeSecrets: Boolean(bundle.keys),
			});
		} catch {
			flash(t("settings.importInvalid"));
		} finally {
			if (fileRef.current) fileRef.current.value = "";
		}
	}

	async function handleApplyImport() {
		if (!pending) return;
		await store.import(pending.bundle, {
			keys: [...pending.keys],
			includeSecrets: pending.includeSecrets,
		});
		setPending(null);
		flash(t("settings.imported"));
	}

	async function handleResetAll() {
		if (!confirm(t("settings.resetAllConfirm"))) return;
		await store.clearAll();
		flash(t("settings.reset"));
	}

	function flash(msg: string) {
		setToast(msg);
		setTimeout(() => setToast(null), 2500);
	}

	return (
		<div className="space-y-5">
			{toast && (
				<div className="text-xs px-3 py-2 rounded bg-primary/10 border border-primary/20 text-primary">
					{toast}
				</div>
			)}

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
					{t("settings.exportHeader")}
				</h3>
				<label className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={includeSecrets}
						onChange={(e) => setIncludeSecrets(e.target.checked)}
					/>
					{t("settings.exportIncludeKeys")}
				</label>
				<Button size="sm" variant="outline" onClick={handleExport}>
					<Download className="w-3 h-3 mr-1" />
					{t("settings.exportDownload")}
				</Button>
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
					{t("settings.importHeader")}
				</h3>
				<Button
					size="sm"
					variant="outline"
					onClick={() => fileRef.current?.click()}
				>
					<Upload className="w-3 h-3 mr-1" />
					{t("settings.importChoose")}
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept="application/json"
					className="hidden"
					onChange={handleFile}
				/>
				{pending && (
					<div className="border border-border rounded p-3 space-y-2 text-xs">
						<div className="font-medium">{t("settings.importPreview")}</div>
						<ul className="space-y-1 max-h-40 overflow-y-auto">
							{Object.entries(pending.bundle.entries).map(([key, value]) => (
								<li key={key} className="flex items-center gap-2">
									<input
										type="checkbox"
										checked={pending.keys.has(key)}
										onChange={(e) => {
											const next = new Set(pending.keys);
											if (e.target.checked) next.add(key);
											else next.delete(key);
											setPending({ ...pending, keys: next });
										}}
									/>
									<span className="font-mono truncate max-w-[180px]">
										{key}
									</span>
									<span className="text-muted-foreground truncate flex-1">
										= {JSON.stringify(value)}
									</span>
								</li>
							))}
						</ul>
						{pending.bundle.keys && (
							<label className="flex items-center gap-2">
								<input
									type="checkbox"
									checked={pending.includeSecrets}
									onChange={(e) =>
										setPending({ ...pending, includeSecrets: e.target.checked })
									}
								/>
								{t("settings.importKeysCount", {
									count: Object.keys(pending.bundle.keys).length,
								})}
							</label>
						)}
						<div className="flex gap-2">
							<Button
								size="sm"
								onClick={handleApplyImport}
								disabled={pending.keys.size === 0}
							>
								{t("settings.importApply", { count: pending.keys.size })}
							</Button>
							<Button
								size="sm"
								variant="outline"
								onClick={() => setPending(null)}
							>
								{t("common.cancel")}
							</Button>
						</div>
					</div>
				)}
			</section>

			<section className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
					{t("settings.resetHeader")}
				</h3>
				<Button size="sm" variant="outline" onClick={handleResetAll}>
					<RotateCw className="w-3 h-3 mr-1" />
					{t("settings.resetAll")}
				</Button>
			</section>
		</div>
	);
}
