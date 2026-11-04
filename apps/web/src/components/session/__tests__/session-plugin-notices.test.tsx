import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import {
  SessionPluginNoticeCards,
  SessionPluginNotices,
} from "../session-plugin-notices.js";
import { NoticeHost } from "@/components/ui/notice-host.js";

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
      <>
        <SessionPluginNoticeCards
          sessionId="s"
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
        />
        <NoticeHost />
      </>,
    );
    expect(
      screen.getByTestId("notice-plugins-unavailable").textContent,
    ).toContain(
      "creator name is off: it needs opening@1. Turn on opening name to use it.",
    );
    expect(screen.queryByTestId("notice-no-story-plugin")).toBeNull();
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
      />,
    );
    const notice = screen.getByTestId("no-story-plugin");
    expect(notice.textContent).toContain("No Storyteller plugin is on");
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on narrator name" }),
    );
    expect(onTurnOn).toHaveBeenCalledWith("narrator");
  });

  it("shows a missing story plugin as an error card in the game", () => {
    render(
      <>
        <SessionPluginNoticeCards
          sessionId="s"
          plugins={[plugin("memory", true)]}
          unavailable={[]}
          offTitle="Off:"
          busy={false}
          onTurnOn={() => {}}
        />
        <NoticeHost />
      </>,
    );
    const card = screen.getByTestId("notice-no-story-plugin");
    expect(card.getAttribute("role")).toBe("alert");
    expect(card.textContent).toContain("Install a Storyteller plugin");
  });

  it("tells the prep screen to install one when no narrative plugin is installed", () => {
    render(
      <SessionPluginNotices
        plugins={[plugin("memory", true)]}
        unavailable={[]}
        offTitle="Off:"
        busy={false}
        onTurnOn={() => {}}
      />,
    );
    expect(screen.getByTestId("no-story-plugin").textContent).toContain(
      "Install a Storyteller plugin",
    );
  });
});
