import type { SettingKey, SettingsBackendAdapter } from "../types.js";

export const LOCAL_STORAGE_SETTINGS_KEY = "covel:settings";
export const LOCAL_STORAGE_KEYS_KEY = "covel:keys";

interface StoredBundle {
	schemaVersion: number;
	savedAt: string;
	entries: Record<SettingKey, unknown>;
}

function readBundle(storage: Storage): StoredBundle {
	const raw = storage.getItem(LOCAL_STORAGE_SETTINGS_KEY);
	if (!raw) return { schemaVersion: 1, savedAt: "", entries: {} };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"entries" in parsed &&
			typeof (parsed as StoredBundle).entries === "object"
		) {
			return parsed as StoredBundle;
		}
		return { schemaVersion: 1, savedAt: "", entries: {} };
	} catch {
		return { schemaVersion: 1, savedAt: "", entries: {} };
	}
}

function readSecrets(storage: Storage): Record<string, string> {
	const raw = storage.getItem(LOCAL_STORAGE_KEYS_KEY);
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object") {
			const out: Record<string, string> = {};
			for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
				if (typeof v === "string") out[k] = v;
			}
			return out;
		}
		return {};
	} catch {
		return {};
	}
}

export function createLocalStorageBackend(
	storage: Storage = globalThis.localStorage,
): SettingsBackendAdapter {
	return {
		async load() {
			return readBundle(storage).entries;
		},
		async save(entries) {
			const bundle: StoredBundle = {
				schemaVersion: 1,
				savedAt: new Date().toISOString(),
				entries,
			};
			storage.setItem(LOCAL_STORAGE_SETTINGS_KEY, JSON.stringify(bundle));
		},
		async loadSecrets() {
			return readSecrets(storage);
		},
		async saveSecrets(keys) {
			storage.setItem(LOCAL_STORAGE_KEYS_KEY, JSON.stringify(keys));
		},
	};
}
