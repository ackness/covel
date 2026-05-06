import i18n from "@/i18n/index.js";
import type { WorldDimensions } from "@covel/shared";

type I18nText = string | Record<string, string>;

export function text(v: I18nText | undefined, locale?: string): string {
	if (!v) return "";
	if (typeof v === "string") return v;
	const lang = locale ?? i18n.language;
	if (lang) {
		if (v[lang]) return v[lang];
		// Try language prefix match: zh-CN → zh
		const prefix = lang.split("-")[0];
		const fallback = Object.keys(v).find((k) => k.startsWith(prefix));
		if (fallback) return v[fallback];
	}
	return Object.values(v)[0] ?? "";
}

/** Shared input class names */
export const inputCls =
	"w-full border border-border bg-background px-3 py-2 text-sm";
export const textareaCls =
	"w-full border border-border bg-background px-3 py-2 text-sm min-h-[80px] resize-y";
export const selectCls = "border border-border bg-background px-3 py-2 text-sm";

export type DimensionsState = WorldDimensions;

export interface TabProps {
	dimensions: DimensionsState;
	onChange: (next: DimensionsState) => void;
	t: (key: string) => string;
}
