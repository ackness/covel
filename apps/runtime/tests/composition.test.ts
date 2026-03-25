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
    expect(runtime.commandRegistry.listHelp().map((entry) => entry.name)).toEqual(
      expect.arrayContaining([
        "archive",
        "guide",
        "help",
        "memory",
        "packages",
        "presets",
        "session",
        "trace"
      ])
    );
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

  it("executes the package-backed guide command and returns an interactive block", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    const result = await runtime.commandBus.dispatch("/guide", {
      sessionId: "session_guide"
    }) as {
      content?: string;
      blocks?: Array<{ type: string }>;
    };

    expect(result.content).toContain("选项");
    expect(result.blocks?.[0]).toMatchObject({
      type: "choices"
    });
  });

  it("localizes package-backed command output and blocks by locale", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    const zhResult = await runtime.commandBus.dispatch("/guide", {
      sessionId: "session_guide",
      locale: "zh-CN"
    }) as {
      content?: string;
      blocks?: Array<{ data?: { title?: string; options?: Array<{ label: string }> } }>;
    };
    const enResult = await runtime.commandBus.dispatch("/guide", {
      sessionId: "session_guide",
      locale: "en"
    }) as {
      content?: string;
      blocks?: Array<{ data?: { title?: string; options?: Array<{ label: string }> } }>;
    };

    expect(zhResult.content).toContain("已为");
    expect(zhResult.blocks?.[0]?.data?.title).toContain("下一步");
    expect(zhResult.blocks?.[0]?.data?.options?.[0]?.label).toBe("继续前进");
    expect(enResult.content).toContain("Guide package prepared options");
    expect(enResult.blocks?.[0]?.data?.title).toContain("Next move");
    expect(enResult.blocks?.[0]?.data?.options?.[0]?.label).toBe("Advance");
  });

  it("executes the built-in help command and lists the registered commands", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    const result = await runtime.commandBus.dispatch("/help") as {
      content?: string;
    };

    expect(result.content).toContain("/guide");
    expect(result.content).toContain("/archive");
    expect(result.content).toContain("/help");
  });

  it("localizes the built-in help command descriptions", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    const zhResult = await runtime.commandBus.dispatch("/help", {
      locale: "zh-CN"
    }) as {
      content?: string;
    };
    const enResult = await runtime.commandBus.dispatch("/help", {
      locale: "en"
    }) as {
      content?: string;
    };

    expect(zhResult.content).toContain("生成引导选择块");
    expect(zhResult.content).toContain("列出可用命令");
    expect(enResult.content).toContain("Generate a guide block.");
    expect(enResult.content).toContain("List available commands.");
  });
});
