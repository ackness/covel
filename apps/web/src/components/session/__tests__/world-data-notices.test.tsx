import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorldDataImportNotice } from "@covel/shared";
import i18n from "@/i18n";
import { WorldDataNotices } from "../world-data-notices.js";

const skipped: WorldDataImportNotice = {
  level: "warning",
  sourceId: "facts",
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
      'facts: No active receiver for data contract "notes@1"',
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByTestId("world-data-notices")).toBeNull();
    rerender(<WorldDataNotices notices={[{ ...skipped }]} />);
    expect(screen.getByTestId("world-data-notices")).toBeTruthy();
    rerender(<WorldDataNotices notices={[]} />);
    expect(screen.queryByTestId("world-data-notices")).toBeNull();
  });
});
