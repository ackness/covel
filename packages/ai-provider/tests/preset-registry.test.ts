import { describe, it, expect } from "vitest";
import { createPresetRegistry } from "../src/preset-registry.js";
import type { ModelProfile, PresetConfig } from "../src/types.js";

const profiles: ModelProfile[] = [
	{
		id: "medium",
		tier: "medium",
		provider: "deepseek",
		model: "deepseek-chat",
		contextWindow: 64000,
		latencyClass: "medium",
		costClass: "low",
		supportedModes: ["text", "object", "stream"],
	},
	{
		id: "small",
		tier: "small",
		provider: "dashscope",
		model: "qwen-turbo",
		contextWindow: 32000,
		latencyClass: "low",
		costClass: "low",
		supportedModes: ["text", "stream"],
	},
	{
		id: "embed-default",
		tier: "embed-default",
		provider: "dashscope",
		model: "text-embedding-v3",
		contextWindow: 8191,
		latencyClass: "low",
		costClass: "low",
		supportedModes: ["embed"],
	},
];

const presets: PresetConfig[] = [
	{
		id: "default",
		name: "DeepSeek Chat",
		provider: "deepseek",
		model: "deepseek-chat",
		tier: "medium",
		supportedModes: ["text", "object", "stream"],
		enabled: true,
		isDefault: true,
		fallbackPresetIds: ["fallback"],
	},
	{
		id: "fallback",
		name: "DashScope Qwen",
		provider: "dashscope",
		model: "qwen-plus",
		tier: "medium",
		supportedModes: ["text", "object", "stream"],
		enabled: true,
	},
	{
		id: "disabled",
		name: "Disabled",
		provider: "test",
		model: "m",
		tier: "small",
		supportedModes: ["text"],
		enabled: false,
	},
];

describe("preset-registry", () => {
	const registry = createPresetRegistry({ profiles, presets });

	it("lists all profiles", () => {
		expect(registry.listProfiles()).toHaveLength(3);
	});

	it("lists all presets", () => {
		expect(registry.listPresets()).toHaveLength(3);
	});

	it("resolves default preset when no ID given", () => {
		const target = registry.resolveTextTarget({});
		expect(target.preset?.id).toBe("default");
		expect(target.profile.tier).toBe("medium");
	});

	it("resolves specific preset by ID", () => {
		const target = registry.resolveTextTarget({ presetId: "fallback" });
		expect(target.preset?.id).toBe("fallback");
		expect(target.preset?.provider).toBe("dashscope");
	});

	it("throws on unknown preset", () => {
		expect(() => registry.resolveTextTarget({ presetId: "nope" })).toThrow(
			"not found",
		);
	});

	it("throws on disabled preset", () => {
		expect(() => registry.resolveTextTarget({ presetId: "disabled" })).toThrow(
			"disabled",
		);
	});

	it("resolves embedding target", () => {
		const target = registry.resolveEmbeddingTarget();
		expect(target.profile.tier).toBe("embed-default");
		expect(target.preset).toBeNull();
	});

	it("builds fallback chain", () => {
		const chain = registry.resolveTextTargetChain({});
		expect(chain).toHaveLength(2);
		expect(chain[0].preset?.id).toBe("default");
		expect(chain[1].preset?.id).toBe("fallback");
	});

	it("avoids circular fallback", () => {
		const circularPresets: PresetConfig[] = [
			{
				id: "a",
				name: "A",
				provider: "p",
				model: "m",
				tier: "medium",
				supportedModes: ["text"],
				enabled: true,
				isDefault: true,
				fallbackPresetIds: ["b"],
			},
			{
				id: "b",
				name: "B",
				provider: "p",
				model: "m",
				tier: "medium",
				supportedModes: ["text"],
				enabled: true,
				fallbackPresetIds: ["a"],
			},
		];
		const r = createPresetRegistry({ profiles, presets: circularPresets });
		const chain = r.resolveTextTargetChain({});
		expect(chain).toHaveLength(2);
	});
});
