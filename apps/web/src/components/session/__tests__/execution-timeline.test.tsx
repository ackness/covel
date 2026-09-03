import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { ExecutionTimeline } from "../execution-timeline.js";

describe("ExecutionTimeline plugin names", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en-US");
  });

  afterEach(() => cleanup());

  it("resolves short manifest locale keys in an English UI", () => {
    render(
      <ExecutionTimeline
        executing
        steps={[
          {
            runtimeId: "dice-check/roller",
            pluginId: "dice-check",
            status: "running",
            turnId: "turn-1",
          },
          {
            runtimeId: "npc-graph/rag-retriever",
            pluginId: "npc-graph",
            status: "completed",
            turnId: "turn-1",
          },
        ]}
        packages={[
          {
            name: "dice-check",
            displayName: { zh: "骰子判定", en: "Dice Check" },
            enabled: true,
          },
          {
            name: "npc-graph",
            displayName: { zh: "关系图谱", en: "Relationship Graph" },
            enabled: true,
          },
        ]}
      />,
    );

    expect(screen.getByText("Dice Check / roller")).toBeTruthy();
    expect(screen.getByText("Relationship Graph / rag-retriever")).toBeTruthy();
    expect(screen.queryByText(/骰子判定|关系图谱/)).toBeNull();
  });

  it("renders failure details as a bounded callout outside the status chip", () => {
    const { container } = render(
      <ExecutionTimeline
        executing
        steps={[
          {
            runtimeId: "world-ir",
            pluginId: "world-ir",
            status: "failed",
            turnId: "turn-1",
            detail: "__i18n:session.reasonConnectionClosed__",
          },
        ]}
        packages={[
          {
            name: "world-ir",
            displayName: { zh: "世界中间表示", en: "World IR" },
            enabled: true,
          },
        ]}
      />,
    );

    const callout = screen.getByRole("alert");
    const chip = container.querySelector(".ui-chip");
    expect(chip).toBeTruthy();
    expect(chip?.contains(callout)).toBe(false);
    expect(callout.closest(".ui-chip")).toBeNull();
    expect(
      within(callout).getByText(
        "The task stream ended before its final status arrived. Retry this task.",
      ),
    ).toBeTruthy();

    const detailButton = within(callout).getByRole("button", {
      name: "Show details",
    });
    expect(detailButton.getAttribute("aria-expanded")).toBe("false");
    expect(detailButton.getAttribute("aria-controls")).toBeTruthy();

    fireEvent.click(detailButton);

    expect(detailButton.getAttribute("aria-expanded")).toBe("true");
    expect(
      within(callout).getByText(
        "Connection closed but backend did not report completion",
      ),
    ).toBeTruthy();
  });
});
