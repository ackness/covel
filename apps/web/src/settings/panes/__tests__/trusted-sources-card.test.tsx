import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@covel/settings";
import type { ServerSettingInfo } from "@covel/shared";
import i18n from "@/i18n";
import { registerCoreSettings } from "../../registry/core.js";
import { TrustedSourcesCard } from "../TrustedSourcesCard.js";
const mocks = vi.hoisted(() => ({ store: null as unknown as SettingsStore }));
vi.mock("../../store.js", () => ({ getSettings: () => mocks.store }));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);
async function mount(
  info: ServerSettingInfo = {
    value: ["alpha"],
    source: "setting",
    settable: true,
  },
) {
  let current = info;
  const save = vi.fn(async (patch: Readonly<Record<string, unknown>>) => {
    current = {
      value: patch["trust.sources"],
      source: "setting",
      settable: true,
    };
    return { "trust.sources": current };
  });
  mocks.store = new SettingsStore(
    {
      load: async () => ({}),
      save: async () => undefined,
      loadSecrets: async () => ({}),
      saveSecrets: async () => undefined,
    },
    {
      serverSettings: {
        load: async () => ({ "trust.sources": current }),
        save,
      },
    },
  );
  registerCoreSettings(mocks.store);
  await mocks.store.init();
  await mocks.store.refreshServerSettings();
  render(<TrustedSourcesCard />);
  return save;
}
it("lists, adds normalized entries through the server channel, and removes", async () => {
  const save = await mount();
  expect(screen.getByText("alpha")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("GitHub owner or owner/repo"), {
    target: { value: " Beta/Repo " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      "trust.sources": ["alpha", "beta/repo"],
    }),
  );
  await waitFor(() =>
    expect(
      (
        screen.getByRole("button", {
          name: "Remove alpha",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Remove alpha" }));
  await waitFor(() =>
    expect(save).toHaveBeenLastCalledWith({ "trust.sources": ["beta/repo"] }),
  );
});
it("rejects invalid syntax inline without saving", async () => {
  const save = await mount();
  fireEvent.change(screen.getByLabelText("GitHub owner or owner/repo"), {
    target: { value: "https://github.com/alpha/repo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByRole("alert").textContent).toMatch(/Enter a GitHub owner/);
  expect(save).not.toHaveBeenCalled();
});
it.each(["env", "default"] as const)(
  "locks a non-settable %s policy with its reason",
  async (source) => {
    const save = await mount({ value: ["alpha"], source, settable: false });
    expect(
      (screen.getByLabelText("GitHub owner or owner/repo") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      screen.getByText(
        source === "env"
          ? "This deployment fixes the value."
          : "The operator of this server sets this.",
      ),
    ).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  },
);
it("only fills the suggestion until the owner presses Add", async () => {
  const save = await mount();
  fireEvent.click(
    screen.getByRole("button", { name: "Suggest the official repository" }),
  );
  expect(
    (screen.getByLabelText("GitHub owner or owner/repo") as HTMLInputElement)
      .value,
  ).toBe("covel-ai/covel-plugins");
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      "trust.sources": ["alpha", "covel-ai/covel-plugins"],
    }),
  );
});
