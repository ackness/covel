import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { ExecutionStep, StreamMessage } from "@/stores/session-store.js";
import { StageExecutionStatus } from "../StageExecutionStatus.js";

const messages: StreamMessage[] = [
  {
    id: "story",
    role: "assistant",
    kind: "story",
    content: "Already saved story",
    turnId: "source",
    timestamp: "2026-09-05T00:00:00Z",
  },
];
const source: ExecutionStep[] = ["story", "tracker", "world"].map(
  (runtimeId) => ({
    runtimeId,
    pluginId: runtimeId,
    turnId: "source",
    startedAt: "2026-09-05T00:00:00Z",
    status: runtimeId === "story" ? "completed" : "failed",
    attemptStatus: "committed",
    detail: runtimeId === "story" ? undefined : `${runtimeId} failed`,
  }),
);

beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});
afterEach(cleanup);

describe("StageExecutionStatus", () => {
  it("retries a task recovered from the remaining-failures summary without original traces", () => {
    const retry = vi.fn();
    render(
      <StageExecutionStatus
        messages={[]}
        executionSteps={[
          {
            runtimeId: "tracker",
            pluginId: "tracker",
            turnId: "attempt",
            sourceTurnId: "source",
            sourceCommitted: true,
            sourceFailedRuntimeIds: ["world"],
            status: "completed",
            attemptStatus: "committed",
          },
        ]}
        plugins={[]}
        executing={false}
        executionError={null}
        onRetryRuntime={retry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry this task: world" }),
    );
    expect(retry).toHaveBeenCalledWith("world", "source");
  });
  it("leaves uncommitted turn recovery to the authoritative notice without misleading retry actions", () => {
    const retry = vi.fn();
    render(
      <StageExecutionStatus
        messages={[]}
        executionSteps={source.map((step) => ({
          ...step,
          status: "failed",
          attemptStatus: "failed",
        }))}
        plugins={[]}
        executing={false}
        executionError="Narration failed"
        onRetryRuntime={retry}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Retry this task/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Retry failed tasks/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Regenerate this turn" }),
    ).toBeNull();
    expect(retry).not.toHaveBeenCalled();
  });
  it("allows another task retry when its committed source has a failed retry attempt", () => {
    const retry = vi.fn();
    render(
      <StageExecutionStatus
        messages={messages}
        executionSteps={[
          ...source,
          {
            ...source[1],
            turnId: "attempt",
            sourceTurnId: "source",
            status: "failed",
            attemptStatus: "failed",
            startedAt: "2026-09-05T01:00:00Z",
          },
        ]}
        plugins={[]}
        executing={false}
        executionError={null}
        onRetryRuntime={retry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry failed tasks (2)" }),
    );
    expect(retry).toHaveBeenCalledWith(["tracker", "world"], "source");
  });
  it("retries all failed tasks in one action with the original source turn", () => {
    const retry = vi.fn();
    render(
      <StageExecutionStatus
        messages={messages}
        executionSteps={source}
        plugins={[]}
        executing={false}
        executionError={null}
        onRetryRuntime={retry}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry failed tasks (2)" }),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledWith(["tracker", "world"], "source");
  });

  it("keeps the remaining failed task available after another task commits its retry", () => {
    const retry = vi.fn();
    const retryStep: ExecutionStep = {
      ...source[1],
      turnId: "attempt",
      sourceTurnId: "source",
      status: "completed",
      attemptStatus: "committed",
      detail: undefined,
      startedAt: "2026-09-05T01:00:00Z",
    };
    render(
      <StageExecutionStatus
        messages={messages}
        executionSteps={[...source, retryStep]}
        plugins={[]}
        executing={false}
        executionError={null}
        onRetryRuntime={retry}
      />,
    );
    expect(
      screen.getByTestId("stage-execution-status").getAttribute("data-turn-id"),
    ).toBe("source");
    expect(
      screen.queryByRole("button", { name: "Retry this task: tracker" }),
    ).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("world failed")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Retry this task: world" }),
    );
    expect(retry).toHaveBeenCalledWith("world", "source");
  });

  it("shows pending retry progress and provides no duplicate retry while executing", () => {
    const retryStep: ExecutionStep = {
      ...source[1],
      turnId: "attempt",
      sourceTurnId: "source",
      status: "completed",
      attemptStatus: "pending",
      startedAt: "2026-09-05T01:00:00Z",
    };
    render(
      <StageExecutionStatus
        messages={messages}
        executionSteps={[...source, retryStep]}
        plugins={[]}
        executing
        executionError={null}
        onRetryRuntime={vi.fn()}
      />,
    );
    expect(screen.getByTestId("stage-execution-status")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Retry this task/ }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Retry failed tasks/ }),
    ).toBeNull();
  });
});
