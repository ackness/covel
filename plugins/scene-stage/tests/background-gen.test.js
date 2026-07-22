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
  progress = undefined,
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
    ...(progress ? { progress } : {}),
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

  it("7. skips the image call when the requested variant already exists, but still refreshes a lagging stage", async () => {
    const existingDay = makeRef("e");
    const ctx = makeCtx({
      variant: "day",
      existingGenerated: {
        sceneId: "gen-abcd1234",
        location: "废弃天文台",
        day: existingDay,
        night: null,
      },
      stage: {
        sceneId: "gen-abcd1234",
        variant: "day",
        source: "pending",
        day: null,
        night: null,
        resolved: null,
      },
    });

    const result = await handler(ctx);

    expect(ctx.images.generate).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(ctx.pluginData.set).not.toHaveBeenCalledWith(
      "generated",
      expect.anything(),
      expect.anything(),
    );
    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "stage",
      "current",
      expect.objectContaining({
        sceneId: "gen-abcd1234",
        source: "session",
        day: existingDay,
        resolved: existingDay,
      }),
    );
  });

  it("8. persists the visualHint on the generated index so a later night backfill can reuse it", async () => {
    const ctx = makeCtx({
      variant: "day",
      visualHint: "an abandoned observatory at dusk",
    });

    await handler(ctx);

    expect(ctx.pluginData.set).toHaveBeenCalledWith(
      "generated",
      "gen-abcd1234",
      expect.objectContaining({
        visualHint: "an abandoned observatory at dusk",
      }),
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

describe("scene-stage background-gen progress reporting", () => {
  it("reports running then succeeded with a monotonic sequence on success", async () => {
    const report = vi.fn();
    const ctx = makeCtx({ progress: { report } });

    await handler(ctx);

    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toMatchObject({
      jobId: "scene-background:gen-abcd1234:day",
      state: "running",
      sequence: 1,
    });
    expect(report.mock.calls[1][0]).toMatchObject({
      jobId: "scene-background:gen-abcd1234:day",
      state: "succeeded",
      progress: 1,
      sequence: 2,
    });
  });

  it("reports running then failed when image generation throws", async () => {
    const report = vi.fn();
    const ctx = makeCtx({
      progress: { report },
      images: {
        generate: vi.fn().mockRejectedValue(new Error("provider exploded")),
      },
    });

    const result = await handler(ctx);

    expect(result.status).toBe("failed");
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0][0]).toMatchObject({
      state: "running",
      sequence: 1,
    });
    expect(report.mock.calls[1][0]).toMatchObject({
      state: "failed",
      sequence: 2,
      message: "provider exploded",
    });
  });

  it("does not start a job (no report) when the requested variant is already cached", async () => {
    // The cached skip returns before any billed generation — reporting here
    // would create a phantom job the kernel never sees terminate.
    const report = vi.fn();
    const ctx = makeCtx({
      progress: { report },
      variant: "day",
      existingGenerated: {
        sceneId: "gen-abcd1234",
        location: "废弃天文台",
        day: makeRef("e"),
        night: null,
      },
    });

    await handler(ctx);

    expect(report).not.toHaveBeenCalled();
  });

  it("silently skips progress when ctx.progress is absent", async () => {
    // No job-status channel wired (test harness / host) — generation unaffected.
    const result = await handler(makeCtx());
    expect(result.status).toBe("done");
  });

  it("swallows a progress.report error without failing generation", async () => {
    const report = vi.fn().mockRejectedValue(new Error("job store down"));
    const result = await handler(makeCtx({ progress: { report } }));
    expect(result.status).toBe("done");
  });
});
