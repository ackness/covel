import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import i18n from "@/i18n";
import { registerLlmSettings } from "../../registry/llm.js";
import { LlmSlotsPane } from "../LlmSlotsPane.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStore,
  toast: vi.fn(),
}));

vi.mock("@/settings/store", () => ({
  getSettings: () => mocks.store,
  registerKnownProviders: vi.fn(),
}));
vi.mock("@/lib/toast-channel.js", () => ({ emitToast: mocks.toast }));
vi.mock("../use-model-capability.js", () => ({
  useModelCapability: () => undefined,
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  fetchModelDbInfo: async () => ({ available: false, count: 0 }),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      presets: [
        {
          id: "detailed",
          name: "Detailed",
          provider: "fixture",
          model: "detailed-model",
          protocol: "openai-chat-v1",
        },
      ],
      plugins: [],
      llmConfig: {
        configured: true,
        slots: {
          story: {
            provider: "fixture",
            model: "base-model",
            protocol: "openai-chat-v1",
          },
        },
      },
    },
  }),
}));

const initialSlots = {
  story: { modelRef: "quick" },
  fast: { presetId: "detailed" },
};
const initialParams = {
  story: { temperature: 0.4, reasoningEffort: "high" },
  fast: { reasoningEffort: "low" },
};
let persisted: Record<string, unknown>;
const save = vi.fn(async (next: Record<string, unknown>) => {
  persisted = structuredClone(next);
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
}

function modelPicker() {
  return within(screen.getByRole("group", { name: "story" })).getByRole(
    "combobox",
    { name: "Model configuration" },
  ) as HTMLSelectElement;
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  mocks.toast.mockReset();
  persisted = {
    "llm.providers": [
      {
        id: "fixture",
        name: "Fixture",
        baseUrl: "https://fixture.invalid",
        protocol: "openai-chat-v1",
        models: [{ ref: "quick", modelId: "quick-model", name: "Quick" }],
      },
    ],
    "llm.slotConfig": structuredClone(initialSlots),
    "llm.paramOverrides": structuredClone(initialParams),
  };
  save.mockReset().mockImplementation(async (next) => {
    persisted = structuredClone(next);
  });
  mocks.store = new SettingsStore({
    load: async () => structuredClone(persisted),
    save,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  registerLlmSettings(mocks.store);
  await mocks.store.init();
});

describe("model role persistence", () => {
  it("confirms the selection only after one atomic binding and reasoning save", async () => {
    const pending = deferred();
    save.mockImplementationOnce(async (next) => {
      await pending.promise;
      persisted = structuredClone(next);
    });
    const { unmount } = render(<LlmSlotsPane />);
    fireEvent.change(modelPicker(), { target: { value: "preset:detailed" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect.soft(modelPicker().value).toBe("model:quick");
    expect.soft(save.mock.calls[0]?.[0]).toMatchObject({
      "llm.slotConfig": {
        story: { presetId: "detailed" },
        fast: initialSlots.fast,
      },
      "llm.paramOverrides": {
        story: { temperature: 0.4 },
        fast: initialParams.fast,
      },
    });
    expect(persisted["llm.slotConfig"]).toEqual(initialSlots);
    expect(persisted["llm.paramOverrides"]).toEqual(initialParams);
    await act(async () => pending.resolve());
    await waitFor(() => expect(modelPicker().value).toBe("preset:detailed"));
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
    render(<LlmSlotsPane />);
    expect(modelPicker().value).toBe("preset:detailed");
  });

  it("retains the old binding and all parameters when a delayed save fails", async () => {
    const pending = deferred();
    save.mockImplementationOnce(async () => pending.promise);
    render(<LlmSlotsPane />);
    fireEvent.change(modelPicker(), { target: { value: "preset:detailed" } });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await act(async () => pending.reject(new Error("synthetic save failure")));
    expect.soft(modelPicker().value).toBe("model:quick");
    expect.soft(mocks.store.get("llm.slotConfig")).toEqual(initialSlots);
    expect.soft(mocks.store.get("llm.paramOverrides")).toEqual(initialParams);
    expect.soft(persisted["llm.slotConfig"]).toEqual(initialSlots);
    expect.soft(persisted["llm.paramOverrides"]).toEqual(initialParams);
    expect
      .soft(mocks.toast)
      .toHaveBeenCalledWith("error", i18n.t("settings.saveFailed"));
    expect
      .soft(screen.queryByRole("alert")?.textContent)
      .toContain(i18n.t("settings.saveFailed"));
    expect(save).toHaveBeenCalledTimes(1);

    fireEvent.change(modelPicker(), { target: { value: "preset:detailed" } });
    await waitFor(() => expect(modelPicker().value).toBe("preset:detailed"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(persisted["llm.paramOverrides"]).toEqual({
      story: { temperature: 0.4 },
      fast: initialParams.fast,
    });
  });

  it("resets the binding and its reasoning override together while retaining other roles", async () => {
    render(<LlmSlotsPane />);
    fireEvent.click(
      within(screen.getByRole("group", { name: "story" })).getByRole("button", {
        name: "Reset",
      }),
    );
    await waitFor(() => expect(modelPicker().value).toBe("__base"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(persisted["llm.slotConfig"]).toEqual({ fast: initialSlots.fast });
    expect(persisted["llm.paramOverrides"]).toEqual({
      story: { temperature: 0.4 },
      fast: initialParams.fast,
    });
  });
});
