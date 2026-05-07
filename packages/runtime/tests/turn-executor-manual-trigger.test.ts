/**
 * Manual-trigger single-runtime mode — the path exercised by
 * `POST /api/sessions/:id/plugin-rpc` when a body carries `{ runtimeId }`.
 *
 * Covers four distinct behaviours introduced in the plugin-rpc-runtime-pipeline
 * refactor:
 *
 * 1. `TurnInput.manualTrigger` bypasses the per-runtime `shouldTrigger` filter
 *    and the DAG scheduler — only the targeted runtime runs, regardless of
 *    its declared trigger type or priority band.
 * 2. The same path must not append a player message to the history store —
 *    manual clicks are not conversational turns and must not pollute
 *    `turnNumber` / `turnsSinceLastTrigger` for scheduled runtimes.
 * 3. `ctx.manualPayload` is forwarded only to the targeted runtime's handler,
 *    and only when that runtime is a function runtime; the payload never
 *    leaks to unrelated runtimes in the same turn.
 * 4. `output.events` from the targeted runtime schedule event-triggered
 *    followers (fan-out) in the same turn, in priority order — this is how
 *    e.g. dashscope-image-gen/prompt-generator kicks off image-generator
 *    without the caller issuing a second RPC.
 */

import { describe, it, expect } from "vitest";
import type { RuntimeManifest, TurnInput } from "@covel/shared";
import { createMemoryStore } from "@covel/store";
import type { DataStore } from "@covel/store";
import { executeTurn } from "../src/turn-executor.js";
import type { TurnExecutorDeps } from "../src/turn-executor.js";
import type { LLMAdapter, LLMResponse } from "../src/llm-adapter.js";
import type {
  FunctionHandlerContext,
  PluginRuntimeGateway,
} from "@covel/plugin-loader";

type MediaContext = NonNullable<FunctionHandlerContext["media"]>;

class NoopLLM implements LLMAdapter {
  async generate(): Promise<LLMResponse> {
    return {
      content: "{}",
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

async function mainLoopStore(sessionId: string): Promise<DataStore> {
  const store = createMemoryStore();
  // Seed one prior player message so turnNumber >= 1 (main-loop band).
  // The manual-trigger code path must not add another one.
  await store.appendTurnMessage({
    id: "seed",
    sessionId,
    turnId: "seed-turn",
    sourceType: "player",
    role: "user",
    content: "prior",
    order: 0,
    createdAt: "2024-01-01T00:00:00Z",
  });
  return store;
}

function fnManifest(
  name: string,
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0]!,
    description: name,
    priority: 500,
    runtimeType: "function",
    handler: "./h.js",
    trigger: { type: "auto" },
    ...overrides,
  } as RuntimeManifest;
}

type Handler = (
  ctx: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

async function runTurn(
  manifests: readonly RuntimeManifest[],
  handlers: Record<string, Handler>,
  turnInput: TurnInput,
  extraDeps: Partial<TurnExecutorDeps> = {},
): Promise<{
  result: Awaited<ReturnType<typeof executeTurn>>;
  store: DataStore;
  handlerCalls: Record<string, Array<Record<string, unknown>>>;
}> {
  const store = await mainLoopStore(turnInput.sessionId);
  const handlerCalls: Record<string, Array<Record<string, unknown>>> = {};
  const deps: TurnExecutorDeps = {
    loadRuntime: async (m) => ({
      manifest: m,
      promptTemplate: "",
      references: [],
      handler: async (ctx) => {
        const recorded = ctx as unknown as Record<string, unknown>;
        (handlerCalls[m.name] ??= []).push(recorded);
        return handlers[m.name]!(recorded);
      },
    }),
    llm: new NoopLLM(),
    getConfig: () => ({}),
    store,
    ...extraDeps,
  };
  const result = await executeTurn(turnInput, manifests, deps);
  return { result, store, handlerCalls };
}

describe("executeTurn: manual trigger", () => {
  it("runs only the targeted runtime and skips unrelated auto runtimes", async () => {
    const target = fnManifest("plug/target", { trigger: { type: "manual" } });
    const unrelated = fnManifest("plug/auto", { trigger: { type: "auto" } });

    const { result, handlerCalls } = await runTurn(
      [target, unrelated],
      {
        "plug/target": async () => ({ ok: true }),
        "plug/auto": async () => {
          throw new Error(
            "unrelated auto runtime should not fire during manual trigger",
          );
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/target" },
      },
    );

    expect(result.runtimeResults).toHaveLength(1);
    expect(result.runtimeResults[0]!.runtimeId).toBe("plug/target");
    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(handlerCalls["plug/auto"]).toBeUndefined();
  });

  it("does not append the player message to history when manualTrigger is set", async () => {
    const target = fnManifest("plug/target", { trigger: { type: "manual" } });

    const { store } = await runTurn(
      [target],
      { "plug/target": async () => ({ ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "this should NOT be appended",
        manualTrigger: { runtimeId: "plug/target" },
      },
    );

    const messages = await store.listTurnMessages("sess-1");
    // Only the seeded prior message remains — no new player row for this turn.
    expect(messages.filter((m) => m.sourceType === "player")).toHaveLength(1);
    expect(
      messages.some((m) => m.content === "this should NOT be appended"),
    ).toBe(false);
  });

  it("does not append manual runtime output to conversation history", async () => {
    const target = fnManifest("plug/target", { trigger: { type: "manual" } });

    const { store, result } = await runTurn(
      [target],
      { "plug/target": async () => ({ prompt: "image prompt", ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/target" },
      },
    );

    expect(result.runtimeResults).toHaveLength(1);
    const messages = await store.listTurnMessages("sess-1");
    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("seed");
  });

  it("forwards manualPayload only to the targeted function handler", async () => {
    const target = fnManifest("plug/target", { trigger: { type: "manual" } });
    const chained = fnManifest("plug/chained", {
      trigger: { type: "event", topic: "target.done" },
      priority: 510,
    });

    const { handlerCalls } = await runTurn(
      [target, chained],
      {
        "plug/target": async () => ({
          events: [{ topic: "target.done", data: { reason: "chain" } }],
        }),
        "plug/chained": async () => ({ ok: true }),
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: {
          runtimeId: "plug/target",
          payload: { clickedAt: "noon", selectedId: "npc-42" },
        },
      },
    );

    expect(handlerCalls["plug/target"]?.[0]?.manualPayload).toEqual({
      clickedAt: "noon",
      selectedId: "npc-42",
    });
    // Event-chained downstream must NOT inherit the manual payload — it ran
    // via event trigger, not via the click.
    expect(handlerCalls["plug/chained"]?.[0]?.manualPayload).toBeUndefined();
  });

  it("exposes deps.gateway to function handlers via ctx.gateway", async () => {
    const target = fnManifest("plug/needs-gateway", {
      trigger: { type: "manual" },
    });

    const fakeGateway: PluginRuntimeGateway = {
      generateText: async () => ({
        text: "hello",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      generateObject: async () => ({
        object: {} as unknown,
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      resolveSlot: () => ({
        presetId: "image",
        provider: "fake",
        protocol: "openai-chat-v1",
        baseUrl: "https://example.test/v1",
        apiKey: "fake-key",
        model: "fake-image-model",
        tag: "image",
        metadata: {},
      }),
    };

    let sawGateway: PluginRuntimeGateway | undefined;
    let resolvedBaseUrl: string | undefined;
    const { result } = await runTurn(
      [target],
      {
        "plug/needs-gateway": async (ctx) => {
          sawGateway = ctx.gateway as PluginRuntimeGateway | undefined;
          const slot = sawGateway!.resolveSlot({
            presetId: "image",
            fallbackTag: "image",
          });
          resolvedBaseUrl = slot?.baseUrl;
          return { ok: true, resolvedBaseUrl };
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/needs-gateway" },
      },
      { gateway: fakeGateway },
    );

    expect(sawGateway).toBe(fakeGateway);
    expect(resolvedBaseUrl).toBe("https://example.test/v1");
    expect(result.runtimeResults[0]!.status).toBe("success");
  });

  it("omits ctx.gateway when the executor was constructed without one", async () => {
    const target = fnManifest("plug/gateway-less", {
      trigger: { type: "manual" },
    });

    const { handlerCalls } = await runTurn(
      [target],
      { "plug/gateway-less": async () => ({ ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/gateway-less" },
      },
      // no gateway in extraDeps
    );

    expect("gateway" in (handlerCalls["plug/gateway-less"]?.[0] ?? {})).toBe(
      false,
    );
  });

  it("exposes deps.mediaStore to function handlers via ctx.media", async () => {
    const target = fnManifest("plug/needs-media", {
      trigger: { type: "manual" },
    });
    let sawMedia: MediaContext | undefined;

    const { result } = await runTurn(
      [target],
      {
        "plug/needs-media": async (ctx) => {
          sawMedia = ctx.media as MediaContext | undefined;
          const ref = await sawMedia!.put(
            new Uint8Array([1, 2, 3]),
            "application/octet-stream",
          );
          return { ok: true, mediaId: ref.id };
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/needs-media" },
      },
      {
        mediaStore: {
          async put(bytes, mime) {
            return {
              id: "media-1",
              mime,
              size: bytes instanceof Uint8Array ? bytes.byteLength : bytes.size,
            };
          },
          async get() {
            return new Uint8Array();
          },
          async resolveUrl() {
            return "https://media.example.test/media-1";
          },
          async recordOwnership() {
            /* no-op for this test */
          },
          async lookup(id) {
            return {
              id,
              mime: "application/octet-stream",
              size: 0,
              ownerSessionId: "sess-1",
              ownerPluginId: "plug",
            };
          },
          async addRef() {
            /* no-op for this test */
          },
          async isReferencedBy() {
            return true;
          },
        },
      },
    );

    expect(sawMedia).toBeDefined();
    expect(result.runtimeResults[0]!.output).toMatchObject({
      ok: true,
      mediaId: "media-1",
    });
  });

  it("exposes assetProgress to function handlers and emits asset.progress", async () => {
    const target = fnManifest("plug/progress", { trigger: { type: "manual" } });
    const emitted: Array<{ type: string; payload: Record<string, unknown> }> =
      [];

    const { result } = await runTurn(
      [target],
      {
        "plug/progress": async (ctx) => {
          const assetProgress =
            ctx.assetProgress as FunctionHandlerContext["assetProgress"];
          await assetProgress?.({
            assetId: "job-1",
            phase: "generating",
            percent: 50,
            modality: "image",
            message: "halfway",
          });
          return { ok: true };
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/progress" },
      },
      {
        emitter: {
          sessionId: "sess-1",
          turnId: "turn-1",
          async emit(type, payload) {
            emitted.push({ type, payload });
          },
        },
      },
    );

    expect(result.runtimeResults[0]!.status).toBe("success");
    expect(emitted).toEqual([
      {
        type: "asset.progress",
        payload: {
          sessionId: "sess-1",
          turnId: "turn-1",
          pluginId: "plug",
          runtimeId: "plug/progress",
          assetId: "job-1",
          phase: "generating",
          percent: 50,
          modality: "image",
          message: "halfway",
        },
      },
    ]);
  });

  // ── Audit F7: userSettings merging. ────────────────────────────────
  //
  // Function runtimes declare `userSettings: [{key, default, ...}]` in their
  // manifest. Server-side TurnInput carries the player-authored values
  // keyed by pluginId. The executor merges defaults with player overrides
  // so `ctx.userSettings[spec.key]` is always defined for every declared
  // key — handlers don't need to duplicate default logic.
  it("merges manifest userSettings defaults into ctx.userSettings and player values override", async () => {
    const target = fnManifest("plug/settings-consumer", {
      trigger: { type: "manual" },
      userSettings: [
        {
          key: "model",
          type: "select",
          default: "wan2.7-image-pro",
          label: "Model",
        },
        { key: "size", type: "select", default: "1024*1024", label: "Size" },
        { key: "quality", type: "number", default: 80, label: "Quality" },
      ],
    } as unknown as Partial<RuntimeManifest>);

    const { handlerCalls } = await runTurn(
      [target],
      { "plug/settings-consumer": async () => ({ ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/settings-consumer" },
        userSettings: {
          // Player has overridden `model` and `quality`; `size` should
          // fall back to the manifest default.
          plug: { model: "wan2.5-image-turbo", quality: 95 },
        },
      },
    );

    const ctx = handlerCalls["plug/settings-consumer"]?.[0];
    expect(ctx?.userSettings).toEqual({
      model: "wan2.5-image-turbo",
      size: "1024*1024",
      quality: 95,
    });
  });

  it("omits ctx.userSettings entirely when the manifest declares no userSettings", async () => {
    const target = fnManifest("plug/no-settings", {
      trigger: { type: "manual" },
    });

    const { handlerCalls } = await runTurn(
      [target],
      { "plug/no-settings": async () => ({ ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/no-settings" },
        // Player bucket exists for this pluginId but the manifest didn't
        // declare any userSettings — the executor must not leak the raw
        // bucket onto ctx (plugins could start reading undocumented keys).
        userSettings: { plug: { stray: "value" } },
      },
    );

    expect(
      "userSettings" in (handlerCalls["plug/no-settings"]?.[0] ?? {}),
    ).toBe(false);
  });

  it("scopes ctx.userSettings to the runtime's own pluginId", async () => {
    const target = fnManifest("plug-a/target", {
      trigger: { type: "manual" },
      userSettings: [
        { key: "theme", type: "select", default: "light", label: "Theme" },
      ],
    } as unknown as Partial<RuntimeManifest>);

    const { handlerCalls } = await runTurn(
      [target],
      { "plug-a/target": async () => ({ ok: true }) },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug-a/target" },
        userSettings: {
          "plug-a": { theme: "dark" },
          "plug-b": { theme: "neon" }, // must not leak
        },
      },
    );

    expect(handlerCalls["plug-a/target"]?.[0]?.userSettings).toEqual({
      theme: "dark",
    });
  });

  it("schedules event-triggered followers in the same turn after the manual runtime emits", async () => {
    const target = fnManifest("plug/target", {
      trigger: { type: "manual" },
      priority: 600,
    });
    const follower = fnManifest("plug/follower", {
      trigger: { type: "event", topic: "image.prompt.ready" },
      priority: 610,
    });
    const unrelatedEvent = fnManifest("plug/other-event", {
      trigger: { type: "event", topic: "something.else" },
      priority: 620,
    });

    const { result, handlerCalls } = await runTurn(
      [target, follower, unrelatedEvent],
      {
        "plug/target": async () => ({
          prompt: "sunset",
          events: [{ topic: "image.prompt.ready", data: { prompt: "sunset" } }],
        }),
        "plug/follower": async () => ({ ok: true }),
        "plug/other-event": async () => {
          throw new Error("unsubscribed event runtime should not fire");
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/target" },
      },
    );

    const names = result.runtimeResults.map((r) => r.runtimeId);
    expect(names).toContain("plug/target");
    expect(names).toContain("plug/follower");
    expect(names).not.toContain("plug/other-event");

    // Follower's handler should have seen the event payload via ctx.triggerEvent.
    const followerCtx = handlerCalls["plug/follower"]?.[0];
    const triggerEvent = followerCtx?.triggerEvent as
      | { topic?: string; data?: { prompt?: string } }
      | undefined;
    expect(triggerEvent?.topic).toBe("image.prompt.ready");
    expect(triggerEvent?.data?.prompt).toBe("sunset");
  });

  it("aborts cleanly when the manualTrigger.runtimeId is not in the active set", async () => {
    const unrelated = fnManifest("plug/unrelated", {
      trigger: { type: "auto" },
    });

    const { result, handlerCalls } = await runTurn(
      [unrelated],
      {
        "plug/unrelated": async () => {
          throw new Error(
            "no auto runtime should run when manual target is unknown",
          );
        },
      },
      {
        sessionId: "sess-1",
        turnId: "turn-1",
        playerMessage: "",
        manualTrigger: { runtimeId: "plug/does-not-exist" },
      },
    );

    expect(result.runtimeResults).toHaveLength(0);
    expect(result.abortReason ?? "").toMatch(/manual-trigger/i);
    expect(handlerCalls["plug/unrelated"]).toBeUndefined();
  });
});
