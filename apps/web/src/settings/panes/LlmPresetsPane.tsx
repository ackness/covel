import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Eye, EyeOff, Plus, Trash2, Upload } from "lucide-react";
import {
	getCustomPresets,
	setCustomPresets,
	uid,
	type CustomPreset,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";

/**
 * Custom preset CRUD pane. Presets include free-form provider definitions the
 * user added through the UI, alongside their optional API key (persisted via
 * the settings secrets channel).
 */
export function LlmPresetsPane() {
	const { t } = useTranslation();
	const fileRef = useRef<HTMLInputElement>(null);

	const [presets, setPresetsLocal] = useState<CustomPreset[]>(() =>
		getCustomPresets(),
	);
	const [newPreset, setNewPreset] = useState<Omit<CustomPreset, "id">>({
		name: "",
		provider: "",
		baseUrl: "",
		model: "",
		protocol: "openai-chat-v1",
		apiKey: "",
	});
	const [visibleNew, setVisibleNew] = useState(false);

	const commit = (next: CustomPreset[]) => {
		setPresetsLocal(next);
		setCustomPresets(next);
	};

	const handleAdd = () => {
		if (!newPreset.name || !newPreset.provider || !newPreset.model) return;
		const preset: CustomPreset = { ...newPreset, id: `custom_${uid()}` };
		commit([...presets, preset]);
		setNewPreset({
			name: "",
			provider: "",
			baseUrl: "",
			model: "",
			protocol: "openai-chat-v1",
			apiKey: "",
		});
	};

	const handleRemove = (id: string) => {
		commit(presets.filter((p) => p.id !== id));
	};

	const handleExport = () => {
		const exportSafe = presets.map(({ apiKey: _apiKey, ...rest }) => rest);
		const blob = new Blob([JSON.stringify(exportSafe, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = "covel-custom-presets.json";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const imported = JSON.parse(reader.result as string);
				if (!Array.isArray(imported) || imported.length > 200) return;
				const valid = imported
					.filter(
						(p): p is Record<string, unknown> =>
							p != null &&
							typeof p === "object" &&
							typeof p.id === "string" &&
							p.id.length > 0 &&
							p.id.length <= 100 &&
							typeof p.name === "string" &&
							p.name.length > 0 &&
							typeof p.provider === "string" &&
							p.provider.length > 0 &&
							typeof p.model === "string" &&
							p.model.length > 0,
					)
					.map((p) => ({
						...p,
						id: (p.id as string).slice(0, 100),
						name: (p.name as string).slice(0, 100),
						provider: (p.provider as string).slice(0, 100),
						model: (p.model as string).slice(0, 200),
						baseUrl:
							typeof p.baseUrl === "string" &&
							(p.baseUrl.startsWith("http://") ||
								p.baseUrl.startsWith("https://"))
								? p.baseUrl.slice(0, 500)
								: "",
					})) as CustomPreset[];
				const existingIds = new Set(presets.map((p) => p.id));
				const deduped = valid.filter((p) => !existingIds.has(p.id));
				commit([...presets, ...deduped]);
			} catch {
				// ignore malformed
			}
		};
		reader.readAsText(file);
		if (fileRef.current) fileRef.current.value = "";
	};

	return (
		<div className="space-y-3">
			{presets.length > 0 && (
				<div className="space-y-2">
					{presets.map((preset) => (
						<div
							key={preset.id}
							className="border border-border px-3 py-2 text-xs space-y-1"
						>
							<div className="flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="font-medium">{preset.name}</span>
									{preset.apiKey && (
										<Badge variant="default" className="text-[10px]">
											{t("settings.hasApiKey")}
										</Badge>
									)}
								</div>
								<Button
									variant="ghost"
									size="icon-xs"
									onClick={() => handleRemove(preset.id)}
									aria-label="Remove"
								>
									<Trash2 className="w-3 h-3" />
								</Button>
							</div>
							<div className="text-muted-foreground flex flex-wrap gap-x-3">
								<span>
									{preset.provider}/{preset.model}
								</span>
								{preset.protocol && <span>{preset.protocol}</span>}
								{preset.baseUrl && (
									<span className="truncate max-w-[200px]">
										{preset.baseUrl}
									</span>
								)}
							</div>
						</div>
					))}
				</div>
			)}
			{presets.length === 0 && (
				<p className="text-xs text-muted-foreground text-center py-2">
					{t("settings.noCustomPresets")}
				</p>
			)}

			<div className="border border-dashed border-border p-3 space-y-2">
				<h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
					{t("settings.addPreset")}
				</h4>
				<div className="grid grid-cols-2 gap-2">
					<input
						placeholder={t("settings.namePlaceholder")}
						value={newPreset.name}
						onChange={(e) =>
							setNewPreset({ ...newPreset, name: e.target.value })
						}
						className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
					/>
					<input
						placeholder={t("settings.presetProviderPlaceholder")}
						value={newPreset.provider}
						onChange={(e) =>
							setNewPreset({ ...newPreset, provider: e.target.value })
						}
						className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
					/>
					<input
						placeholder={t("settings.presetModelPlaceholder")}
						value={newPreset.model}
						onChange={(e) =>
							setNewPreset({ ...newPreset, model: e.target.value })
						}
						className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
					/>
					<select
						value={newPreset.protocol ?? "openai-chat-v1"}
						onChange={(e) =>
							setNewPreset({ ...newPreset, protocol: e.target.value })
						}
						className="bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
					>
						<option value="openai-chat-v1">OpenAI Chat (v1)</option>
						<option value="openai-responses-v1">OpenAI Responses (v1)</option>
						<option value="anthropic-messages-v1">
							Anthropic Messages (v1)
						</option>
					</select>
					<input
						placeholder={t("settings.baseUrlPlaceholder")}
						value={newPreset.baseUrl}
						onChange={(e) =>
							setNewPreset({ ...newPreset, baseUrl: e.target.value })
						}
						className="col-span-2 bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary"
					/>
					<div className="col-span-2 flex gap-1">
						<input
							type={visibleNew ? "text" : "password"}
							placeholder="API Key (sk-...)"
							value={newPreset.apiKey ?? ""}
							onChange={(e) =>
								setNewPreset({ ...newPreset, apiKey: e.target.value })
							}
							className="flex-1 bg-background border border-border px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
						/>
						<Button
							variant="outline"
							size="icon"
							className="shrink-0 h-7 w-7"
							onClick={() => setVisibleNew((v) => !v)}
							aria-label={visibleNew ? "Hide" : "Show"}
						>
							{visibleNew ? (
								<EyeOff className="w-3 h-3" />
							) : (
								<Eye className="w-3 h-3" />
							)}
						</Button>
					</div>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={handleAdd}
					disabled={!newPreset.name || !newPreset.provider || !newPreset.model}
					className="w-full text-xs"
				>
					<Plus className="w-3 h-3" />
					{t("settings.add")}
				</Button>
			</div>

			<div className="flex gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={handleExport}
					className="flex-1 text-xs"
				>
					<Download className="w-3 h-3" />
					{t("settings.export")}
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => fileRef.current?.click()}
					className="flex-1 text-xs"
				>
					<Upload className="w-3 h-3" />
					{t("settings.import")}
				</Button>
				<input
					ref={fileRef}
					type="file"
					accept=".json"
					className="hidden"
					onChange={handleImport}
				/>
			</div>
		</div>
	);
}
