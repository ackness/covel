/**
 * One-shot cleanup for the legacy (pre-unified-store) localStorage keys.
 *
 * Run at boot; guarded by `covel:settings:cleaned-v1` so subsequent boots
 * are no-ops.
 */

const CLEANED_FLAG = "covel:settings:cleaned-v1";

const LEGACY_KEYS: readonly string[] = [
	"covel:locale",
	"covel:appearance",
	"covel:slotConfig",
	"covel:customPresets",
	"covel:paramOverrides",
	"covel:capabilityOverrides",
	"covel:runtimePriority",
	"covel:providerKeys",
	"covel:storageMode",
	"covel:onboarded",
	"covel:onboardedVersion",
];

const LEGACY_KEY_PREFIXES: readonly string[] = ["covel:runtimeBindings:"];

export function cleanupLegacyLocalStorage(): void {
	if (typeof localStorage === "undefined") return;
	try {
		if (localStorage.getItem(CLEANED_FLAG) === "1") return;
		for (const key of LEGACY_KEYS) localStorage.removeItem(key);
		const toDelete: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key) continue;
			if (LEGACY_KEY_PREFIXES.some((p) => key.startsWith(p))) {
				toDelete.push(key);
			}
		}
		for (const key of toDelete) localStorage.removeItem(key);
		localStorage.setItem(CLEANED_FLAG, "1");
	} catch {
		// localStorage unavailable (private mode, quota) — silently skip
	}
}
