import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SettingEntry } from "@covel/settings";
import i18n from "@/i18n";
import { SettingWidget } from "../widgets/index.js";

const settings = vi.hoisted(() => ({ value: "30", set: vi.fn() }));
vi.mock("../use-settings.js", () => ({
  useSetting: () => [settings.value, settings.set],
  useSettingOverride: () => [false, vi.fn()],
}));

const entry: SettingEntry = {
  key: "diagnostics.traceRetention",
  label: "Keep diagnostic traces",
  widget: "select",
  group: "general",
  default: "30",
  schema: z.string(),
};

function serverReports(traceRetention: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ traceRetention })),
  );
}

describe("trace retention setting", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
    settings.value = "30";
    settings.set.mockReset();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("writes the player's choice when the server accepts it", async () => {
    serverReports({ days: 30, source: "default", settable: true });
    render(<SettingWidget entry={entry} />);
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "keep" } });
    expect(settings.set).toHaveBeenCalledWith("keep");
  });

  it("shows the deployment's value and locks the control", async () => {
    settings.value = "7";
    serverReports({ days: 0, source: "env", settable: false });
    render(<SettingWidget entry={entry} />);
    await screen.findByText(/deployment fixes the period at Keep everything/);
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe("keep");
  });
});
