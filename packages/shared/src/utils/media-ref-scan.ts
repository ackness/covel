import { mediaRefSchema } from "../types/media.js";

/**
 * Deep-scan arbitrary JSON-like values for MediaRef-shaped objects.
 *
 * Used by snapshot/fork, media lifecycle cleanup, and legacy trace adapters.
 * The scanner accepts readonly records/arrays and stops descending once a
 * complete MediaRef is found, so nested metadata inside the ref does not
 * produce duplicate ids.
 */
export function collectMediaRefIds(
	value: unknown,
	out = new Set<string>(),
): Set<string> {
	if (!value || typeof value !== "object") return out;

	const parsed = mediaRefSchema.safeParse(value);
	if (parsed.success) {
		out.add(parsed.data.id);
		return out;
	}

	if (Array.isArray(value)) {
		for (const item of value) collectMediaRefIds(item, out);
		return out;
	}

	for (const item of Object.values(value as Record<string, unknown>)) {
		collectMediaRefIds(item, out);
	}
	return out;
}
