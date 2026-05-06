import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Info } from "lucide-react";
import {
	getParamOverrides,
	setParamOverrides,
	type ModelParameterOverrides,
} from "@/services/api.js";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import { useSession } from "@/stores/session-store.js";

const LEGACY_SLOTS = [
	"story",
	"plugin",
	"memory",
	"image",
	"fast",
	"balance",
	"default",
];

export function LlmAdvancedPane() {
	const { t } = useTranslation();
	const { state } = useSession();
	const isConfigured = state.llmConfig?.configured ?? false;
	const configuredSlots = isConfigured
		? Object.keys(state.llmConfig!.slots)
		: [];
	const slots = isConfigured ? configuredSlots : LEGACY_SLOTS;

	const [paramOverrides, setParamOverridesLocal] = useState<
		Record<string, ModelParameterOverrides>
	>(() => getParamOverrides());
	const [selectedSlot, setSelectedSlot] = useState<string>(
		slots[0] ?? "default",
	);

	const current = paramOverrides[selectedSlot] ?? {};

	const commit = (next: Record<string, ModelParameterOverrides>) => {
		setParamOverridesLocal(next);
		setParamOverrides(next);
	};

	const setField = (
		field: keyof ModelParameterOverrides,
		value: number | undefined,
	) => {
		commit({
			...paramOverrides,
			[selectedSlot]: { ...current, [field]: value },
		});
	};

	const resetSlot = () => {
		const next = { ...paramOverrides };
		delete next[selectedSlot];
		commit(next);
	};

	return (
		<div className="space-y-3">
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<Info className="w-3 h-3" />
				<span>{t("settings.advancedDesc")}</span>
			</div>
			<div className="space-y-1.5">
				<Label className="text-xs">{t("settings.selectSlot")}</Label>
				<select
					value={selectedSlot}
					onChange={(e) => setSelectedSlot(e.target.value)}
					className="w-full bg-background border border-border px-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary"
				>
					{slots.map((slot) => (
						<option key={slot} value={slot}>
							{slot}
						</option>
					))}
				</select>
			</div>

			<SliderField
				label="Temperature"
				value={current.temperature}
				onChange={(v) => setField("temperature", v)}
				min={0}
				max={2}
				step={0.1}
			/>
			<SliderField
				label="Top P"
				value={current.topP}
				onChange={(v) => setField("topP", v)}
				min={0}
				max={1}
				step={0.05}
			/>
			<div className="space-y-1.5">
				<Label className="text-xs">Max Output Tokens</Label>
				<input
					type="number"
					placeholder="e.g. 4096"
					value={current.maxOutputTokens ?? ""}
					onChange={(e) => {
						const val = e.target.value
							? parseInt(e.target.value, 10)
							: undefined;
						setField("maxOutputTokens", val);
					}}
					className="w-full bg-background border border-border px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary font-mono"
				/>
			</div>
			<SliderField
				label="Frequency Penalty"
				value={current.frequencyPenalty}
				onChange={(v) => setField("frequencyPenalty", v)}
				min={-2}
				max={2}
				step={0.1}
			/>
			<SliderField
				label="Presence Penalty"
				value={current.presencePenalty}
				onChange={(v) => setField("presencePenalty", v)}
				min={-2}
				max={2}
				step={0.1}
			/>

			<Button
				variant="outline"
				size="sm"
				onClick={resetSlot}
				className="w-full text-xs uppercase tracking-widest"
			>
				Reset to defaults
			</Button>
		</div>
	);
}

function SliderField({
	label,
	value,
	onChange,
	min,
	max,
	step,
}: {
	label: string;
	value: number | undefined;
	onChange: (v: number | undefined) => void;
	min: number;
	max: number;
	step: number;
}) {
	const displayValue = value ?? "";
	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		const raw = e.target.value;
		if (raw === "") {
			onChange(undefined);
			return;
		}
		const num = parseFloat(raw);
		if (!isNaN(num)) onChange(Math.min(max, Math.max(min, num)));
	};
	return (
		<div className="space-y-1.5">
			<div className="flex items-center justify-between">
				<Label className="text-xs">{label}</Label>
				<span className="text-xs text-muted-foreground font-mono w-12 text-right">
					{value !== undefined
						? value.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0)
						: "--"}
				</span>
			</div>
			<div className="flex items-center gap-2">
				<input
					type="range"
					min={min}
					max={max}
					step={step}
					value={value ?? (min + max) / 2}
					onChange={(e) => onChange(parseFloat(e.target.value))}
					className="flex-1 h-1.5 appearance-none bg-muted rounded-full cursor-pointer accent-primary [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
				/>
				<input
					type="number"
					min={min}
					max={max}
					step={step}
					value={displayValue}
					onChange={handleInputChange}
					placeholder="--"
					className="w-16 bg-background border border-border px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-primary font-mono text-center"
				/>
			</div>
		</div>
	);
}
