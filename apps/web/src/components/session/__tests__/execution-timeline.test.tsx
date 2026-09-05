import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginSummary } from "@covel/shared";
import i18n from "@/i18n";
import { ExecutionTimeline } from "../execution-timeline.js";

function plugin(
  id: string,
  displayName: PluginSummary["displayName"],
): PluginSummary {
  return {
    id,
    displayName,
    description: "",
    pluginType: "plugin",
    source: "builtin",
    status: "registered",
    runtimeCount: 0,
    capabilities: [],
    tags: [],
    runtimes: [],
    tools: [],
    userSettings: [],
  };
}

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
        plugins={[
          plugin("dice-check", { zh: "骰子判定", en: "Dice Check" }),
          plugin("npc-graph", { zh: "关系图谱", en: "Relationship Graph" }),
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
        plugins={[
          plugin("world-ir", {
            zh: "世界事实提取",
            en: "World Fact Extraction",
          }),
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

  it("keeps failures and retry visible after completion and manual folding", () => {
    const { rerender } = render(
      <ExecutionTimeline
        executing
        steps={[
          {
            runtimeId: "story",
            pluginId: "story",
            status: "completed",
            turnId: "turn-1",
          },
          {
            runtimeId: "extract",
            pluginId: "extract",
            status: "failed",
            detail: "Extraction timed out",
            turnId: "turn-1",
          },
        ]}
        onRetryRuntime={() => {}}
      />,
    );
    rerender(
      <ExecutionTimeline
        executing={false}
        steps={[
          {
            runtimeId: "story",
            pluginId: "story",
            status: "completed",
            turnId: "turn-1",
          },
          {
            runtimeId: "extract",
            pluginId: "extract",
            status: "failed",
            detail: "Extraction timed out",
            turnId: "turn-1",
          },
        ]}
        onRetryRuntime={() => {}}
      />,
    );
    const summary = screen.getByRole("button", { name: /Execution/ });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Failed: 1")).toBeTruthy();
    expect(
      screen.getByText("Some updates failed. Review the affected tasks below."),
    ).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Retry this task.*extract/ }),
    ).toBeTruthy();
    fireEvent.click(summary);
    fireEvent.click(summary);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("renders a detached runtime as a compact background task with progress", () => {
    render(
      <ExecutionTimeline
        executing={false}
        steps={[
          {
            runtimeId: "mimo-tts/auto-narrate",
            pluginId: "mimo-tts",
            status: "deferred",
            detached: true,
            jobId: "job-1",
            jobState: "progress",
            progress: 42.3,
            turnId: "turn-1",
          },
        ]}
        plugins={[plugin("mimo-tts", { zh: "语音", en: "Voice" })]}
      />,
    );

    expect(screen.getByText("1 in background")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Execution/ }));
    expect(screen.getByText("Voice / auto-narrate")).toBeTruthy();
    expect(screen.getByText("running in background")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries only failed foreground tasks together while background work continues", () => {
    const retry = vi.fn();
    render(
      <ExecutionTimeline
        executing={false}
        onRetryRuntime={retry}
        steps={[
          {
            runtimeId: "story",
            pluginId: "story",
            turnId: "source",
            status: "completed",
          },
          {
            runtimeId: "a",
            pluginId: "a",
            turnId: "source",
            status: "failed",
            detail: "Model output failed",
          },
          {
            runtimeId: "b",
            pluginId: "b",
            turnId: "source",
            status: "failed",
            detail: "Model output failed",
          },
          {
            runtimeId: "voice",
            pluginId: "voice",
            turnId: "source",
            status: "deferred",
            detached: true,
          },
        ]}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry failed tasks (2)" }),
    );
    expect(retry).toHaveBeenCalledExactlyOnceWith(["a", "b"], "source");
    expect(
      screen.queryByRole("button", {
        name: /Retry this task.*story|Retry this task.*voice/,
      }),
    ).toBeNull();
  });

  it("keeps an old interrupted execution as expandable history without a misleading recovery link", () => {
    const retry = vi.fn();
    render(
      <ExecutionTimeline
        executing={false}
        isLatestTurn={false}
        onRetryRuntime={retry}
        steps={[
          {
            runtimeId: "story",
            pluginId: "story",
            turnId: "old",
            status: "failed",
            detail: "__i18n:session.reasonInterrupted__",
          },
        ]}
      />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Execution/ }));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("recorded execution history");
    expect(alert.textContent).not.toContain("recovery notice");
    expect(within(alert).queryByRole("button")).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });

  it("limits an explicit batch to twenty failures and leaves the rest available", () => {
    const retry = vi.fn();
    const steps = Array.from({ length: 21 }, (_, index) => ({
      runtimeId: `task-${index}`,
      pluginId: `plugin-${index}`,
      turnId: "source",
      status: "failed" as const,
      detail: "Invalid output",
    }));
    render(
      <ExecutionTimeline
        executing={false}
        onRetryRuntime={retry}
        steps={steps}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry the first 20 failed tasks" }),
    );
    expect(retry).toHaveBeenCalledExactlyOnceWith(
      steps.slice(0, 20).map((step) => step.runtimeId),
      "source",
    );
    expect(
      screen.getAllByRole("button", { name: /Retry this task:/ }),
    ).toHaveLength(21);
  });

  it("does not offer task retries when the source turn has not committed", () => {
    render(
      <ExecutionTimeline
        executing={false}
        canRetryTasks={false}
        onRetryRuntime={vi.fn()}
        steps={[
          {
            runtimeId: "story",
            pluginId: "story",
            turnId: "source",
            status: "failed",
            detail: "Missing narrative output",
          },
          {
            runtimeId: "extract",
            pluginId: "extract",
            turnId: "source",
            status: "failed",
            detail: "Invalid output",
          },
        ]}
      />,
    );
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(
      screen.queryByRole("button", {
        name: /Retry this task|Retry failed tasks|Regenerate/,
      }),
    ).toBeNull();
  });
});
