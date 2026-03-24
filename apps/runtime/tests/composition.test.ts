import { describe, expect, it } from "vitest";

import { createRuntimeComposition } from "../src/composition.js";

describe("createRuntimeComposition", () => {
  it("discovers and enables the first-party packages and registers the core commands", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    expect(runtime.packageRuntime.listPackages().map((pkg) => pkg.name)).toEqual([
      "core-archive",
      "core-character-card",
      "core-debug-commands",
      "core-guide",
      "core-memory-rag",
      "core-persona",
      "core-presets",
      "core-worldbook"
    ]);
    expect(runtime.commandRegistry.listHelp().map((entry) => entry.name)).toEqual([
      "archive",
      "guide",
      "memory",
      "packages",
      "presets",
      "session",
      "trace"
    ]);
  });

  it("falls back to a deterministic demo provider when no openai-compatible env is configured", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    const result = await runtime.modelGateway.generateText({
      presetId: "default-story",
      messages: [
        {
          role: "user",
          content: "Say something"
        }
      ]
    });

    expect(result.text).toContain("demo");
    expect(runtime.runtimePreset.baseUrl).toBe("in-memory://demo-provider");
  });

  it("uses DashScope/openai-compatible env when configured", async () => {
    const runtime = await createRuntimeComposition({
      env: {
        DASHSCOPE_BASE_URL: "https://dashscope.example/compatible-mode/v1",
        DASHSCOPE_API_KEY: "dashscope-key",
        LIVE_LLM_PRIMARY_MODEL: "qwen3.5-flash"
      }
    });

    expect(runtime.runtimePreset).toMatchObject({
      provider: "openaiCompatible",
      baseUrl: "https://dashscope.example/compatible-mode/v1",
      model: "qwen3.5-flash"
    });
  });
});
