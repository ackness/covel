import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SettingsStore,
  type SettingsBackendAdapter,
  type SettingsStoreApi,
} from "@covel/settings";
import i18n from "@/i18n";
import type { ProviderSourceSummary } from "@/services/api.js";
import { registerLlmSettings } from "../../registry/llm.js";
import { PERMISSIONS_NODE_ID } from "../../navigation.js";
import { LlmPresetsPane } from "../LlmPresetsPane.js";

const mocks = vi.hoisted(() => ({
  store: null as unknown as SettingsStoreApi,
  fetchProviderSources: vi.fn<() => Promise<{ sources: ProviderSourceSummary[] }>>(),
  openPluginConfigFlow: vi.fn(),
}));

vi.mock("@/settings/store", () => ({
  getSettings: () => mocks.store,
  registerKnownProviders: vi.fn(),
}));

vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({
    state: {
      presets: [],
      llmConfig: { configured: false, slots: {} },
    },
  }),
}));

vi.mock("@/services/api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/api.js")>()),
  fetchProviderSources: mocks.fetchProviderSources,
}));

vi.mock("@/lib/platform-ui-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform-ui-events.js")>()),
  openPluginConfigFlow: mocks.openPluginConfigFlow,
}));

const CAPABILITY_DENIED_SOURCE: ProviderSourceSummary = {
  id: "openai-codex/codex",
  pluginId: "openai-codex",
  sourceId: "codex",
  label: "OpenAI Codex (ChatGPT Subscription)",
  protocol: "openai-responses-v1",
  modes: ["text"],
  baseUrl: "https://chatgpt.com/backend-api/codex",
  accountsMode: "many",
  authFlows: ["oauth-sign-in"],
  ready: false,
  reason: "capability_denied",
  accounts: [],
};

const NOT_SIGNED_IN_SOURCE: ProviderSourceSummary = {
  ...CAPABILITY_DENIED_SOURCE,
  reason: "not_signed_in",
};

describe("plugin provider sources in Add Provider dialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    let entries: Record<string, unknown> = {};
    const adapter: SettingsBackendAdapter = {
      load: async () => entries,
      save: async (next) => {
        entries = structuredClone(next);
      },
      loadSecrets: async () => ({}),
      saveSecrets: async () => undefined,
    };
    const store = new SettingsStore(adapter);
    registerLlmSettings(store);
    await store.init();
    mocks.store = store;
    mocks.fetchProviderSources.mockReset();
    mocks.openPluginConfigFlow.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("lists plugin provider sources directly in the Provider dropdown and navigates to Permissions & Security when capability_denied", async () => {
    mocks.fetchProviderSources.mockResolvedValue({
      sources: [CAPABILITY_DENIED_SOURCE],
    });
    const onNavigate = vi.fn();

    render(<LlmPresetsPane onNavigate={onNavigate} />);

    fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
    const dialog = within(screen.getByRole("dialog"));

    const select = (await dialog.findByRole("combobox", {
      name: "Provider",
    })) as HTMLSelectElement;

    await waitFor(() =>
      expect(
        dialog.getByRole("option", {
          name: "OpenAI Codex (ChatGPT Subscription) (Permission required)",
        }),
      ).toBeTruthy(),
    );

    fireEvent.change(select, {
      target: { value: "source:openai-codex/codex" },
    });

    expect(
      (dialog.getByRole("textbox", { name: "Provider ID" }) as HTMLInputElement)
        .value,
    ).toBe("codex");
    expect(
      (dialog.getByRole("textbox", { name: "API endpoint" }) as HTMLInputElement)
        .value,
    ).toBe("https://chatgpt.com/backend-api/codex");

    const openPermissionsButton = dialog.getByRole("button", {
      name: "Open Permissions & Security",
    });
    fireEvent.click(openPermissionsButton);

    expect(onNavigate).toHaveBeenCalledWith(PERMISSIONS_NODE_ID);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("offers direct authentication launch when a plugin provider source needs sign-in", async () => {
    mocks.fetchProviderSources.mockResolvedValue({
      sources: [NOT_SIGNED_IN_SOURCE],
    });

    render(<LlmPresetsPane />);

    fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
    const dialog = within(screen.getByRole("dialog"));
    const select = (await dialog.findByRole("combobox", {
      name: "Provider",
    })) as HTMLSelectElement;

    await waitFor(() =>
      expect(
        dialog.getByRole("option", {
          name: "OpenAI Codex (ChatGPT Subscription) (Sign-in required)",
        }),
      ).toBeTruthy(),
    );

    fireEvent.change(select, {
      target: { value: "source:openai-codex/codex" },
    });

    fireEvent.click(
      dialog.getByRole("button", { name: "Authenticate / Manage" }),
    );
    expect(mocks.openPluginConfigFlow).toHaveBeenCalledWith(
      "openai-codex",
      "oauth-sign-in",
    );
  });
});
