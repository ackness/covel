import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ThemeToggle } from "../theme-toggle.js";
const settings = vi.hoisted(() => ({
  scheme: "light",
  schemes: ["light", "dark"],
  set: vi.fn(),
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: (key: string) => [
    key === "ui.appearance" ? "fixture" : settings.scheme,
    settings.set,
  ],
}));
vi.mock("@/theme-system/registry.js", () => ({
  THEME_SCHEME_KEY: "ui.scheme",
  getThemeDefinition: () => ({ schemes: settings.schemes }),
}));
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  settings.scheme = "light";
  settings.schemes = ["light", "dark"];
  settings.set.mockReset();
});
it("announces the dark-mode state and its locked reason", () => {
  const view = render(<ThemeToggle />);
  fireEvent.click(
    screen.getByRole("button", { name: "Dark mode", pressed: false }),
  );
  expect(settings.set).toHaveBeenCalledWith("dark");
  settings.scheme = "dark";
  settings.schemes = ["dark"];
  view.rerender(<ThemeToggle />);
  const button = screen.getByRole("button", {
    name: "Dark mode",
    pressed: true,
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(
    document.getElementById(button.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("This theme supports only one color mode.");
});
