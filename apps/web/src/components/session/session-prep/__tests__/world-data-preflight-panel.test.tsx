import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { WorldDataPreflightPanel } from "../world-data-preflight-panel.js";

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

describe("WorldDataPreflightPanel", () => {
  it("counts what will be imported instead of listing storage addresses", () => {
    render(
      <WorldDataPreflightPanel
        status="success"
        error={null}
        onRetry={() => {}}
        result={{
          imported: true,
          planned: 4,
          diagnostics: [
            {
              level: "warning",
              sourceId: "portraits",
              code: "receiver-missing",
              message: 'No active receiver for data contract "x@1"',
            },
          ],
          targets: [
            {
              kind: "character",
              target: "character",
              sourceId: "cast",
              key: "a",
            },
            {
              kind: "character",
              target: "character",
              sourceId: "cast",
              key: "b",
            },
            {
              kind: "media-index",
              target: "contract:character.portrait-assets@1",
              sourceId: "portraits",
              key: "chen-yuanshan.webp",
            },
            {
              kind: "lorebook",
              target: "lorebook",
              sourceId: "lore",
              key: "c",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("2 characters")).toBeTruthy();
    expect(screen.getByText("1 image")).toBeTruthy();
    expect(screen.getByText("1 lore entry")).toBeTruthy();
    expect(screen.queryByText(/portrait-assets/)).toBeNull();
    expect(
      screen.getByText('"portraits": no enabled plugin receives this data.'),
    ).toBeTruthy();
  });
});
