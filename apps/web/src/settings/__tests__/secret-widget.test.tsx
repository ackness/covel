import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SettingEntry } from "@covel/settings";
import i18n from "@/i18n";
import { SettingWidget } from "../widgets/index.js";

const state = vi.hoisted(() => ({ saved: "sk-saved-secret", set: vi.fn() }));
vi.mock("../use-settings.js", () => ({
  useSetting: () => [state.saved, state.set],
  useSettingOverride: () => [false, vi.fn()],
  useServerSettingState: () => undefined,
}));
afterEach(cleanup);

it("keeps saved keys and new drafts out of CSS-readable attributes", async () => {
  await i18n.changeLanguage("en-US");
  const entry = {
    key: "keys.test",
    label: "API key",
    widget: "secret",
    group: "general",
    default: "",
  } as SettingEntry;
  const { container } = render(<SettingWidget entry={entry} />);
  const input = screen.getByLabelText("API key") as HTMLInputElement;
  expect(input.value).toBe("");
  expect(container.innerHTML).not.toContain(state.saved);
  fireEvent.change(input, { target: { value: "sk-new-secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Show" }));
  expect(input.value).toBe("sk-new-secret");
  expect(input.getAttribute("value")).toBeNull();
  expect(container.innerHTML).not.toContain("sk-new-secret");
  fireEvent.blur(input);
  expect(state.set).toHaveBeenCalledWith("sk-new-secret");
  expect(input.value).toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(state.set).toHaveBeenLastCalledWith("");
});
