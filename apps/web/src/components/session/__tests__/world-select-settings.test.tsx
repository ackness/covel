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
        name: (name) => name.includes(i18n.t("session.setupAiTitle")),
      }),
    );
    expect(screen.getByRole("dialog").textContent).toBe("llm.providers");
  });

  it("hides the setup card once a model can run", () => {
    render(
      <WorldSelectScreen
        worlds={[]}
        plugins={[]}
        resolvedSlots={[
          {
            slotId: "story",
            presetId: "",
            preset: null,
            label: "story",
            tag: "text",
            hasCredentials: true,
            isAvailable: true,
            serverModel: "m",
            serverProvider: "p",
          },
        ]}
        settingsOpen={false}
        onSettingsOpenChange={vi.fn()}
        onSelectWorld={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: i18n.t("session.setupAiTitle") }),
    ).toBeNull();
  });

  it("points an empty world list at installing worlds, not at a folder", () => {
    render(<WorldPicker />);
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("session.worldsEmptyInstall"),
      }),
    );
    expect(screen.getByRole("dialog").textContent).toBe("packages");
    expect(i18n.t("session.worldsEmptyDesc")).not.toContain("worlds/");
  });
});
