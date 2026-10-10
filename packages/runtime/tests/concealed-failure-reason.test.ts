import { describe, expect, it, vi } from "vitest";
import {
  CONCEALED_FAILURE_MESSAGE,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnInput,
} from "@covel/shared";
import { finalizeRuntimeResult } from "../src/turn-executor/runtime-finalization.js";

const input = { sessionId: "s1", turnId: "t1" } as TurnInput;

function failedResult(
  error = "event evt-secret: condition text is hidden",
): RuntimeResult {
  return {
    runtimeId: "planner/plot",
    pluginId: "planner",
    turnId: "t1",
    runId: "r1",
    status: "failed",
    output: null,
    error,
    toolCalls: [],
    durationMs: 1,
    timestamp: "2024-01-01T00:00:00Z",
  } as RuntimeResult;
}

async function finalize(concealed: boolean, error?: string) {
  const onRuntimeComplete = vi.fn(async () => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const manifest = {
    name: "planner/plot",
    pluginId: "planner",
    outputKind: "plugin",
    concealed,
  } as unknown as RuntimeManifest;
  const result = await finalizeRuntimeResult(
    { onRuntimeComplete } as never,
    manifest,
    input,
    failedResult(error),
  );
  return { result, onRuntimeComplete };
}

describe("failure reason of a concealed runtime", () => {
  it("is replaced in the result and the completion report", async () => {
    const { result, onRuntimeComplete } = await finalize(true);
    expect(result.error).toBe(CONCEALED_FAILURE_MESSAGE);
    expect(onRuntimeComplete).toHaveBeenCalledWith(
      expect.objectContaining({ error: CONCEALED_FAILURE_MESSAGE }),
    );
  });

  it("keeps the provider and model that failed", async () => {
    const { result } = await finalize(
      true,
      "[provider: acme, model: m1] event evt-secret: hidden",
    );
    expect(result.error).toBe(
      `[provider: acme, model: m1] ${CONCEALED_FAILURE_MESSAGE}`,
    );
  });

  it("is kept for a runtime that is not concealed", async () => {
    const { result } = await finalize(false);
    expect(result.error).toContain("evt-secret");
  });
});
