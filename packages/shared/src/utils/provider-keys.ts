const API_KEY_SUFFIX = "_API_KEY";
const API_KEY_ENV_RE = /^[A-Z0-9_]+_API_KEY$/;

function sanitizeProviderToken(input: string): string {
	return input
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/_+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase();
}

export function apiKeyEnvNameToProviderId(input: string): string | null {
	const upper = input.trim().toUpperCase();
	if (!API_KEY_ENV_RE.test(upper)) return null;
	const provider = upper
		.slice(0, -API_KEY_SUFFIX.length)
		.toLowerCase()
		.replace(/_+/g, "-");
	return provider || null;
}

export function providerKeyToId(input: string): string | null {
	const fromEnv = apiKeyEnvNameToProviderId(input);
	if (fromEnv) return fromEnv;
	const sanitized = sanitizeProviderToken(input);
	return sanitized || null;
}

export function providerIdToApiKeyEnvName(input: string): string | null {
	const providerId = providerKeyToId(input);
	if (!providerId) return null;
	return `${providerId.toUpperCase().replace(/-/g, "_")}${API_KEY_SUFFIX}`;
}

export function normalizeProviderKeyMap(
	input: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [rawKey, rawValue] of Object.entries(input)) {
		if (typeof rawValue !== "string") continue;
		const providerId = providerKeyToId(rawKey);
		const value = rawValue.trim();
		if (!providerId || !value) continue;
		out[providerId] = value;
	}
	return out;
}

export function toApiKeyEnvMap(
	input: Record<string, string>,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [rawKey, rawValue] of Object.entries(input)) {
		if (typeof rawValue !== "string") continue;
		const envKey = providerIdToApiKeyEnvName(rawKey);
		const value = rawValue.trim();
		if (!envKey || !value) continue;
		out[envKey] = value;
	}
	return out;
}
