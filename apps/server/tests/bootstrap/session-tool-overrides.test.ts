import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiChatAdapter } from "@covel/ai-provider";
import { createMemoryStore } from "@covel/store/memory";
import { setupPluginTools } from "../../src/routes/api/bootstrap/tools.js";
import type { EventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function directory(
  describeTopics?: EventDirectory["describeTopics"],
): EventDirectory {
  return {
    describeTopics,
    listTopics: async () => [],
    validate: async () => ({ ok: true }),
    validateOwn: async () => ({ ok: true }),
    catalogText: async () => "",
  };
}
const context = (sessionId: string) => ({
  sessionId,
  turnId: "turn",
  pluginId: "probe",
  runtimeId: "probe/agent",
});

describe("session tool definitions", () => {
  it("sends normalized event enums through a mocked custom transport", async () => {
    const store = createMemoryStore();
    const env = await setupPluginTools({
      store,
      eventDirectory: directory(async () => [
        {
          topic: "checks.resolved",
          schema: {
            type: "object",
            properties: {
              checks: {
                type: "array",
                items: {
                  type: "object",
                  properties: { difficulty: { enum: ["easy", "hard"] } },
                },
              },
            },
          },
        },
        {
          topic: "scene.changed",
          schema: {
            type: "object",
            properties: { phase: { enum: ["day", "night"] } },
          },
        },
      ]),
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        choices: [
          {
            message: { role: "assistant", content: "Story continues." },
            finish_reason: "stop",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      await env.prepareToolsForSession("session");
      const info = env.toolExecutor.getToolInfo(
        "emit-event",
        context("session"),
      )!;
      await createOpenAiChatAdapter().generateText(
        { baseUrl: "https://custom.invalid/v1" },
        {
          model: "fixture-model",
          messages: [{ role: "user", content: "Continue." }],
          tools: [
            {
              type: "function",
              function: {
                name: "emit-event",
                parameters: info.jsonSchema,
              },
            },
          ],
        },
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      const request: unknown = JSON.parse(
        String(fetcher.mock.calls[0]![1]?.body),
      );
      expect(request).toMatchObject({
        tools: [
          {
            function: {
              parameters: {
                properties: {
                  data: {
                    type: "object",
                    anyOf: [
                      {
                        properties: {
                          checks: {
                            items: {
                              properties: {
                                difficulty: {
                                  type: "string",
                                  enum: ["easy", "hard"],
                                },
                              },
                            },
                          },
                        },
                      },
                      {
                        properties: {
                          phase: { type: "string", enum: ["day", "night"] },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      });
    } finally {
      await env.toolExecutor.close();
      await store.close();
    }
  });
  it("hides emit-event only for a session whose topics cannot be described and refreshes it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const store = createMemoryStore();
    let repaired = false;
    const env = await setupPluginTools({
      store,
      eventDirectory: directory(async (id) => [
        {
          topic: "optional.event",
          schema: {
            type: "object",
            properties: {
              value: id === "unsafe" && !repaired ? {} : { enum: ["ready"] },
            },
          },
        },
      ]),
    });
    const info = (id: string) =>
      env.toolExecutor.getToolInfo("emit-event", context(id));
    try {
      await env.prepareToolsForSession("unsafe");
      await env.prepareToolsForSession("safe");
      expect(info("unsafe")).toBeUndefined();
      expect(info("safe")?.jsonSchema).toMatchObject({
        properties: {
          topic: { enum: ["optional.event"] },
        },
      });
      repaired = true;
      await env.prepareToolsForSession("unsafe");
      expect(info("unsafe")?.jsonSchema).toEqual(info("safe")?.jsonSchema);
    } finally {
      await env.toolExecutor.close();
      await store.close();
    }
  });
  it("refreshes independent character and event variants and clears both", async () => {
    const store = createMemoryStore();
    vi.spyOn(store, "getCharacterSchema").mockImplementation(
      async (sessionId) =>
        sessionId === "typed"
          ? {
              sessionId,
              version: 1,
              types: ["companion"],
              attributes: [],
              createdAt: "now",
              updatedAt: "now",
            }
          : null,
    );
    let topic = "a.b";
    const env = await setupPluginTools({
      store,
      eventDirectory: directory(async (sessionId) => [
        {
          topic: sessionId === "other" ? "c.d" : topic,
          schema: { type: "object" },
        },
      ]),
    });
    const info = (sessionId: string, name = "emit-event") =>
      env.toolExecutor.getToolInfo(name, context(sessionId));
    try {
      for (const id of ["plain", "other", "typed"])
        await env.prepareToolsForSession(id);
      expect(info("plain")?.jsonSchema).toMatchObject({
        properties: { topic: { enum: ["a.b"] } },
      });
      expect(info("other")?.jsonSchema).toMatchObject({
        properties: { topic: { enum: ["c.d"] } },
      });
      expect(info("typed", "sync-characters")?.jsonSchema).toMatchObject({
        properties: {
          creates: {
            items: { properties: { type: { enum: ["player", "companion"] } } },
          },
        },
      });
      for (const name of [
        "create-character",
        "update-character",
        "get-character-schema",
      ])
        expect(info("typed", name)).toBeUndefined();
      topic = "changed.topic";
      await env.prepareToolsForSession("plain");
      expect(info("plain")?.jsonSchema).toMatchObject({
        properties: { topic: { enum: ["changed.topic"] } },
      });
      env.clearSessionToolOverrides("typed");
      const clearedEventSchema = info("typed")?.jsonSchema;
      expect(clearedEventSchema).toEqual(
        env.tools.find("emit-event", "probe")!.jsonSchema,
      );
      expect(clearedEventSchema).not.toHaveProperty("properties.topic.enum");
      expect(info("typed", "sync-characters")?.jsonSchema).toEqual(
        env.tools.find("sync-characters", "probe")!.jsonSchema,
      );
    } finally {
      await env.toolExecutor.close();
      await store.close();
    }
  });
  it.each(["absent", "empty", "failed"])(
    "uses generic events when topic descriptions are %s",
    async (kind) => {
      const store = createMemoryStore();
      const env = await setupPluginTools({
        store,
        eventDirectory: directory(
          kind === "absent"
            ? undefined
            : async () => {
                if (kind === "failed") throw new Error("Unavailable directory");
                return [];
              },
        ),
      });
      try {
        await env.prepareToolsForSession("session");
        expect(
          env.toolExecutor.getToolInfo("emit-event", context("session"))
            ?.jsonSchema,
        ).toMatchObject({ properties: { topic: { type: "string" } } });
        expect(
          JSON.stringify(
            env.toolExecutor.getToolInfo("emit-event", context("session"))
              ?.jsonSchema,
          ),
        ).not.toContain('"enum"');
      } finally {
        await env.toolExecutor.close();
        await store.close();
      }
    },
  );
});
