import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import {
  defaultToolChoice,
  withTextRequestDefaults,
} from "../src/adapters/request-defaults.js";
import { modelsDevVariant } from "../src/capability/models-dev.js";
import { resolveReasoningControls } from "../src/capability/reasoning-models.js";
import { thinksOnRequest } from "../src/reasoning-effort.js";
import type {
  ModelRequestContext,
  TextGenerationParams,
} from "../src/types.js";

const MOONSHOT = "https://api.moonshot.cn/v1";
const DEEPSEEK = "https://api.deepseek.com";

function context(
  model: string,
  provider: string,
  baseUrl: string,
): ModelRequestContext {
  return {
    profile: { provider, model } as ModelRequestContext["profile"],
    preset: { provider, model, baseUrl } as ModelRequestContext["preset"],
    mode: "text",
  };
}

const levels = (
  model: string,
  provider?: string,
  protocol = "openai-chat-v1",
  baseUrl?: string,
) =>
  resolveReasoningControls(
    model,
    provider,
    protocol,
    undefined,
    baseUrl,
  ).profile?.options.map((option) => option.value);

afterEach(() => vi.unstubAllGlobals());

describe("models.dev catalog lookup", () => {
  it("prefers the host the slot calls", () => {
    expect(
      modelsDevVariant("kimi-k3.1-pro", { baseUrl: MOONSHOT })?.reasoning,
    ).toMatchObject({ default: "max" });
    expect(
      modelsDevVariant("kimi-k3.1-pro", {
        baseUrl: "https://router.requesty.ai/v1",
      })?.reasoning?.effort,
    ).toContain("medium");
  });

  it("falls back to the lab's own host when the host is unknown", () => {
    expect(
      modelsDevVariant("kimi-k3.1-pro", {
        baseUrl: "https://relay.example/v1",
      })?.hosts,
    ).toContain("api.moonshot.cn");
  });

  it("finds models behind an aggregator prefix or a snapshot suffix", () => {
    expect(modelsDevVariant("moonshotai/kimi-k3.1-pro")).toBeDefined();
    expect(modelsDevVariant("gpt-6-luna-2026-09-22")).toBeDefined();
    expect(modelsDevVariant("acme-unlisted-1")).toBeUndefined();
  });
});

describe("catalog-backed reasoning controls", () => {
  it("reads Kimi's levels, fixed sampling and tool choices from the catalog", () => {
    const controls = resolveReasoningControls(
      "kimi-k3.1-pro",
      "custom",
      "openai-chat-v1",
      undefined,
      MOONSHOT,
    );
    expect(controls.thinkingAlwaysOn).toBe(true);
    expect(controls.profile).toMatchObject({
      defaultValue: "max",
      // The top level by default would make every call slow.
      requestDefault: "high",
      sampling: { fixed: ["temperature", "topP"] },
    });
    expect(controls.profile?.options.map((option) => option.value)).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(controls.toolChoiceWhileThinking).toEqual(["auto", "required"]);
  });

  it("keeps DeepSeek's thinking switch beside the catalog's levels", () => {
    const controls = resolveReasoningControls(
      "deepseek-flash",
      "deepseek",
      "openai-chat-v1",
      undefined,
      DEEPSEEK,
    );
    expect(controls).toMatchObject({
      family: "deepseek",
      format: "thinking-type",
      thinksByDefault: true,
      sampling: { ignoredWhileThinking: true },
    });
    expect(controls.profile?.defaultValue).toBe("high");
    expect(controls.profile?.requestDefault).toBeUndefined();
    expect(controls.profile?.options.map((option) => option.value)).toEqual([
      "disabled",
      "low",
      "high",
      "max",
    ]);
  });

  it("lets a bundled rule written for a model win over the catalog", () => {
    expect(
      resolveReasoningControls("claude-opus-5-5", "anthropic").parameterStyle,
    ).toBe("adaptive");
    expect(levels("qwen3.8-flash", "dashscope")).toEqual([
      "disabled",
      "automatic",
      "low",
      "medium",
      "xhigh",
    ]);
  });

  it("fills a missing default and off switch from the family's catch-all rule", () => {
    const controls = resolveReasoningControls(
      "claude-opus-4-5",
      "anthropic",
      "anthropic-messages-v1",
    );
    expect(controls.profile?.defaultValue).toBe("high");
    expect(controls.profile?.options[0]?.value).toBe("disabled");
  });

  it("uses a whenUnlisted rule only for IDs the catalog lacks", () => {
    expect(levels("gpt-6", "custom")).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      levels(
        "gpt-6.1-sol",
        "custom",
        "openai-chat-v1",
        "https://api.cortecs.ai/v1",
      ),
    ).not.toContain("none");
  });

  it("steps a costly default down one level only when it is the top", () => {
    expect(
      resolveReasoningControls("qwen3.8-flash", "dashscope", "openai-chat-v1")
        .profile?.requestDefault,
    ).toBe("medium");
    expect(
      resolveReasoningControls("o3", "openai", "openai-chat-v1").profile
        ?.requestDefault,
    ).toBeUndefined();
  });
});

describe("requests shaped by catalog behaviour", () => {
  const params: TextGenerationParams = {
    model: "kimi-k3.1-pro",
    messages: [{ role: "user", content: "Go on." }],
  };

  it("sends the stepped-down level when no level is chosen", () => {
    const shaped = withTextRequestDefaults(
      params,
      context("kimi-k3.1-pro", "custom", MOONSHOT),
      "openai-chat-v1",
    );
    expect(shaped.providerRequestMetadata).toMatchObject({
      reasoningEffort: "high",
    });
  });

  it("leaves a chosen level alone", () => {
    const shaped = withTextRequestDefaults(
      { ...params, providerRequestMetadata: { reasoningEffort: "low" } },
      context("kimi-k3.1-pro", "custom", MOONSHOT),
      "openai-chat-v1",
    );
    expect(shaped.providerRequestMetadata).toEqual({ reasoningEffort: "low" });
  });

  it("narrows a forced tool while the model thinks", () => {
    const kimi = resolveReasoningControls(
      "kimi-k3.1-pro",
      "custom",
      "openai-chat-v1",
      undefined,
      MOONSHOT,
    );
    const named = { toolChoice: { name: "submit" } } as const;
    expect(defaultToolChoice(named, {}, "chat", kimi)).toBe("required");
    const deepseek = resolveReasoningControls(
      "deepseek-flash",
      "deepseek",
      "openai-chat-v1",
      undefined,
      DEEPSEEK,
    );
    expect(defaultToolChoice(named, {}, "chat", deepseek)).toBe("auto");
    expect(
      defaultToolChoice(
        named,
        { thinking: { type: "disabled" } },
        "chat",
        deepseek,
      ),
    ).toEqual({ type: "function", function: { name: "submit" } });
  });

  it("reads whether a request body turns thinking on", () => {
    const deepseek = resolveReasoningControls(
      "deepseek-flash",
      "deepseek",
      "openai-chat-v1",
      undefined,
      DEEPSEEK,
    );
    expect(thinksOnRequest({}, deepseek)).toBe(true);
    expect(thinksOnRequest({ thinking: { type: "disabled" } }, deepseek)).toBe(
      false,
    );
    expect(thinksOnRequest({ reasoning_effort: "none" }, deepseek)).toBe(false);
  });

  it("does not send sampling a model fixes itself", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createOpenAiChatAdapter().generateText(
      { baseUrl: MOONSHOT, apiKey: "test-key" },
      {
        ...params,
        providerRequestMetadata: {
          parameterOverrides: { temperature: 0.4, topP: 0.9 },
        },
      },
      context("kimi-k3.1-pro", "custom", MOONSHOT),
    );
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("kimi-k3.1-pro fixes temperature itself"),
    );
    warn.mockRestore();
  });
});
