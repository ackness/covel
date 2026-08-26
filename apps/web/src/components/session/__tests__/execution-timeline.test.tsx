import { cleanup, render, screen } from "@testing-library/react";
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
});
