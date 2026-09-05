import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SettingsStore, type SettingsStoreApi } from "@covel/settings";
import type { PresetSummary } from "@/services/api.js";
import i18n from "@/i18n";
import { LlmPresetsPane } from "../LlmPresetsPane.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStoreApi,
  lookup: vi.fn(),
  presets: [
    {
      id: "configured",
      name: "Example",
      provider: "example",
      model: "opaque-model",
      protocol: "anthropic-v1",
      baseUrl: "https://example.invalid",
      enabled: true,
      isDefault: true,
      scope: "global",
    },
  ] as PresetSummary[],
}));
vi.mock("@/settings/store", () => ({
  getSettings: () => mocks.store,
  registerKnownProviders: vi.fn(),
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      presets: mocks.presets,
      llmConfig: { configured: true, slots: {} },
    },
  }),
}));
vi.mock("@/components/shared/ping-button.js", () => ({
  PingButton: () => <button>Test model</button>,
  invalidateAllPingResults: vi.fn(),
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  lookupModelCapabilityDetails: mocks.lookup,
}));

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  let entries: Record<string, unknown> = {};
  const store = new SettingsStore({
    load: async () => entries,
    save: async (next) => {
      entries = next;
    },
    loadSecrets: async () => ({ example: "test-secret" }),
    saveSecrets: async () => undefined,
  });
  store.register({
    key: "keys.example",
    schema: z.string(),
    default: "",
    group: "llm",
    label: "Example key",
    backend: "keys",
  });
  await store.init();
  mocks.store = store;
  mocks.lookup.mockReset().mockResolvedValue({
    found: false,
    source: "protocol-default",
    pricingKind: "unknown",
    candidates: [],
    reasoning: null,
    capability: {
      input: ["text"],
      output: ["text"],
      contextWindow: 8192,
      maxOutputTokens: 4096,
    },
  });
});

describe("provider configuration flow", () => {
  it("has one model test and queries capabilities with the configured protocol", async () => {
    render(<LlmPresetsPane />);
    expect(screen.getAllByRole("button", { name: "Test model" })).toHaveLength(
      1,
    );
    await waitFor(() =>
      expect(mocks.lookup).toHaveBeenCalledWith(
        "opaque-model",
        "example",
        "anthropic-v1",
      ),
    );
    expect(await screen.findByText("Model limits unknown")).toBeTruthy();
    expect(screen.queryByText(/8,192 ctx/)).toBeNull();
  });

  it("switches between a full-width provider list and details on narrow screens", () => {
    const { container } = render(<LlmPresetsPane />);
    const aside = container.querySelector("aside")!;
    const main = container.querySelector("main")!;
    expect(aside.parentElement?.className).toContain("grid-cols-1");
    expect(main.className).toContain("hidden lg:block");
    fireEvent.click(screen.getByRole("button", { name: /example.*1 models/ }));
    expect(aside.className).toContain("hidden lg:flex");
    expect(main.className).not.toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "All providers" }));
    expect(aside.className).not.toContain("hidden");
    expect(main.className).toContain("hidden lg:block");
  });
});
