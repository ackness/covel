import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { LlmKeysPane } from "../LlmKeysPane.js";

const storeMocks = vi.hoisted(() => {
  let key = "";
  const listeners = new Set<(value: unknown, settingKey: string) => void>();
  return {
    reset() {
      key = "";
      listeners.clear();
    },
    setKey(value: string) {
      key = value;
      for (const listener of listeners) listener(value, "keys.proxy");
    },
    store: {
      listEntries: () => [{ key: "keys.proxy", backend: "keys" }],
      get: () => key,
      snapshotSecrets: () => (key ? { proxy: key } : {}),
      subscribeAll(listener: (value: unknown, settingKey: string) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  };
});

vi.mock("@/settings/use-settings.js", () => ({
  useSettingsStore: () => storeMocks.store,
}));

vi.mock("@/services/api.js", () => ({
  getCustomPresets: () => [
    {
      id: "proxy-model",
      name: "Proxy model",
      provider: "proxy",
      model: "model",
    },
  ],
  getProviderPriceMultipliers: () => ({}),
  setProviderPriceMultipliers: vi.fn(),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: { llmConfig: undefined, presets: [] } }),
}));

vi.mock("../../widgets/index.js", () => ({ SettingWidget: () => null }));
vi.mock("@/components/shared/ping-button.js", () => ({
  invalidateAllPingResults: vi.fn(),
  PingButton: () => <span data-testid="ping" />,
}));
vi.mock("@/lib/desktop-bridge.js", () => ({
  isDesktopApp: () => false,
  openLlmToml: vi.fn(),
}));

describe("LlmKeysPane", () => {
  beforeEach(async () => {
    storeMocks.reset();
    await i18n.changeLanguage("en-US");
  });

  it("refreshes key status and Ping actions after a migrated secret is saved", async () => {
    render(<LlmKeysPane providerId="proxy" showIntro={false} />);
    expect(screen.queryByTestId("ping")).toBeNull();

    await act(async () => storeMocks.setKey("sk-migrated"));

    expect(screen.getByTestId("ping")).toBeDefined();
  });
});
