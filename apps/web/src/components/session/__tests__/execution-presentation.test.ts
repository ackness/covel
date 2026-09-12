import { describe, expect, it } from "vitest";
import {
  executionPresentation,
  latestExecutionPresentation,
} from "../execution-presentation.js";
import type { ExecutionStep, StreamMessage } from "@/stores/session-store.js";

const story: StreamMessage = {
  id: "story",
  role: "assistant",
  content: "A new scene.",
  kind: "story",
  turnId: "old",
  timestamp: "2026-09-01T00:00:00Z",
};
const failed: ExecutionStep = {
  runtimeId: "tracker",
  pluginId: "tracker",
  turnId: "old",
  status: "failed",
};

describe("execution presentation", () => {
  it("distinguishes uncommitted stops, failures, and committed partial results", () => {
    expect(
      executionPresentation({
        executing: false,
        steps: [
          {
            ...failed,
            abortReason: "aborted-by-player",
            attemptStatus: "failed",
          },
        ],
      }),
    ).toBe("stopped");
    expect(
      executionPresentation({
        executing: false,
        steps: [{ ...failed, attemptStatus: "failed" }],
        messages: [story],
      }),
    ).toBe("failed");
    expect(
      executionPresentation({
        executing: false,
        steps: [{ ...failed, attemptStatus: "committed" }],
        messages: [story],
      }),
    ).toBe("partial");
  });
  it("only advances progress after a complete story from the current turn", () => {
    expect(
      executionPresentation({
        executing: true,
        steps: [{ runtimeId: "story", pluginId: "story", status: "completed" }],
        messages: [
          { ...story, id: "stream_old_story", runtimeId: "story", content: "" },
        ],
      }),
    ).toBe("updating");
    expect(
      executionPresentation({
        executing: true,
        steps: [],
        messages: [{ ...story, id: "stream_old_story" }],
      }),
    ).toBe("generating");
    expect(
      executionPresentation({ executing: true, steps: [], messages: [story] }),
    ).toBe("updating");
    expect(
      latestExecutionPresentation({
        executing: true,
        executionSteps: [failed],
        messages: [
          story,
          {
            id: "new-input",
            role: "user",
            content: "Continue",
            timestamp: "2026-09-02T00:00:00Z",
          },
        ],
      }),
    ).toBe("generating");
  });
  it("does not turn background failures into foreground failures", () => {
    expect(
      executionPresentation({
        executing: false,
        steps: [{ ...failed, detached: true }],
      }),
    ).toBe("idle");
  });
  it("restores a stop before any runtime was started", () => {
    expect(
      executionPresentation({
        executing: false,
        steps: [],
        recovery: { state: "failed", abortReason: "aborted-by-player" },
      }),
    ).toBe("stopped");
  });
});
