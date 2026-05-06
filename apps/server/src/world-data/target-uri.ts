export type ParsedWorldDataTarget =
	| { readonly kind: "world-metadata"; readonly path: readonly string[] }
	| {
			readonly kind: "plugin-data";
			readonly pluginId: string;
			readonly namespace: string;
			readonly lorebook: boolean;
	  }
	| { readonly kind: "lorebook" }
	| { readonly kind: "characters" }
	| { readonly kind: "media" };

const PLUGIN_ID_RE = /^[a-z][a-z0-9-]*$/;
const NAMESPACE_RE = /^[a-z][a-zA-Z0-9_-]{0,63}$/;
const METADATA_PATH_RE = /^[a-zA-Z0-9_.-]+$/;
const FORBIDDEN_METADATA_SEGMENTS = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

export function parseWorldDataTarget(
	value: string,
): ParsedWorldDataTarget | null {
	if (value === "lorebook") return { kind: "lorebook" };
	if (value === "characters") return { kind: "characters" };
	if (value === "media") return { kind: "media" };

	if (value.startsWith("world:metadata.")) {
		const rawPath = value.slice("world:metadata.".length);
		if (!METADATA_PATH_RE.test(rawPath)) return null;
		const segments = rawPath.split(".").filter((segment) => segment.length > 0);
		if (segments.length === 0) return null;
		if (segments.some((segment) => FORBIDDEN_METADATA_SEGMENTS.has(segment))) {
			return null;
		}
		if (segments.length === 1 && segments[0] === "characterBlueprints") {
			return null;
		}
		return { kind: "world-metadata", path: segments };
	}

	if (value.startsWith("plugin:")) {
		let rest = value.slice("plugin:".length);
		let lorebook = false;
		if (rest.endsWith("+lorebook")) {
			lorebook = true;
			rest = rest.slice(0, -"+lorebook".length);
		}
		const slash = rest.lastIndexOf("/");
		if (slash <= 0 || slash === rest.length - 1) return null;
		const pluginId = rest.slice(0, slash);
		const namespace = rest.slice(slash + 1);
		if (!PLUGIN_ID_RE.test(pluginId) || !NAMESPACE_RE.test(namespace)) {
			return null;
		}
		return { kind: "plugin-data", pluginId, namespace, lorebook };
	}

	return null;
}

export function parseWorldDataIndexTarget(
	value: string,
): Extract<ParsedWorldDataTarget, { kind: "plugin-data" }> | null {
	const parsed = parseWorldDataTarget(value);
	if (!parsed || parsed.kind !== "plugin-data" || parsed.lorebook) return null;
	return parsed;
}
