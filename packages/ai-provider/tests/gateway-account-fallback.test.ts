import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AiProviderError,
  classifyProviderFailure,
  createGateway,
  createPresetRegistry,
  createProviderRegistry,
  createSlotRegistry,
  parseLlmConfig,
} from "../src/index.js";
import type { ModelProviderAdapter } from "../src/adapters/adapter.js";

type Mode = "text" | "object" | "stream";
type Difference = "none" | "provider" | "baseUrl" | "apiKey";

function setup(
  statusCode: number,
  difference: Difference,
  interveningFailure = false,
) {
  const failure = new AiProviderError({
    code: "PROVIDER_ERROR",
    provider: "fixture",
    message: "Account failure",
    statusCode,
    details:
      statusCode === 429 ? { providerCode: "insufficient_quota" } : undefined,
    retriable: false,
  });
  const calls: string[] = [];
  const attempts: string[] = [];
  function attempt(model: string) {
    calls.push(model);
    if (model === "primary") throw failure;
    if (interveningFailure && model === "independent")
      throw new AiProviderError({
        code: "PROVIDER_ERROR",
        provider: "other",
        message: "Temporarily unavailable",
        statusCode: 503,
        retriable: true,
      });
  }
  const adapter: ModelProviderAdapter = {
    generateText: vi.fn(async (_config, params) => {
      attempt(params.model);
      return {
        text: "ok",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    generateObject: vi.fn(async (_config, params) => {
      attempt(params.model);
      return {
        object: params.schema.parse({ ok: true }),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }),
    async *streamText(_config, params) {
      attempt(params.model);
      yield { type: "text-delta", textDelta: "ok" };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
    embed: vi.fn(),
  };
  const { aiConfig } = parseLlmConfig(`
[covel.primary]
provider = "fixture"
model = "primary"
baseUrl = "https://fixture.invalid/v1"
protocol = "openai-chat-v1"
fallback = "duplicate"
[covel.duplicate]
provider = "fixture"
model = "duplicate"
baseUrl = "https://fixture.invalid/v1/"
protocol = "openai-chat-v1"
fallback = "independent"
[covel.independent]
provider = "${difference === "provider" ? "other" : "fixture"}"
model = "independent"
baseUrl = "https://${difference === "baseUrl" ? "other" : "fixture"}.invalid/v1"
protocol = "${difference === "apiKey" ? "anthropic-messages-v1" : "openai-chat-v1"}"
${interveningFailure ? 'fallback = "duplicate-again"' : ""}
[covel.duplicate-again]
provider = "fixture"
model = "duplicate-again"
baseUrl = "https://fixture.invalid/v1"
protocol = "openai-chat-v1"
fallback = "last"
[covel.last]
provider = "last"
model = "last"
baseUrl = "https://last.invalid/v1"
protocol = "openai-chat-v1"
`);
  const registration = {
    adapter,
    defaults: { apiKey: "failed-key" },
    protocols: {
      "anthropic-messages-v1": {
        adapter,
        defaults: { apiKey: "independent-key" },
      },
    },
  };
  const providerRegistry = createProviderRegistry({
    providers: {
      fixture: registration,
      other: registration,
      last: registration,
    },
  });
  const slotRegistry = createSlotRegistry();
  slotRegistry.configure({
    slots: Object.fromEntries(
      aiConfig.presets.map((p) => [
        p.defaultSlot!,
        { slotId: p.defaultSlot!, presetId: p.id, tag: p.tag! },
      ]),
    ),
  });
  const gateway = createGateway({
    providerRegistry,
    presetRegistry: createPresetRegistry(aiConfig),
    slotRegistry,
  });
  const input = {
    presetId: "primary",
    messages: [{ role: "user" as const, content: "hello" }],
  };
  const options = {
    onTargetAttempt: ({ model }: { model: string }) => {
      attempts.push(model);
    },
  };
  async function run(mode: Mode) {
    if (mode === "text") return gateway.generateText(input, options);
    if (mode === "object")
      return gateway.generateObject(
        { ...input, schema: z.object({ ok: z.boolean() }) },
        options,
      );
    const events = [];
    for await (const event of gateway.streamText(input, options))
      events.push(event);
    return events;
  }
  return { run, calls, attempts };
}

describe.each(["text", "object", "stream"] as const)(
  "%s account fallback",
  (mode) => {
    it.each([401, 402, 429])(
      "skips all same-account targets after HTTP %s and retains the original failure",
      async (status) => {
        const { run, calls, attempts } = setup(status, "none");
        const error = await run(mode).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(AiProviderError);
        expect(classifyProviderFailure(error).kind).toBe(
          status === 401 ? "auth" : "quota",
        );
        expect(error).toMatchObject({ model: "primary", statusCode: status });
        expect(String(error)).not.toContain("failed-key");
        expect(calls).toEqual(["primary"]);
        expect(attempts).toEqual(calls);
      },
    );

    it.each(["provider", "baseUrl", "apiKey"] as const)(
      "still tries a configured backup with a different %s",
      async (difference) => {
        const { run, calls, attempts } = setup(402, difference);
        await run(mode);
        expect(calls).toEqual(["primary", "independent"]);
        expect(attempts).toEqual(calls);
      },
    );

    it("remembers a failed account across another target's transient failure", async () => {
      const { run, calls } = setup(401, "provider", true);
      await run(mode);
      expect(calls).toEqual(["primary", "independent", "last"]);
    });

    it("does not skip the same account for a transient provider failure", async () => {
      const { run, calls } = setup(503, "none");
      await run(mode);
      expect(calls).toEqual(["primary", "duplicate"]);
    });

    it("does not carry failed credentials into a later logical call", async () => {
      const { run, calls } = setup(402, "provider");
      await run(mode);
      await run(mode);
      expect(calls).toEqual([
        "primary",
        "independent",
        "primary",
        "independent",
      ]);
    });
  },
);
