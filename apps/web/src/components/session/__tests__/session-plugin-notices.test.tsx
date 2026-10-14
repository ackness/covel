import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { SessionPluginNotices } from "../session-plugin-notices.js";

const plugin = (
  id: string,
  active: boolean,
  extra: Partial<PluginSummary> = {},
) =>
  ({
    id,
    displayName: { "en-US": `${id} name` },
    provides: [],
    extensions: [],
    runtimes: [],
    active,
    ...extra,
  }) as unknown as PluginSummary & { active: boolean };

const story = { outputKind: "story" } as PluginSummary["runtimes"][number];

describe("SessionPluginNotices", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });
  afterEach(cleanup);

  it("says which plugin is off, what it needs, and turns the provider on", () => {
    const onTurnOn = vi.fn();
    render(
      <SessionPluginNotices
        plugins={[
          plugin("narrator", true, { runtimes: [story] }),
          plugin("opening", false, { provides: ["opening@1"] }),
          plugin("creator", false),
        ]}
        unavailable={[
          {
            pluginId: "creator",
            code: "missing-provider",
            reason: "Required contract opening@1 has no active provider",
            contract: "opening@1",
          },
        ]}
        offTitle="Off:"
        busy={false}
        onTurnOn={onTurnOn}
        variant="bar"
      />,
    );
    expect(
      screen.getByText(
        "creator name is off: it needs opening@1. Turn on opening name to use it.",
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("no-story-plugin")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on opening name" }),
    );
    expect(onTurnOn).toHaveBeenCalledWith("opening");
  });

  it("explains a session without a narrative plugin and offers one", () => {
    const onTurnOn = vi.fn();
    render(
      <SessionPluginNotices
        plugins={[
          plugin("memory", true),
          plugin("narrator", false, { runtimes: [story] }),
        ]}
        unavailable={[]}
        offTitle="Off:"
        busy={false}
        onTurnOn={onTurnOn}
        variant="card"
      />,
    );
    const notice = screen.getByTestId("no-story-plugin");
    expect(notice.textContent).toContain("No narrative plugin is on");
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on narrator name" }),
    );
    expect(onTurnOn).toHaveBeenCalledWith("narrator");
  });

  it("tells the player to install one when no narrative plugin is installed", () => {
    render(
      <SessionPluginNotices
        plugins={[plugin("memory", true)]}
        unavailable={[]}
        offTitle="Off:"
        busy={false}
        onTurnOn={() => {}}
        variant="bar"
      />,
    );
    expect(screen.getByTestId("no-story-plugin").textContent).toContain(
      "Install a narrative plugin",
    );
  });
});
