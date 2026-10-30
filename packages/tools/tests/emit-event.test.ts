import { getModelView, ToolError } from "@covel/plugin-handlers-utils";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionEmitEventTool,
  createEmitEventTool,
} from "../src/builtin/emit-event.js";
import { getEmittedEvents, getPendingProposals } from "../src/result.js";
import type { ToolExecutionContext } from "../src/types.js";

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
  it("uses a single payload directly and falls back for absent or referenced schemas", () => {
    expect(
      buildSessionEmitEventTool(deps, [topics[1]!])!.jsonSchema,
    ).toMatchObject({
      properties: { data: { ...topics[1]!.schema, title: "c.d" } },
    });
    for (const schema of [
      undefined,
      { $ref: "#/$defs/value", $defs: {} },
      { properties: { nested: { $ref: "#" } } },
    ])
      expect(
        buildSessionEmitEventTool(deps, [{ topic: "a.b", schema }])!.jsonSchema,
      ).toMatchObject({
        properties: { data: { type: "object", title: "a.b" } },
      });
    expect(buildSessionEmitEventTool(deps, [])).toBeUndefined();
    expect(createEmitEventTool(deps).jsonSchema).toMatchObject({
      properties: { topic: { type: "string" } },
    });
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
