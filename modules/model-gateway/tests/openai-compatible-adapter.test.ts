import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createModelGateway, createModelProfileRegistry, createProviderRegistry } from "../src/index.js";
import type { ModelProfile, PresetMetadata } from "../src/index.js";

const runtimeProfiles: ModelProfile[] = [
  {
    id: "medium",
    tier: "medium",
    provider: "openaiCompatible",
    model: "test-chat-model",
    contextWindow: 64_000,
    latencyClass: "medium",
    costClass: "medium",
    supportedModes: ["text", "object", "stream"]
  },
  {
    id: "embed-default",
    tier: "embed-default",
    provider: "openaiCompatible",
    model: "test-embed-model",
    contextWindow: 8_000,
    latencyClass: "low",
    costClass: "low",
    supportedModes: ["embed"]
  }
];

const runtimePreset = (baseUrl: string): PresetMetadata => ({
  id: "default-medium",
  name: "Default medium",
  provider: "openaiCompatible",
  model: "preset-chat-model",
  tier: "medium",
  baseUrl,
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  scope: "global"
});

interface ServerControl {
  url: string;
  receivedBodies: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

async function startOpenAiCompatibleFixture(): Promise<ServerControl> {
  const receivedBodies: Array<Record<string, unknown>> = [];

  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readJsonBody(request);
    receivedBodies.push(body);

    if (request.url === "/chat/completions") {
      handleChatCompletion(body, response);
      return;
    }

    if (request.url === "/embeddings") {
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        data: [
          { embedding: [0.11, 0.22, 0.33], index: 0 },
          { embedding: [0.44, 0.55, 0.66], index: 1 }
        ],
        usage: {
          prompt_tokens: 6,
          total_tokens: 6
        }
      }));
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to allocate test server port.");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    receivedBodies,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function handleChatCompletion(body: Record<string, unknown>, response: ServerResponse): void {
  if (body.testCase === "rate-limit") {
    response.writeHead(429, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "too many requests"
      }
    }));
    return;
  }

  if (body.testCase === "malformed-object") {
    response.writeHead(200, {
      "content-type": "application/json"
    });
    response.end(JSON.stringify({
      id: "chatcmpl-malformed",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "{\"name\":123}"
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 3,
        total_tokens: 8
      }
    }));
    return;
  }

  if (body.stream === true) {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    response.write("data: {\"choices\":[{\"delta\":{\"content\":\"hello \"}}]}\n\n");
    response.write("data: {\"choices\":[{\"delta\":{\"content\":\"stream\"}}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\n");
    response.write("data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\n");
    response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  const content =
    body.response_format && typeof body.response_format === "object"
      ? "{\"name\":\"covel\",\"level\":2}"
      : "plain text response";

  response.writeHead(200, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify({
    id: "chatcmpl-1",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }
    ],
    usage: {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8
    }
  }));
}

describe("openai-compatible adapter contract", () => {
  let server: ServerControl | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  async function createGateway() {
    server = await startOpenAiCompatibleFixture();

    const providerRegistry = createProviderRegistry({
      providers: {
        openaiCompatible: {
          defaults: {
            apiKey: "fixture-key"
          }
        }
      }
    });

    const profileRegistry = createModelProfileRegistry({
      runtimeProfiles,
      runtimePresets: [runtimePreset(server.url)]
    });

    return {
      gateway: createModelGateway({
        providerRegistry,
        profileRegistry
      }),
      server
    };
  }

  it("supports text generation routed through the selected preset/profile", async () => {
    const { gateway, server: fixture } = await createGateway();

    const result = await gateway.generateText({
      presetId: "default-medium",
      messages: [{ role: "user", content: "Say something deterministic." }]
    });

    expect(result).toEqual({
      text: "plain text response",
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        outputTokens: 3
      }
    });
    expect(fixture.receivedBodies[0]).toMatchObject({
      model: "preset-chat-model",
      messages: [{ role: "user", content: "Say something deterministic." }]
    });
  });

  it("supports structured object generation with schema validation", async () => {
    const { gateway } = await createGateway();

    const result = await gateway.generateObject({
      presetId: "default-medium",
      schema: z.object({
        name: z.string(),
        level: z.number().int()
      }),
      messages: [{ role: "user", content: "Return the model descriptor." }]
    });

    expect(result).toEqual({
      object: {
        name: "covel",
        level: 2
      },
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        outputTokens: 3
      }
    });
  });

  it("supports streaming text responses as deterministic async events", async () => {
    const { gateway } = await createGateway();

    const events = [];
    for await (const event of gateway.streamText({
      presetId: "default-medium",
      messages: [{ role: "user", content: "Stream please." }]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", textDelta: "hello " },
      { type: "text-delta", textDelta: "stream" },
      {
        type: "done",
        finishReason: "stop",
        usage: {
          inputTokens: 4,
          outputTokens: 2
        }
      }
    ]);
  });

  it("supports embeddings through the internal embed-default profile", async () => {
    const { gateway, server: fixture } = await createGateway();

    const result = await gateway.embed({
      values: ["northreach", "observatory"]
    });

    expect(result).toEqual({
      embeddings: [
        [0.11, 0.22, 0.33],
        [0.44, 0.55, 0.66]
      ],
      usage: {
        inputTokens: 6,
        outputTokens: 0
      }
    });
    expect(fixture.receivedBodies[0]).toMatchObject({
      model: "test-embed-model",
      input: ["northreach", "observatory"]
    });
  });

  it("normalizes provider rate limit errors", async () => {
    const { gateway } = await createGateway();

    await expect(
      gateway.generateText({
        presetId: "default-medium",
        messages: [{ role: "user", content: "Trigger a rate limit." }],
        providerRequestMetadata: {
          testCase: "rate-limit"
        }
      })
    ).rejects.toMatchObject({
      name: "ModelGatewayError",
      code: "RATE_LIMITED",
      provider: "openaiCompatible",
      retriable: true,
      statusCode: 429
    });
  });

  it("normalizes malformed structured output as schema validation failures", async () => {
    const { gateway } = await createGateway();

    await expect(
      gateway.generateObject({
        presetId: "default-medium",
        schema: z.object({
          name: z.string()
        }),
        messages: [{ role: "user", content: "Return malformed data." }],
        providerRequestMetadata: {
          testCase: "malformed-object"
        }
      })
    ).rejects.toMatchObject({
      name: "ModelGatewayError",
      code: "SCHEMA_VALIDATION_FAILED",
      provider: "openaiCompatible",
      retriable: false
    });
  });
});
