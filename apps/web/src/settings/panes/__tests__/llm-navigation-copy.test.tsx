import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import i18n from "@/i18n";
import { registerLlmSettings } from "../../registry/llm.js";
import { buildNavTree } from "../../navigation.js";
import { LlmSlotsPane } from "../LlmSlotsPane.js";

const mocks = vi.hoisted(() => ({ store: null as unknown as SettingsStore }));
vi.mock("@/settings/store", () => ({
  getSettings: () => mocks.store,
  registerKnownProviders: vi.fn(),
}));
vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  fetchModelDbInfo: async () => ({ available: false, count: 0 }),
}));
vi.mock("@/hooks/use-model-capabilities.js", () => ({
  useModelCapabilities: () => [],
}));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      presets: [],
      plugins: [],
      llmConfig: { configured: true, slots: {} },
    },
  }),
}));
afterEach(cleanup);
beforeEach(async () => {
  mocks.store = new SettingsStore({
    load: async () => ({}),
    save: async () => undefined,
    loadSecrets: async () => ({}),
    saveSecrets: async () => undefined,
  });
  registerLlmSettings(mocks.store);
  await mocks.store.init();
});

describe("LlmSlotsPane connectivity navigation copy", () => {
  it.each([
    [
      "en-US",
      "Model connectivity tests are available on the Providers & Models page.",
    ],
    [
      "ru-RU",
      "Проверить подключение к модели можно на странице «Провайдеры и модели».",
    ],
  ])(
    "directs %s readers to the current providers navigation, not a retired API keys pane",
    async (locale, expectedHint) => {
      await i18n.changeLanguage(locale);
      render(<LlmSlotsPane />);
      const summary = screen.getByText(i18n.t("settings.slotNotesSummary"));
      fireEvent.click(summary);
      const details = summary.closest("details")!;
      expect(details.open).toBe(true);
      const hint = within(details).getByText(
        i18n.t("settings.slotPingMovedHint"),
      );
      const providers = buildNavTree(mocks.store, { locale }).find(
        (node) => node.id === "llm.providers",
      )!;
      expect(hint.textContent).toContain(providers.label);
      expect(hint.textContent).toBe(expectedHint);
      expect(
        buildNavTree(mocks.store, { locale }).some(
          (node) => node.id === "llm.keys",
        ),
      ).toBe(false);
    },
  );
});
