import type { ComponentType, MouseEventHandler, ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  component: null as ComponentType | null,
  navigate: vi.fn(),
  pathname: "/session",
  search: {} as Record<string, unknown>,
  sessionId: undefined as string | undefined,
  worldId: undefined as string | undefined,
  hasExecutionRecovery: false,
  navLayout: "bar" as "bar" | "rail",
  developer: false,
  emitSettings: vi.fn(),
  emitWorldList: vi.fn(),
  backToWorldSelect: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: { component: ComponentType }) => {
    mocks.component = options.component;
    return options;
  },
  Link: ({
    children,
    onClick,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
    "aria-label"?: string;
  }) => (
    <a href="/session" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useLocation: () => ({ pathname: mocks.pathname, search: mocks.search }),
  useNavigate: () => mocks.navigate,
}));
vi.mock("@/stores/session-store", () => ({
  useSession: () => ({
    state: {
      session: mocks.sessionId ? { id: mocks.sessionId } : null,
      world: mocks.worldId ? { id: mocks.worldId } : null,
      executionRecovery: mocks.hasExecutionRecovery
        ? {
            sessionId: "broken-session",
            status: null,
            hydrating: false,
            checking: false,
            stalled: true,
            error: "schemaVersion must be 3",
          }
        : null,
    },
    backToWorldSelect: mocks.backToWorldSelect,
  }),
}));
vi.mock("@/settings/use-settings.js", () => ({
  useSetting: () => [mocks.developer, vi.fn()],
}));
vi.mock("@/settings/store.js", () => ({
  receiveSettingsBackupNotices: () => () => {},
  settingLabels: () => "",
}));
vi.mock("@/lib/nav-events.js", () => ({
  emitSettingsRequest: mocks.emitSettings,
  emitWorldListRequest: mocks.emitWorldList,
}));
vi.mock("@/components/ui/notice-host", () => ({
  NoticeHost: () => null,
  useNoticeAnchor: () => undefined,
}));
vi.mock("@/components/notice-bell", () => ({
  NoticeBell: () => <button>bell</button>,
}));
vi.mock("@/components/ui/confirm-host", () => ({ ConfirmHost: () => null }));
vi.mock("@/components/error-boundary", () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/shared-server-notice", () => ({
  useSharedServerNotice: () => {},
}));
vi.mock("@/hooks/use-window-controls-colors.js", () => ({
  useWindowControlsColors: () => {},
}));
vi.mock("@/lib/desktop-bridge", () => ({ getCovelIpc: () => null }));
vi.mock("@/theme-system/use-theme-layout.js", () => ({
  useThemeLayout: () => ({ nav: mocks.navLayout }),
}));

import i18n from "@/i18n";
import "../__root.js";

beforeAll(async () => {
  await i18n.changeLanguage("en-US");
});
beforeEach(() => {
  mocks.pathname = "/session";
  mocks.search = {};
  mocks.sessionId = undefined;
  mocks.worldId = undefined;
  mocks.hasExecutionRecovery = false;
  mocks.navLayout = "bar";
  mocks.developer = false;
  vi.clearAllMocks();
});
afterEach(cleanup);

function nav() {
  const Layout = mocks.component!;
  render(<Layout />);
  const primary = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
  return [...primary.querySelectorAll("button")].map((b) => b.textContent);
}

it("offers World and Settings only, with nothing greyed out, before a game opens", () => {
  expect(nav()).toEqual(["World", "Settings"]);
});

it("adds Games while a game is open, renamed from Session", () => {
  mocks.sessionId = "s1";
  expect(nav()).toEqual(["World", "Games", "Settings"]);
});

it("shows Debugger only in developer mode and never Plugins, Images, theme or language", () => {
  mocks.sessionId = "s1";
  mocks.developer = true;
  expect(nav()).toEqual(["World", "Games", "Settings", "Debugger"]);
  expect(screen.queryByRole("button", { name: /plugins|images/i })).toBeNull();
  expect(screen.queryByLabelText(/dark mode/i)).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("opens the settings dialog from Settings, going to the game first from the debugger", () => {
  mocks.sessionId = "s1";
  const Layout = mocks.component!;
  const view = render(<Layout />);
  const primary = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
  fireEvent.click(
    [...primary.querySelectorAll("button")].find(
      (b) => b.textContent === "Settings",
    )!,
  );
  expect(mocks.emitSettings).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).not.toHaveBeenCalled();

  view.unmount();
  mocks.pathname = "/debug";
  mocks.search = { sid: "s1" };
  mocks.developer = true;
  render(<Layout />);
  const debugNav = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
  fireEvent.click(
    [...debugNav.querySelectorAll("button")].find(
      (b) => b.textContent === "Settings",
    )!,
  );
  expect(mocks.navigate).toHaveBeenCalledWith({
    to: "/session",
    search: { sid: "s1" },
  });
});

it.each(["bar", "rail"] as const)(
  "clears stalled hydration recovery and returns home when clicking the Covel logo in %s layout",
  (layout) => {
    mocks.navLayout = layout;
    mocks.hasExecutionRecovery = true;
    const Layout = mocks.component!;
    render(<Layout />);

    const links = screen.getAllByRole("link", { name: "Covel" });
    fireEvent.click(links[0]!);

    expect(mocks.backToWorldSelect).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/session",
      search: {},
    });
    expect(mocks.emitWorldList).toHaveBeenCalledTimes(1);
  },
);

it("clears world prep and stalled hydration recovery from the World nav button even without an active session", () => {
  mocks.worldId = "world-1";
  mocks.hasExecutionRecovery = true;
  const Layout = mocks.component!;
  render(<Layout />);

  const primary = screen.getAllByRole("navigation", { name: "Primary" })[0]!;
  fireEvent.click(
    [...primary.querySelectorAll("button")].find(
      (b) => b.textContent === "World",
    )!,
  );

  expect(mocks.backToWorldSelect).toHaveBeenCalledTimes(1);
  expect(mocks.navigate).toHaveBeenCalledWith({ to: "/session", search: {} });
  expect(mocks.emitWorldList).toHaveBeenCalledTimes(1);
});
