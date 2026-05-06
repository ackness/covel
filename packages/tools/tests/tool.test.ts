import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "../src/tool.js";

describe("tool()", () => {
	const weatherTool = () =>
		tool({
			name: "get-weather",
			description: "Get current weather for a city",
			parameters: z.object({
				city: z.string().describe("City name"),
			}),
			execute: async ({ city }) => ({ temp: 22, city }),
		});

	it("creates a ToolModule with _type covel-tool", () => {
		const mod = weatherTool();
		expect(mod._type).toBe("covel-tool");
	});

	it("preserves name and description", () => {
		const mod = weatherTool();
		expect(mod.name).toBe("get-weather");
		expect(mod.description).toBe("Get current weather for a city");
	});

	it("generates JSON Schema from Zod schema", () => {
		const mod = weatherTool();
		const schema = mod.jsonSchema as Record<string, unknown>;
		expect(schema.type).toBe("object");
		expect(schema).toHaveProperty("properties");
		const props = schema.properties as Record<string, unknown>;
		expect(props).toHaveProperty("city");
	});

	it("execute works with valid params", async () => {
		const mod = weatherTool();
		const ctx = {
			sessionId: "s1",
			turnId: "t1",
			pluginId: "p1",
			runtimeId: "r1",
		};
		const result = await mod.execute({ city: "Tokyo" }, ctx);
		expect(result).toEqual({ temp: 22, city: "Tokyo" });
	});

	it("validates parameters and throws on invalid input", async () => {
		const mod = weatherTool();
		const ctx = {
			sessionId: "s1",
			turnId: "t1",
			pluginId: "p1",
			runtimeId: "r1",
		};
		// Missing required field 'city'
		await expect(mod.execute({} as never, ctx)).rejects.toThrow();
	});

	it("handles complex schema with optional, enum, and nested fields", () => {
		const complexTool = tool({
			name: "complex",
			description: "A complex tool",
			parameters: z.object({
				query: z.string(),
				limit: z.number().optional(),
				category: z.enum(["news", "sports", "tech"]),
				filters: z.object({
					startDate: z.string(),
					endDate: z.string().optional(),
				}),
			}),
			execute: async (params) => params,
		});

		const schema = complexTool.jsonSchema as Record<string, unknown>;
		expect(schema.type).toBe("object");
		const props = schema.properties as Record<string, unknown>;
		expect(props).toHaveProperty("query");
		expect(props).toHaveProperty("limit");
		expect(props).toHaveProperty("category");
		expect(props).toHaveProperty("filters");

		// Required should include query, category, filters but not limit
		const required = schema.required as string[];
		expect(required).toContain("query");
		expect(required).toContain("category");
		expect(required).toContain("filters");
		expect(required).not.toContain("limit");
	});
});
