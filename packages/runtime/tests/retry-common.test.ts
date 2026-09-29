import {
  AiProviderError,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
} from "@covel/ai-provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGatewayAdapter,
  type GatewayLike,
} from "../src/llm/gateway-llm-adapter.js";
import {
  buildRetryPolicy,
  callLLMWithRetry,
  streamLLMWithRetry,
} from "../src/retry/llm-retry.js";
import { TurnAbortedError } from "../src/turn-executor/turn-control.js";

const messages = [{ role: "user" as const, content: "Hello" }];
const policy = buildRetryPolicy({ runtimeTimeoutMs: 10_000, maxRetries: 1 });
const success = {
  text: "recovered",
  finishReason: "stop",
  usage: { inputTokens: 1, outputTokens: 1 },
};

afterEach(() => vi.unstubAllGlobals());

describe.each(["generate", "stream"] as const)(
  "%s gateway error retry contract",
  (mode) => {
    function fixture(error: Error, beforeFailure?: () => void) {
      const attempt = vi.fn(() => {
        if (attempt.mock.calls.length === 1) {
          beforeFailure?.();
          throw error;
        }
      });
      const gateway: GatewayLike = {
        resolveSlot: () => ({ provider: "fixture", model: "fixture-model" }),
        async generateText() {
          attempt();
          return success;
        },
        async *streamText() {
          attempt();
          yield { type: "text-delta", textDelta: success.text };
          yield { type: "done", ...success };
        },
      };
      const llm = createGatewayAdapter(gateway);
      return {
        attempt,
        run(abortSignal?: AbortSignal) {
          const params = {
            llm,
            messages,
            policy,
            deadline: Date.now() + 10_000,
            abortSignal,
          };
          return mode === "generate"
            ? callLLMWithRetry(params)
            : streamLLMWithRetry(params);
        },
      };
    }

    it("retries a structured 429 without rate-limit keywords through the adapter", async () => {
      const { attempt, run } = fixture(
        new AiProviderError({
          provider: "fixture",
          code: "RATE_LIMITED",
          statusCode: 429,
          retriable: true,
          message: "quota exhausted",
        }),
      );

      await expect(run()).resolves.toBeDefined();
      expect(attempt).toHaveBeenCalledTimes(2);
    });

    it.each([
      { code: "PROVIDER_ERROR", statusCode: 400, retriable: false },
      { code: "CONFIG_ERROR", retriable: false },
      { code: "SCHEMA_VALIDATION_FAILED", retriable: false },
      { code: "PROVIDER_ERROR", retriable: false },
    ] as const)(
      "does not retry $code ($statusCode) based on message keywords",
      async (fields) => {
        const error = new AiProviderError({
          ...fields,
          provider: "fixture",
          message: "network timeout option is unsupported",
        });
        const { attempt, run } = fixture(error);

        await expect(run()).rejects.toMatchObject({ cause: error });
        expect(attempt).toHaveBeenCalledTimes(1);
      },
    );

    it("retries an explicitly transient provider failure without message keywords", async () => {
      const { attempt, run } = fixture(
        new AiProviderError({
          provider: "fixture",
          code: "PROVIDER_ERROR",
          retriable: true,
          message: "temporarily unavailable",
        }),
      );

      await expect(run()).resolves.toBeDefined();
      expect(attempt).toHaveBeenCalledTimes(2);
    });

    it("retains message-based retry for unknown transport errors", async () => {
      const { attempt, run } = fixture(new TypeError("fetch failed"));

      await expect(run()).resolves.toBeDefined();
      expect(attempt).toHaveBeenCalledTimes(2);
    });

    it("retries a fetch failure normalized by the real gateway", async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(
            mode === "generate"
              ? JSON.stringify({
                  choices: [
                    {
                      message: { content: "recovered" },
                      finish_reason: "stop",
                    },
                  ],
                  usage: { prompt_tokens: 1, completion_tokens: 1 },
                })
              : 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n\n' +
                  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                  "data: [DONE]\n\n",
            {
              headers: {
                "content-type":
                  mode === "generate"
                    ? "application/json"
                    : "text/event-stream",
              },
            },
          ),
        );
      vi.stubGlobal("fetch", fetchMock);
      const gateway = createGateway({
        providerRegistry: createProviderRegistry({
          providerDefaults: {
            fixture: { baseUrl: "https://fixture.example/v1" },
          },
        }),
        presetRegistry: createPresetRegistry({
          profiles: [],
          presets: [
            {
              id: "fixture",
              name: "Fixture",
              provider: "fixture",
              model: "fixture-model",
              tier: "medium",
              supportedModes: ["text", "stream"],
              enabled: true,
              isDefault: true,
            },
          ],
        }),
      });
      const params = {
        llm: createGatewayAdapter(gateway),
        messages,
        policy,
        deadline: Date.now() + 10_000,
      };
      const response =
        mode === "generate"
          ? await callLLMWithRetry(params)
          : (await streamLLMWithRetry(params)).response;

      expect(response.content).toBe("recovered");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("does not retry an unrecognized error", async () => {
      const error = new Error("unexpected fixture failure");
      const { attempt, run } = fixture(error);

      await expect(run()).rejects.toMatchObject({ cause: error });
      expect(attempt).toHaveBeenCalledTimes(1);
    });

    it("does not retry a transient provider failure after caller cancellation", async () => {
      const aborter = new AbortController();
      const { attempt, run } = fixture(
        new AiProviderError({
          provider: "fixture",
          code: "RATE_LIMITED",
          statusCode: 429,
          retriable: true,
          message: "quota exhausted",
        }),
        () => aborter.abort(new Error("caller cancelled")),
      );

      await expect(run(aborter.signal)).rejects.toBeInstanceOf(
        TurnAbortedError,
      );
      expect(attempt).toHaveBeenCalledTimes(1);
    });
  },
);
