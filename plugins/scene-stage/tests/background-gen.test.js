import { describe, expect, it, vi } from "vitest";
import { expectAssetGenerated } from "@covel/plugin-test-utils";
import handler from "../runtimes/background-gen/handler.js";

const TOPIC = "scene-stage.generate.requested";

function makeRef(id = "a") {
  return { id: id.repeat(64).slice(0, 64), mime: "image/png", size: 2048 };
}

const REGISTRY = {
  schemaVersion: 1,
  registryId: "scene-registry",
  style: {
    prefix: "Visual novel background, ",
    suffix: ", clean composition",
    nightSuffix: ", night time, moonlight",
  },
};

function makeCtx({
  sceneId = "gen-abcd1234",
  location = "废弃天文台",
  visualHint = "an abandoned observatory at dusk",
  variant = "day",
  registry = REGISTRY,
  existingGenerated = null,
  stage = null,
  images = {
    generate: vi
      .fn()
      .mockResolvedValue({ refs: [makeRef()], warnings: [], cached: false }),
  },
} = {}) {
  const get = vi.fn(async (namespace, key) => {
    if (namespace === "scenes" && key === "scene-registry") return registry;
    if (namespace === "generated" && key === sceneId) return existingGenerated;
    if (namespace === "stage" && key === "current") return stage;
    return null;
  });
  return {
    pluginId: "scene-stage",
    runtimeId: "scene-stage/background-gen",
    sessionId: "sess-1",
    turnId: "turn-1",
    triggerEvent: {
      topic: TOPIC,
      data: {
        sceneId,
        location,
        ...(visualHint ? { visualHint } : {}),
        variant,
      },
    },
    pluginData: { get, set: vi.fn(), list: vi.fn(), delete: vi.fn() },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    images,
  };
}

describe("scene-stage background-gen handler", () => {
  it("1. generates the day variant, writes the generated index, and refreshes a pending stage", async () => {
    const stage = {
      sceneId: "gen-abcd1234",
      variant: "day",
      source: "pending",
      day: null,
      night: null,
      resolved: null,
    };
    const ctx = makeCtx({ stage });

    const result = await handler(ctx);

    expect(ctx.images.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt:
          "Visual novel background, an abandoned observatory at dusk, clean composition",
        size: "1536x1024",
        n: 1,
        metadata: {
          kind: "scene-background",
          sceneId: "gen-abcd1234",
          variant: "day",
        },
      }),
    );
    expect(ctx.images.generate.mock.calls[0][0].signal).toBeInstanceOf(
      AbortSignal,
    );

    const asset = expectAssetGenerated(result, { modality: "image" });
    expect(asset.meta).toEqual({
      kind: "scene-background",
      sceneId: "gen-abcd1234",
      variant: "day",
    });

    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "generated",
      "gen-abcd1234",
      expect.objectContaining({
        sceneId: "gen-abcd1234",
        location: "废弃天文台",
        day: asset.ref,
        night: null,
      }),
    );
    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "stage",
      "current",
      expect.objectContaining({
        sceneId: "gen-abcd1234",
        source: "session",
        day: asset.ref,
        night: null,
        resolved: asset.ref,
        sourceLabel: { zh: "本局生成", en: "Generated this session" },
      }),
    );
  });

  it("2. night variant appends nightSuffix and preserves the existing day ref", async () => {
    const existingDay = makeRef("d");
    const ctx = makeCtx({
      variant: "night",
      existingGenerated: {
        sceneId: "gen-abcd1234",
        location: "废弃天文台",
        day: existingDay,
        night: null,
      },
    });

    await handler(ctx);

    expect(ctx.images.generate.mock.calls[0][0].prompt).toBe(
      "Visual novel background, an abandoned observatory at dusk, clean composition, night time, moonlight",
    );
    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "generated",
      "gen-abcd1234",
      expect.objectContaining({ day: existingDay, night: expect.any(Object) }),
    );
  });

  it("3. falls back to the location as the prompt subject when visualHint is missing", async () => {
    // "" (not undefined) so the makeCtx default parameter doesn't refill it.
    const ctx = makeCtx({ visualHint: "", location: "旧图书馆地下室" });

    await handler(ctx);

    expect(ctx.images.generate.mock.calls[0][0].prompt).toBe(
      "Visual novel background, 旧图书馆地下室, clean composition",
    );
  });

  it("4. returns a failed status and logs when ctx.images is unavailable, without throwing", async () => {
    // null (not undefined) so the makeCtx default parameter doesn't refill it.
    const ctx = makeCtx({ images: null });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ctx\.images is unavailable/);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "scene-stage.background-gen.no-images-context",
      expect.objectContaining({ sceneId: "gen-abcd1234" }),
    );
    expect(ctx.pluginData.set).not.toHaveBeenCalled();
  });

  it("5. only updates the generated index when stage/current has moved to a different scene", async () => {
    const ctx = makeCtx({
      stage: { sceneId: "some-other-scene", variant: "day", source: "world" },
    });

    await handler(ctx);

    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "generated",
      "gen-abcd1234",
      expect.any(Object),
    );
    expect(ctx.pluginData.set).not.toHaveBeenCalledWith(
      "stage",
      "current",
      expect.anything(),
    );
  });

  it("6. generates with a bare subject when the registry carries no style block", async () => {
    const ctx = makeCtx({
      registry: { schemaVersion: 1, registryId: "scene-registry" },
    });

    await handler(ctx);

    expect(ctx.images.generate.mock.calls[0][0].prompt).toBe(
      "an abandoned observatory at dusk",
    );
  });

  it("returns a failed status when the provider resolves with zero refs", async () => {
    const ctx = makeCtx({
      images: {
        generate: vi
          .fn()
          .mockResolvedValue({ refs: [], warnings: [], cached: false }),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
