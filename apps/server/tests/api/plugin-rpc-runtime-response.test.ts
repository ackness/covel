import { describe, expect, it } from "vitest";
import {
  deriveBackgroundJobCompletion,
  deriveFollowerRuntimeJobResult,
} from "../../src/routes/api/plugin-rpc/runtime-response.js";

describe("plugin-rpc runtime response helpers", () => {
  it("marks background jobs failed when any runtime summary failed", () => {
    expect(
      deriveBackgroundJobCompletion({
        runtimeResults: [
          {
            runtimeId: "ok",
            pluginId: "plugin",
            status: "success",
            durationMs: 10,
            output: {},
          },
          {
            runtimeId: "failed",
            pluginId: "plugin",
            status: "failed",
            durationMs: 20,
            error: "boom",
            output: {},
          },
        ],
      }),
    ).toEqual({ status: "failed", error: "boom" });
  });

  it("derives follower failure from handler output error", () => {
    expect(
      deriveFollowerRuntimeJobResult({
        followerResult: {
          runtimeId: "image/generate",
          pluginId: "image",
          status: "success",
          durationMs: 42,
          output: { status: "failed", error: "provider unavailable" },
        },
        turnDurationMs: 99,
      }),
    ).toEqual({
      jobStatus: "failed",
      runtimeStatus: "failed",
      durationMs: 42,
      error: "provider unavailable",
      output: { status: "failed", error: "provider unavailable" },
    });
  });

  it("keeps successful follower jobs done", () => {
    expect(
      deriveFollowerRuntimeJobResult({
        followerResult: {
          runtimeId: "image/generate",
          pluginId: "image",
          status: "success",
          durationMs: 42,
          output: { status: "ok", assetId: "asset-1" },
        },
        turnDurationMs: 99,
      }),
    ).toEqual({
      jobStatus: "done",
      runtimeStatus: "success",
      durationMs: 42,
      output: { status: "ok", assetId: "asset-1" },
    });
  });
});
