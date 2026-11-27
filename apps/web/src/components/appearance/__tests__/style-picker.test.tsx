import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeAll, expect, it } from "vitest";
import { getSettings, initSettings } from "@/settings/store.js";
import { CUSTOM_THEMES_KEY } from "@/theme-system/storage.js";
import { syncThemeRegistry } from "@/theme-system/registry.js";
import { StylePicker, readPreviewColors } from "../StylePicker.js";

beforeAll(async () => {
  await initSettings();
  syncThemeRegistry(getSettings());
});

it("offers the classic packages as colourways of one style", async () => {
  render(<StylePicker />);

  // Four styles, although seven packages are registered.
  const styles = screen.getByRole("group", { name: "风格方案" });
  expect(styles.querySelectorAll(".ui-style-card")).toHaveLength(4);

  const palettes = screen.getByRole("radiogroup", { name: "经典 · 配色" });
  expect(
    within(palettes)
      .getAllByRole("radio")
      .map((radio) => radio.textContent),
  ).toEqual(["纸本", "现代", "深渊", "极光"]);

  fireEvent.click(within(palettes).getByRole("radio", { name: "现代" }));
  await waitFor(() =>
    expect(getSettings().get("ui.appearance")).toBe("modern"),
  );
  await waitFor(() =>
    expect(
      within(palettes)
        .getByRole("radio", { name: "现代" })
        .getAttribute("aria-checked"),
    ).toBe("true"),
  );
});

it("reads a package's own colours per scheme, skipping variable references", () => {
  const css = `
    html[data-theme="x"] { --color-background: #ffffff; --color-card: var(--color-background); }
    html[data-theme="x"].dark { --color-background: #000000; }
  `;
  expect(readPreviewColors(css, "light")).toEqual({ background: "#ffffff" });
  expect(readPreviewColors(css, "dark")).toEqual({ background: "#000000" });
});

it("collapses long style lists without hiding the currently selected style", async () => {
  const store = getSettings();
  const savedStyles = store.get(CUSTOM_THEMES_KEY);
  const savedAppearance = store.get("ui.appearance");
  const styles = ["Alpha", "Beta", "Gamma", "Omega"].map((label) => ({
    id: label.toLowerCase(),
    label,
    schemes: ["light", "dark"],
    cssText: "",
  }));
  await store.set(CUSTOM_THEMES_KEY, styles);
  syncThemeRegistry(store);
  await store.set("ui.appearance", "omega");
  const view = render(<StylePicker />);
  try {
    const gallery = within(view.getByRole("group", { name: "风格方案" }));
    expect(
      gallery.getByRole("button", { name: "Omega", pressed: true }),
    ).toBeTruthy();
    expect(gallery.queryByRole("button", { name: "Gamma" })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: /显示全部.*种风格/ }));
    expect(gallery.getByRole("button", { name: "Gamma" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "收起风格列表" }));
    expect(gallery.queryByRole("button", { name: "Gamma" })).toBeNull();
  } finally {
    view.unmount();
    await act(async () => {
      await store.set(CUSTOM_THEMES_KEY, savedStyles);
      await store.set("ui.appearance", savedAppearance);
      syncThemeRegistry(store);
    });
  }
});
