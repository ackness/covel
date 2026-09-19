import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applySlotOverlay,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  type ModelProviderAdapter,
  type PresetConfig,
} from "@covel/ai-provider";
import { createPluginRegistry } from "@covel/plugin-loader";
import { createMemoryStore } from "@covel/store";
import { createMiscApiRoutes } from "../../src/routes/misc-api.js";

function setup(options: { failModel?: string } = {}) {
  const requests: Array<{ model: string; metadata?: Record<string, unknown> }> =
    [];
  const adapter = {
    async *streamText(_config, params) {
      requests.push({
        model: params.model,
        metadata: params.providerRequestMetadata,
      });
      if (params.model === options.failModel)
        throw new Error("Synthetic selected model failure");
      yield { type: "text-delta", textDelta: "ok" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  } satisfies Partial<ModelProviderAdapter>;
  const preset: PresetConfig = {
    id: "slot-story",
    name: "Story",
    provider: "fixture",
    model: "configured-model",
    tier: "medium",
    enabled: true,
    supportedModes: ["text", "stream"],
    capability: { contextWindow: 65_536, maxOutputTokens: 32_768 },
    providerRequestMetadata: {
      privateFlag: "do-not-expose",
      parameterOverrides: {
        maxOutputTokens: 4096,
        temperature: 0.2,
        apiKey: "do-not-expose",
      },
    },
  };
  const config = { providers: {}, profiles: [], presets: [preset] };
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: {
        adapter,
        defaults: {
          baseUrl: "https://fixture.invalid",
          protocol: "openai-chat-v1",
        },
      },
    },
  });
  const presetRegistry = createPresetRegistry(config);
  const slotRegistry = createSlotRegistry({ presetRegistry });
  slotRegistry.configure({
    slots: { story: { slotId: "story", presetId: preset.id, tag: "text" } },
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry,
    slotRegistry,
  });
  const app = createMiscApiRoutes(
    {
      config,
      providerRegistry,
      presetRegistry,
      slotRegistry,
      gateway,
      llmConfig: null,
      modelDb: null,
    },
    createPluginRegistry(),
    createMemoryStore(),
  );
  return { app, requests, presetRegistry, slotRegistry };
}

afterEach(() => vi.unstubAllEnvs());

describe("explicit ping model identity", () => {
  it.each([{ presetId: "slot-story" }, { slot: "story" }])(
    "reports the selected target's failure without probing its fallback for %j",
    async (target) => {
      const { app, requests, presetRegistry } = setup({
        failModel: "configured-model",
      });
      const primary = presetRegistry.resolvePreset("slot-story")!;
      presetRegistry.addPreset({
        ...primary,
        fallbackPresetIds: ["slot-backup"],
      });
      presetRegistry.addPreset({
        ...primary,
        id: "slot-backup",
        model: "working-backup",
      });
      const response = await app.request("/api/ai/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      expect(await response.json()).toMatchObject({
        ok: false,
        testedTarget: { model: "configured-model" },
      });
      expect(requests.map(({ model }) => model)).toEqual(["configured-model"]);
    },
  );

  it("pins a server slot that shares another preset's ID while retaining its parameters", async () => {
    const { app, requests, presetRegistry, slotRegistry } = setup();
    presetRegistry.addPreset({
      ...presetRegistry.resolvePreset("slot-story")!,
      id: "slot-slot-story",
      model: "selected-role-model",
    });
    slotRegistry.configure({
      slots: {
        ...slotRegistry.listSlots(),
        "slot-story": {
          slotId: "slot-story",
          presetId: "slot-slot-story",
          tag: "text",
        },
      },
    });
    const response = await app.request("/api/ai/ping", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slot-Config": Buffer.from(
          JSON.stringify({
            parameterOverrides: {
              "slot-story": { temperature: 0.7, maxOutputTokens: 19 },
            },
          }),
        ).toString("base64"),
      },
      body: JSON.stringify({ slot: "slot-story" }),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      testedTarget: { model: "selected-role-model", resolvedVia: "slot" },
    });
    expect(requests).toMatchObject([
      {
        model: "selected-role-model",
        metadata: {
          parameterOverrides: { temperature: 0.7, maxOutputTokens: 19 },
        },
      },
    ]);
    expect(requests).toHaveLength(1);
  });

  it.each(["tag-fallback", "any"])(
    "pins the %s target and preserves the requested slot's parameters",
    async (resolvedVia) => {
      const { app, requests, presetRegistry, slotRegistry } = setup();
      presetRegistry.addPreset({
        ...presetRegistry.resolvePreset("slot-story")!,
        id: "unconfigured",
        model: "same-named-preset",
      });
      if (resolvedVia === "any") slotRegistry.configure({ slots: {} });
      const response = await app.request("/api/ai/ping", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slot-Config": Buffer.from(
            JSON.stringify({
              parameterOverrides: { unconfigured: { maxOutputTokens: 23 } },
            }),
          ).toString("base64"),
        },
        body: JSON.stringify({ slot: "unconfigured" }),
      });
      expect(await response.json()).toMatchObject({
        ok: true,
        testedTarget: { model: "configured-model", resolvedVia },
      });
      expect(requests).toMatchObject([
        {
          model: "configured-model",
          metadata: { parameterOverrides: { maxOutputTokens: 23 } },
        },
      ]);
      expect(requests).toHaveLength(1);
    },
  );

  it.each([
    "{",
    JSON.stringify({ modelREF: "missing" }),
    JSON.stringify({ presetId: "slot-story", unexpected: true }),
  ])(
    "rejects malformed ping input without probing a model: %s",
    async (body) => {
      const { app, requests } = setup();
      const response = await app.request("/api/ai/ping", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(400);
      expect(requests).toEqual([]);
    },
  );

  it("retains the default probe for a valid empty object", async () => {
    const { app, requests } = setup();
    const response = await app.request("/api/ai/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      testedTarget: { model: "configured-model" },
    });
    expect(requests.map(({ model }) => model)).toEqual(["configured-model"]);
  });

  it.each([{ slot: "story" }, { modelRef: "slot-story" }])(
    "probes the selected local model for %j even with a same-named server preset",
    async (target) => {
      const { app, requests } = setup();
      const slotConfig = {
        slotBindings: { story: { modelRef: "slot-story" } },
        customPresets: [
          {
            id: "slot-story",
            name: "Local",
            provider: "fixture",
            model: "local-model",
          },
        ],
      };
      const response = await app.request("/api/ai/ping", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Slot-Config": Buffer.from(JSON.stringify(slotConfig)).toString(
            "base64",
          ),
        },
        body: JSON.stringify(target),
      });
      expect(await response.json()).toMatchObject({
        ok: true,
        testedTarget: { model: "local-model" },
      });
      expect(requests.map(({ model }) => model)).toEqual(["local-model"]);
    },
  );
});

describe("LLM settings and connectivity", () => {
  it("publishes explicit limits and recognized parameter defaults without private metadata", async () => {
    const { app } = setup();
    const presets = await (await app.request("/api/presets")).json();
    const config = await (await app.request("/api/llm-config")).json();
    for (const item of [presets.items[0], config.slots.story]) {
      expect(item.capability).toMatchObject({
        contextWindow: 65_536,
        maxOutputTokens: 32_768,
      });
      expect(item.parameterOverrides).toEqual({
        maxOutputTokens: 4096,
        temperature: 0.2,
      });
      expect(JSON.stringify(item)).not.toContain("do-not-expose");
    }
  });

  it("pings the selected role with its own model, output and capability overrides", async () => {
    vi.stubEnv("DEPLOYMENT_TIER", "self");
    const { app, requests } = setup();
    const slotConfig = {
      slotBindings: { story: { modelRef: "custom-model" } },
      customPresets: [
        {
          id: "custom-model",
          provider: "fixture",
          model: "selected-model",
          baseUrl: "https://fixture.invalid",
          protocol: "openai-chat-v1",
        },
      ],
      parameterOverrides: {
        story: { maxOutputTokens: 12_000, temperature: 0.3 },
      },
      capabilityOverrides: {
        story: { contextWindow: 65_536, maxOutputTokens: 8192 },
      },
    };
    const response = await app.request("/api/ai/ping", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Slot-Config": Buffer.from(JSON.stringify(slotConfig)).toString(
          "base64",
        ),
      },
      body: JSON.stringify({ slot: "story" }),
    });
    expect(await response.json()).toMatchObject({
      ok: true,
      testedTarget: { model: "selected-model", resolvedVia: "slot" },
    });
    expect(requests).toEqual([
      {
        model: "selected-model",
        metadata: {
          parameterOverrides: { maxOutputTokens: 8192, temperature: 0.3 },
        },
      },
    ]);
  });
});

it("does not publish another request's transient model configuration", async () => {
  const { app, presetRegistry } = setup();
  const cleanup = applySlotOverlay(
    { presetRegistry },
    {
      customPresets: [
        {
          id: "private-ref",
          name: "Private request",
          provider: "private-provider",
          model: "private-model",
        },
      ],
    },
  );
  try {
    const presets = await (await app.request("/api/presets")).json();
    const config = await (await app.request("/api/llm-config")).json();
    expect(presets.items).toHaveLength(1);
    expect(JSON.stringify({ presets, config })).not.toContain(
      "private-provider",
    );
    expect(JSON.stringify({ presets, config })).not.toContain("private-model");
  } finally {
    cleanup();
  }
});

it("does not reinterpret an explicit server preset as a same-named overridden slot", async () => {
  const { app, requests } = setup();
  const response = await app.request("/api/ai/ping", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Slot-Config": Buffer.from(
        JSON.stringify({
          slotBindings: { "slot-story": { modelRef: "local-ref" } },
          customPresets: [
            { id: "local-ref", provider: "fixture", model: "local-model" },
          ],
        }),
      ).toString("base64"),
    },
    body: JSON.stringify({ presetId: "slot-story" }),
  });
  expect(await response.json()).toMatchObject({
    ok: true,
    testedTarget: { model: "configured-model" },
  });
  expect(requests.map(({ model }) => model)).toEqual(["configured-model"]);
});

it.each([
  { modelRef: "missing" },
  { presetId: "missing" },
  { presetId: "slot-missing" },
])(
  "does not substitute another model when an explicit ping target is unavailable: %j",
  async (target) => {
    const { app, requests } = setup();
    const response = await app.request("/api/ai/ping", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(target),
    });
    expect(await response.json()).toMatchObject({ ok: false });
    expect(requests).toEqual([]);
  },
);
