import { describe, expect, it, vi } from "vitest";
import {
  makePendingPluginJobValue,
  makeTerminalPluginJobValue,
  writePluginJob,
} from "../../src/routes/api/plugin-rpc/jobs.js";

describe("plugin-rpc job helpers", () => {
  it("builds pending job values and preserves explicit null payloads", () => {
    expect(
      makePendingPluginJobValue({
        runtimeId: "image/prompt",
        turnId: "turn-1",
        startedAt: "2026-05-09T00:00:00.000Z",
        payload: null,
        phase: "prompt",
        message: "Generating image prompt...",
        progress: 1,
      }),
    ).toEqual({
      status: "pending",
      progress: 1,
      runtimeId: "image/prompt",
      turnId: "turn-1",
      payload: null,
      startedAt: "2026-05-09T00:00:00.000Z",
      phase: "prompt",
      message: "Generating image prompt...",
    });
  });

  it("omits undefined optional fields from terminal job values", () => {
    expect(
      makeTerminalPluginJobValue({
        status: "failed",
        runtimeId: "image/generate",
        turnId: "turn-2",
        startedAt: "2026-05-09T00:00:00.000Z",
        completedAt: "2026-05-09T00:00:02.000Z",
        durationMs: 2000,
        error: "provider unavailable",
        reason: "expected-background-follower-missing",
      }),
    ).toEqual({
      status: "failed",
      progress: 100,
      runtimeId: "image/generate",
      turnId: "turn-2",
      startedAt: "2026-05-09T00:00:00.000Z",
      completedAt: "2026-05-09T00:00:02.000Z",
      durationMs: 2000,
      error: "provider unavailable",
      reason: "expected-background-follower-missing",
    });
  });

  it("writes the canonical _jobs plugin-data envelope", async () => {
    const store = {
      setPluginData: vi.fn(async () => undefined),
    };

    await writePluginJob(store as never, {
      sessionId: "sess-1",
      pluginId: "image",
      jobId: "job-1",
      startedAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:02.000Z",
      value: makeTerminalPluginJobValue({
        status: "done",
        runtimeId: "image/generate",
        turnId: "turn-1",
        startedAt: "2026-05-09T00:00:00.000Z",
        completedAt: "2026-05-09T00:00:02.000Z",
      }),
    });

    expect(store.setPluginData).toHaveBeenCalledWith({
      id: "sess-1:image:_jobs:job-1",
      sessionId: "sess-1",
      pluginId: "image",
      namespace: "_jobs",
      key: "job-1",
      value: {
        status: "done",
        progress: 100,
        runtimeId: "image/generate",
        turnId: "turn-1",
        startedAt: "2026-05-09T00:00:00.000Z",
        completedAt: "2026-05-09T00:00:02.000Z",
      },
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:02.000Z",
    });
  });
});
