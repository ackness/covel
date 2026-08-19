import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type {
  ModelParameterOverrides,
  ProviderModelProfile,
  ReasoningEffortProfile,
} from "@/services/api.js";
import { parseNumericParameterOverride } from "../LlmAdvancedPane.js";
import { ProviderDetails } from "../llm-provider-details.js";
import {
  clearChangedSlotReasoningEfforts,
  pruneInvalidReasoningEffortOverride,
} from "../llm-reasoning-effort.js";

vi.mock("@/components/shared/ping-button.js", () => ({
  PingButton: () => null,
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
    getApiKey: vi.fn(() => ""),
    lookupModelCapabilityDetails: vi.fn(() => new Promise(() => undefined)),
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
