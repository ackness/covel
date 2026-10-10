import { describe, it, expect } from "vitest";
import type { RuntimeManifest } from "@covel/shared";
import {
  createModelResolver,
  type PluginLlmModelTarget,
} from "../src/llm/model-resolver.js";

const manifest = (
  overrides: Partial<RuntimeManifest> = {},
): RuntimeManifest => ({
  name: "narrator",
  pluginId: "narrator",
  description: "test",
  stage: "narrative",
  ...overrides,
});

function setup(isRoleSelected?: (role: string) => boolean) {
  const modelTargets = new Map<string, PluginLlmModelTarget>();
  const resolve = createModelResolver({
    modelTargets,
    isRoleSelected,
    pluginLlmConfigs: new Map([
      [
        "narrator",
        {
          slots: {
            default: { provider: "vendor", model: "default-model" },
            fast: {
              provider: "vendor",
              model: "fast-model",
              baseUrl: "https://vendor.example/v1",
              protocol: "openai-chat-v1",
            },
          },
        },
      ],
    ]),
  });
  return { resolve, modelTargets };
}

describe("createModelResolver", () => {
  it("retains the complete plugin target behind a stable internal reference", () => {
    const { resolve, modelTargets } = setup();
    const id = resolve(manifest({ model: "fast" }));
    expect(id).not.toBe("fast-model");
    expect(modelTargets.get(id!)).toEqual({
      provider: "vendor",
      model: "fast-model",
      baseUrl: "https://vendor.example/v1",
      protocol: "openai-chat-v1",
      role: "fast",
    });
    expect(resolve(manifest({ model: "fast" }))).toBe(id);
    expect(Object.isFrozen(modelTargets.get(id!))).toBe(true);
  });

  it("uses plugin.default when the manifest omits a role", () => {
    const { resolve, modelTargets } = setup();
    expect(modelTargets.get(resolve(manifest())!)).toMatchObject({
      model: "default-model",
      role: "default",
    });
  });

  it("passes missing plugin roles and defaults through to the system", () => {
    const { resolve } = setup();
    expect(resolve(manifest({ model: "story" }))).toBe("story");
    expect(resolve(manifest({ name: "other" }))).toBeUndefined();
  });

  it("preserves explicit API/runtime roles instead of reinterpreting them through plugin preferences", () => {
    const { resolve } = setup();
    expect(resolve(manifest({ model: "fast" }), "fast")).toBe("fast");
    expect(resolve(manifest(), "other-preset")).toBe("other-preset");
  });

  it("lets request-selected role bindings replace plugin preferences", () => {
    const { resolve } = setup((role) => role === "fast" || role === "default");
    expect(resolve(manifest({ model: "fast" }))).toBe("fast");
    expect(resolve(manifest())).toBe("default");
  });
});
