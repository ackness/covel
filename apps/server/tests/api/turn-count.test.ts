import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { RuntimeManifest } from "@covel/shared";
import {
  advanceSessionTurnCount,
  isPreGamePending,
} from "../../src/routes/api/turn-count.js";

const SID = "sess-tc";

function preGameRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "core-plugin",
    priority: 10, // Pre-Game band (<= 99)
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

function mainLoopRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "plugin",
    priority: 500, // main-loop band
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

const ACTIVE = [preGameRuntime("pregame"), mainLoopRuntime("narrator")];

async function seed(
  store: DataStore,
  fields: {
    turnCount: number;
    preGameCompleted: string[];
    status?: "active" | "paused" | "ended";
  },
): Promise<void> {
  const now = new Date().toISOString();
  await store.createSession({
    id: SID,
    worldId: "w",
    status: fields.status ?? "active",
    turnCount: fields.turnCount,
    preGameCompleted: fields.preGameCompleted,
    createdAt: now,
    updatedAt: now,
  });
}

async function turnCountOf(store: DataStore): Promise<number | undefined> {
  return (await store.getSession(SID))?.turnCount;
}

describe("isPreGamePending", () => {
  it("is pending while any Pre-Game runtime has not reported done", () => {
    expect(isPreGamePending(ACTIVE, [])).toBe(true);
    expect(isPreGamePending(ACTIVE, ["pregame"])).toBe(false);
  });

  it("is never pending for a session without Pre-Game runtimes", () => {
    expect(isPreGamePending([mainLoopRuntime("narrator")], [])).toBe(false);
  });
});

describe("advanceSessionTurnCount", () => {
  let store: DataStore;
  beforeEach(() => {
    store = createMemoryStore();
  });

  it("advances a committed main-loop player turn by exactly one", async () => {
    await seed(store, { turnCount: 3, preGameCompleted: ["pregame"] });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(4);
  });

  it("does not advance when the turn's proposals failed to commit", async () => {
    // A failed (or crashed) turn is not a completed player turn — counting it
    // inflated session.turnCount, which drives the UI turn display and the
    // auto-snapshot cadence.
    await seed(store, { turnCount: 3, preGameCompleted: ["pregame"] });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: false,
    });
    expect(await turnCountOf(store)).toBe(3);
  });

  it("does not advance a request that started in Pre-Game", async () => {
    // Setup requests don't count; the request that completes Pre-Game is
    // accounted for by pre-game-completion's atomic `turnCount: 1` write —
    // one logical turn even when main-loop followups ran in the same request.
    await seed(store, { turnCount: 0, preGameCompleted: [] });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: true,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(0);
  });

  it("does not advance a session that is no longer active", async () => {
    await seed(store, {
      turnCount: 3,
      preGameCompleted: ["pregame"],
      status: "paused",
    });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(3);
  });

  it("absorbs the Pre-Game floor: the first main-loop turn stays turn 1", async () => {
    // Pre-Game finished without running any main-loop runtime, so the "1" the
    // completion write left behind is a floor placeholder — the first real
    // main-loop turn IS turn 1, not turn 2.
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await store.saveTurnResult({
      id: "tr-setup",
      sessionId: SID,
      turnId: "turn-setup",
      runtimeResults: [{ runtimeId: "pregame", output: { preGameDone: true } }],
      origin: "player",
      commitStatus: "committed",
      durationMs: 1,
      createdAt: "2024-01-01T00:00:00Z",
    });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(1);
  });

  it("advances past 1 once a main-loop turn already completed", async () => {
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await store.saveTurnResult({
      id: "tr-first",
      sessionId: SID,
      turnId: "turn-first",
      runtimeResults: [{ runtimeId: "narrator", output: {} }],
      origin: "player",
      commitStatus: "committed",
      durationMs: 1,
      createdAt: "2024-01-01T00:00:00Z",
    });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(2);
  });

  it("moves forward from an inherited count (forked session)", async () => {
    // Forks copy `turnCount` from the snapshot but NOT the parent's
    // turn_results rows. The counter is incremental, so the restored value is
    // the baseline — a full recount over turn_results would have collapsed it.
    await seed(store, { turnCount: 42, preGameCompleted: ["pregame"] });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(43);
  });

  it("under-counts a fork taken exactly at turnCount 1 (known limitation)", async () => {
    // A fork copies turnCount but not turn_results. At the ambiguous
    // turnCount===1 boundary the floor check scans the child's (empty)
    // turn_results and can't tell an inherited "1" (the parent finished one
    // main-loop turn) from a Pre-Game floor "1", so it absorbs the floor and
    // the child's next turn stays at 1 instead of advancing to 2.
    //
    // Correct behaviour is 2. Fixing it needs an explicit "this count is an
    // established baseline, not a floor" marker set at fork time; the window
    // (a fork taken at exactly count 1) is narrow enough that the limitation is
    // documented rather than fixed. Pinned so the behaviour can't drift.
    await seed(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    await advanceSessionTurnCount({
      store,
      sessionId: SID,
      turnId: "turn-current",
      activeRuntimes: ACTIVE,
      wasPreGamePending: false,
      committed: true,
    });
    expect(await turnCountOf(store)).toBe(1); // known limitation: ideally 2
  });
});
