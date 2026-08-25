import { describe, expect, it } from "vitest";
import type { RuntimeResult, TurnResult } from "@covel/shared";
import type { SuspensionRecord } from "@covel/store";
import {
  attachSuspensionArtifact,
  collectExecutionSuspensions,
} from "../src/suspension-artifact.js";

function runtimeResult(runtimeId: string): RuntimeResult {
  return {
    pluginId: "plugin",
    runtimeId,
    runId: `run-${runtimeId}`,
    turnId: "turn",
    status: "suspended",
    output: { suspended: true },
    toolCalls: [],
    durationMs: 1,
    timestamp: "2026-08-26T00:00:00.000Z",
  };
}

function suspension(id: string, runtimeId: string): SuspensionRecord {
  return {
    id,
    sessionId: "session",
    turnId: "turn",
    runtimeId,
    pluginId: "plugin",
    reason: "wait",
    resumeSchema: {},
    pendingContinuation: {
      executionContext: {
        executionId: crypto.randomUUID(),
        origin: "player",
        countPolicy: "complete-player-turn",
        logicalTurnId: crypto.randomUUID(),
      },
      messages: [],
      toolCallsSoFar: [],
      pendingProposals: [],
    },
    createdAt: "2026-08-26T00:00:00.000Z",
  };
}

describe("execution suspension artifacts", () => {
  it("stays out of serialized RuntimeResult payloads", () => {
    const result = attachSuspensionArtifact(runtimeResult("top"), {
      record: suspension("suspension-1", "top"),
    });

    expect(JSON.stringify(result)).not.toContain("suspension-1");
    const symbol = Symbol.for("@covel/runtime/execution-suspensions");
    expect(Object.getOwnPropertySymbols(result)).toContain(symbol);
    expect(Object.getOwnPropertyDescriptor(result, symbol)?.enumerable).toBe(
      false,
    );
  });

  it("collects top-level and nested artifacts once", () => {
    const top = attachSuspensionArtifact(runtimeResult("top"), {
      record: suspension("suspension-1", "top"),
    });
    const nested = attachSuspensionArtifact(runtimeResult("nested"), {
      record: suspension("suspension-2", "nested"),
    });
    attachSuspensionArtifact(nested, {
      record: suspension("suspension-1", "top"),
    });
    const turn: TurnResult = {
      turnId: "turn",
      sessionId: "session",
      runtimeResults: [top],
      nestedRuntimeResults: [nested],
      durationMs: 1,
      timestamp: "2026-08-26T00:00:00.000Z",
    };

    expect(
      collectExecutionSuspensions(turn).map((record) => record.id),
    ).toEqual(["suspension-1", "suspension-2"]);
  });
});
