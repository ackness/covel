import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/index.js";
import { WorldSelectScreen } from "../world-select-screen.js";

vi.mock("@/settings/SettingsDialog.js", () => ({
  SettingsDialog: ({
    open,
    initialKey,
  }: {
    open: boolean;
    initialKey?: string;
  }) => (open ? <div role="dialog">{initialKey}</div> : null),
}));

function WorldPicker() {
  const [open, setOpen] = useState(false);
  return (
    <WorldSelectScreen
      worlds={[]}
      plugins={[]}
      resolvedSlots={[]}
      settingsOpen={open}
      onSettingsOpenChange={setOpen}
      onSelectWorld={vi.fn()}
    />
  );
}

describe("world configuration entry", () => {
  it("opens the provider page directly", () => {
    render(<WorldPicker />);
    fireEvent.click(
      screen.getByRole("button", {
        name: (name) => name.includes(i18n.t("session.configureKeys")),
      }),
    );
    expect(screen.getByRole("dialog").textContent).toBe("llm.providers");
  });
});
