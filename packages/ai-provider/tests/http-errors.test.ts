import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createAnthropicMessagesAdapter } from "../src/adapters/anthropic-messages.js";
import { createGoogleGenerativeAiAdapter } from "../src/adapters/google-generative-ai.js";
import { createOpenAiChatAdapter } from "../src/adapters/openai-chat.js";
import { createOpenAiResponsesAdapter } from "../src/adapters/openai-responses.js";
import { ERROR_PREVIEW_MAX_CHARS } from "../src/adapters/http/constants.js";
import { assertSuccess, parseJson } from "../src/adapters/http/response.js";
import { AiProviderError } from "../src/errors.js";
import { classifyProviderFailure } from "../src/provider-failure.js";

const config = { baseUrl: "https://provider.example" };
const params = {
  model: "synthetic",
  messages: [{ role: "user" as const, content: "Hello" }],
  schema: z.object({ count: z.number() }),
};
const authText = "Authentication Fails (governor)";

beforeEach(() => vi.stubEnv("COVEL_LLM_RETRY_DISABLED", "1"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe.each([
  { name: "openai-chat", create: createOpenAiChatAdapter },
  { name: "openai-responses", create: createOpenAiResponsesAdapter },
  { name: "anthropic-messages", create: createAnthropicMessagesAdapter },
  { name: "google-generative-ai", create: createGoogleGenerativeAiAdapter },
])("$name HTTP errors", ({ create }) => {
  describe.each(["generateText", "generateObject", "streamText"] as const)(
    "%s",
    (method) => {
      async function run() {
        const adapter = create();
        if (method === "streamText") {
          for await (const event of adapter.streamText(config, params)) {
            throw new Error(`Unexpected stream event: ${event.type}`);
          }
        } else {
          await adapter[method](config, params);
        }
      }

      it.each([
        authText,
        "",
        "null",
        JSON.stringify({ error: { message: authText } }),
      ])("preserves a 401 with body %j", async (body) => {
        const fetchMock = vi.fn(
          async () => new Response(body, { status: 401 }),
        );
        vi.stubGlobal("fetch", fetchMock);
        const error = await run().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(AiProviderError);
        expect(error).toMatchObject({
          code: "PROVIDER_ERROR",
          statusCode: 401,
          retriable: false,
          message: expect.stringContaining("HTTP 401"),
        });
        if (body.includes(authText))
          expect(error).toHaveProperty(
            "message",
            expect.stringContaining(authText),
          );
        expect(classifyProviderFailure(error).kind).toBe("auth");
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });

      it("keeps a JSON 429 rate limit and its provider details", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(
                JSON.stringify({
                  error: {
                    message: "Too many requests",
                    code: "rate_limit_exceeded",
                    type: "requests",
                  },
                }),
                { status: 429 },
              ),
          ),
        );
        const error = await run().catch((caught: unknown) => caught);
        expect(error).toMatchObject({
          code: "RATE_LIMITED",
          statusCode: 429,
          retriable: true,
          details: {
            providerCode: "rate_limit_exceeded",
            providerType: "requests",
          },
        });
        expect(classifyProviderFailure(error).kind).toBe("rate_limited");
      });

      if (method !== "streamText") {
        it.each(["", "not JSON"])(
          "still rejects a malformed 2xx body %j",
          async (body) => {
            vi.stubGlobal(
              "fetch",
              vi.fn(async () => new Response(body)),
            );
            const error = await run().catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(AiProviderError);
            expect(error).toHaveProperty(
              "message",
              body
                ? "Provider returned non-JSON response (HTTP 200): not JSON"
                : "Provider returned empty response (HTTP 200 )",
            );
          },
        );
      }
    },
  );
});

describe("shared HTTP error parsing", () => {
  async function fail(body: string, status: number) {
    const response = new Response(body, { status });
    assertSuccess(response, await parseJson(response), "fixture");
  }

  it.each([
    [403, "auth", false],
    [404, "not_found", false],
    [429, "rate_limited", true],
    [500, "server", true],
    [503, "overloaded", true],
    [504, "timeout", true],
  ] as const)(
    "preserves non-JSON HTTP %i classification",
    async (status, kind, retriable) => {
      const error = await fail("upstream error", status).catch(
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ statusCode: status, retriable });
      expect(classifyProviderFailure(error).kind).toBe(kind);
    },
  );

  it.each([false, true])("bounds the body preview (JSON=%s)", async (json) => {
    const message = "x".repeat(ERROR_PREVIEW_MAX_CHARS) + "not in preview";
    const body = json ? JSON.stringify({ error: { message } }) : message;
    await expect(fail(body, 401)).rejects.toMatchObject({
      statusCode: 401,
      message: `[fixture] HTTP 401 — ${"x".repeat(ERROR_PREVIEW_MAX_CHARS)}`,
    });
  });
});
