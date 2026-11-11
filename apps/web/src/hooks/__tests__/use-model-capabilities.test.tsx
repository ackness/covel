import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useModelCapabilities } from "../use-model-capabilities.js";
import type { ModelCapabilityLookupResult } from "@/services/api.js";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/services/api.js", () => ({ lookupModelCapabilityDetails: lookup }));
const result = (ready: boolean): ModelCapabilityLookupResult => ({
  found: true,
  source: "known",
  pricingKind: "unknown",
  candidates: [],
  reasoning: null,
  capability: { input: ["text"], output: ["text"] },
  serverCredentialsAvailable: ready,
});
const model = {
  provider: "openai",
  model: "gpt-4o",
  protocol: "openai-chat-v1",
  scope: "custom",
  baseUrl: "https://one.example/v1",
};

beforeEach(() => {
  lookup.mockReset();
});
describe("custom connection credential projection", () => {
  it("reuses a model lookup for the exact connection and its readiness", async () => {
    lookup.mockResolvedValue(result(true));
    const { result: hook } = renderHook(() =>
      useModelCapabilities([model], "config-1"),
    );
    await waitFor(() =>
      expect(hook.current[0]?.serverCredentialsAvailable).toBe(true),
    );
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(
      "gpt-4o",
      "openai",
      "openai-chat-v1",
      undefined,
      { baseUrl: model.baseUrl, revision: "config-1" },
    );
  });

  it("never applies an old origin's result after the connection changes", async () => {
    let settleOld!: (value: ModelCapabilityLookupResult) => void;
    lookup.mockImplementationOnce(
      () =>
        new Promise<ModelCapabilityLookupResult>((resolve) => {
          settleOld = resolve;
        }),
    );
    lookup.mockResolvedValueOnce(result(false));
    const { result: hook, rerender } = renderHook(
      ({ baseUrl }) => useModelCapabilities([{ ...model, baseUrl }]),
      { initialProps: { baseUrl: model.baseUrl } },
    );
    rerender({ baseUrl: "https://two.example/v1" });
    await waitFor(() =>
      expect(hook.current[0]?.serverCredentialsAvailable).toBe(false),
    );
    await act(async () => {
      settleOld(result(true));
    });
    expect(hook.current[0]?.serverCredentialsAvailable).toBe(false);
  });

  it("keeps a failed projection unknown without discarding authored capabilities", async () => {
    let rejectLookup!: (reason: unknown) => void;
    lookup.mockReturnValue(
      new Promise<ModelCapabilityLookupResult>((_resolve, reject) => {
        rejectLookup = reject;
      }),
    );
    const capability = { input: ["text" as const], output: ["text" as const] };
    const { result: hook } = renderHook(() =>
      useModelCapabilities([{ ...model, capability }]),
    );
    await act(async () => rejectLookup(new Error("offline")));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hook.current[0]?.capability).toBe(capability);
    expect(hook.current[0]?.serverCredentialsAvailable).toBeUndefined();
  });
});
