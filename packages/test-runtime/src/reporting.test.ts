import { describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";

import { evaluateExpectations, isExpectedRuntimeFailure } from "./reporting.js";

function runtimeResult(patch: Partial<RuntimeResult> = {}): RuntimeResult {
  return {
    runtimeId: "plugin/main",
    pluginId: "plugin",
    runId: "run-1",
    turnId: "turn-1",
    status: "success",
    durationMs: 1,
    output: {
      events: [{ topic: "asset.ready" }],
      assetGenerations: [{ modality: "image", ref: "media-1" }],
    },
    toolCalls: [],
    timestamp: "2026-05-09T00:00:00.000Z",
    ...patch,
  };
}

describe("reporting helpers", () => {
  it("evaluates runtime, event, log, plugin data, and asset expectations", () => {
    const assertions = evaluateExpectations(
      {
        runtimeResults: [{ runtimeId: "plugin/main", status: "success" }],
        events: ["asset.ready"],
        logs: ["rendered"],
        pluginData: [
          { namespace: "images", key: "latest", status: "done", field: "ref" },
        ],
        assetGenerations: [{ modality: "image", field: "ref" }],
      },
      {
        runtimeId: "plugin/main",
        runtimeResults: [runtimeResult()],
        pluginData: {
          images: [
            { key: "latest", value: { status: "done", ref: "media-1" } },
          ],
        },
        logs: [{ key: "1", value: { message: "rendered" } }],
      },
    );

    expect(assertions).toEqual([
      { status: "passed", message: "runtime:plugin/main:success" },
      { status: "passed", message: "event:asset.ready" },
      { status: "passed", message: "log:rendered" },
      { status: "passed", message: "pluginData:images" },
      { status: "passed", message: "assetGenerations:image" },
    ]);
  });

  it("matches expected runtime failures by runtime and error text", () => {
    const failed = runtimeResult({
      status: "failed",
      error: "provider rejected image prompt",
    });

    expect(
      isExpectedRuntimeFailure(failed, {
        runtimeResults: [
          {
            runtimeId: "plugin/main",
            status: "failed",
            errorIncludes: "image prompt",
          },
        ],
      }),
    ).toBe(true);
    expect(
      isExpectedRuntimeFailure(failed, {
        runtimeResults: [
          {
            runtimeId: "plugin/other",
            status: "failed",
            errorIncludes: "image prompt",
          },
        ],
      }),
    ).toBe(false);
  });
});
