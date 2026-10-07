import {
  act,
  cleanup,
  fireEvent,
  render,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, type SettingsBackendAdapter } from "@covel/settings";
import type { SettingsPersistenceBundle } from "@covel/shared/settings-persistence";
import i18n from "@/i18n";
import { AppearancePane } from "../AppearancePane.js";
import { ThemeManagerWidget } from "@/components/theme-manager.js";
import { TokenControl } from "@/components/appearance/TokenControl.js";
import {
  primeThemeRegistry,
  syncThemeRegistry,
} from "@/theme-system/registry.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import {
  APPEARANCE_TOKENS_KEY,
  applyTokenOverrides,
  loadOverrides,
  setTokenOverride,
} from "@/theme-system/overrides.js";

const context = vi.hoisted(() => ({ store: null as SettingsStore | null }));
vi.mock("@/settings/store.js", () => ({ getSettings: () => context.store }));

const token = "--story-color";
const initialOverrides = {
  shared: {},
  light: {},
  dark: { [token]: "#112233" },
};

class RejectingAdapter implements SettingsBackendAdapter {
  bundle: SettingsPersistenceBundle;
  attempts: Record<string, unknown>[] = [];
  rejectNext = false;
  blocked: { resolve: () => void; reject: () => void } | null = null;
  blockNext = false;

  constructor(entries: Record<string, unknown>) {
    this.bundle = {
      schemaVersion: 2,
      revision: 0,
      savedAt: "2026-01-01T00:00:00.000Z",
      entries,
    };
  }
  async load() {
    return structuredClone(this.bundle.entries);
  }
  async loadWithRevision() {
    return structuredClone(this.bundle);
  }
  async save(entries: Record<string, unknown>) {
    this.attempts.push(structuredClone(entries));
    if (this.blockNext) {
      this.blockNext = false;
      await new Promise<void>((resolve, reject) => {
        this.blocked = {
          resolve,
          reject: () => reject(new Error("synthetic persistence failure")),
        };
      });
    } else if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("synthetic persistence failure");
    }
    this.bundle = {
      ...this.bundle,
      entries: structuredClone(entries),
      revision: this.bundle.revision + 1,
    };
  }
  async saveWithRevision(entries: Record<string, unknown>, revision: number) {
    expect(revision).toBe(this.bundle.revision);
    await this.save(entries);
    return this.loadWithRevision();
  }
  async loadSecrets() {
    return {};
  }
  async saveSecrets() {}
}

async function setup(existing = true, versioned = true) {
  const adapter = new RejectingAdapter({
    "ui.appearance": "stage",
    "ui.scheme": "dark",
    [APPEARANCE_TOKENS_KEY]: existing
      ? initialOverrides
      : { shared: {}, light: {}, dark: {} },
  });
  const backend: SettingsBackendAdapter = versioned
    ? adapter
    : {
        load: () => adapter.load(),
        save: (entries) => adapter.save(entries),
        loadSecrets: () => adapter.loadSecrets(),
        saveSecrets: () => adapter.saveSecrets(),
      };
  const store = new SettingsStore(backend);
  await store.init();
  primeThemeRegistry(store);
  context.store = store;
  // Same subscriptions as app boot: confirmed settings paint the root.
  store.subscribe(APPEARANCE_TOKENS_KEY, () => applyTokenOverrides(store));
  store.subscribe("ui.scheme", () => syncThemeRegistry(store));
  store.subscribe("ui.appearance", () => syncThemeRegistry(store));
  const style = document.createElement("style");
  style.dataset.auditFixture = "true";
  style.textContent = `:root { ${token}: #eeeeee; }`;
  document.head.append(style);
  syncThemeRegistry(store);
  return { store, adapter };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function storyControl(view: ReturnType<typeof render>) {
  const details = [...view.container.querySelectorAll("details")].find((node) =>
    node.querySelector(
      'input[type="text"][value="#112233"], input[type="text"][value="#eeeeee"]',
    ),
  );
  expect(details).toBeDefined();
  const row = details!
    .querySelector(
      'input[type="text"][value="#112233"], input[type="text"][value="#eeeeee"]',
    )!
    .closest("div.flex.items-center.justify-between")!;
  return {
    input: within(row as HTMLElement).getByRole("textbox") as HTMLInputElement,
    row: row as HTMLElement,
  };
}

function preview(input: HTMLElement, value: string) {
  // The native colour picker previews directly; jsdom has no canvas colour parser.
  fireEvent.change(input.parentElement!.querySelector('input[type="color"]')!, {
    target: { value },
  });
}

function edit(input: HTMLElement, value: string) {
  preview(input, value);
  fireEvent.blur(input);
}

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  context.store = null;
  document.documentElement.removeAttribute("style");
  document.head
    .querySelectorAll("[data-audit-fixture], [data-theme-style]")
    .forEach((node) => node.remove());
});

describe("AppearancePane truthful persistence (F-026)", () => {
  it("keeps selection, overrides and name when save-as stores the record but cannot apply it", async () => {
    const { store, adapter } = await setup();
    const view = render(<AppearancePane />);
    const name = view.getByRole("textbox", {
      name: i18n.t("appearance.saveAsThemeTitle"),
    });
    fireEvent.change(name, { target: { value: "Synthetic theme" } });
    // Record save succeeds; the selection write fails; any erroneous cleanup could succeed.
    const save = adapter.save.bind(adapter);
    adapter.save = async (entries) => {
      if (entries["ui.appearance"] === "synthetic-theme")
        adapter.rejectNext = true;
      await save(entries);
    };
    fireEvent.click(
      view.getByRole("button", {
        name: i18n.t("appearance.saveAsTheme"),
      }),
    );
    await settle();
    expect(store.get("ui.appearance")).toBe("stage");
    expect(loadOverrides(store)).toEqual(initialOverrides);
    expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
      initialOverrides,
    );
    expect(name).toHaveProperty("value", "Synthetic theme");
    expect(view.getByText("synthetic persistence failure")).toBeTruthy();
    expect(store.get<unknown[]>(CUSTOM_THEMES_KEY)).toHaveLength(1);
    expect(adapter.attempts).toHaveLength(2);
  });

  it("awaits apply, reports rejection and retains the selected theme", async () => {
    const { store, adapter } = await setup();
    const view = render(<ThemeManagerWidget />);
    adapter.blockNext = true;
    const button = view.getAllByRole("button", {
      name: i18n.t("settings.themeApply"),
    })[0]!;
    fireEvent.click(button);
    await settle();
    expect(
      view
        .getAllByRole("button", { name: i18n.t("settings.themeApply") })
        .every((entry) => (entry as HTMLButtonElement).disabled),
    ).toBe(true);
    await act(async () => {
      adapter.blocked!.reject();
    });
    expect(
      view
        .getAllByRole("button", { name: i18n.t("settings.themeApply") })
        .every((entry) => !(entry as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(store.get("ui.appearance")).toBe("stage");
    expect(loadOverrides(store)).toEqual(initialOverrides);
    expect(view.getByText(i18n.t("settings.saveFailed"))).toBeTruthy();
  });

  it("clears overrides and name only after successful save-as", async () => {
    const { store, adapter } = await setup();
    const view = render(<AppearancePane />);
    const name = view.getByRole("textbox", {
      name: i18n.t("appearance.saveAsThemeTitle"),
    });
    fireEvent.change(name, { target: { value: "Successful synthetic" } });
    fireEvent.click(
      view.getByRole("button", {
        name: i18n.t("appearance.saveAsTheme"),
      }),
    );
    await settle();
    expect(store.get("ui.appearance")).toBe("successful-synthetic");
    expect(loadOverrides(store)).toEqual({ shared: {}, light: {}, dark: {} });
    expect(name).toHaveProperty("value", "");
    expect(adapter.attempts).toHaveLength(3);
  });

  it("does not announce full import success after a saved theme fails to apply", async () => {
    const { store, adapter } = await setup();
    const view = render(<ThemeManagerWidget />);
    const save = adapter.save.bind(adapter);
    adapter.save = async (entries) => {
      if (entries["ui.appearance"] === "synthetic-import")
        adapter.rejectNext = true;
      await save(entries);
    };
    fireEvent.change(view.container.querySelector('input[type="file"]')!, {
      target: {
        files: [
          {
            name: "synthetic.theme.json",
            text: async () =>
              JSON.stringify({
                id: "synthetic-import",
                label: "Synthetic import",
                schemes: ["light", "dark"],
                cssText:
                  'html[data-theme="synthetic-import"] { --story-color: #ffffff; }',
              }),
          },
        ],
      },
    });
    await settle();
    expect(store.get("ui.appearance")).toBe("stage");
    expect(loadOverrides(store)).toEqual(initialOverrides);
    expect(
      view.queryByText(
        i18n.t("settings.themeImported", { name: "Synthetic import" }),
      ),
    ).toBeNull();
    expect(view.getByText("synthetic persistence failure")).toBeTruthy();
    expect(store.get<unknown[]>(CUSTOM_THEMES_KEY)).toHaveLength(1);
  });
});

describe("AppearancePane failed previews (F-027)", () => {
  it.each([false, true])(
    "restores the saved length preview when an empty submission is ignored (versioned=%s)",
    async (versioned) => {
      const lengthToken = "--story-font-size";
      const { store, adapter } = await setup(true, versioned);
      await setTokenOverride(store, lengthToken, "1.25rem");
      const writesBefore = adapter.attempts.length;
      const view = render(<AppearancePane />);
      const input = view.getByRole("textbox", {
        name: "Body size",
      }) as HTMLInputElement;
      expect(input.value).toBe("1.25rem");
      expect(document.documentElement.style.getPropertyValue(lengthToken)).toBe(
        "1.25rem",
      );

      fireEvent.change(input, { target: { value: "" } });
      fireEvent.blur(input);
      expect(document.documentElement.style.getPropertyValue(lengthToken)).toBe(
        "",
      );
      await settle();

      expect(adapter.attempts).toHaveLength(writesBefore);
      expect(loadOverrides(store).shared[lengthToken]).toBe("1.25rem");
      expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
        loadOverrides(store),
      );
      expect(input.value).toBe("1.25rem");
      expect(document.documentElement.style.getPropertyValue(lengthToken)).toBe(
        "1.25rem",
      );
      expect(view.queryByText(i18n.t("settings.saveFailed"))).toBeNull();
    },
  );

  it("does not repaint an older ignored submission over a newer length draft", async () => {
    const lengthToken = "--story-font-size";
    const { store, adapter } = await setup();
    await setTokenOverride(store, lengthToken, "1.25rem");
    const writesBefore = adapter.attempts.length;
    const view = render(<AppearancePane />);
    const input = view.getByRole("textbox", {
      name: "Body size",
    }) as HTMLInputElement;
    vi.useFakeTimers();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "1.375rem" } });
    await settle();

    expect(adapter.attempts).toHaveLength(writesBefore);
    expect(loadOverrides(store).shared[lengthToken]).toBe("1.25rem");
    expect(input.value).toBe("1.375rem");
    expect(document.documentElement.style.getPropertyValue(lengthToken)).toBe(
      "1.375rem",
    );
    fireEvent.blur(input);
    await settle();
    expect(loadOverrides(store).shared[lengthToken]).toBe("1.375rem");
    expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
      loadOverrides(store),
    );
    expect(document.documentElement.style.getPropertyValue(lengthToken)).toBe(
      "1.375rem",
    );
  });

  it("an unmounted control observes rejection without painting or reporting in its old scope", async () => {
    const adapter = new RejectingAdapter({
      [APPEARANCE_TOKENS_KEY]: initialOverrides,
    });
    const store = new SettingsStore(adapter);
    await store.init();
    const onError = vi.fn();
    const view = render(
      <TokenControl
        spec={{
          name: token,
          label: "Body color",
          control: "color",
          perScheme: true,
        }}
        scheme="dark"
        themeDefault="#eeeeee"
        override="#112233"
        onCommit={(value) => setTokenOverride(store, token, value, "dark")}
        onReset={() => undefined}
        onError={onError}
      />,
    );
    adapter.blockNext = true;
    preview(view.getByRole("textbox"), "#abcdef");
    // Closing flushes the last edit, then its late rejection is out of scope.
    view.unmount();
    await settle();
    document.documentElement.style.setProperty(token, "#778899");
    await act(async () => {
      adapter.blocked!.reject();
    });
    expect(document.documentElement.style.getPropertyValue(token)).toBe(
      "#778899",
    );
    expect(onError).not.toHaveBeenCalled();
    expect(loadOverrides(store)).toEqual(initialOverrides);
  });

  it.each([
    { existing: false, versioned: false },
    { existing: true, versioned: false },
    { existing: false, versioned: true },
    { existing: true, versioned: true },
  ])(
    "reverts an override failure ($existing, versioned=$versioned) with a visible error",
    async ({ existing, versioned }) => {
      const { store, adapter } = await setup(existing, versioned);
      const view = render(<AppearancePane />);
      const { input } = storyControl(view);
      adapter.rejectNext = true;
      edit(input, "#abcdef");
      expect(document.documentElement.style.getPropertyValue(token)).toBe(
        "#abcdef",
      );
      await settle();
      expect(input.value).toBe(existing ? "#112233" : "#eeeeee");
      expect(document.documentElement.style.getPropertyValue(token)).toBe(
        existing ? "#112233" : "",
      );
      expect(loadOverrides(store).dark[token]).toBe(
        existing ? "#112233" : undefined,
      );
      expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
        loadOverrides(store),
      );
      expect(view.getByText(i18n.t("settings.saveFailed"))).toBeTruthy();
    },
  );

  it.each([
    { reset: "token", versioned: false },
    { reset: "group", versioned: false },
    { reset: "all", versioned: false },
    { reset: "token", versioned: true },
    { reset: "group", versioned: true },
    { reset: "all", versioned: true },
  ])(
    "reports $reset reset failure and restores the saved override (versioned=$versioned)",
    async ({ reset, versioned }) => {
      const { store, adapter } = await setup(true, versioned);
      const view = render(<AppearancePane />);
      const { input, row } = storyControl(view);
      adapter.rejectNext = true;
      const button =
        reset === "token"
          ? within(row).getByRole("button", {
              name: i18n.t("appearance.resetToken"),
            })
          : view.getAllByRole("button", {
              name: i18n.t(
                reset === "all"
                  ? "appearance.resetAll"
                  : "appearance.resetGroup",
              ),
            })[0]!;
      fireEvent.click(button);
      await settle();
      expect(input.value).toBe("#112233");
      expect(loadOverrides(store)).toEqual(initialOverrides);
      expect(document.documentElement.style.getPropertyValue(token)).toBe(
        "#112233",
      );
      expect(view.getByText(i18n.t("settings.saveFailed"))).toBeTruthy();
    },
  );

  it.each([
    { reset: "token", versioned: false },
    { reset: "group", versioned: false },
    { reset: "all", versioned: false },
    { reset: "token", versioned: true },
    { reset: "group", versioned: true },
    { reset: "all", versioned: true },
  ])(
    "protects a newer preview when an older $reset reset rejects (versioned=$versioned)",
    async ({ reset, versioned }) => {
      const { store, adapter } = await setup(true, versioned);
      const view = render(<AppearancePane />);
      const { input, row } = storyControl(view);
      adapter.blockNext = true;
      const button =
        reset === "token"
          ? within(row).getByRole("button", {
              name: i18n.t("appearance.resetToken"),
            })
          : view.getAllByRole("button", {
              name: i18n.t(
                reset === "all"
                  ? "appearance.resetAll"
                  : "appearance.resetGroup",
              ),
            })[0]!;
      fireEvent.click(button);
      await settle();
      preview(input, "#778899");
      await act(async () => {
        adapter.blocked!.reject();
      });
      expect(input.value).toBe("#778899");
      expect(document.documentElement.style.getPropertyValue(token)).toBe(
        "#778899",
      );
      fireEvent.blur(input);
      await settle();
      expect(loadOverrides(store).dark[token]).toBe("#778899");
      expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
        loadOverrides(store),
      );
    },
  );

  it.each([
    { submitted: false, later: "#778899" },
    { submitted: true, later: "#778899" },
    { submitted: false, later: "#abcdef" },
    { submitted: true, later: "#abcdef" },
  ])(
    "protects a later edit from an older failed save ($submitted, $later)",
    async ({ submitted, later }) => {
      const { store, adapter } = await setup();
      const view = render(<AppearancePane />);
      const { input } = storyControl(view);
      adapter.blockNext = true;
      edit(input, "#abcdef");
      await settle();
      preview(input, later);
      if (submitted) fireEvent.blur(input);
      await act(async () => {
        adapter.blocked!.reject();
      });
      expect(input.value).toBe(later);
      expect(document.documentElement.style.getPropertyValue(token)).toBe(
        later,
      );
      if (!submitted) fireEvent.blur(input);
      await settle();
      expect(loadOverrides(store).dark[token]).toBe(later);
      expect(adapter.bundle.entries[APPEARANCE_TOKENS_KEY]).toEqual(
        loadOverrides(store),
      );
    },
  );

  it("an older rejection after scheme switch does not repaint the new scheme", async () => {
    const { store, adapter } = await setup();
    // Stage is dark-only; use a theme that supports the requested light scheme.
    await store.set("ui.appearance", "paper");
    const view = render(<AppearancePane />);
    const { input } = storyControl(view);
    adapter.blockNext = true;
    edit(input, "#abcdef");
    await settle();
    let switchScheme: Promise<void>;
    act(() => {
      switchScheme = store.set("ui.scheme", "light");
    });
    // Force another setting notification to render the new visible scheme while I/O is blocked.
    act(() => {
      syncThemeRegistry(store);
      view.rerender(<AppearancePane />);
    });
    await act(async () => {
      adapter.blocked!.reject();
      await switchScheme!;
    });
    expect(adapter.bundle.entries["ui.scheme"]).toBe("light");
    expect(store.get("ui.scheme")).toBe("light");
    expect(
      view.getByRole("textbox", { name: "Body color" }).getAttribute("value"),
    ).toBe("#eeeeee");
    expect(document.documentElement.style.getPropertyValue(token)).toBe("");
  });
});
