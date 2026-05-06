import { beforeEach, describe, expect, it } from "vitest";
import { createLocalStorageBackend } from "../../src/settings/backends/localstorage.js";

function makeFakeStorage(): Storage {
	const map = new Map<string, string>();
	return {
		get length() {
			return map.size;
		},
		clear() {
			map.clear();
		},
		getItem(k: string) {
			return map.get(k) ?? null;
		},
		key(i: number) {
			return [...map.keys()][i] ?? null;
		},
		removeItem(k: string) {
			map.delete(k);
		},
		setItem(k: string, v: string) {
			map.set(k, v);
		},
	} as Storage;
}

describe("LocalStorageBackend", () => {
	let storage: Storage;
	beforeEach(() => {
		storage = makeFakeStorage();
	});

	it("round-trips entries", async () => {
		const be = createLocalStorageBackend(storage);
		expect(await be.load()).toEqual({});
		await be.save({
			"ui.locale": "en-US",
			"llm.slotConfig": { default: {} },
		});
		expect(await be.load()).toEqual({
			"ui.locale": "en-US",
			"llm.slotConfig": { default: {} },
		});
	});

	it("round-trips secrets separately from entries", async () => {
		const be = createLocalStorageBackend(storage);
		await be.save({ "ui.locale": "en-US" });
		await be.saveSecrets({ openai: "sk-x" });
		expect(await be.load()).toEqual({ "ui.locale": "en-US" });
		expect(await be.loadSecrets()).toEqual({ openai: "sk-x" });
	});

	it("returns empty object on corrupt JSON", async () => {
		storage.setItem("covel:settings", "not-json");
		const be = createLocalStorageBackend(storage);
		expect(await be.load()).toEqual({});
	});

	it("ignores non-string secret values", async () => {
		storage.setItem(
			"covel:keys",
			JSON.stringify({ openai: "sk-x", bogus: 42 }),
		);
		const be = createLocalStorageBackend(storage);
		expect(await be.loadSecrets()).toEqual({ openai: "sk-x" });
	});
});
