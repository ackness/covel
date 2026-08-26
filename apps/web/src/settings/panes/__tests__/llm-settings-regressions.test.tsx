import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type {
  ModelParameterOverrides,
  ProviderModelProfile,
  ReasoningEffortProfile,
} from "@/services/api.js";
import {
  LlmAdvancedPane,
  parseNumericParameterOverride,
} from "../LlmAdvancedPane.js";
import { ProviderDetails } from "../llm-provider-details.js";
import {
  clearChangedSlotReasoningEfforts,
  pruneInvalidReasoningEffortOverride,
} from "../llm-reasoning-effort.js";

vi.mock("@/components/shared/ping-button.js", () => ({
  PingButton: () => null,
}));

const apiMocks = vi.hoisted(() => ({
  getParamOverrides: vi.fn(),
  getProviderProfiles: vi.fn(),
  getSlotConfig: vi.fn(),
  lookupModelCapabilityDetails: vi.fn(),
  setParamOverrides: vi.fn(),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      llmConfig: {
        configured: true,
        slots: {
          story: { provider: "openai", model: "story-model" },
          fast: { provider: "deepseek", model: "fast-model" },
        },
      },
      presets: [],
    },
  }),
}));

vi.mock("../LlmKeysPane.js", () => ({
  LlmKeysPane: ({ providerId }: { providerId: string }) => (
    <span data-testid="key-namespace">{providerId}</span>
  ),
}));

vi.mock("@/services/api.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/api.js")>();
  return {
    ...original,
    getParamOverrides: apiMocks.getParamOverrides,
    getProviderProfiles: apiMocks.getProviderProfiles,
    getSlotConfig: apiMocks.getSlotConfig,
    getApiKey: vi.fn(() => ""),
    lookupModelCapabilityDetails: apiMocks.lookupModelCapabilityDetails,
    setParamOverrides: apiMocks.setParamOverrides,
  };
});

const profile = (options: ReasoningEffortProfile["options"]) =>
  ({
    family: "openai",
    defaultValue: options[0]?.value,
    options,
  }) satisfies ReasoningEffortProfile;

describe("LLM settings regressions", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    apiMocks.getParamOverrides.mockReset().mockReturnValue({});
    apiMocks.getProviderProfiles.mockReset().mockReturnValue([]);
    apiMocks.getSlotConfig.mockReset().mockReturnValue({});
    apiMocks.lookupModelCapabilityDetails
      .mockReset()
      .mockImplementation(() => new Promise(() => undefined));
    apiMocks.setParamOverrides.mockReset();
  });

  it("removes a reasoning override that the newly bound model cannot use", () => {
    const overrides: Record<string, ModelParameterOverrides> = {
      story: { temperature: 0.7, reasoningEffort: "xhigh" },
    };

    expect(
      pruneInvalidReasoningEffortOverride(
        overrides,
        "story",
        profile([{ value: "high" }]),
      ),
    ).toEqual({ story: { temperature: 0.7 } });
    expect(
      pruneInvalidReasoningEffortOverride(overrides, "story", undefined),
    ).toBe(overrides);
    expect(
      pruneInvalidReasoningEffortOverride(
        overrides,
        "story",
        profile([{ value: "xhigh" }]),
      ),
    ).toBe(overrides);
  });

  it("clears reasoning synchronously when a slot binding changes", () => {
    const overrides: Record<string, ModelParameterOverrides> = {
      story: { temperature: 0.7, reasoningEffort: "xhigh" },
      fast: { reasoningEffort: "low" },
    };

    expect(
      clearChangedSlotReasoningEfforts(
        {
          story: { modelRef: "old-model" },
          fast: { modelRef: "unchanged-model" },
        },
        {
          story: { modelRef: "new-model" },
          fast: { modelRef: "unchanged-model" },
        },
        overrides,
      ),
    ).toEqual({
      story: { temperature: 0.7 },
      fast: { reasoningEffort: "low" },
    });
  });

  it("treats an empty numeric field as the provider default", () => {
    expect(parseNumericParameterOverride("", -2, 2)).toBeUndefined();
    expect(parseNumericParameterOverride("  ", -2, 2)).toBeUndefined();
    expect(parseNumericParameterOverride("5", -2, 2)).toBe(2);
    expect(parseNumericParameterOverride("-5", -2, 2)).toBe(-2);
    expect(parseNumericParameterOverride("invalid", -2, 2)).toBeUndefined();
  });

  it("waits for the selected target profile before pruning its override", async () => {
    apiMocks.getParamOverrides.mockReturnValue({
      fast: { reasoningEffort: "max" },
    });
    let resolveFastLookup: ((value: unknown) => void) | undefined;
    apiMocks.lookupModelCapabilityDetails.mockImplementation((model) => {
      if (model === "story-model") {
        return Promise.resolve({
          reasoning: profile([{ value: "high" }]),
        });
      }
      return new Promise((resolve) => {
        resolveFastLookup = resolve;
      });
    });

    render(<LlmAdvancedPane />);
    await waitFor(() =>
      expect(apiMocks.lookupModelCapabilityDetails).toHaveBeenCalledWith(
        "story-model",
        "openai",
        undefined,
      ),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Reasoning effort") as HTMLSelectElement)
          .disabled,
      ).toBe(false),
    );

    fireEvent.change(screen.getByLabelText("Select Slot"), {
      target: { value: "fast" },
    });

    expect(apiMocks.setParamOverrides).not.toHaveBeenCalled();

    await act(async () => {
      resolveFastLookup?.({
        reasoning: profile([{ value: "max" }]),
      });
    });
    expect(apiMocks.setParamOverrides).not.toHaveBeenCalled();
  });

  it("preserves a reasoning override when capability lookup fails", async () => {
    apiMocks.getParamOverrides.mockReturnValue({
      story: { reasoningEffort: "max" },
    });
    apiMocks.lookupModelCapabilityDetails.mockRejectedValue(
      new Error("lookup unavailable"),
    );

    render(<LlmAdvancedPane />);

    await waitFor(() =>
      expect(apiMocks.lookupModelCapabilityDetails).toHaveBeenCalledWith(
        "story-model",
        "openai",
        undefined,
      ),
    );
    await act(async () => undefined);
    expect(apiMocks.setParamOverrides).not.toHaveBeenCalled();
  });

  it("keeps the base URL as a draft and commits it once on blur", () => {
    const onPatchLocalProfile = vi.fn();
    const localProfile: ProviderModelProfile = {
      id: "openai-second-connection",
      provider: "openai",
      name: "OpenAI proxy",
      baseUrl: "https://old.example/v1",
      protocol: "openai-chat-v1",
      models: [],
    };
    render(
      <ProviderDetails
        provider={{
          id: "openai-second-connection",
          provider: "openai",
          baseUrl: localProfile.baseUrl,
          protocol: "openai-chat-v1",
          serverModels: [],
          localProfile,
        }}
        onAddModel={vi.fn()}
        onPatchLocalProfile={onPatchLocalProfile}
        onDeleteLocalModel={vi.fn()}
        onDeleteLocalProvider={vi.fn()}
      />,
    );

    expect(screen.getByTestId("key-namespace").textContent).toBe(
      "openai-second-connection",
    );

    const input = screen.getByLabelText("API endpoint");
    fireEvent.change(input, { target: { value: "https://new" } });
    fireEvent.change(input, { target: { value: "https://new.example/v1" } });
    expect(onPatchLocalProfile).not.toHaveBeenCalled();

    fireEvent.blur(input);
    expect(onPatchLocalProfile).toHaveBeenCalledTimes(1);
    expect(onPatchLocalProfile).toHaveBeenCalledWith({
      baseUrl: "https://new.example/v1",
    });
  });
});
