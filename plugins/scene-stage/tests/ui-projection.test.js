import { describe, expect, it } from "vitest";
import register from "../server/index.js";
const handlers = new Map();
register({
  provideExtension: (_point, id, { handler }) => handlers.set(id, handler),
});
const ref = { id: "a".repeat(64), mime: "image/png", size: 1 };
const context = (data) => ({
  world: { characters: [{ id: "session-hero", name: "Hero" }] },
  pluginData: {
    get: async (namespace, key) =>
      data[`${namespace}/${key}`]
        ? { value: data[`${namespace}/${key}`] }
        : null,
    list: async (namespace) =>
      Object.entries(data)
        .filter(([key]) => key.startsWith(`${namespace}/`))
        .map(([key, value]) => ({ key, value, updatedAt: "2026-01-01" })),
  },
});
describe("stage UI projections", () => {
  it("projects resolved imagery and preloads a registry without an active scene", async () => {
    expect(
      await handlers.get("backdrop")(
        { events: [] },
        context({
          "scenes/scene-registry": { scenes: [{ sceneId: "gate", day: ref }] },
        }),
      ),
    ).toEqual({ preload: [ref] });
  });
  it("maps dialogue speaker ids to kernel character names and preserves narration gaps", async () => {
    expect(
      await handlers.get("dialogue")(
        {
          events: [
            {
              topic: "stage.direction",
              turnId: "t",
              data: {
                dialogue: {
                  paragraphSpeakers: ["session-hero", null, "unknown"],
                },
              },
            },
          ],
        },
        context({}),
      ),
    ).toEqual({ turnId: "t", paragraphSpeakers: ["Hero", null, null] });
  });
  it("lets an explicit empty direction clear an earlier cast provider", async () => {
    const value = await handlers.get("direction")(
      {
        previous: {
          actors: [{ characterId: "session-hero", displayName: "Hero" }],
          retainWhenEmpty: true,
        },
        events: [],
      },
      context({ "direction/current": { actors: [], schemaVersion: 1 } }),
    );
    expect(value).toEqual({ actors: [], retainWhenEmpty: false });
  });
});
