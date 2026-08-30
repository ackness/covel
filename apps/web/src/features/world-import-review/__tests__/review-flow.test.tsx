import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { ReviewPage } from "../components/review-page.js";
import { WorldImportDraftStore } from "../draft-store.js";

/**
 * End-to-end review journey over the frozen v0 fixture, at the component
 * level: load → browse categories → inspect sources → edit → decide on AI
 * inferences → resolve conflict → save → reopen → export-ready state.
 */

const FIXTURE_TITLE = "龙族 I · 火之晨曦 — 世界导入草稿(审阅用 Fixture)";

let dbCounter = 0;
function newStore() {
  dbCounter += 1;
  return new WorldImportDraftStore(`test-review-flow-${dbCounter}`);
}

beforeEach(() => {
  // No ConfirmHost is mounted in tests, so requestConfirm falls back to
  // window.confirm; tests stub it per case.
  vi.restoreAllMocks();
});

afterEach(cleanup);

async function renderReview(store: WorldImportDraftStore) {
  render(<ReviewPage store={store} />);
  await screen.findByText(FIXTURE_TITLE);
}

function clickEntry(name: string) {
  fireEvent.click(screen.getByText(name));
}

async function save() {
  fireEvent.click(screen.getByRole("button", { name: "保存草稿" }));
  await screen.findByText(/已保存于/);
}

describe("World Import Review flow", () => {
  it("loads the fixture and shows the overview with category filtering", async () => {
    await renderReview(newStore());

    // All nine fixture entries are listed.
    for (const name of [
      "路明非",
      "诺诺",
      "龙类研究会",
      "血统压制",
      "卡塞尔学院",
      "村雨",
      "言灵",
      "路明非收到录取通知",
      "路明非 → 诺诺:单向关注",
    ]) {
      expect(screen.getByText(name)).toBeDefined();
    }
    // Fresh fixture has one unresolved conflict — the export warning shows.
    expect(screen.getByText(/仍有 1 个冲突未标记解决/)).toBeDefined();

    // Category filter narrows the list to characters only.
    fireEvent.click(screen.getByRole("button", { name: "人物" }));
    expect(screen.getByText("路明非")).toBeDefined();
    expect(screen.getByText("诺诺")).toBeDefined();
    expect(screen.queryByText("村雨")).toBeNull();
    expect(screen.queryByText("血统压制")).toBeNull();

    // Back to all.
    fireEvent.click(screen.getByRole("button", { name: "全部" }));
    expect(screen.getByText("村雨")).toBeDefined();
  });

  it("shows source locators for source-backed entries and flags pure AI inferences", async () => {
    await renderReview(newStore());

    clickEntry("路明非");
    expect(
      await screen.findByRole("heading", { name: "路明非" }),
    ).toBeDefined();
    expect(screen.getByText("第一章 · 卡塞尔学院的邀请函")).toBeDefined();
    expect(screen.getByText(/欢迎路明非同学加入卡塞尔学院/)).toBeDefined();

    clickEntry("龙类研究会");
    expect(await screen.findByText(/无来源引用/)).toBeDefined();
  });

  it("edit persistence: edit name, save, reopen shows the edited draft", async () => {
    const store = newStore();
    await renderReview(store);

    clickEntry("路明非");
    const nameInput = await screen.findByRole("textbox", { name: "名称" });
    fireEvent.change(nameInput, { target: { value: "路明非(已审)" } });
    expect(screen.getAllByText("已人工编辑").length).toBeGreaterThan(0);

    await save();
    cleanup();

    await renderReview(store);
    expect(await screen.findByText("路明非(已审)")).toBeDefined();
    // Fresh load is not dirty; save is disabled again.
    expect(
      screen.getByRole("button", { name: "保存草稿" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("accepts an AI inference and the decision survives save + reopen", async () => {
    const store = newStore();
    await renderReview(store);

    clickEntry("龙类研究会");
    fireEvent.click(
      await screen.findByRole("button", { name: "接受 AI 推断" }),
    );
    expect(screen.getAllByText("已接受").length).toBeGreaterThan(0);
    await save();
    cleanup();

    await renderReview(store);
    clickEntry("龙类研究会");
    await waitFor(() => {
      expect(screen.getAllByText("已接受").length).toBeGreaterThan(0);
    });
  });

  it("deletes an AI inference only after explicit confirmation", async () => {
    const store = newStore();
    await renderReview(store);
    const confirmSpy = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);

    clickEntry("路明非 → 诺诺:单向关注");
    fireEvent.click(
      await screen.findByRole("button", { name: "删除 AI 推断" }),
    );
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    // Refused — entry stays (listed once, plus the detail heading).
    expect(
      screen.getAllByText("路明非 → 诺诺:单向关注").length,
    ).toBeGreaterThan(0);

    confirmSpy.mockImplementation(() => true);
    fireEvent.click(screen.getByRole("button", { name: "删除 AI 推断" }));
    await waitFor(() => {
      expect(screen.queryByText("路明非 → 诺诺:单向关注")).toBeNull();
    });
  });

  it("resolves a conflict: edits notes, marks resolved, survives save + reopen", async () => {
    const store = newStore();
    await renderReview(store);

    clickEntry("血统压制");
    const notes = await screen.findByRole("textbox", { name: "冲突说明" });
    fireEvent.change(notes, {
      target: { value: "已复核两处来源,以评级条款为准。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "标记冲突已解决" }));
    expect(screen.getAllByText("已解决").length).toBeGreaterThan(0);
    await save();
    // Live warning disappears once the conflict is resolved.
    expect(screen.queryByText(/仍有 1 个冲突未标记解决/)).toBeNull();
    cleanup();

    await renderReview(store);
    clickEntry("血统压制");
    const notesAfter = await screen.findByRole("textbox", {
      name: "冲突说明",
    });
    expect((notesAfter as HTMLTextAreaElement).value).toBe(
      "已复核两处来源,以评级条款为准。",
    );
    expect(screen.getByRole("button", { name: "取消解决标记" })).toBeDefined();
  });

  it("reset to fixture discards saved edits", async () => {
    const store = newStore();
    await renderReview(store);
    vi.spyOn(window, "confirm").mockImplementation(() => true);

    clickEntry("路明非");
    const nameInput = await screen.findByRole("textbox", { name: "名称" });
    fireEvent.change(nameInput, { target: { value: "路明非(已审)" } });
    await save();

    fireEvent.click(screen.getByRole("button", { name: "重置为 fixture" }));
    // The page reloads the fixture asynchronously (loading state in between).
    await screen.findByText("路明非", undefined, { timeout: 3000 });
    expect(screen.queryByText("路明非(已审)")).toBeNull();
  });
});
