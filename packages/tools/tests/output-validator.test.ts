import { describe, it, expect } from "vitest";
import {
	validateOutput,
	selectOutputStrategy,
	generateSchemaPrompt,
} from "../src/output-validator.js";

describe("validateOutput", () => {
	it("should return valid for output matching schema", () => {
		const schema = {
			type: "object",
			properties: {
				title: { type: "string" },
			},
			required: ["title"],
		};
		const output = { title: "Hello" };

		const result = validateOutput(output, schema);

		expect(result).toEqual({ valid: true });
	});

	it("should return invalid when required field is missing", () => {
		const schema = {
			type: "object",
			properties: {
				title: { type: "string" },
			},
			required: ["title"],
		};
		const output = {};

		const result = validateOutput(output, schema);

		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
	});

	it("should return invalid when type is wrong", () => {
		const schema = {
			type: "object",
			properties: {
				count: { type: "number" },
			},
			required: ["count"],
		};
		const output = { count: "not-a-number" };

		const result = validateOutput(output, schema);

		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
	});

	it("should validate complex nested schema correctly", () => {
		const schema = {
			type: "object",
			properties: {
				user: {
					type: "object",
					properties: {
						name: { type: "string" },
						age: { type: "number" },
					},
					required: ["name", "age"],
				},
			},
			required: ["user"],
		};

		const validOutput = { user: { name: "Alice", age: 30 } };
		expect(validateOutput(validOutput, schema)).toEqual({ valid: true });

		const invalidOutput = { user: { name: "Alice" } };
		const result = validateOutput(invalidOutput, schema);
		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
	});

	it("should accept any object for empty object schema", () => {
		const schema = { type: "object" };
		const output = { anything: "goes", nested: { value: 42 } };

		const result = validateOutput(output, schema);

		expect(result).toEqual({ valid: true });
	});

	it("should return invalid for null output", () => {
		const schema = { type: "object" };

		const result = validateOutput(null, schema);

		expect(result.valid).toBe(false);
		expect(result.errors).toBeDefined();
		expect(result.errors!.length).toBeGreaterThan(0);
	});
});

describe("selectOutputStrategy", () => {
	it("should return native when supported", () => {
		expect(selectOutputStrategy(true)).toBe("native");
	});

	it("should return prompt when not supported", () => {
		expect(selectOutputStrategy(false)).toBe("prompt");
	});
});

describe("generateSchemaPrompt", () => {
	it("should generate prompt containing JSON and stringified schema", () => {
		const schema = {
			type: "object",
			properties: {
				title: { type: "string" },
			},
		};

		const prompt = generateSchemaPrompt(schema);

		expect(prompt).toContain("JSON");
		expect(prompt).toContain(JSON.stringify(schema, null, 2));
	});

	it("should include instruction text about valid JSON output", () => {
		const schema = { type: "object" };

		const prompt = generateSchemaPrompt(schema);

		expect(prompt).toMatch(/must|MUST/i);
		expect(prompt).toMatch(/valid JSON/i);
	});

	it("should include all property names for complex schema", () => {
		const schema = {
			type: "object",
			properties: {
				title: { type: "string" },
				description: { type: "string" },
				priority: { type: "number" },
			},
		};

		const prompt = generateSchemaPrompt(schema);

		expect(prompt).toContain("title");
		expect(prompt).toContain("description");
		expect(prompt).toContain("priority");
	});
});
