import { describe, expect, it, vi } from "vitest";
import { executeTurn } from "../src/execution.js";
import { createMemoryMediaStore } from "@covel/store/memory";
import {
  takePresentationSnapshot,
  projectPresentationStory,
} from "../src/presentation/projection.js";
import type {
  FunctionHandlerContext,
  PluginRuntimeGateway,
} from "@covel/shared/plugin-runtime";
import { createRuntimeImagesContext } from "../src/function-runtime/runtime-images-context.js";
import { createRuntimeMediaWriter } from "../src/function-runtime/runtime-media-context.js";
import { runTurnPipeline } from "../src/turn-executor/turn-executor.js";
import {
  input,
  detachedInput,
  narrator,
  presenter,
  setup,
  story,
} from "./presentation-fixture.js";

describe("restricted presentation context", () => {
  it("refuses a captured presentation source after its target removes the policy", async () => {
    const f = await setup();
    const manifest = presenter({
      turnCompletion: { mode: "detached" },
      presentation: { budget: { calls: 1 }, publicAssetNamespaces: ["assets"] },
    });
    const snapshot = {
      ...(await takePresentationSnapshot({
        store: f.store,
        manifest,
        sessionId: "session",
        sourceTurnId: "source",
        sourceExecutionId: "execution",
        story: {
          segments: [{ kind: "narration" as const, text: "Public source" }],
        },
      })),
      committed: true,
    };
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const admitted = await f.run(
      handler,
      manifest,
      {},
      detachedInput(manifest, snapshot),
    );
    expect(admitted.result.runtimeResults[0]?.status).toBe("success");
    expect(handler).toHaveBeenCalledOnce();
    expect((await f.commit(admitted)).status).toBe("committed");
    handler.mockClear();
    const ordinary = { ...manifest, presentation: undefined };
    const refused = await f.run(
      handler,
      ordinary,
      {},
      detachedInput(ordinary, snapshot),
    );
    expect(refused.result.runtimeResults[0]?.status).toBe("skipped");
    expect(handler).not.toHaveBeenCalled();
    await f.store.close();
  });
  it.each([false, true])(
    "reuses a generation cache only when its asset is public and reachable (reachable=%s)",
    async (reachable) => {
      const f = await setup();
      const media = createMemoryMediaStore();
      const target = {
        provider: "fixture",
        model: "image",
        protocol: "openai-chat-v1" as const,
        metadata: {},
      };
      const generateImage = vi.fn(async () => ({
        target,
        images: [
          {
            kind: "bytes" as const,
            bytes: new Uint8Array([1, 2]),
            mime: "image/png",
          },
        ],
        warnings: [],
      }));
      const gateway: PluginRuntimeGateway = {
        generateImage,
        resolveSlot: () => ({ ...target, presetId: "image", tag: "image" }),
        generateText: async () => {
          throw new Error("Unexpected text dispatch");
        },
        generateObject: async () => {
          throw new Error("Unexpected object dispatch");
        },
      };
      const mediaOptions = { sessionId: "session", pluginId: "display" };
      const ordinary = createRuntimeImagesContext(
        { generateImage, resolveSlot: gateway.resolveSlot },
        media,
        createRuntimeMediaWriter(media, undefined, mediaOptions),
        mediaOptions,
      );
      const cached = await ordinary.generate({ prompt: "Public library art" });
      expect(cached.cached).toBe(false);
      await f.seed(reachable ? "assets" : "_hidden.assets", "cached", {
        ref: cached.refs[0]!,
      });
      generateImage.mockClear();
      const manifest = presenter({
        effects: {
          reads: [
            "plugin-data:self:assets",
            "plugin-data:self:display",
            "media:*",
          ],
          writes: ["plugin-data:self:display", "media:*"],
        },
      });
      const execution = await f.run(
        async (ctx) => {
          const generated = await ctx.images!.generate({
            prompt: "Public library art",
          });
          expect(generated.cached).toBe(true);
          await ctx.pluginData!.set("display", "current", {
            art: generated.refs[0]!,
          });
          return { outcome: "success", value: {} };
        },
        manifest,
        { gateway, mediaStore: media },
      );
      expect(
        execution.result.runtimeResults.find(
          (result) => result.runtimeId === manifest.name,
        )?.status,
      ).toBe(reachable ? "success" : "skipped");
      expect((await f.commit(execution, { mediaStore: media })).status).toBe(
        "committed",
      );
      expect(
        (
          await f.store.getPluginData(
            "session",
            "display",
            "display",
            "current",
          )
        )?.value ?? null,
      ).toEqual(reachable ? { art: cached.refs[0]! } : null);
      expect(generateImage).not.toHaveBeenCalled();
      expect(
        (await f.store.listTraceEvents("session")).find(
          (row) => row.type === "presentation.completed",
        )?.payload,
      ).toMatchObject(
        reachable
          ? { status: "updated", budget: { calls: { used: 0 } } }
          : { status: "no-op", reason: "budget-exhausted" },
      );
      await f.store.close();
    },
  );
  it("does not admit a hand-built agent presentation through delegation", async () => {
    const f = await setup();
    const child = {
      ...presenter(),
      name: "display/unsafe-agent",
      runtimeType: "agent" as const,
      handler: undefined,
      subagentOnly: true as const,
      stage: undefined,
      trigger: { type: "manual" as const },
    };
    const caller = {
      ...presenter(),
      name: "display/caller",
      presentation: undefined,
      inputs: undefined,
    };
    const generate = vi.fn(async () => {
      throw new Error("Presentation agent reached the model");
    });
    const result = await executeTurn(
      input,
      [narrator, caller, child],
      f.deps(
        {
          [caller.name]: async (ctx) => {
            const answer = await ctx.agents!.run({
              target: { runtimeId: child.name },
              brief: "Public scene",
            });
            expect(answer).toMatchObject({
              ok: false,
              error: { code: "not-found" },
            });
            return { outcome: "success", value: {} };
          },
        },
        { llm: { generate } },
      ),
    );
    expect((await f.commit(result)).status).toBe("committed");
    expect(
      result.result.runtimeResults.find((row) => row.runtimeId === caller.name)
        ?.status,
    ).toBe("success");
    expect(generate).not.toHaveBeenCalled();
    await f.store.close();
  });
  it.each([0, 2])(
    "leaves the optional story absent with %s public providers",
    async (count) => {
      const f = await setup();
      const seen = vi.fn(async (ctx: FunctionHandlerContext) => {
        expect(ctx.inputs?.story).toBeUndefined();
        expect(ctx.presentation?.characters).toEqual([]);
        return { outcome: "success" as const, value: {} };
      });
      const producers = count
        ? [
            narrator,
            { ...narrator, name: "other-story", pluginId: "other-story" },
          ]
        : [];
      const result = await executeTurn(
        input,
        [...producers, presenter()],
        f.deps({ "display/cues": seen }),
      );
      expect(seen).toHaveBeenCalledOnce();
      expect((await f.commit(result)).status).toBe("committed");
      expect(
        (await f.store.listTraceEvents("session")).find(
          (row) => row.type === "presentation.completed",
        )?.payload,
      ).toMatchObject({ status: "no-op", reason: "no-story" });
      await f.store.close();
    },
  );
  it("scopes media reads, blocks raw writers and revokes retained gateway and media handles", async () => {
    const f = await setup();
    const media = createMemoryMediaStore();
    const allowed = await media.put(new Uint8Array([1]), "image/png");
    const otherOwn = await media.put(new Uint8Array([2]), "image/png");
    const foreign = await media.put(new Uint8Array([3]), "image/png");
    await media.claimAssets([
      { id: allowed.id, sessionId: "session" },
      { id: otherOwn.id, sessionId: "session" },
      { id: foreign.id, sessionId: "other-session" },
    ]);
    await f.seed("assets", "allowed", { ref: allowed });
    await f.seed("assets", "foreign", { ref: foreign });
    const read = vi.spyOn(media, "get");
    const put = vi.spyOn(media, "put");
    const fetch = vi.fn(async () => new Response("private"));
    const send = vi.fn(async () => ({
      text: "unexpected",
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    let retained: FunctionHandlerContext | undefined;
    const manifest = presenter({
      effects: {
        reads: [
          "plugin-data:self:assets",
          "plugin-data:self:display",
          "media:*",
        ],
        writes: ["plugin-data:self:display", "media:*"],
      },
    });
    const result = await f.run(
      async (ctx) => {
        retained = ctx;
        expect(await ctx.media!.get(allowed)).toEqual(new Uint8Array([1]));
        await expect(ctx.media!.get(otherOwn)).rejects.toThrow(/unavailable/);
        await expect(ctx.media!.get(foreign)).rejects.toThrow(/not accessible/);
        expect(() => ctx.media!.put(new Uint8Array([4]), "image/png")).toThrow(
          /unavailable/,
        );
        expect(() =>
          ctx.media!.ingestUrl("https://example.test/private"),
        ).toThrow(/unavailable/);
        expect(ctx.utils).toBeUndefined();
        expect(ctx.gateway!.evaluate).toBeUndefined();
        expect(ctx.gateway!.transcribeAudio).toBeUndefined();
        return { outcome: "success", value: {} };
      },
      manifest,
      {
        mediaStore: media,
        utils: { validateBaseUrl: () => ({ ok: true }), fetchWithRetry: fetch },
        gateway: {
          generateText: send,
          generateObject: async <T>() => ({
            object: {} as T,
            finishReason: "stop",
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
          resolveSlot: () => null,
        },
      },
    );
    expect((await f.commit(result, { mediaStore: media })).status).toBe(
      "committed",
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(() => retained!.media!.get(allowed)).toThrow(/revoked/);
    expect(() => retained!.gateway!.generateText({ prompt: "late" })).toThrow(
      /revoked/,
    );
    expect(send).not.toHaveBeenCalled();
    await f.store.close();
  });
  it("revokes capabilities after an own deadline and keeps timeout provenance", async () => {
    const f = await setup();
    const started = Promise.withResolvers<void>();
    let retained: FunctionHandlerContext | undefined;
    vi.useFakeTimers();
    try {
      const pending = f.run(
        async (ctx) => {
          retained = ctx;
          started.resolve();
          await new Promise(() => {});
          return { outcome: "success", value: {} };
        },
        presenter({ timeoutMs: 10 }),
      );
      await started.promise;
      await vi.advanceTimersByTimeAsync(11);
      const result = await pending;
      expect(
        result.result.runtimeResults.find(
          (row) => row.runtimeId === "display/cues",
        ),
      ).toMatchObject({ status: "failed", fault: "timeout" });
      expect(() => retained!.pluginData!.set("display", "late", true)).toThrow(
        /revoked/,
      );
      expect((await f.commit(result)).status).toBe("committed");
      expect(
        await f.store.listPluginData("session", "display", "display"),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      await f.store.close();
    }
  });
  it.each([false, null, { budget: { calls: -1 } }, { surprise: true }])(
    "refuses malformed hand-built policy %j before handler entry",
    async (presentation) => {
      const f = await setup();
      const handler = vi.fn(async () => ({
        outcome: "success" as const,
        value: {},
      }));
      const manifest = {
        ...presenter(),
        presentation,
      } as unknown as ReturnType<typeof presenter>;
      const result = await f.run(handler, manifest);
      expect(handler).not.toHaveBeenCalled();
      expect(
        result.result.runtimeResults.find(
          (row) => row.runtimeId === manifest.name,
        )?.status,
      ).toBe("skipped");
      expect((await f.commit(result)).status).toBe("committed");
      await f.store.close();
    },
  );
  it("projects public story and own assets without private context or retained capabilities", async () => {
    const f = await setup();
    let captured: FunctionHandlerContext | undefined;
    const execution = await f.run(async (ctx) => {
      captured = ctx;
      expect(
        ctx.inputs?.story?.cardinality === "one"
          ? ctx.inputs.story.value
          : undefined,
      ).toEqual(story);
      expect(ctx.presentation?.characters).toEqual([
        { id: "mira", name: "Mira", aliases: ["M"] },
      ]);
      expect(await ctx.pluginData!.get("assets", "library")).toEqual({
        label: "Public library art",
      });
      for (const namespace of [
        "_hidden.assets",
        "forbidden",
        "_presentation_budget",
      ]) {
        await expect(
          ctx.pluginData!.get(namespace, "private"),
        ).rejects.toThrow();
        await expect(
          ctx.store!.getPluginData(namespace, "private"),
        ).rejects.toThrow();
        await expect(
          ctx.pluginData!.set(namespace, "private", true),
        ).rejects.toThrow();
      }
      await expect(
        ctx.pluginData!.list(undefined as unknown as string),
      ).rejects.toThrow();
      for (const method of [
        () => ctx.historyFor({} as never),
        () => ctx.store!.getSession(),
        () => ctx.tools!.call("forged", {}),
        () => ctx.agents!.run({} as never),
        () => ctx.recursiveCall({}),
      ])
        expect(method).toThrow(/unavailable/);
      expect(ctx.world).toBeUndefined();
      expect(ctx.services).toBeUndefined();
      expect(ctx.exports).toBeUndefined();
      expect(ctx.playerMessage).toBe("");
      expect(ctx.playerActions).toEqual([]);
      await ctx.pluginData!.set("display", "current", { scene: "Library" });
      return { outcome: "success", value: {} };
    });
    expect(
      execution.result.runtimeResults.find(
        (row) => row.runtimeId === "display/cues",
      )?.status,
    ).toBe("success");
    expect((await f.commit(execution)).status).toBe("committed");
    expect(
      (await f.store.getPluginData("session", "display", "display", "current"))
        ?.value,
    ).toEqual({ scene: "Library" });
    expect(() => captured!.presentation!.note("no-output")).toThrow(/revoked/);
    await f.store.close();
  });
  it("keeps the direct pipeline restricted and revokes retained handles", async () => {
    const f = await setup();
    let context: FunctionHandlerContext | undefined;
    const result = await runTurnPipeline(
      input,
      [narrator, presenter()],
      f.deps({
        [narrator.name]: async () => ({
          outcome: "success",
          value: {
            ...story,
            private: "private-extra",
            toolCalls: [{ secret: "private-tool" }],
          },
        }),
        "display/cues": async (ctx) => {
          context = ctx;
          expect(
            ctx.inputs?.story?.cardinality === "one"
              ? ctx.inputs.story.value
              : undefined,
          ).toEqual(story);
          expect(JSON.stringify(ctx)).not.toContain("private-");
          expect(await ctx.pluginData!.get("assets", "library")).toEqual({
            label: "Public library art",
          });
          await expect(
            ctx.pluginData!.get("forbidden", "private"),
          ).rejects.toThrow();
          expect(() => ctx.tools!.call("forged", {})).toThrow();
          expect(() => ctx.store!.getSession()).toThrow();
          expect(ctx.world).toBeUndefined();
          expect(ctx.services).toBeUndefined();
          return { outcome: "success", value: {} };
        },
      }),
    );
    const presented = result.runtimeResults.find(
      (row) => row.runtimeId === "display/cues",
    );
    expect(presented?.error).toBeUndefined();
    expect(presented?.status).toBe("success");
    expect(() => context!.presentation!.note("no-output")).toThrow(/revoked/);
    expect(() => context!.pluginData!.get("assets", "library")).toThrow(
      /revoked/,
    );
    await f.store.close();
  });
  it("excludes concealed and non-story producers, extra fields, private actions and history", async () => {
    const f = await setup();
    const secret = "PRIVATE-CONTENT-SENTINEL";
    const hidden = {
      ...narrator,
      name: "hidden",
      pluginId: "hidden",
      concealed: true,
    };
    const business = {
      ...narrator,
      name: "business",
      pluginId: "business",
      outputKind: "system" as const,
    };
    const handler = vi.fn(async (ctx: FunctionHandlerContext) => {
      expect(JSON.stringify(ctx)).not.toContain(secret);
      expect(
        ctx.inputs?.story?.cardinality === "one" && ctx.inputs.story.value,
      ).toEqual(story);
      expect(await ctx.pluginData!.get("assets", "library")).toEqual({
        label: "Public library art",
      });
      expect(Object.keys(ctx.gateway ?? {})).not.toContain("evaluate");
      await expect(
        ctx.gateway!.generateText({ prompt: "Public library story" }),
      ).rejects.toMatchObject({ name: "PresentationBudgetExhausted" });
      await ctx.pluginData!.set("display", "current", {
        title: "Public library art",
      });
      return { outcome: "success" as const, value: {} };
    });
    const send = vi.fn(async () => ({
      text: secret,
      finishReason: "stop" as const,
      usage: { inputTokens: 0, outputTokens: 0 },
    }));
    const result = await executeTurn(
      {
        ...input,
        playerMessage: secret,
        actions: [
          { kind: "direct", text: secret, seatId: "main", source: "player" },
        ],
      },
      [hidden, business, narrator, presenter()],
      f.deps(
        {
          hidden: async () => ({
            outcome: "success",
            value: {
              ...story,
              segments: [{ kind: "narration", text: secret }],
            },
          }),
          business: async () => ({
            outcome: "success",
            value: { ...story, private: secret },
          }),
          story: async () => ({
            outcome: "success",
            value: {
              ...story,
              private: secret,
              reasoning: secret,
              continuation: { raw: secret },
            },
          }),
          "display/cues": handler,
        },
        {
          gateway: {
            generateText: send,
            generateObject: async <T>() => ({
              object: {} as T,
              finishReason: "stop",
              usage: { inputTokens: 0, outputTokens: 0 },
            }),
            resolveSlot: () => null,
          },
        },
      ),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    expect((await f.commit(result)).status).toBe("committed");
    expect(
      JSON.stringify(
        await f.store.listPluginData("session", "display", "display"),
      ),
    ).not.toContain(secret);
    await f.store.close();
  });
  it("preserves every exact ambiguity match and bounds inline materialization", async () => {
    const f = await setup();
    await f.store.upsertCharacter({
      id: "other",
      name: "Other",
      aliases: ["M"],
      sessionId: "session",
      type: "npc",
      fields: {},
      version: 1,
      createdAt: "2026-10-31",
      updatedAt: "2026-10-31",
    });
    const snapshot = await takePresentationSnapshot({
      store: f.store,
      manifest: presenter(),
      sessionId: "session",
      sourceTurnId: "source",
      sourceExecutionId: "execution",
      story: { segments: [{ kind: "dialogue", speaker: "M", text: "Hello" }] },
    });
    expect(snapshot.characters.map(({ id }) => id)).toEqual(
      expect.arrayContaining(["mira", "other"]),
    );
    expect(Object.isFrozen(snapshot.characters)).toBe(true);
    expect(projectPresentationStory({ ...story, private: "secret" })).toEqual(
      story,
    );
    await f.seed("assets", "large", "a".repeat(256 * 1024));
    const handler = vi.fn(async () => ({
      outcome: "success" as const,
      value: {},
    }));
    const result = await f.run(handler);
    expect(handler).not.toHaveBeenCalled();
    expect(
      result.result.runtimeResults.find(
        (row) => row.runtimeId === "display/cues",
      )?.status,
    ).toBe("skipped");
    expect((await f.commit(result)).status).toBe("committed");
    await f.store.close();
  });
});
