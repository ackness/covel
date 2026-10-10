import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SettingEntry } from "@covel/settings";
import i18n from "@/i18n";
import { SettingWidget } from "../widgets/index.js";

const settings = vi.hoisted(() => ({
  value: 120 as unknown,
  overridden: false,
  set: vi.fn(),
  restoreDefault: vi.fn(),
}));
vi.mock("../use-settings.js", () => ({
  useSetting: () => [settings.value, settings.set],
  useSettingOverride: () => [settings.overridden, settings.restoreDefault],
  useServerSettingState: () => undefined,
}));

const wait: SettingEntry = {
  key: "demo.wait",
  label: "Wait",
  widget: "number",
  group: "general",
  default: 120,
  min: 15,
  max: 1800,
  schema: z.number().int().min(15).max(1800),
};

describe("SettingWidget editing", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    settings.value = 120;
    settings.overridden = false;
    settings.set.mockReset();
    settings.restoreDefault.mockReset();
  });
  afterEach(() => cleanup());

  it("writes a number when the field is left, not on each key press", () => {
    render(<SettingWidget entry={wait} />);
    const input = screen.getByLabelText("Wait") as HTMLInputElement;
    // "3" and "" are outside the range; the old per-key write refused them
    // and put the stored value back, so "300" could not be typed.
    for (const text of ["", "3", "30", "300"]) {
      fireEvent.change(input, { target: { value: text } });
      expect(input.value).toBe(text);
    }
    expect(settings.set).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(settings.set).toHaveBeenCalledExactlyOnceWith(300);
  });

  it("brings a value outside the range to the nearest allowed value", () => {
    render(<SettingWidget entry={wait} />);
    const input = screen.getByLabelText("Wait");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    fireEvent.change(input, { target: { value: "99999.6" } });
    fireEvent.blur(input);
    expect(settings.set.mock.calls).toEqual([[15], [1800]]);
    expect(screen.getByText(/Range: 15–1,800\./)).toBeTruthy();
  });

  it("keeps the stored value when the field is left empty or unchanged", () => {
    render(<SettingWidget entry={wait} />);
    const input = screen.getByLabelText("Wait") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.value).toBe("120");
    fireEvent.change(input, { target: { value: "120" } });
    fireEvent.blur(input);
    expect(settings.set).not.toHaveBeenCalled();
  });

  it("writes a draft that is still open when the field unmounts", () => {
    const view = render(<SettingWidget entry={wait} />);
    fireEvent.change(screen.getByLabelText("Wait"), {
      target: { value: "240" },
    });
    view.unmount();
    expect(settings.set).toHaveBeenCalledExactlyOnceWith(240);
  });

  it("offers the default only for a value the player set", () => {
    const view = render(<SettingWidget entry={wait} />);
    expect(screen.queryByRole("button", { name: "Use default" })).toBeNull();
    settings.overridden = true;
    view.rerender(<SettingWidget entry={wait} />);
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    expect(settings.restoreDefault).toHaveBeenCalledTimes(1);
  });

  it("shows a framework description that only the catalog holds", () => {
    settings.value = false;
    render(
      <SettingWidget
        entry={{
          key: "ui.expandTurnUpdates",
          label: "Expand turn updates",
          widget: "toggle",
          group: "general",
          default: false,
          schema: z.boolean(),
        }}
      />,
    );
    expect(screen.getByText(/instead of folded into one line/)).toBeTruthy();
  });
});
