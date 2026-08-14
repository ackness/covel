import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());

vi.mock("../request.js", () => ({
  request: requestMock,
}));

const {
  invalidateModelCapabilityCache,
  lookupModelCapabilityDetails,
  refreshModelDb,
} = await import("../llm.js");

const LOOKUP_RESULT = {
  found: true,
  source: "known",
  pricingKind: "provider",
  candidates: ["gpt-5.6-sol"],
  reasoning: null,
  capability: { contextWindow: 400_000 },
} as const;

function lookupReply() {
  return Promise.resolve(LOOKUP_RESULT);
}

describe("model capability lookup cache", () => {
  beforeEach(() => {
    requestMock.mockReset();
    invalidateModelCapabilityCache();
  });

  it("shares one request for concurrent and repeated lookups of the same target", async () => {
    requestMock.mockImplementation(lookupReply);

    const [first, second] = await Promise.all([
      lookupModelCapabilityDetails("gpt-5.6-sol", "openai"),
      lookupModelCapabilityDetails("gpt-5.6-sol", "openai"),
    ]);
    await lookupModelCapabilityDetails("gpt-5.6-sol", "openai");

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("keys the cache on provider and protocol", async () => {
    requestMock.mockImplementation(lookupReply);

    await lookupModelCapabilityDetails("deepseek-v4-flash");
    await lookupModelCapabilityDetails("deepseek-v4-flash", "deepseek");
    await lookupModelCapabilityDetails(
      "deepseek-v4-flash",
      "deepseek",
      "openai-chat-v1",
    );

    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("keeps tuple keys distinct when a value contains the old delimiter", async () => {
    requestMock.mockImplementation(lookupReply);

    await lookupModelCapabilityDetails("d", "a", "b\u0000c");
    await lookupModelCapabilityDetails("d", "a\u0000b", "c");

    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed request instead of caching the rejection", async () => {
    requestMock
      .mockRejectedValueOnce(new Error("network down"))
      .mockImplementationOnce(lookupReply);

    await expect(lookupModelCapabilityDetails("grok-4", "xai")).rejects.toThrow(
      "network down",
    );
    await expect(lookupModelCapabilityDetails("grok-4", "xai")).resolves.toBe(
      LOOKUP_RESULT,
    );
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it("drops cached lookups after a model-db refresh", async () => {
    requestMock.mockImplementation((url: string) =>
      url.startsWith("/api/model-db/refresh")
        ? Promise.resolve({ ok: true, count: 3000 })
        : lookupReply(),
    );

    await lookupModelCapabilityDetails("gpt-5.6-sol", "openai");
    await refreshModelDb();
    await lookupModelCapabilityDetails("gpt-5.6-sol", "openai");

    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it("does not let a stale rejection evict a newer lookup", async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: (value: typeof LOOKUP_RESULT) => void;
    requestMock
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      )
      .mockImplementation(lookupReply);

    const stale = lookupModelCapabilityDetails("grok-4", "xai");
    invalidateModelCapabilityCache();
    const current = lookupModelCapabilityDetails("grok-4", "xai");

    rejectFirst(new Error("stale failure"));
    await expect(stale).rejects.toThrow("stale failure");
    const repeated = lookupModelCapabilityDetails("grok-4", "xai");
    resolveSecond(LOOKUP_RESULT);

    await expect(Promise.all([current, repeated])).resolves.toEqual([
      LOOKUP_RESULT,
      LOOKUP_RESULT,
    ]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });
});
