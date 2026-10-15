import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorldDataImportNotice } from "@covel/shared";
import i18n from "@/i18n";
import { WorldDataNotices } from "../world-data-notices.js";

const skipped: WorldDataImportNotice = {
  level: "warning",
  sourceId: "facts",
  code: "receiver-missing",
  message: 'No active receiver for data contract "notes@1"; source skipped',
};

describe("WorldDataNotices", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });
  afterEach(cleanup);

  it("lists the skipped data until hidden, and shows a later import again", () => {
    const { rerender } = render(<WorldDataNotices notices={[skipped]} />);
    expect(screen.getByTestId("world-data-notices").textContent).toContain(
      '"facts": no enabled plugin receives this data.',
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("world-data-notices")).toBeNull();
    rerender(<WorldDataNotices notices={[{ ...skipped }]} />);
    expect(screen.getByTestId("world-data-notices")).toBeTruthy();
    rerender(<WorldDataNotices notices={[]} />);
    expect(screen.queryByTestId("world-data-notices")).toBeNull();
  });

  it("says a coded notice in the interface language", async () => {
    await i18n.changeLanguage("zh-CN");
    render(
      <WorldDataNotices
        notices={[
          {
            level: "warning",
            code: "dimension-provider-missing",
            message: "No active plugin provides world.dimensions@1",
          },
        ]}
      />,
    );
    const text = screen.getByTestId("world-data-notices").textContent ?? "";
    expect(text).toContain("没有启用的插件保存它们");
    expect(text).not.toContain("No active plugin");
  });

  it("folds an uncoded message under its details", () => {
    render(
      <WorldDataNotices
        notices={[
          { level: "error", sourceId: "map", message: "invalid target URI" },
        ]}
      />,
    );
    const details = screen
      .getByText('The data in "map" was not imported (details)')
      .closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("invalid target URI");
  });
});
