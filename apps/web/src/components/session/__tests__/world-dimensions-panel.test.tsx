import i18n from "@/i18n/index.js";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DimensionSnapshot } from "@covel/shared";
import { WorldDimensionsPanel } from "../world-dimensions-panel.js";

const dimensions: DimensionSnapshot = {
  cities: {
    name: "Cities",
    schema: {
      type: "object",
      additionalProperties: {
        type: "object",
        required: ["wealth"],
        properties: {
          wealth: { title: "Wealth", type: "integer", minimum: 0 },
        },
      },
    },
    value: { harbor: { wealth: 1 } },
    version: 7,
  },
};

describe("WorldDimensionsPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });
  it("shows localized titles and enum labels while storing enum IDs", async () => {
    await i18n.changeLanguage("zh-CN");
    const onEdit = vi.fn().mockResolvedValue(undefined);
    const board: DimensionSnapshot = {
      caseBoard: {
        name: "Case Board",
        schema: {
          type: "object",
          additionalProperties: {
            type: "object",
            properties: {
              status: {
                type: "string",
                title: { "zh-CN": "状态", "en-US": "Status" },
                enum: ["unverified", "resolved"],
                "x-enumLabels": {
                  unverified: { "zh-CN": "未核实", "en-US": "Unverified" },
                  resolved: { "zh-CN": "已解决", "en-US": "Resolved" },
                },
              },
            },
          },
        },
        value: { letter: { status: "unverified" } },
        version: 2,
      },
    };
    render(<WorldDimensionsPanel dimensions={board} onEdit={onEdit} />);
    expect(screen.getByRole("columnheader", { name: "状态" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "未核实" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /编辑|edit$/i }));
    const select = screen.getByRole("combobox", { name: "状态" });
    expect(within(select).getByRole("option", { name: "已解决" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "移除 状态" })).toBeTruthy();
    fireEvent.change(select, { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /保存|save/i }));
    await vi.waitFor(() =>
      expect(onEdit).toHaveBeenCalledWith(
        expect.objectContaining({
          updates: [
            expect.objectContaining({
              id: "caseBoard",
              expectedVersion: 2,
              value: { letter: { status: "resolved" } },
            }),
          ],
        }),
        undefined,
      ),
    );
  });
  it("edits named-map fields and adds schema-directed rows with the captured version", async () => {
    const onEdit = vi.fn().mockResolvedValue(undefined);
    render(<WorldDimensionsPanel dimensions={dimensions} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: /edit$/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Wealth" }), {
      target: { value: "4" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "New row key" }), {
      target: { value: "lake" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onEdit).toHaveBeenCalledWith(
      {
        updates: [
          {
            id: "cities",
            expectedVersion: 7,
            value: { harbor: { wealth: 4 }, lake: { wealth: 0 } },
          },
        ],
      },
      undefined,
    );
  });
  it("does not silently rebase an edit when a newer snapshot arrives", async () => {
    const onEdit = vi
      .fn()
      .mockRejectedValue(new Error("dimension-version-conflict"));
    const view = render(
      <WorldDimensionsPanel dimensions={dimensions} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit$/i }));
    view.rerender(
      <WorldDimensionsPanel
        dimensions={{ cities: { ...dimensions.cities!, version: 8 } }}
        onEdit={onEdit}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(onEdit.mock.calls[0]?.[0].updates[0].expectedVersion).toBe(7);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "dimension-version-conflict",
    );
  });
  it("validates field edits and shows pending debt even without values", async () => {
    const onEdit = vi.fn();
    const view = render(
      <WorldDimensionsPanel dimensions={dimensions} onEdit={onEdit} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /edit$/i }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Wealth" }), {
      target: { value: "-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onEdit).not.toHaveBeenCalled();
    view.unmount();
    render(
      <WorldDimensionsPanel
        dimensions={{}}
        settlements={[
          {
            source: { resultId: "source", turnNumber: 1 },
            sourceTurnId: "turn",
            version: 1,
            status: "pending-settlement",
            error: "Maintenance failed",
          },
        ]}
        onEdit={onEdit}
      />,
    );
    expect(screen.getByText("Maintenance failed")).toBeTruthy();
    fireEvent.click(
      within(
        screen.getByText("Maintenance failed").closest("section")!,
      ).getByRole("button", { name: /skip/i }),
    );
    expect(onEdit).toHaveBeenCalledWith(
      { updates: [], resultId: "source", resolution: "skipped" },
      "turn",
    );
  });
});
