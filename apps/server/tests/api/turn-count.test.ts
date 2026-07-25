import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStore, type DataStore } from "@covel/store";
import type { RuntimeManifest, SetupRuntimeState } from "@covel/shared";
import {
  ensureSessionClockBackfilled,
  isPreGamePending,
} from "../../src/routes/api/turn-count.js";

const SID = "sess-tc";

function preGameRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "core-plugin",
    stage: "setup", // Pre-Game band (<= 99)
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

function mainLoopRuntime(name: string): RuntimeManifest {
  return {
    name,
    pluginId: name.split("/")[0],
    pluginType: "plugin",
    stage: "narrative", // main-loop band
    trigger: { type: "auto" },
  } as RuntimeManifest;
}

const ACTIVE = [preGameRuntime("pregame"), mainLoopRuntime("narrator")];

async function seedLegacy(
  store: DataStore,
  fields: {
    turnCount: number;
    preGameCompleted: string[];
    status?: "active" | "paused" | "ended";
  },
): Promise<void> {
  const now = new Date().toISOString();
  // A legacy session: only turnCount / preGameCompleted, no phase clock.
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

describe("isPreGamePending", () => {
  it("reads the persisted phase when present", () => {
    expect(isPreGamePending({ phase: "setup" }, ACTIVE)).toBe(true);
    expect(isPreGamePending({ phase: "playing" }, ACTIVE)).toBe(false);
    // phase wins even if the legacy signal would say otherwise.
    expect(
      isPreGamePending({ phase: "playing", preGameCompleted: [] }, ACTIVE),
    ).toBe(false);
  });

  it("falls back to the legacy signal when phase is absent", () => {
    expect(isPreGamePending({ preGameCompleted: [] }, ACTIVE)).toBe(true);
    expect(isPreGamePending({ preGameCompleted: ["pregame"] }, ACTIVE)).toBe(
      false,
    );
  });

  it("is never pending for a session without Pre-Game runtimes", () => {
    expect(
      isPreGamePending({ preGameCompleted: [] }, [mainLoopRuntime("narrator")]),
    ).toBe(false);
  });
});

describe("ensureSessionClockBackfilled", () => {
  let store: DataStore;
  beforeEach(() => {
    store = createMemoryStore();
  });

  function doneMirror(
    setupRuntimes: Readonly<Record<string, SetupRuntimeState>> | undefined,
  ): string[] {
    return Object.entries(setupRuntimes ?? {})
      .filter(([, s]) => s.state === "done")
      .map(([id]) => id)
      .sort();
  }

  it("is a no-op when the clock is already populated", async () => {
    const now = new Date().toISOString();
    await store.createSession({
      id: SID,
      worldId: "w",
      status: "active",
      turnCount: 1,
      preGameCompleted: ["pregame"],
      phase: "playing",
      completedPlayerTurns: 1,
      setupRuntimes: {},
      createdAt: now,
      updatedAt: now,
    });
    const session = (await store.getSession(SID))!;
    const returned = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: ACTIVE,
    });
    expect(returned.phase).toBe("playing");
    expect(returned.completedPlayerTurns).toBe(1);
    expect(returned.metadata?.runtimeMigration).toBeUndefined();
  });

  it("turnCount 0 with a pending setup runtime → setup / 0", async () => {
    await seedLegacy(store, { turnCount: 0, preGameCompleted: [] });
    const session = (await store.getSession(SID))!;
    const out = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: ACTIVE,
    });
    expect(out.phase).toBe("setup");
    expect(out.completedPlayerTurns).toBe(0);
    expect(out.turnCount).toBe(0);
    expect(
      (out.metadata?.runtimeMigration as Record<string, unknown>).clock,
    ).toMatchObject({ source: "legacy-backfill", legacyTurnCount: 0 });
  });

  it("turnCount 0 without any setup runtime → playing / 0", async () => {
    await seedLegacy(store, { turnCount: 0, preGameCompleted: [] });
    const session = (await store.getSession(SID))!;
    const out = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: [mainLoopRuntime("narrator")],
    });
    expect(out.phase).toBe("playing");
    expect(out.completedPlayerTurns).toBe(0);
    // Backfill leaves the legacy turnCount untouched (like creation); the first
    // finalize re-derives it from the clock. Band reads from phase regardless.
    expect(out.turnCount).toBe(0);
  });

  it("turnCount > 1 → playing with completedPlayerTurns = turnCount", async () => {
    await seedLegacy(store, { turnCount: 5, preGameCompleted: ["pregame"] });
    const session = (await store.getSession(SID))!;
    const out = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: ACTIVE,
    });
    expect(out.phase).toBe("playing");
    expect(out.completedPlayerTurns).toBe(5);
    expect(out.turnCount).toBe(5);
    expect(doneMirror(out.setupRuntimes)).toEqual(["pregame"]);
  });

  it("turnCount 1 without a prior main-loop turn → completedPlayerTurns 0 (Pre-Game floor)", async () => {
    await seedLegacy(store, { turnCount: 1, preGameCompleted: ["pregame"] });
    // A single setup-only turn_result: not a completed main-loop player turn.
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
    const session = (await store.getSession(SID))!;
    const out = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: ACTIVE,
    });
    expect(out.phase).toBe("playing");
    expect(out.completedPlayerTurns).toBe(0);
    expect(out.turnCount).toBe(1);
  });

  it("turnCount 1 with a prior main-loop turn → completedPlayerTurns 1", async () => {
    await seedLegacy(store, { turnCount: 1, preGameCompleted: ["pregame"] });
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
    const session = (await store.getSession(SID))!;
    const out = await ensureSessionClockBackfilled({
      store,
      session,
      activeRuntimes: ACTIVE,
    });
    expect(out.phase).toBe("playing");
    expect(out.completedPlayerTurns).toBe(1);
    expect(out.turnCount).toBe(1);
  });
});
