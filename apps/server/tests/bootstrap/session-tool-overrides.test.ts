import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { setupPluginTools } from "../../src/routes/api/bootstrap/tools.js";
import type { EventDirectory } from "../../src/routes/api/bootstrap/event-directory.js";

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
      expect(info("typed")?.jsonSchema).toMatchObject({
        properties: { topic: { type: "string" } },
      });
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
