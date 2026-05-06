import { describe, expect, it } from "vitest";
import {
	worldDataDescriptorSchema,
	worldManifestSchema,
} from "../src/index.js";

describe("world data schemas", () => {
	it("allows world.yaml to point at a world data descriptor", () => {
		const result = worldManifestSchema.safeParse({
			schemaVersion: "1",
			id: "haruka-academy",
			name: "Haruka Academy",
			summary: "A school world",
			defaultLocale: "zh-CN",
			worldData: "data/world.data.yaml",
		});
		expect(result.success).toBe(true);
	});

	it("validates a minimal v1 descriptor", () => {
		const result = worldDataDescriptorSchema.safeParse({
			schemaVersion: 1,
			sources: {
				dimensions: {
					kind: "yaml",
					path: "data/dimensions.yaml",
					schema: "covel://world/dimensions",
					to: "world:metadata.dimensions",
				},
				cast: {
					kind: "json",
					path: "data/characters/cast.json",
					to: "plugin:character-blueprint/blueprints",
					key: "id",
					after: "dimensions",
					effects: ["characters"],
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects numeric-like source ids", () => {
		const result = worldDataDescriptorSchema.safeParse({
			schemaVersion: 1,
			sources: {
				"1": {
					kind: "yaml",
					path: "data/foo.yaml",
					to: "world:metadata.foo",
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown source fields", () => {
		const result = worldDataDescriptorSchema.safeParse({
			schemaVersion: 1,
			sources: {
				foo: {
					kind: "yaml",
					path: "data/foo.yaml",
					to: "world:metadata.foo",
					query: "select * from foo",
				},
			},
		});
		expect(result.success).toBe(false);
	});
});
