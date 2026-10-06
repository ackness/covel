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
    await expect(mod.execute({}, ctx)).rejects.toMatchObject({
      name: "ToolValidationError",
      code: "VALIDATION_ERROR",
      details: [{ path: "city", message: expect.any(String) }],
    });
  });

  it("parses array and object arguments sent as JSON text", async () => {
    const mod = tool({
      name: "record",
      description: "Record changes",
      parameters: z.object({
        changes: z.array(z.object({ name: z.string() })),
        meta: z.object({ turn: z.number() }).optional(),
      }),
      execute: async (params) => params,
    });
    const ctx = { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" };

    expect(
      await mod.execute(
        { changes: '[{"name":"Mira"}]', meta: '{"turn":2}' },
        ctx,
      ),
    ).toEqual({ changes: [{ name: "Mira" }], meta: { turn: 2 } });
    // Parsed text is still validated, and other strings are not touched.
    await expect(
      mod.execute({ changes: '[{"name":7}]' }, ctx),
    ).rejects.toMatchObject({ details: [{ path: "changes.0.name" }] });
    await expect(mod.execute({ changes: "Mira" }, ctx)).rejects.toMatchObject({
      details: [{ path: "changes" }],
    });
  });

  it("leaves a pattern that needs the `u` flag out of the JSON schema", async () => {
    const mod = tool({
      name: "relate",
      description: "Relate two people",
      parameters: z.object({
        relation: z.string().regex(/^[\p{Letter}][\p{Letter}_]*$/u),
        people: z.array(
          z.object({ handle: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
        ),
      }),
      execute: async (params) => params,
    });
    // A provider that checks tool schemas refuses `\p{Letter}` in a pattern:
    // a JSON Schema pattern carries no flags.
    expect(mod.jsonSchema).toMatchObject({
      properties: {
        relation: { type: "string" },
        people: {
          items: {
            properties: { handle: { pattern: "^[a-z][a-z0-9-]*$" } },
          },
        },
      },
    });
    expect(
      (mod.jsonSchema.properties as Record<string, object>).relation,
    ).not.toHaveProperty("pattern");
    // The value is still checked.
    const ctx = { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" };
    await expect(
      mod.execute({ relation: "1st", people: [] }, ctx),
    ).rejects.toMatchObject({ details: [{ path: "relation" }] });
    expect(await mod.execute({ relation: "师徒", people: [] }, ctx)).toEqual({
      relation: "师徒",
      people: [],
    });
  });

  it("settles the closing brackets of JSON text", async () => {
    const mod = tool({
      name: "record",
      description: "Record changes",
      parameters: z.object({
        changes: z.array(z.object({ name: z.string() })),
      }),
      execute: async (params) => params,
    });
    const ctx = { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" };
    // The model closed the arguments object inside the text of the array,
    // closed an element once too often, or ended the text before the last
    // brackets.
    for (const text of [
      '[{"name":"Mira"}]}',
      '[{"name":"Mira"}]}\n',
      '[{"name":"Mira"}]}]',
      '[{"name":"Mira"}}]',
      '[{"name":"Mira"}',
      '[{"name":"Mira"',
    ])
      expect(await mod.execute({ changes: text }, ctx), text).toEqual({
        changes: [{ name: "Mira" }],
      });
    // Brackets are all it settles: other text after the value is an error,
    // and so is a value that is not finished.
    for (const text of [
      '[{"name":"Mira"}] and more',
      '[{"name":"Mira",',
      '[{"name":"Mi',
    ])
      await expect(
        mod.execute({ changes: text }, ctx),
        text,
      ).rejects.toMatchObject({ details: [{ path: "changes" }] });
  });

  it("escapes quote marks inside a string value of JSON text", async () => {
    const mod = tool({
      name: "record",
      description: "Record changes",
      parameters: z.object({
        changes: z.array(z.object({ name: z.string() })),
      }),
      execute: async (params) => params,
    });
    const ctx = { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" };
    // The model escaped the quotes of the JSON text, but not the quote marks
    // around a word inside it.
    expect(
      await mod.execute({ changes: '[{"name":"the "Mira" boat"}]}' }, ctx),
    ).toEqual({ changes: [{ name: 'the "Mira" boat' }] });
  });

  it("says why text sent for an array or object could not be used", async () => {
    const mod = tool({
      name: "record",
      description: "Record changes",
      parameters: z.object({
        changes: z.array(z.object({ name: z.string() })),
        meta: z.object({ turn: z.number() }).optional(),
      }),
      execute: async (params) => params,
    });
    const ctx = { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" };
    // A colon is missing. Told only "expected array, received string", a
    // model sends the same broken text again and again.
    const broken = await mod
      .execute({ changes: '[{"name" "Mira"}]' }, ctx)
      .catch((error: unknown) => error);
    expect(broken).toMatchObject({
      details: [
        {
          path: "changes",
          message: expect.stringMatching(
            /^Expected an array, but received text that is not valid JSON: .*position 9.* near `\[\{"name" "Mira"\}\]`\. Send the array itself as the value, not a string that contains it\.$/,
          ),
        },
      ],
    });
    await expect(
      mod.execute({ changes: [], meta: "[1]" }, ctx),
    ).rejects.toMatchObject({
      details: [
        {
          path: "meta",
          message:
            "Expected an object, but received text that holds another JSON type. Send the object itself as the value, not a string that contains it.",
        },
      ],
    });
    // A value of another type, or an ordinary sentence, keeps the schema's
    // own message: neither is an attempt at JSON text.
    for (const [changes, received] of [
      [7, "received number"],
      ["Mira joins the crew", "received string"],
    ] as const)
      await expect(mod.execute({ changes }, ctx)).rejects.toMatchObject({
        details: [
          { path: "changes", message: expect.stringContaining(received) },
        ],
      });
  });

  it("publishes the input schema and executes the parsed transform output", async () => {
    const mod = tool({
      name: "text-length",
      description: "Measure text",
      parameters: z.object({
        text: z.string().transform((text) => text.length),
      }),
      execute: async ({ text }) => ({ length: text }),
    });
    expect(mod.jsonSchema).toMatchObject({
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
    });
    expect(
      await mod.execute(
        { text: "abc" },
        { sessionId: "s", turnId: "t", pluginId: "p", runtimeId: "p" },
      ),
    ).toEqual({ length: 3 });
  });

  it("rejects unsupported parameters during registration with a tool-specific error", () => {
    expect(() =>
      tool({
        name: "bad-date",
        description: "Unsupported input",
        parameters: z.object({ at: z.date() }),
        execute: async (params) => params,
      }),
    ).toThrow(
      /Tool "bad-date" parameters cannot be represented as JSON Schema/,
    );
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
