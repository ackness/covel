import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { getNoticeSnapshot, registerNotice } from "@/lib/notice-center.js";
import { emitToast } from "@/lib/toast-channel.js";
import { NoticeHost, useNoticeAnchor } from "../notice-host.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("pauses until both keyboard focus and hover leave the notification", () => {
  vi.useFakeTimers();
  render(<NoticeHost />);
  act(() => emitToast("error", "Read this error", "Details"));
  const toast = screen.getByRole("alert");
  const [copy, dismiss] = screen.getAllByRole("button");
  if (!copy || !dismiss) throw new Error("Missing toast controls");
  act(() => copy.focus());
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseEnter(toast);
  act(() => dismiss.focus());
  fireEvent.mouseLeave(toast);
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseEnter(toast);
  act(() => dismiss.blur());
  act(() => vi.advanceTimersByTime(7000));
  expect(screen.getByRole("alert")).toBe(toast);
  fireEvent.mouseLeave(toast);
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("fades info toasts after 3 seconds and errors after 6", () => {
  vi.useFakeTimers();
  render(<NoticeHost />);
  act(() => {
    emitToast("info", "Saved");
    emitToast("error", "Broke");
  });
  act(() => vi.advanceTimersByTime(3100));
  expect(screen.queryByText("Saved")).toBeNull();
  expect(screen.getByText("Broke")).toBeTruthy();
  act(() => vi.advanceTimersByTime(3000));
  expect(screen.queryByText("Broke")).toBeNull();
});

it("stacks cards above toasts, never times a card out, and collapses it with the close button", () => {
  vi.useFakeTimers();
  render(<NoticeHost />);
  act(() => {
    emitToast("info", "A toast");
    registerNotice({
      key: "approval",
      kind: "card",
      tone: "warning",
      title: "A card",
      body: "Needs you",
      actions: [{ label: "Review", onClick: vi.fn() }],
    });
  });
  const hosts = Array.from(document.querySelectorAll("[data-notice-host]"));
  for (const host of hosts)
    expect(host.hasAttribute("data-covel-host-controls")).toBe(true);
  expect(
    Array.from(document.querySelectorAll("[data-notice-kind]")).map((el) =>
      el.getAttribute("data-notice-kind"),
    ),
  ).toEqual(["card", "toast"]);
  // Cards render inside the app, under the session header menus (z 40) and
  // dialogs; brief toasts go to <body> and sit above everything.
  const cards = document.querySelector("[data-notice-cards]")!;
  const toasts = document.querySelector("[data-notice-toasts]")!;
  expect(cards.className).toContain("z-30");
  expect(cards.parentElement).not.toBe(document.body);
  expect(toasts.className).toContain("z-100");
  expect(toasts.parentElement).toBe(document.body);
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText("A card")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Review" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Hide for now" }));
  expect(screen.queryByText("A card")).toBeNull();
  // Collapsed, not gone: still an open card for the bell.
  expect(getNoticeSnapshot().cards).toHaveLength(1);
});

it("uses role=status for non-errors and runs action handlers", () => {
  const onClick = vi.fn();
  render(<NoticeHost />);
  act(() =>
    registerNotice({
      key: "x",
      kind: "card",
      tone: "info",
      title: "Heads up",
      actions: [{ label: "Go", onClick }],
    }),
  );
  expect(screen.getByRole("status").textContent).toContain("Heads up");
  fireEvent.click(screen.getByRole("button", { name: "Go" }));
  expect(onClick).toHaveBeenCalledOnce();
});

it("renders a rich card body supplied by the producer", () => {
  render(<NoticeHost />);
  act(() =>
    registerNotice({
      key: "rich",
      kind: "card",
      tone: "error",
      title: "Rich",
      render: () => <p data-testid="rich-body">custom</p>,
    }),
  );
  expect(screen.getByTestId("rich-body")).toBeTruthy();
  expect(screen.getByRole("alert")).toBeTruthy();
});

function Anchor({ bottom }: { bottom: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useNoticeAnchor(ref);
  return (
    <div
      ref={(element) => {
        ref.current = element;
        if (element)
          element.getBoundingClientRect = () =>
            ({ top: 0, bottom, height: bottom }) as DOMRect;
      }}
    />
  );
}

it("keeps notices under the lowest registered top chrome", async () => {
  const offset = () =>
    document.documentElement.style.getPropertyValue("--covel-notice-top");
  const view = render(
    <>
      <NoticeHost />
      <Anchor bottom={48} />
      <Anchor bottom={96} />
    </>,
  );
  await waitFor(() => expect(offset()).toBe("104px"));
  view.rerender(
    <>
      <NoticeHost />
      <Anchor bottom={48} />
    </>,
  );
  await waitFor(() => expect(offset()).toBe("56px"));
});
