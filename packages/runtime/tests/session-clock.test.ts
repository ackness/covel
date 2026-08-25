import { describe, expect, it } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  mirrorSetupDone,
  type ExecutionContext,
  type SetupRuntimeState,
} from "@covel/shared";
import { finalizeExecution } from "../src/commit/finalize-execution.js";

const SID = "sess-clock";
const TURN = "turn-clock";

async function seedSession(
  store: DataStore,
  clock: {
    phase: "setup" | "playing";
    completedPlayerTurns: number;
    setupRuntimes?: Record<string, SetupRuntimeState>;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id: SID,
    worldId: "w",
    status: "active",
    phase: clock.phase,
    completedPlayerTurns: clock.completedPlayerTurns,
    setupRuntimes: clock.setupRuntimes ?? {},
    locale: "zh-CN",
    activePlugins: [],
    createdAt: now,
    updatedAt: now,
  });
}

function makeRuntime(name: string, outputKind = "plugin") {
  return { name, pluginId: name, outputKind, capabilities: [] as const };
}

function statePatchResult(field: string, value: unknown) {
  return {
    pluginId: "rt-a",
    runtimeId: "rt-a",
    runId: crypto.randomUUID(),
    turnId: TURN,
    status: "success" as const,
    output: { statePatches: [{ table: "stats", field, value }] },
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

function badResult() {
  return {
    ...statePatchResult("hp", 1),
    output: { statePatches: [{ field: "hp", value: 1 }] },
  };
}

const playerContext = (
  logicalTurnId: string,
  executionId: string,
): ExecutionContext => ({
  executionId,
  origin: "player",
  countPolicy: "complete-player-turn",
  logicalTurnId,
});

describe("logical-turn counting via finalizeExecution", () => {
  it("advances once per logicalTurnId", async () => {
    const store = createMemoryStore();
    await seedSession(store, { phase: "playing", completedPlayerTurns: 0 });

    const finalize = (logicalTurnId: string, executionId: string) =>
      finalizeExecution({
        store,
        sessionId: SID,
        executionContext: playerContext(logicalTurnId, executionId),
        runtimes: [makeRuntime("rt-a")],
        results: [statePatchResult("hp", executionId)],
        turnIds: [],
        sessionClock: { now: new Date().toISOString() },
      });

    expect((await finalize("L1", "e1")).status).toBe("committed");
    expect((await store.getSession(SID))!.completedPlayerTurns).toBe(1);
    expect((await finalize("L1", "e2")).status).toBe("committed");
    expect((await store.getSession(SID))!.completedPlayerTurns).toBe(1);
    expect((await finalize("L2", "e3")).status).toBe("committed");
    expect((await store.getSession(SID))!.completedPlayerTurns).toBe(2);
  });

  it("does not advance a non-player execution", async () => {
    const store = createMemoryStore();
    await seedSession(store, { phase: "playing", completedPlayerTurns: 2 });

    await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: {
        executionId: "m1",
        origin: "manual",
        countPolicy: "none",
      },
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 9)],
      turnIds: [],
      sessionClock: { now: new Date().toISOString() },
    });

    expect((await store.getSession(SID))!.completedPlayerTurns).toBe(2);
  });
});

describe("phase flip and atomicity", () => {
  const initialSetup = {
    pregame: mirrorSetupDone("1.0.0", "2026-01-01T00:00:00.000Z", 1, 1),
  };

  it("flips setup to playing when setup completes", async () => {
    const store = createMemoryStore();
    await seedSession(store, {
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: initialSetup,
    });

    await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: {
        executionId: "e1",
        origin: "player",
        countPolicy: "none",
      },
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 1)],
      turnIds: [],
      sessionClock: {
        now: new Date().toISOString(),
        setupCompletion: {
          newlyDone: {
            "char/init": mirrorSetupDone(
              "1.0.0",
              "2026-01-01T00:00:00.000Z",
              1,
              1,
            ),
          },
          allSetupDone: true,
        },
      },
    });

    const session = (await store.getSession(SID))!;
    expect(session.phase).toBe("playing");
    expect(session.completedPlayerTurns).toBe(0);
    expect(Object.keys(session.setupRuntimes).sort()).toEqual([
      "char/init",
      "pregame",
    ]);
  });

  it("rolls the clock write back with failed proposals", async () => {
    const store = createMemoryStore();
    await seedSession(store, {
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: initialSetup,
    });

    const outcome = await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: playerContext("L1", "e1"),
      runtimes: [makeRuntime("rt-a")],
      results: [badResult()],
      turnIds: [],
      sessionClock: {
        now: new Date().toISOString(),
        setupCompletion: {
          newlyDone: {
            "char/init": mirrorSetupDone(
              "1.0.0",
              "2026-01-01T00:00:00.000Z",
              1,
              1,
            ),
          },
          allSetupDone: true,
        },
      },
    });

    expect(outcome.status).toBe("failed");
    const session = (await store.getSession(SID))!;
    expect(session.phase).toBe("setup");
    expect(session.completedPlayerTurns).toBe(0);
    expect(Object.keys(session.setupRuntimes)).toEqual(["pregame"]);
    expect(await store.getLogicalTurnCompletion(SID, "L1")).toBeNull();
  });
});
