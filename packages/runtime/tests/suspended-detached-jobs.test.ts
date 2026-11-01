import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMemoryStore } from "@covel/store/memory";
import {
  presentationSnapshotSchema,
  type RuntimeManifest,
} from "@covel/shared";
import type { LoadedRuntime } from "@covel/shared/plugin-runtime";
import {
  commitExecution,
  executeTurn,
  resumeSuspendedRuntime,
} from "../src/index.js";
import { presenter, narrator, setup, story } from "./presentation-fixture.js";

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
  outputKind: "system",
  trigger: { type: "auto" },
};
const memory: RuntimeManifest = {
  description: "test",
  name: "notes/extract",
  pluginId: "notes",
  runtimeType: "function",
  stage: "post-turn",
  outputKind: "system",
  trigger: { type: "auto" },
  turnCompletion: { mode: "detached" },
  effects: { writes: ["plugin-data:self:notes"] },
};

describe("detached jobs of a suspended turn", () => {
  it("keeps one final public presentation snapshot through repeated source suspension", async () => {
    const f = await setup();
    const display = presenter({
      version: "1.0.0",
      presentation: { budget: { calls: 1 }, publicAssetNamespaces: ["assets"] },
      turnCompletion: { mode: "detached" },
    });
    const waiting = { ...asker, pluginId: "display", name: "display/wait" };
    const runtimes = [narrator, waiting, display];
    const deps = f.deps({
      [narrator.name]: async () => ({
        outcome: "success",
        value: { ...story, private: "PRIVATE-SOURCE-EXTRA" },
      }),
      [waiting.name]: async (ctx) =>
        ctx.resumeData === "finish"
          ? { outcome: "success", value: {} }
          : {
              outcome: "suspended",
              reason: "Wait",
              resumeSchema: { type: "string" },
            },
      [display.name]: async () => {
        throw new Error("Detached presenter ran before settlement");
      },
    });
    const original = await executeTurn(
      { ...input, turnId: "public-source" },
      runtimes,
      deps,
    );
    expect(original.result.deferredRuntimeJobs).toBeUndefined();
    expect(original.result.withheldRuntimeJobs).toHaveLength(1);
    expect((await f.commit(original)).status).toBe("committed");
    const [first] = await f.store.listSuspensions("session");
    await expect(
      resumeSuspendedRuntime(
        { ...first!, pluginId: display.pluginId, runtimeId: display.name },
        "finish",
        display,
        deps,
        { activeRuntimes: runtimes },
      ),
    ).rejects.toThrow(/cannot resume/);
    const saved = first!.pendingContinuation.withheldRuntimeJobs;
    expect(saved).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain("PRIVATE-SOURCE-EXTRA");
    expect(
      z.object({ presentation: presentationSnapshotSchema }).parse(saved?.[0])
        .presentation,
    ).toMatchObject({ committed: true, story, sourceTurnId: "public-source" });
    const again = await resumeSuspendedRuntime(first!, "again", waiting, deps, {
      activeRuntimes: runtimes,
    });
    expect(again.commit.releasedRuntimeJobs).toBeUndefined();
    expect((await f.commit(again)).status).toBe("committed");
    const second = (await f.store.listSuspensions("session")).find(
      (record) => !record.resolvedAt,
    )!;
    expect(second.pendingContinuation.withheldRuntimeJobs).toEqual(saved);
    const final = await resumeSuspendedRuntime(
      second,
      "finish",
      waiting,
      deps,
      { activeRuntimes: runtimes },
    );
    expect(final.commit.releasedRuntimeJobs).toEqual(saved);
    expect(final.commit.releasedRuntimeJobs).toHaveLength(1);
    await f.store.close();
  });
  it("travel with the suspension and are released by the resume that completes the turn", async () => {
    const store = createMemoryStore();
    await store.createSession({
      id: input.sessionId,
      locale: "en-US",
      status: "active",
      phase: "playing",
      setupRuntimes: {},
      seats: [
        { id: "main", controller: "human", role: "player", characters: "auto" },
      ],
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
