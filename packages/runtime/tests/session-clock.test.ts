/**
 * Session-clock unit tests (scheduling redesign W3b).
 *
 * Pins the dual-write formula and the finalize-transaction clock write:
 *  - `deriveLegacyClockFields` — turnCount / preGameCompleted derived from
 *    phase / completedPlayerTurns / setupRuntimes at the band boundaries.
 *  - logical-turn counting — an idempotent ledger insert advances
 *    completedPlayerTurns at most once per logicalTurnId, and non-player
 *    executions never advance it.
 *  - phase flip + atomicity — a setup-completing execution flips setup→playing
 *    in the same transaction as its proposals, and a proposal failure rolls the
 *    whole clock write (counter, phase, preGameCompleted) back.
 */

import { describe, it, expect } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import {
  deriveLegacyClockFields,
  deriveLegacyClockForSession,
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
  const legacy = deriveLegacyClockFields({
    phase: clock.phase,
    completedPlayerTurns: clock.completedPlayerTurns,
    setupRuntimes: clock.setupRuntimes ?? {},
  });
  await store.createSession({
    id: SID,
    worldId: "w",
    status: "active",
    turnCount: legacy.turnCount,
    preGameCompleted: legacy.preGameCompleted,
    phase: clock.phase,
    completedPlayerTurns: clock.completedPlayerTurns,
    setupRuntimes: clock.setupRuntimes ?? {},
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

/** A state.patch missing `table` — the handler rejects it (committed: false). */
function badResult() {
  return {
    pluginId: "rt-a",
    runtimeId: "rt-a",
    runId: crypto.randomUUID(),
    turnId: TURN,
    status: "success" as const,
    output: { statePatches: [{ field: "hp", value: 1 }] },
    toolCalls: [] as const,
    durationMs: 1,
    timestamp: new Date().toISOString(),
  };
}

const PLAYER_CTX = (
  logicalTurnId: string,
  executionId: string,
): ExecutionContext => ({
  executionId,
  origin: "player",
  countPolicy: "complete-player-turn",
  logicalTurnId,
});

describe("deriveLegacyClockFields (dual-write formula)", () => {
  it("setup phase → turnCount 0 regardless of completedPlayerTurns", () => {
    expect(
      deriveLegacyClockFields({
        phase: "setup",
        completedPlayerTurns: 0,
        setupRuntimes: {},
      }),
    ).toEqual({ turnCount: 0, preGameCompleted: [] });
    // A stray non-zero count in setup is still floored to 0 by the band.
    expect(
      deriveLegacyClockFields({
        phase: "setup",
        completedPlayerTurns: 3,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(0);
  });

  it("playing phase → turnCount = max(1, completedPlayerTurns) once progress is made", () => {
    // Bare session that started directly in playing (no setup, no turns) → 0,
    // matching the legacy create value (a lossless backfill round-trip).
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(0);
    // Setup just completed (a done mirror, still 0 counted turns) → Pre-Game
    // floor of 1.
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 0,
        setupRuntimes: { "p/setup": mirrorSetupDone("1.0.0", "t") },
      }).turnCount,
    ).toBe(1);
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 1,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(1);
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 7,
        setupRuntimes: {},
      }).turnCount,
    ).toBe(7);
  });

  it("preGameCompleted = sorted done-mirror keys (pending/blocked excluded)", () => {
    const setupRuntimes: Record<string, SetupRuntimeState> = {
      "z/done": mirrorSetupDone("1.0.0", "t"),
      "a/done": mirrorSetupDone("1.0.0", "t"),
      "b/pending": {
        state: "pending",
        pluginVersion: "1.0.0",
        generation: 1,
        attempts: 0,
      },
    };
    expect(
      deriveLegacyClockFields({
        phase: "playing",
        completedPlayerTurns: 2,
        setupRuntimes,
      }).preGameCompleted,
    ).toEqual(["a/done", "z/done"]);
  });
});

describe("logical-turn counting via finalizeExecution", () => {
  it("advances completedPlayerTurns once per logicalTurnId, and never for a duplicate", async () => {
    const store = createMemoryStore();
    await seedSession(store, { phase: "playing", completedPlayerTurns: 0 });
    const now = new Date().toISOString();

    const first = await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: PLAYER_CTX("L1", "e1"),
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 1)],
      turnIds: [],
      sessionClock: { now },
    });
    expect(first.status).toBe("committed");
    let session = (await store.getSession(SID))!;
    expect(session.completedPlayerTurns).toBe(1);
    expect(deriveLegacyClockForSession(session).turnCount).toBe(1);

    // Same logicalTurnId, different execution (retry) → ledger dedups, no count.
    const dup = await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: PLAYER_CTX("L1", "e2"),
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 2)],
      turnIds: [],
      sessionClock: { now: new Date().toISOString() },
    });
    expect(dup.status).toBe("committed");
    session = (await store.getSession(SID))!;
    expect(session.completedPlayerTurns).toBe(1);

    // Fresh logicalTurnId → advances again.
    await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: PLAYER_CTX("L2", "e3"),
      runtimes: [makeRuntime("rt-a")],
      results: [statePatchResult("hp", 3)],
      turnIds: [],
      sessionClock: { now: new Date().toISOString() },
    });
    session = (await store.getSession(SID))!;
    expect(session.completedPlayerTurns).toBe(2);
    // Legacy turnCount is no longer written — derived at read time from the clock.
    expect(deriveLegacyClockForSession(session).turnCount).toBe(2);
  });

  it("does not advance for a non-player execution (countPolicy: none)", async () => {
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
    const session = (await store.getSession(SID))!;
    expect(session.completedPlayerTurns).toBe(2);
    expect(deriveLegacyClockForSession(session).turnCount).toBe(2);
  });
});

describe("phase flip + atomicity", () => {
  it("flips setup → playing in the finalize transaction when setup completes", async () => {
    const store = createMemoryStore();
    await seedSession(store, {
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: { pregame: mirrorSetupDone("1.0.0", "t") },
    });

    await finalizeExecution({
      store,
      sessionId: SID,
      // Setup-completing player turn: countPolicy none, but a setup delta.
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
          newlyDone: { "char/init": mirrorSetupDone("1.0.0", "t") },
          allSetupDone: true,
        },
      },
    });

    const session = (await store.getSession(SID))!;
    expect(session.phase).toBe("playing");
    expect(session.completedPlayerTurns).toBe(0);
    // Legacy fields derived at read time (no longer written by finalize).
    const legacy = deriveLegacyClockForSession(session);
    // Floor after the flip.
    expect(legacy.turnCount).toBe(1);
    expect(legacy.preGameCompleted.slice().sort()).toEqual([
      "char/init",
      "pregame",
    ]);
  });

  it("rolls the clock write back with the proposals when a proposal fails", async () => {
    const store = createMemoryStore();
    await seedSession(store, {
      phase: "setup",
      completedPlayerTurns: 0,
      setupRuntimes: { pregame: mirrorSetupDone("1.0.0", "t") },
    });

    const outcome = await finalizeExecution({
      store,
      sessionId: SID,
      executionContext: PLAYER_CTX("L1", "e1"),
      runtimes: [makeRuntime("rt-a")],
      // A failing proposal must roll back the whole execution, clock included.
      results: [badResult()],
      turnIds: [],
      sessionClock: {
        now: new Date().toISOString(),
        setupCompletion: {
          newlyDone: { "char/init": mirrorSetupDone("1.0.0", "t") },
          allSetupDone: true,
        },
      },
    });

    expect(outcome.status).toBe("failed");
    const session = (await store.getSession(SID))!;
    // Untouched: still setup, count 0, ledger empty, preGameCompleted from seed.
    expect(session.phase).toBe("setup");
    expect(session.completedPlayerTurns).toBe(0);
    const legacy = deriveLegacyClockForSession(session);
    expect(legacy.turnCount).toBe(0);
    expect(legacy.preGameCompleted).toEqual(["pregame"]);
    expect(await store.getLogicalTurnCompletion(SID, "L1")).toBeNull();
  });
});
