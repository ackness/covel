import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import type { RuntimeManifest } from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";

const timestamp = "2026-10-02T00:00:00.000Z";
const input = {
  sessionId: "session",
  turnId: "player-turn",
  logicalTurnId: "logical-player-turn",
  playerMessage: "Ask the archivist",
  origin: "player" as const,
};

const asker: RuntimeManifest = {
  description: "test",
  name: "probe/asker",
  pluginId: "probe",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "plugin",
  trigger: { type: "auto" },
};
const memory: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "plugin",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

describe("detached jobs of a suspended turn", () => {
  it("travel with the suspension and are released by the resume that completes the turn", async () => {
    const store = createMemoryStore();
    await store.createSession({
      id: input.sessionId,
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      activePlugins: ["probe", "notes"],
      completedPlayerTurns: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const deps = {
      store,
      llm: { generate: vi.fn() },
      loadRuntime: async (
        manifest: RuntimeManifest,
      ): Promise<LoadedRuntime> => ({
        manifest,
        promptTemplate: "",
        handler: async (context) =>
          context.resumeData === undefined
            ? {
                outcome: "suspended",
                reason: "Need player confirmation",
                resumeSchema: { type: "object" },
              }
            : { outcome: "success", value: { content: "Confirmed." } },
      }),
    };

    const execution = await executeTurn(input, [asker, memory], deps);
    expect(execution.result.deferredRuntimeJobs).toBeUndefined();
    expect(
      execution.result.withheldRuntimeJobs?.map((job) => job.runtimeId),
    ).toEqual([memory.name]);
    await commitExecution({
      store,
      execution,
      completion: { kind: "turn", turnId: input.turnId, durationMs: 0 },
    });
    const [suspension] = await store.listSuspensions(input.sessionId);
    expect(suspension!.pendingContinuation.withheldRuntimeJobs).toHaveLength(1);

    const resumed = await resumeSuspendedRuntime(
      suspension!,
      { ok: true },
      asker,
      deps,
    );
    expect(
      resumed.commit.releasedRuntimeJobs?.map((job) => job.runtimeId),
    ).toEqual([memory.name]);
  });
});
