import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createModelGateway, createModelProfileRegistry, createProviderRegistry } from "../src/index.js";
import type { ModelProfile, PresetMetadata } from "../src/index.js";

const runtimeProfiles: ModelProfile[] = [
  {
    id: "medium",
    tier: "medium",
    provider: "anthropic",
    model: "claude-sonnet",
    contextWindow: 200_000,
    latencyClass: "medium",
    costClass: "medium",
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

const runtimePreset = (baseUrl: string): PresetMetadata => ({
  id: "claude-default",
  name: "Claude default",
  provider: "anthropic",
  protocol: "anthropic-messages-v1",
  model: "claude-sonnet",
  tier: "medium",
  baseUrl,
  supportedModes: ["text", "object", "stream"],
  enabled: true,
  isDefault: true,
  scope: "global"
});

interface ServerControl {
  url: string;
  close(): Promise<void>;
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function startAnthropicFixture(): Promise<ServerControl> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readJsonBody(request);

    if (request.url === "/messages") {
      if (body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream"
        });
        response.write("event: content_block_delta\n");
        response.write("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"hello \"}}\n\n");
        response.write("event: content_block_delta\n");
        response.write("data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"claude\"}}\n\n");
        response.write("event: message_delta\n");
        response.write("data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n");
        response.write("event: message_stop\n");
        response.write("data: {\"type\":\"message_stop\"}\n\n");
        response.end();
        return;
      }

      const isStructured = Array.isArray(body.messages);
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        id: "msg_01",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: isStructured && body.system ? "{\"title\":\"Watchtower\",\"mood\":\"tense\"}" : "plain anthropic output"
          }
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 7,
          output_tokens: 3
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

describe("anthropic messages adapter", () => {
  let server: ServerControl | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  async function createGateway() {
    server = await startAnthropicFixture();
    return createModelGateway({
      providerRegistry: createProviderRegistry({
        providers: {
          anthropic: {
            defaults: {
              baseUrl: server.url,
              apiKey: "anthropic-key",
              headers: {
                "anthropic-version": "2023-06-01"
              }
            }
          }
        }
      }),
      profileRegistry: createModelProfileRegistry({
        runtimeProfiles,
        runtimePresets: [runtimePreset(server.url)]
      })
    });
  }

  it("supports Anthropic Messages text generation", async () => {
    const gateway = await createGateway();

    const result = await gateway.generateText({
      presetId: "claude-default",
      messages: [{ role: "user", content: "Say hello." }]
    });

    expect(result).toEqual({
      text: "plain anthropic output",
      finishReason: "end_turn",
      usage: {
        inputTokens: 7,
        outputTokens: 3
      }
    });
  });

  it("supports Anthropic Messages structured object generation", async () => {
    const gateway = await createGateway();

    const result = await gateway.generateObject({
      presetId: "claude-default",
      schema: z.object({
        title: z.string(),
        mood: z.string()
      }),
      messages: [{ role: "user", content: "Return structured data." }]
    });

    expect(result.object).toEqual({
      title: "Watchtower",
      mood: "tense"
    });
  });

  it("supports Anthropic Messages streaming events", async () => {
    const gateway = await createGateway();
    const events = [];

    for await (const event of gateway.streamText({
      presetId: "claude-default",
      messages: [{ role: "user", content: "Stream please." }]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", textDelta: "hello " },
      { type: "text-delta", textDelta: "claude" },
      {
        type: "done",
        finishReason: "end_turn",
        usage: {
          inputTokens: 0,
          outputTokens: 2
        }
      }
    ]);
  });
});
