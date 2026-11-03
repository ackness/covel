import { getModelView, ToolError } from "@covel/plugin-handlers-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEmitEventTool,
  canDescribeEventPayload,
  createEmitEventTool,
} from "../src/builtin/emit-event.js";
import { getEmittedEvents, getPendingProposals } from "../src/result.js";
import type { ToolExecutionContext } from "../src/types.js";
import { validateOutput } from "../src/output-validator.js";

afterEach(() => vi.restoreAllMocks());

const ctx: ToolExecutionContext = {
  sessionId: "s1",
  turnId: "t1",
  pluginId: "narrator",
  runtimeId: "narrator",
  random: { int: (min: number) => min },
};

interface FakeTopicEntry {
  readonly topic: string;
  readonly requires?: string;
  /** advertise:false internal topics are omitted from listTopics (the emit gate). */
  readonly advertised?: boolean;
}

function makeDirectory(entries: readonly FakeTopicEntry[]) {
  return {
    listTopics: vi.fn(async (_sessionId: string) =>
      entries
        .filter((entry) => entry.advertised !== false)
        .map((entry) => entry.topic),
    ),
    validate: vi.fn(
      async (
        _sessionId: string,
        topic: string,
        data: Record<string, unknown>,
      ) => {
        const hit = entries.find(
          (entry) => entry.topic === topic && entry.advertised !== false,
        );
        if (!hit)
          return { ok: false as const, reason: `unknown topic "${topic}"` };
        if (hit.requires && !(hit.requires in data)) {
          return {
            ok: false as const,
            reason: `missing field ${hit.requires}`,
          };
        }
        return { ok: true as const };
      },
    ),
  };
}

describe("emit-event tool", () => {
  it("emits a valid event through the emitted-events channel", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = await tool.execute(
      { topic: "scene.set", data: { location: "教室" } },
      ctx,
    );
    expect(getEmittedEvents(result)).toEqual([
      { topic: "scene.set", data: { location: "教室" } },
    ]);
  });

  it("fails the call and lists known topics for an undeclared topic", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const error = await tool
      .execute({ topic: "quest.done", data: {} }, ctx)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "refused" });
    expect((error as Error).message).toContain('unknown topic "quest.done"');
    expect((error as Error).message).toContain("scene.set");
  });

  it("rejects an advertise:false internal topic without leaking its name", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([
        { topic: "scene.set" },
        { topic: "quest.done", advertised: false },
      ]),
    });
    const error = (await tool
      .execute({ topic: "quest.done", data: {} }, ctx)
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "refused" });
    expect(error.message).toContain('unknown topic "quest.done"');
    expect(error.message).toContain("scene.set");
    // The internal topic must not be echoed back in the available-topics hint.
    expect(error.message).not.toContain("Available topics: quest.done");
  });

  it("fails the call with the schema validation error so the LLM can retry", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set", requires: "location" }]),
    });
    await expect(
      tool.execute({ topic: "scene.set", data: {} }, ctx),
    ).rejects.toMatchObject({
      code: "invalid-input",
      message: expect.stringContaining("missing field location"),
    });
  });

  it("never returns event.emit pending proposals (double-emission guard)", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = await tool.execute({ topic: "scene.set", data: {} }, ctx);
    expect(getPendingProposals(result)).toHaveLength(0);
  });

  it("no-ops with a hint when the topic was already emitted this turn", async () => {
    const tool = createEmitEventTool({
      directory: makeDirectory([{ topic: "scene.set" }]),
    });
    const result = (await tool.execute(
      { topic: "scene.set", data: {} },
      { ...ctx, emittedEventTopics: ["scene.set"] },
    )) as { _text: string };
    expect(getEmittedEvents(result)).toBeUndefined();
    expect(getModelView(result)?.summary).toContain("already emitted");
  });
});

describe("session event definitions", () => {
  const deps = {
    directory: makeDirectory([
      { topic: "a.b", requires: "a" },
      { topic: "c.d", requires: "c" },
    ]),
  };
  const topics = [
    {
      topic: "a.b",
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $id: "first",
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      },
    },
    {
      topic: "c.d",
      schema: {
        type: "object",
        properties: { c: { type: "number" } },
        required: ["c"],
      },
    },
  ];
  it("advertises topic enums and payload alternatives below data", () => {
    const tool = buildSessionEmitEventTool(deps, topics)!;
    expect(tool.jsonSchema).toEqual({
      type: "object",
      properties: {
        topic: { type: "string", enum: ["a.b", "c.d"] },
        data: {
          type: "object",
          anyOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
              required: ["a"],
              title: "a.b",
            },
            { ...topics[1]!.schema, title: "c.d" },
          ],
        },
      },
      required: ["topic", "data"],
    });
    expect(topics[0]!.schema).toHaveProperty("$id");
  });
  it("uses a single payload directly and leaves sessions without topics unchanged", () => {
    expect(
      buildSessionEmitEventTool(deps, [topics[1]!])!.jsonSchema,
    ).toMatchObject({
      properties: { data: { ...topics[1]!.schema, title: "c.d" } },
    });
    expect(buildSessionEmitEventTool(deps, [])).toBeUndefined();
    expect(createEmitEventTool(deps).jsonSchema).toMatchObject({
      properties: { topic: { type: "string" } },
    });
  });
  it("types nested enum, const and structural nodes only in the model-facing copy", async () => {
    const schema = {
      type: "object",
      properties: {
        checks: {
          items: {
            properties: {
              difficulty: { enum: ["easy", "hard"] },
              outcome: { const: "success" },
            },
          },
        },
        phase: { anyOf: [{ const: "day" }, { enum: ["night"] }] },
        metadata: {
          type: "object",
          default: { enum: ["literal data"], properties: { enum: {} } },
          properties: { enum: { enum: ["value"] } },
          additionalProperties: { enum: [true, false] },
        },
      },
    };
    const original = structuredClone(schema);
    const directory = makeDirectory([{ topic: "checks.resolved" }]);
    directory.validate.mockImplementation(async (_sessionId, _topic, data) => {
      const result = validateOutput(data, schema);
      return result.valid
        ? { ok: true as const }
        : { ok: false as const, reason: "author schema rejected payload" };
    });
    const tool = buildSessionEmitEventTool({ directory }, [
      { topic: "checks.resolved", schema },
      { topic: "other.event", schema: { type: "object" } },
    ])!;
    expect(tool.jsonSchema).toMatchObject({
      properties: {
        data: {
          type: "object",
          anyOf: [
            {
              properties: {
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      difficulty: { type: "string", enum: ["easy", "hard"] },
                      outcome: { type: "string", const: "success" },
                    },
                  },
                },
                phase: {
                  type: "string",
                  anyOf: [
                    { type: "string", const: "day" },
                    { type: "string", enum: ["night"] },
                  ],
                },
                metadata: {
                  default: original.properties.metadata.default,
                  properties: { enum: { type: "string", enum: ["value"] } },
                  additionalProperties: {
                    type: "boolean",
                    enum: [true, false],
                  },
                },
              },
            },
            { type: "object", title: "other.event" },
          ],
        },
      },
    });
    expect(schema).toEqual(original);
    const data = { checks: [{ difficulty: "easy", outcome: "success" }] };
    expect(
      getEmittedEvents(
        await tool.execute({ topic: "checks.resolved", data }, ctx),
      ),
    ).toEqual([{ topic: "checks.resolved", data }]);
    await expect(
      tool.execute(
        {
          topic: "checks.resolved",
          data: { checks: [{ difficulty: "unknown" }] },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(schema).toEqual(original);
  });
  it.each([
    ["string", ["one", "two"]],
    ["number", [1, 2.5]],
    ["boolean", [true, false]],
    ["null", [null]],
    ["object", [{ enum: ["literal data"] }]],
    ["array", [[1], [2]]],
  ])("infers %s for enums and constants", (type, values) => {
    const tool = buildSessionEmitEventTool(deps, [
      {
        topic: "a.b",
        schema: {
          type: "object",
          properties: {
            choice: { enum: values },
            fixed: { const: values[0] },
            count: { type: "integer", enum: [1, 2] },
          },
        },
      },
    ])!;
    expect(tool.jsonSchema).toMatchObject({
      properties: {
        data: {
          properties: {
            choice: { type, enum: values },
            fixed: { type, const: values[0] },
            count: { type: "integer", enum: [1, 2] },
          },
        },
      },
    });
  });
  it.each([
    undefined,
    { $ref: "#/$defs/value", $defs: {} },
    { properties: { nested: { $ref: "#" } } },
    { type: "object", properties: { choice: { enum: ["one", 2] } } },
    { type: "object", properties: { choice: { enum: [] } } },
    { type: "object", properties: { unknown: {} } },
  ])("omits an undescribable topic with a diagnostic (%j)", (schema) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unsafe = { topic: "unsafe.event", schema };
    const tool = buildSessionEmitEventTool(deps, [unsafe, topics[1]!])!;
    expect(tool.jsonSchema).toEqual({
      type: "object",
      properties: {
        topic: { type: "string", enum: ["c.d"] },
        data: { ...topics[1]!.schema, title: "c.d" },
      },
      required: ["topic", "data"],
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"unsafe.event"'),
    );
    expect(buildSessionEmitEventTool(deps, [unsafe])).toBeUndefined();
  });
  it("keeps Zod loose so unknown topics are refused and bad payloads remain invalid-input", async () => {
    const tool = buildSessionEmitEventTool(deps, topics)!;
    expect(
      tool.parametersSchema.safeParse({ topic: "unknown", data: {} }).success,
    ).toBe(true);
    await expect(
      tool.execute({ topic: "unknown", data: {} }, ctx),
    ).rejects.toMatchObject({ code: "refused" });
    await expect(
      tool.execute({ topic: "a.b", data: {} }, ctx),
    ).rejects.toMatchObject({ code: "invalid-input" });
  });
});

describe("local schema references", () => {
  const deps = {
    directory: makeDirectory([{ topic: "a.b", requires: "cues" }]),
  };
  it("writes out shared definitions so the model sees the whole payload", () => {
    const tool = buildSessionEmitEventTool(deps, [
      {
        topic: "a.b",
        schema: {
          $id: "plugin://owner/a.b",
          type: "object",
          required: ["cues"],
          properties: {
            cues: {
              type: "array",
              items: {
                oneOf: [
                  { $ref: "#/$defs/enter" },
                  { $ref: "#/$defs/leave", description: "Leave the stage" },
                ],
              },
            },
          },
          $defs: {
            key: { type: "string", minLength: 1 },
            enter: {
              type: "object",
              required: ["type", "character"],
              properties: {
                type: { const: "enter" },
                character: { $ref: "#/$defs/key" },
              },
            },
            leave: {
              type: "object",
              properties: {
                type: { const: "leave" },
                character: { $ref: "#/$defs/key" },
                // A `$ref` key inside data stays data.
                note: { type: "object", default: { $ref: "kept" } },
              },
            },
          },
        },
      },
    ])!;
    const data = (tool.jsonSchema as { properties: { data: unknown } })
      .properties.data;
    expect(data).toMatchObject({
      properties: {
        cues: {
          items: {
            oneOf: [
              {
                type: "object",
                required: ["type", "character"],
                properties: {
                  character: { type: "string", minLength: 1 },
                },
              },
              {
                description: "Leave the stage",
                properties: {
                  character: { type: "string", minLength: 1 },
                  note: { type: "object", default: { $ref: "kept" } },
                },
              },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(data)).not.toContain("$defs");
    expect(JSON.stringify(data)).not.toContain('"#/');
  });

  it.each([
    [
      "a local reference",
      {
        type: "object",
        properties: { value: { $ref: "#/$defs/value" } },
        $defs: { value: { type: "number" } },
      },
      true,
    ],
    [
      "a recursive reference",
      {
        type: "object",
        properties: { node: { $ref: "#/$defs/node" } },
        $defs: {
          node: {
            type: "object",
            properties: { child: { $ref: "#/$defs/node" } },
          },
        },
      },
      false,
    ],
    ["a root self-reference", { properties: { nested: { $ref: "#" } } }, false],
    [
      "a dangling reference",
      { type: "object", properties: { value: { $ref: "#/$defs/missing" } } },
      false,
    ],
    [
      "a reference to another document",
      { type: "object", properties: { value: { $ref: "other.json" } } },
      false,
    ],
    [
      "a nested identifier",
      {
        type: "object",
        properties: { value: { $id: "inner", type: "number" } },
      },
      false,
    ],
    ["a non-object payload", { type: "string" }, false],
    ["null", null, false],
    ["an array", [{ type: "object" }], false],
  ])("decides whether the tool can describe %s", (_name, schema, expected) => {
    expect(canDescribeEventPayload(schema)).toBe(expected);
  });
});
