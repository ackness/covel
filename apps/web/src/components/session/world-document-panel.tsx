/**
 * WorldDocumentPanel — renders the current world's WORLD.md (lore field) as
 * Markdown in the right-panel "World" tab. Falls back to description when
 * lore is empty.
 */

import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import i18n from "@/i18n/index.js";
import type { I18nText } from "@covel/shared";
import type { WorldRecord } from "@/services/api.js";
import { Markdown } from "@/components/ui/markdown.js";

function resolveText(v: I18nText | undefined): string {
	if (!v) return "";
	if (typeof v === "string") return v;
	const lang = i18n.language;
	if (lang) {
		const r = v as Record<string, string>;
		if (r[lang]) return r[lang];
		const prefix = lang.split("-")[0];
		const fallback = Object.keys(r).find((k) => k.startsWith(prefix));
		if (fallback) return r[fallback];
	}
	return Object.values(v)[0] ?? "";
}

export interface WorldDocumentPanelProps {
	world: WorldRecord | null;
}

export function WorldDocumentPanel({ world }: WorldDocumentPanelProps) {
	const { t } = useTranslation();

	if (!world) {
		return (
			<div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
				{t("session.worldDocumentEmpty", "No world loaded")}
			</div>
		);
	}

	const lore = resolveText(world.lore);
	const description = resolveText(world.description);
	const body = lore || description;

	if (!body) {
		return (
			<div className="flex items-center justify-center h-20 text-muted-foreground text-xs">
				{t("session.worldDocumentEmpty", "No world document")}
			</div>
		);
	}

	return (
		<article className="prose prose-sm dark:prose-invert max-w-none text-[12px] leading-relaxed">
			<Markdown>{body}</Markdown>
		</article>
	);
}
