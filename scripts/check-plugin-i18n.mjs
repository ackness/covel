#!/usr/bin/env node
/**
 * check-plugin-i18n — enforce the I18nText contract for plugin UI JSON.
 *
 * Every user-visible string in `plugins/**\/ui/*.json` (and sibling ui-only
 * locations like `plugins/**\/runtimes/**\/ui/*.json`) must either:
 *   - be a plain string that contains no CJK characters (treated as an id,
 *     icon name, path, or pre-translated English label), or
 *   - be an object with at least one English locale key (`en` / `en-US`) —
 *     this is how plugin specs declare I18nText per docs/reference/ui-panels.md.
 *
 * A bare Chinese string (`"title": "世界维度"`) is rejected because the
 * framework's `resolveI18n` cannot pick a locale from a single-language
 * string. Use `{ "zh": "世界维度", "en": "World Dimensions" }` instead.
 *
 * Exit code: 0 = OK, 1 = violations found.
 */
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { glob } from "node:fs/promises";

const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..");

const PLUGIN_GLOB = "plugins/**/ui/*.json";
// Allow the author to exempt a specific path by prefix if a false positive
// ever appears. Keep empty by default.
const EXEMPT_PREFIXES = [];

function isEnglishLocaleKey(key) {
	return key === "en" || key === "en-US" || key === "en-GB";
}

function isLocaleObject(obj) {
	if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
	const keys = Object.keys(obj);
	if (keys.length === 0) return false;
	// Heuristic: every value is a string, and at least one key matches a known
	// locale pattern. We intentionally accept arbitrary extra locales (fr, ja)
	// so long as the English locale is present.
	const allStrings = keys.every((k) => typeof obj[k] === "string");
	if (!allStrings) return false;
	return keys.some(isEnglishLocaleKey);
}

/**
 * Walk a JSON value, calling `onViolation({path, value})` for any bare CJK
 * string that is NOT part of a valid I18nText object.
 */
function walkValue(value, pathStack, onViolation) {
	if (value == null) return;
	if (typeof value === "string") {
		if (CJK_REGEX.test(value)) {
			onViolation({ path: pathStack.slice(), value });
		}
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((v, i) => {
			pathStack.push(`[${i}]`);
			walkValue(v, pathStack, onViolation);
			pathStack.pop();
		});
		return;
	}
	if (typeof value === "object") {
		if (isLocaleObject(value)) {
			// All string values inside a locale-tagged I18nText object are legal —
			// stop recursion, they are already paired with an English sibling.
			return;
		}
		for (const [k, v] of Object.entries(value)) {
			pathStack.push(k);
			walkValue(v, pathStack, onViolation);
			pathStack.pop();
		}
		return;
	}
}

async function main() {
	const files = [];
	for await (const file of glob(PLUGIN_GLOB, { cwd: REPO_ROOT })) {
		files.push(file);
	}
	files.sort();

	let totalViolations = 0;
	for (const rel of files) {
		if (EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue;
		const full = resolve(REPO_ROOT, rel);
		const text = readFileSync(full, "utf8");
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch (err) {
			// eslint-disable-next-line no-console
			console.error(`${rel}: failed to parse JSON — ${err.message}`);
			totalViolations += 1;
			continue;
		}

		const violations = [];
		walkValue(parsed, [], (v) => violations.push(v));

		for (const v of violations) {
			totalViolations += 1;
			const pathStr = v.path.length > 0 ? v.path.join(".") : "(root)";
			// eslint-disable-next-line no-console
			console.error(
				`${rel}: "${pathStr}" contains CJK string "${v.value.slice(0, 80)}" — wrap it in an I18nText object { "zh": "…", "en": "…" }`,
			);
		}
	}

	if (totalViolations > 0) {
		// eslint-disable-next-line no-console
		console.error(
			`\ncheck-plugin-i18n: ${totalViolations} violation(s) across ${files.length} plugin UI file(s)`,
		);
		process.exit(1);
	}
	// eslint-disable-next-line no-console
	console.log(
		`check-plugin-i18n: OK (${files.length} plugin UI file(s) scanned)`,
	);
}

main().catch((err) => {
	// eslint-disable-next-line no-console
	console.error("check-plugin-i18n crashed:", err);
	process.exit(2);
});
