import { useContext, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPlugin, WorldDataImportNotice } from "@covel/shared";
import i18n from "@/i18n";
import { NoticeHost } from "@/components/ui/notice-host.js";
import { SessionStateContext } from "@/stores/session-store/context.js";
import { initialState } from "@/stores/session-store/reducer.js";
import type { PluginThemeSession } from "@/theme-system/plugin-themes.js";
import { PluginApprovalNotice } from "../plugin-approval-notice.js";
import { SessionThemeNotice } from "../session-theme-notice.js";
import { WorldStateNotice } from "../world-state-notice.js";

const theme = vi.hoisted(() => ({ error: undefined as string | undefined }));
vi.mock("@/stores/session-store.js", () => ({
  useSession: () => ({ state: useContext(SessionStateContext) }),
}));
vi.mock("@/theme-system/use-plugin-theme.js", () => ({
  usePluginThemeSessionState: () => ({ error: theme.error }),
}));
vi.mock("../session-dimensions-panel.js", () => ({
  SessionDimensionsPanel: () => <p>settlement body</p>,
}));

const plugin = (id: string, extra: Partial<SessionPlugin> = {}) =>
  ({
    id,
    displayName: { "en-US": `${id} name` },
    active: false,
    approvalRequired: false,
    ...extra,
  }) as unknown as SessionPlugin;

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
  theme.error = undefined;
});
afterEach(cleanup);

describe("PluginApprovalNotice", () => {
  it("is one card for every plugin waiting, and Review opens the first", () => {
    const onReview = vi.fn();
    render(
      <>
        <PluginApprovalNotice
          sessionId="s"
          busy={false}
          onReview={onReview}
          plugins={[
            plugin("a", { approvalRequired: true }),
            plugin("b"),
            plugin("c", { approvalRequired: true }),
          ]}
        />
        <NoticeHost />
      </>,
    );
    const card = screen.getByTestId("notice-approval");
    expect(card.textContent).toContain(
      "2 plugins are waiting for your approval",
    );
    expect(card.textContent).toContain("a name, c name");
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(onReview).toHaveBeenCalledExactlyOnceWith("a");
  });

  it("shows nothing when no plugin waits", () => {
    render(
      <>
        <PluginApprovalNotice
          sessionId="s"
          busy={false}
          onReview={vi.fn()}
          plugins={[plugin("a")]}
        />
        <NoticeHost />
      </>,
    );
    expect(screen.queryByTestId("notice-approval")).toBeNull();
  });
});

describe("SessionThemeNotice", () => {
  const select = vi.fn();
  const source = { select } as unknown as PluginThemeSession;
  const show = (node: ReactNode) =>
    render(
      <>
        {node}
        <NoticeHost />
      </>,
    );

  it("stays silent for a theme that works", () => {
    show(<SessionThemeNotice theme={source} sessionId="s" />);
    expect(screen.queryByTestId("notice-session-theme")).toBeNull();
  });

  it("offers the default appearance when the theme could not load", () => {
    theme.error = "resource";
    show(<SessionThemeNotice theme={source} sessionId="s" />);
    const card = screen.getByTestId("notice-session-theme");
    expect(card.textContent).toContain("This game's theme could not be loaded");
    fireEvent.click(
      screen.getByRole("button", { name: "Restore default appearance" }),
    );
    expect(select).toHaveBeenCalledWith(null);
  });
});

describe("WorldStateNotice", () => {
  const stateWith = (settlements: unknown[] = []) => ({
    ...initialState,
    gameState: {
      ...initialState.gameState,
      dimensionProviderPluginId: "keeper",
      dimensionSettlements: settlements,
    },
  });
  const show = (
    plugins: SessionPlugin[],
    notices: WorldDataImportNotice[] = [],
    settlements: unknown[] = [],
  ) =>
    render(
      <SessionStateContext.Provider value={stateWith(settlements)}>
        <WorldStateNotice
          providerPluginId="keeper"
          plugins={plugins}
          notices={notices}
          sessionId="s"
        />
        <NoticeHost />
      </SessionStateContext.Provider>,
    );

  it("says the world state is paused when its plugin is not running", () => {
    show([plugin("keeper")]);
    expect(screen.getByTestId("notice-world-state").textContent).toContain(
      "World state is paused because keeper name is not running",
    );
  });

  it("stays silent while the plugin runs or waits for approval", () => {
    const view = show([plugin("keeper", { active: true })]);
    expect(screen.queryByTestId("notice-world-state")).toBeNull();
    view.unmount();
    show([plugin("keeper", { approvalRequired: true })]);
    expect(screen.queryByTestId("notice-world-state")).toBeNull();
  });

  it("merges the missing-keeper notice and pending settlements into one card", () => {
    show(
      [plugin("keeper", { active: true })],
      [{ level: "warning", code: "dimension-provider-missing", message: "x" }],
      [{ status: "pending-settlement" }],
    );
    const card = screen.getByTestId("notice-world-state");
    expect(card.textContent).toContain("no plugin that is turned on keeps it");
    expect(card.textContent).toContain("settlement body");
    expect(
      document.querySelectorAll('[data-notice-key="world-state"]'),
    ).toHaveLength(1);
  });
});
