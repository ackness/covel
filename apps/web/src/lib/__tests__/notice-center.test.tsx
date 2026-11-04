import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSettings, getSettings } from "@/settings/store.js";
import { emitToast, subscribeToast } from "../toast-channel.js";
import {
  HISTORY_LIMIT,
  dismissNotice,
  getNoticeSnapshot,
  pushNotice,
  registerNotice,
  removeNotice,
  resetNoticeCenter,
  restoreNotice,
  useNotice,
  type NoticeInput,
} from "../notice-center.js";

const card = (over: Partial<NoticeInput> = {}): NoticeInput => ({
  key: "approval",
  kind: "card",
  tone: "warning",
  title: "One plugin is waiting",
  ...over,
});

beforeEach(() => resetNoticeCenter());
afterEach(cleanup);

describe("notice center store", () => {
  it("replaces an entry pushed under the same key", () => {
    emitToast("info", "Saved");
    emitToast("info", "Saved");
    pushNotice({ key: "a", kind: "toast", tone: "info", title: "first" });
    pushNotice({ key: "a", kind: "toast", tone: "info", title: "second" });
    const { toasts } = getNoticeSnapshot();
    expect(toasts.map((toast) => toast.title)).toEqual(["Saved", "second"]);
  });

  it("keeps three toasts visible and the rest in history", () => {
    for (const n of [1, 2, 3, 4]) emitToast("info", `t${n}`);
    const snapshot = getNoticeSnapshot();
    expect(snapshot.toasts.map((toast) => toast.title)).toEqual([
      "t2",
      "t3",
      "t4",
    ]);
    expect(snapshot.history.map((item) => item.title)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
    ]);
  });

  it("keeps emitToast subscribers and its clamp and duration options", () => {
    const seen = vi.fn();
    const off = subscribeToast(seen);
    emitToast("error", "Broken", "x".repeat(5000), { durationMs: 9000 });
    off();
    expect(seen).toHaveBeenCalledOnce();
    const event = seen.mock.calls[0]![0] as {
      kind: string;
      message: string;
      detail: string;
      durationMs: number;
    };
    expect(event).toMatchObject({
      kind: "error",
      message: "Broken",
      durationMs: 9000,
    });
    expect(event.detail).toHaveLength(4001);
  });

  it("collapses a card into the bell and restores it", () => {
    registerNotice(card());
    expect(getNoticeSnapshot().cards[0]).toMatchObject({ collapsed: false });
    dismissNotice("approval");
    expect(getNoticeSnapshot().cards[0]).toMatchObject({ collapsed: true });
    // Collapsing does not resolve it: it is still an open card.
    expect(getNoticeSnapshot().history[0]?.state).toBe("open");
    restoreNotice("approval");
    expect(getNoticeSnapshot().cards[0]).toMatchObject({ collapsed: false });
  });

  it("keeps a collapsed card collapsed when its content changes, and flags it", () => {
    registerNotice(card());
    dismissNotice("approval");
    registerNotice(card());
    expect(getNoticeSnapshot().cards[0]).toMatchObject({
      collapsed: true,
      changed: false,
    });
    registerNotice(card({ title: "Two plugins are waiting" }));
    expect(getNoticeSnapshot().cards[0]).toMatchObject({
      collapsed: true,
      changed: true,
    });
    expect(getNoticeSnapshot().cards).toHaveLength(1);
    restoreNotice("approval");
    expect(getNoticeSnapshot().cards[0]).toMatchObject({
      collapsed: false,
      changed: false,
    });
  });

  it("marks a removed card resolved in the history", () => {
    registerNotice(card());
    removeNotice("approval");
    const snapshot = getNoticeSnapshot();
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]).toMatchObject({
      key: "approval",
      state: "resolved",
    });
  });

  it("keeps only the last 50 history entries per scope", () => {
    for (let n = 0; n < HISTORY_LIMIT + 10; n++)
      pushNotice({
        key: `k${n}`,
        kind: "toast",
        tone: "info",
        title: `n${n}`,
        scope: "s1",
      });
    pushNotice({
      key: "other",
      kind: "toast",
      tone: "info",
      title: "other scope",
      scope: "s2",
    });
    const { history } = getNoticeSnapshot();
    expect(history.filter((item) => item.scope === "s1")).toHaveLength(
      HISTORY_LIMIT,
    );
    expect(history.find((item) => item.title === "n0")).toBeUndefined();
    expect(history.find((item) => item.title === "n59")).toBeDefined();
    expect(history.filter((item) => item.scope === "s2")).toHaveLength(1);
  });

  it("limits actions to two and clamps detail", () => {
    registerNotice(
      card({
        detail: "d".repeat(4100),
        actions: ["a", "b", "c"].map((label) => ({ label, onClick() {} })),
      }),
    );
    const { notice } = getNoticeSnapshot().cards[0]!;
    expect(notice.actions).toHaveLength(2);
    expect(notice.detail).toHaveLength(4001);
  });

  describe("quiet entries", () => {
    it("go to the history only", () => {
      pushNotice({
        key: "q",
        kind: "toast",
        tone: "warning",
        title: "Background failure",
        quiet: true,
      });
      const snapshot = getNoticeSnapshot();
      expect(snapshot.toasts).toEqual([]);
      expect(snapshot.history[0]).toMatchObject({ state: "quiet" });
    });

    it("also show as toasts while developer mode is on", async () => {
      await initSettings();
      await getSettings().set("ui.developerView", true);
      try {
        const seen = vi.fn();
        const off = subscribeToast(seen);
        pushNotice({
          key: "q",
          kind: "toast",
          tone: "warning",
          title: "Background failure",
          quiet: true,
        });
        off();
        expect(getNoticeSnapshot().toasts).toHaveLength(1);
        expect(seen).toHaveBeenCalledOnce();
        expect(getNoticeSnapshot().history[0]).toMatchObject({
          state: "quiet",
        });
      } finally {
        await getSettings().set("ui.developerView", false);
      }
    });
  });
});

describe("useNotice", () => {
  function Producer({ entry }: { entry: NoticeInput | null }) {
    useNotice(entry);
    return null;
  }

  it("registers on mount and removes on unmount or null", () => {
    const view = render(<Producer entry={card()} />);
    expect(getNoticeSnapshot().cards).toHaveLength(1);
    view.rerender(<Producer entry={null} />);
    expect(getNoticeSnapshot().cards).toEqual([]);
    view.rerender(<Producer entry={card()} />);
    expect(getNoticeSnapshot().cards).toHaveLength(1);
    view.unmount();
    expect(getNoticeSnapshot().cards).toEqual([]);
  });

  it("compares by value and runs the latest handler", () => {
    const first = vi.fn();
    const second = vi.fn();
    const entry = (onClick: () => void) =>
      card({ actions: [{ label: "Review", onClick }] });
    const view = render(<Producer entry={entry(first)} />);
    const before = getNoticeSnapshot();
    view.rerender(<Producer entry={entry(second)} />);
    expect(getNoticeSnapshot()).toBe(before);
    act(() => getNoticeSnapshot().cards[0]!.notice.actions![0]!.onClick());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });

  it("keeps a collapsed card collapsed across content changes", () => {
    const view = render(<Producer entry={card()} />);
    act(() => dismissNotice("approval"));
    view.rerender(<Producer entry={card({ title: "Changed" })} />);
    expect(getNoticeSnapshot().cards[0]).toMatchObject({
      collapsed: true,
      changed: true,
    });
  });

  it("shows status entries separately from cards", () => {
    render(
      <Producer
        entry={{ key: "auto", kind: "status", tone: "info", title: "1 / 5" }}
      />,
    );
    expect(getNoticeSnapshot().statuses).toHaveLength(1);
    expect(getNoticeSnapshot().cards).toEqual([]);
  });
});
