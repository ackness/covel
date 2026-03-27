import { describe, expect, it } from "vitest";

import { createSession } from "../../../modules/domain/src/index.js";
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
    expect(runtime.runtimePreset.model).toBe("deepseek/deepseek-chat");
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

  it("adds the legacy OpenRouter free fallback preset when only an OpenRouter key is configured", async () => {
    const runtime = await createRuntimeComposition({
      env: {
        OPENROUTER_API_KEY: "openrouter-key"
      }
    });

    await expect(runtime.presetMetadataStore?.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "default-story",
          fallbackPresetIds: ["openrouter-free"]
        }),
        expect.objectContaining({
          id: "openrouter-free",
          provider: "openrouter",
          model: "openrouter/openrouter/free",
          baseUrl: "https://openrouter.ai/api/v1",
          isDefault: false
        })
      ])
    );
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

  it("routes model turns through structured object generation and emits host blocks", async () => {
    const runtime = await createRuntimeComposition({
      env: {}
    });

    await runtime.repositories.sessions.save(createSession({
      id: "session_model_blocks",
      worldId: "world_model_blocks",
      status: "active",
      createdAt: new Date("2026-03-26T00:00:00.000Z")
    }));

    const events = await runtime.flowEngine.handle({
      requestId: "req_model_blocks",
      type: "send_message",
      sessionId: "session_model_blocks",
      locale: "en",
      payload: {
        content: "Offer a choice for what I should do next."
      }
    });

    expect(events.map((event) => event.type)).toEqual([
      "flow.phase.changed",
      "message.delta",
      "message.completed",
      "block.emitted",
      "workflow.suspended",
      "flow.completed"
    ]);
    expect(events[3]?.payload.block).toMatchObject({
      type: "choice_set",
      data: {
        title: "Choose the next move",
        options: [
          { id: "opt_a", label: "Advance" },
          { id: "opt_b", label: "Observe" }
        ]
      },
      meta: {
        package: "runtime",
        requestId: "req_model_blocks",
        sessionId: "session_model_blocks"
      }
    });
    expect(events[4]?.payload).toMatchObject({
      status: "suspended"
    });
  });
});
