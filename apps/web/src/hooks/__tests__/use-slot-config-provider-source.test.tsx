import i18n from "@/i18n/index.js";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lookupModelCapabilityDetails } from "@/services/api.js";
import { useSlotConfig } from "@/hooks/use-slot-config.js";

const modelSettings = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  slotConfig: {} as Record<string, { presetId?: string; modelRef?: string }>,
  customPresets: [] as Array<{
    id: string;
    name: string;
    provider: string;
    source?: string;
    account?: string;
    baseUrl: string;
    model: string;
    protocol?: string;
  }>,
}));

vi.mock("@/settings/use-settings.js", () => ({
  useSetting: <T,>(key: string): [T, (value: T) => Promise<void>] => [
    modelSettings.values.get(key) as T,
    vi.fn(async () => undefined),
  ],
}));

vi.mock("@/services/api.js", () => ({
  lookupModelCapabilityDetails: vi.fn(async () => {
    throw new Error("No catalogue in this fixture");
  }),
  getSlotConfig: () => modelSettings.slotConfig,
  getCustomPresets: () => modelSettings.customPresets,
  slotBindingId: (
    entry: { presetId?: string; modelRef?: string } | null | undefined,
  ) => entry?.modelRef ?? entry?.presetId,
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  modelSettings.values.clear();
  modelSettings.slotConfig = {};
  modelSettings.customPresets = [];
});

describe("useSlotConfig provider source credentials", () => {
  it.each([true, false])(
    "uses provider-source readiness (%s) even for loopback URLs without requiring a local API key",
    async (ready) => {
      modelSettings.slotConfig = { story: { modelRef: "sub-model-ref" } };
      modelSettings.values.set("llm.slotConfig", modelSettings.slotConfig);
      modelSettings.customPresets = [
        {
          id: "sub-model-ref",
          name: "Sub Model",
          provider: "fake-sub",
          source: "fake-oauth-provider-source/fake-sub",
          account: "acct-1",
          baseUrl: "http://127.0.0.1:18765/backend-api",
          model: "sub-model",
          protocol: "openai-responses-v1",
        },
      ];
      vi.mocked(lookupModelCapabilityDetails).mockResolvedValueOnce({
        found: true,
        source: "known",
        pricingKind: "unknown",
        candidates: [],
        reasoning: null,
        capability: { input: ["text"], output: ["text"] },
        serverCredentialsAvailable: ready,
      });

      const { result } = renderHook(() =>
        useSlotConfig([], {
          configured: true,
          providers: [],
          slots: {},
        }),
      );

      await waitFor(() =>
        expect(
          result.current.resolvedSlots[0]?.preset?.serverCredentialsAvailable,
        ).toBe(ready),
      );
      expect(result.current.resolvedSlots[0]?.hasCredentials).toBe(ready);
      expect(vi.mocked(lookupModelCapabilityDetails)).toHaveBeenCalledWith(
        "sub-model",
        "fake-sub",
        "openai-responses-v1",
        undefined,
        expect.objectContaining({
          source: "fake-oauth-provider-source/fake-sub",
          account: "acct-1",
          baseUrl: "http://127.0.0.1:18765/backend-api",
        }),
      );
    },
  );

  it.each([true, false])(
    "uses server preset credentialSource.ready (%s) without local API keys",
    (ready) => {
      const serverPreset = {
        id: "server-sub",
        name: "Server Sub",
        provider: "fake-sub",
        source: "fake-oauth-provider-source/fake-sub",
        account: "acct-1",
        credentialSource: {
          sourceId: "fake-oauth-provider-source/fake-sub",
          accountId: "acct-1",
          ready,
          ...(ready ? {} : { reason: "not_signed_in" }),
        },
        model: "sub-model",
        baseUrl: "http://127.0.0.1:18765/backend-api",
        protocol: "openai-responses-v1",
        enabled: true,
        isDefault: true,
        scope: "global",
      };

      const { result } = renderHook(() =>
        useSlotConfig([serverPreset], {
          configured: true,
          providers: ["fake-sub"],
          slots: {
            story: {
              provider: "fake-sub",
              source: "fake-oauth-provider-source/fake-sub",
              account: "acct-1",
              credentialSource: serverPreset.credentialSource,
              model: "sub-model",
              baseUrl: "http://127.0.0.1:18765/backend-api",
              protocol: "openai-responses-v1",
              tag: "text",
              serverKeyConfigured: ready,
            },
          },
        }),
      );

      expect(result.current.resolvedSlots[0]?.hasCredentials).toBe(ready);
    },
  );
});
