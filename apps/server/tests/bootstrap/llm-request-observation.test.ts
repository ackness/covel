import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  type PresetConfig,
  type ProviderProtocol,
} from "@covel/ai-provider";
import { createGatewayAdapter, createTurnEmitter } from "@covel/runtime";
import type { LLMProviderRequest } from "@covel/shared";
import {
  callLLMWithRetry,
  streamLLMWithRetry,
  buildRetryPolicy,
} from "../../../../packages/runtime/src/retry/llm-retry.js";
import { outboundFetch } from "../../../../packages/ai-provider/src/outbound-network.js";

vi.mock("../../../../packages/ai-provider/src/outbound-network.js", () => ({
  outboundFetch: vi.fn(),
}));
const fetch = vi.mocked(outboundFetch);
const calls: Record<string, unknown>[] = [];
const success = () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    }),
    { status: 200 },
  );

function fixture(
  fallback = false,
  protocol: ProviderProtocol = "openai-chat-v1",
) {
  const presets: PresetConfig[] = ["primary", "backup"].map((id) => ({
    id,
    name: id,
    provider: id,
    model: `${id}-model`,
    protocol,
    tier: "medium",
    enabled: true,
    supportedModes: ["text", "stream"],
    tag: "text",
    ...(id === "primary" && fallback ? { fallbackPresetIds: ["backup"] } : {}),
  }));
  const gateway = createGateway({
    presetRegistry: createPresetRegistry({ profiles: [], presets }),
    providerRegistry: createProviderRegistry({
      providers: {
        primary: {
          defaults: {
            baseUrl: "https://primary.example.com",
            protocol,
          },
        },
        backup: {
          defaults: {
            baseUrl: "https://backup.example.com",
            protocol,
          },
        },
      },
    }),
  });
  const llm = createGatewayAdapter(gateway, {
    apiKeys: {
      primary: "synthetic-primary-key",
      backup: "synthetic-backup-key",
    },
    slotOverrides: {
      parameterOverrides: {
        primary: { temperature: 0.2, maxOutputTokens: 99 },
      },
    },
  });
  const rows: Array<{ type: string; payload: unknown }> = [];
  const emitter = createTurnEmitter({
    sessionId: "session-fixture",
    turnId: "turn-fixture",
    traceId: "execution-fixture",
    store: {
      async addTraceEvent(row) {
        rows.push(row);
      },
    },
  });
  const params = {
    llm,
    model: "primary",
    messages: [
      { role: "user" as const, content: "Which promise did she make?" },
    ],
    emitter,
    pluginId: "fixture",
    runtimeId: "fixture/story",
    policy: buildRetryPolicy({ maxRetries: 0, runtimeTimeoutMs: 5000 }),
    deadline: Date.now() + 5000,
  };
  return { gateway, llm, rows, params };
}

beforeEach(() => {
  vi.stubEnv("COVEL_LLM_RETRY_DISABLED", "1");
  calls.length = 0;
  fetch.mockReset();
  fetch.mockImplementation(async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return success();
  });
});
afterEach(() => vi.unstubAllEnvs());

function recorded(
  rows: Array<{ type: string; payload: unknown }>,
): LLMProviderRequest[] {
  return (
    rows.find((row) => row.type === "llm.calling")?.payload as {
      providerRequests: LLMProviderRequest[];
    }
  ).providerRequests;
}

describe("model requests through runtime, gateway, and HTTP adapter", () => {
  it("records the transformed structured request and final generation limit", async () => {
    const { params, rows } = fixture();
    await callLLMWithRetry({
      ...params,
      maxOutputTokens: 32,
      responseFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
    });
    const requests = recorded(rows);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      schemaVersion: 1,
      provider: "primary",
      protocol: "openai-chat-v1",
      complete: true,
      statusCode: 200,
    });
    expect(requests[0].body).toEqual(calls[0]);
    expect(calls[0].max_tokens).toBe(32);
    expect(calls[0].temperature).toBe(0.2);
    expect(JSON.stringify(calls[0].messages)).toContain("response-format");
    expect(JSON.stringify(rows)).not.toContain("synthetic-primary-key");
  });

  it.each([
    "openai-chat-v1",
    "openai-responses-v1",
    "anthropic-messages-v1",
  ] as const)(
    "captures multimodal and resumed tool history for %s",
    async (protocol) => {
      const { params, rows } = fixture(false, protocol);
      fetch.mockImplementation(async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            output_text: "ok",
            status: "completed",
            usage: {},
          }),
        );
      });
      await callLLMWithRetry({
        ...params,
        tools: [
          {
            name: "remember",
            description: "Recall a promise",
            parameters: {
              type: "object",
              properties: { person: { type: "string" } },
            },
          },
        ],
        messages: [
          { role: "system", content: "Use remembered facts." },
          {
            role: "assistant",
            content: null,
            toolCalls: [
              {
                id: "recall-1",
                name: "remember",
                arguments: '{"person":"Alice"}',
              },
            ],
          },
          {
            role: "tool",
            content: "Alice promised to return the book.",
            toolCallId: "recall-1",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Is this that book?" },
              {
                type: "image",
                image: {
                  id: "a".repeat(64),
                  mime: "image/png",
                  size: 1234,
                  url: "https://media.example.com/book.png",
                },
              },
            ],
          },
        ],
      });
      expect(recorded(rows)[0]).toMatchObject({ protocol, complete: true });
      expect(recorded(rows)[0].body).toEqual(calls[0]);
      expect(JSON.stringify(recorded(rows)[0].body)).toContain("recall-1");
      expect(JSON.stringify(recorded(rows)[0].body)).toContain(
        "https://media.example.com/book.png",
      );
    },
  );

  it("retains transport retries separately from target fallback", async () => {
    vi.stubEnv("COVEL_LLM_RETRY_DISABLED", "0");
    const { params, rows } = fixture();
    fetch.mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return calls.length === 1
        ? new Response("busy", { status: 429, headers: { "retry-after": "0" } })
        : success();
    });
    await callLLMWithRetry(params);
    expect(
      recorded(rows).map((r) => [r.provider, r.transportAttempt, r.statusCode]),
    ).toEqual([
      ["primary", 0, 429],
      ["primary", 1, 200],
    ]);
    expect(recorded(rows).map((r) => r.body)).toEqual(calls);
  });

  it("retains failed target requests before a successful fallback", async () => {
    const { params, rows } = fixture(true);
    fetch.mockImplementation(async (url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return String(url).includes("primary")
        ? new Response("unavailable", { status: 503 })
        : success();
    });
    await callLLMWithRetry(params);
    const requests = recorded(rows);
    expect(requests.map((r) => r.provider)).toEqual(["primary", "backup"]);
    expect(requests.map((r) => r.statusCode)).toEqual([503, 200]);
    expect(requests.map((r) => r.body)).toEqual(calls);
  });

  it("records streamed requests before the first text delta is projected", async () => {
    const { params, rows } = fixture();
    fetch.mockImplementation(async (_url, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Response(
        'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    const delta = vi.fn(() => {
      expect(recorded(rows)[0].body).toEqual(calls[0]);
    });
    await streamLLMWithRetry({ ...params, onDelta: delta });
    expect(delta).toHaveBeenCalledWith("hello");
    expect(recorded(rows)[0].body.stream).toBe(true);
  });

  it("does not pretend redacted resources and unknown metadata can be reconstructed", async () => {
    const { gateway } = fixture();
    const records: LLMProviderRequest[] = [];
    await gateway.generateText(
      {
        presetId: "primary",
        messages: [
          {
            role: "user",
            content:
              "https://media.example.com/image?signature=synthetic-secret",
          },
        ],
        providerRequestMetadata: { privateToken: "synthetic-metadata-secret" },
      },
      { onProviderRequest: (r) => records.push(r) },
    );
    expect(records[0].complete).toBe(false);
    expect(records[0].omittedFieldCount).toBe(1);
    expect(JSON.stringify(records)).not.toContain("synthetic-secret");
    expect(JSON.stringify(records)).not.toContain("synthetic-metadata-secret");
  });

  it("isolates observation failures from provider success", async () => {
    const { gateway } = fixture();
    await expect(
      gateway.generateText(
        { presetId: "primary", messages: [] },
        {
          onProviderRequest: () => {
            throw new Error("observer failed");
          },
        },
      ),
    ).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
