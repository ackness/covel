import type { ThemeDefinition } from "./types.js";

const STYLE_PREFIX = "covel-theme-style-";

function themeStyleId(themeId: string): string {
	return `${STYLE_PREFIX}${themeId}`;
}

function mountThemeStyle(theme: ThemeDefinition): void {
	if (typeof document === "undefined") return;
	const id = themeStyleId(theme.id);
	const existing = document.getElementById(id);
	if (existing instanceof HTMLStyleElement) {
		if (existing.textContent !== theme.cssText)
			existing.textContent = theme.cssText;
		return;
	}

	const style = document.createElement("style");
	style.id = id;
	style.setAttribute("data-theme-style", theme.id);
	style.textContent = theme.cssText;
	document.head.appendChild(style);
}

export function syncThemeStyles(themes: readonly ThemeDefinition[]): void {
	if (typeof document === "undefined") return;

	const nextIds = new Set(themes.map((theme) => theme.id));

	for (const theme of themes) {
		mountThemeStyle(theme);
	}

	for (const style of document.querySelectorAll<HTMLStyleElement>(
		"style[data-theme-style]",
	)) {
		const themeId = style.getAttribute("data-theme-style");
		if (!themeId || nextIds.has(themeId)) continue;
		style.remove();
	}
}
