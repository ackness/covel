import { describe, expect, it } from "vitest";
import { worldDimensionGetTool as instance } from "../src/builtin/world-dimension-tools.js";
function context() {
  return {
    sessionId: "s",
    pluginId: "world-init",
    runtimeId: "world-init/dimension-tracker",
    turnId: "t",
    locale: "en-US",
    world: {
      dimensions: {
        discoveries: {
          name: "Discoveries",
          schema: {
            type: "object",
            additionalProperties: {
              type: "object",
              properties: {
                name: { type: "string", "x-i18n": true },
                progress: { type: "integer" },
              },
            },
          },
          value: {
            harbor: {
              name: { "en-US": "Harbor", "zh-CN": "港口" },
              progress: 3,
            },
          },
          version: 7,
        },
      },
    },
    store: { getSession: async () => ({ locale: "en-US" }) },
  };
}
describe("public frozen dimension queries", () => {
  it("reads current versioned values and only explicitly marked translations", async () => {
    const result = await instance.execute(
      { queries: [{ dimension: "discoveries", path: "harbor.name" }] },
      context(),
    );
    expect(result.results[0]).toMatchObject({
      found: true,
      value: "Harbor",
      version: 7,
    });
  });
  it("does not expose private write previews or read initial values as a fallback", async () => {
    const ctx = context();
    ctx.pendingProposals = [
      {
        type: "plugin.data",
        payload: {
          namespace: "entries",
          key: "discoveries",
          value: { harbor: { progress: 99 } },
        },
      },
    ];
    expect(
      (
        await instance.execute(
          { queries: [{ dimension: "discoveries", path: "harbor.progress" }] },
          ctx,
        )
      ).results[0],
    ).toMatchObject({ value: 3, version: 7 });
    await expect(
      instance.execute(
        { queries: [{ dimension: "discoveries" }] },
        {
          ...ctx,
          world: {
            worldRecord: { dimensions: { discoveries: { initialValue: 99 } } },
          },
        },
      ),
    ).rejects.toThrow("unavailable");
  });
  it("reports unknown IDs and invalid/absent paths explicitly", async () => {
    const result = await instance.execute(
      {
        queries: [
          { dimension: "unknown" },
          { dimension: "discoveries", path: "harbor[bad]" },
          { dimension: "discoveries", path: "missing" },
        ],
      },
      context(),
    );
    expect(result.results.every((item) => !item.found)).toBe(true);
  });
  it("keeps arbitrary named-map keys queryable through JSON Pointer and pages strings", async () => {
    const ctx = context();
    ctx.world.dimensions.discoveries.value["a.b"] = {
      name: { "en-US": "abcdefgh" },
      progress: 1,
    };
    const result = await instance.execute(
      {
        queries: [
          { dimension: "discoveries", path: "/a.b/name", offset: 2, limit: 3 },
        ],
      },
      ctx,
    );
    expect(result.results[0]).toMatchObject({
      value: "abcdefgh",
      page: { value: "cde", total: 8, nextOffset: 5 },
      version: 7,
    });
  });
});
