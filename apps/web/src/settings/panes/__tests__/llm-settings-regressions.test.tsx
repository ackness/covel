import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type {
  ModelParameterOverrides,
  ProviderModelProfile,
  ReasoningEffortProfile,
  PresetSummary,
  SlotConfigEntry,
} from "@/services/api.js";
import {
  LlmAdvancedPane,
  parseNumericParameterOverride,
} from "../LlmAdvancedPane.js";
import { ProviderDetails } from "../llm-provider-details.js";
import { LlmSlotCard } from "../llm-slot-card.js";
import { collectLlmSlotPresetCandidates } from "../llm-slots-model.js";
import {
  clearChangedSlotReasoningEfforts,
  pruneInvalidReasoningEffortOverride,
} from "../llm-reasoning-effort.js";

vi.mock("@/components/shared/ping-button.js", () => ({
  PingButton: ({ target }: { target: unknown }) => (
    <output data-testid="ping-target">{JSON.stringify(target)}</output>
  ),
}));

const apiMocks = vi.hoisted(() => ({
  getParamOverrides: vi.fn(),
  getProviderProfiles: vi.fn(),
  getSlotConfig: vi.fn(),
  lookupModelCapabilityDetails: vi.fn(),
  setParamOverrides: vi.fn(),
  getCapabilityOverrides: vi.fn(),
  setCapabilityOverrides: vi.fn(),
  setSlotConfig: vi.fn(),
  serverPresets: [] as PresetSummary[],
  serverParameters: undefined as ModelParameterOverrides | undefined,
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      llmConfig: {
        configured: true,
        slots: {
          story: {
            provider: "openai",
            model: "story-model",
            parameterOverrides: apiMocks.serverParameters,
            capability: {
              input: ["text"],
              output: ["text"],
              contextWindow: 1_000_000,
              maxOutputTokens: 384_000,
            },
          },
          fast: { provider: "deepseek", model: "fast-model" },
        },
      },
      presets: apiMocks.serverPresets,
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
    getCapabilityOverrides: apiMocks.getCapabilityOverrides,
    setCapabilityOverrides: apiMocks.setCapabilityOverrides,
    setSlotConfig: apiMocks.setSlotConfig,
  };
});

vi.mock("@/settings/use-settings.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/settings/use-settings.js")>();
  return {
    ...original,
    useSetting: (key: string) =>
      key === "llm.slotConfig"
        ? [apiMocks.getSlotConfig(), apiMocks.setSlotConfig]
        : original.useSetting(key),
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
    apiMocks.getCapabilityOverrides.mockReset().mockReturnValue({});
    apiMocks.setCapabilityOverrides.mockReset();
    apiMocks.serverPresets = [];
    apiMocks.serverParameters = undefined;
    apiMocks.setSlotConfig.mockReset();
  });

  it("allows evaluation models for a newly discovered custom role without imposing text capability", () => {
    const commitSlot = vi.fn();
    render(
      <LlmSlotCard
        slotId="npc-choice"
        slotConfig={{}}
        serverSlot={undefined}
        allPresets={collectLlmSlotPresetCandidates(
          [],
          [
            {
              id: "jev-config",
              name: "Jev",
              provider: "typesafe",
              model: "jev-latest",
              protocol: "typesafe-systemone-v1",
            },
          ],
        )}
        capOverride={undefined}
        isConfigured
        isFirst={false}
        isDiscovered
        isEditing={false}
        commitSlot={commitSlot}
        onToggleEditing={() => undefined}
        onResetCapability={() => undefined}
        onUpdateCapability={() => undefined}
      />,
    );
    const provider = screen.getByRole("combobox", {
      name: "Provider",
    }) as HTMLSelectElement;
    expect([...provider.options].map((option) => option.value)).toContain(
      "typesafe",
    );
    fireEvent.change(provider, { target: { value: "typesafe" } });
    expect(commitSlot).toHaveBeenCalledWith({
      "npc-choice": { modelRef: "jev-config" },
    });
  });

  it("keeps a missing local binding visible for deliberate reselection or reset", () => {
    const commitSlot = vi.fn();
    const serverSlot = {
      provider: "fixture",
      model: "server-model",
      protocol: "openai-chat-v1",
      tag: "text",
    };
    render(
      <LlmSlotCard
        slotId="story"
        slotConfig={{ story: { modelRef: "missing" } }}
        serverSlot={serverSlot}
        allPresets={collectLlmSlotPresetCandidates(
          [
            {
              id: "missing",
              name: "Server replacement",
              provider: "fixture",
              model: "server-model",
            },
          ],
          [],
        )}
        capOverride={undefined}
        isConfigured
        isFirst={false}
        isDiscovered={false}
        isEditing={false}
        commitSlot={commitSlot}
        onToggleEditing={() => undefined}
        onResetCapability={() => undefined}
        onUpdateCapability={() => undefined}
      />,
    );
    expect(apiMocks.lookupModelCapabilityDetails).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "selected model is unavailable",
    );
    const models = screen.getByRole("combobox", {
      name: "Model configuration",
    }) as HTMLSelectElement;
    expect(models.value).toBe("model:missing");
    expect(commitSlot).not.toHaveBeenCalled();
    fireEvent.change(models, { target: { value: "preset:missing" } });
    expect(commitSlot).toHaveBeenLastCalledWith({
      story: { presetId: "missing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(commitSlot).toHaveBeenLastCalledWith({});
  });

  it("does not borrow server capabilities or parameters for a missing local binding", () => {
    apiMocks.serverParameters = {
      maxOutputTokens: 12345,
      temperature: 0.4,
      reasoningEffort: "high",
    };
    apiMocks.getSlotConfig.mockReturnValue({
      story: { modelRef: "missing" },
      fast: { presetId: "kept" },
    });
    render(<LlmAdvancedPane />);
    expect(apiMocks.lookupModelCapabilityDetails).not.toHaveBeenCalled();
    expect(screen.queryByText("story-model", { exact: true })).toBeNull();
    expect(screen.queryByText("12,345", { exact: true })).toBeNull();
    expect(screen.queryByText(/384,000/)).toBeNull();
    expect(
      (
        screen.getByRole("spinbutton", {
          name: "Temperature",
        }) as HTMLInputElement
      ).value,
    ).toBe("1");
    expect(apiMocks.setSlotConfig).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset model binding" }),
    );
    expect(apiMocks.setSlotConfig).toHaveBeenCalledWith({
      fast: { presetId: "kept" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "selected model is unavailable",
    );
  });

  it("selects same-named local and server role models without collapsing their identity", () => {
    const commit = vi.fn();
    const allPresets = collectLlmSlotPresetCandidates(
      [
        {
          id: "same",
          name: "Server configuration",
          provider: "fixture",
          model: "server-model",
        },
      ],
      [
        {
          id: "same",
          name: "Local configuration",
          provider: "fixture",
          model: "local-model",
        },
      ],
    );
    function Role() {
      const [slots, setSlots] = useState<Record<string, SlotConfigEntry>>({
        story: { modelRef: "same" },
      });
      return (
        <LlmSlotCard
          slotId="story"
          slotConfig={slots}
          serverSlot={undefined}
          allPresets={allPresets}
          capOverride={undefined}
          isConfigured={false}
          isFirst={false}
          isDiscovered={false}
          isEditing={false}
          commitSlot={(next) => {
            commit(next);
            setSlots(next);
          }}
          onToggleEditing={() => undefined}
          onResetCapability={() => undefined}
          onUpdateCapability={() => undefined}
        />
      );
    }
    render(<Role />);
    const models = screen.getByRole("combobox", {
      name: "Model configuration",
    });
    expect((models as HTMLSelectElement).value).toBe("model:same");
    fireEvent.change(models, { target: { value: "preset:same" } });
    expect(commit).toHaveBeenLastCalledWith({ story: { presetId: "same" } });
    expect((models as HTMLSelectElement).value).toBe("preset:same");
    fireEvent.change(models, { target: { value: "model:same" } });
    expect(commit).toHaveBeenLastCalledWith({ story: { modelRef: "same" } });
    expect((models as HTMLSelectElement).value).toBe("model:same");
  });

  it("uses the bound namespace for generation settings and model metadata", async () => {
    apiMocks.serverPresets = [
      {
        id: "same",
        name: "Server",
        provider: "fixture",
        model: "server-model",
        enabled: true,
        isDefault: false,
        scope: "server",
      },
    ];
    apiMocks.getProviderProfiles.mockReturnValue([
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid",
        models: [{ ref: "same", modelId: "local-model" }],
      },
    ]);
    apiMocks.getSlotConfig.mockReturnValue({ story: { modelRef: "same" } });
    const { rerender } = render(<LlmAdvancedPane />);
    await waitFor(() =>
      expect(apiMocks.lookupModelCapabilityDetails).toHaveBeenLastCalledWith(
        "local-model",
        "fixture",
        "openai-chat-v1",
      ),
    );
    expect(screen.getByText("local-model", { exact: true })).toBeTruthy();
    apiMocks.getSlotConfig.mockReturnValue({ story: { presetId: "same" } });
    rerender(<LlmAdvancedPane />);
    await waitFor(() =>
      expect(apiMocks.lookupModelCapabilityDetails).toHaveBeenLastCalledWith(
        "server-model",
        "fixture",
        "openai-chat-v1",
      ),
    );
    expect(screen.getByText("server-model", { exact: true })).toBeTruthy();
  });

  it("pings local provider rows as models and server rows as presets", () => {
    render(
      <ProviderDetails
        provider={{
          id: "fixture",
          provider: "fixture",
          baseUrl: "https://fixture.invalid",
          protocol: "openai-chat-v1",
          serverModels: [
            {
              id: "same",
              name: "Server configuration",
              provider: "fixture",
              model: "server-model",
              enabled: true,
              isDefault: false,
              scope: "server",
            },
          ],
          localProfile: {
            id: "fixture",
            name: "Fixture",
            baseUrl: "https://fixture.invalid",
            models: [
              {
                ref: "same",
                name: "Local configuration",
                modelId: "local-model",
              },
            ],
          },
        }}
        onAddModel={() => undefined}
        onPatchLocalProfile={() => undefined}
        onDeleteLocalModel={() => undefined}
        onDuplicateLocalModel={() => undefined}
        onDeleteLocalProvider={() => undefined}
      />,
    );
    expect(
      within(
        screen.getByRole("group", { name: "Local configuration" }),
      ).getByTestId("ping-target").textContent,
    ).toBe(JSON.stringify({ kind: "model", modelRef: "same" }));
    expect(
      within(
        screen.getByRole("group", { name: "Server configuration" }),
      ).getByTestId("ping-target").textContent,
    ).toBe(JSON.stringify({ kind: "preset", presetId: "same" }));
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

  it("clears model-specific reasoning when a same-named binding changes namespace", () => {
    expect(
      clearChangedSlotReasoningEfforts(
        { story: { modelRef: "same" } },
        { story: { presetId: "same" } },
        { story: { reasoningEffort: "high", temperature: 0.2 } },
      ),
    ).toEqual({ story: { temperature: 0.2 } });
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

  it("resets generation and token overrides without clearing other model capabilities", () => {
    apiMocks.getParamOverrides.mockReturnValue({
      story: { maxOutputTokens: 32768 },
    });
    apiMocks.getCapabilityOverrides.mockReturnValue({
      story: {
        contextWindow: 128000,
        maxOutputTokens: 65536,
        features: ["vision"],
        pricing: { inputPerMToken: 1 },
      },
    });
    render(<LlmAdvancedPane />);
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(apiMocks.setParamOverrides).toHaveBeenCalledWith({});
    expect(apiMocks.setCapabilityOverrides).toHaveBeenCalledWith({
      story: { features: ["vision"], pricing: { inputPerMToken: 1 } },
    });
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
        "openai-chat-v1",
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
        "openai-chat-v1",
      ),
    );
    await act(async () => undefined);
    expect(apiMocks.setParamOverrides).not.toHaveBeenCalled();
  });

  it("does not display the previous slot's output limit for an unknown bound model", async () => {
    apiMocks.getProviderProfiles.mockReturnValue([
      {
        id: "ali-coding-plan",
        name: "Ali",
        baseUrl: "https://example.invalid",
        protocol: "openai-chat-v1",
        models: [{ ref: "local-qwen", modelId: "qwen3.8-flash" }],
      },
    ]);
    apiMocks.getSlotConfig.mockReturnValue({
      story: { modelRef: "local-qwen" },
    });
    apiMocks.lookupModelCapabilityDetails.mockResolvedValue({
      found: false,
      source: "protocol-default",
      pricingKind: "unknown",
      candidates: [],
      reasoning: null,
      capability: {
        input: ["text"],
        output: ["text"],
        contextWindow: 32768,
        maxOutputTokens: 4096,
      },
    });
    render(<LlmAdvancedPane />);
    await waitFor(() =>
      expect(apiMocks.lookupModelCapabilityDetails).toHaveBeenCalledWith(
        "qwen3.8-flash",
        "ali-coding-plan",
        "openai-chat-v1",
      ),
    );
    expect(screen.getByText("qwen3.8-flash")).toBeTruthy();
    expect(
      screen
        .getByRole("spinbutton", { name: "Max Output Tokens" })
        .getAttribute("max"),
    ).toBe("1000000");
    expect(screen.getByText("Model limits unknown")).toBeTruthy();
    expect(screen.queryByText(/384,000/)).toBeNull();
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
        onDuplicateLocalModel={vi.fn()}
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

  it("keeps an endpoint draft and requires review when its saved value changes", () => {
    const patch = vi.fn();
    const provider = {
      id: "example",
      provider: "example",
      baseUrl: "https://old.example",
      protocol: "openai-chat-v1",
      serverModels: [],
      localProfile: {
        id: "example",
        name: "Example",
        baseUrl: "https://old.example",
        protocol: "openai-chat-v1",
        models: [],
      },
    };
    const renderDetails = (baseUrl: string) => (
      <ProviderDetails
        provider={{
          ...provider,
          localProfile: { ...provider.localProfile, baseUrl },
        }}
        onAddModel={vi.fn()}
        onPatchLocalProfile={patch}
        onDeleteLocalModel={vi.fn()}
        onDuplicateLocalModel={vi.fn()}
        onDeleteLocalProvider={vi.fn()}
      />
    );
    const view = render(renderDetails("https://old.example"));
    const input = screen.getByLabelText("API endpoint");
    fireEvent.change(input, { target: { value: "https://draft.example" } });
    view.rerender(renderDetails("https://remote.example"));
    fireEvent.blur(input);
    expect(patch).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("https://draft.example");
    fireEvent.click(screen.getByRole("button", { name: "Reload saved value" }));
    expect((input as HTMLInputElement).value).toBe("https://remote.example");
  });
});
