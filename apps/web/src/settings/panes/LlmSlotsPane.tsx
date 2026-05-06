import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Database, Info, Loader2, Pencil, RotateCw } from "lucide-react";
import {
	fetchModelDbInfo,
	getCapabilityOverrides,
	getCustomPresets,
	getSlotConfig,
	mergeCapability,
	refreshModelDb,
	setCapabilityOverrides,
	setSlotConfig,
	type InputModality,
	type ModelCapabilityInfo,
	type ModelDbInfo,
	type ModelFeature,
	type OutputModality,
	type SlotConfigEntry,
} from "@/services/api.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { useSession } from "@/stores/session-store.js";

/**
 * Pane that surfaces the `[covel.<slot>]` sections from llm.toml and lets the
 * user override each slot's preset and capability metadata. Legacy (non-
 * configured) environments fall back to a fixed slot list.
 */
export function LlmSlotsPane() {
	const { t } = useTranslation();
	const { state } = useSession();
	const llm = state.llmConfig;
	const isConfigured = llm?.configured ?? false;

	const LEGACY_SLOTS = [
		"story",
		"plugin",
		"memory",
		"image",
		"fast",
		"balance",
		"default",
	];

	const [slotConfig, setSlotConfigLocal] = useState<
		Record<string, SlotConfigEntry>
	>(() => getSlotConfig());
	const [capOverrides, setCapOverridesLocal] = useState<
		Record<string, Partial<ModelCapabilityInfo>>
	>(() => getCapabilityOverrides());
	const [editingSlot, setEditingSlot] = useState<string | null>(null);
	const [modelDbInfo, setModelDbInfo] = useState<ModelDbInfo | null>(null);
	const [refreshing, setRefreshing] = useState(false);

	useEffect(() => {
		fetchModelDbInfo()
			.then(setModelDbInfo)
			.catch(() => {});
	}, []);

	const customPresets = getCustomPresets();
	const allPresets = [
		...state.presets.map((p) => ({
			id: p.id,
			name: p.name,
			provider: p.provider,
			model: p.model,
			isCustom: false,
		})),
		...customPresets.map((p) => ({
			id: p.id,
			name: p.name,
			provider: p.provider,
			model: p.model,
			isCustom: true,
		})),
	];

	const configuredSlots = isConfigured ? Object.keys(llm!.slots) : [];
	const discoveredSlotIds = useMemo(
		() => discoverRuntimeSlotIds(state.packages),
		[state.packages],
	);
	const slots = useMemo(() => {
		const out: string[] = [];
		const add = (slotId: string | undefined) => {
			if (!slotId || slotId === "default" || out.includes(slotId)) return;
			out.push(slotId);
		};
		if (isConfigured) {
			configuredSlots.forEach(add);
		} else {
			LEGACY_SLOTS.forEach(add);
		}
		discoveredSlotIds.forEach(add);
		return out;
	}, [isConfigured, configuredSlots.join("\n"), discoveredSlotIds.join("\n")]);

	const commitSlot = (next: Record<string, SlotConfigEntry>) => {
		setSlotConfigLocal(next);
		setSlotConfig(next);
	};

	const autoBindDiscoveredSlots = () => {
		const next = { ...slotConfig };
		for (const slotId of discoveredSlotIds) {
			if (slotId === "default" || next[slotId]?.presetId) continue;
			const byName = allPresets.find(
				(p) => p.id === `slot-${slotId}` || p.id === slotId,
			);
			const byProvider = allPresets.find((p) => p.provider === slotId);
			const candidate = byName ?? byProvider;
			if (candidate) next[slotId] = { presetId: candidate.id };
		}
		commitSlot(next);
	};

	const updateCapOverride = (
		slotId: string,
		patch: Partial<ModelCapabilityInfo>,
	) => {
		const next = {
			...capOverrides,
			[slotId]: { ...capOverrides[slotId], ...patch },
		};
		setCapOverridesLocal(next);
		setCapabilityOverrides(next);
	};

	const resetCapOverride = (slotId: string) => {
		const next = { ...capOverrides };
		delete next[slotId];
		setCapOverridesLocal(next);
		setCapabilityOverrides(next);
	};

	const getEffectiveCapability = (
		slotId: string,
	): ModelCapabilityInfo | undefined => {
		const serverCap = isConfigured ? llm!.slots[slotId]?.capability : undefined;
		return mergeCapability(serverCap, capOverrides[slotId]);
	};

	const handleRefreshModelDb = async () => {
		setRefreshing(true);
		try {
			const result = await refreshModelDb();
			if (result.ok) {
				setModelDbInfo({
					available: true,
					count: result.count,
					updatedAt: new Date().toISOString(),
				});
			}
		} catch {
			// silent
		} finally {
			setRefreshing(false);
		}
	};

	return (
		<div className="space-y-3">
			{/* Relationship summary — explains how slots fit into the bigger picture.
          O-4 audit finding: players were seeing "slot / preset / key" as three
          disconnected tabs without any indication that they form a chain. */}
			<div className="border border-border/60 bg-muted/20 px-3 py-2 space-y-1.5">
				<p className="text-[11px] text-muted-foreground leading-relaxed">
					{t(
						"settings.slotChainSummary",
						"Plugins → Slots → Presets → API keys. Change a preset to swap models; manage keys in the Keys tab.",
					)}
				</p>
				<div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground/80 flex-wrap">
					<span className="px-1.5 py-0.5 rounded bg-background border border-border">
						{t("settings.chainRuntime", "Runtime")}
					</span>
					<span className="text-muted-foreground/50">▸</span>
					<span className="px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/30">
						{t("settings.chainSlot", "Slot")}
					</span>
					<span className="text-muted-foreground/50">▸</span>
					<span className="px-1.5 py-0.5 rounded bg-background border border-border">
						{t("settings.chainPreset", "Preset")}
					</span>
					<span className="text-muted-foreground/50">▸</span>
					<span className="px-1.5 py-0.5 rounded bg-background border border-border">
						{t("settings.chainKey", "API key")}
					</span>
				</div>
			</div>
			{isConfigured && (
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<Info className="w-3 h-3" />
					<span>{t("settings.configuredByToml")}</span>
				</div>
			)}
			<div className="flex items-center gap-2 text-[10px] text-muted-foreground italic">
				<Info className="w-3 h-3 shrink-0" />
				<span>{t("settings.slotPingMovedHint")}</span>
			</div>
			{discoveredSlotIds.length > 0 && (
				<div className="border border-border/70 bg-muted/20 px-3 py-2 space-y-2">
					<div className="flex items-center justify-between gap-2">
						<div className="space-y-1">
							<div className="text-xs font-medium">
								{t(
									"settings.runtimeSlotsDiscovered",
									"Runtime-requested slots",
								)}
							</div>
							<p className="text-[11px] text-muted-foreground leading-relaxed">
								{t(
									"settings.runtimeSlotsDiscoveredHint",
									"These slot names were discovered from active plugin runtimes and image-provider settings. Add or bind presets here so plugins can resolve them.",
								)}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							className="text-[11px] shrink-0"
							onClick={autoBindDiscoveredSlots}
						>
							{t("settings.autoBindSlots", "Auto-bind")}
						</Button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{discoveredSlotIds.map((slotId) => (
							<Badge
								key={slotId}
								variant={slotConfig[slotId]?.presetId ? "default" : "outline"}
								className="text-[10px]"
							>
								{slotId}
								{slotConfig[slotId]?.presetId ? " ✓" : ""}
							</Badge>
						))}
					</div>
				</div>
			)}
			{slots.map((slotId) => {
				const selectedPresetId = slotConfig[slotId]?.presetId ?? "";
				const selectedPreset = allPresets.find(
					(p) => p.id === selectedPresetId,
				);
				const serverSlot = isConfigured ? llm!.slots[slotId] : null;
				const effectiveProvider =
					selectedPreset?.provider ?? serverSlot?.provider ?? "";
				const effectiveModel = selectedPreset?.model ?? serverSlot?.model ?? "";
				const effectiveProtocol = serverSlot?.protocol ?? "";
				const isRequired = !isConfigured && slotId === "default";
				const isFirst = isConfigured && slotId === configuredSlots[0];
				const isDiscovered = discoveredSlotIds.includes(slotId);
				const isVirtualSlot = isDiscovered && !serverSlot;
				const effectiveCap = isConfigured
					? getEffectiveCapability(slotId)
					: null;
				const hasCapOverride = isConfigured && !!capOverrides[slotId];
				const isEditing = editingSlot === slotId;

				return (
					<div key={slotId} className="border border-border p-3 space-y-2">
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">{slotId}</span>
							<div className="flex items-center gap-1">
								{isRequired && (
									<Badge variant="default" className="text-[10px]">
										required
									</Badge>
								)}
								{isFirst && (
									<Badge variant="default" className="text-[10px]">
										default
									</Badge>
								)}
								{isDiscovered && (
									<Badge variant="secondary" className="text-[10px]">
										runtime
									</Badge>
								)}
								{isVirtualSlot && (
									<Badge
										variant="outline"
										className="text-[10px] text-amber-600 border-amber-400"
									>
										frontend overlay
									</Badge>
								)}
								{serverSlot?.fallback && (
									<Badge variant="secondary" className="text-[10px]">
										fallback: {serverSlot.fallback}
									</Badge>
								)}
								{selectedPreset && (
									<Badge
										variant="outline"
										className="text-[10px] text-amber-600 border-amber-400"
									>
										{t("settings.overrideApplied")}
									</Badge>
								)}
							</div>
						</div>

						<select
							value={selectedPresetId}
							onChange={(e) => {
								const val = e.target.value;
								if (val) {
									commitSlot({ ...slotConfig, [slotId]: { presetId: val } });
								} else {
									const updated = { ...slotConfig };
									delete updated[slotId];
									commitSlot(updated);
								}
							}}
							className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
						>
							<option value="">
								--{" "}
								{serverSlot
									? "Use base slot config"
									: isDiscovered
										? t("settings.selectPreset", "Select preset")
										: isRequired
											? t("settings.selectPreset")
											: t("settings.noPresetFallback")}{" "}
								--
							</option>
							{state.presets.length > 0 && (
								<optgroup label="Built-in">
									{state.presets.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name} ({p.provider}/{p.model})
										</option>
									))}
								</optgroup>
							)}
							{customPresets.length > 0 && (
								<optgroup label="Custom">
									{customPresets.map((p) => (
										<option key={p.id} value={p.id}>
											{p.name} ({p.provider}/{p.model})
										</option>
									))}
								</optgroup>
							)}
						</select>

						<div className="text-xs text-muted-foreground grid grid-cols-3 gap-1">
							<span>Provider: {effectiveProvider || "—"}</span>
							<span>Model: {effectiveModel || "—"}</span>
							<span>
								{selectedPreset
									? selectedPreset.isCustom
										? "Preset: custom"
										: "Preset: override"
									: `Protocol: ${(effectiveProtocol || "").replace("-v1", "") || "—"}`}
							</span>
						</div>

						{isConfigured && effectiveCap && (
							<CapabilityTags capability={effectiveCap} />
						)}

						{isConfigured && (
							<div className="flex items-center gap-1.5">
								<Button
									variant="ghost"
									size="sm"
									className="h-6 text-[10px] px-1.5"
									onClick={() => setEditingSlot(isEditing ? null : slotId)}
								>
									<Pencil className="w-3 h-3 mr-0.5" />
									{isEditing
										? t("settings.collapseCapability")
										: t("settings.editCapability")}
								</Button>
								{hasCapOverride && (
									<Button
										variant="ghost"
										size="sm"
										className="h-6 text-[10px] px-1.5 text-amber-600"
										onClick={() => resetCapOverride(slotId)}
									>
										<RotateCw className="w-3 h-3 mr-0.5" />
										{t("settings.resetOverride")}
									</Button>
								)}
							</div>
						)}

						{isConfigured && isEditing && (
							<CapabilityEditor
								serverCap={serverSlot?.capability}
								override={capOverrides[slotId]}
								onUpdate={(patch) => updateCapOverride(slotId, patch)}
							/>
						)}
					</div>
				);
			})}

			{isConfigured && (
				<div className="border border-dashed border-border p-3 space-y-2 mt-2">
					<div className="flex items-center justify-between">
						<h4 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-1.5">
							<Database className="w-3 h-3" />
							{t("settings.modelDatabase")}
						</h4>
						<Button
							variant="outline"
							size="sm"
							className="h-6 text-[10px] px-2"
							disabled={refreshing}
							onClick={handleRefreshModelDb}
						>
							{refreshing ? (
								<Loader2 className="w-3 h-3 animate-spin mr-1" />
							) : (
								<RotateCw className="w-3 h-3 mr-1" />
							)}
							{t("settings.updateFromGitHub")}
						</Button>
					</div>
					{modelDbInfo?.available ? (
						<div className="text-[10px] text-muted-foreground space-y-0.5">
							<div>
								{t("settings.modelCount", { count: modelDbInfo.count })}
							</div>
							<div>
								{t("settings.updatedAt", {
									date: modelDbInfo.updatedAt
										? new Date(modelDbInfo.updatedAt).toLocaleDateString()
										: "?",
								})}
							</div>
						</div>
					) : (
						<div className="text-[10px] text-muted-foreground">
							{t("settings.dbUnavailable")}
						</div>
					)}
				</div>
			)}
		</div>
	);
}

// ── Capability helpers (ported from old dialog) ───────────────────

const ALL_INPUT_MODALITY_IDS: InputModality[] = [
	"text",
	"image",
	"audio",
	"video",
	"file",
];
const ALL_OUTPUT_MODALITY_IDS: OutputModality[] = [
	"text",
	"image",
	"audio",
	"embedding",
];
const ALL_FEATURE_IDS: ModelFeature[] = [
	"function_calling",
	"structured_output",
	"streaming",
	"reasoning",
	"vision",
	"prompt_caching",
	"web_search",
	"computer_use",
];

const MODALITY_COLORS: Record<string, string> = {
	"in:image": "bg-violet-500/15 text-violet-600",
	"in:audio": "bg-amber-500/15 text-amber-600",
	"in:video": "bg-rose-500/15 text-rose-600",
	"in:file": "bg-slate-500/15 text-slate-600",
	"out:image": "bg-violet-500/15 text-violet-600",
	"out:audio": "bg-amber-500/15 text-amber-600",
	"out:embedding": "bg-teal-500/15 text-teal-600",
};

const MODALITY_LABEL_KEYS: Record<string, string> = {
	"in:image": "settings.modalInImage",
	"in:audio": "settings.modalInAudio",
	"in:video": "settings.modalInVideo",
	"in:file": "settings.modalInFile",
	"out:image": "settings.modalOutImage",
	"out:audio": "settings.modalOutAudio",
	"out:embedding": "settings.modalOutEmbedding",
};

const FEATURE_LABEL_KEYS: Record<string, string> = {
	function_calling: "settings.featFunctionCalling",
	structured_output: "settings.featStructuredOutput",
	streaming: "settings.featStreaming",
	reasoning: "settings.featReasoning",
	vision: "settings.featVision",
	prompt_caching: "settings.featPromptCaching",
	web_search: "settings.featWebSearch",
	computer_use: "settings.featComputerUse",
};

function formatTokenCount(n: number): string {
	if (n >= 1_000_000)
		return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
	return String(n);
}

function formatPrice(perMToken: number): string {
	if (perMToken < 0.01) return `$${perMToken.toFixed(3)}/M`;
	if (perMToken < 1) return `$${perMToken.toFixed(2)}/M`;
	return `$${perMToken.toFixed(1)}/M`;
}

function CapabilityTags({
	capability: cap,
}: {
	capability: ModelCapabilityInfo;
}) {
	const { t } = useTranslation();
	const inputTags = cap.input
		.filter((m) => m !== "text")
		.map((m) => ({
			key: `in:${m}`,
			label: MODALITY_LABEL_KEYS[`in:${m}`]
				? t(MODALITY_LABEL_KEYS[`in:${m}`])
				: m,
			color: MODALITY_COLORS[`in:${m}`],
		}))
		.filter((tag) => tag.color);
	const outputTags = cap.output
		.filter((m) => m !== "text")
		.map((m) => ({
			key: `out:${m}`,
			label: MODALITY_LABEL_KEYS[`out:${m}`]
				? t(MODALITY_LABEL_KEYS[`out:${m}`])
				: m,
			color: MODALITY_COLORS[`out:${m}`],
		}))
		.filter((tag) => tag.color);
	const featureTags = (cap.features ?? [])
		.filter((f) => f !== "streaming")
		.map((f) => ({
			key: f,
			label: FEATURE_LABEL_KEYS[f] ? t(FEATURE_LABEL_KEYS[f]) : f,
		}));
	const hasLimits = cap.contextWindow || cap.maxOutputTokens;
	const hasPricing =
		cap.pricing && (cap.pricing.inputPerMToken || cap.pricing.perImage);
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap gap-1">
				{inputTags.map((x) => (
					<span
						key={x.key}
						className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${x.color}`}
					>
						{x.label}
					</span>
				))}
				{outputTags.map((x) => (
					<span
						key={x.key}
						className={`inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded ${x.color}`}
					>
						{x.label}
					</span>
				))}
				{featureTags.map((x) => (
					<span
						key={x.key}
						className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium rounded bg-muted text-muted-foreground"
					>
						{x.label}
					</span>
				))}
			</div>
			{(hasLimits || hasPricing) && (
				<div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground font-mono">
					{cap.contextWindow ? (
						<span title="Context Window">
							ctx: {formatTokenCount(cap.contextWindow)}
						</span>
					) : null}
					{cap.maxOutputTokens ? (
						<span title="Max Output Tokens">
							out: {formatTokenCount(cap.maxOutputTokens)}
						</span>
					) : null}
					{cap.pricing?.inputPerMToken != null &&
					cap.pricing?.outputPerMToken != null ? (
						<span title="Pricing (input/output per M tokens)">
							{formatPrice(cap.pricing.inputPerMToken)} /{" "}
							{formatPrice(cap.pricing.outputPerMToken)}
						</span>
					) : cap.pricing?.perImage != null ? (
						<span title="Price per image">${cap.pricing.perImage}/img</span>
					) : null}
				</div>
			)}
		</div>
	);
}

function CapabilityEditor({
	serverCap,
	override,
	onUpdate,
}: {
	serverCap: ModelCapabilityInfo | undefined;
	override: Partial<ModelCapabilityInfo> | undefined;
	onUpdate: (patch: Partial<ModelCapabilityInfo>) => void;
}) {
	const { t } = useTranslation();
	const effective = mergeCapability(serverCap, override);
	const currentInput = override?.input ?? serverCap?.input ?? ["text"];
	const currentOutput = override?.output ?? serverCap?.output ?? ["text"];
	const currentFeatures = override?.features ?? serverCap?.features ?? [];
	const toggle = <T extends string>(
		list: T[],
		item: T,
		field: "input" | "output" | "features",
	) => {
		const next = list.includes(item)
			? list.filter((m) => m !== item)
			: [...list, item];
		onUpdate({ [field]: next } as Partial<ModelCapabilityInfo>);
	};
	return (
		<div className="space-y-3 pt-1 border-t border-dashed border-border mt-2">
			<div className="space-y-1">
				<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
					{t("settings.inputModalities")}
				</Label>
				<div className="flex flex-wrap gap-1">
					{ALL_INPUT_MODALITY_IDS.map((id) => {
						const active = currentInput.includes(id);
						return (
							<button
								key={id}
								onClick={() =>
									toggle(currentInput as InputModality[], id, "input")
								}
								className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
									active
										? "bg-primary/15 text-primary border-primary/30"
										: "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
								}`}
							>
								{t(MODALITY_LABEL_KEYS[`in:${id}`] ?? `in:${id}`, {
									defaultValue: id,
								})}
							</button>
						);
					})}
				</div>
			</div>
			<div className="space-y-1">
				<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
					{t("settings.outputModalities")}
				</Label>
				<div className="flex flex-wrap gap-1">
					{ALL_OUTPUT_MODALITY_IDS.map((id) => {
						const active = currentOutput.includes(id);
						return (
							<button
								key={id}
								onClick={() =>
									toggle(currentOutput as OutputModality[], id, "output")
								}
								className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
									active
										? "bg-primary/15 text-primary border-primary/30"
										: "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
								}`}
							>
								{t(MODALITY_LABEL_KEYS[`out:${id}`] ?? `out:${id}`, {
									defaultValue: id,
								})}
							</button>
						);
					})}
				</div>
			</div>
			<div className="space-y-1">
				<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
					{t("settings.featureTags")}
				</Label>
				<div className="flex flex-wrap gap-1">
					{ALL_FEATURE_IDS.map((id) => {
						const active = currentFeatures.includes(id);
						return (
							<button
								key={id}
								onClick={() =>
									toggle(currentFeatures as ModelFeature[], id, "features")
								}
								className={`px-2 py-0.5 text-[10px] rounded border transition-colors ${
									active
										? "bg-primary/15 text-primary border-primary/30"
										: "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
								}`}
							>
								{t(FEATURE_LABEL_KEYS[id] ?? id, { defaultValue: id })}
							</button>
						);
					})}
				</div>
			</div>
			<div className="grid grid-cols-2 gap-2">
				<div className="space-y-1">
					<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
						Context Window (tokens)
					</Label>
					<input
						type="number"
						placeholder={effective?.contextWindow?.toString() ?? "e.g. 131072"}
						value={override?.contextWindow ?? ""}
						onChange={(e) =>
							onUpdate({
								contextWindow: e.target.value
									? parseInt(e.target.value, 10)
									: undefined,
							})
						}
						className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
						Max Output Tokens
					</Label>
					<input
						type="number"
						placeholder={effective?.maxOutputTokens?.toString() ?? "e.g. 8192"}
						value={override?.maxOutputTokens ?? ""}
						onChange={(e) =>
							onUpdate({
								maxOutputTokens: e.target.value
									? parseInt(e.target.value, 10)
									: undefined,
							})
						}
						className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
					/>
				</div>
			</div>
			<div className="space-y-1">
				<Label className="text-[10px] uppercase tracking-widest text-muted-foreground">
					{t("settings.pricing")}
				</Label>
				<div className="grid grid-cols-2 gap-2">
					<div className="flex items-center gap-1">
						<span className="text-[10px] text-muted-foreground w-8 shrink-0">
							{t("settings.pricingInput")}:
						</span>
						<input
							type="number"
							step="0.01"
							placeholder={
								effective?.pricing?.inputPerMToken?.toString() ?? "$/M"
							}
							value={override?.pricing?.inputPerMToken ?? ""}
							onChange={(e) =>
								onUpdate({
									pricing: {
										...override?.pricing,
										inputPerMToken: e.target.value
											? parseFloat(e.target.value)
											: undefined,
									},
								})
							}
							className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
						/>
					</div>
					<div className="flex items-center gap-1">
						<span className="text-[10px] text-muted-foreground w-8 shrink-0">
							{t("settings.pricingOutput")}:
						</span>
						<input
							type="number"
							step="0.01"
							placeholder={
								effective?.pricing?.outputPerMToken?.toString() ?? "$/M"
							}
							value={override?.pricing?.outputPerMToken ?? ""}
							onChange={(e) =>
								onUpdate({
									pricing: {
										...override?.pricing,
										outputPerMToken: e.target.value
											? parseFloat(e.target.value)
											: undefined,
									},
								})
							}
							className="w-full bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono"
						/>
					</div>
				</div>
			</div>
		</div>
	);
}

function discoverRuntimeSlotIds(
	packages: readonly {
		runtimes?: readonly {
			kind: string;
			model?: string;
			providerTag?: string;
		}[];
		userSettings?: readonly { key: string; default: unknown }[];
	}[],
): string[] {
	const out = new Set<string>();
	for (const pkg of packages) {
		for (const rt of pkg.runtimes ?? []) {
			if (rt.kind === "function") continue;
			const slot = rt.model ?? rt.providerTag;
			if (
				typeof slot === "string" &&
				slot.length > 0 &&
				slot !== "default" &&
				slot !== "text"
			) {
				out.add(slot);
			}
		}
		for (const setting of pkg.userSettings ?? []) {
			if (setting.key !== "modelPresetId") continue;
			if (
				typeof setting.default === "string" &&
				setting.default.length > 0 &&
				setting.default !== "default"
			) {
				out.add(setting.default);
			}
		}
	}
	return [...out].sort((a, b) => a.localeCompare(b));
}
