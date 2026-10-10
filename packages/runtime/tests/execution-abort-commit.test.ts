import { describe, expect, it, vi } from "vitest";
import { createMemoryStore } from "@covel/store/memory";
import { createEventBus } from "@covel/events";
import { PLAYER_ABORT_REASON, type RuntimeManifest } from "@covel/shared";
import {
  commitExecution,
  executeTurn,
  finalizeExecution,
} from "../src/index.js";
import { createHookPipeline } from "../src/hooks/pipeline.js";

async function fixture() {
  const store = createMemoryStore();
  await store.createSession({
    id: "s",
    locale: "en-US",
    status: "active",
    phase: "playing",
    setupRuntimes: {},
    activePlugins: ["probe"],
    completedPlayerTurns: 0,
    createdAt: "2026-09-29T00:00:00.000Z",
    updatedAt: "2026-09-29T00:00:00.000Z",
  });
  const eventBus = createEventBus();
  const events: string[] = [];
  eventBus.onEmit((event) => events.push(event.type));
  return { store, eventBus, events };
}

const input = {
  sessionId: "s",
  turnId: "t",
  logicalTurnId: "logical-t",
  playerMessage: "Continue",
  origin: "player" as const,
};

describe("execution-level abort commit boundary", () => {
  it.each(["policy veto", ""])(
    "rejects TurnStart veto without caller writes or success events (reason=%j)",
    async (reason) => {
      const { store, eventBus, events } = await fixture();
      const hookPipeline = createHookPipeline();
      hookPipeline.register({
        id: "probe:TurnStart",
        event: "TurnStart",
        handler: async () => ({ action: "abort", reason }),
      });
      const execution = await executeTurn(input, [], {
        store,
        eventBus,
        hookPipeline,
        llm: { generate: vi.fn() },
        loadRuntime: vi.fn(),
      });
      expect(execution.result.abortReason).toBe(reason);
      expect(execution.commit.abortReason).toBe(reason);
      const extraInTx = vi.fn();
      const withTransaction = vi.spyOn(store, "withTransaction");
      const outcome = await commitExecution({
        store,
        eventBus,
        execution: structuredClone(execution),
        extraInTx,
        completion: { kind: "turn", turnId: "t", durationMs: 0 },
      });
      expect(outcome).toMatchObject({
        status: "failed",
        error: `Execution aborted: ${reason}`,
      });
      expect(extraInTx).not.toHaveBeenCalled();
      expect(withTransaction).not.toHaveBeenCalled();
      expect((await store.getSession("s"))?.completedPlayerTurns).toBe(0);
      expect(await store.listTurnMessages("s")).toEqual([]);
      expect(await store.listSnapshots("s")).toEqual([]);
      expect(events).not.toContain("turn.completed");
      expect(events).not.toContain("state.snapshot.created");
      expect(
        (await finalizeExecution({ store, ...execution.commit })).status,
      ).toBe("failed");
    },
  );

  it.each(["player", "execution"] as const)(
    "discards earlier successful runtime writes on %s cancellation",
    async (source) => {
      const { store, eventBus, events } = await fixture();
      const controller = new AbortController();
      const first: RuntimeManifest = {
        description: "test",
        name: "probe/first",
        pluginId: "probe",
        runtimeType: "function",
        stage: "pre-turn",
        trigger: { type: "auto" },
      };
      const second: RuntimeManifest = {
        ...first,
        name: "probe/second",
        stage: "narrative",
      };
      const execution = await executeTurn(input, [first, second], {
        store,
        eventBus,
        turnControl:
          source === "player"
            ? { signal: controller.signal }
            : { executionSignal: controller.signal },
        llm: { generate: vi.fn() },
        loadRuntime: async (runtime) => ({
          manifest: runtime,
          promptTemplate: "",
          handler: async (ctx) => {
            await ctx.pluginData!.set("notes", runtime.name, "uncommitted");
            if (runtime.name === second.name)
              controller.abort(new Error("parent cancelled"));
            return { outcome: "success", value: { text: runtime.name } };
          },
        }),
      });
      expect(execution.result.abortReason).toBe(
        source === "player" ? PLAYER_ABORT_REASON : undefined,
      );
      expect(execution.commit.abortReason).toBe(
        source === "player" ? PLAYER_ABORT_REASON : "parent cancelled",
      );
      expect(execution.commit.results[0]?.status).toBe("success");
      expect(execution.commit.results[0]?.pendingProposals).toHaveLength(1);
      const extraInTx = vi.fn();
      const outcome = await commitExecution({
        store,
        eventBus,
        execution,
        extraInTx,
        completion: { kind: "turn", turnId: "t", durationMs: 0 },
      });
      expect(outcome.status).toBe("failed");
      expect(extraInTx).not.toHaveBeenCalled();
      expect(await store.listPluginData("s", "probe", "notes")).toEqual([]);
      expect(await store.listTurnMessages("s")).toEqual([]);
      expect(
        (await store.listTurnResults("s")).every(
          (result) => result.commitStatus === "failed",
        ),
      ).toBe(true);
      expect((await store.getSession("s"))?.completedPlayerTurns).toBe(0);
      expect(events).not.toContain("turn.completed");
      expect(events).not.toContain("state.snapshot.created");
    },
  );
});
