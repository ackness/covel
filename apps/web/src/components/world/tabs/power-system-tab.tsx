import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Label } from "@/components/ui/label.js";
import {
	text,
	inputCls,
	textareaCls,
	selectCls,
	type TabProps,
} from "../editor-helpers.js";
import type {
	WorldPowerSystem,
	PowerSystemType,
	PowerTier,
} from "@covel/shared";

const POWER_TYPES: PowerSystemType[] = [
	"magic",
	"technology",
	"cultivation",
	"psychic",
	"hybrid",
	"other",
];

export function PowerSystemTab({ dimensions, onChange, t }: TabProps) {
	const ps: WorldPowerSystem = dimensions.powerSystem ?? {
		name: "",
		type: "magic",
		description: "",
		rules: [],
	};

	function setPs(next: WorldPowerSystem) {
		onChange({ ...dimensions, powerSystem: next });
	}

	function addRule() {
		setPs({ ...ps, rules: [...ps.rules, ""] });
	}

	function removeRule(index: number) {
		setPs({ ...ps, rules: ps.rules.filter((_, i) => i !== index) });
	}

	function updateRule(index: number, value: string) {
		setPs({ ...ps, rules: ps.rules.map((r, i) => (i === index ? value : r)) });
	}

	function addTier() {
		const tiers: PowerTier[] = [
			...(ps.tiers ?? []),
			{ name: "", rank: (ps.tiers?.length ?? 0) + 1 },
		];
		setPs({ ...ps, tiers });
	}

	function removeTier(index: number) {
		setPs({ ...ps, tiers: (ps.tiers ?? []).filter((_, i) => i !== index) });
	}

	function updateTier(index: number, patch: Partial<PowerTier>) {
		const tiers = (ps.tiers ?? []).map((tier, i) =>
			i === index ? { ...tier, ...patch } : tier,
		);
		setPs({ ...ps, tiers });
	}

	return (
		<div className="space-y-6">
			<div className="grid grid-cols-2 gap-3">
				<div className="space-y-1">
					<Label>{t("world.name")}</Label>
					<input
						className={inputCls}
						value={text(ps.name)}
						onChange={(e) => setPs({ ...ps, name: e.target.value })}
					/>
				</div>
				<div className="space-y-1">
					<Label>{t("world.powerType")}</Label>
					<select
						className={selectCls}
						value={ps.type}
						onChange={(e) =>
							setPs({ ...ps, type: e.target.value as PowerSystemType })
						}
					>
						{POWER_TYPES.map((pt) => (
							<option key={pt} value={pt}>
								{t(`world.powerType${pt[0].toUpperCase()}${pt.slice(1)}`)}
							</option>
						))}
					</select>
				</div>
			</div>

			<div className="space-y-1">
				<Label>{t("world.description")}</Label>
				<textarea
					className={textareaCls}
					value={text(ps.description)}
					onChange={(e) => setPs({ ...ps, description: e.target.value })}
				/>
			</div>

			{/* Rules */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>{t("world.rules")}</Label>
					<Button variant="outline" size="sm" onClick={addRule}>
						<Plus className="mr-1 h-4 w-4" />
						{t("world.addRule")}
					</Button>
				</div>
				{ps.rules.map((rule, ri) => (
					<div key={ri} className="flex items-center gap-2">
						<input
							className={inputCls}
							value={text(rule)}
							onChange={(e) => updateRule(ri, e.target.value)}
						/>
						<Button variant="ghost" size="icon" onClick={() => removeRule(ri)}>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				))}
			</div>

			{/* Tiers */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label>{t("world.tiers")}</Label>
					<Button variant="outline" size="sm" onClick={addTier}>
						<Plus className="mr-1 h-4 w-4" />
						{t("world.addTier")}
					</Button>
				</div>
				{(ps.tiers ?? []).map((tier, ti) => (
					<div key={ti} className="flex items-center gap-2">
						<input
							className={inputCls}
							placeholder={t("world.name")}
							value={text(tier.name)}
							onChange={(e) => updateTier(ti, { name: e.target.value })}
						/>
						<input
							className="w-24 border border-border bg-background px-3 py-2 text-sm"
							type="number"
							placeholder={t("world.rank")}
							value={tier.rank}
							onChange={(e) =>
								updateTier(ti, { rank: Number(e.target.value) || 0 })
							}
						/>
						<Button variant="ghost" size="icon" onClick={() => removeTier(ti)}>
							<Trash2 className="h-4 w-4" />
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}
