import { describe, expect, it } from "vitest";

import {
	apiKeyEnvNameToProviderId,
	normalizeProviderKeyMap,
	providerIdToApiKeyEnvName,
	providerKeyToId,
	toApiKeyEnvMap,
} from "../src/utils/provider-keys.js";

describe("provider key mapping", () => {
	it("maps provider ids to api key env names", () => {
		expect(providerIdToApiKeyEnvName("deepseek")).toBe("DEEPSEEK_API_KEY");
		expect(providerIdToApiKeyEnvName("my-provider")).toBe(
			"MY_PROVIDER_API_KEY",
		);
	});

	it("maps api key env names back to provider ids", () => {
		expect(apiKeyEnvNameToProviderId("DEEPSEEK_API_KEY")).toBe("deepseek");
		expect(apiKeyEnvNameToProviderId("MY_PROVIDER_API_KEY")).toBe(
			"my-provider",
		);
	});

	it("normalizes legacy bare keys and canonical env keys into one provider map", () => {
		expect(
			normalizeProviderKeyMap({
				deepseek: "legacy-value",
				DEEPSEEK_API_KEY: "canonical-value",
				my_provider: "custom-value",
			}),
		).toEqual({
			deepseek: "canonical-value",
			"my-provider": "custom-value",
		});
	});

	it("serializes mixed provider keys into env-only output", () => {
		expect(
			toApiKeyEnvMap({
				deepseek: "a",
				DEEPSEEK_API_KEY: "b",
				"my-provider": "c",
			}),
		).toEqual({
			DEEPSEEK_API_KEY: "b",
			MY_PROVIDER_API_KEY: "c",
		});
	});

	it("derives canonical provider ids from either shape", () => {
		expect(providerKeyToId("deepseek")).toBe("deepseek");
		expect(providerKeyToId("DEEPSEEK_API_KEY")).toBe("deepseek");
		expect(providerKeyToId("my_provider")).toBe("my-provider");
	});
});
