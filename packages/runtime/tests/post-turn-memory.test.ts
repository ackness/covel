import { describe, expect, it } from "vitest";
import type { RuntimeResult } from "@covel/shared";
import type { TurnExecutorDeps } from "../src/turn-executor/turn-executor-types.js";
import { buildPostTurnMemoryUpdate } from "../src/turn-executor/post-turn-memory.js";

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
        updater: {
          updateAfterTurn: async () => ({ updated: false, blocksChanged: [] }),
        },
      },
    };
    const build = (runtimeResults: RuntimeResult[]) =>
      buildPostTurnMemoryUpdate({
        input: { sessionId: "session", turnId: "retry" },
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
    expect(
      build([
        result("old-turn", "success", "old narrative"),
        result("retry", "failed", "uncommitted narrative"),
      ]),
    ).toBeUndefined();
    expect(build([result("retry", "success", 7)])).toBeUndefined();
    expect(
      build([
        {
          ...result("retry", "success", "internal plugin text"),
          runtimeId: "plugin",
        },
      ]),
    ).toBeUndefined();
    expect(
      build([
        result("old-turn", "success", "old narrative"),
        result("retry", "success", "new narrative"),
      ]),
    ).toEqual(
      expect.objectContaining({
        turnId: "retry",
        narrativeText: "new narrative",
      }),
    );
  });
});
