import { describe, expect, it, vi } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { schedulePostTurnMemoryUpdate } from "../src/turn-executor/post-turn-memory.js";

function result(
  turnId: string,
  status: RuntimeResult["status"],
  text: unknown,
): RuntimeResult {
  return {
    pluginId: "fixture",
    runtimeId: "fixture",
    runId: `${turnId}-${status}`,
    turnId,
    status,
    output: { narrativeOutput: text },
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-01-01",
  };
}

describe("post-turn memory source selection", () => {
  it("does not re-extract a retry seed or failed output", () => {
    const updateAfterTurn = vi
      .fn()
      .mockResolvedValue({ updated: false, blocksChanged: [] });
    const deps: TurnExecutorDeps = {
      loadRuntime: async () => undefined,
      llm: {
        generate: async () => ({
          content: "",
          toolCalls: [],
          finishReason: "stop",
        }),
      },
      memorySystem: {
        manager: {
          initializeDefaults: async () => {},
          loadBlocks: async () => [],
        },
        updater: { updateAfterTurn },
      },
    };
    const schedule = (runtimeResults: RuntimeResult[]) =>
      schedulePostTurnMemoryUpdate({
        input: { sessionId: "session", turnId: "retry", playerMessage: "" },
        turnResult: { runtimeResults },
        runtimes: [
          { name: "fixture", outputKind: "story" },
          { name: "plugin", outputKind: "plugin" },
        ],
        deps,
        coreMemoryBlocks: [
          { label: "scene", content: "harbor", updatedAt: "2026-01-01" },
        ],
      });
    schedule([
      result("old-turn", "success", "old narrative"),
      result("retry", "failed", "uncommitted narrative"),
    ]);
    expect(updateAfterTurn).not.toHaveBeenCalled();
    schedule([result("retry", "success", 7)]);
    expect(updateAfterTurn).not.toHaveBeenCalled();
    schedule([
      {
        ...result("retry", "success", "internal plugin text"),
        runtimeId: "plugin",
      },
    ]);
    expect(updateAfterTurn).not.toHaveBeenCalled();
    schedule([
      result("old-turn", "success", "old narrative"),
      result("retry", "success", "new narrative"),
    ]);
    expect(updateAfterTurn).toHaveBeenCalledOnce();
    expect(updateAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        turnId: "retry",
        narrativeText: "new narrative",
      }),
    );
  });
});
