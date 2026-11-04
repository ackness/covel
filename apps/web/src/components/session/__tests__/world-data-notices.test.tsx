import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorldDataImportNotice } from "@covel/shared";
import i18n from "@/i18n";
import { NoticeHost } from "@/components/ui/notice-host.js";
import { WorldDataNoticeCards } from "../world-data-notices.js";

function show(notices: readonly WorldDataImportNotice[]) {
  const tree = (list: readonly WorldDataImportNotice[]) => (
    <>
      <WorldDataNoticeCards notices={list} sessionId="s" />
      <NoticeHost />
    </>
  );
  const view = render(tree(notices));
  return {
    ...view,
    update: (list: readonly WorldDataImportNotice[]) =>
      view.rerender(tree(list)),
  };
}

const skipped: WorldDataImportNotice = {
  level: "warning",
  sourceId: "facts",
  code: "receiver-missing",
  message: 'No active receiver for data contract "notes@1"; source skipped',
};

describe("WorldDataNoticeCards", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });
  afterEach(cleanup);

  it("shows a card per kind of problem and removes it when the data is no longer skipped", () => {
    const view = show([
      skipped,
      { ...skipped, code: "receiver-ambiguous" },
      { ...skipped, sourceId: "more" },
    ]);
    expect(
      screen.getByTestId("notice-world-data:receiver-missing").textContent,
    ).toContain("This data has no plugin to receive it.");
    expect(
      screen.getByTestId("notice-world-data:receiver-ambiguous"),
    ).toBeTruthy();
    // Two skipped sources of one kind share a card.
    expect(
      screen
        .getByTestId("notice-world-data:receiver-missing")
        .querySelector("p.whitespace-pre-line")
        ?.textContent?.split("\n"),
    ).toHaveLength(2);
    view.update([]);
    expect(document.querySelector("[data-notice-key]")).toBeNull();
  });

  it("leaves approval and world-state notices to their own cards", () => {
    show([
      { ...skipped, code: "receiver-approval-required" },
      {
        level: "warning",
        code: "dimension-provider-missing",
        message: "No active plugin provides world.dimensions@1",
      },
    ]);
    expect(document.querySelector("[data-notice-key]")).toBeNull();
  });

  it("says a titled notice in the interface language", async () => {
    await i18n.changeLanguage("zh-CN");
    show([skipped]);
    const text =
      screen.getByTestId("notice-world-data:receiver-missing").textContent ??
      "";
    expect(text).toContain("没有插件接收");
    expect(text).not.toContain("No active receiver");
  });

  it("keeps the raw message of an import failure as copyable detail", () => {
    show([{ level: "error", sourceId: "map", message: "invalid target URI" }]);
    const card = screen.getByTestId("notice-world-data:import-failed");
    expect(card.textContent).toContain('The data in "map" was not imported');
    expect(card.textContent).toContain("invalid target URI");
    expect(screen.getByRole("button", { name: "Copy detail" })).toBeTruthy();
  });

  it.each(["receiver-missing", "receiver-ambiguous", "receiver-excluded"])(
    "renders a fixed player message for %s without source or error sentinels",
    (code) => {
      show([
        {
          level: "warning",
          code,
          sourceId: "SECRET_SOURCE",
          message: "SECRET_FILE: SECRET_RECORD",
        },
      ]);
      expect(document.body.textContent).toContain(
        "This data has no plugin to receive it.",
      );
      expect(document.body.textContent).not.toContain("SECRET");
    },
  );

  it.each(["receiver-missing", "receiver-ambiguous", "receiver-excluded"])(
    "renders the safe public label for %s through the interface language",
    async (code) => {
      await i18n.changeLanguage("zh-CN");
      show([
        {
          level: "warning",
          code,
          publicLabel: "公开笔记",
          sourceId: "SECRET_SOURCE",
          message: "SECRET_ERROR",
        },
        { level: "warning", code, message: "SECRET_ERROR" },
      ]);
      const lines = (
        screen
          .getByTestId(`notice-world-data:${code}`)
          .querySelector("p.whitespace-pre-line")?.textContent ?? ""
      ).split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain("公开笔记");
      expect(lines[1]).not.toContain("公开笔记");
      expect(document.body.textContent).not.toMatch(/SECRET|This data/);
    },
  );
});
