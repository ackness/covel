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
    model: "gpt-responses",
    contextWindow: 64_000,
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
  id: "responses-default",
  name: "Responses default",
  provider: "openaiCompatible",
  protocol: "openai-responses-v1",
  model: "gpt-responses",
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

async function startResponsesFixture(): Promise<ServerControl> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readJsonBody(request);

    if (request.url === "/responses") {
      if (body.stream === true) {
        response.writeHead(200, {
          "content-type": "text/event-stream"
        });
        response.write("event: response.output_text.delta\n");
        response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello \"}\n\n");
        response.write("event: response.output_text.delta\n");
        response.write("data: {\"type\":\"response.output_text.delta\",\"delta\":\"responses\"}\n\n");
        response.write("event: response.completed\n");
        response.write("data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}}\n\n");
        response.end();
        return;
      }

      const isStructured = typeof body.text === "object" && body.text !== null;
      response.writeHead(200, {
        "content-type": "application/json"
      });
      response.end(JSON.stringify({
        id: "resp_01",
        output_text: isStructured ? "{\"title\":\"Northreach\",\"mood\":\"cold\"}" : "plain responses output",
        usage: {
          input_tokens: 5,
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

describe("openai responses adapter", () => {
  let server: ServerControl | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  async function createGateway() {
    server = await startResponsesFixture();
    return createModelGateway({
      providerRegistry: createProviderRegistry({
        providers: {
          openaiCompatible: {
            defaults: {
              apiKey: "fixture-key"
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

  it("supports text generation through the Responses API", async () => {
    const gateway = await createGateway();

    const result = await gateway.generateText({
      presetId: "responses-default",
      messages: [{ role: "user", content: "Say hello." }]
    });

    expect(result).toEqual({
      text: "plain responses output",
      finishReason: "stop",
      usage: {
        inputTokens: 5,
        outputTokens: 3
      }
    });
  });

  it("supports structured object generation through the Responses API", async () => {
    const gateway = await createGateway();

    const result = await gateway.generateObject({
      presetId: "responses-default",
      schema: z.object({
        title: z.string(),
        mood: z.string()
      }),
      messages: [{ role: "user", content: "Return structured data." }]
    });

    expect(result.object).toEqual({
      title: "Northreach",
      mood: "cold"
    });
  });

  it("supports Responses API streaming events", async () => {
    const gateway = await createGateway();
    const events = [];

    for await (const event of gateway.streamText({
      presetId: "responses-default",
      messages: [{ role: "user", content: "Stream please." }]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", textDelta: "hello " },
      { type: "text-delta", textDelta: "responses" },
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
});
