import { AiProviderError } from "@covel/ai-provider";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeMusicContext } from "../src/function-runtime/runtime-music-context.js";

interface StoredAsset {
  readonly id: string;
  readonly mime: string;
  readonly size: number;
  readonly meta: Record<string, unknown>;
}

function setup(resolveSlot: () => unknown = () => ({ presetId: "music" })) {
  const assets: StoredAsset[] = [];
  const media = {
    put: vi.fn(
      async (
        bytes: Uint8Array,
        mime: string,
        meta?: Record<string, unknown>,
      ) => {
        const asset = {
          id: `media-${assets.length + 1}`,
          mime,
          size: bytes.byteLength,
          meta: meta ?? {},
        };
        assets.push(asset);
        return { id: asset.id, mime: asset.mime, size: asset.size };
      },
    ),
  };
  const gateway = {
    composeMusic: vi.fn(async () => ({
      audio: { mimeType: "audio/mpeg", data: new Uint8Array([1, 2, 3, 4]) },
      warnings: ["got 30 s"] as readonly string[],
    })),
    resolveSlot: vi.fn(resolveSlot),
  };
  const context = createRuntimeMusicContext(
    gateway as never,
    {
      listByMetadata: async (_sessionId, filter) =>
        assets.filter((asset) =>
          Object.entries(filter).every(
            ([key, value]) => asset.meta[key] === value,
          ),
        ) as never,
    },
    media as never,
    { sessionId: "s1", pluginId: "composer" },
  );
  return { assets, media, gateway, context };
}

describe("ctx.music", () => {
  it("stores a generated piece and returns its reference", async () => {
    const { context, gateway, assets } = setup();

    const output = await context.generate({
      prompt: "slow strings",
      instrumental: true,
      durationSeconds: 45,
      metadata: { mood: "dread", pluginId: "someone-else" },
    });

    expect(output).toEqual({
      refs: [{ id: "media-1", mime: "audio/mpeg", size: 4 }],
      warnings: ["got 30 s"],
      cached: false,
    });
    expect(gateway.composeMusic).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "slow strings",
        instrumental: true,
        durationSeconds: 45,
      }),
    );
    // The plugin's own keys are kept; the framework's cannot be overridden.
    expect(assets[0]!.meta).toMatchObject({
      mood: "dread",
      pluginId: "composer",
    });
    expect(assets[0]!.meta.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("composes again when the music role is bound to another model", async () => {
    let model = "music-a";
    const { context, gateway } = setup(() => ({
      presetId: "music",
      provider: "acme",
      protocol: "openai-chat-v1",
      model,
      metadata: { musicWire: "acme/music" },
    }));
    await context.generate({ prompt: "slow strings" });
    model = "music-b";
    expect((await context.generate({ prompt: "slow strings" })).cached).toBe(
      false,
    );
    expect(gateway.composeMusic).toHaveBeenCalledTimes(2);
    model = "music-a";
    expect((await context.generate({ prompt: "slow strings" })).cached).toBe(
      true,
    );
  });

  it("pays for one request once: the same request returns the stored piece", async () => {
    const { context, gateway } = setup();
    await context.generate({ prompt: "slow strings", durationSeconds: 45 });

    const again = await context.generate({
      prompt: "slow strings",
      durationSeconds: 45,
      metadata: { mood: "calm" },
    });
    expect(again.cached).toBe(true);
    expect(again.refs[0]).toMatchObject({
      id: "media-1",
      meta: { mood: "calm" },
    });
    expect(gateway.composeMusic).toHaveBeenCalledTimes(1);

    // Another length is another piece.
    await context.generate({ prompt: "slow strings", durationSeconds: 90 });
    expect(gateway.composeMusic).toHaveBeenCalledTimes(2);
  });

  it("says whether a music model is configured without asking the provider", () => {
    expect(setup().context.isAvailable()).toBe(true);
    expect(setup(() => null).context.isAvailable()).toBe(false);
    const unconfigured = setup(() => {
      throw new AiProviderError({
        code: "CONFIG_ERROR",
        provider: "unconfigured",
        retriable: false,
        message: "no music role",
      });
    });
    expect(unconfigured.context.isAvailable("music")).toBe(false);
    expect(unconfigured.gateway.resolveSlot).toHaveBeenCalledWith({
      presetId: "music",
      fallbackTag: "music",
    });
    expect(unconfigured.gateway.composeMusic).not.toHaveBeenCalled();
  });

  it("does not start a request that was cancelled", async () => {
    const { context, gateway } = setup();
    await expect(
      context.generate({ prompt: "x", signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    expect(gateway.composeMusic).not.toHaveBeenCalled();
  });
});
