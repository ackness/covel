/**
 * TDD tests for multi-format image generation in the openai-chat adapter.
 *
 * Covers:
 * - DashScope WAN async task API (imageFormat: "dashscope-wan")
 * - OpenAI chat completions image format (imageFormat: "openai-chat", default)
 * - Original DALL-E format (imageFormat: "dalle")
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";

const openaiChatAdapter = createOpenAiChatAdapter();
import type { ProviderConfig } from "../src/types.js";

const mockConfig: ProviderConfig = {
  baseUrl: "https://dashscope.aliyuncs.com",
  apiKey: "test-key",
  headers: {},
};

const openaiConfig: ProviderConfig = {
  baseUrl: "https://api.openai.com",
  apiKey: "test-key",
  headers: {},
};

// ── DashScope WAN async ───────────────────────────────────────────

describe("generateImage - dashscope-wan format", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should call DashScope async task endpoint and return URL after polling", async () => {
    let callCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const urlStr = String(url);

      // First call: submit task
      if (urlStr.includes("/image-generation/generation") && callCount === 0) {
        callCount++;
        return new Response(
          JSON.stringify({ output: { task_id: "task-abc123", task_status: "PENDING" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      // Second call: poll task - success
      if (urlStr.includes("/tasks/task-abc123")) {
        return new Response(
          JSON.stringify({
            output: {
              task_id: "task-abc123",
              task_status: "SUCCEEDED",
              results: [{ url: "https://cdn.example.com/image.png" }],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      throw new Error(`Unexpected fetch call: ${urlStr}`);
    }));

    const result = await openaiChatAdapter.generateImage(mockConfig, {
      model: "wan2.7-image-pro",
      prompt: "一间有着精致窗户的花店",
      providerRequestMetadata: {
        imageFormat: "dashscope-wan",
        size: "1024*1024",
        n: 1,
        watermark: false,
      },
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe("https://cdn.example.com/image.png");
  });

  it("should throw if DashScope task fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const urlStr = String(url);

      if (urlStr.includes("/image-generation/generation")) {
        return new Response(
          JSON.stringify({ output: { task_id: "task-fail", task_status: "PENDING" } }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      if (urlStr.includes("/tasks/task-fail")) {
        return new Response(
          JSON.stringify({
            output: {
              task_id: "task-fail",
              task_status: "FAILED",
              message: "Content policy violation",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      throw new Error(`Unexpected: ${urlStr}`);
    }));

    await expect(
      openaiChatAdapter.generateImage(mockConfig, {
        model: "wan2.7-image-pro",
        prompt: "test",
        providerRequestMetadata: { imageFormat: "dashscope-wan" },
      })
    ).rejects.toThrow(/FAILED/);
  });
});

// ── OpenAI chat completions image format ─────────────────────────

describe("generateImage - openai-chat format (default)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should call chat completions and extract image URL from response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                tool_calls: null,
              },
              // image embedded in a special way — URL in content or custom field
            },
          ],
          // Some providers return image_url at top level
          image_url: "https://example.com/generated.jpg",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    ));

    const result = await openaiChatAdapter.generateImage(openaiConfig, {
      model: "gpt-4o-image",
      prompt: "画只猫",
      providerRequestMetadata: { imageFormat: "openai-chat" },
    });

    expect(result.images.length).toBeGreaterThan(0);
    expect(result.images[0].url).toBeDefined();
  });
});

// ── Default format (openai-chat) ─────────────────────────────────

describe("generateImage - default format (openai-chat)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("should call chat completions endpoint when imageFormat is not specified", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ image_url: "https://openai.example.com/img.png" }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await openaiChatAdapter.generateImage(openaiConfig, {
      model: "gpt-image-1.5",
      prompt: "A knight",
    });

    expect(result.images[0].url).toBe("https://openai.example.com/img.png");
    const calledUrl = String((fetchMock.mock.calls[0] as [string])[0]);
    expect(calledUrl).toContain("/chat/completions");
  });
});
