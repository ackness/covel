import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import {
  dismissNotice,
  getNoticeSnapshot,
  pushNotice,
  registerNotice,
  removeNotice,
} from "@/lib/notice-center.js";
import { NoticeHost } from "../ui/notice-host.js";
import { NoticeBell } from "../notice-bell.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

const card = (key: string, title: string, scope = "s1") =>
  registerNotice({ key, kind: "card", tone: "warning", title, scope });

it("counts open cards, including collapsed ones, and restores one on click", () => {
  render(
    <>
      <NoticeBell sessionId="s1" />
      <NoticeHost />
    </>,
  );
  expect(screen.queryByTestId("notice-bell-badge")).toBeNull();
  act(() => {
    card("a", "Card A");
    card("b", "Card B");
    dismissNotice("a");
  });
  expect(screen.getByTestId("notice-bell-badge").textContent).toBe("2");
  expect(screen.queryByText("Card A")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
  fireEvent.click(screen.getByRole("button", { name: /Card A/ }));
  expect(
    getNoticeSnapshot().cards.find((c) => c.notice.key === "a"),
  ).toMatchObject({
    collapsed: false,
  });
  expect(screen.getByRole("status", { name: "Card A" })).toBeTruthy();
});

it("flags a collapsed card that changed", () => {
  render(<NoticeBell sessionId="s1" />);
  act(() => {
    card("a", "Card A");
    dismissNotice("a");
    card("a", "Card A changed");
  });
  expect(screen.getByTestId("notice-bell-badge").className).toContain("ring-2");
});

it("lists history newest first, groups by game, and copies details", async () => {
  const writeText = vi.fn(async () => {});
  Object.assign(navigator, { clipboard: { writeText } });
  act(() => {
    pushNotice({
      key: "old",
      kind: "toast",
      tone: "info",
      title: "Old news",
      scope: "s1",
    });
    pushNotice({
      key: "elsewhere",
      kind: "toast",
      tone: "info",
      title: "Other game",
      scope: "s2",
    });
    pushNotice({
      key: "quiet",
      kind: "toast",
      tone: "warning",
      title: "Quiet failure",
      detail: "raw payload",
      scope: "s1",
      quiet: true,
    });
    card("gone", "Resolved card");
    removeNotice("gone");
  });
  render(<NoticeBell sessionId="s1" />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  const titles = () =>
    screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector("p")?.textContent);
  expect(titles()).toEqual(["Resolved card", "Quiet failure", "Old news"]);
  fireEvent.click(screen.getByRole("button", { name: "All" }));
  expect(titles()).toContain("Other game");
  fireEvent.click(screen.getByRole("button", { name: "Copy detail" }));
  expect(writeText).toHaveBeenCalledWith("raw payload");
});

it("shows everything when no game is open", () => {
  act(() =>
    pushNotice({ key: "t", kind: "toast", tone: "info", title: "Anywhere" }),
  );
  render(<NoticeBell />);
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect(screen.getByText("Anywhere")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "This game" })).toBeNull();
});
