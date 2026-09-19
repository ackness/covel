import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  SettingsStore,
  type SettingsStoreApi,
  type SettingsBackendAdapter,
} from "@covel/settings";
import type { PresetSummary } from "@/services/api.js";
import i18n from "@/i18n";
import { registerLlmSettings } from "../../registry/llm.js";
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

let persistedEntries: Record<string, unknown>;
let adapter: SettingsBackendAdapter;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  persistedEntries = {};
  adapter = {
    load: async () => persistedEntries,
    save: vi.fn(async (next) => {
      persistedEntries = structuredClone(next);
    }),
    loadSecrets: async () => ({ example: "test-secret" }),
    saveSecrets: async () => undefined,
  };
  const store = new SettingsStore(adapter);
  registerLlmSettings(store);
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
  delete mocks.presets[0].capability;
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
  it("saves separate reasoning defaults when adding several models", async () => {
    mocks.lookup.mockImplementation(async (model: string) => ({
      found: true,
      source: "known",
      pricingKind: "unknown",
      candidates: [],
      capability: { input: ["text"], output: ["text"] },
      reasoning: model.startsWith("qwen")
        ? {
            family: "qwen",
            options: [{ value: "disabled" }, { value: "automatic" }],
          }
        : {
            family: "deepseek",
            options: [
              { value: "disabled" },
              { value: "high" },
              { value: "max" },
            ],
          },
    }));
    render(<LlmPresetsPane />);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add provider" })[0]!,
    );
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(
      dialog.getByPlaceholderText(i18n.t("settings.providerIdExample")),
      { target: { value: "fixture" } },
    );
    fireEvent.change(dialog.getByRole("textbox", { name: /Model IDs/ }), {
      target: { value: "qwen3.8-flash\ndeepseek-v4-flash" },
    });
    fireEvent.click(
      dialog.getByText("Model reasoning default", { selector: "summary" }),
    );
    const qwen = within(dialog.getByRole("group", { name: "qwen3.8-flash" }));
    const deepseek = within(
      dialog.getByRole("group", { name: "deepseek-v4-flash" }),
    );
    await waitFor(() => expect(qwen.getAllByRole("option")).toHaveLength(4));
    expect(qwen.queryByRole("option", { name: /high/ })).toBeNull();
    fireEvent.change(qwen.getByRole("combobox"), {
      target: { value: "disabled" },
    });
    fireEvent.change(deepseek.getByRole("combobox"), {
      target: { value: "high" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add provider" }));
    await waitFor(() =>
      expect(mocks.store.get("llm.providers")).toEqual([
        expect.objectContaining({
          id: "fixture",
          models: [
            expect.objectContaining({
              modelId: "qwen3.8-flash",
              reasoningEffort: "disabled",
            }),
            expect.objectContaining({
              modelId: "deepseek-v4-flash",
              reasoningEffort: "high",
            }),
          ],
        }),
      ]),
    );
  });
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

  it("keeps explicit provider model limits when the catalog has no match", async () => {
    mocks.presets[0].capability = {
      input: ["text"],
      output: ["text"],
      contextWindow: 65536,
      maxOutputTokens: 8192,
    };
    render(<LlmPresetsPane />);
    expect(await screen.findByText("65,536 ctx")).toBeTruthy();
    expect(screen.queryByText("Model limits unknown")).toBeNull();
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

const importedProfile = {
  id: "fixture",
  name: "Fixture",
  baseUrl: "https://fixture.example/v1",
  models: [{ ref: "model", modelId: "original" }],
};

function chooseImport(text: Promise<string>) {
  const file = new File([], "synthetic-providers.json", {
    type: "application/json",
  });
  Object.defineProperty(file, "text", { value: () => text });
  fireEvent.change(screen.getByLabelText("Import", { exact: true }), {
    target: { files: [file] },
  });
}

function exportProfiles(profiles: unknown[]) {
  return JSON.stringify({ version: 2, providers: profiles });
}

it("keeps the provider draft open after failed persistence and saves it on retry", async () => {
  render(<LlmPresetsPane />);
  fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.change(
    dialog.getByPlaceholderText(i18n.t("settings.providerIdExample")),
    { target: { value: "fixture" } },
  );
  const input = dialog.getByRole("textbox", { name: /Model IDs/ });
  fireEvent.change(input, { target: { value: "opaque-model" } });
  const gate = deferred<void>();
  vi.mocked(adapter.save).mockImplementationOnce(() => gate.promise);
  const submit = dialog.getByRole("button", { name: "Add provider" });
  fireEvent.click(submit);
  expect(input.matches(":disabled")).toBe(true);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => gate.reject(new Error("synthetic failure")));
  await waitFor(() =>
    expect(dialog.getByRole("alert").textContent).toContain(
      "Could not save setting",
    ),
  );
  expect((input as HTMLTextAreaElement).value).toBe("opaque-model");
  expect(persistedEntries["llm.providers"]).toBeUndefined();
  expect(persistedEntries["llm.slotConfig"]).toBeUndefined();
  fireEvent.click(submit);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(persistedEntries["llm.providers"]).toEqual([
    expect.objectContaining({
      id: "fixture",
      models: [expect.objectContaining({ modelId: "opaque-model" })],
    }),
  ]);
  expect(persistedEntries["llm.slotConfig"]).toMatchObject({
    story: { modelRef: expect.any(String) },
    plugin: { modelRef: expect.any(String) },
  });
});

it("discards a superseded import when an older read completes last", async () => {
  render(<LlmPresetsPane />);
  const oldRead = deferred<string>();
  chooseImport(oldRead.promise);
  chooseImport(Promise.resolve(exportProfiles([importedProfile])));
  await waitFor(() =>
    expect(persistedEntries["llm.providers"]).toEqual([importedProfile]),
  );
  await act(async () =>
    oldRead.resolve(exportProfiles([{ ...importedProfile, name: "Stale" }])),
  );
  expect(persistedEntries["llm.providers"]).toEqual([importedProfile]);
});

it.each([
  { field: "endpoint", draft: "https://edited.example/v1" },
  { field: "model name", draft: "Edited model name" },
])(
  "keeps an existing $field draft after a delayed save failure",
  async ({ field, draft }) => {
    const profile = {
      ...importedProfile,
      models: [{ ...importedProfile.models[0]!, name: "Original model name" }],
    };
    await mocks.store.set("llm.providers", [profile]);
    render(<LlmPresetsPane />);
    fireEvent.click(screen.getByRole("button", { name: /fixture.*1 models/ }));
    if (field === "model name") {
      fireEvent.click(
        screen.getByText(/Model reasoning default/, { selector: "summary" }),
      );
    }
    const input = screen.getByRole("textbox", {
      name:
        field === "endpoint"
          ? "API endpoint"
          : i18n.t("settings.modelConfigurationName"),
    }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: draft } });
    const gate = deferred<void>();
    vi.mocked(adapter.save).mockImplementationOnce(() => gate.promise);
    fireEvent.blur(input);
    await waitFor(() => expect(input.matches(":disabled")).toBe(true));
    await act(async () => gate.reject(new Error("synthetic delayed failure")));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Could not save setting",
      ),
    );
    expect(persistedEntries["llm.providers"]).toEqual([profile]);
    expect(input.value).toBe(draft);

    fireEvent.blur(input);
    await waitFor(() =>
      expect(persistedEntries["llm.providers"]).toEqual([
        field === "endpoint"
          ? { ...profile, baseUrl: draft }
          : { ...profile, models: [{ ...profile.models[0], name: draft }] },
      ]),
    );
  },
);

it("does not apply a pending import after the pane unmounts", async () => {
  const view = render(<LlmPresetsPane />);
  const read = deferred<string>();
  chooseImport(read.promise);
  view.unmount();
  await act(async () => read.resolve(exportProfiles([importedProfile])));
  expect(adapter.save).not.toHaveBeenCalled();
});

it.each([
  { field: "endpoint", draft: "https://edited.example/v1" },
  { field: "model name", draft: "Edited model name" },
])(
  "accepts a normalized $field draft without reporting an external conflict",
  async ({ field, draft }) => {
    const profile = {
      ...importedProfile,
      models: [{ ...importedProfile.models[0]!, name: "Original model name" }],
    };
    await mocks.store.set("llm.providers", [profile]);
    render(<LlmPresetsPane />);
    fireEvent.click(screen.getByRole("button", { name: /fixture.*1 models/ }));
    if (field === "model name") {
      fireEvent.click(
        screen.getByText(/Model reasoning default/, { selector: "summary" }),
      );
    }
    const input = screen.getByRole("textbox", {
      name:
        field === "endpoint"
          ? "API endpoint"
          : i18n.t("settings.modelConfigurationName"),
    }) as HTMLInputElement;
    const expected = (value: string) => [
      field === "endpoint"
        ? { ...profile, baseUrl: value }
        : { ...profile, models: [{ ...profile.models[0], name: value }] },
    ];
    fireEvent.change(input, { target: { value: `  ${draft}  ` } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(persistedEntries["llm.providers"]).toEqual(expected(draft)),
    );
    expect(input.value).toBe(draft);
    expect(screen.queryByText(i18n.t("settings.draftConflict"))).toBeNull();

    const next = `${draft}-next`;
    fireEvent.change(input, { target: { value: next } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(persistedEntries["llm.providers"]).toEqual(expected(next)),
    );
  },
);

it("preserves an edited connection instead of applying an import read from an older base", async () => {
  await mocks.store.set("llm.providers", [importedProfile]);
  render(<LlmPresetsPane />);
  const read = deferred<string>();
  chooseImport(read.promise);
  const edited = { ...importedProfile, baseUrl: "https://edited.example/v1" };
  await act(async () => mocks.store.set("llm.providers", [edited]));
  await act(async () => read.resolve(exportProfiles([importedProfile])));
  expect(persistedEntries["llm.providers"]).toEqual([edited]);
  expect(screen.getByRole("alert").textContent).toContain(
    "Model settings changed while reading the file",
  );
});

it("merges unrelated edits made while an import is being read", async () => {
  render(<LlmPresetsPane />);
  const read = deferred<string>();
  chooseImport(read.promise);
  const unrelated = {
    ...importedProfile,
    id: "independent",
    models: [{ ref: "independent", modelId: "independent" }],
  };
  await act(async () => mocks.store.set("llm.providers", [unrelated]));
  await act(async () => read.resolve(exportProfiles([importedProfile])));
  await waitFor(() =>
    expect(persistedEntries["llm.providers"]).toEqual([
      unrelated,
      importedProfile,
    ]),
  );
});

it("rejects an imported model reference owned by an existing connection without changing bindings", async () => {
  const before = {
    "llm.providers": [importedProfile],
    "llm.slotConfig": { story: { modelRef: importedProfile.models[0]!.ref } },
  };
  await mocks.store.setMany(before);
  render(<LlmPresetsPane />);
  vi.mocked(adapter.save).mockClear();
  await act(async () =>
    chooseImport(
      Promise.resolve(
        exportProfiles([
          {
            ...importedProfile,
            id: "different-connection",
            baseUrl: "https://different.example/v1",
          },
        ]),
      ),
    ),
  );
  expect(persistedEntries).toEqual(before);
  expect(adapter.save).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toBeTruthy();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}
