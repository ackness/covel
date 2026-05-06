import { describe, it, expect } from "vitest";
import { getPluginTrustInfo, BUILTIN_PLUGIN_IDS } from "../src/trust.js";

describe("getPluginTrustInfo", () => {
	describe("source-based classification", () => {
		it("classifies a plugin loaded from `plugins/` as builtin (autoLoad, no approval)", () => {
			// The bootstrap layer passes `source: 'builtin'` based on the load
			// path; the trust resolver does not infer trust from the name.
			const info = getPluginTrustInfo("narrator", "builtin");

			expect(info.source).toBe("builtin");
			expect(info.autoLoad).toBe(true);
			expect(info.requiresApproval).toBe(false);
		});

		it("classifies an explicit official plugin as autoLoad with no approval", () => {
			const info = getPluginTrustInfo("some-official-plugin", "official");

			expect(info.source).toBe("official");
			expect(info.autoLoad).toBe(true);
			expect(info.requiresApproval).toBe(false);
		});
	});

	describe("community fallback", () => {
		it("classifies unknown plugins (no source override) as community requiring approval", () => {
			const info = getPluginTrustInfo("my-custom-plugin");

			expect(info.source).toBe("community");
			expect(info.autoLoad).toBe(false);
			expect(info.requiresApproval).toBe(true);
		});

		it("treats a name matching a builtin ID as community when no source is provided", () => {
			// Names alone never grant builtin trust — only the load path does.
			// This guards against a third-party plugin claiming `narrator` and
			// being auto-trusted via name-only inference.
			const info = getPluginTrustInfo("narrator");

			expect(info.source).toBe("community");
			expect(info.autoLoad).toBe(false);
			expect(info.requiresApproval).toBe(true);
		});
	});

	describe("BUILTIN_PLUGIN_IDS reservation list", () => {
		it("contains the IDs of every plugin shipped under plugins/", () => {
			// If you add or remove a plugin under plugins/, update BUILTIN_PLUGIN_IDS
			// in trust.ts so install.ts rejects third-party shadowing.
			expect(BUILTIN_PLUGIN_IDS.has("narrator")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("pregame")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("memory")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("codex")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("guide")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("char-creator")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("world-init")).toBe(true);
			expect(BUILTIN_PLUGIN_IDS.has("npc-graph")).toBe(true);
		});
	});
});
