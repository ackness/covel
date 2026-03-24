import { describe, expect, it } from "vitest";

import {
  createModelProfileRegistry,
  type ModelProfile,
  type PresetMetadata
} from "../src/index.js";

const runtimeProfiles: ModelProfile[] = [
  {
    id: "small",
    tier: "small",
    provider: "openaiCompatible",
    model: "qwen-small",
    contextWindow: 32_000,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "medium",
    tier: "medium",
    provider: "openaiCompatible",
    model: "qwen-medium",
    contextWindow: 64_000,
    latencyClass: "medium",
    costClass: "medium",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "large",
    tier: "large",
    provider: "openaiCompatible",
    model: "qwen-large",
    contextWindow: 128_000,
    latencyClass: "high",
    costClass: "high",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "embed-default",
    tier: "embed-default",
    provider: "openaiCompatible",
    model: "text-embedding-3-small",
    contextWindow: 8_000,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["embed"]
  }
];

const runtimePreset: PresetMetadata = {
  id: "story-default",
  name: "Story default",
  provider: "openaiCompatible",
  protocol: "openai-chat-v1",
  model: "qwen-medium",
  tier: "medium",
  baseUrl: "https://runtime.example/v1",
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  scope: "global"
};

describe("ModelProfileRegistry", () => {
  it("exposes the required runtime default profiles", () => {
    const registry = createModelProfileRegistry({
      runtimeProfiles
    });

    expect(registry.list().map((profile) => profile.id)).toEqual([
      "small",
      "medium",
      "large",
      "embed-default"
    ]);
  });

  it("resolves preset/profile metadata with runtime, database, project, session precedence", () => {
    const registry = createModelProfileRegistry({
      runtimeProfiles,
      runtimePresets: [runtimePreset],
      persistedProfiles: [
        {
          ...runtimeProfiles[1],
          model: "db-medium"
        }
      ],
      persistedPresets: [
        {
          ...runtimePreset,
          model: "db-medium",
          baseUrl: "https://db.example/v1"
        }
      ]
    });

    const resolved = registry.resolveTextTarget({
      presetId: "story-default",
      projectOverride: {
        preset: {
          model: "project-medium",
          baseUrl: "https://project.example/v1"
        }
      },
      sessionOverride: {
        profile: {
          id: "medium",
          model: "session-medium"
        }
      }
    });

    expect(resolved.profile).toMatchObject({
      id: "medium",
      model: "session-medium",
      provider: "openaiCompatible"
    });
    expect(resolved.preset).toMatchObject({
      id: "story-default",
      protocol: "openai-chat-v1",
      model: "project-medium",
      baseUrl: "https://project.example/v1"
    });
  });

  it("routes embed requests to embed-default regardless of text preset", () => {
    const registry = createModelProfileRegistry({
      runtimeProfiles,
      runtimePresets: [runtimePreset]
    });

    const resolved = registry.resolveEmbeddingTarget({
      presetId: "story-default"
    });

    expect(resolved.profile).toMatchObject({
      id: "embed-default",
      model: "text-embedding-3-small",
      supportedModes: ["embed"]
    });
    expect(resolved.preset).toBeNull();
  });

  it("rejects disabled presets", () => {
    const registry = createModelProfileRegistry({
      runtimeProfiles,
      runtimePresets: [
        {
          ...runtimePreset,
          id: "disabled",
          enabled: false
        }
      ]
    });

    expect(() => registry.resolveTextTarget({ presetId: "disabled" })).toThrowError(
      "Model profile registry error: preset \"disabled\" is disabled."
    );
  });

  it("supports protocol overrides through persisted presets", () => {
    const registry = createModelProfileRegistry({
      runtimeProfiles,
      runtimePresets: [runtimePreset],
      persistedPresets: [
        {
          ...runtimePreset,
          protocol: "openai-responses-v1"
        }
      ]
    });

    const resolved = registry.resolveTextTarget({
      presetId: "story-default"
    });

    expect(resolved.preset).toMatchObject({
      protocol: "openai-responses-v1"
    });
  });
});
