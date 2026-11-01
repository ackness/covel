import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteStore } from "@covel/store/sqlite";
import type { PluginRuntimeGateway } from "@covel/shared/plugin-runtime";
import { createPresentationBudget } from "../src/presentation/budget.js";
import { takePresentationSnapshot } from "../src/presentation/projection.js";
import { presentationGateway } from "../src/presentation/gateway.js";
import { withStalledCallRetry } from "../src/function-runtime/runtime-abort-boundaries.js";
import type { PresentationState } from "../src/presentation/state.js";
import { presenter, setup, detachedInput } from "./presentation-fixture.js";
import { createMemoryMediaStore } from "@covel/store/memory";
import {
  AiProviderError,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  type ModelProviderAdapter,
} from "@covel/ai-provider";
import { createPluginRuntimeGateway } from "../src/function-runtime/plugin-runtime-gateway.js";

afterEach(() => vi.useRealTimers());
const response = {
  text: "art direction",
  finishReason: "stop" as const,
  usage: { inputTokens: 1, outputTokens: 1 },
};
const gateway = (
  generateText: PluginRuntimeGateway["generateText"],
): PluginRuntimeGateway => ({
  generateText,
  generateObject: async <T>() => ({
    object: {} as T,
    finishReason: "stop",
    usage: response.usage,
  }),
  resolveSlot: () => null,
});
async function fixture(calls = 2, generations = 1, sqlite = false) {
  const f = await setup(sqlite ? createSqliteStore(":memory:") : undefined);
  const manifest = presenter({
    presentation: {
      budget: { calls, generations },
      publicAssetNamespaces: ["assets"],
    },
    turnCompletion: { mode: "detached" },
  });
  const snapshot = {
    ...(await takePresentationSnapshot({
      store: f.store,
      manifest,
      sessionId: "session",
      sourceTurnId: "source",
      sourceExecutionId: "execution",
      story: { segments: [{ kind: "narration", text: "Public story" }] },
    })),
    committed: true,
  };
  const state = (): PresentationState => ({
    snapshot,
    mediaIds: new Set(),
    budget: createPresentationBudget({
      store: f.store,
      sessionId: "session",
      snapshot,
      currentLimits: { calls, generations },
      assertLive: () => {},
    }),
  });
  return { ...f, state, snapshot };
}
describe("durable presentation dispatch allowance", () => {
  it("treats an unavailable ledger as a no-op while keeping actual provider failures distinct", async () => {
    const f = await fixture(1, 0);
    const manifest = presenter({
      presentation: { budget: { calls: 1 }, publicAssetNamespaces: ["assets"] },
      turnCompletion: { mode: "detached" },
    });
    const send = vi.fn(async () => response);
    const read = f.store.getPluginData.bind(f.store);
    const unavailable = vi
      .spyOn(f.store, "getPluginData")
      .mockImplementation((sessionId, pluginId, namespace, key) =>
        namespace === "_presentation_budget"
          ? Promise.reject(new Error("private-ledger-error"))
          : read(sessionId, pluginId, namespace, key),
      );
    const run = (bound: PluginRuntimeGateway) =>
      f.run(
        async (ctx) => {
          await ctx.gateway!.generateText({ prompt: "Public story" });
          return { outcome: "success", value: {} };
        },
        manifest,
        { gateway: bound },
        detachedInput(manifest, f.snapshot),
      );
    const absent = await run(gateway(send));
    expect(absent.result.runtimeResults[0]).toMatchObject({
      status: "skipped",
    });
    expect(absent.result.runtimeResults[0]?.fault).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
    expect((await f.commit(absent)).status).toBe("committed");
    unavailable.mockRestore();
    const provider = await run(
      gateway(async () => {
        throw new AiProviderError({
          code: "PROVIDER_ERROR",
          provider: "fixture",
          retriable: false,
          message: "private-provider-error",
        });
      }),
    );
    expect(provider.result.runtimeResults[0]).toMatchObject({
      status: "failed",
    });
    expect(provider.result.runtimeResults[0]?.fault).toBeUndefined();
    expect(JSON.stringify(provider.result)).not.toContain(
      "private-provider-error",
    );
    expect((await f.commit(provider)).status).toBe("committed");
    expect(
      JSON.stringify(await f.store.listTraceEvents("session")),
    ).not.toMatch(/private-ledger-error|private-provider-error/);
    await expect(f.state().budget.reserve()).rejects.toMatchObject({
      name: "PresentationBudgetExhausted",
    });
    await f.store.close();
  });
  it.each([false, true])(
    "settles exhaustion normally and retains only a handler's completed fallback (caught=%s)",
    async (caught) => {
      const f = await fixture(1, 0);
      const manifest = presenter({
        presentation: {
          budget: { calls: 1 },
          publicAssetNamespaces: ["assets"],
        },
        turnCompletion: { mode: "detached" },
      });
      const send = vi.fn(async () => response);
      const execution = await f.run(
        async (ctx) => {
          await ctx.gateway!.generateText({ prompt: "Public story" });
          await ctx.pluginData!.set("display", "current", {
            title: "Incomplete",
          });
          if (caught) {
            try {
              await ctx.gateway!.generateText({
                prompt: "Second public request",
              });
            } catch {
              await ctx.pluginData!.set("display", "current", {
                title: "Existing asset fallback",
              });
            }
          } else
            await ctx.gateway!.generateText({
              prompt: "Second public request",
            });
          return { outcome: "success", value: {} };
        },
        manifest,
        { gateway: gateway(send) },
        detachedInput(manifest, f.snapshot),
      );
      const result = execution.result.runtimeResults[0]!;
      expect(result.status).toBe(caught ? "success" : "skipped");
      expect(result.fault).toBeUndefined();
      expect((await f.commit(execution)).status).toBe("committed");
      expect(send).toHaveBeenCalledTimes(1);
      expect(
        (
          await f.store.getPluginData(
            "session",
            "display",
            "display",
            "current",
          )
        )?.value ?? null,
      ).toEqual(caught ? { title: "Existing asset fallback" } : null);
      expect(
        (await f.store.listTraceEvents("session")).find(
          (row) => row.type === "presentation.completed",
        )?.payload,
      ).toMatchObject(
        caught
          ? { status: "updated" }
          : { status: "no-op", reason: "budget-exhausted" },
      );
      await f.store.close();
    },
  );
  it.each([false, true])(
    "retains dispatched spend after a result transaction rolls back (sqlite=%s)",
    async (sqlite) => {
      const f = await fixture(1, 0, sqlite);
      const manifest = presenter({
        presentation: {
          budget: { calls: 1 },
          publicAssetNamespaces: ["assets"],
        },
        turnCompletion: { mode: "detached" },
      });
      const send = vi.fn(async () => response);
      const execution = await f.run(
        async (ctx) => {
          await ctx.gateway!.generateText({ prompt: "Public story" });
          await ctx.pluginData!.set("display", "current", {
            title: "Generated",
          });
          return { outcome: "success", value: {} };
        },
        manifest,
        { gateway: gateway(send) },
        detachedInput(manifest, f.snapshot),
      );
      expect(
        (
          await f.commit(execution, {
            extraInTx: async () => {
              throw new Error("Injected later store failure");
            },
          })
        ).status,
      ).toBe("failed");
      expect(
        await f.store.getPluginData("session", "display", "display", "current"),
      ).toBeNull();
      await expect(
        presentationGateway(gateway(send), f.state(), () => {}).generateText({
          prompt: "Retry",
        }),
      ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
      expect(send).toHaveBeenCalledTimes(1);
      await f.store.close();
    },
  );
  it("shares calls and units with music and speech while isolating actual source turns and runtimes", async () => {
    const f = await fixture(3, 2);
    const music = vi.fn(async () => ({
      audio: { data: new Uint8Array([1]), mimeType: "audio/mpeg" },
      warnings: [],
    }));
    const speech = vi.fn(async () => ({
      audio: { data: new Uint8Array([2]), mimeType: "audio/mpeg" },
      warnings: [],
    }));
    const text = vi.fn(async () => response);
    const base = {
      ...gateway(text),
      composeMusic: music,
      synthesizeSpeech: speech,
    };
    const original = presentationGateway(base, f.state(), () => {});
    await original.generateText({ prompt: "Public scene" });
    await original.composeMusic!({ prompt: "Public scene music" });
    await original.synthesizeSpeech!({ text: "Public dialogue" });
    await expect(
      original.generateText({ prompt: "Extra" }),
    ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
    for (const snapshot of [
      { ...f.snapshot, sourceTurnId: "first-player" },
      { ...f.snapshot, sourceTurnId: "auto-one" },
      { ...f.snapshot, sourceTurnId: "auto-two" },
      { ...f.snapshot, runtimeId: "display/other" },
      { ...f.snapshot, pluginId: "other-owner" },
    ]) {
      const state = {
        ...f.state(),
        snapshot,
        budget: createPresentationBudget({
          store: f.store,
          sessionId: "session",
          snapshot,
          currentLimits: { calls: 1, generations: 0 },
          assertLive: () => {},
        }),
      };
      const bound = presentationGateway(base, state, () => {});
      await bound.generateText({ prompt: "Independent source" });
      await expect(
        bound.generateText({ prompt: "Extra" }),
      ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
    }
    expect(text).toHaveBeenCalledTimes(6);
    expect(music).toHaveBeenCalledOnce();
    expect(speech).toHaveBeenCalledOnce();
    await f.store.close();
  });
  it("shares real request-scoped text, object and image dispatches with helper caching", async () => {
    const f = await fixture(4, 2);
    const mediaStore = createMemoryMediaStore();
    const calls: string[] = [];
    const adapter: ModelProviderAdapter = {
      generateText: async (config) => {
        expect(config.apiKey).toBe("request-secret");
        calls.push("text");
        return response;
      },
      generateObject: async <T>() => {
        calls.push("object");
        return { object: {} as T, finishReason: "stop", usage: response.usage };
      },
      async *streamText() {
        throw new Error("Unexpected stream");
      },
      embed: async () => {
        throw new Error("Unexpected embedding");
      },
    };
    const full = createGateway({
      presetRegistry: createPresetRegistry({ profiles: [], presets: [] }),
      providerRegistry: createProviderRegistry({
        providers: { fixture: { adapter } },
      }),
    });
    const requestOptions = {
      apiKeys: { fixture: "request-secret" },
      slotOverrides: {
        slotBindings: {
          plugin: { modelRef: "request-text" },
          image: { modelRef: "request-image" },
        },
        customPresets: [
          {
            id: "request-text",
            name: "Request text",
            provider: "fixture",
            model: "text",
            protocol: "openai-chat-v1",
            baseUrl: "https://fixture.example",
          },
          {
            id: "request-image",
            name: "Request image",
            provider: "fixture",
            model: "gpt-image-1",
            protocol: "openai-chat-v1",
            baseUrl: "https://fixture.example",
          },
        ],
      },
    } satisfies NonNullable<Parameters<typeof createPluginRuntimeGateway>[1]>;
    const bound = createPluginRuntimeGateway(
      {
        ...full,
        generateImage: async (input) => {
          const target = full.resolveSlot(input.presetId, {
            ...requestOptions,
            fallbackTag: "image",
          });
          expect(target?.model).toBe("gpt-image-1");
          calls.push("image");
          return {
            target: {
              provider: "fixture",
              model: "gpt-image-1",
              protocol: "openai-chat-v1",
              baseUrl: "https://fixture.example",
              metadata: target?.metadata ?? {},
            },
            images: [
              {
                kind: "bytes" as const,
                bytes: new Uint8Array([1, 2]),
                mime: "image/png",
              },
            ],
            warnings: [],
          };
        },
      },
      requestOptions,
    );
    expect(bound.resolveSlot({})).toBeNull();
    const manifest = presenter({
      model: "plugin",
      presentation: {
        budget: { calls: 4, generations: 2 },
        publicAssetNamespaces: ["assets"],
      },
      turnCompletion: { mode: "detached" },
      effects: {
        reads: [
          "plugin-data:self:assets",
          "plugin-data:self:display",
          "media:*",
        ],
        writes: ["plugin-data:self:display", "media:*"],
      },
    });
    const snapshot = { ...f.snapshot, limits: { calls: 4, generations: 2 } };
    const execution = await f.run(
      async (ctx) => {
        expect(ctx.gateway!.resolveSlot({})?.model).toBe("text");
        expect(JSON.stringify(ctx.gateway!.resolveSlot({}))).not.toContain(
          "request-secret",
        );
        expect(ctx.images!.isAvailable()).toBe(true);
        const first = await ctx.images!.generate({
          prompt: "Public library art",
        });
        const cached = await ctx.images!.generate({
          prompt: "Public library art",
        });
        expect(first.cached).toBe(false);
        expect(cached.cached).toBe(true);
        expect(cached.refs).toEqual(first.refs);
        await ctx.gateway!.generateText({ prompt: "Public library story" });
        await ctx.gateway!.generateObject({
          prompt: "Public art metadata",
          schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        });
        await ctx.gateway!.generateImage!({ prompt: "Different public art" });
        await expect(
          ctx.images!.generate({ prompt: "Too many images", n: 2 }),
        ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
        await ctx.pluginData!.set("display", "current", {
          art: first.refs[0]!,
        });
        return { outcome: "success", value: {} };
      },
      manifest,
      { gateway: bound, mediaStore },
      detachedInput(manifest, snapshot),
    );
    expect(execution.result.runtimeResults[0]?.status).toBe("success");
    expect((await f.commit(execution, { mediaStore })).status).toBe(
      "committed",
    );
    expect(calls).toEqual(["image", "text", "object", "image"]);
    expect(
      (await f.store.listTraceEvents("session")).find(
        (event) => event.type === "presentation.completed",
      )?.payload,
    ).toMatchObject({
      status: "updated",
      budget: { calls: { used: 4 }, generations: { used: 2 } },
    });
    await f.store.close();
  });
  it.each([false, true])(
    "atomically admits two concurrent requests and retains spend across adapter recreation (sqlite=%s)",
    async (sqlite) => {
      const f = await fixture(2, 1, sqlite);
      const send = vi.fn(async () => response);
      const a = presentationGateway(gateway(send), f.state(), () => {});
      const b = presentationGateway(gateway(send), f.state(), () => {});
      const results = await Promise.allSettled([
        a.generateText({ prompt: "one" }),
        b.generateText({ prompt: "two" }),
        a.generateText({ prompt: "three" }),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
      await expect(
        presentationGateway(gateway(send), f.state(), () => {}).generateText({
          prompt: "retry",
        }),
      ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
      expect(send).toHaveBeenCalledTimes(2);
      await f.store.close();
    },
  );
  it("refuses zero allowance before dispatch and keeps failed dispatches spent", async () => {
    const f = await fixture(0, 0);
    const send = vi.fn(async () => {
      throw new Error("Provider disconnected");
    });
    await expect(
      presentationGateway(gateway(send), f.state(), () => {}).generateText({
        prompt: "valid",
      }),
    ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
    expect(send).not.toHaveBeenCalled();
    await f.store.close();
    const paid = await fixture(1, 0);
    const bound = presentationGateway(gateway(send), paid.state(), () => {});
    await expect(bound.generateText({ prompt: "valid" })).rejects.toThrow(
      "Provider disconnected",
    );
    await expect(bound.generateText({ prompt: "valid" })).rejects.toMatchObject(
      { name: "PresentationBudgetExhausted" },
    );
    expect(send).toHaveBeenCalledTimes(1);
    await paid.store.close();
  });
  it("reserves all requested media units together with the dispatch", async () => {
    const f = await fixture(2, 1);
    const state = f.state();
    await expect(state.budget.reserve(2)).rejects.toMatchObject({
      name: "PresentationBudgetExhausted",
    });
    expect(state.budget.usage()).toMatchObject({
      calls: { used: 0 },
      generations: { used: 0 },
    });
    await state.budget.reserve(1);
    await state.budget.reserve(0);
    expect(state.budget.usage()).toMatchObject({
      calls: { used: 2 },
      generations: { used: 1 },
    });
    await f.store.close();
  });
  it("charges a real stalled wrapper retry against the same allowance", async () => {
    const f = await fixture(2, 0);
    vi.useFakeTimers();
    const send = vi
      .fn<PluginRuntimeGateway["generateText"]>()
      .mockImplementationOnce(
        (input) =>
          new Promise((_resolve, reject) =>
            input.signal!.addEventListener(
              "abort",
              () => reject(input.signal!.reason),
              { once: true },
            ),
          ),
      )
      .mockResolvedValue(response);
    const bound = withStalledCallRetry(
      presentationGateway(gateway(send), f.state(), () => {}),
      { deadline: Date.now() + 180_000, runtimeId: "display/cues" },
    );
    const pending = bound.generateText({ prompt: "public story" });
    await vi.advanceTimersByTimeAsync(90_001);
    expect(await pending).toEqual(response);
    expect(send).toHaveBeenCalledTimes(2);
    await expect(
      bound.generateText({ prompt: "another" }),
    ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
    expect(send).toHaveBeenCalledTimes(2);
    await f.store.close();
  });
  it("refuses paid work without durable storage and after incarnation changes", async () => {
    const f = await fixture();
    const budget = createPresentationBudget({
      sessionId: "session",
      snapshot: f.snapshot,
      currentLimits: { calls: 2, generations: 1 },
      assertLive: () => {},
    });
    await expect(budget.reserve()).rejects.toMatchObject({
      name: "PresentationUnavailable",
    });
    await f.store.updateSession("session", {
      metadata: { sessionIncarnationNonce: "reset" },
    });
    await expect(f.state().budget.reserve()).rejects.toMatchObject({
      name: "PresentationUnavailable",
    });
    await f.store.close();
  });
});
